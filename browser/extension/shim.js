// Bridge that lets the unmodified VS Code webview bundle (main.js) run in the
// browser side panel. main.js talks to its host via acquireVsCodeApi()
// .postMessage(...) and window "message" events — we reimplement that surface
// and route it to one of two backends:
//
//  - built-in (an API key is set): agentLocal.js runs the agent right here in
//    the extension, straight against the Claude API. Nothing else to install.
//  - native host (no key): a local process started through native messaging
//    that runs the agent on the user's Claude subscription (installer needed);
//    it also carries that mode's browser tool calls, which run here via
//    AgentBrowserTools.
(function () {
  // Attach files with the browser's own file picker + byte upload (there is no
  // editor dialog to open).
  window.__AGENT_REMOTE__ = true;

  var HOST = "com.kari.agent_browser";
  var API_KEY = "agentApi"; // chrome.storage.local: { apiKey, baseUrl, effort }

  var backend = null; // "local" | "native" — undecided until the key check finishes
  var local = null;
  var port = null;
  var outbox = [];
  var chunks = {};
  var failures = 0;
  var gaveUp = false;

  function deliver(ev) {
    window.dispatchEvent(new MessageEvent("message", { data: ev }));
  }

  var SETUP_BANNER = {
    type: "auth",
    ok: false,
    text: "⚠ Set up the agent: add an API key (works right here), or install the local host to use your Claude subscription:",
    loginLabel: "Open settings",
    recheckLabel: "I've done it",
  };

  function send(msg) {
    if (msg && msg.type === "login" && backend !== "local" && (gaveUp || !port)) {
      // No host to open a terminal — the only way forward is the settings page.
      chrome.runtime.openOptionsPage();
      return;
    }
    if (backend === "native" && gaveUp && msg) {
      // Nothing is listening: say so instead of swallowing the message into a queue nobody reads.
      if (msg.type === "recheckAuth") location.reload();
      else if (msg.type === "prompt") {
        deliver(SETUP_BANNER);
        deliver({ type: "error", message: "The agent isn't set up yet. Open the settings (🌐) and pick the free trial, add an API key, or install the local host." });
        deliver({ type: "idle" });
      }
      return;
    }
    if (backend === "local") local.handle(msg);
    else if (backend === "native" && port) port.postMessage(msg);
    else outbox.push(msg);
  }

  function flush() {
    var pending = outbox.splice(0);
    for (var i = 0; i < pending.length; i++) send(pending[i]);
  }

  function runTool(call) {
    window.AgentBrowserTools.run(call.name, call.args || {}).then(
      function (content) {
        send({ type: "browserToolResult", id: call.id, content: content, isError: false });
      },
      function (err) {
        send({
          type: "browserToolResult",
          id: call.id,
          content: [{ type: "text", text: String((err && err.message) || err) }],
          isError: true,
        });
      }
    );
  }

  function onHostMessage(m) {
    if (!m || typeof m !== "object") return;
    if (m.type === "__chunk") {
      // Oversized host messages arrive split (native messaging caps at 1 MB).
      var parts = chunks[m.id] || (chunks[m.id] = []);
      parts[m.i] = m.data;
      var have = 0;
      for (var i = 0; i < parts.length; i++) if (parts[i] !== undefined) have++;
      if (have === m.total) {
        delete chunks[m.id];
        onHostMessage(JSON.parse(parts.join("")));
      }
      return;
    }
    if (m.type === "browserTool") return runTool(m);
    deliver(m);
  }

  function connectNative() {
    try {
      port = chrome.runtime.connectNative(HOST);
    } catch (e) {
      port = null;
      return fail(String((e && e.message) || e));
    }
    port.onMessage.addListener(function (m) {
      failures = 0; // a live host resets the reconnect budget
      onHostMessage(m);
    });
    port.onDisconnect.addListener(function () {
      var reason = (chrome.runtime.lastError && chrome.runtime.lastError.message) || "host exited";
      port = null;
      fail(reason);
    });
    flush();
    // Re-hydrate state after a reconnect; the first "ready" comes from main.js.
    if (failures > 0) port.postMessage({ type: "ready" });
  }

  function fail(reason) {
    if (gaveUp) return;
    if (/not found|forbidden/i.test(reason)) {
      gaveUp = true;
      deliver(SETUP_BANNER);
      deliver({
        type: "error",
        message:
          "No API key is set and the local agent host isn't installed (" + reason + "). " +
          "Open the settings (🌐) and paste an Anthropic API key to start right away.",
      });
      return;
    }
    failures++;
    if (failures > 3) {
      gaveUp = true;
      deliver({ type: "error", message: "Agent host keeps stopping: " + reason + ". Reopen the panel to retry." });
      return;
    }
    deliver({ type: "idle" });
    setTimeout(connectNative, 800 * failures);
  }

  // The surface main.js sees as the VS Code API. Every outgoing message is also
  // announced as an "agent:outgoing" event, so relay.js can mirror prompts typed
  // here to the phone (the UI draws its own bubble; the host doesn't echo it).
  var saved = {};
  function postMessage(m) {
    try { window.dispatchEvent(new CustomEvent("agent:outgoing", { detail: m })); } catch (_) {}
    send(m);
  }
  window.acquireVsCodeApi = function () {
    return {
      postMessage: postMessage,
      getState: function () { return saved; },
      setState: function (s) { saved = s; return s; },
    };
  };

  // Proxy button (not part of the shared UI): opens the settings page and
  // shows whether a proxy is on for this profile.
  var proxyBtn = document.getElementById("proxyBtn");
  if (proxyBtn) {
    proxyBtn.addEventListener("click", function () { chrome.runtime.openOptionsPage(); });
    var paint = function (s) {
      s = s || { state: "off" };
      proxyBtn.dataset.state = s.state;
      proxyBtn.title =
        s.state === "active" ? "Proxy on — " + s.message :
        s.state === "error" ? "Proxy problem — " + s.message :
        "Settings: API key, proxy";
    };
    chrome.storage.session.get("agentProxyStatus").then(function (o) { paint(o.agentProxyStatus); });
    chrome.storage.onChanged.addListener(function (ch, area) {
      if (area === "session" && ch.agentProxyStatus) paint(ch.agentProxyStatus.newValue);
    });
  }

  // Adding or removing the API key switches backends: start over on the other one.
  chrome.storage.onChanged.addListener(function (ch, area) {
    if (area !== "local" || !ch[API_KEY] || !window.AgentLocal) return;
    window.AgentLocal.backend().then(function (which) {
      var now = which === "local" ? "local" : "native";
      if (backend && now !== backend) location.reload();
      // Same backend but the key/mode changed enough to matter (e.g. key added while on the setup banner):
      var o = ch[API_KEY].oldValue || {}, n = ch[API_KEY].newValue || {};
      if (backend === "local" && (o.mode !== n.mode || o.apiKey !== n.apiKey)) location.reload();
    });
  });

  // Decide the backend before the first message goes anywhere (main.js posts
  // "ready" immediately; it waits in the outbox until then).
  var keyCheck = window.AgentLocal ? window.AgentLocal.backend() : Promise.resolve("native");
  keyCheck.then(
    function (which) {
      if (which === "local") {
        backend = "local";
        local = window.AgentLocal.create(deliver);
        flush();
      } else {
        backend = "native";
        connectNative();
      }
    },
    function () {
      backend = "native";
      connectNative();
    }
  );
})();
