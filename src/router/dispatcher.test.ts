import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { DatabaseSync } from "node:sqlite";
import type { RouterConfig, RouterJob, Tier, TierConfig } from "./types.js";
import type { AgentExecutor } from "./worker.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockUpdateJob = vi.fn();
const mockRun = vi.fn();
const mockGetTemplate = vi.fn();
const mockRenderTemplate = vi.fn();

vi.mock("./queue.js", () => ({
  updateJob: (...args: unknown[]) => mockUpdateJob(...args),
}));

vi.mock("./worker.js", () => ({
  run: (...args: unknown[]) => mockRun(...args),
}));

vi.mock("./templates/index.js", () => ({
  getTemplate: (...args: unknown[]) => mockGetTemplate(...args),
  renderTemplate: (...args: unknown[]) => mockRenderTemplate(...args),
}));

// ---------------------------------------------------------------------------
// Import module under test (after mocks)
// ---------------------------------------------------------------------------

import { resolveWeightToTier, dispatch } from "./dispatcher.js";

// ---------------------------------------------------------------------------
// Shared config
// ---------------------------------------------------------------------------

const TEST_TIERS: Record<Tier, TierConfig> = {
  haiku: { range: [1, 3], model: "anthropic/claude-haiku-4-5" },
  sonnet: { range: [4, 7], model: "anthropic/claude-sonnet-4-6" },
  opus: { range: [8, 10], model: "anthropic/claude-opus-4-6" },
};

const TEST_CONFIG: RouterConfig = {
  enabled: true,
  evaluator: {
    model: "anthropic/claude-sonnet-4-6",
    tier: "sonnet",
    timeout: 10,
    fallback_weight: 5,
  },
  tiers: TEST_TIERS,
};

