"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/api.ts
var api_exports = {};
__export(api_exports, {
  getTree: () => getTree,
  health: () => health,
  humanize: () => humanize,
  indexStatus: () => indexStatus,
  joinUrl: () => joinUrl,
  runQuery: () => runQuery,
  withOneRetry: () => withOneRetry
});
module.exports = __toCommonJS(api_exports);
var DEFAULT_TIMEOUT = 15e3;
var QUERY_TIMEOUT = 9e4;
async function fetchJson(url, opts = {}) {
  const { method = "GET", body, token, timeout = DEFAULT_TIMEOUT } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const headers = { "Content-Type": "application/json" };
    if (token)
      headers.Authorization = `Bearer ${token}`;
    const r = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : void 0,
      signal: controller.signal
    });
    const text = await r.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { raw: text };
    }
    if (!r.ok) {
      const err = new Error(parsed && parsed.detail || `HTTP ${r.status}`);
      err.status = r.status;
      err.body = parsed;
      throw err;
    }
    return parsed;
  } catch (e) {
    if (e && e.name === "AbortError") {
      const err = new Error("Request timed out");
      err.status = "timeout";
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
function joinUrl(base, path) {
  if (!base)
    throw new Error("backend URL not configured");
  return base.replace(/\/+$/, "") + path;
}
async function health(backendUrl) {
  return fetchJson(joinUrl(backendUrl, "/api/health"), { timeout: 6e3 });
}
async function indexStatus(backendUrl, token) {
  return fetchJson(joinUrl(backendUrl, "/api/index/status"), { token, timeout: 8e3 });
}
async function getTree(backendUrl, token, owner, name) {
  const q = `?owner=${encodeURIComponent(owner)}&name=${encodeURIComponent(name)}`;
  return fetchJson(joinUrl(backendUrl, "/api/tree") + q, { token, timeout: 15e3 });
}
async function runQuery(backendUrl, token, args) {
  const body = {
    query: args.query,
    token_budget: args.token_budget ?? 3e4,
    repo_owner: args.repo_owner || void 0,
    repo_name: args.repo_name || void 0
  };
  return fetchJson(joinUrl(backendUrl, "/api/query"), {
    method: "POST",
    token,
    body,
    timeout: QUERY_TIMEOUT
  });
}
async function withOneRetry(fn) {
  try {
    return await fn();
  } catch (e) {
    const status = e && e.status;
    const isTransient = status === "timeout" || e && e.name === "TypeError" || /fetch|network/i.test(String(e && e.message));
    if (!isTransient)
      throw e;
    await new Promise((r) => setTimeout(r, 800));
    return fn();
  }
}
function humanize(e, context = "request") {
  if (!e)
    return "";
  if (e.status === 401)
    return "API token was rejected (401). Run 'CodeMemory: Set API Token'.";
  if (e.status === 404)
    return "Backend returned 404. Check codememory.backendUrl.";
  if (e.status === 409)
    return "An index job is already running on the backend.";
  if (e.status === 502)
    return "LLM call failed (502). Try again in a moment.";
  if (e.status === "timeout")
    return `${context} timed out. Try a smaller token_budget or retry.`;
  if (e.name === "TypeError" || /fetch|network/i.test(String(e.message))) {
    return "Backend unreachable. Check codememory.backendUrl.";
  }
  return `${context} failed: ${e.message}`;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  getTree,
  health,
  humanize,
  indexStatus,
  joinUrl,
  runQuery,
  withOneRetry
});
