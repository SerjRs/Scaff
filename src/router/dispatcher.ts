import type { DatabaseSync } from "node:sqlite";
import { updateJob } from "./queue.js";
import { getTemplate, renderTemplate } from "./templates/index.js";
import { run, type AgentExecutor } from "./worker.js";
import type { RouterConfig, RouterJob, Tier, TierConfig } from "./types.js";

/** Max resource content size (64 KB) */
const MAX_RESOURCE_CONTENT_LENGTH = 65536;

/** Sanitize resource name — strip characters that could break delimiters */
function sanitizeResourceName(name: string): string {
  return name.replace(/[\[\]\n\r]/g, "_").slice(0, 200);
}

/** Escape content to prevent delimiter spoofing */
function escapeResourceContent(content: string, name: string): string {
  const truncated = content.length > MAX_RESOURCE_CONTENT_LENGTH
    ? content.slice(0, MAX_RESOURCE_CONTENT_LENGTH) + "\n[... truncated at 64KB]"
    : content;
  return truncated.replaceAll(`[End Resource: ${name}]`, `[End Resource\\: ${name}]`);
}

/** Format resolved resources into labeled blocks for prompt injection. */
export function formatResourceBlocks(resources: Array<{ name: string; content: string }>): string {
  if (!resources || resources.length === 0) return "";
  const blocks = resources.map((r) => {
    const safeName = sanitizeResourceName(r.name);
    const safeContent = escapeResourceContent(r.content, safeName);
    return `[Resource: ${safeName}]\n${safeContent}\n[End Resource: ${safeName}]`;
  });
  return "\n\n" + blocks.join("\n\n");
}

// ---------------------------------------------------------------------------
// Tier resolution
// ---------------------------------------------------------------------------

/**
 * Map a numeric weight (1-10) to a tier by checking each tier's configured range.
 * If the weight doesn't fall into any range (shouldn't happen), defaults to 'sonnet'.
 */
export function resolveWeightToTier(
  weight: number,
  tiers: Record<Tier, TierConfig>,
): Tier {
  for (const [tier, config] of Object.entries(tiers) as [Tier, TierConfig][]) {
    const [min, max] = config.range;
    if (weight >= min && weight <= max) {
      return tier;
    }
  }
  // Defensive default — should never happen with a well-configured range
  return "sonnet";
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * Dispatch a pending job: resolve tier + model, render prompt, fire worker.
 *
 * This function is intentionally synchronous (non-async). It updates the job
 * status to `in_execution`, then fires `worker.run()` without awaiting it.
 * The worker handles its own success/failure lifecycle.
 */
export function dispatch(
  db: DatabaseSync,
  job: RouterJob,
  config: RouterConfig,
  executor?: AgentExecutor,
  /** Short evaluator-generated task summary for the token monitor Task column. */
  evaluatorSummary?: string,
): void {
  // 1. Resolve weight → tier
  const weight = job.weight ?? config.evaluator.fallback_weight;
  const tier = resolveWeightToTier(weight, config.tiers);

  // 2. Look up model for this tier
  const model = config.tiers[tier].model;

  // 3. Load and render the template
  const template = getTemplate(tier, job.type);

  // Parse payload — stored as JSON string in the DB
  const payload: { message?: string; context?: string; resources?: Array<{ name: string; content: string }> } =
    typeof job.payload === "string" ? JSON.parse(job.payload) : job.payload;

  let prompt = renderTemplate(template, {
    task: payload.message ?? "",
    context: payload.context ?? "",
    issuer: job.issuer,
    constraints: "",
  });

  // Append resource blocks to the prompt if present
  if (payload.resources && payload.resources.length > 0) {
    prompt += formatResourceBlocks(payload.resources);
  }

  // 4. Update job: set tier, transition to in_execution
  updateJob(db, job.id, {
    tier,
    status: "in_execution",
  });

  // 5. Fire-and-forget — worker manages its own lifecycle.
  //    Executor runs in isolated router-executor session — no parent context.
  // Prefer evaluator-generated summary over raw truncated text
  const taskLabel = evaluatorSummary || (payload.message ?? "").slice(0, 60);
  void run(db, job.id, prompt, model, executor, taskLabel, weight);
}
