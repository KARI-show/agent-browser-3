// ═══════════════════════════════════════════════════════════════════════════
// Remote access for the browser extension — on its own, no VS Code needed.
// Three modes (picked on the options page, options.html#remote):
//
//  bot     The extension itself is a Telegram bot (telegram.js): you chat with
//          it in Telegram. Nothing to install.
//  helper  The local helper (native host) runs a relay, a public cloudflared
//          tunnel and the relay's Telegram bot (relay/bot.mjs); the panel joins
//          that relay as a node, so the phone gets the full web app / Mini App.
//  relay   The panel joins a relay you run yourself (relay/hub.mjs).
//
// In the two relay modes the panel is a relay "node", like the VS Code
// extension: it publishes its chats, mirrors the open chat's stream to
// subscribers and takes prompts, Stop and approvals from them.
//
// Config: chrome.storage.local "agentRemote"
//   { enabled, mode, botToken, userId, relayUrl, relayToken, publicUrl }
// Status for the options page: chrome.storage.session "agentRemoteStatus".
// Only one panel (browser window) runs remote at a time — a Web Lock decides.
// ═══════════════════════════════════════════════════════════════════════════
(function () {
  var CONFIG_KEY = "agentRemote";
  var LEGACY_KEY = "agentRelay"; // relay-only settings of earlier versions
  var STATUS_KEY = "agentRemoteStatus";
  var HOST = "com.kari.agent_browser";
  var LOCK = "agent-browser-remote";

  var config = {};
  var session = null; // this panel's remote session (running, or waiting for the lock)
  // Set when the user starts remote with the 🛰 button: report in the panel how
  // it went — the link / bot once up, or why not (auto-starts stay quiet).
  var announce = false;
  var reportedFailure = false;

  // ── Config ─────────────────────────────────────────────────────────────

  async function loadConfig() {
    var r = await chrome.storage.local.get([CONFIG_KEY, LEGACY_KEY]);
    var c = r[CONFIG_KEY];
    if (!c) {
      var old = r[LEGACY_KEY];
      c = old && old.url
        ? { mode: "relay", enabled: !!old.enabled, relayUrl: old.url, relayToken: old.token || "", publicUrl: old.publicUrl || "" }
        : { mode: "bot", enabled: false };
    }
    config = c;
    return c;
  }

  function saveConfig(c) {
    config = c;
    return chrome.storage.local.set({ [CONFIG_KEY]: c });
  }

  function configured(c) {
    if (!c) return false;
    if (c.mode === "relay") return !!(c.relayUrl && c.relayToken);
    if (c.mode === "bot") return !!(c.botToken && c.userId);
    return c.mode === "helper"; // its Telegram bot is optional
  }

  // Everything a running session depends on; a change restarts it.
  function sessionKey(c) {
    return JSON.stringify([c.mode, c.botToken || "", c.userId || "", c.relayUrl || "", c.relayToken || "", c.publicUrl || ""]);
  }

  // ── Session: one at a time across this profile's panels ─────────────────

  var syncing = Promise.resolve();
  function sync() {
    syncing = syncing.then(doSync, doSync);
    return syncing;
  }

  async function doSync() {
    var c = await loadConfig();
    var key = c.enabled && configured(c) ? sessionKey(c) : "";
    if (session && session.key === key) return;
    if (session) stopSession();
    if (key) startSession(c, key);
  }

  function startSession(c, key) {
    var s = { key: key, mode: c.mode, cfg: c, stopped: false, abort: new AbortController(), release: null, port: null };
    session = s;
    if (!navigator.locks) return run(s);
    updateStatus("off", "Waiting — remote is running in another browser window");
    navigator.locks
      .request(LOCK, { signal: s.abort.signal }, function () {
        if (s.stopped) return;
        // Held until the session stops (or this panel closes, which frees it).
        return new Promise(function (release) {
          s.release = release;
          run(s);
        });
      })
      .catch(function () {}); // aborted while waiting
  }

  function run(s) {
    if (s.mode === "relay") {
      connectNode({ url: s.cfg.relayUrl, token: s.cfg.relayToken, publicUrl: s.cfg.publicUrl || "" });
    } else if (s.mode === "helper") {
      startHelper(s);
    } else if (s.mode === "bot") {
      if (window.AgentTelegram) window.AgentTelegram.start(s.cfg);
      else fail("The Telegram module didn't load.");
    }
  }

  function stopSession() {
    var s = session;
    session = null;
    if (!s) return;
    s.stopped = true;
    s.abort.abort();
    disconnectNode();
    if (s.port) {
      try { s.port.disconnect(); } catch (e) {}
      s.port = null;
    }
    if (window.AgentTelegram) window.AgentTelegram.stop();
    if (s.release) s.release();
    announce = false;
    updateStatus("off", "");
  }

  /** A mode failed to come up: say why on 🛰 / the options page, and in the panel if the user is waiting. */
  function fail(message) {
    updateStatus("error", message);
    if (announce) {
      announce = false;
      local({ type: "notice", message: "Remote: " + message });
    }
  }

  // ── helper mode: the native host runs relay + tunnel + bot ──────────────

  function startHelper(s) {
    var port;
    try {
      port = chrome.runtime.connectNative(HOST);
    } catch (e) {
      return fail("The local helper isn't installed — set it up in the settings (My Claude subscription).");
    }
    s.port = port;
    updateStatus("off", "Starting the relay and a public tunnel…");
    port.onMessage.addListener(function (m) {
      if (!m || s.stopped) return;
      if (m.type === "remoteReady") {
        if (!m.publicUrl) {
          local({ type: "notice", message: "Remote: the public tunnel didn't come up (" + (m.tunnelError || "unknown error") + ") — the web app works on this computer only." });
        }
        connectNode({ url: m.relayUrl, token: m.token, publicUrl: m.publicUrl || "", bot: !!m.bot });
      } else if (m.type === "remoteError") {
        fail(m.message || "The helper couldn't start remote access.");
      }
    });
    port.onDisconnect.addListener(function () {
      if (s.stopped) return;
      var why = (chrome.runtime.lastError && chrome.runtime.lastError.message) || "it exited";
      s.port = null;
      disconnectNode();
      fail(/not found|forbidden/i.test(why)
        ? "The local helper isn't installed — set it up in the settings (My Claude subscription)."
        : "The local helper stopped (" + why + ").");
    });
    port.postMessage({ type: "remoteStart", botToken: s.cfg.botToken || "", userId: s.cfg.userId || "" });
  }

  // ── Relay node ─────────────────────────────────────────────────────────

  var ws = null;
  var target = null; // { url, token, publicUrl, bot } the node dials
  var nodeId = null;
  var reconnectTimer = null;
  var connected = false;

  // Stable node id per extension install.
  function getNodeId() {
    if (nodeId) return Promise.resolve(nodeId);
    return chrome.storage.local.get("agentNodeId").then(function (r) {
      nodeId = r.agentNodeId;
      if (!nodeId) {
        nodeId = "ext-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        chrome.storage.local.set({ agentNodeId: nodeId });
      }
      return nodeId;
    });
  }

  function wsUrl(url) {
    return String(url || "").trim().replace(/^http/, "ws").replace(/\/+$/, "");
  }

  function hostOf(url) {
    try { return new URL(String(url).replace(/^ws/, "http")).hostname; } catch (e) { return ""; }
  }

  function isLoopback(url) {
    var h = hostOf(url);
    return h === "localhost" || h === "127.0.0.1" || h === "[::1]";
  }

  // The token rides in the URL, so plaintext ws:// to a remote relay leaks it to
  // every hop. Same rule as src/hub.ts: only localhost/LAN may stay plain.
  function secureUrl(url) {
    var h = hostOf(url);
    if (!h) return url;
    var local = isLoopback(url) || /^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(h);
    return !local && url.indexOf("ws://") === 0 ? "wss://" + url.slice(5) : url;
  }

  /** The web-app link for a chat — what the relay's Telegram bot hands out, for this node. */
  function shareLink(chatId) {
    if (!target || !nodeId || !chatId) return "";
    var base = (target.publicUrl || secureUrl(wsUrl(target.url))).trim().replace(/^ws/, "http").replace(/\/+$/, "");
    return base + "/app?token=" + encodeURIComponent(target.token) +
      "&node=" + encodeURIComponent(nodeId) + "&chat=" + encodeURIComponent(chatId);
  }

  function connectNode(t) {
    disconnectNode();
    target = t;
    dial();
  }

  async function dial() {
    if (ws || !target) return;
    var t = target;
    var nid = await getNodeId();
    if (ws || target !== t) return; // superseded while we awaited storage

    var url = secureUrl(wsUrl(t.url));
    var sock;
    try {
      sock = new WebSocket(url + "/?token=" + encodeURIComponent(t.token) +
        "&role=node&id=" + encodeURIComponent(nid) + "&name=" + encodeURIComponent("Agent Browser"));
    } catch (e) {
      return fail("Bad relay address — fix it in the settings.");
    }
    ws = sock;
    updateStatus("off", "Connecting to " + hostOf(url) + "…");

    sock.onopen = function () {
      if (ws !== sock) return;
      connected = true;
      updateStatus("on", "relay " + hostOf(t.publicUrl || url));
      publishPresence();
      if (announce) {
        announce = false;
        announceLink();
      }
    };

    sock.onmessage = function (ev) {
      if (ws !== sock) return;
      var m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      handleRelayMessage(m);
    };

    sock.onclose = function (ev) {
      if (ws !== sock) return; // dropped on purpose (disconnect / new target)
      ws = null;
      connected = false;
      // 4001 = the relay rejected the token: retrying can't fix that.
      if (ev && ev.code === 4001) return fail("The relay rejected the token — check it in the settings.");
      if (announce && !reportedFailure) {
        // Keep `announce`: the link still shows up once a retry gets through.
        reportedFailure = true;
        local({ type: "notice", message: "Remote: can't reach the relay at " + hostOf(url) + " — retrying in the background. (🛰 again to stop.)" });
      }
      updateStatus("off", "Relay unreachable — retrying…");
      if (!reconnectTimer) {
        reconnectTimer = setTimeout(function () {
          reconnectTimer = null;
          dial();
        }, 3000);
      }
    };

    sock.onerror = function () {
      try { sock.close(); } catch (e) {}
    };
  }

  function disconnectNode() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    var sock = ws;
    ws = null; // first, so its onclose knows it was dropped on purpose
    target = null;
    connected = false;
    if (streamTimer) { clearTimeout(streamTimer); streamTimer = null; }
    pendingStream = null;
    if (sock) { try { sock.close(); } catch (e) {} }
  }

  function send(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  function announceLink() {
    var link = shareLink(activeChatId);
    var bot = target && target.bot ? " Your Telegram bot lists this browser's chats too." : "";
    if (!link) {
      local({ type: "info", text: "🛰 Remote ON — this browser's chats are on the relay as “Agent Browser”." + bot });
      return;
    }
    var text = "🛰 Remote ON — open this chat on your phone:\n" + link + "\n" + bot +
      (isLoopback(target.publicUrl || target.url) ? "\n(That address only works on this computer.)" : "");
    var show = function (copied) { local({ type: "info", text: text + (copied ? "\n(link copied)" : "") }); };
    if (navigator.clipboard) navigator.clipboard.writeText(link).then(function () { show(true); }, function () { show(false); });
    else show(false);
  }

  // ── Talking to the panel and the host (shared with telegram.js) ────────

  // Show something in this panel only (never mirrored anywhere).
  function local(msg) {
    msg.__local = true;
    window.dispatchEvent(new MessageEvent("message", { data: msg }));
  }

  // Talk to the host exactly like the panel does (shim.js's VS Code API
  // surface), so remote actions take the same code path as local clicks.
  var hostApi = typeof window.acquireVsCodeApi === "function" ? window.acquireVsCodeApi() : null;
  var fromRemote = false; // a remote prompt is on its way to the host right now
  function toHost(msg) {
    if (!hostApi) return;
    fromRemote = true;
    try { hostApi.postMessage(msg); } finally { fromRemote = false; }
  }

  // ── Panel state, tracked from the host's own messages ──────────────────
  // Works with either backend (built-in agent or native host) without reading
  // their storage.
  var chats = [];
  var activeChatId = null;
  var running = {}; // convId → true while a run is going

  function publishPresence() {
    send({ t: "presence", workspace: "Browser", chats: chats });
  }

  // ── Messages from relay clients (web app / Mini App) ───────────────────

  // Keyed by approval/question id, so they're safe to pass through from any chat.
  var PASS_THROUGH = { approvalResponse: 1, questionResponse: 1 };
  // Act on whatever chat the panel shows — only honoured when that's the sender's chat.
  var ACTIVE_CHAT_ONLY = { interrupt: 1, compact: 1 };

  function replyError(clientId, message) {
    send({ t: "toClient", clientId: clientId, msg: { type: "error", message: message } });
  }

  function handleRelayMessage(m) {
    if (!m || m.t !== "fromClient" || !m.msg || typeof m.msg.type !== "string") return;
    var msg = m.msg;
    var chatId = typeof msg.chatId === "string" && msg.chatId ? msg.chatId : null;

    // A web client opened (or reconnected to) a chat: make it the active one.
    // The host answers with loadConversation, model, mode, conversations…,
    // which the mirror below forwards to that chat's channel.
    if ((msg.type === "ready" || msg.type === "openChat") && chatId) {
      toHost({ type: "openConversation", id: chatId });
      return;
    }

    if (msg.type === "prompt") {
      var text = typeof msg.text === "string" ? msg.text.trim() : "";
      if (!text) return;
      if (!chatId || chatId !== activeChatId) {
        return replyError(m.clientId, "This chat isn't open in the browser right now — reopen it from the chat list and resend.");
      }
      if (running[chatId]) {
        return replyError(m.clientId, "This chat is still working — wait for the reply or press Stop.");
      }
      // Straight to the host, not through the panel's input box: typing into
      // it would wipe the desktop user's draft and send their attachments
      // along. The panel gets the bubble the way it shows mirrored messages.
      local({ type: "user", text: text });
      toHost({ type: "prompt", text: text, attachments: [] });
      return;
    }

    if (ACTIVE_CHAT_ONLY[msg.type]) {
      if (chatId && chatId === activeChatId) toHost({ type: msg.type });
      return;
    }

    if (PASS_THROUGH[msg.type]) {
      toHost(msg);
      return;
    }

    if (msg.type === "listChats") publishPresence();
  }

  // ── Mirror: what the host shows in the panel → that chat's subscribers ─

  var STREAM_TYPES = {
    started: 1, text: 1, thinking: 1, tool: 1, toolResult: 1, result: 1, idle: 1, error: 1, info: 1, notice: 1,
    approval: 1, approvalResolved: 1, question: 1, questionResolved: 1,
    loadConversation: 1, conversations: 1, runState: 1, contextUsage: 1, usageLimits: 1,
    model: 1, mode: 1, identity: 1, slashCommands: 1,
  };

  // Streamed text/thinking arrives in token-sized pieces; the hub drops a node
  // that sends more than ~40 messages/s, which a fast model easily exceeds.
  // Merge consecutive pieces and send at most every STREAM_FLUSH_MS; any other
  // event flushes first, so order is kept.
  var STREAM_FLUSH_MS = 100;
  var pendingStream = null; // { chatId, type, text }
  var streamTimer = null;

  function flushStream() {
    if (streamTimer) { clearTimeout(streamTimer); streamTimer = null; }
    var p = pendingStream;
    if (!p) return;
    pendingStream = null;
    send({ t: "event", chatId: p.chatId, ev: { type: p.type, text: p.text } });
  }

  function mirror(chatId, ev) {
    if ((ev.type === "text" || ev.type === "thinking") && typeof ev.text === "string") {
      if (pendingStream && pendingStream.chatId === chatId && pendingStream.type === ev.type) {
        pendingStream.text += ev.text;
      } else {
        flushStream();
        pendingStream = { chatId: chatId, type: ev.type, text: ev.text };
      }
      if (!streamTimer) streamTimer = setTimeout(flushStream, STREAM_FLUSH_MS);
      return;
    }
    flushStream();
    send({ t: "event", chatId: chatId, ev: ev });
  }

  window.addEventListener("message", function (ev) {
    var d = ev.data;
    if (!d || typeof d.type !== "string" || d.__local) return;

    // Track the panel's state first — even while disconnected, so a later
    // connect (or the Telegram bot) knows the chats and which one is open.
    if (d.type === "runState" && typeof d.convId === "string") {
      if (d.running) running[d.convId] = true;
      else delete running[d.convId];
    } else if (d.type === "loadConversation" && typeof d.convId === "string") {
      // Posted for the chat that's becoming active, before "conversations" says so.
      activeChatId = d.convId;
    } else if (d.type === "clear") {
      activeChatId = null; // new chat / current one deleted — nothing open to mirror
    } else if (d.type === "conversations") {
      activeChatId = typeof d.activeId === "string" ? d.activeId : null;
      if (Array.isArray(d.items)) {
        chats = d.items.slice(0, 50).map(function (c) {
          return { id: String(c.id), title: String(c.title || c.id) };
        });
        if (connected) publishPresence();
      }
    }

    if (!connected || !STREAM_TYPES[d.type]) return;
    // runState names its chat (it may be a background one); the rest belongs to the open chat.
    var chatId = typeof d.convId === "string" ? d.convId : activeChatId;
    if (!chatId) return;
    mirror(chatId, d);
    // A client that just opened a running chat must see Stop, not an idle composer.
    if (d.type === "loadConversation" && running[chatId]) {
      mirror(chatId, { type: "runState", convId: chatId, running: true });
    }
  });

  // Prompts typed in this panel: mirror the question too, so the phone doesn't
  // see answers to messages it never saw. (shim.js announces outgoing messages.)
  window.addEventListener("agent:outgoing", function (ev) {
    var msg = ev.detail;
    if (fromRemote || !connected || !activeChatId || !msg || msg.type !== "prompt" || typeof msg.text !== "string") return;
    mirror(activeChatId, { type: "user", text: msg.text });
  });

  // ── Status: 🛰 button + options page ───────────────────────────────────

  var remoteBtn = document.getElementById("remoteBtn");

  function updateStatus(state, message) {
    chrome.storage.session.set({ [STATUS_KEY]: { state: state, message: message || "" } }).catch(function () {});
    if (!remoteBtn) return;
    remoteBtn.classList.toggle("on", state === "on");
    remoteBtn.setAttribute("aria-pressed", state === "on" ? "true" : "false");
    remoteBtn.title =
      state === "on" ? "Remote ON — " + message + ". Click to stop." :
      state === "error" ? "Remote: " + message :
      message ? "Remote: " + message :
      "Remote: continue this browser's chats from your phone / Telegram";
  }

  function openRemoteSettings() {
    chrome.tabs.create({ url: chrome.runtime.getURL("options.html#remote") });
  }

  if (remoteBtn) {
    remoteBtn.addEventListener("click", function () {
      loadConfig().then(function (c) {
        if (session || c.enabled) {
          // On, starting, retrying or waiting in another window → off everywhere.
          stopSession();
          return saveConfig(Object.assign({}, c, { enabled: false }));
        }
        if (!configured(c)) return openRemoteSettings();
        announce = true;
        reportedFailure = false;
        // Every panel's storage listener syncs; this one also syncs right away.
        return saveConfig(Object.assign({}, c, { enabled: true })).then(sync);
      });
    });
  }

  // Settings changed on the options page, or remote toggled in another panel.
  chrome.storage.onChanged.addListener(function (ch, area) {
    if (area === "local" && ch[CONFIG_KEY]) sync();
  });

  updateStatus("off", "");
  sync();

  // For telegram.js (bot mode) — the same panel state and host channel.
  window.AgentRemote = {
    toHost: toHost,
    local: local,
    state: function () { return { activeChatId: activeChatId, chats: chats.slice(), running: Object.assign({}, running) }; },
    /** Bot mode is up: light 🛰 and, if the user just pressed it, say so in the panel. */
    up: function (message, panelText) {
      updateStatus("on", message);
      if (announce) {
        announce = false;
        if (panelText) local({ type: "info", text: panelText });
      }
    },
    status: updateStatus,
    fail: fail,
  };
})();
