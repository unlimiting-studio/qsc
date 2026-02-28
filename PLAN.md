# QSC (Query Source Code) - 구현 계획서

## 목표 개요

소스코드 리포지토리를 AST 기반으로 chunk/embed하여 SQLite에 저장하고, AI 에이전트들이 하이브리드 검색(BM25+Vector+LLM 리랭킹)으로 코드를 탐색할 수 있게 하는 CLI+MCP 도구.

## 해결하고자 하는 문제 (니즈)

- AI 에이전트가 대규모 코드베이스를 효율적으로 탐색해야 함
- k8s ephemeral disk 환경에서 에이전트가 소스코드를 클론 받고, 사전 구축된 임베딩 DB를 활용해야 함
- 코드 변경 시 전체 재인덱싱 없이 증분 업데이트가 필요함
- 단순 키워드 검색이 아닌 시맨틱 검색이 필요함

### 현 상태

- tobi/qmd는 마크다운 문서에 최적화되어 있어 소스코드에 직접 사용하기 어려움
- 소스코드는 마크다운과 달리 AST 구조가 있어 의미 단위(함수, 클래스, 모듈) 분할이 가능하고 이를 활용해야 검색 품질이 높음

## 솔루션 (목표)

tobi/qmd의 아키텍처를 참고하되, 소스코드에 최적화된 새로운 도구 QSC를 구현한다:
- tree-sitter 기반 AST chunking (지원 언어: JS/TS, Python, Go, Dart, Kotlin, Swift)
- 플러그인 방식 임베딩/LLM (로컬 모델, API 모두 지원)
- BM25 + Vector + LLM 리랭킹 풀 하이브리드 검색
- CLI + MCP 서버 인터페이스
- SHA-256 해싱 기반 증분 인덱싱
- SQLite 단일 파일 DB (S3 전송에 용이)

## 비목표 - 하면 안 되는 것

- S3 연동 직접 구현 (외부 스크립트가 담당)
- 특정 임베딩/LLM 모델에 하드코딩 의존
- 코드 실행이나 컴파일 기능
- IDE 플러그인
- 사용자 인증/권한 관리

## 비목표 - 범위 밖 (향후 가능)

- Fine-tuning 파이프라인 (qmd에 있는 기능)
- 코드 수정/리팩토링 제안 기능
- 크로스-리포지토리 검색
- 웹 UI
- 의존성 그래프 분석

## 확정된 주요 의사결정 사항

1. **TypeScript** 기반, Node.js/Bun 런타임
2. **tree-sitter** AST 파싱 (JS/TS, Python, Go, Dart, Kotlin, Swift) + 토큰 기반 fallback
3. **플러그인 아키텍처**: 임베딩 제공자와 LLM 제공자를 설정으로 교체 가능
4. **SQLite + FTS5 + sqlite-vec**: qmd와 동일한 데이터 스토리지
5. **CLI + MCP**: 두 가지 인터페이스 동시 제공
6. **리포지토리 단위 DB**: 각 리포지토리마다 독립적인 SQLite DB 파일
7. **Git 활용 증분 인덱싱**: git diff로 변경 파일 감지

## 상세 실행 계획

### 작업 1: 프로젝트 스캐폴딩 및 기본 인프라
**의존관계**: 없음

- package.json, tsconfig.json 초기 설정
- 핵심 의존성 설치: better-sqlite3, sqlite-vec, tree-sitter, @modelcontextprotocol/sdk, zod, yaml
- 프로젝트 디렉토리 구조 생성
- 빌드/실행 스크립트 설정

```
src/
├── index.ts          # CLI 진입점
├── mcp.ts            # MCP 서버
├── store.ts          # 데이터베이스 추상화 (핵심)
├── chunker/
│   ├── index.ts      # Chunker 인터페이스 및 팩토리
│   ├── ast.ts        # tree-sitter AST 기반 chunker
│   ├── token.ts      # 토큰 기반 fallback chunker
│   └── languages/    # 언어별 tree-sitter 쿼리/설정
│       ├── index.ts
│       ├── typescript.ts
│       ├── python.ts
│       ├── go.ts
│       ├── dart.ts
│       ├── kotlin.ts
│       └── swift.ts
├── embedder/
│   ├── index.ts      # Embedder 인터페이스 및 팩토리
│   ├── openai.ts     # OpenAI API 제공자
│   └── local.ts      # 로컬 모델 제공자 (node-llama-cpp)
├── llm/
│   ├── index.ts      # LLM 인터페이스 및 팩토리
│   ├── openai.ts     # OpenAI API 제공자
│   └── local.ts      # 로컬 모델 제공자
├── search/
│   ├── index.ts      # 검색 파이프라인 오케스트레이터
│   ├── bm25.ts       # FTS5 BM25 검색
│   ├── vector.ts     # sqlite-vec 벡터 검색
│   ├── reranker.ts   # LLM 리랭커
│   ├── expander.ts   # 쿼리 확장
│   └── fusion.ts     # RRF (Reciprocal Rank Fusion)
├── scanner/
│   ├── index.ts      # 파일 스캐너
│   └── git.ts        # Git 변경 감지
└── config/
    └── index.ts      # 설정 관리
```

