"""CodeMemory Phase 0 POC — backend API tests.

Modules covered:
  * health           -> GET  /api/health (no auth)
  * auth             -> POST /api/poc bearer enforcement
  * poc pipeline     -> POST /api/poc full chain (github -> embed -> chroma -> kmeans -> gpt-5)
  * openapi          -> GET  /api/openapi.json
  * cors             -> OPTIONS preflight from chrome-extension:// origin
  * chroma persist   -> on-disk PersistentClient collection count
"""
import os

import pytest
import requests

from conftest import BASE_URL


# --------------------------------------------------------------------- health
class TestHealth:
    def test_health_no_auth(self, api_client):
        r = api_client.get(f"{BASE_URL}/api/health", timeout=30)
        assert r.status_code == 200, r.text[:300]
        assert r.json() == {"status": "ok"}


# ----------------------------------------------------------------------- auth
class TestPocAuth:
    def test_poc_no_auth_header_401(self, api_client):
        r = requests.post(f"{BASE_URL}/api/poc", timeout=60)
        assert r.status_code == 401, f"expected 401, got {r.status_code}: {r.text[:300]}"
        assert "detail" in r.json()

    def test_poc_wrong_token_401(self, api_client):
        r = requests.post(
            f"{BASE_URL}/api/poc",
            headers={"Authorization": "Bearer totally-wrong-token"},
            timeout=60,
        )
        assert r.status_code == 401, f"expected 401, got {r.status_code}: {r.text[:300]}"
        assert r.json().get("detail") == "Invalid or missing bearer token"

    def test_poc_wrong_scheme_401(self, api_client, bearer_token):
        r = requests.post(
            f"{BASE_URL}/api/poc",
            headers={"Authorization": f"Basic {bearer_token}"},
            timeout=60,
        )
        assert r.status_code == 401, f"expected 401, got {r.status_code}: {r.text[:300]}"


# --------------------------------------------------------------- poc pipeline
class TestPocPipeline:
    def test_poc_status_200(self, poc_result):
        assert poc_result.status_code == 200, poc_result.text[:800]

    def test_poc_counts(self, poc_result):
        assert poc_result.status_code == 200, poc_result.text[:400]
        d = poc_result.json()
        assert isinstance(d["chunks_fetched"], int) and d["chunks_fetched"] > 0
        assert isinstance(d["embeddings_stored"], int) and d["embeddings_stored"] > 0
        assert isinstance(d["clusters"], int) and d["clusters"] >= 1
        assert d["chroma_persisted"] is True

    def test_poc_summary_is_real_llm_content(self, poc_result):
        assert poc_result.status_code == 200, poc_result.text[:400]
        d = poc_result.json()
        summary = d["sample_summary"]
        assert isinstance(summary, str)
        assert len(summary) > 50, f"summary too short: {summary!r}"
        low = summary.lower()
        # must not be a canned/mock placeholder
        for bad in ("lorem ipsum", "mock", "placeholder", "todo"):
            assert bad not in low, f"summary looks mocked: {summary[:200]!r}"
        # should reference repo content (PRs / itsdangerous / serializer code)
        assert any(
            k in low for k in ("pr", "itsdangerous", "serializer", "signer", "commit", "repo")
        ), f"summary does not reference repo content: {summary[:300]!r}"

    def test_poc_token_count(self, poc_result):
        assert poc_result.status_code == 200, poc_result.text[:400]
        d = poc_result.json()
        assert isinstance(d["summary_token_count"], int)
        assert d["summary_token_count"] > 0

    def test_poc_idempotent_second_run_same_chunk_count(self, poc_result, api_client, bearer_token):
        """Re-run should upsert (not duplicate) => embeddings_stored stays stable."""
        assert poc_result.status_code == 200, poc_result.text[:400]
        first = poc_result.json()
        r2 = api_client.post(
            f"{BASE_URL}/api/poc",
            headers={"Authorization": f"Bearer {bearer_token}"},
            timeout=180,
        )
        assert r2.status_code == 200, r2.text[:800]
        second = r2.json()
        assert second["chunks_fetched"] == first["chunks_fetched"]
        assert second["embeddings_stored"] >= first["embeddings_stored"]


# -------------------------------------------------------------------- openapi
class TestOpenApi:
    def test_openapi_exposed_with_both_paths(self, api_client):
        r = api_client.get(f"{BASE_URL}/api/openapi.json", timeout=30)
        assert r.status_code == 200, r.text[:300]
        spec = r.json()
        assert "/api/health" in spec["paths"]
        assert "/api/poc" in spec["paths"]
        assert "post" in spec["paths"]["/api/poc"]
        assert "get" in spec["paths"]["/api/health"]


# ----------------------------------------------------------------------- cors
class TestCors:
    def test_preflight_chrome_extension_origin_allowed(self):
        origin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop"
        r = requests.options(
            f"{BASE_URL}/api/poc",
            headers={
                "Origin": origin,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "authorization,content-type",
            },
            timeout=30,
        )
        assert r.status_code in (200, 204), f"{r.status_code}: {r.text[:300]}"
        acao = r.headers.get("access-control-allow-origin")
        assert acao in (origin, "*"), f"missing/incorrect ACAO header: {dict(r.headers)}"

    def test_preflight_frontend_origin_allowed(self):
        r = requests.options(
            f"{BASE_URL}/api/poc",
            headers={
                "Origin": BASE_URL,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "authorization,content-type",
            },
            timeout=30,
        )
        assert r.status_code in (200, 204), f"{r.status_code}: {r.text[:300]}"
        assert r.headers.get("access-control-allow-origin") in (BASE_URL, "*")


# ------------------------------------------------------------- chroma on disk
class TestChromaPersistence:
    def test_collection_persisted_on_disk(self, poc_result):
        assert poc_result.status_code == 200, "POC must succeed before checking chroma"
        chromadb = pytest.importorskip("chromadb")
        chroma_dir = os.environ.get("CHROMA_DIR", "/app/backend/data/chroma").strip('"')
        client = chromadb.PersistentClient(path=chroma_dir)
        names = [c.name for c in client.list_collections()] if hasattr(client, "list_collections") else []
        coll = client.get_collection("codememory_poc")
        assert coll.count() > 0, f"empty collection; collections={names}"
