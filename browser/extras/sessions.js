// Extra feature "sessions" (side panel): tab sessions — the tabs of a window saved under a name and
// opened again later, into a new window or the current one. Built into extras.js only for brands
// that switch the feature on. The tools are declared in browser/host/extras/sessions.ts; this file
// registers them, the 🗂 tab of the 🧩 panel and the "Tabs" quick commands through the registry
// browserTools.js provides.
//
// Storage: chrome.storage.local[KEY] = [session, …] newest first, at most MAX sessions. A session is
// { id, name, t, tabs: [{ url, title, pinned, active }] }. Names and titles came from the user and
// from web pages, so the tab's DOM is built with ctx.el (text nodes), never innerHTML.
(function () {
  if (!globalThis.AGENT_BRAND || !globalThis.AGENT_BRAND.has("sessions")) return;
  var T = globalThis.AgentBrowserTools;
  var X = globalThis.AgentExtras;
  if (!T || !X) return;
  var H = T.helpers;
  var text = H.text;

  var KEY = "agentSessions";
  var MAX = 50; // sessions kept; the oldest go first
  var MAX_NAME = 80;
  // Pages an extension can't reopen: browser-internal ones, other extensions' pages, file: (needs a
  // permission the user may not have granted) — and about:blank, which isn't worth keeping.
  var INTERNAL = /^(chrome|chrome-extension|chrome-untrusted|chrome-search|edge|about|devtools|view-source|moz-extension|file):/i;

  // ── Pure helpers (exposed on AgentExtras.sessions for the unit tests) ──

  function ago(ts) {
    if (!ts) return "";
    var d = Date.now() - ts;
    if (d < 60000) return "just now";
    if (d < 3600000) return Math.floor(d / 60000) + "m ago";
    if (d < 86400000) return Math.floor(d / 3600000) + "h ago";
    return Math.floor(d / 86400000) + "d ago";
  }
  function tabsWord(n) { return n + " tab" + (n === 1 ? "" : "s"); }
  function hostOf(url) { try { return new URL(url).hostname.replace(/^www\./, ""); } catch (_) { return url || ""; } }
  function newId(list) {
    var taken = {};
    (list || []).forEach(function (s) { taken[s.id] = true; });
    var id;
    do { id = "ses_" + Math.random().toString(36).slice(2, 8); } while (taken[id]);
    return id;
  }
  function sameName(a, b) { return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase(); }

  /** The tabs worth saving, in window order: not the extension's own pages (ownOrigin prefix), not browser-internal ones. */
  function restorableTabs(tabs, ownOrigin) {
    return (tabs || []).filter(function (t) {
      var url = (t && t.url) || "";
      return url && !(ownOrigin && url.indexOf(ownOrigin) === 0) && !INTERNAL.test(url);
    }).map(function (t) { return { url: t.url, title: String(t.title || "").slice(0, 200), pinned: !!t.pinned, active: !!t.active }; });
  }
  /** A session record; `id` keeps an existing id when a session of the same name is replaced. */
  function makeSession(name, tabs, now, id) {
    name = String(name || "").trim().replace(/\s+/g, " ").slice(0, MAX_NAME);
    if (!name) throw new Error("name is required");
    if (!tabs || !tabs.length) throw new Error("No website tabs to save in this window.");
    return { id: id || newId(), name: name, t: now || Date.now(), tabs: tabs };
  }
  function findByName(list, name) { return (list || []).find(function (s) { return sameName(s.name, name); }) || null; }
  /** Replace the session with the same name (or id), newest first, capped at MAX. */
  function upsertSession(list, session) {
    var rest = (list || []).filter(function (s) { return s.id !== session.id && !sameName(s.name, session.name); });
    return [session].concat(rest).slice(0, MAX);
  }
  /** By id, or by name (case-insensitive); throws a message that names what exists. */
  function findSession(list, sel) {
    list = list || [];
    var id = sel && sel.id ? String(sel.id).trim() : "";
    var name = sel && sel.name ? String(sel.name).trim() : "";
    if (!id && !name) throw new Error("Give id or name (see browser_session_list).");
    var s = (id && list.find(function (x) { return x.id === id; })) || (name && findByName(list, name)) || null;
    if (!s) {
      var have = list.map(function (x) { return "'" + x.name + "'"; }).join(", ");
      throw new Error("No session " + (id ? "with id " + id : "named '" + name + "'") + "." + (have ? " Saved: " + have + "." : " Nothing is saved yet."));
    }
    return s;
  }
  function formatTabs(tabs) {
    return (tabs || []).map(function (t, i) { return "  " + (i + 1) + ". " + (t.pinned ? "📌 " : "") + (t.title || "(untitled)") + " — " + t.url + (t.active ? "  (active)" : ""); }).join("\n");
  }
  /** The list the model sees: id, name, tab count, saved time, the first titles. */
  function formatList(list) {
    if (!list || !list.length) return "No sessions saved yet. browser_session_save keeps this window's tabs under a name.";
    var lines = ["Sessions (" + list.length + "):"];
    list.forEach(function (s) {
      lines.push("  " + s.id + "  " + s.name + "  |  " + tabsWord(s.tabs.length) + "  |  saved " + ago(s.t));
      var titles = s.tabs.slice(0, 3).map(function (t) { return t.title || hostOf(t.url); });
      lines.push("    " + titles.join("; ") + (s.tabs.length > 3 ? "; … +" + (s.tabs.length - 3) + " more" : ""));
    });
    return lines.join("\n");
  }

  // ── Storage ────────────────────────────────────────────────────────────

  async function load() {
    var st = await chrome.storage.local.get(KEY);
    return Array.isArray(st[KEY]) ? st[KEY] : [];
  }
  async function save(list) {
    var o = {};
    o[KEY] = list;
    await chrome.storage.local.set(o);
  }
  function ownOrigin() { return chrome.runtime.getURL(""); }

  /** The window the side panel belongs to. */
  async function panelWindowId() {
    var tabs = await chrome.tabs.query({ currentWindow: true });
    if (tabs[0]) return tabs[0].windowId;
    return (await chrome.windows.getCurrent()).id;
  }
  /** The window the agent works in (its current tab's), or the panel's own window when it has none. */
  async function agentWindowId() {
    try { return (await H.currentTab()).windowId; } catch (_) {}
    return panelWindowId();
  }

  /** Save the tabs of window `windowId` under `name`. → { session, replaced } */
  async function saveWindow(windowId, name) {
    var tabs = restorableTabs(await chrome.tabs.query({ windowId: windowId }), ownOrigin());
    var list = await load();
    var existing = findByName(list, name);
    var s = makeSession(name, tabs, Date.now(), existing ? existing.id : newId(list));
    await save(upsertSession(list, s));
    return { session: s, replaced: !!existing };
  }

  // chrome.windows.create from the side panel fails in some browsers (Edge): the service worker creates it then.
  async function createWindow(options) {
    try {
      var win = await chrome.windows.create(options);
      if (win && win.id) return win;
    } catch (_) {}
    var r = await chrome.runtime.sendMessage({ type: "createWindow", options: options });
    if (!r || !r.ok || !r.win || !r.win.id) throw new Error("Couldn't open a new window" + (r && r.error ? ": " + r.error : "") + ".");
    return r.win;
  }

  /** Open a session's tabs in a new window or in `windowId`; → { windowId, tabs: [chrome tabs], activeTab } */
  async function openSession(s, where, windowId) {
    var urls = s.tabs.map(function (t) { return t.url; });
    var created;
    if (where === "current") {
      created = [];
      for (var i = 0; i < s.tabs.length; i++) created.push(await chrome.tabs.create({ windowId: windowId, url: s.tabs[i].url, pinned: !!s.tabs[i].pinned, active: false }));
    } else {
      var win = await createWindow({ url: urls, focused: true });
      windowId = win.id;
      created = win.tabs && win.tabs.length >= urls.length ? win.tabs.slice(0, urls.length) : await chrome.tabs.query({ windowId: win.id });
      for (var j = 0; j < created.length && j < s.tabs.length; j++) if (s.tabs[j].pinned) await chrome.tabs.update(created[j].id, { pinned: true });
    }
    var activeIdx = s.tabs.findIndex(function (t) { return t.active; });
    if (activeIdx < 0 || activeIdx >= created.length) activeIdx = created.length - 1;
    var activeTab = created[activeIdx];
    if (activeTab) await chrome.tabs.update(activeTab.id, { active: true });
    return { windowId: windowId, tabs: created, activeTab: activeTab };
  }

  // ── Tools ──────────────────────────────────────────────────────────────

  AgentBrowserTools.register("browser_session_save", async function (a) {
    a = a || {};
    var name = String(a.name || "").trim();
    if (!name) throw new Error("name is required");
    var r = await saveWindow(await agentWindowId(), name);
    return text((r.replaced ? "Replaced" : "Saved") + " session '" + r.session.name + "' (id: " + r.session.id + ") — " + tabsWord(r.session.tabs.length) + ":\n" + formatTabs(r.session.tabs));
  });

  AgentBrowserTools.register("browser_session_list", async function () {
    return text(formatList(await load()));
  });

  AgentBrowserTools.register("browser_session_restore", async function (a) {
    a = a || {};
    var s = findSession(await load(), a);
    var where = a.where === "current" ? "current" : "new";
    var r = await openSession(s, where, where === "current" ? await agentWindowId() : null);
    // The user is looking at the restored tabs now: the agent works there from here on.
    if (r.activeTab && T.setCurrentTab) T.setCurrentTab(r.activeTab.id);
    var pinned = s.tabs.filter(function (t) { return t.pinned; }).length;
    return text("Restored session '" + s.name + "': " + tabsWord(r.tabs.length) + " in " + (where === "new" ? "new window " : "window ") + r.windowId + (pinned ? " (" + pinned + " pinned)" : "") + ".\n" + formatTabs(s.tabs));
  });

  AgentBrowserTools.register("browser_session_delete", async function (a) {
    var list = await load();
    var s = findSession(list, a || {});
    await save(list.filter(function (x) { return x.id !== s.id; }));
    return text("Deleted session '" + s.name + "' (" + tabsWord(s.tabs.length) + ").");
  });

  // ── 🗂 tab of the 🧩 panel ─────────────────────────────────────────────

  var expanded = {}; // session id → the tab list is open

  async function renderSessions(content, ctx) {
    var el = ctx.el;
    var list = await load();
    var here = restorableTabs(await chrome.tabs.query({ currentWindow: true }), ownOrigin());
    content.textContent = "";
    var name = el("input", { placeholder: "Session name, e.g. Monday research", maxLength: MAX_NAME });
    var saveBtn = el("button", { className: "prof-btn primary small" }, ["💾 Save this window's tabs"]);
    var doSave = function () {
      panelWindowId().then(function (winId) { return saveWindow(winId, name.value.trim() || "Session " + new Date().toLocaleDateString()); })
        .then(function (r) { ctx.status((r.replaced ? "✓ Replaced '" : "✓ Saved '") + r.session.name + "' — " + tabsWord(r.session.tabs.length) + ".", "good"); ctx.rerender(); },
              function (e) { ctx.status("⚠ " + (e && e.message || e), "bad"); });
    };
    saveBtn.addEventListener("click", doSave);
    name.addEventListener("keydown", function (e) { if (e.key === "Enter") doSave(); });
    content.appendChild(el("div", { className: "cmd-item event" }, [
      el("span", { className: "cmd-icon" }, ["➕"]),
      el("div", { className: "cmd-body wide" }, [
        el("div", { className: "cmd-name" }, ["Save this window's tabs"]),
        el("div", { className: "cmd-desc" }, [tabsWord(here.length) + " in this window (the panel and browser pages are left out). Bring them back any time, here or from the chat."]),
        ctx.field("Name", name),
        el("div", { className: "prof-actions" }, [saveBtn]),
      ]),
    ]));
    if (!list.length) { content.appendChild(el("div", { className: "cmd-empty" }, ["No sessions yet."])); return; }
    content.appendChild(el("div", { className: "cmd-group-title" }, ["Saved sessions (" + list.length + ")"]));
    list.forEach(function (s) {
      var open = !!expanded[s.id];
      var restore = function (where) {
        ctx.status("Opening " + tabsWord(s.tabs.length) + "…");
        panelWindowId().then(function (winId) { return openSession(s, where, winId); })
          .then(function (r) { ctx.status("✓ Restored '" + s.name + "': " + tabsWord(r.tabs.length) + " in window " + r.windowId + ".", "good"); },
                function (e) { ctx.status("⚠ " + (e && e.message || e), "bad"); });
      };
      var body = [
        el("div", { className: "cmd-name" }, [s.name]),
        el("div", { className: "cmd-desc" }, [tabsWord(s.tabs.length) + " · saved " + ctx.ago(s.t) + (open ? "" : " · click for the tabs")]),
      ];
      if (open) {
        s.tabs.forEach(function (t) { body.push(el("div", { className: "cmd-desc" }, [(t.pinned ? "📌 " : "• ") + (t.title || "(untitled)") + " — " + hostOf(t.url)])); });
        body.push(el("div", { className: "prof-actions" }, [
          el("button", { className: "prof-btn", title: "Open the tabs in a new window", onclick: function (e) { e.stopPropagation(); restore("new"); } }, ["▶ Restore in a new window"]),
          el("button", { className: "prof-btn", title: "Add the tabs to this window", onclick: function (e) { e.stopPropagation(); restore("current"); } }, ["↳ Restore here"]),
        ]));
      }
      content.appendChild(el("div", { className: "cmd-item", onclick: function () { expanded[s.id] = !open; ctx.rerender(); } }, [
        el("span", { className: "cmd-icon" }, ["🗂"]),
        el("div", { className: "cmd-body" }, body),
        el("div", { className: "prof-actions column" }, [
          el("button", { className: "prof-btn", title: "Restore in a new window", onclick: function (e) { e.stopPropagation(); restore("new"); } }, ["▶"]),
          el("button", { className: "prof-btn", title: "Delete", onclick: function (e) {
            e.stopPropagation();
            if (!confirm("Delete session '" + s.name + "'?")) return;
            load().then(function (cur) { return save(cur.filter(function (x) { return x.id !== s.id; })); }).then(function () { ctx.status("Deleted.", "good"); ctx.rerender(); }, function (err) { ctx.status("⚠ " + err.message, "bad"); });
          } }, ["🗑"]),
        ]),
      ]));
    });
  }

  X.tabs.push({ id: "sessions", label: "🗂 Sessions", storageKeys: [KEY], render: renderSessions });

  // ── Quick commands ─────────────────────────────────────────────────────

  X.commands.push(
    { group: "Tabs", icon: "🗂", name: "Save this window's tabs as a session",
      prompt: "Save this window's tabs as a session (browser_session_save) named: ", partial: true },
    { group: "Tabs", icon: "▶", name: "Restore a session",
      prompt: "Restore my saved tab session (browser_session_restore, in a new window) named: ", partial: true },
    { group: "Tabs", icon: "🧹", name: "Close the duplicates in this window",
      prompt: "List the tabs in this window with browser_tabs. Where several tabs show the same address, keep one of each (the one I'm working in when it is among them) and close the others with browser_close_tab. Don't close anything else. Tell me what you closed." }
  );

  X.sessions = {
    KEY: KEY, MAX: MAX, INTERNAL: INTERNAL,
    restorableTabs: restorableTabs, makeSession: makeSession, upsertSession: upsertSession, findSession: findSession, findByName: findByName,
    formatList: formatList, formatTabs: formatTabs, tabsWord: tabsWord,
    load: load, save: save, saveWindow: saveWindow, openSession: openSession, render: renderSessions,
  };
})();
