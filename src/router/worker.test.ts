import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { DatabaseSync } from "node:sqlite";
import type { AgentExecutor } from "./worker.js";

// ---------------------------------------------------------------------------
// Mock queue operations — avoid real SQLite in unit tests
// ---------------------------------------------------------------------------

const mockUpdateJob = vi.fn();

vi.mock("./queue.js", () => ({
  updateJob: (...args: unknown[]) => mockUpdateJob(...args),
}));

// ---------------------------------------------------------------------------
// Import the module under test (after mocks are registered)
// ---------------------------------------------------------------------------

import { run, routerEvents } from "./worker.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A fake DatabaseSync — we never call real SQL, the mock intercepts updateJob. */
const fakeDb = {} as DatabaseSync;

const TEST_JOB_ID = "job-test-001";
const TEST_PROMPT = "What is 2+2?";
const TEST_MODEL = "anthropic/claude-haiku-4-5";

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("worker", () => {
  let mockExecutor: AgentExecutor & ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    routerEvents.removeAllListeners();
    mockExecutor = vi.fn<AgentExecutor>().mockResolvedValue("Agent response OK");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // -----------------------------------------------------------------------
  // 1. started_at is set when worker begins
  // -----------------------------------------------------------------------

  it("sets started_at and last_checkpoint when worker begins", async () => {
    await run(fakeDb, TEST_JOB_ID, TEST_PROMPT, TEST_MODEL, mockExecutor);

    // First updateJob call sets started_at and last_checkpoint
    expect(mockUpdateJob).toHaveBeenCalledWith(
      fakeDb,
      TEST_JOB_ID,
      expect.objectContaining({
        started_at: expect.any(String),
        last_checkpoint: expect.any(String),
      }),
    );
  });

  // -----------------------------------------------------------------------
  // 2. Successful execution → status 'completed', result stored, finished_at
  // -----------------------------------------------------------------------

  it("marks job as completed with result on success", async () => {
    mockExecutor.mockResolvedValue('{"answer":"4"}');

    await run(fakeDb, TEST_JOB_ID, TEST_PROMPT, TEST_MODEL, mockExecutor);

    // Last updateJob call should set completed status
    const lastCall = mockUpdateJob.mock.calls[mockUpdateJob.mock.calls.length - 1];
    expect(lastCall[1]).toBe(TEST_JOB_ID);
    expect(lastCall[2]).toMatchObject({
      status: "completed",
      result: '{"answer":"4"}',
      finished_at: expect.any(String),
    });
  });

  // -----------------------------------------------------------------------
  // 3. Failed execution → status 'failed', error stored, finished_at
  // -----------------------------------------------------------------------

  it("marks job as failed with error on failure", async () => {
    mockExecutor.mockRejectedValue(new Error("Agent crashed"));

    await run(fakeDb, TEST_JOB_ID, TEST_PROMPT, TEST_MODEL, mockExecutor);

    const lastCall = mockUpdateJob.mock.calls[mockUpdateJob.mock.calls.length - 1];
    expect(lastCall[1]).toBe(TEST_JOB_ID);
    expect(lastCall[2]).toMatchObject({
      status: "failed",
      error: "Agent crashed",
      finished_at: expect.any(String),
    });
  });

  // -----------------------------------------------------------------------
  // 4. Heartbeat timer starts and writes last_checkpoint
  // -----------------------------------------------------------------------

  it("heartbeat timer writes last_checkpoint every 30s", async () => {
    vi.useFakeTimers();

    // Make executor hang until we resolve it
    let resolveAgent!: (value: string) => void;
    const agentPromise = new Promise<string>((resolve) => {
      resolveAgent = resolve;
    });
    mockExecutor.mockReturnValue(agentPromise);

    const runPromise = run(fakeDb, TEST_JOB_ID, TEST_PROMPT, TEST_MODEL, mockExecutor);

    // First call: started_at + last_checkpoint
    expect(mockUpdateJob).toHaveBeenCalledTimes(1);

    // Advance 30s — heartbeat should fire
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mockUpdateJob).toHaveBeenCalledTimes(2);
    const heartbeatCall = mockUpdateJob.mock.calls[1];
    expect(heartbeatCall[1]).toBe(TEST_JOB_ID);
    expect(heartbeatCall[2]).toHaveProperty("last_checkpoint");
    // Should only have last_checkpoint, not status/result
    expect(heartbeatCall[2]).not.toHaveProperty("status");

    // Advance another 30s — second heartbeat
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mockUpdateJob).toHaveBeenCalledTimes(3);

    // Resolve the agent to let run() finish
    resolveAgent("done");
    await runPromise;
  });

  // -----------------------------------------------------------------------
  // 5. Heartbeat timer is cleared on success
  // -----------------------------------------------------------------------

  it("clears heartbeat timer on success (no more checkpoints after completion)", async () => {
    vi.useFakeTimers();

    mockExecutor.mockResolvedValue("OK");

    await run(fakeDb, TEST_JOB_ID, TEST_PROMPT, TEST_MODEL, mockExecutor);

    // After run completes: 1 (start) + 1 (completion) = 2 calls
    const callCountAfterRun = mockUpdateJob.mock.calls.length;
    expect(callCountAfterRun).toBe(2);

    // Advance 60s — no new heartbeats should fire
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockUpdateJob.mock.calls.length).toBe(callCountAfterRun);
  });

  // -----------------------------------------------------------------------
  // 6. Heartbeat timer is cleared on failure
  // -----------------------------------------------------------------------

  it("clears heartbeat timer on failure (no more checkpoints after failure)", async () => {
    vi.useFakeTimers();

    mockExecutor.mockRejectedValue(new Error("boom"));

    await run(fakeDb, TEST_JOB_ID, TEST_PROMPT, TEST_MODEL, mockExecutor);

    const callCountAfterRun = mockUpdateJob.mock.calls.length;
    expect(callCountAfterRun).toBe(2); // start + failure

    // Advance 60s — no new heartbeats should fire
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockUpdateJob.mock.calls.length).toBe(callCountAfterRun);
  });

  // -----------------------------------------------------------------------
  // 7. 'job:completed' event is emitted on success
  // -----------------------------------------------------------------------

  it("emits 'job:completed' event on success", async () => {
    const events: unknown[] = [];
    routerEvents.on("job:completed", (data) => events.push(data));

    await run(fakeDb, TEST_JOB_ID, TEST_PROMPT, TEST_MODEL, mockExecutor);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ jobId: TEST_JOB_ID });
  });

  // -----------------------------------------------------------------------
  // 8. 'job:failed' event is emitted on failure
  // -----------------------------------------------------------------------

  it("emits 'job:failed' event on failure", async () => {
    const events: unknown[] = [];
    routerEvents.on("job:failed", (data) => events.push(data));

    mockExecutor.mockRejectedValue(new Error("something went wrong"));

    await run(fakeDb, TEST_JOB_ID, TEST_PROMPT, TEST_MODEL, mockExecutor);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      jobId: TEST_JOB_ID,
      error: "something went wrong",
    });
  });

  // -----------------------------------------------------------------------
  // 9. Non-Error rejections are stringified
  // -----------------------------------------------------------------------

  it("handles non-Error rejection values", async () => {
    mockExecutor.mockRejectedValue("string error");

    await run(fakeDb, TEST_JOB_ID, TEST_PROMPT, TEST_MODEL, mockExecutor);

    const lastCall = mockUpdateJob.mock.calls[mockUpdateJob.mock.calls.length - 1];
    expect(lastCall[2]).toMatchObject({
      status: "failed",
      error: "string error",
    });
  });

  // -----------------------------------------------------------------------
  // 10. executeAgent receives the correct prompt and model
  // -----------------------------------------------------------------------

  it("passes prompt and model to executor", async () => {
    await run(fakeDb, TEST_JOB_ID, TEST_PROMPT, TEST_MODEL, mockExecutor);

    expect(mockExecutor).toHaveBeenCalledWith(TEST_PROMPT, TEST_MODEL);
  });

  // -----------------------------------------------------------------------
  // 11. No 'job:completed' event on failure
  // -----------------------------------------------------------------------

  it("does not emit 'job:completed' on failure", async () => {
    const completed: unknown[] = [];
    routerEvents.on("job:completed", (data) => completed.push(data));

    mockExecutor.mockRejectedValue(new Error("fail"));

    await run(fakeDb, TEST_JOB_ID, TEST_PROMPT, TEST_MODEL, mockExecutor);

    expect(completed).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // 12. No 'job:failed' event on success
  // -----------------------------------------------------------------------

  it("does not emit 'job:failed' on success", async () => {
    const failed: unknown[] = [];
    routerEvents.on("job:failed", (data) => failed.push(data));

    await run(fakeDb, TEST_JOB_ID, TEST_PROMPT, TEST_MODEL, mockExecutor);

    expect(failed).toHaveLength(0);
  });
});