### 작업 2: Store 모듈 - SQLite 스키마 및 데이터베이스 추상화
**의존관계**: 작업 1

SQLite 스키마 설계 및 `createStore()` 팩토리 구현:

```sql
-- 리포지토리 메타데이터
CREATE TABLE repositories (
  id TEXT PRIMARY KEY,        -- repo 식별자 (e.g., "org/repo")
  path TEXT NOT NULL,         -- 로컬 경로
  last_commit TEXT,           -- 마지막 인덱싱된 커밋 해시
  indexed_at TEXT,            -- 마지막 인덱싱 시간
  config TEXT                 -- JSON: 설정 오버라이드
);

-- 파일 메타데이터
CREATE TABLE files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  path TEXT NOT NULL,          -- 파일 상대 경로
  hash TEXT NOT NULL,          -- SHA-256 content hash
  language TEXT,               -- 감지된 프로그래밍 언어
  active INTEGER DEFAULT 1,   -- 파일 존재 여부
  indexed_at TEXT,
  UNIQUE(repo_id, path)
);

-- 청크 데이터
CREATE TABLE chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES files(id),
  hash TEXT NOT NULL,          -- 청크 content hash
  seq INTEGER NOT NULL,        -- 파일 내 순서
  start_line INTEGER,          -- 시작 라인
  end_line INTEGER,            -- 끝 라인
  chunk_type TEXT,             -- function, class, module, block, etc.
  name TEXT,                   -- 함수/클래스명 (AST에서 추출)
  content TEXT NOT NULL,       -- 청크 원본 텍스트
  metadata TEXT,               -- JSON: 추가 AST 메타데이터
  UNIQUE(file_id, seq)
);

-- FTS5 전문검색 인덱스
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  content,
  name,
  content=chunks,
  content_rowid=id
);

-- 벡터 임베딩 메타데이터
CREATE TABLE chunk_vectors (
  chunk_id INTEGER PRIMARY KEY REFERENCES chunks(id),
  model TEXT NOT NULL,         -- 사용된 임베딩 모델
  embedded_at TEXT
);

-- sqlite-vec 벡터 테이블 (차원은 설정에 따라)
CREATE VIRTUAL TABLE vectors_vec USING vec0(
  chunk_id INTEGER PRIMARY KEY,
  embedding float[768]         -- 차원은 모델에 따라 변경
);
```

Store 인터페이스:
- `initDb()`: DB 초기화 및 마이그레이션
- `upsertFile()`: 파일 메타데이터 upsert
- `insertChunks()`: 청크 배치 삽입
- `getUnembeddedChunks()`: 임베딩 안 된 청크 조회
- `insertEmbeddings()`: 벡터 배치 삽입
- `searchBM25()`: FTS5 검색
- `searchVector()`: 벡터 유사도 검색
- `deactivateFiles()`: 삭제된 파일 비활성화
- `cleanup()`: 고아 데이터 정리

### 작업 3: Chunker 모듈 - AST 기반 소스코드 분할
**의존관계**: 작업 1

- tree-sitter 기반 AST chunker 구현
  - 각 언어별 tree-sitter 문법과 노드 타입 매핑
  - 함수, 클래스, 메서드, 인터페이스, 모듈 단위 분할
  - 너무 큰 노드는 하위 노드로 재분할
  - 너무 작은 인접 노드는 병합
  - 임포트/상수 등 상단 선언부는 컨텍스트로 포함
- 토큰 기반 fallback chunker 구현
  - qmd의 토큰 분할 로직 참고
  - 코드 블록(들여쓰기, 중괄호) 경계 존중
- Chunker 인터페이스 및 팩토리
  - 파일 확장자 → 언어 감지 → 적절한 chunker 선택
- 언어별 설정 파일
  - 각 언어별로 어떤 AST 노드를 청크 단위로 할지 정의
  - 새 언어 추가가 설정 파일 추가만으로 가능하도록

### 작업 4: Embedder 모듈 - 플러그인 임베딩 시스템
**의존관계**: 작업 1

- Embedder 인터페이스 정의
  ```typescript
  interface Embedder {
    embed(texts: string[]): Promise<number[][]>;
    readonly dimensions: number;
    readonly modelName: string;
  }
  ```
- OpenAI 제공자 구현
  - text-embedding-3-small (1536차원) / text-embedding-3-large (3072차원)
  - 배치 처리, rate limiting 대응
- 로컬 모델 제공자 구현
  - node-llama-cpp 기반
  - GGUF 모델 로딩 (embeddinggemma 등)
- 팩토리 함수: 설정 기반 제공자 선택
- 벡터 차원이 모델마다 다르므로 DB 스키마에서 이를 처리

### 작업 5: 검색 파이프라인 - BM25 + Vector + LLM 하이브리드
**의존관계**: 작업 2, 작업 4

