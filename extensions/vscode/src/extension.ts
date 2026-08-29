import * as vscode from "vscode";
import {
  health, indexStatus, getTree, runQuery, withOneRetry, humanize,
  TreeResponse, QueryResponse, ApiError,
} from "./api";

const SECRET_TOKEN_KEY = "codememory.apiToken";

async function getToken(ctx: vscode.ExtensionContext): Promise<string | undefined> {
  return ctx.secrets.get(SECRET_TOKEN_KEY);
}

function cfg() {
  const c = vscode.workspace.getConfiguration("codememory");
  return {
    url: (c.get<string>("backendUrl") || "").trim(),
    owner: (c.get<string>("repoOwner") || "").trim(),
    name: (c.get<string>("repoName") || "").trim(),
    budget: c.get<number>("tokenBudget") ?? 30000,
  };
}

// -------------------- webview tree provider -------------------- //
class TreeViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private tree: TreeResponse | null = null;
  private lastError: string | null = null;
  private lastAnswer: QueryResponse | null = null;

  constructor(private ctx: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.render();
    view.webview.onDidReceiveMessage(async (msg) => {
      if (msg?.type === "refresh") await this.refresh();
      else if (msg?.type === "ask") await vscode.commands.executeCommand("codememory.ask");
      else if (msg?.type === "showNode" && this.tree && this.tree.nodes[msg.id]) {
        const n = this.tree.nodes[msg.id];
        const doc = await vscode.workspace.openTextDocument({
          language: "markdown",
          content: renderNodeMarkdown(n),
        });
        await vscode.window.showTextDocument(doc, { preview: true });
      }
    });
    this.refresh();
  }

  setLastAnswer(a: QueryResponse | null) { this.lastAnswer = a; this.rerender(); }

  async refresh() {
    this.lastError = null;
    const { url, owner, name } = cfg();
    const token = await getToken(this.ctx);
    if (!url) { this.lastError = "backend URL not set"; this.rerender(); return; }
    if (!token) { this.lastError = "API token not set — run 'CodeMemory: Set API Token'"; this.rerender(); return; }
    if (!owner || !name) {
      this.lastError = "Set codememory.repoOwner and codememory.repoName in Settings.";
      this.rerender(); return;
    }
    try {
      this.tree = await withOneRetry(() => getTree(url, token, owner, name));
      this.rerender();
    } catch (e) {
      this.lastError = humanize(e as ApiError, "tree");
      this.tree = null;
      this.rerender();
    }
  }

  private rerender() { if (this.view) this.view.webview.html = this.render(); }

  private render(): string {
    const nonce = String(Math.random()).slice(2);
    const treeJson = JSON.stringify(this.tree || null);
    const answerJson = JSON.stringify(this.lastAnswer || null);
    const errStr = this.lastError ? escapeHtml(this.lastError) : "";
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:transparent;padding:8px 6px;font-size:12px}
.hd{display:flex;gap:8px;align-items:center;margin-bottom:8px}
button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;padding:4px 10px;border-radius:2px;cursor:pointer;font:inherit}
button:hover{background:var(--vscode-button-hoverBackground)}
button.sec{background:transparent;color:var(--vscode-foreground);border:1px solid var(--vscode-panel-border)}
.err{color:var(--vscode-errorForeground);white-space:pre-wrap;padding:6px 8px;border:1px solid var(--vscode-inputValidation-errorBorder);border-radius:3px;margin-bottom:8px;font-family:var(--vscode-editor-font-family);font-size:11.5px}
.row{padding:2px 6px;cursor:pointer;border-radius:3px;font-family:var(--vscode-editor-font-family);font-size:12px}
.row:hover{background:var(--vscode-list-hoverBackground)}
.badge{display:inline-block;font-size:9.5px;padding:0 5px;margin-right:6px;border-radius:3px;text-transform:uppercase;letter-spacing:.05em;border:1px solid var(--vscode-panel-border);color:var(--vscode-descriptionForeground)}
.b-repo{border-color:#7ee787;color:#7ee787}.b-subsystem{border-color:#d2a8ff;color:#d2a8ff}.b-topic{border-color:#79c0ff;color:#79c0ff}.b-artifact{border-color:#f2cc60;color:#f2cc60}.b-chunk{color:var(--vscode-descriptionForeground)}
details{margin:0}
summary{list-style:none;cursor:pointer;padding:2px 0}
summary::-webkit-details-marker{display:none}
.caret{display:inline-block;width:12px;color:var(--vscode-descriptionForeground)}
.answer{margin-top:12px;padding-top:8px;border-top:1px dashed var(--vscode-panel-border)}
.stats{display:grid;grid-template-columns:1fr 1fr;gap:4px;margin:6px 0 8px}
.stat{background:var(--vscode-textCodeBlock-background);padding:4px 6px;border-radius:3px}
.stat b{color:#7ee787}
.paths li{font-family:var(--vscode-editor-font-family);font-size:11px;padding:2px 4px;color:var(--vscode-descriptionForeground)}
</style></head>
<body>
<div class="hd">
  <button id="ask">ask a question</button>
  <button id="refresh" class="sec">refresh</button>
</div>
${errStr ? `<div class="err">${errStr}</div>` : ""}
<div id="tree"></div>
<div id="answer" class="answer" hidden></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const TREE = ${treeJson};
  const ANSWER = ${answerJson};
  const ORDER = { repo:0, subsystem:1, topic:2, subtopic:3, artifact:4, chunk:5 };
  function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
  function renderTree(){
    const el=document.getElementById("tree");
    if(!TREE||!TREE.exists||!TREE.root_id){el.textContent="no tree loaded.";return;}
    el.innerHTML=""; el.appendChild(renderNode(TREE.root_id, 0, true));
  }
  function renderNode(id, depth, openDefault){
    const n=TREE.nodes[id]; if(!n)return document.createTextNode("");
    const wrap=document.createElement("div");
    const kids=(n.children||[]).slice().sort((a,b)=>((ORDER[TREE.nodes[a]?.type]??9)-(ORDER[TREE.nodes[b]?.type]??9)));
    if(kids.length===0){
      const row=document.createElement("div"); row.className="row"; row.style.paddingLeft=(depth*10+4)+"px";
      row.innerHTML='<span class="caret">·</span><span class="badge b-'+n.type+'">'+n.type+'</span>'+esc(n.title||n.id);
      row.addEventListener("click",()=>vscode.postMessage({type:"showNode",id:n.id}));
      wrap.appendChild(row); return wrap;
    }
    const d=document.createElement("details"); if(openDefault)d.open=true;
    const s=document.createElement("summary"); s.className="row"; s.style.paddingLeft=(depth*10+4)+"px";
    s.innerHTML='<span class="caret">▸</span><span class="badge b-'+n.type+'">'+n.type+'</span>'+esc(n.title||n.id);
    s.addEventListener("click",(e)=>{
      if(e.detail===2){vscode.postMessage({type:"showNode",id:n.id});}
    });
    d.appendChild(s);
    kids.forEach(cid=>d.appendChild(renderNode(cid, depth+1, false)));
    wrap.appendChild(d); return wrap;
  }
  function renderAnswer(){
    const el=document.getElementById("answer");
    if(!ANSWER){el.hidden=true;return;}
    el.hidden=false;
    const savings=(ANSWER.naive_baseline_tokens>0)?Math.max(0,Math.round((1-ANSWER.token_count/ANSWER.naive_baseline_tokens)*100))+"%":"—";
    el.innerHTML='<b>last answer</b><div class="stats"><div class="stat"><b>'+ANSWER.token_count+'</b> tokens</div><div class="stat"><b>'+savings+'</b> saved</div></div><pre style="white-space:pre-wrap;font-family:var(--vscode-editor-font-family);font-size:11.5px">'+esc(ANSWER.answer)+'</pre><details><summary>node paths ('+ANSWER.nodes_used.length+')</summary><ul class="paths">'+ANSWER.nodes_used.map(p=>'<li>'+esc(p)+'</li>').join("")+'</ul></details>';
  }
  document.getElementById("ask").addEventListener("click",()=>vscode.postMessage({type:"ask"}));
  document.getElementById("refresh").addEventListener("click",()=>vscode.postMessage({type:"refresh"}));
  renderTree(); renderAnswer();
</script></body></html>`;
  }
}

function renderNodeMarkdown(n: { type: string; title: string; summary?: string | null; content?: string | null; metadata?: Record<string, any> }): string {
  const parts: string[] = [`# ${n.title}`, ``, `_type: **${n.type}**_`, ``];
  const m = n.metadata || {};
  if (m.pr_number) parts.push(`- PR **#${m.pr_number}**`);
  if (m.issue_number) parts.push(`- Issue **#${m.issue_number}**`);
  if (m.file_path) parts.push(`- File: \`${m.file_path}\``);
  if (m.author) parts.push(`- Author: @${m.author}`);
  if (m.merged_at) parts.push(`- Merged: ${m.merged_at}`);
  if (m.html_url) parts.push(`- URL: ${m.html_url}`);
  parts.push(``);
  if (n.summary) parts.push(`## Summary`, ``, n.summary, ``);
  if (n.content) parts.push(`## Content`, ``, "```", n.content, "```", ``);
  return parts.join("\n");
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

// -------------------- commands -------------------- //
async function cmdSetToken(ctx: vscode.ExtensionContext) {
  const value = await vscode.window.showInputBox({
    prompt: "CodeMemory API token (stored in SecretStorage)",
    password: true,
    ignoreFocusOut: true,
    placeHolder: "CODEMEMORY_API_TOKEN",
  });
  if (value === undefined) return;
  await ctx.secrets.store(SECRET_TOKEN_KEY, value.trim());
  vscode.window.showInformationMessage("CodeMemory: API token saved.");
}

async function cmdAsk(ctx: vscode.ExtensionContext, provider: TreeViewProvider) {
  const { url, owner, name, budget } = cfg();
  const token = await getToken(ctx);
  if (!url) return vscode.window.showErrorMessage("Set codememory.backendUrl in Settings.");
  if (!token) {
    const pick = await vscode.window.showErrorMessage(
      "CodeMemory API token not set.",
      "Set token now"
    );
    if (pick) await vscode.commands.executeCommand("codememory.setToken");
    return;
  }

  const editor = vscode.window.activeTextEditor;
  const preselected = editor && !editor.selection.isEmpty
    ? editor.document.getText(editor.selection).slice(0, 500)
    : "";

  const query = await vscode.window.showInputBox({
    prompt: "Ask CodeMemory a question about this repo",
    value: preselected,
    ignoreFocusOut: true,
    placeHolder: "e.g. How did session handling evolve and why?",
  });
  if (!query || !query.trim()) return;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "CodeMemory: querying…", cancellable: false },
    async () => {
      try {
        const r = await withOneRetry(() =>
          runQuery(url, token, {
            query: query.trim(),
            token_budget: budget,
            repo_owner: owner || undefined,
            repo_name: name || undefined,
          })
        );
        provider.setLastAnswer(r);
        await showAnswerPanel(query, r);
      } catch (e) {
        const msg = humanize(e as ApiError, "query");
        const pick = await vscode.window.showErrorMessage(msg, "Set token", "Open Settings");
        if (pick === "Set token") vscode.commands.executeCommand("codememory.setToken");
        else if (pick === "Open Settings") vscode.commands.executeCommand("workbench.action.openSettings", "codememory");
      }
    }
  );
}

