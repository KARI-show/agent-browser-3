// Build the Agent Browser bundle into dist-browser/:
//   extension/  unpacked Chrome/Edge extension (side panel + shared webview UI)
//   host/       native messaging host (bundled host.js + register.mjs)
// With --zip, also writes dist-browser/agent-browser.zip for the release.
// The webview bundle (media/main.js) must be built first (`npm run build`).
//
// Brands (browser/brands/<id>.json, see browser/brand.mjs): the extension under another
// name, icon, skin and feature set (extras.js carries the brand's extra features). `--brand <id>` builds one into
// dist-browser/brands/<id>/extension; `--all-brands` builds every brand; without a
// flag the default brand goes to dist-browser/extension as before. Every brand build
// also writes a store upload (manifest.json at the zip root) to
// dist-browser/store/<id>-<version>.zip. The host is shared by all brands.
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import * as zlib from "node:zlib";
import { createRequire } from "node:module";
import { DEFAULT_BRAND, DEFAULT_SKIN, TOKEN_FILES, brandManifest, brandScript, extrasContentScripts, extrasScript, fillTokens, listBrands, loadBrand, toolDefsFor } from "./brand.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const out = join(root, "dist-browser");
const production = process.argv.includes("--production");
const argBrand = process.argv.indexOf("--brand");
const brandIds = process.argv.includes("--all-brands")
  ? listBrands(root)
  : [argBrand !== -1 ? process.argv[argBrand + 1] : DEFAULT_BRAND];
const brands = brandIds.map((id) => loadBrand(root, id));
const extDir = (b) => (b.id === DEFAULT_BRAND ? join(out, "extension") : join(out, "brands", b.id, "extension"));

// Clean everything except host/node_modules (the installed Agent SDK) so dev
// rebuilds don't need another npm install.
for (const b of brands) rmSync(extDir(b), { recursive: true, force: true });
rmSync(join(out, "agent-browser.zip"), { force: true });
if (existsSync(join(out, "host"))) {
  for (const f of readdirSync(join(out, "host"))) {
    if (f !== "node_modules") rmSync(join(out, "host", f), { recursive: true, force: true });
  }
}
mkdirSync(join(out, "host"), { recursive: true });
if (!existsSync(join(root, "media", "main.js"))) {
  console.error("✗ media/main.js is missing — run `npm run build` first.");
  process.exit(1);
}

// Extension, once per brand: our side-panel files + the shared UI from media/, the brand's icon and
// avatar, the {{brand.*}} tokens filled, brand.js for the runtime strings.
for (const b of brands) {
  const dir = extDir(b);
  mkdirSync(dir, { recursive: true });
  cpSync(join(here, "extension"), dir, { recursive: true });
  for (const f of ["main.js", "style.css"]) cpSync(join(root, "media", f), join(dir, f));
  cpSync(join(root, b.icon), join(dir, "icon.png"));
  cpSync(join(root, b.avatar), join(dir, "avatar.png"));
  cpSync(join(here, "skins", `${b.skin || DEFAULT_SKIN}.css`), join(dir, "skin.css")); // linked last by both pages
  for (const f of TOKEN_FILES) {
    const text = readFileSync(join(dir, f), "utf8");
    writeFileSync(join(dir, f), f === "manifest.json" ? brandManifest(text, b) : fillTokens(text, b));
  }
  writeFileSync(join(dir, "brand.js"), brandScript(b));
  writeFileSync(join(dir, "extras.js"), extrasScript(b, root)); // the runtime of the brand's extra features
  for (const cs of extrasContentScripts(b, root)) cpSync(cs.src, join(dir, cs.file)); // their content scripts, if any
  console.log(`brand ${b.id}: ${b.name} → ${relative(root, dir)}`);
}

// Built-in agent (runs inside the extension with the user's API key). Its tool
// list is generated from the same zod declarations the host uses.
const genDir = join(out, ".build");
mkdirSync(genDir, { recursive: true });
await build({
  entryPoints: [join(here, "gen-tooldefs.ts")],
  bundle: true,
  format: "cjs",
  platform: "node",
  outfile: join(genDir, "gen-tooldefs.cjs"),
  logLevel: "warning",
});
const toolDefs = createRequire(import.meta.url)(join(genDir, "gen-tooldefs.cjs")).default;
// One bundle per brand: its tool list and system prompt hold only the features the brand has.
for (const b of brands) {
  const defsFile = join(genDir, `toolDefs.${b.id}.json`);
  writeFileSync(defsFile, JSON.stringify(toolDefsFor(toolDefs, b)));
  await build({
    entryPoints: [join(here, "standalone", "entry.ts")],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    outfile: join(extDir(b), "agentLocal.js"),
    alias: { "toolDefs.json": defsFile },
    // Address of the free-trial gateway (trial-server/); empty = this build has no free trial.
    define: { __TRIAL_URL__: JSON.stringify((process.env.AGENT_TRIAL_URL || "").replace(/\/+$/, "")) },
    minify: production,
    sourcemap: false,
    logLevel: "warning",
  });
}
rmSync(genDir, { recursive: true, force: true });

