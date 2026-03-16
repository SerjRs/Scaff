#!/usr/bin/env npx tsx
/**
 * Migration script: extract facts+edges from existing Library items
 * into the hippocampus knowledge graph using Haiku via gateway auth.
 *
 * Usage:
 *   npx tsx scripts/library-to-graph.ts
 *   npx tsx scripts/library-to-graph.ts --dry-run
 *   npx tsx scripts/library-to-graph.ts --limit 3
 */

import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { complete } from "../src/llm/simple-complete.js";
import { insertFact, insertEdge } from "../src/cortex/hippocampus.js";
import { dedupAndInsertGraphFact } from "../src/cortex/gardener.js";

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const limitIdx = args.indexOf("--limit");
const LIMIT = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : Infinity;

// ---------------------------------------------------------------------------
// Database paths
// ---------------------------------------------------------------------------
import { homedir } from "node:os";
const OPENCLAW_ROOT = join(homedir(), ".openclaw");

const libraryDbPath = join(OPENCLAW_ROOT, "library", "library.sqlite");
const busDbPath = join(OPENCLAW_ROOT, "cortex", "bus.sqlite");

// ---------------------------------------------------------------------------
// LLM via reusable client (Haiku)
// ---------------------------------------------------------------------------
async function callLLM(prompt: string): Promise<string> {
  return complete(prompt, { model: "claude-haiku-4-5" });
}

// ---------------------------------------------------------------------------
// Embedding helper (Ollama nomic-embed-text)
// ---------------------------------------------------------------------------
async function embedFn(text: string): Promise<Float32Array> {
  const res = await fetch("http://127.0.0.1:11434/api/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "nomic-embed-text", prompt: text }),
  });
  const json = await res.json() as { embedding: number[] };
  return new Float32Array(json.embedding);
}

// ---------------------------------------------------------------------------
// Extraction prompt
// ---------------------------------------------------------------------------
function buildPrompt(title: string, summary: string, keyConcepts: string[], tags: string[], fullText?: string): string {
  let articleText = `Title: ${title}\nSummary: ${summary}\nKey Concepts: ${keyConcepts.join(", ")}\nTags: ${tags.join(", ")}`;
  if (fullText) {
    articleText += `\n\nFull Text:\n${fullText.slice(0, 10_000)}`;
  }

  return `From this article, extract facts and relationships between them.

CATEGORIES:
- fact: specific claims, data points, findings
- decision: recommendations, conclusions
- outcome: results, findings
- correction: debunking, errata

RELATIONSHIPS (only when clearly stated):
- because, informed_by, resulted_in, contradicts, updated_by, related_to

RULES:
- ONLY extract what is directly stated. Do NOT infer.
- Each fact must be a standalone statement.
- Assign confidence: high (explicitly stated), medium (clearly implied), low (loosely implied).
- If no facts found, return {"facts": [], "edges": []}

Return ONLY valid JSON:
{"facts": [{"id": "f1", "text": "...", "type": "fact", "confidence": "high"}], "edges": [{"from": "f1", "to": "f2", "type": "because"}]}

Article:
${articleText}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  if (DRY_RUN) console.log("=== DRY RUN — no writes will be made ===\n");

  console.log(`Library DB: ${libraryDbPath}`);
  console.log(`Bus DB:     ${busDbPath}\n`);

  if (!existsSync(libraryDbPath)) { console.error("Library DB not found!"); process.exit(1); }
  if (!existsSync(busDbPath)) { console.error("Bus DB not found!"); process.exit(1); }

  const libraryDb = new DatabaseSync(libraryDbPath, { open: true });
  const busDb = new DatabaseSync(busDbPath, { open: true, allowExtension: true });
  const sqliteVec = await import("sqlite-vec");
  sqliteVec.load(busDb);

  const items = libraryDb.prepare(`
    SELECT id, url, title, summary, key_concepts, tags, content_type, full_text
    FROM items WHERE status != 'failed' ORDER BY created_at ASC
  `).all() as any[];

  if (LIMIT < Infinity) console.log(`--limit ${LIMIT}: processing first ${LIMIT} items\n`);

  let processed = 0, skipped = 0, errors = 0, totalFacts = 0, totalEdges = 0;
  let count = 0;

  for (const item of items) {
    if (count >= LIMIT) break;
    count++;

    // Idempotency check
    const existing = busDb.prepare(
      `SELECT id FROM hippocampus_facts WHERE source_ref = ? AND fact_type = 'source'`
    ).get(`library://item/${item.id}`);

    if (existing) {
      console.log(`  Skip (already migrated): ${item.title}`);
      skipped++;
      continue;
    }

    console.log(`Processing: ${item.title}`);

    try {
      const keyConcepts = item.key_concepts ? JSON.parse(item.key_concepts) : [];
      const tags = item.tags ? JSON.parse(item.tags) : [];
      const prompt = buildPrompt(item.title, item.summary, keyConcepts, tags, item.full_text);

      const response = await callLLM(prompt);

      // Parse JSON
      let parsed: any;
      try {
        parsed = JSON.parse(response);
      } catch {
        const match = response.match(/\{[\s\S]*\}/);
        parsed = match ? JSON.parse(match[0]) : { facts: [], edges: [] };
      }

      const facts = parsed.facts ?? [];
      const edges = parsed.edges ?? [];

      if (DRY_RUN) {
        console.log(`  [DRY] Would extract: ${facts.length} facts, ${edges.length} edges`);
        totalFacts += facts.length;
        totalEdges += edges.length;
        processed++;
        continue;
      }

      // Create source node
      const sourceFactId = insertFact(busDb, {
        factText: `Article: ${item.title}`,
        factType: "source",
        confidence: "high",
        sourceType: "article",
        sourceRef: `library://item/${item.id}`,
      });

      const idMap = new Map<string, string>();

      for (const f of facts) {
        if (!f.text?.trim()) continue;
        const factId = insertFact(busDb, {
          factText: f.text.trim(),
          factType: f.type ?? "fact",
          confidence: f.confidence ?? "medium",
          sourceType: "article",
          sourceRef: `library://item/${item.id}`,
        });
        idMap.set(f.id, factId);
        insertEdge(busDb, { fromFactId: factId, toFactId: sourceFactId, edgeType: "sourced_from" });
      }

      for (const e of edges) {
        const fromId = idMap.get(e.from);
        const toId = idMap.get(e.to);
        if (fromId && toId && fromId !== toId) {
          insertEdge(busDb, { fromFactId: fromId, toFactId: toId, edgeType: e.type });
        }
      }

      console.log(`  Extracted: ${facts.length} facts, ${edges.length} edges`);
      totalFacts += facts.length;
      totalEdges += edges.length;
      processed++;
    } catch (err: any) {
      console.error(`  ERROR (LLM): ${err.message}`);
      errors++;
    }
  }

  libraryDb.close();
  busDb.close();

  console.log(`\n=== Migration Summary ===`);
  console.log(`Items processed: ${processed}`);
  console.log(`Items skipped:   ${skipped}`);
  console.log(`Errors:          ${errors}`);
  console.log(`Facts extracted: ${totalFacts}`);
  console.log(`Edges extracted: ${totalEdges}`);

  process.exit(errors > 0 ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
