// Fakes for unit-testing an extra's runtime module (browser/extras/<id>.js) in node: a chrome.* stand-in
// (storage local/session, a cookie jar with Chrome's domain matching and per-tab cookie stores, tabs,
// scripting, proxy settings), a stand-in for the AgentBrowserTools registry and a tiny DOM for the
// 🧩 tab's render(). Shared by tests/accounts.test.mjs and tests/audit.test.mjs.
import vm from "node:vm";

const plain = (x) => JSON.parse(JSON.stringify(x));
const hostOf = (url) => new URL(url).hostname;
const bare = (domain) => String(domain || "").replace(/^\./, "");

/**
 * chrome.* with just what the extras touch. `tabs` is { id: { id, windowId, url, title, active?, incognito? } };
 * incognito tabs live in cookie store "1", the rest in "0". The jar is a plain array the test can seed.
 */
export function fakeChrome({ tabs = {} } = {}) {
  const local = {};
  const session = {};
  const jar = []; // { name, value, domain, hostOnly, path, secure, httpOnly, sameSite, expirationDate?, storeId }
  const log = { reloads: [], created: [], sets: [], removes: [], scripts: [] };
  const listeners = [];
  const area = (data) => ({
    async get(keys) {
      const ks = keys == null ? Object.keys(data) : typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      const out = {};
      for (const k of ks) if (k in data) out[k] = plain(data[k]);
      return out;
    },
    async set(items) {
      Object.assign(data, plain(items));
      listeners.forEach((fn) => fn(items, data === local ? "local" : "session"));
    },
    async remove(keys) {
      for (const k of [].concat(keys)) delete data[k];
    },
  });
  const matchesDomain = (cookieDomain, q) => bare(cookieDomain) === q || bare(cookieDomain).endsWith("." + q);
  const chrome = {
    storage: { local: area(local), session: area(session), onChanged: { addListener: (fn) => listeners.push(fn) } },
    cookies: {
      rejectNames: new Set(), // names chrome.cookies.set refuses (returns null)
      async getAllCookieStores() {
        const ids = Object.values(tabs);
        return [{ id: "0", tabIds: ids.filter((t) => !t.incognito).map((t) => t.id) }, { id: "1", tabIds: ids.filter((t) => t.incognito).map((t) => t.id) }];
      },
      async getAll(q = {}) {
        return jar
          .filter((c) => (!q.storeId || c.storeId === q.storeId) && (!q.domain || matchesDomain(c.domain, q.domain.toLowerCase())) && (!q.name || c.name === q.name))
          .map(plain);
      },
      async set(d) {
        log.sets.push(plain(d));
        if (chrome.cookies.rejectNames.has(d.name)) return null;
        const host = hostOf(d.url);
        const c = {
          name: d.name, value: d.value, domain: d.domain ? (d.domain.startsWith(".") ? d.domain : "." + d.domain) : host, hostOnly: !d.domain,
          path: d.path || "/", secure: !!d.secure, httpOnly: !!d.httpOnly, sameSite: d.sameSite || "unspecified", storeId: d.storeId || "0",
        };
        if (d.expirationDate) c.expirationDate = d.expirationDate;
        const i = jar.findIndex((x) => x.name === c.name && x.domain === c.domain && x.path === c.path && x.storeId === c.storeId);
        if (i >= 0) jar.splice(i, 1);
        jar.push(c);
        return plain(c);
      },
      async remove(d) {
        log.removes.push(plain(d));
        const host = hostOf(d.url);
        const i = jar.findIndex((c) => c.name === d.name && bare(c.domain) === host && (!d.storeId || c.storeId === d.storeId));
        if (i < 0) return null;
        const [c] = jar.splice(i, 1);
        return { url: d.url, name: d.name, storeId: c.storeId };
      },
    },
    tabs: {
      async get(id) {
        if (!tabs[id]) throw new Error("No tab with id: " + id);
        return { status: "complete", ...plain(tabs[id]) };
      },
      async query(q = {}) {
        return Object.values(tabs).filter((t) => (q.active === undefined || !!t.active === q.active)).map((t) => ({ status: "complete", ...plain(t) }));
      },
      async reload(id) { log.reloads.push(id); },
      async create(o) { log.created.push(plain(o)); return { id: 77, ...o }; },
    },
    scripting: {
      result: null, // what an injected function returns (a value, or a function of the call's options)
      throws: null, // an Error executeScript rejects with
      async executeScript(o) {
        log.scripts.push({ tabId: o.target.tabId, world: o.world, func: o.func.name });
        if (chrome.scripting.throws) throw chrome.scripting.throws;
        const r = typeof chrome.scripting.result === "function" ? chrome.scripting.result(o) : chrome.scripting.result;
        return [{ result: r == null ? r : plain(r) }];
      },
    },
    proxy: {
      value: { value: { mode: "system" }, levelOfControl: "controllable_by_this_extension" },
      settings: { async get() { return plain(chrome.proxy.value); } },
    },
    runtime: { getURL: (p) => "chrome-extension://abc/" + p },
  };
  return { chrome, local, session, jar, log, tabs };
}

