// Brands: one extension, several names. A brand is a JSON file in browser/brands/
// (name, short name, tagline, colours, icon, avatar, optional extension key). The
// build fills the {{brand.*}} tokens in manifest.json, sidepanel.html, options.html
// and theme.css, copies the brand's icon and avatar, and writes brand.js so the
// runtime code (notifications, the relay node name, the Telegram greeting, the
// assistant's name) reads the same values. Pure functions here; build.mjs does
// the file I/O. Everything else — host, tools, protocol — is identical across brands.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

export const DEFAULT_BRAND = "tali";
export const DEFAULT_SKIN = "default";
const TOKEN = /\{\{\s*brand\.([\w.]+)\s*\}\}/g;
const MANIFEST_DESCRIPTION_MAX = 132; // the Web Store's limit

/**
 * Features (browser/host/features.ts keeps the same lists for the TypeScript side; a test holds them
 * equal). Base features are on unless a brand lists one as `"features": { "watchers": false }`; the
 * opt-in extras (browser/host/extras/, browser/extras/) are off unless a brand lists one as
 * `"features": { "clips": true }`. Each base feature also owns manifest permissions, which a build
 * without the feature drops — so the builds differ in what they can do, not only in their name.
 */
export const FEATURES = ["helper", "remote", "recipes", "watchers", "memory", "profiles", "cookies", "converter", "network", "proxy"];
export const OPT_IN_FEATURES = ["clips", "sessions", "rewrite", "snippets", "checks", "uptime", "accounts", "audit"];
export const ALL_FEATURES = [...FEATURES, ...OPT_IN_FEATURES];
export const FEATURE_PERMISSIONS = {
  helper: ["nativeMessaging"],
  watchers: ["alarms", "notifications"],
  proxy: ["proxy", "webRequest", "webRequestAuthProvider", "privacy"],
  cookies: ["cookies"],
  converter: ["downloads", "downloads.open"],
};
/** An extra that builds on a base feature needs it in the same brand. */
export const FEATURE_REQUIRES = {
  accounts: ["cookies"],
  uptime: ["watchers"],
};

/** The brand's feature switches, every feature present (base: true unless switched off; extras: true only when switched on). */
export function featuresOf(brand) {
  const out = {};
  for (const f of FEATURES) out[f] = !(brand.features && brand.features[f] === false);
  for (const f of OPT_IN_FEATURES) out[f] = !!(brand.features && brand.features[f] === true);
  return out;
}
export function hasFeature(brand, f) {
  return featuresOf(brand)[f];
}
/** The extras this brand switches on, in OPT_IN_FEATURES order. */
export function optInOf(brand) {
  const features = featuresOf(brand);
  return OPT_IN_FEATURES.filter((f) => features[f]);
}

export function listBrands(root) {
  const dir = join(root, "browser", "brands");
  return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => basename(f, ".json")).sort();
}

export function loadBrand(root, id) {
  const file = join(root, "browser", "brands", `${id}.json`);
  if (!existsSync(file)) throw new Error(`Unknown brand "${id}" — expected ${file}. Brands: ${listBrands(root).join(", ")}`);
  const brand = JSON.parse(readFileSync(file, "utf8"));
  if (brand.id !== id) throw new Error(`${file}: "id" must be "${id}"`);
  const problems = validateBrand(brand, root);
  if (problems.length) throw new Error(`${file}:\n  ${problems.join("\n  ")}`);
  return brand;
}

