import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { RulesManager } from "../src/rules";

function tmpws(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentide-rules-"));
}

function mgr(root: string): RulesManager {
  return new RulesManager(
    () => root,
    () => {}
  );
}

test("discovers rule files and flags CLAUDE.md as native", () => {
  const ws = tmpws();
  fs.writeFileSync(path.join(ws, "CLAUDE.md"), "# native memory", "utf8");
  fs.writeFileSync(path.join(ws, "AGENTS.md"), "# project rules", "utf8");
  fs.writeFileSync(path.join(ws, ".cursorrules"), "cursor compat", "utf8");
  fs.mkdirSync(path.join(ws, ".cursor", "rules"), { recursive: true });
  fs.writeFileSync(path.join(ws, ".cursor", "rules", "api.mdc"), "api rule", "utf8");

  const list = mgr(ws).list();
  const names = list.map((f) => f.name);
  assert.ok(names.includes("CLAUDE.md"));
  assert.ok(names.includes("AGENTS.md"));
  assert.ok(names.includes(".cursorrules"));
  assert.ok(names.some((n) => n.endsWith("api.mdc")));
  assert.equal(list.find((f) => f.name === "CLAUDE.md")!.native, true);
  assert.equal(list.find((f) => f.name === "AGENTS.md")!.native, false);
});

test("injection block includes non-native rules only", () => {
  const ws = tmpws();
  fs.writeFileSync(path.join(ws, "CLAUDE.md"), "NATIVE-ONLY-MARKER", "utf8");
  fs.writeFileSync(path.join(ws, "AGENTS.md"), "AGENTS-MARKER", "utf8");

  const block = mgr(ws).injectionBlock();
  assert.ok(block.includes("<project-rules>"));
  assert.ok(block.includes("AGENTS-MARKER"));
  // CLAUDE.md is auto-loaded by the CLI — injecting it would double it up.
  assert.ok(!block.includes("NATIVE-ONLY-MARKER"));
  assert.ok(block.includes('source="AGENTS.md"'));
});

test("empty workspace → empty injection, empty list", () => {
  const ws = tmpws();
  const m = mgr(ws);
  assert.equal(m.injectionBlock(), "");
  assert.deepEqual(m.list(), []);
});

test("createDefault writes the AGENTS.md template once", async () => {
  const ws = tmpws();
  const m = mgr(ws);
  const p = await m.createDefault();
  assert.ok(p && fs.existsSync(p));
  const body = fs.readFileSync(p!, "utf8");
  assert.ok(body.includes("# Project rules"));
  // Second call must not clobber user edits.
  fs.writeFileSync(p!, "user edited", "utf8");
  await m.createDefault();
  assert.equal(fs.readFileSync(p!, "utf8"), "user edited");
});

test("oversized rules are truncated at the injection cap", () => {
  const ws = tmpws();
  fs.writeFileSync(path.join(ws, "AGENTS.md"), "x".repeat(50_000), "utf8");
  const block = mgr(ws).injectionBlock();
  assert.ok(block.length < 30_000, `block too big: ${block.length}`);
  assert.ok(block.includes("…(truncated)"));
});
