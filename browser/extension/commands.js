// Quick Commands panel — ready-made prompts the user can send with one click.
(function () {
  var COMMANDS = [
    // ── Pages & Navigation ─────────────────────────────
    { group: "Pages & Navigation", icon: "📖", name: "Read this page",
      prompt: "Read the current page and summarize what you see." },
    { group: "Pages & Navigation", icon: "📸", name: "Screenshot",
      prompt: "Take a screenshot of the current page." },
    { group: "Pages & Navigation", icon: "🔍", name: "Find on page",
      prompt: "Search this page for: ", partial: true },
    { group: "Pages & Navigation", icon: "🌐", name: "Open URL",
      prompt: "Open this URL: ", partial: true },
    { group: "Pages & Navigation", icon: "📑", name: "List all tabs",
      prompt: "List all my open tabs." },
    { group: "Pages & Navigation", icon: "🔙", name: "Go back",
      prompt: "Go back to the previous page." },

    // ── Cookies & Sessions ─────────────────────────────
    { group: "Cookies & Sessions", icon: "🍪", name: "Show cookies",
      prompt: "Show all cookies for the current site." },
    { group: "Cookies & Sessions", icon: "🍪", name: "Show cookies for domain",
      prompt: "Show all cookies for domain: ", partial: true },
    { group: "Cookies & Sessions", icon: "📤", name: "Export cookies",
      prompt: "Export all cookies for the current site as JSON." },
    { group: "Cookies & Sessions", icon: "📥", name: "Import cookies",
      prompt: "Import these cookies (paste JSON): ", partial: true },
    { group: "Cookies & Sessions", icon: "🗑️", name: "Clear cookies",
      prompt: "Clear all cookies for the current site." },
    { group: "Cookies & Sessions", icon: "✏️", name: "Set a cookie",
      prompt: "Set a cookie with name='', value='', domain='' (fill in the details): ", partial: true },

    // ── Windows & private sessions ─────────────────────
    { group: "Windows", icon: "🕶️", name: "New private window",
      prompt: "Open a new private (Incognito) window — a clean, logged-out session — and work there." },
    { group: "Windows", icon: "🕶️", name: "Private window + open URL",
      prompt: "Open a new private (Incognito) window and go to: ", partial: true },
    { group: "Windows", icon: "📋", name: "List windows",
      prompt: "List my open browser windows and their tabs, and say which one you are working in." },
    { group: "Windows", icon: "🔄", name: "Switch window",
      prompt: "Switch to window #", partial: true },
    { group: "Windows", icon: "❌", name: "Close window",
      prompt: "Close window #", partial: true },
    { group: "Windows", icon: "🔁", name: "Copy session to a private window",
      prompt: "Export the cookies of the current site, open a new private window on the same site, import the cookies there and check that I'm signed in." },

    // ── Device profiles ────────────────────────────────
    { group: "Device profiles", icon: "🕵️", name: "List device profiles",
      prompt: "List my saved device profiles." },
    { group: "Device profiles", icon: "➕", name: "New device profile",
      prompt: "Create a device profile named: ", partial: true },
    { group: "Device profiles", icon: "▶", name: "Launch device profile",
      prompt: "Launch the device profile named: ", partial: true },
    { group: "Device profiles", icon: "💾", name: "Save session into profile",
      prompt: "Save the current tab's cookies and URL into the active device profile." },

    // ── User-Agent ─────────────────────────────────────
    { group: "User-Agent", icon: "🎭", name: "Check UA",
      prompt: "Show my current User-Agent, platform, and language." },
    { group: "User-Agent", icon: "📱", name: "Mobile UA (iPhone)",
      prompt: "Set User-Agent to iPhone Safari: Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1 — and set platform to 'iPhone'. Then reload the page." },
    { group: "User-Agent", icon: "🤖", name: "Android UA",
      prompt: "Set User-Agent to Android Chrome: Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 — platform 'Linux armv8l'. Reload." },
    { group: "User-Agent", icon: "🍎", name: "Mac Safari UA",
      prompt: "Set User-Agent to Mac Safari: Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15 — platform 'MacIntel'. Reload." },
    { group: "User-Agent", icon: "🪟", name: "Windows Chrome UA",
      prompt: "Set User-Agent to Windows Chrome: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 — platform 'Win32'. Reload." },
    { group: "User-Agent", icon: "🎭", name: "Custom UA",
      prompt: "Set User-Agent to: ", partial: true },

    // ── Automation ─────────────────────────────────────
    { group: "Automation", icon: "📝", name: "Fill form",
      prompt: "Read the page, find all form fields, and fill them with test data." },
    { group: "Automation", icon: "📊", name: "Extract table",
      prompt: "Extract the main table from this page as structured text." },
    { group: "Automation", icon: "🔗", name: "Extract all links",
      prompt: "Read this page and list all links with their URLs." },
    { group: "Automation", icon: "📷", name: "Screenshot all tabs",
      prompt: "List all tabs, take a screenshot of each one, and describe what's on them." },
    { group: "Automation", icon: "🤖", name: "Auto-login",
      prompt: "Read the page. If there's a login form, tell me what fields it needs. Do NOT fill passwords — I'll do that myself." },
    { group: "Automation", icon: "👁", name: "Watch this page for changes",
      prompt: "Watch this page for changes with browser_watch_create — pick the part that matters (a CSS selector for the price/status/list, not the whole page) and check it every 30 minutes. Tell me what you are watching." },
    { group: "Automation", icon: "🧩", name: "Save this chat as a recipe",
      prompt: "Save what you did in this chat as a recipe with browser_recipe_save, named after the task; make the values that will change next time parameters." },

    // ── Data & Research ────────────────────────────────
    { group: "Data & Research", icon: "📊", name: "Summarize page",
      prompt: "Read this page thoroughly and give me a detailed summary." },
    { group: "Data & Research", icon: "🔎", name: "Google search",
      prompt: "Open a new tab, go to google.com, and search for: ", partial: true },
    { group: "Data & Research", icon: "📋", name: "Compare tabs",
      prompt: "List my tabs, read the current one and the next one, and compare their content." },
    { group: "Data & Research", icon: "💾", name: "Save page text",
      prompt: "Read this entire page with maxChars=40000 and show me the full text." },
    { group: "Data & Research", icon: "📡", name: "Read the page's API",
      prompt: "Start a network capture (browser_network_capture action=start), reload the page or trigger the data to load, then read the captured JSON responses and show me the structured data behind this page." },

    // ── Document Converter ──────────────────────────────
    { group: "Converter", icon: "📄", name: "Page → PDF",
      prompt: "Save this page as a PDF file (browser_page_to_pdf)." },
    { group: "Converter", icon: "📸", name: "Screenshot → file",
      prompt: "Take a screenshot of this page and save it as a PNG file." },
    { group: "Converter", icon: "💾", name: "Save page as HTML",
      prompt: "Save this page as an HTML file." },
    { group: "Converter", icon: "📝", name: "Save page as text",
      prompt: "Save this page content as a text file." },
    { group: "Converter", icon: "📊", name: "Table → CSV",
      prompt: "Extract the main table from this page and save it as a CSV file." },
    { group: "Converter", icon: "📊", name: "Table → JSON",
      prompt: "Extract the main table from this page and convert it to JSON." },
    { group: "Converter", icon: "🔄", name: "CSV → JSON",
      prompt: "Convert this CSV data to JSON: ", partial: true },
    { group: "Converter", icon: "🔄", name: "JSON → CSV",
      prompt: "Convert this JSON to CSV: ", partial: true },
    { group: "Converter", icon: "📝", name: "Markdown → HTML",
      prompt: "Convert this Markdown to HTML and save: ", partial: true },
    { group: "Converter", icon: "🖼️", name: "Image → JPEG (compress)",
      prompt: "Take a screenshot and save as compressed JPEG (quality 70%)." },

    // ── Privacy ────────────────────────────────────────
    { group: "Privacy", icon: "🧹", name: "Clean session",
      prompt: "Clear all cookies for the current site, then reload the page." },
    { group: "Privacy", icon: "🔒", name: "Check privacy",
      prompt: "Check my current User-Agent and list all cookies for the current site. Tell me what tracking cookies I have." },
  ];
  // Quick commands of a feature this brand ships without would only send the agent to tools it doesn't have.
  var GROUP_FEATURE = { "Cookies & Sessions": "cookies", "Privacy": "cookies", "Converter": "converter", "Device profiles": "profiles", "User-Agent": "profiles" };
  var NAME_FEATURE = { "Read the page's API": "network", "Watch this page for changes": "watchers", "Save this chat as a recipe": "recipes", "Copy session to a private window": "cookies", "Check privacy": "profiles" };
  function has(f) { return !window.AGENT_BRAND || !window.AGENT_BRAND.has || window.AGENT_BRAND.has(f); }
  // A command needs every feature its group and its name point at ("Check privacy" reads cookies and the User-Agent).
  COMMANDS = COMMANDS.filter(function (c) { return [GROUP_FEATURE[c.group], NAME_FEATURE[c.name]].every(function (f) { return !f || has(f); }); });
  // The brand's extra features (extras.js) bring their own quick commands.
  if (window.AgentExtras && window.AgentExtras.commands.length) COMMANDS = COMMANDS.concat(window.AgentExtras.commands);

  var panel = document.getElementById("commands-panel");
  var list = document.getElementById("cmdList");
  var search = document.getElementById("cmdSearch");
  var btn = document.getElementById("cmdBtn");
  var closeBtn = document.getElementById("cmdClose");
  var input = document.getElementById("input");

  if (!panel || !list || !btn) return;

  function render(filter) {
    var q = (filter || "").toLowerCase();
    list.innerHTML = "";
    var groups = {};
    COMMANDS.forEach(function (c) {
      if (q && c.name.toLowerCase().indexOf(q) === -1 && c.group.toLowerCase().indexOf(q) === -1 && c.prompt.toLowerCase().indexOf(q) === -1) return;
      if (!groups[c.group]) groups[c.group] = [];
      groups[c.group].push(c);
    });
    Object.keys(groups).forEach(function (g) {
      var div = document.createElement("div");
      div.className = "cmd-group";
      var title = document.createElement("div");
      title.className = "cmd-group-title";
      title.textContent = g;
      div.appendChild(title);
      groups[g].forEach(function (c) {
        var item = document.createElement("div");
        item.className = "cmd-item";
        var icon = document.createElement("span"); icon.className = "cmd-icon"; icon.textContent = c.icon;
        var body = document.createElement("div"); body.className = "cmd-body";
        var name = document.createElement("div"); name.className = "cmd-name"; name.textContent = c.name;
        var desc = document.createElement("div"); desc.className = "cmd-desc"; desc.textContent = c.prompt.slice(0, 80) + (c.prompt.length > 80 ? "…" : "");
        body.appendChild(name); body.appendChild(desc);
        item.appendChild(icon); item.appendChild(body);
        item.onclick = function () {
          if (c.partial) {
            // Put prompt in input and focus — user finishes it
            input.value = c.prompt;
            input.focus();
            input.setSelectionRange(input.value.length, input.value.length);
          } else {
            // Send immediately
            input.value = c.prompt;
            input.dispatchEvent(new Event("input", { bubbles: true }));
            // Trigger send
            var sendBtn = document.getElementById("send");
            if (sendBtn) sendBtn.click();
          }
          panel.classList.add("hidden");
        };
        div.appendChild(item);
      });
      list.appendChild(div);
    });
    if (!list.children.length) {
      var none = document.createElement("div");
      none.className = "cmd-empty";
      none.textContent = "No commands match your search";
      list.appendChild(none);
    }
  }

  btn.addEventListener("click", function () {
    var visible = !panel.classList.contains("hidden");
    if (visible) {
      panel.classList.add("hidden");
    } else {
      panel.classList.remove("hidden");
      search.value = "";
      render();
      search.focus();
    }
  });

  closeBtn.addEventListener("click", function () {
    panel.classList.add("hidden");
  });

  search.addEventListener("input", function () {
    render(search.value);
  });

  // Close on Escape
  panel.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      panel.classList.add("hidden");
      input.focus();
    }
  });
})();
