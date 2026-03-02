# Cortex Architecture

*Version: 1.0 — 2026-02-26*
*Status: Approved*
*Authors: Serj & Scaff*

---

## 1. What Is Cortex

Cortex is the singular cognitive core of an OpenClaw agent. It is not a chatbot instance. It is not a session. It is the agent — one brain with peripheral I/O.

When Serj sends a message on WhatsApp, he doesn't become a different Serj. The medium changes, he doesn't. Cortex operates the same way. A message arriving on WhatsApp, webchat, Telegram, or from a sub-agent result — all feed into the same Cortex. Channels are tools for carrying messages, not boundaries of awareness.

**Core principle:** There is one Cortex. Everything else is a peripheral.

---

## 2. Current Architecture (Pre-Cortex)

```
┌──────-───────┐   ┌─────────────┐   ┌─────────────┐
│  WhatsApp    │   │   Webchat   │   │  Telegram   │
│  Channel     │   │   Channel   │   │  Channel    │
└──────┬───────┘   └──────┬──────┘   └────-──┬─────┘
       │                  │                  │
       ▼                  ▼                  ▼
┌───────────-──┐   ┌─────────────┐   ┌─────────────┐
│  Session A   │   │  Session B  │   │  Session C  │
│  (isolated)  │   │  (isolated) │   │  (isolated) │
│  Own context │   │  Own context│   │  Own context│
│  Own history │   │  Own history│   │  Own history│
└──────┬───────┘   └──────┬──────┘   └────-──┬─────┘
       │                  │                  │
       └──────────────────┼──────────────────┘
                          │
                    ┌─────▼──────┐
                    │ Shared     │
                    │ Workspace  │
                    │ (files)    │
                    └────────────┘
```

**Problem:** Each channel creates a separate LLM instance with its own conversation history. They share workspace files (SOUL.md, MEMORY.md), but have no shared awareness. WhatsApp-Scaff doesn't know what webchat-Scaff just discussed. They are clones with a shared filing cabinet, not one mind.

Sub-agents are even more isolated — spawned sessions with separate contexts that must deliver results through file-based or event-based handoff, with no guarantee Cortex is aware of the result in the context where it matters.

---

## 3. Cortex Architecture

```
                    ┌─────────────────────────┐
                    │         CORTEX           │
                    │                          │
                    │   Unified Awareness      │
                    │   Single Session State   │
                    │   Decision Engine        │
                    │                          │
                    └────────────┬─────────────┘
                                 │
                    ┌────────────┼─────────────┐
                    │      Message Bus         │
                    │  (ingest, tag, queue)     │
                    └────────────┬─────────────┘
                                 │
          ┌──────────┬───────────┼───────────┬──────────┐
          │          │           │           │          │
     ┌────▼───┐ ┌───▼────┐ ┌───▼────┐ ┌───▼────┐ ┌───▼────┐
     │WhatsApp│ │Webchat │ │Telegram│ │ Router │ │Sub-    │
     │  I/O   │ │  I/O   │ │  I/O   │ │  I/O   │ │agent   │
     │        │ │        │ │        │ │        │ │  I/O   │
     └────────┘ └────────┘ └────────┘ └────────┘ └────────┘
```

### 3.1 One Brain

Cortex maintains a single session state. All incoming messages — regardless of source channel — are ingested into this unified state. Cortex doesn't have "a WhatsApp conversation" and "a webchat conversation." It has awareness, and messages arrive into it from different peripherals.

### 3.2 Channels Are Peripherals

A channel is an I/O adapter. It:

- **Receives** a message from the external world (user, API, sub-agent)
- **Tags** the message with metadata (source channel, sender identity, timestamp, reply-to context)
- **Delivers** it to the Cortex message bus
- **Transmits** Cortex's outbound messages to the appropriate destination

A channel has no session. A channel has no context. A channel is a pipe.

Examples of channels:
| Channel | Direction | Who |
|---------|-----------|-----|
| WhatsApp | Bidirectional | Serj, contacts |
| Webchat | Bidirectional | Serj |
| Telegram | Bidirectional | Serj, groups |
| Router | Inbound (results) + Outbound (dispatch) | Internal |
| Sub-agent | Inbound (results) + Outbound (spawn) | Internal |
| Cron/Heartbeat | Inbound (triggers) | System |
| Email | Bidirectional | External parties |

