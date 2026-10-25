// Palette (browser/extras/palette.js) against fakes of chrome and the tool registry, with styles.js
// loaded first as extras.js does: colour normalisation, the WCAG contrast maths, the palette summary
// and its reports, the theme CSS and its mapping, browser_palette_theme saving through the styles
// extra's key (one theme per site, preview, off), and the 🧪 tab. The page-side walkers run for real
// in tests/e2e/extras-palette.e2e.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeCtx, fakeDom, loadExtras, plain, runTool, settle } from "./mocks/extras-palette.mjs";

// Values made inside the vm have another realm's prototypes: deepEqual needs plain copies.

const load = (opts) => loadExtras(opts);

/** A raw extraction like pageExtractPalette returns for a light page with an orange brand. */
const RAW = {
  url: "https://www.example.com/", title: "Example", total: 120, sampled: 100,
  text: [
    { v: "rgb(34, 34, 34)", n: 40, sels: [{ s: "p", n: 30 }, { s: "li", n: 10 }] },
    { v: "#222", n: 5, sels: [{ s: "h2", n: 5 }] }, // the same colour written another way merges
    { v: "rgb(153, 153, 153)", n: 3, sels: [{ s: "p.low", n: 3 }] },
    { v: "rgb(255, 255, 255)", n: 2, sels: [{ s: "a.cta", n: 2 }] },
    { v: "rgba(0, 0, 0, 0)", n: 9, sels: [] }, // transparent text is not a colour of the palette
  ],
  bg: [
    { v: "rgb(255, 255, 255)", n: 50, sels: [{ s: "body", n: 1 }, { s: "main", n: 1 }] },
    { v: "rgb(244, 244, 244)", n: 6, sels: [{ s: "div.card", n: 6 }] },
    { v: "rgb(255, 102, 0)", n: 2, sels: [{ s: "a.cta", n: 2 }] },
  ],
  border: [{ v: "rgb(221, 221, 221)", n: 6 }],
  fonts: [
    { family: "Georgia", stack: "Georgia, serif", n: 45, sizes: [{ v: "16/400", n: 40 }, { v: "14/400", n: 5 }] },
    { family: "Arial", stack: "Arial, sans-serif", n: 1, sizes: [{ v: "32/700", n: 1 }] },
  ],
  spacing: [{ v: "16", n: 80 }, { v: "8", n: 20 }],
  themeColor: "#ff6600",
  vars: [{ name: "--brand", value: "#ff6600" }, { name: "--bg", value: "#ffffff" }, { name: "--ink", value: "rgb(34, 34, 34)" }, { name: "--gap", value: "16px" }],
  body: { bg: "rgb(255, 255, 255)", color: "rgb(34, 34, 34)" }, link: "rgb(0, 102, 204)", button: { bg: "rgb(255, 102, 0)", color: "rgb(255, 255, 255)" },
};
const CONTRAST = {
  url: "https://www.example.com/", total: 50, checked: 10, styles: [
    { fg: "rgb(153, 153, 153)", layers: ["rgba(0, 0, 0, 0)", "rgb(255, 255, 255)"], size: 16, weight: 400, image: false, text: "Low-contrast fine print nobody can read.", selector: "main > p.low", n: 1 },
    { fg: "rgb(34, 34, 34)", layers: ["rgba(0, 0, 0, 0)", "rgb(255, 255, 255)"], size: 16, weight: 400, image: false, text: "Readable paragraph in dark grey on white.", selector: "main > p", n: 3 },
    { fg: "rgb(119, 119, 119)", layers: ["rgb(255, 255, 255)"], size: 24, weight: 400, image: false, text: "Large grey heading", selector: "main > h2", n: 1 },
    { fg: "rgb(119, 119, 119)", layers: ["rgb(255, 255, 255)"], size: 20, weight: 700, image: true, text: "Bold grey over a picture", selector: "div.hero > p", n: 2 },
  ],
};

