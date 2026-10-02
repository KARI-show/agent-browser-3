# SESSION — weak-points audit (2026-09-30)

## State (2026-10-01)
Tested and pushed to `claude/you-j7pvyh` (6 commits on top of 2c3f13f):
`npm run check` → 104/104; e2e (`npm run test:e2e`, Chromium) → 49 pass, 0 fail, 3 pre-existing todo.
Remote e2e (tests/e2e/remote.e2e.mjs) mutation-checked: breaking relay prompt routing, the bot's
owner check, the 🛰 CSS or the helper's shutdown each fails its test. No PR opened.

## Fixed
- relay/hub.mjs: `GET /%` crashed the relay (unhandled rejection) → 400; `public-*` sibling passed
  the traversal check; stale socket of a reconnected node deleted the live node's presence and
  could overwrite it; unauthenticated `role` logged raw; `RELAY_HOST` (extension binds loopback).
- relay/bot.mjs: unhandled rejection on odd updates killed the bot.
- src/hub.ts: IPv6 `[::1]` treated as remote; replaced socket scheduled a 2nd reconnect (two
  sockets per node); no backoff; endless retry on 4001.
- src/tunnel.ts: old cloudflared's exit wiped the live tunnel URL; URL-less process left on
  timeout; non-atomic binary download.
- src/extension.ts: bot kept a dead tunnel URL after the tunnel was regenerated.
- browser/extension/relay.js: remote mirror was dead (chatId always "current", chat list read a
  non-existent storage key) → routes by host's `conversations.activeId` / `convId`; `ready` opens
  the chat; prompts for a non-active chat rejected; approvals pass through; ws:// → wss://; stop on 4001.
- browser hosts: `loadConversation` carries `convId`.
- browser/host/tools.ts: `browser_cookies_get/export` were auto-allowed in every mode (httpOnly
  session exfiltration via prompt injection) → gated like actions.
- browserTools.js: UA override used `eval` (broken on strict-CSP pages).
- webview: `esc()` didn't escape quotes (attribute injection via file names / slash-command names);
  limit gauges' inline `style=` dropped by the panel CSP.
- relay web app: no CSP at all (token in URL) → script-src without inline; viewport.js split out.
- proxy: text-after-tool streamed into the tool block (index 0 hardcoded); any throw killed the proxy;
  `.vscodeignore` excluded `proxy/` so "Start Local Model" was broken in every vsix.
- superTools dev server: stop() killed only the shell (port stayed taken); stale exit line leaked
  into the new server's log.
- browser/host/memento.ts: corrupt state.json silently wiped all chats; files were world-readable.

## Remote for the browser extension, independent of VS Code (2026-10-01)
User picked: both — Telegram bot inside the extension (default, no install) AND the helper running
relay + tunnel + bot for the full Mini App. Also nothing run/committed yet.
- `browser/extension/relay.js` — remote coordinator: config `agentRemote {enabled, mode: bot|helper|relay,
  botToken, userId, relayUrl, relayToken, publicUrl}` (migrates old `agentRelay`), 🛰 button, Web Lock
  (one window runs remote), relay node (mirror with text/thinking merging, prompts straight to the host,
  approvals/Stop pass-through), status → `chrome.storage.session.agentRemoteStatus`.
- `browser/extension/telegram.js` — bot mode: long-polls Bot API from the panel, owner-only private chat,
  backlog skipped, reply streamed into one edited message, approvals/questions as buttons, /chats /new /stop.
- `browser/host/remote.ts` + host.ts `remoteStart` — helper runs relay/hub.mjs (free loopback port),
  cloudflared tunnel, relay/bot.mjs (BOT_APP_NAME/BOT_EMPTY_HINT env); stopped when the panel's port closes.
- `browser/build.mjs` ships relay/{hub,validate,bot}.mjs + relay/public into dist-browser/host/relay; host deps + ws.
- shim.js: `agent:outgoing` event; sidepanel.css: 🛰 visible again (body.remote hid it); options page: Remote section.
- `src/hub.ts` (VS Code): same text/thinking merging — relay drops >40 msg/s sockets. Kept; revert if unwanted.
- Tests: tests/telegramBot.test.mjs (vm + fake Bot API), tests/hubClient.test.ts. Manual: browser/TESTING.md §10.

## Open / not done (suggestions)
- Remote "newChat" from the web app isn't handled for the browser node (bot mode has /new).
- cli-proxy/queue-manager shares a personal Claude Max OAuth token with third-party installs —
  ToS/ban risk, left untouched.
- `media/main.js.map` is committed and changes on every build → untrack it (vsix excludes maps).
- `browser_network_log` (undeclared) is a stub; `cdpKey` sends wrong code/VK for digits/punctuation.

## Debug pass (2026-10-02, branch claude/keen-ride-w4vlsb)
Baseline on a fresh clone: `npm run check` 103/104; `build:browser` crashed; e2e couldn't build.
Now: `npm run check` → 109/109; e2e → 48 pass, 1 fail (#47 coverage), 3 pre-existing todo.
- browser/standalone/bridgeAgent.ts (free-trial /v1/agent path) had drifted from engine.ts:
  HTTP errors thrown as plain Error → a rejected trial token was never forgotten (the failing test),
  400/413 never rolled back; Ask mode blocked read-only tools too; undeclared tool names ran without
  approval; AskUserQuestion was sent to the page (question never shown); a stream that just ended was
  "✓ done"; Stop surfaced as an error; text after a tool landed in the tool-calling turn.
  → engine.ts `callTool()` is now the single tool policy for both loops; tests/bridgeAgent.test.ts.
- browserTools.js: browser_set_useragent regressed to `new Function` (CSP-blocked in the panel → the
  tool always failed) + a no-op registerContentScripts; profile_launch and set_useragent stored
  different shapes under `__agentUaListeners` and leaked onRemoved listeners → `watchTabLoads()`.
- `.gitignore` `*.png` also ignored media/icon.png + avatar.png → fresh clones can't build the browser
  extension or the vsix. Unignored `media/*.png`; avatar optional in browser/build.mjs.
  **The icons themselves still have to be committed from the owner's machine.**

### Open
- e2e #47: the 5 `browser_profile_*` tools (43 declared, test expects 38) have no e2e coverage.
- cli-proxy/queue-manager was not changed in this pass.