/** A stand-in for AgentBrowserTools: the registry the extras register into, and the helpers they build on. */
export function fakeTools(chrome, currentId) {
  const t = {
    current: currentId,
    device: null, // what deviceOf(tabId) answers (a device config, or null)
    registered: {},
    register(name, fn) {
      if (t.registered[name]) throw new Error("Browser tool already defined: " + name);
      t.registered[name] = fn;
    },
    helpers: {
      currentTab: async () => chrome.tabs.get(t.current),
      inTop: async (fn, args, world) => (await chrome.scripting.executeScript({ target: { tabId: t.current }, func: fn, args: args || [], world: world || "ISOLATED" }))[0].result,
      inAllFrames: async () => [],
      snapshot: async () => ({}),
      sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 2))), // the real pauses would only slow the tests
      text: (s) => [{ type: "text", text: s }],
      ownPage: () => false,
    },
    deviceOf: () => t.device,
    /** Call a registered tool and join its text parts (what the model would read). */
    run: async (name, args) => (await t.registered[name](args || {})).filter((p) => p.type === "text").map((p) => p.text).join("\n"),
  };
  return t;
}

/** Load an extra's source in a vm context with the fakes; returns the context's AgentExtras. */
export function loadExtra(src, { chrome, tools, features = [], globals = {} }) {
  const ctx = {
    chrome, console, setTimeout, clearTimeout, URL,
    AGENT_BRAND: { has: (f) => features.includes(f) },
    AgentBrowserTools: tools,
    AgentExtras: { tabs: [], commands: [] },
    ...globals,
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx.AgentExtras;
}

/**
 * A DOM small enough to render a 🧩 tab: el() with the same contract as automations.js (className,
 * on* handlers, other props set on the node), nodes with children/textContent/appendChild/replaceChildren,
 * click() that runs the handlers, and find()/textOf() to assert on the result.
 */
export function fakeDom() {
  class Node {
    constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.className = ""; }
    appendChild(c) { this.children.push(c); return c; }
    replaceChildren(...nodes) { this.children = nodes; }
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
    async click() { for (const fn of this.listeners.click || []) await fn({ stopPropagation() {}, key: "" }); }
    get textContent() { return textOf(this); }
    set textContent(v) { this.children = v ? [String(v)] : []; }
  }
  function textOf(n) { return typeof n === "string" ? n : n.children.map(textOf).join(""); }
  function el(tag, props, children) {
    const n = new Node(tag);
    if (props) for (const k of Object.keys(props)) {
      if (k === "className") n.className = props[k];
      else if (k.indexOf("on") === 0) n.addEventListener(k.slice(2), props[k]);
      else n[k] = props[k];
    }
    (children || []).forEach((c) => { if (c != null) n.appendChild(c); });
    return n;
  }
  function find(root, pred, out = []) {
    if (typeof root === "string") return out;
    if (pred(root)) out.push(root);
    root.children.forEach((c) => find(c, pred, out));
    return out;
  }
  const byClass = (root, cls) => find(root, (n) => n.className.split(" ").includes(cls));
  const buttons = (root, label) => find(root, (n) => n.tag === "button" && (!label || textOf(n) === label || n.title === label));
  return { Node, el, textOf, find, byClass, buttons };
}

/** The ctx automations.js hands a tab's render(); records status lines, prompts and rerenders. */
export function fakeCtx(dom, { url = "" } = {}) {
  const ctx = {
    statuses: [], prompts: [], rerenders: 0,
    el: dom.el,
    field: (label, input) => dom.el("label", { className: "ed-label" }, [label, input]),
    ago: () => "just now",
    hostOf: (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (_) { return u || ""; } },
    status: (text, kind) => ctx.statuses.push([text || "", kind || ""]),
    sendPrompt: (t) => ctx.prompts.push(t),
    currentTabUrl: async () => url,
    rerender: () => { ctx.rerenders++; },
  };
  return ctx;
}
