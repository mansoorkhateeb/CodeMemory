"""GitHub REST client — code files (recursive), merged PRs (with diff + comments),
and recent issues (with comments).

Token precedence: explicit arg > env GITHUB_TOKEN > unauthenticated.
Rate-limit / timeout errors bubble up as httpx exceptions for the caller to map
to a clean job-failed status. On 403/429 we honor Retry-After (or the
X-RateLimit-Reset window) exactly once, then re-raise.
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Iterable, List, Optional

import httpx

logger = logging.getLogger(__name__)

_GH_BASE = "https://api.github.com"
_TIMEOUT = 25.0
_MAX_CONCURRENCY = 3
_MAX_RETRY_WAIT_S = 30.0  # cap so we never hang a job on a huge reset window

# text-ish file extensions worth ingesting
_TEXT_EXTS = {
    ".py", ".pyi", ".md", ".rst", ".txt", ".toml", ".cfg", ".ini",
    ".yaml", ".yml", ".json", ".js", ".ts", ".tsx", ".jsx", ".html",
    ".css", ".sh",
}
_MAX_FILE_BYTES = 500_000  # skip anything bigger


def _headers(token: Optional[str] = None, accept: Optional[str] = None) -> dict:
    hdrs = {
        "Accept": accept or "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "codememory/0.2 (+https://github.com/codememory)",
    }
    tok = token or os.environ.get("GITHUB_TOKEN")
    if tok:
        hdrs["Authorization"] = f"Bearer {tok}"
    return hdrs


def _retry_wait_seconds(resp: httpx.Response) -> Optional[float]:
    """Return how long to wait before retrying a 403/429, honoring
    Retry-After first, then X-RateLimit-Reset. Capped at _MAX_RETRY_WAIT_S."""
    ra = resp.headers.get("Retry-After")
    if ra:
        try:
            return min(max(float(ra), 0.0), _MAX_RETRY_WAIT_S)
        except ValueError:
            pass
    reset = resp.headers.get("X-RateLimit-Reset")
    if reset:
        try:
            delta = float(reset) - time.time()
            if delta > 0:
                return min(delta, _MAX_RETRY_WAIT_S)
        except ValueError:
            pass
    # secondary/abuse rate limit with no header hint
    return 2.0


async def _gh_get(
    client: httpx.AsyncClient,
    url: str,
    *,
    params: Optional[dict] = None,
    token: Optional[str] = None,
    accept: Optional[str] = None,
) -> httpx.Response:
    """GET with a single Retry-After-aware retry on 403/429."""
    r = await client.get(url, params=params, headers=_headers(token, accept))
    if r.status_code in (403, 429):
        wait = _retry_wait_seconds(r)
        logger.warning(
            "github %s on %s — retrying once after %.1fs (remaining=%s)",
            r.status_code, url, wait or 0, r.headers.get("X-RateLimit-Remaining"),
        )
        if wait is not None:
            await asyncio.sleep(wait)
        r = await client.get(url, params=params, headers=_headers(token, accept))
    r.raise_for_status()
    return r


# --------------------------------------------------------------------------- #
# repo info + tree
# --------------------------------------------------------------------------- #
async def get_default_branch(owner: str, repo: str, token: Optional[str] = None) -> str:
    url = f"{_GH_BASE}/repos/{owner}/{repo}"
    async with httpx.AsyncClient(timeout=_TIMEOUT) as c:
        r = await _gh_get(c, url, token=token)
        return r.json().get("default_branch") or "main"


async def list_tree_recursive(
    owner: str, repo: str, ref: str, token: Optional[str] = None
) -> List[dict]:
    """Return [{path,type,sha,size}, ...] for every blob/tree at `ref`."""
    url = f"{_GH_BASE}/repos/{owner}/{repo}/git/trees/{ref}?recursive=1"
    async with httpx.AsyncClient(timeout=_TIMEOUT) as c:
        r = await _gh_get(c, url, token=token)
        data = r.json()
    return data.get("tree") or []


async def _get_blob_text(
    client: httpx.AsyncClient, owner: str, repo: str, sha: str, token: Optional[str]
) -> str:
    """Fetch a blob as text via the raw media type."""
    url = f"{_GH_BASE}/repos/{owner}/{repo}/git/blobs/{sha}"
    r = await _gh_get(client, url, token=token, accept="application/vnd.github.raw")
    return r.text


def _path_matches_prefixes(path: str, prefixes: Iterable[str]) -> bool:
    norm_prefixes = [p.strip("/").rstrip("/") for p in prefixes if p and p.strip()]
    if not norm_prefixes:
        return True
    for p in norm_prefixes:
        if path == p or path.startswith(p + "/"):
            return True
    return False


def _has_text_ext(path: str) -> bool:
    lower = path.lower()
    return any(lower.endswith(ext) for ext in _TEXT_EXTS)


async def fetch_code_files(
    owner: str,
    repo: str,
    path_prefixes: List[str],
    token: Optional[str] = None,
) -> List[dict]:
    """Return [{path, content, sha, size, html_url}] for text files under prefixes."""
    branch = await get_default_branch(owner, repo, token=token)
    tree = await list_tree_recursive(owner, repo, branch, token=token)

    targets = [
        e for e in tree
        if e.get("type") == "blob"
        and _has_text_ext(e.get("path", ""))
        and _path_matches_prefixes(e["path"], path_prefixes)
        and (e.get("size") or 0) <= _MAX_FILE_BYTES
    ]

    sem = asyncio.Semaphore(_MAX_CONCURRENCY)
    results: List[dict] = []

    async with httpx.AsyncClient(timeout=_TIMEOUT) as c:
        async def one(entry):
            async with sem:
                try:
                    text = await _get_blob_text(c, owner, repo, entry["sha"], token)
                except httpx.HTTPStatusError as e:
                    logger.warning("blob fetch failed for %s: %s", entry["path"], e)
                    return None
                return {
                    "path": entry["path"],
                    "content": text,
                    "sha": entry["sha"],
                    "size": entry.get("size", 0),
                    "html_url": f"https://github.com/{owner}/{repo}/blob/{branch}/{entry['path']}",
                }

        gathered = await asyncio.gather(*(one(e) for e in targets))
        for g in gathered:
            if g is not None:
                results.append(g)

    logger.info("fetched %d code files (of %d candidates)", len(results), len(targets))
    return results


# --------------------------------------------------------------------------- #
# PRs
# --------------------------------------------------------------------------- #
async def _pr_diff(
    client: httpx.AsyncClient, owner: str, repo: str, number: int, token: Optional[str]
) -> str:
    url = f"{_GH_BASE}/repos/{owner}/{repo}/pulls/{number}"
    r = await _gh_get(client, url, token=token, accept="application/vnd.github.diff")
    return r.text


async def _issue_comments(
    client: httpx.AsyncClient, owner: str, repo: str, number: int, token: Optional[str]
) -> List[str]:
    url = f"{_GH_BASE}/repos/{owner}/{repo}/issues/{number}/comments"
    r = await _gh_get(client, url, params={"per_page": 30}, token=token)
    out = []
    for c in r.json():
        body = (c.get("body") or "").strip()
        author = (c.get("user") or {}).get("login") or "unknown"
        if body:
            out.append(f"@{author}: {body}")
    return out


async def fetch_prs_full(
    owner: str, repo: str, limit: int = 20, token: Optional[str] = None
) -> List[dict]:
    """Merged PRs (most recent) with title, body, comments, and diff."""
    url = f"{_GH_BASE}/repos/{owner}/{repo}/pulls"
    params = {"state": "closed", "sort": "updated", "direction": "desc", "per_page": 50}

    async with httpx.AsyncClient(timeout=_TIMEOUT) as c:
        r = await _gh_get(c, url, params=params, token=token)
        listing = r.json()

        merged_meta = []
        for pr in listing:
            if pr.get("merged_at"):
                merged_meta.append(pr)
            if len(merged_meta) >= limit:
                break

        sem = asyncio.Semaphore(_MAX_CONCURRENCY)

        async def enrich(pr):
            async with sem:
                num = pr["number"]
                diff, comments = await asyncio.gather(
                    _pr_diff(c, owner, repo, num, token),
                    _issue_comments(c, owner, repo, num, token),
                )
                return {
                    "number": num,
                    "title": pr.get("title") or "",
                    "body": pr.get("body") or "",
                    "comments": comments,
                    "diff": diff,
                    "merged_at": pr["merged_at"],
                    "author": (pr.get("user") or {}).get("login"),
                    "labels": [lab.get("name") for lab in (pr.get("labels") or []) if lab.get("name")],
                    "html_url": pr.get("html_url"),
                }

        prs = list(await asyncio.gather(*(enrich(p) for p in merged_meta)))

    logger.info("fetched %d PRs (full)", len(prs))
    return prs


# --------------------------------------------------------------------------- #
# Issues (non-PR)
# --------------------------------------------------------------------------- #
async def fetch_issues(
    owner: str, repo: str, limit: int = 20, token: Optional[str] = None
) -> List[dict]:
    """Recent issues (state=all) with comments. Filters out PRs."""
    url = f"{_GH_BASE}/repos/{owner}/{repo}/issues"
    params = {"state": "all", "sort": "updated", "direction": "desc", "per_page": 50}

    async with httpx.AsyncClient(timeout=_TIMEOUT) as c:
        r = await _gh_get(c, url, params=params, token=token)
        listing = r.json()

        real_issues = [i for i in listing if not i.get("pull_request")][:limit]

        sem = asyncio.Semaphore(_MAX_CONCURRENCY)

        async def enrich(issue):
            async with sem:
                num = issue["number"]
                comments = await _issue_comments(c, owner, repo, num, token)
                return {
                    "number": num,
                    "title": issue.get("title") or "",
                    "body": issue.get("body") or "",
                    "state": issue.get("state"),
                    "comments": comments,
                    "author": (issue.get("user") or {}).get("login"),
                    "labels": [lab.get("name") for lab in (issue.get("labels") or []) if lab.get("name")],
                    "html_url": issue.get("html_url"),
                }

        issues = list(await asyncio.gather(*(enrich(i) for i in real_issues)))

    logger.info("fetched %d issues", len(issues))
    return issues
