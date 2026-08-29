import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "@/App.css";

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;
const API = `${BACKEND_URL}/api`;

const DEFAULT_REPO = { owner: "pallets", name: "itsdangerous", paths: "src/itsdangerous" };

// ------------------------- fetch helpers ------------------------- //
async function apiFetch(path, { method = "GET", body, token } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text };
  }
  if (!r.ok) {
    const err = new Error(parsed?.detail || `HTTP ${r.status}`);
    err.status = r.status;
    err.body = parsed;
    throw err;
  }
  return parsed;
}

// ------------------------- top bar ------------------------- //
function TopBar({ health, onRefreshHealth, token, setToken }) {
  const dotCls =
    health.state === "ok"
      ? "cm-dot cm-dot--ok"
      : health.state === "checking"
      ? "cm-dot cm-dot--warn"
      : "cm-dot cm-dot--err";
  return (
    <header className="cm-header" data-testid="app-header">
      <div className="cm-brand">
        <span className="cm-brand-mark">{`{ }`}</span>
        <div>
          <h1 className="cm-title" data-testid="app-title">CodeMemory</h1>
          <p className="cm-subtitle">
            hierarchical token-aware memory over a github repo &nbsp;·&nbsp;
            <span className="cm-tag">phase 1 · ingest + raptor tree</span>
          </p>
        </div>
      </div>
      <div className="cm-header-right">
        <input
          className="cm-input cm-input--slim"
          type="password"
          placeholder="bearer token"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          data-testid="token-input"
          spellCheck={false}
          autoComplete="off"
        />
        <div className="cm-health" data-testid="health-indicator">
          <span className={dotCls} />
          <span className="cm-health-label">api: {health.state}</span>
          <button
            className="cm-btn cm-btn--ghost"
            onClick={onRefreshHealth}
            data-testid="refresh-health-btn"
          >
            refresh
          </button>
        </div>
      </div>
    </header>
  );
}

