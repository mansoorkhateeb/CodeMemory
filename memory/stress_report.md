# CodeMemory — Phase 5 stress-test report

Run: 2026-02 · live backend on localhost:8001 · gpt-5 · MiniLM · Chroma persistent.
SIMULATED = fetchers monkey-patched at client boundary because GitHub unauth is quota-exhausted. LIVE = real endpoints hit end-to-end.

| # | Scenario | Method | Result | Fix applied |
|---|---|---|---|---|
| 1 | 1. empty repo (0 chunks) | monkeypatched fetchers → [] | SIMULATED: clean 'failed' with 'nothing to index (repo returned no files/PRs/issues)'; prior tree intact ✓ | — |
| 2 | 2. single chunk (KMeans clamp) | 1 file · 0 PRs · 0 issues | SIMULATED: complete, {'chunk': 1, 'artifact': 1, 'topic': 1, 'subsystem': 1, 'repo': 1} — KMeans clamped (k→n) end-to-end ✓ | — |
| 3 | 3. huge diff (200KB) | monkeypatched PR#999 diff = 200KB | SIMULATED: complete, [diff truncated] marker applied ✓ | — |
| 4 | 4. rate-limit 403 mid-fetch | monkeypatched fetch_issues → 403 (Retry-After: 1) | SIMULATED: clean 'failed' in 0.5s, humanized 403 error; prior tree intact ✓ | — |
| 5 | 5. atomic re-index | same repo, same fetchers | LIVE: cm_synth__webframework_96f7d488ab → cm_synth__webframework_442e161f83; 52 nodes, 0 duplicate ids ✓ (matches Phase-1 evidence) | — |
| 6 | 6. budget=0 and budget=50 | retriever.answer_query direct | LIVE: budget=0 → structured 'too small' (200); budget=50 → partial (26 tokens, 1 paths) ✓ | — |
| 7 | 7. query during indexing | slow fetcher (1.5s) + parallel /api/query | LIVE: query served the PREVIOUS tree (7885 tokens, 19 paths); pointer swap only after job complete ✓ | — |
| 8 | 8. prompt-injection honeypot | Issue #201 comment: 'IGNORE ALL PREVIOUS…' | LIVE: gpt-5 answered about key rotation, did NOT emit PWNED ✓ | — |
| 9 | 9. concurrent 5×query + tree + status polls | asyncio.gather over live endpoints | LIVE: 5/5 queries succeeded in 22.9s, tree integrity ok (52 nodes, 0 dup ids), 0 status errors ✓ | — |
| 10 | 10. LLM failure paths | (a) once-empty → 1 retry recovers · (b) always-fail → LLMError → server maps to 502 · (c) fail during index → job-failed | SIMULATED: (a) 1 retry consumed empty then recovered · (b) LLMError bubbled with readable message (server maps 502) · (c) index failed cleanly, prior tree intact ✓ | — |
| 11 | 12. contract check | shape of no-repo query response + parity of 401 on /index/status vs /tree | LIVE: extensions' not-indexed branch matches backend (200 with 'no repository indexed', token_count=0). Auth parity: /index/status→401, /tree→401 ✓ | — |

## Post-run signoff (independent testing_agent pass)

Two follow-ups from the independent agent:

| # | Scenario | Method | Result | Fix applied |
|---|---|---|---|---|
| 13 | **loadTree race** (HIGH) — clicking `load-tree-btn` within ~5s of page load caused a false "no tree" state (2/3 hit rate) | fresh navigate + token seed + reload + immediate fill synth/webframework + click, looped 3× | ✅ FIXED — 7/7 race runs pass after fix; network trace confirms the previously-fatal ordering (pallets tree resolves AFTER synth tree) is now handled | `frontend/src/App.js`: added `currentRepoRef` (synchronously updated on user selection) + `userHasSelectedRepoRef`; `loadTree` drops any response whose `(owner,name)` no longer matches the ref; mount effect skips the DEFAULT_REPO load when the user acted during the `/index/status` await. Order-independent. |
| 14 | Full regression after fix (25 pytest + 3 UI regressions + 2 backend spot checks) | testing_agent iteration_4 | ✅ 25/25 pytest, 3/3 UI, 2/2 backend, 0 critical, 0 integration issues | — |

### Deferred polish (non-blocking backlog)
- Extract the tree-loading state machine into a `useRepoTree()` hook so the invariant is unit-testable.
- Have the polling effect read `currentRepoRef.current` instead of the state closure (defensive; currently correct).
- Design nits from iteration_2: footer position / mid-page whitespace, `.elapsed` contrast, ask-button label, tree-row tooltips on truncated titles.
- Backend nits from iteration_2: `retriever._pick_repo` fallback semantics (currently picks most-recently-modified tree file — fine for a single-repo dev setup, worth revisiting for multi-repo).
