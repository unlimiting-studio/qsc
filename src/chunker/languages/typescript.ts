import type { LanguageConfig } from "./index.js";

export const typescriptConfig: LanguageConfig = {
  extensions: [".ts", ".js"],
  treeSitterLanguage: "typescript",
  treeSitterWasmFile: "tree-sitter-typescript.wasm",
  chunkNodeTypes: [
    "function_declaration",
    "arrow_function",
    "class_declaration",
    "method_definition",
    "interface_declaration",
    "type_alias_declaration",
    "enum_declaration",
    "export_statement",
    "lexical_declaration",
    "variable_declaration",
  ],
  containerNodeTypes: [
    "program",
    "class_body",
    "module",
    "export_statement",
  ],
  importNodeTypes: [
    "import_statement",
  ],
  nameFields: ["name", "property"],
};

export const tsxConfig: LanguageConfig = {
  ...typescriptConfig,
  extensions: [".tsx", ".jsx"],
  treeSitterLanguage: "tsx",
  treeSitterWasmFile: "tree-sitter-tsx.wasm",
};
