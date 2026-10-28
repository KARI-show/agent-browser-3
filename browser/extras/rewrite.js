// Extra feature "rewrite" (side panel): selection editing. The agent reads what the user selected on
// the page (browser_selection_get) and puts a rewritten version back into the same field
// (browser_selection_replace); browser_selection_stats counts words, sentences and readability of the
// selection, a field or the page, and browser_selection_replace_all is find & replace inside a field.
// Built into extras.js only for brands that switch the feature on; the tools are declared in
// browser/host/extras/rewrite.ts. Also adds the ✍️ Rewrite tab of the 🧩 panel
// and the "Writing" quick commands (automations.js and commands.js pick them up from AgentExtras).
//
// Page-side functions are injected with chrome.scripting.executeScript, so each is self-contained
// (no closures over this file — the small helpers are repeated on purpose). The tab's DOM is built
// with ctx.el, never innerHTML: selected text comes from web pages and is untrusted.
(function () {
  if (!globalThis.AGENT_BRAND || !globalThis.AGENT_BRAND.has("rewrite")) return;
  var T = globalThis.AgentBrowserTools;
  var H = T.helpers;
  var text = H.text;
  var MAX_REPORT = 20000; // characters of a selection the model gets in one report
  var MAX_STATS = 400000; // characters of page text browser_selection_stats measures (scope page)

  // ── Page side ────────────────────────────────────────────────────────────

  // What is selected in the top frame and where it sits. Text fields report their own selection
  // (selectionStart/End); rich-text editors and plain content go through window.getSelection().
  function pageSelectionGet() {
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
    var out = { selected: false, editable: false, text: "", length: 0 };
    var active = deepActive();
    if (active && isField(active)) {
      var start = active.selectionStart, end = active.selectionEnd, value = active.value || "";
      out.editable = true; out.kind = kindOf(active); out.label = labelOf(active); out.fieldLength = value.length; out.password = active.type === "password";
      if (start !== null && end !== null && end > start) { out.selected = true; out.start = start; out.end = end; out.length = end - start; out.text = out.password ? "" : value.slice(start, end); }
      else { out.wholeField = true; out.length = value.length; out.text = out.password ? "" : value; }
      return out;
    }
    var sel = window.getSelection();
    var str = sel && sel.rangeCount ? sel.toString() : "";
    var node = str ? sel.getRangeAt(0).commonAncestorContainer : null;
    var elx = node ? (node.nodeType === 1 ? node : node.parentElement) : null;
    var host = active && active.isContentEditable ? editingHost(active) : null;
    if (!host && elx && elx.closest) { var ed = elx.closest("[contenteditable]"); if (ed && ed.isContentEditable) { host = editingHost(ed); out.unfocused = true; } }
    if (host) {
      var whole = host.innerText || host.textContent || "";
      out.editable = true; out.kind = "editable"; out.label = labelOf(host); out.fieldLength = whole.length;
      if (str && host.contains(node)) { out.selected = true; out.text = str; out.length = str.length; }
      else { out.wholeField = true; out.text = whole; out.length = whole.length; delete out.unfocused; }
      return out;
    }
    if (str) {
      out.selected = true; out.text = str; out.length = str.length;
      var block = elx && elx.closest ? elx.closest("p, li, h1, h2, h3, h4, h5, h6, td, th, blockquote, pre, dd, figcaption, article, section, main, div") : null;
      out.where = block ? block.tagName.toLowerCase() : "";
    }
    return out;
  }

  // Replace the selection inside the focused text field or rich-text editor with newText; with
  // wholeField and nothing selected, replace the whole value. Reads the field back after a beat.
  function pageSelectionReplace(newText, wholeField) {
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
    function fire(el, inputType, data) {
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: inputType, data: data }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
    function later(info, read) {
      return new Promise(function (resolve) { setTimeout(function () { read(info); resolve(info); }, 120); });
    }
    var active = deepActive();
    var sel = window.getSelection();
    var str = sel && sel.rangeCount ? sel.toString() : "";
    if (active && isField(active)) {
      if (active instanceof HTMLInputElement) newText = newText.replace(/\r?\n+/g, " "); // a single-line field
      var start = active.selectionStart, end = active.selectionEnd;
      var had = start !== null && end !== null && end > start;
      if (!had) {
        if (!wholeField) return { error: "Nothing is selected inside the focused " + kindOf(active) + " — pass wholeField=true to replace its whole value, or ask the user to select the part to rewrite." };
        start = 0; end = (active.value || "").length;
      }
      var before = active.value || "";
      var expected = before.slice(0, start) + newText + before.slice(end);
      try { active.setRangeText(newText, start, end, "select"); } catch (_) {
        // Inputs without a selection API (number, email): the prototype setter, which React's value tracking sees.
        var proto = active instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, "value").set.call(active, expected);
      }
      fire(active, "insertReplacementText", newText);
      return later({ ok: true, kind: kindOf(active), label: labelOf(active), replaced: end - start, wholeField: !had }, function (info) {
        var now = active.value || "";
        info.verified = now === expected || now.indexOf(newText) !== -1;
        info.now = now.slice(0, 200); info.fieldLength = now.length;
      });
    }
    var node = str ? sel.getRangeAt(0).commonAncestorContainer : null;
    var host = active && active.isContentEditable ? editingHost(active) : null;
    if (!host && node) { var elx = node.nodeType === 1 ? node : node.parentElement; var ed = elx && elx.closest ? elx.closest("[contenteditable]") : null; if (ed && ed.isContentEditable) host = editingHost(ed); }
    if (host) {
      var inside = !!(str && host.contains(node));
      if (!inside) {
        if (!wholeField) return { error: "Nothing is selected inside the focused editor — pass wholeField=true to replace its whole content, or ask the user to select the part to rewrite." };
        var all = document.createRange(); all.selectNodeContents(host); sel.removeAllRanges(); sel.addRange(all);
      }
      var saved = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
      if (active !== host) { host.focus(); if (saved) { sel.removeAllRanges(); sel.addRange(saved); } }
      var wholeBefore = host.innerText || host.textContent || "";
      var done = false;
      try { done = document.execCommand("insertText", false, newText); } catch (_) {}
      if (!done) {
        var r = sel.getRangeAt(0);
        r.deleteContents();
        var tn = document.createTextNode(newText);
        r.insertNode(tn);
        r.selectNodeContents(tn);
        fire(host, "insertReplacementText", newText);
      }
      return later({ ok: true, kind: "editable", label: labelOf(host), replaced: inside ? str.length : wholeBefore.length, wholeField: !inside }, function (info) {
        var now = host.innerText || host.textContent || "";
        var norm = function (s) { return s.replace(/\s+/g, " ").trim(); };
        info.verified = norm(now).indexOf(norm(newText).slice(0, 60)) !== -1;
        info.now = now.slice(0, 200); info.fieldLength = now.length;
      });
    }
    if (str) return { error: "The selection is in the page's content, not in an editable field, so it cannot be replaced there. Show the rewritten text in the chat instead." };
    return { error: "Nothing is selected and no text field has focus on the page. Ask the user to select the text (or click into the field), then call browser_selection_get again." };
  }

  // The whole text of the focused text field or rich-text editor (scope "field" of
  // browser_selection_stats). A selection inside an unfocused editor counts as that editor.
  function pageFieldText() {
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
    var active = deepActive();
    if (active && isField(active)) {
      if (active.type === "password") return { error: "The focused field is a password field — its text is never read." };
      return { ok: true, kind: kindOf(active), label: labelOf(active), text: active.value || "" };
    }
    var host = active && active.isContentEditable ? editingHost(active) : null;
    if (!host) {
      var sel = window.getSelection();
      var node = sel && sel.rangeCount ? sel.getRangeAt(0).commonAncestorContainer : null;
      var elx = node ? (node.nodeType === 1 ? node : node.parentElement) : null;
      var ed = elx && elx.closest ? elx.closest("[contenteditable]") : null;
      if (ed && ed.isContentEditable) host = editingHost(ed);
    }
    if (host) return { ok: true, kind: "editable", label: labelOf(host), text: host.innerText || host.textContent || "" };
    return { error: "No text field or editor has focus on the page — ask the user to click into the field, or measure the selection (scope 'selection') or the page (scope 'page')." };
  }

  // The page's visible body text, cut to max characters (scope "page" of browser_selection_stats).
  function pageBodyText(max) {
    var t = (document.body && document.body.innerText) || "";
    return { ok: true, text: t.slice(0, max), cut: t.length > max, title: String(document.title || "").slice(0, 120) };
  }

  // Find & replace inside the focused text field or rich-text editor; with selectionOnly, only inside
  // the selected part. The pattern arrives compiled-ready (source, flags, literal) from the panel, which
  // validated it. A text field gets its value rewritten in one go; an editor is walked text node by text
  // node and each node's data is replaced, so the markup around the matches stays as it is.
  function pageReplaceAll(source, flags, replacement, literal, selectionOnly) {
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
    function fire(el) {
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertReplacementText", data: replacement }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
    function later(info, read) {
      return new Promise(function (resolve) { setTimeout(function () { read(info); resolve(info); }, 120); });
    }
    var re = new RegExp(source, flags), one = new RegExp(source, flags.replace("g", ""));
    function swap(s) { return literal ? s.replace(re, function () { return replacement; }) : s.replace(re, replacement); }
    function countIn(s) {
      re.lastIndex = 0;
      var n = 0, m;
      while ((m = re.exec(s)) !== null) { n++; if (!m[0]) re.lastIndex++; }
      return n;
    }
    function snippetIn(s) {
      re.lastIndex = 0;
      var m = re.exec(s);
      if (!m) return "";
      var end = m.index + m[0].length;
      return (m.index > 30 ? "…" : "") + s.slice(Math.max(0, m.index - 30), m.index) + "[" + m[0] + " → " + (literal ? replacement : m[0].replace(one, replacement)) + "]" + s.slice(end, end + 30) + (end + 30 < s.length ? "…" : "");
    }
    var active = deepActive();
    if (active && isField(active)) {
      if (active.type === "password") return { error: "The focused field is a password field — it is never edited." };
      var value = active.value || "";
      var start = 0, end = value.length;
      if (selectionOnly) {
        if (active.selectionStart === null || active.selectionEnd === active.selectionStart) return { error: "Nothing is selected inside the focused " + kindOf(active) + " — ask the user to select the part to change, or use scope 'field' for the whole value." };
        start = active.selectionStart; end = active.selectionEnd;
      }
      var part = value.slice(start, end);
      var info = { ok: true, kind: kindOf(active), label: labelOf(active), count: countIn(part), first: snippetIn(part) };
      if (!info.count) return info;
      var neu = swap(part);
      if (active instanceof HTMLInputElement) neu = neu.replace(/\r?\n+/g, " "); // a single-line field
      var expected = value.slice(0, start) + neu + value.slice(end);
      try { active.setRangeText(neu, start, end, selectionOnly ? "select" : "preserve"); } catch (_) {
        var proto = active instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, "value").set.call(active, expected);
      }
      fire(active);
      return later(info, function (i) { i.verified = (active.value || "") === expected; });
    }
    var sel = window.getSelection();
    var range = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
    var host = active && active.isContentEditable ? editingHost(active) : null;
    if (!host && range) {
      var node = range.commonAncestorContainer;
      var elx = node.nodeType === 1 ? node : node.parentElement;
      var ed = elx && elx.closest ? elx.closest("[contenteditable]") : null;
      if (ed && ed.isContentEditable) host = editingHost(ed);
    }
    if (!host) return { error: "No text field or editor has focus on the page — ask the user to click into the field first." };
    if (selectionOnly && (!range || range.collapsed || !host.contains(range.commonAncestorContainer))) return { error: "Nothing is selected inside the focused editor — ask the user to select the part to change, or use scope 'field' for the whole content." };
    var walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    var changed = [], total = 0, first = "", tn;
    while ((tn = walker.nextNode())) {
      if (selectionOnly && !range.intersectsNode(tn)) continue;
      var data = tn.data, from = 0, to = data.length;
      if (selectionOnly) {
        if (tn === range.startContainer) from = range.startOffset;
        if (tn === range.endContainer) to = range.endOffset;
      }
      var piece = data.slice(from, to);
      var c = countIn(piece);
      if (!c) continue;
      if (!first) first = snippetIn(piece);
      total += c;
      changed.push({ node: tn, data: data.slice(0, from) + swap(piece) + data.slice(to) });
    }
    var out = { ok: true, kind: "editable", label: labelOf(host), count: total, first: first };
    if (!total) return out;
    changed.forEach(function (x) { x.node.data = x.data; });
    fire(host);
    // An editor that owns its model (Draft.js, ProseMirror…) may re-render from it and undo the change.
    return later(out, function (i) { i.verified = changed.every(function (x) { return x.node.isConnected && x.node.data === x.data; }); });
  }

  // ── Words for the model and the panel (pure) ─────────────────────────────

  function short(s) { s = String(s == null ? "" : s).replace(/\s+/g, " ").trim(); return s.length > 80 ? s.slice(0, 77) + "…" : s; }

  /** 'textarea "Message"', 'text input "Subject"', 'rich-text editor "Body"'. */
  function fieldWords(r) {
    var k = r.kind === "editable" ? "rich-text editor" : r.kind === "textarea" ? "textarea" : r.kind ? r.kind.replace(/^input:/, "") + " input" : "field";
    return k + (r.label ? ' "' + r.label + '"' : "");
  }

  /** The browser_selection_get report for a page result. */
  function formatSelection(r) {
    r = r || {};
    if (!r.selected && !r.wholeField) return "Nothing is selected on the page and no text field has focus. Ask the user to select the text to rewrite (or to click into the field), then call browser_selection_get again.";
    var body = r.password ? "(hidden — a password field)" : r.text.length > MAX_REPORT ? r.text.slice(0, MAX_REPORT) + "\n… (" + (r.text.length - MAX_REPORT) + " more characters not shown)" : r.text;
    var head;
    if (r.wholeField) head = "Nothing is selected, but the " + fieldWords(r) + " has focus — its whole value (" + r.length + " chars; wholeField: true, editable: true). Replace it only if the user wants the whole text rewritten (browser_selection_replace with wholeField=true):";
    else if (r.editable) head = "Selection (" + r.length + " chars) in the " + fieldWords(r) + (r.unfocused ? ", which is not focused" : "") + " — editable: true, browser_selection_replace can put the new text in its place:";
    else head = "Selection (" + r.length + " chars) in the page content" + (r.where ? " (<" + r.where + ">)" : "") + " — editable: false: it cannot be replaced in place, show the rewritten text in the chat:";
    return head + "\n" + body;
  }

  /** What the ✍️ tab shows about the selection: { title, detail, quote }. */
  function summarizeSelection(r) {
    r = r || {};
    if (!r.selected && !r.wholeField) return { title: "Nothing selected", detail: "Select text on the page — or click into a field — and press Refresh.", quote: "" };
    var quote = r.password ? "(hidden)" : r.text.length > 300 ? r.text.slice(0, 300) + "…" : r.text;
    if (r.wholeField) return { title: "Whole " + fieldWords(r), detail: r.length + " chars, nothing selected inside it — a preset rewrites the whole field.", quote: quote };
    if (r.editable) return { title: "Selection in the " + fieldWords(r), detail: r.length + " chars — the result goes back into the field.", quote: quote };
    return { title: "Selection in the page content", detail: r.length + " chars, not editable — the result is shown in the chat.", quote: quote };
  }

  // ── Statistics and find & replace (pure) ─────────────────────────────────

  var WORD = /[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu;
  function round1(n) { return Math.round(n * 10) / 10; }

  /** Syllables of one word — the usual English heuristic: vowel groups, a silent trailing e dropped. */
  function syllables(word) {
    var w = String(word || "").toLowerCase().replace(/[^a-z]/g, "");
    if (w.length <= 3) return 1;
    w = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").replace(/^y/, "");
    var groups = w.match(/[aeiouy]{1,2}/g);
    return groups ? groups.length : 1;
  }

  /**
   * Words, characters, sentences, paragraphs (blocks separated by line breaks), reading time at 200 wpm
   * and readability of a text. The syllable count behind Flesch is an English heuristic.
   */
  function textStats(input) {
    var t = String(input == null ? "" : input).replace(/\r\n?/g, "\n").trim();
    var words = t.match(WORD) || [];
    var paragraphs = t.split(/\n+/).map(function (p) { return p.trim(); }).filter(function (p) { return (p.match(WORD) || []).length > 0; });
    var sentences = [];
    paragraphs.forEach(function (p) {
      // A sentence ends at . ! ? … (closing quotes allowed) followed by whitespace — "3.5" and "e.g" stay whole.
      p.split(/(?<=[.!?…]["'”’)\]]*)\s+/).forEach(function (sn) {
        var ws = sn.match(WORD);
        if (ws && ws.length) sentences.push({ text: sn.replace(/\s+/g, " ").trim(), words: ws.length });
      });
    });
    var longest = sentences.reduce(function (best, sn) { return !best || sn.words > best.words ? sn : best; }, null);
    var syl = words.reduce(function (n, w) { return n + syllables(w); }, 0);
    var nw = words.length, ns = sentences.length;
    var wps = nw && ns ? nw / ns : 0, spw = nw ? syl / nw : 0;
    var seconds = Math.round((nw / 200) * 60);
    return {
      words: nw,
      characters: t.length,
      charactersNoSpaces: t.replace(/\s/g, "").length,
      sentences: ns,
      paragraphs: paragraphs.length,
      avgWordsPerSentence: round1(wps),
      longest: longest ? { words: longest.words, text: longest.text.length > 60 ? longest.text.slice(0, 60) + "…" : longest.text } : null,
      readingSeconds: seconds,
      readingTime: !nw ? "0 s" : seconds < 60 ? seconds + " s" : round1(seconds / 60) + " min",
      syllables: syl,
      fleschEase: nw ? round1(206.835 - 1.015 * wps - 84.6 * spw) : null,
      fkGrade: nw ? round1(0.39 * wps + 11.8 * spw - 15.59) : null,
    };
  }

  function easeWords(ease) {
    return ease >= 90 ? "very easy" : ease >= 80 ? "easy" : ease >= 70 ? "fairly easy" : ease >= 60 ? "plain English" : ease >= 50 ? "fairly difficult" : ease >= 30 ? "difficult" : "very difficult";
  }

  /** The browser_selection_stats report; `what` names the text ("the selection in the textarea "Message""). */
  function formatStats(st, what) {
    if (!st.words) return "Nothing to count: " + what + " holds no words.";
    return "Statistics of " + what + ":\n" +
      "- words: " + st.words + " · characters: " + st.characters + " (" + st.charactersNoSpaces + " without spaces)\n" +
      "- sentences: " + st.sentences + " · paragraphs: " + st.paragraphs + " · " + st.avgWordsPerSentence + " words per sentence on average\n" +
      "- longest sentence: " + st.longest.words + " words — \"" + st.longest.text + "\"\n" +
      "- reading time: " + st.readingTime + " at 200 wpm\n" +
      "- Flesch reading ease: " + st.fleschEase + " (" + easeWords(st.fleschEase) + ") · Flesch–Kincaid grade: " + st.fkGrade + " — from an English syllable heuristic, rough for other languages";
  }

  /** { source, flags, literal } of a find & replace pattern; a bad regex throws a message the model can act on. */
  function finder(find, opts) {
    opts = opts || {};
    find = String(find == null ? "" : find);
    if (!find) throw new Error("find is required — the text (or, with regex=true, the pattern) to look for.");
    var literal = opts.regex !== true;
    var source = literal ? find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : find;
    var flags = "g" + (opts.caseSensitive === true ? "" : "i");
    var re;
    try { re = new RegExp(source, flags); } catch (e) {
      var why = String((e && e.message) || e).replace(/^Invalid regular expression: \/.*\/[a-z]*: /, "");
      throw new Error("Invalid regular expression /" + find + "/: " + why + " — fix the pattern, or pass regex=false to look for the literal text.");
    }
    if (re.test("")) throw new Error("The pattern /" + find + "/ matches an empty string, so it would put the replacement between every two characters — give it something to match.");
    return { source: source, flags: flags, literal: literal };
  }

  /** Replace every match of find in text → { text, count, first } (first: the first change with some context). */
  function replaceInText(text, find, replace, opts) {
    var f = finder(find, opts);
    text = String(text == null ? "" : text);
    replace = String(replace == null ? "" : replace);
    var re = new RegExp(f.source, f.flags), one = new RegExp(f.source, f.flags.replace("g", ""));
    var m = re.exec(text);
    if (!m) return { text: text, count: 0, first: "" };
    var end = m.index + m[0].length;
    var first = (m.index > 30 ? "…" : "") + text.slice(Math.max(0, m.index - 30), m.index) + "[" + m[0] + " → " + (f.literal ? replace : m[0].replace(one, replace)) + "]" + text.slice(end, end + 30) + (end + 30 < text.length ? "…" : "");
    var count = 0;
    re.lastIndex = 0;
    while (re.exec(text) !== null) count++;
    // Literal mode keeps "$1" in the replacement as it is; regex mode lets it refer to a group.
    var out = f.literal ? text.replace(re, function () { return replace; }) : text.replace(re, replace);
    return { text: out, count: count, first: first };
  }

  // ── Tools ────────────────────────────────────────────────────────────────

  T.register("browser_selection_get", async function () {
    var r = await H.inTop(pageSelectionGet, []);
    return text(formatSelection(r));
  });

  T.register("browser_selection_replace", async function (a) {
    a = a || {};
    if (typeof a.text !== "string" || !a.text.trim()) throw new Error("text is required — the new text that replaces the selection.");
    var r = await H.inTop(pageSelectionReplace, [a.text, a.wholeField === true]);
    if (!r || !r.ok) throw new Error((r && r.error) || "Could not replace the selection.");
    var where = (r.wholeField ? "the whole value of the " : "the selection in the ") + fieldWords(r);
    if (!r.verified) return text("Put the new text into " + where + ", but the field does not show it (it holds: \"" + short(r.now) + "\"). The editor may reject programmatic input — show the rewritten text in the chat so the user can paste it.");
    return text("Replaced " + where + ": " + r.replaced + " → " + a.text.length + " chars; the new text is left selected in the field.");
  });

  T.register("browser_selection_stats", async function (a) {
    var scope = a && (a.scope === "field" || a.scope === "page") ? a.scope : "selection";
    var body, what;
    if (scope === "page") {
      var p = await H.inTop(pageBodyText, [MAX_STATS]);
      body = p.text;
      what = "the page's visible text" + (p.title ? " (" + short(p.title) + ")" : "") + (p.cut ? ", its first " + MAX_STATS + " characters" : "");
    } else if (scope === "field") {
      var f = await H.inTop(pageFieldText, []);
      if (!f || !f.ok) throw new Error((f && f.error) || "Could not read the focused field.");
      body = f.text;
      what = "the whole " + fieldWords(f);
    } else {
      var r = await H.inTop(pageSelectionGet, []);
      r = r || {};
      if (!r.selected && !r.wholeField) throw new Error("Nothing is selected on the page and no text field has focus. Ask the user to select the text (or to click into the field), or pass scope 'page' for the whole page.");
      if (r.password) throw new Error("The focused field is a password field — its text is never read.");
      body = r.text;
      what = r.wholeField ? "the whole " + fieldWords(r) + " (nothing is selected inside it)" : "the selection" + (r.editable ? " in the " + fieldWords(r) : " in the page content");
    }
    return text(formatStats(textStats(body), what));
  });

  T.register("browser_selection_replace_all", async function (a) {
    a = a || {};
    var f = finder(a.find, { regex: a.regex === true, caseSensitive: a.caseSensitive === true }); // throws before anything is injected
    var replacement = String(a.replace == null ? "" : a.replace);
    var selectionOnly = a.scope === "selection";
    var r = await H.inTop(pageReplaceAll, [f.source, f.flags, replacement, f.literal, selectionOnly]);
    if (!r || !r.ok) throw new Error((r && r.error) || "Could not replace inside the field.");
    var what = (f.literal ? '"' + a.find + '"' : "/" + a.find + "/") + (a.caseSensitive === true ? " (case-sensitive)" : "");
    var where = (selectionOnly ? "the selection in the " : "the ") + fieldWords(r);
    if (!r.count) return text("No matches for " + what + " in " + where + " — nothing changed.");
    var out = "Replaced " + r.count + " occurrence" + (r.count === 1 ? "" : "s") + " of " + what + ' with "' + replacement + '" in ' + where + ". First change: " + r.first;
    if (r.verified === false) out += "\nBut the field does not show the change — the editor may reject programmatic edits; show the result in the chat so the user can paste it.";
    return text(out);
  });

  // ── Presets: the ✍️ tab's buttons and the "Writing" quick commands ───────

  var PRESETS = [
    { icon: "🎩", name: "Formal", desc: "A formal, professional tone", ask: "in a formal, professional tone" },
    { icon: "🙂", name: "Friendly", desc: "Warm and conversational", ask: "in a friendly, conversational tone" },
    { icon: "✂️", name: "Shorter", desc: "About half the length, every point kept", ask: "so it is about half as long and keeps every point that matters" },
    { icon: "✅", name: "Fix grammar & spelling", desc: "Corrections only, wording and voice kept", ask: "fixing only grammar, spelling and punctuation — keep the wording and the voice" },
    { icon: "🌐", name: "Translate to English", desc: "Natural English, same register", ask: "translating it into natural English of the same register (the language changes on purpose here)" },
    { icon: "➕", name: "Expand", desc: "More detail and smoother transitions, no new facts", ask: "expanding it with more detail and smoother transitions, without adding facts that are not there" },
  ];
  function presetPrompt(p) {
    return "Rewrite the text I selected on the page " + p.ask + ". Read it with browser_selection_get first; keep its language (unless the task is a translation), meaning and formatting; then put the result back with browser_selection_replace — or, if the selection is not in an editable field, show the rewritten text in the chat.";
  }
  var REPLY_PROMPT = "The text I selected on the page is a message I received: read it with browser_selection_get and draft a reply in the same language, matching its tone and answering every point. Show the draft in the chat (the selection is not a field to replace); if I then ask, put it into the reply box.";

  // ── The ✍️ Rewrite tab ───────────────────────────────────────────────────

  async function render(content, ctx) {
    var el = ctx.el;
    content.textContent = "";
    var title = el("div", { className: "cmd-name" }, ["Current selection"]);
    var detail = el("div", { className: "cmd-desc" }, ["Reading…"]);
    var quote = el("div", { className: "cmd-name note" }, []);
    var refresh = el("button", { className: "prof-btn", title: "Read the selection again" }, ["↻ Refresh"]);
    content.appendChild(el("div", { className: "cmd-item event" }, [
      el("span", { className: "cmd-icon" }, ["✍️"]),
      el("div", { className: "cmd-body wide" }, [title, detail, quote]),
      el("div", { className: "prof-actions column" }, [refresh]),
    ]));
    content.appendChild(el("div", { className: "cmd-group-title" }, ["Rewrite the selection"]));
    PRESETS.forEach(function (p) {
      content.appendChild(el("div", { className: "cmd-item", onclick: function () { ctx.sendPrompt(presetPrompt(p)); } }, [
        el("span", { className: "cmd-icon" }, [p.icon]),
        el("div", { className: "cmd-body" }, [el("div", { className: "cmd-name" }, [p.name]), el("div", { className: "cmd-desc" }, [p.desc])]),
      ]));
    });
    content.appendChild(el("div", { className: "cmd-empty" }, ["The agent reads the selection, rewrites it and puts the result back into the field. Text selected outside a field comes back in the chat."]));
    async function load() {
      detail.textContent = "Reading…";
      quote.textContent = "";
      try {
        var s = summarizeSelection(await H.inTop(pageSelectionGet, []));
        title.textContent = s.title;
        detail.textContent = s.detail;
        quote.textContent = s.quote;
      } catch (e) {
        title.textContent = "Current selection";
        detail.textContent = "⚠ " + ((e && e.message) || e);
      }
    }
    refresh.addEventListener("click", load);
    await load();
  }

  globalThis.AgentExtras.tabs.push({ id: "rewrite", label: "✍️ Rewrite", render: render });
  PRESETS.forEach(function (p) { globalThis.AgentExtras.commands.push({ group: "Writing", icon: p.icon, name: p.name, prompt: presetPrompt(p) }); });
  globalThis.AgentExtras.commands.push({ group: "Writing", icon: "💬", name: "Draft a reply to the selected message", prompt: REPLY_PROMPT });
  globalThis.AgentExtras.commands.push(
    { group: "Writing", icon: "📊", name: "Statistics of the selection",
      prompt: "Report the statistics of the text I selected on the page with browser_selection_stats (scope 'page' when nothing is selected): words, sentences, reading time and readability — and say in one line what stands out." },
    { group: "Writing", icon: "🔁", name: "Find & replace in this field",
      prompt: "In the field I'm in, replace every occurrence (browser_selection_replace_all; tell me how many changed) of: ", partial: true }
  );

  /** The pure parts, for tests and other modules. */
  globalThis.AgentExtras.rewrite = {
    MAX_REPORT: MAX_REPORT,
    PRESETS: PRESETS,
    presetPrompt: presetPrompt,
    fieldWords: fieldWords,
    formatSelection: formatSelection,
    summarizeSelection: summarizeSelection,
    pageSelectionGet: pageSelectionGet,
    pageSelectionReplace: pageSelectionReplace,
    MAX_STATS: MAX_STATS,
    syllables: syllables,
    textStats: textStats,
    formatStats: formatStats,
    finder: finder,
    replaceInText: replaceInText,
    pageFieldText: pageFieldText,
    pageBodyText: pageBodyText,
    pageReplaceAll: pageReplaceAll,
  };
})();
