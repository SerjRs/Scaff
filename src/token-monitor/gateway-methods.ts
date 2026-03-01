/**
 * Gateway method handlers for the token monitor.
 * - usage.tokens     → returns current ledger snapshot
 * - usage.tokens.reset → clears the ledger
 */

import type { GatewayRequestHandlers } from "../gateway/server-methods/types.js";
import { snapshot, reset, type TokenLedgerRow } from "./ledger.js";

export type TokensSnapshotResult = {
  rows: TokenLedgerRow[];
  totals: {
    tokensIn: number;
    tokensOut: number;
    cached: number;
    calls: number;
  };
};

function buildSnapshotResult(): TokensSnapshotResult {
  const rows = snapshot();
  const totals = { tokensIn: 0, tokensOut: 0, cached: 0, calls: 0 };
  for (const row of rows) {
    totals.tokensIn += row.tokensIn;
    totals.tokensOut += row.tokensOut;
    totals.cached += row.cached;
    totals.calls += row.calls;
  }
  return { rows, totals };
}

export const tokenMonitorHandlers: GatewayRequestHandlers = {
  "usage.tokens": async ({ respond }) => {
    respond(true, buildSnapshotResult(), undefined);
  },
  "usage.tokens.reset": async ({ respond }) => {
    reset();
    respond(true, { ok: true }, undefined);
  },
};
