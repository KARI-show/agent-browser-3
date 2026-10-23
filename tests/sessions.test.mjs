// Tab sessions (browser/extras/sessions.js) against fakes of chrome.storage / tabs / windows and of
// the tool registry: which tabs a save keeps, replace-by-name, list, restore into a new or the current
// window (pinned and active state, the fallbacks), delete, the cap, and the 🗂 tab.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { fakeDom, fakeStorage, fakeTools, loadExtra, outText, plain, settle } from "./mocks/extras-orbit.mjs";

const SESSIONS_JS = fileURLToPath(new URL("../browser/extras/sessions.js", import.meta.url));
const OWN = "chrome-extension://abc/";

/** A browser of windows and tabs with the chrome.tabs / chrome.windows calls the module makes. */
function fakeBrowser() {
  let nextTab = 100;
  let nextWin = 2;
  const windows = new Map();
  const win = (id, tabs) => { windows.set(id, { id, tabs }); return windows.get(id); };
  // Window 1: the panel's window — a new-tab page, the panel itself, two sites, about:blank.
  win(1, [
    { id: 1, windowId: 1, url: "chrome://newtab/", title: "New Tab", pinned: false, active: false },
    { id: 2, windowId: 1, url: OWN + "sidepanel.html", title: "Orbit", pinned: false, active: false },
    { id: 3, windowId: 1, url: "https://a.example/one", title: "One", pinned: true, active: false },
    { id: 4, windowId: 1, url: "https://b.example/two?x=1", title: "Two", pinned: false, active: true },
    { id: 5, windowId: 1, url: "about:blank", title: "", pinned: false, active: false },
  ]);
  const calls = { windowsCreate: [], tabsCreate: [], tabsUpdate: [], messages: [] };
  const all = () => [...windows.values()].flatMap((w) => w.tabs);
  function makeTab(windowId, o) {
    const t = { id: nextTab++, windowId, url: o.url, title: "", pinned: !!o.pinned, active: !!o.active };
    windows.get(windowId).tabs.push(t);
    return t;
  }
  function createWindow(o) {
    const id = nextWin++;
    const w = win(id, []);
    [].concat(o.url || "about:blank").forEach((url, i) => makeTab(id, { url, active: i === 0 }));
    return { id, focused: !!o.focused, tabs: chrome.windows.populate ? plain(w.tabs) : undefined };
  }
  const chrome = {
    runtime: {
      getURL: (p) => OWN + p,
      // The service worker's createWindow handler (the Edge fallback).
      async sendMessage(msg) { calls.messages.push(msg); return msg.type === "createWindow" ? { ok: true, win: createWindow(msg.options || {}) } : undefined; },
    },
    tabs: {
      async query(q) {
        if (q.windowId !== undefined) return plain((windows.get(q.windowId) || { tabs: [] }).tabs);
        if (q.currentWindow) return plain(windows.get(1).tabs);
        return plain(all());
      },
      async create(o) { calls.tabsCreate.push(o); return plain(makeTab(o.windowId, o)); },
      async update(id, props) {
        calls.tabsUpdate.push([id, props]);
        const t = all().find((x) => x.id === id);
        if (!t) throw new Error("No tab with id: " + id);
        if (props.active) windows.get(t.windowId).tabs.forEach((x) => (x.active = false));
        Object.assign(t, props);
        return plain(t);
      },
    },
    windows: {
      populate: true, // windows.create returns the window with its tabs (Chrome does; the module copes without)
      failCreate: false, // the side panel can't create windows (Edge): the module asks the service worker
      async create(o) {
        calls.windowsCreate.push(o);
        if (chrome.windows.failCreate) throw new Error("windows.create is not available here");
        return createWindow(o);
      },
      async getCurrent() { return { id: 1 }; },
    },
  };
  return { chrome, windows, calls, all };
}

function load({ features = ["sessions"] } = {}) {
  const { data, storage } = fakeStorage();
  const b = fakeBrowser();
  b.chrome.storage = storage;
  const T = fakeTools({
    // The agent works in tab 4 of window 1 unless the test says otherwise.
    currentTab: async () => { if (T.noTab) throw new Error("No active tab in this window."); return plain(b.all().find((t) => t.id === T.current)); },
    ownPage: (t) => !!(t && t.url && t.url.startsWith(OWN)),
  });
  T.current = 4;
  const X = { tabs: [], commands: [] };
  loadExtra(SESSIONS_JS, { chrome: b.chrome, AgentBrowserTools: T, AgentExtras: X, AGENT_BRAND: { has: (f) => features.includes(f) }, confirm: () => true });
  return { tools: T.tools, T, X, S: X.sessions, data, ...b };
}

