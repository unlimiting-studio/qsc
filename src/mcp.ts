#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import Database from "better-sqlite3";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createStore, type Store, type BM25Result } from "./store.js";
import { createSearchPipeline, type SearchPipeline, type SearchResult } from "./search/index.js";
import { createEmbedder, type Embedder } from "./embedder/index.js";
import { createLLMProvider, type LLMProvider } from "./llm/index.js";
import { loadConfig } from "./config/index.js";
import { resolveCollectionDb } from "./collection.js";

// --- Helpers ---

function resolveDbPathFromCollection(collectionName?: string): string {
  if (collectionName) {
    return resolveCollectionDb(collectionName);
  }

  // Fallback: environment variable QSC_COLLECTION
  const envCollection = process.env.QSC_COLLECTION;
  if (envCollection) {
    return resolveCollectionDb(envCollection);
  }

  // Legacy fallback: QSC_DB_PATH
  if (process.env.QSC_DB_PATH) {
    return resolve(process.env.QSC_DB_PATH);
  }

  throw new Error(
    "No collection specified. Set QSC_COLLECTION environment variable, use --collection flag, or set QSC_DB_PATH.",
  );
}

function resolveConfigCollectionName(collectionName?: string): string | undefined {
  return collectionName ?? process.env.QSC_COLLECTION ?? undefined;
}

function getVersion(): string {
  try {
    const pkgPath = new URL("../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return pkg.version ?? "0.1.0";
  } catch {
    return "0.1.0";
  }
}

interface ChunkDetail {
  id: number;
  file_path: string;
  repo_id: string;
  content: string;
  start_line: number | null;
  end_line: number | null;
  chunk_type: string | null;
  name: string | null;
  seq: number;
}

function formatBM25Result(r: BM25Result): string {
  const lineInfo = r.start_line != null ? `:${r.start_line}-${r.end_line ?? ""}` : "";
  const nameInfo = r.name ? ` (${r.name})` : "";
  const typeInfo = r.chunk_type ? ` [${r.chunk_type}]` : "";

  return [
    `## ${r.file_path}${lineInfo}${nameInfo}${typeInfo}`,
    `Chunk ID: ${r.chunk_id} | rank: ${r.rank}`,
    "```",
    r.content,
    "```",
  ].join("\n");
}

function formatSearchResult(r: SearchResult): string {
  const lineInfo = r.startLine != null ? `:${r.startLine}-${r.endLine ?? ""}` : "";
  const nameInfo = r.name ? ` (${r.name})` : "";
  const typeInfo = r.chunkType ? ` [${r.chunkType}]` : "";

  const scoreParts: string[] = [];
  if (r.scores.bm25 != null) scoreParts.push(`bm25=${r.scores.bm25.toFixed(4)}`);
  if (r.scores.vector != null) scoreParts.push(`vector=${r.scores.vector.toFixed(4)}`);
  if (r.scores.rrf != null) scoreParts.push(`rrf=${r.scores.rrf.toFixed(4)}`);
  if (r.scores.rerank != null) scoreParts.push(`rerank=${r.scores.rerank.toFixed(4)}`);

  const scoreDetail = scoreParts.length > 0 ? `\nScores: ${scoreParts.join(", ")}` : "";

  return [
    `## ${r.filePath}${lineInfo}${nameInfo}${typeInfo} | score: ${r.score.toFixed(4)}`,
    `Chunk ID: ${r.chunkId}${scoreDetail}`,
    "```",
    r.content,
    "```",
  ].join("\n");
}

// --- Parse --collection from process.argv ---

function parseCollectionArg(): string | undefined {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--collection" && i + 1 < args.length) {
      return args[i + 1];
    }
    if (args[i].startsWith("--collection=")) {
      return args[i].split("=")[1];
    }
  }
  return undefined;
}

// --- Main entry point ---

