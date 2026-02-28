import type { LLMProvider } from "../llm/index.js";
import type { FusedResult } from "./fusion.js";

export interface RerankedResult extends FusedResult {
  scores: FusedResult["scores"] & {
    rerank?: number;
  };
}

/**
 * Rerank fused results using an LLM for relevance scoring.
 * If no LLM is provided, returns the input results unchanged.
 *
 * Uses position-aware blending: top-ranked items keep more of their RRF score,
 * while lower-ranked items rely more on the reranker score.
 */
export async function rerank(
  query: string,
  results: FusedResult[],
  llm?: LLMProvider,
  options: { topN?: number } = {},
): Promise<RerankedResult[]> {
  if (!llm || results.length === 0) {
    return results.map((r) => ({ ...r }));
  }

  const topN = options.topN ?? results.length;
  const toRerank = results.slice(0, topN);
  const rest = results.slice(topN);

  try {
    // Use LLM rerank API: pass documents and get relevance scores
    const documents = toRerank.map((r) => {
      const header = r.name
        ? `[${r.chunkType ?? "chunk"}] ${r.name} (${r.filePath})`
        : `[${r.chunkType ?? "chunk"}] ${r.filePath}`;
      return `${header}\n${r.content}`;
    });

    const scores = await llm.rerank(query, documents);

    // Normalize rerank scores to 0–1
    const maxScore = Math.max(...scores, 1);
    const normalizedScores = scores.map((s) => Math.max(0, s / maxScore));

    // Position-aware blending: blend RRF and rerank scores
    const reranked: RerankedResult[] = toRerank.map((r, i) => {
      const rerankScore = normalizedScores[i] ?? 0;
      // Weight shifts from RRF to rerank as position increases
      const position = i / Math.max(toRerank.length - 1, 1);
      const rrfWeight = 1 - position * 0.5; // 1.0 at top, 0.5 at bottom
      const rerankWeight = 0.5 + position * 0.5; // 0.5 at top, 1.0 at bottom
      const blendedScore =
        (rrfWeight * r.score + rerankWeight * rerankScore) /
        (rrfWeight + rerankWeight);

      return {
        ...r,
        score: blendedScore,
        scores: {
          ...r.scores,
          rerank: rerankScore,
        },
      };
    });

    // Sort by blended score
    reranked.sort((a, b) => b.score - a.score);

    // Append non-reranked items
    const restMapped: RerankedResult[] = rest.map((r) => ({ ...r }));
    return [...reranked, ...restMapped];
  } catch {
    // LLM failure: graceful fallback to original ordering
    return results.map((r) => ({ ...r }));
  }
}
