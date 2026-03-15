# Claude Code Instructions — 017f

## Branch
`feat/017f-replace-library-breadcrumbs`

## Context
Currently, every Cortex turn embeds the user's message, searches Library items by similarity, and injects the top-10 results as "breadcrumbs" into the System Floor. With 017e, article facts now live in the knowledge graph (`hippocampus_facts` with `sourced_from` edges). The Library breadcrumbs are redundant — graph hot memory already surfaces article-derived facts. This task removes the breadcrumb injection and updates the system prompt guidance.

## What to Build

### 1. Remove Library breadcrumb injection — `src/cortex/context.ts`

Find the block labeled `// 1b. Library breadcrumbs` (around lines 422-447). This block:
- Imports `openLibraryDbReadonly`, `getBreadcrumbs`, `formatBreadcrumbs` from `../library/retrieval.js`
- Opens the library DB
- Embeds the user message
- Calls `getBreadcrumbs()` for top-10 matches
- Appends formatted breadcrumbs to `systemFloor.content`

**Delete the entire block** from `// 1b. Library breadcrumbs` through the closing `catch` block (lines ~422-447). Keep the comment structure clean.

### 2. Update Library guidance in system prompt — `src/cortex/llm-caller.ts`

Find the `## Library` section in the system prompt (around lines 278-288). Replace it with:

```typescript
"## Library\n" +
"When the user shares a URL, always call library_ingest(url) to store it in the Library. " +
"Every link the user shares is domain knowledge worth retaining.\n\n" +
"Article-derived facts are indexed in the Knowledge Graph — they appear in Hot Memory " +
"with sourced_from edges linking back to the source article. " +
"Use graph_traverse to explore domain knowledge from any fact.\n\n" +
"Use library_get(id) to read the full article text when you need details beyond the extracted facts. " +
"Use library_search(query) to find items not yet surfaced through the graph. " +
"When you detect a knowledge gap — the user asks about something you can't answer well " +
"and the graph has no relevant facts — suggest they share relevant links: " +
"\"I don't have deep context on [topic]. If you have docs or articles, drop a link and I'll learn it.\"",
```

Key changes from current:
- Removed "Your context includes Library breadcrumbs" (no longer true)
- Added "Article-derived facts are indexed in the Knowledge Graph" (new source)
- Kept library_get, library_search, library_ingest guidance
- Kept knowledge gap suggestion

### 3. Clean up unused imports in context.ts

After removing the breadcrumb block, check if any imports from `../library/retrieval.js` or `../library/embeddings.js` are still used elsewhere in context.ts. If they're ONLY used in the deleted block, no static imports need removal (they're dynamic `await import()` calls inside the deleted block, so they'll be gone automatically).

## Files to Modify
| File | Change |
|------|--------|
| `src/cortex/context.ts` | Remove Library breadcrumb injection block (~lines 422-447) |
| `src/cortex/llm-caller.ts` | Update `## Library` section in system prompt |

## Tests

Write tests in `src/cortex/__tests__/library-breadcrumbs-removed.test.ts`:

1. **System prompt no longer mentions breadcrumbs** — import the system prompt builder function and verify the output does NOT contain "breadcrumbs" but DOES contain "Knowledge Graph" and "sourced_from"
2. **System prompt still mentions library_get and library_search** — verify these tools are still referenced
3. **System prompt still mentions library_ingest** — verify URL ingestion guidance remains

For test setup, check how `llm-caller.ts` builds the system prompt. The system parts are built in `buildAnthropicRequest()`. You may need to call it with mock context or simply grep the string constants. Use the simplest approach that validates the content.

## Constraints
- Do NOT remove any Library tools (library_get, library_search, library_stats, library_ingest)
- Do NOT remove the Library DB, embeddings, or retrieval modules
- Do NOT modify `src/library/` files
- The Library breadcrumb block in context.ts uses dynamic imports (`await import()`), so removing the block is clean — no static import cleanup needed
- When done, commit, push branch, create PR, then run: `openclaw system event --text "Done 017f library breadcrumbs replaced"`
