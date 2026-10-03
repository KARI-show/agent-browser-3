// 👤 Profiles panel — the UI over the device profiles the browser_profile_*
// tools manage (chrome.storage.local "agentProfiles"): identity (User-Agent,
// platform, language), proxy, saved cookies, start URL and notes.
//
// Launch, save and delete go through the very same tool implementations the
// agent uses (window.AgentBrowserTools.run), so there is one code path and one
// behaviour whether a profile is started by a click or by the model. The panel
// never synthesises chat messages: a profile's notes reach the agent as the
// launch tool's output, not as words put in the user's mouth.
(function () {
  var STORAGE_KEY = "agentProfiles";
  var LOG_KEY = "agentProfileLogs";
  var ACTIVE_KEY = "agentActiveProfile";
  var ICONS = ["👤", "👨", "👩", "🧑", "👨‍💻", "👩‍💻", "🕵️", "🤖", "👽", "🦊", "🐱", "🐶", "🦸", "🧙", "💼", "🎭"];

  function tools() { return window.AgentBrowserTools; }
  async function load() { return ((await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY]) || {}; }
  async function save(p) { await chrome.storage.local.set({ [STORAGE_KEY]: p }); }
  async function getLogs() { return ((await chrome.storage.local.get(LOG_KEY))[LOG_KEY]) || {}; }
  async function log(pid, action) {
    var logs = await getLogs();
    (logs[pid] = logs[pid] || []).push({ t: Date.now(), a: action });
    if (logs[pid].length > 300) logs[pid] = logs[pid].slice(-300);
    await chrome.storage.local.set({ [LOG_KEY]: logs });
  }

  /** Run a browser tool and return its text output. */
  function runTool(name, args) {
    if (!tools()) return Promise.reject(new Error("The browser tools didn't load."));
    return tools().run(name, args).then(function (content) {
      return (content || []).filter(function (p) { return p.type === "text"; }).map(function (p) { return p.text; }).join("\n");
    });
  }

  // ── DOM helpers (no innerHTML: names, notes and icons come from storage the agent writes) ──

  function el(tag, props, children) {
    var n = document.createElement(tag);
    if (props) Object.keys(props).forEach(function (k) {
      if (k === "className") n.className = props[k];
      else if (k === "dataset") Object.assign(n.dataset, props[k]);
      else if (k.indexOf("on") === 0) n.addEventListener(k.slice(2), props[k]);
      else if (k in n) n[k] = props[k];
      else n.setAttribute(k, props[k]);
    });
    (children || []).forEach(function (c) {
      if (c == null) return;
      n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return n;
  }
  function field(label, input) { return el("label", { className: "ed-label" }, [label, input]); }
  function ago(ts) {
    if (!ts) return "never";
    var d = Date.now() - ts;
    if (d < 60000) return "just now";
    if (d < 3600000) return Math.floor(d / 60000) + "m ago";
    if (d < 86400000) return Math.floor(d / 3600000) + "h ago";
    return Math.floor(d / 86400000) + "d ago";
  }
  function proxyLabel(p) {
    return p.proxy && p.proxy.enabled && p.proxy.host ? p.proxy.type + "://" + p.proxy.host + ":" + p.proxy.port : "direct";
  }

  // ── Panel ─────────────────────────────────────────────────────────────

  var cmdPanel = document.getElementById("commands-panel");
  var cmdBtn = document.getElementById("cmdBtn");
  if (!cmdPanel || !cmdBtn) return;

  var content = el("div", { id: "profContent", className: "cmd-list" });
  var statusLine = el("div", { id: "profStatus", className: "prof-status hidden" });
  var closeBtn = el("button", { id: "profClose", className: "icon-btn", title: "Close", onclick: hide }, ["✕"]);
  var tabsBar = el("div", { className: "prof-tabs" });
  var pp = el("div", { id: "profiles-panel", className: "hidden" }, [
    el("div", { className: "cmd-header" }, [el("span", null, ["👤 Device profiles"]), closeBtn]),
    tabsBar,
    statusLine,
    content,
  ]);
  cmdPanel.parentNode.insertBefore(pp, cmdPanel.nextSibling);

  var profBtn = el("button", { id: "profBtn", className: "icon-btn", title: "Device profiles & User-Agent presets", "aria-label": "Device profiles" }, ["👤"]);
  cmdBtn.parentNode.insertBefore(profBtn, cmdBtn);
  profBtn.addEventListener("click", function () {
    if (pp.classList.contains("hidden")) { pp.classList.remove("hidden"); renderCurrent(); }
    else hide();
  });
  function hide() { pp.classList.add("hidden"); }

  var curTab = "profiles";
  [["profiles", "📋 Profiles"], ["ua", "🎭 UA presets"], ["log", "📜 Log"]].forEach(function (t) {
    var b = el("button", { className: "prof-tab" + (t[0] === curTab ? " active" : ""), dataset: { tab: t[0] } }, [t[1]]);
    b.addEventListener("click", function () {
      tabsBar.querySelectorAll(".prof-tab").forEach(function (x) { x.classList.remove("active"); });
      b.classList.add("active");
      curTab = t[0];
      status("");
      renderCurrent();
    });
    tabsBar.appendChild(b);
  });

  function status(text) {
    statusLine.textContent = text || "";
    statusLine.classList.toggle("hidden", !text);
  }

  function renderCurrent() {
    if (curTab === "profiles") renderProfiles();
    else if (curTab === "ua") renderUA();
    else renderLog();
  }

  // ── Profiles tab ──────────────────────────────────────────────────────

  async function renderProfiles() {
    var profiles = await load();
    var active = (await chrome.storage.local.get(ACTIVE_KEY))[ACTIVE_KEY];
    var ids = Object.keys(profiles).sort(function (a, b) { return (profiles[b].updated || 0) - (profiles[a].updated || 0); });
    content.textContent = "";

    content.appendChild(el("div", { className: "cmd-item", onclick: function () { showEditor(null); } }, [
      el("span", { className: "cmd-icon" }, ["➕"]),
      el("div", { className: "cmd-body" }, [
        el("div", { className: "cmd-name" }, ["New profile"]),
        el("div", { className: "cmd-desc" }, ["Identity (User-Agent, platform, language) + proxy + saved cookies + notes for the agent"]),
      ]),
    ]));

    if (!ids.length) {
      content.appendChild(el("div", { className: "cmd-empty" }, ["No profiles yet. Create one to get started."]));
      return;
    }

    ids.forEach(function (id) {
      var p = profiles[id];
      var actions = el("div", { className: "prof-actions column" }, [
        el("button", { className: "prof-btn", title: "Launch: open a window with this identity, proxy and session", onclick: function (e) { e.stopPropagation(); launch(id); } }, ["▶"]),
        el("button", { className: "prof-btn", title: "Save the current tab's cookies and URL into this profile", onclick: function (e) { e.stopPropagation(); snapshot(id); } }, ["💾"]),
        el("button", { className: "prof-btn", title: "Edit", onclick: function (e) { e.stopPropagation(); showEditor(id); } }, ["✏️"]),
        el("button", { className: "prof-btn", title: "Delete", onclick: function (e) { e.stopPropagation(); if (confirm("Delete '" + p.name + "'?")) remove(id); } }, ["🗑"]),
      ]);
      var meta = "Proxy: " + proxyLabel(p) + " · Cookies: " + (p.cookieCount || 0) + (p.lastDomain ? " (" + p.lastDomain + ")" : "") + " · " + ago(p.updated);
      content.appendChild(el("div", { className: "cmd-item" + (id === active ? " active" : "") }, [
        el("span", { className: "cmd-icon" }, [p.icon || "👤"]),
        el("div", { className: "cmd-body" }, [
          el("div", { className: "cmd-name" }, [p.name + (id === active ? " · active" : "")]),
          el("div", { className: "cmd-desc" }, [p.label || (p.ua || "browser default").slice(0, 50)]),
          el("div", { className: "cmd-desc" }, [meta]),
          p.agentContext ? el("div", { className: "cmd-desc" }, ["📝 " + String(p.agentContext).slice(0, 60) + (p.agentContext.length > 60 ? "…" : "")]) : null,
        ]),
        actions,
      ]));
    });
  }

  function launch(id) {
    status("Launching…");
    runTool("browser_profile_launch", { profileId: id }).then(
      function (out) { status(out.split("\n").slice(0, 3).join(" · ")); setTimeout(function () { hide(); status(""); }, 1500); },
      function (e) { status("⚠ " + ((e && e.message) || e)); }
    );
  }
  function snapshot(id) {
    status("Saving the current tab's session…");
    runTool("browser_profile_save", { profileId: id }).then(
      function (out) { status(out); renderProfiles(); },
      function (e) { status("⚠ " + ((e && e.message) || e)); }
    );
  }
  function remove(id) {
    runTool("browser_profile_delete", { profileId: id }).then(
      function () { status(""); renderProfiles(); },
      function (e) { status("⚠ " + ((e && e.message) || e)); }
    );
  }

  // ── Editor ────────────────────────────────────────────────────────────

  async function showEditor(id) {
    var profiles = await load();
    var p = (id && profiles[id]) || { name: "", icon: "👤", ua: "", platform: "", lang: "", proxy: {}, cookies: [], agentContext: "", startUrl: "" };
    var isNew = !id;
    var chosenIcon = p.icon || "👤";
    var presetLabel = null; // set when a preset filled the UA fields
    var prox = p.proxy || {};

    var name = el("input", { value: p.name || "", placeholder: "Work account" });
    var ua = el("textarea", { rows: 2, placeholder: "Mozilla/5.0 … (pick a preset below or paste one)", value: p.ua || "" });
    var plat = el("input", { value: p.platform || "", placeholder: "Win32" });
    var lang = el("input", { value: p.lang || "", placeholder: "en-US,en;q=0.9" });
    var preset = el("select", null, [el("option", { value: "" }, ["Custom / keep current"])].concat(
      (tools() ? tools().uaPresetNames : []).map(function (k) { return el("option", { value: k }, [k]); }),
      [el("option", { value: "random" }, ["🎲 Random"])]
    ));
    preset.addEventListener("change", function () {
      if (!preset.value || !tools()) return;
      var fp = tools().uaPreset(preset.value === "random" ? null : preset.value);
      ua.value = fp.ua; plat.value = fp.platform; lang.value = fp.lang; presetLabel = fp.label;
    });
    var proxyOn = el("input", { type: "checkbox", checked: !!prox.enabled });
    var proxyType = el("select", null, ["http", "https", "socks5"].map(function (t) { return el("option", { value: t, selected: (prox.type || "http") === t }, [t.toUpperCase()]); }));
    var proxyHost = el("input", { value: prox.host || "", placeholder: "proxy.example.com" });
    var proxyPort = el("input", { type: "number", value: prox.port || "", placeholder: "8080" });
    var proxyUser = el("input", { value: prox.username || "", autocomplete: "off" });
    var proxyPass = el("input", { type: "password", value: prox.password || "", autocomplete: "new-password" });
    var startUrl = el("input", { value: p.startUrl || "", placeholder: "https://example.com" });
    var notes = el("textarea", { id: "edCtx", rows: 6, placeholder: "What this profile is for, which account, the usual workflow…", value: p.agentContext || "" });

    var icons = el("div", { className: "ed-icons" }, ICONS.map(function (i) {
      var s = el("span", { className: "ed-icon" + (i === chosenIcon ? " active" : "") }, [i]);
      s.addEventListener("click", function () {
        icons.querySelectorAll(".ed-icon").forEach(function (x) { x.classList.remove("active"); });
        s.classList.add("active");
        chosenIcon = i;
      });
      return s;
    }));

    var saveBtn = el("button", { className: "prof-btn primary" }, ["💾 Save"]);
    saveBtn.addEventListener("click", async function () {
      var pid = id || ("prof_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
      var all = await load();
      var prev = all[pid] || {};
      // Merge over what is stored: fields the editor doesn't show (cookies, lastDomain) survive an edit.
      all[pid] = Object.assign({}, prev, {
        name: name.value.trim() || "Unnamed",
        icon: chosenIcon,
        ua: ua.value.trim(),
        platform: plat.value.trim(),
        lang: lang.value.trim(),
        label: presetLabel || (ua.value.trim() ? ua.value.trim().slice(0, 50) : "browser default"),
        proxy: {
          enabled: proxyOn.checked,
          type: proxyType.value,
          host: proxyHost.value.trim(),
          port: proxyPort.value.trim(),
          username: proxyUser.value,
          password: proxyPass.value,
        },
        startUrl: startUrl.value.trim(),
        agentContext: notes.value,
        cookies: prev.cookies || [],
        cookieCount: (prev.cookies || []).length,
        created: prev.created || Date.now(),
        updated: Date.now(),
      });
      await save(all);
      await log(pid, isNew ? "Profile created" : "Profile edited");
      status("");
      renderProfiles();
    });

    content.textContent = "";
    content.appendChild(el("div", { className: "ed-wrap" }, [
      el("button", { className: "prof-btn", onclick: renderProfiles }, ["← Back"]),
      el("h3", { className: "ed-title" }, [isNew ? "New profile" : "Edit: " + p.name]),
      field("Name", name),
      el("label", { className: "ed-label" }, ["Icon", icons]),
      el("div", { className: "ed-section" }, ["🎭 Identity"]),
      field("Preset", preset),
      field("User-Agent", ua),
      el("div", { className: "ed-row" }, [field("Platform", plat), field("Language", lang)]),
      el("div", { className: "ed-section" }, ["🌐 Proxy (applies to the whole browser while the profile's window is open)"]),
      el("label", { className: "ed-label" }, [proxyOn, " Enable proxy"]),
      el("div", { className: "ed-row" }, [field("Type", proxyType), field("Host", proxyHost), field("Port", proxyPort)]),
      el("div", { className: "ed-row" }, [field("Username", proxyUser), field("Password", proxyPass)]),
      el("div", { className: "ed-section" }, ["🌍 Start URL"]),
      el("label", { className: "ed-label" }, [startUrl]),
      el("div", { className: "ed-section" }, ["📝 Notes for the agent ", el("span", { className: "ed-hint" }, ["(returned by the launch tool as data — the agent reads them, it doesn't obey them)"])]),
      notes,
      el("div", { className: "ed-section" }, ["🍪 Cookies"]),
      el("div", { className: "cmd-desc" }, [(p.cookies && p.cookies.length || 0) + " cookies saved" + (p.lastDomain ? " for " + p.lastDomain : "") + ". Use 💾 on the profile to snapshot the current tab's session."]),
      el("div", { className: "ed-actions" }, [saveBtn, el("button", { className: "prof-btn", onclick: renderProfiles }, ["Cancel"])]),
    ]));
  }

  // ── UA presets tab ────────────────────────────────────────────────────

  function renderUA() {
    content.textContent = "";
    if (!tools()) { content.appendChild(el("div", { className: "cmd-empty" }, ["The browser tools didn't load."])); return; }
    content.appendChild(el("div", { className: "cmd-desc ed-hint" }, ["Apply = override the User-Agent, platform and language of the tab the agent works in (browser_set_useragent). Chrome shows its debugging bar on that tab while it is on."]));
    [null].concat(tools().uaPresetNames).forEach(function (type) {
      var fp = tools().uaPreset(type);
      var apply = el("button", { className: "prof-btn", title: "Apply to the current tab" }, ["▶"]);
      var copy = el("button", { className: "prof-btn", title: "Copy the User-Agent string" }, ["📋"]);
      apply.addEventListener("click", function (e) {
        e.stopPropagation();
        status("Applying…");
        runTool("browser_set_useragent", { userAgent: fp.ua, platform: fp.platform, language: fp.lang }).then(
          function () { status("✓ " + fp.label + " — reload the page for the server to see it."); },
          function (err) { status("⚠ " + ((err && err.message) || err)); }
        );
      });
      copy.addEventListener("click", function (e) {
        e.stopPropagation();
        navigator.clipboard.writeText(fp.ua).then(function () { copy.textContent = "✓"; setTimeout(function () { copy.textContent = "📋"; }, 800); }, function () {});
      });
      content.appendChild(el("div", { className: "cmd-item" }, [
        el("div", { className: "cmd-body wide" }, [
          el("div", { className: "cmd-name" }, [type ? fp.label : "🎲 Random: " + fp.label]),
          el("div", { className: "cmd-desc mono" }, [fp.ua]),
          el("div", { className: "cmd-desc" }, ["Platform: " + fp.platform + " · Language: " + fp.lang]),
        ]),
        el("div", { className: "prof-actions" }, [apply, copy]),
      ]));
    });
  }

  // ── Log tab ───────────────────────────────────────────────────────────

  async function renderLog() {
    var profiles = await load();
    var logs = await getLogs();
    content.textContent = "";
    var all = [];
    Object.keys(logs).forEach(function (pid) {
      var p = profiles[pid];
      logs[pid].forEach(function (l) { all.push({ t: l.t, a: l.a, name: p ? p.name : "[deleted]", icon: p ? p.icon || "👤" : "❌" }); });
    });
    all.sort(function (a, b) { return b.t - a.t; });
    all = all.slice(0, 100);
    if (!all.length) { content.appendChild(el("div", { className: "cmd-empty" }, ["No activity yet."])); return; }

    var lastDay = "";
    var today = new Date().toDateString(), yesterday = new Date(Date.now() - 86400000).toDateString();
    all.forEach(function (ev) {
      var d = new Date(ev.t);
      var day = d.toDateString();
      if (day !== lastDay) {
        lastDay = day;
        content.appendChild(el("div", { className: "cmd-group-title" }, [day === today ? "Today" : day === yesterday ? "Yesterday" : d.toLocaleDateString()]));
      }
      content.appendChild(el("div", { className: "cmd-item" }, [
        el("span", { className: "cmd-icon" }, [ev.icon]),
        el("div", { className: "cmd-body" }, [
          el("div", { className: "cmd-name" }, [ev.name]),
          el("div", { className: "cmd-desc" }, [d.toLocaleTimeString() + " — " + ev.a]),
        ]),
      ]));
    });
  }
})();
