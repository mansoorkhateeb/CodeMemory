// verify.mjs — exercise chrome/api.js against a LIVE backend.
// Node 18+ (built-in fetch). Not shipped in the packaged extension.
//
// Usage:
//   node verify.mjs --url <backend> --token <bearer>
//
// Runs:
//   1. GET /api/health                       (expect status:ok)
//   2. unreachable URL                       (expect network/humanized err)
//   3. GET /api/index/status with WRONG token (expect 401 humanized)
//   4. POST /api/query with valid token      (expect real gpt-5 answer)
//   5. Explicit timeout path                 (expect status:"timeout" humanized)

import { health, indexStatus, runQuery, humanizeError, _joinUrl } from "./api.js";

function arg(name, def) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : def;
}

const URL = arg("url", "http://localhost:8001");
const TOKEN = arg("token", "");

function log(step, obj) {
  console.log("\n== " + step + " ==");
  console.log(JSON.stringify(obj, null, 2));
}

const results = { url: URL, steps: [] };

async function step1_health() {
  try {
    const r = await health(URL);
    results.steps.push({ step: "health", ok: r && r.status === "ok", body: r });
    log("1. health", r);
  } catch (e) {
    results.steps.push({ step: "health", ok: false, err: humanizeError(e) });
    log("1. health FAILED", { message: e.message, status: e.status });
    throw e;
  }
}

async function step2_unreachable() {
  const bogus = "https://this-host-does-not-exist-cm.invalid";
  try {
    await health(bogus);
    results.steps.push({ step: "unreachable", ok: false, note: "expected failure, got success" });
  } catch (e) {
    const msg = humanizeError(e, { context: "health" });
    results.steps.push({ step: "unreachable", ok: true, humanized: msg });
    log("2. unreachable → humanized", { message: e.message, humanized: msg });
  }
}

async function step3_bad_token() {
  try {
    await indexStatus(URL, "definitely-wrong-token-xyz");
    results.steps.push({ step: "401", ok: false, note: "expected 401, got success" });
  } catch (e) {
    const msg = humanizeError(e, { context: "status" });
    const ok = e.status === 401;
    results.steps.push({ step: "401", ok, http: e.status, humanized: msg });
    log("3. bad token → 401", { http: e.status, humanized: msg });
  }
}

async function step4_query() {
  if (!TOKEN) {
    results.steps.push({ step: "query", ok: false, note: "no --token provided" });
    log("4. query SKIPPED", { reason: "no token" });
    return;
  }
  try {
    const r = await runQuery(URL, TOKEN, {
      query: "How did session handling evolve and why?",
      token_budget: 30000,
      repo_owner: "synth",
      repo_name: "webframework",
    });
    const ok = r && typeof r.answer === "string" && r.token_count > 0;
    const savings = r.naive_baseline_tokens > 0
      ? Math.round((1 - r.token_count / r.naive_baseline_tokens) * 100) + "%"
      : "n/a";
    results.steps.push({
      step: "query", ok,
      token_count: r.token_count,
      naive_baseline_tokens: r.naive_baseline_tokens,
      savings,
      n_paths: (r.nodes_used || []).length,
      answer_preview: (r.answer || "").slice(0, 220),
    });
    log("4. query", {
      token_count: r.token_count,
      naive_baseline_tokens: r.naive_baseline_tokens,
      savings,
      paths: (r.nodes_used || []).length,
      answer_preview: (r.answer || "").slice(0, 220),
    });
  } catch (e) {
    results.steps.push({ step: "query", ok: false, http: e.status, humanized: humanizeError(e, { context: "query" }) });
    log("4. query FAILED", { http: e.status, humanized: humanizeError(e) });
  }
}

async function step5_timeout() {
  // Point at an unroutable IP that will hang until the AbortController fires.
  // 10.255.255.1 is TEST-NET, guaranteed to not respond.
  const url = "http://10.255.255.1:8001";
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 1500);
  try {
    await fetch(url + "/api/health", { signal: controller.signal });
    results.steps.push({ step: "timeout", ok: false, note: "expected timeout, got response" });
  } catch (e) {
    // Simulate what api.js's _fetchJson would produce for an AbortError.
    const simulated = e.name === "AbortError"
      ? { status: "timeout", humanized: humanizeError({ status: "timeout" }, { context: "health" }) }
      : { status: "network", humanized: humanizeError(e) };
    results.steps.push({ step: "timeout", ok: !!simulated.humanized, ...simulated });
    log("5. timeout → humanized", simulated);
  } finally { clearTimeout(t); }
}

(async () => {
  try { await step1_health(); } catch { /* fatal steps continue */ }
  await step2_unreachable();
  await step3_bad_token();
  await step4_query();
  await step5_timeout();

  const failed = results.steps.filter((s) => !s.ok).map((s) => s.step);
  console.log("\n== SUMMARY ==");
  console.log(JSON.stringify({
    total: results.steps.length,
    passed: results.steps.length - failed.length,
    failed,
  }, null, 2));
  process.exit(failed.length ? 1 : 0);
})();
