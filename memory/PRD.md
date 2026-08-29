# CodeMemory — PRD

## Summary
Hierarchical, token-aware memory layer over a GitHub repo: RAPTOR-style tree
over code / PRs / issues plus token-budgeted multi-hop Q&A. Web-first
(FastAPI + React on the standard platform stack).

Storage:
- **Chroma** persistent local (`/app/backend/data/chroma`) for embeddings.
- **JSON tree store** per repo (`/app/backend/data/trees/{owner}__{repo}.json`)
  with atomic writes for the RAPTOR hierarchy.
- **Mongo is intentionally NOT used** for domain data.

## Phase plan
- **Phase 0 — Risk POC + skeleton (complete, 2026-02):**
  MiniLM → Chroma → KMeans → gpt-5 pipeline verified end-to-end against
  `pallets/itsdangerous`. `/api/poc` (temporary) removed in Phase 1.
- **Phase 1 — Ingestion pipeline + RAPTOR tree (in progress, 2026-02):**
  - `POST /api/index` schedules a background ingest+build.
  - `GET /api/index/status` state machine (idle → indexing → complete/failed).
  - `GET /api/tree?owner=&name=` returns flat `{root_id, nodes}`.
  - GitHub client: recursive code fetch (git trees + blobs), 20 recent merged
    PRs with diff+comments, 20 recent issues with comments.
  - Chunkers: python top-level split (ast) + text fallback; PR desc/diff split;
    all chunks capped in tokens (tiktoken).
  - Tree builder: chunks → topics (KMeans, k=max(2,min(6,n//4)), clamped) →
    subsystems (KMeans, k=max(2,min(4,nt//2)), clamped) → root; every non-leaf
    summary re-embedded and upserted into the same Chroma collection.
  - Atomic re-index: build into a fresh collection, then `os.replace` the tree
    JSON; drop the previous collection only on success. A failed re-index
    leaves the prior tree/collection fully intact.
  - Concurrency guard: second POST → **409**.
  - Frontend: repo form (owner/name/paths + optional GH token), live status
    poller (1.5s), collapsible tree sidebar, detail pane with summary/content/metadata.
- **Phase 2 — Query API:** `/api/query` with token-budgeted multi-hop retrieval
  (tree traversal + Chroma NN), rerank, `QueryResponse.naive_baseline_tokens`.
- **Phase 3 — Product UI + Chrome extension** (CORS already permits `chrome-extension://*`).

## Personas
- Repo maintainer, new contributor, AI copilot integration (extension).

## Core (static) requirements
- Web-first, standard platform stack (FastAPI + React), all backend routes `/api/*`.
- Chroma for vectors; JSON tree store on disk; Mongo not used.
- Single LLM wrapper (`backend/llm.py`) → OpenAI gpt-5 via Emergent Universal Key.
- Bearer-token auth for every non-health endpoint (`CODEMEMORY_API_TOKEN`).
- CORS allows the frontend origin **and** any `chrome-extension://*`.
- No mocked LLM / GitHub calls — everything real.

## Implemented (2026-02)
- `GET /api/health`, bearer-protected `POST /api/index`, `GET /api/index/status`,
  `GET /api/tree`.
- GitHub client: `fetch_code_files`, `fetch_prs_full` (diff + comments),
  `fetch_issues` (with comments). Token via body / env.
- Chunkers: `chunk_code_file` (ast-aware for Python), `chunk_pr`, `chunk_issue`
  — every chunk token-capped, diffs marked `[diff truncated]` when over 3000 tokens.
- Tree builder (`tree_builder.py`) — full RAPTOR pipeline as described above.
- Atomic tree store (`tree_store.py`) — tmp write + `os.replace`.
- Index manager (`index_manager.py`) — background task, concurrency lock, humanized
  error messages, cleanup of partial Chroma collection on failure.
- React dev console — repo form, live status, tree sidebar, detail pane.
- HTML `<title>` set to "CodeMemory".
- `/api/poc` and its UI button removed.

## Backlog
- **P0 (next):** `/api/query` — multi-hop retrieval with tiktoken budget
  and `naive_baseline_tokens` field (Phase 2).
- **P1:** per-topic reranker; smarter cluster count based on silhouette.
- **P1:** persistent per-repo status history so a page reload knows what was indexed.
- **P2:** Chrome extension MVP (send selected code + open file to `/api/query`).
- **P2:** LLM-in-the-loop artifact summaries (currently artifacts have no summary to save cost).
- **P3:** rate limiting, per-user isolation, background workers/queues.
