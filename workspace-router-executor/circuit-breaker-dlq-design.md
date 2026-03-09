# Circuit Breaker + Dead Letter Queue — Full Design
### OpenClaw Router: Task Execution Pipeline Hardening

---

## 1. FAILURE MODE MAP

### Pipeline Overview

```
User message
    │
    ▼
[Cortex bus]  dequeueNext → markProcessing
    │
    ▼
[loop.ts]  assembleContext → callLLM (sync tool round-trips)
    │
    ├─ LLM calls sessions_spawn ─────────────────────┐
    │                                                 │
    ▼                                                 ▼
parseResponse → routeOutput                     onSpawn(params)
markCompleted / markFailed                      [Router enqueue]
onMessageComplete                                    │
                                                     ▼
                                            [router/loop.ts]
                                            evaluator → pending
                                                     │
                                                     ▼
                                            [worker.ts] run()
                                            executor(prompt, model)
                                                     │
                                              success / fail
                                                     │
                                                     ▼
                                            routerEvents.emit
                                            job:completed / job:failed
                                                     │
                                                     ▼
                                            [notifier.ts]
                                            deliverResult → archiveJob
                                            onDelivered callback
                                                     │
                                                     ▼
                                            appendTaskResult → ops trigger
                                                     │
                                                     ▼
                                            Cortex loop picks up ops trigger
                                            LLM relays result to user
```

---

### Failure Modes Table

| # | Location | Failure | Job State After | User Notified? | Recovery Possible? |
|---|----------|---------|-----------------|----------------|-------------------|
| F1 | `loop.ts` bus-level | `dequeueNext` throws | unchanged (still queued) | No | Yes — next tick retries |
| F2 | `loop.ts` | `markProcessing` fails | stays in queue | No | Yes — reprocessed, idempotency risk |
| F3 | `loop.ts` | `assembleContext` throws | `markFailed` | No — silent | No — permanently failed |
| F4 | `loop.ts` | `callLLM` throws / times out | `markFailed` | No — client unblocked silently | No |
| F5 | `loop.ts` | `routeOutput` fails | `markCompleted` (!!) | No — message dropped | No — completed state blocks recovery |
| F6 | `loop.ts` | `onSpawn` returns null | task_result written as failed | Yes — Cortex relays failure | No |
| F7 | `loop.ts` | `onSpawn` throws (uncaught) | outer catch → `markFailed` | No | No |
| F8 | `loop.ts` | `appendResponse` throws | `markCompleted` already written | No — session incomplete | No |
| F9 | `worker.ts` | `updateJob(started_at)` throws | corrupt state | No | Partial — recovery sees no started_at |
| F10 | `worker.ts` | `executor` hangs indefinitely | stays `in_execution` | No | Yes — restart → recovery resets to pending |
| F11 | `worker.ts` | `executor` throws | `status=failed`, event emitted | Yes (via notifier→onDelivered) | Partial — MAX_RETRIES=2 |
| F12 | `worker.ts` | `updateJob(completed)` throws after executor succeeds | corrupt — result lost | No | No — result is gone |
| F13 | `notifier.ts` | `archiveJob` throws | stays in main table | Yes (already delivered) | Yes — harmless, re-archived on next delivery attempt |
| F14 | `notifier.ts` | `onDelivered` callback throws | swallowed | No — user session never updated | No |
| F15 | `notifier.ts` | `waitForJob` times out | job still executing | Caller gets rejection error | Partial — job may complete but caller abandoned |
| F16 | `recovery.ts` | Job at MAX_RETRIES on startup | `status=failed`, no notification | No — permanently silently failed | No |
| F17 | `recovery.ts` | `deliverResult` fails during re-delivery | undelivered terminal job | No | Yes — re-attempted on next restart |
| F18 | Cross-cutting | Model tier API down (e.g. Sonnet 503s) | All jobs to that tier → failed | Partial — each job notifies individually | No — no tier-level circuit breaking |
| F19 | Cross-cutting | All tiers failing simultaneously | All jobs failed | Individual per-job | No — no fallback mechanism |
| F20 | Cross-cutting | Gateway restart with jobs `in_execution` | recovery resets to pending | No during crash | Yes — recovery handles |

### Critical Gaps

- **F3, F4, F11, F16**: User is never notified of permanent failures — the user's request simply disappears.
- **F5**: A routing failure is silently swallowed while the job is marked *completed*, making it unrecoverable.
- **F14**: The most critical silent failure — `onDelivered` throwing means the agent's result never reaches the session.
- **F18/F19**: No per-model health tracking; a sick model causes every job in that tier to burn its MAX_RETRIES before failing.
- **F12**: A successful execution result can be lost if the DB write throws post-execution — no compensation.

---

## 2. TYPESCRIPT INTERFACES

