import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { initBus, enqueue, markProcessing, markCompleted, checkpoint } from "../bus.js";
import { initSessionTables, addPendingOp, updateChannelState } from "../session.js";
import { recoverState, resetStalledMessages, repairBusState } from "../recovery.js";
import { createEnvelope } from "../types.js";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let db: DatabaseSync;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-recovery-test-"));
  db = initBus(path.join(tmpDir, "bus.sqlite"));
  initSessionTables(db);
});

afterEach(() => {
  try { db.close(); } catch { /* */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeEnvelope(content = "test") {
  return createEnvelope({
    channel: "webchat",
    sender: { id: "serj", name: "Serj", relationship: "partner" },
    content,
  });
}

// ---------------------------------------------------------------------------
// recoverState
// ---------------------------------------------------------------------------

describe("recoverState", () => {
  it("loads latest checkpoint", () => {
    checkpoint(db, {
      createdAt: "2026-02-26T15:00:00Z",
      sessionSnapshot: "latest state",
      channelStates: [],
      pendingOps: [],
    });

    const result = recoverState(db);
    expect(result.checkpoint).not.toBeNull();
    expect(result.checkpoint!.sessionSnapshot).toBe("latest state");
  });

  it("finds unprocessed pending messages", () => {
    enqueue(db, makeEnvelope("pending 1"));
    enqueue(db, makeEnvelope("pending 2"));

    const result = recoverState(db);
    expect(result.unprocessedMessages).toHaveLength(2);
  });

  it("identifies stalled (processing-state) messages", () => {
    const env = makeEnvelope("stalled");
    enqueue(db, env);
    markProcessing(db, env.id);

    const result = recoverState(db);
    expect(result.stalledMessages).toHaveLength(1);
    expect(result.stalledMessages[0].envelope.content).toBe("stalled");
  });

  it("returns null checkpoint when none exist", () => {
    const result = recoverState(db);
    expect(result.checkpoint).toBeNull();
  });

  it("includes channel states", () => {
    updateChannelState(db, "webchat", { lastMessageAt: "2026-02-26T15:00:00Z", layer: "foreground" });
    const result = recoverState(db);
    expect(result.channelStates).toHaveLength(1);
    expect(result.channelStates[0].channel).toBe("webchat");
  });

  it("includes pending operations", () => {
    addPendingOp(db, {
      id: "job-1",
      type: "router_job",
      description: "test job",
      dispatchedAt: "2026-02-26T15:00:00Z",
      expectedChannel: "router",
      status: "pending",
    });
    const result = recoverState(db);
    expect(result.pendingOps).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// resetStalledMessages
// ---------------------------------------------------------------------------

describe("resetStalledMessages", () => {
  it("transitions processing → pending", () => {
    const env = makeEnvelope("stalled");
    enqueue(db, env);
    markProcessing(db, env.id);

    const count = resetStalledMessages(db);
    expect(count).toBe(1);

    const row = db.prepare("SELECT state FROM cortex_bus WHERE id = ?").get(env.id) as { state: string };
    expect(row.state).toBe("pending");
  });

  it("returns count of reset messages", () => {
    const a = makeEnvelope("a");
    const b = makeEnvelope("b");
    enqueue(db, a);
    enqueue(db, b);
    markProcessing(db, a.id);
    markProcessing(db, b.id);

    expect(resetStalledMessages(db)).toBe(2);
  });

  it("does not affect pending or completed messages", () => {
    const pending = makeEnvelope("pending");
    const completed = makeEnvelope("completed");
    enqueue(db, pending);
    enqueue(db, completed);
    markProcessing(db, completed.id);
    markCompleted(db, completed.id);

    expect(resetStalledMessages(db)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// repairBusState
// ---------------------------------------------------------------------------

describe("repairBusState", () => {
  it("resets stalled and checks integrity", () => {
    const env = makeEnvelope("stalled");
    enqueue(db, env);
    markProcessing(db, env.id);

    const report = repairBusState(db);
    expect(report.stalledReset).toBe(1);
    expect(report.checksumValid).toBe(true);
    expect(report.orphansRemoved).toBe(0);
  });

  it("removes orphans with invalid state", () => {
    const env = makeEnvelope("orphan");
    enqueue(db, env);
    // Force invalid state
    db.prepare("UPDATE cortex_bus SET state = 'invalid_state' WHERE id = ?").run(env.id);

    const report = repairBusState(db);
    expect(report.orphansRemoved).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Full recovery cycle
// ---------------------------------------------------------------------------

describe("full recovery cycle", () => {
  it("enqueue 3 → process 1 → crash → recover → 1 stalled + 2 pending", () => {
    const a = makeEnvelope("a");
    const b = makeEnvelope("b");
    const c = makeEnvelope("c");

    enqueue(db, a);
    enqueue(db, b);
    enqueue(db, c);

    // Process a, start processing b (simulating crash mid-b)
    markProcessing(db, a.id);
    markCompleted(db, a.id);
    markProcessing(db, b.id);
    // "Crash" — b is stuck in processing

    const result = recoverState(db);
    expect(result.stalledMessages).toHaveLength(1);
    expect(result.stalledMessages[0].envelope.content).toBe("b");
    expect(result.unprocessedMessages).toHaveLength(1); // c is pending
    expect(result.unprocessedMessages[0].envelope.content).toBe("c");
  });

  it("empty DB on first start → clean initialization", () => {
    const result = recoverState(db);
    expect(result.checkpoint).toBeNull();
    expect(result.unprocessedMessages).toHaveLength(0);
    expect(result.stalledMessages).toHaveLength(0);
    expect(result.channelStates).toHaveLength(0);
    expect(result.pendingOps).toHaveLength(0);
  });

  it("checkpoint ordering: returns most recent", () => {
    checkpoint(db, {
      createdAt: "2026-02-26T14:00:00Z",
      sessionSnapshot: "old",
      channelStates: [],
      pendingOps: [],
    });
    checkpoint(db, {
      createdAt: "2026-02-26T15:00:00Z",
      sessionSnapshot: "new",
      channelStates: [],
      pendingOps: [],
    });

    const result = recoverState(db);
    expect(result.checkpoint!.sessionSnapshot).toBe("new");
  });
});
