import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "@/App.css";

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;
const API = `${BACKEND_URL}/api`;
const DEFAULT_REPO = { owner: "pallets", name: "itsdangerous", paths: "src/itsdangerous" };

// -------------------- fetch helper -------------------- //
async function apiFetch(path, { method = "GET", body, token, timeout = 45000 } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeout);
  try {
    const headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const r = await fetch(`${API}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await r.text();
    let parsed;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
    if (!r.ok) {
      const err = new Error((parsed && parsed.detail) || `HTTP ${r.status}`);
      err.status = r.status;
      err.body = parsed;
      throw err;
    }
    return parsed;
  } catch (e) {
    if (e.name === "AbortError") {
      const err = new Error("Request timed out");
      err.status = "timeout";
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
}

// -------------------- bulletproof download helper -------------------- //
// Blob-based programmatic download. Works regardless of:
//   - cross-origin href (the `download` attr is ignored cross-origin in Chrome)
//   - Content-Disposition (inline vs attachment)
//   - parent handlers calling preventDefault (modals, routers)
async function downloadFile(url, filename, { timeout = 30000 } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeout);
  try {
    const r = await fetch(url, { signal: controller.signal, credentials: "omit" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const blob = await r.blob();
    // eslint-disable-next-line no-console
    console.log("[downloadFile]", filename, "bytes=", blob.size, "type=", blob.type);
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objUrl;
    a.download = filename;
    a.rel = "noopener";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    // Give the browser a tick to consume the click before we revoke.
    setTimeout(() => {
      URL.revokeObjectURL(objUrl);
      a.remove();
    }, 250);
    return blob.size;
  } finally { clearTimeout(t); }
}

function DownloadButton({ url, filename, testid, children, className = "cm-btn" }) {
  const [state, setState] = useState("idle"); // idle | busy | err
  const [err, setErr] = useState(null);
  const onClick = useCallback(async (e) => {
    e.preventDefault();
    e.stopPropagation();
    setState("busy"); setErr(null);
    try {
      const size = await downloadFile(url, filename);
      setState("idle");
      // brief visible confirmation via title attr for a couple seconds
      // eslint-disable-next-line no-console
      console.log("[downloaded]", filename, size, "bytes");
    } catch (ex) {
      setState("err"); setErr(ex.message || String(ex));
      setTimeout(() => setState("idle"), 4000);
    }
  }, [url, filename]);
  return (
    <>
      <button
        type="button"
        className={className + (state === "busy" ? " is-busy" : "")}
        onClick={onClick}
        disabled={state === "busy"}
        data-testid={testid}
        data-download-state={state}
      >
        {state === "busy" ? "downloading…" : state === "err" ? "retry download" : children}
      </button>
      {state === "err" && err && (
        <span className="cm-err-inline" data-testid={testid + "-error"}>
          download failed: {err}
        </span>
      )}
    </>
  );
}

// -------------------- tiny markdown renderer (guide only) -------------------- //
function renderMarkdown(md) {
  const lines = (md || "").split("\n");
  const out = [];
  let i = 0;
  const inlineFmt = (s) =>
    s
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  while (i < lines.length) {
    const line = lines[i];
    if (/^#\s+/.test(line))      { out.push(`<h1>${inlineFmt(line.slice(2))}</h1>`); i++; continue; }
    if (/^##\s+/.test(line))     { out.push(`<h2>${inlineFmt(line.slice(3))}</h2>`); i++; continue; }
    if (/^###\s+/.test(line))    { out.push(`<h3>${inlineFmt(line.slice(4))}</h3>`); i++; continue; }
    if (/^---\s*$/.test(line))   { out.push("<hr/>"); i++; continue; }
    if (/^\s*$/.test(line))      { i++; continue; }
    // table: header row + separator row
    if (/^\|.*\|$/.test(line) && i + 1 < lines.length && /^\|[\s:|-]+\|$/.test(lines[i + 1])) {
      const headers = line.slice(1, -1).split("|").map(s => s.trim());
      i += 2;
      const rows = [];
      while (i < lines.length && /^\|.*\|$/.test(lines[i])) {
        rows.push(lines[i].slice(1, -1).split("|").map(s => s.trim()));
        i++;
      }
      out.push(
        `<table><thead><tr>${headers.map(h => `<th>${inlineFmt(h)}</th>`).join("")}</tr></thead>` +
        `<tbody>${rows.map(r => `<tr>${r.map(c => `<td>${inlineFmt(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`
      );
      continue;
    }
    // ordered list
    if (/^\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s+/, "")); i++;
      }
      out.push(`<ol>${items.map(x => `<li>${inlineFmt(x)}</li>`).join("")}</ol>`);
      continue;
    }
    // unordered list
    if (/^-\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^-\s+/.test(lines[i])) {
        items.push(lines[i].slice(2)); i++;
      }
      out.push(`<ul>${items.map(x => `<li>${inlineFmt(x)}</li>`).join("")}</ul>`);
      continue;
    }
    // paragraph
    const buf = [];
    while (i < lines.length && !/^(#|##|###|-\s|\d+\.\s|---|\|)/.test(lines[i]) && !/^\s*$/.test(lines[i])) {
      buf.push(lines[i]); i++;
    }
    if (buf.length) out.push(`<p>${inlineFmt(buf.join(" "))}</p>`);
  }
  return out.join("\n");
}

function GuideModal({ onClose }) {
  const [md, setMd] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`${API}/downloads/guide`);
        if (!r.ok) throw new Error("HTTP " + r.status);
        setMd(await r.text());
      } catch (e) { setErr(e.message); }
    })();
  }, []);
  const html = useMemo(() => (md ? renderMarkdown(md) : null), [md]);
  return (
    <div className="cm-modal-backdrop" onClick={onClose} data-testid="guide-modal">
      <div className="cm-modal" onClick={(e) => e.stopPropagation()}>
        <div className="cm-modal-head">
          <div className="cm-panel-title" style={{ margin: 0 }}>user guide</div>
          <div style={{ display: "flex", gap: 8 }}>
            <DownloadButton
              url={`${API}/downloads/guide?dl=1`}
              filename="CodeMemory-user-guide.md"
              testid="guide-download-md"
              className="cm-btn cm-btn--ghost"
            >
              download .md
            </DownloadButton>
            <button className="cm-btn cm-btn--ghost" onClick={onClose} data-testid="guide-close">close</button>
          </div>
        </div>
        <div className="cm-modal-body">
          {err && <div className="cm-banner cm-banner--err">could not load guide: {err}</div>}
          {!md && !err && <div className="cm-empty">loading…</div>}
          {html && <div className="cm-md" dangerouslySetInnerHTML={{ __html: html }} data-testid="guide-content" />}
        </div>
      </div>
    </div>
  );
}

// -------------------- top bar & settings -------------------- //
function TopBar({ health, onRefreshHealth, authOk, onToggleSettings, settingsOpen, onOpenGuide }) {
  const dotCls =
    health.state === "ok" ? "cm-dot cm-dot--ok" :
    health.state === "checking" ? "cm-dot cm-dot--warn" : "cm-dot cm-dot--err";
  return (
    <header className="cm-header" data-testid="app-header">
      <div className="cm-brand">
        <span className="cm-brand-mark">{`{ }`}</span>
        <div>
          <h1 className="cm-title" data-testid="app-title">CodeMemory</h1>
          <p className="cm-subtitle">
            hierarchical token-aware memory over a github repo &nbsp;·&nbsp;
            <span className="cm-tag">phase 3 · web ui</span>
          </p>
        </div>
      </div>
      <div className="cm-header-right">
        <div className="cm-health" data-testid="health-indicator">
          <span className={dotCls} />
          <span className="cm-health-label">api: {health.state}</span>
          <button className="cm-btn cm-btn--ghost" onClick={onRefreshHealth} data-testid="refresh-health-btn">
            refresh
          </button>
        </div>
        <div className={"cm-auth-chip" + (authOk === false ? " is-bad" : authOk ? " is-ok" : "")}
             data-testid="auth-chip"
             data-auth-state={authOk === false ? "bad" : authOk === true ? "ok" : "unknown"}>
          <span className="cm-dot"
                style={{
                  background: authOk === false ? "var(--cm-err)" : authOk ? "var(--cm-ok)" : "var(--cm-fg-muted)",
                  color: "inherit",
                }} />
          <span>{authOk === false ? "token: invalid" : authOk ? "token: ok" : "token: unknown"}</span>
        </div>
        <button
          className="cm-btn cm-btn--ghost"
          onClick={onOpenGuide}
          data-testid="guide-toggle"
        >
          guide
        </button>
        <button
          className={"cm-btn cm-btn--ghost" + (settingsOpen ? " is-active" : "")}
          onClick={onToggleSettings}
          data-testid="settings-toggle"
          aria-expanded={settingsOpen}
        >
          settings
        </button>
      </div>
    </header>
  );
}

function SettingsPanel({ token, setToken, onClose }) {
  const [local, setLocal] = useState(token);
  useEffect(() => { setLocal(token); }, [token]);
  return (
    <div className="cm-settings" data-testid="settings-panel">
      <div className="cm-panel-title">settings</div>
      <label class="cm-label" htmlFor="cm-token">CodeMemory API token (app password)</label>
      <div className="cm-settings-row">
        <input
          id="cm-token"
          className="cm-input"
          type="password"
          value={local}
          placeholder="CODEMEMORY_API_TOKEN"
          onChange={(e) => setLocal(e.target.value)}
          data-testid="token-input"
          spellCheck={false}
          autoComplete="off"
        />
        <button
          className="cm-btn cm-btn--primary"
          onClick={() => { setToken(local); onClose(); }}
          data-testid="save-token-btn"
        >
          save
        </button>
      </div>
      <p className="cm-hint">not your GitHub token · stored in localStorage · required for every non-/health endpoint</p>
    </div>
  );
}

// -------------------- tree sidebar -------------------- //
const TYPE_ORDER = { repo: 0, subsystem: 1, topic: 2, subtopic: 3, artifact: 4, chunk: 5 };

function flattenTree(tree, expanded) {
  const out = [];
  if (!tree || !tree.root_id || !tree.nodes) return out;
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
      for (let i = kids.length - 1; i >= 0; i--) stack.push({ id: kids[i], depth: depth + 1 });
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

function AppSidebar({ tree, treeLoading, treeError, selected, onSelect, currentRepo }) {
  const [expanded, setExpanded] = useState(() => new Set());
  const toggle = useCallback((id) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!tree || !tree.root_id) return;
    const initial = new Set([tree.root_id]);
    const root = tree.nodes[tree.root_id];
    for (const cid of (root && root.children) || []) initial.add(cid);
    setExpanded(initial);
  }, [tree?.root_id]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = useMemo(() => flattenTree(tree, expanded), [tree, expanded]);

  return (
    <aside className="cm-sidebar" data-testid="tree-sidebar">
      <div className="cm-sidebar-head">
        <div className="cm-panel-title">tree</div>
        {currentRepo && (
          <div className="cm-sidebar-repo" data-testid="sidebar-repo">
            {currentRepo.owner}/{currentRepo.name}
          </div>
        )}
      </div>
      <div className="cm-tree-scroll">
        {treeLoading && (
          <div className="cm-skeletons" data-testid="tree-loading">
            <div className="cm-skel" /><div className="cm-skel" /><div className="cm-skel" />
          </div>
        )}
        {!treeLoading && treeError && (
          <div className="cm-empty cm-empty--err" data-testid="tree-error">{treeError}</div>
        )}
        {!treeLoading && !treeError && (!tree || !tree.exists || !tree.root_id) && (
          <div className="cm-empty" data-testid="tree-empty">
            no tree for this repo yet.<br />
            open <b>home</b> and click <em>index this repo</em> or <em>load existing tree</em>.
          </div>
        )}
        {!treeLoading && !treeError && rows.map(({ node, depth }) => (
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

// -------------------- home / index page -------------------- //
function RepoForm({ token, disabled, onStarted, onLoadExisting }) {
  const [owner, setOwner] = useState(DEFAULT_REPO.owner);
  const [name, setName] = useState(DEFAULT_REPO.name);
  const [paths, setPaths] = useState(DEFAULT_REPO.paths);
  const [ghToken, setGhToken] = useState("");
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);

  const submit = useCallback(async () => {
    setErr(null); setBusy(true);
    try {
      const body = {
        repo_owner: owner.trim(),
        repo_name: name.trim(),
        paths: paths.split(",").map((p) => p.trim()).filter(Boolean),
        github_token: ghToken.trim() || null,
      };
      const status = await apiFetch("/index", { method: "POST", body, token, timeout: 15000 });
      onStarted(status, { owner: body.repo_owner, name: body.repo_name });
    } catch (e) {
      setErr(e.message + (e.status === 409 ? " (409)" : e.status === 401 ? " (401)" : ""));
    } finally { setBusy(false); }
  }, [owner, name, paths, ghToken, token, onStarted]);

  const loadExisting = useCallback(async () => {
    setErr(null); setLoading(true);
    try { await onLoadExisting(owner.trim(), name.trim()); }
    catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  }, [owner, name, onLoadExisting]);

  return (
    <section className="cm-panel" data-testid="repo-form">
      <div className="cm-panel-title">repo</div>
      <div className="cm-form-grid">
        <div>
          <label className="cm-label" htmlFor="cm-owner">owner</label>
          <input id="cm-owner" data-testid="repo-owner-input" className="cm-input"
                 value={owner} onChange={(e) => setOwner(e.target.value)} spellCheck={false} />
        </div>
        <div>
          <label className="cm-label" htmlFor="cm-name">repo</label>
          <input id="cm-name" data-testid="repo-name-input" className="cm-input"
                 value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} />
        </div>
        <div className="cm-form-wide">
          <label className="cm-label" htmlFor="cm-paths">paths (comma-separated)</label>
          <input id="cm-paths" data-testid="repo-paths-input" className="cm-input"
                 value={paths} onChange={(e) => setPaths(e.target.value)} spellCheck={false} />
        </div>
        <div className="cm-form-wide">
          <label className="cm-label" htmlFor="cm-ghtok">github token (optional — only for indexing real GitHub repos)</label>
          <input id="cm-ghtok" data-testid="github-token-input" className="cm-input" type="password"
                 value={ghToken} placeholder="ghp_… (avoids the 60 req/hr limit)"
                 onChange={(e) => setGhToken(e.target.value)} spellCheck={false} autoComplete="off" />
        </div>
      </div>
      <div className="cm-actions">
        <button className="cm-btn cm-btn--primary" onClick={submit}
                disabled={busy || disabled || !token}
                data-testid="start-index-btn">
          {busy ? "starting…" : disabled ? "indexing…" : "index this repo"}
        </button>
        <button className="cm-btn" onClick={loadExisting}
                disabled={loading || !token}
                data-testid="load-tree-btn">
          {loading ? "loading…" : "load existing tree"}
        </button>
        {err && <span className="cm-err-inline" data-testid="repo-form-error">{err}</span>}
      </div>
    </section>
  );
}

const STATUS_COLORS = { idle: "cm-dot--muted", indexing: "cm-dot--warn", complete: "cm-dot--ok", failed: "cm-dot--err" };

function StatusPanel({ status }) {
  const dotCls = "cm-dot " + (STATUS_COLORS[status.status] || "cm-dot--muted");
  return (
    <section className="cm-panel" data-testid="status-panel">
      <div className="cm-panel-title">status</div>
      <div className="cm-status-row">
        <span className={dotCls} />
        <span className="cm-status-state" data-testid="status-state">{status.status}</span>
        {status.repo && <span className="cm-status-repo" data-testid="status-repo">{status.repo}</span>}
      </div>
      <div className="cm-status-stage" data-testid="status-stage">
        {(status.progress && status.progress.stage) || "—"}
        {status.progress && status.progress.detail
          ? <span className="cm-status-detail"> · {status.progress.detail}</span>
          : null}
      </div>
      {status.error && (
        <pre className="cm-pre cm-pre--err cm-status-error" data-testid="status-error">
          {status.error}
        </pre>
      )}
    </section>
  );
}

function TreeStats({ tree }) {
  if (!tree || !tree.exists) return null;
  const counts = {};
  for (const n of Object.values(tree.nodes)) counts[n.type] = (counts[n.type] || 0) + 1;
  return (
    <div className="cm-stats cm-stats--slim" data-testid="tree-stats">
      {Object.entries(counts).map(([k, v]) => (
        <div key={k} className="cm-stat" data-testid={`tree-stat-${k}`}>
          <div className="cm-stat-value">{v}</div>
          <div className="cm-stat-label">{k}</div>
        </div>
      ))}
    </div>
  );
}

function HomePage({ token, status, tree, onStarted, onLoadExisting }) {
  const chromeUrl = `${API}/downloads/chrome`;
  const vscodeUrl = `${API}/downloads/vscode`;
  return (
    <div className="cm-view cm-view--home" data-testid="home-view">
      <div className="cm-home-grid">
        <RepoForm
          token={token}
          disabled={status.status === "indexing"}
          onStarted={onStarted}
          onLoadExisting={onLoadExisting}
        />
        <StatusPanel status={status} />
      </div>
      <TreeStats tree={tree} />
      <section className="cm-panel" data-testid="downloads-panel">
        <div className="cm-panel-title">get the extensions</div>
        <div className="cm-actions" style={{ marginTop: 0 }}>
          <DownloadButton
            url={chromeUrl}
            filename="codememory-chrome.zip"
            testid="download-chrome-btn"
          >
            ↓ Chrome extension (.zip)
          </DownloadButton>
          <DownloadButton
            url={vscodeUrl}
            filename="codememory-vscode.vsix"
            testid="download-vscode-btn"
          >
            ↓ VS Code extension (.vsix)
          </DownloadButton>
          <DownloadButton
            url={`${API}/downloads/guide?dl=1`}
            filename="CodeMemory-user-guide.md"
            testid="download-guide-md"
          >
            ↓ User guide (.md)
          </DownloadButton>
          <span className="cm-hint" style={{ margin: 0 }}>
            no auth required · configure the backend URL + your bearer token after install
          </span>
        </div>
      </section>
    </div>
  );
}

// -------------------- query page -------------------- //
function QueryPage({ token, currentRepo, treeExists }) {
  const [q, setQ] = useState("How did session handling evolve and why?");
  const [budget, setBudget] = useState(30000);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [result, setResult] = useState(null);
  const [elapsed, setElapsed] = useState(null);

  const run = useCallback(async () => {
    if (!treeExists) { setErr({ status: "not-indexed", msg: "no tree for this repo — index one first (Home tab)" }); return; }
    setErr(null); setBusy(true); setResult(null); setElapsed(null);
    const t0 = performance.now();
    try {
      const body = {
        query: q,
        token_budget: Number(budget) || 0,
        repo_owner: currentRepo && currentRepo.owner,
        repo_name: currentRepo && currentRepo.name,
      };
      const r = await apiFetch("/query", { method: "POST", body, token, timeout: 90000 });
      setResult(r);
    } catch (e) {
      let msg = e.message;
      if (e.status === 401) msg = "invalid or missing bearer token — open settings";
      if (e.status === 502) msg = "LLM call failed (502) — try again in a moment";
      if (e.status === "timeout") msg = "request timed out — try a smaller token_budget or retry";
      setErr({ status: e.status, msg });
    } finally {
      setElapsed(Math.round(performance.now() - t0));
      setBusy(false);
    }
  }, [q, budget, currentRepo, token, treeExists]);

  const savings = result && result.naive_baseline_tokens > 0
    ? Math.max(0, Math.round((1 - result.token_count / result.naive_baseline_tokens) * 100))
    : null;

  return (
    <div className="cm-view cm-view--query" data-testid="query-view">
      <section className="cm-panel cm-query-panel">
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
            disabled={busy || !token || !q.trim()}
            data-testid="run-query-btn"
          >
            {busy ? "querying…" : "ask"}
          </button>
          {elapsed != null && <span className="cm-elapsed" data-testid="query-elapsed">{(elapsed/1000).toFixed(2)}s</span>}
          {!treeExists && <span className="cm-err-inline">no tree — index first</span>}
        </div>

        {busy && (
          <div className="cm-skeletons cm-skeletons--wide" data-testid="query-loading">
            <div className="cm-skel cm-skel--tall" />
            <div className="cm-skel" /><div className="cm-skel" />
          </div>
        )}

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
                <div className="cm-stat-label">node paths</div>
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
    </div>
  );
}

// -------------------- node detail page -------------------- //
function NodeDetailPage({ tree, nodeId, onClearSelection }) {
  const node = nodeId && tree && tree.nodes ? tree.nodes[nodeId] : null;
  if (!node) {
    return (
      <div className="cm-view" data-testid="node-view">
        <section className="cm-panel">
          <div className="cm-panel-title">detail</div>
          <div className="cm-empty" data-testid="detail-empty">
            select a node in the tree sidebar to see its title, summary, content and metadata.
          </div>
        </section>
      </div>
    );
  }
  const meta = node.metadata || {};
  return (
    <div className="cm-view" data-testid="node-view">
      <section className="cm-panel cm-detail">
        <div className="cm-detail-head">
          <span className={"cm-tree-badge cm-tree-badge--" + node.type}>{node.type}</span>
          <h2 className="cm-detail-title" data-testid="node-title">{node.title || node.id}</h2>
          <button className="cm-btn cm-btn--ghost" onClick={onClearSelection} data-testid="clear-selection-btn">
            close
          </button>
        </div>

        {(meta.pr_number || meta.issue_number || meta.file_path || meta.author || meta.merged_at || meta.html_url) && (
          <div className="cm-meta-strip" data-testid="node-meta-strip">
            {meta.pr_number && <span className="cm-meta">PR #{meta.pr_number}</span>}
            {meta.issue_number && <span className="cm-meta">Issue #{meta.issue_number}</span>}
            {meta.file_path && <span className="cm-meta">{meta.file_path}</span>}
            {meta.author && <span className="cm-meta">by @{meta.author}</span>}
            {meta.merged_at && <span className="cm-meta">merged {String(meta.merged_at).slice(0,10)}</span>}
            {meta.html_url && meta.html_url.startsWith("http") && (
              <a className="cm-meta cm-meta--link" href={meta.html_url} target="_blank" rel="noreferrer noopener">
                github ↗
              </a>
            )}
          </div>
        )}

        {node.summary && (
          <>
            <div className="cm-panel-title cm-panel-title--sub">summary</div>
            <pre className="cm-pre" data-testid="node-summary">{node.summary}</pre>
          </>
        )}
        {node.content && (
          <>
            <div className="cm-panel-title cm-panel-title--sub">content</div>
            <pre className="cm-pre cm-pre--code" data-testid="node-content">{node.content}</pre>
          </>
        )}
        <details className="cm-details">
          <summary>raw metadata</summary>
          <pre className="cm-pre cm-pre--muted" data-testid="node-metadata">
            {JSON.stringify(node.metadata || {}, null, 2)}
          </pre>
        </details>
      </section>
    </div>
  );
}

// -------------------- global banners -------------------- //
function GlobalBanners({ health, authOk, token }) {
  const banners = [];
  if (health.state === "down") {
    banners.push(
      <div key="be" className="cm-banner cm-banner--err" data-testid="banner-backend-down">
        backend unreachable — check that /api/health responds
      </div>
    );
  }
  if (!token) {
    banners.push(
      <div key="notoken" className="cm-banner cm-banner--warn" data-testid="banner-no-token">
        no bearer token set — open <b>settings</b> and paste your CODEMEMORY_API_TOKEN
      </div>
    );
  } else if (authOk === false) {
    banners.push(
      <div key="badtoken" className="cm-banner cm-banner--err" data-testid="banner-auth-error">
        the bearer token was rejected (401) — open <b>settings</b> to fix
      </div>
    );
  }
  if (banners.length === 0) return null;
  return <div className="cm-banners">{banners}</div>;
}

// -------------------- app -------------------- //
function App() {
  const [token, setTokenRaw] = useState(() => window.localStorage.getItem("codememory_token") || "");
  const setToken = useCallback((v) => {
    setTokenRaw(v);
    window.localStorage.setItem("codememory_token", v || "");
  }, []);

  const [health, setHealth] = useState({ state: "checking" });
  const [authOk, setAuthOk] = useState(null); // null=unknown, true=ok, false=rejected
  const [settingsOpen, setSettingsOpen] = useState(!token);
  const [guideOpen, setGuideOpen] = useState(false);

  const [status, setStatus] = useState({
    status: "idle",
    progress: { stage: "idle", detail: "" },
    error: null,
    repo: null,
  });
  const [currentRepo, setCurrentRepo] = useState(DEFAULT_REPO);
  const [tree, setTree] = useState({ exists: false, nodes: {}, root_id: null });
  const [treeLoading, setTreeLoading] = useState(false);
  const [treeError, setTreeError] = useState(null);

  const [view, setView] = useState("home"); // "home" | "query" | "node"
  const [selected, setSelected] = useState(null);

  // ---- health poll ----
  const refreshHealth = useCallback(async () => {
    setHealth({ state: "checking" });
    try {
      const r = await apiFetch("/health", { timeout: 6000 });
      setHealth({ state: r.status === "ok" ? "ok" : "down" });
    } catch { setHealth({ state: "down" }); }
  }, []);
  useEffect(() => { refreshHealth(); }, [refreshHealth]);

  // ---- auth probe (whenever token changes) ----
  useEffect(() => {
    if (!token) { setAuthOk(null); return; }
    let cancelled = false;
    (async () => {
      try {
        await apiFetch("/index/status", { token, timeout: 8000 });
        if (!cancelled) setAuthOk(true);
      } catch (e) {
        if (cancelled) return;
        setAuthOk(e.status === 401 ? false : null);
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  // ---- tree loader with staleness guards ------------------------------------
  //   - monotonic request-id: only the most recent loadTree() sets state
  //   - currentRepoRef: drop any response whose (owner,name) no longer matches
  //     the repo the user is currently viewing (order-independent guarantee)
  const treeReqIdRef = useRef(0);
  const currentRepoRef = useRef({ owner: DEFAULT_REPO.owner, name: DEFAULT_REPO.name });
  const userHasSelectedRepoRef = useRef(false);

  const loadTree = useCallback(async (owner, name) => {
    if (!token) return;
    const myReqId = ++treeReqIdRef.current;
    setTreeLoading(true); setTreeError(null);
    try {
      const t = await apiFetch(
        `/tree?owner=${encodeURIComponent(owner)}&name=${encodeURIComponent(name)}`,
        { token, timeout: 12000 }
      );
      // Drop if a newer loadTree() has been queued since we started.
      if (myReqId !== treeReqIdRef.current) return;
      // Drop if this response is for a repo the user is no longer viewing —
      // the reliable invariant (order-independent).
      const cur = currentRepoRef.current;
      if (cur && (owner !== cur.owner || name !== cur.name)) return;
      setTree(t);
    } catch (e) {
      if (myReqId !== treeReqIdRef.current) return;
      const cur = currentRepoRef.current;
      if (cur && (owner !== cur.owner || name !== cur.name)) return;
      setTree({ exists: false, nodes: {}, root_id: null });
      setTreeError(e.status === 401 ? "invalid bearer token" : e.message);
    } finally {
      if (myReqId === treeReqIdRef.current) setTreeLoading(false);
    }
  }, [token]);

  // ---- initial status + tree load ----
  useEffect(() => {
    if (!token) return;
    (async () => {
      try {
        const s = await apiFetch("/index/status", { token, timeout: 8000 });
        setStatus(s);
        // If the user has already selected a repo during the await above,
        // skip the mount-time default load — their selection wins.
        if (userHasSelectedRepoRef.current) return;
        if (s.repo) {
          const [o, n] = s.repo.split("/");
          if (o && n) {
            currentRepoRef.current = { owner: o, name: n };
            setCurrentRepo((prev) => ({ ...prev, owner: o, name: n }));
            loadTree(o, n);
            return;
          }
        }
        currentRepoRef.current = { owner: currentRepo.owner, name: currentRepo.name };
        loadTree(currentRepo.owner, currentRepo.name);
      } catch {
        /* auth probe surfaces */
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
        const s = await apiFetch("/index/status", { token, timeout: 6000 });
        setStatus(s);
        if (s.status === "complete") {
          loadTree(currentRepo.owner, currentRepo.name);
          setSelected(null);
        }
      } catch { /* transient */ }
    }, 1500);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.status, token, currentRepo.owner, currentRepo.name]);

  const onLoadExisting = useCallback(async (o, n) => {
    // Synchronously mark the user selection so any in-flight mount-default
    // loadTree responses are dropped when they resolve.
    userHasSelectedRepoRef.current = true;
    currentRepoRef.current = { owner: o, name: n };
    setCurrentRepo((prev) => ({ ...prev, owner: o, name: n }));
    setSelected(null);
    await loadTree(o, n);
  }, [loadTree]);

  const onStarted = useCallback((s, repo) => {
    setStatus(s);
    userHasSelectedRepoRef.current = true;
    currentRepoRef.current = { owner: repo.owner, name: repo.name };
    setCurrentRepo((prev) => ({ ...prev, ...repo }));
    setSelected(null);
    setTree({ exists: false, nodes: {}, root_id: null });
  }, []);

  const handleTreeSelect = useCallback((id) => {
    setSelected(id);
    setView("node");
  }, []);

  const selectedNode = selected && tree.nodes ? tree.nodes[selected] : null;

  return (
    <div className="cm-app" data-testid="codememory-shell">
      <TopBar
        health={health}
        onRefreshHealth={refreshHealth}
        authOk={authOk}
        settingsOpen={settingsOpen}
        onToggleSettings={() => setSettingsOpen((s) => !s)}
        onOpenGuide={() => setGuideOpen(true)}
      />
      {settingsOpen && <SettingsPanel token={token} setToken={setToken} onClose={() => setSettingsOpen(false)} />}
      {guideOpen && <GuideModal onClose={() => setGuideOpen(false)} />}
      <GlobalBanners health={health} authOk={authOk} token={token} />

      <div className="cm-app-body">
        <AppSidebar
          tree={tree}
          treeLoading={treeLoading}
          treeError={treeError}
          selected={selected}
          onSelect={handleTreeSelect}
          currentRepo={currentRepo}
        />

        <main className="cm-main">
          <nav className="cm-tabs" data-testid="app-tabs">
            <button
              className={"cm-tab" + (view === "home" ? " is-active" : "")}
              onClick={() => setView("home")}
              data-testid="tab-home"
            >home</button>
            <button
              className={"cm-tab" + (view === "query" ? " is-active" : "")}
              onClick={() => setView("query")}
              data-testid="tab-query"
            >query</button>
            <button
              className={"cm-tab" + (view === "node" ? " is-active" : "") + (selectedNode ? "" : " is-dim")}
              onClick={() => setView("node")}
              data-testid="tab-node"
            >
              detail{selectedNode ? <span className="cm-tab-sub">· {selectedNode.title || selectedNode.id}</span> : null}
            </button>
          </nav>

          {view === "home" && (
            <HomePage
              token={token}
              status={status}
              tree={tree}
              onStarted={onStarted}
              onLoadExisting={onLoadExisting}
            />
          )}
          {view === "query" && (
            <QueryPage
              token={token}
              currentRepo={currentRepo}
              treeExists={!!(tree && tree.exists)}
            />
          )}
          {view === "node" && (
            <NodeDetailPage
              tree={tree}
              nodeId={selected}
              onClearSelection={() => { setSelected(null); }}
            />
          )}
        </main>
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
