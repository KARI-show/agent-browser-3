// Make a brand's extension icon (128×128) and chat avatar (256×256) from a vector mark, so a new
// brand gets a clean logo with one command and no image editor. The mark is drawn as SVG in one of
// a few styles and rasterised by headless Chromium — nothing to install.
//
//   node browser/brands/make-logo.mjs <brand-id> --style <style> --bg <#hex> --fg <#hex> [--accent <#hex>] [--letter <X>] [--shape square|circle|none] [--out <dir>]
//
// Styles — each a different composition, not a recolour of another:
//   monogram  a bold letter in a rounded square with an accent dot (--letter; default: the id's initial)
//   orbit     a planet disc with a tilted ring and a small satellite in the accent colour
//   quill     a feather on a circle, the nib in the accent colour
//   beacon    a lighthouse: tapered tower with light beams in the accent colour
//   harbor    an anchor inside a shield with an accent border
//   palette   a painter's palette with a thumb hole and four paint dots derived from the accent (the
//             accent, its two hue neighbours, a tint); the avatar adds a brush loaded with the accent
//   stencil   a drafting set square with ruler ticks along its base and a pencil in the accent colour
//             crossing it; the avatar adds a faint grid
//
// --bg is the background colour, --fg the mark, --accent the secondary colour (defaults to --fg).
// --shape overrides the icon's background shape (the avatar is always a full-bleed square, which
// chat UIs crop to a circle). Writes media/brands/<id>-icon.png and media/brands/<id>-avatar.png
// (--out puts them elsewhere, e.g. for a trial render) and prints the command it was run with, so
// it can be recorded in the brand's JSON and the logo regenerated later. The icon is kept bold and
// simple to read at 16–32 px; the avatar carries more detail (shading, stripes, waves, stars).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const STYLES = ["monogram", "orbit", "quill", "beacon", "harbor", "palette", "stencil"];
const SHAPES = ["square", "circle", "none"];

// ── Arguments ────────────────────────────────────────────────────────────────
function usage(msg) {
  if (msg) console.error(msg);
  console.error(`usage: node browser/brands/make-logo.mjs <brand-id> --style <${STYLES.join("|")}> --bg <#hex> --fg <#hex> [--accent <#hex>] [--letter <X>] [--shape <${SHAPES.join("|")}>] [--out <dir>]`);
  process.exit(2);
}
const args = process.argv.slice(2);
const id = args[0];
if (!id || id.startsWith("--") || !/^[a-z][a-z0-9-]*$/.test(id)) usage("first argument must be the brand id (lowercase letters, digits, dashes)");
const opts = {};
for (let i = 1; i < args.length; i++) {
  const key = args[i];
  if (!key.startsWith("--") || args[i + 1] === undefined) usage(`unexpected argument: ${key}`);
  opts[key.slice(2)] = args[++i];
}
if (!STYLES.includes(opts.style)) usage(`--style must be one of ${STYLES.join(", ")}`);
if (opts.shape !== undefined && !SHAPES.includes(opts.shape)) usage(`--shape must be one of ${SHAPES.join(", ")}`);
function hex(name, value, fallback) {
  if (value === undefined) {
    if (fallback === undefined) usage(`--${name} is required`);
    return fallback;
  }
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (!m) usage(`--${name} must be a hex colour like #1a2b3c`);
  const h = m[1].length === 3 ? [...m[1]].map((ch) => ch + ch).join("") : m[1];
  return `#${h.toLowerCase()}`;
}
const colours = {
  bg: hex("bg", opts.bg),
  fg: hex("fg", opts.fg),
  accent: undefined,
  letter: (opts.letter ?? id[0]).slice(0, 2).toUpperCase(),
};
colours.accent = hex("accent", opts.accent, colours.fg);

// ── Colour helpers ───────────────────────────────────────────────────────────
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const toHex = (c) => "#" + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
// mix(a, b, t): the colour t of the way from a to b.
const mix = (a, b, t) => toHex(rgb(a).map((v, i) => v + (rgb(b)[i] - v) * t));
// rotate(h, deg): the colour h with its hue turned by deg degrees (same saturation and lightness).
const rotate = (h, deg) => {
  const [r, g, b] = rgb(h).map((v) => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  let hue = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    hue = (max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4) / 6;
  }
  hue = (hue + deg / 360 + 1) % 1;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const channel = (t) => ((t = (t + 1) % 1), t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p);
  return toHex([channel(hue + 1 / 3), channel(hue), channel(hue - 1 / 3)].map((v) => v * 255));
};
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const wave = (x0, y, step, n, amp) => `M${x0} ${y} q ${step / 2} ${-amp} ${step} 0` + ` t ${step} 0`.repeat(n - 1);

