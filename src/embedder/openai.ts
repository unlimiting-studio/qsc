import OpenAI from "openai";
import type { EmbedderConfig } from "../config/index.js";
import type { Embedder } from "./index.js";

const MAX_BATCH_SIZE = 2048;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

/**
 * Creates an OpenAI-backed Embedder.
 *
 * Supports text-embedding-3-small (1536d) and text-embedding-3-large (3072d).
 * Handles batch splitting and retry with exponential backoff for rate limits.
 */
export function createOpenAIEmbedder(config: EmbedderConfig): Embedder {
  const apiKey = process.env[config.api_key_env];
  if (!apiKey) {
    throw new Error(
      `Missing API key: environment variable "${config.api_key_env}" is not set`,
    );
  }

  const client = new OpenAI({ apiKey });
  const model = config.model;
  const dimensions = config.dimensions;

  async function embedBatch(texts: string[]): Promise<number[][]> {
    let lastError: unknown;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const response = await client.embeddings.create({
          model,
          input: texts,
          dimensions,
        });

        // Sort by index to preserve input order
        const sorted = response.data.sort((a, b) => a.index - b.index);
        return sorted.map((item) => item.embedding);
      } catch (error: unknown) {
        lastError = error;

        // Retry on rate limit (429) or server errors (5xx)
        const status =
          error instanceof OpenAI.APIError ? error.status : undefined;
        if (status === 429 || (status !== undefined && status >= 500)) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        // Non-retryable error
        throw error;
      }
    }

    throw lastError;
  }

  const embedder: Embedder = {
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];

      // Split into batches respecting API limits
      const results: number[][] = [];
      for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
        const batch = texts.slice(i, i + MAX_BATCH_SIZE);
        const batchResults = await embedBatch(batch);
        results.push(...batchResults);
      }

      return results;
    },

    get dimensions() {
      return dimensions;
    },

    get modelName() {
      return model;
    },
  };

  return embedder;
}
