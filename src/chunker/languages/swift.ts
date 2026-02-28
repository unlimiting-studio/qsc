import type { LanguageConfig } from "./index.js";

export const swiftConfig: LanguageConfig = {
  extensions: [".swift"],
  treeSitterLanguage: "swift",
  treeSitterWasmFile: "tree-sitter-swift.wasm",
  chunkNodeTypes: [
    "function_declaration",
    "class_declaration",
    "struct_declaration",
    "enum_declaration",
    "protocol_declaration",
    "extension_declaration",
    "property_declaration",
    "init_declaration",
  ],
  containerNodeTypes: [
    "source_file",
    "class_body",
  ],
  importNodeTypes: [
    "import_declaration",
  ],
  nameFields: ["name"],
};
