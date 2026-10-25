// Fakes for unit-testing the Palette brand's extras (tests/styles.test.mjs, tests/palette.test.mjs) in
// node: a chrome with storage.local (+ onChanged) / tabs / scripting (executeScript answers by the
// injected function's name and records the call; registerContentScripts is recorded), the
// AgentBrowserTools registry with its helpers (refTarget included) and run(), an AgentExtras registry,
// the brand flag, a tiny DOM stand-in for the 🧩 tab's ctx.el — and a fake document + MutationObserver
// for the content script (browser/extras/styles.cs.js). Same approach as tests/mocks/extras-quill.mjs.
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

export const plain = (x) => JSON.parse(JSON.stringify(x));
export const settle = (ms = 15) => new Promise((r) => setTimeout(r, ms));

export function fakeChrome({ url = "https://www.example.com/page?x=1" } = {}) {
  const data = {};
  const listeners = [];
  // scripting.results[funcName] = value | (…args) => value — what the injected function "returns".
  const scripting = { results: {}, calls: [], registered: [], fail: null };
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
          const changes = {};
          for (const k of Object.keys(items)) { changes[k] = { oldValue: data[k] === undefined ? undefined : plain(data[k]), newValue: plain(items[k]) }; data[k] = plain(items[k]); }
          listeners.forEach((fn) => fn(changes, "local"));
        },
        async remove(keys) {
          for (const k of [].concat(keys)) delete data[k];
        },
      },
      onChanged: { addListener: (fn) => listeners.push(fn), listeners },
    },
    tabs: {
      current: { id: 7, url, title: "Example", windowId: 1, active: true },
      async query() { return [chrome.tabs.current]; },
      async get(id) { return { ...chrome.tabs.current, id }; },
    },
    scripting: {
      async executeScript(o) {
        const name = o.func.name;
        scripting.calls.push({ func: name, args: plain(o.args || []), world: o.world, target: o.target });
        if (scripting.fail) throw new Error(scripting.fail);
        const r = scripting.results[name];
        if (r === undefined) return [{ result: { ok: true } }];
        return [{ result: typeof r === "function" ? await r(...(o.args || [])) : plain(r) }];
      },
      async getRegisteredContentScripts({ ids } = {}) {
        return scripting.registered.filter((s) => !ids || ids.includes(s.id));
      },
      async registerContentScripts(list) {
        for (const s of list) {
          if (scripting.registered.some((x) => x.id === s.id)) throw new Error("Duplicate script ID '" + s.id + "'");
          scripting.registered.push(plain(s));
        }
      },
    },
    runtime: { getURL: (p) => "chrome-extension://abc/" + p },
  };
  return { chrome, data, scripting, listeners };
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
    refs: {}, // ref -> { documentId, local, loc } (what the last snapshot would hold)
    helpers: {
      currentTab: async () => { if (T.noTab) throw new Error("No active tab in this window."); return (await chrome.tabs.query({ active: true, currentWindow: true }))[0]; },
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
      refTarget: (ref) => T.refs[ref] || null,
    },
    calls,
    registered,
    async run(name, args) {
      calls.push({ name, args: plain(args || {}) });
      if (registered[name]) return registered[name](args || {});
      return [{ type: "text", text: "ok " + name }];
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
      get className() { return this.props.className || ""; },
      get disabled() { return !!this.props.disabled; },
      set disabled(v) { this.props.disabled = v; },
      /** Every descendant node matching pred, depth first. */
      find(pred, out = []) { for (const c of this.children) if (typeof c !== "string") { if (pred(c)) out.push(c); c.find(pred, out); } return out; },
      /** The button whose label starts with `label`, or by its title. */
      button(label) { return this.find((n) => n.tag === "button" && (n.textContent.startsWith(label) || n.props.title === label))[0]; },
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
export function fakeCtx(dom, { url = "https://www.example.com/page?x=1" } = {}) {
  const ctx = {
    el: dom.el,
    field: (label, input) => dom.el("label", { className: "ed-label" }, [label, input]),
    ago: () => "just now",
    hostOf: (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (_) { return u; } },
    statuses: [],
    prompts: [],
    rerenders: 0,
    status(text, kind) { ctx.statuses.push({ text, kind }); },
    sendPrompt(text) { ctx.prompts.push(text); },
    currentTabUrl: async () => url,
    rerender() { ctx.rerenders++; },
  };
  return ctx;
}

/**
 * Load browser/extras/styles.js and palette.js (in that order, as extras.js concatenates them) in a vm
 * against the fakes. `features` is the brand's feature map (default: both on). `globals` adds to the
 * context (e.g. a fake CSSStyleSheet). Returns the fakes, the extras' exported helpers and the tabs.
 */
export function loadExtras({ features, globals, url, ids = ["styles", "palette"] } = {}) {
  const f = fakeChrome({ url });
  const T = fakeTools(f.chrome);
  const AgentExtras = { tabs: [], commands: [] };
  const feats = features || { styles: true, palette: true };
  const AGENT_BRAND = { shortName: "Test", features: feats, has: (x) => feats[x] === true };
  const copied = [];
  const warnings = [];
  const context = vm.createContext({
    chrome: f.chrome, AgentBrowserTools: T, AgentExtras, AGENT_BRAND, setTimeout, clearTimeout, URL, Date, Math, JSON,
    console: { ...console, warn: (...a) => warnings.push(a.join(" ")) },
    confirm: () => true,
    navigator: { clipboard: { async writeText(t) { copied.push(t); } } },
    ...(globals || {}),
  });
  for (const id of ids) {
    const file = fileURLToPath(new URL(`../../browser/extras/${id}.js`, import.meta.url));
    vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: `${id}.js` });
  }
  return { ...f, T, AgentExtras, S: AgentExtras.styles, P: AgentExtras.palette, tabs: AgentExtras.tabs, commands: AgentExtras.commands, copied, warnings, context };
}

