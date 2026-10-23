// 🧩 Automations panel — the UI over recipes, watchers and site memory
// (automation.js), plus the "save these steps as a recipe" strip that appears
// after the agent finishes a task. Everything goes through the same functions
// the browser_recipe_* / browser_watch_* / browser_memory_* tools use, so a click
// and a model call behave identically. DOM is built without innerHTML: names,
// notes and page text come from storage the agent and web pages wrote.
(function () {
  var A = window.AgentAutomation;
  var T = window.AgentBrowserTools;
  if (!A || !T) return;

  // ── DOM helpers ───────────────────────────────────────────────────────

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
  function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ""); } catch (_) { return url || ""; }
  }
  function currentTabUrl() {
    return chrome.tabs.query({ active: true, currentWindow: true }).then(function (t) {
      var u = t[0] && t[0].url || "";
      return /^https?:/.test(u) ? u : "";
    });
  }
  // Put words in the chat the way a remote prompt arrives: a user bubble, then the host runs it.
  function sendPrompt(text) {
    var R = window.AgentRemote;
    if (R) {
      R.local({ type: "user", text: text });
      R.toHost({ type: "prompt", text: text, attachments: [] });
    } else if (typeof window.acquireVsCodeApi === "function") {
      window.acquireVsCodeApi().postMessage({ type: "prompt", text: text, attachments: [] });
    }
    hide();
  }

  // ── Panel shell (same shape as the 👤 panel) ───────────────────────────

  var cmdPanel = document.getElementById("commands-panel");
  var cmdBtn = document.getElementById("cmdBtn");
  if (!cmdPanel || !cmdBtn) return;
  function has(f) { return !window.AGENT_BRAND || !window.AGENT_BRAND.has || window.AGENT_BRAND.has(f); }
  var TABS = [["recipes", "🧩 Recipes"], ["watchers", "👁 Watchers"], ["memory", "🧠 Memory"]].filter(function (t) { return has(t[0]); });
  if (!TABS.length) return; // a brand without recipes, watchers and memory has no 🧩

  var content = el("div", { className: "cmd-list" });
  var statusLine = el("div", { className: "prof-status hidden" });
  var tabsBar = el("div", { className: "prof-tabs" });
  var panel = el("div", { id: "automations-panel", className: "hidden" }, [
    el("div", { className: "cmd-header" }, [el("span", null, ["🧩 Automations"]), el("button", { className: "icon-btn", title: "Close", onclick: hide }, ["✕"])]),
    tabsBar,
    statusLine,
    content,
  ]);
  cmdPanel.parentNode.insertBefore(panel, cmdPanel.nextSibling);

  var badge = el("span", { className: "auto-badge hidden" });
  var btn = el("button", { id: "autoBtn", className: "icon-btn", title: "Automations: recipes, watchers, site memory", "aria-label": "Automations" }, ["🧩", badge]);
  cmdBtn.parentNode.insertBefore(btn, cmdBtn);
  btn.addEventListener("click", function () {
    if (panel.classList.contains("hidden")) show(); else hide();
  });
  function show(tab) {
    document.querySelectorAll("#commands-panel, #profiles-panel").forEach(function (p) { p.classList.add("hidden"); });
    panel.classList.remove("hidden");
    if (tab) setTab(tab);
    render();
  }
  function hide() { panel.classList.add("hidden"); }
  function status(text, kind) {
    statusLine.textContent = text || "";
    statusLine.className = "prof-status" + (text ? "" : " hidden") + (kind ? " " + kind : "");
  }

  var curTab = TABS[0][0];
  TABS.forEach(function (t) {
    var b = el("button", { className: "prof-tab" + (t[0] === curTab ? " active" : ""), dataset: { tab: t[0] } }, [t[1]]);
    b.addEventListener("click", function () { setTab(t[0]); render(); });
    tabsBar.appendChild(b);
  });
  function setTab(name) {
    curTab = name;
    tabsBar.querySelectorAll(".prof-tab").forEach(function (x) { x.classList.toggle("active", x.dataset.tab === name); });
    status("");
  }
  function render() {
    if (panel.classList.contains("hidden")) return;
    if (curTab === "recipes") renderRecipes();
    else if (curTab === "watchers") renderWatchers();
    else renderMemory();
  }

  // ── Which chat / turn the traced steps belong to ───────────────────────

  var activeChatId = null;
  var turnN = 0;
  var pendingTurn = null; // a prompt went out before the chat had an id
  window.addEventListener("agent:outgoing", function (ev) {
    var m = ev.detail;
    if (!m || m.type !== "prompt") return;
    turnN++;
    T.setTurn({ convId: activeChatId || "new", n: turnN });
    pendingTurn = activeChatId ? null : turnN;
    offer.classList.add("hidden");
  });
  window.addEventListener("message", function (ev) {
    var d = ev.data;
    if (!d || typeof d.type !== "string") return;
    if (d.type === "loadConversation" && typeof d.convId === "string") activeChatId = d.convId;
    else if (d.type === "conversations" && typeof d.activeId === "string") activeChatId = d.activeId;
    else if (d.type === "clear") activeChatId = null;
    else if (d.type === "runState" && typeof d.convId === "string") {
      if (d.running && pendingTurn) {
        // The chat got its id with the first run: re-tag the turn so "this chat" finds its steps.
        activeChatId = d.convId;
        T.setTurn({ convId: d.convId, n: pendingTurn });
        T.trace().forEach(function (s) { if (s.turn && s.turn.convId === "new" && s.turn.n === pendingTurn) s.turn.convId = d.convId; });
        pendingTurn = null;
      }
      if (!d.running) maybeOffer();
    }
  });

  // ── "Save as recipe" strip ─────────────────────────────────────────────

  var composer = document.getElementById("composer");
  var offerText = el("span", { className: "offer-text" });
  var offer = el("div", { id: "recipe-offer", className: "hidden" }, [
    el("span", { className: "offer-icon" }, ["🧩"]),
    offerText,
    el("button", { className: "prof-btn primary small", onclick: function () { show("recipes"); showSaveDialog(); } }, ["Save as recipe"]),
    el("button", { className: "icon-btn", title: "Dismiss", onclick: function () { offer.classList.add("hidden"); } }, ["✕"]),
  ]);
  if (composer && has("recipes")) composer.parentNode.insertBefore(offer, composer);

  function replayable(steps) {
    try { return A.buildRecipe(steps, { name: "x" }).steps.length; } catch (_) { return 0; }
  }
  function maybeOffer() {
    if (!has("recipes")) return;
    var n = replayable(A.traceSteps("chat"));
    if (n < 2) return;
    offerText.textContent = n + " actions recorded — replay them later without the model.";
    offer.classList.remove("hidden");
  }

  // ── Recipes ────────────────────────────────────────────────────────────

  async function renderRecipes() {
    var all = await A.loadRecipes();
    var ids = Object.keys(all).sort(function (a, b) { return (all[b].updated || 0) - (all[a].updated || 0); });
    content.textContent = "";
    var recorded = replayable(A.traceSteps("chat"));
    content.appendChild(el("div", { className: "cmd-item", onclick: showSaveDialog }, [
      el("span", { className: "cmd-icon" }, ["➕"]),
      el("div", { className: "cmd-body" }, [
        el("div", { className: "cmd-name" }, ["Save this chat's actions as a recipe"]),
        el("div", { className: "cmd-desc" }, [recorded ? recorded + " replayable actions recorded in this chat." : "Do a task with the agent first — its clicks, typing and navigation are recorded; then save them here and replay for free."]),
      ]),
    ]));
    if (!ids.length) {
      content.appendChild(el("div", { className: "cmd-empty" }, ["No recipes yet."]));
      return;
    }
    ids.forEach(function (id) {
      var r = all[id];
      var actions = el("div", { className: "prof-actions column" }, [
        el("button", { className: "prof-btn", title: "Run (no model)", onclick: function (e) { e.stopPropagation(); showRunDialog(r); } }, ["▶"]),
        el("button", { className: "prof-btn", title: "Edit", onclick: function (e) { e.stopPropagation(); showRecipeEditor(r); } }, ["✏️"]),
        el("button", { className: "prof-btn", title: "Delete", onclick: function (e) { e.stopPropagation(); if (confirm("Delete recipe '" + r.name + "'?")) removeRecipe(r); } }, ["🗑"]),
      ]);
      var meta = r.steps.length + " steps · " + (r.startUrl ? hostOf(r.startUrl) : "current page") +
        (r.params && r.params.length ? " · params: " + r.params.map(function (p) { return p.name; }).join(", ") : "") +
        (r.lastRun ? " · " + (r.lastRun.ok ? "✓" : "✗") + " " + ago(r.lastRun.at) : "") + (r.runs ? " · " + r.runs + " runs" : "");
      content.appendChild(el("div", { className: "cmd-item", onclick: function () { showRecipeEditor(r); } }, [
        el("span", { className: "cmd-icon" }, [r.icon || "🧩"]),
        el("div", { className: "cmd-body" }, [
          el("div", { className: "cmd-name" }, [r.name]),
          r.description ? el("div", { className: "cmd-desc" }, [r.description]) : null,
          el("div", { className: "cmd-desc" }, [meta]),
          r.lastRun && !r.lastRun.ok && r.lastRun.error ? el("div", { className: "cmd-desc bad" }, ["Last run failed: " + r.lastRun.error]) : null,
        ]),
        actions,
      ]));
    });
  }

  async function removeRecipe(r) {
    try { await A.recipeDelete({ id: r.id }); status(""); renderRecipes(); } catch (e) { status("⚠ " + e.message, "bad"); }
  }

  // Candidate parameters: what the agent typed or searched for in this chat.
  function typedValues(steps) {
    var seen = {};
    var out = [];
    steps.forEach(function (s) {
      var vals = [];
      if (s.name === "browser_type" && s.args.text && !s.secret) vals.push({ value: String(s.args.text), hint: A.describeLoc(s.loc) });
      if (s.name === "browser_select" && s.args.option) vals.push({ value: String(s.args.option), hint: A.describeLoc(s.loc) });
      if (s.name === "browser_fill_form" && Array.isArray(s.args.fields)) s.args.fields.forEach(function (f) { if (!f.secret && f.value != null && String(f.value)) vals.push({ value: String(f.value), hint: A.describeLoc(f.loc) }); });
      if ((s.name === "browser_navigate" || s.name === "browser_new_tab") && s.args.url) {
        try { new URL(s.args.url).searchParams.forEach(function (v) { if (v.length > 1) vals.push({ value: v, hint: "in the URL" }); }); } catch (_) {}
      }
      vals.forEach(function (v) { if (v.value.length > 1 && !seen[v.value]) { seen[v.value] = true; out.push(v); } });
    });
    return out.slice(0, 12);
  }

  function showSaveDialog(existing) {
    var steps = A.traceSteps("chat");
    var preview;
    try { preview = A.buildRecipe(steps, { name: "x" }); } catch (e) { status("⚠ " + e.message, "bad"); renderRecipes(); return; }
    var name = el("input", { value: existing ? existing.name : "", placeholder: "Weekly report export" });
    var desc = el("input", { value: existing ? existing.description || "" : "", placeholder: "What it does (optional)" });
    var startUrl = el("input", { value: preview.startUrl || "" });
    var scope = el("select", null, [["chat", "This chat"], ["last", "Only the last reply"], ["all", "Everything recorded in this panel"]].map(function (o) { return el("option", { value: o[0] }, [o[1]]); }));
    var candidates = typedValues(steps);
    var paramRows = candidates.map(function (c) {
      var on = el("input", { type: "checkbox" });
      var pname = el("input", { value: c.value.replace(/[^\w]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 20).toLowerCase() || "value", placeholder: "name", className: "param-name" });
      return { on: on, pname: pname, value: c.value, row: el("div", { className: "param-row" }, [el("label", null, [on, " ", el("code", null, [c.value.slice(0, 40)]), el("span", { className: "ed-hint" }, [" — " + c.hint])]), pname]) };
    });
    var save = el("button", { className: "prof-btn primary" }, [existing ? "💾 Update recipe" : "💾 Save recipe"]);
    save.addEventListener("click", async function () {
      try {
        var params = paramRows.filter(function (p) { return p.on.checked; }).map(function (p) { return { name: p.pname.value.trim() || "value", value: p.value }; });
        var out = await A.recipeSave({ id: existing ? existing.id : undefined, name: name.value.trim() || (existing && existing.name) || "Recipe", description: desc.value.trim(), params: params, scope: scope.value, startUrl: startUrl.value.trim() });
        offer.classList.add("hidden");
        status(out.split("\n")[0], "good");
        renderRecipes();
      } catch (e) { status("⚠ " + e.message, "bad"); }
    });
    scope.addEventListener("change", function () {
      try { var p = A.buildRecipe(A.traceSteps(scope.value), { name: "x" }); stepsBox.replaceChildren.apply(stepsBox, stepList(p)); startUrl.value = p.startUrl || ""; } catch (e) { stepsBox.replaceChildren(el("div", { className: "cmd-desc bad" }, [e.message])); }
    });
    var stepsBox = el("div", { className: "steps" }, stepList(preview));
    content.textContent = "";
    content.appendChild(el("div", { className: "ed-wrap" }, [
      el("button", { className: "prof-btn", onclick: renderRecipes }, ["← Back"]),
      el("h3", { className: "ed-title" }, [existing ? "Re-record: " + existing.name : "New recipe from this chat"]),
      field("Name", name),
      field("Description", desc),
      field("Steps from", scope),
      field("Start page", startUrl),
      el("div", { className: "ed-section" }, ["Steps"]),
      stepsBox,
      candidates.length ? el("div", { className: "ed-section" }, ["Parameters ", el("span", { className: "ed-hint" }, ["(tick a value to ask for it at run time)"])]) : null,
      candidates.length ? el("div", null, paramRows.map(function (p) { return p.row; })) : null,
      el("div", { className: "ed-actions" }, [save, el("button", { className: "prof-btn", onclick: renderRecipes }, ["Cancel"])]),
    ]));
  }

  function stepList(recipe) {
    return recipe.steps.map(function (st, i) { return el("div", { className: "step-line" }, [el("span", { className: "step-n" }, [String(i + 1)]), A.stepLabel(st)]); });
  }

  function showRecipeEditor(r) {
    var name = el("input", { value: r.name });
    var desc = el("input", { value: r.description || "" });
    var startUrl = el("input", { value: r.startUrl || "" });
    var paramEls = (r.params || []).map(function (p) { return { p: p, ex: el("input", { value: p.example || "", placeholder: p.secret ? "(asked at run time)" : "example value", disabled: !!p.secret }) }; });
    var save = el("button", { className: "prof-btn primary" }, ["💾 Save"]);
    save.addEventListener("click", async function () {
      var all = await A.loadRecipes();
      var cur = all[r.id];
      if (!cur) return renderRecipes();
      cur.name = name.value.trim() || cur.name;
      cur.description = desc.value.trim();
      cur.startUrl = startUrl.value.trim();
      paramEls.forEach(function (x) { var p = cur.params.find(function (q) { return q.name === x.p.name; }); if (p && !p.secret) p.example = x.ex.value; });
      cur.updated = Date.now();
      await A.saveRecipes(all);
      status("Saved.", "good");
      renderRecipes();
    });
    content.textContent = "";
    content.appendChild(el("div", { className: "ed-wrap" }, [
      el("button", { className: "prof-btn", onclick: renderRecipes }, ["← Back"]),
      el("h3", { className: "ed-title" }, [(r.icon || "🧩") + " " + r.name]),
      field("Name", name),
      field("Description", desc),
      field("Start page", startUrl),
      el("div", { className: "ed-section" }, ["Steps ", el("span", { className: "ed-hint" }, ["(re-record from a chat to change them)"])]),
      el("div", { className: "steps" }, stepList(r)),
      paramEls.length ? el("div", { className: "ed-section" }, ["Parameters"]) : null,
      paramEls.length ? el("div", null, paramEls.map(function (x) { return field("{{" + x.p.name + "}}", x.ex); })) : null,
      el("div", { className: "ed-actions" }, [
        save,
        el("button", { className: "prof-btn", onclick: function () { showRunDialog(r); } }, ["▶ Run"]),
        el("button", { className: "prof-btn", onclick: function () { showSaveDialog(r); } }, ["⟲ Re-record from this chat"]),
        el("button", { className: "prof-btn", onclick: renderRecipes }, ["Cancel"]),
      ]),
    ]));
  }

  function showRunDialog(r) {
    var params = r.params || [];
    var inputs = params.map(function (p) { return { p: p, input: el("input", { type: p.secret ? "password" : "text", value: p.secret ? "" : p.example || "", placeholder: p.secret ? "not stored anywhere" : "" }) }; });
    var newTab = el("input", { type: "checkbox", checked: true });
    if (!params.length) return runRecipe(r, {}, true);
    var go = el("button", { className: "prof-btn primary" }, ["▶ Run"]);
    go.addEventListener("click", function () {
      var vals = {};
      inputs.forEach(function (x) { vals[x.p.name] = x.input.value; });
      runRecipe(r, vals, newTab.checked);
    });
    content.textContent = "";
    content.appendChild(el("div", { className: "ed-wrap" }, [
      el("button", { className: "prof-btn", onclick: renderRecipes }, ["← Back"]),
      el("h3", { className: "ed-title" }, ["Run: " + r.name]),
      el("div", null, inputs.map(function (x) { return field(x.p.name, x.input); })),
      el("label", { className: "ed-label" }, [newTab, " Run in a new tab"]),
      el("div", { className: "ed-actions" }, [go, el("button", { className: "prof-btn", onclick: renderRecipes }, ["Cancel"])]),
    ]));
  }

  var running = null;
  async function runRecipe(r, params, newTab) {
    if (running) { status("A recipe is already running.", "bad"); return; }
    running = r.id;
    var lines = [];
    var box = el("div", { className: "steps" });
    var stop = el("button", { className: "prof-btn" }, ["■ Stop"]);
    var ctrl = new AbortController();
    stop.addEventListener("click", function () { ctrl.abort(); });
    content.textContent = "";
    content.appendChild(el("div", { className: "ed-wrap" }, [
      el("h3", { className: "ed-title" }, ["▶ " + r.name]),
      el("div", { className: "cmd-desc" }, ["Replaying without the model — the page is found by its labels, not by the old refs."]),
      box,
      el("div", { className: "ed-actions" }, [stop]),
    ]));
    var rows = {};
    var onStep = function (i, total, label, st) {
      var key = String(i);
      if (!rows[key]) { rows[key] = el("div", { className: "step-line" }, [el("span", { className: "step-n" }, [i < 0 ? "→" : String(i + 1)]), label]); box.appendChild(rows[key]); }
      rows[key].className = "step-line " + st;
      rows[key].scrollIntoView({ block: "nearest" });
    };
    var result;
    try {
      result = await A.runRecipe(r, params, { newTab: newTab, onStep: onStep, signal: ctrl.signal });
      await A.recordRun(r, result);
    } catch (e) {
      running = null;
      status("⚠ " + e.message, "bad");
      return;
    }
    running = null;
    var done = el("div", { className: "ed-actions" }, [el("button", { className: "prof-btn", onclick: renderRecipes }, ["← Back"])]);
    if (result.ok) {
      status("✓ Done in " + (result.ms / 1000).toFixed(1) + " s.", "good");
    } else {
      status("✗ Step " + (result.failed.i + 1) + " failed: " + result.failed.error, "bad");
      done.insertBefore(el("button", { className: "prof-btn primary", title: "Hand the rest to the agent", onclick: function () {
        sendPrompt("Recipe '" + r.name + "' (id " + r.id + ") was replayed and failed at step " + (result.failed.i + 1) + " (" + result.failed.label + "): " + result.failed.error +
          ". The page is left as it is. Read it, finish the remaining steps by hand:\n" + r.steps.slice(result.failed.i).map(function (st, k) { return (result.failed.i + k + 1) + ". " + A.stepLabel(st); }).join("\n") +
          "\nThen call browser_recipe_save with id=\"" + r.id + "\" and scope=\"chat\" so the recipe is fixed.");
      } }, ["🩹 Fix with the agent"]), done.firstChild);
    }
    if (result.outputs.length) {
      box.appendChild(el("div", { className: "ed-section" }, ["Output"]));
      result.outputs.forEach(function (o) { box.appendChild(el("pre", { className: "auto-pre" }, [o.text.slice(0, 4000)])); });
      done.appendChild(el("button", { className: "prof-btn", onclick: function () {
        sendPrompt("The recipe '" + r.name + "' just produced this output. Summarize what matters:\n\n" + result.outputs.map(function (o) { return o.text; }).join("\n\n").slice(0, 12000));
      } }, ["💬 Discuss in chat"]));
    }
    box.parentNode.appendChild(done);
    stop.remove();
  }

  // ── Watchers ───────────────────────────────────────────────────────────

  async function renderWatchers() {
    var all = await A.loadWatchers();
    var events = (await chrome.storage.local.get(A.EVENTS_KEY))[A.EVENTS_KEY] || [];
    chrome.storage.local.set({ [A.SEEN_KEY]: Date.now() });
    badge.classList.add("hidden");
    var ids = Object.keys(all).sort(function (a, b) { return (all[b].created || 0) - (all[a].created || 0); });
    content.textContent = "";
    content.appendChild(el("div", { className: "cmd-item", onclick: showWatcherEditor }, [
      el("span", { className: "cmd-icon" }, ["➕"]),
      el("div", { className: "cmd-body" }, [
        el("div", { className: "cmd-name" }, ["Watch a page for changes"]),
        el("div", { className: "cmd-desc" }, ["Checked on a schedule in the background, no model involved. Changes arrive as a notification and in Telegram."]),
      ]),
    ]));
    if (!ids.length) content.appendChild(el("div", { className: "cmd-empty" }, ["No watchers yet."]));
    ids.forEach(function (id) {
      var w = all[id];
      var how = w.mode === "selector" ? "CSS " + w.selector : w.mode === "table" ? "table" : w.mode === "recipe" ? "recipe" : "page text";
      var last = w.lastRun ? (w.lastRun.ok ? "checked " + ago(w.lastRun.at) : "⚠ " + (w.lastRun.error || "failed")) : "first check pending";
      var actions = el("div", { className: "prof-actions column" }, [
        el("button", { className: "prof-btn", title: "Check now", onclick: function (e) { e.stopPropagation(); checkNow(w); } }, ["▶"]),
        el("button", { className: "prof-btn", title: w.enabled ? "Pause" : "Resume", onclick: function (e) { e.stopPropagation(); A.watchToggle(w.id, !w.enabled).then(renderWatchers); } }, [w.enabled ? "⏸" : "⏵"]),
        el("button", { className: "prof-btn", title: "Delete", onclick: function (e) { e.stopPropagation(); if (confirm("Delete watcher '" + w.name + "'?")) A.watchDelete({ id: w.id }).then(renderWatchers, function (err) { status("⚠ " + err.message, "bad"); }); } }, ["🗑"]),
      ]);
      content.appendChild(el("div", { className: "cmd-item" + (w.enabled ? "" : " paused") }, [
        el("span", { className: "cmd-icon" }, [w.enabled ? "👁" : "💤"]),
        el("div", { className: "cmd-body" }, [
          el("div", { className: "cmd-name" }, [w.name]),
          el("div", { className: "cmd-desc" }, [hostOf(w.url) + " · every " + w.every + " min · " + how]),
          el("div", { className: "cmd-desc" + (w.lastRun && !w.lastRun.ok ? " bad" : "") }, [last + (w.changes ? " · " + w.changes + " change" + (w.changes === 1 ? "" : "s") : "")]),
        ]),
        actions,
      ]));
    });
    var recent = events.slice().reverse().slice(0, 30);
    if (recent.length) {
      content.appendChild(el("div", { className: "cmd-group-title" }, ["Changes"]));
      recent.forEach(function (ev) {
        var lines = [];
        ev.added.slice(0, 6).forEach(function (l) { lines.push(el("div", { className: "diff-add" }, ["+ " + l])); });
        ev.removed.slice(0, 6).forEach(function (l) { lines.push(el("div", { className: "diff-del" }, ["− " + l])); });
        var more = ev.added.length + ev.removed.length - lines.length;
        if (more > 0) lines.push(el("div", { className: "cmd-desc" }, ["… " + more + " more lines"]));
        content.appendChild(el("div", { className: "cmd-item event" }, [
          el("span", { className: "cmd-icon" }, [ev.error ? "⚠" : "✦"]),
          el("div", { className: "cmd-body wide" }, [
            el("div", { className: "cmd-name" }, [ev.name, el("span", { className: "ed-hint" }, ["  " + ago(ev.at) + (ev.error ? "" : " · +" + ev.added.length + " / −" + ev.removed.length)])]),
            ev.error ? el("div", { className: "cmd-desc bad" }, [ev.error]) : el("div", { className: "diff" }, lines),
            el("div", { className: "prof-actions" }, [
              el("button", { className: "prof-btn", onclick: function () { chrome.tabs.create({ url: ev.url }); } }, ["Open page"]),
              ev.error ? null : el("button", { className: "prof-btn", onclick: function () {
                sendPrompt("The page " + ev.url + " (watcher '" + ev.name + "') changed. Added lines:\n" + ev.added.join("\n").slice(0, 6000) + "\n\nRemoved lines:\n" + ev.removed.join("\n").slice(0, 4000) + "\n\nTell me what changed and whether it matters.");
              } }, ["💬 Explain"]),
            ]),
          ]),
        ]));
      });
    }
  }

  async function checkNow(w) {
    status("Checking " + w.name + "…");
    var r = await A.requestRun(w.id);
    if (!r) status("The background worker didn't answer — it will check on schedule.", "bad");
    else if (!r.ok) status("⚠ " + (r.error || "failed"), "bad");
    else status(r.first ? "✓ Baseline saved (" + r.size + " chars)." : r.changed ? "✓ Changed: +" + r.added + " / −" + r.removed + " lines." : "✓ No change.", "good");
    renderWatchers();
  }

  async function showWatcherEditor() {
    var url = el("input", { value: await currentTabUrl(), placeholder: "https://…" });
    var name = el("input", { placeholder: hostOf(url.value) || "Price of X" });
    var every = el("input", { type: "number", value: 30, min: 1, max: 10080 });
    var mode = el("select", null, [["text", "Whole page text"], ["selector", "A part of the page (CSS selector)"], ["table", "A table"], ["recipe", "A recipe's output"]].map(function (o) { return el("option", { value: o[0] }, [o[1]]); }));
    var selector = el("input", { placeholder: ".price, #stock, table.results" });
    var recipes = await A.loadRecipes();
    var recipeSel = el("select", null, Object.keys(recipes).map(function (id) { return el("option", { value: id }, [recipes[id].name]); }));
    var waitFor = el("input", { placeholder: "Text that must be loaded first (optional)" });
    var tg = el("input", { type: "checkbox", checked: true });
    var selRow = field("Selector", selector), recRow = field("Recipe", recipeSel);
    var sync = function () { selRow.style.display = mode.value === "selector" || mode.value === "table" ? "" : "none"; recRow.style.display = mode.value === "recipe" ? "" : "none"; };
    mode.addEventListener("change", sync);
    sync();
    var save = el("button", { className: "prof-btn primary" }, ["👁 Start watching"]);
    save.addEventListener("click", async function () {
      try {
        var out = await A.watchCreate({ url: url.value.trim(), name: name.value.trim() || name.placeholder, every: Number(every.value), mode: mode.value, selector: selector.value.trim(), recipeId: mode.value === "recipe" ? recipeSel.value : "", waitFor: waitFor.value.trim(), telegram: tg.checked });
        status(out.split(".")[0] + ".", "good");
        renderWatchers();
      } catch (e) { status("⚠ " + e.message, "bad"); }
    });
    content.textContent = "";
    content.appendChild(el("div", { className: "ed-wrap" }, [
      el("button", { className: "prof-btn", onclick: renderWatchers }, ["← Back"]),
      el("h3", { className: "ed-title" }, ["New watcher"]),
      field("Page", url),
      field("Name", name),
      el("div", { className: "ed-row" }, [field("Every (minutes)", every), field("Compare", mode)]),
      selRow,
      recRow,
      field("Wait for", waitFor),
      el("label", { className: "ed-label" }, [tg, " Send changes to Telegram (needs the bot from the Remote settings)"]),
      el("div", { className: "ed-actions" }, [save, el("button", { className: "prof-btn", onclick: renderWatchers }, ["Cancel"])]),
    ]));
  }

  // ── Memory ─────────────────────────────────────────────────────────────

  async function renderMemory() {
    var m = await A.loadMemory();
    var hosts = Object.keys(m).filter(function (h) { return m[h].length; }).sort();
    content.textContent = "";
    content.appendChild(el("div", { className: "cmd-item", onclick: showNoteEditor }, [
      el("span", { className: "cmd-icon" }, ["➕"]),
      el("div", { className: "cmd-body" }, [
        el("div", { className: "cmd-name" }, ["Add a note about a site"]),
        el("div", { className: "cmd-desc" }, ["The agent reads a site's notes every time it looks at that site. It saves its own as it learns; yours go here."]),
      ]),
    ]));
    if (!hosts.length) { content.appendChild(el("div", { className: "cmd-empty" }, ["Nothing remembered yet."])); return; }
    hosts.forEach(function (h) {
      content.appendChild(el("div", { className: "cmd-group-title" }, [h === "*" ? "Every site" : h]));
      m[h].forEach(function (n, i) {
        content.appendChild(el("div", { className: "cmd-item" }, [
          el("span", { className: "cmd-icon" }, ["📝"]),
          el("div", { className: "cmd-body" }, [el("div", { className: "cmd-name note" }, [n.note]), el("div", { className: "cmd-desc" }, [ago(n.t)])]),
          el("div", { className: "prof-actions" }, [el("button", { className: "prof-btn", title: "Delete", onclick: function () { A.memoryDelete({ domain: h, index: i + 1 }).then(renderMemory, function (e) { status("⚠ " + e.message, "bad"); }); } }, ["🗑"])]),
        ]));
      });
    });
  }

  async function showNoteEditor() {
    var domain = el("input", { value: hostOf(await currentTabUrl()), placeholder: "example.com or *" });
    var note = el("textarea", { rows: 4, placeholder: "The export button is under the ⋯ menu, top right." });
    var save = el("button", { className: "prof-btn primary" }, ["💾 Save note"]);
    save.addEventListener("click", async function () {
      try { await A.memorySave({ domain: domain.value.trim(), note: note.value }); status("Saved.", "good"); renderMemory(); } catch (e) { status("⚠ " + e.message, "bad"); }
    });
    content.textContent = "";
    content.appendChild(el("div", { className: "ed-wrap" }, [
      el("button", { className: "prof-btn", onclick: renderMemory }, ["← Back"]),
      el("h3", { className: "ed-title" }, ["New note"]),
      field("Site", domain),
      field("Note", note),
      el("div", { className: "ed-actions" }, [save, el("button", { className: "prof-btn", onclick: renderMemory }, ["Cancel"])]),
    ]));
  }

  // ── Live updates & the unseen-changes dot ──────────────────────────────

  async function refreshBadge() {
    var st = await chrome.storage.local.get([A.EVENTS_KEY, A.SEEN_KEY]);
    var seen = st[A.SEEN_KEY] || 0;
    var unseen = (st[A.EVENTS_KEY] || []).filter(function (e) { return e.at > seen; }).length;
    badge.classList.toggle("hidden", !unseen || (curTab === "watchers" && !panel.classList.contains("hidden")));
  }
  chrome.storage.onChanged.addListener(function (ch, area) {
    if (area !== "local") return;
    if (ch[A.EVENTS_KEY] || ch[A.SEEN_KEY]) refreshBadge();
    if ((ch[A.RECIPES_KEY] || ch[A.WATCHERS_KEY] || ch[A.EVENTS_KEY] || ch[A.MEMORY_KEY]) && !panel.classList.contains("hidden") && !content.querySelector(".ed-wrap")) render();
  });
  refreshBadge();

  window.AgentAutomationsPanel = { show: show, hide: hide };
})();
