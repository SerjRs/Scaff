import fs from "node:fs";
import { Type } from "@sinclair/typebox";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import { optionalStringEnum } from "../schema/typebox.js";
import { SUBAGENT_SPAWN_MODES, spawnSubagentDirect, type ResolvedResource } from "../subagent-spawn.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

const ResourceSchema = Type.Object({
  type: Type.Union([Type.Literal("file"), Type.Literal("url"), Type.Literal("inline")]),
  path: Type.Optional(Type.String()),
  url: Type.Optional(Type.String()),
  content: Type.Optional(Type.String()),
  label: Type.Optional(Type.String()),
});

const SessionsSpawnToolSchema = Type.Object({
  task: Type.String(),
  label: Type.Optional(Type.String()),
  agentId: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  thinking: Type.Optional(Type.String()),
  runTimeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
  // Back-compat: older callers used timeoutSeconds for this tool.
  timeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
  thread: Type.Optional(Type.Boolean()),
  mode: optionalStringEnum(SUBAGENT_SPAWN_MODES),
  cleanup: optionalStringEnum(["delete", "keep"] as const),
  resources: Type.Optional(Type.Array(ResourceSchema)),
});

export function createSessionsSpawnTool(opts?: {
  agentSessionKey?: string;
  agentChannel?: GatewayMessageChannel;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
  agentGroupId?: string | null;
  agentGroupChannel?: string | null;
  agentGroupSpace?: string | null;
  sandboxed?: boolean;
  /** Explicit agent ID override for cron/hook sessions where session key parsing may not work. */
  requesterAgentIdOverride?: string;
}): AnyAgentTool {
  return {
    label: "Sessions",
    name: "sessions_spawn",
    description:
      'Spawn a sub-agent in an isolated session (mode="run" one-shot or mode="session" persistent) and route results back to the requester chat/thread.',
    parameters: SessionsSpawnToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const task = readStringParam(params, "task", { required: true });
      const label = typeof params.label === "string" ? params.label.trim() : "";
      const requestedAgentId = readStringParam(params, "agentId");
      const modelOverride = readStringParam(params, "model");
      const thinkingOverrideRaw = readStringParam(params, "thinking");
      const mode = params.mode === "run" || params.mode === "session" ? params.mode : undefined;
      const cleanup =
        params.cleanup === "keep" || params.cleanup === "delete" ? params.cleanup : "keep";
      // Back-compat: older callers used timeoutSeconds for this tool.
      const timeoutSecondsCandidate =
        typeof params.runTimeoutSeconds === "number"
          ? params.runTimeoutSeconds
          : typeof params.timeoutSeconds === "number"
            ? params.timeoutSeconds
            : undefined;
      const runTimeoutSeconds =
        typeof timeoutSecondsCandidate === "number" && Number.isFinite(timeoutSecondsCandidate)
          ? Math.max(0, Math.floor(timeoutSecondsCandidate))
          : undefined;
      const thread = params.thread === true;

      // Resolve resources
      const resolvedResources: ResolvedResource[] = [];
      const rawResources = params.resources as Array<{ type: string; path?: string; url?: string; content?: string; label?: string }> | undefined;
      if (Array.isArray(rawResources)) {
        for (const res of rawResources) {
          const name = typeof res.label === "string" ? res.label : "unnamed";
          if (res.type === "file" && typeof res.path === "string") {
            try {
              const content = fs.readFileSync(res.path, "utf-8");
              resolvedResources.push({ name, content });
            } catch {
              resolvedResources.push({ name, content: `[File not found: ${res.path}]` });
            }
          } else if (res.type === "url" && typeof res.url === "string") {
            resolvedResources.push({ name, content: `[URL: ${res.url}]` });
          } else if (res.type === "inline" && typeof res.content === "string") {
            resolvedResources.push({ name, content: res.content });
          }
        }
      }

      const result = await spawnSubagentDirect(
        {
          task,
          label: label || undefined,
          agentId: requestedAgentId,
          model: modelOverride,
          thinking: thinkingOverrideRaw,
          runTimeoutSeconds,
          thread,
          mode,
          cleanup,
          expectsCompletionMessage: true,
          resources: resolvedResources.length > 0 ? resolvedResources : undefined,
        },
        {
          agentSessionKey: opts?.agentSessionKey,
          agentChannel: opts?.agentChannel,
          agentAccountId: opts?.agentAccountId,
          agentTo: opts?.agentTo,
          agentThreadId: opts?.agentThreadId,
          agentGroupId: opts?.agentGroupId,
          agentGroupChannel: opts?.agentGroupChannel,
          agentGroupSpace: opts?.agentGroupSpace,
          requesterAgentIdOverride: opts?.requesterAgentIdOverride,
        },
      );

      return jsonResult(result);
    },
  };
}
