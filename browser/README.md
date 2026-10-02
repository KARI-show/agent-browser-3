# Agent Browser

The Agent IDE agent as a Chrome / Edge / Brave extension: a side panel that
works in your real, logged-in browser — reads pages, clicks, types, picks
options, scrolls, switches tabs and takes screenshots. It runs on your Claude
**subscription** (or `ANTHROPIC_API_KEY`), exactly like the VS Code panel.

## Three ways to run the agent

Pick in the extension's settings (the 🌐 button in the panel):

| | How | Needs |
| --- | --- | --- |
| **Free trial** | requests go through your gateway ([`trial-server/`](../trial-server/README.md), which holds *your* API key and enforces the limits) | nothing on the user's side; build with `AGENT_TRIAL_URL=https://your-gateway node browser/build.mjs` |
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
instruction if it isn't. This is an ordinary Incognito window, not a
fingerprint or identity change: sites still see the same browser and exit
address (combine it with a proxy above for a different exit address too).

| Mode | Browser actions |
| --- | --- |
| Agent | run without asking (the agent still confirms risky steps in chat) |
| Careful | every click / type / navigation needs **Allow** |
| Ask | read-only — read page, screenshot, list tabs |

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

## Build

```bash
npm run build                # webview bundle (media/main.js) first
npm run build:browser        # → dist-browser/{extension,host}
npm run package:browser      # production build + dist-browser/agent-browser.zip
```

For the free trial add `AGENT_TRIAL_URL=https://your-gateway` to the build command. Release: upload `agent-browser.zip` to the
[agent-ide-setup](https://github.com/KARI-show/agent-ide-setup) release — its
`install-browser.ps1` downloads it from there.

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
