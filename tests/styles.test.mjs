// Site styles (browser/extras/styles.js and its content script browser/extras/styles.cs.js) against fakes
// of chrome.storage / tabs / scripting and the tool registry: the pure helpers (hosts, the cascade,
// CSS validation), browser_style_apply / list / remove / inspect, the 🎨 tab, the content-script
// registration — and the content script itself against a fake document: what it injects for a host
// and for "*", what it ignores, how it follows storage changes and keeps its element last in <head>.
// The page-side functions run for real in tests/e2e/extras-palette.e2e.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeCtx, fakeDom, loadContentScript, loadExtras, plain, runTool, settle, styleEl } from "./mocks/extras-palette.mjs";

// Values made inside the vm have another realm's prototypes: deepEqual needs plain copies.

const load = (opts) => loadExtras({ ids: ["styles"], features: { styles: true }, ...(opts || {}) });
const stored = (data) => data.agentSiteStyles || {};

test("loads only for a brand with the feature; registers four tools, the 🎨 tab, three Design commands and the content script once", async () => {
  const off = load({ features: { styles: false, palette: true } });
  assert.deepEqual(off.T.names, []);
  assert.deepEqual(off.tabs, []);
  assert.equal(off.S, undefined);

  const { T, tabs, commands, S, scripting } = load();
  assert.deepEqual(T.names, ["browser_style_inspect", "browser_style_apply", "browser_style_list", "browser_style_remove"]);
  assert.equal(tabs[0].label, "🎨 Styles");
  assert.deepEqual(plain(tabs[0].storageKeys), ["agentSiteStyles"]);
  assert.deepEqual(commands.map((c) => [c.group, c.name, !!c.partial]), [
    ["Design", "Make this page easier to read", false], ["Design", "Hide the distractions on this page", false], ["Design", "Show this site's style overrides", false],
  ]);
  for (const c of commands.slice(0, 2)) { assert.match(c.prompt, /browser_style_inspect/); assert.match(c.prompt, /browser_style_apply/); assert.match(c.prompt, /consent/i); }
  assert.match(commands[2].prompt, /browser_style_list/);
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
