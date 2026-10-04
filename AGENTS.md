# Agent Guidelines

## Do NOT delete these files
The following files are part of the device profile feature and must NOT be removed:

- `browser/extension/fingerprint.js` — device config engine: device templates + `configFor(profile)`; loaded by the side panel and the service worker
- `browser/extension/fp-bridge.js` — ISOLATED→MAIN world config bridge (fallback content script, registered while a profile window is open)
- `browser/extension/inject-fingerprint.js` — MAIN world API overrides (installed through DevTools for profile windows; content-script fallback)

## Do NOT remove these permissions from manifest.json
- `downloads.open` — used by the file handling pipeline

## Style
- Commit messages in English, neutral tone
- No mention of "antidetect", "spoof", "fingerprint spoofing" in commits or descriptions
- Use "device config", "device profile", "browser identity" instead