### 3.3 Message Envelope

Every message entering Cortex carries an envelope:

```
{
  channel: "whatsapp" | "webchat" | "telegram" | "router" | "subagent" | "cron" | ...,
  sender: {
    id: "serj" | "router:job-123" | "subagent:rt05" | "system",
    name: "Serj" | "Router" | "Heartbeat",
    relationship: "partner" | "internal" | "external" | "system"
  },
  timestamp: "2026-02-26T14:35:00+02:00",
  replyContext: {
    channel: "whatsapp",       // where to send reply
    threadId: "...",           // if applicable
    messageId: "..."           // for reply-to threading
  },
  content: "...",
  priority: "normal" | "urgent" | "background"
}
```

The envelope tells Cortex not just *what* was said, but *who* said it, *where* it came from, and *where* a reply should go. Cortex uses this to make decisions.

### 3.4 The Decision Engine

For every ingested message, Cortex decides:

1. **Respond or not?** — A casual group chat message might warrant silence. A direct question from Serj always gets a response. A Router result might just need logging.

2. **Where to respond?** — Usually the source channel. But Cortex could decide to respond on a different channel (e.g., receive a cron trigger, send an alert to WhatsApp).

3. **Log or not?** — Significant events get written to memory. Routine acknowledgments don't.

4. **Escalate or defer?** — Urgent messages get immediate attention. Background results get queued for the next natural pause.

5. **Act or wait?** — Some messages require immediate action (spawn a sub-agent, send a reply). Others are informational (a sub-agent completed, note it and continue).

This is not rule-based routing. This is Cortex using judgment — the same way a human reads a notification and decides whether to respond now, later, or never.

### 3.5 Unified Awareness

Cortex is aware of all its active peripherals and pending operations:

- "Serj is talking to me on webchat right now"
- "I have 3 Router jobs in flight (rt01, rt03, rt05)"
- "A WhatsApp message from 10 minutes ago is still unanswered"
- "The heartbeat is due in 15 minutes"
- "A sub-agent just completed task X — I should tell Serj"
- "Router job rt02 failed — I need to tell Serj that task didn't complete"

This awareness is maintained in the unified session state, not scattered across isolated sessions that don't know about each other.

Operations in flight are tracked as **pending ops** with an inbox read/unread pattern:
- `[PENDING]` — task is still running, Cortex is waiting for a result
- `[NEW RESULT]` — result just arrived, Cortex hasn't processed it yet (unread)
- `[FAILED]` — task failed, Cortex hasn't informed the user yet (unread)

After Cortex processes a turn and "reads" any new results or failures, those ops are acknowledged and drop from the awareness window. This prevents stale entries from polluting the context indefinitely.

---

## 4. The Context Window Problem

An LLM has a finite context window. One brain seeing all channels means more input competing for limited space. This is not a flaw — it's the same constraint biological brains have. The solution is the same: **attention**.

### 4.1 Attention & Compression

Not everything stays in active context. Cortex manages its window through:

| Layer | What | Retention | Size |
|-------|------|-----------|------|
| **Active Context** | Current conversation turn, recent messages across all channels | Immediate | Context window |
| **Working Memory** | Recent cross-channel state, pending operations, active threads | Session duration | Compressed summaries |
| **Long-Term Memory** | Curated facts, identity, preferences, project state | Persistent | Workspace files |

When the active context fills, older messages get compressed into working memory summaries. Cortex doesn't forget — it summarizes, like a human who remembers "we discussed X this morning" without recalling every word.

### 4.2 Channel Priority in Context

Not all channel messages deserve equal context space:

- **Direct messages from Serj** — highest priority, always in active context
- **Sub-agent/Router results** — high priority when awaited, summarizable after processing
- **Group chat messages** — low priority, compressed aggressively unless Cortex is mentioned
- **System/cron triggers** — minimal context footprint, processed and released

### 4.3 Serialization

Messages from different channels arriving simultaneously must be serialized. Cortex processes one message at a time (LLM inference is sequential), but the message bus queues and orders them:

