"use strict";var M=Object.create;var g=Object.defineProperty;var $=Object.getOwnPropertyDescriptor;var S=Object.getOwnPropertyNames;var N=Object.getPrototypeOf,I=Object.prototype.hasOwnProperty;var P=(t,e)=>{for(var r in e)g(t,r,{get:e[r],enumerable:!0})},E=(t,e,r,s)=>{if(e&&typeof e=="object"||typeof e=="function")for(let o of S(e))!I.call(t,o)&&o!==r&&g(t,o,{get:()=>e[o],enumerable:!(s=$(e,o))||s.enumerable});return t};var O=(t,e,r)=>(r=t!=null?M(N(t)):{},E(e||!t||!t.__esModule?g(r,"default",{value:t,enumerable:!0}):r,t)),L=t=>E(g({},"__esModule",{value:!0}),t);var Q={};P(Q,{activate:()=>F,deactivate:()=>D});module.exports=L(Q);var n=O(require("vscode"));async function f(t,e={}){let{method:r="GET",body:s,token:o,timeout:c=15e3}=e,p=new AbortController,u=setTimeout(()=>p.abort(),c);try{let a={"Content-Type":"application/json"};o&&(a.Authorization=`Bearer ${o}`);let i=await fetch(t,{method:r,headers:a,body:s?JSON.stringify(s):void 0,signal:p.signal}),d=await i.text(),l;try{l=d?JSON.parse(d):null}catch{l={raw:d}}if(!i.ok){let m=new Error(l&&l.detail||`HTTP ${i.status}`);throw m.status=i.status,m.body=l,m}return l}catch(a){if(a&&a.name==="AbortError"){let i=new Error("Request timed out");throw i.status="timeout",i}throw a}finally{clearTimeout(u)}}function v(t,e){if(!t)throw new Error("backend URL not configured");return t.replace(/\/+$/,"")+e}async function T(t){return f(v(t,"/api/health"),{timeout:6e3})}async function _(t,e){return f(v(t,"/api/index/status"),{token:e,timeout:8e3})}async function C(t,e,r,s){let o=`?owner=${encodeURIComponent(r)}&name=${encodeURIComponent(s)}`;return f(v(t,"/api/tree")+o,{token:e,timeout:15e3})}async function R(t,e,r){let s={query:r.query,token_budget:r.token_budget??3e4,repo_owner:r.repo_owner||void 0,repo_name:r.repo_name||void 0};return f(v(t,"/api/query"),{method:"POST",token:e,body:s,timeout:9e4})}async function y(t){try{return await t()}catch(e){if(!((e&&e.status)==="timeout"||e&&e.name==="TypeError"||/fetch|network/i.test(String(e&&e.message))))throw e;return await new Promise(o=>setTimeout(o,800)),t()}}function w(t,e="request"){return t?t.status===401?"API token was rejected (401). Run 'CodeMemory: Set API Token'.":t.status===404?"Backend returned 404. Check codememory.backendUrl.":t.status===409?"An index job is already running on the backend.":t.status===502?"LLM call failed (502). Try again in a moment.":t.status==="timeout"?`${e} timed out. Try a smaller token_budget or retry.`:t.name==="TypeError"||/fetch|network/i.test(String(t.message))?"Backend unreachable. Check codememory.backendUrl.":`${e} failed: ${t.message}`:""}var A="codememory.apiToken";async function x(t){return t.secrets.get(A)}function k(){let t=n.workspace.getConfiguration("codememory");return{url:(t.get("backendUrl")||"").trim(),owner:(t.get("repoOwner")||"").trim(),name:(t.get("repoName")||"").trim(),budget:t.get("tokenBudget")??3e4}}var b=class{constructor(e){this.ctx=e}view;tree=null;lastError=null;lastAnswer=null;resolveWebviewView(e){this.view=e,e.webview.options={enableScripts:!0},e.webview.html=this.render(),e.webview.onDidReceiveMessage(async r=>{if(r?.type==="refresh")await this.refresh();else if(r?.type==="ask")await n.commands.executeCommand("codememory.ask");else if(r?.type==="showNode"&&this.tree&&this.tree.nodes[r.id]){let s=this.tree.nodes[r.id],o=await n.workspace.openTextDocument({language:"markdown",content:B(s)});await n.window.showTextDocument(o,{preview:!0})}}),this.refresh()}setLastAnswer(e){this.lastAnswer=e,this.rerender()}async refresh(){this.lastError=null;let{url:e,owner:r,name:s}=k(),o=await x(this.ctx);if(!e){this.lastError="backend URL not set",this.rerender();return}if(!o){this.lastError="API token not set \u2014 run 'CodeMemory: Set API Token'",this.rerender();return}if(!r||!s){this.lastError="Set codememory.repoOwner and codememory.repoName in Settings.",this.rerender();return}try{this.tree=await y(()=>C(e,o,r,s)),this.rerender()}catch(c){this.lastError=w(c,"tree"),this.tree=null,this.rerender()}}rerender(){this.view&&(this.view.webview.html=this.render())}render(){let e=String(Math.random()).slice(2),r=JSON.stringify(this.tree||null),s=JSON.stringify(this.lastAnswer||null),o=this.lastError?h(this.lastError):"";return`<!DOCTYPE html><html><head><meta charset="utf-8">
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
${o?`<div class="err">${o}</div>`:""}
<div id="tree"></div>
<div id="answer" class="answer" hidden></div>
<script nonce="${e}">
  const vscode = acquireVsCodeApi();
  const TREE = ${r};
  const ANSWER = ${s};
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
      row.innerHTML='<span class="caret">\xB7</span><span class="badge b-'+n.type+'">'+n.type+'</span>'+esc(n.title||n.id);
      row.addEventListener("click",()=>vscode.postMessage({type:"showNode",id:n.id}));
      wrap.appendChild(row); return wrap;
    }
    const d=document.createElement("details"); if(openDefault)d.open=true;
    const s=document.createElement("summary"); s.className="row"; s.style.paddingLeft=(depth*10+4)+"px";
    s.innerHTML='<span class="caret">\u25B8</span><span class="badge b-'+n.type+'">'+n.type+'</span>'+esc(n.title||n.id);
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
    const savings=(ANSWER.naive_baseline_tokens>0)?Math.max(0,Math.round((1-ANSWER.token_count/ANSWER.naive_baseline_tokens)*100))+"%":"\u2014";
    el.innerHTML='<b>last answer</b><div class="stats"><div class="stat"><b>'+ANSWER.token_count+'</b> tokens</div><div class="stat"><b>'+savings+'</b> saved</div></div><pre style="white-space:pre-wrap;font-family:var(--vscode-editor-font-family);font-size:11.5px">'+esc(ANSWER.answer)+'</pre><details><summary>node paths ('+ANSWER.nodes_used.length+')</summary><ul class="paths">'+ANSWER.nodes_used.map(p=>'<li>'+esc(p)+'</li>').join("")+'</ul></details>';
  }
  document.getElementById("ask").addEventListener("click",()=>vscode.postMessage({type:"ask"}));
  document.getElementById("refresh").addEventListener("click",()=>vscode.postMessage({type:"refresh"}));
  renderTree(); renderAnswer();
</script></body></html>`}};function B(t){let e=[`# ${t.title}`,"",`_type: **${t.type}**_`,""],r=t.metadata||{};return r.pr_number&&e.push(`- PR **#${r.pr_number}**`),r.issue_number&&e.push(`- Issue **#${r.issue_number}**`),r.file_path&&e.push(`- File: \`${r.file_path}\``),r.author&&e.push(`- Author: @${r.author}`),r.merged_at&&e.push(`- Merged: ${r.merged_at}`),r.html_url&&e.push(`- URL: ${r.html_url}`),e.push(""),t.summary&&e.push("## Summary","",t.summary,""),t.content&&e.push("## Content","","```",t.content,"```",""),e.join(`
`)}function h(t){return t.replace(/[&<>"']/g,e=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[e])}async function U(t){let e=await n.window.showInputBox({prompt:"CodeMemory API token (stored in SecretStorage)",password:!0,ignoreFocusOut:!0,placeHolder:"CODEMEMORY_API_TOKEN"});e!==void 0&&(await t.secrets.store(A,e.trim()),n.window.showInformationMessage("CodeMemory: API token saved."))}async function q(t,e){let{url:r,owner:s,name:o,budget:c}=k(),p=await x(t);if(!r)return n.window.showErrorMessage("Set codememory.backendUrl in Settings.");if(!p){await n.window.showErrorMessage("CodeMemory API token not set.","Set token now")&&await n.commands.executeCommand("codememory.setToken");return}let u=n.window.activeTextEditor,a=u&&!u.selection.isEmpty?u.document.getText(u.selection).slice(0,500):"",i=await n.window.showInputBox({prompt:"Ask CodeMemory a question about this repo",value:a,ignoreFocusOut:!0,placeHolder:"e.g. How did session handling evolve and why?"});!i||!i.trim()||await n.window.withProgress({location:n.ProgressLocation.Notification,title:"CodeMemory: querying\u2026",cancellable:!1},async()=>{try{let d=await y(()=>R(r,p,{query:i.trim(),token_budget:c,repo_owner:s||void 0,repo_name:o||void 0}));e.setLastAnswer(d),await z(i,d)}catch(d){let l=w(d,"query"),m=await n.window.showErrorMessage(l,"Set token","Open Settings");m==="Set token"?n.commands.executeCommand("codememory.setToken"):m==="Open Settings"&&n.commands.executeCommand("workbench.action.openSettings","codememory")}})}async function z(t,e){let r=n.window.createWebviewPanel("codememory.answer","CodeMemory \xB7 answer",n.ViewColumn.Beside,{enableScripts:!1}),s=e.naive_baseline_tokens>0?Math.max(0,Math.round((1-e.token_count/e.naive_baseline_tokens)*100))+"%":"\u2014",o=e.nodes_used.map(c=>`<li>${h(c)}</li>`).join("");r.webview.html=`<!DOCTYPE html><html><head><meta charset="utf-8"><style>
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
<div class="q">Q: ${h(t)}</div>
<div class="stats">
  <div class="stat"><b>${e.token_count}</b><span>tokens packed</span></div>
  <div class="stat"><b>${e.naive_baseline_tokens}</b><span>naive baseline</span></div>
  <div class="stat"><b>${s}</b><span>saved vs naive</span></div>
  <div class="stat"><b>${e.nodes_used.length}</b><span>node paths</span></div>
</div>
<h3>Answer</h3>
<pre>${h(e.answer)}</pre>
<h3>Node paths (${e.nodes_used.length})</h3>
<ul>${o}</ul>
</body></html>`}function W(t){let e=n.window.createStatusBarItem(n.StatusBarAlignment.Left,100);e.text="$(sync~spin) CodeMemory",e.tooltip="CodeMemory backend status",e.show();let r=0,s=!1,o=async()=>{if(s)return;let{url:p}=k(),u=await x(t);if(!p){e.text="$(warning) CodeMemory: no URL";return}try{let a=await T(p);if(a&&a.status==="ok"){if(r=0,!u){e.text="$(warning) CodeMemory: no token";return}try{let i=await _(p,u),d=i.status==="indexing"?"$(sync~spin)":i.status==="failed"?"$(error)":"$(check)";e.text=`${d} CodeMemory \xB7 ${i.status}`,e.tooltip=`${i.status} \xB7 ${i.progress?.stage||"-"} \xB7 ${i.progress?.detail||""}`}catch(i){i.status===401?(e.text="$(key) CodeMemory: 401",e.tooltip="API token rejected"):e.text="$(warning) CodeMemory: status err"}}else e.text="$(warning) CodeMemory"}catch{r++,e.text="$(error) CodeMemory: offline",e.tooltip="backend unreachable",r>=4&&(s=!0,e.tooltip="backend unreachable \u2014 polling stopped")}};o();let c=setInterval(o,15e3);return t.subscriptions.push({dispose:()=>{s=!0,clearInterval(c),e.dispose()}}),{item:e,stop:()=>{s=!0,clearInterval(c)}}}function F(t){let e=new b(t);t.subscriptions.push(n.window.registerWebviewViewProvider("codememory.tree",e),n.commands.registerCommand("codememory.setToken",()=>U(t)),n.commands.registerCommand("codememory.ask",()=>q(t,e)),n.commands.registerCommand("codememory.refreshTree",()=>e.refresh())),W(t)}function D(){}0&&(module.exports={activate,deactivate});
