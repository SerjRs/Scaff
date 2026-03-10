# Cortex Context Metadata — Sender Identity & Tool Message Gaps

*Created: 2026-03-10*
*Status: Not Started*
*Ref: `src/cortex/llm-caller.ts` lines 190-235, `src/cortex/context.ts`*

---

## Problem

Cortex builds its foreground context with a metadata prefix on each message:

```
[2026-03-10 10:45:41:agent:main:cortex:whatsapp] message body
```

Format: `[timestamp:issuer:channel] body`

Two issues with this:

1. **`issuer` doesn't identify the sender.** The `issuer` field is always the same value (`agent:main:cortex`) for both user messages and Cortex's own responses. Cortex relies solely on the Anthropic API `role` field (`user` vs `assistant`) to distinguish direction — the prefix gives no indication of who actually sent the message.

2. **Tool messages have no metadata at all.** When content is a structured JSON array (tool_use/tool_result blocks), the prefix is skipped entirely. Cortex has zero context about when a tool was called, from which channel, or who triggered it.

---

## Root Cause

**File:** `src/cortex/llm-caller.ts`, function `contextToMessages()`, lines ~190-235

```typescript
.map((msg) => {
  let content: string | unknown[] = msg.content;

  // Step 1: try parsing JSON-serialized structured content
  if (typeof content === "string" && content.startsWith("[")) {
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        content = parsed;  // ← content becomes an ARRAY
      }
    } catch { /* not JSON — keep as string */ }
  }

  // Step 2: prefix — ONLY for strings, arrays skip this
  if (typeof content === "string") {
    const ts = msg.timestamp?.replace("T", " ").replace(/\.\d+Z$/, "") ?? "";
    content = `[${ts}:${msg.issuer ?? "unknown"}:${msg.channel}] ${content}`;
  }

  return { role: msg.role as "user" | "assistant", content };
});
```

**Flow for regular text messages:**
1. Content is a string (e.g., `"hey Scaff"`)
2. Doesn't start with `[` or isn't valid JSON → stays a string
3. Prefix applied → `[2026-03-10 10:45:41:agent:main:cortex:whatsapp] hey Scaff`
4. ✅ Has metadata — but `issuer` is wrong (same for both directions)

**Flow for tool messages:**
1. Content is a string starting with `[` (JSON-serialized blocks)
2. Parsed successfully → content becomes an array: `[{type: "tool_use", ...}]`
3. `typeof content === "string"` is `false` → prefix **skipped**
4. ❌ No timestamp, no channel, no sender

---

## Issue 1: `issuer` Doesn't Identify the Sender

Both user and assistant messages have the same `issuer` value:

```
role=user:      [2026-03-10 10:45:41:agent:main:cortex:whatsapp] hey Scaff
role=assistant: [2026-03-10 10:45:43:agent:main:cortex:whatsapp] Here's what I found
```

The `issuer` field means "which Cortex instance owns this session" — it's a filter key, not a sender identifier. The actual sender info is in:
- `msg.role` → `"user"` or `"assistant"`
- `msg.senderId` → e.g., `"+40751845717"` for user messages

But `msg.senderId` is not used in the prefix. Cortex sees `agent:main:cortex` for everything.

### Fix

Replace `msg.issuer` with actual sender identity:

```typescript
if (typeof content === "string") {
  const ts = msg.timestamp?.replace("T", " ").replace(/\.\d+Z$/, "") ?? "";
  const sender = msg.role === "assistant" ? "cortex" : (msg.senderId || "user");
  content = `[${ts}:${sender}:${msg.channel}] ${content}`;
}
```

**Before:**
```
[2026-03-10 10:45:41:agent:main:cortex:whatsapp] hey Scaff
[2026-03-10 10:45:43:agent:main:cortex:whatsapp] Here's what I found
```

**After:**
```
[2026-03-10 10:45:41:+40751845717:whatsapp] hey Scaff
[2026-03-10 10:45:43:cortex:whatsapp] Here's what I found
```

Now Cortex can distinguish who said what at a glance, even without relying on the API role field.

---

## Issue 2: Tool Messages Have No Metadata

Tool interactions are sent to the Anthropic API as structured JSON arrays. The API requires `tool_use` and `tool_result` as proper blocks, not text strings. You can't prepend `[timestamp:sender:channel]` to an array — it breaks the API format.

