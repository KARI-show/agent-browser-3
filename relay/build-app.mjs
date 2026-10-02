// Assemble the relay's web app from the SAME sources as the VS Code panel, so the
// remote UI is 1:1: extract the webview <body> markup out of src/extension.ts and
// copy the built media bundle (main.js + style.css). The body is paired with the
// WS shim (hub-shim.js) instead of the VS Code script tag.
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pub = join(root, "relay", "public");
await mkdir(pub, { recursive: true });

const ext = await readFile(join(root, "src", "extension.ts"), "utf8");
// Tolerate attributes on the <body> tag (e.g. data-avatar="...").
const m = ext.match(/<body[^>]*>([\s\S]*?)<script nonce/);
if (!m) {
  console.error("✗ could not extract the webview <body> from src/extension.ts");
  process.exit(1);
}
// The panel builds the title from a TS template expr (assistantName). In the
// browser there's no VS Code config, so strip the raw ${...} to a static name —
// main.js swaps in the avatar image on top of it anyway when one is present.
const body = m[1].replace(
  /<span class="bar-title">[\s\S]*?<\/span>/,
  '<span class="bar-title">Kari</span>'
);

// In a real VS Code webview these --vscode-* variables come from the theme.
// In a plain browser they're undefined, so style.css falls back to light/unstyled.
// Provide a dark palette so the remote UI matches the panel.
const THEME = `:root{
  color-scheme: dark;
  --vscode-font-family: ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif;
  --vscode-font-size: 13px;
  --vscode-foreground:#cccccc;
  --vscode-descriptionForeground:#9d9d9d;
  --vscode-sideBar-background:#1b1b1f;
  --vscode-editor-background:#1e1e1e;
  --vscode-editorWidget-background:#252526;
  --vscode-panel-border: rgba(255,255,255,.12);
  --vscode-focusBorder:#4aa3ff;
  --vscode-textLink-foreground:#4aa3ff;
  --vscode-terminal-background:#0d1117;
  --vscode-terminal-foreground:#d4d4d4;
  --vscode-button-background:#0e639c;
  --vscode-button-foreground:#ffffff;
  --vscode-button-hoverBackground:#1177bb;
  --vscode-button-secondaryBackground:#3a3d41;
  --vscode-button-secondaryForeground:#ffffff;
  --vscode-input-background:#2a2a2e;
  --vscode-input-foreground:#e6edf3;
  --vscode-input-border: rgba(255,255,255,.14);
  --vscode-list-hoverBackground: rgba(255,255,255,.06);
  --vscode-toolbar-hoverBackground: rgba(255,255,255,.10);
  --vscode-tab-activeBackground: rgba(255,255,255,.10);
  --vscode-tab-inactiveForeground:#9d9d9d;
  --vscode-tab-activeForeground:#ffffff;
  --vscode-editor-font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
  --vscode-errorForeground:#f85149;
  --vscode-testing-iconPassed:#3fb950;
}
html,body{height:100%;}
body{margin:0;}`;

// Mobile layout fix (browser / Telegram Mini App ONLY — never the VS Code panel,
// since this lives in app.html, not the shared bundle). style.css pins body to
// 100vh, which on iOS ignores the on-screen keyboard and pushes the composer
// off-screen. Override AFTER style.css (later rule wins) and drive the real
// height from the VisualViewport API so the composer always sits above the
// keyboard. viewport-fit=cover + env(safe-area) keeps clear of the notch/home bar.
const MOBILE_FIX = `html{height:100%;overflow:hidden;}
body{position:fixed;top:0;left:0;right:0;height:100dvh;
  padding-bottom:env(safe-area-inset-bottom);}
#composer{padding-bottom:max(8px,env(safe-area-inset-bottom));}`;

// The page URL carries the relay token, and the relay token is remote control
// of an agent with a shell — so no inline script may run here: an HTML
// injection anywhere in the shared UI must not become script execution.
// (The keyboard/viewport fix lives in public/viewport.js for that reason.)
// Styles stay unrestricted: the UI sets inline styles, and CSS can't run code.
const CSP = [
  "script-src 'self' https://telegram.org",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "form-action 'none'",
].join("; ");

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${CSP}" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover" />
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
  <style>${THEME}</style>
  <link href="style.css" rel="stylesheet" />
  <style>${MOBILE_FIX}</style>
  <title>Agent IDE — Remote</title>
</head>
<body data-avatar="avatar.png">${body}<script src="hub-shim.js"></script>
<script src="main.js"></script>
<script src="viewport.js"></script>
</body>
</html>
`;

await writeFile(join(pub, "app.html"), html);
await copyFile(join(root, "media", "main.js"), join(pub, "main.js"));
await copyFile(join(root, "media", "style.css"), join(pub, "style.css"));
try {
  await copyFile(join(root, "media", "main.js.map"), join(pub, "main.js.map"));
} catch {
  /* map optional */
}
try {
  await copyFile(join(root, "media", "avatar.png"), join(pub, "avatar.png"));
} catch {
  /* avatar optional — web app falls back to the spark + name */
}
console.log("✓ built relay/public: app.html, main.js, style.css, avatar.png (+ shim)");
