// Layout overlays (browser/extras/overlay.js) against fakes of chrome, the tool runtime and a small DOM: the
// grid geometry, the measurement math and alignment hints, note numbering, the eight tools' reports and what
// they draw (the design image through a fake <img> loader, the viewport resize through a fake chrome.windows,
// labelled outlines per kind, responsive captures stitched on a fake canvas with the window put back), and the
// 📐 tab. The real page is exercised in tests/e2e/extras-stencil.e2e.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
const plain = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x))); // values made inside the vm have another realm's prototypes
const eq = (a, b, msg) => assert.deepEqual(plain(a), plain(b), msg);
import { fakeCanvas, fakeCtx, fakeDocument, loadExtra, runTool, settle } from "./mocks/extras-stencil.mjs";

const PAGE_FNS = ["pageRects", "pageOverlayGrid", "pageDrawMeasure", "pageOverlayNotes", "pageOverlayNote", "pageOverlayNoteRemove", "pageOverlayClear", "pageOverlayImage", "pageOverlayOutline"];

/** The module over a fake page whose two boxes have the known geometry (A 200×100 at 100,100; B 150×100 at 340,100). */
function setup(opts = {}) {
  const page = fakeDocument('<main><div id="box-a">A</div><div id="box-b">B</div></main><p id="p">Text <a href="/x">link</a></p>');
  page.querySelector("#box-a")._rect = { left: 100, top: 100, width: 200, height: 100 };
  page.querySelector("#box-b")._rect = { left: 340, top: 100, width: 150, height: 100 };
  page.querySelector("a")._rect = { left: 10, top: 500, width: 40, height: 20 };
  const refs = { 4: { documentId: "d1", local: 1, loc: { kind: "link", text: "link", frame: "" } }, 9: { documentId: "d2", local: 1, loc: { kind: "button", text: "x", frame: "ads.example" } } };
  const m = loadExtra("overlay", { document: page, refs, ...opts });
  const w = m.context.window;
  w.scrollX = 0; w.scrollY = 0; w.innerWidth = 1440; w.innerHeight = 900;
  w.__agentRefs = [page.querySelector("a")];
  for (const fn of PAGE_FNS) m.scripting.results[fn] = (...a) => m.X[fn](...a);
  // The page's viewport as the fake window gives it: 16 px of chrome beside the page (scrollbar, side panel), 120 px above.
  m.scripting.results.pageViewportInfo = () => { const win = m.chrome.windows.list[1]; return { innerWidth: win.width - 16, innerHeight: win.height - 120, outerWidth: win.width, outerHeight: win.height, dpr: 2 }; };
  return { ...m, page, w };
}
/** <img> elements made in `page` "load" on the next tick with the natural size `sizes(url)` gives, fail when it gives none, or never answer when it gives "never". */
function imageLoader(page, sizes) {
  const create = (page._createElement = page._createElement || page.createElement);
  page.createElement = (name) => {
    const n = create(name);
    if (name === "img") Object.defineProperty(n, "src", { get() { return n.getAttribute("src"); }, set(v) {
      n.setAttribute("src", v);
      const s = sizes(v);
      if (s === "never") return;
      setTimeout(() => { if (!s) { if (n.onerror) n.onerror(); } else { n.naturalWidth = s[0]; n.naturalHeight = s[1]; if (n.onload) n.onload(); } }, 0);
    } });
    return n;
  };
}
const overlay = (page) => page.documentElement.querySelector("[data-agent-overlay]");

test("loads only for a brand with the feature; registers eight tools, the 📐 tab and seven Design commands", () => {
  const off = loadExtra("overlay", { features: { overlay: false, elements: true } });
  eq(off.T.names, []);
  assert.equal(off.X, undefined);
  const m = loadExtra("overlay");
  eq(m.T.names, ["browser_overlay_grid", "browser_overlay_measure", "browser_overlay_note", "browser_overlay_clear", "browser_overlay_image", "browser_overlay_viewport", "browser_overlay_outline", "browser_overlay_responsive"]);
  assert.equal(m.tab.label, "📐 Overlay");
  eq(m.commands.map((c) => [c.group, c.name, !!c.partial]), [
    ["Design", "Show a 12-column grid", false], ["Design", "Measure the spacing between these two elements", true], ["Design", "Mark up this page for review", false],
    ["Design", "Compare with a design image", true], ["Design", "Preview at phone width", false],
    ["Design", "Outline the headings", false], ["Design", "Responsive screenshots", false],
  ]);
  assert.match(m.commands[5].prompt, /browser_overlay_outline \(what=headings\).*clear the outlines/);
  assert.match(m.commands[6].prompt, /browser_overlay_responsive .*horizontal overflow/);
  assert.match(m.commands[0].prompt, /browser_overlay_grid .*screenshot/);
  assert.match(m.commands[2].prompt, /browser_overlay_note.*screenshot/);
  assert.match(m.commands[3].prompt, /browser_overlay_image .*clear the overlay/);
  assert.match(m.commands[4].prompt, /browser_overlay_viewport.*preset=reset/);
});

test("gridGeometry: 12 columns, 24 px gutter, 1200 px max in a 1440 px viewport; full width; a narrow viewport", () => {
  const { X } = loadExtra("overlay");
  const g = X.gridGeometry({ columns: 12, gutter: 24, maxWidth: 1200, viewport: 1440 });
  assert.equal(g.left, 120);
  assert.equal(g.width, 1200);
  assert.equal(g.colWidth, 78);
  eq(g.xs, [120, 222, 324, 426, 528, 630, 732, 834, 936, 1038, 1140, 1242]);
  const full = X.gridGeometry({ columns: 4, gutter: 0, maxWidth: 0, viewport: 1000 });
  eq([full.left, full.width, full.colWidth, full.xs], [0, 1000, 250, [0, 250, 500, 750]]);
  const narrow = X.gridGeometry({ columns: 3, gutter: 10, maxWidth: 1200, viewport: 380 });
  eq([narrow.left, narrow.width, narrow.colWidth, narrow.xs], [0, 380, 120, [0, 130, 260]]);
  // Options: defaults and validation.
  const o = X.gridOptions({});
  eq([o.columns, o.gutter, o.maxWidth, o.baseline, o.color], [12, 24, 1200, 0, "#ff2d78"]);
  assert.equal(o.fill, "rgba(255, 45, 120, 0.12)");
  assert.equal(X.gridOptions({ columns: "6", gutter: "0", maxWidth: 0, baseline: 8, color: "#F27" }).fill, "rgba(255, 34, 119, 0.12)");
  assert.throws(() => X.gridOptions({ color: "red" }), /color must be a hex colour/);
  assert.throws(() => X.gridOptions({ columns: 0 }), /columns must be a number between 1 and 24/);
  assert.throws(() => X.gridOptions({ gutter: -1 }), /gutter must be/);
  assert.equal(X.isHexColor("#abc"), true);
  assert.equal(X.isHexColor("#abcd"), false);
});

