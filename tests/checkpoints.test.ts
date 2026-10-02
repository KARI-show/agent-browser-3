import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { CheckpointManager } from "../src/checkpoints";
import { MementoMock } from "./mocks/vscode";

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentide-test-"));
}

test("roundtrip: snapshot → commit → restore reverts an edited file", async () => {
  const ws = tmpdir();
  const blobs = path.join(ws, ".blobs");
  const file = path.join(ws, "a.txt");
  fs.writeFileSync(file, "ORIGINAL", "utf8");

  const cm = new CheckpointManager(new MementoMock() as any, blobs);
  cm.beginTurn("conv1", "edit a.txt");
  await cm.snapshot("conv1", file, "ORIGINAL");
  fs.writeFileSync(file, "MUTATED", "utf8"); // the agent edits the file
  await cm.commitTurn("conv1");

  const cps = cm.list("conv1");
  assert.equal(cps.length, 1);
  // Content must be blob-backed, not inline in the index (memory audit fix).
  assert.equal(cps[0].files[0].original, undefined);
  assert.ok(cps[0].files[0].blob, "expected blob-backed content");
  assert.ok(fs.existsSync(path.join(blobs, cps[0].files[0].blob!)));

  const res = await cm.restore(cps[0].id);
  assert.deepEqual([res.restored, res.failed], [1, 0]);
  assert.equal(fs.readFileSync(file, "utf8"), "ORIGINAL");
});

test("restore deletes files that did not exist before the turn", async () => {
  const ws = tmpdir();
  const cm = new CheckpointManager(new MementoMock() as any, path.join(ws, ".blobs"));
  const created = path.join(ws, "new.txt");

  cm.beginTurn("conv1", "create new.txt");
  await cm.snapshot("conv1", created, null); // didn't exist
  fs.writeFileSync(created, "born this turn", "utf8");
  await cm.commitTurn("conv1");

  const res = await cm.restore(cm.list("conv1")[0].id);
  assert.equal(res.failed, 0);
  assert.equal(fs.existsSync(created), false);
});

test("legacy inline checkpoints (pre-blob) still restore", async () => {
  const ws = tmpdir();
  const file = path.join(ws, "legacy.txt");
  fs.writeFileSync(file, "changed", "utf8");

  const state = new MementoMock();
  await state.update("checkpointsByConv", {
    conv1: [
      {
        id: "cpLegacy",
        convId: "conv1",
        time: Date.now(),
        label: "old format",
        files: [{ path: file, original: "the old text" }],
      },
    ],
  });
  const cm = new CheckpointManager(state as any, path.join(ws, ".blobs"));
  const res = await cm.restore("cpLegacy");
  assert.deepEqual([res.restored, res.failed], [1, 0]);
  assert.equal(fs.readFileSync(file, "utf8"), "the old text");
});

test("failed writes are reported, not swallowed", async () => {
  const ws = tmpdir();
  const cm = new CheckpointManager(new MementoMock() as any, path.join(ws, ".blobs"));
  const bad = path.join(ws, "no-such-dir", "sub", "x.txt");

  cm.beginTurn("conv1", "bad path");
  await cm.snapshot("conv1", bad, null);
  await cm.commitTurn("conv1");
  // restore of an "absent" file that never got created: delete throws → but
  // that branch is swallowed by design. Use a directory-as-file to force a
  // real write failure instead.
  const dirAsFile = path.join(ws, "iamadir");
  fs.mkdirSync(dirAsFile);
  cm.beginTurn("conv2", "dir collision");
  await cm.snapshot("conv2", dirAsFile, "content"); // restore will try to write over a dir
  await cm.commitTurn("conv2");
  const res = await cm.restore(cm.list("conv2")[0].id);
  assert.equal(res.failed, 1);
  assert.equal(res.errors.length, 1);
});

test("sweep drops checkpoints older than 30 days and their blobs", async () => {
  const ws = tmpdir();
  const blobs = path.join(ws, ".blobs");
  const file = path.join(ws, "f.txt");
  fs.writeFileSync(file, "x", "utf8");

  const cm = new CheckpointManager(new MementoMock() as any, blobs);
  cm.beginTurn("conv1", "turn");
  await cm.snapshot("conv1", file, "x");
  await cm.commitTurn("conv1");
  const cp = cm.list("conv1")[0];
  const blobFile = path.join(blobs, cp.files[0].blob!);
  assert.ok(fs.existsSync(blobFile));

  // Age the checkpoint past the TTL, then sweep.
  (cp as any).time = Date.now() - 31 * 24 * 3600_000;
  await (cm as any).state.update("checkpointsByConv", { conv1: [cp] });
  await cm.sweep();
  assert.equal(cm.list("conv1").length, 0);
  assert.equal(fs.existsSync(blobFile), false);
});
