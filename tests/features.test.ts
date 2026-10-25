// The feature lists of the TypeScript side (browser/host/features.ts) and the build (browser/brand.mjs)
// are one contract: same names, same opt-in semantics, and every extra (browser/host/extras/<id>.ts)
// keeps to its tool-name prefix so the brand e2e can tell a tool's feature from its name.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { BASE_FEATURES, OPT_IN_FEATURES, hasFeature } from "../browser/host/features";
import { BROWSER_TOOLS, BASE_TOOLS, PROMPT_SECTIONS, systemPromptFor, toolsFor } from "../browser/host/tools";
import { EXTRAS } from "../browser/host/extras/index";
import * as brand from "../browser/brand.mjs";

/** Tool-name prefix per extra: tests/e2e/brands.e2e.mjs maps names to features with the same table. */
export const EXTRA_TOOL_PREFIX: Record<string, RegExp> = {
  clips: /^browser_clip_/,
  sessions: /^browser_session_/,
  rewrite: /^browser_selection_/,
  snippets: /^browser_snippet_/,
  checks: /^browser_check_/,
  uptime: /^browser_uptime_/,
  accounts: /^browser_account_/,
  audit: /^browser_identity_/,
  styles: /^browser_style_/,
  palette: /^browser_palette_/,
  elements: /^browser_element_/,
  overlay: /^browser_overlay_/,
};

test("features.ts and brand.mjs list the same features, and the extras module covers every opt-in feature once", () => {
  assert.deepEqual([...BASE_FEATURES], brand.FEATURES);
  assert.deepEqual([...OPT_IN_FEATURES], brand.OPT_IN_FEATURES);
  assert.deepEqual(EXTRAS.map((e) => e.id), [...OPT_IN_FEATURES], "one module per opt-in feature, in order");
  assert.deepEqual(Object.keys(EXTRA_TOOL_PREFIX), [...OPT_IN_FEATURES]);
});

test("opt-in semantics: a base feature is on unless switched off, an extra only when switched on", () => {
  assert.equal(hasFeature(undefined, "watchers"), true);
  assert.equal(hasFeature({ watchers: false }, "watchers"), false);
  assert.equal(hasFeature(undefined, "clips"), false);
  assert.equal(hasFeature({}, "clips"), false);
  assert.equal(hasFeature({ clips: true }, "clips"), true);
  // The default tool set and prompt (VS Code, a host without a brand) carry no extra.
  for (const t of toolsFor()) assert.ok(!t.feature || !OPT_IN_FEATURES.includes(t.feature as any), `${t.name} is an extra's tool`);
  assert.deepEqual(toolsFor().map((t) => t.name), BASE_TOOLS.map((t) => t.name));
  for (const e of EXTRAS) if (e.prompt.trim()) assert.ok(!systemPromptFor().includes(e.prompt.trim()), `${e.id}'s prompt section leaks into the default prompt`);
});

test("every extra's tools carry its feature, keep to its name prefix, and are declared only to builds that have it", () => {
  const names = BROWSER_TOOLS.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, "tool names are unique across the base set and the extras");
  for (const e of EXTRAS) {
    for (const t of e.tools) {
      assert.match(t.name, EXTRA_TOOL_PREFIX[e.id], `${e.id}: ${t.name}`);
      assert.ok(BROWSER_TOOLS.some((b) => b.name === t.name && b.feature === e.id), `${t.name} is in BROWSER_TOOLS under ${e.id}`);
      assert.equal(typeof t.description, "string");
      assert.ok(t.description.length > 20, `${t.name} needs a real description`);
    }
    const on = toolsFor({ [e.id]: true }).filter((t) => t.feature === e.id).map((t) => t.name);
    assert.deepEqual(on, e.tools.map((t) => t.name), `${e.id}: switched on → its tools`);
    assert.deepEqual(toolsFor({ [e.id]: false }).filter((t) => t.feature === e.id), [], `${e.id}: switched off → none`);
    if (e.prompt.trim()) {
      assert.match(e.prompt.trim(), /^## /, `${e.id}: the prompt section starts with a heading`);
      assert.ok(systemPromptFor({ [e.id]: true }).includes(e.prompt.trim()), `${e.id}: the section is in the prompt when on`);
      const sections = PROMPT_SECTIONS.map((s) => s.text);
      assert.ok(sections.indexOf(e.prompt) < sections.findIndex((s) => s.startsWith("## Safety")), `${e.id}: the section comes before Safety`);
    }
  }
  // No base tool wears an extra's prefix (the e2e would attribute it to the wrong feature).
  for (const t of BASE_TOOLS) for (const [id, re] of Object.entries(EXTRA_TOOL_PREFIX)) assert.ok(!re.test(t.name), `${t.name} looks like a ${id} tool`);
});

test("every brand's tool list fits the free-trial gateway's cap on tools per request", () => {
  // Bundled into .test-dist/, one level below the repo root.
  const root = path.join(__dirname, "..");
  const cap = Number(/const MAX_TOOLS = (\d+)/.exec(fs.readFileSync(path.join(root, "trial-server", "handler.mjs"), "utf8"))![1]);
  assert.ok(cap > 0);
  for (const id of brand.listBrands(root)) {
    const n = toolsFor(brand.featuresOf(brand.loadBrand(root, id))).length;
    assert.ok(n <= cap, `${id} declares ${n} tools; the gateway takes at most ${cap} — a brand with that many extras can't use the free trial`);
  }
});
