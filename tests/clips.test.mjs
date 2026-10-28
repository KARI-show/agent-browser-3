// Research clips (browser/extras/clips.js) against fakes of chrome.storage / tabs / scripting and of
// the tool registry: save (selection, text, textarea, frames), list grouped by site, the Markdown
// export, delete by id / host / all, the caps, search, update, the citation of a page (its metadata
// and the four styles), and the 📎 tab's buttons.
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

function load({ features = ["clips"] } = {}) {
  const { data, storage } = fakeStorage();
  // The page the fake tab shows: what the injected functions find when they run in the vm context.
  const page = { selection: "", active: null, title: "Example Page", elements: [] };
  const document = {
    get activeElement() { return page.active; },
    get title() { return page.title; },
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
  ]);
  for (const c of X.commands) { assert.ok(c.icon); assert.match(c.prompt, /browser_clip_(save|export|search|cite)/); }
  assert.match(X.commands[3].prompt, /browser_clip_search.*for: $/);

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
