// ═══════════════════════════════════════════════════════════════════════════
// DEVICE CONFIG BRIDGE — ISOLATED world content script at document_start
//
// inject-fingerprint.js runs in the page's MAIN world and has no access to
// extension APIs. This bridge, registered next to it (chrome.scripting
// registerContentScripts, only while a device profile window is open), asks
// the service worker for the config of the window this frame belongs to
// (background.js answers from chrome.storage.session "agentDeviceWindow:<id>"),
// writes it into a <script type="application/json"> element the MAIN world
// can read, and fires an event. Frames in other windows get null and nothing
// happens.
//
// This is the fallback path. Tabs the panel knows about get the config through
// the DevTools protocol before any page script runs; the round-trip here is
// asynchronous, so the MAIN-world side only applies it while no page script
// has run yet.
// ═══════════════════════════════════════════════════════════════════════════
(function () {
  "use strict";
  var CONFIG_ELEMENT = "__fp_config__";
  var CONFIG_EVENT = "__agent_device_config";

  try {
    chrome.runtime.sendMessage({ type: "deviceConfig" }, function (cfg) {
      if (chrome.runtime.lastError || !cfg || !cfg.ua) return;
      var root = document.documentElement || document.head || document.body;
      if (!root) return;
      var el = document.createElement("script");
      el.id = CONFIG_ELEMENT;
      el.type = "application/json";
      el.textContent = JSON.stringify(cfg);
      root.appendChild(el);
      document.dispatchEvent(new Event(CONFIG_EVENT));
      // The MAIN-world script removes the element when it reads it; if it isn't there, leave no trace.
      if (el.parentNode) el.remove();
    });
  } catch (e) {
    // No extension context (the extension was reloaded) — the page keeps its real values.
  }
})();
