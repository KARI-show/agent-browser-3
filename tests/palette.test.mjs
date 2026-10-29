// Palette (browser/extras/palette.js) against fakes of chrome and the tool registry, with styles.js
// loaded first as extras.js does: colour normalisation, the WCAG contrast maths, the palette summary
// and its reports, the theme CSS and its mapping, browser_palette_theme saving through the styles
// extra's key (one theme per site, preview, off), the colour harmonies, and the 🧪 tab. The page-side walkers run for real
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

test("loads only with the feature; registers seven tools, the 🧪 tab and seven Design commands; without the styles extra its tools say so", async () => {
  const off = load({ features: { styles: true, palette: false } });
  assert.deepEqual(off.T.names.filter((n) => /palette/.test(n)), []);
  assert.deepEqual(off.tabs.map((t) => t.id), ["styles"]);
  assert.equal(off.P, undefined);

  const { T, tabs, commands, P } = load();
  assert.deepEqual(T.names.filter((n) => /palette/.test(n)), ["browser_palette_extract", "browser_palette_contrast", "browser_palette_theme", "browser_palette_harmony", "browser_palette_tokens", "browser_palette_recolor", "browser_palette_from_image"]);
  assert.deepEqual(plain(tabs.map((t) => [t.id, t.label, t.storageKeys])), [["styles", "🎨 Styles", ["agentSiteStyles"]], ["palette", "🧪 Palette", ["agentSiteStyles"]]]);
  // The styles extra's "Change a design token…" names browser_palette_tokens too (it comes first: styles.js loads first).
  assert.deepEqual(commands.filter((c) => /browser_palette_/.test(c.prompt)).map((c) => [c.group, c.name, !!c.partial]), [
    ["Design", "Change a design token…", true],
    ["Design", "What colours and fonts does this page use?", false], ["Design", "Check this page's contrast", false], ["Design", "Dark theme for this site", false], ["Design", "Colour harmonies from this site's accent", false],
    ["Design", "Design tokens of this page", false], ["Design", "Recolor this site…", true], ["Design", "Palette from this image", false],
  ]);
  assert.match(commands.find((c) => c.name === "Design tokens of this page").prompt, /browser_palette_tokens[^]*browser_style_tokens/);
  assert.match(commands.find((c) => c.name === "Recolor this site…").prompt, /browser_palette_recolor from=… to=…[^]*Replace: $/);
  assert.match(commands.find((c) => c.name === "Palette from this image").prompt, /browser_palette_from_image/);
  assert.match(commands.find((c) => c.name === "Colour harmonies from this site's accent").prompt, /browser_palette_harmony with no arguments/);
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

test("harmony: the wheel rotations (complementary 180° away, split ±150°, analogous ±30°, triadic, tetradic), tints toward white and shades toward black that keep the hue and are monotonic; the tool measures against the page's background and picks the page's accent", async () => {
  const { T, P, scripting } = load();
  const h = P.harmony("#e0457b");
  const hue = (hex) => P.rgbToHsl(P.parseColor(hex)).h;
  const apart = (a, b) => { const d = Math.abs(hue(a) - hue(b)) % 360; return Math.min(d, 360 - d); };
  assert.equal(h.base, "#e0457b");
  assert.deepEqual(plain(h.hsl), { h: 339, s: 71, l: 57.5 });
  assert.ok(Math.abs(apart(h.base, h.complementary) - 180) <= 1, "complementary " + h.complementary + " is 180° away");
  assert.ok(h.split.every((x) => Math.abs(apart(h.base, x) - 150) <= 1), "split-complementary ±150°: " + h.split);
  assert.ok(h.analogous.every((x) => Math.abs(apart(h.base, x) - 30) <= 1), "analogous ±30°: " + h.analogous);
  assert.ok(h.triadic.every((x) => Math.abs(apart(h.base, x) - 120) <= 1), "triadic: " + h.triadic);
  assert.ok([90, 180, 90].every((d, i) => Math.abs(apart(h.base, h.tetradic[i]) - d) <= 1), "tetradic: " + h.tetradic);
  assert.equal(h.tints.length, 5);
  assert.equal(h.shades.length, 5);
  for (let i = 0; i < 5; i++) {
    assert.ok(P.luminance(h.tints[i]) > P.luminance(i ? h.tints[i - 1] : h.base), "tint " + (i + 1) + " is lighter than the one before");
    assert.ok(P.luminance(h.shades[i]) < P.luminance(i ? h.shades[i - 1] : h.base), "shade " + (i + 1) + " is darker than the one before");
    assert.ok(apart(h.tints[i], h.base) <= 2 && apart(h.shades[i], h.base) <= 2, "the ramps keep the hue");
  }
  assert.ok(P.luminance(h.tints[4]) < 1 && P.luminance(h.shades[4]) > 0, "the ramps stop short of white and black");
  for (const x of [h.complementary].concat(h.split, h.analogous, h.triadic, h.tetradic, h.tints, h.shades)) assert.match(x, /^#[0-9a-f]{6}$/);
  assert.equal(P.harmony("rgb(224, 69, 123)").complementary, h.complementary, "any colour syntax");
  assert.throws(() => P.harmony("nope"), /'nope' is not a colour/);
  assert.equal(P.harmony("#808080").complementary, "#808080", "a grey has no hue");
  assert.equal(P.mix("#000000", "#ffffff", 0.5), "#808080");

  // The tool: a given colour and background.
  await assert.rejects(T.run("browser_palette_harmony", { color: "junk" }), /'junk' is not a colour/);
  await assert.rejects(T.run("browser_palette_harmony", { color: "#e0457b", background: "transparent" }), /'transparent' is not a colour/);
  const out = await runTool(T, "browser_palette_harmony", { color: "#e0457b", background: "#ffffff" });
  const lines = out.split("\n");
  assert.equal(lines[0], "Harmonies of #e0457b (hue 339°, 71% saturation, 58% lightness), contrast against #ffffff:");
  assert.equal(lines[1], "  base                 #e0457b " + P.contrastRatio("#e0457b", "#ffffff").toFixed(2) + ":1 ⚠ large only");
  assert.match(lines[2], /^  complementary        #[0-9a-f]{6} \d\.\d\d:1 (⚠|✓ AA)/);
  assert.match(lines[3], /^  split-complementary  #[0-9a-f]{6} \d\.\d\d:1 [^ ]+( large only)?   #[0-9a-f]{6} \d\.\d\d:1/);
  assert.match(lines[7], /^  tints → white        (#[0-9a-f]{6} \d\.\d\d:1 ⚠( large only)?   ){4}#[0-9a-f]{6} 1\.\d\d:1 ⚠$/, "no tint passes AA on white");
  assert.match(lines[8], /^  shades → black       #[0-9a-f]{6} \d\.\d\d:1 [^ ]+/);
  assert.match(lines[8], /✓ AA$/, "the darkest shade passes on white");
  assert.match(out, /\n✓ AA = 4\.5:1 or more, fine for text; ⚠ large only = 3:1 or more/);
  assert.match(out, /\n:root \{\n  --accent: #e0457b;\n  --accent-2: #[0-9a-f]{6}; \/\* complementary \*\/\n  --accent-3: #[0-9a-f]{6}; \/\* split-complementary \*\/\n  --accent-4: #[0-9a-f]{6};\n  --accent-analogous-1: #[0-9a-f]{6};\n  --accent-analogous-2: #[0-9a-f]{6};\n  --accent-triad-1: #[0-9a-f]{6};\n  --accent-triad-2: #[0-9a-f]{6};\n  --accent-tetrad-1: #[0-9a-f]{6};\n  --accent-tetrad-2: #[0-9a-f]{6};\n  --accent-tetrad-3: #[0-9a-f]{6};\n  --accent-tint-1: #[0-9a-f]{6};\n(  --accent-tint-\d: #[0-9a-f]{6};\n){4}(  --accent-shade-\d: #[0-9a-f]{6};\n){5}  --on-accent: #(ffffff|111111); \/\* text on the accent \*\/\n\}$/);
  assert.deepEqual(scripting.calls, [], "nothing read from the page when both colours are given");

  // Without arguments: the page's accent (its coloured button) against its body background.
  scripting.results.pageExtractPalette = RAW;
  const auto = await runTool(T, "browser_palette_harmony", {});
  assert.match(auto, /^Harmonies of #ff6600 \(hue 24°, 100% saturation, 50% lightness\) — the page's accent \(its button colour\), contrast against #ffffff:\n/);
  assert.match(auto, /\n  --accent-2: #0099ff; \/\* complementary \*\//);
  assert.deepEqual(plain(P.accentOf(P.summarizePalette(RAW))), { hex: "#ff6600", from: "its button colour" });
  assert.deepEqual(plain(P.accentOf(P.summarizePalette({ ...RAW, button: null }))), { hex: "#ff6600", from: "its theme-color" });
  assert.deepEqual(plain(P.accentOf(P.summarizePalette({ ...RAW, button: null, themeColor: "" }))), { hex: "#0066cc", from: "its link colour" });
  // A given colour against the page's background; a dark page.
  scripting.results.pageExtractPalette = { ...RAW, body: { bg: "rgb(18, 18, 18)", color: "rgb(230, 230, 230)" } };
  assert.match(await runTool(T, "browser_palette_harmony", { color: "#e0457b" }), /^Harmonies of #e0457b \([^)]*\), contrast against #121212:\n  base                 #e0457b \d\.\d\d:1 ✓ AA/);
  // A grey page has no accent; a page that can't be read asks for color, or measures against white.
  scripting.results.pageExtractPalette = { ...RAW, button: null, themeColor: "", link: "rgb(80, 80, 80)", bg: [{ v: "rgb(255, 255, 255)", n: 5, sels: [] }], text: [{ v: "rgb(0, 0, 0)", n: 5, sels: [] }], vars: [] };
  await assert.rejects(T.run("browser_palette_harmony", {}), /No accent stands out on this page \(no coloured buttons, theme-color or links\) — pass color/);
  scripting.fail = "Cannot access a chrome:// URL";
  await assert.rejects(T.run("browser_palette_harmony", {}), /Couldn't read the page's palette \(Cannot access a chrome:\/\/ URL\) — pass color/);
  assert.match(await runTool(T, "browser_palette_harmony", { color: "#e0457b" }), /contrast against #ffffff:[^]*\n\(the page could not be read: Cannot access a chrome:\/\/ URL; measured against white\)$/);
});

/** A raw token reading like pageTokens returns. */
const TOKENS = {
  url: "https://www.example.com/", sheets: 5, readable: 3, unreadable: 2, rules: 1204, totalUses: 310,
  tokens: [
    { name: "--brand", declared: "#ff6600", value: "#ff6600", selector: ":root", sheet: "site.css", root: true, decls: 1, uses: 41 },
    { name: "--ink", declared: "var(--gray-9)", value: "rgb(34, 34, 34)", selector: ":root", sheet: "site.css", root: true, decls: 2, uses: 30 },
    { name: "--gap", declared: "16px", value: "16px", selector: ":root, html", sheet: "inline <style>", root: true, decls: 1, uses: 12 },
    { name: "--font-body", declared: '"Inter", sans-serif', value: '"Inter", sans-serif', selector: ":root", sheet: "site.css", root: true, decls: 1, uses: 5 },
    { name: "--shadow", declared: "0 1px 2px rgba(0, 0, 0, 0.1)", value: "", selector: ".card", sheet: "site.css", root: false, decls: 1, uses: 3 },
    { name: "--ghost", declared: "", value: "", selector: "", sheet: "", root: false, decls: 0, uses: 2 },
    { name: "--unused", declared: "#123456", value: "#123456", selector: ":root", sheet: "site.css", root: true, decls: 1, uses: 0 },
  ],
};

test("tokenKind / groupTokens / rankTokens: colours, lengths, fonts and other by the look of the value (the name settles a bare family or weight), most used first", () => {
  const { P } = load();
  const kinds = [
    ["--brand", "#ff6600", "colour"], ["--ink", "rgb(34, 34, 34)", "colour"], ["--x", "hsl(10 50% 50%)", "colour"], ["--x", "oklch(70% 0.1 200)", "colour"], ["--x", "color-mix(in srgb, red, blue)", "colour"], ["--x", "transparent", "colour"], ["--x", "white", "colour"],
    ["--gap", "16px", "length"], ["--pad", "8px 16px", "length"], ["--w", "calc(100% - 2rem)", "length"], ["--h", "clamp(1rem, 2vw, 2rem)", "length"], ["--z", "0", "length"], ["--m", "-0.5em", "length"],
    ["--font-body", '"Inter", sans-serif', "font"], ["--font-heading", "Inter", "font"], ["--mono", "monospace", "font"], ["--weight-bold", "700", "font"], ["--style", "italic", "font"],
    ["--shadow", "0 1px 2px rgba(0,0,0,.1)", "other"], ["--z", "10", "other"], ["--ease", "cubic-bezier(.2,0,0,1)", "other"], ["--grad", "linear-gradient(red, blue)", "other"], ["--none", "", "other"], ["--d", "none", "other"],
  ];
  for (const [name, value, kind] of kinds) assert.equal(P.tokenKind(name, value), kind, name + ": " + value);
  const g = P.groupTokens([{ name: "--brand", value: "#ff6600" }, { name: "--gap", value: "16px" }, { name: "--font-body", value: "Inter, sans-serif" }, { name: "--shadow", value: "0 1px 2px #000" }, { name: "--ink", declared: "var(--gray-9)", value: "rgb(34, 34, 34)" }, { name: "--only-declared", declared: "#abc", value: "" }]);
  assert.deepEqual(plain(g.colour.map((t) => [t.name, t.kind, t.hex])), [["--brand", "colour", "#ff6600"], ["--ink", "colour", "#222222"], ["--only-declared", "colour", "#aabbcc"]]);
  assert.deepEqual(plain(g.length.map((t) => t.name)), ["--gap"]);
  assert.deepEqual(plain(g.font.map((t) => t.name)), ["--font-body"]);
  assert.deepEqual(plain(g.other.map((t) => t.name)), ["--shadow"]);
  assert.deepEqual(plain(P.groupTokens([])), { colour: [], length: [], font: [], other: [] });
  assert.deepEqual(plain(P.rankTokens(TOKENS.tokens).map((t) => t.name)), ["--brand", "--ink", "--gap", "--font-body", "--shadow", "--ghost", "--unused"]);
  assert.deepEqual(plain(P.rankTokens([{ name: "--b", uses: 1, decls: 1 }, { name: "--a", uses: 1, decls: 2 }, { name: "--c", uses: 1, decls: 2 }]).map((t) => t.name)), ["--a", "--c", "--b"], "ties: more declarations, then the name");
});

test("browser_palette_tokens: the report — counts and unreadable sheets, the four groups with resolved values, uses and where declared, the filter, how to change one; nothing found", async () => {
  const { T, P, scripting } = load();
  scripting.results.pageTokens = TOKENS;
  const out = await runTool(T, "browser_palette_tokens", {});
  assert.deepEqual(scripting.calls.at(-1).args, [400]);
  assert.equal(out, [
    "Design tokens of example.com: 7 custom properties in 3 readable stylesheets (1 204 rules, 310 var() uses); 2 cross-origin stylesheets could not be read (tokens declared or used there are not counted).",
    "",
    "Colours (3):",
    "  --brand: #ff6600  ×41 uses  (:root, site.css)",
    "  --ink: var(--gray-9) → rgb(34, 34, 34) (#222222)  ×30 uses  (:root, site.css, 2 declarations)",
    "  --unused: #123456  ×0 uses  (:root, site.css)",
    "",
    "Lengths (1):",
    "  --gap: 16px  ×12 uses  (:root, html, inline <style>)",
    "",
    "Fonts (1):",
    '  --font-body: "Inter", sans-serif  ×5 uses  (:root, site.css)',
    "",
    "Other (2):",
    "  --shadow: 0 1px 2px rgba(0, 0, 0, 0.1)  ×3 uses  (.card, site.css)",
    "  --ghost: (empty)  ×2 uses  (declared in a stylesheet that could not be read)",
    "",
    "Change one everywhere it is used: browser_style_tokens set={\"--brand\": \"#0a7\"} — saved as the site's 'Tokens' override, applied at once and kept on every visit. A token the site redeclares on a component keeps its own value there (a browser_style_apply rule for that selector fixes it).",
  ].join("\n"));
  // The filter; the cap on what is listed.
  const f = await runTool(T, "browser_palette_tokens", { filter: "FONT" });
  assert.match(f, /^Design tokens of example\.com: 7 custom properties[^\n]* Named like 'font': 1\.\n\nFonts \(1\):\n  --font-body/);
  assert.doesNotMatch(f, /--brand/);
  assert.equal(await runTool(T, "browser_palette_tokens", { filter: "nope" }), "None of the 7 custom properties of example.com is named like 'nope' — browser_palette_tokens without filter lists them.");
  const many = { ...TOKENS, tokens: Array.from({ length: 50 }, (_, i) => ({ name: "--t" + i, declared: i + "px", value: i + "px", selector: ":root", sheet: "a.css", root: true, decls: 1, uses: 50 - i })) };
  const capped = P.formatTokens(many);
  assert.match(capped, /50 custom properties in 3 readable stylesheets [^\n]* The 40 most used:\n\nLengths \(40\):\n  --t0: 0px  ×50 uses/);
  assert.doesNotMatch(capped, /--t45/);
  // A page without tokens.
  scripting.results.pageTokens = { url: "https://x.example/", sheets: 2, readable: 1, unreadable: 1, rules: 40, totalUses: 0, tokens: [] };
  assert.equal(await runTool(T, "browser_palette_tokens", {}), "No CSS custom properties found in the 1 readable stylesheet of x.example (1 cross-origin stylesheet could not be read (tokens declared or used there are not counted)). The site styles its elements directly: browser_palette_extract shows its colours and fonts, browser_style_apply changes them.");
});

test("colorDistance / recolorCss / browser_palette_recolor: the 0–100 sRGB distance, one !important rule per property over de-duplicated selectors, the override 'Recolor <from>→<to>' saved and applied; arguments checked; nothing saved when nothing matches", async () => {
  const { T, P, data, scripting, S } = load();
  assert.equal(P.colorDistance("#000000", "#ffffff"), 100);
  assert.equal(P.colorDistance("#ffffff", "#000000"), 100);
  assert.equal(P.colorDistance("#ff0000", "#00ff00"), 81.65);
  assert.equal(P.colorDistance("#0066cc", "rgb(0, 102, 204)"), 0);
  assert.equal(P.colorDistance("#0066cc", "#0070d0"), 2.44);
  assert.ok(P.colorDistance("#ff6600", "#ff8800") < 12 && P.colorDistance("#ff6600", "#ffaa00") > 12, "the default tolerance takes a near shade, not a far one");
  assert.throws(() => P.colorDistance("junk", "#fff"), /'junk' is not a colour/);
  assert.equal(P.recolorCss([{ selector: "a", props: ["color"] }, { selector: "a.btn", props: ["color", "background"] }, { selector: "a", props: ["color"] }, { selector: "div.card", props: ["border"] }, { selector: "", props: ["color"] }], "rgb(224, 69, 123)"), [
    "a, a.btn { color: #e0457b !important; }",
    "a.btn { background-color: #e0457b !important; }",
    "div.card { border-color: #e0457b !important; }",
  ].join("\n"));
  assert.equal(P.recolorCss([], "#fff"), "");
  assert.throws(() => P.recolorCss([{ selector: "a", props: ["color"] }], "nope"), /'nope' is not a colour/);
  assert.deepEqual(plain(P.recolorProps()), ["color", "background", "border"]);
  assert.deepEqual(plain(P.recolorProps(["background-color", "Border", "bg"])), ["background", "border"]);
  assert.throws(() => P.recolorProps(["fill"]), /properties: 'fill' is not one of color, background, border/);
  assert.throws(() => P.recolorProps([]), /properties must be a list/);
  assert.equal(P.recolorName("#0066cc", "#e0457b"), "Recolor #0066cc→#e0457b");

  await assert.rejects(T.run("browser_palette_recolor", { to: "#fff" }), /from is required/);
  await assert.rejects(T.run("browser_palette_recolor", { from: "junk", to: "#fff" }), /from is required[^\n]*'junk' is not one/);
  await assert.rejects(T.run("browser_palette_recolor", { from: "#0066cc" }), /to is required/);
  await assert.rejects(T.run("browser_palette_recolor", { from: "#0066cc", to: "transparent" }), /to is required/);
  await assert.rejects(T.run("browser_palette_recolor", { from: "#0066cc", to: "#fff", tolerance: 41 }), /tolerance must be a number from 0/);
  await assert.rejects(T.run("browser_palette_recolor", { from: "#0066cc", to: "#fff", properties: ["fill"] }), /properties: 'fill'/);
  assert.deepEqual(scripting.calls, [], "arguments are checked before the page is read");
  scripting.results.pageRecolor = {
    url: "https://www.example.com/", total: 400, scanned: 300, elements: 37, unselectable: 3, shades: { "#0066cc": 30, "#0070d0": 7 },
    selectors: [{ selector: "a", props: ["color"], n: 20 }, { selector: "button.btn-primary", props: ["background", "border"], n: 10 }, { selector: "div.badge", props: ["color", "background"], n: 4 }], truncated: 0, closest: { hex: "#0066cc", distance: 0 },
  };
  const out = await runTool(T, "browser_palette_recolor", { from: "rgb(0, 102, 204)", to: "#E0457B" });
  assert.deepEqual(plain(scripting.calls[0]), { func: "pageRecolor", args: [3000, { r: 0, g: 102, b: 204 }, 12, ["color", "background", "border"], 60], world: "ISOLATED", target: { tabId: 7 } });
  assert.equal(out.split("\n")[0], "Saved override 'Recolor #0066cc→#e0457b' for example.com (0.3 KB, 3 rules): 37 elements within 12 of #0066cc (2 shades: #0066cc ×30, #0070d0 ×7) in 3 selectors — color on 2, background on 2, border on 1 → #e0457b. 3 elements have no stable selector and are not covered. Applied in the current tab; the site keeps it until browser_style_remove name=\"Recolor #0066cc→#e0457b\".");
  assert.equal(out.split("\n")[1], "Selectors: a (color, ×20), button.btn-primary (background+border, ×10), div.badge (color+background, ×4).");
  assert.match(out, /\nCheck with browser_screenshot — a missed spot gets a browser_style_apply rule[^\n]*browser_style_tokens is the cleaner change/);
  const saved = data.agentSiteStyles["example.com"]["Recolor #0066cc→#e0457b"];
  assert.ok(saved && saved.enabled === true, "saved through the styles key");
  assert.match(saved.css, /^\/\* Recolor #0066cc → #e0457b \(tolerance 12; color, background, border\): 37 elements, 3 selectors, \d{4}-\d\d-\d\d \*\/\na, div\.badge \{ color: #e0457b !important; \}\nbutton\.btn-primary, div\.badge \{ background-color: #e0457b !important; \}\nbutton\.btn-primary \{ border-color: #e0457b !important; \}$/);
  assert.deepEqual(plain(S.validateCss(saved.css)), { ok: true, rules: 3 });
  assert.equal(scripting.calls.at(-1).func, "pageApplyStyles");
  assert.equal(scripting.calls.at(-1).args[0], S.cssFor(data.agentSiteStyles, "example.com"));
  // Options: tolerance, properties and site reach the page / the store; the same from→to replaces.
  await runTool(T, "browser_palette_recolor", { from: "#0066cc", to: "#e0457b", tolerance: 0, properties: ["background"], site: "www.Other.com" });
  assert.deepEqual(plain(scripting.calls.at(-2).args), [3000, { r: 0, g: 102, b: 204 }, 0, ["background"], 60]);
  assert.ok(data.agentSiteStyles["other.com"]["Recolor #0066cc→#e0457b"]);
  assert.match(await runTool(T, "browser_palette_recolor", { from: "#0066cc", to: "#e0457b" }), /^Replaced override 'Recolor #0066cc→#e0457b' for example\.com/);
  assert.equal(Object.keys(data.agentSiteStyles["example.com"]).length, 1);
  // Nothing matched: an error naming the closest colour, nothing saved.
  scripting.results.pageRecolor = { url: "https://www.example.com/", total: 400, scanned: 300, elements: 0, unselectable: 0, shades: {}, selectors: [], truncated: 0, closest: { hex: "#0a5fc0", distance: 14.2 } };
  await assert.rejects(T.run("browser_palette_recolor", { from: "#0066cc", to: "#fff", properties: ["color"] }), /No visible element of example\.com uses a colour within 12 of #0066cc for color \(the closest is #0a5fc0, at 14\.2\) — raise tolerance \(up to 40\)[^\n]*Nothing was saved\./);
  assert.equal(data.agentSiteStyles["example.com"]["Recolor #0066cc→#ffffff"], undefined);
  scripting.results.pageRecolor = { url: "https://www.example.com/", total: 400, scanned: 300, elements: 2, unselectable: 2, shades: { "#0066cc": 2 }, selectors: [], truncated: 0, closest: { hex: "#0066cc", distance: 0 } };
  await assert.rejects(T.run("browser_palette_recolor", { from: "#0066cc", to: "#fff" }), /; 2 matched but had no stable selector — raise tolerance/);
  // palette.js alone: the override needs the styles extra.
  const lone = loadExtras({ ids: ["palette"], features: { palette: true } });
  await assert.rejects(lone.T.run("browser_palette_recolor", { from: "#0066cc", to: "#fff" }), /The styles extra is not in this build/);
});

test("quantize / browser_palette_from_image: median cut on a fixed pixel array (exact colours, shares, most first, fewer when the image has fewer), the report with contrast and a :root block, by ref through the ref's frame / by selector / the largest image; a tainted canvas and page errors are explained", async () => {
  const { T, P, scripting } = load();
  const px = [];
  for (let i = 0; i < 60; i++) px.push(255, 0, 0);
  for (let i = 0; i < 30; i++) px.push(0, 0, 255);
  for (let i = 0; i < 10; i++) px.push(255, 255, 255);
  assert.deepEqual(plain(P.quantize(px, 3)), [{ hex: "#ff0000", share: 0.6, n: 60 }, { hex: "#0000ff", share: 0.3, n: 30 }, { hex: "#ffffff", share: 0.1, n: 10 }]);
  assert.deepEqual(plain(P.quantize(px, 8)).map((c) => c.hex), ["#ff0000", "#0000ff", "#ffffff"], "no more colours than the image has");
  assert.deepEqual(plain(P.quantize(px, 2)).map((c) => [c.hex, c.n]), [["#ff2424", 70], ["#0000ff", 30]], "two boxes (the cut closest to half the weight): blue, and red with the white folded in");
  assert.deepEqual(plain(P.quantize(px, 1)), [{ hex: "#b31a66", share: 1, n: 100 }], "one box: the weighted mean");
  assert.deepEqual(plain(P.quantize([[10, 20, 30], [10, 20, 30], [12, 22, 32]], 2)), [{ hex: "#0a141e", share: 0.6667, n: 2 }, { hex: "#0c1620", share: 0.3333, n: 1 }], "triples work too; a bucket keeps exact sums");
  assert.deepEqual(plain(P.quantize([10, 20, 30, 11, 21, 31], 2)), [{ hex: "#0b151f", share: 1, n: 2 }], "two pixels in one 5-bit bucket cannot split (their mean, rounded)");
  assert.deepEqual(plain(P.quantize([], 3)), []);
  assert.deepEqual(plain(P.quantize([1, 2], 3)), [], "a short array holds no pixel");
  // A gradient: the top colour of each end of a 4-step quantisation is dark / light and shares sum to 1.
  const grad = []; for (let v = 0; v < 256; v++) grad.push(v, v, v);
  const q = P.quantize(grad, 4);
  assert.equal(q.length, 4);
  assert.ok(Math.abs(q.reduce((s, c) => s + c.share, 0) - 1) < 0.001);
  assert.ok(q.some((c) => P.luminance(c.hex) < 0.05) && q.some((c) => P.luminance(c.hex) > 0.7));

  await assert.rejects(T.run("browser_palette_from_image", { count: 1 }), /count must be a whole number from 2 to 8/);
  await assert.rejects(T.run("browser_palette_from_image", { count: 2.5 }), /count must be a whole number/);
  await assert.rejects(T.run("browser_palette_from_image", { ref: 3 }), /No element \[3\] — call browser_read_page first/);
  assert.deepEqual(scripting.calls, []);
  const IMG = { tag: "img", kind: "img", src: "https://www.example.com/img/hero.jpg", alt: "A harbour at dusk", shown: { width: 600, height: 400 }, how: "largest", crossOrigin: false, pageBg: "rgb(255, 255, 255)", pixels: px, natural: { width: 1200, height: 800 }, sampled: { width: 64, height: 43 }, transparent: 4 };
  scripting.results.pageImagePixels = IMG;
  const out = await runTool(T, "browser_palette_from_image", {});
  assert.deepEqual(plain(scripting.calls.at(-1)), { func: "pageImagePixels", args: [0, "", 64, 3000], world: "ISOLATED", target: { tabId: 7 } });
  assert.equal(out, [
    'Dominant colours of the <img> hero.jpg (alt "A harbour at dusk", 1200×800, shown at 600×400) — the largest visible image: 100 pixels sampled (4 transparent skipped), 3 colours, contrast against the page background #ffffff:',
    "  1. #ff0000  60%  4.00:1 ⚠ large only  (hue 0°, 100% sat, 50% light)",
    "  2. #0000ff  30%  8.59:1 ✓ AA  (hue 240°, 100% sat, 50% light)",
    "  3. #ffffff  10%  1.00:1 ⚠  (hue 0°, 0% sat, 100% light)",
    "",
    ":root {",
    "  --image-1: #ff0000; /* 60% */",
    "  --image-2: #0000ff; /* 30% */",
    "  --image-3: #ffffff; /* 10% */",
    "}",
    "",
    "✓ AA = 4.5:1 or more, fine for text on the page background; ⚠ large only = 3:1 or more (large text, icons, borders); ⚠ = decorative use only. Use a colour with browser_style_tokens (set={\"--brand\": \"#ff0000\"}), browser_palette_theme mode=custom (overrides={ accent: \"…\" }) or a browser_style_apply rule; browser_palette_harmony color=#ff0000 gives its harmonies.",
  ].join("\n"));
  // count caps the colours; the page background changes the ratios; a selector goes to the top frame; a ref to its frame.
  assert.match(await runTool(T, "browser_palette_from_image", { count: 2, selector: ".hero img" }), /, 2 colours, contrast against the page background #ffffff:\n  1\. #ff2424  70%[^\n]*\n  2\. #0000ff  30%/);
  assert.deepEqual(scripting.calls.at(-1).args, [0, ".hero img", 64, 3000]);
  scripting.results.pageImagePixels = { ...IMG, how: "ref", kind: "background", tag: "div", alt: "", pageBg: "rgb(18, 18, 18)" };
  T.refs[3] = { documentId: "doc-1", local: 2, loc: { kind: "image", text: "" } };
  const byRef = await runTool(T, "browser_palette_from_image", { ref: 3, count: 3 });
  assert.deepEqual(plain(scripting.calls.at(-1).target), { tabId: 7, documentIds: ["doc-1"] }, "runs in the frame that owns the ref");
  assert.deepEqual(scripting.calls.at(-1).args, [2, "", 64, 3000]);
  assert.match(byRef, /^Dominant colours of the background image of <div> hero\.jpg \(1200×800, shown at 600×400\): 100 pixels sampled[^\n]*contrast against the page background #121212:\n  1\. #ff0000  60%  4\.69:1 ✓ AA/, "the ratios follow the page background");
  assert.match(byRef, /\n  2\. #0000ff  30%  2\.18:1 ⚠  /);
  assert.match(byRef, /\n  3\. #ffffff  10%  18\.\d\d:1 ✓ AA/);
  // Unreadable: another origin without CORS → the canvas is tainted; the advice is to describe it.
  scripting.results.pageImagePixels = { tag: "img", kind: "img", src: "https://cdn.example.net/hero.jpg", alt: "", shown: { width: 600, height: 400 }, how: "largest", crossOrigin: true, pageBg: "rgb(255, 255, 255)", unreadable: true, reason: "tainted", loadError: "" };
  assert.equal(await runTool(T, "browser_palette_from_image", {}), "The colours of the <img> hero.jpg (shown at 600×400) — the largest visible image cannot be read: it comes from another origin (cdn.example.net) that does not allow cross-origin reads, so the browser taints the canvas and the pixels cannot be read in the page. Describe it instead: open https://cdn.example.net/hero.jpg in a tab (browser_navigate) and look at it with browser_screenshot, or pass the URL to the agent for a description. browser_palette_extract still gives the page's own colours.");
  scripting.results.pageImagePixels = { tag: "img", kind: "img", src: "https://www.example.com/x.svg", alt: "", shown: { width: 10, height: 10 }, how: "selector", crossOrigin: false, pageBg: "rgb(255, 255, 255)", unreadable: true, reason: "load", loadError: "the image has no size yet (not loaded)" };
  assert.match(await runTool(T, "browser_palette_from_image", { selector: "img" }), /cannot be read: it could not be drawn — the image has no size yet \(not loaded\)\. Describe it instead/);
  // Page-side errors come through; a stale ref is explained.
  scripting.results.pageImagePixels = { error: "No visible image on this page (no loaded <img> and no element with a background-image) — pass a ref or a selector." };
  await assert.rejects(T.run("browser_palette_from_image", {}), /No visible image on this page/);
  scripting.results.pageImagePixels = { error: "stale" };
  await assert.rejects(T.run("browser_palette_from_image", { ref: 3 }), /That element is gone — the page changed\. Call browser_read_page again\./);
  assert.equal(P.imageWords({ tag: "img", kind: "img", src: "data:image/png;base64,AAAA", how: "selector" }), "the <img> a data: URL");
});
