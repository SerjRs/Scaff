import { Type } from "@sinclair/typebox";
import { execSync } from "child_process";
import { existsSync } from "fs";
import { resolve } from "path";
import { resolveStateDir } from "../../config/paths.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";

const CodeSearchSchema = Type.Object({
  query: Type.String({ description: "Natural language or code query to search for" }),
  limit: Type.Optional(
    Type.Number({ description: "Max results to return (default 10, max 20)" }),
  ),
});

/**
 * Code search tool — semantic search over the indexed OpenClaw codebase.
 *
 * Uses the sqlite-vec index built by `scripts/code-index.mjs` (nightly cron).
 * Returns relevant code chunks with file paths, line numbers, and similarity scores.
 * Much cheaper than reading whole files — find the right code before diving in.
 */
export function createCodeSearchTool(): AnyAgentTool {
  return {
    label: "Code Search",
    name: "code_search",
    description:
      "Semantic search over the OpenClaw source code index. " +
      "Use before reading files to find relevant functions, classes, and code blocks. " +
      "Returns file paths, line numbers, chunk names, and code snippets ranked by relevance. " +
      "The index is rebuilt nightly — covers all src/**/*.ts files (~2,300 files, ~14,000 chunks). " +
      "Saves tokens vs reading entire files or grepping blind.",
    parameters: CodeSearchSchema,
    execute: async (_toolCallId, params) => {
      const query = readStringParam(params, "query", { required: true });
      const limit = readNumberParam(params, "limit") ?? 10;
      const clampedLimit = Math.min(Math.max(limit, 1), 20);

      const openclawDir = resolveStateDir();
      const searchScript = resolve(openclawDir, "scripts", "code-search.mjs");
      const dbPath = resolve(openclawDir, "scaff-tools", "code-index.sqlite");

      if (!existsSync(dbPath)) {
        return jsonResult({
          error: "Code index not found. Run: node scripts/code-index.mjs",
          available: false,
        });
      }

      if (!existsSync(searchScript)) {
        return jsonResult({
          error: "Search script not found at scripts/code-search.mjs",
          available: false,
        });
      }

      try {
        const output = execSync(
          `node "${searchScript}" --top ${clampedLimit} "${query.replace(/"/g, '\\"')}"`,
          {
            cwd: openclawDir,
            timeout: 30_000,
            encoding: "utf-8",
            env: { ...process.env },
          },
        );

        // Try to parse JSON output
        const trimmed = output.trim();
        if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
          const results = JSON.parse(trimmed);
          return jsonResult({ results, count: Array.isArray(results) ? results.length : 1 });
        }

        // Fallback: return raw text
        return jsonResult({ results: trimmed, format: "text" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ error: `Code search failed: ${message}`, available: true });
      }
    },
  };
}
