// Tab sessions (browser/extras/sessions.js) against fakes of chrome.storage / tabs / windows and of
// the tool registry: which tabs a save keeps, replace-by-name, list, restore into a new or the current
// window (pinned and active state, the fallbacks), delete, adding tabs to a session, the tidy-up of
// duplicate tabs or a site's tabs, the cap, and the 🗂 tab.
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
  const calls = { windowsCreate: [], tabsCreate: [], tabsUpdate: [], tabsRemove: [], messages: [] };
  const all = () => [...windows.values()].flatMap((w) => w.tabs);
  function makeTab(windowId, o) {
    // A title can be given here (chrome.tabs.create takes none) so tidy's report has something to show.
    const t = { id: nextTab++, windowId, url: o.url, title: o.title || "", pinned: !!o.pinned, active: !!o.active };
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
      async remove(ids) {
        for (const id of [].concat(ids)) {
          calls.tabsRemove.push(id);
          const t = all().find((x) => x.id === id);
          if (!t) throw new Error("No tab with id: " + id);
          const w = windows.get(t.windowId);
          w.tabs.splice(w.tabs.indexOf(t), 1);
        }
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
    ["Tabs", "Add this tab to a session", true],
    ["Tabs", "Export my sessions", false],
  ]);
  assert.match(X.commands[0].prompt, /browser_session_save.*named: $/);
  assert.match(X.commands[1].prompt, /browser_session_restore.*named: $/);
  assert.match(X.commands[2].prompt, /browser_session_tidy/);
  assert.doesNotMatch(X.commands[2].prompt, /browser_close_tab/, "closing duplicates is one tool call now");
  assert.match(X.commands[3].prompt, /browser_session_add.*named: $/);
  assert.match(X.commands[4].prompt, /browser_session_export/);

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

