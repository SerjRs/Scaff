# MEMORY.md — Index

*Last recalibrated: 2026-02-24*

## Shards
- `memory/long-term/architecture-state.md` — **READ FIRST** — live system state, what's running, config, message flows, critical rules
- `memory/long-term/identity.md` — name, personality, avatar, partnership agreement, model identity
- `memory/long-term/people.md` — people, contacts
- `memory/long-term/security.md` — security rules, Clawdex, DNA verification
- `memory/long-term/infrastructure.md` — models, providers, architecture, backups, plugins, Router
- `memory/long-term/preferences.md` — operating patterns, delegation, formatting
- `memory/long-term/testing.md` — UI testing framework
- `memory/long-term/mortality-review.md` — mortality review (2026-02-10, timeless)
- `memory/long-term/archived-reports-feb2026.md` — archived reports from Feb 2026
- `memory/long-term/MEMORY_old_backup.md` — old MEMORY.md backup (pre-sharding)

## Memory Architecture

### 3 Layers
1. **Session Tail** — last ~20 messages, sent to Cortex. Truncated to keep context small.
2. **Hot Memory** — Redis-backed vector store (24h sliding window). Auto-captures facts/preferences. ~10 relevant snippets injected per message.
3. **Long Memory** — Curated markdown files in `memory/long-term/`. Manually maintained.

### Storage
| What | Where | Who writes | Retention |
|------|-------|-----------|-----------|
| Active session | `agents/main/sessions/<id>.jsonl` | Gateway (auto) | Truncated tail |
| Session backup | `agents/main/sessions/<id>_backup.jsonl` | Gateway (auto) | Full, never truncated |
| Hot Memory | Redis vector DB | System (auto) | 24h sliding window |
| Daily logs | `memory/YYYY-MM-DD.md` | System (auto) | Persistent |
| Long-term shards | `memory/long-term/*.md` | Scaff (manual) | Persistent |

### Key Notes
- Daily logs are auto-created by the system
- Hot Memory has dedup (cosine similarity > 0.85 = replace) since 2026-02-23
- Session backup is the true source of truth for full conversation replay

## Quick Ref
- **Model:** anthropic/claude-opus-4-6
- **OpenClaw:** 2026.2.25 (source build from git, single install at `.openclaw`)
- **Host:** DianaE (Windows)
- **Channel:** WhatsApp
- **Clawdex:** mandatory before skill installs
- **Purpose:** See PURPOSE.md

## Open Items (as of 2026-02-24)
- [x] ~~Verify/create Windows scheduled tasks for daily backups (local 4:00 AM, cloud 4:15 AM)~~ — done 2026-02-24
- [x] ~~Add rclone to system PATH~~ — confirmed in PATH, resolves to v1.69.1
- [ ] Re-apply gateway fail-closed patch for DNA verification (lost during update to 2026.2.22-2)
- [x] ~~Hot memory flush cron~~ — removed; Hot Memory disabled by Serj
- [ ] PURPOSE.md threads: ClawHub skill, Moltbook, Transition Project (all not started)
- [ ] Immune System runtime policy engine (discussed 2026-02-13, not started)

## Hippocampus Facts
*Auto-generated from cortex_hot_memory. 200 facts. Do not edit manually.*

