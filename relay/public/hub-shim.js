// Bridge that lets the unmodified VS Code webview bundle (main.js) run in a plain
// browser tab against the relay. main.js talks to its host via acquireVsCodeApi()
// .postMessage(...) and window "message" events — we reimplement that surface on
// top of a WebSocket to the relay, so the same UI/render code works as-is.
(function () {
  // Tell the shared UI bundle it's running remotely (browser / Telegram), so it
  // attaches files via a LOCAL file picker + byte upload instead of asking the
  // host to open a VS Code dialog on the far-away desktop.
  window.__AGENT_REMOTE__ = true;
  var qs = new URLSearchParams(location.search);
  var token = qs.get("token") || "";
  var nodeId = qs.get("node") || "";
  var chatId = qs.get("chat") || "";
  var proto = location.protocol === "https:" ? "wss" : "ws";
  var cid = "web-" + Math.random().toString(36).slice(2, 8);
  var url =
    proto + "://" + location.host + "/?token=" + encodeURIComponent(token) +
    "&role=client&id=" + cid + "&name=web";

  var ws = null;
  var outbox = [];
  var saved = {};

  function deliver(ev) {
    // Feed an event into main.js's existing window "message" handler unchanged.
    window.dispatchEvent(new MessageEvent("message", { data: ev }));
  }
  function sendUp(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
    else outbox.push(obj);
  }

  // The shim main.js sees as the VS Code API.
  window.acquireVsCodeApi = function () {
    return {
      postMessage: function (m) {
        // main.js announces itself with "ready" on load; the shim already sends one per connection
        // (onopen), and a second makes the node reload the chat twice.
        if (m && m.type === "ready") return;
        // Switching chats from the web (tab click / chat list): the web session
        // is pinned to ONE chat channel, so move our subscription to the new
        // chat and ask the host to (re)send its full state there. Without this,
        // tab-switching does nothing in the browser (events keep flowing to the
        // old channel we're no longer interested in).
        if (m && m.type === "openConversation" && m.id && m.id !== chatId) {
          if (ws && ws.readyState === 1) {
            ws.send(JSON.stringify({ t: "unsubscribe", channel: nodeId + ":" + chatId }));
          }
          chatId = m.id;
          sendUp({ t: "subscribe", channel: nodeId + ":" + chatId });
          sendUp({ t: "toNode", nodeId: nodeId, msg: { type: "ready", chatId: chatId } });
          return;
        }
        sendUp({ t: "toNode", nodeId: nodeId, msg: Object.assign({ chatId: chatId }, m) });
      },
      getState: function () { return saved; },
      setState: function (s) { saved = s; return s; },
    };
  };

  var reconnectDelay = 1500;
  var authFailed = false;
  function connect() {
    if (authFailed) return; // a rejected token won't fix itself — stop hammering
    ws = new WebSocket(url);
    ws.onopen = function () {
      reconnectDelay = 1500; // healthy connection resets the backoff
      ws.send(JSON.stringify({ t: "subscribe", channel: nodeId + ":" + chatId }));
      // Ask the owning node to (re)send this chat's state.
      sendUp({ t: "toNode", nodeId: nodeId, msg: { type: "ready", chatId: chatId } });
      var pending = outbox.splice(0);
      for (var i = 0; i < pending.length; i++) ws.send(JSON.stringify(pending[i]));
    };
    ws.onmessage = function (e) {
      var m;
      try { m = JSON.parse(e.data); } catch (_) { return; }
      if (m.t === "event") deliver(m.ev);            // live stream for this chat
      else if (m.t === "fromNode") deliver(m.msg);   // direct reply (e.g. history)
      // The terse pre-close "auth" is superseded by the friendly onclose(4001)
      // message — drop it so the user sees one clear line, not two.
      else if (m.t === "error" && m.message !== "auth")
        deliver({ type: "error", message: "relay: " + m.message });
    };
    ws.onclose = function (ev) {
      // 4001 = the relay rejected our token. Reconnecting can't help — show ONE
      // clear message instead of flooding the log with "relay: auth" forever.
      if (ev && ev.code === 4001) {
        if (!authFailed) {
          authFailed = true;
          deliver({
            type: "error",
            message:
              "relay: auth failed — open this page from the Telegram bot or a fresh share link (the token is missing or expired).",
          });
        }
        return;
      }
      // Everything else: reconnect with capped exponential backoff.
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(Math.round(reconnectDelay * 1.6), 15000);
    };
    ws.onerror = function () { try { ws.close(); } catch (_) {} };
  }
  // Defer the first connect to the next tick: main.js loads in the <script> AFTER
  // this one, so its window "message" listener isn't attached yet. Without the
  // defer, an immediate 4001 (bad token) delivers its error into the void.
  setTimeout(connect, 0);
})();