test("sessions: browser_session_add puts the current tab, or the whole window, into a saved session without repeats", async () => {
  const { tools, data, chrome, T } = load();
  await assert.rejects(tools.browser_session_add({}), /Give id or name \(see browser_session_list\)\./);
  await tools.browser_session_save({ name: "S" });
  const id = sessions(data)[0].id;
  await assert.rejects(tools.browser_session_add({ name: "nope" }), /^Error: No session named 'nope'\. Saved: 'S'\.$/);
  // The agent's tab (4) is in the session already.
  assert.equal(outText(await tools.browser_session_add({ name: "s" })), "Nothing added to session 'S' (1 skipped, already in it) — still 2 tabs.");
  const three = await chrome.tabs.create({ windowId: 1, url: "https://c.example/three", title: "Three", active: false });
  T.current = three.id;
  assert.equal(
    outText(await tools.browser_session_add({ id })),
    "Added 1 tab to session 'S' — now 3 tabs.\n  1. 📌 One — https://a.example/one\n  2. Two — https://b.example/two?x=1  (active)\n  3. Three — https://c.example/three"
  );
  assert.deepEqual(plain(sessions(data)[0].tabs[2]), { url: "https://c.example/three", title: "Three", pinned: false, active: false }, "an added tab is never the session's active one");
  assert.equal(sessions(data)[0].id, id, "the id survives");
  // A browser page can't be added; `all` takes every website tab of the window, skipping what is there (and repeats in the window).
  const internal = await chrome.tabs.create({ windowId: 1, url: "chrome://settings/", active: false });
  T.current = internal.id;
  await assert.rejects(tools.browser_session_add({ id }), /^Error: The current tab \(chrome:\/\/settings\/\) is a browser page a session can't reopen — switch to the website tab to add, or pass all\.$/);
  await chrome.tabs.create({ windowId: 1, url: "https://d.example/four", title: "Four", active: false });
  await chrome.tabs.create({ windowId: 1, url: "https://d.example/four", title: "Four again", active: false });
  assert.equal(
    outText(await tools.browser_session_add({ id, all: true })),
    "Added 1 tab to session 'S' (3 skipped, already in it) — now 4 tabs.\n  1. 📌 One — https://a.example/one\n  2. Two — https://b.example/two?x=1  (active)\n  3. Three — https://c.example/three\n  4. Four — https://d.example/four"
  );
  assert.equal(outText(await tools.browser_session_add({ id, all: true })), "Nothing added to session 'S' (5 skipped, already in it) — still 4 tabs.");
  assert.match(outText(await tools.browser_session_list({})), /^Sessions \(1\):\n  ses_[a-z0-9]{6}  S  \|  4 tabs  \|  saved just now\n    One; Two; Three; … \+1 more$/);
  // A session that grows moves to the top of the list; a window without website tabs has nothing to add.
  await tools.browser_session_save({ name: "Newer" });
  assert.deepEqual(sessions(data).map((s) => s.name), ["Newer", "S"]);
  const five = await chrome.tabs.create({ windowId: 1, url: "https://e.example/five", title: "Five", active: false });
  T.current = five.id;
  assert.match(outText(await tools.browser_session_add({ name: "S" })), /^Added 1 tab to session 'S' — now 5 tabs\./);
  assert.deepEqual(sessions(data).map((s) => [s.name, s.tabs.length]), [["S", 5], ["Newer", 5]]);
  const w = await chrome.windows.create({ url: ["chrome://settings/"] });
  T.current = w.tabs[0].id;
  await assert.rejects(tools.browser_session_add({ name: "S", all: true }), /No website tabs to add in this window\./);
  // The pure helper: repeats within the batch collapse, the time moves only when something was added.
  const r = S_add(load().S, { id: "x", name: "n", t: 1, tabs: [ONE] }, [ONE, TWO, TWO], 99);
  assert.deepEqual(plain(r), { session: { id: "x", name: "n", t: 99, tabs: [ONE, { ...TWO, active: false }] }, added: [{ ...TWO, active: false }], skipped: 1 });
  assert.equal(S_add(load().S, { id: "x", name: "n", t: 1, tabs: [ONE] }, [ONE], 99).session.t, 1);
});
const S_add = (S, session, tabs, now) => S.addToSession(session, tabs, now);

test("sessions: duplicateTabs picks what tidy closes — one of each address stays, protected tabs never go", () => {
  const { S } = load();
  const tabs = [
    { id: 1, index: 0, url: "https://a.example/x", title: "A", pinned: true, active: false },
    { id: 2, index: 1, url: "https://a.example/x#top", title: "A again", pinned: false, active: false },
    { id: 3, index: 2, url: "https://b.example/y", title: "B", pinned: false, active: false },
    { id: 4, index: 3, url: "https://b.example/y", title: "B again", pinned: false, active: true },
    { id: 5, index: 4, url: "https://c.example/z", title: "C", pinned: false, active: false },
    { id: 6, index: 5, url: "https://c.example/z", title: "C again", pinned: false, active: false },
    { id: 7, index: 6, url: "https://c.example/z?v=2", title: "C other", pinned: false, active: false },
    { id: 8, index: 7, url: OWN + "sidepanel.html", title: "Panel", pinned: false, active: false },
    { id: 9, index: 8, url: OWN + "sidepanel.html", title: "Panel 2", pinned: false, active: false },
    { id: 10, index: 9, url: "", title: "", pinned: false, active: false },
  ];
  const ids = (opts) => S.duplicateTabs(tabs, opts).map((t) => t.id);
  // 2 repeats the pinned 1 (the #fragment is ignored); 3 repeats the active 4 and goes; of 5 and 6 the earliest stays;
  // 7 differs in its query; the panel's pages never go.
  assert.deepEqual(ids({ ownOrigin: OWN }), [2, 3, 6]);
  assert.deepEqual(ids({ ownOrigin: OWN, keep: [3, 6] }), [2, 5], "kept ids (the agent's tab) stay; their earlier twins go instead");
  assert.deepEqual(ids({}), [2, 3, 6, 9], "without ownOrigin the panel's second page is a repeat like any other");
  assert.deepEqual(S.duplicateTabs([tabs[5], tabs[4]], {}).map((t) => t.id), [6], "window order decides which is the earliest, not array order");
  // By host: every tab of that site but the protected ones; www. and case are ignored.
  assert.deepEqual(ids({ host: "www.C.example", ownOrigin: OWN }), [5, 6, 7]);
  assert.deepEqual(ids({ host: "b.example" }), [3]);
  assert.deepEqual(ids({ host: "a.example" }), [2]);
  assert.deepEqual(ids({ host: "nope.example" }), []);
  assert.deepEqual(S.duplicateTabs([], {}), []);
  assert.equal(S.pageKey("https://a.example/x#top"), "https://a.example/x");
});

test("sessions: browser_session_tidy closes the duplicates (dry run first) or a site's tabs; never the active, pinned or panel tabs", async () => {
  const { tools, chrome, windows, calls, T } = load();
  await chrome.tabs.create({ windowId: 1, url: "https://a.example/one#section", title: "One again", active: false }); // repeats the pinned tab 3
  await chrome.tabs.create({ windowId: 1, url: "https://b.example/two?x=1", title: "Two again", active: false }); // repeats the active tab 4
  await chrome.tabs.create({ windowId: 1, url: "https://c.example/three", title: "Three", active: false });
  await chrome.tabs.create({ windowId: 1, url: "https://c.example/three", title: "Three again", active: false });
  await chrome.tabs.create({ windowId: 1, url: OWN + "sidepanel.html", active: false }); // a second page of the extension
  const w1 = () => windows.get(1).tabs;
  assert.equal(w1().length, 10);
  const going = "  • One again — https://a.example/one#section\n  • Two again — https://b.example/two?x=1\n  • Three again — https://c.example/three";
  assert.equal(outText(await tools.browser_session_tidy({ dryRun: true })), "Would close 3 tabs (duplicate tabs; dry run, nothing closed):\n" + going + "\n7 tabs would remain.");
  assert.deepEqual(calls.tabsRemove, []);
  assert.equal(w1().length, 10);
  assert.equal(outText(await tools.browser_session_tidy({})), "Closed 3 tabs (duplicate tabs):\n" + going + "\n7 tabs remain in the window.");
  assert.deepEqual(w1().map((t) => t.title), ["New Tab", "Orbit", "One", "Two", "", "Three", ""]);
  assert.equal(outText(await tools.browser_session_tidy({})), "No duplicate tabs to close in this window (7 tabs; the active tab, pinned tabs and the panel are never closed).");
  // The tab the agent works in stays even when it is not the window's active one: its earlier twin goes instead.
  const copy = await chrome.tabs.create({ windowId: 1, url: "https://c.example/three", title: "Agent's copy", active: false });
  T.current = copy.id;
  assert.equal(outText(await tools.browser_session_tidy({})), "Closed 1 tab (duplicate tabs):\n  • Three — https://c.example/three\n7 tabs remain in the window.");
  assert.ok(w1().some((t) => t.id === copy.id));
  T.current = 4;
  // By host: every tab of that site but the protected ones; a full address or www. is tolerated.
  await chrome.tabs.create({ windowId: 1, url: "https://www.c.example/four", title: "Four", active: false });
  assert.equal(
    outText(await tools.browser_session_tidy({ host: "https://www.c.example/", dryRun: true })),
    "Would close 2 tabs (tabs of www.c.example; dry run, nothing closed):\n  • Agent's copy — https://c.example/three\n  • Four — https://www.c.example/four\n6 tabs would remain."
  );
  assert.equal(outText(await tools.browser_session_tidy({ host: "a.example" })), "No tabs of a.example to close in this window (8 tabs; the active tab, pinned tabs and the panel are never closed).");
  assert.equal(outText(await tools.browser_session_tidy({ host: "b.example" })), "No tabs of b.example to close in this window (8 tabs; the active tab, pinned tabs and the panel are never closed).");
  assert.match(outText(await tools.browser_session_tidy({ host: "c.example" })), /^Closed 2 tabs \(tabs of c\.example\):\n  • Agent's copy — https:\/\/c\.example\/three\n  • Four — https:\/\/www\.c\.example\/four\n6 tabs remain in the window\.$/);
  assert.deepEqual(w1().map((t) => t.url), ["chrome://newtab/", OWN + "sidepanel.html", "https://a.example/one", "https://b.example/two?x=1", "about:blank", OWN + "sidepanel.html"]);
  assert.equal(calls.tabsRemove.length, 6);
  // Without an agent tab the panel's window is tidied.
  T.noTab = true;
  await chrome.tabs.create({ windowId: 1, url: "https://a.example/one", title: "One again", active: false });
  assert.match(outText(await tools.browser_session_tidy({})), /^Closed 1 tab \(duplicate tabs\):\n  • One again — https:\/\/a\.example\/one\n6 tabs remain/);
});

test("sessions: export as JSON or Markdown, import it back (merge by name, replace, link lists, the cap), rename", async () => {
  const { tools, data, S, chrome } = load();
  assert.equal(outText(await tools.browser_session_export({})), "No sessions saved yet — nothing to export. browser_session_save keeps this window's tabs under a name.");
  await tools.browser_session_save({ name: "Research" });
  await chrome.tabs.create({ windowId: 1, url: "https://c.example/three (draft)", title: "Three [x]", active: false });
  await tools.browser_session_save({ name: "Other" });
  const [other, research] = sessions(data);

  // JSON: a versioned envelope with everything a restore needs; one session by id or name, or all.
  const json = outText(await tools.browser_session_export({}));
  const doc = JSON.parse(json);
  assert.equal(doc.format, "agent-sessions/1");
  assert.equal(S.FORMAT, "agent-sessions/1");
  assert.match(doc.exported, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(doc.sessions.map((s) => [s.id, s.name, s.tabs.length]), [[other.id, "Other", 3], [research.id, "Research", 2]]);
  assert.deepEqual(doc.sessions[1].tabs, [ONE, TWO]);
  assert.equal(new Date(doc.sessions[1].saved).getTime(), research.t);
  assert.deepEqual(JSON.parse(outText(await tools.browser_session_export({ name: "research" }))).sessions.map((s) => s.name), ["Research"]);
  assert.deepEqual(JSON.parse(outText(await tools.browser_session_export({ id: other.id, format: "json" }))).sessions.map((s) => s.name), ["Other"]);
  await assert.rejects(tools.browser_session_export({ name: "zzz" }), /No session named 'zzz'/);
  // Markdown: a heading per session, a link per tab, pinned and active marked, link text and addresses escaped.
  const md = outText(await tools.browser_session_export({ id: other.id, format: "markdown" }));
  assert.equal(md.replace(/\d{4}-\d{2}-\d{2}/g, "DATE"), [
    "# Tab sessions (1) — exported DATE", "",
    "## Other", "", "3 tabs · saved DATE", "",
    "- 📌 [One](https://a.example/one)",
    "- [Two](https://b.example/two?x=1) (active)",
    "- [Three \\[x\\]](https://c.example/three%20%28draft%29)",
    "",
  ].join("\n"));
  assert.match(outText(await tools.browser_session_export({ format: "markdown" })), /^# Tab sessions \(2\) — exported \d{4}-\d{2}-\d{2}\n\n## Other\n[\s\S]*\n## Research\n/);

  // Import: what the text must look like.
  await assert.rejects(tools.browser_session_import({}), /text is required/);
  await assert.rejects(tools.browser_session_import({ text: "{not json" }), /looks like JSON but does not parse/);
  await assert.rejects(tools.browser_session_import({ text: '{"sessions": []}' }), /Not a sessions export: expected \{ "format": "agent-sessions\/1", "sessions": \[\.\.\.\] \}/);
  await assert.rejects(tools.browser_session_import({ text: "[1, 2]" }), /Not a sessions export/);
  await assert.rejects(tools.browser_session_import({ text: "Just prose, no links.\nchrome://settings/" }), /No links in the text/);
  await assert.rejects(tools.browser_session_import({ text: "https://x.example/a" }), /name is required for a list of links/);
  assert.equal(sessions(data).length, 2, "a refused import changes nothing");
  // The JSON round trip, merged by name: what exists is skipped unless replace is set, then replaced in place.
  assert.equal(outText(await tools.browser_session_import({ text: json })), "Imported 0 sessions of 2: skipped 'Other' (exists — pass replace to overwrite it), 'Research' (exists — pass replace to overwrite it).");
  await chrome.tabs.create({ windowId: 1, url: "https://d.example/four", title: "Four", active: false });
  await tools.browser_session_save({ name: "Other" });
  assert.equal(sessions(data)[0].tabs.length, 4);
  assert.match(outText(await tools.browser_session_import({ text: json, replace: true })), /^Imported 2 sessions of 2: replaced 'Other' \(3 tabs\), 'Research' \(2 tabs\)\.\nSessions \(2\):\n/);
  assert.deepEqual(sessions(data).map((s) => [s.id, s.name, s.tabs.length]), [[other.id, "Other", 3], [research.id, "Research", 2]], "same ids, the export's order");
  await tools.browser_session_delete({ name: "Other" });
  await tools.browser_session_delete({ name: "Research" });
  assert.match(outText(await tools.browser_session_import({ text: json })), /^Imported 2 sessions of 2: added 'Other' \(3 tabs\), 'Research' \(2 tabs\)\.\nSessions \(2\):\n  ses_[a-z0-9]{6}  Other  \|  3 tabs  \|  saved just now\n    One; Two; Three \[x\]\n  ses_[a-z0-9]{6}  Research  \|  2 tabs/);
  assert.deepEqual(sessions(data).map((s) => s.name), ["Other", "Research"]);
  assert.ok(sessions(data).every((s) => s.id !== other.id && s.id !== research.id), "new sessions get new ids");
  assert.deepEqual(plain(sessions(data)[1].tabs), [ONE, TWO]);
  assert.match(outText(await tools.browser_session_restore({ name: "Other" })), /^Restored session 'Other': 3 tabs in new window/);

  // A Markdown list: headings name the sessions, 📌 marks a pinned tab, browser pages, repeats and link-less headings are left out.
  const mdIn = "# My links\n\n## Reading\n- [Doc](https://d.example/doc)\n- 📌 https://e.example/pin\n- [Doc again](https://d.example/doc)\nchrome://settings/\n\n## Empty\n\nno links here\n";
  assert.deepEqual(plain(S.parseSessionImport(mdIn)), [{ name: "Reading", tabs: [
    { url: "https://d.example/doc", title: "Doc", pinned: false, active: false },
    { url: "https://e.example/pin", title: "", pinned: true, active: false },
  ] }]);
  assert.match(outText(await tools.browser_session_import({ text: mdIn })), /^Imported 1 session of 1: added 'Reading' \(2 tabs\)\.\nSessions \(1\):\n  ses_[a-z0-9]{6}  Reading  \|  2 tabs  \|  saved just now\n    Doc; e\.example$/);
  // A plain list of addresses needs a name; "(active)" marks the active tab, once.
  assert.deepEqual(plain(S.parseSessionImport("https://f.example/1\n  https://f.example/1\nhttps://g.example/2 (active)\nhttps://h.example/3 (active)", " Plain  list ")), [{ name: "Plain list", tabs: [
    { url: "https://f.example/1", title: "", pinned: false, active: false },
    { url: "https://g.example/2", title: "", pinned: false, active: true },
    { url: "https://h.example/3", title: "", pinned: false, active: false },
  ] }]);
  // The JSON envelope, checked field by field: non-web and repeated addresses go, a nameless session takes the given name, bad shapes are refused.
  const env = (list) => JSON.stringify({ format: "agent-sessions/1", sessions: list });
  assert.deepEqual(plain(S.parseSessionImport(env([
    { name: "  J  ", tabs: [{ url: "https://j.example/a", title: "A", pinned: 1, active: true }, { url: "chrome://x" }, { url: 5 }, "https://j.example/b", { url: "https://j.example/a" }, { url: "https://j.example/c", active: true }] },
    { name: "", tabs: [{ url: "https://k.example/" }] },
    { name: "None", tabs: "nope" },
  ]), "Fallback")), [
    { name: "J", tabs: [{ url: "https://j.example/a", title: "A", pinned: true, active: true }, { url: "https://j.example/b", title: "", pinned: false, active: false }, { url: "https://j.example/c", title: "", pinned: false, active: false }] },
    { name: "Fallback", tabs: [{ url: "https://k.example/", title: "", pinned: false, active: false }] },
    { name: "None", tabs: [] },
  ]);
  await assert.rejects(tools.browser_session_import({ text: env([{ name: "", tabs: [] }]) }), /Session 1 of the export has no name\./);
  await assert.rejects(tools.browser_session_import({ text: env([5]) }), /sessions\[0\] is not a session object\./);
  assert.equal(outText(await tools.browser_session_import({ text: env([{ name: "None", tabs: [{ url: "about:blank" }] }]) })), "Imported 0 sessions of 1: skipped 'None' (no web addresses).");
  // The cap: the oldest sessions make room, and the report says so.
  let many = [];
  for (let i = 0; i < 48; i++) many = S.upsertSession(many, S.makeSession("s" + i, [ONE], 1000 + i));
  await S.save(many);
  assert.match(
    outText(await tools.browser_session_import({ text: env([1, 2, 3, 4].map((i) => ({ name: "n" + i, tabs: ["https://n.example/" + i] }))) })),
    /^Imported 4 sessions of 4: added 'n1' \(1 tab\), 'n2' \(1 tab\), 'n3' \(1 tab\), 'n4' \(1 tab\)\. The list keeps 50 sessions, so the 2 oldest were dropped\.\nSessions \(4\):\n/
  );
  assert.equal(sessions(data).length, 50);
  assert.deepEqual(sessions(data).slice(0, 4).map((s) => s.name), ["n1", "n2", "n3", "n4"]);
  assert.equal(sessions(data).at(-1).name, "s2");

  // Rename: by id or name; another session's name is refused, its own in another case is fine; in place.
  await S.save([]);
  await tools.browser_session_save({ name: "Research" });
  await tools.browser_session_save({ name: "Other" });
  const [o2, r2] = sessions(data);
  await assert.rejects(tools.browser_session_rename({ newName: "x" }), /Give id or name \(see browser_session_list\)\./);
  await assert.rejects(tools.browser_session_rename({ name: "Other", newName: "  " }), /newName is required\./);
  await assert.rejects(tools.browser_session_rename({ name: "nope", newName: "x" }), /No session named 'nope'/);
  await assert.rejects(tools.browser_session_rename({ name: "Other", newName: "research" }), new RegExp(`^Error: A session named 'Research' exists already \\(id ${r2.id}\\) — pick another name, or delete it first\\.$`));
  assert.equal(outText(await tools.browser_session_rename({ name: "other", newName: "OTHER" })), `Renamed session 'Other' → 'OTHER' (id ${o2.id}, 4 tabs).`);
  assert.equal(outText(await tools.browser_session_rename({ id: o2.id, newName: "OTHER" })), `Session 'OTHER' (id ${o2.id}) has that name already — nothing changed.`);
  assert.equal(outText(await tools.browser_session_rename({ id: o2.id, newName: "  Work   stuff " })), `Renamed session 'OTHER' → 'Work stuff' (id ${o2.id}, 4 tabs).`);
  assert.deepEqual(sessions(data).map((s) => [s.id, s.name, s.t]), [[o2.id, "Work stuff", o2.t], [r2.id, "Research", r2.t]], "renamed in place: id, position and time kept");
  assert.match(outText(await tools.browser_session_restore({ name: "work stuff" })), /^Restored session 'Work stuff': 4 tabs/);
  // The pure helper leaves the store alone.
  const r = S.renameSession(sessions(data), { name: "research" }, "R2");
  assert.deepEqual([r.old, r.session.name, r.changed, r.list[1].name, sessions(data)[1].name], ["Research", "R2", true, "R2", "Research"]);
  assert.equal(S.renameSession(sessions(data), { id: r2.id }, "Research").changed, false);
  assert.throws(() => S.renameSession(sessions(data), { id: r2.id }, "work STUFF"), /exists already/);
});
