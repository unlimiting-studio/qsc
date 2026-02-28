/**
 * Search benchmark timing tests.
 * Verifies that benchmark option correctly measures and returns timing info.
 * Run with: npx tsx tests/search-benchmark.test.ts
 */

import { createStore } from "../src/store.js";
import { createSearchPipeline, type SearchResponse } from "../src/search/index.js";
import { unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const DB_PATH = join(tmpdir(), `qsc-bench-test-${Date.now()}.sqlite`);
const DIMENSIONS = 4;

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    console.log(`  PASS: ${msg}`);
    passed++;
  } else {
    console.error(`  FAIL: ${msg}`);
    failed++;
  }
}

function section(name: string) {
  console.log(`\n--- ${name} ---`);
}

try {
  const store = createStore(DB_PATH);
  store.initDb(DIMENSIONS);

  store.upsertRepository({
    id: "test/repo",
    path: "/tmp/test-repo",
  });

  // Setup test data
  const file = store.upsertFile({
    repo_id: "test/repo",
    path: "src/app.ts",
    hash: "file_hash_1",
    language: "typescript",
    active: 1,
  });

  store.insertChunks(file.id, [
    {
      hash: "c1",
      seq: 0,
      start_line: 1,
      end_line: 10,
      chunk_type: "function",
      name: "handleRequest",
      content: "function handleRequest(req: Request) { return processData(req.body); }",
    },
    {
      hash: "c2",
      seq: 1,
      start_line: 12,
      end_line: 20,
      chunk_type: "function",
      name: "processData",
      content: "function processData(data: any) { return data.map(transform); }",
    },
    {
      hash: "c3",
      seq: 2,
      start_line: 22,
      end_line: 30,
      chunk_type: "class",
      name: "DataService",
      content: "class DataService { async fetch() { return await db.query('SELECT *'); } }",
    },
  ]);

  // ========== 1. BM25 search without benchmark ==========
  section("1. BM25 search without benchmark");

  const pipeline = createSearchPipeline(store);

  const noBenchResponse = await pipeline.search("handleRequest", {
    mode: "bm25",
    limit: 10,
  });

  assert(noBenchResponse.results.length > 0, `Results returned: ${noBenchResponse.results.length}`);
  assert(noBenchResponse.timing === undefined, "No timing when benchmark=false");
  assert(noBenchResponse.counts === undefined, "No counts when benchmark=false");

  // ========== 2. BM25 search with benchmark ==========
  section("2. BM25 search with benchmark");

  const benchResponse = await pipeline.search("handleRequest", {
    mode: "bm25",
    limit: 10,
    benchmark: true,
  });

  assert(benchResponse.results.length > 0, `Results returned: ${benchResponse.results.length}`);
  assert(benchResponse.timing !== undefined, "Timing present when benchmark=true");
  assert(typeof benchResponse.timing!.total === "number", `Total timing: ${benchResponse.timing!.total}ms`);
  assert(typeof benchResponse.timing!.bm25 === "number", `BM25 timing: ${benchResponse.timing!.bm25}ms`);
  assert(benchResponse.timing!.total >= 0, "Total timing >= 0");
  assert(benchResponse.timing!.bm25! >= 0, "BM25 timing >= 0");
  assert(benchResponse.timing!.vector === undefined, "No vector timing in BM25 mode");
  assert(benchResponse.timing!.expand === undefined, "No expand timing without LLM");

  // Verify counts
  assert(benchResponse.counts !== undefined, "Counts present when benchmark=true");
  assert(typeof benchResponse.counts!.bm25 === "number", `BM25 count: ${benchResponse.counts!.bm25}`);
  assert(benchResponse.counts!.bm25! > 0, "BM25 result count > 0");

  // ========== 3. Fusion timing ==========
  section("3. Fusion timing in BM25 mode");

  assert(typeof benchResponse.timing!.fusion === "number", `Fusion timing: ${benchResponse.timing!.fusion}ms`);
  assert(benchResponse.timing!.fusion! >= 0, "Fusion timing >= 0");

  // ========== 4. Result consistency ==========
  section("4. Result consistency (benchmark vs non-benchmark)");

  // Results should be identical regardless of benchmark flag
  assert(
    noBenchResponse.results.length === benchResponse.results.length,
    "Same number of results with and without benchmark",
  );
  assert(
    noBenchResponse.results[0].chunkId === benchResponse.results[0].chunkId,
    "Same first result chunkId",
  );
  assert(
    noBenchResponse.results[0].score === benchResponse.results[0].score,
    "Same first result score",
  );

  // ========== 5. Empty results with benchmark ==========
  section("5. Empty results with benchmark");

  const emptyResponse = await pipeline.search("zzzznonexistent", {
    mode: "bm25",
    limit: 10,
    benchmark: true,
  });

  assert(emptyResponse.results.length === 0, "No results for nonexistent query");
  assert(emptyResponse.timing !== undefined, "Timing present even with no results");
  assert(typeof emptyResponse.timing!.total === "number", `Total timing on empty: ${emptyResponse.timing!.total}ms`);

  // ========== Summary ==========
  store.close();

  console.log(`\n========== SUMMARY ==========`);
  console.log(`PASSED: ${passed}`);
  console.log(`FAILED: ${failed}`);
  console.log(`TOTAL:  ${passed + failed}`);

  if (failed > 0) {
    process.exit(1);
  }
} finally {
  try {
    if (existsSync(DB_PATH)) unlinkSync(DB_PATH);
    if (existsSync(DB_PATH + "-wal")) unlinkSync(DB_PATH + "-wal");
    if (existsSync(DB_PATH + "-shm")) unlinkSync(DB_PATH + "-shm");
  } catch {
    // ignore
  }
}
