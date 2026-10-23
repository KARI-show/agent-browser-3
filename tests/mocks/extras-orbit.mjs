// Shared fakes for the Orbit extras' unit tests (tests/clips.test.mjs, tests/sessions.test.mjs): the
// module is loaded with vm against a fake chrome.*, a stand-in for the AgentBrowserTools registry and
// an empty AgentExtras, exactly as extras.js finds them in the side panel; the 🧩 tab's render() is
// exercised against a tiny DOM stand-in that records what was built (no jsdom needed).
import fs from "node:fs";
import vm from "node:vm";

export const plain = (x) => JSON.parse(JSON.stringify(x));
export const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

/** chrome.storage.local over a plain object; the `data` object is the store itself. */
export function fakeStorage() {
  const data = {};
  const listeners = [];
  const local = {
    async get(keys) {
      const ks = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(data);
      const out = {};
      for (const k of ks) if (k in data) out[k] = plain(data[k]);
      return out;
    },
    async set(items) {
      Object.assign(data, plain(items));
      listeners.forEach((fn) => fn(items, "local"));
    },
    async remove(keys) {
      for (const k of [].concat(keys)) delete data[k];
    },
  };
  return { data, storage: { local, onChanged: { addListener: (fn) => listeners.push(fn) } } };
}

/** The registry the module registers its tools into, with the helpers it reads off AgentBrowserTools. */
export function fakeTools(helpers) {
  const tools = {};
  const T = {
    tools,
    switched: [],
    register(name, fn) {
      if (tools[name]) throw new Error("Browser tool already defined: " + name);
      tools[name] = fn;
    },
    helpers: { text: (t) => [{ type: "text", text: t }], sleep: () => Promise.resolve(), ...helpers },
    setCurrentTab(id) { T.switched.push(id); },
  };
  return T;
}

/** Run a browser/extras/<id>.js file in a vm context built from `globals`; returns the context. */
export function loadExtra(file, globals) {
  const context = vm.createContext({ console, URL, ...globals });
  vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
  return context;
}

/** The text parts of a tool's result joined, as the model would read them. */
export const outText = (parts) => parts.filter((p) => p.type === "text").map((p) => p.text).join("\n");

// ── A DOM stand-in for render(content, ctx) ────────────────────────────────

class FakeNode {
  constructor(tag, props) {
    this.tag = tag;
    this.className = "";
    this.children = [];
    this.listeners = {};
    Object.assign(this, props || {});
    if (props && props.className) this.className = props.className;
    if (props && props.onclick) this.listeners.click = [props.onclick];
  }
  /** Assigning textContent replaces the subtree, as in the DOM (render() clears the list with it). */
  get textContent() { return this.texts().join(""); }
  set textContent(v) { this.children = v ? [String(v)] : []; }
  appendChild(c) { this.children.push(c); return c; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  /** Fire the handlers of an event, like a user would. */
  fire(type, ev) { (this.listeners[type] || []).forEach((fn) => fn({ stopPropagation() {}, key: "", ...ev })); }
  /** Every string in this subtree, in document order. */
  texts() {
    const out = [];
    const walk = (n) => { for (const c of n.children) typeof c === "string" ? out.push(c) : walk(c); };
    walk(this);
    return out;
  }
  text() { return this.texts().join(" "); }
  /** Depth-first search for the first node matching `pred`. */
  find(pred) {
    for (const c of this.children) {
      if (typeof c === "string") continue;
      if (pred(c)) return c;
      const hit = c.find(pred);
      if (hit) return hit;
    }
    return null;
  }
  findAll(pred) {
    const out = [];
    const walk = (n) => { for (const c of n.children) if (typeof c !== "string") { if (pred(c)) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  /** The button whose label starts with `label` (icon included), or by its title. */
  button(label) {
    return this.find((n) => n.tag === "button" && (n.texts().join("").startsWith(label) || n.title === label));
  }
  byClass(cls) { return this.findAll((n) => n.className.split(/\s+/).includes(cls)); }
}

/** el(tag, props, children) like automations.js's, plus the ctx the 🧩 panel passes to an extra's render. */
export function fakeDom() {
  const el = (tag, props, children) => {
    const n = new FakeNode(tag, props);
    (children || []).forEach((c) => { if (c != null) n.appendChild(c); });
    return n;
  };
  const content = new FakeNode("div", { className: "cmd-list" });
  const statuses = [];
  const prompts = [];
  let renders = 0;
  const ctx = {
    el,
    field: (label, input) => el("label", { className: "ed-label" }, [label, input]),
    ago: () => "just now",
    hostOf: (url) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch (_) { return url || ""; } },
    status: (text, kind) => statuses.push({ text, kind }),
    sendPrompt: (text) => prompts.push(text),
    currentTabUrl: async () => "https://b.example/two?x=1",
    rerender: () => { renders++; },
  };
  return { el, content, ctx, statuses, prompts, renders: () => renders, FakeNode };
}
