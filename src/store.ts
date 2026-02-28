import Database from "better-sqlite3";
import type { Database as DatabaseType, Statement } from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

// --- Types ---

export interface RepositoryRow {
  id: string;
  path: string;
  last_commit?: string | null;
  indexed_at?: string | null;
  config?: string | null;
}

export interface FileRow {
  id: number;
  repo_id: string;
  path: string;
  hash: string;
  language?: string | null;
  active: number;
  indexed_at?: string | null;
}

export interface ChunkInput {
  hash: string;
  seq: number;
  start_line?: number | null;
  end_line?: number | null;
  chunk_type?: string | null;
  name?: string | null;
  content: string;
  metadata?: string | null;
}

export interface ChunkRow {
  id: number;
  file_id: number;
  hash: string;
  seq: number;
  start_line: number | null;
  end_line: number | null;
  chunk_type: string | null;
  name: string | null;
  content: string;
  metadata: string | null;
}

export interface UnembeddedChunk {
  chunk_id: number;
  content: string;
  name: string | null;
  chunk_type: string | null;
  file_path: string;
  repo_id: string;
}

export interface EmbeddingInput {
  chunk_id: number;
  embedding: Float32Array;
  model: string;
}

export interface BM25Result {
  chunk_id: number;
  file_id: number;
  content: string;
  name: string | null;
  chunk_type: string | null;
  start_line: number | null;
  end_line: number | null;
  file_path: string;
  repo_id: string;
  rank: number;
}

export interface VectorResult {
  chunk_id: number;
  file_id: number;
  content: string;
  name: string | null;
  chunk_type: string | null;
  start_line: number | null;
  end_line: number | null;
  file_path: string;
  repo_id: string;
  distance: number;
}

export interface StoreStats {
  repositories: number;
  files: number;
  active_files: number;
  chunks: number;
  embedded_chunks: number;
  pending_chunks: number;
}

export interface Store {
  initDb(dimensions: number): void;
  upsertRepository(repo: RepositoryRow): void;
  upsertFile(file: Omit<FileRow, "id">): { id: number; changed: boolean };
  insertChunks(fileId: number, chunks: ChunkInput[]): number[];
  getUnembeddedChunks(limit?: number): UnembeddedChunk[];
  insertEmbeddings(embeddings: EmbeddingInput[]): void;
  searchBM25(query: string, limit?: number): BM25Result[];
  searchVector(embedding: Float32Array, limit?: number): VectorResult[];
  deactivateFiles(repoId: string, paths: string[]): void;
  cleanup(): { deletedChunks: number; deletedVectors: number };
  getStats(): StoreStats;
  getRepository(repoId: string): RepositoryRow | undefined;
  getActiveFiles(repoId: string): FileRow[];
  getFileByPath(repoId: string, path: string): FileRow | undefined;
  getChunksByFileId(fileId: number): ChunkRow[];
  close(): void;
}

// --- Schema SQL ---

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS repositories (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  last_commit TEXT,
  indexed_at TEXT,
  config TEXT
);

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  path TEXT NOT NULL,
  hash TEXT NOT NULL,
  language TEXT,
  active INTEGER DEFAULT 1,
  indexed_at TEXT,
  UNIQUE(repo_id, path)
);

CREATE INDEX IF NOT EXISTS idx_files_repo_id ON files(repo_id);
CREATE INDEX IF NOT EXISTS idx_files_hash ON files(hash);
CREATE INDEX IF NOT EXISTS idx_files_active ON files(active);

CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES files(id),
  hash TEXT NOT NULL,
  seq INTEGER NOT NULL,
  start_line INTEGER,
  end_line INTEGER,
  chunk_type TEXT,
  name TEXT,
  content TEXT NOT NULL,
  metadata TEXT,
  UNIQUE(file_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_chunks_file_id ON chunks(file_id);
CREATE INDEX IF NOT EXISTS idx_chunks_hash ON chunks(hash);

CREATE TABLE IF NOT EXISTS chunk_vectors (
  chunk_id INTEGER PRIMARY KEY REFERENCES chunks(id),
  model TEXT NOT NULL,
  embedded_at TEXT
);
`;

const FTS_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  content,
  name,
  content=chunks,
  content_rowid=id
);
`;

const FTS_TRIGGERS_SQL = `
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, content, name) VALUES (new.id, new.content, new.name);
END;

CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, content, name) VALUES('delete', old.id, old.content, old.name);
END;

CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, content, name) VALUES('delete', old.id, old.content, old.name);
  INSERT INTO chunks_fts(rowid, content, name) VALUES (new.id, new.content, new.name);
END;
`;

function vectorTableSQL(dimensions: number): string {
  return `CREATE VIRTUAL TABLE IF NOT EXISTS vectors_vec USING vec0(
  chunk_id INTEGER PRIMARY KEY,
  embedding float[${dimensions}] distance_metric=cosine
);`;
}

// --- Prepared statement cache ---

interface Statements {
  upsertRepo: Statement;
  upsertFile: Statement;
  getFileByRepoAndPath: Statement;
  insertChunk: Statement;
  deleteChunksByFileId: Statement;
  getChunkHashesByFileId: Statement;
  deleteChunkById: Statement;
  deleteVectorByChunkId: Statement;
  deleteChunkVectorByChunkId: Statement;
  updateChunkSeq: Statement;
  getUnembeddedChunks: Statement;
  insertVector: Statement;
  insertChunkVector: Statement;
  searchBM25: Statement;
  searchVector: Statement;
  deactivateFile: Statement;
  deleteOrphanChunks: Statement;
  deleteOrphanVectors: Statement;
  deleteOrphanChunkVectors: Statement;
  countRepos: Statement;
  countFiles: Statement;
  countActiveFiles: Statement;
  countChunks: Statement;
  countEmbeddedChunks: Statement;
  getRepository: Statement;
  getActiveFiles: Statement;
  getFileByPath: Statement;
  getChunksByFileId: Statement;
}

function prepareStatements(db: DatabaseType): Statements {
  return {
    upsertRepo: db.prepare(`
      INSERT INTO repositories (id, path, last_commit, indexed_at, config)
      VALUES (@id, @path, @last_commit, @indexed_at, @config)
      ON CONFLICT(id) DO UPDATE SET
        path = excluded.path,
        last_commit = excluded.last_commit,
        indexed_at = excluded.indexed_at,
        config = excluded.config
    `),

    upsertFile: db.prepare(`
      INSERT INTO files (repo_id, path, hash, language, active, indexed_at)
      VALUES (@repo_id, @path, @hash, @language, @active, @indexed_at)
      ON CONFLICT(repo_id, path) DO UPDATE SET
        hash = excluded.hash,
        language = excluded.language,
        active = excluded.active,
        indexed_at = excluded.indexed_at
    `),

    getFileByRepoAndPath: db.prepare(`
      SELECT * FROM files WHERE repo_id = ? AND path = ?
    `),

    insertChunk: db.prepare(`
      INSERT INTO chunks (file_id, hash, seq, start_line, end_line, chunk_type, name, content, metadata)
      VALUES (@file_id, @hash, @seq, @start_line, @end_line, @chunk_type, @name, @content, @metadata)
    `),

    deleteChunksByFileId: db.prepare(`
      DELETE FROM chunks WHERE file_id = ?
    `),

    getChunkHashesByFileId: db.prepare(`
      SELECT id, hash, seq FROM chunks WHERE file_id = ? ORDER BY seq ASC
    `),

    deleteChunkById: db.prepare(`
      DELETE FROM chunks WHERE id = ?
    `),

    deleteVectorByChunkId: db.prepare(`
      DELETE FROM vectors_vec WHERE chunk_id = ?
    `),

    deleteChunkVectorByChunkId: db.prepare(`
      DELETE FROM chunk_vectors WHERE chunk_id = ?
    `),

    updateChunkSeq: db.prepare(`
      UPDATE chunks SET seq = ? WHERE id = ?
    `),

    getUnembeddedChunks: db.prepare(`
      SELECT
        c.id AS chunk_id,
        c.content,
        c.name,
        c.chunk_type,
        f.path AS file_path,
        f.repo_id
      FROM chunks c
      JOIN files f ON c.file_id = f.id
      WHERE f.active = 1
        AND c.id NOT IN (SELECT chunk_id FROM chunk_vectors)
      LIMIT ?
    `),

    insertVector: db.prepare(`
      INSERT INTO vectors_vec (chunk_id, embedding)
      VALUES (?, ?)
    `),

    insertChunkVector: db.prepare(`
      INSERT OR REPLACE INTO chunk_vectors (chunk_id, model, embedded_at)
      VALUES (?, ?, ?)
    `),

    searchBM25: db.prepare(`
      SELECT
        c.id AS chunk_id,
        c.file_id,
        c.content,
        c.name,
        c.chunk_type,
        c.start_line,
        c.end_line,
        f.path AS file_path,
        f.repo_id,
        fts.rank
      FROM chunks_fts fts
      JOIN chunks c ON c.id = fts.rowid
      JOIN files f ON c.file_id = f.id
      WHERE chunks_fts MATCH ?
        AND f.active = 1
      ORDER BY fts.rank
      LIMIT ?
    `),

    searchVector: db.prepare(`
      SELECT
        v.chunk_id,
        v.distance
      FROM vectors_vec v
      WHERE v.embedding MATCH ?
        AND k = ?
    `),

    deactivateFile: db.prepare(`
      UPDATE files SET active = 0 WHERE repo_id = ? AND path = ?
    `),

    deleteOrphanChunks: db.prepare(`
      DELETE FROM chunks WHERE file_id IN (
        SELECT id FROM files WHERE active = 0
      )
    `),

    deleteOrphanVectors: db.prepare(`
      DELETE FROM vectors_vec WHERE chunk_id NOT IN (
        SELECT id FROM chunks
      )
    `),

    deleteOrphanChunkVectors: db.prepare(`
      DELETE FROM chunk_vectors WHERE chunk_id NOT IN (
        SELECT id FROM chunks
      )
    `),

    countRepos: db.prepare(`SELECT COUNT(*) AS count FROM repositories`),
    countFiles: db.prepare(`SELECT COUNT(*) AS count FROM files`),
    countActiveFiles: db.prepare(`SELECT COUNT(*) AS count FROM files WHERE active = 1`),
    countChunks: db.prepare(`SELECT COUNT(*) AS count FROM chunks`),
    countEmbeddedChunks: db.prepare(`SELECT COUNT(*) AS count FROM chunk_vectors`),

    getRepository: db.prepare(`
      SELECT * FROM repositories WHERE id = ?
    `),

    getActiveFiles: db.prepare(`
      SELECT * FROM files WHERE repo_id = ? AND active = 1
    `),

    getFileByPath: db.prepare(`
      SELECT * FROM files WHERE repo_id = ? AND path = ?
    `),

    getChunksByFileId: db.prepare(`
      SELECT * FROM chunks WHERE file_id = ? ORDER BY seq ASC
    `),
  };
}

// --- Factory ---

export function createStore(dbPath: string): Store {
  const db = new Database(dbPath);
  let stmts: Statements | null = null;

  return {
    initDb(dimensions: number): void {
      // Load sqlite-vec extension
      sqliteVec.load(db);

      // Pragmas
      db.pragma("journal_mode = WAL");
      db.pragma("foreign_keys = ON");

      // Create core tables
      db.exec(SCHEMA_SQL);

      // Create FTS5 virtual table
      db.exec(FTS_SQL);

      // Create FTS5 triggers
      db.exec(FTS_TRIGGERS_SQL);

      // Create sqlite-vec virtual table
      db.exec(vectorTableSQL(dimensions));

      // Prepare statements
      stmts = prepareStatements(db);
    },

    upsertRepository(repo: RepositoryRow): void {
      stmts!.upsertRepo.run({
        id: repo.id,
        path: repo.path,
        last_commit: repo.last_commit ?? null,
        indexed_at: repo.indexed_at ?? new Date().toISOString(),
        config: repo.config ?? null,
      });
    },

    upsertFile(file: Omit<FileRow, "id">): { id: number; changed: boolean } {
      const existing = stmts!.getFileByRepoAndPath.get(
        file.repo_id,
        file.path
      ) as FileRow | undefined;

      if (existing && existing.hash === file.hash && existing.active === 1) {
        return { id: existing.id, changed: false };
      }

      const result = stmts!.upsertFile.run({
        repo_id: file.repo_id,
        path: file.path,
        hash: file.hash,
        language: file.language ?? null,
        active: file.active ?? 1,
        indexed_at: file.indexed_at ?? new Date().toISOString(),
      });

      const id = existing
        ? existing.id
        : Number(result.lastInsertRowid);

      return { id, changed: true };
    },

    insertChunks(fileId: number, chunks: ChunkInput[]): number[] {
      const ids: number[] = [];
      const txn = db.transaction(() => {
        // Get existing chunks for this file
        const existingChunks = stmts!.getChunkHashesByFileId.all(fileId) as {
          id: number;
          hash: string;
          seq: number;
        }[];

        // Build a map of existing hash -> chunk info (use first occurrence per hash)
        const existingByHash = new Map<string, { id: number; seq: number; used: boolean }>();
        for (const ec of existingChunks) {
          if (!existingByHash.has(ec.hash)) {
            existingByHash.set(ec.hash, { id: ec.id, seq: ec.seq, used: false });
          }
        }

        // Build set of new hashes for detecting removed chunks
        const newHashCounts = new Map<string, number>();
        for (const chunk of chunks) {
          newHashCounts.set(chunk.hash, (newHashCounts.get(chunk.hash) ?? 0) + 1);
        }

        // Track which existing chunk IDs are reused
        const reusedIds = new Set<number>();

        // Process new chunks: match by hash, reuse or insert
        // First pass: collect hash usage to handle duplicates
        const hashUsage = new Map<string, number>(); // hash -> times used so far

        for (const chunk of chunks) {
          const usedCount = hashUsage.get(chunk.hash) ?? 0;
          hashUsage.set(chunk.hash, usedCount + 1);

          // Find an available existing chunk with this hash
          const existing = existingByHash.get(chunk.hash);
          if (existing && !existing.used) {
            // Reuse existing chunk - just update seq if needed
            existing.used = true;
            reusedIds.add(existing.id);

            if (existing.seq !== chunk.seq) {
              // Need to handle UNIQUE(file_id, seq) constraint:
              // Temporarily set seq to a negative value, then update
              stmts!.updateChunkSeq.run(-(chunk.seq + 1), existing.id);
            }
            ids.push(existing.id);
          } else {
            // New chunk - will insert after cleanup
            ids.push(-1); // placeholder
          }
        }

        // Delete chunks that are no longer needed (not reused)
        for (const ec of existingChunks) {
          if (!reusedIds.has(ec.id)) {
            stmts!.deleteVectorByChunkId.run(BigInt(ec.id));
            stmts!.deleteChunkVectorByChunkId.run(ec.id);
            stmts!.deleteChunkById.run(ec.id);
          }
        }

        // Fix temporary seq values for reused chunks
        for (let i = 0; i < chunks.length; i++) {
          if (ids[i] !== -1) {
            const existing = existingByHash.get(chunks[i].hash);
            if (existing && existing.id === ids[i] && existing.seq !== chunks[i].seq) {
              stmts!.updateChunkSeq.run(chunks[i].seq, ids[i]);
            }
          }
        }

        // Insert new chunks (those with placeholder -1)
        for (let i = 0; i < chunks.length; i++) {
          if (ids[i] === -1) {
            const chunk = chunks[i];
            const result = stmts!.insertChunk.run({
              file_id: fileId,
              hash: chunk.hash,
              seq: chunk.seq,
              start_line: chunk.start_line ?? null,
              end_line: chunk.end_line ?? null,
              chunk_type: chunk.chunk_type ?? null,
              name: chunk.name ?? null,
              content: chunk.content,
              metadata: chunk.metadata ?? null,
            });
            ids[i] = Number(result.lastInsertRowid);
          }
        }
      });
      txn();
      return ids;
    },

    getUnembeddedChunks(limit = 100): UnembeddedChunk[] {
      return stmts!.getUnembeddedChunks.all(limit) as UnembeddedChunk[];
    },

    insertEmbeddings(embeddings: EmbeddingInput[]): void {
      const txn = db.transaction(() => {
        const now = new Date().toISOString();
        for (const emb of embeddings) {
          // sqlite-vec requires BigInt for integer primary key bindings
          stmts!.insertVector.run(BigInt(emb.chunk_id), emb.embedding);
          stmts!.insertChunkVector.run(emb.chunk_id, emb.model, now);
        }
      });
      txn();
    },

    searchBM25(query: string, limit = 20): BM25Result[] {
      const ftsQuery = buildFTS5Query(query);
      if (!ftsQuery) return [];
      return stmts!.searchBM25.all(ftsQuery, limit) as BM25Result[];
    },

    searchVector(embedding: Float32Array, limit = 20): VectorResult[] {
      // Step 1: Get chunk_ids and distances from sqlite-vec
      const vecResults = stmts!.searchVector.all(
        embedding,
        limit
      ) as { chunk_id: number; distance: number }[];

      if (vecResults.length === 0) return [];

      // Step 2: Fetch full chunk details for each result
      const results: VectorResult[] = [];
      const detailStmt = db.prepare(`
        SELECT
          c.id AS chunk_id,
          c.file_id,
          c.content,
          c.name,
          c.chunk_type,
          c.start_line,
          c.end_line,
          f.path AS file_path,
          f.repo_id
        FROM chunks c
        JOIN files f ON c.file_id = f.id
        WHERE c.id = ?
          AND f.active = 1
      `);

      for (const vr of vecResults) {
        const row = detailStmt.get(vr.chunk_id) as Omit<VectorResult, "distance"> | undefined;
        if (row) {
          results.push({ ...row, distance: vr.distance });
        }
      }

      return results;
    },

    deactivateFiles(repoId: string, paths: string[]): void {
      const txn = db.transaction(() => {
        for (const p of paths) {
          stmts!.deactivateFile.run(repoId, p);
        }
      });
      txn();
    },

    cleanup(): { deletedChunks: number; deletedVectors: number } {
      let deletedChunks = 0;
      let deletedVectors = 0;

      const txn = db.transaction(() => {
        // Get chunk IDs from inactive files
        const orphanChunkIds = db
          .prepare(`SELECT id FROM chunks WHERE file_id IN (SELECT id FROM files WHERE active = 0)`)
          .all() as { id: number }[];

        if (orphanChunkIds.length > 0) {
          // Delete vectors for these chunks first (sqlite-vec requires BigInt)
          const deleteVec = db.prepare(`DELETE FROM vectors_vec WHERE chunk_id = ?`);
          const deleteCV = db.prepare(`DELETE FROM chunk_vectors WHERE chunk_id = ?`);
          for (const { id } of orphanChunkIds) {
            deleteVec.run(BigInt(id));
            deleteCV.run(id);
          }
          deletedVectors = orphanChunkIds.length;

          // Now delete the orphan chunks
          const chunkResult = stmts!.deleteOrphanChunks.run();
          deletedChunks = chunkResult.changes;
        }
      });
      txn();

      return { deletedChunks, deletedVectors };
    },

    getStats(): StoreStats {
      const repos = (stmts!.countRepos.get() as { count: number }).count;
      const files = (stmts!.countFiles.get() as { count: number }).count;
      const activeFiles = (stmts!.countActiveFiles.get() as { count: number }).count;
      const chunks = (stmts!.countChunks.get() as { count: number }).count;
      const embeddedChunks = (stmts!.countEmbeddedChunks.get() as { count: number }).count;

      return {
        repositories: repos,
        files,
        active_files: activeFiles,
        chunks,
        embedded_chunks: embeddedChunks,
        pending_chunks: chunks - embeddedChunks,
      };
    },

    getRepository(repoId: string): RepositoryRow | undefined {
      return stmts!.getRepository.get(repoId) as RepositoryRow | undefined;
    },

    getActiveFiles(repoId: string): FileRow[] {
      return stmts!.getActiveFiles.all(repoId) as FileRow[];
    },

    getFileByPath(repoId: string, path: string): FileRow | undefined {
      return stmts!.getFileByPath.get(repoId, path) as FileRow | undefined;
    },

    getChunksByFileId(fileId: number): ChunkRow[] {
      return stmts!.getChunksByFileId.all(fileId) as ChunkRow[];
    },

    close(): void {
      db.close();
    },
  };
}

// --- Helpers ---

/**
 * Build an FTS5-compatible query from user input.
 * Supports quoted phrases, handles special characters.
 */
function buildFTS5Query(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";

  // If already contains FTS5 operators, pass through
  if (/["{}\[\]]/.test(trimmed) || /\b(AND|OR|NOT|NEAR)\b/.test(trimmed)) {
    return trimmed;
  }

  // Split into tokens, wrap each in quotes for safe matching
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return "";

  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" ");
}
