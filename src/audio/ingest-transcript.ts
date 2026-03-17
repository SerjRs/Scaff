/**
 * Transcript ingestion — create Library article + extract facts into Hippocampus.
 *
 * Called after transcription completes. Does NOT depend on any gateway
 * or HTTP server state — receives all dependencies via params.
 *
 * @see workspace/pipeline/InProgress/025e-transcription-worker/SPEC.md
 */

import type { DatabaseSync } from "node:sqlite";
import { insertItem } from "../library/db.js";
import { insertFact, insertEdge } from "../cortex/hippocampus.js";
import type { FactExtractorLLM, ExtractionResult } from "../cortex/gardener.js";
import { extractFactsFromTranscript } from "../cortex/gardener.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Transcript {
  sessionId: string;
  startedAt: string;
  endedAt?: string;
  durationMinutes: number;
  language: string;
  segments: Array<{
    speaker: "user" | "others";
    start: number;
    end: number;
    text: string;
  }>;
  fullText: string;
}

export interface IngestionDeps {
  /** Library database (library.sqlite). */
  libraryDb: DatabaseSync;
  /** Cortex bus database (bus.sqlite) — for hippocampus facts/edges. */
  busDb: DatabaseSync;
  /** LLM function for fact extraction. If omitted, fact extraction is skipped. */
  extractLLM?: FactExtractorLLM;
}

export interface IngestionResult {
  libraryItemId: number;
  factsInserted: number;
  edgesInserted: number;
}

// ---------------------------------------------------------------------------
// Main ingestion
// ---------------------------------------------------------------------------

/**
 * Ingest a completed transcript into the knowledge graph.
 *
 * 1. Creates a Library article with the full transcript text.
 * 2. Runs fact extraction via LLM (if extractLLM provided).
 * 3. Inserts facts + edges into Hippocampus.
 */
export async function ingestTranscript(
  transcript: Transcript,
  deps: IngestionDeps,
): Promise<IngestionResult> {
  // 1. Create Library article
  const date = new Date(transcript.startedAt);
  const dateStr = date.toISOString().slice(0, 10);
  const timeStr = date.toISOString().slice(11, 16);

  const title = `Meeting Transcript — ${dateStr} ${timeStr} (${transcript.durationMinutes}min)`;
  const url = `audio-capture://${transcript.sessionId}`;

  const libraryItemId = insertItem(deps.libraryDb, {
    url,
    title,
    summary: buildSummary(transcript),
    key_concepts: extractTopics(transcript),
    full_text: transcript.fullText.slice(0, 50_000), // cap at 50KB
    tags: ["meeting", "transcript", "audio-capture"],
    content_type: "article",
    source_quality: "medium",
  });

  // 2. Extract facts via LLM (optional)
  let factsInserted = 0;
  let edgesInserted = 0;

  if (deps.extractLLM) {
    const extraction = await extractFactsFromTranscript(
      deps.extractLLM,
      transcript.fullText,
      "This is an audio meeting transcript. Focus on action items, decisions, key data points, people mentioned, and deadlines.",
    );

    // 3. Insert source node
    const sourceFactId = insertFact(deps.busDb, {
      factText: title,
      factType: "source",
      confidence: "high",
      sourceType: "audio-capture",
      sourceRef: `library://item/${libraryItemId}`,
    });

    // 4. Insert extracted facts
    const localIdToFactId = new Map<string, string>();

    for (const fact of extraction.facts) {
      const factId = insertFact(deps.busDb, {
        factText: fact.text,
        factType: fact.type,
        confidence: fact.confidence,
        sourceType: "audio-capture",
        sourceRef: `library://item/${libraryItemId}`,
      });
      localIdToFactId.set(fact.id, factId);
      factsInserted++;

      // Link fact → source
      insertEdge(deps.busDb, {
        fromFactId: factId,
        toFactId: sourceFactId,
        edgeType: "sourced_from",
        confidence: "high",
      });
      edgesInserted++;
    }

    // 5. Insert inter-fact edges
    for (const edge of extraction.edges) {
      const fromId = localIdToFactId.get(edge.from);
      const toId = localIdToFactId.get(edge.to);
      if (fromId && toId) {
        insertEdge(deps.busDb, {
          fromFactId: fromId,
          toFactId: toId,
          edgeType: edge.type,
        });
        edgesInserted++;
      }
    }
  }

  return { libraryItemId, factsInserted, edgesInserted };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildSummary(transcript: Transcript): string {
  const speakerCount = new Set(transcript.segments.map((s) => s.speaker)).size;
  const segmentCount = transcript.segments.length;
  return `${transcript.durationMinutes}-minute meeting transcript with ${speakerCount} speaker(s) and ${segmentCount} segments.`;
}

/** Extract simple topic keywords from transcript text. */
function extractTopics(transcript: Transcript): string[] {
  // Basic keyword extraction — just use speaker labels + duration as concepts
  const topics: string[] = ["meeting", "transcript"];
  if (transcript.durationMinutes > 30) topics.push("long-meeting");
  if (transcript.segments.some((s) => s.speaker === "others")) topics.push("multi-party");
  return topics;
}