const sessions = (data) => data.agentSessions || [];
const ONE = { url: "https://a.example/one", title: "One", pinned: true, active: false };
const TWO = { url: "https://b.example/two?x=1", title: "Two", pinned: false, active: true };

test("sessions: the module is inert in a brand without the feature", () => {
  const { tools, X } = load({ features: ["clips"] });
  assert.deepEqual(Object.keys(tools), []);
  assert.deepEqual(X.tabs, []);
  assert.deepEqual(X.commands, []);
  assert.equal(X.sessions, undefined);
});

test("sessions: restorableTabs keeps the sites in window order and drops the panel, browser pages and about:blank", async () => {
  const { S, chrome } = load();
  const tabs = await chrome.tabs.query({ windowId: 1 });
  assert.deepEqual(plain(S.restorableTabs(tabs, OWN)), [ONE, TWO]);
  assert.deepEqual(plain(S.restorableTabs([{ url: "file:///etc/hosts" }, { url: "devtools://x" }, { url: "view-source:https://a.example" }, { url: "" }, null], OWN)), []);
  assert.deepEqual([...S.restorableTabs([{ url: "http://plain.example/", title: "t".repeat(300) }], OWN)].map((t) => t.title.length), [200]);
});

test("sessions: save → list → a save under the same name replaces → delete", async () => {
  const { tools, data, chrome } = load();
  await assert.rejects(tools.browser_session_save({}), /name is required/);
  await assert.rejects(tools.browser_session_save({ name: "   " }), /name is required/);
  const saved = outText(await tools.browser_session_save({ name: "  Research   Monday " }));
  assert.match(saved, /^Saved session 'Research Monday' \(id: ses_[a-z0-9]{6}\) — 2 tabs:\n  1\. 📌 One — https:\/\/a\.example\/one\n  2\. Two — https:\/\/b\.example\/two\?x=1  \(active\)$/);
  const s = sessions(data)[0];
  assert.deepEqual(plain({ ...s, id: "x", t: 0 }), { id: "x", t: 0, name: "Research Monday", tabs: [ONE, TWO] });
  assert.ok(Date.now() - s.t < 5000);
  assert.match(outText(await tools.browser_session_list({})), /^Sessions \(1\):\n  ses_[a-z0-9]{6}  Research Monday  \|  2 tabs  \|  saved just now\n    One; Two$/);

  // Same name, other case, a tab more: replaced in place, same id.
  await tools.browser_session_save({ name: "Other" });
  await chrome.tabs.create({ windowId: 1, url: "https://c.example/three", active: false });
  const replaced = outText(await tools.browser_session_save({ name: "research monday" }));
  assert.match(replaced, /^Replaced session 'research monday' \(id: ses_[a-z0-9]{6}\) — 3 tabs:/);
  assert.deepEqual(sessions(data).map((x) => [x.name, x.tabs.length]), [["research monday", 3], ["Other", 2]], "newest first, one entry per name");
  assert.equal(sessions(data)[0].id, s.id, "the id survives a replace");
  assert.match(outText(await tools.browser_session_list({})), /research monday  \|  3 tabs  \|  saved just now\n    One; Two; c\.example\n/);

  await assert.rejects(tools.browser_session_delete({}), /Give id or name \(see browser_session_list\)\./);
  await assert.rejects(tools.browser_session_delete({ name: "zzz" }), /^Error: No session named 'zzz'\. Saved: 'research monday', 'Other'\.$/);
  await assert.rejects(tools.browser_session_delete({ id: "ses_nope" }), /No session with id ses_nope\./);
  assert.equal(outText(await tools.browser_session_delete({ id: s.id })), "Deleted session 'research monday' (3 tabs).");
  assert.equal(outText(await tools.browser_session_delete({ name: "OTHER" })), "Deleted session 'Other' (2 tabs).");
  assert.deepEqual(sessions(data), []);
  assert.equal(outText(await tools.browser_session_list({})), "No sessions saved yet. browser_session_save keeps this window's tabs under a name.");
  await assert.rejects(tools.browser_session_delete({ name: "x" }), /No session named 'x'\. Nothing is saved yet\./);
});

