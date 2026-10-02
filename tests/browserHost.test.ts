import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeFrames, MAX_FRAME } from "../browser/host/native";
import { BROWSER_TOOLS, READ_ONLY_TOOLS, browserToolName } from "../browser/host/tools";
import { FileMemento } from "../browser/host/memento";
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
});

test("every declared browser tool is implemented in the panel", () => {
  // Bundled into .test-dist/, one level below the repo root.
  const src = fs.readFileSync(path.join(__dirname, "..", "browser", "extension", "browserTools.js"), "utf8");
  const implemented = new Set([...src.matchAll(/^ {4}(browser_\w+): async function/gm)].map((m) => m[1]));
  const missing = BROWSER_TOOLS.map((t) => t.name).filter((n) => !implemented.has(n));
  assert.deepEqual(missing, [], "declared in browser/host/tools.ts but missing from browserTools.js");
});
