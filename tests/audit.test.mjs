// The identity report (browser/extras/audit.js) against fakes of chrome.* and the tools runtime: the
// verdict line, the consistency warnings (device profile vs. the page, client hints vs. the User-Agent),
// the report's formatting, what the extension side adds (cookie count, profile label, proxy — never
// values or credentials), the exit check (a faked trace endpoint, the expected proxy, country vs language
// and time zone), the leak check (WebRTC candidates, time zone, languages, geometry, webdriver, client
// hints on fixed page data), the fingerprint check (FNV-1a, the readings against the window's device
// config or the active profile's template, the combined hash), the 🪪 tab and the quick commands.
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

// ── The exit check ──

const TRACE = ["fl=123f45", "h=www.cloudflare.com", "ip=203.0.113.9", "ts=1760000000.123", "visit_scheme=https", "uag=" + WIN_UA, "colo=LHR", "sliver=none", "http=http/2", "loc=GB", "tls=TLSv1.3", "sni=plaintext", "warp=off", "gateway=off", "rbi=off", "kex=X25519", ""].join("\n");
const PROXY_EXP = { type: "http", host: "1.2.3.4", port: 8080 };
const APPLIED = { available: true, mode: "fixed_servers", control: "controlled_by_this_extension", server: "http://1.2.3.4:8080" };

/** A fetch for the trace endpoint: state.body, state.status, state.fail (a TypeError), state.hang (never answers, honours the abort signal); every call recorded. */
function fakeFetch(state = {}) {
  const fetch = async (url, options = {}) => {
    fetch.calls.push({ url, ...options });
    if (state.fail) throw new TypeError("Failed to fetch");
    if (state.hang) return new Promise((_, reject) => { options.signal?.addEventListener("abort", () => reject(Object.assign(new Error("The user aborted a request."), { name: "AbortError" }))); });
    const status = state.status || 200;
    return { ok: status >= 200 && status < 300, status, text: async () => state.body ?? TRACE };
  };
  fetch.calls = [];
  return fetch;
}

test("audit: parseTrace reads the key=value lines of a trace", () => {
  const { U } = setup();
  const t = U.parseTrace(TRACE);
  assert.deepEqual([t.ip, t.loc, t.colo, t.tls, t.http, t.uag, t.warp], ["203.0.113.9", "GB", "LHR", "TLSv1.3", "http/2", WIN_UA, "off"]);
  assert.deepEqual(plain(U.parseTrace("ip = 1.2.3.4 \r\njunk\n=nokey\nloc=\n")), { ip: "1.2.3.4", loc: "" }, "trimmed; lines without a key are ignored");
  assert.deepEqual(plain(U.parseTrace("")), {});
  assert.deepEqual(plain(U.parseTrace(undefined)), {});
  assert.deepEqual([U.langCountry("en-GB"), U.langCountry("de-DE"), U.langCountry("zh-Hans-CN"), U.langCountry("en"), U.langCountry("es-419"), U.langCountry("")], ["GB", "DE", "CN", "", "", ""]);
  assert.deepEqual([U.tzCountry("Europe/London"), U.tzCountry("America/New_York"), U.tzCountry("Asia/Tokyo"), U.tzCountry("Etc/UTC"), U.tzCountry("")], ["GB", "US", "JP", "", ""]);
  assert.deepEqual(plain(U.parseLangs("de-DE,de;q=0.9,en;q=0.8")), ["de-DE", "de", "en"]);
});

