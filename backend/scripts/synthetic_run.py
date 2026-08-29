"""Synthetic in-process run of the FULL Phase 1 pipeline.

Monkey-patches `index_manager.{fetch_code_files, fetch_prs_full, fetch_issues}`
so we can exercise the exact production code path — chunk → embed → cluster →
LLM summarize → atomic tree save → previous-collection drop → concurrency guard —
without touching GitHub.

Runs three back-to-back scenarios:
    1. Happy path: full build, verify status transitions and tree shape.
    2. Re-index: same synthetic input, verify old Chroma collection is dropped
       and the new tree stays valid.
    3. Kill test: forcibly raise inside a fetcher, verify status=failed with a
       clean error message AND the previous tree/collection remain intact.
    4. Concurrency guard: while a job is running, a second `manager.start(...)`
       raises RuntimeError('indexing_already_in_progress').
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from pathlib import Path

# make the app importable
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# force load .env before importing anything that reads it
from dotenv import load_dotenv  # noqa: E402
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

from sentence_transformers import SentenceTransformer  # noqa: E402
import chromadb  # noqa: E402

import index_manager  # noqa: E402
import tree_store  # noqa: E402

# --------------------------------------------------------------------------- #
# Synthetic corpus: 4 loosely-separable "themes" so KMeans can cluster.
# --------------------------------------------------------------------------- #
SYNTH_FILES = [
    {
        "path": "src/synth/auth.py",
        "content": (
            "def sign_token(payload, secret):\n"
            "    import hmac, hashlib, base64, json\n"
            "    body = base64.urlsafe_b64encode(json.dumps(payload).encode())\n"
            "    sig = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()\n"
            "    return body.decode() + '.' + sig\n\n"
            "def verify_token(token, secret):\n"
            "    body, _, sig = token.partition('.')\n"
            "    expected = hmac.new(secret.encode(), body.encode(), hashlib.sha256).hexdigest()\n"
            "    return hmac.compare_digest(sig, expected)\n"
        ),
        "html_url": "https://example.invalid/synth/auth.py",
    },
    {
        "path": "src/synth/session.py",
        "content": (
            "class Session:\n"
            "    def __init__(self, user_id, expires_at):\n"
            "        self.user_id = user_id\n"
            "        self.expires_at = expires_at\n\n"
            "    def is_expired(self, now):\n"
            "        return now >= self.expires_at\n"
        ),
        "html_url": "https://example.invalid/synth/session.py",
    },
    {
        "path": "src/synth/templating.py",
        "content": (
            "def render(template: str, ctx: dict) -> str:\n"
            "    out = template\n"
            "    for k, v in ctx.items():\n"
            "        out = out.replace('{{' + k + '}}', str(v))\n"
            "    return out\n"
        ),
        "html_url": "https://example.invalid/synth/templating.py",
    },
    {
        "path": "src/synth/router.py",
        "content": (
            "class Router:\n"
            "    def __init__(self):\n"
            "        self.routes = {}\n\n"
            "    def add(self, method, path, handler):\n"
            "        self.routes[(method, path)] = handler\n\n"
            "    def dispatch(self, method, path, req):\n"
            "        h = self.routes.get((method, path))\n"
            "        if not h: raise KeyError('no route')\n"
            "        return h(req)\n"
        ),
        "html_url": "https://example.invalid/synth/router.py",
    },
    {
        "path": "src/synth/orm.py",
        "content": (
            "class Model:\n"
            "    _rows = []\n"
            "    def save(self):\n"
            "        Model._rows.append(self.__dict__)\n\n"
            "    @classmethod\n"
            "    def all(cls):\n"
            "        return list(cls._rows)\n"
        ),
        "html_url": "https://example.invalid/synth/orm.py",
    },
]

SYNTH_PRS = [
    {
        "number": 101,
        "title": "Add HMAC-SHA256 token signing to auth module",
        "body": "Replaces the plaintext session cookie with a signed token. Keys read from env.",
        "comments": ["@reviewer: LGTM, please add a rotation test."],
        "diff": (
            "diff --git a/src/synth/auth.py b/src/synth/auth.py\n"
            "+++ b/src/synth/auth.py\n"
            "+def sign_token(...): ...\n"
            "+def verify_token(...): ...\n"
        ),
        "merged_at": "2026-01-05T10:00:00Z",
        "author": "alice",
        "labels": ["auth", "security"],
        "html_url": "https://example.invalid/pr/101",
    },
    {
        "number": 102,
        "title": "Session expiration + refresh flow",
        "body": "Adds `is_expired` and a refresh endpoint.",
        "comments": [],
        "diff": "diff a/src/synth/session.py\n+ is_expired ...\n",
        "merged_at": "2026-01-08T10:00:00Z",
        "author": "bob",
        "labels": ["auth"],
        "html_url": "https://example.invalid/pr/102",
    },
    {
        "number": 103,
        "title": "Templating: {{var}} substitution",
        "body": "Minimal string-replace template renderer, no escaping yet.",
        "comments": ["@carol: we should escape HTML in a follow-up."],
        "diff": "diff a/src/synth/templating.py\n+ def render ...\n",
        "merged_at": "2026-01-12T10:00:00Z",
        "author": "carol",
        "labels": ["templating"],
        "html_url": "https://example.invalid/pr/103",
    },
    {
        "number": 104,
        "title": "Escape HTML in templating render",
        "body": "Follow-up to #103 — html.escape() context values before substitution.",
        "comments": [],
        "diff": "diff a/src/synth/templating.py\n+ import html\n+ html.escape(v)\n",
        "merged_at": "2026-01-14T10:00:00Z",
        "author": "carol",
        "labels": ["templating", "security"],
        "html_url": "https://example.invalid/pr/104",
    },
    {
        "number": 105,
        "title": "Basic HTTP router with path/method dispatch",
        "body": "Registers routes as (method, path) → handler.",
        "comments": [],
        "diff": "diff a/src/synth/router.py\n+ class Router ...\n",
        "merged_at": "2026-01-18T10:00:00Z",
        "author": "dave",
        "labels": ["http"],
        "html_url": "https://example.invalid/pr/105",
    },
    {
        "number": 106,
        "title": "Router: 404 handler and middleware chain",
        "body": "Adds middleware() decorator and a default 404 handler.",
        "comments": ["@eve: please cover middleware ordering in the tests."],
        "diff": "diff a/src/synth/router.py\n+ def middleware ...\n",
        "merged_at": "2026-01-22T10:00:00Z",
        "author": "dave",
        "labels": ["http"],
        "html_url": "https://example.invalid/pr/106",
    },
    {
        "number": 107,
        "title": "ORM base Model.save/all",
        "body": "Trivial in-memory row store, will be replaced by SQLite.",
        "comments": [],
        "diff": "diff a/src/synth/orm.py\n+ class Model ...\n",
        "merged_at": "2026-01-25T10:00:00Z",
        "author": "eve",
        "labels": ["orm", "db"],
        "html_url": "https://example.invalid/pr/107",
    },
    {
        "number": 108,
        "title": "ORM: filter() with kw args and SQLite backend",
        "body": "Adds Model.filter(**kw) and swaps in-memory store for sqlite3.",
        "comments": [],
        "diff": "diff a/src/synth/orm.py\n+ import sqlite3\n+ def filter(cls, **kw): ...\n",
        "merged_at": "2026-01-28T10:00:00Z",
        "author": "eve",
        "labels": ["orm", "db"],
        "html_url": "https://example.invalid/pr/108",
    },
]

SYNTH_ISSUES = [
    {
        "number": 201,
        "title": "auth: rotate signing keys without invalidating live sessions",
        "body": "We need dual-key verification during a rotation window.",
        "state": "open",
        "comments": ["@alice: proposing a `keys.previous` env var."],
        "author": "reporter1",
        "labels": ["auth", "security"],
        "html_url": "https://example.invalid/issue/201",
    },
    {
        "number": 202,
        "title": "templating: {{var}} does not handle nested attributes",
        "body": "`{{user.name}}` currently substitutes the literal.",
        "state": "closed",
        "comments": ["@carol: fixed in #109."],
        "author": "reporter2",
        "labels": ["templating"],
        "html_url": "https://example.invalid/issue/202",
    },
    {
        "number": 203,
        "title": "router: middleware order is non-deterministic when using sets",
        "body": "Register order should be preserved.",
        "state": "open",
        "comments": [],
        "author": "reporter3",
        "labels": ["http"],
        "html_url": "https://example.invalid/issue/203",
    },
    {
        "number": 204,
        "title": "orm: N+1 query pattern in Model.all()",
        "body": "Calling .all() triggers one query per row instead of a single SELECT.",
        "state": "open",
        "comments": [],
        "author": "reporter4",
        "labels": ["orm", "perf"],
        "html_url": "https://example.invalid/issue/204",
    },
]


# --------------------------------------------------------------------------- #
# Runner
# --------------------------------------------------------------------------- #
async def _poll_until_terminal(timeout_s: float = 240.0) -> dict:
    t0 = time.time()
    last_stage = None
    while time.time() - t0 < timeout_s:
        s = index_manager.manager.get_status().model_dump()
        stage = s["progress"]["stage"]
        detail = s["progress"]["detail"][:80]
        if stage != last_stage:
            print(f"  [{time.time()-t0:5.1f}s] {s['status']:9s} · {stage:12s} · {detail}")
            last_stage = stage
        if s["status"] in ("complete", "failed"):
            return s
        await asyncio.sleep(0.5)
    raise TimeoutError("timed out waiting for terminal status")


async def _install_fakes(*, fail: bool = False) -> None:
    async def fake_fetch_code_files(owner, repo, paths, token=None):
        await asyncio.sleep(0.05)
        return list(SYNTH_FILES)

    async def fake_fetch_prs_full(owner, repo, limit=20, token=None):
        await asyncio.sleep(0.05)
        return list(SYNTH_PRS)[:limit]

    async def fake_fetch_issues(owner, repo, limit=20, token=None):
        await asyncio.sleep(0.05)
        if fail:
            import httpx
            raise httpx.HTTPStatusError(
                "simulated failure",
                request=httpx.Request("GET", "https://api.github.com/x"),
                response=httpx.Response(403, request=httpx.Request("GET", "https://api.github.com/x")),
            )
        return list(SYNTH_ISSUES)[:limit]

    index_manager.fetch_code_files = fake_fetch_code_files
    index_manager.fetch_prs_full = fake_fetch_prs_full
    index_manager.fetch_issues = fake_fetch_issues


async def main() -> int:
    print("== bootstrapping embedder + chroma singletons ==")
    embedder = SentenceTransformer("all-MiniLM-L6-v2")
    chroma_client = chromadb.PersistentClient(path=os.environ.get("CHROMA_DIR", "/app/backend/data/chroma"))
    index_manager.wire_singletons(embedder, chroma_client)

    OWNER, NAME = "synth", "webframework"

    # -------------------------------------------------------------------- #
    print("\n== scenario 1: happy-path index ==")
    await _install_fakes(fail=False)
    t0 = time.time()
    await index_manager.manager.start(
        repo_owner=OWNER, repo_name=NAME, paths=["src/synth"], github_token=None
    )
    s1 = await _poll_until_terminal()
    wall1 = time.time() - t0
    assert s1["status"] == "complete", s1
    tree = tree_store.load(OWNER, NAME)
    assert tree is not None, "tree not persisted"
    coll1 = tree["collection_name"]
    counts = {"repo": 0, "subsystem": 0, "topic": 0, "artifact": 0, "chunk": 0}
    for n in tree["nodes"].values():
        counts[n["type"]] = counts.get(n["type"], 0) + 1
    print(f"  wall_time = {wall1:.1f}s")
    print(f"  collection = {coll1}")
    print(f"  root_id    = {tree['root_id']}")
    print(f"  node counts= {counts}")
    print(f"  chroma count= {chroma_client.get_collection(coll1).count()}")
    assert counts["subsystem"] >= 2 and counts["topic"] >= 3, f"tree too flat: {counts}"

    # -------------------------------------------------------------------- #
    print("\n== scenario 2: re-index same repo (old collection must be dropped) ==")
    prev_all = {c.name for c in chroma_client.list_collections()}
    print(f"  collections before= {[c for c in prev_all if c.startswith('cm_synth__')]}")
    await _install_fakes(fail=False)
    t0 = time.time()
    await index_manager.manager.start(
        repo_owner=OWNER, repo_name=NAME, paths=["src/synth"], github_token=None
    )
    s2 = await _poll_until_terminal()
    wall2 = time.time() - t0
    assert s2["status"] == "complete"
    tree2 = tree_store.load(OWNER, NAME)
    coll2 = tree2["collection_name"]
    after_all = {c.name for c in chroma_client.list_collections()}
    print(f"  wall_time = {wall2:.1f}s")
    print(f"  new collection = {coll2}")
    print(f"  old collection dropped? {coll1 not in after_all}  (was: {coll1})")
    print(f"  cm_synth__ collections after = {[c for c in after_all if c.startswith('cm_synth__')]}")
    node_ids = list(tree2["nodes"].keys())
    assert len(node_ids) == len(set(node_ids)), "duplicate node ids"
    assert coll1 not in after_all, "previous collection was NOT dropped"
    assert coll2 in after_all
    counts2 = {}
    for n in tree2["nodes"].values():
        counts2[n["type"]] = counts2.get(n["type"], 0) + 1
    print(f"  node counts (new)= {counts2}")

    # -------------------------------------------------------------------- #
    print("\n== scenario 3: kill test (fetcher raises → status=failed, prior tree intact) ==")
    tree_before_kill = tree_store.load(OWNER, NAME)
    coll_before_kill = tree_before_kill["collection_name"]
    root_before_kill = tree_before_kill["root_id"]
    await _install_fakes(fail=True)
    await index_manager.manager.start(
        repo_owner=OWNER, repo_name=NAME, paths=["src/synth"], github_token=None
    )
    s3 = await _poll_until_terminal(timeout_s=30)
    print(f"  final status = {s3['status']}")
    print(f"  error        = {s3['error']}")
    assert s3["status"] == "failed"
    assert s3["error"] and "GitHub" in s3["error"] and "\n" not in s3["error"][:200]  # no stack trace
    tree_after_kill = tree_store.load(OWNER, NAME)
    assert tree_after_kill["collection_name"] == coll_before_kill, "prior collection pointer moved"
    assert tree_after_kill["root_id"] == root_before_kill, "prior tree was clobbered"
    still_there = {c.name for c in chroma_client.list_collections()}
    assert coll_before_kill in still_there, "prior collection was dropped"
    print("  prior tree intact ✓")

    # -------------------------------------------------------------------- #
    print("\n== scenario 4: concurrency guard ==")
    # Start a slow index (add sleep in fake) — start one immediately and try to start another.
    async def slow_fetch_code_files(*args, **kw):
        await asyncio.sleep(1.5)
        return list(SYNTH_FILES)
    index_manager.fetch_code_files = slow_fetch_code_files

    async def fake_fetch_prs_full_ok(*a, **kw): return list(SYNTH_PRS)
    async def fake_fetch_issues_ok(*a, **kw): return list(SYNTH_ISSUES)
    index_manager.fetch_prs_full = fake_fetch_prs_full_ok
    index_manager.fetch_issues = fake_fetch_issues_ok

    await index_manager.manager.start(
        repo_owner=OWNER, repo_name=NAME, paths=["src/synth"], github_token=None
    )
    try:
        await index_manager.manager.start(
            repo_owner=OWNER, repo_name=NAME, paths=["src/synth"], github_token=None
        )
        print("  FAIL: second start did NOT raise")
        return 2
    except RuntimeError as e:
        assert str(e) == "indexing_already_in_progress", str(e)
        print(f"  second start correctly raised: {e}")
    # let the slow index finish for cleanliness
    await _poll_until_terminal(timeout_s=120)

    print("\n== ALL SCENARIOS PASSED ==")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
