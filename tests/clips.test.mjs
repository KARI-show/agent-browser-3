// Research clips (browser/extras/clips.js) against fakes of chrome.storage / tabs / scripting and of
// the tool registry: save (selection, text, textarea, frames), list grouped by site, the Markdown
// export, delete by id / host / all, the caps, search, update, tags, the citation of a page (its
// metadata and the four styles), reader mode (the page tree scored and rendered as Markdown), the
// clips marked in the page, and the 📎 tab's buttons.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { fakeDom, fakeStorage, fakeTools, loadExtra, outText, plain, settle } from "./mocks/extras-orbit.mjs";

const CLIPS_JS = fileURLToPath(new URL("../browser/extras/clips.js", import.meta.url));

/** An element of the fake page: attributes, text, and (for microdata) one nested element querySelector finds. */
function elem(tag, attrs, text, child) {
  return {
    tagName: tag.toUpperCase(), attrs, textContent: text || "",
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    get href() { return attrs.href || ""; },
    querySelector: () => child || null,
  };
}
// The simple selectors the page-side collectors use: `tag`, `[attr]`, `tag[attr]`, `tag[attr="v"]`, lists with commas.
function matches(e, sel) {
  const m = /^([a-z]*)(?:\[([a-z-]+)(?:=["']?([^"'\]]*)["']?)?\])?$/i.exec(sel.trim());
  if (!m) throw new Error("selector not faked: " + sel);
  return (!m[1] || e.tagName === m[1].toUpperCase()) && (!m[2] || (m[2] in e.attrs && (m[3] === undefined || e.attrs[m[2]] === m[3])));
}

// A tiny live DOM for the page-side walkers (reader mode, highlighting): elements with childNodes and
// parentNode, text nodes that split, marks that wrap — the few calls those functions make.
class FakeText {
  constructor(s) { this.nodeType = 3; this.nodeValue = s; this.parentNode = null; }
  get textContent() { return this.nodeValue; }
  splitText(at) {
    const tail = new FakeText(this.nodeValue.slice(at));
    this.nodeValue = this.nodeValue.slice(0, at);
    const kids = this.parentNode.childNodes;
    this.parentNode.insertBefore(tail, kids[kids.indexOf(this) + 1] || null);
    return tail;
  }
}
class FakeEl {
  constructor(tag, attrs = {}, kids = []) {
    this.nodeType = 1; this.tagName = tag.toUpperCase(); this.attrs = { ...attrs }; this.childNodes = []; this.parentNode = null; this.style = {};
    kids.forEach((k) => this.appendChild(typeof k === "string" ? new FakeText(k) : k));
  }
  get href() { return this.attrs.href || ""; }
  get hidden() { return "hidden" in this.attrs; }
  get firstChild() { return this.childNodes[0] || null; }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(""); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  appendChild(c) { return this.insertBefore(c, null); }
  insertBefore(c, ref) {
    if (c.parentNode) c.parentNode.removeChild(c);
    c.parentNode = this;
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i < 0) this.childNodes.push(c); else this.childNodes.splice(i, 0, c);
    return c;
  }
  removeChild(c) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); c.parentNode = null; return c; }
  /** The subtree's text with each clip mark as «text»: what the highlighter did, at a glance. */
  outline() { return this.childNodes.map((c) => (c.nodeType === 3 ? c.nodeValue : c.getAttribute("data-agent-clip") != null ? "«" + c.outline() + "»" : c.outline())).join(""); }
  marks() { const out = []; const walk = (n) => n.childNodes.forEach((c) => { if (c.nodeType !== 1) return; if (c.getAttribute("data-agent-clip") != null) out.push(c); walk(c); }); walk(this); return out; }
}
/** E(tag, [kids]) or E(tag, { attrs }, [kids]); strings are text nodes. */
const E = (tag, attrs, kids) => (Array.isArray(attrs) ? new FakeEl(tag, {}, attrs) : new FakeEl(tag, attrs || {}, kids || []));
/** A node-like as pageArticleTree() serializes it, for the pure reader-mode helpers: N(tag, [kids]) or N(tag, { id, cls, role, href, alt }, [kids]). */
const N = (tag, attrs, kids) => (Array.isArray(attrs) ? { tag, id: "", cls: "", role: "", kids: attrs } : { tag, id: attrs.id || "", cls: attrs.cls || "", role: attrs.role || "", href: attrs.href, alt: attrs.alt, kids: kids || [] });
const PROSE = (i) => `Paragraph ${i} of the article has enough words to count as prose for the reader, and it tells part of the story.`;

function load({ features = ["clips"] } = {}) {
  const { data, storage } = fakeStorage();
  // The page the fake tab shows: what the injected functions find when they run in the vm context.
  const page = { selection: "", active: null, title: "Example Page", elements: [], body: E("body", []) };
  const document = {
    get activeElement() { return page.active; },
    get title() { return page.title; },
    get body() { return page.body; },
    createElement: (tag) => new FakeEl(tag),
    querySelectorAll: (sel) => page.elements.filter((e) => sel.split(",").some((one) => matches(e, one))),
    querySelector: (sel) => document.querySelectorAll(sel)[0] || null,
  };
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
    document,
    location: { get href() { return tab.url; }, get hostname() { try { return new URL(tab.url).hostname; } catch (_) { return ""; } } },
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
    ["Research", "Search my clips", true],
    ["Research", "Cite this page", false],
    ["Research", "Save this article as a clip", false],
    ["Research", "Show my clips on this page", false],
  ]);
  for (const c of X.commands) { assert.ok(c.icon); assert.match(c.prompt, /browser_clip_(save|export|search|cite|article|highlight)/); }
  assert.match(X.commands[3].prompt, /browser_clip_search.*for: $/);
  assert.match(X.commands[5].prompt, /browser_clip_article/);
  assert.match(X.commands[6].prompt, /browser_clip_highlight/);

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