- BM25 검색: FTS5 쿼리 실행
- Vector 검색: sqlite-vec cosine distance 쿼리
- RRF (Reciprocal Rank Fusion): 두 결과 합산
- 쿼리 확장: LLM으로 원본 쿼리를 lexical/vector/HyDE 변환
- LLM 리랭커: 후보 청크들을 LLM으로 relevance 재점수
- LLM 인터페이스 (플러그인)
  ```typescript
  interface LLMProvider {
    generate(prompt: string, options?: GenerateOptions): Promise<string>;
    rerank(query: string, documents: string[]): Promise<number[]>;
  }
  ```
- OpenAI / 로컬 모델 제공자

### 작업 6: Scanner 모듈 - 파일 스캐닝 및 Git 변경 감지
**의존관계**: 작업 1

- 파일 시스템 스캐닝
  - .gitignore 존중
  - 바이너리 파일 제외
  - 설정 가능한 파일 크기 제한
  - glob 패턴 기반 포함/제외
- Git 변경 감지
  - `git diff --name-status <last_commit>..HEAD`로 변경 파일 파악
  - 새 파일, 수정된 파일, 삭제된 파일 분류
  - last_commit이 없으면 전체 인덱싱
- SHA-256 해싱으로 파일 변경 여부 이중 확인

### 작업 7: CLI 구현
**의존관계**: 작업 2, 3, 4, 5, 6

CLI 명령어:
- `qsc init [path]` - 리포지토리 초기화 (DB 생성)
- `qsc index [path]` - 소스코드 인덱싱 (scan → chunk → FTS 저장)
- `qsc embed` - 벡터 임베딩 생성 (미임베딩 청크 대상)
- `qsc update` - 증분 업데이트 (변경 감지 → 재인덱싱 → 재임베딩)
- `qsc search <query>` - BM25 전문검색
- `qsc query <query>` - 풀 하이브리드 검색 (BM25 + Vector + 리랭킹)
- `qsc get <file-path>` - 파일/청크 조회
- `qsc status` - 인덱스 상태 확인
- `qsc config` - 설정 관리

### 작업 8: MCP 서버 구현
**의존관계**: 작업 7

- stdio 및 HTTP 트랜스포트 지원
- MCP 도구 등록:
  - `search`: BM25 검색
  - `query`: 풀 하이브리드 검색
  - `get_file`: 파일 원본 조회
  - `get_chunk`: 특정 청크 조회
  - `status`: 인덱스 상태
- 리소스 템플릿: `qsc://{repo}/{path}`
- 에러 핸들링 및 타임아웃

### 작업 9: 설정 시스템
**의존관계**: 작업 1

- YAML 기반 설정 파일 (`qsc.yml`)
  ```yaml
  embedder:
    provider: openai  # or local
    model: text-embedding-3-small
    api_key_env: OPENAI_API_KEY  # 환경변수명

  llm:
    provider: openai
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
    max_file_size: 1048576  # 1MB
  ```
- 환경변수 오버라이드 지원
- CLI 인자 오버라이드 지원

### 작업 10: 테스트 및 통합 검증
**의존관계**: 작업 7, 8

- 단위 테스트
  - Chunker: 각 언어별 AST 분할 정확성
  - Store: CRUD, FTS, 벡터 검색
  - Embedder: 제공자 팩토리, 배치 처리
  - Scanner: 파일 스캐닝, git 변경 감지
- 통합 테스트
  - 전체 파이프라인: index → embed → query
  - 증분 업데이트 시나리오
  - MCP 서버 프로토콜 준수
- 실제 리포지토리로 E2E 테스트

## 상세 검증 계획

### V1: 빌드 검증
- TypeScript 컴파일 오류 없음
- 모든 의존성 정상 설치
- CLI 진입점 실행 가능

### V2: Chunker 검증
- 각 지원 언어(JS/TS, Python, Go, Dart, Kotlin, Swift)에 대해:
  - 함수/클래스 단위로 정확히 분할되는지
  - 너무 큰 함수는 하위 분할되는지
  - 작은 인접 선언은 병합되는지
- 지원하지 않는 언어 파일은 토큰 기반 fallback으로 처리되는지

### V3: Store 검증
- DB 초기화 및 마이그레이션 정상 동작
- 파일/청크 CRUD 동작
- FTS5 검색 결과 정확성
- 벡터 검색 결과 정확성 (cosine similarity)
- 증분 인덱싱 시 변경분만 처리되는지

### V4: 검색 파이프라인 검증
- BM25 단독 검색 정상 동작
- Vector 단독 검색 정상 동작
- RRF 합산 정상 동작
- 쿼리 확장 정상 동작
- LLM 리랭킹 정상 동작
- 최종 하이브리드 검색 결과 품질

### V5: CLI 검증
- 모든 CLI 명령어가 정상 동작
- 에러 상황 처리 (DB 없음, 파일 없음, API 키 없음 등)

### V6: MCP 검증
- stdio 트랜스포트 정상 동작
- 모든 MCP 도구 정상 동작
- MCP 프로토콜 스펙 준수

### V7: 증분 업데이트 검증
- 파일 추가 → 해당 파일만 인덱싱
- 파일 수정 → 해당 파일만 재인덱싱
- 파일 삭제 → 해당 파일 비활성화 + 고아 데이터 정리
- 커밋 해시 기반 변경 감지 정상 동작
