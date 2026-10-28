// The "uptime" extra: the status mode of the watchers (browser/extension/automation.js, run in the
// service worker with a fake fetch — baseline, flips, the history ring) and the tools, formatting and
// ⏱ tab of browser/extras/uptime.js, against fakes of chrome.storage / alarms / tabs / notifications
// and of the tool runtime; the pause/resume tool and the history report (summarizeHistory on fixed
// histories). Same harness shape as tests/automation.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const AUTOMATION_JS = fileURLToPath(new URL("../browser/extension/automation.js", import.meta.url));
const UPTIME_JS = fileURLToPath(new URL("../browser/extras/uptime.js", import.meta.url));
const plain = (x) => JSON.parse(JSON.stringify(x));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeChrome() {
  const data = {};
  const alarms = new Map();
  const notifications = [];
  const tabs = { created: [], removed: [] };
  const listeners = [];
  const chrome = {
    storage: {
      local: {
        async get(keys) {
          const ks = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(data);
          const out = {};
          for (const k of ks) if (k in data) out[k] = plain(data[k]);
          return out;
        },
        async set(items) { Object.assign(data, plain(items)); listeners.forEach((fn) => fn(items, "local")); },
        async remove(keys) { for (const k of [].concat(keys)) delete data[k]; },
      },
      onChanged: { addListener: (fn) => listeners.push(fn) },
    },
    alarms: {
      async create(name, info) { alarms.set(name, { name, ...info }); },
      async clear(name) { alarms.delete(name); },
      async getAll() { return [...alarms.values()]; },
    },
    runtime: {
      getURL: (p) => "chrome-extension://abc/" + p,
      sendMessage(msg, cb) { chrome.runtime.sent.push(msg); cb && cb({ ok: true, first: true, size: 8, status: "HTTP 200" }); },
      sent: [],
      lastError: undefined,
    },
    windows: { async getAll() { return [{ id: 1, focused: true, incognito: false }]; }, async create() { return { id: 2, tabs: [{ id: 99, windowId: 2 }] }; }, async remove() {} },
    tabs: {
      async create(o) { const t = { id: 50 + tabs.created.length, windowId: o.windowId, url: o.url }; tabs.created.push(t); return t; },
      async get(id) { return { id, status: "complete" }; },
      async remove(id) { tabs.removed.push(id); },
    },
    scripting: { pageText: "page", async executeScript() { return [{ result: chrome.scripting.pageText }]; } },
    notifications: { async create(id, o) { notifications.push({ id, ...o }); } },
  };
  return { chrome, data, alarms, notifications, tabs };
}

/** A fetch for the status endpoint(s): state.code, state.fail, state.headStatus, state.hang; every call recorded. */
function fakeFetch(state) {
  const calls = [];
  const f = async (url, init) => {
    init = init || {};
    calls.push({ url: String(url), method: init.method || "GET", cache: init.cache, redirect: init.redirect });
    if (String(url).startsWith("https://api.telegram.org/")) { f.telegram.push(JSON.parse(init.body)); return { ok: true }; }
    if (state.fail) throw new TypeError("Failed to fetch");
    if (state.hang) return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
    const status = init.method === "HEAD" && state.headStatus ? state.headStatus : state.code;
    return { status, ok: status >= 200 && status < 300, url: String(url), redirected: false, headers: { get: () => null }, body: null };
  };
  f.calls = calls;
  f.telegram = [];
  return f;
}

/** The tool runtime both modules need: what automation.js calls plus the extras' registry. */
function fakeTools() {
  const t = {
    tools: {},
    currentTab: 5,
    tabUrl: "https://tab.example/x",
    trace: () => [],
    refs: async () => [],
    setCurrentTab: (id) => (t.currentTab = id),
    currentTabId: () => t.currentTab,
    run: async (name) => [{ type: "text", text: "ok " + name }],
    register(name, fn) { if (t.tools[name]) throw new Error("Browser tool already defined: " + name); t.tools[name] = fn; },
    helpers: {
      text: (tx) => [{ type: "text", text: tx }],
      sleep,
      async currentTab() { if (!t.tabUrl) throw new Error("No active tab in this window."); return { id: 7, url: t.tabUrl, title: "Tab" }; },
    },
  };
  return t;
}

function load({ worker = false, brand = ["uptime", "watchers"], state = { code: 200 } } = {}) {
  const f = fakeChrome();
  const T = fakeTools();
  const fetch = fakeFetch(state);
  const ctx = { chrome: f.chrome, AgentBrowserTools: T, console, setTimeout, clearTimeout, URL, AbortController, fetch, confirm: () => true, AGENT_BRAND: { has: (x) => brand.includes(x) }, AgentExtras: { tabs: [], commands: [] } };
  if (!worker) ctx.window = {};
  const context = vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(AUTOMATION_JS, "utf8"), context);
  vm.runInContext(fs.readFileSync(UPTIME_JS, "utf8"), context);
  const run = async (name, args) => (await T.tools[name](args)).filter((p) => p.type === "text").map((p) => p.text).join("\n");
  return { A: context.AgentAutomation, U: ctx.AgentExtras.uptime, X: ctx.AgentExtras, T, fetch, state, run, ...f };
}

async function waitFor(fn, what, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await sleep(20);
  }
  throw new Error("timed out waiting for " + what);
}

// ── automation.js: mode "status" ──────────────────────────────────────────

