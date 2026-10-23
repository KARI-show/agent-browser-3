// Extra feature "uptime" (side panel): uptime monitors — HTTP status checks on a schedule, built on the
// watchers (browser/extension/automation.js). A monitor is a watcher of mode "status": the service worker
// runs it on its alarm, fetches the URL instead of opening a tab (HEAD, GET fallback, 15 s timeout),
// compares "HTTP 200" / "HTTP 503" / "down: <reason>" like any other watcher — so a flip goes through the
// same notification + Telegram path — and appends { at, ms, code, ok } to the watcher's `history` (a ring
// of the last 288 checks, 24 h at 5 min). This module adds the tools (declared in
// browser/host/extras/uptime.ts), the ⏱ Uptime tab and the quick commands; the pure helpers (state,
// sparkline, uptime %, formatting) are exposed on AgentExtras.uptime for the unit tests.
// Built into extras.js only for brands that switch the feature on. No innerHTML: names and addresses come
// from storage.
(function () {
  if (!globalThis.AGENT_BRAND || !globalThis.AGENT_BRAND.has("uptime")) return;
  var T = globalThis.AgentBrowserTools;
  var H = T.helpers;
  var text = H.text;
  function auto() {
    if (!globalThis.AgentAutomation) throw new Error("The automation module (watchers) didn't load.");
    return globalThis.AgentAutomation;
  }

  var DEFAULT_EVERY = 5, DEFAULT_EXPECT = 200;
  var BARS = "▁▂▃▄▅▆▇";
  var SPARK_WIDTH = 24;

  function ago(ts) {
    if (!ts) return "never";
    var d = Date.now() - ts;
    if (d < 60000) return "just now";
    if (d < 3600000) return Math.floor(d / 60000) + " min ago";
    if (d < 86400000) return Math.floor(d / 3600000) + " h ago";
    return Math.floor(d / 86400000) + " d ago";
  }
  function norm(s) { return String(s || "").replace(/\s+/g, " ").trim().toLowerCase(); }

  // ── pure helpers ────────────────────────────────────────────────────────

  /** The status watchers of the watcher map, newest first. */
  function statusWatchers(all) {
    return Object.keys(all || {})
      .filter(function (id) { return all[id] && all[id].mode === "status"; })
      .sort(function (x, y) { return (all[y].created || 0) - (all[x].created || 0); })
      .map(function (id) { return all[id]; });
  }

  /** Uptime over the history, a percentage with one decimal; null without checks. */
  function uptimePercent(history) {
    var h = history || [];
    if (!h.length) return null;
    var up = h.filter(function (e) { return e.ok; }).length;
    return Math.round((up / h.length) * 1000) / 10;
  }

  /** Failed checks at the end of the history, in a row. */
  function consecutiveFailures(history) {
    var h = history || [], n = 0;
    for (var i = h.length - 1; i >= 0 && !h[i].ok; i--) n++;
    return n;
  }

  /** A text sparkline of the last `width` checks: ▁…▇ latency scaled to the slowest good check, × for a failed one. */
  function sparkline(history, width) {
    var h = (history || []).slice(-(width || SPARK_WIDTH));
    if (!h.length) return "";
    var max = 0;
    h.forEach(function (e) { if (e.ok && e.ms > max) max = e.ms; });
    return h.map(function (e) {
      if (!e.ok) return "×";
      var level = max ? Math.min(BARS.length - 1, Math.floor((e.ms / max) * (BARS.length - 1))) : 0;
      return BARS.charAt(level);
    }).join("");
  }

  /** What the list and the tab show for one monitor. */
  function stateOf(w) {
    var h = w.history || [];
    var last = h[h.length - 1] || null;
    var answered = h.filter(function (e) { return e.code > 0; });
    var avg = answered.length ? Math.round(answered.reduce(function (s, e) { return s + e.ms; }, 0) / answered.length) : null;
    return {
      state: !last ? "unknown" : last.ok ? "up" : "down",
      code: last ? last.code : null,
      ms: last ? last.ms : null,
      at: last ? last.at : null,
      consecutiveFailures: consecutiveFailures(h),
      checks: h.length,
      failures: h.filter(function (e) { return !e.ok; }).length,
      uptime: uptimePercent(h),
      avgMs: avg,
      since: w.created || null,
    };
  }

  function lastLabel(w, s) {
    if (w.lastRun && !w.lastRun.ok) return "ERROR " + ago(w.lastRun.at) + ": " + w.lastRun.error;
    if (!s.checks) return "not checked yet";
    return "last: " + (w.lastContent || (s.code ? "HTTP " + s.code : "down")) + (s.code ? " in " + s.ms + " ms" : "") + ", " + ago(s.at);
  }

  function formatMonitor(w) {
    var s = stateOf(w);
    var dot = s.state === "up" ? "🟢 UP" : s.state === "down" ? "🔴 DOWN" + (s.consecutiveFailures > 1 ? " (" + s.consecutiveFailures + " failures in a row)" : "") : "⚪ UNKNOWN";
    var parts = [w.id + "  " + dot + "  " + w.name];
    if (!w.enabled) parts.push("⏸ paused");
    parts.push(w.url, "every " + w.every + " min", "expects " + (w.expect || DEFAULT_EXPECT), lastLabel(w, s));
    if (s.checks) {
      parts.push("history: " + s.uptime + "% up, " + s.checks + " check" + (s.checks === 1 ? "" : "s") + ", " + s.failures + " failure" + (s.failures === 1 ? "" : "s") +
        (s.avgMs != null ? ", avg " + s.avgMs + " ms" : "") + "  " + sparkline(w.history, SPARK_WIDTH));
    }
    parts.push("since " + ago(s.since));
    if (w.notify && w.notify.telegram) parts.push("Telegram");
    return parts.join("  |  ");
  }

  function formatList(all) {
    var ws = statusWatchers(all);
    if (!ws.length) return "No uptime monitors. browser_uptime_add checks a site's HTTP status on a schedule and reports when it goes down or comes back.";
    return "Uptime monitors (" + ws.length + "):\n" + ws.map(formatMonitor).join("\n");
  }

  // ── tools ───────────────────────────────────────────────────────────────

  /** A status watcher by id or name — never a page watcher. */
  async function findMonitor(a) {
    a = a || {};
    var all = await auto().loadWatchers();
    var ws = statusWatchers(all);
    var w = a.id ? ws.filter(function (x) { return x.id === a.id; })[0] : null;
    if (!w) {
      var want = norm(a.name || a.id);
      var hit = want ? ws.filter(function (x) { return norm(x.name) === want; }) : [];
      if (hit.length > 1) throw new Error("Several monitors are named '" + a.name + "' — pass the id (browser_uptime_list).");
      w = hit[0];
    }
    if (!w) {
      if (a.id && all[a.id]) throw new Error(a.id + " is a page watcher, not an uptime monitor — browser_watch_delete handles it.");
      throw new Error("No uptime monitor " + (a.id ? "with id " + a.id : "named '" + a.name + "'") + ". browser_uptime_list shows them.");
    }
    return w;
  }

  /** Create a monitor (a status watcher); lastTab supplies the URL when none is given. → the message for the model. */
  async function addMonitor(a, lastTab) {
    a = a || {};
    var A = auto();
    var every = Number(a.every) > 0 ? Number(a.every) : DEFAULT_EVERY;
    var expect = Number(a.expect) > 0 ? Number(a.expect) : DEFAULT_EXPECT;
    var out = await A.watchCreate({ url: a.url, name: a.name, every: every, mode: "status", expect: expect, telegram: a.telegram }, lastTab);
    var m = /\(id: (wch_\w+)/.exec(out);
    var w = m ? (await A.loadWatchers())[m[1]] : null;
    if (!w) return out;
    return "Monitoring " + w.url + " every " + w.every + " min (id: " + w.id + "), expecting HTTP " + w.expect + ". The first check sets the baseline; after that every flip (e.g. 200 → 503 and back) is reported with a system notification" +
      (w.notify && w.notify.telegram ? " and, when the Telegram bot is set up, a Telegram message" : "") +
      ". It runs in the background with the panel closed; browser_uptime_list shows the state and history (the ⏱ Uptime tab of the 🧩 panel too).";
  }

  T.register("browser_uptime_add", async function (a) {
    a = a || {};
    var tab = null;
    if (!a.url) { try { tab = await H.currentTab(); } catch (_) { tab = null; } }
    return text(await addMonitor(a, tab ? { url: tab.url } : null));
  });

  T.register("browser_uptime_list", async function () {
    return text(formatList(await auto().loadWatchers()));
  });

  T.register("browser_uptime_delete", async function (a) {
    var w = await findMonitor(a || {});
    await auto().watchDelete({ id: w.id });
    return text("Deleted uptime monitor '" + w.name + "'.");
  });

  // ── ⏱ Uptime tab ────────────────────────────────────────────────────────

  async function checkNow(w, ctx) {
    ctx.status("Checking " + w.name + "…");
    var r = await auto().requestRun(w.id);
    if (!r) ctx.status("The background worker didn't answer — it will check on schedule.", "bad");
    else if (!r.ok) ctx.status("⚠ " + (r.error || "failed"), "bad");
    else {
      var up = r.status === "HTTP " + (w.expect || DEFAULT_EXPECT);
      ctx.status((up ? "✓ " : "✗ ") + (r.status || "checked") + (r.first ? " — baseline saved." : r.changed ? " — changed since the last check." : " — no change."), up ? "good" : "bad");
    }
    ctx.rerender();
  }

  async function showAdd(content, ctx) {
    var el = ctx.el, field = ctx.field;
    var url = el("input", { value: await ctx.currentTabUrl(), placeholder: "https://…" });
    var name = el("input", { placeholder: ctx.hostOf(url.value) || "My site" });
    var every = el("input", { type: "number", value: DEFAULT_EVERY, min: 1, max: 10080 });
    var expect = el("input", { type: "number", value: DEFAULT_EXPECT, min: 100, max: 599 });
    var tg = el("input", { type: "checkbox", checked: true });
    var save = el("button", { className: "prof-btn primary" }, ["⏱ Start monitoring"]);
    save.addEventListener("click", async function () {
      try {
        var out = await addMonitor({ url: url.value.trim(), name: name.value.trim() || name.placeholder, every: Number(every.value), expect: Number(expect.value), telegram: tg.checked }, null);
        ctx.status(out.split(". ")[0] + ".", "good");
        ctx.rerender();
      } catch (e) { ctx.status("⚠ " + e.message, "bad"); }
    });
    content.textContent = "";
    content.appendChild(el("div", { className: "ed-wrap" }, [
      el("button", { className: "prof-btn", onclick: ctx.rerender }, ["← Back"]),
      el("h3", { className: "ed-title" }, ["New uptime monitor"]),
      field("Site", url),
      field("Name", name),
      el("div", { className: "ed-row" }, [field("Every (minutes)", every), field("Expected status", expect)]),
      el("label", { className: "ed-label" }, [tg, " Send flips to Telegram (needs the bot from the Remote settings)"]),
      el("div", { className: "ed-actions" }, [save, el("button", { className: "prof-btn", onclick: ctx.rerender }, ["Cancel"])]),
    ]));
  }

  async function renderTab(content, ctx) {
    var el = ctx.el;
    var A = auto();
    var ws = statusWatchers(await A.loadWatchers());
    content.textContent = "";
    content.appendChild(el("div", { className: "cmd-item", onclick: function () { return showAdd(content, ctx); } }, [
      el("span", { className: "cmd-icon" }, ["➕"]),
      el("div", { className: "cmd-body" }, [
        el("div", { className: "cmd-name" }, ["Monitor a site's uptime"]),
        el("div", { className: "cmd-desc" }, ["An HTTP status check every few minutes in the background — no page is opened, no model involved. A flip (200 → 503 and back) arrives as a notification and in Telegram."]),
      ]),
    ]));
    if (!ws.length) { content.appendChild(el("div", { className: "cmd-empty" }, ["No uptime monitors yet."])); return; }
    ws.forEach(function (w) {
      var s = stateOf(w);
      var dot = s.state === "up" ? "🟢" : s.state === "down" ? "🔴" : "⚪";
      var actions = el("div", { className: "prof-actions column" }, [
        el("button", { className: "prof-btn", title: "Check now", onclick: function (e) { e.stopPropagation(); return checkNow(w, ctx); } }, ["▶"]),
        el("button", { className: "prof-btn", title: w.enabled ? "Pause" : "Resume", onclick: function (e) { e.stopPropagation(); return A.watchToggle(w.id, !w.enabled).then(ctx.rerender); } }, [w.enabled ? "⏸" : "⏵"]),
        el("button", { className: "prof-btn", title: "Delete", onclick: function (e) {
          e.stopPropagation();
          if (confirm("Delete the uptime monitor '" + w.name + "'?")) return A.watchDelete({ id: w.id }).then(ctx.rerender, function (err) { ctx.status("⚠ " + err.message, "bad"); });
        } }, ["🗑"]),
      ]);
      content.appendChild(el("div", { className: "cmd-item" + (w.enabled ? "" : " paused") }, [
        el("span", { className: "cmd-icon" }, [dot]),
        el("div", { className: "cmd-body" }, [
          el("div", { className: "cmd-name" }, [w.name]),
          el("div", { className: "cmd-desc" }, [ctx.hostOf(w.url) + " · every " + w.every + " min · expects " + (w.expect || DEFAULT_EXPECT) + (w.enabled ? "" : " · paused")]),
          el("div", { className: "cmd-desc" + (s.state === "down" || (w.lastRun && !w.lastRun.ok) ? " bad" : "") }, [lastLabel(w, s) + (s.consecutiveFailures > 1 ? " · " + s.consecutiveFailures + " failures in a row" : "")]),
          s.checks ? el("div", { className: "cmd-desc mono" }, [sparkline(w.history, 30) + "  " + s.uptime + "% up · " + s.checks + " check" + (s.checks === 1 ? "" : "s") + (s.avgMs != null ? " · avg " + s.avgMs + " ms" : "")]) : null,
        ]),
        actions,
      ]));
    });
  }

  globalThis.AgentExtras.tabs.push({
    id: "uptime",
    label: "⏱ Uptime",
    storageKeys: [(globalThis.AgentAutomation && globalThis.AgentAutomation.WATCHERS_KEY) || "agentWatchers"],
    render: renderTab,
  });

  globalThis.AgentExtras.commands.push(
    { group: "Monitoring", icon: "⏱", name: "Monitor this site's uptime",
      prompt: "Monitor this site's uptime with browser_uptime_add: check it every 5 minutes and tell me what you set up." },
    { group: "Monitoring", icon: "📈", name: "Show my uptime monitors",
      prompt: "Show my uptime monitors with browser_uptime_list: which are up or down, the last status and latency, and the uptime over the stored history." }
  );

  // Pure helpers for the unit tests (and other extras).
  globalThis.AgentExtras.uptime = {
    DEFAULT_EVERY: DEFAULT_EVERY,
    DEFAULT_EXPECT: DEFAULT_EXPECT,
    statusWatchers: statusWatchers,
    uptimePercent: uptimePercent,
    consecutiveFailures: consecutiveFailures,
    sparkline: sparkline,
    stateOf: stateOf,
    formatMonitor: formatMonitor,
    formatList: formatList,
    findMonitor: findMonitor,
    addMonitor: addMonitor,
    renderTab: renderTab,
  };
})();
