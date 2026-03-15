/**
 * Resolve auth credentials from OpenClaw auth profiles.
 * Zero external dependencies — only Node built-ins.
 */
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

export interface ResolvedAuth {
  token: string;
  isOAuth: boolean;
  provider: string;
  profileId: string;
}

/**
 * Resolve auth credentials from OpenClaw auth profiles.
 * Reads auth-profiles.json from the agent directory.
 *
 * @param opts.provider - Provider to resolve (default: "anthropic")
 * @param opts.agentDir - Agent directory (default: ~/.openclaw/agents/main/agent)
 */
export function resolveAuth(opts?: {
  provider?: string;
  agentDir?: string;
}): ResolvedAuth {
  const provider = opts?.provider ?? "anthropic";
  const agentDir =
    opts?.agentDir ??
    path.join(homedir(), ".openclaw", "agents", "main", "agent");

  const profilesPath = path.join(agentDir, "auth-profiles.json");

  let data: any;
  try {
    data = JSON.parse(fs.readFileSync(profilesPath, "utf-8"));
  } catch (err) {
    throw new Error(
      `[resolve-auth] Failed to read auth-profiles.json at ${profilesPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const profiles: Record<string, any> = data.profiles ?? {};
  const lastGood: string | undefined = data.lastGood?.[provider];

  // Build candidate list: lastGood first, then others matching provider
  const candidates: string[] = [];
  if (lastGood && profiles[lastGood]) candidates.push(lastGood);
  for (const id of Object.keys(profiles)) {
    if (id.startsWith(`${provider}:`) && id !== lastGood) {
      candidates.push(id);
    }
  }

  if (candidates.length === 0) {
    throw new Error(
      `[resolve-auth] No auth profile found for provider "${provider}" in ${profilesPath}`,
    );
  }

  // Try each candidate
  for (const profileId of candidates) {
    const profile = profiles[profileId];
    if (!profile) continue;

    let token: string | undefined;

    if (profile.type === "oauth") {
      token = profile.access;
    } else if (profile.type === "token" || profile.type === "api_key") {
      token = profile.token ?? profile.key;
    }

    if (token) {
      return {
        token,
        isOAuth: token.startsWith("sk-ant-oat01-"),
        provider,
        profileId,
      };
    }
  }

  throw new Error(
    `[resolve-auth] No valid credential found for provider "${provider}" (tried ${candidates.length} profile(s))`,
  );
}
