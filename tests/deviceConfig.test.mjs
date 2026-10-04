// Device config stack (browser/extension/fingerprint.js, inject-fingerprint.js, fp-bridge.js) against
// fakes of the page: how a profile becomes the config its window presents, the page-side overrides
// (navigator, screen, canvas noise that leaves the canvas alone, WebGL strings, time zone), the
// embedded (DevTools) route, and the bridge → page handshake with its "no page script yet" guard.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const read = (f) => fs.readFileSync(fileURLToPath(new URL("../browser/extension/" + f, import.meta.url)), "utf8");
const plain = (x) => JSON.parse(JSON.stringify(x)); // values cross vm contexts: compare structure, not prototypes
const ENGINE = read("fingerprint.js");
const INJECT = read("inject-fingerprint.js");
const BRIDGE = read("fp-bridge.js");

function engine() {
  const g = {};
  vm.createContext(g);
  vm.runInContext(ENGINE, g);
  return g.FingerprintEngine;
}
const E = engine();
const WIN_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.7800.44 Safari/537.36";

// ── A page: enough of the DOM/Web API surface for the overrides to land on ──

function fakePage() {
  const listeners = {};
  const elements = [];
  const scripts = [];
  function Element() {}
  Element.prototype.getBoundingClientRect = function () { return { x: 1, y: 2, width: 3, height: 4, top: 2, right: 4, bottom: 6, left: 1 }; };
  function HTMLElement() {}
  HTMLElement.prototype = Object.create(Element.prototype);
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { get() { return 100; }, configurable: true });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { get() { return 20; }, configurable: true });
  function Range() {}
  Range.prototype.getBoundingClientRect = Element.prototype.getBoundingClientRect;

  // 2D canvas with real pixel storage, so the noise can be checked byte by byte.
  function CanvasRenderingContext2D(canvas) { this.canvas = canvas; }
  CanvasRenderingContext2D.prototype.getImageData = function (x, y, w, h) {
    return { width: w, height: h, data: new Uint8ClampedArray(this.canvas._px) };
  };
  CanvasRenderingContext2D.prototype.putImageData = function (img) { this.canvas._px = Array.from(img.data); };
  function HTMLCanvasElement() { this.width = 2; this.height = 1; this._px = [10, 20, 30, 255, 40, 50, 60, 255]; this._ctx = null; }
  HTMLCanvasElement.prototype = Object.create(HTMLElement.prototype);
  HTMLCanvasElement.prototype.getContext = function (kind) { if (kind !== "2d") return null; return this._ctx || (this._ctx = new CanvasRenderingContext2D(this)); };
  HTMLCanvasElement.prototype.toDataURL = function () { return "data:" + this._px.join(","); };
  HTMLCanvasElement.prototype.toBlob = function (cb) { cb("blob:" + this._px.join(",")); };

  function WebGLRenderingContext() {}
  WebGLRenderingContext.prototype.getParameter = function (p) { return "real-" + p; };
  function WebGL2RenderingContext() {}
  WebGL2RenderingContext.prototype.getParameter = WebGLRenderingContext.prototype.getParameter;

  class UAData { getHighEntropyValues() { return Promise.resolve({ real: true }); } toJSON() { return { real: true }; } }
  const uaData = new UAData();
  Object.defineProperty(uaData, "brands", { get: () => [{ brand: "Real", version: "1" }], configurable: true });
  Object.defineProperty(uaData, "platform", { get: () => "Linux", configurable: true });
  Object.defineProperty(uaData, "mobile", { get: () => false, configurable: true });

  class Navigator {
    get userAgent() { return "RealUA"; }
    get platform() { return "Linux x86_64"; }
    get hardwareConcurrency() { return 2; }
    get deviceMemory() { return 4; }
    get language() { return "en"; }
    get languages() { return ["en"]; }
    get userAgentData() { return uaData; }
    get plugins() { return { length: 0 }; }
    getBattery() { return Promise.resolve({ level: 0.5 }); }
    getGamepads() { return [{ id: "pad" }]; }
  }
  const navigator = new Navigator();
  const screen = {};
  for (const [k, v] of Object.entries({ width: 800, height: 600, availWidth: 800, availHeight: 580, colorDepth: 24, pixelDepth: 24 })) {
    Object.defineProperty(screen, k, { get: () => v, configurable: true });
  }
  const document = {
    scripts,
    createElement(tag) { const e = tag === "canvas" ? new HTMLCanvasElement() : { tagName: tag, remove() { elements.splice(elements.indexOf(this), 1); } }; e.tagName = tag; return e; },
    getElementById(id) { return elements.find((e) => e.id === id) || null; },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener(type, fn) { listeners[type] = (listeners[type] || []).filter((f) => f !== fn); },
    dispatchEvent(ev) { (listeners[ev.type] || []).slice().forEach((fn) => fn(ev)); return true; },
    documentElement: { appendChild(el) { elements.push(el); el.parentNode = this; el.remove = () => { elements.splice(elements.indexOf(el), 1); el.parentNode = null; }; } },
  };
  const win = {
    navigator, screen, document, Element, HTMLElement, Range, HTMLCanvasElement, CanvasRenderingContext2D,
    WebGLRenderingContext, WebGL2RenderingContext,
    Intl, Date, Math, Object, Function, Promise, Map, WeakSet, Array, Array: Array, Uint8ClampedArray, Int32Array, Float32Array, ArrayBuffer, JSON, String, Number, Error, Event: class Event { constructor(type) { this.type = type; } },
    matchMedia(q) { return { media: q }; },
    RTCPeerConnection: class RTCPeerConnection { constructor(cfg) { this.cfg = cfg; } static generateCertificate() {} },
    console,
  };
  win.window = win;
  win.globalThis = win;
  vm.createContext(win);
  return { win, elements, listeners };
}

