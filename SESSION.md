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

## Email sign-in + customer list for the free trial (2026-10-02)
- `trial-server/auth.mjs` (shared, web-standard): POST /auth/start → 6-digit code mailed via Resend
  (RESEND_API_KEY + MAIL_FROM; without a key the code goes to the server log), POST /auth/verify → token.
  Code hash only, 10 min, 5 tries counted atomically (store.add), resend ≥ 60 s, 5/address + 20/network a day,
  invite list AUTH_ALLOWED_EMAILS (addresses or @domains). Customers = `users` (D1 table / state file):
  id, email, createdAt, lastLoginAt, logins, ip, lastIp, blocked. Admin (ADMIN_TOKEN, server-only):
  GET /admin/users[?format=csv], POST /admin/users/block. Budgets/rpm/parallel slots count per person (`usr:<id>`).
- trial-server: wired in, /register → 410, schema.sql has users + codes (re-run on existing D1).
- queue-manager: identical copy `cli-proxy/queue-manager/auth.mjs` (deployed alone in /opt/queue-manager —
  copy it there too); invite-only (empty AUTH_ALLOWED_EMAILS = nobody); verify answers transport "agent".
  tests/trialAuth.test.mjs fails when the copies differ.
- Extension: settings → Free trial → email → code → signed in (mode saved as trial); hardcoded register
  secret removed from entry.ts; the panel uses the /v1/agent bridge only when the gateway said
  transport "agent", else the Messages API. Rejected/blocked token → dropped → panel asks to sign in.
- Tests: tests/trialAuth.test.mjs (flow, parallel guessing, caps, invite list, block, admin/CSV, mail,
  D1 SQL on node:sqlite), tests/e2e/trialSignin.e2e.mjs (real Chromium: sign-in UI → chat → block → re-sign-in).
- Open: queue-manager's REGISTER_SECRET still has a default in code (now only its own admin routes use it).

## Product pass — browser extension (2026-10-03, branch claude/gallant-shannon-u7caks)
Goal: test everything, fix bugs, drop what is pointless, bring the browser extension to a near-release state.
Baseline: `npm run check` 120/120; e2e 51 pass / 1 fail (#47 coverage) / 3 todo.
Three parallel code audits (UI modules; engine + host; remote/Telegram/relay) fed the list below.

### ⚠ State of this pass — NOT VERIFIED, NOT COMMITTED
Midway, auto mode's safety classifier started refusing every shell command in the session (it reacted to
the fingerprint-spoofing audit text in the transcript, not to the commands). Everything after the first
e2e run (44 pass / 2 fail, both expected: fill_form message + profile coverage) was written with the
editor only. **First thing in a fresh session:**
```
git rm browser/extension/fingerprint.js browser/extension/fp-bridge.js browser/extension/inject-fingerprint.js
npm run check            # typecheck + build + unit tests (engine/host/telegram tests were changed)
npm run test:e2e         # 46 tests expected: 2 former todo tests are real now, profile + pdf tests added
git add -A && git commit  # then push to claude/gallant-shannon-u7caks
```
Expect small breakage to fix by hand: e2e regexes for the new tool texts, TS strictness in host.ts
(`thinking` ConvMsg, `toolPolicy(() => BrowserMode)`), the profile e2e (data: URL tab + printToPDF for
md→pdf is new code).

