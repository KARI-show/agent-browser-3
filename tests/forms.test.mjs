// Forms (browser/extras/forms.js) against fakes of chrome.storage / tabs / scripting and the tool
// runtime, with autofill.js loaded first the way extras.js concatenates them: the form report
// (formReport, browser_form_read) on fixed field lists, the draft helpers (pageKey, fieldKey, draftOf,
// restorePlan, trimDrafts), save / restore / list / delete through the tools with their reports, the
// 📝 Drafts tab and the "Forms" quick commands. The page-side collector and filler run in
// tests/e2e/extras-quill.e2e.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeCtx, fakeDom, loadExtra, runTool } from "./mocks/extras-quill.mjs";

const load = (opts) => loadExtra("forms", { deps: ["autofill"], ...opts });
const plain = (x) => JSON.parse(JSON.stringify(x)); // values made inside the vm have another realm's prototypes
const tick = () => new Promise((r) => setTimeout(r, 10));
const own = (names) => names.filter((n) => /^browser_form_/.test(n));

/** A page field as pageAutofillCollect describes one with opts.all. */
const field = (i, over) => Object.assign({ i, tag: "input", type: "text", label: "", name: "", id: "", placeholder: "", autocomplete: "", value: "", required: false, disabled: false, readonly: false, valid: true, message: "", form: 0 }, over);
const FORM = { i: 0, name: "signup", id: "signup-form", action: "example.com", submits: ["Create account"] };
/** A sign-up form: required fields, an invalid email, a password, a select, a checkbox, a radio group, a disabled field, a card number and a search box outside the form. */
const PAGE = [
  field(0, { label: "First name", name: "fname", id: "f1", value: "Ann", required: true }),
  field(1, { type: "email", label: "Email", name: "email", value: "ann@", required: true, valid: false, message: "Please include an '@' in the email address." }),
  field(2, { type: "password", label: "Password", name: "password", passwordLength: 8, required: true }),
  field(3, { tag: "select", type: "select", label: "Country", name: "country", value: "", required: true, options: [{ text: "Select…", value: "" }, { text: "Germany", value: "DE" }, { text: "United States of America", value: "US" }] }),
  field(4, { type: "checkbox", label: "Newsletter", name: "news", checked: false, value: "", optionValue: "yes" }),
  field(5, { type: "radio", label: "Free", name: "plan", checked: false, value: "", optionValue: "free", required: true }),
  field(6, { type: "radio", label: "Pro", name: "plan", checked: true, value: "on", optionValue: "pro", required: true }),
  field(7, { tag: "textarea", type: "textarea", label: "Message", name: "msg", value: "Hello\nthere" }),
  field(8, { label: "Promo", name: "promo", value: "SAVE10", disabled: true }),
  field(9, { label: "Card number", name: "cc", value: "4111 1111", autocomplete: "cc-number" }),
  field(10, { type: "search", label: "Search", name: "q", value: "", form: -1 }),
];
/** What collectFields makes of PAGE in the top frame. */
const collected = (fields = PAGE) => ({ isTop: true, fields, forms: [FORM] });
const KEY = "https://mail.example/compose";

