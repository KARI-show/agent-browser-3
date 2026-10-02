# Agent IDE

> **Claude-powered AI agent** that lives in your editor and your browser — reads pages, clicks, types, manages cookies, switches accounts, converts documents, and automates workflows. Runs on your Claude subscription (no API key needed).

Two runtimes, one codebase:

| Runtime | Where | What it does |
|---------|-------|-------------|
| **VS Code / Cursor extension** | Editor side panel | Full coding agent — reads, edits, runs commands against your workspace. Parallel chats, live diffs, checkpoints, remote control from phone & Telegram. |
| **Chrome / Edge extension** | Browser side panel | Browser automation agent — operates your real, logged-in browser with 38 tools. Cookie editor, private sessions, UA override, document converter. |

---

## ✨ VS Code Extension

### 🤖 Agent in your editor
- Reads, edits, and runs commands in your **local workspace** via the Claude Agent SDK.
- **Terminal-style tool cards**: every command shows `$ cmd` and live output; approvals merged into the card.
- **Modes**: Agent (full), Ask (read-only), Plan (proposes first), Auto-accept (hands-free).

### 🪟 Parallel chats
- Run **multiple agents at once** — refactor in one, research in another. Background chats keep working.

### 🔍 Diffs & checkpoints
- **Live diffs** for every change — Keep or Revert per file or all at once.
- **Checkpoints & Rewind**: roll back to any earlier message, optionally reverting files.

### 🧠 Context management
- **Context-window meter** — always know how much you're sending.
- **/compact** — summarize and reclaim context.
- **Auto-context**: active file + selection attached automatically.
- **@-mention** files, paste/attach images, drag-drop.

### 📱 Remote control
- **One tap** to go remote via `cloudflared` tunnel (zero config).
- **Telegram bot** — navigate folders → chats → open a web Mini App with the full UI.
- **Live bidirectional sync** — type from phone, see on desktop, and vice versa.
- **Cross-device approvals** — Allow/Deny from any device.

### 🛠 Super tools (experimental)
- **Eyes** — headless-browser screenshot + rendered DOM.
- **Hands** — managed dev server (start, tail logs, stop).
- **Memory** — persistent project notebook the agent reads/writes.
- **Scale** — spawn read-only subagents for parallel research.
- **Orchestrator** — background multi-agent runs from a goal.

### ⚙️ More
- Plan-usage gauges (5h / 7d limits).
- AI-written commit messages.
- Hybrid engine — point at LM Studio / Ollama for offline use.
- MCP server support (extra tools).
- Status-bar HUD.

---

## 🌐 Browser Extension — 38 Tools

The browser extension gives the AI agent full control over your real browser through a side panel. Every tool is declared in [`browser/host/tools.ts`](browser/host/tools.ts) and executed in the extension's side panel page.

### Core — Navigation & Reading

| Tool | Description |
|------|-------------|
| `browser_read_page` | Read the current tab: URL, title, headings outline, interactive elements with `[ref]` numbers, and visible page text. Covers iframes and shadow DOM. |
| `browser_screenshot` | Capture a screenshot of the visible viewport. Use when layout, images, or charts matter. |
| `browser_tabs` | List all open tabs (id, title, url). Current tab marked with `*`. |
| `browser_switch_tab` | Switch to another open tab by its ID. |
| `browser_navigate` | Open a URL, or go back / forward / reload. |
| `browser_new_tab` | Open a URL in a new tab. |
| `browser_close_tab` | Close a tab (default: current one). |
| `browser_scroll` | Scroll down/up/top/bottom, or scroll an element into view. |
| `browser_find` | Search all frames + shadow DOM for text. Returns matching elements with refs. |
| `browser_wait` | Wait for the page to settle (animations, lazy loading). |
| `browser_wait_for` | Wait until text appears/disappears or URL matches — smarter than a fixed delay. |
| `browser_hover` | Real pointer hover — triggers CSS `:hover` menus and tooltips. |

### Interactions

| Tool | Description |
|------|-------------|
| `browser_click` | Click an element by ref. Detects blocking overlays (cookie banners, modals). Reports whether the page reacted; retries with real mouse input if needed. |
| `browser_type` | Type text into inputs, textareas, or contenteditable elements. Can replace or append, optionally submit. |
| `browser_select` | Choose an option in a `<select>` dropdown by value or visible text. |
| `browser_press_key` | Press any key with optional modifiers (`Control+A`, `Shift+Tab`, `Meta+Enter`). |
| `browser_drag` | Drag one element onto another — HTML5 drag-and-drop, sortable lists, kanban cards, sliders. |
| `browser_upload_file` | Put an attached file into a file input element. |
| `browser_fill_form` | Fill multiple form fields at once — pass `[{ref, value}]` or `{ref: value}`. Much faster than typing each field. |
| `browser_extract_table` | Extract an HTML table as structured text (rows × columns). |
| `browser_run_js` | Execute JavaScript in the page and return the result. Last resort for data other tools can't reach. |

