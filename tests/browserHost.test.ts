import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeFrames, MAX_FRAME } from "../browser/host/native";
import { ALWAYS_ASK_TOOLS, BROWSER_TOOLS, READ_ONLY_TOOLS, browserToolName } from "../browser/host/tools";
import { FileMemento } from "../browser/host/memento";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_DOCUMENT_BYTES,
  MAX_IMAGE_BYTES,
  ATTACHMENT_TTL_MS,
  attachmentLimit,
  expiredFiles,
  isImageAttachment,
  parseDataUrl,
  pruneAttachments,
  safeAttachmentName,
} from "../browser/host/attachments";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function decode(frame: Buffer): any {
  assert.equal(frame.readUInt32LE(0), frame.length - 4, "length prefix matches body");
  return JSON.parse(frame.subarray(4).toString("utf8"));
}

// Mirrors the reassembly in browser/extension/shim.js.
function reassemble(frames: Buffer[]): any {
  const parts: string[] = [];
  for (const f of frames) {
    const m = decode(f);
    assert.equal(m.type, "__chunk");
    parts[m.i] = m.data;
  }
  return JSON.parse(parts.join(""));
}

test("small messages go out as a single frame", () => {
  const frames = encodeFrames({ type: "text", text: "привет" }, 1);
  assert.equal(frames.length, 1);
  assert.deepEqual(decode(frames[0]), { type: "text", text: "привет" });
});

test("oversized messages are chunked under the 1 MB cap and reassemble exactly", () => {
  // Multi-byte text, emoji (surrogate pairs) and quotes that JSON re-escapes.
  const text = 'Ёж "🦔" \\ '.repeat(120_000);
  const msg = { type: "loadConversation", messages: [{ kind: "assistant", text }] };
  const frames = encodeFrames(msg, 7);
  assert.ok(frames.length > 1);
  for (const f of frames) assert.ok(f.length - 4 <= 1024 * 1024, "every frame fits Chrome's limit");
  assert.ok(frames.every((f) => decode(f).id === 7));
  assert.deepEqual(reassemble(frames), msg);
  assert.ok(MAX_FRAME < 1024 * 1024);
});

