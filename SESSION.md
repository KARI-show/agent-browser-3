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

### State
Pushed to `claude/gallant-shannon-u7caks` (7 commits on top of 4f83e4b). Verified after the push:
`npm run check` → 121/121; e2e (`npm run test:e2e`, Chromium) → 55/55, 0 todo (the two former
todo tests — UA override after idle, cookie tools in a private window — are real tests now;
device-profile and md/html→pdf coverage added). No PR opened.
Note: midway the session's shell was blocked by auto mode's classifier (it reacted to the
fingerprint-audit text, not to the commands); the work sat uncommitted in the container until the
user left auto mode. Nothing was lost.

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

## Superpowers pass (2026-10-04, branch claude/cool-cerf-76p498)
Goal: turn the browser extension into a tool people keep using (and pay for): zero-token repeats,
work while the user is away, data from the page's own API, memory per site. Store-ready.
Baseline: `npm run check` 121/121.

### Design
- **Recipes** (`browser/extension/automation.js`, shared by the panel and the service worker):
  every `AgentBrowserTools.run()` call is traced; ref-based actions carry a durable *locator*
  captured at snapshot time (stable id, data-testid, kind + accessible name, name/placeholder, href, frame).
  A recipe = recorded steps with locators; replay re-reads the page and scores the fresh elements
  against the stored locator (no model, no tokens). Typed values can become `{{params}}`; password
  fields are never stored (become `{{password}}`). A failed step hands the rest to the agent ("heal").
  Tools: browser_recipe_save/run/list/delete. UI: 🧩 panel → Recipes, "Save as recipe" strip after a run.
- **Watchers**: background.js imports converter/browserTools/automation; `chrome.alarms` runs a
  watcher in a background tab: extract (page text / CSS selector / table / recipe outputs), hash, diff,
  notify (chrome.notifications + Telegram sendMessage with the bot from `agentRemote`), event feed.
  Tools: browser_watch_create/list/delete (+ run now). UI: 🧩 panel → Watchers.
- **Network tap**: browser_network_capture start/stop/read via CDP Network.* on the agent's tab
  (JSON/XHR/fetch bodies, ring buffer). Gated like cookies.
- **Site memory**: browser_memory_save/list/delete, `agentSiteMemory` per host; browser_read_page
  appends the host's notes (data, not instructions).
- browserTools.js is runnable in the service worker (globalThis, no window.*), so watchers work with
  the panel closed.

### State
Done in this pass (all on claude/cool-cerf-76p498):
- browser/extension/browserTools.js: every `run()` call traced (name, stored-safe args, element locator captured at
  snapshot time, outcome, url); `AgentBrowserTools.{trace,clearTrace,onStep,setTurn,refs,setCurrentTab,run(…,replay)}`;
  runs in the service worker too (globalThis, no window.*; profile_launch creates the window itself there);
  `browser_read_page` appends the site's memory block; `browser_network_capture` (CDP Network.*, ring buffer, lazy bodies).
- browser/extension/automation.js (new, shared): locator scoring (id 100 · data-testid 90 · exact text 50 · name 40 ·
  href 45 · placeholder 30 · kind 15 · frame mismatch −25; min 45; ties → same ordinal), buildRecipe (drops observe
  tools + failed steps, start URL from the first navigation, {{params}}, passwords → {{password}} secret param),
  runRecipe (fresh snapshot per locator step, one retry after 1.5 s, outputs of extraction steps collected, honest
  failure report with the unrun steps), watchers (alarms, background tab in the focused normal window or a minimized
  own window, text/selector/table/recipe extraction, FNV hash, set diff, notifications + Telegram sendMessage,
  event feed ≤100, 3 errors in a row reported once), site memory (host → parent domain → `*`, 20 notes/host).
- browser/extension/automations.js (new): 🧩 panel — Recipes (save dialog with parameter candidates, editor, run
  with progress, "Fix with the agent", "Discuss in chat"), Watchers (editor, check now, pause, feed, "Explain"),
  Memory; "Save as recipe" strip after a run; unseen-changes dot; turn tagging of the trace (convId/turn).
- background.js importScripts converter/browserTools/automation; onAlarm → runWatcherById; runWatcher message;
  notification click opens the page; syncAlarms on install/startup. converter.js: data: URL fallback (no
  createObjectURL in a worker), globalThis export. manifest: alarms + notifications, downloads.open dropped
  (unused since the product pass; an unused permission is a store-review flag), v0.2.0.