**Current output for tool messages:**

```json
// Assistant message (tool call)
{
  "role": "assistant",
  "content": [
    {"type": "tool_use", "id": "toolu_01...", "name": "code_search", "input": {"query": "..."}}
  ]
}

// User message (tool result)
{
  "role": "user",
  "content": [
    {"type": "tool_result", "tool_use_id": "toolu_01...", "content": "Found 5 results..."}
  ]
}
```

No timestamp, no channel, no sender context. Cortex cannot reason about:
- When the tool was called
- Which channel's conversation triggered it
- How long the tool took to execute
- Whether the tool call happened 5 minutes ago or 5 hours ago

### Fix

The Anthropic API allows mixing `text` and `tool_use`/`tool_result` blocks in the same message. Inject the metadata as a text block at the start of the array:

```typescript
// After parsing JSON array, inject metadata text block
if (Array.isArray(content)) {
  const ts = msg.timestamp?.replace("T", " ").replace(/\.\d+Z$/, "") ?? "";
  const sender = msg.role === "assistant" ? "cortex" : (msg.senderId || "user");
  content = [
    { type: "text", text: `[${ts}:${sender}:${msg.channel}]` },
    ...content,
  ];
}
```

**After fix — assistant tool call:**
```json
{
  "role": "assistant",
  "content": [
    {"type": "text", "text": "[2026-03-10 10:45:41:cortex:whatsapp]"},
    {"type": "tool_use", "id": "toolu_01...", "name": "code_search", "input": {"query": "..."}}
  ]
}
```

**After fix — user tool result:**
```json
{
  "role": "user",
  "content": [
    {"type": "text", "text": "[2026-03-10 10:45:42:+40751845717:whatsapp]"},
    {"type": "tool_result", "tool_use_id": "toolu_01...", "content": "Found 5 results..."}
  ]
}
```

---

## Implementation

### Changes in `src/cortex/llm-caller.ts`, function `contextToMessages()`

Replace the current prefix logic (lines ~230-235) with unified metadata injection that handles both strings and arrays:

```typescript
.map((msg) => {
  let content: string | unknown[] = msg.content;

  // Parse JSON-serialized structured content (tool round-trips)
  if (typeof content === "string" && content.startsWith("[")) {
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        content = parsed.map((block: any) => {
          // ... existing block normalization (toolCall → tool_use, etc.)
        }).filter(Boolean);
        if (content.length === 0) {
          content = "(internal processing)";
        }
      }
    } catch { /* not JSON — keep as string */ }
  }

  // Build metadata prefix — same format for both string and array content
  const ts = msg.timestamp?.replace("T", " ").replace(/\.\d+Z$/, "") ?? "";
  const sender = msg.role === "assistant" ? "cortex" : (msg.senderId || "user");
  const meta = `[${ts}:${sender}:${msg.channel}]`;

  if (typeof content === "string") {
    // Text messages: prepend as before
    content = `${meta} ${content}`;
  } else if (Array.isArray(content)) {
    // Tool messages: inject as text block at start of array
    content = [{ type: "text", text: meta }, ...content];
  }

  return { role: msg.role as "user" | "assistant", content };
});
```

---

## Files to Change

| File | Change |
|------|--------|
| `src/cortex/llm-caller.ts` | `contextToMessages()` — replace `msg.issuer` with sender identity, add metadata text block to tool message arrays |

Single file change. No schema changes. No DB changes.

---

## Test Criteria

1. **Text message prefix uses sender, not issuer:** User message shows `senderId`, assistant message shows `cortex`
2. **Tool message arrays include metadata text block:** First element is `{type: "text", text: "[ts:sender:channel]"}`
3. **Mixed content (text + tool_use) gets single metadata block:** No duplicate prefix
4. **Empty/null senderId falls back to `"user"`:** Graceful handling of missing sender
5. **Empty/null timestamp shows empty string:** `[:cortex:whatsapp]` instead of crash
6. **Existing `validateToolPairing()` still works:** Metadata text block doesn't break tool_use/tool_result pairing validation
7. **API accepts the format:** End-to-end test — Cortex makes a successful LLM call with metadata text blocks in tool messages
8. **No regression:** Existing cortex tests pass

---

## Priority

Low complexity, high value. Can be done independently of the unified context work (doc `02`) and the session corruption fix (doc `03`). Single file, ~20 lines changed.
