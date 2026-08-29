"""Atomic per-repo tree store (JSON on disk).

- One JSON file per repo: /app/backend/data/trees/{owner}__{repo}.json
- Writes are atomic (tmp + os.replace) → a crashed re-index leaves the
  previous tree fully readable.
- The JSON also holds the name of the Chroma collection it references, so
  atomic replace of the tree JSON is effectively an atomic pointer swap.
"""
from __future__ import annotations

import json
import logging
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Optional

from models import TreeNode

logger = logging.getLogger(__name__)

_TREES_DIR = Path("/app/backend/data/trees")
_TREES_DIR.mkdir(parents=True, exist_ok=True)


def repo_key(owner: str, name: str) -> str:
    safe = re.sub(r"[^a-zA-Z0-9_.-]", "-", f"{owner}__{name}")
    return safe


def tree_path(owner: str, name: str) -> Path:
    return _TREES_DIR / f"{repo_key(owner, name)}.json"


def load(owner: str, name: str) -> Optional[dict]:
    p = tree_path(owner, name)
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        logger.error("corrupt tree file %s: %s", p, e)
        return None


def save(
    *,
    owner: str,
    name: str,
    paths: list,
    collection_name: str,
    root_id: str,
    nodes: Dict[str, TreeNode],
) -> Path:
    """Atomically write the tree JSON. Overwrites any existing file for this repo."""
    payload = {
        "repo_owner": owner,
        "repo_name": name,
        "paths": paths,
        "collection_name": collection_name,
        "root_id": root_id,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "nodes": {nid: n.model_dump() for nid, n in nodes.items()},
    }
    target = tree_path(owner, name)
    fd, tmp_path = tempfile.mkstemp(
        prefix=f".{repo_key(owner, name)}.", suffix=".tmp.json", dir=str(_TREES_DIR)
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False)
        os.replace(tmp_path, target)  # atomic on POSIX
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise
    logger.info("tree saved to %s (%d nodes)", target, len(nodes))
    return target


def previous_collection(owner: str, name: str) -> Optional[str]:
    """Return the collection_name currently referenced by the persisted tree."""
    data = load(owner, name)
    if not data:
        return None
    return data.get("collection_name")
