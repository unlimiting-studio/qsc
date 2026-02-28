import OpenAI from "openai";
import type { LLMConfig } from "../config/index.js";
import type { LLMProvider, GenerateOptions } from "./index.js";

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

/**
 * Creates an OpenAI-backed LLMProvider.
 *
 * - generate: Uses chat completions API for text generation.
 * - rerank: Scores each document's relevance to a query using the LLM.
 */
export function createOpenAILLM(config: LLMConfig): LLMProvider {
  const apiKey = process.env[config.api_key_env];
  if (!apiKey) {
    throw new Error(
      `Missing API key: environment variable "${config.api_key_env}" is not set`,
    );
  }

  const client = new OpenAI({ apiKey });
  const model = config.model;

  async function callWithRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (error: unknown) {
        lastError = error;
        const status =
          error instanceof OpenAI.APIError ? error.status : undefined;
        if (status === 429 || (status !== undefined && status >= 500)) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        throw error;
      }
    }

    throw lastError;
  }

  const provider: LLMProvider = {
    async generate(prompt: string, options?: GenerateOptions): Promise<string> {
      const response = await callWithRetry(() =>
        client.chat.completions.create({
          model,
          messages: [{ role: "user", content: prompt }],
          temperature: options?.temperature ?? 0.0,
          max_tokens: options?.maxTokens,
        }),
      );

      return response.choices[0]?.message?.content ?? "";
    },

    async rerank(query: string, documents: string[]): Promise<number[]> {
      if (documents.length === 0) return [];

      const BATCH_SIZE = 5;
      const batches: string[][] = [];
      for (let i = 0; i < documents.length; i += BATCH_SIZE) {
        batches.push(documents.slice(i, i + BATCH_SIZE));
      }

      const batchResults = await Promise.all(
        batches.map(async (batch): Promise<number[]> => {
          try {
            const snippetParts = batch
              .map((doc, idx) => `Snippet ${idx + 1}:\n\`\`\`\n${doc}\n\`\`\``)
              .join("\n\n");

            const prompt = `You are a relevance scoring system. Given a search query and multiple code snippets, rate the relevance of each snippet to the query on a scale from 0.0 to 1.0.

Query: ${query}

${snippetParts}

Respond with ONLY the scores as comma-separated decimal numbers in order. Example: 0.8, 0.3, 0.9`;

            const response = await callWithRetry(() =>
              client.chat.completions.create({
                model,
                messages: [{ role: "user", content: prompt }],
                temperature: 0.0,
                max_tokens: 50,
              }),
            );

            const text = response.choices[0]?.message?.content?.trim() ?? "";
            const parsed = text.split(",").map((s) => {
              const score = parseFloat(s.trim());
              return Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : 0;
            });

            // Pad with 0 if fewer scores than expected
            while (parsed.length < batch.length) {
              parsed.push(0);
            }

            return parsed.slice(0, batch.length);
          } catch {
            // Batch failure: return 0 for all documents in this batch
            return batch.map(() => 0);
          }
        }),
      );

      return batchResults.flat();
    },
  };

  return provider;
}
