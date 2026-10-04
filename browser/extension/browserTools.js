// Browser tools the agent calls through the host (declared in
// browser/host/tools.ts). They run in the side panel page, which has the
// chrome.tabs / chrome.scripting / chrome.debugger APIs, and act on one
// "current" tab: the active tab of this panel's window unless the agent
// switched or opened one. The same file is imported by the service worker
// (background.js) so watchers can run with the panel closed — nothing here
// may touch `window` or the panel's DOM (globalThis + chrome.* only).
//
// Every call through AgentBrowserTools.run() is traced: what ran, with which
// arguments, on which element (a durable locator captured at snapshot time),
// and how it went. Recipes (automation.js) are built from that trace.
//
// How it stays reliable:
//  - read_page injects into EVERY frame (cross-origin iframes included) and
//    walks open shadow roots; elements get global refs that map back to
//    {documentId, local index}, so an action lands in the right frame and a
//    navigated-away page is detected instead of clicking the wrong thing.
//  - actions check that the element is actually clickable (not covered) and
//    verify the page reacted; when a synthetic event changed nothing they
//    retry once with real input through the DevTools protocol (the same
//    mechanism Playwright/Puppeteer use). Chrome shows its standard
//    "started debugging this browser" bar while that is attached.
// Page-side functions are injected with chrome.scripting.executeScript, so
// each must be self-contained (no closures over this file).
(function () {
  var currentTabId = null;
  var refTables = {}; // tabId -> { n: { documentId, local, loc } } from the last snapshot
  var lastTab = null; // { id, url, title } of the tab the last tool call worked on (for the trace)

  var STALE = "That element is gone — the page changed. Call browser_read_page again.";
  var inWorker = typeof window === "undefined"; // background.js (service worker) vs the side panel

  function auto() {
    if (!globalThis.AgentAutomation) throw new Error("The automation module (recipes, watchers, memory) didn't load.");
    return globalThis.AgentAutomation;
  }

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }
  function text(t) {
    return [{ type: "text", text: t }];
  }

  // The agent must never work on the extension's own pages (settings hold the API key and proxy).
  var OWN_ORIGIN = chrome.runtime.getURL("");
  function ownPage(tab) {
    return !!(tab && tab.url && tab.url.indexOf(OWN_ORIGIN) === 0);
  }

  async function currentTab() {
    var tab = null;
    if (currentTabId !== null) {
      try {
        tab = await chrome.tabs.get(currentTabId);
      } catch (_) {
        currentTabId = null; // closed — fall back to whatever is active
      }
    }
    if (!tab) {
      var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      tab = tabs[0];
      if (tab && ownPage(tab)) {
        // The panel itself is the active tab (opened as a tab, or popped out): work on the page used just before.
        var all = await chrome.tabs.query({ windowId: tab.windowId });
        var pages = all.filter(function (t) { return !ownPage(t) && /^https?:/i.test(t.url || ""); });
        pages.sort(function (a, b) { return (b.lastAccessed || 0) - (a.lastAccessed || 0); });
        tab = pages[0] || tab;
      }
      if (!tab) throw new Error("No active tab in this window.");
      currentTabId = tab.id;
    }
    if (ownPage(tab)) {
      currentTabId = null; // don't stay pinned to a page we refuse to operate
      throw new Error("That is the extension's own page — the agent doesn't operate it. Switch to a website tab (browser_tabs, browser_switch_tab).");
    }
    lastTab = { id: tab.id, url: tab.url || "", title: tab.title || "" };
    return tab;
  }

  // Resolve once the tab stops loading (or after `timeout`). The short initial
  // delay lets a click-triggered navigation actually start first.
  async function settle(tabId, timeout) {
    var deadline = Date.now() + (timeout || 15000);
    await sleep(300);
    while (Date.now() < deadline) {
      var t = await chrome.tabs.get(tabId);
      if (t.status === "complete") return t;
      await sleep(200);
    }
    return chrome.tabs.get(tabId);
  }

  // Downscale a data-URL image so its longest side is at most maxSide. Done at
  // capture time because history sent to the model must never be edited later.
  async function shrinkImage(dataUrl, maxSide) {
    try {
      var bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
      var scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
      if (scale >= 1) {
        bmp.close();
        return dataUrl;
      }
      var w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
      var canvas = new OffscreenCanvas(w, h);
      canvas.getContext("2d").drawImage(bmp, 0, 0, w, h);
      bmp.close();
      var blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.7 });
      return await new Promise(function (resolve, reject) {
        var r = new FileReader();
        r.onload = function () { resolve(r.result); };
        r.onerror = reject;
        r.readAsDataURL(blob);
      });
    } catch (_) {
      return dataUrl; // never fail a screenshot over resizing
    }
  }

  function explainScriptError(e, tab) {
    var msg = String((e && e.message) || e);
    if (/showing error page/i.test(msg)) {
      return new Error("The page failed to load (the browser is showing an error page — wrong address, 404 or no connection). Check the URL or go back.");
    }
    if (/cannot be scripted|cannot access|chrome:\/\/|extensions gallery|Missing host permission/i.test(msg)) {
      return new Error("This page (" + ((tab && tab.url) || "browser page") + ") can't be automated — navigate to a regular website first.");
    }
    return e;
  }

  // Inject into the top frame only.
  async function inTop(func, args, world) {
    var tab = await currentTab();
    try {
      var results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: func,
        args: args || [],
        world: world || "ISOLATED",
      });
      var r = results && results[0] ? results[0].result : undefined;
      if (r && r.error) throw new Error(r.error);
      return r;
    } catch (e) {
      throw explainScriptError(e, tab);
    }
  }

  // Inject into every frame; returns [{frameId, documentId, result}].
  async function inAllFrames(func, args) {
    var tab = await currentTab();
    try {
      return await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: func,
        args: args || [],
        world: "ISOLATED",
      });
    } catch (e) {
      throw explainScriptError(e, tab);
    }
  }

  var NAVIGATED = { navigated: true };

  // Run the action in the target frame. When the main frame navigates while a
  // click is in flight, the executeScript promise for the destroyed document
  // never settles (Chrome neither resolves nor rejects it), so it is raced
  // against a navigation signal and we stop waiting the moment the tab starts
  // loading a new document. Only clicks pass navigationOk; every other action
  // waits for its real result.
  function runAction(tabId, target, func, args) {
    return chrome.scripting.executeScript({ target: target, func: func, args: args, world: "ISOLATED" });
  }
  function runActionOrNavigate(tabId, target, func, args) {
    var onUpdated;
    var navigated = new Promise(function (resolve) {
      onUpdated = function (id, info) {
        if (id === tabId && (info.url || info.status === "loading")) resolve(NAVIGATED);
      };
      chrome.tabs.onUpdated.addListener(onUpdated);
    });
    return Promise.race([runAction(tabId, target, func, args), navigated]).finally(function () {
      chrome.tabs.onUpdated.removeListener(onUpdated);
    });
  }

  // Run a function inside the frame that owns `ref`. If the document that
  // produced the ref is gone the ref is stale. `navigationOk`: the action may
  // legitimately destroy the document (a click that navigates).
  async function act(tabId, ref, func, args, navigationOk) {
    var entry = (refTables[tabId] || {})[ref];
    if (!entry) throw new Error("No element [" + ref + "] — call browser_read_page first (refs come from it).");
    var target = { tabId: tabId, documentIds: [entry.documentId] };
    try {
      var probe = await chrome.scripting.executeScript({ target: target, func: function () { return 1; } });
      if (!probe || !probe[0]) throw new Error("gone");
    } catch (_) {
      throw new Error(STALE);
    }
    try {
      var callArgs = [entry.local].concat(args || []);
      var res = navigationOk
        ? await runActionOrNavigate(tabId, target, func, callArgs)
        : await runAction(tabId, target, func, callArgs);
      if (res === NAVIGATED) return { navigated: true };
      var r = res && res[0] ? res[0].result : undefined;
      // A click that navigates destroys the document while its result is being
      // collected: executeScript then yields undefined or null.
      if (r === undefined || r === null) return navigationOk ? { navigated: true } : { error: STALE };
      if (r && r.error === "stale") throw new Error(STALE);
      return r;
    } catch (e) {
      if (e && e.message === STALE) throw e;
      // The document vanished mid-action: the click navigated away.
      if (navigationOk) return { navigated: true };
      throw new Error(STALE);
    }
  }

  // Only web pages: file://, chrome-extension://, data:, javascript: and browser-internal pages would let a
  // page steer the agent to local files or to the extension's own settings.
  function normalizeUrl(u) {
    u = String(u || "").trim();
    if (!u) throw new Error("url is required");
    var full = /^[a-z][\w+.-]*:/i.test(u) ? u : "https://" + u;
    if (!/^https?:\/\//i.test(full)) throw new Error("Only http(s) addresses can be opened (got \"" + u.slice(0, 40) + "\").");
    return full;
  }

  async function pageLine() {
    var t = await chrome.tabs.get((await currentTab()).id);
    return "Now at: " + (t.title || "(untitled)") + " — " + t.url;
  }

  // ---------------------------------------------------------------------------
  // Real input through the DevTools protocol (fallback + hover/keys).

  var attached = {};
  var detachTimers = {};
  // Tabs whose DevTools session must stay open: a UA override (Network.setUserAgentOverride) lives only
  // while the debugger is attached, so detaching after the usual idle period silently reverted it.
  var pinned = {};

  chrome.debugger.onDetach.addListener(function (source) {
    delete attached[source.tabId];
    delete deviceReady[source.tabId]; // the new-document script and the emulation died with the session
  });

  async function cdp(tabId, method, params, retried) {
    if (!attached[tabId]) {
      try {
        await chrome.debugger.attach({ tabId: tabId }, "1.3");
      } catch (e) {
        var msg = String((e && e.message) || e);
        if (/already attached/i.test(msg)) {
          try { await chrome.debugger.detach({ tabId: tabId }); } catch (_) {}
          await chrome.debugger.attach({ tabId: tabId }, "1.3");
        } else {
          throw e;
        }
      }
      attached[tabId] = true;
    }
    clearTimeout(detachTimers[tabId]);
    if (!pinned[tabId]) {
      detachTimers[tabId] = setTimeout(function () {
        delete attached[tabId];
        chrome.debugger.detach({ tabId: tabId }).catch(function () {});
      }, 8000);
    }
    try {
      return await chrome.debugger.sendCommand({ tabId: tabId }, method, params || {});
    } catch (e) {
      // The user dismissed the debugging bar (onDetach may not have run yet): attach again, once.
      if (!retried && /not attached|Detached while/i.test(String((e && e.message) || e))) {
        delete attached[tabId];
        return cdp(tabId, method, params, true);
      }
      throw e;
    }
  }

  async function cdpMove(tabId, x, y) {
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: x, y: y });
  }

  async function cdpClick(tabId, x, y, double) {
    await cdpMove(tabId, x, y);
    for (var n = 1; n <= (double ? 2 : 1); n++) {
      await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x: x, y: y, button: "left", clickCount: n });
      await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x: x, y: y, button: "left", clickCount: n });
    }
  }

  var KEY_TABLE = {
    Enter: { code: "Enter", vk: 13, text: "\r" },
    Escape: { code: "Escape", vk: 27 },
    Tab: { code: "Tab", vk: 9 },
    Backspace: { code: "Backspace", vk: 8 },
    Delete: { code: "Delete", vk: 46 },
    ArrowUp: { code: "ArrowUp", vk: 38 },
    ArrowDown: { code: "ArrowDown", vk: 40 },
    ArrowLeft: { code: "ArrowLeft", vk: 37 },
    ArrowRight: { code: "ArrowRight", vk: 39 },
    PageUp: { code: "PageUp", vk: 33 },
    PageDown: { code: "PageDown", vk: 34 },
    Home: { code: "Home", vk: 36 },
    End: { code: "End", vk: 35 },
    Space: { key: " ", code: "Space", vk: 32, text: " " },
  };
  var MODS = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Cmd: 4, Command: 4, Shift: 8 };
  var EDIT_COMMANDS = { a: "selectAll", c: "copy", v: "paste", x: "cut", z: "undo", y: "redo" };

  // A printable character as a key event: letters and digits get their real code/VK, anything else is
  // delivered by its text alone.
  function charKey(ch) {
    if (/[a-z]/i.test(ch)) return { key: ch, code: "Key" + ch.toUpperCase(), vk: ch.toUpperCase().charCodeAt(0), text: ch };
    if (/[0-9]/.test(ch)) return { key: ch, code: "Digit" + ch, vk: ch.charCodeAt(0), text: ch };
    return { key: ch, code: "", vk: 0, text: ch };
  }

  async function cdpKey(tabId, combo) {
    var parts = String(combo).split("+");
    var key = parts.pop() || "+";
    var mods = 0;
    parts.forEach(function (m) { mods |= MODS[m] || 0; });
    var def = KEY_TABLE[key] || (key.length === 1 ? charKey(key) : null);
    if (!def) throw new Error("Unsupported key: " + combo);
    var base = { key: def.key || key, code: def.code, modifiers: mods };
    // Only letters and digits have a virtual-key code we can state; a wrong one is worse than none
    // ("." upper-cased is 46 = VK_DELETE and would delete instead of typing a dot).
    if (def.vk) { base.windowsVirtualKeyCode = def.vk; base.nativeVirtualKeyCode = def.vk; }
    var hasText = def.text && !(mods & (1 | 2 | 4));
    var down = Object.assign({ type: hasText ? "keyDown" : "rawKeyDown" }, base);
    if (hasText) down.text = def.text;
    if ((mods & (2 | 4)) && EDIT_COMMANDS[key.toLowerCase()]) down.commands = [EDIT_COMMANDS[key.toLowerCase()]];
    await cdp(tabId, "Input.dispatchKeyEvent", down);
    await cdp(tabId, "Input.dispatchKeyEvent", Object.assign({ type: "keyUp" }, base));
  }

  // ---------------------------------------------------------------------------
  // Page-side functions (serialised into the tab / frame).

  function pageSnapshot(maxEls, textBudget) {
    var SEL =
      'a[href],button,input,textarea,select,summary,[role=button],[role=link],[role=checkbox],' +
      '[role=radio],[role=tab],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=option],' +
      '[role=switch],[role=combobox],[role=textbox],[role=searchbox],[role=slider],[role=treeitem],' +
      '[contenteditable=""],[contenteditable=true],[draggable=true],[onclick],[tabindex]:not([tabindex="-1"])';
    var refs = [];
    window.__agentRefs = refs;
    var vw = window.innerWidth, vh = window.innerHeight;
    var shadowTexts = [];
    var pointerChecks = 0;

    function visible(el) {
      try {
        if (el.checkVisibility) return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
      } catch (_) {}
      return el.getClientRects().length > 0;
    }
    function clean(s, n) {
      return String(s || "").replace(/\s+/g, " ").trim().slice(0, n);
    }
    function byId(el, id) {
      var root = el.getRootNode();
      return (root.getElementById ? root.getElementById(id) : null) || document.getElementById(id);
    }
    function nameOf(el) {
      var t = el.getAttribute("aria-label");
      if (t && t.trim()) return t;
      var lb = el.getAttribute("aria-labelledby");
      if (lb) {
        var s = lb.split(/\s+/).map(function (id) { var n = byId(el, id); return n ? n.textContent : ""; }).join(" ").trim();
        if (s) return s;
      }
      var tag = el.localName;
      if (tag === "input") {
        var ty = (el.type || "").toLowerCase();
        if (ty === "button" || ty === "submit" || ty === "reset") return el.value;
        if (ty === "image") return el.alt || el.value;
      }
      if (tag === "input" || tag === "textarea" || tag === "select") {
        if (el.labels && el.labels.length) {
          return Array.prototype.map.call(el.labels, function (l) { return l.innerText || l.textContent; }).join(" ");
        }
        return el.getAttribute("title") || el.getAttribute("placeholder") || el.getAttribute("name") || el.id || "";
      }
      var it = (el.innerText || el.textContent || "").trim();
      if (it) return it;
      var img = el.querySelector && el.querySelector("img[alt],svg title");
      if (img) return img.getAttribute("alt") || img.textContent;
      return el.getAttribute("title") || el.getAttribute("alt") || el.getAttribute("name") || el.id || "";
    }
    function shadowText(root) {
      var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      var out = [], n;
      while ((n = w.nextNode())) {
        var pn = n.parentNode && n.parentNode.localName;
        if (pn === "style" || pn === "script") continue;
        var v = n.nodeValue.replace(/\s+/g, " ").trim();
        if (v) out.push(v);
      }
      return out.join(" ");
    }

    var POINTER_TAGS = /^(div|span|li|img|svg|td|tr|i|p|section|article)$/;
    function isCandidate(el) {
      if (el.matches(SEL)) {
        if (el.localName === "input" && el.type === "hidden") return false;
        return true;
      }
      // Framework-built "buttons": a div/span with cursor:pointer and a name.
      if (POINTER_TAGS.test(el.localName) && pointerChecks < 4000) {
        pointerChecks++;
        if (getComputedStyle(el).cursor !== "pointer") return false;
        var p = el.parentElement;
        if (p && getComputedStyle(p).cursor === "pointer") return false;
        return !!(el.getAttribute("aria-label") || el.getAttribute("title") || (el.innerText || "").trim() || (el.querySelector && el.querySelector("img[alt]")));
      }
      return false;
    }

    var found = [];
    function collect(root, depth) {
      var all = root.querySelectorAll("*");
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (el.shadowRoot && depth < 8) {
          var st = shadowText(el.shadowRoot);
          if (st) shadowTexts.push(st);
          collect(el.shadowRoot, depth + 1);
        }
        if (!isCandidate(el)) continue;
        var isFile = el.localName === "input" && el.type === "file";
        var r = el.getBoundingClientRect();
        if (!isFile && (r.width < 2 || r.height < 2 || !visible(el))) continue;
        // A wrapper whose only role is holding an inner control adds noise.
        if (el.matches("[tabindex],[onclick]") && !el.matches("a,button,input,textarea,select,[role]") && el.querySelector(SEL)) continue;
        var inView = r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
        found.push({ el: el, inView: inView, hidden: isFile && (r.width < 2 || r.height < 2 || !visible(el)) });
      }
    }
    collect(document, 0);

    // Modal dialog: what the user could actually interact with right now.
    var modal = null;
    var dialogs = document.querySelectorAll('dialog[open],[role=dialog],[role=alertdialog],[aria-modal=true]');
    for (var d = dialogs.length - 1; d >= 0; d--) {
      var dr = dialogs[d].getBoundingClientRect();
      if (dr.width > 40 && dr.height > 40 && visible(dialogs[d])) { modal = dialogs[d]; break; }
    }
    function inModal(el) {
      if (!modal) return false;
      if (modal.contains(el)) return true;
      var root = el.getRootNode();
      return !!(root && root.host && modal.contains(root.host));
    }

    var picked = found
      .filter(function (f) { return f.inView || f.hidden; })
      .concat(found.filter(function (f) { return !f.inView && !f.hidden; }))
      .slice(0, maxEls);
    var pickedSet = new Set(picked.map(function (f) { return f.el; }));
    var ordered = found.filter(function (f) { return pickedSet.has(f.el); });

    var elements = ordered.map(function (f) {
      var el = f.el;
      refs.push(el);
      var tag = el.localName;
      var role = el.getAttribute("role");
      var type = tag === "input" ? (el.getAttribute("type") || "text").toLowerCase() : "";
      var kind = role || (type ? "input:" + type : tag === "a" ? "link" : tag);
      if (type === "file") kind = "file input" + (f.hidden ? " (hidden)" : "");
      else if (el.isContentEditable && !role) kind = "editable";
      else if (!role && !el.matches("a,button,input,textarea,select,summary")) kind = "clickable";
      var label = clean(nameOf(el), 80);
      var extra = [];
      if (tag === "input" || tag === "textarea") {
        if (el.placeholder && el.placeholder !== label) extra.push('placeholder="' + clean(el.placeholder, 40) + '"');
        if (type === "password") {
          if (el.value) extra.push("value=(hidden)");
        } else if (type === "checkbox" || type === "radio") {
          extra.push(el.checked ? "checked" : "unchecked");
        } else if (type !== "file" && el.value) {
          extra.push('value="' + clean(el.value, 60) + '"');
        }
        if (el.required) extra.push("required");
      } else if (tag === "select") {
        var opt = el.options[el.selectedIndex];
        extra.push('selected="' + clean(opt ? opt.text : "", 40) + '"');
        extra.push("options: " + Array.prototype.slice.call(el.options, 0, 8).map(function (o) { return clean(o.text, 25); }).join(" | ") + (el.options.length > 8 ? " …" : ""));
      } else if (el.isContentEditable && el.innerText) {
        extra.push('text="' + clean(el.innerText, 60) + '"');
      }
      var aria = el.getAttribute("aria-checked") || el.getAttribute("aria-selected") || el.getAttribute("aria-pressed") || el.getAttribute("aria-expanded");
      if (aria) extra.push((el.hasAttribute("aria-expanded") ? "expanded=" : "state=") + aria);
      if (el.disabled || el.getAttribute("aria-disabled") === "true") extra.push("disabled");
      if (tag === "a") {
        var href = el.getAttribute("href") || "";
        if (href && !/^javascript:/i.test(href)) extra.push("→ " + clean(href, 70));
      }
      if (!f.inView && !f.hidden) extra.push("(off-screen)");
      // What still identifies this element after the page re-renders (recipes replay by it, not by ref).
      // Generated ids (React/Ember/Radix, hashes, counters) are left out — they change on every load.
      var id = el.id && /^[A-Za-z][\w-]{0,40}$/.test(el.id) && !/\d{3,}|^(ember|react|radix|headlessui|mui|yui|ext|__)/i.test(el.id) ? el.id : "";
      var href = "";
      if (tag === "a") {
        var raw = el.getAttribute("href") || "";
        if (raw && !/^(javascript:|#|mailto:|tel:)/i.test(raw)) {
          try { var u = new URL(raw, location.href); href = (u.pathname + u.search).slice(0, 120); } catch (_) { href = raw.slice(0, 120); }
        }
      }
      var formy = tag === "input" || tag === "textarea" || tag === "select" || tag === "button";
      var loc = {
        kind: kind,
        text: label,
        id: id,
        test: el.getAttribute("data-testid") || el.getAttribute("data-test") || el.getAttribute("data-cy") || el.getAttribute("data-qa") || "",
        name: formy ? el.getAttribute("name") || "" : "",
        ph: tag === "input" || tag === "textarea" ? clean(el.placeholder, 60) : "",
        href: href,
      };
      return {
        kind: kind,
        label: label,
        extra: extra.join(" "),
        inModal: inModal(el),
        local: refs.length,
        loc: loc,
      };
    });

    var headings = [];
    document.querySelectorAll("h1,h2,h3,[role=heading]").forEach(function (h) {
      if (headings.length >= 30 || !visible(h)) return;
      var t = clean(h.innerText || h.textContent, 90);
      if (!t) return;
      var lvl = h.localName.length === 2 && h.localName[0] === "h" ? +h.localName[1] : +(h.getAttribute("aria-level") || 2);
      headings.push(new Array(lvl + 1).join("#") + " " + t);
    });

    var body = document.body ? document.body.innerText : "";
    body = body.replace(/\n{3,}/g, "\n\n").trim();
    var shadow = shadowTexts.join("\n").slice(0, 1500);
    var docH = document.documentElement.scrollHeight;
    var modalLabel = "";
    if (modal) {
      modalLabel = clean(modal.getAttribute("aria-label") || (modal.querySelector("h1,h2,h3,[role=heading]") || {}).innerText || modal.innerText, 60);
    }
    return {
      url: location.href,
      title: document.title,
      isTop: window === window.top,
      scroll: "y=" + Math.round(window.scrollY) + " of " + Math.max(0, docH - vh) + " (viewport " + vh + "px)",
      total: found.length,
      elements: elements,
      headings: headings,
      modal: modal ? modalLabel || "(untitled dialog)" : null,
      text: body.length > textBudget ? body.slice(0, textBudget) + "\n… (truncated — scroll or use browser_find)" : body,
      shadowText: shadow,
    };
  }

  function pageClick(local, force, dbl) {
    var el = (window.__agentRefs || [])[local - 1]; if (el && !el.isConnected) el = null;
    if (!el) return { error: "stale" };
    el.scrollIntoView({ block: "center", inline: "center" });
    function describe(n) {
      if (!n) return "another element";
      var s = n.localName + (n.id ? "#" + n.id : "");
      var t = (n.innerText || n.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 50);
      return s + (t ? ' "' + t + '"' : "");
    }
    function stateOf(n) {
      return JSON.stringify([n.checked, n.type === "password" ? "" : n.value, n.getAttribute("aria-expanded"), n.getAttribute("aria-checked"), n.getAttribute("aria-pressed"), n.getAttribute("aria-selected"), n.open, n.className, n.disabled]);
    }
    return new Promise(function (resolve) {
      setTimeout(function () {
        var r = el.getBoundingClientRect();
        var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        var root = el.getRootNode();
        var hit = (root.elementFromPoint ? root : document).elementFromPoint(cx, cy);
        while (hit && hit.shadowRoot) {
          var inner = hit.shadowRoot.elementFromPoint(cx, cy);
          if (!inner || inner === hit) break;
          hit = inner;
        }
        var lab = hit && hit.closest ? hit.closest("label") : null;
        var related = !hit || hit === el || el.contains(hit) || hit.contains(el) ||
          (lab && lab.control === el) ||
          (hit.getRootNode() && hit.getRootNode().host && (hit.getRootNode().host === el || el.contains(hit.getRootNode().host)));
        if (!related && !force) {
          return resolve({ error: "Element [" + local + "] is covered by " + describe(hit) + " — dismiss or close that first (or pass force=true)." });
        }
        var before = stateOf(el);
        var url0 = location.href;
        var mutations = 0;
        var mo = new MutationObserver(function (m) { mutations += m.length; });
        var moOpts = { subtree: true, childList: true, attributes: true, characterData: true };
        mo.observe(document.documentElement, moOpts);
        // Mutations inside shadow roots don't reach a document-level observer:
        // watch each enclosing root, or a working click looks like a dead one
        // and gets repeated.
        for (var sr = el.getRootNode(); sr && sr.host; sr = sr.host.getRootNode()) mo.observe(sr, moOpts);
        var o = { bubbles: true, cancelable: true, composed: true, view: window, button: 0, clientX: cx, clientY: cy };
        el.dispatchEvent(new PointerEvent("pointerover", o));
        el.dispatchEvent(new MouseEvent("mouseover", o));
        el.dispatchEvent(new PointerEvent("pointerdown", Object.assign({ buttons: 1 }, o)));
        el.dispatchEvent(new MouseEvent("mousedown", Object.assign({ buttons: 1 }, o)));
        if (typeof el.focus === "function") el.focus({ preventScroll: true });
        el.dispatchEvent(new PointerEvent("pointerup", o));
        el.dispatchEvent(new MouseEvent("mouseup", o));
        el.click();
        if (dbl) {
          el.click();
          el.dispatchEvent(new MouseEvent("dblclick", Object.assign({ detail: 2 }, o)));
        }
        setTimeout(function () {
          mo.disconnect();
          resolve({
            ok: true,
            x: cx, y: cy,
            top: window === window.top,
            effect: mutations > 0 || stateOf(el) !== before || location.href !== url0,
          });
        }, 450);
      }, 60);
    });
  }

  function pageFingerprint() {
    var b = document.body;
    return location.href + "|" + (b ? b.innerText.length : 0) + "|" + document.getElementsByTagName("*").length;
  }

  function pageQuiet(maxMs, quietMs) {
    return new Promise(function (resolve) {
      var last = Date.now();
      var mo = new MutationObserver(function () { last = Date.now(); });
      mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      var start = Date.now();
      (function tick() {
        if (Date.now() - last >= quietMs || Date.now() - start >= maxMs) { mo.disconnect(); resolve(true); }
        else setTimeout(tick, 60);
      })();
    });
  }

  function pageType(local, value, clear, submit) {
    var el = (window.__agentRefs || [])[local - 1];
    if (!el || !el.isConnected) return { error: "stale" };
    function readValue(n) {
      if (n.isContentEditable) return n.innerText || n.textContent || "";
      return "value" in n ? n.value : "";
    }
    if (el instanceof HTMLInputElement && el.type === "file") return { error: "Element [" + local + "] is a file input — use browser_upload_file." };
    el.scrollIntoView({ block: "center" });
    el.focus();
    var prev = readValue(el);
    if (el.isContentEditable) {
      if (clear) document.execCommand("selectAll", false);
      document.execCommand("insertText", false, value);
    } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      // The prototype setter bypasses React's value tracking, so its onChange fires.
      var proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      var setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      setter.call(el, clear ? value : el.value + value);
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      return { error: "Element [" + local + "] is not a text field." };
    }
    // Wait a beat and read back: controlled inputs (React etc.) can revert a
    // programmatic change right after our synchronous check would have passed.
    return new Promise(function (resolve) {
      setTimeout(function () {
        var now = readValue(el);
        var want = clear ? value : prev + value;
        var isPassword = el.type === "password";
        // Inputs can normalise (e.g. dates, numbers); accept "contains" too.
        var verified = isPassword ? now.length > 0 : now === want || now.replace(/\s+/g, " ").trim().indexOf(value.replace(/\s+/g, " ").trim().slice(0, 60)) !== -1;
        if (verified && submit) {
          var k = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
          var go = el.dispatchEvent(new KeyboardEvent("keydown", k));
          el.dispatchEvent(new KeyboardEvent("keypress", k));
          el.dispatchEvent(new KeyboardEvent("keyup", k));
          // Synthetic Enter doesn't trigger implicit form submission; do it
          // explicitly unless a page handler already took the key.
          if (go && el.form && !(el instanceof HTMLTextAreaElement)) {
            if (typeof el.form.requestSubmit === "function") el.form.requestSubmit();
            else el.form.submit();
          }
        }
        resolve({ ok: true, verified: verified });
      }, 120);
    });
  }

  function pageFieldKind(local) {
    // What kind of form field a ref is, so fill_form can pick the right action for it.
    var el = (window.__agentRefs || [])[local - 1];
    if (!el || !el.isConnected) return { error: "stale" };
    if (el instanceof HTMLSelectElement) return { kind: "select" };
    if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) return { kind: "toggle", checked: el.checked };
    return { kind: "text" };
  }

  function pageFocusForTyping(local) {
    var el = (window.__agentRefs || [])[local - 1]; if (el && !el.isConnected) el = null;
    if (!el) return { error: "stale" };
    el.scrollIntoView({ block: "center" });
    el.focus();
    return { ok: true };
  }

  function pageReadValue(local) {
    var el = (window.__agentRefs || [])[local - 1];
    if (!el || !el.isConnected) return { error: "stale" };
    var v = el.isContentEditable ? el.innerText || el.textContent || "" : "value" in el ? el.value : "";
    return { ok: true, value: v, password: el.type === "password" };
  }

  function pageRect(local) {
    var el = (window.__agentRefs || [])[local - 1]; if (el && !el.isConnected) el = null;
    if (!el) return { error: "stale" };
    el.scrollIntoView({ block: "center", inline: "center" });
    var r = el.getBoundingClientRect();
    return { ok: true, x: r.left + r.width / 2, y: r.top + r.height / 2, top: window === window.top };
  }

  function pageSelect(local, option) {
    var el = (window.__agentRefs || [])[local - 1]; if (el && !el.isConnected) el = null;
    if (!el) return { error: "stale" };
    if (!(el instanceof HTMLSelectElement)) return { error: "Element [" + local + "] is not a <select>; click it and pick the option instead." };
    var want = String(option).trim().toLowerCase();
    var match = Array.prototype.find.call(el.options, function (o) {
      return o.value.toLowerCase() === want || o.text.trim().toLowerCase() === want;
    }) || Array.prototype.find.call(el.options, function (o) {
      return o.text.toLowerCase().indexOf(want) !== -1;
    });
    if (!match) return { error: 'No option matching "' + option + '" (options: ' + Array.prototype.slice.call(el.options, 0, 12).map(function (o) { return o.text.trim(); }).join(" | ") + ")." };
    el.value = match.value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, selected: match.text.trim() };
  }

  function pageKey(key) {
    // Synthetic fallback when the debugger can't attach (e.g. another tool holds it).
    var el = document.activeElement || document.body;
    var named = { Enter: 13, Escape: 27, Tab: 9, Backspace: 8, Space: 32, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, PageUp: 33, PageDown: 34, Home: 36, End: 35, Delete: 46 };
    var k = key === "Space" ? " " : key;
    var code = named[key] || (k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0);
    var init = { key: k, code: key.length === 1 ? "Key" + key.toUpperCase() : key, keyCode: code, which: code, bubbles: true, cancelable: true };
    var go = el.dispatchEvent(new KeyboardEvent("keydown", init));
    if (k.length === 1) el.dispatchEvent(new KeyboardEvent("keypress", init));
    el.dispatchEvent(new KeyboardEvent("keyup", init));
    if (!go) return { ok: true };
    if (key === "Enter" && el.form && el.tagName !== "TEXTAREA") {
      if (typeof el.form.requestSubmit === "function") el.form.requestSubmit();
      else el.form.submit();
    } else if (key === "PageDown" || key === "PageUp" || key === "Space") {
      window.scrollBy(0, (key === "PageUp" ? -1 : 1) * window.innerHeight * 0.85);
    } else if (key === "Home" || key === "End") {
      if (!("value" in el)) window.scrollTo(0, key === "Home" ? 0 : document.documentElement.scrollHeight);
    } else if (k.length === 1 && ("value" in el || el.isContentEditable)) {
      document.execCommand("insertText", false, k);
    }
    return { ok: true };
  }

  function pageHover(local) {
    // Synthetic fallback (CSS :hover needs the real pointer, see cdpMove).
    var el = (window.__agentRefs || [])[local - 1]; if (el && !el.isConnected) el = null;
    if (!el) return { error: "stale" };
    el.scrollIntoView({ block: "center", inline: "center" });
    var r = el.getBoundingClientRect();
    var o = { bubbles: true, composed: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    ["pointerover", "pointerenter", "pointermove"].forEach(function (t) { el.dispatchEvent(new PointerEvent(t, o)); });
    ["mouseover", "mouseenter", "mousemove"].forEach(function (t) { el.dispatchEvent(new MouseEvent(t, o)); });
    return { ok: true };
  }

  function pageScroll(local, direction) {
    if (local) {
      var el = (window.__agentRefs || [])[local - 1]; if (el && !el.isConnected) el = null;
      if (!el) return { error: "stale" };
      el.scrollIntoView({ block: "center" });
    } else if (direction === "top") {
      window.scrollTo(0, 0);
    } else if (direction === "bottom") {
      window.scrollTo(0, document.documentElement.scrollHeight);
    } else {
      var before = window.scrollY;
      window.scrollBy(0, (direction === "up" ? -1 : 1) * window.innerHeight * 0.85);
      // Page doesn't scroll (app-style layout)? Scroll the largest scrollable box.
      if (window.scrollY === before) {
        var best = null, area = 0;
        document.querySelectorAll("*").forEach(function (n) {
          if (n.scrollHeight > n.clientHeight + 20 && /(auto|scroll)/.test(getComputedStyle(n).overflowY)) {
            var a = n.clientWidth * n.clientHeight;
            if (a > area) { area = a; best = n; }
          }
        });
        if (best) best.scrollBy(0, (direction === "up" ? -1 : 1) * best.clientHeight * 0.85);
      }
    }
    return { ok: true, y: Math.round(window.scrollY), max: Math.max(0, document.documentElement.scrollHeight - window.innerHeight) };
  }

  function pageDrag(local, toLocal, toText) {
    var from = (window.__agentRefs || [])[local - 1]; if (from && !from.isConnected) from = null;
    var to = toLocal ? (window.__agentRefs || [])[toLocal - 1] : null;
    if (!from) return { error: "stale" };
    if (!toLocal && toText) {
      // Drop zones are usually plain containers with no ref: find the smallest
      // visible element whose text contains the label.
      var want = String(toText).toLowerCase(), best = null, bestLen = Infinity;
      document.querySelectorAll("body *").forEach(function (n) {
        var t = (n.innerText || "").toLowerCase();
        if (t.indexOf(want) !== -1 && t.length < bestLen && n !== from && !from.contains(n) && n.getClientRects().length) { best = n; bestLen = t.length; }
      });
      to = best;
      if (!to) return { error: 'No element containing the text "' + toText + '" in the same frame as the dragged element.' };
    } else if (!to || !to.isConnected) {
      return { error: "Drop target [" + toLocal + "] is not in the same frame as the dragged element, or is gone." };
    }
    from.scrollIntoView({ block: "center", inline: "center" });
    var a = from.getBoundingClientRect();
    var ax = a.left + a.width / 2, ay = a.top + a.height / 2;
    var b0 = to.getBoundingClientRect();
    var bx = b0.left + b0.width / 2, by = b0.top + b0.height / 2;
    var base = { bubbles: true, cancelable: true, composed: true, view: window };
    function fire(node, type, x, y, extra) {
      var Ctor = /^drag|^drop/.test(type) ? DragEvent : /^pointer/.test(type) ? PointerEvent : MouseEvent;
      return node.dispatchEvent(new Ctor(type, Object.assign({ clientX: x, clientY: y, button: 0 }, base, extra || {})));
    }
    var dt = new DataTransfer();
    // Pointer/mouse-driven sortables.
    fire(from, "pointerdown", ax, ay, { buttons: 1 });
    fire(from, "mousedown", ax, ay, { buttons: 1 });
    // HTML5 drag and drop.
    fire(from, "dragstart", ax, ay, { dataTransfer: dt });
    for (var i = 1; i <= 5; i++) {
      var x = ax + ((bx - ax) * i) / 5, y = ay + ((by - ay) * i) / 5;
      fire(document, "pointermove", x, y, { buttons: 1 });
      fire(document, "mousemove", x, y, { buttons: 1 });
      fire(to, "dragenter", x, y, { dataTransfer: dt });
      fire(to, "dragover", x, y, { dataTransfer: dt });
    }
    fire(to, "drop", bx, by, { dataTransfer: dt });
    fire(from, "dragend", bx, by, { dataTransfer: dt });
    fire(to, "pointerup", bx, by);
    fire(to, "mouseup", bx, by);
    return { ok: true };
  }

  function pageUpload(local, name, b64) {
    var el = (window.__agentRefs || [])[local - 1]; if (el && !el.isConnected) el = null;
    if (!el) return { error: "stale" };
    if (!(el instanceof HTMLInputElement) || el.type !== "file") {
      return { error: "Element [" + local + "] is not a file input. Look for \"file input\" entries in browser_read_page." };
    }
    var bin = atob(b64), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    var ext = (name.split(".").pop() || "").toLowerCase();
    var mime = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", pdf: "application/pdf", txt: "text/plain", csv: "text/csv", json: "application/json", zip: "application/zip" }[ext] || "application/octet-stream";
    var dt = new DataTransfer();
    dt.items.add(new File([bytes], name, { type: mime }));
    el.files = dt.files;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, count: el.files.length };
  }

  function pageHasText(needle) {
    var n = String(needle).toLowerCase();
    var body = document.body ? document.body.innerText.toLowerCase() : "";
    if (body.indexOf(n) !== -1) return { has: true };
    var found = false;
    (function walk(root) {
      var all = root.querySelectorAll("*");
      for (var i = 0; i < all.length && !found; i++) {
        if (all[i].shadowRoot) {
          if ((all[i].shadowRoot.textContent || "").toLowerCase().indexOf(n) !== -1) found = true;
          else walk(all[i].shadowRoot);
        }
      }
    })(document);
    return { has: found };
  }

  // Re-apply an override on every load of a tab. One watcher per tab, shared by the UA tools: a new one replaces
  // the old (no stacked listeners); what each wanted done when the tab closes still runs.
  function watchTabLoads(tabId, onLoading, onClose) {
    var all = (globalThis.__agentUaListeners = globalThis.__agentUaListeners || {});
    var prev = all[tabId];
    if (prev) {
      chrome.tabs.onUpdated.removeListener(prev.updated);
      chrome.tabs.onRemoved.removeListener(prev.removed);
    }
    var closers = (prev ? prev.closers : []).concat(onClose ? [onClose] : []);
    var updated = function (id, info) {
      if (id === tabId && info.status === "loading") onLoading();
    };
    var removed = function (id) {
      if (id !== tabId) return;
      chrome.tabs.onUpdated.removeListener(updated);
      chrome.tabs.onRemoved.removeListener(removed);
      delete all[tabId];
      closers.forEach(function (f) { f(); });
    };
    all[tabId] = { updated: updated, removed: removed, closers: closers };
    chrome.tabs.onUpdated.addListener(updated);
    chrome.tabs.onRemoved.addListener(removed);
  }

  function pageUaOverride(ua, platform, langs) {
    // Runs in the page's MAIN world on every load of the overridden tab.
    function pin(key, value) {
      try { Object.defineProperty(navigator, key, { get: function () { return value; }, configurable: true }); } catch (_) {}
    }
    pin("userAgent", ua);
    if (platform) pin("platform", platform);
    if (langs.length) {
      pin("language", langs[0]);
      pin("languages", Object.freeze(langs.slice()));
    }
  }

  // ---------------------------------------------------------------------------
  // User-Agent presets: realistic current browser/OS pairs with version pools, used by device
  // profiles (tools and the 👤 panel alike — one generator, so they can't drift).

  var UA_POOLS = {
    chrome: ["120.0.6099.130", "122.0.6261.94", "124.0.6367.91", "126.0.6478.126", "128.0.6613.84", "130.0.6723.58", "132.0.6834.110", "134.0.6998.89", "136.0.7103.92", "140.0.7280.67", "145.0.7521.62", "148.0.7663.56", "150.0.7800.44", "152.0.7920.62"],
    firefox: ["122.0", "125.0", "128.0", "130.0", "132.0", "134.0", "135.0"],
    safari: ["17.0", "17.2", "17.4", "17.5", "18.0", "18.1"],
    edge: ["120.0.2210.77", "130.0.2849.46", "140.0.3498.28", "145.0.3812.59", "150.0.4115.43", "152.0.4234.46"],
    windows: ["10.0"], // Chrome reports NT 10.0 on Windows 11 too — "11.0" never occurs in the wild
    mac: ["13_0", "13_3", "14_0", "14_2", "14_5", "15_0", "15_1"],
    ios: ["16_2", "17_0", "17_2", "17_4", "17_5", "18_0"],
    android: ["12", "13", "14", "15"],
    phones: ["Pixel 7", "Pixel 8", "Pixel 8 Pro", "Pixel 9", "SM-S911B", "SM-S918B", "SM-S928B", "SM-A546B", "M2101K6G", "23078PND5G"],
    languages: ["en-US,en;q=0.9", "en-GB,en;q=0.9", "de-DE,de;q=0.9,en;q=0.8", "fr-FR,fr;q=0.9,en;q=0.8", "es-ES,es;q=0.9,en;q=0.8", "ru-RU,ru;q=0.9,en;q=0.8", "ja-JP,ja;q=0.9,en;q=0.8", "zh-CN,zh;q=0.9,en;q=0.8", "pt-BR,pt;q=0.9,en;q=0.8", "ko-KR,ko;q=0.9,en;q=0.8", "tr-TR,tr;q=0.9,en;q=0.8"],
  };
  function pick(a) { return a[Math.floor(Math.random() * a.length)]; }
  var WK = " AppleWebKit/537.36 (KHTML, like Gecko) ";
  var UA_PRESETS = {
    "win-chrome": function () { var v = pick(UA_POOLS.chrome); return { ua: "Mozilla/5.0 (Windows NT " + pick(UA_POOLS.windows) + "; Win64; x64)" + WK + "Chrome/" + v + " Safari/537.36", platform: "Win32", label: "Windows · Chrome " + v.split(".")[0] }; },
    "win-edge": function () { var v = pick(UA_POOLS.edge); return { ua: "Mozilla/5.0 (Windows NT " + pick(UA_POOLS.windows) + "; Win64; x64)" + WK + "Chrome/" + v + " Safari/537.36 Edg/" + v, platform: "Win32", label: "Windows · Edge " + v.split(".")[0] }; },
    "win-firefox": function () { var v = pick(UA_POOLS.firefox); return { ua: "Mozilla/5.0 (Windows NT " + pick(UA_POOLS.windows) + "; Win64; x64; rv:" + v + ") Gecko/20100101 Firefox/" + v, platform: "Win32", label: "Windows · Firefox " + v }; },
    "mac-chrome": function () { var v = pick(UA_POOLS.chrome); return { ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X " + pick(UA_POOLS.mac) + ")" + WK + "Chrome/" + v + " Safari/537.36", platform: "MacIntel", label: "macOS · Chrome " + v.split(".")[0] }; },
    "mac-safari": function () { var v = pick(UA_POOLS.safari); return { ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X " + pick(UA_POOLS.mac) + ") AppleWebKit/605.1.15 (KHTML, like Gecko) Version/" + v + " Safari/605.1.15", platform: "MacIntel", label: "macOS · Safari " + v }; },
    "iphone": function () { var v = pick(UA_POOLS.safari); return { ua: "Mozilla/5.0 (iPhone; CPU iPhone OS " + pick(UA_POOLS.ios) + " like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/" + v + " Mobile/15E148 Safari/604.1", platform: "iPhone", label: "iPhone · Safari " + v }; },
    "android": function () { var d = pick(UA_POOLS.phones), v = pick(UA_POOLS.chrome); return { ua: "Mozilla/5.0 (Linux; Android " + pick(UA_POOLS.android) + "; " + d + ")" + WK + "Chrome/" + v + " Mobile Safari/537.36", platform: "Linux armv8l", label: "Android · " + d }; },
    "linux": function () { var v = pick(UA_POOLS.chrome); return { ua: "Mozilla/5.0 (X11; Linux x86_64)" + WK + "Chrome/" + v + " Safari/537.36", platform: "Linux x86_64", label: "Linux · Chrome " + v.split(".")[0] }; },
  };
  /** A preset by name ("win-chrome", …), or a random one. → { ua, platform, label, lang, type } */
  function uaPreset(type) {
    var key = UA_PRESETS[type] ? type : pick(Object.keys(UA_PRESETS));
    var r = UA_PRESETS[key]();
    r.type = key;
    r.lang = pick(UA_POOLS.languages);
    return r;
  }

  // ---------------------------------------------------------------------------
  // The identity a tab presents, for as long as the tab lives: User-Agent / platform / language
  // (browser_set_useragent, profiles) and, for a device profile, its device config (fingerprint.js
  // configFor → inject-fingerprint.js). Everything rides on the tab's DevTools session, which stays
  // attached (pinned): the request headers (Network.setUserAgentOverride, client hints included), the
  // page script installed before any page script runs (Page.addScriptToEvaluateOnNewDocument), the time
  // zone and CPU-thread emulation, and the same for cross-origin frames, which are targets of their own
  // (Target.setAutoAttach). navigator.* is also pinned in the MAIN world on every load — belt and braces
  // for the UA-only case. A dismissed debugging bar ends the session: the next load re-applies it all.

  var identities = {}; // tabId -> { ua, platform, lang, langs, device: config | null }
  var deviceReady = {}; // tabId -> { identifier } while the new-document script is installed on the live session
  var deviceScriptText = null; // inject-fingerprint.js, fetched once

  function engine() { return globalThis.FingerprintEngine || null; }

  async function deviceScript(cfg) {
    if (deviceScriptText === null) deviceScriptText = await (await fetch(chrome.runtime.getURL("inject-fingerprint.js"))).text();
    var marker = "null; /*__DEVICE_CONFIG__*/";
    if (deviceScriptText.indexOf(marker) === -1) throw new Error("inject-fingerprint.js has no config marker");
    return deviceScriptText.replace(marker, JSON.stringify(cfg) + ";");
  }

  function uaOverrideParams(id) {
    var p = { userAgent: id.ua, platform: id.platform || "", acceptLanguage: id.lang || "" };
    var meta = id.device && engine() ? engine().uaMetadata(id.device) : null;
    if (meta) p.userAgentMetadata = meta;
    return p;
  }

  // (Re)apply a tab's identity to its DevTools session. Cheap when already in place.
  async function applyIdentity(tabId) {
    var id = identities[tabId];
    if (!id) return;
    var params = uaOverrideParams(id);
    try {
      await cdp(tabId, "Network.setUserAgentOverride", params);
    } catch (e) {
      if (!params.userAgentMetadata) throw e;
      delete params.userAgentMetadata; // an older browser without client-hint overrides: the UA still goes through
      await cdp(tabId, "Network.setUserAgentOverride", params);
    }
    if (!id.device || deviceReady[tabId]) return;
    // The Page domain must be on for the script to run in the documents to come (not only the current one).
    await cdp(tabId, "Page.enable");
    var r = await cdp(tabId, "Page.addScriptToEvaluateOnNewDocument", { source: await deviceScript(id.device), runImmediately: true });
    deviceReady[tabId] = { identifier: r && r.identifier };
    var swallow = function () {};
    if (id.device.timezone) await cdp(tabId, "Emulation.setTimezoneOverride", { timezoneId: id.device.timezone }).catch(swallow);
    if (id.device.hardwareConcurrency) await cdp(tabId, "Emulation.setHardwareConcurrencyOverride", { hardwareConcurrency: id.device.hardwareConcurrency }).catch(swallow);
    // Cross-origin frames: attach to them as they appear, paused, so the identity is in place before their
    // first script (Target.attachedToTarget below installs it and resumes them).
    await cdp(tabId, "Target.setAutoAttach", AUTO_ATTACH).catch(swallow);
  }

  var AUTO_ATTACH = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true };

  // Every context of the extension (this panel, other panels, the service worker) sees the event. The one
  // that holds the tab's identity installs it and resumes the frame at once; the others resume it after a
  // grace period — a safety net so that no frame stays paused if the panel that attached is gone.
  chrome.debugger.onEvent.addListener(function (source, method, params) {
    if (method !== "Target.attachedToTarget" || !params || !params.sessionId) return;
    var id = identities[source.tabId];
    var info = params.targetInfo || {};
    var target = { tabId: source.tabId, sessionId: params.sessionId };
    var run = function (m, p) { return chrome.debugger.sendCommand(target, m, p || {}).catch(function () {}); };
    var resume = function () { if (params.waitingForDebugger) return run("Runtime.runIfWaitingForDebugger"); };
    if (!id) {
      setTimeout(function () { resume(); }, 1500);
      return;
    }
    (async function () {
      if (id.device && (info.type === "iframe" || info.type === "page")) {
        await run("Network.setUserAgentOverride", uaOverrideParams(id));
        await run("Page.enable");
        await run("Page.addScriptToEvaluateOnNewDocument", { source: await deviceScript(id.device), runImmediately: true });
        if (id.device.timezone) await run("Emulation.setTimezoneOverride", { timezoneId: id.device.timezone });
        if (id.device.hardwareConcurrency) await run("Emulation.setHardwareConcurrencyOverride", { hardwareConcurrency: id.device.hardwareConcurrency });
        await run("Target.setAutoAttach", AUTO_ATTACH);
      } else if (/worker/.test(info.type || "")) {
        await run("Network.setUserAgentOverride", uaOverrideParams(id));
      }
    })().catch(function () {}).then(resume);
  });

  // Give a tab an identity: { ua, platform, lang, device } (device = a config from FingerprintEngine.configFor,
  // or null for User-Agent only). Shared by browser_set_useragent and profile launches.
  async function setIdentity(tabId, id) {
    id = Object.assign({}, id);
    id.langs = id.lang ? id.lang.split(",").map(function (s) { return s.replace(/;q=[\d.]+/, "").trim(); }).filter(Boolean) : [];
    var prev = identities[tabId];
    identities[tabId] = id;
    pinned[tabId] = true;
    clearTimeout(detachTimers[tabId]);
    // A device config is a different script: drop the one installed for the previous identity.
    if (deviceReady[tabId] && (!prev || JSON.stringify(prev.device) !== JSON.stringify(id.device))) {
      if (deviceReady[tabId].identifier) await cdp(tabId, "Page.removeScriptToEvaluateOnNewDocument", { identifier: deviceReady[tabId].identifier }).catch(function () {});
      delete deviceReady[tabId];
    }
    var inPage = function () {
      return chrome.scripting.executeScript({ target: { tabId: tabId }, world: "MAIN", func: pageUaOverride, args: [id.ua, id.platform || "", id.langs] });
    };
    await applyIdentity(tabId);
    await inPage().catch(function () {}); // a blank/new tab has no document yet; the load watcher covers it
    watchTabLoads(
      tabId,
      function () {
        // Re-attach if the user dismissed the debugging bar, then re-pin navigator.* in the new document.
        applyIdentity(tabId).catch(function () {});
        inPage().catch(function () {});
      },
      function () { delete pinned[tabId]; delete identities[tabId]; delete deviceReady[tabId]; }
    );
  }

  /** The device config a tab presents, or null. */
  function deviceOf(tabId) {
    return identities[tabId] ? identities[tabId].device : null;
  }

  function pageRunJs(code) {
    // Runs in the page's MAIN world (page CSP applies).
    function show(v) {
      if (v === undefined) return "undefined";
      if (typeof v === "string") return v;
      try { return JSON.stringify(v, null, 2); } catch (_) { return String(v); }
    }
    try {
      var value = (0, eval)(code);
      return Promise.resolve(value).then(
        function (v) { return { ok: true, value: show(v).slice(0, 20000) }; },
        function (e) { return { error: "Rejected: " + String((e && e.message) || e) }; }
      );
    } catch (e) {
      return { error: String((e && e.message) || e) };
    }
  }

  // ---------------------------------------------------------------------------
  // Network capture (browser_network_capture): per tab, the JSON/text responses seen since start.

  var captures = {}; // tabId -> { filter, entries: [{ requestId, method, url, status, mime, size, body }], pending }
  var CAPTURE_MIMES = /json|javascript|text\/plain|xml|graphql|csv/i;
  var BODY_CAP = 300000;

  chrome.debugger.onEvent.addListener(function (source, method, params) {
    var c = captures[source.tabId];
    if (!c || !params) return;
    if (method === "Network.requestWillBeSent") {
      var req = params.request || {};
      if (c.filter && String(req.url || "").indexOf(c.filter) === -1) return;
      if (params.type && !/^(XHR|Fetch|Document|Other)$/.test(params.type)) return;
      c.pending[params.requestId] = { method: req.method || "GET", url: req.url || "", type: params.type };
    } else if (method === "Network.responseReceived") {
      var p = c.pending[params.requestId];
      if (!p) return;
      var res = params.response || {};
      p.status = res.status;
      p.mime = res.mimeType || "";
      if (!CAPTURE_MIMES.test(p.mime) && !(params.type === "XHR" || params.type === "Fetch")) delete c.pending[params.requestId];
    } else if (method === "Network.loadingFinished") {
      var done = c.pending[params.requestId];
      if (!done) return;
      delete c.pending[params.requestId];
      done.requestId = params.requestId;
      done.size = params.encodedDataLength || 0;
      done.body = null; // fetched lazily; CDP keeps bodies while the session lives
      c.entries.push(done);
      if (c.entries.length > c.max) c.entries.shift();
    } else if (method === "Network.loadingFailed") {
      delete c.pending[params.requestId];
    }
  });

  async function fetchBody(tabId, entry) {
    try {
      var r = await cdp(tabId, "Network.getResponseBody", { requestId: entry.requestId });
      var body = r.base64Encoded ? "(binary, " + Math.round((r.body.length * 3) / 4) + " bytes)" : String(r.body || "");
      if (/json/i.test(entry.mime) || /^[\[{]/.test(body.trim())) {
        try { body = JSON.stringify(JSON.parse(body), null, 1); } catch (_) {}
      }
      entry.body = body.length > BODY_CAP ? body.slice(0, BODY_CAP) + "\n… (body truncated at 300 KB)" : body;
    } catch (e) {
      entry.body = "(body no longer available: " + String((e && e.message) || e) + ")";
    }
    return entry.body;
  }

  // ---------------------------------------------------------------------------
  // Snapshot assembly (all frames).

  var refLabels = {}; // tabId -> { n: "[n] kind \"label\"…" } from the last snapshot (for approval cards)

  async function snapshot(textBudget) {
    var tab = await currentTab();
    var results = await inAllFrames(pageSnapshot, [250, textBudget || 8000]);
    var top = null, subs = [];
    results.forEach(function (r) {
      if (!r || !r.result) return;
      (r.result.isTop ? (top = r) : subs.push(r));
    });
    if (!top) throw new Error("This page can't be read (it may still be loading). Try again in a moment.");

    var table = {};
    var lines = [], budget = 320, n = 0;
    var modalLabel = null;
    var frames = [top].concat(subs.filter(function (f) {
      return f.result.elements.length || f.result.text.trim();
    }).slice(0, 8));
    frames.forEach(function (f) { if (f.result.modal && modalLabel === null) modalLabel = f.result.modal; });

    // Modal-first ordering: what the user could actually click comes first.
    var entries = [];
    frames.forEach(function (f, fi) {
      f.result.elements.forEach(function (e) { entries.push({ f: f, fi: fi, e: e }); });
    });
    if (modalLabel !== null) {
      // Frames can't tell whether they sit inside the dialog, so only the top
      // document's elements are ranked by it.
      var inDialog = function (x) { return x.fi > 0 || x.e.inModal; };
      entries = entries.filter(inDialog)
        .concat(entries.filter(function (x) { return !inDialog(x); }).map(function (x) { x.behind = true; return x; }));
    }
    var listed = entries.slice(0, budget);
    var seenKeys = {}; // kind|text|frame -> count, so a repeated label ("Delete" in every row) keeps its ordinal
    listed.forEach(function (x) {
      n++;
      var frame = x.fi === 0 ? "" : frameHost(x.f.result.url);
      var loc = Object.assign({}, x.e.loc || { kind: x.e.kind, text: x.e.label }, { frame: frame });
      var key = loc.kind + "|" + loc.text + "|" + frame;
      loc.nth = seenKeys[key] = (seenKeys[key] || 0) + 1;
      table[n] = { documentId: x.f.documentId, local: x.e.local, loc: loc };
      var where = frame ? " ⧉ frame " + frame : "";
      lines.push("[" + n + "] " + x.e.kind + (x.e.label ? ' "' + x.e.label + '"' : "") + (x.e.extra ? " " + x.e.extra : "") + where + (x.behind ? " (behind dialog)" : ""));
    });
    refTables[tab.id] = table;
    var labels = {};
    lines.forEach(function (l, i) { labels[i + 1] = l.replace(/^\[\d+\] /, ""); });
    refLabels[tab.id] = labels;

    var t = top.result;
    var out = "URL: " + t.url + "\nTitle: " + t.title + "\nScroll: " + t.scroll;
    if (modalLabel !== null) {
      out += '\n\nA dialog is open: "' + modalLabel + '". Its elements are listed first; the page behind it may not respond until it is closed.';
    }
    if (t.headings.length) out += "\n\nOutline:\n" + t.headings.join("\n");
    var totalFound = frames.reduce(function (s, f) { return s + f.result.total; }, 0);
    out += "\n\nInteractive elements (" + lines.length + " of " + totalFound + "):\n" + (lines.join("\n") || "(none)");
    out += "\n\nPage text:\n" + (t.text || "(empty)");
    if (t.shadowText) out += "\n\nText inside web components:\n" + t.shadowText;
    frames.slice(1).forEach(function (f) {
      if (f.result.text.trim()) out += "\n\n--- iframe " + frameHost(f.result.url) + " ---\n" + f.result.text.slice(0, 2500);
    });
    return { text: out, lines: lines, top: t, frames: frames };
  }

  function frameHost(u) {
    try { return new URL(u).host || u; } catch (_) { return u; }
  }

  // ---------------------------------------------------------------------------
  // PDF rendering (DevTools Page.printToPDF — no print dialog).

  function pdfBlob(base64) {
    var bin = atob(base64), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: "application/pdf" });
  }

  // Render a standalone HTML document to PDF: open it in a background tab (a data: URL — its own
  // opaque origin, so untrusted content never runs as the extension), print through DevTools, close.
  async function htmlToPdf(html) {
    var cur = await currentTab().catch(function () { return null; });
    var dataUrl = "data:text/html;charset=utf-8;base64," + btoa(unescape(encodeURIComponent(html)));
    var opts = { url: dataUrl, active: false };
    if (cur) opts.windowId = cur.windowId;
    var tab = await chrome.tabs.create(opts);
    try {
      await settle(tab.id, 10000);
      var pdf = await cdp(tab.id, "Page.printToPDF", { printBackground: true });
      return pdfBlob(pdf.data);
    } finally {
      clearTimeout(detachTimers[tab.id]);
      delete attached[tab.id];
      chrome.debugger.detach({ tabId: tab.id }).catch(function () {});
      chrome.tabs.remove(tab.id).catch(function () {});
    }
  }

  // ---------------------------------------------------------------------------
  // Tool dispatch.

  async function quiet(tabId) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tabId }, func: pageQuiet, args: [2500, 300] });
    } catch (_) { /* page navigating — settle() covers it */ }
  }

  async function fingerprint(tabId) {
    try {
      var r = await chrome.scripting.executeScript({ target: { tabId: tabId }, func: pageFingerprint });
      return r && r[0] ? r[0].result : "";
    } catch (_) {
      return "navigating";
    }
  }

  function short(s) {
    return String(s).replace(/\s+/g, " ").slice(0, 80);
  }

  // The cookie jar of the tab the agent works in: a private (Incognito) window has its own, so cookie
  // tools used there must not touch the user's regular session (chrome.cookies defaults to the panel's).
  async function cookieStoreOf(tab) {
    var stores = await chrome.cookies.getAllCookieStores();
    var s = stores.find(function (st) { return (st.tabIds || []).indexOf(tab.id) !== -1; });
    return s ? s.id : undefined;
  }

  // A URL that scopes to a stored cookie: chrome.cookies.remove/set need one, and a domain cookie's
  // leading dot is not part of any host name.
  function cookieUrl(c) {
    return (c.secure ? "https://" : "http://") + String(c.domain || "").replace(/^\./, "") + (c.path || "/");
  }

  async function removeCookie(c, storeId) {
    var details = { url: cookieUrl(c), name: c.name };
    if (storeId) details.storeId = storeId;
    return !!(await chrome.cookies.remove(details).catch(function () { return null; }));
  }

  // ---------------------------------------------------------------------------
  // Device profiles: storage shared with the 👤 panel (profiles.js).

  var PROFILES_KEY = "agentProfiles";
  var PROFILE_LOG_KEY = "agentProfileLogs";
  var PROXY_BEFORE_KEY = "agentProxyBeforeProfile"; // { profileId, proxy } while a profile's proxy is applied

  async function loadProfiles() {
    return (await chrome.storage.local.get(PROFILES_KEY))[PROFILES_KEY] || {};
  }
  function saveProfiles(profiles) {
    return chrome.storage.local.set({ [PROFILES_KEY]: profiles });
  }
  function proxyLabel(p) {
    return p.proxy && p.proxy.enabled && p.proxy.host ? p.proxy.type + "://" + p.proxy.host + ":" + p.proxy.port : "direct";
  }
  function deviceLine(p) {
    var E = engine();
    var tpl = E && p.device ? E.DEVICES.find(function (d) { return d.id === p.device; }) : null;
    return tpl ? E.describe(tpl) : "User-Agent only (no device template)";
  }
  function deviceTemplatesLine() {
    var E = engine();
    if (!E) return "";
    return "\n\nDevice templates (browser_profile_create device=<id>; 'none' = User-Agent only):\n" +
      E.DEVICES.map(function (d) { return "  " + d.id + " — " + E.describe(d); }).join("\n");
  }
  async function logProfile(pid, action) {
    var logs = (await chrome.storage.local.get(PROFILE_LOG_KEY))[PROFILE_LOG_KEY] || {};
    (logs[pid] = logs[pid] || []).push({ t: Date.now(), a: action });
    if (logs[pid].length > 300) logs[pid] = logs[pid].slice(-300);
    await chrome.storage.local.set({ [PROFILE_LOG_KEY]: logs });
  }

  // The proxy a profile asks for is applied browser-wide (chrome.proxy has no per-window scope).
  // The setting in place before the first profile launch is kept aside and restored by endProfile();
  // a profile without a proxy launched over another profile's proxy goes direct, not through it.
  async function applyProfileProxy(pid, p) {
    var st = await chrome.storage.local.get(["agentProxy", PROXY_BEFORE_KEY]);
    var before = st[PROXY_BEFORE_KEY];
    var want = p.proxy && p.proxy.enabled && p.proxy.host
      ? { enabled: true, type: p.proxy.type || "http", host: p.proxy.host, port: Number(p.proxy.port), username: p.proxy.username || "", password: p.proxy.password || "", profileId: pid }
      : null;
    if (!want && !before) return ""; // nothing to change
    if (!before) await chrome.storage.local.set({ [PROXY_BEFORE_KEY]: { profileId: pid, proxy: st.agentProxy || null } });
    else await chrome.storage.local.set({ [PROXY_BEFORE_KEY]: { profileId: pid, proxy: before.proxy } });
    if (want) await chrome.storage.local.set({ agentProxy: want });
    else if (before.proxy) await chrome.storage.local.set({ agentProxy: before.proxy });
    else await chrome.storage.local.remove("agentProxy");
    await sleep(500); // background.js applies it on the storage change
    var status = (await chrome.storage.session.get("agentProxyStatus")).agentProxyStatus;
    if (want && status && status.state === "error") return " — FAILED: " + status.message + " (traffic is not going through it)";
    return want ? " (browser-wide while this profile is open)" : "";
  }

  async function endProfile(pid) {
    var st = await chrome.storage.local.get([PROXY_BEFORE_KEY, "agentActiveProfile"]);
    var before = st[PROXY_BEFORE_KEY];
    if (before && before.profileId === pid) {
      if (before.proxy) await chrome.storage.local.set({ agentProxy: before.proxy });
      else await chrome.storage.local.remove("agentProxy");
      await chrome.storage.local.remove(PROXY_BEFORE_KEY);
    }
    if (st.agentActiveProfile === pid) await chrome.storage.local.remove("agentActiveProfile");
    Object.keys(profileWindows).forEach(function (w) {
      if (profileWindows[w].pid !== pid) return;
      chrome.tabs.onCreated.removeListener(profileWindows[w].onCreated);
      delete profileWindows[w];
    });
    await forgetDeviceWindows(function (cfg, winId) { return cfg.profileId === pid; });
  }

  // ── Device config delivery ──────────────────────────────────────────────
  // A profile window's device config is kept in chrome.storage.session under "agentDeviceWindow:<id>"
  // (one key per window — the panel and the service worker never rewrite each other's entries): the
  // service worker answers fp-bridge.js from it, and the content-script pair (bridge + page script) is
  // registered only while at least one such window is open (persistAcrossSessions: false — a browser
  // restart clears both). Tabs the panel attaches to get the config through DevTools before any page
  // script; the content scripts are the fallback for a frame that route missed.

  var DEVICE_WINDOW_PREFIX = "agentDeviceWindow:";
  var DEVICE_SCRIPTS = [
    { id: "agent-device-bridge", js: ["fp-bridge.js"], matches: ["<all_urls>"], runAt: "document_start", allFrames: true, matchOriginAsFallback: true, persistAcrossSessions: false },
    { id: "agent-device-config", js: ["inject-fingerprint.js"], matches: ["<all_urls>"], runAt: "document_start", allFrames: true, matchOriginAsFallback: true, world: "MAIN", persistAcrossSessions: false },
  ];
  var profileWindows = {}; // winId -> { pid, identity, onCreated } (this panel's launches)

  async function registeredDeviceScripts() {
    return chrome.scripting.getRegisteredContentScripts({ ids: DEVICE_SCRIPTS.map(function (d) { return d.id; }) });
  }
  async function ensureDeviceScripts() {
    var have = await registeredDeviceScripts();
    var missing = DEVICE_SCRIPTS.filter(function (d) { return !have.some(function (h) { return h.id === d.id; }); });
    if (missing.length) await chrome.scripting.registerContentScripts(missing);
  }
  async function deviceWindows() {
    var all = await chrome.storage.session.get(null);
    var out = {};
    Object.keys(all).forEach(function (k) { if (k.indexOf(DEVICE_WINDOW_PREFIX) === 0) out[k.slice(DEVICE_WINDOW_PREFIX.length)] = all[k]; });
    return out;
  }
  async function forgetDeviceWindows(drop) {
    var map = await deviceWindows();
    var gone = Object.keys(map).filter(function (w) { return drop(map[w], Number(w)); });
    if (gone.length) await chrome.storage.session.remove(gone.map(function (w) { return DEVICE_WINDOW_PREFIX + w; }));
    if (Object.keys(map).length === gone.length) {
      var have = await registeredDeviceScripts();
      if (have.length) await chrome.scripting.unregisterContentScripts({ ids: have.map(function (h) { return h.id; }) });
    }
  }

  // The window is the profile's: tabs opened in it get the identity too, closing it ends the profile.
  async function startProfileWindow(pid, winId, identity) {
    var onCreated = function (t) {
      if (t.windowId !== winId || ownPage(t) || !(identity.ua || identity.device)) return;
      setIdentity(t.id, identity).catch(function () {});
    };
    chrome.tabs.onCreated.addListener(onCreated);
    profileWindows[winId] = { pid: pid, identity: identity, onCreated: onCreated };
    if (identity.device) {
      await chrome.storage.session.set({ [DEVICE_WINDOW_PREFIX + winId]: identity.device });
      await ensureDeviceScripts();
    }
  }

  chrome.windows.onRemoved.addListener(function (winId) {
    var w = profileWindows[winId];
    if (!w) return;
    chrome.tabs.onCreated.removeListener(w.onCreated);
    delete profileWindows[winId];
    endProfile(w.pid).catch(function () {});
  });

  var TOOLS = {
    browser_read_page: async function (a) {
      var s = await snapshot(a.maxChars || 8000);
      // The page text is budgeted inside the snapshot; this is only a safety net for pathological pages.
      var out = s.text.length > 120000 ? s.text.slice(0, 120000) + "\n… (output truncated)" : s.text;
      // Site memory: what was learnt about this site earlier rides along with the first look at it.
      if (globalThis.AgentAutomation) {
        var notes = await globalThis.AgentAutomation.memoryBlock(s.top.url).catch(function () { return ""; });
        if (notes) out += "\n\n" + notes;
      }
      return text(out);
    },

    browser_find: async function (a) {
      var q = String(a.query || "").toLowerCase();
      if (!q) throw new Error("query is required");
      var s = await snapshot();
      var els = s.lines.filter(function (l) { return l.toLowerCase().indexOf(q) !== -1; }).slice(0, 25);
      var body = [s.top.text].concat(s.frames.slice(1).map(function (f) { return f.result.text; })).join("\n");
      var hits = body.split("\n").filter(function (l) { return l.toLowerCase().indexOf(q) !== -1; }).map(short).slice(0, 15);
      if (!els.length && !hits.length) return text('Nothing on the page matches "' + a.query + '". Try another word, scroll, or browser_read_page.');
      return text(
        (els.length ? "Matching elements:\n" + els.join("\n") + "\n\n" : "") +
          (hits.length ? "Matching page text:\n" + hits.join("\n") : "")
      );
    },

    browser_screenshot: async function () {
      var tab = await currentTab();
      if (!tab.active) {
        await chrome.tabs.update(tab.id, { active: true });
        await sleep(300);
      }
      // Background: 1568px + q70 = ~100K tokens per screenshot, убивает контекст за 5 turns.
      // Design: 1024px + q45 = ~15-25K tokens. Для автоматизации хватает с запасом.
      var dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 45 });
      dataUrl = await shrinkImage(dataUrl, 1024);
      return [
        { type: "image", data: dataUrl.slice(dataUrl.indexOf(",") + 1), mimeType: "image/jpeg" },
        { type: "text", text: (tab.title || "") + " — " + tab.url },
      ];
    },

    browser_tabs: async function () {
      var cur = await currentTab();
      var tabs = await chrome.tabs.query({ windowId: cur.windowId });
      return text(
        tabs.map(function (t) {
          return (t.id === cur.id ? "* " : "  ") + t.id + "  " + (t.title || "(untitled)") + " — " + t.url;
        }).join("\n")
      );
    },

    browser_switch_tab: async function (a) {
      var target = await chrome.tabs.get(a.tabId);
      if (ownPage(target)) throw new Error("That is the extension's own page — the agent doesn't operate it.");
      var t = await chrome.tabs.update(a.tabId, { active: true });
      currentTabId = t.id;
      return text(await pageLine());
    },

    browser_wait: async function (a) {
      await sleep(Math.min(20, Math.max(0.2, a.seconds || 1)) * 1000);
      return text(await pageLine());
    },

    browser_wait_for: async function (a) {
      if (!a.text && !a.textGone && !a.urlContains) throw new Error("Give text, textGone or urlContains.");
      var tab = await currentTab();
      var deadline = Date.now() + (a.timeoutSeconds || 15) * 1000;
      async function anyFrameHas(needle) {
        var res = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: pageHasText, args: [needle] }).catch(function () { return []; });
        return res.some(function (r) { return r && r.result && r.result.has; });
      }
      while (Date.now() < deadline) {
        var t = await chrome.tabs.get(tab.id);
        var ok = true;
        if (a.urlContains && (t.url || "").indexOf(a.urlContains) === -1) ok = false;
        if (ok && a.text && !(await anyFrameHas(a.text))) ok = false;
        if (ok && a.textGone && (await anyFrameHas(a.textGone))) ok = false;
        if (ok) return text("Condition met. " + (await pageLine()));
        await sleep(300);
      }
      return text("Timed out — the condition was not met. " + (await pageLine()));
    },

    browser_navigate: async function (a) {
      var tab = await currentTab();
      if (a.action === "back") await chrome.tabs.goBack(tab.id);
      else if (a.action === "forward") await chrome.tabs.goForward(tab.id);
      else if (a.action === "reload") await chrome.tabs.reload(tab.id);
      else await chrome.tabs.update(tab.id, { url: normalizeUrl(a.url) });
      await settle(tab.id, 20000);
      await quiet(tab.id);
      return text(await pageLine());
    },

    browser_new_tab: async function (a) {
      var cur = await currentTab();
      var t = await chrome.tabs.create({ url: normalizeUrl(a.url), windowId: cur.windowId, active: true });
      currentTabId = t.id;
      await settle(t.id, 20000);
      await quiet(t.id);
      return text(await pageLine());
    },

    browser_open_private_window: async function (a) {
      var win;
      try {
        win = await chrome.windows.create({ url: normalizeUrl(a.url || "about:blank"), incognito: true, focused: true });
      } catch (e) {
        throw new Error(
          "Couldn't open a private window (" + ((e && e.message) || e) + "). Turn on \"Allow in Incognito\" " +
          "for Agent Browser at chrome://extensions, then try again."
        );
      }
      var tab = win.tabs && win.tabs[0];
      if (!tab) throw new Error("Couldn't open a private window — no tab came back.");
      currentTabId = tab.id;
      await settle(tab.id, 20000);
      await quiet(tab.id);
      return text("Opened a private (Incognito) window. " + (await pageLine()));
    },

    browser_close_tab: async function (a) {
      var id = a.tabId || (await currentTab()).id;
      await chrome.tabs.remove(id);
      if (id === currentTabId) currentTabId = null;
      return text("Closed tab " + id + ". " + (await pageLine()));
    },

    browser_click: async function (a) {
      var tab = await currentTab();
      var url0 = tab.url;
      var tabsBefore = (await chrome.tabs.query({ windowId: tab.windowId })).map(function (t) { return t.id; });

      // A click that opened a new tab (target=_blank, window.open) — follow it.
      // target=_blank implies noopener, so the new tab carries no openerTabId to
      // match on; diff the window's tab ids instead. Called before the
      // real-mouse retry so a tab already opened isn't opened a second time.
      async function followNewTab() {
        var after = await chrome.tabs.query({ windowId: tab.windowId });
        var fresh = after.filter(function (t) {
          return tabsBefore.indexOf(t.id) === -1 && !ownPage(t);
        });
        if (!fresh.length) return null;
        fresh.sort(function (x, y) { return y.id - x.id; });
        var nt = fresh[0];
        currentTabId = nt.id;
        await chrome.tabs.update(nt.id, { active: true });
        await settle(nt.id, 15000);
        await quiet(nt.id);
        return text("Clicked [" + a.ref + "] — it opened a new tab, now working there. " + (await pageLine()));
      }

      var r = await act(tab.id, a.ref, pageClick, [!!a.force, !!a.double], true);
      if (r.error) throw new Error(r.error);

      var followed = await followNewTab();
      if (followed) return followed;

      var note = "";
      if (!r.navigated) {
        var after = await settle(tab.id, 8000);
        var effect = r.effect || after.url !== url0;
        if (!effect && r.top) {
          // Synthetic click did nothing visible — retry with the real mouse.
          var fp = await fingerprint(tab.id);
          try {
            await cdpClick(tab.id, r.x, r.y, !!a.double);
            await sleep(500);
            await quiet(tab.id);
            followed = await followNewTab();
            if (followed) return followed;
            var moved = (await fingerprint(tab.id)) !== fp || (await chrome.tabs.get(tab.id)).url !== url0;
            note = moved ? " (needed a real mouse click)" : "";
            effect = moved;
          } catch (_) { /* debugger unavailable — report below */ }
        }
        if (!effect) note = " — but the page showed no visible reaction. The element may be inert or disabled, or the result needs more time (browser_wait_for); re-read the page to check.";
      } else {
        await settle(tab.id, 15000);
      }
      await quiet(tab.id);

      var nowTab = await chrome.tabs.get(tab.id).catch(function () { return { url: url0 }; });
      return text("Clicked [" + a.ref + "]" + (nowTab.url !== url0 ? " — page changed" : "") + note + ". " + (await pageLine()));
    },

    browser_type: async function (a) {
      var tab = await currentTab();
      var value = String(a.text);
      var clear = a.clear !== false;
      var r = await act(tab.id, a.ref, pageType, [value, clear, a.submit === true]);
      if (r.error) throw new Error(r.error);
      var how = "";
      if (!r.verified) {
        // Custom editor ignoring programmatic input — type like a user would.
        try {
          await act(tab.id, a.ref, pageFocusForTyping, []);
          if (clear) await cdpKey(tab.id, "Control+A");
          await cdp(tab.id, "Input.insertText", { text: value });
          await sleep(150);
          var v = await act(tab.id, a.ref, pageReadValue, []);
          var okNow = v.password ? v.value.length > 0 : v.value.replace(/\s+/g, " ").indexOf(value.replace(/\s+/g, " ").trim().slice(0, 60)) !== -1;
          if (!okNow) return text("Typed into [" + a.ref + "], but the field does not show the text (it holds: \"" + short(v.value) + "\"). It may be a canvas-based editor or reject input; try clicking it first, or another element.");
          how = " (used real key input)";
          if (a.submit) await cdpKey(tab.id, "Enter");
        } catch (e) {
          return text("Typed into [" + a.ref + "], but could not confirm the text landed (" + short(e.message) + ").");
        }
      }
      if (a.submit) {
        await settle(tab.id, 15000);
        await quiet(tab.id);
        return text("Typed into [" + a.ref + "]" + how + " and pressed Enter. " + (await pageLine()));
      }
      return text("Typed into [" + a.ref + "]" + how + ".");
    },

    browser_select: async function (a) {
      var tab = await currentTab();
      var r = await act(tab.id, a.ref, pageSelect, [String(a.option)]);
      if (r.error) throw new Error(r.error);
      return text('Selected "' + r.selected + '" in [' + a.ref + "].");
    },

    browser_press_key: async function (a) {
      var tab = await currentTab();
      var key = String(a.key);
      // Paste would read the user's clipboard into the page (and cut modifies it): not something a page-driven agent may do.
      if (/^(Control|Ctrl|Meta|Cmd|Command)\+.*[vVxX]$/.test(key)) throw new Error("Clipboard shortcuts (paste/cut) are not available to the agent. Use browser_type to enter text.");
      try {
        await cdpKey(tab.id, key);
      } catch (e) {
        if (/Unsupported key/.test(e.message)) throw e;
        await inTop(pageKey, [key]); // debugger unavailable — synthetic events
      }
      if (/Enter$/.test(key)) {
        await settle(tab.id, 10000);
        await quiet(tab.id);
      } else {
        await sleep(150);
      }
      return text("Pressed " + key + ". " + (await pageLine()));
    },

    browser_hover: async function (a) {
      var tab = await currentTab();
      var r = await act(tab.id, a.ref, pageRect, []);
      if (r.error) throw new Error(r.error);
      try {
        if (!r.top) throw new Error("subframe");
        await cdpMove(tab.id, r.x, r.y);
      } catch (_) {
        await act(tab.id, a.ref, pageHover, []);
      }
      await sleep(400);
      return text("Hovering over [" + a.ref + "]. Read the page to see any menu or tooltip that opened.");
    },

    browser_drag: async function (a) {
      var tab = await currentTab();
      var from = (refTables[tab.id] || {})[a.fromRef];
      if (!from) throw new Error("Unknown ref — call browser_read_page first.");
      var toLocal = 0;
      if (a.toRef) {
        var to = (refTables[tab.id] || {})[a.toRef];
        if (!to) throw new Error("Unknown toRef — call browser_read_page first.");
        if (from.documentId !== to.documentId) throw new Error("Drag source and target are in different frames; that isn't supported.");
        toLocal = to.local;
      } else if (!a.toText) {
        throw new Error("Give toRef, or toText (visible text of the drop zone).");
      }
      var r = await act(tab.id, a.fromRef, pageDrag, [toLocal, a.toText || ""]);
      if (r.error) throw new Error(r.error);
      await sleep(400);
      await quiet(tab.id);
      return text("Dragged [" + a.fromRef + "] onto " + (a.toRef ? "[" + a.toRef + "]" : '"' + a.toText + '"') + ". Read the page to confirm it moved.");
    },

    browser_upload_file: async function (a) {
      var tab = await currentTab();
      var r = await act(tab.id, a.ref, pageUpload, [String(a.name), String(a.data)]);
      if (r.error) throw new Error(r.error);
      await sleep(300);
      return text('Attached "' + a.name + '" to [' + a.ref + "].");
    },

    browser_scroll: async function (a) {
      var tab = await currentTab();
      var r = a.ref
        ? await act(tab.id, a.ref, pageScroll, [a.direction || "down"])
        : await inTop(pageScroll, [0, a.direction || "down"]);
      if (r.error) throw new Error(r.error);
      await sleep(250);
      return text("Scrolled — y=" + r.y + " of " + r.max + ".");
    },

    browser_run_js: async function (a) {
      var r = await inTop(pageRunJs, [String(a.code)], "MAIN");
      return text(r.value);
    },

    // =========================================================================
    // Network tap — the responses the page itself receives (its JSON API), through the DevTools
    // protocol. Far more robust than scraping a rendered list: pagination, ids and fields come as data.
    // =========================================================================

    browser_network_capture: async function (a) {
      var tab = await currentTab();
      var action = a.action || "read";
      if (action === "start") {
        var filter = String(a.urlFilter || "").trim();
        var cap = { filter: filter, entries: [], pending: {}, max: 60 };
        captures[tab.id] = cap;
        pinned[tab.id] = true;
        clearTimeout(detachTimers[tab.id]);
        await cdp(tab.id, "Network.enable", { maxResourceBufferSize: 20 * 1024 * 1024, maxTotalBufferSize: 50 * 1024 * 1024 });
        return text("Capturing network responses on this tab" + (filter ? ' (URLs containing "' + filter + '")' : "") +
          ". Now do what loads the data (scroll, click, search, reload), then call browser_network_capture with action=read. " +
          "Chrome shows its debugging bar on the tab while the capture is on; action=stop ends it.");
      }
      var c = captures[tab.id];
      if (action === "stop") {
        if (c) {
          delete captures[tab.id];
          delete pinned[tab.id];
          await cdp(tab.id, "Network.disable", {}).catch(function () {});
        }
        return text(c ? "Capture stopped (" + c.entries.length + " responses were recorded; they are discarded)." : "No capture was running on this tab.");
      }
      if (!c) throw new Error("No capture is running on this tab — call browser_network_capture with action=start first, then trigger the request.");
      if (a.index !== undefined && a.index !== null) {
        var e = c.entries[Number(a.index)];
        if (!e) throw new Error("No captured response #" + a.index + " (there are " + c.entries.length + ").");
        var body = e.body == null ? await fetchBody(tab.id, e) : e.body;
        var limit = Math.min(200000, Math.max(1000, Number(a.maxChars) || 30000));
        return text("#" + a.index + " " + e.method + " " + e.url + " → " + e.status + " " + e.mime + " (" + body.length + " chars)\n\n" +
          (body.length > limit ? body.slice(0, limit) + "\n… (truncated — pass maxChars for more, or narrow with urlFilter)" : body));
      }
      var filt = String(a.urlFilter || "").toLowerCase();
      var rows = [];
      for (var i = 0; i < c.entries.length; i++) {
        var en = c.entries[i];
        if (filt && en.url.toLowerCase().indexOf(filt) === -1) continue;
        var preview = en.body == null ? await fetchBody(tab.id, en).catch(function () { return ""; }) : en.body;
        rows.push("#" + i + " " + en.method + " " + en.url.slice(0, 160) + " → " + en.status + " " + en.mime + " " + (en.size ? en.size + " B" : "") +
          (preview ? "\n    " + preview.replace(/\s+/g, " ").slice(0, 220) : ""));
      }
      if (!rows.length) return text(c.entries.length ? "No captured responses match that filter (" + c.entries.length + " captured)." : "Nothing captured yet — trigger the request (scroll, click, reload) and read again.");
      return text("Captured responses (" + rows.length + (filt ? " matching" : "") + "; action=read with index=N gives a full body):\n" + rows.join("\n"));
    },

    // =========================================================================
    // Document Converter
    // =========================================================================

    browser_convert: async function (a) {
      if (!globalThis.AgentConverter) throw new Error("Converter not loaded");
      var cur = await currentTab().catch(function () { return null; });
      var result = await globalThis.AgentConverter.convert({
        from: a.from, to: a.to, data: a.data || "",
        filename: a.filename, title: a.title,
        quality: a.quality, maxWidth: a.maxWidth, maxHeight: a.maxHeight,
        delimiter: a.delimiter,
        windowId: cur ? cur.windowId : undefined,
      });
      if (result.error) throw new Error(result.error);
      if (result.html && !result.blob) {
        // md→pdf / html→pdf: the converter prepared the document, the PDF is rendered here (DevTools).
        result.blob = await htmlToPdf(result.html);
      }
      if (result.blob && a.save !== false) {
        var dl = await globalThis.AgentConverter.download(result.blob, result.filename);
        if (!dl.ok) return text("Conversion done but save failed: " + dl.error);
        return text("Converted and saved: " + dl.filename + " (" + (dl.size || result.blob.size) + " bytes)" + (result.rows ? " — " + result.rows + " rows" : ""));
      }
      if (result.text) return text(result.text.length > 5000 ? result.text.slice(0, 5000) + "\n... (truncated)" : result.text);
      return text("Converted: " + result.filename);
    },

    browser_page_to_pdf: async function () {
      if (!globalThis.AgentConverter) throw new Error("Converter not loaded");
      var tab = await currentTab();
      // Render the actual page (styles, images and layout intact) to PDF via the
      // DevTools protocol, so it's the tab the agent is on — not the side panel —
      // and it saves without a manual print dialog.
      var pdf = await cdp(tab.id, "Page.printToPDF", { printBackground: true });
      var blob = pdfBlob(pdf.data);
      var name = (tab.title || "page").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 50) + ".pdf";
      var dl = await globalThis.AgentConverter.download(blob, name);
      if (!dl.ok) return text("Rendered the page to PDF but saving failed: " + dl.error);
      return text("Saved the page as PDF: " + dl.filename + " (" + (dl.size || blob.size) + " bytes)");
    },

    browser_save_page: async function (a) {
      // Save current page content as HTML/TXT/MD file
      var tab = await currentTab();
      var r = await inTop(function() {
        return { html: document.documentElement.outerHTML, text: document.body.innerText, title: document.title, url: location.href };
      }, []);
      var format = (a.format || "html").toLowerCase();
      var content, filename, mime;
      if (format === "txt" || format === "text") {
        content = "URL: " + r.url + "\nTitle: " + r.title + "\n\n" + r.text;
        filename = (r.title || "page").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 50) + ".txt";
        mime = "text/plain";
      } else if (format === "md") {
        content = "# " + r.title + "\n\n> Source: " + r.url + "\n\n" + r.text;
        filename = (r.title || "page").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 50) + ".md";
        mime = "text/markdown";
      } else {
        content = r.html;
        filename = (r.title || "page").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 50) + ".html";
        mime = "text/html";
      }
      var blob = new Blob([content], { type: mime });
      var dl = await globalThis.AgentConverter.download(blob, filename);
      if (!dl.ok) throw new Error("Saving failed: " + dl.error);
      return text("Saved: " + dl.filename + " (" + (dl.size || blob.size) + " bytes)");
    },

    browser_screenshot_save: async function (a) {
      if (!globalThis.AgentConverter) throw new Error("Converter not loaded");
      var format = (a.format || "png").toLowerCase();
      var tab = await currentTab(); // the tab the agent works in, whichever window it is in
      if (!tab.active) {
        await chrome.tabs.update(tab.id, { active: true });
        await sleep(300);
      }
      var result = await globalThis.AgentConverter.convert({ from: "screenshot", to: format, quality: a.quality, filename: a.filename, windowId: tab.windowId });
      if (result.error) throw new Error(result.error);
      var dl = await globalThis.AgentConverter.download(result.blob, result.filename);
      if (!dl.ok) throw new Error("Saving failed: " + dl.error);
      return text("Screenshot saved: " + dl.filename + " (" + (dl.size || result.size) + " bytes)");
    },

    // =========================================================================
    // Cookie Editor — read, set, delete cookies for any domain
    // =========================================================================

    browser_cookies_get: async function (a) {
      var tab = await currentTab();
      var url = a.url || tab.url;
      var domain = a.domain || "";
      var details = { storeId: await cookieStoreOf(tab) };
      if (url) details.url = url;
      if (domain) details.domain = domain;
      if (a.name) details.name = a.name;
      var cookies = await chrome.cookies.getAll(details);
      if (!cookies.length) return text("No cookies found" + (domain ? " for " + domain : "") + ".");
      var lines = cookies.map(function (c) {
        return c.name + "=" + c.value.slice(0, 80) + (c.value.length > 80 ? "..." : "") +
          " | domain=" + c.domain + " | path=" + c.path +
          (c.secure ? " | secure" : "") +
          (c.httpOnly ? " | httpOnly" : "") +
          (c.sameSite ? " | sameSite=" + c.sameSite : "") +
          (c.expirationDate ? " | expires=" + new Date(c.expirationDate * 1000).toISOString() : " | session");
      });
      return text("Cookies (" + cookies.length + "):\n" + lines.join("\n"));
    },

    browser_cookies_set: async function (a) {
      if (!a.name) throw new Error("name is required");
      var tab = await currentTab();
      var url = a.url || tab.url;
      var details = {
        url: url,
        name: String(a.name),
        value: String(a.value || ""),
        storeId: await cookieStoreOf(tab),
      };
      if (a.domain) details.domain = a.domain;
      if (a.path) details.path = a.path;
      if (a.secure !== undefined) details.secure = !!a.secure;
      if (a.httpOnly !== undefined) details.httpOnly = !!a.httpOnly;
      if (a.sameSite) details.sameSite = a.sameSite;
      if (a.expirationDate) details.expirationDate = a.expirationDate;
      else if (a.maxAgeSec) details.expirationDate = Math.floor(Date.now() / 1000) + Number(a.maxAgeSec);
      var cookie = await chrome.cookies.set(details);
      if (!cookie) throw new Error("Failed to set cookie (check domain/url match).");
      return text("Cookie set: " + cookie.name + "=" + cookie.value.slice(0, 40) + " on " + cookie.domain);
    },

    browser_cookies_delete: async function (a) {
      if (!a.name) throw new Error("name is required");
      var tab = await currentTab();
      var url = a.url || tab.url;
      var gone = await chrome.cookies.remove({ url: url, name: a.name, storeId: await cookieStoreOf(tab) });
      return text(gone ? "Deleted cookie: " + a.name : "No cookie named " + a.name + " for " + url + ".");
    },

    browser_cookies_clear: async function (a) {
      var tab = await currentTab();
      var url = a.url || tab.url;
      var domain = a.domain || "";
      var details = { storeId: await cookieStoreOf(tab) };
      if (url) details.url = url;
      if (domain) details.domain = domain;
      var cookies = await chrome.cookies.getAll(details);
      var count = 0;
      for (var i = 0; i < cookies.length; i++) {
        if (await removeCookie(cookies[i], details.storeId)) count++;
      }
      return text("Cleared " + count + " cookies" + (domain ? " for " + domain : "") + ".");
    },

    browser_cookies_export: async function (a) {
      var tab = await currentTab();
      var url = a.url || tab.url;
      var domain = a.domain || "";
      var details = { storeId: await cookieStoreOf(tab) };
      if (url) details.url = url;
      if (domain) details.domain = domain;
      var cookies = await chrome.cookies.getAll(details);
      var exported = cookies.map(function (c) {
        return { name: c.name, value: c.value, domain: c.domain, path: c.path,
          secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite,
          expirationDate: c.expirationDate || null };
      });
      return text(JSON.stringify(exported, null, 2));
    },

    browser_cookies_import: async function (a) {
      if (!a.cookies) throw new Error("cookies array is required");
      var list = typeof a.cookies === "string" ? JSON.parse(a.cookies) : a.cookies;
      if (!Array.isArray(list)) throw new Error("cookies must be a JSON array of {name, value, domain, ...}.");
      var tab = await currentTab();
      var storeId = await cookieStoreOf(tab);
      var count = 0, skipped = [];
      for (var i = 0; i < list.length; i++) {
        var c = list[i] || {};
        if (!c.name || (!c.url && !c.domain)) { skipped.push("#" + (i + 1) + " (needs name and domain or url)"); continue; }
        var details = { url: c.url || cookieUrl(c), name: String(c.name), value: String(c.value == null ? "" : c.value), storeId: storeId };
        if (c.domain) details.domain = c.domain;
        if (c.path) details.path = c.path;
        if (c.secure !== undefined) details.secure = !!c.secure;
        if (c.httpOnly !== undefined) details.httpOnly = !!c.httpOnly;
        if (c.sameSite) details.sameSite = c.sameSite;
        if (c.expirationDate) details.expirationDate = Number(c.expirationDate);
        try {
          if (await chrome.cookies.set(details)) count++;
          else skipped.push(c.name + " (rejected by the browser)");
        } catch (e) {
          skipped.push(c.name + " (" + short((e && e.message) || e) + ")");
        }
      }
      return text("Imported " + count + " of " + list.length + " cookies." + (skipped.length ? "\nSkipped: " + skipped.slice(0, 10).join(", ") : ""));
    },

    // =========================================================================
    // User-Agent & Headers — override UA, language, platform per session
    // =========================================================================

    browser_set_useragent: async function (a) {
      if (!a.userAgent) throw new Error("userAgent string is required");
      var tab = await currentTab();
      var ua = String(a.userAgent);
      var plat = String(a.platform || "");
      var lang = String(a.language || "");
      // A profile tab keeps its device config; its UA-derived parts (client hints) follow the new UA.
      var dev = deviceOf(tab.id);
      var device = dev && engine() ? engine().configFor({ device: dev.id, ua: ua, platform: plat, lang: lang }, dev.profileId) : null;
      var identity = { ua: ua, platform: plat, lang: lang, device: device };
      try {
        await setIdentity(tab.id, identity);
      } catch (e) {
        throw new Error("Could not override the User-Agent via DevTools: " + ((e && e.message) || e) + ". Another DevTools client (an open inspector?) may hold this tab.");
      }
      // In a profile window the window's identity follows: tabs opened later and the fallback scripts use it.
      if (profileWindows[tab.windowId]) {
        profileWindows[tab.windowId].identity = identity;
        if (device) await chrome.storage.session.set({ [DEVICE_WINDOW_PREFIX + tab.windowId]: device });
      }
      var result = "User-Agent set to: " + ua.slice(0, 100);
      if (plat) result += " | platform=" + plat;
      if (lang) result += " | language=" + lang;
      result += "\nThe override persists across reloads for this tab. It resets when the tab is closed.";
      return text(result);
    },

    browser_get_useragent: async function () {
      var r = await inTop(function() { return { ua: navigator.userAgent, platform: navigator.platform, lang: navigator.language, langs: navigator.languages.join(",") }; }, [], "MAIN");
      return text("User-Agent: " + r.ua + "\nPlatform: " + r.platform + "\nLanguage: " + r.lang + "\nLanguages: " + r.langs);
    },

    // =========================================================================
    // Windows — list, switch, close (a private window is one of them)
    // =========================================================================

    browser_list_windows: async function () {
      var windows = await chrome.windows.getAll({ populate: true });
      var cur = currentTabId;
      var lines = [];
      for (var i = 0; i < windows.length; i++) {
        var w = windows[i];
        var tabs = (w.tabs || []).filter(function (t) { return !ownPage(t); });
        var label = w.incognito ? "[PRIVATE] " : "[NORMAL] ";
        var mine = tabs.some(function (t) { return t.id === cur; });
        lines.push(label + "Window " + w.id + " (" + tabs.length + " tabs)" + (w.focused ? " — focused" : "") + (mine ? " — you work here" : ""));
        for (var j = 0; j < Math.min(tabs.length, 5); j++) {
          lines.push("  " + (tabs[j].id === cur ? "* " : "  ") + tabs[j].id + "  " + (tabs[j].title || "(untitled)").slice(0, 50) + " — " + tabs[j].url);
        }
        if (tabs.length > 5) lines.push("  ... +" + (tabs.length - 5) + " more tabs");
      }
      return text(lines.join("\n") || "No windows.");
    },

    browser_switch_window: async function (a) {
      if (!a.windowId) throw new Error("windowId is required (get it from browser_list_windows)");
      var win = await chrome.windows.update(a.windowId, { focused: true });
      var tabs = await chrome.tabs.query({ windowId: a.windowId, active: true });
      if (tabs[0] && !ownPage(tabs[0])) {
        currentTabId = tabs[0].id;
        return text("Switched to window " + a.windowId + (win.incognito ? " (private)" : "") + ". " + (await pageLine()));
      }
      return text("Switched to window " + a.windowId + " (no website tab is active there — use browser_tabs / browser_switch_tab).");
    },

    browser_close_window: async function (a) {
      if (!a.windowId) throw new Error("windowId is required");
      var w = await chrome.windows.get(a.windowId, { populate: true });
      var tabs = (w.tabs || []);
      var mine = await chrome.windows.getCurrent().catch(function () { return null; });
      if (tabs.some(ownPage) || (mine && mine.id === w.id)) throw new Error("That window holds the agent's own panel — close it yourself if you mean to.");
      await chrome.windows.remove(a.windowId);
      if (tabs.some(function (t) { return t.id === currentTabId; })) currentTabId = null;
      return text("Closed window " + a.windowId + (w.incognito ? " (private — its session is gone)" : "") + " with " + tabs.length + " tab" + (tabs.length === 1 ? "" : "s") + ".");
    },

    // =========================================================================
    // Automation helpers — fill forms, extract data, network intercept
    // =========================================================================

    browser_fill_form: async function (a) {
      // Fill multiple fields at once: [{ref, value}] or {ref: value}
      if (!a.fields) throw new Error("fields is required — [{ref, value}] or {ref: value}");
      var tab = await currentTab();
      var fields = Array.isArray(a.fields) ? a.fields : Object.entries(a.fields).map(function(e) { return { ref: Number(e[0]), value: e[1] }; });
      var results = [];
      for (var i = 0; i < fields.length; i++) {
        var f = fields[i] || {};
        var entry = (refTables[tab.id] || {})[f.ref];
        if (!entry) { results.push("[" + f.ref + "]: no such ref — call browser_read_page first"); continue; }
        try {
          var kind = await act(tab.id, f.ref, pageFieldKind, []);
          var r, note = "ok";
          if (kind.kind === "select") {
            r = await act(tab.id, f.ref, pageSelect, [String(f.value)]);
            if (!r.error) note = 'selected "' + r.selected + '"';
          } else if (kind.kind === "toggle") {
            var on = !(f.value === false || f.value === 0 || /^(false|0|no|off|unchecked|)$/i.test(String(f.value).trim()));
            r = kind.checked === on ? { ok: true } : await act(tab.id, f.ref, pageClick, [false, false], false);
            note = on ? "checked" : "unchecked";
          } else {
            r = await act(tab.id, f.ref, pageType, [String(f.value == null ? "" : f.value), true, false]);
            if (!r.error && !r.verified) note = "typed, but the field does not show the text — check it with browser_read_page";
          }
          results.push("[" + f.ref + "]: " + (r.error ? "FAIL " + r.error : note));
        } catch (e) {
          results.push("[" + f.ref + "]: error " + ((e && e.message) || e));
        }
      }
      return text("Form fill results:\n" + results.join("\n"));
    },

    browser_extract_table: async function (a) {
      var r = await inTop(function(selector) {
        var table = selector ? document.querySelector(selector) : document.querySelector("table");
        if (!table) return { error: "No table found" + (selector ? " matching " + selector : "") };
        var rows = table.querySelectorAll("tr");
        var data = [];
        rows.forEach(function(tr) {
          var cells = [];
          tr.querySelectorAll("th, td").forEach(function(cell) {
            cells.push(cell.innerText.replace(/\s+/g, " ").trim());
          });
          if (cells.length) data.push(cells);
        });
        return { rows: data.length, data: data };
      }, [a.selector || ""], "MAIN");
      if (r.error) throw new Error(r.error);
      return text("Table (" + r.rows + " rows):\n" + r.data.map(function(row) { return row.join(" | "); }).join("\n"));
    },

    // =========================================================================
    // Device profiles — a saved identity (User-Agent + platform + language), proxy, cookies and
    // notes, kept in chrome.storage.local "agentProfiles" and shared with the 👤 panel (profiles.js).
    // =========================================================================

    browser_profile_create: async function (a) {
      if (!a.name) throw new Error("name is required");
      var profiles = await loadProfiles();
      var pid = "prof_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      var device = uaPreset(a.deviceType);
      var E = engine();
      // Device template: the one asked for, else one for the OS of a desktop Chromium UA (none for a
      // custom UA, Firefox, Safari, phones or Linux — the templates are Windows / macOS Chrome machines).
      var tpl = null;
      if (E && a.device && a.device !== "none") {
        tpl = E.DEVICES.find(function (d) { return d.id === a.device; });
        if (!tpl) throw new Error("Unknown device template '" + a.device + "'. Templates: " + E.DEVICES.map(function (d) { return d.id + " (" + d.label + ")"; }).join(", ") + "; 'none' = User-Agent only.");
        if (!a.deviceType && !a.userAgent) device = { ua: tpl.ua, platform: tpl.platform, lang: device.lang, label: E.osFromUa(tpl.ua) === "mac" ? "macOS" : "Windows", type: "template" };
        if (device.type === "template") device.label += " · Chrome " + (/Chrome\/(\d+)/.exec(tpl.ua) || [0, "?"])[1];
      } else if (E && a.device !== "none" && !a.userAgent && /Chrome\//.test(device.ua) && !/Mobile|Android/.test(device.ua)) {
        tpl = E.templateFor(pid, device.ua);
      }
      var profile = {
        name: String(a.name),
        icon: a.icon || "🕵️",
        ua: a.userAgent || device.ua,
        platform: a.platform || device.platform,
        lang: a.language || device.lang,
        label: a.userAgent ? String(a.userAgent).slice(0, 50) : device.label,
        device: tpl ? tpl.id : "",
        deviceLabel: tpl ? tpl.label : "",
        proxy: {
          enabled: !!a.proxyHost,
          type: a.proxyType || "http",
          host: a.proxyHost || "",
          port: a.proxyPort || "",
          username: a.proxyUser || "",
          password: a.proxyPass || "",
        },
        startUrl: a.startUrl || "about:blank",
        agentContext: a.context || "",
        cookies: [],
        cookieCount: 0,
        created: Date.now(),
        updated: Date.now(),
      };
      profiles[pid] = profile;
      await saveProfiles(profiles);

      var result = "Created profile '" + profile.name + "' (id: " + pid + ")\n";
      result += "UA: " + profile.ua.slice(0, 80) + "\n";
      result += "Platform: " + profile.platform + "  |  Language: " + profile.lang + "\n";
      result += "Proxy: " + proxyLabel(profile) + "\n";
      result += "Device: " + deviceLine(profile) + "\n";
      result += "Use browser_profile_launch with id '" + pid + "' to start; browser_profile_save after signing in keeps the session.";
      return text(result);
    },

    browser_profile_launch: async function (a) {
      // Opens a regular (not Incognito) window and applies the device profile to it. Incognito would
      // not help: every Incognito window shares one session, and the extension may not be allowed
      // there. So the profile's saved cookies replace whatever the regular jar holds for its domains.
      if (!a.profileId) throw new Error("profileId is required (get from browser_profile_list)");
      var profiles = await loadProfiles();
      var p = profiles[a.profileId];
      if (!p) throw new Error("Profile not found: " + a.profileId);

      var url = a.url || p.startUrl || "about:blank";

      // 1. Open a new window via background (side panel can't call chrome.windows.create in Edge);
      //    the service worker is that background and creates it directly.
      var winId;
      if (inWorker) {
        winId = (await chrome.windows.create({ url: "about:blank", focused: true })).id;
      } else {
        var winRes = await chrome.runtime.sendMessage({ type: "createWindow", options: { url: "about:blank", focused: true } });
        if (!winRes || !winRes.ok || !winRes.win || !winRes.win.id) throw new Error("Failed to create window — background returned: " + JSON.stringify(winRes));
        winId = winRes.win.id;
      }
      var tabs = await chrome.tabs.query({ windowId: winId });
      var tab = tabs[0];
      if (!tab) throw new Error("No tab in new window — try again");
      currentTabId = tab.id;

      // 2. Proxy. chrome.proxy is browser-wide, so this is "the browser's proxy while the profile is
      //    open": the setting in place before is remembered and comes back when the window closes.
      var proxyNote = await applyProfileProxy(a.profileId, p);

      // 3. Identity: request headers, navigator.* and the device config for the life of this window's
      //    tabs (re-applied on every load; tabs opened in the window get it too).
      var uaNote = "";
      var cfg = engine() ? engine().configFor(p, a.profileId) : null;
      var identity = cfg || p.ua ? { ua: p.ua || cfg.ua, platform: p.platform || (cfg ? cfg.platform : ""), lang: p.lang || "", device: cfg } : null;
      if (identity) {
        try {
          await setIdentity(tab.id, identity);
        } catch (e) {
          uaNote = " (identity override failed: " + short((e && e.message) || e) + ")";
        }
        await startProfileWindow(a.profileId, winId, identity);
      } else {
        await startProfileWindow(a.profileId, winId, { ua: "", platform: "", lang: "", device: null });
      }

      // 4. Session: this is the regular cookie jar, so the profile's domains are cleared first —
      //    whatever account was signed in there is signed out — then the saved cookies go in.
      var imported = 0, replaced = 0, domainList = [];
      if (p.cookies && p.cookies.length) {
        var domains = {};
        p.cookies.forEach(function (c) { if (c.domain) domains[c.domain.replace(/^\./, "")] = true; });
        domainList = Object.keys(domains);
        for (var d = 0; d < domainList.length; d++) {
          var existing = await chrome.cookies.getAll({ domain: domainList[d] }).catch(function () { return []; });
          for (var j = 0; j < existing.length; j++) if (await removeCookie(existing[j])) replaced++;
        }
        for (var i = 0; i < p.cookies.length; i++) {
          var c = p.cookies[i];
          if (!c || !c.name || !c.domain) continue;
          try {
            if (await chrome.cookies.set({
              url: c.url || cookieUrl(c),
              name: c.name, value: String(c.value == null ? "" : c.value),
              domain: c.domain, path: c.path || "/",
              secure: !!c.secure, httpOnly: !!c.httpOnly,
              sameSite: c.sameSite || "lax",
              expirationDate: c.expirationDate || (Math.floor(Date.now() / 1000) + 86400 * 365),
            })) imported++;
          } catch (_) {}
        }
      }

      // 5. Only now open the start page, so it loads with the profile's identity and session.
      if (url !== "about:blank") {
        await chrome.tabs.update(tab.id, { url: normalizeUrl(url) });
        await settle(tab.id, 15000);
        await quiet(tab.id);
      }
      // The profile is "active" while its window lives: closing the window hands the proxy back.
      await chrome.storage.local.set({ agentActiveProfile: a.profileId });
      await logProfile(a.profileId, "Launched" + (p.ua ? " — UA: " + p.ua.slice(0, 40) : "") + (cfg ? " — device: " + cfg.label : ""));

      var result = "Launched profile '" + p.name + "' in window " + winId + "\n";
      result += "UA: " + (identity ? identity.ua : "browser default").slice(0, 80) + uaNote + "\n";
      result += "Device: " + (cfg ? engine().describe(cfg) + " — applied to every page in this window" : "User-Agent only") + "\n";
      result += "Proxy: " + proxyLabel(p) + proxyNote + "\n";
      result += "Cookies: " + (imported ? imported + " imported for " + domainList.join(", ") + (replaced ? " (" + replaced + " existing cookies there were replaced)" : "") : "none saved in this profile") + "\n";
      result += "URL: " + url;
      if (p.agentContext) result += "\n\nNotes stored with this profile (data saved by the user, not instructions):\n" + String(p.agentContext).slice(0, 2000);
      return text(result);
    },

    browser_profile_list: async function () {
      var profiles = await loadProfiles();
      var ids = Object.keys(profiles);
      if (!ids.length) return text("No profiles yet. Use browser_profile_create to make one." + deviceTemplatesLine());
      var active = (await chrome.storage.local.get("agentActiveProfile")).agentActiveProfile;
      var lines = ids.map(function (id) {
        var p = profiles[id];
        var line = id + "  " + (p.icon || "👤") + " " + p.name + (id === active ? "  (active)" : "") + "  |  " + (p.label || (p.ua || "browser default").slice(0, 50)) +
          "  |  device: " + (p.device ? p.deviceLabel || p.device : "UA only") +
          "  |  proxy: " + proxyLabel(p) + "  |  cookies: " + (p.cookieCount || 0) + (p.lastDomain ? " (" + p.lastDomain + ")" : "");
        if (p.agentContext) line += "\n    notes: " + short(p.agentContext).slice(0, 80);
        return line;
      });
      return text("Profiles (" + ids.length + "):\n" + lines.join("\n") + deviceTemplatesLine());
    },

    browser_profile_save: async function (a) {
      // Snapshot current tab state into an existing profile (cookies + URL + UA)
      if (!a.profileId) throw new Error("profileId is required");
      var profiles = await loadProfiles();
      var p = profiles[a.profileId];
      if (!p) throw new Error("Profile not found: " + a.profileId);

      var tab = await currentTab();

      // Snapshot UA
      try {
        var r = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: function() { return { ua: navigator.userAgent, platform: navigator.platform, lang: navigator.language, url: location.href }; },
          world: "MAIN"
        });
        if (r && r[0] && r[0].result) {
          p.ua = r[0].result.ua;
          p.platform = r[0].result.platform;
          p.lang = r[0].result.lang;
          p.startUrl = r[0].result.url;
        }
      } catch (_) {}

      // Snapshot cookies for current domain
      if (tab.url) {
        try {
          var domain = new URL(tab.url).hostname;
          var cookies = await chrome.cookies.getAll({ domain: domain });
          // Also get cookies for parent domain
          var parts = domain.split(".");
          if (parts.length > 2) {
            var parent = parts.slice(-2).join(".");
            var parentCookies = await chrome.cookies.getAll({ domain: parent });
            cookies = cookies.concat(parentCookies);
          }
          // Deduplicate by name+domain
          var seen = {};
          p.cookies = cookies.filter(function(c) {
            var key = c.name + "|" + c.domain;
            if (seen[key]) return false;
            seen[key] = true;
            return true;
          }).map(function(c) {
            return { name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite, expirationDate: c.expirationDate };
          });
          p.cookieCount = p.cookies.length;
          p.lastDomain = domain;
        } catch (_) {}
      }

      p.updated = Date.now();
      profiles[a.profileId] = p;
      await saveProfiles(profiles);
      await logProfile(a.profileId, "Saved " + (p.cookieCount || 0) + " cookies" + (p.lastDomain ? " for " + p.lastDomain : ""));

      return text("Saved profile '" + p.name + "': " + (p.cookieCount || 0) + " cookies, URL: " + (p.startUrl || "?").slice(0, 60));
    },

    browser_profile_delete: async function (a) {
      if (!a.profileId) throw new Error("profileId is required");
      var profiles = await loadProfiles();
      if (!profiles[a.profileId]) throw new Error("Profile not found: " + a.profileId);
      var name = profiles[a.profileId].name;
      delete profiles[a.profileId];
      await saveProfiles(profiles);
      await endProfile(a.profileId);
      return text("Deleted profile '" + name + "'.");
    },

    // =========================================================================
    // Recipes, watchers, site memory — implemented in automation.js (shared with the service worker);
    // declared here so every tool the model can call has one dispatch table.
    // =========================================================================

    browser_recipe_save: async function (a) { return text(await auto().recipeSave(a)); },
    browser_recipe_run: async function (a) { return text(await auto().recipeRunTool(a)); },
    browser_recipe_list: async function (a) { return text(await auto().recipeList(a)); },
    browser_recipe_delete: async function (a) { return text(await auto().recipeDelete(a)); },
    browser_watch_create: async function (a) { return text(await auto().watchCreate(a, lastTab)); },
    browser_watch_list: async function (a) { return text(await auto().watchList(a)); },
    browser_watch_delete: async function (a) { return text(await auto().watchDelete(a)); },
    browser_memory_save: async function (a) { return text(await auto().memorySave(a, lastTab)); },
    browser_memory_list: async function (a) { return text(await auto().memoryList(a, lastTab)); },
    browser_memory_delete: async function (a) { return text(await auto().memoryDelete(a, lastTab)); },
  };

  // ---------------------------------------------------------------------------
  // Trace: every run() call, with the locator of the element it acted on, for recipes.

  var trace = [];
  var stepListeners = [];
  var turnInfo = null; // set by the panel: which chat/turn the steps belong to
  var TRACE_MAX = 500;
  var SECRET_ARGS = { browser_cookies_set: 1, browser_cookies_import: 1, browser_profile_create: 1 };

  function refLoc(ref) {
    var e = (refTables[currentTabId] || {})[ref];
    return e && e.loc ? Object.assign({}, e.loc) : null;
  }

  // Arguments as they may be stored: no file bytes, no cookie values, no passwords.
  function traceArgs(name, args) {
    var a = {};
    Object.keys(args).forEach(function (k) {
      var v = args[k];
      if (name === "browser_upload_file" && k === "data") return;
      if (SECRET_ARGS[name] && k !== "name" && k !== "domain" && k !== "url" && k !== "deviceType" && k !== "device") return;
      a[k] = v;
    });
    return a;
  }

  function beginStep(name, args) {
    var step = { t: Date.now(), name: name, args: traceArgs(name, args), urlBefore: lastTab ? lastTab.url : "" };
    if (turnInfo) step.turn = turnInfo;
    if (args.ref !== undefined) step.loc = refLoc(args.ref);
    if (args.fromRef !== undefined) step.loc = refLoc(args.fromRef);
    if (args.toRef !== undefined) step.toLoc = refLoc(args.toRef);
    if (name === "browser_fill_form" && args.fields) {
      var fields = Array.isArray(args.fields) ? args.fields : Object.entries(args.fields).map(function (e) { return { ref: Number(e[0]), value: e[1] }; });
      step.args.fields = fields.map(function (f) {
        var loc = refLoc(f.ref);
        var secret = !!(loc && /password/.test(loc.kind));
        return { ref: f.ref, value: secret ? "{{password}}" : f.value, loc: loc, secret: secret };
      });
    }
    if (name === "browser_type" && step.loc && /password/.test(step.loc.kind)) {
      step.args.text = "{{password}}";
      step.secret = true;
    }
    return step;
  }

  function outText(out) {
    return (out || []).filter(function (p) { return p.type === "text"; }).map(function (p) { return p.text; }).join("\n");
  }

  function endStep(step, out, err) {
    step.ms = Date.now() - step.t;
    step.ok = !err;
    if (err) step.error = String((err && err.message) || err).slice(0, 300);
    else step.out = outText(out).slice(0, 300);
    step.url = lastTab ? lastTab.url : step.urlBefore;
    trace.push(step);
    if (trace.length > TRACE_MAX) trace.splice(0, trace.length - TRACE_MAX);
    stepListeners.forEach(function (fn) { try { fn(step); } catch (_) {} });
  }

  globalThis.AgentBrowserTools = {
    /** Words for what a call would act on — the element behind a ref, or the address — for approval cards. */
    describe: function (name, args) {
      args = args || {};
      var labels = refLabels[currentTabId] || {};
      var parts = [];
      ["ref", "fromRef", "toRef"].forEach(function (k) {
        if (args[k] && labels[args[k]]) parts.push((k === "toRef" ? "onto " : "") + labels[args[k]]);
      });
      if (args.url) parts.push(String(args.url));
      if (args.toText) parts.push("onto \"" + args.toText + "\"");
      return parts.length ? parts.join(" ") : undefined;
    },
    /** Run a tool; the call lands in the trace (replay=true marks a recipe's own steps). */
    run: function (name, args, replay) {
      var fn = TOOLS[name];
      if (!fn) return Promise.reject(new Error("Unknown browser tool: " + name));
      args = args || {};
      var step = beginStep(name, args);
      if (replay) step.replay = true;
      // Where the tab ended up is part of the record (the next step's "page before").
      var after = function () {
        if (currentTabId === null) return Promise.resolve();
        return chrome.tabs.get(currentTabId).then(function (t) { lastTab = { id: t.id, url: t.url || "", title: t.title || "" }; }, function () {});
      };
      return fn(args).then(
        function (out) { return after().then(function () { endStep(step, out, null); return out; }); },
        function (err) { return after().then(function () { endStep(step, null, err); throw err; }); }
      );
    },
    names: Object.keys(TOOLS),
    /** The recorded steps (a copy), oldest first. */
    trace: function () { return trace.slice(); },
    clearTrace: function () { trace.length = 0; },
    onStep: function (fn) { stepListeners.push(fn); return function () { stepListeners = stepListeners.filter(function (f) { return f !== fn; }); }; },
    /** The panel tells which chat/turn the next steps belong to ({ convId, turn }). */
    setTurn: function (info) { turnInfo = info || null; },
    /** Fresh refs of the current page with their locators: [{ ref, loc }] — recipes match against these. */
    refs: async function () {
      await snapshot(500);
      var table = refTables[currentTabId] || {};
      return Object.keys(table).map(function (n) { return { ref: Number(n), loc: table[n].loc }; });
    },
    /** Work on this tab from now on (watchers run in a tab of their own). */
    setCurrentTab: function (tabId) { currentTabId = tabId; },
    currentTabId: function () { return currentTabId; },
    /** User-Agent presets for the 👤 panel: the same generator the tools use. */
    uaPreset: uaPreset,
    uaPresetNames: Object.keys(UA_PRESETS),
    /** The device config the tab the agent works in presents (null = the real one / UA only). */
    deviceOf: function (tabId) { return deviceOf(tabId === undefined ? currentTabId : tabId); },
  };
})();
