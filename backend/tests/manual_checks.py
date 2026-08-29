"""Ad-hoc checks: dump one POC response + chroma count (run directly, not via pytest)."""
import json
import os
import sys

import chromadb
import requests
from dotenv import dotenv_values

BASE = dotenv_values("/app/frontend/.env")["REACT_APP_BACKEND_URL"].rstrip("/")
TOKEN = "codememory-dev-token-xzcU5a772sHS7PMx8LkLN7Iyj003MDVa"


def chroma_count():
    d = os.environ.get("CHROMA_DIR", "/app/backend/data/chroma").strip('"')
    c = chromadb.PersistentClient(path=d)
    try:
        return c.get_collection("codememory_poc").count()
    except Exception as e:
        return f"ERR: {e}"


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "all"
    if mode in ("all", "poc"):
        r = requests.post(
            f"{BASE}/api/poc",
            headers={"Authorization": f"Bearer {TOKEN}"},
            timeout=180,
        )
        print("STATUS:", r.status_code)
        d = r.json()
        print("KEYS:", sorted(d.keys()))
        print(json.dumps({k: v for k, v in d.items() if k != "sample_summary"}, indent=2))
        print("--- SUMMARY (len=%d) ---" % len(d.get("sample_summary", "")))
        print(d.get("sample_summary", "")[:2500])
    print("CHROMA_COUNT:", chroma_count())
