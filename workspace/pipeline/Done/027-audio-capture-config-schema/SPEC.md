---
id: "027"
title: "Audio Capture Config Schema — Register audioCapture in Zod schema"
priority: high
assignee: scaff
status: cooking
created: 2026-03-17
updated: 2026-03-17
type: fix
parent: "025"
depends_on: ["025f"]
tech: typescript
---

# Audio Capture Config Schema — Register audioCapture in Zod schema

## Problem

Task 025f added `audioCapture` to `src/config/types.openclaw.ts` (TypeScript type) but did NOT add it to the Zod validation schema in `src/config/zod-schema.ts`. The gateway validates `openclaw.json` against the Zod schema at startup and rejects any unrecognized top-level key with:

```
Config invalid: Unrecognized key: "audioCapture"
```

This means the `audioCapture` block cannot be added to `openclaw.json`, so audio capture is permanently disabled — the gateway never calls `initGatewayAudioCapture()`.

## Goal

Add `audioCapture` as a valid optional top-level key in the Zod schema. After this task:

- `openclaw.json` can contain an `audioCapture` block without failing validation
- Enabling audio capture is as simple as setting `audioCapture.enabled: true` and providing an `apiKey`
- The gateway starts clean with audio enabled

## What Exists

### `src/audio/types.ts` — `AudioCaptureConfig`

```typescript
export interface AudioCaptureConfig {
  enabled: boolean;
  apiKey: string;
  maxChunkSizeMB: number;
  dataDir: string;
  port: number | null;
  whisperBinary: string;
  whisperModel: string;
  whisperLanguage: string;
  whisperThreads: number;
  retentionDays: number;
}
```

### `src/config/types.openclaw.ts` — already has the type

```typescript
import type { AudioCaptureConfig } from "../audio/types.js";
// ...
audioCapture?: Partial<AudioCaptureConfig>;
```

### `src/config/zod-schema.ts` — missing the Zod definition

The top-level schema ends with:
```typescript
    router: z.object({ ... }).strict().optional(),
  })
  .strict()
  .superRefine(...)
```

`audioCapture` needs to be added before the closing `.strict()`.

## Changes Required

### 1. `src/config/zod-schema.ts`

Add `audioCapture` between the `router` block and the closing `.strict()`:

```typescript
    audioCapture: z
      .object({
        enabled: z.boolean().optional(),
        apiKey: z.string().optional().register(sensitive),
        maxChunkSizeMB: z.number().int().positive().optional(),
        dataDir: z.string().optional(),
        port: z.number().int().positive().nullable().optional(),
        whisperBinary: z.string().optional(),
        whisperModel: z.string().optional(),
        whisperLanguage: z.string().optional(),
        whisperThreads: z.number().int().positive().optional(),
        retentionDays: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
```

Notes:
- `apiKey` must use `.register(sensitive)` — same pattern as other API keys in the schema
- `port` is `nullable()` to allow `null` (meaning "use gateway port, no separate listener")
- All fields are `.optional()` since the whole block is optional and defaults are in code
- The object itself is `.strict()` to catch typos

### 2. `openclaw.json`

After the schema fix, add the `audioCapture` block back:

```json
{
  "audioCapture": {
    "enabled": true,
    "apiKey": "cortex-audio-2026-a7f3b9e1",
    "maxChunkSizeMB": 15,
    "dataDir": "data/audio",
    "whisperBinary": "whisper",
    "whisperModel": "base.en",
    "whisperLanguage": "en",
    "whisperThreads": 4,
    "retentionDays": 30
  }
}
```

## Tests

### New tests in `src/config/config.ts` test suite or a new `config.audio-capture.test.ts`

- **Valid full config**: `audioCapture` with all fields → passes validation
- **Valid partial config**: `audioCapture` with only `enabled: true, apiKey: "x"` → passes (rest defaults in code)
- **Valid absent config**: no `audioCapture` key → passes (optional)
- **Invalid unknown key**: `audioCapture.unknownField: true` → fails (`.strict()` on the inner object)
- **Invalid type**: `audioCapture.maxChunkSizeMB: "fifteen"` → fails
- **apiKey redacted**: verify `apiKey` is redacted in config snapshots (same as other sensitive fields)

### Existing tests must not break

Run `npx vitest run src/config/` — all existing config tests must pass.

## Files to Modify

| File | Change |
|------|--------|
| `src/config/zod-schema.ts` | Add `audioCapture` Zod object (main change) |
| `openclaw.json` | Re-add `audioCapture` block with `enabled: true` |
| `src/config/config.audio-capture.test.ts` | **NEW** — 6 validation tests |

## Files NOT to Modify

- `src/audio/types.ts` — types are correct
- `src/config/types.openclaw.ts` — TypeScript type already added
- `src/gateway/server-audio.ts` — wiring is done (025f)
- Any test file outside `src/config/`

## Rebuild Required

After merging, run `rebuild.ps1 -Build` to pick up the schema change and the new `openclaw.json` config. The gateway will then start with audio capture enabled.

## Out of Scope

- Changes to audio capture behavior
- Changes to how the config is consumed (025f handles that)
- LAN bind config (already in `openclaw.json` from earlier change)