- System should schedule self-verification if processes run longer than expected
- Test results should be written in hippocampus migration file
- User allocated 4 hours for complete migration
- Migration should be section-by-section with validation before processing
- WhatsApp channel should be marked/parsed by the system
- User requested 4 bullet points to be written into hippocampus migration file for discussion
- Hot memory picks its own data from Hippocampus
- Gardener component picks data for long memory
- User wants data organized by session in Cortex with relevant timestamps
- User wants entire memory migrated from md files to Hippocampus with timestamps
- Hippocampus is a memory system being migrated to from markdown files
- Cortex is an architecture being discussed with shadow mode configuration
- WhatsApp is an integrated communication channel in the system
- System has a gardener component that processes channels and facts
- User phone number: +40751845717
- User asked about using batch API instead
- User requested to stop the actual embedding approach
- Remaining Phase 1 items are: Item 3 (Broadcast bootstrap), Item 4 (Executor retry at worker.ts:115), Item 6 (Ops trigger delivery retry at gateway-bridge.ts:248)
- Phase 1 work is 3 out of 6 items complete
- Phase 1 gate has not been passed
- Memory persistence has been implemented
- 3 code fixes remain: broadcast bootstrap, executor retry, ops trigger retry
- 3 code fixes have been completed: path traversal, resource sanitization, auth sync
- Roadmap docs/ROADMAP.md written on 2026-03-07 at 08:45 defining 7 gates to full autonomy
- Roadmap gates aligned with: cortex-architecture, hipocampus-architecture, goal1-implementation-plan, scaff-roadmap, and self-improvement-architecture
- Hippocampus was already enabled in cortex/config.json
- Cortex hot memory contained 6,086 hallucinated facts with 0 accuracy before purge
- Facts were being extracted at 5-minute intervals before fix
- Gardener service components: compactor, extractor, evictor all enabled
- Extraction prompt changed to explicitly prevent inference and fabrication
- Gardener model changed from Opus to Haiku (configurable via hippocampus.gardenerModel)
- Architecture-spec intervals restored: 1 hour compactor, 6 hour extractor, 1 week evictor
- All 14 gardener tests passing
- Commit 68788af46 pushed for Gardener fix on 2026-03-07 at 09:15
- Manual fact extraction using Haiku model run against 249 session rows on 2026-03-07 at 09:45
- Manual extraction yielded 105 initial facts, reduced to 16 clean verifiable facts after cleanup
- Key extracted facts from manual process: hostname DianaE, CPU 12 cores, OpenClaw 2026.2.25, Serj's phone, build loop, dev setup, Cortex architecture goal
- Extraction prompt refined twice to skip ephemeral data, test artifacts, and task IDs
- Commit 310dc028d documents prompt refinement
- Hot memory injection path verified in code at System Floor section
- Cold storage path (memory_query) cannot yet be tested—no evicted facts available
- 13 WhatsApp messages processed in Cortex bus since Mar 5, all completed
- Cortex shadow responses show high quality output matching main agent performance
- Conversation continuity maintained across 3-day period (Mar 5-7)
- 36 session rows recorded in cortex_session for WhatsApp channel
- Gate 2 runtime progress: ~37 hours elapsed of 48-hour target, approximately 11 hours remaining
- Shadow mode fully processing with Opus calls on every message, resulting in double costs
- Tool 2 (Build+Test runner) completed: scripts/build-test.mjs with structured JSON output, supports --build, --test, and --scope flags
- Tool 1 (Import graph) completed: scripts/import-graph.mjs using TypeScript Compiler API, analyzed 4,563 files with 14,727 edges, supports --importers, --imports, --impact, and --startup flags
- Gate 5 dev tools remaining: Tools 3 (semantic code search) and 4 (architecture state tracker)
- Fixed 8 of 13 router test failures in commit 81e75784c; router tests at 197/202 pass
- 3 evaluator tests required updated reasoning strings for two-stage model
- 5 isolation tests fixed issues with auth sync, weight mapping, template assertions, and warmOllama mock
- Remaining 5 router test failures stem from vitest module cache contamination across test files (identified as test infrastructure debt rather than code bugs)
- Built semantic code search tool with two scripts: code-index.mjs (indexer) and code-search.mjs (query)
- Semantic search processes 2,370 source files into 14,130 chunks using Ollama nomic-embed-text on localhost:11434
- sqlite-vec requires BigInt for rowids in Node 24
- Embeddings process dies after 60-100 when run continuously; solution is batch 500 at a time, close DB between batches, loop externally
- Embedding loop target: 15K embeddings (30 batches x 500)
- Search functionality not yet tested after embedding completion
- Created architecture-state.md as live system ground truth document in memory/long-term/ (commit f519fa79c)
- architecture-state.md added to MEMORY.md as READ FIRST shard to prevent recurring discussion startup problems with false premises
- architecture-state.md covers running components, config locations, message flows, and critical rules
- Serj prefers high-level summaries over internal implementation details
- Serj loses contact during extended tool work sessions and expects real-time communication
- cron.add accepts: name, schedule (either {kind: 'once', at} or {everyMs}), sessionTarget, payload (either {kind: 'system-event', text} or {kind: 'message', message})
- PowerShell JSON escaping is problematic; .mjs wrapper scripts are the workaround for cron API
- OpenClaw source docs include: cortex-architecture.md and router-architecture.md
- Architecture documents include: AGENTS.md, TOOLS.md, BOOTSTRAP.md, circuit-breaker-dlq-design.md, immune-system-design.md, flight-recorder-design.md, zero-trust-analysis.md
- User's goal is to build a fully autonomous assistant
- The Cortex architecture main idea was to remove any tooling from Cortex and let Cortex do jobs only asynchronously through agents
- User uses Sonnet 4 as default and Opus for complex tasks
- User's build loop includes: create a /spec/ folder, numbered 00_spec1, progress .md for progress through implementation, test gate, use agent-browser with dogfood before sending URL to test
- User's current setup includes: droid/pi/codex, 5.4 default, opus for frontend + non code, cmux, multiple panes, telegram for claw, droid missions for big work
- The `.openclaw/src/channels/whatsapp/` directory does not exist
- User's phone number is +40751845717
- Scaff is an AI assistant running on Anthropic Claude Opus whose name derives from 'scaffolds'
- Project has 56 direct production dependencies
- V8 engine version: 13.6.233.17-node.37 (shipping with Node.js 24.13.0)
- Package.json version field: 2026.2.25
- Package.json name field: openclaw
- Windows machine CPU core count: 12
- Windows machine hostname is DianaE
- WhatsApp integration routes messages to Main Agent (Scaff, Opus) for direct response
- Cortex runs as shadow process on WhatsApp without message delivery
- Webchat integration uses Cortex (live, Opus+thinking) with sessions_spawn to trigger Router pipeline
- Webchat available tools: fetch_chat_history, memory_query
- Processing pipeline: Router Queue → Evaluator (Ollama with Sonnet verification) → Dispatcher → Executor
- Model selection by weight: 1-3 uses Haiku, 4-7 uses Sonnet, 8-10 uses Opus
- Main Agent model: anthropic/claude-3-opus-4-6
- Main Agent workspace location: ~/.openclaw/workspace/
- Main Agent session storage: agents/main/sessions/
- Main Agent available tools: read, write, exec, web_search, browser
- Main Agent identity sources: SOUL.md, USER.md, IDENTITY.md injected by OpenClaw framework
- Main Agent memory: Long-term storage in MEMORY.md, daily notes in memory/YYYY-MM-DD.md, shards in memory/long-term/*.md
- Cortex config file location: cortex/config.json
- Cortex model: claude-opus-4-6 with high-level thinking enabled
- Cortex database: cortex/bus.sqlite containing bus, session, hot memory, cold storage, pending operations, channel states
- Cortex active channels: webchat (live), whatsapp (shadow mode)
- Cortex available tools: sessions_spawn, get_task_status, fetch_chat_history, memory_query
- Cortex tool limitations: Cannot directly read files, execute commands, or browse web
- Hippocampus hot memory: 16 clean facts currently stored
- On 2026-03-07, 6,111 hallucinated facts were purged from Hippocampus
- Hippocampus cold storage: sqlite-vec table exists but empty; no evictions occurred yet
- Gardener model: claude-haiku-4-5
- Gardener Compactor runs every 1 hour
- Gardener Extractor runs every 6 hours
- Gardener Evictor runs every 1 week
- Router enabled via openclaw.json with router.enabled: true
- Router queue database: router/queue.sqlite
- Router Stage 1 evaluation: Local Ollama model (llama3.2:3b)
- Router Stage 2 evaluation: Claude Sonnet 4.6 verification triggered if weight > 2
- Router Sonnet model name in config: claude-sonnet-4-6 (no provider prefix)
- Router Session identifier for evaluator: agent:router-evaluator:eval:<uuid>
- Router fallback weight: 5 (Sonnet) when both evaluation stages fail
- Router Executor session identifier: agent:router-executor:task:<uuid>
- Router Executor runs in isolated workspace with full tool access
- Router resource passing accepts file, url, and inline resources
- Gateway port: 18789
- Gateway WhatsApp: Connected
- Gateway Webchat: Available at gateway port
- Ollama running on 127.0.0.1:11434
- Ollama LLM Model: llama3.2:3b
- Ollama Embeddings Model: nomic-embed-text
- WhatsApp on Cortex operates in shadow mode only — Cortex receives messages but cannot reply; main agent handles all WhatsApp communication
- Cold storage queries are non-functional because the memory_query tool exists but cold storage is empty with no evicted facts
- Foreground soft cap is disabled, allowing Cortex conversations to grow unbounded
- DNA verification gateway patch was lost during an update and has not been re-applied
- Immune System has been discussed but not yet started
- All 4 dev tools are complete: import graph, build/test runner, semantic code search with 14,130 chunks, and state tracker
- Cortex inline tools are not wired, preventing Cortex from directly using web_search, file reading, and other capabilities; Cortex must delegate all such tasks
- Main config stored in openclaw.json in JSON format
- Cortex config located at cortex/config.json
- Agent authentication profiles stored at agents/main/agent/auth-profiles.json
- Router queue uses router/queue.sqlite
- Cortex database at cortex/bus.sqlite
- Workspace stored in workspace/ directory as markdown files
- Long-term memory shards in workspace/memory/long-term/*.md
- Daily logs in workspace/memory/YYYY-MM-DD.md format
- Session backups stored as JSONL files in agents/main/sessions/*.jsonl
- Never use PowerShell ConvertTo-Json on openclaw.json — causes UTF-8 BOM corruption
- Agent model IDs have NO provider prefix — use 'claude-sonnet-4-6', not 'anthropic/claude-sonnet-4-6'
- Cortex config is NOT in openclaw.json — lives at cortex/config.json; adding cortex key to openclaw.json breaks schema
- Validate config before restart by running 'node tmp/validate-config.mjs'
- Always write daily log before restart — rebuild.ps1 refuses without it
- Never run rebuild.ps1 inline — use Start-Process instead to avoid gateway kill interruption
- openclaw.json is fragile — Claude Code in ~/.openclaw can wipe it via git operations
- WhatsApp messages flow through gateway to dispatchInboundMessage() which triggers auto-reply, establishes Scaff session, and sends reply
- Webchat message flow to Cortex: gateway chat.ts calls cortexFeed() → cortex_bus routes to loop.ts → buildContext() and callLLM() → sessions_spawn tool calls route to router queue → evaluator → executor → result to cortex_bus → output.ts delivers to webchat
- Original architecture vision was 'Cortex = pure brain, zero tools, delegates everything'
- Pure delegation causes Scaff to disappear mid-conversation during tool work
- Long tool chains (build, code, browser) block conversation for minutes
- Fast tasks like web search, file read, weather, time lookups are instant operations
- Delegating through spawn → evaluator → executor → result → Cortex requires 3-4 LLM calls and 10+ seconds versus 1 call and 1 second with direct execution
- Inline tools (Cortex runs directly, <2s, non-blocking): web_search, web_fetch, read (workspace files), memory_search, memory_get, cron, message
- Delegated tools (async, background, via Router): sessions_spawn → Evaluator → Executor for coding, file editing, exec, browser automation, multi-step analysis, complex multi-tool work
- Inline tools don't cause disappearing because web search takes 1 second
- Heavy work causes the disappearing problem and goes through delegation
- Cortex currently has no direct tools wired in
- Spawn → executor path for heavy tasks is partially validated
- Memory works across sessions (Gate 1/4, in progress)
- Router + Evaluator + Executor pipeline is unchanged
- Hippocampus (hot memory, cold storage) is unchanged
- Session serialization (one LLM call at a time) is unchanged
- Crash durability via SQLite is unchanged
- Gate 1 (Hippocampus Activation) is approximately 70% complete
- Gate 2 (WhatsApp Shadow) is overdue and running 3+ days
- Gate 3 (Cortex Inline Tools) is new, not started, and a critical blocker for Gate 4
- Gate 4 (WhatsApp Live) is blocked by Gates 2 and 3
- Gate 5 (Dev Tools) is complete
- Gate 6 (Self-Improvement Loop) is not started
- Gate 7 (Full Autonomy) is not started
- Gate 3 (Cortex Inline Tools) must be completed before Gate 4 (WhatsApp Live)
- Without inline tools, Cortex cannot answer simple questions without spawning tasks
- Last update to the system documentation was on 2026-03-08
- Issues #11 and #14 (auth sync + resource-passing API) were completed in an overnight session on 2026-03-05
- Commit ca63a03 implements auth sync + resource-passing API across 8 files with 394 insertions
- 14 new tests are passing; 12 pre-existing test failures exist
- All work from overnight session was pushed to GitHub
- openclaw.json config file was wiped during overnight session by Claude Code sessions spawned in ~/.openclaw directory
- Daily log must be written before any rebuild or restart
- Progress updates should be written during long sessions, not just at the end
- Session backups are located in agents/main/sessions/*.jsonl and should be sorted by LastWriteTime descending
- Session backup 95c6c8a7 contained the full story of the overnight incident
- Claude Code uncommitted changes include 21 passing tests
- URL resource type was implemented
- Router pipeline components implemented: dispatcher, gateway-bridge, index, sessions-spawn-tool
- Auth sync was moved to unconditional execution in startGatewaySidecars()
- Uncommitted changes span 12 files: server-startup.ts, gateway-integration.ts, dispatcher.ts, index.ts, auth-sync.test.ts, gateway-bridge.ts, llm-caller.ts, loop.ts, sessions-spawn-tool.ts, resources.test.ts, rebuild.ps1, AGENTS.md
- Guard was added to rebuild.ps1 for daily-log and config backup
- Recovery procedure was added to AGENTS.md
- Serj launched 10 Cortex tasks on 2026-03-05 at 08:41
- agents.list was missing from openclaw.json after the 04:00 config rewrite
- agents.list was fixed to include main (default agent) and router-evaluator (ollama/llama3.2:3b)
- Cortex service failed to start at 09:10 due to missing cortex configuration section in openclaw.json
- Cortex config was added with settings: webchat=live, model=opus, thinking=high
- Serj issued restart directive on 2026-03-05 at 09:35 with orders to fix issues #20 and #21, test with existing Cortex tooling, and report with proof
- Issue #20: Cortex not starting. Root cause: Cortex LLM returned 400 error when conversations ended with assistant messages while thinking=high enabled. Fix: Strip trailing assistant messages in llm-caller.ts when thinking enabled
- Issue #21: Evaluator not starting. Root cause: router-evaluator agent had model set to ollama/llama3.2:3b causing gateway to resolve to double-prefixed path anthropic/anthropic/claude-sonnet-4-6. Fix: Use EVALUATOR_MODEL constant ('claude-sonnet-4-6' without provider prefix)
- Cortex config lives in cortex/config.json with enabled=true, channels.webchat=live, model=claude-opus-4-6, and thinking=high

<!-- END HIPPOCAMPUS -->
