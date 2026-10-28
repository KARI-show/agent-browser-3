# Agent Browser

The Agent IDE agent as a Chrome / Edge / Brave extension: a side panel that
works in your real, logged-in browser — reads pages, clicks, types, picks
options, scrolls, switches tabs and takes screenshots. It runs on your Claude
**subscription** (or `ANTHROPIC_API_KEY`), exactly like the VS Code panel.

## Three ways to run the agent

Pick in the extension's settings (the 🌐 button in the panel):

| | How | Needs |
| --- | --- | --- |
| **Free trial** | requests go through your gateway ([`trial-server/`](../trial-server/README.md), which holds *your* API key and enforces the limits) | an email address — they sign in with a one-time code from it, and become a row in your customer list; build with `AGENT_TRIAL_URL=https://your-gateway node browser/build.mjs` |
| **My API key** | the extension calls the Claude API itself with the official SDK | an Anthropic API key (and a Workspace ID if the key isn't tied to a workspace) |
| **My Claude subscription** | the local helper runs the user's own signed-in Claude Code | the installer; the sign-in happens in Anthropic's own flow — this project never sees or stores a Claude login |

Without `AGENT_TRIAL_URL` the trial option is greyed out ("not available in this build").
With no choice made, the panel defaults to the free trial if the build has one, else to the
user's API key if one is saved, else to the local helper.

Built-in modes (trial, API key) keep the chat **append-only** — models that carry their
reasoning across turns reject edited history — so screenshots are shrunk when taken rather
than pruned later, and `/compact` replaces the whole history with a summary.
Model output is treated as untrusted: the panel filters the HTML it renders (no remote
images, frames or script links), the extension's CSP blocks remote images and frames, and
approval cards (Careful mode) name the element they would click.

## How it fits together

```
side panel (extension)                         native host (Node)
┌──────────────────────────────┐   native     ┌───────────────────────────────┐
│ media/main.js  — shared UI   │  messaging   │ host.ts  — chats, modes, auth │
│ shim.js  — acquireVsCodeApi  │◀────────────▶│ src/agent.ts — Agent SDK run  │
│ browserTools.js — tab actions│    stdio     │ tools.ts — browser MCP tools  │
└──────────────────────────────┘              └───────────────────────────────┘
```

- **UI** — the unmodified webview bundle; `shim.js` swaps the VS Code API for a
  native-messaging port (the same trick `relay/public/hub-shim.js` uses over
  WebSocket). Editor-only controls are hidden by `sidepanel.css`.
- **Host** — Chrome starts it when the panel opens and stops it when the panel
  closes. It reuses `src/agent.ts`, `src/conversations.ts` and `src/auth.ts`;
  chats persist in `~/.agent-browser/state.json`, logs in `~/.agent-browser/host.log`.
- **Tools** — declared in `host/tools.ts` as an in-process MCP server; each call
  is sent to the panel, which runs it on the current tab with
  `chrome.scripting` / `chrome.tabs` (`extension/browserTools.js`).
- **Automation** — `extension/automation.js`: recipes (the traced tool calls with a
  durable locator per element, replayed without the model), watchers (checked on
  `chrome.alarms` by the service worker with the panel closed; changes go to a
  notification and Telegram) and site memory (notes `browser_read_page` shows on
  that site). `extension/automations.js` is the 🧩 panel over them. The tool
  runtime has no DOM dependency, so `background.js` imports it for the watchers.

The agent gets **no shell and no file access** (built-in tools are limited to
WebSearch/WebFetch/TodoWrite/AskUserQuestion, and Read only for attached files),
so a prompt-injected page can't reach your machine. The system prompt treats page
content as untrusted and makes the agent ask before payments, sending messages,
deleting data or changing account settings.

## Reliability

`read_page` covers every frame (cross-origin iframes too) and open shadow roots,
lists a modal dialog's controls first, and also surfaces "buttons" built from
plain elements (`cursor: pointer`), draggable items and hidden file inputs. Refs
are frame-aware: an action lands in the frame that produced the ref, and a ref
whose document is gone is reported as stale instead of hitting something else.

Actions check before and after: a click on an element covered by something else
(cookie banner, modal) fails with the blocker's name; a click that changed
nothing is retried once with a real mouse event through the DevTools protocol
(Chrome then shows its usual "started debugging this browser" bar); typing is
read back and, for editors that ignore programmatic input, redone with real key
input. Extra tools: `wait_for`, `find`, `hover`, `drag`, `upload_file`.

Chat state is the same with either backend: a running chat can be switched away
from and back to (Stop and any pending approval or question card come back),
renamed or pinned mid-run, a second message while it runs is refused rather than
started on the same history, deleting a running chat keeps it deleted, and Stop
closes an open approval card. Attachments are capped at what the model takes
(images 3.5 MB, PDFs 10 MB, other files 20 MB — a notice says so); with the local
helper they are stored in `~/.agent-browser/attachments` and pruned after 7 days.
Retry and ↩ (rewind) work with the built-in agent only — the helper's session
can't be truncated, so the panel hides them there. Retry runs the last message
again; rewind asks first, drops the chat from that message on and puts its text
back into the composer; neither works while the chat runs or across a compaction.
A message the API itself refuses (an oversized image, a block it won't take) is
taken out of the chat and handed back to the composer; other API errors leave the
chat as it is. On the free trial, transient gateway errors are retried up to
three times with a visible "⟳ … retrying" line (Stop cancels the wait), and a
gateway without a model list is probed once per five minutes, not per message.

## Proxy (per browser profile)

The 🌐 button in the panel opens the proxy settings. It uses `chrome.proxy`, so
it applies to the **whole browser profile** the extension is installed in —
install Agent Browser in a dedicated Chrome/Edge profile to give the agent its
own exit address without touching your main browsing.

| Type | Handled by |
| --- | --- |
| HTTP / HTTPS, with or without login | the browser (credentials supplied by the extension) |
| SOCKS5 without login | the browser |
| SOCKS5 **with** username/password | a loopback forwarder in the native host (Chrome can't do SOCKS5 login) |

- Hostnames go to the proxy unresolved, so DNS is done on the proxy's side.
- While a proxy is on, WebRTC is restricted (`disable_non_proxied_udp`) so it
  can't reveal your real IP; optionally third-party cookies are blocked. Both
  are handed back when the proxy is turned off.
- If the proxy can't be set up (bad login, host not installed), the setting is
  cleared and the badge turns red — it never silently browses direct while the
  panel says "on". If the host dies while the forwarder is in use, browsing
  fails until it is restarted.
- **Test connection** runs in the host and shows the address sites will see next
  to your direct one.
- The password is stored in the extension's local storage in that browser
  profile. Chrome caches proxy logins for the browser session, so after
  changing a password restart the browser if the old one keeps being used.

This changes where traffic exits from; it does not alter what the browser
reports about itself.

### Saved proxies (named presets)

The proxy settings page can hold several named configurations ("Home",
"Client A", …), stored in `chrome.storage.local` alongside the active one.
Fill in the fields, name it and **Save as new proxy**; pick it from the list
and **Load** to bring it back into the fields, then **Save** to make it the
one actually applied. This is a convenience list only — switching which one
is active still requires the normal Save, so nothing changes traffic until
you do that.

### Private sessions

The agent has a `browser_open_private_window` tool: it opens a new
Incognito window (no cookies, storage or history shared with your other
tabs) and works there. It needs Chrome's **"Allow in Incognito"** switch on
for this extension (`chrome://extensions` → Agent Browser → Details) — the
settings page shows whether that's on, and the tool fails with that
instruction if it isn't. This is an ordinary Incognito window, not an
identity change: sites still see the same browser and exit address (a device
profile below changes what the browser presents; a proxy above changes the
exit address).

### Device profiles

A device profile (👤 panel, `browser_profile_*` tools) is a saved identity —
User-Agent, platform, language — plus a **device template**, a proxy, a cookie
jar and notes for the agent. The template (`extension/fingerprint.js`) is one
real machine's values: screen, CPU threads, memory, GPU, audio, media devices,
battery, plugins, time zone. Launching the profile opens a window in which
every page presents that machine: the panel installs the config into the
tab's DevTools session (`Network.setUserAgentOverride` with client hints,
`Page.addScriptToEvaluateOnNewDocument` with `extension/inject-fingerprint.js`
before any page script, `Emulation` time zone / CPU threads; cross-origin
frames through `Target.setAutoAttach`; tabs opened from the window too). While
a profile window is open, `extension/fp-bridge.js` + `inject-fingerprint.js`
are also registered as content scripts (`chrome.scripting`) as a fallback for
a frame the DevTools route missed: the bridge asks the service worker for the
window's config (`chrome.storage.session` `agentDeviceWindow:<id>`), and the page
side applies it only if no page script has run yet. Closing the window
restores the proxy, forgets the config and unregisters the scripts.

| Mode | Browser actions |
| --- | --- |
| Agent | run without asking (the agent still confirms risky steps in chat) |
| Careful | every click / type / navigation needs **Allow** |
| Ask | read-only — read page, screenshot, list tabs |

In every mode, Agent included, five tools ask first because they reach session
data a prompt-injected page could make the model leak or plant: reading and
exporting cookies, importing cookies, running JavaScript in the page, and the
network tap (API response bodies). The approval card names the tool and what it
would act on; the system prompt tells the model to prefer the ordinary page
tools and to say why it needs one of these.

## Remote (phone & Telegram)

Work with the browser agent from a phone — independent of VS Code. Set it up
in the settings (🌐 → *Remote*), then press 🛰 in the panel (again to stop).
It works while the side panel is open: the agent lives there. If several
browser windows have the panel open, one of them runs remote (a Web Lock
decides) and another takes over when it closes.

| Mode | Needs | On the phone |
| --- | --- | --- |
| **Telegram chat** | a bot from @BotFather + your user id | chat with the bot: tasks in, replies out (streamed into one message), approvals and questions as buttons, `/chats` `/new` `/stop` |
| **Telegram + web app** | the local helper (same installer as *My Claude subscription*) | the full chat UI — Telegram Mini App or any browser |
| **My own relay** | a relay you run (`relay/hub.mjs`) | its bot and web app list the browser as **Agent Browser** |

- **Telegram chat** (`extension/telegram.js`): the panel long-polls the Bot
  API itself — no relay, tunnel or helper. Only the configured user id in a
  private chat is served; messages that piled up while the panel was closed
  are skipped, not run. Telegram lets one program read a bot, so use a bot of
  its own, not the one VS Code's Remote runs.
- **Telegram + web app** (`host/remote.ts`): the helper starts the relay on a
  free loopback port, a cloudflared quick tunnel for a public `https://`
  address and — if a bot is set — `relay/bot.mjs` with the Mini App button.
  The panel joins that relay as a node and posts the link to the open chat.
  Closing the panel stops all three.
- In the relay modes a remote prompt goes to the chat the panel shows (a
  phone on another chat is told to reopen it); opening a chat on the phone
  switches the panel to it; Stop and Allow/Deny work from the phone. Streamed
  text is merged into ≤10 relay messages a second, under the relay's
  per-socket rate limit.
- What else the phone / web app can do: start a new chat ("+" — its stream is
  sent to that phone until it opens another chat), change model and mode,
  compact, Retry and ↩ (built-in agent) for the chat it has open; delete,
  rename and pin any chat; attach files (uploaded bytes, the chip comes back
  to the uploader); Stop a chat that is not the one on screen — the panel
  switches to it first. A chat that no longer exists answers with an error
  instead of silence.
- On/off: the 🛰 button is "on now" for this browser session (kept in
  `chrome.storage.session`, gone after a restart). *Start remote automatically
  when the panel opens* is a separate setting on the options page. The link
  the panel shows carries the relay token; it is no longer copied to the
  clipboard on its own — copy it from the panel or from the Remote section of
  the settings page (**Copy link**). If the helper's Telegram bot fails to
  start (bad token, no network), the panel says so while the relay and tunnel
  keep working.
- Files dropped onto the panel are attached like files picked with 📎.

## Build

```bash
npm run build                # webview bundle (media/main.js) first
npm run build:browser        # → dist-browser/{extension,host}
npm run package:browser      # production build + dist-browser/agent-browser.zip
```

For the free trial add `AGENT_TRIAL_URL=https://your-gateway` to the build command. Release: upload `agent-browser.zip` to the
[agent-ide-setup](https://github.com/KARI-show/agent-ide-setup) release — its
`install-browser.ps1` downloads it from there.

`package:browser` leaves `media/main.js` minified; run `npm run build` again before
committing anything, or the development bundle in git gets replaced.

### Release checklist

What is automated: `npm run check` (typecheck, build, unit tests) and
`npm run test:e2e` (every tool against a real Chromium, the remote node, the
free-trial sign-in). Before a release:

1. `npm run check && npm run test:e2e` green.
2. Bump `version` in `browser/extension/manifest.json`.
3. `npm run package:browser` (with `AGENT_TRIAL_URL` if the build has a trial)
   → `dist-browser/agent-browser.zip`; load `dist-browser/extension` unpacked once
   and walk `TESTING.md` — the sections marked "by hand" (model behaviour, 👤 / 🧩
   panels, Remote with a real phone and Telegram, device templates on a live site).
4. Store listing (the owner's): screenshots, the privacy policy text (what leaves
   the browser: requests to the chosen API endpoint or gateway, Telegram when
   configured, nothing else), the description, and the extension id. The
   `key` in the manifest keeps the id stable for unpacked installs; the Web Store
   assigns its own id to the uploaded package, so the first store upload must
   be the one the id is then taken from.
5. Every permission in the manifest is in use (watchers: alarms + notifications;
   profiles: proxy, cookies, debugger, scripting; converter: downloads) — a
   reviewer asks about each one.

## Brands (white-label builds)

The same extension can ship as several products that differ in name, logo,
design and what they can do, while the core — tools, host, protocol — stays one
code base. A brand is a JSON file in `browser/brands/`:

```json
{
  "id": "orbit",
  "name": "Orbit — AI Copilot for the Web",     // store listing / manifest name (≤ 75 chars)
  "shortName": "Orbit",                          // the assistant's name in the panel, Telegram, notifications
  "tagline": "AI Copilot for the Web",           // settings page header
  "subtitle": "…",                               // settings page, one line
  "description": "…",                            // manifest description (≤ 132 chars)
  "mascot": "🪐",                                // the Telegram greeting's emoji
  "icon": "media/brands/orbit-icon.png",         // 128×128 PNG
  "avatar": "media/brands/orbit-avatar.png",     // 256×256 PNG, the chat avatar
  "colors": { "accent": "#…", "accentLight": "#…", "spark": "#…", "action": "#…", "ink": "#…", "radius": "12px" },
  "skin": "glass",                               // browser/skins/<skin>.css — the design (default: "default", Tali's look)
  "features": { "profiles": false, "proxy": false }   // what this product leaves out (everything else is on)
}
```

`browser/brands/tali.json` is the published brand and the default. What the build
does with a brand:

- **Texts** — fills the `{{brand.*}}` tokens in `manifest.json`, `sidepanel.html`,
  `options.html` and `theme.css`; writes `brand.js` (`globalThis.AGENT_BRAND`) for
  the strings shown at run time: the relay node name, watcher notifications, the
  Telegram greeting, the assistant's name (whichever backend posts the identity).
- **Design** — copies `browser/skins/<skin>.css` to `skin.css`, linked after every
  other stylesheet on both pages (`body.browser` for the panel, `body.options` for
  the settings page). A skin can restyle the whole chat; it reads the brand's
  colours through `--brand-accent` and friends and never sets them, so one skin
  serves any brand. The default look maps the accent to focus rings and links and
  switches to `accentLight` under a light OS theme; a skin may pin a scheme or use
  its own ink for focus. Shipped: `default` (Tali's look), `glass` (dark, frosted
  translucent panels, gradient header, pill composer), `paper` (light, serif
  reading, ruled lists instead of cards, monochrome buttons), `mono` (terminal:
  monospace, sharp corners, prompt-style messages, the accent as phosphor on
  near-black), `slate` (compact professional, follows the OS scheme, accent bars
  instead of fills), `studio` (light creative studio: warm paper, 14px radii, the
  accent on chips, tabs, rings and Send, a tri-colour stripe and paint wash,
  tinted code cards), `blueprint` (dark technical drawing: navy from the brand's
  ink under a faint grid, 1px accent lines, 4px corners, small-caps labels with
  ruler ticks, monospace for code and tool names only).
- **Features** — the brand's `features` decide what the product can do, and that
  is visible to a reviewer and to the user: the tools of a feature the brand
  leaves out are not declared to the model (built-in agent and helper alike — the
  panel tells the helper its features with `ready`), the matching system-prompt
  sections go with them, the panel's controls disappear (🛰, 🧩 tabs, 👤, quick
  commands, settings sections), and the manifest drops the feature's permissions:

  | feature | what it is | permissions it owns |
  | --- | --- | --- |
  | `helper` | "My Claude subscription" through the local helper | `nativeMessaging` |
  | `remote` | phone / Telegram remote (🛰) | — |
  | `recipes` | record and replay | — |
  | `watchers` | scheduled page checks + notifications | `alarms`, `notifications` |
  | `memory` | site notes | — |
  | `profiles` | device profiles and the User-Agent tools (👤) | — |
  | `cookies` | the cookie tools | `cookies` |
  | `converter` | documents, PDFs, saved pages, screenshots to file | `downloads`, `downloads.open` |
  | `network` | the network tap | — |
  | `proxy` | the proxy settings and per-profile proxies | `proxy`, `webRequest`, `webRequestAuthProvider`, `privacy` |

- **Extras** — opt-in features a brand switches on (`"clips": true`) and every
  other brand lacks, so Tali stays as published while another brand gets
  capabilities of its own. Each is two files: `browser/host/extras/<id>.ts`
  declares the tools and the prompt section the model gets (tools.ts appends
  them under the feature, so the host and the built-in agent declare them only
  to builds that have it) and `browser/extras/<id>.js` implements them in the
  side panel — tools through `AgentBrowserTools.register`, a tab in the 🧩 panel
  and quick commands through `AgentExtras`. The build concatenates a brand's
  modules into its `extras.js`. An extra that builds on a base feature declares
  it (`FEATURE_REQUIRES`): the build refuses `accounts` without `cookies` and
  `uptime` without `watchers`. `browser/host/features.ts` and `brand.mjs` hold the
  same lists; `tests/features.test.ts` keeps them equal and pins each extra's
  tool-name prefix.

  | extra | what it is | tools | ships in |
  | --- | --- | --- | --- |
  | `clips` | research clips with their sources: save, search, edit, export as Markdown; a citation (APA, MLA, Harvard, BibTeX) for the page from its metadata | `browser_clip_*` | Orbit |
  | `sessions` | save a window's tabs, add to a session later, restore; tidy a window (close duplicates or a host's tabs, never the active or pinned ones) | `browser_session_*` | Orbit |
  | `rewrite` | rewrite the selected text in place: tone, length, grammar, translation; text statistics (words, sentences, reading time, Flesch) of the selection, the field or the page; find & replace inside the focused field (literal or regex, markup kept) | `browser_selection_*` | Quill |
  | `snippets` | saved texts with placeholders, inserted into any field, edited in place | `browser_snippet_*` | Quill |
  | `autofill` | named identities (name, email, phone, company, address …, never secrets) that fill a page's form fields by label, name, placeholder and autocomplete, with a dry run and a report of what was and was not filled; nothing is submitted | `browser_autofill_*` | Quill |
  | `checks` | broken-link finder and URL status checks; an on-page SEO audit (title, description, canonical, robots, headings, alt texts, links, Open Graph, structured data); a speed report from the Performance API (TTFB, DCL, load, FCP, LCP, requests and weight by type, slowest resources); robots.txt and sitemap reading with the first URLs checked | `browser_check_*` | Beacon |
  | `uptime` | HTTP status monitors on a schedule, with latency history, pause/resume, and an availability report (uptime %, avg/median/p95 latency, flips, longest outage) over a window (on the watcher machinery) | `browser_uptime_*` | Beacon |
  | `accounts` | named sign-ins per site, switched without logging out, rotated to the next one, exported and imported as a JSON envelope (on the cookie tools; export, import and next ask first) | `browser_account_*` | Harbor |
  | `audit` | identity report: what the site sees, device profile and proxy consistency; the exit address through the current proxy (Cloudflare trace) against the profile; leak checks in the tab (WebRTC, time zone, languages, screen, webdriver, UA vs client hints) | `browser_identity_*` | Harbor |
  | `styles` | restyle a site: inspect an element's styles, apply CSS overrides the site keeps (content script), reset; presets (reading, focus, compact, dyslexia, print), a font swap (Google Fonts @import allowed), UserCSS export for Stylus and import | `browser_style_*` | Palette |
  | `palette` | the page's colours, fonts and type scale, contrast check, a dark theme for the site, colour harmonies from the accent with their contrast and CSS variables (on `styles`) | `browser_palette_*` | Palette |
  | `elements` | add, edit, hide, move and duplicate elements on a page and keep them per site (content script); a developer hand-off of the edits as Markdown, CSS or a JSON patch | `browser_element_*` | Stencil |
  | `overlay` | layout overlays for review: column and baseline grids, measurements, numbered notes to screenshot, a design image laid over the page at an opacity, the window resized to phone / tablet / laptop / desktop widths | `browser_overlay_*` | Stencil |
  | `skills` | the playbooks a brand ships with (`browser/playbooks/*.md`), served to the model on demand, a 🎓 tab, one quick command each | `browser_skill_*` | Palette, Stencil |

  **Playbooks** make a brand an expert rather than a generalist. Each is a
  Markdown file with a front matter (title, summary, when to read it, the quick
  command it brings and that command's prompt) and a body of process, numbers,
  checklists and CSS patterns. A brand lists the ones it carries in
  `"playbooks"`; the build packs them into `skills.json`, the system prompt tells
  the model to read the matching one before a design task, and the model fetches
  it with `browser_skill_read`, so the prompt stays short. Shipped: design-review,
  typography, color, layout, dark-mode, accessibility, readability (Palette's
  shelf); design-review, layout, components, landing-page, ux-writing,
  typography, accessibility (Stencil's). `tests/brand.test.mjs` checks every
  playbook is complete and every brand packs only its own.

  An extra that must act on pages while the panel is closed ships a content
  script, `browser/extras/<id>.cs.js`: the build copies it to
  `extras-<id>.cs.js` in the brands that have the extra and the feature's module
  registers it with `chrome.scripting.registerContentScripts`.

- **Logo** — the icon and avatar the brand points at. `browser/brands/make-logo.mjs`
  draws a vector mark (several styles: monogram, orbit, quill, beacon, harbor,
  palette, stencil) and
  renders the two PNGs in headless Chromium, so a brand gets a clean, distinct
  logo from one command; real artwork can replace the files any time.
- Only the default brand carries the manifest `key` (a fixed id for unpacked
  installs); every other brand gets its id from the store.

```bash
npm run build:brands                 # every brand → dist-browser/brands/<id>/extension (default → dist-browser/extension)
node browser/build.mjs --brand orbit # one brand
npm run package:brands               # production build + dist-browser/store/<id>-<version>.zip per brand (manifest at the zip root)
node browser/brands/make-logo.mjs orbit --style orbit --bg "#0b1d3a" --fg "#e8eefc" --accent "#ff7a59"
```

`tests/brand.test.mjs` checks every brand file, the permission and tool cuts;
`tests/e2e/brands.e2e.mjs` loads each built brand in Chromium and checks name,
colours, assistant, skin, permissions, declared tools, hidden controls, the
extras' runtime and the settings page; `tests/e2e/extras-<brand>.e2e.mjs` drive
each brand's extras against fixture pages. The brands besides Tali are
placeholders (invented names and texts, generated marks) — replace them before
any of them goes anywhere.

**Before publishing more than one of them under one developer account, read
the Chrome Web Store policy on repetitive content.** The store does not allow a
developer (or related accounts) to publish multiple extensions with the same
functionality under different names, and enforcement takes down every listing
involved, the published one included. Brands exist for white-label use — a
partner publishing under their own, unrelated account, unlisted or private
distribution — and the feature profiles are what makes a brand a different
product rather than a renamed copy.

## Install for development

```bash
npm run build && npm run build:browser
cd dist-browser/host && npm install --omit=dev && node register.mjs
```

Then open `chrome://extensions` (or `edge://extensions`), turn on **Developer
mode**, **Load unpacked** → `dist-browser/extension`, and click the toolbar icon.
The extension id is pinned by the `key` in `manifest.json`
(`ppakaagcjnojicbdebhgkpjgikclbnlf`), which is what `register.mjs` allows.
After changing host code, rebuild and reinstall its deps; after changing
extension files, rebuild and hit **Reload** on the extensions page.

Not logged in? The panel shows a **Log in** button that runs `claude login`.
