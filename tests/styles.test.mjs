// Site styles (browser/extras/styles.js and its content script browser/extras/styles.cs.js) against fakes
// of chrome.storage / tabs / scripting and the tool registry: the pure helpers (hosts, the cascade,
// CSS validation), browser_style_apply / list / remove / inspect, the presets, the fonts override, the
// UserCSS export and import, the 🎨 tab, the content-script registration — and the content script itself against a fake document: what it injects for a host
// and for "*", what it ignores, how it follows storage changes and keeps its element last in <head>.
// The page-side functions run for real in tests/e2e/extras-palette.e2e.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeCtx, fakeDom, loadContentScript, loadExtras, plain, runTool, settle, styleEl } from "./mocks/extras-palette.mjs";

// Values made inside the vm have another realm's prototypes: deepEqual needs plain copies.

const load = (opts) => loadExtras({ ids: ["styles"], features: { styles: true }, ...(opts || {}) });
const stored = (data) => data.agentSiteStyles || {};

test("loads only for a brand with the feature; registers ten tools, the 🎨 tab, nine Design commands and the content script once", async () => {
  const off = load({ features: { styles: false, palette: true } });
  assert.deepEqual(off.T.names, []);
  assert.deepEqual(off.tabs, []);
  assert.equal(off.S, undefined);

  const { T, tabs, commands, S, scripting } = load();
  assert.deepEqual(T.names, ["browser_style_inspect", "browser_style_apply", "browser_style_list", "browser_style_remove", "browser_style_preset", "browser_style_font", "browser_style_export", "browser_style_import", "browser_style_toggle", "browser_style_tokens"]);
  assert.equal(tabs[0].label, "🎨 Styles");
  assert.deepEqual(plain(tabs[0].storageKeys), ["agentSiteStyles"]);
  assert.deepEqual(commands.map((c) => [c.group, c.name, !!c.partial]), [
    ["Design", "Make this page easier to read", false], ["Design", "Hide the distractions on this page", false], ["Design", "Show this site's style overrides", false],
    ["Design", "Reading mode for this site", false], ["Design", "Dyslexia-friendly text", false], ["Design", "Change the site's fonts", true], ["Design", "Export my styles for Stylus", false],
    ["Design", "Pause this site's styles", false], ["Design", "Change a design token…", true],
  ]);
  for (const c of commands.slice(0, 2)) { assert.match(c.prompt, /browser_style_inspect/); assert.match(c.prompt, /browser_style_apply/); assert.match(c.prompt, /consent/i); }
  assert.match(commands[2].prompt, /browser_style_list/);
  assert.match(commands[3].prompt, /browser_style_preset preset=reading/);
  assert.match(commands[4].prompt, /browser_style_preset preset=dyslexia/);
  assert.match(commands[5].prompt, /browser_style_font.*to: $/);
  assert.match(commands[6].prompt, /browser_style_export with save=true/);
  assert.match(commands[7].prompt, /browser_style_toggle name="\*" enabled=false/);
  assert.match(commands[8].prompt, /browser_style_tokens set=.*: $/);
  assert.equal(await S.ready, true);
  assert.deepEqual(scripting.registered, [{ id: "extras-styles", js: ["extras-styles.cs.js"], matches: ["http://*/*", "https://*/*"], runAt: "document_start", persistAcrossSessions: true }]);
  // A second panel load finds it registered and does not register twice.
  assert.equal(await S.ensureContentScript(), true);
  assert.equal(scripting.registered.length, 1);
});

test("hosts and the cascade: www. and case are dropped, '*' applies everywhere and comes first, paused and empty overrides are skipped", () => {
  const { S } = load();
  assert.equal(S.normHost(" WWW.Example.COM. "), "example.com");
  assert.equal(S.normHost("*"), "*");
  assert.equal(S.hostOf("https://www.example.com/a?b"), "example.com");
  assert.equal(S.hostOf("chrome://extensions"), "");
  assert.equal(S.hostOf("not a url"), "");
  assert.deepEqual(plain(S.sitesFor("www.example.com")), ["*", "example.com"]);
  assert.deepEqual(plain(S.sitesFor("*")), ["*"]);
  const all = {
    "example.com": { b: { css: "h2 { color: blue }", enabled: true, t: 1 }, a: { css: "h1 { color: red }", enabled: true, t: 1 }, paused: { css: "h3 { color: gray }", enabled: false, t: 1 }, empty: { css: "   ", enabled: true, t: 1 } },
    "*": { big: { css: "body { font-size: 18px }", enabled: true, t: 1 } },
    "other.com": { z: { css: "p { color: green }", enabled: true, t: 1 } },
  };
  assert.equal(S.cssFor(all, "WWW.example.com"), "/* every site · big */\nbody { font-size: 18px }\n\n/* example.com · a */\nh1 { color: red }\n\n/* example.com · b */\nh2 { color: blue }");
  assert.equal(S.cssFor(all, "nothing.example"), "/* every site · big */\nbody { font-size: 18px }");
  assert.deepEqual(plain(S.applicable(all, "example.com").map((o) => [o.site, o.name, o.enabled])), [["*", "big", true], ["example.com", "a", true], ["example.com", "b", true], ["example.com", "empty", true], ["example.com", "paused", false]]);
  // Keys saved with www. are still found.
  assert.equal(S.cssFor({ "www.example.com": { a: { css: "h1{}", enabled: true } } }, "example.com"), "/* example.com · a */\nh1{}");
  assert.equal(S.nameKey({ "Wider Article": {} }, "wider article"), "Wider Article");
  assert.equal(S.nameKey({ "Wider Article": {} }, "nope"), null);
});

test("validateCss: structure without a parser — balanced braces, no stray text, declarations shaped property: value, @import refused", () => {
  const { S } = load();
  assert.deepEqual(plain(S.validateCss("h1 { color: red }")), { ok: true, rules: 1 });
  assert.deepEqual(plain(S.validateCss("h1 { color: red } /* c */ p, li { margin: 0; padding: 4px }")), { ok: true, rules: 2 });
  assert.deepEqual(plain(S.validateCss("@media (max-width: 600px) { h1 { color: red } }")), { ok: true, rules: 1 });
  assert.deepEqual(plain(S.validateCss("a::after { content: '}'; }")), { ok: true, rules: 1 }, "a brace inside a string is text");
  assert.match(S.validateCss("h1 { color: red ").error, /Missing '}' — 1 block is not closed/);
  assert.match(S.validateCss("h1 { color: red } }").error, /Unexpected '}'/);
  assert.match(S.validateCss("color: red").error, /Text outside a rule: "color: red"/);
  assert.match(S.validateCss("").error, /empty/);
  assert.match(S.validateCss("/* only a comment */").error, /No rules found/);
  assert.match(S.validateCss("@import url(evil.css); h1 { color: red }").error, /@import is not allowed/);
  assert.match(S.validateCss("h1 { color }").error, /rule 1 \(h1\): 'color' is not a 'property: value' declaration/);
  assert.deepEqual(plain(S.splitDecls("background: url(data:x;base64,abc); color: red")), ["background: url(data:x;base64,abc)", "color: red"]);
});