/** What a brand must have for the build to produce a loadable extension. */
export function validateBrand(b, root) {
  const p = [];
  const str = (k) => typeof b[k] === "string" && b[k].trim();
  for (const k of ["id", "name", "shortName", "tagline", "subtitle", "description", "icon", "avatar"]) if (!str(k)) p.push(`"${k}" is required`);
  if (str("id") && !/^[a-z][a-z0-9-]*$/.test(b.id)) p.push(`"id" must be lower-case letters, digits and dashes`);
  if (str("name") && b.name.length > 75) p.push(`"name" is over the Web Store's 75 characters`);
  if (str("description") && b.description.length > MANIFEST_DESCRIPTION_MAX) p.push(`"description" is over ${MANIFEST_DESCRIPTION_MAX} characters (${b.description.length})`);
  if (!b.colors || typeof b.colors !== "object") p.push(`"colors" is required`);
  else for (const k of ["accent", "accentLight", "spark", "action", "ink"]) if (!/^#[0-9a-f]{6}$/i.test(b.colors[k] || "")) p.push(`colors.${k} must be a #rrggbb colour`);
  if (b.colors && !/^\d+px$/.test(b.colors.radius || "")) p.push(`colors.radius must be like "10px"`);
  if (b.key !== undefined && !/^[A-Za-z0-9+/=]{300,}$/.test(String(b.key))) p.push(`"key" doesn't look like an extension public key`);
  if (b.skin !== undefined && !/^[a-z][a-z0-9-]*$/.test(String(b.skin))) p.push(`"skin" must be a file name like "glass" (browser/skins/glass.css)`);
  if (b.features !== undefined) {
    if (!b.features || typeof b.features !== "object") p.push(`"features" must be an object of feature → boolean`);
    else {
      for (const [k, v] of Object.entries(b.features)) {
        if (!ALL_FEATURES.includes(k)) p.push(`features.${k}: unknown feature (${ALL_FEATURES.join(", ")})`);
        else if (typeof v !== "boolean") p.push(`features.${k} must be true or false`);
      }
      const on = featuresOf(b);
      for (const [extra, needs] of Object.entries(FEATURE_REQUIRES)) {
        if (on[extra]) for (const base of needs) if (!on[base]) p.push(`features.${extra} needs ${base}, which this brand switches off`);
      }
    }
  }
  if (root) {
    for (const k of ["icon", "avatar"]) {
      if (str(k) && !existsSync(join(root, b[k]))) p.push(`"${k}": ${b[k]} does not exist`);
    }
    const skin = join(root, "browser", "skins", `${b.skin || DEFAULT_SKIN}.css`);
    if (!existsSync(skin)) p.push(`"skin": ${skin} does not exist`);
  }
  return p;
}

function lookup(brand, path) {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), brand);
}

/** Replace every {{brand.x.y}} token; a token with no value is an error, not an empty string. */
export function fillTokens(text, brand) {
  return text.replace(TOKEN, (_, path) => {
    const v = lookup(brand, path);
    if (v === undefined || v === null) throw new Error(`No value for {{brand.${path}}}`);
    return String(v);
  });
}

/**
 * Fill the manifest's tokens, set its key (the brand's own, or none — the store assigns the id) and
 * drop the permissions of the features this brand leaves out.
 */
export function brandManifest(text, brand) {
  const m = JSON.parse(fillTokens(text, brand));
  if (brand.key) m.key = brand.key;
  else delete m.key;
  const features = featuresOf(brand);
  const dropped = new Set(Object.entries(FEATURE_PERMISSIONS).flatMap(([f, perms]) => (features[f] ? [] : perms)));
  m.permissions = (m.permissions || []).filter((p) => !dropped.has(p));
  return JSON.stringify(m, null, 2) + "\n";
}

/** The built-in agent's tool definitions for this brand: only the tools and prompt sections of its features. */
export function toolDefsFor(defs, brand) {
  const features = featuresOf(brand);
  const has = (f) => !f || features[f] === true;
  return {
    system: defs.sections.filter((s) => has(s.feature)).map((s) => s.text.trim()).join("\n\n"),
    tools: defs.tools.filter((t) => has(t.feature)).map(({ feature, ...t }) => t),
  };
}

/** The runtime's copy of the brand (no key, no file paths — nothing a page would need). */
export function brandScript(brand) {
  const pub = { id: brand.id, name: brand.name, shortName: brand.shortName, tagline: brand.tagline, mascot: brand.mascot || "", colors: brand.colors, skin: brand.skin || DEFAULT_SKIN, features: featuresOf(brand) };
  return "// Generated by browser/build.mjs from browser/brands/" + brand.id + ".json — do not edit.\n" +
    "globalThis.AGENT_BRAND = " + JSON.stringify(pub, null, 2) + ";\n" +
    "AGENT_BRAND.has = function (feature) { return AGENT_BRAND.features[feature] === true; };\n";
}

/**
 * The side panel's extras.js: the runtime of every extra this brand switches on (browser/extras/<id>.js),
 * concatenated in OPT_IN_FEATURES order; a comment only for a brand without extras.
 */
export function extrasScript(brand, root) {
  const ids = optInOf(brand);
  const head = "// Generated by browser/build.mjs for brand " + brand.id + " — the runtime of its extra features. Do not edit.\n";
  if (!ids.length) return head + "// This brand has no extra features.\n";
  return head + ids.map((id) => `\n// ── ${id} (browser/extras/${id}.js) ──\n` + readFileSync(join(root, "browser", "extras", `${id}.js`), "utf8")).join("\n");
}

/** Files to fill with the brand (relative to the extension dir). */
export const TOKEN_FILES = ["manifest.json", "sidepanel.html", "options.html", "theme.css"];
