import type { LLMProvider } from "../llm/index.js";

export type ExpandedQueryType = "lex" | "vec" | "hyde";

export interface ExpandedQuery {
  type: ExpandedQueryType;
  text: string;
}

const EXPANSION_PROMPT = `You are a code search query expander. Given a user query about source code, generate expanded queries for better search coverage.

For each query, produce exactly 3 variations:
1. "lex": Extract key technical terms, function/class names, and synonyms for keyword search.
2. "vec": Rephrase semantically to capture the intent, suitable for embedding-based search.
3. "hyde": Write a short hypothetical code snippet (2-5 lines) that would match the query.

Respond ONLY with valid JSON array, no markdown fencing:
[{"type":"lex","text":"..."},{"type":"vec","text":"..."},{"type":"hyde","text":"..."}]

User query: `;

/**
 * Expand a search query using an LLM to generate lexical, semantic, and HyDE variants.
 * If no LLM is provided, returns an empty array (caller uses original query only).
 */
export async function expandQuery(
  query: string,
  llm?: LLMProvider,
): Promise<ExpandedQuery[]> {
  if (!llm) return [];

  try {
    const response = await llm.generate(EXPANSION_PROMPT + query, {
      temperature: 0.3,
      maxTokens: 512,
    });

    const parsed = parseExpansionResponse(response);
    // Filter out entries that duplicate the original query
    return parsed.filter((e) => e.text.trim() !== query.trim());
  } catch {
    // LLM failure: graceful fallback to no expansion
    return [];
  }
}

function parseExpansionResponse(response: string): ExpandedQuery[] {
  try {
    // Try to extract JSON array from response (handle potential markdown fencing)
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const arr = JSON.parse(jsonMatch[0]) as unknown[];
    const results: ExpandedQuery[] = [];

    for (const item of arr) {
      if (
        typeof item === "object" &&
        item !== null &&
        "type" in item &&
        "text" in item
      ) {
        const typed = item as { type: string; text: string };
        if (
          (typed.type === "lex" || typed.type === "vec" || typed.type === "hyde") &&
          typeof typed.text === "string" &&
          typed.text.trim().length > 0
        ) {
          results.push({ type: typed.type, text: typed.text.trim() });
        }
      }
    }

    return results;
  } catch {
    return [];
  }
}