test("sessions: a window with no website tabs has nothing to save", async () => {
  const { tools, T, chrome } = load();
  const w = await chrome.windows.create({ url: ["chrome://settings/", OWN + "options.html"] });
  T.current = w.tabs[0].id;
  await assert.rejects(tools.browser_session_save({ name: "x" }), /No website tabs to save in this window\./);
  // No agent tab at all: the panel's own window is saved.
  T.noTab = true;
  assert.match(outText(await tools.browser_session_save({ name: "panel" })), /— 2 tabs:\n  1\. 📌 One/);
});

test("sessions: restore into a new window (default) or the current one; pinned and active as saved", async () => {
  const { tools, T, data, windows, calls } = load();
  await tools.browser_session_save({ name: "S" });
  const id = sessions(data)[0].id;
  await assert.rejects(tools.browser_session_restore({}), /Give id or name/);
  await assert.rejects(tools.browser_session_restore({ name: "nope" }), /No session named 'nope'\. Saved: 'S'\./);

  const out = outText(await tools.browser_session_restore({ name: "s" }));
  assert.equal(out, "Restored session 'S': 2 tabs in new window 2 (1 pinned).\n  1. 📌 One — https://a.example/one\n  2. Two — https://b.example/two?x=1  (active)");
  assert.deepEqual(plain(calls.windowsCreate), [{ url: ["https://a.example/one", "https://b.example/two?x=1"], focused: true }]);
  const w2 = windows.get(2).tabs;
  assert.deepEqual(w2.map((t) => [t.url, t.pinned, t.active]), [["https://a.example/one", true, false], ["https://b.example/two?x=1", false, true]]);
  assert.deepEqual(T.switched, [w2[1].id], "the agent works in the restored active tab from now on");
  assert.deepEqual(calls.tabsCreate, [], "a new window gets its tabs from windows.create");

  const here = outText(await tools.browser_session_restore({ id, where: "current" }));
  assert.equal(here, "Restored session 'S': 2 tabs in window 1 (1 pinned).\n  1. 📌 One — https://a.example/one\n  2. Two — https://b.example/two?x=1  (active)");
  assert.equal(calls.windowsCreate.length, 1, "no new window");
  assert.deepEqual(plain(calls.tabsCreate), [
    { windowId: 1, url: "https://a.example/one", pinned: true, active: false },
    { windowId: 1, url: "https://b.example/two?x=1", pinned: false, active: false },
  ]);
  const w1 = windows.get(1).tabs;
  assert.deepEqual(w1.filter((t) => t.active).map((t) => t.url), ["https://b.example/two?x=1"]);
  assert.equal(w1.filter((t) => t.active)[0].id, w1.at(-1).id, "the restored copy is the active one, not the original tab");
  assert.equal(T.switched.at(-1), w1.at(-1).id);
  assert.deepEqual(sessions(data).map((s) => s.name), ["S"], "restoring changes nothing in the store");
});

test("sessions: restore copes with windows.create returning no tabs, and with a panel that can't create windows", async () => {
  const { tools, chrome, windows, calls } = load();
  await tools.browser_session_save({ name: "S" });
  chrome.windows.populate = false;
  assert.match(outText(await tools.browser_session_restore({ name: "S" })), /^Restored session 'S': 2 tabs in new window 2 \(1 pinned\)\./);
  assert.deepEqual(windows.get(2).tabs.map((t) => [t.pinned, t.active]), [[true, false], [false, true]]);
  chrome.windows.failCreate = true;
  assert.match(outText(await tools.browser_session_restore({ name: "S" })), /^Restored session 'S': 2 tabs in new window 3 /);
  assert.deepEqual(plain(calls.messages), [{ type: "createWindow", options: { url: ["https://a.example/one", "https://b.example/two?x=1"], focused: true } }]);
  assert.equal(windows.get(3).tabs.length, 2);
});

test("sessions: at most 50 sessions, the oldest dropped", async () => {
  const { tools, data, S } = load();
  let list = [];
  for (let i = 0; i < 55; i++) list = S.upsertSession(list, S.makeSession("s" + i, [ONE], 1000 + i));
  assert.equal(S.MAX, 50);
  assert.equal(list.length, 50);
  assert.deepEqual([list[0].name, list.at(-1).name], ["s54", "s5"]);
  assert.equal(new Set(list.map((s) => s.id)).size, 50);
  await S.save(list);
  await tools.browser_session_save({ name: "fresh" });
  assert.equal(sessions(data).length, 50);
  assert.deepEqual([sessions(data)[0].name, sessions(data).at(-1).name], ["fresh", "s6"]);
  assert.throws(() => S.makeSession("x", []), /No website tabs to save in this window\./);
  assert.throws(() => S.makeSession("", [ONE]), /name is required/);
});

