import { extname } from "node:path";
import type { Chunk } from "./index.js";

/**
 * Rough token count estimation: ~4 characters per token on average for code.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Find the best split point near a target line index, respecting code boundaries.
 * Prefers splitting at blank lines, then at dedent boundaries.
 */
function findBestSplit(lines: string[], targetIdx: number, windowSize: number): number {
  const start = Math.max(0, targetIdx - windowSize);
  const end = Math.min(lines.length - 1, targetIdx + windowSize);

  // Prefer blank lines
  for (let i = targetIdx; i >= start; i--) {
    if (lines[i].trim() === "") return i + 1;
  }
  for (let i = targetIdx + 1; i <= end; i++) {
    if (lines[i].trim() === "") return i + 1;
  }

  // Prefer lines with less indentation (scope boundary)
  let bestIdx = targetIdx;
  let bestIndent = Infinity;
  for (let i = start; i <= end; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    const indent = line.length - line.trimStart().length;
    if (indent < bestIndent) {
      bestIndent = indent;
      bestIdx = i;
    }
  }

  return bestIdx;
}

export interface TokenChunker {
  chunk(content: string, filePath: string): Chunk[];
}

/**
 * Split a single long line into multiple chunks of at most maxChars characters.
 * Used when a line exceeds maxTokens (e.g. minified JSON/JS).
 */
function splitLongLine(
  line: string,
  lineNumber: number,
  maxChars: number,
  language: string,
): Chunk[] {
  const chunks: Chunk[] = [];
  let offset = 0;
  while (offset < line.length) {
    const slice = line.slice(offset, offset + maxChars);
    if (slice.trim().length > 0) {
      chunks.push({
        content: slice,
        startLine: lineNumber,
        endLine: lineNumber,
        type: "block",
        language,
      });
    }
    offset += maxChars;
  }
  return chunks;
}

export function createTokenChunker(maxTokens: number, overlapRatio: number): TokenChunker {
  // Maximum characters per chunk (~4 chars per token)
  const maxChars = maxTokens * 4;

  return {
    chunk(content: string, filePath: string): Chunk[] {
      const lines = content.split("\n");
      if (lines.length === 0) return [];

      const ext = extname(filePath).toLowerCase();
      const language = ext ? ext.slice(1) : "unknown";

      const totalTokens = estimateTokens(content);
      if (totalTokens <= maxTokens) {
        return [{
          content,
          startLine: 1,
          endLine: lines.length,
          type: "module",
          language,
        }];
      }

      const overlapTokens = Math.floor(maxTokens * overlapRatio);
      const chunks: Chunk[] = [];
      let lineIdx = 0;

      while (lineIdx < lines.length) {
        // Check if the current line alone exceeds maxTokens (e.g. minified file)
        const firstLineTokens = estimateTokens(lines[lineIdx] + "\n");
        if (firstLineTokens > maxTokens) {
          // Split this long line at character boundaries
          const subChunks = splitLongLine(lines[lineIdx], lineIdx + 1, maxChars, language);
          chunks.push(...subChunks);
          lineIdx++;
          continue;
        }

        // Accumulate lines until we reach maxTokens
        let tokenCount = 0;
        let endIdx = lineIdx;
        while (endIdx < lines.length) {
          const lineTokens = estimateTokens(lines[endIdx] + "\n");
          // If this single line exceeds maxTokens, stop before it
          // (it will be handled by the long-line splitter in the next iteration)
          if (lineTokens > maxTokens && endIdx > lineIdx) break;
          if (tokenCount + lineTokens > maxTokens && endIdx > lineIdx) break;
          tokenCount += lineTokens;
          endIdx++;
        }

        // Try to find a good split point if we're not at the end
        if (endIdx < lines.length) {
          const window = Math.min(10, Math.floor((endIdx - lineIdx) * 0.2));
          endIdx = findBestSplit(lines, endIdx - 1, window);
          if (endIdx <= lineIdx) endIdx = lineIdx + 1;
        }

        const chunkLines = lines.slice(lineIdx, endIdx);
        const chunkContent = chunkLines.join("\n");

        if (chunkContent.trim().length > 0) {
          chunks.push({
            content: chunkContent,
            startLine: lineIdx + 1,
            endLine: endIdx,
            type: "block",
            language,
          });
        }

        // Compute overlap: go back by overlapTokens worth of lines
        if (endIdx >= lines.length) break;
        let overlapLines = 0;
        let overlapCount = 0;
        for (let i = endIdx - 1; i >= lineIdx; i--) {
          const lt = estimateTokens(lines[i] + "\n");
          if (overlapCount + lt > overlapTokens) break;
          overlapCount += lt;
          overlapLines++;
        }
        lineIdx = endIdx - overlapLines;
      }

      return chunks;
    },
  };
}
