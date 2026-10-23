// Selection editing (browser/extras/rewrite.js) against fakes of chrome and the tool runtime: what
// browser_selection_get reports for a selection in a field, in a rich-text editor, in plain content
// and when nothing is selected; what browser_selection_replace refuses and reports; the ✍️ tab and
// the "Writing" quick commands. The page-side functions themselves run in tests/e2e/extras-quill.e2e.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeCtx, fakeDom, loadExtra, runTool } from "./mocks/extras.mjs";

const load = (opts) => loadExtra("rewrite", opts);
const plain = (x) => JSON.parse(JSON.stringify(x)); // values made inside the vm have another realm's prototypes

test("loads only for a brand with the feature; registers its two tools, the tab and seven Writing commands", () => {
  const off = load({ features: { rewrite: false, snippets: true } });
  assert.deepEqual(off.T.names, []);
  assert.deepEqual(off.AgentExtras.tabs, []);
  assert.equal(off.X, undefined);

  const { T, tab, commands, X } = load();
  assert.deepEqual(T.names, ["browser_selection_get", "browser_selection_replace"]);
  assert.equal(tab.label, "✍️ Rewrite");
  assert.equal(typeof tab.render, "function");
  assert.deepEqual(commands.map((c) => c.group), Array(7).fill("Writing"));
  assert.deepEqual(commands.map((c) => c.name), ["Formal", "Friendly", "Shorter", "Fix grammar & spelling", "Translate to English", "Expand", "Draft a reply to the selected message"]);
  for (const c of commands) {
    assert.match(c.prompt, /browser_selection_get/, `${c.name} sends the agent to the selection tools`);
    assert.ok(!c.partial, `${c.name} is sent as it is`);
  }
  for (const c of commands.slice(0, 6)) assert.match(c.prompt, /browser_selection_replace/);
  assert.match(commands[6].prompt, /Show the draft in the chat/);
  assert.equal(X.PRESETS.length, 6);
  assert.equal(X.presetPrompt(X.PRESETS[0]), commands[0].prompt);
});

test("browser_selection_get: a selection inside a textarea is editable, with the field's kind and label", async () => {
  const { T, scripting } = load();
  scripting.results.pageSelectionGet = { selected: true, editable: true, kind: "textarea", label: "Message", text: "Hello wrold", length: 11, start: 0, end: 11, fieldLength: 40 };
  const out = await runTool(T, "browser_selection_get", {});
  assert.match(out, /^Selection \(11 chars\) in the textarea "Message" — editable: true, browser_selection_replace can put the new text in its place:\nHello wrold$/);
  assert.deepEqual(scripting.calls.map((c) => [c.func, c.args, c.world]), [["pageSelectionGet", [], "ISOLATED"]], "one injection into the top frame");
});

test("browser_selection_get: plain page content is reported as not editable; a rich-text editor as editable", async () => {
  const { T, scripting } = load();
  scripting.results.pageSelectionGet = { selected: true, editable: false, text: "Some article text.", length: 18, where: "p" };
  let out = await runTool(T, "browser_selection_get", {});
  assert.match(out, /^Selection \(18 chars\) in the page content \(<p>\) — editable: false: it cannot be replaced in place, show the rewritten text in the chat:\nSome article text\.$/);

  scripting.results.pageSelectionGet = { selected: true, editable: true, kind: "editable", label: "Body", text: "rich", length: 4, unfocused: true };
  out = await runTool(T, "browser_selection_get", {});
  assert.match(out, /in the rich-text editor "Body", which is not focused — editable: true/);

  scripting.results.pageSelectionGet = { selected: true, editable: true, kind: "input:search", label: "", text: "lamp", length: 4 };
  out = await runTool(T, "browser_selection_get", {});
  assert.match(out, /in the search input — editable: true/);
});

test("browser_selection_get: nothing selected → says so; a focused field → its whole value with wholeField", async () => {
  const { T, scripting } = load();
  scripting.results.pageSelectionGet = { selected: false, editable: false, text: "", length: 0 };
  assert.match(await runTool(T, "browser_selection_get", {}), /^Nothing is selected on the page and no text field has focus\./);

  scripting.results.pageSelectionGet = { selected: false, editable: true, wholeField: true, kind: "input:text", label: "Subject", text: "Old subject", length: 11, fieldLength: 11 };
  const out = await runTool(T, "browser_selection_get", {});
  assert.match(out, /^Nothing is selected, but the text input "Subject" has focus — its whole value \(11 chars; wholeField: true, editable: true\)\. Replace it only if .*wholeField=true\):\nOld subject$/);

  // Passwords never reach the model.
  scripting.results.pageSelectionGet = { selected: true, editable: true, wholeField: false, kind: "input:password", label: "Password", text: "", length: 6, password: true };
  assert.match(await runTool(T, "browser_selection_get", {}), /password input "Password".*\n\(hidden — a password field\)$/);
});

test("formatSelection truncates a huge selection and says how much is left", () => {
  const { X } = load();
  const big = "x".repeat(X.MAX_REPORT + 500);
  const out = X.formatSelection({ selected: true, editable: false, text: big, length: big.length });
  assert.ok(out.length < big.length);
  assert.match(out, /… \(500 more characters not shown\)$/);
});

