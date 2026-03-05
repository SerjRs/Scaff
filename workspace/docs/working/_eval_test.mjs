// Dispatch 3 tasks of different complexity through the router
import { execSync } from "child_process";

const tasks = [
  { msg: "What is 2+2?", expected: "haiku" },
  { msg: "Read the file workspace/IDENTITY.md and summarize it", expected: "sonnet" },
  { msg: "Analyze the architectural trade-offs between event sourcing and CQRS for financial systems with consistency models, replay capabilities, operational complexity, and provide code examples", expected: "opus" },
];

const cli = process.env.USERPROFILE + "/.openclaw/openclaw.mjs";

for (let i = 0; i < tasks.length; i++) {
  const t = tasks[i];
  const sid = `eval-verify-${i}`;
  console.log(`\n=== Task ${i}: ${t.msg.slice(0, 60)}... (expected: ${t.expected}) ===`);
  try {
    const out = execSync(
      `node "${cli}" agent -m "${t.msg.replace(/"/g, '\\"')}" --session-id ${sid} --json`,
      { timeout: 120000, encoding: "utf-8", cwd: process.env.USERPROFILE + "/.openclaw" }
    );
    const json = JSON.parse(out);
    const model = json.result?.meta?.agentMeta?.model || "unknown";
    console.log(`  Model: ${model}`);
    console.log(`  Text: ${json.result?.payloads?.[0]?.text?.slice(0, 100)}`);
  } catch (e) {
    console.log(`  ERROR: ${e.message.slice(0, 200)}`);
  }
}

// Check token monitor
console.log("\n=== TOKEN MONITOR ===");
try {
  const tokens = execSync(`node "${cli}" tokens`, { timeout: 10000, encoding: "utf-8", cwd: process.env.USERPROFILE + "/.openclaw" });
  console.log(tokens);
} catch (e) {
  console.log("Token monitor error:", e.message.slice(0, 200));
}