/** Run a registered tool and return its text. */
export async function runTool(T, name, args) {
  const out = await T.run(name, args);
  return out.filter((p) => p.type === "text").map((p) => p.text).join("\n");
}

// ── A document stand-in for the content script ──────────────────────────────

class FakeElement {
  constructor(tag, doc) { this.tag = tag; this.doc = doc; this.attrs = {}; this.children = []; this.parentNode = null; this.textContent = ""; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  hasAttribute(k) { return k in this.attrs; }
  appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); this.doc._mutated(this); return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i !== -1) this.children.splice(i, 1); c.parentNode = null; this.doc._mutated(this); return c; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  get lastElementChild() { return this.children[this.children.length - 1] || null; }
  get nextElementSibling() { if (!this.parentNode) return null; const s = this.parentNode.children; return s[s.indexOf(this) + 1] || null; }
  get previousElementSibling() { if (!this.parentNode) return null; const s = this.parentNode.children; return s[s.indexOf(this) - 1] || null; }
  /** Depth-first search over this subtree for "style[attr]"-style selectors used by the scripts. */
  query(pred) { for (const c of this.children) { if (pred(c)) return c; const r = c.query(pred); if (r) return r; } return null; }
}

/**
 * A document with <html> (and <head> unless withHead is false — add it later with doc.addHead()),
 * createElement, querySelector for "style[data-…]" and a MutationObserver stub whose callbacks fire
 * synchronously after a childList change of an observed node (close enough to the real microtask).
 */
export function fakeDocument({ withHead = true } = {}) {
  const observers = [];
  const doc = {
    documentElement: null, head: null, body: null, observers,
    createElement(tag) { return new FakeElement(tag, doc); },
    querySelector(sel) {
      const m = /^(\w+)\[([\w-]+)\]$/.exec(sel);
      if (!m) throw new Error("fake querySelector only supports tag[attr]: " + sel);
      return doc.documentElement.query((n) => n.tag === m[1] && n.hasAttribute(m[2]));
    },
    // Like the real thing, records are delivered in a microtask (one callback per observer per tick), so a
    // move (remove + append) never re-enters the observer's callback half-way.
    _mutated(node) { for (const o of observers) if (o.target === node && !o.disconnected && !o.pending) { o.pending = true; queueMicrotask(() => { o.pending = false; if (!o.disconnected) o.fire(); }); } },
    addHead() { const h = new FakeElement("head", doc); doc.documentElement.appendChild(h); doc.head = h; return h; },
  };
  doc.documentElement = new FakeElement("html", doc);
  if (withHead) doc.addHead();
  doc.body = new FakeElement("body", doc);
  doc.documentElement.appendChild(doc.body);
  class MutationObserver {
    constructor(cb) { this.cb = cb; this.target = null; this.disconnected = false; observers.push(this); }
    observe(target, opts) { this.target = target; this.opts = opts; }
    disconnect() { this.disconnected = true; }
    fire() { this.cb([{ type: "childList" }], this); }
  }
  return { doc, MutationObserver, observers };
}

/**
 * Load browser/extras/styles.cs.js the way a page would: a `chrome` with storage (shared `data`
 * object, so a panel-side fake can write what the content script reads), a fake document and
 * location. Returns the document, the exported AgentSiteStyles helpers and a way to fire storage changes.
 */
export function loadContentScript({ hostname = "www.example.com", data = {}, withHead = true, manual = false } = {}) {
  const listeners = [];
  const chrome = {
    storage: {
      local: {
        async get(keys) { const ks = typeof keys === "string" ? [keys] : keys; const out = {}; for (const k of ks) if (k in data) out[k] = plain(data[k]); return out; },
        async set(items) { const changes = {}; for (const k of Object.keys(items)) { changes[k] = { oldValue: data[k], newValue: plain(items[k]) }; data[k] = plain(items[k]); } listeners.forEach((fn) => fn(changes, "local")); },
      },
      onChanged: { addListener: (fn) => listeners.push(fn) },
    },
  };
  const { doc, MutationObserver, observers } = fakeDocument({ withHead });
  const context = vm.createContext({ chrome, document: doc, location: { hostname }, MutationObserver, console, __agentSiteStylesManual: manual });
  const file = fileURLToPath(new URL("../../browser/extras/styles.cs.js", import.meta.url));
  vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: "styles.cs.js" });
  return { chrome, doc, observers, data, api: context.AgentSiteStyles, MutationObserver, change: (newValue) => chrome.storage.local.set({ agentSiteStyles: newValue }) };
}

/** The agent's <style> element in a fake document (or null). */
export const styleEl = (doc) => doc.querySelector("style[data-agent-styles]");