```typescript
// ============================================================
// circuit-breaker.ts — full interface + type definitions
// ============================================================

import type { Tier } from "./types.js";

// ─── Circuit Breaker ─────────────────────────────────────────

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

/** A single observation in the sliding window */
export interface WindowSample {
  timestamp: number;   // epoch ms
  success: boolean;
  tier: Tier;
  jobId: string;
  durationMs: number;
}

/** Per-tier circuit breaker state */
export interface TierCircuit {
  tier: Tier;
  state: CircuitState;
  /** Rolling window of samples (last windowMs ms) */
  window: WindowSample[];
  /** When the circuit was opened (epoch ms) */
  openedAt: number | null;
  /** How many half-open probe attempts have been tried */
  halfOpenAttempts: number;
  /** Last successful execution timestamp */
  lastSuccessAt: number | null;
  /** Consecutive successes in HALF_OPEN (resets on failure) */
  halfOpenSuccesses: number;
}

export interface CircuitBreakerConfig {
  /** Sliding window duration in ms (default: 5 min) */
  windowMs: number;
  /** Minimum samples before circuit can open (default: 5) */
  minSamples: number;
  /** Failure rate threshold to open circuit (0.0–1.0, default: 0.5) */
  failureThreshold: number;
  /** How long to wait before transitioning OPEN → HALF_OPEN (default: 60s) */
  openCooldownMs: number;
  /** Consecutive successes required to close from HALF_OPEN (default: 2) */
  halfOpenSuccessRequired: number;
  /** Max simultaneous probes in HALF_OPEN state (default: 1) */
  halfOpenMaxProbes: number;
}

// ─── Dead Letter Queue ────────────────────────────────────────

export type DLQReason =
  | "max_retries_exceeded"       // hit MAX_RETRIES in recovery.ts
  | "circuit_open"               // all eligible tiers circuit-broken
  | "executor_error"             // executor threw; not a tier issue
  | "poison_pill";               // repeatedly fails regardless of tier/retry

/** A DLQ entry wrapping a RouterJob with retry metadata */
export interface DLQEntry {
  id: string;                    // UUID (independent of job.id)
  jobId: string;                 // original RouterJob.id
  originalTier: Tier | null;
  /** Tiers attempted before DLQ admission (for circuit-open reason) */
  exhaustedTiers: Tier[];
  reason: DLQReason;
  /** Number of DLQ retry attempts so far */
  dlqAttempts: number;
  /** Max DLQ retry attempts before declaring poison pill */
  maxDlqAttempts: number;
  /** Timestamp of next scheduled retry (epoch ms) */
  nextRetryAt: number;
  /** The original job payload (snapshot at DLQ admission time) */
  payload: string;
  issuer: string;
  /** Error messages from each attempt */
  errorHistory: string[];
  createdAt: number;
  updatedAt: number;
  /** Null until permanently dead */
  deadAt: number | null;
}

export interface DLQConfig {
  /** Max DLQ retry attempts before poison pill (default: 3) */
  maxAttempts: number;
  /** Base delay for exponential backoff in ms (default: 30s) */
  backoffBaseMs: number;
  /** Backoff multiplier (default: 2.0) */
  backoffMultiplier: number;
  /** Cap for backoff delay in ms (default: 30 min) */
  backoffMaxMs: number;
  /** Number of distinct errors that classifies a job as poison pill (default: 3) */
  poisonPillUniqueErrors: number;
}

// ─── Observability Events ─────────────────────────────────────

export type CircuitEvent =
  | { kind: "circuit:opened";     tier: Tier; failureRate: number; samples: number; at: number }
  | { kind: "circuit:half_open";  tier: Tier; cooldownElapsedMs: number; at: number }
  | { kind: "circuit:closed";     tier: Tier; probeSuccesses: number; at: number }
  | { kind: "circuit:probe_fail"; tier: Tier; attempt: number; error: string; at: number }
  | { kind: "circuit:sample";     tier: Tier; success: boolean; durationMs: number; jobId: string; at: number };

export type DLQEvent =
  | { kind: "dlq:enqueued";  jobId: string; reason: DLQReason; dlqId: string; at: number }
  | { kind: "dlq:retrying";  jobId: string; dlqId: string; attempt: number; nextTier: Tier | null; at: number }
  | { kind: "dlq:recovered"; jobId: string; dlqId: string; at: number }
  | { kind: "dlq:dead";      jobId: string; dlqId: string; reason: DLQReason; attempts: number; at: number };

export type PipelineObservabilityEvent = CircuitEvent | DLQEvent;
```

---

## 3. CIRCUIT BREAKER STATE MACHINE

```
                    ┌──────────────────────────────────────────────────────┐
                    │                                                      │
                    │          failure_rate > threshold                    │
                    │          AND samples >= minSamples                   │
                    │                                                      │
         ┌──────────▼──────────┐                   ┌─────────────────────┐
         │                     │                   │                      │
         │       CLOSED        │                   │        OPEN          │
         │                     │                   │                      │
         │  - Records samples  │                   │ - Rejects all calls  │
         │  - Routes normally  │  ──────────────►  │ - Returns tier-      │
         │  - Cleans old       │                   │   fallback or DLQ    │
         │    samples from     │                   │ - Waits cooldown     │
         │    window           │                   │                      │
         └─────────▲───────────┘                   └──────────┬──────────┘
                   │                                          │
                   │                                          │ cooldownMs elapsed
                   │                                          ▼
                   │                               ┌──────────────────────┐
                   │  halfOpenSuccessRequired       │                      │
                   │  consecutive successes         │      HALF_OPEN       │
                   └────────────────────────────────│                      │
                                                    │ - Allows 1 probe at  │
                                                    │   a time             │
                   ┌────────────────────────────────│ - On probe fail →    │
                   │  probe fails                   │   back to OPEN       │
                   │  → reset openedAt              │ - Counts consecutive │
                   ▼                                │   successes          │
               [OPEN]                               └──────────────────────┘

  Tier fallback order:
    opus   → sonnet → haiku → DLQ
    sonnet → haiku  → opus  → DLQ   (if opus also open)
    haiku  → sonnet → opus  → DLQ   (if sonnet also open)

  All tiers OPEN → DLQ immediately (no fallback available)
```

### Tier Fallback Priority Table