export async function startMcpServer(): Promise<void> {
  const collectionName = parseCollectionArg();
  const dbPath = resolveDbPathFromCollection(collectionName);

  if (!existsSync(dbPath)) {
    const name = collectionName ?? process.env.QSC_COLLECTION ?? "(unknown)";
    console.error(
      `Error: Database not found at ${dbPath}\n` +
        `Run 'qsc init ${name} <path>' first to create the collection.`,
    );
    process.exit(1);
  }

  const configCollectionName = resolveConfigCollectionName(collectionName);
  const config = loadConfig(configCollectionName);
  const version = getVersion();
  const displayName = collectionName ?? process.env.QSC_COLLECTION ?? "default";

  // Create main store (read-write, for search operations)
  const store = createStore(dbPath);
  store.initDb(config.embedder.dimensions);

  // Open a read-only connection for get_chunk queries
  const readDb = new Database(dbPath, { readonly: true });
  const getChunkStmt = readDb.prepare(`
    SELECT
      c.id, c.content, c.name, c.chunk_type,
      c.start_line, c.end_line, c.seq,
      f.path AS file_path, f.repo_id
    FROM chunks c
    JOIN files f ON c.file_id = f.id
    WHERE c.id = ?
  `);
  const findRepoStmt = readDb.prepare(`
    SELECT f.repo_id FROM files f WHERE f.path = ? AND f.active = 1 LIMIT 1
  `);

  // Create MCP server
  const server = new McpServer(
    { name: "qsc", version },
    {
      instructions:
        `QSC (Query Source Code) - Collection: ${displayName}. ` +
        "Search and explore indexed source code repositories. " +
        "Use 'search' for fast BM25 text search, 'query' for full hybrid search (BM25 + vector + LLM reranking), " +
        "'get_file' to retrieve a file's chunks, 'get_chunk' for a specific chunk, and 'status' for index statistics.",
    },
  );

  // Lazily initialized search pipeline components
  let embedder: Embedder | undefined;
  let llmProvider: LLMProvider | undefined;
  let searchPipeline: SearchPipeline | undefined;

  async function getSearchPipeline(): Promise<SearchPipeline> {
    if (searchPipeline) return searchPipeline;

    try {
      embedder = await createEmbedder(config.embedder);
    } catch {
      // Vector search unavailable
    }

    try {
      llmProvider = await createLLMProvider(config.llm);
    } catch {
      // LLM unavailable
    }

    searchPipeline = createSearchPipeline(store, embedder, llmProvider);
    return searchPipeline;
  }

  // --- Tool: search (BM25) ---
  server.registerTool(
    "search",
    {
      title: "BM25 Search",
      description:
        "Fast full-text search using BM25 ranking. Best for keyword-based queries. " +
        "Returns matching code chunks with file paths, line numbers, and relevance scores.",
      inputSchema: z.object({
        query: z.string().describe("Search query text"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Maximum number of results (default: 20)"),
      }),
    },
    async ({ query, limit }) => {
      if (!query.trim()) {
        return {
          content: [{ type: "text" as const, text: "Error: query must not be empty" }],
          isError: true,
        };
      }

      const results = store.searchBM25(query, limit ?? 20);

      if (results.length === 0) {
        return { content: [{ type: "text" as const, text: "No results found." }] };
      }

      const formatted = results.map(formatBM25Result).join("\n\n---\n\n");
      return {
        content: [
          { type: "text" as const, text: `Found ${results.length} result(s):\n\n${formatted}` },
        ],
      };
    },
  );

  // --- Tool: query (hybrid search) ---
  server.registerTool(
    "query",
    {
      title: "Hybrid Search",
      description:
        "Full hybrid search combining BM25, vector similarity, and optional LLM reranking. " +
        "Best for semantic and complex queries. May be slower than 'search' but provides better results.",
      inputSchema: z.object({
        query: z.string().describe("Search query text"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Maximum number of results (default: 20)"),
        expand: z
          .boolean()
          .optional()
          .describe("Enable LLM query expansion (default: true if LLM available)"),
        rerank: z
          .boolean()
          .optional()
          .describe("Enable LLM reranking (default: true if LLM available)"),
      }),
    },
    async ({ query, limit, expand, rerank }) => {
      if (!query.trim()) {
        return {
          content: [{ type: "text" as const, text: "Error: query must not be empty" }],
          isError: true,
        };
      }

      const sp = await getSearchPipeline();
      const mode = embedder ? "hybrid" : "bm25";
      const shouldExpand = expand ?? !!llmProvider;
      const shouldRerank = rerank ?? !!llmProvider;

      const response = await sp.search(query, {
        mode,
        limit: limit ?? 20,
        expand: shouldExpand,
        rerank: shouldRerank,
      });

      if (response.results.length === 0) {
        return { content: [{ type: "text" as const, text: "No results found." }] };
      }

      const formatted = response.results.map(formatSearchResult).join("\n\n---\n\n");
      const modeLabel =
        mode === "hybrid"
          ? `hybrid (expand=${shouldExpand}, rerank=${shouldRerank})`
          : "bm25";

      return {
        content: [
          { type: "text" as const, text: `Found ${response.results.length} result(s) [${modeLabel}]:\n\n${formatted}` },
        ],
      };
    },
  );

  // --- Tool: get_file ---
  server.registerTool(
    "get_file",
    {
      title: "Get File",
      description:
        "Retrieve a file's metadata and all its indexed chunks by file path. " +
        "Returns file info (hash, language, active status) and chunk contents.",
      inputSchema: z.object({
        path: z.string().describe("Relative file path within the repository"),
        repo_id: z
          .string()
          .optional()
          .describe("Repository ID. If omitted, searches across all repositories."),
      }),
    },
    async ({ path, repo_id }) => {
      if (!path.trim()) {
        return {
          content: [{ type: "text" as const, text: "Error: path must not be empty" }],
          isError: true,
        };
      }

      let repoId = repo_id;
      if (!repoId) {
        const row = findRepoStmt.get(path) as { repo_id: string } | undefined;
        repoId = row?.repo_id;
      }
      if (!repoId) {
        return {
          content: [
            { type: "text" as const, text: `Error: File not found in index: ${path}. Specify repo_id if needed.` },
          ],
          isError: true,
        };
      }

      const file = store.getFileByPath(repoId, path);
      if (!file) {
        return {
          content: [
            { type: "text" as const, text: `Error: File not found in index: ${path} (repo: ${repoId})` },
          ],
          isError: true,
        };
      }

      const chunks = store.getChunksByFileId(file.id);

      const fileMeta = [
        `# ${file.path}`,
        `- **ID**: ${file.id}`,
        `- **Repository**: ${file.repo_id}`,
        `- **Hash**: ${file.hash}`,
        `- **Language**: ${file.language ?? "unknown"}`,
        `- **Active**: ${file.active ? "yes" : "no"}`,
        `- **Indexed at**: ${file.indexed_at ?? "unknown"}`,
        `- **Chunks**: ${chunks.length}`,
      ].join("\n");

      const chunkTexts = chunks.map((c) => {
        const lineInfo = c.start_line != null ? `L${c.start_line}-${c.end_line}` : "";
        const nameInfo = c.name ? ` ${c.name}` : "";
        const typeInfo = c.chunk_type ? ` [${c.chunk_type}]` : "";
        return `### Chunk #${c.seq} (ID: ${c.id}) ${lineInfo}${nameInfo}${typeInfo}\n\`\`\`\n${c.content}\n\`\`\``;
      });

      return {
        content: [
          { type: "text" as const, text: `${fileMeta}\n\n${chunkTexts.join("\n\n")}` },
        ],
      };
    },
  );

  // --- Tool: get_chunk ---
  server.registerTool(
    "get_chunk",
    {
      title: "Get Chunk",
      description:
        "Retrieve a specific code chunk by its ID. Returns the chunk content, metadata, and location.",
      inputSchema: z.object({
        chunk_id: z.number().int().describe("Chunk ID to retrieve"),
      }),
    },
    async ({ chunk_id }) => {
      const row = getChunkStmt.get(chunk_id) as ChunkDetail | undefined;

      if (!row) {
        return {
          content: [{ type: "text" as const, text: `Error: Chunk not found: ${chunk_id}` }],
          isError: true,
        };
      }

      const lineInfo = row.start_line != null ? `L${row.start_line}-${row.end_line}` : "";
      const nameInfo = row.name ? ` (${row.name})` : "";
      const typeInfo = row.chunk_type ? ` [${row.chunk_type}]` : "";

      const text = [
        `# Chunk ${row.id}${nameInfo}${typeInfo}`,
        `- **File**: ${row.file_path} ${lineInfo}`,
        `- **Repository**: ${row.repo_id}`,
        `- **Sequence**: ${row.seq}`,
        `- **Type**: ${row.chunk_type ?? "unknown"}`,
        "",
        "```",
        row.content,
        "```",
      ].join("\n");

      return { content: [{ type: "text" as const, text }] };
    },
  );

  // --- Tool: status ---
  server.registerTool(
    "status",
    {
      title: "Index Status",
      description:
        "Get statistics about the QSC index: repository count, file count, chunk count, and embedding status.",
      inputSchema: z.object({}),
    },
    async () => {
      const stats = store.getStats();

      const text = [
        "# QSC Index Status",
        `**Collection**: ${displayName}`,
        "",
        `| Metric | Value |`,
        `|--------|-------|`,
        `| Repositories | ${stats.repositories} |`,
        `| Files (total) | ${stats.files} |`,
        `| Files (active) | ${stats.active_files} |`,
        `| Chunks | ${stats.chunks} |`,
        `| Embedded chunks | ${stats.embedded_chunks} |`,
        `| Pending embed | ${stats.pending_chunks} |`,
      ].join("\n");

      return { content: [{ type: "text" as const, text }] };
    },
  );

  // --- Connect transport and start ---
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Clean up on exit
  const cleanup = () => {
    try { readDb.close(); } catch { /* ignore */ }
    try { store.close(); } catch { /* ignore */ }
  };
  process.on("SIGINT", () => { cleanup(); process.exit(0); });
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });

  console.error(`QSC MCP server v${version} running on stdio`);
  console.error(`Collection: ${displayName}`);
  console.error(`Database: ${dbPath}`);
}

// Direct execution: only run when this file is the entry point
const isDirectRun =
  process.argv[1] &&
  (import.meta.url.endsWith(process.argv[1]) ||
   import.meta.url === `file://${process.argv[1]}` ||
   import.meta.url === `file://${resolve(process.argv[1])}`);

if (isDirectRun) {
  startMcpServer().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