async function showAnswerPanel(query: string, r: QueryResponse) {
  const panel = vscode.window.createWebviewPanel(
    "codememory.answer",
    "CodeMemory · answer",
    vscode.ViewColumn.Beside,
    { enableScripts: false }
  );
  const savings = r.naive_baseline_tokens > 0
    ? Math.max(0, Math.round((1 - r.token_count / r.naive_baseline_tokens) * 100)) + "%"
    : "—";
  const paths = r.nodes_used.map((p) => `<li>${escapeHtml(p)}</li>`).join("");
  panel.webview.html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:14px 18px;font-size:13px}
h2{font-size:14px;margin:0 0 8px}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin:8px 0 16px}
.stat{background:var(--vscode-textCodeBlock-background);padding:8px 10px;border-radius:4px;text-align:center}
.stat b{display:block;color:#7ee787;font-size:16px}
.stat span{font-size:10.5px;color:var(--vscode-descriptionForeground)}
pre{background:var(--vscode-textCodeBlock-background);padding:12px 14px;border-radius:4px;white-space:pre-wrap;font-family:var(--vscode-editor-font-family);font-size:12.5px;line-height:1.5}
ul{padding-left:0;list-style:none}
li{font-family:var(--vscode-editor-font-family);font-size:11.5px;padding:2px 6px;color:var(--vscode-descriptionForeground);border-left:2px solid var(--vscode-panel-border);margin-bottom:2px}
.q{color:var(--vscode-descriptionForeground);font-style:italic;margin-bottom:12px}
</style></head><body>
<h2>CodeMemory answer</h2>
<div class="q">Q: ${escapeHtml(query)}</div>
<div class="stats">
  <div class="stat"><b>${r.token_count}</b><span>tokens packed</span></div>
  <div class="stat"><b>${r.naive_baseline_tokens}</b><span>naive baseline</span></div>
  <div class="stat"><b>${savings}</b><span>saved vs naive</span></div>
  <div class="stat"><b>${r.nodes_used.length}</b><span>node paths</span></div>
</div>
<h3>Answer</h3>
<pre>${escapeHtml(r.answer)}</pre>
<h3>Node paths (${r.nodes_used.length})</h3>
<ul>${paths}</ul>
</body></html>`;
}

// -------------------- status bar poller -------------------- //
function makeStatusBar(ctx: vscode.ExtensionContext): { item: vscode.StatusBarItem; stop: () => void } {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  item.text = "$(sync~spin) CodeMemory";
  item.tooltip = "CodeMemory backend status";
  item.show();

  let consecutiveFail = 0;
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    const { url } = cfg();
    const token = await getToken(ctx);
    if (!url) { item.text = "$(warning) CodeMemory: no URL"; return; }
    try {
      const h = await health(url);
      if (h && h.status === "ok") {
        consecutiveFail = 0;
        if (!token) { item.text = "$(warning) CodeMemory: no token"; return; }
        try {
          const s = await indexStatus(url, token);
          const glyph = s.status === "indexing" ? "$(sync~spin)" : s.status === "failed" ? "$(error)" : "$(check)";
          item.text = `${glyph} CodeMemory · ${s.status}`;
          item.tooltip = `${s.status} · ${s.progress?.stage || "-"} · ${s.progress?.detail || ""}`;
        } catch (e: any) {
          if (e.status === 401) { item.text = "$(key) CodeMemory: 401"; item.tooltip = "API token rejected"; }
          else { item.text = "$(warning) CodeMemory: status err"; }
        }
      } else { item.text = "$(warning) CodeMemory"; }
    } catch (e) {
      consecutiveFail++;
      item.text = "$(error) CodeMemory: offline";
      item.tooltip = "backend unreachable";
      if (consecutiveFail >= 4) { stopped = true; item.tooltip = "backend unreachable — polling stopped"; }
    }
  };
  tick();
  const iv = setInterval(tick, 15000);
  ctx.subscriptions.push({ dispose: () => { stopped = true; clearInterval(iv); item.dispose(); } });
  return { item, stop: () => { stopped = true; clearInterval(iv); } };
}

// -------------------- activate / deactivate -------------------- //
export function activate(ctx: vscode.ExtensionContext) {
  const provider = new TreeViewProvider(ctx);

  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider("codememory.tree", provider),
    vscode.commands.registerCommand("codememory.setToken", () => cmdSetToken(ctx)),
    vscode.commands.registerCommand("codememory.ask", () => cmdAsk(ctx, provider)),
    vscode.commands.registerCommand("codememory.refreshTree", () => provider.refresh()),
  );

  makeStatusBar(ctx);
}

export function deactivate() {}
