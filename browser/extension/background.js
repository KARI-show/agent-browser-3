// Clicking the toolbar icon opens the agent side panel.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

// ---------------------------------------------------------------------------
// Watchers run here, on chrome.alarms, with the panel closed: the same tool
// runtime the panel uses (browserTools.js has no DOM dependency) plus the
// automation module that knows how to check a page and report a change.
importScripts("brand.js", "fingerprint.js", "converter.js", "browserTools.js", "automation.js");

// A brand without watchers has no alarms/notifications permission — the APIs are then undefined.
if (chrome.alarms) chrome.alarms.onAlarm.addListener(function (alarm) {
  if (alarm.name.indexOf(AgentAutomation.ALARM_PREFIX) !== 0) return;
  AgentAutomation.runWatcherById(alarm.name.slice(AgentAutomation.ALARM_PREFIX.length)).catch(function (e) {
    console.warn("[watch]", alarm.name, e);
  });
});

// A notification names the watcher: clicking it opens the watched page.
if (chrome.notifications) chrome.notifications.onClicked.addListener(function (id) {
  var m = /^watch:(\w+):/.exec(id);
  chrome.notifications.clear(id);
  if (!m) return;
  AgentAutomation.loadWatchers().then(function (all) {
    var w = all[m[1]];
    if (w) chrome.tabs.create({ url: w.url });
  });
});

// Alarms don't survive an update of the extension, storage does.
if (chrome.alarms) {
  chrome.runtime.onInstalled.addListener(function () { AgentAutomation.syncAlarms().catch(console.warn); });
  chrome.runtime.onStartup.addListener(function () { AgentAutomation.syncAlarms().catch(console.warn); });
}

// ---------------------------------------------------------------------------
// Proxy for this browser profile (set up on the options page).
//
// The setting is applied with chrome.proxy, so it covers everything in the
// profile the extension is installed in — install it in a dedicated profile to
// give the agent its own exit address without touching your main browsing.
// Credentials for HTTP/HTTPS proxies are supplied when the proxy challenges.
// Chrome can't do SOCKS5 with a username/password, so in that one case a
// loopback forwarder in the native host does the SOCKS login and Chrome is
// pointed at it (host port stays open while the proxy is active).

importScripts("proxyConfig.js"); // the same validation the options page runs before saving

// A brand without the proxy feature has no proxy/webRequest/privacy permission: everything below is inert.
var PROXY_OK = !!(chrome.proxy && chrome.webRequest);
var CONFIG_KEY = "agentProxy";
var STATUS_KEY = "agentProxyStatus";
var HOST = "com.kari.agent_browser";

var hostPort = null;
var forwarder = null; // { port, token } while a forwarder is serving
var restarts = 0;
var authTried = {}; // requestId -> true (stops credential retry loops)

function getConfig() {
  return chrome.storage.local.get(CONFIG_KEY).then(function (o) { return o[CONFIG_KEY] || null; });
}

function setStatus(state, message) {
  var s = { state: state, message: message || "", at: Date.now() };
  chrome.storage.session.set({ [STATUS_KEY]: s }).catch(function () {});
  chrome.action.setBadgeBackgroundColor({ color: state === "error" ? "#cf222e" : "#1a7f37" }).catch(function () {});
  chrome.action.setBadgeText({ text: state === "off" ? "" : state === "error" ? "!" : "P" }).catch(function () {});
  chrome.action.setTitle({ title: AGENT_BRAND.shortName + (state === "active" ? " — proxy on" : state === "error" ? " — proxy problem" : "") }).catch(function () {});
}

function randomToken() {
  var b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return Array.prototype.map.call(b, function (x) { return x.toString(16).padStart(2, "0"); }).join("");
}

function closeHost() {
  forwarder = null;
  if (hostPort) {
    var p = hostPort;
    hostPort = null;
    p.onDisconnect.removeListener(onHostGone);
    try { p.disconnect(); } catch (_) {}
  }
}

