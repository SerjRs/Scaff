 # Hippocampus Memory Flow: Implementation & Testing Plan

---

## Safety Gate — `hippocampus.enabled` Flag

**All Hippocampus features are gated behind a single flag in `cortex/config.json`:**

```json
{
  "enabled": true,
  "defaultMode": "off",
  "channels": { "webchat": "live" },
  "hippocampus": {
    "enabled": false
  }
}
```

**When `hippocampus.enabled: false` (default):**
- Context assembly uses the pre-Hippocampus behavior — no soft caps, no hot memory injection, no layer changes
- `fetch_chat_history` and `memory_query` tools are NOT exposed to the LLM
- Gardener cron tasks do not run
- All existing tests continue to pass unchanged

**When `hippocampus.enabled: true`:**
- Full 4-layer context assembly activates
- Tools added to LLM caller tool list
- Gardener tasks scheduled via cron

**Hot-reload:** The flag is re-read from `cortex/config.json` on each context assembly cycle — no restart needed to toggle. If Hippocampus breaks webchat behavior, set `enabled: false` and the next message falls back to previous Cortex behavior immediately.

**Pre-condition for every task below:** The task must check `hippocampus.enabled` before activating. If false, the code path must be a no-op and fall through to previous behavior.

---

## Phase 1: Database Foundation & Hot Memory Setup

This phase establishes the storage infrastructure required before manipulating the LLM context window.

### Tasks

* **Task 1.1: Initialize Hot Memory Table.** Create the `cortex_hot_memory` SQLite table with columns: `id`, `fact_text`, `created_at`, `last_accessed_at`, and `hit_count`. Ensure `hit_count` defaults to 0.
* **Task 1.2: State Management Tables.** Ensure the existence and proper schema of `cortex_pending_ops` (for Layer 1) and `cortex_channel_states` (for Layer 3 summaries). `cortex_pending_ops` must include the `acknowledged_at TEXT` column for the inbox read/unread pattern (§6.5.1). Migration adds the column to existing tables.
* **Task 1.3: Vector DB Initialization.** Load the `sqlite-vec` extension into the existing SQLite connection. Create the virtual table for cold storage embeddings using `nomic-embed-text` dimensions (768). Same database file as `cortex_hot_memory` — single file, single backup.

### Unit Tests

* **`test_hot_memory_schema`**: Assert that the `cortex_hot_memory` table is created successfully and that inserting a row without a `hit_count` correctly defaults to 0.
* **`test_pending_ops_schema`**: Verify CRUD operations on the `cortex_pending_ops` table, including the `acknowledged_at` column. Assert that `getPendingOps()` returns `pending` ops and unacknowledged `completed` ops, but excludes acknowledged `completed` ops. Assert that `acknowledgeCompletedOps()` sets `acknowledged_at` on all unacknowledged completed ops.
* **`test_vector_db_init`**: Load `sqlite-vec` extension into an in-memory SQLite connection. Assert the virtual table is created with the correct dimensions (768) and that a mock embedding can be inserted and retrieved.

### Phase 1 E2E Test

* **`test_db_infrastructure_e2e`**: Boot up the database layer, insert a mock fact into `cortex_hot_memory`, insert a pending operation, and write a mock embedding to the Vector DB. Assert that all data can be successfully read back in a single transaction sequence.

---

## Phase 2: Context Manager & The 4 Layers

This phase rewrites the prompt assembly logic to transition from a static file-load approach to a dynamic, bottom-up 4-layer architecture.

### Tasks

