# OpenClaw Architecture Review

*Author: Scaff — based on source analysis and architectural discussion with Serj*
*Date: 2026-02-28*
*Scope: Original OpenClaw runtime — does NOT cover Router, Cortex, or Hippocampus extensions*

---

## 1. Overview

OpenClaw is a **self-hosted Node.js gateway** (Node 24+) that runs as a single process on your machine and acts as the bridge between messaging apps and AI agents. It listens on port 18789 and handles everything — channel connections, agent sessions, tool execution, automation, and the web UI — in one process with no external service dependencies beyond an API key.

**Core value proposition:**
- Self-hosted: runs on your hardware, your rules
- Multi-channel: one gateway serves WhatsApp, Telegram, Discord, and more simultaneously
- Agent-native: built for AI agents with tool use, sessions, memory, and multi-agent routing
- Open source: MIT licensed

---

## 2. Gateway Core

The heart of OpenClaw is `src/gateway/`. It runs:

- **HTTP server** (REST + WebSocket on port 18789) — serves the Web Control UI and handles all WebSocket commands (`chat.*`, `sessions.*`, `node.*`, `config.*`, `cron.*`, etc.)
- **Plugin loader** — each channel is a plugin loaded at startup; the gateway manages their lifecycle
- **Hook system** (`src/hooks/`) — internal lifecycle events (`gateway:startup`, `command`, `agent:bootstrap`, `session-memory`, etc.) that allow behavior injection without modifying core files
- **Server startup/close** (`server-startup.ts`, `server-close.ts`) — orchestrate initialization and teardown order across all subsystems

The gateway is the single source of truth for sessions, routing, channel connections, and configuration.

---

## 3. Channels (Plugin Model)

Each messaging channel is a separate module under `src/` or loaded as an extension package:

| Channel | Implementation |
|---------|---------------|
| WhatsApp | Baileys (reverse-engineered WhatsApp Web) |
| Telegram | Telegram Bot API |
| Discord | discord.js |
| Signal | Signal CLI |
| Slack | Slack Web API |
| iMessage | BlueBubbles |
| IRC, LINE, Matrix, Mattermost, etc. | Provider-specific SDKs |

**What each channel plugin does:**
1. Connects to the external service
2. Normalizes inbound messages into a common internal format
3. Routes them to `dispatchInboundMessage()` in the gateway
4. Receives outbound replies and delivers them back via the provider

WhatsApp specifically uses Baileys with a large pre-key store stored under `agents/<id>/agent/`. This store must never be deleted — losing it requires a full re-link.

Channel plugins can also register their own **tools** (e.g., WhatsApp plugin adds `whatsapp_login`) that the LLM can call.

---

## 4. Agent Model

An **agent** in OpenClaw is an isolated AI persona with its own:

- **Workspace** — a directory of markdown files that form the agent's identity and memory (`SOUL.md`, `MEMORY.md`, `USER.md`, `AGENTS.md`, `TOOLS.md`, `HEARTBEAT.md`, etc.)
- **Session history** — JSONL files under `agents/<id>/sessions/` keyed by session key
- **Auth profiles** (`auth-profiles.json`) — which API keys and providers the agent can use, with rotation and cooldown tracking
- **Config block** in `openclaw.json` — tool policy (allow/deny), memory settings, skill list, subagent limits, model overrides

The default agent is `main`. Multiple agents can be defined in `openclaw.json`, each with different personas, workspaces, and capabilities.

### The Embedded Pi Agent Runner

The AI runner is called the **embedded Pi agent** (`runEmbeddedPiAgent` in `src/agents/pi-embedded-runner.ts`), built on `@mariozechner/pi-ai`. It:

1. Assembles the system prompt from workspace files
2. Injects session history (last N messages, rolling window)
3. Resolves the auth profile and LLM provider
4. Calls the LLM, streaming the response
5. Intercepts tool calls, executes them, feeds results back
6. Persists the turn to the session JSONL file
7. Delivers the reply to the channel

---

## 5. Sessions

A **session** is a conversation scoped to one agent + channel + sender combination.

- **Session key format:** `agent:<agentId>:<channel>:<senderId>` — e.g., `agent:main:whatsapp:+40751845717`
- **Storage:** JSONL files at `agents/<id>/sessions/<sessionKey>.jsonl`
- **History management:** Truncated to a rolling window before each LLM call to manage context budget. Compaction runs when the window fills.
- **Reset:** `/reset` command clears the session history for the current channel