| Requested Tier | Fallback 1 | Fallback 2 | Final |
|----------------|-----------|-----------|-------|
| haiku (weight 1-33) | sonnet | opus | DLQ |
| sonnet (weight 34-66) | haiku | opus | DLQ |
| opus (weight 67-100) | sonnet | haiku | DLQ |

*Rationale: sonnet is the safest fallback — it sits in the middle of the cost/capability spectrum. When degrading upward (haiku→sonnet) we accept cost increase for reliability. When degrading downward (opus→sonnet) we accept quality reduction for delivery.*

---

## 4. DLQ RETRY ALGORITHM

```
function computeNextRetry(entry: DLQEntry, config: DLQConfig): number {
  const delay = min(
    config.backoffBaseMs * (config.backoffMultiplier ** entry.dlqAttempts),
    config.backoffMaxMs
  );

  // Add ±10% jitter to prevent thundering herd
  const jitter = delay * 0.1 * (Math.random() * 2 - 1);
  return Date.now() + delay + jitter;
}

// Attempt sequence (backoffBase=30s, multiplier=2, cap=30min):
// Attempt 0 (initial DLQ): nextRetry = now + 30s  ± 3s
// Attempt 1:               nextRetry = now + 60s  ± 6s
// Attempt 2:               nextRetry = now + 120s ± 12s
// Attempt 3:               nextRetry = now + 240s ± 24s
// Attempt 4:               nextRetry = now + 480s ± 48s
// ...cap at 30min...
// After maxAttempts → declare DEAD

Poison Pill Detection:
  A job is a poison pill if, across all its DLQ attempts:
  - distinctErrors.size >= poisonPillUniqueErrors (default: 3)
    → the job fails with different errors regardless of tier or retry
  - OR the error consistently contains known-bad patterns:
    ["context_window_exceeded", "invalid_request", "content_policy"]
    → these will never succeed on retry

  Poison pill detection fires before scheduling the next retry,
  immediately marking the entry as DEAD and notifying the issuer.
```

---

## 5. FULL IMPLEMENTATION

### 5a. `circuit-breaker.ts`