test("audit: assessExit compares the exit with the expected route and the profile's country hints", () => {
  const { U } = setup();
  const trace = U.parseTrace(TRACE);
  // Direct, nothing to compare.
  let a = U.assessExit(trace, { proxy: null, source: "no proxy configured", applied: NO_PROXY, languages: [], timezone: "", latency: 412 });
  assert.equal(a.verdict, "Exit 203.0.113.9 (GB) direct — no profile hints to compare");
  assert.deepEqual(plain(a.lines), [
    "Expected route: direct (no proxy configured)",
    "Exit: 203.0.113.9 · country GB · Cloudflare LHR · 412 ms round trip",
    "Connection: TLS TLSv1.3 · HTTP http/2 · User-Agent " + WIN_UA,
    "✓ No proxy configured: the exit is this machine's own address",
  ]);
  assert.deepEqual(plain([a.reached, a.warnings, a.advice]), [true, [], []]);
  // Through the expected proxy, country agreeing with language and time zone: consistent.
  a = U.assessExit(trace, { proxy: PROXY_EXP, source: "device profile 'Work'", applied: APPLIED, languages: ["en-GB", "en"], timezone: "Europe/London", latency: 90 });
  assert.equal(a.verdict, "Exit 203.0.113.9 (GB) through http://1.2.3.4:8080 — consistent with the profile's language en-GB and time zone Europe/London");
  assert.deepEqual(plain(a.lines).slice(3), [
    "✓ Fetched through the browser's proxy settings (http://1.2.3.4:8080)",
    "✓ Exit country GB agrees with the profile language en-GB",
    "✓ Exit country GB agrees with the profile time zone Europe/London",
  ]);
  assert.equal(a.lines[0], "Expected route: through http://1.2.3.4:8080 (device profile 'Work')");
  // A German profile leaving through the US: advice, not an error.
  a = U.assessExit({ ip: "198.51.100.1", loc: "us" }, { proxy: PROXY_EXP, source: "the proxy setting", applied: APPLIED, languages: ["de-DE", "de", "en"], timezone: "Europe/Berlin" });
  assert.equal(a.verdict, "Exit 198.51.100.1 (US) through http://1.2.3.4:8080 — advice: language de-DE suggests DE; time zone Europe/Berlin suggests DE");
  assert.deepEqual(plain(a.advice), ["language de-DE suggests DE", "time zone Europe/Berlin suggests DE"]);
  assert.deepEqual(plain(a.warnings), []);
  assert.match(a.lines[3], /^⚠ Exit country US while the profile language is de-DE \(DE\) — advice, not an error: a site may find the pair odd; use a proxy in DE or a profile language for US$/);
  assert.match(a.lines[4], /^⚠ Exit country US while the profile time zone is Europe\/Berlin \(DE\) — advice, not an error: use a proxy in DE or a profile for US$/);
  assert.equal(a.lines[1], "Exit: 198.51.100.1 · country US", "no colo, no latency: nothing invented");
  // A proxy that is expected but not applied is a warning; the proxy's own address as the exit is noted.
  a = U.assessExit(trace, { proxy: PROXY_EXP, source: "device profile 'Work'", applied: NO_PROXY, languages: ["en-GB"], timezone: "" });
  assert.equal(a.verdict, "Exit 203.0.113.9 (GB) through http://1.2.3.4:8080 — 1 warning: no proxy applied");
  assert.match(a.lines[3], /^⚠ A proxy is expected \(through http:\/\/1\.2\.3\.4:8080\) but the browser applies none \(mode "system"\) — the exit above is the real address$/);
  a = U.assessExit({ ip: "1.2.3.4", loc: "GB" }, { proxy: PROXY_EXP, applied: APPLIED, languages: ["de-DE"], timezone: "" });
  assert.ok(a.lines.includes("✓ The exit IP is the proxy's own address"));
  assert.equal(a.verdict, "Exit 1.2.3.4 (GB) through http://1.2.3.4:8080 — advice: language de-DE suggests DE");
  // Hints that name no country, a trace without one, a SOCKS proxy.
  a = U.assessExit({ ip: "203.0.113.9", loc: "GB" }, { proxy: null, applied: NO_PROXY, languages: ["en"], timezone: "Etc/UTC" });
  assert.equal(a.verdict, "Exit 203.0.113.9 (GB) direct — no profile hints to compare");
  assert.ok(a.lines.includes("Profile language en names no country — not compared with the exit"));
  assert.ok(a.lines.includes("Profile time zone Etc/UTC — country not known to this check, not compared"));
  a = U.assessExit({ ip: "203.0.113.9" }, { proxy: null, applied: NO_PROXY, languages: ["en-GB"], timezone: "Europe/London" });
  assert.equal(a.verdict, "Exit 203.0.113.9 direct — no profile hints to compare");
  assert.ok(a.lines.includes("The trace gave no country — language and time zone not compared"));
  assert.equal(U.assessExit({}, { proxy: { type: "socks5", host: "proxy.example", port: 1080 } }).lines[0], "Expected route: through socks5://proxy.example:1080");
  // Unreachable: reported, with the route it was tried through.
  a = U.assessExit(null, { proxy: PROXY_EXP, source: "device profile 'Work'", applied: APPLIED, error: "timed out after 10 s" });
  assert.equal(a.verdict, "The exit could not be reached through the current proxy (timed out after 10 s)");
  assert.deepEqual(plain(a.lines), ["Expected route: through http://1.2.3.4:8080 (device profile 'Work')", "⚠ The exit could not be reached through the current proxy (http://1.2.3.4:8080): timed out after 10 s — browsing through it fails too; check host, port and credentials."]);
  assert.equal(a.reached, false);
  a = U.assessExit(null, { proxy: { type: "socks5", host: "h", port: 1 }, error: "Failed to fetch" });
  assert.match(a.lines[1], /, and the local agent host for SOCKS5\.$/);
  a = U.assessExit(null, { proxy: null, error: "Failed to fetch" });
  assert.equal(a.verdict, "The exit could not be reached (Failed to fetch)");
  assert.match(a.lines[1], /^⚠ The exit could not be reached \(Failed to fetch\) — no proxy is configured, so the machine itself seems offline or the endpoint is blocked\.$/);
});