test("loads only with the feature; registers three tools, the 🧪 tab and three Design commands; without the styles extra its tools say so", async () => {
  const off = load({ features: { styles: true, palette: false } });
  assert.deepEqual(off.T.names.filter((n) => /palette/.test(n)), []);
  assert.deepEqual(off.tabs.map((t) => t.id), ["styles"]);
  assert.equal(off.P, undefined);

  const { T, tabs, commands, P } = load();
  assert.deepEqual(T.names.filter((n) => /palette/.test(n)), ["browser_palette_extract", "browser_palette_contrast", "browser_palette_theme"]);
  assert.deepEqual(plain(tabs.map((t) => [t.id, t.label, t.storageKeys])), [["styles", "🎨 Styles", ["agentSiteStyles"]], ["palette", "🧪 Palette", ["agentSiteStyles"]]]);
  assert.deepEqual(commands.filter((c) => /browser_palette_/.test(c.prompt)).map((c) => [c.group, c.name]), [
    ["Design", "What colours and fonts does this page use?"], ["Design", "Check this page's contrast"], ["Design", "Dark theme for this site"],
  ]);
  assert.equal(commands.filter((c) => c.name === "Dark theme for this site").length, 1, "defined once, by the palette");
  assert.match(commands.find((c) => c.name === "Dark theme for this site").prompt, /browser_palette_theme mode=dark/);
  assert.equal(typeof P.themeCss, "function");

  // palette.js alone (a build that forgot styles): the module loads, a theme explains what is missing.
  const lone = loadExtras({ ids: ["palette"], features: { palette: true } });
  lone.scripting.results.pageExtractPalette = RAW;
  await assert.rejects(lone.T.run("browser_palette_theme", { mode: "dark" }), /The styles extra is not in this build/);
});

test("colour normalisation: rgb/rgba/hex/hsl/color(srgb)/names → #rrggbb, alpha dropped unless fully transparent", () => {
  const { P } = load();
  assert.equal(P.normalizeColor("rgb(255, 255, 255)"), "#ffffff");
  assert.equal(P.normalizeColor("rgba(0, 0, 0, 0)"), "transparent");
  assert.equal(P.normalizeColor("transparent"), "transparent");
  assert.equal(P.normalizeColor("rgba(10, 20, 30, 0.5)"), "#0a141e");
  assert.equal(P.normalizeColor("rgb(10 20 30 / 50%)"), "#0a141e");
  assert.equal(P.normalizeColor("#abc"), "#aabbcc");
  assert.equal(P.normalizeColor("#AABBCCDD"), "#aabbcc");
  assert.equal(P.normalizeColor("#abcd"), "#aabbcc");
  assert.equal(P.normalizeColor("hsl(0, 100%, 50%)"), "#ff0000");
  assert.equal(P.normalizeColor("hsl(120deg 100% 25%)"), "#008000");
  assert.equal(P.normalizeColor("color(srgb 1 0 0)"), "#ff0000");
  assert.equal(P.normalizeColor("White"), "#ffffff");
  assert.equal(P.normalizeColor("rebeccapurple"), "#663399");
  assert.equal(P.normalizeColor("junk"), null);
  assert.equal(P.normalizeColor("16px"), null);
  assert.equal(P.normalizeColor("#12345"), null);
  assert.equal(P.normalizeColor(""), null);
  assert.deepEqual(plain(P.rgbToHsl(P.parseColor("#ff6600"))), { h: 24, s: 100, l: 50 });
  assert.equal(P.hslHex(24, 100, 50), "#ff6600");
});

