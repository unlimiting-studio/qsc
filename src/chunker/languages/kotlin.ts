import type { LanguageConfig } from "./index.js";

export const kotlinConfig: LanguageConfig = {
  extensions: [".kt", ".kts"],
  treeSitterLanguage: "kotlin",
  treeSitterWasmFile: "tree-sitter-kotlin.wasm",
  chunkNodeTypes: [
    "function_declaration",
    "class_declaration",
    "object_declaration",
    "property_declaration",
    "companion_object",
    "interface_declaration",
  ],
  containerNodeTypes: [
    "source_file",
    "class_body",
  ],
  importNodeTypes: [
    "import_list",
    "import_header",
  ],
  nameFields: ["name"],
};
