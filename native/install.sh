#!/usr/bin/env bash
# Registers gh_host.py as a Chrome native messaging host so the extension can
# run GitHub CLI commands. Usage: native/install.sh <extension-id>
# (find the ID on chrome://extensions with Developer mode on).
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Usage: $0 <extension-id>" >&2
  exit 1
fi

EXTENSION_ID="$1"
HOST_NAME="com.my_github_harness.gh"
HOST_PATH="$(cd "$(dirname "$0")" && pwd)/gh_host.py"

case "$(uname -s)" in
  Darwin) TARGET_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts" ;;
  Linux) TARGET_DIR="$HOME/.config/google-chrome/NativeMessagingHosts" ;;
  *) echo "Unsupported OS" >&2; exit 1 ;;
esac

chmod +x "$HOST_PATH"
mkdir -p "$TARGET_DIR"
cat > "$TARGET_DIR/$HOST_NAME.json" <<EOF
{
  "name": "$HOST_NAME",
  "description": "My GitHub Harness - GitHub CLI bridge",
  "path": "$HOST_PATH",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXTENSION_ID/"]
}
EOF

echo "Installed $TARGET_DIR/$HOST_NAME.json"
