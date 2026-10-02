// Build the Agent Browser bundle into dist-browser/:
//   extension/  unpacked Chrome/Edge extension (side panel + shared webview UI)
//   host/       native messaging host (bundled host.js + register.mjs)
// With --zip, also writes dist-browser/agent-browser.zip for the release.
// The webview bundle (media/main.js) must be built first (`npm run build`).
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import * as zlib from "node:zlib";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const out = join(root, "dist-browser");
const production = process.argv.includes("--production");

// Clean everything except host/node_modules (the installed Agent SDK) so dev
// rebuilds don't need another npm install.
rmSync(join(out, "extension"), { recursive: true, force: true });
rmSync(join(out, "agent-browser.zip"), { force: true });
if (existsSync(join(out, "host"))) {
  for (const f of readdirSync(join(out, "host"))) {
    if (f !== "node_modules") rmSync(join(out, "host", f), { recursive: true, force: true });
  }
}
mkdirSync(join(out, "extension"), { recursive: true });
mkdirSync(join(out, "host"), { recursive: true });

// Extension: our side-panel files + the shared UI from media/.
cpSync(join(here, "extension"), join(out, "extension"), { recursive: true });
if (!existsSync(join(root, "media", "icon.png"))) {
  // The manifest names it: without it Chrome refuses to load the extension at all.
  console.error("✗ media/icon.png is missing — the extension can't load without its icon. Put the 128×128 icon there.");
  process.exit(1);
}
for (const f of ["main.js", "style.css", "icon.png"]) {
  cpSync(join(root, "media", f), join(out, "extension", f));
}
// Optional, like in the VS Code panel and the web app: without it the header shows the name instead.
if (existsSync(join(root, "media", "avatar.png"))) cpSync(join(root, "media", "avatar.png"), join(out, "extension", "avatar.png"));

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
writeFileSync(join(genDir, "toolDefs.json"), JSON.stringify(toolDefs));
await build({
  entryPoints: [join(here, "standalone", "entry.ts")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  outfile: join(out, "extension", "agentLocal.js"),
  alias: { "toolDefs.json": join(genDir, "toolDefs.json") },
  // Address of the free-trial gateway (trial-server/); empty = this build has no free trial.
  define: { __TRIAL_URL__: JSON.stringify((process.env.AGENT_TRIAL_URL || "").replace(/\/+$/, "")) },
  minify: production,
  sourcemap: false,
  logLevel: "info",
});
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
  writeFileSync(join(out, "agent-browser.zip"), zip(out, ["extension", "host"]));
  console.log("wrote dist-browser/agent-browser.zip");
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
