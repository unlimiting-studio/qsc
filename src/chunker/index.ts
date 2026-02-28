import { extname } from "node:path";
import { getLanguageConfig } from "./languages/index.js";
import { createAstChunker, type AstChunker } from "./ast.js";
import { createTokenChunker } from "./token.js";
import type { ChunkerConfig } from "../config/index.js";

export interface Chunk {
  content: string;
  startLine: number;
  endLine: number;
  type: string;
  name?: string;
  language: string;
  metadata?: Record<string, unknown>;
}

export interface Chunker {
  chunk(content: string, filePath: string): Promise<Chunk[]>;
}

/**
 * Estimate token count (~4 chars per token).
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function createChunker(config: ChunkerConfig): Chunker {
  const maxTokens = config.max_tokens;
  const overlap = config.overlap;
  const maxChars = maxTokens * 4;

  // Cache AstChunker instances per language to reuse tree-sitter Parser objects.
  // Creating a new Parser for every file leaks WASM memory and causes OOM.
  const astChunkerCache = new Map<string, AstChunker>();

  /**
   * Safety net: split any chunk that still exceeds maxTokens.
   * This should rarely trigger since both AST and token chunkers now
   * enforce the limit, but it prevents oversized chunks from ever
   * reaching the store.
   */
  function enforceMaxTokens(chunks: Chunk[]): Chunk[] {
    const result: Chunk[] = [];
    for (const chunk of chunks) {
      if (estimateTokens(chunk.content) <= maxTokens) {
        result.push(chunk);
        continue;
      }

      // Split oversized chunk by lines, then by characters for very long lines
      const lines = chunk.content.split("\n");
      let currentLines: string[] = [];
      let currentStartLine = chunk.startLine;
      let currentTokens = 0;

      for (let i = 0; i < lines.length; i++) {
        const lineTokens = estimateTokens(lines[i] + "\n");

        // Single line exceeds maxTokens: split at character boundary
        if (lineTokens > maxTokens && currentLines.length === 0) {
          let offset = 0;
          while (offset < lines[i].length) {
            const slice = lines[i].slice(offset, offset + maxChars);
            if (slice.trim().length > 0) {
              result.push({
                content: slice,
                startLine: chunk.startLine + i,
                endLine: chunk.startLine + i,
                type: chunk.type,
                name: chunk.name,
                language: chunk.language,
              });
            }
            offset += maxChars;
          }
          currentStartLine = chunk.startLine + i + 1;
          continue;
        }

        if (currentTokens + lineTokens > maxTokens && currentLines.length > 0) {
          result.push({
            content: currentLines.join("\n"),
            startLine: currentStartLine,
            endLine: currentStartLine + currentLines.length - 1,
            type: chunk.type,
            name: chunk.name,
            language: chunk.language,
          });
          currentLines = [];
          currentStartLine = chunk.startLine + i;
          currentTokens = 0;
        }
        currentLines.push(lines[i]);
        currentTokens += lineTokens;
      }

      if (currentLines.length > 0 && currentLines.join("\n").trim().length > 0) {
        result.push({
          content: currentLines.join("\n"),
          startLine: currentStartLine,
          endLine: currentStartLine + currentLines.length - 1,
          type: chunk.type,
          name: chunk.name,
          language: chunk.language,
        });
      }
    }
    return result;
  }

  return {
    async chunk(content: string, filePath: string): Promise<Chunk[]> {
      const ext = extname(filePath).toLowerCase();
      const langConfig = getLanguageConfig(ext);
      let chunks: Chunk[];

      if (langConfig) {
        try {
          const cacheKey = langConfig.treeSitterLanguage;
          let astChunker = astChunkerCache.get(cacheKey);
          if (!astChunker) {
            astChunker = await createAstChunker(langConfig, maxTokens);
            astChunkerCache.set(cacheKey, astChunker);
          }
          chunks = astChunker.chunk(content, filePath);
        } catch {
          // AST parsing failed, fall through to token chunker
          const tokenChunker = createTokenChunker(maxTokens, overlap);
          chunks = tokenChunker.chunk(content, filePath);
        }
      } else {
        const tokenChunker = createTokenChunker(maxTokens, overlap);
        chunks = tokenChunker.chunk(content, filePath);
      }

      // Safety net: enforce maxTokens on all output chunks
      return enforceMaxTokens(chunks);
    },
  };
}
