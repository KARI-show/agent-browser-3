// Brands (browser/brand.mjs + browser/brands/*.json): every brand is complete and distinct, the
// tokens in the extension's source are all filled by a brand, the manifest stays valid, and the
// default brand reproduces today's strings.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { ALL_FEATURES, DEFAULT_BRAND, FEATURES, FEATURE_PERMISSIONS, OPT_IN_FEATURES, TOKEN_FILES, brandManifest, brandScript, extrasScript, featuresOf, fillTokens, listBrands, loadBrand, optInOf, toolDefsFor, validateBrand } from "../browser/brand.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ext = (f) => fs.readFileSync(path.join(root, "browser", "extension", f), "utf8");

test("every brand file loads, is complete, and names/ids/icons are distinct", () => {
  const ids = listBrands(root);
  assert.ok(ids.includes(DEFAULT_BRAND));
  assert.ok(ids.length >= 5, "five brands are configured");
  const brands = ids.map((id) => loadBrand(root, id));
  const uniq = (k) => new Set(brands.map((b) => (typeof k === "function" ? k(b) : b[k]))).size;
  assert.equal(uniq("name"), brands.length, "store names differ");
  assert.equal(uniq("shortName"), brands.length, "assistant names differ");
  assert.equal(uniq("icon"), brands.length, "each brand has its own icon");
  assert.equal(uniq((b) => b.colors.accent), brands.length, "accent colours differ");
  for (const b of brands) {
    for (const k of ["icon", "avatar"]) {
      const png = fs.readFileSync(path.join(root, b[k]));
      assert.equal(png.readUInt32BE(0), 0x89504e47, `${b.id} ${k} is a PNG`);
      assert.equal(png.readUInt32BE(16), k === "icon" ? 128 : 256, `${b.id} ${k} width`);
    }
    // Only one brand may pin the extension id: two listings with one key would be the same extension.
    if (b.id !== DEFAULT_BRAND) assert.equal(b.key, undefined, `${b.id} must not carry the default brand's key`);
  }
});

