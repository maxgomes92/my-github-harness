// Content script for PR list pages (github.com/:owner/:repo/pulls): stack
// highlighting, APPROVE / REAPPROVE buttons and highlighting your own PRs.
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

// One-click approval buttons: REAPPROVE on PRs the user reviewed before the
// latest push (or whose approval was dismissed), APPROVE on bot-authored or
// assigned PRs they haven't reviewed, and otherwise a badge with their review
// status.
// Goes through background.js to the GitHub CLI native host.
const APPROVE_ATTR = 'data-gmav-approve';
const STATUS_ATTR = 'data-gmav-review-status';
const APPROVABLE_TTL = 60_000;

let approvable = null; // { repo, at, result: Promise<{ labels: Map<number, label>, reviews: Map<number, { state }> }> }
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
      result: gh({ action: 'approvable', repo })
        .then((res) => {
          if (res?.error) console.warn('[My GitHub Harness] approvable:', res.error);
          return {
            labels: new Map([
              ...(res?.approve || []).map((n) => [n, 'APPROVE']),
              ...(res?.reapprove || []).map((n) => [n, 'REAPPROVE']),
            ]),
            reviews: new Map(Object.entries(res?.reviews || {}).map(([n, r]) => [Number(n), r])),
          };
        })
        .catch(() => ({ labels: new Map(), reviews: new Map() })),
    };
  }
  return approvable.result;
}

const REVIEW_STATUS = {
  APPROVED: { text: 'Approved', color: '#1a7f37' },
  CHANGES_REQUESTED: { text: 'Changes requested', color: '#cf222e' },
  COMMENTED: { text: 'Commented', color: '#8c959f' },
};

function createStatus(review) {
  const { text, color } = REVIEW_STATUS[review.state] || { text: review.state, color: '#8c959f' };
  const badge = document.createElement('span');
  badge.textContent = text;
  badge.title = 'Your latest review';
  Object.assign(badge.style, {
    marginLeft: '8px',
    padding: '0 7px',
    border: `1px solid ${color}`,
    borderRadius: '2em',
    color,
    fontSize: '11px',
    fontWeight: '600',
    lineHeight: '18px',
    verticalAlign: 'middle',
    whiteSpace: 'nowrap',
  });
  return badge;
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

  const { labels, reviews } = await fetchApprovable(repo);
  if (id !== approveRunId) return;

  for (const { number, row } of collectRows(repo)) {
    const key = `${repo}#${number}`;
    const title = row.querySelector('a[data-testid="listitem-title-link"], a.js-navigation-open');
    const anchor = row.querySelector('[class*="trailingBadgesContainer"]');
    const place = (el) => (anchor ? anchor.append(el) : title?.after(el));

    // Keep showing the result after approving, even once it's no longer approvable.
    const label = labels.get(number) || (approveState.has(key) && shownLabels.get(key));

    // The button already says where things stand ("Approved ✓" once clicked),
    // so the review badge only shows on rows without one.
    const review = label ? null : reviews.get(number);
    const status = row.querySelector(`[${STATUS_ATTR}]`);
    const statusKey = review?.state ?? null;
    if (status?.getAttribute(STATUS_ATTR) !== statusKey) {
      status?.remove();
      if (review) {
        const badge = createStatus(review);
        badge.setAttribute(STATUS_ATTR, statusKey);
        place(badge);
      }
    }

    const existing = row.querySelector(`[${APPROVE_ATTR}]`);
    if (!label) {
      // Approved since the button was added (e.g. in another tab, or on GitHub).
      existing?.remove();
      continue;
    }
    if (existing) continue;
    shownLabels.set(key, label);
    place(createButton(repo, number, label));
  }
}

// Highlight the author name on PRs opened by the logged-in user.
const MINE_ATTR = 'data-gmav-mine';

function viewerLogin() {
  return document.querySelector('meta[name="user-login"]')?.content || null;
}

