import type { BM25SearchResult } from "./bm25.js";
import type { VectorSearchResult } from "./vector.js";

export interface FusedResult {
  chunkId: number;
  fileId: number;
  filePath: string;
  content: string;
  startLine: number | null;
  endLine: number | null;
  chunkType: string | null;
  name: string | null;
  score: number;
  scores: {
    bm25?: number;
    vector?: number;
    rrf: number;
  };
}

interface RankedItem {
  chunkId: number;
  fileId: number;
  filePath: string;
  content: string;
  startLine: number | null;
  endLine: number | null;
  chunkType: string | null;
  name: string | null;
  bm25Score?: number;
  vectorScore?: number;
}

/**
 * Reciprocal Rank Fusion (RRF) combining BM25 and vector search results.
 *
 * RRF score = sum of 1/(k + rank_i) across all ranked lists the item appears in.
 * Default k=60 (standard in literature).
 *
 * Items from the original query get 2x weight. Duplicates are merged by chunkId.
 */
export function reciprocalRankFusion(
  bm25Results: BM25SearchResult[][],
  vectorResults: VectorSearchResult[][],
  options: { k?: number; limit?: number; originalWeight?: number } = {},
): FusedResult[] {
  const k = options.k ?? 60;
  const limit = options.limit ?? 20;
  const originalWeight = options.originalWeight ?? 2;

  // Map chunkId -> accumulated data
  const items = new Map<number, RankedItem & { rrfScore: number }>();

  function ensureItem(
    chunkId: number,
    source: BM25SearchResult | VectorSearchResult,
  ) {
    if (!items.has(chunkId)) {
      items.set(chunkId, {
        chunkId: source.chunkId,
        fileId: source.fileId,
        filePath: source.filePath,
        content: source.content,
        startLine: source.startLine,
        endLine: source.endLine,
        chunkType: source.chunkType,
        name: source.name,
        rrfScore: 0,
      });
    }
    return items.get(chunkId)!;
  }

  // Process BM25 result lists
  for (let listIdx = 0; listIdx < bm25Results.length; listIdx++) {
    const list = bm25Results[listIdx];
    const weight = listIdx === 0 ? originalWeight : 1;
    for (let rank = 0; rank < list.length; rank++) {
      const r = list[rank];
      const item = ensureItem(r.chunkId, r);
      item.rrfScore += weight / (k + rank + 1);
      // Keep best BM25 score
      if (item.bm25Score === undefined || r.score > item.bm25Score) {
        item.bm25Score = r.score;
      }
    }
  }

  // Process vector result lists
  for (let listIdx = 0; listIdx < vectorResults.length; listIdx++) {
    const list = vectorResults[listIdx];
    const weight = listIdx === 0 ? originalWeight : 1;
    for (let rank = 0; rank < list.length; rank++) {
      const r = list[rank];
      const item = ensureItem(r.chunkId, r);
      item.rrfScore += weight / (k + rank + 1);
      // Keep best vector score
      if (item.vectorScore === undefined || r.score > item.vectorScore) {
        item.vectorScore = r.score;
      }
    }
  }

  // Sort by RRF score descending and return top results
  const sorted = Array.from(items.values())
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .slice(0, limit);

  return sorted.map((item) => ({
    chunkId: item.chunkId,
    fileId: item.fileId,
    filePath: item.filePath,
    content: item.content,
    startLine: item.startLine,
    endLine: item.endLine,
    chunkType: item.chunkType,
    name: item.name,
    score: item.rrfScore,
    scores: {
      bm25: item.bm25Score,
      vector: item.vectorScore,
      rrf: item.rrfScore,
    },
  }));
}