function makeJob(overrides: Partial<RouterJob> = {}): RouterJob {
  return {
    id: "job-001",
    type: "agent_run",
    status: "pending",
    weight: 5,
    tier: null,
    issuer: "session:test",
    payload: JSON.stringify({ message: "What is 2+2?", context: "math test" }),
    result: null,
    error: null,
    retry_count: 0,
    worker_id: null,
    last_checkpoint: null,
    checkpoint_data: null,
    created_at: "2026-02-26 00:00:00",
    updated_at: "2026-02-26 00:00:00",
    started_at: null,
    finished_at: null,
    delivered_at: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests: resolveWeightToTier
// ---------------------------------------------------------------------------

describe("resolveWeightToTier", () => {
  it("weight 1 → haiku", () => {
    expect(resolveWeightToTier(1, TEST_TIERS)).toBe("haiku");
  });

  it("weight 3 → haiku", () => {
    expect(resolveWeightToTier(3, TEST_TIERS)).toBe("haiku");
  });

  it("weight 4 → sonnet", () => {
    expect(resolveWeightToTier(4, TEST_TIERS)).toBe("sonnet");
  });

  it("weight 7 → sonnet", () => {
    expect(resolveWeightToTier(7, TEST_TIERS)).toBe("sonnet");
  });

  it("weight 8 → opus", () => {
    expect(resolveWeightToTier(8, TEST_TIERS)).toBe("opus");
  });

  it("weight 10 → opus", () => {
    expect(resolveWeightToTier(10, TEST_TIERS)).toBe("opus");
  });

  it("out-of-range weight defaults to sonnet", () => {
    expect(resolveWeightToTier(0, TEST_TIERS)).toBe("sonnet");
    expect(resolveWeightToTier(11, TEST_TIERS)).toBe("sonnet");
    expect(resolveWeightToTier(-5, TEST_TIERS)).toBe("sonnet");
  });
});

// ---------------------------------------------------------------------------
// Tests: dispatch
// ---------------------------------------------------------------------------

describe("dispatch", () => {
  const fakeDb = {} as DatabaseSync;
  let mockExecutor: AgentExecutor & ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecutor = vi.fn<AgentExecutor>().mockResolvedValue("OK");
    mockGetTemplate.mockReturnValue("Template: {task} | {context} | {issuer} | {constraints}");
    mockRenderTemplate.mockReturnValue("Rendered prompt content");
    mockRun.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("updates job tier and status to in_execution", () => {
    const job = makeJob({ weight: 5 });

    dispatch(fakeDb, job, TEST_CONFIG, mockExecutor);

    expect(mockUpdateJob).toHaveBeenCalledWith(fakeDb, "job-001", {
      tier: "sonnet",
      status: "in_execution",
    });
  });

  it("calls worker.run with correct prompt and model", () => {
    const job = makeJob({ weight: 5 });

    dispatch(fakeDb, job, TEST_CONFIG, mockExecutor);

    expect(mockRun).toHaveBeenCalledWith(
      fakeDb,
      "job-001",
      "Rendered prompt content",
      "anthropic/claude-sonnet-4-6",
      mockExecutor,
    );
  });

  it("renders template with job payload variables", () => {
    const job = makeJob({
      weight: 2,
      payload: JSON.stringify({ message: "Build a REST API", context: "Node.js project" }),
      issuer: "session:user123",
    });

    dispatch(fakeDb, job, TEST_CONFIG, mockExecutor);

    // getTemplate called with resolved tier and job type
    expect(mockGetTemplate).toHaveBeenCalledWith("haiku", "agent_run");

    // renderTemplate called with parsed payload variables
    expect(mockRenderTemplate).toHaveBeenCalledWith(
      "Template: {task} | {context} | {issuer} | {constraints}",
      {
        task: "Build a REST API",
        context: "Node.js project",
        issuer: "session:user123",
        constraints: "",
      },
    );
  });

  it("uses the correct tier model from config", () => {
    // Haiku tier (weight 1)
    dispatch(fakeDb, makeJob({ weight: 1 }), TEST_CONFIG, mockExecutor);
    expect(mockRun).toHaveBeenCalledWith(
      fakeDb,
      "job-001",
      expect.any(String),
      "anthropic/claude-haiku-4-5",
      mockExecutor,
    );

    vi.clearAllMocks();
    mockGetTemplate.mockReturnValue("template");
    mockRenderTemplate.mockReturnValue("prompt");

    // Opus tier (weight 9)
    dispatch(fakeDb, makeJob({ weight: 9 }), TEST_CONFIG, mockExecutor);
    expect(mockRun).toHaveBeenCalledWith(
      fakeDb,
      "job-001",
      expect.any(String),
      "anthropic/claude-opus-4-6",
      mockExecutor,
    );
  });

  it("uses fallback weight when job.weight is null", () => {
    const job = makeJob({ weight: null });

    dispatch(fakeDb, job, TEST_CONFIG, mockExecutor);

    // fallback_weight is 5 → sonnet tier
    expect(mockUpdateJob).toHaveBeenCalledWith(fakeDb, "job-001", {
      tier: "sonnet",
      status: "in_execution",
    });
  });

  it("handles payload with missing context gracefully", () => {
    const job = makeJob({
      weight: 4,
      payload: JSON.stringify({ message: "Hello" }),
    });

    dispatch(fakeDb, job, TEST_CONFIG, mockExecutor);

    expect(mockRenderTemplate).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        task: "Hello",
        context: "",
        constraints: "",
      }),
    );
  });

  it("does not await worker.run (fire-and-forget)", () => {
    // If dispatch were async and awaited, this would hang or throw.
    // Since it's fire-and-forget, dispatch returns immediately.
    const job = makeJob({ weight: 5 });

    // Make run return a never-resolving promise
    mockRun.mockReturnValue(new Promise(() => {}));

    // This should return immediately without blocking
    dispatch(fakeDb, job, TEST_CONFIG, mockExecutor);

    expect(mockRun).toHaveBeenCalledTimes(1);
  });
});
