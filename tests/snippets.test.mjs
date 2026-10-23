// Text snippets (browser/extras/snippets.js) against fakes of chrome.storage / tabs / scripting and
// the tool runtime: placeholder parsing and filling, save/list/insert/delete, the cap, insertion
// through browser_type (ref) or at the caret of the focused field (inTop), the ✂️ tab and the
// "Writing" quick commands. The page-side insertion runs in tests/e2e/extras-quill.e2e.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeCtx, fakeDom, loadExtra, runTool } from "./mocks/extras-quill.mjs";

const load = (opts) => loadExtra("snippets", opts);
const plain = (x) => JSON.parse(JSON.stringify(x)); // values made inside the vm have another realm's prototypes

test("loads only for a brand with the feature; registers four tools, the tab (re-rendered on its storage key) and two partial commands", () => {
  const off = load({ features: { snippets: false, rewrite: true } });
  assert.deepEqual(off.T.names, []);
  assert.equal(off.X, undefined);

  const { T, tab, commands, X } = load();
  assert.deepEqual(T.names, ["browser_snippet_save", "browser_snippet_list", "browser_snippet_insert", "browser_snippet_delete"]);
  assert.equal(tab.label, "✂️ Snippets");
  assert.deepEqual(plain(tab.storageKeys), [X.KEY]);
  assert.deepEqual(commands.map((c) => [c.group, c.name, c.partial]), [["Writing", "Save the selection as a snippet", true], ["Writing", "Insert a snippet", true]]);
  assert.match(commands[0].prompt, /browser_snippet_save.*named: $/);
  assert.match(commands[1].prompt, /browser_snippet_insert.*named: $/);
});

test("placeholders / fill / missingValues / firstLine / normTags", () => {
  const { X } = load();
  assert.deepEqual(plain(X.placeholders("Dear {{name}},\n{{ name }} owes {{amount}} by {{due-date}}. {{bad name}} stays.")), ["name", "amount", "due-date"]);
  assert.deepEqual(plain(X.placeholders("no placeholders")), []);
  assert.equal(X.fill("Dear {{name}}, {{amount}} by {{ due }}.", { name: "Ann", amount: "€ 20" }), "Dear Ann, € 20 by {{ due }}.");
  assert.equal(X.fill("Dear {{name}}", { name: "" }), "Dear ", "an empty value is a value");
  assert.equal(X.fill("Dear {{name}}", { name: 0 }), "Dear 0");
  assert.deepEqual(plain(X.missingValues("{{a}} {{b}} {{a}}", { a: "x" })), ["b"]);
  assert.deepEqual(plain(X.missingValues("{{a}}", undefined)), ["a"]);
  assert.equal(X.firstLine("\n\n  Kind regards,  \nAnn"), "Kind regards, …");
  assert.equal(X.firstLine("one line"), "one line");
  assert.equal(X.firstLine("x".repeat(100)), "x".repeat(77) + "…");
  assert.deepEqual(plain(X.normTags(["Mail", "#support", "mail", "", " SUPPORT "])), ["mail", "support"]);
  assert.deepEqual(plain(X.normTags("mail, support crm")), ["mail", "support", "crm"]);
  assert.deepEqual(plain(X.normTags(undefined)), []);
  assert.equal(X.normTags(Array.from({ length: 20 }, (_, i) => "t" + i)).length, 10);
});