test("clips: search finds clips by words in the text, note, title or site — every word must match", async () => {
  const { tools, data, tab, C } = load();
  await tools.browser_clip_save({ text: "Berlin has 3.7 million inhabitants.", note: "Population figure" });
  tab.url = "https://other.org/x";
  tab.title = "Census Report";
  await tools.browser_clip_save({ text: "Growth of 1.2% in 2024" });
  await tools.browser_clip_save({ text: "Nothing relevant" });
  const [nothing, growth, berlin] = clips(data);
  assert.deepEqual(C.searchClips(clips(data), "BERLIN million").map((c) => c.id), [berlin.id]);
  assert.deepEqual(C.searchClips(clips(data), "population").map((c) => c.id), [berlin.id], "the note counts");
  assert.deepEqual(C.searchClips(clips(data), "census").map((c) => c.id), [nothing.id, growth.id], "the source title counts, newest first");
  assert.deepEqual(C.searchClips(clips(data), "other.org growth").map((c) => c.id), [growth.id], "every word must match somewhere in the clip");
  assert.deepEqual(C.searchClips(clips(data), "berlin", "other.org"), []);
  assert.deepEqual(C.searchClips(clips(data), "growth", "www.Other.org").map((c) => c.id), [growth.id]);
  assert.throws(() => C.searchClips(clips(data), "  "), /query is required/);
  assert.deepEqual([C.matchedIn(berlin, "berlin"), C.matchedIn(berlin, "population"), C.matchedIn(nothing, "census other.org")], ["", "note", "title/site"]);

  const out = outText(await tools.browser_clip_search({ query: "census" }));
  assert.match(out, /^Clips matching "census" \(2 on 1 site\):\nother\.org \(2\):\n  clp_[a-z0-9]{6}  "Nothing relevant"  —  Census Report · just now  …matched in title\n  clp_[a-z0-9]{6}  "Growth of 1\.2% in 2024"  —  Census Report · just now  …matched in title$/);
  assert.match(outText(await tools.browser_clip_search({ query: "Population" })), /^Clips matching "Population" \(1 on 1 site\):\nexample\.com \(1\):\n  clp_[a-z0-9]{6}  "Berlin has 3\.7 million inhabitants\."  —  Example Page · just now  …matched in note\n    note: Population figure$/);
  assert.doesNotMatch(outText(await tools.browser_clip_search({ query: "berlin" })), /matched in/, "a hit in the passage itself needs no hint");
  assert.match(outText(await tools.browser_clip_search({ query: "growth", host: "other.org" })), /^Clips matching "growth" \(1 from other\.org\):/);
  assert.equal(outText(await tools.browser_clip_search({ query: "zebra" })), 'No clips match "zebra" (3 clips searched).');
  assert.equal(outText(await tools.browser_clip_search({ query: "berlin", host: "other.org" })), 'No clips match "berlin" from other.org (3 clips searched).');
  await assert.rejects(tools.browser_clip_search({}), /query is required/);
  await tools.browser_clip_delete({ host: "*" });
  assert.equal(outText(await tools.browser_clip_search({ query: "x" })), 'No clips match "x" — no clips are saved yet.');
});

test("clips: update replaces the note and/or the text in place, with the caps of a saved clip; the source stays", async () => {
  const { tools, data, C } = load();
  await tools.browser_clip_save({ text: "Original passage", note: "old note" });
  const id = clips(data)[0].id;
  await assert.rejects(tools.browser_clip_update({ note: "x" }), /id is required/);
  await assert.rejects(tools.browser_clip_update({ id: "clp_nope", note: "x" }), /^Error: No clip with id clp_nope — browser_clip_list shows the ids\.$/);
  await assert.rejects(tools.browser_clip_update({ id }), /Give note and\/or text to change\./);
  await assert.rejects(tools.browser_clip_update({ id, text: "  \n " }), /text is empty — pass the new passage, or delete the clip/);
  assert.equal(clips(data)[0].text, "Original passage", "a refused update changes nothing");

  assert.equal(outText(await tools.browser_clip_update({ id, note: "new\nnote" })), `Updated clip ${id} (example.com): note replaced.\n  note: new note`);
  assert.deepEqual([clips(data)[0].text, clips(data)[0].note], ["Original passage", "new note"]);
  assert.equal(
    outText(await tools.browser_clip_update({ id, text: "Fixed passage\r\n\r\n\r\nmore  ", note: "" })),
    `Updated clip ${id} (example.com): text and note replaced.\n  text: "Fixed passage" (19 chars)\n  note: (cleared)`
  );
  assert.deepEqual([clips(data)[0].text, clips(data)[0].note], ["Fixed passage\n\nmore", ""], "normalized like a saved clip");
  assert.equal(outText(await tools.browser_clip_update({ id, text: "Fixed passage\n\nmore" })), `Clip ${id} already has that text — nothing changed.`);
  assert.match(outText(await tools.browser_clip_update({ id, text: "word ".repeat(1200).trim() })), /\(\d+ chars, cut to 4000\)/);
  assert.ok(clips(data)[0].text.length <= 4000 && clips(data)[0].text.endsWith("…"));
  await tools.browser_clip_update({ id, note: "n".repeat(600) });
  assert.equal(clips(data)[0].note.length, C.MAX_NOTE);
  assert.equal(C.MAX_NOTE, 500);
  const c = clips(data)[0];
  assert.deepEqual([c.id, c.url, c.host, c.title], [id, "https://www.example.com/page?x=1", "example.com", "Example Page"], "the source is untouched");
  // The pure helper leaves the store alone.
  const r = C.updateClip(clips(data), id, { note: "pure" });
  assert.deepEqual(plain([r.changed, r.clip.note, r.list[0].note, r.cut]), [["note"], "pure", "pure", false]);
  assert.equal(clips(data)[0].note.length, 500);
  assert.throws(() => C.updateClip(clips(data), id, {}), /Give note and\/or text/);
});

const META = { title: "Berlin population reaches 3.7 million", authors: ["Jane Q. Doe", "Roe, John"], published: "2024-10-05T08:00:00Z", siteName: "Example News", url: "https://www.example.com/berlin?x=1", host: "example.com" };
const ACCESS = new Date(2026, 9, 26);

