# CodeMemory — User Guide

Welcome. This guide walks you through using CodeMemory step by step. No terminal, no code. If you can click buttons and paste text, you can do this.

## The two tokens, explained

CodeMemory uses **two different tokens** that are easy to mix up. They are **NOT the same thing**.

| Token | What it is | Value | Where you paste it |
|---|---|---|---|
| **CodeMemory API token** | The app's password. Proves you are allowed to use this CodeMemory backend. | `codememory-dev-token-xzcU5a772sHS7PMx8LkLN7Iyj003MDVa` | Web app → **Settings** (top right) → *"CodeMemory API token"*. Or Chrome extension → **Options**. Or VS Code → command *"CodeMemory: Set API Token"*. |
| **GitHub token** | A key GitHub gives you so this app can read a public repo faster than the free anonymous limit. **Optional.** Only needed if you want to index a real GitHub repository. | You create it yourself at `https://github.com/settings/tokens` (see Part D). Starts with `ghp_...` or `github_pat_...`. | Web app → **Home** tab → *"github token (optional)"* field. That's the ONLY place it goes. |

**Rule of thumb.** If the app is complaining about "token invalid" or "401", it's talking about the **CodeMemory API token**. If indexing fails with "rate-limited", that's about the **GitHub token**.

---

## Part A — Using the web app

The web app is already running. Nothing to install.

1. Open this URL in your browser: **https://raptor-code-poc.preview.emergentagent.com**
2. Top-right, click **settings**. A small panel drops down.
3. In *"CodeMemory API token (app password)"* paste:
   `codememory-dev-token-xzcU5a772sHS7PMx8LkLN7Iyj003MDVa`
4. Click **save**. The chip in the top-right should turn green and read *"token: ok"*.
5. On the **Home** tab, keep the owner as `synth` and the repo as `webframework` (these already have a demo tree built). Leave "paths" and "github token" fields as-is.
6. Click **load existing tree**. In about a second, the left sidebar fills up with a hierarchy: `REPO → SUBSYSTEMS → TOPICS → ARTIFACTS`.
7. **Click any row** in the left sidebar. The middle switches to the **detail** tab and shows that node's title, summary, and (for files/PRs) metadata like PR number and author.
8. Click the **query** tab at the top.
9. In the big text box, type or paste: **How did session handling evolve and why?**
10. Leave `token_budget` at 30000. Click **ask**. Wait 15-30 seconds (the AI is thinking).
11. You'll see four number tiles and an answer:
    - **tokens packed** = how much context CodeMemory sent to the AI. Smaller is cheaper and faster.
    - **naive baseline** = how much context you'd send if you had NO memory layer and just dumped every PR at the AI.
    - **saved vs naive** = how much you saved. E.g. `33%` means CodeMemory answered the question with about a third fewer tokens than the brute-force approach.
    - **node paths** = the specific pieces of the repo CodeMemory used to answer you — each path reads like a breadcrumb from repo down to the exact PR or file.

**Plain-English version.** Imagine your codebase is a huge encyclopedia. A naive AI reads the whole thing every time you ask a question, which is slow and expensive. CodeMemory pre-reads and summarises the encyclopedia into a table of contents (subsystems), chapter summaries (topics), and lets the AI look up just the paragraphs that matter for your specific question. The "saved" percentage is what you save on every question forever.

---

## Part B — Installing the Chrome extension

Use this if you want to ask CodeMemory questions about text you highlight on any web page (great on github.com).

1. Open the web app (Part A) and go to the **Home** tab.
2. Scroll to the *"get the extensions"* panel and click **↓ Chrome extension (.zip)**. Save the file.
3. **Unzip** the file. You'll get a folder called `chrome`.
4. In Chrome, open a new tab and go to `chrome://extensions/`.
5. Top-right, turn ON the **Developer mode** switch.
6. Top-left, click **Load unpacked**. Select the `chrome` folder from step 3.
7. The extension appears in the list. Click the **puzzle** icon in your Chrome toolbar and **pin** CodeMemory so its icon stays visible.
8. Right-click the CodeMemory icon → **Options**. A page opens.
9. Fill in:
   - **backend url**: `https://raptor-code-poc.preview.emergentagent.com`
   - **api token**: `codememory-dev-token-xzcU5a772sHS7PMx8LkLN7Iyj003MDVa`
10. Click **save**, then **test connection**. You should see a green message. If your backend URL is not the default preview, also click **grant host permission** and approve.
11. Close the options page. Click the pinned CodeMemory icon: a popup opens with a query box.
12. **Bonus — the context menu**: highlight any text on any web page → right-click → **Ask CodeMemory about this**. Next time you open the popup (within 60 seconds) your selection is pre-filled as the query.

---

## Part C — Installing the VS Code extension

Use this to ask CodeMemory questions from inside your editor.