test("watchCreate accepts mode status: expect and history fields, the alarm, the texts of create and list", async () => {
  const { A, data, alarms, chrome } = load();
  const out = await A.watchCreate({ url: "https://site.example/", mode: "status", every: 5, expect: 200, name: "Site" }, null);
  assert.match(out, /^Watching https:\/\/site\.example\/ every 5 min \(id: wch_\w+, the HTTP status, expecting 200\)\. The first check establishes the baseline/);
  const id = Object.keys(data.agentWatchers)[0];
  const w = data.agentWatchers[id];
  assert.equal(w.mode, "status");
  assert.equal(w.expect, 200);
  assert.deepEqual(w.history, []);
  assert.equal(w.selector, "");
  assert.equal(alarms.get("watch:" + id).periodInMinutes, 5);
  assert.deepEqual(plain(chrome.runtime.sent), [{ type: "runWatcher", id }], "the baseline check is requested from the worker");
  assert.match(await A.watchList(), /Watchers \(1\):\nwch_\w+  ⏱ Site  \|  https:\/\/site\.example\/  \|  every 5 min  \|  HTTP status \(expect 200\)  \|  not checked yet  \|  Telegram$/);
  await assert.rejects(A.watchCreate({ mode: "status" }, null), /url is required/);
  // expect is clamped to a status code; nonsense falls back to 200.
  await A.watchCreate({ url: "https://a.example/", mode: "status", expect: 999 }, null);
  await A.watchCreate({ url: "https://b.example/", mode: "status", expect: "abc" }, null);
  const ws = Object.values(data.agentWatchers);
  assert.equal(ws.find((x) => x.url === "https://a.example/").expect, 599);
  assert.equal(ws.find((x) => x.url === "https://b.example/").expect, 200);
  // Other modes are untouched by the new fields.
  await A.watchCreate({ url: "https://c.example/", selector: ".p" }, null);
  const sel = Object.values(data.agentWatchers).find((x) => x.url === "https://c.example/");
  assert.equal(sel.expect, undefined);
  assert.equal(sel.history, undefined);
});

test("worker: a status check opens no tab; the baseline is silent; 200 → 503 → 200 and a network error flip through notification + Telegram; history grows", async () => {
  const state = { code: 200 };
  const { A, data, notifications, tabs, T, fetch } = load({ worker: true, state });
  data.agentRemote = { mode: "bot", botToken: "1:x", userId: "42" };
  await A.watchCreate({ url: "https://site.example/", mode: "status", every: 5, name: "Site" }, null);
  const id = Object.keys(data.agentWatchers)[0];
  // watchCreate kicked off the baseline run in this (worker) context.
  let w = await waitFor(() => data.agentWatchers[id].lastRun && data.agentWatchers[id], "the baseline run");
  assert.equal(w.lastRun.ok, true, JSON.stringify(w.lastRun));
  assert.equal(w.lastContent, "HTTP 200");
  assert.equal(w.changes, 0);
  assert.equal(w.history.length, 1);
  assert.deepEqual([w.history[0].code, w.history[0].ok, w.history[0].ms >= 0, w.history[0].at > 0], [200, true, true, true]);
  assert.equal(notifications.length, 0, "the baseline is not a change");
  assert.deepEqual(tabs.created, [], "no background tab for a status check");
  assert.equal(T.currentTab, 5, "the tool runtime's current tab is untouched");
  assert.deepEqual(fetch.calls.map((c) => [c.method, c.cache, c.redirect]), [["HEAD", "no-store", "follow"]], "one HEAD request, uncached, redirects followed");

  // Down: a flip is a change like any other watcher's, with the two status strings as the diff.
  state.code = 503;
  let r = plain(await A.runWatcherById(id));
  assert.deepEqual(r, { ok: true, changed: true, first: false, added: 1, removed: 1, size: 8, ms: r.ms, status: "HTTP 503" });
  w = data.agentWatchers[id];
  assert.equal(w.changes, 1);
  assert.equal(w.lastContent, "HTTP 503");
  assert.equal(w.errors, 0, "an answering server is never a check error");
  assert.deepEqual(plain(w.history.map((e) => [e.code, e.ok])), [[200, true], [503, false]]);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].title, "Tali · Site");
  assert.equal(notifications[0].message, "HTTP 503");
  assert.equal(notifications[0].contextMessage, "https://site.example/");
  assert.equal(fetch.telegram.length, 1);
  assert.equal(fetch.telegram[0].chat_id, "42");
  assert.equal(fetch.telegram[0].text, "👁 Site changed: +1 / −1 lines\nhttps://site.example/\n\n+ HTTP 503\n− HTTP 200");
  assert.equal(data.agentWatchEvents.length, 1);
  assert.deepEqual([plain(data.agentWatchEvents[0].added), plain(data.agentWatchEvents[0].removed)], [["HTTP 503"], ["HTTP 200"]]);

  // Still down: no new event, the history still grows.
  r = await A.runWatcherById(id);
  assert.equal(r.changed, false);
  assert.equal(notifications.length, 1);
  assert.equal(data.agentWatchers[id].history.length, 3);

  // Back up: reported again.
  state.code = 200;
  r = await A.runWatcherById(id);
  assert.equal(r.changed, true);
  assert.equal(r.status, "HTTP 200");
  assert.equal(notifications.length, 2);
  assert.equal(notifications[1].message, "HTTP 200");
  assert.equal(fetch.telegram[1].text, "👁 Site changed: +1 / −1 lines\nhttps://site.example/\n\n+ HTTP 200\n− HTTP 503");
  assert.equal(data.agentWatchers[id].changes, 2);

  // Unreachable: "down: <reason>" is the content; HEAD then GET were tried; code 0 in the history; errors stay 0.
  state.fail = true;
  fetch.calls.length = 0;
  r = await A.runWatcherById(id);
  assert.equal(r.status, "down: Failed to fetch");
  assert.equal(r.changed, true);
  assert.deepEqual(fetch.calls.filter((c) => !c.url.startsWith("https://api.telegram")).map((c) => c.method), ["HEAD", "GET"]);
  w = data.agentWatchers[id];
  assert.equal(w.lastContent, "down: Failed to fetch");
  assert.equal(w.errors, 0);
  assert.deepEqual(plain(w.history.at(-1)), { at: w.history.at(-1).at, ms: w.history.at(-1).ms, code: 0, ok: false });
  assert.equal(notifications[2].message, "down: Failed to fetch");
  assert.equal(fetch.telegram[2].text, "👁 Site changed: +1 / −1 lines\nhttps://site.example/\n\n+ down: Failed to fetch\n− HTTP 200");

  // HEAD refused → GET decides.
  state.fail = false;
  state.headStatus = 405;
  fetch.calls.length = 0;
  r = await A.runWatcherById(id);
  assert.equal(r.status, "HTTP 200");
  assert.deepEqual(fetch.calls.filter((c) => !c.url.startsWith("https://api.telegram")).map((c) => c.method), ["HEAD", "GET"]);
  assert.equal(data.agentWatchers[id].history.length, 6);
  assert.equal(data.agentWatchEvents.length, 4);
});