// Host: one CJS file; the Agent SDK stays external (ESM + per-platform
// binary), installed next to it from the generated package.json.
await build({
  entryPoints: [join(here, "host", "host.ts")],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  outfile: join(out, "host", "host.js"),
  external: ["@anthropic-ai/claude-agent-sdk"],
  alias: { vscode: join(here, "host", "vscode-stub.ts") },
  minify: production,
  sourcemap: production ? false : "inline",
  logLevel: "info",
});
cpSync(join(here, "host", "register.mjs"), join(out, "host", "register.mjs"));

// Remote access without VS Code ("helper" mode, browser/host/remote.ts): the host
// runs the same relay, Telegram bot and web app as VS Code's Remote command.
// relay/public/app.html + main.js come from `npm run build` (relay/build-app.mjs).
const relayOut = join(out, "host", "relay");
mkdirSync(relayOut, { recursive: true });
for (const f of ["hub.mjs", "validate.mjs", "bot.mjs"]) cpSync(join(root, "relay", f), join(relayOut, f));
cpSync(join(root, "relay", "public"), join(relayOut, "public"), {
  recursive: true,
  filter: (src) => !src.endsWith(".map"),
});
if (!existsSync(join(relayOut, "public", "app.html"))) {
  console.warn("⚠ relay/public/app.html is missing — run `npm run build` first, or the helper's web app won't load.");
}

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
writeFileSync(
  join(out, "host", "package.json"),
  JSON.stringify(
    {
      name: "agent-browser-host",
      version: pkg.version,
      private: true,
      dependencies: {
        "@anthropic-ai/claude-agent-sdk": pkg.dependencies["@anthropic-ai/claude-agent-sdk"],
        ws: pkg.dependencies.ws, // relay/hub.mjs + relay/bot.mjs
      },
    },
    null,
    2
  ) + "\n"
);

if (process.argv.includes("--zip")) {
  // The installer's bundle (extension + host) — the default brand only.
  if (brands.some((b) => b.id === DEFAULT_BRAND)) {
    writeFileSync(join(out, "agent-browser.zip"), zip(out, ["extension", "host"]));
    console.log("wrote dist-browser/agent-browser.zip");
  }
}
// A store upload per brand: the extension's files at the zip root, no host.
mkdirSync(join(out, "store"), { recursive: true });
for (const b of brands) {
  const version = JSON.parse(readFileSync(join(extDir(b), "manifest.json"), "utf8")).version;
  const file = join(out, "store", `${b.id}-${version}.zip`);
  writeFileSync(file, zip(extDir(b), ["."]));
  console.log(`wrote ${relative(root, file)}`);
}

// zlib.crc32 needs Node ≥ 20.15; table fallback for older runtimes.
function crc32(buf) {
  if (zlib.crc32) return zlib.crc32(buf);
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

// Minimal zip writer (deflate, no zip64) — keeps the build zero-dependency.
function zip(base, dirs) {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      if (name === "node_modules") continue; // installed on the user's machine
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else files.push(p);
    }
  };
  dirs.forEach((d) => walk(join(base, d)));

  const local = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(relative(base, file).split("\\").join("/"));
    const data = readFileSync(file);
    const packed = zlib.deflateRawSync(data);
    const crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4); // version needed
    head.writeUInt16LE(0x0800, 6); // UTF-8 names
    head.writeUInt16LE(8, 8); // deflate
    head.writeUInt32LE(0x00210000, 10); // 1980-01-01 00:00 — reproducible
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(packed.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(name.length, 26);
    local.push(head, name, packed);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(8, 10);
    cen.writeUInt32LE(0x00210000, 12);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(packed.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, name);
    offset += head.length + name.length + packed.length;
  }
  const cenSize = central.reduce((s, b) => s + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cenSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}
