"""RAPTOR-style tree builder.

Given a list of Chunks + their embeddings and a dict of artifact groupings:
    - Cluster chunks into topics (KMeans, k clamped to n_samples).
    - Assign each artifact to its dominant topic.
    - Summarize each topic with the verbatim Phase-0 prompt (asking for a
      leading "Title: <short>" line so we get a display name for free).
    - Embed topic summaries and cluster into subsystems, summarize each.
    - Root repo node with an overall summary.
    - Every non-leaf node's summary is embedded and stored in the *same*
      Chroma collection so retrieval can hit any level.
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from collections import Counter, defaultdict
from typing import Callable, Dict, List, Optional, Tuple

from llm import call_llm
from models import Chunk, TreeNode

logger = logging.getLogger(__name__)


# --------------------------------------------------------------------------- #
# Prompt (from Phase 0, verbatim body — with a small "Title: ..." preamble)
# --------------------------------------------------------------------------- #
SUMMARIZATION_PROMPT = (
    "Return a short 4-8 word title on the very first line prefixed exactly "
    "with 'Title: ', then a blank line, then the following summary. "
    "You are an expert software engineer and technical writer. Summarize this "
    "cluster of related code/PR chunks into a concise, high-level summary "
    "(max {max_tokens} tokens) that captures its main purpose, key design "
    "decisions/trade-offs, and any clearly represented PRs. Use structured "
    "bullet points. Skip line-by-line code detail — focus on the story of "
    "what this cluster does, why it exists, and how it evolved. "
    "Chunks: {cluster_text}"
)


def _parse_title_and_body(raw: str, fallback_title: str) -> Tuple[str, str]:
    text = (raw or "").strip()
    if not text:
        return fallback_title, ""
    first, _, rest = text.partition("\n")
    first_stripped = first.strip()
    if first_stripped.lower().startswith("title:"):
        title = first_stripped.split(":", 1)[1].strip()
        body = rest.strip()
        if title:
            return title[:80], body or text
    return fallback_title, text


# --------------------------------------------------------------------------- #
# KMeans helper (always clamped)
# --------------------------------------------------------------------------- #
def _kmeans_labels(embeddings, k: int) -> List[int]:
    import numpy as np
    from sklearn.cluster import KMeans

    n = len(embeddings)
    k_eff = max(1, min(k, n))
    if k_eff == 1:
        return [0] * n
    arr = np.asarray(embeddings, dtype="float32")
    km = KMeans(n_clusters=k_eff, n_init=10, random_state=42)
    return km.fit_predict(arr).tolist()


# --------------------------------------------------------------------------- #
# Artifact assembly (grouping chunks by their source PR/issue/file)
# --------------------------------------------------------------------------- #
def build_artifacts(chunks: List[Chunk]) -> Dict[str, dict]:
    """Return artifact_id → {type, title, metadata, chunk_ids}."""
    artifacts: Dict[str, dict] = {}
    for c in chunks:
        if c.type in ("pr_description", "pr_diff", "pr_comment"):
            num = c.metadata.get("pr_number")
            a_id = f"artifact:pr:{num}"
            title = f"PR #{num}: {c.metadata.get('title') or ''}".strip()
            atype = "pr"
        elif c.type == "issue":
            num = c.metadata.get("issue_number")
            a_id = f"artifact:issue:{num}"
            title = f"Issue #{num}: {c.metadata.get('title') or ''}".strip()
            atype = "issue"
        elif c.type == "code":
            path = c.metadata.get("file_path") or c.id
            a_id = f"artifact:file:{path}"
            title = path
            atype = "file"
        else:
            a_id = f"artifact:misc:{c.id}"
            title = c.id
            atype = "misc"

        art = artifacts.setdefault(
            a_id,
            {
                "id": a_id,
                "type": atype,
                "title": title,
                "metadata": {
                    "pr_number": c.metadata.get("pr_number"),
                    "issue_number": c.metadata.get("issue_number"),
                    "file_path": c.metadata.get("file_path"),
                    "html_url": c.metadata.get("html_url"),
                    "author": c.metadata.get("author"),
                    "merged_at": c.metadata.get("merged_at"),
                    "labels": c.metadata.get("labels") or [],
                },
                "chunk_ids": [],
            },
        )
        art["chunk_ids"].append(c.id)
    return artifacts


# --------------------------------------------------------------------------- #
# Cluster-text builder for the LLM prompt
# --------------------------------------------------------------------------- #
def _join_cluster_texts(items: List[str], max_chars: int = 12000) -> str:
    joined = "\n\n---\n\n".join(items)
    return joined[:max_chars]


# --------------------------------------------------------------------------- #
# The build orchestrator
# --------------------------------------------------------------------------- #
async def build_tree(
    *,
    chunks: List[Chunk],
    embeddings: List[List[float]],
    embed_fn: Callable[[List[str]], List[List[float]]],
    repo_owner: str,
    repo_name: str,
    on_progress: Optional[Callable[[str, str], None]] = None,
) -> Tuple[Dict[str, TreeNode], str, Dict[str, List[float]]]:
    """Build the tree and return (nodes, root_id, extra_embeddings).

    extra_embeddings: id -> vector for topic/subsystem/repo node summaries;
    the caller adds these to the same Chroma collection.
    """

    def progress(stage: str, detail: str = ""):
        if on_progress:
            on_progress(stage, detail)
        logger.info("stage=%s detail=%s", stage, detail)

    if len(chunks) != len(embeddings):
        raise ValueError("chunks and embeddings length mismatch")
    if not chunks:
        raise ValueError("no chunks to build tree from")

    # ---- chunk nodes --------------------------------------------------------
    chunk_index: Dict[str, int] = {c.id: i for i, c in enumerate(chunks)}
    chunk_nodes: Dict[str, TreeNode] = {}
    for c in chunks:
        node_id = f"node:chunk:{c.id}"
        chunk_nodes[node_id] = TreeNode(
            id=node_id,
            type="chunk",
            title=(c.metadata.get("file_path") or c.metadata.get("title") or c.id)[:80],
            summary=None,
            content=c.content,
            embedding_id=c.id,
            metadata={"chunk_type": c.type, **c.metadata},
            children=[],
        )

    # ---- artifact nodes -----------------------------------------------------
    progress("clustering", "assembling artifacts")
    artifacts = build_artifacts(chunks)

    # ---- topic clustering on chunks ----------------------------------------
    n = len(chunks)
    k_topics = max(2, min(6, n // 4))
    progress("clustering", f"kmeans topics k={k_topics} n={n}")
    topic_labels = _kmeans_labels(embeddings, k_topics)
    topics_by_id: Dict[int, List[int]] = defaultdict(list)  # topic_lbl -> chunk indices
    for i, lbl in enumerate(topic_labels):
        topics_by_id[lbl].append(i)

    # assign each artifact to its dominant topic
    artifact_topic: Dict[str, int] = {}
    for a_id, art in artifacts.items():
        lbls = [topic_labels[chunk_index[cid]] for cid in art["chunk_ids"] if cid in chunk_index]
        if not lbls:
            continue
        artifact_topic[a_id] = Counter(lbls).most_common(1)[0][0]

    # ---- summarize topics ---------------------------------------------------
    progress("summarizing", f"{len(topics_by_id)} topic summaries")
    topic_nodes: Dict[str, TreeNode] = {}
    topic_id_by_label: Dict[int, str] = {}
    topic_summaries_for_embed: List[str] = []
    topic_ids_ordered: List[str] = []

    async def _summarize_topic(lbl: int, chunk_indices: List[int]):
        # collect a sample of chunk texts (cap length upstream)
        texts = [chunks[i].content for i in chunk_indices]
        cluster_text = _join_cluster_texts(texts)
        prompt = SUMMARIZATION_PROMPT.format(max_tokens=300, cluster_text=cluster_text)
        raw = await call_llm(prompt)
        title, body = _parse_title_and_body(raw, fallback_title=f"Topic {lbl}")
        return lbl, title, body

    topic_results = await asyncio.gather(
        *(_summarize_topic(lbl, idxs) for lbl, idxs in topics_by_id.items())
    )

    for lbl, title, body in topic_results:
        node_id = f"node:topic:{uuid.uuid4().hex[:10]}"
        topic_id_by_label[lbl] = node_id
        topic_ids_ordered.append(node_id)
        topic_summaries_for_embed.append(body or title)
        # assemble children: artifacts assigned to this topic (unique)
        arts_here = [a_id for a_id, t in artifact_topic.items() if t == lbl]
        topic_nodes[node_id] = TreeNode(
            id=node_id,
            type="topic",
            title=title,
            summary=body,
            embedding_id=f"summary:{node_id}",
            metadata={"n_chunks": len(topics_by_id[lbl]), "n_artifacts": len(arts_here)},
            children=[],  # filled after artifact nodes are built
        )
        # placeholder — actual artifact node ids added below

    # ---- build artifact TreeNodes and wire under their topic ---------------
    artifact_nodes: Dict[str, TreeNode] = {}
    for a_id, art in artifacts.items():
        node_id = f"node:artifact:{uuid.uuid4().hex[:10]}"
        lbl = artifact_topic.get(a_id)
        if lbl is None:
            continue
        parent_topic = topic_id_by_label[lbl]
        # chunk children
        child_chunk_nodes = [f"node:chunk:{cid}" for cid in art["chunk_ids"]]
        for ccn in child_chunk_nodes:
            if ccn in chunk_nodes:
                chunk_nodes[ccn].parent = node_id
        artifact_nodes[node_id] = TreeNode(
            id=node_id,
            type="artifact",
            title=art["title"][:120],
            summary=None,
            metadata={"artifact_type": art["type"], **{k: v for k, v in art["metadata"].items() if v is not None}},
            children=child_chunk_nodes,
            parent=parent_topic,
        )
        topic_nodes[parent_topic].children.append(node_id)

    # ---- embed topic summaries + subsystem clustering ----------------------
    progress("embedding", "topic summaries")
    topic_embeddings = await asyncio.to_thread(embed_fn, topic_summaries_for_embed)

    n_topics = len(topic_ids_ordered)
    k_sub = max(2, min(4, n_topics // 2))
    progress("clustering", f"kmeans subsystems k={k_sub} n_topics={n_topics}")
    sub_labels = _kmeans_labels(topic_embeddings, k_sub)
    subs_by_id: Dict[int, List[int]] = defaultdict(list)
    for i, lbl in enumerate(sub_labels):
        subs_by_id[lbl].append(i)

    # ---- summarize subsystems ----------------------------------------------
    progress("summarizing", f"{len(subs_by_id)} subsystem summaries")

    async def _summarize_subsystem(lbl: int, topic_indices: List[int]):
        texts = []
        for ti in topic_indices:
            tn = topic_nodes[topic_ids_ordered[ti]]
            texts.append(f"Topic: {tn.title}\n{tn.summary or ''}")
        cluster_text = _join_cluster_texts(texts)
        prompt = SUMMARIZATION_PROMPT.format(max_tokens=300, cluster_text=cluster_text)
        raw = await call_llm(prompt)
        title, body = _parse_title_and_body(raw, fallback_title=f"Subsystem {lbl}")
        return lbl, title, body

    sub_results = await asyncio.gather(
        *(_summarize_subsystem(lbl, idxs) for lbl, idxs in subs_by_id.items())
    )

    subsystem_nodes: Dict[str, TreeNode] = {}
    subsystem_summaries_for_embed: List[str] = []
    subsystem_ids_ordered: List[str] = []

    for lbl, title, body in sub_results:
        node_id = f"node:subsystem:{uuid.uuid4().hex[:10]}"
        subsystem_ids_ordered.append(node_id)
        subsystem_summaries_for_embed.append(body or title)
        # children = topic nodes assigned to this subsystem
        topic_children = [topic_ids_ordered[i] for i in subs_by_id[lbl]]
        for tid in topic_children:
            topic_nodes[tid].parent = node_id
        subsystem_nodes[node_id] = TreeNode(
            id=node_id,
            type="subsystem",
            title=title,
            summary=body,
            embedding_id=f"summary:{node_id}",
            metadata={"n_topics": len(topic_children)},
            children=topic_children,
        )

    # embed subsystem summaries
    progress("embedding", "subsystem summaries")
    subsystem_embeddings = await asyncio.to_thread(embed_fn, subsystem_summaries_for_embed)

    # ---- root repo summary --------------------------------------------------
    progress("summarizing", "root repo summary")
    root_texts = [
        f"Subsystem: {subsystem_nodes[sid].title}\n{subsystem_nodes[sid].summary or ''}"
        for sid in subsystem_ids_ordered
    ]
    root_prompt = SUMMARIZATION_PROMPT.format(
        max_tokens=300, cluster_text=_join_cluster_texts(root_texts)
    )
    root_raw = await call_llm(root_prompt)
    root_title, root_body = _parse_title_and_body(
        root_raw, fallback_title=f"{repo_owner}/{repo_name}"
    )
    root_id = f"node:repo:{uuid.uuid4().hex[:10]}"

    for sid in subsystem_ids_ordered:
        subsystem_nodes[sid].parent = root_id

    progress("embedding", "root summary")
    root_embedding = await asyncio.to_thread(embed_fn, [root_body or root_title])

    root_node = TreeNode(
        id=root_id,
        type="repo",
        title=f"{repo_owner}/{repo_name}",  # canonical
        summary=root_body,
        embedding_id=f"summary:{root_id}",
        metadata={
            "display_title": root_title,
            "n_subsystems": len(subsystem_nodes),
            "n_topics": len(topic_nodes),
            "n_artifacts": len(artifact_nodes),
            "n_chunks": len(chunk_nodes),
        },
        children=subsystem_ids_ordered,
    )

    # ---- collect everything -------------------------------------------------
    all_nodes: Dict[str, TreeNode] = {}
    all_nodes.update(chunk_nodes)
    all_nodes.update(artifact_nodes)
    all_nodes.update(topic_nodes)
    all_nodes.update(subsystem_nodes)
    all_nodes[root_id] = root_node

    extra_embeddings: Dict[str, List[float]] = {}
    for i, tid in enumerate(topic_ids_ordered):
        extra_embeddings[f"summary:{tid}"] = topic_embeddings[i]
    for i, sid in enumerate(subsystem_ids_ordered):
        extra_embeddings[f"summary:{sid}"] = subsystem_embeddings[i]
    extra_embeddings[f"summary:{root_id}"] = root_embedding[0]

    progress("persisting", "tree assembled")
    return all_nodes, root_id, extra_embeddings
