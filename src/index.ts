#!/usr/bin/env node

import { resolve, basename } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { createStore, type Store } from "./store.js";
import { createChunker } from "./chunker/index.js";
import { createEmbedder, type Embedder } from "./embedder/index.js";
import { createLLMProvider } from "./llm/index.js";
import { scanRepository, detectLanguage } from "./scanner/index.js";
import { detectChanges, getCurrentCommit, isGitRepository } from "./scanner/git.js";
import { createSearchPipeline, type SearchResult, type SearchResponse, type SearchTiming } from "./search/index.js";
import { loadConfig, type QSCConfig } from "./config/index.js";
import { createHash } from "node:crypto";
import {
  registerCollection,
  resolveCollectionDb,
  resolveCollectionSourcePath,
  getCollection,
  listCollections,
  ensureQscHome,
  getCollectionDbPath,
  copyCollection,
  importCollection,
  exportCollection,
} from "./collection.js";

// --- Argument Parsing ---

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);

  if (args.length === 0 || (args.length === 1 && args[0] === "--help")) {
    return { command: "help", positional: [], flags: {} };
  }

  const command = args[0]!.startsWith("--") ? "help" : args[0]!;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const startIdx = args[0]!.startsWith("--") ? 0 : 1;

  for (let i = startIdx; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const eqIdx = key.indexOf("=");
      if (eqIdx !== -1) {
        flags[key.slice(0, eqIdx)] = key.slice(eqIdx + 1);
      } else if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
        if (key.startsWith("no-")) {
          flags[key] = true;
        } else {
          flags[key] = args[++i];
        }
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }

  return { command, positional, flags };
}

function getFlag(flags: Record<string, string | boolean>, key: string, defaultVal: string): string {
  const v = flags[key];
  if (v === undefined || v === true) return defaultVal;
  return String(v);
}

function hasFlag(flags: Record<string, string | boolean>, key: string): boolean {
  return flags[key] !== undefined;
}

// --- Helpers ---

function openStore(dbPath: string, config: QSCConfig): Store {
  if (!existsSync(dbPath)) {
    throw new Error(`Database not found: ${dbPath}\nRun 'qsc init <name> <path>' first.`);
  }
  const store = createStore(dbPath);
  store.initDb(config.embedder.dimensions);
  return store;
}

function getRepoId(repoPath: string): string {
  return basename(resolve(repoPath));
}

function formatScore(score: number): string {
  return score.toFixed(4);
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 3) + "...";
}

function printResults(results: SearchResult[], mode: string): void {
  if (results.length === 0) {
    console.log("No results found.");
    return;
  }

  console.log(`\n${results.length} result(s) [${mode}]:\n`);

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const lineInfo = r.startLine != null ? `:${r.startLine}` : "";
    const nameInfo = r.name ? ` (${r.name})` : "";
    const typeInfo = r.chunkType ? ` [${r.chunkType}]` : "";

    console.log(`--- #${i + 1} | ${r.filePath}${lineInfo}${nameInfo}${typeInfo} | score: ${formatScore(r.score)} ---`);

    const parts: string[] = [];
    if (r.scores.bm25 != null) parts.push(`bm25=${formatScore(r.scores.bm25)}`);
    if (r.scores.vector != null) parts.push(`vector=${formatScore(r.scores.vector)}`);
    if (r.scores.rrf != null) parts.push(`rrf=${formatScore(r.scores.rrf)}`);
    if (r.scores.rerank != null) parts.push(`rerank=${formatScore(r.scores.rerank)}`);
    if (parts.length > 0) console.log(`    scores: ${parts.join(", ")}`);

    const lines = r.content.split("\n");
    const preview = lines.slice(0, 8).join("\n");
    console.log(preview);
    if (lines.length > 8) console.log(`    ... (${lines.length - 8} more lines)`);
    console.log();
  }
}

