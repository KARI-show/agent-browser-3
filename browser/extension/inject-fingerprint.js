// ═══════════════════════════════════════════════════════════════════════════
// FINGERPRINT INJECTOR — MAIN world content script at document_start
//
// 背景：Must execute BEFORE any page script to override browser APIs.
// Runs in MAIN world (page context), not ISOLATED (extension context).
// Uses Object.defineProperty, not Proxy, to avoid prototype chain tells.
//
// 设计意图：Override every fingerprint surface with values from the profile
// config injected by the ISOLATED-world bridge script. All overrides mask
// their toString() to return native function signatures.
//
// 约束：Cannot override Worker/OffscreenCanvas rendering (engine-level).
// Must handle iframe consistency (same overrides in nested frames).
// Must not break page functionality.
// ═══════════════════════════════════════════════════════════════════════════
(function () {
  "use strict";

  // Profile config is injected by the bridge script into a <script> tag data attribute
  var configEl = document.getElementById("__fp_config__");
  if (!configEl) return; // No profile active — don't override anything
  var FP;
  try { FP = JSON.parse(configEl.textContent); } catch (e) { return; }
  if (!FP || !FP.ua) return;
  configEl.remove(); // Clean up — no trace in DOM

  // ── UTILITY: Native function masking ──────────────────────────────────
  // Detection scripts call fn.toString() to check for [native code].
  // Our overrides must return the same string as the original.

  var _toString = Function.prototype.toString;
  var _originals = new Map();

  function mask(obj, prop, fn, originalFn) {
    /**
     * 背景：Fingerprint detectors check fn.toString() for "native code" string.
     * If an overridden function returns "[object Function]" or shows Proxy source,
     * it's an instant detection flag.
     * 设计意图：Store the original toString result and return it for our overrides.
     */
    var orig = originalFn || obj[prop];
    var nativeStr = _toString.call(orig);
    _originals.set(fn, nativeStr);
    Object.defineProperty(obj, prop, {
      value: fn,
      writable: false,
      configurable: true,
      enumerable: typeof orig === "function" ? Object.getOwnPropertyDescriptor(obj, prop)?.enumerable !== false : true,
    });
  }

  // Patch Function.prototype.toString to return native strings for our masks
  var patchedToString = function toString() {
    var native = _originals.get(this);
    return native || _toString.call(this);
  };
  _originals.set(patchedToString, _toString.call(_toString));
  Function.prototype.toString = patchedToString;

  // ── PRNG (must match fingerprint.js exactly) ──────────────────────────

  function seedHash(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  function createPRNG(seed) {
    var s = seedHash(String(seed));
    return function () {
      s ^= s << 13; s ^= s >> 17; s ^= s << 5;
      return (s >>> 0) / 4294967296;
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // NAVIGATOR OVERRIDES
  // ═══════════════════════════════════════════════════════════════════════

  var nav = navigator;
  var navProps = {
    userAgent: FP.ua,
    platform: FP.platform,
    hardwareConcurrency: FP.hardwareConcurrency,
    deviceMemory: FP.deviceMemory,
    maxTouchPoints: FP.maxTouchPoints,
    language: FP.langs[0],
    languages: Object.freeze(FP.langs.slice()),
    vendor: "Google Inc.",
    appVersion: FP.ua.replace("Mozilla/", ""),
    // webdriver must be false (true = automation detected)
    webdriver: false,
  };

  Object.keys(navProps).forEach(function (key) {
    try {
      Object.defineProperty(nav, key, {
        get: function () { return navProps[key]; },
        configurable: true,
        enumerable: true,
      });
    } catch (e) { /* some props may be non-configurable in strict mode */ }
  });

  // navigator.connection
  if (FP.connection) {
    try {
      var conn = nav.connection || {};
      ["downlink", "effectiveType", "rtt", "saveData"].forEach(function (k) {
        if (FP.connection[k] !== undefined) {
          try { Object.defineProperty(conn, k, { get: function () { return FP.connection[k]; }, configurable: true }); } catch (e) {}
        }
      });
    } catch (e) {}
  }

  // Client Hints (navigator.userAgentData)
  if (FP.brands && nav.userAgentData) {
    var uaData = nav.userAgentData;
    try {
      Object.defineProperty(uaData, "brands", { get: function () { return FP.brands.slice(); }, configurable: true });
      Object.defineProperty(uaData, "mobile", { get: function () { return !!FP.mobile; }, configurable: true });
      Object.defineProperty(uaData, "platform", { get: function () { return FP.os === "mac" ? "macOS" : "Windows"; }, configurable: true });

      var origGetHighEntropyValues = uaData.getHighEntropyValues;
      var fakeGetHEV = function getHighEntropyValues(hints) {
        return Promise.resolve({
          architecture: FP.arch || "x86",
          bitness: FP.bitness || "64",
          brands: FP.brands.slice(),
          fullVersionList: FP.fullVersionList || FP.brands,
          mobile: !!FP.mobile,
          model: FP.model || "",
          platform: FP.os === "mac" ? "macOS" : "Windows",
          platformVersion: FP.platformVersion || "10.0.0",
          uaFullVersion: (FP.fullVersionList && FP.fullVersionList[0] && FP.fullVersionList[0].version) || FP.brands[0].version,
        });
      };
      mask(uaData, "getHighEntropyValues", fakeGetHEV, origGetHighEntropyValues);
    } catch (e) {}
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SCREEN OVERRIDES
  // ═══════════════════════════════════════════════════════════════════════

  if (FP.screen) {
    var s = FP.screen;
    var screenProps = { width: s.width, height: s.height, availWidth: s.availWidth, availHeight: s.availHeight, colorDepth: s.colorDepth, pixelDepth: s.colorDepth };
    Object.keys(screenProps).forEach(function (key) {
      try {
        Object.defineProperty(screen, key, { get: function () { return screenProps[key]; }, configurable: true });
      } catch (e) {}
    });
    if (s.pixelRatio) {
      try { Object.defineProperty(window, "devicePixelRatio", { get: function () { return s.pixelRatio; }, configurable: true }); } catch (e) {}
    }
    // matchMedia for device dimensions
    var origMatchMedia = window.matchMedia;
    var fakeMatchMedia = function matchMedia(query) {
      var q = String(query);
      // Intercept device-width/device-height queries
      q = q.replace(/device-width:\s*(\d+)px/g, "device-width: " + s.width + "px");
      q = q.replace(/device-height:\s*(\d+)px/g, "device-height: " + s.height + "px");
      return origMatchMedia.call(window, q);
    };
    mask(window, "matchMedia", fakeMatchMedia, origMatchMedia);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CANVAS NOISE (deterministic, seed-based)
  // ═══════════════════════════════════════════════════════════════════════

  var canvasRNG = createPRNG(FP.noiseSeed + "-canvas");

  function addCanvasNoise(imageData) {
    var d = imageData.data;
    var rng = createPRNG(FP.noiseSeed + "-canvas-" + d.length); // Stable per canvas size
    for (var i = 0; i < d.length; i += 4) {
      var ch = Math.floor(rng() * 3);
      var delta = rng() < 0.5 ? -1 : 1;
      var v = d[i + ch] + delta;
      d[i + ch] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
    return imageData;
  }

  // HTMLCanvasElement.prototype.toDataURL
  var origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  var fakeToDataURL = function toDataURL() {
    var ctx = this.getContext("2d");
    if (ctx) {
      try {
        var img = ctx.getImageData(0, 0, this.width, this.height);
        addCanvasNoise(img);
        ctx.putImageData(img, 0, 0);
      } catch (e) { /* tainted canvas, skip */ }
    }
    return origToDataURL.apply(this, arguments);
  };
  mask(HTMLCanvasElement.prototype, "toDataURL", fakeToDataURL, origToDataURL);

  // HTMLCanvasElement.prototype.toBlob
  var origToBlob = HTMLCanvasElement.prototype.toBlob;
  var fakeToBlob = function toBlob(callback) {
    var ctx = this.getContext("2d");
    if (ctx) {
      try {
        var img = ctx.getImageData(0, 0, this.width, this.height);
        addCanvasNoise(img);
        ctx.putImageData(img, 0, 0);
      } catch (e) {}
    }
    return origToBlob.apply(this, arguments);
  };
  mask(HTMLCanvasElement.prototype, "toBlob", fakeToBlob, origToBlob);

  // CanvasRenderingContext2D.prototype.getImageData
  var origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
  var fakeGetImageData = function getImageData() {
    var result = origGetImageData.apply(this, arguments);
    addCanvasNoise(result);
    return result;
  };
  mask(CanvasRenderingContext2D.prototype, "getImageData", fakeGetImageData, origGetImageData);

  // ═══════════════════════════════════════════════════════════════════════
  // WEBGL OVERRIDES
  // ═══════════════════════════════════════════════════════════════════════

  if (FP.webgl) {
    var GL = FP.webgl;
    var PARAM_MAP = {};
    PARAM_MAP[0x1F00] = GL.vendor;           // VENDOR
    PARAM_MAP[0x1F01] = GL.renderer;         // RENDERER
    PARAM_MAP[0x0D33] = GL.maxTextureSize;   // MAX_TEXTURE_SIZE
    PARAM_MAP[0x0D3A] = GL.maxViewportDims;  // MAX_VIEWPORT_DIMS
    PARAM_MAP[0x84E8] = GL.maxRenderbufferSize; // MAX_RENDERBUFFER_SIZE
    PARAM_MAP[0x8869] = GL.maxVertexAttribs; // MAX_VERTEX_ATTRIBS
    PARAM_MAP[0x8DFC] = GL.maxVaryingVectors; // MAX_VARYING_VECTORS
    PARAM_MAP[0x8DFD] = GL.maxFragmentUniformVectors; // MAX_FRAGMENT_UNIFORM_VECTORS
    PARAM_MAP[0x8DFF] = GL.maxVertexUniformVectors; // MAX_VERTEX_UNIFORM_VECTORS
    PARAM_MAP[0x8872] = GL.maxVertexTextureImageUnits; // MAX_VERTEX_TEXTURE_IMAGE_UNITS
    PARAM_MAP[0x8872] = GL.maxVertexTextureImageUnits;
    PARAM_MAP[0x8871] = GL.maxTextureImageUnits; // MAX_TEXTURE_IMAGE_UNITS
    PARAM_MAP[0x8B4D] = GL.maxCombinedTextureImageUnits; // MAX_COMBINED_TEXTURE_IMAGE_UNITS
    PARAM_MAP[0x846E] = GL.aliasedLineWidthRange ? new Float32Array(GL.aliasedLineWidthRange) : undefined; // ALIASED_LINE_WIDTH_RANGE
    PARAM_MAP[0x8460] = GL.aliasedPointSizeRange ? new Float32Array(GL.aliasedPointSizeRange) : undefined; // ALIASED_POINT_SIZE_RANGE

    // WEBGL_debug_renderer_info extension constants
    var UNMASKED_VENDOR  = 0x9245;
    var UNMASKED_RENDERER = 0x9246;
    PARAM_MAP[UNMASKED_VENDOR] = GL.unmaskedVendor;
    PARAM_MAP[UNMASKED_RENDERER] = GL.unmaskedRenderer;

    function patchWebGL(proto) {
      var origGetParam = proto.getParameter;
      var fakeGetParam = function getParameter(pname) {
        if (PARAM_MAP[pname] !== undefined) return PARAM_MAP[pname];
        return origGetParam.call(this, pname);
      };
      mask(proto, "getParameter", fakeGetParam, origGetParam);

      // MAX_TEXTURE_MAX_ANISOTROPY_EXT (depends on extension)
      if (GL.maxAnisotropy) {
        var origGetExt = proto.getExtension;
        var fakeGetExt = function getExtension(name) {
          var ext = origGetExt.call(this, name);
          if (ext && /anisotropic/i.test(name)) {
            var origGet = ext.constructor.prototype.getParameter || origGetParam;
            // The constant is on the extension object itself
            try {
              var anisoConst = ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT;
              if (anisoConst) PARAM_MAP[anisoConst] = GL.maxAnisotropy;
            } catch (e) {}
          }
          return ext;
        };
        mask(proto, "getExtension", fakeGetExt, origGetExt);
      }
    }

    try { patchWebGL(WebGLRenderingContext.prototype); } catch (e) {}
    try { patchWebGL(WebGL2RenderingContext.prototype); } catch (e) {}
  }

  // ═══════════════════════════════════════════════════════════════════════
  // AUDIO CONTEXT
  // ═══════════════════════════════════════════════════════════════════════

  if (FP.audio) {
    var origAudioCtx = window.AudioContext || window.webkitAudioContext;
    if (origAudioCtx) {
      var audioProto = origAudioCtx.prototype;

      // Override scalar properties
      try { Object.defineProperty(audioProto, "sampleRate", { get: function () { return FP.audio.sampleRate; } }); } catch (e) {}

      // OfflineAudioContext buffer noise
      if (window.OfflineAudioContext) {
        var origStartRendering = OfflineAudioContext.prototype.startRendering;
        var fakeStartRendering = function startRendering() {
          var audioRNG = createPRNG(FP.noiseSeed + "-audio");
          return origStartRendering.call(this).then(function (buffer) {
            for (var ch = 0; ch < buffer.numberOfChannels; ch++) {
              var data = buffer.getChannelData(ch);
              for (var i = 0; i < data.length; i++) {
                data[i] += (audioRNG() - 0.5) * 1e-6;
              }
            }
            return buffer;
          });
        };
        mask(OfflineAudioContext.prototype, "startRendering", fakeStartRendering, origStartRendering);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // MEDIA DEVICES (webcam/mic model override)
  // ═══════════════════════════════════════════════════════════════════════

  if (FP.media && FP.media.length && navigator.mediaDevices) {
    var origEnumerate = navigator.mediaDevices.enumerateDevices;
    var fakeEnumerate = function enumerateDevices() {
      return Promise.resolve(FP.media.map(function (d) {
        return {
          deviceId: d.deviceId || "",
          groupId: d.groupId || "",
          kind: d.kind,
          label: d.label,
          toJSON: function () { return { deviceId: this.deviceId, groupId: this.groupId, kind: this.kind, label: this.label }; }
        };
      }));
    };
    mask(navigator.mediaDevices, "enumerateDevices", fakeEnumerate, origEnumerate);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // BATTERY API
  // ═══════════════════════════════════════════════════════════════════════

  if (FP.battery && navigator.getBattery) {
    var origGetBattery = navigator.getBattery;
    var fakeBattery = {
      charging: FP.battery.charging,
      chargingTime: FP.battery.chargingTime,
      dischargingTime: FP.battery.dischargingTime,
      level: FP.battery.level,
      addEventListener: function () {},
      removeEventListener: function () {},
      dispatchEvent: function () { return true; },
      onchargingchange: null, onchargingtimechange: null,
      ondischargingtimechange: null, onlevelchange: null,
    };
    var fakeGetBattery = function getBattery() { return Promise.resolve(fakeBattery); };
    mask(navigator, "getBattery", fakeGetBattery, origGetBattery);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // TIMEZONE
  // ═══════════════════════════════════════════════════════════════════════

  if (FP.timezone) {
    // DateTimeFormat
    var origDTF = Intl.DateTimeFormat;
    var fakeDTF = function DateTimeFormat() {
      var args = Array.from(arguments);
      if (!args[1]) args[1] = {};
      if (!args[1].timeZone) args[1].timeZone = FP.timezone;
      return new origDTF(args[0], args[1]);
    };
    fakeDTF.prototype = origDTF.prototype;
    fakeDTF.supportedLocalesOf = origDTF.supportedLocalesOf;
    mask(window.Intl, "DateTimeFormat", fakeDTF, origDTF);

    // Date.prototype.getTimezoneOffset
    if (FP.timezoneOffset !== undefined) {
      var origGetTZO = Date.prototype.getTimezoneOffset;
      mask(Date.prototype, "getTimezoneOffset", function getTimezoneOffset() {
        return FP.timezoneOffset;
      }, origGetTZO);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PLUGINS
  // ═══════════════════════════════════════════════════════════════════════

  if (FP.plugins) {
    try {
      var fakePlugins = {
        length: FP.plugins.length,
        item: function (i) { return this[i] || null; },
        namedItem: function (name) {
          for (var i = 0; i < this.length; i++) if (this[i].name === name) return this[i];
          return null;
        },
        refresh: function () {},
      };
      FP.plugins.forEach(function (name, i) {
        fakePlugins[i] = { name: name, description: name, filename: name.toLowerCase().replace(/\s+/g, "-") + ".pdf", length: 1, item: function () { return null; }, namedItem: function () { return null; } };
      });
      Object.defineProperty(navigator, "plugins", { get: function () { return fakePlugins; }, configurable: true });
    } catch (e) {}
  }

  // ═══════════════════════════════════════════════════════════════════════
  // WEBDRIVER FLAG
  // ═══════════════════════════════════════════════════════════════════════

  // Extra hardening: delete automation tells
  try { Object.defineProperty(navigator, "webdriver", { get: function () { return false; }, configurable: true }); } catch (e) {}
  try { delete window.cdc_adoQpoasnfa76pfcZLmcfl_Array; } catch (e) {}
  try { delete window.cdc_adoQpoasnfa76pfcZLmcfl_Promise; } catch (e) {}
  try { delete window.cdc_adoQpoasnfa76pfcZLmcfl_Symbol; } catch (e) {}

  // ═══════════════════════════════════════════════════════════════════════
  // CLIENT RECTS NOISE (from Chromixer MIT — prevents DOMRect fingerprinting)
  // 背景：fingerprint scripts measure getBoundingClientRect for elements with
  // specific fonts/styles. Tiny noise makes the hash differ per session.
  // ═══════════════════════════════════════════════════════════════════════

  var rectNoise = rng() * 0.0001;
  var addNoiseToRect = function (rect) {
    return {
      x: rect.x + rectNoise, y: rect.y + rectNoise,
      width: rect.width + rectNoise, height: rect.height + rectNoise,
      top: rect.top + rectNoise, right: rect.right + rectNoise,
      bottom: rect.bottom + rectNoise, left: rect.left + rectNoise,
      toJSON: function () { return rect.toJSON(); },
    };
  };

  try {
    var origGetBCR = Element.prototype.getBoundingClientRect;
    mask(Element.prototype, "getBoundingClientRect", function getBoundingClientRect() {
      return addNoiseToRect(origGetBCR.call(this));
    }, origGetBCR);
  } catch (e) {}

  try {
    var origRangeGetBCR = Range.prototype.getBoundingClientRect;
    mask(Range.prototype, "getBoundingClientRect", function getBoundingClientRect() {
      return addNoiseToRect(origRangeGetBCR.call(this));
    }, origRangeGetBCR);
  } catch (e) {}

  // ═══════════════════════════════════════════════════════════════════════
  // FONT METRIC NOISE (from Chromixer MIT — prevents offsetWidth/Height font enum)
  // 背景：sites cycle through hundreds of fonts checking offsetWidth/Height to
  // detect installed fonts. Tiny noise breaks the comparison.
  // ═══════════════════════════════════════════════════════════════════════

  var fontNoise = rng() * 0.05;
  try {
    var origOH = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
    var origOW = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
    if (origOH && origOH.get) {
      Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
        get: function () { return origOH.get.call(this) + fontNoise; },
        configurable: true,
      });
    }
    if (origOW && origOW.get) {
      Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
        get: function () { return origOW.get.call(this) + fontNoise; },
        configurable: true,
      });
    }
  } catch (e) {}

  // ═══════════════════════════════════════════════════════════════════════
  // GAMEPAD API (from Chromixer MIT — hide gamepad fingerprinting)
  // ═══════════════════════════════════════════════════════════════════════

  try {
    if (navigator.getGamepads) {
      var origGG = navigator.getGamepads;
      mask(navigator, "getGamepads", function getGamepads() { return []; }, origGG);
    }
  } catch (e) {}

  // ═══════════════════════════════════════════════════════════════════════
  // WebRTC IP LEAK PROTECTION
  // ═══════════════════════════════════════════════════════════════════════

  try {
    if (typeof RTCPeerConnection !== "undefined") {
      var origRTC = RTCPeerConnection;
      var fakeRTC = function RTCPeerConnection() {
        var args = Array.from(arguments);
        // Force iceServers to empty to prevent STUN leaks
        if (!args[0]) args[0] = {};
        args[0].iceServers = [];
        return new origRTC(args[0], args[1]);
      };
      fakeRTC.prototype = origRTC.prototype;
      fakeRTC.generateCertificate = origRTC.generateCertificate;
      _originals.set(fakeRTC, _toString.call(origRTC));
      window.RTCPeerConnection = fakeRTC;
    }
  } catch (e) {}

})();
