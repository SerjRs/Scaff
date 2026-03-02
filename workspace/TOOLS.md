# TOOLS.md — Local Environment

## Infrastructure
- Memory-core: `%USERPROFILE%\.openclaw\memory\main.sqlite`
- Hot-cache: `_state/hot-cache/hot-cache.sqlite`
- Ollama: `127.0.0.1:11434` — serves `llama3.2:3b` (LLM) and `nomic-embed-text` (embeddings)
- Hot-memory plugin: `scaff-hot-memory` — native hooks replace PowerShell pipeline
- Gateway: `127.0.0.1:18789`

## Delegation
`scripts/delegate.ps1 -Task -Domain -Urgency` → spawns sub-agent.
Full protocol: `docs/delegation-protocol.md`

## PowerShell escaping
Use `scripts/lib/exec-ps.ps1` or backticks. Details: `docs/powershell-escaping.md`
