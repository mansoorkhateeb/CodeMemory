import os
import re
from pathlib import Path

import pytest
import requests
from dotenv import dotenv_values

frontend_env = dotenv_values("/app/frontend/.env")
_base = os.environ.get("REACT_APP_BACKEND_URL") or frontend_env.get("REACT_APP_BACKEND_URL")
if not _base:
    raise RuntimeError("REACT_APP_BACKEND_URL missing from env and /app/frontend/.env")
BASE_URL = _base.rstrip("/")


@pytest.fixture(scope="session")
def base_url():
    return BASE_URL


@pytest.fixture(scope="session")
def bearer_token():
    """Read the shared-secret bearer token from /app/memory/test_credentials.md."""
    p = Path("/app/memory/test_credentials.md")
    if not p.exists():
        pytest.skip("Missing /app/memory/test_credentials.md; report under test_credentials")
    m = re.search(r"Current value:\s*`([^`]+)`", p.read_text(encoding="utf-8"))
    if not m:
        pytest.skip("No bearer token found in test_credentials.md")
    return m.group(1).strip()


@pytest.fixture(scope="session")
def api_client():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="session")
def synth_tree(bearer_token):
    """Persisted synth/webframework tree via GET /api/tree (no LLM cost)."""
    r = requests.get(
        f"{BASE_URL}/api/tree",
        params={"owner": "synth", "name": "webframework"},
        headers={"Authorization": f"Bearer {bearer_token}"},
        timeout=60,
    )
    assert r.status_code == 200, f"GET /api/tree -> {r.status_code}: {r.text[:300]}"
    return r.json()
