/**
 * TokenLedger — in-memory singleton that accumulates per-agent/model token usage.
 * Lives as long as the gateway process; resets on restart.
 *
 * Tracks individual sessions/tasks with PID, channel, status, and duration.
 * Terminal rows (Finished/Canceled/Failed) auto-cleanup after 30 seconds.
 */

export type TokenRowStatus = "Active" | "Queued" | "InProgress" | "Finished" | "Canceled" | "Failed";

export type TokenLedgerRow = {
  pid: string;
  agentId: string;
  model: string;
  task?: string;
  channel: string;
  /** Total context tokens (input/prompt) from the most recent API call. Updated per call, not cumulative. */
  ctxTokens?: number;
  tokensIn: number;
  tokensOut: number;
  cached: number;
  calls: number;
  lastCallAt: number;
  startedAt: number;
  status: TokenRowStatus;
  statusChangedAt: number | null;
};

export type TokenLedgerEvent = {
  agentId: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  cached: number;
  pid?: string;
  channel?: string;
  /** Unique session/task ID. When provided, each session gets its own row. */
  sessionId?: string;
  /** Short description of what this agent/task is doing (max 40 chars displayed). */
  task?: string;
  /** If true, this is a persistent agent (main, cortex) — status defaults to Active. */
  persistent?: boolean;
  /** Context tokens (input/prompt) from the current API call. Overwrites previous value (not cumulative). */
  ctxTokens?: number;
};

type LedgerMap = Map<string, TokenLedgerRow>;

// Use globalThis to ensure a single shared ledger across all bundler chunks.
// The bundler may duplicate module-level singletons when code is split across
// separate entrypoints (gateway vs pi-embedded), causing record() and
// snapshot() to operate on different Map instances.
const LEDGER_KEY = "__openclawTokenLedger";
const JOB_MAP_KEY = "__openclawTokenLedgerJobMap";
const _global = globalThis as unknown as Record<string, unknown>;
if (!_global[LEDGER_KEY]) {
  _global[LEDGER_KEY] = new Map();
}
if (!_global[JOB_MAP_KEY]) {
  _global[JOB_MAP_KEY] = new Map();
}
const ledger: LedgerMap = _global[LEDGER_KEY] as LedgerMap;
/** Maps router jobId → sessionId for status update linkage. */
const jobToSession: Map<string, string> = _global[JOB_MAP_KEY] as Map<string, string>;

/** Auto-cleanup delay for terminal rows (ms). */
const CLEANUP_DELAY_MS = 30_000;

/** Stale InProgress cleanup — rows with no activity for this long are marked Failed. */
const STALE_INPROGRESS_MS = 120_000;

/** Stale Queued cleanup — rows stuck in Queued for this long are marked Failed (orphaned). */
const STALE_QUEUED_MS = 300_000;

function rowKey(sessionIdOrAgent: string, model: string): string {
  return `${sessionIdOrAgent}\0${model}`;
}

/** Determine if a status is terminal (eligible for auto-cleanup). */
function isTerminalStatus(status: TokenRowStatus): boolean {
  return status === "Finished" || status === "Canceled" || status === "Failed";
}

export function record(event: TokenLedgerEvent): void {
  // Bug 1 fix: when sessionId is provided, key on sessionId alone to prevent
  // duplicate rows when the same session reports with varying model strings.
  const key = event.sessionId ?? rowKey(event.agentId, event.model);
  const existing = ledger.get(key);
  const now = Date.now();

  if (existing) {
    existing.tokensIn += event.tokensIn;
    existing.tokensOut += event.tokensOut;
    existing.cached += event.cached;
    existing.calls += 1;
    existing.lastCallAt = now;
    existing.model = event.model; // keep model current for session rows
    if (event.ctxTokens != null) existing.ctxTokens = event.ctxTokens; // latest, not cumulative
    if (event.pid) existing.pid = event.pid;
    if (event.channel) existing.channel = event.channel;
    if (event.task) existing.task = event.task;
  } else {
    // Bug 2 fix: persistent agents (cortex, main) should always be Active
    const isPersistent =
      event.persistent ||
      event.channel === "cortex" ||
      event.channel === "main";
    const isTask = !isPersistent && Boolean(event.sessionId);
    ledger.set(key, {
      pid: event.pid ?? String(process.pid),
      agentId: event.agentId,
      model: event.model,
      task: event.task,
      channel: event.channel ?? event.agentId,
      ctxTokens: event.ctxTokens,
      tokensIn: event.tokensIn,
      tokensOut: event.tokensOut,
      cached: event.cached,
      calls: 1,
      lastCallAt: now,
      startedAt: now,
      status: isTask ? "InProgress" : "Active",
      statusChangedAt: null,
    });
  }
}

