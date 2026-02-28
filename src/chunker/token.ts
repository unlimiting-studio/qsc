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

export function createTokenChunker(maxTokens: number, overlapRatio: number): TokenChunker {
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
        // Accumulate lines until we reach maxTokens
        let tokenCount = 0;
        let endIdx = lineIdx;
        while (endIdx < lines.length) {
          const lineTokens = estimateTokens(lines[endIdx] + "\n");
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