```typescript
import { EventEmitter } from "node:events";
import type { Tier } from "./types.js";
import type {
  TierCircuit,
  CircuitState,
  WindowSample,
  CircuitBreakerConfig,
  CircuitEvent,
} from "./circuit-breaker-types.js";

export const DEFAULT_CIRCUIT_CONFIG: CircuitBreakerConfig = {
  windowMs: 5 * 60 * 1000,       // 5 min
  minSamples: 5,
  failureThreshold: 0.5,
  openCooldownMs: 60_000,         // 1 min
  halfOpenSuccessRequired: 2,
  halfOpenMaxProbes: 1,
};

export class CircuitBreaker extends EventEmitter {
  private circuits = new Map<Tier, TierCircuit>();
  private config: CircuitBreakerConfig;

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CIRCUIT_CONFIG, ...config };

    for (const tier of ["haiku", "sonnet", "opus"] as Tier[]) {
      this.circuits.set(tier, {
        tier,
        state: "CLOSED",
        window: [],
        openedAt: null,
        halfOpenAttempts: 0,
        lastSuccessAt: null,
        halfOpenSuccesses: 0,
      });
    }
  }

  // ── Main API ──────────────────────────────────────────────

  /**
   * Check if a tier is available. Returns the circuit state.
   * Transitions OPEN → HALF_OPEN if cooldown has elapsed.
   */
  canRoute(tier: Tier): CircuitState {
    const circuit = this.getCircuit(tier);
    this.pruneWindow(circuit);

    if (circuit.state === "OPEN") {
      const now = Date.now();
      if (circuit.openedAt && now - circuit.openedAt >= this.config.openCooldownMs) {
        circuit.state = "HALF_OPEN";
        circuit.halfOpenSuccesses = 0;
        circuit.halfOpenAttempts = 0;
        this.emit("circuit", {
          kind: "circuit:half_open",
          tier,
          cooldownElapsedMs: now - circuit.openedAt,
          at: now,
        } satisfies CircuitEvent);
      }
    }

    return circuit.state;
  }

  /**
   * Record a sample for a tier. Updates circuit state if threshold crossed.
   */
  record(tier: Tier, sample: Omit<WindowSample, "tier">): void {
    const circuit = this.getCircuit(tier);
    const now = Date.now();

    this.pruneWindow(circuit);
    circuit.window.push({ ...sample, tier });

    this.emit("circuit", {
      kind: "circuit:sample",
      tier,
      success: sample.success,
      durationMs: sample.durationMs,
      jobId: sample.jobId,
      at: now,
    } satisfies CircuitEvent);

    if (sample.success) {
      circuit.lastSuccessAt = now;
    }

    this.evaluateState(circuit);
  }

  /**
   * Returns the best available tier for a job, respecting circuit states.
   * Returns null if all tiers are circuit-broken.
   */
  resolveRoute(requestedTier: Tier): Tier | null {
    const fallbackOrder = this.fallbackChain(requestedTier);
    for (const tier of fallbackOrder) {
      const state = this.canRoute(tier);
      if (state === "CLOSED") return tier;
      if (state === "HALF_OPEN" && this.getCircuit(tier).halfOpenAttempts < this.config.halfOpenMaxProbes) {
        this.getCircuit(tier).halfOpenAttempts++;
        return tier;
      }
    }
    return null; // all tiers unavailable → DLQ
  }

  getCircuitState(tier: Tier): TierCircuit {
    return { ...this.getCircuit(tier) };
  }

  getAllStates(): Record<Tier, TierCircuit> {
    return {
      haiku: this.getCircuitState("haiku"),
      sonnet: this.getCircuitState("sonnet"),
      opus: this.getCircuitState("opus"),
    };
  }

  // ── Private ───────────────────────────────────────────────

  private getCircuit(tier: Tier): TierCircuit {
    return this.circuits.get(tier)!;
  }

  private pruneWindow(circuit: TierCircuit): void {
    const cutoff = Date.now() - this.config.windowMs;
    circuit.window = circuit.window.filter((s) => s.timestamp >= cutoff);
  }

  private evaluateState(circuit: TierCircuit): void {
    const { window, state, tier } = circuit;
    const { minSamples, failureThreshold, halfOpenSuccessRequired } = this.config;

    if (state === "CLOSED") {
      if (window.length < minSamples) return;
      const failRate = window.filter((s) => !s.success).length / window.length;
      if (failRate >= failureThreshold) {
        circuit.state = "OPEN";
        circuit.openedAt = Date.now();
        this.emit("circuit", {
          kind: "circuit:opened",
          tier,
          failureRate: failRate,
          samples: window.length,
          at: Date.now(),
        } satisfies CircuitEvent);
      }
    } else if (state === "HALF_OPEN") {
      const lastSample = circuit.window[circuit.window.length - 1];
      if (!lastSample) return;

      if (lastSample.success) {
        circuit.halfOpenSuccesses++;
        if (circuit.halfOpenSuccesses >= halfOpenSuccessRequired) {
          circuit.state = "CLOSED";
          circuit.openedAt = null;
          circuit.halfOpenSuccesses = 0;
          circuit.window = [];
          this.emit("circuit", {
            kind: "circuit:closed",
            tier,
            probeSuccesses: circuit.halfOpenSuccesses,
            at: Date.now(),
          } satisfies CircuitEvent);
        }
      } else {
        // Probe failed — re-open
        circuit.state = "OPEN";
        circuit.openedAt = Date.now();
        circuit.halfOpenSuccesses = 0;
        this.emit("circuit", {
          kind: "circuit:probe_fail",
          tier,
          attempt: circuit.halfOpenAttempts,
          error: "probe execution failed",
          at: Date.now(),
        } satisfies CircuitEvent);
      }
    }
  }

  private fallbackChain(requestedTier: Tier): Tier[] {
    const chains: Record<Tier, Tier[]> = {
      haiku:  ["haiku", "sonnet", "opus"],
      sonnet: ["sonnet", "haiku", "opus"],
      opus:   ["opus", "sonnet", "haiku"],
    };
    return chains[requestedTier];
  }

  // ── Persistence (for restart survival) ───────────────────

  /**
   * Serialize circuit state for persistence across restarts.
   * Only persists OPEN circuits (CLOSED/HALF_OPEN reset naturally).
   */
  serialize(): string {
    const openCircuits: Array<{ tier: Tier; openedAt: number }> = [];
    for (const [tier, circuit] of this.circuits) {
      if (circuit.state === "OPEN" && circuit.openedAt !== null) {
        openCircuits.push({ tier, openedAt: circuit.openedAt });
      }
    }
    return JSON.stringify({ openCircuits, savedAt: Date.now() });
  }

  /**
   * Restore circuit state from a serialized snapshot.
   * OPEN circuits whose cooldown has already elapsed are restored as HALF_OPEN.
   */
  restore(serialized: string): void {
    try {
      const { openCircuits, savedAt } = JSON.parse(serialized) as {
        openCircuits: Array<{ tier: Tier; openedAt: number }>;
        savedAt: number;
      };
      const now = Date.now();
      const downtime = now - savedAt;

      for (const { tier, openedAt } of openCircuits) {
        const circuit = this.circuits.get(tier);
        if (!circuit) continue;
        const adjustedOpenedAt = openedAt; // preserve original open time
        const cooldownRemaining = this.config.openCooldownMs - (now - adjustedOpenedAt);

        if (cooldownRemaining <= 0) {
          // Cooldown has elapsed during downtime — restore as HALF_OPEN
          circuit.state = "HALF_OPEN";
          circuit.openedAt = adjustedOpenedAt;
          circuit.halfOpenSuccesses = 0;
          circuit.halfOpenAttempts = 0;
        } else {
          // Still within cooldown
          circuit.state = "OPEN";
          circuit.openedAt = adjustedOpenedAt;
        }

        console.log(
          `[circuit-breaker] restored ${tier}: ${circuit.state}` +
          ` (open for ${Math.round((now - openedAt) / 1000)}s, downtime=${Math.round(downtime / 1000)}s)`
        );
      }
    } catch (err) {
      console.warn("[circuit-breaker] failed to restore state:", err);
    }
  }
}
```

### 5b. `dlq.ts`

