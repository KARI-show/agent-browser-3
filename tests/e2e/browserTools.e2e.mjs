// End-to-end test of every browser tool against a real Chromium.
//
// The unpacked extension (dist-browser/extension) is loaded into headless
// Chromium; its side panel page is opened as a background tab in the same
// window as a fixture page (so "current window / active tab" means the same
// thing it does for the real side panel), and each tool is invoked exactly the
// way shim.js / the built-in agent do it: window.AgentBrowserTools.run(name, args).
// Results are checked against the page itself through a separate CDP session,
// not only against the tool's own report.
//
// Run: npm run test:e2e   (builds first; set CHROME_PATH if Chromium isn't found)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, extensionIdFromKey, findChromium } from "./cdp.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(dirname(here));
const EXT_DIR = join(root, "dist-browser", "extension");
const skip = !findChromium()
  ? "no Chromium found (set CHROME_PATH)"
  : !existsSync(join(EXT_DIR, "manifest.json"))
    ? "extension not built (npm run build && npm run build:browser)"
    : false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Fixture server ─────────────────────────────────────────────────────────
// Pages are served on http://localhost:PORT; the iframe comes from
// http://127.0.0.1:PORT so it is cross-origin (and an out-of-process frame).

const SAMPLE_TEXT = "test resource content — ".repeat(4);
const uaLog = []; // User-Agent header of every page request
let server, PORT, BASE, FRAME_ORIGIN;

function fixture(name) {
  return readFileSync(join(here, "fixtures", name), "utf8")
    .replace("{{FRAME_ORIGIN}}", FRAME_ORIGIN)
    .replace("{{PAYLOAD}}", Buffer.from(SAMPLE_TEXT).toString("base64"));
}

function startServer() {
  server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    uaLog.push({ path: url.pathname, ua: req.headers["user-agent"] || "" });
    const html = (body) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(body);
    };
    if (url.pathname === "/" || url.pathname === "/main.html") return html(fixture("main.html"));
    if (url.pathname === "/page2.html") return html(fixture("page2.html"));
    if (url.pathname === "/frame.html") return html(fixture("frame.html"));
    if (url.pathname === "/search") {
      const q = url.searchParams.get("q") || "";
      return html(`<!doctype html><title>Search</title><p id="r">Results for ${q.replace(/[<&]/g, "")}</p>`);
    }
    if (url.pathname === "/file.txt") {
      res.writeHead(200, { "content-type": "text/plain", "content-disposition": 'attachment; filename="file.txt"' });
      return res.end("downloaded file body");
    }
    res.writeHead(404);
    res.end("not found");
  });
  return new Promise((r) =>
    server.listen(0, "127.0.0.1", () => {
      PORT = server.address().port;
      BASE = `http://localhost:${PORT}`;
      FRAME_ORIGIN = `http://127.0.0.1:${PORT}`;
      r();
    })
  );
}

// ── Browser + panel harness ────────────────────────────────────────────────

let browser, cdp, extId, panel, workDir, downloadDir;
let mainTarget, mainTabId, panelTabId;
const pageSessions = new Map(); // targetId -> sessionId
const panelErrors = []; // uncaught exceptions / unhandled rejections in the panel
const exercised = new Set();

