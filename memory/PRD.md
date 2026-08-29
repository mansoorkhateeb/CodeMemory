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
- **Phase 0 — Risk POC (complete).**
- **Phase 1 — Ingestion + RAPTOR tree (complete).**
- **Phase 2 — Retrieval + `/api/query` (complete).**
- **Phase 3 — Web UI completion (complete).**
- **Phase 4 — Chrome + VS Code extensions (complete).**
- **Phase 5 — Stress + polish (complete, 2026-02):** 11/11 stress scenarios
  green against the live backend (real gpt-5 / MiniLM / Chroma) plus an
  independent testing_agent pass that surfaced and fixed one HIGH-priority
  frontend race (loadTree stale-response clobber). Final state: **7/7 race
  runs pass, 3/3 UI regressions pass, 25/25 backend pytest pass, 2/2 backend
  spot checks pass, 0 critical / 0 integration issues open.** Full report:
  **`/app/memory/stress_report.md`**.

## Project status: COMPLETE
All acceptance criteria for Phases 0-5 met. Backend, web app, Chrome
extension, and VS Code extension are all built, tested, and packaged.
Deferred polish items are enumerated in the stress report; none are
blocking.
- **Phase 3 — Web UI completion (complete, 2026-02).**
- **Phase 4 — Chrome + VS Code extensions (complete, 2026-02):**
  - `/app/extensions/chrome/` — MV3, vanilla JS. Popup (query + budget + answer/stats/paths), context menu ("Ask CodeMemory about this" on selection → pre-fills popup), options page (backend URL + token + `test connection` + runtime host-permission grant). `host_permissions` restricted to the preview URL; `optional_host_permissions` for other origins granted at runtime via `chrome.permissions.request`. Packaged: **/app/extensions/codememory-chrome.zip** (14 files).
  - `/app/extensions/vscode/` — TypeScript, esbuild bundle, `@vscode/vsce` packaged. Sidebar webview tree, "Ask a question" command → webview panel, status-bar poller (15s, auto-stops after 4 consecutive failures). API token stored in **SecretStorage** only (no plain setting). Packaged: **/app/extensions/codememory-vscode.vsix** (11 files, 18.87 KB).
  - Live-backend verification of both `api.js` / `api.ts` layers: 5/5 scenarios pass (health, unreachable → humanized, bad token → 401, real /api/query round-trip, timeout → humanized).

## Backlog
- **P0:** run first real index against a live public repo with a GitHub PAT (unauth is 60 req/hr; anything > 5 PRs blows past it).
- **P1:** silhouette-based k-selection instead of hard heuristics.
- **P1:** per-repo status history so a page reload knows what was indexed.
- **P2:** artifact-level summaries (currently artifacts have no summary to save LLM cost).
- **P2:** replace placeholder Chrome extension icons with real ones.
- **P3:** rate limiting, per-user isolation, background workers/queues.

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
