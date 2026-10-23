// End-to-end test of the Quill brand's extras (rewrite + snippets) against a real Chromium: the built
// brand (dist-browser/brands/quill/extension) is loaded, its side panel opened as a background tab,
// and a fixture page with a textarea, an input, a contenteditable editor and a paragraph is the tab the
// agent works on. Selections are made through CDP in the page itself; the tools run exactly as
// shim.js / the built-in agent run them (window.AgentBrowserTools.run) and the page is checked through
// a separate CDP session, not only through the tools' own reports.
//
// Run: node browser/build.mjs --brand quill && node --test tests/e2e/extras-quill.e2e.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, findChromium } from "./cdp.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(dirname(here));
const EXT_DIR = join(root, "dist-browser", "brands", "quill", "extension");
const skip = !findChromium()
  ? "no Chromium found (set CHROME_PATH)"
  : !existsSync(join(EXT_DIR, "manifest.json"))
    ? "quill not built (npm run build && node browser/build.mjs --brand quill)"
    : false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Fixture page ───────────────────────────────────────────────────────────

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Writing Fixture</title></head><body>
<h1>Writing Fixture</h1>
<label for="ta">Message</label> <textarea id="ta" rows="4">Hello world, this is a draft.</textarea>
<label for="in">Subject</label> <input id="in" value="Old subject">
<div id="ed" contenteditable="true" aria-label="Rich editor" style="border:1px solid #999;min-height:24px">Rich text here.</div>
<p id="p">Plain paragraph text that nobody can edit.</p>
<script>
  window.__events = [];
  for (const id of ["ta", "in", "ed"]) {
    document.getElementById(id).addEventListener("input", (e) => window.__events.push(id + ":input:" + (e.inputType || "")));
    document.getElementById(id).addEventListener("change", () => window.__events.push(id + ":change"));
  }
</script>
</body></html>`;

let server, BASE;
function startServer() {
  server = createServer((req, res) => {
    res.writeHead(req.url.startsWith("/write.html") ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
    res.end(req.url.startsWith("/write.html") ? PAGE : "not found");
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => { BASE = `http://localhost:${server.address().port}`; r(); }));
}

// ── Browser + panel harness ────────────────────────────────────────────────

let browser, cdp, panel, page, pageTabId, workDir;
const panelErrors = [];