test("FileMemento sets a corrupt state file aside and writes owner-only", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memento-"));
  const file = path.join(dir, "state.json");
  fs.writeFileSync(file, "{ not json");
  const m = new FileMemento(file);
  assert.deepEqual(m.keys(), []);
  const aside = fs.readdirSync(dir).filter((f) => f.startsWith("state.json.corrupt-"));
  assert.equal(aside.length, 1, "the unreadable file is kept, not overwritten");
  assert.equal(fs.readFileSync(path.join(dir, aside[0]), "utf8"), "{ not json");

  await m.update("k", { v: 1 });
  assert.deepEqual(new FileMemento(file).get("k"), { v: 1 });
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("browser tool names and read-only set", () => {
  assert.equal(browserToolName("mcp__browser__browser_click"), "browser_click");
  assert.equal(browserToolName("mcp__other__browser_click"), undefined);
  assert.equal(browserToolName("Bash"), undefined);
  for (const t of ["browser_read_page", "browser_screenshot", "browser_tabs"]) assert.ok(READ_ONLY_TOOLS.has(t), t);
  for (const t of ["browser_click", "browser_type", "browser_navigate", "browser_run_js"]) {
    assert.ok(!READ_ONLY_TOOLS.has(t), `${t} must need permission outside Agent mode`);
  }
  // Cookie values include httpOnly session tokens — reading them is gated too.
  for (const t of ["browser_cookies_get", "browser_cookies_export"]) {
    assert.ok(!READ_ONLY_TOOLS.has(t), `${t} leaks session secrets — must not be auto-allowed`);
  }
  // …and asks the user even in Agent mode, like running page scripts and reading API bodies.
  assert.deepEqual([...ALWAYS_ASK_TOOLS].sort(), ["browser_cookies_export", "browser_cookies_get", "browser_cookies_import", "browser_network_capture", "browser_run_js"]);
  for (const t of ALWAYS_ASK_TOOLS) assert.ok(!READ_ONLY_TOOLS.has(t), `${t} can't be both read-only and always-ask`);
});

test("parseDataUrl accepts parameters and whitespace, rejects anything that is not base64", () => {
  const png = Buffer.from("png-bytes").toString("base64");
  assert.deepEqual(parseDataUrl(`data:image/png;base64,${png}`), { mime: "image/png", data: png });
  // Parameters between the mime type and ;base64 (FileReader never adds them, other producers do).
  assert.deepEqual(parseDataUrl(`data:image/png;name=a.png;base64,${png}`), { mime: "image/png", data: png });
  assert.deepEqual(parseDataUrl(`data:text/plain;charset=utf-8;name=notes.txt;base64,${png}`), { mime: "text/plain", data: png });
  // No mime → octet-stream; line breaks inside the payload are dropped.
  assert.deepEqual(parseDataUrl(`data:;base64,${png.slice(0, 4)}\n${png.slice(4)}`), { mime: "application/octet-stream", data: png });
  assert.equal(parseDataUrl("data:text/plain,hello"), null, "not base64");
  assert.equal(parseDataUrl(`data:image/png;base64,${png}!`), null, "stray character");
  assert.equal(parseDataUrl("javascript:alert(1)"), null);
  assert.equal(parseDataUrl(undefined), null);
  assert.equal(parseDataUrl(42), null);
});

test("attachment limits follow the kind of file (mime or extension)", () => {
  assert.equal(attachmentLimit("image/png", "shot.png"), MAX_IMAGE_BYTES);
  assert.equal(attachmentLimit("application/octet-stream", "photo.JPG"), MAX_IMAGE_BYTES, "image by extension");
  assert.equal(attachmentLimit("application/pdf", "file"), MAX_DOCUMENT_BYTES);
  assert.equal(attachmentLimit("application/octet-stream", "report.pdf"), MAX_DOCUMENT_BYTES, "pdf by extension");
  assert.equal(attachmentLimit("text/plain", "notes.txt"), MAX_ATTACHMENT_BYTES);
  assert.equal(attachmentLimit("application/zip", "bundle.zip"), MAX_ATTACHMENT_BYTES);
  assert.ok(MAX_IMAGE_BYTES < MAX_DOCUMENT_BYTES && MAX_DOCUMENT_BYTES < MAX_ATTACHMENT_BYTES);
  assert.ok(isImageAttachment("image/webp", "x") && isImageAttachment("", "a.gif") && !isImageAttachment("text/plain", "a.txt"));
});

test("attachment names lose directories, odd characters and excess length", () => {
  assert.equal(safeAttachmentName("../../etc/passwd", "text/plain"), "passwd");
  assert.equal(safeAttachmentName("my shot (1).png", "image/png"), "my_shot_1_.png");
  assert.equal(safeAttachmentName(undefined, "image/png"), "pasted.png");
  assert.equal(safeAttachmentName("", "application/pdf"), "file");
  assert.equal(safeAttachmentName("..", "text/plain"), "file", "a bare dot-dot is not a name");
  assert.equal(safeAttachmentName("a".repeat(300) + ".txt", "text/plain").length, 120);
});

test("expiredFiles keeps everything within the TTL", () => {
  const now = 1_700_000_000_000;
  const files = [
    { name: "old.png", mtimeMs: now - ATTACHMENT_TTL_MS - 1 },
    { name: "edge.png", mtimeMs: now - ATTACHMENT_TTL_MS },
    { name: "fresh.png", mtimeMs: now - 60_000 },
    { name: "future.png", mtimeMs: now + 60_000 },
  ];
  assert.deepEqual(expiredFiles(files, now), ["old.png"]);
  assert.deepEqual(expiredFiles(files, now, 30_000), ["old.png", "edge.png", "fresh.png"]);
});

test("pruneAttachments deletes only files older than the TTL", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "attachments-"));
  const old = path.join(dir, "k1-old.png");
  const fresh = path.join(dir, "k2-fresh.png");
  fs.writeFileSync(old, "x");
  fs.writeFileSync(fresh, "y");
  fs.mkdirSync(path.join(dir, "subdir"));
  const eightDaysAgo = (Date.now() - 8 * 24 * 3600 * 1000) / 1000;
  fs.utimesSync(old, eightDaysAgo, eightDaysAgo);
  assert.deepEqual(pruneAttachments(dir), ["k1-old.png"]);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["k2-fresh.png", "subdir"]);
  // Idempotent: a second pass finds nothing.
  assert.deepEqual(pruneAttachments(dir), []);
});

test("every declared browser tool is implemented in the panel", () => {
  // Bundled into .test-dist/, one level below the repo root.
  const src = fs.readFileSync(path.join(__dirname, "..", "browser", "extension", "browserTools.js"), "utf8");
  const implemented = new Set([...src.matchAll(/^ {4}(browser_\w+): async function/gm)].map((m) => m[1]));
  // The extras register theirs (AgentBrowserTools.register) from browser/extras/<id>.js.
  const extrasDir = path.join(__dirname, "..", "browser", "extras");
  const registered = new Map<string, string>();
  for (const f of fs.readdirSync(extrasDir).filter((f) => f.endsWith(".js"))) {
    const code = fs.readFileSync(path.join(extrasDir, f), "utf8").replace(/^\s*\/\/.*$/gm, ""); // not the comments
    for (const m of code.matchAll(/\.register\(\s*"(browser_\w+)"/g)) registered.set(m[1], f);
  }
  const missing = BROWSER_TOOLS.map((t) => t.name).filter((n) => !implemented.has(n) && !registered.has(n));
  assert.deepEqual(missing, [], "declared in browser/host/tools.ts but implemented neither in browserTools.js nor in browser/extras/");
  for (const t of BROWSER_TOOLS) {
    if (registered.has(t.name)) assert.equal(registered.get(t.name), `${t.feature}.js`, `${t.name} must be registered by its own feature's module`);
  }
  const declared = new Set(BROWSER_TOOLS.map((t) => t.name));
  for (const n of registered.keys()) assert.ok(declared.has(n), `${n} is registered by an extra but not declared in browser/host/extras/`);
});
