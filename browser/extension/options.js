(function () {
  var CONFIG_KEY = "agentProxy";
  var STATUS_KEY = "agentProxyStatus";
  var HOST = "com.kari.agent_browser";
  var $ = function (id) { return document.getElementById(id); };

  function read() {
    return {
      enabled: $("enabled").checked,
      type: $("type").value,
      host: $("host").value.trim(),
      port: Number($("port").value) || 0,
      username: $("username").value,
      password: $("password").value,
      bypass: $("bypass").value.trim(),
      blockThirdPartyCookies: $("blockCookies").checked,
    };
  }

  function write(c) {
    c = c || {};
    $("enabled").checked = !!c.enabled;
    $("type").value = c.type || "http";
    $("host").value = c.host || "";
    $("port").value = c.port || "";
    $("username").value = c.username || "";
    $("password").value = c.password || "";
    $("bypass").value = c.bypass || "";
    $("blockCookies").checked = !!c.blockThirdPartyCookies;
    syncEnabled();
  }

  function syncEnabled() {
    ["type", "host", "port", "username", "password", "bypass", "blockCookies"].forEach(function (id) {
      $(id).disabled = !$("enabled").checked;
    });
  }

  function showStatus(s) {
    s = s || { state: "off" };
    var el = $("status");
    el.className = "status " + s.state;
    $("statusText").textContent =
      s.state === "active" ? "Proxy is on — " + s.message :
      s.state === "error" ? "Proxy problem — " + s.message :
      "Proxy is off";
  }

  function say(text, cls) {
    var r = $("testResult");
    r.textContent = text;
    r.className = "result " + (cls || "");
  }

  // The test runs in the native host, so it checks the proxy itself (login,
  // reachability, the address sites will see) regardless of the browser.
  function testViaHost(c) {
    return new Promise(function (resolve) {
      var port;
      try {
        port = chrome.runtime.connectNative(HOST);
      } catch (e) {
        return resolve({ ok: false, message: "The agent host isn't installed — run the installer first." });
      }
      var done = false;
      function finish(r) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { port.disconnect(); } catch (_) {}
        resolve(r);
      }
      var timer = setTimeout(function () { finish({ ok: false, message: "Timed out." }); }, 40000);
      port.onMessage.addListener(function (m) {
        if (m && m.type === "proxyTestResult") finish(m.result);
      });
      port.onDisconnect.addListener(function () {
        finish({ ok: false, message: "The agent host isn't running (" + ((chrome.runtime.lastError && chrome.runtime.lastError.message) || "no reason given") + ")." });
      });
      port.postMessage({
        type: "proxyTest",
        id: 1,
        upstream: {
          // HTTPS proxies are dialled as plain HTTP CONNECT proxies by the host test.
          type: c.type === "socks5" ? "socks5" : "http",
          host: c.host, port: c.port, username: c.username, password: c.password,
        },
      });
    });
  }

  $("enabled").addEventListener("change", syncEnabled);

  // ---- named proxy presets ("saved proxies") ----
  var PRESETS_KEY = "agentProxyPresets";

  function sayPreset(text2, cls) {
    var r = $("presetResult");
    r.textContent = text2;
    r.className = "result " + (cls || "");
  }

  function loadPresets() {
    return chrome.storage.local.get(PRESETS_KEY).then(function (o) { return o[PRESETS_KEY] || []; });
  }

  function savePresets(list) {
    return chrome.storage.local.set({ [PRESETS_KEY]: list });
  }

  function paintPresets(list) {
    var sel = $("presetSelect");
    var kept = sel.value;
    sel.innerHTML = '<option value="">— pick a saved proxy —</option>';
    list.forEach(function (p) {
      var o = document.createElement("option");
      o.value = p.id;
      o.textContent = p.name + " (" + p.type + "://" + p.host + ":" + p.port + ")";
      sel.appendChild(o);
    });
    if (kept && list.some(function (p) { return p.id === kept; })) sel.value = kept;
  }

  function refreshPresets() {
    return loadPresets().then(paintPresets);
  }

  function randomId() {
    return "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  $("presetSave").addEventListener("click", function () {
    var name = $("presetName").value.trim();
    if (!name) return sayPreset("Give it a name first.", "bad");
    var c = read();
    c.enabled = true;
    var p = AgentProxyConfig.validate(c);
    if (p) return sayPreset(p, "bad");
    loadPresets().then(function (list) {
      var existing = list.find(function (x) { return x.name.toLowerCase() === name.toLowerCase(); });
      var entry = Object.assign({ id: existing ? existing.id : randomId(), name: name }, c);
      var next = existing ? list.map(function (x) { return x.id === entry.id ? entry : x; }) : list.concat([entry]);
      return savePresets(next).then(function () {
        paintPresets(next);
        $("presetSelect").value = entry.id;
        sayPreset((existing ? "Updated “" : "Saved “") + name + "”.", "ok");
      });
    });
  });

  $("presetLoad").addEventListener("click", function () {
    var id = $("presetSelect").value;
    if (!id) return sayPreset("Pick a saved proxy first.", "bad");
    loadPresets().then(function (list) {
      var p = list.find(function (x) { return x.id === id; });
      if (!p) return sayPreset("That saved proxy is gone.", "bad");
      write(p);
      $("presetName").value = p.name;
      sayPreset("Loaded “" + p.name + "” into the fields below — press Save to switch to it.", "ok");
    });
  });

  $("presetDelete").addEventListener("click", function () {
    var id = $("presetSelect").value;
    if (!id) return sayPreset("Pick a saved proxy first.", "bad");
    loadPresets().then(function (list) {
      var p = list.find(function (x) { return x.id === id; });
      var next = list.filter(function (x) { return x.id !== id; });
      return savePresets(next).then(function () {
        paintPresets(next);
        sayPreset(p ? "Deleted “" + p.name + "”." : "Deleted.", "ok");
      });
    });
  });

  refreshPresets();

  // ---- private sessions: reflect whether Chrome allows this extension in Incognito ----
  if (chrome.extension && chrome.extension.isAllowedIncognitoAccess) {
    chrome.extension.isAllowedIncognitoAccess().then(function (allowed) {
      var el = $("incognitoStatus");
      el.className = "status " + (allowed ? "active" : "error");
      $("incognitoStatusText").textContent = allowed
        ? "Allowed — the agent can open private windows."
        : "Not allowed yet — turn it on at chrome://extensions (" + ((window.AGENT_BRAND && window.AGENT_BRAND.shortName) || "Tali") + " → Details).";
    });
  }

  $("form").addEventListener("submit", function (e) {
    e.preventDefault();
    var c = read();
    var p = AgentProxyConfig.validate(c);
    if (p) return say(p, "bad");
    chrome.storage.local.set({ [CONFIG_KEY]: c }).then(function () {
      say(c.enabled ? "Saved — applying…" : "Saved — proxy is off.", "ok");
    });
  });

  $("test").addEventListener("click", function () {
    var c = read();
    c.enabled = true;
    var p = AgentProxyConfig.validate(c);
    if (p) return say(p, "bad");
    if (c.type === "https") return say("Testing HTTPS-to-proxy connections isn't supported here; Save and browse to check.", "");
    $("test").disabled = true;
    say("Testing…", "");
    testViaHost(c).then(function (r) {
      $("test").disabled = false;
      say(r.message, r.ok ? "ok" : "bad");
    });
  });

  // ---- how the agent runs: free trial / own API key / Claude subscription ----
  var API_KEY = "agentApi";
  var trialOk = !!(window.AgentLocal && window.AgentLocal.trialConfigured);

  function chosenMode() {
    var r = document.querySelector('input[name="mode"]:checked');
    return r ? r.value : "";
  }

  function showFields() {
    var m = chosenMode();
    $("trialFields").classList.toggle("open", m === "trial");
    $("apiFields").classList.toggle("open", m === "api");
    $("subFields").classList.toggle("open", m === "subscription");
  }

  function readKey() {
    return {
      mode: chosenMode(),
      apiKey: $("apiKey").value.trim(),
      effort: $("effort").value,
      workspaceId: $("workspaceId").value.trim(),
      baseUrl: $("baseUrl").value.trim(),
    };
  }

  function sayTo(id, text, cls) {
    var r = $(id);
    r.textContent = text;
    r.className = "result " + (cls || "");
  }

  function validBase(u) {
    try {
      var x = new URL(u);
      return x.protocol === "https:" || (x.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].indexOf(x.hostname) !== -1);
    } catch (_) { return false; }
  }

  var savedMode = "";
  function paintAgent(mode) {
    savedMode = mode;
    var el = $("agentStatus");
    el.className = "status " + (mode ? "active" : "off");
    $("agentStatusText").textContent = {
      trial: "Running on the free trial.",
      api: "Running with your API key, inside this extension.",
      subscription: "Running on your Claude subscription through the local helper.",
    }[mode] || "Not set up yet — pick one below.";
  }

  function refreshTrial() {
    if (!trialOk) {
      $("modeTrial").classList.add("disabled");
      $("modeTrial").querySelector("input").disabled = true;
      $("trialStatus").textContent = "Not available in this build.";
      return;
    }
    window.AgentLocal.trialAccount().then(function (acc) {
      paintTrialAccount(acc);
      if (!acc) {
        $("trialStatus").textContent = "Sign in with your email to start.";
        if (savedMode === "trial") $("agentStatusText").textContent = "Free trial chosen — sign in with your email below.";
        return;
      }
      $("trialStatus").textContent = "Checking allowance…";
      window.AgentLocal.trialStatus().then(function (r) {
        $("trialStatus").textContent = r.message;
        if (r.signedOut) refreshTrial(); // the gateway dropped the token: show the sign-in again
      });
    });
  }

  // ---- free trial: sign in with a code from the email ----
  function paintTrialAccount(acc) {
    $("trialEmailRow").hidden = !!acc;
    $("trialSendRow").hidden = !!acc;
    $("trialCodeRow").hidden = true;
    $("trialVerifyRow").hidden = true;
    $("trialIn").hidden = !acc;
    $("trialWho").textContent = acc ? acc.email : "";
    $("trialSend").textContent = "Send code";
  }

  $("trialSend").addEventListener("click", function () {
    var email = $("trialEmail").value.trim();
    if (!email) return sayTo("trialResult", "Enter your email.", "bad");
    $("trialSend").disabled = true;
    sayTo("trialResult", "Sending…", "");
    window.AgentLocal.trialStart(email).then(function (r) {
      $("trialSend").disabled = false;
      sayTo("trialResult", r.message, r.ok ? "ok" : "bad");
      if (!r.ok) return;
      $("trialCodeRow").hidden = false;
      $("trialVerifyRow").hidden = false;
      $("trialSend").textContent = "Send again";
      $("trialCode").focus();
    });
  });

  $("trialVerify").addEventListener("click", function () {
    var code = $("trialCode").value.replace(/\s+/g, "");
    if (!/^\d{6}$/.test(code)) return sayTo("trialResult", "Enter the 6-digit code from the email.", "bad");
    $("trialVerify").disabled = true;
    sayTo("trialResult", "Checking…", "");
    window.AgentLocal.trialVerify($("trialEmail").value.trim(), code).then(function (r) {
      $("trialVerify").disabled = false;
      sayTo("trialResult", r.message, r.ok ? "ok" : "bad");
      if (!r.ok) return;
      $("trialCode").value = "";
      // Signing in is choosing the trial: save that, keeping the rest of what's on file (an API key stays).
      chrome.storage.local.get(API_KEY).then(function (o) {
        var s = o[API_KEY] || {};
        s.mode = "trial";
        return chrome.storage.local.set({ [API_KEY]: s });
      }).then(function () {
        var radio = document.querySelector('input[name="mode"][value="trial"]');
        if (radio) radio.checked = true;
        showFields();
        paintAgent("trial");
        refreshTrial();
      });
    });
  });

  $("trialSignOut").addEventListener("click", function () {
    window.AgentLocal.trialSignOut().then(function () {
      sayTo("trialResult", "Signed out.", "");
      refreshTrial();
    });
  });

  // Enter in these fields means their button, not "save the whole form".
  [["trialEmail", "trialSend"], ["trialCode", "trialVerify"]].forEach(function (pair) {
    $(pair[0]).addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); $(pair[1]).click(); }
    });
  });

  // The local helper, reached through native messaging: alive? signed in?
  function hostSession(onMessage, onGone) {
    var port;
    try { port = chrome.runtime.connectNative(HOST); } catch (e) { onGone("The local helper isn't installed."); return null; }
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(function () {
      onGone((chrome.runtime.lastError && chrome.runtime.lastError.message) || "The local helper isn't running.");
    });
    return port;
  }

  function hostCheck(cb) {
    var done = false;
    var port = hostSession(
      function (m) { if (m && m.type === "hostPong" && !done) { done = true; port.disconnect(); cb(null, m); } },
      function (why) { if (!done) { done = true; cb(/not found|forbidden|installed/i.test(why) ? "The local helper isn't installed yet — run the command below in PowerShell, then check again." : why); } }
    );
    if (port) port.postMessage({ type: "hostPing", id: 1 });
  }

  function paintHost(err, m) {
    $("hostStatus").textContent = err
      ? "✗ " + err
      : m.loggedIn
        ? "✓ The helper is running and Claude Code is signed in."
        : "The helper is running, but Claude Code isn't signed in yet — press “Sign in to Claude”.";
  }

  $("hostCheck").addEventListener("click", function () {
    $("hostStatus").textContent = "Checking…";
    hostCheck(paintHost);
  });

  $("hostLogin").addEventListener("click", function () {
    $("hostStatus").textContent = "Opening the Claude sign-in… finish it in the window/browser that appears.";
    var stop = false;
    var port = hostSession(
      function (m) {
        if (m && m.type === "auth" && m.ok) { stop = true; $("hostStatus").textContent = "✓ Signed in to Claude."; setTimeout(function () { try { port.disconnect(); } catch (_) {} }, 500); }
      },
      function (why) { if (!stop) $("hostStatus").textContent = "✗ " + (/not found|forbidden|installed/i.test(why) ? "The local helper isn't installed yet — run the command below first." : why); }
    );
    if (port) {
      port.postMessage({ type: "login" });
      setTimeout(function () { if (!stop) { try { port.disconnect(); } catch (_) {} } }, 5 * 60 * 1000);
    }
  });

  $("copyInstall").addEventListener("click", function () {
    var v = $("installCmd").value;
    (navigator.clipboard ? navigator.clipboard.writeText(v) : Promise.reject()).then(
      function () { sayTo("modeResult", "Command copied.", "ok"); },
      function () { $("installCmd").select(); sayTo("modeResult", "Press Ctrl+C to copy.", ""); }
    );
  });

  document.querySelectorAll('input[name="mode"]').forEach(function (r) { r.addEventListener("change", showFields); });

  chrome.storage.local.get(API_KEY).then(function (o) {
    var s = o[API_KEY] || {};
    $("apiKey").value = s.apiKey || "";
    $("effort").value = s.effort || "medium";
    $("workspaceId").value = s.workspaceId || "";
    $("baseUrl").value = s.baseUrl || "";
    var mode = s.mode || (s.apiKey ? "api" : trialOk ? "trial" : "subscription");
    var radio = document.querySelector('input[name="mode"][value="' + mode + '"]');
    if (radio && !radio.disabled) radio.checked = true;
    paintAgent(mode === "trial" && !trialOk ? "" : mode);
    showFields();
    refreshTrial();
    if (mode === "subscription") hostCheck(paintHost);
  });

  $("modeForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var k = readKey();
    if (!k.mode) return sayTo("modeResult", "Pick one of the three.", "bad");
    if (k.mode === "api") {
      if (!k.apiKey) return sayTo("modeResult", "Paste your API key, or pick another option.", "bad");
      if (k.baseUrl && !validBase(k.baseUrl)) return sayTo("modeResult", "The API address must start with https:// (http:// only for localhost).", "bad");
    }
    // Keep the key on file when another mode is chosen, so switching back doesn't lose it.
    chrome.storage.local.set({ [API_KEY]: k }).then(function () {
      paintAgent(k.mode);
      sayTo("modeResult", "Saved — reopen the side panel if it was open.", "ok");
      if (k.mode === "trial") refreshTrial(); // says so when the trial still needs a sign-in
    });
  });

  $("testKey").addEventListener("click", function () {
    var k = readKey();
    $("testKey").disabled = true;
    sayTo("keyResult", "Testing…", "");
    window.AgentLocal.testKey(k).then(function (r) {
      $("testKey").disabled = false;
      sayTo("keyResult", r.message, r.ok ? "ok" : "bad");
    });
  });

  // ---- remote: phone / Telegram (run by browser/extension/relay.js + telegram.js) ----
  var REMOTE_KEY = "agentRemote";
  var LEGACY_RELAY_KEY = "agentRelay";
  var REMOTE_STATUS_KEY = "agentRemoteStatus";
  var REMOTE_ON_KEY = "agentRemoteOn"; // chrome.storage.session: on in this browser session (relay.js)

  function remoteMode() {
    var r = document.querySelector('input[name="remoteMode"]:checked');
    return r ? r.value : "bot";
  }

  function showRemoteFields() {
    $("relayFields").classList.toggle("open", remoteMode() === "relay");
  }

  var remoteOn = false;
  function paintRemote(s) {
    s = s || { state: "off" };
    remoteOn = s.state === "on";
    $("remoteStatus").className = "status " + (s.state === "on" ? "active" : s.state === "error" ? "error" : "off");
    $("remoteStatusText").textContent =
      s.state === "on" ? "On — " + s.message :
      s.state === "error" ? s.message :
      s.message || "Off";
    // The web-app link of the chat open in the panel (relay modes only); it carries the relay token.
    $("remoteLinkRow").hidden = !s.link;
    $("remoteLink").value = s.link || "";
  }

  $("remoteLinkCopy").addEventListener("click", function () {
    var v = $("remoteLink").value;
    if (!v) return;
    (navigator.clipboard ? navigator.clipboard.writeText(v) : Promise.reject()).then(
      function () { sayTo("remoteResult", "Link copied.", "ok"); },
      function () { $("remoteLink").select(); sayTo("remoteResult", "Press Ctrl+C to copy.", ""); }
    );
  });

  function badAddress(u, protocols) {
    try { return protocols.indexOf(new URL(u).protocol) === -1; } catch (_) { return true; }
  }

  document.querySelectorAll('input[name="remoteMode"]').forEach(function (r) { r.addEventListener("change", showRemoteFields); });

  chrome.storage.local.get([REMOTE_KEY, LEGACY_RELAY_KEY]).then(function (o) {
    var c = o[REMOTE_KEY];
    var old = o[LEGACY_RELAY_KEY];
    if (!c) c = old && old.url ? { mode: "relay", autostart: !!old.enabled, relayUrl: old.url, relayToken: old.token || "" } : { mode: "bot" };
    $("tgToken").value = c.botToken || "";
    $("tgUser").value = c.userId || "";
    $("relayUrl").value = c.relayUrl || "";
    $("relayToken").value = c.relayToken || "";
    $("relayPublicUrl").value = c.publicUrl || "";
    // `enabled` is the one flag of earlier versions (relay.js carries it over to autostart when a panel opens).
    $("remoteAutostart").checked = c.autostart !== undefined ? !!c.autostart : !!c.enabled;
    var radio = document.querySelector('input[name="remoteMode"][value="' + (c.mode || "bot") + '"]');
    if (radio) radio.checked = true;
    showRemoteFields();
  });
  chrome.storage.session.get(REMOTE_STATUS_KEY).then(function (o) { paintRemote(o[REMOTE_STATUS_KEY]); });

  $("remoteForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var c = {
      mode: remoteMode(),
      autostart: $("remoteAutostart").checked,
      botToken: $("tgToken").value.trim(),
      userId: $("tgUser").value.trim(),
      relayUrl: $("relayUrl").value.trim(),
      relayToken: $("relayToken").value.trim(),
      publicUrl: $("relayPublicUrl").value.trim(),
    };
    var tgGiven = c.botToken || c.userId;
    if (tgGiven || c.mode === "bot") {
      if (!/^\d+:[\w-]{20,}$/.test(c.botToken)) return sayTo("remoteResult", "That doesn't look like a bot token from @BotFather (123456789:AA…).", "bad");
      if (!/^\d{5,}$/.test(c.userId)) return sayTo("remoteResult", "Your Telegram user id is a number — get it from @userinfobot.", "bad");
    }
    if (c.mode === "relay") {
      if (!c.relayUrl || badAddress(c.relayUrl, ["ws:", "wss:", "http:", "https:"])) {
        return sayTo("remoteResult", "The relay address must start with wss:// (or ws://, https://, http://).", "bad");
      }
      if (!c.relayToken) return sayTo("remoteResult", "Enter the relay token.", "bad");
      if (c.publicUrl && badAddress(c.publicUrl, ["http:", "https:"])) {
        return sayTo("remoteResult", "The public web address must start with https:// (or http://).", "bad");
      }
    }
    chrome.storage.local.set({ [REMOTE_KEY]: c }).then(function () {
      // Turning autostart on also means "now": an open panel starts without a trip to 🛰. Turning it
      // off leaves a running remote alone — 🛰 (or a browser restart) ends it.
      if (c.autostart) return chrome.storage.session.set({ [REMOTE_ON_KEY]: true });
    }).then(function () {
      sayTo("remoteResult",
        c.autostart ? "Saved — starts whenever the side panel is open (an open panel starts it right away)." :
        remoteOn ? "Saved — remote stays on until you press 🛰 in the side panel or restart the browser." :
        "Saved. Press 🛰 in the side panel to turn it on.", "ok");
    });
  });

  chrome.storage.local.get(CONFIG_KEY).then(function (o) { write(o[CONFIG_KEY]); });
  chrome.storage.session.get(STATUS_KEY).then(function (o) { showStatus(o[STATUS_KEY]); });
  chrome.storage.onChanged.addListener(function (ch, area) {
    if (area === "session" && ch[STATUS_KEY]) showStatus(ch[STATUS_KEY].newValue);
    if (area === "session" && ch[REMOTE_STATUS_KEY]) paintRemote(ch[REMOTE_STATUS_KEY].newValue);
  });
})();