1. Urgent messages first (direct from Serj, critical alerts)
2. Awaited results (sub-agent completions Cortex is expecting)
3. Normal priority (routine channel messages)
4. Background (heartbeats, non-urgent notifications)

If Serj sends a message on WhatsApp while Cortex is processing a webchat message, the WhatsApp message waits in the bus. Cortex finishes the current turn, then processes the WhatsApp message with full awareness of what just happened on webchat.

---

## 5. Output Routing

Cortex doesn't just receive from all channels — it decides where to send.

### 5.1 Default: Reply to Source

Most messages get a reply on the channel they arrived from. Serj asks on WhatsApp → Cortex replies on WhatsApp.

### 5.2 Cross-Channel

Cortex can proactively send to any channel:

- Receive a cron trigger → send an alert to WhatsApp
- Receive a sub-agent result → send a summary to webchat where Serj is active
- Detect something in email → message Serj on WhatsApp

### 5.3 Multi-Channel

A single decision can produce output on multiple channels:

- Log the event to memory (internal)
- Notify Serj on WhatsApp (external)
- Update a status file (internal)

### 5.4 No Output

Some messages need no reply at all. A Router job logging its completion, a heartbeat with nothing to report, a group chat message that doesn't need Cortex's input. Silence is a valid output.

---

## 6. Sub-Agents & The Router

Under Cortex architecture, sub-agents and the Router are not separate systems — they are Cortex's hands.

### 6.1 Dispatching

When Cortex decides to delegate a task (via Router or direct sub-agent spawn), it:

1. Notes in its unified state: "I dispatched task X via Router, expecting result"
2. Sends the dispatch through the Router/sub-agent I/O channel
3. Continues processing other messages (non-blocking)

### 6.2 Receiving Results

When a result arrives back through the sub-agent I/O channel:

1. Cortex receives it with full awareness of *why* it was dispatched
2. Decides what to do: relay to Serj, store silently, trigger follow-up
3. No session mismatch — the result enters the same unified state where the dispatch happened

### 6.3a Handling Failures

When a dispatched task fails (Router evaluator crash, worker error, hung job):

1. The Router emits a `job:failed` event
2. Cortex marks the pending op as `failed` with the error details — but does NOT hide it
3. On the next LLM turn, Cortex sees `[FAILED] task description — Error: reason. Inform the user that this task failed.` in its System Floor
4. Cortex tells the user the task failed
5. After that LLM turn, the failure is acknowledged (marked as "read") and drops from the System Floor

**Startup safety net:** If the process crashed before a `job:failed` event could fire, any orphaned pending ops are detected on restart and marked failed with `"orphaned from prior session"`. They remain visible for one LLM turn so the user is informed.

Failed ops are never deleted from the database — they stay as `status = 'failed'` for auditability. They are not retried by Cortex (the Router has its own retry logic with max 2 retries before permanent failure).

### 6.3 The Router as Internal Channel

The Router is just another channel. It happens to be internal, but architecturally it's no different from WhatsApp:

- **Outbound:** Cortex sends a task (like sending a message)
- **Inbound:** Cortex receives a result (like receiving a reply)
- **Metadata:** Job ID, tier, model used, execution time
- **Decision:** What to do with the result

---

## 7. Identity Implications

Cortex is not a new component bolted onto OpenClaw. It's a reframing of what the agent *is*.

- **Scaff** is the identity — name, personality, values, memory
- **Cortex** is the architecture — how that identity processes and routes information
- **Channels** are the peripherals — how the world reaches Cortex and vice versa
- **Sessions** cease to be per-channel — there is one Cortex session, period

This means:

- Cortex wakes up once, not once-per-channel
- Cortex has one conversation history, not N isolated ones
- Cortex's context includes awareness of all active channels
- Cortex's memory is not "shared files between clones" — it's just... memory

---

## 8. Migration Path

Moving from the current multi-session architecture to Cortex is non-trivial. Key changes:

### 8.1 Gateway Changes
- Session resolution: all channels for the same agent resolve to ONE session
- Message bus: queue + tag incoming messages with channel metadata
- Serialization: ensure sequential processing with priority ordering

### 8.2 Context Management
- Implement compression/summarization for cross-channel context
- Channel-aware context budgeting (how much window each channel gets)
- Working memory layer between active context and long-term files

