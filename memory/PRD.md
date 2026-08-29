# CodeMemory — PRD

## Summary
CodeMemory is a hierarchical, token-aware memory layer over a GitHub repo:
a RAPTOR-style tree over code / PRs / issues plus token-budgeted multi-hop
Q&A. Web-first: FastAPI + React on the standard platform stack.

Storage:
- **Chroma** (persistent local, `/app/backend/data/chroma`) for embeddings.
- JSON/SQLite tree store (future phases) for the RAPTOR hierarchy.
- **Mongo is intentionally NOT used for domain data.**

## Phase plan
- **Phase 0 — Risk POC + skeleton (in progress, 2026-02):**
  - FastAPI skeleton (`/api/health`, bearer-protected `/api/poc`).
  - Emergent Universal LLM key wrapper (`llm.py`, OpenAI gpt-5).
  - MiniLM embeddings → Chroma persistence → KMeans (k=2, clamped) → single-cluster gpt-5 summary.
  - Minimal React "dev console" stub with health indicator + Run POC button.
- **Phase 1 — Ingestion pipeline:** authenticated GitHub client, real chunkers for code / PRs / issues, incremental sync.
- **Phase 2 — RAPTOR tree:** hierarchical clustering + summaries stored in a JSON/SQLite tree store.
- **Phase 3 — Query API:** `/api/index`, `/api/query` with token-budgeted multi-hop retrieval, LLM-in-the-loop reranking.
- **Phase 4 — Product UI + Chrome extension** (chrome-extension origin already permitted by CORS).

## Personas
- **Repo maintainer** — asks "why does this exist? which PR introduced X?".
- **New contributor** — asks "where does auth actually live in this codebase?".
- **AI copilot integration (extension)** — pulls token-budgeted context for a task.

## Core (static) requirements
- Web-first, standard platform stack (FastAPI + React).
- All backend routes prefixed with `/api`.
- Chroma for vectors (never Mongo).
- Single LLM wrapper, swappable — currently OpenAI gpt-5 via Emergent key.
- Bearer-token auth (shared secret in env).
- CORS allows the frontend origin **and** any `chrome-extension://*` origin.
- No mocked LLM / GitHub calls — everything real.

## Implemented (2026-02)
- `GET /api/health` → `{"status":"ok"}`.
- `POST /api/poc` — end-to-end risk chain: GitHub fetch → chunk → embed (MiniLM) → persist to Chroma → KMeans → gpt-5 summary → tiktoken count.
- Bearer auth via `CODEMEMORY_API_TOKEN`.
- CORS w/ frontend origin + `chrome-extension://*` regex.
- OpenAPI at `/api/openapi.json`.
- React dev console (health indicator, token input, Run POC, JSON viewer).

## Backlog
- **P0 (next):** ingestion pipeline (Phase 1) — chunkers for code/PRs/issues, incremental sync, `/api/index`.
- **P1:** RAPTOR tree store (JSON/SQLite), hierarchical clustering + summaries.
- **P1:** `/api/query` multi-hop retrieval with tiktoken budget.
- **P2:** authenticated GitHub client via body/env token.
- **P2:** remove `/api/poc` once real endpoints exist.
- **P2:** Chrome extension MVP.
- **P3:** rate limiting, per-repo isolation, background jobs.
