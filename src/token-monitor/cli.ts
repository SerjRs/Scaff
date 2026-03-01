/**
 * CLI command: `openclaw tokens`
 * Connects to the gateway and displays a live token usage table.
 */

import type { Command } from "commander";
import { callGateway } from "../gateway/call.js";
import { loadConfig } from "../config/config.js";
import { defaultRuntime } from "../runtime.js";
import { runCommandWithRuntime } from "../cli/cli-utils.js";
import { theme } from "../terminal/theme.js";
import { formatHelpExamples } from "../cli/help-format.js";
import type { TokensSnapshotResult } from "./gateway-methods.js";

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

function pad(str: string, width: number, align: "left" | "right" = "left"): string {
  if (str.length >= width) return str;
  const padding = " ".repeat(width - str.length);
  return align === "right" ? padding + str : str + padding;
}

// Stable sort so rows don't jump around — alphabetical by agentId then model.
function sortRowsStable(rows: TokensSnapshotResult["rows"]): TokensSnapshotResult["rows"] {
  return rows.toSorted((a, b) => {
    const agentCmp = a.agentId.localeCompare(b.agentId);
    if (agentCmp !== 0) return agentCmp;
    return a.model.localeCompare(b.model);
  });
}

function renderTable(result: TokensSnapshotResult, rich: boolean): string {
  const colAgent = 14;
  const colModel = 24;
  const colIn = 12;
  const colOut = 12;
  const colCached = 12;
  const colCalls = 7;

  const sep = rich ? "\u2502" : "|";
  const hline = rich ? "\u2500" : "-";
  const cross = rich ? "\u253c" : "+";

  const header = [
    pad("AGENT-ID", colAgent),
    pad("MODEL", colModel),
    pad("TOKENS-IN", colIn, "right"),
    pad("TOKENS-OUT", colOut, "right"),
    pad("CACHED", colCached, "right"),
    pad("CALLS", colCalls, "right"),
  ].join(` ${sep} `);

  const divider = [
    hline.repeat(colAgent),
    hline.repeat(colModel),
    hline.repeat(colIn),
    hline.repeat(colOut),
    hline.repeat(colCached),
    hline.repeat(colCalls),
  ].join(`${hline}${cross}${hline}`);

  const lines: string[] = [];
  lines.push(rich ? theme.heading(header) : header);
  lines.push(divider);

  const sortedRows = sortRowsStable(result.rows);

  if (sortedRows.length === 0) {
    lines.push(rich ? theme.muted("  (no API calls recorded yet)") : "  (no API calls recorded yet)");
  } else {
    for (const row of sortedRows) {
      const line = [
        pad(row.agentId, colAgent),
        pad(row.model, colModel),
        pad(formatNumber(row.tokensIn), colIn, "right"),
        pad(formatNumber(row.tokensOut), colOut, "right"),
        pad(formatNumber(row.cached), colCached, "right"),
        pad(formatNumber(row.calls), colCalls, "right"),
      ].join(` ${sep} `);
      lines.push(line);
    }

    lines.push(divider);

    const totalsLine = [
      pad("TOTAL", colAgent),
      pad("", colModel),
      pad(formatNumber(result.totals.tokensIn), colIn, "right"),
      pad(formatNumber(result.totals.tokensOut), colOut, "right"),
      pad(formatNumber(result.totals.cached), colCached, "right"),
      pad(formatNumber(result.totals.calls), colCalls, "right"),
    ].join(` ${sep} `);
    lines.push(rich ? theme.accent(totalsLine) : totalsLine);
  }

  return lines.join("\n");
}

async function fetchSnapshot(config?: ReturnType<typeof loadConfig>): Promise<TokensSnapshotResult> {
  return await callGateway<TokensSnapshotResult>({
    method: "usage.tokens",
    config,
  });
}

async function resetLedger(config?: ReturnType<typeof loadConfig>): Promise<void> {
  await callGateway({
    method: "usage.tokens.reset",
    config,
  });
}

function setupExitHandlers(cleanup: () => void): void {
  // Listen on raw stdin so Ctrl+C works reliably on Windows CMD
  if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", (data: Buffer) => {
      // Ctrl+C = 0x03, q/Q to quit, Esc = 0x1B
      const byte = data[0];
      if (byte === 0x03 || byte === 0x71 || byte === 0x51 || byte === 0x1b) {
        cleanup();
      }
    });
  }
  // Fallback for non-TTY or piped input
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

async function tokensCommand(opts: {
  json?: boolean;
  watch?: boolean;
  reset?: boolean;
}): Promise<void> {
  const config = loadConfig();

  if (opts.reset) {
    await resetLedger(config);
    defaultRuntime.log("Token ledger cleared.");
    return;
  }

  if (opts.watch) {
    const INTERVAL_MS = 2000;
    const rich = Boolean(theme.accent);
    let stopped = false;
    let interval: ReturnType<typeof setInterval> | null = null;

    const cleanup = () => {
      if (stopped) return;
      stopped = true;
      if (interval) clearInterval(interval);
      // Restore terminal
      if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
        process.stdin.setRawMode(false);
      }
      // Show cursor, move below table
      process.stdout.write("\x1B[?25h\n");
      process.exit(0);
    };

    setupExitHandlers(cleanup);

    // Hide cursor to reduce visual noise
    process.stdout.write("\x1B[?25l");

    const renderWatch = async () => {
      if (stopped) return;
      try {
        const result = await fetchSnapshot(config);
        const table = renderTable(result, rich);
        const footer = theme.muted("  Press q or Ctrl+C to stop");
        const frame = `${table}\n\n${footer}`;

        // Move cursor to home position, write frame, clear everything below
        process.stdout.write(`\x1B[H${frame}\x1B[J`);
      } catch {
        // Gateway disconnected — keep trying
      }
    };

    // Initial render: clear screen once, then overwrite in-place
    process.stdout.write("\x1B[2J\x1B[H");
    await renderWatch();

    interval = setInterval(() => {
      void renderWatch();
    }, INTERVAL_MS);

    // Block until cleanup runs
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (stopped) {
          clearInterval(check);
          resolve();
        }
      }, 100);
    });
  } else {
    const result = await fetchSnapshot(config);
    if (opts.json) {
      defaultRuntime.log(JSON.stringify(result, null, 2));
    } else {
      const rich = Boolean(theme.accent);
      defaultRuntime.log(renderTable(result, rich));
    }
  }
}

export function registerTokensCommand(program: Command): void {
  program
    .command("tokens")
    .description("Show live LLM token usage by agent and model")
    .option("--json", "Output JSON instead of table", false)
    .option("--watch", "Continuously refresh every 2 seconds", false)
    .option("--reset", "Clear the token ledger", false)
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["openclaw tokens", "Show current token usage snapshot."],
          ["openclaw tokens --watch", "Live-updating table (2s refresh)."],
          ["openclaw tokens --json", "Machine-readable output."],
          ["openclaw tokens --reset", "Clear the in-memory ledger."],
        ])}`,
    )
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await tokensCommand({
          json: Boolean(opts.json),
          watch: Boolean(opts.watch),
          reset: Boolean(opts.reset),
        });
      });
    });
}
