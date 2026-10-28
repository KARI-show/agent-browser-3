// Extra feature "audit" (side panel): the identity report — what the current site sees of this browser,
// and what the extension knows about the window it is in. Built into extras.js only for brands that
// switch the feature on; the tool is declared in browser/host/extras/audit.ts.
//
// The page half runs in the page's MAIN world, so it sees exactly what the site's own scripts see — a
// device profile's overrides included. The extension half adds the site's cookie count (never values),
// whether the tab's window carries a device profile (chrome.storage.session "agentDeviceWindow:<id>" —
// its label only) and whether a proxy is applied (chrome.proxy.settings — mode and host:port, never
// credentials). Two more checks: browser_identity_proxy fetches Cloudflare's trace endpoint from the panel —
// the request takes the browser's proxy settings, so the exit it reports is the one sites see — and compares
// it with the proxy the extension expects and the profile's language / time zone; browser_identity_leaks runs
// one self-contained probe in the page (WebRTC candidates, time zone, languages, geometry, webdriver, client
// hints…) and grades the findings. Pure helpers (verdict, checks, parseTrace, assessExit, leakFindings,
// formatting) are exposed on AgentExtras.audit for tests.
(function () {
  if (!globalThis.AGENT_BRAND || !globalThis.AGENT_BRAND.has("audit")) return;
  var T = globalThis.AgentBrowserTools;
  var H = T.helpers;
  var text = H.text;

  var DEVICE_WINDOW_PREFIX = "agentDeviceWindow:";
  var TRACE_URL = "https://www.cloudflare.com/cdn-cgi/trace"; // key=value lines: ip, loc, colo, uag, tls, http…
  var TRACE_TIMEOUT = 10000;
  var WEBRTC_WAIT = 2000; // ms the page gathers ICE candidates (inlined in probeLeaks, which must stay self-contained)
  // Where a time zone puts a visitor, for comparing with the exit country; zones not listed are not compared.
  var TZ_COUNTRY = {
    "America/New_York": "US", "America/Chicago": "US", "America/Denver": "US", "America/Phoenix": "US", "America/Los_Angeles": "US", "America/Anchorage": "US", "Pacific/Honolulu": "US",
    "America/Toronto": "CA", "America/Vancouver": "CA", "America/Edmonton": "CA", "America/Winnipeg": "CA", "America/Halifax": "CA",
    "America/Mexico_City": "MX", "America/Sao_Paulo": "BR", "America/Argentina/Buenos_Aires": "AR", "America/Buenos_Aires": "AR", "America/Santiago": "CL", "America/Bogota": "CO", "America/Lima": "PE",
    "Europe/London": "GB", "Europe/Dublin": "IE", "Europe/Lisbon": "PT", "Europe/Madrid": "ES", "Europe/Paris": "FR", "Europe/Brussels": "BE", "Europe/Amsterdam": "NL", "Europe/Luxembourg": "LU",
    "Europe/Berlin": "DE", "Europe/Zurich": "CH", "Europe/Vienna": "AT", "Europe/Rome": "IT", "Europe/Prague": "CZ", "Europe/Warsaw": "PL", "Europe/Budapest": "HU", "Europe/Bucharest": "RO",
    "Europe/Copenhagen": "DK", "Europe/Oslo": "NO", "Europe/Stockholm": "SE", "Europe/Helsinki": "FI", "Europe/Athens": "GR", "Europe/Istanbul": "TR", "Europe/Kiev": "UA", "Europe/Kyiv": "UA", "Europe/Moscow": "RU",
    "Asia/Dubai": "AE", "Asia/Riyadh": "SA", "Asia/Jerusalem": "IL", "Asia/Kolkata": "IN", "Asia/Calcutta": "IN", "Asia/Karachi": "PK", "Asia/Dhaka": "BD", "Asia/Bangkok": "TH", "Asia/Jakarta": "ID",
    "Asia/Singapore": "SG", "Asia/Kuala_Lumpur": "MY", "Asia/Manila": "PH", "Asia/Ho_Chi_Minh": "VN", "Asia/Hong_Kong": "HK", "Asia/Taipei": "TW", "Asia/Shanghai": "CN", "Asia/Seoul": "KR", "Asia/Tokyo": "JP",
    "Australia/Sydney": "AU", "Australia/Melbourne": "AU", "Australia/Brisbane": "AU", "Australia/Perth": "AU", "Pacific/Auckland": "NZ", "Africa/Johannesburg": "ZA", "Africa/Cairo": "EG", "Africa/Lagos": "NG", "Africa/Nairobi": "KE",
  };
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

  // The leak probe (MAIN world, self-contained). WebRTC: a connection with no ICE servers gathers host candidates
  // only; Chrome hides their addresses behind mDNS .local names unless a policy or flag exposes them, so a raw IP
  // in a candidate is exactly what a site would read. Gathering is cut off after 2 s; the rest is read at once.
  function probeLeaks() {
    var n = navigator;
    var out = {
      url: location.href, title: document.title, now: Date.now(),
      userAgent: n.userAgent, uaData: null, platform: n.platform,
      language: n.language, languages: Array.prototype.slice.call(n.languages || []),
      timeZone: "", tzOffset: new Date().getTimezoneOffset(),
      screen: { width: screen.width, height: screen.height, availWidth: screen.availWidth, availHeight: screen.availHeight },
      dpr: window.devicePixelRatio, inner: { width: window.innerWidth, height: window.innerHeight }, outer: { width: window.outerWidth, height: window.outerHeight },
      webdriver: n.webdriver === undefined ? null : n.webdriver,
      hardwareConcurrency: n.hardwareConcurrency === undefined ? null : n.hardwareConcurrency, deviceMemory: n.deviceMemory === undefined ? null : n.deviceMemory,
      plugins: n.plugins ? n.plugins.length : null, doNotTrack: n.doNotTrack === undefined ? null : n.doNotTrack,
      maxTouchPoints: n.maxTouchPoints === undefined ? null : n.maxTouchPoints,
      webrtc: { supported: false, candidates: [], error: "" },
    };
    try { out.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (_) {}
    try {
      if (n.userAgentData) out.uaData = { brands: (n.userAgentData.brands || []).map(function (b) { return b.brand + " " + b.version; }), platform: n.userAgentData.platform || "", mobile: !!n.userAgentData.mobile };
    } catch (_) {}
    var RTC = window.RTCPeerConnection || window.webkitRTCPeerConnection;
    if (typeof RTC !== "function") return out;
    out.webrtc.supported = true;
    return new Promise(function (resolve) {
      var pc = null, done = false, timer = null;
      function finish() {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { if (pc) pc.close(); } catch (_) {}
        resolve(out);
      }
      try {
        pc = new RTC({ iceServers: [] });
        pc.createDataChannel("leak-check");
        pc.onicecandidate = function (e) {
          if (!e || !e.candidate) return finish(); // a null candidate ends the gathering
          out.webrtc.candidates.push(String(e.candidate.candidate || ""));
        };
        pc.createOffer().then(function (offer) { return pc.setLocalDescription(offer); }).catch(function (e) { out.webrtc.error = String((e && e.message) || e); finish(); });
        timer = setTimeout(finish, 2000);
      } catch (e) {
        out.webrtc.error = String((e && e.message) || e);
        finish();
      }
    });
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

  function plural(n, word) {
    return n + " " + word + (n === 1 ? "" : "s");
  }
  /** "fr-FR,fr;q=0.9,en;q=0.8" → ["fr-FR", "fr", "en"]: a profile's language field, as fingerprint.js reads it. */
  function parseLangs(lang) {
    return String(lang || "").split(",").map(function (s) { return s.replace(/;q=[\d.]+/, "").trim(); }).filter(Boolean);
  }
  /** The country a language tag names ("en-GB" → "GB", "zh-Hans-CN" → "CN"); "" when it names none ("en"). */
  function langCountry(tag) {
    var m = /(?:^|-)([A-Za-z]{2})(?:-|$)/.exec(String(tag || "").replace(/^[A-Za-z]{2,3}(?=-|$)/, ""));
    return m ? m[1].toUpperCase() : "";
  }
  function tzCountry(tz) {
    return TZ_COUNTRY[String(tz || "")] || "";
  }

  // ── The exit check ──

  /** The key=value lines of a Cloudflare trace → { ip, loc, colo, uag, tls, http, … } (every key, values trimmed). */
  function parseTrace(body) {
    var out = {};
    String(body || "").split(/\r?\n/).forEach(function (line) {
      var i = line.indexOf("=");
      if (i <= 0) return;
      var k = line.slice(0, i).trim();
      if (k) out[k] = line.slice(i + 1).trim();
    });
    return out;
  }

  function routeOf(proxy) {
    return proxy && proxy.host ? "through " + (proxy.type || "http") + "://" + proxy.host + (proxy.port ? ":" + proxy.port : "") : "direct";
  }

  /**
   * The exit against what the extension expects. `trace` is parseTrace()'s result, or null when the fetch failed
   * (exp.error says why). exp = { proxy: { type, host, port } | null, source, applied: proxyInfo() | null, languages,
   * timezone, latency, error }. → { reached, lines ("✓ …", "⚠ …", plain), warnings, advice, verdict }. A proxy that is
   * expected but not applied is a warning; an exit country that disagrees with the profile's language or time zone is
   * advice, not an error — it is what a careful site might find odd, and the fix is a different proxy or profile.
   */
  function assessExit(trace, exp) {
    exp = exp || {};
    var route = routeOf(exp.proxy);
    var lines = ["Expected route: " + route + (exp.source ? " (" + exp.source + ")" : "")];
    var warnings = [], advice = [], compared = [];
    if (!trace) {
      var why = exp.error || "no answer";
      var reach = exp.proxy ? "The exit could not be reached through the current proxy (" + route.replace(/^through /, "") + "): " + why + " — browsing through it fails too; check host, port and credentials" + (exp.proxy.type === "socks5" ? ", and the local agent host for SOCKS5" : "")
        : "The exit could not be reached (" + why + ") — no proxy is configured, so the machine itself seems offline or the endpoint is blocked";
      lines.push("⚠ " + reach + ".");
      return { reached: false, lines: lines, warnings: [reach], advice: [], verdict: exp.proxy ? "The exit could not be reached through the current proxy (" + why + ")" : "The exit could not be reached (" + why + ")" };
    }
    var ip = trace.ip || "?", loc = String(trace.loc || "").toUpperCase(), colo = trace.colo || "";
    lines.push("Exit: " + ip + (loc ? " · country " + loc : " · country unknown") + (colo ? " · Cloudflare " + colo : "") + (typeof exp.latency === "number" ? " · " + exp.latency + " ms round trip" : ""));
    if (trace.tls || trace.http || trace.uag) {
      lines.push("Connection: " + [trace.tls ? "TLS " + trace.tls : "", trace.http ? "HTTP " + trace.http : "", trace.uag ? "User-Agent " + trace.uag : ""].filter(Boolean).join(" · "));
    }
    if (exp.proxy) {
      var applied = exp.applied;
      if (applied && applied.available && applied.mode !== "fixed_servers" && applied.mode !== "pac_script") {
        var w = "A proxy is expected (" + route + ") but the browser applies none (mode \"" + applied.mode + "\") — the exit above is the real address";
        lines.push("⚠ " + w);
        warnings.push("no proxy applied");
      } else {
        lines.push("✓ Fetched through the browser's proxy settings" + (applied && applied.server ? " (" + applied.server + ")" : ""));
        if (/^\d+\.\d+\.\d+\.\d+$/.test(exp.proxy.host) && trace.ip === exp.proxy.host) lines.push("✓ The exit IP is the proxy's own address");
      }
    } else {
      lines.push("✓ No proxy configured: the exit is this machine's own address");
    }
    var lang = (exp.languages && exp.languages[0]) || "";
    var lc = langCountry(lang);
    if (lang && loc) {
      if (!lc) lines.push("Profile language " + lang + " names no country — not compared with the exit");
      else if (lc === loc) { lines.push("✓ Exit country " + loc + " agrees with the profile language " + lang); compared.push("language " + lang); }
      else {
        lines.push("⚠ Exit country " + loc + " while the profile language is " + lang + " (" + lc + ") — advice, not an error: a site may find the pair odd; use a proxy in " + lc + " or a profile language for " + loc);
        advice.push("language " + lang + " suggests " + lc);
      }
    }
    var tz = exp.timezone || "", tc = tzCountry(tz);
    if (tz && loc) {
      if (!tc) lines.push("Profile time zone " + tz + " — country not known to this check, not compared");
      else if (tc === loc) { lines.push("✓ Exit country " + loc + " agrees with the profile time zone " + tz); compared.push("time zone " + tz); }
      else {
        lines.push("⚠ Exit country " + loc + " while the profile time zone is " + tz + " (" + tc + ") — advice, not an error: use a proxy in " + tc + " or a profile for " + loc);
        advice.push("time zone " + tz + " suggests " + tc);
      }
    }
    if (!loc && (lang || tz)) lines.push("The trace gave no country — language and time zone not compared");
    var verdict = "Exit " + ip + (loc ? " (" + loc + ")" : "") + " " + route;
    if (warnings.length) verdict += " — " + plural(warnings.length, "warning") + ": " + warnings.join("; ") + (advice.length ? "; advice: " + advice.join("; ") : "");
    else if (advice.length) verdict += " — advice: " + advice.join("; ");
    else if (compared.length) verdict += " — consistent with the profile's " + compared.join(" and ");
    else verdict += " — no profile hints to compare";
    return { reached: true, lines: lines, warnings: warnings, advice: advice, verdict: verdict };
  }

  // ── The leak check ──

  /** An ICE candidate line's address and type: "candidate:… udp 2122260223 192.168.1.5 54321 typ host …". */
  function candidateAddress(line) {
    var parts = String(line || "").trim().split(/\s+/);
    var m = /\btyp\s+(\S+)/.exec(String(line || ""));
    return { address: parts.length > 4 ? parts[4] : "", type: m ? m[1] : "" };
  }
  function isIpv4(a) {
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(a);
  }
  function isIpv6(a) {
    return a.indexOf(":") !== -1 && /^[0-9a-f:.%]+$/i.test(a);
  }
  function isPrivateIp(a) {
    if (isIpv4(a)) return /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a);
    return /^(fe80:|fc|fd|::1$)/i.test(a);
  }
  /** The raw IPs the WebRTC probe exposed: [{ address, scope: "private" | "public", type }]; mDNS .local names are no leak. */
  function webrtcLeaks(candidates) {
    var seen = {}, out = [];
    (candidates || []).forEach(function (line) {
      var c = candidateAddress(line);
      if (!c.address || seen[c.address] || !(isIpv4(c.address) || isIpv6(c.address))) return;
      seen[c.address] = true;
      out.push({ address: c.address, scope: isPrivateIp(c.address) ? "private" : "public", type: c.type || "host" });
    });
    return out;
  }
  /** getTimezoneOffset()-style minutes (UTC − local) of an IANA zone at `at`; null for a zone Intl does not know. */
  function zoneOffset(tz, at) {
    try {
      var d = new Date(at || Date.now());
      var v = {};
      new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" })
        .formatToParts(d).forEach(function (p) { v[p.type] = p.value; });
      var local = Date.UTC(+v.year, +v.month - 1, +v.day, +v.hour % 24, +v.minute, +v.second);
      return Math.round((d.getTime() - d.getMilliseconds() - local) / 60000);
    } catch (_) {
      return null;
    }
  }

  /**
   * The leak report from probeLeaks()' data and what the extension expects of the page ({ timezone, languages, label }
   * of the window's device profile, or nothing). → { lines: ["✓ …" | "⚠ …"], risks: [short reasons], verdict }.
   * Every ⚠ line is a risk; the verdict counts them and repeats the short reasons.
   */
  function leakFindings(p, exp) {
    p = p || {};
    exp = exp || {};
    var lines = [], risks = [];
    function ok(s) { lines.push("✓ " + s); }
    function warn(s, short) { lines.push("⚠ " + s); risks.push(short || s); }
    var ua = p.userAgent || "", mobile = isMobile(p), uaOs = osOfUa(ua), chromium = /Chrome\//.test(ua) && !/Firefox\//.test(ua);
    var profile = exp.label ? "the device profile '" + exp.label + "'" : "the device profile";

    var rtc = p.webrtc || {};
    if (!rtc.supported) ok("WebRTC: RTCPeerConnection is not available in this page — nothing to leak");
    else {
      var leaks = webrtcLeaks(rtc.candidates);
      if (leaks.length) {
        warn("WebRTC exposes " + leaks.map(function (l) { return l.address + " (" + l.scope + ", " + l.type + ")"; }).join(", ") + " in its ICE candidates — a site reads these without asking; Chrome normally hides local addresses behind mDNS .local names",
          "WebRTC exposes " + leaks.map(function (l) { return l.address; }).join(", "));
      } else if (rtc.candidates && rtc.candidates.length) ok("WebRTC: " + plural(rtc.candidates.length, "host candidate") + ", all behind mDNS .local names — no raw IP");
      else ok("WebRTC: no ICE candidates gathered in 2 s" + (rtc.error ? " (" + rtc.error + ")" : "") + " — nothing exposed");
    }

    var tz = p.timeZone || "", off = typeof p.tzOffset === "number" ? p.tzOffset : null;
    if (!tz) warn("Time zone: Intl names no zone" + (off !== null ? " (Date offset " + utcOffset(off) + ")" : ""), "no time zone");
    else {
      var want = zoneOffset(tz, p.now);
      if (want !== null && off !== null && want !== off) warn("Time zone " + tz + " (" + utcOffset(want) + ") but Date reports " + utcOffset(off) + " — a zone override that reached Intl and not Date", "time zone " + tz + " vs Date offset " + utcOffset(off));
      else if (exp.timezone && exp.timezone !== tz) warn("Time zone " + tz + " while " + profile + " says " + exp.timezone, "time zone " + tz + " while the profile says " + exp.timezone);
      else ok("Time zone " + tz + (off !== null ? " (" + utcOffset(off) + ")" : "") + (want === null ? " — a zone this check does not know, offset not compared" : ", Date offset agrees") + (exp.timezone ? ", matches " + profile : ""));
    }

    var lang = p.language || "", first = (p.languages && p.languages[0]) || "", expLang = (exp.languages && exp.languages[0]) || "";
    if (!lang && !first) warn("Languages: navigator.language and navigator.languages are empty", "no languages");
    else if (first && lang.toLowerCase() !== first.toLowerCase()) warn("navigator.language is " + lang + " but navigator.languages starts with " + first + " — an override applied to one and not the other", "language " + lang + " vs languages[0] " + first);
    else if (expLang && lang && expLang.toLowerCase() !== lang.toLowerCase()) warn("Language " + lang + " while " + profile + " says " + expLang, "language " + lang + " while the profile says " + expLang);
    else ok("Languages " + (p.languages && p.languages.length ? p.languages.join(", ") : lang) + " — navigator.language agrees" + (expLang ? ", matches " + profile : ""));

    var sc = p.screen || {}, inner = p.inner || {}, outer = p.outer || {}, dpr = p.dpr;
    var geo = "screen " + dim(sc) + " · window " + dim(inner) + (outer.width ? " in " + dim(outer) : "") + " · pixel ratio " + (dpr || "?");
    if (!sc.width || !sc.height) warn("Screen size is missing (" + geo + ")", "no screen size");
    else if (inner.width > sc.width || inner.height > sc.height) warn("The viewport " + dim(inner) + " is larger than the screen " + dim(sc) + " — impossible on a real display", "viewport larger than the screen");
    else if (outer.width && (outer.width < inner.width || outer.height < inner.height)) warn("The viewport " + dim(inner) + " is larger than its window " + dim(outer) + " — headless browsers report that", "viewport larger than its window");
    else if (sc.availWidth > sc.width || sc.availHeight > sc.height) warn("screen.avail " + sc.availWidth + "×" + sc.availHeight + " exceeds the screen " + dim(sc), "avail larger than the screen");
    else if (!(dpr > 0)) warn("devicePixelRatio is " + dpr + " — a real display reports a positive ratio", "no devicePixelRatio");
    else ok("Geometry plausible: " + geo);

    if (p.webdriver === true) warn("navigator.webdriver is true — the page can tell automation is attached", "navigator.webdriver is true");
    else ok("navigator.webdriver: " + (p.webdriver === false ? "false" : "not set"));

    var hc = p.hardwareConcurrency, mem = p.deviceMemory;
    if (!(hc > 0)) warn("hardwareConcurrency is missing — every real browser reports its CPU threads", "hardwareConcurrency missing");
    else if (chromium && !(mem > 0)) warn("deviceMemory is missing on a Chromium User-Agent — Chrome always reports it", "deviceMemory missing");
    else ok("Hardware: " + hc + " CPU threads · " + (mem > 0 ? mem + " GB memory" : "memory not exposed (normal outside Chromium)"));

    if (p.plugins == null) ok("Plugins: navigator.plugins not available");
    else if (p.plugins === 0 && chromium && !mobile) warn("navigator.plugins is empty — desktop Chrome lists its PDF viewers; headless and stripped builds show none", "no plugins on desktop Chrome");
    else ok("Plugins: " + p.plugins + (mobile ? " (mobile browsers list none)" : ""));

    ok("Do Not Track: " + (p.doNotTrack == null ? "unset (the common default)" : p.doNotTrack + " — a rarer setting, part of the fingerprint"));

    if (p.uaData) {
      var hintOs = osOfPlatform(p.uaData.platform) || p.uaData.platform;
      var uaMobile = /\bMobile\b/.test(ua);
      var uaMajor = /(?:Chrome|CriOS|Edg)\/(\d+)/.exec(ua), hintMajor = "";
      (p.uaData.brands || []).forEach(function (b) { var m = /^(?:Google Chrome|Chromium|Microsoft Edge) (\d+)/.exec(b); if (m && !hintMajor) hintMajor = m[1]; });
      if (uaOs && hintOs && !sameOs(hintOs, uaOs)) warn("Client hints say " + p.uaData.platform + " while the User-Agent says " + uaOs + " — sites compare the two", "client hints " + p.uaData.platform + " vs User-Agent " + uaOs);
      else if (!!p.uaData.mobile !== uaMobile) warn("Client hints say " + (p.uaData.mobile ? "mobile" : "desktop") + " while the User-Agent says " + (uaMobile ? "mobile" : "desktop"), "client hints " + (p.uaData.mobile ? "mobile" : "desktop") + " vs User-Agent " + (uaMobile ? "mobile" : "desktop"));
      else if (uaMajor && hintMajor && uaMajor[1] !== hintMajor) warn("Client hints say version " + hintMajor + " while the User-Agent says " + uaMajor[1], "client hints version " + hintMajor + " vs User-Agent " + uaMajor[1]);
      else ok("Client hints (" + ((p.uaData.brands || []).join(", ") || "no brands") + " · " + (p.uaData.platform || "?") + ") agree with the User-Agent");
    } else ok("Client hints: none (not a Chromium browser, or hints are off)");

    var touch = p.maxTouchPoints;
    if (mobile && touch === 0) warn("A mobile User-Agent with no touch points — phones report 5 or more", "mobile User-Agent without touch");
    else if (!mobile && touch > 0 && (uaOs === "macOS" || uaOs === "Linux")) warn("A " + uaOs + " desktop User-Agent with " + touch + " touch points — Macs have no touch screens and Linux desktops rarely do", uaOs + " desktop with touch points");
    else ok("Touch points: " + (touch == null ? "unknown" : touch) + (mobile ? " on a mobile User-Agent" : touch > 0 ? " (a touch laptop)" : " on a desktop User-Agent"));

    var verdict = risks.length ? plural(risks.length, "risk") + ": " + risks.join("; ") : "No risks found: WebRTC, time zone, languages, geometry, hardware and client hints look consistent";
    return { lines: lines, risks: risks, verdict: verdict };
  }

  /** The leak report as the model reads it: where, the verdict, what it was compared with, then the lines. */
  function formatLeaks(tab, page, exp, findings) {
    tab = tab || {};
    page = page || {};
    var head = ["Leak check for " + (tab.url || page.url || "?") + (tab.title || page.title ? " (" + (tab.title || page.title) + ")" : "")];
    head.push("Verdict: " + findings.verdict);
    head.push("Compared with: " + (exp && exp.label
      ? "device profile '" + exp.label + "'" + (exp.profile ? " (" + exp.profile + ")" : "") + (exp.timezone ? ", time zone " + exp.timezone : "") + (exp.languages && exp.languages.length ? ", language " + exp.languages[0] : "")
      : "no device profile on this window — the page's own consistency only"));
    return head.concat(findings.lines).join("\n");
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
  // panel attached to the tab directly), as stored, with the owning profile → { cfg, profile }; both null without one.
  async function rawDevice(tab) {
    var cfg = null;
    if (chrome.storage && chrome.storage.session) {
      var key = DEVICE_WINDOW_PREFIX + tab.windowId;
      cfg = (await chrome.storage.session.get(key).catch(function () { return {}; }))[key] || null;
    }
    if (!cfg && typeof T.deviceOf === "function") cfg = T.deviceOf(tab.id) || null;
    if (!cfg) return { cfg: null, profile: null };
    var profile = null;
    if (cfg.profileId && chrome.storage && chrome.storage.local) {
      var profiles = (await chrome.storage.local.get("agentProfiles").catch(function () { return {}; })).agentProfiles || {};
      profile = profiles[cfg.profileId] || null;
    }
    return { cfg: cfg, profile: profile };
  }
  /** The window's device config reduced to its labels, plus the owning profile's name. */
  async function deviceOfWindow(tab) {
    var r = await rawDevice(tab);
    return r.cfg ? summarizeDevice(r.cfg, r.profile ? String(r.profile.name || "") : "") : null;
  }
  /** What the window's device profile asks the page to show: { label, profile, timezone, languages } — empty without one. */
  function windowExpectations(r) {
    if (!r || !r.cfg) return { label: "", profile: "", timezone: "", languages: [] };
    var langs = Array.isArray(r.cfg.langs) && r.cfg.langs.length ? r.cfg.langs.slice() : parseLangs(r.profile && r.profile.lang);
    return { label: r.cfg.label || r.cfg.id || "device profile", profile: r.profile ? String(r.profile.name || "") : "", timezone: r.cfg.timezone || "", languages: langs };
  }

  // The proxy the extension expects traffic to take: the active profile's, else the global setting (a profile
  // without one is launched over it) — { type, host, port } and where it comes from, never credentials.
  async function expectedProxy() {
    if (!chrome.storage || !chrome.storage.local) return { proxy: null, source: "no proxy configured", languages: [] };
    var st = await chrome.storage.local.get(["agentProfiles", "agentActiveProfile", "agentProxy"]).catch(function () { return {}; });
    var profiles = st.agentProfiles || {};
    var active = st.agentActiveProfile && profiles[st.agentActiveProfile] ? profiles[st.agentActiveProfile] : null;
    var name = active ? String(active.name || st.agentActiveProfile) : "";
    function pick(p) { return p && p.enabled && p.host ? { type: p.type || "http", host: String(p.host), port: Number(p.port) || 0 } : null; }
    var own = active ? pick(active.proxy) : null;
    if (own) return { proxy: own, source: "device profile '" + name + "'", languages: parseLangs(active.lang) };
    var global = pick(st.agentProxy);
    return {
      proxy: global,
      source: global ? "the proxy setting" + (active ? " — profile '" + name + "' has none of its own" : "") : "no proxy configured" + (active ? " — profile '" + name + "' has none" : ""),
      languages: active ? parseLangs(active.lang) : [],
    };
  }

  /** One GET of the trace endpoint from the panel (the browser's proxy settings apply) → { trace, latency } or { trace: null, latency, error }. */
  async function fetchTrace(timeout) {
    timeout = timeout || TRACE_TIMEOUT;
    if (typeof fetch !== "function") return { trace: null, latency: 0, error: "no fetch in this runtime" };
    var ctrl = typeof AbortController === "function" ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, timeout) : null;
    var t0 = Date.now();
    try {
      var res = await fetch(TRACE_URL, { cache: "no-store", credentials: "omit", redirect: "follow", signal: ctrl ? ctrl.signal : undefined });
      var body = await res.text();
      if (!res.ok) throw new Error("HTTP " + res.status);
      return { trace: parseTrace(body), latency: Date.now() - t0 };
    } catch (e) {
      return { trace: null, latency: Date.now() - t0, error: ctrl && ctrl.signal.aborted ? "timed out after " + timeout / 1000 + " s" : String((e && e.message) || e) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** The exit check: fetch the trace, gather the expectations, grade → { text, assessment }. Never throws for a network failure. */
  async function exitCheck(tab) {
    if (!tab) {
      try { tab = await H.currentTab(); } catch (_) { tab = null; }
    }
    var win = windowExpectations(tab ? await rawDevice(tab).catch(function () { return null; }) : null);
    var px = await expectedProxy();
    var applied = await proxyInfo();
    var t = await fetchTrace();
    var exp = { proxy: px.proxy, source: px.source, applied: applied, languages: win.languages.length ? win.languages : px.languages, timezone: win.timezone, latency: t.latency, error: t.error || "" };
    var a = assessExit(t.trace, exp);
    return { text: ["Exit check (" + TRACE_URL + ", fetched by the extension through the browser's proxy settings)", "Verdict: " + a.verdict].concat(a.lines).join("\n"), assessment: a };
  }

  /** The leak probe on a tab, graded against the window's device profile → { text, findings }. */
  async function leakCheck(tab) {
    tab = tab || (await H.currentTab());
    var results;
    try {
      results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: probeLeaks, args: [], world: "MAIN" });
    } catch (e) {
      throw new Error("This page (" + (tab.url || "browser page") + ") can't be inspected — navigate to a regular website first. (" + String((e && e.message) || e) + ")");
    }
    var page = results && results[0] ? results[0].result : null;
    if (!page) throw new Error("The page did not answer — it may still be loading.");
    var exp = windowExpectations(await rawDevice(tab));
    var findings = leakFindings(page, exp);
    return { text: formatLeaks(tab, page, exp, findings), findings: findings };
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
  T.register("browser_identity_proxy", async function () {
    return text((await exitCheck()).text);
  });
  T.register("browser_identity_leaks", async function () {
    return text((await leakCheck(await H.currentTab())).text);
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
    { group: "Accounts", icon: "🔍", name: "Check my identity before signing in", prompt: CHECK_PROMPT },
    { group: "Accounts", icon: "🌐", name: "Check my exit IP",
      prompt: "Run browser_identity_proxy and tell me what the world sees as my exit: IP, country, latency, whether the request went through the proxy the extension expects, and whether the country fits my profile's language and time zone." },
    { group: "Accounts", icon: "🕳", name: "Leak check this tab",
      prompt: "Run browser_identity_leaks on this tab and explain every ⚠ in plain words — what leaks, what a site could learn from it, and how to fix it (WebRTC policy, the profile's time zone or language, the window size) — before I sign in." }
  );

  globalThis.AgentExtras.audit = {
    TRACE_URL: TRACE_URL, TRACE_TIMEOUT: TRACE_TIMEOUT, WEBRTC_WAIT: WEBRTC_WAIT,
    probePage: probePage, siteOf: siteOf, osOfUa: osOfUa, osOfPlatform: osOfPlatform, browserOfUa: browserOfUa, summarizeDevice: summarizeDevice,
    checks: checks, verdict: verdict, formatReport: formatReport, bytes: bytes, utcOffset: utcOffset, collect: collect,
    probeLeaks: probeLeaks, parseLangs: parseLangs, langCountry: langCountry, tzCountry: tzCountry, parseTrace: parseTrace, assessExit: assessExit,
    candidateAddress: candidateAddress, webrtcLeaks: webrtcLeaks, zoneOffset: zoneOffset, leakFindings: leakFindings, formatLeaks: formatLeaks,
    windowExpectations: windowExpectations, expectedProxy: expectedProxy, fetchTrace: fetchTrace, exitCheck: exitCheck, leakCheck: leakCheck,
  };
})();