```typescript
import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Tier } from "./types.js";
import type { DLQEntry, DLQConfig, DLQReason, DLQEvent } from "./circuit-breaker-types.js";
import { updateJob, getJob } from "./queue.js";

export const DEFAULT_DLQ_CONFIG: DLQConfig = {
  maxAttempts: 3,
  backoffBaseMs: 30_000,       // 30s
  backoffMultiplier: 2.0,
  backoffMaxMs: 30 * 60_000,   // 30 min
  poisonPillUniqueErrors: 3,
};

// Known-unretryable error patterns (poison pill fast-track)
const POISON_PATTERNS = [
  /context.?window.?exceeded/i,
  /invalid.?request/i,
  /content.?policy/i,
  /maximum.?tokens/i,
];

export class DeadLetterQueue extends EventEmitter {
  private entries = new Map<string, DLQEntry>();  // dlqId → entry
  private jobIndex = new Map<string, string>();   // jobId → dlqId
  private config: DLQConfig;

  constructor(config: Partial<DLQConfig> = {}) {
    super();
    this.config = { ...DEFAULT_DLQ_CONFIG, ...config };
  }

  // ── Admission ─────────────────────────────────────────────

  enqueue(
    jobId: string,
    payload: string,
    issuer: string,
    reason: DLQReason,
    options: {
      originalTier?: Tier | null;
      exhaustedTiers?: Tier[];
      initialError?: string;
    } = {}
  ): DLQEntry {
    // Idempotent — if already in DLQ, bump attempt
    const existingId = this.jobIndex.get(jobId);
    if (existingId) {
      const existing = this.entries.get(existingId)!;
      return this.scheduleRetry(existing, options.initialError);
    }

    const dlqId = crypto.randomUUID();
    const now = Date.now();
    const entry: DLQEntry = {
      id: dlqId,
      jobId,
      originalTier: options.originalTier ?? null,
      exhaustedTiers: options.exhaustedTiers ?? [],
      reason,
      dlqAttempts: 0,
      maxDlqAttempts: this.config.maxAttempts,
      nextRetryAt: this.computeNextRetry(0),
      payload,
      issuer,
      errorHistory: options.initialError ? [options.initialError] : [],
      createdAt: now,
      updatedAt: now,
      deadAt: null,
    };

    this.entries.set(dlqId, entry);
    this.jobIndex.set(jobId, dlqId);

    this.emit("dlq", {
      kind: "dlq:enqueued",
      jobId,
      reason,
      dlqId,
      at: now,
    } satisfies DLQEvent);

    return entry;
  }

  // ── Retry scheduling ──────────────────────────────────────

  /**
   * Get all DLQ entries whose nextRetryAt has elapsed and aren't dead.
   */
  getDueEntries(): DLQEntry[] {
    const now = Date.now();
    return Array.from(this.entries.values()).filter(
      (e) => e.deadAt === null && e.nextRetryAt <= now
    );
  }

  /**
   * Mark a DLQ entry as successfully recovered and remove from queue.
   */
  markRecovered(dlqId: string): void {
    const entry = this.entries.get(dlqId);
    if (!entry) return;

    this.entries.delete(dlqId);
    this.jobIndex.delete(entry.jobId);

    this.emit("dlq", {
      kind: "dlq:recovered",
      jobId: entry.jobId,
      dlqId,
      at: Date.now(),
    } satisfies DLQEvent);
  }

  /**
   * Record a retry attempt result. Returns the updated entry.
   * Handles poison pill detection and max attempts.
   */
  recordAttempt(
    dlqId: string,
    success: boolean,
    error?: string,
    nextTier?: Tier | null
  ): DLQEntry | null {
    const entry = this.entries.get(dlqId);
    if (!entry) return null;

    entry.updatedAt = Date.now();

    if (success) {
      this.markRecovered(dlqId);
      return null;
    }

    if (error) {
      entry.errorHistory.push(error);
    }

    entry.dlqAttempts++;

    this.emit("dlq", {
      kind: "dlq:retrying",
      jobId: entry.jobId,
      dlqId,
      attempt: entry.dlqAttempts,
      nextTier: nextTier ?? null,
      at: Date.now(),
    } satisfies DLQEvent);

    // Check poison pill
    if (this.isPoisonPill(entry)) {
      return this.markDead(entry, "poison_pill");
    }

    // Check max attempts
    if (entry.dlqAttempts >= this.config.maxAttempts) {
      return this.markDead(entry, "max_retries_exceeded");
    }

    // Schedule next retry
    entry.nextRetryAt = this.computeNextRetry(entry.dlqAttempts);
    return entry;
  }

  has(jobId: string): boolean {
    return this.jobIndex.has(jobId);
  }

  getByJobId(jobId: string): DLQEntry | null {
    const id = this.jobIndex.get(jobId);
    return id ? (this.entries.get(id) ?? null) : null;
  }

  size(): number {
    return this.entries.size;
  }

  getDeadEntries(): DLQEntry[] {
    return Array.from(this.entries.values()).filter((e) => e.deadAt !== null);
  }

  // ── Private ───────────────────────────────────────────────

  private computeNextRetry(attempt: number): number {
    const raw = this.config.backoffBaseMs * Math.pow(this.config.backoffMultiplier, attempt);
    const capped = Math.min(raw, this.config.backoffMaxMs);
    const jitter = capped * 0.1 * (Math.random() * 2 - 1);
    return Date.now() + capped + jitter;
  }

  private isPoisonPill(entry: DLQEntry): boolean {
    // Check known-bad patterns
    for (const pattern of POISON_PATTERNS) {
      if (entry.errorHistory.some((e) => pattern.test(e))) return true;
    }
    // Check unique errors threshold
    const unique = new Set(entry.errorHistory).size;
    return unique >= this.config.poisonPillUniqueErrors;
  }

  private markDead(entry: DLQEntry, reason: DLQReason): DLQEntry {
    entry.deadAt = Date.now();
    entry.reason = reason;

    this.emit("dlq", {
      kind: "dlq:dead",
      jobId: entry.jobId,
      dlqId: entry.id,
      reason,
      attempts: entry.dlqAttempts,
      at: Date.now(),
    } satisfies DLQEvent);

    return entry;
  }

  private scheduleRetry(entry: DLQEntry, error?: string): DLQEntry {
    if (error) entry.errorHistory.push(error);
    entry.nextRetryAt = this.computeNextRetry(entry.dlqAttempts);
    entry.updatedAt = Date.now();
    return entry;
  }
}
```

---

## 6. INTEGRATION POINTS

