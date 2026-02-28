import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";

// --- Zod schemas ---

const EmbedderConfigSchema = z.object({
  provider: z.enum(["openai", "local"]).default("openai"),
  model: z.string().default("text-embedding-3-small"),
  api_key_env: z.string().default("OPENAI_API_KEY"),
  dimensions: z.number().int().positive().default(1536),
});

const LLMConfigSchema = z.object({
  provider: z.enum(["openai", "local"]).default("openai"),
  model: z.string().default("gpt-4o-mini"),
  api_key_env: z.string().default("OPENAI_API_KEY"),
});

const ChunkerConfigSchema = z.object({
  max_tokens: z.number().int().positive().default(900),
  overlap: z.number().min(0).max(1).default(0.15),
});

const ScannerConfigSchema = z.object({
  exclude: z
    .array(z.string())
    .default([
      "node_modules/**",
      ".git/**",
      "dist/**",
      "*.min.js",
    ]),
  max_file_size: z.number().int().positive().default(1_048_576),
});

const QSCConfigSchema = z.object({
  embedder: EmbedderConfigSchema.optional().transform(
    (v) => EmbedderConfigSchema.parse(v ?? {}),
  ),
  llm: LLMConfigSchema.optional().transform(
    (v) => LLMConfigSchema.parse(v ?? {}),
  ),
  chunker: ChunkerConfigSchema.optional().transform(
    (v) => ChunkerConfigSchema.parse(v ?? {}),
  ),
  scanner: ScannerConfigSchema.optional().transform(
    (v) => ScannerConfigSchema.parse(v ?? {}),
  ),
});

export type QSCConfig = z.infer<typeof QSCConfigSchema>;
export type EmbedderConfig = z.infer<typeof EmbedderConfigSchema>;
export type LLMConfig = z.infer<typeof LLMConfigSchema>;
export type ChunkerConfig = z.infer<typeof ChunkerConfigSchema>;
export type ScannerConfig = z.infer<typeof ScannerConfigSchema>;

// --- Environment variable overrides ---

function applyEnvOverrides(raw: Record<string, unknown>): Record<string, unknown> {
  const result = { ...raw };

  // embedder overrides
  const embedder: Record<string, unknown> = {
    ...((result.embedder as Record<string, unknown>) ?? {}),
  };
  if (process.env.QSC_EMBEDDER_PROVIDER) embedder.provider = process.env.QSC_EMBEDDER_PROVIDER;
  if (process.env.QSC_EMBEDDER_MODEL) embedder.model = process.env.QSC_EMBEDDER_MODEL;
  if (process.env.QSC_EMBEDDER_API_KEY_ENV) embedder.api_key_env = process.env.QSC_EMBEDDER_API_KEY_ENV;
  if (process.env.QSC_EMBEDDER_DIMENSIONS) embedder.dimensions = Number(process.env.QSC_EMBEDDER_DIMENSIONS);
  result.embedder = embedder;

  // llm overrides
  const llm: Record<string, unknown> = {
    ...((result.llm as Record<string, unknown>) ?? {}),
  };
  if (process.env.QSC_LLM_PROVIDER) llm.provider = process.env.QSC_LLM_PROVIDER;
  if (process.env.QSC_LLM_MODEL) llm.model = process.env.QSC_LLM_MODEL;
  if (process.env.QSC_LLM_API_KEY_ENV) llm.api_key_env = process.env.QSC_LLM_API_KEY_ENV;
  result.llm = llm;

  // chunker overrides
  const chunker: Record<string, unknown> = {
    ...((result.chunker as Record<string, unknown>) ?? {}),
  };
  if (process.env.QSC_CHUNKER_MAX_TOKENS) chunker.max_tokens = Number(process.env.QSC_CHUNKER_MAX_TOKENS);
  if (process.env.QSC_CHUNKER_OVERLAP) chunker.overlap = Number(process.env.QSC_CHUNKER_OVERLAP);
  result.chunker = chunker;

  // scanner overrides
  const scanner: Record<string, unknown> = {
    ...((result.scanner as Record<string, unknown>) ?? {}),
  };
  if (process.env.QSC_SCANNER_MAX_FILE_SIZE) scanner.max_file_size = Number(process.env.QSC_SCANNER_MAX_FILE_SIZE);
  result.scanner = scanner;

  return result;
}

// --- Public API ---

const CONFIG_FILENAMES = ["qsc.yml", "qsc.yaml"];

/**
 * Load configuration from a qsc.yml file, apply environment variable
 * overrides, validate with zod, and return the merged config with defaults.
 */
export function loadConfig(basePath?: string): QSCConfig {
  const dir = basePath ?? process.cwd();
  let raw: Record<string, unknown> = {};

  for (const name of CONFIG_FILENAMES) {
    const filePath = resolve(dir, name);
    if (existsSync(filePath)) {
      const content = readFileSync(filePath, "utf-8");
      raw = (parseYaml(content) as Record<string, unknown>) ?? {};
      break;
    }
  }

  const withEnv = applyEnvOverrides(raw);
  return QSCConfigSchema.parse(withEnv);
}