test("WCAG contrast: known pairs, alpha blending over the effective background, large text", () => {
  const { P } = load();
  assert.equal(P.contrastRatio("#000000", "#ffffff"), 21);
  assert.equal(P.contrastRatio("#ffffff", "#000000"), 21);
  assert.equal(P.contrastRatio("#777777", "#ffffff"), 4.48);
  assert.equal(P.contrastRatio("#767676", "#ffffff"), 4.54, "the classic AA grey");
  assert.equal(P.contrastRatio("#999999", "#ffffff"), 2.85);
  assert.equal(P.contrastRatio("#ff6600", "#ffffff"), 2.94);
  assert.equal(P.effectiveBackground(["rgba(0, 0, 0, 0.5)", "rgb(255, 255, 255)"]), "#808080");
  assert.equal(P.effectiveBackground(["rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0)", "rgb(0, 0, 0)"]), "#000000");
  assert.equal(P.effectiveBackground(["rgba(255, 0, 0, 0.5)", "rgba(0, 0, 255, 0.5)", "rgb(255, 255, 255)"]), "#bf4080", "two translucent layers composite in order");
  assert.equal(P.effectiveBackground(["rgba(0, 0, 0, 0)"]), "#ffffff", "nothing opaque → the canvas is white");
  assert.equal(P.effectiveBackground([]), "#ffffff");
  assert.equal(P.isLargeText(24, 400), true);
  assert.equal(P.isLargeText(18.66, 700), true);
  assert.equal(P.isLargeText(18.66, 400), false);
  assert.equal(P.isLargeText(23.9, 400), false);
  assert.deepEqual([P.threshold("AA", false), P.threshold("AA", true), P.threshold("AAA", false), P.threshold("AAA", true)], [4.5, 3, 7, 4.5]);

  const r = P.evaluateContrast(CONTRAST, "AA");
  assert.deepEqual(plain(r.failures.map((f) => [f.selector, f.ratio, f.need, f.fg, f.bg])), [["main > p.low", 2.85, 4.5, "#999999", "#ffffff"]]);
  // #777 at 24px (large) and at 20px bold (large) passes AA's 3:1 but not AAA's 4.5:1.
  assert.deepEqual(plain(r.styles.map((s) => [s.selector, s.pass, s.large, s.aaa])), [["main > p.low", false, false, false], ["main > p", true, false, true], ["main > h2", true, true, false], ["div.hero > p", true, true, false]]);
  assert.equal(r.passes, 3);
  assert.equal(r.aaa, 1);
  assert.equal(r.approx, 1);
  const aaa = P.evaluateContrast(CONTRAST, "AAA");
  assert.deepEqual(plain(aaa.failures.map((f) => f.selector)), ["main > p.low", "main > h2", "div.hero > p"], "AAA: 7:1 normal, 4.5:1 large");
  // A translucent text colour is blended before measuring.
  const half = P.evaluateContrast({ styles: [{ fg: "rgba(0, 0, 0, 0.5)", layers: ["rgb(255, 255, 255)"], size: 16, weight: 400, text: "x", selector: "p" }] }, "AA");
  assert.equal(half.styles[0].fg, "#808080");
  assert.equal(half.styles[0].ratio, 3.95);
  // A fix suggestion keeps the hue and reaches the threshold.
  assert.equal(P.contrastRatio(P.suggestText("#ffffff", "#999999", 4.5), "#ffffff") >= 4.5, true);
  assert.equal(P.suggestText("#000000", "#333333", 4.5) >= "#8", true, "lighter on a dark background");
});

