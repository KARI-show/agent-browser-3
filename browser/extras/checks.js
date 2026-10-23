// Extra feature "checks" (side panel): link and URL checks — one-shot HTTP status checks run from the
// panel page, which has host permissions for every URL (so fetch works without CORS). Built into
// extras.js only for brands that switch the feature on; browser/host/extras/checks.ts declares the tools.
//
//   browser_check_url    one address or up to 20: HEAD (GET when HEAD is refused with 405/501 or fails),
//                        redirects followed, 10 s timeout → status, final URL, time, type and size.
//   browser_check_links  the http(s) links of the current tab's top frame (deduplicated, up to 150),
//                        checked 6 at a time → the broken ones (4xx/5xx/unreachable) first, redirects,
//                        counts and the slowest few.
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
      prompt: "Check only the links in this page's footer and navigation (browser_check_links with selector \"footer, nav, header\") and report any broken or redirected ones." }
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
  };
})();
