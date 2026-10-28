// Fakes for unit-testing the Stencil extras (tests/elements.test.mjs, tests/overlay.test.mjs) in node:
// a chrome with storage.local (promise and callback forms, onChanged) / tabs / windows (get, update recorded) / scripting (executeScript
// answers by the injected function's name, or records a file injection; content-script registration is
// recorded), the AgentBrowserTools registry with its helpers (refTarget included) and run(), an
// AgentExtras registry, the brand flag — and a small DOM: enough of the DOM API (createElement, template
// innerHTML through a mini HTML parser, querySelector/querySelectorAll over a mini selector engine,
// attributes, classList, style, insertAdjacentElement, textContent/innerHTML) for the content script, the
// sanitiser and the 🧩 tab's ctx.el to run against, without jsdom.
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

export const plain = (x) => JSON.parse(JSON.stringify(x));
export const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

// ── chrome.* ──────────────────────────────────────────────────────────────

export function fakeChrome() {
  const data = {};
  const listeners = [];
  // scripting.results[funcName] = value | (…args) => value — what the injected function "returns".
  const scripting = { results: {}, calls: [], files: [], registered: [] };
  const chrome = {
    storage: {
      local: {
        get(keys, cb) {
          const ks = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(data);
          const out = {};
          for (const k of ks) if (k in data) out[k] = plain(data[k]);
          if (typeof cb === "function") { Promise.resolve().then(() => cb(out)); return undefined; }
          return Promise.resolve(out);
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
      onChanged: { addListener: (fn) => listeners.push(fn) },
    },
    tabs: {
      current: { id: 7, url: "https://www.example.com/page", title: "Example", windowId: 1, active: true },
      async query() { return [chrome.tabs.current]; },
      async get(id) { return { ...chrome.tabs.current, id }; },
    },
    // windows.list[id] is the window as chrome.windows.get returns it; update() changes it in place and records the call.
    windows: {
      list: { 1: { id: 1, type: "normal", state: "normal", left: 10, top: 20, width: 1600, height: 1000, focused: true } },
      updates: [],
      async get(id) { const w = chrome.windows.list[id]; if (!w) throw new Error("No window with id: " + id + "."); return plain(w); },
      async getCurrent() { return plain(chrome.windows.list[1]); },
      async update(id, info) { const w = chrome.windows.list[id]; if (!w) throw new Error("No window with id: " + id + "."); chrome.windows.updates.push({ id, info: plain(info) }); Object.assign(w, info); return plain(w); },
    },
    scripting: {
      async executeScript(o) {
        if (o.files) { scripting.files.push({ files: o.files, target: o.target }); return [{ result: undefined }]; }
        const name = o.func.name;
        scripting.calls.push({ func: name, args: plain(o.args || []), world: o.world, target: o.target });
        const r = scripting.results[name];
        if (r === undefined) throw new Error(`fake executeScript: no result prepared for ${name}`);
        const value = typeof r === "function" ? await r(...(o.args || [])) : plain(r);
        return [{ result: value }];
      },
      async getRegisteredContentScripts(f) { return scripting.registered.filter((s) => !f || !f.ids || f.ids.includes(s.id)); },
      async registerContentScripts(list) { scripting.registered.push(...list); },
      async unregisterContentScripts(f) { scripting.registered = scripting.registered.filter((s) => !f.ids.includes(s.id)); },
    },
    runtime: { getURL: (p) => "chrome-extension://abc/" + p },
  };
  return { chrome, data, scripting, listeners };
}

/** AgentBrowserTools as browserTools.js exposes it to the extras, over the fake chrome. `refs` maps ref → { documentId, local, loc }. */
export function fakeTools(chrome, refs = {}) {
  const registered = {};
  const calls = [];
  const T = {
    refs,
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
      refTarget: (ref) => (T.refs[ref] ? { ...T.refs[ref], loc: { ...(T.refs[ref].loc || {}) } } : null),
    },
    calls,
    registered,
    async run(name, args) {
      calls.push({ name, args: plain(args || {}) });
      if (!registered[name]) throw new Error("Unknown browser tool: " + name);
      return registered[name](args || {});
    },
    get names() { return Object.keys(registered); },
  };
  return T;
}

/** The text parts of a tool's result joined, as the model would read them. */
export const outText = (parts) => parts.filter((p) => p.type === "text").map((p) => p.text).join("\n");
export async function runTool(T, name, args) { return outText(await T.run(name, args)); }

// ── A small DOM ───────────────────────────────────────────────────────────

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const RAW = new Set(["script", "style"]);

function escapeText(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function escapeAttr(s) { return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;"); }
function decode(s) { return String(s).replace(/&(amp|lt|gt|quot|#39|#x27);/g, (m, k) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", "#x27": "'" }[k])).replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n))); }

class StyleDecl {
  constructor(owner) { this.owner = owner; this.map = new Map(); }
  _read() {
    this.map = new Map();
    for (const d of (this.owner.getAttribute("style") || "").split(";")) {
      const i = d.indexOf(":");
      if (i > 0) this.map.set(d.slice(0, i).trim().toLowerCase(), d.slice(i + 1).trim());
    }
  }
  _write() {
    const s = [...this.map].map(([k, v]) => `${k}: ${v}`).join("; ");
    if (s) this.owner._attrs.set("style", s); else this.owner._attrs.delete("style");
  }
  setProperty(p, v, prio) { this._read(); this.map.set(p.toLowerCase(), prio ? `${v} !${prio}` : v); this._write(); }
  getPropertyValue(p) { this._read(); return (this.map.get(p.toLowerCase()) || "").replace(/\s*!important$/, ""); }
  get cssText() { return this.owner.getAttribute("style") || ""; }
  get left() { return this.getPropertyValue("left"); }
  get top() { return this.getPropertyValue("top"); }
  get display() { this._read(); return this.getPropertyValue("display"); }
  set display(v) { this.setProperty("display", v); }
}

export class MiniNode {
  constructor(doc, type, name) {
    this.ownerDocument = doc;
    this.nodeType = type; // 1 element, 3 text, 9 document, 11 fragment
    this.localName = name || "";
    this.tagName = (name || "").toUpperCase();
    this.childNodes = [];
    this.parentNode = null;
    this._attrs = new Map();
    this._text = "";
    this.listeners = {};
    this.style = type === 1 ? new StyleDecl(this) : null;
    this._rect = null;
    this._props = {};
  }
  // ── tree ──
  get children() { return this.childNodes.filter((c) => c.nodeType === 1); }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  get firstElementChild() { return this.children[0] || null; }
  get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; }
  get nodeValue() { return this.nodeType === 3 ? this._text : null; }
  set nodeValue(v) { this._text = String(v); }
  get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n.nodeType === 9; }
  getRootNode() { let n = this; while (n.parentNode) n = n.parentNode; return n; }
  contains(other) { for (let n = other; n; n = n.parentNode) if (n === this) return true; return false; }
  appendChild(c) { return this.insertBefore(c, null); }
  insertBefore(c, ref) {
    if (c.nodeType === 11) { for (const k of [...c.childNodes]) this.insertBefore(k, ref); return c; }
    if (c.parentNode) c.parentNode.removeChild(c);
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i === -1) this.childNodes.push(c); else this.childNodes.splice(i, 0, c);
    c.parentNode = this;
    return c;
  }
  removeChild(c) { const i = this.childNodes.indexOf(c); if (i === -1) throw new Error("not a child"); this.childNodes.splice(i, 1); c.parentNode = null; return c; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  insertAdjacentElement(where, el) {
    if (where === "beforebegin") this.parentNode.insertBefore(el, this);
    else if (where === "afterend") this.parentNode.insertBefore(el, this.nextSibling);
    else if (where === "afterbegin") this.insertBefore(el, this.firstChild);
    else this.appendChild(el);
    return el;
  }
  get nextSibling() { if (!this.parentNode) return null; const s = this.parentNode.childNodes; return s[s.indexOf(this) + 1] || null; }
  replaceChildren(...nodes) { for (const c of [...this.childNodes]) this.removeChild(c); nodes.forEach((n) => this.appendChild(n)); }
  // ── attributes ──
  get attributes() { return [...this._attrs].map(([name, value]) => ({ name, value })); }
  getAttribute(n) { n = n.toLowerCase(); return this._attrs.has(n) ? this._attrs.get(n) : null; }
  setAttribute(n, v) { this._attrs.set(n.toLowerCase(), String(v)); }
  hasAttribute(n) { return this._attrs.has(n.toLowerCase()); }
  removeAttribute(n) { this._attrs.delete(n.toLowerCase()); }
  get id() { return this.getAttribute("id") || ""; }
  set id(v) { this.setAttribute("id", v); }
  get className() { return this.getAttribute("class") || ""; }
  set className(v) { this.setAttribute("class", v); }
  get classList() {
    const self = this;
    const list = () => self.className.split(/\s+/).filter(Boolean);
    return {
      add: (...cs) => { const l = list(); cs.forEach((c) => { if (!l.includes(c)) l.push(c); }); self.className = l.join(" "); },
      remove: (...cs) => { self.className = list().filter((c) => !cs.includes(c)).join(" "); },
      contains: (c) => list().includes(c),
      toggle: (c, on) => { const has = list().includes(c); if (on === undefined ? has : !on) self.classList.remove(c); else self.classList.add(c); },
    };
  }
  get dataset() { const o = {}; for (const [k, v] of this._attrs) if (k.startsWith("data-")) o[k.slice(5).replace(/-([a-z])/g, (m, c) => c.toUpperCase())] = v; return o; }
  get hidden() { return this.hasAttribute("hidden"); }
  set hidden(v) { if (v) this.setAttribute("hidden", ""); else this.removeAttribute("hidden"); }
  get value() {
    if (this._props.value !== undefined) return this._props.value;
    if (this.localName === "select") { const o = this.children.find((c) => c.localName === "option"); return o ? (o.hasAttribute("value") ? o.getAttribute("value") : o.textContent) : ""; }
    return this.getAttribute("value") || "";
  }
  set value(v) { this._props.value = String(v); }
  get title() { return this.getAttribute("title") || ""; }
  set title(v) { this.setAttribute("title", v); }
  get placeholder() { return this.getAttribute("placeholder") || ""; }
  set placeholder(v) { this.setAttribute("placeholder", v); }
  get type() { return this.getAttribute("type") || ""; }
  set type(v) { this.setAttribute("type", v); }
  // ── text and markup ──
  get textContent() { return this.nodeType === 3 ? this._text : this.childNodes.map((c) => c.textContent).join(""); }
  set textContent(v) {
    if (this.nodeType === 3) { this._text = String(v); return; }
    this.replaceChildren();
    if (v !== "" && v !== null && v !== undefined) this.appendChild(this.ownerDocument.createTextNode(String(v)));
  }
  /** Like the browser's innerText for block children: the text nodes with a space between them. */
  get innerText() { return this.texts().join(" ").replace(/\s+/g, " ").trim(); }
  get innerHTML() { return this.childNodes.map((c) => c.outerHTML).join(""); }
  set innerHTML(html) {
    const frag = parseHtml(this.ownerDocument, html);
    if (this.localName === "template") { this.content = frag; return; }
    this.replaceChildren(...frag.childNodes);
  }
  get outerHTML() {
    if (this.nodeType === 3) return escapeText(this._text);
    if (this.nodeType !== 1) return this.innerHTML;
    const attrs = [...this._attrs].map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join("");
    if (VOID.has(this.localName)) return `<${this.localName}${attrs}>`;
    return `<${this.localName}${attrs}>${this.innerHTML}</${this.localName}>`;
  }
  // ── selectors ──
  matches(sel) { return parseSelectorList(sel).some((s) => matchComplex(this, s)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    const list = parseSelectorList(sel);
    const out = [];
    const walk = (n) => { for (const c of n.childNodes) if (c.nodeType === 1) { if (list.some((s) => matchComplex(c, s))) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  closest(sel) { for (let n = this; n && n.nodeType === 1; n = n.parentElement) if (n.matches(sel)) return n; return null; }
  getElementById(id) { return this.querySelector(`#${id}`); }
  // ── geometry and events ──
  getBoundingClientRect() { const r = this._rect || { left: 0, top: 0, width: 0, height: 0 }; return { ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height }; }
  getClientRects() { return this._rect ? [this.getBoundingClientRect()] : []; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn); }
  dispatchEvent(ev) { (this.listeners[ev.type] || []).forEach((fn) => fn(ev)); return true; }
  fire(type, ev) { (this.listeners[type] || []).forEach((fn) => fn({ type, stopPropagation() {}, preventDefault() {}, ...ev })); }
  click() { this.fire("click"); }
  focus() {}
  // ── test helpers ──
  /** Every string in this subtree, in document order. */
  texts() { const out = []; const walk = (n) => { for (const c of n.childNodes) c.nodeType === 3 ? out.push(c._text) : walk(c); }; walk(this); return out; }
  text() { return this.texts().join(" "); }
  find(pred) { for (const c of this.childNodes) { if (c.nodeType !== 1) continue; if (pred(c)) return c; const hit = c.find(pred); if (hit) return hit; } return null; }
  findAll(pred) { const out = []; const walk = (n) => { for (const c of n.childNodes) if (c.nodeType === 1) { if (pred(c)) out.push(c); walk(c); } }; walk(this); return out; }
  /** The button whose label starts with `label`, or whose title is `label`. */
  button(label) { return this.find((n) => n.localName === "button" && (n.textContent.startsWith(label) || n.title === label)); }
  byClass(cls) { return this.findAll((n) => n.className.split(/\s+/).includes(cls)); }
}

// ── HTML parsing (tags, attributes, text, comments, void and raw-text elements) ──
function parseHtml(doc, html) {
  const frag = doc.createDocumentFragment();
  const stack = [frag];
  let i = 0;
  const s = String(html);
  while (i < s.length) {
    const lt = s.indexOf("<", i);
    if (lt === -1 || lt > i) {
      const txt = s.slice(i, lt === -1 ? s.length : lt);
      if (txt) stack[stack.length - 1].appendChild(doc.createTextNode(decode(txt)));
      if (lt === -1) break;
      i = lt;
    }
    if (s.startsWith("<!--", i)) { const end = s.indexOf("-->", i); i = end === -1 ? s.length : end + 3; continue; }
    if (s.startsWith("<!", i)) { const end = s.indexOf(">", i); i = end === -1 ? s.length : end + 1; continue; }
    const m = /^<(\/?)([a-zA-Z][\w:-]*)((?:\s+[^\s"'>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>/.exec(s.slice(i));
    if (!m) { stack[stack.length - 1].appendChild(doc.createTextNode("<")); i++; continue; }
    i += m[0].length;
    const name = m[2].toLowerCase();
    if (m[1]) { // closing tag: pop to the matching element
      for (let k = stack.length - 1; k > 0; k--) if (stack[k].localName === name) { stack.length = k; break; }
      continue;
    }
    const el = doc.createElement(name);
    const attrRe = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
    let a;
    while ((a = attrRe.exec(m[3]))) el.setAttribute(a[1], decode(a[2] !== undefined ? a[2] : a[3] !== undefined ? a[3] : a[4] !== undefined ? a[4] : ""));
    stack[stack.length - 1].appendChild(el);
    if (VOID.has(name) || m[4]) continue;
    if (RAW.has(name)) {
      const end = s.toLowerCase().indexOf(`</${name}>`, i);
      el.appendChild(doc.createTextNode(s.slice(i, end === -1 ? s.length : end)));
      i = end === -1 ? s.length : end + name.length + 3;
      continue;
    }
    stack.push(el);
  }
  return frag;
}

// ── Selectors: lists, descendant (space) and child (>) combinators, compound of tag #id .class [attr] [attr="v"] :nth-of-type(n) ──
function parseSelectorList(sel) {
  if (typeof sel !== "string" || !sel.trim()) throw new Error("SyntaxError: empty selector");
  return splitTopLevel(sel, ",").map(parseComplex);
}
function splitTopLevel(s, sep) {
  const out = []; let cur = "", depth = 0, quote = "";
  for (const ch of s) {
    if (quote) { cur += ch; if (ch === quote) quote = ""; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === "(" || ch === "[") depth++;
    if (ch === ")" || ch === "]") depth--;
    if (ch === sep && !depth) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}
function parseComplex(text) {
  // Tokens: compounds separated by combinators; ">" possibly surrounded by spaces.
  const parts = [];
  const re = /\s*(>)\s*|\s+/g;
  let last = 0, m;
  const pieces = [];
  while ((m = re.exec(text.trim()))) {
    pieces.push({ compound: text.trim().slice(last, m.index), comb: m[1] ? ">" : " " });
    last = m.index + m[0].length;
  }
  pieces.push({ compound: text.trim().slice(last), comb: "" });
  for (const p of pieces) parts.push({ compound: parseCompound(p.compound), comb: p.comb });
  return parts; // [{compound, comb}] — comb is the combinator to the NEXT compound
}
function parseCompound(c) {
  const out = { tag: null, id: null, classes: [], attrs: [], nth: null };
  if (!c) throw new Error("SyntaxError: bad selector");
  const re = /^(\*|[a-zA-Z][\w-]*)|#([\w-]+|(?:\\.|[\w-])+)|\.((?:\\.|[\w-])+)|\[([\w:-]+)(?:([~|^$*]?=)"?([^"\]]*)"?)?\]|:nth-of-type\((\d+)\)|:(scope|root)/g;
  let i = 0, m;
  while (i < c.length) {
    re.lastIndex = i;
    m = re.exec(c);
    if (!m || m.index !== i) throw new Error("SyntaxError: '" + c + "' is not a valid selector");
    i = re.lastIndex;
    if (m[1] !== undefined) out.tag = m[1] === "*" ? null : m[1].toLowerCase();
    else if (m[2] !== undefined) out.id = m[2].replace(/\\(.)/g, "$1");
    else if (m[3] !== undefined) out.classes.push(m[3].replace(/\\(.)/g, "$1"));
    else if (m[4] !== undefined) out.attrs.push({ name: m[4].toLowerCase(), op: m[5] || "", value: m[6] });
    else if (m[7] !== undefined) out.nth = Number(m[7]);
  }
  return out;
}
function matchCompound(el, c) {
  if (c.tag && el.localName !== c.tag) return false;
  if (c.id !== null && el.id !== c.id) return false;
  for (const cls of c.classes) if (!el.classList.contains(cls)) return false;
  for (const a of c.attrs) {
    if (!el.hasAttribute(a.name)) return false;
    const v = el.getAttribute(a.name);
    if (a.op === "=" && v !== a.value) return false;
    if (a.op === "^=" && !v.startsWith(a.value)) return false;
    if (a.op === "*=" && !v.includes(a.value)) return false;
  }
  if (c.nth !== null) {
    const p = el.parentNode;
    if (!p) return false;
    const same = p.childNodes.filter((x) => x.nodeType === 1 && x.localName === el.localName);
    if (same.indexOf(el) + 1 !== c.nth) return false;
  }
  return true;
}
function matchComplex(el, parts) {
  // Match right to left.
  let k = parts.length - 1;
  if (!matchCompound(el, parts[k].compound)) return false;
  let node = el;
  while (k > 0) {
    const comb = parts[k - 1].comb;
    k--;
    if (comb === ">") {
      node = node.parentElement;
      if (!node || !matchCompound(node, parts[k].compound)) return false;
    } else {
      node = node.parentElement;
      while (node && !matchCompound(node, parts[k].compound)) node = node.parentElement;
      if (!node) return false;
    }
  }
  return true;
}

/** A document with <html><head></head><body>…body…</body></html>; `bodyHtml` fills the body. */
export function fakeDocument(bodyHtml = "") {
  const doc = new MiniNode(null, 9, "#document");
  doc.ownerDocument = doc;
  doc.createElement = (name) => new MiniNode(doc, 1, name.toLowerCase());
  doc.createTextNode = (t) => { const n = new MiniNode(doc, 3, "#text"); n._text = String(t); return n; };
  doc.createDocumentFragment = () => new MiniNode(doc, 11, "#fragment");
  const html = doc.createElement("html");
  const head = doc.createElement("head");
  const body = doc.createElement("body");
  html.appendChild(head); html.appendChild(body); doc.appendChild(html);
  doc.documentElement = html; doc.head = head; doc.body = body;
  doc.readyState = "complete";
  if (bodyHtml) body.innerHTML = bodyHtml;
  return doc;
}
/** A DOMParser over the mini parser, for sanitizeHtml in node. */
export class FakeDOMParser {
  parseFromString(html) {
    const m = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html);
    return fakeDocument(m ? m[1] : html);
  }
}

// ── Loading a module ───────────────────────────────────────────────────────

/**
 * Load browser/extras/<id>.js in a vm against the fakes. `features` is the brand's feature map (default: only
 * this extra on); `document` a fake document the page-side functions see when called directly; `refs` the
 * ref table of helpers.refTarget. Returns the fakes, the module's X object, its tab and commands.
 */
export function loadExtra(id, { features, document, refs, tabUrl, preRegistered } = {}) {
  const f = fakeChrome();
  if (tabUrl) f.chrome.tabs.current.url = tabUrl;
  if (preRegistered) f.scripting.registered.push(...preRegistered); // content scripts registered by an earlier panel session
  const T = fakeTools(f.chrome, refs);
  const AgentExtras = { tabs: [], commands: [] };
  const feats = features || { [id]: true };
  const AGENT_BRAND = { shortName: "Test", colors: { accent: "#3fb8ff" }, features: feats, has: (x) => feats[x] === true };
  const doc = document || fakeDocument();
  const sandbox = {
    chrome: f.chrome, AgentBrowserTools: T, AgentExtras, AGENT_BRAND, console, setTimeout, clearTimeout, URL,
    confirm: () => true, DOMParser: FakeDOMParser, document: doc,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  const file = fileURLToPath(new URL(`../../browser/extras/${id}.js`, import.meta.url));
  vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: `${id}.js` });
  const tab = AgentExtras.tabs.find((t) => t.id === id);
  return { ...f, T, AgentExtras, X: AgentExtras[id], tab, commands: AgentExtras.commands, context, document: doc };
}

/**
 * Load browser/extras/elements.cs.js (the content script) in a vm: a fake document, location.hostname and a
 * chrome with storage. Returns the context (window.__agentElementsCS is its API) and the fakes.
 */
export function loadContentScript({ document, hostname = "example.com", chrome, readyState } = {}) {
  const f = chrome ? { chrome } : fakeChrome();
  const doc = document || fakeDocument();
  if (readyState) doc.readyState = readyState;
  const sandbox = { chrome: f.chrome, document: doc, location: { hostname, href: `https://${hostname}/` }, console, setTimeout, clearTimeout };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  const file = fileURLToPath(new URL("../../browser/extras/elements.cs.js", import.meta.url));
  vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: "elements.cs.js" });
  return { ...f, context, document: doc, cs: () => sandbox.__agentElementsCS };
}

// ── The ctx automations.js hands an extra's render() ──────────────────────

export function fakeCtx(doc) {
  const d = doc || fakeDocument();
  const el = (tag, props, children) => {
    const n = d.createElement(tag);
    if (props) for (const k of Object.keys(props)) {
      if (k === "className") n.className = props[k];
      else if (k === "dataset") for (const dk of Object.keys(props[k])) n.setAttribute("data-" + dk.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase()), props[k][dk]);
      else if (k.indexOf("on") === 0) n.addEventListener(k.slice(2), props[k]);
      else if (k === "value") n.value = props[k];
      else n.setAttribute(k, props[k]);
    }
    (children || []).forEach((c) => { if (c != null) n.appendChild(typeof c === "string" ? d.createTextNode(c) : c); });
    return n;
  };
  const content = el("div", { className: "cmd-list" });
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
    currentTabUrl: async () => "https://www.example.com/page",
    rerender: () => { renders++; },
  };
  return { el, content, ctx, statuses, prompts, renders: () => renders, document: d };
}
