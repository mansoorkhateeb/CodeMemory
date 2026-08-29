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
- **Phase 0 — Risk POC (complete, 2026-02).**
- **Phase 1 — Ingestion + RAPTOR tree (complete, 2026-02).**
- **Phase 2 — Retrieval + `/api/query` (complete, 2026-02).**
- **Phase 3 — Web UI completion (complete, 2026-02):**
  - Persistent left tree sidebar (sticky, scrollable, colored type badges,
    iterative renderer — no recursive JSX, no babel-traverse stack blowups).
  - Tabbed main area: **Home** (repo form + status + tree stats) · **Query**
    (textarea + budget + savings contrast) · **Detail** (title, summary,
    content, PR#/file/author/merged_at meta strip, raw metadata drawer).
  - Settings popover with the bearer-token input (localStorage; auto-opens
    when the token is empty).
  - Global banners: backend-unreachable, no-token, 401 rejected.
  - Auth probe on token change — `token: ok` / `token: invalid` chip in the
    top bar; every view reacts to a bad token.
  - Loading skeletons for tree + query; every fetch has an explicit timeout
    (6s health / 8s status / 12s tree / 15s index start / 90s query) so no
    infinite spinner is possible.
  - Distinct error states surfaced with `data-testid`s: `banner-backend-down`,
    `banner-no-token`, `banner-auth-error`, `tree-error`, `status-error`,
    `query-error`, `repo-form-error`.
- **Phase 4 — Chrome extension** (CORS already permits `chrome-extension://*`).

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
- **P0:** authenticated real-repo happy-path run (needs GITHUB_TOKEN — user's PAT or env).
- **P1:** re-run silhouette-based k-selection instead of hard heuristics.
- **P1:** persistent per-repo status history so a page reload knows what was indexed.
- **P2:** Chrome extension MVP (send selected code + open file + `/api/query`).
- **P2:** LLM-in-the-loop artifact summaries (currently artifacts have no summary to save cost).
- **P3:** rate limiting, per-user isolation, background workers/queues.