test("save, list, replace by name, delete — one storage key", async () => {
  const { T, data, X } = load();
  assert.equal(await runTool(T, "browser_snippet_list", {}), "No snippets saved yet. browser_snippet_save keeps one.");
  let out = await runTool(T, "browser_snippet_save", { name: "Greeting", text: "Dear {{name}},\nthanks for {{what}}!", tags: ["Mail", "support"] });
  assert.match(out, /^Saved snippet 'Greeting' \(id snp_\w{6}, 35 chars, tags: mail, support, placeholders: name, what\)\. browser_snippet_insert puts it into a field\.$/);
  await runTool(T, "browser_snippet_save", { name: "Address", text: "12 Quill Lane\nInk Town" });
  assert.deepEqual(Object.keys(data), [X.KEY]);
  assert.equal(data[X.KEY].length, 2);
  const id = data[X.KEY][0].id;

  out = await runTool(T, "browser_snippet_list", {});
  assert.equal(out, `Snippets (2):\n- Address  (id ${data[X.KEY][1].id})\n    12 Quill Lane …\n- Greeting  (id ${id}; tags: mail, support; placeholders: name, what)\n    Dear {{name}}, …`);
  assert.match(await runTool(T, "browser_snippet_list", { tag: "#Mail" }), /^Snippets \(1\):\n- Greeting/);
  assert.equal(await runTool(T, "browser_snippet_list", { tag: "nope" }), "No snippets tagged 'nope'. 2 saved in all — browser_snippet_list without a tag shows them.");

  // The same name (any case) replaces the text; tags stay unless given; the id and history survive.
  data[X.KEY][0].uses = 3;
  out = await runTool(T, "browser_snippet_save", { name: "greeting", text: "Hi {{name}}!" });
  assert.match(out, /^Updated snippet 'greeting' \(id /);
  assert.equal(data[X.KEY].length, 2);
  assert.equal(data[X.KEY][0].id, id);
  assert.equal(data[X.KEY][0].text, "Hi {{name}}!");
  assert.deepEqual(data[X.KEY][0].tags, ["mail", "support"]);
  assert.equal(data[X.KEY][0].uses, 3);
  await runTool(T, "browser_snippet_save", { name: "Greeting", text: "Hi {{name}}!", tags: [] });
  assert.deepEqual(data[X.KEY][0].tags, []);

  // Validation.
  await assert.rejects(T.run("browser_snippet_save", { text: "x" }), /name is required/);
  await assert.rejects(T.run("browser_snippet_save", { name: "x", text: "  " }), /text is required/);
  await assert.rejects(T.run("browser_snippet_save", { name: "x", text: "y".repeat(X.MAX_TEXT + 1) }), /too long/);

  // Delete by name (prefix is enough when unique) and by id; unknown ones are refused with a hint.
  assert.equal(await runTool(T, "browser_snippet_delete", { name: "addr" }), "Deleted snippet 'Address'.");
  await assert.rejects(T.run("browser_snippet_delete", { name: "Address" }), /No snippet named 'Address'\. browser_snippet_list shows the saved ones\./);
  await assert.rejects(T.run("browser_snippet_delete", { id: "snp_nope" }), /No snippet with id snp_nope/);
  await assert.rejects(T.run("browser_snippet_delete", {}), /name or id is required/);
  assert.equal(await runTool(T, "browser_snippet_delete", { id }), "Deleted snippet 'Greeting'.");
  assert.deepEqual(data[X.KEY], []);
});

test("the cap: the 201st snippet is refused, replacing an existing one is not", async () => {
  const { T, data, X } = load();
  data[X.KEY] = Array.from({ length: X.MAX }, (_, i) => ({ id: "snp_" + String(i).padStart(6, "0"), name: "S" + i, text: "t" + i, tags: [], created: 1, updated: 1, uses: 0 }));
  await assert.rejects(T.run("browser_snippet_save", { name: "One more", text: "x" }), /Snippet limit reached \(200\)\. Delete one with browser_snippet_delete first\./);
  assert.equal(data[X.KEY].length, X.MAX);
  assert.match(await runTool(T, "browser_snippet_save", { name: "S7", text: "new text" }), /^Updated snippet 'S7'/);
  assert.equal(data[X.KEY].length, X.MAX);
  assert.equal(data[X.KEY][7].text, "new text");
});

test("insert: placeholders filled, at the caret of the focused field through inTop; missing values and no focus are refused", async () => {
  const { T, scripting, data, X } = load();
  await runTool(T, "browser_snippet_save", { name: "Greeting", text: "Dear {{name}}, thanks for {{what}}!" });
  const id = data[X.KEY][0].id;
  scripting.results.pageInsertAtCaret = (value) => ({ ok: true, verified: true, kind: "textarea", label: "Message", now: value });
  let out = await runTool(T, "browser_snippet_insert", { name: "greeting", values: { name: "Ann", what: "writing" } });
  assert.equal(out, 'Inserted snippet \'Greeting\' (29 chars) into the textarea "Message".');
  assert.deepEqual(scripting.calls.map((c) => [c.func, c.args]), [["pageInsertAtCaret", ["Dear Ann, thanks for writing!"]]]);
  assert.equal(data[X.KEY][0].uses, 1, "a use is counted");
  assert.ok(data[X.KEY][0].lastUsed > 0);

  await assert.rejects(T.run("browser_snippet_insert", { id, values: { name: "Ann" } }), /Snippet 'Greeting' needs values for: \{\{what\}\}\. Pass them in values/);
  await assert.rejects(T.run("browser_snippet_insert", { id }), /needs values for: \{\{name\}\}, \{\{what\}\}/);
  await assert.rejects(T.run("browser_snippet_insert", { name: "nope" }), /No snippet named 'nope'/);
  assert.equal(scripting.calls.length, 1, "nothing is injected when values are missing");

  scripting.results.pageInsertAtCaret = { error: "No text field or editor has focus on the page. Ask the user to click into the field, or pass ref (an element from browser_read_page) to type the snippet there." };
  await assert.rejects(T.run("browser_snippet_insert", { id, values: { name: "A", what: "B" } }), /No text field or editor has focus.*pass ref/);
  assert.equal(data[X.KEY][0].uses, 1, "a failed insert is not a use");

  scripting.results.pageInsertAtCaret = { ok: true, verified: false, kind: "editable", label: "Editor", now: "untouched" };
  out = await runTool(T, "browser_snippet_insert", { id, values: { name: "A", what: "B" } });
  assert.match(out, /into the rich-text editor "Editor", but the field does not show the text \(it holds: "untouched"\)/);
});

test("insert with ref: types through browser_type with exactly { ref, text }; its report is passed on when it is not the plain one", async () => {
  const { T, scripting, data, X } = load();
  await runTool(T, "browser_snippet_save", { name: "Sig", text: "— Ann\n{{company}}" });
  T.outputs.browser_type = "Typed into [12]."; // the plain report of browser_type
  let out = await runTool(T, "browser_snippet_insert", { name: "Sig", ref: 12, values: { company: "Quill Ltd" } });
  assert.equal(out, "Inserted snippet 'Sig' (15 chars) into [12].");
  assert.deepEqual(T.calls.filter((c) => c.name === "browser_type"), [{ name: "browser_type", args: { ref: 12, text: "— Ann\nQuill Ltd" } }]);
  assert.equal(scripting.calls.length, 0, "nothing is injected when a ref is given");
  assert.equal(data[X.KEY][0].uses, 1);

  T.outputs.browser_type = "Typed into [12], but the field does not show the text (it holds: \"\"). It may be a canvas-based editor.";
  out = await runTool(T, "browser_snippet_insert", { name: "Sig", ref: 12, values: { company: "Q" } });
  assert.match(out, /into \[12\] \(Typed into \[12\], but the field does not show the text/);

  T.failOn = "browser_type";
  await assert.rejects(T.run("browser_snippet_insert", { name: "Sig", ref: 99, values: { company: "Q" } }), /boom: browser_type/);
  assert.equal(data[X.KEY][0].uses, 2, "a failed typing is not a use");
});

test("the ✂️ tab: add form, list with Insert / Copy / Delete, placeholders asked before inserting, save the selection", async () => {
  const { T, tab, scripting, data, X, copied } = load();
  const dom = fakeDom();
  const ctx = fakeCtx(dom);
  const content = dom.node("div");
  await tab.render(content, ctx);
  let names = content.find((n) => n.props.className === "cmd-name").map((n) => n.textContent);
  assert.deepEqual(names, ["Add a snippet", "Save the selection as a snippet"]);
  assert.match(content.allText, /No snippets yet\./);

  // "Add a snippet" opens the form; saving stores and re-renders.
  content.find((n) => n.props.className === "cmd-item")[0].click();
  let inputs = content.find((n) => n.tag === "input" || n.tag === "textarea");
  assert.equal(inputs.length, 3, "name, text, tags");
  inputs[0].value = "Greeting";
  inputs[1].value = "Dear {{name}}, hello!";
  inputs[2].value = "mail";
  const save = content.find((n) => n.tag === "button" && /Save snippet/.test(n.textContent))[0];
  save.click();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(ctx.statuses.at(-1), { text: "Saved 'Greeting'.", kind: "good" });
  assert.equal(ctx.rerenders, 1);
  assert.equal(data[X.KEY][0].text, "Dear {{name}}, hello!");
  assert.deepEqual(data[X.KEY][0].tags, ["mail"]);

  // The list: name, first line, meta, three buttons.
  await tab.render(content, ctx);
  names = content.find((n) => n.props.className === "cmd-name").map((n) => n.textContent);
  assert.deepEqual(names, ["Add a snippet", "Save the selection as a snippet", "Greeting"]);
  assert.match(content.allText, /#mail · \{\{name\}\}/);
  const buttons = content.find((n) => n.tag === "button").map((n) => n.textContent);
  assert.deepEqual(buttons, ["⤵ Insert", "📋 Copy", "🗑"]);

  // Copy puts the raw text on the clipboard.
  content.find((n) => n.tag === "button")[1].click();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(copied, ["Dear {{name}}, hello!"]);
  assert.deepEqual(ctx.statuses.at(-1), { text: "Copied 'Greeting'.", kind: "good" });

  // Insert asks for the placeholder, then inserts into the focused field of the page.
  content.find((n) => n.tag === "button")[0].click();
  const ph = content.find((n) => n.tag === "input");
  assert.equal(ph.length, 1);
  assert.equal(ph[0].props.placeholder, "name");
  ph[0].value = "Bob";
  scripting.results.pageInsertAtCaret = (v) => ({ ok: true, verified: true, kind: "input:text", label: "Subject", now: v });
  content.find((n) => n.tag === "button" && n.textContent === "⤵ Insert")[0].click();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(scripting.calls.at(-1).args, ["Dear Bob, hello!"]);
  assert.deepEqual(ctx.statuses.at(-1), { text: "Inserted 'Greeting' into the text input \"Subject\".", kind: "good" });
  assert.equal(data[X.KEY][0].uses, 1);

  // Save the selection: the page's selection lands in the form's text.
  await tab.render(content, ctx);
  scripting.results.pageSelectedText = { text: "Selected words" };
  content.find((n) => n.props.className === "cmd-item")[1].click();
  await new Promise((r) => setTimeout(r, 10));
  inputs = content.find((n) => n.tag === "input" || n.tag === "textarea");
  assert.equal(inputs[1].value, "Selected words");
  assert.equal(inputs[0].value, "");
  // …and nothing selected is a status line, not a form.
  await tab.render(content, ctx);
  scripting.results.pageSelectedText = { text: "  " };
  content.find((n) => n.props.className === "cmd-item")[1].click();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(ctx.statuses.at(-1), { text: "Nothing is selected on the page.", kind: "bad" });
  assert.equal(content.find((n) => n.tag === "textarea").length, 0);

  // Delete (confirm() says yes in the fake).
  await tab.render(content, ctx);
  content.find((n) => n.tag === "button" && n.textContent === "🗑")[0].click();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(data[X.KEY], []);
  assert.deepEqual(ctx.statuses.at(-1), { text: "Deleted 'Greeting'.", kind: "good" });
  assert.equal(T.calls.length, 0, "the tab works on storage directly, nothing lands in the recipe trace");
});
