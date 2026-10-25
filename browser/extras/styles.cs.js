// Content script of the "styles" extra: the build copies it to extras-styles.cs.js in builds of brands that
// have the feature, and the feature's panel module registers it with chrome.scripting
// .registerContentScripts (id "extras-styles", http/https pages, document_start, persistAcrossSessions)
// so the edits saved for a site come back on every load, panel open or not. Classic script, ISOLATED
// world: chrome.storage.local and the DOM only, nothing from the panel.
//
// What it does: at document_start it reads the overrides saved for this host (and for "*", every
// site) from chrome.storage.local and puts the enabled ones into one <style data-agent-styles>
// element — into <head> when it exists, else onto <html> until the parser creates <head>; it keeps
// that element the LAST child of <head> (so a plain rule of equal specificity wins over the site's
// own stylesheets) with a small childList observer, and applies storage changes live. The logic is a
// factory (AgentSiteStyles.start) so tests can run it against a fake chrome and document; it starts
// itself only where a real page is around.
(function () {
  var KEY = "agentSiteStyles";
  var ATTR = "data-agent-styles";
  var PREVIEW_ATTR = "data-agent-styles-preview"; // the panel's unsaved preview may sit after ours

  /** "www.Example.com." → "example.com"; "*" stays. */
  function normHost(h) {
    h = String(h == null ? "" : h).trim().toLowerCase().replace(/\.$/, "");
    if (h === "*") return h;
    return h.replace(/^www\./, "");
  }

  /** The site's group in the stored object, by normalised host (keys were saved normalised, but be tolerant). */
  function siteGroup(all, site) {
    if (!all || typeof all !== "object") return null;
    if (all[site] && typeof all[site] === "object") return all[site];
    var keys = Object.keys(all);
    for (var i = 0; i < keys.length; i++) if (normHost(keys[i]) === site && all[keys[i]] && typeof all[keys[i]] === "object") return all[keys[i]];
    return null;
  }

  /** The CSS text to inject for a page on `host`: the enabled overrides of "*" first, then the host's own. */
  function cssFor(all, host) {
    host = normHost(host);
    var parts = [];
    var sites = host && host !== "*" ? ["*", host] : ["*"];
    sites.forEach(function (site) {
      var group = siteGroup(all, site);
      if (!group) return;
      Object.keys(group).sort().forEach(function (name) {
        var o = group[name];
        if (!o || o.enabled === false || typeof o.css !== "string" || !o.css.trim()) return;
        parts.push("/* " + (site === "*" ? "every site" : site) + " · " + String(name).replace(/\*\//g, "* /") + " */\n" + o.css.trim());
      });
    });
    return parts.join("\n\n");
  }

  /**
   * An applier over a document: apply(css) puts the text into the one <style data-agent-styles> and
   * keeps it the last element of <head> (only our own preview element may follow it). `MO` is the
   * MutationObserver constructor (null = no live re-ordering).
   */
  function makeApplier(doc, MO) {
    var el = null, mo = null, watched = null;
    function ours(n) { return !!(n && n.hasAttribute && (n.hasAttribute(ATTR) || n.hasAttribute(PREVIEW_ATTR))); }
    function parentNow() { return doc.head || doc.documentElement; }
    function isLast() {
      if (!el || !el.parentNode) return false;
      for (var n = el.nextElementSibling; n; n = n.nextElementSibling) if (!ours(n)) return false;
      return true;
    }
    function place() {
      var parent = parentNow();
      if (!el || !parent) return;
      if (el.parentNode !== parent || !isLast()) parent.appendChild(el);
      watch(parent);
    }
    // One childList observer on the element's parent: a stylesheet appended after ours moves ours back
    // to the end; while <head> does not exist yet, the same observer on <html> sees it being created.
    function watch(parent) {
      if (!MO || watched === parent) return;
      if (mo) { try { mo.disconnect(); } catch (_) {} }
      mo = new MO(function () { if (el) place(); });
      mo.observe(parent, { childList: true });
      watched = parent;
    }
    function apply(css) {
      css = String(css || "");
      if (!el || !el.parentNode) el = doc.querySelector ? doc.querySelector("style[" + ATTR + "]") : el;
      if (!css) {
        if (el && el.parentNode) el.parentNode.removeChild(el);
        el = null;
        return { removed: true };
      }
      if (!el) {
        el = doc.createElement("style");
        el.setAttribute(ATTR, "");
      }
      if (el.textContent !== css) el.textContent = css;
      place();
      return { chars: css.length };
    }
    return { apply: apply, element: function () { return el; } };
  }

  /** Wire everything up for one page: the initial read, then live updates from storage. Returns the applier. */
  function start(chromeApi, doc, host, MO) {
    var applier = makeApplier(doc, MO);
    host = normHost(host);
    function fromStore(all) {
      try { applier.apply(cssFor(all, host)); } catch (_) {}
    }
    try {
      // Chrome calls the callback; a promise-only stand-in resolves instead — either way one apply.
      var got = chromeApi.storage.local.get(KEY, function (st) { fromStore(st && st[KEY]); });
      if (got && typeof got.then === "function") got.then(function (st) { fromStore((st || {})[KEY]); }, function () {});
    } catch (_) {}
    if (chromeApi.storage.onChanged && chromeApi.storage.onChanged.addListener) {
      chromeApi.storage.onChanged.addListener(function (changes, area) {
        if (area && area !== "local") return;
        if (!changes || !changes[KEY]) return;
        fromStore(changes[KEY].newValue);
      });
    }
    return applier;
  }

  var api = { KEY: KEY, ATTR: ATTR, PREVIEW_ATTR: PREVIEW_ATTR, normHost: normHost, siteGroup: siteGroup, cssFor: cssFor, makeApplier: makeApplier, start: start };
  globalThis.AgentSiteStyles = api; // the ISOLATED world's own global; tests read the helpers off it

  // A real page: start now. Tests load this file with a fake `location` (or none) and call start() themselves.
  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local && typeof document !== "undefined" && typeof location !== "undefined" && location && location.hostname && !globalThis.__agentSiteStylesManual) {
    try { start(chrome, document, location.hostname, typeof MutationObserver === "function" ? MutationObserver : null); } catch (_) {}
  }
})();
