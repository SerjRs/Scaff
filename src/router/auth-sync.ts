/**
 * Router Auth Sync
 *
 * Copies authentication files from the main agent to the router-executor
 * agent so that the executor can authenticate with the same API keys.
 *
 * @module
 */

import path from "node:path";
import fs from "node:fs";

const EXECUTOR_AGENT_ID = "router-executor";

/**
 * Sync auth files from the main agent to the router-executor agent.
 *
 * Copies `auth-profiles.json` and (if it exists) `auth.json` from
 * `agents/main/agent/` to `agents/router-executor/agent/`.
 * Creates target directories if needed. Never throws.
 */
export function syncExecutorAuth(stateDir: string, log?: any): void {
  const mainAgentDir = path.join(stateDir, "agents", "main", "agent");
  const executorAgentDir = path.join(stateDir, "agents", EXECUTOR_AGENT_ID, "agent");

  const profilesSrc = path.join(mainAgentDir, "auth-profiles.json");
  if (!fs.existsSync(profilesSrc)) {
    console.log("[router] Warning: auth-profiles.json not found in main agent — skipping auth sync");
    return;
  }

  // Ensure target dir exists
  fs.mkdirSync(executorAgentDir, { recursive: true });

  // Copy auth-profiles.json (required)
  fs.copyFileSync(profilesSrc, path.join(executorAgentDir, "auth-profiles.json"));

  // Copy auth.json if it exists (optional)
  const authSrc = path.join(mainAgentDir, "auth.json");
  if (fs.existsSync(authSrc)) {
    fs.copyFileSync(authSrc, path.join(executorAgentDir, "auth.json"));
  }

  console.log("[router] Synced auth profiles to router-executor agent");
}
