// The identity report (browser/extras/audit.js) against fakes of chrome.* and the tools runtime: the
// verdict line, the consistency warnings (device profile vs. the page, client hints vs. the User-Agent),
// the report's formatting, what the extension side adds (cookie count, profile label, proxy — never
// values or credentials), the 🪪 tab and the quick commands.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { fakeChrome, fakeTools, fakeDom, fakeCtx, loadExtra } from "./mocks/extras-harbor.mjs";

const SRC = fs.readFileSync(fileURLToPath(new URL("../browser/extras/audit.js", import.meta.url)), "utf8");
const plain = (x) => JSON.parse(JSON.stringify(x)); // values cross the vm boundary: compare structure, not prototypes

const LINUX_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const WIN_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.7103.92 Safari/537.36";
/** What probePage() returns on a plain Linux desktop Chrome. */
const PAGE = {
  url: "http://localhost:4000/", title: "Whoami",
  userAgent: LINUX_UA, uaData: { brands: ["Chromium 131", "Google Chrome 131", "Not.A/Brand 99"], platform: "Linux", mobile: false },
  platform: "Linux x86_64", language: "en-US", languages: ["en-US", "en"], timeZone: "Europe/Berlin", locale: "en-US", tzOffset: -60,
  screen: { width: 1280, height: 900, availWidth: 1280, availHeight: 900, colorDepth: 24 }, dpr: 1, inner: { width: 1280, height: 700 },
  hardwareConcurrency: 8, deviceMemory: 8, maxTouchPoints: 0, cookieEnabled: true, webdriver: false, doNotTrack: null,
  storage: { quota: 2000000000, usage: 0 },
};
const WIN_PAGE = { ...PAGE, userAgent: WIN_UA, uaData: { brands: ["Chromium 136", "Google Chrome 136", "Not.A/Brand 99"], platform: "Windows", mobile: false }, platform: "Win32", timeZone: "America/New_York", tzOffset: 300, screen: { width: 2560, height: 1440, availWidth: 2560, availHeight: 1400, colorDepth: 24 }, hardwareConcurrency: 24, deviceMemory: 32 };
/** summarizeDevice() of a win11 template launched by profile "Work". */
const DEVICE = { label: "Windows 11 — i7-13700K / RTX 4060", profile: "Work", os: "Windows", platform: "Win32", timezone: "America/New_York", ua: WIN_UA, screen: "2560×1440", threads: 24 };
const NO_PROXY = { available: true, mode: "system", control: "controllable_by_this_extension", server: "" };
const PROXY = { available: true, mode: "fixed_servers", control: "controlled_by_this_extension", server: "http://1.2.3.4:8080" };
const report = (over = {}) => ({ tab: { url: PAGE.url, title: "Whoami", windowId: 1 }, page: PAGE, cookies: { site: "localhost", count: 2, httpOnly: 1 }, device: null, proxy: NO_PROXY, ...over });

// The config a profile window keeps in chrome.storage.session (a template plus the per-profile parts).
const CFG = {
  id: "win11-i7-rtx4060", label: "Windows 11 — i7-13700K / RTX 4060", os: "win", osName: "Windows", ua: WIN_UA, platform: "Win32", profileId: "prof_1",
  hardwareConcurrency: 24, deviceMemory: 32, screen: { width: 2560, height: 1440, availWidth: 2560, availHeight: 1400, colorDepth: 24 }, timezone: "America/New_York",
  webgl: { unmaskedRenderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Direct3D11 vs_5_0 ps_5_0, D3D11)" }, brands: [{ brand: "Chromium", version: "136" }],
};

function setup({ features = ["accounts", "audit"], globals, page = PAGE } = {}) {
  const f = fakeChrome({ tabs: { 5: { id: 5, windowId: 1, active: true, url: "http://localhost:4000/", title: "Whoami" } } });
  f.chrome.scripting.result = page;
  f.jar.push(
    { name: "session", value: "alice", domain: "localhost", hostOnly: true, path: "/", secure: false, httpOnly: false, sameSite: "lax", storeId: "0" },
    { name: "sid", value: "s3cr3t-alice", domain: "localhost", hostOnly: true, path: "/", secure: false, httpOnly: true, sameSite: "unspecified", storeId: "0" },
    { name: "other", value: "x", domain: "other.test", hostOnly: true, path: "/", secure: false, httpOnly: false, sameSite: "lax", storeId: "0" }
  );
  const T = fakeTools(f.chrome, 5);
  const X = loadExtra(SRC, { chrome: f.chrome, tools: T, features, globals });
  return { ...f, T, X, U: X.audit, run: T.run };
}

