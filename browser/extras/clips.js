// Extra feature "clips" (side panel): research clips — passages saved from pages together with their
// source (title, URL, site, time), a note and tags, listed by site, searched, edited and exported as
// Markdown; a citation of the current page (APA, MLA, Harvard, BibTeX) from its metadata; reader mode
// (the page's main text as Markdown, saved as a clip); and the page's clips marked in the page. Built
// into extras.js only for brands that switch the feature on. The tools are declared in
// browser/host/extras/clips.ts; this file registers them, the 📎 tab of the 🧩 panel and the
// "Research" quick commands through the registry browserTools.js provides.
//
// Storage: chrome.storage.local[KEY] = [clip, …] newest first, at most MAX clips. A clip is
// { id, text, note, title, url, host, t, tags? }. Everything in it came from a web page or the model, so
// the tab's DOM is built with ctx.el (text nodes), never innerHTML. The page-side functions are injected
// with chrome.scripting.executeScript and must stay self-contained (no closures over this file).
(function () {
  if (!globalThis.AGENT_BRAND || !globalThis.AGENT_BRAND.has("clips")) return;
  var T = globalThis.AgentBrowserTools;
  var X = globalThis.AgentExtras;
  if (!T || !X) return;
  var H = T.helpers;
  var text = H.text;

  var KEY = "agentClips";
  var MAX = 300; // clips kept; the oldest go first
  var MAX_TEXT = 4000; // characters per clip
  var MAX_NOTE = 500;
  var MAX_TAGS = 10; // tags per clip
  var MAX_TAG = 24; // characters per tag

  // ── Pure helpers (exposed on AgentExtras.clips for the unit tests) ─────

  function hostOf(url) {
    try {
      var u = new URL(url);
      return /^https?:$/.test(u.protocol) ? u.hostname.replace(/^www\./, "") : "";
    } catch (_) { return ""; }
  }
  function normalizeText(s) {
    return String(s == null ? "" : s).replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }
  function firstLine(s, max) {
    max = max || 80;
    var line = normalizeText(s).split("\n")[0] || "";
    return line.length > max ? line.slice(0, max - 1).replace(/\s+$/, "") + "…" : line;
  }
  function ago(ts) {
    if (!ts) return "";
    var d = Date.now() - ts;
    if (d < 60000) return "just now";
    if (d < 3600000) return Math.floor(d / 60000) + "m ago";
    if (d < 86400000) return Math.floor(d / 3600000) + "h ago";
    return Math.floor(d / 86400000) + "d ago";
  }
  function isoDate(ts) { return new Date(ts).toISOString().slice(0, 10); }
  function newId(list) {
    var taken = {};
    (list || []).forEach(function (c) { taken[c.id] = true; });
    var id;
    do { id = "clp_" + Math.random().toString(36).slice(2, 8); } while (taken[id]);
    return id;
  }

  /** A passage as stored: normalized, cut to MAX_TEXT at a word boundary. */
  function capText(s) {
    var body = normalizeText(s);
    return body.length > MAX_TEXT ? body.slice(0, MAX_TEXT - 1).replace(/\s+\S*$/, "") + "…" : body;
  }
  /** A note as stored: one line, at most MAX_NOTE characters. */
  function capNote(s) { return normalizeText(s).replace(/\s*\n\s*/g, " ").slice(0, MAX_NOTE); }

  /** A clip from the passage and the tab it came from; the text is cut to MAX_TEXT. Throws on an empty passage. */
  function makeClip(input, tab, now, list) {
    var body = capText(input && input.text);
    if (!body) throw new Error("Nothing is selected on the page — select the passage first, or pass text.");
    var url = (tab && tab.url) || "";
    return {
      id: newId(list),
      text: body,
      note: capNote(input && input.note),
      title: normalizeText(tab && tab.title).replace(/\s*\n\s*/g, " ").slice(0, 200),
      url: url,
      host: hostOf(url),
      t: now || Date.now(),
    };
  }
  /** Newest first, capped. */
  function addClip(list, clip) { return [clip].concat(list || []).slice(0, MAX); }
  function sameHost(a, b) { return String(a || "").replace(/^www\./, "").toLowerCase() === String(b || "").replace(/^www\./, "").toLowerCase(); }
  /** { kept, removed } for a selection by id, by host, or host "*" (everything). */
  function removeClips(list, sel) {
    list = list || [];
    var removed;
    if (sel && sel.id) removed = list.filter(function (c) { return c.id === sel.id; });
    else if (sel && sel.host === "*") removed = list.slice();
    else if (sel && sel.host) removed = list.filter(function (c) { return sameHost(c.host, sel.host); });
    else throw new Error("Give id or host (host '*' deletes every clip).");
    var gone = {};
    removed.forEach(function (c) { gone[c.id] = true; });
    return { kept: list.filter(function (c) { return !gone[c.id]; }), removed: removed };
  }
  /** [{ host, clips }] in order of the most recent clip (the list is newest first); hosts compared without www. */
  function groupByHost(list, host) {
    var groups = [];
    var byHost = {};
    (list || []).forEach(function (c) {
      if (host && !sameHost(c.host, host)) return;
      var key = (c.host || "").toLowerCase();
      if (!byHost[key]) { byHost[key] = { host: c.host || "", clips: [] }; groups.push(byHost[key]); }
      byHost[key].clips.push(c);
    });
    return groups;
  }
  function groupLabel(g) { return g.host || "other pages"; }

  function queryWords(q) { return String(q == null ? "" : q).toLowerCase().split(/\s+/).filter(Boolean); }
  function hasWord(s, w) { return String(s || "").toLowerCase().indexOf(w) !== -1; }
  /** The clips in which every word of `query` occurs — in the text, note, source title or site (case-insensitive) — optionally from one site. */
  function searchClips(list, query, host) {
    var ws = queryWords(query);
    if (!ws.length) throw new Error("query is required: the words to look for.");
    return (list || []).filter(function (c) {
      if (host && !sameHost(c.host, host)) return false;
      var hay = [c.text, c.note, c.title, c.host].map(function (s) { return String(s || "").toLowerCase(); }).join("\n");
      return ws.every(function (w) { return hay.indexOf(w) !== -1; });
    });
  }
  /** Where a search matched when the passage itself holds none of the words: "note", "title", "site" — else "". */
  function matchedIn(c, query) {
    var ws = queryWords(query);
    if (ws.some(function (w) { return hasWord(c.text, w); })) return "";
    var where = [];
    if (ws.some(function (w) { return hasWord(c.note, w); })) where.push("note");
    if (ws.some(function (w) { return hasWord(c.title, w); })) where.push("title");
    if (ws.some(function (w) { return hasWord(c.host, w); })) where.push("site");
    return where.join("/");
  }

  /**
   * The list with the note and/or the text of clip `id` replaced, normalized and capped like a saved clip.
   * → { list, clip, changed: ["text" | "note"], cut }; throws on an unknown id or when nothing is given.
   */
  function updateClip(list, id, changes) {
    list = list || [];
    changes = changes || {};
    var at = -1;
    list.forEach(function (c, i) { if (c.id === id) at = i; });
    if (at < 0) throw new Error("No clip with id " + id + " — browser_clip_list shows the ids.");
    if (changes.text == null && changes.note == null) throw new Error("Give note and/or text to change.");
    var clip = Object.assign({}, list[at]);
    var changed = [];
    var cut = false;
    if (changes.text != null) {
      var body = capText(changes.text);
      if (!body) throw new Error("text is empty — pass the new passage, or delete the clip with browser_clip_delete.");
      cut = normalizeText(changes.text).length > MAX_TEXT;
      if (body !== clip.text) { clip.text = body; changed.push("text"); }
    }
    if (changes.note != null) {
      var note = capNote(changes.note);
      if (note !== (clip.note || "")) { clip.note = note; changed.push("note"); }
    }
    var out = list.slice();
    out[at] = clip;
    return { list: out, clip: clip, changed: changed, cut: cut };
  }

  // ── Tags ───────────────────────────────────────────────────────────────

  /**
   * Tags as stored: lowercase, trimmed, a leading # dropped, inner spaces as -, only letters, digits, -
   * and _, at most MAX_TAG characters, repeats folded. Takes an array or one string ("a, b" is two tags).
   */
  function normTags(tags) {
    var out = [];
    var seen = {};
    (Array.isArray(tags) ? tags : tags == null ? [] : [tags]).forEach(function (raw) {
      String(raw == null ? "" : raw).split(",").forEach(function (part) {
        var t = part.trim().toLowerCase().replace(/^#+/, "").replace(/\s+/g, "-").replace(/[^\p{L}\p{N}_-]/gu, "").replace(/^[-_]+|[-_]+$/g, "").slice(0, MAX_TAG);
        if (t && !seen[t]) { seen[t] = true; out.push(t); }
      });
    });
    return out;
  }
  /**
   * The list with the tags of clip `id` changed: (tags − remove) ∪ add, kept to MAX_TAGS (the oldest
   * first; what did not fit is in `dropped`). → { list, clip, added, removed, dropped }; throws on an
   * unknown id or when nothing is given.
   */
  function tagClip(list, id, changes) {
    list = list || [];
    changes = changes || {};
    var at = -1;
    list.forEach(function (c, i) { if (c.id === id) at = i; });
    if (at < 0) throw new Error("No clip with id " + id + " — browser_clip_list shows the ids.");
    var add = normTags(changes.add);
    var remove = normTags(changes.remove);
    if (!add.length && !remove.length) throw new Error("Give add and/or remove: the tags to put on or take off the clip.");
    var clip = Object.assign({}, list[at]);
    var have = normTags(clip.tags);
    var kept = have.filter(function (t) { return remove.indexOf(t) === -1; });
    var all = kept.concat(add.filter(function (t) { return kept.indexOf(t) === -1; }));
    var tags = all.slice(0, MAX_TAGS);
    if (tags.length) clip.tags = tags; else delete clip.tags;
    var out = list.slice();
    out[at] = clip;
    return {
      list: out, clip: clip,
      added: tags.filter(function (t) { return have.indexOf(t) === -1; }),
      removed: have.filter(function (t) { return tags.indexOf(t) === -1; }),
      dropped: all.slice(MAX_TAGS),
    };
  }
  /** The clips carrying `tag` (normalised like a stored one); every clip when tag is empty. Throws on a tag with nothing left after normalising. */
  function withTag(list, tag) {
    var t = normTags([tag])[0] || "";
    if (String(tag || "").trim() && !t) throw new Error("tag '" + tag + "' holds no letters or digits.");
    if (!t) return list || [];
    return (list || []).filter(function (c) { return (c.tags || []).indexOf(t) !== -1; });
  }
  function tagsText(c) { return c.tags && c.tags.length ? c.tags.map(function (t) { return "#" + t; }).join(" ") : ""; }

  /**
   * The list the model sees: grouped by site, ids, the first line of each clip and its tags. `opts.heading`
   * replaces "Clips", `opts.empty` the no-clips line, `opts.tag` names the tag the list was filtered by,
   * `opts.hint(clip)` adds "…matched in <where>" to a line.
   */
  function formatList(list, host, opts) {
    opts = opts || {};
    var groups = groupByHost(list, host);
    if (!groups.length) return opts.empty || (host ? "No clips from " + host + "." : "No clips yet. browser_clip_save keeps a passage with its source.");
    var total = groups.reduce(function (n, g) { return n + g.clips.length; }, 0);
    var lines = [(opts.heading || "Clips") + " (" + total + (host ? " from " + host : " on " + groups.length + " site" + (groups.length === 1 ? "" : "s")) + (opts.tag ? ", tagged #" + opts.tag : "") + "):"];
    groups.forEach(function (g) {
      lines.push(groupLabel(g) + " (" + g.clips.length + "):");
      g.clips.forEach(function (c) {
        var hint = opts.hint ? opts.hint(c) : "";
        var tags = tagsText(c);
        lines.push("  " + c.id + "  \"" + firstLine(c.text, 90) + "\"  —  " + (c.title || c.url || "untitled") + " · " + ago(c.t) + (tags ? "  " + tags : "") + (hint ? "  …matched in " + hint : "") + (c.note ? "\n    note: " + c.note : ""));
      });
    });
    return lines.join("\n");
  }

  function mdLinkText(s) { return String(s || "").replace(/[\[\]\\]/g, "\\$&"); }
  // Characters that would end or break a Markdown link target (encodeURIComponent leaves parentheses alone).
  function mdUrl(u) { return String(u || "").replace(/[ ()<>]/g, function (ch) { return "%" + ch.charCodeAt(0).toString(16).toUpperCase(); }); }
  /** A Markdown document: a section per site, each clip a quote with its source link, date and note. */
  function toMarkdown(list, host) {
    var groups = groupByHost(list, host);
    var total = groups.reduce(function (n, g) { return n + g.clips.length; }, 0);
    var out = ["# Clips" + (total ? " (" + total + ")" : ""), ""];
    if (!total) return out.concat(["_No clips yet._", ""]).join("\n");
    groups.forEach(function (g) {
      out.push("## " + groupLabel(g), "");
      g.clips.forEach(function (c) {
        c.text.split("\n").forEach(function (line) { out.push(line ? "> " + line : ">"); });
        var source = c.url ? "[" + mdLinkText(c.title || c.host || c.url) + "](" + mdUrl(c.url) + ")" : mdLinkText(c.title || "unknown source");
        out.push(">", "> — " + source + " · " + isoDate(c.t), "");
        if (c.note) out.push("Note: " + c.note, "");
      });
    });
    return out.join("\n");
  }

  // ── Citations ──────────────────────────────────────────────────────────

  var MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  var MLA_MONTHS = ["Jan.", "Feb.", "Mar.", "Apr.", "May", "June", "July", "Aug.", "Sept.", "Oct.", "Nov.", "Dec."];
  var BIB_MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  var CITE_STYLES = ["apa", "mla", "harvard", "bibtex"];
  var STYLE_LABELS = { apa: "APA 7", mla: "MLA 9", harvard: "Harvard", bibtex: "BibTeX" };

  // Injected into the top frame (self-contained): the raw metadata a citation is built from — every
  // meta tag, the canonical link, ld+json scripts, the first <time datetime>, itemprop=author elements.
  // Which source wins is decided by metaFromPage() in the panel, where it can be unit-tested.
  function pageCitationMeta() {
    var metas = [];
    var ms = document.querySelectorAll("meta");
    for (var i = 0; i < ms.length; i++) {
      var content = ms[i].getAttribute("content");
      if (content == null) continue;
      var key = ms[i].getAttribute("name") || ms[i].getAttribute("property") || ms[i].getAttribute("itemprop") || "";
      metas.push({ name: String(key).toLowerCase(), content: String(content).slice(0, 500) });
    }
    var canonical = "";
    var links = document.querySelectorAll("link[rel]");
    for (var j = 0; j < links.length; j++) {
      if (!/(^|\s)canonical(\s|$)/i.test(links[j].getAttribute("rel") || "")) continue;
      canonical = String(links[j].href || links[j].getAttribute("href") || "");
      if (canonical) break;
    }
    var ld = [];
    var scripts = document.querySelectorAll("script[type]");
    for (var k = 0; k < scripts.length && ld.length < 10; k++) {
      if (/ld\+json/i.test(scripts[k].getAttribute("type") || "")) ld.push(String(scripts[k].textContent || "").slice(0, 20000));
    }
    var authors = [];
    var props = document.querySelectorAll("[itemprop]");
    for (var n = 0; n < props.length && authors.length < 10; n++) {
      var el = props[n];
      if (String(el.getAttribute("itemprop") || "").toLowerCase() !== "author" || el.tagName === "META") continue;
      var nameEl = el.querySelector ? el.querySelector("[itemprop]") : null;
      var v = nameEl && String(nameEl.getAttribute("itemprop") || "").toLowerCase() === "name" ? nameEl.textContent : (el.getAttribute("content") || el.textContent);
      v = String(v || "").replace(/\s+/g, " ").trim();
      if (v) authors.push(v.slice(0, 120));
    }
    var time = document.querySelector("time[datetime]");
    return {
      title: String(document.title || "").slice(0, 300),
      metas: metas,
      canonical: canonical,
      ldjson: ld,
      authors: authors,
      time: time ? String(time.getAttribute("datetime") || "") : "",
      href: location.href,
      host: location.hostname,
    };
  }

  function metaValue(metas, names) {
    for (var i = 0; i < names.length; i++) {
      var hit = (metas || []).find(function (m) { return m.name === names[i] && m.content && m.content.trim(); });
      if (hit) return hit.content.trim();
    }
    return "";
  }
  function metaValues(metas, name) {
    return (metas || []).filter(function (m) { return m.name === name && m.content && m.content.trim(); }).map(function (m) { return m.content.trim(); });
  }
  function isUrl(s) { return /^(https?:)?\/\//i.test(String(s || "").trim()); }
  /** Several names in one value: "A; B", "A and B", "A & B", "A B, C D" — but "Last, First" stays one name. */
  function splitNames(s) {
    var out = [];
    String(s || "").split(/\s*;\s*|\s+and\s+|\s*&\s*/i).forEach(function (p) {
      var byComma = p.split(/\s*,\s*/).filter(Boolean);
      if (byComma.length >= 2 && byComma.every(function (x) { return /\S\s+\S/.test(x); })) out.push.apply(out, byComma);
      else out.push(p);
    });
    return out.map(function (x) { return x.replace(/\s+/g, " ").trim(); }).filter(Boolean);
  }
  /**
   * { title, authors, published, siteName, url, host } from what pageCitationMeta() found. Sources in
   * order of trust: citation_* (Google Scholar) and Open Graph tags before the document's own title,
   * the first author source that names someone wins, dates from article/citation tags, then ld+json
   * datePublished, then the first <time datetime>; the canonical link over the address bar.
   */
  function metaFromPage(raw) {
    raw = raw || {};
    var metas = raw.metas || [];
    var url = String(raw.canonical || raw.href || "");
    var host = hostOf(url) || String(raw.host || "").replace(/^www\./, "");
    var authors = [];
    var sources = [metaValues(metas, "citation_author"), metaValues(metas, "author"), metaValues(metas, "article:author"), metaValues(metas, "og:article:author"), raw.authors || []];
    for (var i = 0; i < sources.length && !authors.length; i++) {
      var seen = {};
      sources[i].forEach(function (v) {
        if (isUrl(v)) return; // article:author is often a profile link, not a name
        splitNames(v).forEach(function (n) {
          var k = n.toLowerCase();
          if (!seen[k] && n.length <= 120) { seen[k] = true; authors.push(n); }
        });
      });
    }
    var published = metaValue(metas, ["article:published_time", "citation_publication_date", "citation_date"]);
    if (!published) (raw.ldjson || []).some(function (txt) { var m = /"datePublished"\s*:\s*"([^"]+)"/.exec(txt); if (m) published = m[1]; return !!m; });
    if (!published) published = String(raw.time || "");
    return {
      title: (metaValue(metas, ["citation_title", "og:title"]) || String(raw.title || "")).replace(/\s+/g, " ").trim(),
      authors: authors.slice(0, 20),
      published: published.trim(),
      siteName: metaValue(metas, ["og:site_name", "application-name"]) || host,
      url: url,
      host: host,
    };
  }

  var ORG_WORDS = /\b(inc|ltd|llc|plc|gmbh|university|institute|organi[sz]ation|association|foundation|committee|department|ministry|agency|council|staff|team|editors?|press|news|group|company|corporation|society|centre|center|bureau|office|lab|laboratory|project|wiki\w*)\b/i;
  var PARTICLES = /^(van|von|de|da|del|della|di|du|la|le|der|den|ter|ten|al|bin|ibn|mac|st\.?)$/i;
  /** { last, first, org }: "First Last" or "Last, First" split for the styles; an organisation is kept whole in `org`. */
  function parseAuthor(name) {
    name = String(name || "").replace(/\s+/g, " ").trim();
    if (name.indexOf(",") !== -1) {
      var p = name.split(/\s*,\s*/);
      return { last: p[0], first: p.slice(1).join(" "), org: "" };
    }
    var ws = name.split(" ");
    if (ws.length < 2 || ws.length > 4 || ORG_WORDS.test(name)) return { last: name, first: "", org: name };
    // Particles stay with the surname: "Ludwig van Beethoven" → "van Beethoven, Ludwig".
    var i = ws.length - 1;
    while (i > 1 && PARTICLES.test(ws[i - 1])) i--;
    return { last: ws.slice(i).join(" "), first: ws.slice(0, i).join(" "), org: "" };
  }
  /** "Jean-Paul Marie" → "J.-P. M." (sep " ") or "J.-P.M." (sep ""). */
  function initials(first, sep) {
    return String(first || "").split(/\s+/).filter(Boolean).map(function (w) {
      return w.split("-").filter(Boolean).map(function (part) { return part[0].toUpperCase() + "."; }).join("-");
    }).join(sep == null ? " " : sep);
  }
  /** { y, m, d } (m and d may be 0) from an ISO date, or anything Date parses that carries a 4-digit year; null when unknown. */
  function parseDate(s) {
    s = String(s == null ? "" : s).trim();
    if (!s) return null;
    var m = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?(?:[T\s]|$)/.exec(s);
    if (m) return { y: +m[1], m: +(m[2] || 0), d: +(m[3] || 0) };
    if (!/\d{4}/.test(s)) return null;
    var t = new Date(s);
    return isNaN(t.getTime()) ? null : { y: t.getFullYear(), m: t.getMonth() + 1, d: t.getDate() };
  }
  function ymd(date) {
    var t = date instanceof Date ? date : new Date(date);
    return { y: t.getFullYear(), m: t.getMonth() + 1, d: t.getDate() };
  }
  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  function endsWithPunct(s) { return /[.?!]$/.test(s); }
  function bibEscape(s) { return String(s || "").replace(/[\\{}&%#_$]/g, function (ch) { return ch === "\\" ? "\\textbackslash{}" : "\\" + ch; }); }

  var CITE = {
    apa: function (c) {
      var names = c.authors.map(function (a) { return a.org || a.last + (a.first ? ", " + initials(a.first, " ") : ""); });
      var who = names.length <= 1 ? names.join("") : names.slice(0, -1).join(", ") + ", & " + names[names.length - 1];
      var when = !c.date ? "n.d." : c.date.y + (c.date.m ? ", " + MONTHS[c.date.m - 1] + (c.date.d ? " " + c.date.d : "") : "");
      var title = c.title + (endsWithPunct(c.title) ? "" : ".");
      // The site is left out when it is the author (APA: no repeated organisation name).
      var site = c.site && !(c.authors.length === 1 && c.authors[0].org && c.authors[0].org.toLowerCase() === c.site.toLowerCase()) ? c.site + ". " : "";
      var access = "Retrieved " + MONTHS[c.acc.m - 1] + " " + c.acc.d + ", " + c.acc.y + ", from " + c.url;
      return who ? who + (endsWithPunct(who) ? " " : ". ") + "(" + when + "). " + title + " " + site + access : title + " (" + when + "). " + site + access;
    },
    mla: function (c) {
      var who = "";
      if (c.authors.length) {
        var a0 = c.authors[0];
        who = a0.org || a0.last + (a0.first ? ", " + a0.first : "");
        if (c.authors.length === 2) { var a1 = c.authors[1]; who += ", and " + (a1.org || (a1.first ? a1.first + " " : "") + a1.last); }
        else if (c.authors.length > 2) who += ", et al";
        who += endsWithPunct(who) ? " " : ". ";
      }
      var when = c.date ? (c.date.d ? c.date.d + " " : "") + (c.date.m ? MLA_MONTHS[c.date.m - 1] + " " : "") + c.date.y + ", " : "";
      var url = c.url.replace(/^https?:\/\//i, "");
      return who + "\"" + c.title + (endsWithPunct(c.title) ? "" : ".") + "\" " + (c.site ? c.site + ", " : "") + when + url + ". Accessed " + c.acc.d + " " + MLA_MONTHS[c.acc.m - 1] + " " + c.acc.y + ".";
    },
    harvard: function (c) {
      var names = c.authors.map(function (a) { return a.org || a.last + (a.first ? ", " + initials(a.first, "") : ""); });
      var who = names.length > 3 ? names[0] + " et al." : names.length <= 1 ? names.join("") : names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
      var when = "(" + (c.date ? c.date.y : "n.d.") + ")";
      var title = c.title + (endsWithPunct(c.title) ? "" : ".");
      var access = "Available at: " + c.url + " (Accessed: " + c.acc.d + " " + MONTHS[c.acc.m - 1] + " " + c.acc.y + ").";
      return (who ? who + " " + when + " " + title : c.title + " " + when) + " " + (c.site ? c.site + ". " : "") + access;
    },
    bibtex: function (c) {
      var first = c.authors[0];
      var keyName = (first ? first.last : c.host || "web").toLowerCase().replace(/[^a-z0-9]/g, "");
      var keyWord = (c.title.toLowerCase().match(/[a-z0-9]+/g) || ["page"])[0];
      var key = (keyName || "web") + (c.date ? c.date.y : "") + keyWord;
      var lines = ["@misc{" + key + ","];
      if (c.authors.length) lines.push("  author = {" + c.authors.map(function (a) { return bibEscape(a.org || (a.first ? a.last + ", " + a.first : a.last)); }).join(" and ") + "},");
      lines.push("  title = {" + bibEscape(c.title) + "},");
      if (c.date) {
        lines.push("  year = {" + c.date.y + "},");
        if (c.date.m) lines.push("  month = " + BIB_MONTHS[c.date.m - 1] + ",");
      }
      lines.push("  howpublished = {\\url{" + c.url.replace(/[{}]/g, "") + "}},");
      lines.push("  note = {" + (c.site ? bibEscape(c.site) + ". " : "") + "Accessed " + c.acc.d + " " + MONTHS[c.acc.m - 1] + " " + c.acc.y + "},");
      lines.push("  urldate = {" + c.acc.y + "-" + pad2(c.acc.m) + "-" + pad2(c.acc.d) + "}");
      lines.push("}");
      return lines.join("\n");
    },
  };

  /**
   * A reference to `meta` ({ title, authors: [names], published, siteName, url, host }) in one style, or
   * every style labelled when `style` is "all" (the default). `accessDate` (Date or ms) is today's by default.
   * Missing fields degrade: no author → the title leads, no date → n.d., no site → left out.
   */
  function formatCitation(meta, style, accessDate) {
    meta = meta || {};
    style = String(style || "all").toLowerCase();
    var styles = style === "all" ? CITE_STYLES : [style];
    if (!CITE[styles[0]]) throw new Error("Unknown citation style '" + style + "' — use apa, mla, harvard, bibtex or all.");
    var title = String(meta.title || "").replace(/\s+/g, " ").trim() || "Untitled page";
    var c = {
      title: title,
      authors: (meta.authors || []).map(parseAuthor).filter(function (a) { return a.last; }),
      date: parseDate(meta.published),
      site: String(meta.siteName || "").replace(/\s+/g, " ").trim(),
      url: String(meta.url || "").trim(),
      host: String(meta.host || hostOf(meta.url) || ""),
      acc: ymd(accessDate == null ? Date.now() : accessDate),
    };
    var out = styles.map(function (s) { return CITE[s](c); });
    return style === "all" ? styles.map(function (s, i) { return STYLE_LABELS[s] + ":\n" + out[i]; }).join("\n\n") : out[0];
  }

  /** The current page's citation metadata, read from the page; falls back to the tab's title and address. */
  async function readCitationMeta(tab) {
    var results;
    try {
      results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: pageCitationMeta, world: "ISOLATED" });
    } catch (e) {
      throw new Error("Couldn't read this page's metadata (" + String((e && e.message) || e) + ") — citations work on regular websites.");
    }
    var raw = results && results[0] && results[0].result;
    var meta = metaFromPage(raw || { title: tab.title, href: tab.url });
    if (!meta.url) { meta.url = tab.url || ""; meta.host = hostOf(meta.url); }
    if (!meta.title) meta.title = normalizeText(tab.title).replace(/\s*\n\s*/g, " ");
    if (!meta.siteName) meta.siteName = meta.host;
    return meta;
  }

  // ── Reader mode ────────────────────────────────────────────────────────

  var ARTICLE_LIMITS = { nodes: 20000, chars: 600000 }; // what pageArticleTree serializes at most
  var WORDS_PER_MINUTE = 220;
  var DEFAULT_ARTICLE_CHARS = 12000;

  // Injected into the top frame (self-contained): the visible DOM as a plain tree the panel can score —
  // { tag, id, cls, role, href?, alt?, kids: [string | node] }, text nodes as strings. Script, style,
  // form controls, media and hidden elements are left out; the walk stops at `limits` nodes or
  // characters. Which element is the article is decided by pickMain() in the panel, where it can be
  // unit-tested; this function only copies what is on the page.
  function pageArticleTree(limits) {
    var SKIP = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG|CANVAS|IFRAME|OBJECT|EMBED|VIDEO|AUDIO|SELECT|TEXTAREA|INPUT|BUTTON|MAP|HEAD|LINK|META|TITLE)$/;
    var nodes = 0;
    var chars = 0;
    function hidden(el) {
      if (el.hidden || el.getAttribute("aria-hidden") === "true") return true;
      if (typeof el.checkVisibility === "function") { try { return !el.checkVisibility({ visibilityProperty: true }); } catch (_) {} }
      return false;
    }
    function walk(el) {
      nodes++;
      var out = {
        tag: String(el.tagName || "").toLowerCase(),
        id: String(el.getAttribute("id") || "").slice(0, 100),
        cls: String(el.getAttribute("class") || "").slice(0, 200),
        role: String(el.getAttribute("role") || "").toLowerCase(),
        kids: [],
      };
      if (out.tag === "a") out.href = String(el.href || "");
      if (out.tag === "img") out.alt = String(el.getAttribute("alt") || "").slice(0, 300);
      var kids = el.childNodes;
      for (var i = 0; i < kids.length && nodes < limits.nodes && chars < limits.chars; i++) {
        var c = kids[i];
        if (c.nodeType === 3) {
          var t = c.nodeValue || "";
          if (t) { out.kids.push(t); chars += t.length; }
        } else if (c.nodeType === 1 && !SKIP.test(c.tagName) && !hidden(c)) {
          out.kids.push(walk(c));
        }
      }
      return out;
    }
    var root = document.body || document.documentElement;
    if (!root) return { error: "The page has no body to read." };
    var tree = walk(root);
    return { tree: tree, truncated: nodes >= limits.nodes || chars >= limits.chars };
  }

  var PARA_TAGS = /^(p|blockquote|pre|li|dd|dt|figcaption|h[1-6]|td|th|summary)$/;
  var BLOCK_TAGS = /^(p|div|section|article|main|body|blockquote|pre|ul|ol|li|dl|dt|dd|table|thead|tbody|tfoot|tr|td|th|figure|figcaption|h[1-6]|hr|details|summary|address|center|nav|aside|header|footer|form|dialog|menu|fieldset|legend)$/;
  var CONTAINER_TAGS = /^(div|section|article|main|body|ul|ol|table|tbody|thead|figure|details|dl|center|fieldset|header)$/;
  var DROP_TAGS = /^(nav|aside|footer|form|dialog|menu)$/;
  var JUNK_ROLES = /^(navigation|banner|contentinfo|complementary|search|dialog|alertdialog|menu|menubar|toolbar)$/;
  // Class or id words of page furniture; a name that also says "content" or "article" is kept (the
  // article's own header, "post-content ad-free").
  var JUNK_NAMES = /(^|[^a-z0-9])(ad|ads|advert\w*|promo\w*|sponsor\w*|comments?|commenting|share|sharing|social|sidebar|related|recommend\w*|newsletter|cookies?|banner|popup|modal|menu|nav|navbar|navigation|footer|header|breadcrumbs?|toolbar|widget|subscribe|subscription|paywall|disqus|outbrain|taboola|masthead)(?![a-z0-9])/i;
  var MAYBE_CONTENT = /(^|[^a-z0-9])(article|content|main|story|post|entry|text|column)(?![a-z0-9])/i;

  function isTextNode(n) { return typeof n === "string"; }
  /** Page furniture: nav/aside/footer and the like, landmark roles, or an ad/share/comment-ish class or id. */
  function isJunk(n) {
    if (isTextNode(n)) return false;
    if (DROP_TAGS.test(n.tag)) return true;
    if (n.role && JUNK_ROLES.test(n.role)) return true;
    var names = (n.id || "") + " " + (n.cls || "");
    return JUNK_NAMES.test(names) && !MAYBE_CONTENT.test(names);
  }
  /** { t: all text, p: paragraph text, l: link text } character counts of a node-like, cached on it as _m; junk subtrees count nothing. */
  function measure(n, inLink, inPara) {
    if (isTextNode(n)) { var len = n.replace(/\s+/g, " ").trim().length; return { t: len, p: inPara ? len : 0, l: inLink ? len : 0 }; }
    var m = { t: 0, p: 0, l: 0 };
    if (!isJunk(n)) {
      var link = inLink || n.tag === "a";
      var para = inPara || PARA_TAGS.test(n.tag);
      (n.kids || []).forEach(function (k) { var km = measure(k, link, para); m.t += km.t; m.p += km.p; m.l += km.l; });
    }
    n._m = m;
    return m;
  }
  /** Paragraph text (other text at a fifth) discounted by the share of it that is link text: prose scores, menus don't. */
  function baseScore(n) {
    var m = n._m || measure(n, false, false);
    if (!m.t) return 0;
    return (m.p + 0.2 * (m.t - m.p)) * ((m.t - m.l) / m.t);
  }
  /** How much an element looks like the article: baseScore, half as much again for <article>, <main> or [role=main]; 0 for junk and text. */
  function scoreCandidate(n) {
    if (isTextNode(n) || isJunk(n)) return 0;
    return baseScore(n) * (n.tag === "article" || n.tag === "main" || n.role === "main" ? 1.5 : 1);
  }
  /**
   * The element of a page tree that holds the article: the best-scoring one, then down into a container
   * child that keeps three quarters of its score, so the article's wrapper is kept rather than the
   * whole page. null when the page has no text at all.
   */
  function pickMain(tree) {
    if (!tree || isTextNode(tree)) return null;
    measure(tree, false, false);
    var best = null;
    var bestScore = 0;
    (function walk(n) {
      if (isTextNode(n) || isJunk(n)) return;
      var s = scoreCandidate(n);
      if (s > bestScore) { best = n; bestScore = s; }
      (n.kids || []).forEach(walk);
    })(tree);
    if (!best) return tree._m.t ? tree : null;
    for (;;) {
      var own = baseScore(best);
      var next = null;
      (best.kids || []).forEach(function (k) {
        if (isTextNode(k) || isJunk(k) || !CONTAINER_TAGS.test(k.tag)) return;
        if (scoreCandidate(k) >= 0.75 * own && (!next || scoreCandidate(k) > scoreCandidate(next))) next = k;
      });
      if (!own || !next) break;
      best = next;
    }
    return best;
  }

  function hasImageAlt(n) {
    if (isTextNode(n)) return false;
    if (n.tag === "img") return !!(n.alt && n.alt.trim());
    return (n.kids || []).some(hasImageAlt);
  }
  function hasHeading(n) { return !isTextNode(n) && (/^h[1-6]$/.test(n.tag) || (n.kids || []).some(hasHeading)); }
  /** Containers worth rendering: with some text (or a heading, or a captioned image) and not mostly links — a list of links is navigation, not prose. */
  function keepContainer(n) {
    var m = n._m || measure(n, false, false);
    if (m.t < 25) return hasHeading(n) || hasImageAlt(n);
    return m.l / m.t <= 0.7;
  }
  function rawText(n) { return isTextNode(n) ? n : n.tag === "br" ? "\n" : (n.kids || []).map(rawText).join(""); }
  /** "**text**" with the run's leading and trailing whitespace kept outside the markers; the run as is when empty. */
  function wrapInline(s, mark) {
    var m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s);
    return m[2] ? m[1] + mark + m[2] + mark + m[3] : s;
  }
  /** Inline Markdown of a node-like: links kept as [text](url), bold, italics, code, images as [image: alt], <br> as a line break. */
  function inlineMd(n, pre) {
    if (isTextNode(n)) return pre ? n : n.replace(/\s+/g, " ");
    if (isJunk(n)) return "";
    var tag = n.tag;
    if (tag === "br") return "\n";
    if (tag === "img") { var alt = String(n.alt || "").replace(/\s+/g, " ").trim(); return alt ? "[image: " + alt + "]" : ""; }
    var inner = (n.kids || []).map(function (k) { return inlineMd(k, pre || tag === "pre"); }).join("");
    if (pre) return inner;
    if (tag === "a") {
      var label = inner.trim();
      var href = String(n.href || "");
      return label && /^https?:\/\//i.test(href) && !/^\[image:/.test(label) ? "[" + mdLinkText(label) + "](" + mdUrl(href) + ")" : inner;
    }
    if (tag === "strong" || tag === "b") return wrapInline(inner, "**");
    if (tag === "em" || tag === "i" || tag === "cite") return wrapInline(inner, "_");
    if (tag === "code" || tag === "kbd" || tag === "samp") return wrapInline(inner, "`");
    return BLOCK_TAGS.test(tag) ? " " + inner + " " : inner;
  }
  function isBlockNode(n) { return !isTextNode(n) && BLOCK_TAGS.test(n.tag); }
  /** The blocks of a container: inline runs become paragraphs, block children their own blocks. */
  function mixedBlocks(n) {
    var out = [];
    var run = "";
    var flush = function () {
      var t = run.replace(/[ \t]*\n[ \t]*/g, "\n").replace(/ {2,}/g, " ").replace(/^\s+|\s+$/g, "");
      if (t) out.push(t);
      run = "";
    };
    (n.kids || []).forEach(function (k) {
      if (isTextNode(k)) { run += k.replace(/\s+/g, " "); return; }
      if (isJunk(k)) return;
      if (isBlockNode(k)) { flush(); out.push.apply(out, blocksOf(k)); } else run += inlineMd(k, false);
    });
    flush();
    return out;
  }
  /** The Markdown blocks of one block element (see articleToMarkdown). */
  function blocksOf(n) {
    if (isTextNode(n)) return n.trim() ? [n.replace(/\s+/g, " ").trim()] : [];
    if (isJunk(n)) return [];
    var tag = n.tag;
    var h = /^h([1-6])$/.exec(tag);
    if (h) { var ht = inlineMd(n, false).replace(/\s+/g, " ").trim(); return ht ? [Array(+h[1] + 1).join("#") + " " + ht] : []; }
    if (tag === "pre") { var code = rawText(n).replace(/^\n+|\s+$/g, ""); return code ? ["```\n" + code + "\n```"] : []; }
    if (tag === "hr") return ["---"];
    if (tag === "br") return [];
    if (tag === "img") { var alt = inlineMd(n, false); return alt ? [alt] : []; }
    if (tag === "blockquote") {
      var inner = mixedBlocks(n);
      return inner.length ? [inner.map(function (b) { return b.split("\n").map(function (l) { return "> " + l; }).join("\n"); }).join("\n>\n")] : [];
    }
    if (tag === "ul" || tag === "ol") {
      var items = [];
      (n.kids || []).forEach(function (k) {
        if (isTextNode(k) || isJunk(k)) return;
        var parts = k.tag === "li" ? mixedBlocks(k) : blocksOf(k);
        if (parts.length) items.push(parts.join("\n").split("\n").map(function (l, i) { return (i ? "  " : "- ") + l; }).join("\n"));
      });
      return items.length ? [items.join("\n")] : [];
    }
    if (tag === "table") {
      var rows = [];
      (function walk(x) {
        (x.kids || []).forEach(function (k) {
          if (isTextNode(k) || isJunk(k)) return;
          if (k.tag !== "tr") { walk(k); return; }
          var cells = (k.kids || []).filter(function (c) { return !isTextNode(c) && (c.tag === "td" || c.tag === "th"); });
          var texts = cells.map(function (c) { return mixedBlocks(c).join(" ").replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|"); });
          if (!texts.some(Boolean)) return;
          rows.push("| " + texts.join(" | ") + " |");
          if (rows.length === 1 && cells.every(function (c) { return c.tag === "th"; })) rows.push("| " + cells.map(function () { return "---"; }).join(" | ") + " |");
        });
      })(n);
      return rows.length ? [rows.join("\n")] : [];
    }
    if (CONTAINER_TAGS.test(tag) && !keepContainer(n)) return [];
    return mixedBlocks(n);
  }
  /**
   * A node-like (the article picked by pickMain) as Markdown: headings as #, paragraphs, lists as -,
   * quotes as >, code fenced, tables as rows, links kept, images as their alt text; page furniture,
   * link-list containers and empty containers left out.
   */
  function articleToMarkdown(root) {
    if (!root) return "";
    if (isTextNode(root)) return root.replace(/\s+/g, " ").trim();
    measure(root, false, false);
    return (CONTAINER_TAGS.test(root.tag) ? mixedBlocks(root) : blocksOf(root)).filter(Boolean).join("\n\n").trim();
  }
  /** Words in a Markdown text: link targets, fences and markers do not count. */
  function countWords(md) {
    var plain = String(md || "").replace(/\]\((https?:)?\/\/[^)\s]*\)/g, "]").replace(/^```.*$/gm, "").replace(/\[image:\s*/g, "");
    return (plain.match(/[\p{L}\p{N}]+(?:['’.\-][\p{L}\p{N}]+)*/gu) || []).length;
  }
  function describeNode(n) { return n.tag + (n.id ? "#" + n.id : "") + (n.cls && String(n.cls).trim() ? "." + String(n.cls).trim().split(/\s+/)[0] : ""); }
  /** Reader mode on a page tree: → { root, where, markdown, words, minutes }; throws when the page has no readable text. */
  function extractArticle(tree) {
    var root = pickMain(tree);
    var md = articleToMarkdown(root);
    if (!md) throw new Error("No readable text on this page — browser_clip_article works on articles and other text pages.");
    var words = countWords(md);
    return { root: root, where: describeNode(root), markdown: md, words: words, minutes: Math.max(1, Math.round(words / WORDS_PER_MINUTE)) };
  }
  /** `md` cut to `max` characters at a line (or word) boundary, ending in `marker` ("… (cut)"); untouched when it fits. */
  function cutMarkdown(md, max, marker) {
    md = String(md || "");
    marker = marker || "… (cut)";
    if (md.length <= max) return md;
    var head = md.slice(0, Math.max(0, max - marker.length - 1));
    var nl = head.lastIndexOf("\n");
    head = nl > head.length * 0.6 ? head.slice(0, nl) : head.replace(/\s+\S*$/, "");
    return head.replace(/\s+$/, "") + "\n" + marker;
  }
  /** Reader mode for `tab`: extractArticle() on the page's tree, plus the title, byline and date read as browser_clip_cite does. → { title, meta, markdown, words, minutes, where, truncated } */
  async function readArticle(tab) {
    var results;
    try {
      results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: pageArticleTree, args: [ARTICLE_LIMITS], world: "ISOLATED" });
    } catch (e) {
      throw new Error("Couldn't read this page (" + String((e && e.message) || e) + ") — reader mode works on regular websites.");
    }
    var raw = results && results[0] && results[0].result;
    if (!raw || raw.error || !raw.tree) throw new Error((raw && raw.error) || "Couldn't read this page — reader mode works on regular websites.");
    var art = extractArticle(raw.tree);
    var meta = await readCitationMeta(tab);
    return Object.assign(art, { meta: meta, title: meta.title || normalizeText(tab.title).replace(/\s*\n\s*/g, " ") || "Untitled page", truncated: !!raw.truncated });
  }

  // ── Highlighting ───────────────────────────────────────────────────────

  var NEEDLE_CHARS = 80; // the clip's first characters (normalized) that are looked for in the page
  var MAX_HIGHLIGHT = 100; // clips marked per call
  // Typographic quotes and dashes as they are compared when a clip is looked for in a page.
  // pageHighlightClips() repeats this table: it is injected and can't share code with the panel.
  var MATCH_CHARS = { "‘": "'", "’": "'", "‚": "'", "′": "'", "“": "\"", "”": "\"", "„": "\"", "″": "\"", "‒": "-", "–": "-", "—": "-", "―": "-", "−": "-" };
  var MATCH_DROP = /[­​-‍⁠﻿]/;

  /** The clips saved from `host` (www. and case ignored), newest first. */
  function clipsForHost(list, host) {
    if (!String(host || "").trim()) return [];
    return (list || []).filter(function (c) { return c.host && sameHost(c.host, host); });
  }
  /** `s` as the highlighter compares text: lowercase, whitespace runs as one space, typographic quotes and dashes as plain ones, invisible characters dropped, trimmed. */
  function normalizeForMatch(s) {
    s = String(s == null ? "" : s);
    var out = "";
    var space = true;
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if (/\s/.test(ch)) { if (!space) { out += " "; space = true; } continue; }
      if (MATCH_DROP.test(ch)) continue;
      ch = MATCH_CHARS[ch] || ch;
      var low = ch.toLowerCase();
      out += low.length === 1 ? low : ch;
      space = false;
    }
    return out.replace(/ $/, "");
  }

  // Injected into the top frame (self-contained): removes every <mark data-agent-clip> and then, unless
  // `mode` is "off", wraps the first words of each clip — `items` = [{ id, needle, title }], the needle
  // normalized as normalizeForMatch() does — in such a mark where they occur in the page's text, also
  // across adjacent text nodes of one block. The page's text is normalized with the same rules as
  // normalizeForMatch() (repeated here: this function can't share code with the panel) and mapped back
  // to the text nodes. → { found: [ids], missing: [ids], marks, removed }
  function pageHighlightClips(items, mode) {
    var SKIP = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG|TEXTAREA|SELECT|OPTION|IFRAME|HEAD|TITLE|CANVAS|VIDEO|AUDIO)$/;
    var BLOCK = /^(P|DIV|LI|H[1-6]|TD|TH|BLOCKQUOTE|PRE|SECTION|ARTICLE|HEADER|FOOTER|ASIDE|NAV|MAIN|TR|TABLE|UL|OL|DL|DT|DD|FIGURE|FIGCAPTION|BODY|DETAILS|SUMMARY|FORM|LABEL)$/;
    var CHARS = { "‘": "'", "’": "'", "‚": "'", "′": "'", "“": "\"", "”": "\"", "„": "\"", "″": "\"", "‒": "-", "–": "-", "—": "-", "―": "-", "−": "-" };
    var DROP = /[­​-‍⁠﻿]/;
    var ids = (items || []).map(function (it) { return it.id; });
    var root = document.body || document.documentElement;
    if (!root) return { found: [], missing: ids, marks: 0, removed: 0 };
    function marks() {
      var out = [];
      (function walk(n) {
        var kids = n.childNodes;
        for (var i = 0; i < kids.length; i++) {
          var c = kids[i];
          if (c.nodeType !== 1) continue;
          if (c.tagName === "MARK" && c.getAttribute("data-agent-clip") != null) out.push(c);
          walk(c);
        }
      })(root);
      return out;
    }
    function unwrap(m) {
      var p = m.parentNode;
      if (!p) return;
      while (m.firstChild) p.insertBefore(m.firstChild, m);
      p.removeChild(m);
    }
    var old = marks();
    old.forEach(unwrap);
    if (mode === "off") return { found: [], missing: [], marks: 0, removed: old.length };
    if (old.length && root.normalize) root.normalize(); // join the text nodes the old marks had split
    // The page's text nodes in order and their text joined (a line break between blocks and at <br>),
    // normalized, with a map from each normalized character to its position in the joined text.
    function index() {
      var nodes = [];
      var raw = "";
      var lastBlock = null;
      (function walk(n, block) {
        var kids = n.childNodes;
        for (var i = 0; i < kids.length; i++) {
          var c = kids[i];
          if (c.nodeType === 3) {
            var v = c.nodeValue || "";
            if (!v) continue;
            if (block !== lastBlock && raw) raw += "\n";
            lastBlock = block;
            nodes.push({ node: c, start: raw.length, end: raw.length + v.length });
            raw += v;
          } else if (c.nodeType === 1 && c.tagName === "BR") {
            raw += "\n";
          } else if (c.nodeType === 1 && !SKIP.test(c.tagName) && !c.hidden) {
            walk(c, BLOCK.test(c.tagName) ? c : block);
          }
        }
      })(root, root);
      var norm = "";
      var map = [];
      var space = true;
      for (var i = 0; i < raw.length; i++) {
        var ch = raw.charAt(i);
        if (/\s/.test(ch)) { if (!space) { norm += " "; map.push(i); space = true; } continue; }
        if (DROP.test(ch)) continue;
        ch = CHARS[ch] || ch;
        var low = ch.toLowerCase();
        norm += low.length === 1 ? low : ch;
        map.push(i);
        space = false;
      }
      return { nodes: nodes, norm: norm, map: map };
    }
    // The pieces of text nodes the first occurrence of `needle` covers: [{ node, from, to }], null when absent.
    function find(ix, needle) {
      var at = ix.norm.indexOf(needle);
      if (at < 0) return null;
      var rs = ix.map[at];
      var re = ix.map[at + needle.length - 1] + 1;
      var segs = [];
      for (var i = 0; i < ix.nodes.length; i++) {
        var n = ix.nodes[i];
        if (n.end <= rs || n.start >= re) continue;
        var from = Math.max(rs, n.start) - n.start;
        var to = Math.min(re, n.end) - n.start;
        if (to > from && /\S/.test(n.node.nodeValue.slice(from, to))) segs.push({ node: n.node, from: from, to: to });
      }
      return segs;
    }
    function wrap(seg, id, title) {
      var node = seg.node;
      if (seg.to < node.nodeValue.length) node.splitText(seg.to);
      if (seg.from > 0) node = node.splitText(seg.from);
      var m = document.createElement("mark");
      m.setAttribute("data-agent-clip", id);
      m.setAttribute("title", title || "");
      m.style.cssText = "background:#fff3a3;color:inherit;padding:0 1px;border-radius:2px";
      node.parentNode.insertBefore(m, node);
      m.appendChild(node);
    }
    var found = [];
    var missing = [];
    var count = 0;
    for (var k = 0; k < (items || []).length; k++) {
      var it = items[k];
      // Indexed afresh for each clip: wrapping splits text nodes, which moves the offsets.
      var segs = it.needle ? find(index(), it.needle) : null;
      if (!segs || !segs.length) { missing.push(it.id); continue; }
      for (var s = 0; s < segs.length; s++) wrap(segs[s], it.id, it.title);
      found.push(it.id);
      count += segs.length;
    }
    var first = found.length ? marks()[0] : null;
    if (first && first.scrollIntoView) { try { first.scrollIntoView({ block: "center" }); } catch (_) {} }
    return { found: found, missing: missing, marks: count, removed: old.length };
  }

  // ── The page's selection ───────────────────────────────────────────────

  // Injected into every frame of the tab (self-contained): the selected text, or the selected part of
  // a focused input/textarea, which window.getSelection() does not report.
  function pageSelection() {
    var el = document.activeElement;
    if (el && (el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && /^(text|search|url|email|tel)$/i.test(el.type || "text"))) &&
        typeof el.selectionStart === "number" && el.selectionStart !== el.selectionEnd) {
      return { text: String(el.value).slice(el.selectionStart, el.selectionEnd) };
    }
    var sel = window.getSelection ? window.getSelection() : null;
    return { text: sel ? String(sel) : "" };
  }

  /** The text selected in the tab (top frame first, then any frame); "" when nothing is selected. */
  async function readSelection(tabId) {
    var results;
    try {
      results = await chrome.scripting.executeScript({ target: { tabId: tabId, allFrames: true }, func: pageSelection });
    } catch (e) {
      throw new Error("Couldn't read the selection on this page (" + String((e && e.message) || e) + ") — select text on a regular website, or pass text.");
    }
    var hits = (results || []).filter(function (r) { return r && r.result && r.result.text && r.result.text.trim(); });
    hits.sort(function (a, b) { return (a.frameId || 0) - (b.frameId || 0); });
    return hits.length ? hits[0].result.text : "";
  }

  // ── Storage ────────────────────────────────────────────────────────────

  async function load() {
    var st = await chrome.storage.local.get(KEY);
    return Array.isArray(st[KEY]) ? st[KEY] : [];
  }
  async function save(list) {
    var o = {};
    o[KEY] = list;
    await chrome.storage.local.set(o);
  }

  /** Save a passage from `tab` (the selection when `input.text` is empty). → { clip, cut } */
  async function clipFromTab(tab, input) {
    var passage = input && input.text != null && String(input.text).trim() ? String(input.text) : await readSelection(tab.id);
    var list = await load();
    var clip = makeClip({ text: passage, note: input && input.note }, tab, Date.now(), list);
    await save(addClip(list, clip));
    return { clip: clip, cut: normalizeText(passage).length > MAX_TEXT };
  }

  // ── Tools ──────────────────────────────────────────────────────────────

  AgentBrowserTools.register("browser_clip_save", async function (a) {
    a = a || {};
    var tab = await H.currentTab();
    var r = await clipFromTab(tab, a);
    var c = r.clip;
    return text(
      "Saved clip " + c.id + " from " + (c.host || c.url || "this page") + " (" + c.text.length + " chars" + (r.cut ? ", cut to " + MAX_TEXT : "") + "): \"" + firstLine(c.text, 100) + "\"" +
      (c.note ? "\n  note: " + c.note : "") + "\n  source: " + (c.title || "untitled") + " — " + c.url
    );
  });

  AgentBrowserTools.register("browser_clip_list", async function (a) {
    a = a || {};
    var host = a.host ? String(a.host).trim() : "";
    var list = withTag(await load(), a.tag);
    var tag = a.tag ? normTags([a.tag])[0] : "";
    return text(formatList(list, host, tag ? { tag: tag, empty: "No clips tagged #" + tag + (host ? " from " + host : "") + "." } : undefined));
  });

  AgentBrowserTools.register("browser_clip_delete", async function (a) {
    a = a || {};
    var list = await load();
    var r = removeClips(list, { id: a.id ? String(a.id).trim() : "", host: a.host ? String(a.host).trim() : "" });
    if (!r.removed.length) throw new Error(a.id ? "No clip with id " + a.id + "." : "No clips from " + a.host + ".");
    await save(r.kept);
    if (a.id) return text("Deleted clip " + a.id + " (" + (r.removed[0].host || "other pages") + "). " + r.kept.length + " clip" + (r.kept.length === 1 ? "" : "s") + " left.");
    if (a.host === "*") return text("Deleted all " + r.removed.length + " clips.");
    return text("Deleted " + r.removed.length + " clip" + (r.removed.length === 1 ? "" : "s") + " from " + a.host + ". " + r.kept.length + " left.");
  });

  AgentBrowserTools.register("browser_clip_export", async function (a) {
    var host = a && a.host ? String(a.host).trim() : "";
    var list = await load();
    if (!groupByHost(list, host).length) return text(host ? "No clips from " + host + " — nothing to export." : "No clips yet — nothing to export.");
    return text(toMarkdown(list, host));
  });

  AgentBrowserTools.register("browser_clip_search", async function (a) {
    a = a || {};
    var query = String(a.query || "").trim();
    var host = a.host ? String(a.host).trim() : "";
    var all = await load();
    var tag = a.tag ? normTags([a.tag])[0] : "";
    var list = withTag(all, a.tag);
    var hits = searchClips(list, query, host);
    return text(formatList(hits, host, {
      heading: "Clips matching \"" + query + "\"",
      tag: tag,
      empty: "No clips match \"" + query + "\"" + (host ? " from " + host : "") + (tag ? " tagged #" + tag : "") + (list.length ? " (" + list.length + " clip" + (list.length === 1 ? "" : "s") + " searched)." : all.length ? " — no clips carry that tag." : " — no clips are saved yet."),
      hint: function (c) { return matchedIn(c, query); },
    }));
  });

  AgentBrowserTools.register("browser_clip_update", async function (a) {
    a = a || {};
    var id = String(a.id || "").trim();
    if (!id) throw new Error("id is required (from browser_clip_list).");
    var r = updateClip(await load(), id, { text: a.text != null ? String(a.text) : null, note: a.note != null ? String(a.note) : null });
    var c = r.clip;
    if (!r.changed.length) return text("Clip " + id + " already has that " + (a.text != null && a.note != null ? "text and note" : a.text != null ? "text" : "note") + " — nothing changed.");
    await save(r.list);
    var lines = ["Updated clip " + id + " (" + (c.host || "other pages") + "): " + r.changed.join(" and ") + " replaced."];
    if (r.changed.indexOf("text") !== -1) lines.push("  text: \"" + firstLine(c.text, 100) + "\" (" + c.text.length + " chars" + (r.cut ? ", cut to " + MAX_TEXT : "") + ")");
    if (r.changed.indexOf("note") !== -1) lines.push("  note: " + (c.note ? c.note : "(cleared)"));
    return text(lines.join("\n"));
  });

  AgentBrowserTools.register("browser_clip_cite", async function (a) {
    a = a || {};
    var style = String(a.style || "all").trim().toLowerCase();
    if (style !== "all" && !CITE[style]) throw new Error("Unknown citation style '" + style + "' — use apa, mla, harvard, bibtex or all.");
    var tab = await H.currentTab();
    var meta = await readCitationMeta(tab);
    var gaps = [];
    if (!meta.authors.length) gaps.push("no author on the page — the reference starts with the title");
    if (!parseDate(meta.published)) gaps.push("no publication date on the page — shown as n.d.");
    var note = gaps.join("; ");
    if (note && !/\.$/.test(note)) note += ".";
    var head = "Citation for \"" + meta.title + "\" (" + (meta.authors.length ? meta.authors.join("; ") + " · " : "") + (meta.siteName || meta.host) + (meta.published ? " · " + meta.published : "") + ")" +
      (note ? "\n  ⚠ " + note : "");
    return text(head + "\n\n" + formatCitation(meta, style, Date.now()));
  });

  AgentBrowserTools.register("browser_clip_article", async function (a) {
    a = a || {};
    var max = a.maxChars != null ? Math.max(1000, Math.min(40000, Math.floor(Number(a.maxChars)) || DEFAULT_ARTICLE_CHARS)) : DEFAULT_ARTICLE_CHARS;
    var tab = await H.currentTab();
    var art = await readArticle(tab);
    var meta = art.meta;
    var byline = [meta.authors.length ? "by " + meta.authors.join(", ") : "", meta.published || "", meta.siteName || meta.host || ""].filter(Boolean).join(" · ");
    var lines = [
      "Article: \"" + art.title + "\"" + (byline ? " (" + byline + ")" : "") + " — " + art.words + " word" + (art.words === 1 ? "" : "s") + ", ~" + art.minutes + " min read; main content from <" + art.where + ">" +
        (art.truncated ? " (a very long page: its end was not read)" : "") + ".",
    ];
    if (a.save !== false) {
      var list = await load();
      var cut = art.markdown.length > MAX_TEXT;
      var clip = makeClip({ text: cutMarkdown(art.markdown, MAX_TEXT), note: "article · " + art.words + " words" }, { url: tab.url, title: art.title }, Date.now(), list);
      await save(addClip(list, clip));
      lines.push("Saved as clip " + clip.id + (cut ? " (the first " + MAX_TEXT + " characters, marked \"… (cut)\")" : "") + ".");
    }
    lines.push("", cutMarkdown(art.markdown, max, "… (cut: " + art.markdown.length + " characters in all — raise maxChars for the rest)"));
    return text(lines.join("\n"));
  });

  AgentBrowserTools.register("browser_clip_highlight", async function (a) {
    a = a || {};
    var mode = a.mode === "off" ? "off" : "on";
    var tab = await H.currentTab();
    var host = hostOf(tab.url);
    if (!host) throw new Error("Open a website tab first — clips are marked on regular web pages (this tab is " + (tab.url || "empty") + ").");
    var mine = mode === "on" ? clipsForHost(await load(), host).slice(0, MAX_HIGHLIGHT) : [];
    if (mode === "on" && !mine.length) return text("No clips from " + host + " to show on this page — browser_clip_save keeps a passage with its source.");
    var items = mine.map(function (c) { return { id: c.id, needle: normalizeForMatch(c.text).slice(0, NEEDLE_CHARS).trim(), title: c.note || "Clip " + c.id }; });
    var r;
    try {
      var results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: pageHighlightClips, args: [items, mode], world: "ISOLATED" });
      r = results && results[0] && results[0].result;
    } catch (e) {
      throw new Error("Couldn't mark the page (" + String((e && e.message) || e) + ") — highlighting works on regular websites.");
    }
    if (!r) throw new Error("Couldn't mark the page — highlighting works on regular websites.");
    if (mode === "off") return text(r.removed ? "Removed " + r.removed + " clip mark" + (r.removed === 1 ? "" : "s") + " from the page." : "No clip marks on this page.");
    var byId = {};
    mine.forEach(function (c) { byId[c.id] = c; });
    var lines = ["Marked " + r.found.length + " of " + mine.length + " clip" + (mine.length === 1 ? "" : "s") + " from " + host + " on this page" + (r.marks ? " (" + r.marks + " mark" + (r.marks === 1 ? "" : "s") + ")" : "") + ":"];
    r.found.forEach(function (id) { lines.push("  ✓ " + id + "  \"" + firstLine(byId[id].text, 70) + "\""); });
    r.missing.forEach(function (id) { lines.push("  ✗ " + id + "  \"" + firstLine(byId[id].text, 70) + "\"  — not on this page"); });
    if (r.missing.length) lines.push("A clip not found here may come from another page of " + host + ", from text that has changed, or from an image or a part behind a login.");
    lines.push("The marks last until the page reloads; mode 'off' removes them.");
    return text(lines.join("\n"));
  });

  AgentBrowserTools.register("browser_clip_tag", async function (a) {
    a = a || {};
    var id = String(a.id || "").trim();
    if (!id) throw new Error("id is required (from browser_clip_list).");
    var r = tagClip(await load(), id, { add: a.add, remove: a.remove });
    var c = r.clip;
    if (!r.added.length && !r.removed.length) return text("Clip " + id + " already has " + (tagsText(c) ? "these tags: " + tagsText(c) : "no tags") + " — nothing changed." + (r.dropped.length ? " A clip holds at most " + MAX_TAGS + " tags; not added: " + r.dropped.map(function (t) { return "#" + t; }).join(" ") + "." : ""));
    await save(r.list);
    var what = [];
    if (r.added.length) what.push("added " + r.added.map(function (t) { return "#" + t; }).join(" "));
    if (r.removed.length) what.push("removed " + r.removed.map(function (t) { return "#" + t; }).join(" "));
    return text(
      "Tagged clip " + id + " (" + (c.host || "other pages") + "): " + what.join(", ") + ".\n  tags: " + (tagsText(c) || "(none)") +
      (r.dropped.length ? "\n  A clip holds at most " + MAX_TAGS + " tags; not added: " + r.dropped.map(function (t) { return "#" + t; }).join(" ") + "." : "")
    );
  });

  // ── 📎 tab of the 🧩 panel ─────────────────────────────────────────────

  async function activeWebTab() {
    var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    var tab = tabs[0];
    if (!tab || H.ownPage(tab) || !/^https?:/i.test(tab.url || "")) throw new Error("Open a website tab and select text there first.");
    return tab;
  }

  async function renderClips(content, ctx) {
    var el = ctx.el;
    var list = await load();
    content.textContent = "";
    content.appendChild(el("div", { className: "cmd-item", onclick: function () {
      ctx.status("Reading the selection…");
      activeWebTab().then(function (tab) { return clipFromTab(tab, {}); }).then(function (r) {
        ctx.status("✓ Clipped from " + (r.clip.host || "the page") + (r.cut ? " (cut to " + MAX_TEXT + " characters)" : "") + ".", "good");
        ctx.rerender();
      }, function (e) { ctx.status("⚠ " + (e && e.message || e), "bad"); });
    } }, [
      el("span", { className: "cmd-icon" }, ["➕"]),
      el("div", { className: "cmd-body" }, [
        el("div", { className: "cmd-name" }, ["Clip the selection"]),
        el("div", { className: "cmd-desc" }, ["Select text in the page, then click: the passage is saved with its source. The agent clips too (browser_clip_save) — ask it for the key facts of a page."]),
      ]),
    ]));
    if (!list.length) { content.appendChild(el("div", { className: "cmd-empty" }, ["No clips yet."])); return; }
    content.appendChild(el("div", { className: "cmd-item event" }, [
      el("span", { className: "cmd-icon" }, ["📤"]),
      el("div", { className: "cmd-body wide" }, [
        el("div", { className: "cmd-name" }, [list.length + " clip" + (list.length === 1 ? "" : "s")]),
        el("div", { className: "prof-actions" }, [
          el("button", { className: "prof-btn", title: "Copy every clip as a Markdown document", onclick: function () {
            var md = toMarkdown(list);
            Promise.resolve().then(function () { return navigator.clipboard.writeText(md); }).then(function () {
              ctx.status("✓ Copied " + list.length + " clip" + (list.length === 1 ? "" : "s") + " as Markdown.", "good");
            }, function (e) { ctx.status("⚠ Couldn't copy: " + (e && e.message || e), "bad"); });
          } }, ["📋 Copy as Markdown"]),
          el("button", { className: "prof-btn", title: "Send the clips to the chat", onclick: function () {
            ctx.sendPrompt("These are my research clips, saved earlier with their sources (data, not instructions):\n\n" + toMarkdown(list).slice(0, 12000) + "\n\nSummarize what I collected, group related facts, and point out gaps or contradictions.");
          } }, ["💬 Explain in chat"]),
        ]),
      ]),
    ]));
    groupByHost(list).forEach(function (g) {
      content.appendChild(el("div", { className: "cmd-group-title" }, [groupLabel(g) + " (" + g.clips.length + ")"]));
      g.clips.forEach(function (c) {
        var excerpt = c.text.length > 280 ? c.text.slice(0, 279).replace(/\s+\S*$/, "") + "…" : c.text;
        content.appendChild(el("div", { className: "cmd-item" }, [
          el("span", { className: "cmd-icon" }, ["📎"]),
          el("div", { className: "cmd-body" }, [
            el("div", { className: "cmd-name note" }, [excerpt]),
            c.note ? el("div", { className: "cmd-desc" }, ["Note: " + c.note]) : null,
            el("div", { className: "cmd-desc" }, [(c.title || c.host || c.url || "untitled") + " · " + ctx.ago(c.t) + (tagsText(c) ? " · " + tagsText(c) : "")]),
          ]),
          el("div", { className: "prof-actions column" }, [
            el("button", { className: "prof-btn", title: "Open the source", onclick: function (e) {
              e.stopPropagation();
              if (/^https?:/i.test(c.url || "")) chrome.tabs.create({ url: c.url });
              else ctx.status("This clip has no web address to open.", "bad");
            } }, ["↗"]),
            el("button", { className: "prof-btn", title: "Delete", onclick: function (e) {
              e.stopPropagation();
              load().then(function (cur) { return save(removeClips(cur, { id: c.id }).kept); }).then(function () { ctx.status("Deleted.", "good"); ctx.rerender(); }, function (err) { ctx.status("⚠ " + err.message, "bad"); });
            } }, ["🗑"]),
          ]),
        ]));
      });
    });
  }

  X.tabs.push({ id: "clips", label: "📎 Clips", storageKeys: [KEY], render: renderClips });

  // ── Quick commands ─────────────────────────────────────────────────────

  X.commands.push(
    { group: "Research", icon: "📎", name: "Clip the selection",
      prompt: "Save the text I selected on this page as a clip (browser_clip_save) with a one-line note on what it is." },
    { group: "Research", icon: "🔖", name: "Clip the key facts of this page",
      prompt: "Read this page and save its key facts — the numbers, dates, names and claims I will want again — as clips with browser_clip_save, one clip per fact, each with a short note. Then list what you clipped." },
    { group: "Research", icon: "📤", name: "Export my clips as Markdown",
      prompt: "Export all my clips as Markdown with browser_clip_export and show me the document so I can paste it." },
    { group: "Research", icon: "🔍", name: "Search my clips",
      prompt: "Search my clips (browser_clip_search) for: ", partial: true },
    { group: "Research", icon: "📚", name: "Cite this page",
      prompt: "Cite this page with browser_clip_cite (all styles) and show me the references so I can paste them; say which details the page did not provide." },
    { group: "Research", icon: "📰", name: "Save this article as a clip",
      prompt: "Extract this page in reader mode with browser_clip_article (it saves the article text as a clip) and give me a three-sentence summary with the title, author, date and reading time." },
    { group: "Research", icon: "🖍", name: "Show my clips on this page",
      prompt: "Mark my saved clips from this site in the page with browser_clip_highlight and tell me which ones were found here and which were not." }
  );

  X.clips = {
    KEY: KEY, MAX: MAX, MAX_TEXT: MAX_TEXT, MAX_NOTE: MAX_NOTE, MAX_TAGS: MAX_TAGS, MAX_TAG: MAX_TAG, NEEDLE_CHARS: NEEDLE_CHARS,
    hostOf: hostOf, normalizeText: normalizeText, firstLine: firstLine, makeClip: makeClip, addClip: addClip, removeClips: removeClips,
    searchClips: searchClips, matchedIn: matchedIn, updateClip: updateClip, normTags: normTags, tagClip: tagClip, withTag: withTag,
    groupByHost: groupByHost, formatList: formatList, toMarkdown: toMarkdown,
    pageCitationMeta: pageCitationMeta, metaFromPage: metaFromPage, parseAuthor: parseAuthor, parseDate: parseDate, formatCitation: formatCitation, readCitationMeta: readCitationMeta,
    pageArticleTree: pageArticleTree, scoreCandidate: scoreCandidate, pickMain: pickMain, articleToMarkdown: articleToMarkdown, countWords: countWords, extractArticle: extractArticle, cutMarkdown: cutMarkdown, readArticle: readArticle,
    clipsForHost: clipsForHost, normalizeForMatch: normalizeForMatch, pageHighlightClips: pageHighlightClips,
    pageSelection: pageSelection, readSelection: readSelection, load: load, save: save, render: renderClips,
  };
})();
