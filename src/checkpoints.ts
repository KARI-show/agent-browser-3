import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

/**
 * Snapshot-based undo, scoped per conversation. Each agent turn opens a
 * checkpoint under the active conversation id; the first time a file is touched
 * we store its original bytes (or null if it didn't exist). Restoring writes
 * every file back to its original. Survives restarts.
 *
 * Storage: the index (ids, labels, file paths) lives in workspaceState, but
 * file CONTENT is written to blob files under globalStorage — workspaceState
 * used to carry full file text inline, which bloated the extension-host memory
 * with every kept checkpoint (audit finding). Legacy inline entries are still
 * readable, so old checkpoints keep working after the upgrade.
 */

export interface CheckpointFile {
  path: string;
  /** Inline original text (legacy entries; `undefined` when blob-backed). */
  original?: string | null;
  /** Blob filename under the checkpoint storage dir (new entries). */
  blob?: string;
  /** True when the file did not exist before the turn (restore = delete). */
  absent?: boolean;
}

export interface Checkpoint {
  id: string;
  convId: string;
  time: number;
  label: string;
  files: CheckpointFile[];
  /** Shadow-git commit of the whole workspace at turn start (deep restore). */
  shadowSha?: string;
}

type Store = Record<string, Checkpoint[]>; // convId -> checkpoints (newest first)

const MAX_PER_CHAT = 50;
const MAX_AGE_MS = 30 * 24 * 3600_000; // sweep checkpoints older than 30 days

/** Outcome of a restore: how many files were written back, how many failed, and
 *  why. `failed > 0` means the undo was incomplete — callers should warn. */
export interface RestoreResult {
  restored: number;
  failed: number;
  errors: string[];
}

export class CheckpointManager {
  // Per-conversation in-flight turn, so parallel runs (one per chat) don't mix
  // each other's file snapshots into one checkpoint.
  private turns = new Map<string, { cp: Checkpoint; seen: Set<string>; contents: Map<string, string | null> }>();

  /**
   * @param blobRoot Directory for content blobs (globalStorage/checkpoints).
   *                 Without it, falls back to legacy inline storage.
   */
  constructor(private state: vscode.Memento, private blobRoot?: string) {}

  private all(): Store {
    return this.state.get<Store>("checkpointsByConv", {});
  }

  private blobPath(name: string): string | undefined {
    return this.blobRoot ? path.join(this.blobRoot, name) : undefined;
  }

  private deleteBlobs(cp: Checkpoint) {
    for (const f of cp.files) {
      const p = f.blob ? this.blobPath(f.blob) : undefined;
      if (!p) continue;
      try {
        fs.unlinkSync(p);
      } catch {
        /* already gone */
      }
    }
  }

  /** Drop expired checkpoints + their blobs (called once on activation). */
  async sweep() {
    const store = this.all();
    const cutoff = Date.now() - MAX_AGE_MS;
    let dirty = false;
    for (const convId of Object.keys(store)) {
      const keep: Checkpoint[] = [];
      for (const cp of store[convId]) {
        if (cp.time < cutoff) {
          this.deleteBlobs(cp);
          dirty = true;
        } else keep.push(cp);
      }
      if (keep.length) store[convId] = keep;
      else if (store[convId]) {
        delete store[convId];
        dirty = true;
      }
    }
    if (dirty) await this.state.update("checkpointsByConv", store);
  }

