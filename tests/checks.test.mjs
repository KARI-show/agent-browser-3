// The "checks" extra (browser/extras/checks.js) against fakes of chrome.storage / tabs, of the tool
// runtime (AgentBrowserTools.register + helpers) and of fetch: the HEAD → GET fallback, redirects,
// 4xx/5xx, network errors and the timeout; the link collection filter and the reports; the 🔗 tab; the
// SEO audit and the speed report on fixed page data; the sitemap check against fake robots.txt/sitemaps;
// the accessibility and mobile audits on fixed page data; the redirect chain (manual redirects, the opaque
// case with and without webRequest) and the response headers against the fake fetch.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const CHECKS_JS = fileURLToPath(new URL("../browser/extras/checks.js", import.meta.url));
const plain = (x) => JSON.parse(JSON.stringify(x));

/**
 * A fetch answering from a route table: url → { status, headStatus, headers, redirectTo, fail, hang, delay, body (text),
 * setCookie (lines for getSetCookie), opaque (a redirect: manual mode gets an opaque response, follow mode lands on
 * redirectTo), hops ([{ url, status, location }] reported to hooks.redirect in follow mode, like webRequest) }.
 */
function fakeFetch(routes, hooks) {
  const calls = [];
  const f = async (url, init) => {
    init = init || {};
    calls.push({ url: String(url), method: init.method || "GET" });
    const r = routes[String(url)] || { status: 404 };
    if (r.delay) await new Promise((res) => setTimeout(res, r.delay));
    if (r.fail) throw new TypeError("Failed to fetch");
    if (r.hang) return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("The user aborted a request."), { name: "AbortError" }))));
    if (r.opaque && init.redirect === "manual") return { status: 0, ok: false, type: "opaqueredirect", url: String(url), redirected: false, headers: { get: () => null, forEach: () => {} }, body: null, text: async () => "" };
    if (r.hops && init.redirect !== "manual" && hooks && hooks.redirect) r.hops.forEach((h) => hooks.redirect({ requestId: "req-1", url: h.url, statusCode: h.status, redirectUrl: h.location, timeStamp: Date.now() }));
    let status = r.status === undefined ? 200 : r.status;
    if (init.method === "HEAD" && r.headStatus) status = r.headStatus;
    const headers = Object.fromEntries(Object.entries(r.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    const h = { get: (k) => (k.toLowerCase() in headers ? headers[k.toLowerCase()] : null), forEach: (fn) => Object.entries(headers).forEach(([k, v]) => fn(v, k)) };
    if (r.setCookie) h.getSetCookie = () => r.setCookie.slice();
    return { status, ok: status >= 200 && status < 300, url: r.redirectTo || String(url), redirected: !!r.redirectTo, headers: h, body: null, text: async () => (r.body == null ? "" : String(r.body)) };
  };
  f.calls = calls;
  return f;
}

/** Load checks.js the way extras.js is loaded in the panel, with a brand that has (or lacks) the feature. `page` is what an injected function returns, or a function of the injected function's name. */
function load({ brand = ["checks"], routes = {}, page = null, cookies = null, webRequest = false } = {}) {
  const data = {};
  const tools = {};
  const created = [];
  const inTopCalls = [];
  const cookieCalls = [];
  const redirectListeners = [];
  const chrome = {
    storage: {
      local: {
        async get(k) { const out = {}; for (const x of typeof k === "string" ? [k] : k) if (x in data) out[x] = plain(data[x]); return out; },
        async set(items) { Object.assign(data, plain(items)); },
      },
    },
    tabs: { async create(o) { created.push(o); return { id: 9 }; } },
  };
  // chrome.cookies (the stored cookies of an address) and chrome.webRequest (redirects of a followed request) only when a test asks.
  if (cookies) chrome.cookies = { async getAll(q) { cookieCalls.push(plain(q)); return plain(cookies); } };
  if (webRequest) chrome.webRequest = { onBeforeRedirect: { addListener: (fn) => redirectListeners.push(fn), removeListener: (fn) => { const i = redirectListeners.indexOf(fn); if (i >= 0) redirectListeners.splice(i, 1); } } };
  const fetch = fakeFetch(routes, { redirect: (d) => redirectListeners.slice().forEach((fn) => fn(d)) });
  const ctx = {
    console, setTimeout, clearTimeout, URL, AbortController, chrome, fetch,
    AGENT_BRAND: { has: (f) => brand.includes(f) },
    AgentBrowserTools: {
      register(name, fn) { if (tools[name]) throw new Error("Browser tool already defined: " + name); tools[name] = fn; },
      helpers: {
        text: (t) => [{ type: "text", text: t }],
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        async currentTab() { return { id: 1, url: "https://site.example/page" }; },
        async inTop(func, args) {
          inTopCalls.push({ func: func.name, args: plain(args) });
          const result = typeof page === "function" ? page(func.name, args) : page;
          if (!result) throw new Error("This page (chrome://newtab) can't be automated — navigate to a regular website first.");
          return plain(result);
        },
      },
    },
    AgentExtras: { tabs: [], commands: [] },
  };
  const context = vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(CHECKS_JS, "utf8"), context);
  const run = async (name, args) => (await tools[name](args)).filter((p) => p.type === "text").map((p) => p.text).join("\n");
  return { ctx, tools, data, fetch, created, inTopCalls, cookieCalls, redirectListeners, X: ctx.AgentExtras.checks, run };
}

// A fake DOM for the tab: ctx.el builds plain objects, textOf() reads them back.
function fakeEl(tag, props, children) {
  const n = { tag, props: props || {}, children: [], textContent: "" };
  // Like the real el(): a prop becomes a property of the node (value, placeholder, className, …).
  Object.keys(n.props).forEach((k) => { if (k.indexOf("on") !== 0) n[k] = n.props[k]; });
  n.appendChild = (c) => { n.children.push(c); return c; };
  n.addEventListener = (type, fn) => { n.props["on" + type] = fn; };
  (children || []).forEach((c) => { if (c != null) n.children.push(c); });
  return n;
}
const textOf = (n) => (typeof n === "string" ? n : [n.textContent, ...n.children.map(textOf)].join(" "));
function find(n, pred) {
  if (typeof n === "string") return null;
  if (pred(n)) return n;
  for (const c of n.children) { const h = find(c, pred); if (h) return h; }
  return null;
}
function panelCtx(statuses, prompts) {
  return { el: fakeEl, field: (l, i) => fakeEl("label", { className: "ed-label" }, [l, i]), ago: () => "just now", hostOf: (u) => u, status: (t, k) => statuses.push([t, k]), sendPrompt: (t) => prompts.push(t), currentTabUrl: async () => "https://site.example/page", rerender: () => {} };
}

const PAGE = {
  url: "https://site.example/page",
  title: "Site",
  origin: "https://site.example",
  links: [
    { url: "https://site.example/a", text: "A" },
    { url: "https://site.example/a", text: "A again" },
    { url: "https://site.example/missing", text: "Old docs" },
    { url: "https://site.example/moved", text: "Moved" },
    { url: "https://other.example/x", text: "Partner" },
    { url: "https://site.example/slow", text: "Slow report" },
    { url: "https://dead.example/", text: "Dead host" },
    { url: "mailto:a@b.c", text: "Mail" },
  ],
};
const ROUTES = {
  "https://site.example/a": { headers: { "content-type": "text/html; charset=utf-8", "content-length": "2048" } },
  "https://site.example/missing": { status: 404 },
  "https://site.example/moved": { redirectTo: "https://site.example/new", headers: { "content-type": "text/html" } },
  "https://other.example/x": {},
  "https://site.example/slow": { delay: 40 },
  "https://dead.example/": { fail: true },
};

// ── the brand switch ───────────────────────────────────────────────────────

test("a brand without the feature gets nothing: no tools, no tab, no commands, no helpers", () => {
  const { tools, ctx } = load({ brand: ["clips"] });
  assert.deepEqual(Object.keys(tools), []);
  assert.deepEqual(ctx.AgentExtras.tabs, []);
  assert.deepEqual(ctx.AgentExtras.commands, []);
  assert.equal(ctx.AgentExtras.checks, undefined);
});

test("with the feature: the nine tools, the 🔗 tab watching its storage key, the Monitoring quick commands", () => {
  const { tools, ctx } = load();
  assert.deepEqual(Object.keys(tools).sort(), ["browser_check_accessibility", "browser_check_headers", "browser_check_links", "browser_check_mobile", "browser_check_redirects", "browser_check_seo", "browser_check_sitemap", "browser_check_speed", "browser_check_url"]);
  assert.equal(ctx.AgentExtras.tabs.length, 1);
  assert.equal(ctx.AgentExtras.tabs[0].id, "checks");
  assert.equal(ctx.AgentExtras.tabs[0].label, "🔗 Checks");
  assert.deepEqual(plain(ctx.AgentExtras.tabs[0].storageKeys), ["agentLinkCheck"]);
  assert.equal(typeof ctx.AgentExtras.tabs[0].render, "function");
  assert.deepEqual(plain(ctx.AgentExtras.commands.map((c) => [c.group, c.name, !!c.partial])), [
    ["Monitoring", "Find broken links on this page", false],
    ["Monitoring", "Check this URL's status", true],
    ["Monitoring", "Check the links in the footer and navigation only", false],
    ["Monitoring", "SEO audit of this page", false],
    ["Monitoring", "Page speed report", false],
    ["Monitoring", "Check the sitemap", false],
    ["Monitoring", "Accessibility audit of this page", false],
    ["Monitoring", "Mobile readiness of this page", false],
    ["Monitoring", "Redirect chain of this URL", true],
    ["Monitoring", "Response headers of this page", false],
  ]);
  for (const c of ctx.AgentExtras.commands) assert.match(c.prompt, /browser_check_(url|links|seo|speed|sitemap|accessibility|mobile|redirects|headers)/, c.name + " names its tool");
});

// ── browser_check_url ──────────────────────────────────────────────────────

test("browser_check_url: one address — HEAD only, status, time, content type and size; https:// is added", async () => {
  const { run, fetch } = load({ routes: { "https://site.example/": { headers: { "Content-Type": "text/html; charset=utf-8", "Content-Length": "12345" } } } });
  const out = await run("browser_check_url", { url: "site.example" });
  assert.match(out, /^✓ 200  https:\/\/site\.example\/  —  \d+ ms, text\/html, 12\.1 kB$/);
  assert.deepEqual(fetch.calls, [{ url: "https://site.example/", method: "HEAD" }]);
});