- browser/host/tools.ts: 11 new tools (53 total) + system prompt sections. commands.js: 3 new quick commands.
- cli-proxy/queue-manager: disallowedTools as the first-class SDK option (extraArgs worked by Array#toString luck).
- Tests: tests/automation.test.mjs (10, vm + fakes, incl. the worker pipeline), e2e: network tap, recipes (replay on
  a page with shifted refs, honest failure, re-record), the 🧩 panel, watchers through the real service worker, memory.
- fingerprint.js / fp-bridge.js / inject-fingerprint.js — RESTORED (see AGENTS.md: do NOT delete).

### Device config stack — done (2026-10-04, see "Device config pass" below)
The three files are wired and tested; the TODO that stood here is resolved there.

### Open
- Recipes replay in the panel's tab; a recipe that opens new tabs mid-way follows them (browser_click does) but a
  `browser_switch_tab` step is dropped (ids are not stable) — such flows need re-recording as one tab.
- Watcher notifications in headless Chromium are a no-op; verified by hand only on a desktop.
- No "summarize the change with the model" in the worker (would need the engine there); the panel's 💬 Explain does it.
- Store listing itself (screenshots, privacy policy text, the key/ID) is the owner's; the manifest and permissions
  are ready: every permission is used (alarms/notifications by watchers).

## Device config pass (2026-10-04, branch claude/admiring-newton-2qhpnu)
Goal: the TODO above — make the device config stack (fingerprint.js / fp-bridge.js / inject-fingerprint.js)
actually run for device profiles, without deleting anything. Baseline: `npm run check` 131/131.

### What was wrong
- Nothing loaded fingerprint.js (window.* export, no <script>/importScripts); the manifest content_scripts had
  been removed; profiles never stored a device config; `agentActiveFingerprint` was written by no one.
- fp-bridge.js awaited chrome.storage before writing the DOM element, inject-fingerprint.js read it
  synchronously → always empty. A content script can't read storage synchronously at all, so "bridge first"
  is not achievable that way: the MAIN-world side must wait, and by then a page script may have run.
- inject-fingerprint.js: `rng` undefined (ReferenceError mid-file, half-applied state), canvas noise written
  back into the real canvas on every read (double noise, unstable hashes, drawings corrupted), wrong GL
  constants (MAX_VERTEX_UNIFORM_VECTORS / MAX_VERTEX_TEXTURE_IMAGE_UNITS / ALIASED_POINT_SIZE_RANGE),
  anisotropy never mapped, client-hint platform hard-coded to Windows/macOS, `getHighEntropyValues` ignored
  the hints asked for.

### Design
- **fingerprint.js** — `globalThis.FingerprintEngine`: the 6 device templates (unchanged), `configFor(profile, pid)`
  = template hardware + the profile's own UA/platform/language, brands/fullVersionList derived from the UA in
  use (`brandsFromUa`, Edge aware; non-Chromium UA → no client hints), noise seeded by the profile id;
  `templateFor(pid, idOrUa)`, `describe()`, `uaMetadata()` (DevTools client hints). Loaded by sidepanel.html
  and background.js.
- **Delivery, primary — DevTools** (browserTools.js `setIdentity` / `applyIdentity`, shared with
  browser_set_useragent): on the pinned session of a profile tab `Network.setUserAgentOverride` (+ userAgentMetadata
  → Sec-CH-UA headers and navigator.userAgentData natively), `Page.addScriptToEvaluateOnNewDocument(runImmediately)`
  with inject-fingerprint.js and the config embedded in place of its `EMBEDDED` marker — before any page script —
  `Emulation.setTimezoneOverride`, `Emulation.setHardwareConcurrencyOverride`; `Target.setAutoAttach(flatten)` so
  cross-origin frames (own targets) get the same on `Target.attachedToTarget`. A dismissed debugging bar → the next
  load re-applies everything (cdp() re-attaches on "not attached"). The window is the profile's scope:
  `chrome.tabs.onCreated` in it → same identity; `chrome.windows.onRemoved` → endProfile (proxy back, config
  forgotten) — closing the first tab no longer ends the profile.
- **Delivery, fallback — content scripts** (fp-bridge.js + inject-fingerprint.js) registered with
  `chrome.scripting.registerContentScripts` (MAIN world for the page side, all_frames, persistAcrossSessions:false)
  only while a profile window is open; the bridge asks the service worker (`deviceConfig` message) for the config of
  its window (`chrome.storage.session agentDeviceWindow:<id>`, written at launch), writes the `<script type=json>` element
  and fires an event; the page side applies it only if `document.scripts` is still empty — never two identities in one
  document. background.js also drops the window entry / unregisters the scripts on windows.onRemoved (panel closed).
  No static manifest content_scripts: nothing runs in the user's own tabs.
- **inject-fingerprint.js** rewritten around `applyDeviceConfig(FP)`: idempotent (an own `hardwareConcurrency` on
  navigator marks a done document), canvas noise into a copy (same bytes on every read, canvas untouched),
  AudioBuffer.getChannelData noise once per buffer, correct GL constants, userAgentData platform from the UA's OS,
  getHighEntropyValues answers the hints asked, time zone / layout noise / plugins / battery / gamepads / WebRTC kept.
- Tools: browser_profile_create `device` (template id | none | auto: a template of the UA's OS for desktop Chrome/Edge,
  none for Firefox/Safari/phones/Linux; with `device` and no preset the template's own UA); create/launch report
  "Device: …"; browser_profile_list shows each profile's template and lists the templates. browser_set_useragent on a
  profile tab keeps the template and re-derives the hints. 👤 panel: Device template select (follows the preset's OS,
  fills UA/platform from the template), "Device:" in the list. Tool count unchanged (53).

### Tests
- tests/deviceConfig.test.mjs (9): configFor / brands / templates / describe; inject in a vm page (navigator, hints,
  screen, WebGL, time zone, plugins, layout noise, WebRTC, native toString), canvas noise stable + canvas untouched,
  idempotence, no-config no-op; bridge → page handshake, null reply, "page script already ran" guard.
- e2e (real Chromium): profile with a template → server sees UA + `Sec-CH-UA-Platform: "Windows"`; the page (oracle
  session) sees one coherent device incl. GPU string and canvas noise; the cross-origin iframe target too; a tab opened
  by target=_blank from the profile page carries it; fallback scripts registered while the window is open and gone
  after; the user's own tab unchanged; set_useragent inside the window keeps the template, hints follow the new UA.
- Result: `npm run check` → 140/140 (131 + 9); e2e `tests/e2e/browserTools.e2e.mjs` → 54/54 (53 + 1), Chromium 141.
- Two things the e2e caught on the way: `Page.addScriptToEvaluateOnNewDocument` only fires for later documents
  while the Page domain is enabled (`Page.enable` — without it only the fallback ran, which masked the gap); and a
  frame auto-attached without `waitForDebuggerOnStart` had run its first script before the config arrived — frames
  now start paused and are resumed once the identity is in place (every extension context resumes a paused frame
  after 1.5 s as a safety net, so a vanished panel can't leave one hanging).

### Open
- The fallback (content-script) path is covered by the unit test and by the registration check in e2e, not by a
  page that reached it: with the DevTools route working, nothing in headless Chromium misses it.
- Workers/OffscreenCanvas keep the real values except what the Emulation overrides cover (threads, time zone).
- Only desktop Windows/macOS Chrome templates exist; adding one = a DEVICES entry (fingerprint.js).

## Release pass (2026-10-04, branch claude/admiring-newton-2qhpnu)
Goal: the verified backlog of the product pass closed, the extension packaged and ready for a short manual pass
(browser/README.md "Release checklist", browser/TESTING.md). Baseline: `npm run check` 140/140, e2e 54/54 + 7/7.
Work split: shared pieces and docs here; three parallel passes on disjoint files (native host; built-in engine;
remote / panel UI / options), each rebased onto this branch and merged.

### Done — shared
- **Backlog 1 (security)**: `alwaysAsk` on browser_cookies_get / export / import, browser_run_js, browser_network_capture
  (tools.ts → gen-tooldefs → engine `callTool`, host `toolPolicy`): an approval card in Agent mode too, denial in Ask.
  System prompt names the rule. Tests: tools set (browserHost.test.ts), engine behaviour (standalone.test.ts).
- Recipes replay a recorded `browser_switch_tab` by the tab's address (exact, else same origin + path; honest failure).
- manifest 0.3.0; `npm run package:browser` → dist-browser/agent-browser.zip (37 files); release checklist in browser/README.md.
  Note: `package:browser` leaves media/main.js minified — `npm run build` before committing (it bit once in this pass).
__AGENT_SECTIONS__

### Open
- src/tunnel.ts still downloads cloudflared "latest" unverified (backlog 8): pinning needs a release tag + checksums,
  which this environment could not fetch (GitHub answers 403 through the proxy). Owner's call; also the relay token
  rotation there.
- Store listing itself (screenshots, privacy text, id) — owner's; see the checklist.