test("worker: a status that differs from `expect` counts as down; 204 expected and answered is up", async () => {
  const state = { code: 204 };
  const { A, data } = load({ worker: true, state });
  await A.watchCreate({ url: "https://api.example/health", mode: "status", expect: 204 }, null);
  const id = Object.keys(data.agentWatchers)[0];
  await waitFor(() => data.agentWatchers[id].lastRun, "baseline");
  assert.deepEqual(plain(data.agentWatchers[id].history.map((e) => [e.code, e.ok])), [[204, true]]);
  state.code = 200;
  await A.runWatcherById(id);
  assert.deepEqual(plain(data.agentWatchers[id].history.map((e) => [e.code, e.ok])), [[204, true], [200, false]], "200 is not what this monitor expects");
});

test("worker: the history is a ring of the last 288 checks", async () => {
  const { A, data } = load({ worker: true });
  await A.watchCreate({ url: "https://site.example/", mode: "status" }, null);
  const id = Object.keys(data.agentWatchers)[0];
  await waitFor(() => data.agentWatchers[id].lastRun, "baseline");
  assert.equal(A.STATUS_HISTORY_MAX, 288);
  const all = await A.loadWatchers();
  all[id].history = Array.from({ length: 287 }, (_, i) => ({ at: i + 1, ms: 10, code: 200, ok: true }));
  await A.saveWatchers(all);
  await A.runWatcherById(id);
  assert.equal(data.agentWatchers[id].history.length, 288);
  assert.equal(data.agentWatchers[id].history[0].at, 1);
  await A.runWatcherById(id);
  const h = data.agentWatchers[id].history;
  assert.equal(h.length, 288, "capped");
  assert.equal(h[0].at, 2, "the oldest entry is dropped");
  assert.ok(h.at(-1).at > 1000, "the newest is this run");
});

test("worker: other watcher modes are untouched by the status branch (a tab opens, no fetch, no history)", async () => {
  const { A, data, tabs, fetch, chrome } = load({ worker: true });
  chrome.scripting.pageText = "hello";
  await A.watchCreate({ url: "https://page.example/", name: "Page" }, null);
  const id = Object.keys(data.agentWatchers)[0];
  await waitFor(() => data.agentWatchers[id].lastRun, "baseline");
  assert.equal(tabs.created.length, 1);
  assert.deepEqual(tabs.removed, [tabs.created[0].id]);
  assert.equal(fetch.calls.length, 0);
  assert.equal(data.agentWatchers[id].history, undefined);
  assert.equal(data.agentWatchers[id].lastContent, "hello");
  const r = await A.runWatcherById(id);
  assert.equal(r.status, undefined);
});

test("statusProbe: the strings and the entry", async () => {
  const state = { code: 301 };
  const { A, fetch } = load({ state });
  let p = plain(await A.statusProbe("https://x.example/", 200));
  assert.deepEqual([p.content, p.code, p.ok], ["HTTP 301", 301, false]);
  p = plain(await A.statusProbe("https://x.example/", 301));
  assert.deepEqual([p.content, p.code, p.ok], ["HTTP 301", 301, true]);
  state.fail = true;
  p = plain(await A.statusProbe("https://x.example/"));
  assert.deepEqual([p.content, p.code, p.ok], ["down: Failed to fetch", 0, false]);
  assert.ok(p.ms >= 0 && p.at > 0);
  assert.deepEqual(fetch.calls.map((c) => c.method), ["HEAD", "HEAD", "HEAD", "GET"]);
});

// ── uptime.js ──────────────────────────────────────────────────────────────

test("a brand without the feature gets nothing", () => {
  const { T, X } = load({ brand: ["watchers"] });
  assert.deepEqual(Object.keys(T.tools), []);
  assert.deepEqual(X.tabs, []);
  assert.deepEqual(X.commands, []);
  assert.equal(X.uptime, undefined);
});

