# QSC

AST 기반 코드 검색 -- BM25 + Vector + LLM 리랭킹 하이브리드 검색.

[English](README.md)

[qmd](https://github.com/tobi/qmd)에서 영감을 받아, tree-sitter AST 기반 청킹과 벡터 임베딩, 하이브리드 검색을 소스 코드에 적용한 도구입니다.

## 개요

QSC는 tree-sitter AST 파싱을 활용하여 소스 코드를 의미 단위로 분할하고, FTS5 및 벡터 인덱스가 적용된 SQLite에 저장한 뒤, BM25 키워드 매칭, 벡터 유사도, LLM 리랭킹을 결합한 하이브리드 검색을 제공합니다. 모든 데이터는 `~/.qsc/`에 저장되며, 소스 디렉터리는 변경되지 않습니다.

## 설치

```
npm install -g @unlimiting/qsc
```

Node.js >= 20이 필요합니다.

## 빠른 시작

```bash
qsc init my-project /path/to/repo          # 컬렉션 생성
qsc index my-project                        # 스캔 + AST 청킹 + 저장
qsc embed my-project                        # 벡터 임베딩 (OPENAI_API_KEY 필요)
qsc search my-project "createUser function" # BM25 키워드 검색
qsc query my-project "how does auth work"   # 하이브리드 검색
```

## CLI 레퍼런스

### 인덱싱

| 명령어 | 설명 |
|---------|------|
| `init <name> <path> [--update-cmd <cmd>]` | `<path>` 경로의 소스에 대한 컬렉션 생성 |
| `index <name> [--rebuild]` | 소스 코드 인덱싱 (스캔, 청킹, 저장). `--rebuild`는 모든 데이터를 먼저 초기화 |
| `embed <name> [--batch <n>] [--rebuild]` | 벡터 임베딩 생성. `--rebuild`는 벡터를 먼저 초기화 |
| `update <name>` | 증분 업데이트: 사전 업데이트 명령 실행, 변경 감지 (git 최적화 또는 해시 기반), 재인덱싱, 자동 임베딩 |

### 검색

| 명령어 | 설명 |
|---------|------|
| `search <name> <query> [--limit <n>] [--benchmark]` | BM25 전문 검색. API 키 불필요 |
| `query <name> <query> [--limit <n>] [--no-expand] [--no-rerank] [--benchmark]` | 하이브리드 검색 (BM25 + vector + RRF + LLM). 임베더가 없으면 BM25로 폴백 |

#### 인라인 필터

쿼리 내에서 경로, 확장자, 파일명으로 결과를 필터링할 수 있습니다. 같은 타입의 포함 조건은 OR로, 다른 타입 간에는 AND로 결합됩니다.

```bash
qsc query my-project "auth path:src ext:.ts"            # src/**/*.ts만 포함
qsc query my-project "auth -path:vendor -ext:.test.ts"  # vendor와 테스트 제외
qsc query my-project "db path:src/api path:src/core"    # src/api 또는 src/core
qsc search my-project "config -file:package.json"       # 특정 파일 제외
```

| 필터 | 포함 | 제외 |
|------|------|------|
| 경로 | `path:src/api` | `-path:vendor` |
| 확장자 | `ext:.ts` | `-ext:.test.ts` |
| 파일 | `file:config.ts` | `-file:package.json` |

#### 옵션

| 플래그 | 설명 |
|--------|------|
| `--limit <n>` | 최대 결과 수 (기본값: 10) |
| `--no-expand` | LLM 쿼리 확장 비활성화 |
| `--no-rerank` | LLM 리랭킹 비활성화 |
| `--benchmark` | 단계별 소요 시간 출력 |

### 조회

| 명령어 | 설명 |
|---------|------|
| `get <name> <file-path>` | 파일 메타데이터 및 청크 조회 |
| `status <name>` | 인덱스 통계 |
| `config` | 현재 설정 출력 |

### 컬렉션 관리

| 명령어 | 설명 |
|---------|------|
| `list` | 모든 컬렉션 목록 |
| `set-update-cmd <name> <command>` | 사전 업데이트 명령 설정 (예: `git pull`). 명령을 생략하면 제거 |
| `copy <source> <dest> <path>` | 새 소스 경로로 컬렉션 DB 복사 |
| `import <name> <sqlite-path> <source-path>` | 외부 SQLite DB를 컬렉션으로 가져오기 |
| `export <name> <output-path>` | 컬렉션 DB 내보내기 |

### MCP 서버

```bash
qsc mcp --collection my-project
```

제공 도구: `search`, `query`, `get_file`, `get_chunk`, `status`

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

또는 환경변수를 통해 설정:

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

## 설정

모든 데이터는 `~/.qsc/` 하위에 저장됩니다:

```
~/.qsc/
  config.yml                    # 전역 기본값
  collections.json              # 컬렉션 레지스트리
  collections/
    <name>.sqlite               # 데이터베이스
    <name>.yml                  # 컬렉션별 오버라이드
```

우선순위: `~/.qsc/config.yml` < `~/.qsc/collections/<name>.yml` < 환경변수

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

### 환경변수

| 변수 | 오버라이드 대상 |
|------|----------------|
| `QSC_COLLECTION` | MCP 서버의 기본 컬렉션 |
| `QSC_EMBEDDER_PROVIDER` | `embedder.provider` |
| `QSC_EMBEDDER_MODEL` | `embedder.model` |
| `QSC_EMBEDDER_DIMENSIONS` | `embedder.dimensions` |
| `QSC_LLM_PROVIDER` | `llm.provider` |
| `QSC_LLM_MODEL` | `llm.model` |
| `QSC_CHUNKER_MAX_TOKENS` | `chunker.max_tokens` |
| `QSC_CHUNKER_OVERLAP` | `chunker.overlap` |
| `QSC_SCANNER_MAX_FILE_SIZE` | `scanner.max_file_size` |

## 지원 언어

AST 청킹 (tree-sitter): TypeScript, TSX/JSX, JavaScript, Python, Go, Dart, Kotlin, Swift.

그 외 모든 파일 타입은 토큰 기반 폴백 청킹을 사용합니다.

## 라이선스

MIT
