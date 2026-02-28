import type { Store } from "../store.js";
import type { Embedder } from "../embedder/index.js";
import type { LLMProvider } from "../llm/index.js";
import { searchBM25, type BM25SearchResult } from "./bm25.js";
import { searchVector, searchVectorWithEmbedding, type VectorSearchResult } from "./vector.js";
import { expandQuery, type ExpandedQuery } from "./expander.js";
import { reciprocalRankFusion } from "./fusion.js";
import { rerank, type RerankedResult } from "./reranker.js";
import type { FusedResult } from "./fusion.js";
import { applyFilters, hasFilters, type QueryFilters } from "./filter.js";

// --- Public types ---

export interface SearchTiming {
  total: number;
  expand?: number;
  bm25?: number;
  vector?: number;
  fusion?: number;
  rerank?: number;
}

export interface SearchOptions {
  mode: "bm25" | "vector" | "hybrid";
  limit?: number;
  expand?: boolean;
  rerank?: boolean;
  rrfK?: number;
  benchmark?: boolean;
  filters?: QueryFilters;
}

export interface SearchResult {
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
    rrf?: number;
    rerank?: number;
  };
}

export interface SearchResponse {
  results: SearchResult[];
  timing?: SearchTiming;
  counts?: {
    bm25?: number;
    vector?: number;
  };
}

export interface SearchPipeline {
  search(query: string, options?: SearchOptions): Promise<SearchResponse>;
}

// --- Factory ---

/**
 * Create a hybrid search pipeline.
 *
 * @param store - SQLite store with searchBM25 and searchVector
 * @param embedder - (optional) embedding provider for vector search
 * @param llm - (optional) LLM provider for query expansion and reranking
 */
export function createSearchPipeline(
  store: Store,
  embedder?: Embedder,
  llm?: LLMProvider,
): SearchPipeline {
  return {
    async search(
      query: string,
      options: SearchOptions = { mode: "hybrid" },
    ): Promise<SearchResponse> {
      const limit = options.limit ?? 20;
      const filters = options.filters;
      const hasActiveFilters = filters != null && hasFilters(filters);
      // Fetch more when filters are active since post-filtering may reduce result count
      const fetchLimit = hasActiveFilters ? limit * 10 : limit * 3;
      const bench = options.benchmark ?? false;

      const timing: SearchTiming = { total: 0 };
      const counts: { bm25?: number; vector?: number } = {};
      const totalStart = bench ? performance.now() : 0;

      // Step 1: (Optional) Query expansion
      let expanded: ExpandedQuery[] = [];
      if (options.expand && llm) {
        const t0 = bench ? performance.now() : 0;
        expanded = await expandQuery(query, llm);
        if (bench) timing.expand = performance.now() - t0;
      }

      // Separate expanded queries by target search type
      const lexQueries = expanded.filter((e) => e.type === "lex");
      const vecQueries = expanded.filter((e) => e.type === "vec" || e.type === "hyde");

      // Step 2: Execute searches based on mode
      const bm25Lists: BM25SearchResult[][] = [];
      const vectorLists: VectorSearchResult[][] = [];

      if (options.mode === "bm25" || options.mode === "hybrid") {
        const t0 = bench ? performance.now() : 0;

        // Original query BM25 (index 0 = original, gets higher weight)
        bm25Lists.push(searchBM25(store, query, fetchLimit));

        // Expanded lex queries
        for (const eq of lexQueries) {
          bm25Lists.push(searchBM25(store, eq.text, fetchLimit));
        }

        if (bench) {
          timing.bm25 = performance.now() - t0;
          counts.bm25 = bm25Lists.reduce((sum, list) => sum + list.length, 0);
        }
      }

      if (
        (options.mode === "vector" || options.mode === "hybrid") &&
        embedder
      ) {
        const t0 = bench ? performance.now() : 0;

        // Batch embed all vector queries at once
        const vecQueryTexts = [query, ...vecQueries.map((e) => e.text)];
        const embeddings = await embedder.embed(vecQueryTexts);

        // Original query vector search (index 0)
        for (let i = 0; i < embeddings.length; i++) {
          vectorLists.push(
            searchVectorWithEmbedding(store, embeddings[i], fetchLimit),
          );
        }

        if (bench) {
          timing.vector = performance.now() - t0;
          counts.vector = vectorLists.reduce((sum, list) => sum + list.length, 0);
        }
      }

      // Step 3: Combine results via RRF
      let fused: FusedResult[];

      {
        const t0 = bench ? performance.now() : 0;

        // When filters are active, pass fetchLimit to RRF to get more candidates
        const fusionLimit = hasActiveFilters ? fetchLimit : (options.rerank ? fetchLimit : limit);

        if (options.mode === "bm25") {
          fused = reciprocalRankFusion(bm25Lists, [], {
            k: options.rrfK,
            limit: fusionLimit,
          });
        } else if (options.mode === "vector") {
          if (vectorLists.length === 0) {
            if (bench) timing.total = performance.now() - totalStart;
            return { results: [], timing: bench ? timing : undefined, counts: bench ? counts : undefined };
          }
          fused = reciprocalRankFusion([], vectorLists, {
            k: options.rrfK,
            limit: fusionLimit,
          });
        } else {
          fused = reciprocalRankFusion(bm25Lists, vectorLists, {
            k: options.rrfK,
            limit: fusionLimit,
          });
        }

        if (bench) timing.fusion = performance.now() - t0;
      }

      // Step 3.5: Apply inline filters (post-filtering by filePath)
      if (hasActiveFilters) {
        fused = applyFilters(fused, filters!);
      }

      // Step 4: (Optional) LLM reranking
      let finalResults: Array<FusedResult | RerankedResult>;
      if (options.rerank && llm && fused.length > 0) {
        const t0 = bench ? performance.now() : 0;
        const reranked = await rerank(query, fused, llm, {
          topN: Math.min(fused.length, limit * 2),
        });
        finalResults = reranked.slice(0, limit);
        if (bench) timing.rerank = performance.now() - t0;
      } else {
        finalResults = fused.slice(0, limit);
      }

      if (bench) timing.total = performance.now() - totalStart;

      // Convert to SearchResult
      const results = finalResults.map((r) => ({
        chunkId: r.chunkId,
        fileId: r.fileId,
        filePath: r.filePath,
        content: r.content,
        startLine: r.startLine,
        endLine: r.endLine,
        chunkType: r.chunkType,
        name: r.name,
        score: r.score,
        scores: {
          bm25: r.scores.bm25,
          vector: r.scores.vector,
          rrf: r.scores.rrf,
          rerank: "rerank" in r.scores ? r.scores.rerank : undefined,
        },
      }));

      return {
        results,
        timing: bench ? timing : undefined,
        counts: bench ? counts : undefined,
      };
    },
  };
}

// Re-export sub-module types for convenience
export type { BM25SearchResult } from "./bm25.js";
export type { VectorSearchResult } from "./vector.js";
export type { ExpandedQuery, ExpandedQueryType } from "./expander.js";
export type { FusedResult } from "./fusion.js";
export type { RerankedResult } from "./reranker.js";
export { parseQuery, applyFilters, matchesFilters, hasFilters } from "./filter.js";
export type { ParsedQuery, QueryFilters } from "./filter.js";
