// api.ts — pure API-calling helpers for the VS Code extension.
// No `vscode` imports here — safely testable from plain Node.

const DEFAULT_TIMEOUT = 15000;
const QUERY_TIMEOUT = 90000;

export interface ApiError extends Error {
  status?: number | string;
  body?: unknown;
}

async function fetchJson(
  url: string,
  opts: { method?: string; body?: unknown; token?: string; timeout?: number } = {}
): Promise<any> {
  const { method = "GET", body, token, timeout = DEFAULT_TIMEOUT } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const r = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await r.text();
    let parsed: any;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
    if (!r.ok) {
      const err = new Error((parsed && parsed.detail) || `HTTP ${r.status}`) as ApiError;
      err.status = r.status;
      err.body = parsed;
      throw err;
    }
    return parsed;
  } catch (e: any) {
    if (e && e.name === "AbortError") {
      const err = new Error("Request timed out") as ApiError;
      err.status = "timeout";
      throw err;
    }
    throw e;
  } finally { clearTimeout(timer); }
}

export function joinUrl(base: string, path: string): string {
  if (!base) throw new Error("backend URL not configured");
  return base.replace(/\/+$/, "") + path;
}

export async function health(backendUrl: string) {
  return fetchJson(joinUrl(backendUrl, "/api/health"), { timeout: 6000 });
}

export async function indexStatus(backendUrl: string, token: string) {
  return fetchJson(joinUrl(backendUrl, "/api/index/status"), { token, timeout: 8000 });
}

export interface TreeNode {
  id: string;
  type: "repo" | "subsystem" | "topic" | "subtopic" | "artifact" | "chunk";
  title: string;
  summary?: string | null;
  content?: string | null;
  embedding_id?: string | null;
  metadata: Record<string, any>;
  children: string[];
  parent?: string | null;
}

export interface TreeResponse {
  repo_owner?: string;
  repo_name?: string;
  root_id?: string | null;
  nodes: Record<string, TreeNode>;
  exists: boolean;
}

export async function getTree(
  backendUrl: string, token: string, owner: string, name: string
): Promise<TreeResponse> {
  const q = `?owner=${encodeURIComponent(owner)}&name=${encodeURIComponent(name)}`;
  return fetchJson(joinUrl(backendUrl, "/api/tree") + q, { token, timeout: 15000 });
}

export interface QueryResponse {
  answer: string;
  nodes_used: string[];
  token_count: number;
  naive_baseline_tokens: number;
}

export async function runQuery(
  backendUrl: string, token: string,
  args: { query: string; token_budget?: number; repo_owner?: string; repo_name?: string }
): Promise<QueryResponse> {
  const body = {
    query: args.query,
    token_budget: args.token_budget ?? 30000,
    repo_owner: args.repo_owner || undefined,
    repo_name: args.repo_name || undefined,
  };
  return fetchJson(joinUrl(backendUrl, "/api/query"), {
    method: "POST", token, body, timeout: QUERY_TIMEOUT,
  });
}

// One retry on transient network errors (not on 4xx/5xx).
export async function withOneRetry<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (e: any) {
    const status = e && e.status;
    const isTransient =
      status === "timeout" ||
      (e && e.name === "TypeError") ||
      /fetch|network/i.test(String(e && e.message));
    if (!isTransient) throw e;
    await new Promise((r) => setTimeout(r, 800));
    return fn();
  }
}

export function humanize(e: ApiError, context = "request"): string {
  if (!e) return "";
  if (e.status === 401) return "API token was rejected (401). Run 'CodeMemory: Set API Token'.";
  if (e.status === 404) return "Backend returned 404. Check codememory.backendUrl.";
  if (e.status === 409) return "An index job is already running on the backend.";
  if (e.status === 502) return "LLM call failed (502). Try again in a moment.";
  if (e.status === "timeout") return `${context} timed out. Try a smaller token_budget or retry.`;
  if (e.name === "TypeError" || /fetch|network/i.test(String(e.message))) {
    return "Backend unreachable. Check codememory.backendUrl.";
  }
  return `${context} failed: ${e.message}`;
}
