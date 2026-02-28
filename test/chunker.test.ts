/**
 * Chunker module verification test
 * Run with: npx tsx test/chunker.test.ts
 */
import { createChunker } from "../src/chunker/index.js";
import type { Chunk } from "../src/chunker/index.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
  if (condition) {
    passed++;
    console.log(`  PASS: ${msg}`);
  } else {
    failed++;
    console.error(`  FAIL: ${msg}`);
  }
}

// --- Test data ---

const tsSource = `
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface Config {
  name: string;
  value: number;
}

function greet(name: string): string {
  return \`Hello, \${name}!\`;
}

class Calculator {
  private value: number = 0;

  add(n: number): void {
    this.value += n;
  }

  subtract(n: number): void {
    this.value -= n;
  }

  getResult(): number {
    return this.value;
  }
}

export function main(): void {
  const calc = new Calculator();
  calc.add(5);
  calc.subtract(2);
  console.log(calc.getResult());
}
`.trim();

const pySource = `
import os
from pathlib import Path

def greet(name: str) -> str:
    """Return a greeting."""
    return f"Hello, {name}!"

class Calculator:
    def __init__(self):
        self.value = 0

    def add(self, n: int) -> None:
        self.value += n

    def subtract(self, n: int) -> None:
        self.value -= n

    def get_result(self) -> int:
        return self.value

def main():
    calc = Calculator()
    calc.add(5)
    calc.subtract(2)
    print(calc.get_result())
`.trim();

const unknownSource = `
This is a plain text file.
It has no particular structure.
Just some lines of text that should be chunked by the token-based chunker.
Line 4.
Line 5.
`.trim();

// Generate a large TypeScript function (> maxTokens)
function generateLargeFunction(lines: number): string {
  const parts = [
    'import { something } from "somewhere";',
    "",
    `function largeFunction(): void {`,
  ];
  for (let i = 0; i < lines; i++) {
    parts.push(`  const x${i} = ${i} * Math.random(); // computation line ${i}`);
  }
  parts.push("}");
  return parts.join("\n");
}

const largeSource = generateLargeFunction(500);

// --- Tests ---

async function testTypeScriptChunking(): Promise<void> {
  console.log("\n=== Test: TypeScript AST Chunking ===");
  const chunker = createChunker({ max_tokens: 900, overlap: 0.15 });
  const chunks = await chunker.chunk(tsSource, "example.ts");

  assert(chunks.length > 0, `Got ${chunks.length} chunks (expected > 0)`);
  assert(chunks.every((c) => c.language === "typescript"), "All chunks have language 'typescript'");

  // Check that functions/classes are extracted
  const names = chunks.map((c) => c.name).filter(Boolean);
  console.log(`  Names found: ${names.join(", ")}`);
  assert(names.includes("greet"), "Found function 'greet'");
  assert(names.includes("Calculator"), "Found class 'Calculator'");
  assert(names.includes("main"), "Found function 'main'");

  // Check that chunk types are correct
  const types = new Set(chunks.map((c) => c.type));
  console.log(`  Types found: ${[...types].join(", ")}`);
  assert(types.has("function") || types.has("module"), "Has function/module type chunks");

  // Check that import prefix is included in non-import chunks
  const nonImportChunks = chunks.filter((c) => c.type !== "module");
  const hasImportPrefix = nonImportChunks.some((c) =>
    c.content.includes('import { readFileSync }')
  );
  assert(hasImportPrefix, "Import prefix included in non-import chunks");

  // Check line numbers
  assert(chunks.every((c) => c.startLine >= 1), "All startLines >= 1");
  assert(chunks.every((c) => c.endLine >= c.startLine), "All endLines >= startLines");
}

async function testPythonChunking(): Promise<void> {
  console.log("\n=== Test: Python AST Chunking ===");
  const chunker = createChunker({ max_tokens: 900, overlap: 0.15 });
  const chunks = await chunker.chunk(pySource, "example.py");

  assert(chunks.length > 0, `Got ${chunks.length} chunks (expected > 0)`);
  assert(chunks.every((c) => c.language === "python"), "All chunks have language 'python'");

  const names = chunks.map((c) => c.name).filter(Boolean);
  console.log(`  Names found: ${names.join(", ")}`);
  assert(names.includes("greet"), "Found function 'greet'");
  assert(names.includes("Calculator"), "Found class 'Calculator'");
  assert(names.includes("main"), "Found function 'main'");

  // Check import prefix
  const nonImportChunks = chunks.filter((c) => c.type !== "module");
  const hasImportPrefix = nonImportChunks.some((c) =>
    c.content.includes("import os")
  );
  assert(hasImportPrefix, "Import prefix included in Python chunks");
}

async function testFallbackChunking(): Promise<void> {
  console.log("\n=== Test: Fallback Token Chunking (unknown extension) ===");
  const chunker = createChunker({ max_tokens: 900, overlap: 0.15 });
  const chunks = await chunker.chunk(unknownSource, "readme.txt");

  assert(chunks.length > 0, `Got ${chunks.length} chunks (expected > 0)`);
  assert(chunks.every((c) => c.language === "txt"), "Language is 'txt'");
  assert(chunks.every((c) => c.type === "module" || c.type === "block"), "Type is module or block");
}

async function testLargeFunctionSubdivision(): Promise<void> {
  console.log("\n=== Test: Large Function Subdivision ===");
  const chunker = createChunker({ max_tokens: 900, overlap: 0.15 });
  const chunks = await chunker.chunk(largeSource, "large.ts");

  console.log(`  Got ${chunks.length} chunks from ~500 line function`);
  assert(chunks.length > 1, `Large function was split into ${chunks.length} chunks (expected > 1)`);

  // Verify all chunks have reasonable token counts
  for (const chunk of chunks) {
    const estimatedTokens = Math.ceil(chunk.content.length / 4);
    // Allow import prefix to make chunks slightly larger
    assert(
      estimatedTokens < 900 * 3,
      `Chunk tokens ${estimatedTokens} is reasonable (< ${900 * 3})`,
    );
  }
}

async function testNameExtraction(): Promise<void> {
  console.log("\n=== Test: Name Extraction ===");
  const chunker = createChunker({ max_tokens: 900, overlap: 0.15 });

  const source = `
export function fetchData(url: string): Promise<Response> {
  return fetch(url);
}

export class UserService {
  getUser(id: string): User {
    return db.find(id);
  }
}

export interface UserRepository {
  findById(id: string): User;
}
`.trim();

  const chunks = await chunker.chunk(source, "service.ts");
  const names = chunks.map((c) => c.name).filter(Boolean);
  console.log(`  Names: ${names.join(", ")}`);
  assert(names.includes("fetchData"), "Extracted name 'fetchData'");
  assert(names.includes("UserService"), "Extracted name 'UserService'");
  assert(names.includes("UserRepository"), "Extracted name 'UserRepository'");
}

async function main(): Promise<void> {
  console.log("Chunker Module Verification Tests");
  console.log("==================================");

  await testTypeScriptChunking();
  await testPythonChunking();
  await testFallbackChunking();
  await testLargeFunctionSubdivision();
  await testNameExtraction();

  console.log("\n==================================");
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Test runner error:", err);
  process.exit(1);
});