function printBenchmark(response: SearchResponse): void {
  if (!response.timing) return;

  const t = response.timing;
  console.log("--- Benchmark ---");

  if (t.expand != null) {
    console.log(`Query Expansion: ${Math.round(t.expand)}ms`);
  }
  if (t.bm25 != null) {
    const countInfo = response.counts?.bm25 != null ? ` (${response.counts.bm25} results)` : "";
    console.log(`BM25: ${Math.round(t.bm25)}ms${countInfo}`);
  }
  if (t.vector != null) {
    const countInfo = response.counts?.vector != null ? ` (${response.counts.vector} results)` : "";
    console.log(`Vector: ${Math.round(t.vector)}ms${countInfo}`);
  }
  if (t.fusion != null) {
    console.log(`RRF Fusion: ${Math.round(t.fusion)}ms`);
  }
  if (t.rerank != null) {
    console.log(`LLM Reranking: ${Math.round(t.rerank)}ms`);
  }
  console.log(`Total: ${Math.round(t.total)}ms`);
}

// --- Commands ---

async function cmdInit(positional: string[], _flags: Record<string, string | boolean>): Promise<void> {
  const name = positional[0];
  const sourcePath = positional[1];

  if (!name || !sourcePath) {
    console.error("Usage: qsc init <name> <path>");
    process.exit(1);
  }

  const absSourcePath = resolve(sourcePath);
  if (!existsSync(absSourcePath)) {
    console.error(`Source path does not exist: ${absSourcePath}`);
    process.exit(1);
  }

  ensureQscHome();

  const dbPath = getCollectionDbPath(name);
  const config = loadConfig(absSourcePath);

  // Create DB and initialize schema
  const store = createStore(dbPath);
  store.initDb(config.embedder.dimensions);

  // Register repository in DB
  const repoId = getRepoId(absSourcePath);
  store.upsertRepository({
    id: repoId,
    path: absSourcePath,
  });

  store.close();

  // Register collection
  registerCollection(name, absSourcePath, dbPath);

  console.log(`Collection '${name}' initialized.`);
  console.log(`  Database: ${dbPath}`);
  console.log(`  Source:   ${absSourcePath}`);
  console.log(`  Embedding dimensions: ${config.embedder.dimensions}`);
}

async function cmdIndex(positional: string[], _flags: Record<string, string | boolean>): Promise<void> {
  const name = positional[0];
  if (!name) {
    console.error("Usage: qsc index <name>");
    process.exit(1);
  }

  const dbPath = resolveCollectionDb(name);
  const sourcePath = resolveCollectionSourcePath(name);
  const config = loadConfig(sourcePath);
  const store = openStore(dbPath, config);
  const repoId = getRepoId(sourcePath);

  try {
    console.log(`Scanning ${sourcePath}...`);
    const scanResult = await scanRepository(sourcePath, config.scanner);
    console.log(`Found ${scanResult.files.length} files (${(scanResult.totalSize / 1024).toFixed(1)} KB)`);

    const chunker = createChunker(config.chunker);
    let indexed = 0;
    let skipped = 0;

    for (let i = 0; i < scanResult.files.length; i++) {
      const file = scanResult.files[i];
      const progress = `[${i + 1}/${scanResult.files.length}]`;

      const { id: fileId, changed } = store.upsertFile({
        repo_id: repoId,
        path: file.path,
        hash: file.hash,
        language: file.language ?? null,
        active: 1,
        indexed_at: new Date().toISOString(),
      });

      if (!changed) {
        skipped++;
        continue;
      }

      const content = readFileSync(file.absolutePath, "utf-8");
      const chunks = await chunker.chunk(content, file.path);

      store.insertChunks(
        fileId,
        chunks.map((c, seq) => ({
          hash: createHash("sha256").update(c.content).digest("hex"),
          seq,
          start_line: c.startLine,
          end_line: c.endLine,
          chunk_type: c.type,
          name: c.name ?? null,
          content: c.content,
          metadata: c.metadata ? JSON.stringify(c.metadata) : null,
        })),
      );

      indexed++;
      process.stdout.write(`\r${progress} Indexed: ${indexed}, Skipped: ${skipped}`);
    }

    console.log(`\nIndexing complete. Indexed: ${indexed}, Skipped (unchanged): ${skipped}`);

    store.upsertRepository({
      id: repoId,
      path: sourcePath,
      indexed_at: new Date().toISOString(),
    });
  } finally {
    store.close();
  }
}

