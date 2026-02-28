import { createRequire } from "node:module";
import { join } from "node:path";
import type { LanguageConfig } from "./languages/index.js";
import type { Chunk } from "./index.js";

// web-tree-sitter 0.22.x: default export is the Parser class
const require = createRequire(import.meta.url);
const Parser: typeof import("web-tree-sitter") = require("web-tree-sitter");

// Use the types from web-tree-sitter's declarations
type SyntaxNode = InstanceType<typeof Parser>["parse"] extends (
  ...args: unknown[]
) => infer T
  ? T extends { rootNode: infer N }
    ? N
    : never
  : never;

let initPromise: Promise<void> | null = null;

async function ensureInit(): Promise<void> {
  if (!initPromise) {
    initPromise = Parser.init();
  }
  await initPromise;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function resolveWasmPath(wasmFile: string): string {
  const require2 = createRequire(import.meta.url);
  const wasmsDir = join(require2.resolve("tree-sitter-wasms/package.json"), "..", "out");
  return join(wasmsDir, wasmFile);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const languageCache = new Map<string, any>();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadLanguage(config: LanguageConfig): Promise<any> {
  const key = config.treeSitterLanguage;
  if (languageCache.has(key)) {
    return languageCache.get(key)!;
  }
  const wasmPath = resolveWasmPath(config.treeSitterWasmFile);
  const lang = await Parser.Language.load(wasmPath);
  languageCache.set(key, lang);
  return lang;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractName(node: any, nameFields: string[]): string | undefined {
  // For export_statement, look at the inner declaration
  if (node.type === "export_statement" || node.type === "export_declaration") {
    const childCount = node.childCount;
    for (let i = 0; i < childCount; i++) {
      const c = node.child(i);
      if (c && c.isNamed && c.type !== "export" && c.type !== "default") {
        const innerName = extractName(c, nameFields);
        if (innerName) return innerName;
      }
    }
  }
  // For decorated_definition (Python), look at the inner definition
  if (node.type === "decorated_definition") {
    const def = node.childForFieldName("definition");
    if (def) return extractName(def, nameFields);
  }
  for (const field of nameFields) {
    const child = node.childForFieldName(field);
    if (child) return child.text;
  }
  const childCount = node.childCount;
  for (let i = 0; i < childCount; i++) {
    const c = node.child(i);
    if (c && (c.type === "identifier" || c.type === "property_identifier" || c.type === "type_identifier")) {
      return c.text;
    }
  }
  return undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function classifyNode(node: any): string {
  const nodeType: string = node.type;
  // For export_statement, classify based on inner declaration
  if (nodeType === "export_statement" || nodeType === "export_declaration") {
    const childCount = node.childCount;
    for (let i = 0; i < childCount; i++) {
      const c = node.child(i);
      if (c && c.isNamed && c.type !== "export" && c.type !== "default") {
        return classifyNode(c);
      }
    }
    return "module";
  }
  return classifyNodeTypeStr(nodeType);
}

function classifyNodeTypeStr(nodeType: string): string {
  if (nodeType.includes("function") || nodeType.includes("method") || nodeType === "arrow_function") return "function";
  if (nodeType.includes("class")) return "class";
  if (nodeType.includes("interface")) return "interface";
  if (nodeType.includes("enum")) return "enum";
  if (nodeType.includes("type_alias") || nodeType.includes("type_declaration")) return "type";
  if (nodeType.includes("struct")) return "struct";
  if (nodeType.includes("protocol")) return "protocol";
  if (nodeType.includes("extension")) return "extension";
  if (nodeType.includes("import") || nodeType.includes("export")) return "module";
  return "block";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function collectImports(rootNode: any, importTypes: string[]): string {
  if (importTypes.length === 0) return "";
  const imports: string[] = [];
  const childCount = rootNode.childCount;
  for (let i = 0; i < childCount; i++) {
    const child = rootNode.child(i);
    if (child && importTypes.includes(child.type)) {
      imports.push(child.text);
    }
  }
  return imports.length > 0 ? imports.join("\n") + "\n\n" : "";
}

interface RawChunk {
  content: string;
  startLine: number;
  endLine: number;
  type: string;
  name?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function collectChunkNodes(
  node: any,
  config: LanguageConfig,
  sourceLines: string[],
  maxTokens: number,
): RawChunk[] {
  const chunks: RawChunk[] = [];
  const chunkSet = new Set(config.chunkNodeTypes);
  const containerSet = new Set(config.containerNodeTypes);
  const importSet = new Set(config.importNodeTypes);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function visit(n: any): void {
    if (importSet.has(n.type)) return;

    if (chunkSet.has(n.type)) {
      const text: string = n.text;
      const tokens = estimateTokens(text);
      const startLine: number = n.startPosition.row + 1;
      const endLine: number = n.endPosition.row + 1;
      const name = extractName(n, config.nameFields);
      const chunkType = classifyNode(n);

      if (tokens <= maxTokens) {
        chunks.push({ content: text, startLine, endLine, type: chunkType, name });
      } else {
        const subChunks = splitLargeNode(n, config, sourceLines, maxTokens);
        if (subChunks.length > 0) {
          chunks.push(...subChunks);
        } else {
          chunks.push({ content: text, startLine, endLine, type: chunkType, name });
        }
      }
      return;
    }

    if (containerSet.has(n.type) || n.type === "program" || n.type === "source_file" || n.type === "module") {
      const childCount: number = n.childCount;
      for (let i = 0; i < childCount; i++) {
        const child = n.child(i);
        if (child) visit(child);
      }
      return;
    }

    // Top-level non-chunk, non-container nodes
    if (n.parent && (containerSet.has(n.parent.type) || n.parent.type === "program" || n.parent.type === "source_file" || n.parent.type === "module")) {
      if (!importSet.has(n.type) && n.text.trim().length > 0) {
        chunks.push({
          content: n.text,
          startLine: n.startPosition.row + 1,
          endLine: n.endPosition.row + 1,
          type: "block",
          name: undefined,
        });
      }
    }
  }

  visit(node);
  return chunks;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function splitLargeNode(
  node: any,
  config: LanguageConfig,
  sourceLines: string[],
  maxTokens: number,
): RawChunk[] {
  const chunkSet = new Set(config.chunkNodeTypes);
  const subChunks: RawChunk[] = [];
  const childCount: number = node.childCount;

  let hasChunkableChildren = false;
  for (let i = 0; i < childCount; i++) {
    const child = node.child(i);
    if (child && child.isNamed && chunkSet.has(child.type)) {
      hasChunkableChildren = true;
      break;
    }
  }

  if (hasChunkableChildren) {
    for (let i = 0; i < childCount; i++) {
      const child = node.child(i);
      if (!child || !child.isNamed) continue;
      const childChunks = collectChunkNodes(child, config, sourceLines, maxTokens);
      subChunks.push(...childChunks);
    }
    return subChunks;
  }

  // Split by line groups
  const nodeStartLine: number = node.startPosition.row;
  const nodeEndLine: number = node.endPosition.row;
  const nodeLines = sourceLines.slice(nodeStartLine, nodeEndLine + 1);

  let currentLines: string[] = [];
  let currentStartLine = nodeStartLine;
  let currentTokens = 0;

  for (let i = 0; i < nodeLines.length; i++) {
    const lineTokens = estimateTokens(nodeLines[i] + "\n");
    if (currentTokens + lineTokens > maxTokens && currentLines.length > 0) {
      subChunks.push({
        content: currentLines.join("\n"),
        startLine: currentStartLine + 1,
        endLine: currentStartLine + currentLines.length,
        type: classifyNode(node),
        name: extractName(node, config.nameFields),
      });
      currentLines = [];
      currentStartLine = nodeStartLine + i;
      currentTokens = 0;
    }
    currentLines.push(nodeLines[i]);
    currentTokens += lineTokens;
  }

  if (currentLines.length > 0) {
    subChunks.push({
      content: currentLines.join("\n"),
      startLine: currentStartLine + 1,
      endLine: currentStartLine + currentLines.length,
      type: classifyNode(node),
      name: extractName(node, config.nameFields),
    });
  }

  return subChunks;
}

function mergeSmallChunks(chunks: RawChunk[], maxTokens: number): RawChunk[] {
  if (chunks.length <= 1) return chunks;

  const merged: RawChunk[] = [];
  let current = chunks[0];

  for (let i = 1; i < chunks.length; i++) {
    const next = chunks[i];
    const combinedTokens = estimateTokens(current.content) + estimateTokens(next.content);

    if (
      combinedTokens <= maxTokens &&
      current.type === "block" &&
      next.type === "block" &&
      next.startLine <= current.endLine + 2
    ) {
      current = {
        content: current.content + "\n" + next.content,
        startLine: current.startLine,
        endLine: next.endLine,
        type: "block",
        name: current.name || next.name,
      };
    } else {
      merged.push(current);
      current = next;
    }
  }
  merged.push(current);

  return merged;
}

export interface AstChunker {
  chunk(content: string, filePath: string): Chunk[];
}

export async function createAstChunker(
  langConfig: LanguageConfig,
  maxTokens: number,
): Promise<AstChunker> {
  await ensureInit();
  const language = await loadLanguage(langConfig);
  const parser = new Parser();
  parser.setLanguage(language);

  return {
    chunk(content: string, filePath: string): Chunk[] {
      const tree = parser.parse(content);
      if (!tree) return [];

      const rootNode = tree.rootNode;
      const sourceLines = content.split("\n");
      const importPrefix = collectImports(rootNode, langConfig.importNodeTypes);

      let rawChunks = collectChunkNodes(rootNode, langConfig, sourceLines, maxTokens);
      rawChunks = mergeSmallChunks(rawChunks, maxTokens);

      // Maximum characters per chunk (~4 chars per token)
      const maxChars = maxTokens * 4;

      const result: Chunk[] = [];
      for (const raw of rawChunks) {
        const needsPrefix = importPrefix.length > 0 && !raw.content.trimStart().startsWith("import");
        const finalContent = needsPrefix ? importPrefix + raw.content : raw.content;

        // If the chunk (with import prefix) exceeds maxTokens, split it
        if (estimateTokens(finalContent) > maxTokens) {
          const chunkLines = finalContent.split("\n");
          let currentLines: string[] = [];
          let currentStartLine = raw.startLine;
          let currentTokens = 0;

          for (let li = 0; li < chunkLines.length; li++) {
            const lineTokens = estimateTokens(chunkLines[li] + "\n");

            // Handle single lines that exceed maxTokens (e.g. minified code)
            if (lineTokens > maxTokens && currentLines.length === 0) {
              let offset = 0;
              while (offset < chunkLines[li].length) {
                const slice = chunkLines[li].slice(offset, offset + maxChars);
                if (slice.trim().length > 0) {
                  result.push({
                    content: slice,
                    startLine: raw.startLine + li,
                    endLine: raw.startLine + li,
                    type: raw.type,
                    name: raw.name,
                    language: langConfig.treeSitterLanguage,
                  });
                }
                offset += maxChars;
              }
              continue;
            }

            if (currentTokens + lineTokens > maxTokens && currentLines.length > 0) {
              result.push({
                content: currentLines.join("\n"),
                startLine: currentStartLine,
                endLine: currentStartLine + currentLines.length - 1,
                type: raw.type,
                name: raw.name,
                language: langConfig.treeSitterLanguage,
              });
              currentLines = [];
              currentStartLine = raw.startLine + li;
              currentTokens = 0;
            }
            currentLines.push(chunkLines[li]);
            currentTokens += lineTokens;
          }

          if (currentLines.length > 0 && currentLines.join("\n").trim().length > 0) {
            result.push({
              content: currentLines.join("\n"),
              startLine: currentStartLine,
              endLine: currentStartLine + currentLines.length - 1,
              type: raw.type,
              name: raw.name,
              language: langConfig.treeSitterLanguage,
            });
          }
        } else {
          result.push({
            content: finalContent,
            startLine: raw.startLine,
            endLine: raw.endLine,
            type: raw.type,
            name: raw.name,
            language: langConfig.treeSitterLanguage,
          });
        }
      }

      // Fallback: if AST produced no chunks but content exists, use token-based splitting
      if (result.length === 0 && content.trim().length > 0) {
        if (estimateTokens(content) <= maxTokens) {
          result.push({
            content,
            startLine: 1,
            endLine: sourceLines.length,
            type: "module",
            language: langConfig.treeSitterLanguage,
          });
        } else {
          // Split oversized fallback content by lines respecting maxTokens
          let currentLines: string[] = [];
          let currentStartLine = 1;
          let currentTokens = 0;

          for (let li = 0; li < sourceLines.length; li++) {
            const lineTokens = estimateTokens(sourceLines[li] + "\n");

            // Handle single lines that exceed maxTokens
            if (lineTokens > maxTokens && currentLines.length === 0) {
              let offset = 0;
              while (offset < sourceLines[li].length) {
                const slice = sourceLines[li].slice(offset, offset + maxChars);
                if (slice.trim().length > 0) {
                  result.push({
                    content: slice,
                    startLine: li + 1,
                    endLine: li + 1,
                    type: "block",
                    language: langConfig.treeSitterLanguage,
                  });
                }
                offset += maxChars;
              }
              currentStartLine = li + 2;
              continue;
            }

            if (currentTokens + lineTokens > maxTokens && currentLines.length > 0) {
              result.push({
                content: currentLines.join("\n"),
                startLine: currentStartLine,
                endLine: currentStartLine + currentLines.length - 1,
                type: "block",
                language: langConfig.treeSitterLanguage,
              });
              currentLines = [];
              currentStartLine = li + 1;
              currentTokens = 0;
            }
            currentLines.push(sourceLines[li]);
            currentTokens += lineTokens;
          }

          if (currentLines.length > 0 && currentLines.join("\n").trim().length > 0) {
            result.push({
              content: currentLines.join("\n"),
              startLine: currentStartLine,
              endLine: currentStartLine + currentLines.length - 1,
              type: "block",
              language: langConfig.treeSitterLanguage,
            });
          }
        }
      }

      tree.delete();
      return result;
    },
  };
}