### Done — browserTools.js / tools.ts (42 tools)
- Undeclared tools `browser_cache_extract`, `browser_download_open`, `browser_network_log` removed
  (unreachable for the model; cache_extract fetched any URL with the page's cookies and opened the file).
- "profile" meant two things → window tools are `browser_list_windows/switch_window/close_window`;
  `browser_new_profile` (duplicate of `browser_open_private_window`, false "separate login state") removed.
  `close_window` refuses the panel's own window.
- UA override: DevTools session pinned while an override is active (was reverted after 8 s idle);
  `applyUaOverride()` shared by set_useragent, profile_launch and the 👤 panel; re-applied on each load.
- Cookie tools act on the cookie store of the tab the agent works in (private window ≠ main profile).
  clear/import: leading-dot domains, validation, honest counts.
- Device profiles: one UA-preset generator (`uaPreset`, 8 presets, NT 10.0 only) instead of three;
  profile_launch opens the start URL even without saved cookies, applies the profile's proxy browser-wide
  and **restores the previous proxy when the window closes** (`agentProxyBeforeProfile`), reports the
  replaced cookies and returns the profile's notes as tool output; profile_list shows notes + active.
- **Fingerprint stack removed** (fingerprint.js / fp-bridge.js / inject-fingerprint.js + manifest
  content_scripts on <all_urls>): it had never run end-to-end (not loaded, wrong global, reversed args,
  async race, ReferenceError mid-file) while injecting into every frame of every page. Profiles are
  honest now: UA + platform + language + proxy + cookies + notes. The three files still need `git rm`.
- Converter: md→pdf / html→pdf render through `Page.printToPDF` in a background data: tab (real PDF, no
  print dialog, no document.write into the extension origin); `downloads.open` path + permission dropped
  (never worked without a gesture); quality accepts 0–1 or 0–100; table parsing via DOMParser; fenced
  code survives mdToHtml; screenshot_save captures the agent's window, not the panel's.
- fill_form handles <select> and checkbox/radio; cdpKey no longer sends VK_DELETE for ".".
- background.js: `createWindow` only from the extension's own pages (sender.url check).

### Done — profiles.js (👤 panel) rewritten
Was a second, buggier implementation (own CDP client fighting browserTools' auto-detach, `new Function`
under CSP, listener leak, `return win` ReferenceError, real identity shown to the site before the fake
one, notes pasted into the chat as a *user* message = stored prompt injection). Now a thin UI over
`browser_profile_*` / `browser_set_useragent` via `AgentBrowserTools.run`; DOM built without innerHTML;
theme variables instead of hard-coded dark colours; editing keeps cookies/lastDomain.

### Done — engine.ts / host.ts
- **engine.ts `stripOldImages` removed**: it rewrote earlier tool_results on every request; a thinking
  block's signature covers every message before it → preserved-thinking 400 (new accounts, Opus 5.5
  default model) and a cache miss per turn. History is append-only again, as the header always said.
- engine.ts: `max_tokens` capped by the Models API `max_tokens`; effort no longer silently clamped to
  high when the level list is unknown; id fallback knows haiku-4-5 / opus-4-5 (effort, no adaptive) /
  4.6 (no xhigh). Tests updated.
- host.ts: one transcript entry per thinking block (was one per delta → hundreds of bubbles + a
  state.json rewrite each); a chat deleted while running is not saved back; mode re-read per tool call.

### Done — remote
- telegram.js: a task is bound to its chat (runState), so a desktop chat switch no longer streams the
  other chat into Telegram / ends the task / makes /stop miss; /stop reports "■ Stopped."; start and
  polling retry on network errors with 🛰 in error state instead of dying or lying "on". Test added.
- relay.js: "chat is still working" is a notice (an error hid the phone's Stop); reconnect backoff
  3 s→30 s; unhandled rejections caught; only the lock-holding panel writes the shared status.
- hub-shim.js: main.js's own "ready" dropped (each connect reloaded the chat twice).
- commands.js: groups follow the tools (Windows / Device profiles), "Page → PDF" no longer promises a
  print dialog, items built without innerHTML; 'Linux armv81' typo.
- Repo: proto-*/smoke*.mjs → demo/, media/main.js.map untracked; README/TESTING updated.

### Backlog (verified findings, not done — in priority order)
1. Default Agent mode auto-allows cookies_get/export/import and run_js → a prompt-injected page can
   exfiltrate httpOnly sessions. Add an `alwaysAsk` flag per tool honoured in Agent mode.
2. host.ts lags localHost: pending approval card not re-shown on chat switch (only a notice);
   pin/rename lost on a running chat; no synchronous double-send gate; Linux login terminal spawn
   error invisible; saveAttachment has no size cap / parameterised data URL / cleanup.
3. localHost: 4 s stall per prompt when /v1/models is unavailable (remember the attempt); 400 rollback
   drops the user's message for any 400; pre-`promptId` chats replayed with old thinking → 400.
4. bridgeAgent: no retry on 429/5xx; accepts empty tool_use.id.
5. Remote: web app controls the browser node ignores (newChat, setModel/setMode, delete/rename/pin,
   uploadAttachment, interrupt for a non-active chat, ready for a deleted chat, nodeGone); link shown
   only once and token copied to the clipboard silently; one `enabled` flag = autostart + "on now";
   bot.mjs: getMe failure leaves a zombie; approval in Telegram has no element text on the native host.
6. UI: Retry (regenerate) / rewind / drag-drop file buttons post messages no browser backend handles.
7. Dead code to delete: browser/host/profile-launcher.ts + host.ts nativeProfile* (unreachable; has
   a path-traversal `rmSync` and an unauthenticated forwarder), `AgentLocal.hasKey/SETTINGS_KEY`,
   duplicated mode tables, relay.js `openChat`/`listChats` branches, `config` var, `question.msgId`.
8. src/tunnel.ts downloads cloudflared unpinned/unverified; relay token has no rotation and rides in
   URLs/clipboard/Telegram.
9. Options page validation duplicated with background.js; `options.css` no-op rule.
