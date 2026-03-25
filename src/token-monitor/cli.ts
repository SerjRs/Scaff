/**
 * CLI command: `openclaw tokens`
 * Connects to the gateway and displays a live token usage table.
 *
 * Column layout: PID | Model | Task | Channel | CTX | Tokens In | Tokens Out | Duration | Status
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
  if (str.length >= width) return str.slice(0, width);
  const padding = " ".repeat(width - str.length);
  return align === "right" ? padding + str : str + padding;
}

/**
 * Format a duration in milliseconds as a human-readable string.
 * < 60s  → "12s"
 * < 60m  → "5m 12s"
 * >= 60m → "1h 23m"
 */
function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainMinutes = minutes % 60;
  return `${hours}h ${remainMinutes}m`;
}

// Stable sort so rows don't jump around — alphabetical by agentId then model.
function sortRowsStable(rows: TokensSnapshotResult["rows"]): TokensSnapshotResult["rows"] {
  return rows.toSorted((a, b) => {
    // Sort by status priority: Active/InProgress first, terminal last
    const statusOrder = { Active: 0, Queued: 1, InProgress: 2, Finished: 3, Canceled: 4, Failed: 5 };
    const sa = statusOrder[a.status] ?? 2;
    const sb = statusOrder[b.status] ?? 2;
    if (sa !== sb) return sa - sb;
    const agentCmp = a.agentId.localeCompare(b.agentId);
    if (agentCmp !== 0) return agentCmp;
    return a.model.localeCompare(b.model);
  });
}

/** Color a status string based on its value. */
function colorStatus(status: string, rich: boolean): string {
  if (!rich) return status;
  switch (status) {
    case "Active":
      return theme.accent ? theme.accent(status) : status;
    case "InProgress":
      return theme.heading ? theme.heading(status) : status;
    case "Finished":
      return theme.muted ? theme.muted(status) : status;
    case "Failed":
      return `\x1B[31m${status}\x1B[0m`; // red
    case "Queued":
      return `\x1B[33m${status}\x1B[0m`; // yellow
    case "Canceled":
      return `\x1B[33m${status}\x1B[0m`; // yellow
    default:
      return status;
  }
}

/** Resolve the task label for a row. Persistent agents show "Live session". */
function resolveTaskLabel(row: TokensSnapshotResult["rows"][number]): string {
  if (row.task) return row.task;
  // Persistent agents (Active status, no task set) get a generic label
  if (row.status === "Active") return "Live session";
  return "";
}

/** Format context tokens as compact "k" notation (e.g. 148k, 12k, 200k). */
function formatCtx(tokens?: number): string {
  if (tokens == null || tokens <= 0) return "";
  if (tokens < 1000) return String(tokens);
  return `${Math.round(tokens / 1000)}k`;
}

function renderTable(result: TokensSnapshotResult, rich: boolean): string {
  const colPid = 12;
  const colModel = 24;
  const colTask = 42;
  const colChannel = 16;
  const colCtx = 8;
  const colIn = 12;
  const colOut = 12;
  const colDuration = 10;
  const colStatus = 12;

  const sep = rich ? "\u2502" : "|";
  const hline = rich ? "\u2500" : "-";
  const cross = rich ? "\u253c" : "+";

  const header = [
    pad("PID", colPid),
    pad("MODEL", colModel),
    pad("TASK", colTask),
    pad("CHANNEL", colChannel),
    pad("CTX", colCtx, "right"),
    pad("TOKENS-IN", colIn, "right"),
    pad("TOKENS-OUT", colOut, "right"),
    pad("DURATION", colDuration, "right"),
    pad("STATUS", colStatus),
  ].join(` ${sep} `);

  const divider = [
    hline.repeat(colPid),
    hline.repeat(colModel),
    hline.repeat(colTask),
    hline.repeat(colChannel),
    hline.repeat(colCtx),
    hline.repeat(colIn),
    hline.repeat(colOut),
    hline.repeat(colDuration),
    hline.repeat(colStatus),
  ].join(`${hline}${cross}${hline}`);

  const lines: string[] = [];
  lines.push(rich ? theme.heading(header) : header);
  lines.push(divider);

  const sortedRows = sortRowsStable(result.rows);
  const now = Date.now();

  if (sortedRows.length === 0) {
    lines.push(rich ? theme.muted("  (no API calls recorded yet)") : "  (no API calls recorded yet)");
  } else {
    for (const row of sortedRows) {
      const durationMs = now - (row.startedAt ?? now);
      const statusText = row.status ?? "Active";
      const statusDisplay = colorStatus(pad(statusText, colStatus), rich);
      const taskLabel = resolveTaskLabel(row);

      const line = [
        pad(row.pid ?? String(process.pid), colPid),
        pad(row.model, colModel),
        pad(taskLabel, colTask),
        pad(row.channel ?? row.agentId, colChannel),
        pad(formatCtx(row.ctxTokens), colCtx, "right"),
        pad(formatNumber(row.tokensIn), colIn, "right"),
        pad(formatNumber(row.tokensOut), colOut, "right"),
        pad(formatDuration(durationMs), colDuration, "right"),
        statusDisplay,
      ].join(` ${sep} `);
      lines.push(line);
    }

    lines.push(divider);

    const totalsLine = [
      pad("TOTAL", colPid),
      pad("", colModel),
      pad("", colTask),
      pad("", colChannel),
      pad("", colCtx, "right"),
      pad(formatNumber(result.totals.tokensIn), colIn, "right"),
      pad(formatNumber(result.totals.tokensOut), colOut, "right"),
      pad("", colDuration, "right"),
      pad("", colStatus),
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