// ---------------------------------------------------------------------------
// Status management
// ---------------------------------------------------------------------------

/** Update the status of a specific ledger row (by sessionId/agentId + model). */
export function updateStatus(sessionIdOrAgent: string, model: string, status: TokenRowStatus): void {
  const key = rowKey(sessionIdOrAgent, model);
  const row = ledger.get(key);
  if (row) {
    // Bug 3 fix: idempotent — don't reset statusChangedAt if already in the same state
    if (row.status === status) return;
    row.status = status;
    if (isTerminalStatus(status)) {
      row.statusChangedAt = Date.now();
    }
  }
}

/** Update task description for ALL rows whose key starts with a given sessionId. */
export function updateTaskBySession(sessionId: string, task: string): void {
  for (const [key, row] of ledger) {
    // Bug 1 fix: match both bare sessionId keys and legacy sessionId\0model keys
    if (key === sessionId || key.startsWith(sessionId + "\0")) {
      row.task = task;
    }
  }
}

/** Update status for ALL rows whose key starts with a given sessionId. */
export function updateStatusBySession(sessionId: string, status: TokenRowStatus): void {
  const now = Date.now();
  for (const [key, row] of ledger) {
    // Bug 1 fix: match both bare sessionId keys and legacy sessionId\0model keys
    if (key === sessionId || key.startsWith(sessionId + "\0")) {
      // Bug 3 fix: idempotent — don't reset statusChangedAt if already in same state
      if (row.status === status) continue;
      row.status = status;
      if (isTerminalStatus(status)) {
        row.statusChangedAt = now;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Router job ↔ session mapping
// ---------------------------------------------------------------------------

/** Register a mapping from router jobId to session identifier. */
export function registerJobSession(jobId: string, sessionId: string): void {
  jobToSession.set(jobId, sessionId);
}

/** Update ledger status using a router jobId (resolves via the job-session map). */
export function updateStatusByJobId(jobId: string, status: TokenRowStatus): void {
  const sessionId = jobToSession.get(jobId);
  if (sessionId) {
    updateStatusBySession(sessionId, status);
    if (isTerminalStatus(status)) {
      // Clean up the mapping after a delay (after the row will be removed)
      setTimeout(() => jobToSession.delete(jobId), CLEANUP_DELAY_MS + 5_000);
    }
  }
}

// ---------------------------------------------------------------------------
// Snapshot & reset
// ---------------------------------------------------------------------------

export function snapshot(): TokenLedgerRow[] {
  const now = Date.now();

  // Auto-cleanup: remove terminal rows older than 30s
  for (const [key, row] of ledger) {
    if (
      isTerminalStatus(row.status) &&
      row.statusChangedAt != null &&
      now - row.statusChangedAt > CLEANUP_DELAY_MS
    ) {
      ledger.delete(key);
      continue;
    }
    // Stale InProgress cleanup: non-persistent rows with no LLM activity for 2+ minutes
    // are likely orphaned (evaluator sessions, crashed tasks). Mark as Failed for cleanup.
    if (
      row.status === "InProgress" &&
      now - row.lastCallAt > STALE_INPROGRESS_MS
    ) {
      row.status = "Failed";
      row.statusChangedAt = now;
    }
    // Stale Queued cleanup: rows stuck in Queued for 5+ minutes are orphaned.
    if (
      row.status === "Queued" &&
      now - row.lastCallAt > STALE_QUEUED_MS
    ) {
      row.status = "Failed";
      row.statusChangedAt = now;
    }
  }

  return Array.from(ledger.values()).toSorted(
    (a, b) => b.tokensIn + b.tokensOut - (a.tokensIn + a.tokensOut),
  );
}

export function reset(): void {
  ledger.clear();
  jobToSession.clear();
}
