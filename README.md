# QSC

AST-based code search with hybrid BM25 + Vector + LLM reranking.

## What it does

QSC (Query Source Code) chunks source code into semantically meaningful units using AST parsing, stores them in SQLite with FTS5 and vector indexes, and provides hybrid search that combines BM25 keyword matching, vector similarity, and LLM reranking. All data lives in `~/.qsc/` -- nothing is added to your source directories.

## Install

```
npm install -g @unlimiting/qsc
```

Requires Node.js >= 20.

## Quick Start

```bash
# 1. Create a collection
qsc init my-project /path/to/repo

# 2. Index source code (scan -> AST chunk -> store)
qsc index my-project

# 3. Generate vector embeddings (requires OPENAI_API_KEY)
qsc embed my-project

# 4. Search
qsc search my-project "createUser function"    # BM25 keyword search
qsc query my-project "how does auth work"       # hybrid search
```

## CLI Reference

```
qsc <command> [options]
```

### Indexing

| Command | Description |
|---------|-------------|
| `init <name> <path> [--update-cmd <cmd>]` | Create a collection for the source at `<path>` |
| `index <name>` | Index source code (scan, chunk, store) |
| `embed <name> [--batch <n>]` | Generate vector embeddings for unembedded chunks. Default batch size: 100 |
| `update <name>` | Incremental update with git-optimized diffing when available, hash-based fallback otherwise. Auto-embeds new chunks. Runs `updateCommand` first if configured |

### Searching

| Command | Description |
|---------|-------------|
| `search <name> <query> [--limit <n>] [--benchmark]` | BM25 full-text search. No API key required |
| `query <name> <query> [--limit <n>] [--no-expand] [--no-rerank] [--benchmark]` | Hybrid search (BM25 + vector + RRF fusion + LLM query expansion + LLM reranking). Falls back to BM25 if embedder is unavailable |

**Search/query options:**

| Flag | Description |
|------|-------------|
| `--limit <n>` | Maximum number of results (default: 10) |
| `--no-expand` | Disable LLM query expansion |
| `--no-rerank` | Disable LLM reranking |
| `--benchmark` | Print per-stage timing breakdown |

### Inspection

| Command | Description |
|---------|-------------|
| `get <name> <file-path>` | Show file metadata and chunk list |
| `status <name>` | Show index statistics (files, chunks, embedding progress) |
| `config` | Print current configuration |

### Collection Management

| Command | Description |
|---------|-------------|
| `list` | List all collections |
| `set-update-cmd <name> <command>` | Set a pre-update shell command (e.g., `git pull`). Omit command to remove |
| `copy <source> <dest> <path>` | Copy a collection DB to a new collection with a different source path |
| `import <name> <sqlite-path> <source-path>` | Import an external SQLite DB as a collection |
| `export <name> <output-path>` | Export a collection's SQLite DB |

### Other

| Command | Description |
|---------|-------------|
| `mcp [--collection <name>]` | Start MCP server (stdio transport) |
| `help` | Show help |

## MCP Server

QSC exposes an MCP server with tools: `search`, `query`, `get_file`, `get_chunk`, `status`.

### Claude Code

```json
{
  "mcpServers": {
    "qsc": {
      "command": "qsc",
      "args": ["mcp", "--collection", "my-project"]
    }
  }
}
```

### Claude Desktop

```json
{
  "mcpServers": {
    "qsc": {
      "command": "qsc",
      "args": ["mcp", "--collection", "my-project"]
    }
  }
}
```

You can also set the collection via environment variable instead of `--collection`:

```json
{
  "mcpServers": {
    "qsc": {
      "command": "qsc",
      "args": ["mcp"],
      "env": {
        "QSC_COLLECTION": "my-project"
      }
    }
  }
}
```

## Configuration

### File locations

All QSC data lives under `~/.qsc/`:

```
~/.qsc/
  config.yml                    # Global config
  collections.json              # Collection registry
  collections/
    <name>.sqlite               # SQLite database per collection
    <name>.yml                  # Per-collection config override
```

### Priority (lowest to highest)

1. `~/.qsc/config.yml` -- global defaults
2. `~/.qsc/collections/<name>.yml` -- per-collection overrides
3. Environment variables -- highest priority

### Config schema

```yaml
embedder:
  provider: openai              # openai | local
  model: text-embedding-3-small
  api_key_env: OPENAI_API_KEY
  dimensions: 1536

llm:
  provider: openai              # openai | local
  model: gpt-4o-mini
  api_key_env: OPENAI_API_KEY

chunker:
  max_tokens: 900
  overlap: 0.15

scanner:
  exclude:
    - "node_modules/**"
    - ".git/**"
    - "dist/**"
    - "*.min.js"
  max_file_size: 1048576        # bytes (1 MB)
```

### Environment variables

| Variable | Overrides |
|----------|-----------|
| `QSC_COLLECTION` | Default collection name for MCP server |
| `QSC_EMBEDDER_PROVIDER` | `embedder.provider` |
| `QSC_EMBEDDER_MODEL` | `embedder.model` |
| `QSC_EMBEDDER_API_KEY_ENV` | `embedder.api_key_env` |
| `QSC_EMBEDDER_DIMENSIONS` | `embedder.dimensions` |
| `QSC_LLM_PROVIDER` | `llm.provider` |
| `QSC_LLM_MODEL` | `llm.model` |
| `QSC_LLM_API_KEY_ENV` | `llm.api_key_env` |
| `QSC_CHUNKER_MAX_TOKENS` | `chunker.max_tokens` |
| `QSC_CHUNKER_OVERLAP` | `chunker.overlap` |
| `QSC_SCANNER_MAX_FILE_SIZE` | `scanner.max_file_size` |

## Supported Languages

AST-based chunking (via tree-sitter) is supported for:

- TypeScript (`.ts`)
- TSX / JSX (`.tsx`, `.jsx`)
- JavaScript (`.js`)
- Python (`.py`)
- Go (`.go`)
- Dart (`.dart`)
- Kotlin (`.kt`, `.kts`)
- Swift (`.swift`)

All other file types fall back to token-based chunking, which splits by token count with configurable overlap.

## License

MIT
