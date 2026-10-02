// ═══════════════════════════════════════════════════════════════════════════
// PROFILE MANAGER v2 — Isolated browser profiles with saved sessions
//
// Each profile = own UA + proxy + cookies + window + agent chat + context notes
// Profiles stored in chrome.storage.local
// Agent context = local notes that AI reads to orient itself
// ═══════════════════════════════════════════════════════════════════════════
(function () {
  console.log("[Profiles] v3 loaded — " + new Date().toISOString());
  var STORAGE_KEY = "agentProfiles";
  var ACTIVE_KEY = "agentActiveProfile";
  var LOG_KEY = "agentProfileLogs";

  // Track which windows belong to which profiles
  var profileWindows = {}; // profileId -> windowId

  // ── CDP helper (chrome.debugger) ──────────────────────────────────────
  // Background: browserTools.js имеет свой cdp(), но он локальный.
  // Design: дублируем минимальный CDP-хелпер для profiles — attach + sendCommand.
  var _attached = {};
  chrome.debugger.onDetach.addListener(function(source) { delete _attached[source.tabId]; });
  async function cdp(tabId, method, params) {
    if (!_attached[tabId]) {
      try {
        await chrome.debugger.attach({ tabId: tabId }, "1.3");
        _attached[tabId] = true;
      } catch (e) {
        if (!/already attached/i.test(String(e))) throw e;
        _attached[tabId] = true;
      }
    }
    return chrome.debugger.sendCommand({ tabId: tabId }, method, params || {});
  }

  // Apply UA + language + platform override via CDP
  // Background: CDP Network.setUserAgentOverride меняет HTTP-заголовки и navigator.userAgent,
  // но navigator.languages/platform не перезаписываются CDP — нужен content script injection.
  async function applyFingerprint(tabId, ua, platform, lang) {
    if (!tabId || !ua) return;
    console.log("[Profiles] Applying fingerprint to tab", tabId, "ua:", ua.slice(0, 50));
    try {
      await cdp(tabId, "Network.enable");
      await cdp(tabId, "Network.setUserAgentOverride", {
        userAgent: ua,
        platform: platform || "",
        acceptLanguage: lang || "",
      });
    } catch (e) {
      console.warn("[Profiles] CDP UA override failed:", e);
    }

    // navigator.languages + platform via page script injection
    if (lang || platform) {
      var langs = lang ? lang.split(",").map(function(l) { return l.replace(/;q=.*/, "").trim(); }) : [];
      var code = "(function(){";
      if (platform) code += "try{Object.defineProperty(navigator,'platform',{get:function(){return " + JSON.stringify(platform) + "}})}catch(e){}";
      if (langs.length) code += "try{Object.defineProperty(navigator,'languages',{get:function(){return " + JSON.stringify(langs) + "}})}catch(e){}";
      if (langs[0]) code += "try{Object.defineProperty(navigator,'language',{get:function(){return " + JSON.stringify(langs[0]) + "}})}catch(e){}";
      code += "})()";
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tabId },
          func: new Function(code),
          world: "MAIN",
          injectImmediately: true,
        });
      } catch (e) {
        console.warn("[Profiles] navigator override inject failed:", e);
      }
    }

    // Persist on navigation: re-apply CDP UA after every page load in this tab
    var onNav = function(updatedId, info) {
      if (updatedId !== tabId || info.status !== "loading") return;
      cdp(tabId, "Network.setUserAgentOverride", {
        userAgent: ua, platform: platform || "", acceptLanguage: lang || "",
      }).catch(function() {});
    };
    chrome.tabs.onUpdated.addListener(onNav);
    chrome.tabs.onRemoved.addListener(function(removedId) {
      if (removedId === tabId) chrome.tabs.onUpdated.removeListener(onNav);
    });
  }

  // ── UA GENERATOR ────────────────────────────────────────────────────────

  var CV = ["120.0.6099.130","122.0.6261.94","124.0.6367.91","126.0.6478.126","128.0.6613.84","130.0.6723.58","132.0.6834.110","134.0.6998.89","136.0.7103.92","140.0.7280.67","145.0.7521.62","148.0.7663.56","150.0.7800.44","152.0.7920.62"];
  var FV = ["122.0","125.0","128.0","130.0","132.0","134.0","135.0"];
  var SV = ["17.0","17.2","17.4","17.5","18.0","18.1"];
  var EV = ["120.0.2210.77","130.0.2849.46","140.0.3498.28","145.0.3812.59","150.0.4115.43","152.0.4234.46"];
  var WV = ["10.0","11.0"];
  var MV = ["13_0","13_3","14_0","14_2","14_5","15_0","15_1"];
  var IV = ["16_2","17_0","17_2","17_4","17_5","18_0"];
  var AV = ["12","13","14","15"];
  var AD = ["Pixel 7","Pixel 8","Pixel 8 Pro","Pixel 9","SM-S911B","SM-S918B","SM-S928B","SM-A546B","M2101K6G","23078PND5G"];
  var LANGS = ["en-US,en;q=0.9","en-GB,en;q=0.9","de-DE,de;q=0.9,en;q=0.8","fr-FR,fr;q=0.9,en;q=0.8","es-ES,es;q=0.9,en;q=0.8","ru-RU,ru;q=0.9,en;q=0.8","ja-JP,ja;q=0.9,en;q=0.8","zh-CN,zh;q=0.9,en;q=0.8","pt-BR,pt;q=0.9,en;q=0.8","ko-KR,ko;q=0.9,en;q=0.8","tr-TR,tr;q=0.9,en;q=0.8"];
  var SCREENS_D = ["1920x1080","2560x1440","1366x768","1536x864","3840x2160"];
  var SCREENS_M = ["390x844","393x852","414x896","430x932","375x812"];

  function pick(a) { return a[Math.floor(Math.random() * a.length)]; }
  function rInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

  var GEN = {
    "win-chrome": function() { var v=pick(CV); return { ua:"Mozilla/5.0 (Windows NT "+pick(WV)+"; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/"+v+" Safari/537.36", platform:"Win32", screen:pick(SCREENS_D), label:"Win Chrome "+v.split(".")[0] }; },
    "win-edge": function() { var v=pick(EV); return { ua:"Mozilla/5.0 (Windows NT "+pick(WV)+"; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/"+v+" Safari/537.36 Edg/"+v, platform:"Win32", screen:pick(SCREENS_D), label:"Win Edge "+v.split(".")[0] }; },
    "win-firefox": function() { var v=pick(FV); return { ua:"Mozilla/5.0 (Windows NT "+pick(WV)+"; Win64; x64; rv:"+v+") Gecko/20100101 Firefox/"+v, platform:"Win32", screen:pick(SCREENS_D), label:"Win FF "+v }; },
    "mac-chrome": function() { var v=pick(CV); return { ua:"Mozilla/5.0 (Macintosh; Intel Mac OS X "+pick(MV)+") AppleWebKit/537.36 (KHTML, like Gecko) Chrome/"+v+" Safari/537.36", platform:"MacIntel", screen:pick(["1440x900","2560x1600","1680x1050","2880x1800"]), label:"Mac Chrome "+v.split(".")[0] }; },
    "mac-safari": function() { var v=pick(SV); return { ua:"Mozilla/5.0 (Macintosh; Intel Mac OS X "+pick(MV)+") AppleWebKit/605.1.15 (KHTML, like Gecko) Version/"+v+" Safari/605.1.15", platform:"MacIntel", screen:pick(["1440x900","2560x1600","2880x1800"]), label:"Mac Safari "+v }; },
    "iphone": function() { var v=pick(SV); return { ua:"Mozilla/5.0 (iPhone; CPU iPhone OS "+pick(IV)+" like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/"+v+" Mobile/15E148 Safari/604.1", platform:"iPhone", screen:pick(SCREENS_M), label:"iPhone "+v }; },
    "android": function() { var d=pick(AD),v=pick(CV); return { ua:"Mozilla/5.0 (Linux; Android "+pick(AV)+"; "+d+") AppleWebKit/537.36 (KHTML, like Gecko) Chrome/"+v+" Mobile Safari/537.36", platform:"Linux armv8l", screen:pick(["412x915","393x873","360x800"]), label:"Android "+d.split(" ")[0] }; },
    "linux": function() { var v=pick(CV); return { ua:"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/"+v+" Safari/537.36", platform:"Linux x86_64", screen:pick(SCREENS_D), label:"Linux Chrome "+v.split(".")[0] }; },
  };

  function genUA(type) { return (GEN[type] || GEN[pick(Object.keys(GEN))])(); }

  // ── STORAGE ─────────────────────────────────────────────────────────────

  async function load() { return ((await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY]) || {}; }
  async function save(p) { await chrome.storage.local.set({[STORAGE_KEY]: p}); }
  async function getLogs() { return ((await chrome.storage.local.get(LOG_KEY))[LOG_KEY]) || {}; }
  async function log(pid, action) {
    var logs = await getLogs();
    if (!logs[pid]) logs[pid] = [];
    logs[pid].push({ t: Date.now(), a: action });
    if (logs[pid].length > 300) logs[pid] = logs[pid].slice(-300);
    await chrome.storage.local.set({[LOG_KEY]: logs});
  }

  // ── PROFILE ACTIVATION ──────────────────────────────────────────────────

  async function activateProfile(pid) {
    var profiles = await load();
    var p = profiles[pid];
    if (!p) return;

    // 1. Open a new window for the profile via background script
    // Background: chrome.windows.create не работает из side panel в Edge —
    // возвращает null. Design: делегируем в background.js через sendMessage,
    // background имеет полный доступ к chrome.windows API.
    var url = p.startUrl || "chrome://newtab";
    console.log("[Profiles] Launching profile", pid, "url:", url);
    var winData = null;
    try {
      winData = await chrome.runtime.sendMessage({
        type: "createWindow",
        options: { url: url, focused: true }
      });
    } catch (e) {
      console.error("[Profiles] createWindow message failed:", e);
    }
    console.log("[Profiles] createWindow response:", JSON.stringify(winData));
    var winId = (winData && winData.ok && winData.win) ? winData.win.id : null;
    var firstTabId = (winData && winData.ok && winData.win && winData.win.tabs && winData.win.tabs[0]) ? winData.win.tabs[0].id : null;
    if (!winId) {
      console.error("[Profiles] No window created");
      await log(pid, "Launch failed — no window");
      return null;
    }
    console.log("[Profiles] Window created, id:", winId, "tab:", firstTabId);
    profileWindows[pid] = winId;

    // 2. Set proxy if configured
    if (p.proxy && p.proxy.enabled) {
      // Send proxy config to background
      var proxyConfig = {
        enabled: true,
        type: p.proxy.type || "http",
        host: p.proxy.host,
        port: Number(p.proxy.port),
        username: p.proxy.username || "",
        password: p.proxy.password || "",
      };
      await chrome.storage.local.set({ agentProxy: proxyConfig });
    }

    // 3. Import cookies after window loads
    if (p.cookies && p.cookies.length && firstTabId) {
      await new Promise(function(r) { setTimeout(r, 1500); });
      for (var i = 0; i < p.cookies.length; i++) {
        var c = p.cookies[i];
        try {
          var proto = c.secure ? "https://" : "http://";
          var cookieUrl = c.url || (proto + c.domain.replace(/^\./, "") + (c.path || "/"));
          await chrome.cookies.set({
            url: cookieUrl, name: c.name, value: c.value,
            domain: c.domain, path: c.path || "/",
            secure: c.secure || false, httpOnly: c.httpOnly || false,
            sameSite: c.sameSite || "lax",
            expirationDate: c.expirationDate || (Math.floor(Date.now()/1000) + 86400*365),
          });
        } catch (e) { /* some cookies may fail */ }
      }
      if (url !== "chrome://newtab") {
        chrome.tabs.update(firstTabId, { url: url });
      }
    }

    // 4. Apply UA/fingerprint directly via CDP (no chat messages needed)
    if (firstTabId && p.ua) {
      await applyFingerprint(firstTabId, p.ua, p.platform, p.lang);
      // Reload tab to apply the UA to the actual page
      try { await chrome.tabs.reload(firstTabId); } catch (e) {}
    }

    await log(pid, "Profile activated" + (p.ua ? " — UA: " + p.ua.slice(0, 40) : ""));

    // 5. Send context to agent chat (if configured)
    if (p.agentContext) {
      setTimeout(function() {
        var input = document.getElementById("input");
        if (input) {
          input.value = "[PROFILE CONTEXT — read and remember]\n\n" + p.agentContext + "\n\nI just loaded profile '" + p.name + "'. Acknowledge the context briefly.";
          input.dispatchEvent(new Event("input", { bubbles: true }));
          var sendBtn = document.getElementById("send");
          if (sendBtn) sendBtn.click();
        }
      }, 500);
    }

    await chrome.storage.local.set({[ACTIVE_KEY]: pid});
    return win;
  }

  async function snapshotProfile(pid) {
    var profiles = await load();
    var p = profiles[pid];
    if (!p) return;

    // Get current UA
    try {
      var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs[0]) {
        var r = await chrome.scripting.executeScript({
          target: { tabId: tabs[0].id },
          func: function() { return { ua: navigator.userAgent, platform: navigator.platform, lang: navigator.language, url: location.href }; },
          world: "MAIN"
        });
        if (r && r[0] && r[0].result) {
          p.ua = r[0].result.ua;
          p.platform = r[0].result.platform;
          p.lang = r[0].result.lang;
          p.startUrl = r[0].result.url;
        }
      }
      // Snapshot cookies
      if (tabs[0] && tabs[0].url) {
        var domain = new URL(tabs[0].url).hostname;
        var cookies = await chrome.cookies.getAll({ domain: domain });
        p.cookies = cookies.map(function(c) {
          return { name:c.name, value:c.value, domain:c.domain, path:c.path, secure:c.secure, httpOnly:c.httpOnly, sameSite:c.sameSite, expirationDate:c.expirationDate };
        });
        p.cookieCount = p.cookies.length;
        p.lastDomain = domain;
      }
    } catch(e) {}

    p.updated = Date.now();
    await save(profiles);
    await log(pid, "Snapshot saved (" + (p.cookieCount||0) + " cookies, URL: " + (p.startUrl||"?").slice(0,50) + ")");
    return p;
  }

  // ── UI PANEL ────────────────────────────────────────────────────────────

  var panel = document.getElementById("commands-panel");
  if (!panel) return;

  var pp = document.createElement("div");
  pp.id = "profiles-panel";
  pp.className = "hidden";
  pp.innerHTML = [
    '<div class="cmd-header"><span>👤 Profiles</span><button id="profClose" class="icon-btn">✕</button></div>',
    '<div class="prof-tabs">',
    '  <button class="prof-tab active" data-tab="profiles">📋 Profiles</button>',
    '  <button class="prof-tab" data-tab="ua">🎭 UA Gen</button>',
    '  <button class="prof-tab" data-tab="log">📜 Log</button>',
    '</div>',
    '<div id="profContent" class="cmd-list"></div>',
  ].join("");
  panel.parentNode.insertBefore(pp, panel.nextSibling);

  // Toolbar button
  var cmdBtn = document.getElementById("cmdBtn");
  if (cmdBtn) {
    var profBtn = document.createElement("button");
    profBtn.id = "profBtn";
    profBtn.className = "icon-btn";
    profBtn.title = "Profiles & UA";
    profBtn.textContent = "👤";
    cmdBtn.parentNode.insertBefore(profBtn, cmdBtn);
    profBtn.onclick = function() { pp.classList.toggle("hidden"); if(!pp.classList.contains("hidden")) renderCurrent(); };
  }
  pp.querySelector("#profClose").onclick = function() { pp.classList.add("hidden"); };

  var content = pp.querySelector("#profContent");
  var curTab = "profiles";
  pp.querySelectorAll(".prof-tab").forEach(function(t) {
    t.onclick = function() {
      pp.querySelectorAll(".prof-tab").forEach(function(x){x.classList.remove("active");});
      t.classList.add("active");
      curTab = t.dataset.tab;
      renderCurrent();
    };
  });

  function renderCurrent() {
    if (curTab === "profiles") renderProfiles();
    else if (curTab === "ua") renderUA();
    else renderLog();
  }

  function esc(s) { return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
  function ago(ts) {
    if (!ts) return "never";
    var d = Date.now() - ts;
    if (d < 60000) return "just now";
    if (d < 3600000) return Math.floor(d/60000)+"m ago";
    if (d < 86400000) return Math.floor(d/3600000)+"h ago";
    return Math.floor(d/86400000)+"d ago";
  }

  // ── PROFILES TAB ──────────────────────────────────────────────────────

  async function renderProfiles() {
    var profiles = await load();
    var ids = Object.keys(profiles).sort(function(a,b){ return (profiles[b].updated||0)-(profiles[a].updated||0); });
    content.innerHTML = "";

    // New profile button
    var nb = document.createElement("div"); nb.className = "cmd-item";
    nb.innerHTML = '<span class="cmd-icon">➕</span><div class="cmd-body"><div class="cmd-name">New Profile</div><div class="cmd-desc">Create a full isolated profile (UA + proxy + cookies + context)</div></div>';
    nb.onclick = function() { showEditor(null); };
    content.appendChild(nb);

    if (!ids.length) {
      var empty = document.createElement("div");
      empty.style.cssText = "padding:20px;text-align:center;color:#888";
      empty.innerHTML = "No profiles yet.<br>Create one to get started.";
      content.appendChild(empty);
      return;
    }

    ids.forEach(function(id) {
      var p = profiles[id];
      var item = document.createElement("div"); item.className = "cmd-item";
      var proxyLabel = p.proxy && p.proxy.enabled ? "🟢 " + p.proxy.type + "://" + p.proxy.host + ":" + p.proxy.port : "🔴 direct";
      item.innerHTML =
        '<span class="cmd-icon">' + (p.icon||"👤") + '</span>' +
        '<div class="cmd-body">' +
        '<div class="cmd-name">' + esc(p.name) + '</div>' +
        '<div class="cmd-desc">' + esc(p.label || (p.ua||"").slice(0,50)) + '</div>' +
        '<div class="cmd-desc">Proxy: ' + proxyLabel + ' · Cookies: ' + (p.cookieCount||0) + ' · ' + ago(p.updated) + '</div>' +
        (p.agentContext ? '<div class="cmd-desc">📝 Context: ' + esc(p.agentContext.slice(0,60)) + '...</div>' : '') +
        '</div>' +
        '<div class="prof-actions" style="flex-direction:column;gap:2px">' +
        '<button class="prof-btn" data-a="launch" title="Launch profile">▶</button>' +
        '<button class="prof-btn" data-a="snap" title="Save current state">💾</button>' +
        '<button class="prof-btn" data-a="edit" title="Edit">✏️</button>' +
        '<button class="prof-btn" data-a="del" title="Delete">🗑</button>' +
        '</div>';
      item.querySelector('[data-a="launch"]').onclick = function(e) { e.stopPropagation(); activateProfile(id).then(function(){ pp.classList.add("hidden"); }); };
      item.querySelector('[data-a="snap"]').onclick = function(e) { e.stopPropagation(); snapshotProfile(id).then(renderProfiles); };
      item.querySelector('[data-a="edit"]').onclick = function(e) { e.stopPropagation(); showEditor(id); };
      item.querySelector('[data-a="del"]').onclick = function(e) { e.stopPropagation(); if(confirm("Delete '"+p.name+"'?")){ deleteProfile(id); } };
      content.appendChild(item);
    });
  }

  async function deleteProfile(id) {
    var p = await load(); delete p[id]; await save(p); renderProfiles();
  }

  // ── PROFILE EDITOR ────────────────────────────────────────────────────

  async function showEditor(id) {
    var profiles = await load();
    var p = id ? profiles[id] : { name:"", icon:"👤", ua:"", platform:"", lang:"", proxy:{}, cookies:[], agentContext:"", startUrl:"" };
    var isNew = !id;
    var icons = ["👤","👨","👩","🧑","👨‍💻","👩‍💻","🕵️","🤖","👽","🦊","🐱","🐶","🦸","🧙","💼","🎭"];

    content.innerHTML =
      '<div style="padding:12px;overflow-y:auto">' +
      '<button id="edBack" class="prof-btn">← Back</button>' +
      '<h3 style="margin:8px 0;color:#ddd">' + (isNew ? "New Profile" : "Edit: " + esc(p.name)) + '</h3>' +

      '<label class="ed-label">Name<input id="edName" value="' + esc(p.name) + '" placeholder="My Account #1" /></label>' +

      '<label class="ed-label">Icon<div class="ed-icons" id="edIcons">' +
      icons.map(function(i){ return '<span class="ed-icon'+(i===p.icon?' active':'')+'" data-i="'+i+'">'+i+'</span>'; }).join("") +
      '</div></label>' +

      '<div class="ed-section">🎭 Fingerprint</div>' +
      '<label class="ed-label">UA preset<select id="edUAPreset"><option value="">Custom / keep current</option>' +
      Object.keys(GEN).map(function(k){ return '<option value="'+k+'">'+k+'</option>'; }).join("") +
      '<option value="random">🎲 Random</option></select></label>' +
      '<label class="ed-label">User-Agent<textarea id="edUA" rows="2" placeholder="Mozilla/5.0...">' + esc(p.ua) + '</textarea></label>' +
      '<div class="ed-row">' +
      '<label class="ed-label">Platform<input id="edPlat" value="' + esc(p.platform) + '" placeholder="Win32" /></label>' +
      '<label class="ed-label">Language<input id="edLang" value="' + esc(p.lang) + '" placeholder="en-US,en;q=0.9" /></label>' +
      '</div>' +

      '<div class="ed-section">🌐 Proxy</div>' +
      '<label class="ed-label"><input type="checkbox" id="edProxyOn" ' + (p.proxy&&p.proxy.enabled?"checked":"") + ' /> Enable proxy</label>' +
      '<div class="ed-row">' +
      '<label class="ed-label">Type<select id="edProxyType"><option value="http"'+(p.proxy&&p.proxy.type==="http"?" selected":"")+'>HTTP</option><option value="https"'+(p.proxy&&p.proxy.type==="https"?" selected":"")+'>HTTPS</option><option value="socks5"'+(p.proxy&&p.proxy.type==="socks5"?" selected":"")+'>SOCKS5</option></select></label>' +
      '<label class="ed-label">Host<input id="edProxyHost" value="' + esc(p.proxy&&p.proxy.host) + '" placeholder="proxy.example.com" /></label>' +
      '<label class="ed-label">Port<input id="edProxyPort" type="number" value="' + (p.proxy&&p.proxy.port||"") + '" placeholder="8080" /></label>' +
      '</div>' +
      '<div class="ed-row">' +
      '<label class="ed-label">Username<input id="edProxyUser" value="' + esc(p.proxy&&p.proxy.username) + '" /></label>' +
      '<label class="ed-label">Password<input id="edProxyPass" type="password" value="' + esc(p.proxy&&p.proxy.password) + '" /></label>' +
      '</div>' +

      '<div class="ed-section">🌍 Start URL</div>' +
      '<label class="ed-label"><input id="edUrl" value="' + esc(p.startUrl) + '" placeholder="https://facebook.com" /></label>' +

      '<div class="ed-section">📝 Agent Context <span style="color:#888;font-weight:normal">(AI reads this when profile loads)</span></div>' +
      '<textarea id="edCtx" rows="6" placeholder="This profile is for...\nAccount: ...\nWorkflow: ...\nCurrent status: ...\nImportant URLs: ...">' + esc(p.agentContext) + '</textarea>' +

      '<div class="ed-section">🍪 Cookies</div>' +
      '<div class="cmd-desc">' + (p.cookies&&p.cookies.length||0) + ' cookies saved. Use 💾 button to snapshot current cookies.</div>' +

      '<div style="margin-top:16px;display:flex;gap:8px">' +
      '<button id="edSave" class="prof-btn" style="padding:8px 20px;font-size:14px;background:var(--vscode-button-background,#0e639c);color:#fff;border:none">💾 Save</button>' +
      '<button id="edCancel" class="prof-btn" style="padding:8px 16px">Cancel</button>' +
      '</div>' +
      '</div>';

    // Icon picker
    content.querySelectorAll(".ed-icon").forEach(function(el) {
      el.onclick = function() {
        content.querySelectorAll(".ed-icon").forEach(function(x){x.classList.remove("active");});
        el.classList.add("active");
      };
    });

    // UA preset
    content.querySelector("#edUAPreset").onchange = function() {
      var val = this.value;
      if (!val) return;
      var fp = genUA(val === "random" ? null : val);
      content.querySelector("#edUA").value = fp.ua;
      content.querySelector("#edPlat").value = fp.platform;
      content.querySelector("#edLang").value = pick(LANGS);
    };

    // Save
    content.querySelector("#edSave").onclick = async function() {
      var pid = id || ("prof_" + Date.now().toString(36) + Math.random().toString(36).slice(2,6));
      var profiles = await load();
      var activeIcon = content.querySelector(".ed-icon.active");
      profiles[pid] = {
        name: content.querySelector("#edName").value || "Unnamed",
        icon: activeIcon ? activeIcon.dataset.i : "👤",
        ua: content.querySelector("#edUA").value,
        platform: content.querySelector("#edPlat").value,
        lang: content.querySelector("#edLang").value,
        label: (function(){ var fp = content.querySelector("#edUA").value; return fp.slice(0,50); })(),
        proxy: {
          enabled: content.querySelector("#edProxyOn").checked,
          type: content.querySelector("#edProxyType").value,
          host: content.querySelector("#edProxyHost").value,
          port: content.querySelector("#edProxyPort").value,
          username: content.querySelector("#edProxyUser").value,
          password: content.querySelector("#edProxyPass").value,
        },
        startUrl: content.querySelector("#edUrl").value,
        agentContext: content.querySelector("#edCtx").value,
        cookies: (p.cookies || []),
        cookieCount: (p.cookies || []).length,
        created: p.created || Date.now(),
        updated: Date.now(),
      };
      await save(profiles);
      await log(pid, isNew ? "Profile created" : "Profile edited");
      renderProfiles();
    };

    content.querySelector("#edCancel").onclick = renderProfiles;
    content.querySelector("#edBack").onclick = renderProfiles;
  }

  // ── UA GEN TAB ────────────────────────────────────────────────────────

  function renderUA() {
    content.innerHTML = "";
    // Random button
    var rb = document.createElement("div"); rb.className = "cmd-item";
    rb.innerHTML = '<span class="cmd-icon">🎲</span><div class="cmd-body"><div class="cmd-name">Random fingerprint</div><div class="cmd-desc">Generate and apply a completely random device</div></div>';
    rb.onclick = function() { applyUA(genUA()); };
    content.appendChild(rb);

    Object.keys(GEN).forEach(function(type) {
      var fp = genUA(type);
      var item = document.createElement("div"); item.className = "cmd-item";
      item.innerHTML =
        '<div class="cmd-body" style="width:100%">' +
        '<div class="cmd-name">' + esc(fp.label) + '</div>' +
        '<div class="cmd-desc" style="word-break:break-all;font-family:monospace;font-size:10px">' + esc(fp.ua) + '</div>' +
        '<div class="cmd-desc">Platform: ' + esc(fp.platform) + ' · Screen: ' + fp.screen + '</div>' +
        '</div>' +
        '<div class="prof-actions">' +
        '<button class="prof-btn" data-a="apply" title="Apply">▶</button>' +
        '<button class="prof-btn" data-a="copy" title="Copy">📋</button>' +
        '</div>';
      item.querySelector('[data-a="apply"]').onclick = function(e) { e.stopPropagation(); applyUA(fp); };
      item.querySelector('[data-a="copy"]').onclick = function(e) { e.stopPropagation(); navigator.clipboard.writeText(fp.ua); e.target.textContent="✓"; setTimeout(function(){e.target.textContent="📋";},800); };
      content.appendChild(item);
    });
  }

  function applyUA(fp) {
    var input = document.getElementById("input");
    input.value = "Set User-Agent to: " + fp.ua + " — platform: " + fp.platform + " — language: " + pick(LANGS) + ". Then reload the page.";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    document.getElementById("send").click();
    pp.classList.add("hidden");
  }

  // ── LOG TAB ───────────────────────────────────────────────────────────

  async function renderLog() {
    var profiles = await load();
    var logs = await getLogs();
    content.innerHTML = "";
    var all = [];
    Object.keys(logs).forEach(function(pid) {
      var name = profiles[pid] ? profiles[pid].name : "[deleted]";
      var icon = profiles[pid] ? profiles[pid].icon : "❌";
      logs[pid].forEach(function(l) { all.push({t:l.t, a:l.a, name:name, icon:icon}); });
    });
    all.sort(function(a,b){ return b.t - a.t; });
    all = all.slice(0, 100);

    if (!all.length) {
      content.innerHTML = '<div style="padding:20px;text-align:center;color:#888">No activity yet.</div>';
      return;
    }

    var lastDay = "";
    all.forEach(function(ev) {
      var d = new Date(ev.t);
      var day = d.toDateString();
      if (day !== lastDay) {
        lastDay = day;
        var today = new Date().toDateString();
        var label = day === today ? "Today" : day === new Date(Date.now()-86400000).toDateString() ? "Yesterday" : d.toLocaleDateString();
        var h = document.createElement("div"); h.className = "cmd-group-title"; h.textContent = label;
        content.appendChild(h);
      }
      var item = document.createElement("div"); item.className = "cmd-item";
      item.innerHTML = '<span class="cmd-icon">' + ev.icon + '</span><div class="cmd-body"><div class="cmd-name">' + esc(ev.name) + '</div><div class="cmd-desc">' + d.toLocaleTimeString() + " — " + esc(ev.a) + '</div></div>';
      content.appendChild(item);
    });
  }

  // Expose for tools
  window.AgentProfiles = { genUA: genUA, GEN: GEN, activate: activateProfile, snapshot: snapshotProfile, load: load, save: save, log: log };
})();
