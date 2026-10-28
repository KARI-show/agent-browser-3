// Extra feature "styles" (side panel): site styles — CSS overrides the agent writes with the user and
// the site keeps. Saved in chrome.storage.local under one key, agentSiteStyles = { host: { name: { css,
// enabled, t } } } ("*" = every site), capped at 200 KB; the content script (browser/extras/styles.cs.js,
// registered here with chrome.scripting.registerContentScripts) injects a site's enabled overrides as
// the last <style data-agent-styles> in <head> on every load, panel open or not, and follows storage
// changes live. Built into extras.js only for brands that switch the feature on; the tools are declared
// in browser/host/extras/styles.ts. Also adds the 🎨 Styles tab of the 🧩 panel and the "Design" quick
// commands (automations.js and commands.js pick them up from AgentExtras). The palette extra builds
// its themes on the storage helpers exposed at AgentExtras.styles. On top of the single override the
// model writes, the module carries whole looks (browser_style_preset: reading, focus, compact, dyslexia,
// print — one "Preset: <name>" override per site), a fonts override (browser_style_font, with a Google
// Fonts @import — the one @import the validator lets through, hoisted to the top of the injected text
// where a browser honours it) and a Stylus/UserCSS export and import of the overrides.
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
  var PRESET_PREFIX = "Preset: "; // a site has one preset override at a time
  var FONTS_NAME = "Fonts"; // the override browser_style_font writes
  // The one @import an override may carry: a Google Fonts stylesheet (browser_style_font googleFont) — any
  // other @import would pull a stylesheet from elsewhere.
  var GOOGLE_FONTS_IMPORT = /^@import\s+url\(\s*(?:"https:\/\/fonts\.googleapis\.com\/css2?\?[^"\s]*"|'https:\/\/fonts\.googleapis\.com\/css2?\?[^'\s]*')\s*\)\s*;?$/i;
  // An @import statement at the start of a CSS text (quote-aware: a Google Fonts URL may hold ';').
  var LEADING_IMPORT = /^@import\s+url\(\s*(?:"[^"]*"|'[^']*'|[^)]*)\s*\)\s*;\s*/i;

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
    var imports = [], parts = [];
    sitesFor(host).forEach(function (site) {
      var group = siteGroup(all, site);
      if (!group) return;
      Object.keys(group).sort().forEach(function (name) {
        var o = group[name];
        if (!o || o.enabled === false || typeof o.css !== "string" || !o.css.trim()) return;
        var css = o.css.trim(), m;
        // A browser honours an @import only before every other rule of the sheet: the ones an override starts with go first.
        while ((m = LEADING_IMPORT.exec(css))) { if (imports.indexOf(m[0].trim()) === -1) imports.push(m[0].trim()); css = css.slice(m[0].length); }
        parts.push("/* " + siteWords(site) + " · " + name.replace(/\*\//g, "* /") + " */\n" + css);
      });
    });
    return (imports.length ? imports.join("\n") + "\n\n" : "") + parts.join("\n\n");
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
    var seenRule = false;
    for (var k = 0; k < sp.rules.length; k++) {
      if (!/^@import\b/i.test(sp.rules[k])) { seenRule = true; continue; }
      if (!GOOGLE_FONTS_IMPORT.test(sp.rules[k])) return { ok: false, error: "@import is not allowed in an override (it would load a stylesheet from elsewhere); write the rules themselves. The one exception is a Google Fonts stylesheet (browser_style_font googleFont)." };
      if (seenRule) return { ok: false, error: "The @import must come before the other rules (a browser ignores it after them)." };
    }
    var sheet = null;
    if (typeof CSSStyleSheet === "function") { try { sheet = new CSSStyleSheet(); } catch (_) { sheet = null; } }
    var problems = [];
    sp.rules.forEach(function (rule, i) {
      if (/^@import\b/i.test(rule)) return; // checked above; a constructed stylesheet refuses @import
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
    return { ok: true, rules: sp.rules.filter(function (r) { return !/^@import\b/i.test(r); }).length };
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

  // ── Presets, fonts and UserCSS (pure) ────────────────────────────────────

  // Blocks a reading view does without, by class or id name — a conservative list: ads, sidebars, promo and
  // newsletter boxes. Consent and security UI are never on it (the prompt in host/extras/styles.ts forbids it).
  var CLUTTER = '[class*="sidebar"], [id*="sidebar"], [class*="promo"], [id*="promo"], [class*="newsletter"], [id*="newsletter"], [class*="advert"], [id*="advert"], [class*="adsbygoogle"], [class*="ad-slot"], [class*="ad-container"], [class*="ad-banner"], [class*="banner-ad"], [class^="ad-"], [class$="-ad"], [class*="-ad-"], [id^="ad-"], [id$="-ad"], [id*="-ad-"], .ad, .ads, #ad, #ads';
  var TEXT_ELS = "p, li, dd, dt, td, th, blockquote, figcaption, label, legend, summary, caption";
  var READING = [
    "/* Reading: a 68ch measure, 18px type with 1.7 leading, air between paragraphs, no clutter, no animations */",
    "html { font-size: 18px !important; }",
    "body { line-height: 1.7 !important; }",
    'article, [role="article"], [itemprop="articleBody"], .article, .article-body, .article-content, .post, .post-content, .post-body, .entry-content, .story-body, .page-content { max-width: 68ch !important; margin-left: auto !important; margin-right: auto !important; }',
    "p, li, dd, blockquote, figcaption { max-width: 68ch; line-height: 1.7 !important; }",
    "p { margin-top: 0 !important; margin-bottom: 1.25em !important; }",
    "h1, h2, h3, h4, h5, h6 { line-height: 1.3 !important; margin-top: 1.5em !important; margin-bottom: 0.5em !important; }",
    "img, video { max-width: 100% !important; height: auto !important; }",
    CLUTTER + " { display: none !important; }",
    "*, *::before, *::after { animation: none !important; }",
  ];
  /** The looks browser_style_preset switches on: name → CSS (each passes validateCss; sizes well under MAX_CSS). */
  var PRESETS = {
    reading: READING.join("\n"),
    focus: READING.concat([
      "/* Focus: media fade back until hovered, sticky bars stay put */",
      "img, video, iframe, embed, object { opacity: 0.35 !important; }",
      "img:hover, video:hover, iframe:hover, embed:hover, object:hover { opacity: 1 !important; }",
      'header, footer, nav, [role="banner"], [role="navigation"], [class*="sticky"], [id*="sticky"], [class*="fixed-top"], [class*="fixed-bottom"], [class*="navbar"] { position: static !important; }',
    ]).join("\n"),
    compact: [
      "/* Compact: 13px type, tight leading, small headings, slimmer paddings */",
      "html { font-size: 13px !important; }",
      "body, " + TEXT_ELS + " { line-height: 1.35 !important; }",
      "h1 { font-size: 1.6em !important; }",
      "h2 { font-size: 1.35em !important; }",
      "h3 { font-size: 1.15em !important; }",
      "h4, h5, h6 { font-size: 1em !important; }",
      "h1, h2, h3, h4, h5, h6 { line-height: 1.25 !important; margin-top: 0.8em !important; margin-bottom: 0.35em !important; }",
      "p, ul, ol, dl, blockquote, pre, table, figure { margin-top: 0 !important; margin-bottom: 0.6em !important; }",
      "li { margin-top: 0 !important; margin-bottom: 0.15em !important; }",
      "td, th { padding: 3px 6px !important; }",
      'button, [role="button"], .btn, .button, input, select, textarea { padding-top: 3px !important; padding-bottom: 3px !important; }',
      "header, nav, footer, main, section, article, aside, form, fieldset, .card, .container, .content, .panel { padding-top: 6px !important; padding-bottom: 6px !important; }",
    ].join("\n"),
    dyslexia: [
      "/* Dyslexia-friendly: a plain sans, wider letter and word spacing, roomy lines, left-aligned dark text on cream */",
      "html { background-color: #fbf7ef !important; }",
      "body { background-color: #fbf7ef !important; color: #222222 !important; line-height: 1.8 !important; }",
      'main, article, [role="main"], .content, .post, .post-content, .entry-content, .article-body { background-color: #fbf7ef !important; }',
      "body, " + TEXT_ELS + ", a, button, input, select, textarea, h1, h2, h3, h4, h5, h6 { font-family: Verdana, \"Open Sans\", Arial, Helvetica, system-ui, sans-serif !important; letter-spacing: 0.05em !important; word-spacing: 0.1em !important; }",
      TEXT_ELS + " { color: #222222 !important; text-align: left !important; line-height: 1.8 !important; }",
      "h1, h2, h3, h4, h5, h6 { color: #222222 !important; text-align: left !important; line-height: 1.4 !important; }",
      "p { margin-bottom: 1.2em !important; }",
      "em, i { font-style: normal !important; font-weight: 700 !important; }",
      "a { text-decoration: underline !important; }",
    ].join("\n"),
    print: [
      "/* Print: black on white, no chrome, link targets after the links, nothing fixed */",
      "html, body { background-color: #ffffff !important; color: #000000 !important; }",
      "body * { color: #000000 !important; background-color: transparent !important; background-image: none !important; box-shadow: none !important; text-shadow: none !important; position: static !important; }",
      'nav, aside, footer, video, iframe, embed, object, [role="navigation"], [role="complementary"], [role="contentinfo"] { display: none !important; }',
      "a { text-decoration: underline !important; }",
      'a[href^="http"]::after { content: " (" attr(href) ")"; font-size: 0.85em; word-break: break-all; }',
      "img { max-width: 100% !important; }",
      "pre, code { white-space: pre-wrap !important; overflow-wrap: anywhere !important; }",
      "*, *::before, *::after { animation: none !important; }",
    ].join("\n"),
  };
  var PRESET_NAMES = Object.keys(PRESETS);
  function presetName(preset) { return PRESET_PREFIX + preset; }
  /** The preset overrides a site has: [{ name, preset, enabled }] (one, unless saved by hand). */
  function presetsOf(all, site) {
    var group = siteGroup(all, site) || {};
    return Object.keys(group).filter(function (n) { return n.indexOf(PRESET_PREFIX) === 0; }).map(function (n) { return { name: n, preset: n.slice(PRESET_PREFIX.length), enabled: !group[n] || group[n].enabled !== false }; });
  }

  /** A font-family value from the model or the user: one line, without the characters that would end the declaration or the rule. */
  function fontFamilyValue(v) { return String(v == null ? "" : v).replace(/[;{}]/g, " ").replace(/\s+/g, " ").trim(); }
  function quoteFamily(name) { return /^[A-Za-z][\w-]*$/.test(name) ? name : '"' + name.replace(/"/g, "") + '"'; }
  /**
   * The options of browser_style_font, checked and filled in: a Google Fonts family stands in for body and
   * headings where they are not given. Throws when nothing is set. → { body, headings, code, size, googleFont }
   */
  function fontOptions(o) {
    o = o || {};
    var google = String(o.googleFont == null ? "" : o.googleFont).replace(/\s+/g, " ").trim();
    if (google && !/^[A-Za-z0-9][A-Za-z0-9 ]{0,60}$/.test(google)) throw new Error("googleFont must be a Google Fonts family name such as 'Inter' or 'Source Serif 4' (letters, digits and spaces).");
    var body = fontFamilyValue(o.body), headings = fontFamilyValue(o.headings), code = fontFamilyValue(o.code);
    var size = o.size === undefined || o.size === null || o.size === "" ? null : Number(o.size);
    if (size !== null && (!isFinite(size) || size < 12 || size > 24)) throw new Error("size must be a base font size between 12 and 24 (px).");
    if (google) {
      var stack = quoteFamily(google) + ", sans-serif";
      if (!body) body = stack;
      if (!headings) headings = stack;
    }
    if (!body && !headings && !code && size === null) throw new Error("Nothing to set — pass body, headings or code (font-family strings), size (12-24) or googleFont.");
    return { body: body, headings: headings, code: code, size: size, googleFont: google };
  }
  /** The "Fonts" override for those options: the Google Fonts @import first, then !important font-family rules and the base size. */
  function fontCss(o) {
    var f = fontOptions(o);
    var out = [];
    if (f.googleFont) out.push('@import url("https://fonts.googleapis.com/css2?family=' + encodeURIComponent(f.googleFont).replace(/%20/g, "+") + '&display=swap");');
    out.push("/* Fonts" + (f.googleFont ? " — " + f.googleFont + " from Google Fonts" : "") + " */");
    if (f.body) out.push("body, " + TEXT_ELS + ", input, select, textarea, button { font-family: " + f.body + " !important; }");
    if (f.headings) out.push("h1, h2, h3, h4, h5, h6 { font-family: " + f.headings + " !important; }");
    if (f.code) out.push("code, pre, kbd, samp, var, tt { font-family: " + f.code + " !important; }");
    if (f.size !== null) out.push("html { font-size: " + f.size + "px !important; }");
    return out.join("\n");
  }

  function commentSafe(s) { return String(s == null ? "" : s).replace(/\*\//g, "* /").replace(/\s+/g, " ").trim(); }
  function indentCss(css, pad) { return css.split("\n").map(function (l) { return l.trim() ? pad + l : ""; }).join("\n"); }
  function isoDate(ts) { return ts ? new Date(ts).toISOString().slice(0, 10) : ""; }
  /** The sites an export covers: the one asked for (when it has overrides), or every site with "*" first. */
  function exportSites(all, site) {
    if (site) { var g = siteGroup(all, site); return g && Object.keys(g).length ? [site] : []; }
    return Object.keys(all || {}).filter(function (h) { return Object.keys(all[h] || {}).length; }).sort(function (a, b) { return a === "*" ? -1 : b === "*" ? 1 : a.localeCompare(b); });
  }
  function exportFilename(site, format) { return (site ? (site === "*" ? "every-site" : site.replace(/[^\w.-]+/g, "_")) : "all") + "-styles" + (format === "css" ? ".css" : ".user.css"); }
  /**
   * The overrides of one site (or every site) as a Stylus/UserCSS document: a ==UserStyle== header and one
   * @-moz-document block per site (domain("host"); regexp(".*") for the overrides that apply everywhere),
   * each override a commented section, paused ones commented out, the @imports hoisted to the top where a
   * browser honours them. format "css": the sections only — no header, no blocks.
   */
  function toUserCss(all, site, format) {
    site = site ? normHost(site) : "";
    format = format === "css" ? "css" : "usercss";
    var imports = [], blocks = [], names = [];
    exportSites(all, site).forEach(function (h) {
      var group = siteGroup(all, h);
      var sections = [];
      Object.keys(group).sort().forEach(function (name) {
        var o = group[name] || {};
        var css = String(o.css || "").trim(), m;
        while ((m = LEADING_IMPORT.exec(css))) { if (imports.indexOf(m[0].trim()) === -1) imports.push(m[0].trim()); css = css.slice(m[0].length); }
        names.push(name);
        var head = "/* " + commentSafe(name) + (o.t ? " — saved " + isoDate(o.t) : "") + (o.enabled === false ? " — paused" : "") + " */";
        sections.push(o.enabled === false ? head + "\n/*\n" + css.replace(/\*\//g, "* /") + "\n*/" : head + "\n" + css);
      });
      var body = sections.join("\n\n");
      if (format === "css") blocks.push("/* ── " + siteWords(h) + " ── */\n" + body);
      else blocks.push("@-moz-document " + (h === "*" ? 'regexp(".*")' : 'domain("' + h + '")') + " {\n" + indentCss(body, "  ") + "\n}");
    });
    var out = [];
    if (format === "usercss") {
      var label = site ? siteWords(site) : "all sites";
      out.push([
        "/* ==UserStyle==",
        "@name           " + label + " — site styles",
        "@namespace      agent-site-styles",
        "@version        1.0.0",
        "@description    " + names.length + " override" + (names.length === 1 ? "" : "s") + " for " + label + ": " + commentSafe(names.join(", ")).slice(0, 200),
        "==/UserStyle== */",
      ].join("\n"));
    }
    if (imports.length) out.push(imports.join("\n"));
    return out.concat(blocks).join("\n\n");
  }

  /** The index of the '}' closing the block opened at `open` (quotes and comments skipped); the text's end when unbalanced. */
  function matchBrace(s, open) {
    var depth = 0, quote = null;
    for (var i = open; i < s.length; i++) {
      var ch = s[i];
      if (quote) { if (ch === "\\") i++; else if (ch === quote) quote = null; continue; }
      if (ch === "/" && s[i + 1] === "*") { var e = s.indexOf("*/", i + 2); i = e === -1 ? s.length : e + 1; continue; }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) return i;
    }
    return s.length;
  }
  /** A block's text without the indentation it had inside its @-moz-document. */
  function dedent(css) {
    var lines = css.replace(/^\n+|\s+$/g, "").split("\n");
    var pad = null;
    lines.forEach(function (l) { if (!l.trim()) return; var n = /^[ \t]*/.exec(l)[0].length; pad = pad === null ? n : Math.min(pad, n); });
    return lines.map(function (l) { return l.slice(Math.min(pad || 0, /^[ \t]*/.exec(l)[0].length)); }).join("\n").trim();
  }
  /** The sites of an @-moz-document prelude: domain("h") → h, url-prefix / url → the URL's host, regexp(".*") → "*"; anything else is not understood. */
  function preludeSites(prelude) {
    var sites = [], m, re = /(domain|url-prefix|url|regexp)\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi;
    while ((m = re.exec(prelude))) {
      var kind = m[1].toLowerCase(), v = String(m[2] != null ? m[2] : m[3] != null ? m[3] : m[4] || "").trim(), site = "";
      if (kind === "domain") site = normHost(v);
      else if (kind === "regexp") site = /^\^?(\.\*|\.\+|\.\*\?)\$?$/.test(v) ? "*" : "";
      else site = hostOf(v);
      if (site && sites.indexOf(site) === -1) sites.push(site);
    }
    return sites;
  }
  /**
   * UserCSS or plain CSS → [{ site, css, prelude? }]: each @-moz-document block to the sites of its prelude
   * (site "" with the prelude when none is understood), the rules outside the blocks to "*" when there are
   * blocks — else the whole text is one plain-CSS entry with site "". The ==UserStyle== header is dropped and
   * the @imports found outside the blocks (the export hoists them there) go back to the top of every entry.
   */
  function parseUserCss(text) {
    var s = String(text == null ? "" : text).replace(/\r\n?/g, "\n").replace(/\/\*\s*==UserStyle==[\s\S]*?==\/UserStyle==\s*\*\//, "");
    var blocks = [], outside = "", i = 0, n = s.length;
    while (i < n) {
      var ch = s[i];
      if (ch === "/" && s[i + 1] === "*") { var e = s.indexOf("*/", i + 2); e = e === -1 ? n : e + 2; outside += s.slice(i, e); i = e; continue; }
      if (ch === '"' || ch === "'") { var q = i + 1; while (q < n && s[q] !== ch) { if (s[q] === "\\") q++; q++; } outside += s.slice(i, q + 1); i = q + 1; continue; }
      if (ch === "@" && s.slice(i, i + 14) === "@-moz-document" && !/[\w-]/.test(s[i + 14] || "")) {
        var open = s.indexOf("{", i);
        if (open === -1) break;
        var close = matchBrace(s, open);
        var css = dedent(s.slice(open + 1, close));
        if (css.replace(/\/\*[\s\S]*?\*\//g, "").trim()) blocks.push({ prelude: s.slice(i + 14, open).trim(), css: css });
        i = close + 1;
        continue;
      }
      outside += ch; i++;
    }
    var imports = [];
    var rest = outside.replace(/@import\s+url\(\s*(?:"[^"]*"|'[^']*'|[^)]*)\s*\)\s*;?/gi, function (x) { x = x.replace(/;?$/, ";"); if (imports.indexOf(x) === -1) imports.push(x); return ""; }).trim();
    var restHasRules = !!rest.replace(/\/\*[\s\S]*?\*\//g, "").trim();
    function entry(site, css, prelude) { var o = { site: site, css: (imports.length ? imports.join("\n") + "\n" : "") + css }; if (prelude) o.prelude = prelude; return o; }
    if (!blocks.length) return restHasRules ? [entry("", rest)] : [];
    var out = [];
    blocks.forEach(function (b) {
      var sites = preludeSites(b.prelude);
      if (!sites.length) out.push(entry("", b.css, b.prelude));
      sites.forEach(function (site) { out.push(entry(site, b.css, b.prelude)); });
    });
    if (restHasRules) out.push(entry("*", rest));
    return out;
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

  /** Save `body` as a text file in Downloads (a data: URL; the download id comes back) → { id, filename, size }. */
  async function downloadText(filename, body, mime) {
    var dl = typeof chrome !== "undefined" && chrome.downloads;
    if (!dl || typeof dl.download !== "function") throw new Error("This build cannot save files (no downloads permission) — call again without save and copy the text.");
    var id = await dl.download({ url: "data:" + (mime || "text/css") + ";charset=utf-8," + encodeURIComponent(body), filename: filename, conflictAction: "uniquify" });
    return { id: id, filename: filename, size: body.length };
  }

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

  T.register("browser_style_preset", async function (a) {
    a = a || {};
    var preset = String(a.preset || "").trim().toLowerCase();
    if (preset !== "off" && !PRESETS[preset]) throw new Error("preset must be one of " + PRESET_NAMES.join(", ") + " — or off to remove the site's preset.");
    var tab = null;
    try { tab = await H.currentTab(); } catch (e) { if (!a.site) throw e; }
    var site = await siteOf(a, tab);
    var name = presetName(preset);
    var had = presetsOf(await loadAll(), site);
    var gone = [], paused = false;
    // One preset at a time: every other "Preset: …" override of the site goes; the same one is refreshed.
    for (var i = 0; i < had.length; i++) {
      if (preset !== "off" && had[i].name === name) { paused = !had[i].enabled; continue; }
      await removeOverride({ site: site, name: had[i].name });
      gone.push(had[i].preset);
    }
    if (preset === "off") {
      var apOff = tab ? await applyToTab(tab) : { applies: false };
      if (!gone.length) return text("No preset is on for " + siteWords(site) + ". Presets: " + PRESET_NAMES.join(", ") + ".");
      return text("Preset " + gone.join(", ") + " is off for " + siteWords(site) + " (override '" + presetName(gone[0]) + "' removed; its other overrides are untouched)." + (apOff.applies ? " The current tab is updated." : ""));
    }
    var r = await saveOverride({ site: site, name: name, css: PRESETS[preset] });
    if (paused) await setEnabled({ site: site, name: name, enabled: true });
    var ap = tab ? await applyToTab(tab) : { applies: false, error: "no tab" };
    return text("Preset '" + preset + "' is on for " + siteWords(site) + " — override '" + r.name + "' (" + kb(r.size) + ", " + r.rules + " rules" + (gone.length ? ", replacing " + gone.join(", ") : r.replaced ? ", refreshed" : "") + "). " + appliedWords(ap, site) +
      "; the site keeps it until browser_style_preset preset=off (or browser_style_remove). Check it with browser_screenshot and fix a broken spot with a small browser_style_apply rule. Other presets: " + PRESET_NAMES.filter(function (p) { return p !== preset; }).join(", ") + ".");
  });

  T.register("browser_style_font", async function (a) {
    a = a || {};
    var f = fontOptions(a);
    var css = fontCss(a);
    var tab = null;
    try { tab = await H.currentTab(); } catch (e) { if (!a.site) throw e; }
    var site = await siteOf(a, tab);
    var r = await saveOverride({ site: site, name: FONTS_NAME, css: css });
    var ap = tab ? await applyToTab(tab) : { applies: false, error: "no tab" };
    var what = [];
    if (f.body) what.push("body text → " + f.body);
    if (f.headings) what.push("headings → " + f.headings);
    if (f.code) what.push("code → " + f.code);
    if (f.size !== null) what.push("base size → " + f.size + "px");
    return text((r.replaced ? "Replaced" : "Saved") + " the '" + r.name + "' override for " + siteWords(site) + " (" + kb(r.size) + "): " + what.join("; ") + ". " +
      (f.googleFont ? "'" + f.googleFont + "' is loaded with an @import from fonts.googleapis.com at the top of the override — a site's Content-Security-Policy can block that import, in which case the fallback fonts show (browser_style_inspect on a paragraph tells which font rendered). " : "") +
      appliedWords(ap, site) + "; the site keeps it until browser_style_remove name=" + r.name + ".");
  });

  T.register("browser_style_export", async function (a) {
    a = a || {};
    var site = a.site ? normHost(a.site) : "";
    var format = a.format === "css" ? "css" : "usercss";
    var all = await loadAll();
    var sites = exportSites(all, site);
    if (!sites.length) throw new Error(site ? "No style overrides for " + siteWords(site) + " — nothing to export." + (countOf(all) ? " browser_style_list shows the sites that have some." : "") : "No style overrides saved yet — nothing to export.");
    var doc = toUserCss(all, site, format);
    if (!a.save) return text(doc);
    var r = await downloadText(exportFilename(site, format), doc);
    return text("Saved " + r.filename + " to Downloads (download id " + r.id + ", " + kb(r.size) + "): " + sites.map(function (h) { return siteWords(h) + " (" + Object.keys(siteGroup(all, h)).length + ")"; }).join(", ") + ". " +
      (format === "usercss" ? "It installs in Stylus (Manage → Import, or drop the file onto the Stylus page); paused overrides are in it as comments." : "Plain CSS with a comment per override."));
  });

  T.register("browser_style_import", async function (a) {
    a = a || {};
    var src = typeof a.css === "string" ? a.css : "";
    if (!src.trim()) throw new Error("css is required — a UserCSS document (@-moz-document domain(\"…\") blocks) or plain CSS with site.");
    var entries = parseUserCss(src);
    if (!entries.length) throw new Error("No CSS rules found in the text.");
    var tab = null;
    try { tab = await H.currentTab(); } catch (_) { tab = null; } // not needed when every block names its site
    var given = a.site ? normHost(a.site) : "";
    var name = cleanName(a.name) || "Imported";
    // One override per site: the valid blocks of a site are joined; a broken one is reported and skipped. Plain
    // CSS goes to the given site or the current tab's; a block whose prelude is not understood only to a given site.
    var bySite = {}, order = [], lines = [], problems = [];
    entries.forEach(function (e) {
      var site = e.site || given || (e.prelude ? "" : hostOf(tab && tab.url));
      var where = e.prelude ? "the block for " + short(e.prelude, 50) : "the plain CSS";
      if (!site) { problems.push("  skipped " + where + ": no site — pass site, or use @-moz-document domain(\"…\") blocks"); return; }
      var v = validateCss(e.css);
      if (!v.ok) { problems.push("  " + siteWords(site) + ": refused " + where + " — " + v.error.replace(/\.$/, "")); return; }
      if (!bySite[site]) { bySite[site] = []; order.push(site); }
      bySite[site].push(e.css);
    });
    var saved = 0;
    for (var i = 0; i < order.length; i++) {
      try {
        var r = await saveOverride({ site: order[i], name: name, css: bySite[order[i]].join("\n\n") });
        saved++;
        lines.push("  " + siteWords(order[i]) + ": " + (r.replaced ? "replaced" : "saved") + " override '" + r.name + "' (" + kb(r.size) + ", " + r.rules + " rule" + (r.rules === 1 ? "" : "s") + ")");
      } catch (e) { lines.push("  " + siteWords(order[i]) + ": not saved — " + String((e && e.message) || e)); }
    }
    lines = lines.concat(problems);
    if (!saved) throw new Error("Nothing was imported:\n" + lines.join("\n"));
    var ap = tab ? await applyToTab(tab) : { applies: false };
    return text("Imported " + saved + " override" + (saved === 1 ? "" : "s") + " named '" + name + "'" + (ap.applies ? " (the current tab is updated)" : "") + ":\n" + lines.join("\n") + "\nThe sites keep them until browser_style_remove.");
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
    { group: "Design", icon: "🎨", name: "Show this site's style overrides", prompt: "Show me the style overrides saved for this site (browser_style_list for the current site) and say in one line each what they do." },
    { group: "Design", icon: "📚", name: "Reading mode for this site", prompt: "Switch this site to the reading preset (browser_style_preset preset=reading): a comfortable measure, bigger text with more line-height, sidebars and promo blocks hidden, animations off — the site keeps it. Take a screenshot; if something I need is hidden or broken, fix it with a small browser_style_apply rule (never consent or security UI). preset=off switches it off." },
    { group: "Design", icon: "🔤", name: "Dyslexia-friendly text", prompt: "Make this site's text dyslexia-friendly with browser_style_preset preset=dyslexia (a plain sans, wider letter and word spacing, 1.8 line-height, left-aligned dark text on cream, underlined links), take a screenshot and fix anything that became unreadable with a targeted browser_style_apply rule." },
    { group: "Design", icon: "🔠", name: "Change the site's fonts", prompt: "Change this site's fonts with browser_style_font (body text, headings, code, base size; a Google Fonts family loads with googleFont) to: ", partial: true },
    { group: "Design", icon: "📤", name: "Export my styles for Stylus", prompt: "Export my style overrides for this site as a UserCSS file for Stylus (browser_style_export with save=true), tell me where it landed and how to install it in Stylus; if this site has none, export every site's instead." }
  );

  // ── Exports: the pure parts and the storage, for tests and the palette extra ──

  globalThis.AgentExtras.styles = {
    KEY: KEY, ATTR: ATTR, PREVIEW_ATTR: PREVIEW_ATTR, CS_ID: CS_ID, CS_FILE: CS_FILE, MAX_CSS: MAX_CSS, MAX_TOTAL: MAX_TOTAL, MAX_NAME: MAX_NAME,
    normHost: normHost, hostOf: hostOf, siteGroup: siteGroup, nameKey: nameKey, sitesFor: sitesFor, cssFor: cssFor, applicable: applicable, sizeOf: sizeOf, countOf: countOf,
    splitRules: splitRules, splitDecls: splitDecls, validateCss: validateCss, rgbHex: rgbHex,
    loadAll: loadAll, saveAll: saveAll, saveOverride: saveOverride, removeOverride: removeOverride, setEnabled: setEnabled,
    applyToTab: applyToTab, previewInTab: previewInTab, ensureContentScript: ensureContentScript, ready: ready,
    formatInspect: formatInspect, formatList: formatList, pageApplyStyles: pageApplyStyles, pageInspect: pageInspect,
    PRESET_PREFIX: PRESET_PREFIX, FONTS_NAME: FONTS_NAME, PRESETS: PRESETS, PRESET_NAMES: PRESET_NAMES, presetsOf: presetsOf,
    fontOptions: fontOptions, fontCss: fontCss, toUserCss: toUserCss, parseUserCss: parseUserCss, preludeSites: preludeSites, exportFilename: exportFilename, downloadText: downloadText,
  };
})();
