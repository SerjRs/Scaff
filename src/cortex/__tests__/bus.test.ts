import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  initBus,
  enqueue,
  dequeueNext,
  peekPending,
  markProcessing,
  markCompleted,
  markFailed,
  countPending,
  checkpoint,
  loadLatestCheckpoint,
  purgeCompleted,
} from "../bus.js";
import { createEnvelope, type CortexEnvelope, type Sender } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let db: DatabaseSync;
let tmpDir: string;

function makeSender(overrides: Partial<Sender> = {}): Sender {
  return { id: "serj", name: "Serj", relationship: "partner", ...overrides };
}

function makeEnvelope(overrides: Partial<CortexEnvelope> = {}): CortexEnvelope {
  return createEnvelope({
    channel: "webchat",
    sender: makeSender(),
    content: "test message",
    ...overrides,
  });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-bus-test-"));
  db = initBus(path.join(tmpDir, "bus.sqlite"));
});

afterEach(() => {
  try {
    db.close();
  } catch { /* already closed in some tests */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// initBus
// ---------------------------------------------------------------------------

describe("initBus", () => {
  it("creates database file and tables", () => {
    expect(fs.existsSync(path.join(tmpDir, "bus.sqlite"))).toBe(true);
    // Verify tables exist by querying them
    const busCount = db.prepare("SELECT COUNT(*) as cnt FROM cortex_bus").get() as { cnt: number };
    expect(busCount.cnt).toBe(0);
    const cpCount = db.prepare("SELECT COUNT(*) as cnt FROM cortex_checkpoints").get() as { cnt: number };
    expect(cpCount.cnt).toBe(0);
  });

  it("creates parent directories if they don't exist", () => {
    const nested = path.join(tmpDir, "deep", "nested", "bus.sqlite");
    const db2 = initBus(nested);
    expect(fs.existsSync(nested)).toBe(true);
    db2.close();
  });
});

// ---------------------------------------------------------------------------
// enqueue
// ---------------------------------------------------------------------------

describe("enqueue", () => {
  it("stores envelope and returns id", () => {
    const env = makeEnvelope();
    const id = enqueue(db, env);
    expect(id).toBe(env.id);
    expect(countPending(db)).toBe(1);
  });

  it("stores multiple envelopes", () => {
    enqueue(db, makeEnvelope());
    enqueue(db, makeEnvelope());
    enqueue(db, makeEnvelope());
    expect(countPending(db)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// dequeueNext
// ---------------------------------------------------------------------------

describe("dequeueNext", () => {
  it("returns null on empty queue", () => {
    expect(dequeueNext(db)).toBeNull();
  });

  it("returns highest-priority message first", () => {
    const bg = makeEnvelope({ content: "background", priority: "background" });
    const normal = makeEnvelope({ content: "normal", priority: "normal" });
    const urgent = makeEnvelope({ content: "urgent", priority: "urgent" });

    // Enqueue in reverse priority order
    enqueue(db, bg);
    enqueue(db, normal);
    enqueue(db, urgent);

    const first = dequeueNext(db);
    expect(first?.envelope.content).toBe("urgent");
  });

  it("returns FIFO within same priority tier", () => {
    const first = makeEnvelope({ content: "first", priority: "normal" });
    const second = makeEnvelope({ content: "second", priority: "normal" });
    const third = makeEnvelope({ content: "third", priority: "normal" });

    enqueue(db, first);
    enqueue(db, second);
    enqueue(db, third);

    const dequeued = dequeueNext(db);
    expect(dequeued?.envelope.content).toBe("first");
  });

  it("priority ordering: urgent before normal before background", () => {
    enqueue(db, makeEnvelope({ content: "bg", priority: "background" }));
    enqueue(db, makeEnvelope({ content: "urgent", priority: "urgent" }));
    enqueue(db, makeEnvelope({ content: "normal", priority: "normal" }));

    // Dequeue all by processing each
    const results: string[] = [];
    for (let i = 0; i < 3; i++) {
      const msg = dequeueNext(db);
      if (msg) {
        results.push(msg.envelope.content);
        markProcessing(db, msg.envelope.id);
        markCompleted(db, msg.envelope.id);
      }
    }
    expect(results).toEqual(["urgent", "normal", "bg"]);
  });

  it("skips messages in processing state", () => {
    const first = makeEnvelope({ content: "first" });
    const second = makeEnvelope({ content: "second" });

    enqueue(db, first);
    enqueue(db, second);

    // Mark first as processing
    markProcessing(db, first.id);

    // Dequeue should return second
    const next = dequeueNext(db);
    expect(next?.envelope.content).toBe("second");
  });
});

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------

describe("markProcessing", () => {
  it("transitions pending → processing and increments attempts", () => {
    const env = makeEnvelope();
    enqueue(db, env);
    markProcessing(db, env.id);

    const row = db.prepare("SELECT state, attempts FROM cortex_bus WHERE id = ?").get(env.id) as { state: string; attempts: number };
    expect(row.state).toBe("processing");
    expect(row.attempts).toBe(1);
  });
});

describe("markCompleted", () => {
  it("transitions processing → completed with timestamp", () => {
    const env = makeEnvelope();
    enqueue(db, env);
    markProcessing(db, env.id);
    markCompleted(db, env.id);

    const row = db.prepare("SELECT state, processed_at FROM cortex_bus WHERE id = ?").get(env.id) as { state: string; processed_at: string };
    expect(row.state).toBe("completed");
    expect(row.processed_at).toBeDefined();
  });
});

describe("markFailed", () => {
  it("transitions processing → failed with error message", () => {
    const env = makeEnvelope();
    enqueue(db, env);
    markProcessing(db, env.id);
    markFailed(db, env.id, "LLM timeout");

    const row = db.prepare("SELECT state, error FROM cortex_bus WHERE id = ?").get(env.id) as { state: string; error: string };
    expect(row.state).toBe("failed");
    expect(row.error).toBe("LLM timeout");
  });
});

// ---------------------------------------------------------------------------
// peekPending
// ---------------------------------------------------------------------------

describe("peekPending", () => {
  it("returns all pending messages in priority order", () => {
    enqueue(db, makeEnvelope({ content: "bg", priority: "background" }));
    enqueue(db, makeEnvelope({ content: "urgent", priority: "urgent" }));
    enqueue(db, makeEnvelope({ content: "normal", priority: "normal" }));

    const pending = peekPending(db);
    expect(pending).toHaveLength(3);
    expect(pending[0].envelope.content).toBe("urgent");
    expect(pending[1].envelope.content).toBe("normal");
    expect(pending[2].envelope.content).toBe("bg");
  });

  it("returns empty array when no pending messages", () => {
    expect(peekPending(db)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// countPending
// ---------------------------------------------------------------------------

describe("countPending", () => {
  it("returns accurate count after mixed operations", () => {
    const a = makeEnvelope({ content: "a" });
    const b = makeEnvelope({ content: "b" });
    const c = makeEnvelope({ content: "c" });

    enqueue(db, a);
    enqueue(db, b);
    enqueue(db, c);
    expect(countPending(db)).toBe(3);

    markProcessing(db, a.id);
    expect(countPending(db)).toBe(2);

    markCompleted(db, a.id);
    expect(countPending(db)).toBe(2);

    markProcessing(db, b.id);
    markFailed(db, b.id, "error");
    expect(countPending(db)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Envelope round-trip
// ---------------------------------------------------------------------------

describe("envelope round-trip", () => {
  it("enqueue → dequeue preserves envelope content", () => {
    const env = makeEnvelope({
      content: "Hello Cortex",
      priority: "urgent",
      attachments: [{ type: "image", url: "https://example.com/pic.jpg" }],
      metadata: { key: "value" },
    });

    enqueue(db, env);
    const dequeued = dequeueNext(db);

    expect(dequeued).not.toBeNull();
    expect(dequeued!.envelope.id).toBe(env.id);
    expect(dequeued!.envelope.content).toBe("Hello Cortex");
    expect(dequeued!.envelope.channel).toBe("webchat");
    expect(dequeued!.envelope.sender).toEqual(env.sender);
    expect(dequeued!.envelope.priority).toBe("urgent");
    expect(dequeued!.envelope.attachments).toEqual(env.attachments);
    expect(dequeued!.envelope.metadata).toEqual({ key: "value" });
    expect(dequeued!.state).toBe("pending");
    expect(dequeued!.attempts).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Checkpoints
// ---------------------------------------------------------------------------

describe("checkpoint", () => {
  it("stores and retrieves checkpoint data", () => {
    const data = {
      createdAt: new Date().toISOString(),
      sessionSnapshot: "Last discussed Cortex architecture",
      channelStates: [
        { channel: "webchat", lastMessageAt: new Date().toISOString(), unreadCount: 0, layer: "foreground" as const },
      ],
      pendingOps: [
        { id: "job-1", type: "router_job" as const, description: "Analyze code", dispatchedAt: new Date().toISOString(), expectedChannel: "router", status: "pending" as const },
      ],
    };

    const id = checkpoint(db, data);
    expect(id).toBeGreaterThan(0);

    const loaded = loadLatestCheckpoint(db);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(id);
    expect(loaded!.sessionSnapshot).toBe(data.sessionSnapshot);
    expect(loaded!.channelStates).toEqual(data.channelStates);
    expect(loaded!.pendingOps).toEqual(data.pendingOps);
  });

  it("returns most recent checkpoint", () => {
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

    const loaded = loadLatestCheckpoint(db);
    expect(loaded!.sessionSnapshot).toBe("new");
  });

  it("returns null when no checkpoints exist", () => {
    expect(loadLatestCheckpoint(db)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// purgeCompleted
// ---------------------------------------------------------------------------

describe("purgeCompleted", () => {
  it("removes completed messages older than threshold", () => {
    const old = makeEnvelope({ content: "old" });
    const recent = makeEnvelope({ content: "recent" });
    const pending = makeEnvelope({ content: "pending" });

    enqueue(db, old);
    enqueue(db, recent);
    enqueue(db, pending);

    // Complete old and recent
    markProcessing(db, old.id);
    markCompleted(db, old.id);
    // Backdate the old one
    db.prepare("UPDATE cortex_bus SET processed_at = '2026-02-25T00:00:00Z' WHERE id = ?").run(old.id);

    markProcessing(db, recent.id);
    markCompleted(db, recent.id);

    // Purge older than Feb 26
    const removed = purgeCompleted(db, "2026-02-26T00:00:00Z");
    expect(removed).toBe(1);

    // Recent completed still there, pending still there
    const remaining = db.prepare("SELECT COUNT(*) as cnt FROM cortex_bus").get() as { cnt: number };
    expect(remaining.cnt).toBe(2);
  });

  it("does not remove pending or processing messages", () => {
    const env = makeEnvelope();
    enqueue(db, env);

    const removed = purgeCompleted(db, "2099-01-01T00:00:00Z");
    expect(removed).toBe(0);
    expect(countPending(db)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Crash durability
// ---------------------------------------------------------------------------

describe("crash durability", () => {
  it("pending messages survive close + reopen", () => {
    const env = makeEnvelope({ content: "survive this" });
    enqueue(db, env);

    // "Crash" — close the DB
    const dbPath = path.join(tmpDir, "bus.sqlite");
    db.close();

    // Reopen
    db = initBus(dbPath);
    const msg = dequeueNext(db);
    expect(msg).not.toBeNull();
    expect(msg!.envelope.content).toBe("survive this");
  });

  it("processing messages survive crash (still in processing state)", () => {
    const env = makeEnvelope({ content: "in flight" });
    enqueue(db, env);
    markProcessing(db, env.id);

    // "Crash"
    const dbPath = path.join(tmpDir, "bus.sqlite");
    db.close();

    // Reopen
    db = initBus(dbPath);
    const row = db.prepare("SELECT state FROM cortex_bus WHERE id = ?").get(env.id) as { state: string };
    expect(row.state).toBe("processing");

    // dequeueNext won't return it (it's processing, not pending)
    expect(dequeueNext(db)).toBeNull();
  });
});
