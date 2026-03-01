/**
 * TokenLedger — in-memory singleton that accumulates per-agent/model token usage.
 * Lives as long as the gateway process; resets on restart.
 */

export type TokenLedgerRow = {
  agentId: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  cached: number;
  calls: number;
  lastCallAt: number;
};

export type TokenLedgerEvent = {
  agentId: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  cached: number;
};

type LedgerMap = Map<string, TokenLedgerRow>;

// Use globalThis to ensure a single shared ledger across all bundler chunks.
// The bundler may duplicate module-level singletons when code is split across
// separate entrypoints (gateway vs pi-embedded), causing record() and
// snapshot() to operate on different Map instances.
const LEDGER_KEY = "__openclawTokenLedger";
const _global = globalThis as unknown as Record<string, unknown>;
if (!_global[LEDGER_KEY]) {
  _global[LEDGER_KEY] = new Map();
}
const ledger: LedgerMap = _global[LEDGER_KEY] as LedgerMap;

function rowKey(agentId: string, model: string): string {
  return `${agentId}\0${model}`;
}

export function record(event: TokenLedgerEvent): void {
  const key = rowKey(event.agentId, event.model);
  const existing = ledger.get(key);
  if (existing) {
    existing.tokensIn += event.tokensIn;
    existing.tokensOut += event.tokensOut;
    existing.cached += event.cached;
    existing.calls += 1;
    existing.lastCallAt = Date.now();
  } else {
    ledger.set(key, {
      agentId: event.agentId,
      model: event.model,
      tokensIn: event.tokensIn,
      tokensOut: event.tokensOut,
      cached: event.cached,
      calls: 1,
      lastCallAt: Date.now(),
    });
  }
}

export function snapshot(): TokenLedgerRow[] {
  return Array.from(ledger.values()).toSorted(
    (a, b) => b.tokensIn + b.tokensOut - (a.tokensIn + a.tokensOut),
  );
}

export function reset(): void {
  ledger.clear();
}
