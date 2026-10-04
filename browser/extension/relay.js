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
//   { mode, autostart, botToken, userId, relayUrl, relayToken, publicUrl }
// On/off for this browser session (🛰): chrome.storage.session "agentRemoteOn";
// unset = whatever `autostart` says, so a restart only brings remote back if
// autostart is on. Status for the options page: session "agentRemoteStatus".
// Only one panel (browser window) runs remote at a time — a Web Lock decides.
// ═══════════════════════════════════════════════════════════════════════════
(function () {
  var CONFIG_KEY = "agentRemote";
  var LEGACY_KEY = "agentRelay"; // relay-only settings of earlier versions
  var ON_KEY = "agentRemoteOn";
  var STATUS_KEY = "agentRemoteStatus";
  var HOST = "com.kari.agent_browser";
  var LOCK = "agent-browser-remote";

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
        ? { mode: "relay", autostart: !!old.enabled, relayUrl: old.url, relayToken: old.token || "", publicUrl: old.publicUrl || "" }
        : { mode: "bot", autostart: false };
    }
    if (c.autostart === undefined) {
      // Earlier versions had one `enabled` flag for "start with the panel" and "on now". Carry it over to
      // autostart once, so remote keeps coming up for those who had it on; 🛰 is independent from here.
      c = Object.assign({}, c, { autostart: !!c.enabled });
      delete c.enabled;
      await chrome.storage.local.set({ [CONFIG_KEY]: c });
    }
    return c;
  }

  async function isOn(c) {
    var r = await chrome.storage.session.get(ON_KEY);
    return r[ON_KEY] === undefined ? !!c.autostart : !!r[ON_KEY];
  }

  function setOn(on) {
    return chrome.storage.session.set({ [ON_KEY]: on });
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
    syncing = syncing.then(doSync, doSync).catch(function (e) {
      updateStatus("error", "Remote couldn't start: " + ((e && e.message) || e), true);
    });
    return syncing;
  }

  async function doSync() {
    var c = await loadConfig();
    var key = (await isOn(c)) && configured(c) ? sessionKey(c) : "";
    if (session && session.key === key) return;
    if (session) stopSession();
    if (key) startSession(c, key);
  }

  function startSession(c, key) {
    var s = { key: key, mode: c.mode, cfg: c, stopped: false, abort: new AbortController(), release: null, port: null };
    session = s;
    if (!navigator.locks) return run(s);
    // Only this panel's button: the window that holds the lock owns the shared status.
    updateStatus("off", "Waiting — remote is running in another browser window", false);
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
    var owned = !!s.release || !navigator.locks;
    if (s.release) s.release();
    announce = false;
    updateStatus("off", "", owned);
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
        if (m.botError) {
          local({ type: "notice", message: "Remote: the Telegram bot didn't start (" + m.botError + ") — the web app still works; check the bot token in the settings." });
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
  var reconnectDelay = 3000; // grows while the relay stays down (src/hub.ts does the same)
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
    reconnectDelay = 3000;
    dial().catch(function (e) { fail("Remote couldn't connect: " + ((e && e.message) || e)); });
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
      reconnectDelay = 3000;
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
          dial().catch(function () {});
        }, reconnectDelay);
        reconnectDelay = Math.min(Math.round(reconnectDelay * 1.6), 30000);
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
    followers = {};
    pendingInterrupt = null;
    if (sock) { try { sock.close(); } catch (e) {} }
  }

  function send(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  // The link carries the relay token, so it is shown, never put on the clipboard unasked; the
  // settings page keeps a copy (from the status) with a Copy button.
  function announceLink() {
    var link = shareLink(activeChatId);
    var bot = target && target.bot ? "Your Telegram bot lists this browser's chats too." : "";
    if (!link) {
      local({ type: "info", text: ["🛰 Remote ON — this browser's chats are on the relay as “Agent Browser”.", bot].filter(Boolean).join(" ") });
      return;
    }
    var lines = ["🛰 Remote ON — open this chat on your phone:", link, bot];
    if (isLoopback(target.publicUrl || target.url)) lines.push("(That address only works on this computer.)");
    lines.push("The link is also in the settings (🌐 → Remote), with a Copy button.");
    local({ type: "info", text: lines.filter(Boolean).join("\n") });
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
  var chats = []; // what presence lists (the newest 50)
  var knownChats = {}; // every id the host listed — a phone's link may name a chat deleted since
  var chatsKnown = false; // until the host sent its first list
  var activeChatId = null;
  var running = {}; // convId → true while a run is going

  function publishPresence() {
    send({ t: "presence", workspace: "Browser", chats: chats });
  }

  // ── Messages from relay clients (web app / Mini App) ───────────────────

  // Keyed by approval/question/confirm id, so they're safe to pass through from any chat.
  var PASS_THROUGH = { approvalResponse: 1, questionResponse: 1, confirmResponse: 1 };
  // Name their chat, so any chat may be the target.
  var BY_ID = { deleteConversation: 1, renameConversation: 1, pinConversation: 1 };
  // Act on whatever chat the panel shows — only honoured when that's the sender's chat. (The native
  // host answers regenerate/rewind with a notice; the built-in backend asks before a rewind — confirm.)
  var ACTIVE_CHAT_ONLY = { compact: 1, setModel: 1, setMode: 1, regenerate: 1, rewind: 1 };
  // Need a chat with content, which a fresh one has not.
  var NEEDS_CHAT = { compact: 1, regenerate: 1, rewind: 1 };

  // Clients that get a chat's events sent to them directly instead of through their channel: the web
  // app pins itself to the channel of the chat it opened (hub-shim.js), so when it presses "+" the
  // chat its next message creates streams to an id it never subscribed to. It follows that chat here
  // until it opens a chat from the list by itself. clientId → { chatId } (null until the host names it).
  var followers = {};

  // Uploads in flight, oldest first. The host's "attached" answers don't say whose upload they are, so
  // they're matched up in order (claimAttached); client is null for this panel's own uploads.
  var uploads = [];

  function replyError(clientId, message) {
    send({ t: "toClient", clientId: clientId, msg: { type: "error", message: message } });
  }
  // A notice leaves the phone's run state alone (an "error" would hide its Stop button while the chat still runs).
  function replyNotice(clientId, message) {
    send({ t: "toClient", clientId: clientId, msg: { type: "notice", message: message } });
  }

  // To the host exactly as the panel's own click would send it (the client's chatId is routing, not payload).
  function forward(msg) {
    var copy = Object.assign({}, msg);
    delete copy.chatId;
    toHost(copy);
  }

  // The host stops the chat the panel shows. For another chat, open it first and stop once the host
  // confirms the switch (loadConversation): the built-in backend opens chats asynchronously, so an
  // interrupt sent right behind openConversation could still hit the chat shown before.
  var pendingInterrupt = null; // { chatId, until }
  function interruptChat(chatId) {
    if (chatId === activeChatId) return toHost({ type: "interrupt" });
    pendingInterrupt = { chatId: chatId, until: Date.now() + 8000 };
    toHost({ type: "openConversation", id: chatId });
  }

  function handleRelayMessage(m) {
    if (!m || m.t !== "fromClient" || !m.msg || typeof m.msg.type !== "string" || typeof m.clientId !== "string") return;
    var msg = m.msg;
    var client = m.clientId;
    var chatId = typeof msg.chatId === "string" && msg.chatId ? msg.chatId : null;

    // A web client opened (or reconnected to) a chat: make it the active one.
    // The host answers with loadConversation, model, mode, conversations…,
    // which the mirror below forwards to that chat's channel.
    if (msg.type === "ready") {
      delete followers[client]; // it chose a chat itself and is subscribed to that channel now
      if (!chatId) return;
      if (chatsKnown && !knownChats[chatId] && chatId !== activeChatId && !running[chatId]) {
        return replyError(client, "This chat no longer exists in the browser — pick another one from the chat list.");
      }
      toHost({ type: "openConversation", id: chatId });
      return;
    }

    if (msg.type === "newChat") {
      // Like "+" in the panel: the browser shows a fresh chat, and so does the phone, which follows it from here.
      followers[client] = { chatId: null };
      toHost({ type: "newChat" });
      send({ t: "toClient", clientId: client, msg: { type: "clear" } });
      return;
    }

    // A follower's messages still carry the id of the chat it came from.
    var follow = followers[client];
    if (follow) chatId = follow.chatId;
    var onActive = chatId ? chatId === activeChatId : !!(follow && activeChatId === null);

    if (msg.type === "prompt") {
      var text = typeof msg.text === "string" ? msg.text.trim() : "";
      var atts = Array.isArray(msg.attachments) ? msg.attachments.filter(function (a) { return typeof a === "string" && a; }) : [];
      if (!text && !atts.length) return;
      if (!onActive) {
        return replyError(client, "This chat isn't open in the browser right now — reopen it from the chat list and resend.");
      }
      if (chatId && running[chatId]) {
        return replyNotice(client, "This chat is still working — wait for the reply or press Stop.");
      }
      // Straight to the host, not through the panel's input box: typing into
      // it would wipe the desktop user's draft and send their attachments
      // along. The panel gets the bubble the way it shows mirrored messages.
      local({ type: "user", text: text + (atts.length ? "\n📎 " + atts.length + (atts.length === 1 ? " attachment" : " attachments") : "") });
      toHost({ type: "prompt", text: text, attachments: atts });
      return;
    }

    if (msg.type === "interrupt") {
      if (chatId && running[chatId]) interruptChat(chatId); // the phone's Stop only shows while running
      return;
    }

    if (ACTIVE_CHAT_ONLY[msg.type]) {
      if (msg.type === "rewind" && typeof msg.userIndex !== "number") return;
      if (!onActive || (NEEDS_CHAT[msg.type] && !chatId)) {
        return replyNotice(client, "This chat isn't open in the browser right now — reopen it from the chat list first.");
      }
      return forward(msg);
    }

    if (BY_ID[msg.type]) {
      if (typeof msg.id !== "string" || !msg.id) return;
      if (msg.type === "deleteConversation" && msg.id === chatId) {
        // It deleted the chat it was looking at: like "+", it is on a fresh chat from here.
        followers[client] = { chatId: null };
        send({ t: "toClient", clientId: client, msg: { type: "clear" } });
      }
      return forward(msg);
    }

    if (PASS_THROUGH[msg.type]) return forward(msg);

    if (msg.type === "uploadAttachment") {
      if (typeof msg.dataUrl !== "string") return;
      uploads.push({ client: client, at: Date.now() });
      forward(msg);
    }
  }

  /** shim.js asks before showing an "attached" chip here: a phone's upload goes to that phone instead. */
  function claimAttached(m) {
    var now = Date.now();
    while (uploads.length && now - uploads[0].at > 60000) uploads.shift(); // an upload the host rejected silently
    var u = uploads.shift();
    if (!u || !u.client) return false;
    send({ t: "toClient", clientId: u.client, msg: m });
    return true;
  }

  // ── Mirror: what the host shows in the panel → that chat's subscribers ─

  var STREAM_TYPES = {
    started: 1, text: 1, thinking: 1, tool: 1, toolResult: 1, result: 1, idle: 1, error: 1, info: 1, notice: 1,
    approval: 1, approvalResolved: 1, question: 1, questionResolved: 1, confirm: 1, confirmResolved: 1,
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
    emit(p.chatId, { type: p.type, text: p.text });
  }

  function emit(chatId, ev) {
    send({ t: "event", chatId: chatId, ev: ev });
    for (var c in followers) {
      if (followers[c].chatId === chatId) send({ t: "toClient", clientId: c, msg: ev });
    }
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
    emit(chatId, ev);
  }

  // The host named the chat it just created for a prompt sent to a fresh one: it is the open chat,
  // and the phones that pressed "+" follow it.
  function freshChat(id) {
    activeChatId = id;
    knownChats[id] = true;
    for (var c in followers) if (followers[c].chatId === null) followers[c].chatId = id;
  }

  window.addEventListener("message", function (ev) {
    var d = ev.data;
    if (!d || typeof d.type !== "string" || d.__local) return;

    // Track the panel's state first — even while disconnected, so a later
    // connect (or the Telegram bot) knows the chats and which one is open.
    if (d.type === "runState" && typeof d.convId === "string") {
      if (d.running) running[d.convId] = true;
      else delete running[d.convId];
      // The native host names a chat created by a prompt here first (its list follows when the run ends).
      if (d.running && activeChatId === null && !knownChats[d.convId]) freshChat(d.convId);
    } else if (d.type === "loadConversation" && typeof d.convId === "string") {
      // Posted for the chat that's becoming active, before "conversations" says so.
      activeChatId = d.convId;
      if (pendingInterrupt && pendingInterrupt.chatId === d.convId && Date.now() < pendingInterrupt.until) {
        pendingInterrupt = null;
        toHost({ type: "interrupt" });
      }
    } else if (d.type === "clear") {
      activeChatId = null; // new chat / current one deleted — nothing open to mirror
    } else if (d.type === "conversations") {
      var active = typeof d.activeId === "string" ? d.activeId : null;
      if (active && activeChatId === null && !knownChats[active]) freshChat(active);
      else activeChatId = active;
      if (Array.isArray(d.items)) {
        chatsKnown = true;
        knownChats = {};
        d.items.forEach(function (c) { knownChats[String(c.id)] = true; });
        chats = d.items.slice(0, 50).map(function (c) {
          return { id: String(c.id), title: String(c.title || c.id) };
        });
        if (connected) publishPresence();
      }
    }
    refreshLink();

    if (!connected || !STREAM_TYPES[d.type]) return;
    // runState names its chat (it may be a background one); the rest belongs to the open chat.
    var chatId = typeof d.convId === "string" ? d.convId : activeChatId;
    if (!chatId) {
      // Nothing is open: only the phones on the fresh chat (followers waiting for its id) share this
      // view — they get the chat list, model and mode the panel shows.
      for (var c in followers) if (followers[c].chatId === null) send({ t: "toClient", clientId: c, msg: d });
      return;
    }
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
    if (fromRemote || !msg) return;
    // This panel's own uploads keep their chip here (see claimAttached).
    if (msg.type === "uploadAttachment" || msg.type === "pasteImage") uploads.push({ client: null, at: Date.now() });
    if (!connected || !activeChatId || msg.type !== "prompt" || typeof msg.text !== "string") return;
    mirror(activeChatId, { type: "user", text: msg.text });
  });

  // ── Status: 🛰 button + options page ───────────────────────────────────

  var remoteBtn = document.getElementById("remoteBtn");
  var shown = { state: "off", message: "", link: "" }; // what 🛰 and the options page show now

  // `persist`: also publish to the options page (chrome.storage.session). Default: only the panel that
  // runs remote (holds the lock) may — a second window loading or waiting must not overwrite it.
  // The published status carries the open chat's web-app link, so the options page can offer it.
  function updateStatus(state, message, persist) {
    if (persist === undefined) persist = !!(session && session.release) || !navigator.locks;
    shown = { state: state, message: message || "", link: state === "on" && target ? shareLink(activeChatId) : "" };
    if (persist) chrome.storage.session.set({ [STATUS_KEY]: shown }).catch(function () {});
    if (!remoteBtn) return;
    remoteBtn.classList.toggle("on", state === "on");
    remoteBtn.setAttribute("aria-pressed", state === "on" ? "true" : "false");
    remoteBtn.title =
      state === "on" ? "Remote ON — " + message + ". Click to stop." :
      state === "error" ? "Remote: " + message :
      message ? "Remote: " + message :
      "Remote: continue this browser's chats from your phone / Telegram";
  }

  // The link names the open chat: re-publish when that changes while remote is on.
  function refreshLink() {
    if (shown.state === "on" && target && shareLink(activeChatId) !== shown.link) updateStatus("on", shown.message);
  }

  function openRemoteSettings() {
    chrome.tabs.create({ url: chrome.runtime.getURL("options.html#remote") });
  }

  if (remoteBtn) {
    remoteBtn.addEventListener("click", function () {
      loadConfig().then(function (c) {
        return isOn(c).then(function (on) {
          if (session || on) {
            // On, starting, retrying or waiting in another window → off everywhere, until 🛰 again or a restart.
            stopSession();
            return setOn(false);
          }
          if (!configured(c)) return openRemoteSettings();
          announce = true;
          reportedFailure = false;
          // Every panel's storage listener syncs; this one also syncs right away.
          return setOn(true).then(sync);
        });
      });
    });
  }

  // Settings changed on the options page, or remote toggled in another panel.
  chrome.storage.onChanged.addListener(function (ch, area) {
    if ((area === "local" && ch[CONFIG_KEY]) || (area === "session" && ch[ON_KEY])) sync();
  });

  updateStatus("off", "", false);
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
    claimAttached: claimAttached,
  };
})();
