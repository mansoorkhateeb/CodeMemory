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
- **Phase 1 — Ingestion pipeline + RAPTOR tree (complete, 2026-02):**
  `POST /api/index`, `GET /api/index/status`, `GET /api/tree`. Recursive GitHub
  fetch (git trees + blobs, retry-after aware), token-capped chunkers,
  hierarchical KMeans + gpt-5 summaries, atomic tree swap via `os.replace`.
- **Phase 2 — Retrieval + `/api/query` (complete, 2026-02):**
  Token-aware RAPTOR retrieval + gpt-5 answer.
  - Embed query → Chroma top-N across ALL levels (chunks + summary embeddings).
  - Score = similarity + level-mix bonus (subsystem +0.05, topic +0.03).
  - Greedy pack under `token_budget` with **guarantee**: ≥1 subsystem + ≥2 topics
    (parents pulled from the tree if search didn't surface them).
  - Edge cases: `budget=0` → structured "too small" response (HTTP 200);
    no index yet → structured "no repository indexed" response (HTTP 200).
  - Context wrapped in explicit `<<<REPOSITORY_CONTEXT_START/END>>>` delimiters
    so prompt-injection content in PR/issue bodies is unmistakably DATA.
  - `naive_baseline_tokens` = sum of tiktokens of every PR chunk (desc+diff)
    in the tree — "if you'd naively dumped every PR as context" upper bound.
  - Frontend: query textarea + budget input + stats strip
    (tokens packed / naive baseline / **saved-vs-naive %** / paths cited)
    + answer viewer + collapsible node-paths list.
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
- **P0:** authenticated real-repo happy-path run (needs GITHUB_TOKEN — user's PAT or env).
- **P1:** re-run silhouette-based k-selection instead of hard heuristics.
- **P1:** persistent per-repo status history so a page reload knows what was indexed.
- **P2:** Chrome extension MVP (send selected code + open file + `/api/query`).
- **P2:** LLM-in-the-loop artifact summaries (currently artifacts have no summary to save cost).
- **P3:** rate limiting, per-user isolation, background workers/queues.