async function waitUntil(fn, timeout = 10000, what = "condition") {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Evaluate in the side panel page (where the tools live). */
function inPanel(expr, timeout = 60000) {
  return Promise.race([
    cdp.evaluate(panel, expr),
    sleep(timeout).then(() => {
      throw new Error(`panel evaluation timed out: ${expr.slice(0, 80)}`);
    }),
  ]);
}

/** Call a tool like shim.js does. → { ok, text, content, error } */
async function call(name, args = {}, timeout = 60000) {
  exercised.add(name);
  const r = await inPanel(
    `AgentBrowserTools.run(${JSON.stringify(name)}, ${JSON.stringify(args)}).then(
      (c) => ({ ok: true, content: c }),
      (e) => ({ ok: false, error: String((e && e.message) || e) }))`,
    timeout
  );
  r.text = r.ok ? r.content.filter((p) => p.type === "text").map((p) => p.text).join("\n") : "";
  return r;
}

async function ok(name, args) {
  const r = await call(name, args);
  assert.ok(r.ok, `${name} failed: ${r.error}`);
  return r.text;
}

async function fails(name, args) {
  const r = await call(name, args);
  assert.ok(!r.ok, `${name} should have failed but returned: ${r.text}`);
  return r.error;
}

/** Evaluate in a page target (the oracle — independent of the tools). */
async function inPage(targetId, expr) {
  let s = pageSessions.get(targetId);
  if (!s) {
    s = await cdp.attach(targetId);
    pageSessions.set(targetId, s);
  }
  return cdp.evaluate(s, expr);
}
const inMain = (expr) => inPage(mainTarget, expr);

/** Ref number of the first read_page line matching `re`. */
function refOf(snapshot, re) {
  const line = snapshot.split("\n").find((l) => /^\[\d+\]/.test(l) && re.test(l));
  assert.ok(line, `no element matching ${re} in snapshot:\n${snapshot.slice(0, 3000)}`);
  return Number(/^\[(\d+)\]/.exec(line)[1]);
}

/** Put the main tab back on a fresh main.html and make it the agent's tab. */
async function resetMain(path = "/main.html") {
  await inPanel(
    `chrome.tabs.update(${mainTabId}, { url: ${JSON.stringify(BASE + path)}, active: true }).then(() => true)`
  );
  await waitUntil(
    () => inPanel(`chrome.tabs.get(${mainTabId}).then((t) => t.status === "complete" && t.url.includes(${JSON.stringify(path)}))`),
    15000,
    "main tab load"
  );
  await ok("browser_switch_tab", { tabId: mainTabId });
}

async function read() {
  return ok("browser_read_page", {});
}

function downloaded(name) {
  return waitUntil(
    () => {
      const f = readdirSync(downloadDir).find((n) => n === name);
      if (!f) return false;
      const p = join(downloadDir, f);
      return statSync(p).size > 0 ? p : false;
    },
    15000,
    `download ${name}`
  );
}

// Tiny 2x2 PNG (red) for the image converter.
const PNG_2x2 =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGP4z8DwnwGMgRQAH+4D/dJQfRoAAAAASUVORK5CYII=";

before(async () => {
  if (skip) return;
  await startServer();
  workDir = mkdtempSync(join(tmpdir(), "agent-browser-e2e-"));
  downloadDir = join(workDir, "downloads");
  browser = await launch({ extensionDir: EXT_DIR, userDataDir: join(workDir, "profile"), downloadDir });
  cdp = browser.cdp;
  extId = extensionIdFromKey(JSON.parse(readFileSync(join(EXT_DIR, "manifest.json"), "utf8")).key);

  // "Allow in Incognito" (needed by the private-window / profile tools), the
  // same switch a user flips at chrome://extensions. It reloads the extension.
  const { targetId: extPage } = await cdp.send("Target.createTarget", { url: "chrome://extensions" });
  const s = await cdp.attach(extPage);
  await waitUntil(() => cdp.evaluate(s, "!!(window.chrome && chrome.developerPrivate)"), 10000, "chrome://extensions");
  // Without developer mode the reload disables a --load-extension extension.
  await cdp.evaluate(s, "chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true })");
  await cdp.evaluate(s, `chrome.developerPrivate.updateExtensionConfiguration({ extensionId: "${extId}", incognitoAccess: true })`);
  await waitUntil(
    () => cdp.evaluate(s, `chrome.developerPrivate.getExtensionInfo("${extId}").then((i) => i.state === "ENABLED" && i.incognitoAccess.isActive)`),
    10000,
    "extension re-enabled with incognito access"
  );
  await cdp.send("Target.closeTarget", { targetId: extPage });

  // Panel first (it becomes a background tab), then the page the agent works on.
  const { targetId: panelTarget } = await cdp.send("Target.createTarget", { url: `chrome-extension://${extId}/sidepanel.html` });
  panel = await cdp.attach(panelTarget);
  cdp.on((m) => {
    if (m.sessionId === panel && m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      panelErrors.push((d.exception && d.exception.description) || d.text);
    }
  });
  await cdp.send("Runtime.enable", {}, panel);
  await waitUntil(() => cdp.evaluate(panel, "typeof AgentBrowserTools === 'object' && typeof AgentConverter === 'object'"), 10000, "panel scripts");

  ({ targetId: mainTarget } = await cdp.send("Target.createTarget", { url: `${BASE}/main.html` }));
  await waitUntil(() => inMain("document.readyState === 'complete'"), 10000, "main page");
  mainTabId = await inPanel(`chrome.tabs.query({ url: "${BASE}/*" }).then((t) => t[0].id)`);
  panelTabId = await inPanel(`chrome.tabs.getCurrent().then((t) => t.id)`);
  await ok("browser_switch_tab", { tabId: mainTabId });
});

after(async () => {
  if (browser) await browser.close();
  if (server) server.close();
  if (workDir) rmSync(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

// ── Reading ────────────────────────────────────────────────────────────────

test("browser_read_page: outline, refs, form state, shadow DOM, cross-origin iframe, page text", { skip }, async () => {
  await resetMain();
  await inMain(`document.getElementById("pw").value = "hunter2"`);
  const s = await read();
  assert.match(s, new RegExp(`^URL: ${BASE}/main.html`));
  assert.match(s, /Title: Fixture Main/);
  assert.match(s, /Outline:\n# Fixture Main/);
  assert.match(s, /\] button "Increment"/);
  assert.match(s, /\] input:text "Search query" placeholder="Type here"/);
  assert.match(s, /\] select "Color" selected="Red" options: Red \| Green \| Blue/);
  assert.match(s, /\] input:password "Password" value=\(hidden\)/);
  assert.doesNotMatch(s, /hunter2/, "password value must never reach the model");
  assert.match(s, /\] input:checkbox "Agree" unchecked/);
  assert.match(s, /\] file input "Attachment"/);
  assert.match(s, /\] editable "Rich editor"/);
  assert.match(s, /\] link "Go to page two" → \/page2\.html/);
  assert.match(s, /\] button "Shadow button"/, "open shadow roots are walked");
  assert.match(s, /\] button "Frame button" ⧉ frame 127\.0\.0\.1/, "cross-origin iframe elements are listed");
  assert.match(s, /--- iframe 127\.0\.0\.1:\d+ ---\nFrame button Frame clicks: 0/);
  assert.match(s, /Page text:\nFixture Main\n\nidle/);
  assert.doesNotMatch(s, /Secret item/, "hover-only menu is hidden until hovered");
});

test("browser_read_page: maxChars budgets the page text", { skip }, async () => {
  const s = await ok("browser_read_page", { maxChars: 500 });
  assert.match(s, /… \(truncated — scroll or use browser_find\)/);
});

test("browser_find: elements and text across shadow DOM and frames", { skip }, async () => {
  const hit = await ok("browser_find", { query: "shadow button" });
  assert.match(hit, /Matching elements:\n\[\d+\] button "Shadow button"/);
  const frame = await ok("browser_find", { query: "frame clicks" });
  assert.match(frame, /Matching page text:\nFrame button Frame clicks: 0/);
  const none = await ok("browser_find", { query: "zzz-no-such-text" });
  assert.match(none, /^Nothing on the page matches/);
  assert.match(await fails("browser_find", { query: "" }), /query is required/);
});

