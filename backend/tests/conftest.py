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
def poc_result(api_client, bearer_token):
    """Run POST /api/poc once per session (real gpt-5 call, ~15-25s) and share."""
    r = api_client.post(
        f"{BASE_URL}/api/poc",
        headers={"Authorization": f"Bearer {bearer_token}"},
        timeout=180,
    )
    return r
