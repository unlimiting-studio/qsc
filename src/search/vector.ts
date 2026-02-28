import type { Store, VectorResult } from "../store.js";
import type { Embedder } from "../embedder/index.js";

export interface VectorSearchResult {
  chunkId: number;
  fileId: number;
  filePath: string;
  content: string;
  startLine: number | null;
  endLine: number | null;
  chunkType: string | null;
  name: string | null;
  score: number;
}

/**
 * Convert cosine distance to similarity score (0–1, higher is better).
 */
function distanceToScore(distance: number): number {
  return Math.max(0, 1 - distance);
}

/**
 * Perform vector similarity search.
 * Embeds the query text using the provided Embedder, then searches via Store.searchVector.
 */
export async function searchVector(
  store: Store,
  embedder: Embedder,
  query: string,
  limit = 20,
): Promise<VectorSearchResult[]> {
  const [embedding] = await embedder.embed([query]);
  if (!embedding || embedding.length === 0) return [];

  const float32 = new Float32Array(embedding);
  const raw: VectorResult[] = store.searchVector(float32, limit);

  return raw.map((r) => ({
    chunkId: r.chunk_id,
    fileId: r.file_id,
    filePath: r.file_path,
    content: r.content,
    startLine: r.start_line,
    endLine: r.end_line,
    chunkType: r.chunk_type,
    name: r.name,
    score: distanceToScore(r.distance),
  }));
}

/**
 * Perform vector search with a pre-computed embedding.
 */
export function searchVectorWithEmbedding(
  store: Store,
  embedding: number[],
  limit = 20,
): VectorSearchResult[] {
  const float32 = new Float32Array(embedding);
  const raw: VectorResult[] = store.searchVector(float32, limit);

  return raw.map((r) => ({
    chunkId: r.chunk_id,
    fileId: r.file_id,
    filePath: r.file_path,
    content: r.content,
    startLine: r.start_line,
    endLine: r.end_line,
    chunkType: r.chunk_type,
    name: r.name,
    score: distanceToScore(r.distance),
  }));
}