test("browser_screenshot: JPEG of the visible tab + caption", { skip }, async () => {
  const r = await call("browser_screenshot", {});
  assert.ok(r.ok, r.error);
  const [img, caption] = r.content;
  assert.equal(img.type, "image");
  assert.equal(img.mimeType, "image/jpeg");
  const bytes = Buffer.from(img.data, "base64");
  assert.equal(bytes.readUInt16BE(0), 0xffd8, "JPEG magic");
  assert.ok(bytes.length > 2000, "not an empty image");
  assert.match(caption.text, new RegExp(`Fixture Main — ${BASE}/main.html`));
});

test("browser_tabs: lists the window's tabs and stars the current one", { skip }, async () => {
  const t = await ok("browser_tabs", {});
  assert.match(t, new RegExp(`^\\* ${mainTabId}  Fixture Main — ${BASE}/main.html$`, "m"));
  assert.match(t, new RegExp(`^  ${panelTabId}  `, "m"));
});

test("browser_extract_table: rows and cells", { skip }, async () => {
  const t = await ok("browser_extract_table", {});
  assert.equal(t, "Table (3 rows):\nName | Age\nAnn | 31\nBob | 42");
  assert.equal(await ok("browser_extract_table", { selector: "#t" }), t);
  assert.match(await fails("browser_extract_table", { selector: "#nope" }), /No table found matching #nope/);
});

// ── Clicking ───────────────────────────────────────────────────────────────

test("browser_click: plain button changes the page", { skip }, async () => {
  await resetMain();
  const s = await read();
  const out = await ok("browser_click", { ref: refOf(s, /button "Increment"/) });
  assert.match(out, /^Clicked \[\d+\]\. Now at: Fixture Main/);
  assert.equal(await inMain("count.textContent"), "1");
});

test("browser_click: covered element is refused, force=true clicks through", { skip }, async () => {
  const s = await read();
  const ref = refOf(s, /button "Covered button"/);
  assert.match(await fails("browser_click", { ref }), /is covered by div#overlay "overlay"/);
  assert.equal(await inMain("coveredstatus.textContent"), "");
  await ok("browser_click", { ref, force: true });
  assert.equal(await inMain("coveredstatus.textContent"), "covered-clicked");
});

test("browser_click: double=true fires dblclick", { skip }, async () => {
  const s = await read();
  await ok("browser_click", { ref: refOf(s, /button "Double me"/), double: true });
  assert.equal(await inMain("dblstatus.textContent"), "double-clicked");
});

test("browser_click: button inside a shadow root", { skip }, async () => {
  const s = await read();
  const out = await ok("browser_click", { ref: refOf(s, /button "Shadow button"/) });
  assert.doesNotMatch(out, /no visible reaction/);
  assert.equal(await inMain(`document.querySelector("shadow-box").shadowRoot.getElementById("sc").textContent`), "1");
});

test("browser_click: button inside a cross-origin iframe", { skip }, async () => {
  const s = await read();
  await ok("browser_click", { ref: refOf(s, /button "Frame button" ⧉ frame/) });
  assert.match(await read(), /--- iframe 127\.0\.0\.1:\d+ ---\nFrame button Frame clicks: 1/);
});

test("browser_click: refs from a replaced document are reported stale", { skip }, async () => {
  await resetMain();
  const s = await read();
  await resetMain("/page2.html");
  assert.match(await fails("browser_click", { ref: refOf(s, /button "Increment"/) }), /That element is gone — the page changed/);
  assert.match(await fails("browser_click", { ref: 9999 }), /No element \[9999\]/);
});

// Regression: pageClick's injected promise settles ~510 ms after the click, so
// when the navigation commits first, its executeScript never settles; act()
// now races the call against a navigation signal and returns instead of hanging
// to the host's 60 s tool timeout.
test("browser_click: a link that navigates quickly returns", { skip }, async () => {
  await resetMain();
  const s = await read();
  const r = await call("browser_click", { ref: refOf(s, /link "Go to page two"/) }, 15000).catch(() => null);
  assert.equal(await inMain("document.title"), "Page Two", "the click itself worked");
  assert.ok(r, "browser_click did not return within 15 s");
  assert.match(r.text, /page changed.*Now at: Page Two/s);
});

// Regression: the synthetic el.click() opens the tab, but target=_blank implies
// noopener so it carries no openerTabId; browser_click now spots the new tab by
// diffing tab ids before the real-mouse retry, so it opens exactly once and
// follows it.
test("browser_click: target=_blank opens one tab and follows it", { skip }, async () => {
  await resetMain();
  const s = await read();
  const countBlank = () => inPanel(`chrome.tabs.query({ url: "${BASE}/page2.html?blank=1" }).then((t) => t.map((x) => x.id))`);
  try {
    const out = await ok("browser_click", { ref: refOf(s, /link "Open in new tab"/) });
    assert.equal((await countBlank()).length, 1, "exactly one new tab");
    assert.match(out, /opened a new tab, now working there\. Now at: Page Two — .*blank=1/);
  } finally {
    await inPanel(`chrome.tabs.remove(${JSON.stringify(await countBlank())}).then(() => true)`);
  }
});

// ── Typing & forms ─────────────────────────────────────────────────────────

test("browser_type: replace, append, textarea, contenteditable, password", { skip }, async () => {
  await resetMain();
  const s = await read();
  const q = refOf(s, /"Search query"/);
  assert.equal(await ok("browser_type", { ref: q, text: "hello" }), `Typed into [${q}].`);
  assert.equal(await inMain("q.value"), "hello");
  await ok("browser_type", { ref: q, text: " world", clear: false });
  assert.equal(await inMain("q.value"), "hello world");
  await ok("browser_type", { ref: q, text: "replaced" });
  assert.equal(await inMain("q.value"), "replaced");

  await ok("browser_type", { ref: refOf(s, /textarea "Bio"/), text: "line one\nline two" });
  assert.equal(await inMain("bio.value"), "line one\nline two");

  await ok("browser_type", { ref: refOf(s, /editable "Rich editor"/), text: "rich text" });
  assert.equal(await inMain("editor.innerText.trim()"), "rich text");

  await ok("browser_type", { ref: refOf(s, /input:password/), text: "s3cret" });
  assert.equal(await inMain("pw.value"), "s3cret");
});

test("browser_type: wrong targets are refused", { skip }, async () => {
  const s = await read();
  assert.match(await fails("browser_type", { ref: refOf(s, /button "Increment"/), text: "x" }), /is not a text field/);
  assert.match(await fails("browser_type", { ref: refOf(s, /file input/), text: "x" }), /is a file input — use browser_upload_file/);
});

test("browser_type: submit=true submits the form", { skip }, async () => {
  const s = await read();
  const out = await ok("browser_type", { ref: refOf(s, /"Search query"/), text: "kittens", submit: true });
  assert.match(out, /and pressed Enter\. Now at: Search — .*\/search\?q=kittens/);
  assert.equal(await inMain("r.textContent"), "Results for kittens");
});

test("browser_select: by visible text and by value; bad option and non-select refused", { skip }, async () => {
  await resetMain();
  const s = await read();
  const color = refOf(s, /select "Color"/);
  assert.equal(await ok("browser_select", { ref: color, option: "Green" }), `Selected "Green" in [${color}].`);
  assert.equal(await inMain("color.value"), "g");
  await ok("browser_select", { ref: color, option: "b" });
  assert.equal(await inMain("color.value"), "b");
  assert.match(await fails("browser_select", { ref: color, option: "Purple" }), /No option matching "Purple" \(options: Red \| Green \| Blue\)/);
  assert.match(await fails("browser_select", { ref: refOf(s, /"Search query"/), option: "x" }), /is not a <select>/);
});

test("browser_fill_form: array and object forms; unknown refs reported", { skip }, async () => {
  await resetMain();
  const s = await read();
  const q = refOf(s, /"Search query"/);
  const email = refOf(s, /input:email/);
  const out = await ok("browser_fill_form", { fields: [{ ref: q, value: "alpha" }, { ref: email, value: "a@b.co" }, { ref: 999, value: "x" }] });
  assert.equal(out, `Form fill results:\n[${q}]: ok\n[${email}]: ok\n[999]: not found`);
  assert.equal(await inMain("q.value"), "alpha");
  assert.equal(await inMain("email.value"), "a@b.co");
  await ok("browser_fill_form", { fields: { [q]: "beta", [email]: "c@d.co" } });
  assert.equal(await inMain("q.value + '|' + email.value"), "beta|c@d.co");
  assert.match(await fails("browser_fill_form", {}), /fields is required/);
});

test("browser_press_key: characters, Backspace, Enter submits, clipboard refused", { skip }, async () => {
  await resetMain();
  const s = await read();
  const q = refOf(s, /"Search query"/);
  await ok("browser_click", { ref: q });
  await ok("browser_press_key", { key: "a" });
  await ok("browser_press_key", { key: "b" });
  assert.equal(await inMain("q.value"), "ab");
  await ok("browser_press_key", { key: "Backspace" });
  assert.equal(await inMain("q.value"), "a");
  await ok("browser_press_key", { key: "Control+A" });
  await ok("browser_press_key", { key: "Delete" });
  assert.equal(await inMain("q.value"), "");
  assert.match(await fails("browser_press_key", { key: "Control+V" }), /Clipboard shortcuts/);
  assert.match(await fails("browser_press_key", { key: "F13" }), /Unsupported key: F13/);
  await ok("browser_type", { ref: q, text: "via-enter" });
  const out = await ok("browser_press_key", { key: "Enter" });
  assert.match(out, /^Pressed Enter\. Now at: Search/);
});

test("browser_upload_file: puts the bytes into a file input", { skip }, async () => {
  await resetMain();
  const s = await read();
  const up = refOf(s, /file input "Attachment"/);
  const out = await ok("browser_upload_file", { ref: up, name: "hello.txt", data: Buffer.from("hi there").toString("base64") });
  assert.equal(out, `Attached "hello.txt" to [${up}].`);
  const got = await waitUntil(() => inMain("window.__upload"), 3000, "change event");
  assert.deepEqual(got, { name: "hello.txt", type: "text/plain", size: 8, text: "hi there" });
  assert.match(
    await fails("browser_upload_file", { ref: refOf(s, /"Search query"/), name: "a.txt", data: "" }),
    /is not a file input/
  );
});

// ── Pointer ────────────────────────────────────────────────────────────────

test("browser_hover: real pointer opens a CSS :hover menu", { skip }, async () => {
  await resetMain();
  const s = await read();
  const out = await ok("browser_hover", { ref: refOf(s, /button "Menu"/) });
  assert.match(out, /^Hovering over \[\d+\]/);
  assert.equal(await inMain(`getComputedStyle(document.querySelector("#menu .sub")).display`), "block");
  assert.match(await read(), /link "Secret item"/);
});

test("browser_drag: onto a drop zone by text and by ref", { skip }, async () => {
  await resetMain();
  let s = await read();
  const out = await ok("browser_drag", { fromRef: refOf(s, /"Drag me"/), toText: "Drop zone" });
  assert.match(out, /Dragged \[\d+\] onto "Drop zone"/);
  assert.deepEqual(await inMain("window.__drops"), ["drop"]);
  s = await read();
  await ok("browser_drag", { fromRef: refOf(s, /"Drag me"/), toRef: refOf(s, /"Zone B"/) });
  assert.deepEqual(await inMain("window.__drops"), ["drop", "zone-b"]);
  assert.match(await fails("browser_drag", { fromRef: refOf(s, /"Drag me"/) }), /Give toRef, or toText/);
});

test("browser_scroll: down, bottom, top, element into view", { skip }, async () => {
  await resetMain();
  const down = await ok("browser_scroll", { direction: "down" });
  // Not an exact match: the "started debugging" bar coming and going resizes
  // the viewport, and scroll anchoring then nudges scrollY by a few pixels.
  assert.match(down, /^Scrolled — y=[1-9]\d* of \d+\.$/);
  assert.ok((await inMain("scrollY")) > 0, "scrolled down");
  await ok("browser_scroll", { direction: "bottom" });
  assert.equal(await inMain("Math.round(scrollY) === document.documentElement.scrollHeight - innerHeight"), true);
  await ok("browser_scroll", { direction: "up" });
  await ok("browser_scroll", { direction: "top" });
  assert.equal(await inMain("scrollY"), 0);
  const s = await read();
  await ok("browser_scroll", { ref: refOf(s, /button "Load later"/) });
  assert.equal(await inMain(`(() => { const r = later.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })()`), true);
});

// ── Waiting ────────────────────────────────────────────────────────────────

test("browser_wait: sleeps and reports the page", { skip }, async () => {
  await resetMain();
  const t0 = Date.now();
  assert.match(await ok("browser_wait", { seconds: 0.5 }), /^Now at: Fixture Main/);
  assert.ok(Date.now() - t0 >= 500);
});

test("browser_wait_for: text appears, text disappears, URL, timeout", { skip }, async () => {
  await resetMain();
  const s = await read();
  assert.match(await fails("browser_wait_for", {}), /Give text, textGone or urlContains/);
  await ok("browser_click", { ref: refOf(s, /button "Load later"/) });
  assert.match(await ok("browser_wait_for", { text: "Loaded later", timeoutSeconds: 5 }), /^Condition met\./);
  assert.match(await ok("browser_wait_for", { textGone: "Loading…", timeoutSeconds: 5 }), /^Condition met\./);
  assert.match(await ok("browser_wait_for", { urlContains: "main.html" }), /^Condition met\./);
  assert.match(await ok("browser_wait_for", { text: "Frame clicks" }), /^Condition met\./, "any frame counts");
  const t0 = Date.now();
  assert.match(await ok("browser_wait_for", { text: "never-appears", timeoutSeconds: 1 }), /^Timed out/);
  assert.ok(Date.now() - t0 < 4000);
});

// ── Navigation & tabs ──────────────────────────────────────────────────────

test("browser_navigate: url, back, forward, reload; non-web schemes refused", { skip }, async () => {
  await resetMain();
  assert.match(await ok("browser_navigate", { url: `${BASE}/page2.html` }), /^Now at: Page Two/);
  assert.match(await ok("browser_navigate", { action: "back" }), /^Now at: Fixture Main/);
  assert.match(await ok("browser_navigate", { action: "forward" }), /^Now at: Page Two/);
  await inMain("window.__marker = 1");
  assert.match(await ok("browser_navigate", { action: "reload" }), /^Now at: Page Two/);
  assert.equal(await inMain("window.__marker"), undefined, "page really reloaded");
  for (const url of ["file:///etc/passwd", "javascript:alert(1)", `chrome-extension://${extId}/options.html`, "data:text/html,hi"]) {
    assert.match(await fails("browser_navigate", { url }), /Only http\(s\) addresses can be opened/, url);
  }
  assert.match(await fails("browser_navigate", {}), /url is required/);
});

test("browser_new_tab / browser_switch_tab / browser_close_tab", { skip }, async () => {
  await resetMain();
  assert.match(await ok("browser_new_tab", { url: `${BASE}/page2.html` }), /^Now at: Page Two/);
  const tabs = await ok("browser_tabs", {});
  const newId = Number(/^\* (\d+)  Page Two/m.exec(tabs)[1]);
  assert.notEqual(newId, mainTabId);

  assert.match(await ok("browser_switch_tab", { tabId: mainTabId }), /^Now at: Fixture Main/);
  assert.match(await ok("browser_tabs", {}), new RegExp(`^\\* ${mainTabId} `, "m"));
  assert.match(await fails("browser_switch_tab", { tabId: panelTabId }), /extension's own page/);

  assert.match(await ok("browser_close_tab", { tabId: newId }), new RegExp(`^Closed tab ${newId}\\. Now at: Fixture Main`));
  assert.doesNotMatch(await ok("browser_tabs", {}), new RegExp(`${newId}  `));

  await ok("browser_new_tab", { url: `${BASE}/page2.html` });
  const out = await ok("browser_close_tab", {});
  assert.match(out, /^Closed tab \d+\. Now at: /, "closing the current tab falls back to the active one");
  assert.match(await fails("browser_new_tab", { url: "file:///etc/passwd" }), /Only http\(s\)/);
});

// ── JavaScript ─────────────────────────────────────────────────────────────

test("browser_run_js: values, promises, errors, page world", { skip }, async () => {
  await resetMain();
  assert.equal(await ok("browser_run_js", { code: "1 + 1" }), "2");
  assert.equal(await ok("browser_run_js", { code: "document.title" }), "Fixture Main");
  assert.equal(await ok("browser_run_js", { code: "Promise.resolve({ a: [1, 2] })" }), '{\n  "a": [\n    1,\n    2\n  ]\n}');
  assert.equal(await ok("browser_run_js", { code: "typeof loadLater" }), "function", "runs in the page's MAIN world");
  assert.match(await fails("browser_run_js", { code: "throw new Error('boom')" }), /boom/);
  assert.match(await fails("browser_run_js", { code: "Promise.reject(new Error('nope'))" }), /Rejected: nope/);
});

// ── Cookies ────────────────────────────────────────────────────────────────

test("browser_cookies_set / get / delete on the current page", { skip }, async () => {
  await resetMain();
  assert.match(await ok("browser_cookies_set", { name: "test", value: "hello123" }), /^Cookie set: test=hello123 on localhost$/);
  assert.match(await inMain("document.cookie"), /(^|; )test=hello123/);

  await ok("browser_cookies_set", { name: "secretish", value: "v", httpOnly: true, maxAgeSec: 3600 });
  assert.doesNotMatch(await inMain("document.cookie"), /secretish/, "httpOnly is really httpOnly");

  const all = await ok("browser_cookies_get", {});
  assert.match(all, /^Cookies \(\d+\):/);
  assert.match(all, /^test=hello123 \| domain=localhost \| path=\/.* \| session$/m);
  assert.match(all, /^secretish=v \| .*httpOnly.* \| expires=/m);
  const one = await ok("browser_cookies_get", { name: "test" });
  assert.match(one, /^Cookies \(1\):\ntest=hello123/);

  assert.equal(await ok("browser_cookies_delete", { name: "test" }), "Deleted cookie: test");
  assert.doesNotMatch(await inMain("document.cookie"), /test=/);
  assert.match(await ok("browser_cookies_get", { name: "test" }), /^No cookies found/);
});

test("browser_cookies_export / import round-trip", { skip }, async () => {
  await resetMain();
  await inMain(`document.cookie = "roundtrip=42; path=/"`);
  const exported = JSON.parse(await ok("browser_cookies_export", {}));
  const rt = exported.find((c) => c.name === "roundtrip");
  assert.deepEqual(
    { name: rt.name, value: rt.value, domain: rt.domain, path: rt.path },
    { name: "roundtrip", value: "42", domain: "localhost", path: "/" }
  );

  // The TESTING.md example: a cookie for another site entirely.
  assert.equal(
    await ok("browser_cookies_import", { cookies: [{ name: "imported", value: "yes", domain: ".example.com", path: "/" }] }),
    "Imported 1 cookies."
  );
  assert.match(await ok("browser_cookies_get", { url: "http://example.com/" }), /imported=yes \| domain=\.example\.com/);
  // String form is accepted too.
  await ok("browser_cookies_import", { cookies: JSON.stringify([{ name: "fromstring", value: "1", domain: "localhost", path: "/" }]) });
  assert.match(await inMain("document.cookie"), /fromstring=1/);
  assert.match(await fails("browser_cookies_import", {}), /cookies array is required/);
});

test("browser_cookies_clear: host-only cookies of the current page", { skip }, async () => {
  await resetMain();
  await inMain(`document.cookie = "c1=1; path=/"; document.cookie = "c2=2; path=/"`);
  assert.match(await ok("browser_cookies_clear", {}), /^Cleared \d+ cookies\.$/);
  assert.equal(await inMain("document.cookie"), "");
});

test("browser_cookies_clear: domain cookies (leading-dot domain)", { skip }, async () => {
  await ok("browser_cookies_import", { cookies: [{ name: "dom1", value: "a", domain: ".example.com", path: "/" }] });
  assert.match(await ok("browser_cookies_get", { url: "http://example.com/" }), /dom1=a/);
  await ok("browser_cookies_clear", { url: "http://example.com/" });
  assert.match(await ok("browser_cookies_get", { url: "http://example.com/" }), /^No cookies found/, "domain cookies must actually be removed");
});

// ── User-Agent ─────────────────────────────────────────────────────────────

const FAKE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AgentE2E/1.0";

test("browser_get_useragent / browser_set_useragent: page and request headers", { skip }, async () => {
  await resetMain();
  const before = await ok("browser_get_useragent", {});
  assert.match(before, /^User-Agent: Mozilla\/5\.0 .*\nPlatform: .*\nLanguage: .*\nLanguages: /);

  const out = await ok("browser_set_useragent", { userAgent: FAKE_UA, platform: "iPhone", language: "de-DE" });
  assert.match(out, /^User-Agent set to: Mozilla\/5\.0 \(iPhone.* \| platform=iPhone$/);
  assert.match(await ok("browser_get_useragent", {}), /User-Agent: .*AgentE2E\/1\.0\nPlatform: iPhone/);

  // As the system prompt says: reload for full effect — the server must see it.
  uaLog.length = 0;
  await ok("browser_navigate", { action: "reload" });
  assert.match(uaLog.find((e) => e.path === "/main.html").ua, /AgentE2E/);
});

// cdp() detaches the debugger after 8 s idle, and Network.setUserAgentOverride
// dies with the session — the header and navigator.userAgent silently revert.
test("browser_set_useragent: override survives a reload 10 s later", { skip, todo: "known: UA override is dropped when the debugger auto-detaches after 8 s (not fixed — persistent UA override is out of scope)" }, async () => {
  await resetMain();
  await ok("browser_set_useragent", { userAgent: FAKE_UA });
  await sleep(10000); // the agent keeps working; the DevTools session idles out after 8 s
  uaLog.length = 0;
  await ok("browser_navigate", { action: "reload" });
  assert.match(uaLog.find((e) => e.path === "/main.html").ua, /AgentE2E/, "request User-Agent after reload");
  assert.match(await ok("browser_get_useragent", {}), /AgentE2E/, "navigator.userAgent after reload");
});

// ── Private windows & profiles ─────────────────────────────────────────────

test("browser_open_private_window: incognito window becomes the current tab", { skip }, async () => {
  await resetMain();
  const out = await ok("browser_open_private_window", { url: `${BASE}/page2.html` });
  assert.match(out, /^Opened a private \(Incognito\) window\. Now at: Page Two/);
  const incognito = await inPanel(`chrome.windows.getAll({ populate: true }).then((ws) => ws.filter((w) => w.incognito).map((w) => w.id))`);
  assert.equal(incognito.length, 1);
  assert.match(await read(), /Title: Page Two/, "tools work inside the private window");
  await ok("browser_close_profile", { windowId: incognito[0] });
});

test("browser_new_profile / list / switch / close", { skip }, async () => {
  await resetMain();
  const out = await ok("browser_new_profile", { url: `${BASE}/page2.html` });
  const winId = Number(/window (\d+)\) opened/.exec(out)[1]);
  assert.match(out, /Now at: Page Two/);

  const list = await ok("browser_list_profiles", {});
  assert.match(list, new RegExp(`^\\[ISOLATED\\] Window ${winId} \\(1 tabs\\)`, "m"));
  assert.match(list, /^\[MAIN\] Window \d+ \(\d+ tabs\)/m);
  assert.doesNotMatch(list, /chrome-extension:/, "the panel itself is not listed");

  await ok("browser_switch_tab", { tabId: mainTabId });
  assert.match(await ok("browser_switch_profile", { windowId: winId }), new RegExp(`^Switched to window ${winId} \\(isolated\\)\\. Now at: Page Two`));
  assert.match(await fails("browser_switch_profile", {}), /windowId is required/);

  assert.equal(await ok("browser_close_profile", { windowId: winId }), `Closed window ${winId} and all its tabs/sessions.`);
  assert.doesNotMatch(await ok("browser_list_profiles", {}), /\[ISOLATED\]/);
  assert.match(await fails("browser_close_profile", {}), /windowId is required/);
});

// Every Incognito window of a Chrome profile shares ONE off-the-record
// session, so "5 accounts in 5 profiles" (tool description, system prompt)
// can't work: account B inherits account A's cookies.
test("browser_new_profile: two profiles don't share cookies (multi-account claim)", { skip, todo: "known: all incognito windows share one cookie jar — real per-account isolation is out of scope" }, async () => {
  await resetMain();
  const a = Number(/window (\d+)\)/.exec(await ok("browser_new_profile", { url: `${BASE}/page2.html` }))[1]);
  await ok("browser_run_js", { code: `document.cookie = "account=A; path=/"` });
  const b = Number(/window (\d+)\)/.exec(await ok("browser_new_profile", { url: `${BASE}/page2.html` }))[1]);
  const seenInB = await ok("browser_run_js", { code: "document.cookie" });
  await ok("browser_close_profile", { windowId: a });
  await ok("browser_close_profile", { windowId: b });
  assert.doesNotMatch(seenInB, /account=A/, "profile B sees profile A's login cookie");
});

// chrome.cookies.* without storeId uses the panel's (regular) cookie store,
// so while the agent works in a private window the cookie tools hit the MAIN
// profile — the opposite of what the isolation tools promise.
test("cookie tools act on the private window's own cookie store", { skip, todo: "known: cookie tools use the main store, not the private window's (tied to the isolation feature, out of scope)" }, async () => {
  await resetMain();
  const win = Number(/window (\d+)\)/.exec(await ok("browser_new_profile", { url: `${BASE}/page2.html` }))[1]);
  await ok("browser_cookies_set", { name: "incog", value: "1" });
  const pageSees = await ok("browser_run_js", { code: "document.cookie" });
  await ok("browser_close_profile", { windowId: win });
  await ok("browser_switch_tab", { tabId: mainTabId });
  const mainSees = await inMain("document.cookie");
  await ok("browser_cookies_delete", { name: "incog" });
  assert.doesNotMatch(mainSees, /incog=1/, "cookie set while working in the private window landed in the main profile");
  assert.match(pageSees, /incog=1/, "…and the private window's page doesn't have it");
});

