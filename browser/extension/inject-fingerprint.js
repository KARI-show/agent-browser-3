// ═══════════════════════════════════════════════════════════════════════════
// DEVICE CONFIG — page-side overrides (MAIN world, before any page script)
//
// Presents a device profile's config (fingerprint.js configFor) to the page:
// navigator.*, client hints, screen, canvas / audio noise, WebGL strings,
// media devices, battery, time zone, plugins. Everything is read from one
// config object, so the values agree with each other and with the request
// headers the DevTools session sets for the same tab.
//
// How the config gets here, in order of preference:
//   1. Embedded: browserTools.js loads this file's text, puts the config in
//      place of the EMBEDDED marker below and installs the result with
//      Page.addScriptToEvaluateOnNewDocument — runs before any page script
//      in every document of the profile's tab (frames through auto-attach).
//   2. Bridge: fp-bridge.js (ISOLATED world content script, registered while
//      a profile window is open) asks the service worker for this window's
//      config, writes it into a <script type="application/json"> element and
//      fires an event; this script, registered alongside in the MAIN world,
//      waits for that event. The storage round-trip is asynchronous, so this
//      path can lose to an inline page script: it then stands down rather
//      than present two identities in one document.
// Applying twice is a no-op (a navigator own-property marks a done document).
//
// Limits: workers and OffscreenCanvas keep the real values (the DevTools
// hardwareConcurrency / time zone overrides cover workers; the rest doesn't).
// ═══════════════════════════════════════════════════════════════════════════
(function () {
  "use strict";

  var EMBEDDED = null; /*__DEVICE_CONFIG__*/

  function applyDeviceConfig(FP) {
    if (!FP || !FP.ua) return false;
    // Already applied to this document (hardwareConcurrency is never pinned by anything else).
    if (Object.getOwnPropertyDescriptor(navigator, "hardwareConcurrency")) return false;
    var langs = FP.langs && FP.langs.length ? FP.langs.slice() : ["en-US", "en"];
    var win = typeof window !== "undefined" ? window : globalThis;

    // ── Native function masking ───────────────────────────────────────────
    // Pages compare fn.toString() with "[native code]"; a replaced function
    // keeps the string of the one it replaced.
    var _toString = Function.prototype.toString;
    var _originals = new Map();

    function mask(obj, prop, fn, originalFn) {
      var orig = originalFn || obj[prop];
      try { _originals.set(fn, _toString.call(orig)); } catch (e) {}
      var desc = Object.getOwnPropertyDescriptor(obj, prop);
      Object.defineProperty(obj, prop, {
        value: fn,
        writable: true,
        configurable: true,
        enumerable: desc ? desc.enumerable !== false : true,
      });
    }

    var patchedToString = function toString() {
      var native = _originals.get(this);
      return native || _toString.call(this);
    };
    _originals.set(patchedToString, _toString.call(_toString));
    Function.prototype.toString = patchedToString;

    function getter(obj, prop, value) {
      try {
        Object.defineProperty(obj, prop, { get: function () { return value; }, configurable: true, enumerable: true });
      } catch (e) {}
    }

    // ── PRNG (same as fingerprint.js) ─────────────────────────────────────
    function seedHash(str) {
      var h = 0x811c9dc5;
      for (var i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
      }
      return h >>> 0;
    }
    function createPRNG(seed) {
      var s = seedHash(String(seed)) || 1;
      return function () {
        s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
        return (s >>> 0) / 4294967296;
      };
    }
    var seed = String(FP.noiseSeed || FP.profileId || FP.ua);

    // ── navigator ─────────────────────────────────────────────────────────
    var nav = navigator;
    var navProps = {
      userAgent: FP.ua,
      appVersion: String(FP.ua).replace(/^Mozilla\//, ""),
      platform: FP.platform,
      hardwareConcurrency: FP.hardwareConcurrency,
      deviceMemory: FP.deviceMemory,
      maxTouchPoints: FP.maxTouchPoints,
      language: langs[0],
      languages: Object.freeze(langs.slice()),
      vendor: "Google Inc.",
    };
    Object.keys(navProps).forEach(function (key) {
      if (navProps[key] === undefined) return;
      getter(nav, key, navProps[key]);
    });

    if (FP.connection && nav.connection) {
      ["downlink", "effectiveType", "rtt", "saveData"].forEach(function (k) {
        if (FP.connection[k] !== undefined) getter(nav.connection, k, FP.connection[k]);
      });
    }

    // Client hints: navigator.userAgentData (the request headers come from the DevTools session).
    var osName = FP.osName || ({ win: "Windows", mac: "macOS", linux: "Linux", android: "Android", ios: "iOS" })[FP.os] || "Windows";
    if (FP.brands && nav.userAgentData) {
      try {
        var uaData = nav.userAgentData;
        getter(uaData, "brands", Object.freeze(FP.brands.map(function (b) { return Object.freeze({ brand: b.brand, version: b.version }); })));
        getter(uaData, "mobile", !!FP.mobile);
        getter(uaData, "platform", osName);
        var origGetHEV = uaData.getHighEntropyValues;
        var full = FP.fullVersionList || FP.brands;
        var fakeGetHEV = function getHighEntropyValues(hints) {
          var all = {
            architecture: FP.arch || "x86",
            bitness: FP.bitness || "64",
            brands: FP.brands.slice(),
            fullVersionList: full.slice(),
            mobile: !!FP.mobile,
            model: FP.model || "",
            platform: osName,
            platformVersion: FP.platformVersion || "10.0.0",
            uaFullVersion: full[0].version,
            wow64: false,
            formFactors: FP.mobile ? ["Mobile"] : ["Desktop"],
          };
          var out = { brands: all.brands, mobile: all.mobile, platform: all.platform };
          (Array.isArray(hints) ? hints : []).forEach(function (h) { if (h in all) out[h] = all[h]; });
          return Promise.resolve(out);
        };
        mask(Object.getPrototypeOf(uaData), "getHighEntropyValues", fakeGetHEV, origGetHEV);
        var origToJSON = uaData.toJSON;
        mask(Object.getPrototypeOf(uaData), "toJSON", function toJSON() {
          return { brands: FP.brands.slice(), mobile: !!FP.mobile, platform: osName };
        }, origToJSON);
      } catch (e) {}
    }

    // ── screen ────────────────────────────────────────────────────────────
    if (FP.screen && typeof screen !== "undefined") {
      var s = FP.screen;
      var screenProps = { width: s.width, height: s.height, availWidth: s.availWidth, availHeight: s.availHeight, availLeft: 0, availTop: 0, colorDepth: s.colorDepth, pixelDepth: s.colorDepth };
      Object.keys(screenProps).forEach(function (key) { getter(screen, key, screenProps[key]); });
      if (s.pixelRatio) getter(win, "devicePixelRatio", s.pixelRatio);
      if (typeof win.matchMedia === "function") {
        var origMatchMedia = win.matchMedia;
        mask(win, "matchMedia", function matchMedia(query) {
          var q = String(query)
            .replace(/device-width:\s*(\d+)px/g, "device-width: " + s.width + "px")
            .replace(/device-height:\s*(\d+)px/g, "device-height: " + s.height + "px");
          return origMatchMedia.call(win, q);
        }, origMatchMedia);
      }
    }

    // ── canvas noise (deterministic per profile and canvas size) ──────────
    // The real canvas is never modified: the noisy pixels go into a copy, so
    // reading a canvas twice gives the same bytes and drawing goes on untouched.
    function addCanvasNoise(imageData) {
      var d = imageData.data;
      var rng = createPRNG(seed + "-canvas-" + d.length);
      for (var i = 0; i < d.length; i += 4) {
        var ch = Math.floor(rng() * 3);
        var delta = rng() < 0.5 ? -1 : 1;
        var v = d[i + ch] + delta;
        d[i + ch] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
      return imageData;
    }

    if (typeof HTMLCanvasElement !== "undefined" && typeof CanvasRenderingContext2D !== "undefined") {
      var CanvasProto = HTMLCanvasElement.prototype;
      var Ctx2dProto = CanvasRenderingContext2D.prototype;
      var origToDataURL = CanvasProto.toDataURL;
      var origToBlob = CanvasProto.toBlob;
      var origGetImageData = Ctx2dProto.getImageData;
      var origGetContext = CanvasProto.getContext;

      // A noisy copy of a 2D canvas, or null (WebGL / empty canvases pass through unchanged).
      function noisyCopy(canvas) {
        if (!canvas.width || !canvas.height) return null;
        var ctx;
        try { ctx = origGetContext.call(canvas, "2d"); } catch (e) { return null; }
        if (!ctx) return null;
        var img = origGetImageData.call(ctx, 0, 0, canvas.width, canvas.height);
        addCanvasNoise(img);
        var copy = document.createElement("canvas");
        copy.width = canvas.width;
        copy.height = canvas.height;
        origGetContext.call(copy, "2d").putImageData(img, 0, 0);
        return copy;
      }

      mask(CanvasProto, "toDataURL", function toDataURL() {
        var copy = null;
        try { copy = noisyCopy(this); } catch (e) { copy = null; }
        return origToDataURL.apply(copy || this, arguments);
      }, origToDataURL);

      mask(CanvasProto, "toBlob", function toBlob() {
        var copy = null;
        try { copy = noisyCopy(this); } catch (e) { copy = null; }
        return origToBlob.apply(copy || this, arguments);
      }, origToBlob);

      mask(Ctx2dProto, "getImageData", function getImageData() {
        return addCanvasNoise(origGetImageData.apply(this, arguments));
      }, origGetImageData);
    }

    // ── WebGL strings and limits ──────────────────────────────────────────
    if (FP.webgl) {
      var GL = FP.webgl;
      var PARAM_MAP = {};
      PARAM_MAP[0x1F00] = GL.vendor;                       // VENDOR
      PARAM_MAP[0x1F01] = GL.renderer;                     // RENDERER
      PARAM_MAP[0x0D33] = GL.maxTextureSize;               // MAX_TEXTURE_SIZE
      PARAM_MAP[0x0D3A] = GL.maxViewportDims ? new Int32Array(GL.maxViewportDims) : undefined; // MAX_VIEWPORT_DIMS
      PARAM_MAP[0x84E8] = GL.maxRenderbufferSize;          // MAX_RENDERBUFFER_SIZE
      PARAM_MAP[0x8869] = GL.maxVertexAttribs;             // MAX_VERTEX_ATTRIBS
      PARAM_MAP[0x8DFC] = GL.maxVaryingVectors;            // MAX_VARYING_VECTORS
      PARAM_MAP[0x8DFD] = GL.maxFragmentUniformVectors;    // MAX_FRAGMENT_UNIFORM_VECTORS
      PARAM_MAP[0x8DFB] = GL.maxVertexUniformVectors;      // MAX_VERTEX_UNIFORM_VECTORS
      PARAM_MAP[0x8B4C] = GL.maxVertexTextureImageUnits;   // MAX_VERTEX_TEXTURE_IMAGE_UNITS
      PARAM_MAP[0x8872] = GL.maxTextureImageUnits;         // MAX_TEXTURE_IMAGE_UNITS
      PARAM_MAP[0x8B4D] = GL.maxCombinedTextureImageUnits; // MAX_COMBINED_TEXTURE_IMAGE_UNITS
      PARAM_MAP[0x846E] = GL.aliasedLineWidthRange ? new Float32Array(GL.aliasedLineWidthRange) : undefined;
      PARAM_MAP[0x846D] = GL.aliasedPointSizeRange ? new Float32Array(GL.aliasedPointSizeRange) : undefined;
      PARAM_MAP[0x9245] = GL.unmaskedVendor;               // UNMASKED_VENDOR_WEBGL
      PARAM_MAP[0x9246] = GL.unmaskedRenderer;             // UNMASKED_RENDERER_WEBGL
      if (GL.maxAnisotropy) PARAM_MAP[0x84FF] = GL.maxAnisotropy; // MAX_TEXTURE_MAX_ANISOTROPY_EXT

      function patchWebGL(proto) {
        var origGetParam = proto.getParameter;
        mask(proto, "getParameter", function getParameter(pname) {
          var v = PARAM_MAP[pname];
          if (v !== undefined) return ArrayBuffer.isView(v) ? v.slice() : v;
          return origGetParam.apply(this, arguments);
        }, origGetParam);
      }
      if (typeof WebGLRenderingContext !== "undefined") { try { patchWebGL(WebGLRenderingContext.prototype); } catch (e) {} }
      if (typeof WebGL2RenderingContext !== "undefined") { try { patchWebGL(WebGL2RenderingContext.prototype); } catch (e) {} }
    }

    // ── audio ─────────────────────────────────────────────────────────────
    if (FP.audio) {
      var AudioCtx = win.AudioContext || win.webkitAudioContext;
      if (AudioCtx && typeof BaseAudioContext !== "undefined") {
        getter(BaseAudioContext.prototype, "sampleRate", FP.audio.sampleRate);
      }
      if (typeof AudioBuffer !== "undefined") {
        var origGetChannelData = AudioBuffer.prototype.getChannelData;
        var noised = new WeakSet();
        mask(AudioBuffer.prototype, "getChannelData", function getChannelData(channel) {
          var data = origGetChannelData.call(this, channel);
          if (!noised.has(data)) {
            noised.add(data);
            var rng = createPRNG(seed + "-audio-" + channel + "-" + data.length);
            for (var i = 0; i < data.length; i++) data[i] += (rng() - 0.5) * 1e-6;
          }
          return data;
        }, origGetChannelData);
      }
    }

    // ── media devices ─────────────────────────────────────────────────────
    if (FP.media && FP.media.length && nav.mediaDevices && typeof MediaDevices !== "undefined") {
      var origEnumerate = MediaDevices.prototype.enumerateDevices;
      mask(MediaDevices.prototype, "enumerateDevices", function enumerateDevices() {
        return Promise.resolve(FP.media.map(function (d) {
          var info = { deviceId: d.deviceId || "", groupId: d.groupId || "", kind: d.kind, label: d.label };
          info.toJSON = function () { return { deviceId: info.deviceId, groupId: info.groupId, kind: info.kind, label: info.label }; };
          return info;
        }));
      }, origEnumerate);
    }

    // ── battery ───────────────────────────────────────────────────────────
    if (FP.battery && typeof nav.getBattery === "function") {
      var origGetBattery = nav.getBattery;
      var battery = {
        charging: FP.battery.charging,
        chargingTime: FP.battery.chargingTime,
        dischargingTime: FP.battery.dischargingTime,
        level: FP.battery.level,
        onchargingchange: null, onchargingtimechange: null, ondischargingtimechange: null, onlevelchange: null,
        addEventListener: function () {},
        removeEventListener: function () {},
        dispatchEvent: function () { return true; },
      };
      mask(Object.getPrototypeOf(nav), "getBattery", function getBattery() { return Promise.resolve(battery); }, origGetBattery);
    }

    // ── time zone ─────────────────────────────────────────────────────────
    // (The DevTools session also sets Emulation.setTimezoneOverride; this covers the bridge path.)
    if (FP.timezone && typeof Intl !== "undefined" && Intl.DateTimeFormat) {
      var origDTF = Intl.DateTimeFormat;
      var fakeDTF = function DateTimeFormat(locales, options) {
        var opts = Object.assign({}, options || {});
        if (!opts.timeZone) opts.timeZone = FP.timezone;
        return new origDTF(locales, opts);
      };
      fakeDTF.prototype = origDTF.prototype;
      fakeDTF.supportedLocalesOf = origDTF.supportedLocalesOf;
      mask(Intl, "DateTimeFormat", fakeDTF, origDTF);
      if (FP.timezoneOffset !== undefined) {
        var origGetTZO = Date.prototype.getTimezoneOffset;
        mask(Date.prototype, "getTimezoneOffset", function getTimezoneOffset() { return FP.timezoneOffset; }, origGetTZO);
      }
    }

    // ── plugins ───────────────────────────────────────────────────────────
    if (FP.plugins && FP.plugins.length) {
      var plugins = { length: FP.plugins.length };
      FP.plugins.forEach(function (name, i) {
        var pl = { name: name, description: "Portable Document Format", filename: "internal-pdf-viewer", length: 2 };
        pl.item = function () { return null; };
        pl.namedItem = function () { return null; };
        plugins[i] = pl;
        plugins[name] = pl;
      });
      plugins.item = function (i) { return this[i] || null; };
      plugins.namedItem = function (name) { return this[name] || null; };
      plugins.refresh = function () {};
      getter(nav, "plugins", plugins);
    }

    // ── layout noise (client rects, font metrics) ─────────────────────────
    var layoutRng = createPRNG(seed + "-layout");
    var rectNoise = layoutRng() * 0.0001;
    function noisyRect(rect) {
      if (!rect) return rect;
      var r = {
        x: rect.x + rectNoise, y: rect.y + rectNoise, width: rect.width + rectNoise, height: rect.height + rectNoise,
        top: rect.top + rectNoise, right: rect.right + rectNoise, bottom: rect.bottom + rectNoise, left: rect.left + rectNoise,
      };
      r.toJSON = function () { return { x: r.x, y: r.y, width: r.width, height: r.height, top: r.top, right: r.right, bottom: r.bottom, left: r.left }; };
      return r;
    }
    [typeof Element !== "undefined" ? Element.prototype : null, typeof Range !== "undefined" ? Range.prototype : null].forEach(function (proto) {
      if (!proto || typeof proto.getBoundingClientRect !== "function") return;
      var orig = proto.getBoundingClientRect;
      mask(proto, "getBoundingClientRect", function getBoundingClientRect() { return noisyRect(orig.call(this)); }, orig);
    });
    var fontNoise = layoutRng() * 0.05;
    if (typeof HTMLElement !== "undefined") {
      ["offsetHeight", "offsetWidth"].forEach(function (prop) {
        var d = Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop);
        if (!d || !d.get) return;
        try {
          Object.defineProperty(HTMLElement.prototype, prop, { get: function () { return d.get.call(this) + fontNoise; }, configurable: true, enumerable: d.enumerable });
        } catch (e) {}
      });
    }

    // ── gamepads ──────────────────────────────────────────────────────────
    if (typeof nav.getGamepads === "function") {
      var origGG = nav.getGamepads;
      mask(Object.getPrototypeOf(nav), "getGamepads", function getGamepads() { return []; }, origGG);
    }

    // ── WebRTC: no STUN candidates around the profile's proxy ─────────────
    if (typeof RTCPeerConnection !== "undefined") {
      var origRTC = RTCPeerConnection;
      var fakeRTC = function RTCPeerConnection(config, constraints) {
        var c = Object.assign({}, config || {});
        c.iceServers = [];
        return new origRTC(c, constraints);
      };
      fakeRTC.prototype = origRTC.prototype;
      try { fakeRTC.generateCertificate = origRTC.generateCertificate; } catch (e) {}
      _originals.set(fakeRTC, _toString.call(origRTC));
      try { win.RTCPeerConnection = fakeRTC; } catch (e) {}
      try { win.webkitRTCPeerConnection = fakeRTC; } catch (e) {}
    }

    return true;
  }

  // ── Bootstrap ────────────────────────────────────────────────────────────

  var CONFIG_ELEMENT = "__fp_config__";
  var CONFIG_EVENT = "__agent_device_config";

  function readConfigElement() {
    var el = document.getElementById(CONFIG_ELEMENT);
    if (!el) return null;
    var cfg = null;
    try { cfg = JSON.parse(el.textContent); } catch (e) {}
    el.remove();
    return cfg;
  }

  if (EMBEDDED) {
    applyDeviceConfig(EMBEDDED);
    return;
  }
  if (typeof document === "undefined") return;
  var early = readConfigElement();
  if (early) {
    applyDeviceConfig(early);
    return;
  }
  // The bridge's config arrives after a storage round-trip: apply it only while no page script has run.
  document.addEventListener(CONFIG_EVENT, function onConfig() {
    document.removeEventListener(CONFIG_EVENT, onConfig);
    var cfg = readConfigElement();
    if (!cfg) return;
    if (document.scripts && document.scripts.length) return; // a page script may have seen the real values
    applyDeviceConfig(cfg);
  });
})();
