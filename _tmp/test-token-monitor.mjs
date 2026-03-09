/**
 * Token Monitor verification tests
 * Tests Tasks 1-4 from the spec against the actual ledger implementation.
 */

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}`);
    failed++;
  }
}

// Dynamic import from built dist
const ledgerPath = new URL("file:///" + process.argv[1].replace(/\\/g, "/")).href;

// We need to import from the source directly — ledger uses globalThis singletons
// Import the built dist versions
const distDir = new URL("file:///C:/Users/Temp User/.openclaw/dist/").href;

// Reset globalThis to ensure clean state
delete globalThis.__openclawTokenLedger;
delete globalThis.__openclawTokenLedgerJobMap;

const { record, snapshot, reset, updateStatus, updateStatusBySession, registerJobSession, updateStatusByJobId } = await import("file:///C:/Users/Temp User/.openclaw/src/token-monitor/ledger.ts");

console.log("\n=== Task 1: PID Column ===");

reset();

// Test: PID is stored when provided
record({ agentId: "main", model: "opus", tokensIn: 100, tokensOut: 50, cached: 0, pid: "12345", sessionId: "sess-1" });
let rows = snapshot();
assert(rows.length === 1, "Single row recorded");
assert(rows[0].pid === "12345", "PID stored correctly: " + rows[0].pid);

// Test: PID defaults to process.pid when not provided
reset();
record({ agentId: "cortex", model: "opus", tokensIn: 200, tokensOut: 100, cached: 0 });
rows = snapshot();
assert(rows[0].pid === String(process.pid), "PID defaults to process.pid: " + rows[0].pid);

// Test: Task ID can be used as PID (T: prefix convention)
reset();
record({ agentId: "executor", model: "sonnet", tokensIn: 50, tokensOut: 25, cached: 0, pid: "T:813e79ca", sessionId: "task-1" });
rows = snapshot();
assert(rows[0].pid === "T:813e79ca", "Task ID stored as PID with T: prefix: " + rows[0].pid);

console.log("\n=== Task 2: Status Column ===");

reset();

// Test: Persistent agents get "Active" status
record({ agentId: "cortex", model: "opus", tokensIn: 100, tokensOut: 50, cached: 0 });
rows = snapshot();
assert(rows[0].status === "Active", "Persistent agent status is Active: " + rows[0].status);

// Test: Tasks get "InProgress" status
record({ agentId: "executor", model: "sonnet", tokensIn: 50, tokensOut: 25, cached: 0, sessionId: "task-123" });
rows = snapshot();
const taskRow = rows.find(r => r.agentId === "executor");
assert(taskRow?.status === "InProgress", "Task status is InProgress: " + taskRow?.status);

// Test: Status updates to Finished
updateStatusBySession("task-123", "Finished");
rows = snapshot();
const finishedRow = rows.find(r => r.agentId === "executor");
assert(finishedRow?.status === "Finished", "Status updated to Finished: " + finishedRow?.status);
assert(finishedRow?.statusChangedAt !== null, "statusChangedAt set on terminal status");

// Test: Status updates to Failed
reset();
record({ agentId: "executor", model: "haiku", tokensIn: 10, tokensOut: 5, cached: 0, sessionId: "task-fail" });
updateStatusBySession("task-fail", "Failed");
rows = snapshot();
const failedRow = rows.find(r => r.agentId === "executor");
assert(failedRow?.status === "Failed", "Status updated to Failed: " + failedRow?.status);

// Test: Status updates to Canceled
reset();
record({ agentId: "executor", model: "haiku", tokensIn: 10, tokensOut: 5, cached: 0, sessionId: "task-cancel" });
updateStatusBySession("task-cancel", "Canceled");
rows = snapshot();
const canceledRow = rows.find(r => r.agentId === "executor");
assert(canceledRow?.status === "Canceled", "Status updated to Canceled: " + canceledRow?.status);

// Test: Active agents stay Active (status doesn't change unexpectedly)
reset();
record({ agentId: "main", model: "opus", tokensIn: 500, tokensOut: 200, cached: 0 });
record({ agentId: "main", model: "opus", tokensIn: 300, tokensOut: 100, cached: 0 });
rows = snapshot();
assert(rows[0].status === "Active", "Active status persists across multiple records");
assert(rows[0].calls === 2, "Call count incremented: " + rows[0].calls);

console.log("\n=== Task 3: Auto-cleanup of Finished Rows ===");

reset();

// Test: Terminal rows have statusChangedAt set
record({ agentId: "executor", model: "sonnet", tokensIn: 50, tokensOut: 25, cached: 0, sessionId: "cleanup-test" });
updateStatusBySession("cleanup-test", "Finished");
rows = snapshot();
const cleanupRow = rows.find(r => r.agentId === "executor");
assert(cleanupRow !== undefined, "Finished row still visible immediately after status change");
assert(typeof cleanupRow?.statusChangedAt === "number", "statusChangedAt is a timestamp");

// Test: Simulate cleanup by manually setting statusChangedAt to 31s ago
// (We can't wait 30s in a test, so we manipulate the timestamp)
const ledgerMap = globalThis.__openclawTokenLedger;
for (const [key, row] of ledgerMap) {
  if (row.status === "Finished") {
    row.statusChangedAt = Date.now() - 31000; // 31 seconds ago
  }
}
rows = snapshot();
const cleanedRow = rows.find(r => r.agentId === "executor");
assert(cleanedRow === undefined, "Finished row auto-removed after 30s");

// Test: Active rows are never auto-removed
reset();
record({ agentId: "main", model: "opus", tokensIn: 100, tokensOut: 50, cached: 0 });
// Even with old startedAt, Active should remain
for (const [key, row] of ledgerMap) {
  if (row.status === "Active") {
    row.startedAt = Date.now() - 3600000; // 1 hour ago
  }
}
rows = snapshot();
assert(rows.length === 1, "Active rows never auto-removed: " + rows.length);

// Test: InProgress rows are never auto-removed
reset();
record({ agentId: "executor", model: "sonnet", tokensIn: 50, tokensOut: 25, cached: 0, sessionId: "ip-test" });
for (const [key, row] of ledgerMap) {
  if (row.status === "InProgress") {
    row.startedAt = Date.now() - 3600000;
  }
}
rows = snapshot();
assert(rows.length === 1, "InProgress rows never auto-removed");

console.log("\n=== Task 4: Column Layout / Data Shape ===");

reset();
record({ agentId: "main", model: "claude-opus-4-6", tokensIn: 1000, tokensOut: 500, cached: 200, pid: "9944", channel: "whatsapp", sessionId: "main-sess" });
rows = snapshot();
const r = rows[0];

// Verify all required fields exist
assert(typeof r.pid === "string", "pid field exists: " + r.pid);
assert(typeof r.model === "string", "model field exists: " + r.model);
assert(typeof r.channel === "string", "channel field exists: " + r.channel);
assert(typeof r.tokensIn === "number", "tokensIn field exists: " + r.tokensIn);
assert(typeof r.tokensOut === "number", "tokensOut field exists: " + r.tokensOut);
assert(typeof r.startedAt === "number", "startedAt field exists (for duration calc)");
assert(typeof r.status === "string", "status field exists: " + r.status);

// Verify values
assert(r.tokensIn === 1000, "tokensIn value correct");
assert(r.tokensOut === 500, "tokensOut value correct");
assert(r.channel === "whatsapp", "channel value correct");
assert(r.pid === "9944", "pid value correct");

console.log("\n=== Task 5: Router Job ↔ Session Mapping ===");

reset();

// Test: registerJobSession + updateStatusByJobId
record({ agentId: "executor", model: "sonnet", tokensIn: 100, tokensOut: 50, cached: 0, sessionId: "agent:router-executor:task:abc123" });
registerJobSession("job-xyz", "agent:router-executor:task:abc123");
updateStatusByJobId("job-xyz", "Finished");
rows = snapshot();
const jobRow = rows.find(r => r.agentId === "executor");
assert(jobRow?.status === "Finished", "updateStatusByJobId resolves job → session → status update");

// Test: updateStatusByJobId with unknown jobId is a no-op
updateStatusByJobId("nonexistent-job", "Failed");
// Should not crash — just a no-op

console.log("\n=== Token Accumulation ===");

reset();

// Test: Multiple records accumulate tokens
record({ agentId: "main", model: "opus", tokensIn: 100, tokensOut: 50, cached: 10 });
record({ agentId: "main", model: "opus", tokensIn: 200, tokensOut: 100, cached: 20 });
record({ agentId: "main", model: "opus", tokensIn: 300, tokensOut: 150, cached: 30 });
rows = snapshot();
assert(rows[0].tokensIn === 600, "Tokens in accumulated: " + rows[0].tokensIn);
assert(rows[0].tokensOut === 300, "Tokens out accumulated: " + rows[0].tokensOut);
assert(rows[0].cached === 60, "Cached accumulated: " + rows[0].cached);
assert(rows[0].calls === 3, "Call count: " + rows[0].calls);

console.log("\n" + "=".repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) process.exit(1);