async function cmdEmbed(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const name = positional[0];
  if (!name) {
    console.error("Usage: qsc embed <name>");
    process.exit(1);
  }

  const dbPath = resolveCollectionDb(name);
  const sourcePath = resolveCollectionSourcePath(name);
  const config = loadConfig(sourcePath);
  const store = openStore(dbPath, config);

  try {
    const batchSize = parseInt(getFlag(flags, "batch", "100"), 10);
    const embedder = await createEmbedder(config.embedder);

    console.log(`Embedder: ${embedder.modelName} (${embedder.dimensions}d)`);

    let totalEmbedded = 0;

    while (true) {
      const chunks = store.getUnembeddedChunks(batchSize);
      if (chunks.length === 0) break;

      const texts = chunks.map((c) =>
        c.name ? `${c.name}\n${c.content}` : c.content,
      );

      const vectors = await embedder.embed(texts);

      store.insertEmbeddings(
        chunks.map((c, i) => ({
          chunk_id: c.chunk_id,
          embedding: new Float32Array(vectors[i]),
          model: embedder.modelName,
        })),
      );

      totalEmbedded += chunks.length;
      process.stdout.write(`\rEmbedded: ${totalEmbedded} chunks`);
    }

    console.log(`\nEmbedding complete. Total: ${totalEmbedded} chunks`);
  } finally {
    store.close();
  }
}