* **Task 2.1: System Floor (Layer 1).** Implement logic to inject static identity files (`SOUL.md`, `IDENTITY.md`, `USER.md`), active records from `cortex_pending_ops`, and the top 50 facts from `cortex_hot_memory` ordered by `hit_count` and `last_accessed_at`. Pending ops use a consistent structured format so the LLM tracks each task from dispatch to completion:
    * `Pending:` `[TASK_ID]=<id>, Message='<task>', Status=Pending, Channel=<ch>, DispatchedAt=<ts>`
    * `Completed:` `[TASK_ID]=<id>, Message='<task>', Status=Completed, Channel=<ch>, Result='<full result>', CompletedAt=<ts>`
    * `Failed:` `[TASK_ID]=<id>, Message='<task>', Status=Failed, Channel=<ch>, Error='<error>', CompletedAt=<ts>`
  Acknowledged completed/failed ops are excluded by `getPendingOps()` (§6.5.1). A behavioral instruction preamble is included when results or failures are present, directing the LLM to act on them.
* **Task 2.2: Foreground Soft Caps (Layer 2).** Update the session loader to apply a soft cap (e.g., last 20 messages or 4,000 tokens) for the active channel's verbatim history.
* **Task 2.3: Background Awareness (Layer 3).** Implement logic to inject 1-to-2 sentence summaries of recently active channels from `cortex_channel_states`. Ensure channels idle for >24 hours are excluded.

### Unit Tests

* **`test_layer1_builder`**: Mock DB responses and assert that the System Floor builder limits hot memory to exactly 50 items and sorts them correctly.
* **`test_layer2_soft_cap`**: Pass 50 mock messages to the Foreground loader and assert it truncates the output to the configured soft cap limit (e.g., 20 messages).
* **`test_layer3_exclusion`**: Provide mock channel states with varying timestamps. Assert that only channels active within the last 24 hours are included in the output.

### Phase 2 E2E Test

* **`test_context_assembly_e2e`**: Seed the DB with hot memories, a pending operation, a long active conversation, and multiple background channel summaries. Trigger the Context Manager and assert that the final generated system prompt contains the correct mix of Layer 1, 2, and 3 data, while strictly adhering to token/item limits.

---

## Phase 3: Retrieval Tooling (Read Path)

This phase gives Cortex two explicit native tools to pull older data into its active context without token bloat. Tools are intentionally separate — different mechanics, different schemas, different intent.

### Tasks

* **Task 3.1: Build `fetch_chat_history` Tool.** Deterministic relational query against `cortex_session`. Returns chronological rows for a given channel up to a configurable limit. Expands Layer 2 (Foreground) on demand for older verbatim context the Soft Cap excluded.
  * Input schema: `{ channel: string, limit?: number, before?: string }`
  * Executes synchronously within the same turn (no Router, no async).

* **Task 3.2: Build `memory_query` Tool.** Semantic vector search against `sqlite-vec` cold storage for disconnected facts.
  * Input schema: `{ query: string, limit?: number }`
  * Mechanics: embed `query` via Ollama `nomic-embed-text` → vector similarity search → return matching facts.
  * Tracking hook: for each result returned, `UPDATE cortex_hot_memory SET last_accessed_at=now(), hit_count=hit_count+1 WHERE id=?` — retrieved facts stay hot.
  * Executes synchronously within the same turn.

* **Task 3.3: Wire both tools into `llm-caller.ts`.** Add `fetch_chat_history` and `memory_query` tool definitions to the Cortex LLM tool list (alongside `sessions_spawn`). Update `loop.ts` to handle both as synchronous tool round-trips (detect tool call → execute → feed `tool_result` → LLM continues).

### Unit Tests

* **`test_fetch_chat_history_returns_rows`**: Seed `cortex_session` with 30 messages. Call tool with `limit=10`. Assert exactly 10 rows returned in chronological order.
* **`test_fetch_chat_history_channel_filter`**: Seed messages from 2 channels. Assert only the requested channel's messages are returned.
* **`test_memory_query_updates_hit_count`**: Mock vector DB hit. Assert the tool returns the fact text and executes an `UPDATE` on `cortex_hot_memory` to increment `hit_count`.
* **`test_memory_query_no_hit`**: Mock empty vector DB result. Assert the tool returns an empty result without error.

