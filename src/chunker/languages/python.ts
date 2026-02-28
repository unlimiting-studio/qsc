import type { LanguageConfig } from "./index.js";

export const pythonConfig: LanguageConfig = {
  extensions: [".py"],
  treeSitterLanguage: "python",
  treeSitterWasmFile: "tree-sitter-python.wasm",
  chunkNodeTypes: [
    "function_definition",
    "class_definition",
    "decorated_definition",
  ],
  containerNodeTypes: [
    "module",
    "class_body",
    "block",
  ],
  importNodeTypes: [
    "import_statement",
    "import_from_statement",
  ],
  nameFields: ["name"],
};
