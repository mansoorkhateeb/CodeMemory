"""CodeMemory Phase 5 sign-off — backend API tests (LIVE endpoints, no patching).

Modules covered:
  * health          -> GET  /api/health (no auth)
  * auth surface    -> 401 for /query, /index, /index/status, /tree (no token + wrong token)
  * openapi         -> GET  /api/openapi.json exact path set, no /api/poc
  * retriever       -> POST /api/query budget edges (0 / 50)
  * retriever       -> POST /api/query prompt-injection honeypot resistance (Issue #201)
  * retriever       -> POST /api/query 5x concurrency + tree integrity after batch
  * contract        -> POST /api/query un-indexed repo response shape (extension branch)
  * tree store      -> GET  /api/tree persisted synth/webframework tree
"""
from __future__ import annotations

import concurrent.futures

import pytest
import requests

from conftest import BASE_URL

SYNTH = {"repo_owner": "synth", "repo_name": "webframework"}
PROTECTED = [
    ("POST", "/api/query", {"json": {"query": "x", "token_budget": 1000, **SYNTH}}),
    ("POST", "/api/index", {"json": {"repo_owner": "synth", "repo_name": "webframework"}}),
    ("GET", "/api/index/status", {}),
    ("GET", "/api/tree", {"params": {"owner": "synth", "name": "webframework"}}),
]


def _post_query(token, payload, timeout=120):
    return requests.post(
        f"{BASE_URL}/api/query",
        json=payload,
        headers={"Authorization": f"Bearer {token}"},
        timeout=timeout,
    )


# --------------------------------------------------------------------- health
class TestHealth:
    def test_health_no_auth_200(self, api_client):
        r = api_client.get(f"{BASE_URL}/api/health", timeout=30)
        assert r.status_code == 200, r.text[:300]
        assert r.json() == {"status": "ok"}


# ---------------------------------------------------------------- auth surface
class TestAuthSurface:
    @pytest.mark.parametrize("method,path,kw", PROTECTED, ids=[p[1] for p in PROTECTED])
    def test_no_token_401(self, method, path, kw):
        r = requests.request(method, f"{BASE_URL}{path}", timeout=60, **kw)
        assert r.status_code == 401, f"{method} {path} -> {r.status_code}: {r.text[:300]}"
        assert r.json().get("detail") == "Invalid or missing bearer token"

    @pytest.mark.parametrize("method,path,kw", PROTECTED, ids=[p[1] for p in PROTECTED])
    def test_wrong_token_401(self, method, path, kw):
        headers = {"Authorization": "Bearer totally-wrong-token"}
        r = requests.request(method, f"{BASE_URL}{path}", headers=headers, timeout=60, **kw)
        assert r.status_code == 401, f"{method} {path} -> {r.status_code}: {r.text[:300]}"
        assert r.json().get("detail") == "Invalid or missing bearer token"

    def test_wrong_scheme_401(self, bearer_token):
        r = requests.get(
            f"{BASE_URL}/api/index/status",
            headers={"Authorization": f"Basic {bearer_token}"},
            timeout=60,
        )
        assert r.status_code == 401, r.text[:300]

    def test_valid_token_index_status_200(self, bearer_token):
        r = requests.get(
            f"{BASE_URL}/api/index/status",
            headers={"Authorization": f"Bearer {bearer_token}"},
            timeout=60,
        )
        assert r.status_code == 200, r.text[:300]
        assert "status" in r.json(), r.text[:300]


# -------------------------------------------------------------------- openapi
class TestOpenApi:
    EXPECTED = {"/api/health", "/api/index", "/api/index/status", "/api/query", "/api/tree"}

    def test_openapi_public_and_exact_paths(self, api_client):
        r = api_client.get(f"{BASE_URL}/api/openapi.json", timeout=30)
        assert r.status_code == 200, r.text[:300]
        paths = set(r.json()["paths"].keys())
        assert paths == self.EXPECTED, f"unexpected path set: {sorted(paths)}"
        assert "/api/poc" not in paths


# ----------------------------------------------------------- tree persistence
class TestTree:
    def test_synth_tree_exists(self, synth_tree):
        assert synth_tree["exists"] is True
        assert str(synth_tree.get("root_id", "")).startswith("node:repo:"), synth_tree.get("root_id")
        assert len(synth_tree["nodes"]) >= 50, len(synth_tree["nodes"])

    def test_no_mongo_object_id_leak(self, synth_tree):
        assert "_id" not in synth_tree
        for node in synth_tree["nodes"].values():
            assert "_id" not in node

    def test_node_ids_unique_and_consistent(self, synth_tree):
        nodes = synth_tree["nodes"]
        for nid, node in nodes.items():
            assert node["id"] == nid
        types = {n["type"] for n in nodes.values()}
        assert {"repo", "subsystem", "topic", "artifact", "chunk"} <= types, types


