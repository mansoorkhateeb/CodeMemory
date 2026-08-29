"""Pydantic models shared by ingestion, tree, and API layers."""
from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field

ChunkType = Literal["code", "pr_description", "pr_comment", "pr_diff", "issue"]
NodeType = Literal["repo", "subsystem", "topic", "subtopic", "artifact", "chunk"]


class Chunk(BaseModel):
    id: str
    type: ChunkType
    content: str
    metadata: Dict[str, Any] = Field(default_factory=dict)


class TreeNode(BaseModel):
    id: str
    type: NodeType
    title: str
    summary: Optional[str] = None
    content: Optional[str] = None
    embedding_id: Optional[str] = None
    metadata: Dict[str, Any] = Field(default_factory=dict)
    children: List[str] = Field(default_factory=list)
    parent: Optional[str] = None


class IndexRequest(BaseModel):
    repo_owner: str
    repo_name: str
    paths: List[str] = Field(default_factory=list)
    github_token: Optional[str] = None


class IndexProgress(BaseModel):
    stage: str = "idle"
    detail: str = ""


class IndexStatus(BaseModel):
    status: Literal["idle", "indexing", "complete", "failed"] = "idle"
    progress: IndexProgress = Field(default_factory=IndexProgress)
    error: Optional[str] = None
    repo: Optional[str] = None
    started_at: Optional[str] = None
    finished_at: Optional[str] = None


class TreeResponse(BaseModel):
    """Flat node map + root id.

    Consumers (web sidebar, VS Code webview) recurse via `nodes[id].children`.
    """
    repo_owner: Optional[str] = None
    repo_name: Optional[str] = None
    root_id: Optional[str] = None
    nodes: Dict[str, TreeNode] = Field(default_factory=dict)
    exists: bool = True


class QueryRequest(BaseModel):
    query: str
    token_budget: int = 30000
    # optional repo scoping — defaults to the last-indexed / only tree
    repo_owner: Optional[str] = None
    repo_name: Optional[str] = None


class QueryResponse(BaseModel):
    answer: str
    nodes_used: List[str] = Field(default_factory=list)
    token_count: int = 0
    naive_baseline_tokens: int = 0
