# My GitHub Harness

<img src="icon.svg" width="64" align="right" alt="Extension icon">

A personal Chrome extension of GitHub enhancements. Its main feature bulk-marks (or unmarks) GitHub PR files as **Viewed** using glob patterns — useful when a PR has many auto-generated or irrelevant files you want to dismiss at once.

## Features

- Match files by glob patterns (`*`, `**`, `?` supported)
- Leave patterns empty to target all files in the diff
- Works with GitHub's current and legacy PR diff UI
- Patterns are saved between sessions
- Optional visual features (toggle in the popup):
  - **Highlight stacked PRs** — on a repo's Pull requests list, PRs in the same stack (one PR targeting another's branch) get a shared color. With the [GitHub CLI host](#one-click-approval) installed, branches for all open PRs come from a single `gh pr list` call, so colors appear almost instantly and stay consistent across pages; without it, each PR page is fetched instead
- **APPROVE / REAPPROVE** — on a repo's Pull requests list, one-click approval for bot PRs and for PRs where your approval was dismissed (e.g. by a new push), using the GitHub CLI (see [One-click approval](#one-click-approval))
- After marking, reloads the diff with `?show-viewed-files=false&w=1` so viewed files are hidden and whitespace changes ignored

## Usage

1. Open a GitHub Pull Request and go to the **Files changed** tab
2. Click the extension icon in your toolbar
3. Enter one glob pattern per line, e.g.:

   ```
   *.ndjson
   **/*.generated.ts
   src/locales/**
   ```

4. Click **Mark as viewed** or **Unmark**

The status line will report how many matched files were toggled. After **Mark as viewed**, the page reloads with `show-viewed-files=false` and `w=1` appended so you land on just the files left to review, with whitespace-only changes hidden. Other query params and the URL hash are preserved; the reload is skipped if both params are already set.

### Keyboard shortcut

Press **Alt+Shift+R** (**⌥⇧R** on Mac) on a PR's Files changed tab to run **Mark as viewed** with your saved patterns — no need to open the popup. The toolbar badge briefly shows how many files were marked (or `!` on error). Rebind it at `chrome://extensions/shortcuts`.

### Pattern rules

| Pattern | Matches |
|---|---|
| `*.ndjson` | Any `.ndjson` file, at any depth |
| `**/*.test.ts` | Any `.test.ts` file, at any depth |
| `src/**` | Everything under `src/` |
| `src/*/index.ts` | `index.ts` one level inside `src/` |
| `!**/en.*.json` | Exclude files matching this pattern |
| _(empty)_ | All files in the diff |

Patterns without a `/` are matched against the **filename only**. Patterns containing a `/` are matched against the **full path**. Prefix a pattern with `!` to exclude matching files.

## One-click approval

On a repo's **Pull requests** list, some PRs get a green button next to their title:

- **REAPPROVE** — your latest review is an approval that was dismissed, typically after the author pushed new commits
- **APPROVE** — the PR was opened by a bot (e.g. Renovate, Dependabot) and you haven't approved it yet

Click it to approve that PR and add yourself as an assignee. The button turns into **Approved ✓**, or red with the error on hover if it failed. If the approval went through but assigning didn't, it still shows **Approved ✓** with the reason on hover. The list of approvable PRs is refreshed at most once a minute.

This goes through your local [GitHub CLI](https://cli.github.com/) (`gh pr review --approve`), using your existing `gh auth login` — no token is stored in the extension. Chrome reaches `gh` through a native messaging host, which needs a one-time install:

1. Make sure `gh` is installed and logged in (`gh auth status`)
2. Copy the extension's ID from `chrome://extensions`
3. Run `native/install.sh <extension-id>`

The ID of an unpacked extension is tied to its directory; if you move it, re-run the install script with the new ID.

## Installation

Load the extension:

1. Go to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** and select this directory
