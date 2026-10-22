const STORAGE_KEY = 'glob_patterns';

const globsEl = document.getElementById('globs');
const markBtn = document.getElementById('mark-btn');
const unmarkBtn = document.getElementById('unmark-btn');
const statusEl = document.getElementById('status');

// Restore saved patterns on open
chrome.storage.local.get(STORAGE_KEY, (result) => {
  if (result[STORAGE_KEY]) {
    globsEl.value = result[STORAGE_KEY];
  }
});

// Save patterns whenever textarea changes
globsEl.addEventListener('input', () => {
  chrome.storage.local.set({ [STORAGE_KEY]: globsEl.value });
});

// Visual feature toggles — read live by pulls.js via storage.onChanged.
const FEATURES_KEY = 'visual_features';
const featureEls = document.querySelectorAll('input[data-feature]');

chrome.storage.local.get(FEATURES_KEY, (result) => {
  const features = result[FEATURES_KEY] || {};
  featureEls.forEach((el) => {
    el.checked = !!features[el.dataset.feature];
  });
});

featureEls.forEach((el) => {
  el.addEventListener('change', () => {
    const features = {};
    featureEls.forEach((f) => {
      features[f.dataset.feature] = f.checked;
    });
    chrome.storage.local.set({ [FEATURES_KEY]: features });
  });
});

function setStatus(msg, type = 'info') {
  statusEl.textContent = msg;
  statusEl.className = type;
}

async function sendAction(action) {
  const patterns = globsEl.value
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab?.url?.match(/github\.com\/.+\/pull\/\d+/)) {
    setStatus('Not a GitHub PR page.', 'error');
    return;
  }

  let result;
  try {
    [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: applyGlobs,
      args: [patterns, action],
    });
  } catch (err) {
    setStatus('Cannot access page. Try refreshing.', 'error');
    return;
  }

  if (result?.result?.error) {
    setStatus(result.result.error, 'error');
  } else {
    const { clicked, total, reloading } = result.result;
    const verb = action === 'mark' ? 'Marked' : 'Unmarked';
    const suffix = reloading ? ' Reloading for review…' : '';
    setStatus(`${verb} ${clicked} of ${total} matched file(s).${suffix}`, 'success');
  }
}

markBtn.addEventListener('click', () => sendAction('mark'));
unmarkBtn.addEventListener('click', () => sendAction('unmark'));
