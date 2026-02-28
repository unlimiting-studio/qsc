import type { EmbedderConfig } from "../config/index.js";

/**
 * Metadata about a text being embedded, used for logging/debugging.
 */
export interface EmbedTextMeta {
  chunkId?: number;
  filePath?: string;
}

/**
 * Embedder interface: converts text strings into vector embeddings.
 */
export interface Embedder {
  embed(texts: string[], meta?: EmbedTextMeta[]): Promise<number[][]>;
  readonly dimensions: number;
  readonly modelName: string;
}

/**
 * Factory function: creates an Embedder instance based on config.
 */
export async function createEmbedder(config: EmbedderConfig): Promise<Embedder> {
  switch (config.provider) {
    case "openai": {
      const { createOpenAIEmbedder } = await import("./openai.js");
      return createOpenAIEmbedder(config);
    }
    case "local": {
      const { createLocalEmbedder } = await import("./local.js");
      return createLocalEmbedder(config);
    }
    default:
      throw new Error(`Unknown embedder provider: ${config.provider as string}`);
  }
}
