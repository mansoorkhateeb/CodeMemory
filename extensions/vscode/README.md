# CodeMemory — VS Code extension

Hierarchical, token-aware memory over a GitHub repo — right in your editor.

## Features
- **Command: `CodeMemory: Ask a question`** — input box (prefilled with the current selection if any) → shows a webview panel with the gpt-5 answer, token counts, savings %, and the list of node paths.
- **Sidebar (Activity bar → CodeMemory)** — collapsible tree of `subsystem → topic → artifact/chunk` from `GET /api/tree`. Double-click a node to open its summary + metadata as a markdown preview. The last answer is shown at the bottom of the sidebar.
- **Status bar item** — polls `/api/health` + `/api/index/status` every 15s (`$(check) · complete`, `$(sync~spin) · indexing`, `$(error) offline`, `$(key) 401`). Polling stops after 4 consecutive failures until you re-run `CodeMemory: Refresh tree`.
- **Command: `CodeMemory: Set API Token`** — prompts and stores the bearer token in VS Code **SecretStorage** (never a plain setting).

## Settings
- `codememory.backendUrl` — base URL of the backend (default = preview URL).
- `codememory.repoOwner`, `codememory.repoName` — scope tree + queries.
- `codememory.tokenBudget` — default `token_budget` for `/api/query` (30000).

Token is stored via `context.secrets.store("codememory.apiToken", …)`. There is **no** `codememory.apiToken` setting — the extension will not read a token from settings.json.

## Install (installing the .vsix)
```
code --install-extension /app/extensions/codememory-vscode.vsix
```
Or from VS Code: `Extensions` view → `···` → **Install from VSIX…** → pick the file.

After install:
1. `CodeMemory: Set API Token` (Ctrl/Cmd+Shift+P) → paste `CODEMEMORY_API_TOKEN`
   (see `/app/memory/test_credentials.md`).
2. Open Settings → search `codememory`. Set `repoOwner` + `repoName`
   (e.g. `synth` / `webframework` to hit the synthetic tree we built in Phase 2).
3. Click the **CodeMemory** icon in the Activity bar → the tree loads.
4. Run **CodeMemory: Ask a question** or click **ask a question** in the sidebar.

## Manual install (if vsix isn't available)
```
# 1. compile
cd /app/extensions/vscode && yarn install && yarn compile
# 2. link into your local VS Code extensions folder
cp -r /app/extensions/vscode ~/.vscode/extensions/codememory-0.1.0
# 3. reload window
```

## Build from source
```
cd /app/extensions/vscode
yarn install
yarn typecheck        # tsc --noEmit
yarn compile          # esbuild → out/extension.js
npx @vscode/vsce package    # → codememory-0.1.0.vsix
```

## Error surfaces (no silent failures)
- **Backend unreachable** — status bar `$(error) offline`; `showErrorMessage("Backend unreachable …")` on any command that runs.
- **401 bad token** — `showErrorMessage("API token was rejected (401). Run 'CodeMemory: Set API Token'.")` with a "Set token" action button.
- **Repo not indexed** — surfaced by the backend's graceful 200 (`answer = "No repository indexed yet …"`), rendered in the answer panel verbatim.
- **LLM failure (502)** — `showErrorMessage("LLM call failed (502). Try again in a moment.")`.
- **Timeout (90s)** — `showErrorMessage("query timed out …")`.

All network calls use `withOneRetry(...)` — at most one automatic retry on transient network / timeout, then visible failure. `getToken()` is called on every command and the sidebar refresh; there is no in-memory cache to go stale.
