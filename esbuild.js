const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** @type {import('esbuild').BuildOptions} */
const extensionCfg = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  outfile: "dist/extension.js",
  sourcemap: !production,
  minify: production,
  external: ["vscode", "@anthropic-ai/claude-agent-sdk"],
  logLevel: "info",
};

/** @type {import('esbuild').BuildOptions} */
const webviewCfg = {
  entryPoints: ["src/webview/main.ts"],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2020",
  outfile: "media/main.js",
  sourcemap: !production,
  minify: production,
  logLevel: "info",
};

async function main() {
  const ctxs = await Promise.all([
    esbuild.context(extensionCfg),
    esbuild.context(webviewCfg),
  ]);
  if (watch) {
    await Promise.all(ctxs.map((c) => c.watch()));
  } else {
    await Promise.all(ctxs.map((c) => c.rebuild()));
    await Promise.all(ctxs.map((c) => c.dispose()));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
