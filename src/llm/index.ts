import type { LLMConfig } from "../config/index.js";

export interface GenerateOptions {
  temperature?: number;
  maxTokens?: number;
}

/**
 * LLMProvider interface: text generation and document reranking.
 */
export interface LLMProvider {
  generate(prompt: string, options?: GenerateOptions): Promise<string>;
  rerank(query: string, documents: string[]): Promise<number[]>;
}

/**
 * Factory function: creates an LLMProvider instance based on config.
 */
export async function createLLMProvider(config: LLMConfig): Promise<LLMProvider> {
  switch (config.provider) {
    case "openai": {
      const { createOpenAILLM } = await import("./openai.js");
      return createOpenAILLM(config);
    }
    case "local": {
      const { createLocalLLM } = await import("./local.js");
      return createLocalLLM(config);
    }
    default:
      throw new Error(`Unknown LLM provider: ${config.provider as string}`);
  }
}
