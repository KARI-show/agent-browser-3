// Extra feature "palette" (side panel): what the page is made of — colours, fonts, spacing — WCAG 2
// contrast, and themes (dark, sepia, high contrast, custom) built on the extracted palette and applied
// through the styles extra's overrides (the same agentSiteStyles key, name "theme:<mode>"), so a theme
// persists like any other override and shows up in the 🎨 tab. Built into extras.js only for brands that
// switch the feature on (which need "styles" too — browser/brand.mjs FEATURE_REQUIRES); the tools are
// declared in browser/host/extras/palette.ts. Also adds the 🧪 Palette tab of the 🧩 panel and the
// "Design" quick commands. styles.js is concatenated before this file (OPT_IN_FEATURES order), so
// AgentExtras.styles is defined by now.
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
    { group: "Design", icon: "🌙", name: "Dark theme for this site", prompt: "Give this site a dark theme: build it from the page's own palette with browser_palette_theme mode=dark (it is saved as the site's 'theme:dark' override and kept), take a screenshot, and fix anything that stayed light or became unreadable with targeted browser_style_apply rules — never an invert filter on the whole page, images must stay as they are." }
  );

  // ── Exports: the pure parts, for tests and other modules ──────────────────

  globalThis.AgentExtras.palette = {
    MAX_SAMPLE: MAX_SAMPLE, THEME_PREFIX: THEME_PREFIX, MODES: MODES, TOKEN_NAMES: TOKEN_NAMES,
    parseColor: parseColor, normalizeColor: normalizeColor, toHex: toHex, rgbToHsl: rgbToHsl, hslToRgb: hslToRgb, hslHex: hslHex,
    luminance: luminance, contrastRatio: contrastRatio, blend: blend, effectiveBackground: effectiveBackground, isLargeText: isLargeText, threshold: threshold,
    summarizePalette: summarizePalette, formatPalette: formatPalette, cssVariables: cssVariables,
    evaluateContrast: evaluateContrast, formatContrast: formatContrast, suggestText: suggestText,
    tokensFor: tokensFor, mapBg: mapBg, mapText: mapText, mapBorder: mapBorder, themeCss: themeCss, formatMapping: formatMapping, themesOf: themesOf,
    extract: extract, contrast: contrast, applyTheme: applyTheme,
    pageExtractPalette: pageExtractPalette, pageContrast: pageContrast,
  };
})();
