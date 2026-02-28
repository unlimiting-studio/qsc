---
name: qsc
description: "대규모 코드베이스에서 특정 함수, 클래스, 패턴, 아키텍처를 시맨틱하게 검색해야 할 때. grep이나 파일 탐색만으로는 원하는 코드를 정확히 찾기 어려울 때. 익숙하지 않은 리포지토리의 구조와 구현 방식을 빠르게 파악해야 할 때. AST 기반 코드 청킹과 하이브리드 검색(BM25 + 벡터 + LLM 리랭킹)을 제공하는 소스코드 검색 엔진."
---

# QSC (Query Source Code)

AST 기반 소스코드 청킹 + BM25/벡터/LLM 하이브리드 검색 도구.

## 셋업

### 컬렉션 생성 및 인덱싱

```bash
# 컬렉션 초기화
qsc init <name> <source-path>
qsc init my-project /path/to/repo --update-cmd "git pull"

# 인덱싱 (스캔 -> AST 청킹 -> DB 저장)
qsc index <name>

# 벡터 임베딩 생성 (OPENAI_API_KEY 필요)
qsc embed <name>
qsc embed <name> --batch 200

# 증분 업데이트 (변경 감지 -> 재인덱싱 -> 자동 임베딩)
qsc update <name>
```

### MCP 서버

```json
{
  "mcpServers": {
    "qsc": {
      "command": "qsc",
      "args": ["mcp", "--collection", "<name>"]
    }
  }
}
```

MCP tools: `search`, `query`, `get_file`, `get_chunk`, `status`

## 검색

### BM25 키워드 검색 (`search`)

```bash
qsc search <name> "createUser function"
qsc search <name> "authentication" --limit 20 --benchmark
```

API 키 없이 동작. 키워드 매칭 기반.

### 하이브리드 시맨틱 검색 (`query`)

```bash
qsc query <name> "how does authentication work"
qsc query <name> "error handling" --no-expand --no-rerank
qsc query <name> "REST API endpoints" --limit 5 --benchmark
```

BM25 + 벡터 유사도 + RRF 융합 + LLM 쿼리 확장 + LLM 리랭킹.
임베더 없으면 BM25로 폴백. LLM 없으면 확장/리랭킹 생략.

| 플래그 | 설명 |
|--------|------|
| `--limit <n>` | 최대 결과 수 (기본 10) |
| `--no-expand` | LLM 쿼리 확장 비활성화 |
| `--no-rerank` | LLM 리랭킹 비활성화 |
| `--benchmark` | 단계별 소요 시간 표시 |

### 파일/청크 조회

```bash
qsc get <name> src/index.ts     # 파일 메타 + 청크 목록
qsc status <name>                # 인덱스 통계
```

## 컬렉션 관리

```bash
qsc list                                          # 전체 컬렉션 목록
qsc copy <src> <dest> <new-source-path>           # DB 복사 + 소스 경로 재지정
qsc import <name> <sqlite-path> <source-path>     # 외부 DB 가져오기
qsc export <name> <output-path>                   # DB 내보내기
qsc set-update-cmd <name> "git pull"              # 사전 업데이트 명령 설정
qsc set-update-cmd <name>                         # 사전 업데이트 명령 제거
```

저장 구조:

```
~/.qsc/
  config.yml                    # 글로벌 설정
  collections.json              # 컬렉션 레지스트리
  collections/
    <name>.sqlite               # DB
    <name>.yml                  # 컬렉션별 설정 오버라이드
```

## 설정

우선순위: `~/.qsc/config.yml` < `~/.qsc/collections/<name>.yml` < 환경변수

```yaml
embedder:
  provider: openai              # openai | local
  model: text-embedding-3-small
  api_key_env: OPENAI_API_KEY
  dimensions: 1536

llm:
  provider: openai
  model: gpt-4o-mini
  api_key_env: OPENAI_API_KEY

chunker:
  max_tokens: 900
  overlap: 0.15

scanner:
  exclude: ["node_modules/**", ".git/**", "dist/**", "*.min.js"]
  max_file_size: 1048576        # 1MB
```

환경변수 오버라이드: `QSC_EMBEDDER_PROVIDER`, `QSC_EMBEDDER_MODEL`, `QSC_EMBEDDER_DIMENSIONS`, `QSC_LLM_PROVIDER`, `QSC_LLM_MODEL`, `QSC_CHUNKER_MAX_TOKENS`, `QSC_CHUNKER_OVERLAP`, `QSC_SCANNER_MAX_FILE_SIZE`

## 지원 언어

TypeScript/JavaScript, Python, Go, Dart, Kotlin, Swift — AST 청킹 지원.
그 외 언어는 토큰 기반 폴백 청킹.