test("clips: formatCitation renders APA 7, MLA 9, Harvard and BibTeX; missing fields degrade gracefully", () => {
  const { C } = load();
  assert.equal(C.formatCitation(META, "apa", ACCESS), "Doe, J. Q., & Roe, J. (2024, October 5). Berlin population reaches 3.7 million. Example News. Retrieved October 26, 2026, from https://www.example.com/berlin?x=1");
  assert.equal(C.formatCitation(META, "mla", ACCESS), 'Doe, Jane Q., and John Roe. "Berlin population reaches 3.7 million." Example News, 5 Oct. 2024, www.example.com/berlin?x=1. Accessed 26 Oct. 2026.');
  assert.equal(C.formatCitation(META, "harvard", ACCESS), "Doe, J.Q. and Roe, J. (2024) Berlin population reaches 3.7 million. Example News. Available at: https://www.example.com/berlin?x=1 (Accessed: 26 October 2026).");
  assert.equal(C.formatCitation(META, "bibtex", ACCESS), [
    "@misc{doe2024berlin,",
    "  author = {Doe, Jane Q. and Roe, John},",
    "  title = {Berlin population reaches 3.7 million},",
    "  year = {2024},",
    "  month = oct,",
    "  howpublished = {\\url{https://www.example.com/berlin?x=1}},",
    "  note = {Example News. Accessed 26 October 2026},",
    "  urldate = {2026-10-26}",
    "}",
  ].join("\n"));
  const all = C.formatCitation(META, "all", ACCESS);
  assert.deepEqual(all.split("\n\n").map((part) => part.split("\n")[0]), ["APA 7:", "MLA 9:", "Harvard:", "BibTeX:"]);
  assert.equal(all.split("\n\n")[1], "MLA 9:\n" + C.formatCitation(META, "mla", ACCESS));
  assert.equal(C.formatCitation(META, undefined, ACCESS), all, "'all' is the default");

  // No author → the title leads; no date → n.d.; nothing in BibTeX for what is unknown.
  const bare = { title: "What is a tab?", authors: [], published: "", siteName: "Docs", url: "https://docs.test/tabs" };
  assert.equal(C.formatCitation(bare, "apa", ACCESS), "What is a tab? (n.d.). Docs. Retrieved October 26, 2026, from https://docs.test/tabs");
  assert.equal(C.formatCitation(bare, "mla", ACCESS), '"What is a tab?" Docs, docs.test/tabs. Accessed 26 Oct. 2026.');
  assert.equal(C.formatCitation(bare, "harvard", ACCESS), "What is a tab? (n.d.) Docs. Available at: https://docs.test/tabs (Accessed: 26 October 2026).");
  assert.match(C.formatCitation(bare, "bibtex", ACCESS), /^@misc\{docstestwhat,\n  title = \{What is a tab\?\},\n  howpublished = \{\\url\{https:\/\/docs\.test\/tabs\}\},\n  note = \{Docs\. Accessed 26 October 2026\},\n  urldate = \{2026-10-26\}\n\}$/);
  assert.doesNotMatch(C.formatCitation(bare, "bibtex", ACCESS), /author|year|month/);
  // An organisation stays whole, is not repeated as the site (APA), and BibTeX escapes what it must.
  const org = { title: "Report & findings", authors: ["World Health Organization"], published: "2023", siteName: "World Health Organization", url: "https://who.int/r" };
  assert.equal(C.formatCitation(org, "apa", ACCESS), "World Health Organization. (2023). Report & findings. Retrieved October 26, 2026, from https://who.int/r");
  assert.equal(C.formatCitation(org, "harvard", ACCESS), "World Health Organization (2023) Report & findings. World Health Organization. Available at: https://who.int/r (Accessed: 26 October 2026).");
  assert.match(C.formatCitation(org, "bibtex", ACCESS), /^@misc\{worldhealthorganization2023report,\n  author = \{World Health Organization\},\n  title = \{Report \\& findings\},\n  year = \{2023\},\n  howpublished/);
  // Many authors: APA names them all, MLA and Harvard say et al.; a particle stays with the surname; a non-ISO date parses.
  const many = { title: "T", authors: ["Ludwig van Beethoven", "A B", "C D", "E F"], published: "May 3, 2021", siteName: "S", url: "https://s.test/" };
  assert.match(C.formatCitation(many, "apa", ACCESS), /^van Beethoven, L\., B, A\., D, C\., & F, E\. \(2021, May 3\)\. T\. S\. Retrieved/);
  assert.match(C.formatCitation(many, "mla", ACCESS), /^van Beethoven, Ludwig, et al\. "T\." S, 3 May 2021, s\.test\/\. Accessed/);
  assert.match(C.formatCitation(many, "harvard", ACCESS), /^van Beethoven, L\. et al\. \(2021\) T\. S\. Available/);
  assert.match(C.formatCitation(many, "bibtex", ACCESS), /author = \{van Beethoven, Ludwig and B, A and D, C and F, E\},\n  title = \{T\},\n  year = \{2021\},\n  month = may,/);
  assert.throws(() => C.formatCitation(META, "chicago", ACCESS), /Unknown citation style 'chicago' — use apa, mla, harvard, bibtex or all\./);
  assert.deepEqual(plain([C.parseDate("2024-10"), C.parseDate("2024"), C.parseDate("garbage"), C.parseDate("")]), [{ y: 2024, m: 10, d: 0 }, { y: 2024, m: 0, d: 0 }, null, null]);
  assert.deepEqual(plain([C.parseAuthor("Acme Inc."), C.parseAuthor("Cher"), C.parseAuthor("Doe, Jane")]), [
    { last: "Acme Inc.", first: "", org: "Acme Inc." }, { last: "Cher", first: "", org: "Cher" }, { last: "Doe", first: "Jane", org: "" },
  ]);
});

test("clips: browser_clip_cite reads the page's metadata in order of trust and names what the page lacks", async () => {
  const { tools, page, chrome, T, C } = load();
  page.title = "Berlin facts | Example";
  page.elements = [
    elem("meta", { property: "og:title", content: "Berlin population reaches 3.7 million" }),
    elem("meta", { name: "author", content: "Jane Q. Doe; Roe, John" }),
    elem("meta", { property: "article:author", content: "https://facebook.com/jane" }),
    elem("meta", { property: "article:published_time", content: "2024-10-05T08:00:00Z" }),
    elem("meta", { property: "og:site_name", content: "Example News" }),
    elem("meta", { name: "description" }), // no content: ignored
    elem("link", { rel: "canonical", href: "https://www.example.com/berlin?x=1" }),
    elem("script", { type: "application/ld+json" }, '{"datePublished":"2000-01-01"}'),
    elem("time", { datetime: "1999-01-01" }),
  ];
  const out = outText(await tools.browser_clip_cite({}));
  assert.match(out, /^Citation for "Berlin population reaches 3\.7 million" \(Jane Q\. Doe; Roe, John · Example News · 2024-10-05T08:00:00Z\)\n\nAPA 7:\nDoe, J\. Q\., & Roe, J\. \(2024, October 5\)\. Berlin population reaches 3\.7 million\. Example News\. Retrieved /);
  for (const part of ["\n\nMLA 9:\nDoe, Jane Q., and John Roe. ", "\n\nHarvard:\nDoe, J.Q. and Roe, J. (2024) ", "\n\nBibTeX:\n@misc{doe2024berlin,\n"]) assert.ok(out.includes(part), part);
  assert.doesNotMatch(out, /⚠/);
  assert.equal(chrome.scripting.calls.at(-1).target.allFrames, undefined, "the top frame only");
  const apa = outText(await tools.browser_clip_cite({ style: "APA" }));
  assert.equal(apa.split("\n\n")[1], C.formatCitation(C.metaFromPage(C.pageCitationMeta()), "apa", Date.now()));
  assert.doesNotMatch(apa, /MLA|Harvard|BibTeX/);
  await assert.rejects(tools.browser_clip_cite({ style: "chicago" }), /Unknown citation style 'chicago'/);

  // citation_* beats og: and the document title; repeated citation_author tags are the authors; ld+json beats <time>.
  page.elements = [
    elem("meta", { name: "citation_title", content: "Scholar title" }),
    elem("meta", { property: "og:title", content: "OG title" }),
    elem("meta", { name: "citation_author", content: "Smith, Ann" }),
    elem("meta", { name: "citation_author", content: "Lee, Bo" }),
    elem("meta", { name: "citation_author", content: "smith, ann" }),
    elem("meta", { name: "author", content: "Ignored Person" }),
    elem("script", { type: "application/ld+json" }, '{"@type":"Article","datePublished":"2022-02-02T00:00:00+01:00"}'),
    elem("time", { datetime: "1999-01-01" }),
  ];
  assert.deepEqual(plain(C.metaFromPage(C.pageCitationMeta())), {
    title: "Scholar title", authors: ["Smith, Ann", "Lee, Bo"], published: "2022-02-02T00:00:00+01:00",
    siteName: "example.com", url: "https://www.example.com/page?x=1", host: "example.com",
  });
  // Microdata authors (a nested name wins over the element's text) and <time> when nothing else says.
  page.elements = [
    elem("span", { itemprop: "author" }, "ignored", elem("span", { itemprop: "name" }, "  Nested   Name ")),
    elem("a", { itemprop: "author" }, "Link Author"),
    elem("meta", { name: "application-name", content: "Example App" }),
    elem("time", { datetime: "2021-07-01" }),
  ];
  const micro = C.metaFromPage(C.pageCitationMeta());
  assert.deepEqual(plain([micro.title, micro.authors, micro.published, micro.siteName]), ["Berlin facts | Example", ["Nested Name", "Link Author"], "2021-07-01", "Example App"]);

  // A page that says nothing: the tab's title and address, no author, n.d. — and the gaps are named.
  page.elements = [];
  page.title = "";
  assert.equal(
    outText(await tools.browser_clip_cite({ style: "harvard" })),
    'Citation for "Example Page" (example.com)\n  ⚠ no author on the page — the reference starts with the title; no publication date on the page — shown as n.d.\n\n' +
      C.formatCitation({ title: "Example Page", authors: [], published: "", siteName: "example.com", url: "https://www.example.com/page?x=1" }, "harvard", Date.now())
  );
  chrome.scripting.fail = "Cannot access a chrome:// URL";
  await assert.rejects(tools.browser_clip_cite({}), /^Error: Couldn't read this page's metadata \(Cannot access a chrome:\/\/ URL\) — citations work on regular websites\.$/);
  T.noTab = true;
  await assert.rejects(tools.browser_clip_cite({}), /No active tab in this window\./);
});

test("clips: tags are normalised and capped, shown in the list, and filter the list and the search", async () => {
  const { tools, data, tab, C, X } = load();
  assert.deepEqual(plain(C.normTags([" #Berlin ", "Q3 Budget", "ümlaut!", "a,b", "", "x".repeat(30), "berlin", "--_", null])), ["berlin", "q3-budget", "ümlaut", "a", "b", "x".repeat(24)]);
  assert.deepEqual(plain(C.normTags("One, Two")), ["one", "two"]);
  assert.equal(C.MAX_TAG, 24);
  assert.equal(C.MAX_TAGS, 10);

  await tools.browser_clip_save({ text: "Berlin has 3.7 million inhabitants." });
  tab.url = "https://other.org/x";
  await tools.browser_clip_save({ text: "Growth figures" });
  const [growth, berlin] = clips(data);
  await assert.rejects(tools.browser_clip_tag({ add: ["x"] }), /id is required/);
  await assert.rejects(tools.browser_clip_tag({ id: "clp_nope", add: ["x"] }), /^Error: No clip with id clp_nope — browser_clip_list shows the ids\.$/);
  await assert.rejects(tools.browser_clip_tag({ id: berlin.id }), /Give add and\/or remove/);
  await assert.rejects(tools.browser_clip_tag({ id: berlin.id, add: ["!!!"] }), /Give add and\/or remove/, "a tag with nothing left after normalising is no tag");
  assert.equal(clips(data)[1].tags, undefined);
  assert.equal(outText(await tools.browser_clip_tag({ id: berlin.id, add: ["#Berlin", "Population", "berlin"] })), `Tagged clip ${berlin.id} (example.com): added #berlin #population.\n  tags: #berlin #population`);
  assert.deepEqual(clips(data)[1].tags, ["berlin", "population"]);
  assert.equal(outText(await tools.browser_clip_tag({ id: berlin.id, add: ["stats"], remove: ["population", "nope"] })), `Tagged clip ${berlin.id} (example.com): added #stats, removed #population.\n  tags: #berlin #stats`);
  assert.equal(outText(await tools.browser_clip_tag({ id: berlin.id, add: ["berlin"] })), `Clip ${berlin.id} already has these tags: #berlin #stats — nothing changed.`);
  // At most 10 tags: the rest is named, not added; removing them all drops the field.
  const many = Array.from({ length: 12 }, (_, i) => "t" + i);
  assert.equal(
    outText(await tools.browser_clip_tag({ id: growth.id, add: many })),
    `Tagged clip ${growth.id} (other.org): added #t0 #t1 #t2 #t3 #t4 #t5 #t6 #t7 #t8 #t9.\n  tags: #t0 #t1 #t2 #t3 #t4 #t5 #t6 #t7 #t8 #t9\n  A clip holds at most 10 tags; not added: #t10 #t11.`
  );
  assert.equal(clips(data)[0].tags.length, 10);
  assert.equal(outText(await tools.browser_clip_tag({ id: growth.id, add: ["t11"] })), `Clip ${growth.id} already has these tags: #t0 #t1 #t2 #t3 #t4 #t5 #t6 #t7 #t8 #t9 — nothing changed. A clip holds at most 10 tags; not added: #t11.`);
  assert.equal(outText(await tools.browser_clip_tag({ id: growth.id, remove: many })), `Tagged clip ${growth.id} (other.org): removed #t0 #t1 #t2 #t3 #t4 #t5 #t6 #t7 #t8 #t9.\n  tags: (none)`);
  assert.equal(clips(data)[0].tags, undefined);

  // The list shows the tags and filters by one; so does the search.
  assert.match(outText(await tools.browser_clip_list({})), /\n  clp_[a-z0-9]{6}  "Berlin has 3\.7 million inhabitants\."  —  Example Page · just now  #berlin #stats$/);
  assert.match(outText(await tools.browser_clip_list({ tag: "#BERLIN" })), /^Clips \(1 on 1 site, tagged #berlin\):\nexample\.com \(1\):\n  clp_[a-z0-9]{6}  "Berlin has 3\.7 million inhabitants\."  —  Example Page · just now  #berlin #stats$/);
  assert.equal(outText(await tools.browser_clip_list({ tag: "nope" })), "No clips tagged #nope.");
  assert.equal(outText(await tools.browser_clip_list({ tag: "berlin", host: "other.org" })), "No clips tagged #berlin from other.org.");
  await assert.rejects(tools.browser_clip_list({ tag: "!!!" }), /tag '!!!' holds no letters or digits\./);
  assert.match(outText(await tools.browser_clip_search({ query: "million", tag: "stats" })), /^Clips matching "million" \(1 on 1 site, tagged #stats\):\nexample\.com \(1\):\n  clp_[a-z0-9]{6}  "Berlin has 3\.7 million inhabitants\."  —  Example Page · just now  #berlin #stats$/);
  assert.equal(outText(await tools.browser_clip_search({ query: "growth", tag: "stats" })), 'No clips match "growth" tagged #stats (1 clip searched).');
  assert.equal(outText(await tools.browser_clip_search({ query: "growth", tag: "zzz" })), 'No clips match "growth" tagged #zzz — no clips carry that tag.');
  assert.match(outText(await tools.browser_clip_search({ query: "growth" })), /^Clips matching "growth" \(1 on 1 site\):\nother\.org \(1\):\n  clp_[a-z0-9]{6}  "Growth figures"  —  Example Page · just now$/);
  // The pure helpers leave the store alone.
  const r = C.tagClip(clips(data), berlin.id, { add: ["pure"] });
  assert.deepEqual(plain([r.added, r.removed, r.dropped, r.clip.tags, r.list[1].tags]), [["pure"], [], [], ["berlin", "stats", "pure"], ["berlin", "stats", "pure"]]);
  assert.deepEqual(clips(data)[1].tags, ["berlin", "stats"]);
  assert.deepEqual(C.withTag(clips(data), "#Stats").map((c) => c.id), [berlin.id]);
  assert.equal(C.withTag(clips(data), "").length, 2);
  assert.throws(() => C.withTag(clips(data), "!!"), /holds no letters or digits/);
  // The 📎 tab shows the tags on the source line.
  const dom = fakeDom();
  await X.tabs[0].render(dom.content, dom.ctx);
  assert.deepEqual(dom.content.byClass("cmd-item")[3].byClass("cmd-desc").map((n) => n.text()), ["Example Page · just now · #berlin #stats"]);
});

test("clips: reader mode picks the article by its paragraph text and renders it as Markdown (pure helpers)", () => {
  const { C } = load();
  const menu = N("div", { cls: "menu" }, [N("a", { href: "https://x.test/a" }, ["Home"]), N("a", { href: "https://x.test/b" }, ["About"])]);
  const links = N("div", [N("a", { href: "https://x.test/a" }, ["Only"]), N("a", { href: "https://x.test/b" }, ["links here"])]);
  const body = N("div", { cls: "article-body" }, [
    N("p", ["Berlin has ", N("strong", ["3.7 million"]), " inhabitants, the ", N("a", { href: "https://x.test/census" }, ["census [2024]"]), " says."]),
    N("h2", ["Growth"]),
    N("p", [PROSE(1)]),
    N("ul", [N("li", ["First point"]), N("li", ["Second ", N("em", ["point"]), N("ul", [N("li", ["nested"])])])]),
    N("figure", [N("img", { alt: " The skyline " }), N("figcaption", ["Berlin at dusk"])]),
    N("blockquote", [N("p", ["A quoted line."]), N("p", ["And another."])]),
    N("pre", ["  code\n    indented\n"]),
    N("table", [N("tbody", [N("tr", [N("th", ["City"]), N("th", ["People"])]), N("tr", [N("td", ["Berlin"]), N("td", ["3.7 | million"])])])]),
    N("hr", []),
    N("p", [PROSE(2), N("br", []), "Second line with ", N("code", ["code"]), "."]),
    N("div", { cls: "ad-slot" }, [N("p", ["Buy now! Buy now! Buy now! Buy now! Buy now! Buy now!"])]),
    N("div", { cls: "share-tools" }, [N("p", [PROSE(3)])]),
    links,
    N("div", [N("span", ["tiny"])]),
    N("img", { alt: "" }),
  ]);
  const article = N("article", { cls: "post" }, [N("header", { cls: "article-header" }, [N("h1", ["Title"]), N("p", { cls: "byline" }, ["By Someone"])]), body]);
  const page = N("body", [
    N("header", { cls: "site-header" }, [N("a", { href: "https://x.test/" }, ["Example"]), N("nav", [N("a", { href: "https://x.test/a" }, ["Politics"])])]),
    N("div", { id: "content" }, [article, N("aside", { id: "sidebar" }, [N("p", ["Related: " + PROSE(4)])]), N("div", { cls: "comments" }, [N("p", [PROSE(5)]), N("p", [PROSE(6)])])]),
    N("footer", [N("p", ["© Example"])]),
  ]);
  assert.equal(C.pickMain(page), body, "down from <article> into the container that keeps its text");
  assert.equal(C.scoreCandidate(menu), 0, "an ad/menu/share-ish class or id is page furniture");
  assert.equal(C.scoreCandidate(N("nav", [N("p", [PROSE(1)])])), 0);
  assert.equal(C.scoreCandidate(N("div", { role: "navigation" }, [N("p", [PROSE(1)])])), 0);
  assert.equal(C.scoreCandidate(links), 0, "text that is all links scores nothing");
  assert.ok(C.scoreCandidate(article) > C.scoreCandidate(page), "<article> gets a bonus over the page");
  assert.ok(C.scoreCandidate(N("div", { cls: "article-header" }, [N("p", ["x".repeat(50)])])) > 0, "'header' next to 'article' in the name is the article's own");
  assert.ok(C.scoreCandidate(N("div", [N("p", ["x".repeat(50)])])) > C.scoreCandidate(N("div", [N("span", ["x".repeat(50)])])), "paragraph text counts most");

  const md = C.articleToMarkdown(body);
  assert.equal(md, [
    "Berlin has **3.7 million** inhabitants, the [census \\[2024\\]](https://x.test/census) says.",
    "## Growth",
    PROSE(1),
    "- First point\n- Second _point_\n  - nested",
    "[image: The skyline]",
    "Berlin at dusk",
    "> A quoted line.\n>\n> And another.",
    "```\n  code\n    indented\n```",
    "| City | People |\n| --- | --- |\n| Berlin | 3.7 \\| million |",
    "---",
    PROSE(2) + "\nSecond line with `code`.",
  ].join("\n\n"));
  assert.equal(C.articleToMarkdown(article).split("\n\n").slice(0, 3).join("\n\n"), "# Title\n\nBy Someone\n\n" + md.split("\n\n")[0], "from the <article> itself the header comes first");
  assert.equal(C.articleToMarkdown(null), "");
  assert.equal(C.articleToMarkdown(N("p", ["  spaced   out  "])), "spaced out");
  const spans = N("body", [N("div", [N("span", ["no paragraphs, only spans of text in a div"])])]);
  assert.equal(C.pickMain(spans), spans.kids[0], "without paragraphs the other text decides");
  assert.equal(C.pickMain(N("body", [])), null);
  assert.throws(() => C.extractArticle(N("body", [N("div", [N("a", { href: "https://x.test/" }, ["Only a link"])])])), /No readable text on this page/);
  const art = C.extractArticle(page);
  assert.deepEqual([art.root, art.where, art.markdown, art.minutes], [body, "div.article-body", md, 1]);
  assert.equal(art.words, C.countWords(md));
  assert.equal(C.countWords("Hello **world** [link](https://x.y/z) 3.7 don't\n```\n[image: Berlin]"), 6, "link targets, fences and markers are not words");
  assert.equal(Math.round(1100 / 220), 5);
  assert.equal(C.cutMarkdown("short", 100), "short");
  const cut = C.cutMarkdown("para one\n\npara two\n\n".repeat(50), 120);
  assert.ok(cut.length <= 120 && cut.endsWith("e\n… (cut)") && cut.startsWith("para one\n\npara two"), cut);
  assert.equal(C.cutMarkdown("a".repeat(50) + " " + "b".repeat(50), 60, "…"), "a".repeat(50) + "\n…", "at a word when no line break is near");
});

test("clips: browser_clip_article reads the page, returns the Markdown and saves it as a clip", async () => {
  const { tools, data, page, tab, chrome, T, C } = load();
  page.title = "Berlin facts | Example";
  page.elements = [
    elem("meta", { property: "og:title", content: "Berlin population reaches 3.7 million" }),
    elem("meta", { name: "author", content: "Jane Q. Doe" }),
    elem("meta", { property: "article:published_time", content: "2024-10-05" }),
    elem("meta", { property: "og:site_name", content: "Example News" }),
  ];
  page.body = E("body", [
    E("header", { class: "site-header" }, [E("a", { href: "https://www.example.com/" }, ["Example News"]), E("nav", [E("a", { href: "https://www.example.com/a" }, ["Politics"])])]),
    E("article", [
      E("h1", ["Berlin population reaches 3.7 million"]),
      E("div", { class: "body" }, [
        E("p", ["Berlin has ", E("strong", ["3.7 million"]), " inhabitants, the ", E("a", { href: "https://www.example.com/census" }, ["census"]), " says."]),
        E("p", [PROSE(1)]),
        E("p", { hidden: "" }, ["Hidden paragraph that must not appear in the article at all."]),
        E("script", ["alert('not text')"]),
        E("div", { class: "comments" }, [E("p", [PROSE(2)])]),
      ]),
    ]),
    E("footer", [E("p", ["© Example"])]),
  ]);
  // The serializer: the visible tree as plain data, hidden elements and scripts left out, a cap.
  const raw = C.pageArticleTree({ nodes: 20000, chars: 600000 });
  assert.equal(raw.truncated, false);
  assert.deepEqual(plain(raw.tree.kids.map((k) => k.tag)), ["header", "article", "footer"]);
  assert.deepEqual(plain(raw.tree.kids[1].kids[1].kids.map((k) => k.tag + "." + k.cls)), ["p.", "p.", "div.comments"]);
  assert.deepEqual(plain(raw.tree.kids[1].kids[1].kids[0].kids[3]), { tag: "a", id: "", cls: "", role: "", href: "https://www.example.com/census", kids: ["census"] });
  assert.equal(C.pageArticleTree({ nodes: 3, chars: 600000 }).truncated, true);

  const md = "Berlin has **3.7 million** inhabitants, the [census](https://www.example.com/census) says.\n\n" + PROSE(1);
  const words = C.countWords(md);
  const out = outText(await tools.browser_clip_article({}));
  assert.equal(clips(data).length, 1);
  const c = clips(data)[0];
  assert.equal(out, `Article: "Berlin population reaches 3.7 million" (by Jane Q. Doe · 2024-10-05 · Example News) — ${words} words, ~1 min read; main content from <div.body>.\nSaved as clip ${c.id}.\n\n${md}`);
  assert.deepEqual(plain({ ...c, id: "x", t: 0 }), { id: "x", t: 0, text: md, note: `article · ${words} words`, title: "Berlin population reaches 3.7 million", url: "https://www.example.com/page?x=1", host: "example.com" });
  assert.deepEqual(chrome.scripting.calls.slice(-2).map((o) => [o.func.name, o.target.allFrames]), [["pageArticleTree", undefined], ["pageCitationMeta", undefined]], "the top frame: the tree, then the metadata as the cite tool reads it");
  assert.deepEqual(plain(chrome.scripting.calls.at(-2).args), [{ nodes: 20000, chars: 600000 }]);
  assert.equal(outText(await tools.browser_clip_article({ save: false })), `Article: "Berlin population reaches 3.7 million" (by Jane Q. Doe · 2024-10-05 · Example News) — ${words} words, ~1 min read; main content from <div.body>.\n\n${md}`);
  assert.equal(clips(data).length, 1, "save: false keeps nothing");

  // A long read: the reply is cut to maxChars, the clip to its cap, both marked; the note keeps the full word count.
  page.title = "Long read";
  page.elements = [];
  page.body = E("body", [E("article", Array.from({ length: 60 }, (_, i) => E("p", [PROSE(i)])))]);
  const long = outText(await tools.browser_clip_article({ maxChars: 1000 }));
  assert.match(long, /^Article: "Long read" \(example\.com\) — 1320 words, ~6 min read; main content from <article>\.\nSaved as clip clp_[a-z0-9]{6} \(the first 4000 characters, marked "… \(cut\)"\)\.\n\n/);
  const reply = long.slice(long.indexOf("\n\n") + 2);
  assert.ok(reply.length <= 1000 && reply.startsWith(PROSE(0) + "\n\n" + PROSE(1)), reply.length);
  assert.match(reply, /\n… \(cut: \d{4} characters in all — raise maxChars for the rest\)$/);
  const saved = clips(data)[0];
  assert.ok(saved.text.length <= 4000 && saved.text.endsWith("\n… (cut)") && saved.text.startsWith(PROSE(0)), saved.text.length);
  assert.equal(saved.note, "article · 1320 words");
  assert.equal(saved.title, "Long read");
  assert.doesNotMatch(outText(await tools.browser_clip_article({ save: false, maxChars: 40000 })), /raise maxChars/, "a big enough budget gets the whole text");
  assert.ok(outText(await tools.browser_clip_article({ save: false, maxChars: 5 })).length < 1200, "maxChars is clamped to its range");

  // Pages without readable text, pages the extension can't read, no tab.
  page.body = E("body", [E("div", [E("a", { href: "https://x.test/" }, ["Only a link"])])]);
  await assert.rejects(tools.browser_clip_article({}), /^Error: No readable text on this page — browser_clip_article works on articles and other text pages\.$/);
  chrome.scripting.fail = "Cannot access a chrome:// URL";
  await assert.rejects(tools.browser_clip_article({}), /^Error: Couldn't read this page \(Cannot access a chrome:\/\/ URL\) — reader mode works on regular websites\.$/);
  T.noTab = true;
  await assert.rejects(tools.browser_clip_article({}), /No active tab in this window\./);
  assert.equal(clips(data).length, 2, "a refused extraction saves nothing");
});

test("clips: browser_clip_highlight marks this site's clips in the page (quotes, dashes and node boundaries ignored) and names the missing ones", async () => {
  const { tools, data, page, tab, chrome, T, C } = load();
  assert.equal(C.normalizeForMatch("  Berlin has  “3.7­ million”\n— inhabitants ’ "), "berlin has \"3.7 million\" - inhabitants '");
  assert.equal(C.normalizeForMatch(null), "");
  assert.equal(C.NEEDLE_CHARS, 80);
  assert.deepEqual(C.clipsForHost([{ id: "a", host: "example.com" }, { id: "b", host: "other.org" }, { id: "c", host: "" }], "www.Example.com").map((c) => c.id), ["a"]);
  assert.deepEqual(plain(C.clipsForHost([{ id: "c", host: "" }], "")), []);

  page.body = E("body", [
    E("h1", ["Berlin facts"]),
    E("p", ["Berlin has ", E("strong", ["3.7 million"]), " inhabitants, the ", E("a", { href: "https://www.example.com/census" }, ["census"]), " says."]),
    E("p", ["Growth of 1.2% in 2024 — it’s steady."]),
    E("script", ["Not here at all"]),
  ]);
  const [h1, p1, p2] = page.body.childNodes;
  await tools.browser_clip_save({ text: "berlin HAS  3.7 million", note: "population" });
  await tools.browser_clip_save({ text: "Growth of 1.2% in 2024 - it's steady" });
  await tools.browser_clip_save({ text: "Not here at all" });
  tab.url = "https://other.org/x";
  await tools.browser_clip_save({ text: "Berlin facts" });
  tab.url = "https://www.example.com/page?x=1";
  const [, notHere, growth, berlin] = clips(data);

  const out = outText(await tools.browser_clip_highlight({}));
  assert.equal(out, [
    "Marked 2 of 3 clips from example.com on this page (3 marks):",
    `  ✓ ${growth.id}  "Growth of 1.2% in 2024 - it's steady"`,
    `  ✓ ${berlin.id}  "berlin HAS  3.7 million"`,
    `  ✗ ${notHere.id}  "Not here at all"  — not on this page`,
    "A clip not found here may come from another page of example.com, from text that has changed, or from an image or a part behind a login.",
    "The marks last until the page reloads; mode 'off' removes them.",
  ].join("\n"));
  assert.equal(p1.outline(), "«Berlin has »«3.7 million» inhabitants, the census says.", "across the text node and the <strong> in it");
  assert.equal(p2.outline(), "«Growth of 1.2% in 2024 — it’s steady».", "the page's dash and apostrophe match the clip's plain ones");
  const marks = page.body.marks();
  assert.deepEqual(marks.map((m) => [m.tagName, m.getAttribute("data-agent-clip"), m.getAttribute("title")]), [["MARK", berlin.id, "population"], ["MARK", berlin.id, "population"], ["MARK", growth.id, "Clip " + growth.id]]);
  assert.match(marks[0].style.cssText, /background:#fff3a3/);
  const call = chrome.scripting.calls.at(-1);
  assert.equal(call.func.name, "pageHighlightClips");
  assert.deepEqual(plain(call.args), [[
    { id: notHere.id, needle: "not here at all", title: "Clip " + notHere.id },
    { id: growth.id, needle: "growth of 1.2% in 2024 - it's steady", title: "Clip " + growth.id },
    { id: berlin.id, needle: "berlin has 3.7 million", title: "population" },
  ], "on"]);
  // Again: the old marks go first, the page ends up the same.
  assert.equal(outText(await tools.browser_clip_highlight({ mode: "on" })), out);
  assert.equal(page.body.marks().length, 3);
  assert.equal(p1.outline(), "«Berlin has »«3.7 million» inhabitants, the census says.");
  // Off: the page is as it was.
  assert.equal(outText(await tools.browser_clip_highlight({ mode: "off" })), "Removed 3 clip marks from the page.");
  assert.equal(page.body.marks().length, 0);
  assert.equal(p1.textContent, "Berlin has 3.7 million inhabitants, the census says.");
  assert.equal(outText(await tools.browser_clip_highlight({ mode: "off" })), "No clip marks on this page.");

  // A clip across two blocks (the heading and the paragraph) and one longer than the needle: the first 80 characters decide.
  page.body.appendChild(E("p", [PROSE(1)]));
  await tools.browser_clip_save({ text: "Berlin facts\n\nBerlin has 3.7 million" });
  await tools.browser_clip_save({ text: PROSE(1).slice(0, 90) + " BUT A DIFFERENT ENDING" });
  const [longer, across] = clips(data);
  const again = outText(await tools.browser_clip_highlight({}));
  assert.match(again, /^Marked 4 of 5 clips from example\.com on this page \(7 marks\):\n/);
  assert.deepEqual(again.split("\n").slice(1, 6).map((l) => l.slice(0, 14)), [`  ✓ ${longer.id}`, `  ✓ ${across.id}`, `  ✓ ${growth.id}`, `  ✓ ${berlin.id}`, `  ✗ ${notHere.id}`]);
  assert.equal(h1.outline(), "«Berlin facts»");
  assert.equal(p1.outline(), "««Berlin has »»««3.7 million»» inhabitants, the census says.", "a clip inside another clip's text is marked inside its mark");
  const needle = C.normalizeForMatch(PROSE(1)).slice(0, 80).trim();
  assert.equal(needle.length, 80);
  assert.equal(page.body.childNodes[4].outline(), "«" + PROSE(1).slice(0, 80) + "»" + PROSE(1).slice(80));
  assert.equal(outText(await tools.browser_clip_highlight({ mode: "off" })), "Removed 7 clip marks from the page.");
  assert.equal(page.body.marks().length, 0);

  // Not a website, a site without clips, a page the extension can't touch, no tab.
  tab.url = "chrome://newtab/";
  await assert.rejects(tools.browser_clip_highlight({}), /^Error: Open a website tab first — clips are marked on regular web pages \(this tab is chrome:\/\/newtab\/\)\.$/);
  tab.url = "https://nothing.test/";
  assert.equal(outText(await tools.browser_clip_highlight({})), "No clips from nothing.test to show on this page — browser_clip_save keeps a passage with its source.");
  tab.url = "https://www.example.com/page?x=1";
  chrome.scripting.fail = "Cannot access a chrome:// URL";
  await assert.rejects(tools.browser_clip_highlight({}), /^Error: Couldn't mark the page \(Cannot access a chrome:\/\/ URL\) — highlighting works on regular websites\.$/);
  T.noTab = true;
  await assert.rejects(tools.browser_clip_highlight({}), /No active tab in this window\./);
});
