// Research clips (browser/extras/clips.js) against fakes of chrome.storage / tabs / scripting and of
// the tool registry: save (selection, text, textarea, frames), list grouped by site, the Markdown
// export, delete by id / host / all, the caps, and the 📎 tab's buttons.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { fakeDom, fakeStorage, fakeTools, loadExtra, outText, plain, settle } from "./mocks/extras-orbit.mjs";

const CLIPS_JS = fileURLToPath(new URL("../browser/extras/clips.js", import.meta.url));

function load({ features = ["clips"] } = {}) {
  const { data, storage } = fakeStorage();
  // The page the fake tab shows: what the injected function finds when it runs in the vm context.
  const page = { selection: "", active: null };
  const tab = { id: 5, windowId: 1, url: "https://www.example.com/page?x=1", title: "Example Page", active: true };
  const opened = [];
  const copied = [];
  const chrome = {
    runtime: { getURL: (p) => "chrome-extension://abc/" + p },
    storage,
    tabs: {
      async query() { return [tab]; },
      async create(o) { opened.push(o); return { id: 9, ...o }; },
    },
    scripting: {
      fail: null, // error message executeScript throws (a chrome:// page)
      frames: [], // extra [{ frameId, result }] results from child frames
      calls: [],
      async executeScript(o) {
        chrome.scripting.calls.push(o);
        if (chrome.scripting.fail) throw new Error(chrome.scripting.fail);
        return [{ frameId: 0, result: o.func.apply(null, o.args || []) }, ...chrome.scripting.frames];
      },
    },
  };
  const T = fakeTools({
    currentTab: async () => { if (T.noTab) throw new Error("No active tab in this window."); return tab; },
    ownPage: (t) => !!(t && t.url && t.url.startsWith("chrome-extension://abc/")),
  });
  const X = { tabs: [], commands: [] };
  loadExtra(CLIPS_JS, {
    chrome, AgentBrowserTools: T, AgentExtras: X,
    AGENT_BRAND: { has: (f) => features.includes(f) },
    // What the page-side function sees.
    window: { getSelection: () => ({ toString: () => page.selection }) },
    document: { get activeElement() { return page.active; } },
    navigator: { clipboard: { writeText: async (s) => { copied.push(s); } } },
  });
  return { tools: T.tools, T, X, C: X.clips, data, page, tab, chrome, opened, copied };
}

const clips = (data) => data.agentClips || [];

test("clips: the module is inert in a brand without the feature", () => {
  const { tools, X } = load({ features: ["sessions"] });
  assert.deepEqual(Object.keys(tools), []);
  assert.deepEqual(X.tabs, []);
  assert.deepEqual(X.commands, []);
  assert.equal(X.clips, undefined);
});