function runInject(page, cfg) {
  vm.runInContext(cfg === undefined ? INJECT : INJECT.replace("null; /*__DEVICE_CONFIG__*/", JSON.stringify(cfg) + ";"), page.win);
}

// ── Engine ─────────────────────────────────────────────────────────────────

test("configFor: the template's hardware, the profile's UA / platform / language, brands from the UA in use", () => {
  const cfg = E.configFor({ device: "win11-i7-rtx4060", ua: WIN_UA + " Edg/150.0.4115.43", platform: "Win32", lang: "fr-FR,fr;q=0.9,en;q=0.8" }, "prof_abc");
  assert.equal(cfg.hardwareConcurrency, 24);
  assert.equal(cfg.deviceMemory, 32);
  assert.deepEqual([cfg.screen.width, cfg.screen.height], [2560, 1440]);
  assert.equal(cfg.webgl.unmaskedRenderer, "ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Direct3D11 vs_5_0 ps_5_0, D3D11)");
  assert.equal(cfg.ua, WIN_UA + " Edg/150.0.4115.43");
  assert.deepEqual(plain(cfg.langs), ["fr-FR", "fr", "en"]);
  assert.deepEqual(plain(cfg.brands.map((b) => b.brand + " " + b.version)), ["Chromium 150", "Microsoft Edge 150", "Not.A/Brand 99"]);
  assert.deepEqual(plain(cfg.fullVersionList[1]), { brand: "Microsoft Edge", version: "150.0.4115.43" });
  assert.equal(cfg.osName, "Windows");
  assert.equal(cfg.noiseSeed, "prof_abc");
  assert.equal(cfg.profileId, "prof_abc");
  assert.equal(E.uaMetadata(cfg).platformVersion, "15.0.0");
  // Deterministic per profile id, different between profiles (media device ids are hashed from it).
  assert.deepEqual(plain(E.configFor({ device: "win11-i7-rtx4060", ua: WIN_UA }, "prof_abc").media), plain(cfg.media));
  assert.notDeepEqual(plain(E.configFor({ device: "win11-i7-rtx4060", ua: WIN_UA }, "prof_xyz").media), plain(cfg.media));
});

