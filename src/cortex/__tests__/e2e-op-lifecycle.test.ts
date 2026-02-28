/**
 * E2E: Pending Op Lifecycle
 *
 * Tests the full lifecycle: pending → completed → gardened → archived.
 * Verifies System Floor visibility, fact extraction, and archival.
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
  getCompletedOps,
  markOpsGardened,
  archiveOldGardenedOps,
  acknowledgeCompletedOps,
} from "../session.js";
import { getTopHotFacts } from "../hippocampus.js";
import { runOpHarvester } from "../gardener.js";
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
  it("full lifecycle: pending → completed → gardened → archived", async () => {
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

    // 3. Garden — Op Harvester extracts facts
    const harvestResult = await runOpHarvester({
      db: instance.db,
      extractLLM: async () => JSON.stringify(["Server runs on port 8080"]),
    });

    expect(harvestResult.processed).toBe(1);
    expect(harvestResult.errors).toHaveLength(0);

    // Op is now gardened — no longer in active ops
    ops = getPendingOps(instance.db);
    expect(ops).toHaveLength(0);

    // Fact extracted into hot memory
    const hotFacts = getTopHotFacts(instance.db);
    expect(hotFacts).toHaveLength(1);
    expect(hotFacts[0].factText).toBe("Server runs on port 8080");

    // 4. Archive — backdate gardened_at and archive
    instance.db.prepare(
      `UPDATE cortex_pending_ops SET gardened_at = ? WHERE id = ?`,
    ).run(new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(), "job-100");

    const archived = archiveOldGardenedOps(instance.db, 7);
    expect(archived).toBe(1);

    // Verify: archived op not visible, fact persists
    ops = getPendingOps(instance.db);
    expect(ops).toHaveLength(0);

    const factsAfter = getTopHotFacts(instance.db);
    expect(factsAfter).toHaveLength(1);
    expect(factsAfter[0].factText).toBe("Server runs on port 8080");
  });

  it("System Floor visibility: pending and completed ops visible, gardened/archived not", async () => {
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
    expect(capturedSystem).toContain("PENDING");

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

    // Completed op should be visible as NEW RESULT
    expect(capturedSystem).toContain("Research API design patterns");
    expect(capturedSystem).toContain("NEW RESULT");
    expect(capturedSystem).toContain("Use REST with OpenAPI spec");

    // After the LLM turn, acknowledgeCompletedOps() was called by the loop (step 8b).
    // Trigger another context assembly — acknowledged op should NOT be visible.
    capturedSystem = "";
    instance.enqueue(createEnvelope({
      channel: "webchat",
      sender: { id: "serj", name: "Serj", relationship: "partner" },
      content: "any updates?",
    }));
    await wait(500);

    // Acknowledged op should NOT be visible in System Floor (inbox "read" pattern)
    expect(capturedSystem).not.toContain("Research API design patterns");
  });

  it("fact persistence: extracted facts survive op archival", async () => {
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

    // Add and complete an op
    addPendingOp(instance.db, {
      id: "job-300",
      type: "router_job",
      description: "Find the database password",
      dispatchedAt: new Date().toISOString(),
      expectedChannel: "router",
      status: "pending",
    });
    completePendingOp(instance.db, "job-300", "DB password is stored in vault at /secrets/db");

    // Harvest facts
    await runOpHarvester({
      db: instance.db,
      extractLLM: async () => JSON.stringify(["DB password is stored in vault at /secrets/db"]),
    });

    // Backdate and archive
    instance.db.prepare(
      `UPDATE cortex_pending_ops SET gardened_at = ? WHERE id = ?`,
    ).run(new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(), "job-300");
    archiveOldGardenedOps(instance.db, 7);

    // Op is archived but fact persists independently
    const archivedOp = instance.db.prepare(
      `SELECT status FROM cortex_pending_ops WHERE id = ?`,
    ).get("job-300") as { status: string };
    expect(archivedOp.status).toBe("archived");

    const facts = getTopHotFacts(instance.db);
    expect(facts).toHaveLength(1);
    expect(facts[0].factText).toBe("DB password is stored in vault at /secrets/db");
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

    // All 3 completed
    const completed = getCompletedOps(instance.db);
    expect(completed).toHaveLength(3);

    // Harvest all
    let callCount = 0;
    const harvestResult = await runOpHarvester({
      db: instance.db,
      extractLLM: async () => {
        callCount++;
        return JSON.stringify([`Fact from task ${callCount}`]);
      },
    });

    expect(harvestResult.processed).toBe(3);
    expect(getTopHotFacts(instance.db)).toHaveLength(3);

    // All gardened — no longer in active ops
    ops = getPendingOps(instance.db);
    expect(ops).toHaveLength(0);
  });

  it("Op Harvester: LLM error on one op does not block others", async () => {
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

    // Add 3 completed ops
    for (let i = 1; i <= 3; i++) {
      addPendingOp(instance.db, {
        id: `job-${i}`,
        type: "router_job",
        description: `Task ${i}`,
        dispatchedAt: new Date().toISOString(),
        expectedChannel: "router",
        status: "pending",
      });
      completePendingOp(instance.db, `job-${i}`, `Result ${i}`);
    }

    let callIdx = 0;
    const harvestResult = await runOpHarvester({
      db: instance.db,
      extractLLM: async () => {
        callIdx++;
        if (callIdx === 2) throw new Error("LLM timeout");
        return JSON.stringify([`Fact ${callIdx}`]);
      },
    });

    // 2 processed successfully, 1 error
    expect(harvestResult.processed).toBe(2);
    expect(harvestResult.errors).toHaveLength(1);
    expect(harvestResult.errors[0]).toContain("LLM timeout");

    // 2 gardened, 1 still completed (the failed one)
    const remaining = getCompletedOps(instance.db);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe("job-2");
  });

  it("acknowledgeCompletedOps: fresh results visible until acknowledged, then gone", async () => {
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

    // Both should be visible (completed but unacknowledged)
    let ops = getPendingOps(instance.db);
    expect(ops).toHaveLength(2);
    expect(ops.every((o) => o.status === "completed")).toBe(true);
    expect(ops.every((o) => o.acknowledgedAt === undefined)).toBe(true);

    // Acknowledge — marks as "read"
    const acked = acknowledgeCompletedOps(instance.db);
    expect(acked).toBe(2);

    // Now both should be gone from getPendingOps (acknowledged)
    ops = getPendingOps(instance.db);
    expect(ops).toHaveLength(0);

    // But they're still in the DB as completed (for Op Harvester)
    const completed = getCompletedOps(instance.db);
    expect(completed).toHaveLength(2);

    // A new op that completes AFTER acknowledgment is still visible
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
    expect(ops[0].acknowledgedAt).toBeUndefined();
  });

  it("failPendingOp: failed ops stay visible until acknowledged", async () => {
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
    expect(capturedSystem).toContain("PENDING");

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

    // Failed op should have been visible in the System Floor with FAILED tag
    expect(capturedSystem).toContain("Doomed task");
    expect(capturedSystem).toContain("FAILED");
    expect(capturedSystem).toContain("config missing tiers");
    expect(capturedSystem).toContain("Good task");

    // After the LLM turn, acknowledgeCompletedOps() was called by the loop,
    // so the failed op is now acknowledged. Trigger another context assembly.
    capturedSystem = "";
    instance.enqueue(createEnvelope({
      channel: "webchat",
      sender: { id: "serj", name: "Serj", relationship: "partner" },
      content: "any updates?",
    }));
    await wait(500);

    // Failed op should be gone after acknowledgment, pending op still visible
    expect(capturedSystem).not.toContain("Doomed task");
    expect(capturedSystem).toContain("Good task");
  });

  it("startup cleanup: orphaned pending ops are marked failed but stay visible until acknowledged", async () => {
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

    // Orphaned ops should STILL be visible (failed but unacknowledged)
    let ops = getPendingOps(instance.db);
    expect(ops).toHaveLength(2);
    expect(ops.every((o) => o.status === "failed")).toBe(true);

    // Verify they're in DB as failed with error details
    const row = instance.db.prepare(
      `SELECT status, result, acknowledged_at FROM cortex_pending_ops WHERE id = ?`,
    ).get("orphan-1") as { status: string; result: string; acknowledged_at: string | null };
    expect(row.status).toBe("failed");
    expect(row.result).toContain("orphaned from prior session");
    expect(row.acknowledged_at).toBeNull();

    // After the LLM acknowledges, they disappear
    acknowledgeCompletedOps(instance.db);
    ops = getPendingOps(instance.db);
    expect(ops).toHaveLength(0);
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

    // Failed ops are still visible (unacknowledged)
    let ops = getPendingOps(instance.db);
    expect(ops).toHaveLength(2);
    expect(ops.every((o) => o.status === "failed")).toBe(true);

    // Acknowledge the failed ops (LLM has seen them)
    acknowledgeCompletedOps(instance.db);
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

    // Gardener can harvest the new op normally
    const harvestResult = await runOpHarvester({
      db: instance.db,
      extractLLM: async () => JSON.stringify(["Port is 3000"]),
    });
    expect(harvestResult.processed).toBe(1);
    expect(harvestResult.errors).toHaveLength(0);
  });

  it("archiveOldGardenedOps: only archives ops older than threshold", async () => {
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

    // Add 2 ops, garden both
    for (let i = 1; i <= 2; i++) {
      addPendingOp(instance.db, {
        id: `job-${i}`,
        type: "router_job",
        description: `Task ${i}`,
        dispatchedAt: new Date().toISOString(),
        expectedChannel: "router",
        status: "pending",
      });
      completePendingOp(instance.db, `job-${i}`, `Result ${i}`);
    }
    markOpsGardened(instance.db, ["job-1", "job-2"]);

    // Backdate job-1 to 10 days ago, leave job-2 as recent
    instance.db.prepare(
      `UPDATE cortex_pending_ops SET gardened_at = ? WHERE id = ?`,
    ).run(new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(), "job-1");

    const archived = archiveOldGardenedOps(instance.db, 7);
    expect(archived).toBe(1);

    // job-1 archived, job-2 still gardened
    const row1 = instance.db.prepare(
      `SELECT status FROM cortex_pending_ops WHERE id = ?`,
    ).get("job-1") as { status: string };
    expect(row1.status).toBe("archived");

    const row2 = instance.db.prepare(
      `SELECT status FROM cortex_pending_ops WHERE id = ?`,
    ).get("job-2") as { status: string };
    expect(row2.status).toBe("gardened");
  });
});
