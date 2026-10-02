// ═══════════════════════════════════════════════════════════════════════════
// Remote "bot" mode: the side panel is itself a Telegram bot. It long-polls
// the Bot API (no relay, tunnel or helper), takes tasks from ONE whitelisted
// user in a private chat, runs them in the open chat and answers there:
// the reply streams into one message, approvals and questions come as buttons.
//
// Started/stopped by relay.js (the remote coordinator, window.AgentRemote),
// which also guarantees only one panel polls (two pollers = Telegram 409).
// ═══════════════════════════════════════════════════════════════════════════
(function () {
  var API = "https://api.telegram.org/bot";
  var MAX_LEN = 4000; // Telegram's limit is 4096 characters per message
  var EDIT_EVERY_MS = 1500; // live reply refresh — well within Telegram's edit limits

  var bot = null; // { token, userId, ctrl, offset, username }
  var turn = null; // the task started from Telegram that is running now
  var approvals = {}; // approval id → Telegram message id
  var question = null; // { id, questions, msgId } waiting for an answer

  function R() { return window.AgentRemote; }
  function noop() {}
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  async function api(method, body, signal) {
    var b = bot;
    if (!b) throw new Error("bot stopped");
    var res = await fetch(API + b.token + "/" + method, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
      signal: signal,
    });
    var j = await res.json().catch(function () { return { ok: false, description: "HTTP " + res.status }; });
    if (!j.ok) {
      var e = new Error(j.description || method + " failed");
      e.code = j.error_code || res.status;
      throw e;
    }
    return j.result;
  }

  function say(text, markup) {
    var body = { chat_id: bot.userId, text: String(text).slice(0, MAX_LEN), disable_web_page_preview: true };
    if (markup) body.reply_markup = markup;
    return api("sendMessage", body);
  }

  function edit(messageId, text, markup) {
    var body = { chat_id: bot.userId, message_id: messageId, text: String(text).slice(0, MAX_LEN), disable_web_page_preview: true };
    if (markup) body.reply_markup = markup;
    return api("editMessageText", body).catch(function (e) {
      if (!/not modified/i.test(e.message)) throw e;
    });
  }

  function split(text) {
    var parts = [];
    var rest = text;
    while (rest.length > MAX_LEN) {
      var cut = rest.lastIndexOf("\n", MAX_LEN);
      if (cut < MAX_LEN / 2) cut = MAX_LEN;
      parts.push(rest.slice(0, cut));
      rest = rest.slice(cut).replace(/^\n/, "");
    }
    parts.push(rest);
    return parts;
  }

  function shortTool(name) {
    return String(name || "").replace(/^mcp__browser__/, "").replace(/^browser_/, "").replace(/_/g, " ");
  }

  function describe(name, input) {
    var short = String(name || "").replace(/^mcp__browser__/, "");
    try {
      return (window.AgentBrowserTools && window.AgentBrowserTools.describe(short, input || {})) || "";
    } catch (e) {
      return "";
    }
  }

  function chatTitle(id) {
    var c = R().state().chats.find(function (x) { return x.id === id; });
    return c ? c.title : "new chat";
  }

  // ── Start / stop (called by relay.js) ──────────────────────────────────

  function start(cfg) {
    stop();
    bot = { token: String(cfg.botToken).trim(), userId: String(cfg.userId).trim(), ctrl: new AbortController(), offset: 0 };
    R().status("off", "Starting the Telegram bot…");
    loop(bot);
  }

  function stop() {
    if (bot) bot.ctrl.abort();
    bot = null;
    if (turn && turn.timer) clearTimeout(turn.timer);
    turn = null;
    approvals = {};
    question = null;
  }

  async function loop(b) {
    var signal = b.ctrl.signal;
    try {
      var me = await api("getMe", {}, signal);
      b.username = me.username;
      // Long polling needs the webhook off.
      await api("deleteWebhook", { drop_pending_updates: false }, signal);
      // Skip what piled up while the panel was closed: acting on stale orders
      // the moment a panel opens would surprise the user.
      var backlog = await api("getUpdates", { offset: -1, timeout: 0 }, signal);
      if (backlog.length) b.offset = backlog[backlog.length - 1].update_id + 1;
      if (signal.aborted || bot !== b) return; // turned off while starting
      R().up("Telegram bot @" + b.username,
        "🤖 Remote ON — message @" + b.username + " in Telegram to work in this browser (keep this panel open). /chats switches chats, /stop stops a task.");
    } catch (e) {
      if (signal.aborted || bot !== b) return;
      return R().fail(e.code === 401 || e.code === 404 ? "Telegram rejected the bot token — check it in the settings." : "Can't reach Telegram (" + e.message + ").");
    }

    var conflictShown = false;
    while (!signal.aborted && bot === b) {
      var updates;
      try {
        updates = await api("getUpdates", { offset: b.offset, timeout: 50, allowed_updates: ["message", "callback_query"] }, signal);
      } catch (e) {
        if (signal.aborted || bot !== b) return;
        if (e.code === 401 || e.code === 404) return R().fail("Telegram rejected the bot token — check it in the settings.");
        if (e.code === 409) {
          // Someone else polls this bot (VS Code's bot, a server) — Telegram allows one.
          if (!conflictShown) R().status("error", "Another program is using this bot (VS Code's Telegram bot?) — use a separate bot");
          conflictShown = true;
        }
        await sleep(5000);
        continue;
      }
      if (conflictShown) {
        conflictShown = false;
        R().status("on", "Telegram bot @" + b.username);
      }
      for (var i = 0; i < updates.length; i++) {
        b.offset = updates[i].update_id + 1;
        try {
          handle(updates[i]);
        } catch (e) {
          console.warn("[telegram] update failed:", e);
        }
      }
    }
  }

  // ── Incoming updates ───────────────────────────────────────────────────

  function owner(from, chat) {
    // The owner, in their private chat with the bot — never a group.
    return !!from && String(from.id) === bot.userId && (!chat || String(chat.id) === bot.userId);
  }

  function handle(u) {
    if (u.message) {
      var m = u.message;
      if (!owner(m.from, m.chat)) return;
      var text = (m.text || "").trim();
      if (!text) return say("Send the task as text — photos and files aren't supported here.").catch(noop);
      if (text.charAt(0) === "/") return command(text);
      if (question) return answerQuestion(text);
      return prompt(text);
    }
    if (u.callback_query) {
      var q = u.callback_query;
      api("answerCallbackQuery", { callback_query_id: q.id }).catch(noop);
      if (!owner(q.from)) return;
      onButton(String(q.data || ""), q.message && q.message.message_id);
    }
  }

  function helpText() {
    var st = R().state();
    return "🤖 Agent Browser — your browser agent.\n" +
      "Write a task and it is done in the browser (the side panel must stay open).\n\n" +
      "Now: " + (st.activeChatId ? chatTitle(st.activeChatId) : "new chat") + "\n" +
      "/chats — switch chat\n/new — start a new chat\n/stop — stop the running task";
  }

  function command(text) {
    var cmd = text.split(/\s+/)[0].split("@")[0].toLowerCase();
    var st = R().state();
    if (cmd === "/chats") {
      if (!st.chats.length) return say("No chats yet — just send a task.").catch(noop);
      var rows = st.chats.slice(0, 30).map(function (c) {
        return [{ text: (c.id === st.activeChatId ? "• " : "") + c.title.slice(0, 48), callback_data: "c:" + c.id }];
      });
      return say("Pick a chat:", { inline_keyboard: rows }).catch(noop);
    }
    if (cmd === "/new") {
      if (st.activeChatId && st.running[st.activeChatId]) return say("⏳ A task is still running — /stop it first.").catch(noop);
      R().toHost({ type: "newChat" });
      return say("🆕 New chat — send your first task.").catch(noop);
    }
    if (cmd === "/stop") {
      if (!st.activeChatId || !st.running[st.activeChatId]) return say("Nothing is running.").catch(noop);
      R().toHost({ type: "interrupt" });
      return say("■ Stopping…").catch(noop);
    }
    return say(helpText()).catch(noop);
  }

  function onButton(data, messageId) {
    if (data.indexOf("c:") === 0) {
      var id = data.slice(2);
      var st = R().state();
      if (st.activeChatId && st.running[st.activeChatId] && st.activeChatId !== id) {
        return say("⏳ A task is still running — /stop it before switching.").catch(noop);
      }
      R().toHost({ type: "openConversation", id: id });
      var text = "💬 " + chatTitle(id) + " — send a message to continue it.";
      return (messageId ? edit(messageId, text) : say(text)).catch(noop);
    }
    if (data.indexOf("a:") === 0) {
      // a:<1|0>:<approval id>
      R().toHost({ type: "approvalResponse", id: data.slice(4), approved: data.charAt(2) === "1" });
      return;
    }
    if (data.indexOf("q:") === 0 && question) {
      // q:<option index>:<question id>
      var rest = data.slice(2);
      var sep = rest.indexOf(":");
      if (rest.slice(sep + 1) !== question.id) return;
      var q = question.questions[0] || {};
      var opt = (q.options || [])[Number(rest.slice(0, sep))];
      if (opt) answerQuestion(String(opt.label));
    }
  }

  // ── Running a task ─────────────────────────────────────────────────────

  function prompt(text) {
    var st = R().state();
    if (st.activeChatId && st.running[st.activeChatId]) {
      return say("⏳ Still working on the last task — wait for the reply or send /stop.").catch(noop);
    }
    turn = { text: "", status: "", msgId: null, timer: null, lastEdit: 0, chain: Promise.resolve() };
    // The panel shows the message like any mirrored one, then the host runs it.
    R().local({ type: "user", text: text });
    R().toHost({ type: "prompt", text: text, attachments: [] });
    api("sendChatAction", { chat_id: bot.userId, action: "typing" }).catch(noop);
  }

  // All Telegram calls of a turn run in order (the first send must finish
  // before an edit can name its message).
  function queue(t, fn) {
    t.chain = t.chain.then(fn).catch(function (e) { console.warn("[telegram]", e && e.message); });
    return t.chain;
  }

  function liveText(t) {
    var body = t.text.trim();
    if (body.length > MAX_LEN - 200) body = "…" + body.slice(-(MAX_LEN - 200));
    return (body ? body + "\n\n" : "") + (t.status || "⏳ working…");
  }

  function scheduleRefresh() {
    var t = turn;
    if (!t || t.timer) return;
    t.timer = setTimeout(function () {
      t.timer = null;
      if (turn !== t) return;
      t.lastEdit = Date.now();
      var text = liveText(t);
      queue(t, function () {
        if (t.msgId) return edit(t.msgId, text);
        return say(text).then(function (msg) { t.msgId = msg.message_id; });
      });
    }, Math.max(0, EDIT_EVERY_MS - (Date.now() - t.lastEdit)));
  }

  function finish(extra) {
    var t = turn;
    if (!t) return;
    turn = null;
    if (t.timer) clearTimeout(t.timer);
    var body = t.text.trim();
    var text = body && extra ? body + "\n\n" + extra : body || extra || "✓ Done.";
    var parts = split(text);
    queue(t, async function () {
      if (t.msgId) await edit(t.msgId, parts[0]);
      else await say(parts[0]);
      for (var i = 1; i < parts.length; i++) await say(parts[i]);
    });
  }

  function askApproval(d) {
    var what = describe(d.toolName, d.input);
    var text = "🔐 Allow: " + shortTool(d.toolName) + (what ? " — " + what : "") + "?";
    var markup = { inline_keyboard: [[
      { text: "✅ Allow", callback_data: "a:1:" + d.id },
      { text: "✖ Deny", callback_data: "a:0:" + d.id },
    ]] };
    var id = d.id;
    say(text, markup).then(function (msg) { approvals[id] = { msgId: msg.message_id, text: text }; }).catch(noop);
  }

  function approvalResolved(d) {
    var a = approvals[d.id];
    if (!a) return;
    delete approvals[d.id];
    edit(a.msgId, a.text + "\n" + (d.approved ? "✅ Allowed" : "✖ Denied")).catch(noop);
  }

  function askQuestion(d) {
    var qs = Array.isArray(d.questions) ? d.questions : [];
    var lines = qs.map(function (q, i) {
      var opts = (q.options || []).map(function (o, j) { return "  " + (j + 1) + ". " + o.label; }).join("\n");
      return (qs.length > 1 ? i + 1 + ") " : "") + (q.question || q.header || "") + (opts ? "\n" + opts : "");
    });
    var buttons = qs.length === 1 && !qs[0].multiSelect && (qs[0].options || []).length;
    var markup = buttons
      ? { inline_keyboard: qs[0].options.slice(0, 10).map(function (o, j) {
          return [{ text: String(o.label).slice(0, 60), callback_data: "q:" + j + ":" + d.id }];
        }) }
      : undefined;
    question = { id: d.id, questions: qs, msgId: null };
    var q = question;
    say("❓ " + lines.join("\n\n") + "\n\n" + (buttons ? "Tap an option or reply with your own answer." : "Reply with your answer."), markup)
      .then(function (msg) { q.msgId = msg.message_id; })
      .catch(noop);
  }

  function answerQuestion(text) {
    var q = question;
    question = null;
    // Same shape the panel sends: "<header or question>: <answer>" per question.
    var answer = q.questions.length === 1
      ? (q.questions[0].header || q.questions[0].question || "Answer") + ": " + text
      : text;
    R().toHost({ type: "questionResponse", id: q.id, answer: answer });
  }

  function questionResolved(d) {
    if (question && question.id === d.id) question = null; // answered in the panel
  }

  // ── What the host shows in the panel → Telegram (for tasks sent from there) ─

  window.addEventListener("message", function (ev) {
    var d = ev.data;
    if (!bot || !d || typeof d.type !== "string" || d.__local) return;
    switch (d.type) {
      case "text":
        if (turn && typeof d.text === "string") {
          turn.text += d.text;
          scheduleRefresh();
        }
        break;
      case "tool":
        if (turn) {
          var what = describe(d.name, d.input);
          turn.status = "🔧 " + shortTool(d.name) + (what ? " — " + what.slice(0, 80) : "") + "…";
          scheduleRefresh();
        }
        break;
      case "approval":
        if (turn) askApproval(d);
        break;
      case "approvalResolved":
        approvalResolved(d);
        break;
      case "question":
        if (turn) askQuestion(d);
        break;
      case "questionResolved":
        questionResolved(d);
        break;
      case "notice":
        if (turn) say("⚠ " + d.message).catch(noop);
        break;
      case "error":
        if (turn) finish("⚠ " + d.message);
        break;
      case "result":
      case "idle":
        finish();
        break;
    }
  });

  window.AgentTelegram = { start: start, stop: stop };
})();