function onHostGone() {
  var reason = (chrome.runtime.lastError && chrome.runtime.lastError.message) || "";
  hostPort = null;
  forwarder = null;
  // Browsing now fails closed (the proxy points at a dead port) — say why, and retry a few times.
  setStatus("error", "The local agent host stopped" + (reason ? " (" + reason + ")" : "") + " — the SOCKS5 login went with it.");
  if (restarts++ < 3) setTimeout(apply, 1500 * restarts);
}

function startForwarder(cfg) {
  return new Promise(function (resolve, reject) {
    var port;
    try {
      port = chrome.runtime.connectNative(HOST);
    } catch (e) {
      return reject(new Error("The agent host isn't installed (" + ((e && e.message) || e) + ")."));
    }
    var token = randomToken();
    var id = 1;
    var settled = false;
    var timer = setTimeout(function () { fail(new Error("The agent host didn't answer.")); }, 10000);
    function fail(e) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { port.disconnect(); } catch (_) {}
      reject(e);
    }
    port.onMessage.addListener(function (m) {
      if (!m || m.id !== id) return;
      if (m.type === "proxyReady" && !settled) {
        settled = true;
        clearTimeout(timer);
        hostPort = port;
        forwarder = { port: m.port, token: token };
        port.onDisconnect.addListener(onHostGone);
        resolve(forwarder);
      } else if (m.type === "proxyError") {
        fail(new Error(m.message));
      }
    });
    port.onDisconnect.addListener(function () {
      fail(new Error((chrome.runtime.lastError && chrome.runtime.lastError.message) || "The agent host exited."));
    });
    port.postMessage({
      type: "proxyStart",
      id: id,
      token: token,
      upstream: { type: "socks5", host: cfg.host.trim(), port: Number(cfg.port), username: cfg.username || "", password: cfg.password || "" },
    });
  });
}

function bypassList(cfg) {
  var extra = String(cfg.bypass || "").split(/[\s,;]+/).filter(Boolean);
  return ["localhost", "127.0.0.1", "[::1]", "<local>"].concat(extra);
}

async function applyPrivacy(cfg, on) {
  // Both are profile-wide settings; clearing hands control back to the user.
  if (!chrome.privacy) return;
  try {
    if (on) {
      // Without this, WebRTC can reveal the real address around the proxy.
      await chrome.privacy.network.webRTCIPHandlingPolicy.set({ value: "disable_non_proxied_udp" });
    } else {
      await chrome.privacy.network.webRTCIPHandlingPolicy.clear({});
    }
    if (on && cfg.blockThirdPartyCookies) await chrome.privacy.websites.thirdPartyCookiesAllowed.set({ value: false });
    else await chrome.privacy.websites.thirdPartyCookiesAllowed.clear({});
  } catch (e) {
    console.warn("privacy settings:", e);
  }
}

// One apply at a time — startup events and storage changes can arrive together.
var applyChain = Promise.resolve();
function apply() {
  if (!PROXY_OK) return Promise.resolve();
  applyChain = applyChain.then(doApply, doApply);
  return applyChain;
}

async function doApply() {
  authTried = {};
  var cfg = await getConfig();
  closeHost();
  var problem = AgentProxyConfig.validate(cfg);
  if (!cfg || !cfg.enabled) {
    await chrome.proxy.settings.clear({ scope: "regular" });
    await applyPrivacy(cfg || {}, false);
    return setStatus("off");
  }
  if (problem) {
    await chrome.proxy.settings.clear({ scope: "regular" });
    return setStatus("error", problem);
  }
  try {
    var server;
    if (cfg.type === "socks5" && (cfg.username || cfg.password)) {
      var f = await startForwarder(cfg);
      server = { scheme: "http", host: "127.0.0.1", port: f.port };
    } else {
      server = { scheme: cfg.type, host: cfg.host.trim(), port: Number(cfg.port) };
    }
    await chrome.proxy.settings.set({
      value: { mode: "fixed_servers", rules: { singleProxy: server, bypassList: bypassList(cfg) } },
      scope: "regular",
    });
    await applyPrivacy(cfg, true);
    restarts = 0;
    setStatus("active", cfg.type + "://" + cfg.host.trim() + ":" + cfg.port);
  } catch (e) {
    // Fail closed: leave no half-applied state that would send traffic direct
    // while the user believes the proxy is on.
    await chrome.proxy.settings.clear({ scope: "regular" });
    setStatus("error", String((e && e.message) || e));
  }
}

