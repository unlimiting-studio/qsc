import { extname } from "node:path";
import { getLanguageConfig } from "./languages/index.js";
import { createAstChunker } from "./ast.js";
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

export function createChunker(config: ChunkerConfig): Chunker {
  const maxTokens = config.max_tokens;
  const overlap = config.overlap;

  return {
    async chunk(content: string, filePath: string): Promise<Chunk[]> {
      const ext = extname(filePath).toLowerCase();
      const langConfig = getLanguageConfig(ext);

      if (langConfig) {
        try {
          const astChunker = await createAstChunker(langConfig, maxTokens);
          return astChunker.chunk(content, filePath);
        } catch {
          // AST parsing failed, fall through to token chunker
        }
      }

      const tokenChunker = createTokenChunker(maxTokens, overlap);
      return tokenChunker.chunk(content, filePath);
    },
  };
}
