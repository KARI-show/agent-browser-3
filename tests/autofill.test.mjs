// Autofill identities (browser/extras/autofill.js) against fakes of chrome.storage / tabs / scripting
// and the tool runtime: key normalisation and the secret filter, save/merge/list/delete and the cap,
// matchFields on fixed page-field lists (synonyms, autocomplete, selects, no-overwrite, the "only"
// filter), the two-step apply (collect in every frame, fill per frame) with its report and dryRun,
// the 🪪 tab and the "Forms" quick commands. The page-side functions themselves run in
// tests/e2e/extras-quill.e2e.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeCtx, fakeDom, loadExtra, runTool } from "./mocks/extras-quill.mjs";

const load = (opts) => loadExtra("autofill", opts);
const plain = (x) => JSON.parse(JSON.stringify(x)); // values made inside the vm have another realm's prototypes
const tick = () => new Promise((r) => setTimeout(r, 10));

/** A page field as pageAutofillCollect describes one. */
const field = (i, over) => Object.assign({ i, tag: "input", type: "text", label: "", name: "", id: "", placeholder: "", autocomplete: "", value: "" }, over);
/** A sign-up form: labels, names, a placeholder-only email that is already filled, an autocomplete-only phone, a select, a username and a password. */
const PAGE = [
  field(0, { label: "First name *", name: "fname", id: "f1" }),
  field(1, { label: "Last name", name: "lname", id: "f2" }),
  field(2, { type: "email", name: "user[email]", placeholder: "you@example.com", value: "old@x.com" }),
  field(3, { type: "email", label: "Confirm email", name: "email2" }),
  field(4, { type: "tel", autocomplete: "shipping tel" }),
  field(5, { label: "Company name", name: "org" }),
  field(6, { tag: "select", type: "select", label: "Country", name: "country", options: [{ text: "Select…", value: "" }, { text: "Germany", value: "DE" }, { text: "United States of America", value: "US" }] }),
  field(7, { label: "Username", name: "username", autocomplete: "username" }),
  field(8, { type: "password", label: "Password", name: "password" }),
  field(9, { tag: "textarea", type: "textarea", label: "Message", name: "msg" }),
  field(10, { label: "Postal code", name: "zip" }),
];
const WORK = { id: "idn_test01", name: "Work", fields: { firstName: "Ann", lastName: "Lee", email: "ann@quill.example", phone: "+1 555 0100", company: "Quill Ltd", country: "United States", zip: "10001", linkedin: "in/annlee" } };
const planOf = (m) => m.plan.map((p) => [p.field.i, p.key, p.value, p.option, p.shown]);

