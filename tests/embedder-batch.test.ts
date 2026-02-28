/**
 * Embedder token-based batch splitting tests.
 * Verifies that batches are split by estimated token count to avoid
 * exceeding the OpenAI embedding API's 300k token limit.
 * Run with: npx tsx tests/embedder-batch.test.ts
 */

import {
  estimateTokens,
  splitBatchesByTokens,
} from "../src/embedder/openai.js";

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

// ========== 1. estimateTokens ==========
section("1. estimateTokens");

assert(estimateTokens("") === 0, "Empty string = 0 tokens");
assert(estimateTokens("abcd") === 1, "4 chars = 1 token");
assert(estimateTokens("abcde") === 2, "5 chars = 2 tokens (ceil)");
assert(estimateTokens("a".repeat(400)) === 100, "400 chars = 100 tokens");

// ========== 2. splitBatchesByTokens: single small batch ==========
section("2. Single small batch (fits in one request)");

const smallTexts = ["hello", "world", "test"];
const smallBatches = splitBatchesByTokens(smallTexts);
assert(smallBatches.length === 1, `1 batch for 3 small texts, got ${smallBatches.length}`);
assert(smallBatches[0].length === 3, `Batch has all 3 items`);
assert(smallBatches[0][0].index === 0, "First item index = 0");
assert(smallBatches[0][1].index === 1, "Second item index = 1");
assert(smallBatches[0][2].index === 2, "Third item index = 2");

// ========== 3. splitBatchesByTokens: empty input ==========
section("3. Empty input");

const emptyBatches = splitBatchesByTokens([]);
assert(emptyBatches.length === 0, "Empty input = 0 batches");

// ========== 4. splitBatchesByTokens: token limit splitting ==========
section("4. Token limit splitting");

// Each chunk is ~100k tokens (400k chars). Two of them = 200k tokens (under 250k limit).
// Three of them = 300k tokens (over 250k limit), so should split.
const largeText = "x".repeat(400_000); // ~100k tokens
const threeTexts = [largeText, largeText, largeText];
const tokenBatches = splitBatchesByTokens(threeTexts);
assert(
  tokenBatches.length === 2,
  `3 x 100k-token texts split into 2 batches, got ${tokenBatches.length}`,
);
// First batch should have 2 items (200k tokens < 250k limit)
assert(tokenBatches[0].length === 2, `First batch has 2 items, got ${tokenBatches[0].length}`);
// Second batch should have 1 item
assert(tokenBatches[1].length === 1, `Second batch has 1 item, got ${tokenBatches[1].length}`);

// Verify indices are preserved
assert(tokenBatches[0][0].index === 0, "First batch, first item: index 0");
assert(tokenBatches[0][1].index === 1, "First batch, second item: index 1");
assert(tokenBatches[1][0].index === 2, "Second batch, first item: index 2");

// ========== 5. splitBatchesByTokens: many small chunks exceeding token limit ==========
section("5. Many small chunks that together exceed token limit");

// 500 chunks of ~1000 tokens each = 500k tokens total, needs splitting
const manyTexts = Array.from({ length: 500 }, (_, i) => "y".repeat(4000)); // ~1000 tokens each
const manyBatches = splitBatchesByTokens(manyTexts);
assert(manyBatches.length >= 2, `500 x 1k-token texts need at least 2 batches, got ${manyBatches.length}`);

// Verify each batch respects the 250k token limit
for (let b = 0; b < manyBatches.length; b++) {
  const batchTokens = manyBatches[b].reduce(
    (sum, item) => sum + estimateTokens(item.text),
    0,
  );
  assert(
    batchTokens <= 250_000,
    `Batch ${b + 1}: ${batchTokens} tokens <= 250,000`,
  );
}

// Verify all indices are present
const allIndices = manyBatches.flatMap((b) => b.map((item) => item.index)).sort((a, b) => a - b);
assert(allIndices.length === 500, `All 500 items present across batches`);
assert(allIndices[0] === 0, "First index is 0");
assert(allIndices[499] === 499, "Last index is 499");

// ========== 6. splitBatchesByTokens: single oversized chunk truncation ==========
section("6. Single oversized chunk truncation");

// A single chunk that is ~300k tokens (1.2M chars), exceeds 250k limit
const oversizedText = "z".repeat(1_200_000); // ~300k tokens
const oversizedBatches = splitBatchesByTokens([oversizedText]);
assert(oversizedBatches.length === 1, `Oversized text still produces 1 batch`);
assert(
  oversizedBatches[0][0].text.length === 1_000_000,
  `Oversized text truncated to 1,000,000 chars (250k tokens), got ${oversizedBatches[0][0].text.length}`,
);

// ========== 7. splitBatchesByTokens: mixed sizes ==========
section("7. Mixed sizes");

const mixedTexts = [
  "a".repeat(800_000),  // ~200k tokens
  "b".repeat(100_000),  // ~25k tokens
  "c".repeat(200_000),  // ~50k tokens
  "d".repeat(400_000),  // ~100k tokens
  "e".repeat(40_000),   // ~10k tokens
];
const mixedBatches = splitBatchesByTokens(mixedTexts);

// Verify no batch exceeds 250k tokens
for (let b = 0; b < mixedBatches.length; b++) {
  const batchTokens = mixedBatches[b].reduce(
    (sum, item) => sum + estimateTokens(item.text),
    0,
  );
  assert(
    batchTokens <= 250_000,
    `Mixed batch ${b + 1}: ${batchTokens} tokens <= 250,000`,
  );
}

// Verify all items are present
const mixedAllIndices = mixedBatches
  .flatMap((b) => b.map((item) => item.index))
  .sort((a, b) => a - b);
assert(
  mixedAllIndices.length === 5 &&
    mixedAllIndices[0] === 0 &&
    mixedAllIndices[4] === 4,
  `All 5 items present across batches`,
);

// ========== 8. Batch size (item count) limit ==========
section("8. Batch size (item count) limit");

// 3000 tiny texts - each is 1 token, total 3000 tokens, but exceeds MAX_BATCH_SIZE of 2048
const tinyTexts = Array.from({ length: 3000 }, () => "a");
const tinyBatches = splitBatchesByTokens(tinyTexts);
assert(tinyBatches.length >= 2, `3000 tiny texts need at least 2 batches (MAX_BATCH_SIZE=2048), got ${tinyBatches.length}`);
assert(tinyBatches[0].length <= 2048, `First batch has <= 2048 items, got ${tinyBatches[0].length}`);

// ========== 9. Order preservation ==========
section("9. Order preservation");

const orderedTexts = ["first", "second", "third", "fourth", "fifth"];
const orderedBatches = splitBatchesByTokens(orderedTexts);
const orderedItems = orderedBatches.flatMap((b) => b);
for (let i = 0; i < orderedItems.length; i++) {
  assert(
    orderedItems[i].index === i,
    `Item at position ${i} has index ${orderedItems[i].index}`,
  );
  assert(
    orderedItems[i].text === orderedTexts[i],
    `Item at position ${i} has correct text`,
  );
}

// ========== Summary ==========
console.log(`\n========== SUMMARY ==========`);
console.log(`PASSED: ${passed}`);
console.log(`FAILED: ${failed}`);
console.log(`TOTAL:  ${passed + failed}`);

if (failed > 0) {
  process.exit(1);
}
