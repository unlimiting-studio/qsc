import OpenAI from "openai";
import type { EmbedderConfig } from "../config/index.js";
import type { Embedder } from "./index.js";

const MAX_BATCH_SIZE = 2048;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

/**
 * Maximum tokens per OpenAI embedding API request.
 * The actual API limit is 300,000 tokens. We use 250,000 as a safety margin
 * since our token estimation (string length / 4) is approximate.
 */
const MAX_TOKENS_PER_REQUEST = 250_000;

/**
 * Maximum characters for a single chunk before truncation.
 * A single chunk cannot exceed the API token limit by itself.
 * 250,000 tokens * 4 chars/token = 1,000,000 characters.
 */
const MAX_CHARS_PER_CHUNK = MAX_TOKENS_PER_REQUEST * 4;

/**
 * Estimates the number of tokens in a string.
 * Uses a rough approximation of ~4 characters per token for English text / code.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Splits an array of texts into batches that respect both the item count limit
 * (MAX_BATCH_SIZE) and the estimated token count limit (MAX_TOKENS_PER_REQUEST).
 *
 * If a single text exceeds MAX_CHARS_PER_CHUNK, it is truncated to fit within
 * the token limit.
 *
 * Returns an array of batches, where each batch is an array of
 * { index, text } objects preserving the original indices.
 */
export function splitBatchesByTokens(
  texts: string[],
): { index: number; text: string }[][] {
  const batches: { index: number; text: string }[][] = [];
  let currentBatch: { index: number; text: string }[] = [];
  let currentTokens = 0;

  for (let i = 0; i < texts.length; i++) {
    let text = texts[i];

    // Truncate single oversized chunks
    if (text.length > MAX_CHARS_PER_CHUNK) {
      text = text.slice(0, MAX_CHARS_PER_CHUNK);
    }

    const tokens = estimateTokens(text);

    // If adding this text would exceed the token limit or batch size limit,
    // flush the current batch first (unless it's empty)
    if (
      currentBatch.length > 0 &&
      (currentTokens + tokens > MAX_TOKENS_PER_REQUEST ||
        currentBatch.length >= MAX_BATCH_SIZE)
    ) {
      batches.push(currentBatch);
      currentBatch = [];
      currentTokens = 0;
    }

    currentBatch.push({ index: i, text });
    currentTokens += tokens;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}

/**
 * Creates an OpenAI-backed Embedder.
 *
 * Supports text-embedding-3-small (1536d) and text-embedding-3-large (3072d).
 * Handles batch splitting by token count and retry with exponential backoff for rate limits.
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

      // Split into batches respecting both item count and token limits
      const batches = splitBatchesByTokens(texts);
      const results: number[][] = new Array(texts.length);

      for (const batch of batches) {
        const batchTexts = batch.map((item) => item.text);
        const batchResults = await embedBatch(batchTexts);

        // Place results back in their original positions
        for (let j = 0; j < batch.length; j++) {
          results[batch[j].index] = batchResults[j];
        }
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