test("configFor: no template → null; a non-Chromium UA keeps the hardware but drops the client hints", () => {
  assert.equal(E.configFor({ device: "", ua: WIN_UA }, "p"), null);
  assert.equal(E.configFor({ device: "none", ua: WIN_UA }, "p"), null);
  assert.equal(E.configFor({ device: "no-such-template", ua: WIN_UA }, "p"), null);
  const ff = E.configFor({ device: "win10-i5-gtx1650", ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:135.0) Gecko/20100101 Firefox/135.0" }, "p");
  assert.equal(ff.hardwareConcurrency, 12);
  assert.equal(ff.brands, undefined);
  assert.equal(E.uaMetadata(ff), null);
  // Without a profile language the template's languages stay.
  assert.deepEqual(plain(ff.langs), ["en-US", "en"]);
});

test("templateFor / templatesFor / describe: by id, by the UA's OS (stable per profile), one line per template", () => {
  assert.equal(E.templateFor("p", "mac-m2-14inch").id, "mac-m2-14inch");
  assert.equal(E.templateFor("p", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/150.0.0.0").os, "mac");
  const a = E.templateFor("prof_1", WIN_UA), b = E.templateFor("prof_1", WIN_UA);
  assert.equal(a.id, b.id);
  assert.equal(a.os, "win");
  assert.equal(E.templateFor("p", "Mozilla/5.0 (X11; Linux x86_64) Chrome/150.0.0.0"), null, "no Linux template");
  assert.equal(E.templatesFor("win").length, 5);
  assert.equal(E.templatesFor("mac").length, 1);
  assert.equal(E.describe(E.templateFor("p", "win11-i7-rtx4060")), "Windows 11 — i7-13700K / RTX 4060 (2560×1440, 24 threads, 32 GB, NVIDIA GeForce RTX 4060, America/New_York)");
  assert.equal(E.describe(E.templateFor("p", "mac-m2-14inch")), "macOS Sonoma — M2 Pro / 14-inch (1512×982, 12 threads, 16 GB, Apple M2 Pro, America/New_York)");
  assert.equal(E.describe(null), "User-Agent only");
  assert.equal(E.brandsFromUa("Mozilla/5.0 Safari/605.1.15"), null);
  assert.deepEqual(plain(E.parseLangs(" de-DE , de;q=0.9,en;q=0.8")), ["de-DE", "de", "en"]);
});

// ── Page-side overrides ─────────────────────────────────────────────────────

test("inject (embedded config): navigator, client hints, screen, WebGL, time zone, plugins, layout noise, WebRTC", async () => {
  const cfg = E.configFor({ device: "win11-i7-rtx4060", ua: WIN_UA, platform: "Win32", lang: "de-DE,de;q=0.9" }, "prof_t1");
  const page = fakePage();
  runInject(page, cfg);
  const { navigator, screen, Intl: I, Date: D, HTMLElement, Element, Range, WebGLRenderingContext, RTCPeerConnection } = page.win;
  assert.equal(navigator.userAgent, WIN_UA);
  assert.equal(navigator.appVersion, WIN_UA.replace("Mozilla/", ""));
  assert.equal(navigator.platform, "Win32");
  assert.equal(navigator.hardwareConcurrency, 24);
  assert.equal(navigator.deviceMemory, 32);
  assert.equal(navigator.language, "de-DE");
  assert.deepEqual(plain(navigator.languages), ["de-DE", "de"]);
  assert.equal(navigator.userAgentData.platform, "Windows");
  assert.deepEqual(plain(navigator.userAgentData.brands.map((b) => b.brand)), ["Chromium", "Google Chrome", "Not.A/Brand"]);
  const hev = await navigator.userAgentData.getHighEntropyValues(["architecture", "platformVersion", "uaFullVersion", "fullVersionList"]);
  assert.equal(hev.architecture, "x86");
  assert.equal(hev.platformVersion, "15.0.0");
  assert.equal(hev.uaFullVersion, "150.0.7800.44");
  assert.equal(hev.fullVersionList[1].version, "150.0.7800.44");
  assert.equal(hev.model, undefined, "only the hints asked for, plus the low-entropy ones");
  assert.deepEqual(plain(navigator.userAgentData.toJSON()), { brands: plain(cfg.brands), mobile: false, platform: "Windows" });
  assert.deepEqual([screen.width, screen.height, screen.availHeight, screen.colorDepth], [2560, 1440, cfg.screen.availHeight, 24]);
  assert.equal(page.win.devicePixelRatio, 1);
  assert.equal(page.win.matchMedia("(device-width: 800px)").media, "(device-width: 2560px)");
  const gl = new WebGLRenderingContext();
  assert.equal(gl.getParameter(0x9246), cfg.webgl.unmaskedRenderer);
  assert.equal(gl.getParameter(0x1F00), "Google Inc. (NVIDIA)");
  assert.equal(gl.getParameter(0x0D33), 32768);
  assert.deepEqual(Array.from(gl.getParameter(0x0D3A)), [32768, 32768]);
  assert.equal(gl.getParameter(0x84FF), 16, "anisotropy");
  assert.equal(gl.getParameter(0x1234), "real-4660", "everything else passes through");
  assert.equal(new I.DateTimeFormat("en-US").resolvedOptions().timeZone, "America/New_York");
  assert.equal(new I.DateTimeFormat("en-US", { timeZone: "UTC" }).resolvedOptions().timeZone, "UTC", "an explicit time zone wins");
  assert.equal(new D().getTimezoneOffset(), 300);
  assert.equal(navigator.plugins.length, 5);
  assert.equal(navigator.plugins.namedItem("Chrome PDF Viewer").name, "Chrome PDF Viewer");
  assert.equal(navigator.plugins[0].name, "PDF Viewer");
  assert.deepEqual(plain(navigator.getGamepads()), []);
  assert.equal((await navigator.getBattery()).level, 1);
  const el = new HTMLElement();
  assert.ok(el.offsetWidth > 100 && el.offsetWidth < 100.05, "font metric noise is tiny: " + el.offsetWidth);
  assert.ok(new Element().getBoundingClientRect().width > 3 && new Range().getBoundingClientRect().width < 3.0001);
  assert.deepEqual(plain(new RTCPeerConnection({ iceServers: [{ urls: "stun:x" }] }).cfg.iceServers), []);
  // Native-looking: every replaced function keeps the string of the one it replaced.
  assert.match(page.win.Function.prototype.toString.call(gl.getParameter), /^function \(p\) \{ return "real-"/, "the fake's own source (function getParameter(pname)…) never shows");
  assert.match(page.win.Function.prototype.toString.call(page.win.Function.prototype.toString), /function toString\(\) \{ \[native code\] \}/);
});

test("inject: canvas noise is deterministic per profile and canvas size, and never alters the canvas itself", () => {
  const cfg = E.configFor({ device: "win11-i7-rtx4060", ua: WIN_UA }, "prof_canvas");
  const page = fakePage();
  runInject(page, cfg);
  const c = new page.win.HTMLCanvasElement();
  const before = c._px.slice();
  const a = c.toDataURL(), b = c.toDataURL();
  assert.equal(a, b, "two reads of the same canvas agree");
  assert.notEqual(a, "data:" + before.join(","), "but differ from the real pixels");
  assert.deepEqual(plain(c._px), plain(before), "the canvas pixels are untouched");
  let viaBlob; c.toBlob((x) => (viaBlob = x));
  assert.equal(viaBlob, "blob:" + a.slice(5), "toBlob sees the same noisy copy");
  const img = c.getContext("2d").getImageData(0, 0, 2, 1);
  assert.equal("data:" + Array.from(img.data).join(","), a, "getImageData applies the same noise");
  const pixelsChanged = before.filter((v, i) => v !== img.data[i]).length;
  assert.equal(pixelsChanged, 2, "one channel per pixel, ±1 (alpha untouched)");
  assert.equal(img.data[3], 255);
  // Another profile: another pattern.
  const page2 = fakePage();
  runInject(page2, E.configFor({ device: "win11-i7-rtx4060", ua: WIN_UA }, "prof_other"));
  assert.notEqual(new page2.win.HTMLCanvasElement().toDataURL(), a);
});

test("inject: applying twice is a no-op; a different config is not applied over a done document", () => {
  const cfg = E.configFor({ device: "win11-i7-rtx4060", ua: WIN_UA }, "p1");
  const page = fakePage();
  runInject(page, cfg);
  const toStr = page.win.Function.prototype.toString;
  runInject(page, E.configFor({ device: "mac-m2-14inch", ua: WIN_UA }, "p2"));
  assert.equal(page.win.navigator.hardwareConcurrency, 24, "first config stays");
  assert.equal(page.win.Function.prototype.toString, toStr, "nothing re-patched");
});

test("inject with no config does nothing to the page", () => {
  const page = fakePage();
  runInject(page);
  assert.equal(page.win.navigator.userAgent, "RealUA");
  assert.equal(page.win.navigator.hardwareConcurrency, 2);
  assert.equal(page.listeners.__agent_device_config.length, 1, "it waits for the bridge");
});

// ── Bridge → page ───────────────────────────────────────────────────────────

function bridgeWorld(page, reply) {
  // The ISOLATED world shares the DOM with the page but has chrome.* and its own globals.
  const sent = [];
  const iso = {
    document: page.win.document,
    Event: page.win.Event,
    JSON,
    chrome: { runtime: { lastError: undefined, sendMessage(msg, cb) { sent.push(msg); reply(cb); } } },
  };
  vm.createContext(iso);
  return { run: () => vm.runInContext(BRIDGE, iso), sent };
}

test("bridge: asks the worker for the window's config, hands it to the page through the DOM, leaves no element behind", () => {
  const cfg = E.configFor({ device: "win10-i5-gtx1650", ua: WIN_UA, lang: "en-GB,en;q=0.9" }, "prof_b");
  const page = fakePage();
  runInject(page); // the MAIN-world script is waiting
  let answer;
  const b = bridgeWorld(page, (cb) => (answer = cb));
  b.run();
  assert.deepEqual(plain(b.sent), [{ type: "deviceConfig" }]);
  assert.equal(page.win.navigator.hardwareConcurrency, 2, "nothing yet");
  answer(cfg); // the worker's reply arrives
  assert.equal(page.win.navigator.hardwareConcurrency, 12);
  assert.equal(page.win.navigator.userAgent, WIN_UA);
  assert.equal(page.win.navigator.language, "en-GB");
  assert.equal(page.elements.length, 0, "the config element is gone");
  assert.equal(page.win.document.getElementById("__fp_config__"), null);
});

test("bridge: a null reply (another window) or a page script that already ran leaves the page alone", () => {
  let page = fakePage();
  runInject(page);
  let answer;
  bridgeWorld(page, (cb) => (answer = cb)).run();
  answer(null);
  assert.equal(page.win.navigator.hardwareConcurrency, 2);
  assert.equal(page.elements.length, 0);

  page = fakePage();
  runInject(page);
  bridgeWorld(page, (cb) => (answer = cb)).run();
  page.win.document.scripts.push({ tagName: "script" }); // the parser got to a page script first
  answer(E.configFor({ device: "win10-i5-gtx1650", ua: WIN_UA }, "p"));
  assert.equal(page.win.navigator.hardwareConcurrency, 2, "two identities in one document are worse than none");
  assert.equal(page.elements.length, 0, "the element is still cleaned up");
});
