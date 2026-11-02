// Handles the keyboard shortcut (default Alt+Shift+R) — runs the same
// "Mark as viewed" action as the popup, using the saved glob patterns.
importScripts('apply-globs.js');

const STORAGE_KEY = 'glob_patterns';

// Global (not per-tab) badge: per-tab badges are cleared by the reload that
// follows marking.
function flashBadge(text, color) {
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setBadgeText({ text });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 4000);
}

// Relays GitHub CLI requests from content scripts (which can't use native
// messaging) to native/gh_host.py.
const GH_HOST = 'com.my_github_harness.gh';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'gh') return;
  chrome.runtime.sendNativeMessage(GH_HOST, msg.request, (response) => {
    sendResponse(chrome.runtime.lastError ? { error: chrome.runtime.lastError.message } : response);
  });
  return true; // async response
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'mark-as-viewed') return;
  if (!tab?.url?.match(/github\.com\/.+\/pull\/\d+/)) return;

  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const patterns = (stored[STORAGE_KEY] || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  let result;
  try {
    [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: applyGlobs,
      args: [patterns, 'mark'],
    });
  } catch (err) {
    flashBadge('!', '#cf222e');
    return;
  }

  if (result?.result?.error) {
    flashBadge('!', '#cf222e');
  } else {
    flashBadge(String(result.result.clicked), '#1f883d');
  }
});
