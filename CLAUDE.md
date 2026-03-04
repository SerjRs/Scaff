## Tech Stack

- **Language:** TypeScript (ESM modules)
- **Runtime:** Node.js (v24+, uses built-in `node:sqlite`)
- **Package manager:** pnpm
- **Build:** tsdown
- **Type checking:** tsgo (Go-based TS checker)
- **Linting/Formatting:** oxlint, oxfmt (Oxc toolchain)
- **Logging:** Pino
- **Database:** SQLite (`node:sqlite`) + `sqlite-vec` for vector search
- **AI SDKs:** `@anthropic-ai/sdk`, `openai`, `@mistralai/mistralai`
- **Entry point:** `openclaw.mjs` (CLI), gateway server (multi-channel AI messaging)
- **Native apps:** iOS/macOS (Swift/SwiftUI), Android (Kotlin/Gradle), Web UI (`ui/`)

## Architecture

Three-pillar design:
1. **Cortex** — Singular cognitive core. One brain, one session, unified awareness across all channels. SQLite message bus.
2. **Hippocampus** — Memory lifecycle. Hot Memory, vector search (sqlite-vec + nomic-embed-text), gardener subsystem.
3. **Router** — Task delegation. Complexity scoring, model routing (Haiku/Sonnet/Opus), SQLite persistent queue, push-based results.