test("registration: the five tools, the ⏱ tab on the watchers key, the Monitoring quick commands", () => {
  const { T, X } = load();
  assert.deepEqual(Object.keys(T.tools).sort(), ["browser_uptime_add", "browser_uptime_delete", "browser_uptime_list", "browser_uptime_report", "browser_uptime_toggle"]);
  assert.deepEqual(plain(X.tabs.map((t) => [t.id, t.label, t.storageKeys])), [["uptime", "⏱ Uptime", ["agentWatchers"]]]);
  assert.deepEqual(plain(X.commands.map((c) => [c.group, c.name, !!c.partial])), [["Monitoring", "Monitor this site's uptime", false], ["Monitoring", "Show my uptime monitors", false], ["Monitoring", "Uptime report", false]]);
  for (const c of X.commands) assert.match(c.prompt, /browser_uptime_(add|list|report)/);
});

test("browser_uptime_add: a status watcher every 5 min expecting 200, the id in the answer; the current tab as the default URL; clamps", async () => {
  const { run, data, alarms, chrome, T } = load();
  const out = await run("browser_uptime_add", { url: "https://site.example/", name: "Site" });
  assert.match(out, /^Monitoring https:\/\/site\.example\/ every 5 min \(id: wch_\w+\), expecting HTTP 200\. The first check sets the baseline; after that every flip \(e\.g\. 200 → 503 and back\) is reported with a system notification and, when the Telegram bot is set up, a Telegram message\. It runs in the background/);
  const id = /id: (wch_\w+)/.exec(out)[1];
  const w = data.agentWatchers[id];
  assert.deepEqual([w.mode, w.every, w.expect, w.name, w.enabled, w.history], ["status", 5, 200, "Site", true, []]);
  assert.equal(alarms.get("watch:" + id).periodInMinutes, 5);
  assert.deepEqual(plain(chrome.runtime.sent), [{ type: "runWatcher", id }]);
  // No url: the tab the tools work on.
  const out2 = await run("browser_uptime_add", { every: 0.3, expect: 204, telegram: false });
  assert.match(out2, /^Monitoring https:\/\/tab\.example\/x every 1 min \(id: wch_\w+\), expecting HTTP 204\. .*system notification\. It runs/);
  const w2 = data.agentWatchers[/id: (wch_\w+)/.exec(out2)[1]];
  assert.equal(w2.name, "tab.example", "named after the host");
  assert.equal(w2.notify.telegram, false);
  // No url and no usable tab.
  T.tabUrl = "";
  await assert.rejects(run("browser_uptime_add", {}), /url is required/);
  await assert.rejects(run("browser_uptime_add", { url: "ftp://x" }), /url is required/);
});

test("browser_uptime_list: state, last code and latency, failures in a row, history stats, sparkline; page watchers are not listed", async () => {
  const { run, data, A, U } = load();
  await A.watchCreate({ url: "https://a.example/", mode: "status", name: "A", every: 5 }, null);
  await A.watchCreate({ url: "https://b.example/", mode: "status", name: "B", every: 1, expect: 204, telegram: false }, null);
  await A.watchCreate({ url: "https://c.example/", mode: "status", name: "C", every: 5 }, null);
  await A.watchCreate({ url: "https://page.example/", selector: ".p", name: "Page" }, null);
  const all = await A.loadWatchers();
  const byName = (n) => Object.values(all).find((w) => w.name === n);
  const now = Date.now();
  byName("A").history = [{ at: now - 3000, ms: 100, code: 200, ok: true }, { at: now - 2000, ms: 300, code: 200, ok: true }, { at: now - 1000, ms: 50, code: 503, ok: false }];
  byName("A").lastContent = "HTTP 503";
  byName("A").lastRun = { at: now - 1000, ok: true, ms: 50, hash: "x", size: 8 };
  byName("C").history = [{ at: now - 4000, ms: 80, code: 200, ok: true }, { at: now - 3000, ms: 0, code: 0, ok: false }, { at: now - 2000, ms: 0, code: 0, ok: false }, { at: now - 1000, ms: 0, code: 0, ok: false }];
  byName("C").lastContent = "down: timeout after 15 s";
  byName("C").lastRun = { at: now - 1000, ok: true, ms: 0, hash: "y", size: 24 };
  byName("C").enabled = false;
  await A.saveWatchers(all);
  const out = await run("browser_uptime_list", {});
  const lines = out.split("\n");
  assert.equal(lines[0], "Uptime monitors (3):");
  assert.equal(lines.length, 4, "the page watcher is not an uptime monitor");
  const line = (name) => lines.find((l) => l.includes("  " + name + "  |  "));
  assert.match(line("C"), /^wch_\w+  🔴 DOWN \(3 failures in a row\)  C  \|  ⏸ paused  \|  https:\/\/c\.example\/  \|  every 5 min  \|  expects 200  \|  last: down: timeout after 15 s, just now  \|  history: 25% up, 4 checks, 3 failures, avg 80 ms  ▇×××  \|  since just now  \|  Telegram$/);
  assert.match(line("B"), /^wch_\w+  ⚪ UNKNOWN  B  \|  https:\/\/b\.example\/  \|  every 1 min  \|  expects 204  \|  not checked yet  \|  since just now$/);
  assert.match(line("A"), /^wch_\w+  🔴 DOWN  A  \|  https:\/\/a\.example\/  \|  every 5 min  \|  expects 200  \|  last: HTTP 503 in 50 ms, just now  \|  history: 66\.7% up, 3 checks, 1 failure, avg 150 ms  ▃▇×  \|  since just now  \|  Telegram$/);
  // Up again: the dot flips.
  const again = await A.loadWatchers();
  Object.values(again).find((w) => w.name === "A").history.push({ at: now, ms: 120, code: 200, ok: true });
  Object.values(again).find((w) => w.name === "A").lastContent = "HTTP 200";
  await A.saveWatchers(again);
  assert.match(await run("browser_uptime_list", {}), /🟢 UP  A  \|  .*last: HTTP 200 in 120 ms, just now  \|  history: 75% up, 4 checks, 1 failure, avg 143 ms  ▃▇×▃/);
  // A check that itself failed (an exception in the worker) is shown as such.
  const err = await A.loadWatchers();
  Object.values(err).find((w) => w.name === "B").lastRun = { at: now, ok: false, error: "fetch is not defined", ms: 1 };
  await A.saveWatchers(err);
  assert.match(await run("browser_uptime_list", {}), /⚪ UNKNOWN  B  \|  .*  \|  ERROR just now: fetch is not defined  \|/);
  assert.equal(U.formatList({}), "No uptime monitors. browser_uptime_add checks a site's HTTP status on a schedule and reports when it goes down or comes back.");
  // Only page watchers → also "no monitors".
  assert.match(U.formatList({ x: { mode: "text", name: "p" } }), /^No uptime monitors\./);
});

