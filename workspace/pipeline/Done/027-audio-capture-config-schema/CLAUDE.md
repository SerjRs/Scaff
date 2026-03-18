# CLAUDE.md — 027 Audio Capture Config Schema

## Branch
`feat/027-audio-capture-config-schema`

Create from `main`. All commits go here. Merge to `main` when done.

## What To Build

Add `audioCapture` as a valid optional top-level key to the Zod config schema in `src/config/zod-schema.ts` so `openclaw.json` accepts it without throwing "Unrecognized key".

Read SPEC.md for full details. Summary:

### Step 1 — Add Zod schema (`src/config/zod-schema.ts`)

Find the `router` block near the end of the top-level schema object. Add `audioCapture` right after it, before the closing `.strict()`:

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

The `sensitive` variable is already in scope in that file — look at how `apiKey` is registered elsewhere (e.g. in the `gateway.auth` block).

### Step 2 — Update `openclaw.json`

Add the `audioCapture` block (enabled, with a real apiKey):

```json
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
```

### Step 3 — Write tests (`src/config/config.audio-capture.test.ts`)

6 tests covering:
- Valid full config → passes
- Valid partial config (only enabled + apiKey) → passes
- Absent audioCapture key → passes
- Unknown key inside audioCapture → fails validation
- Wrong type (e.g. maxChunkSizeMB as string) → fails
- apiKey is redacted in config snapshot

Look at existing config test files (e.g. `src/config/config.schema-regressions.test.ts`) for the pattern.

## Constraints

- Do NOT modify `src/audio/types.ts` or `src/config/types.openclaw.ts` — already correct
- Do NOT modify any gateway or audio source files
- All work inside `C:\Users\Temp User\.openclaw`
- Make ALL decisions yourself

## Working Directory

`C:\Users\Temp User\.openclaw`

## Git Workflow

```powershell
git checkout -b feat/027-audio-capture-config-schema
# changes...
git add -A
git commit -m "027: add audioCapture to Zod config schema"
git checkout main
git merge feat/027-audio-capture-config-schema --no-edit
git push
```

## Test Commands

```powershell
npx vitest run src/config/
```

All existing config tests must pass. New 6 tests on top.

## Done Criteria

- `audioCapture` accepted in `openclaw.json` without validation error
- `openclaw.json` has the block enabled with apiKey
- 6 new tests pass
- All existing config tests pass
- Committed, merged to main, pushed
- STATE.md shows `STATUS: COMPLETE`