test("summarizePalette: merges colours by hex with their selectors, drops transparent, builds the type scale, keeps colour-looking variables only", () => {
  const { P } = load();
  const p = P.summarizePalette(RAW);
  assert.deepEqual(plain(p.text.map((c) => [c.hex, c.n, c.selectors])), [["#222222", 45, ["p", "li", "h2"]], ["#999999", 3, ["p.low"]], ["#ffffff", 2, ["a.cta"]]]);
  assert.deepEqual(plain(p.bg.map((c) => [c.hex, c.n])), [["#ffffff", 50], ["#f4f4f4", 6], ["#ff6600", 2]]);
  assert.deepEqual(plain(p.border.map((c) => c.hex)), ["#dddddd"]);
  assert.deepEqual(plain(p.fonts.map((f) => [f.family, f.n, f.sizes.map((s) => s.size + "/" + s.weight)])), [["Georgia", 45, ["16/400", "14/400"]], ["Arial", 1, ["32/700"]]]);
  assert.deepEqual(plain(p.scale), [14, 16, 32]);
  assert.deepEqual(plain(p.spacing), [{ px: 16, n: 80 }, { px: 8, n: 20 }]);
  assert.equal(p.themeColor, "#ff6600");
  assert.deepEqual(plain(p.vars.map((v) => [v.name, v.hex])), [["--brand", "#ff6600"], ["--bg", "#ffffff"], ["--ink", "#222222"]]);
  assert.deepEqual(plain(p.body), { bg: "#ffffff", color: "#222222" });
  assert.equal(p.link, "#0066cc");
  assert.deepEqual(plain(p.button), { bg: "#ff6600", color: "#ffffff" });

  const report = P.formatPalette(p);
  assert.match(report, /^Palette of example\.com \(100 of 120 elements sampled\):/);
  assert.match(report, /Text colours:\n  #222222  ×45  \(p, li, h2\)\n  #999999  ×3  \(p\.low\)/);
  assert.match(report, /Backgrounds:\n  #ffffff  ×50  \(body, main\)/);
  assert.match(report, /Georgia — 45 text elements; 16px\/400 ×40, 14px\/400 ×5/);
  assert.match(report, /Type scale: 14, 16, 32 px/);
  assert.match(report, /Spacing \(margins\/paddings rounded to 4px\): 16px ×80, 8px ×20/);
  assert.match(report, /Body: #ffffff background, #222222 text; links #0066cc; buttons #ffffff on #ff6600; theme-color #ff6600/);
  assert.match(report, /CSS variables on :root: --brand: #ff6600, --bg: #ffffff, --ink: #222222/);
  const css = P.cssVariables(p);
  assert.match(css, /^:root \{\n  --c1: #222222; \/\* text, ×45 \*\/\n  --c2: #999999;/);
  assert.match(css, /--c4: #f4f4f4; \/\* background, ×6 \*\//, "a colour already listed as text is not repeated");
  assert.match(css, /--link: #0066cc;\n  --button-bg: #ff6600;\n  --button-text: #ffffff;\n  --theme-color: #ff6600;\n  --font-1: Georgia, serif;\n  --font-2: Arial, sans-serif;/);
  // An empty page.
  const empty = P.summarizePalette({ url: "https://x.example/", total: 0, sampled: 0 });
  assert.deepEqual(plain([empty.text, empty.bg, empty.fonts, empty.scale, empty.vars]), [[], [], [], [], []]);
  assert.match(P.formatPalette(empty), /^Palette of x\.example \(0 of 0 elements sampled\):\n\nBody: #ffffff background, #000000 text$/);
});

test("themeCss dark: color-scheme dark, light backgrounds → dark surfaces on their selectors, dark text → light, variables mapped, links kept in hue and brightened, no invert filter", () => {
  const { P } = load();
  const p = P.summarizePalette(RAW);
  const t = P.themeCss(p, "dark", null, "example.com");
  assert.equal(t.name, "theme:dark");
  const css = t.css;
  assert.match(css, /^\/\* Palette theme: dark for example\.com/);
  assert.match(css, /:root \{ color-scheme: dark; \}/);
  assert.match(css, /html, body \{ background-color: #121212 !important; color: #e6e6e6 !important; \}/);
  assert.match(css, /:root \{ --bg: #121212 !important; --ink: #[0-9a-f]{6} !important; \}/, "light and dark colour variables are mapped; the brand variable is kept");
  assert.doesNotMatch(css, /--brand/);
  assert.match(css, /\nmain \{ background-color: #121212 !important; \}/, "html/body are covered by the page rule, not repeated");
  assert.match(css, /div\.card \{ background-color: #(1|2)[0-9a-f]{5} !important; \}/);
  assert.doesNotMatch(css, /a\.cta \{ background-color/, "the saturated brand background of the button is not turned dark");
  assert.match(css, /p, li, h2 \{ color: #[0-9a-f]{6} !important; \}/);
  assert.match(css, /p\.low \{ color: #a6a6a6 !important; \}/, "mid greys become the muted text");
  assert.match(css, /a, a:visited \{ color: #64adf7 !important; \}/, "the site's blue link, brightened");
  assert.deepEqual(P.rgbToHsl(P.parseColor("#64adf7")).h, P.rgbToHsl(P.parseColor("#0066cc")).h, "same hue");
  assert.match(css, /button, \[role=button\], input\[type=submit\], input\[type=button\] \{ background-color: #[0-9a-f]{6} !important; color: #ffffff !important/, "the orange button keeps its white text (it still passes 3:1)");
  assert.match(css, /img, video, canvas, picture, svg, iframe \{ filter: none; \}/);
  assert.doesNotMatch(css, /filter:\s*invert/);
  // Every mapped surface is dark and every mapped text light.
  for (const m of t.mapping) {
    if (m.what === "background") assert.ok(P.luminance(m.to) < 0.06, m.from + " → " + m.to + " is dark");
    if (m.what === "text") assert.ok(P.luminance(m.to) > 0.35, m.from + " → " + m.to + " is light");
    if (m.what === "background" || m.what === "text") assert.ok(P.contrastRatio(m.what === "background" ? m.to : m.to, m.what === "background" ? "#e6e6e6" : "#121212") >= 4.5, m.what + " " + m.to + " is readable");
  }
  assert.match(P.formatMapping(t.mapping), /background: #ffffff → #121212  \(main\)\n  background: #f4f4f4 → #[0-9a-f]{6}  \(div\.card\)\n  text: #222222 → #[0-9a-f]{6}  \(p, li, h2\)/);
  assert.match(P.formatMapping(t.mapping), /links: #0066cc → #64adf7/);
});

test("themeCss sepia / high-contrast / custom: tokens and validation", () => {
  const { P } = load();
  const p = P.summarizePalette(RAW);
  const sepia = P.themeCss(p, "sepia", null, "example.com");
  assert.match(sepia.css, /:root \{ color-scheme: light; \}\nhtml, body \{ background-color: #f4ecd8 !important; color: #5b4636 !important; \}/);
  assert.match(sepia.css, /a, a:visited \{ color: #7a4a12 !important; \}/);
  for (const m of sepia.mapping) if (m.what === "background") assert.ok(P.luminance(m.to) > 0.4 && P.rgbToHsl(P.parseColor(m.to)).h >= 30 && P.rgbToHsl(P.parseColor(m.to)).h <= 45, m.to + " is a warm light paper tone");

  const hc = P.themeCss(p, "high-contrast", null, "example.com");
  assert.match(hc.css, /html, body \{ background-color: #000000 !important; color: #ffffff !important; \}/);
  assert.match(hc.css, /a, a:visited \{ color: #ffff00 !important; \}\na:visited \{ color: #ff80ff !important; \}\n\*:focus-visible \{ outline: 3px solid #ffbf00 !important/);
  assert.match(hc.css, /button, \[role=button\][^\n]* background-color: #ffffff !important; color: #000000 !important/);
  for (const m of hc.mapping) if (m.what === "background") assert.equal(m.to, "#000000");
  for (const m of hc.mapping) if (m.what === "text") assert.equal(m.to, "#ffffff");

  const custom = P.themeCss(p, "custom", { bg: "rgb(0, 17, 34)", text: "#eef", link: "hsl(50, 100%, 70%)" }, "example.com");
  assert.equal(custom.tokens.bg, "#001122");
  assert.equal(custom.tokens.text, "#eeeeff");
  assert.equal(custom.tokens.link, "#ffe566");
  assert.equal(custom.tokens.scheme, "dark", "picked from the background's lightness");
  assert.match(custom.css, /html, body \{ background-color: #001122 !important; color: #eeeeff !important; \}/);
  assert.equal(P.themeCss(p, "custom", { bg: "#ffffff", text: "#000000" }).tokens.scheme, "light");
  assert.throws(() => P.themeCss(p, "custom", { bg: "nope" }), /overrides\.bg: 'nope' is not a colour/);
  assert.throws(() => P.themeCss(p, "custom", { glow: "#fff" }), /overrides\.glow is not a theme token/);
  assert.throws(() => P.themeCss(p, "custom", { scheme: "blue" }), /overrides\.scheme must be 'dark' or 'light'/);
  assert.throws(() => P.themeCss(p, "neon"), /mode must be dark, sepia, high-contrast, custom or off/);
});

test("browser_palette_theme: saves through the styles key as theme:<mode> (one theme per site, applied at once), preview does not save, off removes", async () => {
  const { T, data, scripting, S } = load();
  scripting.results.pageExtractPalette = RAW;
  await assert.rejects(T.run("browser_palette_theme", {}), /mode is required/);
  await assert.rejects(T.run("browser_palette_theme", { mode: "neon" }), /mode must be/);

  const out = await runTool(T, "browser_palette_theme", { mode: "dark" });
  assert.match(out, /^Saved the dark theme as override 'theme:dark' for example\.com \(\d\.\d KB\); applied in the current tab\. The site keeps it until browser_style_remove or mode=off\.\nMapping:\n  page: #ffffff \/ #222222 → #121212 \/ #e6e6e6/);
  assert.match(out, /Check it with browser_screenshot/);
  const saved = data.agentSiteStyles["example.com"]["theme:dark"];
  assert.ok(saved && saved.enabled === true, "stored under the styles key, enabled");
  assert.match(saved.css, /color-scheme: dark/);
  assert.deepEqual(plain(S.validateCss(saved.css)), { ok: true, rules: saved.css.split("\n").length - 1 }, "the theme CSS passes the styles extra's validation");
  const applied = scripting.calls.filter((c) => c.func === "pageApplyStyles");
  assert.deepEqual(plain(applied.at(-1).args), [S.cssFor(data.agentSiteStyles, "example.com"), "data-agent-styles"], "the tab got the saved cascade");
  assert.ok(applied.some((c) => c.args[1] === "data-agent-styles-preview" && c.args[0] === ""), "an earlier preview is cleared");
  assert.match(await runTool(T, "browser_style_list", { site: "example.com" }), /theme:dark — \d\.\d KB, on/, "it shows up like any override");

  // Another mode replaces the earlier theme; other overrides stay.
  await runTool(T, "browser_style_apply", { name: "wider", css: "main { max-width: 70ch }" });
  const sepia = await runTool(T, "browser_palette_theme", { mode: "sepia" });
  assert.match(sepia, /^Saved the sepia theme as override 'theme:sepia' for example\.com \(\d\.\d KB\), replacing theme:dark/);
  assert.deepEqual(Object.keys(data.agentSiteStyles["example.com"]).sort(), ["theme:sepia", "wider"]);

  // Preview: applied in its own element, nothing saved.
  scripting.calls.length = 0;
  const pv = await runTool(T, "browser_palette_theme", { mode: "dark", preview: true });
  assert.match(pv, /^Previewing the dark theme in the current tab \(not saved/);
  assert.deepEqual(scripting.calls.map((c) => [c.func, c.args[1]]), [["pageExtractPalette", undefined], ["pageApplyStyles", "data-agent-styles-preview"]]);
  assert.match(scripting.calls[1].args[0], /color-scheme: dark/);
  assert.deepEqual(Object.keys(data.agentSiteStyles["example.com"]).sort(), ["theme:sepia", "wider"]);

  // Off: the theme goes, the preview element is cleared, the other override stays.
  scripting.calls.length = 0;
  assert.equal(await runTool(T, "browser_palette_theme", { mode: "off" }), "Removed the theme of example.com (theme:sepia); the current tab is back to the site's own colours.");
  assert.deepEqual(Object.keys(data.agentSiteStyles["example.com"]), ["wider"]);
  assert.ok(scripting.calls.some((c) => c.func === "pageApplyStyles" && c.args[1] === "data-agent-styles-preview" && c.args[0] === ""));
  assert.equal(await runTool(T, "browser_palette_theme", { mode: "off" }), "No theme is saved for example.com.");
  // A custom name is honoured.
  await runTool(T, "browser_palette_theme", { mode: "custom", name: "night", overrides: { bg: "#000", text: "#fff" } });
  assert.ok(data.agentSiteStyles["example.com"].night);
});

test("browser_palette_extract and browser_palette_contrast: the reports, as=css / json, the selector scope", async () => {
  const { T, scripting } = load();
  scripting.results.pageExtractPalette = RAW;
  const report = await runTool(T, "browser_palette_extract", {});
  assert.match(report, /^Palette of example\.com/);
  assert.match(report, /\n\nAs CSS variables:\n:root \{\n  --c1: #222222;/);
  assert.deepEqual(scripting.calls.at(-1).args, [3000], "up to ~3000 elements sampled");
  assert.match(await runTool(T, "browser_palette_extract", { as: "css" }), /^:root \{\n  --c1: #222222;/);
  const json = JSON.parse(await runTool(T, "browser_palette_extract", { as: "json" }));
  assert.equal(json.text[0].hex, "#222222");
  assert.equal(json.themeColor, "#ff6600");

  scripting.results.pageContrast = CONTRAST;
  const c = await runTool(T, "browser_palette_contrast", {});
  assert.equal(c, [
    "Contrast on example.com (WCAG 2 AA; 4 text styles across 10 text elements): 1 fail, 3 pass (1 also AAA).",
    "",
    "Failures (needs 4.5:1 for normal text, 3:1 for large text — 24px, or 18.66px bold):",
    '  1. 2.85:1 (needs 4.5)  #999999 on #ffffff, 16px/400 — main > p.low  "Low-contrast fine print nobody can read."',
    "",
    "Fix: a browser_style_apply rule on the selector, e.g. `main > p.low { color: #737373; }`, then check again.",
  ].join("\n"));
  assert.doesNotMatch(c, /Readable paragraph/);
  assert.deepEqual(scripting.calls.at(-1).args, [3000, ""]);
  const aaa = await runTool(T, "browser_palette_contrast", { level: "AAA", selector: "main" });
  assert.match(aaa, /WCAG 2 AAA; 4 text styles.*: 3 fail, 1 pass/);
  assert.match(aaa, /over an image \(approximate\)/);
  assert.deepEqual(scripting.calls.at(-1).args, [3000, "main"]);
  scripting.results.pageContrast = { url: "https://www.example.com/", total: 3, checked: 2, styles: [CONTRAST.styles[1]] };
  assert.equal(await runTool(T, "browser_palette_contrast", {}), "Contrast on example.com (WCAG 2 AA; 1 text style across 2 text elements): every style passes AA (1 of 1 also pass AAA).");
  scripting.results.pageContrast = { error: '"$$" is not a valid CSS selector.' };
  await assert.rejects(T.run("browser_palette_contrast", { selector: "$$" }), /not a valid CSS selector/);
});

test("the 🧪 tab: Extract shows swatches from validated hex only, Copy puts the variables on the clipboard, Check contrast lists the failures, the theme buttons save and remove through the styles key", async () => {
  const { T, tabs, data, scripting, copied } = load();
  scripting.results.pageExtractPalette = RAW;
  scripting.results.pageContrast = CONTRAST;
  const dom = fakeDom();
  const ctx = fakeCtx(dom);
  const content = dom.node("div");
  const tab = tabs.find((t) => t.id === "palette");
  await tab.render(content, ctx);
  assert.match(content.allText, /Palette of example\.com/);
  for (const b of ["🎨 Extract", "🔍 Check contrast", "📋 Copy as CSS variables", "🌙 Dark", "📜 Sepia", "◐ High contrast", "✕ Off"]) assert.ok(content.button(b), b + " is there");
  assert.equal(content.button("📋 Copy as CSS variables").props.disabled, true, "nothing to copy before an extraction");

  content.button("🎨 Extract").click();
  await settle();
  const swatches = content.find((n) => n.props.className === "pal-swatch");
  assert.deepEqual(swatches.map((n) => /background:(#[0-9a-f]{6})$/.exec(n.props.style)[1]), ["#222222", "#999999", "#ffffff", "#ffffff", "#f4f4f4", "#ff6600", "#dddddd"]);
  assert.match(content.allText, /#222222  ×45/);
  assert.match(content.allText, /Georgia/);
  assert.match(content.allText, /Type scale: 14, 16, 32 px/);
  assert.match(content.allText, /Body #222222 on #ffffff · links #0066cc · buttons #ffffff on #ff6600 · theme-color #ff6600/);
  content.button("📋 Copy as CSS variables").click();
  await settle();
  assert.match(copied[0], /^:root \{\n  --c1: #222222;/);
  assert.deepEqual(ctx.statuses.at(-1), { text: "Copied the CSS variables.", kind: "good" });

  content.button("🔍 Check contrast").click();
  await settle();
  assert.match(content.allText, /Contrast \(WCAG 2 AA\): 1 failing style/);
  assert.match(content.allText, /2\.85:1 \(needs 4\.5\) · 16px\/400 · main > p\.low/);
  assert.match(content.allText, /3 pass \(1 also AAA\) · 1 over images \(approximate\) · 10 text elements checked\./);

  content.button("🌙 Dark").click();
  await settle();
  assert.ok(data.agentSiteStyles["example.com"]["theme:dark"], "saved through the styles key");
  assert.deepEqual(ctx.statuses.at(-1), { text: "Saved 'theme:dark' for example.com — it shows up in the 🎨 Styles tab too.", kind: "good" });
  assert.equal(ctx.rerenders, 1);
  await tab.render(content, ctx);
  assert.match(content.button("🌙 Dark").props.className, /primary/, "the active theme's button is highlighted");
  assert.match(content.allText, /Active: dark/);
  content.button("✕ Off").click();
  await settle();
  assert.equal(data.agentSiteStyles["example.com"], undefined);
  assert.deepEqual(ctx.statuses.at(-1), { text: "Theme removed.", kind: "good" });

  // A page that can't be read: the error lands in the status line, nothing throws.
  scripting.fail = "Cannot access a chrome:// URL";
  content.button("🎨 Extract").click();
  await settle();
  assert.match(ctx.statuses.at(-1).text, /^⚠ Cannot access a chrome:\/\/ URL/);
  assert.deepEqual(ctx.prompts, []);
});
