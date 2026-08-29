import { health, indexStatus, humanizeError } from "./api.js";

const $ = (id) => document.getElementById(id);
function say(kind, txt) {
  const m = $("msg"); m.hidden = false; m.className = "banner " + kind; m.textContent = txt;
}

async function load() {
  const cfg = await chrome.storage.local.get(["backend_url", "api_token"]);
  $("url").value = cfg.backend_url || "";
  $("tok").value = cfg.api_token || "";
}

async function save() {
  const url = $("url").value.trim().replace(/\/+$/, "");
  const token = $("tok").value.trim();
  await chrome.storage.local.set({ backend_url: url, api_token: token });
  say("warn", "Saved. Click 'test connection' to verify.");
}

async function grantHost() {
  const url = $("url").value.trim();
  if (!url) { say("err", "Set a backend URL first."); return; }
  try {
    const origin = new URL(url).origin + "/*";
    const granted = await chrome.permissions.request({ origins: [origin] });
    if (granted) say("warn", `Granted host permission for ${origin}`);
    else say("err", "Host permission was not granted.");
  } catch (e) { say("err", "Invalid URL: " + e.message); }
}

async function test() {
  $("detail").hidden = true;
  const url = $("url").value.trim();
  const token = $("tok").value.trim();
  if (!url) return say("err", "Set a backend URL first.");
  if (!token) return say("err", "Set an API token first.");
  const results = [];
  // 1. health (no auth)
  try {
    const h = await health(url);
    results.push({ step: "GET /api/health", ok: h && h.status === "ok", body: h });
  } catch (e) {
    results.push({ step: "GET /api/health", ok: false, error: humanizeError(e, { context: "health" }) });
    say("err", "Health failed. " + humanizeError(e, { context: "health" }));
    $("detail").hidden = false;
    $("detail").textContent = JSON.stringify(results, null, 2);
    return;
  }
  // 2. authed status
  try {
    const s = await indexStatus(url, token);
    results.push({ step: "GET /api/index/status", ok: true, body: s });
    say("warn", "OK — health and token both valid. Status: " + s.status);
  } catch (e) {
    results.push({ step: "GET /api/index/status", ok: false, error: humanizeError(e, { context: "index/status" }) });
    say("err", humanizeError(e, { context: "index/status" }));
  }
  $("detail").hidden = false;
  $("detail").textContent = JSON.stringify(results, null, 2);
}

document.addEventListener("DOMContentLoaded", () => {
  load();
  $("save").addEventListener("click", save);
  $("test").addEventListener("click", test);
  $("grant").addEventListener("click", grantHost);
});