// ── Files: converter, save, screenshot ─────────────────────────────────────

test("browser_convert: csv→json, json→csv, md→html, table→csv, text→file, image→jpg", { skip }, async () => {
  await resetMain();
  const csvOut = await ok("browser_convert", { from: "csv", to: "json", data: "name,age\nJohn,30\nJane,25", filename: "people.json" });
  assert.match(csvOut, /^Converted and (opened|saved): .*people\.json \(\d+ bytes\) — 2 rows$/);
  assert.deepEqual(JSON.parse(readFileSync(await downloaded("people.json"), "utf8")), [
    { name: "John", age: "30" },
    { name: "Jane", age: "25" },
  ]);

  await ok("browser_convert", { from: "json", to: "csv", data: JSON.stringify([{ a: 1, b: "x,y" }]), filename: "rows.csv" });
  assert.equal(readFileSync(await downloaded("rows.csv"), "utf8"), 'a,b\n1,"x,y"');

  await ok("browser_convert", { from: "md", to: "html", data: "# Hello\n\n**World**", filename: "doc.html" });
  const html = readFileSync(await downloaded("doc.html"), "utf8");
  assert.match(html, /<h1>Hello<\/h1>/);
  assert.match(html, /<strong>World<\/strong>/);

  await ok("browser_convert", { from: "table", to: "csv", data: "<table><tr><th>k</th></tr><tr><td>v</td></tr></table>", filename: "t.csv" });
  assert.equal(readFileSync(await downloaded("t.csv"), "utf8"), "k\nv");

  await ok("browser_convert", { from: "text", to: "txt", data: "plain text", filename: "note.txt" });
  assert.equal(readFileSync(await downloaded("note.txt"), "utf8"), "plain text");

  await ok("browser_convert", { from: "image", to: "jpg", data: PNG_2x2, filename: "pic.jpg" });
  assert.equal(readFileSync(await downloaded("pic.jpg")).readUInt16BE(0), 0xffd8);

  assert.equal(await ok("browser_convert", { from: "csv", to: "json", data: "a\n1", save: false }), '[\n  {\n    "a": "1"\n  }\n]');
  assert.match(await fails("browser_convert", { from: "docx", to: "odt", data: "x" }), /Unknown conversion: docx → odt/);
});

