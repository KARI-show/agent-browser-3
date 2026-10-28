// The "checks" extra (browser/extras/checks.js) against fakes of chrome.storage / tabs, of the tool
// runtime (AgentBrowserTools.register + helpers) and of fetch: the HEAD → GET fallback, redirects,
// 4xx/5xx, network errors and the timeout; the link collection filter and the reports; the 🔗 tab; the
// SEO audit and the speed report on fixed page data; the sitemap check against fake robots.txt/sitemaps.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const CHECKS_JS = fileURLToPath(new URL("../browser/extras/checks.js", import.meta.url));
const plain = (x) => JSON.parse(JSON.stringify(x));

/** A fetch answering from a route table: url → { status, headStatus, headers, redirectTo, fail, hang, delay, body (text) }. */
function fakeFetch(routes) {
  const calls = [];
  const f = async (url, init) => {
    init = init || {};
    calls.push({ url: String(url), method: init.method || "GET" });
    const r = routes[String(url)] || { status: 404 };
    if (r.delay) await new Promise((res) => setTimeout(res, r.delay));
    if (r.fail) throw new TypeError("Failed to fetch");
    if (r.hang) return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("The user aborted a request."), { name: "AbortError" }))));
    let status = r.status === undefined ? 200 : r.status;
    if (init.method === "HEAD" && r.headStatus) status = r.headStatus;
    const headers = Object.fromEntries(Object.entries(r.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    return { status, ok: status >= 200 && status < 300, url: r.redirectTo || String(url), redirected: !!r.redirectTo, headers: { get: (k) => (k.toLowerCase() in headers ? headers[k.toLowerCase()] : null) }, body: null, text: async () => (r.body == null ? "" : String(r.body)) };
  };
  f.calls = calls;
  return f;
}

/** Load checks.js the way extras.js is loaded in the panel, with a brand that has (or lacks) the feature. `page` is what an injected function returns, or a function of the injected function's name. */
function load({ brand = ["checks"], routes = {}, page = null } = {}) {
  const data = {};
  const tools = {};
  const created = [];
  const inTopCalls = [];
  const chrome = {
    storage: {
      local: {
        async get(k) { const out = {}; for (const x of typeof k === "string" ? [k] : k) if (x in data) out[x] = plain(data[x]); return out; },
        async set(items) { Object.assign(data, plain(items)); },
      },
    },
    tabs: { async create(o) { created.push(o); return { id: 9 }; } },
  };
  const fetch = fakeFetch(routes);
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
  return { ctx, tools, data, fetch, created, inTopCalls, X: ctx.AgentExtras.checks, run };
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

test("with the feature: the five tools, the 🔗 tab watching its storage key, the Monitoring quick commands", () => {
  const { tools, ctx } = load();
  assert.deepEqual(Object.keys(tools).sort(), ["browser_check_links", "browser_check_seo", "browser_check_sitemap", "browser_check_speed", "browser_check_url"]);
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
  ]);
  for (const c of ctx.AgentExtras.commands) assert.match(c.prompt, /browser_check_(url|links|seo|speed|sitemap)/, c.name + " names its tool");
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
