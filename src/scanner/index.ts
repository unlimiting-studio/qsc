import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve, relative, extname } from "node:path";
import fg from "fast-glob";
import type { ScannerConfig } from "../config/index.js";

// --- Interfaces ---

export interface ScannedFile {
  path: string;          // repository root relative path
  absolutePath: string;  // absolute path
  hash: string;          // SHA-256 content hash
  size: number;          // file size in bytes
  language?: string;     // detected language
}

export interface ScanResult {
  files: ScannedFile[];
  repoRoot: string;
  totalSize: number;
}

// --- Language detection ---

const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".pyi": "python",
  ".go": "go",
  ".dart": "dart",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".swift": "swift",
  ".java": "java",
  ".rs": "rust",
  ".rb": "ruby",
  ".php": "php",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".cc": "cpp",
  ".cs": "csharp",
  ".scala": "scala",
  ".lua": "lua",
  ".sh": "shell",
  ".bash": "shell",
  ".zsh": "shell",
  ".sql": "sql",
  ".html": "html",
  ".htm": "html",
  ".css": "css",
  ".scss": "scss",
  ".less": "less",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".xml": "xml",
  ".md": "markdown",
  ".mdx": "markdown",
  ".vue": "vue",
  ".svelte": "svelte",
  ".astro": "astro",
  ".graphql": "graphql",
  ".gql": "graphql",
  ".proto": "protobuf",
  ".r": "r",
  ".R": "r",
  ".ex": "elixir",
  ".exs": "elixir",
  ".erl": "erlang",
  ".hs": "haskell",
  ".ml": "ocaml",
  ".mli": "ocaml",
  ".clj": "clojure",
  ".tf": "terraform",
  ".dockerfile": "dockerfile",
};

export function detectLanguage(filePath: string): string | undefined {
  const ext = extname(filePath).toLowerCase();
  if (ext && EXTENSION_LANGUAGE_MAP[ext]) {
    return EXTENSION_LANGUAGE_MAP[ext];
  }
  // Check for special filenames
  const base = filePath.split("/").pop() ?? "";
  if (base === "Dockerfile" || base.startsWith("Dockerfile.")) return "dockerfile";
  if (base === "Makefile" || base === "GNUmakefile") return "makefile";
  return undefined;
}

// --- Binary detection ---

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".svg", ".webp", ".avif",
  ".mp3", ".mp4", ".avi", ".mov", ".mkv", ".flv", ".wmv", ".wav", ".ogg", ".flac",
  ".zip", ".gz", ".tar", ".bz2", ".7z", ".rar", ".xz", ".zst",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".exe", ".dll", ".so", ".dylib", ".a", ".o", ".obj", ".lib",
  ".wasm", ".class", ".pyc", ".pyo",
  ".ttf", ".otf", ".woff", ".woff2", ".eot",
  ".sqlite", ".db", ".sqlite3",
  ".bin", ".dat", ".iso", ".img",
  ".node", ".map",
]);

function isBinaryExtension(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

function isBinaryContent(buffer: Buffer): boolean {
  // Check first 8KB for null bytes (common binary indicator)
  const checkLength = Math.min(buffer.length, 8192);
  for (let i = 0; i < checkLength; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

// --- Hashing ---

export function hashContent(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

// --- Scanner ---

export async function scanRepository(
  repoPath: string,
  config: ScannerConfig,
): Promise<ScanResult> {
  const absoluteRoot = resolve(repoPath);
  const maxFileSize = config.max_file_size;
  const excludePatterns = config.exclude;

  // Use fast-glob to find all files, respecting .gitignore
  const entries = await fg("**/*", {
    cwd: absoluteRoot,
    dot: false,
    onlyFiles: true,
    followSymbolicLinks: false,
    ignore: excludePatterns,
    absolute: true,
    suppressErrors: true,
    concurrency: 64,
  });

  const files: ScannedFile[] = [];
  let totalSize = 0;

  for (const absolutePath of entries) {
    // Skip binary files by extension
    if (isBinaryExtension(absolutePath)) continue;

    // Check file size
    let stat;
    try {
      stat = statSync(absolutePath);
    } catch {
      continue; // skip files we can't stat
    }

    if (stat.size > maxFileSize) continue;
    if (stat.size === 0) continue;

    // Read file content
    let content: Buffer;
    try {
      content = readFileSync(absolutePath);
    } catch {
      continue; // skip files we can't read
    }

    // Skip binary content (null bytes check)
    if (isBinaryContent(content)) continue;

    const relPath = relative(absoluteRoot, absolutePath);
    const hash = hashContent(content);
    const language = detectLanguage(relPath);

    files.push({
      path: relPath,
      absolutePath,
      hash,
      size: stat.size,
      language,
    });

    totalSize += stat.size;
  }

  // Sort by path for deterministic output
  files.sort((a, b) => a.path.localeCompare(b.path));

  return {
    files,
    repoRoot: absoluteRoot,
    totalSize,
  };
}