test("audit: nothing is registered for a brand without the feature", () => {
  const { X, T } = setup({ features: ["accounts"] });
  assert.equal(X.audit, undefined);
  assert.deepEqual([X.tabs, X.commands, Object.keys(T.registered)], [[], [], []]);
});

test("audit: the small helpers", () => {
  const { U } = setup();
  assert.deepEqual([U.osOfUa(LINUX_UA), U.osOfUa(WIN_UA), U.osOfUa("Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120.0 Mobile Safari/537.36"), U.osOfUa("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)"), U.osOfUa("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"), U.osOfUa("Mozilla/5.0 (X11; CrOS x86_64 14541.0.0)"), U.osOfUa("")],
    ["Linux", "Windows", "Android", "iOS", "macOS", "Chrome OS", ""]);
  assert.deepEqual([U.osOfPlatform("Win32"), U.osOfPlatform("MacIntel"), U.osOfPlatform("Linux armv8l"), U.osOfPlatform("iPhone"), U.osOfPlatform("Windows"), U.osOfPlatform("macOS"), U.osOfPlatform("Chrome OS"), U.osOfPlatform("")],
    ["Windows", "macOS", "Linux", "iOS", "Windows", "macOS", "Chrome OS", ""]);
  assert.deepEqual([U.browserOfUa(LINUX_UA), U.browserOfUa(WIN_UA + " Edg/136.0.1"), U.browserOfUa("Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0"), U.browserOfUa("Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"), U.browserOfUa("curl/8")],
    ["Chrome 131", "Edge 136", "Firefox 128", "Safari 17", "an unknown browser"]);
  assert.deepEqual([U.siteOf("https://www.app.example.com/x"), U.siteOf("http://localhost:4000/"), U.siteOf("https://shop.example.co.uk/"), U.siteOf("http://127.0.0.1/"), U.siteOf("chrome://extensions"), U.siteOf("")], ["example.com", "localhost", "example.co.uk", "127.0.0.1", "", ""]);
  assert.deepEqual([U.bytes(2000000000), U.bytes(15000000), U.bytes(2048), U.bytes(0), U.bytes(undefined)], ["2.0 GB", "15 MB", "2 kB", "0 B", "?"]);
  assert.deepEqual([U.utcOffset(0), U.utcOffset(300), U.utcOffset(-60), U.utcOffset(-330), U.utcOffset(undefined)], ["UTC", "UTC−5", "UTC+1", "UTC+5:30", "UTC"]);
  assert.deepEqual(plain(U.summarizeDevice(CFG, "Work")), DEVICE, "only labels and the compared values — nothing of the template's internals");
  assert.equal(U.summarizeDevice(null), null);
  assert.equal(U.summarizeDevice({ id: "x", os: "mac" }).os, "macOS");
});