test("browser_convert: md→pdf opens a print view of the markdown", { skip }, async () => {
  await inPanel(`(() => {
    window.__printed = [];
    window.__realOpen = window.open;
    window.open = () => {
      const doc = { html: "", write(s) { this.html += s; }, close() {} };
      return { document: doc, print() { window.__printed.push(doc.html); }, close() {} };
    };
    return true;
  })()`);
  try {
    await ok("browser_convert", { from: "md", to: "pdf", data: "# Printable" });
    const printed = await waitUntil(() => inPanel("window.__printed[0]"), 5000, "print");
    assert.match(printed, /<h1>Printable<\/h1>/);
  } finally {
    await inPanel("window.open = window.__realOpen, true");
  }
});

// Regression: page_to_pdf renders the current tab (not the side panel) to a
// real PDF file via the DevTools protocol, with no manual print dialog.
test("browser_page_to_pdf: saves the current page as a real PDF", { skip }, async () => {
  await resetMain();
  const out = await ok("browser_page_to_pdf", {});
  assert.match(out, /^Saved the page as PDF: .*Fixture_Main\.pdf \(\d+ bytes\)/);
  const pdf = readFileSync(await downloaded("Fixture_Main.pdf"));
  assert.equal(pdf.subarray(0, 5).toString("latin1"), "%PDF-", "a real PDF file");
  assert.ok(pdf.length > 1000, "not an empty PDF");
});

