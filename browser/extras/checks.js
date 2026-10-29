// Extra feature "checks" (side panel): link and URL checks — one-shot HTTP status checks run from the
// panel page, which has host permissions for every URL (so fetch works without CORS). Built into
// extras.js only for brands that switch the feature on; browser/host/extras/checks.ts declares the tools.
//
//   browser_check_url    one address or up to 20: HEAD (GET when HEAD is refused with 405/501 or fails),
//                        redirects followed, 10 s timeout → status, final URL, time, type and size.
//   browser_check_links  the http(s) links of the current tab's top frame (deduplicated, up to 150),
//                        checked 6 at a time → the broken ones (4xx/5xx/unreachable) first, redirects,
//                        counts and the slowest few.
//   browser_check_seo    on-page SEO audit of the tab (one injected read): title, description, canonical,
//                        robots, viewport, lang, h1, images, links, social cards, ld+json, word count.
//   browser_check_speed  the tab's Performance API: TTFB, DOM/load events, paints, LCP, resources by type.
//   browser_check_sitemap robots.txt and the sitemap(s) of a site (index files followed), the first URLs checked.
//   browser_check_accessibility  a11y audit of the tab (one injected read): alt, labels, icon-only buttons and
//                        links, generic link texts, heading skips, landmarks, lang, tabindex, duplicate ids,
//                        iframe titles, target=_blank, aria-hidden with focusable content, autoplay. No contrast.
//   browser_check_mobile mobile readiness of the tab (one injected read): viewport meta, tap targets, small
//                        text, wide elements, overlays, overflow, declared widths over 375 px, legacy plugins.
//   browser_check_redirects  the redirect chain of an address hop by hop (manual redirects; the hops Chrome
//                        hides are observed with webRequest, or collapsed into one hidden hop).
//   browser_check_headers  the response headers of an address that matter: server, type, compression, caching,
//                        the security headers ("security headers n/7"), cookie flags without values, HTTP version.
//   🔗 Checks tab        "Check the links on this page" with a live list, the last result, "Check a URL…".
//
// Storage (chrome.storage.local): agentLinkCheck — the last link-check result, shown by the tab.
// The pure helpers are exposed on AgentExtras.checks for the unit tests. No innerHTML: link texts and
// addresses come from web pages.
(function () {
  if (!globalThis.AGENT_BRAND || !globalThis.AGENT_BRAND.has("checks")) return;
  var T = globalThis.AgentBrowserTools;
  var H = T.helpers;
  var text = H.text;

  var RESULT_KEY = "agentLinkCheck";
  var MAX_URLS = 20, MAX_LINKS = 150, MAX_SCAN = 3000, SHOWN_OK = 60;
  // Mutable so the unit tests can shorten the timeout.
  var CFG = { urlTimeout: 10000, concurrency: 6 };

  /** "example.com/x" → "https://example.com/x"; "" when it is not an http(s) address. */
  function parseHttp(u) {
    var s = String(u || "").trim();
    if (!s) return "";
    if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = "https://" + s;
    try {
      var p = new URL(s);
      return /^https?:$/.test(p.protocol) ? p.href : "";
    } catch (_) {
      return "";
    }
  }

  function fmtBytes(n) {
    if (n == null) return "";
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " kB";
    return (n / 1048576).toFixed(1) + " MB";
  }

  // ── one request ─────────────────────────────────────────────────────────

  /** One request. → { status, ok, url (final), redirected, type, length, ms, method } or { error, ms, method }. */
  async function attempt(url, method) {
    var ctrl = typeof AbortController === "function" ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, CFG.urlTimeout) : null;
    var t0 = Date.now();
    try {
      // With the user's cookies, as a click on the link would be.
      var res = await globalThis.fetch(url, { method: method, redirect: "follow", cache: "no-store", credentials: "include", signal: ctrl ? ctrl.signal : undefined });
      if (res.body && res.body.cancel) res.body.cancel().catch(function () {}); // the headers are all that matters
      var type = (res.headers && res.headers.get("content-type")) || "";
      var len = res.headers ? res.headers.get("content-length") : null;
      var length = len != null && len !== "" && isFinite(Number(len)) ? Number(len) : null;
      return {
        status: res.status,
        ok: res.status >= 200 && res.status < 300,
        url: res.url || url,
        redirected: !!res.redirected || (!!res.url && res.url !== url),
        type: String(type).split(";")[0].trim(),
        length: length,
        ms: Date.now() - t0,
        method: method,
      };
    } catch (e) {
      var reason = ctrl && ctrl.signal.aborted ? "timeout after " + CFG.urlTimeout / 1000 + " s" : String((e && e.message) || e);
      return { error: reason, ms: Date.now() - t0, method: method };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Check one address: HEAD, then GET when HEAD is refused (405/501) or fails. → { url, status, ok, ms, method, finalUrl?, redirected?, type?, length?, error? } */
  async function checkUrl(url) {
    var r = await attempt(url, "HEAD");
    if (r.error || r.status === 405 || r.status === 501) r = await attempt(url, "GET");
    var out = { url: url, ms: r.ms, method: r.method };
    if (r.error) {
      out.status = 0;
      out.ok = false;
      out.error = r.error;
      return out;
    }
    out.status = r.status;
    out.ok = r.ok;
    out.redirected = !!r.redirected;
    if (r.redirected) out.finalUrl = r.url;
    if (r.type) out.type = r.type;
    if (r.length != null) out.length = r.length;
    return out;
  }

  /** Run `fn` over `items`, at most `limit` in flight; results in input order. onProgress(done, total, results so far). */
  function runPool(items, limit, fn, onProgress) {
    var results = new Array(items.length), next = 0, done = 0;
    function worker() {
      if (next >= items.length) return Promise.resolve();
      var i = next++;
      return Promise.resolve()
        .then(function () { return fn(items[i], i); })
        .then(
          function (r) { results[i] = r; },
          function (e) { results[i] = { url: items[i] && items[i].url ? items[i].url : String(items[i]), status: 0, ok: false, error: String((e && e.message) || e), ms: 0 }; }
        )
        .then(function () {
          done++;
          if (onProgress) try { onProgress(done, items.length, results.filter(Boolean)); } catch (_) {}
          return worker();
        });
    }
    var workers = [];
    for (var k = 0; k < Math.max(1, Math.min(limit || 1, items.length)); k++) workers.push(worker());
    return Promise.all(workers).then(function () { return results; });
  }

  // ── links of the page ───────────────────────────────────────────────────

  /** Page side (injected into the top frame, self-contained): the anchors, deduplicated by address without the #fragment. */
  function collectLinks(selector, max) {
    var roots;
    if (selector) {
      try { roots = Array.prototype.slice.call(document.querySelectorAll(selector)); } catch (e) { return { error: "Invalid selector: " + selector }; }
      if (!roots.length) return { error: "Nothing on the page matches " + selector + "." };
    } else {
      roots = [document];
    }
    var links = [], seen = {}, anchors = 0;
    function label(a) {
      var t = (a.innerText || a.textContent || "").replace(/\s+/g, " ").trim();
      if (!t) t = a.getAttribute("aria-label") || a.getAttribute("title") || "";
      if (!t) { var img = a.querySelector("img[alt]"); if (img) t = img.getAttribute("alt") || ""; }
      return String(t).replace(/\s+/g, " ").trim().slice(0, 80);
    }
    roots.forEach(function (root) {
      var as = [];
      if (root.matches && root.matches("a[href]")) as.push(root);
      as = as.concat(Array.prototype.slice.call(root.querySelectorAll("a[href]")));
      as.forEach(function (a) {
        anchors++;
        var href = a.href;
        if (typeof href !== "string") href = (href && href.baseVal) || a.getAttribute("href") || ""; // SVG anchors
        try { href = new URL(href, location.href).href; } catch (e) { return; }
        if (!/^https?:/i.test(href)) return;
        var key = href.split("#")[0];
        if (seen[key] || links.length >= max) return;
        seen[key] = true;
        links.push({ url: key, text: label(a) });
      });
    });
    return { url: location.href, title: document.title, origin: location.origin, links: links, anchors: anchors };
  }

  /**
   * The links to check: http(s) only, deduplicated (the #fragment dropped), the page's own origin unless
   * external ones are wanted, at most `max`. opts: { origin, sameOriginOnly, includeExternal, max }
   * → { links: [{ url, text }], leftOut: { external, over, other } }
   */
  function filterLinks(links, opts) {
    opts = opts || {};
    var max = opts.max || MAX_LINKS;
    var externalOk = !opts.sameOriginOnly && opts.includeExternal !== false;
    var seen = {}, out = [], leftOut = { external: 0, over: 0, other: 0 };
    (links || []).forEach(function (l) {
      var u;
      try { u = new URL(l && l.url); } catch (_) { leftOut.other++; return; }
      if (!/^https?:$/.test(u.protocol)) { leftOut.other++; return; }
      u.hash = "";
      var key = u.href;
      if (seen[key]) return;
      seen[key] = true;
      if (!externalOk && opts.origin && u.origin !== opts.origin) { leftOut.external++; return; }
      if (out.length >= max) { leftOut.over++; return; }
      out.push({ url: key, text: String(l.text || "").replace(/\s+/g, " ").trim().slice(0, 80) });
    });
    return { links: out, leftOut: leftOut };
  }

  /** Disjoint counts (broken, redirected, ok), the lists behind them and the slowest answered addresses. */
  function summarize(results, slowestN) {
    var broken = [], redirected = [], fine = [];
    (results || []).forEach(function (r) {
      if (r.error || !r.ok) broken.push(r);
      else if (r.redirected) redirected.push(r);
      else fine.push(r);
    });
    var slowest = (results || []).filter(function (r) { return !r.error; }).slice().sort(function (a, b) { return b.ms - a.ms; }).slice(0, slowestN || 5);
    return { counts: { ok: fine.length, redirected: redirected.length, broken: broken.length }, broken: broken, redirected: redirected, fine: fine, slowest: slowest };
  }

  /** The link check behind the tool and the tab. opts: { sameOriginOnly, includeExternal, selector }; onProgress(done, total, results). */
  async function linkCheck(opts, onProgress) {
    opts = opts || {};
    var page = await H.inTop(collectLinks, [opts.selector ? String(opts.selector) : "", MAX_SCAN]);
    if (!page || !page.links) throw new Error("Couldn't read the page's links.");
    var sel = filterLinks(page.links, { origin: page.origin, sameOriginOnly: !!opts.sameOriginOnly, includeExternal: opts.includeExternal !== false, max: MAX_LINKS });
    var results = await runPool(sel.links, CFG.concurrency, async function (l) {
      var r = await checkUrl(l.url);
      r.text = l.text;
      return r;
    }, onProgress);
    var s = summarize(results);
    var result = { at: Date.now(), url: page.url, title: page.title, selector: opts.selector ? String(opts.selector) : "", found: page.links.length, checked: results.length, leftOut: sel.leftOut, counts: s.counts, results: results };
    var o = {};
    o[RESULT_KEY] = result;
    await chrome.storage.local.set(o);
    return result;
  }

  // ── formatting ──────────────────────────────────────────────────────────

  function statusLabel(r) { return r.error ? "down: " + r.error : "HTTP " + r.status; }

  /** One line for a checked address: "✓ 200  https://x  —  120 ms, text/html, 12.3 kB". */
  function formatUrlResult(r) {
    var mark = r.error || !r.ok ? "✗" : r.redirected ? "↪" : "✓";
    var head = r.error ? "down: " + r.error : String(r.status);
    var details = [r.ms + " ms"];
    if (r.type) details.push(r.type);
    if (r.length != null) details.push(fmtBytes(r.length));
    return mark + " " + head + "  " + r.url + (r.finalUrl ? " → " + r.finalUrl : "") + "  —  " + details.join(", ");
  }

  function formatUrlReport(results) {
    if (results.length === 1) return formatUrlResult(results[0]);
    var c = summarize(results).counts;
    return "Checked " + results.length + " addresses: " + c.ok + " ok, " + c.redirected + " redirected, " + c.broken + " broken.\n" + results.map(formatUrlResult).join("\n");
  }

  function leftOutNote(lo) {
    if (!lo) return "";
    var parts = [];
    if (lo.external) parts.push(lo.external + " external (sameOriginOnly)");
    if (lo.over) parts.push(lo.over + " over the limit of " + MAX_LINKS);
    return parts.length ? " Left out: " + parts.join(", ") + "." : "";
  }

  /** The report of a link check (the stored result object). */
  function formatLinkReport(res) {
    var results = res.results || [];
    var s = summarize(results);
    var where = (res.title ? '"' + res.title + '" (' + res.url + ")" : res.url) + (res.selector ? " within " + res.selector : "");
    if (!results.length) return "No http(s) links to check on " + where + "." + leftOutNote(res.leftOut);
    var lines = ["Checked " + results.length + " link" + (results.length === 1 ? "" : "s") + " on " + where + ": " + s.counts.ok + " ok, " + s.counts.redirected + " redirected, " + s.counts.broken + " broken." + leftOutNote(res.leftOut)];
    if (s.broken.length) {
      lines.push("Broken:");
      s.broken.forEach(function (r) { lines.push("  ✗ " + (r.error ? "down: " + r.error : r.status) + '  "' + (r.text || "(no text)") + '" → ' + r.url + (r.error ? "" : "  (" + r.ms + " ms)")); });
    }
    if (s.redirected.length) {
      lines.push("Redirected:");
      s.redirected.slice(0, 15).forEach(function (r) { lines.push('  ↪ "' + (r.text || "(no text)") + '" ' + r.url + " → " + r.finalUrl + "  (" + r.status + ")"); });
      if (s.redirected.length > 15) lines.push("  … " + (s.redirected.length - 15) + " more");
    }
    if (results.length > 1 && s.slowest.length) {
      lines.push("Slowest:");
      s.slowest.forEach(function (r) { lines.push("  " + r.ms + " ms  " + r.url); });
    }
    return lines.join("\n");
  }

  // ── SEO audit ───────────────────────────────────────────────────────────

  var SEO_TITLE_MIN = 30, SEO_TITLE_MAX = 60, SEO_DESC_MIN = 70, SEO_DESC_MAX = 160, SEO_MIN_WORDS = 300;

  /** Page side (injected into the top frame, self-contained): everything the on-page SEO audit looks at. */
  function readSeo() {
    function clean(s) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim(); }
    function content(sel) { var m = document.querySelector(sel); return m ? clean(m.getAttribute("content")) : null; }
    function all(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
    var canon = document.querySelector('link[rel~="canonical"][href]');
    var canonical = null, canonicalHost = null;
    if (canon) {
      try { var cu = new URL(canon.getAttribute("href"), location.href); canonical = cu.href; canonicalHost = cu.host; } catch (e) { canonical = clean(canon.getAttribute("href")); }
    }
    var h1 = all("h1").map(function (h) { return clean(h.innerText || h.textContent).slice(0, 120); });
    var imgs = all("img"), noAlt = [];
    imgs.forEach(function (img) { if (!img.hasAttribute("alt")) noAlt.push(String(img.currentSrc || img.getAttribute("src") || "(no src)").slice(0, 160)); });
    var links = { total: 0, internal: 0, external: 0, nofollow: 0 };
    all("a[href]").forEach(function (a) {
      var href = typeof a.href === "string" ? a.href : "";
      if (!/^https?:/i.test(href)) return;
      links.total++;
      var host = "";
      try { host = new URL(href).host; } catch (e) {}
      if (host === location.host) links.internal++; else links.external++;
      if (/(^|\s)nofollow(\s|$)/i.test(a.getAttribute("rel") || "")) links.nofollow++;
    });
    var ld = { count: 0, types: [] };
    all('script[type="application/ld+json"]').forEach(function (s) {
      ld.count++;
      var parsed;
      try { parsed = JSON.parse(s.textContent || ""); } catch (e) { ld.types.push("(invalid JSON)"); return; }
      var items = [].concat(parsed && parsed["@graph"] ? parsed["@graph"] : parsed);
      items.forEach(function (it) {
        if (!it || !it["@type"]) return;
        [].concat(it["@type"]).forEach(function (t) { if (ld.types.indexOf(String(t)) < 0) ld.types.push(String(t)); });
      });
    });
    var body = document.body ? String(document.body.innerText || "") : "";
    return {
      url: location.href,
      host: location.host,
      title: clean(document.title),
      description: content('meta[name="description"]'),
      canonical: canonical,
      canonicalHost: canonicalHost,
      robots: content('meta[name="robots"]'),
      viewport: !!document.querySelector('meta[name="viewport"]'),
      lang: clean(document.documentElement.getAttribute("lang")),
      h1: h1.slice(0, 5),
      h1Count: h1.length,
      h2: document.querySelectorAll("h2").length,
      h3: document.querySelectorAll("h3").length,
      images: { total: imgs.length, noAlt: noAlt.length, samples: noAlt.slice(0, 5) },
      links: links,
      og: { title: !!content('meta[property="og:title"]'), description: !!content('meta[property="og:description"]'), image: !!content('meta[property="og:image"]') },
      twitterCard: content('meta[name="twitter:card"]'),
      ld: ld,
      words: body.split(/\s+/).filter(Boolean).length,
      hreflang: document.querySelectorAll('link[rel="alternate"][hreflang]').length,
    };
  }

  function plural(n, word) { return n + " " + word + (n === 1 ? "" : "s"); }
  function quote(s) { return '"' + String(s) + '"'; }

  /** The audit over what readSeo returned: [{ ok, name, detail }], one entry per check, in a fixed order. */
  function seoFindings(d) {
    d = d || {};
    var out = [];
    function add(ok, name, detail) { out.push({ ok: !!ok, name: name, detail: detail }); }
    var title = String(d.title || "");
    add(title.length >= SEO_TITLE_MIN && title.length <= SEO_TITLE_MAX, "title",
      !title ? "missing" : quote(title) + " (" + title.length + " chars" + (title.length < SEO_TITLE_MIN ? ", short — aim for " + SEO_TITLE_MIN + "–" + SEO_TITLE_MAX : title.length > SEO_TITLE_MAX ? ", long — aim for " + SEO_TITLE_MIN + "–" + SEO_TITLE_MAX : "") + ")");
    var desc = d.description == null ? null : String(d.description);
    add(desc != null && desc.length >= SEO_DESC_MIN && desc.length <= SEO_DESC_MAX, "meta description",
      desc == null ? "missing" : !desc ? "empty" : desc.length + " chars" + (desc.length < SEO_DESC_MIN ? ", short — aim for " + SEO_DESC_MIN + "–" + SEO_DESC_MAX : desc.length > SEO_DESC_MAX ? ", long — aim for " + SEO_DESC_MIN + "–" + SEO_DESC_MAX : "") + ": " + quote(desc.length > 100 ? desc.slice(0, 99) + "…" : desc));
    var otherHost = !!(d.canonical && d.canonicalHost && d.host && d.canonicalHost !== d.host);
    add(d.canonical && !otherHost, "canonical", !d.canonical ? "missing" : d.canonical + (otherHost ? " — points to another host (" + d.canonicalHost + ")" : ""));
    var robots = String(d.robots || "");
    var blocked = /noindex|nofollow/i.test(robots);
    add(!blocked, "meta robots", robots ? robots + (blocked ? " — search engines are told not to index/follow this page" : "") : "none (indexable)");
    add(!!d.viewport, "viewport", d.viewport ? "meta viewport present" : "no meta viewport — not mobile-friendly");
    var hreflang = Number(d.hreflang) || 0;
    add(!!d.lang, "html lang", (d.lang ? "lang=" + d.lang : "missing") + (hreflang ? ", " + plural(hreflang, "hreflang alternate") : ""));
    var h1n = Number(d.h1Count) || 0;
    add(h1n === 1, "headings", plural(h1n, "h1") + (h1n === 0 ? " — add one" : h1n > 1 ? " — keep to one" : "") + (d.h1 && d.h1.length ? ": " + d.h1.map(quote).join(", ") : "") + "; " + plural(Number(d.h2) || 0, "h2") + ", " + plural(Number(d.h3) || 0, "h3"));
    var im = d.images || { total: 0, noAlt: 0, samples: [] };
    add(!im.noAlt, "images", plural(im.total || 0, "image") + (im.noAlt ? ", " + im.noAlt + " without alt: " + (im.samples || []).join(", ") + (im.noAlt > (im.samples || []).length ? ", …" : "") : im.total ? ", all with alt" : ""));
    var ln = d.links || {};
    add((ln.total || 0) > 0, "links", (ln.total || 0) + " http(s) links: " + (ln.internal || 0) + " internal, " + (ln.external || 0) + " external, " + (ln.nofollow || 0) + " nofollow");
    var og = d.og || {};
    var ogMissing = ["title", "description", "image"].filter(function (k) { return !og[k]; });
    add(!ogMissing.length, "social cards", (ogMissing.length ? "Open Graph missing og:" + ogMissing.join(", og:") : "Open Graph complete (title, description, image)") + "; Twitter card " + (d.twitterCard ? d.twitterCard : "none"));
    var ld = d.ld || { count: 0, types: [] };
    add(ld.count > 0, "structured data", ld.count ? plural(ld.count, "ld+json block") + ((ld.types || []).length ? ": " + ld.types.join(", ") : "") : "none (no ld+json)");
    var words = Number(d.words) || 0;
    add(words >= SEO_MIN_WORDS, "content", words + " words of visible text" + (words < SEO_MIN_WORDS ? " — thin, under " + SEO_MIN_WORDS : ""));
    return out;
  }

  function verdictOf(findings) {
    var ok = findings.filter(function (f) { return f.ok; }).length;
    return findings.length + " checks: " + ok + " ok, " + plural(findings.length - ok, "warning") + ".";
  }

  /** The report of an SEO audit: the page, the verdict, then one ✓/⚠ line per check. */
  function formatSeoReport(d) {
    var f = seoFindings(d);
    var lines = ["SEO audit of " + d.url + " — " + verdictOf(f)];
    f.forEach(function (x) { lines.push((x.ok ? "✓ " : "⚠ ") + x.name + ": " + x.detail); });
    return lines.join("\n");
  }

  // ── speed ───────────────────────────────────────────────────────────────

  var MAX_RESOURCES = 500;
  var SPEED_LIMITS = { ttfb: 800, load: 3000, bytes: 3 * 1048576, requests: 100 };
  var RES_GROUPS = ["script", "css", "img", "font", "xhr/fetch", "other"];

  /**
   * Page side (injected into the top frame, self-contained): the navigation, paint and resource entries of
   * the Performance API. Chrome hands LCP out only through a buffered PerformanceObserver, which reports
   * asynchronously, so the function returns a promise that waits briefly for it (executeScript awaits it).
   */
  function readPerf(maxResources) {
    var nav = performance.getEntriesByType ? performance.getEntriesByType("navigation")[0] : null;
    if (!nav) return { error: "No navigation timing for this page." };
    var paints = {};
    performance.getEntriesByType("paint").forEach(function (e) { paints[e.name] = e.startTime; });
    var all = performance.getEntriesByType("resource");
    var data = {
      url: location.href,
      navType: nav.type,
      ttfb: nav.responseStart - nav.requestStart,
      domInteractive: nav.domInteractive,
      dcl: nav.domContentLoadedEventEnd,
      load: nav.loadEventEnd,
      fp: paints["first-paint"] != null ? paints["first-paint"] : null,
      fcp: paints["first-contentful-paint"] != null ? paints["first-contentful-paint"] : null,
      lcp: null,
      docSize: nav.transferSize || nav.encodedBodySize || 0,
      resourceCount: all.length,
      resources: all.slice(0, maxResources).map(function (e) { return { name: e.name, initiatorType: e.initiatorType, duration: e.duration, transferSize: e.transferSize, encodedBodySize: e.encodedBodySize }; }),
    };
    var lcp = performance.getEntriesByType("largest-contentful-paint");
    if (lcp.length) { data.lcp = lcp[lcp.length - 1].startTime; return data; }
    var PO = typeof PerformanceObserver === "function" ? PerformanceObserver : null;
    if (!PO || (PO.supportedEntryTypes || []).indexOf("largest-contentful-paint") < 0) return data;
    return new Promise(function (resolve) {
      var done = false, ob = null;
      function finish() { if (done) return; done = true; try { if (ob) ob.disconnect(); } catch (e) {} resolve(data); }
      try {
        ob = new PO(function (list) { var es = list.getEntries(); if (es.length) data.lcp = es[es.length - 1].startTime; });
        ob.observe({ type: "largest-contentful-paint", buffered: true });
      } catch (e) { return finish(); }
      setTimeout(finish, 300);
    });
  }

  /** Which of RES_GROUPS a resource entry belongs to, by initiator type, then by the file extension. */
  function resourceGroup(r) {
    var it = String((r && r.initiatorType) || "").toLowerCase();
    var ext = "";
    try { var m = /\.([a-z0-9]{1,5})$/i.exec(new URL(r.name).pathname); ext = m ? m[1].toLowerCase() : ""; } catch (_) {}
    if (it === "xmlhttprequest" || it === "fetch" || it === "beacon") return "xhr/fetch";
    if (/^(woff2?|ttf|otf|eot)$/.test(ext)) return "font";
    if (it === "img" || it === "image" || /^(png|jpe?g|gif|webp|avif|svg|ico|bmp)$/.test(ext)) return "img";
    if (it === "script" || ext === "js" || ext === "mjs") return "script";
    if (it === "css" || ext === "css") return "css";
    return "other";
  }

  function fmtMs(v) { return v == null || !isFinite(v) ? "n/a" : Math.round(v) + " ms"; }
  function fmtKb(bytes) { bytes = Number(bytes) || 0; return (bytes / 1024).toFixed(bytes < 10240 ? 1 : 0) + " kB"; }
  function resourceSize(r) { return Number(r.transferSize) || Number(r.encodedBodySize) || 0; }
  function shortName(u) { return String(u || "").length > 110 ? String(u).slice(0, 109) + "…" : String(u || ""); }

  /** The speed report over what readPerf returned: the flags with a verdict, the timings, the resources by type, the slowest. */
  function speedReport(d) {
    d = d || {};
    var res = d.resources || [];
    var groups = {};
    RES_GROUPS.forEach(function (g) { groups[g] = { count: 0, bytes: 0 }; });
    var total = Number(d.docSize) || 0, unsized = 0;
    res.forEach(function (r) {
      var g = groups[resourceGroup(r)], size = resourceSize(r);
      g.count++;
      g.bytes += size;
      total += size;
      if (!size) unsized++;
    });
    var requests = (d.resourceCount != null ? Number(d.resourceCount) : res.length) + 1; // the document itself
    var f = [];
    function add(ok, name, detail) { f.push({ ok: !!ok, name: name, detail: detail }); }
    add(!(d.ttfb > SPEED_LIMITS.ttfb), "TTFB", fmtMs(d.ttfb) + (d.ttfb > SPEED_LIMITS.ttfb ? " (over " + SPEED_LIMITS.ttfb + " ms)" : ""));
    add(!(d.load > SPEED_LIMITS.load), "load", d.load > 0 ? fmtMs(d.load) + (d.load > SPEED_LIMITS.load ? " (over " + SPEED_LIMITS.load + " ms)" : "") : "load event not fired yet");
    add(total <= SPEED_LIMITS.bytes, "transfer", fmtKb(total) + (total > SPEED_LIMITS.bytes ? " (over " + fmtKb(SPEED_LIMITS.bytes) + ")" : "") + (unsized ? "; " + unsized + " cross-origin resource" + (unsized === 1 ? "" : "s") + " without a size (no Timing-Allow-Origin)" : ""));
    add(requests <= SPEED_LIMITS.requests, "requests", requests + (requests > SPEED_LIMITS.requests ? " (over " + SPEED_LIMITS.requests + ")" : "") + (d.resourceCount > res.length ? "; the first " + res.length + " resources are detailed" : ""));
    var lines = ["Page speed of " + d.url + " (" + (d.navType || "navigate") + ") — " + verdictOf(f)];
    f.forEach(function (x) { lines.push((x.ok ? "✓ " : "⚠ ") + x.name + ": " + x.detail); });
    lines.push("Timing: TTFB " + fmtMs(d.ttfb) + " · DOM interactive " + fmtMs(d.domInteractive) + " · DOMContentLoaded " + fmtMs(d.dcl) + " · load " + (d.load > 0 ? fmtMs(d.load) : "not yet") +
      " · first paint " + fmtMs(d.fp) + " · first contentful paint " + fmtMs(d.fcp) + " · LCP " + (d.lcp != null ? fmtMs(d.lcp) : "n/a"));
    lines.push("Resources: " + res.length + " + the document (" + fmtKb(d.docSize) + "), " + fmtKb(total) + " in all: " +
      RES_GROUPS.map(function (g) { return g + " " + groups[g].count + " (" + fmtKb(groups[g].bytes) + ")"; }).join(", "));
    var slowest = res.slice().sort(function (a, b) { return (Number(b.duration) || 0) - (Number(a.duration) || 0); }).slice(0, 5);
    if (slowest.length) {
      lines.push("Slowest resources:");
      slowest.forEach(function (r) { lines.push("  " + fmtMs(r.duration) + "  " + fmtKb(resourceSize(r)) + "  " + shortName(r.name)); });
    }
    return lines.join("\n");
  }

  // ── sitemap ─────────────────────────────────────────────────────────────

  var MAX_SITEMAP_NESTED = 5, MAX_SITEMAP_TOP = 5, MAX_SITEMAP_LOCS = 5000, MAX_BODY = 3 * 1048576;
  var DEFAULT_SITEMAP_MAX = 10, MAX_SITEMAP_CHECK = 50, SHOWN_LOCS = 10;

  /** GET a text resource (robots.txt, a sitemap) with the same timeout as a check. → { url, status, ok, text, type } or { url, error }. */
  async function fetchText(url) {
    var ctrl = typeof AbortController === "function" ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, CFG.urlTimeout) : null;
    try {
      var res = await globalThis.fetch(url, { method: "GET", redirect: "follow", cache: "no-store", credentials: "include", signal: ctrl ? ctrl.signal : undefined });
      var ok = res.status >= 200 && res.status < 300;
      var body = ok && typeof res.text === "function" ? String(await res.text()).slice(0, MAX_BODY) : "";
      if (!ok && res.body && res.body.cancel) res.body.cancel().catch(function () {});
      return { url: res.url || url, status: res.status, ok: ok, text: body, type: String((res.headers && res.headers.get("content-type")) || "").split(";")[0].trim() };
    } catch (e) {
      return { url: url, error: ctrl && ctrl.signal.aborted ? "timeout after " + CFG.urlTimeout / 1000 + " s" : String((e && e.message) || e) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** robots.txt → { sitemaps: [the Sitemap: lines], disallow: number of Disallow rules with a path }. */
  function parseRobots(txt) {
    var sitemaps = [], disallow = 0;
    String(txt || "").split(/\r?\n/).forEach(function (line) {
      var m = /^\s*([a-z-]+)\s*:\s*([^#]*)/i.exec(line);
      if (!m) return;
      var key = m[1].toLowerCase(), val = m[2].trim();
      if (key === "sitemap" && val && sitemaps.indexOf(val) < 0) sitemaps.push(val);
      else if (key === "disallow" && val) disallow++;
    });
    return { sitemaps: sitemaps, disallow: disallow };
  }

  function xmlUnescape(s) {
    return String(s).replace(/&(amp|lt|gt|quot|apos|#(\d+)|#x([0-9a-f]+));/gi, function (_, name, dec, hex) {
      if (dec) return String.fromCharCode(Number(dec));
      if (hex) return String.fromCharCode(parseInt(hex, 16));
      return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[name.toLowerCase()];
    });
  }

  /**
   * A sitemap's text → { index, locs }: index is true for a <sitemapindex> (locs are then the nested sitemaps),
   * false for a <urlset> (locs are the pages). <image:loc> / <video:loc> inside a <url> are not pages. A plain-text
   * sitemap (one address per line) is accepted too.
   */
  function parseSitemap(xml) {
    var s = String(xml || "");
    var locs = [], seen = {};
    function push(u) {
      u = xmlUnescape(u.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")).trim();
      if (u && !seen[u]) { seen[u] = true; locs.push(u); }
    }
    if (/<\s*(?:[\w-]+:)?(urlset|sitemapindex)\b/i.test(s)) {
      var re = /<\s*(?:([\w-]+):)?loc\s*>([\s\S]*?)<\s*\/\s*(?:[\w-]+:)?loc\s*>/gi, m;
      while ((m = re.exec(s))) if (!m[1] || !/^(image|video|news)$/i.test(m[1])) push(m[2]);
      return { index: /<\s*(?:[\w-]+:)?sitemapindex\b/i.test(s), locs: locs };
    }
    if (!/</.test(s)) s.split(/\r?\n/).forEach(function (line) { if (/^\s*https?:\/\//i.test(line)) push(line); });
    return { index: false, locs: locs };
  }

  /**
   * Fetch the candidate sitemaps and, for an index, up to MAX_SITEMAP_NESTED of the sitemaps it names.
   * → { sitemaps: [{ url, status, index, count, error, skipped }], locs: [page URLs, deduplicated, http(s) only] }
   */
  async function readSitemaps(candidates) {
    var queue = [], seen = {}, sitemaps = [], locs = [], locSeen = {}, nested = 0;
    function enqueue(u) { if (seen[u]) return false; seen[u] = true; queue.push(u); return true; }
    candidates.forEach(enqueue);
    while (queue.length) {
      var url = queue.shift();
      var entry = { url: url, status: 0, index: false, count: 0, error: "" };
      sitemaps.push(entry);
      if (/\.gz($|\?)/i.test(url)) { entry.error = "compressed (.gz) — not read"; continue; }
      var r = await fetchText(url);
      entry.status = r.status || 0;
      if (r.error) { entry.error = r.error; continue; }
      if (!r.ok) { entry.error = "HTTP " + r.status; continue; }
      var p = parseSitemap(r.text);
      entry.index = p.index;
      entry.count = p.locs.length;
      if (!p.index && !p.locs.length && !/<\s*(?:[\w-]+:)?urlset\b/i.test(r.text)) { entry.error = "not a sitemap (" + (r.type || "unknown type") + ")"; continue; }
      if (p.index) {
        p.locs.forEach(function (u) {
          if (seen[u]) return;
          if (nested >= MAX_SITEMAP_NESTED) { entry.skipped = (entry.skipped || 0) + 1; return; }
          nested++;
          enqueue(u);
        });
      } else {
        p.locs.forEach(function (u) {
          var h = parseHttp(u);
          if (h && !locSeen[h] && locs.length < MAX_SITEMAP_LOCS) { locSeen[h] = true; locs.push(h); }
        });
      }
    }
    return { sitemaps: sitemaps, locs: locs };
  }

  /** The sitemap check behind the tool. opts: { url, max, onProgress } → the result formatSitemapReport renders. */
  async function sitemapCheck(opts) {
    opts = opts || {};
    var start = opts.url ? parseHttp(opts.url) : "";
    if (opts.url && !start) throw new Error("Not an http(s) address: " + opts.url);
    if (!start) {
      var tab = await H.currentTab();
      start = parseHttp(tab && tab.url);
      if (!start) throw new Error("The current tab isn't a website — pass url.");
    }
    var u = new URL(start), origin = u.origin;
    var max = Math.max(1, Math.min(MAX_SITEMAP_CHECK, Math.floor(Number(opts.max)) || DEFAULT_SITEMAP_MAX));
    var robots = await fetchText(origin + "/robots.txt");
    var rp = robots.ok ? parseRobots(robots.text) : { sitemaps: [], disallow: 0 };
    var candidates = [];
    if (/\.xml(\.gz)?$/i.test(u.pathname)) candidates.push(u.href); // the address given is a sitemap itself
    candidates.push(origin + "/sitemap.xml");
    rp.sitemaps.forEach(function (s) {
      var abs = "";
      try { abs = new URL(s, origin + "/").href; } catch (_) {}
      if (/^https?:/.test(abs) && candidates.indexOf(abs) < 0) candidates.push(abs);
    });
    var sm = await readSitemaps(candidates.slice(0, MAX_SITEMAP_TOP));
    var toCheck = sm.locs.slice(0, max).map(function (l) { return { url: l }; });
    var results = await runPool(toCheck, CFG.concurrency, function (l) { return checkUrl(l.url); }, opts.onProgress);
    return {
      at: Date.now(),
      origin: origin,
      robots: { status: robots.status || 0, ok: !!robots.ok, error: robots.error || "", sitemaps: rp.sitemaps, disallow: rp.disallow },
      sitemaps: sm.sitemaps,
      locs: sm.locs,
      checked: results,
      counts: summarize(results).counts,
    };
  }

  function formatSitemapReport(r) {
    var rb = r.robots || {};
    var lines = ["Sitemap check of " + r.origin + ":"];
    lines.push("robots.txt: " + (rb.error ? "unreachable (" + rb.error + ")" : !rb.ok ? "missing (HTTP " + rb.status + ")" :
      plural(rb.disallow || 0, "Disallow rule") + ", " + plural((rb.sitemaps || []).length, "Sitemap: line") + ((rb.sitemaps || []).length ? " (" + rb.sitemaps.join(", ") + ")" : "")));
    var tried = r.sitemaps || [];
    var found = tried.filter(function (x) { return !x.error; });
    lines.push("Sitemaps: " + found.length + " found" + (tried.length > found.length ? ", " + (tried.length - found.length) + " not readable" : "") + (tried.length ? ":" : "."));
    tried.forEach(function (x) {
      lines.push("  " + (x.error ? "✗ " : "✓ ") + x.url + "  —  " + (x.error ? x.error : x.index ? "index of " + plural(x.count, "sitemap") + (x.skipped ? ", " + x.skipped + " not read (limit " + MAX_SITEMAP_NESTED + ")" : "") : plural(x.count, "URL")));
    });
    if (!found.length) { lines.push("No sitemap to check — pass url with the sitemap's address if the site keeps it elsewhere."); return lines.join("\n"); }
    var n = (r.locs || []).length, shown = Math.min(SHOWN_LOCS, n);
    lines.push("URLs listed: " + n + (n > shown ? " — the first " + shown + ":" : n ? ":" : ""));
    (r.locs || []).slice(0, shown).forEach(function (l) { lines.push("  " + l); });
    var checked = r.checked || [];
    if (!checked.length) return lines.join("\n");
    var s = summarize(checked);
    lines.push("Checked the first " + checked.length + ": " + s.counts.ok + " ok, " + s.counts.redirected + " redirected, " + s.counts.broken + " broken.");
    if (s.broken.length) {
      lines.push("Broken:");
      s.broken.forEach(function (x) { lines.push("  " + formatUrlResult(x)); });
    }
    if (s.redirected.length) {
      lines.push("Redirected:");
      s.redirected.slice(0, 10).forEach(function (x) { lines.push("  " + formatUrlResult(x)); });
      if (s.redirected.length > 10) lines.push("  … " + (s.redirected.length - 10) + " more");
    }
    return lines.join("\n");
  }

  // ── accessibility ───────────────────────────────────────────────────────

  var A11Y_SAMPLES = 5, A11Y_SCAN = 3000;
  var GENERIC_LINK_TEXTS = ["click here", "read more", "here", "link", "more"];

  /**
   * Page side (injected into the top frame, self-contained): everything the accessibility audit looks at,
   * as counts with up to `samples` selectors each. `generic` is the list of generic link texts. Colour
   * contrast is not read here. Nothing is changed on the page.
   */
  function readA11y(samples, maxScan, generic) {
    function clean(s) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim(); }
    function all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)).slice(0, maxScan); }
    function sel(el, depth) {
      var tag = el.tagName.toLowerCase();
      if (el.id) return tag + "#" + el.id;
      var cls = clean(typeof el.className === "string" ? el.className : "").split(" ").filter(Boolean)[0];
      if (cls) return tag + "." + cls;
      var name = el.getAttribute("name");
      if (name) return tag + '[name="' + name + '"]';
      var p = el.parentElement;
      if (!p || p === document.body || p === document.documentElement || (depth || 0) >= 2) return tag;
      var sibs = Array.prototype.filter.call(p.children, function (c) { return c.tagName === el.tagName; });
      return sel(p, (depth || 0) + 1) + " > " + tag + (sibs.length > 1 ? ":nth-of-type(" + (sibs.indexOf(el) + 1) + ")" : "");
    }
    function bucket() { return { count: 0, samples: [] }; }
    function note(b, el, extra) { b.count++; if (b.samples.length < samples) b.samples.push(sel(el).slice(0, 80) + (extra ? " " + extra : "")); }
    function labelled(el) { return !!(clean(el.getAttribute("aria-label")) || clean(el.getAttribute("aria-labelledby")) || clean(el.getAttribute("title"))); }
    /** The accessible name of a link or button, roughly: its own attributes, its text, or an image/svg/aria-labelled child. */
    function nameOf(el) {
      if (labelled(el)) return "(named)";
      var t = clean(el.innerText != null ? el.innerText : el.textContent);
      if (t) return t;
      var inner = all('img[alt], [aria-label], svg title, input[type="image"][alt]', el);
      for (var i = 0; i < inner.length; i++) {
        var v = clean(inner[i].getAttribute("alt") || inner[i].getAttribute("aria-label") || inner[i].textContent);
        if (v) return v;
      }
      return "";
    }
    var imgs = all("img"), noAlt = bucket();
    imgs.forEach(function (img) { if (!img.hasAttribute("alt")) note(noAlt, img, "(" + String(img.currentSrc || img.getAttribute("src") || "no src").slice(-60) + ")"); });
    var controls = bucket(), controlsTotal = 0;
    all("input, select, textarea").forEach(function (c) {
      var type = (c.getAttribute("type") || "text").toLowerCase();
      if (c.tagName === "INPUT" && /^(hidden|submit|reset|button|image)$/.test(type)) return; // buttons, below
      controlsTotal++;
      if (labelled(c) || clean(c.getAttribute("placeholder"))) return;
      if (c.labels && c.labels.length) return; // <label for> or a wrapping <label>
      if (c.closest("label")) return;
      note(controls, c, "(" + (c.tagName === "INPUT" ? type : c.tagName.toLowerCase()) + ")");
    });
    var links = { total: 0, empty: bucket(), generic: bucket() };
    all("a[href]").forEach(function (a) {
      links.total++;
      var n = nameOf(a), href = clean(a.getAttribute("href")).slice(0, 60);
      if (!n) { note(links.empty, a, "→ " + href); return; }
      var key = n.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
      if ((generic || []).indexOf(key) >= 0) note(links.generic, a, '"' + n + '" → ' + href);
    });
    var buttons = { total: 0, empty: bucket() };
    all('button, [role="button"], input[type="button"], input[type="image"]').forEach(function (b) {
      buttons.total++;
      var n = b.tagName === "INPUT" ? (labelled(b) ? "(named)" : clean(b.value) || clean(b.getAttribute("alt"))) : nameOf(b);
      if (!n) note(buttons.empty, b);
    });
    var levels = [], skips = bucket();
    all("h1, h2, h3, h4, h5, h6").forEach(function (h) {
      var lv = Number(h.tagName.charAt(1)), prev = levels.length ? levels[levels.length - 1] : 0;
      if (prev && lv > prev + 1) note(skips, h, "(h" + prev + " → h" + lv + ' "' + clean(h.textContent).slice(0, 40) + '")');
      levels.push(lv);
    });
    var sectioning = "article, aside, main, nav, section";
    function topLevel(tag) { return all(tag).some(function (e) { return !e.parentElement || !e.parentElement.closest(sectioning); }); }
    var landmarks = {
      main: !!document.querySelector('main, [role="main"]'),
      nav: !!document.querySelector('nav, [role="navigation"]'),
      banner: !!document.querySelector('[role="banner"]') || topLevel("header"),
      contentinfo: !!document.querySelector('[role="contentinfo"]') || topLevel("footer"),
    };
    var tabindex = bucket();
    all("[tabindex]").forEach(function (e) { var v = parseInt(e.getAttribute("tabindex"), 10); if (v > 0) note(tabindex, e, "(tabindex=" + v + ")"); });
    var ids = {}, dup = bucket();
    all("[id]").forEach(function (e) { if (e.id) ids[e.id] = (ids[e.id] || 0) + 1; });
    Object.keys(ids).forEach(function (id) { if (ids[id] > 1) { dup.count++; if (dup.samples.length < samples) dup.samples.push("#" + id + " ×" + ids[id]); } });
    var iframes = { total: 0, untitled: bucket() };
    all("iframe").forEach(function (f) {
      iframes.total++;
      if (clean(f.getAttribute("title")) || clean(f.getAttribute("aria-label"))) return;
      var host = ""; try { host = new URL(f.getAttribute("src") || "", location.href).host; } catch (e) {}
      note(iframes.untitled, f, host ? "(" + host + ")" : "");
    });
    var blank = { total: 0, noRel: bucket() };
    all('a[target="_blank"]').forEach(function (a) { blank.total++; if (!/\b(noopener|noreferrer)\b/i.test(a.getAttribute("rel") || "")) note(blank.noRel, a); });
    var hidden = bucket();
    var focusable = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    all('[aria-hidden="true"]').forEach(function (e) { var n = e.querySelectorAll(focusable).length; if (n) note(hidden, e, "(" + n + " focusable inside)"); });
    var autoplay = bucket();
    all("video, audio").forEach(function (m) { if (m.hasAttribute("autoplay") || (!m.paused && !m.ended)) note(autoplay, m, m.muted ? "(muted)" : "(with sound)"); });
    return {
      url: location.href,
      lang: clean(document.documentElement.getAttribute("lang")),
      images: { total: imgs.length, noAlt: noAlt },
      controls: { total: controlsTotal, unnamed: controls },
      links: links,
      buttons: buttons,
      headings: { count: levels.length, skips: skips },
      landmarks: landmarks,
      tabindex: tabindex,
      duplicateIds: dup,
      iframes: iframes,
      blank: blank,
      hiddenFocusable: hidden,
      autoplay: autoplay,
    };
  }

  /** "a, b, …" over a { count, samples } bucket. */
  function sampleList(b) { b = b || {}; var s = b.samples || []; return s.join(", ") + ((Number(b.count) || 0) > s.length ? ", …" : ""); }
  function countOf(b) { return (b && Number(b.count)) || 0; }

  /** The audit over what readA11y returned: [{ ok, name, detail }], one entry per check, in a fixed order. */
  function a11yFindings(d) {
    d = d || {};
    var out = [];
    function add(ok, name, detail) { out.push({ ok: !!ok, name: name, detail: detail }); }
    add(!!d.lang, "html lang", d.lang ? "lang=" + d.lang : "missing — screen readers can't pick the language");
    var im = d.images || {}, noAlt = countOf(im.noAlt);
    add(!noAlt, "images", plural(im.total || 0, "image") + (noAlt ? ", " + noAlt + " without alt: " + sampleList(im.noAlt) : im.total ? ", all with alt" : ""));
    var c = d.controls || {}, unnamed = countOf(c.unnamed);
    add(!unnamed, "form controls", !c.total ? "none" : plural(c.total, "control") + (unnamed ? ", " + unnamed + " without an accessible name (no label, aria-label, title or placeholder): " + sampleList(c.unnamed) : ", all named"));
    var ln = d.links || {}, bt = d.buttons || {}, emptyL = countOf(ln.empty), emptyB = countOf(bt.empty);
    add(!emptyL && !emptyB, "buttons and links without text", (emptyL || emptyB) ?
      (emptyL ? emptyL + " of " + plural(ln.total || 0, "link") : "") + (emptyL && emptyB ? " and " : "") + (emptyB ? emptyB + " of " + plural(bt.total || 0, "button") : "") + " icon-only without aria-label: " + [sampleList(ln.empty), sampleList(bt.empty)].filter(Boolean).join(", ") :
      plural(ln.total || 0, "link") + " and " + plural(bt.total || 0, "button") + ", all with a text or an aria-label");
    var generic = countOf(ln.generic);
    add(!generic, "link text", generic ? generic + " generic link text" + (generic === 1 ? "" : "s") + " (say where they lead): " + sampleList(ln.generic) : "no generic link texts (" + GENERIC_LINK_TEXTS.slice(0, 3).join(", ") + ", …)");
    var hd = d.headings || {}, skips = countOf(hd.skips);
    add(!skips, "heading order", !hd.count ? "no headings" : plural(hd.count, "heading") + (skips ? ", " + plural(skips, "level skip") + ": " + sampleList(hd.skips) : ", levels in order"));
    var lm = d.landmarks || {};
    var missing = ["main", "nav", "banner", "contentinfo"].filter(function (k) { return !lm[k]; });
    add(!missing.length, "landmarks", missing.length ? "missing " + missing.join(", ") + (missing.length === 4 ? " — add <main>, <nav>, <header> and <footer>" : "") : "main, nav, banner and contentinfo present");
    var ti = countOf(d.tabindex);
    add(!ti, "tabindex", ti ? plural(ti, "element") + " with a positive tabindex (it breaks the natural tab order): " + sampleList(d.tabindex) : "no positive tabindex");
    var dup = countOf(d.duplicateIds);
    add(!dup, "duplicate ids", dup ? plural(dup, "id") + " used more than once: " + sampleList(d.duplicateIds) : "all ids unique");
    var fr = d.iframes || {}, untitled = countOf(fr.untitled);
    add(!untitled, "iframes", !fr.total ? "none" : plural(fr.total, "iframe") + (untitled ? ", " + untitled + " without title: " + sampleList(fr.untitled) : ", all titled"));
    var bl = d.blank || {}, noRel = countOf(bl.noRel);
    add(!noRel, "target=_blank", noRel ? "advice — " + noRel + " of " + plural(bl.total || 0, "link") + " opening a new tab without rel=noopener: " + sampleList(bl.noRel) : bl.total ? "all " + plural(bl.total, "link") + " opening a new tab carry rel=noopener" : "no links open a new tab");
    var hf = countOf(d.hiddenFocusable);
    add(!hf, "aria-hidden", hf ? plural(hf, "aria-hidden element") + " with focusable content (keyboard users reach what screen readers can't): " + sampleList(d.hiddenFocusable) : "no aria-hidden element hides focusable content");
    var ap = countOf(d.autoplay);
    add(!ap, "autoplay", ap ? plural(ap, "autoplaying media element") + ": " + sampleList(d.autoplay) : "no autoplaying media");
    return out;
  }

  /** The report of an accessibility audit: the page, the verdict, one ✓/⚠ line per check, what is not covered. */
  function formatA11yReport(d) {
    var f = a11yFindings(d);
    var lines = ["Accessibility audit of " + d.url + " — " + verdictOf(f)];
    f.forEach(function (x) { lines.push((x.ok ? "✓ " : "⚠ ") + x.name + ": " + x.detail); });
    lines.push("Not checked here: text contrast (the palette tool reads the colours).");
    return lines.join("\n");
  }

  // ── mobile readiness ────────────────────────────────────────────────────

  var MOBILE = { tap: 44, minFont: 12, phoneWidth: 375, overlayPct: 25, samples: 5, scan: 3000, rules: 5000 };

  /**
   * Page side (injected into the top frame, self-contained): what the mobile audit looks at, at the tab's
   * current width. The tab is not resized: for a phone, the elements with a declared width or min-width
   * in px over `phoneWidth` are collected instead (inline styles, width attributes, same-origin stylesheets
   * outside min-width media queries). `limits` = { tap, minFont, phoneWidth, overlayPct, samples, scan, rules }.
   */
  function readMobile(limits) {
    var samples = limits.samples, maxScan = limits.scan;
    function clean(s) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim(); }
    function all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)).slice(0, maxScan); }
    function sel(el, depth) {
      var tag = el.tagName.toLowerCase();
      if (el.id) return tag + "#" + el.id;
      var cls = clean(typeof el.className === "string" ? el.className : "").split(" ").filter(Boolean)[0];
      if (cls) return tag + "." + cls;
      var name = el.getAttribute("name");
      if (name) return tag + '[name="' + name + '"]';
      var p = el.parentElement;
      if (!p || p === document.body || p === document.documentElement || (depth || 0) >= 2) return tag;
      var sibs = Array.prototype.filter.call(p.children, function (c) { return c.tagName === el.tagName; });
      return sel(p, (depth || 0) + 1) + " > " + tag + (sibs.length > 1 ? ":nth-of-type(" + (sibs.indexOf(el) + 1) + ")" : "");
    }
    function bucket() { return { count: 0, samples: [] }; }
    function note(b, label) { b.count++; if (b.samples.length < samples) b.samples.push(label); }
    var skip = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|HEAD|META|LINK|TITLE)$/;
    var vw = window.innerWidth, vh = window.innerHeight;
    var meta = document.querySelector('meta[name="viewport"]');
    var tap = { total: 0, small: bucket() };
    all('a[href], button, input:not([type="hidden"]), select, textarea, [role="button"]').forEach(function (el) {
      var r = el.getBoundingClientRect();
      if (!r.width || !r.height) return; // not rendered
      tap.total++;
      if (r.width < limits.tap || r.height < limits.tap) note(tap.small, sel(el).slice(0, 80) + " " + Math.round(r.width) + "×" + Math.round(r.height));
    });
    var small = bucket(), scanned = 0;
    if (document.body && document.createTreeWalker) {
      var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT), seen = [];
      while (walker.nextNode() && scanned < maxScan) {
        var node = walker.currentNode, el = node.parentElement;
        if (!el || !clean(node.nodeValue) || skip.test(el.tagName) || seen.indexOf(el) >= 0) continue;
        seen.push(el);
        scanned++;
        var cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden") continue;
        var r2 = el.getBoundingClientRect();
        if (!r2.width || !r2.height) continue;
        var px = parseFloat(cs.fontSize);
        if (px && px < limits.minFont) note(small, sel(el).slice(0, 80) + " " + Math.round(px * 10) / 10 + "px");
      }
    }
    var wide = [], overlays = bucket(), fixedWidth = bucket();
    function px(v) { return /^\d+(\.\d+)?px$/.test(v || "") ? parseFloat(v) : NaN; }
    all("body *").forEach(function (el) {
      if (skip.test(el.tagName)) return;
      var r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      if (r.width > vw + 1 || r.right > vw + 1) wide.push({ sel: sel(el).slice(0, 80), width: Math.round(r.width), right: Math.round(r.right) });
      var cs = getComputedStyle(el);
      if (cs.position === "fixed" || cs.position === "sticky") {
        var w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)), h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
        var pct = vw && vh ? Math.round((w * h * 100) / (vw * vh)) : 0;
        if (pct > limits.overlayPct) note(overlays, sel(el).slice(0, 80) + " " + pct + "% (" + cs.position + ")");
      }
      var decl = "";
      if (px(cs.minWidth) > limits.phoneWidth) decl = "min-width " + cs.minWidth;
      else if (px(el.style && el.style.width) > limits.phoneWidth) decl = "width " + el.style.width + " (inline)";
      else if (/^(IMG|IFRAME|TABLE|VIDEO|CANVAS|EMBED|OBJECT|SVG)$/.test(el.tagName) && Number(el.getAttribute("width")) > limits.phoneWidth) decl = "width=" + el.getAttribute("width");
      if (decl) note(fixedWidth, sel(el).slice(0, 80) + " " + decl);
    });
    wide.sort(function (a, b) { return b.width - a.width; });
    // Same-origin stylesheets: a px width / min-width over the phone width that matches something on the page.
    var rulesScanned = 0;
    function scanRules(rules) {
      for (var i = 0; i < rules.length && rulesScanned < limits.rules; i++) {
        var r = rules[i];
        rulesScanned++;
        if (r.cssRules && r.cssRules.length) {
          if (r.media && /min-width/i.test(r.conditionText || r.media.mediaText || "")) continue; // a desktop-only rule
          scanRules(r.cssRules);
          continue;
        }
        if (!r.style || !r.selectorText) continue;
        var mw = r.style.getPropertyValue("min-width"), w = r.style.getPropertyValue("width");
        var v = px(mw) > limits.phoneWidth ? "min-width " + mw : px(w) > limits.phoneWidth ? "width " + w : "";
        if (!v) continue;
        var el;
        try { el = document.querySelector(r.selectorText); } catch (e) { el = null; }
        if (!el || !el.getBoundingClientRect().width) continue; // matches nothing rendered on this page
        note(fixedWidth, r.selectorText.slice(0, 60) + " { " + v + " }");
      }
    }
    Array.prototype.forEach.call(document.styleSheets, function (ss) { var rules = null; try { rules = ss.cssRules; } catch (e) {} if (rules) scanRules(rules); });
    var plugins = bucket();
    all("object, embed, applet").forEach(function (p) { note(plugins, p.tagName.toLowerCase() + " (" + (p.getAttribute("type") || String(p.getAttribute("src") || p.getAttribute("data") || "").slice(-40) || "no type") + ")"); });
    return {
      url: location.href,
      innerWidth: vw,
      innerHeight: vh,
      scrollWidth: Math.max(document.documentElement.scrollWidth || 0, document.body ? document.body.scrollWidth || 0 : 0),
      viewport: meta ? clean(meta.getAttribute("content")) : null,
      tapTargets: tap,
      smallText: { count: small.count, samples: small.samples, scanned: scanned },
      wide: { count: wide.length, samples: wide.slice(0, samples).map(function (x) { return x.sel + " " + x.width + " px wide" + (x.right > x.width ? ", right edge at " + x.right : ""); }) },
      overlays: overlays,
      fixedWidth: fixedWidth,
      plugins: plugins,
    };
  }

  /** A viewport meta content ("width=device-width, initial-scale=1") → { width, initialScale, maximumScale, userScalable }; null for none. */
  function parseViewport(content) {
    if (content == null) return null;
    var out = { width: "", initialScale: NaN, maximumScale: NaN, userScalable: "" };
    String(content).split(/[,;]/).forEach(function (part) {
      var kv = part.split("="), k = String(kv[0] || "").trim().toLowerCase(), v = String(kv[1] || "").trim().toLowerCase();
      if (k === "width") out.width = v;
      else if (k === "initial-scale") out.initialScale = parseFloat(v);
      else if (k === "maximum-scale") out.maximumScale = parseFloat(v);
      else if (k === "user-scalable") out.userScalable = v;
    });
    return out;
  }

  /** The audit over what readMobile returned: [{ ok, name, detail }], one entry per check, in a fixed order. */
  function mobileFindings(d) {
    d = d || {};
    var out = [];
    function add(ok, name, detail) { out.push({ ok: !!ok, name: name, detail: detail }); }
    var vp = parseViewport(d.viewport);
    if (!vp) add(false, "viewport", "no meta viewport — phones render the page at desktop width and shrink it");
    else {
      var problems = [];
      if (vp.width !== "device-width") problems.push(vp.width ? "width=" + vp.width + " instead of device-width" : "no width=device-width");
      if (/^(no|0)$/.test(vp.userScalable)) problems.push("user-scalable=" + vp.userScalable + " blocks pinch zoom");
      if (vp.maximumScale <= 1) problems.push("maximum-scale=" + vp.maximumScale + " blocks pinch zoom");
      add(!problems.length, "viewport", quote(d.viewport) + (problems.length ? " — " + problems.join("; ") : ""));
    }
    var tap = d.tapTargets || {}, smallTap = countOf(tap.small);
    add(!smallTap, "tap targets", !tap.total ? "none found" : smallTap ? smallTap + " of " + tap.total + " under " + MOBILE.tap + "×" + MOBILE.tap + " px: " + sampleList(tap.small) : "all " + tap.total + " at least " + MOBILE.tap + "×" + MOBILE.tap + " px");
    var st = d.smallText || {}, smallText = countOf(st);
    add(!smallText, "text size", smallText ? plural(smallText, "element") + " with text under " + MOBILE.minFont + " px: " + sampleList(st) : "no visible text under " + MOBILE.minFont + " px" + (st.scanned ? " (" + st.scanned + " text elements checked)" : ""));
    var vw = Number(d.innerWidth) || 0, sw = Number(d.scrollWidth) || 0;
    add(!(sw > vw + 1), "horizontal overflow", sw > vw + 1 ? "the page scrolls sideways at " + vw + " px (content " + sw + " px wide)" : "none at " + vw + " px");
    var wide = countOf(d.wide);
    add(!wide, "wide elements", wide ? plural(wide, "element") + " wider than the viewport (" + vw + " px), widest: " + sampleList(d.wide) : "none wider than the viewport (" + vw + " px)");
    var ov = countOf(d.overlays);
    add(!ov, "overlays", ov ? plural(ov, "fixed/sticky element") + " covering over " + MOBILE.overlayPct + "% of the viewport: " + sampleList(d.overlays) : "no fixed/sticky element covers over " + MOBILE.overlayPct + "% of the viewport");
    var fw = countOf(d.fixedWidth);
    add(!fw, "phone width", fw ? plural(fw, "element") + " with a fixed width or min-width over " + MOBILE.phoneWidth + " px (would overflow a phone unless a media query changes them): " + sampleList(d.fixedWidth) : "no fixed width or min-width over " + MOBILE.phoneWidth + " px (inline styles, width attributes and same-origin stylesheets checked)");
    var pl = countOf(d.plugins);
    add(!pl, "plugins", pl ? plural(pl, "legacy plugin") + " (object/embed/applet) — phones don't run them: " + sampleList(d.plugins) : "no legacy plugins");
    return out;
  }

  /** The report of a mobile audit: the page and its size, the verdict, one ✓/⚠ line per check, the caveat. */
  function formatMobileReport(d) {
    var f = mobileFindings(d);
    var lines = ["Mobile readiness of " + d.url + " at " + d.innerWidth + "×" + d.innerHeight + " px — " + verdictOf(f)];
    f.forEach(function (x) { lines.push((x.ok ? "✓ " : "⚠ ") + x.name + ": " + x.detail); });
    lines.push("The tab was not resized: the phone-width check comes from declared widths, the others from the current size.");
    return lines.join("\n");
  }

  // ── redirect chain ──────────────────────────────────────────────────────

  var DEFAULT_HOPS = 10, MAX_HOPS = 20;

  /** One GET with the redirect not followed. → { url, status, location?, ms, type, opaque? } or { url, error, ms }. */
  async function hop(url) {
    var ctrl = typeof AbortController === "function" ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, CFG.urlTimeout) : null;
    var t0 = Date.now();
    try {
      var res = await globalThis.fetch(url, { method: "GET", redirect: "manual", cache: "no-store", credentials: "include", signal: ctrl ? ctrl.signal : undefined });
      if (res.body && res.body.cancel) res.body.cancel().catch(function () {});
      var loc = (res.headers && res.headers.get("location")) || "";
      var out = { url: url, status: res.status, ms: Date.now() - t0, type: String((res.headers && res.headers.get("content-type")) || "").split(";")[0].trim() };
      // A browser hands a manual-mode redirect out as an opaque response: status 0, no headers.
      if (res.type === "opaqueredirect" || (res.status === 0 && !loc)) out.opaque = true;
      if (loc) { try { out.location = new URL(loc, url).href; } catch (_) { out.location = loc; } }
      return out;
    } catch (e) {
      return { url: url, error: ctrl && ctrl.signal.aborted ? "timeout after " + CFG.urlTimeout / 1000 + " s" : String((e && e.message) || e), ms: Date.now() - t0 };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * The hops the browser hides: one followed GET, observed with chrome.webRequest.onBeforeRedirect (status,
   * target and timing of every hop) when the API is there; without it, one hidden hop to the final address.
   */
  async function observedChain(url) {
    var wr = typeof chrome !== "undefined" && chrome.webRequest && chrome.webRequest.onBeforeRedirect;
    var hops = [], reqId = null, last = Date.now();
    function onRedirect(d) {
      if (reqId ? d.requestId !== reqId : d.url !== url) return;
      reqId = d.requestId;
      var now = d.timeStamp || Date.now();
      hops.push({ url: d.url, status: d.statusCode, location: d.redirectUrl, ms: Math.max(0, Math.round(now - last)) });
      last = now;
    }
    if (wr) wr.addListener(onRedirect, { urls: ["<all_urls>"] });
    var r;
    try { r = await attempt(url, "GET"); } finally { if (wr) wr.removeListener(onRedirect); }
    var from = hops.length ? hops[hops.length - 1].location : url;
    if (r.error) { hops.push({ url: from, error: r.error, ms: r.ms }); return hops; }
    var spent = hops.reduce(function (s, h) { return s + h.ms; }, 0);
    if (!hops.length) hops.push({ url: url, status: 0, location: r.url, hidden: true, ms: 0 });
    hops.push({ url: r.url, status: r.status, ms: Math.max(0, r.ms - spent), type: r.type || "" });
    return hops;
  }

  /** The chain behind the tool, at most `max` redirects followed. → { start, hops: [{ url, status, location?, ms, type?, error?, hidden? }], stopped: "" | "loop" | "max" } */
  async function followChain(start, max) {
    var hops = [], seen = {}, cur = start, redirects = 0;
    seen[cur] = true;
    while (true) {
      var h = await hop(cur);
      if (h.error) { hops.push(h); return { start: start, hops: hops, stopped: "" }; }
      if (h.opaque) return { start: start, hops: hops.concat(await observedChain(cur)), stopped: "" };
      hops.push(h);
      if (!(h.status >= 300 && h.status < 400 && h.location)) return { start: start, hops: hops, stopped: "" };
      redirects++;
      if (seen[h.location]) return { start: start, hops: hops, stopped: "loop" };
      if (redirects >= max) return { start: start, hops: hops, stopped: "max" };
      seen[h.location] = true;
      cur = h.location;
    }
  }

  function schemeOf(u) { var m = /^(https?):/i.exec(String(u || "")); return m ? m[1].toLowerCase() : ""; }

  /**
   * The lines of a redirect chain: one per hop (status, from → to, latency, http→https notes), then the
   * summary and the warnings (loop, downgrade to http, hidden hops, the hop limit). `stopped` is "loop" or
   * "max" when the chain was cut; a loop is also recognised from the addresses themselves.
   */
  function describeChain(hops, stopped) {
    hops = hops || [];
    var lines = [], warnings = [], total = 0, redirects = 0, visited = {}, hidden = false;
    hops.forEach(function (h, i) {
      var n = i + 1 + ". ";
      total += Number(h.ms) || 0;
      if (h.error) { lines.push(n + "✗ down: " + h.error + "  " + h.url + "  (" + (h.ms || 0) + " ms)"); return; }
      var isRedirect = !!h.location && (h.hidden || (h.status >= 300 && h.status < 400));
      if (!isRedirect) { lines.push(n + (h.status >= 200 && h.status < 400 ? "✓ " : "✗ ") + h.status + "  " + h.url + "  (" + (h.ms || 0) + " ms" + (h.type ? ", " + h.type : "") + ")"); return; }
      redirects++;
      visited[h.url] = true;
      var notes = [];
      var from = schemeOf(h.url), to = schemeOf(h.location);
      if (from === "http" && to === "https") notes.push("http → https");
      if (from === "https" && to === "http") { notes.push("⚠ https → http"); warnings.push("Hop " + (i + 1) + " sends the visitor from https back to http (insecure, mixed content for anything embedding it)."); }
      if (h.hidden) { hidden = true; notes.push("hidden"); }
      if (visited[h.location]) { warnings.push("Loop: " + h.location + " was already visited — the chain never ends."); }
      lines.push(n + "↪ " + (h.hidden ? "redirect" : h.status) + "  " + h.url + "  →  " + h.location + "  (" + (h.ms || 0) + " ms" + (notes.length ? ", " + notes.join(", ") : "") + ")");
    });
    var last = hops[hops.length - 1];
    var final = !last ? "no response" : last.error ? "down: " + last.error : last.location && (last.hidden || (last.status >= 300 && last.status < 400)) ? "still redirecting to " + last.location : last.url + " (" + last.status + ")";
    if (stopped === "max" && !warnings.some(function (w) { return /^Loop/.test(w); })) warnings.push("Stopped after " + redirects + " redirects (the limit) — " + final + ".");
    if (stopped === "loop" && !warnings.some(function (w) { return /^Loop/.test(w); })) warnings.push("Loop: the chain comes back to an address it already visited.");
    if (hidden) warnings.push("The browser hid the intermediate hops; the redirect is shown as one step to the final address.");
    var summary = (redirects ? plural(redirects, "redirect") + ", " + plural(hops.length, "request") : "no redirect, " + plural(hops.length, "request")) + ", " + total + " ms in all; final: " + final + ".";
    return { lines: lines, summary: summary, warnings: warnings, redirects: redirects, total: total, final: final };
  }

  function formatChainReport(chain) {
    var d = describeChain(chain.hops, chain.stopped);
    var lines = ["Redirect chain of " + chain.start + " — " + d.summary];
    d.lines.forEach(function (l) { lines.push("  " + l); });
    d.warnings.forEach(function (w) { lines.push("⚠ " + w); });
    return lines.join("\n");
  }

  // ── response headers ────────────────────────────────────────────────────

  var HSTS_MIN_AGE = 15552000; // 180 days

  /** One GET with the redirects followed; the response headers as a lower-case object. → { url, status, redirected, headers, setCookie: [lines], ms } or { url, error, ms }. */
  async function fetchHeaders(url) {
    var ctrl = typeof AbortController === "function" ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, CFG.urlTimeout) : null;
    var t0 = Date.now();
    try {
      var res = await globalThis.fetch(url, { method: "GET", redirect: "follow", cache: "no-store", credentials: "include", signal: ctrl ? ctrl.signal : undefined });
      if (res.body && res.body.cancel) res.body.cancel().catch(function () {});
      var headers = {};
      if (res.headers && typeof res.headers.forEach === "function") res.headers.forEach(function (v, k) { headers[String(k).toLowerCase()] = String(v); });
      var setCookie = res.headers && typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : headers["set-cookie"] ? [headers["set-cookie"]] : [];
      return { url: res.url || url, status: res.status, redirected: !!res.redirected || (!!res.url && res.url !== url), headers: headers, setCookie: setCookie || [], ms: Date.now() - t0 };
    } catch (e) {
      return { url: url, error: ctrl && ctrl.signal.aborted ? "timeout after " + CFG.urlTimeout / 1000 + " s" : String((e && e.message) || e), ms: Date.now() - t0 };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Set-Cookie lines → [{ secure, httpOnly, sameSite }] (names and values are dropped). */
  function cookieFlags(lines) {
    return (lines || []).map(function (line) {
      var attrs = String(line).split(";").slice(1).map(function (a) { return a.trim().toLowerCase(); });
      var ss = attrs.filter(function (a) { return a.indexOf("samesite=") === 0; })[0];
      return { secure: attrs.indexOf("secure") >= 0, httpOnly: attrs.indexOf("httponly") >= 0, sameSite: ss ? ss.slice(9).replace(/^./, function (c) { return c.toUpperCase(); }) : "" };
    });
  }

  /** chrome.cookies entries → the same flags; its sameSite names are no_restriction / lax / strict / unspecified. */
  function storedCookieFlags(list) {
    return (list || []).map(function (c) {
      var ss = String(c.sameSite || "").toLowerCase();
      return { secure: !!c.secure, httpOnly: !!c.httpOnly, sameSite: ss === "lax" ? "Lax" : ss === "strict" ? "Strict" : ss === "no_restriction" ? "None" : "" };
    });
  }

  function protocolLabel(p) {
    p = String(p || "").toLowerCase();
    if (!p) return "";
    if (p === "h2" || p === "h2c") return "HTTP/2";
    if (p === "h3" || /^h3-/.test(p)) return "HTTP/3";
    if (/^http\/1/.test(p)) return "HTTP/" + p.slice(5);
    return p;
  }

  /**
   * The findings over a response's headers (lower-case keys): [{ ok, name, detail, security }], in a fixed
   * order; the entries with security=true make the "security headers n/7" verdict. extra: { cookies:
   * [{ secure, httpOnly, sameSite }] or null when unknown, cookieSource, protocol }.
   */
  function headerFindings(headers, url, extra) {
    var h = {};
    Object.keys(headers || {}).forEach(function (k) { if (headers[k] != null) h[String(k).toLowerCase()] = String(headers[k]); });
    extra = extra || {};
    var https = schemeOf(url) === "https";
    var out = [];
    function add(ok, name, detail, security) { out.push({ ok: !!ok, name: name, detail: detail, security: !!security }); }
    add(!h["x-powered-by"], "server", (h.server ? h.server : "not disclosed") + (h["x-powered-by"] ? "; x-powered-by " + h["x-powered-by"] + " — drop it, it advertises the stack" : ""));
    var ct = h["content-type"] || "", mime = ct.split(";")[0].trim().toLowerCase(), charset = /charset=([^;\s]+)/i.exec(ct);
    var isText = /^text\//.test(mime), compressible = isText || /json|xml|javascript|svg/.test(mime);
    add(!!mime && (!isText || !!charset), "content-type", mime ? mime + (charset ? "; charset=" + charset[1] : isText ? " — no charset declared, add ; charset=utf-8" : "") : "missing");
    var enc = (h["content-encoding"] || "").toLowerCase();
    add(!compressible || !!enc, "compression", enc ? "content-encoding " + enc : compressible ? "none — enable gzip or brotli for " + (mime || "text") : "none (not a text type, fine)");
    var cc = h["cache-control"], exp = h.expires, validators = [h.etag ? "etag" : "", h["last-modified"] ? "last-modified" : ""].filter(Boolean);
    add(!!(cc || exp), "caching", (cc ? "cache-control " + cc : exp ? "expires " + exp + " (no cache-control)" : "no cache-control or expires — browsers guess the lifetime") +
      (validators.length ? "; validators: " + validators.join(", ") : cc || exp ? "; no etag or last-modified — add one so revalidation is cheap" : ""));
    var hsts = h["strict-transport-security"], maxAge = hsts ? Number((/max-age=(\d+)/i.exec(hsts) || [])[1]) || 0 : 0;
    add(!!hsts && maxAge >= HSTS_MIN_AGE, "strict-transport-security",
      !hsts ? (https ? "missing — add max-age=31536000; includeSubDomains" : "missing (the address is http — serve it over https first)") :
      "max-age " + maxAge + " (" + plural(Math.round(maxAge / 86400), "day") + (maxAge < HSTS_MIN_AGE ? ", short — aim for a year" : "") + ")" + (/includesubdomains/i.test(hsts) ? ", includeSubDomains" : "") + (/preload/i.test(hsts) ? ", preload" : ""), true);
    var csp = h["content-security-policy"], cspRo = h["content-security-policy-report-only"];
    add(!!csp, "content-security-policy", csp ? "present, " + csp.length + " chars" + (/unsafe-inline/i.test(csp) ? ", allows 'unsafe-inline'" : "") + (/unsafe-eval/i.test(csp) ? ", allows 'unsafe-eval'" : "") : cspRo ? "report-only (" + cspRo.length + " chars) — not enforced" : "missing", true);
    var xfo = h["x-frame-options"], fa = csp ? /frame-ancestors\s+([^;]+)/i.exec(csp) : null;
    add(!!(xfo || fa), "frame protection", fa ? "CSP frame-ancestors " + fa[1].trim() + (xfo ? "; x-frame-options " + xfo : "") : xfo ? "x-frame-options " + xfo : "missing — add x-frame-options: DENY or CSP frame-ancestors (clickjacking)", true);
    var xcto = (h["x-content-type-options"] || "").toLowerCase();
    add(xcto === "nosniff", "x-content-type-options", xcto || "missing — add nosniff", true);
    add(!!h["referrer-policy"], "referrer-policy", h["referrer-policy"] || "missing — e.g. strict-origin-when-cross-origin", true);
    add(!!h["permissions-policy"], "permissions-policy", h["permissions-policy"] ? "present, " + h["permissions-policy"].length + " chars" : h["feature-policy"] ? "only the legacy feature-policy — add permissions-policy" : "missing — e.g. camera=(), microphone=(), geolocation=()", true);
    var cs = extra.cookies;
    if (!cs) add(true, "cookies", "none set by this response", true);
    else if (!cs.length) add(true, "cookies", "none" + (extra.cookieSource ? " " + extra.cookieSource : ""), true);
    else {
      var secure = cs.filter(function (c) { return c.secure; }).length, httpOnly = cs.filter(function (c) { return c.httpOnly; }).length;
      var ss = { Lax: 0, Strict: 0, None: 0, unset: 0 };
      cs.forEach(function (c) { ss[c.sameSite in ss ? c.sameSite : "unset"]++; });
      var bad = [];
      if (https && secure < cs.length) bad.push(cs.length - secure + " without Secure");
      if (ss.unset) bad.push(ss.unset + " without SameSite");
      if (ss.None > secure) bad.push("SameSite=None needs Secure");
      add(!bad.length, "cookies", plural(cs.length, "cookie") + (extra.cookieSource ? " " + extra.cookieSource : "") + ": Secure " + secure + ", HttpOnly " + httpOnly + ", SameSite Lax " + ss.Lax + " / Strict " + ss.Strict + " / None " + ss.None + " / unset " + ss.unset + (bad.length ? " — " + bad.join(", ") : ""), true);
    }
    add(true, "http version", protocolLabel(extra.protocol) || "not exposed");
    return out;
  }

  /** The report of a headers check: the address and status, the verdict with the security count, one ✓/⚠ line per header. */
  function formatHeadersReport(r, start) {
    var f = headerFindings(r.headers, r.url, { cookies: r.cookies, cookieSource: r.cookieSource, protocol: r.protocol });
    var sec = f.filter(function (x) { return x.security; }), secOk = sec.filter(function (x) { return x.ok; }).length;
    var lines = ["Response headers of " + r.url + " — HTTP " + r.status + (r.redirected && start && start !== r.url ? " (after redirect from " + start + ")" : "") + ", " + r.ms + " ms — security headers " + secOk + "/" + sec.length + "; " + verdictOf(f)];
    f.forEach(function (x) { lines.push((x.ok ? "✓ " : "⚠ ") + x.name + ": " + x.detail); });
    return lines.join("\n");
  }

  /** The address a tool works on: the argument, or the current tab's URL. */
  async function targetUrl(given) {
    if (given) {
      var p = parseHttp(given);
      if (!p) throw new Error("Not an http(s) address: " + given);
      return p;
    }
    var tab = await H.currentTab();
    var u = parseHttp(tab && tab.url);
    if (!u) throw new Error("The current tab isn't a website — pass url.");
    return u;
  }

  // ── tools ───────────────────────────────────────────────────────────────

  T.register("browser_check_url", async function (a) {
    a = a || {};
    var list = Array.isArray(a.urls) ? a.urls.slice() : [];
    if (a.url) list.unshift(a.url);
    if (!list.length) throw new Error("url is required (one address), or urls (a list of up to " + MAX_URLS + ").");
    if (list.length > MAX_URLS) throw new Error("At most " + MAX_URLS + " addresses per call (got " + list.length + ").");
    var urls = list.map(function (u) {
      var p = parseHttp(u);
      if (!p) throw new Error("Not an http(s) address: " + u);
      return { url: p };
    });
    var results = await runPool(urls, CFG.concurrency, function (l) { return checkUrl(l.url); });
    return text(formatUrlReport(results));
  });

  T.register("browser_check_links", async function (a) {
    return text(formatLinkReport(await linkCheck(a || {})));
  });

  T.register("browser_check_seo", async function () {
    var d = await H.inTop(readSeo, []);
    if (!d || !d.url) throw new Error("Couldn't read the page for the SEO audit.");
    return text(formatSeoReport(d));
  });

  T.register("browser_check_speed", async function () {
    var d = await H.inTop(readPerf, [MAX_RESOURCES]);
    if (!d || !d.url) throw new Error("No timing data for this page.");
    return text(speedReport(d));
  });

  T.register("browser_check_sitemap", async function (a) {
    a = a || {};
    return text(formatSitemapReport(await sitemapCheck({ url: a.url, max: a.max })));
  });

  T.register("browser_check_accessibility", async function () {
    var d = await H.inTop(readA11y, [A11Y_SAMPLES, A11Y_SCAN, GENERIC_LINK_TEXTS]);
    if (!d || !d.url) throw new Error("Couldn't read the page for the accessibility audit.");
    return text(formatA11yReport(d));
  });

  T.register("browser_check_mobile", async function () {
    var d = await H.inTop(readMobile, [MOBILE]);
    if (!d || !d.url) throw new Error("Couldn't read the page for the mobile audit.");
    return text(formatMobileReport(d));
  });

  T.register("browser_check_redirects", async function (a) {
    a = a || {};
    var start = await targetUrl(a.url);
    var max = Math.max(1, Math.min(MAX_HOPS, Math.floor(Number(a.max)) || DEFAULT_HOPS));
    return text(formatChainReport(await followChain(start, max)));
  });

  T.register("browser_check_headers", async function (a) {
    a = a || {};
    var start = await targetUrl(a.url);
    var r = await fetchHeaders(start);
    if (r.error) throw new Error("No response from " + start + ": " + r.error);
    // Set-Cookie is hidden from fetch in a browser: the cookies stored for the address stand in (flags only).
    r.cookies = null;
    r.cookieSource = "";
    if (r.setCookie && r.setCookie.length) { r.cookies = cookieFlags(r.setCookie); r.cookieSource = "set by this response"; }
    else if (typeof chrome !== "undefined" && chrome.cookies && typeof chrome.cookies.getAll === "function") {
      try { r.cookies = storedCookieFlags(await chrome.cookies.getAll({ url: r.url })); r.cookieSource = "stored for this address"; } catch (_) { r.cookies = null; }
    }
    r.protocol = "";
    try {
      var entries = typeof performance !== "undefined" && performance.getEntriesByName ? performance.getEntriesByName(r.url) : [];
      if (entries.length) r.protocol = entries[entries.length - 1].nextHopProtocol || "";
    } catch (_) {}
    return text(formatHeadersReport(r, start));
  });

  // ── 🔗 Checks tab ───────────────────────────────────────────────────────

  function linkItem(el, r) {
    var bad = r.error || !r.ok;
    return el("div", { className: "cmd-item event" }, [
      el("span", { className: "cmd-icon" }, [bad ? "✗" : r.redirected ? "↪" : "✓"]),
      el("div", { className: "cmd-body" }, [
        el("div", { className: "cmd-name" }, [r.text || "(no text)"]),
        el("div", { className: "cmd-desc mono" + (bad ? " bad" : "") }, [statusLabel(r) + " · " + r.ms + " ms · " + r.url + (r.finalUrl ? " → " + r.finalUrl : "")]),
      ]),
      el("div", { className: "prof-actions" }, [
        el("button", { className: "prof-btn", title: "Open the link in a new tab", onclick: function () { chrome.tabs.create({ url: r.url }); } }, ["Open"]),
      ]),
    ]);
  }

  /** The result list: a summary, then the broken links, the redirected ones and (capped) the fine ones. */
  function renderResult(box, ctx, res, live) {
    var el = ctx.el;
    var results = res.results || [];
    var s = summarize(results);
    box.textContent = "";
    box.appendChild(el("div", { className: "cmd-group-title" }, [live ? "Checking links… " + results.length + (res.total ? " / " + res.total : "") : "Last check · " + ctx.ago(res.at)]));
    box.appendChild(el("div", { className: "cmd-item event" }, [
      el("span", { className: "cmd-icon" }, [s.counts.broken ? "⚠" : "✓"]),
      el("div", { className: "cmd-body wide" }, [
        el("div", { className: "cmd-name" }, [res.title || res.url || "This page"]),
        el("div", { className: "cmd-desc" }, [results.length + " link" + (results.length === 1 ? "" : "s") + " · " + s.counts.ok + " ok · " + s.counts.redirected + " redirected · " + s.counts.broken + " broken" + (res.selector ? " · within " + res.selector : "")]),
        res.url ? el("div", { className: "cmd-desc mono" }, [res.url]) : null,
        !live && results.length ? el("div", { className: "prof-actions" }, [
          el("button", { className: "prof-btn", onclick: function () { ctx.sendPrompt("Here is the last link check of " + res.url + ":\n\n" + formatLinkReport(res) + "\n\nTell me what to fix first."); } }, ["💬 Discuss in chat"]),
        ]) : null,
      ]),
    ]));
    s.broken.concat(s.redirected).forEach(function (r) { box.appendChild(linkItem(el, r)); });
    s.fine.slice(0, SHOWN_OK).forEach(function (r) { box.appendChild(linkItem(el, r)); });
    if (s.fine.length > SHOWN_OK) box.appendChild(el("div", { className: "cmd-desc" }, ["… " + (s.fine.length - SHOWN_OK) + " more links answered ok"]));
  }

  var checking = false;
  async function checkPage(box, ctx) {
    if (checking) { ctx.status("A link check is already running.", "bad"); return; }
    checking = true;
    ctx.status("Collecting the links…");
    try {
      var res = await linkCheck({}, function (done, total, results) {
        ctx.status("Checking links… " + done + " / " + total);
        renderResult(box, ctx, { at: Date.now(), results: results, total: total }, true);
      });
      ctx.status(res.counts.broken ? "✗ " + res.counts.broken + " broken link" + (res.counts.broken === 1 ? "" : "s") + " of " + res.checked + "." : "✓ All " + res.checked + " links answered.", res.counts.broken ? "bad" : "good");
      renderResult(box, ctx, res, false);
    } catch (e) {
      ctx.status("⚠ " + ((e && e.message) || e), "bad");
    } finally {
      checking = false;
    }
  }

  async function renderTab(content, ctx) {
    var el = ctx.el;
    var last = (await chrome.storage.local.get(RESULT_KEY))[RESULT_KEY] || null;
    content.textContent = "";
    var resultBox = el("div");
    content.appendChild(el("div", { className: "cmd-item", onclick: function () { return checkPage(resultBox, ctx); } }, [
      el("span", { className: "cmd-icon" }, ["🔗"]),
      el("div", { className: "cmd-body" }, [
        el("div", { className: "cmd-name" }, ["Check the links on this page"]),
        el("div", { className: "cmd-desc" }, ["Every link of the current tab is requested (6 at a time, HEAD then GET); the broken ones come first, then the redirects."]),
      ]),
    ]));
    // Check a URL…
    var input = el("input", { placeholder: "https://example.com/page", "aria-label": "Address to check" });
    var go = el("button", { className: "prof-btn" }, ["Check"]);
    var line = el("div", { className: "cmd-desc mono" });
    var runOne = async function () {
      var u = parseHttp(input.value);
      if (!u) { ctx.status("⚠ Enter an http(s) address.", "bad"); return; }
      ctx.status("Checking " + u + "…");
      line.textContent = "";
      var r = await checkUrl(u);
      var bad = r.error || !r.ok;
      line.textContent = formatUrlResult(r);
      line.className = "cmd-desc mono" + (bad ? " bad" : "");
      ctx.status((bad ? "✗ " : "✓ ") + statusLabel(r), bad ? "bad" : "good");
    };
    go.addEventListener("click", runOne);
    input.addEventListener("keydown", function (e) { if (e.key === "Enter") runOne(); });
    content.appendChild(el("div", { className: "cmd-item event" }, [
      el("span", { className: "cmd-icon" }, ["🌐"]),
      el("div", { className: "cmd-body wide" }, [
        ctx.field("Check a URL…", input),
        el("div", { className: "prof-actions" }, [go]),
        line,
      ]),
    ]));
    content.appendChild(resultBox);
    if (last) renderResult(resultBox, ctx, last, false);
    else resultBox.appendChild(el("div", { className: "cmd-empty" }, ["No link check yet."]));
  }

  globalThis.AgentExtras.tabs.push({ id: "checks", label: "🔗 Checks", storageKeys: [RESULT_KEY], render: renderTab });

  globalThis.AgentExtras.commands.push(
    { group: "Monitoring", icon: "🔗", name: "Find broken links on this page",
      prompt: "Check the links on this page with browser_check_links and report the broken ones (status, link text and where they point), the redirects and anything unusually slow." },
    { group: "Monitoring", icon: "🌐", name: "Check this URL's status",
      prompt: "Check this URL with browser_check_url and tell me its status, final address, response time and content type: ", partial: true },
    { group: "Monitoring", icon: "🧭", name: "Check the links in the footer and navigation only",
      prompt: "Check only the links in this page's footer and navigation (browser_check_links with selector \"footer, nav, header\") and report any broken or redirected ones." },
    { group: "Monitoring", icon: "🔍", name: "SEO audit of this page",
      prompt: "Run an SEO audit of this page with browser_check_seo and tell me what to fix first, in order of impact." },
    { group: "Monitoring", icon: "⚡", name: "Page speed report",
      prompt: "Measure this page's speed with browser_check_speed and explain the numbers: what is slow, which resources weigh most, and what would help." },
    { group: "Monitoring", icon: "🗺", name: "Check the sitemap",
      prompt: "Check this site's sitemap with browser_check_sitemap: robots.txt, the sitemaps it lists, how many URLs they contain and whether the first ones answer. Report anything missing or broken." },
    { group: "Monitoring", icon: "♿", name: "Accessibility audit of this page",
      prompt: "Audit this page's accessibility with browser_check_accessibility and tell me what to fix first, naming the elements concerned." },
    { group: "Monitoring", icon: "📱", name: "Mobile readiness of this page",
      prompt: "Check this page's mobile readiness with browser_check_mobile and explain what would break on a phone and how to fix it." },
    { group: "Monitoring", icon: "↪", name: "Redirect chain of this URL",
      prompt: "Follow the redirect chain of this URL with browser_check_redirects and tell me each hop, the final address and anything wrong (loops, a drop to http, slow hops): ", partial: true },
    { group: "Monitoring", icon: "📋", name: "Response headers of this page",
      prompt: "Check this page's response headers with browser_check_headers and tell me which security, caching and compression headers are missing or wrong, and what to set." }
  );

  // Pure helpers for the unit tests (and other extras).
  globalThis.AgentExtras.checks = {
    RESULT_KEY: RESULT_KEY,
    MAX_URLS: MAX_URLS,
    MAX_LINKS: MAX_LINKS,
    config: CFG,
    parseHttp: parseHttp,
    fmtBytes: fmtBytes,
    checkUrl: checkUrl,
    runPool: runPool,
    collectLinks: collectLinks,
    filterLinks: filterLinks,
    summarize: summarize,
    linkCheck: linkCheck,
    formatUrlResult: formatUrlResult,
    formatUrlReport: formatUrlReport,
    formatLinkReport: formatLinkReport,
    renderResult: renderResult,
    // SEO, speed, sitemap
    readSeo: readSeo,
    seoFindings: seoFindings,
    formatSeoReport: formatSeoReport,
    readPerf: readPerf,
    resourceGroup: resourceGroup,
    speedReport: speedReport,
    fetchText: fetchText,
    parseRobots: parseRobots,
    parseSitemap: parseSitemap,
    readSitemaps: readSitemaps,
    sitemapCheck: sitemapCheck,
    formatSitemapReport: formatSitemapReport,
    // accessibility, mobile, redirects, headers
    GENERIC_LINK_TEXTS: GENERIC_LINK_TEXTS,
    MOBILE: MOBILE,
    readA11y: readA11y,
    a11yFindings: a11yFindings,
    formatA11yReport: formatA11yReport,
    readMobile: readMobile,
    parseViewport: parseViewport,
    mobileFindings: mobileFindings,
    formatMobileReport: formatMobileReport,
    hop: hop,
    followChain: followChain,
    describeChain: describeChain,
    formatChainReport: formatChainReport,
    fetchHeaders: fetchHeaders,
    cookieFlags: cookieFlags,
    storedCookieFlags: storedCookieFlags,
    headerFindings: headerFindings,
    formatHeadersReport: formatHeadersReport,
  };
})();
