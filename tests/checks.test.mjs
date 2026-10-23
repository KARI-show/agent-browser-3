// The "checks" extra (browser/extras/checks.js) against fakes of chrome.storage / tabs, of the tool
// runtime (AgentBrowserTools.register + helpers) and of fetch: the HEAD → GET fallback, redirects,
// 4xx/5xx, network errors and the timeout; the link collection filter and the reports; the 🔗 tab.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const CHECKS_JS = fileURLToPath(new URL("../browser/extras/checks.js", import.meta.url));
const plain = (x) => JSON.parse(JSON.stringify(x));

/** A fetch answering from a route table: url → { status, headStatus, headers, redirectTo, fail, hang, delay }. */
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
    return { status, ok: status >= 200 && status < 300, url: r.redirectTo || String(url), redirected: !!r.redirectTo, headers: { get: (k) => (k.toLowerCase() in headers ? headers[k.toLowerCase()] : null) }, body: null };
  };
  f.calls = calls;
  return f;
}

/** Load checks.js the way extras.js is loaded in the panel, with a brand that has (or lacks) the feature. */
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
          if (!page) throw new Error("This page (chrome://newtab) can't be automated — navigate to a regular website first.");
          return plain(page);
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

test("with the feature: both tools, the 🔗 tab watching its storage key, the Monitoring quick commands", () => {
  const { tools, ctx } = load();
  assert.deepEqual(Object.keys(tools).sort(), ["browser_check_links", "browser_check_url"]);
  assert.equal(ctx.AgentExtras.tabs.length, 1);
  assert.equal(ctx.AgentExtras.tabs[0].id, "checks");
  assert.equal(ctx.AgentExtras.tabs[0].label, "🔗 Checks");
  assert.deepEqual(plain(ctx.AgentExtras.tabs[0].storageKeys), ["agentLinkCheck"]);
  assert.equal(typeof ctx.AgentExtras.tabs[0].render, "function");
  assert.deepEqual(plain(ctx.AgentExtras.commands.map((c) => [c.group, c.name, !!c.partial])), [
    ["Monitoring", "Find broken links on this page", false],
    ["Monitoring", "Check this URL's status", true],
    ["Monitoring", "Check the links in the footer and navigation only", false],
  ]);
  for (const c of ctx.AgentExtras.commands) assert.match(c.prompt, /browser_check_(url|links)/, c.name + " names its tool");
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
