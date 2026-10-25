// Extra feature "styles" (side panel): site styles — CSS overrides the agent writes with the user and
// the site keeps. Saved in chrome.storage.local under one key, agentSiteStyles = { host: { name: { css,
// enabled, t } } } ("*" = every site), capped at 200 KB; the content script (browser/extras/styles.cs.js,
// registered here with chrome.scripting.registerContentScripts) injects a site's enabled overrides as
// the last <style data-agent-styles> in <head> on every load, panel open or not, and follows storage
// changes live. Built into extras.js only for brands that switch the feature on; the tools are declared
// in browser/host/extras/styles.ts. Also adds the 🎨 Styles tab of the 🧩 panel and the "Design" quick
// commands (automations.js and commands.js pick them up from AgentExtras). The palette extra builds
// its themes on the storage helpers exposed at AgentExtras.styles.
//
// Page-side functions are injected with chrome.scripting.executeScript, so each is self-contained (no
// closures over this file). The tab's DOM is built with ctx.el, never innerHTML: names and CSS are data.
(function () {
  if (!globalThis.AGENT_BRAND || !globalThis.AGENT_BRAND.has("styles")) return;
  var T = globalThis.AgentBrowserTools;
  var H = T.helpers;
  var text = H.text;
  var KEY = "agentSiteStyles";
  var ATTR = "data-agent-styles";
  var PREVIEW_ATTR = "data-agent-styles-preview"; // an unsaved preview (the palette's theme preview) lives in its own element
  var CS_ID = "extras-styles";
  var CS_FILE = "extras-styles.cs.js";
  var MAX_CSS = 20000; // characters per override
  var MAX_TOTAL = 200 * 1024; // characters of the whole store (JSON)
  var MAX_NAME = 60;
  var STALE = "That element is gone — the page changed. Call browser_read_page again.";

  // ── Pure helpers ─────────────────────────────────────────────────────────

  /** "www.Example.com." → "example.com"; "*" stays; anything else lower-cased and trimmed. */
  function normHost(h) {
    h = String(h == null ? "" : h).trim().toLowerCase().replace(/\.$/, "");
    if (h === "*") return h;
    return h.replace(/^www\./, "");
  }
  /** The normalised host of an http(s) URL, "" for anything else. */
  function hostOf(url) {
    try {
      var u = new URL(String(url || ""));
      return /^https?:$/.test(u.protocol) ? normHost(u.hostname) : "";
    } catch (_) { return ""; }
  }
  function siteWords(site) { return site === "*" ? "every site" : site; }
  function short(s, n) { s = String(s == null ? "" : s).replace(/\s+/g, " ").trim(); n = n || 80; return s.length > n ? s.slice(0, n - 1) + "…" : s; }
  function cleanName(name) { return String(name == null ? "" : name).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_NAME); }
  function kb(n) { return n < 1024 ? n + " B" : (n / 1024).toFixed(n < 10240 ? 1 : 0) + " KB"; }
  function agoWords(ts) {
    if (!ts) return "";
    var d = Date.now() - ts;
    if (d < 60000) return "just now";
    if (d < 3600000) return Math.floor(d / 60000) + " min ago";
    if (d < 86400000) return Math.floor(d / 3600000) + " h ago";
    return Math.floor(d / 86400000) + " d ago";
  }
  /** "rgb(17, 34, 51)" / "rgba(…, 1)" → "#112233" ("" when it isn't an opaque rgb colour). */
  function rgbHex(s) {
    var m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(String(s || "").trim());
    if (!m) return "";
    if (m[4] !== undefined && parseFloat(m[4]) < 1) return parseFloat(m[4]) === 0 ? "transparent" : "";
    return "#" + [m[1], m[2], m[3]].map(function (v) { var h = Math.min(255, +v).toString(16); return h.length < 2 ? "0" + h : h; }).join("");
  }
  function colourWords(s) { var h = rgbHex(s); return h && h !== s ? s + " (" + h + ")" : s; }

  /** The site's group in the store, by normalised host (tolerant of keys saved another way). */
  function siteGroup(all, site) {
    if (!all || typeof all !== "object") return null;
    if (all[site] && typeof all[site] === "object") return all[site];
    var keys = Object.keys(all);
    for (var i = 0; i < keys.length; i++) if (normHost(keys[i]) === site && all[keys[i]] && typeof all[keys[i]] === "object") return all[keys[i]];
    return null;
  }
  /** The stored key of `name` in a site's group: exact, else case-insensitive; null when there is none. */
  function nameKey(group, name) {
    if (!group) return null;
    if (Object.prototype.hasOwnProperty.call(group, name)) return name;
    var q = String(name).toLowerCase();
    var keys = Object.keys(group).filter(function (k) { return k.toLowerCase() === q; });
    return keys.length ? keys[0] : null;
  }
  /** The sites a page on `host` gets its overrides from, in cascade order: every site first, then the host. */
  function sitesFor(host) { host = normHost(host); return host && host !== "*" ? ["*", host] : ["*"]; }
  /** The CSS text to inject for a page on `host` — the same concatenation the content script does. */
  function cssFor(all, host) {
    var parts = [];
    sitesFor(host).forEach(function (site) {
      var group = siteGroup(all, site);
      if (!group) return;
      Object.keys(group).sort().forEach(function (name) {
        var o = group[name];
        if (!o || o.enabled === false || typeof o.css !== "string" || !o.css.trim()) return;
        parts.push("/* " + siteWords(site) + " · " + name.replace(/\*\//g, "* /") + " */\n" + o.css.trim());
      });
    });
    return parts.join("\n\n");
  }
  /** The overrides that apply to a page on `host`: [{ site, name, css, enabled, t }], cascade order. */
  function applicable(all, host) {
    var out = [];
    sitesFor(host).forEach(function (site) {
      var group = siteGroup(all, site);
      if (!group) return;
      Object.keys(group).sort().forEach(function (name) { var o = group[name] || {}; out.push({ site: site, name: name, css: String(o.css || ""), enabled: o.enabled !== false, t: o.t || 0 }); });
    });
    return out;
  }
  function sizeOf(all) { try { return JSON.stringify(all || {}).length; } catch (_) { return 0; } }
  function countOf(all) { var n = 0; Object.keys(all || {}).forEach(function (h) { n += Object.keys(all[h] || {}).length; }); return n; }

  // ── CSS validation ───────────────────────────────────────────────────────

  /** Top-level rules of a stylesheet text (comments stripped), or { error } for unbalanced braces / stray text. */
  function splitRules(css) {
    var s = String(css == null ? "" : css).replace(/\/\*[\s\S]*?\*\//g, "");
    var out = [], depth = 0, start = 0, quote = null, esc = false;
    for (var i = 0; i < s.length; i++) {
      var ch = s[i];
      if (quote) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === quote) quote = null; continue; }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth < 0) return { error: "Unexpected '}' at character " + (i + 1) + " — a block was closed that was never opened." };
        if (depth === 0) { var rule = s.slice(start, i + 1).trim(); if (rule) out.push(rule); start = i + 1; }
      } else if (ch === ";" && depth === 0) {
        var at = s.slice(start, i + 1).trim();
        if (at) out.push(at); // an at-rule without a block (@import, @charset, @namespace)
        start = i + 1;
      }
    }
    if (quote) return { error: "Unterminated string (a quote is not closed)." };
    if (depth > 0) return { error: "Missing '}' — " + depth + " block" + (depth > 1 ? "s are" : " is") + " not closed." };
    var rest = s.slice(start).trim();
    if (rest) return { error: "Text outside a rule: \"" + short(rest, 40) + "\" — every declaration needs a selector and braces, e.g. h1 { color: red }." };
    return { rules: out };
  }
  /** Declarations of a rule body, split on ';' outside parentheses and quotes. */
  function splitDecls(body) {
    var out = [], depth = 0, quote = null, cur = "";
    for (var i = 0; i < body.length; i++) {
      var ch = body[i];
      if (quote) { cur += ch; if (ch === quote && body[i - 1] !== "\\") quote = null; continue; }
      if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
      if (ch === "(") depth++;
      else if (ch === ")") depth = Math.max(0, depth - 1);
      if (ch === ";" && depth === 0) { if (cur.trim()) out.push(cur.trim()); cur = ""; continue; }
      cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }
  function ruleHead(rule) { var i = rule.indexOf("{"); var h = (i === -1 ? rule : rule.slice(0, i)).trim(); return short(h || rule, 40); }
  function parserMessage(e) { return String((e && e.message) || e).replace(/^Failed to execute '\w+' on '\w+':\s*/, "").replace(/\.$/, ""); }

  /**
   * Validate a CSS text: structure (balanced braces, no stray text), no @import (it would load a
   * stylesheet from elsewhere), and — where the panel has CSSStyleSheet — the browser's own parser:
   * a rule it refuses, or a declaration it drops (unknown property, invalid value), is reported with
   * its message. → { ok: true, rules } or { ok: false, error }.
   */
  function validateCss(css) {
    if (typeof css !== "string" || !css.trim()) return { ok: false, error: "The CSS is empty." };
    var sp = splitRules(css);
    if (sp.error) return { ok: false, error: sp.error };
    if (!sp.rules.length) return { ok: false, error: "No rules found — write them like h1 { color: red }." };
    var bad = sp.rules.filter(function (r) { return /^@import\b/i.test(r); });
    if (bad.length) return { ok: false, error: "@import is not allowed in an override (it would load a stylesheet from elsewhere); write the rules themselves." };
    var sheet = null;
    if (typeof CSSStyleSheet === "function") { try { sheet = new CSSStyleSheet(); } catch (_) { sheet = null; } }
    var problems = [];
    sp.rules.forEach(function (rule, i) {
      var label = "rule " + (i + 1) + " (" + ruleHead(rule) + ")";
      var open = rule.indexOf("{"), close = rule.lastIndexOf("}");
      var body = open !== -1 && close > open ? rule.slice(open + 1, close) : "";
      var nested = /\{[^{}]*\{/.test(rule); // @media & co.: declarations sit in inner blocks
      var decls = nested || open === -1 ? [] : splitDecls(body);
      if (sheet) {
        var n = sheet.cssRules.length;
        try { sheet.insertRule(rule, n); } catch (e) { problems.push(label + ": " + parserMessage(e)); return; }
        var ins = sheet.cssRules[n];
        if (ins && ins.style && !nested) {
          decls.forEach(function (d) {
            var m = /^([-\w]+)\s*:\s*([\s\S]*)$/.exec(d);
            if (!m) { problems.push(label + ": '" + short(d, 40) + "' is not a 'property: value' declaration"); return; }
            var prop = m[1];
            if (prop.indexOf("--") === 0) return; // custom properties take anything
            if (ins.style.getPropertyValue(prop) === "") problems.push(label + ": '" + short(d, 50) + "' was dropped by the parser — unknown property or invalid value");
          });
        }
      } else if (!nested && open !== -1) {
        decls.forEach(function (d) { if (!/^[-\w]+\s*:\s*\S/.test(d)) problems.push(label + ": '" + short(d, 40) + "' is not a 'property: value' declaration"); });
      }
    });
    if (problems.length) return { ok: false, error: problems.slice(0, 5).join("; ") + (problems.length > 5 ? "; … " + (problems.length - 5) + " more" : "") };
    return { ok: true, rules: sp.rules.length };
  }

  // ── Storage ──────────────────────────────────────────────────────────────

  async function loadAll() {
    var st = await chrome.storage.local.get(KEY);
    var all = st && st[KEY];
    return all && typeof all === "object" && !Array.isArray(all) ? all : {};
  }
  function saveAll(all) {
    Object.keys(all).forEach(function (h) { if (!all[h] || !Object.keys(all[h]).length) delete all[h]; });
    var o = {}; o[KEY] = all; return chrome.storage.local.set(o);
  }

  /** Validate and save (or replace, by name) an override → { site, name, replaced, size, rules, count, total }. */
  async function saveOverride(a) {
    a = a || {};
    var site = normHost(a.site);
    if (!site) throw new Error("site is required — a host like example.com, or '*' for every site.");
    if (!/^(\*|[a-z0-9-]+(\.[a-z0-9-]+)*|localhost|\[[0-9a-f:.]+\]|\d{1,3}(\.\d{1,3}){3})$/i.test(site)) throw new Error("'" + a.site + "' is not a host — use the site's host name (example.com) or '*'.");
    var name = cleanName(a.name);
    if (!name) throw new Error("name is required — a short name saying what the override does (e.g. 'wider article').");
    var css = typeof a.css === "string" ? a.css.replace(/\r\n?/g, "\n").trim() : "";
    if (!css) throw new Error("css is required — the rule block(s), e.g. 'main article { max-width: 70ch }'.");
    if (css.length > MAX_CSS) throw new Error("The CSS is too long (" + css.length + " characters; the limit per override is " + MAX_CSS + ") — split it into named overrides or trim it.");
    var v = validateCss(css);
    if (!v.ok) throw new Error("The CSS was refused: " + v.error.replace(/\.$/, "") + ". Nothing was saved.");
    var all = await loadAll();
    var group = siteGroup(all, site);
    if (!group) { group = {}; all[site] = group; }
    var key = nameKey(group, name);
    var prev = key !== null ? group[key] : null;
    if (prev && key !== name) delete group[key]; // the same name spelt differently: one entry
    group[name] = { css: css, enabled: prev ? prev.enabled !== false : true, t: Date.now() };
    var total = sizeOf(all);
    if (total > MAX_TOTAL) throw new Error("Site styles are full (" + kb(total) + " of " + kb(MAX_TOTAL) + " with this override) — remove or shorten an override with browser_style_remove first. Nothing was saved.");
    await saveAll(all);
    return { site: site, name: name, replaced: !!prev, size: css.length, rules: v.rules, count: Object.keys(group).length, total: total };
  }

  /** Remove one override (by name) or all of a site → { site, removed: [names], left }. Throws when the name is unknown. */
  async function removeOverride(a) {
    a = a || {};
    var site = normHost(a.site);
    if (!site) throw new Error("site is required — a host like example.com, or '*'.");
    var all = await loadAll();
    var group = siteGroup(all, site);
    var names = group ? Object.keys(group) : [];
    if (a.all) {
      if (group) Object.keys(all).forEach(function (h) { if (normHost(h) === site) delete all[h]; });
      await saveAll(all);
      return { site: site, removed: names, left: 0 };
    }
    var key = nameKey(group, cleanName(a.name));
    if (key === null) throw new Error("No override named '" + a.name + "' on " + siteWords(site) + "." + (names.length ? " Its overrides: " + names.join(", ") + "." : " It has no overrides."));
    delete group[key];
    await saveAll(all);
    return { site: site, removed: [key], left: Object.keys(group).length };
  }

  /** Pause (enabled=false) or resume an override without deleting it → { site, name, enabled }. */
  async function setEnabled(a) {
    a = a || {};
    var site = normHost(a.site);
    var all = await loadAll();
    var group = siteGroup(all, site);
    var key = nameKey(group, cleanName(a.name));
    if (key === null) throw new Error("No override named '" + a.name + "' on " + siteWords(site) + "." + (group && Object.keys(group).length ? " Its overrides: " + Object.keys(group).join(", ") + "." : ""));
    group[key].enabled = a.enabled !== false;
    await saveAll(all);
    return { site: site, name: key, enabled: group[key].enabled };
  }

  // ── Page side ────────────────────────────────────────────────────────────

  // Put `css` into the one <style attr> element (created when missing) and keep it the last element of
  // <head>; an empty css removes the element. The content script does the same on later loads.
  function pageApplyStyles(css, attr) {
    var el = document.querySelector("style[" + attr + "]");
    if (!css) {
      if (el) el.remove();
      return { ok: true, removed: !!el };
    }
    if (!el) { el = document.createElement("style"); el.setAttribute(attr, ""); }
    if (el.textContent !== css) el.textContent = css;
    var parent = document.head || document.documentElement;
    if (el.parentNode !== parent || parent.lastElementChild !== el) parent.appendChild(el);
    return { ok: true, chars: css.length };
  }

  // What an element is and how it is styled: identity, a selector that finds it, computed box /
  // typography / background / layout values, and the stylesheet rules that match it (best effort:
  // cross-origin stylesheets cannot be read). `local` is the element's index from the snapshot
  // (window.__agentRefs) in this document; without it, `selector` is used.
  function pageInspect(local, selector) {
    var el = null;
    if (local) {
      el = (window.__agentRefs || [])[local - 1];
      if (!el || !el.isConnected) return { error: "stale" };
    } else {
      try { el = document.querySelector(selector); } catch (e) { return { error: "\"" + selector + "\" is not a valid CSS selector: " + String((e && e.message) || e).replace(/^Failed to execute 'querySelector' on 'Document':\s*/, "") }; }
      if (!el) return { error: "No element matches \"" + selector + "\" on this page (top frame). Check the selector with browser_read_page, or pass a ref." };
    }
    var cs = getComputedStyle(el);
    function px(v) { var n = parseFloat(v); return isNaN(n) ? v : Math.round(n * 10) / 10; }
    function sides(prefix, suffix) { return ["Top", "Right", "Bottom", "Left"].map(function (s) { return px(cs[prefix + s + (suffix || "")]); }); }
    function saneId(id) { return !!id && /^[A-Za-z][\w-]{0,40}$/.test(id) && !/\d{3,}|^(ember|react|radix|headlessui|mui|yui|ext|__)/i.test(id); }
    function stableClass(c) {
      if (!/^[a-zA-Z][\w-]{0,40}$/.test(c) || /^(css|sc|jsx|emotion|_)-/.test(c)) return false;
      return !c.split(/[-_]/).some(function (seg) { return seg.length >= 5 && /\d/.test(seg) && /[a-zA-Z]/.test(seg); }); // hash-like segments
    }
    function esc(s) { return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/([^\w-])/g, "\\$1"); }
    function unique(sel) { try { return document.querySelectorAll(sel).length === 1; } catch (_) { return false; } }
    function own(n) {
      var cls = Array.prototype.filter.call(n.classList, stableClass).map(esc);
      return cls.length ? n.localName + "." + cls.slice(0, 2).join(".") : n.localName;
    }
    function selectorFor(n) {
      if (saneId(n.id) && unique("#" + esc(n.id))) return "#" + esc(n.id);
      var cls = Array.prototype.filter.call(n.classList, stableClass).map(esc);
      for (var i = 1; i <= Math.min(cls.length, 3); i++) { var s = n.localName + "." + cls.slice(0, i).join("."); if (unique(s)) return s; }
      var cur = own(n), p = n.parentElement, depth = 0;
      while (p && p !== document.documentElement && depth < 4) {
        var ps = saneId(p.id) ? "#" + esc(p.id) : own(p);
        cur = ps + " > " + cur;
        if (unique(cur)) return cur;
        if (saneId(p.id)) break;
        p = p.parentElement; depth++;
      }
      if (n.parentElement) {
        var k = 1, sib = n;
        while ((sib = sib.previousElementSibling)) if (sib.localName === n.localName) k++;
        var nth = own(n) + ":nth-of-type(" + k + ")";
        if (unique(nth)) return nth;
        var i2 = cur.lastIndexOf(own(n));
        return i2 === -1 ? cur : cur.slice(0, i2) + nth;
      }
      return cur;
    }
    // Matched rules: every readable stylesheet, @media blocks that currently apply, up to 15 selectors.
    var matched = [], unreadable = 0;
    function sheetName(sheet) {
      if (!sheet.href) { var o = sheet.ownerNode; return o && o.hasAttribute && o.hasAttribute("data-agent-styles") ? "your override" : "inline <style>"; }
      try { var u = new URL(sheet.href); var f = u.pathname.split("/").pop() || u.host; return f.length > 40 ? f.slice(0, 37) + "…" : f; } catch (_) { return sheet.href.slice(0, 40); }
    }
    function walk(rules, name, media) {
      for (var i = 0; i < rules.length && matched.length < 15; i++) {
        var r = rules[i];
        if (typeof r.selectorText === "string") {
          var hit = false;
          try { hit = el.matches(r.selectorText); } catch (_) {
            hit = r.selectorText.split(",").some(function (s) { try { return el.matches(s.replace(/::?[\w-]+(\([^)]*\))?\s*$/, "")); } catch (e) { return false; } });
          }
          if (!hit) continue;
          var important = false;
          try { for (var j = 0; j < r.style.length; j++) if (r.style.getPropertyPriority(r.style[j]) === "important") { important = true; break; } } catch (_) {}
          matched.push({ selector: r.selectorText.length > 100 ? r.selectorText.slice(0, 97) + "…" : r.selectorText, sheet: name, media: media, decls: r.style ? r.style.length : 0, important: important });
        } else if (r.cssRules) {
          var m = media;
          if (r.media) {
            try { if (!matchMedia(r.media.mediaText).matches) continue; } catch (_) {}
            m = (media ? media + " " : "") + "@media " + r.media.mediaText;
          }
          walk(r.cssRules, name, m);
        }
      }
    }
    for (var s = 0; s < document.styleSheets.length; s++) {
      var sh = document.styleSheets[s];
      if (sh.disabled) continue;
      var rules;
      try { rules = sh.cssRules; } catch (_) { unreadable++; continue; }
      if (!rules) { unreadable++; continue; }
      walk(rules, sheetName(sh), "");
    }
    var r = el.getBoundingClientRect();
    var radius = ["TopLeft", "TopRight", "BottomRight", "BottomLeft"].map(function (c) { return px(cs["border" + c + "Radius"]); });
    return {
      tag: el.localName, id: el.id || "", classes: Array.prototype.slice.call(el.classList, 0, 12), selector: selectorFor(el),
      text: String(el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80),
      box: { width: Math.round(r.width), height: Math.round(r.height), top: Math.round(r.top + window.scrollY), left: Math.round(r.left + window.scrollX) },
      margin: sides("margin"), padding: sides("padding"),
      border: { width: sides("border", "Width"), style: cs.borderTopStyle, color: cs.borderTopColor },
      radius: radius.every(function (x) { return x === radius[0]; }) ? [radius[0]] : radius,
      font: { family: cs.fontFamily, size: px(cs.fontSize), weight: cs.fontWeight, style: cs.fontStyle, lineHeight: cs.lineHeight === "normal" ? "normal" : px(cs.lineHeight), color: cs.color, align: cs.textAlign, transform: cs.textTransform, decoration: cs.textDecorationLine, letterSpacing: cs.letterSpacing },
      background: { color: cs.backgroundColor, image: cs.backgroundImage === "none" ? "" : cs.backgroundImage.slice(0, 100) },
      display: cs.display, position: cs.position, opacity: cs.opacity, zIndex: cs.zIndex, overflow: cs.overflow,
      boxShadow: cs.boxShadow === "none" ? "" : cs.boxShadow.slice(0, 100),
      rules: matched, sheets: document.styleSheets.length, unreadable: unreadable,
    };
  }

  // ── Words for the model ──────────────────────────────────────────────────

  /** The browser_style_inspect report. */
  function formatInspect(r) {
    var ident = "<" + r.tag + (r.id ? "#" + r.id : "") + (r.classes.length ? "." + r.classes.join(".") : "") + ">";
    var lines = [ident + (r.text ? ' "' + short(r.text, 60) + '"' : "") + " — selector: " + r.selector];
    var box = "Box: " + r.box.width + "×" + r.box.height + " px at (" + r.box.left + ", " + r.box.top + ")";
    box += "; margin " + r.margin.join(" ") + "; padding " + r.padding.join(" ");
    var bw = r.border.width;
    box += "; border " + (bw.every(function (x) { return x === 0; }) ? "none" : bw.join(" ") + " " + r.border.style + " " + colourWords(r.border.color));
    box += "; radius " + r.radius.join(" ");
    lines.push(box);
    var f = r.font;
    lines.push("Type: " + f.family + " " + f.size + "px / " + f.lineHeight + (f.lineHeight === "normal" ? "" : "px") + ", weight " + f.weight + (f.style !== "normal" ? ", " + f.style : "") + ", color " + colourWords(f.color) +
      (f.align && f.align !== "start" && f.align !== "left" ? ", align " + f.align : "") + (f.transform && f.transform !== "none" ? ", " + f.transform : "") + (f.decoration && f.decoration !== "none" ? ", " + f.decoration : "") + (f.letterSpacing && f.letterSpacing !== "normal" ? ", letter-spacing " + f.letterSpacing : ""));
    lines.push("Background: " + colourWords(r.background.color) + (r.background.image ? ", image " + r.background.image : "") + (r.boxShadow ? "; shadow " + r.boxShadow : ""));
    lines.push("Layout: display " + r.display + ", position " + r.position + (r.zIndex !== "auto" ? ", z-index " + r.zIndex : "") + (r.opacity !== "1" ? ", opacity " + r.opacity : "") + (r.overflow !== "visible" ? ", overflow " + r.overflow : ""));
    var parts = [];
    if (r.rules.length) parts.push(r.rules.length + (r.rules.length >= 15 ? "+" : "") + ", from " + r.sheets + " stylesheet" + (r.sheets === 1 ? "" : "s"));
    if (r.unreadable) parts.push(r.unreadable + " cross-origin stylesheet" + (r.unreadable === 1 ? "" : "s") + " could not be read");
    var head = "Matched rules" + (parts.length ? " (" + parts.join("; ") + ")" : "") + ":";
    lines.push(head + (r.rules.length ? "" : " none" + (r.unreadable ? " readable" : "") + (r.sheets ? "" : " — the page has no stylesheets; the values above come from inline styles and the browser's defaults")));
    r.rules.forEach(function (m) { lines.push("  " + m.selector + "  (" + m.sheet + (m.media ? ", " + m.media : "") + ", " + m.decls + " declaration" + (m.decls === 1 ? "" : "s") + (m.important ? ", uses !important" : "") + ")"); });
    lines.push("An override for it starts with: " + r.selector + " { … } — browser_style_apply saves it for this site.");
    return lines.join("\n");
  }

  /** The browser_style_list report: every site, or one. */
  function formatList(all, site, withCss) {
    var hosts = Object.keys(all || {}).filter(function (h) { return Object.keys(all[h] || {}).length; });
    var total = countOf(all), size = sizeOf(all);
    if (site) {
      site = normHost(site);
      var group = siteGroup(all, site);
      if (!group || !Object.keys(group).length) return "No style overrides for " + siteWords(site) + "." + (total ? " " + total + " saved on other sites — browser_style_list without site shows them." : " browser_style_apply adds one.");
      return siteBlock(site, group, withCss).join("\n");
    }
    if (!hosts.length) return "No style overrides saved yet. browser_style_apply adds one for the current site (the site keeps it until it is removed).";
    hosts.sort(function (a, b) { return a === "*" ? -1 : b === "*" ? 1 : a.localeCompare(b); });
    var lines = ["Style overrides: " + total + " on " + hosts.length + " site" + (hosts.length === 1 ? "" : "s") + " (" + kb(size) + " of " + kb(MAX_TOTAL) + ")."];
    hosts.forEach(function (h) { lines = lines.concat(siteBlock(h, all[h], withCss)); });
    return lines.join("\n");
  }
  function siteBlock(site, group, withCss) {
    var names = Object.keys(group).sort();
    var lines = [(site === "*" ? "Every site" : site) + " (" + names.length + "):"];
    names.forEach(function (n) {
      var o = group[n] || {};
      var css = String(o.css || "");
      lines.push("  - " + n + " — " + kb(css.length) + ", " + (o.enabled === false ? "paused" : "on") + (o.t ? ", saved " + agoWords(o.t) : ""));
      lines.push(withCss ? css.split("\n").map(function (l) { return "      " + l; }).join("\n") : "      " + short(css.split("\n").filter(function (l) { return l.trim(); })[0] || "", 100) + (css.indexOf("\n") !== -1 ? " …" : ""));
    });
    return lines;
  }

  // ── Applying to the current tab; the content script ──────────────────────

  /** Put the saved overrides of the current tab's host into the tab now → { host, applies, chars } (or { error }). */
  async function applyToTab(tab) {
    tab = tab || (await H.currentTab());
    var host = hostOf(tab.url);
    if (!host) return { host: "", applies: false, error: "not a website tab" };
    var css = cssFor(await loadAll(), host);
    try {
      var r = await H.inTop(pageApplyStyles, [css, ATTR]);
      return { host: host, applies: true, chars: css.length, removed: !!(r && r.removed) };
    } catch (e) {
      return { host: host, applies: false, error: String((e && e.message) || e) };
    }
  }
  /** Apply (or clear, with "") an unsaved preview in the current tab; it lives in its own element and goes with the next load. */
  async function previewInTab(css) {
    return H.inTop(pageApplyStyles, [String(css || ""), PREVIEW_ATTR]);
  }

  /** Register the content script once (persistAcrossSessions keeps it over restarts) → true when registered. */
  async function ensureContentScript() {
    var sc = typeof chrome !== "undefined" && chrome.scripting;
    if (!sc || typeof sc.registerContentScripts !== "function") return false;
    var have = [];
    try { have = (await sc.getRegisteredContentScripts({ ids: [CS_ID] })) || []; } catch (_) { have = []; }
    if (have.some(function (s) { return s.id === CS_ID; })) return true;
    try {
      await sc.registerContentScripts([{ id: CS_ID, js: [CS_FILE], matches: ["http://*/*", "https://*/*"], runAt: "document_start", persistAcrossSessions: true }]);
      return true;
    } catch (e) {
      if (/duplicate/i.test(String((e && e.message) || e))) return true;
      console.warn("[styles] could not register the content script:", (e && e.message) || e);
      return false;
    }
  }
  var ready = ensureContentScript();

  // ── Tools ────────────────────────────────────────────────────────────────

  async function siteOf(a, tab) {
    if (a.site) return normHost(a.site);
    var host = hostOf(tab && tab.url);
    if (!host) throw new Error("The current tab is not a website (" + ((tab && tab.url) || "no URL") + ") — switch to one, or pass site (a host like example.com, or '*').");
    return host;
  }
  function usage(all) { return countOf(all) + " override" + (countOf(all) === 1 ? "" : "s") + " saved in all, " + kb(sizeOf(all)) + " of " + kb(MAX_TOTAL) + " used"; }
  function appliedWords(ap, site) {
    if (ap.applies) return site === "*" || ap.host === site ? "Applied in the current tab" : "Saved; it applies on " + site + " (the current tab is " + ap.host + ")";
    return "Saved; it applies when a page of " + siteWords(site) + " loads (the current tab could not be updated: " + ap.error + ")";
  }

  T.register("browser_style_inspect", async function (a) {
    a = a || {};
    var r;
    if (a.ref !== undefined && a.ref !== null) {
      var t = H.refTarget ? H.refTarget(Number(a.ref)) : null;
      if (!t) throw new Error("No element [" + a.ref + "] — call browser_read_page first (refs come from it).");
      var tab = await H.currentTab();
      var res;
      try {
        res = await chrome.scripting.executeScript({ target: { tabId: tab.id, documentIds: [t.documentId] }, func: pageInspect, args: [t.local, ""], world: "ISOLATED" });
      } catch (_) { throw new Error(STALE); }
      r = res && res[0] ? res[0].result : null;
      if (!r) throw new Error(STALE);
      if (r.error) throw new Error(r.error === "stale" ? STALE : r.error);
    } else {
      var sel = String(a.selector || "").trim();
      if (!sel) throw new Error("Pass ref (from browser_read_page) or selector (a CSS selector, e.g. 'main h1').");
      r = await H.inTop(pageInspect, [0, sel]);
    }
    return text(formatInspect(r));
  });

  T.register("browser_style_apply", async function (a) {
    a = a || {};
    var tab = null;
    try { tab = await H.currentTab(); } catch (e) { if (!a.site) throw e; }
    var site = await siteOf(a, tab);
    var r = await saveOverride({ site: site, name: a.name, css: a.css });
    var ap = tab ? await applyToTab(tab) : { applies: false, error: "no tab" };
    var all = await loadAll();
    return text((r.replaced ? "Replaced" : "Saved") + " override '" + r.name + "' for " + siteWords(site) + " (" + kb(r.size) + ", " + r.rules + " rule" + (r.rules === 1 ? "" : "s") + "). " + appliedWords(ap, site) +
      "; the site keeps it on every visit until it is removed (browser_style_remove). " + siteWords(site) + " now has " + r.count + " override" + (r.count === 1 ? "" : "s") + "; " + usage(all) + ". Check the result with browser_screenshot or browser_style_inspect.");
  });

  T.register("browser_style_list", async function (a) {
    a = a || {};
    return text(formatList(await loadAll(), a.site, a.css === true));
  });

  T.register("browser_style_remove", async function (a) {
    a = a || {};
    var tab = null;
    try { tab = await H.currentTab(); } catch (e) { if (!a.site) throw e; }
    var site = await siteOf(a, tab);
    var out;
    if (typeof a.enabled === "boolean") {
      if (!a.name) throw new Error("name is required with enabled — which override to " + (a.enabled ? "resume" : "pause") + ".");
      var s = await setEnabled({ site: site, name: a.name, enabled: a.enabled });
      out = (s.enabled ? "Resumed" : "Paused") + " override '" + s.name + "' on " + siteWords(site) + " (it stays saved; enabled=" + s.enabled + " undoes this).";
    } else if (a.all) {
      var r = await removeOverride({ site: site, all: true });
      if (!r.removed.length) return text("No overrides saved for " + siteWords(site) + " — nothing to remove.");
      out = "Removed " + r.removed.length + " override" + (r.removed.length === 1 ? "" : "s") + " of " + siteWords(site) + ": " + r.removed.join(", ") + ".";
    } else {
      if (!a.name) throw new Error("name is required (or all=true to remove every override of the site). browser_style_list shows the names.");
      var r2 = await removeOverride({ site: site, name: a.name });
      out = "Removed override '" + r2.removed[0] + "' from " + siteWords(site) + (r2.left ? " (" + r2.left + " left there)" : " (none left there)") + ".";
    }
    var ap = tab ? await applyToTab(tab) : { applies: false };
    return text(out + (ap.applies ? " The current tab is updated." : ap.error && ap.host ? " The current tab could not be updated (" + ap.error + "); the change applies on the next load." : ""));
  });

  // ── The 🎨 Styles tab ────────────────────────────────────────────────────

  function item(el, icon, name, desc, onclick) {
    return el("div", { className: "cmd-item", onclick: onclick }, [
      el("span", { className: "cmd-icon" }, [icon]),
      el("div", { className: "cmd-body" }, [el("div", { className: "cmd-name" }, [name]), el("div", { className: "cmd-desc" }, [desc])]),
    ]);
  }

  async function render(content, ctx) {
    var el = ctx.el;
    var host = hostOf(await ctx.currentTabUrl());
    var all = await loadAll();
    content.textContent = "";
    content.appendChild(item(el, "➕", "New override", host ? "A CSS rule " + host + " keeps on every visit — or ask the agent: \"make this page easier to read\"." : "Open a website tab, or write a rule for every site (*).", function () { showEditor(content, ctx, { site: host || "*" }); }));
    var shown = 0;
    [[host, host], ["*", "Every site"]].forEach(function (g) {
      var site = g[0];
      var group = site ? siteGroup(all, site) : null;
      var names = group ? Object.keys(group).sort() : [];
      if (!names.length) return;
      content.appendChild(el("div", { className: "cmd-group-title" }, [g[1]]));
      names.forEach(function (name) {
        shown++;
        var o = group[name] || {};
        var on = o.enabled !== false;
        var actions = el("div", { className: "prof-actions column" }, [
          el("button", { className: "prof-btn", title: on ? "Pause" : "Resume", onclick: function (e) { e.stopPropagation(); run(ctx, function () { return setEnabled({ site: site, name: name, enabled: !on }); }, (on ? "Paused '" : "Resumed '") + name + "'."); } }, [on ? "⏸" : "⏵"]),
          el("button", { className: "prof-btn", title: "Edit", onclick: function (e) { e.stopPropagation(); showEditor(content, ctx, { site: site, name: name, css: o.css || "" }); } }, ["✏️"]),
          el("button", { className: "prof-btn", title: "Delete", onclick: function (e) { e.stopPropagation(); if (confirm("Delete override '" + name + "'?")) run(ctx, function () { return removeOverride({ site: site, name: name }); }, "Deleted '" + name + "'."); } }, ["🗑"]),
        ]);
        content.appendChild(el("div", { className: "cmd-item" + (on ? "" : " paused"), onclick: function () { showEditor(content, ctx, { site: site, name: name, css: o.css || "" }); } }, [
          el("span", { className: "cmd-icon" }, [on ? "🎨" : "💤"]),
          el("div", { className: "cmd-body" }, [
            el("div", { className: "cmd-name" }, [name]),
            el("div", { className: "cmd-desc mono" }, [short(String(o.css || "").split("\n").filter(function (l) { return l.trim(); })[0] || "", 90)]),
            el("div", { className: "cmd-desc" }, [kb(String(o.css || "").length) + " · " + (on ? "on" : "paused") + (o.t ? " · " + ctx.ago(o.t) : "")]),
          ]),
          actions,
        ]));
      });
    });
    if (!shown) content.appendChild(el("div", { className: "cmd-empty" }, [host ? "No overrides for " + host + " yet." : "Open a website tab to see its overrides."]));
    if (host && siteGroup(all, host)) {
      content.appendChild(el("div", { className: "ed-actions" }, [
        el("button", { className: "prof-btn", title: "Remove every override of " + host, onclick: function () { if (confirm("Remove every override of " + host + "?")) run(ctx, function () { return removeOverride({ site: host, all: true }); }, "Reset " + host + "."); } }, ["🧹 Reset this site"]),
      ]));
    }
    var others = Object.keys(all).filter(function (h) { return h !== host && h !== "*" && Object.keys(all[h] || {}).length; }).sort();
    if (others.length) content.appendChild(el("div", { className: "cmd-empty" }, ["Also saved: " + others.map(function (h) { return h + " (" + Object.keys(all[h]).length + ")"; }).join(", ") + "."]));
  }

  /** Run a storage change from the tab, update the current tab, report, re-render. */
  async function run(ctx, change, okText) {
    try {
      await change();
      var ap = await applyToTab().catch(function () { return { applies: false }; });
      ctx.status(okText + (ap.applies ? "" : " (applies on the next load of the page)"), "good");
      ctx.rerender();
    } catch (e) { ctx.status("⚠ " + ((e && e.message) || e), "bad"); }
  }

  function showEditor(content, ctx, o) {
    var el = ctx.el;
    var editing = !!o.name;
    var name = el("input", { value: o.name || "", placeholder: "wider article, hide sidebar, larger text…" });
    var site = el("input", { value: o.site || "", placeholder: "example.com or *" });
    var css = el("textarea", { rows: 10, value: o.css || "", placeholder: "main article {\n  max-width: 70ch;\n  font-size: 18px;\n  line-height: 1.6;\n}", spellcheck: false });
    var apply = el("button", { className: "prof-btn primary" }, ["✓ Apply"]);
    apply.addEventListener("click", async function () {
      try {
        var r = await saveOverride({ site: site.value, name: name.value, css: css.value });
        if (editing && r.name !== o.name) await removeOverride({ site: o.site, name: o.name }).catch(function () {}); // renamed
        var ap = await applyToTab().catch(function () { return { applies: false }; });
        ctx.status((r.replaced ? "Updated '" : "Saved '") + r.name + "' for " + siteWords(r.site) + "." + (ap.applies ? "" : " It applies on the next load of the page."), "good");
        ctx.rerender();
      } catch (e) { ctx.status("⚠ " + ((e && e.message) || e), "bad"); }
    });
    content.textContent = "";
    content.appendChild(el("div", { className: "ed-wrap" }, [
      el("button", { className: "prof-btn", onclick: function () { ctx.rerender(); } }, ["← Back"]),
      el("h3", { className: "ed-title" }, [editing ? "🎨 " + o.name : "New override"]),
      ctx.field("Name", name),
      ctx.field("Site", site),
      ctx.field("CSS", css),
      el("div", { className: "ed-hint" }, ["Injected after the site's own stylesheets, so a plain rule of equal specificity wins. The site keeps it until you delete it."]),
      el("div", { className: "ed-actions" }, [apply, el("button", { className: "prof-btn", onclick: function () { ctx.rerender(); } }, ["Cancel"])]),
    ]));
    if (!editing && name.focus) name.focus();
  }

  globalThis.AgentExtras.tabs.push({ id: "styles", label: "🎨 Styles", render: render, storageKeys: [KEY] });

  // ── Quick commands ───────────────────────────────────────────────────────

  var RULES = " Inspect the elements first (browser_style_inspect), write small targeted rules, apply them with browser_style_apply under a name that says what they do, and check with a screenshot. Never touch security or consent UI, prices or amounts.";
  globalThis.AgentExtras.commands.push(
    { group: "Design", icon: "📖", name: "Make this page easier to read", prompt: "Make this page easier to read: larger text (about 18px) with more line-height (1.6), a comfortable maximum width for the main content (about 70ch, centred), and more breathing room between paragraphs — keep the site's colours and fonts." + RULES },
    { group: "Design", icon: "🧹", name: "Hide the distractions on this page", prompt: "Hide the distractions on this page — sidebars, promo banners, 'related' and 'recommended' blocks, sticky bars, floating widgets — but never consent or security UI (cookie choices, sign-in, warnings) and nothing I need to use the page." + RULES },
    { group: "Design", icon: "🎨", name: "Show this site's style overrides", prompt: "Show me the style overrides saved for this site (browser_style_list for the current site) and say in one line each what they do." }
  );

  // ── Exports: the pure parts and the storage, for tests and the palette extra ──

  globalThis.AgentExtras.styles = {
    KEY: KEY, ATTR: ATTR, PREVIEW_ATTR: PREVIEW_ATTR, CS_ID: CS_ID, CS_FILE: CS_FILE, MAX_CSS: MAX_CSS, MAX_TOTAL: MAX_TOTAL, MAX_NAME: MAX_NAME,
    normHost: normHost, hostOf: hostOf, siteGroup: siteGroup, nameKey: nameKey, sitesFor: sitesFor, cssFor: cssFor, applicable: applicable, sizeOf: sizeOf, countOf: countOf,
    splitRules: splitRules, splitDecls: splitDecls, validateCss: validateCss, rgbHex: rgbHex,
    loadAll: loadAll, saveAll: saveAll, saveOverride: saveOverride, removeOverride: removeOverride, setEnabled: setEnabled,
    applyToTab: applyToTab, previewInTab: previewInTab, ensureContentScript: ensureContentScript, ready: ready,
    formatInspect: formatInspect, formatList: formatList, pageApplyStyles: pageApplyStyles, pageInspect: pageInspect,
  };
})();
