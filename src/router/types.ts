export type JobStatus =
  | "in_queue"
  | "evaluating"
  | "pending"
  | "in_execution"
  | "completed"
  | "failed"
  | "canceled";

export type JobType = "agent_run";

export type Tier = "haiku" | "sonnet" | "opus";

export interface RouterJob {
  id: string;
  type: JobType;
  status: JobStatus;
  weight: number | null;
  tier: Tier | null;
  issuer: string;
  payload: string;
  result: string | null;
  error: string | null;
  retry_count: number;
  worker_id: string | null;
  last_checkpoint: string | null;
  checkpoint_data: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  delivered_at: string | null;
}

export interface ArchivedJob extends RouterJob {
  archived_at: string;
}

export interface EvaluatorResult {
  weight: number;
  reasoning: string;
}

export interface TierConfig {
  range: [number, number];
  model: string;
}

export interface EvaluatorConfig {
  model: string;
  tier: Tier;
  timeout: number;
  fallback_weight: number;
}

export interface RouterConfig {
  enabled: boolean;
  evaluator: EvaluatorConfig;
  tiers: Record<Tier, TierConfig>;
}
