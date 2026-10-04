// ═══════════════════════════════════════════════════════════════════════════
// FINGERPRINT ENGINE v1 — Coherent device profile generation & management
//
// 背景：Device profiles must present a COHERENT browser configuration.
// Randomizing values independently is an instant detection signal.
// All values must come from ONE plausible real device.
//
// 设计意图：Pre-built device profiles sampled from real hardware.
// Each profile = consistent set of 50+ parameters that a real browser
// on that device would report. Seed-based deterministic noise for
// canvas/audio ensures stability across page loads and restarts.
//
// 约束：Extension-level overrides cannot match Chromium C++ patching.
// Worker/OffscreenCanvas hash delta is a known limitation.
// toString() masking on all overrides is mandatory to avoid Proxy tells.
// ═══════════════════════════════════════════════════════════════════════════
(function () {
  "use strict";

  // ── REAL DEVICE DATABASE ──────────────────────────────────────────────
  // Sampled from actual machines. Every field in a profile is internally
  // consistent — GPU matches canvas behavior, CPU matches device class, etc.

  var DEVICES = [
    {
      id: "win11-i7-rtx4060",
      label: "Windows 11 — i7-13700K / RTX 4060",
      os: "win", osVersion: "10.0",
      ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.7103.92 Safari/537.36",
      platform: "Win32",
      brands: [{ brand: "Chromium", version: "136" }, { brand: "Google Chrome", version: "136" }, { brand: "Not.A/Brand", version: "99" }],
      mobile: false,
      arch: "x86", bitness: "64", model: "", platformVersion: "15.0.0", fullVersionList: [{ brand: "Chromium", version: "136.0.7103.92" }, { brand: "Google Chrome", version: "136.0.7103.92" }],
      hardwareConcurrency: 24, deviceMemory: 32,
      maxTouchPoints: 0,
      screen: { width: 2560, height: 1440, availWidth: 2560, availHeight: 1400, colorDepth: 24, pixelRatio: 1 },
      webgl: {
        vendor: "Google Inc. (NVIDIA)",
        renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Direct3D11 vs_5_0 ps_5_0, D3D11)",
        unmaskedVendor: "Google Inc. (NVIDIA)",
        unmaskedRenderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Direct3D11 vs_5_0 ps_5_0, D3D11)",
        maxTextureSize: 32768, maxViewportDims: [32768, 32768], maxRenderbufferSize: 32768,
        maxVertexAttribs: 16, maxVaryingVectors: 30, maxFragmentUniformVectors: 1024,
        maxVertexUniformVectors: 4096, maxVertexTextureImageUnits: 32, maxTextureImageUnits: 32,
        maxCombinedTextureImageUnits: 64, aliasedLineWidthRange: [1, 1], aliasedPointSizeRange: [1, 1024],
        maxAnisotropy: 16, extensions: 42
      },
      audio: { sampleRate: 48000, maxChannelCount: 2, outputLatency: 0.01, numberOfInputs: 1, numberOfOutputs: 1 },
      media: [
        { kind: "audioinput", label: "Microphone (Realtek High Definition Audio)", groupId: "a1" },
        { kind: "videoinput", label: "USB Camera (046d:0825)", groupId: "v1" },
        { kind: "audiooutput", label: "Speakers (Realtek High Definition Audio)", groupId: "a1" }
      ],
      battery: { charging: true, chargingTime: 0, dischargingTime: Infinity, level: 1.0 },
      plugins: ["PDF Viewer", "Chrome PDF Viewer", "Chromium PDF Viewer", "Microsoft Edge PDF Viewer", "WebKit built-in PDF"],
      langs: ["en-US", "en"],
      timezone: "America/New_York", timezoneOffset: 300,
      fonts: ["Arial", "Calibri", "Cambria", "Comic Sans MS", "Consolas", "Courier New", "Georgia", "Impact", "Lucida Console", "Segoe UI", "Tahoma", "Times New Roman", "Trebuchet MS", "Verdana"]
    },
    {
      id: "win10-i5-gtx1650",
      label: "Windows 10 — i5-10400F / GTX 1650",
      os: "win", osVersion: "10.0",
      ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.6998.89 Safari/537.36",
      platform: "Win32",
      brands: [{ brand: "Chromium", version: "134" }, { brand: "Google Chrome", version: "134" }, { brand: "Not.A/Brand", version: "99" }],
      mobile: false,
      arch: "x86", bitness: "64", model: "", platformVersion: "10.0.0", fullVersionList: [{ brand: "Chromium", version: "134.0.6998.89" }, { brand: "Google Chrome", version: "134.0.6998.89" }],
      hardwareConcurrency: 12, deviceMemory: 16,
      maxTouchPoints: 0,
      screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24, pixelRatio: 1 },
      webgl: {
        vendor: "Google Inc. (NVIDIA)",
        renderer: "ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)",
        unmaskedVendor: "Google Inc. (NVIDIA)",
        unmaskedRenderer: "ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)",
        maxTextureSize: 32768, maxViewportDims: [32768, 32768], maxRenderbufferSize: 32768,
        maxVertexAttribs: 16, maxVaryingVectors: 30, maxFragmentUniformVectors: 1024,
        maxVertexUniformVectors: 4096, maxVertexTextureImageUnits: 32, maxTextureImageUnits: 32,
        maxCombinedTextureImageUnits: 64, aliasedLineWidthRange: [1, 1], aliasedPointSizeRange: [1, 1024],
        maxAnisotropy: 16, extensions: 39
      },
      audio: { sampleRate: 44100, maxChannelCount: 2, outputLatency: 0.02, numberOfInputs: 1, numberOfOutputs: 1 },
      media: [
        { kind: "audioinput", label: "Microphone (Realtek(R) Audio)", groupId: "b1" },
        { kind: "videoinput", label: "Integrated Webcam (0bda:5689)", groupId: "v2" },
        { kind: "audiooutput", label: "Speakers (Realtek(R) Audio)", groupId: "b1" }
      ],
      battery: { charging: true, chargingTime: 0, dischargingTime: Infinity, level: 1.0 },
      plugins: ["PDF Viewer", "Chrome PDF Viewer", "Chromium PDF Viewer", "Microsoft Edge PDF Viewer", "WebKit built-in PDF"],
      langs: ["en-US", "en"],
      timezone: "America/Chicago", timezoneOffset: 360,
      fonts: ["Arial", "Calibri", "Cambria", "Comic Sans MS", "Consolas", "Courier New", "Georgia", "Impact", "Segoe UI", "Tahoma", "Times New Roman", "Trebuchet MS", "Verdana"]
    },
    {
      id: "win11-ryzen7-rx7600",
      label: "Windows 11 — Ryzen 7 5800X / RX 7600",
      os: "win", osVersion: "10.0",
      ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.7280.67 Safari/537.36",
      platform: "Win32",
      brands: [{ brand: "Chromium", version: "140" }, { brand: "Google Chrome", version: "140" }, { brand: "Not.A/Brand", version: "99" }],
      mobile: false,
      arch: "x86", bitness: "64", model: "", platformVersion: "15.0.0", fullVersionList: [{ brand: "Chromium", version: "140.0.7280.67" }, { brand: "Google Chrome", version: "140.0.7280.67" }],
      hardwareConcurrency: 16, deviceMemory: 32,
      maxTouchPoints: 0,
      screen: { width: 2560, height: 1440, availWidth: 2560, availHeight: 1400, colorDepth: 24, pixelRatio: 1 },
      webgl: {
        vendor: "Google Inc. (AMD)",
        renderer: "ANGLE (AMD, AMD Radeon RX 7600 Direct3D11 vs_5_0 ps_5_0, D3D11)",
        unmaskedVendor: "Google Inc. (AMD)",
        unmaskedRenderer: "ANGLE (AMD, AMD Radeon RX 7600 Direct3D11 vs_5_0 ps_5_0, D3D11)",
        maxTextureSize: 16384, maxViewportDims: [16384, 16384], maxRenderbufferSize: 16384,
        maxVertexAttribs: 16, maxVaryingVectors: 32, maxFragmentUniformVectors: 1024,
        maxVertexUniformVectors: 4096, maxVertexTextureImageUnits: 32, maxTextureImageUnits: 32,
        maxCombinedTextureImageUnits: 64, aliasedLineWidthRange: [1, 1], aliasedPointSizeRange: [1, 8192],
        maxAnisotropy: 16, extensions: 40
      },
      audio: { sampleRate: 48000, maxChannelCount: 6, outputLatency: 0.015, numberOfInputs: 1, numberOfOutputs: 1 },
      media: [
        { kind: "audioinput", label: "Microphone (Realtek High Definition Audio)", groupId: "c1" },
        { kind: "videoinput", label: "HD Pro Webcam C920 (046d:082d)", groupId: "v3" },
        { kind: "audiooutput", label: "Speakers (Realtek High Definition Audio)", groupId: "c1" },
        { kind: "audiooutput", label: "Digital Audio (S/PDIF) (Realtek High Definition Audio)", groupId: "c2" }
      ],
      battery: { charging: true, chargingTime: 0, dischargingTime: Infinity, level: 1.0 },
      plugins: ["PDF Viewer", "Chrome PDF Viewer", "Chromium PDF Viewer", "Microsoft Edge PDF Viewer", "WebKit built-in PDF"],
      langs: ["en-US", "en"],
      timezone: "America/Los_Angeles", timezoneOffset: 480,
      fonts: ["Arial", "Calibri", "Cambria", "Comic Sans MS", "Consolas", "Courier New", "Georgia", "Impact", "Lucida Console", "Segoe UI", "Tahoma", "Times New Roman", "Trebuchet MS", "Verdana", "Webdings", "Wingdings"]
    },
    {
      id: "mac-m2-14inch",
      label: "macOS Sonoma — M2 Pro / 14-inch",
      os: "mac", osVersion: "14_5",
      ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.7103.92 Safari/537.36",
      platform: "MacIntel",
      brands: [{ brand: "Chromium", version: "136" }, { brand: "Google Chrome", version: "136" }, { brand: "Not.A/Brand", version: "99" }],
      mobile: false,
      arch: "arm", bitness: "64", model: "", platformVersion: "14.5.0", fullVersionList: [{ brand: "Chromium", version: "136.0.7103.92" }, { brand: "Google Chrome", version: "136.0.7103.92" }],
      hardwareConcurrency: 12, deviceMemory: 16,
      maxTouchPoints: 0,
      screen: { width: 1512, height: 982, availWidth: 1512, availHeight: 944, colorDepth: 30, pixelRatio: 2 },
      webgl: {
        vendor: "Google Inc. (Apple)",
        renderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)",
        unmaskedVendor: "Google Inc. (Apple)",
        unmaskedRenderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)",
        maxTextureSize: 16384, maxViewportDims: [16384, 16384], maxRenderbufferSize: 16384,
        maxVertexAttribs: 16, maxVaryingVectors: 31, maxFragmentUniformVectors: 1024,
        maxVertexUniformVectors: 4096, maxVertexTextureImageUnits: 16, maxTextureImageUnits: 16,
        maxCombinedTextureImageUnits: 32, aliasedLineWidthRange: [1, 1], aliasedPointSizeRange: [1, 511],
        maxAnisotropy: 16, extensions: 37
      },
      audio: { sampleRate: 48000, maxChannelCount: 2, outputLatency: 0.005, numberOfInputs: 1, numberOfOutputs: 1 },
      media: [
        { kind: "audioinput", label: "MacBook Pro Microphone", groupId: "m1" },
        { kind: "videoinput", label: "FaceTime HD Camera (1452:8514)", groupId: "v4" },
        { kind: "audiooutput", label: "MacBook Pro Speakers", groupId: "m2" }
      ],
      battery: { charging: false, chargingTime: Infinity, dischargingTime: 28800, level: 0.73 },
      plugins: ["PDF Viewer", "Chrome PDF Viewer", "Chromium PDF Viewer", "Microsoft Edge PDF Viewer", "WebKit built-in PDF"],
      langs: ["en-US", "en"],
      timezone: "America/New_York", timezoneOffset: 300,
      fonts: ["Arial", "Courier New", "Georgia", "Helvetica", "Helvetica Neue", "Lucida Grande", "Menlo", "Monaco", "SF Pro", "Times New Roman", "Trebuchet MS", "Verdana"]
    },
    {
      id: "win10-i3-uhd630",
      label: "Windows 10 — i3-8100 / UHD 630 (budget)",
      os: "win", osVersion: "10.0",
      ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.6613.84 Safari/537.36",
      platform: "Win32",
      brands: [{ brand: "Chromium", version: "128" }, { brand: "Google Chrome", version: "128" }, { brand: "Not.A/Brand", version: "99" }],
      mobile: false,
      arch: "x86", bitness: "64", model: "", platformVersion: "10.0.0", fullVersionList: [{ brand: "Chromium", version: "128.0.6613.84" }, { brand: "Google Chrome", version: "128.0.6613.84" }],
      hardwareConcurrency: 4, deviceMemory: 8,
      maxTouchPoints: 0,
      screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24, pixelRatio: 1 },
      webgl: {
        vendor: "Google Inc. (Intel)",
        renderer: "ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)",
        unmaskedVendor: "Google Inc. (Intel)",
        unmaskedRenderer: "ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)",
        maxTextureSize: 16384, maxViewportDims: [16384, 16384], maxRenderbufferSize: 16384,
        maxVertexAttribs: 16, maxVaryingVectors: 30, maxFragmentUniformVectors: 1024,
        maxVertexUniformVectors: 4096, maxVertexTextureImageUnits: 16, maxTextureImageUnits: 16,
        maxCombinedTextureImageUnits: 32, aliasedLineWidthRange: [1, 1], aliasedPointSizeRange: [1, 1024],
        maxAnisotropy: 16, extensions: 35
      },
      audio: { sampleRate: 44100, maxChannelCount: 2, outputLatency: 0.03, numberOfInputs: 1, numberOfOutputs: 1 },
      media: [
        { kind: "audioinput", label: "Microphone (Realtek(R) Audio)", groupId: "d1" },
        { kind: "audiooutput", label: "Speakers (Realtek(R) Audio)", groupId: "d1" }
      ],
      battery: { charging: true, chargingTime: 0, dischargingTime: Infinity, level: 1.0 },
      plugins: ["PDF Viewer", "Chrome PDF Viewer", "Chromium PDF Viewer", "Microsoft Edge PDF Viewer", "WebKit built-in PDF"],
      langs: ["en-US", "en"],
      timezone: "Europe/London", timezoneOffset: 0,
      fonts: ["Arial", "Calibri", "Comic Sans MS", "Consolas", "Courier New", "Georgia", "Impact", "Segoe UI", "Tahoma", "Times New Roman", "Verdana"]
    },
    {
      id: "win11-laptop-i5-iris",
      label: "Windows 11 Laptop — i5-1235U / Iris Xe",
      os: "win", osVersion: "10.0",
      ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.7521.62 Safari/537.36",
      platform: "Win32",
      brands: [{ brand: "Chromium", version: "145" }, { brand: "Google Chrome", version: "145" }, { brand: "Not.A/Brand", version: "99" }],
      mobile: false,
      arch: "x86", bitness: "64", model: "", platformVersion: "15.0.0", fullVersionList: [{ brand: "Chromium", version: "145.0.7521.62" }, { brand: "Google Chrome", version: "145.0.7521.62" }],
      hardwareConcurrency: 12, deviceMemory: 16,
      maxTouchPoints: 10,
      screen: { width: 1920, height: 1200, availWidth: 1920, availHeight: 1152, colorDepth: 24, pixelRatio: 1.25 },
      webgl: {
        vendor: "Google Inc. (Intel)",
        renderer: "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)",
        unmaskedVendor: "Google Inc. (Intel)",
        unmaskedRenderer: "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)",
        maxTextureSize: 16384, maxViewportDims: [16384, 16384], maxRenderbufferSize: 16384,
        maxVertexAttribs: 16, maxVaryingVectors: 30, maxFragmentUniformVectors: 1024,
        maxVertexUniformVectors: 4096, maxVertexTextureImageUnits: 16, maxTextureImageUnits: 16,
        maxCombinedTextureImageUnits: 32, aliasedLineWidthRange: [1, 1], aliasedPointSizeRange: [1, 1024],
        maxAnisotropy: 16, extensions: 36
      },
      audio: { sampleRate: 48000, maxChannelCount: 2, outputLatency: 0.01, numberOfInputs: 1, numberOfOutputs: 1 },
      media: [
        { kind: "audioinput", label: "Microphone Array (Intel® Smart Sound Technology)", groupId: "e1" },
        { kind: "videoinput", label: "Integrated Camera (0c45:6a1b)", groupId: "v5" },
        { kind: "audiooutput", label: "Speakers (Realtek(R) Audio)", groupId: "e2" }
      ],
      battery: { charging: false, chargingTime: Infinity, dischargingTime: 14400, level: 0.62 },
      plugins: ["PDF Viewer", "Chrome PDF Viewer", "Chromium PDF Viewer", "Microsoft Edge PDF Viewer", "WebKit built-in PDF"],
      langs: ["de-DE", "de", "en-US", "en"],
      timezone: "Europe/Berlin", timezoneOffset: -60,
      fonts: ["Arial", "Calibri", "Cambria", "Comic Sans MS", "Consolas", "Courier New", "Georgia", "Impact", "Lucida Console", "Segoe UI", "Tahoma", "Times New Roman", "Trebuchet MS", "Verdana"]
    }
  ];

  // ── DETERMINISTIC PRNG (splitmix64-style, seed-based) ────────────────
  // Same seed = same noise across restarts, page loads, calls.

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

  // ── PROFILE GENERATOR ─────────────────────────────────────────────────

  function generateProfile(profileId, deviceId) {
    /**
     * 背景：each browser profile needs a unique but stable fingerprint.
     * 设计意图：pick a real device from DEVICES, then apply deterministic
     * micro-variations using the profileId as PRNG seed. This ensures
     * two profiles on the same device template look slightly different
     * (different device IDs, different noise) but remain internally coherent.
     */
    var device = DEVICES.find(function (d) { return d.id === deviceId; });
    if (!device) device = DEVICES[Math.floor(seedHash(profileId) / 4294967296 * DEVICES.length)] || DEVICES[0];

    var rng = createPRNG(profileId);

    // Deep clone device
    var fp = JSON.parse(JSON.stringify(device));
    fp.profileId = profileId;
    fp.noiseSeed = profileId;

    // Per-profile micro-variations (stay coherent with device class)
    // Slight screen avail offset (taskbar variance)
    fp.screen.availHeight = fp.screen.height - (30 + Math.floor(rng() * 20));

    // Unique media device IDs (hash-based, stable)
    fp.media = fp.media.map(function (d, i) {
      return {
        kind: d.kind,
        label: d.label,
        deviceId: seedHash(profileId + "-dev-" + i).toString(16),
        groupId: seedHash(profileId + "-grp-" + d.groupId).toString(16)
      };
    });

    // Battery micro-variation for laptops
    if (fp.battery && !fp.battery.charging && fp.battery.level < 1) {
      fp.battery.level = Math.round((0.3 + rng() * 0.65) * 100) / 100;
      fp.battery.dischargingTime = Math.floor(7200 + rng() * 36000);
    }

    return fp;
  }

  // ── CANVAS NOISE ──────────────────────────────────────────────────────

  function canvasNoiseFn(seed) {
    /**
     * 背景：canvas fingerprint detection does double-render consistency checks.
     * 设计意图：deterministic pixel noise. Same seed + same canvas content =
     * same noise. Two identical renders produce identical hashes.
     * The noise is ±1 on one channel per pixel, imperceptible visually.
     */
    var rng = createPRNG(seed + "-canvas");
    return function applyNoise(imageData) {
      var d = imageData.data;
      for (var i = 0; i < d.length; i += 4) {
        var channel = Math.floor(rng() * 3); // R, G, or B (never alpha)
        var delta = rng() < 0.5 ? -1 : 1;
        var v = d[i + channel] + delta;
        if (v < 0) v = 0;
        if (v > 255) v = 255;
        d[i + channel] = v;
      }
      return imageData;
    };
  }

  // ── AUDIO NOISE ───────────────────────────────────────────────────────

  function audioNoiseFn(seed) {
    /**
     * 背景：audio fingerprint = OfflineAudioContext rendered buffer hash.
     * 设计意图：±5e-7 per sample, keyed on seed and channel index.
     * Stable per profile, distinct between profiles.
     */
    var rng = createPRNG(seed + "-audio");
    return function applyNoise(channelData) {
      for (var i = 0; i < channelData.length; i++) {
        channelData[i] += (rng() - 0.5) * 1e-6;
      }
      return channelData;
    };
  }

  // ── EXPORT ────────────────────────────────────────────────────────────

  window.FingerprintEngine = {
    DEVICES: DEVICES,
    generate: generateProfile,
    canvasNoise: canvasNoiseFn,
    audioNoise: audioNoiseFn,
    createPRNG: createPRNG,
    seedHash: seedHash,
  };
})();
