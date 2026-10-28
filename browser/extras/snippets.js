// Extra feature "snippets" (side panel): texts the user saved — a signature, a standard reply, an
// address, a form answer — inserted into forms and editors, with {{placeholders}} filled at insert
// time, and edited in place (browser_snippet_update keeps the id and the history). Stored in
// chrome.storage.local under one key (capped). Built into extras.js only for brands that switch the
// feature on; the tools are declared in browser/host/extras/snippets.ts. Also adds the ✂️ Snippets
// tab of the 🧩 panel and two "Writing" quick commands.
//
// Page-side functions are injected with chrome.scripting.executeScript, so each is self-contained
// (no closures over this file). The tab's DOM is built with ctx.el, never innerHTML: snippet texts
// and page selections are data, not markup.
(function () {
  if (!globalThis.AGENT_BRAND || !globalThis.AGENT_BRAND.has("snippets")) return;
  var T = globalThis.AgentBrowserTools;
  var H = T.helpers;
  var text = H.text;
  var KEY = "agentSnippets";
  var MAX = 200; // snippets kept
  var MAX_TEXT = 20000; // characters per snippet
  var PLACEHOLDER = /\{\{\s*([\w.-]+)\s*\}\}/g;

  // ── Pure helpers ─────────────────────────────────────────────────────────

  /** Placeholder names in a text, in order, each once. */
  function placeholders(t) {
    var out = [], seen = {};
    String(t || "").replace(PLACEHOLDER, function (m, n) { if (!seen[n]) { seen[n] = 1; out.push(n); } return m; });
    return out;
  }
  /** Fill {{name}} from values; a placeholder without a value stays as it is. */
  function fill(t, values) {
    values = values || {};
    return String(t || "").replace(PLACEHOLDER, function (m, n) { return values[n] === undefined || values[n] === null ? m : String(values[n]); });
  }
  function missingValues(t, values) {
    return placeholders(t).filter(function (n) { return !values || values[n] === undefined || values[n] === null; });
  }
  function firstLine(t) {
    var lines = String(t || "").split(/\r?\n/).filter(function (x) { return x.trim(); });
    var l = (lines[0] || "").trim();
    return (l.length > 80 ? l.slice(0, 77) + "…" : l) + (lines.length > 1 ? " …" : "");
  }
  function short(s) { s = String(s == null ? "" : s).replace(/\s+/g, " ").trim(); return s.length > 80 ? s.slice(0, 77) + "…" : s; }
  /** Tags: lower-case words, no #, no duplicates, at most ten (a string splits on commas/spaces). */
  function normTags(tags) {
    if (typeof tags === "string") tags = tags.split(/[,\s]+/);
    if (!Array.isArray(tags)) return [];
    var seen = {};
    return tags.map(function (t) { return String(t || "").trim().toLowerCase().replace(/^#/, "").slice(0, 30); })
      .filter(function (t) { if (!t || seen[t]) return false; seen[t] = 1; return true; }).slice(0, 10);
  }
  function fieldWords(r) {
    var k = r.kind === "editable" ? "rich-text editor" : r.kind === "textarea" ? "textarea" : r.kind ? r.kind.replace(/^input:/, "") + " input" : "field";
    return k + (r.label ? ' "' + r.label + '"' : "");
  }
  function byName(list, name) {
    var q = String(name || "").trim().toLowerCase();
    if (!q) return null;
    var exact = list.filter(function (s) { return s.name.toLowerCase() === q; });
    if (exact.length) return exact[0];
    var starts = list.filter(function (s) { return s.name.toLowerCase().indexOf(q) === 0; });
    return starts.length === 1 ? starts[0] : null;
  }
  /** The snippet `a` names (id first, then name); throws a message for the model when there is none. */
  function findSnippet(list, a) {
    a = a || {};
    if (a.id) {
      var byId = list.filter(function (s) { return s.id === a.id; })[0];
      if (!byId) throw new Error("No snippet with id " + a.id + ". browser_snippet_list shows the saved ones.");
      return byId;
    }
    if (a.name) {
      var s = byName(list, a.name);
      if (!s) throw new Error("No snippet named '" + a.name + "'. browser_snippet_list shows the saved ones.");
      return s;
    }
    throw new Error("name or id is required.");
  }
  /** The browser_snippet_list report (optionally one tag). */
  function formatList(list, tag) {
    tag = String(tag || "").trim().toLowerCase().replace(/^#/, "");
    var items = tag ? list.filter(function (s) { return (s.tags || []).indexOf(tag) !== -1; }) : list.slice();
    if (!items.length) return tag ? "No snippets tagged '" + tag + "'." + (list.length ? " " + list.length + " saved in all — browser_snippet_list without a tag shows them." : "") : "No snippets saved yet. browser_snippet_save keeps one.";
    items.sort(function (a, b) { return a.name.localeCompare(b.name); });
    return "Snippets (" + items.length + "):\n" + items.map(function (s) {
      var ph = placeholders(s.text);
      var meta = ["id " + s.id].concat((s.tags || []).length ? ["tags: " + s.tags.join(", ")] : []).concat(ph.length ? ["placeholders: " + ph.join(", ")] : []);
      return "- " + s.name + "  (" + meta.join("; ") + ")\n    " + firstLine(s.text);
    }).join("\n");
  }

  // ── Storage ──────────────────────────────────────────────────────────────

  async function load() {
    var st = await chrome.storage.local.get(KEY);
    var list = st && st[KEY];
    return Array.isArray(list) ? list : [];
  }
  function store(list) { var o = {}; o[KEY] = list; return chrome.storage.local.set(o); }
  function newId(list) {
    var id;
    do { id = "snp_" + Math.random().toString(36).slice(2, 8); } while (list.some(function (s) { return s.id === id; }));
    return id;
  }

  /** Save (or replace, by name) a snippet → { snippet, replaced }. */
  async function saveSnippet(a) {
    a = a || {};
    var name = String(a.name || "").replace(/\s+/g, " ").trim().slice(0, 60);
    if (!name) throw new Error("name is required — a short name for the snippet.");
    var body = String(a.text == null ? "" : a.text);
    if (!body.trim()) throw new Error("text is required — the snippet text.");
    if (body.length > MAX_TEXT) throw new Error("The snippet is too long (" + body.length + " chars; the limit is " + MAX_TEXT + ").");
    var list = await load();
    var now = Date.now();
    var i = -1;
    list.forEach(function (s, k) { if (i === -1 && s.name.toLowerCase() === name.toLowerCase()) i = k; });
    if (i !== -1) {
      var old = list[i];
      list[i] = Object.assign({}, old, { name: name, text: body, tags: a.tags === undefined ? old.tags || [] : normTags(a.tags), updated: now });
      await store(list);
      return { snippet: list[i], replaced: true };
    }
    if (list.length >= MAX) throw new Error("Snippet limit reached (" + MAX + "). Delete one with browser_snippet_delete first.");
    var s = { id: newId(list), name: name, text: body, tags: normTags(a.tags), created: now, updated: now, uses: 0 };
    list.push(s);
    await store(list);
    return { snippet: s, replaced: false };
  }

  async function deleteSnippet(a) {
    var list = await load();
    var s = findSnippet(list, a);
    await store(list.filter(function (x) { return x.id !== s.id; }));
    return s;
  }

  /**
   * Edit a snippet in place (newName, text, tags — at least one) → { snippet, changes }. The id, the
   * creation date and the use count stay; a rename to a name another snippet has is refused.
   */
  async function updateSnippet(a) {
    a = a || {};
    if (a.newName === undefined && a.text === undefined && a.tags === undefined) throw new Error("Nothing to change — pass newName, text or tags.");
    var list = await load();
    var s = findSnippet(list, a);
    var next = Object.assign({}, s), changes = [];
    if (a.newName !== undefined) {
      var name = String(a.newName || "").replace(/\s+/g, " ").trim().slice(0, 60);
      if (!name) throw new Error("newName must not be empty.");
      var clash = list.filter(function (x) { return x.id !== s.id && x.name.toLowerCase() === name.toLowerCase(); })[0];
      if (clash) throw new Error("Another snippet is already named '" + clash.name + "' (id " + clash.id + ") — pick a different name, or delete that one first.");
      if (name !== s.name) { next.name = name; changes.push("renamed '" + s.name + "' → '" + name + "'"); }
    }
    if (a.text !== undefined) {
      var body = String(a.text == null ? "" : a.text);
      if (!body.trim()) throw new Error("text must not be empty — browser_snippet_delete removes a snippet.");
      if (body.length > MAX_TEXT) throw new Error("The snippet is too long (" + body.length + " chars; the limit is " + MAX_TEXT + ").");
      if (body !== s.text) {
        var ph = placeholders(body);
        next.text = body;
        changes.push("text " + s.text.length + " → " + body.length + " chars" + (ph.length ? " (placeholders: " + ph.join(", ") + ")" : ""));
      }
    }
    if (a.tags !== undefined) {
      var tags = normTags(a.tags);
      if (tags.join(",") !== (s.tags || []).join(",")) { next.tags = tags; changes.push("tags " + ((s.tags || []).join(", ") || "none") + " → " + (tags.join(", ") || "none")); }
    }
    if (!changes.length) return { snippet: s, changes: [] };
    next.updated = Date.now();
    await store(list.map(function (x) { return x.id === s.id ? next : x; }));
    return { snippet: next, changes: changes };
  }

  async function bumpUse(id) {
    var list = await load();
    list.forEach(function (s) { if (s.id === id) { s.uses = (s.uses || 0) + 1; s.lastUsed = Date.now(); } });
    await store(list);
  }

  // ── Page side ────────────────────────────────────────────────────────────

  // Insert value at the caret (replacing a selection) of the focused text field or rich-text editor.
  function pageInsertAtCaret(value) {
    var TEXT_INPUT = /^(text|search|url|tel|email|password|number|)$/i;
    function deepActive() {
      var a = document.activeElement;
      while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
      return a && a !== document.body && a !== document.documentElement ? a : null;
    }
    function isField(el) { return el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && TEXT_INPUT.test(el.type || "text")); }
    function kindOf(el) { return el instanceof HTMLTextAreaElement ? "textarea" : el instanceof HTMLInputElement ? "input:" + (el.type || "text") : "editable"; }
    function clean(s) { return String(s || "").replace(/\s+/g, " ").trim().slice(0, 80); }
    function labelOf(el) {
      var t = el.getAttribute("aria-label") || "";
      if (!t && el.getAttribute("aria-labelledby")) t = el.getAttribute("aria-labelledby").split(/\s+/).map(function (id) { var n = document.getElementById(id); return n ? n.textContent : ""; }).join(" ");
      if (!t && el.labels && el.labels.length) t = el.labels[0].textContent;
      if (!t && el.closest("label")) t = el.closest("label").textContent;
      if (!t) t = el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("name") || "";
      return clean(t);
    }
    function editingHost(el) { var h = el; while (h.parentElement && h.parentElement.isContentEditable) h = h.parentElement; return h; }
    function later(info, read) {
      return new Promise(function (resolve) { setTimeout(function () { read(info); resolve(info); }, 120); });
    }
    var active = deepActive();
    if (active && isField(active)) {
      if (active instanceof HTMLInputElement) value = value.replace(/\r?\n+/g, " "); // a single-line field
      var before = active.value || "";
      var start = active.selectionStart, end = active.selectionEnd;
      if (start === null || end === null) { start = end = before.length; }
      var expected = before.slice(0, start) + value + before.slice(end);
      try { active.setRangeText(value, start, end, "end"); } catch (_) {
        var proto = active instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, "value").set.call(active, expected);
      }
      active.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
      active.dispatchEvent(new Event("change", { bubbles: true }));
      return later({ ok: true, kind: kindOf(active), label: labelOf(active) }, function (info) {
        var now = active.value || "";
        info.verified = now === expected || now.indexOf(value) !== -1;
        info.now = now.slice(0, 200);
      });
    }
    if (active && active.isContentEditable) {
      var host = editingHost(active);
      var sel = window.getSelection();
      if (!sel.rangeCount || !host.contains(sel.getRangeAt(0).commonAncestorContainer)) {
        var r = document.createRange(); r.selectNodeContents(host); r.collapse(false); sel.removeAllRanges(); sel.addRange(r);
      }
      var done = false;
      try { done = document.execCommand("insertText", false, value); } catch (_) {}
      if (!done) {
        var rg = sel.getRangeAt(0);
        rg.deleteContents();
        var tn = document.createTextNode(value);
        rg.insertNode(tn);
        rg.setStartAfter(tn); rg.collapse(true);
        host.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
      }
      return later({ ok: true, kind: "editable", label: labelOf(host) }, function (info) {
        var now = host.innerText || host.textContent || "";
        var norm = function (s) { return s.replace(/\s+/g, " ").trim(); };
        info.verified = norm(now).indexOf(norm(value).slice(0, 60)) !== -1;
        info.now = now.slice(0, 200);
      });
    }
    return { error: "No text field or editor has focus on the page. Ask the user to click into the field, or pass ref (an element from browser_read_page) to type the snippet there." };
  }

  // The text selected on the page (a text field's own selection first) — for "Save the selection as a snippet".
  function pageSelectedText() {
    var a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    if (a && (a instanceof HTMLTextAreaElement || a instanceof HTMLInputElement) && a.type !== "password" && a.selectionStart !== null && a.selectionEnd > a.selectionStart) {
      return { text: a.value.slice(a.selectionStart, a.selectionEnd) };
    }
    var sel = window.getSelection();
    return { text: sel ? sel.toString() : "" };
  }

  // ── Insert (shared by the tool and the tab) ──────────────────────────────

  function outText(out) { return (out || []).filter(function (p) { return p.type === "text"; }).map(function (p) { return p.text; }).join("\n"); }

  /** Fill and insert: into `ref` through browser_type, or at the caret of the focused field → { filled, how }. */
  async function insertSnippet(s, values, ref) {
    var missing = missingValues(s.text, values);
    if (missing.length) throw new Error("Snippet '" + s.name + "' needs values for: " + missing.map(function (n) { return "{{" + n + "}}"; }).join(", ") + ". Pass them in values (ask the user if you don't know them).");
    var filled = fill(s.text, values);
    var how;
    if (ref !== undefined && ref !== null) {
      var note = outText(await T.run("browser_type", { ref: Number(ref), text: filled }));
      how = "into [" + ref + "]" + (/^Typed into \[\d+\]\.$/.test(note) ? "" : " (" + note + ")");
    } else {
      var r = await H.inTop(pageInsertAtCaret, [filled]);
      if (!r || !r.ok) throw new Error((r && r.error) || "Could not insert the snippet.");
      how = "into the " + fieldWords(r) + (r.verified ? "" : ", but the field does not show the text (it holds: \"" + short(r.now) + "\") — the editor may reject programmatic input; show the text in the chat so the user can paste it");
    }
    await bumpUse(s.id);
    return { filled: filled, how: how };
  }

  // ── Tools ────────────────────────────────────────────────────────────────

  T.register("browser_snippet_save", async function (a) {
    var r = await saveSnippet(a);
    var s = r.snippet, ph = placeholders(s.text);
    return text((r.replaced ? "Updated" : "Saved") + " snippet '" + s.name + "' (id " + s.id + ", " + s.text.length + " chars" +
      (s.tags.length ? ", tags: " + s.tags.join(", ") : "") + (ph.length ? ", placeholders: " + ph.join(", ") : "") + "). browser_snippet_insert puts it into a field.");
  });

  T.register("browser_snippet_list", async function (a) {
    return text(formatList(await load(), a && a.tag));
  });

  T.register("browser_snippet_insert", async function (a) {
    a = a || {};
    var s = findSnippet(await load(), a);
    var r = await insertSnippet(s, a.values, a.ref);
    return text("Inserted snippet '" + s.name + "' (" + r.filled.length + " chars) " + r.how + ".");
  });

  T.register("browser_snippet_update", async function (a) {
    var r = await updateSnippet(a);
    if (!r.changes.length) return text("Snippet '" + r.snippet.name + "' (id " + r.snippet.id + ") already has these values — nothing changed.");
    return text("Updated snippet '" + r.snippet.name + "' (id " + r.snippet.id + "): " + r.changes.join("; ") + ".");
  });

  T.register("browser_snippet_delete", async function (a) {
    var s = await deleteSnippet(a);
    return text("Deleted snippet '" + s.name + "'.");
  });

  // ── The ✂️ Snippets tab ──────────────────────────────────────────────────

  function item(el, icon, name, desc, onclick) {
    return el("div", { className: "cmd-item", onclick: onclick }, [
      el("span", { className: "cmd-icon" }, [icon]),
      el("div", { className: "cmd-body" }, [el("div", { className: "cmd-name" }, [name]), el("div", { className: "cmd-desc" }, [desc])]),
    ]);
  }

  async function render(content, ctx) {
    var el = ctx.el;
    var list = await load();
    content.textContent = "";
    content.appendChild(item(el, "➕", "Add a snippet", "A text you insert again and again — a signature, a standard reply, an address. {{name}} marks a placeholder you fill when inserting.", function () { showEditor(content, ctx, null); }));
    content.appendChild(item(el, "💾", "Save the selection as a snippet", "Takes the text selected on the current page.", async function () {
      try {
        var r = await H.inTop(pageSelectedText, []);
        if (!r || !r.text || !r.text.trim()) { ctx.status("Nothing is selected on the page.", "bad"); return; }
        showEditor(content, ctx, { text: r.text });
      } catch (e) { ctx.status("⚠ " + ((e && e.message) || e), "bad"); }
    }));
    if (!list.length) { content.appendChild(el("div", { className: "cmd-empty" }, ["No snippets yet."])); return; }
    list.slice().sort(function (a, b) { return a.name.localeCompare(b.name); }).forEach(function (s) {
      var ph = placeholders(s.text);
      var meta = [(s.tags || []).length ? "#" + s.tags.join(" #") : "", ph.length ? "{{" + ph.join("}} {{") + "}}" : "", s.uses ? s.uses + " use" + (s.uses === 1 ? "" : "s") : ""].filter(Boolean).join(" · ");
      var actions = el("div", { className: "prof-actions column" }, [
        el("button", { className: "prof-btn", title: "Insert into the focused field of the current tab", onclick: function (e) { e.stopPropagation(); insertFromPanel(content, ctx, s); } }, ["⤵ Insert"]),
        el("button", { className: "prof-btn", title: "Copy the text", onclick: function (e) { e.stopPropagation(); copySnippet(ctx, s); } }, ["📋 Copy"]),
        el("button", { className: "prof-btn", title: "Delete", onclick: function (e) { e.stopPropagation(); if (confirm("Delete snippet '" + s.name + "'?")) deleteSnippet({ id: s.id }).then(function () { ctx.status("Deleted '" + s.name + "'.", "good"); ctx.rerender(); }, function (err) { ctx.status("⚠ " + err.message, "bad"); }); } }, ["🗑"]),
      ]);
      content.appendChild(el("div", { className: "cmd-item", onclick: function () { showEditor(content, ctx, s); } }, [
        el("span", { className: "cmd-icon" }, ["✂️"]),
        el("div", { className: "cmd-body" }, [
          el("div", { className: "cmd-name" }, [s.name]),
          el("div", { className: "cmd-desc" }, [firstLine(s.text)]),
          meta ? el("div", { className: "cmd-desc" }, [meta]) : null,
        ]),
        actions,
      ]));
    });
  }

  function showEditor(content, ctx, s) {
    var el = ctx.el;
    var name = el("input", { value: (s && s.name) || "", placeholder: "Signature, Refund reply, Office address…" });
    var body = el("textarea", { rows: 6, value: (s && s.text) || "", placeholder: "Dear {{name}},\n\nthank you for your message…" });
    var tags = el("input", { value: ((s && s.tags) || []).join(", "), placeholder: "mail, support (optional)" });
    var save = el("button", { className: "prof-btn primary" }, [s && s.id ? "💾 Save" : "💾 Save snippet"]);
    save.addEventListener("click", async function () {
      try {
        var r = await saveSnippet({ name: name.value, text: body.value, tags: tags.value });
        ctx.status((r.replaced ? "Updated '" : "Saved '") + r.snippet.name + "'.", "good");
        ctx.rerender();
      } catch (e) { ctx.status("⚠ " + ((e && e.message) || e), "bad"); }
    });
    content.textContent = "";
    content.appendChild(el("div", { className: "ed-wrap" }, [
      el("button", { className: "prof-btn", onclick: function () { ctx.rerender(); } }, ["← Back"]),
      el("h3", { className: "ed-title" }, [s && s.id ? "✂️ " + s.name : "New snippet"]),
      ctx.field("Name", name),
      ctx.field("Text", body),
      ctx.field("Tags", tags),
      el("div", { className: "ed-hint" }, ["{{name}} in the text is a placeholder: the agent (or the Insert button) asks for its value."]),
      el("div", { className: "ed-actions" }, [save, el("button", { className: "prof-btn", onclick: function () { ctx.rerender(); } }, ["Cancel"])]),
    ]));
    if (s && !s.id) name.focus && name.focus();
  }

  async function doInsert(ctx, s, values) {
    try {
      var r = await insertSnippet(s, values);
      ctx.status("Inserted '" + s.name + "' " + r.how + ".", "good");
      ctx.rerender();
    } catch (e) { ctx.status("⚠ " + ((e && e.message) || e), "bad"); }
  }

  function insertFromPanel(content, ctx, s) {
    var ph = placeholders(s.text);
    if (!ph.length) return doInsert(ctx, s, {});
    var el = ctx.el;
    var inputs = ph.map(function (n) { return { n: n, input: el("input", { placeholder: n }) }; });
    var go = el("button", { className: "prof-btn primary" }, ["⤵ Insert"]);
    go.addEventListener("click", function () {
      var values = {};
      inputs.forEach(function (x) { values[x.n] = x.input.value; });
      doInsert(ctx, s, values);
    });
    content.textContent = "";
    content.appendChild(el("div", { className: "ed-wrap" }, [
      el("button", { className: "prof-btn", onclick: function () { ctx.rerender(); } }, ["← Back"]),
      el("h3", { className: "ed-title" }, ["Insert: " + s.name]),
      el("div", { className: "cmd-desc" }, ["Goes into the field that has focus on the current tab."]),
      el("div", null, inputs.map(function (x) { return ctx.field("{{" + x.n + "}}", x.input); })),
      el("div", { className: "ed-actions" }, [go, el("button", { className: "prof-btn", onclick: function () { ctx.rerender(); } }, ["Cancel"])]),
    ]));
  }

  function copySnippet(ctx, s) {
    var clip = typeof navigator !== "undefined" && navigator.clipboard;
    if (!clip) { ctx.status("⚠ The clipboard is not available here.", "bad"); return; }
    clip.writeText(s.text).then(function () { ctx.status("Copied '" + s.name + "'.", "good"); }, function (e) { ctx.status("⚠ Could not copy: " + ((e && e.message) || e), "bad"); });
  }

  globalThis.AgentExtras.tabs.push({ id: "snippets", label: "✂️ Snippets", render: render, storageKeys: [KEY] });
  globalThis.AgentExtras.commands.push(
    { group: "Writing", icon: "💾", name: "Save the selection as a snippet", prompt: "Save the text I selected on the page as a snippet (read it with browser_selection_get, keep it with browser_snippet_save) named: ", partial: true },
    { group: "Writing", icon: "✂️", name: "Insert a snippet", prompt: "Insert into the field I'm in (browser_snippet_insert; ask me for any placeholder values) the snippet named: ", partial: true }
  );

  /** The pure parts and the storage functions, for tests and other modules. */
  globalThis.AgentExtras.snippets = {
    KEY: KEY,
    MAX: MAX,
    MAX_TEXT: MAX_TEXT,
    placeholders: placeholders,
    fill: fill,
    missingValues: missingValues,
    firstLine: firstLine,
    normTags: normTags,
    formatList: formatList,
    findSnippet: findSnippet,
    load: load,
    saveSnippet: saveSnippet,
    updateSnippet: updateSnippet,
    deleteSnippet: deleteSnippet,
    insertSnippet: insertSnippet,
    pageInsertAtCaret: pageInsertAtCaret,
    pageSelectedText: pageSelectedText,
  };
})();