async function cmdUpdate(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const name = positional[0];
  if (!name) {
    console.error("Usage: qsc update <name>");
    process.exit(1);
  }

  const dbPath = resolveCollectionDb(name);
  const sourcePath = resolveCollectionSourcePath(name);
  const config = loadConfig(sourcePath);
  const store = openStore(dbPath, config);
  const repoId = getRepoId(sourcePath);

  try {
    const isGit = isGitRepository(sourcePath);

    // Try git-optimized path first
    if (isGit) {
      const repo = store.getRepository(repoId);
      const lastCommit = repo?.last_commit ?? undefined;

      if (lastCommit) {
        const gitInfo = detectChanges(sourcePath, lastCommit);

        if (!gitInfo.isFullScan) {
          console.log(`Git incremental update (${lastCommit.slice(0, 8)} -> ${gitInfo.currentCommit.slice(0, 8)})`);

          const added = gitInfo.changes.filter((c) => c.status === "added" || c.status === "renamed");
          const modified = gitInfo.changes.filter((c) => c.status === "modified");
          const deleted = gitInfo.changes.filter((c) => c.status === "deleted");

          console.log(`  Added: ${added.length}, Modified: ${modified.length}, Deleted: ${deleted.length}`);

          if (deleted.length > 0) {
            store.deactivateFiles(repoId, deleted.map((c) => c.path));
            console.log(`Deactivated ${deleted.length} deleted files`);
          }

          const changedPaths = [...added, ...modified].map((c) => c.path);
          if (changedPaths.length > 0) {
            const chunker = createChunker(config.chunker);
            let indexed = 0;

            for (const relPath of changedPaths) {
              const absPath = resolve(sourcePath, relPath);
              if (!existsSync(absPath)) continue;

              const content = readFileSync(absPath, "utf-8");
              const hash = createHash("sha256").update(content).digest("hex");
              const language = detectLanguage(relPath);

              const { id: fileId, changed } = store.upsertFile({
                repo_id: repoId,
                path: relPath,
                hash,
                language: language ?? null,
                active: 1,
                indexed_at: new Date().toISOString(),
              });

              if (!changed) continue;

              const chunks = await chunker.chunk(content, relPath);
              store.insertChunks(
                fileId,
                chunks.map((c, seq) => ({
                  hash: createHash("sha256").update(c.content).digest("hex"),
                  seq,
                  start_line: c.startLine,
                  end_line: c.endLine,
                  chunk_type: c.type,
                  name: c.name ?? null,
                  content: c.content,
                  metadata: c.metadata ? JSON.stringify(c.metadata) : null,
                })),
              );
              indexed++;
            }
            console.log(`Re-indexed ${indexed} files`);
          }

          // Cleanup and update commit
          const cleaned = store.cleanup();
          if (cleaned.deletedChunks > 0) {
            console.log(`Cleaned up ${cleaned.deletedChunks} orphan chunks, ${cleaned.deletedVectors} vectors`);
          }

          store.upsertRepository({
            id: repoId,
            path: sourcePath,
            last_commit: gitInfo.currentCommit,
            indexed_at: new Date().toISOString(),
          });

          console.log("Git incremental update complete.");

          // Auto-embed
          const unembedded = store.getUnembeddedChunks(1);
          store.close();
          if (unembedded.length > 0) {
            console.log("Embedding new chunks...");
            await cmdEmbed([name], flags);
          }
          return;
        }
      }
    }

    // Fallback: hash-based full scan (works for both git and non-git)
    console.log(isGit ? "Full hash-based scan (no previous commit)..." : "Hash-based scan (non-git directory)...");

    const scanResult = await scanRepository(sourcePath, config.scanner);
    console.log(`Found ${scanResult.files.length} files (${(scanResult.totalSize / 1024).toFixed(1)} KB)`);

    const chunker = createChunker(config.chunker);
    let indexed = 0;
    let skipped = 0;

    // Track scanned paths to detect deleted files
    const scannedPaths = new Set<string>();

    for (let i = 0; i < scanResult.files.length; i++) {
      const file = scanResult.files[i];
      scannedPaths.add(file.path);
      const progress = `[${i + 1}/${scanResult.files.length}]`;

      const { id: fileId, changed } = store.upsertFile({
        repo_id: repoId,
        path: file.path,
        hash: file.hash,
        language: file.language ?? null,
        active: 1,
        indexed_at: new Date().toISOString(),
      });

      if (!changed) {
        skipped++;
        continue;
      }

      const content = readFileSync(file.absolutePath, "utf-8");
      const chunks = await chunker.chunk(content, file.path);

      store.insertChunks(
        fileId,
        chunks.map((c, seq) => ({
          hash: createHash("sha256").update(c.content).digest("hex"),
          seq,
          start_line: c.startLine,
          end_line: c.endLine,
          chunk_type: c.type,
          name: c.name ?? null,
          content: c.content,
          metadata: c.metadata ? JSON.stringify(c.metadata) : null,
        })),
      );

      indexed++;
      process.stdout.write(`\r${progress} Indexed: ${indexed}, Skipped: ${skipped}`);
    }

    console.log(`\nIndexed: ${indexed}, Skipped (unchanged): ${skipped}`);

    // Deactivate files that are no longer present on disk
    const activeFiles = store.getActiveFiles(repoId);
    const deletedPaths = activeFiles
      .filter((f) => !scannedPaths.has(f.path))
      .map((f) => f.path);

    if (deletedPaths.length > 0) {
      store.deactivateFiles(repoId, deletedPaths);
      console.log(`Deactivated ${deletedPaths.length} deleted files`);
    }

    // Cleanup orphaned data
    const cleaned = store.cleanup();
    if (cleaned.deletedChunks > 0) {
      console.log(`Cleaned up ${cleaned.deletedChunks} orphan chunks, ${cleaned.deletedVectors} vectors`);
    }

    // Update repository metadata
    const updateData: { id: string; path: string; indexed_at: string; last_commit?: string } = {
      id: repoId,
      path: sourcePath,
      indexed_at: new Date().toISOString(),
    };

    if (isGit) {
      try {
        updateData.last_commit = getCurrentCommit(sourcePath);
      } catch {
        // ignore git errors
      }
    }

    store.upsertRepository(updateData);
    console.log("Update complete.");

    // Auto-embed
    const unembedded = store.getUnembeddedChunks(1);
    store.close();
    if (unembedded.length > 0) {
      console.log("Embedding new chunks...");
      await cmdEmbed([name], flags);
    }
  } catch (err) {
    store.close();
    throw err;
  }
}

