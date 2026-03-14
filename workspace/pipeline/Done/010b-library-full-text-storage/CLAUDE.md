# Claude Code Instructions — 010b

## Branch
`feat/010b-library-full-text-storage`

## What to Build
1. **Modify Librarian prompt** (`src/library/librarian-prompt.ts`):
   - Add `full_text` field to the JSON output schema in the executor prompt
   - Instruct the executor: "Include the raw article content in `full_text`. Cap at 50KB. If content exceeds 50KB, truncate with a note."

2. **Pass full_text through** (`src/cortex/gateway-bridge.ts`):
   - In the Library task handler (~line 349), add `full_text: parsed.full_text` to the `insertItem()` call
   - The `insertItem` function already accepts `full_text` — just needs the value passed

## Constraints
- Do NOT modify the DB schema (full_text column already exists)
- Do NOT change the insertItem function (it already handles full_text)
- Keep the Librarian prompt changes minimal — just add the field to the output schema
- Update STATE.md after each milestone

## Test
- Read the modified prompt and verify `full_text` is in the output schema
- Check gateway-bridge passes `parsed.full_text` to insertItem
