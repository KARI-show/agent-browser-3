// Minimal Chrome DevTools Protocol driver for the e2e suite: launches a
// Chromium with the unpacked extension loaded and talks raw CDP over `ws`
// (already a dependency), so no Playwright/Puppeteer is needed.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";

const CANDIDATES = [
  process.env.CHROME_PATH,
  "/opt/pw-browsers/chromium",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
];

export function findChromium() {
  return CANDIDATES.find((p) => p && existsSync(p));
}

/** Chrome derives an unpacked extension's id from the manifest `key`. */
export function extensionIdFromKey(key) {
  const hex = createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Set();
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
        else p.resolve(msg.result);
      } else {
        for (const fn of this.listeners) fn(msg);
      }
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Resolve with the first event matching `pred` (or reject after `timeout`). */
  waitForEvent(pred, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error("timed out waiting for CDP event"));
      }, timeout);
      const off = this.on((m) => {
        if (!pred(m)) return;
        clearTimeout(timer);
        off();
        resolve(m);
      });
    });
  }

  async attach(targetId) {
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    return sessionId;
  }

  /** Evaluate in a session; resolves with the returned value (promises awaited). */
  async evaluate(sessionId, expression) {
    const r = await this.send(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      sessionId
    );
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error((d.exception && d.exception.description) || d.text);
    }
    return r.result.value;
  }

  async targets() {
    return (await this.send("Target.getTargets")).targetInfos;
  }

  async waitForTarget(pred, timeout = 10000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const t = (await this.targets()).find(pred);
      if (t) return t;
      await sleep(100);
    }
    throw new Error("timed out waiting for target");
  }
}

/**
 * Start Chromium (new headless) with `extensionDir` loaded. Downloads land in
 * `downloadDir` without a prompt. Returns { cdp, close }.
 */
export async function launch({ extensionDir, userDataDir, downloadDir, headless = true }) {
  const bin = findChromium();
  if (!bin) throw new Error("No Chromium found (set CHROME_PATH)");
  mkdirSync(join(userDataDir, "Default"), { recursive: true });
  writeFileSync(
    join(userDataDir, "Default", "Preferences"),
    JSON.stringify({ download: { default_directory: downloadDir, prompt_for_download: false, directory_upgrade: true } })
  );
  const args = [
    ...(headless ? ["--headless=new"] : []),
    "--no-sandbox",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    // The side panel runs as a background tab here: keep its timers accurate.
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    // No calls home (safe browsing, component updates, sync) during tests.
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--disable-default-apps",
    "--window-size=1280,900",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
    "about:blank",
  ];
  const proc = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  proc.stderr.on("data", (d) => (stderr = (stderr + d).slice(-4000)));

  const portFile = join(userDataDir, "DevToolsActivePort");
  const deadline = Date.now() + 20000;
  while (!existsSync(portFile) || !readFileSync(portFile, "utf8").includes("\n")) {
    if (proc.exitCode !== null) throw new Error(`Chromium exited early:\n${stderr}`);
    if (Date.now() > deadline) throw new Error(`Chromium did not start:\n${stderr}`);
    await sleep(100);
  }
  const [port, path] = readFileSync(portFile, "utf8").trim().split("\n");
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { perMessageDeflate: false });
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  const cdp = new Cdp(ws);
  return {
    cdp,
    // Graceful first so child processes are gone before the profile is deleted.
    async close() {
      const exited = new Promise((r) => (proc.exitCode !== null ? r() : proc.once("exit", r)));
      await Promise.race([cdp.send("Browser.close").catch(() => {}), sleep(3000)]);
      if ((await Promise.race([exited.then(() => true), sleep(5000).then(() => false)])) === false) {
        proc.kill("SIGKILL");
        await exited;
      }
      try { ws.close(); } catch (_) {}
    },
  };
}