async function cmdSearch(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const name = positional[0];
  const query = positional.slice(1).join(" ");
  if (!name || !query) {
    console.error("Usage: qsc search <name> <query>");
    process.exit(1);
  }

  const dbPath = resolveCollectionDb(name);
  const sourcePath = resolveCollectionSourcePath(name);
  const config = loadConfig(sourcePath);
  const store = openStore(dbPath, config);

  try {
    const limit = parseInt(getFlag(flags, "limit", "10"), 10);
    const benchmark = hasFlag(flags, "benchmark");
    const pipeline = createSearchPipeline(store);

    const response = await pipeline.search(query, {
      mode: "bm25",
      limit,
      benchmark,
    });

    printResults(response.results, "BM25");
    if (benchmark) printBenchmark(response);
  } finally {
    store.close();
  }
}

async function cmdQuery(positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const name = positional[0];
  const query = positional.slice(1).join(" ");
  if (!name || !query) {
    console.error("Usage: qsc query <name> <query>");
    process.exit(1);
  }

  const dbPath = resolveCollectionDb(name);
  const sourcePath = resolveCollectionSourcePath(name);
  const config = loadConfig(sourcePath);
  const store = openStore(dbPath, config);

  try {
    const limit = parseInt(getFlag(flags, "limit", "10"), 10);
    const noExpand = hasFlag(flags, "no-expand");
    const noRerank = hasFlag(flags, "no-rerank");
    const benchmark = hasFlag(flags, "benchmark");

    let embedder: Embedder | undefined;
    let llm;

    try {
      embedder = await createEmbedder(config.embedder);
    } catch (err) {
      console.error(`Warning: Could not create embedder (${(err as Error).message}). Vector search disabled.`);
    }

    try {
      llm = await createLLMProvider(config.llm);
    } catch (err) {
      console.error(`Warning: Could not create LLM provider (${(err as Error).message}). Expansion/reranking disabled.`);
    }

    const pipeline = createSearchPipeline(store, embedder, llm);

    const mode = embedder ? "hybrid" : "bm25";
    const response = await pipeline.search(query, {
      mode,
      limit,
      expand: !noExpand && !!llm,
      rerank: !noRerank && !!llm,
      benchmark,
    });

    printResults(response.results, mode);
    if (benchmark) printBenchmark(response);
  } finally {
    store.close();
  }
}

