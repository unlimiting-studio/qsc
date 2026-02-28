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

      const scores: number[] = [];

      for (const doc of documents) {
        const prompt = `You are a relevance scoring system. Given a search query and a code snippet, rate the relevance of the code snippet to the query on a scale from 0.0 to 1.0, where 0.0 means completely irrelevant and 1.0 means perfectly relevant.

Query: ${query}

Code snippet:
\`\`\`
${doc}
\`\`\`

Respond with ONLY a single decimal number between 0.0 and 1.0. No other text.`;

        const response = await callWithRetry(() =>
          client.chat.completions.create({
            model,
            messages: [{ role: "user", content: prompt }],
            temperature: 0.0,
            max_tokens: 10,
          }),
        );

        const text = response.choices[0]?.message?.content?.trim() ?? "0";
        const score = parseFloat(text);
        scores.push(Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : 0);
      }

      return scores;
    },
  };

  return provider;
}
