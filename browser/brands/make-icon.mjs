// Make a brand's icon and avatar from the default ones by shifting their hue, and print the
// matching accent colours for the brand's JSON — so a new brand gets a consistent look without
// an image editor. Rendering happens in headless Chromium (canvas filters), nothing to install.
//
//   node browser/brands/make-icon.mjs <brand-id> <hue-degrees> [--saturate 1.1]
//
// Writes media/brands/<id>-icon.png (128×128) and media/brands/<id>-avatar.png (256×256) and
// prints the colours block to paste into browser/brands/<id>.json. Real artwork can replace the
// files any time — the JSON only points at them.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import WebSocket from "ws";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const [id, hueArg] = process.argv.slice(2);
const satIdx = process.argv.indexOf("--saturate");
const saturate = satIdx !== -1 ? Number(process.argv[satIdx + 1]) : 1;
if (!id || !/^[a-z][a-z0-9-]*$/.test(id) || !Number.isFinite(Number(hueArg))) {
  console.error("usage: node browser/brands/make-icon.mjs <brand-id> <hue-degrees> [--saturate 1.1]");
  process.exit(2);
}
const hue = Number(hueArg);

// The default brand's palette — the same shift applies to the colours and to the pixels.
const base = JSON.parse(readFileSync(join(root, "browser", "brands", "tali.json"), "utf8")).colors;

function hexToHsl(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}
function hslToHex(h, s, l) {
  h = ((h % 360) + 360) % 360;
  const f = (n) => {
    const k = (n + h / 30) % 12;
    const c = l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}
function shift(hex) {
  const [h, s, l] = hexToHsl(hex);
  return hslToHex(h + hue, Math.min(1, s * saturate), l);
}
const colors = {
  accent: shift(base.accent),
  accentLight: shift(base.accentLight),
  spark: shift(base.spark),
  action: shift(base.action),
  ink: base.ink,
  radius: base.radius,
};

// ── Headless Chromium does the pixel work ────────────────────────────────────
const bin = ["/opt/pw-browsers/chromium", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", process.env.CHROME_PATH].find((p) => p && existsSync(p));
if (!bin) {
  console.error("No Chromium found (set CHROME_PATH).");
  process.exit(1);
}
const profile = mkdtempSync(join(tmpdir(), "brand-icon-"));
const proc = spawn(bin, ["--headless=new", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
const portFile = join(profile, "DevToolsActivePort");
const deadline = Date.now() + 20000;
while (!existsSync(portFile) || !readFileSync(portFile, "utf8").includes("\n")) {
  if (Date.now() > deadline) throw new Error("Chromium did not start");
  await new Promise((r) => setTimeout(r, 100));
}
const [port, path] = readFileSync(portFile, "utf8").trim().split("\n");
const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
await new Promise((res, rej) => (ws.once("open", res), ws.once("error", rej)));
let seq = 0;
const pending = new Map();
ws.on("message", (raw) => {
  const m = JSON.parse(String(raw));
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
});
const send = (method, params, sessionId) => new Promise((resolve, reject) => {
  const mid = ++seq;
  pending.set(mid, { resolve, reject });
  ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }));
});

try {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const recolor = async (src, size) => {
    const dataUrl = "data:image/png;base64," + readFileSync(join(root, src)).toString("base64");
    const r = await send("Runtime.evaluate", {
      awaitPromise: true,
      returnByValue: true,
      expression: `(async () => {
        const img = new Image(); img.src = ${JSON.stringify(dataUrl)}; await img.decode();
        const c = document.createElement("canvas"); c.width = ${size}; c.height = ${size};
        const x = c.getContext("2d");
        x.filter = "hue-rotate(${hue}deg) saturate(${saturate})";
        x.drawImage(img, 0, 0, ${size}, ${size});
        return c.toDataURL("image/png");
      })()`,
    }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return Buffer.from(r.result.value.split(",")[1], "base64");
  };
  mkdirSync(join(root, "media", "brands"), { recursive: true });
  const iconOut = join("media", "brands", `${id}-icon.png`);
  const avatarOut = join("media", "brands", `${id}-avatar.png`);
  writeFileSync(join(root, iconOut), await recolor("media/icon.png", 128));
  writeFileSync(join(root, avatarOut), await recolor("media/avatar.png", 256));
  console.log(`wrote ${iconOut} and ${avatarOut} (hue ${hue}°, saturate ${saturate})`);
  console.log(`"icon": ${JSON.stringify(iconOut)},\n"avatar": ${JSON.stringify(avatarOut)},\n"colors": ${JSON.stringify(colors, null, 2)}`);
} finally {
  try { ws.close(); } catch {}
  proc.kill("SIGKILL");
  await new Promise((r) => proc.once("exit", r));
  rmSync(profile, { recursive: true, force: true });
}