test("browser_uptime_delete: by id or name, the alarm goes; a page watcher or an unknown name is refused; ambiguous names ask for the id", async () => {
  const { run, data, alarms, A } = load();
  const out = await run("browser_uptime_add", { url: "https://site.example/", name: "Site" });
  const id = /id: (wch_\w+)/.exec(out)[1];
  await A.watchCreate({ url: "https://page.example/", name: "Page" }, null);
  const pageId = Object.keys(data.agentWatchers).find((k) => k !== id);
  assert.equal(alarms.size, 2);
  await assert.rejects(run("browser_uptime_delete", { id: pageId }), /is a page watcher, not an uptime monitor — browser_watch_delete handles it/);
  await assert.rejects(run("browser_uptime_delete", { name: "Page" }), /No uptime monitor named 'Page'/);
  await assert.rejects(run("browser_uptime_delete", { id: "wch_nope" }), /No uptime monitor with id wch_nope/);
  assert.equal(await run("browser_uptime_delete", { name: "site" }), "Deleted uptime monitor 'Site'.");
  assert.deepEqual(Object.keys(data.agentWatchers), [pageId], "the page watcher stays");
  assert.deepEqual([...alarms.keys()], ["watch:" + pageId]);
  await run("browser_uptime_add", { url: "https://a.example/", name: "Twin" });
  await run("browser_uptime_add", { url: "https://b.example/", name: "Twin" });
  await assert.rejects(run("browser_uptime_delete", { name: "Twin" }), /Several monitors are named 'Twin' — pass the id/);
  const twinId = Object.values(data.agentWatchers).find((w) => w.url === "https://a.example/").id;
  assert.equal(await run("browser_uptime_delete", { id: twinId }), "Deleted uptime monitor 'Twin'.");
});

test("helpers: sparkline, uptimePercent, consecutiveFailures, stateOf, statusWatchers", () => {
  const { U } = load();
  const h = (...ms) => ms.map((m) => (m === null ? { at: 1, ms: 0, code: 0, ok: false } : { at: 1, ms: m, code: 200, ok: true }));
  assert.equal(U.sparkline([]), "");
  assert.equal(U.sparkline(h(10)), "▇", "one check is the maximum");
  assert.equal(U.sparkline(h(0, 50, 100, 150, 200, 250, 300)), "▁▂▃▄▅▆▇");
  assert.equal(U.sparkline(h(100, null, 50)), "▇×▄");
  assert.equal(U.sparkline(h(null, null)), "××");
  assert.equal(U.sparkline(h(1, 2, 3, 4, 5), 3), "▄▅▇", "only the last `width` checks");
  assert.equal(U.sparkline(h(...Array(40).fill(7))).length, 24, "the default width");
  assert.equal(U.uptimePercent([]), null);
  assert.equal(U.uptimePercent(h(1, 2)), 100);
  assert.equal(U.uptimePercent(h(1, null, 2, null)), 50);
  assert.equal(U.uptimePercent(h(1, 2, null)), 66.7);
  assert.equal(U.consecutiveFailures([]), 0);
  assert.equal(U.consecutiveFailures(h(1, null, null)), 2);
  assert.equal(U.consecutiveFailures(h(null, 1)), 0);
  const s = plain(U.stateOf({ created: 5, history: [{ at: 10, ms: 100, code: 200, ok: true }, { at: 20, ms: 40, code: 500, ok: false }, { at: 30, ms: 0, code: 0, ok: false }] }));
  assert.deepEqual(s, { state: "down", code: 0, ms: 0, at: 30, consecutiveFailures: 2, checks: 3, failures: 2, uptime: 33.3, avgMs: 70, since: 5 });
  assert.deepEqual(plain(U.stateOf({ created: 5 })), { state: "unknown", code: null, ms: null, at: null, consecutiveFailures: 0, checks: 0, failures: 0, uptime: null, avgMs: null, since: 5 });
  assert.deepEqual(plain(U.statusWatchers({ a: { mode: "status", created: 1 }, b: { mode: "text", created: 3 }, c: { mode: "status", created: 2 } })).map((w) => w.created), [2, 1], "newest first, status only");
  assert.deepEqual(plain(U.statusWatchers(undefined)), []);
});

// A fake DOM for the tab: ctx.el builds plain objects.
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

