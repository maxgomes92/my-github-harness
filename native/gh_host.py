#!/usr/bin/env python3
# Native messaging host: lets the extension run GitHub CLI (`gh`) commands
# with the user's existing `gh auth login` session. Chrome launches this once
# per message, passing a length-prefixed JSON request on stdin.
#
# Requests:
#   {"action": "approvable", "repo": "owner/repo"}               -> {"reapprove": [...], "approve": [...], "reviews": {...}}
#   {"action": "approve",    "repo": "owner/repo", "number": 123} -> {"ok": true, "warning"?: str}
#     (approves, then adds the user as an assignee)
#   {"action": "branches",   "repo": "owner/repo"}               -> {"prs": [{"number", "base", "head"}]}

import json
import os
import shutil
import struct
import subprocess
import sys

# Chrome launches hosts with a minimal PATH, so look where gh usually lives.
GH = shutil.which(
    "gh",
    path=os.pathsep.join(
        [os.environ.get("PATH", ""), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]
    ),
)


def read_message():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    (length,) = struct.unpack("@I", raw)
    return json.loads(sys.stdin.buffer.read(length))


def send_message(msg):
    data = json.dumps(msg).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("@I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def gh(*args):
    proc = subprocess.run([GH, *args], capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or f"gh {args[0]} failed")
    return proc.stdout


def approvable(repo):
    """Open PRs by others worth a one-click approval, plus the user's own
    review status (PRs authored by the user are skipped: you can't approve
    your own PR, and replying to comments on it counts as a review):
    reapprove: the user reviewed it, but commits were pushed since, or their
               approval got dismissed.
    approve:   not reviewed by the user yet, and authored by a bot or
               assigned to the user.
    reviews:   {number: {"state": ...}} for the remaining PRs the user has
               reviewed. state is their latest verdict (APPROVED,
               CHANGES_REQUESTED), or COMMENTED if they only commented."""
    me = gh("api", "user", "-q", ".login").strip()
    prs = json.loads(
        gh("pr", "list", "-R", repo, "--state", "open", "--limit", "1000",
           "--json", "number,author,assignees,headRefOid,reviews")
    )
    reapprove, approve, reviews = [], [], {}
    for pr in prs:
        if pr["author"]["login"] == me:
            continue
        mine = [
            r for r in pr["reviews"]
            if r["author"]["login"] == me and r["state"] != "PENDING"
        ]
        if not mine:
            if pr["author"].get("is_bot") or any(a["login"] == me for a in pr["assignees"]):
                approve.append(pr["number"])
            continue
        # Comment-only reviews don't undo an earlier verdict, so the verdict
        # is the latest non-comment review.
        verdicts = [r["state"] for r in mine if r["state"] != "COMMENTED"]
        verdict = verdicts[-1] if verdicts else "COMMENTED"
        stale = (mine[-1].get("commit") or {}).get("oid") != pr["headRefOid"]
        if stale or verdict == "DISMISSED":
            reapprove.append(pr["number"])
        else:
            reviews[pr["number"]] = {"state": verdict}
    return {"reapprove": reapprove, "approve": approve, "reviews": reviews}


def branches(repo):
    """Base/head branch of every open PR, for stack detection. Fork PRs get
    head None: their head branch lives in another repo, so no PR here can
    target it, even if the names match."""
    prs = json.loads(
        gh("pr", "list", "-R", repo, "--state", "open", "--limit", "1000",
           "--json", "number,baseRefName,headRefName,isCrossRepository")
    )
    return {
        "prs": [
            {
                "number": pr["number"],
                "base": pr["baseRefName"],
                "head": None if pr["isCrossRepository"] else pr["headRefName"],
            }
            for pr in prs
        ]
    }


def approve(repo, number):
    """Approve, then assign the user. Returns a warning if only assigning failed."""
    gh("pr", "review", str(number), "-R", repo, "--approve")
    try:
        gh("pr", "edit", str(number), "-R", repo, "--add-assignee", "@me")
    except RuntimeError as err:
        return f"Approved, but couldn't assign you: {err}"
    return None


def main():
    msg = read_message()
    if msg is None:
        return
    try:
        if not GH:
            raise RuntimeError("GitHub CLI (gh) not found")
        if msg.get("action") == "approvable":
            send_message(approvable(msg["repo"]))
        elif msg.get("action") == "branches":
            send_message(branches(msg["repo"]))
        elif msg.get("action") == "approve":
            warning = approve(msg["repo"], int(msg["number"]))
            send_message({"ok": True, "warning": warning} if warning else {"ok": True})
        else:
            send_message({"error": f"Unknown action: {msg.get('action')}"})
    except Exception as err:  # report everything back to the extension
        send_message({"error": str(err)})


if __name__ == "__main__":
    main()
