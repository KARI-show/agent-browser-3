// Layout overlays (browser/extras/overlay.js) against fakes of chrome, the tool runtime and a small DOM: the
// grid geometry, the measurement math and alignment hints, note numbering, the four tools' reports and what
// they draw, and the 📐 tab. The real page is exercised in tests/e2e/extras-stencil.e2e.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
const plain = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x))); // values made inside the vm have another realm's prototypes
const eq = (a, b, msg) => assert.deepEqual(plain(a), plain(b), msg);
import { fakeCtx, fakeDocument, loadExtra, runTool, settle } from "./mocks/extras-stencil.mjs";

const PAGE_FNS = ["pageRects", "pageOverlayGrid", "pageDrawMeasure", "pageOverlayNotes", "pageOverlayNote", "pageOverlayNoteRemove", "pageOverlayClear"];

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
  return { ...m, page, w };
}
const overlay = (page) => page.documentElement.querySelector("[data-agent-overlay]");

test("loads only for a brand with the feature; registers four tools, the 📐 tab and three Design commands", () => {
  const off = loadExtra("overlay", { features: { overlay: false, elements: true } });
  eq(off.T.names, []);
  assert.equal(off.X, undefined);
  const m = loadExtra("overlay");
  eq(m.T.names, ["browser_overlay_grid", "browser_overlay_measure", "browser_overlay_note", "browser_overlay_clear"]);
  assert.equal(m.tab.label, "📐 Overlay");
  eq(m.commands.map((c) => [c.group, c.name, !!c.partial]), [
    ["Design", "Show a 12-column grid", false], ["Design", "Measure the spacing between these two elements", true], ["Design", "Mark up this page for review", false],
  ]);
  assert.match(m.commands[0].prompt, /browser_overlay_grid .*screenshot/);
  assert.match(m.commands[2].prompt, /browser_overlay_note.*screenshot/);
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
  await assert.rejects(m.T.run("browser_overlay_clear", { only: "boxes" }), /only must be grid, measure or notes/);
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