test("loads only for a brand with the feature and the autofill extra; registers three tools, the tab (re-rendered on its storage key) and two Forms commands after autofill's", () => {
  const off = load({ features: { forms: false, autofill: true } });
  assert.deepEqual(own(off.T.names), []);
  assert.equal(off.X, undefined);
  const alone = loadExtra("forms"); // no autofill.js in the build: nothing is registered
  assert.deepEqual(alone.T.names, []);
  assert.equal(alone.X, undefined);
  assert.equal(alone.tab, undefined);

  const { T, tab, commands, X } = load();
  assert.deepEqual(own(T.names), ["browser_form_read", "browser_form_draft_save", "browser_form_draft_restore"]);
  assert.equal(tab.label, "📝 Drafts");
  assert.equal(typeof tab.render, "function");
  assert.deepEqual(plain(tab.storageKeys), [X.KEY]);
  assert.equal(X.KEY, "agentFormDrafts");
  assert.equal(X.MAX, 50);
  assert.equal(X.MAX_VALUE, 2000);
  assert.deepEqual(commands.slice(2).map((c) => [c.group, c.icon, c.name, !!c.partial]), [["Forms", "🔍", "Check this form before I submit", false], ["Forms", "📝", "Save a draft of this form", false]]);
  assert.match(commands[2].prompt, /browser_form_read.*empty, required or invalid.*Don't submit anything\.$/);
  assert.match(commands[3].prompt, /browser_form_draft_save.*never keeps passwords or card numbers.*browser_form_draft_restore/);
});

test("formReport: the summary line, then every field grouped by form with its submit buttons — values, passwords as a length, selects with options, checkbox and radio states, required/invalid/disabled marks", () => {
  const { X } = load();
  const fields = PAGE.map((f) => Object.assign({}, f, { frame: 0, form: f.form === 0 ? Object.assign({ frame: 0 }, FORM) : null }));
  assert.equal(X.formSummary(fields), "10 fields · 1 required empty · 1 invalid: Email");
  assert.equal(X.formReport(fields),
    "10 fields · 1 required empty · 1 invalid: Email\n" +
    'Form "signup" (id signup-form, posts to example.com) · submit: "Create account":\n' +
    '- First name * [text] = "Ann"\n' +
    '- Email * [email] = "ann@" — invalid: Please include an \'@\' in the email address.\n' +
    "- Password * [password] = •••• (8 chars)\n" +
    "- Country * [select] = nothing chosen (options: Select…, Germany, United States of America) — required, empty\n" +
    "- Newsletter [checkbox] ☐ unchecked\n" +
    '- plan * [radio] = "Pro" (of Free, Pro)\n' +
    '- Message [textarea] = "Hello / there"\n' +
    '- Promo [text] = "SAVE10" — disabled\n' +
    '- Card number [text] = "4111 1111"\n' +
    "Outside any <form>:\n" +
    "- Search [search] = empty");
  // Empty required toggles, a chosen select, an unnamed form in a frame, no form at all, read-only.
  const more = [
    Object.assign(field(0, { type: "checkbox", label: "I agree", name: "tos", required: true, checked: false }), { frame: 1, form: { frame: 1, i: 0, name: "", id: "", action: "", submits: [] } }),
    Object.assign(field(1, { type: "radio", label: "A", name: "r", checked: false, optionValue: "a", required: true }), { frame: 1, form: { frame: 1, i: 0, name: "", id: "", action: "", submits: [] } }),
    Object.assign(field(2, { type: "radio", label: "B", name: "r", checked: false, optionValue: "b" }), { frame: 1, form: { frame: 1, i: 0, name: "", id: "", action: "", submits: [] } }),
    Object.assign(field(3, { tag: "select", type: "select", label: "Size", value: "Medium", options: Array.from({ length: 10 }, (_, i) => ({ text: "Size " + i, value: String(i) })), readonly: true }), { frame: 1, form: { frame: 1, i: 0, name: "", id: "", action: "", submits: [] } }),
    Object.assign(field(4, { type: "password", label: "PIN", passwordLength: 0, required: true }), { frame: 1, form: { frame: 1, i: 0, name: "", id: "", action: "", submits: [] } }),
  ];
  assert.equal(X.formReport(more),
    "4 fields · 3 required empty · 0 invalid\n" +
    "Form [frame 1] · no submit button:\n" +
    "- I agree * [checkbox] ☐ unchecked — required, empty\n" +
    "- r * [radio] = nothing chosen (of A, B) — required, empty\n" +
    '- Size [select] = "Medium" (options: Size 0, Size 1, Size 2, Size 3, Size 4, Size 5, Size 6, Size 7 … 10 in all) — read-only\n' +
    "- PIN * [password] = empty — required, empty");
  assert.equal(X.formReport([Object.assign(field(0, { label: "Only" }), { form: null })]), "1 field · 0 required empty · 0 invalid\n- Only [text] = empty", "one group without a form: no heading");
  assert.equal(X.formReport([]), "No form field is visible on this page.");
  assert.deepEqual(plain(X.entriesOf(fields).map((e) => [e.label, e.type, e.empty, e.required, e.valid]))[5], ["plan", "radio", false, true, true]);
});

test("browser_form_read: collects every field in all frames (opts.all) and returns the report; no fields is an error", async () => {
  const { T, scripting } = load();
  scripting.results.pageAutofillCollect = collected();
  const out = await runTool(T, "browser_form_read", {});
  assert.match(out, /^10 fields · 1 required empty · 1 invalid: Email\nForm "signup"/);
  assert.deepEqual(scripting.calls.map((c) => [c.func, c.args, c.target]), [["pageAutofillCollect", [150, { all: true, maxValue: 120 }], { tabId: 7, allFrames: true }]]);
  scripting.results.pageAutofillCollect = collected([]);
  await assert.rejects(T.run("browser_form_read", {}), /No form field is visible on this page \(inputs, textareas, selects, checkboxes or radios\)/);
  scripting.results.pageAutofillCollect = () => { throw new Error("This page (chrome://x) can't be automated"); };
  await assert.rejects(T.run("browser_form_read", {}), /can't be automated/);
});

test("pageKey / fieldKey / keyedFields / draftOf / restorePlan / trimDrafts / findDraftKey", () => {
  const { X } = load();
  assert.equal(X.pageKey("https://shop.example/checkout/step-2?session=abc#top"), "https://shop.example/checkout/step-2");
  assert.equal(X.pageKey("https://shop.example"), "https://shop.example/");
  assert.equal(X.pageKey(" not a url?x=1 "), "not a url");
  assert.equal(X.pageKey(null), "");
  assert.equal(X.fieldKey(field(0, { id: "f1", name: "fname", label: "First" })), "f1");
  assert.equal(X.fieldKey(field(0, { name: "fname", label: "First" })), "fname");
  assert.equal(X.fieldKey(field(0, { label: " First  name " })), "First name");
  assert.equal(X.fieldKey(field(0, { type: "radio", name: "plan", optionValue: "pro", label: "Pro" })), "plan=pro");
  assert.equal(X.fieldKey(field(0, { type: "checkbox", name: "news", label: "News" })), "news");
  assert.equal(X.fieldKey(Object.assign(field(0, { name: "q" }), { frame: 2 })), "[2]q");
  assert.equal(X.fieldKey(field(0, {})), "");
  assert.deepEqual(plain(X.keyedFields([field(0, { name: "q" }), field(1, { name: "q" }), field(2, {}), field(3, { name: "q" })]).map((f) => f.key)), ["q", "q#2", "", "q#3"]);

  const r = X.draftOf(PAGE.concat([field(11, { label: "Bio", name: "bio", value: "x".repeat(2500) }), field(12, { value: "orphan" })]), { url: KEY + "?x=1", title: "  Sign  up ", now: 42 });
  assert.deepEqual(plain(r.draft), { url: KEY + "?x=1", title: "Sign up", t: 42, fields: [
    { key: "f1", label: "First name", value: "Ann" },
    { key: "email", label: "Email", value: "ann@" },
    { key: "plan=pro", label: "Pro", value: "on" },
    { key: "msg", label: "Message", value: "Hello\nthere" },
    { key: "bio", label: "Bio", value: "x".repeat(2000) },
  ] });
  assert.deepEqual(plain({ e: r.skipped.empty.map((f) => f.i), p: r.skipped.password.map((f) => f.i), s: r.skipped.secret.map((f) => f.i), l: r.skipped.locked.map((f) => f.i), n: r.skipped.noKey.map((f) => f.i), c: r.cut.map((f) => f.i) }),
    { e: [3, 4, 5, 10], p: [2], s: [9], l: [8], n: [12], c: [11] });

  // Restore: by key; a filled field is skipped unless overwrite; a select needs an option; secrets and locked fields are refused; missing keys are listed.
  const draft = { url: KEY, title: "Compose", t: 1, fields: [
    { key: "f1", label: "First name", value: "Bea" }, { key: "country", label: "Country", value: "United States" }, { key: "news=yes", label: "Newsletter", value: "on" },
    { key: "plan=pro", label: "Pro", value: "on" }, { key: "password", label: "Password", value: "x" }, { key: "promo", label: "Promo", value: "SAVE20" }, { key: "gone", label: "Gone", value: "y" },
  ] };
  let m = X.restorePlan(PAGE, draft, {});
  assert.deepEqual(plain(m.plan.map((p) => [p.field.i, p.key, p.value, p.option, p.shown])), [[3, "country", "United States", "US", "United States of America"], [4, "news=yes", "on", null, null]]);
  assert.deepEqual(plain(m.skipped.map((s) => [s.field.i, s.key])), [[0, "f1"], [6, "plan=pro"]], "the filled name and the checked radio");
  assert.deepEqual(plain(m.refused.map((x) => [x.field.i, x.why])), [[2, "a secret field is never filled"], [8, "the field is disabled or read-only"]]);
  assert.deepEqual(plain(m.missing), [{ key: "gone", label: "Gone", value: "y" }]);
  assert.deepEqual(plain(m.noOption), []);
  m = X.restorePlan(PAGE, draft, { overwrite: true });
  assert.deepEqual(plain(m.plan.map((p) => [p.field.i, p.value])), [[0, "Bea"], [3, "United States"], [4, "on"], [6, "on"]]);
  assert.deepEqual(plain(m.skipped), []);
  m = X.restorePlan(PAGE, { fields: [{ key: "country", label: "Country", value: "Narnia" }] }, {});
  assert.deepEqual(plain(m.noOption.map((d) => [d.field.i, d.value])), [[3, "Narnia"]]);
  assert.deepEqual(plain(X.restorePlan([], draft, {}).missing.length), 7);

  // The cap drops the oldest drafts but never the one just saved; a lookup by text finds a unique key.
  const many = {};
  for (let i = 0; i < 52; i++) many["https://a.example/p" + i] = { url: "", title: "", t: i + 1, fields: [] };
  const trimmed = X.trimDrafts(many, "https://a.example/p0");
  assert.equal(Object.keys(trimmed).length, 50);
  assert.ok(trimmed["https://a.example/p0"], "the kept one survives though it is the oldest");
  assert.ok(!trimmed["https://a.example/p1"] && !trimmed["https://a.example/p2"], "the two oldest others go");
  assert.equal(Object.keys(many).length, 52, "not mutated");
  assert.deepEqual(plain(X.trimDrafts({ a: { t: 1, fields: [] } }, "a")), { a: { t: 1, fields: [] } });
  const drafts = { "https://a.example/apply": { t: 1, fields: [] }, "https://b.example/apply": { t: 2, fields: [] } };
  assert.equal(X.findDraftKey(drafts, "https://a.example/apply?step=2"), "https://a.example/apply");
  assert.equal(X.findDraftKey(drafts, "b.example"), "https://b.example/apply");
  assert.equal(X.findDraftKey(drafts, "apply"), null, "two keys match");
  assert.equal(X.findDraftKey(drafts, "https://c.example/apply"), null);
  assert.equal(X.findDraftKey(drafts, ""), null);
});

test("browser_form_draft_save: keeps the filled fields of the page under its origin+path, reports what was skipped, replaces the earlier draft and keeps to the cap", async () => {
  const { T, scripting, data, X } = load();
  scripting.results.pageAutofillCollect = collected();
  let out = await runTool(T, "browser_form_draft_save", {});
  assert.equal(out, `Saved a draft of ${KEY} ("Compose"): 4 fields kept — First name, Email, Pro, Message.\n` +
    "Skipped: 4 empty (Country, Newsletter, Free, Search); 1 password (Password); 1 secret (Card number); 1 disabled or read-only (Promo).\n" +
    "browser_form_draft_restore brings it back on this page.");
  assert.deepEqual(scripting.calls.map((c) => [c.func, c.args]), [["pageAutofillCollect", [150, { all: true, maxValue: 2000 }]]]);
  assert.deepEqual(Object.keys(data), [X.KEY]);
  const d = data[X.KEY][KEY];
  assert.deepEqual(Object.keys(d), ["url", "title", "t", "fields"]);
  assert.equal(d.url, KEY);
  assert.equal(d.title, "Compose");
  assert.ok(d.t > 0);
  assert.deepEqual(d.fields, [{ key: "f1", label: "First name", value: "Ann" }, { key: "email", label: "Email", value: "ann@" }, { key: "plan=pro", label: "Pro", value: "on" }, { key: "msg", label: "Message", value: "Hello\nthere" }]);

  // The same page (query ignored) replaces the draft; a long value is cut.
  scripting.results.pageAutofillCollect = collected([field(0, { label: "Bio", name: "bio", value: "x".repeat(2500) })]);
  out = await runTool(T, "browser_form_draft_save", {});
  assert.equal(out, `Saved a draft of ${KEY} ("Compose"): 1 field kept — Bio (replaces the draft from just now).\nCut at 2000 characters: Bio.\nbrowser_form_draft_restore brings it back on this page.`);
  assert.equal(Object.keys(data[X.KEY]).length, 1);
  assert.equal(data[X.KEY][KEY].fields[0].value.length, 2000);

  // Nothing worth keeping.
  scripting.results.pageAutofillCollect = collected([field(0, { label: "Email", value: "" }), field(1, { type: "password", label: "Password", passwordLength: 3 })]);
  await assert.rejects(T.run("browser_form_draft_save", {}), /Nothing to save: no field on this page holds a value the draft could keep — only password or secret fields hold a value \(Password\), and those are never kept\. Drafts keep what the user typed/);
  scripting.results.pageAutofillCollect = collected([]);
  await assert.rejects(T.run("browser_form_draft_save", {}), /No form field is visible on this page/);
  assert.equal(data[X.KEY][KEY].fields[0].key, "bio", "a refused save changes nothing");

  // Not a web page.
  const { T: T2, chrome: c2 } = load();
  c2.tabs.current = { id: 9, url: "chrome://extensions", title: "Extensions" };
  await assert.rejects(T2.run("browser_form_draft_save", {}), /The current tab is not a web page \(chrome:\/\/extensions\) — open the form's page first\./);

  // The cap: the 51st draft pushes the oldest out.
  const full = {};
  for (let i = 0; i < X.MAX; i++) full["https://a.example/p" + i] = { url: "", title: "P" + i, t: i + 1, fields: [{ key: "k", label: "K", value: "v" }] };
  data[X.KEY] = full;
  scripting.results.pageAutofillCollect = collected([field(0, { label: "Email", name: "email", value: "a@b" })]);
  await runTool(T, "browser_form_draft_save", {});
  assert.equal(Object.keys(data[X.KEY]).length, X.MAX);
  assert.ok(data[X.KEY][KEY]);
  assert.ok(!data[X.KEY]["https://a.example/p0"], "the oldest went");
  assert.ok(data[X.KEY]["https://a.example/p1"]);
});

test("browser_form_draft_restore: fills the page from the draft by key through the autofill filler, skips filled fields unless overwrite, reports missing ones; list, url, delete and the errors", async () => {
  const { T, scripting, data, X } = load();
  await assert.rejects(T.run("browser_form_draft_restore", {}), /^Error: No draft saved for https:\/\/mail\.example\/compose\. browser_form_draft_save keeps one\.$/);
  assert.equal(await runTool(T, "browser_form_draft_restore", { list: true }), "No drafts saved yet. browser_form_draft_save keeps what the user typed into a form.");
  data[X.KEY] = {
    [KEY]: { url: KEY, title: "Compose", t: Date.now() - 2 * 3600000, fields: [
      { key: "f1", label: "First name", value: "Bea" }, { key: "email", label: "Email", value: "bea@quill.example" }, { key: "country", label: "Country", value: "Germany" },
      { key: "news=yes", label: "Newsletter", value: "on" }, { key: "plan=pro", label: "Pro", value: "on" }, { key: "msg", label: "Message", value: "Hi" }, { key: "gone", label: "Gone", value: "x" },
    ] },
    "https://other.example/apply": { url: "https://other.example/apply", title: "Job application", t: Date.now() - 3 * 86400000, fields: [{ key: "cv", label: "Cover letter", value: "…" }] },
  };
  assert.equal(await runTool(T, "browser_form_draft_restore", { list: true }),
    `Drafts (2 of 50):\n- ${KEY}  "Compose" · 7 fields · 2h ago\n    First name, Email, Country, Newsletter, Pro, Message, Gone\n- https://other.example/apply  "Job application" · 1 field · 3d ago\n    Cover letter`);

  scripting.results.pageAutofillCollect = collected(PAGE.map((f) => (f.i === 7 ? Object.assign({}, f, { value: "" }) : f)));
  scripting.results.pageAutofillFill = (items) => items.map((it) => (it.i === 3 ? { i: it.i, ok: true, verified: false } : { i: it.i, ok: true, verified: true }));
  let out = await runTool(T, "browser_form_draft_restore", {});
  assert.equal(out, `Restored the draft of ${KEY} (saved 2h ago, 7 fields): filled 2 of 7:\n` +
    'not filled: Country = Germany — the field does not show the value; the page may reject programmatic input — type it with browser_type\n' +
    "filled: Newsletter ☑ checked\n" +
    "filled: Message = Hi\n" +
    'skipped (already filled): First name (holds "Ann", the draft has "Bea"; pass overwrite=true to replace it)\n' +
    'skipped (already filled): Email (holds "ann@", the draft has "bea@quill.example"; pass overwrite=true to replace it)\n' +
    "skipped (already checked): Pro\n" +
    "missing on the page: Gone (gone)\n" +
    "Nothing was submitted — the user checks the form and sends it.");
  assert.deepEqual(plain(scripting.calls.map((c) => [c.func, c.args, c.target])), [
    ["pageAutofillCollect", [150, { all: true, maxValue: 2000 }], { tabId: 7, allFrames: true }],
    ["pageAutofillFill", [[{ i: 3, value: "Germany", option: "DE" }, { i: 4, value: "on" }, { i: 7, value: "Hi" }]], { tabId: 7 }],
  ], "the select gets its option's value, the checkbox 'on'");
  assert.equal(scripting.calls[1].world, "ISOLATED");

  scripting.calls.length = 0;
  scripting.results.pageAutofillFill = (items) => items.map((it) => ({ i: it.i, ok: true, verified: true }));
  out = await runTool(T, "browser_form_draft_restore", { overwrite: true });
  assert.match(out, /^Restored the draft of .* filled 6 of 7:\nfilled: First name = Bea\nfilled: Email = bea@quill\.example\nfilled: Country = Germany\nfilled: Newsletter ☑ checked\nfilled: Pro ☑ checked\nfilled: Message = Hi\nmissing on the page: Gone \(gone\)\n/);
  assert.deepEqual(scripting.calls[1].args[0].map((it) => it.i), [0, 1, 3, 4, 6, 7]);

  // url picks another page's draft (a unique part of its address is enough) for the current page; an unknown one is refused with the count.
  scripting.results.pageAutofillCollect = collected([field(0, { tag: "textarea", type: "textarea", label: "Cover letter", id: "cv", value: "" })]);
  out = await runTool(T, "browser_form_draft_restore", { url: "other.example" });
  assert.match(out, /^Restored the draft of https:\/\/other\.example\/apply \(saved 3d ago, 1 field\): filled 1 of 1:\nfilled: Cover letter = …\n/);
  await assert.rejects(T.run("browser_form_draft_restore", { url: "https://nowhere.example/x?y" }), /No draft saved for https:\/\/nowhere\.example\/x\. 2 drafts are saved — browser_form_draft_restore with list=true shows them\./);
  scripting.results.pageAutofillCollect = collected([]);
  await assert.rejects(T.run("browser_form_draft_restore", {}), /No form field is visible on this page/);

  // delete removes the draft instead of restoring; nothing is injected for it.
  scripting.calls.length = 0;
  assert.equal(await runTool(T, "browser_form_draft_restore", { delete: true }), `Deleted the draft of ${KEY} ("Compose") (7 fields). 1 draft left.`);
  assert.deepEqual(Object.keys(data[X.KEY]), ["https://other.example/apply"]);
  assert.equal(scripting.calls.length, 0);
  assert.equal(await runTool(T, "browser_form_draft_restore", { url: "https://other.example/apply", delete: true }), 'Deleted the draft of https://other.example/apply ("Job application") (1 field). 0 drafts left.');
  await assert.rejects(T.run("browser_form_draft_restore", { delete: true }), /No draft saved for/);
});

test("the 📝 tab: empty state, Save a draft runs browser_form_draft_save, the drafts with Restore (through the tool) and Delete", async () => {
  const { T, tab, scripting, data, X } = load();
  const dom = fakeDom();
  const ctx = fakeCtx(dom);
  const content = dom.node("div");
  await tab.render(content, ctx);
  assert.deepEqual(content.find((n) => n.props.className === "cmd-name").map((n) => n.textContent), ["Save a draft of this page"]);
  assert.match(content.allText, /No drafts yet\./);

  // Save a draft goes through the tool; the status shows its first line.
  scripting.results.pageAutofillCollect = collected([field(0, { label: "Email", name: "email", value: "a@b" }), field(1, { type: "password", label: "Password", passwordLength: 3 })]);
  content.find((n) => n.props.className === "cmd-item")[0].click();
  await tick();
  assert.deepEqual(T.calls, [{ name: "browser_form_draft_save", args: {} }]);
  assert.deepEqual(ctx.statuses.at(-1), { text: `✓ Saved a draft of ${KEY} ("Compose"): 1 field kept — Email.`, kind: "good" });
  assert.equal(ctx.rerenders, 1);
  assert.equal(data[X.KEY][KEY].fields.length, 1);

  await tab.render(content, ctx);
  assert.deepEqual(content.find((n) => n.props.className === "cmd-name").map((n) => n.textContent), ["Save a draft of this page", "Compose"]);
  assert.match(content.allText, new RegExp(KEY.replace(/[.]/g, "\\.") + "\n1 field · just now"));
  const buttons = content.find((n) => n.tag === "button");
  assert.deepEqual(buttons.map((n) => n.textContent), ["↩ Restore", "🗑"]);

  // Restore goes through the tool with the draft's key.
  scripting.results.pageAutofillCollect = collected([field(0, { label: "Email", name: "email", value: "" })]);
  scripting.results.pageAutofillFill = (items) => items.map((it) => ({ i: it.i, ok: true, verified: true }));
  buttons[0].click();
  await tick();
  assert.deepEqual(T.calls.at(-1), { name: "browser_form_draft_restore", args: { url: KEY } });
  assert.deepEqual(ctx.statuses.at(-1), { text: `✓ Restored the draft of ${KEY} (saved just now, 1 field): filled 1 of 1 — nothing was submitted.`, kind: "good" });
  scripting.results.pageAutofillCollect = () => { throw new Error("This page (chrome://x) can't be automated"); };
  buttons[0].click();
  await tick();
  assert.deepEqual(ctx.statuses.at(-1), { text: "⚠ This page (chrome://x) can't be automated", kind: "bad" });

  // Delete (confirm() says yes in the fake) works on storage directly.
  buttons[1].click();
  await tick();
  assert.deepEqual(data[X.KEY], {});
  assert.deepEqual(ctx.statuses.at(-1), { text: "Deleted the draft of Compose.", kind: "good" });
  assert.equal(T.calls.length, 3, "the save and the two restores went through the tool runtime");
});
