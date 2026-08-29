// verify.mjs — exercise the VS Code extension's api.ts logic against a
// LIVE backend. Runs the compiled output at out/verify-bundle.cjs which
// re-exports the pure functions from src/api.ts (built by esbuild).
//
// Usage: node verify.mjs --url <backend> --token <bearer>

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLE = resolve(HERE, "out/verify-bundle.cjs");
const require = createRequire(import.meta.url);

// Build the bundle if needed.
if (!existsSync(BUNDLE)) {
  const r = spawnSync(
    "npx",
    ["esbuild", "src/api.ts", "--bundle", "--platform=node", "--format=cjs", "--outfile=" + BUNDLE],
    { cwd: HERE, stdio: "inherit" },
  );
  if (r.status !== 0) { console.error("failed to build verify bundle"); process.exit(2); }
}

const api = require(BUNDLE);

function arg(name, def) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : def;
}
const URL = arg("url", "http://localhost:8001");
const TOKEN = arg("token", "");

function log(step, obj) { console.log("\n== " + step + " ==\n" + JSON.stringify(obj, null, 2)); }
const results = { url: URL, steps: [] };

async function step1() {
  try {
    const r = await api.health(URL);
    results.steps.push({ step: "health", ok: r && r.status === "ok", body: r });
    log("1. health", r);
  } catch (e) {
    results.steps.push({ step: "health", ok: false, err: api.humanize(e, "health") });
    log("1. health FAILED", { message: e.message, status: e.status });
  }
}
async function step2() {
  try { await api.health("https://this-host-does-not-exist-cm.invalid"); results.steps.push({ step: "unreachable", ok: false }); }
  catch (e) {
    const msg = api.humanize(e, "health");
    results.steps.push({ step: "unreachable", ok: true, humanized: msg });
    log("2. unreachable → humanized", { message: e.message, humanized: msg });
  }
}
async function step3() {
  try { await api.indexStatus(URL, "wrong-token"); results.steps.push({ step: "401", ok: false }); }
  catch (e) {
    const msg = api.humanize(e, "status");
    results.steps.push({ step: "401", ok: e.status === 401, http: e.status, humanized: msg });
    log("3. bad token → 401", { http: e.status, humanized: msg });
  }
}
async function step4() {
  if (!TOKEN) { results.steps.push({ step: "query", ok: false, note: "no --token" }); return; }
  try {
    const r = await api.withOneRetry(() => api.runQuery(URL, TOKEN, {
      query: "How did session handling evolve and why?", token_budget: 30000,
      repo_owner: "synth", repo_name: "webframework",
    }));
    const savings = r.naive_baseline_tokens > 0
      ? Math.round((1 - r.token_count / r.naive_baseline_tokens) * 100) + "%" : "n/a";
    results.steps.push({ step: "query", ok: r.token_count > 0, token_count: r.token_count, naive_baseline_tokens: r.naive_baseline_tokens, savings, paths: r.nodes_used.length, answer_preview: r.answer.slice(0, 220) });
    log("4. query", { token_count: r.token_count, naive_baseline_tokens: r.naive_baseline_tokens, savings, paths: r.nodes_used.length, answer_preview: r.answer.slice(0, 220) });
  } catch (e) {
    results.steps.push({ step: "query", ok: false, err: api.humanize(e, "query") });
    log("4. query FAILED", { http: e.status, humanized: api.humanize(e, "query") });
  }
}
async function step5() {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 1500);
  try {
    await fetch("http://10.255.255.1:8001/api/health", { signal: controller.signal });
    results.steps.push({ step: "timeout", ok: false });
  } catch (e) {
    const simulated = e.name === "AbortError" ? { status: "timeout" } : {};
    const msg = api.humanize(simulated, "health");
    results.steps.push({ step: "timeout", ok: !!msg, humanized: msg });
    log("5. timeout → humanized", { name: e.name, humanized: msg });
  } finally { clearTimeout(t); }
}

(async () => {
  await step1(); await step2(); await step3(); await step4(); await step5();
  const failed = results.steps.filter((s) => !s.ok).map((s) => s.step);
  console.log("\n== SUMMARY ==\n" + JSON.stringify({ total: results.steps.length, passed: results.steps.length - failed.length, failed }, null, 2));
  process.exit(failed.length ? 1 : 0);
})();
