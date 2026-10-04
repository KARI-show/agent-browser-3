// ═══════════════════════════════════════════════════════════════════════════
// FP-BRIDGE — ISOLATED world content script at document_start
//
// 背景：inject-fingerprint.js runs in MAIN world and can't access
// chrome.storage. This bridge runs in ISOLATED world, reads the active
// profile's fingerprint config, and injects it as a hidden <script> tag
// for the MAIN world script to consume.
//
// 设计意图：Dual-world architecture. ISOLATED handles storage/messaging,
// MAIN handles API overrides. The config is passed via a DOM element
// that's removed immediately by the MAIN script.
//
// 约束：Must run at document_start before any page scripts.
// ═══════════════════════════════════════════════════════════════════════════
(async function () {
  "use strict";

  try {
    var data = await chrome.storage.local.get(["agentActiveFingerprint"]);
    var fp = data.agentActiveFingerprint;
    if (!fp || !fp.ua) return; // No active fingerprint — pass through real values

    // Inject config into page DOM for MAIN world script to read
    var script = document.createElement("script");
    script.id = "__fp_config__";
    script.type = "application/json";
    script.textContent = JSON.stringify(fp);
    (document.documentElement || document.head || document.body || document).appendChild(script);
  } catch (e) {
    // Extension context not available (e.g. chrome:// pages) — skip silently
  }
})();
