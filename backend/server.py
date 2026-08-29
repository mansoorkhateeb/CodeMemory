"""CodeMemory backend — Phase 1.

Endpoints (all under /api):
    GET  /health              → {"status":"ok"} (no auth)
    POST /index               → schedule background ingestion+tree build (bearer)
    GET  /index/status        → current job status (bearer)
    GET  /tree?owner=&name=   → full tree (flat node map + root id) (bearer)
"""
from __future__ import annotations

import asyncio
import logging
import os
import secrets
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
from fastapi import APIRouter, Depends, FastAPI, HTTPException, Query, status
from fastapi.responses import FileResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from starlette.middleware.cors import CORSMiddleware

import tree_store
import retriever
from index_manager import manager, wire_singletons
from llm import LLMError
from models import (
    IndexRequest,
    IndexStatus,
    QueryRequest,
    QueryResponse,
    TreeNode,
    TreeResponse,
)

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger("codememory")

# --------------------------------------------------------------------------- #
# Heavy singletons (lazy)
# --------------------------------------------------------------------------- #
_embedder = None
_chroma_client = None


def _get_embedder():
    global _embedder
    if _embedder is None:
        from sentence_transformers import SentenceTransformer

        logger.info("Loading sentence-transformer model all-MiniLM-L6-v2 …")
        _embedder = SentenceTransformer("all-MiniLM-L6-v2")
        logger.info("Embedder ready.")
    return _embedder


def _get_chroma():
    global _chroma_client
    if _chroma_client is None:
        import chromadb

        chroma_dir = os.environ.get("CHROMA_DIR", "/app/backend/data/chroma")
        Path(chroma_dir).mkdir(parents=True, exist_ok=True)
        logger.info("Opening Chroma PersistentClient at %s", chroma_dir)
        _chroma_client = chromadb.PersistentClient(path=chroma_dir)
    return _chroma_client


# --------------------------------------------------------------------------- #
# Auth
# --------------------------------------------------------------------------- #
_bearer_scheme = HTTPBearer(auto_error=False)


