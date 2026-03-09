# Flight Recorder: Comprehensive Observability for the Cortex→Router→Executor Pipeline

## Table of Contents
1. [Current Observability Gap Analysis](#1-current-observability-gap-analysis)
2. [Flight Recorder Architecture](#2-flight-recorder-architecture)
3. [TypeScript Interfaces](#3-typescript-interfaces)
4. [SQLite Ring Buffer Schema](#4-sqlite-ring-buffer-schema)
5. [Metrics Aggregation Algorithm](#5-metrics-aggregation-algorithm)
6. [Health Digest](#6-health-digest)
7. [Integration Points — Exact Instrumentation Locations](#7-integration-points)
8. [Performance & Storage Analysis](#8-performance--storage-analysis)
9. [Restart Continuity](#9-restart-continuity)

---

## 1. Current Observability Gap Analysis

### What You CAN See Today

| Layer | Visible | Mechanism |
|-------|---------|-----------|
| Cortex Bus | Message enqueue/dequeue/state | `cortex_bus` table (`pending`→`processing`→`completed`/`failed`) |
| Cortex Loop | `processed` counter | `processedCount()` method on `CortexLoop` |
| Cortex Session | Conversation history | `cortex_session` table |
| Cortex Checkpoints | Latest snapshot | `cortex_checkpoints` table |
| Router Queue | Job status transitions | `jobs` table (status column) |
| Router Archive | Terminal job records | `jobs_archive` table |
| Evaluator | Console logs of scores | `console.log()` in `evaluate()` |
| Token Usage | Ledger entries | `record()` calls in evaluator |
| Worker | Job lifecycle events | `routerEvents` EventEmitter (`job:completed`, `job:failed`, `job:delivered`) |

### What Is INVISIBLE

| Gap | Impact | Severity |
|-----|--------|----------|
| **No cross-layer trace correlation** | Cannot trace a user message from Cortex intake through Router dispatch to Executor result and back. The `envelopeId` in Cortex and `jobId` in Router exist independently — there is no shared trace/span ID linking them. | 🔴 Critical |
| **Evaluator decision metadata is ephemeral** | Ollama score, Sonnet verification score, agreement/disagreement between the two — all go to `console.log()` and vanish. If the evaluator misjudges complexity, there's no historical record to diagnose drift. | 🔴 Critical |
| **No latency breakdown** | `created_at`, `started_at`, `finished_at` exist on jobs but: (a) no timing for the evaluate phase itself, (b) no timing for dispatch overhead, (c) no timing for Cortex bus wait time, (d) no timing for delivery/archive. You can't tell where time was spent. | 🟡 High |
| **Silent swallow in top-level catch** | `loop.ts:processTick()` line ~58: the outer `catch {}` swallows all errors silently. If the concurrency check, retry dequeue, or JSON parse fails, the job never moves and nobody knows. | 🔴 Critical |
| **Watchdog retry is fire-and-forget** | `watchdogTick()` schedules `setTimeout` retries but doesn't log which jobs were retried, how many times, or whether the retry itself succeeded. | 🟡 High |
| **No evaluator agreement tracking** | When Ollama scores ≤2 the task skips Sonnet entirely. When Ollama scores >2, Sonnet verifies. But there's no record of how often they agree, how far apart they are, or whether Ollama's accuracy is degrading. | 🟡 High |
| **No cost tracking per task** | Token usage is recorded in the ledger per-model but not per-task. You can't answer "how much did this specific task cost?" | 🟡 High |
| **Gateway restart loses in-flight state** | Jobs in `in_execution` have heartbeat timers in memory. On restart, `recovery.ts` can detect stuck jobs, but the execution context (which LLM call was in-flight) is lost. No WAL-style replay possible. | 🟡 High |
| **No tier distribution visibility** | You can't answer "what percentage of tasks go to Haiku vs Sonnet vs Opus?" without manually querying the archive. | 🟠 Medium |
| **`dequeue()` status gap** | Between `dequeue()` setting `evaluating` and `evaluate()` completing, if the process crashes, the job is stuck in `evaluating` forever (until `recovery.ts` catches it). No explicit timeout on the evaluate phase. | 🟡 High |
| **Notifier delivery failures are silent** | `notifier.ts` `onCompleted`/`onFailed` wrap `onDelivered` in `try/catch {}` — delivery failures vanish. The `callGateway` push in `gateway-integration.ts` also `.catch()`es silently. | 🟡 High |
| **No Cortex→Router handoff trace** | `cortex/loop.ts` fires `onSpawn()` and gets back a `jobId`, but doesn't record the association in any queryable store. The `taskId` is in the ops trigger metadata but not linked to a trace. | 🔴 Critical |

### Where Jobs Disappear Silently

1. **`processTick()` outer catch** (loop.ts ~line 109): Any unhandled error in the concurrency check, retry dequeue path, or evaluation swallowed with empty `catch {}`.

2. **`evaluate()` dual failure** (evaluator.ts): When both Ollama AND Sonnet fail, returns `fallback_weight` with a reasoning string — but the caller (`loop.ts`) doesn't know this was a degraded evaluation. Job proceeds with potentially wrong tier.

3. **`dispatch()` fire-and-forget** (dispatcher.ts → worker.ts): `void run(...)` means if `run()` throws synchronously before the heartbeat starts (e.g., `executor` is undefined), the error is swallowed by the void.

4. **Notifier `onDelivered` catch** (notifier.ts line 50/57): `try { onDelivered(...) } catch { /* best-effort */ }` — if pushing the result to the issuer's session fails, the job is archived successfully but the user never sees the result.

5. **`gateway-integration.ts` `logRouterDecision()`** (line ~218): Entire function wrapped in `try/catch {}` — if audit logging fails, nobody knows.

6. **Cortex `routeOutput` failure** (cortex/loop.ts ~line 159): The `onError` callback fires but the message is still marked `completed` in the bus. The user may never receive the response.

---

## 2. Flight Recorder Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                       Flight Recorder                             │
│                                                                    │
│  ┌─────────────┐   ┌──────────────┐   ┌────────────────────┐     │
│  │ Trace Store  │   │  Metrics     │   │  Health Digest     │     │
│  │ (SQLite      │   │  Aggregator  │   │  Generator         │     │
│  │  Ring Buffer)│   │  (In-Memory) │   │  (6h cron)         │     │
│  └──────┬──────┘   └──────┬───────┘   └────────┬───────────┘     │
│         │                  │                     │                  │
│         └──────────┬───────┴─────────────────────┘                 │
│                    │                                                │
│              ┌─────┴─────┐                                         │
│              │  Recorder  │  ← Single entry point                  │
│              │    API     │     for all instrumentation             │
│              └─────┬─────┘                                         │
└────────────────────┼───────────────────────────────────────────────┘
                     │
    ┌────────────────┼────────────────────────────┐
    │                │                             │
    ▼                ▼                             ▼
┌────────┐    ┌──────────┐                 ┌────────────┐
│ Cortex │    │  Router  │                 │  Executor  │
│ Loop   │    │  Loop    │                 │  Worker    │
│        │    │  Eval    │                 │            │
│        │    │  Dispatch│                 │            │
└────────┘    └──────────┘                 └────────────┘
```

### Design Principles

1. **Zero-allocation hot path**: Span creation uses pre-allocated buffers; no `new Date()` on every span — use `performance.now()` for relative timing, convert to wall-clock only on flush.
2. **Non-blocking writes**: SQLite inserts are batched and flushed on a 1-second timer, not inline with the hot path.
3. **Ring buffer eviction**: After 1000 traces, oldest trace (by `root_span.start_time`) is deleted in the same transaction as the new insert.
4. **OpenTelemetry-compatible**: Trace/span IDs follow W3C Trace Context format (128-bit trace ID, 64-bit span ID). Can be exported to Jaeger/Zipkin without conversion.
5. **Restart-durable**: Active traces are flushed to SQLite on `SIGTERM`/`SIGINT`. On restart, orphaned spans are closed with `status=INTERRUPTED`.

---

## 3. TypeScript Interfaces

```typescript
// src/router/flight-recorder/types.ts

// ─────────────────────────────────────────────────────────────────
// W3C Trace Context compatible IDs
// ─────────────────────────────────────────────────────────────────

/** 128-bit trace ID as 32 hex chars (W3C Trace Context) */
export type TraceId = string & { readonly __brand: "TraceId" };

/** 64-bit span ID as 16 hex chars (W3C Trace Context) */
export type SpanId = string & { readonly __brand: "SpanId" };

// ─────────────────────────────────────────────────────────────────
// Span Status
// ─────────────────────────────────────────────────────────────────

export type SpanStatus =
  | "OK"
  | "ERROR"
  | "TIMEOUT"
  | "INTERRUPTED"   // gateway restart mid-span
  | "SKIPPED";      // stage not executed (e.g., Sonnet verification skipped)

// ─────────────────────────────────────────────────────────────────
// Span Kinds (mirrors OpenTelemetry SpanKind)
// ─────────────────────────────────────────────────────────────────

export type SpanKind =
  | "INTERNAL"
  | "SERVER"
  | "CLIENT";

// ─────────────────────────────────────────────────────────────────
// Pipeline Stages — one span per stage
// ─────────────────────────────────────────────────────────────────

export type PipelineStage =
  | "cortex.intake"        // message enters Cortex bus
  | "cortex.context"       // context assembly
  | "cortex.llm"           // LLM call (may include tool rounds)
  | "cortex.spawn"         // Cortex decides to spawn a Router job
  | "cortex.output"        // response routing & delivery
  | "router.enqueue"       // job enters Router queue
  | "router.evaluate"      // complexity evaluation (contains children)
  | "router.evaluate.ollama"    // Ollama scoring sub-span
  | "router.evaluate.sonnet"    // Sonnet verification sub-span
  | "router.policy"        // policy/concurrency check
  | "router.dispatch"      // tier resolution + template rendering
  | "router.execute"       // worker execution (contains LLM call)
  | "router.deliver"       // notifier delivery + archive
  | "executor.llm"         // actual LLM call inside worker
  | "executor.tools"       // tool execution rounds
  | "executor.cleanup";    // session cleanup

// ─────────────────────────────────────────────────────────────────
// Core Span
// ─────────────────────────────────────────────────────────────────

export interface Span {
  /** W3C-compatible trace ID (shared across the entire task lifecycle) */
  traceId: TraceId;

  /** Unique span ID */
  spanId: SpanId;

  /** Parent span ID (null for root spans) */
  parentSpanId: SpanId | null;

  /** Pipeline stage this span represents */
  stage: PipelineStage;

  /** OpenTelemetry span kind */
  kind: SpanKind;

  /** High-resolution start time (ms since epoch, µs precision) */
  startTimeMs: number;

  /** High-resolution end time (null if span is still open) */
  endTimeMs: number | null;

  /** Computed duration in milliseconds */
  durationMs: number | null;

  /** Span status */
  status: SpanStatus;

  /** Human-readable status message (error details, etc.) */
  statusMessage: string | null;

  /** Stage-specific metadata (see StageMetadata union) */
  metadata: StageMetadata;
}

// ─────────────────────────────────────────────────────────────────
// Stage-specific Metadata (discriminated union)
// ─────────────────────────────────────────────────────────────────

export type StageMetadata =
  | CortexIntakeMetadata
  | CortexContextMetadata
  | CortexLlmMetadata
  | CortexSpawnMetadata
  | CortexOutputMetadata
  | RouterEnqueueMetadata
  | RouterEvaluateMetadata
  | EvaluatorOllamaMetadata
  | EvaluatorSonnetMetadata
  | RouterPolicyMetadata
  | RouterDispatchMetadata
  | RouterExecuteMetadata
  | RouterDeliverMetadata
  | ExecutorLlmMetadata
  | ExecutorToolsMetadata
  | ExecutorCleanupMetadata
  | EmptyMetadata;

export interface EmptyMetadata {
  stage: "empty";
}

export interface CortexIntakeMetadata {
  stage: "cortex.intake";
  envelopeId: string;
  channel: string;
  priority: "urgent" | "normal" | "background";
  isOpsTrigger: boolean;
  contentPreview: string;   // first 120 chars
  busQueueDepth: number;    // pending messages at intake time
}

export interface CortexContextMetadata {
  stage: "cortex.context";
  tokenCount: number;
  hippocampusEnabled: boolean;
  sessionMessageCount: number;
}

export interface CortexLlmMetadata {
  stage: "cortex.llm";
  model: string;
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  toolRounds: number;
  syncToolCalls: string[];  // tool names called
}

export interface CortexSpawnMetadata {
  stage: "cortex.spawn";
  taskId: string;
  taskPreview: string;      // first 200 chars of task
  replyChannel: string | null;
  resultPriority: "urgent" | "normal" | "background";
  resourceCount: number;
}

export interface CortexOutputMetadata {
  stage: "cortex.output";
  targetChannels: string[];
  silent: boolean;
  deliveryErrors: string[];
}

export interface RouterEnqueueMetadata {
  stage: "router.enqueue";
  jobId: string;
  jobType: string;
  issuer: string;
  payloadSizeBytes: number;
}

export interface RouterEvaluateMetadata {
  stage: "router.evaluate";
  /** Final weight used for tier resolution */
  finalWeight: number;
  /** Whether Ollama was used */
  ollamaUsed: boolean;
  /** Whether Sonnet verification was triggered */
  sonnetVerified: boolean;
  /** Ollama score (null if Ollama failed) */
  ollamaWeight: number | null;
  /** Sonnet score (null if Sonnet not called or failed) */
  sonnetWeight: number | null;
  /** Absolute divergence between Ollama and Sonnet (null if not compared) */
  divergence: number | null;
  /** Which evaluator's score was ultimately used */
  decisionSource: "ollama" | "sonnet" | "fallback";
  /** Fallback weight from config */
  fallbackWeight: number;
  /** Evaluator reasoning string */
  reasoning: string;
}

export interface EvaluatorOllamaMetadata {
  stage: "router.evaluate.ollama";
  model: string;
  rawResponse: string;      // first 200 chars
  parsedWeight: number | null;
  tokensIn: number;
  tokensOut: number;
  success: boolean;
  errorMessage: string | null;
}

export interface EvaluatorSonnetMetadata {
  stage: "router.evaluate.sonnet";
  model: string;
  rawResponse: string;      // first 200 chars
  parsedWeight: number | null;
  tokensIn: number;
  tokensOut: number;
  success: boolean;
  errorMessage: string | null;
}

export interface RouterPolicyMetadata {
  stage: "router.policy";
  concurrentJobs: number;
  maxConcurrent: number;
  allowed: boolean;
  isRetry: boolean;
  retryCount: number;
  waitTimeMs: number;       // time spent waiting for concurrency slot
}

export interface RouterDispatchMetadata {
  stage: "router.dispatch";
  jobId: string;
  weight: number;
  tier: string;
  model: string;
  templateName: string;
  promptSizeChars: number;
  resourceCount: number;
}

export interface RouterExecuteMetadata {
  stage: "router.execute";
  jobId: string;
  workerId: string | null;
  model: string;
  heartbeatCount: number;
  wasRetry: boolean;
  retryCount: number;
}

export interface RouterDeliverMetadata {
  stage: "router.deliver";
  jobId: string;
  jobStatus: string;
  resultSizeBytes: number;
  issuer: string;
  deliveryTarget: "cortex" | "session" | "unknown";
  archiveSuccess: boolean;
}

export interface ExecutorLlmMetadata {
  stage: "executor.llm";
  model: string;
  sessionKey: string;
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  payloadCount: number;
  resultSizeBytes: number;
}

export interface ExecutorToolsMetadata {
  stage: "executor.tools";
  toolNames: string[];
  toolCallCount: number;
  totalToolDurationMs: number;
}

export interface ExecutorCleanupMetadata {
  stage: "executor.cleanup";
  sessionDeleted: boolean;
  cleanupDurationMs: number;
}

// ─────────────────────────────────────────────────────────────────
// Trace — a complete task lifecycle (root + all child spans)
// ─────────────────────────────────────────────────────────────────

export interface Trace {
  /** W3C trace ID — shared by all spans in this trace */
  traceId: TraceId;

  /** Root span (either cortex.intake or router.enqueue) */
  rootSpan: Span;

  /** All spans in the trace, ordered by startTimeMs */
  spans: Span[];

  /** Total end-to-end duration (null if trace still open) */
  totalDurationMs: number | null;

  /** Terminal status of the trace */
  status: SpanStatus;

  /** Summary metadata for fast querying */
  summary: TraceSummary;
}

export interface TraceSummary {
  /** Original task/message preview (first 200 chars) */
  taskPreview: string;

  /** Source channel */
  channel: string;

  /** Final tier selected (null if never routed) */
  tier: string | null;

  /** Model used for execution */
  model: string | null;

  /** Total tokens consumed (in + out) across all LLM calls */
  totalTokens: number;

  /** Estimated cost in USD (based on model pricing) */
  estimatedCostUsd: number;

  /** Whether task completed successfully */
  success: boolean;

  /** Error message if failed */
  error: string | null;

  /** Number of retry attempts */
  retryCount: number;

  /** Was evaluator Sonnet verification triggered? */
  sonnetVerified: boolean;

  /** Evaluator divergence (Ollama vs Sonnet) */
  evaluatorDivergence: number | null;
}

// ─────────────────────────────────────────────────────────────────
// Metrics (real-time, in-memory)
// ─────────────────────────────────────────────────────────────────

export interface LatencyPercentiles {
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  count: number;
}

export interface TierMetrics {
  tier: string;
  taskCount: number;
  successCount: number;
  failureCount: number;
  successRate: number;       // 0-1
  latency: LatencyPercentiles;
  avgTokensPerTask: number;
  totalCostUsd: number;
}

export interface ModelMetrics {
  model: string;
  callCount: number;
  successCount: number;
  failureCount: number;
  successRate: number;
  avgLatencyMs: number;
  avgTokensIn: number;
  avgTokensOut: number;
  totalCostUsd: number;
}

export interface EvaluatorMetrics {
  /** Total evaluations performed */
  totalEvaluations: number;

  /** How many used Ollama only (weight ≤ 2) */
  ollamaOnlyCount: number;

  /** How many triggered Sonnet verification */
  sonnetVerifiedCount: number;

  /** How many fell back to fallback_weight */
  fallbackCount: number;

  /** Agreement rate when both scored (|ollama - sonnet| ≤ 1) */
  agreementRate: number;

  /** Average absolute divergence between Ollama and Sonnet */
  avgDivergence: number;

  /** Divergence trend: positive = growing apart, negative = converging */
  divergenceTrend: number;

  /** Distribution of Ollama scores (index = score 1-10) */
  ollamaDistribution: number[];

  /** Distribution of Sonnet scores (index = score 1-10) */
  sonnetDistribution: number[];
}

export interface PipelineMetrics {
  /** When metrics collection started */
  collectionStartedAt: string;

  /** Total traces recorded */
  totalTraces: number;

  /** Per-tier breakdown */
  tiers: Record<string, TierMetrics>;

  /** Per-model breakdown */
  models: Record<string, ModelMetrics>;

  /** Evaluator performance */
  evaluator: EvaluatorMetrics;

  /** Overall pipeline health */
  pipeline: {
    /** Average end-to-end latency (Cortex intake → delivery) */
    avgE2eLatencyMs: number;
    e2eLatency: LatencyPercentiles;

    /** Average queue wait time */
    avgQueueWaitMs: number;

    /** Average evaluate time */
    avgEvaluateMs: number;

    /** Average execution time */
    avgExecuteMs: number;

    /** Average delivery time */
    avgDeliverMs: number;

    /** Current queue depth */
    currentQueueDepth: number;

    /** Jobs currently executing */
    currentExecuting: number;

    /** Total cost accumulated (USD) */
    totalCostUsd: number;

    /** Hung job count (detected by watchdog) */
    hungJobCount: number;

    /** Total retries triggered */
    totalRetries: number;
  };
}

// ─────────────────────────────────────────────────────────────────
// Health Digest
// ─────────────────────────────────────────────────────────────────

export interface HealthDigest {
  /** Digest generation timestamp */
  generatedAt: string;

  /** Period covered */
  periodStart: string;
  periodEnd: string;
  periodHours: number;

  /** Summary stats */
  tasksProcessed: number;
  tasksSucceeded: number;
  tasksFailed: number;
  failureRate: number;        // 0-1

  /** Cost */
  totalCostUsd: number;
  costByTier: Record<string, number>;
  costByModel: Record<string, number>;

  /** Latency */
  avgLatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;

  /** Slowest tasks */
  slowestTasks: Array<{
    traceId: string;
    taskPreview: string;
    durationMs: number;
    tier: string;
    model: string;
  }>;

  /** Evaluator health */
  evaluator: {
    totalEvaluations: number;
    ollamaOnlyPercent: number;
    sonnetVerifiedPercent: number;
    fallbackPercent: number;
    agreementRate: number;
    avgDivergence: number;
    divergenceTrend: "stable" | "diverging" | "converging";
    divergenceTrendValue: number;
  };

  /** Tier distribution */
  tierDistribution: Record<string, { count: number; percent: number }>;

  /** Anomalies / alerts */
  alerts: string[];
}

// ─────────────────────────────────────────────────────────────────
// Recorder API
// ─────────────────────────────────────────────────────────────────

export interface FlightRecorderAPI {
  // Span lifecycle
  startTrace(stage: PipelineStage, metadata?: Partial<StageMetadata>): TraceId;
  startSpan(traceId: TraceId, stage: PipelineStage, parentSpanId?: SpanId): SpanId;
  endSpan(traceId: TraceId, spanId: SpanId, status: SpanStatus, metadata?: Partial<StageMetadata>, statusMessage?: string): void;
  addMetadata(traceId: TraceId, spanId: SpanId, metadata: Partial<StageMetadata>): void;

  // Trace completion
  completeTrace(traceId: TraceId, status: SpanStatus): void;

  // Queries
  getTrace(traceId: TraceId): Trace | null;
  getRecentTraces(limit?: number): Trace[];
  getMetrics(): PipelineMetrics;
  generateDigest(periodHours?: number): HealthDigest;

  // Lifecycle
  flush(): void;              // Force write pending spans to SQLite
  close(): void;              // Flush + close DB
  recoverOrphans(): number;   // Close interrupted spans after restart
}
```

---

## 4. SQLite Ring Buffer Schema

```sql
-- File: ~/.openclaw/router/flight-recorder.sqlite
-- Separate DB from queue.sqlite to avoid contention on the hot path.

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;          -- Durability trade-off: 1 sec of data at risk
PRAGMA cache_size = -2000;            -- 2MB cache
PRAGMA busy_timeout = 5000;

-- ─────────────────────────────────────────────────────────────────
-- Traces table (ring buffer: max 1000 rows)
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS traces (
  trace_id          TEXT PRIMARY KEY,       -- W3C 128-bit hex
  root_stage        TEXT NOT NULL,          -- pipeline stage of root span
  start_time_ms     REAL NOT NULL,          -- epoch ms (µs precision)
  end_time_ms       REAL,                   -- null if still open
  duration_ms       REAL,                   -- computed on close
  status            TEXT NOT NULL DEFAULT 'OK',
  task_preview      TEXT,                   -- first 200 chars
  channel           TEXT,
  tier              TEXT,                   -- final tier (haiku/sonnet/opus)
  model             TEXT,                   -- final model used
  total_tokens      INTEGER DEFAULT 0,
  estimated_cost    REAL DEFAULT 0.0,       -- USD
  success           INTEGER DEFAULT 1,      -- boolean 0/1
  error_message     TEXT,
  retry_count       INTEGER DEFAULT 0,
  sonnet_verified   INTEGER DEFAULT 0,      -- boolean 0/1
  eval_divergence   REAL,                   -- |ollama - sonnet|
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),

  -- Job correlation
  envelope_id       TEXT,                   -- cortex envelope ID
  job_id            TEXT                    -- router job ID
);

CREATE INDEX IF NOT EXISTS idx_traces_start ON traces(start_time_ms);
CREATE INDEX IF NOT EXISTS idx_traces_status ON traces(status);
CREATE INDEX IF NOT EXISTS idx_traces_tier ON traces(tier);
CREATE INDEX IF NOT EXISTS idx_traces_created ON traces(created_at);

-- ─────────────────────────────────────────────────────────────────
-- Spans table (child spans for each trace)
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS spans (
  span_id           TEXT NOT NULL,          -- W3C 64-bit hex
  trace_id          TEXT NOT NULL REFERENCES traces(trace_id) ON DELETE CASCADE,
  parent_span_id    TEXT,                   -- null for root span
  stage             TEXT NOT NULL,          -- pipeline stage
  kind              TEXT NOT NULL DEFAULT 'INTERNAL',
  start_time_ms     REAL NOT NULL,
  end_time_ms       REAL,
  duration_ms       REAL,
  status            TEXT NOT NULL DEFAULT 'OK',
  status_message    TEXT,
  metadata_json     TEXT,                   -- JSON blob of StageMetadata
  PRIMARY KEY (trace_id, span_id)
);

CREATE INDEX IF NOT EXISTS idx_spans_trace ON spans(trace_id);
CREATE INDEX IF NOT EXISTS idx_spans_stage ON spans(stage);

-- ─────────────────────────────────────────────────────────────────
-- Metrics snapshots (periodic persistence for restart recovery)
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS metrics_snapshots (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_time     TEXT NOT NULL DEFAULT (datetime('now')),
  metrics_json      TEXT NOT NULL,          -- serialized PipelineMetrics
  period_start      TEXT NOT NULL,
  period_end        TEXT NOT NULL
);

-- Only keep last 28 snapshots (7 days × 4 per day at 6h intervals)
-- Eviction handled in application code.

-- ─────────────────────────────────────────────────────────────────
-- Health digests (generated every 6 hours)
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS health_digests (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  generated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  period_start      TEXT NOT NULL,
  period_end        TEXT NOT NULL,
  digest_json       TEXT NOT NULL            -- serialized HealthDigest
);

-- Keep last 56 digests (14 days × 4 per day)

-- ─────────────────────────────────────────────────────────────────
-- Ring buffer eviction trigger
-- ─────────────────────────────────────────────────────────────────
-- Application-level eviction (not a SQLite trigger, to avoid
-- trigger complexity with WAL mode):
--
-- Before INSERT into traces:
--   SELECT COUNT(*) FROM traces → if >= 1000:
--     DELETE FROM traces
--     WHERE trace_id IN (
--       SELECT trace_id FROM traces
--       ORDER BY start_time_ms ASC
--       LIMIT (count - 999)
--     );
--   (CASCADE deletes corresponding spans automatically)
```

---

## 5. Metrics Aggregation Algorithm

```typescript
// src/router/flight-recorder/metrics.ts

/**
 * In-memory metrics aggregator using reservoir sampling + streaming percentiles.
 *
 * Design choices:
 * - T-Digest for percentile estimation (memory-bounded, mergeable)
 * - Exponentially weighted moving average (EWMA) for trend detection
 * - No external dependencies — hand-rolled T-Digest subset (~100 lines)
 */

// ─────────────────────────────────────────────────────────────────
// Streaming Percentile Estimator (simplified T-Digest)
// ─────────────────────────────────────────────────────────────────

interface Centroid {
  mean: number;
  count: number;
}

class PercentileDigest {
  private centroids: Centroid[] = [];
  private totalCount = 0;
  private readonly maxCentroids: number;

  constructor(maxCentroids = 100) {
    this.maxCentroids = maxCentroids;
  }

  add(value: number): void {
    this.centroids.push({ mean: value, count: 1 });
    this.totalCount++;

    // Compress when exceeding 2× max centroids
    if (this.centroids.length > this.maxCentroids * 2) {
      this.compress();
    }
  }

  private compress(): void {
    this.centroids.sort((a, b) => a.mean - b.mean);
    const compressed: Centroid[] = [];
    let current = { ...this.centroids[0] };

    for (let i = 1; i < this.centroids.length; i++) {
      const next = this.centroids[i];
      // Merge adjacent centroids if combined count is small enough
      const combinedCount = current.count + next.count;
      const quantile = combinedCount / this.totalCount;
      if (quantile < 1 / this.maxCentroids) {
        current.mean =
          (current.mean * current.count + next.mean * next.count) /
          combinedCount;
        current.count = combinedCount;
      } else {
        compressed.push(current);
        current = { ...next };
      }
    }
    compressed.push(current);
    this.centroids = compressed;
  }

  percentile(p: number): number {
    if (this.centroids.length === 0) return 0;

    this.centroids.sort((a, b) => a.mean - b.mean);
    const target = p * this.totalCount;
    let cumulative = 0;

    for (const c of this.centroids) {
      cumulative += c.count;
      if (cumulative >= target) return c.mean;
    }

    return this.centroids[this.centroids.length - 1].mean;
  }

  getPercentiles(): LatencyPercentiles {
    return {
      p50: this.percentile(0.5),
      p95: this.percentile(0.95),
      p99: this.percentile(0.99),
      min: this.centroids.length > 0
        ? Math.min(...this.centroids.map((c) => c.mean))
        : 0,
      max: this.centroids.length > 0
        ? Math.max(...this.centroids.map((c) => c.mean))
        : 0,
      count: this.totalCount,
    };
  }

  reset(): void {
    this.centroids = [];
    this.totalCount = 0;
  }
}

// ─────────────────────────────────────────────────────────────────
// EWMA for trend detection
// ─────────────────────────────────────────────────────────────────

class EWMA {
  private value: number | null = null;
  private readonly alpha: number;

  /**
   * @param halfLifeSamples — number of samples for the weight to decay to 50%
   */
  constructor(halfLifeSamples = 20) {
    this.alpha = 1 - Math.exp(-Math.LN2 / halfLifeSamples);
  }

  update(sample: number): number {
    if (this.value === null) {
      this.value = sample;
    } else {
      this.value = this.alpha * sample + (1 - this.alpha) * this.value;
    }
    return this.value;
  }

  get(): number {
    return this.value ?? 0;
  }
}

// ─────────────────────────────────────────────────────────────────
// Main Aggregator
// ─────────────────────────────────────────────────────────────────

class MetricsAggregator {
  // Per-tier digests
  private tierLatency = new Map<string, PercentileDigest>();
  private tierCounts = new Map<string, { total: number; success: number; fail: number; tokens: number; cost: number }>();

  // Per-model digests
  private modelStats = new Map<string, {
    calls: number; success: number; fail: number;
    latencySum: number; tokensInSum: number; tokensOutSum: number; cost: number;
  }>();

  // Evaluator tracking
  private evalStats = {
    total: 0,
    ollamaOnly: 0,
    sonnetVerified: 0,
    fallback: 0,
    agreements: 0,        // |ollama - sonnet| ≤ 1
    comparisons: 0,       // total where both scored
    divergenceSum: 0,
  };
  private divergenceEwma = new EWMA(20);

  // Pipeline-level digests
  private e2eLatency = new PercentileDigest();
  private queueWaitDigest = new PercentileDigest();
  private evaluateDigest = new PercentileDigest();
  private executeDigest = new PercentileDigest();
  private deliverDigest = new PercentileDigest();

  private totalCost = 0;
  private hungJobCount = 0;
  private totalRetries = 0;
  private collectionStartedAt = new Date().toISOString();

  /**
   * Record a completed trace's metrics.
   * Called once per trace completion from the Recorder.
   *
   * Algorithm:
   * 1. Extract timing from spans by stage
   * 2. Update per-tier percentile digest
   * 3. Update per-model counters
   * 4. Update evaluator agreement tracking
   * 5. Update pipeline-level percentile digests
   * 6. Accumulate cost
   *
   * Time complexity: O(S) where S = number of spans in trace (typically 5-12)
   * Space: O(1) amortized (digest compression keeps centroids bounded)
   */
  recordTrace(trace: Trace): void {
    const { summary, spans } = trace;

    // 1. Per-tier metrics
    const tier = summary.tier ?? "unknown";
    if (!this.tierLatency.has(tier)) {
      this.tierLatency.set(tier, new PercentileDigest());
      this.tierCounts.set(tier, { total: 0, success: 0, fail: 0, tokens: 0, cost: 0 });
    }
    if (trace.totalDurationMs !== null) {
      this.tierLatency.get(tier)!.add(trace.totalDurationMs);
    }
    const tc = this.tierCounts.get(tier)!;
    tc.total++;
    if (summary.success) tc.success++;
    else tc.fail++;
    tc.tokens += summary.totalTokens;
    tc.cost += summary.estimatedCostUsd;

    // 2. Per-model metrics
    const model = summary.model ?? "unknown";
    if (!this.modelStats.has(model)) {
      this.modelStats.set(model, {
        calls: 0, success: 0, fail: 0,
        latencySum: 0, tokensInSum: 0, tokensOutSum: 0, cost: 0,
      });
    }
    const ms = this.modelStats.get(model)!;
    ms.calls++;
    if (summary.success) ms.success++;
    else ms.fail++;
    ms.latencySum += trace.totalDurationMs ?? 0;
    ms.cost += summary.estimatedCostUsd;

    // Extract token details from executor.llm or cortex.llm spans
    for (const span of spans) {
      const meta = span.metadata;
      if ("tokensIn" in meta && "tokensOut" in meta) {
        ms.tokensInSum += (meta as any).tokensIn ?? 0;
        ms.tokensOutSum += (meta as any).tokensOut ?? 0;
      }
    }

    // 3. Evaluator metrics
    const evalSpan = spans.find((s) => s.stage === "router.evaluate");
    if (evalSpan && evalSpan.metadata && "stage" in evalSpan.metadata
        && evalSpan.metadata.stage === "router.evaluate") {
      const em = evalSpan.metadata as RouterEvaluateMetadata;
      this.evalStats.total++;

      if (em.decisionSource === "ollama") this.evalStats.ollamaOnly++;
      else if (em.decisionSource === "sonnet") this.evalStats.sonnetVerified++;
      else if (em.decisionSource === "fallback") this.evalStats.fallback++;

      if (em.divergence !== null) {
        this.evalStats.comparisons++;
        this.evalStats.divergenceSum += em.divergence;
        if (em.divergence <= 1) this.evalStats.agreements++;
        this.divergenceEwma.update(em.divergence);
      }
    }

    // 4. Pipeline-level timing (extract from spans)
    if (trace.totalDurationMs !== null) {
      this.e2eLatency.add(trace.totalDurationMs);
    }

    for (const span of spans) {
      if (span.durationMs === null) continue;
      switch (span.stage) {
        case "router.policy":
          this.queueWaitDigest.add(span.durationMs);
          break;
        case "router.evaluate":
          this.evaluateDigest.add(span.durationMs);
          break;
        case "router.execute":
          this.executeDigest.add(span.durationMs);
          break;
        case "router.deliver":
          this.deliverDigest.add(span.durationMs);
          break;
      }
    }

    // 5. Cost
    this.totalCost += summary.estimatedCostUsd;
  }

  recordHungJob(): void { this.hungJobCount++; }
  recordRetry(): void { this.totalRetries++; }

  getMetrics(currentQueueDepth: number, currentExecuting: number): PipelineMetrics {
    const tiers: Record<string, TierMetrics> = {};
    for (const [tier, digest] of this.tierLatency) {
      const counts = this.tierCounts.get(tier)!;
      tiers[tier] = {
        tier,
        taskCount: counts.total,
        successCount: counts.success,
        failureCount: counts.fail,
        successRate: counts.total > 0 ? counts.success / counts.total : 1,
        latency: digest.getPercentiles(),
        avgTokensPerTask: counts.total > 0 ? counts.tokens / counts.total : 0,
        totalCostUsd: counts.cost,
      };
    }

    const models: Record<string, ModelMetrics> = {};
    for (const [model, stats] of this.modelStats) {
      models[model] = {
        model,
        callCount: stats.calls,
        successCount: stats.success,
        failureCount: stats.fail,
        successRate: stats.calls > 0 ? stats.success / stats.calls : 1,
        avgLatencyMs: stats.calls > 0 ? stats.latencySum / stats.calls : 0,
        avgTokensIn: stats.calls > 0 ? stats.tokensInSum / stats.calls : 0,
        avgTokensOut: stats.calls > 0 ? stats.tokensOutSum / stats.calls : 0,
        totalCostUsd: stats.cost,
      };
    }

    const e = this.evalStats;
    const evaluator: EvaluatorMetrics = {
      totalEvaluations: e.total,
      ollamaOnlyCount: e.ollamaOnly,
      sonnetVerifiedCount: e.sonnetVerified,
      fallbackCount: e.fallback,
      agreementRate: e.comparisons > 0 ? e.agreements / e.comparisons : 1,
      avgDivergence: e.comparisons > 0 ? e.divergenceSum / e.comparisons : 0,
      divergenceTrend: this.divergenceEwma.get(),
      ollamaDistribution: new Array(10).fill(0), // populated from SQLite on demand
      sonnetDistribution: new Array(10).fill(0),
    };

    const e2e = this.e2eLatency.getPercentiles();

    return {
      collectionStartedAt: this.collectionStartedAt,
      totalTraces: e2e.count,
      tiers,
      models,
      evaluator,
      pipeline: {
        avgE2eLatencyMs: e2e.count > 0 ? e2e.p50 : 0, // use p50 as proxy
        e2eLatency: e2e,
        avgQueueWaitMs: this.queueWaitDigest.getPercentiles().p50,
        avgEvaluateMs: this.evaluateDigest.getPercentiles().p50,
        avgExecuteMs: this.executeDigest.getPercentiles().p50,
        avgDeliverMs: this.deliverDigest.getPercentiles().p50,
        currentQueueDepth,
        currentExecuting,
        totalCostUsd: this.totalCost,
        hungJobCount: this.hungJobCount,
        totalRetries: this.totalRetries,
      },
    };
  }
}

// Types referenced from types.ts
import type {
  LatencyPercentiles,
  TierMetrics,
  ModelMetrics,
  EvaluatorMetrics,
  PipelineMetrics,
  Trace,
  RouterEvaluateMetadata,
} from "./types.js";
```

---

## 6. Health Digest

### Generation Algorithm

```typescript
// src/router/flight-recorder/digest.ts

function generateDigest(
  db: DatabaseSync,
  metrics: PipelineMetrics,
  periodHours: number = 6,
): HealthDigest {
  const now = Date.now();
  const periodStart = new Date(now - periodHours * 3600 * 1000).toISOString();
  const periodEnd = new Date(now).toISOString();

  // Query recent traces from SQLite for the period
  const recentTraces = db.prepare(`
    SELECT * FROM traces
    WHERE start_time_ms >= ? AND start_time_ms <= ?
    ORDER BY start_time_ms DESC
  `).all(now - periodHours * 3600 * 1000, now) as any[];

  const total = recentTraces.length;
  const succeeded = recentTraces.filter(t => t.success === 1).length;
  const failed = total - succeeded;

  // Slowest 5 tasks
  const slowest = recentTraces
    .filter(t => t.duration_ms !== null)
    .sort((a, b) => (b.duration_ms ?? 0) - (a.duration_ms ?? 0))
    .slice(0, 5)
    .map(t => ({
      traceId: t.trace_id,
      taskPreview: t.task_preview ?? "",
      durationMs: t.duration_ms ?? 0,
      tier: t.tier ?? "unknown",
      model: t.model ?? "unknown",
    }));

  // Cost by tier
  const costByTier: Record<string, number> = {};
  for (const [tier, tm] of Object.entries(metrics.tiers)) {
    costByTier[tier] = tm.totalCostUsd;
  }

  // Cost by model
  const costByModel: Record<string, number> = {};
  for (const [model, mm] of Object.entries(metrics.models)) {
    costByModel[model] = mm.totalCostUsd;
  }

  // Tier distribution
  const tierDistribution: Record<string, { count: number; percent: number }> = {};
  for (const [tier, tm] of Object.entries(metrics.tiers)) {
    tierDistribution[tier] = {
      count: tm.taskCount,
      percent: total > 0 ? tm.taskCount / total : 0,
    };
  }

  // Divergence trend classification
  const dv = metrics.evaluator.divergenceTrend;
  const divergenceTrend: "stable" | "diverging" | "converging" =
    Math.abs(dv) < 0.5 ? "stable" : dv > 0 ? "diverging" : "converging";

  // Alerts
  const alerts: string[] = [];
  if (failed / Math.max(total, 1) > 0.1) {
    alerts.push(`⚠️ High failure rate: ${(failed / total * 100).toFixed(1)}% (${failed}/${total} tasks failed)`);
  }
  if (metrics.evaluator.fallbackCount > metrics.evaluator.totalEvaluations * 0.2) {
    alerts.push(`⚠️ Evaluator fallback rate high: ${metrics.evaluator.fallbackCount}/${metrics.evaluator.totalEvaluations} used fallback weight`);
  }
  if (metrics.evaluator.agreementRate < 0.6 && metrics.evaluator.sonnetVerifiedCount > 5) {
    alerts.push(`⚠️ Evaluator disagreement: Ollama↔Sonnet agreement at ${(metrics.evaluator.agreementRate * 100).toFixed(0)}%`);
  }
  if (metrics.pipeline.hungJobCount > 0) {
    alerts.push(`⚠️ ${metrics.pipeline.hungJobCount} hung jobs detected by watchdog`);
  }
  if (metrics.pipeline.e2eLatency.p99 > 120_000) {
    alerts.push(`⚠️ p99 latency > 2 minutes: ${(metrics.pipeline.e2eLatency.p99 / 1000).toFixed(1)}s`);
  }

  return {
    generatedAt: periodEnd,
    periodStart,
    periodEnd,
    periodHours,
    tasksProcessed: total,
    tasksSucceeded: succeeded,
    tasksFailed: failed,
    failureRate: total > 0 ? failed / total : 0,
    totalCostUsd: metrics.pipeline.totalCostUsd,
    costByTier,
    costByModel,
    avgLatencyMs: metrics.pipeline.e2eLatency.p50,
    p95LatencyMs: metrics.pipeline.e2eLatency.p95,
    p99LatencyMs: metrics.pipeline.e2eLatency.p99,
    slowestTasks: slowest,
    evaluator: {
      totalEvaluations: metrics.evaluator.totalEvaluations,
      ollamaOnlyPercent: metrics.evaluator.totalEvaluations > 0
        ? metrics.evaluator.ollamaOnlyCount / metrics.evaluator.totalEvaluations
        : 0,
      sonnetVerifiedPercent: metrics.evaluator.totalEvaluations > 0
        ? metrics.evaluator.sonnetVerifiedCount / metrics.evaluator.totalEvaluations
        : 0,
      fallbackPercent: metrics.evaluator.totalEvaluations > 0
        ? metrics.evaluator.fallbackCount / metrics.evaluator.totalEvaluations
        : 0,
      agreementRate: metrics.evaluator.agreementRate,
      avgDivergence: metrics.evaluator.avgDivergence,
      divergenceTrend,
      divergenceTrendValue: dv,
    },
    tierDistribution,
    alerts,
  };
}
```

### Sample Health Digest Output

```
╔══════════════════════════════════════════════════════════════════╗
║           🛫 Flight Recorder — Health Digest                    ║
║           Period: 2026-03-05 04:57 → 10:57 UTC+2 (6h)          ║
╚══════════════════════════════════════════════════════════════════╝

📊 Summary
  Tasks processed:   47
  Succeeded:         44 (93.6%)
  Failed:             3 (6.4%)
  Total cost:        $0.284

⏱️ Latency
  Average (p50):     4,230 ms
  p95:              18,450 ms
  p99:              42,100 ms

💰 Cost by Tier
  haiku:   $0.018  (22 tasks, 46.8%)
  sonnet:  $0.156  (19 tasks, 40.4%)
  opus:    $0.110   (6 tasks, 12.8%)

🧠 Evaluator Health
  Total evaluations:    47
  Ollama-only (w≤2):    22 (46.8%)
  Sonnet-verified:      21 (44.7%)
  Fallback (both fail):  4 (8.5%)
  Agreement rate:       76.2% (when both scored, |Δ| ≤ 1)
  Avg divergence:       1.8 points
  Trend:                stable (EWMA = 0.3)

🐢 Slowest Tasks
  1. [trace-a7f3...] "Analyze the current observability gaps acr..."
     Duration: 42,100ms | Tier: opus | Model: claude-opus-4-6
  2. [trace-b2e1...] "Design a comprehensive API for the new pa..."
     Duration: 38,200ms | Tier: opus | Model: claude-opus-4-6
  3. [trace-c9d4...] "Review PR #247 and suggest improvements..."
     Duration: 24,800ms | Tier: sonnet | Model: claude-sonnet-4-6
  4. [trace-d1a8...] "Summarize the meeting notes from today's..."
     Duration: 18,450ms | Tier: sonnet | Model: claude-sonnet-4-6
  5. [trace-e5c2...] "What's the weather in Bucharest?"
     Duration: 12,300ms | Tier: haiku | Model: claude-haiku-4-5

📈 Tier Distribution
  ▓▓▓▓▓▓▓▓▓░░░░░░░░░░░  haiku   46.8%  (22)
  ▓▓▓▓▓▓▓▓░░░░░░░░░░░░  sonnet  40.4%  (19)
  ▓▓▓░░░░░░░░░░░░░░░░░  opus    12.8%   (6)

⚠️ Alerts
  ⚠️ Evaluator fallback rate high: 4/47 used fallback weight
  ⚠️ 1 hung job detected by watchdog
```

---

## 7. Integration Points — Exact Instrumentation Locations

### 7.1 `cortex/loop.ts` — Cortex Layer Instrumentation

```typescript
// ═══════════════════════════════════════════════════════════════
// INTEGRATION POINT 1: Cortex intake (message dequeue)
// Location: cortex/loop.ts, inside tick(), after dequeueNext()
// Line: ~62 (after `const msg = dequeueNext(db);`)
// ═══════════════════════════════════════════════════════════════

// BEFORE (existing code):
const msg = dequeueNext(db);
if (!msg) { /* ... */ }
markProcessing(db, msg.envelope.id);

// AFTER (instrumented):
const msg = dequeueNext(db);
if (!msg) { /* ... */ }

// 🔧 INSTRUMENT: Start a new trace for this message
const traceId = recorder.startTrace("cortex.intake", {
  stage: "cortex.intake",
  envelopeId: msg.envelope.id,
  channel: msg.envelope.channel,
  priority: msg.envelope.priority,
  isOpsTrigger: msg.envelope.metadata?.ops_trigger === true,
  contentPreview: msg.envelope.content.slice(0, 120),
  busQueueDepth: countPending(db),
} as CortexIntakeMetadata);
const intakeSpanId = recorder.rootSpanId(traceId);

// Store traceId on the envelope for downstream correlation
(msg.envelope as any).__traceId = traceId;
(msg.envelope as any).__intakeSpanId = intakeSpanId;

markProcessing(db, msg.envelope.id);
recorder.endSpan(traceId, intakeSpanId, "OK");


// ═══════════════════════════════════════════════════════════════
// INTEGRATION POINT 2: Context assembly
// Location: cortex/loop.ts, around line ~100 (assembleContext call)
// ═══════════════════════════════════════════════════════════════

// BEFORE:
let context = await assembleContext({ /* ... */ });

// AFTER:
const contextSpanId = recorder.startSpan(traceId, "cortex.context", intakeSpanId);
let context = await assembleContext({ /* ... */ });
recorder.endSpan(traceId, contextSpanId, "OK", {
  stage: "cortex.context",
  tokenCount: context.estimatedTokens ?? 0,
  hippocampusEnabled: !!hippocampusEnabled,
  sessionMessageCount: context.messages?.length ?? 0,
} as CortexContextMetadata);


// ═══════════════════════════════════════════════════════════════
// INTEGRATION POINT 3: LLM call (including tool rounds)
// Location: cortex/loop.ts, around line ~112 (callLLM)
// ═══════════════════════════════════════════════════════════════

// BEFORE:
let llmResult = await callLLM(context);

// AFTER:
const llmSpanId = recorder.startSpan(traceId, "cortex.llm", intakeSpanId);
let llmResult = await callLLM(context);
// ... (after tool loop completes, before parseResponse) ...
recorder.endSpan(traceId, llmSpanId, "OK", {
  stage: "cortex.llm",
  model: context.model ?? "unknown",
  tokensIn: llmResult.usage?.input ?? 0,
  tokensOut: llmResult.usage?.output ?? 0,
  tokensCached: llmResult.usage?.cacheRead ?? 0,
  toolRounds: round,  // from the for loop counter
  syncToolCalls: llmResult.toolCalls.filter(tc => SYNC_TOOL_NAMES.has(tc.name)).map(tc => tc.name),
} as CortexLlmMetadata);


// ═══════════════════════════════════════════════════════════════
// INTEGRATION POINT 4: Spawn (Router delegation)
// Location: cortex/loop.ts, around line ~145 (sessions_spawn handling)
// ═══════════════════════════════════════════════════════════════

// BEFORE:
const jobId = onSpawn({ task, replyChannel, resultPriority, envelopeId: msg.envelope.id, taskId, resources });

// AFTER:
const spawnSpanId = recorder.startSpan(traceId, "cortex.spawn", intakeSpanId);
const jobId = onSpawn({ task, replyChannel, resultPriority, envelopeId: msg.envelope.id, taskId, resources });

// Pass traceId to Router via the payload so Router spans share the same trace
(msg.envelope as any).__routerTraceId = traceId;
(msg.envelope as any).__spawnSpanId = spawnSpanId;

recorder.endSpan(traceId, spawnSpanId, jobId ? "OK" : "ERROR", {
  stage: "cortex.spawn",
  taskId,
  taskPreview: task.slice(0, 200),
  replyChannel,
  resultPriority,
  resourceCount: resolvedResources.length,
} as CortexSpawnMetadata);


// ═══════════════════════════════════════════════════════════════
// INTEGRATION POINT 5: Output routing
// Location: cortex/loop.ts, around line ~173 (routeOutput)
// ═══════════════════════════════════════════════════════════════

// BEFORE:
await routeOutput({ output, registry, onError: (channel, err) => { /* ... */ } });

// AFTER:
const outputSpanId = recorder.startSpan(traceId, "cortex.output", intakeSpanId);
const deliveryErrors: string[] = [];
await routeOutput({
  output,
  registry,
  onError: (channel, err) => {
    deliveryErrors.push(`${channel}: ${err.message}`);
    onError(new Error(`Adapter send failed [${channel}]: ${err.message}`));
  },
});
recorder.endSpan(traceId, outputSpanId, deliveryErrors.length > 0 ? "ERROR" : "OK", {
  stage: "cortex.output",
  targetChannels: output.targets.map(t => t.channel),
  silent: output.targets.length === 0,
  deliveryErrors,
} as CortexOutputMetadata);

// Complete the trace
recorder.completeTrace(traceId, deliveryErrors.length > 0 ? "ERROR" : "OK");
```

### 7.2 `router/loop.ts` — Router Layer Instrumentation

```typescript
// ═══════════════════════════════════════════════════════════════
// INTEGRATION POINT 6: Concurrency/policy check
// Location: router/loop.ts, processTick(), line ~58
// ═══════════════════════════════════════════════════════════════

// BEFORE:
const executing = db.prepare(`SELECT count(*) as c FROM jobs WHERE status = 'in_execution'`).get() as { c: number };
if (executing.c >= MAX_CONCURRENT) return;

// AFTER:
const executing = db.prepare(`SELECT count(*) as c FROM jobs WHERE status = 'in_execution'`).get() as { c: number };
if (executing.c >= MAX_CONCURRENT) {
  // 🔧 Record policy rejection (trace ID is not yet known — logged as orphan metric)
  recorder.recordPolicyBlock(executing.c, MAX_CONCURRENT);
  return;
}


// ═══════════════════════════════════════════════════════════════
// INTEGRATION POINT 7: New job evaluation
// Location: router/loop.ts, processTick(), line ~73
// ═══════════════════════════════════════════════════════════════

// BEFORE:
const job = dequeue(db);
if (!job) return;
const result = await evaluate(config.evaluator, payload.message ?? "", payload.context);

// AFTER:
const job = dequeue(db);
if (!job) return;

// 🔧 Recover or create trace ID — check if Cortex embedded one in the payload
const payload = typeof job.payload === "string" ? JSON.parse(job.payload) : job.payload;
const traceId: TraceId = payload.__traceId ?? recorder.startTrace("router.enqueue");

// Start enqueue span
const enqueueSpanId = recorder.startSpan(traceId, "router.enqueue");
recorder.endSpan(traceId, enqueueSpanId, "OK", {
  stage: "router.enqueue",
  jobId: job.id,
  jobType: job.type,
  issuer: job.issuer,
  payloadSizeBytes: JSON.stringify(job.payload).length,
} as RouterEnqueueMetadata);

// Start evaluate span
const evalSpanId = recorder.startSpan(traceId, "router.evaluate", enqueueSpanId);
const result = await evaluate(config.evaluator, payload.message ?? "", payload.context);
// (evaluator itself records sub-spans — see Integration Point 9)
recorder.endSpan(traceId, evalSpanId, "OK", {
  stage: "router.evaluate",
  finalWeight: result.weight,
  reasoning: result.reasoning,
  // Sub-span data populated by evaluator instrumentation
} as Partial<RouterEvaluateMetadata>);

// Store traceId on job for worker access
(job as any).__traceId = traceId;
(job as any).__evalSpanId = evalSpanId;


// ═══════════════════════════════════════════════════════════════
// INTEGRATION POINT 8: Silent error swallow — FIX
// Location: router/loop.ts, processTick(), outer catch (line ~109)
// ═══════════════════════════════════════════════════════════════

// BEFORE:
} catch {
  // Top-level safety net — never let the loop crash
}

// AFTER:
} catch (err) {
  // 🔧 Top-level safety net — never let the loop crash, BUT RECORD IT
  const detail = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  console.error(`[router/loop] processTick unhandled error: ${detail}`);
  if (stack) console.error(`[router/loop] stack: ${stack}`);
  recorder.recordAnomaly("processTick_unhandled", detail);
}


// ═══════════════════════════════════════════════════════════════
// INTEGRATION POINT 8b: Watchdog hung job detection
// Location: router/loop.ts, watchdogTick(), line ~102-108
// ═══════════════════════════════════════════════════════════════

// BEFORE:
if (job.retry_count < MAX_RETRIES) {
  const timer = setTimeout(() => { /* ... */ }, RETRY_DELAY_MS);

// AFTER:
if (job.retry_count < MAX_RETRIES) {
  recorder.recordRetry();
  console.warn(`[router/watchdog] hung job ${job.id}, scheduling retry ${job.retry_count + 1}/${MAX_RETRIES}`);
  const timer = setTimeout(() => { /* ... */ }, RETRY_DELAY_MS);
// Also for permanent failure:
} else {
  recorder.recordHungJob();
  console.error(`[router/watchdog] job ${job.id} permanently failed after ${MAX_RETRIES} retries`);
```

### 7.3 `router/evaluator.ts` — Evaluator Sub-span Instrumentation

```typescript
// ═══════════════════════════════════════════════════════════════
// INTEGRATION POINT 9: Ollama scoring sub-span
// Location: router/evaluator.ts, evaluate(), line ~118
// ═══════════════════════════════════════════════════════════════

// Inside evaluate(), the traceId and parent evalSpanId are passed
// via a new optional parameter or thread-local context:

export async function evaluate(
  config: EvaluatorConfig,
  task: string,
  context?: string,
  // 🔧 NEW: optional trace context for Flight Recorder
  traceCtx?: { traceId: TraceId; parentSpanId: SpanId },
): Promise<EvaluatorResult> {

  // ... existing template rendering ...

  // Stage 1: Ollama
  let ollamaSpanId: SpanId | undefined;
  if (traceCtx) {
    ollamaSpanId = recorder.startSpan(traceCtx.traceId, "router.evaluate.ollama", traceCtx.parentSpanId);
  }
  let ollamaResult: EvaluatorResult | null = null;
  try {
    const ollamaText = await callOllama(userMessage, timeoutMs * 2);
    ollamaResult = parseEvaluatorResponse(ollamaText, config.fallback_weight);
    if (traceCtx && ollamaSpanId) {
      recorder.endSpan(traceCtx.traceId, ollamaSpanId, "OK", {
        stage: "router.evaluate.ollama",
        model: OLLAMA_MODEL,
        rawResponse: ollamaText.slice(0, 200),
        parsedWeight: ollamaResult.weight,
        tokensIn: 0,  // populated by callOllama instrumentation
        tokensOut: 0,
        success: true,
        errorMessage: null,
      } as EvaluatorOllamaMetadata);
    }
  } catch (err) {
    if (traceCtx && ollamaSpanId) {
      recorder.endSpan(traceCtx.traceId, ollamaSpanId, "ERROR", {
        stage: "router.evaluate.ollama",
        model: OLLAMA_MODEL,
        rawResponse: "",
        parsedWeight: null,
        tokensIn: 0,
        tokensOut: 0,
        success: false,
        errorMessage: err instanceof Error ? err.message : String(err),
      } as EvaluatorOllamaMetadata);
    }
  }

  // Stage 2: Sonnet verification (same pattern)
  if (ollamaResult && ollamaResult.weight <= 2) {
    // Skip Sonnet — record SKIPPED span
    if (traceCtx) {
      const sonnetSpanId = recorder.startSpan(traceCtx.traceId, "router.evaluate.sonnet", traceCtx.parentSpanId);
      recorder.endSpan(traceCtx.traceId, sonnetSpanId, "SKIPPED", {
        stage: "router.evaluate.sonnet",
        model: EVALUATOR_MODEL,
        rawResponse: "",
        parsedWeight: null,
        tokensIn: 0, tokensOut: 0,
        success: false,
        errorMessage: "skipped: ollama weight ≤ 2",
      } as EvaluatorSonnetMetadata);
    }
  } else {
    // Call Sonnet — same span pattern as Ollama above
    let sonnetSpanId: SpanId | undefined;
    if (traceCtx) {
      sonnetSpanId = recorder.startSpan(traceCtx.traceId, "router.evaluate.sonnet", traceCtx.parentSpanId);
    }
    // ... existing verifySonnet call with span end on success/failure ...
  }
}
```

### 7.4 `router/dispatcher.ts` — Dispatch Span

```typescript
// ═══════════════════════════════════════════════════════════════
// INTEGRATION POINT 10: Dispatch
// Location: router/dispatcher.ts, dispatch(), entire function
// ═══════════════════════════════════════════════════════════════

export function dispatch(db, job, config, executor): void {
  // 🔧 Recover trace context from job
  const traceId: TraceId | undefined = (job as any).__traceId;
  const dispatchSpanId = traceId
    ? recorder.startSpan(traceId, "router.dispatch")
    : undefined;

  const weight = job.weight ?? config.evaluator.fallback_weight;
  const tier = resolveWeightToTier(weight, config.tiers);
  const model = config.tiers[tier].model;
  // ... existing template rendering ...

  if (traceId && dispatchSpanId) {
    recorder.endSpan(traceId, dispatchSpanId, "OK", {
      stage: "router.dispatch",
      jobId: job.id,
      weight,
      tier,
      model,
      templateName: `${tier}/agent_run`,
      promptSizeChars: prompt.length,
      resourceCount: payload.resources?.length ?? 0,
    } as RouterDispatchMetadata);
  }

  updateJob(db, job.id, { tier, status: "in_execution" });

  // 🔧 Pass trace context to worker
  void run(db, job.id, prompt, model, executor, traceId);
}
```

### 7.5 `router/worker.ts` — Execution Span

```typescript
// ═══════════════════════════════════════════════════════════════
// INTEGRATION POINT 11: Worker execution
// Location: router/worker.ts, run(), entire function
// ═══════════════════════════════════════════════════════════════

export async function run(
  db, jobId, prompt, model,
  executor = defaultExecuteAgent,
  traceId?: TraceId,         // 🔧 NEW parameter
): Promise<void> {
  const executeSpanId = traceId
    ? recorder.startSpan(traceId, "router.execute")
    : undefined;

  let heartbeatCount = 0;
  // ... existing heartbeat setup ...
  const heartbeatTimer = setInterval(() => {
    heartbeatCount++;
    // ... existing checkpoint ...
  }, HEARTBEAT_INTERVAL_MS);

  try {
    // 🔧 Executor LLM sub-span
    const llmSpanId = traceId
      ? recorder.startSpan(traceId, "executor.llm", executeSpanId!)
      : undefined;

    const result = await executor(prompt, model);

    if (traceId && llmSpanId) {
      recorder.endSpan(traceId, llmSpanId, "OK", {
        stage: "executor.llm",
        model,
        sessionKey: `agent:router-executor:task:${jobId}`,
        tokensIn: 0,    // populated from callGateway response
        tokensOut: 0,
        tokensCached: 0,
        payloadCount: 1,
        resultSizeBytes: Buffer.byteLength(result, "utf-8"),
      } as ExecutorLlmMetadata);
    }

    clearInterval(heartbeatTimer);
    updateJob(db, jobId, { status: "completed", result, finished_at: nowTimestamp() });

    if (traceId && executeSpanId) {
      recorder.endSpan(traceId, executeSpanId, "OK", {
        stage: "router.execute",
        jobId,
        workerId: null,
        model,
        heartbeatCount,
        wasRetry: false,
        retryCount: 0,
      } as RouterExecuteMetadata);
    }

    routerEvents.emit("job:completed", { jobId });
  } catch (err) {
    clearInterval(heartbeatTimer);
    // ... existing error handling ...
    if (traceId && executeSpanId) {
      recorder.endSpan(traceId, executeSpanId, "ERROR", {
        stage: "router.execute",
        jobId,
        workerId: null,
        model,
        heartbeatCount,
        wasRetry: false,
        retryCount: 0,
      } as RouterExecuteMetadata, errorMessage);
    }
  }
}
```

### 7.6 `router/notifier.ts` — Delivery Span

```typescript
// ═══════════════════════════════════════════════════════════════
// INTEGRATION POINT 12: Delivery + archive
// Location: router/notifier.ts, deliverResult()
// ═══════════════════════════════════════════════════════════════

export function deliverResult(db, jobId): void {
  const job = getJob(db, jobId);
  if (!job || !TERMINAL_STATUSES.has(job.status)) return;

  // 🔧 Recover trace context
  const traceId: TraceId | undefined = (job as any).__traceId;
  const deliverSpanId = traceId
    ? recorder.startSpan(traceId, "router.deliver")
    : undefined;

  updateJob(db, jobId, { delivered_at: /* ... */ });
  const updatedJob = getJob(db, jobId);
  routerEvents.emit("job:delivered", { jobId, job: updatedJob ?? job });

  let archiveSuccess = true;
  try {
    archiveJob(db, jobId);
  } catch {
    archiveSuccess = false;
  }

  if (traceId && deliverSpanId) {
    recorder.endSpan(traceId, deliverSpanId, archiveSuccess ? "OK" : "ERROR", {
      stage: "router.deliver",
      jobId,
      jobStatus: job.status,
      resultSizeBytes: Buffer.byteLength(job.result ?? "", "utf-8"),
      issuer: job.issuer,
      deliveryTarget: job.issuer.includes("cortex") ? "cortex" : "session",
      archiveSuccess,
    } as RouterDeliverMetadata);

    // 🔧 Complete the trace
    recorder.completeTrace(traceId, job.status === "completed" ? "OK" : "ERROR");
  }
}
```

### Integration Summary — Trace Context Flow

```
Cortex intake
  │ traceId = recorder.startTrace("cortex.intake")
  │ envelope.__traceId = traceId
  ▼
Cortex LLM call → sessions_spawn
  │ traceId passed in spawn payload
  ▼
Router enqueue (queue.ts)
  │ traceId extracted from payload.__traceId
  │ job.__traceId = traceId
  ▼
Router evaluate (evaluator.ts)
  │ traceId passed as traceCtx parameter
  │ └── Ollama sub-span
  │ └── Sonnet sub-span
  ▼
Router dispatch (dispatcher.ts)
  │ traceId from job.__traceId
  │ passed to run() as parameter
  ▼
Worker execute (worker.ts)
  │ traceId from parameter
  │ └── executor.llm sub-span
  ▼
Notifier deliver (notifier.ts)
  │ traceId from job.__traceId
  │ recorder.completeTrace()
  ▼
Trace flushed to SQLite ring buffer
```

---

## 8. Performance & Storage Analysis

### 8.1 Storage Overhead of 1000 Traces in SQLite

**Per-trace storage estimate:**

| Component | Size | Notes |
|-----------|------|-------|
| `traces` row | ~600 bytes | Fixed fields + task_preview (200 chars) + model/tier strings |
| `spans` rows (avg 8 per trace) | ~400 bytes × 8 = 3,200 bytes | metadata_json is the bulk (~300 bytes avg per span) |
| SQLite overhead (page alignment, indexes) | ~800 bytes | B-tree nodes, index entries, page padding |
| **Total per trace** | **~4,600 bytes** | |
| **1000 traces** | **~4.6 MB** | |

**Including indexes and WAL:**

| Component | Size |
|-----------|------|
| Data (1000 traces) | 4.6 MB |
| Indexes (4 on traces, 2 on spans) | ~1.2 MB |
| WAL file (worst case) | ~2 MB |
| Metrics snapshots (28) | ~56 KB |
| Health digests (56) | ~112 KB |
| **Total on disk** | **~8 MB max** |

**Verdict:** Negligible. The existing `queue.sqlite` and `bus.sqlite` are comparable in size. 8 MB is well within SSD/NVMe tolerances even on a Raspberry Pi.

### 8.2 Performance Impact of Span Creation on the Hot Path

**Cost per span operation:**

| Operation | Time | Notes |
|-----------|------|-------|
| `startSpan()` — ID generation | ~2 µs | `crypto.randomBytes(8).toString('hex')` |
| `startSpan()` — Map insert | ~0.1 µs | In-memory `Map<SpanId, Span>` |
| `startSpan()` — `performance.now()` | ~0.05 µs | V8 intrinsic |
| `endSpan()` — Map lookup + duration calc | ~0.2 µs | |
| `endSpan()` — metadata merge | ~0.5 µs | Object.assign on small objects |
| `completeTrace()` — push to write queue | ~0.1 µs | Array.push, non-blocking |
| **Total per span lifecycle** | **~3 µs** | |

**Per-task total overhead (8 spans):**

| Item | Time |
|------|------|
| Span creation/closing (8×) | ~24 µs |
| Async batch flush (1/sec) | 0 µs on hot path (deferred) |
| SQLite INSERT (batched, off hot path) | ~200 µs per trace (background) |
| **Total hot-path overhead per task** | **~24 µs** |

**Context:** A single Ollama evaluation takes 2,000–8,000 ms. A Sonnet verification takes 3,000–15,000 ms. An executor LLM call takes 5,000–60,000 ms. The **24 µs** span overhead is 0.0003% of the fastest possible task. **Utterly negligible.**

**SQLite write contention:** The flight recorder uses a **separate SQLite database** (`flight-recorder.sqlite`) from `queue.sqlite`, so there is zero write contention with the job queue. WAL mode allows concurrent reads during writes. The 1-second batch flush means at most 1 write transaction per second, each taking ~200 µs.

### 8.3 Memory Impact

| Structure | Size | Notes |
|-----------|------|-------|
| Active trace map (max ~5 concurrent) | ~40 KB | 5 traces × 8 spans × ~1 KB each |
| PercentileDigest (7 instances) | ~56 KB | 100 centroids × 16 bytes × 7 |
| EWMA state | ~64 bytes | Single float + alpha |
| Tier/model counter maps | ~4 KB | Bounded by distinct tier/model count |
| Write buffer (pending flushes) | ~20 KB | 1 sec of traces |
| **Total resident memory** | **~120 KB** | |

**Verdict:** Less than a single LLM context window token. Zero concern.

---

## 9. Restart Continuity

### The Problem

When the gateway restarts (SIGTERM, SIGUSR1 for update, crash):
1. **In-memory spans** for active traces are lost
2. **Metrics aggregator state** (percentile digests, counters) is lost
3. **Active jobs** may be in `in_execution` with no heartbeat timer

### The Solution: Three-Layer Recovery

#### Layer 1: Graceful Shutdown Flush

```typescript
// In the FlightRecorder constructor:
process.on("SIGTERM", () => this.emergencyFlush());
process.on("SIGINT", () => this.emergencyFlush());
process.on("SIGUSR1", () => this.emergencyFlush());

emergencyFlush(): void {
  // 1. Close all open spans with INTERRUPTED status
  for (const [traceId, spans] of this.activeTraces) {
    for (const span of spans) {
      if (span.endTimeMs === null) {
        span.endTimeMs = performance.now() + this.epochOffset;
        span.durationMs = span.endTimeMs - span.startTimeMs;
        span.status = "INTERRUPTED";
        span.statusMessage = "gateway restart";
      }
    }
    // Flush to SQLite synchronously (we're shutting down)
    this.flushTraceSync(traceId);
  }

  // 2. Snapshot metrics to SQLite
  const metrics = this.aggregator.getMetrics(0, 0);
  this.db.prepare(`
    INSERT INTO metrics_snapshots (metrics_json, period_start, period_end)
    VALUES (?, ?, ?)
  `).run(
    JSON.stringify(metrics),
    this.aggregator.collectionStartedAt,
    new Date().toISOString(),
  );
}
```

#### Layer 2: Orphan Recovery on Startup

```typescript
// Called during initFlightRecorder():
recoverOrphans(): number {
  // Find traces with no end_time_ms (interrupted by crash)
  const orphans = this.db.prepare(`
    SELECT trace_id FROM traces WHERE end_time_ms IS NULL
  `).all() as { trace_id: string }[];

  for (const { trace_id } of orphans) {
    // Close all open spans in this trace
    this.db.prepare(`
      UPDATE spans
      SET end_time_ms = start_time_ms + 1,
          duration_ms = 1,
          status = 'INTERRUPTED',
          status_message = 'recovered after gateway restart'
      WHERE trace_id = ? AND end_time_ms IS NULL
    `).run(trace_id);

    // Close the trace itself
    this.db.prepare(`
      UPDATE traces
      SET end_time_ms = start_time_ms + 1,
          duration_ms = 1,
          status = 'INTERRUPTED',
          error_message = 'interrupted by gateway restart'
      WHERE trace_id = ? AND end_time_ms IS NULL
    `).run(trace_id);
  }

  return orphans.length;
}
```

#### Layer 3: Metrics Warm-Start from Snapshot

```typescript
// On startup, after recoverOrphans():
warmStartMetrics(): void {
  // Load the most recent metrics snapshot
  const snapshot = this.db.prepare(`
    SELECT metrics_json, period_start, period_end
    FROM metrics_snapshots
    ORDER BY id DESC
    LIMIT 1
  `).get() as { metrics_json: string; period_start: string; period_end: string } | undefined;

  if (!snapshot) return;

  // Also replay any traces created after the snapshot
  const snapshotEnd = new Date(snapshot.period_end).getTime();
  const recentTraces = this.db.prepare(`
    SELECT * FROM traces
    WHERE start_time_ms > ?
    ORDER BY start_time_ms ASC
  `).all(snapshotEnd) as any[];

  // Rebuild aggregator from snapshot + recent traces
  const savedMetrics = JSON.parse(snapshot.metrics_json);
  this.aggregator.restoreFrom(savedMetrics);

  for (const trace of recentTraces) {
    const spans = this.db.prepare(`
      SELECT * FROM spans WHERE trace_id = ?
    `).all(trace.trace_id) as any[];

    const fullTrace = this.reconstructTrace(trace, spans);
    this.aggregator.recordTrace(fullTrace);
  }

  console.log(`[flight-recorder] warm-started metrics from snapshot + ${recentTraces.length} recent traces`);
}
```

### Restart Continuity Matrix

| Scenario | Data Loss | Recovery |
|----------|-----------|----------|
| **Graceful restart** (SIGTERM) | None | Emergency flush captures all open spans |
| **SIGUSR1 update** | None | Same as graceful |
| **Crash (SIGKILL, OOM)** | Active spans (~0-5) | Orphan recovery marks as INTERRUPTED; metrics rebuilt from snapshot + replayed traces |
| **Power loss** | Up to 1 sec of spans | WAL with `synchronous=NORMAL` may lose last ~1 sec. Orphan recovery handles the rest. |
| **Disk full** | New spans drop | Flight recorder catches SQLite errors, continues operating without persistence. Metrics stay in-memory. |

---

## Appendix: Model Cost Table (for `estimatedCostUsd` calculation)

```typescript
// src/router/flight-recorder/cost.ts

const MODEL_COSTS: Record<string, { inputPer1M: number; outputPer1M: number }> = {
  "claude-haiku-4-5":  { inputPer1M: 0.80,  outputPer1M: 4.00  },
  "claude-sonnet-4-6": { inputPer1M: 3.00,  outputPer1M: 15.00 },
  "claude-opus-4-6":   { inputPer1M: 15.00, outputPer1M: 75.00 },
  "llama3.2:3b":       { inputPer1M: 0.00,  outputPer1M: 0.00  }, // local
};

export function estimateCost(
  model: string,
  tokensIn: number,
  tokensOut: number,
): number {
  const costs = MODEL_COSTS[model];
  if (!costs) return 0;
  return (tokensIn / 1_000_000) * costs.inputPer1M
       + (tokensOut / 1_000_000) * costs.outputPer1M;
}
```
