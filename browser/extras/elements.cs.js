// Content script of the "elements" extra: the build copies it to extras-elements.cs.js in builds of brands that
// have the feature, and the feature's panel module (browser/extras/elements.js) registers it with
// chrome.scripting.registerContentScripts (id "extras-elements", http/https pages, document_start,
// persistAcrossSessions) so the edits saved for a site come back on every load, panel open or not.
// Classic script, ISOLATED world: chrome.storage.local and the DOM only, nothing from the panel.
//
// One registration at document_start, branching on document.readyState: the hides go in at once as a
// <style data-agent-hide> (selector { display: none !important }) so a hidden element never flashes;
// insertions, moves and edits need the DOM and wait for DOMContentLoaded. Storage changes are followed live.
// Everything is idempotent — an element is never added twice (its data-agent-element id is looked up),
// an edit applied twice changes nothing — because the panel runs the same code right after it saves.
//
// The panel reuses this logic instead of carrying a copy: it injects this file into a page that was open
// before the registration (chrome.scripting.executeScript with files) and calls window.__agentElementsCS
// .sync(edits) from the same isolated world. `edits` is the host's whole list: enabled records are
// applied, disabled ones reverted (edits carry the values they replaced in `before`).
(function () {
  if (window.__agentElementsCS) return; // registered at document_start and injected again by the panel: one instance per document
  if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return;
  var KEY = "agentPageEdits";
  var host = location.hostname.replace(/^www\./, "").toLowerCase();
  var current = []; // this host's edits as last given to sync()
  var domReady = document.readyState !== "loading";
  var retries = null;

  function qs(sel, root) { try { return (root || document).querySelector(sel); } catch (_) { return null; } }
  function qsa(sel, root) { try { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); } catch (_) { return []; } }
  function headOrRoot() { return document.head || document.documentElement; }
  function remove(el) { if (el && el.parentNode) el.parentNode.removeChild(el); }
  function on(e) { return e && e.enabled !== false; }

  // ── Hides: one style element, rebuilt from the enabled hides (one rule each, so a bad selector only loses its own rule) ──
  function applyHides(edits) {
    var rules = edits.filter(function (e) { return e.kind === "hide" && on(e) && e.selector; }).map(function (e) { return e.selector + " { display: none !important; }"; });
    var s = qs("style[data-agent-hide]");
    if (!rules.length) { remove(s); return 0; }
    if (!s) { s = document.createElement("style"); s.setAttribute("data-agent-hide", ""); headOrRoot().appendChild(s); }
    var txt = rules.join("\n");
    if (s.textContent !== txt) s.textContent = txt;
    return rules.length;
  }

  // ── Insertions ──
  // The fragment was sanitised in the panel when it was saved; this re-check after parsing costs nothing
  // and also covers a storage entry written by something else.
  function scrub(root) {
    qsa("script,style,iframe,frame,frameset,object,embed,link,meta,base,template,noscript", root).forEach(remove);
    qsa("*", root).forEach(function (el) {
      var attrs = Array.prototype.slice.call(el.attributes);
      for (var k = 0; k < attrs.length; k++) {
        var n = attrs[k].name.toLowerCase(), v = String(attrs[k].value).replace(/[\u0000- \u007f-\u009f]+/g, "").toLowerCase();
        if (n.indexOf("on") === 0 || n === "srcdoc" || n === "formaction" || n === "action" || /^(javascript|vbscript|data:text):?/.test(v)) el.removeAttribute(attrs[k].name);
      }
    });
  }
  function fixedStyle(corner) {
    var base = "position:fixed;z-index:2147483000;box-sizing:border-box;margin:0;";
    var card = "max-width:min(360px,calc(100vw - 32px));";
    switch (corner) {
      case "bottom": return base + "left:0;right:0;bottom:0;";
      case "top-left": return base + card + "left:16px;top:16px;";
      case "top-right": return base + card + "right:16px;top:16px;";
      case "bottom-left": return base + card + "left:16px;bottom:16px;";
      case "bottom-right": return base + card + "right:16px;bottom:16px;";
      default: return base + "left:0;right:0;top:0;";
    }
  }
  function ensureCss(e) {
    var s = qs('style[data-agent-css="' + e.id + '"]');
    if (!e.css) { remove(s); return; }
    if (!s) { s = document.createElement("style"); s.setAttribute("data-agent-css", e.id); headOrRoot().appendChild(s); }
    if (s.textContent !== e.css) s.textContent = e.css;
  }
  function insert(e, rep) {
    var anchor = e.position === "fixed" ? document.body : qs(e.selector);
    if (!anchor) { rep.missingAnchor.push(e.id); return; }
    var tpl = document.createElement("template");
    tpl.innerHTML = e.html || "";
    scrub(tpl.content);
    var nodes = Array.prototype.slice.call(tpl.content.childNodes);
    var els = nodes.filter(function (n) { return n.nodeType === 1; });
    var loose = nodes.some(function (n) { return n.nodeType === 3 && /\S/.test(n.nodeValue || ""); });
    var node;
    if (e.position === "fixed" || els.length !== 1 || loose) {
      // Several top-level nodes (or a fixed overlay) get a wrapper; a single element is the element itself.
      node = document.createElement("div");
      nodes.forEach(function (n) { node.appendChild(n); });
      if (e.position === "fixed") node.setAttribute("style", fixedStyle(e.corner));
    } else {
      node = els[0];
    }
    node.setAttribute("data-agent-element", e.id);
    var where = e.position === "before" ? "beforebegin" : e.position === "prepend" ? "afterbegin" : e.position === "append" || e.position === "fixed" ? "beforeend" : "afterend";
    anchor.insertAdjacentElement(where, node);
    ensureCss(e);
    rep.added.push(e.id);
  }

  // ── Edits: applied to the element the durable selector finds; the ids applied are kept on it so a disabled edit can be reverted ──
  function marks(el) { return (el.getAttribute("data-agent-edit") || "").split(/\s+/).filter(Boolean); }
  function setMarks(el, list) { if (list.length) el.setAttribute("data-agent-edit", list.join(" ")); else el.removeAttribute("data-agent-edit"); }
  function hasMark(el, id) { return marks(el).indexOf(id) !== -1; }
  function classes(s) { return String(s || "").split(/\s+/).filter(Boolean); }
  // "color: red; font-size: 12px !important" → [[prop, value, priority]]; splits on ; outside quotes and parentheses.
  function decls(text) {
    var out = [], cur = "", depth = 0, quote = "";
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (quote) { cur += ch; if (ch === quote) quote = ""; continue; }
      if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
      if (ch === "(") depth++;
      if (ch === ")") depth = Math.max(0, depth - 1);
      if (ch === ";" && !depth) { out.push(cur); cur = ""; continue; }
      cur += ch;
    }
    out.push(cur);
    return out.map(function (d) {
      var m = /^\s*(-?[a-zA-Z][\w-]*)\s*:\s*([\s\S]*?)\s*(!important)?\s*$/.exec(d);
      return m && m[2] ? [m[1], m[2], m[3] ? "important" : ""] : null;
    }).filter(Boolean);
  }
  function setAttr(el, k, v) {
    if (k === "value" && "value" in el) el.value = v;
    el.setAttribute(k, v);
  }
  function applyEdit(el, e) {
    if (typeof e.text === "string" && el.textContent !== e.text) el.textContent = e.text;
    var at = e.attrs || {};
    Object.keys(at).forEach(function (k) {
      var v = String(at[k]);
      if (k === "addClass") classes(v).forEach(function (c) { el.classList.add(c); });
      else if (k === "removeClass") classes(v).forEach(function (c) { el.classList.remove(c); });
      else if (/^(href|src|alt|title|placeholder|value)$/.test(k)) setAttr(el, k, v);
    });
    if (e.style) decls(String(e.style)).forEach(function (d) { el.style.setProperty(d[0], d[1], d[2]); });
    if (!hasMark(el, e.id)) setMarks(el, marks(el).concat([e.id]));
  }
  function revertEdit(el, e) {
    var b = e.before || {};
    if (typeof e.text === "string" && typeof b.text === "string") el.textContent = b.text;
    var at = e.attrs || {};
    Object.keys(at).forEach(function (k) {
      if (k === "addClass") classes(at[k]).forEach(function (c) { el.classList.remove(c); });
      else if (k === "removeClass") classes(at[k]).forEach(function (c) { el.classList.add(c); });
      else if (b.attrs && k in b.attrs) {
        if (b.attrs[k] === null) { el.removeAttribute(k); if (k === "value" && "value" in el) el.value = ""; }
        else setAttr(el, k, b.attrs[k]);
      }
    });
    if (e.style && typeof b.style === "string") { if (b.style) el.setAttribute("style", b.style); else el.removeAttribute("style"); }
    setMarks(el, marks(el).filter(function (id) { return id !== e.id; }));
  }

  // ── Everything that needs the DOM: markers of removed hides, insertions, edits ──
  function applyDom(edits) {
    var rep = { hidden: 0, marked: 0, added: [], present: [], missingAnchor: [], removed: [], edited: [], missing: [], reverted: [], moved: [], unmoved: [], missingMove: [], missingTarget: [], stuck: [] };
    var enabled = {}, byId = {};
    edits.forEach(function (e) { byId[e.id] = e; if (on(e)) enabled[e.id] = e; });
    // mode=remove hides: hidden + aria-hidden on the matched elements, marked with the hide's id; unmarked when the hide is off or gone.
    qsa("[data-agent-hidden]").forEach(function (el) {
      var e = enabled[el.getAttribute("data-agent-hidden")];
      if (!e || e.kind !== "hide" || e.mode !== "remove") { el.removeAttribute("hidden"); el.removeAttribute("aria-hidden"); el.removeAttribute("data-agent-hidden"); }
    });
    edits.forEach(function (e) {
      if (e.kind !== "hide" || !on(e) || e.mode !== "remove") return;
      qsa(e.selector).forEach(function (el) {
        if (el.getAttribute("data-agent-hidden") === e.id) return;
        el.setAttribute("hidden", ""); el.setAttribute("aria-hidden", "true"); el.setAttribute("data-agent-hidden", e.id);
        rep.marked++;
      });
    });
    // Insertions that are off or forgotten go, with their style; the others are added once.
    qsa("[data-agent-element]").forEach(function (el) {
      var id = el.getAttribute("data-agent-element");
      var e = enabled[id];
      if (!e || e.kind !== "add") { remove(el); remove(qs('style[data-agent-css="' + id + '"]')); rep.removed.push(id); }
    });
    edits.forEach(function (e) {
      if (e.kind !== "add" || !on(e)) return;
      if (qs('[data-agent-element="' + e.id + '"]')) { rep.present.push(e.id); ensureCss(e); return; }
      insert(e, rep);
    });
    // Moves: a move that is off or forgotten puts its element back where it was — `from` names the parent and the next
    // sibling as they select with the element taken out, so it is taken out first (stuck: no place to go back to; a
    // reload does it). An enabled move moves the element once; the move's id on it says it is in place.
    qsa("[data-agent-moved]").forEach(function (el) {
      var id = el.getAttribute("data-agent-moved");
      var e = byId[id];
      if (e && e.kind === "move" && on(e)) return;
      el.removeAttribute("data-agent-moved");
      if (!e || !e.from || !e.from.parentSelector) { rep.stuck.push(id); return; }
      var was = { parent: el.parentNode, next: el.nextSibling };
      remove(el);
      var parent = qs(e.from.parentSelector), next = e.from.nextSelector ? qs(e.from.nextSelector) : null;
      if (parent) { parent.insertBefore(el, next && next.parentNode === parent ? next : null); rep.unmoved.push(id); }
      else { was.parent.insertBefore(el, was.next); rep.stuck.push(id); }
    });
    edits.forEach(function (e) {
      if (e.kind !== "move" || !on(e)) return;
      if (qs('[data-agent-moved="' + e.id + '"]')) { rep.moved.push(e.id); return; }
      var el = qs(e.selector);
      if (!el) { rep.missingMove.push(e.id); return; }
      var target = qs(e.targetSelector);
      if (!target || target === el || el.contains(target)) { rep.missingTarget.push(e.id); return; }
      if (e.position === "before") target.parentNode.insertBefore(el, target);
      else if (e.position === "prepend") target.insertBefore(el, target.firstChild);
      else if (e.position === "append") target.appendChild(el);
      else target.parentNode.insertBefore(el, target.nextSibling);
      el.setAttribute("data-agent-moved", e.id);
      rep.moved.push(e.id);
    });
    edits.forEach(function (e) {
      if (e.kind !== "edit") return;
      var el = qs(e.selector);
      if (!on(e)) { if (el && hasMark(el, e.id)) { revertEdit(el, e); rep.reverted.push(e.id); } return; }
      if (!el) { rep.missing.push(e.id); return; }
      applyEdit(el, e);
      rep.edited.push(e.id);
    });
    return rep;
  }

  // Pages that render late (frameworks, lazy sections): a few timed retries for targets not found yet.
  function scheduleRetries() {
    if (retries) return;
    var delays = [600, 2000, 5000];
    retries = [];
    delays.forEach(function (ms) { retries.push(setTimeout(function () { if (current.length) applyDom(current); }, ms)); });
  }

  /** Bring the page in line with `edits` (this host's list, enabled and disabled). → report, or { deferred: true } while the DOM loads. */
  function sync(edits) {
    current = Array.isArray(edits) ? edits : [];
    var hidden = applyHides(current);
    if (!domReady) return { deferred: true, hidden: hidden };
    var rep = applyDom(current);
    rep.hidden = hidden;
    if (rep.missingAnchor.length || rep.missing.length || rep.missingMove.length || rep.missingTarget.length) scheduleRetries();
    return rep;
  }
  function forHost(all) { var list = all && all[host]; return Array.isArray(list) ? list : []; }

  if (!domReady) {
    document.addEventListener("DOMContentLoaded", function () { domReady = true; sync(current); }, { once: true });
  }
  chrome.storage.onChanged.addListener(function (ch, area) {
    if (area === "local" && ch[KEY]) sync(forHost(ch[KEY].newValue));
  });
  chrome.storage.local.get(KEY, function (st) { sync(forHost(st && st[KEY])); });

  window.__agentElementsCS = { sync: sync, host: host, version: 1 };
})();
