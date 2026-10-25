// Extra feature "overlay" (side panel): layout overlays for design review — a column/baseline grid,
// measurements between two elements and numbered review notes, all drawn in ONE click-through layer
// (<div data-agent-overlay>, pointer-events: none, a very high z-index) on the page for this visit only.
// Nothing is persisted; browser_overlay_clear or a reload removes everything. Built into extras.js only
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
  var LAYERS = ["grid", "measure", "notes"];

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

  // ── Page side (self-contained; injected with chrome.scripting.executeScript) ──

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
    if (!root.querySelector("[data-agent-overlay-grid],[data-agent-overlay-measure],[data-agent-overlay-notes]")) root.parentNode.removeChild(root);
    return true;
  }
  // Remove everything, or one layer ("grid" | "measure" | "notes"). → { removed: bool, left: [layers still there] }
  function pageOverlayClear(only) {
    var root = document.querySelector("[data-agent-overlay]");
    if (!root) return { removed: false, left: [] };
    if (!only) { root.parentNode.removeChild(root); return { removed: true, left: [] }; }
    var layer = root.querySelector("[data-agent-overlay-" + only + "]");
    if (layer) layer.parentNode.removeChild(layer);
    var left = ["grid", "measure", "notes"].filter(function (l) { return !!root.querySelector("[data-agent-overlay-" + l + "]"); });
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
    if (only && LAYERS.indexOf(only) === -1) throw new Error("only must be grid, measure or notes.");
    var r = await H.inTop(pageOverlayClear, [only]);
    if (!r.removed) return text(only ? "No " + only + " overlay was on the page." : "No overlays were on the page.");
    return text(only ? "Removed the " + only + " overlay." + (r.left.length ? " Still on the page: " + r.left.join(", ") + "." : " The page is clean.") : "Removed all overlays; the page is clean.");
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
      prompt: "Review the layout of this page: read it and take a screenshot, then mark every problem you see — alignment, spacing, hierarchy, contrast, crowding — with a numbered browser_overlay_note where it is, take a screenshot with the markers and list the notes with a suggested fix for each. Leave the markers on the page." }
  );

  /** The pure parts and the page-side functions, for tests and other modules. */
  X.overlay = {
    DEFAULT_COLOR: DEFAULT_COLOR, BOX_COLORS: BOX_COLORS, LAYERS: LAYERS,
    isHexColor: isHexColor, hexToRgba: hexToRgba, gridOptions: gridOptions, gridGeometry: gridGeometry, formatGrid: formatGrid,
    measureBoxes: measureBoxes, formatMeasure: formatMeasure, nextNoteNumber: nextNoteNumber, formatNotes: formatNotes, targetOf: targetOf,
    pageRects: pageRects, pageOverlayGrid: pageOverlayGrid, pageDrawMeasure: pageDrawMeasure, pageOverlayNotes: pageOverlayNotes, pageOverlayNote: pageOverlayNote, pageOverlayNoteRemove: pageOverlayNoteRemove, pageOverlayClear: pageOverlayClear,
    render: renderTab,
  };
})();