// ── Styles ───────────────────────────────────────────────────────────────────
// Each style draws its mark into a 100×100 box. `shape` is the icon's default background shape
// (filled with --bg); `avatarScale` shrinks the mark on the avatar so a circle crop keeps it whole;
// `avatarBg` can give the avatar a different field than --bg (the harbor shield sits on a darker one).
// draw(c, d) gets the colours and { avatar: boolean } and returns SVG markup.
const styles = {
  monogram: {
    shape: "square",
    radius: 22,
    avatarScale: 1,
    draw: (c, d) => `
      <text x="50" y="52" text-anchor="middle" dominant-baseline="central"
        font-family="'Liberation Sans', Arial, Helvetica, 'DejaVu Sans', sans-serif" font-weight="700"
        font-size="${(d.avatar ? 58 : 64) * (c.letter.length > 1 ? 0.7 : 1)}" fill="${c.fg}">${esc(c.letter)}</text>
      <circle cx="${d.avatar ? 79 : 83}" cy="${d.avatar ? 21 : 17}" r="${d.avatar ? 7 : 8}" fill="${c.accent}"/>`,
  },

  orbit: {
    shape: "square",
    radius: 28,
    avatarScale: 0.9,
    draw: (c, d) => {
      const planet = mix(c.bg, c.fg, 0.55);
      const shade = mix(c.bg, c.fg, 0.36);
      const ring = `cx="50" cy="50" rx="40" ry="9"`;
      const a = (150 * Math.PI) / 180; // where the satellite sits on the ring (front-left)
      const sx = (50 + 40 * Math.cos(a)).toFixed(1), sy = (50 + 9 * Math.sin(a)).toFixed(1);
      const field = d.avatar ? `
        <defs><radialGradient id="space" cx="50%" cy="42%" r="62%">
          <stop offset="0" stop-color="${mix(c.bg, c.fg, 0.14)}"/><stop offset="1" stop-color="${c.bg}"/>
        </radialGradient></defs>
        <rect width="100" height="100" fill="url(#space)"/>
        <g fill="${c.fg}" opacity="0.55">
          <circle cx="12" cy="20" r="1.5"/><circle cx="86" cy="12" r="1.1"/><circle cx="20" cy="84" r="1.2"/>
          <circle cx="90" cy="68" r="1.7"/><circle cx="70" cy="92" r="1"/><circle cx="6" cy="54" r="0.9"/>
          <circle cx="78" cy="30" r="0.9"/><circle cx="34" cy="8" r="1"/>
        </g>` : "";
      return `${field}
        <g transform="rotate(-24 50 50)">
          <ellipse ${ring} fill="none" stroke="${c.fg}" stroke-width="7"/>
          <circle cx="50" cy="50" r="23" fill="${planet}"/>
          ${d.avatar ? `<clipPath id="disc"><circle cx="50" cy="50" r="23"/></clipPath>
          <circle cx="61" cy="61" r="26" fill="${shade}" clip-path="url(#disc)"/>` : ""}
          <clipPath id="front"><rect x="0" y="50" width="100" height="50"/></clipPath>
          <g clip-path="url(#front)" fill="none">
            <ellipse ${ring} stroke="${c.bg}" stroke-width="11"/>
            <ellipse ${ring} stroke="${c.fg}" stroke-width="7"/>
          </g>
          <circle cx="${sx}" cy="${sy}" r="6" fill="${c.accent}" stroke="${c.bg}" stroke-width="2"/>
        </g>`;
    },
  },

  quill: {
    shape: "circle",
    avatarScale: 0.92,
    draw: (c, d) => {
      // Barb splits are thin wedges from the shaft down and out across the vane's edge:
      // [y on the shaft, dx, dy]. The left side is the fuller one; the avatar gets more splits.
      const cuts = d.avatar
        ? [[20, -34, 22], [30, -34, 22], [40, -34, 22], [50, -30, 20], [26, 26, 17], [38, 26, 17]]
        : [[26, -34, 22], [40, -34, 22], [32, 26, 17]];
      return `
        <g transform="rotate(38 50 50)">
          <path d="M50 6 C 34 14, 22 34, 24 54 C 25 62, 32 66, 42 64 L 50 58 C 56 60, 64 58, 66 50 C 70 34, 62 14, 50 6 Z" fill="${c.fg}"/>
          <g fill="${c.bg}" stroke="${c.bg}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round">
            <path d="M50 11 L50 58" fill="none" stroke-width="2.4"/>
            ${cuts.map(([y, dx, dy]) => `<path d="M50 ${y} L${50 + dx} ${y + dy - 2.5} L${50 + dx} ${y + dy + 2.5} Z"/>`).join("")}
          </g>
          <path d="M50 56 Q 48 70 50 84" fill="none" stroke="${c.fg}" stroke-width="4.6" stroke-linecap="round"/>
          <path d="M45.5 82 L54.5 82 L50 94 Z" fill="${c.accent}" stroke="${c.accent}" stroke-width="1.5" stroke-linejoin="round"/>
          ${d.avatar ? `<circle cx="59" cy="93" r="2.4" fill="${c.accent}"/>` : ""}
        </g>`;
    },
  },

  beacon: {
    shape: "square",
    radius: 18,
    avatarScale: 1,
    draw: (c, d) => {
      const halfWidth = (y) => 6 + ((y - 44) * 7) / 44; // the tower tapers from 12 wide at the top to 26 at the base
      const stripes = (d.avatar ? [[54, 60], [70, 76]] : [[62, 68]])
        .map(([y0, y1]) => `<polygon points="${50 - halfWidth(y0)},${y0} ${50 + halfWidth(y0)},${y0} ${50 + halfWidth(y1)},${y1} ${50 - halfWidth(y1)},${y1}" fill="${c.bg}"/>`)
        .join("");
      const defs = d.avatar ? `
        <defs>
          <linearGradient id="beamL" x1="1" y1="0" x2="0" y2="0"><stop offset="0" stop-color="${c.accent}"/><stop offset="1" stop-color="${c.accent}" stop-opacity="0.1"/></linearGradient>
          <linearGradient id="beamR" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${c.accent}"/><stop offset="1" stop-color="${c.accent}" stop-opacity="0.1"/></linearGradient>
          <radialGradient id="glow"><stop offset="0" stop-color="${c.accent}" stop-opacity="0.85"/><stop offset="1" stop-color="${c.accent}" stop-opacity="0"/></radialGradient>
        </defs>` : "";
      return `${defs}
        <polygon points="43,31 0,12 0,52 43,37" fill="${d.avatar ? "url(#beamL)" : c.accent}"/>
        <polygon points="57,31 100,12 100,52 57,37" fill="${d.avatar ? "url(#beamR)" : c.accent}"/>
        ${d.avatar ? `<circle cx="50" cy="34" r="17" fill="url(#glow)"/>` : ""}
        <rect x="44" y="27" width="12" height="13" fill="${c.accent}"/>
        <path d="M43 27 A 7 7 0 0 1 57 27 Z" fill="${c.fg}"/>
        <rect x="48.8" y="17" width="2.4" height="6" rx="1" fill="${c.fg}"/>
        ${d.avatar ? `<rect x="43" y="27" width="2" height="13" fill="${c.fg}"/><rect x="55" y="27" width="2" height="13" fill="${c.fg}"/>` : ""}
        <rect x="40" y="40" width="20" height="4.5" rx="1.2" fill="${c.fg}"/>
        <polygon points="44,44 56,44 63,88 37,88" fill="${c.fg}"/>
        ${stripes}
        <rect x="31" y="88" width="38" height="5.5" rx="2" fill="${c.fg}"/>
        ${d.avatar ? `<path d="${wave(4, 97, 10, 9, 3)}" fill="none" stroke="${c.fg}" stroke-width="1.6" opacity="0.4"/>` : ""}`;
    },
  },

  harbor: {
    shape: "none",
    avatarScale: 0.84,
    avatarBg: (c) => mix(c.bg, "#000000", 0.42),
    draw: (c, d) => {
      const shield = "M12 8 H88 V46 C88 68 70 86 50 95 C30 86 12 68 12 46 Z";
      return `
        <path d="${shield}" fill="${c.bg}" stroke="${c.accent}" stroke-width="${d.avatar ? 3 : 4}" stroke-linejoin="round"/>
        ${d.avatar ? `
        <clipPath id="shield"><path d="${shield}"/></clipPath>
        <g clip-path="url(#shield)">
          <path d="${wave(0, 74, 12, 9, 4)} V100 H0 Z" fill="${c.accent}" opacity="0.32"/>
          <path d="${wave(0, 74, 12, 9, 4)}" fill="none" stroke="${c.accent}" stroke-width="2.2"/>
        </g>` : ""}
        <g fill="none" stroke="${c.fg}" stroke-width="6.5" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="50" cy="25" r="7.5"/>
          <path d="M35 42 H65"/>
          <path d="M50 33 V80"/>
          <path d="M25 58 A 25 25 0 0 0 50 83 A 25 25 0 0 0 75 58"/>
        </g>
        <polygon points="18,62 32,62 25,49" fill="${c.fg}"/>
        <polygon points="68,62 82,62 75,49" fill="${c.fg}"/>`;
    },
  },

  palette: {
    shape: "square",
    radius: 24,
    avatarScale: 0.9,
    draw: (c, d) => {
      // The paint: the accent, its two hue neighbours and a tint of it, so the dots differ on any brand.
      const paint = [c.accent, rotate(c.accent, 36), rotate(c.accent, -36), mix(c.accent, "#ffffff", 0.5)];
      const spots = [[27, 41], [41, 26], [57, 25], [26, 59]];
      const r = d.avatar ? 7 : 7.5;
      // A kidney-shaped board: wide at the top left, a notch curving in at the lower right, the thumb hole beside it.
      const board = "M50 12 C 26 12, 10 30, 10 52 C 10 74, 28 90, 50 90 C 66 90, 72 82, 70 72 C 68 64, 74 60, 82 60 C 88 60, 92 54, 92 46 C 92 26, 74 12, 50 12 Z";
      const field = d.avatar ? `
        <defs><radialGradient id="studio" gradientUnits="userSpaceOnUse" cx="28" cy="22" r="92">
          <stop offset="0" stop-color="${mix(c.bg, c.fg, 0.16)}"/><stop offset="1" stop-color="${c.bg}"/>
        </radialGradient></defs>
        <rect x="-6" y="-6" width="112" height="112" fill="url(#studio)"/>` : "";
      // The brush lies across the mixing area: handle, ferrule, bristles dipped in the accent; a background-coloured
      // outline keeps it apart from the board where the two share a colour.
      const brush = d.avatar ? `
        <g stroke="${c.bg}" fill="${c.bg}" stroke-linecap="round" stroke-linejoin="round">
          <path d="M92 94 L64 66" stroke-width="10"/>
          <path d="M65.5 67.5 L56.5 58.5" stroke-width="10.5"/>
          <path d="M59.8 56.2 L47 49 L54.2 61.8 Z" stroke-width="3"/>
        </g>
        <path d="M92 94 L64 66" stroke="${mix(c.bg, c.fg, 0.5)}" stroke-width="7" stroke-linecap="round"/>
        <path d="M65 67 L57 59" stroke="${c.fg}" stroke-width="7.5"/>
        <path d="M59.8 56.2 L47 49 L54.2 61.8 Z" fill="${c.accent}"/>` : "";
      return `${field}
        <path d="${board}" fill="${c.fg}"/>
        <circle cx="70" cy="42" r="${d.avatar ? 7.5 : 8}" fill="${d.avatar ? "url(#studio)" : c.bg}"/>
        ${spots.map(([x, y], i) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${paint[i]}"/>`).join("")}
        ${brush}`;
    },
  },

  stencil: {
    shape: "square",
    radius: 18,
    avatarScale: 0.88,
    draw: (c, d) => {
      const lead = mix(c.bg, "#000000", 0.4);
      // Ruler ticks along the base, cut into the set square in the background colour; the avatar's are finer.
      const step = d.avatar ? 6 : 12;
      const ticks = [];
      for (let x = 20, i = 0; x <= 80; x += step, i++) {
        const tall = d.avatar ? i % 5 === 0 : i % 2 === 0;
        const w = d.avatar ? 1.3 : 2.4, h = tall ? 8 : 4.5;
        ticks.push(`<rect x="${(x - w / 2).toFixed(2)}" y="${88 - h}" width="${w}" height="${h}" fill="${c.bg}"/>`);
      }
      const grid = d.avatar ? `<g stroke="${c.accent}" stroke-width="0.5" opacity="0.26">${
        Array.from({ length: 12 }, (_, i) => `<path d="M${-6 + i * 10} -6 V106 M-6 ${-6 + i * 10} H106"/>`).join("")}</g>` : "";
      // The pencil is drawn upright (tip at the top) and turned 30°, so it crosses the hypotenuse from the base band.
      const hw = d.avatar ? 5 : 6;
      const pencil = `
        <g transform="translate(74 60) rotate(30)">
          <path d="M${-hw} 30 H${hw} V-16 L0 -30 L${-hw} -16 Z" fill="${c.bg}" stroke="${c.bg}" stroke-width="3" stroke-linejoin="round"/>
          <rect x="${-hw}" y="-16" width="${hw * 2}" height="40" fill="${c.accent}"/>
          <rect x="${-hw}" y="24" width="${hw * 2}" height="6" fill="${c.fg}"/>
          <path d="M${-hw} -16 H${hw} L0 -30 Z" fill="${c.fg}"/>
          <path d="M${(-hw * 0.38).toFixed(2)} -24.7 H${(hw * 0.38).toFixed(2)} L0 -30 Z" fill="${lead}"/>
          ${d.avatar ? `<path d="M0 -14 V22" stroke="${c.bg}" stroke-width="1" opacity="0.35"/>` : ""}
        </g>`;
      return `${grid}
        <path d="M12 88 H88 L12 12 Z M26 76 V42 L60 76 Z" fill="${c.fg}" fill-rule="evenodd"/>
        ${ticks.join("")}
        ${pencil}`;
    },
  },
};

// ── SVG documents ────────────────────────────────────────────────────────────
function svgFor(style, c, variant) {
  const avatar = variant === "avatar";
  const size = avatar ? 256 : 128;
  const shape = avatar ? "rect" : (opts.shape ?? style.shape);
  const frame = {
    rect: `<rect width="100" height="100"/>`,
    square: `<rect x="2" y="2" width="96" height="96" rx="${style.radius ?? 22}"/>`,
    circle: `<circle cx="50" cy="50" r="48"/>`,
    none: "",
  }[shape];
  const fill = avatar ? (style.avatarBg ? style.avatarBg(c) : c.bg) : c.bg;
  const background = frame ? frame.replace("/>", ` fill="${fill}"/>`) : "";
  const scale = avatar ? style.avatarScale ?? 0.86 : 1;
  const transform = scale === 1 ? "" : ` transform="translate(50 50) scale(${scale}) translate(-50 -50)"`;
  const clip = frame ? ` clip-path="url(#frame)"` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">
    ${frame ? `<defs><clipPath id="frame">${frame}</clipPath></defs>` : ""}
    ${background}
    <g${clip}><g${transform}>${style.draw(c, { avatar })}</g></g>
  </svg>`;
}