test("browser_selection_replace: refuses a selection in plain content (→ show it in the chat), nothing selected, and empty text", async () => {
  const { T, scripting } = load();
  scripting.results.pageSelectionReplace = { error: "The selection is in the page's content, not in an editable field, so it cannot be replaced there. Show the rewritten text in the chat instead." };
  await assert.rejects(T.run("browser_selection_replace", { text: "Better." }), /not in an editable field.*Show the rewritten text in the chat/);
  scripting.results.pageSelectionReplace = { error: "Nothing is selected inside the focused textarea — pass wholeField=true to replace its whole value, or ask the user to select the part to rewrite." };
  await assert.rejects(T.run("browser_selection_replace", { text: "Better." }), /pass wholeField=true/);
  assert.deepEqual(scripting.calls.map((c) => c.args), [["Better.", false], ["Better.", false]], "wholeField defaults to false");
  await assert.rejects(T.run("browser_selection_replace", {}), /text is required/);
  await assert.rejects(T.run("browser_selection_replace", { text: "   " }), /text is required/);
  assert.equal(scripting.calls.length, 2, "nothing is injected for bad input");
});

test("browser_selection_replace: reports what it replaced; wholeField is passed through; an unverified field says so", async () => {
  const { T, scripting } = load();
  scripting.results.pageSelectionReplace = (newText, wholeField) => ({ ok: true, verified: true, kind: "textarea", label: "Message", replaced: 5, wholeField, now: "Hello there" });
  let out = await runTool(T, "browser_selection_replace", { text: "there" });
  assert.equal(out, 'Replaced the selection in the textarea "Message": 5 → 5 chars; the new text is left selected in the field.');
  out = await runTool(T, "browser_selection_replace", { text: "New subject", wholeField: true });
  assert.match(out, /^Replaced the whole value of the textarea "Message": 5 → 11 chars/);
  assert.deepEqual(scripting.calls.map((c) => c.args), [["there", false], ["New subject", true]]);

  scripting.results.pageSelectionReplace = { ok: true, verified: false, kind: "editable", label: "Editor", replaced: 4, now: "the old text still" };
  out = await runTool(T, "browser_selection_replace", { text: "new" });
  assert.match(out, /^Put the new text into the selection in the rich-text editor "Editor", but the field does not show it \(it holds: "the old text still"\)\. .*show the rewritten text in the chat/);
});

test("the ✍️ tab: shows the selection, refreshes it, and its presets send prompts through ctx.sendPrompt", async () => {
  const { tab, scripting } = load();
  const dom = fakeDom();
  const ctx = fakeCtx(dom);
  const content = dom.node("div");
  scripting.results.pageSelectionGet = { selected: true, editable: true, kind: "textarea", label: "Message", text: "Hello wrold", length: 11 };
  await tab.render(content, ctx);
  const names = content.find((n) => n.props.className === "cmd-name").map((n) => n.textContent);
  assert.deepEqual(names, ['Selection in the textarea "Message"', "Formal", "Friendly", "Shorter", "Fix grammar & spelling", "Translate to English", "Expand"]);
  assert.match(content.allText, /11 chars — the result goes back into the field\./);
  assert.match(content.allText, /Hello wrold/, "the selected text is shown as text");
  // The presets send their prompt.
  const items = content.find((n) => n.props.className === "cmd-item");
  items[1].click(); // Friendly (the selection block above the presets is "cmd-item event", not in this list)
  assert.equal(ctx.prompts.length, 1);
  assert.match(ctx.prompts[0], /^Rewrite the text I selected on the page in a friendly, conversational tone\. Read it with browser_selection_get first/);
  // Refresh re-reads the page.
  scripting.results.pageSelectionGet = { selected: false, editable: false, text: "", length: 0 };
  const refresh = content.find((n) => n.tag === "button")[0];
  assert.equal(refresh.textContent, "↻ Refresh");
  refresh.click();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(content.find((n) => n.props.className === "cmd-name")[0].textContent, "Nothing selected");
  assert.equal(scripting.calls.length, 2);
  // A page that can't be scripted: the error is shown, the presets stay.
  scripting.results.pageSelectionGet = () => { throw new Error("This page (chrome://x) can't be automated"); };
  refresh.click();
  await new Promise((r) => setTimeout(r, 10));
  assert.match(content.allText, /⚠ This page \(chrome:\/\/x\) can't be automated/);
  assert.equal(content.find((n) => n.props.className === "cmd-item").length, 6, "the six presets");
});

test("summarizeSelection: the three states of the tab's header", () => {
  const { X } = load();
  assert.deepEqual(plain(X.summarizeSelection({})), { title: "Nothing selected", detail: "Select text on the page — or click into a field — and press Refresh.", quote: "" });
  assert.deepEqual(plain(X.summarizeSelection({ selected: false, wholeField: true, editable: true, kind: "input:text", label: "Subject", text: "Old", length: 3 })), { title: 'Whole text input "Subject"', detail: "3 chars, nothing selected inside it — a preset rewrites the whole field.", quote: "Old" });
  const long = "y".repeat(400);
  const s = X.summarizeSelection({ selected: true, editable: false, text: long, length: 400 });
  assert.equal(s.title, "Selection in the page content");
  assert.equal(s.quote, "y".repeat(300) + "…");
});
