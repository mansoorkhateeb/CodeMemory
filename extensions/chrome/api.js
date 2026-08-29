// api.js — pure API-calling helpers shared by popup, options, background.
// Tested standalone with Node against the live backend (see verify.mjs).
// All functions take {backendUrl, token} explicitly — no globals.

const DEFAULT_TIMEOUT = 15000;
const QUERY_TIMEOUT = 90000;

async function _fetchJson(url, { method = "GET", body, token, timeout = DEFAULT_TIMEOUT } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeout);
  try {
    const headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const r = await fetch(url, {
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
  } finally { clearTimeout(t); }
}

export function _joinUrl(base, path) {
  if (!base) throw new Error("backend URL not configured");
  return base.replace(/\/+$/, "") + path;
}

export async function health(backendUrl) {
  return _fetchJson(_joinUrl(backendUrl, "/api/health"), { timeout: 6000 });
}

export async function indexStatus(backendUrl, token) {
  return _fetchJson(_joinUrl(backendUrl, "/api/index/status"), { token, timeout: 8000 });
}

export async function getTree(backendUrl, token, owner, name) {
  const q = `?owner=${encodeURIComponent(owner)}&name=${encodeURIComponent(name)}`;
  return _fetchJson(_joinUrl(backendUrl, "/api/tree") + q, { token, timeout: 15000 });
}

export async function runQuery(backendUrl, token, { query, token_budget = 30000, repo_owner, repo_name }) {
  return _fetchJson(_joinUrl(backendUrl, "/api/query"), {
    method: "POST",
    token,
    body: { query, token_budget, repo_owner, repo_name },
    timeout: QUERY_TIMEOUT,
  });
}

// Maps low-level errors → user-facing messages a UI can show verbatim.
export function humanizeError(e, { context = "request" } = {}) {
  if (!e) return null;
  if (e.status === 401) return "Bearer token was rejected (401). Open Options to set a valid CODEMEMORY_API_TOKEN.";
  if (e.status === 404) return "Backend returned 404 — check the backend URL in Options.";
  if (e.status === 409) return "An index job is already running on the backend.";
  if (e.status === 502) return "LLM call failed (502). Try again in a moment.";
  if (e.status === "timeout") return `${context} timed out. Try a smaller token_budget or retry.`;
  if (e.name === "TypeError" || /fetch|network/i.test(String(e.message))) {
    return "Backend unreachable. Check the backend URL in Options (and that the container is up).";
  }
  return `${context} failed: ${e.message}`;
}