test("browser_overlay_grid draws the columns in one click-through layer, reports the geometry, replaces itself and goes with on=false", async () => {
  const m = setup();
  const out = await runTool(m.T, "browser_overlay_grid", { columns: 12, gutter: 24, maxWidth: 1200, baseline: 8 });
  assert.equal(out, "Grid on: 12 columns, 24 px gutters, max width 1200 px, centred in a 1440 px viewport — columns 78 px wide at x = 120, 222, 324, 426, 528, 630, 732, 834, 936, 1038, 1140, 1242 (every 102 px; the grid spans 120–1320 px). Baseline grid every 8 px. It stays fixed to the viewport while the page scrolls. Take a browser_screenshot to see it; browser_overlay_grid on=false removes it.");
  const root = overlay(m.page);
  assert.match(root.getAttribute("style"), /pointer-events:none;z-index:2147483646/);
  assert.equal(root.querySelectorAll("[data-agent-grid-col]").length, 12);
  assert.match(root.querySelector("[data-agent-grid-cols]").getAttribute("style"), /display:flex;gap:24px;max-width:1200px;/);
  assert.match(root.querySelector("[data-agent-grid-baseline]").getAttribute("style"), /repeating-linear-gradient\(to bottom,rgba\(255, 45, 120, 0.65\) 0,.*transparent 8px\)/);
  // Again with other options: one grid, not two; no baseline layer without baseline.
  await runTool(m.T, "browser_overlay_grid", { columns: 4, maxWidth: 0 });
  assert.equal(root.querySelectorAll("[data-agent-overlay-grid]").length, 1);
  assert.equal(root.querySelectorAll("[data-agent-grid-col]").length, 4);
  assert.equal(root.querySelector("[data-agent-grid-baseline]"), null);
  assert.equal(await runTool(m.T, "browser_overlay_grid", { on: false }), "Grid removed.");
  assert.equal(overlay(m.page), null, "an empty overlay container goes too");
  assert.equal(await runTool(m.T, "browser_overlay_grid", { on: false }), "No grid was on the page.");
  await assert.rejects(m.T.run("browser_overlay_grid", { color: "pink" }), /color must be a hex colour/);
});

test("measureBoxes: gaps, overlaps, offsets, alignment hints within 1 px and the segments to draw", () => {
  const { X } = loadExtra("overlay");
  const a = { left: 100, top: 100, width: 200, height: 100 }, b = { left: 340, top: 100, width: 150, height: 100 };
  const m = X.measureBoxes(a, b);
  assert.equal(m.gapX, 40);
  assert.equal(m.sideX, "right");
  assert.equal(m.gapY, null);
  assert.equal(m.overlapY, 100);
  eq([m.dx, m.dy], [240, 0]);
  eq(m.hints, ["same top edge", "same bottom edge", "same vertical centre", "same height"]);
  eq(m.segments, [{ dir: "x", x1: 300, y1: 150, x2: 340, y2: 150, label: "40 px" }]);
  // B below A, same left edge within a pixel, same width.
  const m2 = X.measureBoxes(a, { left: 100.6, top: 224, width: 200, height: 50 });
  assert.equal(m2.gapY, 24);
  assert.equal(m2.sideY, "below");
  assert.equal(m2.overlapX, 199.4);
  eq(m2.hints, ["same left edge", "same right edge", "same horizontal centre", "same width"]);
  eq(m2.segments, [{ dir: "y", x1: 200.3, y1: 200, x2: 200.3, y2: 224, label: "24 px" }]);
  // Diagonal: gaps on both axes, nothing aligned; the lines run from A's centre.
  const m3 = X.measureBoxes(a, { left: 400, top: 300, width: 10, height: 10 });
  eq([m3.gapX, m3.gapY, m3.sideX, m3.sideY], [100, 100, "right", "below"]);
  eq(m3.hints, []);
  eq(m3.segments.map((s) => [s.dir, s.x1, s.y1, s.x2, s.y2]), [["x", 300, 150, 400, 150], ["y", 200, 200, 200, 300]]);
  // B left of and above A; overlapping boxes.
  const m4 = X.measureBoxes(a, { left: 0, top: 0, width: 50, height: 50 });
  eq([m4.gapX, m4.gapY, m4.sideX, m4.sideY], [50, 50, "left", "above"]);
  const m5 = X.measureBoxes(a, { left: 150, top: 150, width: 200, height: 100 });
  eq([m5.gapX, m5.gapY, m5.overlapX, m5.overlapY, m5.hints, m5.segments], [null, null, 150, 50, ["same width", "same height"], []]);
  // One box only.
  const m6 = X.measureBoxes(a);
  assert.equal(m6.b, null);
  eq(m6.a, { left: 100, top: 100, width: 200, height: 100, right: 300, bottom: 200, cx: 200, cy: 150 });
  assert.match(X.formatMeasure(m6, [{ tag: "div", text: "A" }]), /^A: div "A" — 200 × 100 px at \(100, 100\)\nDrawn on the page \(box with its size\)/);
});

