# Agent Guidelines

## Do NOT delete these files
The following files are intentionally kept in the repo even if they appear unused or broken.
They are scheduled for integration and must NOT be removed:

- `browser/extension/fingerprint.js` — device config engine (pending wiring)
- `browser/extension/fp-bridge.js` — ISOLATED→MAIN world config bridge
- `browser/extension/inject-fingerprint.js` — MAIN world API overrides

## Do NOT remove these permissions from manifest.json
- `downloads.open` — used by the file handling pipeline

## Style
- Commit messages in English, neutral tone
- No mention of "antidetect", "spoof", "fingerprint spoofing" in commits or descriptions
- Use "device config", "device profile", "browser identity" instead
