// Selection editing (browser/extras/rewrite.js) against fakes of chrome and the tool runtime: what
// browser_selection_get reports for a selection in a field, in a rich-text editor, in plain content
// and when nothing is selected; what browser_selection_replace refuses and reports; the text
// statistics (textStats, browser_selection_stats), find & replace (replaceInText,
// browser_selection_replace_all) and the case transforms (transformCase, browser_selection_case); the
// ✍️ tab and the "Writing" quick commands. The page-side functions themselves run in
// tests/e2e/extras-quill.e2e.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeCtx, fakeDom, loadExtra, runTool } from "./mocks/extras-quill.mjs";

const load = (opts) => loadExtra("rewrite", opts);
const plain = (x) => JSON.parse(JSON.stringify(x)); // values made inside the vm have another realm's prototypes

test("loads only for a brand with the feature; registers its five tools, the tab and nine Writing commands", () => {
  const off = load({ features: { rewrite: false, snippets: true } });
  assert.deepEqual(off.T.names, []);
  assert.deepEqual(off.AgentExtras.tabs, []);
  assert.equal(off.X, undefined);

  const { T, tab, commands, X } = load();
  assert.deepEqual(T.names, ["browser_selection_get", "browser_selection_replace", "browser_selection_stats", "browser_selection_replace_all", "browser_selection_case"]);
  assert.equal(tab.label, "✍️ Rewrite");
  assert.equal(typeof tab.render, "function");
  assert.deepEqual(commands.map((c) => c.group), Array(9).fill("Writing"));
  assert.deepEqual(commands.map((c) => c.name), ["Formal", "Friendly", "Shorter", "Fix grammar & spelling", "Translate to English", "Expand", "Draft a reply to the selected message", "Statistics of the selection", "Find & replace in this field"]);
  for (const c of commands.slice(0, 7)) {
    assert.match(c.prompt, /browser_selection_get/, `${c.name} sends the agent to the selection tools`);
    assert.ok(!c.partial, `${c.name} is sent as it is`);
  }
  for (const c of commands.slice(0, 6)) assert.match(c.prompt, /browser_selection_replace/);
  assert.match(commands[6].prompt, /Show the draft in the chat/);
  // The two additions: statistics go as they are, find & replace waits for the user's words.
  assert.match(commands[7].prompt, /browser_selection_stats/);
  assert.ok(!commands[7].partial);
  assert.match(commands[8].prompt, /browser_selection_replace_all.*of: $/);
  assert.equal(commands[8].partial, true);
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

test("textStats: words, characters, sentences, paragraphs, reading time and readability of a fixed passage (English syllable heuristic)", () => {
  const { X } = load();
  const passage = "The quick brown fox jumps over the lazy dog. It was a sunny day!\n\nEveryone cheered loudly. Prices rose 3.5 percent, e.g. bread.";
  // 25 words; "3.5" stays one sentence, "e.g." ends one (the heuristic's known cost); 32 syllables by the vowel-group rule.
  assert.deepEqual(plain(X.textStats(passage)), {
    words: 25, characters: 127, charactersNoSpaces: 104, sentences: 5, paragraphs: 2, avgWordsPerSentence: 5,
    longest: { words: 9, text: "The quick brown fox jumps over the lazy dog." },
    readingSeconds: 8, readingTime: "8 s", syllables: 32, fleschEase: 93.5, fkGrade: 1.5,
  });
  assert.deepEqual(["the", "quick", "over", "lazy", "everyone", "cheered", "loudly", "little", "statistics"].map(X.syllables), [1, 1, 2, 2, 3, 1, 2, 2, 3]);
  assert.equal(X.formatStats(X.textStats(passage), "the selection"),
    "Statistics of the selection:\n" +
    "- words: 25 · characters: 127 (104 without spaces)\n" +
    "- sentences: 5 · paragraphs: 2 · 5 words per sentence on average\n" +
    "- longest sentence: 9 words — \"The quick brown fox jumps over the lazy dog.\"\n" +
    "- reading time: 8 s at 200 wpm\n" +
    "- Flesch reading ease: 93.5 (very easy) · Flesch–Kincaid grade: 1.5 — from an English syllable heuristic, rough for other languages");
  // Empty text, minutes for a long one, the longest sentence cut at 60 characters.
  assert.deepEqual(plain(X.textStats("  \n ")), { words: 0, characters: 0, charactersNoSpaces: 0, sentences: 0, paragraphs: 0, avgWordsPerSentence: 0, longest: null, readingSeconds: 0, readingTime: "0 s", syllables: 0, fleschEase: null, fkGrade: null });
  assert.equal(X.formatStats(X.textStats(""), "the selection"), "Nothing to count: the selection holds no words.");
  const long = Array.from({ length: 60 }, (_, i) => "Sentence number " + i + " is here.").join(" ") + " " + "word ".repeat(70).trim() + ".";
  const st = X.textStats(long);
  assert.equal(st.words, 370);
  assert.equal(st.sentences, 61);
  assert.equal(st.readingTime, "1.9 min");
  assert.equal(st.longest.words, 70);
  assert.equal(st.longest.text, "word ".repeat(12) + "…");
  assert.match(X.formatStats(X.textStats("Notwithstanding the aforementioned considerations, the organisation's representatives unanimously acknowledged the unprecedented complexity."), "x"), /\(very difficult\)/);
});

test("browser_selection_stats: the selection by default (the whole focused field when nothing is selected), scope field and scope page", async () => {
  const { T, scripting, X } = load();
  scripting.results.pageSelectionGet = { selected: true, editable: true, kind: "textarea", label: "Message", text: "Hello world. Bye.", length: 17 };
  let out = await runTool(T, "browser_selection_stats", {});
  assert.match(out, /^Statistics of the selection in the textarea "Message":\n- words: 3 · characters: 17 \(15 without spaces\)\n- sentences: 2 · paragraphs: 1/);
  scripting.results.pageSelectionGet = { selected: false, editable: true, wholeField: true, kind: "input:text", label: "Subject", text: "One two", length: 7 };
  out = await runTool(T, "browser_selection_stats", { scope: "selection" });
  assert.match(out, /^Statistics of the whole text input "Subject" \(nothing is selected inside it\):\n- words: 2 /);
  scripting.results.pageSelectionGet = { selected: true, editable: false, text: "Plain words here.", length: 17, where: "p" };
  assert.match(await runTool(T, "browser_selection_stats", {}), /^Statistics of the selection in the page content:\n- words: 3 /);
  scripting.results.pageSelectionGet = { selected: false, editable: false, text: "", length: 0 };
  await assert.rejects(T.run("browser_selection_stats", {}), /Nothing is selected on the page and no text field has focus.*scope 'page'/);
  scripting.results.pageSelectionGet = { selected: false, editable: true, wholeField: true, kind: "input:password", label: "Password", text: "", length: 6, password: true };
  await assert.rejects(T.run("browser_selection_stats", {}), /password field/);

  scripting.results.pageFieldText = { ok: true, kind: "editable", label: "Body", text: "A full editor text. Two sentences." };
  out = await runTool(T, "browser_selection_stats", { scope: "field" });
  assert.match(out, /^Statistics of the whole rich-text editor "Body":\n- words: 6 · /);
  scripting.results.pageFieldText = { error: "No text field or editor has focus on the page — ask the user to click into the field, or measure the selection (scope 'selection') or the page (scope 'page')." };
  await assert.rejects(T.run("browser_selection_stats", { scope: "field" }), /No text field or editor has focus/);

  scripting.results.pageBodyText = { ok: true, text: "Page text. ".repeat(3), cut: false, title: "Docs" };
  out = await runTool(T, "browser_selection_stats", { scope: "page" });
  assert.match(out, /^Statistics of the page's visible text \(Docs\):\n- words: 6 · /);
  scripting.results.pageBodyText = { ok: true, text: "x ".repeat(5), cut: true, title: "" };
  assert.match(await runTool(T, "browser_selection_stats", { scope: "page" }), /^Statistics of the page's visible text, its first 400000 characters:/);
  assert.deepEqual(scripting.calls.map((c) => c.func), ["pageSelectionGet", "pageSelectionGet", "pageSelectionGet", "pageSelectionGet", "pageSelectionGet", "pageFieldText", "pageFieldText", "pageBodyText", "pageBodyText"]);
  assert.deepEqual(scripting.calls.at(-1).args, [X.MAX_STATS]);
});

test("replaceInText: literal and case-insensitive by default, case-sensitive, regex with groups, a literal '$1', the first changed passage; bad patterns throw", () => {
  const { X } = load();
  assert.deepEqual(plain(X.replaceInText("The cat sat on the Cat mat; a cat.", "cat", "dog", {})), { text: "The dog sat on the dog mat; a dog.", count: 3, first: "The [cat → dog] sat on the Cat mat; a cat." });
  assert.deepEqual(plain(X.replaceInText("The cat sat on the Cat mat; a cat.", "cat", "dog", { caseSensitive: true })), { text: "The dog sat on the Cat mat; a dog.", count: 2, first: "The [cat → dog] sat on the Cat mat; a cat." });
  assert.deepEqual(plain(X.replaceInText("a.b a.b axb", "a.b", "X", {})), { text: "X X axb", count: 2, first: "[a.b → X] a.b axb" }, "a literal dot is not a wildcard");
  assert.deepEqual(plain(X.replaceInText("2024-01-05 and 2025-12-31", "(\\d{4})-(\\d{2})-(\\d{2})", "$3/$2/$1", { regex: true })), { text: "05/01/2024 and 31/12/2025", count: 2, first: "[2024-01-05 → 05/01/2024] and 2025-12-31" });
  assert.deepEqual(plain(X.replaceInText("cost $1", "$1", "one", {})), { text: "cost one", count: 1, first: "cost [$1 → one]" }, "in literal mode $1 is just text");
  assert.deepEqual(plain(X.replaceInText("nothing here", "zzz", "y", {})), { text: "nothing here", count: 0, first: "" });
  assert.equal(X.replaceInText("x".repeat(100) + "needle" + "y".repeat(100), "needle", "", {}).first, "…" + "x".repeat(30) + "[needle → ]" + "y".repeat(30) + "…");
  assert.throws(() => X.replaceInText("t", "(", "r", { regex: true }), /^Error: Invalid regular expression \/\(\/: Unterminated group — fix the pattern, or pass regex=false/);
  assert.throws(() => X.replaceInText("t", "a*", "r", { regex: true }), /matches an empty string/);
  assert.throws(() => X.replaceInText("t", "", "r", {}), /find is required/);
  assert.deepEqual(plain(X.finder("a.b", {})), { source: "a\\.b", flags: "gi", literal: true });
  assert.deepEqual(plain(X.finder("a.b", { regex: true, caseSensitive: true })), { source: "a.b", flags: "g", literal: false });
});

test("browser_selection_replace_all: validates the pattern before injecting, passes the compiled pattern and scope through, reports the count, no matches and an unverified field", async () => {
  const { T, scripting } = load();
  await assert.rejects(T.run("browser_selection_replace_all", { find: "(", replace: "", regex: true }), /Invalid regular expression/);
  await assert.rejects(T.run("browser_selection_replace_all", { replace: "x" }), /find is required/);
  assert.equal(scripting.calls.length, 0, "nothing is injected for a bad pattern");

  scripting.results.pageReplaceAll = { ok: true, kind: "textarea", label: "Message", count: 3, first: "The [cat → dog] sat", verified: true };
  let out = await runTool(T, "browser_selection_replace_all", { find: "cat", replace: "dog" });
  assert.equal(out, 'Replaced 3 occurrences of "cat" with "dog" in the textarea "Message". First change: The [cat → dog] sat');
  assert.deepEqual(scripting.calls.at(-1).args, ["cat", "gi", "dog", true, false], "literal, case-insensitive, whole field by default");
  out = await runTool(T, "browser_selection_replace_all", { find: "a.b", replace: "", caseSensitive: true, scope: "selection" });
  assert.deepEqual(scripting.calls.at(-1).args, ["a\\.b", "g", "", true, true]);
  assert.match(out, /^Replaced 3 occurrences of "a\.b" \(case-sensitive\) with "" in the selection in the textarea "Message"\./);
  out = await runTool(T, "browser_selection_replace_all", { find: "(\\d+)", replace: "#$1", regex: true });
  assert.deepEqual(scripting.calls.at(-1).args, ["(\\d+)", "gi", "#$1", false, false]);
  assert.match(out, /^Replaced 3 occurrences of \/\(\\d\+\)\/ with "#\$1" in the textarea/);

  scripting.results.pageReplaceAll = { ok: true, kind: "editable", label: "Body", count: 0, first: "" };
  assert.equal(await runTool(T, "browser_selection_replace_all", { find: "zzz", replace: "y" }), 'No matches for "zzz" in the rich-text editor "Body" — nothing changed.');
  scripting.results.pageReplaceAll = { ok: true, kind: "editable", label: "Body", count: 1, first: "[a → b]", verified: false };
  assert.match(await runTool(T, "browser_selection_replace_all", { find: "a", replace: "b" }), /^Replaced 1 occurrence of "a" with "b" in the rich-text editor "Body"\. First change: \[a → b\]\nBut the field does not show the change/);
  scripting.results.pageReplaceAll = { error: "Nothing is selected inside the focused textarea — ask the user to select the part to change, or use scope 'field' for the whole value." };
  await assert.rejects(T.run("browser_selection_replace_all", { find: "a", replace: "b", scope: "selection" }), /use scope 'field'/);
  scripting.results.pageReplaceAll = { error: "No text field or editor has focus on the page — ask the user to click into the field first." };
  await assert.rejects(T.run("browser_selection_replace_all", { find: "a", replace: "b" }), /No text field or editor has focus/);
});

test("transformCase: upper, lower, title (small words lower except first/last and after a colon), sentence (first letters, i → I), slug (transliterated), plain (whitespace and quotes tidied)", () => {
  const { X } = load();
  const t = X.transformCase;
  assert.deepEqual(plain(X.MODES), ["upper", "lower", "title", "sentence", "slug", "plain"]);
  assert.equal(t("MiXed Case ß", "upper"), "MIXED CASE SS");
  assert.equal(t("MiXed Case É", "lower"), "mixed case é");
  assert.equal(t("the war of the worlds: a story for all", "title"), "The War of the Worlds: A Story for All");
  assert.equal(t("step-by-step guide to the end", "title"), "Step-by-Step Guide to the End", "hyphenated parts are words of their own");
  assert.equal(t("DON'T PANIC\nin the beginning", "title"), "Don't Panic\nIn the Beginning", "per line, the rest of a word lowered");
  assert.equal(t("HELLO WORLD. this is it! i think i’m fine, i said.\n\"quoted\" start", "sentence"), "Hello world. This is it! I think I’m fine, I said.\n\"Quoted\" start");
  assert.equal(t("e.g. prices rose 3.5 percent", "sentence"), "E.g. Prices rose 3.5 percent", "a known cost: 'e.g.' ends a sentence, '3.5' does not");
  assert.equal(t("Crème brûlée & Co — Straße/Øl  “quoted”", "slug"), "creme-brulee-and-co-strasse-ol-quoted");
  assert.equal(t("  Hello  World! It's 100% ", "slug"), "hello-world-its-100");
  assert.equal(t("  Hello “world”   it’s   me  \n\n\n\nnext  ", "plain"), " Hello \"world\" it's me\n\nnext ", "runs collapsed, one empty line at most, nothing trimmed");
  assert.equal(t("zero​width soft­hyphen", "plain"), "zerowidth softhyphen");
  assert.equal(t("", "upper"), "");
  assert.equal(t(null, "slug"), "");
  assert.throws(() => t("x", "camel"), /^Error: mode is required — one of upper, lower, title, sentence, slug, plain\./);
  assert.equal(X.titleCase("a tale of two cities"), "A Tale of Two Cities");
  assert.equal(X.slugify("Ærø & Łódź"), "aero-and-lodz");
});

test("browser_selection_case: reads the selection, transforms it and writes it back like browser_selection_replace; an unchanged text injects nothing more", async () => {
  const { T, scripting } = load();
  scripting.results.pageSelectionGet = { selected: true, editable: true, kind: "textarea", label: "Subject", text: "the quick brown fox", length: 19 };
  scripting.results.pageSelectionReplace = (newText, wholeField) => ({ ok: true, verified: true, kind: "textarea", label: "Subject", replaced: 19, wholeField, now: newText });
  let out = await runTool(T, "browser_selection_case", { mode: "title" });
  assert.equal(out, 'Changed the selection in the textarea "Subject" to title case: 19 → 19 chars, now "The Quick Brown Fox"; the new text is left selected in the field.');
  assert.deepEqual(scripting.calls.map((c) => [c.func, c.args]), [["pageSelectionGet", []], ["pageSelectionReplace", ["The Quick Brown Fox", false]]]);

  // Nothing selected but a field focused: the whole value, written back with wholeField=true.
  scripting.calls.length = 0;
  scripting.results.pageSelectionGet = { selected: false, wholeField: true, editable: true, kind: "input:text", label: "Slug", text: "Crème Brûlée & Co", length: 17 };
  out = await runTool(T, "browser_selection_case", { mode: "slug" });
  assert.match(out, /^Changed the whole text input "Slug" to a slug: 17 → 19 chars, now "creme-brulee-and-co"/);
  assert.deepEqual(scripting.calls.at(-1).args, ["creme-brulee-and-co", true]);

  // Already in that case: no write.
  scripting.calls.length = 0;
  scripting.results.pageSelectionGet = { selected: true, editable: true, kind: "textarea", label: "Subject", text: "ALL CAPS", length: 8 };
  assert.equal(await runTool(T, "browser_selection_case", { mode: "upper" }), 'Nothing changed: the selection in the textarea "Subject" is already upper case.');
  assert.deepEqual(scripting.calls.map((c) => c.func), ["pageSelectionGet"]);

  // "plain" in a rich-text editor puts the same text back (that strips the formatting); in a field it tidies the text.
  scripting.calls.length = 0;
  scripting.results.pageSelectionGet = { selected: true, editable: true, kind: "editable", label: "Body", text: "Bold  and “quoted”", length: 18 };
  scripting.results.pageSelectionReplace = (newText) => ({ ok: true, verified: true, kind: "editable", label: "Body", replaced: 18, now: newText });
  out = await runTool(T, "browser_selection_case", { mode: "plain" });
  assert.match(out, /^Changed the selection in the rich-text editor "Body" to plain text: 18 → 18 chars/);
  assert.deepEqual(scripting.calls.at(-1).args, ["Bold  and “quoted”", false], "the editor's text as it is, as plain text");
  scripting.results.pageSelectionGet = { selected: true, editable: true, kind: "textarea", label: "Body", text: "Bold  and “quoted”", length: 18 };
  scripting.results.pageSelectionReplace = (newText) => ({ ok: true, verified: true, kind: "textarea", label: "Body", replaced: 18, now: newText });
  await runTool(T, "browser_selection_case", { mode: "plain" });
  assert.deepEqual(scripting.calls.at(-1).args, ['Bold and "quoted"', false]);

  // The field does not show the result: the text is handed over for the chat.
  scripting.results.pageSelectionReplace = { ok: true, verified: false, kind: "textarea", label: "Body", replaced: 18, now: "Bold  and “quoted”" };
  out = await runTool(T, "browser_selection_case", { mode: "upper" });
  assert.match(out, /^Put the text in upper case into the selection in the textarea "Body", but the field does not show it \(it holds: "Bold and “quoted”"\)\. .*paste it:\nBOLD  AND “QUOTED”$/, "the preview of what the field holds is collapsed to one line");
});

test("browser_selection_case: scope field reads the whole field and replaces all of it; refusals (page content, password, nothing, empty, bad mode) inject nothing further", async () => {
  const { T, scripting } = load();
  scripting.results.pageFieldText = { ok: true, kind: "textarea", label: "Message", text: "hello there. how are you? i am fine" };
  scripting.results.pageFieldReplace = (newText) => ({ ok: true, verified: true, kind: "textarea", label: "Message", replaced: 35, now: newText });
  const out = await runTool(T, "browser_selection_case", { mode: "sentence", scope: "field" });
  assert.equal(out, 'Changed the whole textarea "Message" to sentence case: 35 → 35 chars, now "Hello there. How are you? I am fine"; the new text is left selected in the field.');
  assert.deepEqual(scripting.calls.map((c) => [c.func, c.args]), [["pageFieldText", []], ["pageFieldReplace", ["Hello there. How are you? I am fine"]]]);
  scripting.results.pageFieldText = { error: "No text field or editor has focus on the page — ask the user to click into the field, or measure the selection (scope 'selection') or the page (scope 'page')." };
  await assert.rejects(T.run("browser_selection_case", { mode: "upper", scope: "field" }), /No text field or editor has focus/);

  scripting.calls.length = 0;
  scripting.results.pageSelectionGet = { selected: true, editable: false, text: "some article text", length: 17, where: "p" };
  await assert.rejects(T.run("browser_selection_case", { mode: "title" }), /not in an editable field.*Show it in the chat instead — in title case:\nSome Article Text$/s);
  scripting.results.pageSelectionGet = { selected: false, editable: true, wholeField: true, kind: "input:password", label: "Password", text: "", length: 6, password: true };
  await assert.rejects(T.run("browser_selection_case", { mode: "upper" }), /password field — it is never edited/);
  scripting.results.pageSelectionGet = { selected: false, editable: false, text: "", length: 0 };
  await assert.rejects(T.run("browser_selection_case", { mode: "upper" }), /Nothing is selected on the page and no text field has focus/);
  scripting.results.pageSelectionGet = { selected: false, editable: true, wholeField: true, kind: "textarea", label: "Message", text: "   ", length: 3 };
  await assert.rejects(T.run("browser_selection_case", { mode: "upper" }), /Nothing to change: the whole textarea "Message" is empty\./);
  assert.deepEqual(scripting.calls.map((c) => c.func), ["pageSelectionGet", "pageSelectionGet", "pageSelectionGet", "pageSelectionGet"], "no write for a refusal");
  await assert.rejects(T.run("browser_selection_case", { mode: "camel" }), /mode is required — one of upper, lower, title, sentence, slug, plain/);
  await assert.rejects(T.run("browser_selection_case", {}), /mode is required/);
  assert.equal(scripting.calls.length, 4, "a bad mode injects nothing");
});