test("browser_overlay_measure draws the boxes and gap lines and reports the numbers; refs, selectors and refusals", async () => {
  const m = setup();
  const out = await runTool(m.T, "browser_overlay_measure", { selector: "#box-a", selectorB: "#box-b" });
  assert.equal(out, [
    'A: div "A" — 200 × 100 px at (100, 100)',
    'B: div "B" — 150 × 100 px at (340, 100)',
    "Horizontal: B is right of A, gap 40 px. Vertical: the boxes overlap by 100 px.",
    "Offset of B from A (top-left corners): dx 240 px, dy 0 px.",
    "Alignment: same top edge, same bottom edge, same vertical centre, same height.",
    "Drawn on the page (boxes with sizes, gap lines with their px). Take a browser_screenshot to see it.",
  ].join("\n"));
  const layer = overlay(m.page).querySelector("[data-agent-overlay-measure]");
  const boxes = layer.querySelectorAll("[data-agent-box]");
  assert.equal(boxes.length, 2);
  assert.match(boxes[0].getAttribute("style"), /left:100px;top:100px;width:200px;height:100px;.*outline:2px solid #1e90ff/);
  assert.equal(boxes[0].textContent, "A 200 × 100");
  assert.equal(boxes[1].textContent, "B 150 × 100");
  const gap = layer.querySelector("[data-agent-gap]");
  assert.match(gap.getAttribute("style"), /left:300px;top:149px;width:40px;height:2px/);
  assert.equal(layer.textContent.includes("40 px"), true);
  // Scrolled: rectangles come in document coordinates.
  m.w.scrollX = 0; m.w.scrollY = 1000;
  const out2 = await runTool(m.T, "browser_overlay_measure", { ref: 4 });
  assert.match(out2, /^A: a "link" — 40 × 20 px at \(10, 1500\)/);
  assert.equal(overlay(m.page).querySelectorAll("[data-agent-overlay-measure]").length, 1, "measurements replace the earlier ones");
  assert.equal(overlay(m.page).querySelectorAll("[data-agent-box]").length, 1);
  // Refusals.
  await assert.rejects(m.T.run("browser_overlay_measure", {}), /Give ref .* or selector of element A/);
  await assert.rejects(m.T.run("browser_overlay_measure", { selector: "#box-a", refB: 42 }), /No element \[42\]/);
  await assert.rejects(m.T.run("browser_overlay_measure", { ref: 9 }), /inside an iframe \(ads\.example\); overlays are drawn on the top page only/);
  await assert.rejects(m.T.run("browser_overlay_measure", { selector: "#nope" }), /Nothing on the page matches the selector "#nope"/);
  m.page.querySelector("a").remove();
  await assert.rejects(m.T.run("browser_overlay_measure", { ref: 4 }), /That element is gone — the page changed/);
});

test("browser_overlay_note: numbered markers at an element or at viewport coordinates, list, remove; numbers are never reused", async () => {
  const { X } = loadExtra("overlay");
  assert.equal(X.nextNoteNumber([]), 1);
  assert.equal(X.nextNoteNumber([{ n: 1 }, { n: 3 }]), 4);
  assert.equal(X.formatNotes([]), "No review notes on the page.");

  const m = setup();
  m.w.scrollY = 50;
  assert.equal(await runTool(m.T, "browser_overlay_note", { selector: "#box-a", text: "  Too   close " }), 'Note #1 "Too close" placed at div "A". 1 note on the page. Take a browser_screenshot to see them; list=true lists them, remove=N takes one away.');
  assert.equal(await runTool(m.T, "browser_overlay_note", { x: 10, y: 20, text: "Second" }), 'Note #2 "Second" placed at (10, 20) of the viewport. 2 notes on the page. Take a browser_screenshot to see them; list=true lists them, remove=N takes one away.');
  const markers = overlay(m.page).querySelectorAll("[data-agent-note]");
  eq(markers.map((x) => x.getAttribute("data-agent-note")), ["1", "2"]);
  assert.match(markers[0].getAttribute("style"), /left:112px;top:162px/, "just inside the element's top-left corner, in document coordinates");
  assert.match(markers[1].getAttribute("style"), /left:10px;top:70px/, "viewport coordinates plus the scroll");
  assert.equal(markers[0].textContent, "1Too close");
  assert.equal(await runTool(m.T, "browser_overlay_note", { list: true }), "Review notes on the page (2):\n#1 Too close — at (112, 162)\n#2 Second — at (10, 70)");
  assert.equal(await runTool(m.T, "browser_overlay_note", { remove: 1 }), "Removed note #1. 1 left: #2 Second");
  assert.match(await runTool(m.T, "browser_overlay_note", { ref: 4, text: "Third" }), /^Note #3 "Third" placed at a "link"\. 2 notes on the page\./);
  await assert.rejects(m.T.run("browser_overlay_note", { remove: 1 }), /No note #1 on the page/);
  await assert.rejects(m.T.run("browser_overlay_note", { text: "x" }), /Give ref or selector of the element the note points at, or x and y/);
  await assert.rejects(m.T.run("browser_overlay_note", { selector: "#box-a" }), /text is required/);
  await assert.rejects(m.T.run("browser_overlay_note", { remove: 0 }), /remove must be the number of a note/);
  assert.equal(await runTool(m.T, "browser_overlay_note", { remove: 2 }), "Removed note #2. 1 left: #3 Third");
  assert.equal(await runTool(m.T, "browser_overlay_note", { remove: 3 }), "Removed note #3. No notes left.");
  assert.equal(await runTool(m.T, "browser_overlay_note", { list: true }), "No review notes on the page.");
});

test("browser_overlay_clear removes one layer or everything", async () => {
  const m = setup();
  assert.equal(await runTool(m.T, "browser_overlay_clear", {}), "No overlays were on the page.");
  await runTool(m.T, "browser_overlay_grid", {});
  await runTool(m.T, "browser_overlay_measure", { selector: "#box-a", selectorB: "#box-b" });
  await runTool(m.T, "browser_overlay_note", { selector: "#box-b", text: "n" });
  assert.equal(await runTool(m.T, "browser_overlay_clear", { only: "grid" }), "Removed the grid overlay. Still on the page: measure, notes.");
  assert.equal(overlay(m.page).querySelector("[data-agent-grid-col]"), null);
  assert.equal(overlay(m.page).querySelectorAll("[data-agent-note]").length, 1);
  assert.equal(await runTool(m.T, "browser_overlay_clear", { only: "grid" }), "No grid overlay was on the page.");
  assert.equal(await runTool(m.T, "browser_overlay_clear", { only: "notes" }), "Removed the notes overlay. Still on the page: measure.");
  assert.equal(await runTool(m.T, "browser_overlay_clear", { only: "measure" }), "Removed the measure overlay. The page is clean.");
  assert.equal(overlay(m.page), null);
  await runTool(m.T, "browser_overlay_grid", {});
  assert.equal(await runTool(m.T, "browser_overlay_clear", {}), "Removed all overlays; the page is clean.");
  assert.equal(overlay(m.page), null);
  await assert.rejects(m.T.run("browser_overlay_clear", { only: "boxes" }), /only must be grid, measure, notes, image or outline/);
});

test("the 📐 tab: grid controls draw and remove the grid, the notes list with remove, Clear all, Screenshot with overlays", async () => {
  const m = setup();
  await runTool(m.T, "browser_overlay_note", { selector: "#box-a", text: "Crowded" });
  const { content, ctx, statuses, prompts } = fakeCtx(m.page);
  await m.tab.render(content, ctx);
  eq(content.byClass("cmd-group-title").map((n) => n.textContent), ["Grid", "Notes", "Review"]);
  assert.match(content.text(), /#1 Crowded at \(112, 112\)/);
  // Grid on with the form's values.
  const inputs = content.findAll((n) => n.localName === "input");
  inputs[0].value = "6"; inputs[1].value = "16"; inputs[2].value = "960"; inputs[3].value = "4"; inputs[4].value = "#00aaff";
  content.button("▦ Grid on").click();
  await settle();
  assert.equal(overlay(m.page).querySelectorAll("[data-agent-grid-col]").length, 6);
  assert.match(overlay(m.page).querySelector("[data-agent-grid-cols]").getAttribute("style"), /gap:16px;max-width:960px/);
  eq(statuses.pop(), { text: "✓ Grid on: 6 columns in a 1440 px viewport.", kind: "good" });
  inputs[4].value = "blue";
  content.button("▦ Grid on").click();
  eq(statuses.pop(), { text: "⚠ color must be a hex colour like #ff2d78.", kind: "bad" });
  content.button("Grid off").click();
  await settle();
  assert.equal(overlay(m.page).querySelector("[data-agent-overlay-grid]"), null);
  // Remove the note from the list.
  content.button("Remove this note").click();
  await settle();
  assert.equal(overlay(m.page), null);
  assert.match(content.text(), /No review notes on the page/);
  // Clear all and the screenshot prompt.
  await runTool(m.T, "browser_overlay_grid", {});
  content.button("🧹 Clear all").click();
  await settle();
  assert.equal(overlay(m.page), null);
  eq(statuses.pop(), { text: "All overlays removed.", kind: "good" });
  content.button("📸 Screenshot with overlays").click();
  assert.match(prompts[0], /browser_screenshot, without clearing them/);
});

test("browser_overlay_image: a translucent click-through image in the overlay layer at document or viewport coordinates; replaced, cleared, and failures reported", async () => {
  const { X } = loadExtra("overlay");
  const o = X.imageOptions({ url: " https://cdn.example/design.png " });
  eq(o, { url: "https://cdn.example/design.png", opacity: 0.5, x: 0, y: 0, width: 0, align: "top-left", lock: true, fixed: false });
  assert.equal(X.imageOptions({ url: "data:image/png;base64,AAAA\nBBBB" }).url, "data:image/png;base64,AAAABBBB", "whitespace pasted into a data URL goes");
  assert.throws(() => X.imageOptions({}), /url is required/);
  assert.throws(() => X.imageOptions({ url: "http://cdn.example/x.png" }), /url must be an https: URL or a data:image/);
  assert.throws(() => X.imageOptions({ url: "data:text/html,<p>" }), /url must be an https: URL or a data:image/);
  assert.throws(() => X.imageOptions({ url: "design.png" }), /attached files are not reachable here/);
  assert.throws(() => X.imageOptions({ url: "https://x/y.png", opacity: 0 }), /opacity must be a number between 0.05 and 1/);
  assert.throws(() => X.imageOptions({ url: "https://x/y.png", align: "bottom" }), /align must be top-left or top-center/);
  assert.throws(() => X.imageOptions({ url: "https://x/y.png", width: 0 }), /width must be a number between 1 and 10000/);

  const m = setup();
  imageLoader(m.page, (url) => (/fail/.test(url) ? null : [800, 600]));
  const out = await runTool(m.T, "browser_overlay_image", { url: "https://cdn.example/design.png" });
  assert.equal(out, "Image overlay on: 800 × 600 px at (0, 0) of the document, scrolling with the page, opacity 0.5, top-left, click-through. Take a browser_screenshot to compare it with the page; browser_overlay_clear only=image removes it, another call replaces it.");
  const root = overlay(m.page);
  assert.match(root.getAttribute("style"), /pointer-events:none;z-index:2147483646/);
  const layer = root.querySelector("[data-agent-overlay-image]");
  assert.equal(layer.getAttribute("style"), "position:absolute;left:0px;top:0px;width:800px;height:600px;pointer-events:none;");
  const img = layer.querySelector("img");
  assert.equal(img.getAttribute("src"), "https://cdn.example/design.png");
  assert.equal(img.getAttribute("style"), "display:block;width:100%;height:100%;opacity:0.5;pointer-events:inherit;");
  assert.equal(img.getAttribute("alt"), "");
  // Centred at a width, with offsets, fixed, unlocked: one layer (the earlier image replaced), the height from the aspect ratio.
  const out2 = await runTool(m.T, "browser_overlay_image", { url: "https://cdn.example/design.png", width: 400, x: 10, y: 20, align: "top-center", opacity: 0.8, fixed: true, lock: false });
  assert.equal(out2, "Image overlay on: 400 × 300 px (natural 800 × 600) at (530, 20) of the viewport, fixed to it, opacity 0.8, top-center with offset 10, 20, catching the pointer. Take a browser_screenshot to compare it with the page; browser_overlay_clear only=image removes it, another call replaces it.");
  assert.equal(root.querySelectorAll("[data-agent-overlay-image]").length, 1);
  assert.equal(root.querySelector("[data-agent-overlay-image]").getAttribute("style"), "position:fixed;left:530px;top:20px;width:400px;height:300px;pointer-events:auto;");
  assert.equal(root.querySelector("[data-agent-overlay-image] img").getAttribute("style"), "display:block;width:100%;height:100%;opacity:0.8;pointer-events:inherit;");
  // Cleared on its own, with the rest, and the emptied container goes.
  await runTool(m.T, "browser_overlay_note", { selector: "#box-a", text: "n" });
  assert.equal(await runTool(m.T, "browser_overlay_clear", { only: "image" }), "Removed the image overlay. Still on the page: notes.");
  assert.equal(await runTool(m.T, "browser_overlay_clear", { only: "image" }), "No image overlay was on the page.");
  await runTool(m.T, "browser_overlay_image", { url: "https://cdn.example/design.png" });
  assert.equal(await runTool(m.T, "browser_overlay_note", { remove: 1 }), "Removed note #1. No notes left.");
  assert.equal(overlay(m.page).querySelectorAll("[data-agent-overlay-image]").length, 1, "removing the last note keeps a container that still holds the image");
  assert.equal(await runTool(m.T, "browser_overlay_clear", {}), "Removed all overlays; the page is clean.");
  assert.equal(overlay(m.page), null);
  // Failures: a URL that does not load, no image behind it, a load that takes too long.
  await assert.rejects(m.T.run("browser_overlay_image", { url: "https://cdn.example/fail.png" }), /The image could not be loaded \(https:\/\/cdn\.example\/fail\.png\) — check the URL; a page's content security policy/);
  assert.equal(overlay(m.page), null, "nothing drawn for an image that failed");
  imageLoader(m.page, () => [0, 0]);
  await assert.rejects(m.T.run("browser_overlay_image", { url: "https://cdn.example/empty.png" }), /The URL did not give an image/);
  imageLoader(m.page, () => "never");
  const t0 = Date.now();
  const late = await m.X.pageOverlayImage({ url: "https://cdn.example/slow.png", timeout: 20, opacity: 0.5, x: 0, y: 0, width: 0, align: "top-left", lock: true, fixed: false });
  assert.equal(late.error, "The image did not load within 0.02 s — check the URL (https://cdn.example/slow.png).");
  assert.ok(Date.now() - t0 >= 15, "the timeout waited");
  assert.equal(overlay(m.page), null);
  assert.equal(m.X.IMAGE_TIMEOUT, 15000, "the tool waits 15 s");
});

test("browser_overlay_viewport: presets and sizes, the chrome measured in the tab, the original bounds kept per window and restored by reset; refusals", async () => {
  const { X } = loadExtra("overlay");
  eq(X.viewportRequest({ preset: "mobile" }), { preset: "mobile", width: 375, height: 812 });
  eq(X.viewportRequest({ preset: "mobile-landscape" }), { preset: "mobile-landscape", width: 812, height: 375 });
  eq(X.viewportRequest({ preset: "tablet" }), { preset: "tablet", width: 768, height: 1024 });
  eq(X.viewportRequest({ preset: "laptop" }), { preset: "laptop", width: 1280, height: 800 });
  eq(X.viewportRequest({ preset: "desktop" }), { preset: "desktop", width: 1440, height: 900 });
  eq(X.viewportRequest({ preset: "reset" }), { reset: true });
  eq(X.viewportRequest({ width: 1024 }), { preset: "", width: 1024, height: 0 });
  eq(X.viewportRequest({ width: "600", height: 700.4 }), { preset: "", width: 600, height: 700 });
  assert.throws(() => X.viewportRequest({}), /Give preset \(mobile, mobile-landscape, tablet, laptop, desktop, reset\) or width/);
  assert.throws(() => X.viewportRequest({ preset: "tv" }), /preset must be one of mobile, mobile-landscape, tablet, laptop, desktop or reset/);
  assert.throws(() => X.viewportRequest({ width: 100 }), /width must be a number between 320 and 3840/);
  assert.throws(() => X.viewportRequest({ width: 400, height: 5000 }), /height must be a number between 320 and 3840/);
  eq(X.boundsFor({ width: 375, height: 812 }, { innerWidth: 1584, innerHeight: 880, outerWidth: 1600, outerHeight: 1000 }), { width: 391, height: 932 });
  eq(X.boundsFor({ width: 1024, height: 0 }, { innerWidth: 1584, innerHeight: 880, outerWidth: 1600, outerHeight: 1000 }), { width: 1040 });

  const m = setup();
  const win = m.chrome.windows.list[1];
  const out = await runTool(m.T, "browser_overlay_viewport", { preset: "mobile" });
  assert.equal(out, "Viewport 375 × 812 px, devicePixelRatio 2 (mobile). The window was resized; browser_overlay_viewport preset=reset puts it back. Take a browser_screenshot — reload first if the page lays out from media queries only at load.");
  eq(m.chrome.windows.updates, [{ id: 1, info: { state: "normal", width: 391, height: 932 } }]);
  eq(m.data["agentOverlayViewport:1"], { left: 10, top: 20, width: 1600, height: 1000, state: "normal" }, "the bounds before the first resize, kept for reset");
  // A width alone keeps the height; the saved bounds stay those of the first resize.
  assert.equal(await runTool(m.T, "browser_overlay_viewport", { width: 1024 }), "Viewport 1024 × 812 px, devicePixelRatio 2. The window was resized; browser_overlay_viewport preset=reset puts it back. Take a browser_screenshot — reload first if the page lays out from media queries only at load.");
  eq(m.chrome.windows.updates[1], { id: 1, info: { state: "normal", width: 1040 } });
  eq([win.width, win.height], [1040, 932]);
  eq(m.data["agentOverlayViewport:1"], { left: 10, top: 20, width: 1600, height: 1000, state: "normal" });
  // A window that will not go that small: one correction pass, then the truth.
  const update = m.chrome.windows.update;
  m.chrome.windows.update = async (id, info) => update(id, { ...info, ...(info.width && info.width < 500 ? { width: 500 } : {}) });
  assert.equal(await runTool(m.T, "browser_overlay_viewport", { width: 320, height: 480 }), "Viewport 484 × 480 px, devicePixelRatio 2. Asked for 320 × 480 — the window would not go there; the screen or the browser's minimum window size limits it. The window was resized; browser_overlay_viewport preset=reset puts it back. Take a browser_screenshot — reload first if the page lays out from media queries only at load.");
  assert.equal(m.chrome.windows.updates.length, 4, "the first attempt and one correction");
  m.chrome.windows.update = update;
  // Reset restores the bounds and forgets them; a second reset has nothing to do.
  assert.equal(await runTool(m.T, "browser_overlay_viewport", { preset: "reset" }), "Window restored to 1600 × 1000 px. Viewport 1584 × 880 px, devicePixelRatio 2.");
  eq(m.chrome.windows.updates[4], { id: 1, info: { state: "normal", left: 10, top: 20, width: 1600, height: 1000 } });
  assert.equal(m.data["agentOverlayViewport:1"], undefined);
  assert.equal(await runTool(m.T, "browser_overlay_viewport", { preset: "reset" }), "Nothing to reset: this window was not resized by browser_overlay_viewport. Viewport 1584 × 880 px, devicePixelRatio 2.");
  // A maximised window is brought to normal for the resize and maximised again by reset.
  win.state = "maximized";
  await runTool(m.T, "browser_overlay_viewport", { preset: "tablet" });
  assert.equal(m.data["agentOverlayViewport:1"].state, "maximized");
  await runTool(m.T, "browser_overlay_viewport", { preset: "reset" });
  eq(m.chrome.windows.updates.slice(-2), [{ id: 1, info: { state: "normal", left: 10, top: 20, width: 1600, height: 1000 } }, { id: 1, info: { state: "maximized" } }]);
  // Refusals: arguments, and the panel's own (popup) window.
  await assert.rejects(m.T.run("browser_overlay_viewport", {}), /Give preset .* or width/);
  await assert.rejects(m.T.run("browser_overlay_viewport", { preset: "tv" }), /preset must be one of/);
  await assert.rejects(m.T.run("browser_overlay_viewport", { width: 100 }), /width must be a number between 320 and 3840/);
  const n = m.chrome.windows.updates.length;
  win.type = "popup";
  await assert.rejects(m.T.run("browser_overlay_viewport", { preset: "mobile" }), /sits in a popup window \(the panel's own, or an app window\), which is not resized/);
  assert.equal(m.chrome.windows.updates.length, n);
});

test("browser_overlay_outline: labelled boxes per kind in the overlay layer, the counts and the first ten with their text; all = a colour per kind; replaced, off, cleared; options", async () => {
  const { X } = loadExtra("overlay");
  eq(X.outlineOptions({ what: "headings" }), { what: "headings", kinds: ["headings"], colors: { headings: "#e00060" } });
  eq(X.outlineOptions({ what: "all", color: " #abc " }).colors, { headings: "#abc", links: "#abc", buttons: "#abc", images: "#abc", forms: "#abc", landmarks: "#abc" });
  eq(X.outlineOptions({ what: "all" }).kinds, X.OUTLINE_KINDS);
  assert.throws(() => X.outlineOptions({}), /what is required — one of headings, links, buttons, images, forms, landmarks or all/);
  assert.throws(() => X.outlineOptions({ what: "tables" }), /what must be one of headings, links, buttons, images, forms, landmarks or all/);
  assert.throws(() => X.outlineOptions({ what: "links", color: "blue" }), /color must be a hex colour/);
  assert.equal(X.formatOutline({ counts: { links: 0 }, items: {} }, X.outlineOptions({ what: "links" })), "No links on the page — nothing outlined.");
  assert.equal(X.formatOutline({ counts: {}, items: {} }, X.outlineOptions({ what: "all" })), "No headings, links, buttons, images, forms or landmarks on the page — nothing outlined.");
  const r = { counts: { headings: 2, links: 12 }, items: { headings: [{ label: "h1", text: "Welcome" }, { label: "h2", text: "" }], links: Array.from({ length: 10 }, (_, i) => ({ label: String(i + 1), text: "l" + i })) } };
  assert.equal(X.formatOutline(r, { what: "all", kinds: ["headings", "links", "images"], colors: { headings: "#e00060", links: "#1e90ff", images: "#19a974" } }), [
    "Outlined 14 elements: 2 headings, 12 links, 0 images.",
    'Headings (2, #e00060): h1 "Welcome", h2',
    'Links (12, first 10, #1e90ff): 1 "l0", 2 "l1", 3 "l2", 4 "l3", 5 "l4", 6 "l5", 7 "l6", 8 "l7", 9 "l8", 10 "l9"',
    "Take a browser_screenshot to see the outlines; browser_overlay_clear only=outline (or off=true here) removes them, another call replaces them.",
  ].join("\n"));

  // A page with every kind; elements without a size (the hidden heading, the empty footer) and a link without href are left out.
  const page = fakeDocument(
    '<header id="hd"><h1 id="h1">Welcome</h1><nav id="nav"><a href="/a" id="a">A</a><a href="/b" id="b">B</a><a id="c">no href</a></nav></header>' +
    '<main id="main"><h2 id="h2">Section</h2><img id="img" src="/pics/hero.png" alt="Hero"><form id="form" name="signup"><input type="hidden" name="t"><input name="email"><select></select><textarea></textarea><button id="go">Go</button></form>' +
    '<div id="fake" role="button">Fake</div><h3 id="hidden">Hidden</h3></main><footer role="contentinfo"></footer>'
  );
  const rects = { hd: [0, 0, 1000, 80], h1: [10, 10, 300, 40], nav: [400, 10, 500, 40], a: [400, 10, 50, 40], b: [460, 10, 50, 40], c: [520, 10, 50, 40], main: [0, 100, 1000, 600], h2: [10, 110, 300, 30], img: [10, 150, 400, 300], form: [10, 460, 400, 200], go: [10, 600, 80, 30], fake: [500, 600, 80, 30] };
  for (const id of Object.keys(rects)) { const [left, top, width, height] = rects[id]; page.querySelector("#" + id)._rect = { left, top, width, height }; }
  const m = loadExtra("overlay", { document: page });
  m.context.window.scrollX = 0; m.context.window.scrollY = 20;
  for (const fn of PAGE_FNS) m.scripting.results[fn] = (...a) => m.X[fn](...a);
  const out = await runTool(m.T, "browser_overlay_outline", { what: "all" });
  assert.equal(out, [
    "Outlined 11 elements: 2 headings, 2 links, 2 buttons, 1 image, 1 form, 3 landmarks.",
    'Headings (2, #e00060): h1 "Welcome", h2 "Section"',
    'Links (2, #1e90ff): 1 "A", 2 "B"',
    'Buttons (2, #ff8c00): 1 "Go", 2 "Fake"',
    'Images (1, #19a974): 400×300 "Hero"',
    'Forms (1, #8e44ad): 3 fields "signup"',
    'Landmarks (3, #555555): header "Welcome A B no href", nav "A B no href", main "Section Go Fake Hidden"',
    "Take a browser_screenshot to see the outlines; browser_overlay_clear only=outline (or off=true here) removes them, another call replaces them.",
  ].join("\n"));
  const root = overlay(page);
  assert.match(root.getAttribute("style"), /pointer-events:none;z-index:2147483646/);
  const layer = root.querySelector("[data-agent-overlay-outline]");
  assert.match(layer.getAttribute("style"), /pointer-events:none/);
  const boxes = layer.querySelectorAll("[data-agent-outline]");
  assert.equal(boxes.length, 11);
  eq(boxes.map((b) => b.getAttribute("data-agent-outline")), ["headings", "headings", "links", "links", "buttons", "buttons", "images", "forms", "landmarks", "landmarks", "landmarks"]);
  assert.match(boxes[0].getAttribute("style"), /left:10px;top:30px;width:300px;height:40px;.*outline:2px solid #e00060/, "document coordinates: the scroll is added");
  assert.equal(boxes[0].textContent, "h1");
  assert.equal(boxes[6].textContent, "400×300");
  assert.match(boxes[6].getAttribute("style"), /outline:2px solid #19a974/);
  assert.equal(boxes[7].textContent, "3 fields");
  eq(boxes.slice(8).map((b) => b.textContent), ["header", "nav", "main"]);
  // One kind in a given colour replaces the outlines; the first ten of many are listed.
  const out2 = await runTool(m.T, "browser_overlay_outline", { what: "links", color: "#123456" });
  assert.equal(out2, 'Outlined 2 elements: 2 links.\nLinks (2, #123456): 1 "A", 2 "B"\nTake a browser_screenshot to see the outlines; browser_overlay_clear only=outline (or off=true here) removes them, another call replaces them.');
  assert.equal(root.querySelectorAll("[data-agent-overlay-outline]").length, 1);
  assert.equal(root.querySelectorAll("[data-agent-outline]").length, 2);
  assert.match(root.querySelector("[data-agent-outline]").getAttribute("style"), /outline:2px solid #123456/);
  for (let i = 0; i < 12; i++) { const a = page.createElement("a"); a.setAttribute("href", "/l" + i); a.textContent = "L" + i; a._rect = { left: 0, top: 700 + i * 10, width: 50, height: 10 }; page.querySelector("main").appendChild(a); }
  assert.match(await runTool(m.T, "browser_overlay_outline", { what: "links" }), /^Outlined 14 elements: 14 links\.\nLinks \(14, first 10, #1e90ff\): 1 "A", 2 "B", 3 "L0", .*, 10 "L7"\n/);
  // off=true and browser_overlay_clear remove them; an emptied container goes, one that still holds notes stays.
  assert.equal(await runTool(m.T, "browser_overlay_outline", { what: "headings", off: true }), "Outlines removed.");
  assert.equal(overlay(page), null);
  assert.equal(await runTool(m.T, "browser_overlay_outline", { what: "headings", off: true }), "No outlines were on the page.");
  assert.equal(await runTool(m.T, "browser_overlay_clear", { only: "outline" }), "No outline overlay was on the page.");
  await runTool(m.T, "browser_overlay_outline", { what: "headings" });
  await runTool(m.T, "browser_overlay_note", { selector: "#h1", text: "n" });
  assert.equal(await runTool(m.T, "browser_overlay_clear", { only: "outline" }), "Removed the outline overlay. Still on the page: notes.");
  await runTool(m.T, "browser_overlay_outline", { what: "headings" });
  assert.equal(await runTool(m.T, "browser_overlay_outline", { what: "headings", off: true }), "Outlines removed. Still on the page: notes.");
  await runTool(m.T, "browser_overlay_outline", { what: "forms" });
  assert.equal(await runTool(m.T, "browser_overlay_note", { remove: 1 }), "Removed note #1. No notes left.");
  assert.equal(overlay(page).querySelectorAll("[data-agent-overlay-outline]").length, 1, "removing the last note keeps a container that still holds outlines");
  assert.equal(await runTool(m.T, "browser_overlay_clear", {}), "Removed all overlays; the page is clean.");
  assert.equal(overlay(page), null);
  await assert.rejects(m.T.run("browser_overlay_outline", {}), /what is required/);
  await assert.rejects(m.T.run("browser_overlay_outline", { what: "menus" }), /what must be one of/);
  assert.equal(overlay(page), null, "nothing drawn for a refused call");
});

test("browser_overlay_responsive: one capture per width with the window resized and put back (also after an error), full-page stitching on a canvas, overflow notes, save; responsiveRequest and stitchPlan", async () => {
  const { X } = loadExtra("overlay");
  eq(X.responsiveRequest({}), { widths: [375, 768, 1280], fullPage: false, save: false });
  eq(X.responsiveRequest({ widths: [1024, "600", 1024.4], fullPage: true, save: true }), { widths: [1024, 600], fullPage: true, save: true }, "duplicates dropped, whole px");
  assert.throws(() => X.responsiveRequest({ widths: [] }), /widths must be an array of viewport widths in px/);
  assert.throws(() => X.responsiveRequest({ widths: "375" }), /widths must be an array/);
  assert.throws(() => X.responsiveRequest({ widths: [100] }), /each width must be a number between 320 and 3840/);
  assert.throws(() => X.responsiveRequest({ widths: [375, null] }), /each width must be a number/);
  assert.throws(() => X.responsiveRequest({ widths: [320, 400, 500, 600, 700, 800, 900] }), /widths: at most 6 per call/);
  eq(X.stitchPlan(2140, 812, 8), { offsets: [0, 812, 1328], height: 2140, cut: false }, "the last screen ends at the page's bottom");
  eq(X.stitchPlan(800, 812, 8), { offsets: [0], height: 800, cut: false });
  eq(X.stitchPlan(812, 812, 8), { offsets: [0], height: 812, cut: false });
  eq(X.stitchPlan(10000, 812, 8), { offsets: [0, 812, 1624, 2436, 3248, 4060, 4872, 5684], height: 6496, cut: true }, "capped at eight screens");
  assert.match(X.responsiveName("example.com", 375, true, 0), /^example\.com-375px-full-\d{8}-\d{6}\.png$/);
  assert.match(X.responsiveName("", 768, false, 0), /^page-768px-\d{8}-\d{6}\.png$/);

  const m = setup();
  const canvases = fakeCanvas(m);
  const win = m.chrome.windows.list[1];
  // The page as the fake window gives it (16 px of chrome beside the page, 120 above): 420 px wide under 400 (overflow), 2140 tall, dpr 2.
  let scrollY = 0;
  const layout = () => { const iw = win.width - 16, ih = win.height - 120; return { innerWidth: iw, innerHeight: ih, scrollWidth: iw < 400 ? 420 : iw, scrollHeight: 2140, scrollX: 0, scrollY, dpr: 2 }; };
  m.scripting.results.pageLayoutInfo = layout;
  m.scripting.results.pageScrollTo = (x, y) => { scrollY = Math.max(0, Math.min(y, 2140 - (win.height - 120))); return { scrollX: 0, scrollY }; };
  m.chrome.tabs.capture = () => `data:image/png;base64,FAKE:${(win.width - 16) * 2}x${(win.height - 120) * 2}`;
  const parts = await m.T.run("browser_overlay_responsive", {});
  eq(parts.map((p) => p.type), ["image", "text", "image", "text", "image", "text", "text"]);
  eq(parts[0], { type: "image", data: "CANVAS:750x1760:1", mimeType: "image/png" }, "the viewport at dpr 2");
  assert.equal(parts[1].text, "375 px: 375×880, page 420×2140 — horizontal overflow: 45 px wider than the viewport");
  assert.equal(parts[2].data, "CANVAS:1536x1760:1");
  assert.equal(parts[3].text, "768 px: 768×880, page 768×2140");
  assert.equal(parts[5].text, "1280 px: 1280×880, page 1280×2140");
  assert.equal(parts[6].text, "Window restored to 1600 × 1000 px. Horizontal overflow at 375 px (the page is 420 px wide, 45 px over). fullPage=true captures the whole page (scrolled and stitched, up to 8 screens per width).");
  eq(m.captures.map((c) => [c.windowId, c.options.format]), [[1, "png"], [1, "png"], [1, "png"]]);
  eq(m.chrome.windows.updates, [
    { id: 1, info: { state: "normal", width: 391 } }, { id: 1, info: { state: "normal", width: 784 } }, { id: 1, info: { state: "normal", width: 1296 } },
    { id: 1, info: { state: "normal", left: 10, top: 20, width: 1600, height: 1000 } },
  ], "each width through the viewport code (height unchanged), then the original bounds");
  eq([win.width, win.height, win.state], [1600, 1000, "normal"]);
  eq(canvases[0].draws, [["data:image/png;base64,FAKE:750x1760", 0, 0, 750, 1760, 0, 0, 750, 1760]]);
  eq(m.downloads.calls, []);
  assert.equal(m.scripting.calls.filter((c) => c.func === "pageScrollTo").length, 0, "no scrolling without fullPage");
  assert.equal(m.data["agentOverlayViewport:1"], undefined, "browser_overlay_viewport's reset bounds are not touched");
  // fullPage: three screens scrolled and stitched (scaled to the longest side allowed), saved to Downloads, the scroll put back.
  m.chrome.windows.updates.length = 0; m.captures.length = 0;
  const parts2 = await m.T.run("browser_overlay_responsive", { widths: [375], fullPage: true, save: true });
  assert.equal(parts2.length, 3);
  assert.match(parts2[1].text, /^375 px: 375×880, page 420×2140, 3 screens stitched, image scaled to 701×4000 — horizontal overflow: 45 px wider than the viewport — saved as example\.com-375px-full-\d{8}-\d{6}\.png \(download id 41\)$/);
  assert.equal(parts2[0].data, "CANVAS:701x4000:3");
  assert.equal(parts2[2].text, "Window restored to 1600 × 1000 px. Horizontal overflow at 375 px (the page is 420 px wide, 45 px over).");
  assert.equal(m.captures.length, 3);
  const stitched = canvases[canvases.length - 1];
  eq(stitched.draws.map((d) => d[6]), [0, 1645, 2355], "each screen at its scroll offset, in device px, scaled");
  eq(m.scripting.calls.filter((c) => c.func === "pageScrollTo").map((c) => c.args[1]), [0, 880, 1260, 0], "the planned offsets, then back to where the page was");
  assert.equal(m.downloads.calls.length, 1);
  assert.equal(m.downloads.calls[0].url, "data:image/png;base64,CANVAS:701x4000:3");
  assert.match(m.downloads.calls[0].filename, /^example\.com-375px-full-\d{8}-\d{6}\.png$/);
  assert.equal(m.downloads.calls[0].conflictAction, "uniquify");
  eq([win.width, win.height], [1600, 1000]);
  // A maximised window is brought back to maximised; a capture that fails still puts the window back.
  win.state = "maximized";
  m.chrome.windows.updates.length = 0;
  await runTool(m.T, "browser_overlay_responsive", { widths: [768] });
  eq(m.chrome.windows.updates.slice(-2), [{ id: 1, info: { state: "normal", left: 10, top: 20, width: 1600, height: 1000 } }, { id: 1, info: { state: "maximized" } }]);
  assert.equal(win.state, "maximized");
  win.state = "normal";
  m.chrome.tabs.capture = () => { throw new Error("capture failed"); };
  m.chrome.windows.updates.length = 0;
  await assert.rejects(m.T.run("browser_overlay_responsive", { widths: [375, 768] }), /capture failed/);
  eq(m.chrome.windows.updates, [{ id: 1, info: { state: "normal", width: 391 } }, { id: 1, info: { state: "normal", left: 10, top: 20, width: 1600, height: 1000 } }], "resized once, then restored after the error");
  eq([win.width, win.height], [1600, 1000]);
  // Refusals, before anything is resized.
  m.chrome.windows.updates.length = 0;
  await assert.rejects(m.T.run("browser_overlay_responsive", { widths: [100] }), /each width must be a number between 320 and 3840/);
  delete m.chrome.downloads;
  m.chrome.tabs.capture = () => "data:image/png;base64,FAKE:750x1760";
  await assert.rejects(m.T.run("browser_overlay_responsive", { widths: [375], save: true }), /cannot save files \(no downloads permission\)/);
  eq([win.width, win.height], [1600, 1000], "put back even when saving failed");
  m.chrome.windows.updates.length = 0;
  win.type = "popup";
  await assert.rejects(m.T.run("browser_overlay_responsive", {}), /sits in a popup window .* which is not resized/);
  eq(m.chrome.windows.updates, []);
});