// ------------------------- repo form ------------------------- //
function RepoForm({ token, onStarted, onLoadExisting, disabled }) {
  const [owner, setOwner] = useState(DEFAULT_REPO.owner);
  const [name, setName] = useState(DEFAULT_REPO.name);
  const [paths, setPaths] = useState(DEFAULT_REPO.paths);
  const [ghToken, setGhToken] = useState("");
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);

  const submit = useCallback(async () => {
    setErr(null);
    setBusy(true);
    try {
      const body = {
        repo_owner: owner.trim(),
        repo_name: name.trim(),
        paths: paths.split(",").map((p) => p.trim()).filter(Boolean),
        github_token: ghToken.trim() || null,
      };
      const status = await apiFetch("/index", { method: "POST", body, token });
      onStarted(status, { owner: body.repo_owner, name: body.repo_name });
    } catch (e) {
      setErr(e.message + (e.status === 409 ? " (409)" : ""));
    } finally {
      setBusy(false);
    }
  }, [owner, name, paths, ghToken, token, onStarted]);

  const loadExisting = useCallback(async () => {
    setErr(null);
    setLoading(true);
    try {
      await onLoadExisting(owner.trim(), name.trim());
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, [owner, name, onLoadExisting]);

  return (
    <section className="cm-panel" data-testid="repo-form">
      <div className="cm-panel-title">repo</div>
      <div className="cm-form-grid">
        <div>
          <label className="cm-label" htmlFor="cm-owner">owner</label>
          <input
            id="cm-owner"
            data-testid="repo-owner-input"
            className="cm-input"
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
            spellCheck={false}
          />
        </div>
        <div>
          <label className="cm-label" htmlFor="cm-name">repo</label>
          <input
            id="cm-name"
            data-testid="repo-name-input"
            className="cm-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            spellCheck={false}
          />
        </div>
        <div className="cm-form-wide">
          <label className="cm-label" htmlFor="cm-paths">paths (comma-separated)</label>
          <input
            id="cm-paths"
            data-testid="repo-paths-input"
            className="cm-input"
            value={paths}
            placeholder="src/itsdangerous, docs"
            onChange={(e) => setPaths(e.target.value)}
            spellCheck={false}
          />
        </div>
        <div className="cm-form-wide">
          <label className="cm-label" htmlFor="cm-ghtok">github token (optional)</label>
          <input
            id="cm-ghtok"
            data-testid="github-token-input"
            className="cm-input"
            type="password"
            value={ghToken}
            placeholder="ghp_… (avoids the 60 req/hr limit)"
            onChange={(e) => setGhToken(e.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
        </div>
      </div>
      <div className="cm-actions">
        <button
          className="cm-btn cm-btn--primary"
          onClick={submit}
          disabled={busy || disabled || !token}
          data-testid="start-index-btn"
        >
          {busy ? "starting…" : disabled ? "indexing…" : "index this repo"}
        </button>
        <button
          className="cm-btn"
          onClick={loadExisting}
          disabled={loading || !token}
          data-testid="load-tree-btn"
        >
          {loading ? "loading…" : "load existing tree"}
        </button>
        {err && (
          <span className="cm-err-inline" data-testid="repo-form-error">
            {err}
          </span>
        )}
      </div>
    </section>
  );
}

// ------------------------- status panel ------------------------- //
const STATUS_COLORS = {
  idle: "cm-dot--muted",
  indexing: "cm-dot--warn",
  complete: "cm-dot--ok",
  failed: "cm-dot--err",
};

function StatusPanel({ status }) {
  const dotCls = `cm-dot ${STATUS_COLORS[status.status] || "cm-dot--muted"}`;
  return (
    <section className="cm-panel" data-testid="status-panel">
      <div className="cm-panel-title">status</div>
      <div className="cm-status-row">
        <span className={dotCls} />
        <span className="cm-status-state" data-testid="status-state">
          {status.status}
        </span>
        {status.repo && (
          <span className="cm-status-repo" data-testid="status-repo">
            {status.repo}
          </span>
        )}
      </div>
      <div className="cm-status-stage" data-testid="status-stage">
        {status.progress?.stage || "—"}
        {status.progress?.detail ? (
          <span className="cm-status-detail"> · {status.progress.detail}</span>
        ) : null}
      </div>
      {status.error && (
        <pre className="cm-pre cm-pre--err cm-status-error" data-testid="status-error">
          {status.error}
        </pre>
      )}
    </section>
  );
}

// ------------------------- tree view ------------------------- //
const TYPE_ORDER = { repo: 0, subsystem: 1, topic: 2, subtopic: 3, artifact: 4, chunk: 5 };

function flattenTree(tree, expanded) {
  const out = [];
  if (!tree?.root_id || !tree?.nodes) return out;
  const stack = [{ id: tree.root_id, depth: 0 }];
  while (stack.length) {
    const { id, depth } = stack.pop();
    const node = tree.nodes[id];
    if (!node) continue;
    out.push({ node, depth });
    if (expanded.has(id) && node.children && node.children.length) {
      const kids = [...node.children].sort((a, b) => {
        const at = TYPE_ORDER[tree.nodes[a] && tree.nodes[a].type] ?? 9;
        const bt = TYPE_ORDER[tree.nodes[b] && tree.nodes[b].type] ?? 9;
        return at - bt;
      });
      for (let i = kids.length - 1; i >= 0; i--) {
        stack.push({ id: kids[i], depth: depth + 1 });
      }
    }
  }
  return out;
}

function TreeRow({ node, depth, isSelected, isOpen, hasChildren, onSelect, onToggle }) {
  return (
    <div
      className={"cm-tree-row cm-tree-row--" + node.type + (isSelected ? " is-selected" : "")}
      style={{ paddingLeft: 8 + depth * 14 }}
      onClick={() => onSelect(node.id)}
      data-testid={"tree-node-" + node.id}
      data-node-type={node.type}
    >
      <button
        className="cm-tree-caret"
        onClick={(e) => { e.stopPropagation(); if (hasChildren) onToggle(node.id); }}
        data-testid={"tree-toggle-" + node.id}
        aria-label={isOpen ? "collapse" : "expand"}
        disabled={!hasChildren}
      >
        {hasChildren ? (isOpen ? "\u25be" : "\u25b8") : "\u00b7"}
      </button>
      <span className={"cm-tree-badge cm-tree-badge--" + node.type}>{node.type}</span>
      <span className="cm-tree-title">{node.title || node.id}</span>
    </div>
  );
}

function TreeSidebar({ tree, selected, onSelect }) {
  const [expanded, setExpanded] = useState(() => new Set());
  const toggle = useCallback((id) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!tree?.root_id) return;
    const initial = new Set([tree.root_id]);
    const root = tree.nodes[tree.root_id];
    for (const cid of (root && root.children) || []) initial.add(cid);
    setExpanded(initial);
  }, [tree?.root_id]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = useMemo(() => flattenTree(tree, expanded), [tree, expanded]);

  if (!tree?.exists || !tree.root_id) {
    return (
      <aside className="cm-panel cm-sidebar" data-testid="tree-sidebar">
        <div className="cm-panel-title">tree</div>
        <div className="cm-empty" data-testid="tree-empty">
          no tree yet — run an index above.
        </div>
      </aside>
    );
  }

  return (
    <aside className="cm-panel cm-sidebar" data-testid="tree-sidebar">
      <div className="cm-panel-title">tree</div>
      <div className="cm-tree-scroll">
        {rows.map(({ node, depth }) => (
          <TreeRow
            key={node.id}
            node={node}
            depth={depth}
            isSelected={selected === node.id}
            isOpen={expanded.has(node.id)}
            hasChildren={(node.children && node.children.length) > 0}
            onSelect={onSelect}
            onToggle={toggle}
          />
        ))}
      </div>
    </aside>
  );
}

// ------------------------- detail pane ------------------------- //
function NodeDetail({ tree, nodeId }) {
  const node = nodeId ? tree?.nodes?.[nodeId] : null;
  if (!node) {
    return (
      <section className="cm-panel cm-detail" data-testid="node-detail">
        <div className="cm-panel-title">detail</div>
        <pre className="cm-pre cm-pre--muted" data-testid="detail-empty">
          {`// select a node in the tree`}
        </pre>
      </section>
    );
  }
  return (
    <section className="cm-panel cm-detail" data-testid="node-detail">
      <div className="cm-detail-head">
        <span className={`cm-tree-badge cm-tree-badge--${node.type}`}>
          {node.type}
        </span>
        <h2 className="cm-detail-title" data-testid="node-title">
          {node.title || node.id}
        </h2>
      </div>
      {node.summary && (
        <>
          <div className="cm-panel-title cm-panel-title--sub">summary</div>
          <pre className="cm-pre" data-testid="node-summary">{node.summary}</pre>
        </>
      )}
      {node.content && (
        <>
          <div className="cm-panel-title cm-panel-title--sub">content</div>
          <pre className="cm-pre cm-pre--code" data-testid="node-content">
            {node.content}
          </pre>
        </>
      )}
      <details className="cm-details">
        <summary>metadata</summary>
        <pre className="cm-pre cm-pre--muted" data-testid="node-metadata">
          {JSON.stringify(node.metadata || {}, null, 2)}
        </pre>
      </details>
    </section>
  );
}

// ------------------------- query panel ------------------------- //
function QueryPanel({ token, currentRepo, treeExists }) {
  const [q, setQ] = useState("How did session handling evolve and why?");
  const [budget, setBudget] = useState(30000);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [result, setResult] = useState(null);
  const [elapsed, setElapsed] = useState(null);

  const run = useCallback(async () => {
    setErr(null); setBusy(true); setResult(null); setElapsed(null);
    const t0 = performance.now();
    try {
      const body = {
        query: q,
        token_budget: Number(budget) || 0,
        repo_owner: currentRepo?.owner,
        repo_name: currentRepo?.name,
      };
      const r = await apiFetch("/query", { method: "POST", body, token });
      setResult(r);
    } catch (e) {
      setErr({ status: e.status, msg: e.message });
    } finally {
      setElapsed(Math.round(performance.now() - t0));
      setBusy(false);
    }
  }, [q, budget, currentRepo, token]);

  const savings = result && result.naive_baseline_tokens > 0
    ? Math.max(0, Math.round((1 - result.token_count / result.naive_baseline_tokens) * 100))
    : null;

  return (
    <section className="cm-panel cm-query-panel" data-testid="query-panel">
      <div className="cm-panel-title">query</div>
      <textarea
        className="cm-input cm-textarea"
        rows={3}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="ask a question about this repo — evolution, why, tradeoffs…"
        data-testid="query-input"
        spellCheck={false}
      />
      <div className="cm-query-controls">
        <label className="cm-inline-label">
          <span className="cm-label">token_budget</span>
          <input
            className="cm-input cm-input--narrow"
            type="number"
            min={0}
            step={1000}
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            data-testid="budget-input"
          />
        </label>
        <button
          className="cm-btn cm-btn--primary"
          onClick={run}
          disabled={busy || !token || !treeExists || !q.trim()}
          data-testid="run-query-btn"
        >
          {busy ? "querying…" : "ask"}
        </button>
        {elapsed != null && (
          <span className="cm-elapsed" data-testid="query-elapsed">
            {(elapsed / 1000).toFixed(2)}s
          </span>
        )}
        {!treeExists && (
          <span className="cm-err-inline">index a repo first</span>
        )}
      </div>

      {err && (
        <pre className="cm-pre cm-pre--err" data-testid="query-error">
          {JSON.stringify(err, null, 2)}
        </pre>
      )}

      {result && (
        <div className="cm-query-result">
          <div className="cm-stats cm-stats--slim" data-testid="query-stats">
            <div className="cm-stat">
              <div className="cm-stat-value" data-testid="stat-token-count">{result.token_count}</div>
              <div className="cm-stat-label">tokens packed</div>
            </div>
            <div className="cm-stat">
              <div className="cm-stat-value" data-testid="stat-baseline">{result.naive_baseline_tokens}</div>
              <div className="cm-stat-label">naive baseline</div>
            </div>
            <div className="cm-stat">
              <div className="cm-stat-value" data-testid="stat-savings">
                {savings == null ? "—" : `${savings}%`}
              </div>
              <div className="cm-stat-label">saved vs naive</div>
            </div>
            <div className="cm-stat">
              <div className="cm-stat-value" data-testid="stat-paths">{result.nodes_used.length}</div>
              <div className="cm-stat-label">node paths cited</div>
            </div>
          </div>

          <div className="cm-panel-title cm-panel-title--sub">answer</div>
          <pre className="cm-pre cm-pre--code" data-testid="query-answer">{result.answer}</pre>

          <details className="cm-details" open>
            <summary>nodes used ({result.nodes_used.length})</summary>
            <ul className="cm-paths-list" data-testid="query-paths">
              {result.nodes_used.map((p, i) => (
                <li key={i} className="cm-path-item">{p}</li>
              ))}
            </ul>
          </details>
        </div>
      )}
    </section>
  );
}

// ------------------------- app ------------------------- //
function App() {
  const [token, setTokenRaw] = useState(
    () => window.localStorage.getItem("codememory_token") || ""
  );
  const setToken = useCallback((v) => {
    setTokenRaw(v);
    window.localStorage.setItem("codememory_token", v);
  }, []);

  const [health, setHealth] = useState({ state: "checking" });
  const [status, setStatus] = useState({
    status: "idle",
    progress: { stage: "idle", detail: "" },
    error: null,
    repo: null,
  });
  const [currentRepo, setCurrentRepo] = useState(DEFAULT_REPO);
  const [tree, setTree] = useState({ exists: false, nodes: {}, root_id: null });
  const [selected, setSelected] = useState(null);

  // ---- health polling (once + button) ----
  const refreshHealth = useCallback(async () => {
    setHealth({ state: "checking" });
    try {
      const r = await apiFetch("/health");
      setHealth({ state: r.status === "ok" ? "ok" : "down" });
    } catch {
      setHealth({ state: "down" });
    }
  }, []);
  useEffect(() => { refreshHealth(); }, [refreshHealth]);

  // ---- fetch tree helper ----
  const loadTree = useCallback(async (owner, name) => {
    if (!token) return;
    try {
      const t = await apiFetch(`/tree?owner=${encodeURIComponent(owner)}&name=${encodeURIComponent(name)}`, { token });
      setTree(t);
      if (t.exists && t.root_id && !selected) setSelected(t.root_id);
    } catch (e) {
      // silent; status panel will surface auth errors on next poll
      console.warn("load tree:", e.message);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // ---- initial status + tree load ----
  useEffect(() => {
    if (!token) return;
    (async () => {
      try {
        const s = await apiFetch("/index/status", { token });
        setStatus(s);
        if (s.repo) {
          const [o, n] = s.repo.split("/");
          if (o && n) {
            setCurrentRepo({ owner: o, name: n, paths: currentRepo.paths });
            loadTree(o, n);
            return;
          }
        }
        loadTree(currentRepo.owner, currentRepo.name);
      } catch (e) {
        // token likely wrong
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // ---- polling while indexing ----
  const pollRef = useRef(null);
  useEffect(() => {
    if (status.status !== "indexing") {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      return;
    }
    pollRef.current = setInterval(async () => {
      try {
        const s = await apiFetch("/index/status", { token });
        setStatus(s);
        if (s.status === "complete") {
          loadTree(currentRepo.owner, currentRepo.name);
          setSelected(null);
        }
      } catch (e) {
        // ignore transient
      }
    }, 1500);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.status, token, currentRepo.owner, currentRepo.name]);

  const onStarted = useCallback((s, repo) => {
    setStatus(s);
    setCurrentRepo((prev) => ({ ...prev, ...repo }));
    setSelected(null);
    setTree({ exists: false, nodes: {}, root_id: null });
  }, []);

  const treeStats = useMemo(() => {
    if (!tree?.exists) return null;
    const counts = {};
    for (const n of Object.values(tree.nodes)) counts[n.type] = (counts[n.type] || 0) + 1;
    return counts;
  }, [tree]);

  return (
    <div className="cm-shell" data-testid="codememory-shell">
      <TopBar
        health={health}
        onRefreshHealth={refreshHealth}
        token={token}
        setToken={setToken}
      />

      <div className="cm-top-grid">
        <RepoForm
          token={token}
          disabled={status.status === "indexing"}
          onStarted={onStarted}
          onLoadExisting={async (o, n) => {
            setCurrentRepo((prev) => ({ ...prev, owner: o, name: n }));
            setSelected(null);
            await loadTree(o, n);
          }}
        />
        <StatusPanel status={status} />
      </div>

      {treeStats && (
        <div className="cm-stats cm-stats--slim" data-testid="tree-stats">
          {Object.entries(treeStats).map(([k, v]) => (
            <div key={k} className="cm-stat" data-testid={`tree-stat-${k}`}>
              <div className="cm-stat-value">{v}</div>
              <div className="cm-stat-label">{k}</div>
            </div>
          ))}
        </div>
      )}

      <QueryPanel token={token} currentRepo={currentRepo} treeExists={!!tree?.exists} />

      <div className="cm-tree-grid">
        <TreeSidebar tree={tree} selected={selected} onSelect={setSelected} />
        <NodeDetail tree={tree} nodeId={selected} />
      </div>

      <footer className="cm-footer">
        <span>backend: {BACKEND_URL || "(unset)"}</span>
        <span>·</span>
        <span>model: openai/gpt-5</span>
        <span>·</span>
        <span>embed: all-MiniLM-L6-v2</span>
      </footer>
    </div>
  );
}

export default App;