### Phase 3 E2E Test

* **`test_retrieval_paths_e2e`**:
  1. Seed `cortex_session` with 40 messages. Simulate Cortex calling `fetch_chat_history(limit=5)`. Verify 5 oldest-excluded messages are returned and injected as `tool_result`.
  2. Seed `sqlite-vec` with an embedded fact. Simulate Cortex calling `memory_query("IP address")`. Verify the fact is returned, `hit_count` incremented, and result injected as `tool_result`.



---

## Phase 4: The Gardener Subsystem (Background Maintenance)

This phase implements the automated background workers that manage the lifecycle of memories.

### Tasks

* **Task 4.1: Channel Compactor.** Create an hourly cron task that compresses inactive Foreground sessions into 1-line Background summaries.
* **Task 4.2: Fact Extractor.** Create a 6-hour cron task that uses a Sonnet-tier LLM to extract persistent facts from recent logs and inserts them into `cortex_hot_memory`.
* **Task 4.3: Vector Evictor.** Create a weekly cron task that sweeps `cortex_hot_memory` for facts older than 14 days with a `hit_count` < 3. Move these facts to the Vector DB and delete the hot rows.

### Unit Tests

* **`test_channel_compactor_logic`**: Provide raw chat logs to the compactor function and assert it outputs a concise summary string.
* **`test_vector_evictor_selection`**: Seed `cortex_hot_memory` with a mix of fresh, stale/high-hit, and stale/low-hit records. Assert that the Evictor query only selects the stale/low-hit records for removal.

### Phase 4 E2E Test

* **`test_gardener_lifecycle_e2e`**: Manually trigger the Vector Evictor on a seeded database. Assert that the targeted rows are removed from `cortex_hot_memory`, successfully embedded and stored in the Vector DB, and that the transaction rolls back cleanly if the Vector DB insertion fails.

---

## Phase 5: Async Tool Provenance — Single-Path Result Delivery

This phase fixes the async tool provenance gap: results from `sessions_spawn` currently enter the LLM's context via two paths (System Floor + Foreground bus envelope), causing the LLM to not recognize its own dispatched results. The fix routes results exclusively through the System Floor.

### Tasks

* **Task 5.1: Structured ops format in System Floor.** Replace the `[PENDING]`/`[NEW RESULT]`/`[FAILED]` tag format in `loadSystemFloor()` (`context.ts`) with the structured format: `[TASK_ID]=<id>, Message='...', Status=Pending|Completed|Failed, ...`. Add `id=` field and behavioral instruction preamble when results/failures are present.

* **Task 5.2: Ops trigger envelope.** Modify `gateway-bridge.ts:onJobDelivered` and `onJobFailed` to: (a) update `cortex_pending_ops` as before, (b) enqueue a lightweight trigger envelope (`content: "[ops_update]"`, `metadata: { ops_trigger: true }`) instead of a content-bearing result envelope. Remove the code that creates a full CortexEnvelope with result content.

* **Task 5.3: Loop trigger handling + dispatch evidence.** Modify `loop.ts` to: (a) detect ops triggers (`envelope.metadata.ops_trigger === true`) and store a system notification `[Task update available]` instead of the raw trigger content (ensures foreground ends with user message for API compliance); (b) after each `sessions_spawn` dispatch, store an assistant-role `[DISPATCHED]` record in `cortex_session` with the task ID and description (dispatch evidence for provenance).

* **Task 5.4: Acknowledgment with foreground copy.** Modify the post-turn acknowledgment in `loop.ts` to: (a) for each unacknowledged completed/failed op, insert a row into `cortex_session` with `role='user'`, `channel=op.reply_channel`, `sender_id='cortex:ops'`, `content=<structured format>`, `timestamp=op.completed_at`; (b) then call `acknowledgeCompletedOps()` as before.

