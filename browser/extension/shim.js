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
    // A file a phone uploaded through relay.js belongs in that phone's composer, not this one's.
    if (ev && ev.type === "attached" && window.AgentRemote && window.AgentRemote.claimAttached && window.AgentRemote.claimAttached(ev)) return;
    // Both backends name the assistant; the brand this build carries decides what the panel shows.
    if (ev && ev.type === "identity" && window.AGENT_BRAND && window.AGENT_BRAND.shortName) ev = Object.assign({}, ev, { name: window.AGENT_BRAND.shortName });
    window.dispatchEvent(new MessageEvent("message", { data: ev }));
  }

  // Words for what a tool call would act on (the element behind a ref), for approval cards.
  function describeCall(name, input) {
    var T = window.AgentBrowserTools;
    if (!T || typeof T.describe !== "function") return "";
    try {
      return T.describe(String(name || "").replace(/^mcp__browser__/, ""), input) || "";
    } catch (e) {
      return "";
    }
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
    if (m.type === "approval" && m.input && !m.input.element) {
      // The host knows refs, not what they point at: "click [7]" tells the user (and the phone)
      // nothing. Put the element's words on the card, as the built-in backend does itself.
      var element = describeCall(m.toolName, m.input);
      if (element) m = Object.assign({}, m, { input: Object.assign({}, m.input, { element: element }) });
    }
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
    if (failures > 0) port.postMessage(withBrand({ type: "ready" }));
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
  // "ready" tells the host which features this brand build has, so the model gets only their tools.
  function withBrand(m) {
    if (!m || m.type !== "ready" || !window.AGENT_BRAND) return m;
    return Object.assign({}, m, { brand: window.AGENT_BRAND.id, features: window.AGENT_BRAND.features });
  }
  function postMessage(m) {
    m = withBrand(m);
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

  // Files dropped on the panel: the shared UI's drop handler only knows file:// paths from an
  // editor, which a browser never hands over, so read the dropped files here and upload them the
  // way the 📎 button does. Without preventDefault the browser would open the file in the panel.
  document.addEventListener("dragover", function (e) {
    var types = e.dataTransfer && e.dataTransfer.types;
    if (types && Array.prototype.indexOf.call(types, "Files") !== -1) e.preventDefault();
  });
  document.addEventListener("drop", function (e) {
    var files = e.dataTransfer && e.dataTransfer.files;
    if (!files || !files.length) return;
    e.preventDefault();
    Array.prototype.forEach.call(files, function (f) {
      var reader = new FileReader();
      reader.onload = function () { postMessage({ type: "uploadAttachment", name: f.name, dataUrl: reader.result }); };
      reader.readAsDataURL(f);
    });
  });

  // Decide the backend before the first message goes anywhere (main.js posts
  // "ready" immediately; it waits in the outbox until then). The body class
  // lets sidepanel.css hide controls one backend has no answer for.
  function useBackend(which) {
    backend = which;
    document.body.classList.add("backend-" + which);
    if (which === "local") {
      local = window.AgentLocal.create(deliver);
      flush();
    } else {
      connectNative();
    }
  }
  var keyCheck = window.AgentLocal ? window.AgentLocal.backend() : Promise.resolve("native");
  keyCheck.then(
    function (which) { useBackend(which === "local" ? "local" : "native"); },
    function () { useBackend("native"); }
  );
})();