test("browser_check_url: GET fallback when HEAD is refused (405/501) or fails; a redirect shows the final address", async () => {
  const { run, fetch } = load({
    routes: {
      "https://a.example/": { headStatus: 405, headers: { "content-type": "application/json" } },
      "https://b.example/": { headStatus: 501 },
      "https://c.example/old": { redirectTo: "https://c.example/new" },
      "https://dead.example/": { fail: true },
    },
  });
  assert.match(await run("browser_check_url", { url: "https://a.example/" }), /^✓ 200  https:\/\/a\.example\/  —  \d+ ms, application\/json$/);
  assert.deepEqual(fetch.calls.map((c) => c.method), ["HEAD", "GET"], "405 on HEAD → GET");
  fetch.calls.length = 0;
  assert.match(await run("browser_check_url", { url: "https://b.example/" }), /^✓ 200/);
  assert.deepEqual(fetch.calls.map((c) => c.method), ["HEAD", "GET"], "501 on HEAD → GET");
  fetch.calls.length = 0;
  assert.match(await run("browser_check_url", { url: "https://c.example/old" }), /^↪ 200  https:\/\/c\.example\/old → https:\/\/c\.example\/new  —  \d+ ms$/);
  assert.deepEqual(fetch.calls.map((c) => c.method), ["HEAD"], "a redirect followed by HEAD needs no GET");
  fetch.calls.length = 0;
  assert.match(await run("browser_check_url", { url: "https://dead.example/" }), /^✗ down: Failed to fetch  https:\/\/dead\.example\/  —  \d+ ms$/);
  assert.deepEqual(fetch.calls.map((c) => c.method), ["HEAD", "GET"], "a failed HEAD is retried as GET before the address counts as down");
});

test("browser_check_url: 4xx/5xx are broken, a hanging server is a timeout", async () => {
  const { run, X } = load({ routes: { "https://x.example/gone": { status: 404 }, "https://x.example/err": { status: 503 }, "https://slow.example/": { hang: true } } });
  assert.match(await run("browser_check_url", { url: "https://x.example/gone" }), /^✗ 404  https:\/\/x\.example\/gone  —  \d+ ms$/);
  assert.match(await run("browser_check_url", { url: "https://x.example/err" }), /^✗ 503  /);
  X.config.urlTimeout = 30; // the real one is 10 s
  const t0 = Date.now();
  assert.match(await run("browser_check_url", { url: "https://slow.example/" }), /^✗ down: timeout after 0\.03 s  https:\/\/slow\.example\/  —  \d+ ms$/);
  assert.ok(Date.now() - t0 < 2000, "aborted by the timeout, not by the test's patience");
});

test("browser_check_url: a list gets counts and one line per address; input limits", async () => {
  const { run } = load({ routes: { "https://a.example/": {}, "https://b.example/": { redirectTo: "https://b.example/home" }, "https://c.example/": { status: 500 } } });
  const out = await run("browser_check_url", { urls: ["https://a.example/", "https://b.example/", "https://c.example/"] });
  assert.match(out, /^Checked 3 addresses: 1 ok, 1 redirected, 1 broken\.\n✓ 200  https:\/\/a\.example\/  —  \d+ ms\n↪ 200  https:\/\/b\.example\/ → https:\/\/b\.example\/home  —  \d+ ms\n✗ 500  https:\/\/c\.example\/  —  \d+ ms$/);
  // url + urls are combined, url first.
  assert.match(await run("browser_check_url", { url: "https://c.example/", urls: ["https://a.example/"] }), /^Checked 2 addresses: 1 ok, 0 redirected, 1 broken\.\n✗ 500/);
  await assert.rejects(run("browser_check_url", {}), /url is required/);
  await assert.rejects(run("browser_check_url", { urls: Array.from({ length: 21 }, (_, i) => `https://x${i}.example/`) }), /At most 20 addresses/);
  await assert.rejects(run("browser_check_url", { url: "ftp://files.example/" }), /Not an http\(s\) address: ftp:/);
  await assert.rejects(run("browser_check_url", { url: "javascript:alert(1)" }), /Not an http\(s\) address/);
});

// ── browser_check_links ────────────────────────────────────────────────────

test("browser_check_links: the page's links deduplicated and checked, broken first, redirects, slowest; the result is stored", async () => {
  const { run, data, inTopCalls, fetch } = load({ routes: ROUTES, page: PAGE });
  const out = await run("browser_check_links", {});
  assert.deepEqual(inTopCalls, [{ func: "collectLinks", args: ["", 3000] }], "the top frame is read once, without a selector");
  assert.match(out, new RegExp(
    '^Checked 6 links on "Site" \\(https://site\\.example/page\\): 3 ok, 1 redirected, 2 broken\\.\n' +
    'Broken:\n  ✗ 404  "Old docs" → https://site\\.example/missing  \\(\\d+ ms\\)\n  ✗ down: Failed to fetch  "Dead host" → https://dead\\.example/\n' +
    'Redirected:\n  ↪ "Moved" https://site\\.example/moved → https://site\\.example/new  \\(200\\)\n' +
    "Slowest:\n  \\d+ ms  https://site\\.example/slow\n"
  ));
  assert.equal(fetch.calls.filter((c) => c.url === "https://site.example/a").length, 1, "the duplicate link is checked once");
  assert.equal(fetch.calls.filter((c) => c.url === "https://dead.example/").length, 2, "HEAD then GET for the dead host");
  const saved = data.agentLinkCheck;
  assert.ok(saved && saved.at > 0);
  assert.equal(saved.url, "https://site.example/page");
  assert.equal(saved.title, "Site");
  assert.deepEqual(saved.counts, { ok: 3, redirected: 1, broken: 2 });
  assert.equal(saved.checked, 6);
  assert.deepEqual(saved.leftOut, { external: 0, over: 0, other: 1 }, "the mailto: link is left out silently");
  assert.deepEqual(saved.results.map((r) => [r.url, r.status, r.ok, r.text]), [
    ["https://site.example/a", 200, true, "A"],
    ["https://site.example/missing", 404, false, "Old docs"],
    ["https://site.example/moved", 200, true, "Moved"],
    ["https://other.example/x", 200, true, "Partner"],
    ["https://site.example/slow", 200, true, "Slow report"],
    ["https://dead.example/", 0, false, "Dead host"],
  ]);
  assert.equal(saved.results[2].finalUrl, "https://site.example/new");
  assert.equal(saved.results[5].error, "Failed to fetch");
});

test("browser_check_links: sameOriginOnly / includeExternal=false leave external links out and say so; selector narrows the page", async () => {
  const { run, inTopCalls, fetch } = load({ routes: ROUTES, page: PAGE });
  let out = await run("browser_check_links", { sameOriginOnly: true });
  assert.match(out, /^Checked 4 links on "Site" \(https:\/\/site\.example\/page\): 2 ok, 1 redirected, 1 broken\. Left out: 2 external \(sameOriginOnly\)\./);
  assert.equal(fetch.calls.filter((c) => !c.url.startsWith("https://site.example/")).length, 0, "no request leaves the page's origin");
  out = await run("browser_check_links", { includeExternal: false });
  assert.match(out, /^Checked 4 links .* Left out: 2 external/);
  await run("browser_check_links", { selector: "footer, nav" });
  assert.deepEqual(inTopCalls.at(-1).args, ["footer, nav", 3000]);
  assert.match(await run("browser_check_links", { selector: "footer" }), /^Checked 6 links on "Site" \(https:\/\/site\.example\/page\) within footer:/);
});

test("browser_check_links: a page that can't be scripted, or without links", async () => {
  const { run } = load({ routes: ROUTES, page: null });
  await assert.rejects(run("browser_check_links", {}), /can't be automated/);
  const empty = load({ page: { url: "https://e.example/", title: "Empty", origin: "https://e.example", links: [] } });
  assert.equal(await empty.run("browser_check_links", {}), 'No http(s) links to check on "Empty" (https://e.example/).');
  assert.deepEqual(plain(empty.data.agentLinkCheck.results), []);
});

// ── helpers ────────────────────────────────────────────────────────────────

test("filterLinks: http(s) only, #fragment dropped, deduplicated, external filter, the cap", () => {
  const { X } = load();
  const links = [
    { url: "https://s.example/a#top", text: "  A  one " },
    { url: "https://s.example/a", text: "A" },
    { url: "https://s.example/a#other", text: "A" },
    { url: "http://s.example/b", text: "B" },
    { url: "https://ext.example/", text: "E" },
    { url: "mailto:x@y.z", text: "M" },
    { url: "javascript:void(0)", text: "J" },
    { url: "not a url", text: "N" },
    { url: "https://s.example/c", text: "C" },
  ];
  let r = plain(X.filterLinks(links, { origin: "https://s.example" }));
  assert.deepEqual(r.links.map((l) => l.url), ["https://s.example/a", "http://s.example/b", "https://ext.example/", "https://s.example/c"]);
  assert.equal(r.links[0].text, "A one", "whitespace collapsed");
  assert.deepEqual(r.leftOut, { external: 0, over: 0, other: 3 });
  r = plain(X.filterLinks(links, { origin: "https://s.example", sameOriginOnly: true }));
  assert.deepEqual(r.links.map((l) => l.url), ["https://s.example/a", "https://s.example/c"], "http:// on the same host is another origin");
  assert.deepEqual(r.leftOut, { external: 2, over: 0, other: 3 });
  r = plain(X.filterLinks(links, { origin: "https://s.example", includeExternal: false, max: 1 }));
  assert.deepEqual(r.links.map((l) => l.url), ["https://s.example/a"]);
  assert.equal(r.leftOut.over, 1);
  assert.equal(X.MAX_LINKS, 150);
  assert.deepEqual(plain(X.filterLinks([], {})), { links: [], leftOut: { external: 0, over: 0, other: 0 } });
});

test("summarize, formatUrlResult, fmtBytes, parseHttp", () => {
  const { X } = load();
  const results = [
    { url: "https://a/", status: 200, ok: true, ms: 50, type: "text/html", length: 500 },
    { url: "https://b/", status: 200, ok: true, redirected: true, finalUrl: "https://b/home", ms: 300 },
    { url: "https://c/", status: 404, ok: false, ms: 20 },
    { url: "https://d/", status: 0, ok: false, error: "Failed to fetch", ms: 5 },
    { url: "https://e/", status: 200, ok: true, ms: 120, length: 2 * 1048576 },
  ];
  const s = plain(X.summarize(results, 2));
  assert.deepEqual(s.counts, { ok: 2, redirected: 1, broken: 2 });
  assert.deepEqual(s.broken.map((r) => r.url), ["https://c/", "https://d/"]);
  assert.deepEqual(s.redirected.map((r) => r.url), ["https://b/"]);
  assert.deepEqual(s.slowest.map((r) => r.url), ["https://b/", "https://e/"], "the slowest answered ones, never a failed request");
  assert.equal(X.formatUrlResult(results[0]), "✓ 200  https://a/  —  50 ms, text/html, 500 B");
  assert.equal(X.formatUrlResult(results[1]), "↪ 200  https://b/ → https://b/home  —  300 ms");
  assert.equal(X.formatUrlResult(results[2]), "✗ 404  https://c/  —  20 ms");
  assert.equal(X.formatUrlResult(results[3]), "✗ down: Failed to fetch  https://d/  —  5 ms");
  assert.equal(X.formatUrlResult(results[4]), "✓ 200  https://e/  —  120 ms, 2.0 MB");
  assert.equal(X.fmtBytes(1536), "1.5 kB");
  assert.equal(X.fmtBytes(null), "");
  assert.equal(X.parseHttp("example.com/x?y=1"), "https://example.com/x?y=1");
  assert.equal(X.parseHttp("HTTP://Example.com"), "http://example.com/");
  assert.equal(X.parseHttp("ftp://example.com"), "");
  assert.equal(X.parseHttp(""), "");
  assert.equal(X.parseHttp("   "), "");
});

test("runPool: at most `limit` in flight, results in input order, progress reported, a thrown error becomes a down result", async () => {
  const { X } = load();
  let inFlight = 0, peak = 0;
  const progress = [];
  const items = Array.from({ length: 10 }, (_, i) => ({ url: "u" + i }));
  const results = plain(await X.runPool(items, 3, async (it, i) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5 + ((i * 7) % 11)));
    inFlight--;
    if (i === 4) throw new Error("boom");
    return { url: it.url, i };
  }, (done, total) => progress.push([done, total])));
  assert.equal(peak, 3);
  assert.deepEqual(results.map((r) => r.url), items.map((it) => it.url));
  assert.deepEqual(results[4], { url: "u4", status: 0, ok: false, error: "boom", ms: 0 });
  assert.deepEqual(progress.map((p) => p[0]), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.ok(progress.every((p) => p[1] === 10));
  assert.deepEqual(plain(await X.runPool([], 6, async () => 1)), []);
});

