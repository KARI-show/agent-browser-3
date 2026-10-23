// Fakes for unit-testing an extra's runtime (browser/extras/<id>.js) in node: a chrome with
// storage.local / tabs / scripting (executeScript answers by the injected function's name), the
// AgentBrowserTools registry with its helpers and run(), an AgentExtras registry, the brand flag,
// and a tiny DOM stand-in for the 🧩 tab's ctx.el. Same approach as tests/automation.test.mjs.
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const plain = (x) => JSON.parse(JSON.stringify(x));

export function fakeChrome() {
  const data = {};
  const listeners = [];
  // scripting.results[funcName] = value | async (…args) => value — what the injected function "returns".
  const scripting = { results: {}, calls: [] };
  const chrome = {
    storage: {
      local: {
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
      },
      onChanged: { addListener: (fn) => listeners.push(fn) },
    },
    tabs: {
      current: { id: 7, url: "https://mail.example/compose", title: "Compose", windowId: 1, active: true },
      async query() { return [chrome.tabs.current]; },
      async get(id) { return { ...chrome.tabs.current, id }; },
    },
    scripting: {
      async executeScript(o) {
        const name = o.func.name;
        scripting.calls.push({ func: name, args: plain(o.args || []), world: o.world, target: o.target });
        const r = scripting.results[name];
        if (r === undefined) throw new Error(`fake executeScript: no result prepared for ${name}`);
        return [{ result: typeof r === "function" ? await r(...(o.args || [])) : plain(r) }];
      },
    },
    runtime: { getURL: (p) => "chrome-extension://abc/" + p },
  };
  return { chrome, data, scripting };
}

/** AgentBrowserTools as browserTools.js exposes it to the extras, over the fake chrome. */
export function fakeTools(chrome) {
  const registered = {};
  const calls = [];
  const T = {
    register(name, fn) {
      if (registered[name]) throw new Error("Browser tool already defined: " + name);
      registered[name] = fn;
    },
    helpers: {
      currentTab: async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0],
      async inTop(func, args, world) {
        const tab = await T.helpers.currentTab();
        const results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func, args: args || [], world: world || "ISOLATED" });
        const r = results && results[0] ? results[0].result : undefined;
        if (r && r.error) throw new Error(r.error);
        return r;
      },
      async inAllFrames(func, args) {
        const tab = await T.helpers.currentTab();
        return chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func, args: args || [], world: "ISOLATED" });
      },
      snapshot: async () => ({ text: "", lines: [], top: { url: chrome.tabs.current.url }, frames: [] }),
      sleep: async () => {},
      text: (t) => [{ type: "text", text: t }],
      ownPage: () => false,
    },
    outputs: {}, // base tool name -> text it "returns"
    failOn: null, // base tool name that throws
    calls,
    registered,
    async run(name, args) {
      calls.push({ name, args: plain(args || {}) });
      if (registered[name]) return registered[name](args || {});
      if (T.failOn === name) throw new Error("boom: " + name);
      return [{ type: "text", text: T.outputs[name] || "ok " + name }];
    },
    get names() { return Object.keys(registered); },
  };
  return T;
}

/** A minimal DOM for the tab's ctx.el: nodes with props, children, listeners, textContent, value. */
export function fakeDom() {
  function node(tag) {
    const n = {
      tag, props: {}, children: [], listeners: {}, _text: null,
      get textContent() { return this._text !== null ? this._text : this.children.map((c) => (typeof c === "string" ? c : c.textContent)).join(""); },
      set textContent(v) { this.children = []; this._text = String(v); },
      appendChild(c) { this._text = null; this.children.push(c); return c; },
      addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
      click() { (this.listeners.click || []).forEach((fn) => fn({ stopPropagation() {} })); },
      focus() {},
      get value() { return this.props.value === undefined ? "" : this.props.value; },
      set value(v) { this.props.value = v; },
      /** Every descendant node matching pred, depth first. */
      find(pred, out = []) { for (const c of this.children) if (typeof c !== "string") { if (pred(c)) out.push(c); c.find(pred, out); } return out; },
      /** The whole text of the subtree (what a user would read). */
      get allText() { return this._text !== null ? this._text : this.children.map((c) => (typeof c === "string" ? c : c.allText)).join("\n"); },
    };
    return n;
  }
  function el(tag, props, children) {
    const n = node(tag);
    if (props) for (const k of Object.keys(props)) { if (k.indexOf("on") === 0) n.addEventListener(k.slice(2), props[k]); else n.props[k] = props[k]; }
    (children || []).forEach((c) => { if (c != null) n.appendChild(c); });
    return n;
  }
  return { el, node };
}

/** The ctx automations.js hands an extra's render(): records status lines and sent prompts. */
export function fakeCtx(dom) {
  const ctx = {
    el: dom.el,
    field: (label, input) => dom.el("label", { className: "ed-label" }, [label, input]),
    ago: () => "just now",
    hostOf: (u) => { try { return new URL(u).hostname; } catch (_) { return u; } },
    statuses: [],
    prompts: [],
    rerenders: 0,
    status(text, kind) { ctx.statuses.push({ text, kind }); },
    sendPrompt(text) { ctx.prompts.push(text); },
    currentTabUrl: async () => "https://mail.example/compose",
    rerender() { ctx.rerenders++; },
  };
  return ctx;
}

/**
 * Load browser/extras/<id>.js in a vm against the fakes. `features` is the brand's feature map
 * (default: only this extra on). Returns the fakes, the tab and the commands the module added.
 */
export function loadExtra(id, { features } = {}) {
  const f = fakeChrome();
  const T = fakeTools(f.chrome);
  const AgentExtras = { tabs: [], commands: [] };
  const feats = features || { [id]: true };
  const AGENT_BRAND = { shortName: "Test", features: feats, has: (x) => feats[x] === true };
  const copied = [];
  const context = vm.createContext({
    chrome: f.chrome, AgentBrowserTools: T, AgentExtras, AGENT_BRAND, console, setTimeout, clearTimeout,
    confirm: () => true,
    navigator: { clipboard: { async writeText(t) { copied.push(t); } } },
  });
  const file = fileURLToPath(new URL(`../../browser/extras/${id}.js`, import.meta.url));
  vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: `${id}.js` });
  const tab = AgentExtras.tabs.find((t) => t.id === id);
  return { ...f, T, AgentExtras, X: AgentExtras[id], tab, commands: AgentExtras.commands, copied, context };
}

/** Run a registered tool and return its text. */
export async function runTool(T, name, args) {
  const out = await T.run(name, args);
  return out.filter((p) => p.type === "text").map((p) => p.text).join("\n");
}
