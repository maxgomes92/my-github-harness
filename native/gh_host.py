#!/usr/bin/env python3
# Native messaging host: lets the extension run GitHub CLI (`gh`) commands
# with the user's existing `gh auth login` session. Chrome launches this once
# per message, passing a length-prefixed JSON request on stdin.
#
# Requests:
#   {"action": "approvable", "repo": "owner/repo"}               -> {"reapprove": [...], "approve": [...]}
#   {"action": "approve",    "repo": "owner/repo", "number": 123} -> {"ok": true, "warning"?: str}
#     (approves, then adds the user as an assignee)

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
    """Open PRs worth a one-click approval:
    reapprove: the user's latest review is an approval that got dismissed.
    approve:   authored by a bot and not yet approved by the user."""
    me = gh("api", "user", "-q", ".login").strip()
    prs = json.loads(
        gh("pr", "list", "-R", repo, "--state", "open", "--limit", "1000",
           "--json", "number,author,latestReviews")
    )
    reapprove, approve = [], []
    for pr in prs:
        mine = [r["state"] for r in pr["latestReviews"] if r["author"]["login"] == me]
        if "DISMISSED" in mine:
            reapprove.append(pr["number"])
        elif pr["author"].get("is_bot") and "APPROVED" not in mine:
            approve.append(pr["number"])
    return {"reapprove": reapprove, "approve": approve}


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
        elif msg.get("action") == "approve":
            warning = approve(msg["repo"], int(msg["number"]))
            send_message({"ok": True, "warning": warning} if warning else {"ok": True})
        else:
            send_message({"error": f"Unknown action: {msg.get('action')}"})
    except Exception as err:  # report everything back to the extension
        send_message({"error": str(err)})


if __name__ == "__main__":
    main()