async function cmdGet(positional: string[], _flags: Record<string, string | boolean>): Promise<void> {
  const name = positional[0];
  const filePath = positional[1];
  if (!name || !filePath) {
    console.error("Usage: qsc get <name> <file-path>");
    process.exit(1);
  }

  const dbPath = resolveCollectionDb(name);
  const sourcePath = resolveCollectionSourcePath(name);
  const config = loadConfig(sourcePath);
  const store = openStore(dbPath, config);
  const repoId = getRepoId(sourcePath);

  try {
    const file = store.getFileByPath(repoId, filePath);
    if (!file) {
      console.error(`File not found in index: ${filePath}`);
      process.exit(1);
    }

    console.log(`File: ${file.path}`);
    console.log(`  ID: ${file.id}`);
    console.log(`  Hash: ${file.hash}`);
    console.log(`  Language: ${file.language ?? "unknown"}`);
    console.log(`  Active: ${file.active ? "yes" : "no"}`);
    console.log(`  Indexed at: ${file.indexed_at ?? "unknown"}`);

    const chunks = store.getChunksByFileId(file.id);
    console.log(`\nChunks (${chunks.length}):\n`);

    for (const chunk of chunks) {
      const lineInfo =
        chunk.start_line != null
          ? `L${chunk.start_line}-${chunk.end_line}`
          : "";
      const nameInfo = chunk.name ? ` ${chunk.name}` : "";
      const typeInfo = chunk.chunk_type ? ` [${chunk.chunk_type}]` : "";

      console.log(`  #${chunk.seq} ${lineInfo}${nameInfo}${typeInfo}`);
      console.log(`    ${truncate(chunk.content.split("\n")[0], 80)}`);
    }
  } finally {
    store.close();
  }
}

async function cmdStatus(positional: string[], _flags: Record<string, string | boolean>): Promise<void> {
  const name = positional[0];
  if (!name) {
    console.error("Usage: qsc status <name>");
    process.exit(1);
  }

  const dbPath = resolveCollectionDb(name);
  const sourcePath = resolveCollectionSourcePath(name);
  const config = loadConfig(sourcePath);
  const store = openStore(dbPath, config);

  try {
    const stats = store.getStats();

    console.log("QSC Index Status");
    console.log("================");
    console.log(`Collection:      ${name}`);
    console.log(`Database:        ${dbPath}`);
    console.log(`Source:          ${sourcePath}`);
    console.log(`Repositories:    ${stats.repositories}`);
    console.log(`Files (total):   ${stats.files}`);
    console.log(`Files (active):  ${stats.active_files}`);
    console.log(`Chunks:          ${stats.chunks}`);
    console.log(`Embedded:        ${stats.embedded_chunks}`);
    console.log(`Pending embed:   ${stats.pending_chunks}`);
  } finally {
    store.close();
  }
}

async function cmdConfig(): Promise<void> {
  const config = loadConfig();

  console.log("QSC Configuration");
  console.log("==================");
  console.log("\nEmbedder:");
  console.log(`  Provider:   ${config.embedder.provider}`);
  console.log(`  Model:      ${config.embedder.model}`);
  console.log(`  Dimensions: ${config.embedder.dimensions}`);
  console.log(`  API Key:    ${config.embedder.api_key_env} (env var)`);

  console.log("\nLLM:");
  console.log(`  Provider:   ${config.llm.provider}`);
  console.log(`  Model:      ${config.llm.model}`);
  console.log(`  API Key:    ${config.llm.api_key_env} (env var)`);

  console.log("\nChunker:");
  console.log(`  Max Tokens: ${config.chunker.max_tokens}`);
  console.log(`  Overlap:    ${config.chunker.overlap}`);

  console.log("\nScanner:");
  console.log(`  Max File Size: ${(config.scanner.max_file_size / 1024).toFixed(0)} KB`);
  console.log(`  Exclude:`);
  for (const pattern of config.scanner.exclude) {
    console.log(`    - ${pattern}`);
  }
}

async function cmdList(): Promise<void> {
  const collections = listCollections();
  const names = Object.keys(collections);

  if (names.length === 0) {
    console.log("No collections found. Run 'qsc init <name> <path>' to create one.");
    return;
  }

  console.log("Collections:");
  console.log("============");
  for (const name of names.sort()) {
    const meta = collections[name];
    console.log(`  ${name}`);
    console.log(`    Source: ${meta.sourcePath}`);
    console.log(`    DB:     ${meta.dbPath}`);
    console.log(`    Created: ${meta.createdAt}`);
  }
}