Sessions are ephemeral in the LLM's context window but permanent on disk. The JSONL file is the source of truth for replay and audit.

---

## 6. Memory (Original Design)

Original OpenClaw memory is **static file injection**. On each turn, the system prompt is assembled by reading workspace files:

| File | Purpose |
|------|---------|
| `SOUL.md` | Persona, identity, tone |
| `MEMORY.md` | Long-term notes, curated facts |
| `USER.md` | User preferences, contact info |
| `AGENTS.md` | Workspace rules, operating conventions |
| `TOOLS.md` | Local environment notes, tool config |
| `HEARTBEAT.md` | Periodic task checklist |

These files are read fresh on every turn and prepended to the system prompt. No database, no embeddings, no vector search — plain markdown on disk. Simple and portable.

**Limitation:** Memory is limited to what fits in the context window and what was manually written to files. No automatic fact extraction, no graceful degradation, no cold storage.

---

## 7. Routing

`src/routing/` handles how inbound messages are directed:

- **Channel routing** — which agent handles which channel and sender
- **Multi-agent routing** — messages can be routed to different agents based on rules (sender, group, keyword, etc.)
- **Auto-reply** — automatic responses for specific patterns without invoking the LLM
- **Group messages** — special handling for group chats: mention detection, silence rules, reaction behavior
- **Subagent routing** — spawned agents get isolated sessions with their own session keys

---

## 8. Tools

### 8.1 What Tools Are

Tools are **executable functions the LLM can call mid-conversation** to interact with the real world. They are hardcoded into the OpenClaw runtime — adding a new tool requires modifying source code. They are not configurable via markdown or config files.

When the LLM decides to use a tool, it emits a tool call block in its response. OpenClaw intercepts it, executes the handler, feeds the result back as a `tool_result`, and the LLM continues.

### 8.2 Tool Definition Structure

Every tool is a TypeScript module under `src/agents/tools/`. Each exports a `create*Tool()` factory that returns an `AnyAgentTool` object with:

- `name` — the string identifier the LLM uses to call it
- `description` — what the LLM sees; drives when it decides to call the tool
- `schema` — JSON Schema defining valid input parameters
- `execute(args, context)` — the actual implementation

### 8.3 Tool Catalog

`src/agents/tool-catalog.ts` is the static registry of all core tools, organized into sections:

| Section | Tools |
|---------|-------|
| Files | `read`, `write`, `edit` |
| Runtime | `exec`, `process` |
| Web | `web_search`, `web_fetch` |
| Memory | `memory_search`, `memory_get` |
| Sessions | `sessions_list`, `sessions_send`, `sessions_history`, `sessions_spawn` |
| UI | `browser`, `canvas` |
| Messaging | `message`, `tts` |
| Automation | `cron`, `gateway` |
| Nodes | `nodes` |
| Agents | `agents_list`, `subagents`, `session_status` |
| Media | `image` |

Each tool entry declares which **profiles** include it: `minimal`, `coding`, `messaging`, `full`. Profiles are preconfigured bundles — e.g., the coding profile includes file + runtime + web tools.

### 8.4 Plugin Tools

Plugins can register their own tools via `src/plugins/tools.ts` → `resolvePluginTools()`. These are namespaced under `plugin:<pluginId>` and merged into the tool list alongside core tools. Example: WhatsApp plugin adds `whatsapp_login`.

### 8.5 Tool Factory Pattern — Why Context Is Injected at Construction

All tools are instantiated together in `src/agents/openclaw-tools.ts` via `createOpenClawTools()`. This factory receives full runtime context and wires it into each tool's closure:

```
agentSessionKey, agentChannel, agentAccountId, agentTo, agentThreadId,
agentDir, workspaceDir, sandboxRoot, fsPolicy, config, ...
```

**Why at construction time, not at execute time:**

The alternative — passing context into every `execute(args, context)` call — would require every call site to assemble the full context object (channel, session key, workspace, config, account ID, thread ID...). By injecting at factory time, `execute(args)` stays clean. The context lives in the closure. Each tool instance is scoped to exactly one agent, one session, one channel for the duration of that turn.

Tools are created **fresh per turn or per session start** — if two users message simultaneously from different channels, each gets their own tool instances. No shared mutable state between sessions.

