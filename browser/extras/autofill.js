// Extra feature "autofill" (side panel): identities — named sets of the user's details (name, email,
// phone, address, company…) that fill a page's form fields. Built into extras.js only for brands that
// switch the feature on; the tools are declared in browser/host/extras/autofill.ts. Also adds the
// 🪪 Identities tab of the 🧩 panel and the "Forms" quick commands.
//
// Storage: chrome.storage.local[KEY] = [identity, …], at most MAX. An identity is
// { id, name, fields: { key: value }, created, updated, uses }. Keys are normalised to camelCase and
// never name a secret (password, PIN, card number…): the save tool refuses those, so an identity can
// be listed and shown freely. Filling takes two injections: pageAutofillCollect runs in every frame
// and describes the visible fields (keeping the elements in window.__agentAutofill of that frame's
// isolated world), the panel matches them to the identity (matchFields, pure), and pageAutofillFill
// sets the chosen values in the frames that got any. browser_autofill_from_page runs the collector the
// other way round: the page's filled fields become an identity (fieldsToIdentity, pure). The collector
// and the filler are shared with the forms extra (forms.js, after this file in extras.js) through
// AgentExtras.autofill: with opts.all the collector describes every field the user sees (passwords as a
// length only, checkboxes, radios, disabled ones, validity, the <form> they sit in). Page-side functions
// are self-contained (no closures over this file); the tab's DOM is built with ctx.el, never innerHTML
// — labels come from web pages.
(function () {
  if (!globalThis.AGENT_BRAND || !globalThis.AGENT_BRAND.has("autofill")) return;
  var T = globalThis.AgentBrowserTools;
  var X = globalThis.AgentExtras;
  if (!T || !X) return;
  var H = T.helpers;
  var text = H.text;

  var KEY = "agentAutofill";
  var MAX = 20; // identities kept
  var MAX_VALUE = 500; // characters per value
  var MAX_FIELDS = 60; // keys per identity
  var MAX_PAGE_FIELDS = 150; // form fields read per frame
  var MAX_UNMATCHED = 10; // page fields reported as left alone

  // ── Keys (pure) ─────────────────────────────────────────────────────────

  // Spellings of a key the user may use, mapped to the key the synonym table knows.
  var ALIASES = {
    givenName: "firstName", forename: "firstName", fname: "firstName",
    surname: "lastName", familyName: "lastName", lname: "lastName",
    eMail: "email", emailAddress: "email", mail: "email",
    tel: "phone", telephone: "phone", phoneNumber: "phone", mobile: "phone", cell: "phone",
    organization: "company", organisation: "company", employer: "company", org: "company",
    position: "jobTitle", role: "jobTitle", title: "jobTitle",
    street: "address", streetAddress: "address", addressLine1: "address", address1: "address",
    addressLine2: "address2", apt: "address2", suite: "address2",
    town: "city", locality: "city",
    province: "state", region: "state",
    postcode: "zip", postalCode: "zip", zipCode: "zip",
    url: "website", homepage: "website",
    linkedIn: "linkedin", gitHub: "github",
    dob: "birthday", dateOfBirth: "birthday", birthDate: "birthday",
  };
  // What a page calls a field, per identity key: phrases looked for as whole words in the field's
  // label, name, id and placeholder; "autocomplete=x" is the autocomplete attribute's token.
  var SYNONYMS = {
    firstName: ["first name", "given name", "fname", "autocomplete=given-name"],
    lastName: ["last name", "surname", "family name", "lname", "family-name", "autocomplete=family-name"],
    fullName: ["full name", "your name", "name", "autocomplete=name"],
    name: ["full name", "your name", "name", "autocomplete=name"],
    email: ["email", "e-mail", "autocomplete=email"],
    phone: ["phone", "mobile", "tel", "autocomplete=tel"],
    company: ["company", "organization", "organisation", "employer", "org", "autocomplete=organization"],
    jobTitle: ["job title", "position", "role", "title", "autocomplete=organization-title"],
    address: ["address", "street", "address line 1", "street-address", "autocomplete=street-address", "autocomplete=address-line1"],
    address2: ["address line 2", "apt", "suite", "autocomplete=address-line2"],
    city: ["city", "town", "locality", "autocomplete=address-level2"],
    state: ["state", "province", "region", "autocomplete=address-level1"],
    zip: ["zip", "postal", "postcode", "autocomplete=postal-code"],
    country: ["country", "autocomplete=country", "autocomplete=country-name"],
    website: ["website", "url", "homepage", "autocomplete=url"],
    linkedin: ["linkedin"],
    github: ["github"],
    twitter: ["twitter"],
    birthday: ["birth", "dob", "date of birth", "autocomplete=bday"],
  };
  // Words that mark a secret: anywhere in a word for the unmistakable ones, at the start of a word
  // for pin/card ("pinCode", "cardNumber" — but not "shipping" or "discard").
  var SECRET = /password|passcode|cvv|cvc|iban|ssn|secret|token/i;
  var SECRET_START = /^(pin|card)/i;
  // Words of a page field (whole words only) and autocomplete tokens that mark a secret field.
  var SECRET_FIELD_WORD = /^(cc|cvn|otp)$/i;
  var SECRET_AUTOCOMPLETE = /(^|\s)(cc-|one-time-code|new-password|current-password)/i;

  function wordsOf(key) {
    return String(key == null ? "" : key).replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  }
  /** "First name" / "first_name" / "FirstName" → "firstName"; a known spelling → the table's key ("E-mail" → "email"). */
  function normKey(key) {
    var w = wordsOf(key);
    if (!w.length) return "";
    var k = w.map(function (t, i) { return i ? t.charAt(0).toUpperCase() + t.slice(1) : t; }).join("");
    return ALIASES[k] || k;
  }
  function isSecretKey(key) {
    return wordsOf(key).some(function (w) { return SECRET.test(w) || SECRET_START.test(w); });
  }
  /** A page field that must never be kept: a password, or one whose label, name, id, placeholder or autocomplete names a secret (card, CVV, IBAN, SSN, PIN, token…). */
  function isSecretField(f) {
    if (!f) return false;
    if (f.type === "password") return true;
    if (SECRET_AUTOCOMPLETE.test(String(f.autocomplete || ""))) return true;
    return [f.label, f.name, f.id, f.placeholder].some(function (s) {
      return !!s && (isSecretKey(s) || wordsOf(s).some(function (w) { return SECRET_FIELD_WORD.test(w); }));
    });
  }
  /** The fields of a save call: keys normalised, values trimmed; secrets and over-long values refused, empty values dropped. */
  function normFields(fields) {
    if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw new Error("fields is required — an object of key → value, e.g. { firstName: 'Ann', email: 'ann@example.com' }.");
    var out = {}, refused = [], tooLong = [];
    Object.keys(fields).forEach(function (raw) {
      var k = normKey(raw);
      if (!k) return;
      if (isSecretKey(raw) || isSecretKey(k)) { refused.push(raw); return; }
      var v = fields[raw] == null ? "" : String(fields[raw]).replace(/\r\n?/g, "\n").trim();
      if (!v) return;
      if (v.length > MAX_VALUE) { tooLong.push(raw); return; }
      out[k] = v;
    });
    if (refused.length) throw new Error("Refused: " + refused.join(", ") + " — identities never hold passwords, PINs, card numbers or other secrets; leave those out, the user types them.");
    if (tooLong.length) throw new Error("Too long: " + tooLong.join(", ") + " — a value holds at most " + MAX_VALUE + " characters.");
    if (!Object.keys(out).length) throw new Error("fields holds no usable key → value pair.");
    if (Object.keys(out).length > MAX_FIELDS) throw new Error("Too many fields (" + Object.keys(out).length + "; an identity holds at most " + MAX_FIELDS + ").");
    return out;
  }

  // ── Matching page fields to an identity (pure) ──────────────────────────

  function normText(s) {
    return String(s == null ? "" : s).replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }
  /** A page string both split at camelCase ("firstName" → "first name") and as written ("LinkedIn" → "linkedin"). */
  function spellings(s) {
    var split = normText(s), plain = String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    return split === plain ? [split] : [split, plain];
  }
  function hasWord(hay, phrase) { return (" " + hay + " ").indexOf(" " + phrase + " ") !== -1; }
  function oneLine(s, max) {
    s = String(s == null ? "" : s).replace(/\s*\n\s*/g, " / ").replace(/\s+/g, " ").trim();
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
  }
  /** What to call a page field in a report: its label, else placeholder, name, id, or its kind. */
  function fieldName(f) {
    var n = f.label || f.placeholder || f.name || f.id || (f.tag === "input" ? f.type + " input" : f.tag);
    return oneLine(n, 60) + (f.frame ? " [frame " + f.frame + "]" : "");
  }

  /** How well a page field answers to an identity key: 0 when it doesn't; the autocomplete attribute and exact names score highest. */
  function scoreField(field, key) {
    var phrases = SYNONYMS[key] || [];
    var hays = [spellings(field.label), spellings(field.name), spellings(field.id), spellings(field.placeholder)];
    var auto = String(field.autocomplete || "").toLowerCase().split(/\s+/).filter(Boolean);
    var nk = normText(key);
    var best = 0;
    if (auto.indexOf(key.toLowerCase()) !== -1 || (field.name && hays[1].indexOf(nk) !== -1) || (field.id && hays[2].indexOf(nk) !== -1)) best = 90;
    phrases.forEach(function (ph) {
      if (ph.indexOf("autocomplete=") === 0) {
        if (auto.indexOf(ph.slice("autocomplete=".length)) !== -1) best = Math.max(best, 100);
        return;
      }
      var np = normText(ph);
      hays.forEach(function (hs) {
        hs.forEach(function (h) {
          if (!h) return;
          if (h === np) best = Math.max(best, 80 + np.length);
          else if (hasWord(h, np)) best = Math.max(best, 40 + np.length);
        });
      });
      if (normText(field.type) === np) best = Math.max(best, 30 + np.length); // type=email, type=tel, type=url
    });
    return best;
  }

  /** The option of a select that shows value (its text or value, case-insensitive; else a unique prefix either way). */
  function pickOption(options, value) {
    var v = String(value == null ? "" : value).trim().toLowerCase();
    if (!v) return null;
    var exact = (options || []).filter(function (o) { return String(o.value).trim().toLowerCase() === v || String(o.text).trim().toLowerCase() === v; });
    if (exact.length) return exact[0];
    var starts = (options || []).filter(function (o) { var t = String(o.text).trim().toLowerCase(); return t && (t.indexOf(v) === 0 || v.indexOf(t) === 0); });
    return starts.length === 1 ? starts[0] : null;
  }

  /**
   * The fill plan of an identity for a page's fields → { plan, skipped, unmatched, unmatchedFields }.
   * plan: [{ field, key, value, option?, shown? }] in page order; skipped: fields that already hold a
   * value (unless opts.overwrite); unmatched: [{ key, why }] keys that found no field; unmatchedFields:
   * the page's fields nothing was planned for. opts.only limits the keys. Each field is used once
   * and each key once (the best score wins); password fields never take part.
   */
  function matchFields(pageFields, identity, opts) {
    opts = opts || {};
    var fields = (pageFields || []).filter(function (f) { return f && f.type !== "password"; });
    var values = (identity && identity.fields) || {};
    var only = Array.isArray(opts.only) && opts.only.length ? opts.only.map(normKey).filter(Boolean) : null;
    var keys = Object.keys(values).filter(function (k) { return !only || only.indexOf(k) !== -1; });
    var cands = [];
    keys.forEach(function (k, ki) {
      fields.forEach(function (f, fi) { var s = scoreField(f, k); if (s) cands.push({ s: s, fi: fi, ki: ki }); });
    });
    cands.sort(function (a, b) { return b.s - a.s || a.fi - b.fi || a.ki - b.ki; });
    var fieldTaken = {}, keyTaken = {}, plan = [], skipped = [], noOption = {};
    cands.forEach(function (c) {
      if (fieldTaken[c.fi] || keyTaken[c.ki]) return;
      var f = fields[c.fi], k = keys[c.ki], v = values[k], option = null;
      if (f.tag === "select") {
        option = pickOption(f.options, v);
        if (!option) { if (!noOption[k]) noOption[k] = 'select "' + fieldName(f) + '" has no option "' + oneLine(v, 40) + '"'; return; }
      }
      fieldTaken[c.fi] = true;
      keyTaken[c.ki] = true;
      if (f.value && opts.overwrite !== true) { skipped.push({ field: f, key: k, value: v, fi: c.fi }); return; }
      plan.push({ field: f, key: k, value: v, option: option ? option.value : undefined, shown: option ? option.text : undefined, fi: c.fi });
    });
    var byPage = function (a, b) { return a.fi - b.fi; };
    plan.sort(byPage);
    skipped.sort(byPage);
    return {
      plan: plan,
      skipped: skipped,
      unmatched: keys.filter(function (k, ki) { return !keyTaken[ki]; }).map(function (k) { return { key: k, why: noOption[k] || "" }; }),
      unmatchedFields: fields.filter(function (f, fi) { return !fieldTaken[fi]; }),
    };
  }

  // ── Page fields to an identity (pure) ───────────────────────────────────

  // The keys a page field can become ("name" shares fullName's phrases, so fullName stands for both).
  var IDENTITY_KEYS = Object.keys(SYNONYMS).filter(function (k) { return k !== "name"; });

  /**
   * An identity from a page's filled fields → { fields, kept, notKept, secret }: every field that holds a
   * value goes to the identity key it answers to best (the synonym table in reverse, each key used once
   * — the best score wins, then page order); fields that fit no key, or whose key is taken, are notKept
   * [{ field, why }]; password fields and secret-looking ones (isSecretField) are never kept.
   */
  function fieldsToIdentity(pageFields) {
    var fields = {}, kept = [], notKept = [], secret = [], cands = [];
    (pageFields || []).forEach(function (f, fi) {
      if (!f) return;
      var v = String(f.value == null ? "" : f.value).replace(/\r\n?/g, "\n").trim();
      if (!v) return;
      if (isSecretField(f)) { secret.push(f); return; }
      if (v.length > MAX_VALUE) { notKept.push({ field: f, why: "too long (" + v.length + " chars; a value holds at most " + MAX_VALUE + ")", fi: fi }); return; }
      var best = 0, bestKey = "";
      IDENTITY_KEYS.forEach(function (k) { var s = scoreField(f, k); if (s > best) { best = s; bestKey = k; } });
      if (!best) { notKept.push({ field: f, why: "no identity key fits it", fi: fi }); return; }
      cands.push({ s: best, fi: fi, field: f, key: bestKey, value: v });
    });
    cands.sort(function (a, b) { return b.s - a.s || a.fi - b.fi; });
    var keyTaken = {};
    cands.forEach(function (c) {
      if (keyTaken[c.key]) { notKept.push({ field: c.field, why: c.key + " is already taken", fi: c.fi }); return; }
      keyTaken[c.key] = true;
      kept.push({ field: c.field, key: c.key, value: c.value, fi: c.fi });
    });
    var byPage = function (a, b) { return a.fi - b.fi; };
    kept.sort(byPage);
    notKept.sort(byPage);
    kept.forEach(function (k) { fields[k.key] = k.value; }); // in page order
    return { fields: fields, kept: kept, notKept: notKept, secret: secret };
  }

  // ── Words for the model (pure) ──────────────────────────────────────────

  function ago(ts) {
    if (!ts) return "";
    var d = Date.now() - ts;
    if (d < 60000) return "just now";
    if (d < 3600000) return Math.floor(d / 60000) + "m ago";
    if (d < 86400000) return Math.floor(d / 3600000) + "h ago";
    return Math.floor(d / 86400000) + "d ago";
  }
  function fieldsLine(idn) {
    return Object.keys(idn.fields).map(function (k) { return k + ": " + oneLine(idn.fields[k], 60); }).join(" · ");
  }
  /** The browser_autofill_list report. */
  function formatList(list) {
    if (!list.length) return "No identities saved yet. browser_autofill_save keeps the user's details (never passwords or card numbers) for filling forms.";
    return "Identities (" + list.length + " of " + MAX + "):\n" + list.map(function (idn) {
      var n = Object.keys(idn.fields).length;
      return "- " + idn.name + "  (id " + idn.id + "; " + n + " field" + (n === 1 ? "" : "s") + (idn.uses ? "; used " + idn.uses + "×" : "") + "; updated " + ago(idn.updated) + ")\n    " + fieldsLine(idn);
    }).join("\n");
  }
  /** The browser_autofill_apply report for { identity, match, results, dryRun, fieldsCount, missingOnly }. */
  function formatApply(r) {
    var idn = r.identity, m = r.match, lines = [], filled = 0;
    var resultOf = {};
    (r.results || []).forEach(function (x) { resultOf[(x.frame || 0) + ":" + x.i] = x; });
    m.plan.forEach(function (p) {
      var x = resultOf[(p.field.frame || 0) + ":" + p.field.i];
      var head = fieldName(p.field) + " ← " + p.key + " = " + oneLine(p.value, 80) + (p.shown !== undefined && String(p.shown).toLowerCase() !== String(p.value).toLowerCase() ? ' (option "' + p.shown + '")' : "");
      if (r.dryRun) lines.push("would fill: " + head);
      else if (x && x.ok && x.verified !== false) { filled++; lines.push("filled: " + head); }
      else lines.push("not filled: " + head + " — " + ((x && x.why) || "the field does not show the value; the page may reject programmatic input — type it with browser_type"));
    });
    m.skipped.forEach(function (sk) { lines.push("skipped (already filled): " + fieldName(sk.field) + " ← " + sk.key + ' (holds "' + oneLine(sk.field.value, 40) + '"; pass overwrite=true to replace it)'); });
    if (m.unmatched.length) lines.push("not matched: " + m.unmatched.map(function (u) { return u.key + (u.why ? " (" + u.why + ")" : ""); }).join(", "));
    if (r.missingOnly && r.missingOnly.length) lines.push("not in the identity: " + r.missingOnly.join(", "));
    if (m.unmatchedFields.length) {
      lines.push("unmatched fields on the page: " + m.unmatchedFields.slice(0, MAX_UNMATCHED).map(fieldName).join(", ") + (m.unmatchedFields.length > MAX_UNMATCHED ? " … (" + m.unmatchedFields.length + " in all)" : ""));
    }
    var head = r.dryRun
      ? "Dry run — identity '" + idn.name + "' (" + idn.id + ") would fill " + m.plan.length + " of " + r.fieldsCount + " fields on this page; nothing was changed:"
      : "Filled " + filled + " of " + r.fieldsCount + " fields on this page from identity '" + idn.name + "' (" + idn.id + "):";
    return head + "\n" + lines.join("\n") + (r.dryRun ? "" : "\nNothing was submitted — the user checks the form and sends it.");
  }
  /** The browser_autofill_from_page report for a save result `s` and a fieldsToIdentity result `r`. */
  function formatFromPage(s, r) {
    var idn = s.identity, filled = r.kept.length + r.notKept.length + r.secret.length;
    var head = (s.replaced ? "Updated" : "Saved") + " identity '" + idn.name + "' (id " + idn.id + ") from " + r.kept.length + " of " + filled + " filled field" + (filled === 1 ? "" : "s") + " on this page:";
    var lines = r.kept.map(function (k) { return "kept: " + k.key + " = " + oneLine(k.value, 80) + "  ← " + fieldName(k.field); });
    r.notKept.forEach(function (n) { lines.push("not kept: " + fieldName(n.field) + " (" + n.why + ")"); });
    if (r.secret.length) lines.push("never kept (secret): " + r.secret.map(fieldName).join(", "));
    var keys = Object.keys(idn.fields);
    var tail = "Identity '" + idn.name + "' now holds " + keys.length + " field" + (keys.length === 1 ? "" : "s") + ": " + keys.join(", ") + ".";
    if (s.replaced) {
      var what = [].concat(s.changed.length ? ["changed " + s.changed.join(", ")] : []).concat(s.added.length ? ["added " + s.added.join(", ")] : []).concat(s.removed && s.removed.length ? ["removed " + s.removed.join(", ")] : []);
      tail += " " + (what.length ? what.join("; ").replace(/^./, function (c) { return c.toUpperCase(); }) : "Nothing new, the values were the same") + ".";
    }
    return head + "\n" + lines.join("\n") + "\n" + tail;
  }

  // ── Storage ─────────────────────────────────────────────────────────────

  async function load() {
    var st = await chrome.storage.local.get(KEY);
    var list = st && st[KEY];
    return Array.isArray(list) ? list.filter(function (i) { return i && i.id && i.fields; }) : [];
  }
  function store(list) { var o = {}; o[KEY] = list; return chrome.storage.local.set(o); }
  function newId(list) {
    var id;
    do { id = "idn_" + Math.random().toString(36).slice(2, 8); } while (list.some(function (i) { return i.id === id; }));
    return id;
  }
  function byName(list, name) {
    var q = String(name || "").trim().toLowerCase();
    if (!q) return null;
    var exact = list.filter(function (i) { return i.name.toLowerCase() === q; });
    if (exact.length) return exact[0];
    var starts = list.filter(function (i) { return i.name.toLowerCase().indexOf(q) === 0; });
    return starts.length === 1 ? starts[0] : null;
  }
  /** The identity `a` names (id first, then name; the only one saved when neither is given); throws a message for the model otherwise. */
  function findIdentity(list, a) {
    a = a || {};
    if (a.id) {
      var byId = list.filter(function (i) { return i.id === a.id; })[0];
      if (!byId) throw new Error("No identity with id " + a.id + ". browser_autofill_list shows the saved ones.");
      return byId;
    }
    if (a.name) {
      var hit = byName(list, a.name);
      if (!hit) throw new Error("No identity named '" + a.name + "'. browser_autofill_list shows the saved ones.");
      return hit;
    }
    if (list.length === 1) return list[0];
    if (!list.length) throw new Error("No identities saved yet — browser_autofill_save keeps the user's details first.");
    throw new Error("name or id is required — " + list.length + " identities are saved: " + list.map(function (i) { return "'" + i.name + "'"; }).join(", ") + ".");
  }

  /**
   * Save a new identity, or merge the fields into the one with that name → { identity, replaced, added, changed, removed }.
   * With opts.replace the existing identity's fields are replaced instead of merged (id, creation date and uses stay).
   */
  async function saveIdentity(a, opts) {
    a = a || {};
    opts = opts || {};
    var name = String(a.name || "").replace(/\s+/g, " ").trim().slice(0, 60);
    if (!name) throw new Error("name is required — what to call the identity, e.g. 'Personal' or 'Work'.");
    var fields = normFields(a.fields);
    var list = await load();
    var now = Date.now();
    var i = -1;
    list.forEach(function (idn, k) { if (i === -1 && idn.name.toLowerCase() === name.toLowerCase()) i = k; });
    if (i !== -1) {
      var old = list[i], merged = opts.replace === true ? {} : Object.assign({}, old.fields), added = [], changed = [], removed = [];
      Object.keys(fields).forEach(function (k) {
        if (!(k in old.fields)) added.push(k); else if (old.fields[k] !== fields[k]) changed.push(k);
        merged[k] = fields[k];
      });
      if (opts.replace === true) removed = Object.keys(old.fields).filter(function (k) { return !(k in fields); });
      if (Object.keys(merged).length > MAX_FIELDS) throw new Error("Too many fields (" + Object.keys(merged).length + "; an identity holds at most " + MAX_FIELDS + ").");
      list[i] = Object.assign({}, old, { fields: merged, updated: now });
      await store(list);
      return { identity: list[i], replaced: true, added: added, changed: changed, removed: removed };
    }
    if (list.length >= MAX) throw new Error("Identity limit reached (" + MAX + "). Delete one with browser_autofill_delete first.");
    var idn = { id: newId(list), name: name, fields: fields, created: now, updated: now, uses: 0 };
    list.push(idn);
    await store(list);
    return { identity: idn, replaced: false, added: Object.keys(fields), changed: [], removed: [] };
  }

  async function deleteIdentity(a) {
    var list = await load();
    var idn = findIdentity(list, a);
    await store(list.filter(function (x) { return x.id !== idn.id; }));
    return { identity: idn, left: list.length - 1 };
  }

  async function bumpUse(id) {
    var list = await load();
    list.forEach(function (i) { if (i.id === id) { i.uses = (i.uses || 0) + 1; i.lastUsed = Date.now(); } });
    await store(list);
  }

  // ── Page side ───────────────────────────────────────────────────────────

  // Every visible, enabled, writable text-like input, textarea and select of this frame (shadow roots
  // included), with what identifies it; the elements stay in window.__agentAutofill for pageAutofillFill.
  // With opts.all (the forms extra) every field the user sees is described instead: passwords (as a
  // length only), checkboxes and radios (checked), disabled and read-only ones (flagged), each with its
  // required flag, validity and validation message, and the <form> it sits in (index into `forms`:
  // name, id, action host, submit button labels); opts.maxValue is the characters kept of a value.
  function pageAutofillCollect(maxFields, opts) {
    opts = opts || {};
    var all = opts.all === true, maxValue = opts.maxValue || 120;
    var TYPES = /^(text|email|tel|url|number|search|date)$/i;
    var SKIP = /^(hidden|submit|button|reset|image|file)$/i;
    function clean(s) { return String(s || "").replace(/\s+/g, " ").trim().slice(0, 120); }
    function hostOf(u) { try { return new URL(u || "", location.href).host; } catch (_) { return ""; } }
    function buttonLabel(b) {
      var t = b.getAttribute("aria-label") || (b.tagName === "INPUT" ? b.value || b.getAttribute("alt") : b.textContent) || b.getAttribute("title") || "";
      return clean(t);
    }
    var forms = [], formIndex = [];
    function formOf(el) {
      var fm = el.form || (el.closest ? el.closest("form") : null);
      if (!fm) return -1;
      var k = formIndex.indexOf(fm);
      if (k !== -1) return k;
      var submits = [];
      fm.querySelectorAll("button, input[type=submit], input[type=image]").forEach(function (b) {
        if (b.tagName === "BUTTON" && /^(button|reset)$/i.test(b.getAttribute("type") || "")) return;
        var l = buttonLabel(b);
        if (l && submits.length < 5 && submits.indexOf(l) === -1) submits.push(l);
      });
      formIndex.push(fm);
      forms.push({ i: forms.length, name: clean(fm.getAttribute("name")), id: clean(fm.id), action: hostOf(fm.getAttribute("action")), submits: submits });
      return forms.length - 1;
    }
    function visible(el) {
      if (!el.isConnected) return false;
      var cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return false;
      var r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }
    function labelOf(el) {
      var t = el.getAttribute("aria-label") || "";
      if (!t && el.getAttribute("aria-labelledby")) t = el.getAttribute("aria-labelledby").split(/\s+/).map(function (id) { var n = document.getElementById(id); return n ? n.textContent : ""; }).join(" ");
      if (!t && el.labels && el.labels.length) t = el.labels[0].textContent;
      if (!t && el.closest("label")) t = el.closest("label").textContent;
      return clean(t);
    }
    function collect(root, out) {
      root.querySelectorAll("input, textarea, select").forEach(function (el) { out.push(el); });
      root.querySelectorAll("*").forEach(function (el) { if (el.shadowRoot) collect(el.shadowRoot, out); });
    }
    var all = [];
    collect(document, all);
    var kept = [], fields = [];
    all.forEach(function (el) {
      if (fields.length >= maxFields) return;
      var tag = el.tagName.toLowerCase();
      var type = tag === "input" ? String(el.type || "text").toLowerCase() : tag; // el.type reads unknown types as "text"
      if (tag === "input" && (all ? SKIP.test(type) : !TYPES.test(type))) return;
      if (!all && (el.disabled || el.readOnly)) return;
      if (!visible(el)) return;
      var f = { i: kept.length, tag: tag, type: type, label: labelOf(el), name: clean(el.getAttribute("name")), id: clean(el.id), placeholder: clean(el.getAttribute("placeholder")), autocomplete: clean(el.getAttribute("autocomplete")).toLowerCase() };
      if (tag === "select") {
        f.options = Array.prototype.slice.call(el.options, 0, 300).map(function (o) { return { text: clean(o.textContent), value: String(o.value) }; });
        var cur = el.selectedIndex >= 0 ? el.options[el.selectedIndex] : null;
        // A select holds a value unless its first option is chosen and that is a prompt ("Select…", empty).
        var prompt = !cur || (el.selectedIndex === 0 && (!String(cur.value) || !clean(cur.textContent) || /^(select|choose|please|pick|-|—|–|…|\()/i.test(clean(cur.textContent))));
        f.value = prompt ? "" : clean(cur.textContent);
      } else if (all && (type === "checkbox" || type === "radio")) {
        f.checked = !!el.checked;
        f.value = el.checked ? "on" : "";
        f.optionValue = clean(el.value);
      } else if (all && type === "password") {
        f.value = "";
        f.passwordLength = String(el.value || "").length;
      } else {
        f.value = String(el.value || "").slice(0, maxValue);
      }
      if (all) {
        f.required = !!el.required;
        f.disabled = !!el.disabled;
        f.readonly = !!el.readOnly;
        f.valid = el.validity ? !!el.validity.valid : true;
        f.message = f.valid ? "" : clean(el.validationMessage);
        f.form = formOf(el);
      }
      kept.push(el);
      fields.push(f);
    });
    window.__agentAutofill = kept;
    return all ? { isTop: window === window.top, fields: fields, forms: forms } : { isTop: window === window.top, fields: fields };
  }

  // Set the planned values ([{ i, value, option }]) on this frame's collected elements through the native
  // value setter plus input/change events, so React/Vue forms notice; reads them back after a beat. A
  // checkbox or radio (the forms extra's drafts) is clicked when it is not checked yet.
  function pageAutofillFill(items) {
    var els = window.__agentAutofill || [];
    function fire(el, data) {
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: data }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
    var done = items.map(function (it) {
      var el = els[it.i];
      if (!el || !el.isConnected) return { i: it.i, ok: false, why: "the field is gone — the page changed; read it again" };
      if (el.type === "password") return { i: it.i, ok: false, why: "a password field is never filled" };
      if (el.disabled || el.readOnly) return { i: it.i, ok: false, why: "the field is disabled or read-only" };
      try {
        if (el.type === "checkbox" || el.type === "radio") {
          if (!el.checked) el.click();
          return { i: it.i, ok: true, check: true };
        }
        if (el.tagName === "SELECT") {
          var want = String(it.option == null ? it.value : it.option).trim().toLowerCase(), idx = -1;
          for (var k = 0; k < el.options.length && idx < 0; k++) {
            var o = el.options[k];
            if (String(o.value).trim().toLowerCase() === want || String(o.textContent).trim().toLowerCase() === want) idx = k;
          }
          if (idx < 0) return { i: it.i, ok: false, why: 'no option matches "' + it.value + '"' };
          el.focus();
          el.selectedIndex = idx;
          fire(el, null);
          return { i: it.i, ok: true, idx: idx };
        }
        var proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        var d = Object.getOwnPropertyDescriptor(proto, "value");
        el.focus();
        if (d && d.set) d.set.call(el, it.value); else el.value = it.value;
        fire(el, it.value);
        el.blur();
        return { i: it.i, ok: true, want: it.value };
      } catch (e) { return { i: it.i, ok: false, why: String((e && e.message) || e) }; }
    });
    return new Promise(function (resolve) {
      setTimeout(function () {
        done.forEach(function (r) {
          if (!r.ok) return;
          var el = els[r.i];
          r.verified = r.check ? el.checked === true : el.tagName === "SELECT" ? el.selectedIndex === r.idx : el.value === r.want;
          delete r.idx; delete r.want; delete r.check;
        });
        resolve(done);
      }, 120);
    });
  }

  // ── Apply (shared by the tool and the tab) ──────────────────────────────

  /**
   * The fillable fields of every frame of the current tab, in page order (top frame first), each stamped
   * with its frame. With opts ({ all, maxValue } of pageAutofillCollect) every field the user sees, its
   * `form` resolved to { frame, i, name, id, action, submits } (null outside a form).
   */
  async function collectFields(opts) {
    var results = await H.inAllFrames(pageAutofillCollect, opts ? [MAX_PAGE_FIELDS, opts] : [MAX_PAGE_FIELDS]);
    var frames = (results || []).filter(function (r) { return r && r.result && Array.isArray(r.result.fields); });
    frames.sort(function (a, b) { return (b.result.isTop ? 1 : 0) - (a.result.isTop ? 1 : 0) || (a.frameId || 0) - (b.frameId || 0); });
    var fields = [];
    frames.forEach(function (r, fi) {
      var forms = Array.isArray(r.result.forms) ? r.result.forms : [];
      r.result.fields.forEach(function (f) {
        f.frame = fi; f.frameId = r.frameId; f.documentId = r.documentId;
        if (typeof f.form === "number") f.form = f.form >= 0 && forms[f.form] ? Object.assign({ frame: fi }, forms[f.form]) : null;
        fields.push(f);
      });
    });
    return fields;
  }

  /** Run pageAutofillFill in every frame the plan touches → [{ i, frame, ok, verified, why }]. */
  async function fillPlan(plan) {
    if (!plan.length) return [];
    var tab = await H.currentTab();
    var groups = {};
    plan.forEach(function (p) {
      var k = String(p.field.frame || 0);
      (groups[k] = groups[k] || { field: p.field, items: [] }).items.push({ i: p.field.i, value: p.value, option: p.option });
    });
    var out = [];
    var keys = Object.keys(groups);
    for (var n = 0; n < keys.length; n++) {
      var g = groups[keys[n]], f = g.field;
      var target = { tabId: tab.id };
      if (f.documentId) target.documentIds = [f.documentId]; else if (f.frameId) target.frameIds = [f.frameId];
      try {
        var res = await chrome.scripting.executeScript({ target: target, func: pageAutofillFill, args: [g.items], world: "ISOLATED" });
        var r = res && res[0] ? res[0].result : null;
        (Array.isArray(r) ? r : []).forEach(function (x) { x.frame = Number(keys[n]); out.push(x); });
      } catch (e) {
        g.items.forEach(function (it) { out.push({ i: it.i, frame: Number(keys[n]), ok: false, why: "the frame could not be scripted (" + String((e && e.message) || e) + ")" }); });
      }
    }
    return out;
  }

  /** Fill the current page with an identity (or plan it with dryRun) → what formatApply needs. */
  async function applyIdentity(a) {
    a = a || {};
    var idn = findIdentity(await load(), a);
    var fields = await collectFields();
    if (!fields.length) throw new Error("No fillable form field is visible on this page (enabled, writable text inputs, textareas or selects). Read the page with browser_read_page first.");
    var only = Array.isArray(a.only) && a.only.length ? a.only : null;
    var m = matchFields(fields, idn, { only: only, overwrite: a.overwrite === true });
    var missingOnly = only ? only.map(normKey).filter(function (k) { return k && !(k in idn.fields); }) : [];
    var r = { identity: idn, match: m, results: [], dryRun: a.dryRun === true, fieldsCount: fields.length, missingOnly: missingOnly };
    if (r.dryRun) return r;
    r.results = await fillPlan(m.plan);
    if (r.results.some(function (x) { return x.ok && x.verified !== false; })) await bumpUse(idn.id);
    return r;
  }

  // ── Tools ───────────────────────────────────────────────────────────────

  T.register("browser_autofill_save", async function (a) {
    var r = await saveIdentity(a);
    var idn = r.identity, keys = Object.keys(idn.fields);
    if (!r.replaced) return text("Saved identity '" + idn.name + "' (id " + idn.id + ") with " + keys.length + " field" + (keys.length === 1 ? "" : "s") + ": " + fieldsLine(idn) + ". browser_autofill_apply fills a form with it.");
    var what = [].concat(r.changed.length ? ["changed " + r.changed.join(", ")] : []).concat(r.added.length ? ["added " + r.added.join(", ")] : []);
    return text("Updated identity '" + idn.name + "' (id " + idn.id + "): " + (what.length ? what.join("; ") : "nothing new, the values were the same") + " — " + keys.length + " field" + (keys.length === 1 ? "" : "s") + " now: " + keys.join(", ") + ".");
  });

  T.register("browser_autofill_apply", async function (a) {
    return text(formatApply(await applyIdentity(a)));
  });

  T.register("browser_autofill_list", async function () {
    return text(formatList(await load()));
  });

  T.register("browser_autofill_delete", async function (a) {
    var r = await deleteIdentity(a);
    return text("Deleted identity '" + r.identity.name + "' (" + r.identity.id + "). " + r.left + " left.");
  });

  T.register("browser_autofill_from_page", async function (a) {
    a = a || {};
    var name = String(a.name || "").replace(/\s+/g, " ").trim();
    if (!name) throw new Error("name is required — what to call the identity, e.g. 'Personal' or 'Work'.");
    var fields = await collectFields();
    if (!fields.length) throw new Error("No form field is visible on this page (enabled, writable text inputs, textareas or selects). Read the page with browser_read_page first.");
    var r = fieldsToIdentity(fields);
    if (!Object.keys(r.fields).length) {
      var why = r.notKept.length ? " The filled fields fit no identity key: " + r.notKept.map(function (n) { return fieldName(n.field); }).join(", ") + "." : "";
      if (r.secret.length) why += " Never kept (secret): " + r.secret.map(fieldName).join(", ") + ".";
      throw new Error("Nothing to save: no filled field on this page fits an identity key." + why + " The user fills the form first — or browser_autofill_save takes the details from the chat.");
    }
    var s = await saveIdentity({ name: name, fields: r.fields }, { replace: a.merge === false });
    return text(formatFromPage(s, r));
  });

  // ── The 🪪 Identities tab ───────────────────────────────────────────────

  var FILL_PROMPT = "Fill this form with my saved details: look at browser_autofill_list, pick the identity that fits this page (ask me when it is not obvious), fill the form with browser_autofill_apply, then tell me what was filled and what I still have to enter myself. Don't submit anything.";
  var SAVE_PROMPT = "Read the form on this page (browser_read_page) and save the details I entered — name, email, phone, address, company and the like — as an identity with browser_autofill_save (never passwords, PINs or card numbers). Ask me what to call it when there is no obvious name.";

  function outText(out) { return (out || []).filter(function (p) { return p.type === "text"; }).map(function (p) { return p.text; }).join("\n"); }

  async function fillFromPanel(ctx, idn) {
    ctx.status("Filling the form with '" + idn.name + "'…");
    try {
      var report = outText(await T.run("browser_autofill_apply", { id: idn.id }));
      ctx.status("✓ " + report.split("\n")[0].replace(/:$/, "") + " — nothing was submitted.", "good");
      ctx.rerender();
    } catch (e) { ctx.status("⚠ " + ((e && e.message) || e), "bad"); }
  }

  async function render(content, ctx) {
    var el = ctx.el;
    var list = await load();
    content.textContent = "";
    content.appendChild(el("div", { className: "cmd-item", onclick: function () { ctx.sendPrompt(SAVE_PROMPT); } }, [
      el("span", { className: "cmd-icon" }, ["💾"]),
      el("div", { className: "cmd-body" }, [
        el("div", { className: "cmd-name" }, ["Save my details from this form"]),
        el("div", { className: "cmd-desc" }, ["The agent reads what you entered on the page and keeps it as an identity — never passwords or card numbers."]),
      ]),
    ]));
    if (!list.length) {
      content.appendChild(el("div", { className: "cmd-empty" }, ["No identities yet. Ask the agent to remember your details — e.g. \"remember my details: Ann Lee, ann@example.com, +1 555 0100, Quill Ltd\" — and it saves them with browser_autofill_save. Secrets such as passwords or card numbers are never stored."]));
      return;
    }
    list.forEach(function (idn) {
      var keys = Object.keys(idn.fields);
      content.appendChild(el("div", { className: "cmd-item" }, [
        el("span", { className: "cmd-icon" }, ["🪪"]),
        el("div", { className: "cmd-body" }, [
          el("div", { className: "cmd-name" }, [idn.name]),
          el("div", { className: "cmd-desc" }, [keys.map(function (k) { return k + ": " + oneLine(idn.fields[k], 40); }).join(" · ")]),
          el("div", { className: "cmd-desc" }, [keys.length + " field" + (keys.length === 1 ? "" : "s") + (idn.uses ? " · used " + idn.uses + "×" : "") + " · updated " + ctx.ago(idn.updated)]),
        ]),
        el("div", { className: "prof-actions column" }, [
          el("button", { className: "prof-btn", title: "Fill the form on the current tab with this identity (nothing is submitted)", onclick: function (e) { e.stopPropagation(); fillFromPanel(ctx, idn); } }, ["📝 Fill this page"]),
          el("button", { className: "prof-btn", title: "Delete", onclick: function (e) {
            e.stopPropagation();
            if (!confirm("Delete identity '" + idn.name + "'?")) return;
            deleteIdentity({ id: idn.id }).then(function () { ctx.status("Deleted '" + idn.name + "'.", "good"); ctx.rerender(); }, function (err) { ctx.status("⚠ " + err.message, "bad"); });
          } }, ["🗑"]),
        ]),
      ]));
    });
  }

  X.tabs.push({ id: "autofill", label: "🪪 Identities", storageKeys: [KEY], render: render });
  X.commands.push(
    { group: "Forms", icon: "📝", name: "Fill this form with my details", prompt: FILL_PROMPT },
    { group: "Forms", icon: "💾", name: "Save my details from this form", prompt: SAVE_PROMPT }
  );

  /** The pure parts and the storage functions, for tests and other modules (forms.js reads the page through collectFields/fillPlan). */
  X.autofill = {
    KEY: KEY, MAX: MAX, MAX_VALUE: MAX_VALUE, MAX_FIELDS: MAX_FIELDS, MAX_UNMATCHED: MAX_UNMATCHED, MAX_PAGE_FIELDS: MAX_PAGE_FIELDS,
    SYNONYMS: SYNONYMS, ALIASES: ALIASES,
    normKey: normKey, isSecretKey: isSecretKey, isSecretField: isSecretField, normFields: normFields,
    scoreField: scoreField, pickOption: pickOption, matchFields: matchFields, fieldsToIdentity: fieldsToIdentity, fieldName: fieldName, oneLine: oneLine,
    formatList: formatList, formatApply: formatApply, formatFromPage: formatFromPage, findIdentity: findIdentity,
    load: load, saveIdentity: saveIdentity, deleteIdentity: deleteIdentity, applyIdentity: applyIdentity,
    collectFields: collectFields, fillPlan: fillPlan,
    pageAutofillCollect: pageAutofillCollect, pageAutofillFill: pageAutofillFill, render: render,
  };
})();
