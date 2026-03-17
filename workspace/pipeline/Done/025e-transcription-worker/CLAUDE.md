# CLAUDE.md — 025e Transcription Worker

## What You're Building

A TypeScript worker that takes completed audio sessions (WAV chunks from 025d), runs speech-to-text via Whisper CLI, produces structured transcripts, and ingests results into the OpenClaw knowledge graph.

## Project Location

Inside OpenClaw source tree: `src/audio/transcribe.ts` + `src/audio/ingest-transcript.ts`

The ingest API (025d) already exists at `src/audio/ingest.ts`.

## Key Constraints

- TypeScript/Node.js — same stack as OpenClaw.
- Do NOT modify `src/audio/ingest.ts` or `src/audio/session-store.ts` (025d).
- You CAN import from them.
- Use `node:child_process` for Whisper CLI calls.
- For WAV processing, use pure JS (no FFmpeg dependency). The `wavefile` npm package is acceptable.
- Tests should mock the Whisper CLI (don't require whisper installed).
- Use vitest for tests.

## Implementation Order

1. `src/audio/wav-utils.ts` — WAV concatenation + stereo→mono channel splitting (pure JS)
2. `src/audio/transcribe.ts` — Run whisper CLI on mono WAV, parse output to segments
3. `src/audio/ingest-transcript.ts` — Merge L/R segments, create Library article, extract facts
4. `src/audio/worker.ts` — Orchestrator: validate chunks → concat → split → transcribe L+R → merge → ingest
5. `src/audio/__tests__/transcribe.test.ts` — Tests with mocked whisper CLI
6. `src/audio/__tests__/wav-utils.test.ts` — Tests for WAV operations

## Whisper Integration

Use shell exec to local `whisper` CLI (Option A from SPEC):

```typescript
import { execFileSync } from 'node:child_process';
// whisper input.wav --model base.en --output_format json --output_dir /tmp
```

For tests, mock `execFileSync` or use a test fixture JSON file that matches whisper output format.

## Transcript Format

Output JSON at `data/audio/transcripts/{sessionId}.json`:

```json
{
  "sessionId": "abc-123",
  "startedAt": "2026-03-17T14:30:00Z",
  "durationMinutes": 45,
  "segments": [
    { "speaker": "user", "start": 0.0, "end": 4.2, "text": "..." },
    { "speaker": "others", "start": 4.5, "end": 12.1, "text": "..." }
  ],
  "fullText": "User: ...\nOthers: ..."
}
```

## Done Criteria

- All source files created in `src/audio/`
- Tests pass with `npx vitest run src/audio/__tests__/transcribe.test.ts src/audio/__tests__/wav-utils.test.ts`
- No modifications to 025d files
- Update STATE.md with STATUS: COMPLETE when done