def require_bearer(
    creds: Optional[HTTPAuthorizationCredentials] = Depends(_bearer_scheme),
) -> str:
    expected = os.environ.get("CODEMEMORY_API_TOKEN")
    if not expected:
        raise HTTPException(status_code=500, detail="CODEMEMORY_API_TOKEN not configured")
    if (
        creds is None
        or creds.scheme.lower() != "bearer"
        or not secrets.compare_digest(creds.credentials, expected)
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing bearer token",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return creds.credentials


# --------------------------------------------------------------------------- #
# App
# --------------------------------------------------------------------------- #
app = FastAPI(
    title="CodeMemory",
    version="0.2.0-phase1",
    openapi_url="/api/openapi.json",
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    description="Hierarchical, token-aware memory over a GitHub repo.",
)

_frontend_origin = os.environ.get("FRONTEND_ORIGIN", "")
_allow_origins = [o for o in [_frontend_origin] if o]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_allow_origins,
    allow_origin_regex=r"^chrome-extension://.*$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

api = APIRouter(prefix="/api")


@app.on_event("startup")
async def _startup() -> None:
    # Preload embedder + chroma so the first /index call isn't cold.
    await asyncio.to_thread(_get_embedder)
    await asyncio.to_thread(_get_chroma)
    wire_singletons(_embedder, _chroma_client)
    retriever.wire(_embedder, _chroma_client)
    logger.info("codememory ready.")


# --------------------------------------------------------------------------- #
# Health
# --------------------------------------------------------------------------- #
@api.get("/health")
async def health() -> dict:
    return {"status": "ok"}


# --------------------------------------------------------------------------- #
# Index
# --------------------------------------------------------------------------- #
@api.post("/index", response_model=IndexStatus, status_code=202)
async def index(
    body: IndexRequest, _token: str = Depends(require_bearer)
) -> IndexStatus:
    """Kick off ingestion + tree build in the background. Returns immediately.

    Returns 202 with the fresh status, or 409 if another index job is running.
    """
    if not body.repo_owner.strip() or not body.repo_name.strip():
        raise HTTPException(status_code=400, detail="repo_owner and repo_name are required")

    try:
        return await manager.start(
            repo_owner=body.repo_owner.strip(),
            repo_name=body.repo_name.strip(),
            paths=[p.strip() for p in (body.paths or []) if p.strip()],
            github_token=body.github_token,
        )
    except RuntimeError as e:
        if str(e) == "indexing_already_in_progress":
            raise HTTPException(
                status_code=409,
                detail="An index job is already running. Poll /api/index/status and retry when idle/complete.",
            ) from e
        raise


@api.get("/index/status", response_model=IndexStatus)
async def index_status(_token: str = Depends(require_bearer)) -> IndexStatus:
    return manager.get_status()


# --------------------------------------------------------------------------- #
# Tree
# --------------------------------------------------------------------------- #
@api.get("/tree", response_model=TreeResponse)
async def tree(
    owner: str = Query(..., description="repo owner"),
    name: str = Query(..., description="repo name"),
    _token: str = Depends(require_bearer),
) -> TreeResponse:
    """Return the persisted tree for a repo.

    Shape: `{root_id, nodes: {id -> TreeNode}, ...}`.
    Consumers descend via `nodes[id].children`.
    Returns `exists=false` (with an empty node map) if this repo has never been indexed.
    """
    data = tree_store.load(owner, name)
    if not data:
        return TreeResponse(repo_owner=owner, repo_name=name, exists=False)

    nodes = {nid: TreeNode(**n) for nid, n in (data.get("nodes") or {}).items()}
    return TreeResponse(
        repo_owner=data.get("repo_owner", owner),
        repo_name=data.get("repo_name", name),
        root_id=data.get("root_id"),
        nodes=nodes,
        exists=True,
    )


# --------------------------------------------------------------------------- #
# Query — token-budgeted RAPTOR retrieval + gpt-5 answer
# --------------------------------------------------------------------------- #
@api.post("/query", response_model=QueryResponse)
async def query_endpoint(
    body: QueryRequest, _token: str = Depends(require_bearer)
) -> QueryResponse:
    """Token-aware multi-hop retrieval over the persisted tree + Chroma.

    Always returns HTTP 200 with a structured `QueryResponse` for the edge
    cases (no repo indexed / budget too small); clients render `answer` as
    the surfacing message and can key off `token_count == 0`.
    Raises 502 if the underlying LLM call fails after a single retry.
    """
    q = (body.query or "").strip()
    if not q:
        raise HTTPException(status_code=400, detail="query is required")
    try:
        return await retriever.answer_query(
            query_text=q,
            token_budget=max(0, int(body.token_budget)),
            repo_owner=body.repo_owner,
            repo_name=body.repo_name,
        )
    except LLMError as e:
        raise HTTPException(status_code=502, detail=f"LLM failed: {e}") from e


# --------------------------------------------------------------------------- #
# Public download routes for the packaged extensions.
# No bearer required — these artifacts contain no secrets.
# --------------------------------------------------------------------------- #
_EXT_DIR = Path("/app/extensions")

def _serve_artifact(filename: str, media_type: str) -> FileResponse:
    fp = _EXT_DIR / filename
    if not fp.exists():
        raise HTTPException(status_code=404, detail=f"{filename} not found")
    return FileResponse(
        path=str(fp),
        media_type=media_type,
        filename=filename,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


_GUIDE_PATH = Path("/app/USER_GUIDE.md")


@api.api_route("/downloads/guide", methods=["GET", "HEAD"])
async def download_guide(dl: int = 0) -> FileResponse:
    """Public user guide. Default `inline` for the in-app viewer;
    call with `?dl=1` to force a download disposition."""
    if not _GUIDE_PATH.exists():
        raise HTTPException(status_code=404, detail="USER_GUIDE.md not found")
    disp = "attachment" if dl else "inline"
    return FileResponse(
        path=str(_GUIDE_PATH),
        media_type="text/markdown; charset=utf-8",
        filename="CodeMemory-user-guide.md",
        headers={
            "Content-Disposition": f'{disp}; filename="CodeMemory-user-guide.md"',
            "Cache-Control": "public, max-age=60",
        },
    )


@api.api_route("/downloads/chrome", methods=["GET", "HEAD"])
async def download_chrome() -> FileResponse:
    """Public download of the packaged Chrome extension (MV3, vanilla JS)."""
    return _serve_artifact("codememory-chrome.zip", "application/zip")


@api.api_route("/downloads/vscode", methods=["GET", "HEAD"])
async def download_vscode() -> FileResponse:
    """Public download of the packaged VS Code extension (.vsix)."""
    return _serve_artifact("codememory-vscode.vsix", "application/octet-stream")


app.include_router(api)
