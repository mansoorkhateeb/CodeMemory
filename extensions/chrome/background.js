// background.js (MV3 service worker) — context menu → save selection.
// No auth/network here; the popup handles all API calls.

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "codememory-ask",
    title: "Ask CodeMemory about this",
    contexts: ["selection"],
  });
});

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== "codememory-ask") return;
  const selection = (info.selectionText || "").trim();
  if (!selection) return;
  await chrome.storage.local.set({
    pending_selection: selection,
    pending_selection_at: Date.now(),
  });
  // Best-effort: open the popup so the user sees it immediately.
  // openPopup() is only available on toolbar-pinned actions in some Chrome
  // versions; ignore failure and rely on the next popup open.
  try { await chrome.action.openPopup(); } catch (_) {}
});
