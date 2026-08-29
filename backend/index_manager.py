"""Ingestion + tree-build orchestrator (background task + status state machine).

- Single global state (POC-scoped; single-worker backend).
- `POST /api/index` → schedules a task, returns immediately.
- A running job blocks new POSTs with 409.
- On any failure: the *new* Chroma collection (if any was created) is
  destroyed and the *previous* tree/collection are left fully intact.
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

import httpx

import tree_store
from chunker import chunk_code_file, chunk_issue, chunk_pr
from github_client import fetch_code_files, fetch_issues, fetch_prs_full
from llm import LLMError
from models import Chunk, IndexProgress, IndexStatus, TreeNode
from tree_builder import build_tree

logger = logging.getLogger(__name__)


# --------------------------------------------------------------------------- #
# Chroma + embedder singletons (populated by server.py)
# --------------------------------------------------------------------------- #
_embedder = None
_chroma_client = None


def wire_singletons(embedder, chroma_client) -> None:
    global _embedder, _chroma_client
    _embedder = embedder
    _chroma_client = chroma_client


def _embed_texts(texts: List[str]) -> List[List[float]]:
    if _embedder is None:
        raise RuntimeError("embedder not initialized")
    return _embedder.encode(texts, normalize_embeddings=True).tolist()


def _sanitize_collection_component(s: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_.-]", "-", s)


# --------------------------------------------------------------------------- #
# State
# --------------------------------------------------------------------------- #
class IndexManager:
    def __init__(self) -> None:
        self._status = IndexStatus()
        self._lock = asyncio.Lock()
        self._task: Optional[asyncio.Task] = None

    def get_status(self) -> IndexStatus:
        return self._status.model_copy(deep=True)

    def _set(self, **kwargs) -> None:
        data = self._status.model_dump()
        data.update(kwargs)
        self._status = IndexStatus(**data)

    def _progress(self, stage: str, detail: str = "") -> None:
        self._status = self._status.model_copy(
            update={"progress": IndexProgress(stage=stage, detail=detail)}
        )
        logger.info("[index] %s: %s", stage, detail)

    async def start(
        self,
        *,
        repo_owner: str,
        repo_name: str,
        paths: List[str],
        github_token: Optional[str],
    ) -> IndexStatus:
        async with self._lock:
            if self._status.status == "indexing":
                raise RuntimeError("indexing_already_in_progress")
            repo = f"{repo_owner}/{repo_name}"
            self._status = IndexStatus(
                status="indexing",
                progress=IndexProgress(stage="fetching", detail="queued"),
                error=None,
                repo=repo,
                started_at=datetime.now(timezone.utc).isoformat(),
                finished_at=None,
            )
            self._task = asyncio.create_task(
                self._run(repo_owner, repo_name, paths, github_token)
            )
        return self.get_status()

    async def _run(
        self,
        owner: str,
        repo: str,
        paths: List[str],
        github_token: Optional[str],
    ) -> None:
        new_collection_name: Optional[str] = None
        try:
            self._progress("fetching", f"github: {owner}/{repo}")
            code_files, prs, issues = await asyncio.gather(
                fetch_code_files(owner, repo, paths or [], token=github_token),
                fetch_prs_full(owner, repo, limit=20, token=github_token),
                fetch_issues(owner, repo, limit=20, token=github_token),
            )
            self._progress(
                "fetching",
                f"code_files={len(code_files)} prs={len(prs)} issues={len(issues)}",
            )

            if not code_files and not prs and not issues:
                raise RuntimeError("nothing to index (repo returned no files/PRs/issues)")

            # ---- chunk ----------------------------------------------------- #
            self._progress("chunking", "code / prs / issues")
            chunks: List[Chunk] = []
            for f in code_files:
                chunks.extend(chunk_code_file(f["path"], f["content"], f.get("html_url", "")))
            for pr in prs:
                chunks.extend(chunk_pr(pr))
            for issue in issues:
                chunks.extend(chunk_issue(issue))

            if not chunks:
                raise RuntimeError("no chunks produced (all inputs were empty)")

            self._progress("chunking", f"{len(chunks)} chunks total")

            # ---- embed ----------------------------------------------------- #
            self._progress("embedding", f"{len(chunks)} chunk embeddings")
            embeddings = await asyncio.to_thread(_embed_texts, [c.content for c in chunks])

            # ---- new chroma collection (isolated for atomic swap) ---------- #
            ingest_id = uuid.uuid4().hex[:10]
            new_collection_name = (
                f"cm_{_sanitize_collection_component(owner)}__"
                f"{_sanitize_collection_component(repo)}_{ingest_id}"
            )
            self._progress("persisting", f"chroma collection {new_collection_name}")
            new_coll = _chroma_client.get_or_create_collection(name=new_collection_name)
            new_coll.upsert(
                ids=[c.id for c in chunks],
                embeddings=embeddings,
                documents=[c.content for c in chunks],
                metadatas=[
                    {"type": c.type, **{k: _flatten(v) for k, v in c.metadata.items()}}
                    for c in chunks
                ],
            )

            # ---- build tree ----------------------------------------------- #
            def report(stage: str, detail: str) -> None:
                self._progress(stage, detail)

            nodes, root_id, extra_embeddings = await build_tree(
                chunks=chunks,
                embeddings=embeddings,
                embed_fn=_embed_texts,
                repo_owner=owner,
                repo_name=repo,
                on_progress=report,
            )

            if extra_embeddings:
                self._progress(
                    "persisting", f"{len(extra_embeddings)} node-summary embeddings"
                )
                ids = list(extra_embeddings.keys())
                vecs = [extra_embeddings[i] for i in ids]
                # documents = the node summary text (looked up in nodes)
                docs = []
                metas = []
                for eid in ids:
                    node_id = eid.split("summary:", 1)[1]
                    n = nodes[node_id]
                    docs.append(n.summary or n.title or "")
                    metas.append({"kind": "node_summary", "node_type": n.type, "node_id": n.id})
                new_coll.upsert(ids=ids, embeddings=vecs, documents=docs, metadatas=metas)

            # ---- atomic swap: write tree JSON, drop old collection --------- #
            prev_collection = tree_store.previous_collection(owner, repo)
            self._progress("persisting", "writing tree.json (atomic)")
            tree_store.save(
                owner=owner,
                name=repo,
                paths=paths,
                collection_name=new_collection_name,
                root_id=root_id,
                nodes=nodes,
            )

            if prev_collection and prev_collection != new_collection_name:
                try:
                    _chroma_client.delete_collection(name=prev_collection)
                    logger.info("dropped previous collection %s", prev_collection)
                except Exception as e:
                    logger.warning("could not drop old collection %s: %s", prev_collection, e)

            # ---- done ------------------------------------------------------ #
            self._set(
                status="complete",
                progress=IndexProgress(
                    stage="complete",
                    detail=(
                        f"nodes={len(nodes)} chunks={len(chunks)} "
                        f"prs={len(prs)} issues={len(issues)} files={len(code_files)}"
                    ),
                ),
                error=None,
                finished_at=datetime.now(timezone.utc).isoformat(),
            )
            logger.info("[index] complete for %s/%s", owner, repo)

        except Exception as e:  # noqa: BLE001
            logger.exception("[index] failed")
            # cleanup the *new* collection so state stays consistent
            if new_collection_name and _chroma_client is not None:
                try:
                    _chroma_client.delete_collection(name=new_collection_name)
                    logger.info("cleaned up partial collection %s", new_collection_name)
                except Exception:
                    pass
            self._set(
                status="failed",
                progress=IndexProgress(stage="failed", detail=""),
                error=_humanize_error(e),
                finished_at=datetime.now(timezone.utc).isoformat(),
            )


def _flatten(v):
    """Chroma metadata values must be str/int/float/bool. Coerce lists → csv."""
    if isinstance(v, (str, int, float, bool)) or v is None:
        return "" if v is None else v
    if isinstance(v, list):
        return ",".join(str(x) for x in v)
    return str(v)


def _humanize_error(e: Exception) -> str:
    if isinstance(e, httpx.HTTPStatusError):
        code = e.response.status_code
        if code in (401, 403):
            return (
                f"GitHub rejected the request ({code}). "
                "You may have hit the unauthenticated rate limit — provide a GITHUB_TOKEN."
            )
        if code == 404:
            return "GitHub returned 404: repo or paths not found."
        if code in (429,):
            return "GitHub rate-limited (429). Try again later or provide a token."
        return f"GitHub HTTP {code}: {e.response.text[:200]}"
    if isinstance(e, httpx.HTTPError):
        return f"GitHub request failed: {e}"
    if isinstance(e, LLMError):
        return f"LLM call failed: {e}"
    return f"{type(e).__name__}: {e}"


# module singleton
manager = IndexManager()
