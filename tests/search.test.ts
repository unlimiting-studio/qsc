/**
 * Search pipeline module verification test
 * Run with: npx tsx tests/search.test.ts
 */
import { createStore, type Store, type BM25Result, type VectorResult } from "../src/store.js";
import { searchBM25 } from "../src/search/bm25.js";
import { searchVector, searchVectorWithEmbedding } from "../src/search/vector.js";
import { expandQuery } from "../src/search/expander.js";
import { reciprocalRankFusion } from "../src/search/fusion.js";
import { rerank } from "../src/search/reranker.js";
import { createSearchPipeline } from "../src/search/index.js";
import { parseQuery, matchesFilters, applyFilters, hasFilters, type QueryFilters } from "../src/search/filter.js";
import type { Embedder } from "../src/embedder/index.js";
import type { LLMProvider, GenerateOptions } from "../src/llm/index.js";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${message}`);
  } else {
    failed++;
    console.error(`  FAIL: ${message}`);
  }
}

// --- Test helpers ---

function createTestDb(): { store: Store; dbPath: string } {
  const dbPath = join(tmpdir(), `qsc-search-test-${Date.now()}.db`);
  const store = createStore(dbPath);
  store.initDb(4); // 4 dimensions for testing

  // Seed test data
  store.upsertRepository({
    id: "test/repo",
    path: "/test/repo",
  });

  store.upsertFile({
    repo_id: "test/repo",
    path: "src/auth.ts",
    hash: "hash1",
    language: "typescript",
    active: 1,
  });

  store.upsertFile({
    repo_id: "test/repo",
    path: "src/db.ts",
    hash: "hash2",
    language: "typescript",
    active: 1,
  });

  store.upsertFile({
    repo_id: "test/repo",
    path: "src/utils.ts",
    hash: "hash3",
    language: "typescript",
    active: 1,
  });

  // Insert chunks
  store.insertChunks(1, [
    {
      hash: "c1",
      seq: 0,
      start_line: 1,
      end_line: 10,
      chunk_type: "function",
      name: "authenticate",
      content: "function authenticate(user: string, password: string) { return validateCredentials(user, password); }",
    },
    {
      hash: "c2",
      seq: 1,
      start_line: 12,
      end_line: 20,
      chunk_type: "function",
      name: "validateToken",
      content: "function validateToken(token: string) { return jwt.verify(token, secret); }",
    },
  ]);

  store.insertChunks(2, [
    {
      hash: "c3",
      seq: 0,
      start_line: 1,
      end_line: 15,
      chunk_type: "function",
      name: "connectDatabase",
      content: "function connectDatabase(url: string) { return new Database(url); }",
    },
  ]);

  store.insertChunks(3, [
    {
      hash: "c4",
      seq: 0,
      start_line: 1,
      end_line: 5,
      chunk_type: "function",
      name: "formatDate",
      content: "function formatDate(date: Date) { return date.toISOString(); }",
    },
  ]);

  // Insert embeddings
  store.insertEmbeddings([
    { chunk_id: 1, embedding: new Float32Array([1, 0, 0, 0]), model: "test" },
    { chunk_id: 2, embedding: new Float32Array([0.9, 0.1, 0, 0]), model: "test" },
    { chunk_id: 3, embedding: new Float32Array([0, 0, 1, 0]), model: "test" },
    { chunk_id: 4, embedding: new Float32Array([0, 0, 0, 1]), model: "test" },
  ]);

  return { store, dbPath };
}

function createMockEmbedder(): Embedder {
  return {
    dimensions: 4,
    modelName: "test-model",
    async embed(texts: string[]): Promise<number[][]> {
      // Return deterministic embeddings based on text content
      return texts.map((t) => {
        if (t.includes("auth") || t.includes("login") || t.includes("token")) {
          return [1, 0, 0, 0];
        }
        if (t.includes("database") || t.includes("connect") || t.includes("db")) {
          return [0, 0, 1, 0];
        }
        if (t.includes("date") || t.includes("format") || t.includes("util")) {
          return [0, 0, 0, 1];
        }
        return [0.25, 0.25, 0.25, 0.25];
      });
    },
  };
}

function createMockLLM(): LLMProvider {
  return {
    async generate(prompt: string, _options?: GenerateOptions): Promise<string> {
      // Mock query expansion response
      return JSON.stringify([
        { type: "lex", text: "authenticate login credentials" },
        { type: "vec", text: "user authentication and login flow" },
        { type: "hyde", text: "function login(username, password) { authenticate(username, password); }" },
      ]);
    },
    async rerank(_query: string, documents: string[]): Promise<number[]> {
      // Mock reranking: give highest score to auth-related documents
      return documents.map((doc) => {
        if (doc.includes("authenticate") || doc.includes("token")) return 9;
        if (doc.includes("database")) return 3;
        return 1;
      });
    },
  };
}

// --- Tests ---

async function testBM25Search() {
  console.log("\n[BM25 Search]");
  const { store, dbPath } = createTestDb();

  try {
    const results = searchBM25(store, "authenticate", 10);
    assert(results.length > 0, "BM25 search returns results for 'authenticate'");
    assert(results[0].name === "authenticate", "Top result is the authenticate function");
    assert(results[0].score > 0 && results[0].score <= 1, "Score is normalized to 0-1");
    assert(results[0].filePath === "src/auth.ts", "File path is correct");
    assert(results[0].chunkId > 0, "Chunk ID is present");

    const noResults = searchBM25(store, "xyznonexistent", 10);
    assert(noResults.length === 0, "No results for non-matching query");

    const tokenResults = searchBM25(store, "validateToken", 10);
    assert(tokenResults.length > 0, "BM25 finds validateToken");
  } finally {
    store.close();
    try { unlinkSync(dbPath); } catch {}
  }
}

async function testVectorSearch() {
  console.log("\n[Vector Search]");
  const { store, dbPath } = createTestDb();
  const embedder = createMockEmbedder();

  try {
    const results = await searchVector(store, embedder, "auth login", 10);
    assert(results.length > 0, "Vector search returns results");
    assert(results[0].score >= 0 && results[0].score <= 1, "Score is 0-1 range");

    // Test with pre-computed embedding
    const results2 = searchVectorWithEmbedding(store, [0, 0, 1, 0], 10);
    assert(results2.length > 0, "searchVectorWithEmbedding returns results");
    assert(results2[0].name === "connectDatabase", "Closest vector match is connectDatabase");
  } finally {
    store.close();
    try { unlinkSync(dbPath); } catch {}
  }
}

async function testQueryExpansion() {
  console.log("\n[Query Expansion]");

  // Without LLM: returns empty
  const noLlm = await expandQuery("authenticate user");
  assert(noLlm.length === 0, "Returns empty array without LLM");

  // With mock LLM
  const llm = createMockLLM();
  const expanded = await expandQuery("authenticate user", llm);
  assert(expanded.length === 3, "Returns 3 expanded queries");
  assert(expanded.some((e) => e.type === "lex"), "Has lex expansion");
  assert(expanded.some((e) => e.type === "vec"), "Has vec expansion");
  assert(expanded.some((e) => e.type === "hyde"), "Has hyde expansion");
}

async function testRRFFusion() {
  console.log("\n[RRF Fusion]");

  const bm25Results = [
    [
      { chunkId: 1, fileId: 1, filePath: "a.ts", content: "a", startLine: 1, endLine: 5, chunkType: "function", name: "funcA", score: 0.9 },
      { chunkId: 2, fileId: 1, filePath: "a.ts", content: "b", startLine: 6, endLine: 10, chunkType: "function", name: "funcB", score: 0.7 },
      { chunkId: 3, fileId: 2, filePath: "b.ts", content: "c", startLine: 1, endLine: 5, chunkType: "function", name: "funcC", score: 0.5 },
    ],
  ];

  const vectorResults = [
    [
      { chunkId: 2, fileId: 1, filePath: "a.ts", content: "b", startLine: 6, endLine: 10, chunkType: "function", name: "funcB", score: 0.95 },
      { chunkId: 4, fileId: 3, filePath: "c.ts", content: "d", startLine: 1, endLine: 5, chunkType: "function", name: "funcD", score: 0.8 },
      { chunkId: 1, fileId: 1, filePath: "a.ts", content: "a", startLine: 1, endLine: 5, chunkType: "function", name: "funcA", score: 0.6 },
    ],
  ];

  const fused = reciprocalRankFusion(bm25Results, vectorResults);
  assert(fused.length === 4, "Fused results contain all unique chunks (4)");

  // chunkId 2 appears in both lists (rank 1 in BM25, rank 0 in vec) - should be top
  // chunkId 1 also appears in both (rank 0 in BM25, rank 2 in vec)
  const top2Ids = fused.slice(0, 2).map((r) => r.chunkId);
  assert(top2Ids.includes(1) || top2Ids.includes(2), "Items in both lists rank higher");

  // All items have RRF scores
  assert(fused.every((r) => r.scores.rrf > 0), "All items have RRF scores");

  // Scores are in descending order
  for (let i = 1; i < fused.length; i++) {
    assert(fused[i].score <= fused[i - 1].score, `Score[${i}] <= Score[${i - 1}]`);
  }

  // Deduplication: no duplicate chunkIds
  const ids = new Set(fused.map((r) => r.chunkId));
  assert(ids.size === fused.length, "No duplicate chunk IDs after fusion");
}

async function testReranker() {
  console.log("\n[LLM Reranker]");

  const fusedResults = [
    { chunkId: 1, fileId: 1, filePath: "a.ts", content: "function authenticate() {}", startLine: 1, endLine: 5, chunkType: "function" as const, name: "authenticate", score: 0.5, scores: { rrf: 0.5, bm25: 0.6 } },
    { chunkId: 2, fileId: 2, filePath: "b.ts", content: "function connectDatabase() {}", startLine: 1, endLine: 5, chunkType: "function" as const, name: "connectDatabase", score: 0.45, scores: { rrf: 0.45, vector: 0.7 } },
    { chunkId: 3, fileId: 3, filePath: "c.ts", content: "function formatDate() {}", startLine: 1, endLine: 5, chunkType: "function" as const, name: "formatDate", score: 0.4, scores: { rrf: 0.4 } },
  ];

  // Without LLM: returns same results
  const noLlm = await rerank("auth", fusedResults);
  assert(noLlm.length === 3, "Without LLM returns same count");
  assert(noLlm[0].chunkId === 1, "Without LLM preserves order");

  // With LLM
  const llm = createMockLLM();
  const reranked = await rerank("authenticate", fusedResults, llm);
  assert(reranked.length === 3, "Reranked results have same count");
  assert(reranked[0].scores.rerank !== undefined, "Reranked items have rerank score");
  // authenticate should rank highest since mock LLM gives it score 9
  assert(reranked[0].chunkId === 1, "Auth chunk ranks first after reranking");
}

async function testFullPipeline() {
  console.log("\n[Full Pipeline]");
  const { store, dbPath } = createTestDb();
  const embedder = createMockEmbedder();
  const llm = createMockLLM();

  try {
    const pipeline = createSearchPipeline(store, embedder, llm);

    // BM25 mode
    const bm25Response = await pipeline.search("authenticate", { mode: "bm25", limit: 5 });
    assert(bm25Response.results.length > 0, "BM25 mode returns results");
    assert(bm25Response.results[0].scores.rrf !== undefined, "BM25 mode has RRF score");

    // Vector mode
    const vecResponse = await pipeline.search("database connection", { mode: "vector", limit: 5 });
    assert(vecResponse.results.length > 0, "Vector mode returns results");

    // Hybrid mode
    const hybridResponse = await pipeline.search("authenticate", { mode: "hybrid", limit: 5 });
    assert(hybridResponse.results.length > 0, "Hybrid mode returns results");

    // Hybrid with expansion
    const expandedResponse = await pipeline.search("authenticate", {
      mode: "hybrid",
      limit: 5,
      expand: true,
    });
    assert(expandedResponse.results.length > 0, "Hybrid with expansion returns results");

    // Hybrid with reranking
    const rerankedResponse = await pipeline.search("authenticate", {
      mode: "hybrid",
      limit: 5,
      rerank: true,
    });
    assert(rerankedResponse.results.length > 0, "Hybrid with reranking returns results");
    assert(rerankedResponse.results[0].scores.rerank !== undefined, "Reranked results have rerank score");

    // Full pipeline: expand + rerank
    const fullResponse = await pipeline.search("authenticate", {
      mode: "hybrid",
      limit: 5,
      expand: true,
      rerank: true,
    });
    assert(fullResponse.results.length > 0, "Full pipeline returns results");

    // Pipeline without embedder (vector mode should return empty)
    const noEmbPipeline = createSearchPipeline(store);
    const noVecResponse = await noEmbPipeline.search("test", { mode: "vector" });
    assert(noVecResponse.results.length === 0, "Vector mode without embedder returns empty");

    // Pipeline without LLM (expand/rerank should be no-ops)
    const noLlmPipeline = createSearchPipeline(store, embedder);
    const noLlmResponse = await noLlmPipeline.search("authenticate", {
      mode: "hybrid",
      limit: 5,
      expand: true,
      rerank: true,
    });
    assert(noLlmResponse.results.length > 0, "Pipeline without LLM still returns results");
    assert(noLlmResponse.results[0].scores.rerank === undefined, "No rerank score without LLM");
  } finally {
    store.close();
    try { unlinkSync(dbPath); } catch {}
  }
}

async function testEdgeCases() {
  console.log("\n[Edge Cases]");
  const { store, dbPath } = createTestDb();

  try {
    // Empty query
    const emptyResults = searchBM25(store, "", 10);
    assert(emptyResults.length === 0, "Empty query returns no results");

    // RRF with empty lists
    const emptyFusion = reciprocalRankFusion([], []);
    assert(emptyFusion.length === 0, "RRF with empty lists returns empty");

    // Rerank with empty results
    const emptyRerank = await rerank("test", []);
    assert(emptyRerank.length === 0, "Rerank with empty results returns empty");

    // Expansion with no LLM
    const noExpand = await expandQuery("test");
    assert(noExpand.length === 0, "Expansion without LLM returns empty");

    // Limit enforcement
    const fused = reciprocalRankFusion(
      [[
        { chunkId: 1, fileId: 1, filePath: "a.ts", content: "a", startLine: 1, endLine: 5, chunkType: "function", name: "a", score: 0.9 },
        { chunkId: 2, fileId: 1, filePath: "a.ts", content: "b", startLine: 6, endLine: 10, chunkType: "function", name: "b", score: 0.7 },
      ]],
      [],
      { limit: 1 },
    );
    assert(fused.length === 1, "Limit parameter is respected");
  } finally {
    store.close();
    try { unlinkSync(dbPath); } catch {}
  }
}

async function testParseQuery() {
  console.log("\n[Query Parser]");

  // Basic: no filters
  {
    const result = parseQuery("hello world");
    assert(result.text === "hello world", "No filters: text preserved");
    assert(!hasFilters(result.filters), "No filters: filters are empty");
  }

  // Single path filter
  {
    const result = parseQuery("auth path:src/api");
    assert(result.text === "auth", "Path filter: text extracted");
    assert(result.filters.includePaths.length === 1, "Path filter: one include path");
    assert(result.filters.includePaths[0] === "src/api", "Path filter: correct path value");
  }

  // Exclude path filter
  {
    const result = parseQuery("auth -path:vendor");
    assert(result.text === "auth", "Exclude path: text extracted");
    assert(result.filters.excludePaths.length === 1, "Exclude path: one exclude path");
    assert(result.filters.excludePaths[0] === "vendor", "Exclude path: correct value");
  }

  // Extension filter with dot
  {
    const result = parseQuery("auth ext:.ts");
    assert(result.text === "auth", "Ext filter: text extracted");
    assert(result.filters.includeExts[0] === ".ts", "Ext filter: normalized with dot");
  }

  // Extension filter without dot (normalize)
  {
    const result = parseQuery("auth ext:ts");
    assert(result.filters.includeExts[0] === ".ts", "Ext without dot: normalized to .ts");
  }

  // Multi-part extension
  {
    const result = parseQuery("auth -ext:.test.ts");
    assert(result.filters.excludeExts[0] === ".test.ts", "Multi-part ext: preserved");
  }

  // File filter
  {
    const result = parseQuery("auth file:config.ts");
    assert(result.text === "auth", "File filter: text extracted");
    assert(result.filters.includeFiles[0] === "config.ts", "File filter: correct value");
  }

  // Exclude file filter
  {
    const result = parseQuery("auth -file:package.json");
    assert(result.filters.excludeFiles[0] === "package.json", "Exclude file: correct value");
  }

  // Multiple same-type filters (OR)
  {
    const result = parseQuery("auth path:src/api path:src/auth ext:.ts");
    assert(result.text === "auth", "Multiple filters: text extracted");
    assert(result.filters.includePaths.length === 2, "Multiple paths: two include paths");
    assert(result.filters.includeExts.length === 1, "Multiple filters: one include ext");
  }

  // Complex combined query
  {
    const result = parseQuery("auth path:src/api path:src/auth ext:.ts -path:vendor -ext:.test.ts");
    assert(result.text === "auth", "Complex: text extracted");
    assert(result.filters.includePaths.length === 2, "Complex: 2 include paths");
    assert(result.filters.excludePaths.length === 1, "Complex: 1 exclude path");
    assert(result.filters.includeExts.length === 1, "Complex: 1 include ext");
    assert(result.filters.excludeExts.length === 1, "Complex: 1 exclude ext");
  }

  // Only filters, no text
  {
    const result = parseQuery("path:src ext:.ts");
    assert(result.text === "", "Only filters: empty text");
    assert(hasFilters(result.filters), "Only filters: filters present");
  }

  // Empty input
  {
    const result = parseQuery("");
    assert(result.text === "", "Empty input: empty text");
    assert(!hasFilters(result.filters), "Empty input: no filters");
  }

  // Filter prefix with no value (treated as text)
  {
    const result = parseQuery("auth path:");
    assert(result.text === "auth path:", "Empty filter value: treated as text");
    assert(result.filters.includePaths.length === 0, "Empty filter value: no path added");
  }

  // Multi-word text with filters interspersed
  {
    const result = parseQuery("user auth path:src login");
    assert(result.text === "user auth login", "Interspersed: text tokens joined correctly");
    assert(result.filters.includePaths[0] === "src", "Interspersed: filter extracted correctly");
  }
}

async function testMatchesFilters() {
  console.log("\n[Filter Matching]");

  // Path include
  {
    const filters: QueryFilters = { includePaths: ["src/api"], excludePaths: [], includeExts: [], excludeExts: [], includeFiles: [], excludeFiles: [] };
    assert(matchesFilters("src/api/auth.ts", filters) === true, "Path include: matches prefix");
    assert(matchesFilters("src/api", filters) === true, "Path include: exact match");
    assert(matchesFilters("src/utils/helper.ts", filters) === false, "Path include: non-matching path");
    assert(matchesFilters("src/apix/foo.ts", filters) === false, "Path include: partial prefix rejected");
  }

  // Multiple path includes (OR)
  {
    const filters: QueryFilters = { includePaths: ["src/api", "src/auth"], excludePaths: [], includeExts: [], excludeExts: [], includeFiles: [], excludeFiles: [] };
    assert(matchesFilters("src/api/auth.ts", filters) === true, "Multi path OR: first matches");
    assert(matchesFilters("src/auth/login.ts", filters) === true, "Multi path OR: second matches");
    assert(matchesFilters("src/utils/helper.ts", filters) === false, "Multi path OR: none matches");
  }

  // Path exclude
  {
    const filters: QueryFilters = { includePaths: [], excludePaths: ["vendor"], includeExts: [], excludeExts: [], includeFiles: [], excludeFiles: [] };
    assert(matchesFilters("vendor/lib.js", filters) === false, "Path exclude: excluded");
    assert(matchesFilters("src/api.ts", filters) === true, "Path exclude: non-excluded passes");
  }

  // Extension include
  {
    const filters: QueryFilters = { includePaths: [], excludePaths: [], includeExts: [".ts"], excludeExts: [], includeFiles: [], excludeFiles: [] };
    assert(matchesFilters("src/auth.ts", filters) === true, "Ext include: .ts matches");
    assert(matchesFilters("src/auth.js", filters) === false, "Ext include: .js rejected");
  }

  // Extension exclude
  {
    const filters: QueryFilters = { includePaths: [], excludePaths: [], includeExts: [], excludeExts: [".test.ts"], includeFiles: [], excludeFiles: [] };
    assert(matchesFilters("src/auth.test.ts", filters) === false, "Ext exclude: .test.ts excluded");
    assert(matchesFilters("src/auth.ts", filters) === true, "Ext exclude: .ts passes");
  }

  // File include
  {
    const filters: QueryFilters = { includePaths: [], excludePaths: [], includeExts: [], excludeExts: [], includeFiles: ["config.ts"], excludeFiles: [] };
    assert(matchesFilters("src/config.ts", filters) === true, "File include: matches basename");
    assert(matchesFilters("config.ts", filters) === true, "File include: exact path");
    assert(matchesFilters("src/auth.ts", filters) === false, "File include: non-matching rejected");
  }

  // File exclude
  {
    const filters: QueryFilters = { includePaths: [], excludePaths: [], includeExts: [], excludeExts: [], includeFiles: [], excludeFiles: ["package.json"] };
    assert(matchesFilters("package.json", filters) === false, "File exclude: exact match excluded");
    assert(matchesFilters("sub/package.json", filters) === false, "File exclude: nested excluded");
    assert(matchesFilters("src/auth.ts", filters) === true, "File exclude: non-matching passes");
  }

  // Cross-type AND: path AND ext
  {
    const filters: QueryFilters = { includePaths: ["src"], excludePaths: [], includeExts: [".ts"], excludeExts: [], includeFiles: [], excludeFiles: [] };
    assert(matchesFilters("src/auth.ts", filters) === true, "Cross-type AND: both match");
    assert(matchesFilters("src/auth.js", filters) === false, "Cross-type AND: ext fails");
    assert(matchesFilters("lib/auth.ts", filters) === false, "Cross-type AND: path fails");
  }

  // Include AND exclude together
  {
    const filters: QueryFilters = { includePaths: ["src"], excludePaths: ["src/vendor"], includeExts: [".ts"], excludeExts: [".test.ts"], includeFiles: [], excludeFiles: [] };
    assert(matchesFilters("src/auth.ts", filters) === true, "Include+Exclude: passes both");
    assert(matchesFilters("src/auth.test.ts", filters) === false, "Include+Exclude: ext excluded");
    assert(matchesFilters("src/vendor/lib.ts", filters) === false, "Include+Exclude: path excluded");
    assert(matchesFilters("lib/auth.ts", filters) === false, "Include+Exclude: path not included");
  }

  // No filters: everything passes
  {
    const filters: QueryFilters = { includePaths: [], excludePaths: [], includeExts: [], excludeExts: [], includeFiles: [], excludeFiles: [] };
    assert(matchesFilters("anything.xyz", filters) === true, "No filters: everything passes");
  }
}

async function testApplyFilters() {
  console.log("\n[Apply Filters]");

  const results = [
    { filePath: "src/api/auth.ts", score: 0.9 },
    { filePath: "src/api/db.ts", score: 0.8 },
    { filePath: "src/utils/helper.ts", score: 0.7 },
    { filePath: "vendor/lib.js", score: 0.6 },
    { filePath: "src/auth/login.test.ts", score: 0.5 },
  ];

  // No filters: all pass
  {
    const filters: QueryFilters = { includePaths: [], excludePaths: [], includeExts: [], excludeExts: [], includeFiles: [], excludeFiles: [] };
    const filtered = applyFilters(results, filters);
    assert(filtered.length === 5, "No filters: all results pass");
  }

  // Path include
  {
    const filters: QueryFilters = { includePaths: ["src/api"], excludePaths: [], includeExts: [], excludeExts: [], includeFiles: [], excludeFiles: [] };
    const filtered = applyFilters(results, filters);
    assert(filtered.length === 2, "Path include: only src/api results");
    assert(filtered.every(r => r.filePath.startsWith("src/api/")), "Path include: all start with src/api/");
  }

  // Exclude path + ext
  {
    const filters: QueryFilters = { includePaths: [], excludePaths: ["vendor"], includeExts: [], excludeExts: [".test.ts"], includeFiles: [], excludeFiles: [] };
    const filtered = applyFilters(results, filters);
    assert(filtered.length === 3, "Exclude path+ext: vendor and .test.ts excluded");
    assert(filtered.every(r => !r.filePath.startsWith("vendor/") && !r.filePath.endsWith(".test.ts")), "Exclude: no excluded results");
  }

  // (src/api OR src/auth) AND .ts
  {
    const filters: QueryFilters = { includePaths: ["src/api", "src/auth"], excludePaths: [], includeExts: [".ts"], excludeExts: [], includeFiles: [], excludeFiles: [] };
    const filtered = applyFilters(results, filters);
    assert(filtered.length === 3, "OR paths AND ext: 3 results (auth.ts, db.ts, login.test.ts)");
  }

  // snake_case file_path support
  {
    const snakeResults = [
      { file_path: "src/api/auth.ts", score: 0.9 },
      { file_path: "vendor/lib.js", score: 0.6 },
    ];
    const filters: QueryFilters = { includePaths: ["src"], excludePaths: [], includeExts: [], excludeExts: [], includeFiles: [], excludeFiles: [] };
    const filtered = applyFilters(snakeResults, filters);
    assert(filtered.length === 1, "snake_case: filters work with file_path");
    assert((filtered[0] as any).file_path === "src/api/auth.ts", "snake_case: correct result");
  }
}

async function testPipelineWithFilters() {
  console.log("\n[Pipeline with Filters]");
  const { store, dbPath } = createTestDb();

  try {
    const pipeline = createSearchPipeline(store);

    // BM25 with path filter: only src/auth.ts results
    const pathFiltered = await pipeline.search("authenticate", {
      mode: "bm25",
      limit: 10,
      filters: {
        includePaths: ["src"],
        excludePaths: [],
        includeExts: [],
        excludeExts: [],
        includeFiles: [],
        excludeFiles: [],
      },
    });
    assert(pathFiltered.results.length > 0, "Pipeline path filter: returns results");
    assert(pathFiltered.results.every(r => r.filePath.startsWith("src/")), "Pipeline path filter: all in src/");

    // BM25 with exclude file filter
    const excludeFiltered = await pipeline.search("function", {
      mode: "bm25",
      limit: 10,
      filters: {
        includePaths: [],
        excludePaths: [],
        includeExts: [],
        excludeExts: [],
        includeFiles: [],
        excludeFiles: ["db.ts"],
      },
    });
    assert(excludeFiltered.results.every(r => !r.filePath.endsWith("db.ts")), "Pipeline exclude file: db.ts excluded");

    // BM25 with ext filter
    const extFiltered = await pipeline.search("function", {
      mode: "bm25",
      limit: 10,
      filters: {
        includePaths: [],
        excludePaths: [],
        includeExts: [".ts"],
        excludeExts: [],
        includeFiles: [],
        excludeFiles: [],
      },
    });
    assert(extFiltered.results.length > 0, "Pipeline ext filter: returns results");
    assert(extFiltered.results.every(r => r.filePath.endsWith(".ts")), "Pipeline ext filter: all .ts");

    // No filters: same as before
    const noFilter = await pipeline.search("authenticate", {
      mode: "bm25",
      limit: 10,
    });
    assert(noFilter.results.length > 0, "Pipeline no filter: returns results normally");

    // Restrictive filter: no results
    const emptyFiltered = await pipeline.search("authenticate", {
      mode: "bm25",
      limit: 10,
      filters: {
        includePaths: ["nonexistent"],
        excludePaths: [],
        includeExts: [],
        excludeExts: [],
        includeFiles: [],
        excludeFiles: [],
      },
    });
    assert(emptyFiltered.results.length === 0, "Pipeline restrictive filter: no results");
  } finally {
    store.close();
    try { unlinkSync(dbPath); } catch {}
  }
}

// --- Run all tests ---

async function main() {
  console.log("=== Search Pipeline Tests ===");

  await testBM25Search();
  await testVectorSearch();
  await testQueryExpansion();
  await testRRFFusion();
  await testReranker();
  await testFullPipeline();
  await testEdgeCases();
  await testParseQuery();
  await testMatchesFilters();
  await testApplyFilters();
  await testPipelineWithFilters();

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Test runner error:", err);
  process.exit(1);
});
