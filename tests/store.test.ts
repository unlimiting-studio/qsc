/**
 * Store module verification tests.
 * Run with: npx tsx tests/store.test.ts
 */

import { createStore } from "../src/store.js";
import { unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const DB_PATH = join(tmpdir(), `qsc-test-${Date.now()}.sqlite`);
const DIMENSIONS = 4; // small for testing

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
  // ========== 1. DB 초기화 ==========
  section("1. DB 초기화");
  const store = createStore(DB_PATH);
  store.initDb(DIMENSIONS);
  assert(existsSync(DB_PATH), "DB 파일 생성됨");

  // ========== 2. Repository CRUD ==========
  section("2. Repository upsert");
  store.upsertRepository({
    id: "test/repo",
    path: "/tmp/test-repo",
    last_commit: "abc123",
  });
  // upsert again (update)
  store.upsertRepository({
    id: "test/repo",
    path: "/tmp/test-repo-updated",
    last_commit: "def456",
  });
  const stats1 = store.getStats();
  assert(stats1.repositories === 1, "리포지토리 1개 존재 (upsert 중복 방지)");

  // ========== 3. File upsert 및 변경 감지 ==========
  section("3. File upsert 및 변경 감지");
  const f1 = store.upsertFile({
    repo_id: "test/repo",
    path: "src/main.ts",
    hash: "hash_aaa",
    language: "typescript",
    active: 1,
  });
  assert(f1.changed === true, "새 파일 삽입 시 changed=true");
  assert(f1.id > 0, `파일 id 부여됨: ${f1.id}`);

  // 같은 해시로 다시 upsert → changed false
  const f2 = store.upsertFile({
    repo_id: "test/repo",
    path: "src/main.ts",
    hash: "hash_aaa",
    language: "typescript",
    active: 1,
  });
  assert(f2.changed === false, "동일 해시 → changed=false (증분 인덱싱 스킵)");
  assert(f2.id === f1.id, "동일 파일 id 유지");

  // 다른 해시로 upsert → changed true
  const f3 = store.upsertFile({
    repo_id: "test/repo",
    path: "src/main.ts",
    hash: "hash_bbb",
    language: "typescript",
    active: 1,
  });
  assert(f3.changed === true, "다른 해시 → changed=true (재인덱싱 필요)");

  // ========== 4. Chunk 삽입 ==========
  section("4. Chunk 삽입 및 조회");
  const chunkIds = store.insertChunks(f1.id, [
    {
      hash: "chunk_hash_1",
      seq: 0,
      start_line: 1,
      end_line: 10,
      chunk_type: "function",
      name: "main",
      content: "function main() { console.log('hello'); }",
    },
    {
      hash: "chunk_hash_2",
      seq: 1,
      start_line: 12,
      end_line: 20,
      chunk_type: "function",
      name: "helper",
      content: "function helper(x: number) { return x * 2; }",
    },
    {
      hash: "chunk_hash_3",
      seq: 2,
      start_line: 22,
      end_line: 30,
      chunk_type: "class",
      name: "MyClass",
      content: "class MyClass { constructor() {} }",
    },
  ]);
  assert(chunkIds.length === 3, `3개 청크 삽입됨, ids: ${chunkIds}`);

  const chunks = store.getChunksByFileId(f1.id);
  assert(chunks.length === 3, "파일별 청크 조회 정상");
  assert(chunks[0].name === "main", "첫 번째 청크 이름 = main");

  // 재삽입 시 기존 청크 삭제 후 새로 삽입
  const newChunkIds = store.insertChunks(f1.id, [
    {
      hash: "chunk_hash_new",
      seq: 0,
      start_line: 1,
      end_line: 15,
      chunk_type: "function",
      name: "newMain",
      content: "function newMain() { return 42; }",
    },
  ]);
  assert(newChunkIds.length === 1, "재삽입 후 1개 청크만 존재");
  const chunksAfter = store.getChunksByFileId(f1.id);
  assert(chunksAfter.length === 1, "기존 청크 삭제 확인");
  assert(chunksAfter[0].name === "newMain", "새 청크 이름 = newMain");

  // ========== 5. FTS5 BM25 검색 ==========
  section("5. FTS5 BM25 검색");

  // 검색용 파일 + 청크 추가
  const fSearch = store.upsertFile({
    repo_id: "test/repo",
    path: "src/search-test.ts",
    hash: "hash_search",
    language: "typescript",
    active: 1,
  });
  store.insertChunks(fSearch.id, [
    {
      hash: "s1",
      seq: 0,
      start_line: 1,
      end_line: 10,
      chunk_type: "function",
      name: "searchFunction",
      content: "function searchFunction(query: string) { return database.find(query); }",
    },
    {
      hash: "s2",
      seq: 1,
      start_line: 12,
      end_line: 20,
      chunk_type: "function",
      name: "processResults",
      content: "function processResults(results: any[]) { return results.filter(Boolean); }",
    },
  ]);

  const bm25Results = store.searchBM25("searchFunction", 10);
  assert(bm25Results.length > 0, `BM25 검색 결과: ${bm25Results.length}개`);
  assert(
    bm25Results[0].name === "searchFunction",
    `BM25 첫 결과 이름: ${bm25Results[0].name}`
  );

  const bm25Results2 = store.searchBM25("database query", 10);
  assert(bm25Results2.length > 0, `BM25 'database query' 검색 결과: ${bm25Results2.length}개`);

  const bm25Empty = store.searchBM25("zzzznonexistent", 10);
  assert(bm25Empty.length === 0, "존재하지 않는 검색어 → 0건");

  // ========== 6. 임베딩 관련 ==========
  section("6. 임베딩 (getUnembeddedChunks, insertEmbeddings)");

  const unembedded = store.getUnembeddedChunks(100);
  assert(unembedded.length > 0, `미임베딩 청크: ${unembedded.length}개`);

  // 임베딩 삽입
  const embedInputs = unembedded.map((u) => ({
    chunk_id: u.chunk_id,
    embedding: new Float32Array([0.1, 0.2, 0.3, 0.4]),
    model: "test-model",
  }));
  store.insertEmbeddings(embedInputs);

  const unembeddedAfter = store.getUnembeddedChunks(100);
  assert(unembeddedAfter.length === 0, "임베딩 후 미임베딩 청크 0개");

  // ========== 7. Vector 검색 ==========
  section("7. sqlite-vec 벡터 검색");

  const vecResults = store.searchVector(
    new Float32Array([0.1, 0.2, 0.3, 0.4]),
    10
  );
  assert(vecResults.length > 0, `벡터 검색 결과: ${vecResults.length}개`);
  assert(
    typeof vecResults[0].distance === "number",
    `distance 값: ${vecResults[0].distance}`
  );
  assert(vecResults[0].file_path !== undefined, `파일 경로 포함됨: ${vecResults[0].file_path}`);

  // ========== 8. 파일 비활성화 및 cleanup ==========
  section("8. deactivateFiles 및 cleanup");

  store.deactivateFiles("test/repo", ["src/search-test.ts"]);
  const deactivatedFile = store.getFileByPath("test/repo", "src/search-test.ts");
  assert(deactivatedFile?.active === 0, "파일 비활성화 확인");

  // 비활성화된 파일의 청크는 BM25 검색에서 제외
  const bm25After = store.searchBM25("searchFunction", 10);
  assert(bm25After.length === 0, "비활성화 파일 청크는 BM25 검색 제외");

  // Cleanup
  const cleanResult = store.cleanup();
  assert(cleanResult.deletedChunks > 0, `고아 청크 삭제: ${cleanResult.deletedChunks}개`);

  // ========== 9. getStats ==========
  section("9. getStats");

  const stats = store.getStats();
  assert(stats.repositories === 1, `리포지토리 수: ${stats.repositories}`);
  assert(stats.active_files >= 1, `활성 파일 수: ${stats.active_files}`);
  assert(stats.chunks >= 1, `청크 수: ${stats.chunks}`);
  assert(stats.embedded_chunks >= 0, `임베딩 청크 수: ${stats.embedded_chunks}`);
  console.log("  Stats:", JSON.stringify(stats));

  // ========== 10. getFileByPath ==========
  section("10. getFileByPath");
  const foundFile = store.getFileByPath("test/repo", "src/main.ts");
  assert(foundFile !== undefined, "경로로 파일 조회 성공");
  assert(foundFile!.path === "src/main.ts", `경로: ${foundFile!.path}`);

  // ========== 11. 트랜잭션 롤백 검증 ==========
  section("11. 트랜잭션 롤백");
  const statsBefore = store.getStats();
  try {
    // 잘못된 file_id로 청크 삽입 시도 (FK constraint)
    // 단, better-sqlite3에서 FK는 deferred가 아닌 즉시 체크이므로 에러 발생
    store.insertChunks(999999, [
      {
        hash: "bad",
        seq: 0,
        content: "bad chunk",
      },
    ]);
  } catch {
    // expected error
  }
  const statsAfterRollback = store.getStats();
  assert(
    statsBefore.chunks === statsAfterRollback.chunks,
    "트랜잭션 롤백: 청크 수 변동 없음"
  );

  // ========== 12. close ==========
  section("12. close");
  store.close();
  assert(true, "DB 연결 정상 종료");

  // ========== Summary ==========
  console.log(`\n========== SUMMARY ==========`);
  console.log(`PASSED: ${passed}`);
  console.log(`FAILED: ${failed}`);
  console.log(`TOTAL:  ${passed + failed}`);

  if (failed > 0) {
    process.exit(1);
  }
} finally {
  // Cleanup temp DB
  try {
    if (existsSync(DB_PATH)) unlinkSync(DB_PATH);
    if (existsSync(DB_PATH + "-wal")) unlinkSync(DB_PATH + "-wal");
    if (existsSync(DB_PATH + "-shm")) unlinkSync(DB_PATH + "-shm");
  } catch {
    // ignore
  }
}
