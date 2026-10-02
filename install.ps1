#!/usr/bin/env pwsh
# Agent IDE — one-command installer (Windows / PowerShell)
# Usage:  ./install.ps1
$ErrorActionPreference = "Stop"
$repo = "KARI-show/agent-ide"
$tmp = Join-Path $env:TEMP "agent-ide-latest.vsix"

Write-Host "==> Downloading latest Agent IDE..." -ForegroundColor Cyan
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  throw "GitHub CLI (gh) not found. Install https://cli.github.com, run 'gh auth login', then re-run. (The repo is private, so a download needs auth.)"
}
gh release download --repo $repo --pattern "*.vsix" --output $tmp --clobber

# Find an editor CLI (VS Code or Cursor)
$cli = $null
foreach ($c in "code", "cursor") {
  $g = Get-Command $c -ErrorAction SilentlyContinue
  if ($g) { $cli = $g.Source; break }
}
if (-not $cli) {
  throw "VS Code or Cursor CLI not found in PATH. Open the editor and run 'Shell Command: Install 'code' command in PATH', then re-run."
}

Write-Host "==> Installing into $cli..." -ForegroundColor Cyan
& $cli --install-extension $tmp --force

Write-Host "`nDone. Reload the editor (Ctrl+R / 'Reload Window')." -ForegroundColor Green
Write-Host "If you haven't yet, log in to your Claude subscription: run 'claude login'." -ForegroundColor Yellow