* **Task 5.5: Update `sessions_spawn` tool description.** Update `SESSIONS_SPAWN_TOOL.description` in `llm-caller.ts` to explain: "After dispatch, you will see the task in your Active Operations as `Status=Pending`. When the result arrives, the same entry will show `Status=Completed` with the full `Result`. Act on it and deliver the findings to the user."

### Unit Tests

* **`test_ops_structured_format`**: Assert System Floor output uses `[TASK_ID]=..., Status=Pending` format for pending ops, and `Status=Completed, Result='...'` for completed ops. No `[NEW RESULT]` tags.
* **`test_ops_trigger_not_stored`**: Enqueue a trigger envelope with `metadata.ops_trigger=true`. Assert `appendToSession()` is not called (trigger does not appear in `cortex_session`).
* **`test_ops_trigger_wakes_loop`**: Enqueue a trigger. Assert the loop fires a context assembly + LLM call.
* **`test_acknowledgment_copies_to_session`**: Complete a pending op, run a loop turn, assert the op appears in `cortex_session` with correct `channel`, `timestamp=completed_at`, and structured content.
* **`test_acknowledged_op_not_in_system_floor`**: After acknowledgment, assert `getPendingOps()` excludes the op. Assert the next `loadSystemFloor()` does not include it.
* **`test_foreground_includes_copied_op`**: After acknowledgment, assert `buildForeground(db, channel)` includes the copied op row in chronological order.

### Phase 5 E2E Test

* **`test_single_path_result_delivery_e2e`**:
  1. Dispatch a task. Assert System Floor shows `Status=Pending`.
  2. Complete the task. Fire trigger. Assert System Floor shows `Status=Completed` with full result. Assert `cortex_session` does NOT yet contain the result.
  3. Run LLM turn. Assert LLM receives the completed op in System Floor. Assert LLM response references the result.
  4. After turn: assert op copied to `cortex_session` with `completed_at` timestamp. Assert op gone from System Floor.
  5. Next turn: assert foreground history includes the result in chronological order. Assert System Floor no longer shows the op.

---

## Final Comprehensive E2E Tests

These tests validate the architecture holistically across Cortex, the Router, and the Hippocampus.

* **`test_global_information_lifecycle_flow`**
* **Action**: Simulate a user mentioning "My new IP is 192.168.1.50" in the active Foreground. Switch channels. Manually trigger the Fact Extractor. Fast-forward time by 15 days and trigger the Vector Evictor.
* **Assertion**: Verify the message moves from verbatim Foreground -> Hot Memory Table -> Archived Vector DB, correctly clearing out of the active context window to save tokens.


* **`test_global_long_running_task_flow`**
* **Action**: Cortex dispatches a task via `sessions_spawn`, creating a record in `cortex_pending_ops`. Simulate the Router taking "30 hours" (decaying other background memory). The Router worker finishes, updates `cortex_pending_ops`, and fires a lightweight trigger.
* **Assertion**:
  1. System Floor shows `Status=Pending` for the entire wait period.
  2. After result arrives, System Floor shows `Status=Completed` with full `Result` — no `[NEW RESULT]` tag, just the structured line with updated fields.
  3. The trigger envelope is NOT stored in `cortex_session` (ops triggers are not conversation messages).
  4. After the LLM turn completes: the op is copied to `cortex_session` with `completed_at` as timestamp, on the correct `reply_channel`.
  5. `acknowledgeCompletedOps()` sets `acknowledged_at` — op drops from System Floor on the next turn.
  6. The result persists in `cortex_session` foreground, sorted chronologically, decaying naturally.
  7. The Gardener can still harvest the acknowledged op for facts (the `cortex_pending_ops` row is untouched).


* **`test_global_cross_channel_awareness_flow`**
* **Action**: User speaks on WhatsApp. System drops WhatsApp to background, compactor summarizes it. User speaks on Webchat.
* **Assertion**: Verify Cortex's response on Webchat has access to the 1-to-2 sentence summary of the WhatsApp conversation in its Layer 3 Background context.