test("sessions: the 🗂 tab and the Tabs quick commands", async () => {
  const { tools, X, data, windows, calls } = load();
  assert.deepEqual(plain(X.tabs.map((t) => [t.id, t.label, t.storageKeys])), [["sessions", "🗂 Sessions", ["agentSessions"]]]);
  assert.deepEqual(X.commands.map((c) => [c.group, c.name, !!c.partial]), [
    ["Tabs", "Save this window's tabs as a session", true],
    ["Tabs", "Restore a session", true],
    ["Tabs", "Close the duplicates in this window", false],
  ]);
  assert.match(X.commands[0].prompt, /browser_session_save.*named: $/);
  assert.match(X.commands[1].prompt, /browser_session_restore.*named: $/);
  assert.match(X.commands[2].prompt, /browser_tabs[\s\S]*browser_close_tab/);
  assert.doesNotMatch(X.commands[2].prompt, /browser_session_/, "closing duplicates needs no session tool");

  const dom = fakeDom();
  const render = () => X.tabs[0].render(dom.content, dom.ctx);
  await render();
  assert.deepEqual(dom.content.byClass("cmd-empty").map((n) => n.text()), ["No sessions yet."]);
  const card = dom.content.byClass("cmd-item")[0];
  assert.match(card.text(), /^➕ Save this window's tabs 2 tabs in this window \(the panel and browser pages are left out\)/);
  // Save from the panel: the name field (Enter works too), then the list.
  const input = card.find((n) => n.tag === "input");
  input.value = "From the panel";
  card.button("💾 Save this window's tabs").fire("click");
  await settle();
  assert.deepEqual(dom.statuses.at(-1), { text: "✓ Saved 'From the panel' — 2 tabs.", kind: "good" });
  assert.equal(dom.renders(), 1);
  assert.deepEqual(sessions(data).map((s) => [s.name, s.tabs.length]), [["From the panel", 2]]);
  input.value = "";
  input.fire("keydown", { key: "Enter" });
  await settle();
  assert.match(dom.statuses.at(-1).text, /^✓ Saved 'Session /, "an empty name gets a dated default");
  await tools.browser_session_save({ name: "From the chat" });

  await render();
  assert.deepEqual(dom.content.byClass("cmd-group-title").map((n) => n.text()), ["Saved sessions (3)"]);
  let items = dom.content.byClass("cmd-item").slice(1);
  assert.deepEqual(items.map((n) => n.byClass("cmd-name")[0].text()), ["From the chat", "Session " + new Date().toLocaleDateString(), "From the panel"]);
  assert.match(items[0].byClass("cmd-desc")[0].text(), /^2 tabs · saved just now · click for the tabs$/);
  assert.equal(items[0].button("↳ Restore here"), null, "collapsed: no tab list");
  // Expand: the tab titles and the two restore buttons.
  items[0].fire("click");
  assert.equal(dom.renders(), 3);
  await render();
  items = dom.content.byClass("cmd-item").slice(1);
  assert.deepEqual(items[0].byClass("cmd-desc").map((n) => n.text()), ["2 tabs · saved just now", "📌 One — a.example", "• Two — b.example"]);
  items[0].button("↳ Restore here").fire("click");
  await settle();
  assert.deepEqual(dom.statuses.at(-1), { text: "✓ Restored 'From the chat': 2 tabs in window 1.", kind: "good" });
  assert.equal(calls.tabsCreate.length, 2);
  items[0].button("▶ Restore in a new window").fire("click");
  await settle();
  assert.deepEqual(dom.statuses.at(-1), { text: "✓ Restored 'From the chat': 2 tabs in window 2.", kind: "good" });
  assert.equal(windows.get(2).tabs.length, 2);
  items[1].button("▶").fire("click");
  await settle();
  assert.equal(windows.get(3).tabs.length, 2);
  // Delete asks (confirm → true in this harness).
  items[2].button("Delete").fire("click");
  await settle();
  assert.deepEqual(sessions(data).map((s) => s.name), ["From the chat", "Session " + new Date().toLocaleDateString()]);
  assert.deepEqual(dom.statuses.at(-1), { text: "Deleted.", kind: "good" });
});
