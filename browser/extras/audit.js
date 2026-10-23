// Extra feature "audit" (side panel): the identity report — what the current site sees of this browser,
// and what the extension knows about the window it is in. Built into extras.js only for brands that
// switch the feature on; the tool is declared in browser/host/extras/audit.ts.
//
// The page half runs in the page's MAIN world, so it sees exactly what the site's own scripts see — a
// device profile's overrides included. The extension half adds the site's cookie count (never values),
// whether the tab's window carries a device profile (chrome.storage.session "agentDeviceWindow:<id>" —
// its label only) and whether a proxy is applied (chrome.proxy.settings — mode and host:port, never
// credentials). Pure helpers (verdict, checks, formatting) are exposed on AgentExtras.audit for tests.
(function () {
  if (!globalThis.AGENT_BRAND || !globalThis.AGENT_BRAND.has("audit")) return;
  var T = globalThis.AgentBrowserTools;
  var H = T.helpers;
  var text = H.text;

  var DEVICE_WINDOW_PREFIX = "agentDeviceWindow:";
  var OS_NAMES = { win: "Windows", mac: "macOS", linux: "Linux", android: "Android", ios: "iOS" };
  var TWO_LEVEL_SUFFIX = /^(co|com|net|org|gov|edu|ac|or|ne|go|nom|ltd|plc|me)\.[a-z]{2}$/;

  // ── Page side (injected with chrome.scripting.executeScript: self-contained, no closures) ──

  function probePage() {
    var n = navigator;
    var res = {};
    try { res = Intl.DateTimeFormat().resolvedOptions(); } catch (_) {}
    var uad = null;
    try {
      if (n.userAgentData) uad = { brands: (n.userAgentData.brands || []).map(function (b) { return b.brand + " " + b.version; }), platform: n.userAgentData.platform || "", mobile: !!n.userAgentData.mobile };
    } catch (_) {}
    var out = {
      url: location.href, title: document.title,
      userAgent: n.userAgent, uaData: uad, platform: n.platform, language: n.language, languages: Array.prototype.slice.call(n.languages || []),
      timeZone: res.timeZone || "", locale: res.locale || "", tzOffset: new Date().getTimezoneOffset(),
      screen: { width: screen.width, height: screen.height, availWidth: screen.availWidth, availHeight: screen.availHeight, colorDepth: screen.colorDepth },
      dpr: window.devicePixelRatio, inner: { width: window.innerWidth, height: window.innerHeight },
      hardwareConcurrency: n.hardwareConcurrency, deviceMemory: n.deviceMemory === undefined ? null : n.deviceMemory, maxTouchPoints: n.maxTouchPoints,
      cookieEnabled: n.cookieEnabled, webdriver: n.webdriver === undefined ? null : n.webdriver, doNotTrack: n.doNotTrack === undefined ? null : n.doNotTrack,
      storage: null,
    };
    if (n.storage && n.storage.estimate) {
      return n.storage.estimate().then(function (e) { out.storage = { quota: e.quota, usage: e.usage }; return out; }, function () { return out; });
    }
    return out;
  }

  // ── Pure helpers ───────────────────────────────────────────────────────

  /** The registrable domain of a URL (the cookie scope a site uses); "" for a non-web address. */
  function siteOf(url) {
    var host;
    try {
      var u = new URL(String(url || ""));
      if (!/^https?:$/.test(u.protocol)) return "";
      host = u.hostname.toLowerCase();
    } catch (_) { return ""; }
    if (/^[\d.]+$/.test(host) || host.indexOf(":") !== -1) return host;
    var parts = host.split(".").filter(Boolean);
    if (parts.length <= 2) return parts.join(".");
    var tail = parts.slice(-2).join(".");
    return TWO_LEVEL_SUFFIX.test(tail) ? parts.slice(-3).join(".") : tail;
  }

  function osOfUa(ua) {
    ua = String(ua || "");
    if (/Windows/.test(ua)) return "Windows";
    if (/Android/.test(ua)) return "Android";
    if (/iPhone|iPad|iPod/.test(ua)) return "iOS";
    if (/Macintosh|Mac OS X/.test(ua)) return "macOS";
    if (/CrOS/.test(ua)) return "Chrome OS";
    if (/Linux|X11/.test(ua)) return "Linux";
    return "";
  }
  function osOfPlatform(p) {
    p = String(p || "");
    if (/^Win/i.test(p)) return "Windows";
    if (/^Mac/i.test(p)) return "macOS";
    if (/iPhone|iPad|iPod|^iOS$/i.test(p)) return "iOS";
    if (/Android/i.test(p)) return "Android";
    if (/Chrome ?OS|CrOS/i.test(p)) return "Chrome OS";
    if (/Linux|X11/i.test(p)) return "Linux";
    return "";
  }
  /** Browser product and major version from a User-Agent. */
  function browserOfUa(ua) {
    ua = String(ua || "");
    var m;
    if ((m = /Edg(?:e|A|iOS)?\/(\d+)/.exec(ua))) return "Edge " + m[1];
    if ((m = /OPR\/(\d+)/.exec(ua))) return "Opera " + m[1];
    if ((m = /Firefox\/(\d+)/.exec(ua))) return "Firefox " + m[1];
    if ((m = /Chrome\/(\d+)/.exec(ua))) return "Chrome " + m[1];
    if (/Safari\//.test(ua) && (m = /Version\/(\d+)/.exec(ua))) return "Safari " + m[1];
    return "an unknown browser";
  }
  function isMobile(page) {
    return !!(page.uaData && page.uaData.mobile) || /Mobile|Android|iPhone|iPad/.test(page.userAgent || "");
  }
  // Android's navigator.platform is a Linux string; iOS devices report their model.
  function sameOs(a, b) {
    var x = String(a || "").toLowerCase().replace(/\s/g, ""), y = String(b || "").toLowerCase().replace(/\s/g, "");
    if (x === y) return true;
    var pair = [x, y].sort().join("|");
    return pair === "android|linux";
  }

  /** Only what the report needs from a device config: its labels, never the template's values beyond the ones compared. */
  function summarizeDevice(cfg, profileName) {
    if (!cfg) return null;
    return {
      label: cfg.label || cfg.id || "device profile",
      profile: profileName || "",
      os: cfg.osName || OS_NAMES[cfg.os] || osOfUa(cfg.ua) || "",
      platform: cfg.platform || "",
      timezone: cfg.timezone || "",
      ua: cfg.ua || "",
      screen: cfg.screen && cfg.screen.width ? cfg.screen.width + "×" + cfg.screen.height : "",
      threads: cfg.hardwareConcurrency || 0,
    };
  }

  /** Inconsistencies a site could notice: between the page and the device profile, and inside the page's own values. */
  function checks(report) {
    var w = [];
    var p = report.page || {}, d = report.device;
    var uaOs = osOfUa(p.userAgent);
    if (d) {
      if (d.os && uaOs && !sameOs(d.os, uaOs)) w.push("The User-Agent says " + uaOs + ", but the device profile '" + d.label + "' is a " + d.os + " machine.");
      if (d.platform && p.platform && d.platform !== p.platform) w.push("navigator.platform is '" + p.platform + "', the device profile presents '" + d.platform + "'.");
      if (d.timezone && p.timeZone && d.timezone !== p.timeZone) w.push("Time zone: the page sees " + p.timeZone + ", the device profile sets " + d.timezone + ".");
      if (d.screen && p.screen && p.screen.width && p.screen.width + "×" + p.screen.height !== d.screen) w.push("Screen: the page sees " + p.screen.width + "×" + p.screen.height + ", the device profile is " + d.screen + ".");
      if (d.threads && p.hardwareConcurrency && d.threads !== p.hardwareConcurrency) w.push("CPU threads: the page sees " + p.hardwareConcurrency + ", the device profile has " + d.threads + ".");
    }
    if (p.uaData && p.uaData.platform && uaOs && !sameOs(osOfPlatform(p.uaData.platform) || p.uaData.platform, uaOs)) {
      w.push("Client hints say " + p.uaData.platform + " while the User-Agent says " + uaOs + " — sites compare the two.");
    }
    var platOs = osOfPlatform(p.platform);
    if (uaOs && platOs && !sameOs(platOs, uaOs)) w.push("navigator.platform '" + p.platform + "' does not match the " + uaOs + " User-Agent.");
    if (p.webdriver === true) w.push("navigator.webdriver is true — the page can tell that automation is attached.");
    return w;
  }

  function proxySummary(x) {
    if (!x || !x.available) return "no proxy control in this build";
    if (x.server) return "proxy " + x.server;
    if (x.mode === "system" || x.mode === "direct") return "no proxy";
    return "proxy mode " + x.mode;
  }

  /** One line: what the site takes this browser for, whether a profile and a proxy are in play, how many warnings. */
  function verdict(report) {
    var p = report.page || {};
    var what = (isMobile(p) ? "mobile " : "desktop ") + browserOfUa(p.userAgent) + " on " + (osOfUa(p.userAgent) || "an unknown OS");
    var parts = [];
    if (report.device) parts.push("Presents as a " + what + " through device profile '" + report.device.label + "'" + (report.device.profile ? " (" + report.device.profile + ")" : ""));
    else parts.push("Looks like a plain " + what + "; no device profile");
    parts.push(proxySummary(report.proxy));
    var w = checks(report);
    if (w.length) parts.push(w.length + " warning" + (w.length === 1 ? "" : "s"));
    return parts.join("; ");
  }

  function bytes(n) {
    if (typeof n !== "number" || !isFinite(n)) return "?";
    if (n >= 1e9) return (n / 1e9).toFixed(1) + " GB";
    if (n >= 1e6) return Math.round(n / 1e6) + " MB";
    if (n >= 1e3) return Math.round(n / 1e3) + " kB";
    return n + " B";
  }
  /** getTimezoneOffset() minutes (positive = behind UTC) → "UTC−5", "UTC+5:30", "UTC". */
  function utcOffset(min) {
    if (typeof min !== "number" || !isFinite(min) || min === 0) return "UTC";
    var sign = min > 0 ? "−" : "+";
    var abs = Math.abs(min);
    return "UTC" + sign + Math.floor(abs / 60) + (abs % 60 ? ":" + String(abs % 60).padStart(2, "0") : "");
  }
  function dim(s) {
    return s && s.width ? s.width + "×" + s.height : "?";
  }
  function yesNo(v) {
    return v === true ? "yes" : v === false ? "no" : "unknown";
  }
  function proxyLine(x) {
    if (!x || !x.available) return "no proxy control in this build";
    var who = x.control === "controlled_by_this_extension" ? " — set by this extension" : x.control === "controlled_by_other_extensions" ? " — set by another extension" : "";
    if (x.server) return x.server + " (mode \"" + x.mode + "\"" + who + ")";
    if (x.mode === "system" || x.mode === "direct") return "none set by the extension (mode \"" + x.mode + "\")";
    return "mode \"" + x.mode + "\"" + who;
  }

  /** The report as a readable block: verdict and warnings first, then the two groups. */
  function formatReport(report) {
    var p = report.page || {}, c = report.cookies || {}, d = report.device, tab = report.tab || {};
    var lines = ["Identity report for " + (tab.url || p.url || "?") + (tab.title || p.title ? " (" + (tab.title || p.title) + ")" : "")];
    lines.push("Verdict: " + verdict(report));
    checks(report).forEach(function (w) { lines.push("⚠ " + w); });
    lines.push("");
    lines.push("What the page sees");
    lines.push("  User-Agent: " + (p.userAgent || "?"));
    lines.push("  Client hints: " + (p.uaData ? (p.uaData.brands.length ? p.uaData.brands.join(", ") : "no brands") + " · platform " + (p.uaData.platform || "?") + " · " + (p.uaData.mobile ? "mobile" : "desktop") : "none (not a Chromium browser, or hints are off)"));
    lines.push("  Platform: " + (p.platform || "?"));
    lines.push("  Languages: " + (p.languages && p.languages.length ? p.languages.join(", ") : p.language || "?"));
    lines.push("  Time zone: " + (p.timeZone || "?") + (typeof p.tzOffset === "number" ? " (" + utcOffset(p.tzOffset) + ")" : "") + " · locale " + (p.locale || "?"));
    lines.push("  Screen: " + dim(p.screen) + (p.screen && p.screen.availWidth ? " (available " + p.screen.availWidth + "×" + p.screen.availHeight + ")" : "") +
      (p.screen && p.screen.colorDepth ? ", " + p.screen.colorDepth + "-bit" : "") + " · device pixel ratio " + (p.dpr || "?") + " · window " + dim(p.inner));
    lines.push("  Hardware: " + (p.hardwareConcurrency || "?") + " CPU threads · " + (p.deviceMemory ? p.deviceMemory + " GB memory" : "memory not exposed") + " · " + (p.maxTouchPoints || 0) + " touch points");
    lines.push("  Cookies enabled: " + yesNo(p.cookieEnabled) + " · navigator.webdriver: " + yesNo(p.webdriver) + " · Do Not Track: " + (p.doNotTrack == null ? "unset" : p.doNotTrack));
    lines.push("  Storage: " + (p.storage ? bytes(p.storage.quota) + " quota, " + bytes(p.storage.usage) + " used" : "estimate not available"));
    lines.push("");
    lines.push("What the extension knows");
    lines.push("  Cookies for " + (c.site || "this site") + ": " + (c.count == null ? "unknown (no cookie access in this build)" : c.count + (c.httpOnly ? " (" + c.httpOnly + " httpOnly)" : "")));
    lines.push("  Device profile: " + (d ? "'" + d.label + "'" + (d.profile ? " — profile '" + d.profile + "'" : "") + (d.timezone ? ", time zone " + d.timezone : "") + " — applied to this window" : "none — this window presents the real browser"));
    lines.push("  Proxy: " + proxyLine(report.proxy));
    return lines.join("\n");
  }

  // ── Extension side ─────────────────────────────────────────────────────

  async function storeOf(tab) {
    if (!chrome.cookies || !chrome.cookies.getAllCookieStores) return undefined;
    var stores = await chrome.cookies.getAllCookieStores();
    var s = stores.find(function (st) { return (st.tabIds || []).indexOf(tab.id) !== -1; });
    return s ? s.id : undefined;
  }

  async function probe(tab) {
    var results;
    try {
      results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: probePage, args: [], world: "MAIN" });
    } catch (e) {
      throw new Error("This page (" + (tab.url || "browser page") + ") can't be inspected — navigate to a regular website first. (" + String((e && e.message) || e) + ")");
    }
    var r = results && results[0] ? results[0].result : null;
    if (!r) throw new Error("The page did not answer — it may still be loading.");
    return r;
  }

  async function cookieCount(tab, site) {
    var out = { site: site, count: null, httpOnly: 0 };
    if (!chrome.cookies || !site) return out;
    var q = { domain: site };
    var storeId = await storeOf(tab);
    if (storeId) q.storeId = storeId;
    var list = await chrome.cookies.getAll(q).catch(function () { return null; });
    if (!list) return out;
    out.count = list.length;
    out.httpOnly = list.filter(function (c) { return c.httpOnly; }).length;
    return out;
  }

  // The device config the tab's window presents (a profile window's key in session storage; else an identity this
  // panel attached to the tab directly), reduced to its labels, plus the owning profile's name.
  async function deviceOfWindow(tab) {
    var cfg = null;
    if (chrome.storage && chrome.storage.session) {
      var key = DEVICE_WINDOW_PREFIX + tab.windowId;
      cfg = (await chrome.storage.session.get(key).catch(function () { return {}; }))[key] || null;
    }
    if (!cfg && typeof T.deviceOf === "function") cfg = T.deviceOf(tab.id) || null;
    if (!cfg) return null;
    var profileName = "";
    if (cfg.profileId && chrome.storage && chrome.storage.local) {
      var profiles = (await chrome.storage.local.get("agentProfiles").catch(function () { return {}; })).agentProfiles || {};
      if (profiles[cfg.profileId]) profileName = String(profiles[cfg.profileId].name || "");
    }
    return summarizeDevice(cfg, profileName);
  }

  async function proxyInfo() {
    if (!chrome.proxy || !chrome.proxy.settings) return { available: false };
    var s = await Promise.resolve(chrome.proxy.settings.get({})).catch(function () { return null; });
    var v = (s && s.value) || {};
    var out = { available: true, mode: v.mode || "unknown", control: (s && s.levelOfControl) || "", server: "" };
    var rules = v.rules || {};
    var one = rules.singleProxy || rules.proxyForHttps || rules.proxyForHttp;
    if (v.mode === "fixed_servers" && one && one.host) out.server = (one.scheme ? one.scheme + "://" : "") + one.host + (one.port ? ":" + one.port : "");
    else if (v.mode === "pac_script") out.server = "PAC script";
    return out;
  }

  /** The whole report for a tab (the tab the agent works in, or the one the panel shows). */
  async function collect(tab) {
    tab = tab || (await H.currentTab());
    var page = await probe(tab);
    var site = siteOf(tab.url || page.url);
    var cookies = await cookieCount(tab, site);
    var device = await deviceOfWindow(tab);
    var proxy = await proxyInfo();
    return { tab: { url: tab.url || page.url, title: tab.title || page.title || "", windowId: tab.windowId }, page: page, cookies: cookies, device: device, proxy: proxy, at: Date.now() };
  }

  // ── Tool ───────────────────────────────────────────────────────────────

  T.register("browser_identity_report", async function () {
    return text(formatReport(await collect(await H.currentTab())));
  });

  // ── 🧩 tab ─────────────────────────────────────────────────────────────

  var CHECK_PROMPT = "Run browser_identity_report on this tab, then compare it with the device profile and proxy this account is expected to use " +
    "(browser_profile_list shows the profiles and their proxies; say which one, if any, this window belongs to). Warn me about every mismatch — " +
    "User-Agent, platform, time zone, language, screen, proxy — before I sign in, and tell me what to fix.";

  globalThis.AgentExtras.tabs.push({
    id: "audit",
    label: "🪪 Identity",
    render: async function (content, ctx) {
      var el = ctx.el;
      content.textContent = "";
      var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      var tab = tabs[0];
      var reportText = "";
      var headline = el("div", { className: "cmd-name" }, ["Reading what " + (tab && tab.url ? ctx.hostOf(tab.url) : "this tab") + " sees…"]);
      var icon = el("span", { className: "cmd-icon" }, ["🪪"]);
      var body = el("div", { className: "cmd-body wide" }, [headline]);
      var copy = el("button", { className: "prof-btn", title: "Copy the report", disabled: true, onclick: function () {
        navigator.clipboard.writeText(reportText).then(function () { ctx.status("Report copied.", "good"); }, function (e) { ctx.status("⚠ " + e.message, "bad"); });
      } }, ["📋 Copy"]);
      var refresh = el("button", { className: "prof-btn primary", title: "Read the active tab again", onclick: function () { ctx.rerender(); } }, ["↻ Refresh"]);
      var ask = el("button", { className: "prof-btn", title: "Have the agent compare it with the expected profile and proxy", onclick: function () { ctx.sendPrompt(CHECK_PROMPT); } }, ["💬 Check with the agent"]);
      var pre = el("pre", { className: "auto-pre" }, [""]);
      content.appendChild(el("div", { className: "cmd-item event" }, [icon, body]));
      content.appendChild(el("div", { className: "ed-actions" }, [refresh, copy, ask]));
      content.appendChild(pre);
      content.appendChild(el("div", { className: "cmd-desc" }, ["Compare with another tab: switch to it and press Refresh — a profile window and a plain window should read differently."]));
      if (!tab || !/^https?:/i.test(tab.url || "")) {
        headline.textContent = "Open a website tab to see what it sees.";
        pre.textContent = "The report reads the page's own values (User-Agent, time zone, screen, hardware) and what the extension knows about its window (cookies, device profile, proxy).";
        return;
      }
      try {
        var report = await collect(tab);
        reportText = formatReport(report);
        var warnings = checks(report);
        var line = verdict(report);
        icon.textContent = warnings.length ? "⚠" : "✅";
        body.replaceChildren(el("div", { className: "cmd-name" }, [line]));
        warnings.forEach(function (w) { body.appendChild(el("div", { className: "cmd-desc bad" }, [w])); });
        ctx.status(line, warnings.length ? "bad" : "good"); // the verdict, highlighted
        pre.textContent = reportText;
        copy.disabled = false;
      } catch (e) {
        icon.textContent = "⚠";
        headline.textContent = "Could not read this tab.";
        pre.textContent = String((e && e.message) || e);
        ctx.status("⚠ " + ((e && e.message) || e), "bad");
      }
    },
  });

  // ── ⚡ quick commands ───────────────────────────────────────────────────

  globalThis.AgentExtras.commands.push(
    { group: "Accounts", icon: "🪪", name: "What does this site see?",
      prompt: "Run browser_identity_report for this tab and explain in plain words what this site sees about my browser: device and OS, time zone, languages, cookies, and whether a device profile or a proxy is in effect." },
    { group: "Accounts", icon: "🔍", name: "Check my identity before signing in", prompt: CHECK_PROMPT }
  );

  globalThis.AgentExtras.audit = {
    probePage: probePage, siteOf: siteOf, osOfUa: osOfUa, osOfPlatform: osOfPlatform, browserOfUa: browserOfUa, summarizeDevice: summarizeDevice,
    checks: checks, verdict: verdict, formatReport: formatReport, bytes: bytes, utcOffset: utcOffset, collect: collect,
  };
})();