test("validateCss with the browser's parser (a fake CSSStyleSheet): refused rules carry the parser's message, dropped declarations are named", () => {
  class FakeSheet {
    constructor() { this.cssRules = []; }
    insertRule(rule, i) {
      if (/^\s*\{/.test(rule)) throw new Error("Failed to execute 'insertRule' on 'CSSStyleSheet': Failed to parse the rule '" + rule + "'.");
      const body = rule.slice(rule.indexOf("{") + 1, rule.lastIndexOf("}"));
      const style = { props: {}, getPropertyValue(p) { return this.props[p] || ""; } };
      for (const d of body.split(";")) { const m = /^\s*([-\w]+)\s*:\s*(\S[^]*)$/.exec(d); if (m && !/^colour$/.test(m[1]) && m[2].trim() !== "blurple") style.props[m[1]] = m[2].trim(); }
      style.length = Object.keys(style.props).length;
      this.cssRules.splice(i, 0, { style });
    }
  }
  const { S } = load({ globals: { CSSStyleSheet: FakeSheet } });
  assert.deepEqual(plain(S.validateCss("h1 { color: red; --x: anything }")), { ok: true, rules: 1 });
  assert.equal(S.validateCss("{ color: red }").error, "rule 1 ({ color: red }): Failed to parse the rule '{ color: red }'");
  assert.equal(S.validateCss("h1 { colour: red }").error, "rule 1 (h1): 'colour: red' was dropped by the parser — unknown property or invalid value");
  assert.equal(S.validateCss("h1 { color: blurple; margin: 0 }").error, "rule 1 (h1): 'color: blurple' was dropped by the parser — unknown property or invalid value");
});

test("browser_style_apply: validates, saves under host + name, applies the cascade in the tab; the same name replaces; site '*'", async () => {
  const { T, data, scripting } = load();
  await assert.rejects(T.run("browser_style_apply", { css: "h1 { color: red }" }), /name is required/);
  await assert.rejects(T.run("browser_style_apply", { name: "x" }), /css is required/);
  await assert.rejects(T.run("browser_style_apply", { name: "x", css: "h1 { color: red" }), /The CSS was refused: Missing '}'.*Nothing was saved/);
  assert.deepEqual(stored(data), {}, "nothing saved on bad input");
  assert.equal(scripting.calls.length, 0, "nothing injected on bad input");

  const out = await runTool(T, "browser_style_apply", { name: "  Heading   colour ", css: "h1 { color: rgb(1, 2, 3) }\r\n" });
  assert.match(out, /^Saved override 'Heading colour' for example\.com \(26 B, 1 rule\)\. Applied in the current tab; the site keeps it on every visit until it is removed/);
  assert.match(out, /example\.com now has 1 override; 1 override saved in all, \d+ B of 200 KB used/);
  const o = stored(data)["example.com"]["Heading colour"];
  assert.equal(o.css, "h1 { color: rgb(1, 2, 3) }");
  assert.equal(o.enabled, true);
  assert.ok(Date.now() - o.t < 5000);
  assert.deepEqual(scripting.calls.map((c) => [c.func, c.args[1], c.world]), [["pageApplyStyles", "data-agent-styles", "ISOLATED"]]);
  assert.equal(scripting.calls[0].args[0], "/* example.com · Heading colour */\nh1 { color: rgb(1, 2, 3) }");

  // The same name (any case) replaces; a paused override stays paused.
  stored(data)["example.com"]["Heading colour"].enabled = false;
  const again = await runTool(T, "browser_style_apply", { name: "heading colour", css: "h1 { color: red }" });
  assert.match(again, /^Replaced override 'heading colour'/);
  assert.deepEqual(Object.keys(stored(data)["example.com"]), ["heading colour"]);
  assert.equal(stored(data)["example.com"]["heading colour"].enabled, false);

  // '*' goes to every site and the cascade puts it first.
  await runTool(T, "browser_style_apply", { name: "big text", css: "body { font-size: 18px }", site: "*" });
  assert.equal(stored(data)["*"]["big text"].css, "body { font-size: 18px }");
  assert.equal(scripting.calls.at(-1).args[0], "/* every site · big text */\nbody { font-size: 18px }", "the paused override is left out of the injected text");
  // Another site: saved, not applied here.
  const other = await runTool(T, "browser_style_apply", { name: "wide", css: "main { max-width: 90ch }", site: "www.Other.com" });
  assert.match(other, /Saved override 'wide' for other\.com .*Saved; it applies on other\.com \(the current tab is example\.com\)/);
  assert.ok(stored(data)["other.com"].wide);
  await assert.rejects(T.run("browser_style_apply", { name: "x", css: "h1{color:red}", site: "not a host" }), /is not a host/);
});

test("browser_style_apply: the per-override and total caps give clear errors and save nothing", async () => {
  const { T, data, S } = load();
  await assert.rejects(T.run("browser_style_apply", { name: "huge", css: "h1 { content: '" + "x".repeat(S.MAX_CSS) + "' }" }), new RegExp("too long \\(" + (S.MAX_CSS + 18) + " characters; the limit per override is " + S.MAX_CSS + "\\)"));
  const chunk = "p { content: '" + "y".repeat(15000) + "' }";
  for (let i = 0; i < 13; i++) await runTool(T, "browser_style_apply", { name: "chunk " + i, css: chunk });
  await assert.rejects(T.run("browser_style_apply", { name: "one more", css: chunk }), /Site styles are full \(2\d\d KB of 200 KB with this override\) — remove or shorten an override with browser_style_remove first\. Nothing was saved/);
  assert.equal(Object.keys(stored(data)["example.com"]).length, 13);
});

test("browser_style_list: empty, all sites with sizes / state / first line, one site, with the full CSS", async () => {
  const { T, data } = load();
  assert.equal(await runTool(T, "browser_style_list", {}), "No style overrides saved yet. browser_style_apply adds one for the current site (the site keeps it until it is removed).");
  data.agentSiteStyles = {
    "example.com": { "wider article": { css: "main article {\n  max-width: 70ch;\n}", enabled: true, t: Date.now() - 7200000 }, "hide sidebar": { css: "aside { display: none }", enabled: false, t: Date.now() - 90000000 } },
    "*": { "big text": { css: "body { font-size: 18px }", enabled: true, t: Date.now() - 30000 } },
  };
  const all = await runTool(T, "browser_style_list", {});
  assert.equal(all, [
    "Style overrides: 3 on 2 sites (" + JSON.stringify(data.agentSiteStyles).length + " B of 200 KB).",
    "Every site (1):", "  - big text — 24 B, on, saved just now", "      body { font-size: 18px }",
    "example.com (2):", "  - hide sidebar — 23 B, paused, saved 1 d ago", "      aside { display: none }",
    "  - wider article — 35 B, on, saved 2 h ago", "      main article { …",
  ].join("\n"));
  assert.match(await runTool(T, "browser_style_list", { site: "www.example.com" }), /^example\.com \(2\):\n  - hide sidebar/);
  assert.match(await runTool(T, "browser_style_list", { site: "example.com", css: true }), /      main article \{\n        max-width: 70ch;\n      \}/);
  assert.equal(await runTool(T, "browser_style_list", { site: "nothing.example" }), "No style overrides for nothing.example. 3 saved on other sites — browser_style_list without site shows them.");
});

test("browser_style_remove: by name, pause/resume with enabled, all of a site; unknown names list what exists; the tab is updated each time", async () => {
  const { T, data, scripting } = load();
  await runTool(T, "browser_style_apply", { name: "A", css: "h1 { color: red }" });
  await runTool(T, "browser_style_apply", { name: "B", css: "h2 { color: blue }" });
  await runTool(T, "browser_style_apply", { name: "G", css: "body { margin: 0 }", site: "*" });
  scripting.calls.length = 0;

  assert.equal(await runTool(T, "browser_style_remove", { name: "a", enabled: false }), "Paused override 'A' on example.com (it stays saved; enabled=false undoes this). The current tab is updated.");
  assert.equal(stored(data)["example.com"].A.enabled, false);
  assert.equal(scripting.calls.at(-1).args[0], "/* every site · G */\nbody { margin: 0 }\n\n/* example.com · B */\nh2 { color: blue }");
  assert.match(await runTool(T, "browser_style_remove", { name: "A", enabled: true }), /^Resumed override 'A'/);
  assert.equal(stored(data)["example.com"].A.enabled, true);
  await assert.rejects(T.run("browser_style_remove", { enabled: false }), /name is required with enabled/);

  assert.equal(await runTool(T, "browser_style_remove", { name: "B" }), "Removed override 'B' from example.com (1 left there). The current tab is updated.");
  assert.deepEqual(Object.keys(stored(data)["example.com"]), ["A"]);
  await assert.rejects(T.run("browser_style_remove", { name: "nope" }), /No override named 'nope' on example\.com\. Its overrides: A\./);
  await assert.rejects(T.run("browser_style_remove", {}), /name is required \(or all=true/);

  assert.equal(await runTool(T, "browser_style_remove", { all: true }), "Removed 1 override of example.com: A. The current tab is updated.");
  assert.equal(stored(data)["example.com"], undefined, "an empty site is dropped from the store");
  assert.equal(await runTool(T, "browser_style_remove", { all: true }), "No overrides saved for example.com — nothing to remove.");
  assert.equal(scripting.calls.at(-1).args[0], "/* every site · G */\nbody { margin: 0 }");
  assert.equal(await runTool(T, "browser_style_remove", { name: "G", site: "*" }), "Removed override 'G' from every site (none left there). The current tab is updated.");
  assert.deepEqual(stored(data), {});
  assert.deepEqual(scripting.calls.at(-1).args, ["", "data-agent-styles"], "nothing left → the element is removed from the page");
});

test("browser_style_inspect: by ref through the ref's frame, by selector in the top frame; stale refs and bad selectors are explained", async () => {
  const { T, scripting } = load();
  const info = {
    tag: "a", id: "cta", classes: ["cta"], selector: "#cta", text: "Call to action",
    box: { width: 160, height: 38, top: 300, left: 24 }, margin: [0, 0, 0, 0], padding: [8, 16, 8, 16],
    border: { width: [0, 0, 0, 0], style: "none", color: "rgb(0, 0, 0)" }, radius: [4],
    font: { family: "Georgia, serif", size: 16, weight: "400", style: "normal", lineHeight: 24, color: "rgb(255, 255, 255)", align: "start", transform: "none", decoration: "none", letterSpacing: "normal" },
    background: { color: "rgb(255, 102, 0)", image: "" }, display: "inline-block", position: "static", opacity: "1", zIndex: "auto", overflow: "visible", boxShadow: "",
    rules: [{ selector: "a.cta", sheet: "inline <style>", media: "", decls: 5, important: false }, { selector: "a", sheet: "site.css", media: "@media (min-width: 600px)", decls: 1, important: true }], sheets: 2, unreadable: 1,
  };
  scripting.results.pageInspect = info;
  await assert.rejects(T.run("browser_style_inspect", { ref: 3 }), /No element \[3\] — call browser_read_page first/);
  await assert.rejects(T.run("browser_style_inspect", {}), /Pass ref .* or selector/);
  T.refs[3] = { documentId: "doc-1", local: 2, loc: { kind: "link", text: "Call to action" } };
  const out = await runTool(T, "browser_style_inspect", { ref: 3 });
  assert.deepEqual(plain(scripting.calls.at(-1).target), { tabId: 7, documentIds: ["doc-1"] }, "runs in the frame that owns the ref");
  assert.deepEqual(scripting.calls.at(-1).args, [2, ""]);
  assert.equal(out, [
    '<a#cta.cta> "Call to action" — selector: #cta',
    "Box: 160×38 px at (24, 300); margin 0 0 0 0; padding 8 16 8 16; border none; radius 4",
    "Type: Georgia, serif 16px / 24px, weight 400, color rgb(255, 255, 255) (#ffffff)",
    "Background: rgb(255, 102, 0) (#ff6600)",
    "Layout: display inline-block, position static",
    "Matched rules (2, from 2 stylesheets; 1 cross-origin stylesheet could not be read):",
    "  a.cta  (inline <style>, 5 declarations)",
    "  a  (site.css, @media (min-width: 600px), 1 declaration, uses !important)",
    "An override for it starts with: #cta { … } — browser_style_apply saves it for this site.",
  ].join("\n"));
  await runTool(T, "browser_style_inspect", { selector: "main h1" });
  assert.deepEqual(scripting.calls.at(-1).args, [0, "main h1"]);
  assert.deepEqual(plain(scripting.calls.at(-1).target), { tabId: 7 }, "a selector runs in the top frame");
  scripting.results.pageInspect = { error: "stale" };
  await assert.rejects(T.run("browser_style_inspect", { ref: 3 }), /That element is gone — the page changed\. Call browser_read_page again\./);
  scripting.results.pageInspect = { error: 'No element matches "h9" on this page (top frame). Check the selector with browser_read_page, or pass a ref.' };
  await assert.rejects(T.run("browser_style_inspect", { selector: "h9" }), /No element matches "h9"/);
});

test("the 🎨 tab: lists the site's and the global overrides with pause / edit / delete, New override opens an editor whose Apply saves, Reset this site clears the host", async () => {
  const { T, tabs, data, scripting } = load();
  const dom = fakeDom();
  const ctx = fakeCtx(dom);
  const content = dom.node("div");
  await tabs[0].render(content, ctx);
  assert.match(content.allText, /New override/);
  assert.match(content.allText, /No overrides for example\.com yet\./);
  assert.equal(content.button("🧹 Reset this site"), undefined, "nothing to reset yet");

  await runTool(T, "browser_style_apply", { name: "wider", css: "main { max-width: 70ch }" });
  await runTool(T, "browser_style_apply", { name: "big", css: "body { font-size: 18px }", site: "*" });
  data.agentSiteStyles["other.com"] = { z: { css: "p{}", enabled: true, t: 1 } };
  await tabs[0].render(content, ctx);
  const names = content.find((n) => n.props.className === "cmd-name").map((n) => n.textContent);
  assert.deepEqual(names, ["New override", "wider", "big"]);
  assert.deepEqual(content.find((n) => n.props.className === "cmd-group-title").map((n) => n.textContent), ["example.com", "Every site"]);
  assert.match(content.allText, /24 B · on · just now/);
  assert.match(content.allText, /Also saved: other\.com \(1\)\./);

  // Pause from the tab.
  scripting.calls.length = 0;
  content.button("Pause").click();
  await settle();
  assert.equal(data.agentSiteStyles["example.com"].wider.enabled, false);
  assert.deepEqual(ctx.statuses.at(-1), { text: "Paused 'wider'.", kind: "good" });
  assert.equal(ctx.rerenders, 1);
  assert.equal(scripting.calls.at(-1).func, "pageApplyStyles");

  // Edit opens the editor with the CSS; Apply saves and re-renders.
  content.button("Edit").click();
  const inputs = content.find((n) => n.tag === "input" || n.tag === "textarea");
  assert.deepEqual(inputs.map((n) => n.value), ["wider", "example.com", "main { max-width: 70ch }"]);
  inputs[2].value = "main { max-width: 80ch }";
  content.button("✓ Apply").click();
  await settle();
  assert.equal(data.agentSiteStyles["example.com"].wider.css, "main { max-width: 80ch }");
  assert.equal(data.agentSiteStyles["example.com"].wider.enabled, false, "editing keeps the paused state");
  assert.deepEqual(ctx.statuses.at(-1), { text: "Updated 'wider' for example.com.", kind: "good" });
  // A broken edit is refused with the reason and nothing changes.
  await tabs[0].render(content, ctx);
  content.button("Edit").click();
  content.find((n) => n.tag === "textarea")[0].value = "main { max-width: 80ch ";
  content.button("✓ Apply").click();
  await settle();
  assert.match(ctx.statuses.at(-1).text, /^⚠ The CSS was refused: Missing '}'/);
  assert.equal(data.agentSiteStyles["example.com"].wider.css, "main { max-width: 80ch }");

  // New override: name + site + CSS.
  await tabs[0].render(content, ctx);
  content.find((n) => n.props.className === "cmd-item")[0].click();
  const fresh = content.find((n) => n.tag === "input" || n.tag === "textarea");
  assert.deepEqual(fresh.map((n) => n.value), ["", "example.com", ""]);
  fresh[0].value = "hide promo"; fresh[2].value = "aside.promo { display: none }";
  content.button("✓ Apply").click();
  await settle();
  assert.equal(data.agentSiteStyles["example.com"]["hide promo"].css, "aside.promo { display: none }");

  // Reset this site.
  await tabs[0].render(content, ctx);
  content.button("🧹 Reset this site").click();
  await settle();
  assert.equal(data.agentSiteStyles["example.com"], undefined);
  assert.ok(data.agentSiteStyles["*"].big, "the global override stays");
  assert.deepEqual(ctx.statuses.at(-1), { text: "Reset example.com.", kind: "good" });
  assert.deepEqual(ctx.prompts, []);
});

// A parser stand-in that takes every "property: value" declaration (the real one also knows the values).
class LenientSheet {
  constructor() { this.cssRules = []; }
  insertRule(rule, i) {
    if (/^@import/.test(rule)) throw new Error("Can't insert @import rules into a constructed stylesheet.");
    if (!/^[^{]+\{[^]*\}$/.test(rule.trim())) throw new Error("Failed to execute 'insertRule' on 'CSSStyleSheet': Failed to parse the rule '" + rule + "'.");
    const body = rule.slice(rule.indexOf("{") + 1, rule.lastIndexOf("}"));
    const style = { props: {}, getPropertyValue(p) { return this.props[p] || ""; } };
    for (const d of body.split(";")) { const m = /^\s*([-\w]+)\s*:\s*(\S[^]*)$/.exec(d); if (m) style.props[m[1]] = m[2].trim(); }
    style.length = Object.keys(style.props).length;
    this.cssRules.splice(i, 0, { style });
  }
}

test("presets: every preset validates (structure, and with a parser), browser_style_preset keeps one 'Preset: …' override per site, replaces it with another, resumes a paused one, off removes it", async () => {
  const { T, S, data, scripting } = load({ globals: { CSSStyleSheet: LenientSheet } });
  assert.deepEqual(Object.keys(S.PRESETS), ["reading", "focus", "compact", "dyslexia", "print"]);
  assert.deepEqual(plain(S.PRESET_NAMES), ["reading", "focus", "compact", "dyslexia", "print"]);
  for (const [name, css] of Object.entries(S.PRESETS)) {
    const v = S.validateCss(css);
    assert.equal(v.ok, true, name + ": " + v.error);
    assert.ok(v.rules >= 8, name + " has rules");
    assert.ok(css.length < S.MAX_CSS / 4, name + " is small");
    assert.equal(load().S.validateCss(css).ok, true, name + " without a parser");
  }
  for (const re of [/^html \{ font-size: 18px !important; \}$/m, /max-width: 68ch/, /line-height: 1\.7/, /\[class\*="sidebar"\][^\n]*\[class\*="promo"\][^\n]*\[class\*="newsletter"\][^\n]*\{ display: none !important; \}/, /^\*, \*::before, \*::after \{ animation: none !important; \}$/m]) assert.match(S.PRESETS.reading, re);
  assert.doesNotMatch(S.PRESETS.reading, /cookie|consent|login|sign/i, "consent and security UI are never hidden");
  assert.ok(S.PRESETS.focus.startsWith(S.PRESETS.reading), "focus builds on reading");
  assert.match(S.PRESETS.focus, /^img, video, iframe, embed, object \{ opacity: 0\.35 !important; \}\nimg:hover[^\n]* \{ opacity: 1 !important; \}$/m);
  assert.match(S.PRESETS.focus, /^header, footer, nav, [^\n]*\[class\*="sticky"\][^\n]* \{ position: static !important; \}$/m);
  assert.match(S.PRESETS.compact, /^html \{ font-size: 13px !important; \}$/m);
  assert.match(S.PRESETS.compact, /line-height: 1\.35/);
  assert.match(S.PRESETS.compact, /^h1 \{ font-size: 1\.6em !important; \}$/m);
  for (const re of [/Verdana/, /letter-spacing: 0\.05em/, /word-spacing: 0\.1em/, /line-height: 1\.8/, /text-align: left/, /#fbf7ef/, /color: #222222/, /^a \{ text-decoration: underline !important; \}$/m]) assert.match(S.PRESETS.dyslexia, re);
  for (const re of [/background-color: #ffffff !important; color: #000000 !important/, /^nav, aside, footer, video, iframe[^\n]* \{ display: none !important; \}$/m, /a\[href\^="http"\]::after \{ content: " \(" attr\(href\) "\)"/, /position: static !important/]) assert.match(S.PRESETS.print, re);

  await assert.rejects(T.run("browser_style_preset", { preset: "neon" }), /preset must be one of reading, focus, compact, dyslexia, print — or off/);
  await assert.rejects(T.run("browser_style_preset", {}), /preset must be one of/);
  assert.equal(await runTool(T, "browser_style_preset", { preset: "off" }), "No preset is on for example.com. Presets: reading, focus, compact, dyslexia, print.");
  const on = await runTool(T, "browser_style_preset", { preset: "reading" });
  const readingRules = S.validateCss(S.PRESETS.reading).rules;
  assert.match(on, new RegExp("^Preset 'reading' is on for example\\.com — override 'Preset: reading' \\(\\d\\.\\d KB, " + readingRules + " rules\\)\\. Applied in the current tab; the site keeps it until browser_style_preset preset=off \\(or browser_style_remove\\)\\. Check it with browser_screenshot"));
  assert.match(on, /Other presets: focus, compact, dyslexia, print\.$/);
  assert.deepEqual(Object.keys(stored(data)["example.com"]), ["Preset: reading"]);
  assert.equal(stored(data)["example.com"]["Preset: reading"].css, S.PRESETS.reading);
  assert.equal(scripting.calls.at(-1).func, "pageApplyStyles");
  assert.match(scripting.calls.at(-1).args[0], /^\/\* example\.com · Preset: reading \*\/\n\/\* Reading:/);

  // Another preset replaces it, applying twice keeps one, other overrides stay.
  await runTool(T, "browser_style_apply", { name: "wider", css: "main { max-width: 90ch }" });
  assert.match(await runTool(T, "browser_style_preset", { preset: "focus" }), /^Preset 'focus' is on for example\.com — override 'Preset: focus' \(\d\.\d KB, \d+ rules, replacing reading\)\. Applied/);
  assert.deepEqual(Object.keys(stored(data)["example.com"]).sort(), ["Preset: focus", "wider"]);
  assert.match(await runTool(T, "browser_style_preset", { preset: "focus" }), /^Preset 'focus' is on for example\.com — override 'Preset: focus' \(\d\.\d KB, \d+ rules, refreshed\)\./);
  assert.deepEqual(Object.keys(stored(data)["example.com"]).sort(), ["Preset: focus", "wider"]);
  assert.equal(Object.keys(stored(data)["example.com"]).filter((n) => n.startsWith("Preset: ")).length, 1, "one preset at a time");
  assert.deepEqual(plain(S.presetsOf(stored(data), "example.com")), [{ name: "Preset: focus", preset: "focus", enabled: true }]);
  // A paused preset comes back on when it is applied again.
  stored(data)["example.com"]["Preset: focus"].enabled = false;
  await runTool(T, "browser_style_preset", { preset: "focus" });
  assert.equal(stored(data)["example.com"]["Preset: focus"].enabled, true);
  // Another site by name; off removes the preset and nothing else.
  assert.match(await runTool(T, "browser_style_preset", { preset: "print", site: "www.Other.com" }), /^Preset 'print' is on for other\.com — override 'Preset: print' \([^)]*\)\. Saved; it applies on other\.com \(the current tab is example\.com\)/);
  assert.deepEqual(Object.keys(stored(data)["other.com"]), ["Preset: print"]);
  assert.equal(await runTool(T, "browser_style_preset", { preset: "off" }), "Preset focus is off for example.com (override 'Preset: focus' removed; its other overrides are untouched). The current tab is updated.");
  assert.deepEqual(Object.keys(stored(data)["example.com"]), ["wider"]);
  assert.deepEqual(scripting.calls.at(-1).args, ["/* example.com · wider */\nmain { max-width: 90ch }", "data-agent-styles"]);
});

test("fontCss / browser_style_font: !important family rules for body text, headings and code, a base size, a Google Fonts @import at the top that the validator lets through and the cascade hoists; other @imports stay refused", async () => {
  const { T, S, data, scripting } = load();
  assert.throws(() => S.fontCss({}), /Nothing to set — pass body, headings or code/);
  assert.throws(() => S.fontCss({ size: 9 }), /size must be a base font size between 12 and 24/);
  assert.throws(() => S.fontCss({ size: 25 }), /between 12 and 24/);
  assert.throws(() => S.fontCss({ googleFont: "Inter; evil" }), /googleFont must be a Google Fonts family name/);
  const css = S.fontCss({ body: "Georgia, serif", headings: "'Helvetica Neue', sans-serif", code: "'JetBrains Mono', monospace", size: 18 });
  assert.equal(css, [
    "/* Fonts */",
    "body, p, li, dd, dt, td, th, blockquote, figcaption, label, legend, summary, caption, input, select, textarea, button { font-family: Georgia, serif !important; }",
    "h1, h2, h3, h4, h5, h6 { font-family: 'Helvetica Neue', sans-serif !important; }",
    "code, pre, kbd, samp, var, tt { font-family: 'JetBrains Mono', monospace !important; }",
    "html { font-size: 18px !important; }",
  ].join("\n"));
  assert.deepEqual(plain(S.validateCss(css)), { ok: true, rules: 4 });
  assert.equal(S.fontCss({ size: 16 }), "/* Fonts */\nhtml { font-size: 16px !important; }");
  // A value cannot end the declaration or the rule early: the override stays one rule.
  const sneaky = S.fontCss({ body: "Georgia; } body { display: none" });
  assert.equal(sneaky.split("\n").length, 2);
  assert.deepEqual(plain(S.validateCss(sneaky)), { ok: true, rules: 1 });
  assert.doesNotMatch(sneaky, /\{ display/);
  // Google Fonts: the @import first, the family for body and headings unless they are given.
  const g = S.fontCss({ googleFont: " Source  Serif 4 ", headings: "Inter, sans-serif" });
  assert.equal(g, [
    '@import url("https://fonts.googleapis.com/css2?family=Source+Serif+4&display=swap");',
    "/* Fonts — Source Serif 4 from Google Fonts */",
    'body, p, li, dd, dt, td, th, blockquote, figcaption, label, legend, summary, caption, input, select, textarea, button { font-family: "Source Serif 4", sans-serif !important; }',
    "h1, h2, h3, h4, h5, h6 { font-family: Inter, sans-serif !important; }",
  ].join("\n"));
  assert.deepEqual(plain(S.fontOptions({ googleFont: "Inter" })), { body: "Inter, sans-serif", headings: "Inter, sans-serif", code: "", size: null, googleFont: "Inter" });
  assert.deepEqual(plain(S.validateCss(g)), { ok: true, rules: 2 }, "the Google Fonts import passes; rules counted without it");
  assert.equal(load({ globals: { CSSStyleSheet: LenientSheet } }).S.validateCss(g).ok, true, "the @import is not handed to a constructed sheet (which refuses it)");
  assert.match(S.validateCss('h1 { color: red }\n@import url("https://fonts.googleapis.com/css2?family=Inter&display=swap");').error, /The @import must come before the other rules/);
  assert.match(S.validateCss('@import url("https://evil.example/x.css");\nh1 { color: red }').error, /@import is not allowed .* The one exception is a Google Fonts stylesheet/);
  assert.match(S.validateCss('@import url("http://fonts.googleapis.com/css2?family=Inter");\nh1 { color: red }').error, /@import is not allowed/, "https only");
  assert.match(S.validateCss('@import url("https://fonts.googleapis.com.evil.example/css2?family=Inter");\nh1 { color: red }').error, /@import is not allowed/);

  // The tool: saved as 'Fonts' (the same name replaces), applied; the cascade puts the @import first even when other overrides sort before it.
  await runTool(T, "browser_style_apply", { name: "A big text", css: "body { font-size: 20px }" });
  await runTool(T, "browser_style_apply", { name: "global", css: "body { margin: 0 }", site: "*" });
  await assert.rejects(T.run("browser_style_font", {}), /Nothing to set/);
  const out = await runTool(T, "browser_style_font", { googleFont: "Inter", code: "monospace", size: 17 });
  assert.match(out, /^Saved the 'Fonts' override for example\.com \(\d+ B\): body text → Inter, sans-serif; headings → Inter, sans-serif; code → monospace; base size → 17px\. 'Inter' is loaded with an @import from fonts\.googleapis\.com at the top of the override — a site's Content-Security-Policy can block that import, in which case the fallback fonts show/);
  assert.match(out, /Applied in the current tab; the site keeps it until browser_style_remove name=Fonts\.$/);
  assert.ok(stored(data)["example.com"].Fonts.css.startsWith('@import url("https://fonts.googleapis.com/css2?family=Inter&display=swap");\n'));
  const injected = scripting.calls.at(-1).args[0];
  assert.equal(injected, [
    '@import url("https://fonts.googleapis.com/css2?family=Inter&display=swap");',
    "",
    "/* every site · global */", "body { margin: 0 }", "",
    "/* example.com · A big text */", "body { font-size: 20px }", "",
    "/* example.com · Fonts */", "/* Fonts — Inter from Google Fonts */",
    "body, p, li, dd, dt, td, th, blockquote, figcaption, label, legend, summary, caption, input, select, textarea, button { font-family: Inter, sans-serif !important; }",
    "h1, h2, h3, h4, h5, h6 { font-family: Inter, sans-serif !important; }",
    "code, pre, kbd, samp, var, tt { font-family: monospace !important; }",
    "html { font-size: 17px !important; }",
  ].join("\n"), "the @import is hoisted above every override");
  assert.match(await runTool(T, "browser_style_font", { body: "Georgia, serif" }), /^Replaced the 'Fonts' override for example\.com \(\d+ B\): body text → Georgia, serif\. Applied in the current tab/);
  assert.doesNotMatch(stored(data)["example.com"].Fonts.css, /@import/);
  assert.doesNotMatch(scripting.calls.at(-1).args[0], /@import/);
  await runTool(T, "browser_style_font", { headings: "Inter", site: "*" });
  assert.match(stored(data)["*"].Fonts.css, /^\/\* Fonts \*\/\nh1, h2, h3, h4, h5, h6 \{ font-family: Inter !important; \}$/);
});

test("toUserCss / browser_style_export: a UserCSS document with a header and one @-moz-document block per site (regexp for '*'), paused overrides commented out, @imports hoisted; format css is plain; save writes <site or all>-styles.user.css to Downloads", async () => {
  const { T, S, data, downloads } = load();
  await assert.rejects(T.run("browser_style_export", {}), /No style overrides saved yet — nothing to export/);
  const t = Date.UTC(2026, 9, 26, 12);
  data.agentSiteStyles = {
    "example.com": {
      "wider article": { css: "main article {\n  max-width: 70ch;\n}", enabled: true, t },
      "hide sidebar": { css: "aside { display: none } /* gone */", enabled: false, t },
      Fonts: { css: '@import url("https://fonts.googleapis.com/css2?family=Inter&display=swap");\nbody { font-family: Inter, sans-serif !important; }', enabled: true, t },
    },
    "*": { "big text": { css: "body { font-size: 18px }", enabled: true, t } },
  };
  const doc = S.toUserCss(data.agentSiteStyles, "", "usercss");
  assert.equal(doc, [
    "/* ==UserStyle==",
    "@name           all sites — site styles",
    "@namespace      agent-site-styles",
    "@version        1.0.0",
    "@description    4 overrides for all sites: big text, Fonts, hide sidebar, wider article",
    "==/UserStyle== */",
    "",
    '@import url("https://fonts.googleapis.com/css2?family=Inter&display=swap");',
    "",
    '@-moz-document regexp(".*") {',
    "  /* big text — saved 2026-10-26 */",
    "  body { font-size: 18px }",
    "}",
    "",
    '@-moz-document domain("example.com") {',
    "  /* Fonts — saved 2026-10-26 */",
    "  body { font-family: Inter, sans-serif !important; }",
    "",
    "  /* hide sidebar — saved 2026-10-26 — paused */",
    "  /*",
    "  aside { display: none } /* gone * /",
    "  */",
    "",
    "  /* wider article — saved 2026-10-26 */",
    "  main article {",
    "    max-width: 70ch;",
    "  }",
    "}",
  ].join("\n"));
  assert.equal(await runTool(T, "browser_style_export", {}), doc);
  // One site, plain CSS: no header, no blocks, the import still first.
  const css = S.toUserCss(data.agentSiteStyles, "www.Example.com", "css");
  assert.equal(css, [
    '@import url("https://fonts.googleapis.com/css2?family=Inter&display=swap");',
    "",
    "/* ── example.com ── */",
    "/* Fonts — saved 2026-10-26 */",
    "body { font-family: Inter, sans-serif !important; }",
    "",
    "/* hide sidebar — saved 2026-10-26 — paused */",
    "/*",
    "aside { display: none } /* gone * /",
    "*/",
    "",
    "/* wider article — saved 2026-10-26 */",
    "main article {",
    "  max-width: 70ch;",
    "}",
  ].join("\n"));
  assert.equal(await runTool(T, "browser_style_export", { site: "example.com", format: "css" }), css);
  assert.match(await runTool(T, "browser_style_export", { site: "*" }), /^\/\* ==UserStyle==\n@name           every site — site styles\n[^]*@description    1 override for every site: big text\n==\/UserStyle== \*\/\n\n@-moz-document regexp\("\.\*"\) \{\n  \/\* big text — saved 2026-10-26 \*\/\n  body \{ font-size: 18px \}\n\}$/);
  await assert.rejects(T.run("browser_style_export", { site: "nothing.example" }), /No style overrides for nothing\.example — nothing to export\. browser_style_list shows the sites that have some\./);
  // The export round-trips through the parser.
  assert.deepEqual(plain(S.parseUserCss(doc).map((e) => e.site)), ["*", "example.com"]);

  // save: a data: URL to Downloads, the id reported.
  const saved = await runTool(T, "browser_style_export", { save: true });
  assert.match(saved, /^Saved all-styles\.user\.css to Downloads \(download id 41, \d+ B\): every site \(1\), example\.com \(3\)\. It installs in Stylus \(Manage → Import/);
  assert.deepEqual(downloads.calls.map((c) => [c.filename, c.conflictAction]), [["all-styles.user.css", "uniquify"]]);
  assert.equal(decodeURIComponent(downloads.calls[0].url.replace(/^data:text\/css;charset=utf-8,/, "")), doc);
  assert.match(await runTool(T, "browser_style_export", { site: "example.com", format: "css", save: true }), /^Saved example\.com-styles\.css to Downloads \(download id 42, \d+ B\): example\.com \(3\)\. Plain CSS with a comment per override\.$/);
  assert.equal(S.exportFilename("*", "usercss"), "every-site-styles.user.css");
  downloads.fail = "Invalid filename";
  await assert.rejects(T.run("browser_style_export", { save: true }), /Invalid filename/);
  // A build without the downloads permission says so and keeps the text route.
  const noDl = load();
  delete noDl.chrome.downloads;
  await runTool(noDl.T, "browser_style_apply", { name: "x", css: "h1 { color: red }" });
  await assert.rejects(noDl.T.run("browser_style_export", { save: true }), /cannot save files \(no downloads permission\) — call again without save/);
  assert.match(await runTool(noDl.T, "browser_style_export", {}), /@-moz-document domain\("example\.com"\)/);
});

test("parseUserCss / browser_style_import: a two-domain document goes to its sites (the header dropped, @imports put back), plain CSS takes the site, a broken block is reported and the others are saved", async () => {
  const { T, S, data, scripting } = load();
  const imp = '@import url("https://fonts.googleapis.com/css2?family=Inter&display=swap");\n';
  const doc = [
    "/* ==UserStyle==", "@name x", "@version 1.0.0", "==/UserStyle== */", "",
    imp.trim(), "",
    '@-moz-document domain("example.com"), domain("www.Other.com") {',
    "  /* wider */",
    "  main article {",
    "    max-width: 70ch;",
    "  }",
    "}", "",
    '@-moz-document url-prefix("https://docs.example.org/guide/") {',
    "  h1 { color: red }",
    "}", "",
    '@-moz-document regexp(".*") {', "  body { font-size: 18px }", "}",
    "", "/* a stray comment */",
    '@-moz-document regexp("https?://.*gov/.*") {', "  p { color: blue }", "}",
  ].join("\n");
  assert.deepEqual(plain(S.parseUserCss(doc)), [
    { site: "example.com", css: imp + "/* wider */\nmain article {\n  max-width: 70ch;\n}", prelude: 'domain("example.com"), domain("www.Other.com")' },
    { site: "other.com", css: imp + "/* wider */\nmain article {\n  max-width: 70ch;\n}", prelude: 'domain("example.com"), domain("www.Other.com")' },
    { site: "docs.example.org", css: imp + "h1 { color: red }", prelude: 'url-prefix("https://docs.example.org/guide/")' },
    { site: "*", css: imp + "body { font-size: 18px }", prelude: 'regexp(".*")' },
    { site: "", css: imp + "p { color: blue }", prelude: 'regexp("https?://.*gov/.*")' },
  ]);
  assert.deepEqual(plain(S.preludeSites('domain("A.com"), url("https://b.com/x"), regexp("^.*$"), domain("A.com")')), ["a.com", "b.com", "*"]);
  // Plain CSS is one entry without a site; a header-only text is nothing; rules outside the blocks go to every site.
  assert.deepEqual(plain(S.parseUserCss("h1 { color: red }\n/* c */\np { margin: 0 }")), [{ site: "", css: "h1 { color: red }\n/* c */\np { margin: 0 }" }]);
  assert.deepEqual(plain(S.parseUserCss("/* ==UserStyle==\n@name x\n==/UserStyle== */\n\n/* only comments */")), []);
  assert.deepEqual(plain(S.parseUserCss('body { margin: 0 }\n@-moz-document domain("a.com") { a::after { content: "}" } }')), [{ site: "a.com", css: 'a::after { content: "}" }', prelude: 'domain("a.com")' }, { site: "*", css: "body { margin: 0 }" }]);

  await assert.rejects(T.run("browser_style_import", {}), /css is required/);
  await assert.rejects(T.run("browser_style_import", { css: "/* nothing */" }), /No CSS rules found/);
  const out = await runTool(T, "browser_style_import", { css: doc });
  assert.match(out, /^Imported 4 overrides named 'Imported' \(the current tab is updated\):\n  example\.com: saved override 'Imported' \(\d+ B, 1 rule\)\n  other\.com: saved override 'Imported' \(\d+ B, 1 rule\)\n  docs\.example\.org: saved override 'Imported' \(\d+ B, 1 rule\)\n  every site: saved override 'Imported' \(\d+ B, 1 rule\)\n  skipped the block for regexp\("https\?:\/\/\.\*gov\/\.\*"\): no site — pass site, or use @-moz-document domain\("…"\) blocks\nThe sites keep them until browser_style_remove\.$/);
  assert.deepEqual(Object.keys(stored(data)).sort(), ["*", "docs.example.org", "example.com", "other.com"]);
  assert.equal(stored(data)["example.com"].Imported.css, imp + "/* wider */\nmain article {\n  max-width: 70ch;\n}");
  assert.equal(stored(data)["*"].Imported.css, imp + "body { font-size: 18px }");
  assert.equal(scripting.calls.at(-1).func, "pageApplyStyles");
  assert.equal(scripting.calls.at(-1).args[0].split("\n\n")[0], imp.trim(), "the import is hoisted once");
  assert.equal((scripting.calls.at(-1).args[0].match(/@import/g) || []).length, 1);
  // With site, a block without a known site goes there too.
  const withSite = await runTool(T, "browser_style_import", { css: '@-moz-document regexp("x") { p { color: blue } }', site: "gov.example", name: "blue" });
  assert.match(withSite, /^Imported 1 override named 'blue'[^]*\n  gov\.example: saved override 'blue' \(17 B, 1 rule\)\n/);

  // Plain CSS: the current tab's site (or site) under a name; the same name replaces.
  assert.match(await runTool(T, "browser_style_import", { css: "h1 { color: red }", name: "Headline" }), /^Imported 1 override named 'Headline' \(the current tab is updated\):\n  example\.com: saved override 'Headline' \(17 B, 1 rule\)\nThe sites keep them/);
  assert.match(await runTool(T, "browser_style_import", { css: "h1 { color: green }", name: "Headline", site: "www.Other.com" }), /other\.com: saved override 'Headline'/);
  assert.match(await runTool(T, "browser_style_import", { css: "h1 { color: blue }", name: "Headline", site: "www.Other.com" }), /other\.com: replaced override 'Headline'/);
  assert.equal(stored(data)["other.com"].Headline.css, "h1 { color: blue }");
  // No website tab and no site: plain CSS cannot be placed.
  T.noTab = true;
  await assert.rejects(T.run("browser_style_import", { css: "h1 { color: red }" }), /Nothing was imported:\n  skipped the plain CSS: no site — pass site/);
  T.noTab = false;
  // One broken block is reported, the other is saved.
  const mixed = '@-moz-document domain("a.com") {\n  color: red\n}\n@-moz-document domain("b.com") {\n  h2 { color: blue }\n}';
  assert.equal(await runTool(T, "browser_style_import", { css: mixed }), [
    "Imported 1 override named 'Imported' (the current tab is updated):",
    "  b.com: saved override 'Imported' (18 B, 1 rule)",
    '  a.com: refused the block for domain("a.com") — Text outside a rule: "color: red" — every declaration needs a selector and braces, e.g. h1 { color: red }',
    "The sites keep them until browser_style_remove.",
  ].join("\n"));
  assert.equal(stored(data)["a.com"], undefined);
  assert.equal(stored(data)["b.com"].Imported.css, "h2 { color: blue }");
  // Everything broken (a block that never closes): an error with the reasons, nothing saved.
  await assert.rejects(T.run("browser_style_import", { css: '@-moz-document domain("c.com") {\n  h1 { color: red' }), /Nothing was imported:\n  c\.com: refused the block for domain\("c\.com"\) — Missing '\}' — 1 block is not closed$/);
  assert.equal(stored(data)["c.com"], undefined);
});

test("toggleOverrides / browser_style_toggle: pauses and resumes one override or every override of the site (flipping without enabled), reports the new state, updates the tab; the content script leaves a paused override out on a load", async () => {
  const { T, S, data, scripting } = load();
  await assert.rejects(T.run("browser_style_toggle", {}), /name is required — the override to pause or resume, or '\*'/);
  await assert.rejects(T.run("browser_style_toggle", { name: "*" }), /No overrides saved for example\.com — nothing to pause or resume/);
  await runTool(T, "browser_style_apply", { name: "A", css: "h1 { color: red }" });
  await runTool(T, "browser_style_apply", { name: "B", css: "h2 { color: blue }" });
  await runTool(T, "browser_style_apply", { name: "G", css: "body { margin: 0 }", site: "*" });
  await assert.rejects(T.run("browser_style_toggle", { name: "nope" }), /No override named 'nope' on example\.com\. Its overrides: A, B\./);
  scripting.calls.length = 0;
  // Without enabled the state flips (the name in any case).
  assert.equal(await runTool(T, "browser_style_toggle", { name: "a" }), "Paused override 'A' on example.com — it stays saved; browser_style_toggle name=\"A\" enabled=true resumes it. The current tab is updated; the site leaves it out on every visit until resumed.");
  assert.equal(stored(data)["example.com"].A.enabled, false);
  assert.deepEqual(scripting.calls.map((c) => c.func), ["pageApplyStyles"]);
  assert.equal(scripting.calls[0].args[0], "/* every site · G */\nbody { margin: 0 }\n\n/* example.com · B */\nh2 { color: blue }", "the paused override is left out of the tab at once");
  assert.equal(await runTool(T, "browser_style_toggle", { name: "A" }), "Resumed override 'A' on example.com. The current tab is updated; the site applies it again on every visit.");
  assert.equal(stored(data)["example.com"].A.enabled, true);
  // With enabled the state is set; the same state again changes nothing (and does not touch the tab).
  assert.match(await runTool(T, "browser_style_toggle", { name: "A", enabled: false }), /^Paused override 'A'/);
  scripting.calls.length = 0;
  assert.equal(await runTool(T, "browser_style_toggle", { name: "A", enabled: false }), "Override 'A' on example.com is already paused — nothing changed.");
  assert.deepEqual(scripting.calls, []);
  // '*': every override of the site together — paused when any is on, resumed when all are paused.
  assert.equal(await runTool(T, "browser_style_toggle", { name: "*" }), "Paused every override of example.com (1: B; already paused: A) — they stay saved; browser_style_toggle name=\"*\" enabled=true resumes them. The current tab is updated; the site leaves them out on every visit until resumed.");
  assert.deepEqual([stored(data)["example.com"].A.enabled, stored(data)["example.com"].B.enabled], [false, false]);
  assert.deepEqual(scripting.calls.at(-1).args, ["/* every site · G */\nbody { margin: 0 }", "data-agent-styles"]);
  assert.equal(await runTool(T, "browser_style_toggle", { name: "*", enabled: false }), "Every override of example.com is already paused (A, B) — nothing changed.");
  assert.equal(await runTool(T, "browser_style_toggle", { name: "*" }), "Resumed every override of example.com (2: A, B). The current tab is updated; the site applies them again on every visit.");
  assert.ok(stored(data)["example.com"].A.enabled && stored(data)["example.com"].B.enabled);
  assert.equal(stored(data)["*"].G.enabled, true, "another site's overrides are untouched");
  // The helper's result; a site by name.
  assert.deepEqual(plain(await S.toggleOverrides({ site: "*", name: "g", enabled: false })), { site: "*", enabled: false, all: false, changed: ["G"], unchanged: [] });
  assert.equal(stored(data)["*"].G.enabled, false);
  assert.match(await runTool(T, "browser_style_toggle", { name: "G", site: "*", enabled: true }), /^Resumed override 'G' on every site\. The current tab is updated/);
  // Paused → the content script leaves it out on a load, and puts it back once resumed.
  await runTool(T, "browser_style_toggle", { name: "B", enabled: false });
  const cs = loadContentScript({ hostname: "www.example.com", data: { agentSiteStyles: plain(stored(data)) } });
  await settle();
  assert.equal(styleEl(cs.doc).textContent, "/* every site · G */\nbody { margin: 0 }\n\n/* example.com · A */\nh1 { color: red }");
  await runTool(T, "browser_style_toggle", { name: "B", enabled: true });
  await cs.change(plain(stored(data)));
  await settle();
  assert.match(styleEl(cs.doc).textContent, /\n\n\/\* example\.com · B \*\/\nh2 \{ color: blue \}$/);
  // No website tab and no site: the usual error.
  T.noTab = true;
  await assert.rejects(T.run("browser_style_toggle", { name: "A" }), /No active tab/);
});

test("parseTokens / checkToken / tokensCss: one :root rule with every token !important, merged over an earlier Tokens override (known names keep their place, new ones are appended, an empty value drops one); names and values are checked", () => {
  const { S } = load();
  assert.deepEqual(plain(S.parseTokens("")), []);
  const css = S.tokensCss({ "--brand-color": "#0a7", "--radius": " 4px ", "--font-body": '"Inter", sans-serif' }, "");
  assert.equal(css, [
    "/* Tokens: the site's design tokens, changed everywhere they are used (browser_style_tokens) */",
    ":root {",
    "  --brand-color: #0a7 !important;",
    "  --radius: 4px !important;",
    '  --font-body: "Inter", sans-serif !important;',
    "}",
  ].join("\n"));
  assert.deepEqual(plain(S.validateCss(css)), { ok: true, rules: 1 });
  assert.equal(load({ globals: { CSSStyleSheet: LenientSheet } }).S.validateCss(css).ok, true, "with a parser too (custom properties take anything)");
  assert.deepEqual(plain(S.parseTokens(css)), [{ name: "--brand-color", value: "#0a7" }, { name: "--radius", value: "4px" }, { name: "--font-body", value: '"Inter", sans-serif' }]);
  const merged = S.tokensCss({ "--radius": "8px", "--gap": "1rem", "--brand-color": "" }, css);
  assert.deepEqual(plain(S.parseTokens(merged)), [{ name: "--radius", value: "8px" }, { name: "--font-body", value: '"Inter", sans-serif' }, { name: "--gap", value: "1rem" }]);
  assert.equal(S.tokensCss({ "--radius": "", "--font-body": "", "--gap": "" }, merged), "", "nothing left");
  assert.deepEqual(plain(S.parseTokens("h1 { --x: 1 } :root { color: red; --a: 1px; --a: 2px !important } html { --b: url(x) }")), [{ name: "--a", value: "2px" }, { name: "--b", value: "url(x)" }], "only :root / html tokens; the last declaration wins");
  // Names and values.
  assert.deepEqual(plain(S.checkToken(" --a ", " #fff  !important ")), { name: "--a", value: "#fff" });
  assert.deepEqual(plain(S.checkToken("--a", 4)), { name: "--a", value: "4" });
  assert.deepEqual(plain(S.checkToken("--a", null)), { name: "--a", value: "" });
  assert.deepEqual(plain(S.checkToken("--a", "var(--b, #fff)")), { name: "--a", value: "var(--b, #fff)" });
  assert.throws(() => S.checkToken("brand", "#fff"), /'brand' is not a custom property name — names start with --/);
  assert.throws(() => S.checkToken("--a b", "#fff"), /is not a custom property name/);
  assert.throws(() => S.checkToken("--" + "a".repeat(79), "#fff"), /is not a custom property name/);
  assert.throws(() => S.checkToken("--a", "x".repeat(201)), /--a: the value is too long \(201 characters; at most 200\)/);
  assert.throws(() => S.checkToken("--a", "red; } body { display: none"), /--a: the value may not contain ; \{ \} or comment markers/);
  assert.throws(() => S.checkToken("--a", "x /* y */"), /comment markers/);
  assert.throws(() => S.checkToken("--a", "url(https://evil.example/x.png)"), /--a: url\(\), expression\(\) and javascript: are not allowed/);
  assert.throws(() => S.checkToken("--a", "expression(alert(1))"), /not allowed/);
  assert.throws(() => S.checkToken("--a", "javascript:alert(1)"), /not allowed/);
  assert.throws(() => S.checkToken("--a", "calc(1px + 2px"), /--a: the parentheses in the value are not balanced/);
  assert.throws(() => S.checkToken("--a", "'Inter"), /--a: a quote in the value is not closed/);
  assert.throws(() => S.tokensCss({}, ""), /set is required/);
  assert.throws(() => S.tokensCss(["--a"], ""), /set is required/);
  assert.throws(() => S.tokensCss({ "--a": "url(x)" }, ""), /not allowed/);
});

test("browser_style_tokens: saves the 'Tokens' override (merged on later calls), applies it, reports what was set, kept and dropped; a bad entry saves nothing; dropping every token removes the override", async () => {
  const { T, data, scripting } = load();
  await assert.rejects(T.run("browser_style_tokens", {}), /set is required/);
  await assert.rejects(T.run("browser_style_tokens", { set: {} }), /set is required/);
  await assert.rejects(T.run("browser_style_tokens", { set: { "--a": "url(x)" } }), /--a: url\(\)/);
  await assert.rejects(T.run("browser_style_tokens", { set: { "--a": "" } }), /Nothing to set — every value in set is empty and example\.com has no 'Tokens' override/);
  assert.deepEqual(stored(data), {});
  assert.equal(scripting.calls.length, 0);
  const out = await runTool(T, "browser_style_tokens", { set: { "--brand-color": "#0a7", "--radius": "4px" } });
  assert.match(out, /^Set 2 tokens on example\.com \(override 'Tokens', \d+ B\): --brand-color: #0a7; --radius: 4px\. Applied in the current tab; the site keeps it until browser_style_remove name=Tokens\. Every rule that uses var\(--name\) follows; a token the site redeclares on a component \(\.card \{ --name: … \}\) keeps its own value there/);
  const head = "/* Tokens: the site's design tokens, changed everywhere they are used (browser_style_tokens) */";
  assert.equal(stored(data)["example.com"].Tokens.css, head + "\n:root {\n  --brand-color: #0a7 !important;\n  --radius: 4px !important;\n}");
  assert.equal(stored(data)["example.com"].Tokens.enabled, true);
  assert.equal(scripting.calls.at(-1).func, "pageApplyStyles");
  assert.match(scripting.calls.at(-1).args[0], /^\/\* example\.com · Tokens \*\/\n\/\* Tokens:[^\n]*\*\/\n:root \{\n  --brand-color: #0a7 !important;/);
  // A later call merges: a known name takes the new value, new names are added, an empty value drops one.
  assert.match(await runTool(T, "browser_style_tokens", { set: { "--radius": "8px", "--gap": "1rem", "--brand-color": "" } }), /^Set 2 tokens on example\.com \(override 'Tokens', \d+ B\): --radius: 8px; --gap: 1rem\. Dropped --brand-color\. Applied in the current tab/);
  assert.equal(stored(data)["example.com"].Tokens.css, head + "\n:root {\n  --radius: 8px !important;\n  --gap: 1rem !important;\n}");
  assert.match(await runTool(T, "browser_style_tokens", { set: { "--ink": "#222" } }), /^Set 1 token on example\.com \(override 'Tokens', \d+ B\): --ink: #222\. 2 tokens from before kept\. Applied/);
  // A bad entry in a merge saves nothing.
  await assert.rejects(T.run("browser_style_tokens", { set: { "--ok": "1px", "--bad": "a; b" } }), /--bad: the value may not contain/);
  assert.doesNotMatch(stored(data)["example.com"].Tokens.css, /--ok/);
  // A paused Tokens override stays paused (as with browser_style_apply); another name, another site.
  stored(data)["example.com"].Tokens.enabled = false;
  await runTool(T, "browser_style_tokens", { set: { "--ink": "#333" } });
  assert.equal(stored(data)["example.com"].Tokens.enabled, false);
  assert.match(stored(data)["example.com"].Tokens.css, /--ink: #333 !important;/);
  assert.match(await runTool(T, "browser_style_tokens", { set: { "--brand": "#fff" }, name: "Tokens: dark", site: "www.Other.com" }), /^Set 1 token on other\.com \(override 'Tokens: dark', \d+ B\): --brand: #fff\. Saved; it applies on other\.com \(the current tab is example\.com\)/);
  assert.deepEqual(Object.keys(stored(data)["other.com"]), ["Tokens: dark"]);
  // Dropping every token removes the override.
  assert.equal(await runTool(T, "browser_style_tokens", { set: { "--radius": "", "--gap": "", "--ink": "" } }), "Dropped --radius, --gap, --ink — every token of the 'Tokens' override of example.com is gone, so the override was removed. The current tab is updated.");
  assert.equal(stored(data)["example.com"], undefined);
  assert.ok(stored(data)["other.com"]["Tokens: dark"]);
});

// ── The content script ───────────────────────────────────────────────────────

const STORE = {
  "example.com": { a: { css: "h1 { color: red }", enabled: true, t: 1 }, b: { css: "h2 { color: blue }", enabled: false, t: 1 } },
  "*": { g: { css: "body { font-size: 18px }", enabled: true, t: 1 } },
  "other.com": { z: { css: "p { color: green }", enabled: true, t: 1 } },
};

test("content script: injects the enabled overrides of the host (www. dropped) and of '*' as one <style data-agent-styles>, last in <head>; ignores other hosts", async () => {
  const cs = loadContentScript({ hostname: "www.example.com", data: { agentSiteStyles: STORE } });
  await settle();
  const el = styleEl(cs.doc);
  assert.ok(el, "the style element is there");
  assert.equal(el.textContent, "/* every site · g */\nbody { font-size: 18px }\n\n/* example.com · a */\nh1 { color: red }");
  assert.equal(el.parentNode, cs.doc.head);
  assert.equal(cs.doc.head.lastElementChild, el);
  assert.equal(cs.doc.head.children.length, 1, "one element, nothing else touched");
  // The exported helpers match the panel's cascade.
  assert.equal(cs.api.normHost("WWW.Example.com"), "example.com");
  assert.equal(cs.api.cssFor(STORE, "other.com"), "/* every site · g */\nbody { font-size: 18px }\n\n/* other.com · z */\np { color: green }");

  const none = loadContentScript({ hostname: "nothing.example", data: { agentSiteStyles: { "example.com": STORE["example.com"] } } });
  await settle();
  assert.equal(styleEl(none.doc), null, "a host with no overrides (and no '*') gets no element");
  const empty = loadContentScript({ hostname: "example.com", data: {} });
  await settle();
  assert.equal(styleEl(empty.doc), null);
});

test("content script: stays last when the page appends stylesheets later, follows storage changes live, removes its element when nothing is left", async () => {
  const cs = loadContentScript({ hostname: "example.com", data: { agentSiteStyles: STORE } });
  await settle();
  const ours = styleEl(cs.doc);
  const late = cs.doc.createElement("style");
  late.textContent = "h1 { color: black }";
  cs.doc.head.appendChild(late);
  const link = cs.doc.createElement("link");
  cs.doc.head.appendChild(link);
  await settle();
  assert.deepEqual(cs.doc.head.children.map((c) => c.tag + (c.hasAttribute("data-agent-styles") ? "*" : "")), ["style", "link", "style*"], "ours moved back to the end");
  assert.equal(styleEl(cs.doc), ours, "the same element, not a copy");
  // The panel's preview element may sit after ours without a tug of war.
  const preview = cs.doc.createElement("style");
  preview.setAttribute("data-agent-styles-preview", "");
  cs.doc.head.appendChild(preview);
  await settle();
  assert.deepEqual(cs.doc.head.children.map((c) => c.tag + (c.hasAttribute("data-agent-styles") ? "*" : c.hasAttribute("data-agent-styles-preview") ? "~" : "")), ["style", "link", "style*", "style~"]);

  // A storage change is applied at once.
  await cs.change({ "example.com": { a: { css: "h1 { color: pink }", enabled: true, t: 2 } } });
  await settle();
  assert.equal(styleEl(cs.doc).textContent, "/* example.com · a */\nh1 { color: pink }");
  await cs.change({ "example.com": { a: { css: "h1 { color: pink }", enabled: false, t: 2 } } });
  await settle();
  assert.equal(styleEl(cs.doc), null, "everything paused → the element goes");
  await cs.change({ "*": { g: { css: "body { margin: 0 }", enabled: true, t: 3 } } });
  await settle();
  assert.equal(styleEl(cs.doc).textContent, "/* every site · g */\nbody { margin: 0 }");
  assert.equal(cs.doc.head.lastElementChild, styleEl(cs.doc));
});

test("content script at document_start: with no <head> yet the element goes onto <html> and moves into <head> once the parser creates it", async () => {
  const cs = loadContentScript({ hostname: "example.com", withHead: false, data: { agentSiteStyles: STORE } });
  await settle();
  const el = styleEl(cs.doc);
  assert.equal(el.parentNode, cs.doc.documentElement);
  cs.doc.addHead();
  await settle();
  assert.equal(el.parentNode, cs.doc.head);
  assert.equal(cs.doc.head.lastElementChild, el);
  assert.equal(cs.observers.filter((o) => !o.disconnected).length, 1, "one live observer, on <head>");
  assert.equal(cs.observers.filter((o) => !o.disconnected)[0].target, cs.doc.head);
});

test("content script: start() is a factory a test (or another document) can drive by hand", async () => {
  const cs = loadContentScript({ hostname: "x.example", manual: true, data: { agentSiteStyles: STORE } });
  await settle();
  assert.equal(styleEl(cs.doc), null, "nothing started on its own");
  const applier = cs.api.start(cs.chrome, cs.doc, "WWW.EXAMPLE.COM", cs.MutationObserver);
  await settle();
  assert.equal(applier.element(), styleEl(cs.doc));
  assert.match(styleEl(cs.doc).textContent, /h1 \{ color: red \}/);
  applier.apply("");
  assert.equal(styleEl(cs.doc), null);
});

test("content script: the @import an override starts with is hoisted above every override, once, the same as the panel's cascade", async () => {
  const store = {
    "example.com": { Fonts: { css: '@import url("https://fonts.googleapis.com/css2?family=Inter&display=swap");\nbody { font-family: Inter }', enabled: true, t: 1 }, A: { css: "h1 { color: red }", enabled: true, t: 1 } },
    "*": { g: { css: '@import url("https://fonts.googleapis.com/css2?family=Inter&display=swap");\nbody { margin: 0 }', enabled: true, t: 1 } },
  };
  const cs = loadContentScript({ hostname: "example.com", data: { agentSiteStyles: store } });
  await settle();
  const expected = '@import url("https://fonts.googleapis.com/css2?family=Inter&display=swap");\n\n/* every site · g */\nbody { margin: 0 }\n\n/* example.com · A */\nh1 { color: red }\n\n/* example.com · Fonts */\nbody { font-family: Inter }';
  assert.equal(styleEl(cs.doc).textContent, expected);
  assert.equal(load().S.cssFor(store, "example.com"), expected, "the panel builds the same text");
  await cs.change({ "example.com": { Fonts: { css: store["example.com"].Fonts.css, enabled: false, t: 2 }, A: store["example.com"].A } });
  await settle();
  assert.equal(styleEl(cs.doc).textContent, "/* example.com · A */\nh1 { color: red }", "a paused override takes its import with it");
});
