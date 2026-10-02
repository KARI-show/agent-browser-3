#!/usr/bin/env node
// Register (or with --uninstall, remove) the Agent Browser native messaging
// host for Chrome, Edge, Brave and Chromium for the current user. Run from the
// installed host folder: `node register.mjs`. Chrome only launches hosts it
// finds through this manifest, and only for the extension id it allows.
import { writeFileSync, mkdirSync, rmSync, chmodSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const NAME = "com.kari.agent_browser";
// Fixed by the "key" in extension/manifest.json (unpacked installs keep it).
const EXTENSION_ID = "ppakaagcjnojicbdebhgkpjgikclbnlf";
const hostDir = dirname(fileURLToPath(import.meta.url));
const uninstall = process.argv.includes("--uninstall");
const isWin = process.platform === "win32";

function manifestDirs() {
  const home = homedir();
  if (process.platform === "darwin") {
    const base = join(home, "Library", "Application Support");
    return ["Google/Chrome", "Chromium", "Microsoft Edge", "BraveSoftware/Brave-Browser"].map((b) =>
      join(base, b, "NativeMessagingHosts")
    );
  }
  const base = join(home, ".config");
  return ["google-chrome", "chromium", "microsoft-edge", "BraveSoftware/Brave-Browser"].map((b) =>
    join(base, b, "NativeMessagingHosts")
  );
}

const WIN_KEYS = [
  "Software\\Google\\Chrome",
  "Software\\Chromium",
  "Software\\Microsoft\\Edge",
  "Software\\BraveSoftware\\Brave-Browser",
].map((k) => `HKCU\\${k}\\NativeMessagingHosts\\${NAME}`);

if (uninstall) {
  if (isWin) {
    for (const key of WIN_KEYS) {
      try {
        execFileSync("reg", ["delete", key, "/f"], { stdio: "ignore" });
      } catch {
        /* not registered for this browser */
      }
    }
  } else {
    for (const dir of manifestDirs()) rmSync(join(dir, `${NAME}.json`), { force: true });
  }
  console.log("Agent Browser host unregistered.");
  process.exit(0);
}

// Chrome starts the host with a minimal environment, so pin the absolute node
// path that runs this script instead of trusting PATH.
const launcher = join(hostDir, isWin ? "agent-browser-host.cmd" : "agent-browser-host.sh");
if (isWin) {
  writeFileSync(launcher, `@echo off\r\n"${process.execPath}" "%~dp0host.js" %*\r\n`);
} else {
  writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/host.js" "$@"\n`);
  chmodSync(launcher, 0o755);
}

const manifest = JSON.stringify(
  {
    name: NAME,
    description: "Agent Browser — runs the Claude agent for the browser side panel",
    path: launcher,
    type: "stdio",
    allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
  },
  null,
  2
);

if (isWin) {
  const file = join(hostDir, `${NAME}.json`);
  writeFileSync(file, manifest);
  for (const key of WIN_KEYS) {
    execFileSync("reg", ["add", key, "/ve", "/t", "REG_SZ", "/d", file, "/f"], { stdio: "ignore" });
  }
} else {
  for (const dir of manifestDirs()) {
    // Only browsers that exist on this machine (their profile dir is present).
    if (!existsSync(dirname(dir))) continue;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${NAME}.json`), manifest);
  }
}
console.log(`Agent Browser host registered (${launcher}).`);