// ── the 🔗 tab ─────────────────────────────────────────────────────────────

test("the tab renders the last result (broken first, Open buttons), runs a page check live and checks a single URL", async () => {
  const { ctx, data, created, X } = load({ routes: ROUTES, page: PAGE });
  const statuses = [], prompts = [];
  const pctx = panelCtx(statuses, prompts);
  const tab = ctx.AgentExtras.tabs[0];
  // Nothing checked yet.
  let content = fakeEl("div");
  await tab.render(content, pctx);
  let txt = textOf(content);
  assert.match(txt, /Check the links on this page/);
  assert.match(txt, /Check a URL…/);
  assert.match(txt, /No link check yet\./);
  // Run the page check from the tab: live progress, then the stored result.
  const item = find(content, (n) => n.props.className === "cmd-item" && typeof n.props.onclick === "function");
  await item.props.onclick();
  assert.ok(statuses.some(([t]) => /^Checking links… \d+ \/ 6$/.test(t)), "progress is shown: " + JSON.stringify(statuses));
  assert.deepEqual(statuses.at(-1), ["✗ 2 broken links of 6.", "bad"]);
  assert.deepEqual(data.agentLinkCheck.counts, { ok: 3, redirected: 1, broken: 2 });
  // A fresh render shows the stored result, broken links first, each with an Open button.
  content = fakeEl("div");
  await tab.render(content, pctx);
  txt = textOf(content);
  assert.match(txt, /Last check · just now/);
  assert.match(txt, /6 links · 3 ok · 1 redirected · 2 broken/);
  const names = [];
  (function walk(n) { if (typeof n === "string") return; if (n.props.className === "cmd-name") names.push(textOf(n).trim()); n.children.forEach(walk); })(content);
  assert.deepEqual(names, ["Check the links on this page", "Site", "Old docs", "Dead host", "Moved", "A", "Partner", "Slow report"]);
  assert.match(txt, /HTTP 404 · \d+ ms · https:\/\/site\.example\/missing/);
  assert.match(txt, /down: Failed to fetch · \d+ ms · https:\/\/dead\.example\//);
  const open = find(content, (n) => n.props.title === "Open the link in a new tab");
  open.props.onclick();
  assert.deepEqual(plain(created), [{ url: "https://site.example/missing" }]);
  // "Discuss in chat" sends the report.
  find(content, (n) => n.tag === "button" && n.children[0] === "💬 Discuss in chat").props.onclick();
  assert.match(prompts[0], /^Here is the last link check of https:\/\/site\.example\/page:\n\nChecked 6 links/);
  // Check a URL…
  const input = find(content, (n) => n.tag === "input");
  const go = find(content, (n) => n.tag === "button" && n.children[0] === "Check");
  input.value = "site.example/missing";
  await go.props.onclick();
  assert.deepEqual(statuses.at(-1), ["✗ HTTP 404", "bad"]);
  const line = find(content, (n) => n.className === "cmd-desc mono bad" && /^✗ 404/.test(n.textContent));
  assert.ok(line, "the result line is shown under the field, marked bad");
  input.value = "site.example/a";
  await go.props.onclick();
  assert.deepEqual(statuses.at(-1), ["✓ HTTP 200", "good"]);
  assert.match(line.textContent, /^✓ 200  https:\/\/site\.example\/a  —  \d+ ms, text\/html, 2\.0 kB$/);
  assert.equal(line.className, "cmd-desc mono", "no longer marked bad");
});

test("the tab: an unknown host answers 404 from the fake, an empty field is refused", async () => {
  const { ctx } = load({ routes: {}, page: PAGE });
  const statuses = [], prompts = [];
  const pctx = panelCtx(statuses, prompts);
  const content = fakeEl("div");
  await ctx.AgentExtras.tabs[0].render(content, pctx);
  const input = find(content, (n) => n.tag === "input");
  const go = find(content, (n) => n.tag === "button" && n.children[0] === "Check");
  input.value = "   ";
  await go.props.onclick();
  assert.deepEqual(statuses.at(-1), ["⚠ Enter an http(s) address.", "bad"]);
  input.value = "https://whatever.example/";
  await go.props.onclick();
  assert.deepEqual(statuses.at(-1), ["✗ HTTP 404", "bad"]);
});

test("formatLinkReport caps the redirect list and omits sections that are empty", () => {
  const { X } = load();
  const results = Array.from({ length: 17 }, (_, i) => ({ url: `https://s.example/r${i}`, status: 200, ok: true, redirected: true, finalUrl: `https://s.example/n${i}`, ms: 10 + i, text: "R" + i }));
  const out = X.formatLinkReport({ url: "https://s.example/", title: "", results, leftOut: { external: 2, over: 3, other: 0 } });
  assert.match(out, /^Checked 17 links on https:\/\/s\.example\/: 0 ok, 17 redirected, 0 broken\. Left out: 2 external \(sameOriginOnly\), 3 over the limit of 150\.\nRedirected:\n/);
  assert.match(out, /\n  … 2 more\nSlowest:\n  26 ms  https:\/\/s\.example\/r16\n/);
  assert.doesNotMatch(out, /Broken:/);
  const one = X.formatLinkReport({ url: "https://s.example/", title: "One", selector: "footer", results: [{ url: "https://s.example/x", status: 200, ok: true, ms: 3, text: "X" }] });
  assert.equal(one, 'Checked 1 link on "One" (https://s.example/) within footer: 1 ok, 0 redirected, 0 broken.');
});

// ── browser_check_seo ──────────────────────────────────────────────────────

const SEO_GOOD = {
  url: "https://site.example/page", host: "site.example",
  title: "Beacon — page monitor and browser agent for teams", // 49 chars
  description: "Beacon watches pages and sites for you: content changes, uptime and broken links, with notifications and Telegram.", // 114 chars
  canonical: "https://site.example/page", canonicalHost: "site.example",
  robots: "index, follow", viewport: true, lang: "en",
  h1: ["Welcome to Beacon"], h1Count: 1, h2: 3, h3: 4,
  images: { total: 4, noAlt: 0, samples: [] },
  links: { total: 20, internal: 15, external: 5, nofollow: 2 },
  og: { title: true, description: true, image: true }, twitterCard: "summary_large_image",
  ld: { count: 1, types: ["Organization", "WebSite"] },
  words: 850, hreflang: 2,
};
const SEO_BAD = {
  url: "https://site.example/bad", host: "site.example",
  title: "Home", description: null,
  canonical: "https://other.example/bad", canonicalHost: "other.example",
  robots: "noindex, nofollow", viewport: false, lang: "",
  h1: ["One", "Two"], h1Count: 2, h2: 0, h3: 0,
  images: { total: 9, noAlt: 7, samples: ["a.png", "b.png", "c.png", "d.png", "e.png"] },
  links: { total: 0, internal: 0, external: 0, nofollow: 0 },
  og: { title: true, description: false, image: false }, twitterCard: null,
  ld: { count: 0, types: [] }, words: 120, hreflang: 0,
};

test("seoFindings: a well-made page passes all 12 checks; the details carry the numbers", () => {
  const { X } = load();
  const f = plain(X.seoFindings(SEO_GOOD));
  assert.equal(f.length, 12);
  assert.deepEqual(f.map((x) => x.name), ["title", "meta description", "canonical", "meta robots", "viewport", "html lang", "headings", "images", "links", "social cards", "structured data", "content"]);
  assert.ok(f.every((x) => x.ok), JSON.stringify(f.filter((x) => !x.ok)));
  assert.equal(f[0].detail, '"Beacon — page monitor and browser agent for teams" (49 chars)');
  assert.equal(f[1].detail, '114 chars: "Beacon watches pages and sites for you: content changes, uptime and broken links, with notification…"', "the quoted description is cut at 100 chars");
  assert.equal(f[2].detail, "https://site.example/page");
  assert.equal(f[3].detail, "index, follow");
  assert.equal(f[5].detail, "lang=en, 2 hreflang alternates");
  assert.equal(f[6].detail, '1 h1: "Welcome to Beacon"; 3 h2s, 4 h3s');
  assert.equal(f[7].detail, "4 images, all with alt");
  assert.equal(f[8].detail, "20 http(s) links: 15 internal, 5 external, 2 nofollow");
  assert.equal(f[9].detail, "Open Graph complete (title, description, image); Twitter card summary_large_image");
  assert.equal(f[10].detail, "1 ld+json block: Organization, WebSite");
  assert.equal(f[11].detail, "850 words of visible text");
});

test("seoFindings: every warning fires on a bad page — short title, missing description, canonical on another host, noindex, no viewport/lang, two h1, missing alt, no links, incomplete Open Graph, no ld+json, thin text", () => {
  const { X } = load();
  const f = plain(X.seoFindings(SEO_BAD));
  assert.equal(f.length, 12);
  assert.ok(f.every((x) => !x.ok), JSON.stringify(f.filter((x) => x.ok)));
  assert.equal(f[0].detail, '"Home" (4 chars, short — aim for 30–60)');
  assert.equal(f[1].detail, "missing");
  assert.equal(f[2].detail, "https://other.example/bad — points to another host (other.example)");
  assert.equal(f[3].detail, "noindex, nofollow — search engines are told not to index/follow this page");
  assert.equal(f[4].detail, "no meta viewport — not mobile-friendly");
  assert.equal(f[5].detail, "missing");
  assert.equal(f[6].detail, '2 h1s — keep to one: "One", "Two"; 0 h2s, 0 h3s');
  assert.equal(f[7].detail, "9 images, 7 without alt: a.png, b.png, c.png, d.png, e.png, …");
  assert.equal(f[8].detail, "0 http(s) links: 0 internal, 0 external, 0 nofollow");
  assert.equal(f[9].detail, "Open Graph missing og:description, og:image; Twitter card none");
  assert.equal(f[10].detail, "none (no ld+json)");
  assert.equal(f[11].detail, "120 words of visible text — thin, under 300");
  // The in-between cases: a long title, a long description, no h1, a canonical without a host, an empty page object.
  const long = plain(X.seoFindings({ ...SEO_GOOD, title: "x".repeat(61), description: "y".repeat(161), h1: [], h1Count: 0, canonical: "/page", canonicalHost: null }));
  assert.deepEqual([long[0].ok, long[1].ok, long[2].ok, long[6].ok], [false, false, true, false]);
  assert.match(long[0].detail, /\(61 chars, long — aim for 30–60\)$/);
  assert.match(long[1].detail, /^161 chars, long — aim for 70–160: "y{99}…"$/);
  assert.equal(long[6].detail, "0 h1s — add one; 3 h2s, 4 h3s");
  const empty = plain(X.seoFindings({}));
  assert.equal(empty.length, 12);
  assert.deepEqual([empty[0].detail, empty[1].detail, empty[2].detail, empty[3].detail], ["missing", "missing", "missing", "none (indexable)"]);
  assert.equal(empty[3].ok, true, "no robots meta is fine");
});

test("browser_check_seo: one injected read of the top frame, the report with ✓/⚠ lines and the verdict", async () => {
  const { run, inTopCalls } = load({ page: (func) => (func === "readSeo" ? SEO_GOOD : null) });
  const out = await run("browser_check_seo", {});
  assert.deepEqual(inTopCalls, [{ func: "readSeo", args: [] }]);
  const lines = out.split("\n");
  assert.equal(lines[0], "SEO audit of https://site.example/page — 12 checks: 12 ok, 0 warnings.");
  assert.equal(lines.length, 13);
  assert.ok(lines.slice(1).every((l) => l.startsWith("✓ ")), out);
  const bad = load({ page: (func) => (func === "readSeo" ? SEO_BAD : null) });
  const report = await bad.run("browser_check_seo", {});
  assert.equal(report.split("\n")[0], "SEO audit of https://site.example/bad — 12 checks: 0 ok, 12 warnings.");
  assert.match(report, /\n⚠ title: "Home" \(4 chars, short — aim for 30–60\)\n⚠ meta description: missing\n/);
  const mixed = load({ page: () => ({ ...SEO_GOOD, viewport: false }) });
  assert.match(await mixed.run("browser_check_seo", {}), /12 checks: 11 ok, 1 warning\.\n/);
  await assert.rejects(load({ page: null }).run("browser_check_seo", {}), /can't be automated/);
});

// ── browser_check_speed ────────────────────────────────────────────────────

const PERF = {
  url: "https://site.example/page", navType: "reload",
  ttfb: 950.4, domInteractive: 800, dcl: 900.2, load: 1400, fp: 500, fcp: 520.6, lcp: 900,
  docSize: 30 * 1024, resourceCount: 7,
  resources: [
    { name: "https://site.example/app.js", initiatorType: "script", duration: 820, transferSize: 310 * 1024, encodedBodySize: 900000 },
    { name: "https://cdn.example/lib.min.js?v=2", initiatorType: "link", duration: 100, transferSize: 0, encodedBodySize: 0 },
    { name: "https://site.example/style.css", initiatorType: "link", duration: 60, transferSize: 20 * 1024, encodedBodySize: 50000 },
    { name: "https://site.example/hero.webp", initiatorType: "css", duration: 300, transferSize: 400 * 1024 },
    { name: "https://site.example/fonts/inter.woff2", initiatorType: "css", duration: 120, transferSize: 90 * 1024 },
    { name: "https://api.example/data", initiatorType: "fetch", duration: 450, transferSize: 5 * 1024 },
    { name: "https://site.example/manifest.json", initiatorType: "other", duration: 10, transferSize: 1024 },
  ],
};

test("speedReport: flags, timings in ms, resources grouped by initiator type / extension in kB, the 5 slowest", () => {
  const { X } = load();
  const lines = X.speedReport(PERF).split("\n");
  assert.deepEqual(lines.slice(0, 5), [
    "Page speed of https://site.example/page (reload) — 4 checks: 3 ok, 1 warning.",
    "⚠ TTFB: 950 ms (over 800 ms)",
    "✓ load: 1400 ms",
    "✓ transfer: 856 kB; 1 cross-origin resource without a size (no Timing-Allow-Origin)",
    "✓ requests: 8",
  ]);
  assert.equal(lines[5], "Timing: TTFB 950 ms · DOM interactive 800 ms · DOMContentLoaded 900 ms · load 1400 ms · first paint 500 ms · first contentful paint 521 ms · LCP 900 ms");
  assert.equal(lines[6], "Resources: 7 + the document (30 kB), 856 kB in all: script 2 (310 kB), css 1 (20 kB), img 1 (400 kB), font 1 (90 kB), xhr/fetch 1 (5.0 kB), other 1 (1.0 kB)");
  assert.deepEqual(lines.slice(7), [
    "Slowest resources:",
    "  820 ms  310 kB  https://site.example/app.js",
    "  450 ms  5.0 kB  https://api.example/data",
    "  300 ms  400 kB  https://site.example/hero.webp",
    "  120 ms  90 kB  https://site.example/fonts/inter.woff2",
    "  100 ms  0.0 kB  https://cdn.example/lib.min.js?v=2",
  ]);
  // Grouping: the initiator decides for xhr/fetch, the extension for fonts and images loaded from CSS, preloads by extension.
  assert.deepEqual(PERF.resources.map(X.resourceGroup), ["script", "script", "css", "img", "font", "xhr/fetch", "other"]);
  assert.equal(X.resourceGroup({ name: "https://x/bg.png", initiatorType: "css" }), "img");
  assert.equal(X.resourceGroup({ name: "https://x/a.b.c/no-extension", initiatorType: "xmlhttprequest" }), "xhr/fetch");
  assert.equal(X.resourceGroup({ name: "https://x/track", initiatorType: "beacon" }), "xhr/fetch");
  assert.equal(X.resourceGroup({ name: "https://x/video.mp4", initiatorType: "video" }), "other");
  assert.equal(X.resourceGroup({ name: "not a url", initiatorType: "img" }), "img");
});

test("speedReport: a heavy page trips load, transfer and request counts; a page still loading, without paints or LCP", () => {
  const { X } = load();
  const heavy = X.speedReport({
    url: "https://heavy.example/", navType: "navigate", ttfb: 100, domInteractive: 2000, dcl: 2500, load: 5000, fp: 900, fcp: 950, lcp: 4100,
    docSize: 0, resourceCount: 150,
    resources: [1, 2, 3].map((i) => ({ name: `https://heavy.example/big${i}.jpg`, initiatorType: "img", duration: 1000 * i, transferSize: 1.5 * 1048576 })),
  }).split("\n");
  assert.deepEqual(heavy.slice(0, 5), [
    "Page speed of https://heavy.example/ (navigate) — 4 checks: 1 ok, 3 warnings.",
    "✓ TTFB: 100 ms",
    "⚠ load: 5000 ms (over 3000 ms)",
    "⚠ transfer: 4608 kB (over 3072 kB)",
    "⚠ requests: 151 (over 100); the first 3 resources are detailed",
  ]);
  assert.equal(heavy[6], "Resources: 3 + the document (0.0 kB), 4608 kB in all: script 0 (0.0 kB), css 0 (0.0 kB), img 3 (4608 kB), font 0 (0.0 kB), xhr/fetch 0 (0.0 kB), other 0 (0.0 kB)");
  assert.equal(heavy.length, 11, "three slowest lines");
  const loading = X.speedReport({ url: "https://x.example/", ttfb: 200, domInteractive: 300, dcl: 0, load: 0, fp: null, fcp: null, lcp: null, docSize: 2048, resourceCount: 0, resources: [] }).split("\n");
  assert.equal(loading[0], "Page speed of https://x.example/ (navigate) — 4 checks: 4 ok, 0 warnings.");
  assert.equal(loading[2], "✓ load: load event not fired yet");
  assert.equal(loading[5], "Timing: TTFB 200 ms · DOM interactive 300 ms · DOMContentLoaded 0 ms · load not yet · first paint n/a · first contentful paint n/a · LCP n/a");
  assert.equal(loading.length, 7, "no slowest section without resources");
});

test("browser_check_speed: the Performance API is read once in the top frame (resource cap passed), the report comes back", async () => {
  const { run, inTopCalls } = load({ page: (func) => (func === "readPerf" ? PERF : null) });
  const out = await run("browser_check_speed", {});
  assert.deepEqual(inTopCalls, [{ func: "readPerf", args: [500] }]);
  assert.match(out, /^Page speed of https:\/\/site\.example\/page \(reload\) — 4 checks: 3 ok, 1 warning\.\n⚠ TTFB: 950 ms/);
  await assert.rejects(load({ page: null }).run("browser_check_speed", {}), /can't be automated/);
  await assert.rejects(load({ page: () => ({}) }).run("browser_check_speed", {}), /No timing data/);
});

// ── browser_check_sitemap ──────────────────────────────────────────────────

test("parseSitemap: a urlset (entities, CDATA, duplicates, image:loc left out), a sitemapindex, namespaced tags, a text sitemap, garbage", () => {
  const { X } = load();
  const urlset = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
  <url><loc>https://site.example/</loc><lastmod>2026-01-01</lastmod></url>
  <url><loc> https://site.example/a?x=1&amp;y=2 </loc><image:image><image:loc>https://site.example/a.jpg</image:loc></image:image></url>
  <url><loc><![CDATA[https://site.example/b]]></loc></url>
  <url><loc>https://site.example/</loc></url>
</urlset>`;
  assert.deepEqual(plain(X.parseSitemap(urlset)), { index: false, locs: ["https://site.example/", "https://site.example/a?x=1&y=2", "https://site.example/b"] });
  const index = `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://site.example/sitemap-1.xml</loc></sitemap>
  <sitemap>
    <loc>https://site.example/sitemap-2.xml</loc>
  </sitemap>
</sitemapindex>`;
  assert.deepEqual(plain(X.parseSitemap(index)), { index: true, locs: ["https://site.example/sitemap-1.xml", "https://site.example/sitemap-2.xml"] });
  assert.deepEqual(plain(X.parseSitemap('<sm:urlset xmlns:sm="http://www.sitemaps.org/schemas/sitemap/0.9"><sm:url><sm:loc>https://s.example/n</sm:loc></sm:url></sm:urlset>')), { index: false, locs: ["https://s.example/n"] });
  assert.deepEqual(plain(X.parseSitemap("https://t.example/1\n# comment\nhttps://t.example/2\r\n")), { index: false, locs: ["https://t.example/1", "https://t.example/2"] });
  assert.deepEqual(plain(X.parseSitemap("<html><body>Not found</body></html>")), { index: false, locs: [] });
  assert.deepEqual(plain(X.parseSitemap("")), { index: false, locs: [] });
  assert.deepEqual(plain(X.parseSitemap(undefined)), { index: false, locs: [] });
});

test("parseRobots: Sitemap: lines (any case, deduplicated), Disallow rules with a path, comments ignored", () => {
  const { X } = load();
  const r = plain(X.parseRobots("User-agent: *\nDisallow: /admin # private\nDisallow:\nAllow: /\ndisallow: /tmp/\nSITEMAP: https://s.example/sitemap.xml\nSitemap: https://s.example/sitemap.xml\nSitemap: https://s.example/news.xml\n# Disallow: /not-a-rule\n"));
  assert.deepEqual(r, { sitemaps: ["https://s.example/sitemap.xml", "https://s.example/news.xml"], disallow: 2 });
  assert.deepEqual(plain(X.parseRobots("")), { sitemaps: [], disallow: 0 });
});

const SITEMAP_ROUTES = {
  "https://site.example/robots.txt": { body: "User-agent: *\nDisallow: /admin\nDisallow: /tmp/\nDisallow:\nSitemap: https://site.example/sitemap-news.xml\n" },
  "https://site.example/sitemap.xml": { headers: { "content-type": "application/xml" }, body: `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<sitemap><loc>https://site.example/sitemap-pages.xml</loc></sitemap>
<sitemap><loc>https://site.example/sitemap-posts.xml</loc></sitemap>
<sitemap><loc>https://site.example/sitemap-old.xml</loc></sitemap>
</sitemapindex>` },
  "https://site.example/sitemap-news.xml": { body: "<urlset><url><loc>https://site.example/news/1</loc></url><url><loc>https://site.example/news/2</loc></url></urlset>" },
  "https://site.example/sitemap-pages.xml": { body: "<urlset>" + ["/", "/about", "/missing", "/moved"].map((p) => `<url><loc>https://site.example${p}</loc></url>`).join("") + "</urlset>" },
  "https://site.example/sitemap-posts.xml": { body: "<urlset>" + Array.from({ length: 12 }, (_, i) => `<url><loc>https://site.example/posts/${i + 1}</loc></url>`).join("") + "</urlset>" },
  "https://site.example/news/1": {}, "https://site.example/news/2": {},
  "https://site.example/": {}, "https://site.example/about": {},
  "https://site.example/missing": { status: 404 },
  "https://site.example/moved": { redirectTo: "https://site.example/new" },
  "https://site.example/posts/1": {}, "https://site.example/posts/2": {}, "https://site.example/posts/3": {}, "https://site.example/posts/4": {}, "https://site.example/posts/5": {},
};

test("browser_check_sitemap: robots.txt, the index and its nested sitemaps plus the one robots names, the URL list, the first 10 checked", async () => {
  const { run, fetch } = load({ routes: SITEMAP_ROUTES });
  const out = await run("browser_check_sitemap", {});
  const lines = out.split("\n");
  assert.deepEqual(lines.slice(0, 9), [
    "Sitemap check of https://site.example:",
    "robots.txt: 2 Disallow rules, 1 Sitemap: line (https://site.example/sitemap-news.xml)",
    "Sitemaps: 4 found, 1 not readable:",
    "  ✓ https://site.example/sitemap.xml  —  index of 3 sitemaps",
    "  ✓ https://site.example/sitemap-news.xml  —  2 URLs",
    "  ✓ https://site.example/sitemap-pages.xml  —  4 URLs",
    "  ✓ https://site.example/sitemap-posts.xml  —  12 URLs",
    "  ✗ https://site.example/sitemap-old.xml  —  HTTP 404",
    "URLs listed: 18 — the first 10:",
  ]);
  assert.deepEqual(lines.slice(9, 19), ["https://site.example/news/1", "https://site.example/news/2", "https://site.example/", "https://site.example/about", "https://site.example/missing", "https://site.example/moved", "https://site.example/posts/1", "https://site.example/posts/2", "https://site.example/posts/3", "https://site.example/posts/4"].map((u) => "  " + u));
  assert.equal(lines[19], "Checked the first 10: 8 ok, 1 redirected, 1 broken.");
  assert.match(lines.slice(20).join("\n"), /^Broken:\n  ✗ 404  https:\/\/site\.example\/missing  —  \d+ ms\nRedirected:\n  ↪ 200  https:\/\/site\.example\/moved → https:\/\/site\.example\/new  —  \d+ ms$/);
  // Texts are fetched with GET, the listed URLs checked with HEAD (the module's usual check), each sitemap once.
  assert.deepEqual(fetch.calls.filter((c) => c.method === "GET").map((c) => c.url), ["https://site.example/robots.txt", "https://site.example/sitemap.xml", "https://site.example/sitemap-news.xml", "https://site.example/sitemap-pages.xml", "https://site.example/sitemap-posts.xml", "https://site.example/sitemap-old.xml"]);
  assert.equal(fetch.calls.filter((c) => c.method === "HEAD").length, 10);
  assert.equal(fetch.calls.filter((c) => c.url === "https://site.example/posts/5").length, 0, "only the first max URLs are checked");
});

test("browser_check_sitemap: max limits the checks, url picks the site or names a sitemap directly, a bad address is refused", async () => {
  const { run, fetch } = load({ routes: SITEMAP_ROUTES });
  let out = await run("browser_check_sitemap", { url: "site.example/some/page", max: 3 });
  assert.match(out, /\nURLs listed: 18 — the first 10:\n/);
  assert.match(out, /\nChecked the first 3: 3 ok, 0 redirected, 0 broken\.$/);
  assert.equal(fetch.calls.filter((c) => c.method === "HEAD").length, 3);
  fetch.calls.length = 0;
  out = await run("browser_check_sitemap", { url: "https://site.example/sitemap-news.xml", max: 100 });
  assert.match(out, /\nSitemaps: 4 found, 1 not readable:\n  ✓ https:\/\/site\.example\/sitemap-news\.xml  —  2 URLs\n  ✓ https:\/\/site\.example\/sitemap\.xml  —  index of 3 sitemaps\n/, "the address given comes first; named again by robots.txt, it is listed once");
  assert.match(out, /\nChecked the first 18: /, "max is capped at 50; 18 are listed");
  assert.equal(fetch.calls.filter((c) => c.url === "https://site.example/sitemap-news.xml").length, 1, "a sitemap named twice is read once");
  await assert.rejects(run("browser_check_sitemap", { url: "ftp://site.example/" }), /Not an http\(s\) address/);
});

test("browser_check_sitemap: a missing robots.txt and sitemap are reported, not thrown; an unreachable robots.txt; a page instead of a sitemap", async () => {
  const none = load({ routes: {} });
  assert.equal(await none.run("browser_check_sitemap", { url: "https://nothing.example/" }), [
    "Sitemap check of https://nothing.example:",
    "robots.txt: missing (HTTP 404)",
    "Sitemaps: 0 found, 1 not readable:",
    "  ✗ https://nothing.example/sitemap.xml  —  HTTP 404",
    "No sitemap to check — pass url with the sitemap's address if the site keeps it elsewhere.",
  ].join("\n"));
  const dead = load({ routes: { "https://dead.example/robots.txt": { fail: true }, "https://dead.example/sitemap.xml": { fail: true } } });
  assert.equal(await dead.run("browser_check_sitemap", { url: "https://dead.example/" }), [
    "Sitemap check of https://dead.example:",
    "robots.txt: unreachable (Failed to fetch)",
    "Sitemaps: 0 found, 1 not readable:",
    "  ✗ https://dead.example/sitemap.xml  —  Failed to fetch",
    "No sitemap to check — pass url with the sitemap's address if the site keeps it elsewhere.",
  ].join("\n"));
  const html = load({ routes: { "https://html.example/robots.txt": { body: "User-agent: *\nDisallow:\n" }, "https://html.example/sitemap.xml": { headers: { "content-type": "text/html; charset=utf-8" }, body: "<html><body>Soft 404</body></html>" } } });
  const out = await html.run("browser_check_sitemap", { url: "https://html.example/" });
  assert.match(out, /\nrobots\.txt: 0 Disallow rules, 0 Sitemap: lines\nSitemaps: 0 found, 1 not readable:\n  ✗ https:\/\/html\.example\/sitemap\.xml  —  not a sitemap \(text\/html\)\n/);
  const gz = load({ routes: { "https://gz.example/robots.txt": { body: "Sitemap: https://gz.example/sitemap.xml.gz\n" }, "https://gz.example/sitemap.xml": { body: "<urlset><url><loc>https://gz.example/</loc></url></urlset>" }, "https://gz.example/": {} } });
  assert.match(await gz.run("browser_check_sitemap", { url: "https://gz.example/" }), /\nSitemaps: 1 found, 1 not readable:\n  ✓ https:\/\/gz\.example\/sitemap\.xml  —  1 URL\n  ✗ https:\/\/gz\.example\/sitemap\.xml\.gz  —  compressed \(\.gz\) — not read\nURLs listed: 1:\n  https:\/\/gz\.example\/\nChecked the first 1: 1 ok, 0 redirected, 0 broken\.$/);
});

test("readSitemaps: an index with more than 5 nested sitemaps reads 5 and says how many were left", async () => {
  const routes = { "https://big.example/sitemap.xml": { body: "<sitemapindex>" + Array.from({ length: 8 }, (_, i) => `<sitemap><loc>https://big.example/s${i}.xml</loc></sitemap>`).join("") + "</sitemapindex>" } };
  for (let i = 0; i < 8; i++) routes[`https://big.example/s${i}.xml`] = { body: `<urlset><url><loc>https://big.example/p${i}</loc></url></urlset>` };
  const { X } = load({ routes });
  const r = plain(await X.readSitemaps(["https://big.example/sitemap.xml"]));
  assert.equal(r.sitemaps.length, 6);
  assert.deepEqual([r.sitemaps[0].index, r.sitemaps[0].count, r.sitemaps[0].skipped], [true, 8, 3]);
  assert.deepEqual(r.locs, ["https://big.example/p0", "https://big.example/p1", "https://big.example/p2", "https://big.example/p3", "https://big.example/p4"]);
  assert.match(X.formatSitemapReport({ origin: "https://big.example", robots: { ok: true, status: 200, sitemaps: [], disallow: 0 }, sitemaps: r.sitemaps, locs: r.locs, checked: [] }), /index of 8 sitemaps, 3 not read \(limit 5\)\n/);
});

// ── browser_check_accessibility ────────────────────────────────────────────

const EMPTY = { count: 0, samples: [] };
const A11Y_GOOD = {
  url: "https://site.example/page", lang: "en",
  images: { total: 4, noAlt: EMPTY },
  controls: { total: 3, unnamed: EMPTY },
  links: { total: 20, empty: EMPTY, generic: EMPTY },
  buttons: { total: 2, empty: EMPTY },
  headings: { count: 8, skips: EMPTY },
  landmarks: { main: true, nav: true, banner: true, contentinfo: true },
  tabindex: EMPTY, duplicateIds: EMPTY,
  iframes: { total: 1, untitled: EMPTY },
  blank: { total: 2, noRel: EMPTY },
  hiddenFocusable: EMPTY, autoplay: EMPTY,
};
const A11Y_BAD = {
  url: "https://site.example/bad", lang: "",
  images: { total: 9, noAlt: { count: 7, samples: ["img.hero (hero.png)", "img#logo (logo.svg)", "img (a.png)", "img (b.png)", "img (c.png)"] } },
  controls: { total: 4, unnamed: { count: 2, samples: ['input[name="q"] (search)', "textarea (textarea)"] } },
  links: { total: 12, empty: { count: 1, samples: ["a.icon → /settings"] }, generic: { count: 3, samples: ['a.more "Read more" → /post/1', 'a.more "Read more" → /post/2', 'a "click here" → /help'] } },
  buttons: { total: 3, empty: { count: 2, samples: ["button.close", "button#menu"] } },
  headings: { count: 5, skips: { count: 1, samples: ['h3.sub (h1 → h3 "Details")'] } },
  landmarks: { main: false, nav: true, banner: false, contentinfo: false },
  tabindex: { count: 2, samples: ["div.modal (tabindex=1)", "a#skip (tabindex=5)"] },
  duplicateIds: { count: 2, samples: ["#row ×3", "#x ×2"] },
  iframes: { total: 2, untitled: { count: 2, samples: ["iframe (www.youtube.com)", "iframe#ad"] } },
  blank: { total: 3, noRel: { count: 1, samples: ["a.partner"] } },
  hiddenFocusable: { count: 1, samples: ["div.carousel (3 focusable inside)"] },
  autoplay: { count: 1, samples: ["video#promo (with sound)"] },
};
const A11Y_NAMES = ["html lang", "images", "form controls", "buttons and links without text", "link text", "heading order", "landmarks", "tabindex", "duplicate ids", "iframes", "target=_blank", "aria-hidden", "autoplay"];

test("a11yFindings: a well-made page passes all 13 checks; the details carry the counts", () => {
  const { X } = load();
  const f = plain(X.a11yFindings(A11Y_GOOD));
  assert.deepEqual(f.map((x) => x.name), A11Y_NAMES);
  assert.ok(f.every((x) => x.ok), JSON.stringify(f.filter((x) => !x.ok)));
  assert.deepEqual(f.map((x) => x.detail), [
    "lang=en",
    "4 images, all with alt",
    "3 controls, all named",
    "20 links and 2 buttons, all with a text or an aria-label",
    "no generic link texts (click here, read more, here, …)",
    "8 headings, levels in order",
    "main, nav, banner and contentinfo present",
    "no positive tabindex",
    "all ids unique",
    "1 iframe, all titled",
    "all 2 links opening a new tab carry rel=noopener",
    "no aria-hidden element hides focusable content",
    "no autoplaying media",
  ]);
  assert.deepEqual(plain(X.GENERIC_LINK_TEXTS), ["click here", "read more", "here", "link", "more"]);
});

test("a11yFindings: every warning fires on a bad page, with up to 5 samples and an ellipsis beyond; the empty page object", () => {
  const { X } = load();
  const f = plain(X.a11yFindings(A11Y_BAD));
  assert.equal(f.length, 13);
  assert.ok(f.every((x) => !x.ok), JSON.stringify(f.filter((x) => x.ok)));
  assert.deepEqual(f.map((x) => x.detail), [
    "missing — screen readers can't pick the language",
    "9 images, 7 without alt: img.hero (hero.png), img#logo (logo.svg), img (a.png), img (b.png), img (c.png), …",
    '4 controls, 2 without an accessible name (no label, aria-label, title or placeholder): input[name="q"] (search), textarea (textarea)',
    "1 of 12 links and 2 of 3 buttons icon-only without aria-label: a.icon → /settings, button.close, button#menu",
    '3 generic link texts (say where they lead): a.more "Read more" → /post/1, a.more "Read more" → /post/2, a "click here" → /help',
    '5 headings, 1 level skip: h3.sub (h1 → h3 "Details")',
    "missing main, banner, contentinfo",
    "2 elements with a positive tabindex (it breaks the natural tab order): div.modal (tabindex=1), a#skip (tabindex=5)",
    "2 ids used more than once: #row ×3, #x ×2",
    "2 iframes, 2 without title: iframe (www.youtube.com), iframe#ad",
    "advice — 1 of 3 links opening a new tab without rel=noopener: a.partner",
    "1 aria-hidden element with focusable content (keyboard users reach what screen readers can't): div.carousel (3 focusable inside)",
    "1 autoplaying media element: video#promo (with sound)",
  ]);
  // Only buttons empty, only links empty.
  const onlyButtons = plain(X.a11yFindings({ ...A11Y_GOOD, buttons: { total: 3, empty: { count: 1, samples: ["button.x"] } } }));
  assert.equal(onlyButtons[3].detail, "1 of 3 buttons icon-only without aria-label: button.x");
  const onlyLinks = plain(X.a11yFindings({ ...A11Y_GOOD, links: { total: 5, empty: { count: 2, samples: ["a.i", "a.j"] }, generic: EMPTY } }));
  assert.equal(onlyLinks[3].detail, "2 of 5 links icon-only without aria-label: a.i, a.j");
  // An empty page object: nothing on it, nothing to warn about except the language and the landmarks.
  const empty = plain(X.a11yFindings({}));
  assert.equal(empty.length, 13);
  assert.deepEqual(empty.filter((x) => !x.ok).map((x) => x.name), ["html lang", "landmarks"]);
  assert.deepEqual([empty[2].detail, empty[5].detail, empty[6].detail, empty[9].detail, empty[10].detail], ["none", "no headings", "missing main, nav, banner, contentinfo — add <main>, <nav>, <header> and <footer>", "none", "no links open a new tab"]);
});

test("browser_check_accessibility: one injected read with the sample and scan limits and the generic texts, the report with the verdict and the contrast caveat", async () => {
  const { run, inTopCalls } = load({ page: (func) => (func === "readA11y" ? A11Y_GOOD : null) });
  const out = await run("browser_check_accessibility", {});
  assert.deepEqual(inTopCalls, [{ func: "readA11y", args: [5, 3000, ["click here", "read more", "here", "link", "more"]] }]);
  const lines = out.split("\n");
  assert.equal(lines[0], "Accessibility audit of https://site.example/page — 13 checks: 13 ok, 0 warnings.");
  assert.equal(lines.length, 15);
  assert.ok(lines.slice(1, 14).every((l) => l.startsWith("✓ ")), out);
  assert.equal(lines[14], "Not checked here: text contrast (the palette tool reads the colours).");
  const bad = load({ page: (func) => (func === "readA11y" ? A11Y_BAD : null) });
  const report = await bad.run("browser_check_accessibility", {});
  assert.equal(report.split("\n")[0], "Accessibility audit of https://site.example/bad — 13 checks: 0 ok, 13 warnings.");
  assert.match(report, /\n⚠ html lang: missing — screen readers can't pick the language\n⚠ images: 9 images, 7 without alt: /);
  await assert.rejects(load({ page: null }).run("browser_check_accessibility", {}), /can't be automated/);
  await assert.rejects(load({ page: () => ({}) }).run("browser_check_accessibility", {}), /Couldn't read the page for the accessibility audit/);
});

// ── browser_check_mobile ───────────────────────────────────────────────────

const MOBILE_GOOD = {
  url: "https://site.example/page", innerWidth: 1280, innerHeight: 800, scrollWidth: 1280,
  viewport: "width=device-width, initial-scale=1",
  tapTargets: { total: 30, small: EMPTY },
  smallText: { count: 0, samples: [], scanned: 210 },
  wide: EMPTY, overlays: EMPTY, fixedWidth: EMPTY, plugins: EMPTY,
};
const MOBILE_BAD = {
  url: "https://site.example/bad", innerWidth: 390, innerHeight: 844, scrollWidth: 1100,
  viewport: "width=1024, maximum-scale=1, user-scalable=no",
  tapTargets: { total: 40, small: { count: 12, samples: ["a.nav-link 60×18", "button.icon 24×24", "input#agree 13×13", "a 30×30", "a.tag 50×20"] } },
  smallText: { count: 3, samples: ["small.legal 10px", "span.note 11px", "footer p 9.5px"], scanned: 300 },
  wide: { count: 2, samples: ["table.data 1100 px wide, right edge at 1100", "img.banner 600 px wide, right edge at 620"] },
  overlays: { count: 1, samples: ["div.cookie-banner 40% (fixed)"] },
  fixedWidth: { count: 2, samples: ["div.container min-width 960px", ".wrapper { width: 1200px }"] },
  plugins: { count: 1, samples: ["embed (application/x-shockwave-flash)"] },
};
const MOBILE_NAMES = ["viewport", "tap targets", "text size", "horizontal overflow", "wide elements", "overlays", "phone width", "plugins"];

test("parseViewport: the pairs of a viewport meta, any order and separator; null for none", () => {
  const { X } = load();
  const v = plain(X.parseViewport("width=device-width, initial-scale=1.0, maximum-scale=1, user-scalable=no"));
  assert.deepEqual(v, { width: "device-width", initialScale: 1, maximumScale: 1, userScalable: "no" });
  const w = X.parseViewport("initial-scale=1; width=1024");
  assert.deepEqual([w.width, w.initialScale, Number.isNaN(w.maximumScale), w.userScalable], ["1024", 1, true, ""]);
  assert.equal(X.parseViewport(null), null);
  assert.equal(X.parseViewport("").width, "");
});

test("mobileFindings: a responsive page passes all 8 checks; every warning fires on a desktop-only page; the viewport variants", () => {
  const { X } = load();
  const good = plain(X.mobileFindings(MOBILE_GOOD));
  assert.deepEqual(good.map((x) => x.name), MOBILE_NAMES);
  assert.ok(good.every((x) => x.ok), JSON.stringify(good.filter((x) => !x.ok)));
  assert.deepEqual(good.map((x) => x.detail), [
    '"width=device-width, initial-scale=1"',
    "all 30 at least 44×44 px",
    "no visible text under 12 px (210 text elements checked)",
    "none at 1280 px",
    "none wider than the viewport (1280 px)",
    "no fixed/sticky element covers over 25% of the viewport",
    "no fixed width or min-width over 375 px (inline styles, width attributes and same-origin stylesheets checked)",
    "no legacy plugins",
  ]);
  const bad = plain(X.mobileFindings(MOBILE_BAD));
  assert.ok(bad.every((x) => !x.ok), JSON.stringify(bad.filter((x) => x.ok)));
  assert.deepEqual(bad.map((x) => x.detail), [
    '"width=1024, maximum-scale=1, user-scalable=no" — width=1024 instead of device-width; user-scalable=no blocks pinch zoom; maximum-scale=1 blocks pinch zoom',
    "12 of 40 under 44×44 px: a.nav-link 60×18, button.icon 24×24, input#agree 13×13, a 30×30, a.tag 50×20, …",
    "3 elements with text under 12 px: small.legal 10px, span.note 11px, footer p 9.5px",
    "the page scrolls sideways at 390 px (content 1100 px wide)",
    "2 elements wider than the viewport (390 px), widest: table.data 1100 px wide, right edge at 1100, img.banner 600 px wide, right edge at 620",
    "1 fixed/sticky element covering over 25% of the viewport: div.cookie-banner 40% (fixed)",
    "2 elements with a fixed width or min-width over 375 px (would overflow a phone unless a media query changes them): div.container min-width 960px, .wrapper { width: 1200px }",
    "1 legacy plugin (object/embed/applet) — phones don't run them: embed (application/x-shockwave-flash)",
  ]);
  const vp = (viewport) => plain(X.mobileFindings({ ...MOBILE_GOOD, viewport }))[0];
  assert.deepEqual([vp(null).ok, vp(null).detail], [false, "no meta viewport — phones render the page at desktop width and shrink it"]);
  assert.equal(vp("initial-scale=1").detail, '"initial-scale=1" — no width=device-width');
  assert.equal(vp("width=device-width, user-scalable=0").detail, '"width=device-width, user-scalable=0" — user-scalable=0 blocks pinch zoom');
  assert.equal(vp("width=device-width, maximum-scale=0.5").detail, '"width=device-width, maximum-scale=0.5" — maximum-scale=0.5 blocks pinch zoom');
  assert.equal(vp("width=device-width, maximum-scale=5").ok, true);
  assert.equal(plain(X.mobileFindings({ ...MOBILE_GOOD, tapTargets: { total: 0, small: EMPTY } }))[1].detail, "none found");
  assert.equal(plain(X.mobileFindings({}))[2].detail, "no visible text under 12 px");
  assert.deepEqual(plain(X.MOBILE), { tap: 44, minFont: 12, phoneWidth: 375, overlayPct: 25, samples: 5, scan: 3000, rules: 5000 });
});

test("browser_check_mobile: one injected read with the limits, the report with the size, the verdict and the resize caveat", async () => {
  const { run, inTopCalls } = load({ page: (func) => (func === "readMobile" ? MOBILE_GOOD : null) });
  const out = await run("browser_check_mobile", {});
  assert.deepEqual(inTopCalls, [{ func: "readMobile", args: [{ tap: 44, minFont: 12, phoneWidth: 375, overlayPct: 25, samples: 5, scan: 3000, rules: 5000 }] }]);
  const lines = out.split("\n");
  assert.equal(lines[0], "Mobile readiness of https://site.example/page at 1280×800 px — 8 checks: 8 ok, 0 warnings.");
  assert.equal(lines.length, 10);
  assert.equal(lines[9], "The tab was not resized: the phone-width check comes from declared widths, the others from the current size.");
  const bad = load({ page: () => MOBILE_BAD });
  assert.match(await bad.run("browser_check_mobile", {}), /^Mobile readiness of https:\/\/site\.example\/bad at 390×844 px — 8 checks: 0 ok, 8 warnings\.\n⚠ viewport: "width=1024/);
  await assert.rejects(load({ page: null }).run("browser_check_mobile", {}), /can't be automated/);
  await assert.rejects(load({ page: () => ({}) }).run("browser_check_mobile", {}), /Couldn't read the page for the mobile audit/);
});

// ── browser_check_redirects ────────────────────────────────────────────────

test("describeChain: one line per hop with the scheme notes, the summary; a downgrade, a loop, the hop limit, a hidden hop, a dead address, no redirect", () => {
  const { X } = load();
  const d = plain(X.describeChain([
    { url: "http://x.example/", status: 301, location: "https://x.example/", ms: 120, type: "" },
    { url: "https://x.example/", status: 302, location: "https://x.example/home", ms: 90, type: "text/html" },
    { url: "https://x.example/home", status: 200, ms: 200, type: "text/html" },
  ], ""));
  assert.deepEqual(d.lines, [
    "1. ↪ 301  http://x.example/  →  https://x.example/  (120 ms, http → https)",
    "2. ↪ 302  https://x.example/  →  https://x.example/home  (90 ms)",
    "3. ✓ 200  https://x.example/home  (200 ms, text/html)",
  ]);
  assert.deepEqual([d.summary, d.warnings, d.redirects, d.total], ["2 redirects, 3 requests, 410 ms in all; final: https://x.example/home (200).", [], 2, 410]);
  const down = plain(X.describeChain([{ url: "https://a.example/", status: 302, location: "http://a.example/", ms: 10 }, { url: "http://a.example/", status: 200, ms: 5 }], ""));
  assert.equal(down.lines[0], "1. ↪ 302  https://a.example/  →  http://a.example/  (10 ms, ⚠ https → http)");
  assert.deepEqual(down.warnings, ["Hop 1 sends the visitor from https back to http (insecure, mixed content for anything embedding it)."]);
  const loop = plain(X.describeChain([{ url: "https://l.example/a", status: 302, location: "https://l.example/b", ms: 1 }, { url: "https://l.example/b", status: 302, location: "https://l.example/a", ms: 1 }], "loop"));
  assert.deepEqual(loop.warnings, ["Loop: https://l.example/a was already visited — the chain never ends."]);
  assert.equal(loop.summary, "2 redirects, 2 requests, 2 ms in all; final: still redirecting to https://l.example/a.");
  const max = plain(X.describeChain([{ url: "https://m.example/1", status: 301, location: "https://m.example/2", ms: 4 }, { url: "https://m.example/2", status: 301, location: "https://m.example/3", ms: 4 }], "max"));
  assert.deepEqual(max.warnings, ["Stopped after 2 redirects (the limit) — still redirecting to https://m.example/3."]);
  const hidden = plain(X.describeChain([{ url: "https://h.example/", status: 0, location: "https://h.example/final", hidden: true, ms: 0 }, { url: "https://h.example/final", status: 200, ms: 50, type: "text/html" }], ""));
  assert.equal(hidden.lines[0], "1. ↪ redirect  https://h.example/  →  https://h.example/final  (0 ms, hidden)");
  assert.deepEqual(hidden.warnings, ["The browser hid the intermediate hops; the redirect is shown as one step to the final address."]);
  const dead = plain(X.describeChain([{ url: "https://d.example/", error: "Failed to fetch", ms: 3 }], ""));
  assert.deepEqual([dead.lines, dead.summary], [["1. ✗ down: Failed to fetch  https://d.example/  (3 ms)"], "no redirect, 1 request, 3 ms in all; final: down: Failed to fetch."]);
  const direct = plain(X.describeChain([{ url: "https://p.example/", status: 404, ms: 40, type: "text/html" }], ""));
  assert.deepEqual([direct.lines, direct.summary], [["1. ✗ 404  https://p.example/  (40 ms, text/html)"], "no redirect, 1 request, 40 ms in all; final: https://p.example/ (404)."]);
  assert.equal(plain(X.describeChain([], "")).summary, "no redirect, 0 requests, 0 ms in all; final: no response.");
});

test("browser_check_redirects: the chain hop by hop (relative Location resolved), the current tab by default, a loop, max, a dead hop, bad input", async () => {
  const routes = {
    "http://x.example/": { status: 301, headers: { location: "https://x.example/" } },
    "https://x.example/": { status: 302, headers: { location: "/home" } },
    "https://x.example/home": { headers: { "content-type": "text/html; charset=utf-8" } },
    "https://site.example/page": { headers: { "content-type": "text/html" } },
    "https://l.example/a": { status: 307, headers: { location: "https://l.example/b" } },
    "https://l.example/b": { status: 307, headers: { location: "https://l.example/a" } },
    "https://dead.example/": { fail: true },
  };
  for (let i = 0; i < 25; i++) routes[`https://m.example/${i}`] = { status: 301, headers: { location: `https://m.example/${i + 1}` } };
  const { run, fetch } = load({ routes });
  let lines = (await run("browser_check_redirects", { url: "x.example", max: 5 })).split("\n");
  // "x.example" becomes https://x.example/ — start there.
  assert.match(lines[0], /^Redirect chain of https:\/\/x\.example\/ — 1 redirect, 2 requests, \d+ ms in all; final: https:\/\/x\.example\/home \(200\)\.$/);
  lines = (await run("browser_check_redirects", { url: "http://x.example/" })).split("\n");
  assert.match(lines[0], /^Redirect chain of http:\/\/x\.example\/ — 2 redirects, 3 requests, \d+ ms in all; final: https:\/\/x\.example\/home \(200\)\.$/);
  assert.match(lines[1], /^  1\. ↪ 301  http:\/\/x\.example\/  →  https:\/\/x\.example\/  \(\d+ ms, http → https\)$/);
  assert.match(lines[2], /^  2\. ↪ 302  https:\/\/x\.example\/  →  https:\/\/x\.example\/home  \(\d+ ms\)$/);
  assert.match(lines[3], /^  3\. ✓ 200  https:\/\/x\.example\/home  \(\d+ ms, text\/html\)$/);
  assert.equal(lines.length, 4);
  assert.ok(fetch.calls.every((c) => c.method === "GET"), "redirect hops are GETs");
  // No url: the current tab.
  assert.match(await run("browser_check_redirects", {}), /^Redirect chain of https:\/\/site\.example\/page — no redirect, 1 request, \d+ ms in all; final: https:\/\/site\.example\/page \(200\)\.\n  1\. ✓ 200  https:\/\/site\.example\/page  \(\d+ ms, text\/html\)$/);
  // A loop stops at the second visit and says so.
  const loop = await run("browser_check_redirects", { url: "https://l.example/a" });
  assert.match(loop, /^Redirect chain of https:\/\/l\.example\/a — 2 redirects, 2 requests, \d+ ms in all; final: still redirecting to https:\/\/l\.example\/a\.\n/);
  assert.match(loop, /\n⚠ Loop: https:\/\/l\.example\/a was already visited — the chain never ends\.$/);
  // max: the default 10, clamped to 20.
  fetch.calls.length = 0;
  assert.match(await run("browser_check_redirects", { url: "https://m.example/0" }), /— 10 redirects, 10 requests, \d+ ms in all; final: still redirecting to https:\/\/m\.example\/10\.\n[\s\S]*\n⚠ Stopped after 10 redirects \(the limit\) — still redirecting to https:\/\/m\.example\/10\.$/);
  assert.equal(fetch.calls.length, 10);
  assert.match(await run("browser_check_redirects", { url: "https://m.example/0", max: 100 }), /— 20 redirects, 20 requests/);
  assert.match(await run("browser_check_redirects", { url: "https://m.example/0", max: 1 }), /— 1 redirect, 1 request/);
  // A dead hop ends the chain as down.
  assert.match(await run("browser_check_redirects", { url: "https://dead.example/" }), /^Redirect chain of https:\/\/dead\.example\/ — no redirect, 1 request, \d+ ms in all; final: down: Failed to fetch\.\n  1\. ✗ down: Failed to fetch  https:\/\/dead\.example\/  \(\d+ ms\)$/);
  await assert.rejects(run("browser_check_redirects", { url: "ftp://x.example/" }), /Not an http\(s\) address/);
});

test("browser_check_redirects: a redirect the browser hides (opaque response) is observed through webRequest, or shown as one hidden hop without it", async () => {
  const routes = {
    "https://o.example/": { opaque: true, redirectTo: "https://o.example/final", headers: { "content-type": "text/html" }, hops: [{ url: "https://o.example/", status: 301, location: "https://o.example/mid" }, { url: "https://o.example/mid", status: 302, location: "https://o.example/final" }] },
  };
  const plain_ = load({ routes });
  let lines = (await plain_.run("browser_check_redirects", { url: "https://o.example/" })).split("\n");
  assert.match(lines[0], /^Redirect chain of https:\/\/o\.example\/ — 1 redirect, 2 requests, \d+ ms in all; final: https:\/\/o\.example\/final \(200\)\.$/);
  assert.equal(lines[1], "  1. ↪ redirect  https://o.example/  →  https://o.example/final  (0 ms, hidden)");
  assert.match(lines[2], /^  2\. ✓ 200  https:\/\/o\.example\/final  \(\d+ ms, text\/html\)$/);
  assert.equal(lines[3], "⚠ The browser hid the intermediate hops; the redirect is shown as one step to the final address.");
  assert.equal(plain_.fetch.calls.length, 2, "the manual request, then one followed GET");
  const observed = load({ routes, webRequest: true });
  lines = (await observed.run("browser_check_redirects", { url: "https://o.example/" })).split("\n");
  assert.match(lines[0], /^Redirect chain of https:\/\/o\.example\/ — 2 redirects, 3 requests, \d+ ms in all; final: https:\/\/o\.example\/final \(200\)\.$/);
  assert.match(lines[1], /^  1\. ↪ 301  https:\/\/o\.example\/  →  https:\/\/o\.example\/mid  \(\d+ ms\)$/);
  assert.match(lines[2], /^  2\. ↪ 302  https:\/\/o\.example\/mid  →  https:\/\/o\.example\/final  \(\d+ ms\)$/);
  assert.match(lines[3], /^  3\. ✓ 200  https:\/\/o\.example\/final  \(\d+ ms, text\/html\)$/);
  assert.equal(lines.length, 4, "nothing hidden, no warning");
  assert.equal(observed.redirectListeners.length, 0, "the listener is removed after the request");
});

// ── browser_check_headers ──────────────────────────────────────────────────

const GOOD_HEADERS = {
  server: "nginx", "content-type": "text/html; charset=utf-8", "content-encoding": "br",
  "cache-control": "max-age=600, must-revalidate", etag: '"abc"', "last-modified": "Tue, 01 Oct 2026 10:00:00 GMT",
  "strict-transport-security": "max-age=31536000; includeSubDomains; preload",
  "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff", "referrer-policy": "strict-origin-when-cross-origin", "permissions-policy": "camera=(), microphone=()",
};
const HEADER_NAMES = ["server", "content-type", "compression", "caching", "strict-transport-security", "content-security-policy", "frame protection", "x-content-type-options", "referrer-policy", "permissions-policy", "cookies", "http version"];

test("headerFindings: a well-configured https response passes everything, the 7 security entries are marked; the bad http response trips every warning", () => {
  const { X } = load();
  const f = plain(X.headerFindings(GOOD_HEADERS, "https://site.example/", { cookies: [{ secure: true, httpOnly: true, sameSite: "Lax" }], cookieSource: "set by this response", protocol: "h2" }));
  assert.deepEqual(f.map((x) => x.name), HEADER_NAMES);
  assert.ok(f.every((x) => x.ok), JSON.stringify(f.filter((x) => !x.ok)));
  assert.deepEqual(f.map((x) => x.security), [false, false, false, false, true, true, true, true, true, true, true, false]);
  assert.deepEqual(f.map((x) => x.detail), [
    "nginx",
    "text/html; charset=utf-8",
    "content-encoding br",
    "cache-control max-age=600, must-revalidate; validators: etag, last-modified",
    "max-age 31536000 (365 days), includeSubDomains, preload",
    "present, " + GOOD_HEADERS["content-security-policy"].length + " chars",
    "CSP frame-ancestors 'none'",
    "nosniff",
    "strict-origin-when-cross-origin",
    "present, 24 chars",
    "1 cookie set by this response: Secure 1, HttpOnly 1, SameSite Lax 1 / Strict 0 / None 0 / unset 0",
    "HTTP/2",
  ]);
  const bad = plain(X.headerFindings(
    { Server: "Apache/2.4.41 (Ubuntu)", "X-Powered-By": "PHP/7.4", "Content-Type": "text/html", "Content-Security-Policy-Report-Only": "default-src 'self'", "Feature-Policy": "camera 'none'" },
    "http://site.example/",
    { cookies: [{ secure: false, httpOnly: false, sameSite: "" }, { secure: false, httpOnly: true, sameSite: "None" }], cookieSource: "stored for this address", protocol: "http/1.1" }
  ));
  assert.deepEqual(bad.filter((x) => x.ok).map((x) => x.name), ["http version"], "header names are matched regardless of case");
  assert.deepEqual(bad.map((x) => x.detail), [
    "Apache/2.4.41 (Ubuntu); x-powered-by PHP/7.4 — drop it, it advertises the stack",
    "text/html — no charset declared, add ; charset=utf-8",
    "none — enable gzip or brotli for text/html",
    "no cache-control or expires — browsers guess the lifetime",
    "missing (the address is http — serve it over https first)",
    "report-only (18 chars) — not enforced",
    "missing — add x-frame-options: DENY or CSP frame-ancestors (clickjacking)",
    "missing — add nosniff",
    "missing — e.g. strict-origin-when-cross-origin",
    "only the legacy feature-policy — add permissions-policy",
    "2 cookies stored for this address: Secure 0, HttpOnly 1, SameSite Lax 0 / Strict 0 / None 1 / unset 1 — 1 without SameSite, SameSite=None needs Secure",
    "HTTP/1.1",
  ]);
});

test("headerFindings: the in-between cases — no headers at all, a short HSTS, unsafe-inline, x-frame-options, expires only, an image, cookies without Secure on https", () => {
  const { X } = load();
  const none = plain(X.headerFindings({}, "https://site.example/"));
  assert.deepEqual(none.map((x) => [x.ok, x.detail]), [
    [true, "not disclosed"],
    [false, "missing"],
    [true, "none (not a text type, fine)"],
    [false, "no cache-control or expires — browsers guess the lifetime"],
    [false, "missing — add max-age=31536000; includeSubDomains"],
    [false, "missing"],
    [false, "missing — add x-frame-options: DENY or CSP frame-ancestors (clickjacking)"],
    [false, "missing — add nosniff"],
    [false, "missing — e.g. strict-origin-when-cross-origin"],
    [false, "missing — e.g. camera=(), microphone=(), geolocation=()"],
    [true, "none set by this response"],
    [true, "not exposed"],
  ]);
  const mixed = plain(X.headerFindings(
    { "strict-transport-security": "max-age=86400", "content-security-policy": "default-src 'self' 'unsafe-inline' 'unsafe-eval'", "x-frame-options": "SAMEORIGIN", expires: "Thu, 01 Jan 2027 00:00:00 GMT", "content-type": "image/png", "content-encoding": "" },
    "https://site.example/a.png",
    { cookies: [{ secure: false, httpOnly: true, sameSite: "Strict" }, { secure: true, httpOnly: false, sameSite: "Lax" }], cookieSource: "stored for this address", protocol: "h3" }
  ));
  assert.deepEqual([mixed[1].ok, mixed[1].detail], [true, "image/png"]);
  assert.deepEqual([mixed[2].ok, mixed[2].detail], [true, "none (not a text type, fine)"]);
  assert.deepEqual([mixed[3].ok, mixed[3].detail], [true, "expires Thu, 01 Jan 2027 00:00:00 GMT (no cache-control); no etag or last-modified — add one so revalidation is cheap"]);
  assert.deepEqual([mixed[4].ok, mixed[4].detail], [false, "max-age 86400 (1 day, short — aim for a year)"]);
  assert.deepEqual([mixed[5].ok, mixed[5].detail], [true, "present, 48 chars, allows 'unsafe-inline', allows 'unsafe-eval'"]);
  assert.deepEqual([mixed[6].ok, mixed[6].detail], [true, "x-frame-options SAMEORIGIN"]);
  assert.deepEqual([mixed[10].ok, mixed[10].detail], [false, "2 cookies stored for this address: Secure 1, HttpOnly 1, SameSite Lax 1 / Strict 1 / None 0 / unset 0 — 1 without Secure"]);
  assert.equal(mixed[11].detail, "HTTP/3");
  assert.equal(plain(X.headerFindings({ "content-type": "application/json" }, "https://api.example/"))[2].detail, "none — enable gzip or brotli for application/json");
  assert.equal(plain(X.headerFindings({ "cache-control": "no-store" }, "https://x.example/"))[3].detail, "cache-control no-store; no etag or last-modified — add one so revalidation is cheap");
  assert.equal(plain(X.headerFindings({}, "https://x.example/", { cookies: [], cookieSource: "stored for this address" }))[10].detail, "none stored for this address");
  // The cookie flag parsers: names and values never come through.
  assert.deepEqual(plain(X.cookieFlags(["sid=secret123; Path=/; Secure; HttpOnly; SameSite=Lax", "t=1", "u=2; samesite=none; secure"])), [
    { secure: true, httpOnly: true, sameSite: "Lax" }, { secure: false, httpOnly: false, sameSite: "" }, { secure: true, httpOnly: false, sameSite: "None" },
  ]);
  assert.deepEqual(plain(X.storedCookieFlags([{ name: "a", value: "v", secure: true, httpOnly: false, sameSite: "no_restriction" }, { sameSite: "lax" }, { sameSite: "unspecified", httpOnly: true }])), [
    { secure: true, httpOnly: false, sameSite: "None" }, { secure: false, httpOnly: false, sameSite: "Lax" }, { secure: false, httpOnly: true, sameSite: "" },
  ]);
  assert.ok(!JSON.stringify(X.cookieFlags(["sid=secret123; Secure"])).includes("secret123"));
});

test("browser_check_headers: one GET, the report with the security count; Set-Cookie when readable, else the cookies stored for the address; a redirect, a dead address, bad input", async () => {
  const routes = {
    "https://site.example/page": { headers: GOOD_HEADERS, setCookie: ["a=1; Secure; HttpOnly; SameSite=Lax", "b=2; Secure; SameSite=Strict"] },
    "https://site.example/other": { headers: { ...GOOD_HEADERS, "content-security-policy": undefined, "x-frame-options": "DENY" } },
    "https://r.example/": { redirectTo: "https://r.example/home", headers: { "content-type": "text/plain" } },
    "https://dead.example/": { fail: true },
  };
  delete routes["https://site.example/other"].headers["content-security-policy"];
  const { run, fetch, cookieCalls } = load({ routes, cookies: [{ name: "s", value: "x", secure: false, httpOnly: false, sameSite: "unspecified" }] });
  let lines = (await run("browser_check_headers", {})).split("\n");
  assert.deepEqual(fetch.calls, [{ url: "https://site.example/page", method: "GET" }], "the current tab, one GET");
  assert.match(lines[0], /^Response headers of https:\/\/site\.example\/page — HTTP 200, \d+ ms — security headers 7\/7; 12 checks: 12 ok, 0 warnings\.$/);
  assert.equal(lines.length, 13);
  assert.equal(lines[11], "✓ cookies: 2 cookies set by this response: Secure 2, HttpOnly 1, SameSite Lax 1 / Strict 1 / None 0 / unset 0");
  assert.equal(lines[12], "✓ http version: not exposed");
  assert.deepEqual(cookieCalls, [], "Set-Cookie was readable — the cookie store is not consulted");
  // No Set-Cookie exposed (the browser case): the stored cookies, flags only.
  lines = (await run("browser_check_headers", { url: "https://site.example/other" })).split("\n");
  assert.deepEqual(cookieCalls, [{ url: "https://site.example/other" }]);
  assert.match(lines[0], /security headers 5\/7; 12 checks: 10 ok, 2 warnings\.$/);
  assert.equal(lines[6], "⚠ content-security-policy: missing");
  assert.equal(lines[7], "✓ frame protection: x-frame-options DENY");
  assert.equal(lines[11], "⚠ cookies: 1 cookie stored for this address: Secure 0, HttpOnly 0, SameSite Lax 0 / Strict 0 / None 0 / unset 1 — 1 without Secure, 1 without SameSite");
  assert.ok(!lines.join("\n").includes("value"), "no cookie value in the report");
  // A redirect is followed and named; the stored cookie (no Secure, no SameSite) costs the seventh security point.
  assert.match(await run("browser_check_headers", { url: "r.example" }), /^Response headers of https:\/\/r\.example\/home — HTTP 200 \(after redirect from https:\/\/r\.example\/\), \d+ ms — security headers 0\/7; 12 checks: 2 ok, 10 warnings\.\n/);
  await assert.rejects(run("browser_check_headers", { url: "https://dead.example/" }), /No response from https:\/\/dead\.example\/: Failed to fetch/);
  await assert.rejects(run("browser_check_headers", { url: "javascript:alert(1)" }), /Not an http\(s\) address/);
  // A build without chrome.cookies: the cookie line stays neutral.
  const bare = load({ routes });
  assert.match(await bare.run("browser_check_headers", { url: "https://site.example/other" }), /\n✓ cookies: none set by this response\n/);
});
