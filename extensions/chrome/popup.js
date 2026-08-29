import { health, runQuery, humanizeError } from "./api.js";

const $ = (id) => document.getElementById(id);

async function loadConfig() {
  const cfg = await chrome.storage.local.get(["backend_url", "api_token"]);
  return {
    backendUrl: cfg.backend_url || "",
    token: cfg.api_token || "",
  };
}

function showBanner(msg, kind = "warn") {
  const b = $("banner");
  b.hidden = false;
  b.className = "banner " + kind;
  b.textContent = msg;
}
function clearBanner() { $("banner").hidden = true; }
function showError(msg) { $("error").hidden = false; $("error").textContent = msg; }
function clearError() { $("error").hidden = true; $("error").textContent = ""; }

async function refreshBackendHint(cfg) {
  const el = $("be-hint");
  if (!cfg.backendUrl) { el.textContent = "backend not set → options"; return; }
  el.textContent = cfg.backendUrl.replace(/^https?:\/\//, "").slice(0, 42);
  if (!cfg.token) {
    showBanner("No API token. Open Options.", "warn");
    return;
  }
  try {
    const h = await health(cfg.backendUrl);
    if (h && h.status === "ok") clearBanner();
    else showBanner("Backend health degraded.", "err");
  } catch (e) {
    showBanner(humanizeError(e, { context: "health" }), "err");
  }
}

async function loadPendingSelection() {
  const { pending_selection, pending_selection_at } = await chrome.storage.local.get([
    "pending_selection", "pending_selection_at"
  ]);
  // Only preload if it's fresh (last 60s) and the textarea is empty.
  if (pending_selection && (Date.now() - (pending_selection_at || 0) < 60_000)) {
    const ta = $("q");
    if (!ta.value.trim()) ta.value = pending_selection;
    // consume it so it doesn't reappear on next open
    await chrome.storage.local.remove(["pending_selection", "pending_selection_at"]);
  }
}

async function ask() {
  clearError();
  const cfg = await loadConfig();
  if (!cfg.backendUrl || !cfg.token) {
    showError("Backend URL and API token are required — open Options.");
    return;
  }
  const query = $("q").value.trim();
  if (!query) { showError("Enter a question first."); return; }
  const budget = Number($("budget").value) || 0;

  $("loading").hidden = false;
  $("result").hidden = true;
  $("ask").disabled = true;
  $("elapsed").textContent = "";
  const t0 = performance.now();
  try {
    const r = await runQuery(cfg.backendUrl, cfg.token, {
      query, token_budget: budget,
    });
    renderResult(r);
  } catch (e) {
    showError(humanizeError(e, { context: "query" }));
  } finally {
    $("loading").hidden = true;
    $("ask").disabled = false;
    $("elapsed").textContent = ((performance.now() - t0) / 1000).toFixed(2) + "s";
  }
}

function renderResult(r) {
  $("stat-tokens").textContent = r.token_count;
  $("stat-baseline").textContent = r.naive_baseline_tokens;
  const savings = r.naive_baseline_tokens > 0
    ? Math.max(0, Math.round((1 - r.token_count / r.naive_baseline_tokens) * 100)) + "%"
    : "—";
  $("stat-savings").textContent = savings;
  $("stat-paths").textContent = (r.nodes_used || []).length;
  $("answer").textContent = r.answer || "";
  const ul = $("paths"); ul.innerHTML = "";
  for (const p of (r.nodes_used || [])) {
    const li = document.createElement("li");
    li.textContent = p;
    ul.appendChild(li);
  }
  $("result").hidden = false;
}

document.addEventListener("DOMContentLoaded", async () => {
  const cfg = await loadConfig();
  await refreshBackendHint(cfg);
  await loadPendingSelection();
  $("ask").addEventListener("click", ask);
  $("open-options").addEventListener("click", () => chrome.runtime.openOptionsPage());
  $("q").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); ask(); }
  });
});
