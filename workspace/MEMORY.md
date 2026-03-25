# MEMORY.md — Index

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
- **Serj's WhatsApp:** +40751845717
- **Repo:** https://github.com/SerjRs/Scaff.git

## sdlc-fabric — Autonomous Pipeline Orchestrator (built 2025-07-27)
- **Repo:** https://github.com/SerjRs/sdlc-fabric (private)
- **Local:** `C:\Users\Temp User\sdlc-fabric`
- **Skill:** installed at `~/.openclaw/skills/sdlc-fabric/`
- **Tasks done:** 051–061 (DB, filesystem, MCP, scheduler, agents, REST/CLI, prompts, skill, config, spawn fixes)
- **Remaining:** 061b (prompt file updates), 062 (docs) — both in Cooking
- **Tests:** 83 passing
- **All agents:** claude-code only (codex/gemini deferred)
- **CODEBASE.md:** living API surface doc in repo root
- **Project structure:** `~/.openclaw/workspace/sdlc-fabric/<project>/pipeline/ + repo/`

## Pipeline Status (as of 2026-03-19)
- **Done:** 025a-025g, 026, 027, 028, 030-042 (audio pipeline fixes + full test rewrite)
- **Cooking:** 029 (cortex honesty v2), 043 (test cleanup)
- **Total tests:** ~110+ Rust + ~110+ TS audio = 220+ audio tests (all rewritten, no fake E2E)
- **036 deployed but needs gateway rebuild** for Librarian ingestion to be active

## Architecture — Meeting Transcription Pipeline (025)
- **Client (Rust):** `tools/cortex-audio/` — 3 crates: capture (cpal/WASAPI), shipper (reqwest/tokio), tray (tao/tray-icon)
- **Server (TypeScript):** `src/audio/` — ingest API, transcription worker (Whisper CLI), transcript→Hippocampus
- **Binary:** `cortex-audio.exe` (~1.9MB release) — portable, config.json next to exe
- **Gateway wiring (025f):** audio handler mounted on gateway HTTP server, `audioCapture` config in openclaw.json
- **Config key:** `audioCapture` (not `audio` — that was taken). Added to Zod schema in task 027.
- **Gateway LAN binding:** `gateway.bind: "lan"` + `controlUi.dangerouslyAllowHostHeaderOriginFallback: true` required for non-localhost access

## Audio Client Deployment (cortex-audio.exe)
- Copy exe + config.json to same folder on any Windows machine
- Config.json lookup: checks exe directory first, fallback to %LOCALAPPDATA%\CortexAudio\config.json
- Default outbox: %LOCALAPPDATA%\CortexAudio\outbox\ (028 will change to ./capture/ next to exe)
- Auto-detects device channel count (stereo headsets need ch=2), downmixes to mono internally
- Logs to stdout + cortex-audio.log next to exe (debug level default)
- On stream error: enumerates supported device formats in the error message
- **KNOWN:** shipper not yet wired into tray app (028 incomplete)

## Cortex Honesty Bug (persistent)
- 026 added system prompt rules — LLM still violates them
- Pattern: generates "I spawned X" text without tool call, delivers lie before validation
- Seen in March 16 audit AND March 18 01:45 session (3 instances in one conversation)
- Fix requires architectural enforcement, not just prompt rules
- 029 spec: post-generation intent detection + prompt rewrite + executor format suffix

## Cortex Config
- File: `cortex/config.json`
- `whatsapp: "live"` (enabled March 17 ~midnight at Serj's request, still active)
- `webchat: "live"`
- Model: claude-opus-4-6, thinking: high
- Hippocampus: enabled, gardener intervals set

## Critical Files & Paths
- **OpenClaw root:** `C:\Users\Temp User\.openclaw`
- **Workspace:** `C:\Users\Temp User\.openclaw\workspace\`
- **Cortex source:** `src/cortex/` (loop.ts, llm-caller.ts, tools.ts, context.ts)
- **Audio source:** `src/audio/` (ingest.ts, worker.ts, transcribe.ts, wav-utils.ts, types.ts)
- **Rust workspace:** `tools/cortex-audio/` (Cargo.toml with capture, shipper, tray members)
- **Bus DB:** `cortex/bus.sqlite` (44MB) — cortex_bus, cortex_session, hippocampus_facts, etc.
- **Gateway config:** `openclaw.json` — includes audioCapture block (enabled: true)
- **Auth:** OAuth token at `agents/main/agent/auth-profiles.json`, profile `anthropic:scaff`

## Claude Code Agent Patterns
- **Working spawn pattern:** `$prompt = Get-Content "file.txt" -Raw; claude -p $prompt --permission-mode bypassPermissions --output-format text`
- **Background:** `background: true` on exec, NO pty
- **Failure pattern (March 17 night):** 5 consecutive failures — 3x Anthropic 500, 2x hung with zero output. API instability.
- **Hung agents sometimes DO the work** — check git log and disk before killing
- **Prompt must say:** "Do NOT ask questions. Execute." or it proposes plans and waits
- **PowerShell quoting:** escaped quotes in -p strings cause parse errors. Use file + Get-Content instead.

## Audio Pipeline — First Live Success (2026-03-19)
- Session `a61162c8`: 14 chunks, stereo split, Whisper transcribed, transcript on disk
- Librarian ingestion (036) not yet active — needs gateway rebuild
- Next: rebuild gateway, retry live capture, verify transcript lands in Library + Hippocampus

## Test Rewrite Post-Mortem (2026-03-19)
- 5/5 production bugs missed by 150+ green tests
- Root cause: every integration boundary mocked on at least one side
- Full audit: `pipeline/InProgress/TESTS-REVISION-REPORT.md` (34KB)
- New rule: NO env patching in tests, NO silent skip guards
- Tests must fail when production would fail

## Lessons Learned (cumulative)
- **Always use `--permission-mode bypassPermissions`** for Claude Code
- **Create daily log BEFORE rebuild.ps1** (rebuild checks for it)
- **Add .gitignore BEFORE git add** on new Rust projects
- **EOF markers prevent LLM re-read loops** — critical for tool results
- **Gateway bind: "lan" needs controlUi config** — or gateway fails to start
- **audioCapture must be in Zod schema** — gateway rejects unknown keys in openclaw.json
- **rebuild.ps1 restores from pre-rebuild backup** if gateway fails to start
- **Device channel count varies** — must query default_input_config, not hardcode ch=1
- **Prompt files > inline prompts** for Claude Code — avoids PowerShell escaping hell
- **Don't chain blocking operations** — reply between test/merge/commit steps
- **Cortex whatsapp: "live"** — toggled by me, currently ON (since March 17 midnight)

<!-- END HIPPOCAMPUS -->
