// The skills extra's panel module (browser/extras/skills.js) against fakes: the two tools over a
// skills.json, name matching, the quick commands each playbook brings, and the 🎓 tab's DOM.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const SKILLS_JS = fileURLToPath(new URL("../browser/extras/skills.js", import.meta.url));
const PLAYBOOKS = [
  { name: "design-review", title: "Design review", summary: "Review a page like a senior designer.", when: "asked for feedback", command: "Review this page like a designer", prompt: 'Read the "design-review" playbook and review.', icon: "🔍", body: "# Design review\n\n## Process\n\n1. Look first.\n\n- [ ] Done" },
  { name: "typography", title: "Typography", summary: "Numbers that make text read well.", when: "text is hard to read", command: "Fix the typography on this page", prompt: 'Read the "typography" playbook.', icon: "", body: "# Typography\n\nBody 16–18px." },
];
const settle = () => new Promise((r) => setTimeout(r, 5));

function fakeEl(tag, props, children) {
  const n = { tag, props: props || {}, children: [], className: (props && props.className) || "", classList: null, listeners: {} };
  n.classList = { toggle(c) { n.className = n.className.includes(c) ? n.className.replace(c, "").trim() : (n.className + " " + c).trim(); }, contains(c) { return n.className.split(/\s+/).includes(c); } };
  n.appendChild = (c) => { n.children.push(c); return c; };
  n.addEventListener = (ev, fn) => { n.listeners[ev] = fn; };
  (children || []).forEach((c) => { if (c != null) n.children.push(typeof c === "string" ? { text: c } : c); });
  if (props && props.onclick) n.listeners.click = props.onclick;
  return n;
}
const textOf = (n) => (n.text !== undefined ? n.text : n.children.map(textOf).join(" ")) || "";

function load({ json = PLAYBOOKS, ok = true, has = true, commands = [] } = {}) {
  const registered = {};
  const fetched = [];
  const context = vm.createContext({
    console,
    AGENT_BRAND: { has: (f) => has && f === "skills" },
    AgentBrowserTools: { register: (name, fn) => { registered[name] = fn; }, helpers: { text: (t) => [{ type: "text", text: t }] } },
    AgentExtras: { tabs: [], commands },
    chrome: { runtime: { getURL: (p) => "chrome-extension://abc/" + p } },
    fetch: async (url) => { fetched.push(url); return { ok, json: async () => json }; },
  });
  vm.runInContext(fs.readFileSync(SKILLS_JS, "utf8"), context, { filename: SKILLS_JS });
  return { registered, fetched, extras: context.AgentExtras };
}
const out = (parts) => parts.map((p) => p.text).join("\n");

test("skills: list and read serve the build's playbooks to the model; unknown names list what exists", async () => {
  const { registered, fetched } = load();
  assert.deepEqual(Object.keys(registered).sort(), ["browser_skill_list", "browser_skill_read"]);
  const list = out(await registered.browser_skill_list({}));
  assert.match(list, /^Playbooks \(2\)/);
  assert.match(list, /- design-review — Design review: Review a page like a senior designer\. Use when: asked for feedback/);
  assert.match(list, /- typography — Typography/);
  const read = out(await registered.browser_skill_read({ name: "design-review" }));
  assert.match(read, /^# Design review \(design-review\)\n\n# Design review\n\n## Process/);
  // Tolerant matching: case, spaces, underscores, a .md suffix.
  for (const n of ["Design Review", "design_review", "design-review.md", " DESIGN-REVIEW "]) assert.match(out(await registered.browser_skill_read({ name: n })), /\(design-review\)/, n);
  await assert.rejects(registered.browser_skill_read({ name: "nope" }), /No playbook "nope"\. Available: design-review, typography/);
  await settle();
  assert.equal(fetched.filter((u) => u.endsWith("/skills.json")).length, 1, "skills.json is fetched once and cached");
});

test("skills: each playbook with a command becomes a Design quick command; the 🎓 tab lists them with Apply and Read", async () => {
  const { extras } = load();
  await settle();
  assert.deepEqual(extras.commands.map((c) => [c.group, c.icon, c.name]), [["Design", "🔍", "Review this page like a designer"], ["Design", "🎓", "Fix the typography on this page"]]);
  assert.equal(extras.commands[0].prompt, 'Read the "design-review" playbook and review.');
  const tab = extras.tabs.find((t) => t.id === "skills");
  assert.ok(tab && tab.label === "🎓 Skills");
  const content = fakeEl("div");
  const sent = [];
  await tab.render(content, { el: fakeEl, sendPrompt: (t) => sent.push(t) });
  const items = content.children.filter((c) => c.className === "cmd-item");
  assert.equal(items.length, 2);
  assert.match(textOf(items[0]), /Design review/);
  assert.match(textOf(items[0]), /Use when: asked for feedback/);
  const actions = items[0].children.find((c) => c.className === "prof-actions column");
  const apply = actions.children.find((c) => c.className === "prof-btn primary");
  apply.listeners.click({ stopPropagation() {} });
  assert.deepEqual(sent, ['Read the "design-review" playbook and review.']);
  // The body is folded until read; the fold is a pre so the Markdown stays as written.
  const body = items[0].children.find((c) => c.className === "cmd-body wide").children.find((c) => c.tag === "pre");
  assert.ok(body.className.includes("hidden"));
  assert.match(textOf(body), /## Process/);
});

test("skills: a command another extra already offers under the same name is upgraded with the playbook's prompt, not duplicated", async () => {
  const own = { group: "Design", icon: "🔤", name: "Fix the typography on this page", prompt: "Inspect the type and fix it." };
  const { extras } = load({ commands: [own] });
  await settle();
  assert.deepEqual(extras.commands.map((c) => c.name), ["Fix the typography on this page", "Review this page like a designer"]);
  assert.equal(extras.commands[0], own, "the same object, so a panel holding a reference sees the change");
  assert.equal(own.prompt, 'Read the "typography" playbook.');
  assert.equal(own.icon, "🔤", "the extra's icon stays");
  assert.equal(own.playbook, "typography");
});

test("skills: a build without skills.json, and a brand without the extra", async () => {
  const { registered } = load({ ok: false });
  await assert.rejects(registered.browser_skill_list({}), /skills\.json is missing/);
  const off = load({ has: false });
  assert.deepEqual(Object.keys(off.registered), []);
  assert.deepEqual(off.extras.tabs, []);
});
