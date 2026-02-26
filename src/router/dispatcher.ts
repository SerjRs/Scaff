import type { DatabaseSync } from "node:sqlite";
import { updateJob } from "./queue.js";
import { getTemplate, renderTemplate } from "./templates/index.js";
import { run, type AgentExecutor } from "./worker.js";
import type { RouterConfig, RouterJob, Tier, TierConfig } from "./types.js";

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
): void {
  // 1. Resolve weight → tier
  const weight = job.weight ?? config.evaluator.fallback_weight;
  const tier = resolveWeightToTier(weight, config.tiers);

  // 2. Look up model for this tier
  const model = config.tiers[tier].model;

  // 3. Load and render the template
  const template = getTemplate(tier, job.type);

  // Parse payload — stored as JSON string in the DB
  const payload: { message?: string; context?: string } =
    typeof job.payload === "string" ? JSON.parse(job.payload) : job.payload;

  const prompt = renderTemplate(template, {
    task: payload.message ?? "",
    context: payload.context ?? "",
    issuer: job.issuer,
    constraints: "",
  });

  // 4. Update job: set tier, transition to in_execution
  updateJob(db, job.id, {
    tier,
    status: "in_execution",
  });

  // 5. Fire-and-forget — worker manages its own lifecycle.
  //    Executor runs in isolated router-executor session — no parent context.
  void run(db, job.id, prompt, model, executor);
}
