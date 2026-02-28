import { execSync } from "node:child_process";
import { resolve } from "node:path";

// --- Interfaces ---

export interface GitChange {
  status: "added" | "modified" | "deleted" | "renamed";
  path: string;
  oldPath?: string; // only for renamed
}

export interface GitInfo {
  currentCommit: string;
  changes: GitChange[];
  isFullScan: boolean; // true when lastCommit is not provided
}

// --- Helpers ---

function execGit(args: string, cwd: string): string {
  try {
    return execSync(`git ${args}`, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30_000,
    }).trim();
  } catch (error) {
    const err = error as { status?: number; stderr?: string; message?: string };
    if (err.stderr?.includes("not a git repository")) {
      throw new Error(`Not a git repository: ${cwd}`);
    }
    if (err.message?.includes("ENOENT")) {
      throw new Error("git is not installed or not found in PATH");
    }
    throw new Error(`git command failed: git ${args}\n${err.stderr ?? err.message}`);
  }
}

function parseStatusCode(code: string): GitChange["status"] {
  switch (code[0]) {
    case "A":
      return "added";
    case "M":
      return "modified";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    default:
      return "modified"; // treat unknown as modified
  }
}

function isValidCommitHash(value: string): boolean {
  return /^[0-9a-f]{4,40}$/i.test(value);
}

// --- Public API ---

/**
 * Get the current HEAD commit hash.
 * Throws if the directory is not a git repository or has no commits.
 */
export function getCurrentCommit(repoPath: string): string {
  const cwd = resolve(repoPath);
  return execGit("rev-parse HEAD", cwd);
}

/**
 * Check if a path is inside a git repository.
 */
export function isGitRepository(repoPath: string): boolean {
  try {
    const cwd = resolve(repoPath);
    execGit("rev-parse --git-dir", cwd);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect file changes between lastCommit and HEAD.
 * If lastCommit is not provided, returns isFullScan=true with no change list
 * (caller should do a full repository scan instead).
 */
export function detectChanges(
  repoPath: string,
  lastCommit?: string,
): GitInfo {
  const cwd = resolve(repoPath);
  const currentCommit = getCurrentCommit(cwd);

  if (!lastCommit) {
    return {
      currentCommit,
      changes: [],
      isFullScan: true,
    };
  }

  // Validate commit hash format to prevent command injection
  if (!isValidCommitHash(lastCommit)) {
    return {
      currentCommit,
      changes: [],
      isFullScan: true,
    };
  }

  // Verify lastCommit exists
  try {
    execGit(`cat-file -t ${lastCommit}`, cwd);
  } catch {
    // If lastCommit is not valid, fall back to full scan
    return {
      currentCommit,
      changes: [],
      isFullScan: true,
    };
  }

  // Get diff between lastCommit and HEAD
  const output = execGit(
    `diff --name-status ${lastCommit}..${currentCommit}`,
    cwd,
  );

  if (!output) {
    return {
      currentCommit,
      changes: [],
      isFullScan: false,
    };
  }

  const changes: GitChange[] = [];

  for (const line of output.split("\n")) {
    if (!line.trim()) continue;

    const parts = line.split("\t");
    const statusCode = parts[0];

    if (statusCode.startsWith("R")) {
      // Renamed: R100\toldPath\tnewPath
      changes.push({
        status: "renamed",
        path: parts[2],
        oldPath: parts[1],
      });
    } else {
      changes.push({
        status: parseStatusCode(statusCode),
        path: parts[1],
      });
    }
  }

  return {
    currentCommit,
    changes,
    isFullScan: false,
  };
}
