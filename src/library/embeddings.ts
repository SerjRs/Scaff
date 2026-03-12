/**
 * Library Embedding Generation via Ollama nomic-embed-text.
 *
 * Same model and endpoint used by Hippocampus cold storage and code-search.
 * Ollama endpoint: http://127.0.0.1:11434
 * Model: nomic-embed-text
 * Dimension: 768
 *
 * @see docs/library-architecture.md §5
 */

export async function generateEmbedding(text: string): Promise<number[]> {
  const response = await fetch("http://127.0.0.1:11434/api/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "nomic-embed-text",
      prompt: text,
    }),
    signal: AbortSignal.timeout(5_000),
  });

  if (!response.ok) {
    throw new Error(`Ollama embedding failed: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as { embedding: number[] };
  return data.embedding;
}