test("audit: browser_identity_proxy fetches the trace from the panel and grades the exit against the expected proxy — never thrown, never credentials", async () => {
  const state = {};
  const fetch = fakeFetch(state);
  const { run, local, session, chrome, U } = setup({ globals: { fetch, AbortController } });
  let out = await run("browser_identity_proxy", {});
  assert.deepEqual(fetch.calls.map((c) => [c.url, c.cache, c.credentials, !!c.signal]), [["https://www.cloudflare.com/cdn-cgi/trace", "no-store", "omit", true]], "one uncached, cookie-less GET with an abort signal");
  assert.match(out, /^Exit check \(https:\/\/www\.cloudflare\.com\/cdn-cgi\/trace, fetched by the extension through the browser's proxy settings\)\nVerdict: Exit 203\.0\.113\.9 \(GB\) direct — no profile hints to compare\nExpected route: direct \(no proxy configured\)\nExit: 203\.0\.113\.9 · country GB · Cloudflare LHR · \d+ ms round trip\n/);
  assert.match(out, /^✓ No proxy configured: the exit is this machine's own address$/m);

  // The active profile's proxy is the expectation; its language is the hint; the password never shows.
  local.agentProfiles = { prof_1: { name: "Work", lang: "en-GB,en;q=0.9", proxy: { enabled: true, type: "http", host: "1.2.3.4", port: 8080, username: "user", password: "hunter2" } } };
  local.agentActiveProfile = "prof_1";
  chrome.proxy.value = { value: { mode: "fixed_servers", rules: { singleProxy: { scheme: "http", host: "1.2.3.4", port: 8080 } } }, levelOfControl: "controlled_by_this_extension" };
  out = await run("browser_identity_proxy", {});
  assert.match(out, /^Verdict: Exit 203\.0\.113\.9 \(GB\) through http:\/\/1\.2\.3\.4:8080 — consistent with the profile's language en-GB$/m);
  assert.match(out, /^Expected route: through http:\/\/1\.2\.3\.4:8080 \(device profile 'Work'\)$/m);
  assert.match(out, /^✓ Fetched through the browser's proxy settings \(http:\/\/1\.2\.3\.4:8080\)$/m);
  assert.doesNotMatch(out, /hunter2|user/);

  // The tab's window carries a device profile: its time zone and languages win over the active profile's language.
  session["agentDeviceWindow:1"] = { ...CFG, langs: ["de-DE", "de"] };
  out = await run("browser_identity_proxy", {});
  assert.match(out, /^Verdict: Exit 203\.0\.113\.9 \(GB\) through http:\/\/1\.2\.3\.4:8080 — advice: language de-DE suggests DE; time zone America\/New_York suggests US$/m);
  assert.match(out, /^⚠ Exit country GB while the profile language is de-DE \(DE\) — advice, not an error/m);
  delete session["agentDeviceWindow:1"];

  // A profile without a proxy of its own runs over the global setting; the setting off means direct.
  local.agentProfiles.prof_1.proxy = { enabled: false, host: "" };
  local.agentProxy = { enabled: true, type: "socks5", host: "exit.example", port: 1080, username: "u", password: "p" };
  chrome.proxy.value = { value: { mode: "fixed_servers", rules: { singleProxy: { scheme: "socks5", host: "127.0.0.1", port: 40123 } } }, levelOfControl: "controlled_by_this_extension" };
  out = await run("browser_identity_proxy", {});
  assert.match(out, /^Expected route: through socks5:\/\/exit\.example:1080 \(the proxy setting — profile 'Work' has none of its own\)$/m);
  assert.match(out, /^✓ Fetched through the browser's proxy settings \(socks5:\/\/127\.0\.0\.1:40123\)$/m, "the loopback forwarder counts as applied");
  assert.doesNotMatch(out, /\bu:|\bp\b|password/);
  local.agentProxy.enabled = false;
  chrome.proxy.value = { value: { mode: "system" }, levelOfControl: "controllable_by_this_extension" };
  out = await run("browser_identity_proxy", {});
  assert.match(out, /^Expected route: direct \(no proxy configured — profile 'Work' has none\)$/m);
  // Expected but not applied: a warning, not advice.
  local.agentProxy.enabled = true;
  out = await run("browser_identity_proxy", {});
  assert.match(out, /^Verdict: Exit 203\.0\.113\.9 \(GB\) through socks5:\/\/exit\.example:1080 — 1 warning: no proxy applied$/m);

  // A network failure is a report, not an exception; so is an HTTP error.
  state.fail = true;
  out = await run("browser_identity_proxy", {});
  assert.match(out, /^Verdict: The exit could not be reached through the current proxy \(Failed to fetch\)\nExpected route: through socks5:\/\/exit\.example:1080/m);
  assert.match(out, /^⚠ The exit could not be reached through the current proxy \(socks5:\/\/exit\.example:1080\): Failed to fetch — browsing through it fails too; check host, port and credentials, and the local agent host for SOCKS5\.$/m);
  state.fail = false;
  state.status = 503;
  assert.match(await run("browser_identity_proxy", {}), /^Verdict: The exit could not be reached through the current proxy \(HTTP 503\)$/m);
  state.status = 0;
  // The timeout aborts the request (a short one here; the tool uses 10 s).
  state.hang = true;
  assert.equal(U.TRACE_TIMEOUT, 10000);
  const t = await U.fetchTrace(5);
  assert.deepEqual([t.trace, t.error], [null, "timed out after 0.005 s"]);
  assert.ok(fetch.calls.at(-1).signal.aborted);
});

// ── The leak check ──

const MDNS = "candidate:1 1 udp 2122260223 a1b2c3d4-1234-5678-9abc-def012345678.local 54321 typ host generation 0 ufrag abcd network-cost 999";
const WINTER = Date.UTC(2026, 0, 15, 12); // standard time everywhere in the test zones: offsets are fixed
/** What probeLeaks() returns on a clean Windows desktop presenting profile "Work" (America/New_York, en-US). */
const CLEAN = {
  url: "http://localhost:4000/", title: "Whoami", now: WINTER,
  userAgent: WIN_UA, uaData: { brands: ["Chromium 136", "Google Chrome 136", "Not.A/Brand 99"], platform: "Windows", mobile: false }, platform: "Win32",
  language: "en-US", languages: ["en-US", "en"], timeZone: "America/New_York", tzOffset: 300,
  screen: { width: 2560, height: 1440, availWidth: 2560, availHeight: 1400 }, dpr: 1, inner: { width: 1600, height: 900 }, outer: { width: 1616, height: 1000 },
  webdriver: false, hardwareConcurrency: 24, deviceMemory: 32, plugins: 5, doNotTrack: null, maxTouchPoints: 0,
  webrtc: { supported: true, candidates: [MDNS], error: "" },
};
const EXPECT = { label: "Windows 11 — i7-13700K / RTX 4060", profile: "Work", timezone: "America/New_York", languages: ["en-US", "en"] };
/** The same machine with the real network and time zone showing through, automation visible, a stripped build. */
const LEAKY = {
  ...CLEAN, timeZone: "Europe/Berlin", tzOffset: -60, language: "en-US", languages: ["de-DE", "de"], webdriver: true, plugins: 0, deviceMemory: null,
  webrtc: { supported: true, candidates: [
    "candidate:1 1 udp 2122260223 192.168.1.5 54321 typ host generation 0",
    "candidate:2 1 udp 1686052607 203.0.113.7 54321 typ srflx raddr 192.168.1.5 rport 54321 generation 0",
    "candidate:3 1 udp 2122197247 fe80::1c2b:3d4e:5f60:7a8b 54322 typ host generation 0",
    MDNS,
  ], error: "" },
};

test("audit: leakFindings — a clean desktop passes every check, a leaking one is named in the verdict", () => {
  const { U } = setup();
  const clean = U.leakFindings(CLEAN, EXPECT);
  assert.deepEqual(plain(clean.risks), []);
  assert.equal(clean.verdict, "No risks found: WebRTC, time zone, languages, geometry, hardware and client hints look consistent");
  assert.deepEqual(plain(clean.lines), [
    "✓ WebRTC: 1 host candidate, all behind mDNS .local names — no raw IP",
    "✓ Time zone America/New_York (UTC−5), Date offset agrees, matches the device profile 'Windows 11 — i7-13700K / RTX 4060'",
    "✓ Languages en-US, en — navigator.language agrees, matches the device profile 'Windows 11 — i7-13700K / RTX 4060'",
    "✓ Geometry plausible: screen 2560×1440 · window 1600×900 in 1616×1000 · pixel ratio 1",
    "✓ navigator.webdriver: false",
    "✓ Hardware: 24 CPU threads · 32 GB memory",
    "✓ Plugins: 5",
    "✓ Do Not Track: unset (the common default)",
    "✓ Client hints (Chromium 136, Google Chrome 136, Not.A/Brand 99 · Windows) agree with the User-Agent",
    "✓ Touch points: 0 on a desktop User-Agent",
  ]);
  const leaky = U.leakFindings(LEAKY, EXPECT);
  assert.equal(leaky.verdict, "6 risks: WebRTC exposes 192.168.1.5, 203.0.113.7, fe80::1c2b:3d4e:5f60:7a8b; time zone Europe/Berlin while the profile says America/New_York; language en-US vs languages[0] de-DE; navigator.webdriver is true; deviceMemory missing; no plugins on desktop Chrome");
  assert.equal(leaky.lines[0], "⚠ WebRTC exposes 192.168.1.5 (private, host), 203.0.113.7 (public, srflx), fe80::1c2b:3d4e:5f60:7a8b (private, host) in its ICE candidates — a site reads these without asking; Chrome normally hides local addresses behind mDNS .local names");
  assert.equal(leaky.lines[1], "⚠ Time zone Europe/Berlin while the device profile 'Windows 11 — i7-13700K / RTX 4060' says America/New_York");
  assert.equal(leaky.lines[2], "⚠ navigator.language is en-US but navigator.languages starts with de-DE — an override applied to one and not the other");
  assert.equal(leaky.lines[4], "⚠ navigator.webdriver is true — the page can tell automation is attached");
  assert.equal(leaky.lines[5], "⚠ deviceMemory is missing on a Chromium User-Agent — Chrome always reports it");
  assert.equal(leaky.lines[6], "⚠ navigator.plugins is empty — desktop Chrome lists its PDF viewers; headless and stripped builds show none");
  assert.equal(leaky.lines.filter((l) => l.startsWith("⚠")).length, 6, "every ⚠ is a risk, nothing else is");
  // The verdict's shape with two risks.
  const two = U.leakFindings({ ...CLEAN, timeZone: "Europe/Berlin", tzOffset: -60, webrtc: { supported: true, candidates: ["candidate:1 1 udp 2122260223 192.168.1.5 54321 typ host generation 0"], error: "" } }, EXPECT);
  assert.equal(two.verdict, "2 risks: WebRTC exposes 192.168.1.5; time zone Europe/Berlin while the profile says America/New_York");
  // Without a profile only the page's own consistency counts.
  const alone = U.leakFindings({ ...CLEAN, timeZone: "Europe/Berlin", tzOffset: -60, language: "de-DE", languages: ["de-DE", "de"] }, {});
  assert.deepEqual(plain(alone.risks), []);
  assert.equal(alone.lines[1], "✓ Time zone Europe/Berlin (UTC+1), Date offset agrees");
  assert.equal(alone.lines[2], "✓ Languages de-DE, de — navigator.language agrees");
  // Profile language differing from a consistent page.
  assert.deepEqual(plain(U.leakFindings({ ...CLEAN, language: "de-DE", languages: ["de-DE", "de"] }, EXPECT).risks), ["language de-DE while the profile says en-US"]);
});

test("audit: leakFindings — the single checks", () => {
  const { U } = setup();
  const risks = (over, exp = EXPECT) => plain(U.leakFindings({ ...CLEAN, ...over }, exp).risks);
  const line = (over, i, exp = EXPECT) => U.leakFindings({ ...CLEAN, ...over }, exp).lines[i];
  // WebRTC: no API, no candidates, an error, only mDNS.
  assert.equal(line({ webrtc: { supported: false, candidates: [], error: "" } }, 0), "✓ WebRTC: RTCPeerConnection is not available in this page — nothing to leak");
  assert.equal(line({ webrtc: { supported: true, candidates: [], error: "" } }, 0), "✓ WebRTC: no ICE candidates gathered in 2 s — nothing exposed");
  assert.equal(line({ webrtc: { supported: true, candidates: [], error: "blocked" } }, 0), "✓ WebRTC: no ICE candidates gathered in 2 s (blocked) — nothing exposed");
  assert.equal(line({ webrtc: undefined }, 0), "✓ WebRTC: RTCPeerConnection is not available in this page — nothing to leak");
  assert.deepEqual(plain(U.webrtcLeaks(["candidate:1 1 udp 1 10.0.0.2 1 typ host", "candidate:2 1 tcp 1 10.0.0.2 2 typ host tcptype active", "candidate:3 1 udp 1 2001:db8::1 3 typ host", "garbage", MDNS])),
    [{ address: "10.0.0.2", scope: "private", type: "host" }, { address: "2001:db8::1", scope: "public", type: "host" }], "deduplicated, scoped, .local names ignored");
  assert.deepEqual(plain(U.candidateAddress("candidate:1 1 udp 2122260223 192.168.1.5 54321 typ host generation 0")), { address: "192.168.1.5", type: "host" });
  assert.deepEqual(plain(U.candidateAddress("")), { address: "", type: "" });
  // Time zone: a half-applied override (Intl says one zone, Date another offset), an unknown zone, none at all.
  assert.deepEqual(risks({ timeZone: "America/New_York", tzOffset: -60 }), ["time zone America/New_York vs Date offset UTC+1"]);
  assert.equal(line({ timeZone: "America/New_York", tzOffset: -60 }, 1), "⚠ Time zone America/New_York (UTC−5) but Date reports UTC+1 — a zone override that reached Intl and not Date");
  assert.deepEqual([U.zoneOffset("America/New_York", WINTER), U.zoneOffset("Europe/Berlin", WINTER), U.zoneOffset("Asia/Kolkata", WINTER), U.zoneOffset("Etc/UTC", WINTER), U.zoneOffset("Mars/Olympus", WINTER)], [300, -60, -330, 0, null]);
  assert.equal(line({ timeZone: "Mars/Olympus", tzOffset: 0 }, 1, {}), "✓ Time zone Mars/Olympus (UTC) — a zone this check does not know, offset not compared");
  assert.deepEqual(risks({ timeZone: "", tzOffset: 300 }), ["no time zone"]);
  // Languages.
  assert.deepEqual(risks({ language: "", languages: [] }), ["no languages"]);
  assert.deepEqual(risks({ language: "en-us", languages: ["en-US"] }), [], "case does not matter");
  assert.deepEqual(risks({ language: "en-US", languages: [] }), [], "an empty languages list is not a contradiction");
  // Geometry.
  assert.deepEqual(risks({ inner: { width: 3000, height: 900 } }), ["viewport larger than the screen"]);
  assert.deepEqual(risks({ outer: { width: 800, height: 600 } }), ["viewport larger than its window"]);
  assert.deepEqual(risks({ screen: { width: 1280, height: 800, availWidth: 1400, availHeight: 800 }, inner: { width: 1000, height: 700 }, outer: { width: 1000, height: 700 } }), ["avail larger than the screen"]);
  assert.deepEqual(risks({ dpr: 0 }), ["no devicePixelRatio"]);
  assert.deepEqual(risks({ screen: null }), ["no screen size"]);
  assert.deepEqual(risks({ outer: null }), [], "no outer size: not compared");
  // webdriver, hardware, plugins, DNT.
  assert.deepEqual(risks({ webdriver: null }), []);
  assert.equal(line({ webdriver: null }, 4), "✓ navigator.webdriver: not set");
  assert.deepEqual(risks({ hardwareConcurrency: null }), ["hardwareConcurrency missing"]);
  assert.deepEqual(risks({ userAgent: "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0", uaData: null, platform: "Linux x86_64", deviceMemory: null, plugins: 0 }, {}), [], "Firefox exposes neither deviceMemory nor plugins — not a risk");
  assert.equal(line({ userAgent: "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0", uaData: null, platform: "Linux x86_64", deviceMemory: null }, 5, {}), "✓ Hardware: 24 CPU threads · memory not exposed (normal outside Chromium)");
  assert.equal(line({ plugins: null }, 6), "✓ Plugins: navigator.plugins not available");
  assert.equal(line({ doNotTrack: "1" }, 7), "✓ Do Not Track: 1 — a rarer setting, part of the fingerprint");
  // Client hints vs the User-Agent: platform, mobile flag, version.
  assert.deepEqual(risks({ uaData: { ...CLEAN.uaData, platform: "Linux" } }), ["client hints Linux vs User-Agent Windows"]);
  assert.deepEqual(risks({ uaData: { ...CLEAN.uaData, mobile: true } }), ["client hints mobile vs User-Agent desktop", "mobile User-Agent without touch"], "a mobile hint on a desktop UA with no touch points: both checks speak up");
  assert.deepEqual(risks({ uaData: { ...CLEAN.uaData, brands: ["Chromium 131", "Google Chrome 131", "Not.A/Brand 99"] } }), ["client hints version 131 vs User-Agent 136"]);
  assert.equal(line({ uaData: null }, 8), "✓ Client hints: none (not a Chromium browser, or hints are off)");
  // Touch points vs the User-Agent.
  const PHONE = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Mobile Safari/537.36";
  const phone = { userAgent: PHONE, uaData: { brands: ["Chromium 136", "Google Chrome 136"], platform: "Android", mobile: true }, platform: "Linux armv8l", plugins: 0, maxTouchPoints: 5 };
  assert.deepEqual(risks(phone, {}), []);
  assert.equal(line(phone, 9, {}), "✓ Touch points: 5 on a mobile User-Agent");
  assert.equal(line(phone, 6, {}), "✓ Plugins: 0 (mobile browsers list none)");
  assert.deepEqual(risks({ ...phone, maxTouchPoints: 0 }, {}), ["mobile User-Agent without touch"]);
  assert.deepEqual(risks({ maxTouchPoints: 10 }), [], "a Windows touch laptop is fine");
  assert.equal(line({ maxTouchPoints: 10 }, 9), "✓ Touch points: 10 (a touch laptop)");
  const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
  assert.deepEqual(risks({ userAgent: MAC, uaData: { ...CLEAN.uaData, platform: "macOS" }, platform: "MacIntel", maxTouchPoints: 5 }, {}), ["macOS desktop with touch points"]);
  assert.deepEqual(risks({ maxTouchPoints: null }), []);
  assert.equal(line({ maxTouchPoints: null }, 9), "✓ Touch points: unknown on a desktop User-Agent");
});

test("audit: browser_identity_leaks injects one self-contained probe into the page's MAIN world and compares with the window's profile", async () => {
  const { run, log, session, local, chrome, U } = setup();
  chrome.scripting.result = (o) => (o.func.name === "probeLeaks" ? LEAKY : PAGE);
  const src = U.probeLeaks.toString();
  assert.doesNotMatch(src, /\b(H|T|X|WEBRTC_WAIT|TRACE_URL|osOfUa|plural)\b/, "the injected function closes over nothing of the module");
  assert.match(src, /RTCPeerConnection[\s\S]*iceServers: \[\][\s\S]*onicecandidate[\s\S]*setTimeout\(finish, 2000\)/, "host candidates only, cut off after 2 s");
  let out = await run("browser_identity_leaks", {});
  assert.deepEqual(log.scripts, [{ tabId: 5, world: "MAIN", func: "probeLeaks" }], "what the site itself sees");
  assert.equal(out.split("\n").slice(0, 4).join("\n"), [
    "Leak check for http://localhost:4000/ (Whoami)",
    "Verdict: 5 risks: WebRTC exposes 192.168.1.5, 203.0.113.7, fe80::1c2b:3d4e:5f60:7a8b; language en-US vs languages[0] de-DE; navigator.webdriver is true; deviceMemory missing; no plugins on desktop Chrome",
    "Compared with: no device profile on this window — the page's own consistency only",
    "⚠ WebRTC exposes 192.168.1.5 (private, host), 203.0.113.7 (public, srflx), fe80::1c2b:3d4e:5f60:7a8b (private, host) in its ICE candidates — a site reads these without asking; Chrome normally hides local addresses behind mDNS .local names",
  ].join("\n"));
  assert.match(out, /^✓ Time zone Europe\/Berlin \(UTC\+1\), Date offset agrees$/m, "without a profile the page's zone is only checked against itself");
  assert.doesNotMatch(out, /s3cr3t|alice/);
  // The window's device config: its time zone, and the owning profile's language when the config carries none.
  session["agentDeviceWindow:1"] = CFG;
  local.agentProfiles = { prof_1: { name: "Work", lang: "en-US,en;q=0.9", proxy: { enabled: true, host: "1.2.3.4", port: 8080, username: "user", password: "hunter2" } } };
  out = await run("browser_identity_leaks", {});
  assert.match(out, /^Verdict: 6 risks: WebRTC exposes [^;]+; time zone Europe\/Berlin while the profile says America\/New_York; language en-US vs languages\[0\] de-DE; /m);
  assert.match(out, /^Compared with: device profile 'Windows 11 — i7-13700K \/ RTX 4060' \(Work\), time zone America\/New_York, language en-US$/m);
  assert.doesNotMatch(out, /hunter2|ANGLE/);
  chrome.scripting.result = (o) => (o.func.name === "probeLeaks" ? CLEAN : PAGE);
  out = await run("browser_identity_leaks", {});
  assert.match(out, /^Verdict: No risks found: /m);
  assert.doesNotMatch(out, /^⚠/m);
  // A page that cannot be scripted, and one that does not answer.
  chrome.scripting.throws = new Error("Cannot access a chrome:// URL");
  await assert.rejects(run("browser_identity_leaks", {}), /can't be inspected — navigate to a regular website first\. \(Cannot access a chrome:\/\/ URL\)/);
  chrome.scripting.throws = null;
  chrome.scripting.result = null;
  await assert.rejects(run("browser_identity_leaks", {}), /The page did not answer/);
});

// ── The fingerprint check ──

const RTX = "ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Direct3D11 vs_5_0 ps_5_0, D3D11)";
/** What probeFingerprint() returns in a window presenting the win11 template (profile "Work"). */
const FP = {
  url: "http://localhost:4000/", title: "Whoami",
  canvas: { hash: "1a2b3c4d", error: "" },
  webgl: { vendor: "WebKit", renderer: "WebKit WebGL", unmaskedVendor: "Google Inc. (NVIDIA)", unmaskedRenderer: RTX, paramsHash: "deadbeef", extensions: 42, error: "" },
  audio: { hash: "0badf00d", sampleRate: 48000, error: "" },
  fonts: { present: ["Arial", "Calibri", "Segoe UI"], tested: 31, error: "" },
  screen: { width: 2560, height: 1440, colorDepth: 24 }, dpr: 1, hardwareConcurrency: 24, deviceMemory: 32,
  timeZone: "America/New_York", languages: ["en-US", "en"], maxTouchPoints: 0, plugins: 5, userAgent: WIN_UA, platform: "Win32",
};
/** The same probe on the real Linux machine. */
const FP_REAL = {
  ...FP, canvas: { hash: "99887766", error: "" },
  webgl: { vendor: "WebKit", renderer: "WebKit WebGL", unmaskedVendor: "Google Inc. (Intel)", unmaskedRenderer: "ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6)", paramsHash: "cafebabe", extensions: 38, error: "" },
  audio: { hash: "11112222", sampleRate: 44100, error: "" }, fonts: { present: ["DejaVu Sans", "Liberation Sans", "Ubuntu"], tested: 31, error: "" },
  screen: { width: 1280, height: 900, colorDepth: 24 }, hardwareConcurrency: 8, deviceMemory: 8, timeZone: "Europe/Berlin", languages: ["de-DE", "de"], userAgent: LINUX_UA, platform: "Linux x86_64",
};
const FP_EXP = { label: CFG.label, profile: "Work", source: "applied to this window", gpuVendor: "Google Inc. (NVIDIA)", gpuRenderer: RTX, threads: 24, memory: 32, screen: "2560×1440", colorDepth: 24, timezone: "America/New_York", languages: ["en-US", "en"], canvasNoise: true, audioNoise: true };
const PROFILE = "the device profile 'Windows 11 — i7-13700K / RTX 4060'";

test("audit: fnv1a is the 32-bit FNV-1a hash as 8 hex digits, and the probe inlines the same one", () => {
  const { U } = setup();
  assert.deepEqual([U.fnv1a(""), U.fnv1a("a"), U.fnv1a("foobar"), U.fnv1a("\u0000"), U.fnv1a(undefined), U.fnv1a(42)], ["811c9dc5", "e40c292c", "bf9cf968", "050c5d1f", "811c9dc5", U.fnv1a("42")]);
  assert.ok(U.fnv1a("x".repeat(100000)).length === 8);
  const inlined = /function fnv\(s\) \{[\s\S]*?\n    \}/.exec(U.probeFingerprint.toString());
  assert.ok(inlined, "the probe carries its own fnv");
  const fnv = new Function("return " + inlined[0])();
  assert.deepEqual([fnv(""), fnv("foobar")], ["811c9dc5", "bf9cf968"], "the same hash as the module's");
});

test("audit: fingerprintExpectations reduces a device config to what the probe should find", () => {
  const { U } = setup();
  assert.deepEqual(plain(U.fingerprintExpectations({ cfg: { ...CFG, audio: { sampleRate: 48000 }, webgl: { ...CFG.webgl, unmaskedVendor: "Google Inc. (NVIDIA)" } }, profile: { name: "Work", lang: "en-US,en;q=0.9" } })), FP_EXP);
  const e = U.fingerprintExpectations({ cfg: { id: "x", screen: {}, webgl: { vendor: "V", renderer: "R" }, langs: ["fr-FR"] }, profile: null, source: "elsewhere" });
  assert.deepEqual(plain(e), { label: "x", profile: "", source: "elsewhere", gpuVendor: "V", gpuRenderer: "R", threads: 0, memory: 0, screen: "", colorDepth: 0, timezone: "", languages: ["fr-FR"], canvasNoise: true, audioNoise: false });
  assert.deepEqual(plain(U.fingerprintExpectations(null)), { label: "", profile: "", source: "", gpuVendor: "", gpuRenderer: "", threads: 0, memory: 0, screen: "", colorDepth: 0, timezone: "", languages: [], canvasNoise: false, audioNoise: false });
  assert.equal(U.fingerprintExpectations({ cfg: null }).label, "");
});

test("audit: fingerprintFindings — a matching profile window passes, every difference is a ⚠, no profile means the real machine", () => {
  const { U } = setup();
  const clean = U.fingerprintFindings(FP, FP_EXP);
  assert.deepEqual(plain(clean.warnings), []);
  assert.match(clean.hash, /^[0-9a-f]{8}$/);
  assert.equal(clean.verdict, "Combined hash " + clean.hash + " — consistent with " + PROFILE);
  assert.deepEqual(plain(clean.lines), [
    "✓ Canvas hash 1a2b3c4d (300×150 scene: text, emoji, arcs, gradient) — noise on for " + PROFILE + ": stable for this profile, different from every other",
    "✓ WebGL Google Inc. (NVIDIA) · " + RTX + " · parameters hash deadbeef (42 extensions), matches " + PROFILE,
    "✓ Audio hash 0badf00d at 48000 Hz — noise on for " + PROFILE,
    "✓ Fonts: 3 of 31 common fonts present: Arial, Calibri, Segoe UI",
    "✓ Screen 2560×1440, 24-bit · pixel ratio 1, matches " + PROFILE,
    "✓ Hardware: 24 CPU threads · 32 GB memory, matches " + PROFILE,
    "✓ Time zone America/New_York, matches " + PROFILE,
    "✓ Languages en-US, en, matches " + PROFILE,
    "✓ Touch points 0 · plugins 5",
  ]);
  // The combined hash is stable for the same readings and changes with any one of them.
  assert.equal(U.fingerprintFindings({ ...FP }, {}).hash, clean.hash, "the expectations do not enter the hash");
  assert.notEqual(U.fingerprintFindings({ ...FP, canvas: { hash: "1a2b3c4e", error: "" } }, FP_EXP).hash, clean.hash);
  assert.notEqual(U.fingerprintFindings({ ...FP, fonts: { present: ["Arial"], tested: 31 } }, FP_EXP).hash, clean.hash);
  assert.notEqual(U.fingerprintFindings(FP_REAL, FP_EXP).hash, clean.hash);
  // The real machine in a window that should present the template: every difference named.
  const real = U.fingerprintFindings(FP_REAL, FP_EXP);
  assert.equal(real.verdict, "Combined hash " + real.hash + " — 5 warnings against " + PROFILE + ": GPU renderer differs from the profile; screen 1280×900 vs profile 2560×1440; CPU threads 8 vs profile 24; time zone Europe/Berlin vs profile America/New_York; language de-DE vs profile en-US");
  assert.equal(real.lines[1], "⚠ WebGL Google Inc. (Intel) · ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6) · parameters hash cafebabe (38 extensions) — " + PROFILE + " presents '" + RTX + "'");
  assert.equal(real.lines[4], "⚠ Screen 1280×900, 24-bit · pixel ratio 1 — " + PROFILE + " is 2560×1440");
  assert.equal(real.lines[5], "⚠ Hardware: 8 CPU threads · 8 GB memory — " + PROFILE + " has 24 threads");
  assert.equal(real.lines[6], "⚠ Time zone Europe/Berlin — " + PROFILE + " sets America/New_York");
  assert.equal(real.lines[7], "⚠ Languages de-DE, de — " + PROFILE + " says en-US");
  assert.equal(real.lines.filter((l) => l.startsWith("⚠")).length, 5);
  const one = U.fingerprintFindings({ ...FP, deviceMemory: 16 }, FP_EXP);
  assert.equal(one.verdict, "Combined hash " + one.hash + " — 1 warning against " + PROFILE + ": memory 16 GB vs profile 32 GB");
  assert.deepEqual(plain(U.fingerprintFindings({ ...FP, webgl: { ...FP.webgl, unmaskedVendor: "Google Inc. (AMD)" } }, FP_EXP).warnings), ["GPU vendor differs from the profile"]);
  // No profile: the readings stand on their own; nothing to match.
  const alone = U.fingerprintFindings(FP_REAL, {});
  assert.deepEqual(plain(alone.warnings), []);
  assert.equal(alone.verdict, "Combined hash " + alone.hash + " — no device profile on this window: the real machine's fingerprint");
  assert.equal(alone.lines[0], "✓ Canvas hash 99887766 (300×150 scene: text, emoji, arcs, gradient) — the real renderer's bytes, no profile noise");
  assert.equal(alone.lines[2], "✓ Audio hash 11112222 at 44100 Hz — the real device's samples");
  assert.equal(alone.lines[1], "✓ WebGL Google Inc. (Intel) · ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6) · parameters hash cafebabe (38 extensions)");
  // Noise flags, readings a site would find odd, missing values.
  assert.equal(U.fingerprintFindings(FP, { ...FP_EXP, audioNoise: false }).lines[2], "✓ Audio hash 0badf00d at 48000 Hz — no audio noise for " + PROFILE + ": the real device's samples");
  const broken = U.fingerprintFindings({ ...FP, canvas: { hash: "", error: "no 2d context" }, webgl: { error: "no WebGL context" }, audio: { hash: "", error: "timed out after 2 s" }, fonts: { present: [], tested: 0, error: "no 2d context" } }, FP_EXP);
  assert.deepEqual(plain(broken.warnings), ["canvas unreadable", "no WebGL", "no audio fingerprint", "fonts not measured"]);
  assert.equal(broken.lines[0], "⚠ Canvas: not readable (no 2d context) — a site expects every browser to render its canvas");
  assert.equal(broken.lines[1], "⚠ WebGL: not available (no WebGL context) — nearly every real desktop browser has it");
  assert.equal(broken.lines[2], "⚠ Audio: no fingerprint (timed out after 2 s)");
  const sparse = U.fingerprintFindings({ canvas: { hash: "abcdef01" }, webgl: { vendor: "V", renderer: "R", paramsHash: "" }, audio: { hash: "" }, fonts: {}, screen: null, languages: [] }, {});
  assert.deepEqual(plain(sparse.lines).slice(1), ["✓ WebGL V · R · parameters hash ? (0 extensions)", "✓ Audio hash ? — the real device's samples", "✓ Fonts: 0 of 0 common fonts present", "✓ Screen ? · pixel ratio ?", "✓ Hardware: ? CPU threads · memory not exposed", "✓ Time zone ?", "✓ Languages ?", "✓ Touch points unknown · plugins not available"]);
  assert.match(U.fingerprintFindings(undefined, undefined).verdict, /^Combined hash [0-9a-f]{8} — no device profile/);
});

test("audit: browser_identity_fingerprint injects one self-contained probe into the MAIN world and compares with the window's device config, else the active profile's template", async () => {
  const { run, log, session, local, chrome, U } = setup();
  chrome.scripting.result = (o) => (o.func.name === "probeFingerprint" ? FP_REAL : PAGE);
  const src = U.probeFingerprint.toString();
  assert.doesNotMatch(src, /\b(H|T|X|fnv1a|plural|dim|parseLangs|OS_NAMES)\b/, "the injected function closes over nothing of the module");
  assert.match(src, /c\.width = 300;[\s\S]*c\.height = 150;[\s\S]*fillText[\s\S]*createLinearGradient[\s\S]*\.arc\([\s\S]*toDataURL\(\)/, "a fixed scene on a 300×150 canvas, hashed from its data URL");
  assert.match(src, /WEBGL_debug_renderer_info[\s\S]*UNMASKED_VENDOR_WEBGL[\s\S]*UNMASKED_RENDERER_WEBGL/);
  for (const piece of [/OfflineAudioContext/, /createOscillator/, /createDynamicsCompressor/, /startRendering/, /getChannelData\(0\)/]) assert.match(src, piece);
  assert.match(src, /setTimeout\(function \(\) \{ end\("timed out after 2 s"\); \}, 2000\)/, "the audio rendering is cut off after 2 s");
  const fonts = /var FONTS = \[([\s\S]*?)\];/.exec(src)[1].split(",").length;
  assert.ok(fonts >= 28 && fonts <= 34, "about 30 fonts: " + fonts);
  assert.match(src, /measureText/);

  let out = await run("browser_identity_fingerprint", {});
  assert.deepEqual(log.scripts, [{ tabId: 5, world: "MAIN", func: "probeFingerprint" }], "what the site itself reads");
  const hash = U.fingerprintFindings(FP_REAL, {}).hash;
  assert.equal(out.split("\n").slice(0, 4).join("\n"), [
    "Fingerprint of http://localhost:4000/ (Whoami)",
    "Verdict: Combined hash " + hash + " — no device profile on this window: the real machine's fingerprint",
    "Compared with: no device profile on this window — the readings are the real machine's",
    "✓ Canvas hash 99887766 (300×150 scene: text, emoji, arcs, gradient) — the real renderer's bytes, no profile noise",
  ].join("\n"));
  assert.match(out, /\nDifferent hash = different device to the site; run it in another profile's tab to compare the two\.$/);
  assert.doesNotMatch(out, /s3cr3t|alice/);

  // The window's device config: the page still shows the real machine, so every difference is flagged; no credentials, no noise seed.
  session["agentDeviceWindow:1"] = { ...CFG, noiseSeed: "prof_1", audio: { sampleRate: 48000 } };
  local.agentProfiles = { prof_1: { name: "Work", lang: "en-US,en;q=0.9", proxy: { enabled: true, host: "1.2.3.4", port: 8080, username: "user", password: "hunter2" } } };
  out = await run("browser_identity_fingerprint", {});
  assert.match(out, /^Verdict: Combined hash [0-9a-f]{8} — 5 warnings against the device profile 'Windows 11 — i7-13700K \/ RTX 4060': GPU renderer differs from the profile; screen 1280×900 vs profile 2560×1440; CPU threads 8 vs profile 24; time zone Europe\/Berlin vs profile America\/New_York; language de-DE vs profile en-US$/m);
  assert.match(out, /^Compared with: device profile 'Windows 11 — i7-13700K \/ RTX 4060' \(Work\) — applied to this window: GPU ANGLE \(NVIDIA, NVIDIA GeForce RTX 4060 Direct3D11 vs_5_0 ps_5_0, D3D11\), 24 threads, 32 GB, screen 2560×1440, time zone America\/New_York, canvas noise on, audio noise on$/m);
  assert.doesNotMatch(out, /hunter2|prof_1/);
  // The same window once the page presents the template: consistent, and the hash differs from the real machine's.
  chrome.scripting.result = (o) => (o.func.name === "probeFingerprint" ? FP : PAGE);
  out = await run("browser_identity_fingerprint", {});
  assert.match(out, /^Verdict: Combined hash ([0-9a-f]{8}) — consistent with the device profile 'Windows 11 — i7-13700K \/ RTX 4060'$/m);
  assert.notEqual(/Combined hash ([0-9a-f]{8})/.exec(out)[1], hash);
  assert.doesNotMatch(out, /^⚠/m);
  // A config without an audio block: audio noise off, said so.
  session["agentDeviceWindow:1"] = CFG;
  out = await run("browser_identity_fingerprint", {});
  assert.match(out, /canvas noise on, audio noise off$/m);
  assert.match(out, /^✓ Audio hash 0badf00d at 48000 Hz — no audio noise for the device profile/m);
  // The runtime's deviceOf is the fallback for a tab the panel gave an identity directly.
  delete session["agentDeviceWindow:1"];
  const T2 = setup();
  T2.chrome.scripting.result = (o) => (o.func.name === "probeFingerprint" ? FP : PAGE);
  T2.T.device = { ...CFG, profileId: "" };
  assert.match(await T2.run("browser_identity_fingerprint", {}), /^Compared with: device profile 'Windows 11 — i7-13700K \/ RTX 4060' — applied to this window: /m);

  // A plain window with the engine at hand: the active profile's template is the yardstick, and the report says it is not applied here.
  const seen = [];
  const E = setup({ globals: { FingerprintEngine: { configFor: (p, id) => { seen.push([plain(p), id]); return p.device === "win11-i7-rtx4060" ? { ...CFG, audio: { sampleRate: 48000 } } : null; } } } });
  E.chrome.scripting.result = (o) => (o.func.name === "probeFingerprint" ? FP_REAL : PAGE);
  E.local.agentProfiles = { prof_1: { name: "Work", lang: "en-US", device: "win11-i7-rtx4060" }, prof_2: { name: "UA only", device: "none" } };
  E.local.agentActiveProfile = "prof_1";
  out = await E.run("browser_identity_fingerprint", {});
  assert.match(out, /^Compared with: device profile 'Windows 11 — i7-13700K \/ RTX 4060' \(Work\) — the active profile's template, not applied to this window — differences mean the profile is not in effect here: GPU /m);
  assert.match(out, /^Verdict: Combined hash [0-9a-f]{8} — 5 warnings against the device profile/m);
  assert.deepEqual(seen, [[{ name: "Work", lang: "en-US", device: "win11-i7-rtx4060" }, "prof_1"]]);
  E.local.agentActiveProfile = "prof_2";
  assert.match(await E.run("browser_identity_fingerprint", {}), /^Compared with: no device profile on this window — the readings are the real machine's$/m, "a UA-only profile has no template to compare with");
  delete E.local.agentActiveProfile;
  assert.match(await E.run("browser_identity_fingerprint", {}), /^Compared with: no device profile on this window/m);

  // A page that cannot be scripted, and one that does not answer.
  chrome.scripting.throws = new Error("Cannot access a chrome:// URL");
  await assert.rejects(run("browser_identity_fingerprint", {}), /can't be inspected — navigate to a regular website first\. \(Cannot access a chrome:\/\/ URL\)/);
  chrome.scripting.throws = null;
  chrome.scripting.result = null;
  await assert.rejects(run("browser_identity_fingerprint", {}), /The page did not answer/);
});

test("audit: tools and quick commands are registered under their names and group", () => {
  const { T, X } = setup();
  assert.deepEqual(Object.keys(T.registered), ["browser_identity_report", "browser_identity_proxy", "browser_identity_leaks", "browser_identity_fingerprint"]);
  const mine = X.commands.filter((c) => c.group === "Accounts");
  assert.deepEqual(mine.map((c) => c.name), ["What does this site see?", "Check my identity before signing in", "Check my exit IP", "Leak check this tab", "Fingerprint of this tab"]);
  assert.match(mine[1].prompt, /browser_identity_report[\s\S]*compare it with the device profile and proxy[\s\S]*mismatch/);
  assert.match(mine[2].prompt, /browser_identity_proxy[\s\S]*exit/);
  assert.match(mine[3].prompt, /browser_identity_leaks[\s\S]*⚠/);
  assert.match(mine[4].prompt, /browser_identity_fingerprint[\s\S]*canvas[\s\S]*combined hash/);
  for (const c of mine) assert.ok(c.icon && !c.partial, c.name);
});
