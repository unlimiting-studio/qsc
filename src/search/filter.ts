import { basename } from "node:path";

// --- Types ---

export interface QueryFilters {
  includePaths: string[];
  excludePaths: string[];
  includeExts: string[];
  excludeExts: string[];
  includeFiles: string[];
  excludeFiles: string[];
}

export interface ParsedQuery {
  text: string;
  filters: QueryFilters;
}

// --- Filter token patterns ---

const FILTER_PREFIXES = [
  { prefix: "-path:", key: "excludePaths" },
  { prefix: "path:", key: "includePaths" },
  { prefix: "-ext:", key: "excludeExts" },
  { prefix: "ext:", key: "includeExts" },
  { prefix: "-file:", key: "excludeFiles" },
  { prefix: "file:", key: "includeFiles" },
] as const;

/**
 * Normalize an extension value: ensure it starts with a dot.
 * "ts" -> ".ts", ".ts" -> ".ts", ".test.ts" -> ".test.ts"
 */
function normalizeExt(ext: string): string {
  if (ext.startsWith(".")) return ext;
  return `.${ext}`;
}

/**
 * Parse a raw query string into search text and inline filters.
 *
 * Filter syntax:
 * - path:src/api       Include path prefix
 * - -path:vendor       Exclude path prefix
 * - ext:.ts            Include extension
 * - -ext:.test.ts      Exclude extension
 * - file:config.ts     Include file name
 * - -file:package.json Exclude file name
 *
 * @param rawQuery - The raw query string potentially containing filter tokens.
 * @returns Parsed query with separated text and filters.
 */
export function parseQuery(rawQuery: string): ParsedQuery {
  const filters: QueryFilters = {
    includePaths: [],
    excludePaths: [],
    includeExts: [],
    excludeExts: [],
    includeFiles: [],
    excludeFiles: [],
  };

  const tokens = rawQuery.trim().split(/\s+/);
  const textTokens: string[] = [];

  for (const token of tokens) {
    if (!token) continue;

    let matched = false;

    for (const { prefix, key } of FILTER_PREFIXES) {
      if (token.startsWith(prefix)) {
        let value = token.slice(prefix.length);
        if (!value) break; // e.g. "path:" with no value - treat as text

        // Normalize extensions
        if (key === "includeExts" || key === "excludeExts") {
          value = normalizeExt(value);
        }

        filters[key].push(value);
        matched = true;
        break;
      }
    }

    if (!matched) {
      textTokens.push(token);
    }
  }

  return {
    text: textTokens.join(" "),
    filters,
  };
}

/**
 * Check if the given filters are empty (no filters specified).
 */
export function hasFilters(filters: QueryFilters): boolean {
  return (
    filters.includePaths.length > 0 ||
    filters.excludePaths.length > 0 ||
    filters.includeExts.length > 0 ||
    filters.excludeExts.length > 0 ||
    filters.includeFiles.length > 0 ||
    filters.excludeFiles.length > 0
  );
}

/**
 * Test whether a single file path matches the given filters.
 *
 * Filter combination rules:
 * - Same-type include filters: OR (any match includes)
 * - Different-type include filters: AND (all must match)
 * - Exclude filters: OR (any match excludes)
 * - Include AND NOT exclude
 *
 * @param filePath - The file path to test.
 * @param filters - The filters to apply.
 * @returns true if the file path passes all filters.
 */
export function matchesFilters(filePath: string, filters: QueryFilters): boolean {
  // --- Exclude checks (OR: any match -> exclude) ---

  for (const p of filters.excludePaths) {
    if (filePath === p || filePath.startsWith(p.endsWith("/") ? p : `${p}/`)) {
      return false;
    }
  }

  for (const ext of filters.excludeExts) {
    if (filePath.endsWith(ext)) {
      return false;
    }
  }

  for (const f of filters.excludeFiles) {
    const base = basename(filePath);
    if (base === f || filePath === f || filePath.endsWith(`/${f}`)) {
      return false;
    }
  }

  // --- Include checks (same-type OR, cross-type AND) ---

  // Path include: OR within, must pass if any specified
  if (filters.includePaths.length > 0) {
    const pathMatch = filters.includePaths.some(
      (p) => filePath === p || filePath.startsWith(p.endsWith("/") ? p : `${p}/`),
    );
    if (!pathMatch) return false;
  }

  // Ext include: OR within
  if (filters.includeExts.length > 0) {
    const extMatch = filters.includeExts.some((ext) => filePath.endsWith(ext));
    if (!extMatch) return false;
  }

  // File include: OR within
  if (filters.includeFiles.length > 0) {
    const base = basename(filePath);
    const fileMatch = filters.includeFiles.some(
      (f) => base === f || filePath === f || filePath.endsWith(`/${f}`),
    );
    if (!fileMatch) return false;
  }

  return true;
}

/**
 * Filter an array of search results by their file path field.
 * Supports both `filePath` (camelCase) and `file_path` (snake_case) conventions.
 *
 * @param results - Array of objects with a filePath or file_path field.
 * @param filters - The filters to apply.
 * @returns Filtered array preserving original order.
 */
export function applyFilters<T extends { filePath: string } | { file_path: string }>(
  results: T[],
  filters: QueryFilters,
): T[] {
  if (!hasFilters(filters)) return results;
  return results.filter((r) => {
    const fp = "filePath" in r ? (r as { filePath: string }).filePath : (r as { file_path: string }).file_path;
    return matchesFilters(fp, filters);
  });
}
