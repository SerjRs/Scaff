/**
 * E2E: Pending Op Lifecycle
 *
 * Tests the simplified lifecycle: pending → completed/failed → [LLM sees it] → copy to cortex_session + DELETE.
 * Verifies System Floor visibility, copy to session, and deletion.
 *
 * @see docs/hipocampus-architecture.md §6
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { startCortex, stopCortex, _resetSingleton, type CortexInstance } from "../index.js";
import { createEnvelope } from "../types.js";
import {
  addPendingOp,
  getPendingOps,
  completePendingOp,
  failPendingOp,
  copyAndDeleteCompletedOps,
  getSessionHistory,
} from "../session.js";
import { getTopHotFacts } from "../hippocampus.js";
import type { EmbedFunction } from "../tools.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let workspaceDir: string;
let instance: CortexInstance | null = null;

const mockEmbedFn: EmbedFunction = async (text: string) => {
  let seed = 0;
  for (let i = 0; i < text.length; i++) seed = (seed * 31 + text.charCodeAt(i)) | 0;
  const emb = new Float32Array(768);
  for (let i = 0; i < 768; i++) emb[i] = Math.sin(seed * (i + 1));
  return emb;
};

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(() => {
  _resetSingleton();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-e2e-oplife-"));
  workspaceDir = path.join(tmpDir, "workspace");
  fs.mkdirSync(workspaceDir);
  fs.writeFileSync(path.join(workspaceDir, "SOUL.md"), "You are Scaff.");
});

afterEach(async () => {
  if (instance) {
    await instance.stop();
    instance = null;
  }
  _resetSingleton();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("pending op lifecycle", () => {
  it("full lifecycle: pending → completed → copy to cortex_session + DELETE", async () => {
    instance = await startCortex({
      agentId: "main",
      workspaceDir,
      dbPath: path.join(tmpDir, "bus.sqlite"),
      maxContextTokens: 10000,
      hippocampusEnabled: true,
      embedFn: mockEmbedFn,
      gardenerSummarizeLLM: async () => "summary",
      gardenerExtractLLM: async () => JSON.stringify(["Server runs on port 8080"]),
      callLLM: async () => ({ text: "ok", toolCalls: [] }),
    });

    // 1. Dispatch — add a pending op
    addPendingOp(instance.db, {
      id: "job-100",
      type: "router_job",
      description: "Check which port the server runs on",
      dispatchedAt: new Date().toISOString(),
      expectedChannel: "router",
      status: "pending",
    });

    let ops = getPendingOps(instance.db);
    expect(ops).toHaveLength(1);
    expect(ops[0].status).toBe("pending");

    // 2. Complete — result arrives
    completePendingOp(instance.db, "job-100", "The server runs on port 8080");

    ops = getPendingOps(instance.db);
    expect(ops).toHaveLength(1);
    expect(ops[0].status).toBe("completed");
    expect(ops[0].result).toBe("The server runs on port 8080");
    expect(ops[0].completedAt).toBeDefined();

    // 3. Copy + delete — replaces the old acknowledge+garden+archive flow
    const copied = copyAndDeleteCompletedOps(instance.db);
    expect(copied).toBe(1);

    // Op is deleted from cortex_pending_ops
    ops = getPendingOps(instance.db);
    expect(ops).toHaveLength(0);

    // Result is now in cortex_session
    const session = getSessionHistory(instance.db, { channel: "router" });
    expect(session.length).toBeGreaterThanOrEqual(1);
    const taskResult = session.find((m) => m.senderId === "cortex:ops");
    expect(taskResult).toBeDefined();
    expect(taskResult!.content).toContain("[TASK_RESULT]");
    expect(taskResult!.content).toContain("The server runs on port 8080");
  });

  it("System Floor visibility: pending and completed ops visible, then gone after copy+delete", async () => {
    let capturedSystem = "";

    instance = await startCortex({
      agentId: "main",
      workspaceDir,
      dbPath: path.join(tmpDir, "bus.sqlite"),
      maxContextTokens: 10000,
      pollIntervalMs: 50,
      hippocampusEnabled: true,
      embedFn: mockEmbedFn,
      gardenerSummarizeLLM: async () => "summary",
      gardenerExtractLLM: async () => "[]",
      callLLM: async (context) => {
        const systemFloor = context.layers.find((l) => l.name === "system_floor");
        if (systemFloor) capturedSystem = systemFloor.content;
        return { text: "ok", toolCalls: [] };
      },
    });

    instance.registerAdapter({
      channelId: "webchat",
      toEnvelope: () => { throw new Error("not used"); },
      send: async () => {},
      isAvailable: () => true,
    });

    // Add a pending op
    addPendingOp(instance.db, {
      id: "job-200",
      type: "router_job",
      description: "Research API design patterns",
      dispatchedAt: new Date().toISOString(),
      expectedChannel: "router",
      status: "pending",
    });

    // Trigger context assembly
    instance.enqueue(createEnvelope({
      channel: "webchat",
      sender: { id: "serj", name: "Serj", relationship: "partner" },
      content: "hello",
    }));
    await wait(500);

    // Pending op should be visible
    expect(capturedSystem).toContain("Research API design patterns");
    expect(capturedSystem).toContain("Status=Pending");

    // Complete the op
    completePendingOp(instance.db, "job-200", "Use REST with OpenAPI spec");

    // Trigger another context assembly — fresh result should be visible
    capturedSystem = "";
    instance.enqueue(createEnvelope({
      channel: "webchat",
      sender: { id: "serj", name: "Serj", relationship: "partner" },
      content: "what about the API?",
    }));
    await wait(500);

    // Completed op should be visible as Status=Completed
    expect(capturedSystem).toContain("Research API design patterns");
    expect(capturedSystem).toContain("Status=Completed");
    expect(capturedSystem).toContain("Use REST with OpenAPI spec");

    // After the LLM turn, copyAndDeleteCompletedOps() was called by the loop (step 8b).
    // Trigger another context assembly — deleted op should NOT be visible.
    capturedSystem = "";
    instance.enqueue(createEnvelope({
      channel: "webchat",
      sender: { id: "serj", name: "Serj", relationship: "partner" },
      content: "any updates?",
    }));
    await wait(500);

    // Deleted op should NOT be visible in System Floor
    expect(capturedSystem).not.toContain("Research API design patterns");
  });

  it("multiple concurrent ops: results arrive in different order, all correctly processed", async () => {
    instance = await startCortex({
      agentId: "main",
      workspaceDir,
      dbPath: path.join(tmpDir, "bus.sqlite"),
      maxContextTokens: 10000,
      hippocampusEnabled: true,
      embedFn: mockEmbedFn,
      gardenerSummarizeLLM: async () => "summary",
      gardenerExtractLLM: async () => "[]",
      callLLM: async () => ({ text: "ok", toolCalls: [] }),
    });

    // Dispatch 3 ops
    for (let i = 1; i <= 3; i++) {
      addPendingOp(instance.db, {
        id: `job-${i}`,
        type: "router_job",
        description: `Task ${i}`,
        dispatchedAt: new Date().toISOString(),
        expectedChannel: "router",
        status: "pending",
      });
    }

    expect(getPendingOps(instance.db)).toHaveLength(3);

    // Complete in reverse order (3, 1, 2)
    completePendingOp(instance.db, "job-3", "Result 3");
    completePendingOp(instance.db, "job-1", "Result 1");

    // 1 pending, 2 completed — all visible
    let ops = getPendingOps(instance.db);
    expect(ops).toHaveLength(3);
    expect(ops.find((o) => o.id === "job-2")!.status).toBe("pending");
    expect(ops.find((o) => o.id === "job-1")!.status).toBe("completed");
    expect(ops.find((o) => o.id === "job-3")!.status).toBe("completed");

    // Complete the last one
    completePendingOp(instance.db, "job-2", "Result 2");

    // All 3 completed — still in table
    ops = getPendingOps(instance.db);
    expect(ops).toHaveLength(3);
    expect(ops.every((o) => o.status === "completed")).toBe(true);

    // Copy + delete all
    const copied = copyAndDeleteCompletedOps(instance.db);
    expect(copied).toBe(3);

    // All deleted from cortex_pending_ops
    ops = getPendingOps(instance.db);
    expect(ops).toHaveLength(0);

    // All copied to cortex_session
    const session = getSessionHistory(instance.db, { channel: "router" });
    const opResults = session.filter((m) => m.senderId === "cortex:ops");
    expect(opResults).toHaveLength(3);
  });

  it("copyAndDeleteCompletedOps: completed ops copied to session then deleted", async () => {
    instance = await startCortex({
      agentId: "main",
      workspaceDir,
      dbPath: path.join(tmpDir, "bus.sqlite"),
      maxContextTokens: 10000,
      hippocampusEnabled: true,
      embedFn: mockEmbedFn,
      gardenerSummarizeLLM: async () => "summary",
      gardenerExtractLLM: async () => "[]",
      callLLM: async () => ({ text: "ok", toolCalls: [] }),
    });

    // Add 2 ops, complete both
    addPendingOp(instance.db, {
      id: "job-ack-1",
      type: "router_job",
      description: "Task A",
      dispatchedAt: new Date().toISOString(),
      expectedChannel: "router",
      status: "pending",
    });
    addPendingOp(instance.db, {
      id: "job-ack-2",
      type: "router_job",
      description: "Task B",
      dispatchedAt: new Date().toISOString(),
      expectedChannel: "router",
      status: "pending",
    });

    completePendingOp(instance.db, "job-ack-1", "Result A");
    completePendingOp(instance.db, "job-ack-2", "Result B");

    // Both should be visible (completed, still in table)
    let ops = getPendingOps(instance.db);
    expect(ops).toHaveLength(2);
    expect(ops.every((o) => o.status === "completed")).toBe(true);

    // Copy + delete
    const count = copyAndDeleteCompletedOps(instance.db);
    expect(count).toBe(2);

    // Now both should be gone from getPendingOps
    ops = getPendingOps(instance.db);
    expect(ops).toHaveLength(0);

    // Results exist in cortex_session
    const session = getSessionHistory(instance.db, { channel: "router" });
    const opResults = session.filter((m) => m.senderId === "cortex:ops");
    expect(opResults).toHaveLength(2);
    expect(opResults.some((m) => m.content.includes("Result A"))).toBe(true);
    expect(opResults.some((m) => m.content.includes("Result B"))).toBe(true);

    // A new op that completes AFTER copy+delete is still visible
    addPendingOp(instance.db, {
      id: "job-ack-3",
      type: "router_job",
      description: "Task C",
      dispatchedAt: new Date().toISOString(),
      expectedChannel: "router",
      status: "pending",
    });
    completePendingOp(instance.db, "job-ack-3", "Result C");

    ops = getPendingOps(instance.db);
    expect(ops).toHaveLength(1);
    expect(ops[0].id).toBe("job-ack-3");
  });

  it("failPendingOp: failed ops stay visible until copy+delete", async () => {
    let capturedSystem = "";

    instance = await startCortex({
      agentId: "main",
      workspaceDir,
      dbPath: path.join(tmpDir, "bus.sqlite"),
      maxContextTokens: 10000,
      pollIntervalMs: 50,
      hippocampusEnabled: true,
      embedFn: mockEmbedFn,
      gardenerSummarizeLLM: async () => "summary",
      gardenerExtractLLM: async () => "[]",
      callLLM: async (context) => {
        const systemFloor = context.layers.find((l) => l.name === "system_floor");
        if (systemFloor) capturedSystem = systemFloor.content;
        return { text: "ok", toolCalls: [] };
      },
    });

    instance.registerAdapter({
      channelId: "webchat",
      toEnvelope: () => { throw new Error("not used"); },
      send: async () => {},
      isAvailable: () => true,
    });

    // Add 2 pending ops — one will fail, one stays pending
    addPendingOp(instance.db, {
      id: "job-will-fail",
      type: "router_job",
      description: "Doomed task",
      dispatchedAt: new Date().toISOString(),
      expectedChannel: "router",
      status: "pending",
    });
    addPendingOp(instance.db, {
      id: "job-will-succeed",
      type: "router_job",
      description: "Good task",
      dispatchedAt: new Date().toISOString(),
      expectedChannel: "router",
      status: "pending",
    });

    // Trigger context assembly — both should be visible as PENDING
    instance.enqueue(createEnvelope({
      channel: "webchat",
      sender: { id: "serj", name: "Serj", relationship: "partner" },
      content: "hello",
    }));
    await wait(500);

    expect(capturedSystem).toContain("Doomed task");
    expect(capturedSystem).toContain("Good task");
    expect(capturedSystem).toContain("Status=Pending");

    // Fail one op (simulating Router job:failed event)
    failPendingOp(instance.db, "job-will-fail", "config missing tiers");

    // Check ops BEFORE the next LLM turn — both should be visible
    const ops = getPendingOps(instance.db);
    expect(ops).toHaveLength(2);
    expect(ops.find((o) => o.id === "job-will-fail")!.status).toBe("failed");
    expect(ops.find((o) => o.id === "job-will-succeed")!.status).toBe("pending");

    // Trigger another context assembly — the LLM should see the FAILED op
    capturedSystem = "";
    instance.enqueue(createEnvelope({
      channel: "webchat",
      sender: { id: "serj", name: "Serj", relationship: "partner" },
      content: "what happened?",
    }));
    await wait(500);

    // Failed op should have been visible in the System Floor with Status=Failed tag
    expect(capturedSystem).toContain("Doomed task");
    expect(capturedSystem).toContain("Status=Failed");
    expect(capturedSystem).toContain("config missing tiers");
    expect(capturedSystem).toContain("Good task");

    // After the LLM turn, copyAndDeleteCompletedOps() was called by the loop,
    // so the failed op is now deleted. Trigger another context assembly.
    capturedSystem = "";
    instance.enqueue(createEnvelope({
      channel: "webchat",
      sender: { id: "serj", name: "Serj", relationship: "partner" },
      content: "any updates?",
    }));
    await wait(500);

    // Failed op should be gone after copy+delete, pending op still visible
    expect(capturedSystem).not.toContain("Doomed task");
    expect(capturedSystem).toContain("Good task");
  });

  it("startup cleanup: orphaned pending ops are marked failed but stay visible until copy+delete", async () => {
    const dbPath = path.join(tmpDir, "bus.sqlite");

    // Start Cortex, add orphaned pending ops, then stop
    instance = await startCortex({
      agentId: "main",
      workspaceDir,
      dbPath,
      maxContextTokens: 10000,
      callLLM: async () => ({ text: "ok", toolCalls: [] }),
    });

    addPendingOp(instance.db, {
      id: "orphan-1",
      type: "router_job",
      description: "Orphaned from crash",
      dispatchedAt: new Date().toISOString(),
      expectedChannel: "router",
      status: "pending",
    });
    addPendingOp(instance.db, {
      id: "orphan-2",
      type: "router_job",
      description: "Also orphaned",
      dispatchedAt: new Date().toISOString(),
      expectedChannel: "router",
      status: "pending",
    });

    // Verify they're there as pending
    expect(getPendingOps(instance.db)).toHaveLength(2);

    // Simulate what gateway-bridge startup cleanup does
    const orphaned = getPendingOps(instance.db).filter((op) => op.status === "pending");
    for (const op of orphaned) {
      failPendingOp(instance.db, op.id, "orphaned from prior session (startup cleanup)");
    }

    // Orphaned ops should STILL be visible (failed but not yet copy+deleted)
    let ops = getPendingOps(instance.db);
    expect(ops).toHaveLength(2);
    expect(ops.every((o) => o.status === "failed")).toBe(true);

    // Verify they're in DB as failed with error details
    const row = instance.db.prepare(
      `SELECT status, result FROM cortex_pending_ops WHERE id = ?`,
    ).get("orphan-1") as { status: string; result: string };
    expect(row.status).toBe("failed");
    expect(row.result).toContain("orphaned from prior session");

    // After copy+delete, they disappear from pending_ops and appear in session
    copyAndDeleteCompletedOps(instance.db);
    ops = getPendingOps(instance.db);
    expect(ops).toHaveLength(0);

    // Verify copied to cortex_session
    const session = getSessionHistory(instance.db, { channel: "router" });
    const opResults = session.filter((m) => m.senderId === "cortex:ops");
    expect(opResults).toHaveLength(2);
    expect(opResults.some((m) => m.content.includes("[TASK_FAILED]"))).toBe(true);
  });

  it("failed ops don't interfere with new ops completing normally", async () => {
    instance = await startCortex({
      agentId: "main",
      workspaceDir,
      dbPath: path.join(tmpDir, "bus.sqlite"),
      maxContextTokens: 10000,
      hippocampusEnabled: true,
      embedFn: mockEmbedFn,
      gardenerSummarizeLLM: async () => "summary",
      gardenerExtractLLM: async () => JSON.stringify(["Port is 3000"]),
      callLLM: async () => ({ text: "ok", toolCalls: [] }),
    });

    // Simulate: 2 old failed ops + 1 new successful op
    addPendingOp(instance.db, {
      id: "old-fail-1",
      type: "router_job",
      description: "Old failed task 1",
      dispatchedAt: new Date().toISOString(),
      expectedChannel: "router",
      status: "pending",
    });
    addPendingOp(instance.db, {
      id: "old-fail-2",
      type: "router_job",
      description: "Old failed task 2",
      dispatchedAt: new Date().toISOString(),
      expectedChannel: "router",
      status: "pending",
    });

    // Fail the old ones
    failPendingOp(instance.db, "old-fail-1", "config broken");
    failPendingOp(instance.db, "old-fail-2", "config broken");

    // Failed ops are still visible
    let ops = getPendingOps(instance.db);
    expect(ops).toHaveLength(2);
    expect(ops.every((o) => o.status === "failed")).toBe(true);

    // Copy+delete the failed ops (LLM has seen them)
    copyAndDeleteCompletedOps(instance.db);
    expect(getPendingOps(instance.db)).toHaveLength(0);

    // Add a new op and complete it normally
    addPendingOp(instance.db, {
      id: "new-success",
      type: "router_job",
      description: "What port does the server use?",
      dispatchedAt: new Date().toISOString(),
      expectedChannel: "router",
      status: "pending",
    });
    completePendingOp(instance.db, "new-success", "Server runs on port 3000");

    // The new completed op should be visible
    ops = getPendingOps(instance.db);
    expect(ops).toHaveLength(1);
    expect(ops[0].id).toBe("new-success");
    expect(ops[0].status).toBe("completed");

    // Copy+delete the new op
    const count = copyAndDeleteCompletedOps(instance.db);
    expect(count).toBe(1);
    expect(getPendingOps(instance.db)).toHaveLength(0);

    // Result is in cortex_session
    const session = getSessionHistory(instance.db, { channel: "router" });
    const opResults = session.filter((m) => m.senderId === "cortex:ops" && m.content.includes("port 3000"));
    expect(opResults).toHaveLength(1);
  });
});