  beginTurn(convId: string, label: string) {
    this.turns.set(convId, {
      cp: {
        id: "cp" + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36),
        convId,
        time: Date.now(),
        label: label.slice(0, 120),
        files: [],
      },
      seen: new Set(),
      contents: new Map(),
    });
  }

  /** Id of the checkpoint opened for the given chat's current turn (if any). */
  currentId(convId: string): string | undefined {
    return this.turns.get(convId)?.cp.id;
  }

  /**
   * Attach a shadow-git sha to a checkpoint. The snapshot runs async while the
   * turn streams, so the checkpoint may still be in-flight OR already
   * committed by the time the sha arrives — handle both.
   */
  async setShadowSha(cpId: string, sha: string) {
    for (const t of this.turns.values()) {
      if (t.cp.id === cpId) {
        t.cp.shadowSha = sha;
        return;
      }
    }
    const store = this.all();
    for (const list of Object.values(store)) {
      const cp = list.find((c) => c.id === cpId);
      if (cp) {
        cp.shadowSha = sha;
        await this.state.update("checkpointsByConv", store);
        return;
      }
    }
  }

  async snapshot(convId: string, absPath: string, original: string | null) {
    const t = this.turns.get(convId);
    if (!t) return;
    if (t.seen.has(absPath)) return;
    t.seen.add(absPath);
    // Content stays in memory only for the duration of the turn; commitTurn
    // spills it to a blob file so workspaceState holds just the index.
    t.contents.set(absPath, original);
    t.cp.files.push({ path: absPath });
  }

  async commitTurn(convId: string) {
    const t = this.turns.get(convId);
    if (!t) return;
    this.turns.delete(convId);
    // Keep the checkpoint when it has file snapshots OR a shadow-git commit —
    // a bash-only turn has no per-file entries but is still deep-restorable.
    if (t.cp.files.length === 0 && !t.cp.shadowSha) return;

    // Spill contents to blobs (or inline when no blob root is configured).
    let blobDirOk = false;
    if (this.blobRoot) {
      try {
        fs.mkdirSync(this.blobRoot, { recursive: true });
        blobDirOk = true;
      } catch {
        blobDirOk = false; // fall back to inline below
      }
    }
    t.cp.files = t.cp.files.map((f, i) => {
      const original = t.contents.get(f.path) ?? null;
      if (original === null) return { path: f.path, absent: true };
      if (blobDirOk) {
        const name = `${t.cp.id}-${i}.blob`;
        try {
          fs.writeFileSync(this.blobPath(name)!, original, "utf8");
          return { path: f.path, blob: name };
        } catch {
          /* disk full / permissions — keep the undo working via inline */
        }
      }
      return { path: f.path, original };
    });

    const store = this.all();
    const list = store[convId] ?? [];
    const evicted = list.slice(MAX_PER_CHAT - 1); // rows that fall off the cap
    for (const cp of evicted) this.deleteBlobs(cp);
    store[convId] = [t.cp, ...list].slice(0, MAX_PER_CHAT);
    await this.state.update("checkpointsByConv", store);
  }

  list(convId: string): Checkpoint[] {
    return this.all()[convId] ?? [];
  }

  /** Original content for a checkpoint file: inline (legacy) or blob-backed. */
  private readOriginal(f: CheckpointFile): string | null {
    if (f.absent) return null;
    if (f.original !== undefined) return f.original; // legacy inline (may be null)
    if (f.blob) {
      const p = this.blobPath(f.blob);
      if (!p) throw new Error("checkpoint storage unavailable");
      return fs.readFileSync(p, "utf8");
    }
    return null; // pre-upgrade "didn't exist" rows stored original: null
  }

  async restore(id: string): Promise<RestoreResult> {
    const store = this.all();
    let cp: Checkpoint | undefined;
    for (const list of Object.values(store)) {
      cp = list.find((c) => c.id === id);
      if (cp) break;
    }
    if (!cp) return { restored: 0, failed: 0, errors: [] };
    let restored = 0;
    let failed = 0;
    const errors: string[] = [];
    for (const f of cp.files) {
      const uri = vscode.Uri.file(f.path);
      try {
        const original = this.readOriginal(f);
        if (original == null) {
          try {
            await vscode.workspace.fs.delete(uri);
          } catch {
            /* file was never created / already gone — nothing to undo */
          }
        } else {
          await vscode.workspace.fs.writeFile(uri, Buffer.from(original, "utf8"));
        }
        restored++;
      } catch (e) {
        // Don't swallow: a failed write means the user's "undo" silently didn't
        // happen. Surface it so the caller can warn instead of claiming success.
        failed++;
        errors.push(`${f.path}: ${(e as Error)?.message ?? String(e)}`);
      }
    }
    return { restored, failed, errors };
  }
}