test("loads only for a brand with the feature; registers four tools, the tab (re-rendered on its storage key) and two Forms commands", () => {
  const off = load({ features: { autofill: false, snippets: true } });
  assert.deepEqual(off.T.names, []);
  assert.deepEqual(off.AgentExtras.tabs, []);
  assert.equal(off.X, undefined);

  const { T, tab, commands, X } = load();
  assert.deepEqual(T.names, ["browser_autofill_save", "browser_autofill_apply", "browser_autofill_list", "browser_autofill_delete"]);
  assert.equal(tab.label, "🪪 Identities");
  assert.equal(typeof tab.render, "function");
  assert.deepEqual(plain(tab.storageKeys), [X.KEY]);
  assert.deepEqual(commands.map((c) => [c.group, c.name, !!c.partial]), [["Forms", "Fill this form with my details", false], ["Forms", "Save my details from this form", false]]);
  assert.match(commands[0].prompt, /browser_autofill_list.*browser_autofill_apply.*Don't submit anything\.$/);
  assert.match(commands[1].prompt, /browser_read_page.*browser_autofill_save \(never passwords, PINs or card numbers\)/);
  assert.equal(X.MAX, 20);
  assert.equal(X.MAX_VALUE, 500);
});

test("normKey: camelCase-ish lower tokens and the table's spelling; isSecretKey; normFields refuses secrets and over-long values", () => {
  const { X } = load();
  const keys = { "First name": "firstName", first_name: "firstName", FirstName: "firstName", "FIRST-NAME": "firstName", "Given name": "firstName", Surname: "lastName",
    "E-mail": "email", "Email address": "email", "ZIP code": "zip", Postcode: "zip", "Address line 1": "address", "Address line 2": "address2", "phone number": "phone", Tel: "phone",
    Organisation: "company", "Job title": "jobTitle", Town: "city", Province: "state", "Date of birth": "birthday", LinkedIn: "linkedin", GitHub: "github", Website: "website", URL: "website",
    "my-Custom Key": "myCustomKey", name: "name", "Full name": "fullName", "  ": "", "": "" };
  for (const [raw, want] of Object.entries(keys)) assert.equal(X.normKey(raw), want, raw);
  for (const k of ["password", "Password", "passcode", "PIN", "pinCode", "pin_code", "cvv", "CVC", "cardNumber", "credit card", "iban", "ssn", "secret", "apiToken", "access_token"]) assert.equal(X.isSecretKey(k), true, k + " is a secret");
  for (const k of ["firstName", "shippingAddress", "discard", "email", "zip", "company"]) assert.equal(X.isSecretKey(k), false, k + " is not a secret");
  assert.deepEqual(plain(X.normFields({ "First name": " Ann ", "E-mail": "ann@x", empty: "  ", nothing: null, Company: "Quill\r\nLtd" })), { firstName: "Ann", email: "ann@x", company: "Quill\nLtd" });
  assert.throws(() => X.normFields({ email: "a", Password: "p", cardNumber: "4" }), /^Error: Refused: Password, cardNumber — identities never hold passwords, PINs, card numbers or other secrets/);
  assert.throws(() => X.normFields({ email: "x".repeat(501) }), /Too long: email — a value holds at most 500 characters/);
  assert.throws(() => X.normFields({ "  ": "a", empty: "" }), /no usable key/);
  assert.throws(() => X.normFields(["a"]), /fields is required/);
  assert.throws(() => X.normFields(undefined), /fields is required/);
});

test("save, merge by name, list, delete — one storage key; the cap", async () => {
  const { T, data, X } = load();
  assert.equal(await runTool(T, "browser_autofill_list", {}), "No identities saved yet. browser_autofill_save keeps the user's details (never passwords or card numbers) for filling forms.");
  let out = await runTool(T, "browser_autofill_save", { name: "Work", fields: { "First name": "Ann", "E-mail": "ann@quill.example", Company: "Quill Ltd" } });
  assert.match(out, /^Saved identity 'Work' \(id idn_\w{6}\) with 3 fields: firstName: Ann · email: ann@quill\.example · company: Quill Ltd\. browser_autofill_apply fills a form with it\.$/);
  assert.deepEqual(Object.keys(data), [X.KEY]);
  const idn = data[X.KEY][0];
  assert.deepEqual(Object.keys(idn), ["id", "name", "fields", "created", "updated", "uses"]);
  assert.deepEqual(idn.fields, { firstName: "Ann", email: "ann@quill.example", company: "Quill Ltd" });
  assert.equal(idn.uses, 0);

  // The same name (any case) merges: new keys override, the others stay; id, created and uses survive.
  data[X.KEY][0].uses = 2;
  out = await runTool(T, "browser_autofill_save", { name: "work", fields: { email: "ann@new.example", phone: "+1 555 0100" } });
  assert.equal(out, `Updated identity 'Work' (id ${idn.id}): changed email; added phone — 4 fields now: firstName, email, company, phone.`);
  assert.equal(data[X.KEY].length, 1);
  assert.equal(data[X.KEY][0].id, idn.id);
  assert.equal(data[X.KEY][0].created, idn.created);
  assert.equal(data[X.KEY][0].uses, 2);
  assert.deepEqual(data[X.KEY][0].fields, { firstName: "Ann", email: "ann@new.example", company: "Quill Ltd", phone: "+1 555 0100" });
  assert.equal(await runTool(T, "browser_autofill_save", { name: "Work", fields: { phone: "+1 555 0100" } }), `Updated identity 'Work' (id ${idn.id}): nothing new, the values were the same — 4 fields now: firstName, email, company, phone.`);
  // A secret key refuses the whole call, nothing is stored.
  await assert.rejects(T.run("browser_autofill_save", { name: "Work", fields: { zip: "10001", password: "hunter2" } }), /Refused: password — identities never hold passwords/);
  assert.equal(data[X.KEY][0].fields.zip, undefined);
  await assert.rejects(T.run("browser_autofill_save", { fields: { zip: "1" } }), /name is required/);
  await assert.rejects(T.run("browser_autofill_save", { name: "x" }), /fields is required/);

  await runTool(T, "browser_autofill_save", { name: "Personal", fields: { firstName: "Ann", email: "ann@home.example" } });
  out = await runTool(T, "browser_autofill_list", {});
  assert.equal(out, `Identities (2 of 20):\n- Work  (id ${idn.id}; 4 fields; used 2×; updated just now)\n    firstName: Ann · email: ann@new.example · company: Quill Ltd · phone: +1 555 0100\n- Personal  (id ${data[X.KEY][1].id}; 2 fields; updated just now)\n    firstName: Ann · email: ann@home.example`);

  // Delete by name (a unique prefix is enough) and by id; unknown ones are refused with a hint.
  const pid = data[X.KEY][1].id;
  assert.equal(await runTool(T, "browser_autofill_delete", { name: "pers" }), `Deleted identity 'Personal' (${pid}). 1 left.`);
  await assert.rejects(T.run("browser_autofill_delete", { name: "Personal" }), /No identity named 'Personal'\. browser_autofill_list shows the saved ones\./);
  await assert.rejects(T.run("browser_autofill_delete", { id: "idn_nope" }), /No identity with id idn_nope/);
  assert.equal(await runTool(T, "browser_autofill_delete", { id: idn.id }), `Deleted identity 'Work' (${idn.id}). 0 left.`);
  assert.deepEqual(data[X.KEY], []);
  await assert.rejects(T.run("browser_autofill_delete", {}), /No identities saved yet/);

  // The cap: the 21st identity is refused, merging into an existing one is not.
  data[X.KEY] = Array.from({ length: X.MAX }, (_, i) => ({ id: "idn_" + String(i).padStart(6, "0"), name: "I" + i, fields: { email: "i" + i + "@x" }, created: 1, updated: 1, uses: 0 }));
  await assert.rejects(T.run("browser_autofill_save", { name: "One more", fields: { email: "x@y" } }), /Identity limit reached \(20\)\. Delete one with browser_autofill_delete first\./);
  assert.equal(data[X.KEY].length, X.MAX);
  assert.match(await runTool(T, "browser_autofill_save", { name: "I7", fields: { zip: "1" } }), /^Updated identity 'I7'/);
  assert.equal(data[X.KEY].length, X.MAX);
});

test("matchFields: labels, names, autocomplete and input types find the fields; each field and each key once; selects need an option; passwords never", () => {
  const { X } = load();
  const m = X.matchFields(PAGE, WORK, {});
  assert.deepEqual(plain(planOf(m)), [
    [0, "firstName", "Ann", null, null],
    [1, "lastName", "Lee", null, null],
    [4, "phone", "+1 555 0100", null, null], // autocomplete=tel
    [5, "company", "Quill Ltd", null, null],
    [6, "country", "United States", "US", "United States of America"], // a unique prefix of the option text
    [10, "zip", "10001", null, null], // "Postal code"
  ]);
  assert.deepEqual(plain(m.skipped.map((s) => [s.field.i, s.key])), [[2, "email"]], "the filled email is skipped, and the key is used up (Confirm email stays empty)");
  assert.deepEqual(plain(m.unmatched), [{ key: "linkedin", why: "" }]);
  assert.deepEqual(plain(m.unmatchedFields.map((f) => f.i)), [3, 7, 9], "Confirm email, Username (no 'name' key, and 'username' is one word), Message");

  // fullName takes a plain "Name" field but not "First name" when firstName is there; a type alone is a weak hint; exact names win.
  const page2 = [field(0, { label: "Name" }), field(1, { label: "First name" }), field(2, { type: "email" }), field(3, { name: "jobTitle" }), field(4, { label: "Title", name: "salutation" }), field(5, { type: "url", label: "Website" }), field(6, { type: "url", label: "LinkedIn profile" })];
  const m2 = X.matchFields(page2, { fields: { fullName: "Ann Lee", firstName: "Ann", email: "a@b", jobTitle: "CTO", website: "https://q.example", linkedin: "in/ann" } }, {});
  assert.deepEqual(plain(planOf(m2).map((p) => p.slice(0, 2))), [[0, "fullName"], [1, "firstName"], [2, "email"], [3, "jobTitle"], [5, "website"], [6, "linkedin"]]);
  assert.deepEqual(plain(m2.unmatchedFields.map((f) => f.i)), [4]);

  // A select without a fitting option leaves the key unmatched with the reason; a password field never takes part.
  const m3 = X.matchFields(PAGE, { fields: { country: "Narnia", password: "x" } }, {});
  assert.deepEqual(plain(planOf(m3)), []);
  assert.deepEqual(plain(m3.unmatched), [{ key: "country", why: 'select "Country" has no option "Narnia"' }, { key: "password", why: "" }]);
  assert.deepEqual(plain(X.pickOption(PAGE[6].options, "de")), { text: "Germany", value: "DE" });
  assert.deepEqual(plain(X.pickOption(PAGE[6].options, "GERMANY")), { text: "Germany", value: "DE" });
  assert.deepEqual(plain(X.pickOption(PAGE[6].options, "United")), { text: "United States of America", value: "US" }, "a unique prefix is enough");
  assert.equal(X.pickOption([{ text: "USA", value: "1" }, { text: "US Virgin Islands", value: "2" }], "US"), null, "two options start with US");
  assert.equal(X.pickOption(PAGE[6].options, ""), null);

  // No identity, no fields: empty results, no crash.
  const m4 = X.matchFields([], WORK, {});
  assert.deepEqual(plain(m4.unmatched.map((u) => u.key)), Object.keys(WORK.fields));
  assert.deepEqual(plain(X.matchFields(PAGE, { fields: {} }, {}).unmatchedFields.map((f) => f.i)), [0, 1, 2, 3, 4, 5, 6, 7, 9, 10]);
});

test("matchFields: overwrite fills a field that holds a value; only limits the keys (normalised); fieldName names a field for the report", () => {
  const { X } = load();
  const m = X.matchFields(PAGE, WORK, { overwrite: true });
  assert.deepEqual(plain(planOf(m).map((p) => p.slice(0, 2))), [[0, "firstName"], [1, "lastName"], [2, "email"], [4, "phone"], [5, "company"], [6, "country"], [10, "zip"]]);
  assert.deepEqual(plain(m.skipped), []);
  const m2 = X.matchFields(PAGE, WORK, { overwrite: true, only: ["E-mail", "zip", "nope"] });
  assert.deepEqual(plain(planOf(m2).map((p) => p.slice(0, 3))), [[2, "email", "ann@quill.example"], [10, "zip", "10001"]]);
  assert.deepEqual(plain(m2.unmatched), []);
  assert.deepEqual(plain(m2.unmatchedFields.map((f) => f.i)), [0, 1, 3, 4, 5, 6, 7, 9]);
  const m3 = X.matchFields(PAGE, WORK, { only: ["email"] });
  assert.deepEqual(plain(m3.plan), []);
  assert.deepEqual(plain(m3.skipped.map((s) => s.key)), ["email"]);
  assert.equal(X.fieldName(PAGE[2]), "you@example.com", "placeholder when there is no label");
  assert.equal(X.fieldName(PAGE[4]), "tel input");
  assert.equal(X.fieldName(field(1, { name: "msg", frame: 2 })), "msg [frame 2]");
  assert.equal(X.fieldName(field(1, { label: "x".repeat(70) })), "x".repeat(59) + "…");
});

test("browser_autofill_apply: collects in every frame, fills through the native setter per frame, reports and counts a use; dryRun plans only; identity lookup", async () => {
  const { T, scripting, data, X } = load();
  await runTool(T, "browser_autofill_save", { name: "Work", fields: WORK.fields });
  const id = data[X.KEY][0].id;
  scripting.results.pageAutofillCollect = { isTop: true, fields: PAGE };
  scripting.results.pageAutofillFill = (items) => items.map((it) => ({ i: it.i, ok: true, verified: true }));

  // One identity: no name needed.
  let out = await runTool(T, "browser_autofill_apply", {});
  assert.equal(out, `Filled 6 of 11 fields on this page from identity 'Work' (${id}):\n` +
    "filled: First name * ← firstName = Ann\n" +
    "filled: Last name ← lastName = Lee\n" +
    "filled: tel input ← phone = +1 555 0100\n" +
    "filled: Company name ← company = Quill Ltd\n" +
    'filled: Country ← country = United States (option "United States of America")\n' +
    "filled: Postal code ← zip = 10001\n" +
    'skipped (already filled): you@example.com ← email (holds "old@x.com"; pass overwrite=true to replace it)\n' +
    "not matched: linkedin\n" +
    "unmatched fields on the page: Confirm email, Username, Message\n" +
    "Nothing was submitted — the user checks the form and sends it.");
  assert.deepEqual(plain(scripting.calls.map((c) => [c.func, c.target])), [["pageAutofillCollect", { tabId: 7, allFrames: true }], ["pageAutofillFill", { tabId: 7 }]]);
  assert.deepEqual(scripting.calls[0].args, [150]);
  assert.deepEqual(scripting.calls[1].args, [[{ i: 0, value: "Ann" }, { i: 1, value: "Lee" }, { i: 4, value: "+1 555 0100" }, { i: 5, value: "Quill Ltd" }, { i: 6, value: "United States", option: "US" }, { i: 10, value: "10001" }]], "the select gets its option's value");
  assert.equal(scripting.calls[1].world, "ISOLATED");
  assert.equal(data[X.KEY][0].uses, 1);
  assert.ok(data[X.KEY][0].lastUsed > 0);

  // What the page did not take is reported as not filled; nothing filled is not a use.
  scripting.results.pageAutofillFill = (items) => items.map((it) => (it.i === 1 ? { i: it.i, ok: true, verified: false } : it.i === 5 ? { i: it.i, ok: false, why: "the field is disabled or read-only" } : { i: it.i, ok: true, verified: true }));
  out = await runTool(T, "browser_autofill_apply", { name: "work", overwrite: true });
  assert.match(out, /^Filled 5 of 11 fields on this page from identity 'Work'/);
  assert.match(out, /\nnot filled: Last name ← lastName = Lee — the field does not show the value; the page may reject programmatic input — type it with browser_type\n/);
  assert.match(out, /\nnot filled: Company name ← company = Quill Ltd — the field is disabled or read-only\n/);
  assert.match(out, /\nfilled: you@example\.com ← email = ann@quill\.example\n/, "overwrite fills the filled email");
  assert.ok(!/skipped/.test(out));
  assert.equal(data[X.KEY][0].uses, 2);
  scripting.results.pageAutofillFill = () => [];
  out = await runTool(T, "browser_autofill_apply", { id, only: ["linkedin"] });
  assert.equal(out, `Filled 0 of 11 fields on this page from identity 'Work' (${id}):\nnot matched: linkedin\nunmatched fields on the page: First name *, Last name, you@example.com, Confirm email, tel input, Company name, Country, Username, Message, Postal code\nNothing was submitted — the user checks the form and sends it.`);
  assert.equal(scripting.calls.at(-1).func, "pageAutofillCollect", "an empty plan injects nothing");
  assert.equal(data[X.KEY][0].uses, 2);

  // dryRun: the plan, no fill call, no use.
  scripting.calls.length = 0;
  out = await runTool(T, "browser_autofill_apply", { id, dryRun: true, only: ["firstName", "nope"] });
  assert.equal(out, `Dry run — identity 'Work' (${id}) would fill 1 of 11 fields on this page; nothing was changed:\nwould fill: First name * ← firstName = Ann\nnot in the identity: nope\nunmatched fields on the page: Last name, you@example.com, Confirm email, tel input, Company name, Country, Username, Message, Postal code`);
  assert.deepEqual(scripting.calls.map((c) => c.func), ["pageAutofillCollect"]);
  assert.equal(data[X.KEY][0].uses, 2);
  // More than ten fields left alone: the list is cut and the total named.
  const many = Array.from({ length: 12 }, (_, i) => field(i, { label: "F" + i }));
  assert.match(X.formatApply({ identity: WORK, match: X.matchFields(many, { fields: { zip: "1" } }, {}), results: [], dryRun: true, fieldsCount: 12, missingOnly: [] }), /\nnot matched: zip\nunmatched fields on the page: F0, F1, F2, F3, F4, F5, F6, F7, F8, F9 … \(12 in all\)$/);

  // No fillable field on the page; a page that can't be scripted.
  scripting.results.pageAutofillCollect = { isTop: true, fields: [] };
  await assert.rejects(T.run("browser_autofill_apply", { id }), /No fillable form field is visible on this page/);
  scripting.results.pageAutofillCollect = () => { throw new Error("This page (chrome://x) can't be automated"); };
  await assert.rejects(T.run("browser_autofill_apply", { id }), /can't be automated/);

  // Two identities: a name or id is required; unknown ones are refused with a hint.
  await runTool(T, "browser_autofill_save", { name: "Personal", fields: { email: "ann@home.example" } });
  await assert.rejects(T.run("browser_autofill_apply", {}), /name or id is required — 2 identities are saved: 'Work', 'Personal'\./);
  await assert.rejects(T.run("browser_autofill_apply", { name: "nope" }), /No identity named 'nope'\. browser_autofill_list shows the saved ones\./);
  await assert.rejects(T.run("browser_autofill_apply", { id: "idn_nope" }), /No identity with id idn_nope/);
});

test("browser_autofill_apply: fields of several frames are filled frame by frame, targeted by documentId, and named by their frame", async () => {
  const { T, chrome, scripting, data, X } = load();
  await runTool(T, "browser_autofill_save", { name: "Work", fields: { firstName: "Ann", email: "ann@quill.example" } });
  const orig = chrome.scripting.executeScript;
  chrome.scripting.executeScript = async (o) => {
    if (o.func.name !== "pageAutofillCollect") return orig(o);
    scripting.calls.push({ func: o.func.name, args: plain(o.args || []), target: o.target });
    return [
      { frameId: 3, documentId: "DOC3", result: { isTop: false, fields: [field(0, { label: "Email", type: "email" })] } },
      { frameId: 0, documentId: "DOC0", result: { isTop: true, fields: [field(0, { label: "First name" }), field(1, { label: "Promo code" })] } },
      { frameId: 5, documentId: "DOC5", result: null }, // a frame that did not answer
    ];
  };
  scripting.results.pageAutofillFill = (items) => items.map((it) => ({ i: it.i, ok: true, verified: true }));
  const out = await runTool(T, "browser_autofill_apply", {});
  assert.equal(out, `Filled 2 of 3 fields on this page from identity 'Work' (${data[X.KEY][0].id}):\nfilled: First name ← firstName = Ann\nfilled: Email [frame 1] ← email = ann@quill.example\nunmatched fields on the page: Promo code\nNothing was submitted — the user checks the form and sends it.`);
  assert.deepEqual(plain(scripting.calls.map((c) => [c.func, c.target, c.args])), [
    ["pageAutofillCollect", { tabId: 7, allFrames: true }, [150]],
    ["pageAutofillFill", { tabId: 7, documentIds: ["DOC0"] }, [[{ i: 0, value: "Ann" }]]],
    ["pageAutofillFill", { tabId: 7, documentIds: ["DOC3"] }, [[{ i: 0, value: "ann@quill.example" }]]],
  ], "the top frame first, each frame its own fill");
});

test("the 🪪 tab: empty state, the identities with their fields, Fill this page runs browser_autofill_apply, delete", async () => {
  const { T, tab, scripting, data, X } = load();
  const dom = fakeDom();
  const ctx = fakeCtx(dom);
  const content = dom.node("div");
  await tab.render(content, ctx);
  assert.deepEqual(content.find((n) => n.props.className === "cmd-name").map((n) => n.textContent), ["Save my details from this form"]);
  assert.match(content.allText, /No identities yet\. Ask the agent to remember your details — e\.g\. "remember my details: .*browser_autofill_save\. Secrets such as passwords or card numbers are never stored\./);
  content.find((n) => n.props.className === "cmd-item")[0].click();
  assert.equal(ctx.prompts.length, 1);
  assert.match(ctx.prompts[0], /browser_autofill_save/);

  await runTool(T, "browser_autofill_save", { name: "Work", fields: { firstName: "Ann", email: "ann@quill.example" } });
  const id = data[X.KEY][0].id;
  await tab.render(content, ctx);
  assert.deepEqual(content.find((n) => n.props.className === "cmd-name").map((n) => n.textContent), ["Save my details from this form", "Work"]);
  assert.match(content.allText, /firstName: Ann · email: ann@quill\.example/, "the fields are shown as text");
  assert.match(content.allText, /2 fields · updated just now/);
  assert.ok(!/No identities yet/.test(content.allText));
  const buttons = content.find((n) => n.tag === "button");
  assert.deepEqual(buttons.map((n) => n.textContent), ["📝 Fill this page", "🗑"]);

  // Fill this page goes through the tool (so the call lands in the trace), the status shows the first line.
  scripting.results.pageAutofillCollect = { isTop: true, fields: [field(0, { label: "First name" }), field(1, { label: "Email", type: "email" })] };
  scripting.results.pageAutofillFill = (items) => items.map((it) => ({ i: it.i, ok: true, verified: true }));
  buttons[0].click();
  await tick();
  assert.deepEqual(T.calls.slice(1), [{ name: "browser_autofill_apply", args: { id } }], "after the save above, the fill goes through the tool runtime");
  assert.deepEqual(ctx.statuses.at(-1), { text: `✓ Filled 2 of 2 fields on this page from identity 'Work' (${id}) — nothing was submitted.`, kind: "good" });
  assert.equal(ctx.rerenders, 1);
  assert.equal(data[X.KEY][0].uses, 1);
  scripting.results.pageAutofillCollect = { isTop: true, fields: [] };
  buttons[0].click();
  await tick();
  assert.deepEqual(ctx.statuses.at(-1), { text: "⚠ No fillable form field is visible on this page (enabled, writable text inputs, textareas or selects). Read the page with browser_read_page first.", kind: "bad" });

  // Delete (confirm() says yes in the fake) works on storage directly.
  buttons[1].click();
  await tick();
  assert.deepEqual(data[X.KEY], []);
  assert.deepEqual(ctx.statuses.at(-1), { text: "Deleted 'Work'.", kind: "good" });
  assert.equal(T.calls.length, 3, "the save and the two fills went through the tool runtime, the delete worked on storage directly");
});