function highlightMine() {
  const repo = pullsRepo();
  const login = viewerLogin()?.toLowerCase();
  const marked = new Set();

  if (repo && login) {
    for (const { row } of collectRows(repo)) {
      // The author link is the only one in the row whose text is a bare login.
      for (const a of row.querySelectorAll('a:not([data-testid="listitem-title-link"]):not(.js-navigation-open)')) {
        if (a.textContent.trim().toLowerCase() !== login) continue;
        a.setAttribute(MINE_ATTR, '');
        marked.add(a);
      }
    }
  }
  document.querySelectorAll(`[${MINE_ATTR}]`).forEach((a) => marked.has(a) || a.removeAttribute(MINE_ATTR));
}

// "Assign me" button in place of GitHub's "—" placeholder on PRs with no
// assignee. Goes through the GitHub CLI native host like approving does.
const ASSIGN_ATTR = 'data-gmav-assign';
const PLACEHOLDER_ATTR = 'data-gmav-placeholder';
const assignState = new Map(); // "owner/repo#123" -> 'pending' | 'done' | error string

const PERSON_ADD_ICON =
  '<svg viewBox="0 0 16 16" width="12" height="12" style="margin-left:1px" fill="currentColor" aria-hidden="true">' +
  '<path d="M7.9 8.548h-.001a5.528 5.528 0 0 1 3.1 4.659.75.75 0 1 1-1.498.086A4.01 4.01 0 0 0 5.5 9.5a4.01 4.01 0 0 0-4.001 3.793.75.75 0 1 1-1.498-.085 5.527 5.527 0 0 1 3.1-4.66 3.5 3.5 0 1 1 4.799 0ZM13.25 0a.75.75 0 0 1 .75.75V2h1.25a.75.75 0 0 1 0 1.5H14v1.25a.75.75 0 0 1-1.5 0V3.5h-1.25a.75.75 0 0 1 0-1.5h1.25V.75a.75.75 0 0 1 .75-.75ZM5.5 4a2 2 0 1 0-.001 3.999A2 2 0 0 0 5.5 4Z"/></svg>';

function renderAssignButton(btn, state) {
  btn.disabled = state === 'pending' || state === 'done';
  btn.dataset.state = state === 'pending' || state === 'done' ? state : state ? 'error' : 'idle';
  btn.title =
    state === 'done'
      ? 'Assigned to you'
      : state === 'pending'
        ? 'Assigning…'
        : state
          ? `Failed: ${state}`
          : 'Assign yourself';

  if (state === 'done') {
    const login = viewerLogin();
    btn.innerHTML = login
      ? `<img src="https://github.com/${encodeURIComponent(login)}.png?size=40" alt="" width="20" height="20">`
      : '✓';
  } else if (state === 'pending') {
    btn.innerHTML = '<span class="gmav-spinner"></span>';
  } else {
    btn.innerHTML = PERSON_ADD_ICON;
  }
}

function createAssignButton(repo, number) {
  const key = `${repo}#${number}`;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'gmav-assign';
  btn.setAttribute(ASSIGN_ATTR, key);
  renderAssignButton(btn, assignState.get(key));

  btn.addEventListener('click', async (e) => {
    // Rows are clickable; don't open the PR.
    e.preventDefault();
    e.stopPropagation();
    if (btn.disabled) return;

    assignState.set(key, 'pending');
    renderAssignButton(btn, 'pending');
    const res = await gh({ action: 'assign', repo, number }).catch((err) => ({ error: err.message }));
    const state = res?.ok ? 'done' : res?.error || 'No response from gh host';
    assignState.set(key, state);
    document.querySelectorAll(`[${ASSIGN_ATTR}="${key}"]`).forEach((b) => renderAssignButton(b, state));
    // Being assigned can make the PR approvable; refresh the buttons.
    if (state === 'done') {
      approvable = null;
      schedule();
    }
  });
  return btn;
}

