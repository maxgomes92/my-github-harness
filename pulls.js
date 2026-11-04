// Content script for PR list pages (github.com/:owner/:repo/pulls): stack
// highlighting and APPROVE / REAPPROVE buttons.
// Runs on every github.com page because GitHub navigates client-side, so we
// can't rely on a full page load landing on /pulls.

const FEATURES_KEY = 'visual_features';
const ATTR = 'data-gmav-stack';

// Ordered so consecutive stacks get far-apart hues (most pages show only
// 2–4 stacks, so the first few colors matter most). Mid-brightness so they
// read on both light and dark GitHub themes.
const STACK_COLORS = [
  '#2f81f7', // blue     (215°)
  '#f0883e', // orange   (25°)
  '#3fb950', // green    (130°)
  '#db61a2', // magenta  (330°)
  '#d4b11a', // yellow   (50°)
  '#8957e5', // purple   (265°)
  '#1fb5b0', // teal     (178°)
  '#e5534b', // red      (3°)
];

let features = {};
const branchCache = new Map(); // "owner/repo#123" -> Promise<{ base, head } | null>

function pullsRepo() {
  const m = location.pathname.match(/^\/([^/]+)\/([^/]+)\/pulls\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

// Returns [{ number, row }] for each PR row on the list page.
function collectRows(repo) {
  const prHref = new RegExp(`/${repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/pull/(\\d+)$`);
  const links =
    document.querySelectorAll('a[data-testid="listitem-title-link"]').length > 0
      ? document.querySelectorAll('a[data-testid="listitem-title-link"]')
      : // Legacy (non-React) list
        document.querySelectorAll('.js-issue-row a.js-navigation-open[href*="/pull/"]');

  const rows = [];
  for (const a of links) {
    const m = new URL(a.href, location.origin).pathname.match(prHref);
    if (!m) continue;
    const row = a.closest('li, .js-issue-row');
    if (row) rows.push({ number: Number(m[1]), row });
  }
  return rows;
}

// Base/head branches of every open PR in the repo, from one `gh pr list` call
// via the native host. Covering the whole repo (not just this page) means
// stacks split across pages still link up and keep the same color.
const BRANCHES_TTL = 60_000;
let repoBranches = null; // { repo, at, prs: Promise<Map<number, { number, base, head }>> }

function fetchRepoBranches(repo) {
  if (!repoBranches || repoBranches.repo !== repo || Date.now() - repoBranches.at > BRANCHES_TTL) {
    repoBranches = {
      repo,
      at: Date.now(),
      prs: gh({ action: 'branches', repo })
        .then((res) => {
          if (res?.error) console.warn('[My GitHub Harness] branches:', res.error);
          return new Map((res?.prs || []).map((pr) => [pr.number, pr]));
        })
        .catch(() => new Map()),
    };
  }
  return repoBranches.prs;
}

// Fallback when gh doesn't cover a row (host not installed, or the PR was
// opened since the last refresh): fetch the PR page (same-origin, so it works
// for private repos) and pull the base/head branch names out of it.
function fetchBranches(repo, number) {
  const key = `${repo}#${number}`;
  if (!branchCache.has(key)) {
    const promise = fetch(`/${repo}/pull/${number}`, { credentials: 'same-origin' })
      .then((res) => (res.ok ? res.text() : null))
      .then((html) => (html ? parseBranches(html) : null))
      .catch(() => null)
      .then((result) => {
        // Don't cache failures so a later pass can retry.
        if (!result) branchCache.delete(key);
        return result;
      });
    branchCache.set(key, promise);
  }
  return branchCache.get(key);
}

function parseBranches(html) {
  // React PR page: branch names live in the embedded JSON payload.
  const str = '"((?:[^"\\\\]|\\\\.)*)"';
  const base = html.match(new RegExp(`"baseBranch":${str}`));
  const head = html.match(new RegExp(`"headBranch":${str}`));
  if (base && head) {
    return { base: JSON.parse(`"${base[1]}"`), head: JSON.parse(`"${head[1]}"`) };
  }

  // Legacy PR page: <span class="base-ref" title="owner/repo:branch">.
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const ref = (cls) => {
    const el = doc.querySelector(`.${cls}`);
    const text = el?.getAttribute('title') || el?.textContent || '';
    return text.trim().replace(/^[^:]*:/, '') || null;
  };
  const legacyBase = ref('base-ref');
  const legacyHead = ref('head-ref');
  return legacyBase && legacyHead ? { base: legacyBase, head: legacyHead } : null;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Group PRs into stacks: a PR belongs to the same stack as the PR whose head
// branch it targets. Fork PRs have a null head and never act as a parent.
// Returns Map<number, color>.
function computeStacks(prs) {
  const byHead = new Map(prs.filter((pr) => pr.head).map((pr) => [pr.head, pr]));
  const parentOf = (pr) => (pr.base !== pr.head ? byHead.get(pr.base) : undefined);

  // Union-find over PR numbers.
  const root = new Map(prs.map((pr) => [pr.number, pr.number]));
  const find = (n) => (root.get(n) === n ? n : find(root.get(n)));
  for (const pr of prs) {
    const parent = parentOf(pr);
    if (parent) root.set(find(pr.number), find(parent.number));
  }

  const groups = new Map();
  for (const pr of prs) {
    const r = find(pr.number);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(pr);
  }

  // Color stacks in order of their lowest PR number so colors stay stable
  // across pages and re-renders.
  const stacks = [...groups.values()]
    .filter((g) => g.length > 1)
    .sort((a, b) => Math.min(...a.map((p) => p.number)) - Math.min(...b.map((p) => p.number)));

  const info = new Map();
  stacks.forEach((group, i) => {
    const color = STACK_COLORS[i % STACK_COLORS.length];
    for (const pr of group) {
      info.set(pr.number, color);
    }
  });
  return info;
}

function paintRow({ row }, color) {
  const value = color || null;
  if (row.getAttribute(ATTR) === value) return; // unchanged — avoid DOM churn

  clearRow(row);
  if (!color) return;

  row.setAttribute(ATTR, color);
  row.style.boxShadow = `inset 6px 0 0 ${color}`;
  row.style.backgroundColor = `color-mix(in srgb, ${color} 10%, transparent)`;
}

function clearRow(row) {
  if (!row.hasAttribute(ATTR)) return;
  row.removeAttribute(ATTR);
  row.style.boxShadow = '';
  row.style.backgroundColor = '';
}

let runId = 0;

async function highlightStacks() {
  const id = ++runId;
  const repo = pullsRepo();

  if (!repo || !features.highlightStacks) {
    document.querySelectorAll(`[${ATTR}]`).forEach(clearRow);
    return;
  }

  const rows = collectRows(repo);
  const known = await fetchRepoBranches(repo);
  if (id !== runId) return; // a newer pass superseded this one

  const missing = rows.filter((r) => !known.has(r.number));
  const scraped = await mapLimit(missing, 6, (r) => fetchBranches(repo, r.number));
  if (id !== runId) return;

  const prs = [
    ...known.values(),
    ...missing.map((r, i) => scraped[i] && { number: r.number, ...scraped[i] }).filter(Boolean),
  ];
  const stacks = computeStacks(prs);

  // Re-collect: the list may have re-rendered while we were fetching.
  for (const r of collectRows(repo)) paintRow(r, stacks.get(r.number));
}

// One-click approval buttons: REAPPROVE on PRs where the user's approval was
// dismissed (e.g. by a new push), APPROVE on bot-authored PRs not yet approved.
// Goes through background.js to the GitHub CLI native host.
const APPROVE_ATTR = 'data-gmav-approve';
const APPROVABLE_TTL = 60_000;

let approvable = null; // { repo, at, labels: Promise<Map<number, label>> }
const approveState = new Map(); // "owner/repo#123" -> 'pending' | 'done' | error string
const approveWarnings = new Map(); // "owner/repo#123" -> warning (approved, but assigning failed)

function gh(request) {
  return chrome.runtime.sendMessage({ type: 'gh', request });
}

function fetchApprovable(repo) {
  if (!approvable || approvable.repo !== repo || Date.now() - approvable.at > APPROVABLE_TTL) {
    approvable = {
      repo,
      at: Date.now(),
      labels: gh({ action: 'approvable', repo })
        .then((res) => {
          if (res?.error) console.warn('[My GitHub Harness] approvable:', res.error);
          return new Map([
            ...(res?.approve || []).map((n) => [n, 'APPROVE']),
            ...(res?.reapprove || []).map((n) => [n, 'REAPPROVE']),
          ]);
        })
        .catch(() => new Map()),
    };
  }
  return approvable.labels;
}

function renderButton(btn, state) {
  btn.disabled = state === 'pending' || state === 'done';
  btn.textContent = state === 'pending' ? 'Approving…' : state === 'done' ? 'Approved ✓' : btn.dataset.label;
  btn.title =
    state && state !== 'pending' && state !== 'done'
      ? `Failed: ${state}`
      : approveWarnings.get(btn.getAttribute(APPROVE_ATTR)) || '';
  btn.style.background = state === 'done' ? 'transparent' : state && state !== 'pending' ? '#cf222e' : '#1f883d';
  btn.style.color = state === 'done' ? '#1a7f37' : '#ffffff';
  btn.style.cursor = btn.disabled ? 'default' : 'pointer';
}

function createButton(repo, number, label) {
  const key = `${repo}#${number}`;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.dataset.label = label;
  btn.setAttribute(APPROVE_ATTR, key);
  Object.assign(btn.style, {
    marginLeft: '8px',
    padding: '0 8px',
    height: '20px',
    border: '1px solid rgba(31, 35, 40, 0.15)',
    borderRadius: '6px',
    fontSize: '11px',
    fontWeight: '600',
    lineHeight: '18px',
    verticalAlign: 'middle',
  });
  renderButton(btn, approveState.get(key));

  btn.addEventListener('click', async (e) => {
    // Rows are clickable; don't open the PR.
    e.preventDefault();
    e.stopPropagation();
    if (btn.disabled) return;

    approveState.set(key, 'pending');
    renderButton(btn, 'pending');
    const res = await gh({ action: 'approve', repo, number }).catch((err) => ({ error: err.message }));
    const state = res?.ok ? 'done' : res?.error || 'No response from gh host';
    if (res?.warning) approveWarnings.set(key, res.warning);
    approveState.set(key, state);
    // The row may have re-rendered meanwhile; update whichever button is live.
    document.querySelectorAll(`[${APPROVE_ATTR}="${key}"]`).forEach((b) => renderButton(b, state));
  });
  return btn;
}

let approveRunId = 0;
const shownLabels = new Map(); // "owner/repo#123" -> label, so results outlive a refresh

async function renderApproveButtons() {
  const id = ++approveRunId;
  const repo = pullsRepo();
  if (!repo) return;

  const labels = await fetchApprovable(repo);
  if (id !== approveRunId) return;

  for (const { number, row } of collectRows(repo)) {
    const key = `${repo}#${number}`;
    // Keep showing the result after approving, even once it's no longer approvable.
    const label = labels.get(number) || (approveState.has(key) && shownLabels.get(key));
    if (!label) continue;
    if (row.querySelector(`[${APPROVE_ATTR}]`)) continue;
    shownLabels.set(key, label);

    const title = row.querySelector('a[data-testid="listitem-title-link"], a.js-navigation-open');
    const anchor = row.querySelector('[class*="trailingBadgesContainer"]');
    if (anchor) anchor.append(createButton(repo, number, label));
    else title?.after(createButton(repo, number, label));
  }
}

let timer = null;
function schedule() {
  // Throttle rather than debounce: GitHub mutates the DOM constantly
  // (relative timestamps, deferred status icons), which would starve a debounce.
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    highlightStacks();
    renderApproveButtons();
  }, 300);
}

chrome.storage.local.get(FEATURES_KEY, (result) => {
  features = result[FEATURES_KEY] || {};
  schedule();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[FEATURES_KEY]) {
    features = changes[FEATURES_KEY].newValue || {};
    schedule();
  }
});

// GitHub re-renders the list on navigation, filtering and pagination.
new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