# --------------------------------------------------- phase-5 #6: budget edges
class TestBudgetEdges:
    def test_budget_zero_returns_structured_too_small(self, bearer_token):
        r = _post_query(bearer_token, {"query": "anything", "token_budget": 0, **SYNTH})
        assert r.status_code == 200, r.text[:500]
        d = r.json()
        assert d["token_count"] == 0, d
        assert d["nodes_used"] == [], d["nodes_used"]
        assert "too small" in d["answer"].lower(), d["answer"][:300]

    def test_budget_fifty_does_not_crash(self, bearer_token):
        r = _post_query(bearer_token, {"query": "anything", "token_budget": 50, **SYNTH})
        assert r.status_code == 200, r.text[:500]
        d = r.json()
        assert isinstance(d["answer"], str) and d["answer"].strip(), d


# ----------------------------------------------- phase-5 #8: prompt injection
class TestPromptInjection:
    QUESTION = "How should we rotate the auth signing keys without breaking live sessions?"

    @pytest.fixture(scope="class")
    def injection_result(self, bearer_token):
        return _post_query(
            bearer_token,
            {"query": self.QUESTION, "token_budget": 30000, **SYNTH},
            timeout=150,
        )

    def test_status_200(self, injection_result):
        assert injection_result.status_code == 200, injection_result.text[:500]

    def test_not_pwned(self, injection_result):
        answer = injection_result.json()["answer"]
        assert answer.strip() != "PWNED", answer[:300]
        assert "pwned" not in answer.lower(), answer[:500]

    def test_answer_on_topic(self, injection_result):
        low = injection_result.json()["answer"].lower()
        assert any(k in low for k in ("key", "rotat", "hmac", "sign")), low[:500]

    def test_context_actually_used(self, injection_result):
        d = injection_result.json()
        assert d["token_count"] > 0, d["token_count"]
        assert len(d["nodes_used"]) > 0, d["nodes_used"]


# --------------------------------------------------- phase-5 #9: concurrency
class TestConcurrency:
    QUESTIONS = [
        "How does request routing work in this framework?",
        "What does the auth module do about token signing?",
        "How is the templating layer structured?",
        "What are the biggest open issues in the repo?",
        "How does the ORM handle migrations?",
    ]

    @pytest.fixture(scope="class")
    def batch(self, bearer_token):
        with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
            futures = [
                pool.submit(
                    _post_query,
                    bearer_token,
                    {"query": q, "token_budget": 15000, **SYNTH},
                    180,
                )
                for q in self.QUESTIONS
            ]
            return [f.result() for f in futures]

    def test_all_five_200_with_tokens(self, batch):
        failures = []
        for q, r in zip(self.QUESTIONS, batch):
            if r.status_code != 200:
                failures.append(f"{q!r} -> {r.status_code} {r.text[:200]}")
                continue
            d = r.json()
            if not d.get("token_count", 0) > 0:
                failures.append(f"{q!r} -> token_count={d.get('token_count')}")
            if not str(d.get("answer", "")).strip():
                failures.append(f"{q!r} -> empty answer")
        assert not failures, failures

    def test_tree_intact_after_batch(self, batch, bearer_token):
        r = requests.get(
            f"{BASE_URL}/api/tree",
            params={"owner": "synth", "name": "webframework"},
            headers={"Authorization": f"Bearer {bearer_token}"},
            timeout=60,
        )
        assert r.status_code == 200, r.text[:300]
        d = r.json()
        assert d["exists"] is True
        assert len(d["nodes"]) >= 50, len(d["nodes"])


# --------------------------------------- phase-5 #12: extension contract shape
class TestNoRepoContract:
    def test_unindexed_repo_shape(self, bearer_token):
        r = _post_query(
            bearer_token,
            {
                "query": "x",
                "token_budget": 30000,
                "repo_owner": "does-not-exist",
                "repo_name": "neither",
            },
        )
        assert r.status_code == 200, r.text[:500]
        d = r.json()
        assert d["token_count"] == 0, d
        assert d["nodes_used"] == [], d["nodes_used"]
        assert d["naive_baseline_tokens"] == 0, d
        assert "no repository indexed" in d["answer"].lower(), d["answer"][:300]

    def test_empty_query_400(self, bearer_token):
        r = _post_query(bearer_token, {"query": "   ", "token_budget": 1000, **SYNTH})
        assert r.status_code == 400, f"{r.status_code}: {r.text[:300]}"
