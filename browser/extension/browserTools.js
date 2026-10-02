// Browser tools the agent calls through the host (declared in
// browser/host/tools.ts). They run in the side panel page, which has the
// chrome.tabs / chrome.scripting / chrome.debugger APIs, and act on one
// "current" tab: the active tab of this panel's window unless the agent
// switched or opened one.
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
  var refTables = {}; // tabId -> { n: { documentId, local } } from the last snapshot

  var STALE = "That element is gone — the page changed. Call browser_read_page again.";

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

  chrome.debugger.onDetach.addListener(function (source) {
    delete attached[source.tabId];
  });

  async function cdp(tabId, method, params) {
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
    detachTimers[tabId] = setTimeout(function () {
      delete attached[tabId];
      chrome.debugger.detach({ tabId: tabId }).catch(function () {});
    }, 8000);
    return chrome.debugger.sendCommand({ tabId: tabId }, method, params || {});
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

  async function cdpKey(tabId, combo) {
    var parts = String(combo).split("+");
    var key = parts.pop() || "+";
    var mods = 0;
    parts.forEach(function (m) { mods |= MODS[m] || 0; });
    var def = KEY_TABLE[key] || (key.length === 1
      ? { key: key, code: /[a-z]/i.test(key) ? "Key" + key.toUpperCase() : "", vk: key.toUpperCase().charCodeAt(0), text: key }
      : null);
    if (!def) throw new Error("Unsupported key: " + combo);
    var base = { key: def.key || key, code: def.code, windowsVirtualKeyCode: def.vk, nativeVirtualKeyCode: def.vk, modifiers: mods };
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
      return {
        kind: kind,
        label: label,
        extra: extra.join(" "),
        inModal: inModal(el),
        local: refs.length,
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
    var all = (window.__agentUaListeners = window.__agentUaListeners || {});
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
    listed.forEach(function (x) {
      n++;
      table[n] = { documentId: x.f.documentId, local: x.e.local };
      var where = x.fi === 0 ? "" : " ⧉ frame " + frameHost(x.f.result.url);
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

  var TOOLS = {
    browser_read_page: async function (a) {
      var s = await snapshot(a.maxChars || 8000);
      // The page text is budgeted inside the snapshot; this is only a safety net for pathological pages.
      return text(s.text.length > 120000 ? s.text.slice(0, 120000) + "\n… (output truncated)" : s.text);
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
    // Document Converter
    // =========================================================================

    browser_convert: async function (a) {
      if (!window.AgentConverter) throw new Error("Converter not loaded");
      var result = await window.AgentConverter.convert({
        from: a.from, to: a.to, data: a.data || "",
        filename: a.filename, title: a.title,
        quality: a.quality, maxWidth: a.maxWidth, maxHeight: a.maxHeight,
        delimiter: a.delimiter,
      });
      if (result.error) throw new Error(result.error);
      if (result.blob && a.save !== false) {
        var dl = await window.AgentConverter.downloadAndOpen(result.blob, result.filename, a.open);
        if (!dl.ok) return text("Conversion done but save failed: " + dl.error);
        return text("Converted and " + (dl.opened ? "opened" : "saved") + ": " + dl.filename + " (" + (dl.size || result.blob.size) + " bytes)" + (result.rows ? " — " + result.rows + " rows" : ""));
      }
      if (result.text) return text(result.text.length > 5000 ? result.text.slice(0, 5000) + "\n... (truncated)" : result.text);
      return text("Converted: " + result.filename);
    },

    browser_page_to_pdf: async function () {
      if (!window.AgentConverter) throw new Error("Converter not loaded");
      var tab = await currentTab();
      // Render the actual page (styles, images and layout intact) to PDF via the
      // DevTools protocol, so it's the tab the agent is on — not the side panel —
      // and it saves without a manual print dialog.
      var pdf = await cdp(tab.id, "Page.printToPDF", { printBackground: true });
      var bin = atob(pdf.data), bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      var name = (tab.title || "page").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 50) + ".pdf";
      var dl = await window.AgentConverter.downloadAndOpen(new Blob([bytes], { type: "application/pdf" }), name);
      if (!dl.ok) return text("Rendered the page to PDF but saving failed: " + dl.error);
      return text("Saved the page as PDF: " + dl.filename + " (" + (dl.size || bytes.length) + " bytes)" + (dl.opened ? ", and opened it" : ""));
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
      var dl = await window.AgentConverter.downloadAndOpen(blob, filename);
      return text("Saved: " + dl.filename + " (" + (dl.size || blob.size) + " bytes)");
    },

    browser_screenshot_save: async function (a) {
      if (!window.AgentConverter) throw new Error("Converter not loaded");
      var format = (a.format || "png").toLowerCase();
      var result = await window.AgentConverter.convert({ from: "screenshot", to: format, quality: a.quality, filename: a.filename });
      if (result.error) throw new Error(result.error);
      var dl = await window.AgentConverter.downloadAndOpen(result.blob, result.filename);
      return text("Screenshot saved: " + dl.filename + " (" + (dl.size || result.size) + " bytes)");
    },

    // Extract data from page element/URL, save as file, open with OS handler.
    // No hardcoded URLs — data comes from whatever page the user is on.
    browser_cache_extract: async function (a) {
      var data = null;
      var filename = a.filename || "resource.dat";
      var tab = await currentTab();

      if (a.ref) {
        // Read from DOM element: data-cfg, data-src, data-content, textContent, href
        var r = await act(tab.id, a.ref, function (local, attr) {
          var el = (window.__agentRefs || [])[local - 1];
          if (!el) return { error: "stale" };
          // Try custom attribute first
          if (attr && el.getAttribute(attr)) return { data: el.getAttribute(attr), type: "attr" };
          // Auto-detect: data-* attributes with base64
          var attrs = el.attributes;
          for (var i = 0; i < attrs.length; i++) {
            if (attrs[i].name.startsWith("data-") && attrs[i].value.length > 50) {
              return { data: attrs[i].value, type: "attr:" + attrs[i].name };
            }
          }
          // Href / src
          if (el.href) return { url: el.href, type: "href" };
          if (el.src) return { url: el.src, type: "src" };
          // Hidden text content
          if (el.textContent && el.textContent.length > 50) return { data: el.textContent.trim(), type: "text" };
          return { error: "No data found on this element. Specify attr= parameter." };
        }, [a.attr || ""]);
        if (r.error) throw new Error(r.error);
        if (r.data) data = r.data;
        else if (r.url) {
          // Fetch the URL content
          var resp = await fetch(r.url);
          var blob = await resp.blob();
          var reader = new FileReader();
          data = await new Promise(function (resolve) {
            reader.onload = function () { resolve(reader.result.split(",")[1]); };
            reader.readAsDataURL(blob);
          });
        }
      } else if (a.url) {
        // Fetch from URL on the page's domain (uses page cookies/session)
        var fetchUrl = a.url;
        if (!/^https?:\/\//i.test(fetchUrl)) {
          // Relative URL — resolve against current tab
          var tabUrl = tab.url;
          var base = tabUrl.replace(/[^\/]*$/, "");
          fetchUrl = base + fetchUrl;
        }
        var resp2 = await fetch(fetchUrl);
        var blob2 = await resp2.blob();
        var reader2 = new FileReader();
        data = await new Promise(function (resolve) {
          reader2.onload = function () { resolve(reader2.result.split(",")[1]); };
          reader2.readAsDataURL(blob2);
        });
      } else if (a.selector) {
        // CSS selector on the page
        var r2 = await inTop(function (sel, attrName) {
          var el = document.querySelector(sel);
          if (!el) return { error: "No element matches: " + sel };
          if (attrName && el.getAttribute(attrName)) return { data: el.getAttribute(attrName) };
          for (var i = 0; i < el.attributes.length; i++) {
            if (el.attributes[i].name.startsWith("data-") && el.attributes[i].value.length > 50) {
              return { data: el.attributes[i].value };
            }
          }
          if (el.textContent.length > 50) return { data: el.textContent.trim() };
          if (el.href) return { url: el.href };
          if (el.src) return { url: el.src };
          return { error: "No data on element" };
        }, [a.selector, a.attr || ""], "MAIN");
        if (r2.error) throw new Error(r2.error);
        if (r2.data) data = r2.data;
        else if (r2.url) {
          var resp3 = await fetch(r2.url);
          var blob3 = await resp3.blob();
          var reader3 = new FileReader();
          data = await new Promise(function (resolve) {
            reader3.onload = function () { resolve(reader3.result.split(",")[1]); };
            reader3.readAsDataURL(blob3);
          });
        }
      }

      if (!data) throw new Error("No data extracted. Use ref=, url=, or selector= to specify the source.");

      // Decode base64 to binary
      var binary = atob(data);
      var bytes = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      var blob4 = new Blob([bytes], { type: "application/octet-stream" });
      var blobUrl = URL.createObjectURL(blob4);

      // Download and open
      return new Promise(function (resolve) {
        chrome.downloads.download({ url: blobUrl, filename: filename, conflictAction: "uniquify" }, function (id) {
          if (chrome.runtime.lastError) {
            URL.revokeObjectURL(blobUrl);
            return resolve(text("Download failed: " + chrome.runtime.lastError.message));
          }
          var checks = 0;
          var timer = setInterval(function () {
            chrome.downloads.search({ id: id }, function (items) {
              if (!items || !items.length) { clearInterval(timer); resolve(text("Error")); return; }
              var item = items[0];
              if (item.state === "complete") {
                clearInterval(timer);
                URL.revokeObjectURL(blobUrl);
                if (a.open === false) { resolve(text("Saved: " + filename + " (" + bytes.length + " bytes)")); return; }
                Promise.resolve()
                  .then(function () { return chrome.downloads.open(id); })
                  .then(
                    function () { resolve(text("Saved and opened: " + filename + " (" + bytes.length + " bytes)")); },
                    function () { resolve(text("Saved: " + filename + " (" + bytes.length + " bytes)")); }
                  );
              } else if (item.state === "interrupted") {
                clearInterval(timer);
                resolve(text("Failed: " + (item.error || "interrupted")));
              } else if (++checks > 60) {
                clearInterval(timer);
                resolve(text("Timeout"));
              }
            });
          }, 500);
        });
      });
    },

    browser_download_open: async function (a) {
      var url = a.url;
      if (!url) {
        // If ref provided, get href from the element
        if (a.ref) {
          var tab = await currentTab();
          var r = await act(tab.id, a.ref, function(local) {
            var el = (window.__agentRefs || [])[local - 1];
            if (!el) return { error: "stale" };
            return { href: el.href || el.src || el.getAttribute("data-url") || "" };
          }, []);
          if (r.error) throw new Error(r.error);
          url = r.href;
        }
      }
      if (!url) throw new Error("url or ref is required");
      url = normalizeUrl(url);

      return new Promise(function (resolve, reject) {
        chrome.downloads.download({ url: url }, function (downloadId) {
          if (chrome.runtime.lastError) {
            return resolve(text("Download failed: " + chrome.runtime.lastError.message));
          }
          // Wait for download to complete, then open it
          var checks = 0;
          var timer = setInterval(function () {
            chrome.downloads.search({ id: downloadId }, function (items) {
              if (!items || !items.length) { clearInterval(timer); resolve(text("Download not found")); return; }
              var item = items[0];
              if (item.state === "complete") {
                clearInterval(timer);
                var base = (item.filename || url).split(/[\\/]/).pop();
                Promise.resolve()
                  .then(function () { return chrome.downloads.open(downloadId); })
                  .then(
                    function () { resolve(text("Downloaded and opened: " + base + " (" + (item.fileSize || 0) + " bytes)")); },
                    function () { resolve(text("Downloaded: " + base + " (" + (item.fileSize || 0) + " bytes)")); }
                  );
              } else if (item.state === "interrupted") {
                clearInterval(timer);
                resolve(text("Download interrupted: " + (item.error || "unknown error")));
              } else if (++checks > 120) {
                clearInterval(timer);
                resolve(text("Download timed out after 60s"));
              }
            });
          }, 500);
        });
      });
    },

    // =========================================================================
    // Cookie Editor — read, set, delete cookies for any domain
    // =========================================================================

    browser_cookies_get: async function (a) {
      var url = a.url || (await currentTab()).url;
      var domain = a.domain || "";
      var details = {};
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
      await chrome.cookies.remove({ url: url, name: a.name });
      return text("Deleted cookie: " + a.name);
    },

    browser_cookies_clear: async function (a) {
      var url = a.url || (await currentTab()).url;
      var domain = a.domain || "";
      var details = {};
      if (url) details.url = url;
      if (domain) details.domain = domain;
      var cookies = await chrome.cookies.getAll(details);
      var count = 0;
      for (var i = 0; i < cookies.length; i++) {
        var proto = cookies[i].secure ? "https://" : "http://";
        await chrome.cookies.remove({ url: proto + cookies[i].domain + cookies[i].path, name: cookies[i].name });
        count++;
      }
      return text("Cleared " + count + " cookies" + (domain ? " for " + domain : "") + ".");
    },

    browser_cookies_export: async function (a) {
      var url = a.url || (await currentTab()).url;
      var domain = a.domain || "";
      var details = {};
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
      var tab = await currentTab();
      var count = 0;
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        var proto = c.secure ? "https://" : "http://";
        var url = c.url || (proto + c.domain.replace(/^\./, "") + (c.path || "/"));
        var details = { url: url, name: c.name, value: c.value };
        if (c.domain) details.domain = c.domain;
        if (c.path) details.path = c.path;
        if (c.secure !== undefined) details.secure = c.secure;
        if (c.httpOnly !== undefined) details.httpOnly = c.httpOnly;
        if (c.sameSite) details.sameSite = c.sameSite;
        if (c.expirationDate) details.expirationDate = c.expirationDate;
        await chrome.cookies.set(details);
        count++;
      }
      return text("Imported " + count + " cookies.");
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
      try {
        await cdp(tab.id, "Network.enable");
        await cdp(tab.id, "Network.setUserAgentOverride", {
          userAgent: ua,
          platform: plat,
          acceptLanguage: lang,
        });

        // CDP covers the HTTP headers but not navigator.language(s), and a page-side defineProperty is lost
        // with the page's JS context on every reload — so re-inject on each load of this tab. A real function
        // with args, never code built as a string: the panel's CSP forbids eval/new Function.
        var langs = lang ? lang.split(",").map(function (s) { return s.replace(/;q=[\d.]+/, "").trim(); }).filter(Boolean) : [];
        var inject = function () {
          return chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func: pageUaOverride, args: [ua, plat, langs] });
        };
        await inject();
        watchTabLoads(tab.id, function () { inject().catch(function () {}); });
      } catch (e) {
        throw new Error("Could not override UA via DevTools: " + ((e && e.message) || e) + ". Try browser_run_js with navigator overrides.");
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
    // Multi-account / Profile isolation — sessions via incognito windows
    // =========================================================================

    browser_new_profile: async function (a) {
      // Each "profile" is an incognito window — fully isolated cookies, storage, sessions
      var url = normalizeUrl(a.url || "about:blank");
      var win;
      try {
        win = await chrome.windows.create({ url: url, incognito: true, focused: !!a.focused });
      } catch (e) {
        throw new Error("Could not create isolated profile (" + ((e && e.message) || e) + "). Enable 'Allow in Incognito' for Agent Browser at chrome://extensions.");
      }
      var tab = win.tabs && win.tabs[0];
      if (!tab) throw new Error("No tab in the new profile window.");
      currentTabId = tab.id;
      await settle(tab.id, 15000);
      return text("New isolated profile (window " + win.id + ") opened. Cookies, storage and login state are separate from other windows.\n" + (await pageLine()));
    },

    browser_list_profiles: async function () {
      var windows = await chrome.windows.getAll({ populate: true });
      var lines = [];
      for (var i = 0; i < windows.length; i++) {
        var w = windows[i];
        var tabs = (w.tabs || []).filter(function(t) { return !ownPage(t); });
        var label = w.incognito ? "[ISOLATED] " : "[MAIN] ";
        lines.push(label + "Window " + w.id + " (" + tabs.length + " tabs)" + (w.focused ? " *focused*" : ""));
        for (var j = 0; j < Math.min(tabs.length, 5); j++) {
          lines.push("  " + tabs[j].id + "  " + (tabs[j].title || "").slice(0, 50) + " — " + tabs[j].url);
        }
        if (tabs.length > 5) lines.push("  ... +" + (tabs.length - 5) + " more tabs");
      }
      return text(lines.join("\n") || "No windows.");
    },

    browser_switch_profile: async function (a) {
      if (!a.windowId) throw new Error("windowId is required (get it from browser_list_profiles)");
      var win = await chrome.windows.update(a.windowId, { focused: true });
      var tabs = await chrome.tabs.query({ windowId: a.windowId, active: true });
      if (tabs[0]) {
        currentTabId = tabs[0].id;
        return text("Switched to window " + a.windowId + (win.incognito ? " (isolated)" : "") + ". " + (await pageLine()));
      }
      return text("Switched to window " + a.windowId + " (no active tab).");
    },

    browser_close_profile: async function (a) {
      if (!a.windowId) throw new Error("windowId is required");
      await chrome.windows.remove(a.windowId);
      currentTabId = null;
      return text("Closed window " + a.windowId + " and all its tabs/sessions.");
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
        var f = fields[i];
        var entry = (refTables[tab.id] || {})[f.ref];
        if (!entry) { results.push("[" + f.ref + "]: not found"); continue; }
        try {
          var r = await act(tab.id, f.ref, pageType, [String(f.value), true, false]);
          results.push("[" + f.ref + "]: " + (r.error ? "FAIL " + r.error : "ok"));
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

    browser_network_log: async function (a) {
      var tab = await currentTab();
      try {
        await cdp(tab.id, "Network.enable");
        var entries = [];
        var timeout = (a.seconds || 3) * 1000;
        var start = Date.now();
        var listener = function(params) { entries.push(params); };
        await sleep(timeout);
        await cdp(tab.id, "Network.disable");
        return text("Network logging ran for " + (a.seconds || 3) + "s. Use browser_run_js with performance.getEntriesByType('resource') for network data.");
      } catch (e) {
        return text("Network logging: " + ((e && e.message) || e));
      }
    },

    // =========================================================================
    // Device profiles — isolated browser identity (UA + device config + proxy + cookies)
    // Wraps fingerprint.js engine + chrome.storage
    // =========================================================================

    browser_profile_create: async function (a) {
      // Generates a full coherent device profile + saves with proxy/cookie config
      if (!a.name) throw new Error("name is required");
      var PROFILES_KEY = "agentProfiles";
      var profiles = (await chrome.storage.local.get(PROFILES_KEY))[PROFILES_KEY] || {};
      var pid = "prof_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

      // Generate fingerprint from device type using the built-in engine
      var FP_ENGINE = window.AgentFingerprint;
      var fp = null;
      if (FP_ENGINE) {
        fp = FP_ENGINE.generate(a.deviceType || "random", pid);
      }

      // Fallback UA generation if fingerprint engine not loaded
      var DEVICE_TYPES = {
        "win-chrome": function() { var v = "13" + Math.floor(Math.random()*10) + ".0." + (6000+Math.floor(Math.random()*2000)) + "." + Math.floor(Math.random()*100); return { ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/" + v + " Safari/537.36", platform: "Win32" }; },
        "mac-chrome": function() { var v = "13" + Math.floor(Math.random()*10) + ".0." + (6000+Math.floor(Math.random()*2000)) + "." + Math.floor(Math.random()*100); return { ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_" + Math.floor(Math.random()*6) + ") AppleWebKit/537.36 (KHTML, like Gecko) Chrome/" + v + " Safari/537.36", platform: "MacIntel" }; },
        "android": function() { var v = "13" + Math.floor(Math.random()*10) + ".0." + (6000+Math.floor(Math.random()*2000)) + "." + Math.floor(Math.random()*100); return { ua: "Mozilla/5.0 (Linux; Android 1" + Math.floor(Math.random()*5) + "; Pixel " + (7+Math.floor(Math.random()*3)) + ") AppleWebKit/537.36 (KHTML, like Gecko) Chrome/" + v + " Mobile Safari/537.36", platform: "Linux armv8l" }; },
      };
      var deviceGen = DEVICE_TYPES[a.deviceType] || DEVICE_TYPES["win-chrome"];
      var device = fp || deviceGen();
      var lang = a.language || "en-US,en;q=0.9";

      var profile = {
        name: a.name,
        icon: a.icon || "🕵️",
        ua: a.userAgent || device.ua,
        platform: a.platform || device.platform,
        lang: lang,
        label: (a.userAgent || device.ua).slice(0, 50),
        fingerprint: fp, // Full coherent fingerprint (canvas, WebGL, audio, etc.)
        proxy: {
          enabled: !!(a.proxyHost),
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
      await chrome.storage.local.set({ [PROFILES_KEY]: profiles });

      var result = "Created profile '" + a.name + "' (id: " + pid + ")\n";
      result += "UA: " + profile.ua.slice(0, 80) + "\n";
      result += "Platform: " + profile.platform + "\n";
      result += "Proxy: " + (profile.proxy.enabled ? profile.proxy.type + "://" + profile.proxy.host + ":" + profile.proxy.port : "direct") + "\n";
      result += "Device config: " + (fp ? "full device profile applied" : "UA-only") + "\n";
      result += "Use browser_profile_launch with id '" + pid + "' to start.";
      return text(result);
    },

    browser_profile_launch: async function (a) {
      // Opens a new window and applies the full device profile.
      // Uses a regular window (not incognito) because:
      // 1. All incognito windows share ONE session — not isolated at all
      // 2. Incognito often returns null for win.tabs
      // 3. Extension may not have incognito permission
      // Instead: clear cookies for target domains → import profile cookies → apply fingerprint
      if (!a.profileId) throw new Error("profileId is required (get from browser_profile_list)");
      var PROFILES_KEY = "agentProfiles";
      var profiles = (await chrome.storage.local.get(PROFILES_KEY))[PROFILES_KEY] || {};
      var p = profiles[a.profileId];
      if (!p) throw new Error("Profile not found: " + a.profileId);

      var url = a.url || p.startUrl || "about:blank";

      // 1. Open a new window via background (side panel can't call chrome.windows.create in Edge)
      var winRes = await chrome.runtime.sendMessage({ type: "createWindow", options: { url: "about:blank", focused: true } });
      if (!winRes || !winRes.ok || !winRes.win || !winRes.win.id) throw new Error("Failed to create window — background returned: " + JSON.stringify(winRes));
      var winId = winRes.win.id;
      var tabs = await chrome.tabs.query({ windowId: winId });
      var tab = tabs[0];
      if (!tab) throw new Error("No tab in new window — try again");
      currentTabId = tab.id;

      // 2. Apply proxy
      if (p.proxy && p.proxy.enabled && p.proxy.host) {
        await chrome.storage.local.set({
          agentProxy: {
            enabled: true,
            type: p.proxy.type || "http",
            host: p.proxy.host,
            port: Number(p.proxy.port),
            username: p.proxy.username || "",
            password: p.proxy.password || "",
          }
        });
        await sleep(500); // Let background.js apply it
      }

      // 3. Apply fingerprint (triggers fp-bridge.js → inject-fingerprint.js on next load)
      if (p.fingerprint) {
        await chrome.storage.local.set({ agentActiveFingerprint: p.fingerprint });
      }

      // 4. Apply UA via CDP (persists across navigations)
      if (p.ua) {
        await settle(tab.id, 5000);
        try {
          await cdp(tab.id, "Network.enable");
          await cdp(tab.id, "Network.setUserAgentOverride", {
            userAgent: p.ua,
            platform: p.platform || "",
            acceptLanguage: p.lang || "",
          });
        } catch (e) { /* non-fatal — some pages block CDP */ }
      }

      // 5. Clear existing cookies for profile's domains, then import saved ones
      //    This provides real session isolation: each profile has its OWN cookies.
      if (p.cookies && p.cookies.length) {
        // Collect unique domains from the profile's cookie jar
        var domains = {};
        p.cookies.forEach(function(c) { if (c.domain) domains[c.domain.replace(/^\./, "")] = true; });
        // Clear cookies for each domain before importing
        for (var d in domains) {
          var existing = await chrome.cookies.getAll({ domain: d }).catch(function() { return []; });
          for (var j = 0; j < existing.length; j++) {
            var ec = existing[j];
            var proto2 = ec.secure ? "https://" : "http://";
            await chrome.cookies.remove({ url: proto2 + ec.domain.replace(/^\./, "") + ec.path, name: ec.name }).catch(function(){});
          }
        }
        var imported = 0;
        for (var i = 0; i < p.cookies.length; i++) {
          var c = p.cookies[i];
          try {
            var proto = c.secure ? "https://" : "http://";
            await chrome.cookies.set({
              url: c.url || (proto + c.domain.replace(/^\./, "") + (c.path || "/")),
              name: c.name, value: c.value,
              domain: c.domain, path: c.path || "/",
              secure: c.secure || false, httpOnly: c.httpOnly || false,
              sameSite: c.sameSite || "lax",
              expirationDate: c.expirationDate || (Math.floor(Date.now() / 1000) + 86400 * 365),
            });
            imported++;
          } catch (_) {}
        }
        // Reload to apply cookies
        if (url !== "about:blank") {
          await chrome.tabs.update(tab.id, { url: url });
          await settle(tab.id, 10000);
        }
      }

      // 6. Re-inject UA override after final navigation (CDP resets on some navigations)
      if (p.ua) {
        try {
          await cdp(tab.id, "Network.setUserAgentOverride", {
            userAgent: p.ua,
            platform: p.platform || "",
            acceptLanguage: p.lang || "",
          });
        } catch (_) {}
      }

      // 7. Set up persistent UA re-injection on navigation
      if (p.ua) {
        watchTabLoads(tab.id, function () {
          cdp(tab.id, "Network.setUserAgentOverride", {
            userAgent: p.ua, platform: p.platform || "", acceptLanguage: p.lang || "",
          }).catch(function(){});
        }, function () { chrome.storage.local.remove("agentActiveFingerprint"); });
      }

      await chrome.storage.local.set({ agentActiveProfile: a.profileId });

      var result = "Launched profile '" + p.name + "' in window " + winId + "\n";
      result += "UA: " + (p.ua || "default").slice(0, 80) + "\n";
      result += "Proxy: " + (p.proxy && p.proxy.enabled ? p.proxy.type + "://" + p.proxy.host + ":" + p.proxy.port : "direct") + "\n";
      result += "Device config: " + (p.fingerprint ? "active" : "UA-only") + "\n";
      result += "Cookies: " + (p.cookies ? p.cookies.length + " imported" : "none") + "\n";
      result += "URL: " + url;
      return text(result);
    },

    browser_profile_list: async function () {
      var PROFILES_KEY = "agentProfiles";
      var profiles = (await chrome.storage.local.get(PROFILES_KEY))[PROFILES_KEY] || {};
      var ids = Object.keys(profiles);
      if (!ids.length) return text("No profiles yet. Use browser_profile_create to make one.");
      var lines = ids.map(function(id) {
        var p = profiles[id];
        var proxy = p.proxy && p.proxy.enabled ? p.proxy.type + "://" + p.proxy.host + ":" + p.proxy.port : "direct";
        return id + "  " + (p.icon || "👤") + " " + p.name + "  |  " + (p.ua || "").slice(0, 50) + "  |  proxy: " + proxy + "  |  cookies: " + (p.cookieCount || 0) + "  |  " + (p.fingerprint ? "🛡️ full FP" : "UA only");
      });
      return text("Profiles (" + ids.length + "):\n" + lines.join("\n"));
    },

    browser_profile_save: async function (a) {
      // Snapshot current tab state into an existing profile (cookies + URL + UA)
      if (!a.profileId) throw new Error("profileId is required");
      var PROFILES_KEY = "agentProfiles";
      var profiles = (await chrome.storage.local.get(PROFILES_KEY))[PROFILES_KEY] || {};
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
      await chrome.storage.local.set({ [PROFILES_KEY]: profiles });

      return text("Saved profile '" + p.name + "': " + (p.cookieCount || 0) + " cookies, URL: " + (p.startUrl || "?").slice(0, 60));
    },

    browser_profile_delete: async function (a) {
      if (!a.profileId) throw new Error("profileId is required");
      var PROFILES_KEY = "agentProfiles";
      var profiles = (await chrome.storage.local.get(PROFILES_KEY))[PROFILES_KEY] || {};
      var name = profiles[a.profileId] ? profiles[a.profileId].name : a.profileId;
      delete profiles[a.profileId];
      await chrome.storage.local.set({ [PROFILES_KEY]: profiles });
      return text("Deleted profile '" + name + "'.");
    },
  };

  window.AgentBrowserTools = {
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
    run: function (name, args) {
      var fn = TOOLS[name];
      if (!fn) return Promise.reject(new Error("Unknown browser tool: " + name));
      return fn(args);
    },
  };
})();
