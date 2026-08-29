import { useCallback, useEffect, useState } from "react";
import "@/App.css";
import { BrowserRouter, Route, Routes } from "react-router-dom";

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;
const API = `${BACKEND_URL}/api`;

/**
 * Phase 0 stub: a dev console with a health indicator and a "Run POC" button.
 * The bearer token is entered by the developer (never hardcoded).
 */
function DevConsole() {
  const [token, setToken] = useState(
    () => window.localStorage.getItem("codememory_token") || ""
  );
  const [health, setHealth] = useState({ state: "checking", detail: null });
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [elapsedMs, setElapsedMs] = useState(null);

  const checkHealth = useCallback(async () => {
    setHealth({ state: "checking", detail: null });
    try {
      const r = await fetch(`${API}/health`);
      const j = await r.json();
      if (r.ok && j.status === "ok") setHealth({ state: "ok", detail: j });
      else setHealth({ state: "down", detail: j });
    } catch (e) {
      setHealth({ state: "down", detail: String(e) });
    }
  }, []);

  useEffect(() => {
    checkHealth();
  }, [checkHealth]);

  useEffect(() => {
    window.localStorage.setItem("codememory_token", token);
  }, [token]);

  const runPoc = useCallback(async () => {
    setRunning(true);
    setError(null);
    setResult(null);
    setElapsedMs(null);
    const t0 = performance.now();
    try {
      const r = await fetch(`${API}/poc`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      });
      const text = await r.text();
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text };
      }
      if (!r.ok) {
        setError({ status: r.status, body: parsed });
      } else {
        setResult(parsed);
      }
    } catch (e) {
      setError({ status: "network", body: String(e) });
    } finally {
      setElapsedMs(Math.round(performance.now() - t0));
      setRunning(false);
    }
  }, [token]);

  const healthColor =
    health.state === "ok"
      ? "cm-dot cm-dot--ok"
      : health.state === "checking"
      ? "cm-dot cm-dot--warn"
      : "cm-dot cm-dot--err";

  return (
    <div className="cm-shell" data-testid="codememory-shell">
      <header className="cm-header">
        <div className="cm-brand">
          <span className="cm-brand-mark">{`{ }`}</span>
          <div>
            <h1 className="cm-title" data-testid="app-title">
              CodeMemory
            </h1>
            <p className="cm-subtitle">
              hierarchical token-aware memory over a github repo &nbsp;·&nbsp;
              <span className="cm-tag">phase 0 · risk poc</span>
            </p>
          </div>
        </div>
        <div className="cm-health" data-testid="health-indicator">
          <span className={healthColor} />
          <span className="cm-health-label">
            api: {health.state}
          </span>
          <button
            className="cm-btn cm-btn--ghost"
            onClick={checkHealth}
            data-testid="refresh-health-btn"
          >
            refresh
          </button>
        </div>
      </header>

      <main className="cm-main">
        <section className="cm-panel">
          <label className="cm-label" htmlFor="cm-token">
            api bearer token
          </label>
          <input
            id="cm-token"
            data-testid="token-input"
            className="cm-input"
            type="password"
            placeholder="paste CODEMEMORY_API_TOKEN"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
          <p className="cm-hint">
            stored in localStorage; used only for /api/poc bearer header.
          </p>

          <div className="cm-actions">
            <button
              className="cm-btn cm-btn--primary"
              onClick={runPoc}
              disabled={running || !token}
              data-testid="run-poc-btn"
            >
              {running ? "running…" : "run poc"}
            </button>
            {elapsedMs != null && (
              <span className="cm-elapsed" data-testid="elapsed">
                {(elapsedMs / 1000).toFixed(2)}s
              </span>
            )}
          </div>
        </section>

        <section className="cm-panel cm-panel--output">
          <div className="cm-panel-title">response</div>
          {!result && !error && (
            <pre className="cm-pre cm-pre--muted" data-testid="empty-state">
              {`// click "run poc" to fetch → chunk → embed → cluster → summarize`}
            </pre>
          )}
          {error && (
            <pre className="cm-pre cm-pre--err" data-testid="error-output">
              {JSON.stringify(error, null, 2)}
            </pre>
          )}
          {result && (
            <>
              <div className="cm-stats" data-testid="poc-stats">
                <Stat label="chunks_fetched" value={result.chunks_fetched} />
                <Stat label="embeddings_stored" value={result.embeddings_stored} />
                <Stat label="clusters" value={result.clusters} />
                <Stat
                  label="summary_tokens"
                  value={result.summary_token_count}
                />
                <Stat
                  label="chroma_persisted"
                  value={String(result.chroma_persisted)}
                />
              </div>
              <div className="cm-panel-title cm-panel-title--sub">
                sample_summary
              </div>
              <pre className="cm-pre" data-testid="poc-summary">
                {result.sample_summary}
              </pre>
              <details className="cm-details">
                <summary>raw json</summary>
                <pre className="cm-pre cm-pre--muted" data-testid="poc-raw">
                  {JSON.stringify(result, null, 2)}
                </pre>
              </details>
            </>
          )}
        </section>
      </main>

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

function Stat({ label, value }) {
  return (
    <div className="cm-stat" data-testid={`stat-${label}`}>
      <div className="cm-stat-value">{value}</div>
      <div className="cm-stat-label">{label}</div>
    </div>
  );
}

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<DevConsole />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
