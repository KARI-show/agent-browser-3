// Extra feature "skills" (side panel): the design playbooks a brand ships with. The build writes
// skills.json next to the panel ([{ name, title, summary, when, command, prompt, body }], from
// browser/playbooks/<name>.md); this module serves them to the model (browser_skill_list /
// browser_skill_read), shows them in a 🎓 tab and turns each into a quick command.
(function () {
  if (!globalThis.AGENT_BRAND || !globalThis.AGENT_BRAND.has("skills")) return;
  var T = globalThis.AgentBrowserTools;
  var text = T.helpers.text;

  var loaded = null;
  function load() {
    if (loaded) return loaded;
    loaded = fetch(chrome.runtime.getURL("skills.json")).then(function (r) {
      if (!r.ok) throw new Error("skills.json is missing from this build");
      return r.json();
    }).then(function (list) { return Array.isArray(list) ? list : []; });
    loaded.catch(function () { loaded = null; });
    return loaded;
  }

  // ── Pure helpers (tests reach them through AgentExtras.skills) ────────────

  /** The list as the model reads it: one line per playbook with when to use it. */
  function listText(list) {
    if (!list.length) return "This build carries no playbooks.";
    return "Playbooks (" + list.length + ") — read one with browser_skill_read before a design task:\n" +
      list.map(function (s) { return "- " + s.name + " — " + s.title + ": " + s.summary + (s.when ? " Use when: " + s.when : ""); }).join("\n");
  }
  /** A playbook by name, tolerant of case, spaces and a .md suffix. */
  function find(list, name) {
    var key = String(name || "").trim().toLowerCase().replace(/\.md$/, "").replace(/[\s_]+/g, "-");
    return list.find(function (s) { return s.name === key; }) || null;
  }
  /** The playbook body as the model reads it. */
  function readText(s) {
    return "# " + s.title + " (" + s.name + ")\n\n" + String(s.body || "").trim();
  }

  // ── Tools ──────────────────────────────────────────────────────────────────

  T.register("browser_skill_list", async function () {
    return text(listText(await load()));
  });
  T.register("browser_skill_read", async function (a) {
    var list = await load();
    var s = find(list, a.name);
    if (!s) throw new Error("No playbook \"" + a.name + "\". Available: " + list.map(function (x) { return x.name; }).join(", "));
    return text(readText(s));
  });

  // ── Quick commands: each playbook brings one ───────────────────────────────

  load().then(function (list) {
    list.forEach(function (s) {
      if (!s.command || !s.prompt) return;
      // Another extra may already offer a command of this name (the styles extra's "Make this page easier to
      // read" next to the readability playbook): one command, with the playbook's prompt — it reads the
      // playbook first, so it is the richer of the two.
      var existing = globalThis.AgentExtras.commands.find(function (c) { return c.name === s.command; });
      if (existing) { existing.prompt = s.prompt; existing.playbook = s.name; return; }
      globalThis.AgentExtras.commands.push({ group: "Design", icon: s.icon || "🎓", name: s.command, prompt: s.prompt, playbook: s.name });
    });
  }).catch(function () {});

  // ── 🎓 tab ─────────────────────────────────────────────────────────────────

  globalThis.AgentExtras.tabs.push({
    id: "skills",
    label: "🎓 Skills",
    render: async function (content, ctx) {
      var el = ctx.el;
      var list;
      try { list = await load(); } catch (e) { content.appendChild(el("div", { className: "cmd-empty" }, [String(e.message || e)])); return; }
      content.appendChild(el("div", { className: "cmd-desc", style: "padding: 6px 12px" }, ["Design playbooks this build carries. The agent reads the relevant one before a design task; open one to see what it works by, or apply it to the page you are on."]));
      if (!list.length) { content.appendChild(el("div", { className: "cmd-empty" }, ["No playbooks in this build."])); return; }
      list.forEach(function (s) {
        var body = el("pre", { className: "auto-pre hidden" }, [String(s.body || "").trim()]);
        var toggle = el("button", { className: "prof-btn", title: "Read" }, ["📖"]);
        toggle.addEventListener("click", function (e) { e.stopPropagation(); body.classList.toggle("hidden"); });
        var use = el("button", { className: "prof-btn primary", title: "Apply to this page" }, ["▶"]);
        use.addEventListener("click", function (e) {
          e.stopPropagation();
          ctx.sendPrompt(s.prompt || ("Read the \"" + s.name + "\" playbook with browser_skill_read and apply it to the current page."));
        });
        content.appendChild(el("div", { className: "cmd-item", onclick: function () { body.classList.toggle("hidden"); } }, [
          el("span", { className: "cmd-icon" }, [s.icon || "🎓"]),
          el("div", { className: "cmd-body wide" }, [
            el("div", { className: "cmd-name" }, [s.title]),
            el("div", { className: "cmd-desc" }, [s.summary]),
            s.when ? el("div", { className: "cmd-desc" }, ["Use when: " + s.when]) : null,
            body,
          ]),
          el("div", { className: "prof-actions column" }, [use, toggle]),
        ]));
      });
    },
  });

  globalThis.AgentExtras.skills = { listText: listText, find: find, readText: readText };
})();