### 8.6 Tool Policy Pipeline

Before tools reach the LLM, they pass through `src/agents/tool-policy-pipeline.ts`. Rules applied in order:

1. **Tool profile** — start from the base set (`full`, `coding`, etc.)
2. **`tools.allow`** in `openclaw.json` — explicit allowlist
3. **`tools.deny`** in `openclaw.json` — explicit denylist
4. **Group-level policy** — group chats can restrict tools further
5. **Subagent policy** — spawned agents inherit a restricted subset
6. **Dangerous tools default deny** — `gateway` and others denied by default in HTTP contexts

The result is the effective tool list for that specific agent, session, and channel.

### 8.7 Tool Execution Lifecycle

Full lifecycle of one tool call:

```
1. Pi agent calls LLM with tool definitions in the tools array
2. LLM returns: { type: "toolCall", name: "exec", args: { command: "node -v" } }
3. pi-embedded-subscribe.handlers.tools.ts intercepts it
4. Looks up the tool by name in the active tool list
5. Runs before-tool-call hooks — e.g., exec approval gate
6. Calls tool.execute(args) — sync or async
7. Result wrapped as tool_result block, appended to conversation
8. LLM gets another turn with the result in context
9. Continues until no more tool calls → final text response
```

Failures are returned as `tool_result` errors so the LLM can recover or explain.

### 8.8 Security Layers

Tools have multiple security checkpoints:

- **Exec approval** — `exec` and `process` can require user confirmation before running (configurable per agent)
- **Filesystem policy** (`tool-fs-policy.ts`) — `read`/`write`/`edit` sandboxed to allowed paths; agent cannot read outside its workspace without explicit permission
- **Dangerous tools default deny** (`src/security/dangerous-tools.ts`) — `gateway` denied in HTTP contexts by default
- **Subagent depth limits** — spawned agents cannot infinitely recurse; depth tracked and capped
- **Loop detection** (`tool-loop-detection.ts`) — same tool + same args called repeatedly is detected and killed

### 8.9 HTTP Invoke Path

Tools can also be invoked directly via `POST /tools/invoke` — used by the Control UI, external scripts, or automation. This goes through `tools-invoke-http.ts`, which authenticates the request, applies the same policy pipeline, calls `tool.execute()`, and returns the result as JSON. Same tools, same policy, different entry point.

### 8.10 Architectural Critique: Tools Holding Delivery Context

**The current design conflates two responsibilities:** tool logic (computation) and routing (where to send the result). The `message` tool has channel credentials baked into its closure — it can fire directly to WhatsApp without the gateway inspecting or approving the delivery.

**Security implications:**

- **Prompt injection → direct channel access.** Malicious content ingested via `web_fetch` or a document can manipulate the LLM into calling `message` with arbitrary content. The tool fires immediately — no checkpoint, no gateway validation.
- **No single enforcement point.** Routing logic is scattered across tool implementations. There is no central authority asking: "is this outbound delivery authorized for this session, this channel, at this moment?"
- **Tools hold keys they shouldn't.** The `read` tool has no business holding a WhatsApp connection handle, but because context is bundled at factory time, the boundary between "what this tool needs" and "what this session has access to" is blurry.
- **Audit gap.** Outbound delivery through tools is not centrally logged. You'd need to instrument every tool individually.

**The cleaner model — gateway-mediated dispatch:**

Tools would produce *intents* (untrusted LLM output), not deliveries:
```ts
{ type: "deliver", channel: "whatsapp", message: "..." }
```
The gateway would validate and execute the intent. This gives:

- **Single enforcement point** — one place for content policy, rate limiting, session-channel authorization
- **Principle of least privilege** — tools get only computation context, never channel credentials
- **Mediated access** — the LLM never touches channel delivery directly; the gateway is the gatekeeper
- **Centralized audit trail** — all outbound delivery is a gateway decision, logged in one place
- **Cross-session isolation** — gateway can verify a tool result from session A isn't dispatched to session B's channel

This refactor is non-trivial but architecturally correct. The gateway already knows the active session and channel — it's redundant and insecure for tools to also carry that information.

---

## 9. Skills

### 9.1 What Skills Are

Skills are **knowledge packages** — a `SKILL.md` file (plus optional scripts and assets) that tells the agent how to use its existing tools for a specific domain. They do not add executable capability. They add instructions.

Skills live under `~/.openclaw/skills/` and are installed from ClawHub or dropped in manually.