test("audit: consistency checks between the page, the device profile and the page's own values", () => {
  const { U } = setup();
  assert.deepEqual(plain(U.checks(report())), [], "a plain browser is consistent with itself");
  assert.deepEqual(plain(U.checks(report({ page: WIN_PAGE, device: DEVICE }))), [], "a profile window whose page shows the template");
  assert.deepEqual(plain(U.checks(report({ device: DEVICE }))), [
    "The User-Agent says Linux, but the device profile 'Windows 11 — i7-13700K / RTX 4060' is a Windows machine.",
    "navigator.platform is 'Linux x86_64', the device profile presents 'Win32'.",
    "Time zone: the page sees Europe/Berlin, the device profile sets America/New_York.",
    "Screen: the page sees 1280×900, the device profile is 2560×1440.",
    "CPU threads: the page sees 8, the device profile has 24.",
  ], "a profile that did not reach the page");
  assert.deepEqual(plain(U.checks(report({ page: { ...WIN_PAGE, timeZone: "Europe/Berlin" }, device: DEVICE }))), ["Time zone: the page sees Europe/Berlin, the device profile sets America/New_York."]);
  assert.deepEqual(plain(U.checks(report({ page: { ...PAGE, uaData: { ...PAGE.uaData, platform: "Windows" } } }))), ["Client hints say Windows while the User-Agent says Linux — sites compare the two."]);
  assert.deepEqual(plain(U.checks(report({ page: { ...PAGE, platform: "Win32", uaData: null } }))), ["navigator.platform 'Win32' does not match the Linux User-Agent."]);
  assert.deepEqual(plain(U.checks(report({ page: { ...PAGE, userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36", platform: "Linux armv8l", uaData: { brands: [], platform: "Android", mobile: true } } }))), [], "Android's Linux platform string is not a mismatch");
  assert.deepEqual(plain(U.checks(report({ page: { ...PAGE, webdriver: true } }))), ["navigator.webdriver is true — the page can tell that automation is attached."]);
});

test("audit: the verdict line", () => {
  const { U } = setup();
  assert.equal(U.verdict(report()), "Looks like a plain desktop Chrome 131 on Linux; no device profile; no proxy");
  assert.equal(U.verdict(report({ proxy: { ...NO_PROXY, mode: "direct" } })), "Looks like a plain desktop Chrome 131 on Linux; no device profile; no proxy");
  assert.equal(U.verdict(report({ page: WIN_PAGE, device: DEVICE, proxy: PROXY })), "Presents as a desktop Chrome 136 on Windows through device profile 'Windows 11 — i7-13700K / RTX 4060' (Work); proxy http://1.2.3.4:8080");
  assert.equal(U.verdict(report({ device: DEVICE, proxy: PROXY })), "Presents as a desktop Chrome 131 on Linux through device profile 'Windows 11 — i7-13700K / RTX 4060' (Work); proxy http://1.2.3.4:8080; 5 warnings");
  assert.equal(U.verdict(report({ page: { ...PAGE, webdriver: true } })), "Looks like a plain desktop Chrome 131 on Linux; no device profile; no proxy; 1 warning");
  assert.equal(U.verdict(report({ page: { ...PAGE, userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36", platform: "Linux armv8l", uaData: { brands: [], platform: "Android", mobile: true } } })), "Looks like a plain mobile Chrome 120 on Android; no device profile; no proxy");
  assert.equal(U.verdict(report({ proxy: { available: false } })), "Looks like a plain desktop Chrome 131 on Linux; no device profile; no proxy control in this build");
  assert.equal(U.verdict(report({ proxy: { ...NO_PROXY, mode: "pac_script", server: "PAC script" } })), "Looks like a plain desktop Chrome 131 on Linux; no device profile; proxy PAC script");
  assert.equal(U.verdict(report({ proxy: { ...NO_PROXY, mode: "auto_detect" } })), "Looks like a plain desktop Chrome 131 on Linux; no device profile; proxy mode auto_detect");
  assert.equal(U.verdict(report({ device: { ...DEVICE, profile: "" }, page: WIN_PAGE })), "Presents as a desktop Chrome 136 on Windows through device profile 'Windows 11 — i7-13700K / RTX 4060'; no proxy");
});

test("audit: the report is one readable block — verdict and warnings first, then the two groups", () => {
  const { U } = setup();
  assert.equal(U.formatReport(report()), [
    "Identity report for http://localhost:4000/ (Whoami)",
    "Verdict: Looks like a plain desktop Chrome 131 on Linux; no device profile; no proxy",
    "",
    "What the page sees",
    "  User-Agent: " + LINUX_UA,
    "  Client hints: Chromium 131, Google Chrome 131, Not.A/Brand 99 · platform Linux · desktop",
    "  Platform: Linux x86_64",
    "  Languages: en-US, en",
    "  Time zone: Europe/Berlin (UTC+1) · locale en-US",
    "  Screen: 1280×900 (available 1280×900), 24-bit · device pixel ratio 1 · window 1280×700",
    "  Hardware: 8 CPU threads · 8 GB memory · 0 touch points",
    "  Cookies enabled: yes · navigator.webdriver: no · Do Not Track: unset",
    "  Storage: 2.0 GB quota, 0 B used",
    "",
    "What the extension knows",
    "  Cookies for localhost: 2 (1 httpOnly)",
    "  Device profile: none — this window presents the real browser",
    "  Proxy: none set by the extension (mode \"system\")",
  ].join("\n"));
  const full = U.formatReport(report({ page: { ...WIN_PAGE, timeZone: "Europe/Berlin" }, device: DEVICE, proxy: PROXY, cookies: { site: "example.com", count: 0, httpOnly: 0 } }));
  assert.match(full, /^Verdict: Presents as a desktop Chrome 136 on Windows through device profile 'Windows 11 — i7-13700K \/ RTX 4060' \(Work\); proxy http:\/\/1\.2\.3\.4:8080; 1 warning\n⚠ Time zone: the page sees Europe\/Berlin, the device profile sets America\/New_York\.\n\nWhat the page sees/m);
  assert.match(full, /^  Cookies for example\.com: 0$/m);
  assert.match(full, /^  Device profile: 'Windows 11 — i7-13700K \/ RTX 4060' — profile 'Work', time zone America\/New_York — applied to this window$/m);
  assert.match(full, /^  Proxy: http:\/\/1\.2\.3\.4:8080 \(mode "fixed_servers" — set by this extension\)$/m);
  // Missing values are said to be missing, not invented.
  const sparse = U.formatReport(report({ page: { url: PAGE.url, userAgent: "curl/8", uaData: null, languages: [], screen: null, inner: null }, cookies: { site: "", count: null }, proxy: { available: false }, tab: {} }));
  assert.match(sparse, /^Identity report for http:\/\/localhost:4000\/\nVerdict: Looks like a plain desktop an unknown browser on an unknown OS; no device profile; no proxy control in this build\n/);
  assert.match(sparse, /^  Client hints: none \(not a Chromium browser, or hints are off\)$/m);
  assert.match(sparse, /^  Platform: \?\n  Languages: \?\n  Time zone: \? · locale \?\n  Screen: \? · device pixel ratio \? · window \?\n  Hardware: \? CPU threads · memory not exposed · 0 touch points\n  Cookies enabled: unknown · navigator.webdriver: unknown · Do Not Track: unset\n  Storage: estimate not available$/m);
  assert.match(sparse, /^  Cookies for this site: unknown \(no cookie access in this build\)$/m);
  assert.match(sparse, /^  Proxy: no proxy control in this build$/m);
});

test("audit: browser_identity_report reads the page's MAIN world and adds the cookie count, the profile label and the proxy", async () => {
  const { run, log, session, local, chrome, T } = setup();
  let out = await run("browser_identity_report", {});
  assert.deepEqual(log.scripts, [{ tabId: 5, world: "MAIN", func: "probePage" }], "what the site itself sees, not the isolated world");
  assert.match(out, /^Identity report for http:\/\/localhost:4000\/ \(Whoami\)\nVerdict: Looks like a plain desktop Chrome 131 on Linux; no device profile; no proxy\n/);
  assert.match(out, /^  Cookies for localhost: 2 \(1 httpOnly\)$/m, "the other site's cookie is not counted");
  assert.doesNotMatch(out, /s3cr3t|alice/, "no cookie values");

  // A profile window: the session key names the config, the profile's name comes from the profiles store.
  session["agentDeviceWindow:1"] = CFG;
  local.agentProfiles = { prof_1: { name: "Work", proxy: { enabled: true, host: "1.2.3.4", port: 8080, username: "user", password: "hunter2" } } };
  chrome.proxy.value = { value: { mode: "fixed_servers", rules: { singleProxy: { scheme: "http", host: "1.2.3.4", port: 8080 }, bypassList: ["<local>"] } }, levelOfControl: "controlled_by_this_extension" };
  out = await run("browser_identity_report", {});
  assert.match(out, /^Verdict: Presents as a desktop Chrome 131 on Linux through device profile 'Windows 11 — i7-13700K \/ RTX 4060' \(Work\); proxy http:\/\/1\.2\.3\.4:8080; 5 warnings$/m, "the page still shows the real machine: every difference is flagged");
  assert.match(out, /^⚠ The User-Agent says Linux, but the device profile 'Windows 11 — i7-13700K \/ RTX 4060' is a Windows machine\.$/m);
  assert.match(out, /^  Device profile: 'Windows 11 — i7-13700K \/ RTX 4060' — profile 'Work', time zone America\/New_York — applied to this window$/m);
  assert.match(out, /^  Proxy: http:\/\/1\.2\.3\.4:8080 \(mode "fixed_servers" — set by this extension\)$/m);
  assert.doesNotMatch(out, /hunter2|user:|Direct3D11|ANGLE/, "no credentials, nothing of the template's internals");

  // The same window once its page presents the template: consistent.
  chrome.scripting.result = WIN_PAGE;
  out = await run("browser_identity_report", {});
  assert.match(out, /^Verdict: Presents as a desktop Chrome 136 on Windows through device profile 'Windows 11 — i7-13700K \/ RTX 4060' \(Work\); proxy http:\/\/1\.2\.3\.4:8080$/m);
  assert.doesNotMatch(out, /^⚠/m);

  // A tab this panel gave an identity directly (no profile window): the runtime's deviceOf is the fallback.
  delete session["agentDeviceWindow:1"];
  T.device = { ...CFG, profileId: "" };
  out = await run("browser_identity_report", {});
  assert.match(out, /^  Device profile: 'Windows 11 — i7-13700K \/ RTX 4060', time zone America\/New_York — applied to this window$/m);
  T.device = null;

  // A build without cookies or proxy access says so instead of failing.
  delete chrome.cookies;
  delete chrome.proxy;
  out = await run("browser_identity_report", {});
  assert.match(out, /no device profile; no proxy control in this build$/m);
  assert.match(out, /^  Cookies for localhost: unknown \(no cookie access in this build\)$/m);
  assert.match(out, /^  Proxy: no proxy control in this build$/m);

  // A page that cannot be scripted.
  chrome.scripting.throws = new Error("Cannot access a chrome:// URL");
  await assert.rejects(run("browser_identity_report", {}), /can't be inspected — navigate to a regular website first\. \(Cannot access a chrome:\/\/ URL\)/);
});

test("audit: the 🪪 tab shows the highlighted verdict, the report, Refresh / Copy and the agent hand-off", async () => {
  const dom = fakeDom();
  const copied = [];
  const { X, tabs, chrome, local, session } = setup({ globals: { navigator: { clipboard: { writeText: async (t) => { copied.push(t); } } } } });
  assert.ok(!/\.innerHTML/.test(SRC.replace(/^\s*\/\/.*$/gm, "")), "the tab builds its DOM without innerHTML");
  const tab = X.tabs.find((t) => t.id === "audit");
  assert.equal(tab.label, "🪪 Identity");
  const ctx = fakeCtx(dom, { url: tabs[5].url });
  let content = new dom.Node("div");
  await tab.render(content, ctx);
  const verdict = "Looks like a plain desktop Chrome 131 on Linux; no device profile; no proxy";
  assert.deepEqual(ctx.statuses.at(-1), [verdict, "good"], "the verdict goes to the highlighted status line");
  assert.equal(dom.byClass(content, "cmd-name").map(dom.textOf)[0], verdict);
  assert.equal(dom.byClass(content, "cmd-icon")[0].textContent, "✅");
  const pre = dom.byClass(content, "auto-pre")[0];
  assert.match(pre.textContent, /^Identity report for http:\/\/localhost:4000\/ \(Whoami\)\nVerdict: /);
  assert.match(pre.textContent, /\nWhat the page sees\n[\s\S]*\nWhat the extension knows\n/);
  assert.match(dom.textOf(content), /Compare with another tab: switch to it and press Refresh/);
  assert.doesNotMatch(dom.textOf(content), /s3cr3t|alice/);
  const copy = dom.buttons(content, "📋 Copy")[0];
  assert.equal(copy.disabled, false);
  await copy.click();
  assert.deepEqual(copied, [pre.textContent]);
  await dom.buttons(content, "↻ Refresh")[0].click();
  assert.equal(ctx.rerenders, 1);
  await dom.buttons(content, "💬 Check with the agent")[0].click();
  assert.match(ctx.prompts[0], /^Run browser_identity_report on this tab, then compare it with the device profile and proxy/);

  // With a mismatching profile the verdict is marked bad and the warnings are listed under it.
  session["agentDeviceWindow:1"] = CFG;
  local.agentProfiles = { prof_1: { name: "Work" } };
  content = new dom.Node("div");
  await tab.render(content, ctx);
  assert.equal(ctx.statuses.at(-1)[1], "bad");
  assert.equal(dom.byClass(content, "cmd-icon")[0].textContent, "⚠");
  assert.equal(dom.byClass(content, "bad").length, 5);
  assert.match(dom.byClass(content, "bad")[2].textContent, /^Time zone: the page sees Europe\/Berlin/);

  // Not a website: no probe, a hint instead.
  tabs[5].url = "chrome://newtab/";
  chrome.scripting.throws = new Error("must not be called");
  content = new dom.Node("div");
  await tab.render(content, ctx);
  assert.match(dom.textOf(content), /Open a website tab to see what it sees\./);
  assert.equal(dom.buttons(content, "📋 Copy")[0].disabled, true);
});

test("audit: tool and quick commands are registered under their names and group", () => {
  const { T, X } = setup();
  assert.deepEqual(Object.keys(T.registered), ["browser_identity_report"]);
  const mine = X.commands.filter((c) => c.group === "Accounts");
  assert.deepEqual(mine.map((c) => c.name), ["What does this site see?", "Check my identity before signing in"]);
  assert.match(mine[1].prompt, /browser_identity_report[\s\S]*compare it with the device profile and proxy[\s\S]*mismatch/);
  for (const c of mine) assert.ok(c.icon && !c.partial, c.name);
});
