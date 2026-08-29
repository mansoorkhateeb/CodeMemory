# CodeMemory — Chrome extension (MV3)

Ask the CodeMemory backend about a repo's evolution, PRs, and design decisions
directly from any tab.

## What's inside
```
chrome/
├── manifest.json          Manifest V3
├── background.js          service worker (context menu)
├── popup.html + popup.js  the query popup
├── options.html + options.js  backend URL + API token + test connection
├── api.js                 pure API-calling helpers (also used from Node in verify.mjs)
├── verify.mjs             live-backend verification script
└── icons/                 16 / 32 / 48 / 128 PNGs
```

## Install (unpacked, developer mode)

1. Open `chrome://extensions/`, enable **Developer mode** (top-right).
2. Click **Load unpacked** and select `/app/extensions/chrome/`.
3. Pin the CodeMemory action to your toolbar (puzzle icon → pin).
4. Right-click the action → **Options**:
   - **backend url**: `https://raptor-code-poc.preview.emergentagent.com`
     (or wherever the backend is running).
   - **api token**: paste the value of `CODEMEMORY_API_TOKEN`
     (see `/app/memory/test_credentials.md`).
   - Click **save** → **test connection**. Both `/api/health` and
     `/api/index/status` should succeed.
   - If the backend URL is anything other than the preview URL, click
     **grant host permission** first (MV3 host permissions).

## Use
- Click the toolbar icon → popup opens with a textarea, `token_budget`, and
  **ask** button. Ctrl/Cmd+Enter also submits.
- Result: token_count / naive_baseline / saved-% / paths + gpt-5 answer +
  collapsible node-paths list.
- **Context menu**: select text on any page → right-click → **Ask CodeMemory
  about this**. The next popup pre-fills the query with your selection
  (valid for 60s).

## Host permissions (MV3-compliant approach)
- Compile-time `host_permissions` targets **only** the known preview backend
  origin — the extension does NOT declare `<all_urls>`.
- `optional_host_permissions` lists `https://*/*` / `http://*/*` so users can
  point at a different backend via the Options page (**grant host
  permission** button), which triggers a runtime `chrome.permissions.request`.

## Errors surfaced (no silent failures)
- Backend unreachable → red banner "Backend unreachable…".
- 401 bad token → "Bearer token was rejected (401). Open Options…".
- 502 LLM failure → "LLM call failed (502). Try again in a moment.".
- Request timeout (90s query) → "…timed out. Try a smaller token_budget…".
- Repo not indexed → surfaced via the backend's graceful 200 response
  (`answer` field reads "No repository indexed yet…"). Rendered verbatim.

## Live verification (against a running backend)
```
node /app/extensions/chrome/verify.mjs \
  --url  https://raptor-code-poc.preview.emergentagent.com \
  --token codememory-dev-token-...
```
Exercises: health, unreachable URL, 401 path, real `/api/query`, timeout path.

## Package
```
cd /app/extensions && zip -r codememory-chrome.zip chrome \
  -x 'chrome/verify.mjs' -x 'chrome/README.md' -x 'chrome/*.md'
```
Ship `/app/extensions/codememory-chrome.zip`.
