# QSC

AST-based code search with hybrid BM25 + Vector + LLM reranking.

[한국어](README_ko.md)

Inspired by [qmd](https://github.com/tobi/qmd) — adapted for source code with AST-aware chunking, vector embeddings, and hybrid search.

## What it does

QSC chunks source code into semantically meaningful units using tree-sitter AST parsing, stores them in SQLite with FTS5 and vector indexes, and provides hybrid search combining BM25 keyword matching, vector similarity, and LLM reranking. All data lives in `~/.qsc/` — your source directories stay untouched.

## Install

```
npm install -g @unlimiting/qsc
```

Requires Node.js >= 20.

## Quick Start

```bash
qsc init my-project /path/to/repo          # create collection
qsc index my-project                        # scan + AST chunk + store
qsc embed my-project                        # vector embeddings (needs OPENAI_API_KEY)
qsc search my-project "createUser function" # BM25 keyword search
qsc query my-project "how does auth work"   # hybrid search
```

## CLI Reference

### Indexing

| Command | Description |
|---------|-------------|
| `init <name> <path> [--update-cmd <cmd>]` | Create a collection for the source at `<path>` |
| `index <name> [--rebuild]` | Index source code (scan, chunk, store). `--rebuild` clears all data first |
| `embed <name> [--batch <n>] [--rebuild]` | Generate vector embeddings. `--rebuild` clears vectors first |
| `update <name>` | Incremental update: runs pre-update command, detects changes (git-optimized or hash-based), re-indexes, and auto-embeds |

### Searching

| Command | Description |
|---------|-------------|
| `search <name> <query> [--limit <n>] [--benchmark]` | BM25 full-text search. No API key required |
| `query <name> <query> [--limit <n>] [--no-expand] [--no-rerank] [--benchmark]` | Hybrid search (BM25 + vector + RRF + LLM). Falls back to BM25 if no embedder |

#### Inline filters

Filter results by path, extension, or filename directly in the query. Same-type includes are OR, cross-type are AND.

```bash
qsc query my-project "auth path:src ext:.ts"            # src/**/*.ts only
qsc query my-project "auth -path:vendor -ext:.test.ts"  # exclude vendor and tests
qsc query my-project "db path:src/api path:src/core"    # src/api OR src/core
qsc search my-project "config -file:package.json"       # exclude specific file
```

| Filter | Include | Exclude |
|--------|---------|---------|
| Path | `path:src/api` | `-path:vendor` |
| Extension | `ext:.ts` | `-ext:.test.ts` |
| File | `file:config.ts` | `-file:package.json` |

#### Options

| Flag | Description |
|------|-------------|
| `--limit <n>` | Max results (default: 10) |
| `--no-expand` | Disable LLM query expansion |
| `--no-rerank` | Disable LLM reranking |
| `--benchmark` | Print per-stage timing |

### Inspection

| Command | Description |
|---------|-------------|
| `get <name> <file-path>` | Show file metadata and chunks |
| `status <name>` | Index statistics |
| `config` | Print current configuration |

### Collection Management

| Command | Description |
|---------|-------------|
| `list` | List all collections |
| `set-update-cmd <name> <command>` | Set pre-update command (e.g., `git pull`). Omit command to remove |
| `copy <source> <dest> <path>` | Copy collection DB with new source path |
| `import <name> <sqlite-path> <source-path>` | Import external SQLite DB as collection |
| `export <name> <output-path>` | Export collection DB |

### MCP Server

```bash
qsc mcp --collection my-project
```

Tools: `search`, `query`, `get_file`, `get_chunk`, `status`

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

Or via environment variable:

```json
{
  "mcpServers": {
    "qsc": {
      "command": "qsc",
      "args": ["mcp"],
      "env": { "QSC_COLLECTION": "my-project" }
    }
  }
}
```

## Configuration

All data lives under `~/.qsc/`:

```
~/.qsc/
  config.yml                    # global defaults
  collections.json              # collection registry
  collections/
    <name>.sqlite               # database
    <name>.yml                  # per-collection overrides
```

Priority: `~/.qsc/config.yml` < `~/.qsc/collections/<name>.yml` < environment variables

```yaml
embedder:
  provider: openai              # openai | local
  model: text-embedding-3-small
  api_key_env: OPENAI_API_KEY
  dimensions: 1536

llm:
  provider: openai
  model: gpt-5-nano
  api_key_env: OPENAI_API_KEY

chunker:
  max_tokens: 900
  overlap: 0.15

scanner:
  exclude:
    - "node_modules/**"
    - ".git/**"
    - "dist/**"
    - "build/**"
    - "vendor/**"
    - "*.min.js"
    - "*.lock"
  max_file_size: 1048576        # 1MB
```

### Environment variables

| Variable | Overrides |
|----------|-----------|
| `QSC_COLLECTION` | Default collection for MCP server |
| `QSC_EMBEDDER_PROVIDER` | `embedder.provider` |
| `QSC_EMBEDDER_MODEL` | `embedder.model` |
| `QSC_EMBEDDER_DIMENSIONS` | `embedder.dimensions` |
| `QSC_LLM_PROVIDER` | `llm.provider` |
| `QSC_LLM_MODEL` | `llm.model` |
| `QSC_CHUNKER_MAX_TOKENS` | `chunker.max_tokens` |
| `QSC_CHUNKER_OVERLAP` | `chunker.overlap` |
| `QSC_SCANNER_MAX_FILE_SIZE` | `scanner.max_file_size` |

## Supported Languages

AST chunking (tree-sitter): TypeScript, TSX/JSX, JavaScript, Python, Go, Dart, Kotlin, Swift.

All other file types use token-based fallback chunking.

## License

MIT