1. Open the web app → **Home** tab → click **↓ VS Code extension (.vsix)**. Save the file.
2. Open **VS Code**.
3. On the left sidebar, click the **Extensions** icon (four squares).
4. Top of the Extensions panel, click the **···** menu → **Install from VSIX…**
5. Pick the `.vsix` file you downloaded. VS Code installs it silently.
6. Press **Ctrl+Shift+P** (or **Cmd+Shift+P** on Mac) to open the command palette. Type **CodeMemory: Set API Token**. Press Enter. Paste `codememory-dev-token-xzcU5a772sHS7PMx8LkLN7Iyj003MDVa` and press Enter. The token is stored securely in VS Code's SecretStorage (never in plain text).
7. Open VS Code Settings (**Ctrl+,** / **Cmd+,**) and search for **codememory**. Set:
   - `codememory.backendUrl`: `https://raptor-code-poc.preview.emergentagent.com`
   - `codememory.repoOwner`: `synth`
   - `codememory.repoName`: `webframework`
8. On the left activity bar (icons on the far left of VS Code), you'll see a new **CodeMemory** icon. Click it. The tree loads.
9. **To ask a question**: press **Ctrl+Shift+P** → **CodeMemory: Ask a question**. Type your question, press Enter. A side panel opens with the answer, token counts, and node paths.
10. **Tip**: if you have text selected in the editor when you run the command, that selection pre-fills the question.

---

## Part D — Indexing a real GitHub repository

You've been playing with a synthetic demo tree (`synth/webframework`). Here's how to point CodeMemory at any real public GitHub repo.

**Why you need a GitHub token here.** GitHub allows only 60 requests per hour without any account. Indexing a repo touches many API endpoints (list of PRs, comments on each PR, the diff of each PR, list of issues, comments on each, plus source files). Even a small repo blows past 60. With a personal token you get 5000 requests per hour — plenty.

### Create a fine-grained GitHub token (2 minutes)

1. Go to **https://github.com/settings/tokens?type=beta** and sign in.
2. Click **Generate new token**. Give it a name like *"CodeMemory read-only"*.
3. **Expiration**: 90 days is a reasonable default.
4. **Repository access**: select **Public Repositories (read-only)**. This is the safest option — the token can only read publicly available data.
5. Leave all Permissions at their defaults (no extra scopes needed for public reads).
6. Click **Generate token**. Copy the value shown (starts with `github_pat_...`). **You will only see it once** — paste it somewhere safe.

### Kick off the index

1. Open the web app → **Home** tab.
2. Fill:
   - **owner**: e.g. `pallets`
   - **repo**: e.g. `itsdangerous`
   - **paths**: e.g. `src/itsdangerous` (leave blank to index the whole repo, but that is slower and uses more tokens)
   - **github token (optional)**: paste your `github_pat_...` value here. This field is ONLY for the GitHub token — not the CodeMemory API token.
3. Click **index this repo**. The **status** panel on the right shows live progress: *fetching → chunking → embedding → clustering → summarizing → persisting → complete*.
4. Expect **5-10 minutes** for a small-to-medium repo. It's a real AI pipeline running many summarisation calls under the hood.
5. When status flips to *complete*, the tree appears in the left sidebar. Head to the **query** tab and ask something like *"What is this project for and how has its security posture evolved?"*.

---

## Troubleshooting

| What you see | What it means | Fix |
|---|---|---|
| Top-right chip says *"token: invalid"* (red) | The **CodeMemory API token** is wrong or missing. | Click **settings** → paste the correct token → **save**. |
| Red banner *"backend unreachable"* | The web app can't reach the CodeMemory server. | Check your internet, and that the URL in the address bar starts with `https://raptor-code-poc.preview.emergentagent.com`. |
| Sidebar says *"no tree for this repo yet"* | You haven't loaded or indexed this repo. | Home tab → **load existing tree** (for the demo) or **index this repo** (for a real one). |
| Query takes 15-30 seconds | This is **normal** — you're calling a real AI model. Nothing is broken. | Wait. If it takes more than 90 seconds, retry with a smaller `token_budget` (e.g. 8000). |
| Chrome/VS Code extension shows **401** or *"token was rejected"* | The extension has the wrong CodeMemory API token. | Chrome: right-click the icon → **Options** → re-paste → **test connection**. VS Code: **Ctrl/Cmd+Shift+P** → *CodeMemory: Set API Token*. |
| Indexing fails with a message about *"rate limit"* or *"403"* | You tried to index a real repo without a GitHub token, or your GitHub token expired. | Create a fresh **GitHub token** (Part D) and paste it into the *github token* field on the Home page. |
| Extension **Options** page won't reach your backend on a URL other than the default preview | MV3 restricts which hosts an extension can talk to. | On the Options page, click **grant host permission** after saving the URL, then approve the Chrome prompt. |

---

## In one sentence

CodeMemory reads a GitHub repo once, builds a smart, hierarchical map of its PRs / issues / code, and then answers questions about it using far fewer AI tokens than the naive "just paste everything" approach — with the savings visible on every query.

Enjoy.