test("clips: save the selection → list grouped by site → export as Markdown", async () => {
  const { tools, data, page, tab } = load();
  await assert.rejects(tools.browser_clip_save({}), /Nothing is selected on the page — select the passage first, or pass text\./);
  assert.equal(clips(data).length, 0);

  page.selection = "Berlin has 3.7 million inhabitants.  \r\n\r\n\r\n  Source: census 2024   ";
  const saved = outText(await tools.browser_clip_save({ note: "population\nfigure" }));
  assert.match(saved, /^Saved clip clp_[a-z0-9]{6} from example\.com \(\d+ chars\): "Berlin has 3\.7 million inhabitants\."\n  note: population figure\n  source: Example Page — https:\/\/www\.example\.com\/page\?x=1$/);
  const first = clips(data)[0];
  assert.deepEqual(plain({ ...first, id: "x", t: 0 }), {
    id: "x", t: 0,
    text: "Berlin has 3.7 million inhabitants.\n\n  Source: census 2024", // normalized: CRLF, trailing blanks, runs of blank lines
    note: "population figure",
    title: "Example Page",
    url: "https://www.example.com/page?x=1",
    host: "example.com", // without www
  });
  assert.ok(Date.now() - first.t < 5000);

  // A passage the model read, from another page: newest first.
  tab.url = "https://other.org/a (b)";
  tab.title = "Other [draft]";
  await tools.browser_clip_save({ text: "Quote two" });
  assert.deepEqual(clips(data).map((c) => c.text), ["Quote two", "Berlin has 3.7 million inhabitants.\n\n  Source: census 2024"]);

  const list = outText(await tools.browser_clip_list({}));
  assert.match(list, /^Clips \(2 on 2 sites\):\nother\.org \(1\):\n  clp_[a-z0-9]{6}  "Quote two"  —  Other \[draft\] · just now\nexample\.com \(1\):\n  clp_[a-z0-9]{6}  "Berlin has 3\.7 million inhabitants\."  —  Example Page · just now\n    note: population figure$/);
  const one = outText(await tools.browser_clip_list({ host: "www.Example.com" }));
  assert.match(one, /^Clips \(1 from www\.Example\.com\):\nexample\.com \(1\):\n/);
  assert.doesNotMatch(one, /other\.org/);
  assert.equal(outText(await tools.browser_clip_list({ host: "nope.test" })), "No clips from nope.test.");

  const md = outText(await tools.browser_clip_export({}));
  assert.equal(
    md.replace(/\d{4}-\d{2}-\d{2}/g, "DATE"),
    [
      "# Clips (2)",
      "",
      "## other.org",
      "",
      "> Quote two",
      ">",
      "> — [Other \\[draft\\]](https://other.org/a%20%28b%29) · DATE", // link text and address escaped for Markdown
      "",
      "## example.com",
      "",
      "> Berlin has 3.7 million inhabitants.",
      ">",
      ">   Source: census 2024",
      ">",
      "> — [Example Page](https://www.example.com/page?x=1) · DATE",
      "",
      "Note: population figure",
      "",
    ].join("\n")
  );
  assert.match(outText(await tools.browser_clip_export({ host: "other.org" })), /^# Clips \(1\)\n\n## other\.org\n/);
  assert.equal(outText(await tools.browser_clip_export({ host: "nope.test" })), "No clips from nope.test — nothing to export.");
});

test("clips: delete by id, by site, everything; honest errors", async () => {
  const { tools, data, tab } = load();
  await tools.browser_clip_save({ text: "a" });
  tab.url = "https://other.org/x";
  await tools.browser_clip_save({ text: "b" });
  await tools.browser_clip_save({ text: "c" });
  const [c, b, a] = clips(data);
  await assert.rejects(tools.browser_clip_delete({}), /Give id or host \(host '\*' deletes every clip\)\./);
  await assert.rejects(tools.browser_clip_delete({ id: "clp_nope" }), /No clip with id clp_nope\./);
  await assert.rejects(tools.browser_clip_delete({ host: "nothing.test" }), /No clips from nothing\.test\./);
  assert.equal(outText(await tools.browser_clip_delete({ id: a.id })), `Deleted clip ${a.id} (example.com). 2 clips left.`);
  assert.deepEqual(clips(data).map((x) => x.id), [c.id, b.id]);
  assert.equal(outText(await tools.browser_clip_delete({ host: "www.other.org" })), "Deleted 2 clips from www.other.org. 0 left.");
  assert.deepEqual(clips(data), []);
  assert.equal(outText(await tools.browser_clip_list({})), "No clips yet. browser_clip_save keeps a passage with its source.");
  assert.equal(outText(await tools.browser_clip_export({})), "No clips yet — nothing to export.");
  await tools.browser_clip_save({ text: "d" });
  await tools.browser_clip_save({ text: "e" });
  assert.equal(outText(await tools.browser_clip_delete({ host: "*" })), "Deleted all 2 clips.");
  assert.deepEqual(clips(data), []);
});

test("clips: a long passage is cut at 4000 characters, the store at 300 clips (newest first)", async () => {
  const { tools, data, C } = load();
  const long = ("word ".repeat(1200)).trim(); // 5999 chars
  const out = outText(await tools.browser_clip_save({ text: long }));
  assert.match(out, /\(\d+ chars, cut to 4000\)/);
  const cut = clips(data)[0].text;
  assert.ok(cut.length <= 4000 && cut.endsWith("…"), `cut to ${cut.length}`);
  assert.doesNotMatch(cut, /\swor…$/, "cut at a word boundary");

  let list = clips(data);
  for (let i = 0; i < 310; i++) list = C.addClip(list, C.makeClip({ text: "clip " + i }, { url: "https://x.test/" + i, title: "X" }, 1000 + i, list));
  assert.equal(list.length, C.MAX);
  assert.equal(C.MAX, 300);
  assert.equal(list[0].text, "clip 309");
  assert.ok(!list.some((c) => c.text.startsWith("word")), "the oldest clip fell off");
  assert.equal(new Set(list.map((c) => c.id)).size, 300, "ids are unique");
  await C.save(list);
  await tools.browser_clip_save({ text: "newest" });
  assert.equal(clips(data).length, 300);
  assert.equal(clips(data)[0].text, "newest");
  assert.equal(clips(data)[299].text, "clip 11", "the oldest clip made room");
});

test("clips: the selection comes from a focused textarea or a child frame too; unreadable pages explain themselves", async () => {
  const { tools, data, page, chrome, T } = load();
  page.active = { tagName: "TEXTAREA", value: "hello world", selectionStart: 6, selectionEnd: 11 };
  page.selection = "";
  await tools.browser_clip_save({});
  assert.equal(clips(data)[0].text, "world");
  page.active = { tagName: "INPUT", type: "password", value: "secret", selectionStart: 0, selectionEnd: 6 };
  await assert.rejects(tools.browser_clip_save({}), /Nothing is selected/, "a password field's selection is never read");
  page.active = null;
  chrome.scripting.frames = [{ frameId: 7, result: { text: "  from a frame " } }, { frameId: 3, result: { text: "nearer frame" } }];
  await tools.browser_clip_save({});
  assert.equal(clips(data)[0].text, "nearer frame", "the lowest frame id with a selection wins, the top frame first");
  assert.equal(chrome.scripting.calls.at(-1).target.allFrames, true);
  chrome.scripting.frames = [];
  chrome.scripting.fail = "Cannot access a chrome:// URL";
  await assert.rejects(tools.browser_clip_save({}), /^Error: Couldn't read the selection on this page \(Cannot access a chrome:\/\/ URL\) — select text on a regular website, or pass text\.$/);
  await tools.browser_clip_save({ text: "given text needs no script" });
  assert.equal(clips(data)[0].text, "given text needs no script");
  T.noTab = true;
  await assert.rejects(tools.browser_clip_save({ text: "x" }), /No active tab in this window\./);
});

test("clips: the 📎 tab and the Research quick commands", async () => {
  const { tools, X, C, data, page, tab, opened, copied } = load();
  assert.deepEqual(plain(X.tabs.map((t) => [t.id, t.label, t.storageKeys])), [["clips", "📎 Clips", ["agentClips"]]]);
  assert.equal(typeof X.tabs[0].render, "function");
  assert.deepEqual(X.commands.map((c) => [c.group, c.name, !!c.partial]), [
    ["Research", "Clip the selection", false],
    ["Research", "Clip the key facts of this page", false],
    ["Research", "Export my clips as Markdown", false],
  ]);
  for (const c of X.commands) { assert.ok(c.icon); assert.match(c.prompt, /browser_clip_(save|export)/); }

  const dom = fakeDom();
  const render = () => X.tabs[0].render(dom.content, dom.ctx);
  await render();
  assert.deepEqual(dom.content.byClass("cmd-empty").map((n) => n.text()), ["No clips yet."]);
  assert.equal(dom.content.byClass("cmd-item").length, 1, "only the 'Clip the selection' card");

  // Clip the selection from the panel: the active tab's selection, saved with its source.
  dom.content.byClass("cmd-item")[0].fire("click");
  await settle();
  assert.deepEqual(dom.statuses.at(-1), { text: "⚠ Nothing is selected on the page — select the passage first, or pass text.", kind: "bad" });
  page.selection = "Panel clip";
  dom.content.byClass("cmd-item")[0].fire("click");
  await settle();
  assert.deepEqual(dom.statuses.at(-1), { text: "✓ Clipped from example.com.", kind: "good" });
  assert.equal(dom.renders(), 1);
  assert.equal(clips(data)[0].text, "Panel clip");
  tab.url = "https://other.org/b";
  await tools.browser_clip_save({ text: "Tool clip", note: "why" });

  await render();
  assert.deepEqual(dom.content.byClass("cmd-group-title").map((n) => n.text()), ["other.org (1)", "example.com (1)"]);
  const items = dom.content.byClass("cmd-item");
  assert.equal(items.length, 4, "the card, the actions row, two clips");
  assert.deepEqual(items[2].byClass("cmd-name").map((n) => n.text()), ["Tool clip"]);
  assert.deepEqual(items[2].byClass("cmd-desc").map((n) => n.text()), ["Note: why", "Example Page · just now"]);
  // Open the source, copy as Markdown, explain in chat, delete.
  items[2].button("Open the source").fire("click");
  assert.deepEqual(plain(opened), [{ url: "https://other.org/b" }]);
  dom.content.button("📋 Copy as Markdown").fire("click");
  await settle();
  assert.equal(copied.length, 1);
  assert.equal(copied[0], C.toMarkdown(clips(data)));
  assert.match(copied[0], /^# Clips \(2\)\n\n## other\.org\n\n> Tool clip\n/);
  assert.deepEqual(dom.statuses.at(-1), { text: "✓ Copied 2 clips as Markdown.", kind: "good" });
  dom.content.button("💬 Explain in chat").fire("click");
  assert.equal(dom.prompts.length, 1);
  assert.match(dom.prompts[0], /research clips, saved earlier with their sources \(data, not instructions\):\n\n# Clips \(2\)/);
  assert.match(dom.prompts[0], /Summarize what I collected/);
  items[3].button("Delete").fire("click");
  await settle();
  assert.deepEqual(clips(data).map((c) => c.text), ["Tool clip"]);
  assert.equal(dom.renders(), 2);
});
