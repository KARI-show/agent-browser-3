// Extra feature "palette" (side panel): what the page is made of — colours, fonts, spacing — WCAG 2
// contrast, and themes (dark, sepia, high contrast, custom) built on the extracted palette and applied
// through the styles extra's overrides (the same agentSiteStyles key, name "theme:<mode>"), so a theme
// persists like any other override and shows up in the 🎨 tab. Built into extras.js only for brands that
// switch the feature on (which need "styles" too — browser/brand.mjs FEATURE_REQUIRES); the tools are
// declared in browser/host/extras/palette.ts. Colour harmonies of an accent (browser_palette_harmony:
// wheel rotations, tints, shades, each with its contrast) come from the same colour maths, as do the
// page's design tokens (browser_palette_tokens: the custom properties its stylesheets declare, grouped and
// counted by use), a recolouring of the page (browser_palette_recolor: the elements near one colour get an
// override that sets another) and the dominant colours of an image (browser_palette_from_image: drawn on a
// canvas in the page, median cut). Also adds the 🧪 Palette tab of the 🧩 panel and the "Design" quick
// commands. styles.js is concatenated before this file (OPT_IN_FEATURES order), so AgentExtras.styles is
// defined by now.
//
// Page-side functions are injected with chrome.scripting.executeScript, so each is self-contained (no
// closures over this file). The tab's DOM is built with ctx.el, never innerHTML; a swatch is an element
// with an inline background from a validated #rrggbb only.
(function () {
  if (!globalThis.AGENT_BRAND || !globalThis.AGENT_BRAND.has("palette")) return;
  var T = globalThis.AgentBrowserTools;
  var H = T.helpers;
  var text = H.text;
  var MAX_SAMPLE = 3000; // elements looked at in the top frame
  var THEME_PREFIX = "theme:";
  var HEX = /^#[0-9a-f]{6}$/;
  var MAX_TOKENS = 400; // custom properties collected from the page's stylesheets
  var TOP_TOKENS = 40; // the ones reported, most used first
  var MAX_SELECTORS = 60; // selectors a recolour override may carry
  var IMAGE_SIDE = 64; // an image is read at most this many px on its long side (≤ 4 096 pixels)
  var STALE = "That element is gone — the page changed. Call browser_read_page again.";

  function S() {
    var s = globalThis.AgentExtras && globalThis.AgentExtras.styles;
    if (!s) throw new Error("The styles extra is not in this build — themes are saved as site style overrides and need it.");
    return s;
  }

  // ── Colour maths (pure) ──────────────────────────────────────────────────

  var NAMED = { white: "#ffffff", black: "#000000", red: "#ff0000", green: "#008000", blue: "#0000ff", yellow: "#ffff00", gray: "#808080", grey: "#808080", silver: "#c0c0c0", orange: "#ffa500", purple: "#800080", navy: "#000080", teal: "#008080", maroon: "#800000", aqua: "#00ffff", cyan: "#00ffff", fuchsia: "#ff00ff", magenta: "#ff00ff", lime: "#00ff00", olive: "#808000", whitesmoke: "#f5f5f5", lightgray: "#d3d3d3", lightgrey: "#d3d3d3", darkgray: "#a9a9a9", darkgrey: "#a9a9a9", dimgray: "#696969", dimgrey: "#696969", gainsboro: "#dcdcdc", rebeccapurple: "#663399", transparent: "transparent" };
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function hex2(n) { var h = clamp(Math.round(n), 0, 255).toString(16); return h.length < 2 ? "0" + h : h; }
  function toHex(c) { return "#" + hex2(c.r) + hex2(c.g) + hex2(c.b); }
  function num(v, scale) { v = String(v).trim(); if (!v) return NaN; return v.slice(-1) === "%" ? parseFloat(v) * (scale / 100) : parseFloat(v); }
  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360 / 360; s = clamp(s, 0, 1); l = clamp(l, 0, 1);
    if (s === 0) return { r: l * 255, g: l * 255, b: l * 255 };
    var q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    function f(t) { t = (t + 1) % 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; }
    return { r: f(h + 1 / 3) * 255, g: f(h) * 255, b: f(h - 1 / 3) * 255 };
  }
  function rgbToHsl(c) {
    var r = c.r / 255, g = c.g / 255, b = c.b / 255, max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, h = 0, s = 0;
    if (max !== min) {
      var d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h *= 60;
    }
    return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 1000) / 10 };
  }
  /** Any CSS colour Chrome's computed styles produce (rgb/rgba, hex, hsl, color(srgb), a few names) → { r, g, b, a } or null. */
  function parseColor(s) {
    s = String(s == null ? "" : s).trim().toLowerCase();
    if (!s) return null;
    if (s === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
    if (NAMED[s]) return parseColor(NAMED[s]);
    var m;
    if ((m = /^#([0-9a-f]{3,8})$/.exec(s))) {
      var h = m[1];
      if (h.length === 3 || h.length === 4) h = h.split("").map(function (c) { return c + c; }).join("");
      if (h.length !== 6 && h.length !== 8) return null;
      return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 };
    }
    if ((m = /^rgba?\(([^)]+)\)$/.exec(s))) {
      var p = m[1].split(/[\s,\/]+/).filter(Boolean);
      if (p.length < 3) return null;
      var rgb = p.slice(0, 3).map(function (v) { return num(v, 255); });
      if (rgb.some(isNaN)) return null;
      var a = p[3] !== undefined ? num(p[3], 1) : 1;
      return { r: rgb[0], g: rgb[1], b: rgb[2], a: isNaN(a) ? 1 : clamp(a, 0, 1) };
    }
    if ((m = /^hsla?\(([^)]+)\)$/.exec(s))) {
      var q = m[1].split(/[\s,\/]+/).filter(Boolean);
      if (q.length < 3) return null;
      var hh = parseFloat(q[0]), ss = num(q[1], 100), ll = num(q[2], 100);
      if ([hh, ss, ll].some(isNaN)) return null;
      var c = hslToRgb(hh, ss / 100, ll / 100);
      var a2 = q[3] !== undefined ? num(q[3], 1) : 1;
      c.a = isNaN(a2) ? 1 : clamp(a2, 0, 1);
      return c;
    }
    if ((m = /^color\(srgb\s+([^)]+)\)$/.exec(s))) {
      var w = m[1].split(/[\s\/]+/).filter(Boolean).map(function (v) { return num(v, 1); });
      if (w.length < 3 || w.slice(0, 3).some(isNaN)) return null;
      return { r: w[0] * 255, g: w[1] * 255, b: w[2] * 255, a: w[3] === undefined || isNaN(w[3]) ? 1 : clamp(w[3], 0, 1) };
    }
    return null;
  }
  /** "#rrggbb" (alpha dropped), "transparent" for a fully transparent colour, null for anything that isn't a colour. */
  function normalizeColor(s) {
    var c = parseColor(s);
    if (!c) return null;
    if (c.a === 0) return "transparent";
    return toHex(c);
  }
  function luminance(hex) {
    var c = parseColor(hex);
    if (!c) return 0;
    function lin(v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
    return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  }
  /** WCAG 2 contrast ratio of two opaque colours, two decimals (21 for black on white). */
  function contrastRatio(a, b) {
    var la = luminance(a), lb = luminance(b);
    var hi = Math.max(la, lb), lo = Math.min(la, lb);
    return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
  }
  /** `fg` (with alpha) composited over the opaque `bg`. */
  function blend(fg, bg) {
    var a = fg.a === undefined ? 1 : fg.a;
    return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a), a: 1 };
  }
  /** The effective background of layers listed from the element outwards (white when nothing is opaque) → "#rrggbb". */
  function effectiveBackground(layers) {
    var cs = (layers || []).map(parseColor);
    var base = { r: 255, g: 255, b: 255, a: 1 }, from = cs.length;
    for (var i = 0; i < cs.length; i++) if (cs[i] && cs[i].a >= 1) { base = cs[i]; from = i; break; }
    var out = base;
    for (var j = from - 1; j >= 0; j--) if (cs[j] && cs[j].a > 0) out = blend(cs[j], out);
    return toHex(out);
  }
  function isLargeText(sizePx, weight) { return sizePx >= 24 || (sizePx >= 18.66 && Number(weight) >= 700); }
  function threshold(level, large) { return level === "AAA" ? (large ? 4.5 : 7) : (large ? 3 : 4.5); }
  function hslHex(h, s, l) { return toHex(hslToRgb(h, s / 100, l / 100)); }
  function hslOf(hex) { return rgbToHsl(parseColor(hex) || { r: 0, g: 0, b: 0 }); }

  // ── Page side ────────────────────────────────────────────────────────────

  // Walk the visible elements of the top frame (sampled evenly when there are more than `maxEls`) and
  // count: text colours (elements with their own text), background colours, border colours — each with
  // the selectors that use them most — font families with size/weight pairs, margins and paddings
  // rounded to 4px; plus the theme-color meta, the colour-looking custom properties on :root, and the
  // body / link / button colours. Raw computed strings: the panel normalises them.
  function pageExtractPalette(maxEls) {
    var all = document.body ? [document.body].concat(Array.prototype.slice.call(document.body.querySelectorAll("*"))) : [];
    var total = all.length;
    var SKIP = /^(script|style|noscript|template|svg|path|g|use|meta|link|head|br|wbr|title|iframe|object|embed)$/;
    var BG_TAGS = /^(body|main|header|footer|nav|aside|section|article|form|table|thead|tbody|tr|td|th|ul|ol|li|dl|p|h[1-6]|blockquote|pre|code|figure|details|summary|dialog|fieldset|label)$/;
    var TEXT_TAGS = /^(body|main|article|section|p|li|h[1-6]|td|th|dd|dt|label|blockquote|figcaption|small|strong|em|b|i|code|pre|summary|legend|caption|time|address)$/;
    var INTERACTIVE = /^(a|button|input|select|textarea|summary|option)$/; // links and buttons get rules of their own in a theme
    var counts = { text: {}, bg: {}, border: {}, spacing: {} };
    var sels = { text: {}, bg: {} };
    var fonts = {};
    function bump(map, k) { if (k) map[k] = (map[k] || 0) + 1; }
    function bumpSel(map, colour, sel) { if (!sel) return; var m = map[colour] || (map[colour] = {}); m[sel] = (m[sel] || 0) + 1; }
    function saneId(id) { return !!id && /^[A-Za-z][\w-]{0,40}$/.test(id) && !/\d{3,}|^(ember|react|radix|headlessui|mui|yui|ext|__)/i.test(id); }
    function stableClass(c) {
      if (!/^[a-zA-Z][\w-]{0,40}$/.test(c) || /^(css|sc|jsx|emotion|_)-/.test(c)) return false;
      return !c.split(/[-_]/).some(function (seg) { return seg.length >= 5 && /\d/.test(seg) && /[a-zA-Z]/.test(seg); });
    }
    function selectorOf(el, tagsOk) {
      if (INTERACTIVE.test(el.localName) || el.getAttribute("role") === "button") return "";
      if (saneId(el.id)) return "#" + el.id;
      var cls = Array.prototype.filter.call(el.classList, stableClass).slice(0, 2);
      if (cls.length) return el.localName + "." + cls.join(".");
      return tagsOk.test(el.localName) ? el.localName : "";
    }
    function opaque(c) { return c && c !== "rgba(0, 0, 0, 0)" && c !== "transparent" && !/^rgba\(.*,\s*0\)$/.test(c); }
    var step = total > maxEls ? total / maxEls : 1, sampled = 0;
    for (var i = 0; i < total; i += step) {
      var el = all[Math.floor(i)];
      if (!el || SKIP.test(el.localName)) continue;
      var rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) continue;
      var cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none" || parseFloat(cs.opacity) === 0) continue;
      sampled++;
      var hasText = false;
      for (var c = el.firstChild; c; c = c.nextSibling) if (c.nodeType === 3 && c.nodeValue.trim()) { hasText = true; break; }
      if (hasText) {
        bump(counts.text, cs.color);
        bumpSel(sels.text, cs.color, selectorOf(el, TEXT_TAGS));
        var fam = (cs.fontFamily.split(",")[0] || "").trim().replace(/^["']|["']$/g, "");
        if (fam) {
          var f = fonts[fam] || (fonts[fam] = { n: 0, sizes: {}, stack: cs.fontFamily.slice(0, 120) });
          f.n++;
          var sw = Math.round(parseFloat(cs.fontSize)) + "/" + cs.fontWeight;
          f.sizes[sw] = (f.sizes[sw] || 0) + 1;
        }
      }
      if (opaque(cs.backgroundColor)) {
        bump(counts.bg, cs.backgroundColor);
        bumpSel(sels.bg, cs.backgroundColor, selectorOf(el, BG_TAGS));
      }
      var seenB = {};
      ["Top", "Right", "Bottom", "Left"].forEach(function (side) {
        if (parseFloat(cs["border" + side + "Width"]) > 0 && cs["border" + side + "Style"] !== "none") { var bc = cs["border" + side + "Color"]; if (opaque(bc) && !seenB[bc]) { seenB[bc] = 1; bump(counts.border, bc); } }
      });
      ["marginTop", "marginRight", "marginBottom", "marginLeft", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft"].forEach(function (p) {
        var v = Math.round(parseFloat(cs[p]) / 4) * 4;
        if (v > 0 && v <= 200) bump(counts.spacing, String(v));
      });
    }
    function top(map, n) { return Object.keys(map).sort(function (a, b) { return map[b] - map[a]; }).slice(0, n).map(function (k) { return { v: k, n: map[k] }; }); }
    function withSels(list, selMap) { return list.map(function (e) { var m = selMap[e.v] || {}; e.sels = Object.keys(m).sort(function (a, b) { return m[b] - m[a]; }).slice(0, 8).map(function (s) { return { s: s, n: m[s] }; }); return e; }); }
    var fontList = Object.keys(fonts).sort(function (a, b) { return fonts[b].n - fonts[a].n; }).slice(0, 12).map(function (fam) {
      var f = fonts[fam];
      return { family: fam, stack: f.stack, n: f.n, sizes: top(f.sizes, 14) };
    });
    // Custom properties on :root that look like colours (declared values; resolved through the computed style when possible).
    var vars = [], seenVar = {};
    var rootCs = getComputedStyle(document.documentElement);
    var LOOKS = /^(#[0-9a-f]{3,8}|rgba?\(|hsla?\(|color\()/i;
    function takeVar(style) {
      for (var k = 0; k < style.length && vars.length < 40; k++) {
        var name = style[k];
        if (name.indexOf("--") !== 0 || seenVar[name]) continue;
        var val = (rootCs.getPropertyValue(name) || style.getPropertyValue(name) || "").trim();
        if (LOOKS.test(val)) { seenVar[name] = 1; vars.push({ name: name, value: val.slice(0, 60) }); }
      }
    }
    for (var s = 0; s < document.styleSheets.length && vars.length < 40; s++) {
      var rules;
      try { rules = document.styleSheets[s].cssRules; } catch (_) { continue; }
      if (!rules) continue;
      for (var r = 0; r < rules.length && vars.length < 40; r++) {
        var rule = rules[r];
        if (typeof rule.selectorText === "string" && /^(:root|html)(\s*,\s*(:root|html))*$/.test(rule.selectorText.trim()) && rule.style) takeVar(rule.style);
      }
    }
    takeVar(document.documentElement.style);
    var meta = document.querySelector('meta[name="theme-color"]');
    var bodyCs = document.body ? getComputedStyle(document.body) : rootCs;
    var bodyBg = opaque(bodyCs.backgroundColor) ? bodyCs.backgroundColor : rootCs.backgroundColor;
    var link = null, links = document.querySelectorAll("a[href]");
    for (var li = 0; li < links.length && li < 40; li++) { var lr = links[li].getBoundingClientRect(); if (lr.width > 0 && lr.height > 0) { link = getComputedStyle(links[li]).color; break; } }
    var button = null, btns = document.querySelectorAll("button, [role=button], input[type=submit], input[type=button], a.btn, a.button, .btn, .button");
    for (var bi = 0; bi < btns.length && bi < 40; bi++) { var br = btns[bi].getBoundingClientRect(); if (br.width < 1 || br.height < 1) continue; var bcs = getComputedStyle(btns[bi]); if (opaque(bcs.backgroundColor)) { button = { bg: bcs.backgroundColor, color: bcs.color }; break; } }
    return {
      url: location.href, title: document.title, total: total, sampled: sampled,
      text: withSels(top(counts.text, 30), sels.text), bg: withSels(top(counts.bg, 30), sels.bg), border: top(counts.border, 15),
      fonts: fontList, spacing: top(counts.spacing, 16),
      themeColor: meta ? meta.getAttribute("content") : "", vars: vars,
      body: { bg: bodyBg, color: bodyCs.color }, link: link, button: button,
    };
  }

  // Every visible text style of the top frame (or inside `scope`): the text colour, the background layers
  // from the element outwards up to the first opaque one, the font size/weight, a snippet, a selector and
  // how many elements share the style. The panel does the contrast maths.
  function pageContrast(maxEls, scope) {
    var roots = [];
    if (scope) {
      try { roots = Array.prototype.slice.call(document.querySelectorAll(scope)); } catch (e) { return { error: "\"" + scope + "\" is not a valid CSS selector." }; }
      if (!roots.length) return { error: "No element matches \"" + scope + "\" on this page." };
    } else if (document.body) roots = [document.body];
    var els = [];
    roots.forEach(function (r) { els.push(r); els = els.concat(Array.prototype.slice.call(r.querySelectorAll("*"))); });
    var total = els.length;
    var SKIP = /^(script|style|noscript|template|svg|path|g|use|meta|link|head|br|wbr|title|iframe|object|embed|option)$/;
    function saneId(id) { return !!id && /^[A-Za-z][\w-]{0,40}$/.test(id) && !/\d{3,}|^(ember|react|radix|headlessui|mui|yui|ext|__)/i.test(id); }
    function stableClass(c) {
      if (!/^[a-zA-Z][\w-]{0,40}$/.test(c) || /^(css|sc|jsx|emotion|_)-/.test(c)) return false;
      return !c.split(/[-_]/).some(function (seg) { return seg.length >= 5 && /\d/.test(seg) && /[a-zA-Z]/.test(seg); });
    }
    function selectorOf(el) {
      if (saneId(el.id)) return "#" + el.id;
      var cls = Array.prototype.filter.call(el.classList, stableClass).slice(0, 2);
      var own = cls.length ? el.localName + "." + cls.join(".") : el.localName;
      var p = el.parentElement;
      if (p && p !== document.body && p !== document.documentElement) {
        var pc = Array.prototype.filter.call(p.classList, stableClass).slice(0, 1);
        return (saneId(p.id) ? "#" + p.id : p.localName + (pc.length ? "." + pc[0] : "")) + " > " + own;
      }
      return own;
    }
    function isOpaque(c) { return /^rgb\(/.test(c) || /^rgba\(.*,\s*1\)$/.test(c); }
    var styles = {}, unique = 0, checked = 0;
    var step = total > maxEls ? total / maxEls : 1;
    for (var i = 0; i < total && unique < 500; i += step) {
      var el = els[Math.floor(i)];
      if (!el || SKIP.test(el.localName)) continue;
      var hasText = false, snippet = "";
      for (var c = el.firstChild; c; c = c.nextSibling) if (c.nodeType === 3 && c.nodeValue.trim()) { hasText = true; snippet += c.nodeValue; if (snippet.length > 80) break; }
      if (!hasText) continue;
      var rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) continue;
      var cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none" || parseFloat(cs.opacity) === 0 || parseFloat(cs.fontSize) < 2) continue;
      checked++;
      var layers = [], image = false, n = el, depth = 0;
      while (n && n.nodeType === 1 && depth < 14) {
        var ncs = n === el ? cs : getComputedStyle(n);
        var bc = ncs.backgroundColor;
        if (ncs.backgroundImage && ncs.backgroundImage !== "none") image = true;
        layers.push(bc);
        if (isOpaque(bc)) break;
        n = n.parentElement; depth++;
      }
      var weight = parseInt(cs.fontWeight, 10) || (cs.fontWeight === "bold" ? 700 : 400);
      var size = Math.round(parseFloat(cs.fontSize) * 10) / 10;
      var key = cs.color + "|" + layers.join(">") + "|" + size + "|" + weight + "|" + image;
      var st = styles[key];
      if (!st) { unique++; st = styles[key] = { fg: cs.color, layers: layers, size: size, weight: weight, image: image, text: snippet.replace(/\s+/g, " ").trim().slice(0, 80), selector: selectorOf(el), n: 0 }; }
      st.n++;
    }
    return { url: location.href, total: total, checked: checked, styles: Object.keys(styles).map(function (k) { return styles[k]; }) };
  }

  // The page's design tokens: every custom property declared in a readable stylesheet rule (cross-origin
  // sheets throw on cssRules and are counted as unreadable) or in the style attribute of <html> / <body>,
  // with the declared value (the :root / html / body declaration preferred), where it is declared, how many
  // rules declare it and how many var(--name) uses the readable rules make of it; the value resolved on
  // :root (then body) where it resolves. Tokens only used (declared in an unreadable sheet) are listed too.
  function pageTokens(maxTokens) {
    var decl = {}, order = [], uses = {}, sheets = 0, readable = 0, unreadable = 0, rules = 0, totalUses = 0;
    var ROOTISH = /^(:root|html|body)(\s*,\s*(:root|html|body))*$/;
    var VAR_RE = /var\(\s*(--[\w-]+)/g;
    function sheetName(sheet) {
      if (!sheet.href) { var o = sheet.ownerNode; return o && o.hasAttribute && o.hasAttribute("data-agent-styles") ? "your override" : "inline <style>"; }
      try { var u = new URL(sheet.href); var f = u.pathname.split("/").pop() || u.host; return f.length > 40 ? f.slice(0, 37) + "…" : f; } catch (_) { return sheet.href.slice(0, 40); }
    }
    function take(style, selector, sheet) {
      var rootish = ROOTISH.test(selector.trim());
      for (var k = 0; k < style.length; k++) {
        var name = style[k];
        if (name.indexOf("--") !== 0) continue;
        var d = decl[name];
        if (!d) { if (order.length >= maxTokens) continue; d = decl[name] = { value: "", selector: "", sheet: "", root: false, decls: 0 }; order.push(name); }
        d.decls++;
        if ((rootish && !d.root) || !d.selector) { d.value = (style.getPropertyValue(name) || "").trim().slice(0, 200); d.selector = selector; d.sheet = sheet; d.root = rootish; }
      }
      var txt = "", m;
      try { txt = style.cssText || ""; } catch (_) {}
      VAR_RE.lastIndex = 0;
      while ((m = VAR_RE.exec(txt))) { uses[m[1]] = (uses[m[1]] || 0) + 1; totalUses++; }
    }
    function walk(list, sheet, depth) {
      for (var i = 0; i < list.length; i++) {
        var r = list[i];
        if (r.style && typeof r.selectorText === "string") { rules++; take(r.style, r.selectorText, sheet); }
        else if (r.cssRules && depth < 6) walk(r.cssRules, sheet, depth + 1); // @media, @supports, @layer, @container
      }
    }
    for (var s = 0; s < document.styleSheets.length; s++) {
      var sh = document.styleSheets[s];
      sheets++;
      if (sh.disabled) continue;
      var list;
      try { list = sh.cssRules; } catch (_) { unreadable++; continue; }
      if (!list) { unreadable++; continue; }
      readable++;
      walk(list, sheetName(sh), 0);
    }
    if (document.documentElement.style) take(document.documentElement.style, "html (style attribute)", "inline");
    if (document.body && document.body.style) take(document.body.style, "body (style attribute)", "inline");
    var rootCs = getComputedStyle(document.documentElement), bodyCs = document.body ? getComputedStyle(document.body) : null;
    function resolved(name) { return ((rootCs.getPropertyValue(name) || (bodyCs ? bodyCs.getPropertyValue(name) : "")) || "").trim().slice(0, 200); }
    var tokens = order.map(function (name) {
      var d = decl[name];
      return { name: name, declared: d.value, value: resolved(name), selector: d.selector.length > 80 ? d.selector.slice(0, 77) + "…" : d.selector, sheet: d.sheet, root: d.root, decls: d.decls, uses: uses[name] || 0 };
    });
    Object.keys(uses).forEach(function (name) { if (!decl[name] && tokens.length < maxTokens) tokens.push({ name: name, declared: "", value: resolved(name), selector: "", sheet: "", root: false, decls: 0, uses: uses[name] }); });
    return { url: location.href, tokens: tokens, sheets: sheets, readable: readable, unreadable: unreadable, rules: rules, totalUses: totalUses };
  }

  // The visible elements of the top frame (sampled evenly when there are more than `maxEls`) whose text
  // colour (elements with their own text), background colour and/or border colour lie within `tolerance`
  // of `from` ({ r, g, b }; the distance is sqrt of the summed squared channel differences on a 0–100
  // scale, 100 = black vs white), grouped under minimal selectors: an id, or the tag with its stable
  // classes, a semantic bare tag, else the parent's classes + tag. The panel writes the override.
  function pageRecolor(maxEls, from, tolerance, props, maxSelectors) {
    var all = document.body ? [document.documentElement, document.body].concat(Array.prototype.slice.call(document.body.querySelectorAll("*"))) : [];
    var total = all.length;
    var SKIP = /^(script|style|noscript|template|svg|path|g|use|meta|link|head|br|wbr|title|iframe|object|embed|option)$/;
    var BARE = /^(html|body|main|header|footer|nav|aside|section|article|h[1-6]|p|li|a|button|label|td|th|input|select|textarea|blockquote|pre|code|small|strong|em|figcaption|summary|legend|caption|hr)$/;
    function saneId(id) { return !!id && /^[A-Za-z][\w-]{0,40}$/.test(id) && !/\d{3,}|^(ember|react|radix|headlessui|mui|yui|ext|__)/i.test(id); }
    function stableClass(c) {
      if (!/^[a-zA-Z][\w-]{0,40}$/.test(c) || /^(css|sc|jsx|emotion|_)-/.test(c)) return false;
      return !c.split(/[-_]/).some(function (seg) { return seg.length >= 5 && /\d/.test(seg) && /[a-zA-Z]/.test(seg); });
    }
    function esc(s) { return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/([^\w-])/g, "\\$1"); }
    function own(el) { var cls = Array.prototype.filter.call(el.classList, stableClass).map(esc).slice(0, 3); return cls.length ? el.localName + "." + cls.join(".") : ""; }
    function selectorOf(el) {
      if (saneId(el.id)) return "#" + esc(el.id);
      var o = own(el);
      if (o) return o;
      if (BARE.test(el.localName)) return el.localName;
      var p = el.parentElement;
      if (p) { var po = saneId(p.id) ? "#" + esc(p.id) : own(p); if (po) return po + " > " + el.localName; }
      return "";
    }
    function parse(c) {
      var m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(c || "");
      if (!m || (m[4] !== undefined && parseFloat(m[4]) <= 0)) return null;
      return { r: +m[1], g: +m[2], b: +m[3] };
    }
    function hex(c) { return "#" + [c.r, c.g, c.b].map(function (v) { var h = Math.min(255, v).toString(16); return h.length < 2 ? "0" + h : h; }).join(""); }
    function dist(c) { var dr = c.r - from.r, dg = c.g - from.g, db = c.b - from.b; return Math.sqrt(dr * dr + dg * dg + db * db) * 100 / 441.673; }
    var want = {};
    (props || []).forEach(function (p) { want[p] = true; });
    var bySel = {}, order = [], elements = 0, unselectable = 0, shades = {}, closest = null, scanned = 0;
    function check(c) {
      if (!c) return false;
      var d = dist(c);
      if (!closest || d < closest.distance) closest = { hex: hex(c), distance: Math.round(d * 10) / 10 };
      return d <= tolerance;
    }
    var step = total > maxEls ? total / maxEls : 1;
    for (var i = 0; i < total; i += step) {
      var el = all[Math.floor(i)];
      if (!el || SKIP.test(el.localName)) continue;
      var rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) continue;
      var cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none") continue;
      scanned++;
      var hits = [];
      if (want.color) {
        var hasText = false;
        for (var c = el.firstChild; c; c = c.nextSibling) if (c.nodeType === 3 && c.nodeValue.trim()) { hasText = true; break; }
        var tc = hasText ? parse(cs.color) : null;
        if (tc && check(tc)) hits.push(["color", hex(tc)]);
      }
      if (want.background) { var bc = parse(cs.backgroundColor); if (bc && check(bc)) hits.push(["background", hex(bc)]); }
      if (want.border) {
        var seen = {};
        for (var k = 0; k < 4; k++) {
          var side = ["Top", "Right", "Bottom", "Left"][k];
          if (!(parseFloat(cs["border" + side + "Width"]) > 0) || cs["border" + side + "Style"] === "none") continue;
          var v = cs["border" + side + "Color"];
          if (seen[v]) continue;
          seen[v] = 1;
          var rc = parse(v);
          if (rc && check(rc)) { hits.push(["border", hex(rc)]); break; }
        }
      }
      if (!hits.length) continue;
      elements++;
      hits.forEach(function (h) { shades[h[1]] = (shades[h[1]] || 0) + 1; });
      var sel = selectorOf(el);
      if (!sel) { unselectable++; continue; }
      var e = bySel[sel];
      if (!e) { e = bySel[sel] = { selector: sel, props: {}, n: 0 }; order.push(sel); }
      e.n++;
      hits.forEach(function (h) { e.props[h[0]] = 1; });
    }
    var list = order.map(function (s) { return bySel[s]; }).sort(function (a, b) { return b.n - a.n; });
    var truncated = Math.max(0, list.length - maxSelectors);
    list = list.slice(0, maxSelectors).map(function (e) { return { selector: e.selector, props: ["color", "background", "border"].filter(function (p) { return e.props[p]; }), n: e.n }; });
    return { url: location.href, total: total, scanned: scanned, elements: elements, unselectable: unselectable, shades: shades, selectors: list, truncated: truncated, closest: closest };
  }

  // The pixels of an image on the page: the element behind a ref (window.__agentRefs[local - 1]), a
  // selector, or — by default — the largest visible <img> or element with a background-image. It is
  // drawn on a canvas at most `maxSide` px on the long side and read back; a cross-origin image taints
  // the canvas (getImageData throws a SecurityError), in which case the image is loaded again with
  // crossOrigin="anonymous" (works when its server sends CORS headers) — otherwise { unreadable, reason }.
  // Returns a flat [r, g, b, …] array of the opaque pixels, the sizes and the page background.
  async function pageImagePixels(local, selector, maxSide, maxScan) {
    function visible(el) { var r = el.getBoundingClientRect(); return r.width >= 2 && r.height >= 2 ? r : null; }
    function bgUrl(el) { var m = /url\(\s*["']?([^"')]+)["']?\s*\)/.exec(getComputedStyle(el).backgroundImage || ""); return m ? m[1] : ""; }
    var el = null, how = "";
    if (local) {
      el = (window.__agentRefs || [])[local - 1];
      if (!el || !el.isConnected) return { error: "stale" };
      how = "ref";
    } else if (selector) {
      try { el = document.querySelector(selector); } catch (e) { return { error: "\"" + selector + "\" is not a valid CSS selector: " + String((e && e.message) || e).replace(/^Failed to execute 'querySelector' on 'Document':\s*/, "") }; }
      if (!el) return { error: "No element matches \"" + selector + "\" on this page (top frame). Check the selector with browser_read_page, or pass a ref." };
      how = "selector";
    } else {
      var best = null, bestArea = 0, imgs = document.images;
      for (var i = 0; i < imgs.length; i++) { var r = visible(imgs[i]); if (r && imgs[i].complete && imgs[i].naturalWidth > 0 && r.width * r.height > bestArea) { best = imgs[i]; bestArea = r.width * r.height; } }
      var els = document.body ? document.body.querySelectorAll("*") : [];
      for (var j = 0; j < els.length && j < maxScan; j++) { var e2 = els[j]; if (e2.localName === "img") continue; var r2 = visible(e2); if (!r2 || r2.width * r2.height <= bestArea) continue; if (bgUrl(e2)) { best = e2; bestArea = r2.width * r2.height; } }
      if (!best) return { error: "No visible image on this page (no loaded <img> and no element with a background-image) — pass a ref or a selector." };
      el = best; how = "largest";
    }
    if (el.localName === "picture") el = el.querySelector("img") || el;
    var src = "", source = null, kind = el.localName;
    if (el.localName === "img") { src = el.currentSrc || el.src || ""; source = el; }
    else if (el.localName === "canvas" || el.localName === "video") { src = el.currentSrc || el.src || ""; source = el; }
    else { src = bgUrl(el); if (!src) return { error: "<" + el.localName + "> is not an image and has no background-image — pass an <img> or an element with one." }; kind = "background"; }
    var rect = el.getBoundingClientRect();
    var origin = "";
    try { origin = new URL(src, location.href).origin; } catch (_) {}
    var info = { tag: el.localName, kind: kind, src: src.slice(0, 300), alt: (el.getAttribute("alt") || el.getAttribute("aria-label") || "").slice(0, 120), shown: { width: Math.round(rect.width), height: Math.round(rect.height) }, how: how, crossOrigin: !!origin && origin !== location.origin && !/^data:|^blob:/.test(src) };
    function load(url) { return new Promise(function (resolve, reject) { var im = new Image(); im.crossOrigin = "anonymous"; im.onload = function () { resolve(im); }; im.onerror = function () { reject(new Error("the image could not be loaded with CORS")); }; im.src = url; }); }
    function pixelsOf(img) {
      var w = img.naturalWidth || img.videoWidth || img.width, h = img.naturalHeight || img.videoHeight || img.height;
      if (!w || !h) throw new Error("the image has no size yet (not loaded)");
      var scale = Math.min(1, maxSide / Math.max(w, h));
      var cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
      var canvas = document.createElement("canvas");
      canvas.width = cw; canvas.height = ch;
      var ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, cw, ch);
      var data = ctx.getImageData(0, 0, cw, ch).data; // SecurityError when the canvas is tainted
      var px = [], skipped = 0;
      for (var p = 0; p < data.length; p += 4) { if (data[p + 3] < 128) { skipped++; continue; } px.push(data[p], data[p + 1], data[p + 2]); }
      return { pixels: px, natural: { width: w, height: h }, sampled: { width: cw, height: ch }, transparent: skipped };
    }
    var result = null, tainted = false, loadError = "";
    if (source && (source.localName !== "img" || (source.complete && source.naturalWidth > 0))) {
      try { result = pixelsOf(source); } catch (e) { if (e && e.name === "SecurityError") tainted = true; else loadError = String((e && e.message) || e); }
    }
    if (!result && src && !/^blob:/.test(src)) {
      try { result = pixelsOf(await load(src)); } catch (e) { if (e && e.name === "SecurityError") tainted = true; else loadError = loadError || String((e && e.message) || e); }
    }
    var bodyCs = document.body ? getComputedStyle(document.body) : null;
    var bg = bodyCs && bodyCs.backgroundColor && bodyCs.backgroundColor !== "rgba(0, 0, 0, 0)" ? bodyCs.backgroundColor : getComputedStyle(document.documentElement).backgroundColor;
    info.pageBg = bg;
    if (!result) { info.unreadable = true; info.reason = tainted ? "tainted" : info.crossOrigin && /CORS/.test(loadError) ? "cors" : "load"; info.loadError = loadError; return info; }
    info.pixels = result.pixels; info.natural = result.natural; info.sampled = result.sampled; info.transparent = result.transparent;
    return info;
  }

  // ── The summary (pure) ───────────────────────────────────────────────────

  /** Merge a raw colour count list by normalised hex → [{ hex, n, selectors }] sorted by count. */
  function mergeColours(list) {
    var by = {};
    (list || []).forEach(function (e) {
      var hex = normalizeColor(e.v);
      if (!hex || hex === "transparent") return;
      var o = by[hex] || (by[hex] = { hex: hex, n: 0, sel: {} });
      o.n += e.n;
      (e.sels || []).forEach(function (s) { o.sel[s.s] = (o.sel[s.s] || 0) + s.n; });
    });
    return Object.keys(by).map(function (hex) {
      var o = by[hex];
      return { hex: hex, n: o.n, selectors: Object.keys(o.sel).sort(function (a, b) { return o.sel[b] - o.sel[a]; }).slice(0, 6) };
    }).sort(function (a, b) { return b.n - a.n; });
  }
  /** The palette summary the report, the CSS variables and the themes are built from. */
  function summarizePalette(raw) {
    raw = raw || {};
    var fonts = (raw.fonts || []).map(function (f) {
      var sizes = (f.sizes || []).map(function (s) { var p = String(s.v).split("/"); return { size: Number(p[0]), weight: Number(p[1]) || 400, n: s.n }; }).sort(function (a, b) { return b.n - a.n; });
      return { family: f.family, stack: f.stack || f.family, n: f.n, sizes: sizes };
    });
    var scale = {};
    fonts.forEach(function (f) { f.sizes.forEach(function (s) { if (s.size > 0) scale[s.size] = (scale[s.size] || 0) + s.n; }); });
    var vars = (raw.vars || []).map(function (v) { return { name: v.name, value: v.value, hex: normalizeColor(v.value) }; }).filter(function (v) { return v.hex && v.hex !== "transparent"; });
    var btn = raw.button && normalizeColor(raw.button.bg) && normalizeColor(raw.button.bg) !== "transparent" ? { bg: normalizeColor(raw.button.bg), color: normalizeColor(raw.button.color) || "#ffffff" } : null;
    var bodyBg = raw.body ? normalizeColor(raw.body.bg) : null;
    return {
      url: raw.url || "", title: raw.title || "", total: raw.total || 0, sampled: raw.sampled || 0,
      text: mergeColours(raw.text), bg: mergeColours(raw.bg), border: mergeColours(raw.border),
      fonts: fonts,
      scale: Object.keys(scale).map(Number).sort(function (a, b) { return a - b; }),
      spacing: (raw.spacing || []).map(function (s) { return { px: Number(s.v), n: s.n }; }).filter(function (s) { return s.px > 0; }),
      themeColor: raw.themeColor ? normalizeColor(raw.themeColor) : null,
      vars: vars,
      body: { bg: bodyBg && bodyBg !== "transparent" ? bodyBg : "#ffffff", color: (raw.body && normalizeColor(raw.body.color)) || "#000000" },
      link: raw.link ? normalizeColor(raw.link) : null,
      button: btn,
    };
  }
  function hostOfUrl(u) { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (_) { return ""; } }
  function fmtN(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " "); }

  /** The readable browser_palette_extract report. */
  function formatPalette(p) {
    var lines = ["Palette of " + (hostOfUrl(p.url) || "this page") + " (" + fmtN(p.sampled) + " of " + fmtN(p.total) + " elements sampled):"];
    function block(title, list, n) {
      if (!list.length) return;
      lines.push("", title + ":");
      list.slice(0, n).forEach(function (c) { lines.push("  " + c.hex + "  ×" + fmtN(c.n) + (c.selectors && c.selectors.length ? "  (" + c.selectors.slice(0, 4).join(", ") + ")" : "")); });
      if (list.length > n) lines.push("  … " + (list.length - n) + " more");
    }
    block("Text colours", p.text, 10);
    block("Backgrounds", p.bg, 10);
    block("Borders", p.border, 6);
    if (p.fonts.length) {
      lines.push("", "Fonts:");
      p.fonts.slice(0, 6).forEach(function (f) {
        var sizes = f.sizes.slice(0, 8).map(function (s) { return s.size + "px/" + s.weight + " ×" + fmtN(s.n); }).join(", ");
        lines.push("  " + f.family + " — " + fmtN(f.n) + " text element" + (f.n === 1 ? "" : "s") + (sizes ? "; " + sizes : ""));
      });
      if (p.scale.length) lines.push("  Type scale: " + p.scale.join(", ") + " px");
    }
    if (p.spacing.length) lines.push("", "Spacing (margins/paddings rounded to 4px): " + p.spacing.slice(0, 8).map(function (s) { return s.px + "px ×" + fmtN(s.n); }).join(", "));
    lines.push("", "Body: " + p.body.bg + " background, " + p.body.color + " text" + (p.link ? "; links " + p.link : "") + (p.button ? "; buttons " + p.button.color + " on " + p.button.bg : "") + (p.themeColor ? "; theme-color " + p.themeColor : ""));
    if (p.vars.length) lines.push("CSS variables on :root: " + p.vars.slice(0, 12).map(function (v) { return v.name + ": " + v.hex; }).join(", ") + (p.vars.length > 12 ? " … " + (p.vars.length - 12) + " more" : ""));
    return lines.join("\n");
  }
  /** The palette as a :root block of CSS variables (--c1… by count: text, backgrounds, borders; --font-1…). */
  function cssVariables(p) {
    var lines = [":root {"];
    var i = 0, seen = {};
    [["text", p.text], ["background", p.bg], ["border", p.border]].forEach(function (g) {
      g[1].slice(0, 8).forEach(function (c) {
        if (seen[c.hex]) return;
        seen[c.hex] = 1; i++;
        lines.push("  --c" + i + ": " + c.hex + "; /* " + g[0] + ", ×" + fmtN(c.n) + " */");
      });
    });
    if (p.link && !seen[p.link]) lines.push("  --link: " + p.link + ";");
    if (p.button) lines.push("  --button-bg: " + p.button.bg + ";", "  --button-text: " + p.button.color + ";");
    if (p.themeColor) lines.push("  --theme-color: " + p.themeColor + ";");
    p.fonts.slice(0, 4).forEach(function (f, k) { lines.push("  --font-" + (k + 1) + ": " + f.stack + ";"); });
    if (p.scale.length) lines.push("  /* type scale: " + p.scale.join(", ") + " px */");
    lines.push("}");
    return lines.join("\n");
  }

  // ── Contrast (pure) ──────────────────────────────────────────────────────

  /** The checked styles with ratios: { level, checked, styles: [...], failures, passes, aaa, approx }. */
  function evaluateContrast(raw, level) {
    level = level === "AAA" ? "AAA" : "AA";
    var styles = (raw && raw.styles ? raw.styles : []).map(function (s) {
      var bg = effectiveBackground(s.layers);
      var fgc = parseColor(s.fg) || { r: 0, g: 0, b: 0, a: 1 };
      var fg = toHex(fgc.a < 1 ? blend(fgc, parseColor(bg)) : fgc);
      var large = isLargeText(s.size, s.weight);
      var ratio = contrastRatio(fg, bg);
      return { text: s.text, selector: s.selector, n: s.n, fg: fg, bg: bg, size: s.size, weight: s.weight, large: large, image: !!s.image, ratio: ratio, need: threshold(level, large), pass: ratio >= threshold(level, large), aaa: ratio >= threshold("AAA", large) };
    });
    var failures = styles.filter(function (s) { return !s.pass; }).sort(function (a, b) { return a.ratio - b.ratio; });
    return { level: level, checked: raw && raw.checked || 0, total: raw && raw.total || 0, styles: styles, failures: failures, passes: styles.length - failures.length, aaa: styles.filter(function (s) { return s.aaa; }).length, approx: styles.filter(function (s) { return s.image; }).length };
  }
  function formatContrast(r, url) {
    var head = "Contrast on " + (hostOfUrl(url) || "this page") + " (WCAG 2 " + r.level + "; " + r.styles.length + " text style" + (r.styles.length === 1 ? "" : "s") + " across " + fmtN(r.checked) + " text elements): ";
    if (!r.styles.length) return head + "no visible text found.";
    if (!r.failures.length) return head + "every style passes " + r.level + " (" + r.aaa + " of " + r.styles.length + " also pass AAA)." + (r.approx ? " " + r.approx + " sit on a background image or gradient — their ratio is approximate." : "");
    var lines = [head + r.failures.length + " fail, " + r.passes + " pass (" + r.aaa + " also AAA).", "", "Failures (needs " + threshold(r.level, false) + ":1 for normal text, " + threshold(r.level, true) + ":1 for large text — 24px, or 18.66px bold):"];
    r.failures.slice(0, 25).forEach(function (f, i) {
      lines.push("  " + (i + 1) + ". " + f.ratio.toFixed(2) + ":1 (needs " + f.need + ")  " + f.fg + " on " + f.bg + ", " + f.size + "px/" + f.weight + (f.large ? " large" : "") + (f.image ? ", over an image (approximate)" : "") + " — " + f.selector + (f.n > 1 ? " ×" + f.n : "") + '  "' + f.text + '"');
    });
    if (r.failures.length > 25) lines.push("  … " + (r.failures.length - 25) + " more");
    lines.push("", "Fix: a browser_style_apply rule on the selector, e.g. `" + r.failures[0].selector + " { color: " + suggestText(r.failures[0].bg, r.failures[0].fg, r.failures[0].need) + "; }`, then check again.");
    return lines.join("\n");
  }
  /** A text colour of the same hue that reaches `need` on `bg` (darker on light, lighter on dark). */
  function suggestText(bg, fg, need) {
    var hsl = hslOf(fg), dark = luminance(bg) < 0.4;
    for (var step = 0; step <= 20; step++) {
      var l = dark ? Math.min(100, hsl.l + step * 5) : Math.max(0, hsl.l - step * 5);
      var hex = hslHex(hsl.h, hsl.s, l);
      if (contrastRatio(hex, bg) >= need) return hex;
    }
    return dark ? "#ffffff" : "#000000";
  }

  // ── Themes (pure) ────────────────────────────────────────────────────────

  var MODES = { dark: "Dark", sepia: "Sepia", "high-contrast": "High contrast", custom: "Custom" };
  var TOKEN_NAMES = ["bg", "surface", "text", "muted", "link", "accent", "accentText", "border"];
  function grey(hsl) { return hsl.s < 20; }
  function readableOn(bg) { return contrastRatio(bg, "#ffffff") >= contrastRatio(bg, "#111111") ? "#ffffff" : "#111111"; }

  /** The theme's colour tokens for a mode, from the page's palette (and the custom overrides). */
  function tokensFor(mode, p, overrides) {
    var linkHsl = p.link ? hslOf(p.link) : null;
    var btnHsl = p.button ? hslOf(p.button.bg) : null;
    var t;
    if (mode === "dark") {
      var accent = btnHsl && !grey(btnHsl) ? hslHex(btnHsl.h, Math.min(btnHsl.s, 85), clamp(btnHsl.l, 42, 58)) : linkHsl && !grey(linkHsl) ? hslHex(linkHsl.h, Math.min(linkHsl.s, 85), 50) : "#4a8be0";
      t = { scheme: "dark", bg: "#121212", surface: "#1e1e1e", text: "#e6e6e6", muted: "#a6a6a6", border: "#3a3a3a",
        link: linkHsl && !grey(linkHsl) ? hslHex(linkHsl.h, Math.min(linkHsl.s, 90), Math.max(linkHsl.l, 68)) : "#8ab4f8",
        accent: accent, accentText: p.button && contrastRatio(p.button.color, accent) >= 3 ? p.button.color : readableOn(accent) };
    } else if (mode === "sepia") {
      t = { scheme: "light", bg: "#f4ecd8", surface: "#ebe0c8", text: "#5b4636", muted: "#7d6757", border: "#d6c7a8", link: "#7a4a12", accent: btnHsl && !grey(btnHsl) ? hslHex(btnHsl.h, Math.min(btnHsl.s, 60), clamp(btnHsl.l, 35, 50)) : "#8a5a2b", accentText: "#fff8ec" };
      t.accentText = readableOn(t.accent) === "#ffffff" ? "#fff8ec" : "#2b1d10";
    } else if (mode === "high-contrast") {
      t = { scheme: "dark", bg: "#000000", surface: "#000000", text: "#ffffff", muted: "#ffffff", border: "#ffffff", link: "#ffff00", accent: "#ffffff", accentText: "#000000" };
    } else if (mode === "custom") {
      t = tokensFor("dark", p, null);
      overrides = overrides || {};
      Object.keys(overrides).forEach(function (k) {
        if (k === "scheme") { if (overrides[k] !== "dark" && overrides[k] !== "light") throw new Error("overrides.scheme must be 'dark' or 'light'."); t.scheme = overrides[k]; return; }
        if (TOKEN_NAMES.indexOf(k) === -1) throw new Error("overrides." + k + " is not a theme token — use " + TOKEN_NAMES.join(", ") + " or scheme.");
        var hex = normalizeColor(overrides[k]);
        if (!hex || hex === "transparent") throw new Error("overrides." + k + ": '" + overrides[k] + "' is not a colour (use #rrggbb, rgb() or hsl()).");
        t[k] = hex;
      });
      if (!overrides.accentText && overrides.accent) t.accentText = readableOn(t.accent);
      if (!overrides.scheme) t.scheme = luminance(t.bg) < 0.3 ? "dark" : "light";
    } else throw new Error("mode must be dark, sepia, high-contrast, custom or off.");
    return t;
  }
  /** A site background → the theme's counterpart (light surfaces move to the theme's surfaces; saturated tints keep their hue). */
  function mapBg(hex, mode, t) {
    var h = hslOf(hex);
    if (mode === "high-contrast") return t.bg;
    if (mode === "sepia") return h.l >= 92 ? t.bg : grey(h) ? hslHex(38, 32, clamp(90 - (100 - h.l) * 0.6, 72, 90)) : hslHex(h.h, Math.min(h.s, 45), clamp(h.l, 78, 90));
    // dark (and custom, which follows the dark mapping onto its own surfaces)
    if (h.l >= 97) return t.bg;
    if (grey(h) || h.s <= 40) return hslHex(h.h, Math.min(h.s, 20), clamp(hslOf(t.surface).l + (100 - h.l) * 0.4, 8, 26));
    return hslHex(h.h, Math.round(h.s * 0.7), clamp(h.l - 55, 18, 32));
  }
  /** A site text colour → the theme's counterpart. */
  function mapText(hex, mode, t) {
    var h = hslOf(hex);
    if (mode === "high-contrast") return grey(h) ? t.text : hslHex(h.h, 100, 80);
    if (mode === "sepia") return grey(h) ? (h.l >= 45 ? t.muted : t.text) : hslHex(h.h, Math.min(h.s, 70), clamp(h.l, 25, 40));
    if (grey(h)) return h.l >= 45 ? t.muted : hslHex(h.h, Math.min(h.s, 15), clamp(93 - h.l * 0.6, 72, 93));
    return hslHex(h.h, Math.min(h.s, 85), clamp(h.l + 30, 62, 82));
  }
  function mapBorder(hex, mode, t) {
    var h = hslOf(hex);
    if (mode === "high-contrast") return t.border;
    if (mode === "sepia") return hslHex(38, 25, clamp(h.l - 10, 60, 82));
    return hslHex(h.h, Math.min(h.s, 15), clamp(100 - h.l, 22, 42));
  }
  function uniqSelectors(list, used, exclude) {
    return (list || []).filter(function (s) { if (!s || used[s] || exclude.test(s)) return false; used[s] = 1; return true; });
  }

  /** Build the theme CSS for a palette summary → { css, mapping: [{ what, from, to, selectors }], tokens, name }. */
  function themeCss(p, mode, overrides, host) {
    if (!MODES[mode]) throw new Error("mode must be dark, sepia, high-contrast, custom or off.");
    var t = tokensFor(mode, p, overrides);
    var mapping = [], used = { html: 1, body: 1 };
    var out = [];
    out.push("/* Palette theme: " + MODES[mode].toLowerCase() + " for " + (host || "this site") + " — built from the page's own colours, " + new Date().toISOString().slice(0, 10) + ". Mapped colours, no invert filter: images stay as they are. */");
    out.push(":root { color-scheme: " + t.scheme + "; }");
    out.push("html, body { background-color: " + t.bg + " !important; color: " + t.text + " !important; }");
    mapping.push({ what: "page", from: p.body.bg + " / " + p.body.color, to: t.bg + " / " + t.text });
    // Colour variables on :root: light ones to the theme's surfaces, dark ones to its text, the rest kept.
    var varDecls = [];
    p.vars.forEach(function (v) {
      var h = hslOf(v.hex), to = null;
      if (h.l >= 60 && (grey(h) || h.s <= 40)) to = mapBg(v.hex, mode, t);
      else if (h.l <= 40 && grey(h)) to = mapText(v.hex, mode, t);
      if (to && to !== v.hex) { varDecls.push(v.name + ": " + to + " !important;"); mapping.push({ what: "variable " + v.name, from: v.hex, to: to }); }
    });
    if (varDecls.length) out.push(":root { " + varDecls.join(" ") + " }");
    // Backgrounds: the light surfaces of the site, on the selectors that use them.
    p.bg.slice(0, 14).forEach(function (c) {
      var h = hslOf(c.hex);
      if (h.l < 55) return;
      var to = mapBg(c.hex, mode, t);
      var sels = uniqSelectors(c.selectors, used, /^(a|button|input|img|svg|span)(\.|$)/);
      mapping.push({ what: "background", from: c.hex, to: to, selectors: sels, n: c.n });
      if (sels.length) out.push(sels.join(", ") + " { background-color: " + to + " !important; }");
    });
    // Text: the dark (and mid-grey) text colours of the site.
    var usedText = {};
    p.text.slice(0, 14).forEach(function (c) {
      var h = hslOf(c.hex);
      if (h.l > 70) return;
      var to = mapText(c.hex, mode, t);
      var sels = uniqSelectors(c.selectors, usedText, /^(a|button|input|img|svg)(\.|$)/);
      mapping.push({ what: "text", from: c.hex, to: to, selectors: sels, n: c.n });
      if (sels.length) out.push(sels.join(", ") + " { color: " + to + " !important; }");
    });
    // Borders: one rule for the common border colours (and rules/hr).
    var borders = p.border.slice(0, 6).filter(function (c) { return hslOf(c.hex).l >= 55 || mode === "high-contrast"; });
    if (borders.length) { var bto = mapBorder(borders[0].hex, mode, t); mapping.push({ what: "borders", from: borders.map(function (c) { return c.hex; }).join(", "), to: bto }); out.push("hr { border-color: " + bto + " !important; }"); }
    out.push("*, *::before, *::after { border-color: " + t.border + "; }");
    // Links and buttons: the site's own hue, brightened for the dark surfaces.
    out.push("a, a:visited { color: " + t.link + " !important; }");
    if (mode === "high-contrast") out.push("a:visited { color: #ff80ff !important; }", "*:focus-visible { outline: 3px solid #ffbf00 !important; outline-offset: 2px; }");
    mapping.push({ what: "links", from: p.link || "(none)", to: t.link });
    if (p.button || mode !== "dark") {
      out.push("button, [role=button], input[type=submit], input[type=button] { background-color: " + t.accent + " !important; color: " + t.accentText + " !important; border-color: " + (mode === "high-contrast" ? t.border : t.accent) + " !important; }");
      mapping.push({ what: "buttons", from: p.button ? p.button.color + " on " + p.button.bg : "(none)", to: t.accentText + " on " + t.accent });
    }
    out.push("input:not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio]):not([type=range]), textarea, select { background-color: " + t.surface + " !important; color: " + t.text + " !important; border-color: " + t.border + " !important; }");
    out.push("::placeholder { color: " + t.muted + " !important; }");
    out.push("img, video, canvas, picture, svg, iframe { filter: none; }");
    return { css: out.join("\n"), mapping: mapping, tokens: t, name: THEME_PREFIX + mode };
  }
  function formatMapping(m) {
    return m.map(function (e) { return "  " + e.what + ": " + e.from + " → " + e.to + (e.selectors && e.selectors.length ? "  (" + e.selectors.join(", ") + ")" : e.selectors ? "  (no stable selector found — covered by the page rule)" : ""); }).join("\n");
  }
  /** The theme overrides a site has: [{ name, mode, enabled }]. */
  function themesOf(all, site) {
    var st = S();
    var group = st.siteGroup(all, site) || {};
    return Object.keys(group).filter(function (n) { return n.indexOf(THEME_PREFIX) === 0; }).map(function (n) { return { name: n, mode: n.slice(THEME_PREFIX.length), enabled: group[n].enabled !== false }; });
  }

  // ── Harmonies (pure) ─────────────────────────────────────────────────────

  function mix(hex, toward, k) { var c = parseColor(hex), t = parseColor(toward); return toHex({ r: c.r + (t.r - c.r) * k, g: c.g + (t.g - c.g) * k, b: c.b + (t.b - c.b) * k }); }
  /**
   * The harmonies of a colour, as hex: rotations of its hue on the HSL wheel (complementary 180°, split
   * ±150°, analogous ±30°, triadic ±120°, tetradic 90°/180°/270°), five tints mixed toward white and five
   * shades toward black (the hue kept, each step lighter / darker than the last). Throws when the colour
   * cannot be parsed.
   */
  function harmony(color) {
    var hex = normalizeColor(color);
    if (!hex || hex === "transparent") throw new Error("'" + color + "' is not a colour — use #rrggbb, rgb() or hsl().");
    var h = hslOf(hex);
    function rot(d) { return hslHex(h.h + d, h.s, h.l); }
    function ramp(toward) { var out = []; for (var i = 1; i <= 5; i++) out.push(mix(hex, toward, i / 6)); return out; }
    return { base: hex, hsl: h, complementary: rot(180), split: [rot(150), rot(210)], analogous: [rot(-30), rot(30)], triadic: [rot(120), rot(240)], tetradic: [rot(90), rot(180), rot(270)], tints: ramp("#ffffff"), shades: ramp("#000000") };
  }
  /** The page's accent the way the themes pick it → { hex, from }, or null when nothing coloured stands out. */
  function accentOf(p) {
    function vivid(hex) { if (!hex || hex === "transparent") return false; var h = hslOf(hex); return !grey(h) && h.l > 8 && h.l < 92; }
    if (p.button && vivid(p.button.bg)) return { hex: p.button.bg, from: "its button colour" };
    if (vivid(p.themeColor)) return { hex: p.themeColor, from: "its theme-color" };
    if (vivid(p.link)) return { hex: p.link, from: "its link colour" };
    var cands = (p.bg || []).concat(p.text || []).filter(function (c) { return vivid(c.hex); });
    return cands.length ? { hex: cands[0].hex, from: "its most used saturated colour" } : null;
  }
  function pad(s, n) { s = String(s); while (s.length < n) s += " "; return s; }
  function ratioMark(hex, bg) { var r = contrastRatio(hex, bg); return r.toFixed(2) + ":1 " + (r >= 4.5 ? "✓ AA" : r >= 3 ? "⚠ large only" : "⚠"); }
  /** The harmonies as CSS variables on :root, ready to paste. */
  function harmonyVars(hm) {
    var lines = [":root {", "  --accent: " + hm.base + ";", "  --accent-2: " + hm.complementary + "; /* complementary */", "  --accent-3: " + hm.split[0] + "; /* split-complementary */", "  --accent-4: " + hm.split[1] + ";"];
    hm.analogous.forEach(function (x, i) { lines.push("  --accent-analogous-" + (i + 1) + ": " + x + ";"); });
    hm.triadic.forEach(function (x, i) { lines.push("  --accent-triad-" + (i + 1) + ": " + x + ";"); });
    hm.tetradic.forEach(function (x, i) { lines.push("  --accent-tetrad-" + (i + 1) + ": " + x + ";"); });
    hm.tints.forEach(function (x, i) { lines.push("  --accent-tint-" + (i + 1) + ": " + x + ";"); });
    hm.shades.forEach(function (x, i) { lines.push("  --accent-shade-" + (i + 1) + ": " + x + ";"); });
    lines.push("  --on-accent: " + readableOn(hm.base) + "; /* text on the accent */", "}");
    return lines.join("\n");
  }
  /** The browser_palette_harmony report: every colour with its contrast against `bg`, then the variables. */
  function formatHarmony(hm, bg, words) {
    var lines = ["Harmonies of " + hm.base + " (hue " + hm.hsl.h + "°, " + hm.hsl.s + "% saturation, " + Math.round(hm.hsl.l) + "% lightness)" + (words || "") + ", contrast against " + bg + ":"];
    function row(label, list) { lines.push("  " + pad(label, 21) + list.map(function (x) { return x + " " + ratioMark(x, bg); }).join("   ")); }
    row("base", [hm.base]);
    row("complementary", [hm.complementary]);
    row("split-complementary", hm.split);
    row("analogous (±30°)", hm.analogous);
    row("triadic", hm.triadic);
    row("tetradic", hm.tetradic);
    row("tints → white", hm.tints);
    row("shades → black", hm.shades);
    if (hm.hsl.s < 10) lines.push("  (a grey has no hue, so the rotations repeat it — pass a saturated colour)");
    lines.push("", "✓ AA = 4.5:1 or more, fine for text; ⚠ large only = 3:1 or more, fine for large text (24px, or 18.66px bold), icons and borders; ⚠ = below 3:1, decorative use only.", "", harmonyVars(hm));
    return lines.join("\n");
  }


  // ── Design tokens, recolouring, image colours (pure) ─────────────────────

  var LENGTH_UNIT = "(?:px|r?em|%|vw|vh|vmin|vmax|ch|ex|pt|pc|cm|mm|in|q|svh|lvh|dvh|svw|lvw|dvw|cqw|cqh|lh|rlh|fr)";
  var ONE_LENGTH = new RegExp("^-?(?:\\d+\\.?\\d*|\\.\\d+)" + LENGTH_UNIT + "$|^0$", "i");
  var FAMILY_LIST = /^(?:"[^"]*"|'[^']*'|[-\w][-\w ]*)(?:\s*,\s*(?:"[^"]*"|'[^']*'|[-\w][-\w ]*))*$/;
  var GENERIC_FAMILY = /\b(serif|sans-serif|monospace|system-ui|ui-sans-serif|ui-serif|ui-monospace|ui-rounded|cursive|fantasy|emoji|math|fangsong)\b/i;
  /** What a token's value looks like → "colour" | "length" | "font" | "other" (the name settles a bare family or weight). */
  function tokenKind(name, value) {
    var v = String(value == null ? "" : value).trim(), n = String(name == null ? "" : name).toLowerCase();
    if (!v) return "other";
    if (normalizeColor(v) || /^(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark)\(/i.test(v)) return "colour";
    if (v.split(/\s+/).every(function (p) { return ONE_LENGTH.test(p); })) return "length";
    if (/^(calc|clamp|min|max)\(/i.test(v) && new RegExp("\\d" + LENGTH_UNIT + "\\b", "i").test(v) && !/,\s*(rgba?|hsla?|#)/i.test(v)) return "length";
    if (FAMILY_LIST.test(v) && (v.indexOf(",") !== -1 || GENERIC_FAMILY.test(v) || /font|family|typeface/.test(n)) && !/^(none|auto|inherit|initial|unset|normal|solid|dashed|dotted|block|flex|grid)$/i.test(v)) return "font";
    if (/^[1-9]00$/.test(v) && /weight/.test(n)) return "font";
    if (/^(bold|bolder|lighter|italic|oblique|small-caps)$/i.test(v)) return "font";
    return "other";
  }
  /** Tokens by what they look like → { colour, length, font, other }: each a copy with `kind` (and `hex` for a colour), the input order kept. */
  function groupTokens(list) {
    var groups = { colour: [], length: [], font: [], other: [] };
    (list || []).forEach(function (t) {
      var value = t.value || t.declared || "";
      var kind = tokenKind(t.name, value) === "other" && t.declared && t.declared !== value ? tokenKind(t.name, t.declared) : tokenKind(t.name, value);
      var copy = {};
      Object.keys(t).forEach(function (k) { copy[k] = t[k]; });
      copy.kind = kind;
      if (kind === "colour") copy.hex = normalizeColor(value) || null;
      groups[kind].push(copy);
    });
    return groups;
  }
  /** Most used first (then most declared, then by name). */
  function rankTokens(list) {
    return (list || []).slice().sort(function (a, b) { return (b.uses || 0) - (a.uses || 0) || (b.decls || 0) - (a.decls || 0) || String(a.name).localeCompare(String(b.name)); });
  }
  function tokenLine(t) {
    var value = t.value || t.declared || "(empty)";
    var s = t.name + ": " + (t.declared && t.value && t.declared !== t.value ? t.declared + " → " + value : value);
    if (t.kind === "colour" && t.hex && t.hex !== value.toLowerCase()) s += " (" + t.hex + ")";
    s += "  ×" + fmtN(t.uses || 0) + " use" + (t.uses === 1 ? "" : "s");
    if (t.selector) s += "  (" + t.selector + (t.sheet ? ", " + t.sheet : "") + (t.decls > 1 ? ", " + t.decls + " declarations" : "") + ")";
    else s += "  (declared in a stylesheet that could not be read)";
    return s;
  }
  /** The browser_palette_tokens report: the top tokens by use in four groups, how to change one. */
  function formatTokens(raw, filter) {
    raw = raw || {};
    var host = hostOfUrl(raw.url) || "this page";
    var all = raw.tokens || [], q = String(filter || "").trim().toLowerCase();
    var list = q ? all.filter(function (t) { return String(t.name).toLowerCase().indexOf(q) !== -1; }) : all;
    var unread = raw.unreadable ? raw.unreadable + " cross-origin stylesheet" + (raw.unreadable === 1 ? "" : "s") + " could not be read (tokens declared or used there are not counted)" : "";
    var sheetsWords = (raw.readable || 0) + " readable stylesheet" + (raw.readable === 1 ? "" : "s");
    if (!list.length) {
      if (q && all.length) return "None of the " + all.length + " custom properties of " + host + " is named like '" + q + "' — browser_palette_tokens without filter lists them.";
      return "No CSS custom properties found in the " + sheetsWords + " of " + host + (unread ? " (" + unread + ")" : "") + ". The site styles its elements directly: browser_palette_extract shows its colours and fonts, browser_style_apply changes them.";
    }
    var top = rankTokens(list).slice(0, TOP_TOKENS);
    var groups = groupTokens(top);
    var head = "Design tokens of " + host + ": " + all.length + " custom propert" + (all.length === 1 ? "y" : "ies") + " in " + sheetsWords + (raw.rules ? " (" + fmtN(raw.rules) + " rules" + (raw.totalUses !== undefined ? ", " + fmtN(raw.totalUses) + " var() uses" : "") + ")" : "") + (unread ? "; " + unread : "") + ".";
    if (q) head += " Named like '" + q + "': " + list.length + ".";
    if (list.length > top.length) head += " The " + top.length + " most used:";
    var lines = [head];
    [["colour", "Colours"], ["length", "Lengths"], ["font", "Fonts"], ["other", "Other"]].forEach(function (g) {
      var items = groups[g[0]];
      if (!items.length) return;
      lines.push("", g[1] + " (" + items.length + "):");
      items.forEach(function (t) { lines.push("  " + tokenLine(t)); });
    });
    var example = groups.colour[0] || top[0];
    lines.push("", "Change one everywhere it is used: browser_style_tokens set={\"" + example.name + "\": \"" + (example.kind === "colour" ? "#0a7" : "…") + "\"} — saved as the site's 'Tokens' override, applied at once and kept on every visit. A token the site redeclares on a component keeps its own value there (a browser_style_apply rule for that selector fixes it).");
    return lines.join("\n");
  }

  var RECOLOR_PROPS = ["color", "background", "border"];
  var RECOLOR_CSS = { color: "color", background: "background-color", border: "border-color" };
  /** Distance of two colours on a 0–100 scale: the sRGB channel differences summed in quadrature (0 = the same, 100 = black vs white), two decimals. Throws on a non-colour. */
  function colorDistance(a, b) {
    var ca = parseColor(a), cb = parseColor(b);
    if (!ca) throw new Error("'" + a + "' is not a colour — use #rrggbb, rgb() or hsl().");
    if (!cb) throw new Error("'" + b + "' is not a colour — use #rrggbb, rgb() or hsl().");
    var dr = ca.r - cb.r, dg = ca.g - cb.g, db = ca.b - cb.b;
    return Math.round(Math.sqrt(dr * dr + dg * dg + db * db) * 100 / (255 * Math.sqrt(3)) * 100) / 100;
  }
  /** The `properties` argument checked → ["color", "background", "border"] (all three by default). */
  function recolorProps(list) {
    if (list === undefined || list === null) return RECOLOR_PROPS.slice();
    if (typeof list === "string") list = [list];
    if (!Array.isArray(list) || !list.length) throw new Error("properties must be a list of color, background and/or border (default: all three).");
    var out = [];
    list.forEach(function (p) {
      p = String(p).trim().toLowerCase().replace(/-color$/, "");
      if (p === "background-color" || p === "bg") p = "background";
      if (RECOLOR_PROPS.indexOf(p) === -1) throw new Error("properties: '" + p + "' is not one of color, background, border.");
      if (out.indexOf(p) === -1) out.push(p);
    });
    return out;
  }
  /** The recolour rules: one !important rule per property, its selectors de-duplicated — matches = [{ selector, props: ["color" | "background" | "border"] }]. */
  function recolorCss(matches, to) {
    var hex = normalizeColor(to);
    if (!hex || hex === "transparent") throw new Error("'" + to + "' is not a colour — use #rrggbb, rgb() or hsl().");
    var by = { color: [], background: [], border: [] };
    (matches || []).forEach(function (m) {
      if (!m || !m.selector) return;
      (m.props || []).forEach(function (p) { if (by[p] && by[p].indexOf(m.selector) === -1) by[p].push(m.selector); });
    });
    return RECOLOR_PROPS.filter(function (p) { return by[p].length; }).map(function (p) { return by[p].join(", ") + " { " + RECOLOR_CSS[p] + ": " + hex + " !important; }"; }).join("\n");
  }
  function recolorName(from, to) { return "Recolor " + from + "→" + to; }

  /**
   * The dominant colours of pixels (a flat [r, g, b, …] array, or [[r, g, b], …]) by median cut: the
   * pixels are binned to 5 bits per channel (exact sums kept), the bins split along their widest
   * channel at the weighted median (the box with the largest spread × population splits first) until
   * `count` boxes exist (or no box can split), each box's weighted
   * mean is a colour. → [{ hex, share (0–1), n }] most pixels first; [] for no pixels.
   */
  function quantize(pixels, count) {
    count = Math.max(1, Math.min(64, Math.round(Number(count) || 5)));
    var flat = pixels || [], triples = Array.isArray(flat[0]), n = triples ? flat.length : Math.floor(flat.length / 3);
    var cells = {}, keys = [], total = 0;
    for (var i = 0; i < n; i++) {
      var r = triples ? flat[i][0] : flat[i * 3], g = triples ? flat[i][1] : flat[i * 3 + 1], b = triples ? flat[i][2] : flat[i * 3 + 2];
      if (!(r >= 0 && r <= 255 && g >= 0 && g <= 255 && b >= 0 && b <= 255)) continue;
      var k = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      var c = cells[k];
      if (!c) { c = cells[k] = { r: 0, g: 0, b: 0, n: 0 }; keys.push(k); }
      c.r += r; c.g += g; c.b += b; c.n++; total++;
    }
    if (!total) return [];
    var entries = keys.map(function (k) { var c = cells[k]; return { r: c.r / c.n, g: c.g / c.n, b: c.b / c.n, sr: c.r, sg: c.g, sb: c.b, n: c.n }; });
    function spread(box) {
      var lo = { r: 255, g: 255, b: 255 }, hi = { r: 0, g: 0, b: 0 }, pop = 0;
      box.forEach(function (e) { pop += e.n; ["r", "g", "b"].forEach(function (ch) { if (e[ch] < lo[ch]) lo[ch] = e[ch]; if (e[ch] > hi[ch]) hi[ch] = e[ch]; }); });
      var span = { r: hi.r - lo.r, g: hi.g - lo.g, b: hi.b - lo.b };
      var ch = span.r >= span.g && span.r >= span.b ? "r" : span.g >= span.b ? "g" : "b";
      return { ch: ch, span: span[ch], pop: pop };
    }
    var boxes = [entries];
    while (boxes.length < count) {
      var pick = -1, best = -1, sp = null;
      for (var j = 0; j < boxes.length; j++) {
        if (boxes[j].length < 2) continue;
        var s = spread(boxes[j]), score = s.span * s.pop;
        if (score > best) { best = score; pick = j; sp = s; }
      }
      if (pick === -1) break;
      var box = boxes[pick].slice().sort(function (a, b) { return a[sp.ch] - b[sp.ch]; });
      // The cut between two bins whose cumulative weight comes closest to half the box's (the weighted median).
      var half = sp.pop / 2, acc = 0, cut = 1, nearest = Infinity;
      for (var m = 0; m < box.length - 1; m++) { acc += box[m].n; var diff = Math.abs(acc - half); if (diff < nearest) { nearest = diff; cut = m + 1; } }
      boxes.splice(pick, 1, box.slice(0, cut), box.slice(cut));
    }
    return boxes.map(function (bx) {
      var sr = 0, sg = 0, sb = 0, nn = 0;
      bx.forEach(function (e) { sr += e.sr; sg += e.sg; sb += e.sb; nn += e.n; });
      return { hex: toHex({ r: sr / nn, g: sg / nn, b: sb / nn }), share: Math.round((nn / total) * 10000) / 10000, n: nn };
    }).sort(function (a, b) { return b.n - a.n; });
  }
  function fileOf(src) {
    if (!src) return "";
    if (/^data:/i.test(src)) return "a data: URL";
    if (/^blob:/i.test(src)) return "a blob: URL";
    try { var u = new URL(src); return (u.pathname.split("/").pop() || u.host).slice(0, 60); } catch (_) { return String(src).slice(0, 60); }
  }
  /** "the <img> hero.jpg (alt "…", 1200×800, shown at 600×400) — the largest visible image" */
  function imageWords(r) {
    var what = r.kind === "background" ? "the background image of <" + r.tag + ">" : "the <" + r.tag + ">";
    var bits = [];
    if (r.alt) bits.push('alt "' + (r.alt.length > 60 ? r.alt.slice(0, 59) + "…" : r.alt) + '"');
    if (r.natural) bits.push(r.natural.width + "×" + r.natural.height);
    if (r.shown) bits.push("shown at " + r.shown.width + "×" + r.shown.height);
    var file = fileOf(r.src);
    return what + (file ? " " + file : "") + (bits.length ? " (" + bits.join(", ") + ")" : "") + (r.how === "largest" ? " — the largest visible image" : "");
  }
  /** The browser_palette_from_image report: the colours with share and contrast against the page background, a :root block; or why the image cannot be read. */
  function formatImagePalette(r, count) {
    r = r || {};
    var bg = normalizeColor(r.pageBg);
    if (!bg || bg === "transparent") bg = "#ffffff";
    if (!r.pixels) {
      var why = r.reason === "tainted" || r.reason === "cors"
        ? "it comes from another origin" + (r.src ? " (" + (function () { try { return new URL(r.src).host; } catch (_) { return "elsewhere"; } })() + ")" : "") + " that does not allow cross-origin reads, so the browser taints the canvas and the pixels cannot be read in the page"
        : "it could not be drawn" + (r.loadError ? " — " + r.loadError : "");
      return "The colours of " + imageWords(r) + " cannot be read: " + why + ". Describe it instead: open " + (r.src || "the image") + " in a tab (browser_navigate) and look at it with browser_screenshot, or pass the URL to the agent for a description. browser_palette_extract still gives the page's own colours.";
    }
    var cols = quantize(r.pixels, count);
    var px = Math.floor(r.pixels.length / 3);
    if (!cols.length) return "The colours of " + imageWords(r) + " cannot be read: every pixel is transparent.";
    var lines = ["Dominant colours of " + imageWords(r) + ": " + fmtN(px) + " pixels sampled" + (r.transparent ? " (" + fmtN(r.transparent) + " transparent skipped)" : "") + ", " + cols.length + " colour" + (cols.length === 1 ? "" : "s") + ", contrast against the page background " + bg + ":"];
    cols.forEach(function (c, i) {
      var h = hslOf(c.hex);
      lines.push("  " + (i + 1) + ". " + c.hex + "  " + pad(Math.round(c.share * 100) + "%", 4) + " " + ratioMark(c.hex, bg) + "  (hue " + h.h + "°, " + h.s + "% sat, " + Math.round(h.l) + "% light)");
    });
    lines.push("", ":root {");
    cols.forEach(function (c, i) { lines.push("  --image-" + (i + 1) + ": " + c.hex + "; /* " + Math.round(c.share * 100) + "% */"); });
    lines.push("}");
    lines.push("", "✓ AA = 4.5:1 or more, fine for text on the page background; ⚠ large only = 3:1 or more (large text, icons, borders); ⚠ = decorative use only. Use a colour with browser_style_tokens (set={\"--brand\": \"" + cols[0].hex + "\"}), browser_palette_theme mode=custom (overrides={ accent: \"…\" }) or a browser_style_apply rule; browser_palette_harmony color=" + cols[0].hex + " gives its harmonies.");
    return lines.join("\n");
  }
  // ── Doing it: extract, contrast, theme (shared by the tools and the tab) ───

  async function extract() {
    var raw = await H.inTop(pageExtractPalette, [MAX_SAMPLE]);
    return summarizePalette(raw);
  }
  async function contrast(level, selector) {
    var raw = await H.inTop(pageContrast, [MAX_SAMPLE, String(selector || "")]);
    return { result: evaluateContrast(raw, level), url: raw.url };
  }
  /**
   * Build and apply a theme for the current tab's site (or `site`): saved as the override
   * "theme:<mode>" (other theme:* overrides of the site are removed), or only previewed. mode "off"
   * removes the site's theme. → { mode, name, site, saved, preview, removed, css, mapping }
   */
  async function applyTheme(a) {
    a = a || {};
    var st = S();
    var mode = String(a.mode || "").trim();
    var tab = null;
    try { tab = await H.currentTab(); } catch (e) { if (!a.site) throw e; }
    var site = a.site ? st.normHost(a.site) : st.hostOf(tab && tab.url);
    if (!site) throw new Error("The current tab is not a website (" + ((tab && tab.url) || "no URL") + ") — switch to one, or pass site.");
    if (mode === "off") {
      var had = themesOf(await st.loadAll(), site);
      for (var i = 0; i < had.length; i++) await st.removeOverride({ site: site, name: had[i].name });
      var apOff = tab ? await st.applyToTab(tab) : { applies: false };
      if (tab) await st.previewInTab("").catch(function () {});
      return { mode: mode, site: site, removed: had.map(function (h) { return h.name; }), applied: !!apOff.applies };
    }
    if (!MODES[mode]) throw new Error("mode must be dark, sepia, high-contrast, custom or off.");
    if (!tab) throw new Error("A theme is built from the page's own palette — open a page of " + site + " first.");
    var p = await extract();
    var built = themeCss(p, mode, a.overrides, site);
    var name = a.name ? String(a.name).replace(/\s+/g, " ").trim().slice(0, 60) || built.name : built.name;
    if (a.preview) {
      await st.previewInTab(built.css);
      return { mode: mode, name: name, site: site, saved: false, preview: true, css: built.css, mapping: built.mapping, tokens: built.tokens };
    }
    // One theme per site: the earlier theme:* overrides go.
    var earlier = themesOf(await st.loadAll(), site).filter(function (h) { return h.name !== name; });
    for (var k = 0; k < earlier.length; k++) await st.removeOverride({ site: site, name: earlier[k].name });
    var saved = await st.saveOverride({ site: site, name: name, css: built.css });
    await st.previewInTab("").catch(function () {});
    var ap = await st.applyToTab(tab);
    return { mode: mode, name: saved.name, site: site, saved: true, preview: false, replaced: earlier.map(function (h) { return h.name; }), applied: !!ap.applies, size: saved.size, css: built.css, mapping: built.mapping, tokens: built.tokens };
  }

  // ── Tools ────────────────────────────────────────────────────────────────

  T.register("browser_palette_extract", async function (a) {
    a = a || {};
    var p = await extract();
    if (a.as === "json") return text(JSON.stringify(p, null, 1));
    if (a.as === "css") return text(cssVariables(p));
    return text(formatPalette(p) + "\n\nAs CSS variables:\n" + cssVariables(p));
  });

  T.register("browser_palette_contrast", async function (a) {
    a = a || {};
    var r = await contrast(a.level, a.selector);
    return text(formatContrast(r.result, r.url));
  });

  T.register("browser_palette_theme", async function (a) {
    a = a || {};
    if (!a.mode) throw new Error("mode is required: dark, sepia, high-contrast, custom (with overrides) or off.");
    var r = await applyTheme(a);
    if (r.mode === "off") return text(r.removed.length ? "Removed the theme of " + r.site + " (" + r.removed.join(", ") + ")" + (r.applied ? "; the current tab is back to the site's own colours." : ".") : "No theme is saved for " + r.site + ".");
    var head = r.preview
      ? "Previewing the " + MODES[r.mode].toLowerCase() + " theme in the current tab (not saved — it goes with the next load; call again without preview to keep it)."
      : "Saved the " + MODES[r.mode].toLowerCase() + " theme as override '" + r.name + "' for " + r.site + " (" + (r.size / 1024).toFixed(1) + " KB)" + (r.replaced.length ? ", replacing " + r.replaced.join(", ") : "") + (r.applied ? "; applied in the current tab" : "") + ". The site keeps it until browser_style_remove or mode=off.";
    return text(head + "\nMapping:\n" + formatMapping(r.mapping) + "\nCheck it with browser_screenshot; fix a spot with a browser_style_apply rule.");
  });

  T.register("browser_palette_harmony", async function (a) {
    a = a || {};
    var base, bg, words = "";
    // The given colours are checked before the page is read: a bad argument should not cost a page walk.
    if (a.color) {
      base = normalizeColor(a.color);
      if (!base || base === "transparent") throw new Error("'" + a.color + "' is not a colour — use #rrggbb, rgb() or hsl().");
    }
    if (a.background) {
      bg = normalizeColor(a.background);
      if (!bg || bg === "transparent") throw new Error("'" + a.background + "' is not a colour — use #rrggbb, rgb() or hsl().");
    }
    var p = null, pageErr = "";
    if (!base || !bg) { try { p = await extract(); } catch (e) { pageErr = String((e && e.message) || e); } }
    if (!base) {
      if (!p) throw new Error("Couldn't read the page's palette (" + pageErr + ") — pass color.");
      var acc = accentOf(p);
      if (!acc) throw new Error("No accent stands out on this page (no coloured buttons, theme-color or links) — pass color.");
      base = acc.hex; words = " — the page's accent (" + acc.from + ")";
    }
    if (!bg) bg = p ? p.body.bg : "#ffffff";
    return text(formatHarmony(harmony(base), bg, words) + (!a.background && !p ? "\n(the page could not be read: " + pageErr + "; measured against white)" : ""));
  });

  T.register("browser_palette_tokens", async function (a) {
    a = a || {};
    var raw = await H.inTop(pageTokens, [MAX_TOKENS]);
    return text(formatTokens(raw, a.filter));
  });

  T.register("browser_palette_recolor", async function (a) {
    a = a || {};
    var st = S();
    var from = a.from ? normalizeColor(a.from) : null, to = a.to ? normalizeColor(a.to) : null;
    if (!from || from === "transparent") throw new Error("from is required — the colour to replace, as #rrggbb, rgb() or hsl()" + (a.from ? " ('" + a.from + "' is not one)" : "") + ".");
    if (!to || to === "transparent") throw new Error("to is required — the new colour, as #rrggbb, rgb() or hsl()" + (a.to ? " ('" + a.to + "' is not one)" : "") + ".");
    var tol = a.tolerance === undefined || a.tolerance === null || a.tolerance === "" ? 12 : Number(a.tolerance);
    if (!isFinite(tol) || tol < 0 || tol > 40) throw new Error("tolerance must be a number from 0 (the exact colour) to 40 (neighbouring shades too); the default is 12.");
    var props = recolorProps(a.properties);
    var tab = await H.currentTab();
    var site = a.site ? st.normHost(a.site) : st.hostOf(tab && tab.url);
    if (!site) throw new Error("The current tab is not a website (" + ((tab && tab.url) || "no URL") + ") — switch to one, or pass site.");
    var c = parseColor(from);
    var raw = await H.inTop(pageRecolor, [MAX_SAMPLE, { r: Math.round(c.r), g: Math.round(c.g), b: Math.round(c.b) }, tol, props, MAX_SELECTORS]);
    var sels = raw.selectors || [];
    var propWords = props.join(", ");
    if (!sels.length) throw new Error("No visible element of " + (st.hostOf(raw.url) || "this page") + " uses a colour within " + tol + " of " + from + " for " + propWords + (raw.closest ? " (the closest is " + raw.closest.hex + ", at " + raw.closest.distance + ")" : "") + (raw.unselectable ? "; " + raw.unselectable + " matched but had no stable selector" : "") + " — raise tolerance (up to 40), check the colour with browser_palette_extract, or pass other properties. Nothing was saved.");
    var shades = Object.keys(raw.shades || {}).sort(function (x, y) { return raw.shades[y] - raw.shades[x]; });
    var css = "/* Recolor " + from + " → " + to + " (tolerance " + tol + "; " + propWords + "): " + raw.elements + " elements, " + sels.length + " selectors, " + new Date().toISOString().slice(0, 10) + " */\n" + recolorCss(sels, to);
    var saved = await st.saveOverride({ site: site, name: recolorName(from, to), css: css });
    var ap = await st.applyToTab(tab);
    var perProp = props.map(function (p) { var k = sels.filter(function (s) { return s.props.indexOf(p) !== -1; }).length; return k ? p + " on " + k : null; }).filter(Boolean);
    var lines = [(saved.replaced ? "Replaced" : "Saved") + " override '" + saved.name + "' for " + site + " (" + (saved.size / 1024).toFixed(1) + " KB, " + saved.rules + " rule" + (saved.rules === 1 ? "" : "s") + "): " + raw.elements + " element" + (raw.elements === 1 ? "" : "s") + " within " + tol + " of " + from +
      " (" + shades.length + " shade" + (shades.length === 1 ? "" : "s") + ": " + shades.slice(0, 6).map(function (h) { return h + " ×" + raw.shades[h]; }).join(", ") + (shades.length > 6 ? ", …" : "") + ") in " + sels.length + " selector" + (sels.length === 1 ? "" : "s") + (raw.truncated ? " (the " + raw.truncated + " least used dropped)" : "") + " — " + perProp.join(", ") + " → " + to + "." +
      (raw.unselectable ? " " + raw.unselectable + " element" + (raw.unselectable === 1 ? " has" : "s have") + " no stable selector and " + (raw.unselectable === 1 ? "is" : "are") + " not covered." : "") +
      (ap.applies ? " Applied in the current tab;" : " Saved;") + " the site keeps it until browser_style_remove name=\"" + saved.name + "\"."];
    lines.push("Selectors: " + sels.slice(0, 20).map(function (s) { return s.selector + " (" + s.props.join("+") + (s.n > 1 ? ", ×" + s.n : "") + ")"; }).join(", ") + (sels.length > 20 ? ", … " + (sels.length - 20) + " more (browser_style_list css=true shows the override)" : "") + ".");
    lines.push("Check with browser_screenshot — a missed spot gets a browser_style_apply rule, a wrong one goes with browser_style_remove. For a colour the site keeps in a custom property, browser_style_tokens is the cleaner change (browser_palette_tokens lists them).");
    return text(lines.join("\n"));
  });

  T.register("browser_palette_from_image", async function (a) {
    a = a || {};
    var count = a.count === undefined || a.count === null || a.count === "" ? 5 : Number(a.count);
    if (!Number.isInteger(count) || count < 2 || count > 8) throw new Error("count must be a whole number from 2 to 8 (default 5).");
    var r;
    if (a.ref !== undefined && a.ref !== null) {
      var t = H.refTarget ? H.refTarget(Number(a.ref)) : null;
      if (!t) throw new Error("No element [" + a.ref + "] — call browser_read_page first (refs come from it).");
      var tab = await H.currentTab();
      var res;
      try {
        res = await chrome.scripting.executeScript({ target: { tabId: tab.id, documentIds: [t.documentId] }, func: pageImagePixels, args: [t.local, "", IMAGE_SIDE, MAX_SAMPLE], world: "ISOLATED" });
      } catch (_) { throw new Error(STALE); }
      r = res && res[0] ? res[0].result : null;
      if (!r) throw new Error(STALE);
      if (r.error) throw new Error(r.error === "stale" ? STALE : r.error);
    } else {
      r = await H.inTop(pageImagePixels, [0, String(a.selector || "").trim(), IMAGE_SIDE, MAX_SAMPLE]);
    }
    return text(formatImagePalette(r, count));
  });

  // ── The 🧪 Palette tab ───────────────────────────────────────────────────

  var SWATCH = "display:inline-block;width:14px;height:14px;border-radius:3px;border:1px solid rgba(128,128,128,.45);vertical-align:-2px;margin-right:6px;";
  /** A coloured square for a validated #rrggbb (a grey outline square for anything else). */
  function swatch(el, hex) {
    hex = String(hex || "").toLowerCase();
    return el("span", { className: "pal-swatch", title: hex, style: SWATCH + (HEX.test(hex) ? "background:" + hex : "") }, []);
  }

  async function render(content, ctx) {
    var el = ctx.el;
    var st = S();
    var host = st.hostOf(await ctx.currentTabUrl());
    var themes = host ? themesOf(await st.loadAll(), host) : [];
    content.textContent = "";
    var out = el("div", { className: "steps" });
    var lastPalette = null;
    var copy = el("button", { className: "prof-btn", title: "Copy the colours as CSS variables", disabled: true }, ["📋 Copy as CSS variables"]);
    var extractBtn = el("button", { className: "prof-btn primary", title: "Colours, fonts and spacing of the current tab" }, ["🎨 Extract"]);
    var contrastBtn = el("button", { className: "prof-btn", title: "WCAG 2 AA contrast of the visible text" }, ["🔍 Check contrast"]);
    extractBtn.addEventListener("click", async function () {
      out.textContent = ""; ctx.status("Reading the page…");
      try { lastPalette = await extract(); showPalette(el, out, lastPalette); copy.disabled = false; ctx.status(""); }
      catch (e) { ctx.status("⚠ " + ((e && e.message) || e), "bad"); }
    });
    contrastBtn.addEventListener("click", async function () {
      out.textContent = ""; ctx.status("Checking the text…");
      try { var r = await contrast("AA"); showContrast(el, out, r.result); ctx.status(""); }
      catch (e) { ctx.status("⚠ " + ((e && e.message) || e), "bad"); }
    });
    copy.addEventListener("click", function () {
      var clip = typeof navigator !== "undefined" && navigator.clipboard;
      if (!lastPalette || !clip) { ctx.status("⚠ Nothing to copy yet.", "bad"); return; }
      clip.writeText(cssVariables(lastPalette)).then(function () { ctx.status("Copied the CSS variables.", "good"); }, function (e) { ctx.status("⚠ Could not copy: " + ((e && e.message) || e), "bad"); });
    });
    content.appendChild(el("div", { className: "cmd-item event" }, [
      el("span", { className: "cmd-icon" }, ["🧪"]),
      el("div", { className: "cmd-body wide" }, [
        el("div", { className: "cmd-name" }, [host ? "Palette of " + host : "Palette"]),
        el("div", { className: "cmd-desc" }, ["What the page is made of — colours, fonts, spacing — and whether its text is readable."]),
        el("div", { className: "prof-actions" }, [extractBtn, contrastBtn, copy]),
      ]),
    ]));
    content.appendChild(out);
    content.appendChild(el("div", { className: "cmd-group-title" }, ["Theme for " + (host || "this site")]));
    var active = themes.filter(function (t) { return t.enabled; }).map(function (t) { return t.mode; });
    var buttons = [["dark", "🌙 Dark"], ["sepia", "📜 Sepia"], ["high-contrast", "◐ High contrast"], ["off", "✕ Off"]].map(function (b) {
      return el("button", { className: "prof-btn" + (active.indexOf(b[0]) !== -1 ? " primary" : ""), disabled: !host, title: b[0] === "off" ? "Remove the site's theme" : "Build the " + b[1].replace(/^\S+\s/, "").toLowerCase() + " theme from the page's colours and keep it for this site", onclick: async function () {
        ctx.status(b[0] === "off" ? "Removing the theme…" : "Building the theme…");
        try {
          var r = await applyTheme({ mode: b[0], site: host });
          ctx.status(r.mode === "off" ? (r.removed.length ? "Theme removed." : "No theme was saved for " + host + ".") : "Saved '" + r.name + "' for " + host + " — it shows up in the 🎨 Styles tab too.", "good");
          ctx.rerender();
        } catch (e) { ctx.status("⚠ " + ((e && e.message) || e), "bad"); }
      } }, [b[1]]);
    });
    content.appendChild(el("div", { className: "ed-actions" }, buttons));
    content.appendChild(el("div", { className: "cmd-empty" }, [active.length ? "Active: " + active.join(", ") + " (saved as a style override: theme:" + active[0] + ")." : "Built from the page's own colours — mapped, not inverted, so images stay as they are. Saved as the site's style override."]));
  }

  function showPalette(el, out, p) {
    function colours(title, list, n) {
      if (!list.length) return;
      out.appendChild(el("div", { className: "cmd-group-title" }, [title]));
      list.slice(0, n).forEach(function (c) {
        out.appendChild(el("div", { className: "step-line" }, [swatch(el, c.hex), el("span", null, [c.hex + "  ×" + fmtN(c.n)]), c.selectors && c.selectors.length ? el("span", { className: "ed-hint" }, ["  " + c.selectors.slice(0, 3).join(", ")]) : null]));
      });
    }
    colours("Text colours", p.text, 8);
    colours("Backgrounds", p.bg, 8);
    colours("Borders", p.border, 4);
    if (p.fonts.length) {
      out.appendChild(el("div", { className: "cmd-group-title" }, ["Fonts"]));
      p.fonts.slice(0, 5).forEach(function (f) {
        out.appendChild(el("div", { className: "step-line" }, [el("span", { style: "font-family:" + f.stack.replace(/[;{}<>]/g, "") }, [f.family]), el("span", { className: "ed-hint" }, ["  ×" + fmtN(f.n) + " · " + f.sizes.slice(0, 5).map(function (s) { return s.size + "/" + s.weight; }).join(", ")])]));
      });
      if (p.scale.length) out.appendChild(el("div", { className: "cmd-desc" }, ["Type scale: " + p.scale.join(", ") + " px"]));
    }
    if (p.spacing.length) out.appendChild(el("div", { className: "cmd-desc" }, ["Spacing: " + p.spacing.slice(0, 6).map(function (s) { return s.px + "px ×" + fmtN(s.n); }).join(", ")]));
    var meta = [];
    if (p.link) meta.push("links " + p.link);
    if (p.button) meta.push("buttons " + p.button.color + " on " + p.button.bg);
    if (p.themeColor) meta.push("theme-color " + p.themeColor);
    out.appendChild(el("div", { className: "cmd-desc" }, ["Body " + p.body.color + " on " + p.body.bg + (meta.length ? " · " + meta.join(" · ") : "")]));
    if (p.vars.length) out.appendChild(el("div", { className: "cmd-desc mono" }, [p.vars.slice(0, 8).map(function (v) { return v.name + ": " + v.hex; }).join("  ")]));
  }

  function showContrast(el, out, r) {
    out.appendChild(el("div", { className: "cmd-group-title" }, ["Contrast (WCAG 2 AA): " + (r.failures.length ? r.failures.length + " failing style" + (r.failures.length === 1 ? "" : "s") : "all " + r.styles.length + " styles pass")]));
    r.failures.slice(0, 20).forEach(function (f) {
      out.appendChild(el("div", { className: "step-line failed" }, [swatch(el, f.fg), el("span", null, ["on "]), swatch(el, f.bg), el("span", null, [f.ratio.toFixed(2) + ":1 (needs " + f.need + ") · " + f.size + "px/" + f.weight + " · " + f.selector + (f.image ? " · over an image" : "")]), el("div", { className: "cmd-desc" }, ['"' + f.text + '"'])]));
    });
    if (r.failures.length > 20) out.appendChild(el("div", { className: "cmd-desc" }, ["… " + (r.failures.length - 20) + " more"]));
    out.appendChild(el("div", { className: "cmd-desc" }, [r.passes + " pass (" + r.aaa + " also AAA)" + (r.approx ? " · " + r.approx + " over images (approximate)" : "") + " · " + fmtN(r.checked) + " text elements checked."]));
  }

  globalThis.AgentExtras.tabs.push({ id: "palette", label: "🧪 Palette", render: render, storageKeys: ["agentSiteStyles"] });

  // ── Quick commands ───────────────────────────────────────────────────────

  globalThis.AgentExtras.commands.push(
    { group: "Design", icon: "🧪", name: "What colours and fonts does this page use?", prompt: "What colours and fonts does this page use? Extract its palette (browser_palette_extract) and describe it: the main text and background colours, the accent, the font families and the type scale, the spacing rhythm — in a few lines, then the CSS variables block." },
    { group: "Design", icon: "🔍", name: "Check this page's contrast", prompt: "Check this page's text contrast against WCAG 2 AA (browser_palette_contrast). List what fails with the ratio and where it is, and propose a fix for each (a colour of the same hue that passes) — apply the fixes as style overrides only if I ask." },
    { group: "Design", icon: "🌙", name: "Dark theme for this site", prompt: "Give this site a dark theme: build it from the page's own palette with browser_palette_theme mode=dark (it is saved as the site's 'theme:dark' override and kept), take a screenshot, and fix anything that stayed light or became unreadable with targeted browser_style_apply rules — never an invert filter on the whole page, images must stay as they are." },
    { group: "Design", icon: "🎯", name: "Colour harmonies from this site's accent", prompt: "Take this site's accent colour and show me its harmonies (browser_palette_harmony with no arguments picks the accent and the background from the page): complementary, split-complementary, analogous, triadic, tetradic, tints and shades, each with its contrast against the page background. Recommend one for a hover state and one for a secondary button, and give me the :root variables block." },
    { group: "Design", icon: "🧬", name: "Design tokens of this page", prompt: "List this page's design tokens (browser_palette_tokens): the CSS custom properties its stylesheets declare — colours, lengths, fonts — with their values and how often each is used. Point out the ones worth changing for a different look (the accent, the background, the radius, the font) and how to change one everywhere with browser_style_tokens." },
    { group: "Design", icon: "🖌", name: "Recolor this site…", prompt: "Recolor this site: replace one colour with another everywhere it is used for text, backgrounds and borders (browser_palette_recolor from=… to=…; when I name the colour loosely, find the exact one with browser_palette_extract first), take a screenshot and fix a missed or wrong spot with a small browser_style_apply rule. Replace: ", partial: true },
    { group: "Design", icon: "🖼", name: "Palette from this image", prompt: "Take the dominant colours of the main image on this page (browser_palette_from_image; pass a ref if I point at an image) and show them with their share and their contrast against the page background. Suggest which could be the accent, the background and the text colour, and give me the :root variables block. If the image cannot be read in the page (another origin without CORS), say so and describe its colours from a screenshot instead." }
  );

  // ── Exports: the pure parts, for tests and other modules ──────────────────

  globalThis.AgentExtras.palette = {
    MAX_SAMPLE: MAX_SAMPLE, THEME_PREFIX: THEME_PREFIX, MODES: MODES, TOKEN_NAMES: TOKEN_NAMES,
    parseColor: parseColor, normalizeColor: normalizeColor, toHex: toHex, rgbToHsl: rgbToHsl, hslToRgb: hslToRgb, hslHex: hslHex,
    luminance: luminance, contrastRatio: contrastRatio, blend: blend, effectiveBackground: effectiveBackground, isLargeText: isLargeText, threshold: threshold,
    summarizePalette: summarizePalette, formatPalette: formatPalette, cssVariables: cssVariables,
    evaluateContrast: evaluateContrast, formatContrast: formatContrast, suggestText: suggestText,
    tokensFor: tokensFor, mapBg: mapBg, mapText: mapText, mapBorder: mapBorder, themeCss: themeCss, formatMapping: formatMapping, themesOf: themesOf,
    harmony: harmony, accentOf: accentOf, harmonyVars: harmonyVars, formatHarmony: formatHarmony, mix: mix,
    MAX_TOKENS: MAX_TOKENS, TOP_TOKENS: TOP_TOKENS, MAX_SELECTORS: MAX_SELECTORS, IMAGE_SIDE: IMAGE_SIDE, RECOLOR_PROPS: RECOLOR_PROPS,
    tokenKind: tokenKind, groupTokens: groupTokens, rankTokens: rankTokens, formatTokens: formatTokens,
    colorDistance: colorDistance, recolorProps: recolorProps, recolorCss: recolorCss, recolorName: recolorName,
    quantize: quantize, formatImagePalette: formatImagePalette, imageWords: imageWords,
    extract: extract, contrast: contrast, applyTheme: applyTheme,
    pageExtractPalette: pageExtractPalette, pageContrast: pageContrast, pageTokens: pageTokens, pageRecolor: pageRecolor, pageImagePixels: pageImagePixels,
  };
})();
