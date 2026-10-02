// Test runner: bundle the TS tests with esbuild (aliasing `vscode` to the
// in-memory mock), then run everything — bundled TS + plain .mjs tests —
// under node's built-in test runner. Zero extra dependencies.
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readdirSync, mkdirSync, rmSync } from "node:fs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const testsDir = join(root, "tests");
const outDir = join(root, ".test-dist");

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const vscodeMock = {
  name: "vscode-mock",
  setup(b) {
    b.onResolve({ filter: /^vscode$/ }, () => ({
      path: join(testsDir, "mocks", "vscode.ts"),
    }));
  },
};

const tsTests = readdirSync(testsDir).filter((f) => f.endsWith(".test.ts"));
await build({
  entryPoints: tsTests.map((f) => join(testsDir, f)),
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  outdir: outDir,
  sourcemap: "inline",
  plugins: [vscodeMock],
  logLevel: "warning",
});

const mjsTests = readdirSync(testsDir)
  .filter((f) => f.endsWith(".test.mjs"))
  .map((f) => join(testsDir, f));
const builtTests = readdirSync(outDir)
  .filter((f) => f.endsWith(".test.js"))
  .map((f) => join(outDir, f));

const res = spawnSync(process.execPath, ["--test", ...builtTests, ...mjsTests], {
  stdio: "inherit",
});
process.exit(res.status ?? 1);
