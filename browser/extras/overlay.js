// Extra feature "overlay" (side panel): layout overlays for design review — a column/baseline grid,
// measurements between two elements, numbered review notes and a design image to compare against, all
// drawn in ONE click-through layer (<div data-agent-overlay>, pointer-events: none, a very high z-index)
// on the page for this visit only, and labelled outlines around every element of a kind in the same layer;
// plus a viewport resize of the tab's window for device previews and responsive captures (the window
// resized per width, the page captured — scrolled and stitched on a canvas of the panel for the full page —
// and the window put back). Nothing is persisted; browser_overlay_clear or a reload removes everything. Built into extras.js only
// for brands that switch the feature on; the tools are declared in browser/host/extras/overlay.ts. Also
// adds the 📐 Overlay tab of the 🧩 panel and its "Design" quick commands.
//
// The geometry (grid columns, gaps, alignment hints) is computed here in pure functions, exposed on
// AgentExtras.overlay for the unit tests; the page-side functions only read rectangles and draw what
// they are given. Those functions are injected with chrome.scripting.executeScript and are
// self-contained. The tab's DOM is built with ctx.el (note texts come from the model).
(function () {
  if (!globalThis.AGENT_BRAND || !globalThis.AGENT_BRAND.has("overlay")) return;
  var T = globalThis.AgentBrowserTools;
  var X = globalThis.AgentExtras;
  if (!T || !X) return;
  var H = T.helpers;
  var text = H.text;

  var DEFAULT_COLOR = "#ff2d78";
  var BOX_COLORS = ["#1e90ff", "#ff8c00"]; // A, B
  var STALE = "That element is gone — the page changed. Call browser_read_page again.";
  var LAYERS = ["grid", "measure", "notes", "image", "outline"];
  var OUTLINE_KINDS = ["headings", "links", "buttons", "images", "forms", "landmarks"];
  var OUTLINE_COLORS = { headings: "#e00060", links: "#1e90ff", buttons: "#ff8c00", images: "#19a974", forms: "#8e44ad", landmarks: "#555555" };
  var OUTLINE_SAMPLE = 10; // items per kind in the report
  var RESPONSIVE_WIDTHS = [375, 768, 1280];
  var RESPONSIVE_MAX = 6; // widths per call
  var STITCH_MAX = 8; // screens per width for a full-page capture
  var MAX_STITCH_SIDE = 4000; // device px: a longer image is scaled down
  var VIEWPORTS = { mobile: [375, 812], "mobile-landscape": [812, 375], tablet: [768, 1024], laptop: [1280, 800], desktop: [1440, 900] };
  var VIEWPORT_MIN = 320, VIEWPORT_MAX = 3840;
  var VIEWPORT_KEY = "agentOverlayViewport:"; // + windowId → the window's bounds before its first resize (chrome.storage.session, or local)
  var IMAGE_TIMEOUT = 15000;

  // ── Pure helpers ─────────────────────────────────────────────────────────

  function round(n) { return Math.round(n * 100) / 100; }
  function isHexColor(c) { return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(c || "").trim()); }
  /** "#ff2d78" (or "#f27") with an alpha → "rgba(255, 45, 120, 0.12)". */
  function hexToRgba(hex, alpha) {
    var h = String(hex).trim().slice(1);
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return "rgba(" + (n >> 16) + ", " + ((n >> 8) & 255) + ", " + (n & 255) + ", " + alpha + ")";
  }
  function num(v, def, min, max, name) {
    if (v === undefined || v === null || v === "") return def;
    var n = Number(v);
    if (!isFinite(n) || n < min || n > max) throw new Error(name + " must be a number between " + min + " and " + max + ".");
    return n;
  }
  /** The grid options a call asks for, validated and defaulted. */
  function gridOptions(a) {
    a = a || {};
    var color = a.color === undefined || a.color === null || a.color === "" ? DEFAULT_COLOR : String(a.color).trim();
    if (!isHexColor(color)) throw new Error("color must be a hex colour like #ff2d78.");
    return {
      columns: Math.round(num(a.columns, 12, 1, 24, "columns")),
      gutter: num(a.gutter, 24, 0, 200, "gutter"),
      maxWidth: num(a.maxWidth, 1200, 0, 4000, "maxWidth"),
      baseline: num(a.baseline, 0, 0, 100, "baseline"),
      color: color,
      fill: hexToRgba(color, 0.12),
      line: hexToRgba(color, 0.65),
    };
  }
  /** Column geometry of a centred grid in a viewport: { left, width, colWidth, xs }. */
  function gridGeometry(o) {
    var columns = o.columns, gutter = o.gutter || 0, viewport = o.viewport;
    var width = o.maxWidth > 0 ? Math.min(o.maxWidth, viewport) : viewport;
    var left = (viewport - width) / 2;
    var colWidth = (width - gutter * (columns - 1)) / columns;
    var xs = [];
    for (var i = 0; i < columns; i++) xs.push(round(left + i * (colWidth + gutter)));
    return { columns: columns, gutter: gutter, viewport: viewport, left: round(left), width: round(width), colWidth: round(colWidth), xs: xs };
  }
  function formatGrid(o, g) {
    return "Grid on: " + o.columns + " column" + (o.columns === 1 ? "" : "s") + ", " + o.gutter + " px gutters, " +
      (o.maxWidth > 0 ? "max width " + o.maxWidth + " px, " : "full width, ") + "centred in a " + g.viewport + " px viewport — columns " + g.colWidth +
      " px wide at x = " + g.xs.join(", ") + (o.columns > 1 ? " (every " + round(g.colWidth + o.gutter) + " px" : " (") + "; the grid spans " + g.left + "–" + round(g.left + g.width) + " px)." +
      (o.baseline > 0 ? " Baseline grid every " + o.baseline + " px." : "") +
      " It stays fixed to the viewport while the page scrolls. Take a browser_screenshot to see it; browser_overlay_grid on=false removes it.";
  }

  function box(r) { return { left: round(r.left), top: round(r.top), width: round(r.width), height: round(r.height), right: round(r.left + r.width), bottom: round(r.top + r.height), cx: round(r.left + r.width / 2), cy: round(r.top + r.height / 2) }; }
  function near(u, v) { return Math.abs(u - v) <= 1; }
  /**
   * Sizes, gaps/overlaps, offsets and alignment hints of box A and (optionally) B, plus the gap
   * segments to draw ({ dir, x1, y1, x2, y2, label }). Rectangles are { left, top, width, height }.
   */
  function measureBoxes(ra, rb) {
    var a = box(ra);
    var out = { a: a, b: null, gapX: null, gapY: null, overlapX: null, overlapY: null, dx: null, dy: null, sideX: "", sideY: "", hints: [], segments: [] };
    if (!rb) return out;
    var b = box(rb);
    out.b = b;
    out.dx = round(b.left - a.left);
    out.dy = round(b.top - a.top);
    if (b.left >= a.right) { out.gapX = round(b.left - a.right); out.sideX = "right"; }
    else if (a.left >= b.right) { out.gapX = round(a.left - b.right); out.sideX = "left"; }
    else out.overlapX = round(Math.min(a.right, b.right) - Math.max(a.left, b.left));
    if (b.top >= a.bottom) { out.gapY = round(b.top - a.bottom); out.sideY = "below"; }
    else if (a.top >= b.bottom) { out.gapY = round(a.top - b.bottom); out.sideY = "above"; }
    else out.overlapY = round(Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    if (near(a.left, b.left)) out.hints.push("same left edge");
    if (near(a.right, b.right)) out.hints.push("same right edge");
    if (near(a.cx, b.cx)) out.hints.push("same horizontal centre");
    if (near(a.top, b.top)) out.hints.push("same top edge");
    if (near(a.bottom, b.bottom)) out.hints.push("same bottom edge");
    if (near(a.cy, b.cy)) out.hints.push("same vertical centre");
    if (near(a.width, b.width)) out.hints.push("same width");
    if (near(a.height, b.height)) out.hints.push("same height");
    if (out.gapX !== null) {
      var y = out.overlapY !== null ? (Math.max(a.top, b.top) + Math.min(a.bottom, b.bottom)) / 2 : a.cy;
      var x1 = out.sideX === "right" ? a.right : b.right, x2 = out.sideX === "right" ? b.left : a.left;
      out.segments.push({ dir: "x", x1: round(x1), y1: round(y), x2: round(x2), y2: round(y), label: out.gapX + " px" });
    }
    if (out.gapY !== null) {
      var x = out.overlapX !== null ? (Math.max(a.left, b.left) + Math.min(a.right, b.right)) / 2 : a.cx;
      var y1 = out.sideY === "below" ? a.bottom : b.bottom, y2 = out.sideY === "below" ? b.top : a.top;
      out.segments.push({ dir: "y", x1: round(x), y1: round(y1), x2: round(x), y2: round(y2), label: out.gapY + " px" });
    }
    return out;
  }
  function itemWords(it) { return (it.tag || "element") + (it.text ? ' "' + it.text + '"' : ""); }
  function sizeWords(bx) { return bx.width + " × " + bx.height + " px at (" + bx.left + ", " + bx.top + ")"; }
  /** The browser_overlay_measure report. `items` are the page's rectangles with tag/text. */
  function formatMeasure(m, items) {
    var lines = ["A: " + itemWords(items[0]) + " — " + sizeWords(m.a)];
    if (!m.b) return lines.concat(["Drawn on the page (box with its size). Take a browser_screenshot to see it; pass refB/selectorB to measure the distance to a second element."]).join("\n");
    lines.push("B: " + itemWords(items[1]) + " — " + sizeWords(m.b));
    lines.push("Horizontal: " + (m.gapX !== null ? "B is " + m.sideX + " of A, gap " + m.gapX + " px" : "the boxes overlap by " + m.overlapX + " px") +
      ". Vertical: " + (m.gapY !== null ? "B is " + m.sideY + " A, gap " + m.gapY + " px" : "the boxes overlap by " + m.overlapY + " px") + ".");
    lines.push("Offset of B from A (top-left corners): dx " + m.dx + " px, dy " + m.dy + " px.");
    lines.push("Alignment: " + (m.hints.length ? m.hints.join(", ") : "no edges or centres align within 1 px") + ".");
    lines.push("Drawn on the page (boxes with sizes, gap lines with their px). Take a browser_screenshot to see it.");
    return lines.join("\n");
  }

  /** The number of the next review note: one more than the highest so far (numbers are never reused). */
  function nextNoteNumber(notes) {
    var max = 0;
    (notes || []).forEach(function (n) { if (Number(n.n) > max) max = Number(n.n); });
    return max + 1;
  }
  function formatNotes(notes) {
    if (!notes || !notes.length) return "No review notes on the page.";
    return "Review notes on the page (" + notes.length + "):\n" + notes.map(function (n) { return "#" + n.n + " " + n.text + " — at (" + Math.round(n.x) + ", " + Math.round(n.y) + ")"; }).join("\n");
  }

  /** The image overlay a call asks for, validated and defaulted: url (https: or data:image), opacity, x, y, width (0 = natural), align, lock, fixed. */
  function imageOptions(a) {
    a = a || {};
    var url = String(a.url == null ? "" : a.url).trim();
    if (/^data:/i.test(url)) url = url.replace(/\s+/g, "");
    if (!url) throw new Error("url is required — an https: or data:image URL of the design image.");
    if (!/^https:\/\/[^\s"'<>]+$/i.test(url) && !/^data:image\/[a-z0-9.+-]+[;,]\S*$/i.test(url)) throw new Error("url must be an https: URL or a data:image/… URL (attached files are not reachable here — pass a URL).");
    var align = a.align === undefined || a.align === null || a.align === "" ? "top-left" : String(a.align);
    if (align !== "top-left" && align !== "top-center") throw new Error("align must be top-left or top-center.");
    return {
      url: url,
      opacity: num(a.opacity, 0.5, 0.05, 1, "opacity"),
      x: num(a.x, 0, -10000, 10000, "x"),
      y: num(a.y, 0, -10000, 100000, "y"),
      width: num(a.width, 0, 1, 10000, "width"),
      align: align,
      lock: a.lock !== false,
      fixed: a.fixed === true,
    };
  }
  function formatImage(r, o) {
    return "Image overlay on: " + r.width + " × " + r.height + " px" + (r.natural.width !== r.width ? " (natural " + r.natural.width + " × " + r.natural.height + ")" : "") +
      " at (" + r.left + ", " + r.top + ") of the " + (o.fixed ? "viewport, fixed to it" : "document, scrolling with the page") + ", opacity " + o.opacity + ", " + o.align +
      (o.x || o.y ? " with offset " + o.x + ", " + o.y : "") + ", " + (o.lock ? "click-through" : "catching the pointer") +
      ". Take a browser_screenshot to compare it with the page; browser_overlay_clear only=image removes it, another call replaces it.";
  }

  /** What a browser_overlay_viewport call asks for: { reset: true } or { preset, width, height } (height 0 = unchanged). */
  function viewportRequest(a) {
    a = a || {};
    var preset = a.preset === undefined || a.preset === null || a.preset === "" ? "" : String(a.preset);
    if (preset === "reset") return { reset: true };
    if (preset) {
      if (!VIEWPORTS[preset]) throw new Error("preset must be one of " + Object.keys(VIEWPORTS).join(", ") + " or reset.");
      return { preset: preset, width: VIEWPORTS[preset][0], height: VIEWPORTS[preset][1] };
    }
    if (a.width === undefined || a.width === null || a.width === "") throw new Error("Give preset (" + Object.keys(VIEWPORTS).join(", ") + ", reset) or width (and height) in px.");
    return { preset: "", width: Math.round(num(a.width, 0, VIEWPORT_MIN, VIEWPORT_MAX, "width")), height: Math.round(num(a.height, 0, VIEWPORT_MIN, VIEWPORT_MAX, "height")) };
  }
  /** Window bounds that give the viewport `want` with the chrome `info` shows around the page (outer − inner: tabs, toolbars, the side panel). */
  function boundsFor(want, info) {
    var chromeW = Math.max(0, (info.outerWidth || 0) - (info.innerWidth || 0)), chromeH = Math.max(0, (info.outerHeight || 0) - (info.innerHeight || 0));
    var b = { width: want.width + chromeW };
    if (want.height) b.height = want.height + chromeH;
    return b;
  }
  function viewportWords(info) { return "Viewport " + info.innerWidth + " × " + info.innerHeight + " px, devicePixelRatio " + info.dpr + "."; }
  function viewportOff(want, info) { return info.innerWidth !== want.width || (want.height > 0 && info.innerHeight !== want.height); }

  /** What browser_overlay_outline draws: the kinds ("all" = every kind) and a colour per kind (one given colour for all, else the palette). */
  function outlineOptions(a) {
    a = a || {};
    var what = a.what === undefined || a.what === null ? "" : String(a.what);
    if (!what) throw new Error("what is required — one of " + OUTLINE_KINDS.join(", ") + " or all.");
    if (what !== "all" && OUTLINE_KINDS.indexOf(what) === -1) throw new Error("what must be one of " + OUTLINE_KINDS.join(", ") + " or all.");
    var color = a.color === undefined || a.color === null || a.color === "" ? "" : String(a.color).trim();
    if (color && !isHexColor(color)) throw new Error("color must be a hex colour like #ff2d78.");
    var kinds = what === "all" ? OUTLINE_KINDS.slice() : [what];
    var colors = {};
    kinds.forEach(function (k) { colors[k] = color || OUTLINE_COLORS[k]; });
    return { what: what, kinds: kinds, colors: colors };
  }
  var KIND_WORDS = { headings: "heading", links: "link", buttons: "button", images: "image", forms: "form", landmarks: "landmark" };
  function plural(n, word) { return n + " " + word + (n === 1 ? "" : "s"); }
  /** The browser_overlay_outline report: the count per kind and the first few of each with their label and text. */
  function formatOutline(r, o) {
    var counts = r.counts || {}, items = r.items || {};
    var total = o.kinds.reduce(function (s, k) { return s + (counts[k] || 0); }, 0);
    if (!total) return "No " + (o.what === "all" ? "headings, links, buttons, images, forms or landmarks" : o.what) + " on the page — nothing outlined.";
    var lines = ["Outlined " + plural(total, "element") + ": " + o.kinds.map(function (k) { return plural(counts[k] || 0, KIND_WORDS[k]); }).join(", ") + "."];
    o.kinds.forEach(function (k) {
      var n = counts[k] || 0, list = items[k] || [];
      if (!n) return;
      lines.push(k[0].toUpperCase() + k.slice(1) + " (" + n + (n > list.length ? ", first " + list.length : "") + ", " + o.colors[k] + "): " + list.map(function (it) { return it.label + (it.text ? ' "' + it.text + '"' : ""); }).join(", "));
    });
    lines.push("Take a browser_screenshot to see the outlines; browser_overlay_clear only=outline (or off=true here) removes them, another call replaces them.");
    return lines.join("\n");
  }

  /** What browser_overlay_responsive captures: the widths (whole px, 320–3840, duplicates dropped, at most 6), fullPage and save. */
  function responsiveRequest(a) {
    a = a || {};
    var widths = a.widths === undefined || a.widths === null ? RESPONSIVE_WIDTHS.slice() : a.widths;
    if (!Array.isArray(widths) || !widths.length) throw new Error("widths must be an array of viewport widths in px, e.g. [375, 768, 1280].");
    var out = [];
    widths.forEach(function (w) {
      if (w === undefined || w === null || w === "") throw new Error("each width must be a number between " + VIEWPORT_MIN + " and " + VIEWPORT_MAX + ".");
      var n = Math.round(num(w, 0, VIEWPORT_MIN, VIEWPORT_MAX, "each width"));
      if (out.indexOf(n) === -1) out.push(n);
    });
    if (out.length > RESPONSIVE_MAX) throw new Error("widths: at most " + RESPONSIVE_MAX + " per call.");
    return { widths: out, fullPage: a.fullPage === true, save: a.save === true };
  }
  /**
   * The scroll offsets of a full-page capture: viewport-high steps from the top, the last one ending at the page's
   * bottom, at most `max` of them (then the image stops there: `cut`). → { offsets, height, cut }
   */
  function stitchPlan(pageHeight, viewportHeight, max) {
    var offsets = [0];
    if (viewportHeight > 0) {
      while (offsets[offsets.length - 1] + viewportHeight < pageHeight && offsets.length < max) {
        offsets.push(Math.min(offsets[offsets.length - 1] + viewportHeight, pageHeight - viewportHeight));
      }
    }
    var height = Math.min(pageHeight, offsets[offsets.length - 1] + viewportHeight);
    return { offsets: offsets, height: height, cut: height < pageHeight };
  }
  function hostOf(url) {
    try { var u = new URL(url); return /^https?:$/.test(u.protocol) ? u.hostname.replace(/^www\./, "").toLowerCase() : ""; } catch (_) { return ""; }
  }
  /** "20261029-143005" — local time, for a file name. */
  function fileStamp(ts) {
    var d = new Date(ts);
    function p(n) { return (n < 10 ? "0" : "") + n; }
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }
  function responsiveName(host, width, fullPage, ts) { return (host || "page").replace(/[^\w.-]+/g, "_") + "-" + width + "px" + (fullPage ? "-full" : "") + "-" + fileStamp(ts) + ".png"; }

  // ── Page side (self-contained; injected with chrome.scripting.executeScript) ──

  // The page's viewport and the window around it, as the page sees them.
  function pageViewportInfo() {
    return { innerWidth: window.innerWidth, innerHeight: window.innerHeight, outerWidth: window.outerWidth, outerHeight: window.outerHeight, dpr: window.devicePixelRatio || 1 };
  }

  // The design image at document (or, fixed, viewport) coordinates once it has loaded; replaces an earlier one. Returns a
  // promise — executeScript waits for it. → { natural: { width, height }, width, height, left, top } or { error }
  function pageOverlayImage(o) {
    return new Promise(function (resolve) {
      var img = document.createElement("img");
      var done = false;
      var timer = setTimeout(function () { finish({ error: "The image did not load within " + o.timeout / 1000 + " s — check the URL (" + o.url.slice(0, 80) + ")." }); }, o.timeout);
      function finish(r) { if (done) return; done = true; clearTimeout(timer); resolve(r); }
      img.onerror = function () { finish({ error: "The image could not be loaded (" + o.url.slice(0, 80) + ") — check the URL; a page's content security policy can also keep outside images out." }); };
      img.onload = function () {
        var nw = img.naturalWidth || 0, nh = img.naturalHeight || 0;
        if (!nw || !nh) { finish({ error: "The URL did not give an image (" + o.url.slice(0, 80) + ")." }); return; }
        var width = o.width > 0 ? o.width : nw;
        var height = Math.round(width * nh / nw * 100) / 100;
        var page = document.documentElement.clientWidth || window.innerWidth;
        var left = Math.round(((o.align === "top-center" ? (page - width) / 2 : 0) + o.x) * 100) / 100;
        var root = document.querySelector("[data-agent-overlay]");
        if (!root) {
          root = document.createElement("div");
          root.setAttribute("data-agent-overlay", "");
          root.setAttribute("style", "position:absolute;left:0;top:0;width:0;height:0;overflow:visible;pointer-events:none;z-index:2147483646;");
          document.documentElement.appendChild(root);
        }
        var old = root.querySelector("[data-agent-overlay-image]");
        if (old) old.parentNode.removeChild(old);
        var layer = document.createElement("div");
        layer.setAttribute("data-agent-overlay-image", "");
        layer.setAttribute("style", "position:" + (o.fixed ? "fixed" : "absolute") + ";left:" + left + "px;top:" + o.y + "px;width:" + width + "px;height:" + height + "px;pointer-events:" + (o.lock ? "none" : "auto") + ";");
        img.setAttribute("alt", "");
        img.setAttribute("style", "display:block;width:100%;height:100%;opacity:" + o.opacity + ";pointer-events:inherit;");
        layer.appendChild(img);
        root.appendChild(layer);
        finish({ natural: { width: nw, height: nh }, width: width, height: height, left: left, top: o.y });
      };
      img.src = o.url;
    });
  }

  // The page's layout at the current viewport: the viewport, the document's scroll size (horizontal overflow = scrollWidth
  // beyond innerWidth), the scroll position and devicePixelRatio.
  function pageLayoutInfo() {
    var de = document.documentElement, body = document.body;
    return {
      innerWidth: window.innerWidth, innerHeight: window.innerHeight,
      scrollWidth: (de && de.scrollWidth) || window.innerWidth,
      scrollHeight: Math.max((de && de.scrollHeight) || 0, (body && body.scrollHeight) || 0, window.innerHeight),
      scrollX: window.scrollX || 0, scrollY: window.scrollY || 0, dpr: window.devicePixelRatio || 1,
    };
  }
  // Scroll the page to (x, y) at once and report where it landed.
  function pageScrollTo(x, y) {
    try { window.scrollTo({ left: x, top: y, behavior: "instant" }); } catch (_) { window.scrollTo(x, y); }
    return { scrollX: window.scrollX || 0, scrollY: window.scrollY || 0 };
  }

  // Labelled outline boxes around every element of `kinds` (document coordinates, `colors[kind]` each), in the overlay
  // container; replaces earlier outlines. → { counts: { kind: n }, items: { kind: [{ label, text }] (the first `sample`) } }
  function pageOverlayOutline(kinds, colors, sample) {
    var sx = window.scrollX || 0, sy = window.scrollY || 0;
    var SEL = {
      headings: 'h1, h2, h3, h4, h5, h6, [role="heading"]',
      links: "a[href]",
      buttons: 'button, input[type="button"], input[type="submit"], input[type="reset"], [role="button"]',
      images: 'img, [role="img"]',
      forms: "form",
      landmarks: 'header, nav, main, aside, footer, [role="banner"], [role="navigation"], [role="main"], [role="complementary"], [role="contentinfo"]',
    };
    function clean(s) { return String(s || "").replace(/\s+/g, " ").trim().slice(0, 40); }
    function textOf(kind, el) {
      if (kind === "images") return clean(el.getAttribute("alt") || el.getAttribute("aria-label") || String(el.getAttribute("src") || "").split("/").pop());
      if (kind === "forms") return clean(el.getAttribute("aria-label") || el.getAttribute("name") || el.id || String(el.getAttribute("action") || "").split("/").pop());
      return clean(el.innerText || el.textContent || el.getAttribute("aria-label") || el.getAttribute("value") || el.getAttribute("title"));
    }
    function labelOf(kind, el, i, r) {
      if (kind === "headings") return /^h[1-6]$/.test(el.localName) ? el.localName : "h" + (el.getAttribute("aria-level") || 2);
      if (kind === "links" || kind === "buttons") return String(i + 1);
      if (kind === "images") return Math.round(r.width) + "×" + Math.round(r.height);
      if (kind === "forms") { var fields = el.querySelectorAll("input, select, textarea").length - el.querySelectorAll('input[type="hidden"]').length; return fields + " field" + (fields === 1 ? "" : "s"); }
      return /^(header|nav|main|aside|footer)$/.test(el.localName) ? el.localName : el.getAttribute("role") || el.localName;
    }
    var root = document.querySelector("[data-agent-overlay]");
    if (!root) {
      root = document.createElement("div");
      root.setAttribute("data-agent-overlay", "");
      root.setAttribute("style", "position:absolute;left:0;top:0;width:0;height:0;overflow:visible;pointer-events:none;z-index:2147483646;");
      document.documentElement.appendChild(root);
    }
    var old = root.querySelector("[data-agent-overlay-outline]");
    if (old) old.parentNode.removeChild(old);
    var layer = document.createElement("div");
    layer.setAttribute("data-agent-overlay-outline", "");
    layer.setAttribute("style", "position:absolute;left:0;top:0;width:0;height:0;pointer-events:none;font:600 11px/1.2 system-ui,sans-serif;");
    var counts = {}, items = {};
    kinds.forEach(function (kind) {
      var color = colors[kind];
      var els = Array.prototype.filter.call(document.querySelectorAll(SEL[kind]), function (el) {
        if (el.closest && el.closest("[data-agent-overlay]")) return false;
        var r = el.getBoundingClientRect();
        return !!(r.width && r.height);
      });
      counts[kind] = els.length;
      items[kind] = [];
      els.forEach(function (el, i) {
        var r = el.getBoundingClientRect();
        var label = labelOf(kind, el, i, r);
        if (i < sample) items[kind].push({ label: label, text: textOf(kind, el) });
        var bx = document.createElement("div");
        bx.setAttribute("data-agent-outline", kind);
        bx.setAttribute("style", "position:absolute;left:" + (r.left + sx) + "px;top:" + (r.top + sy) + "px;width:" + r.width + "px;height:" + r.height + "px;box-sizing:border-box;outline:2px solid " + color + ";outline-offset:-1px;");
        var tag = document.createElement("div");
        tag.textContent = label;
        tag.setAttribute("style", "position:absolute;left:0;top:0;padding:1px 5px;background:" + color + ";color:#fff;white-space:nowrap;border-radius:0 0 3px 0;");
        bx.appendChild(tag);
        layer.appendChild(bx);
      });
    });
    root.appendChild(layer);
    return { counts: counts, items: items };
  }

  // Rectangles of the targets ([{ local, selector }]) in document coordinates, with tag and text, plus the scroll and viewport.
  function pageRects(targets) {
    var sx = window.scrollX || 0, sy = window.scrollY || 0;
    var items = (targets || []).map(function (t) {
      var el = null;
      if (t.local) {
        el = (window.__agentRefs || [])[t.local - 1];
        if (el && !el.isConnected) el = null;
        if (!el) return { error: "stale" };
      } else {
        try { el = document.querySelector(t.selector); } catch (_) { return { error: "Invalid CSS selector: " + t.selector }; }
        if (!el) return { error: 'Nothing on the page matches the selector "' + t.selector + '". Check it with browser_read_page.' };
      }
      var r = el.getBoundingClientRect();
      return { left: r.left + sx, top: r.top + sy, width: r.width, height: r.height, tag: el.localName, text: String(el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40) };
    });
    return { scrollX: sx, scrollY: sy, viewport: { width: window.innerWidth, height: window.innerHeight }, items: items };
  }

  // The column grid (fixed to the viewport, centred) and the baseline grid. Replaces a grid already there.
  function pageOverlayGrid(o) {
    var root = document.querySelector("[data-agent-overlay]");
    if (!root) {
      root = document.createElement("div");
      root.setAttribute("data-agent-overlay", "");
      root.setAttribute("style", "position:absolute;left:0;top:0;width:0;height:0;overflow:visible;pointer-events:none;z-index:2147483646;");
      document.documentElement.appendChild(root);
    }
    var old = root.querySelector("[data-agent-overlay-grid]");
    if (old) old.parentNode.removeChild(old);
    var layer = document.createElement("div");
    layer.setAttribute("data-agent-overlay-grid", "");
    layer.setAttribute("style", "position:fixed;left:0;top:0;right:0;bottom:0;pointer-events:none;");
    if (o.baseline > 0) {
      var base = document.createElement("div");
      base.setAttribute("data-agent-grid-baseline", "");
      base.setAttribute("style", "position:absolute;left:0;top:0;right:0;bottom:0;background-image:repeating-linear-gradient(to bottom," + o.line + " 0," + o.line + " 1px,transparent 1px,transparent " + o.baseline + "px);");
      layer.appendChild(base);
    }
    var cols = document.createElement("div");
    cols.setAttribute("data-agent-grid-cols", "");
    cols.setAttribute("style", "position:absolute;left:0;right:0;top:0;bottom:0;margin:0 auto;display:flex;gap:" + o.gutter + "px;" + (o.maxWidth > 0 ? "max-width:" + o.maxWidth + "px;" : ""));
    for (var i = 0; i < o.columns; i++) {
      var c = document.createElement("div");
      c.setAttribute("data-agent-grid-col", String(i + 1));
      c.setAttribute("style", "flex:1 1 0;min-width:0;background:" + o.fill + ";border-left:1px solid " + o.line + ";border-right:1px solid " + o.line + ";box-sizing:border-box;");
      cols.appendChild(c);
    }
    layer.appendChild(cols);
    root.appendChild(layer);
    return { viewport: window.innerWidth, columns: o.columns };
  }

  // Boxes with size labels and the gap segments, in document coordinates. Replaces earlier measurements.
  function pageDrawMeasure(d) {
    var root = document.querySelector("[data-agent-overlay]");
    if (!root) {
      root = document.createElement("div");
      root.setAttribute("data-agent-overlay", "");
      root.setAttribute("style", "position:absolute;left:0;top:0;width:0;height:0;overflow:visible;pointer-events:none;z-index:2147483646;");
      document.documentElement.appendChild(root);
    }
    var old = root.querySelector("[data-agent-overlay-measure]");
    if (old) old.parentNode.removeChild(old);
    var layer = document.createElement("div");
    layer.setAttribute("data-agent-overlay-measure", "");
    layer.setAttribute("style", "position:absolute;left:0;top:0;width:0;height:0;pointer-events:none;font:600 12px/1 system-ui,sans-serif;");
    var font = "font:600 12px/1 system-ui,sans-serif;";
    d.items.forEach(function (it, i) {
      var color = d.colors[i % d.colors.length];
      var bx = document.createElement("div");
      bx.setAttribute("data-agent-box", String(i));
      bx.setAttribute("style", "position:absolute;left:" + it.left + "px;top:" + it.top + "px;width:" + it.width + "px;height:" + it.height + "px;box-sizing:border-box;outline:2px solid " + color + ";outline-offset:-1px;background:" + color + "14;");
      var label = document.createElement("div");
      label.textContent = (i === 0 ? "A " : "B ") + Math.round(it.width) + " × " + Math.round(it.height);
      label.setAttribute("style", "position:absolute;left:0;top:-18px;padding:2px 6px;background:" + color + ";color:#fff;white-space:nowrap;border-radius:3px;" + font);
      bx.appendChild(label);
      layer.appendChild(bx);
    });
    (d.segments || []).forEach(function (s) {
      var horizontal = s.dir === "x";
      var len = horizontal ? s.x2 - s.x1 : s.y2 - s.y1;
      var line = document.createElement("div");
      line.setAttribute("data-agent-gap", s.dir);
      line.setAttribute("style", "position:absolute;left:" + (horizontal ? s.x1 : s.x1 - 1) + "px;top:" + (horizontal ? s.y1 - 1 : s.y1) + "px;width:" + (horizontal ? len : 2) + "px;height:" + (horizontal ? 2 : len) + "px;background:#e00060;" +
        (horizontal ? "border-left:2px solid #e00060;border-right:2px solid #e00060;" : "border-top:2px solid #e00060;border-bottom:2px solid #e00060;") + "box-sizing:content-box;");
      var tag = document.createElement("div");
      tag.textContent = s.label;
      tag.setAttribute("style", "position:absolute;left:" + (horizontal ? s.x1 + len / 2 : s.x1 + 8) + "px;top:" + (horizontal ? s.y1 - 24 : s.y1 + len / 2 - 8) + "px;" + (horizontal ? "transform:translateX(-50%);" : "") + "padding:2px 6px;background:#e00060;color:#fff;white-space:nowrap;border-radius:3px;" + font);
      layer.appendChild(line);
      layer.appendChild(tag);
    });
    root.appendChild(layer);
    return { boxes: d.items.length, segments: (d.segments || []).length };
  }

  // The notes placed so far: [{ n, text, x, y }] (document coordinates).
  function pageOverlayNotes() {
    return Array.prototype.map.call(document.querySelectorAll("[data-agent-overlay] [data-agent-note]"), function (m) {
      return { n: Number(m.getAttribute("data-agent-note")), text: m.getAttribute("data-agent-note-text") || "", x: parseFloat(m.style.left) || 0, y: parseFloat(m.style.top) || 0 };
    });
  }
  // A numbered marker with its label at document coordinates; returns the notes after adding it.
  function pageOverlayNote(note) {
    var root = document.querySelector("[data-agent-overlay]");
    if (!root) {
      root = document.createElement("div");
      root.setAttribute("data-agent-overlay", "");
      root.setAttribute("style", "position:absolute;left:0;top:0;width:0;height:0;overflow:visible;pointer-events:none;z-index:2147483646;");
      document.documentElement.appendChild(root);
    }
    var layer = root.querySelector("[data-agent-overlay-notes]");
    if (!layer) {
      layer = document.createElement("div");
      layer.setAttribute("data-agent-overlay-notes", "");
      layer.setAttribute("style", "position:absolute;left:0;top:0;width:0;height:0;pointer-events:none;font:600 12px/1.2 system-ui,sans-serif;");
      root.appendChild(layer);
    }
    var m = document.createElement("div");
    m.setAttribute("data-agent-note", String(note.n));
    m.setAttribute("data-agent-note-text", note.text);
    m.setAttribute("style", "position:absolute;left:" + note.x + "px;top:" + note.y + "px;display:flex;align-items:center;gap:6px;transform:translate(-11px,-11px);white-space:nowrap;");
    var dot = document.createElement("div");
    dot.textContent = String(note.n);
    dot.setAttribute("style", "width:22px;height:22px;border-radius:50%;background:#e00060;color:#fff;display:flex;align-items:center;justify-content:center;font:700 12px/1 system-ui,sans-serif;box-shadow:0 1px 4px rgba(0,0,0,.4);");
    var label = document.createElement("div");
    label.textContent = note.text;
    label.setAttribute("style", "max-width:280px;overflow:hidden;text-overflow:ellipsis;padding:3px 8px;border-radius:4px;background:rgba(224,0,96,.92);color:#fff;");
    m.appendChild(dot);
    m.appendChild(label);
    layer.appendChild(m);
    return Array.prototype.map.call(layer.querySelectorAll("[data-agent-note]"), function (x) {
      return { n: Number(x.getAttribute("data-agent-note")), text: x.getAttribute("data-agent-note-text") || "", x: parseFloat(x.style.left) || 0, y: parseFloat(x.style.top) || 0 };
    });
  }
  // Removes marker n; an emptied notes layer goes too, and so does an emptied overlay container.
  function pageOverlayNoteRemove(n) {
    var m = document.querySelector('[data-agent-overlay] [data-agent-note="' + n + '"]');
    if (!m) return false;
    var layer = m.parentNode, root = layer.parentNode;
    layer.removeChild(m);
    if (!layer.querySelector("[data-agent-note]")) root.removeChild(layer);
    if (!root.querySelector("[data-agent-overlay-grid],[data-agent-overlay-measure],[data-agent-overlay-notes],[data-agent-overlay-image],[data-agent-overlay-outline]")) root.parentNode.removeChild(root);
    return true;
  }
  // Remove everything, or one layer ("grid" | "measure" | "notes" | "image" | "outline"). → { removed: bool, left: [layers still there] }
  function pageOverlayClear(only) {
    var root = document.querySelector("[data-agent-overlay]");
    if (!root) return { removed: false, left: [] };
    if (!only) { root.parentNode.removeChild(root); return { removed: true, left: [] }; }
    var layer = root.querySelector("[data-agent-overlay-" + only + "]");
    if (layer) layer.parentNode.removeChild(layer);
    var left = ["grid", "measure", "notes", "image", "outline"].filter(function (l) { return !!root.querySelector("[data-agent-overlay-" + l + "]"); });
    if (!left.length) root.parentNode.removeChild(root);
    return { removed: !!layer, left: left };
  }

  // ── Tools ────────────────────────────────────────────────────────────────

  /** A ref (checked against the last snapshot, top frame only) or a selector as the page functions take it. */
  function targetOf(ref, selector, label) {
    var hasRef = ref !== undefined && ref !== null;
    var sel = selector == null ? "" : String(selector).trim();
    if (!hasRef && !sel) throw new Error("Give ref (from browser_read_page) or selector of element " + label + ".");
    if (hasRef) {
      var e = H.refTarget ? H.refTarget(Number(ref)) : null;
      if (!e) throw new Error("No element [" + ref + "] — call browser_read_page first (refs come from it).");
      if (e.loc && e.loc.frame) throw new Error("Element [" + ref + "] sits inside an iframe (" + e.loc.frame + "); overlays are drawn on the top page only — pass a selector or pick an element of the page itself.");
      return { local: e.local, selector: "" };
    }
    return { local: 0, selector: sel };
  }
  async function rectsOf(targets) {
    var r = await H.inTop(pageRects, [targets]);
    r.items.forEach(function (it) { if (it.error) throw new Error(it.error === "stale" ? STALE : it.error); });
    return r;
  }

  T.register("browser_overlay_grid", async function (a) {
    a = a || {};
    if (a.on === false) {
      var c = await H.inTop(pageOverlayClear, ["grid"]);
      return text(c.removed ? "Grid removed." + (c.left.length ? " Still on the page: " + c.left.join(", ") + "." : "") : "No grid was on the page.");
    }
    var o = gridOptions(a);
    var r = await H.inTop(pageOverlayGrid, [o]);
    return text(formatGrid(o, gridGeometry({ columns: o.columns, gutter: o.gutter, maxWidth: o.maxWidth, viewport: r.viewport })));
  });

  T.register("browser_overlay_measure", async function (a) {
    a = a || {};
    var targets = [targetOf(a.ref, a.selector, "A")];
    if ((a.refB !== undefined && a.refB !== null) || (a.selectorB && String(a.selectorB).trim())) targets.push(targetOf(a.refB, a.selectorB, "B"));
    var r = await rectsOf(targets);
    var m = measureBoxes(r.items[0], r.items[1]);
    await H.inTop(pageDrawMeasure, [{ items: r.items, segments: m.segments, colors: BOX_COLORS }]);
    return text(formatMeasure(m, r.items));
  });

  T.register("browser_overlay_note", async function (a) {
    a = a || {};
    if (a.list) return text(formatNotes(await H.inTop(pageOverlayNotes, [])));
    if (a.remove !== undefined && a.remove !== null) {
      var n0 = Number(a.remove);
      if (!(n0 >= 1)) throw new Error("remove must be the number of a note.");
      var gone = await H.inTop(pageOverlayNoteRemove, [n0]);
      if (!gone) throw new Error("No note #" + n0 + " on the page. browser_overlay_note list=true shows them.");
      var left = await H.inTop(pageOverlayNotes, []);
      return text("Removed note #" + n0 + ". " + (left.length ? left.length + " left: " + left.map(function (x) { return "#" + x.n + " " + x.text; }).join("; ") : "No notes left."));
    }
    var label = String(a.text == null ? "" : a.text).replace(/\s+/g, " ").trim();
    if (!label) throw new Error("text is required — the note's label (or pass list=true, or remove=N).");
    if (label.length > 200) label = label.slice(0, 199) + "…";
    var pos;
    if ((a.ref !== undefined && a.ref !== null) || (a.selector && String(a.selector).trim())) {
      var r = await rectsOf([targetOf(a.ref, a.selector, "")]);
      var it = r.items[0];
      pos = { x: it.left + Math.min(12, it.width / 2), y: it.top + Math.min(12, it.height / 2), at: itemWords(it) };
    } else if (typeof a.x === "number" && typeof a.y === "number") {
      var r2 = await H.inTop(pageRects, [[]]);
      pos = { x: a.x + r2.scrollX, y: a.y + r2.scrollY, at: "(" + a.x + ", " + a.y + ") of the viewport" };
    } else {
      throw new Error("Give ref or selector of the element the note points at, or x and y.");
    }
    var n = nextNoteNumber(await H.inTop(pageOverlayNotes, []));
    var notes = await H.inTop(pageOverlayNote, [{ n: n, x: round(pos.x), y: round(pos.y), text: label }]);
    return text("Note #" + n + ' "' + label + '" placed at ' + pos.at + ". " + notes.length + " note" + (notes.length === 1 ? "" : "s") + " on the page. Take a browser_screenshot to see them; list=true lists them, remove=N takes one away.");
  });

  T.register("browser_overlay_clear", async function (a) {
    var only = a && a.only ? String(a.only) : "";
    if (only && LAYERS.indexOf(only) === -1) throw new Error("only must be grid, measure, notes, image or outline.");
    var r = await H.inTop(pageOverlayClear, [only]);
    if (!r.removed) return text(only ? "No " + only + " overlay was on the page." : "No overlays were on the page.");
    return text(only ? "Removed the " + only + " overlay." + (r.left.length ? " Still on the page: " + r.left.join(", ") + "." : " The page is clean.") : "Removed all overlays; the page is clean.");
  });

  T.register("browser_overlay_image", async function (a) {
    var o = imageOptions(a);
    var r = await H.inTop(pageOverlayImage, [Object.assign({ timeout: IMAGE_TIMEOUT }, o)]);
    return text(formatImage(r, o));
  });

  // The side panel lives in the window of the tab it works on, so that window is the one to resize; a detached panel
  // or app window (type popup/app) is not a page preview and is left alone.
  async function normalWindow(tab) {
    var win = await chrome.windows.get(tab.windowId);
    if (win.type && win.type !== "normal") throw new Error("The current tab sits in a " + win.type + " window (the panel's own, or an app window), which is not resized — open the page in a normal browser window first.");
    return win;
  }
  /**
   * Resize the window so the page's viewport is `want` ({ width, height: 0 = unchanged }): the chrome around the page
   * is measured in the tab, with one correction from the result (measured on the window as it was — maximised, a
   * scrollbar more or less — it can be off). → the viewport info after
   */
  async function resizeViewport(winId, want) {
    var info = await H.inTop(pageViewportInfo, []);
    await chrome.windows.update(winId, Object.assign({ state: "normal" }, boundsFor(want, info)));
    await H.sleep(150);
    var after = await H.inTop(pageViewportInfo, []);
    if (viewportOff(want, after)) {
      await chrome.windows.update(winId, boundsFor(want, after));
      await H.sleep(150);
      after = await H.inTop(pageViewportInfo, []);
    }
    return after;
  }
  /** Put the window back to `b` ({ left, top, width, height, state }). */
  async function restoreWindow(winId, b) {
    await chrome.windows.update(winId, { state: "normal", left: b.left, top: b.top, width: b.width, height: b.height });
    if (b.state && b.state !== "normal") await chrome.windows.update(winId, { state: b.state });
  }

  T.register("browser_overlay_viewport", async function (a) {
    var want = viewportRequest(a);
    var tab = await H.currentTab();
    var win = await normalWindow(tab);
    var store = chrome.storage.session || chrome.storage.local;
    var key = VIEWPORT_KEY + win.id;
    var saved = (await store.get(key))[key];
    if (want.reset) {
      if (!saved) return text("Nothing to reset: this window was not resized by browser_overlay_viewport. " + viewportWords(await H.inTop(pageViewportInfo, [])));
      await restoreWindow(win.id, saved);
      await store.remove(key);
      await H.sleep(150);
      return text("Window restored to " + saved.width + " × " + saved.height + " px" + (saved.state && saved.state !== "normal" ? " (" + saved.state + ")" : "") + ". " + viewportWords(await H.inTop(pageViewportInfo, [])));
    }
    if (!saved) { var o = {}; o[key] = { left: win.left, top: win.top, width: win.width, height: win.height, state: win.state || "normal" }; await store.set(o); }
    var after = await resizeViewport(win.id, want);
    return text(
      viewportWords(after).replace(/\.$/, "") + (want.preset ? " (" + want.preset + ")." : ".") +
      (viewportOff(want, after) ? " Asked for " + want.width + (want.height ? " × " + want.height : "") + " — the window would not go there; the screen or the browser's minimum window size limits it." : "") +
      " The window was resized; browser_overlay_viewport preset=reset puts it back. Take a browser_screenshot — reload first if the page lays out from media queries only at load."
    );
  });

  T.register("browser_overlay_outline", async function (a) {
    a = a || {};
    if (a.off === true) {
      var c = await H.inTop(pageOverlayClear, ["outline"]);
      return text(c.removed ? "Outlines removed." + (c.left.length ? " Still on the page: " + c.left.join(", ") + "." : "") : "No outlines were on the page.");
    }
    var o = outlineOptions(a);
    var r = await H.inTop(pageOverlayOutline, [o.kinds, o.colors, OUTLINE_SAMPLE]);
    return text(formatOutline(r, o));
  });

  // ── Captures: the visible tab, stitched on a canvas of the panel ─────────

  function loadImage(dataUrl) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error("The screenshot could not be decoded.")); };
      img.src = dataUrl;
    });
  }
  /**
   * The captures (data URLs, each with the scroll offset it was taken at, CSS px) drawn under each other on one canvas
   * of the page `width` × `height` CSS px at `dpr`, scaled down when a side is over maxSide. → { dataUrl, width, height, scale }
   */
  async function stitchCaptures(shots, dpr, width, height, maxSide) {
    var scale = maxSide > 0 ? Math.min(1, maxSide / Math.max(width * dpr, height * dpr)) : 1;
    var canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * dpr * scale));
    canvas.height = Math.max(1, Math.round(height * dpr * scale));
    var ctx = canvas.getContext("2d");
    for (var i = 0; i < shots.length; i++) {
      var img = await loadImage(shots[i].dataUrl);
      var iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
      ctx.drawImage(img, 0, 0, iw, ih, 0, Math.round(shots[i].y * dpr * scale), Math.round(iw * scale), Math.round(ih * scale));
    }
    return { dataUrl: canvas.toDataURL("image/png"), width: canvas.width, height: canvas.height, scale: scale };
  }
  function imagePart(dataUrl) { return { type: "image", data: dataUrl.slice(dataUrl.indexOf(",") + 1), mimeType: "image/png" }; }
  async function downloadDataUrl(filename, dataUrl) {
    var dl = typeof chrome !== "undefined" && chrome.downloads;
    if (!dl || typeof dl.download !== "function") throw new Error("This build cannot save files (no downloads permission) — call again without save.");
    return dl.download({ url: dataUrl, filename: filename, conflictAction: "uniquify" });
  }

  // One capture per width: the window resized as browser_overlay_viewport does it, the page captured (scrolled and
  // stitched with fullPage), and the window's bounds from before the call put back at the end — also after an error.
  T.register("browser_overlay_responsive", async function (a) {
    var o = responsiveRequest(a);
    var tab = await H.currentTab();
    var win = await normalWindow(tab);
    var bounds = { left: win.left, top: win.top, width: win.width, height: win.height, state: win.state || "normal" };
    if (!tab.active) { await chrome.tabs.update(tab.id, { active: true }); await H.sleep(300); }
    var start = await H.inTop(pageLayoutInfo, []);
    var parts = [], overflow = [], scrolled = false;
    try {
      for (var i = 0; i < o.widths.length; i++) {
        var w = o.widths[i];
        await resizeViewport(win.id, { width: w, height: 0 });
        await H.sleep(300); // layout, media queries, images
        var lay = await H.inTop(pageLayoutInfo, []);
        var plan = o.fullPage ? stitchPlan(lay.scrollHeight, lay.innerHeight, STITCH_MAX) : { offsets: [0], height: lay.innerHeight, cut: false };
        var shots = [];
        for (var k = 0; k < plan.offsets.length; k++) {
          var y = 0;
          if (o.fullPage) { scrolled = true; y = (await H.inTop(pageScrollTo, [0, plan.offsets[k]])).scrollY; await H.sleep(150); }
          shots.push({ y: y, dataUrl: await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" }) });
        }
        var img = await stitchCaptures(shots, lay.dpr, lay.innerWidth, plan.height, MAX_STITCH_SIDE);
        var over = lay.scrollWidth > lay.innerWidth;
        if (over) overflow.push(w + " px (the page is " + lay.scrollWidth + " px wide, " + (lay.scrollWidth - lay.innerWidth) + " px over)");
        var line = w + " px: " + lay.innerWidth + "×" + lay.innerHeight + ", page " + lay.scrollWidth + "×" + lay.scrollHeight +
          (lay.innerWidth !== w ? " (asked for " + w + " — the window would not go there)" : "") +
          (o.fullPage ? ", " + shots.length + " screen" + (shots.length === 1 ? "" : "s") + " stitched" + (plan.cut ? ", cut at " + plan.height + " px" : "") : "") +
          (img.scale < 1 ? ", image scaled to " + img.width + "×" + img.height : "") +
          (over ? " — horizontal overflow: " + (lay.scrollWidth - lay.innerWidth) + " px wider than the viewport" : "");
        if (o.save) {
          var name = responsiveName(hostOf(tab.url), w, o.fullPage, Date.now());
          var id = await downloadDataUrl(name, img.dataUrl);
          line += " — saved as " + name + " (download id " + id + ")";
        }
        parts.push(imagePart(img.dataUrl), { type: "text", text: line });
      }
    } finally {
      try {
        await restoreWindow(win.id, bounds);
        if (scrolled) await H.inTop(pageScrollTo, [start.scrollX, start.scrollY]);
      } catch (_) { /* the window or the page is gone; nothing left to restore */ }
    }
    parts.push({ type: "text", text:
      "Window restored to " + bounds.width + " × " + bounds.height + " px. " + (overflow.length ? "Horizontal overflow at " + overflow.join("; ") + "." : "No horizontal overflow at any width.") +
      (o.fullPage ? "" : " fullPage=true captures the whole page (scrolled and stitched, up to " + STITCH_MAX + " screens per width).") });
    return parts;
  });

  // ── 📐 Overlay tab of the 🧩 panel ───────────────────────────────────────

  async function renderTab(content, ctx) {
    var el = ctx.el;
    content.textContent = "";
    var columns = el("input", { type: "number", value: 12, min: 1, max: 24 });
    var gutter = el("input", { type: "number", value: 24, min: 0, max: 200 });
    var maxWidth = el("input", { type: "number", value: 1200, min: 0, max: 4000 });
    var baseline = el("input", { type: "number", value: 0, min: 0, max: 100 });
    var color = el("input", { value: DEFAULT_COLOR, placeholder: DEFAULT_COLOR });
    var gridOn = el("button", { className: "prof-btn primary", title: "Draw the grid on the page" }, ["▦ Grid on"]);
    var gridOff = el("button", { className: "prof-btn", title: "Remove the grid" }, ["Grid off"]);
    gridOn.addEventListener("click", function () {
      var o;
      try { o = gridOptions({ columns: columns.value, gutter: gutter.value, maxWidth: maxWidth.value, baseline: baseline.value, color: color.value }); } catch (e) { ctx.status("⚠ " + e.message, "bad"); return; }
      H.inTop(pageOverlayGrid, [o]).then(function (r) { ctx.status("✓ Grid on: " + o.columns + " columns in a " + r.viewport + " px viewport.", "good"); }, function (e) { ctx.status("⚠ " + ((e && e.message) || e), "bad"); });
    });
    gridOff.addEventListener("click", function () {
      H.inTop(pageOverlayClear, ["grid"]).then(function (r) { ctx.status(r.removed ? "Grid removed." : "No grid on the page.", "good"); }, function (e) { ctx.status("⚠ " + ((e && e.message) || e), "bad"); });
    });
    content.appendChild(el("div", { className: "cmd-group-title" }, ["Grid"]));
    content.appendChild(el("div", { className: "ed-wrap" }, [
      el("div", { className: "ed-row" }, [ctx.field("Columns", columns), ctx.field("Gutter (px)", gutter)]),
      el("div", { className: "ed-row" }, [ctx.field("Max width (px, 0 = full)", maxWidth), ctx.field("Baseline (px, 0 = none)", baseline)]),
      ctx.field("Colour", color),
      el("div", { className: "ed-actions" }, [gridOn, gridOff]),
    ]));

    content.appendChild(el("div", { className: "cmd-group-title" }, ["Notes"]));
    var notesBox = el("div", null, []);
    content.appendChild(notesBox);
    function loadNotes() {
      notesBox.textContent = "";
      return H.inTop(pageOverlayNotes, []).then(function (notes) {
        if (!notes.length) { notesBox.appendChild(el("div", { className: "cmd-empty" }, ["No review notes on the page. Ask the agent to mark up the page: it places numbered markers where it sees problems."])); return; }
        notes.forEach(function (n) {
          notesBox.appendChild(el("div", { className: "cmd-item event" }, [
            el("span", { className: "cmd-icon" }, ["#" + n.n]),
            el("div", { className: "cmd-body" }, [el("div", { className: "cmd-name note" }, [n.text]), el("div", { className: "cmd-desc" }, ["at (" + Math.round(n.x) + ", " + Math.round(n.y) + ")"])]),
            el("div", { className: "prof-actions column" }, [el("button", { className: "prof-btn", title: "Remove this note", onclick: function () {
              H.inTop(pageOverlayNoteRemove, [n.n]).then(function () { ctx.status("Removed note #" + n.n + ".", "good"); return loadNotes(); }, function (e) { ctx.status("⚠ " + ((e && e.message) || e), "bad"); });
            } }, ["✕"])]),
          ]));
        });
      }, function (e) { notesBox.appendChild(el("div", { className: "cmd-desc bad" }, ["⚠ " + ((e && e.message) || e)])); });
    }
    await loadNotes();

    content.appendChild(el("div", { className: "cmd-group-title" }, ["Review"]));
    content.appendChild(el("div", { className: "cmd-item event" }, [
      el("span", { className: "cmd-icon" }, ["📐"]),
      el("div", { className: "cmd-body wide" }, [
        el("div", { className: "cmd-desc" }, ["Overlays are drawn for this visit only and never catch clicks; a reload clears them."]),
        el("div", { className: "prof-actions" }, [
          el("button", { className: "prof-btn", title: "Read the notes on the page again", onclick: function () { loadNotes(); } }, ["↻ Refresh"]),
          el("button", { className: "prof-btn", title: "Remove the grid, the measurements and the notes", onclick: function () {
            H.inTop(pageOverlayClear, [""]).then(function (r) { ctx.status(r.removed ? "All overlays removed." : "No overlays on the page.", "good"); return loadNotes(); }, function (e) { ctx.status("⚠ " + ((e && e.message) || e), "bad"); });
          } }, ["🧹 Clear all"]),
          el("button", { className: "prof-btn", title: "Ask the agent for a screenshot of the page with the overlays", onclick: function () {
            ctx.sendPrompt("Take a screenshot of the page with the overlays as they are now (browser_screenshot, without clearing them) and tell me what the grid, measurements and notes show.");
          } }, ["📸 Screenshot with overlays"]),
        ]),
      ]),
    ]));
  }

  X.tabs.push({ id: "overlay", label: "📐 Overlay", render: renderTab });

  // ── Quick commands ───────────────────────────────────────────────────────

  X.commands.push(
    { group: "Design", icon: "▦", name: "Show a 12-column grid",
      prompt: "Draw a 12-column layout grid over this page with browser_overlay_grid (24 px gutters, 1200 px max width), take a screenshot and tell me which elements sit off the grid." },
    { group: "Design", icon: "📏", name: "Measure the spacing between these two elements",
      prompt: "Read the page, then measure with browser_overlay_measure (and show me the screenshot) the spacing between these two elements: ", partial: true },
    { group: "Design", icon: "📐", name: "Mark up this page for review",
      prompt: "Review the layout of this page: read it and take a screenshot, then mark every problem you see — alignment, spacing, hierarchy, contrast, crowding — with a numbered browser_overlay_note where it is, take a screenshot with the markers and list the notes with a suggested fix for each. Leave the markers on the page." },
    { group: "Design", icon: "🖼", name: "Compare with a design image",
      prompt: "Lay this design image over the page with browser_overlay_image at 50% opacity (top-center, its natural width), take a screenshot and list where the page departs from the design — offsets, sizes, spacing, colours — with the numbers; then clear the overlay. The image URL: ", partial: true },
    { group: "Design", icon: "📱", name: "Preview at phone width",
      prompt: "Resize the viewport to the mobile preset with browser_overlay_viewport, take a screenshot and tell me what breaks or crowds at 375 px — navigation, images, text, tap targets — then put the window back with preset=reset." },
    { group: "Design", icon: "🔲", name: "Outline the headings",
      prompt: "Outline every heading on this page with browser_overlay_outline (what=headings), take a screenshot and tell me whether the heading levels form a sensible hierarchy — one h1, no skipped levels, a heading where each section starts — then clear the outlines." },
    { group: "Design", icon: "🖥", name: "Responsive screenshots",
      prompt: "Capture this page at phone, tablet and laptop widths with browser_overlay_responsive (the default widths), show me the three screenshots and list what breaks or crowds at each width — navigation, images, text, tap targets — and any horizontal overflow it reports." }
  );

  /** The pure parts and the page-side functions, for tests and other modules. */
  X.overlay = {
    DEFAULT_COLOR: DEFAULT_COLOR, BOX_COLORS: BOX_COLORS, LAYERS: LAYERS, VIEWPORTS: VIEWPORTS, VIEWPORT_KEY: VIEWPORT_KEY, IMAGE_TIMEOUT: IMAGE_TIMEOUT,
    isHexColor: isHexColor, hexToRgba: hexToRgba, gridOptions: gridOptions, gridGeometry: gridGeometry, formatGrid: formatGrid,
    measureBoxes: measureBoxes, formatMeasure: formatMeasure, nextNoteNumber: nextNoteNumber, formatNotes: formatNotes, targetOf: targetOf,
    imageOptions: imageOptions, formatImage: formatImage, viewportRequest: viewportRequest, boundsFor: boundsFor, viewportWords: viewportWords,
    pageRects: pageRects, pageOverlayGrid: pageOverlayGrid, pageDrawMeasure: pageDrawMeasure, pageOverlayNotes: pageOverlayNotes, pageOverlayNote: pageOverlayNote, pageOverlayNoteRemove: pageOverlayNoteRemove, pageOverlayClear: pageOverlayClear,
    pageOverlayImage: pageOverlayImage, pageViewportInfo: pageViewportInfo,
    OUTLINE_KINDS: OUTLINE_KINDS, OUTLINE_COLORS: OUTLINE_COLORS, OUTLINE_SAMPLE: OUTLINE_SAMPLE, RESPONSIVE_WIDTHS: RESPONSIVE_WIDTHS, RESPONSIVE_MAX: RESPONSIVE_MAX, STITCH_MAX: STITCH_MAX, MAX_STITCH_SIDE: MAX_STITCH_SIDE,
    outlineOptions: outlineOptions, formatOutline: formatOutline, responsiveRequest: responsiveRequest, stitchPlan: stitchPlan, responsiveName: responsiveName, stitchCaptures: stitchCaptures,
    pageOverlayOutline: pageOverlayOutline, pageLayoutInfo: pageLayoutInfo, pageScrollTo: pageScrollTo, resizeViewport: resizeViewport, restoreWindow: restoreWindow,
    render: renderTab,
  };
})();
