#!/usr/bin/env node
/**
 * E2E test for resource-passing via sessions_spawn.
 *
 * Sends a message to the agent asking it to spawn a task with a file resource
 * (workspace/IDENTITY.md), then checks that the output mentions "Scaff".
 */

import { execSync } from "node:child_process";

const sessionId = `e2e-res-${Date.now()}`;
const prompt = `Use sessions_spawn to dispatch this task: Read the provided resource and tell me what name is defined in it. Attach workspace/IDENTITY.md as a file resource.`;

console.log(`[e2e] Running with session: ${sessionId}`);
console.log(`[e2e] Prompt: ${prompt}`);

try {
  const output = execSync(
    `node openclaw.mjs agent -m '${prompt.replace(/'/g, "'\\''")}' --session-id ${sessionId} --json`,
    {
      cwd: process.cwd(),
      timeout: 120_000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  console.log(`[e2e] Output:\n${output}`);

  if (output.includes("Scaff")) {
    console.log("[e2e] PASS — output mentions 'Scaff'");
    process.exit(0);
  } else {
    console.log("[e2e] FAIL — output does not mention 'Scaff'");
    process.exit(1);
  }
} catch (err) {
  console.error(`[e2e] Error:`, err.message || err);
  if (err.stdout) console.log(`[e2e] stdout: ${err.stdout}`);
  if (err.stderr) console.log(`[e2e] stderr: ${err.stderr}`);
  process.exit(1);
}
