/**
 * Incremental chunk insertion tests.
 * Verifies that only changed chunks are re-inserted while unchanged chunks are preserved.
 * Run with: npx tsx tests/incremental-chunks.test.ts
 */

import { createStore } from "../src/store.js";
import { unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const DB_PATH = join(tmpdir(), `qsc-incr-test-${Date.now()}.sqlite`);
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

  const file = store.upsertFile({
    repo_id: "test/repo",
    path: "src/app.ts",
    hash: "file_hash_1",
    language: "typescript",
    active: 1,
  });

  // ========== 1. Initial insertion ==========
  section("1. Initial chunk insertion (100 chunks)");

  const initialChunks = Array.from({ length: 100 }, (_, i) => ({
    hash: `chunk_hash_${i}`,
    seq: i,
    start_line: i * 10 + 1,
    end_line: (i + 1) * 10,
    chunk_type: "function" as const,
    name: `func_${i}`,
    content: `function func_${i}() { return ${i}; }`,
  }));

  const initialIds = store.insertChunks(file.id, initialChunks);
  assert(initialIds.length === 100, `100 chunks inserted, got ${initialIds.length}`);

  // Add embeddings to some chunks to verify they are preserved
  store.insertEmbeddings(
    initialIds.map((id) => ({
      chunk_id: id,
      embedding: new Float32Array([0.1, 0.2, 0.3, 0.4]),
      model: "test-model",
    })),
  );

  const statsAfterInit = store.getStats();
  assert(statsAfterInit.embedded_chunks === 100, `All 100 chunks embedded`);

  // ========== 2. Change 1 out of 100 ==========
  section("2. Change 1 chunk out of 100");

  const modifiedChunks = initialChunks.map((c, i) => {
    if (i === 50) {
      return { ...c, hash: "chunk_hash_50_modified", content: "function func_50() { return 999; }" };
    }
    return c;
  });

  const modifiedIds = store.insertChunks(file.id, modifiedChunks);
  assert(modifiedIds.length === 100, `Still 100 chunks after modification`);

  // The 99 unchanged chunks should keep their original IDs
  let preservedCount = 0;
  for (let i = 0; i < 100; i++) {
    if (i !== 50 && modifiedIds[i] === initialIds[i]) {
      preservedCount++;
    }
  }
  assert(preservedCount === 99, `99 chunks preserved (IDs unchanged), got ${preservedCount}`);

  // The modified chunk should have a new ID
  assert(modifiedIds[50] !== initialIds[50], `Modified chunk got new ID: ${modifiedIds[50]} vs ${initialIds[50]}`);

  // Embeddings for preserved chunks should still be there
  const statsAfterMod = store.getStats();
  assert(statsAfterMod.embedded_chunks === 99, `99 embeddings preserved (1 removed for modified chunk), got ${statsAfterMod.embedded_chunks}`);
  assert(statsAfterMod.pending_chunks === 1, `1 chunk pending embedding, got ${statsAfterMod.pending_chunks}`);

  // ========== 3. Delete chunks (function removed) ==========
  section("3. Remove chunks (function deletion)");

  const fewerChunks = initialChunks.slice(0, 50); // Keep only first 50
  // But chunk at index 50 was already modified, so use original hashes for 0-49
  const fewerIds = store.insertChunks(file.id, fewerChunks);
  assert(fewerIds.length === 50, `50 chunks after removal`);

  const chunksAfterRemoval = store.getChunksByFileId(file.id);
  assert(chunksAfterRemoval.length === 50, `50 chunks in DB after removal`);

  // Preserved chunks should keep their IDs
  let preservedAfterRemoval = 0;
  for (let i = 0; i < 50; i++) {
    if (fewerIds[i] === initialIds[i]) {
      preservedAfterRemoval++;
    }
  }
  assert(preservedAfterRemoval === 50, `All 50 remaining chunks preserved, got ${preservedAfterRemoval}`);

  // ========== 4. Add new chunks (function added) ==========
  section("4. Add new chunks (function addition)");

  const extendedChunks = [
    ...fewerChunks,
    {
      hash: "new_chunk_hash_A",
      seq: 50,
      start_line: 501,
      end_line: 510,
      chunk_type: "function",
      name: "newFuncA",
      content: "function newFuncA() { return 'A'; }",
    },
    {
      hash: "new_chunk_hash_B",
      seq: 51,
      start_line: 511,
      end_line: 520,
      chunk_type: "function",
      name: "newFuncB",
      content: "function newFuncB() { return 'B'; }",
    },
  ];

  const extendedIds = store.insertChunks(file.id, extendedChunks);
  assert(extendedIds.length === 52, `52 chunks after addition`);

  // First 50 should be preserved
  let preservedAfterAdd = 0;
  for (let i = 0; i < 50; i++) {
    if (extendedIds[i] === fewerIds[i]) {
      preservedAfterAdd++;
    }
  }
  assert(preservedAfterAdd === 50, `First 50 chunks preserved, got ${preservedAfterAdd}`);

  // ========== 5. Seq reordering (function inserted in middle) ==========
  section("5. Seq reordering (function inserted in middle)");

  const reorderedChunks = [
    { ...initialChunks[0], seq: 0 }, // func_0 at seq 0
    {
      hash: "inserted_middle_hash",
      seq: 1,
      start_line: 5,
      end_line: 8,
      chunk_type: "function",
      name: "insertedMiddle",
      content: "function insertedMiddle() {}",
    },
    { ...initialChunks[1], seq: 2 }, // func_1 at seq 2 (was seq 1)
    { ...initialChunks[2], seq: 3 }, // func_2 at seq 3 (was seq 2)
  ];

  const reorderedIds = store.insertChunks(file.id, reorderedChunks);
  assert(reorderedIds.length === 4, `4 chunks after reordering`);

  const reorderedChunkRows = store.getChunksByFileId(file.id);
  assert(reorderedChunkRows[0].name === "func_0", `First chunk is func_0`);
  assert(reorderedChunkRows[1].name === "insertedMiddle", `Second chunk is insertedMiddle`);
  assert(reorderedChunkRows[2].name === "func_1", `Third chunk is func_1`);
  assert(reorderedChunkRows[3].name === "func_2", `Fourth chunk is func_2`);

  // Verify seq values are correct
  assert(reorderedChunkRows[0].seq === 0, `func_0 seq=0`);
  assert(reorderedChunkRows[1].seq === 1, `insertedMiddle seq=1`);
  assert(reorderedChunkRows[2].seq === 2, `func_1 seq=2`);
  assert(reorderedChunkRows[3].seq === 3, `func_2 seq=3`);

  // ========== 6. No changes ==========
  section("6. No changes (all hashes same)");

  const sameChunks = reorderedChunks.map((c) => ({ ...c }));
  const sameIds = store.insertChunks(file.id, sameChunks);
  assert(sameIds.length === 4, `4 chunks (no changes)`);

  // All IDs should be preserved
  let allPreserved = true;
  for (let i = 0; i < 4; i++) {
    if (sameIds[i] !== reorderedIds[i]) {
      allPreserved = false;
      break;
    }
  }
  assert(allPreserved, `All chunk IDs preserved when no changes`);

  // ========== 7. FTS5 consistency ==========
  section("7. FTS5 consistency after incremental updates");

  const ftsResults = store.searchBM25("insertedMiddle", 10);
  assert(ftsResults.length === 1, `FTS5 finds insertedMiddle: ${ftsResults.length}`);
  assert(ftsResults[0].name === "insertedMiddle", `FTS5 result name correct`);

  // Removed chunks should not appear in FTS
  const removedResults = store.searchBM25("func_50", 10);
  assert(removedResults.length === 0, `Removed func_50 not in FTS results`);

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
