#!/usr/bin/env bash
# Agent IDE — one-command installer (macOS / Linux)
# Usage:  ./install.sh
set -euo pipefail
repo="KARI-show/agent-ide"
tmp="$(mktemp -d)/agent-ide.vsix"

echo "==> Downloading latest Agent IDE..."
if ! command -v gh >/dev/null 2>&1; then
  echo "GitHub CLI (gh) not found. Install https://cli.github.com, run 'gh auth login', then re-run." >&2
  echo "(The repo is private, so a download needs auth.)" >&2
  exit 1
fi
gh release download --repo "$repo" --pattern "*.vsix" --output "$tmp" --clobber

cli=""
for c in code cursor; do
  if command -v "$c" >/dev/null 2>&1; then cli="$c"; break; fi
done
if [ -z "$cli" ]; then
  echo "VS Code or Cursor CLI not found in PATH. Install the 'code' command, then re-run." >&2
  exit 1
fi

echo "==> Installing into $cli..."
"$cli" --install-extension "$tmp" --force

echo ""
echo "Done. Reload the editor (Ctrl+R / 'Reload Window')."
echo "If you haven't yet, log in to your Claude subscription: run 'claude login'."
