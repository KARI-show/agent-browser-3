// Extra feature "forms" (side panel): a page's form read as the user sees it (browser_form_read) and
// drafts of what was typed — saved per page (browser_form_draft_save) and brought back field by field
// (browser_form_draft_restore). Built into extras.js only for brands that switch the feature on; the
// tools are declared in browser/host/extras/forms.ts. Also adds the 📝 Drafts tab of the 🧩 panel and
// two "Forms" quick commands.
//
// The page is read and filled through the autofill extra's collector and filler (AgentExtras.autofill:
// autofill.js precedes this file in extras.js, so a brand with "forms" switches "autofill" on too) —
// the fields come back described per frame, with opts.all every field the user sees, and the values go
// in through the native setter plus input/change events. Nothing here submits anything.
//
// Storage: chrome.storage.local[KEY] = { "<origin+path>": { url, title, t, fields: [{ key, label, value }] } },
// at most MAX drafts (the oldest goes first), values cut at MAX_VALUE characters. A draft never holds a
// password field or one that looks like a card number, CVV, IBAN, SSN or other secret. The tab's DOM is
// built with ctx.el, never innerHTML — titles and labels come from web pages.
(function () {
  if (!globalThis.AGENT_BRAND || !globalThis.AGENT_BRAND.has("forms")) return;
  var T = globalThis.AgentBrowserTools;
  var X = globalThis.AgentExtras;
  if (!T || !X) return;
  var A = X.autofill;
  if (!A) { console.warn("extras/forms: the autofill extra is not loaded — the forms tools need its field collector; switch autofill on for this brand."); return; }
  var H = T.helpers;
  var text = H.text;

  var KEY = "agentFormDrafts";
  var MAX = 50; // drafts kept
  var MAX_VALUE = 2000; // characters per draft value
  var MAX_OPTIONS = 8; // select options named in a report
  var MAX_NAMES = 10; // fields named per bucket in a report

  // ── Words (pure) ────────────────────────────────────────────────────────

  var fieldName = A.fieldName;
  function oneLine(s, max) {
    s = String(s == null ? "" : s).replace(/\s*\n\s*/g, " / ").replace(/\s+/g, " ").trim();
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
  }
  function ago(ts) {
    if (!ts) return "";
    var d = Date.now() - ts;
    if (d < 60000) return "just now";
    if (d < 3600000) return Math.floor(d / 60000) + "m ago";
    if (d < 86400000) return Math.floor(d / 3600000) + "h ago";
    return Math.floor(d / 86400000) + "d ago";
  }
  function plural(n, word) { return n + " " + word + (n === 1 ? "" : "s"); }
  function names(list) {
    return list.slice(0, MAX_NAMES).map(fieldName).join(", ") + (list.length > MAX_NAMES ? " … (" + list.length + " in all)" : "");
  }

  // ── The form report (pure) ──────────────────────────────────────────────

  function typeWord(f) { return f.tag === "input" ? f.type : f.tag; }
  function isEmpty(f) {
    if (f.type === "password") return !f.passwordLength;
    if (f.type === "checkbox" || f.type === "radio") return !f.checked;
    return !String(f.value == null ? "" : f.value).trim();
  }
  function optionsWords(f) {
    var opts = (f.options || []).map(function (o) { return o.text; }).filter(Boolean);
    if (!opts.length) return "";
    return " (options: " + opts.slice(0, MAX_OPTIONS).join(", ") + (opts.length > MAX_OPTIONS ? " … " + opts.length + " in all" : "") + ")";
  }
  function valueWords(f) {
    if (f.type === "password") return f.passwordLength ? "•••• (" + plural(f.passwordLength, "char") + ")" : "empty";
    if (f.type === "checkbox") return f.checked ? "☑ checked" : "☐ unchecked";
    if (f.tag === "select") return (f.value ? '"' + oneLine(f.value, 60) + '"' : "nothing chosen") + optionsWords(f);
    return f.value ? '"' + oneLine(f.value, 60) + '"' : "empty";
  }
  function stateWords(f, empty) {
    var out = [];
    if (f.required && empty) out.push("required, empty");
    if (f.valid === false) out.push("invalid" + (f.message ? ": " + f.message : ""));
    if (f.disabled) out.push("disabled");
    if (f.readonly) out.push("read-only");
    return out.length ? " — " + out.join("; ") : "";
  }

  /** A field's name for the report, without the frame suffix — the group heading names the frame. */
  function labelOf(f) { return fieldName(f.frame ? Object.assign({}, f, { frame: 0 }) : f); }

  /**
   * The report's entries in page order, one per field — the radios of one name in one form as one
   * entry → [{ group, form, frame, label, type, empty, required, valid, message, line }].
   */
  function entriesOf(fields) {
    var entries = [], radioGroups = {};
    (fields || []).forEach(function (f) {
      if (!f) return;
      var frame = f.frame || 0;
      var group = frame + ":" + (f.form ? f.form.i : "none");
      if (f.type === "radio" && f.name) {
        var rk = group + "|" + f.name;
        if (!radioGroups[rk]) { radioGroups[rk] = { group: group, form: f.form || null, frame: frame, radio: true, name: f.name, items: [] }; entries.push(radioGroups[rk]); }
        radioGroups[rk].items.push(f);
        return;
      }
      entries.push({ group: group, form: f.form || null, frame: frame, field: f });
    });
    return entries.map(function (e) {
      if (!e.radio) {
        var f = e.field, empty = isEmpty(f);
        return {
          group: e.group, form: e.form, frame: e.frame, label: labelOf(f), type: typeWord(f), empty: empty, required: !!f.required, valid: f.valid !== false, message: f.message || "",
          line: "- " + labelOf(f) + (f.required ? " *" : "") + " [" + typeWord(f) + "] " + (f.type === "checkbox" ? valueWords(f) : "= " + valueWords(f)) + stateWords(f, empty),
        };
      }
      var chosen = e.items.filter(function (f) { return f.checked; })[0] || null;
      var required = e.items.some(function (f) { return f.required; });
      var invalid = e.items.filter(function (f) { return f.valid === false; })[0] || null;
      var label = e.name;
      var state = { required: required, valid: !invalid, message: invalid ? invalid.message : "", disabled: e.items.every(function (f) { return f.disabled; }), readonly: false };
      return {
        group: e.group, form: e.form, frame: e.frame, label: label, type: "radio", empty: !chosen, required: required, valid: !invalid, message: state.message,
        line: "- " + label + (required ? " *" : "") + " [radio] = " + (chosen ? '"' + oneLine(chosen.label || chosen.optionValue, 60) + '"' : "nothing chosen") +
          " (of " + e.items.map(function (f) { return oneLine(f.label || f.optionValue || "?", 30); }).join(", ") + ")" + stateWords(state, !chosen),
      };
    });
  }

  /** The one-line summary: "12 fields · 3 required empty · 1 invalid: Email". */
  function formSummary(fields) {
    var es = entriesOf(fields);
    var reqEmpty = es.filter(function (e) { return e.required && e.empty; }).length;
    var invalid = es.filter(function (e) { return !e.valid; }).map(function (e) { return e.label; });
    return plural(es.length, "field") + " · " + reqEmpty + " required empty · " + invalid.length + " invalid" + (invalid.length ? ": " + invalid.join(", ") : "");
  }

  function formHeading(form, frame) {
    var where = frame ? " [frame " + frame + "]" : "";
    if (!form) return "Outside any <form>" + where + ":";
    var what = form.name ? 'Form "' + form.name + '"' : form.id ? "Form #" + form.id : "Form";
    var bits = [];
    if (form.name && form.id) bits.push("id " + form.id);
    if (form.action) bits.push("posts to " + form.action);
    var submits = (form.submits || []).map(function (s) { return '"' + s + '"'; });
    return what + (bits.length ? " (" + bits.join(", ") + ")" : "") + where + " · " + (submits.length ? "submit: " + submits.join(", ") : "no submit button") + ":";
  }

  /** The browser_form_read report: the summary line, then every field grouped by <form> with its submit buttons. */
  function formReport(fields) {
    var es = entriesOf(fields);
    if (!es.length) return "No form field is visible on this page.";
    var groups = [], byKey = {};
    es.forEach(function (e) {
      var g = byKey[e.group];
      if (!g) { g = byKey[e.group] = { form: e.form, frame: e.frame, lines: [] }; groups.push(g); }
      g.lines.push(e.line);
    });
    var out = [formSummary(fields)];
    groups.forEach(function (g) {
      if (groups.length > 1 || g.form) out.push(formHeading(g.form, g.frame));
      out = out.concat(g.lines);
    });
    return out.join("\n");
  }

  // ── Drafts (pure) ───────────────────────────────────────────────────────

  /** The draft key of a page: origin + path, query and hash dropped; a non-URL loses only those. */
  function pageKey(url) {
    var s = String(url == null ? "" : url).trim();
    try { var u = new URL(s); return u.origin + u.pathname; } catch (_) { return s.replace(/[?#].*$/, ""); }
  }

  /** The stable key of a page field: id, else name (a checkbox or radio: name=value), else label — prefixed with its frame when not the top one; "" when it has none. */
  function fieldKey(f) {
    var toggle = f.type === "checkbox" || f.type === "radio";
    var k = f.id || (f.name ? (toggle && f.optionValue ? f.name + "=" + f.optionValue : f.name) : "") || f.label || "";
    k = String(k).replace(/\s+/g, " ").trim().slice(0, 120);
    return k ? (f.frame ? "[" + f.frame + "]" : "") + k : "";
  }

  /** The fields with their keys (`key`); a key seen again gets "#2", "#3"… so the numbering is the same on save and restore. */
  function keyedFields(fields) {
    var seen = {};
    return (fields || []).map(function (f) {
      var k = fieldKey(f);
      if (!k) return Object.assign({}, f, { key: "" });
      seen[k] = (seen[k] || 0) + 1;
      return Object.assign({}, f, { key: seen[k] > 1 ? k + "#" + seen[k] : k });
    });
  }

  /**
   * A draft of a page's fields → { draft: { url, title, t, fields: [{ key, label, value }] }, skipped: { empty,
   * password, secret, locked, noKey }, cut }: fields that hold a value, keyed, values cut at MAX_VALUE; a
   * password field, a secret-looking one, a disabled or read-only one and one without id, name or label is skipped.
   */
  function draftOf(fields, meta) {
    meta = meta || {};
    var kept = [], skipped = { empty: [], password: [], secret: [], locked: [], noKey: [] }, cut = [];
    keyedFields(fields).forEach(function (f) {
      if (f.type === "password") { skipped.password.push(f); return; }
      if (A.isSecretField(f)) { skipped.secret.push(f); return; }
      var v = String(f.value == null ? "" : f.value).replace(/\r\n?/g, "\n");
      if (!v.trim()) { skipped.empty.push(f); return; }
      if (f.disabled || f.readonly) { skipped.locked.push(f); return; }
      if (!f.key) { skipped.noKey.push(f); return; }
      if (v.length > MAX_VALUE) { v = v.slice(0, MAX_VALUE); cut.push(f); }
      kept.push({ key: f.key, label: fieldName(f), value: v });
    });
    var title = String(meta.title == null ? "" : meta.title).replace(/\s+/g, " ").trim().slice(0, 200);
    return { draft: { url: String(meta.url == null ? "" : meta.url), title: title, t: meta.now || Date.now(), fields: kept }, skipped: skipped, cut: cut };
  }

  /**
   * How a draft goes back onto a page's fields → { plan, skipped, missing, noOption, refused }: plan
   * [{ field, key, value, option?, shown? }] for the fields found by key (a select needs an option that
   * shows the value), skipped: those that already hold a value (unless opts.overwrite), missing: draft
   * fields with no field of that key on the page, refused: fields that are disabled, read-only or secret.
   */
  function restorePlan(fields, draft, opts) {
    opts = opts || {};
    var byKey = {};
    keyedFields(fields).forEach(function (f) { if (f.key && !byKey[f.key]) byKey[f.key] = f; });
    var plan = [], skipped = [], missing = [], noOption = [], refused = [];
    ((draft && draft.fields) || []).forEach(function (d) {
      var f = byKey[d.key];
      if (!f) { missing.push(d); return; }
      if (f.type === "password" || A.isSecretField(f)) { refused.push({ field: f, key: d.key, value: d.value, why: "a secret field is never filled" }); return; }
      if (f.disabled || f.readonly) { refused.push({ field: f, key: d.key, value: d.value, why: "the field is disabled or read-only" }); return; }
      var item = { field: f, key: d.key, value: d.value };
      if (f.tag === "select") {
        var o = A.pickOption(f.options, d.value);
        if (!o) { noOption.push(Object.assign({ field: f }, d)); return; }
        item.option = o.value; item.shown = o.text;
      }
      if (f.value && opts.overwrite !== true) { skipped.push(item); return; }
      plan.push(item);
    });
    return { plan: plan, skipped: skipped, missing: missing, noOption: noOption, refused: refused };
  }

  /** At most MAX drafts: the oldest (by t) are dropped, never `keep`. Returns a new object. */
  function trimDrafts(drafts, keep) {
    var out = Object.assign({}, drafts);
    var keys = Object.keys(out);
    if (keys.length <= MAX) return out;
    keys.sort(function (a, b) { return ((out[a] && out[a].t) || 0) - ((out[b] && out[b].t) || 0); });
    for (var i = 0; i < keys.length && Object.keys(out).length > MAX; i++) if (keys[i] !== keep) delete out[keys[i]];
    return out;
  }

  /** The draft key `url` names: its page key when a draft has it, else the one key that contains the text (case-insensitive); null otherwise. */
  function findDraftKey(drafts, url) {
    var k = pageKey(url);
    if (k && drafts[k]) return k;
    var q = String(url || "").trim().toLowerCase();
    if (!q) return null;
    var hits = Object.keys(drafts).filter(function (x) { return x.toLowerCase().indexOf(q) !== -1; });
    return hits.length === 1 ? hits[0] : null;
  }

  /** The browser_form_draft_restore list=true report. */
  function formatDrafts(drafts) {
    var keys = Object.keys(drafts).sort(function (a, b) { return (drafts[b].t || 0) - (drafts[a].t || 0); });
    if (!keys.length) return "No drafts saved yet. browser_form_draft_save keeps what the user typed into a form.";
    return "Drafts (" + keys.length + " of " + MAX + "):\n" + keys.map(function (k) {
      var d = drafts[k], n = d.fields.length;
      return "- " + k + (d.title ? '  "' + d.title + '"' : "") + " · " + plural(n, "field") + " · " + ago(d.t) + "\n    " + d.fields.slice(0, 8).map(function (f) { return f.label; }).join(", ") + (n > 8 ? " …" : "");
    }).join("\n");
  }

  /** The browser_form_draft_save report for a page key, a draftOf result and the draft it replaces (if any). */
  function formatSaved(key, r, had) {
    var d = r.draft, n = d.fields.length;
    var out = "Saved a draft of " + key + (d.title ? ' ("' + d.title + '")' : "") + ": " + plural(n, "field") + " kept — " +
      d.fields.slice(0, MAX_NAMES).map(function (f) { return f.label; }).join(", ") + (n > MAX_NAMES ? " … (" + n + " in all)" : "") +
      (had ? " (replaces the draft from " + ago(had.t) + ")" : "") + ".";
    var sk = r.skipped, parts = [];
    if (sk.empty.length) parts.push(sk.empty.length + " empty (" + names(sk.empty) + ")");
    if (sk.password.length) parts.push(sk.password.length + " password (" + names(sk.password) + ")");
    if (sk.secret.length) parts.push(sk.secret.length + " secret (" + names(sk.secret) + ")");
    if (sk.locked.length) parts.push(sk.locked.length + " disabled or read-only (" + names(sk.locked) + ")");
    if (sk.noKey.length) parts.push(sk.noKey.length + " without id, name or label");
    if (parts.length) out += "\nSkipped: " + parts.join("; ") + ".";
    if (r.cut.length) out += "\nCut at " + MAX_VALUE + " characters: " + names(r.cut) + ".";
    return out + "\nbrowser_form_draft_restore brings it back on this page.";
  }

  /** The browser_form_draft_restore report for a page key, its draft, a restorePlan result and the fill results. */
  function formatRestore(key, draft, m, results) {
    var resultOf = {};
    (results || []).forEach(function (x) { resultOf[(x.frame || 0) + ":" + x.i] = x; });
    var filled = 0, lines = [];
    var toggle = function (f) { return f.type === "checkbox" || f.type === "radio"; };
    m.plan.forEach(function (p) {
      var x = resultOf[(p.field.frame || 0) + ":" + p.field.i];
      var head = toggle(p.field) ? fieldName(p.field) + " ☑ checked" : fieldName(p.field) + " = " + oneLine(p.value, 80) + (p.shown !== undefined && String(p.shown).toLowerCase() !== String(p.value).toLowerCase() ? ' (option "' + p.shown + '")' : "");
      if (x && x.ok && x.verified !== false) { filled++; lines.push("filled: " + head); }
      else lines.push("not filled: " + head + " — " + ((x && x.why) || "the field does not show the value; the page may reject programmatic input — type it with browser_type"));
    });
    m.skipped.forEach(function (s) {
      if (toggle(s.field)) lines.push("skipped (already checked): " + fieldName(s.field));
      else lines.push("skipped (already filled): " + fieldName(s.field) + ' (holds "' + oneLine(s.field.value, 40) + '", the draft has "' + oneLine(s.value, 40) + '"; pass overwrite=true to replace it)');
    });
    m.noOption.forEach(function (d) { lines.push("not filled: " + fieldName(d.field) + ' — no option shows "' + oneLine(d.value, 40) + '"'); });
    m.refused.forEach(function (r) { lines.push("not filled: " + fieldName(r.field) + " — " + r.why); });
    if (m.missing.length) lines.push("missing on the page: " + m.missing.map(function (d) { return d.label + " (" + d.key + ")"; }).join(", "));
    var n = draft.fields.length;
    return "Restored the draft of " + key + " (saved " + ago(draft.t) + ", " + plural(n, "field") + "): filled " + filled + " of " + n + ":\n" + lines.join("\n") + "\nNothing was submitted — the user checks the form and sends it.";
  }

  // ── Storage ─────────────────────────────────────────────────────────────

  async function loadDrafts() {
    var st = await chrome.storage.local.get(KEY);
    var d = st && st[KEY];
    if (!d || typeof d !== "object" || Array.isArray(d)) return {};
    var out = {};
    Object.keys(d).forEach(function (k) { if (d[k] && Array.isArray(d[k].fields)) out[k] = d[k]; });
    return out;
  }
  function storeDrafts(drafts) { var o = {}; o[KEY] = drafts; return chrome.storage.local.set(o); }
  async function deleteDraft(key) {
    var drafts = await loadDrafts();
    var d = drafts[key];
    if (!d) return null;
    delete drafts[key];
    await storeDrafts(drafts);
    return { draft: d, left: Object.keys(drafts).length };
  }

  // ── The page ────────────────────────────────────────────────────────────

  /** The current tab's { url, title }; throws for a tab that is not a web page. */
  async function pageMeta() {
    var tab = await H.currentTab();
    if (!tab || H.ownPage(tab) || !/^https?:/i.test(tab.url || "")) throw new Error("The current tab is not a web page (" + ((tab && tab.url) || "no address") + ") — open the form's page first.");
    return { url: tab.url, title: tab.title || "" };
  }
  /** Every field the user sees, in every frame (the autofill collector with opts.all). */
  async function readFields(maxValue) {
    var fields = await A.collectFields({ all: true, maxValue: maxValue || 120 });
    if (!fields.length) throw new Error("No form field is visible on this page (inputs, textareas, selects, checkboxes or radios). Read the page with browser_read_page first.");
    return fields;
  }

  // ── Tools ───────────────────────────────────────────────────────────────

  T.register("browser_form_read", async function () {
    return text(formReport(await readFields()));
  });

  T.register("browser_form_draft_save", async function () {
    var meta = await pageMeta();
    var fields = await readFields(MAX_VALUE);
    var r = draftOf(fields, { url: meta.url, title: meta.title, now: Date.now() });
    if (!r.draft.fields.length) {
      var sk = r.skipped, why = [];
      if (sk.password.length || sk.secret.length) why.push("only password or secret fields hold a value (" + names(sk.password.concat(sk.secret)) + "), and those are never kept");
      if (sk.locked.length) why.push(plural(sk.locked.length, "disabled or read-only field") + " left out");
      throw new Error("Nothing to save: no field on this page holds a value the draft could keep" + (why.length ? " — " + why.join("; ") : "") + ". Drafts keep what the user typed; the form is still empty.");
    }
    var key = pageKey(meta.url);
    var drafts = await loadDrafts();
    var had = drafts[key] || null;
    drafts[key] = r.draft;
    await storeDrafts(trimDrafts(drafts, key));
    return text(formatSaved(key, r, had));
  });

  T.register("browser_form_draft_restore", async function (a) {
    a = a || {};
    var drafts = await loadDrafts();
    if (a.list === true) return text(formatDrafts(drafts));
    var url = a.url ? String(a.url) : (await pageMeta()).url;
    var key = findDraftKey(drafts, url);
    if (!key) {
      var n = Object.keys(drafts).length;
      throw new Error("No draft saved for " + pageKey(url) + "." + (n ? " " + plural(n, "draft") + (n === 1 ? " is" : " are") + " saved — browser_form_draft_restore with list=true shows them." : " browser_form_draft_save keeps one."));
    }
    var draft = drafts[key];
    if (a.delete === true) {
      var d = await deleteDraft(key);
      return text("Deleted the draft of " + key + (draft.title ? ' ("' + draft.title + '")' : "") + " (" + plural(draft.fields.length, "field") + "). " + plural(d ? d.left : 0, "draft") + " left.");
    }
    var fields = await readFields(MAX_VALUE);
    var m = restorePlan(fields, draft, { overwrite: a.overwrite === true });
    var results = await A.fillPlan(m.plan);
    return text(formatRestore(key, draft, m, results));
  });

  // ── The 📝 Drafts tab ───────────────────────────────────────────────────

  var CHECK_PROMPT = "Read the form on this page with browser_form_read and tell me what is empty, required or invalid — what I should fix before I submit. Don't submit anything.";
  var DRAFT_PROMPT = "Save a draft of the form on this page with browser_form_draft_save (it never keeps passwords or card numbers) and tell me which fields were kept and which were skipped. browser_form_draft_restore brings it back later.";

  function outText(out) { return (out || []).filter(function (p) { return p.type === "text"; }).map(function (p) { return p.text; }).join("\n"); }

  async function saveFromPanel(ctx) {
    ctx.status("Saving a draft of this page…");
    try {
      var report = outText(await T.run("browser_form_draft_save", {}));
      ctx.status("✓ " + report.split("\n")[0], "good");
      ctx.rerender();
    } catch (e) { ctx.status("⚠ " + ((e && e.message) || e), "bad"); }
  }

  async function restoreFromPanel(ctx, key) {
    ctx.status("Restoring the draft of " + key + "…");
    try {
      var report = outText(await T.run("browser_form_draft_restore", { url: key }));
      ctx.status("✓ " + report.split("\n")[0].replace(/:$/, "") + " — nothing was submitted.", "good");
    } catch (e) { ctx.status("⚠ " + ((e && e.message) || e), "bad"); }
  }

  async function render(content, ctx) {
    var el = ctx.el;
    var drafts = await loadDrafts();
    content.textContent = "";
    content.appendChild(el("div", { className: "cmd-item", onclick: function () { saveFromPanel(ctx); } }, [
      el("span", { className: "cmd-icon" }, ["📝"]),
      el("div", { className: "cmd-body" }, [
        el("div", { className: "cmd-name" }, ["Save a draft of this page"]),
        el("div", { className: "cmd-desc" }, ["Keeps what you typed into the form on the current tab — never passwords or card numbers — so it comes back after a reload or a timeout."]),
      ]),
    ]));
    var keys = Object.keys(drafts).sort(function (a, b) { return (drafts[b].t || 0) - (drafts[a].t || 0); });
    if (!keys.length) {
      content.appendChild(el("div", { className: "cmd-empty" }, ["No drafts yet. Save one while filling a long form — or ask the agent to (browser_form_draft_save); Restore puts the values back into the page's fields."]));
      return;
    }
    keys.forEach(function (k) {
      var d = drafts[k], n = d.fields.length;
      content.appendChild(el("div", { className: "cmd-item" }, [
        el("span", { className: "cmd-icon" }, ["📄"]),
        el("div", { className: "cmd-body" }, [
          el("div", { className: "cmd-name" }, [d.title || k]),
          el("div", { className: "cmd-desc" }, [k]),
          el("div", { className: "cmd-desc" }, [plural(n, "field") + " · " + ctx.ago(d.t)]),
        ]),
        el("div", { className: "prof-actions column" }, [
          el("button", { className: "prof-btn", title: "Fill the form on the current tab from this draft (nothing is submitted)", onclick: function (e) { e.stopPropagation(); restoreFromPanel(ctx, k); } }, ["↩ Restore"]),
          el("button", { className: "prof-btn", title: "Delete", onclick: function (e) {
            e.stopPropagation();
            if (!confirm("Delete the draft of " + (d.title || k) + "?")) return;
            deleteDraft(k).then(function () { ctx.status("Deleted the draft of " + (d.title || k) + ".", "good"); ctx.rerender(); }, function (err) { ctx.status("⚠ " + err.message, "bad"); });
          } }, ["🗑"]),
        ]),
      ]));
    });
  }

  X.tabs.push({ id: "forms", label: "📝 Drafts", storageKeys: [KEY], render: render });
  X.commands.push(
    { group: "Forms", icon: "🔍", name: "Check this form before I submit", prompt: CHECK_PROMPT },
    { group: "Forms", icon: "📝", name: "Save a draft of this form", prompt: DRAFT_PROMPT }
  );

  /** The pure parts and the storage functions, for tests. */
  X.forms = {
    KEY: KEY, MAX: MAX, MAX_VALUE: MAX_VALUE, MAX_OPTIONS: MAX_OPTIONS,
    entriesOf: entriesOf, formSummary: formSummary, formReport: formReport,
    pageKey: pageKey, fieldKey: fieldKey, keyedFields: keyedFields, draftOf: draftOf, restorePlan: restorePlan, trimDrafts: trimDrafts, findDraftKey: findDraftKey,
    formatDrafts: formatDrafts, formatSaved: formatSaved, formatRestore: formatRestore,
    loadDrafts: loadDrafts, deleteDraft: deleteDraft, render: render,
  };
})();
