import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { initBus } from "../bus.js";
import {
  initSessionTables,
  getCortexSessionKey,
  appendToSession,
  appendResponse,
  getSessionHistory,
  updateChannelState,
  getChannelStates,
  addPendingOp,
  removePendingOp,
  getPendingOps,
  completePendingOp,
  failPendingOp,
  getCompletedOps,
  markOpsGardened,
  archiveOldGardenedOps,
  acknowledgeCompletedOps,
} from "../session.js";
import { createEnvelope, type CortexOutput, type PendingOperation } from "../types.js";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let db: DatabaseSync;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-session-test-"));
  db = initBus(path.join(tmpDir, "bus.sqlite"));
  initSessionTables(db);
});

afterEach(() => {
  try { db.close(); } catch { /* */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeEnvelope(channel = "webchat", content = "test", senderId = "serj") {
  return createEnvelope({
    channel,
    sender: { id: senderId, name: senderId === "serj" ? "Serj" : senderId, relationship: "partner" },
    content,
    timestamp: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// getCortexSessionKey
// ---------------------------------------------------------------------------

describe("getCortexSessionKey", () => {
  it("returns agent:main:cortex format", () => {
    expect(getCortexSessionKey("main")).toBe("agent:main:cortex");
  });

  it("returns same key on repeated calls (singleton)", () => {
    expect(getCortexSessionKey("main")).toBe(getCortexSessionKey("main"));
  });

  it("different agent ID → different key", () => {
    expect(getCortexSessionKey("main")).not.toBe(getCortexSessionKey("other"));
  });
});

// ---------------------------------------------------------------------------
// appendToSession / getSessionHistory
// ---------------------------------------------------------------------------

describe("appendToSession", () => {
  it("stores message with envelope metadata", () => {
    const env = makeEnvelope("webchat", "hello cortex");
    appendToSession(db, env);

    const history = getSessionHistory(db);
    expect(history).toHaveLength(1);
    expect(history[0].content).toBe("hello cortex");
    expect(history[0].channel).toBe("webchat");
    expect(history[0].senderId).toBe("serj");
    expect(history[0].role).toBe("user");
    expect(history[0].envelopeId).toBe(env.id);
  });

  it("stores messages from multiple channels in one session", () => {
    appendToSession(db, makeEnvelope("webchat", "msg 1"));
    appendToSession(db, makeEnvelope("whatsapp", "msg 2"));
    appendToSession(db, makeEnvelope("telegram", "msg 3"));

    const history = getSessionHistory(db);
    expect(history).toHaveLength(3);
    expect(history.map((m) => m.channel)).toEqual(["webchat", "whatsapp", "telegram"]);
  });
});

describe("appendResponse", () => {
  it("stores Cortex output linked to input envelope", () => {
    const env = makeEnvelope("webchat", "what time is it?");
    appendToSession(db, env);

    const output: CortexOutput = {
      targets: [{ channel: "webchat", content: "It's 15:00" }],
    };
    appendResponse(db, output, env.id);

    const history = getSessionHistory(db);
    expect(history).toHaveLength(2);
    expect(history[1].role).toBe("assistant");
    expect(history[1].content).toBe("It's 15:00");
    expect(history[1].envelopeId).toBe(env.id);
  });

  it("stores silence as [silence] when no targets", () => {
    const env = makeEnvelope("cron", "heartbeat");
    appendToSession(db, env);

    const output: CortexOutput = { targets: [] };
    appendResponse(db, output, env.id);

    const history = getSessionHistory(db);
    expect(history).toHaveLength(2);
    expect(history[1].content).toBe("[silence]");
  });

  it("stores multi-channel output as separate entries", () => {
    const env = makeEnvelope("cron", "alert trigger");
    appendToSession(db, env);

    const output: CortexOutput = {
      targets: [
        { channel: "whatsapp", content: "Alert!" },
        { channel: "webchat", content: "Alert!" },
      ],
    };
    appendResponse(db, output, env.id);

    const history = getSessionHistory(db);
    expect(history).toHaveLength(3); // 1 input + 2 outputs
  });
});

describe("getSessionHistory", () => {
  it("returns all channels by default, ordered by timestamp", () => {
    appendToSession(db, makeEnvelope("webchat", "first"));
    appendToSession(db, makeEnvelope("whatsapp", "second"));
    appendToSession(db, makeEnvelope("telegram", "third"));

    const history = getSessionHistory(db);
    expect(history).toHaveLength(3);
    expect(history[0].content).toBe("first");
    expect(history[2].content).toBe("third");
  });

  it("filters by channel when specified", () => {
    appendToSession(db, makeEnvelope("webchat", "web msg"));
    appendToSession(db, makeEnvelope("whatsapp", "wa msg"));
    appendToSession(db, makeEnvelope("webchat", "web msg 2"));

    const webOnly = getSessionHistory(db, { channel: "webchat" });
    expect(webOnly).toHaveLength(2);
    expect(webOnly.every((m) => m.channel === "webchat")).toBe(true);
  });

  it("respects limit", () => {
    for (let i = 0; i < 10; i++) {
      appendToSession(db, makeEnvelope("webchat", `msg ${i}`));
    }

    const limited = getSessionHistory(db, { limit: 3 });
    expect(limited).toHaveLength(3);
  });

  it("returns empty array for new session", () => {
    expect(getSessionHistory(db)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Channel States
// ---------------------------------------------------------------------------

describe("updateChannelState / getChannelStates", () => {
  it("creates channel state entry", () => {
    updateChannelState(db, "webchat", {
      lastMessageAt: "2026-02-26T15:00:00Z",
      unreadCount: 0,
      layer: "foreground",
    });

    const states = getChannelStates(db);
    expect(states).toHaveLength(1);
    expect(states[0].channel).toBe("webchat");
    expect(states[0].layer).toBe("foreground");
  });

  it("updates existing channel state", () => {
    updateChannelState(db, "webchat", { lastMessageAt: "2026-02-26T15:00:00Z", layer: "foreground" });
    updateChannelState(db, "webchat", { layer: "background", summary: "5 messages, routine chat" });

    const states = getChannelStates(db);
    expect(states).toHaveLength(1);
    expect(states[0].layer).toBe("background");
    expect(states[0].summary).toBe("5 messages, routine chat");
  });

  it("tracks multiple channels", () => {
    updateChannelState(db, "webchat", { lastMessageAt: "2026-02-26T15:00:00Z", layer: "foreground" });
    updateChannelState(db, "whatsapp", { lastMessageAt: "2026-02-26T14:00:00Z", layer: "background" });
    updateChannelState(db, "telegram", { lastMessageAt: "2026-02-26T10:00:00Z", layer: "archived" });

    const states = getChannelStates(db);
    expect(states).toHaveLength(3);
  });

  it("layer transitions: archived → background → foreground", () => {
    updateChannelState(db, "webchat", { lastMessageAt: "2026-02-26T10:00:00Z", layer: "archived" });
    expect(getChannelStates(db)[0].layer).toBe("archived");

    updateChannelState(db, "webchat", { layer: "background" });
    expect(getChannelStates(db)[0].layer).toBe("background");

    updateChannelState(db, "webchat", { layer: "foreground" });
    expect(getChannelStates(db)[0].layer).toBe("foreground");
  });
});

// ---------------------------------------------------------------------------
// Pending Operations
// ---------------------------------------------------------------------------

describe("addPendingOp / removePendingOp / getPendingOps", () => {
  const op1: PendingOperation = {
    id: "job-1",
    type: "router_job",
    description: "Analyze code complexity",
    dispatchedAt: "2026-02-26T15:00:00Z",
    expectedChannel: "router",
    status: "pending",
  };

  const op2: PendingOperation = {
    id: "sa-1",
    type: "subagent",
    description: "Research weather API",
    dispatchedAt: "2026-02-26T15:01:00Z",
    expectedChannel: "subagent",
    status: "pending",
  };

  it("adds and retrieves pending operations", () => {
    addPendingOp(db, op1);
    addPendingOp(db, op2);

    const ops = getPendingOps(db);
    expect(ops).toHaveLength(2);
    expect(ops[0].id).toBe("job-1");
    expect(ops[1].id).toBe("sa-1");
  });

  it("removes a pending operation", () => {
    addPendingOp(db, op1);
    addPendingOp(db, op2);
    removePendingOp(db, "job-1");

    const ops = getPendingOps(db);
    expect(ops).toHaveLength(1);
    expect(ops[0].id).toBe("sa-1");
  });

  it("returns empty array when no pending ops", () => {
    expect(getPendingOps(db)).toEqual([]);
  });

  it("upserts on duplicate id", () => {
    addPendingOp(db, op1);
    addPendingOp(db, { ...op1, description: "Updated description" });

    const ops = getPendingOps(db);
    expect(ops).toHaveLength(1);
    expect(ops[0].description).toBe("Updated description");
  });
});

// ---------------------------------------------------------------------------
// failPendingOp
// ---------------------------------------------------------------------------

describe("failPendingOp", () => {
  const op1: PendingOperation = {
    id: "job-fail-1",
    type: "router_job",
    description: "Failing task",
    dispatchedAt: "2026-02-26T15:00:00Z",
    expectedChannel: "router",
    status: "pending",
  };

  it("marks a pending op as failed but keeps it visible in getPendingOps", () => {
    addPendingOp(db, op1);
    expect(getPendingOps(db)).toHaveLength(1);

    failPendingOp(db, "job-fail-1", "dispatch exploded");

    // Failed ops stay visible (unacknowledged) so the LLM can inform the user
    const ops = getPendingOps(db);
    expect(ops).toHaveLength(1);
    expect(ops[0].status).toBe("failed");
    expect(ops[0].result).toBe("Error: dispatch exploded");
  });

  it("sets status to failed with error result, no acknowledged_at", () => {
    addPendingOp(db, op1);
    failPendingOp(db, "job-fail-1", "config missing tiers");

    const row = db.prepare(
      `SELECT status, result, acknowledged_at, completed_at FROM cortex_pending_ops WHERE id = ?`,
    ).get("job-fail-1") as { status: string; result: string; acknowledged_at: string | null; completed_at: string };

    expect(row.status).toBe("failed");
    expect(row.result).toBe("Error: config missing tiers");
    expect(row.acknowledged_at).toBeNull(); // stays visible until LLM acknowledges
    expect(row.completed_at).toBeTruthy();
  });

  it("failed ops drop from getPendingOps after acknowledgeCompletedOps", () => {
    addPendingOp(db, op1);
    failPendingOp(db, "job-fail-1", "boom");

    // Visible before acknowledgment
    expect(getPendingOps(db)).toHaveLength(1);

    // Acknowledge — same as completed ops, the LLM has now "read" the failure
    acknowledgeCompletedOps(db);

    // Gone after acknowledgment
    expect(getPendingOps(db)).toHaveLength(0);
  });

  it("only affects pending ops (does not overwrite completed ops)", () => {
    addPendingOp(db, op1);
    completePendingOp(db, "job-fail-1", "Real result");

    // Try to fail an already-completed op — should be a no-op (WHERE status = 'pending')
    failPendingOp(db, "job-fail-1", "should not overwrite");

    const row = db.prepare(
      `SELECT status, result FROM cortex_pending_ops WHERE id = ?`,
    ).get("job-fail-1") as { status: string; result: string };

    expect(row.status).toBe("completed");
    expect(row.result).toBe("Real result");
  });

  it("is a no-op for non-existent ops", () => {
    // Should not throw
    failPendingOp(db, "non-existent", "some error");
    expect(getPendingOps(db)).toHaveLength(0);
  });

  it("fails one op — both failed and pending ops stay visible", () => {
    addPendingOp(db, op1);
    addPendingOp(db, {
      id: "job-ok",
      type: "router_job",
      description: "OK task",
      dispatchedAt: "2026-02-26T15:01:00Z",
      expectedChannel: "router",
      status: "pending",
    });

    failPendingOp(db, "job-fail-1", "boom");

    // Both visible: one failed, one still pending
    const ops = getPendingOps(db);
    expect(ops).toHaveLength(2);
    expect(ops.find((o) => o.id === "job-fail-1")!.status).toBe("failed");
    expect(ops.find((o) => o.id === "job-ok")!.status).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// Session history round-trip
// ---------------------------------------------------------------------------

describe("session round-trip", () => {
  it("append → get → content matches across channels", () => {
    const envWeb = makeEnvelope("webchat", "from webchat");
    const envWa = makeEnvelope("whatsapp", "from whatsapp");

    appendToSession(db, envWeb);
    appendToSession(db, envWa);

    const output: CortexOutput = {
      targets: [{ channel: "webchat", content: "reply to webchat" }],
    };
    appendResponse(db, output, envWeb.id);

    const history = getSessionHistory(db);
    expect(history).toHaveLength(3);
    expect(history[0].content).toBe("from webchat");
    expect(history[0].channel).toBe("webchat");
    expect(history[1].content).toBe("from whatsapp");
    expect(history[1].channel).toBe("whatsapp");
    expect(history[2].content).toBe("reply to webchat");
    expect(history[2].role).toBe("assistant");
  });
});