function renderAssignButtons() {
  const repo = pullsRepo();
  if (!repo) return;

  for (const { number, row } of collectRows(repo)) {
    const cell = row.querySelector('[class*="metadataAssignees"]');
    if (!cell) continue;
    const key = `${repo}#${number}`;
    const placeholder = cell.querySelector('[class*="emptyPlaceholder"]');
    const existing = cell.querySelector(`[${ASSIGN_ATTR}]`);

    if (!placeholder) {
      // GitHub now shows real assignees (e.g. after a refresh).
      existing?.remove();
      continue;
    }
    if (existing) continue;
    // Hide rather than remove: React owns the placeholder.
    placeholder.setAttribute(PLACEHOLDER_ATTR, '');
    cell.append(createAssignButton(repo, number));
  }
}

// Make room for the badges and buttons: hide GitHub's review column, and let
// long titles truncate instead of pushing everything after them out of view.
const LAYOUT_ATTR = 'data-gmav-pulls';
const layoutStyle = document.createElement('style');
layoutStyle.textContent = `
  html[${LAYOUT_ATTR}] [class*="metadataReview"] { display: none !important; }
  html[${LAYOUT_ATTR}] li > [class*="container"]:has(> h3 + [class*="trailingBadgesContainer"]) {
    display: flex !important;
    align-items: center;
  }
  html[${LAYOUT_ATTR}] li > [class*="container"] > h3:has(+ [class*="trailingBadgesContainer"]) {
    flex-shrink: 1 !important;
    min-width: 0;
    text-overflow: ellipsis;
  }
  html[${LAYOUT_ATTR}] [class*="trailingBadgesContainer"] {
    flex-shrink: 0;
    overflow: visible !important;
  }
  [${MINE_ATTR}] {
    padding: 0 5px;
    border-radius: 2em;
    background: color-mix(in srgb, #d4b11a 30%, transparent);
    color: inherit !important;
    font-weight: 600;
  }
  [${PLACEHOLDER_ATTR}] { display: none !important; }
  .gmav-assign {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    width: 20px;
    height: 20px;
    padding: 0;
    border: 1px dashed var(--borderColor-default, #d0d7de);
    border-radius: 50%;
    background: transparent;
    color: var(--fgColor-muted, #656d76);
    line-height: 0;
    cursor: pointer;
    opacity: 0.75;
    transition: opacity 120ms, background-color 120ms, border-color 120ms, color 120ms;
  }
  li:hover .gmav-assign { opacity: 1; }
  .gmav-assign[data-state="idle"]:hover,
  .gmav-assign[data-state="idle"]:focus-visible {
    border-style: solid;
    border-color: #1f883d;
    background: #1f883d;
    color: #ffffff;
  }
  .gmav-assign[data-state="error"] {
    border-style: solid;
    border-color: #cf222e;
    color: #cf222e;
    opacity: 1;
  }
  .gmav-assign[data-state="pending"] { cursor: default; opacity: 1; }
  .gmav-assign[data-state="done"] {
    padding: 0;
    border: none;
    cursor: default;
    opacity: 1;
  }
  .gmav-assign img {
    border-radius: 50%;
    box-shadow: 0 0 0 2px #1f883d;
  }
  .gmav-spinner {
    width: 10px;
    height: 10px;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: gmav-spin 0.7s linear infinite;
  }
  @keyframes gmav-spin { to { transform: rotate(360deg); } }
`;
document.documentElement.append(layoutStyle);

function updateLayout() {
  document.documentElement.toggleAttribute(LAYOUT_ATTR, Boolean(pullsRepo()));
}

let timer = null;
function schedule() {
  // Throttle rather than debounce: GitHub mutates the DOM constantly
  // (relative timestamps, deferred status icons), which would starve a debounce.
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    updateLayout();
    highlightStacks();
    renderApproveButtons();
    renderAssignButtons();
    highlightMine();
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
