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
      prompt: "Check this site's sitemap with browser_check_sitemap: robots.txt, the sitemaps it lists, how many URLs they contain and whether the first ones answer. Report anything missing or broken." }
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
  };
})();
