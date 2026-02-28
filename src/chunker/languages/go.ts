import type { LanguageConfig } from "./index.js";

export const goConfig: LanguageConfig = {
  extensions: [".go"],
  treeSitterLanguage: "go",
  treeSitterWasmFile: "tree-sitter-go.wasm",
  chunkNodeTypes: [
    "function_declaration",
    "method_declaration",
    "type_declaration",
    "const_declaration",
    "var_declaration",
  ],
  containerNodeTypes: [
    "source_file",
  ],
  importNodeTypes: [
    "import_declaration",
  ],
  nameFields: ["name"],
};