### 8.3 Output Routing
- Cortex responses tagged with target channel(s)
- Gateway routes outbound messages to correct channel adapters
- Support for multi-channel output from a single Cortex turn

### 8.4 Sub-Agent Integration
- Sub-agent results feed back into Cortex's unified session
- Dispatch tracking in unified state (what's in flight, what's expected)
- Router becomes a channel adapter, not a parallel system

---

## 9. Design Principles

1. **One brain.** Never clone Cortex across sessions. One instance, one state, one awareness.

2. **Channels are dumb pipes.** They carry messages in and out. They don't hold state, context, or session history.

3. **Metadata over magic.** Every message carries an envelope. Cortex makes decisions based on explicit metadata, not implicit session boundaries.

4. **Attention is finite.** Context window management is a first-class concern, not an afterthought. Compression and prioritization are core mechanisms.

5. **Silence is valid.** Not every message needs a response. Cortex decides. The architecture must support "no output" as a natural outcome.

6. **Awareness over isolation.** Cortex should always know what it has in flight, what channels are active, and what's pending — even if the details are compressed.

---

## 10. Open Questions

- **Concurrency model:** ~~What happens when two urgent messages arrive simultaneously? Strict serialization, or can Cortex batch-process?~~ **Decided: Strict serialization.** Messages are processed one at a time, in priority order. No batch-processing.
- **Context budget allocation:** ~~How to dynamically allocate context window space across channels? Fixed ratios? Demand-based?~~ **Decided: Tiered attention model with 4 layers:**
  1. **System floor** (~10-15%) — Identity, memory, workspace context, active operations state. Always loaded. Non-negotiable.
  2. **Foreground** — Active channel conversation. Demand-based, no artificial cap. Takes what it needs.
  3. **Background** — Other channels with recent activity. Compressed to one-line summaries. Cheap peripheral awareness.
  4. **Archived** — Inactive channels. Not in context. Zero cost. Retrievable on demand.
  
  Foreground is demand-based; it expands into space that Background/Archived don't need. No fixed ratios.
  
  **Note:** Facts and memories flow between these layers (Foreground knowledge becomes System floor, stale System context gets Archived, etc.). Memory management across layers is a separate architecture discussion — see future `memory-flow-architecture.md`.
- **State persistence:** ~~If Cortex crashes mid-turn, how is the unified state recovered? The message bus needs durability (SQLite?).~~ **Decided: SQLite-backed message bus + checkpointing.**
  - **Survives crash:** Unprocessed messages in bus, last channel states, pending operations (Router jobs, sub-agents), conversation history up to last completed turn.
  - **Acceptable to lose:** Mid-turn reasoning (retry the whole turn on restart).
  - **Storage:** SQLite (WAL mode), same as Router queue. Single file, no external dependencies.
  - **Recovery:** Cortex restarts → loads System floor from workspace → reads unprocessed messages from SQLite bus → rebuilds channel state from last checkpoints → resumes processing.
  - **Checkpoint:** After each completed turn.
- **Multi-agent Cortex:** ~~If Serj runs multiple agents (main + specialized), do they share a Cortex or each have their own?~~ **Decided: 1 OpenClaw = 1 Agent = 1 Cortex.** No multi-agent. Scaff is the single agent on this instance. Sub-agents (like `router-executor`) are spawned workers, not independent agents — they have no Cortex, no channels, no identity.
- **Channel handoff:** ~~If Serj starts a conversation on webchat and continues on WhatsApp, how does Cortex handle the thread continuity?~~ **Non-issue.** Solved by design. One brain, one session — there is no handoff. Cortex replies to whichever channel the latest message came from (`replyContext` in the envelope). Like talking to someone in person and then continuing on the phone — same conversation, different medium.
- **Token economics:** ~~Unified context means larger context per turn. Cost implications need modeling.~~ **Deferred.** Will be addressed together with memory architecture refactor — token costs are directly tied to how memory flows between the 4 context layers (System floor → Foreground → Background → Archived). See future `memory-flow-architecture.md`.

---

*This document describes the target architecture. Implementation requires changes to the OpenClaw gateway, session management, and context handling. See migration path (§8) for phased approach.*