// Regression: chrome.downloads.open needs a user gesture; a tool call never has
// one, so it rejects. The download helper must await that and report "saved"
// (not "opened") instead of leaking an unhandled rejection.
test("browser_convert: reports 'saved' when it can't open without a user gesture", { skip }, async () => {
  const seen = panelErrors.length;
  const out = await ok("browser_convert", { from: "text", to: "txt", data: "open me", filename: "open-me.txt" });
  assert.match(out, /^Converted and saved: /, "no false 'opened' without a gesture");
  assert.equal(readFileSync(await downloaded("open-me.txt"), "utf8"), "open me");
  await sleep(300); // let any stray rejection surface
  assert.deepEqual(panelErrors.slice(seen), [], "downloads.open must not leak a rejection");
});

test("browser_save_page: html / txt / md", { skip }, async () => {
  await resetMain();
  assert.match(await ok("browser_save_page", {}), /^Saved: .*Fixture_Main\.html \(\d+ bytes\)$/);
  assert.match(readFileSync(await downloaded("Fixture_Main.html"), "utf8"), /<title>Fixture Main<\/title>/);
  await ok("browser_save_page", { format: "txt" });
  assert.match(readFileSync(await downloaded("Fixture_Main.txt"), "utf8"), new RegExp(`^URL: ${BASE}/main.html\nTitle: Fixture Main\n\nFixture Main\n`));
  await ok("browser_save_page", { format: "md" });
  assert.match(readFileSync(await downloaded("Fixture_Main.md"), "utf8"), new RegExp(`^# Fixture Main\n\n> Source: ${BASE}/main.html`));
});