async function cmdCopy(positional: string[]): Promise<void> {
  const sourceName = positional[0];
  const destName = positional[1];
  const path = positional[2];

  if (!sourceName || !destName || !path) {
    console.error("Usage: qsc copy <source-name> <dest-name> <path>");
    process.exit(1);
  }

  const meta = copyCollection(sourceName, destName, path);
  console.log(`Collection '${destName}' created (copied from '${sourceName}').`);
  console.log(`  Database: ${meta.dbPath}`);
  console.log(`  Source:   ${meta.sourcePath}`);
}

async function cmdImport(positional: string[]): Promise<void> {
  const name = positional[0];
  const sqlitePath = positional[1];
  const sourcePath = positional[2];

  if (!name || !sqlitePath || !sourcePath) {
    console.error("Usage: qsc import <name> <sqlite-path> <source-path>");
    process.exit(1);
  }

  const meta = importCollection(name, sqlitePath, sourcePath);
  console.log(`Collection '${name}' imported.`);
  console.log(`  Database: ${meta.dbPath}`);
  console.log(`  Source:   ${meta.sourcePath}`);
}

async function cmdExport(positional: string[]): Promise<void> {
  const name = positional[0];
  const outputPath = positional[1];

  if (!name || !outputPath) {
    console.error("Usage: qsc export <name> <output-path>");
    process.exit(1);
  }

  exportCollection(name, outputPath);
  console.log(`Collection '${name}' exported to ${resolve(outputPath)}`);
}

function printHelp(): void {
  console.log(`
QSC - Query Source Code
=======================

Usage: qsc <command> [options]

Commands:
  init <name> <path>                    Create a collection for the source at <path>
  index <name>                          Index source code (scan -> chunk -> store)
  embed <name>                          Generate vector embeddings for unembedded chunks
  update <name>                         Incremental update (hash-based, git-optimized if available)
  search <name> <query>                 BM25 full-text search
  query <name> <query>                  Hybrid search (BM25 + Vector + LLM reranking)
  get <name> <file-path>                Get file info and chunks
  status <name>                         Show index statistics
  list                                  List all collections
  copy <source> <dest> <path>           Copy a collection DB to a new collection
  import <name> <sqlite-path> <path>    Import an external SQLite DB as a collection
  export <name> <output-path>           Export a collection's SQLite DB
  config                                Show current configuration
  mcp                                   Start MCP server (stdio transport)
  help                                  Show this help message

Options:
  --limit <n>         Max results for search/query (default: 10)
  --batch <n>         Batch size for embed (default: 100)
  --no-expand         Disable query expansion (query command)
  --no-rerank         Disable LLM reranking (query command)
  --benchmark         Show timing info for search/query
  --collection <name> Collection name for MCP server
  --help              Show help
`);
}

// --- Main ---

async function main(): Promise<void> {
  const { command, positional, flags } = parseArgs(process.argv);

  if (hasFlag(flags, "help")) {
    printHelp();
    return;
  }

  try {
    switch (command) {
      case "init":
        await cmdInit(positional, flags);
        break;
      case "index":
        await cmdIndex(positional, flags);
        break;
      case "embed":
        await cmdEmbed(positional, flags);
        break;
      case "update":
        await cmdUpdate(positional, flags);
        break;
      case "search":
        await cmdSearch(positional, flags);
        break;
      case "query":
        await cmdQuery(positional, flags);
        break;
      case "get":
        await cmdGet(positional, flags);
        break;
      case "status":
        await cmdStatus(positional, flags);
        break;
      case "list":
        await cmdList();
        break;
      case "copy":
        await cmdCopy(positional);
        break;
      case "import":
        await cmdImport(positional);
        break;
      case "export":
        await cmdExport(positional);
        break;
      case "config":
        await cmdConfig();
        break;
      case "mcp": {
        const { startMcpServer } = await import("./mcp.js");
        await startMcpServer();
        break;
      }
      case "help":
        printHelp();
        break;
      default:
        console.error(`Unknown command: ${command}`);
        printHelp();
        process.exit(1);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
    process.exit(1);
  }
}

main();