### 6a. `worker.ts` — Integration

```typescript
// worker.ts additions (diff-style)

import { CircuitBreaker } from "./circuit-breaker.js";
import { DeadLetterQueue } from "./dlq.js";
import type { Tier } from "./types.js";

// ─── Module-level singletons (shared across all run() calls) ───
// In production, pass these in via the Router's DI container.

export let circuitBreaker: CircuitBreaker | null = null;
export let dlq: DeadLetterQueue | null = null;

export function initCircuitBreaker(cb: CircuitBreaker, d: DeadLetterQueue): void {
  circuitBreaker = cb;
  dlq = d;
}

// ─── Modified run() ────────────────────────────────────────────

export async function run(
  db: DatabaseSync,
  jobId: string,
  prompt: string,
  model: string,
  tier: Tier,                              // NEW: explicit tier param
  executor: AgentExecutor = defaultExecuteAgent,
): Promise<void> {
  const cb = circuitBreaker;
  const dlqQueue = dlq;

  // ── Circuit breaker check ──────────────────────────────────
  let resolvedTier = tier;
  let resolvedModel = model;

  if (cb) {
    const routedTier = cb.resolveRoute(tier);
    if (routedTier === null) {
      // All tiers circuit-broken → DLQ
      const job = db.prepare("SELECT payload, issuer FROM jobs WHERE id = ?").get(jobId) as
        { payload: string; issuer: string } | undefined;
      if (job && dlqQueue) {
        const allTiers: Tier[] = ["haiku", "sonnet", "opus"];
        dlqQueue.enqueue(jobId, job.payload, job.issuer, "circuit_open", {
          originalTier: tier,
          exhaustedTiers: allTiers,
        });
      }
      updateJob(db, jobId, {
        status: "failed",
        error: "circuit_open: all tiers unavailable",
        finished_at: nowTimestamp(),
      });
      routerEvents.emit("job:failed", { jobId, error: "circuit_open: all tiers unavailable" });
      return;
    }
    if (routedTier !== tier) {
      console.log(`[worker] circuit: rerouting job ${jobId} from ${tier} → ${routedTier}`);
      resolvedTier = routedTier;
      // Remap model from tier config (caller must provide tierConfig or inject)
      // resolvedModel = tierConfig[routedTier].model; // inject via closure
    }
  }

  // ── Normal execution ──────────────────────────────────────
  const now = nowTimestamp();
  updateJob(db, jobId, { started_at: now, last_checkpoint: now });

  const heartbeatTimer = setInterval(() => {
    try { updateJob(db, jobId, { last_checkpoint: nowTimestamp() }); } catch { /* best-effort */ }
  }, HEARTBEAT_INTERVAL_MS);

  const executionStart = Date.now();

  try {
    const result = await executor(prompt, resolvedModel);
    clearInterval(heartbeatTimer);

    const durationMs = Date.now() - executionStart;

    // Record success to circuit breaker
    cb?.record(resolvedTier, {
      timestamp: Date.now(),
      success: true,
      jobId,
      durationMs,
    });

    updateJob(db, jobId, {
      status: "completed",
      result,
      finished_at: nowTimestamp(),
    });
    routerEvents.emit("job:completed", { jobId });

    // If job was in DLQ, mark recovered
    dlqQueue?.markRecovered(dlqQueue.getByJobId(jobId)?.id ?? "");

  } catch (err) {
    clearInterval(heartbeatTimer);

    const durationMs = Date.now() - executionStart;
    const errorMessage = err instanceof Error ? err.message : String(err);

    // Record failure to circuit breaker
    cb?.record(resolvedTier, {
      timestamp: Date.now(),
      success: false,
      jobId,
      durationMs,
    });

    updateJob(db, jobId, {
      status: "failed",
      error: errorMessage,
      finished_at: nowTimestamp(),
    });
    routerEvents.emit("job:failed", { jobId, error: errorMessage });

    // Admit to DLQ if this isn't already a DLQ retry
    if (dlqQueue && !dlqQueue.has(jobId)) {
      const job = db.prepare("SELECT payload, issuer FROM jobs WHERE id = ?")
        .get(jobId) as { payload: string; issuer: string } | undefined;
      if (job) {
        dlqQueue.enqueue(jobId, job.payload, job.issuer, "executor_error", {
          originalTier: resolvedTier,
          initialError: errorMessage,
        });
      }
    } else if (dlqQueue?.has(jobId)) {
      const entry = dlqQueue.getByJobId(jobId);
      if (entry) dlqQueue.recordAttempt(entry.id, false, errorMessage, resolvedTier);
    }
  }
}
```

### 6b. `recovery.ts` — Integration