### 🍪 Cookie Editor (6 tools)

Full cookie management on any domain — inspect, edit, transfer sessions between profiles.

| Tool | Description |
|------|-------------|
| `browser_cookies_get` | List cookies for a domain or current page. Shows name, value, domain, flags. |
| `browser_cookies_set` | Set or update a cookie with full control (domain, path, secure, httpOnly, sameSite, expiry). |
| `browser_cookies_delete` | Delete a specific cookie by name. |
| `browser_cookies_clear` | Delete ALL cookies for a domain. |
| `browser_cookies_export` | Export all cookies as JSON — for backup or cross-profile transfer. |
| `browser_cookies_import` | Import cookies from a JSON array. |

### 🎭 User-Agent & Fingerprint

| Tool | Description |
|------|-------------|
| `browser_set_useragent` | Override User-Agent string + `navigator.platform` + Accept-Language via DevTools protocol. |
| `browser_get_useragent` | Get current UA, platform, and language settings. |

**Built-in UA generator** with 12 device presets:

| Preset | Example |
|--------|---------|
| `win-chrome` | Windows 10/11 + Chrome 120–152 |
| `win-edge` | Windows + Edge 120–152 |
| `win-firefox` | Windows + Firefox 122–135 |
| `mac-chrome` | macOS 13–15 + Chrome |
| `mac-safari` | macOS + Safari 17–18 |
| `iphone` | iPhone + Safari (iOS 16–18) |
| `android` | Pixel / Samsung / Xiaomi + Chrome |
| `linux` | Linux x86_64 + Chrome |

Each preset randomizes version, screen resolution, and Accept-Language from realistic pools.

### 👤 Private Sessions

Incognito windows separate from your normal, signed-in tabs — for a clean, logged-out session or to sign in as a different user than the main window. Note: all Incognito windows share one session, so they can't hold several accounts signed in at once; to keep and switch between accounts, export a profile's cookies and import them into a fresh session.

| Tool | Description |
|------|-------------|
| `browser_new_profile` | Open an Incognito window — a session separate from your normal tabs. |
| `browser_list_profiles` | List open windows. `[ISOLATED]` vs `[MAIN]`, window ID, tab count. |
| `browser_switch_profile` | Switch to a different window by window ID. |
| `browser_close_profile` | Close a window and all its tabs/sessions. |
| `browser_open_private_window` | Quick incognito window (no profile management). |

**Profile Manager UI** (👤 button in side panel):
- Create named profiles with UA preset, proxy, start URL, and agent context notes.
- Launch → opens incognito window with configured UA and proxy.
- Snapshot → saves current cookies + UA into the profile.
- Activity log per profile.

### 📄 Document Converter

All conversions run locally — no server calls, no external dependencies.

| Tool | Description |
|------|-------------|
| `browser_convert` | Universal converter: CSV↔JSON, Markdown→HTML/PDF, HTML→PDF, table→CSV/JSON, image format/resize (PNG↔JPEG↔WebP via Canvas API). |
| `browser_page_to_pdf` | Current page → PDF via browser print dialog. |
| `browser_save_page` | Save page as HTML, TXT, or Markdown file. |
| `browser_screenshot_save` | Save screenshot as PNG/JPEG file. |

### ⚡ Quick Commands

40+ one-click commands organized by category:

- **Pages & Navigation** — Read page, Screenshot, Find, Open URL, List tabs, Go back
- **Cookies & Sessions** — Show/Set/Export/Import/Clear cookies
- **Private sessions** — New window, List windows, Switch, Transfer session
- **User-Agent** — Check UA, iPhone/Android/Mac/Windows presets, Custom UA
- **Automation** — Fill form, Extract table, Extract links, Screenshot all tabs, Monitor changes
- **Data & Research** — Summarize page, Google search, Compare tabs
- **Convert** — Save as HTML/TXT/PDF, Extract table to CSV, CSV↔JSON, Markdown→HTML

### 🛰 Relay — Remote Access

Connect the browser extension to a WebSocket relay hub for remote control via Telegram or web.

- Stable node ID per extension install.
- Presence broadcasting (active chats).
- Bidirectional message sync.
- Same relay protocol as the VS Code extension — hub doesn't care who connects.

---

## 🏗 Architecture