// ── Headless Chromium does the pixel work ────────────────────────────────────
const bin = ["/opt/pw-browsers/chromium", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", process.env.CHROME_PATH].find((p) => p && existsSync(p));
if (!bin) {
  console.error("No Chromium found (set CHROME_PATH).");
  process.exit(1);
}
const profile = mkdtempSync(join(tmpdir(), "brand-logo-"));
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
  const rasterise = async (svg, size) => {
    const dataUrl = "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");
    const r = await send("Runtime.evaluate", {
      awaitPromise: true,
      returnByValue: true,
      expression: `(async () => {
        const img = new Image(); img.src = ${JSON.stringify(dataUrl)}; await img.decode();
        const c = document.createElement("canvas"); c.width = ${size}; c.height = ${size};
        c.getContext("2d").drawImage(img, 0, 0, ${size}, ${size});
        return c.toDataURL("image/png");
      })()`,
    }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return Buffer.from(r.result.value.split(",")[1], "base64");
  };
  const style = styles[opts.style];
  const outDir = opts.out ?? join("media", "brands");
  mkdirSync(resolve(root, outDir), { recursive: true });
  const iconOut = join(outDir, `${id}-icon.png`);
  const avatarOut = join(outDir, `${id}-avatar.png`);
  writeFileSync(resolve(root, iconOut), await rasterise(svgFor(style, colours, "icon"), 128));
  writeFileSync(resolve(root, avatarOut), await rasterise(svgFor(style, colours, "avatar"), 256));
  const command = `node browser/brands/make-logo.mjs ${args.join(" ")}`;
  console.log(`wrote ${iconOut} (128×128) and ${avatarOut} (256×256)`);
  console.log(`command: ${command}`);
  console.log(`"icon": ${JSON.stringify(iconOut)},\n"avatar": ${JSON.stringify(avatarOut)},\n"_note": ${JSON.stringify(`Placeholder logo generated with: ${command} — replace the artwork before publishing.`)}`);
} finally {
  try { ws.close(); } catch {}
  proc.kill("SIGKILL");
  await new Promise((r) => proc.once("exit", r));
  rmSync(profile, { recursive: true, force: true });
}