test("the ⏱ tab: empty state, the list with dots and sparklines, Check now / Pause / Delete, the add form", async () => {
  const { X, A, data, alarms, chrome } = load();
  const statuses = [];
  let rerenders = 0;
  const pctx = { el: fakeEl, field: (l, i) => fakeEl("label", { className: "ed-label" }, [l, i]), ago: () => "just now", hostOf: (u) => new URL(u).hostname, status: (t, k) => statuses.push([t, k]), sendPrompt: () => {}, currentTabUrl: async () => "https://tab.example/x", rerender: () => rerenders++ };
  const tab = X.tabs[0];
  let content = fakeEl("div");
  await tab.render(content, pctx);
  assert.match(textOf(content), /Monitor a site's uptime/);
  assert.match(textOf(content), /No uptime monitors yet\./);
  // Add through the form: URL prefilled with the current tab, every 5, expect 200.
  await find(content, (n) => n.props.className === "cmd-item").props.onclick();
  const inputs = [];
  (function walk(n) { if (typeof n === "string") return; if (n.tag === "input") inputs.push(n); n.children.forEach(walk); })(content);
  assert.deepEqual(inputs.map((i) => [i.props.type || "text", String(i.props.value === undefined ? "" : i.props.value)]), [["text", "https://tab.example/x"], ["text", ""], ["number", "5"], ["number", "200"], ["checkbox", ""]]);
  inputs[0].value = "https://site.example/"; inputs[1].value = ""; inputs[1].placeholder = "site.example"; inputs[2].value = "5"; inputs[3].value = "200"; inputs[4].checked = true;
  await find(content, (n) => n.tag === "button" && n.children[0] === "⏱ Start monitoring").props.onclick();
  assert.equal(statuses.at(-1)[1], "good");
  assert.match(statuses.at(-1)[0], /^Monitoring https:\/\/site\.example\/ every 5 min \(id: wch_\w+\), expecting HTTP 200\.$/);
  assert.equal(rerenders, 1);
  const id = Object.keys(data.agentWatchers)[0];
  assert.equal(data.agentWatchers[id].name, "site.example");
  // The list with a history.
  const all = await A.loadWatchers();
  all[id].history = [{ at: Date.now() - 2000, ms: 100, code: 200, ok: true }, { at: Date.now() - 1000, ms: 200, code: 200, ok: true }];
  all[id].lastContent = "HTTP 200";
  await A.saveWatchers(all);
  content = fakeEl("div");
  await tab.render(content, pctx);
  const txt = textOf(content);
  assert.match(txt, /🟢/);
  assert.match(txt, /site\.example · every 5 min · expects 200/);
  assert.match(txt, /last: HTTP 200 in 200 ms, just now/);
  assert.match(txt, /▄▇  100% up · 2 checks · avg 150 ms/);
  // Check now goes through requestRun (the worker answers through runtime.sendMessage here).
  await find(content, (n) => n.props.title === "Check now").props.onclick({ stopPropagation() {} });
  assert.deepEqual(statuses.at(-1), ["✓ HTTP 200 — baseline saved.", "good"]);
  assert.deepEqual(plain(chrome.runtime.sent.filter((m) => m.type === "runWatcher")).length, 2);
  // Pause.
  await find(content, (n) => n.props.title === "Pause").props.onclick({ stopPropagation() {} });
  assert.equal(data.agentWatchers[id].enabled, false);
  assert.equal(alarms.size, 0);
  content = fakeEl("div");
  await tab.render(content, pctx);
  assert.match(textOf(content), /· paused/);
  assert.ok(find(content, (n) => n.props.title === "Resume"));
  // A down monitor is marked.
  const down = await A.loadWatchers();
  down[id].history.push({ at: Date.now() - 500, ms: 0, code: 0, ok: false }, { at: Date.now(), ms: 0, code: 0, ok: false });
  down[id].lastContent = "down: Failed to fetch";
  await A.saveWatchers(down);
  content = fakeEl("div");
  await tab.render(content, pctx);
  assert.match(textOf(content), /🔴/);
  assert.match(textOf(content), /last: down: Failed to fetch, just now · 2 failures in a row/);
  assert.ok(find(content, (n) => n.props.className === "cmd-desc bad"));
  // Delete (the page's confirm() says yes).
  await find(content, (n) => n.props.title === "Delete").props.onclick({ stopPropagation() {} });
  await waitFor(() => !data.agentWatchers[id], "the delete");
  assert.deepEqual(data.agentWatchers, {});
  content = fakeEl("div");
  await tab.render(content, pctx);
  assert.match(textOf(content), /No uptime monitors yet\./);
});

// ── browser_uptime_toggle ──────────────────────────────────────────────────

test("browser_uptime_toggle: pauses (the alarm goes) and resumes (the alarm is back) a monitor, flips without `enabled`, says when nothing changes; id required; page watchers refused", async () => {
  const { run, data, alarms, A } = load();
  const out = await run("browser_uptime_add", { url: "https://site.example/", name: "Site" });
  const id = /id: (wch_\w+)/.exec(out)[1];
  assert.ok(alarms.has("watch:" + id));
  assert.equal(await run("browser_uptime_toggle", { id }), `Paused the uptime monitor 'Site' (${id}) — no checks or notifications until it is resumed (browser_uptime_toggle with enabled=true); the history is kept.`);
  assert.equal(data.agentWatchers[id].enabled, false);
  assert.equal(alarms.has("watch:" + id), false, "a paused monitor has no alarm, as the watcher machinery expects");
  assert.equal(await run("browser_uptime_toggle", { id }), `Resumed the uptime monitor 'Site' (${id}) — checking https://site.example/ every 5 min, the next check within a minute.`);
  assert.equal(data.agentWatchers[id].enabled, true);
  assert.deepEqual(plain(alarms.get("watch:" + id)), { name: "watch:" + id, periodInMinutes: 5, delayInMinutes: 0.5 });
  assert.match(await run("browser_uptime_toggle", { id, enabled: true }), /^The uptime monitor 'Site' \(wch_\w+\) was already running — checking https:\/\/site\.example\/ every 5 min/);
  assert.equal(data.agentWatchers[id].enabled, true);
  assert.match(await run("browser_uptime_toggle", { id, enabled: false }), /^Paused the uptime monitor 'Site'/);
  assert.match(await run("browser_uptime_toggle", { id, enabled: false }), /^The uptime monitor 'Site' \(wch_\w+\) was already paused — no checks/);
  assert.equal(data.agentWatchers[id].enabled, false);
  assert.equal(alarms.has("watch:" + id), false);
  assert.match(await run("browser_uptime_list", {}), /⏸ paused/);
  await assert.rejects(run("browser_uptime_toggle", {}), /id is required/);
  await A.watchCreate({ url: "https://page.example/", name: "Page" }, null);
  const pageId = Object.keys(data.agentWatchers).find((k) => k !== id);
  await assert.rejects(run("browser_uptime_toggle", { id: pageId }), /is a page watcher, not an uptime monitor/);
  assert.equal(data.agentWatchers[pageId].enabled, true, "the page watcher is untouched");
  await assert.rejects(run("browser_uptime_toggle", { id: "wch_nope" }), /No uptime monitor with id wch_nope/);
});

// ── summarizeHistory / browser_uptime_report ───────────────────────────────

const MIN = 60000;
/** A history entry `minAgo` minutes before `now`; a failed check has code 0 unless given. */
const entry = (now, minAgo, ok, ms, code) => ({ at: now - minAgo * MIN, ok, ms, code: code === undefined ? (ok ? 200 : 0) : code });
/** 12 checks over an hour: up, up, an outage spanning two checks (503 then a timeout), up, up, one timeout, then up. */
const sampleHistory = (now) => [
  entry(now, 60, true, 100), entry(now, 55, true, 120), entry(now, 50, false, 30, 503), entry(now, 45, false, 0), entry(now, 40, true, 90), entry(now, 35, true, 200),
  entry(now, 30, false, 0), entry(now, 25, true, 110), entry(now, 20, true, 95), entry(now, 15, true, 130), entry(now, 10, true, 105), entry(now, 5, true, 115),
];

test("summarizeHistory: availability, latency avg/median/p95 of the answered checks, flips, outages (one spanning two samples), the longest, the last state", () => {
  const { U } = load();
  const now = 1700000000000;
  const r = plain(U.summarizeHistory(sampleHistory(now), now - 2 * 3600000, now));
  assert.deepEqual(r, {
    checks: 12, up: 9, down: 3, availability: 75,
    avgMs: 110, medianMs: 108, p95Ms: 200, // the 503 answered in 30 ms counts, the timeouts (code 0) do not
    flips: 4, outages: 2,
    longestOutage: { from: now - 50 * MIN, to: now - 40 * MIN, ms: 10 * MIN, checks: 2, ongoing: false },
    last: { at: now - 5 * MIN, ok: true, code: 200, ms: 115 },
    state: "up",
  });
  // Only the window counts: from 32 minutes ago there is one timeout, one flip, a 5 min outage.
  const w = plain(U.summarizeHistory(sampleHistory(now), now - 32 * MIN, now));
  assert.deepEqual([w.checks, w.up, w.down, w.availability, w.flips, w.outages], [6, 5, 1, 83.3, 1, 1]);
  assert.deepEqual(w.longestOutage, { from: now - 30 * MIN, to: now - 25 * MIN, ms: 5 * MIN, checks: 1, ongoing: false });
  assert.deepEqual([w.avgMs, w.medianMs, w.p95Ms], [111, 110, 130]);
  // An outage that has not ended runs to nowTs and says so.
  const down = plain(U.summarizeHistory([entry(now, 10, true, 100), entry(now, 5, false, 0), entry(now, 2, false, 0)], 0, now));
  assert.deepEqual([down.checks, down.availability, down.flips, down.outages, down.state], [3, 33.3, 1, 1, "down"]);
  assert.deepEqual(down.longestOutage, { from: now - 5 * MIN, to: null, ms: 5 * MIN, checks: 2, ongoing: true });
  assert.deepEqual([down.avgMs, down.medianMs, down.p95Ms], [100, 100, 100]);
  assert.deepEqual(down.last, { at: now - 2 * MIN, ok: false, code: 0, ms: 0 });
  // All down and never answered: no latency.
  const silent = plain(U.summarizeHistory([entry(now, 3, false, 0), entry(now, 1, false, 0)], 0, now));
  assert.deepEqual([silent.availability, silent.avgMs, silent.medianMs, silent.p95Ms, silent.flips, silent.outages, silent.longestOutage.ms], [0, null, null, null, 0, 1, 3 * MIN]);
  // Empty, undefined, or nothing inside the window.
  const empty = { checks: 0, up: 0, down: 0, availability: null, avgMs: null, medianMs: null, p95Ms: null, flips: 0, outages: 0, longestOutage: null, last: null, state: "unknown" };
  assert.deepEqual(plain(U.summarizeHistory([], 0, now)), empty);
  assert.deepEqual(plain(U.summarizeHistory(undefined, 0, now)), empty);
  assert.deepEqual(plain(U.summarizeHistory(sampleHistory(now), now - MIN, now)), empty);
  // Odd count → the middle value is the median; p95 of one value is that value.
  const odd = plain(U.summarizeHistory([entry(now, 3, true, 300), entry(now, 2, true, 100), entry(now, 1, true, 200)], 0, now));
  assert.deepEqual([odd.avgMs, odd.medianMs, odd.p95Ms], [200, 200, 300]);
  assert.equal(U.fmtDuration(30 * 1000), "< 1 min");
  assert.equal(U.fmtDuration(5 * MIN), "5 min");
  assert.equal(U.fmtDuration(60 * MIN), "1 h");
  assert.equal(U.fmtDuration(90 * MIN), "1 h 30 min");
  assert.equal(U.fmtDuration(25 * 60 * MIN), "1 d 1 h");
  assert.equal(U.fmtDuration(48 * 60 * MIN), "2 d");
  assert.match(U.stamp(now), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
});

test("browser_uptime_report: a compact table per monitor over the window, one monitor by id, hours clamped, monitors without checks, no monitors", async () => {
  const { run, data, A, U } = load();
  await A.watchCreate({ url: "https://a.example/", mode: "status", name: "A", every: 5 }, null);
  await A.watchCreate({ url: "https://b.example/", mode: "status", name: "B", every: 1 }, null);
  await A.watchCreate({ url: "https://page.example/", selector: ".p", name: "Page" }, null);
  const all = await A.loadWatchers();
  const byName = (n) => Object.values(all).find((w) => w.name === n);
  const now = Date.now();
  byName("A").history = sampleHistory(now);
  byName("B").history = [entry(now, 30 * 60, true, 50)]; // 30 h ago: outside the default window
  byName("B").enabled = false;
  await A.saveWatchers(all);
  const idA = byName("A").id, idB = byName("B").id;
  let lines = (await run("browser_uptime_report", {})).split("\n");
  assert.match(lines[0], /^Uptime report, last 24 h \(2 monitors, since \d{4}-\d{2}-\d{2} \d{2}:\d{2}\):$/);
  // A block per monitor (the two were created in the same millisecond, so their order is not fixed).
  const block = (id) => { const i = lines.findIndex((l) => l.startsWith(id + "  ")); const j = lines.findIndex((l, k) => k > i && /^wch_/.test(l)); return lines.slice(i, j < 0 ? undefined : j); };
  assert.deepEqual(block(idB), [`${idB}  B  |  https://b.example/  |  every 1 min  |  ⏸ paused`, "  no checks in the last 24 h (1 older in the history)."]);
  assert.deepEqual(block(idA), [
    `${idA}  A  |  https://a.example/  |  every 5 min`,
    "  state       🟢 UP  ·  HTTP 200 in 115 ms  ·  5 min ago",
    "  checks      12  ·  9 up, 3 down  ·  availability 75%",
    "  latency     avg 110 ms  ·  median 108 ms  ·  p95 200 ms",
    `  incidents   4 flips  ·  2 outages, longest 10 min (${U.stamp(now - 50 * MIN)} → ${U.stamp(now - 40 * MIN)})`,
  ]);
  assert.equal(lines.length, 8, "the page watcher is not reported");
  // One monitor, a shorter window; a value below 1 is nonsense and means the default, like `every` in browser_uptime_add.
  lines = (await run("browser_uptime_report", { id: idA, hours: 1 })).split("\n");
  assert.match(lines[0], /^Uptime report, last 1 h \(1 monitor, since /);
  assert.equal(lines.length, 6);
  assert.match(await run("browser_uptime_report", { id: idA, hours: "0.5" }), /^Uptime report, last 24 h \(1 monitor/);
  lines = (await run("browser_uptime_report", { id: idA, hours: 10000 })).split("\n");
  assert.match(lines[0], /^Uptime report, last 720 h \(1 monitor/, "hours is capped at 720 (30 days)");
  // B, resumed and with an outage still running.
  const again = await A.loadWatchers();
  again[idB].history = [entry(now, 10, true, 100), entry(now, 5, false, 0), entry(now, 2, false, 0)];
  again[idB].enabled = true;
  await A.saveWatchers(again);
  lines = (await run("browser_uptime_report", { id: idB })).split("\n");
  assert.deepEqual(lines.slice(1), [
    `${idB}  B  |  https://b.example/  |  every 1 min`,
    "  state       🔴 DOWN  ·  no answer (timeout or network error)  ·  2 min ago",
    "  checks      3  ·  1 up, 2 down  ·  availability 33.3%",
    "  latency     avg 100 ms  ·  median 100 ms  ·  p95 100 ms",
    `  incidents   1 flip  ·  1 outage, longest 5 min (since ${U.stamp(now - 5 * MIN)}, still down)`,
  ]);
  // A monitor that never checked, and one whose checks never answered.
  const fresh = await A.loadWatchers();
  fresh[idB].history = [];
  fresh[idA].history = [entry(now, 3, false, 0)];
  await A.saveWatchers(fresh);
  const out = await run("browser_uptime_report", {});
  assert.match(out, /\n  no checks in the last 24 h — waiting for the first check\.(\n|$)/);
  assert.match(out, /\n  latency     no answered check\n  incidents   0 flips  ·  1 outage, longest 3 min \(since .*, still down\)(\n|$)/);
  await assert.rejects(run("browser_uptime_report", { id: "wch_nope" }), /No uptime monitor with id wch_nope/);
  const empty = load();
  assert.equal(await empty.run("browser_uptime_report", {}), "No uptime monitors. browser_uptime_add checks a site's HTTP status on a schedule and reports when it goes down or comes back.");
});