// Credentials: registered synchronously (MV3 requires it) and resolved lazily,
// so it works after the worker restarts.
if (PROXY_OK) chrome.webRequest.onAuthRequired.addListener(
  function (details, callback) {
    if (!details.isProxy) return callback({});
    getConfig().then(function (cfg) {
      var creds = null;
      if (forwarder && details.challenger && details.challenger.host === "127.0.0.1" && details.challenger.port === forwarder.port) {
        creds = { username: "agent", password: forwarder.token };
      } else if (cfg && cfg.enabled && cfg.type !== "socks5" && (cfg.username || cfg.password)) {
        creds = { username: cfg.username || "", password: cfg.password || "" };
      }
      if (!creds) return callback({});
      // Asked again for the same request → the credentials were refused.
      if (authTried[details.requestId]) {
        setStatus("error", "The proxy refused the username/password.");
        return callback({ cancel: true });
      }
      authTried[details.requestId] = true;
      callback({ authCredentials: creds });
    });
  },
  { urls: ["<all_urls>"] },
  ["asyncBlocking"]
);

// ── Device config for a profile window ──────────────────────────────────
// fp-bridge.js (content script, registered while a device profile window is
// open) asks which device config the window its frame lives in presents; the
// panel stored it under the window id when it launched the profile. Frames in
// other windows get null. The pair of content scripts is unregistered with
// the last profile window — here too, in case the panel is gone by then.
var DEVICE_WINDOW_PREFIX = "agentDeviceWindow:"; // one chrome.storage.session key per profile window
var DEVICE_SCRIPT_IDS = ["agent-device-bridge", "agent-device-config"];

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || msg.type !== "deviceConfig" || !sender || !sender.tab) return;
  var key = DEVICE_WINDOW_PREFIX + sender.tab.windowId;
  chrome.storage.session.get(key).then(function (st) { sendResponse(st[key] || null); }, function () { sendResponse(null); });
  return true;
});

chrome.windows.onRemoved.addListener(function (winId) {
  var key = DEVICE_WINDOW_PREFIX + winId;
  chrome.storage.session.get(null).then(async function (all) {
    if (!(key in all)) return;
    await chrome.storage.session.remove(key);
    if (Object.keys(all).some(function (k) { return k !== key && k.indexOf(DEVICE_WINDOW_PREFIX) === 0; })) return;
    var have = await chrome.scripting.getRegisteredContentScripts({ ids: DEVICE_SCRIPT_IDS });
    if (have.length) await chrome.scripting.unregisterContentScripts({ ids: have.map(function (h) { return h.id; }) });
  }).catch(function (e) { console.warn("[device] window cleanup:", e); });
});

// ── Requests from the side panel ────────────────────────────────────────
// Some browsers (Edge) refuse chrome.windows.create from a side panel, so the
// panel asks the service worker to open the window. Only the extension's own
// pages may ask: a content script's sender.url is the web page it runs in.
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!sender || !sender.url || sender.url.indexOf(chrome.runtime.getURL("")) !== 0) return;
  if (msg && msg.type === "createWindow") {
    chrome.windows.create(msg.options || {}).then(function (win) {
      sendResponse({ ok: true, win: win });
    }).catch(function (e) {
      sendResponse({ ok: false, error: String(e && e.message || e) });
    });
    return true; // async sendResponse
  }
  // "Check now" from the panel or a tool: the watcher runs here, where it runs on schedule too.
  if (msg && msg.type === "runWatcher" && typeof msg.id === "string") {
    AgentAutomation.runWatcherById(msg.id, { quiet: !!msg.quiet }).then(sendResponse, function (e) {
      sendResponse({ ok: false, error: String(e && e.message || e) });
    });
    return true;
  }
});

chrome.storage.onChanged.addListener(function (changes, area) {
  if (area === "local" && changes[CONFIG_KEY]) apply();
});
chrome.runtime.onStartup.addListener(apply);
chrome.runtime.onInstalled.addListener(apply);
apply();
