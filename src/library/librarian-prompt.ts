/**
 * Librarian Executor Prompt
 *
 * Builds the prompt sent to the Librarian executor (Sonnet-class via Router).
 * The executor reads pre-fetched content and returns structured JSON.
 * The JSON is parsed by the gateway-bridge handler to write to the Library DB.
 *
 * @see docs/library-architecture.md §4
 */

/**
 * Build the Librarian executor prompt for a given URL and its content.
 */
export function buildLibrarianPrompt(url: string, content: string): string {
  const isTranscript = url.startsWith("audio-capture://");

  const contentTypeGuide = isTranscript
    ? `If the URL starts with "audio-capture://", this is a meeting transcript.
Focus on: action items and decisions made, key quotes and statements, participants mentioned,
deadlines and commitments. Use content_type: "transcript".`
    : "";

  return `You are a Librarian. Your job is to read, understand, and catalog knowledge.

You have been given content from this URL:
${url}
${contentTypeGuide ? `\n${contentTypeGuide}\n` : ""}
CONTENT:
${content}

Analyze the content and produce a structured knowledge entry as JSON.
Output ONLY valid JSON, no markdown, no explanation:

{
  "title": "...",
  "summary": "200-500 word summary capturing key ideas — what matters, not surface description. Focus on insights, findings, and actionable knowledge.",
  "key_concepts": ["atomic statement 1", "atomic statement 2", ...],
  "tags": ["kebab-case-tag-1", "kebab-case-tag-2", ...],
  "content_type": "article|documentation|tutorial|research|tool|discussion|transcript",
  "source_quality": "high|medium|low",
  "full_text": "raw article content (see rules)",
  "facts": [
    {"id": "f1", "text": "...", "type": "fact|decision|outcome|correction", "confidence": "high|medium|low"},
    ...
  ],
  "edges": [
    {"from": "f1", "to": "f2", "type": "because|informed_by|resulted_in|contradicts|updated_by|related_to"},
    ...
  ]
}

Rules:
- summary: 200-500 words. Extract INSIGHTS, not surface description. What could someone apply or learn?
- key_concepts: 3-7 atomic statements. Each should stand alone as a fact or insight.
- tags: 3-10 tags, kebab-case, specific. Not generic ("ai", "tech"). Specific ("erlang-supervisors", "o-ran-fronthaul").
- content_type: pick the most accurate classification.
- source_quality: "high" = deep, well-cited, authoritative. "medium" = useful but surface-level. "low" = opinion, thin, or questionable.
- full_text: Include the raw article content in full_text. Cap at 50KB. If content exceeds 50KB, truncate and append "[TRUNCATED]".
- facts: Extract 3-10 key facts from the article. Each should be a standalone statement of knowledge. Types: fact (claims, data points), decision (recommendations, conclusions), outcome (results, findings), correction (debunking, errata).
- edges: Identify relationships between extracted facts. Only include edges where the relationship is clearly stated in the article. If no clear relationships exist, use an empty array.

Output ONLY the JSON object.`;
}
