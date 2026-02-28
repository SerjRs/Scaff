/**
 * Gateway ↔ Router integration module.
 *
 * Manages a global (singleton) Router instance and provides the bridge
 * between the gateway's execution path and the Router queue.
 *
 * This module is the **single integration point** described in the
 * architecture doc (§6). Everything that uses `callGateway()` for agent
 * execution can be routed through the Router by swapping the call to
 * `routerCallGateway()` (Task 11, Step 4 — wiring deferred to a later task).
 *
 * @module
 */

import path from "node:path";
import fs from "node:fs";
import type { CallGatewayOptions } from "../gateway/call.js";
import { callGateway } from "../gateway/call.js";
import { startRouter, type RouterInstance, type AgentExecutor } from "./index.js";
import type { OnDeliveredCallback } from "./notifier.js";
import type { RouterConfig, RouterJob } from "./types.js";
import { resolveStateDir } from "../config/paths.js";
import { getCortexSessionKey } from "../cortex/session.js";

// ---------------------------------------------------------------------------
// Global singleton — use globalThis to survive bundler chunk splitting.
// Module-scoped variables get duplicated across chunks, breaking the
// singleton pattern. globalThis ensures a single shared instance.
// ---------------------------------------------------------------------------

const ROUTER_KEY = "__openclaw_router_instance__" as const;

function getRouterInstance(): RouterInstance | null {
  return (globalThis as Record<string, unknown>)[ROUTER_KEY] as RouterInstance | null ?? null;
}

function setRouterInstance(instance: RouterInstance | null): void {
  (globalThis as Record<string, unknown>)[ROUTER_KEY] = instance;
}

// ---------------------------------------------------------------------------
// Gateway executor factory
// ---------------------------------------------------------------------------

/**
 * Create an {@link AgentExecutor} that bridges Router workers to the
 * gateway's existing agent execution mechanism.
 *
 * The executor runs tasks in **fully isolated sessions** under the
 * `router-executor` agent — no SOUL.md, AGENTS.md, USER.md, MEMORY.md,
 * no tools, no memory search, no skills. The Router's tier template
 * (rendered by the Dispatcher) is the executor's ONLY instruction set.
 *
 * Session key format: `agent:router-executor:task:<uuid>`
 *
 * The returned function signature matches what the Router worker expects:
 *   `(prompt: string, model: string) => Promise<string>`
 */
export function createGatewayExecutor(): AgentExecutor {
  return async (prompt: string, model: string): Promise<string> => {
    // Always create an isolated session under the router-executor agent.
    // This agent has an empty workspace — no context files are injected.
    const sessionKey = `agent:${EXECUTOR_AGENT_ID}:task:${crypto.randomUUID()}`;
    const idempotencyKey = crypto.randomUUID();

    // Patch the model selected by the Router's Dispatcher
    if (model) {
      await callGateway({
        method: "sessions.patch",
        params: { key: sessionKey, model },
        timeoutMs: 10_000,
      });
    }

    // Execute the agent — expectFinal waits for the completed result
    const response = await callGateway<{
      runId?: string;
      status: string;
      result?: unknown;
      summary?: string;
    }>({
      method: "agent",
      params: {
        message: prompt,
        sessionKey,
        deliver: false,
        idempotencyKey,
      },
      expectFinal: true,
      timeoutMs: 5 * 60 * 1000,
    });

    if (response?.status === "error") {
      throw new Error(response.summary ?? "agent execution failed");
    }

    // Clean up the isolated session after execution
    try {
      await callGateway({
        method: "sessions.delete",
        params: { key: sessionKey, deleteTranscript: true },
        timeoutMs: 10_000,
      });
    } catch {
      // Best-effort cleanup — don't fail the task
    }

    // Extract text result from gateway agent response.
    // Shape: { result: { payloads: [{ text, mediaUrl }], meta } }
    const result = response?.result as Record<string, unknown> | undefined;
    const payloads = result?.payloads as Array<{ text?: string }> | undefined;
    if (payloads?.[0]?.text) {
      return payloads[0].text;
    }
    if (typeof response?.result === "string") {
      return response.result;
    }
    if (response?.summary && typeof response.summary === "string") {
      return response.summary;
    }
    return JSON.stringify(response?.result ?? response ?? {});
  };
}

// ---------------------------------------------------------------------------
// Auth sync — copy main agent credentials to router-executor agent
// ---------------------------------------------------------------------------

const EXECUTOR_AGENT_ID = "router-executor";

/**
 * Sync auth files from the main agent to the router-executor agent.
 * This ensures the executor can authenticate with the same API keys.
 * Called on startup — idempotent, safe to call multiple times.
 */
