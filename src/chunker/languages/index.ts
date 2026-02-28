export interface LanguageConfig {
  extensions: string[];
  treeSitterLanguage: string;
  treeSitterWasmFile: string;
  chunkNodeTypes: string[];
  containerNodeTypes: string[];
  importNodeTypes: string[];
  nameFields: string[];
}

import { typescriptConfig, tsxConfig } from "./typescript.js";
import { pythonConfig } from "./python.js";
import { goConfig } from "./go.js";
import { dartConfig } from "./dart.js";
import { kotlinConfig } from "./kotlin.js";
import { swiftConfig } from "./swift.js";

const allConfigs: LanguageConfig[] = [
  tsxConfig,        // must come before typescriptConfig so .tsx/.jsx map to tsx
  typescriptConfig,
  pythonConfig,
  goConfig,
  dartConfig,
  kotlinConfig,
  swiftConfig,
];

const extensionMap = new Map<string, LanguageConfig>();

for (const config of allConfigs) {
  for (const ext of config.extensions) {
    if (!extensionMap.has(ext)) {
      extensionMap.set(ext, config);
    }
  }
}

// Override: .tsx/.jsx should use tsxConfig, .ts/.js should use typescriptConfig
extensionMap.set(".tsx", tsxConfig);
extensionMap.set(".jsx", tsxConfig);
extensionMap.set(".ts", typescriptConfig);
extensionMap.set(".js", typescriptConfig);

export function getLanguageConfig(extension: string): LanguageConfig | undefined {
  return extensionMap.get(extension);
}

export function getSupportedExtensions(): string[] {
  return [...extensionMap.keys()];
}
