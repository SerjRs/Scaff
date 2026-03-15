/**
 * Self-contained LLM completion using OpenClaw auth profiles.
 * Zero external dependencies — only Node built-ins + resolve-auth.
 */
import { resolveAuth } from "./resolve-auth.js";

export interface CompleteOptions {
  model?: string;
  provider?: string;
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
  timeoutMs?: number;
  agentDir?: string;
}

/**
 * Make an authenticated LLM completion call using OpenClaw's auth profiles.
 *
 * @param prompt - User message to send
 * @param opts - Model, provider, and call options
 * @returns The text response from the LLM
 */
export async function complete(
  prompt: string,
  opts?: CompleteOptions,
): Promise<string> {
  const model = opts?.model ?? "claude-haiku-4-5";
  const maxTokens = opts?.maxTokens ?? 2048;
  const temperature = opts?.temperature ?? 0;
  const timeoutMs = opts?.timeoutMs ?? 60_000;

  const auth = resolveAuth({
    provider: opts?.provider,
    agentDir: opts?.agentDir,
  });

  // Build headers based on auth type
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
  };

  if (auth.isOAuth) {
    headers["authorization"] = `Bearer ${auth.token}`;
    headers["anthropic-beta"] = "claude-code-20250219,oauth-2025-04-20";
    headers["anthropic-dangerous-direct-browser-access"] = "true";
  } else {
    headers["x-api-key"] = auth.token;
  }

  const body = {
    model,
    max_tokens: maxTokens,
    temperature,
    messages: [{ role: "user", content: prompt }],
    ...(opts?.systemPrompt ? { system: opts.systemPrompt } : {}),
  };

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `[simple-complete] Anthropic API error ${res.status} (model=${model}, profile=${auth.profileId}): ${text}`,
    );
  }

  const data = await res.json();
  const content = data.content?.[0]?.text;

  if (typeof content !== "string") {
    throw new Error(
      `[simple-complete] Unexpected response shape (model=${model}, profile=${auth.profileId}): ${JSON.stringify(data)}`,
    );
  }

  return content;
}
