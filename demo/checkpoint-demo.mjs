// Standalone harness that mirrors the real logic from src/checkpoints.ts
// (CheckpointManager) but swaps `vscode.Memento` for a Map and `vscode.workspace.fs`
// for the real Node fs, so we can watch snapshot -> edit -> restore actually run.
import { writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from "node:fs";

// --- fake Memento (the persisted key/value store VS Code gives the extension) ---
class MemoryMemento {
  store = new Map();
  get(key, def) { return this.store.has(key) ? this.store.get(key) : def; }
  async update(key, val) { this.store.set(key, val); }
}

// --- faithful copy of CheckpointManager, fs/Date kept real ---
class CheckpointManager {
  current; seen = new Set();
  constructor(state) { this.state = state; }
  beginTurn(label) {
    this.current = { id: "cp" + Date.now().toString(36), time: Date.now(),
      label: label.slice(0, 120), files: [] };
    this.seen = new Set();
  }
  async snapshot(absPath, original) {
    if (!this.current) this.beginTurn("(edit)");
    if (this.seen.has(absPath)) return;
    this.seen.add(absPath);
    this.current.files.push({ path: absPath, original });
  }
  async commitTurn() {
    if (!this.current || this.current.files.length === 0) { this.current = undefined; return; }
    const all = [this.current, ...this.list()].slice(0, 50);
    await this.state.update("checkpoints", all);
    this.current = undefined;
  }
  list() { return this.state.get("checkpoints", []); }
  async restore(id) {
    const cp = this.list().find((c) => c.id === id);
    if (!cp) return 0;
    let n = 0;
    for (const f of cp.files) {
      if (f.original == null) { if (existsSync(f.path)) rmSync(f.path); }
      else writeFileSync(f.path, f.original, "utf8");
      n++;
    }
    return n;
  }
}

const read = (p) => existsSync(p) ? readFileSync(p, "utf8") : null;
const dir = new URL("./_scratch/", import.meta.url).pathname.replace(/^\//, "");
rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
const file = dir + "greeting.ts";

const mgr = new CheckpointManager(new MemoryMemento());

console.log("STEP 1  create original file + commit a checkpoint");
writeFileSync(file, 'export const hi = "hello";\nexport const bye = "goodbye";\n');
mgr.beginTurn("turn #1: agent edits greeting.ts");
await mgr.snapshot(file, read(file));   // store original bytes BEFORE the edit
await mgr.commitTurn();
const cpId = mgr.list()[0].id;
console.log("        checkpoint saved:", cpId, "| files:", mgr.list()[0].files.length);
console.log("        disk now:\n" + read(file).replace(/^/gm, "          "));

console.log("\nSTEP 2  agent edits the file (change + delete a line)");
writeFileSync(file, 'export const hi = "HELLO, WORLD";\n');
console.log("        disk now:\n" + read(file).replace(/^/gm, "          "));

console.log("\nSTEP 3  restore(" + cpId + ")  <- this is what the Undo button calls");
const n = await mgr.restore(cpId);
console.log("        files rewritten:", n);
console.log("        disk now:\n" + read(file).replace(/^/gm, "          "));

console.log("\nRESULT  restored === original ?",
  read(file) === 'export const hi = "hello";\nexport const bye = "goodbye";\n');