async function waitUntil(fn, timeout = 10000, what = "condition") {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Evaluate in the side panel page (where the tools live). */
function inPanel(expr, timeout = 30000) {
  return Promise.race([cdp.evaluate(panel, expr), sleep(timeout).then(() => { throw new Error(`panel evaluation timed out: ${expr.slice(0, 80)}`); })]);
}
/** Evaluate in the fixture page (the oracle — independent of the tools). */
const inPage = (expr) => cdp.evaluate(page, expr);

/** Call a tool like shim.js does. → { ok, text, error } */
async function call(name, args = {}) {
  const r = await inPanel(`AgentBrowserTools.run(${JSON.stringify(name)}, ${JSON.stringify(args)}).then(
    (c) => ({ ok: true, content: c }),
    (e) => ({ ok: false, error: String((e && e.message) || e) }))`);
  r.text = r.ok ? r.content.filter((p) => p.type === "text").map((p) => p.text).join("\n") : "";
  return r;
}
async function ok(name, args) {
  const r = await call(name, args);
  assert.ok(r.ok, `${name} failed: ${r.error}`);
  return r.text;
}
async function fails(name, args) {
  const r = await call(name, args);
  assert.ok(!r.ok, `${name} should have failed but returned: ${r.text}`);
  return r.error;
}
/** Ref number of the first read_page line matching `re`. */
function refOf(snapshot, re) {
  const line = snapshot.split("\n").find((l) => /^\[\d+\]/.test(l) && re.test(l));
  assert.ok(line, `no element matching ${re} in snapshot:\n${snapshot.slice(0, 3000)}`);
  return Number(/^\[(\d+)\]/.exec(line)[1]);
}
/** Select characters [from, to) of the first text node of #id (a contenteditable or a paragraph). */
const selectIn = (id, from, to) => inPage(`(() => {
  const el = document.getElementById(${JSON.stringify(id)});
  const r = document.createRange(); r.setStart(el.firstChild, ${from}); r.setEnd(el.firstChild, ${to});
  const s = getSelection(); s.removeAllRanges(); s.addRange(r); return s.toString(); })()`);
const clearSelection = () => inPage(`(() => { if (document.activeElement) document.activeElement.blur(); getSelection().removeAllRanges(); return document.activeElement === document.body; })()`);

before(async () => {
  if (skip) return;
  await startServer();
  workDir = mkdtempSync(join(tmpdir(), "quill-extras-e2e-"));
  browser = await launch({ extensionDir: EXT_DIR, userDataDir: join(workDir, "profile"), downloadDir: join(workDir, "downloads") });
  cdp = browser.cdp;
  // The brand has no manifest key: read the id off the service worker.
  const sw = await cdp.waitForTarget((t) => t.type === "service_worker" && t.url.startsWith("chrome-extension://") && t.url.endsWith("/background.js"), 15000);
  const extId = new URL(sw.url).host;
  // Panel first (it becomes a background tab), then the page the agent works on.
  const { targetId: panelTarget } = await cdp.send("Target.createTarget", { url: `chrome-extension://${extId}/sidepanel.html` });
  panel = await cdp.attach(panelTarget);
  cdp.on((m) => {
    if (m.sessionId === panel && m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      panelErrors.push((d.exception && d.exception.description) || d.text);
    }
  });
  await cdp.send("Runtime.enable", {}, panel);
  await waitUntil(() => inPanel("document.readyState === 'complete' && typeof AgentBrowserTools === 'object' && typeof AgentExtras === 'object' && typeof AGENT_BRAND === 'object' && !!window.AgentLocal"), 15000, "panel scripts");
  const { targetId } = await cdp.send("Target.createTarget", { url: `${BASE}/write.html` });
  page = await cdp.attach(targetId);
  await waitUntil(() => inPage("document.readyState === 'complete'"), 10000, "fixture page");
  pageTabId = await inPanel(`chrome.tabs.query({ url: "${BASE}/*" }).then((t) => t[0].id)`);
  await ok("browser_switch_tab", { tabId: pageTabId });
});

after(async () => {
  if (browser) await browser.close();
  if (server) server.close();
  if (workDir) rmSync(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

// ── The panel: tabs, quick commands, tools ─────────────────────────────────

test("quill's panel has the ✍️ Rewrite and ✂️ Snippets tabs, the Writing commands, and the six tools registered and declared", { skip }, async () => {
  const seen = await inPanel(`({
    brand: AGENT_BRAND.id,
    tabs: AgentExtras.tabs.map((t) => t.id),
    labels: [...document.querySelectorAll("#automations-panel .prof-tab")].map((b) => b.textContent),
    commands: AgentExtras.commands.map((c) => [c.group, c.name, !!c.partial]),
    registered: AgentBrowserTools.names.filter((n) => /^browser_(selection|snippet)_/.test(n)),
    declared: AgentLocal.toolNames.filter((n) => /^browser_(selection|snippet)_/.test(n)),
    autoBtn: !!document.getElementById("autoBtn"),
    extraObjects: [typeof AgentExtras.rewrite, typeof AgentExtras.snippets],
  })`);
  assert.equal(seen.brand, "quill");
  assert.deepEqual(seen.tabs, ["rewrite", "snippets"]);
  assert.deepEqual(seen.labels, ["🧩 Recipes", "🧠 Memory", "✍️ Rewrite", "✂️ Snippets"], "the built-in tabs of the brand's features, then the extras'");
  assert.deepEqual(seen.commands, [
    ["Writing", "Formal", false], ["Writing", "Friendly", false], ["Writing", "Shorter", false], ["Writing", "Fix grammar & spelling", false],
    ["Writing", "Translate to English", false], ["Writing", "Expand", false], ["Writing", "Draft a reply to the selected message", false],
    ["Writing", "Save the selection as a snippet", true], ["Writing", "Insert a snippet", true],
  ]);
  const tools = ["browser_selection_get", "browser_selection_replace", "browser_snippet_save", "browser_snippet_list", "browser_snippet_insert", "browser_snippet_delete"];
  assert.deepEqual(seen.registered.sort(), tools.slice().sort());
  assert.deepEqual(seen.declared.sort(), tools.slice().sort(), "the built-in agent declares the same tools");
  assert.ok(seen.autoBtn, "the 🧩 button is there");
  assert.deepEqual(seen.extraObjects, ["object", "object"]);
  // The ⚡ panel lists the Writing group with the commands.
  const names = await inPanel(`(() => { document.getElementById("cmdBtn").click(); const out = [...document.querySelectorAll("#cmdList .cmd-item .cmd-name")].map((n) => n.textContent); document.getElementById("cmdClose").click(); return out; })()`);
  for (const n of ["Formal", "Draft a reply to the selected message", "Save the selection as a snippet", "Insert a snippet"]) assert.ok(names.includes(n), `${n} in the ⚡ panel`);
});

// ── Rewrite ────────────────────────────────────────────────────────────────

test("textarea: browser_selection_get reads the field's selection; browser_selection_replace swaps it in place and fires input/change", { skip }, async () => {
  assert.equal(await inPage(`(() => { const ta = document.getElementById("ta"); ta.focus(); ta.setSelectionRange(6, 11); return ta.value.slice(ta.selectionStart, ta.selectionEnd); })()`), "world");
  const got = await ok("browser_selection_get", {});
  assert.match(got, /^Selection \(5 chars\) in the textarea "Message" — editable: true, browser_selection_replace can put the new text in its place:\nworld$/);
  const out = await ok("browser_selection_replace", { text: "there" });
  assert.equal(out, 'Replaced the selection in the textarea "Message": 5 → 5 chars; the new text is left selected in the field.');
  assert.equal(await inPage(`document.getElementById("ta").value`), "Hello there, this is a draft.");
  assert.deepEqual(await inPage(`window.__events.splice(0)`), ["ta:input:insertReplacementText", "ta:change"]);
  // The new text stays selected, so a second rewrite acts on it.
  assert.match(await ok("browser_selection_get", {}), /^Selection \(5 chars\) in the textarea "Message".*\nthere$/);
  await ok("browser_selection_replace", { text: "there again" });
  assert.equal(await inPage(`document.getElementById("ta").value`), "Hello there again, this is a draft.");
});

test("contenteditable: a selection in the editor is editable; replace puts the new text in and the editor fires input", { skip }, async () => {
  assert.equal(await inPage(`document.getElementById("ed").focus(), true`), true);
  assert.equal(await selectIn("ed", 5, 9), "text");
  const got = await ok("browser_selection_get", {});
  assert.match(got, /^Selection \(4 chars\) in the rich-text editor "Rich editor" — editable: true, browser_selection_replace can put the new text in its place:\ntext$/);
  const out = await ok("browser_selection_replace", { text: "prose" });
  assert.match(out, /^Replaced the selection in the rich-text editor "Rich editor": 4 → 5 chars/);
  assert.equal(await inPage(`document.getElementById("ed").innerText.trim()`), "Rich prose here.");
  const events = await inPage(`window.__events.splice(0)`);
  assert.ok(events.some((e) => e.startsWith("ed:input")), `the editor saw an input event: ${events}`);
});

test("plain page content: the selection is reported as not editable and replace refuses — the result belongs in the chat", { skip }, async () => {
  assert.ok(await clearSelection());
  assert.equal(await selectIn("p", 0, 15), "Plain paragraph");
  const got = await ok("browser_selection_get", {});
  assert.match(got, /^Selection \(15 chars\) in the page content \(<p>\) — editable: false: it cannot be replaced in place, show the rewritten text in the chat:\nPlain paragraph$/);
  const err = await fails("browser_selection_replace", { text: "Formal paragraph" });
  assert.match(err, /not in an editable field.*Show the rewritten text in the chat instead\./);
  assert.equal(await inPage(`document.getElementById("p").textContent`), "Plain paragraph text that nobody can edit.", "the page is untouched");
});

test("a focused input with nothing selected: the whole value comes back with wholeField; replace needs wholeField=true", { skip }, async () => {
  await inPage(`(() => { getSelection().removeAllRanges(); const i = document.getElementById("in"); i.focus(); i.setSelectionRange(i.value.length, i.value.length); })()`);
  const got = await ok("browser_selection_get", {});
  assert.match(got, /^Nothing is selected, but the text input "Subject" has focus — its whole value \(11 chars; wholeField: true, editable: true\)\..*\nOld subject$/);
  assert.match(await fails("browser_selection_replace", { text: "New subject" }), /Nothing is selected inside the focused input:text — pass wholeField=true/);
  assert.equal(await inPage(`document.getElementById("in").value`), "Old subject");
  const out = await ok("browser_selection_replace", { text: "New\nsubject", wholeField: true });
  assert.match(out, /^Replaced the whole value of the text input "Subject": 11 → 11 chars/);
  assert.equal(await inPage(`document.getElementById("in").value`), "New subject", "a single-line field gets a single-line text");
  assert.deepEqual(await inPage(`window.__events.splice(0)`), ["in:input:insertReplacementText", "in:change"]);
});

test("nothing selected, nothing focused: get says so, replace refuses, empty text is refused before touching the page", { skip }, async () => {
  assert.ok(await clearSelection());
  assert.match(await ok("browser_selection_get", {}), /^Nothing is selected on the page and no text field has focus\./);
  assert.match(await fails("browser_selection_replace", { text: "x" }), /Nothing is selected and no text field has focus/);
  assert.match(await fails("browser_selection_replace", { text: "" }), /text is required/);
});

// ── Snippets ───────────────────────────────────────────────────────────────

test("snippets: save with placeholders, list, insert at the caret of the focused input, insert into a ref, uses counted, delete", { skip }, async () => {
  assert.equal(await ok("browser_snippet_list", {}), "No snippets saved yet. browser_snippet_save keeps one.");
  const saved = await ok("browser_snippet_save", { name: "Greeting", text: "Dear {{name}}, thanks for {{what}}!", tags: ["Mail", "support"] });
  assert.match(saved, /^Saved snippet 'Greeting' \(id (snp_\w+), 35 chars, tags: mail, support, placeholders: name, what\)\./);
  const id = /id (snp_\w+)/.exec(saved)[1];
  const list = await ok("browser_snippet_list", {});
  assert.equal(list, `Snippets (1):\n- Greeting  (id ${id}; tags: mail, support; placeholders: name, what)\n    Dear {{name}}, thanks for {{what}}!`);
  assert.match(await ok("browser_snippet_list", { tag: "mail" }), /^Snippets \(1\)/);
  assert.match(await ok("browser_snippet_list", { tag: "nope" }), /^No snippets tagged 'nope'\. 1 saved in all/);

  // Missing values are refused before anything reaches the page.
  assert.match(await fails("browser_snippet_insert", { name: "greeting", values: { name: "Ann" } }), /needs values for: \{\{what\}\}/);

  // At the caret of the focused input (caret placed in the middle: the text goes in there).
  await inPage(`(() => { const i = document.getElementById("in"); i.value = "Re: |end"; i.focus(); i.setSelectionRange(4, 4); })()`);
  const ins = await ok("browser_snippet_insert", { name: "greeting", values: { name: "Ann", what: "writing" } });
  assert.equal(ins, 'Inserted snippet \'Greeting\' (29 chars) into the text input "Subject".');
  assert.equal(await inPage(`document.getElementById("in").value`), "Re: Dear Ann, thanks for writing!|end");
  assert.deepEqual(await inPage(`window.__events.splice(0)`), ["in:input:insertText", "in:change"]);

  // Into the focused rich-text editor, replacing its selection.
  await inPage(`document.getElementById("ed").focus()`);
  assert.equal(await selectIn("ed", 0, 4), "Rich");
  assert.match(await ok("browser_snippet_insert", { id, values: { name: "Bob", what: "reading" } }), /into the rich-text editor "Rich editor"\.$/);
  assert.equal(await inPage(`document.getElementById("ed").innerText.trim()`), "Dear Bob, thanks for reading! prose here.");

  // No focused field and no ref: refused with the hint.
  assert.ok(await clearSelection());
  assert.match(await fails("browser_snippet_insert", { id, values: { name: "A", what: "B" } }), /No text field or editor has focus on the page.*pass ref/);

  // With a ref: typed through browser_type (replaces the value).
  const snap = await ok("browser_read_page", {});
  const ta = refOf(snap, /textarea "Message"/);
  assert.equal(await ok("browser_snippet_insert", { id, ref: ta, values: { name: "Cid", what: "all" } }), `Inserted snippet 'Greeting' (25 chars) into [${ta}].`);
  assert.equal(await inPage(`document.getElementById("ta").value`), "Dear Cid, thanks for all!");

  // Storage: one key, the uses counted; the same name replaces.
  const stored = await inPanel(`chrome.storage.local.get("agentSnippets").then((s) => s.agentSnippets)`);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].uses, 3);
  assert.match(await ok("browser_snippet_save", { name: "GREETING", text: "Hi {{name}}" }), /^Updated snippet 'GREETING' \(id /);
  assert.equal((await inPanel(`chrome.storage.local.get("agentSnippets").then((s) => s.agentSnippets)`)).length, 1);

  assert.equal(await ok("browser_snippet_delete", { name: "Greeting" }), "Deleted snippet 'GREETING'.");
  assert.match(await fails("browser_snippet_delete", { name: "Greeting" }), /No snippet named 'Greeting'/);
  assert.equal(await ok("browser_snippet_list", {}), "No snippets saved yet. browser_snippet_save keeps one.");
});

// ── The 🧩 panel's tabs, rendered for real ────────────────────────────────

test("the ✍️ Rewrite and ✂️ Snippets tabs render in the 🧩 panel and read the page", { skip }, async () => {
  await inPage(`(() => { const ta = document.getElementById("ta"); ta.focus(); ta.setSelectionRange(0, 8); })()`);
  await inPanel(`AgentAutomationsPanel.show("rewrite"), true`);
  const rewrite = await waitUntil(() => inPanel(`(() => { const t = document.querySelector("#automations-panel .cmd-list").innerText; return /Dear Cid/.test(t) ? t : ""; })()`), 10000, "the Rewrite tab");
  assert.match(rewrite, /Selection in the textarea "Message"/);
  assert.match(rewrite, /8 chars — the result goes back into the field\./);
  for (const n of ["Formal", "Friendly", "Shorter", "Fix grammar & spelling", "Translate to English", "Expand", "↻ Refresh"]) assert.ok(rewrite.includes(n), `${n} in the tab`);
  await ok("browser_snippet_save", { name: "Address", text: "12 Quill Lane\nInk Town" });
  await inPanel(`AgentAutomationsPanel.show("snippets"), true`);
  const snippets = await waitUntil(() => inPanel(`(() => { const t = document.querySelector("#automations-panel .cmd-list").innerText; return /Address/.test(t) ? t : ""; })()`), 10000, "the Snippets tab");
  for (const n of ["Add a snippet", "Save the selection as a snippet", "Address", "12 Quill Lane …", "⤵ Insert", "📋 Copy"]) assert.ok(snippets.includes(n), `${n} in the tab`);
  // The panel's Insert button puts the snippet into the page's focused field (no placeholders → straight away).
  await inPage(`(() => { const i = document.getElementById("in"); i.value = ""; i.focus(); })()`);
  await inPanel(`[...document.querySelectorAll("#automations-panel .prof-btn")].find((b) => b.textContent === "⤵ Insert").click(), true`);
  await waitUntil(() => inPage(`document.getElementById("in").value === "12 Quill Lane Ink Town"`), 5000, "the snippet in the input");
  const status = await waitUntil(() => inPanel(`document.querySelector("#automations-panel .prof-status").textContent`), 5000, "a status line");
  assert.match(status, /^Inserted 'Address' into the text input "Subject"\.$/);
  await inPanel(`AgentAutomationsPanel.hide(), true`);
  await ok("browser_snippet_delete", { name: "Address" });
  assert.deepEqual(panelErrors, [], "no uncaught errors in the panel");
});