```typescript
// recovery.ts additions (diff-style)

import type { CircuitBreaker } from "./circuit-breaker.js";
import type { DeadLetterQueue } from "./dlq.js";

// ─── Modified recover() signature ──────────────────────────────

export function recover(
  db: DatabaseSync,
  cb?: CircuitBreaker,              // NEW optional params
  dlqQueue?: DeadLetterQueue,
): { recovered: number; failed: number; dlqAdmitted: number } {
  let recovered = 0;
  let failed = 0;
  let dlqAdmitted = 0;

  // ── Restore circuit breaker state (if snapshot exists) ────
  if (cb) {
    try {
      const snapshotPath = resolveUserPath("~/.openclaw/router/circuit-state.json");
      if (fs.existsSync(snapshotPath)) {
        cb.restore(fs.readFileSync(snapshotPath, "utf-8"));
      }
    } catch { /* non-fatal */ }
  }

  const stuckJobs = getStuckJobs(db);

  for (const job of stuckJobs) {
    if (job.status === "evaluating") {
      updateJob(db, job.id, { status: "in_queue" });
      recovered++;
    } else if (job.status === "in_execution") {
      if (job.retry_count < MAX_RETRIES) {
        updateJob(db, job.id, {
          status: "pending",
          retry_count: job.retry_count + 1,
        });
        recovered++;
      } else {
        // ── KEY CHANGE: instead of silently failing, admit to DLQ ──
        // Only do this if the job isn't a circuit_open failure
        // (circuit_open jobs already wrote status=failed before archiving)
        if (dlqQueue && !dlqQueue.has(job.id)) {
          updateJob(db, job.id, { status: "pending" }); // keep alive for DLQ retry
          dlqQueue.enqueue(job.id, job.payload, job.issuer, "max_retries_exceeded", {
            originalTier: job.tier ?? undefined,
            initialError: job.error ?? "max retries exceeded at crash recovery",
          });
          dlqAdmitted++;
          console.log(`[router:recovery] job ${job.id}: in_execution → DLQ (max retries at restart)`);
        } else {
          // No DLQ — original behavior
          updateJob(db, job.id, {
            status: "failed",
            error: "gateway crash: max retries exceeded",
            finished_at: new Date().toISOString().replace("T", " ").slice(0, 19),
          });
          failed++;
        }
      }
    }
  }

  // Re-deliver undelivered terminal jobs (unchanged)
  const undelivered = db.prepare(
    `SELECT * FROM jobs WHERE status IN ('completed', 'failed') AND delivered_at IS NULL`
  ).all() as unknown as RouterJob[];

  for (const job of undelivered) {
    deliverResult(db, job.id);
  }

  return { recovered, failed, dlqAdmitted };
}
```

### 6c. DLQ Retry Loop (add to `router/loop.ts`)

```typescript
// Runs alongside the main router dispatch loop
// Tick every 10s; processes due DLQ entries

export function startDlqRetryLoop(
  dlqQueue: DeadLetterQueue,
  cb: CircuitBreaker,
  db: DatabaseSync,
  dispatchJob: (jobId: string, payload: string, issuer: string, tier: Tier | null) => void,
): () => void {
  const interval = setInterval(() => {
    const due = dlqQueue.getDueEntries();

    for (const entry of due) {
      const resolvedTier = entry.originalTier
        ? cb.resolveRoute(entry.originalTier)
        : null;

      if (resolvedTier === null) {
        // Still no available tier — reschedule
        const updated = dlqQueue.recordAttempt(entry.id, false, "no_tier_available");
        if (updated?.deadAt) {
          // Permanently dead — mark the job failed, notify user
          updateJob(db, entry.jobId, {
            status: "failed",
            error: `dlq_dead: ${entry.reason} after ${entry.dlqAttempts} attempts`,
            finished_at: new Date().toISOString().replace("T", " ").slice(0, 19),
          });
          routerEvents.emit("job:failed", {
            jobId: entry.jobId,
            error: `dlq_dead after ${entry.dlqAttempts} attempts`,
          });
        }
        continue;
      }

      // Re-dispatch the job
      try {
        // Restore job to pending state for re-execution
        updateJob(db, entry.jobId, {
          status: "pending",
          error: null,
          finished_at: null,
        });
        dispatchJob(entry.jobId, entry.payload, entry.issuer, resolvedTier);
      } catch (err) {
        dlqQueue.recordAttempt(
          entry.id,
          false,
          err instanceof Error ? err.message : String(err),
          resolvedTier
        );
      }
    }
  }, 10_000); // check every 10s

  return () => clearInterval(interval);
}
```

### 6d. Observability — Structured Event Sink

```typescript
// observability.ts — wire up all events to a structured log / metrics

import type { CircuitBreaker } from "./circuit-breaker.js";
import type { DeadLetterQueue } from "./dlq.js";
import type { PipelineObservabilityEvent } from "./circuit-breaker-types.js";

export function attachObservability(
  cb: CircuitBreaker,
  dlqQueue: DeadLetterQueue,
  sink: (event: PipelineObservabilityEvent) => void = defaultSink,
): () => void {
  const onCircuit = (event: unknown) => sink(event as PipelineObservabilityEvent);
  const onDlq = (event: unknown) => sink(event as PipelineObservabilityEvent);

  cb.on("circuit", onCircuit);
  dlqQueue.on("dlq", onDlq);

  return () => {
    cb.off("circuit", onCircuit);
    dlqQueue.off("dlq", onDlq);
  };
}

function defaultSink(event: PipelineObservabilityEvent): void {
  // Structured JSON log — easily consumed by log aggregators
  console.log(JSON.stringify({ source: "pipeline", ...event }));
}

// Example output:
// {"source":"pipeline","kind":"circuit:opened","tier":"sonnet","failureRate":0.6,"samples":5,"at":1741161120000}
// {"source":"pipeline","kind":"dlq:enqueued","jobId":"abc123","reason":"circuit_open","dlqId":"uuid","at":1741161121000}
// {"source":"pipeline","kind":"circuit:half_open","tier":"sonnet","cooldownElapsedMs":61000,"at":1741161181000}
// {"source":"pipeline","kind":"dlq:recovered","jobId":"abc123","dlqId":"uuid","at":1741161190000}
```

---

## 7. EDGE CASE ANALYSIS

### 7a. Gateway Restart with Open Circuits

**Scenario:** Sonnet circuit is OPEN when gateway crashes and restarts.

**Problem:** In-memory `CircuitBreaker` state is lost. Without persistence, sonnet jobs would route normally and immediately re-trigger failures.