### 9.2 How Skills Work

On each turn, the available skill descriptions are present in the system prompt. The agent scans them, identifies if one clearly applies to the current request, reads that skill's `SKILL.md`, and follows its instructions for the turn.

A skill can instruct the LLM to:
- Use specific tools in a specific order
- Hit specific URLs with `web_fetch`
- Parse responses in a specific way
- Format output in a specific style
- Chain multiple tool calls to accomplish a goal

### 9.3 Tools vs Skills

| Dimension | Tools | Skills |
|-----------|-------|--------|
| What | Executable functions | Instructional documents |
| Who defines | OpenClaw runtime (TypeScript) | Community / user (Markdown) |
| How added | Source code change | `clawhub install` or drop a folder |
| What they give | New capability | Better behavior with existing capabilities |
| LLM interaction | LLM calls them | LLM reads and follows them |
| Security surface | Execution, filesystem, network | None — markdown only |

**Key insight:** Tools are hands. Skills are training manuals for how to use those hands.

**When writing a skill:** you must know which tools are enabled for the target agent. A skill that instructs the LLM to run a shell command will fail silently if `exec` is denied. Skills are only as reliable as the tools they depend on.

---

## 10. Automation

### Cron Jobs
SQLite-backed scheduler (`src/cron/`). Jobs run at exact intervals or cron expressions, fire system events or `agentTurn` prompts into sessions. Supports isolated sessions (separate context from main). Used for reminders, scheduled checks, periodic agent work.

### Heartbeats
Periodic polls to the main session matching a configured prompt. The agent checks `HEARTBEAT.md` and responds with work or `HEARTBEAT_OK`. Lightweight alternative to cron for batching periodic checks that don't need exact timing.

### Webhooks
HTTP endpoints that can trigger agent turns or system events when called externally.

### Hooks
Internal lifecycle events (`src/hooks/`) — `gateway:startup`, `command`, `agent:bootstrap`, `session-memory`, etc. Allow behavior injection at key points without modifying core files. Used internally and by plugins.

---

## 11. Web Control UI

Browser dashboard served at `http://127.0.0.1:18789`. Built on the WebSocket protocol (`chat.*` commands). Provides:

- Chat interface across all sessions
- Config editor (live, schema-validated)
- Session list and history
- Cron job manager
- Node management (paired iOS/Android devices)
- Tool catalog browser
- Model selector

The webchat interface is also the entry point for Cortex (live mode) — messages sent through the Control UI are processed by Cortex when `webchat: "live"` is configured.

---

## 12. Mobile Nodes

iOS and Android devices can be paired as **nodes** via the OpenClaw app. Paired nodes expose:
- Camera (snap, clip, list)
- Screen recording
- Location
- System notifications
- Remote command execution

Accessible via the `nodes` tool — the LLM can take a photo, check the device location, or send a notification as part of a tool chain.

---

## 13. Config (`openclaw.json`)

Single config file governing everything:
- Agents (workspace dir, tools allow/deny, memory settings, auth profiles, skill list, model overrides, subagent limits)
- Channels (which plugins are active, per-channel settings)
- Plugins (enabled, slots, trust)
- Providers (model catalog, API base URLs)
- Cron jobs
- Routing rules
- Security (exec approval policy, dangerous tool overrides)

Strictly schema-validated — no unknown fields accepted. Partial updates via `config.patch` merge safely; full replacement via `config.apply` validates before writing. Both trigger a gateway restart.

---

## 14. Summary

```
openclaw.json
    ↓ config
Gateway (port 18789)
    ├── Channel Plugins (WhatsApp, Telegram, Discord, ...)
    │       ↓ dispatchInboundMessage()
    ├── Agent Runner (Pi embedded)
    │       ├── System prompt (workspace files)
    │       ├── Session history (JSONL)
    │       ├── Tool policy pipeline
    │       └── LLM call → tool interception → tool execution → reply
    ├── Automation (cron, heartbeat, webhooks, hooks)
    ├── Web Control UI (WebSocket + HTTP)
    └── Mobile Nodes (camera, screen, location)
```

OpenClaw's strength is in its breadth — one process, many channels, rich tooling, flexible automation. Its main architectural debt is the coupling of routing/delivery context into tool closures, which creates a security gap between LLM output and channel delivery. A gateway-mediated dispatch layer would address this.
