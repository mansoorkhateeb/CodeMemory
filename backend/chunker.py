"""Chunkers for code files, PRs (description + diff), and issues.

- Each chunk carries deterministic metadata used by the tree (file_path,
  line_range, pr_number, author, merged_at, labels).
- Every chunk is size-capped in tokens (tiktoken) so a huge file or diff can
  never blow up downstream embedding / LLM calls.
"""
from __future__ import annotations

import ast
import re
from typing import Callable, List

import tiktoken

from models import Chunk

# --- tokenizer -------------------------------------------------------------- #
_ENC = tiktoken.get_encoding("o200k_base")


def token_len(text: str) -> int:
    return len(_ENC.encode(text or ""))


def _truncate_to_tokens(text: str, max_tokens: int, marker: str = "\n[truncated]") -> str:
    ids = _ENC.encode(text or "")
    if len(ids) <= max_tokens:
        return text or ""
    kept = _ENC.decode(ids[:max_tokens])
    return kept + marker


CODE_CHUNK_TOKENS = 2000
DIFF_CHUNK_TOKENS = 3000
PR_DESC_CHUNK_TOKENS = 2500
ISSUE_CHUNK_TOKENS = 2500


# --------------------------------------------------------------------------- #
# Python top-level splitter (ast → line ranges)
# --------------------------------------------------------------------------- #
def _split_python_top_level(source: str) -> List[tuple]:
    """Return list of (start_line, end_line, body_text) for top-level def/class,
    plus a single 'module' segment holding everything not inside a def/class."""
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return []

    lines = source.splitlines(keepends=True)
    n_lines = len(lines)
    covered = [False] * n_lines
    segments: List[tuple] = []

    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            start = node.lineno - 1  # 0-based
            end = (getattr(node, "end_lineno", None) or node.lineno) - 1
            for i in range(start, min(end + 1, n_lines)):
                covered[i] = True
            body = "".join(lines[start:end + 1])
            segments.append((start + 1, end + 1, body, node.name))

    # module-level "glue" (imports, top-level statements)
    glue_lines = [lines[i] for i in range(n_lines) if not covered[i]]
    glue = "".join(glue_lines).strip()
    if glue:
        segments.append((1, n_lines, glue, "<module>"))

    # order by start line for readability
    segments.sort(key=lambda s: s[0])
    return segments


def _split_large_text(text: str, max_tokens: int) -> List[str]:
    """Fallback for non-python or oversize segments: split by paragraphs then
    hard-cut. Preserves rough order."""
    parts: List[str] = []
    buf: List[str] = []
    buf_tokens = 0
    for para in re.split(r"\n\s*\n", text or ""):
        pt = token_len(para)
        if pt > max_tokens:
            if buf:
                parts.append("\n\n".join(buf))
                buf, buf_tokens = [], 0
            ids = _ENC.encode(para)
            for i in range(0, len(ids), max_tokens):
                parts.append(_ENC.decode(ids[i:i + max_tokens]))
            continue
        if buf_tokens + pt > max_tokens and buf:
            parts.append("\n\n".join(buf))
            buf, buf_tokens = [], 0
        buf.append(para)
        buf_tokens += pt
    if buf:
        parts.append("\n\n".join(buf))
    return [p for p in parts if p.strip()]


# --------------------------------------------------------------------------- #
# Chunkers
# --------------------------------------------------------------------------- #
def chunk_code_file(path: str, content: str, html_url: str = "") -> List[Chunk]:
    """One chunk per file if small; otherwise split by top-level def/class."""
    if not content:
        return []

    if token_len(content) <= CODE_CHUNK_TOKENS:
        return [
            Chunk(
                id=f"code:{path}",
                type="code",
                content=content,
                metadata={
                    "file_path": path,
                    "line_range": [1, len(content.splitlines()) or 1],
                    "html_url": html_url,
                },
            )
        ]

    chunks: List[Chunk] = []
    is_py = path.lower().endswith((".py", ".pyi"))
    segments = _split_python_top_level(content) if is_py else []

    if segments:
        for idx, (start, end, body, name) in enumerate(segments):
            body = body or ""
            if token_len(body) > CODE_CHUNK_TOKENS:
                for pi, part in enumerate(_split_large_text(body, CODE_CHUNK_TOKENS)):
                    chunks.append(
                        Chunk(
                            id=f"code:{path}#{name}#{idx}.{pi}",
                            type="code",
                            content=part,
                            metadata={
                                "file_path": path,
                                "symbol": name,
                                "line_range": [start, end],
                                "html_url": html_url,
                            },
                        )
                    )
            else:
                chunks.append(
                    Chunk(
                        id=f"code:{path}#{name}#{idx}",
                        type="code",
                        content=body,
                        metadata={
                            "file_path": path,
                            "symbol": name,
                            "line_range": [start, end],
                            "html_url": html_url,
                        },
                    )
                )
    else:
        for pi, part in enumerate(_split_large_text(content, CODE_CHUNK_TOKENS)):
            chunks.append(
                Chunk(
                    id=f"code:{path}#p{pi}",
                    type="code",
                    content=part,
                    metadata={
                        "file_path": path,
                        "part": pi,
                        "html_url": html_url,
                    },
                )
            )
    return chunks


def chunk_pr(pr: dict) -> List[Chunk]:
    """Return [pr_description_chunk, pr_diff_chunk] for a single PR."""
    number = pr["number"]
    title = pr.get("title") or ""
    body = pr.get("body") or ""
    comments = pr.get("comments") or []

    desc_text = f"PR #{number}: {title}\n\n{body}".strip()
    if comments:
        joined = "\n\n".join(comments)
        desc_text += "\n\n---\nComments:\n" + joined

    desc_text = _truncate_to_tokens(desc_text, PR_DESC_CHUNK_TOKENS)

    diff = pr.get("diff") or ""
    diff_text = _truncate_to_tokens(diff, DIFF_CHUNK_TOKENS, marker="\n[diff truncated]")

    common_meta = {
        "pr_number": number,
        "author": pr.get("author"),
        "merged_at": pr.get("merged_at"),
        "labels": pr.get("labels") or [],
        "html_url": pr.get("html_url"),
        "title": title,
    }

    chunks: List[Chunk] = [
        Chunk(
            id=f"pr:{number}:desc",
            type="pr_description",
            content=desc_text,
            metadata=common_meta,
        )
    ]
    if diff_text.strip():
        chunks.append(
            Chunk(
                id=f"pr:{number}:diff",
                type="pr_diff",
                content=f"Diff for PR #{number}: {title}\n\n{diff_text}",
                metadata=common_meta,
            )
        )
    return chunks


def chunk_issue(issue: dict) -> List[Chunk]:
    number = issue["number"]
    title = issue.get("title") or ""
    body = issue.get("body") or ""
    comments = issue.get("comments") or []

    text = f"Issue #{number}: {title}\n\n{body}".strip()
    if comments:
        text += "\n\n---\nComments:\n" + "\n\n".join(comments)
    text = _truncate_to_tokens(text, ISSUE_CHUNK_TOKENS)

    return [
        Chunk(
            id=f"issue:{number}",
            type="issue",
            content=text,
            metadata={
                "issue_number": number,
                "state": issue.get("state"),
                "author": issue.get("author"),
                "labels": issue.get("labels") or [],
                "html_url": issue.get("html_url"),
                "title": title,
            },
        )
    ]
