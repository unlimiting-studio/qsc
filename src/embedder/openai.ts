import OpenAI from "openai";
import type { EmbedderConfig } from "../config/index.js";
import type { Embedder, EmbedTextMeta } from "./index.js";

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

  /**
   * Attempts to embed a batch of texts. On failure (e.g. 400 token limit
   * exceeded), recursively splits the batch in half and retries each half.
   * When a batch of size 1 still fails, logs a warning and returns a zero
   * vector so the rest of the pipeline can continue.
   */
  async function embedBatchWithFallback(
    texts: string[],
    metaItems?: EmbedTextMeta[],
  ): Promise<number[][]> {
    try {
      return await embedBatch(texts);
    } catch (error: unknown) {
      // Only apply split-and-retry for 400 errors (token limit exceeded, etc.)
      const status =
        error instanceof OpenAI.APIError ? error.status : undefined;
      if (status !== 400) {
        throw error;
      }

      // Single item batch that still fails → skip with zero vector
      if (texts.length <= 1) {
        const m = metaItems?.[0];
        const metaInfo = m
          ? ` [chunk_id=${m.chunkId ?? "?"}, file=${m.filePath ?? "?"}]`
          : "";
        console.warn(
          `[qsc] Skipping chunk that exceeds token limit (length=${texts[0]?.length ?? 0})${metaInfo}. Returning zero vector.`,
        );
        return [new Array(dimensions).fill(0)];
      }

      // Split in half and retry each sub-batch recursively
      const mid = Math.ceil(texts.length / 2);
      const firstHalf = texts.slice(0, mid);
      const secondHalf = texts.slice(mid);
      const firstMeta = metaItems?.slice(0, mid);
      const secondMeta = metaItems?.slice(mid);

      console.warn(
        `[qsc] Batch of ${texts.length} texts failed with 400 error. Splitting into [${firstHalf.length}, ${secondHalf.length}] and retrying.`,
      );

      const [firstResults, secondResults] = await Promise.all([
        embedBatchWithFallback(firstHalf, firstMeta),
        embedBatchWithFallback(secondHalf, secondMeta),
      ]);

      return [...firstResults, ...secondResults];
    }
  }

  const embedder: Embedder = {
    async embed(texts: string[], meta?: EmbedTextMeta[]): Promise<number[][]> {
      if (texts.length === 0) return [];

      // Split into batches respecting both item count and token limits
      const batches = splitBatchesByTokens(texts);
      const results: number[][] = new Array(texts.length);

      for (const batch of batches) {
        const batchTexts = batch.map((item) => item.text);
        const batchMeta = meta
          ? batch.map((item) => meta[item.index])
          : undefined;
        const batchResults = await embedBatchWithFallback(batchTexts, batchMeta);

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