function syncExecutorAuth(): void {
  try {
    const stateDir = resolveStateDir();
    const mainAgentDir = path.join(stateDir, "agents", "main", "agent");
    const executorAgentDir = path.join(stateDir, "agents", EXECUTOR_AGENT_ID, "agent");

    // Ensure executor agent dir exists
    fs.mkdirSync(executorAgentDir, { recursive: true });

    // Files to sync
    const authFiles = ["auth-profiles.json", "auth.json"];

    for (const file of authFiles) {
      const src = path.join(mainAgentDir, file);
      const dst = path.join(executorAgentDir, file);
      try {
        fs.copyFileSync(src, dst);
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === "ENOENT") {
          // Source file doesn't exist — skip silently
          continue;
        }
        console.log(`[router] Warning: failed to sync ${file} to executor agent: ${(err as Error).message}`);
      }
    }
    console.log("[router] Synced auth profiles to router-executor agent");
  } catch (err) {
    console.log(`[router] Warning: auth sync failed: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Lifecycle: init / stop
// ---------------------------------------------------------------------------

/**
 * Initialize the global Router instance.
 *
 * Called during gateway startup (after config is loaded).
 * If a Router instance already exists (e.g. from a hot-reload),
 * it is stopped first.
 *
 * @param config - Router configuration from `openclaw.json`
 */
export function initGatewayRouter(config: RouterConfig): void {
  if (!config.enabled) {
    console.log("[router] Router disabled in config — skipping init");
    return;
  }

  // Sync auth before starting — executor needs API credentials
  syncExecutorAuth();

  // Stop any existing instance (idempotent — handles hot-reload)
  const existing = getRouterInstance();
  if (existing) {
    console.log("[router] Stopping previous Router instance before re-init");
    try {
      existing.stop();
    } catch {
      // Best-effort cleanup
    }
    setRouterInstance(null);
  }

  const executor = createGatewayExecutor();

  // §3.7 Step 3: Push result to the issuer's session on delivery.
  // Same mechanism as subagent completion announcements — callGateway({ method: "agent" }).
  // NOTE: Cortex-issued jobs are handled by gateway-bridge.ts via routerEvents —
  // skip them here to avoid double-handling (which causes ghost messages on WhatsApp).
  const cortexSessionKey = getCortexSessionKey("main");
  const onDelivered: OnDeliveredCallback = (jobId, job) => {
    const issuer = job.issuer;
    if (!issuer) return;
    console.log(`[router/notifier] onDelivered: jobId=${jobId} issuer="${issuer}" cortexKey="${cortexSessionKey}" match=${issuer === cortexSessionKey}`);
    if (issuer === cortexSessionKey) return; // Cortex handles its own results via the bus

    const content = job.status === "completed"
      ? (job.result ?? "Task completed.")
      : `Error: ${job.error ?? "Unknown error"}`;

    const systemMessage = [
      `[System Message] Router Job ${jobId} ${job.status}.`,
      "",
      "Result:",
      content,
    ].join("\n");

    // Fire-and-forget — don't block the Notifier
    callGateway({
      method: "agent",
      params: {
        sessionKey: issuer,
        message: systemMessage,
        deliver: true,
      },
      timeoutMs: 30_000,
    }).catch((err) => {
      console.log(`[router] Failed to push result to issuer ${issuer}: ${err instanceof Error ? err.message : String(err)}`);
    });
  };

  setRouterInstance(startRouter(config, executor, onDelivered));
  console.log("[router] Gateway Router initialized");
}

/**
 * Stop the global Router instance.
 *
 * Called during gateway shutdown. Safe to call when no instance exists (no-op).
 */
export function stopGatewayRouter(): void {
  const instance = getRouterInstance();
  if (!instance) {
    return;
  }

  try {
    instance.stop();
  } catch {
    // Best-effort — don't block gateway shutdown
  }

  setRouterInstance(null);
  console.log("[router] Gateway Router stopped");
}

// ---------------------------------------------------------------------------
// Router-aware callGateway replacement
// ---------------------------------------------------------------------------

/**
 * Router-aware callGateway replacement.
 *
 * **What it does:**
 * 1. Evaluates task complexity via Ollama (+ Sonnet verification if weight > 3)
 * 2. Resolves weight → tier → model
 * 3. Renders the tier-specific template — this becomes the executor's ONLY prompt
 * 4. Patches the session with the selected model
 * 5. Falls through to normal `callGateway()` with the rendered template as the message
 *
 * **Context isolation:** The session is already under `router-executor` agent
 * (set by `subagent-spawn.ts`), which has an empty workspace — no SOUL.md,
 * AGENTS.md, USER.md, MEMORY.md, no tools. The template is the complete context.
 *
 * **Standard lifecycle preserved:** `callGateway()` returns `{ runId }` immediately.
 * `agent.wait`, announce, and cleanup all work as usual — the Router doesn't
 * interfere with any gateway mechanisms.
 */
export async function routerCallGateway<T = Record<string, unknown>>(
  opts: CallGatewayOptions,
  _routerMode: "sync" | "async" = "sync",
): Promise<T> {
  const instance = getRouterInstance();
  if (opts.method !== "agent" || !instance) {
    return callGateway<T>(opts);
  }

  const params = opts.params as Record<string, unknown> | undefined;
  const message =
    typeof params?.message === "string" ? params.message : "";
  const sessionKey =
    typeof params?.sessionKey === "string" ? params.sessionKey : undefined;

  let weight: number | undefined;
  let tier: string | undefined;
  let model: string | undefined;

  try {
    // 1. Evaluate task complexity (Ollama → optional Sonnet)
    const { evaluate } = await import("./evaluator.js");
    const routerConfig = instance.getConfig();
    const evalResult = await evaluate(routerConfig.evaluator, message);

    // 2. Resolve weight → tier → model
    const { resolveWeightToTier } = await import("./dispatcher.js");
    const resolvedTier = resolveWeightToTier(evalResult.weight, routerConfig.tiers);
    weight = evalResult.weight;
    tier = resolvedTier;
    model = routerConfig.tiers[resolvedTier].model;

    console.log(`[router] evaluated: w=${weight} → ${tier} (${model})`);

    // 3. Render the tier-specific template — this IS the executor's complete prompt.
    //    No SOUL.md, no AGENTS.md, no parent context. Just the template + task.
    const { getTemplate, renderTemplate } = await import("./templates/index.js");
    const template = getTemplate(resolvedTier, "agent_run");
    const renderedPrompt = renderTemplate(template, {
      task: message,
      context: "",
      issuer: "",
      constraints: "",
    });

    // 4. Patch the session with the Router-selected model
    if (sessionKey) {
      await callGateway({
        method: "sessions.patch",
        params: { key: sessionKey, model },
        timeoutMs: 10_000,
      });
    }

    // 5. Replace the message in opts with the rendered template
    const modifiedOpts: CallGatewayOptions = {
      ...opts,
      params: {
        ...params,
        message: renderedPrompt,
      },
    };

    // 6. Execute via normal callGateway — preserves subagent lifecycle
    const response = await callGateway<T>(modifiedOpts);

    // 7. Log the Router decision to SQLite (fire-and-forget, non-blocking)
    void logRouterDecision(instance, {
      message,
      weight,
      tier,
      model,
      runId: (response as Record<string, unknown>)?.runId as string | undefined,
      sessionKey,
    });

    return response;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.log(`[router] evaluation/routing failed, falling through to default: ${detail}`);

    // Evaluation or template rendering failed — fall through with original message
    return callGateway<T>(opts);
  }
}

/**
 * Log a Router decision to the SQLite archive for observability.
 * Non-blocking, best-effort — never throws.
 */
async function logRouterDecision(
  instance: RouterInstance,
  decision: {
    message: string;
    weight?: number;
    tier?: string;
    model?: string;
    runId?: string;
    sessionKey?: string;
  },
): Promise<void> {
  try {
    const jobId = instance.enqueue("agent_run", { message: decision.message }, decision.sessionKey ?? "unknown");
    // The Router loop would normally pick this up, but we've already handled it.
    // Mark as completed immediately and let the notifier archive it.
    // Import queue operations to update directly.
    const { updateJob, archiveJob, initRouterDb } = await import("./queue.js");
    const db = initRouterDb();
    updateJob(db, jobId, {
      weight: decision.weight,
      tier: (decision.tier as import("./types.js").Tier) ?? null,
      status: "completed",
      result: JSON.stringify({
        model: decision.model,
        runId: decision.runId,
        routed: true,
      }),
      worker_id: decision.runId,
      started_at: new Date().toISOString().replace("T", " ").slice(0, 19),
      finished_at: new Date().toISOString().replace("T", " ").slice(0, 19),
      delivered_at: new Date().toISOString().replace("T", " ").slice(0, 19),
    });
    archiveJob(db, jobId);
  } catch {
    // Best-effort — don't break the main flow for tracking failures
  }
}

// ---------------------------------------------------------------------------
// Accessors (for testing / introspection)
// ---------------------------------------------------------------------------

/**
 * Returns the current Router instance, or null if not initialized.
 * Primarily useful for tests and status endpoints.
 */
export function getGatewayRouter(): RouterInstance | null {
  return getRouterInstance();
}

/**
 * Check if the Router is active and accepting jobs.
 */
export function isGatewayRouterActive(): boolean {
  return getRouterInstance() !== null;
}

// ---------------------------------------------------------------------------
// Wiring points (completed)
// ---------------------------------------------------------------------------
// [subagent-spawn.ts] — routerCallGateway() replaces callGateway() for agent
//   execution when Router is active. Session key uses router-executor agent
//   for full context isolation.
// [server-startup.ts] — initGatewayRouter() called during startup.
// [server-close.ts] — stopGatewayRouter() called during shutdown.
