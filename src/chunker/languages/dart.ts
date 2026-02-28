import type { LanguageConfig } from "./index.js";

export const dartConfig: LanguageConfig = {
  extensions: [".dart"],
  treeSitterLanguage: "dart",
  treeSitterWasmFile: "tree-sitter-dart.wasm",
  chunkNodeTypes: [
    "function_signature",
    "method_signature",
    "class_definition",
    "enum_declaration",
    "function_body",
    "declaration",
  ],
  containerNodeTypes: [
    "program",
    "class_body",
  ],
  importNodeTypes: [
    "import_or_export",
  ],
  nameFields: ["name"],
};
