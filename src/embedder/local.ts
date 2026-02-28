import type { EmbedderConfig } from "../config/index.js";
import type { Embedder, EmbedTextMeta } from "./index.js";

/**
 * Creates a local model Embedder using node-llama-cpp.
 *
 * NOTE: This is a stub implementation. Full functionality requires
 * node-llama-cpp to be installed and a GGUF model file available.
 * The interface and structure are ready for when the environment supports it.
 */
export function createLocalEmbedder(config: EmbedderConfig): Embedder {
  const model = config.model;
  const dimensions = config.dimensions;

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

  async function getContext(): Promise<any> {
    if (cachedContext) return cachedContext;

    const llama = await loadLlama();
    const llamaInstance = await llama.getLlama();
    cachedModel = await llamaInstance.loadModel({ modelPath: model });
    cachedContext = await cachedModel.createEmbeddingContext();
    return cachedContext;
  }

  const embedder: Embedder = {
    async embed(texts: string[], _meta?: EmbedTextMeta[]): Promise<number[][]> {
      if (texts.length === 0) return [];

      const context = await getContext();

      const results: number[][] = [];
      for (const text of texts) {
        const embedding = await context.getEmbeddingFor(text);
        results.push(Array.from(embedding.vector as number[]));
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