**Solution (implemented above):**
```
Gateway start
  → recover() calls cb.restore(file)
  → Reads ~/.openclaw/router/circuit-state.json
  → Restores OPEN circuits with original openedAt timestamp
  → If cooldown already elapsed during downtime → restores as HALF_OPEN
  → If still within cooldown → restores as OPEN

Gateway stop (graceful)
  → cb.serialize() → writes circuit-state.json
  → File persists across restart

Crash (non-graceful)
  → No shutdown hook fires
  → On restart, circuit state lost (window samples lost)
  → Recovery sees no snapshot → all circuits start CLOSED
  → This is safe: the sliding window is empty, so minSamples(5) isn't met
    → circuit won't reopen until 5 new failures accumulate
  → Effectively: a crash acts as a circuit reset (acceptable tradeoff)
```

**Recommendation:** Also write circuit state periodically (e.g., every 30s via heartbeat) to minimize exposure window on crash.

---

### 7b. DLQ Interaction with Existing MAX_RETRIES=2

**Current behavior:**
```
in_execution crash #1 → retry_count=1 → pending
in_execution crash #2 → retry_count=2 → pending
in_execution crash #3 → retry_count >= MAX_RETRIES(2) → FAILED (silent)
```

**With DLQ:**
```
in_execution crash #1 → retry_count=1 → pending (recovery.ts unchanged)
in_execution crash #2 → retry_count=2 → pending (recovery.ts unchanged)
in_execution crash #3 → retry_count >= MAX_RETRIES(2)
  → WITHOUT DLQ: status=failed (old behavior)
  → WITH DLQ: status=pending + DLQ.enqueue(reason="max_retries_exceeded")
    → DLQ retry #1: backoff 30s, try on available tier
    → DLQ retry #2: backoff 60s
    → DLQ retry #3: backoff 120s
    → If all DLQ attempts fail: status=failed + user notified (NEW)
```

**Concern:** There are now two retry counters: `retry_count` (recovery.ts, max 2) and `dlqAttempts` (DLQ, max 3). Maximum total retries = 2 (recovery) + 3 (DLQ) = 5. For most transient failures this is appropriate. For resource-constrained environments, set `DLQConfig.maxAttempts=1` to limit total retries to 3.

**Key invariant to preserve:** `recovery.ts` MAX_RETRIES=2 **must not be raised** — it exists to prevent infinite crash loops. DLQ is a separate tier of recovery for jobs that survive crash recovery but continue to fail at execution time.

---

### 7c. All Three Tiers Circuit-Broken Simultaneously

**Scenario:** API provider outage, or a bad deployment where all models are returning 5xx.

**Current behavior (without CB+DLQ):** Every job runs, fails immediately, burns MAX_RETRIES, goes silently dead.

**With CB+DLQ:**

```
Phase 1 — Opening (first ~5 jobs per tier):
  haiku jobs: 5 failures → haiku OPEN
  sonnet jobs: 5 failures → sonnet OPEN
  opus jobs: 5 failures → opus OPEN
  (all circuits open within ~windowMs=5min)

Phase 2 — All circuits OPEN:
  New jobs: resolveRoute() returns null
  → ALL new jobs go directly to DLQ with reason="circuit_open"
  → No execution attempts (fast-fail — avoids burning API quota)
  → User-facing: immediate DLQ acknowledgment in job result

Phase 3 — Cooldown expires (default: 1 min per tier):
  haiku: OPEN → HALF_OPEN (probe allowed)
  sonnet: OPEN → HALF_OPEN
  opus: OPEN → HALF_OPEN
  (staggered because they opened at slightly different times)

Phase 4 — DLQ retry loop (10s tick):
  getDueEntries() finds jobs with elapsed nextRetryAt
  resolveRoute() finds first HALF_OPEN tier → returns it (allows 1 probe)
  Job re-dispatched as probe
  If probe succeeds: circuit closes, DLQ entry recovered
  If probe fails: circuit re-opens, DLQ entry rescheduled with backoff

Phase 5 — Complete outage (all 3 tiers fail probes repeatedly):
  DLQ entries exhaust maxAttempts=3
  → status=failed, error="dlq_dead: circuit_open after 3 attempts"
  → routerEvents.emit("job:failed") → notifier → onDelivered
  → User IS notified (unlike current silent failure)
```

**Safety valve:** DLQ size grows unbounded during full outage. Add a configurable `maxQueueSize` to reject new DLQ admissions when the queue is full, returning an immediate user-visible error rather than silently queuing forever.

---

## 8. SUMMARY: WHAT CHANGES, WHAT STAYS

| Component | Change |
|-----------|--------|
| `worker.ts` | Add tier param; record to CircuitBreaker; admit to DLQ on failure |
| `recovery.ts` | On max-retries: DLQ admission instead of silent fail; restore circuit state |
| `notifier.ts` | No changes needed — F14 (onDelivered throws) should add try/catch around `onDelivered` + emit an error event |
| `loop.ts` (router) | Add DLQ retry loop alongside existing dispatch loop |
| New: `circuit-breaker.ts` | TierCircuit state machine + sliding window |
| New: `dlq.ts` | DLQ with exponential backoff + poison pill detection |
| New: `observability.ts` | Structured event sink for all CB+DLQ state transitions |
| `queue.ts` / DB | Add `dlq_entries` table for DLQ persistence across restarts (optional but recommended) |

**Zero behavior change for the happy path.** The circuit breaker only activates when failure rate exceeds threshold. The DLQ is only admitted when a job would have previously silently died. All existing `routerEvents` contracts are preserved.