```
┌─────────────────────────────────┐
│  VS Code / Cursor Extension     │
│  src/ → dist/extension.js       │
│  Claude Agent SDK + tools       │
│  Webview panel (media/)         │
│  Relay client + TG bot          │
├─────────────────────────────────┤
│  Browser Extension (Chrome/Edge)│
│  browser/extension/             │
│  Manifest V3, side panel        │
│  38 browser_* tools             │
│  Cookie editor, profiles, UA    │
│  Converter, commands, relay     │
├─────────────────────────────────┤
│  Relay Hub                      │
│  relay/hub.mjs (WebSocket)      │
│  relay/bot.mjs (Telegram)       │
│  relay/public/ (web Mini App)   │
├─────────────────────────────────┤
│  Queue Manager (optional)       │
│  cli-proxy/queue-manager/       │
│  OAuth proxy, rate limits       │
│  Multi-user, retry on 429       │
└─────────────────────────────────┘
```

### Key files

```
src/                          # VS Code extension source (TypeScript)
media/                        # Webview styles + bundled JS
browser/
  extension/                  # Browser extension (Manifest V3)
    manifest.json
    background.js             # Service worker
    sidepanel.html/css        # Side panel UI
    browserTools.js           # 38 browser tools implementation
    converter.js              # Document converter engine
    profiles.js               # Profile manager + UA generator
    commands.js               # Quick commands panel
    relay.js                  # Remote relay client
    options.html/js/css       # Settings page
  host/
    tools.ts                  # Tool definitions (Zod schemas)
    host.ts                   # Native messaging host
    proxy.ts                  # API proxy
  standalone/                 # Standalone browser agent engine
relay/
  hub.mjs                     # WebSocket relay hub
  bot.mjs                     # Telegram bot
  public/                     # Web Mini App
cli-proxy/
  queue-manager/              # Backend OAuth proxy
    server.mjs
    token-manager.mjs
```

---

## ⚡ Install

### VS Code Extension

**Prereq:** Claude CLI logged in (`claude login`) — uses your subscription, no API key needed. An `ANTHROPIC_API_KEY` works too.

1. Install from VSIX or Marketplace.
2. Reload Window → click the robot icon in the sidebar.
3. Type a request → Send.

### Browser Extension

1. Go to `chrome://extensions` (or `edge://extensions`).
2. Enable Developer Mode.
3. Load Unpacked → select the `browser/extension/` folder.
4. Open a website → click the extension icon → side panel opens.
5. Enter your Anthropic API key in Settings (⚙).

### Relay (optional)

```bash
cd relay
node hub.mjs    # WebSocket hub on port 8790
node bot.mjs    # Telegram bot (needs BOT_TOKEN + RELAY_TOKEN env vars)
```

---

## ⌨️ Shortcuts (VS Code)

| Key | Action |
|-----|--------|
| `Ctrl/Cmd+Alt+A` | Open panel |
| `Ctrl/Cmd+Alt+N` | New chat |
| `Ctrl/Cmd+Alt+K` | Add selection to chat |
| `Enter` on approval card | Allow |

---

## 🔑 Key Settings

### VS Code (`agentIde.*`)

| Setting | Description |
|---------|-------------|
| `model` | Default model (populated live from your account). |
| `includeEditorContext` | Auto-attach active file + selection. |
| `autoFixDiagnostics` | Feed new errors back to the agent after edits. |
| `superTools` | Enable Eyes / Hands / Memory / Scale tools. |
| `mcpServers` | Extra MCP tool servers (same shape as Claude Agent SDK). |
| `botToken` / `telegramUserId` | Telegram remote access. |
| `baseUrl` | Point at LM Studio / Ollama for offline use. |
| `shadowGit` | Deep checkpoints via shadow git repo. |
| `autoResume` | Self-healing: auto-resume stalled runs. |

### Browser Extension

Configured via the Settings page (⚙ in side panel):
- API key / proxy URL
- Default model
- Agent mode (Agent / Careful / Ask)

---

## 🔧 Development

```bash
# VS Code extension
npm install
npm run check          # typecheck + build + test
npm run watch          # dev mode with auto-rebuild

# Browser extension
npm run build:browser  # build to dist-browser/
npm run package:browser --production --zip  # production zip

# Tests
npm test               # node:test runner
```

### Tech stack
- **TypeScript** — extension host (CJS) + webview (IIFE), built with esbuild.
- **Node 18+**, `ws` for relay (ESM).
- **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) for the AI engine.
- **Manifest V3** for the browser extension.
- **Zero runtime dependencies** in the browser extension — everything runs with browser APIs.

---

## 📜 License

MIT License

```
Copyright (c) 2025 Miyang Tech (Zhuhai Hengqin) Co., Ltd.
```