test("features: a brand without a feature loses its permissions, tools and prompt sections; the default has everything", () => {
  const tali = loadBrand(root, DEFAULT_BRAND);
  assert.deepEqual(featuresOf(tali), Object.fromEntries([...FEATURES.map((f) => [f, true]), ...OPT_IN_FEATURES.map((f) => [f, false])]), "the published brand keeps every base feature and has no extras");
  const full = JSON.parse(brandManifest(ext("manifest.json"), tali));
  for (const perms of Object.values(FEATURE_PERMISSIONS)) for (const p of perms) assert.ok(full.permissions.includes(p), `${p} in the full manifest`);

  const lite = { ...tali, id: "lite", features: { watchers: false, proxy: false, helper: false, cookies: false, converter: false, profiles: false } };
  delete lite.key;
  const m = JSON.parse(brandManifest(ext("manifest.json"), lite));
  for (const p of ["alarms", "notifications", "proxy", "webRequest", "webRequestAuthProvider", "privacy", "nativeMessaging", "cookies", "downloads", "downloads.open"]) {
    assert.ok(!m.permissions.includes(p), `${p} dropped`);
  }
  for (const p of ["sidePanel", "tabs", "scripting", "storage", "debugger", "unlimitedStorage"]) assert.ok(m.permissions.includes(p), `${p} stays (core)`);

  // Tool definitions as gen-tooldefs produces them: tagged tools and prompt sections.
  const defs = {
    sections: [{ text: "# Agent" }, { feature: "watchers", text: "## Watchers\n- watch" }, { feature: "cookies", text: "## Cookies" }, { text: "## Safety" }],
    tools: [
      { name: "browser_read_page", readOnly: true, description: "r", input_schema: {} },
      { name: "browser_watch_create", feature: "watchers", readOnly: false, description: "w", input_schema: {} },
      { name: "browser_cookies_get", feature: "cookies", readOnly: false, alwaysAsk: true, description: "c", input_schema: {} },
      { name: "browser_recipe_save", feature: "recipes", readOnly: false, description: "s", input_schema: {} },
    ],
  };
  const cut = toolDefsFor(defs, lite);
  assert.deepEqual(cut.tools.map((t) => t.name), ["browser_read_page", "browser_recipe_save"]);
  assert.ok(cut.tools.every((t) => !("feature" in t)), "the tag is build-time only");
  assert.equal(cut.system, "# Agent\n\n## Safety");
  const all = toolDefsFor(defs, tali);
  assert.equal(all.tools.length, 4);
  assert.match(all.system, /## Watchers\n- watch\n\n## Cookies/);

  const script = brandScript(lite);
  assert.match(script, /"watchers": false/);
  assert.match(script, /"recipes": true/);
  assert.match(script, /AGENT_BRAND\.has = function/);
  assert.match(brandScript(tali), /"skin": "default"/);
  assert.deepEqual(validateBrand({ ...tali, features: { nope: true, watchers: "no" } }, root), ["features.nope: unknown feature (" + ALL_FEATURES.join(", ") + ")", "features.watchers must be true or false"]);
});

test("extras: an opt-in feature is off unless a brand switches it on; its tools, prompt, runtime and dependencies follow", () => {
  const tali = loadBrand(root, DEFAULT_BRAND);
  assert.deepEqual(optInOf(tali), [], "Tali has no extras");
  const orbit = { ...tali, id: "orbit2", features: { clips: true, sessions: true } };
  delete orbit.key;
  assert.deepEqual(optInOf(orbit), ["clips", "sessions"]);
  assert.equal(featuresOf(orbit).clips, true);
  assert.equal(featuresOf(orbit).watchers, true, "base features stay on");
  // The manifest is the same: extras own no permissions.
  assert.deepEqual(JSON.parse(brandManifest(ext("manifest.json"), orbit)).permissions, JSON.parse(brandManifest(ext("manifest.json"), tali)).permissions);
  // Tool definitions: an extra's tools and section reach only the brands that have it.
  const defs = {
    sections: [{ text: "# Agent" }, { feature: "clips", text: "## Clips\n- clip" }, { text: "## Safety" }],
    tools: [
      { name: "browser_read_page", readOnly: true, description: "r", input_schema: {} },
      { name: "browser_clip_save", feature: "clips", readOnly: false, description: "c", input_schema: {} },
    ],
  };
  assert.deepEqual(toolDefsFor(defs, tali).tools.map((t) => t.name), ["browser_read_page"]);
  assert.equal(toolDefsFor(defs, tali).system, "# Agent\n\n## Safety");
  assert.deepEqual(toolDefsFor(defs, orbit).tools.map((t) => t.name), ["browser_read_page", "browser_clip_save"]);
  assert.match(toolDefsFor(defs, orbit).system, /## Clips\n- clip\n\n## Safety/);
  // The runtime flag and the built extras.js.
  const ctx = {};
  vm.runInNewContext(brandScript(orbit), ctx);
  assert.equal(ctx.AGENT_BRAND.has("clips"), true);
  assert.equal(ctx.AGENT_BRAND.has("audit"), false);
  assert.equal(ctx.AGENT_BRAND.has("recipes"), true);
  assert.match(extrasScript(tali, root), /^\/\/ Generated[^\n]*\n\/\/ This brand has no extra features\.\n$/);
  const js = extrasScript(orbit, root);
  assert.ok(js.indexOf("── clips (browser/extras/clips.js)") < js.indexOf("── sessions (browser/extras/sessions.js)"), "modules in OPT_IN_FEATURES order");
  assert.ok(js.includes(fs.readFileSync(path.join(root, "browser", "extras", "clips.js"), "utf8")), "the module's source is carried whole");
  for (const id of OPT_IN_FEATURES) assert.ok(fs.existsSync(path.join(root, "browser", "extras", `${id}.js`)) && fs.existsSync(path.join(root, "browser", "host", "extras", `${id}.ts`)), `${id} has both halves`);
  // An extra that builds on a base feature needs it.
  assert.deepEqual(validateBrand({ ...tali, features: { cookies: false, accounts: true } }, root), ["features.accounts needs cookies, which this brand switches off"]);
  assert.deepEqual(validateBrand({ ...tali, features: { watchers: false, uptime: true } }, root), ["features.uptime needs watchers, which this brand switches off"]);
  assert.deepEqual(validateBrand({ ...tali, features: { accounts: true, uptime: true } }, root), []);
});

test("validateBrand: the reasons a brand is refused", () => {
  const ok = loadBrand(root, DEFAULT_BRAND);
  assert.deepEqual(validateBrand(ok, root), []);
  const bad = { ...ok, id: "Bad Id", name: "x".repeat(80), description: "d".repeat(140), colors: { ...ok.colors, accent: "blue" }, icon: "media/nope.png" };
  const problems = validateBrand(bad, root);
  for (const re of [/"id" must be lower-case/, /"name" is over/, /"description" is over 132/, /colors\.accent must be/, /media\/nope\.png does not exist/]) {
    assert.ok(problems.some((p) => re.test(p)), `${re} in ${problems.join(" | ")}`);
  }
  assert.throws(() => loadBrand(root, "no-such-brand"), /Unknown brand "no-such-brand"/);
});

test("fillTokens: every {{brand.*}} in the source files has a value; an unknown token is an error", () => {
  const brand = loadBrand(root, DEFAULT_BRAND);
  for (const f of TOKEN_FILES) {
    const src = ext(f);
    assert.match(src, /\{\{\s*brand\./, `${f} carries brand tokens`);
    const filled = f === "manifest.json" ? brandManifest(src, brand) : fillTokens(src, brand);
    assert.doesNotMatch(filled, /\{\{\s*brand\./, `${f}: no token left`);
  }
  assert.throws(() => fillTokens("{{brand.nothing.here}}", brand), /No value for \{\{brand\.nothing\.here\}\}/);
  // Nothing else in the extension carries a token the build would miss.
  for (const f of fs.readdirSync(path.join(root, "browser", "extension"))) {
    if (TOKEN_FILES.includes(f)) continue;
    assert.doesNotMatch(ext(f), /\{\{\s*brand\./, `${f} has a token outside TOKEN_FILES`);
  }
});

test("the default brand reproduces the published strings; another brand replaces them everywhere", () => {
  const tali = loadBrand(root, DEFAULT_BRAND);
  const m = JSON.parse(brandManifest(ext("manifest.json"), tali));
  assert.equal(m.name, "Tali — AI Browser Agent");
  assert.equal(m.action.default_title, "Tali — AI Browser Agent");
  assert.ok(m.key && m.key.startsWith("MIIB"), "the default brand keeps the fixed id for unpacked installs");
  assert.match(fillTokens(ext("sidepanel.html"), tali), /<span class="bar-title">Tali · Browser<\/span>/);
  assert.match(fillTokens(ext("sidepanel.html"), tali), /data-assistant="Tali"/);
  assert.match(fillTokens(ext("theme.css"), tali), /--brand-accent: #25b6ff;/);

  const other = { ...tali, id: "zed", name: "Zed — Browser Copilot", shortName: "Zed", tagline: "Browser Copilot", subtitle: "Sub", description: "Desc", colors: { ...tali.colors, accent: "#ff00aa" } };
  delete other.key;
  const om = JSON.parse(brandManifest(ext("manifest.json"), other));
  assert.equal(om.name, "Zed — Browser Copilot");
  assert.equal(om.description, "Desc");
  assert.equal(om.key, undefined, "no key → the store assigns the id");
  assert.deepEqual(om.permissions, m.permissions, "only the branding differs");
  const html = fillTokens(ext("options.html"), other);
  assert.match(html, /<title>Zed — settings<\/title>/);
  assert.match(html, /Zed <span>&middot; Browser Copilot<\/span>/);
  assert.doesNotMatch(html, /Tali/, "no trace of the default brand in another brand's page");
  assert.doesNotMatch(fillTokens(ext("sidepanel.html"), other), /Tali/);
  assert.match(fillTokens(ext("theme.css"), other), /--brand-accent: #ff00aa;/);
  const script = brandScript(other);
  assert.match(script, /globalThis\.AGENT_BRAND = /);
  assert.doesNotMatch(script, /MIIB|media\//, "no key or file paths reach the runtime");
  const ctx = {};
  vm.runInNewContext(script, ctx);
  assert.equal(ctx.AGENT_BRAND.shortName, "Zed");
  assert.equal(ctx.AGENT_BRAND.has("watchers"), true, "every base feature on unless switched off");
  assert.equal(ctx.AGENT_BRAND.has("clips"), false, "no extra unless switched on");
});