test("browser_screenshot_save: png and jpg files", { skip }, async () => {
  await resetMain();
  assert.match(await ok("browser_screenshot_save", { filename: "shot.png" }), /^Screenshot saved: .*shot\.png \(\d+ bytes\)$/);
  assert.equal(readFileSync(await downloaded("shot.png")).readUInt32BE(0), 0x89504e47);
  await ok("browser_screenshot_save", { format: "jpg", filename: "shot.jpg" });
  assert.equal(readFileSync(await downloaded("shot.jpg")).readUInt16BE(0), 0xffd8);
});

// ── Implemented in the panel but not declared to the model ─────────────────

test("undeclared: browser_download_open / browser_cache_extract / browser_network_log", { skip }, async () => {
  await resetMain();
  // "opened" only when downloads.open actually succeeds (no user gesture here).
  assert.match(await ok("browser_download_open", { url: `${BASE}/file.txt` }), /^Downloaded(?: and opened)?: file\.txt \(\d+ bytes\)/);
  assert.equal(readFileSync(await downloaded("file.txt"), "utf8"), "downloaded file body");

  assert.match(await ok("browser_cache_extract", { selector: "#blob", filename: "blob.bin", open: false }), /^Saved: blob\.bin/);
  assert.equal(readFileSync(await downloaded("blob.bin"), "utf8"), SAMPLE_TEXT);

  assert.match(await ok("browser_network_log", { seconds: 1 }), /Use browser_run_js with performance\.getEntriesByType/);
});

// ── Coverage ───────────────────────────────────────────────────────────────

test("every tool declared in browser/host/tools.ts was exercised", { skip }, () => {
  const declared = [...readFileSync(join(root, "browser", "host", "tools.ts"), "utf8").matchAll(/name: "(browser_\w+)"/g)].map((m) => m[1]);
  assert.equal(declared.length, 38);
  assert.deepEqual(declared.filter((n) => !exercised.has(n)), []);
});

test("no uncaught errors in the panel", { skip }, () => {
  assert.deepEqual(panelErrors, []);
});
