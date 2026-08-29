"""Minimal GitHub REST client used by the Phase 0 POC.

Structured so that a token can be injected later via env `GITHUB_TOKEN`
or a per-request override (later phases). Unauthenticated is fine for POC.
"""
from __future__ import annotations

import base64
import logging
import os
from typing import List, Optional

import httpx

logger = logging.getLogger(__name__)

_GH_BASE = "https://api.github.com"
_TIMEOUT = 20.0


def _headers(token: Optional[str] = None) -> dict:
    hdrs = {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "codememory-poc",
    }
    tok = token or os.environ.get("GITHUB_TOKEN")
    if tok:
        hdrs["Authorization"] = f"Bearer {tok}"
    return hdrs


async def recent_merged_prs(
    owner: str,
    repo: str,
    limit: int = 5,
    token: Optional[str] = None,
) -> List[dict]:
    """Return up to `limit` most-recently-merged PRs (title + body).

    Filters out closed-but-not-merged PRs.
    """
    url = f"{_GH_BASE}/repos/{owner}/{repo}/pulls"
    params = {
        "state": "closed",
        "sort": "updated",
        "direction": "desc",
        "per_page": 30,
    }
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        r = await client.get(url, params=params, headers=_headers(token))
        r.raise_for_status()
        prs = r.json()

    merged = []
    for pr in prs:
        if pr.get("merged_at"):
            merged.append(
                {
                    "number": pr["number"],
                    "title": pr.get("title") or "",
                    "body": pr.get("body") or "",
                    "merged_at": pr["merged_at"],
                    "html_url": pr.get("html_url"),
                }
            )
        if len(merged) >= limit:
            break
    return merged


async def list_dir(
    owner: str,
    repo: str,
    path: str,
    token: Optional[str] = None,
) -> List[dict]:
    url = f"{_GH_BASE}/repos/{owner}/{repo}/contents/{path.lstrip('/')}"
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        r = await client.get(url, headers=_headers(token))
        r.raise_for_status()
        return r.json()


async def get_file_text(
    owner: str,
    repo: str,
    path: str,
    token: Optional[str] = None,
) -> str:
    url = f"{_GH_BASE}/repos/{owner}/{repo}/contents/{path.lstrip('/')}"
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        r = await client.get(url, headers=_headers(token))
        r.raise_for_status()
        data = r.json()
    if data.get("encoding") == "base64" and data.get("content"):
        return base64.b64decode(data["content"]).decode("utf-8", errors="replace")
    return data.get("content") or ""


async def fetch_files_in_dir(
    owner: str,
    repo: str,
    path: str,
    limit: int = 3,
    token: Optional[str] = None,
) -> List[dict]:
    """Fetch up to `limit` regular files (type=file) under `path` with contents."""
    entries = await list_dir(owner, repo, path, token=token)
    files_meta = [e for e in entries if e.get("type") == "file"][:limit]
    out: List[dict] = []
    for meta in files_meta:
        text = await get_file_text(owner, repo, meta["path"], token=token)
        out.append(
            {
                "path": meta["path"],
                "name": meta["name"],
                "size": meta.get("size", 0),
                "html_url": meta.get("html_url"),
                "content": text,
            }
        )
    return out
