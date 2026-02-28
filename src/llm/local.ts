import type { LLMConfig } from "../config/index.js";
import type { LLMProvider, GenerateOptions } from "./index.js";

/**
 * Creates a local LLM provider using node-llama-cpp.
 *
 * NOTE: This is a stub implementation. Full functionality requires
 * node-llama-cpp to be installed and a GGUF model file available.
 */
export function createLocalLLM(config: LLMConfig): LLMProvider {
  const modelPath = config.model;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let llamaModule: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let cachedModel: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let cachedContext: any = null;

  async function loadLlama(): Promise<any> {
    if (llamaModule) return llamaModule;
    try {
      // Dynamic import — node-llama-cpp is an optional dependency
      // @ts-expect-error node-llama-cpp is optional and may not be installed
      llamaModule = await import("node-llama-cpp");
      return llamaModule;
    } catch {
      throw new Error(
        "node-llama-cpp is not installed. Install it with: npm install node-llama-cpp",
      );
    }
  }

  async function getContext(): Promise<{ context: any; llama: any }> {
    if (cachedContext) return { context: cachedContext, llama: llamaModule };

    const llama = await loadLlama();
    const llamaInstance = await llama.getLlama();
    cachedModel = await llamaInstance.loadModel({ modelPath });
    cachedContext = await cachedModel.createContext();
    return { context: cachedContext, llama };
  }

  const provider: LLMProvider = {
    async generate(prompt: string, options?: GenerateOptions): Promise<string> {
      const { context, llama } = await getContext();
      const session = new llama.LlamaChatSession({
        contextSequence: context.getSequence(),
      });

      const response = await session.prompt(prompt, {
        temperature: options?.temperature ?? 0.0,
        maxTokens: options?.maxTokens,
      });

      return response;
    },

    async rerank(query: string, documents: string[]): Promise<number[]> {
      if (documents.length === 0) return [];

      const scores: number[] = [];

      for (const doc of documents) {
        const prompt = `You are a relevance scoring system. Given a search query and a code snippet, rate the relevance on a scale from 0.0 to 1.0.

Query: ${query}

Code snippet:
\`\`\`
${doc}
\`\`\`

Respond with ONLY a single decimal number between 0.0 and 1.0.`;

        const result = await provider.generate(prompt, {
          temperature: 0.0,
          maxTokens: 10,
        });

        const score = parseFloat(result.trim());
        scores.push(Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : 0);
      }

      return scores;
    },
  };

  return provider;
}
