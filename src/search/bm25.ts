import type { Store, BM25Result } from "../store.js";

export interface BM25SearchResult {
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
 * Normalize FTS5 BM25 rank to a 0–1 score (higher is better).
 * FTS5 BM25 rank is negative; lower (more negative) means stronger match.
 * Formula: |rank| / (1 + |rank|)
 */
function normalizeBM25Rank(rank: number): number {
  const abs = Math.abs(rank);
  return abs / (1 + abs);
}

/**
 * Perform BM25 full-text search via Store.searchBM25.
 */
export function searchBM25(
  store: Store,
  query: string,
  limit = 20,
): BM25SearchResult[] {
  const raw: BM25Result[] = store.searchBM25(query, limit);
  return raw.map((r) => ({
    chunkId: r.chunk_id,
    fileId: r.file_id,
    filePath: r.file_path,
    content: r.content,
    startLine: r.start_line,
    endLine: r.end_line,
    chunkType: r.chunk_type,
    name: r.name,
    score: normalizeBM25Rank(r.rank),
  }));
}
