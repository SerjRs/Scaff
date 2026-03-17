# Claude Code Instructions — 025a Audio Capture Engine

## Branch
`feat/025a-audio-capture-engine`

## What To Do
Read SPEC.md in this folder. Implement the Audio Capture Engine module per spec.

## Key Rules
- Check STATE.md first. If it has progress, resume from there.
- Create branch from main if it doesn't exist.
- Commit after each milestone.
- Update STATE.md after each milestone with what's done and what's next.
- If you hit a blocker or ambiguity, make a reasonable decision, document it in STATE.md, and keep going. Do NOT stop to ask questions.
- If you fail, write your failure state to STATE.md so the next run can pick up.
- Run tests before marking done.
- When fully done: push branch, create PR, update STATE.md with status=done and PR link.

## Tech Context
- This is a Windows desktop module using WASAPI for audio capture
- Language: pick the most practical (C#/.NET, Rust, or C++ — your call based on WASAPI ergonomics)
- Must produce WAV chunks in a local outbox directory
- Stereo: left=mic, right=speakers
- Size-based chunking, silence detection, session lifecycle
- This is a standalone module — no server, no UI, no network

## Tests
- Unit tests as specified in SPEC.md
- End-to-end tests as specified in SPEC.md
- Tests must pass before completion
