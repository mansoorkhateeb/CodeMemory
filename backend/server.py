"""CodeMemory backend — Phase 0 POC.

Endpoints:
    GET  /api/health         → {"status":"ok"} (no auth)
    POST /api/poc            → runs the full risk chain (bearer-protected)

Auth: shared-secret bearer token from env CODEMEMORY_API_TOKEN.
CORS: allows the frontend origin AND any chrome-extension://* origin.
"""
from __future__ import annotations

import asyncio
import logging
import os
import secrets
from pathlib import Path
from typing import List, Optional

import httpx
import tiktoken
from dotenv import load_dotenv
from fastapi import APIRouter, Depends, FastAPI, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel
from starlette.middleware.cors import CORSMiddleware

from github_client import fetch_files_in_dir, recent_merged_prs
from llm import LLMError, call_llm

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger("codememory")

# --------------------------------------------------------------------------- #
# Lazy singletons — model + chroma client are heavy, load on first use.
# --------------------------------------------------------------------------- #
_embedder = None
_chroma_client = None
_chroma_lock = asyncio.Lock()


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
    version="0.1.0-phase0",
    openapi_url="/api/openapi.json",
    docs_url="/api/docs",
    redoc_url="/api/redoc",
)

# CORS: exact frontend origin + any chrome-extension://<id> origin.
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


# --------------------------------------------------------------------------- #
# Health
# --------------------------------------------------------------------------- #
@api.get("/health")
async def health() -> dict:
    return {"status": "ok"}


# --------------------------------------------------------------------------- #
# POC — proves the whole risky chain end-to-end.
# --------------------------------------------------------------------------- #
class PocResponse(BaseModel):
    chunks_fetched: int
    embeddings_stored: int
    clusters: int
    sample_summary: str
    summary_token_count: int
    chroma_persisted: bool


SUMMARY_PROMPT_TEMPLATE = (
    "You are an expert software engineer and technical writer. Summarize this "
    "cluster of related code/PR chunks into a concise, high-level summary "
    "(max {max_tokens} tokens) that captures its main purpose, key design "
    "decisions/trade-offs, and any clearly represented PRs. Use structured "
    "bullet points. Skip line-by-line code detail — focus on the story of "
    "what this cluster does, why it exists, and how it evolved. "
    "Chunks: {cluster_text}"
)


def _kmeans_labels(embeddings, k: int) -> List[int]:
    """Run KMeans with k clamped to min(k, n_samples)."""
    import numpy as np
    from sklearn.cluster import KMeans

    n = len(embeddings)
    k_eff = max(1, min(k, n))
    km = KMeans(n_clusters=k_eff, n_init=10, random_state=42)
    arr = np.asarray(embeddings, dtype="float32")
    labels = km.fit_predict(arr).tolist()
    return labels


@api.post("/poc", response_model=PocResponse)
async def poc(_token: str = Depends(require_bearer)) -> PocResponse:
    owner, repo = "pallets", "itsdangerous"

    # 1. Fetch small slice of GitHub data.
    try:
        prs, files = await asyncio.gather(
            recent_merged_prs(owner, repo, limit=5),
            fetch_files_in_dir(owner, repo, "src/itsdangerous", limit=3),
        )
    except httpx.HTTPStatusError as e:
        raise HTTPException(
            status_code=502,
            detail=f"GitHub error {e.response.status_code}: {e.response.text[:200]}",
        ) from e
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"GitHub request failed: {e}") from e
    logger.info("Fetched %d PRs and %d files", len(prs), len(files))

    # 2. Trivial chunking: one chunk per PR body, one per file.
    chunks: List[dict] = []
    for pr in prs:
        text = f"PR #{pr['number']}: {pr['title']}\n\n{pr['body']}".strip()
        chunks.append(
            {
                "id": f"pr-{pr['number']}",
                "text": text,
                "metadata": {
                    "kind": "pr",
                    "number": pr["number"],
                    "title": pr["title"],
                    "merged_at": pr["merged_at"],
                    "url": pr.get("html_url") or "",
                },
            }
        )
    for f in files:
        text = f"FILE {f['path']}\n\n{f['content']}"
        chunks.append(
            {
                "id": f"file-{f['path']}",
                "text": text,
                "metadata": {
                    "kind": "file",
                    "path": f["path"],
                    "name": f["name"],
                    "size": f["size"],
                    "url": f.get("html_url") or "",
                },
            }
        )

    if not chunks:
        raise HTTPException(status_code=502, detail="GitHub returned no PRs or files")

    # 3. Embed with MiniLM and persist in Chroma.
    embedder = await asyncio.to_thread(_get_embedder)
    texts = [c["text"] for c in chunks]
    embeddings = await asyncio.to_thread(
        lambda: embedder.encode(texts, normalize_embeddings=True).tolist()
    )

    async with _chroma_lock:
        client = _get_chroma()
        coll = client.get_or_create_collection(name="codememory_poc")
        # upsert so re-runs are idempotent
        coll.upsert(
            ids=[c["id"] for c in chunks],
            embeddings=embeddings,
            documents=texts,
            metadatas=[c["metadata"] for c in chunks],
        )
        stored_count = coll.count()

        # Verify persistence: reopen the collection via the same client and
        # confirm the count survives (proxy for on-disk durability).
        verify_coll = client.get_collection(name="codememory_poc")
        persisted = verify_coll.count() >= len(chunks)

    # 4. KMeans k=2 (clamped).
    labels = await asyncio.to_thread(_kmeans_labels, embeddings, 2)
    unique_clusters = sorted(set(labels))
    logger.info("Clusters produced: %s", unique_clusters)

    # 5. Summarize ONE cluster with gpt-5.
    target_cluster = unique_clusters[0]
    cluster_chunks = [chunks[i]["text"] for i, lb in enumerate(labels) if lb == target_cluster]
    # cap raw input size to keep the call fast/cheap
    cluster_text = "\n\n---\n\n".join(cluster_chunks)[:12000]

    prompt = SUMMARY_PROMPT_TEMPLATE.format(max_tokens=300, cluster_text=cluster_text)
    try:
        summary = await call_llm(prompt)
    except LLMError as e:
        raise HTTPException(status_code=502, detail=f"LLM failed: {e}") from e

    # 6. Count tokens with tiktoken.
    try:
        enc = tiktoken.encoding_for_model("gpt-4o")  # gpt-5 not in tiktoken registry; use o200k_base equivalent
    except Exception:
        enc = tiktoken.get_encoding("o200k_base")
    summary_tokens = len(enc.encode(summary))

    return PocResponse(
        chunks_fetched=len(chunks),
        embeddings_stored=stored_count,
        clusters=len(unique_clusters),
        sample_summary=summary,
        summary_token_count=summary_tokens,
        chroma_persisted=bool(persisted),
    )


app.include_router(api)
