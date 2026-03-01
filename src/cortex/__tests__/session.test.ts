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
} from "../session.js";
import { createEnvelope, type CortexOutput } from "../types.js";

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

// ---------------------------------------------------------------------------
// Issuer filtering
// ---------------------------------------------------------------------------

describe("issuer filtering", () => {
  it("appendToSession writes issuer, getSessionHistory filters by it", () => {
    appendToSession(db, makeEnvelope("webchat", "msg A"), "agent:main:cortex");
    appendToSession(db, makeEnvelope("webchat", "msg B"), "agent:other:cortex");

    const all = getSessionHistory(db);
    expect(all).toHaveLength(2);

    const mainOnly = getSessionHistory(db, { issuer: "agent:main:cortex" });
    expect(mainOnly).toHaveLength(1);
    expect(mainOnly[0].content).toBe("msg A");
    expect(mainOnly[0].issuer).toBe("agent:main:cortex");

    const otherOnly = getSessionHistory(db, { issuer: "agent:other:cortex" });
    expect(otherOnly).toHaveLength(1);
    expect(otherOnly[0].content).toBe("msg B");
  });

});

// ---------------------------------------------------------------------------
// Migration: existing DB without issuer column
// ---------------------------------------------------------------------------

describe("migration: existing DB without issuer", () => {
  it("initSessionTables succeeds on a DB with pre-existing tables lacking issuer", () => {
    // Create a SECOND database with OLD schema (no issuer column)
    const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-migrate-test-"));
    const db2 = initBus(path.join(tmpDir2, "migrate.sqlite"));

    // Manually create old-schema tables (no issuer)
    db2.exec(`
      CREATE TABLE cortex_session (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        envelope_id TEXT NOT NULL,
        role        TEXT NOT NULL,
        channel     TEXT NOT NULL,
        sender_id   TEXT NOT NULL,
        content     TEXT NOT NULL,
        timestamp   TEXT NOT NULL,
        metadata    TEXT
      )
    `);

    // Insert a row in the old schema
    db2.prepare(`
      INSERT INTO cortex_session (envelope_id, role, channel, sender_id, content, timestamp)
      VALUES ('env-1', 'user', 'webchat', 'serj', 'old message', '2026-01-01T00:00:00Z')
    `).run();

    // NOW run initSessionTables — this must NOT crash
    initSessionTables(db2);

    // Old rows should have the default issuer
    const history = getSessionHistory(db2);
    expect(history).toHaveLength(1);
    expect(history[0].issuer).toBe("agent:main:cortex");

    // New rows work with explicit issuer
    appendToSession(db2, makeEnvelope("webchat", "new msg"), "agent:main:cortex");
    expect(getSessionHistory(db2, { issuer: "agent:main:cortex" })).toHaveLength(2);

    db2.close();
    fs.rmSync(tmpDir2, { recursive: true, force: true });
  });
});
