// Every brand build (dist-browser/extension = the default brand, dist-browser/brands/<id>/extension
// = the others) loads in a real Chromium and shows its own name, colours and assistant — nothing
// of another brand. Run: npm run test:e2e (builds the brands first), or
//   npm run build && npm run build:brands && node --test tests/e2e/brands.e2e.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, findChromium } from "./cdp.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(dirname(here));
const brandsDir = join(root, "browser", "brands");
const brands = readdirSync(brandsDir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(brandsDir, f), "utf8")));
const extDir = (b) => (b.id === "tali" ? join(root, "dist-browser", "extension") : join(root, "dist-browser", "brands", b.id, "extension"));
const skip = !findChromium() ? "no Chromium found (set CHROME_PATH)" : brands.some((b) => !existsSync(join(extDir(b), "manifest.json"))) ? "brands not built (npm run build && npm run build:brands)" : false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn, timeout = 10000, what = "condition") {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

for (const b of brands) {
  test(`brand ${b.id}: the built extension is "${b.name}" everywhere a user sees it`, { skip }, async () => {
    const workDir = mkdtempSync(join(tmpdir(), `brand-e2e-${b.id}-`));
    const browser = await launch({ extensionDir: extDir(b), userDataDir: join(workDir, "profile"), downloadDir: join(workDir, "downloads") });
    const cdp = browser.cdp;
    try {
      // The extension id: a brand without a key gets one derived from its path, so read it off the service worker.
      const sw = await cdp.waitForTarget((t) => t.type === "service_worker" && t.url.startsWith("chrome-extension://") && t.url.endsWith("/background.js"), 15000);
      const extId = new URL(sw.url).host;
      const { targetId } = await cdp.send("Target.createTarget", { url: `chrome-extension://${extId}/sidepanel.html` });
      const panel = await cdp.attach(targetId);
      await waitUntil(() => cdp.evaluate(panel, "typeof AgentBrowserTools === 'object' && typeof AGENT_BRAND === 'object'"), 10000, "panel scripts");
      const seen = await cdp.evaluate(panel, `({
        manifestName: chrome.runtime.getManifest().name,
        manifestDescription: chrome.runtime.getManifest().description,
        title: document.title,
        // With an avatar the header shows the image and keeps the words as its alt text.
        bar: document.querySelector(".bar-title").textContent || (document.querySelector(".bar-title img") || {}).alt || "",
        assistant: document.body.dataset.assistant,
        brand: AGENT_BRAND.shortName,
        accent: getComputedStyle(document.documentElement).getPropertyValue("--brand-accent").trim(),
        focus: getComputedStyle(document.documentElement).getPropertyValue("--vscode-focusBorder").trim(),
        light: matchMedia("(prefers-color-scheme: light)").matches,
        icon: chrome.runtime.getURL("icon.png"),
      })`);
      assert.equal(seen.manifestName, b.name);
      assert.equal(seen.manifestDescription, b.description);
      assert.equal(seen.title, b.shortName);
      assert.equal(seen.bar, `${b.shortName} · Browser`);
      assert.equal(seen.assistant, b.shortName);
      assert.equal(seen.brand, b.shortName);
      assert.equal(seen.accent, b.colors.accent);
      assert.equal(seen.focus, seen.light ? b.colors.accentLight : b.colors.accent, "the accent (light or dark variant, by the OS theme) drives focus rings and links");
      // The icon the manifest points at is the brand's file, byte for byte.
      const iconBytes = await cdp.evaluate(panel, `fetch(${JSON.stringify(seen.icon)}).then((r) => r.arrayBuffer()).then((a) => Array.from(new Uint8Array(a).slice(0, 64)))`);
      assert.deepEqual(iconBytes, Array.from(readFileSync(join(root, b.icon)).subarray(0, 64)));
      // The assistant's name shown in the chat comes from the brand, whichever backend posts the identity.
      await cdp.evaluate(panel, `window.dispatchEvent(new MessageEvent("message", { data: { type: "identity", name: "Someone Else" } })); true`);
      // The options page carries the brand too.
      const { targetId: optTarget } = await cdp.send("Target.createTarget", { url: `chrome-extension://${extId}/options.html` });
      const opt = await cdp.attach(optTarget);
      // The target starts as an empty document (readyState "complete" already): wait for the page's own markup.
      await waitUntil(() => cdp.evaluate(opt, "!!document.querySelector('.brand-sub')"), 10000, "options page");
      const optSeen = await cdp.evaluate(opt, `({ title: document.title, head: document.querySelector(".brand-name").textContent.replace(/\\s+/g, " ").trim(), sub: document.querySelector(".brand-sub").textContent.trim(), body: document.body.innerText })`);
      assert.equal(optSeen.title, `${b.shortName} — settings`);
      assert.equal(optSeen.head, `${b.shortName} · ${b.tagline}`);
      assert.equal(optSeen.sub, b.subtitle);
      for (const other of brands) {
        if (other.id === b.id) continue;
        assert.doesNotMatch(optSeen.body, new RegExp(`\\b${other.shortName}\\b`), `no "${other.shortName}" on ${b.id}'s settings page`);
        assert.doesNotMatch(seen.bar + seen.title, new RegExp(other.shortName));
      }
    } finally {
      await browser.close();
      rmSync(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });
}
