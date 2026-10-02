import * as vscode from "vscode";
import * as path from "path";
import { CheckpointManager } from "./checkpoints";
import { makeVirtual } from "./diff";

/**
 * Cursor-style inline review. When the agent writes a file we highlight the
 * changed lines in-place (green) and show Keep / Revert / Diff actions via
 * CodeLens at the top of the file. Revert restores the pre-edit snapshot.
 */

// Windows: VS Code's watcher reports `c:\...` (lowercase drive) while the SDK
// gives `C:\...`. Normalize so the pending-edit map keys match.
function pathKey(p: string): string {
  return p.replace(/\//g, "\\").toLowerCase();
}

async function readFileOrNull(absPath: string): Promise<string | null> {
  try {
    const buf = await vscode.workspace.fs.readFile(vscode.Uri.file(absPath));
    return Buffer.from(buf).toString("utf8");
  } catch {
    return null;
  }
}

interface Hunk {
  newStart: number; // first changed new-line index (insertion point if pure deletion)
  newEnd: number; // last changed new-line index (newStart-1 if pure deletion)
  orig: string[]; // original lines this hunk replaces (removed)
  add: string[]; // new lines this hunk introduces (added)
}

interface DiffStats {
  ranges: vscode.Range[]; // changed/added line ranges in `neu`
  added: number;
  removed: number;
  hunks: Hunk[];
}

/** Line diff between orig and neu: ranges, +/- counts, and per-hunk originals. */
function diffStats(orig: string, neu: string): DiffStats {
  const a = orig.length ? orig.split("\n") : [];
  const b = neu.split("\n");
  const m = a.length;
  const n = b.length;
  const added = new Array<boolean>(n).fill(false);
  let addedCount = 0;
  let removed = 0;
  const hunks: Hunk[] = [];
  let cur: Hunk | null = null;
  const flush = () => {
    if (cur) {
      hunks.push(cur);
      cur = null;
    }
  };
  const onAdd = (j: number) => {
    if (!cur) cur = { newStart: j, newEnd: j, orig: [], add: [] };
    else if (cur.newEnd < cur.newStart) {
      cur.newStart = j;
      cur.newEnd = j;
    } else cur.newEnd = j;
    cur.add.push(b[j]);
    added[j] = true;
    addedCount++;
  };
  const onDel = (line: string, j: number) => {
    if (!cur) cur = { newStart: j, newEnd: j - 1, orig: [], add: [] };
    cur.orig.push(line);
    removed++;
  };

  if (m * n > 4_000_000) {
    // Big file: cheap prefix/suffix trim instead of full LCS.
    let p = 0;
    while (p < m && p < n && a[p] === b[p]) p++;
    let s = 0;
    while (s < m - p && s < n - p && a[m - 1 - s] === b[n - 1 - s]) s++;
    cur = { newStart: p, newEnd: p - 1, orig: a.slice(p, m - s), add: [] };
    for (let k = p; k < n - s; k++) onAdd(k);
    removed = Math.max(0, m - p - s);
    flush();
  } else {
    const dp: number[][] = Array.from({ length: m + 1 }, () =>
      new Array<number>(n + 1).fill(0)
    );
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        dp[i][j] =
          a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (a[i] === b[j]) {
        flush();
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        onDel(a[i], j);
        i++;
      } else {
        onAdd(j);
        j++;
      }
    }
    while (j < n) onAdd(j++);
    while (i < m) onDel(a[i++], j);
    flush();
  }

  const ranges: vscode.Range[] = [];
  let start = -1;
  for (let k = 0; k < n; k++) {
    if (added[k]) {
      if (start < 0) start = k;
    } else if (start >= 0) {
      ranges.push(new vscode.Range(start, 0, k - 1, Number.MAX_SAFE_INTEGER));
      start = -1;
    }
  }
  if (start >= 0) ranges.push(new vscode.Range(start, 0, n - 1, Number.MAX_SAFE_INTEGER));
  return { ranges, added: addedCount, removed, hunks };
}

interface Review {
  original: string | null;
  ranges: vscode.Range[];
  added: number;
  removed: number;
  path: string; // real fs path for display / opening
  hunks: Hunk[];
}

export interface ChangeItem {
  path: string;
  name: string;
  added: number;
  removed: number;
  hunks: { del: string[]; add: string[] }[];
  original: string | null; // pre-edit content, so reviews survive a reload
}

export class ReviewManager implements vscode.CodeLensProvider {
  private pending = new Map<string, { original: string | null }>();
  private reviews = new Map<string, Review>();
  private deco: vscode.TextEditorDecorationType;
  private emitter = new vscode.EventEmitter<void>();
  onDidChangeCodeLenses = this.emitter.event;
  private changesEmitter = new vscode.EventEmitter<void>();
  /** Fires whenever the set of pending file changes changes. */
  readonly onDidChangeReviews = this.changesEmitter.event;

  /** Current pending changes (files the agent edited, not yet kept/reverted). */
  list(): ChangeItem[] {
    return Array.from(this.reviews.values()).map((r) => ({
      path: r.path,
      name: path.basename(r.path),
      added: r.added,
      removed: r.removed,
      hunks: r.hunks.map((h) => ({ del: h.orig, add: h.add })),
      original: r.original,
    }));
  }

  /** Drop all live reviews (e.g. when switching conversations). */
  clearAll() {
    if (this.reviews.size === 0) return;
    this.reviews.clear();
    this.emitter.fire();
    for (const ed of vscode.window.visibleTextEditors) {
      ed.setDecorations(this.deco, []);
    }
  }

  /** Rebuild reviews from persisted change items so they survive a reload. */
  async rehydrate(items: { path: string; original: string | null }[]) {
    for (const it of items || []) {
      if (!it?.path) continue;
      const current = await readFileOrNull(it.path);
      if (current == null || current === (it.original ?? "")) continue;
      const stats = diffStats(it.original ?? "", current);
      this.reviews.set(pathKey(it.path), {
        original: it.original,
        ranges: stats.ranges,
        added: stats.added,
        removed: stats.removed,
        path: it.path,
        hunks: stats.hunks,
      });
    }
    this.emitter.fire();
    this.changesEmitter.fire();
    this.decorateVisible();
  }

  constructor(
    private ctx: vscode.ExtensionContext,
    private checkpoints: CheckpointManager
  ) {
    this.deco = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: "rgba(46, 160, 67, 0.18)",
      borderColor: "rgba(46, 160, 67, 0.7)",
      borderWidth: "0 0 0 2px",
      borderStyle: "solid",
      overviewRulerColor: "rgba(46, 160, 67, 0.8)",
      overviewRulerLane: vscode.OverviewRulerLane.Full,
    });
    ctx.subscriptions.push(this.deco);

    ctx.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor((e) => e && this.decorate(e)),
      vscode.workspace.onDidOpenTextDocument(() => this.decorateVisible())
    );

    const watcher = vscode.workspace.createFileSystemWatcher("**/*");
    ctx.subscriptions.push(watcher);
    watcher.onDidChange((uri) => this.onWrite(uri));
    watcher.onDidCreate((uri) => this.onWrite(uri));

    ctx.subscriptions.push(
      vscode.commands.registerCommand("agentIde.keepFile", (uri: vscode.Uri) =>
        this.keep(uri)
      ),
      vscode.commands.registerCommand("agentIde.revertFile", (uri: vscode.Uri) =>
        this.revert(uri)
      ),
      vscode.commands.registerCommand("agentIde.openReviewDiff", (uri: vscode.Uri) =>
        this.openDiff(uri)
      ),
      vscode.commands.registerCommand(
        "agentIde.revertHunk",
        (uri: vscode.Uri, idx: number) => this.revertHunk(uri, idx)
      ),
      vscode.languages.registerCodeLensProvider({ scheme: "file" }, this)
    );
  }

  /** Called from the approval gate, before the agent writes the file. The
   *  convId routes the snapshot to the right chat's checkpoint (parallel runs). */
  async prepareEdit(absPath: string, convId: string): Promise<void> {
    const original = await readFileOrNull(absPath);
    this.pending.set(pathKey(absPath), { original });
    await this.checkpoints.snapshot(convId, absPath, original);
  }

  private async onWrite(uri: vscode.Uri) {
    const p = uri.fsPath;
    const k = pathKey(p);
    const pend = this.pending.get(k);
    if (!pend) return;
    this.pending.delete(k);

    const current = await readFileOrNull(p);
    if (current == null || current === pend.original) return;

    const stats = diffStats(pend.original ?? "", current);
    this.reviews.set(k, {
      original: pend.original,
      ranges: stats.ranges,
      added: stats.added,
      removed: stats.removed,
      path: p,
      hunks: stats.hunks,
    });
    this.emitter.fire();
    this.changesEmitter.fire();

    const doc = await vscode.workspace.openTextDocument(uri);
    const ed = await vscode.window.showTextDocument(doc, {
      preview: false,
      preserveFocus: true,
    });
    this.decorate(ed);
  }

  private decorate(editor: vscode.TextEditor) {
    const r = this.reviews.get(pathKey(editor.document.uri.fsPath));
    editor.setDecorations(this.deco, r ? r.ranges : []);
  }

  private decorateVisible() {
    for (const ed of vscode.window.visibleTextEditors) this.decorate(ed);
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const r = this.reviews.get(pathKey(doc.uri.fsPath));
    if (!r) return [];
    const top = new vscode.Range(0, 0, 0, 0);
    const lenses: vscode.CodeLens[] = [
      new vscode.CodeLens(top, {
        title: `✓ Keep all`,
        command: "agentIde.keepFile",
        arguments: [doc.uri],
      }),
      new vscode.CodeLens(top, {
        title: "✗ Revert all",
        command: "agentIde.revertFile",
        arguments: [doc.uri],
      }),
      new vscode.CodeLens(top, {
        title: "⇄ Diff",
        command: "agentIde.openReviewDiff",
        arguments: [doc.uri],
      }),
    ];
    // Per-hunk revert, right at each changed block.
    r.hunks.forEach((h, idx) => {
      if (h.newEnd >= h.newStart) {
        const at = new vscode.Range(h.newStart, 0, h.newStart, 0);
        lenses.push(
          new vscode.CodeLens(at, {
            title: "↩ Revert this change",
            command: "agentIde.revertHunk",
            arguments: [doc.uri, idx],
          })
        );
      }
    });
    return lenses;
  }

  private clear(p: string) {
    const k = pathKey(p);
    this.reviews.delete(k);
    this.emitter.fire();
    this.changesEmitter.fire();
    for (const ed of vscode.window.visibleTextEditors) {
      if (pathKey(ed.document.uri.fsPath) === k) ed.setDecorations(this.deco, []);
    }
  }

  private keep(uri: vscode.Uri) {
    this.clear(uri.fsPath);
  }

  private async revert(uri: vscode.Uri) {
    const r = this.reviews.get(pathKey(uri.fsPath));
    if (!r) return;
    if (r.original == null) {
      try {
        await vscode.workspace.fs.delete(uri);
      } catch {
        /* ignore */
      }
    } else {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(r.original, "utf8"));
    }
    this.clear(uri.fsPath);
  }

  /** Panel entry points (the webview identifies changes by fs path). */
  revertHunkByPath(p: string, hunkIndex: number): Promise<void> {
    return this.revertHunk(vscode.Uri.file(p), hunkIndex);
  }
  keepHunkByPath(p: string, hunkIndex: number): Promise<void> {
    return this.keepHunk(vscode.Uri.file(p), hunkIndex);
  }

  /**
   * Accept one changed block: fold it into the review baseline so it stops
   * counting as "pending", while every other hunk stays reviewable. The new
   * baseline = current file with all OTHER hunks reverted (descending order
   * keeps the line indices valid while splicing).
   */
  private async keepHunk(uri: vscode.Uri, hunkIndex: number) {
    const k = pathKey(uri.fsPath);
    const r = this.reviews.get(k);
    if (!r || !r.hunks[hunkIndex]) return;

    const current = await readFileOrNull(uri.fsPath);
    if (current == null) return;
    const lines = current.split("\n");
    for (let i = r.hunks.length - 1; i >= 0; i--) {
      if (i === hunkIndex) continue;
      const h = r.hunks[i];
      const count = h.newEnd >= h.newStart ? h.newEnd - h.newStart + 1 : 0;
      lines.splice(h.newStart, count, ...h.orig);
    }
    const newBaseline = lines.join("\n");

    if (newBaseline === current) {
      // That was the only hunk — the whole file is accepted.
      this.clear(uri.fsPath);
      return;
    }
    const stats = diffStats(newBaseline, current);
    this.reviews.set(k, {
      ...r,
      original: newBaseline,
      ranges: stats.ranges,
      added: stats.added,
      removed: stats.removed,
      hunks: stats.hunks,
    });
    this.emitter.fire();
    this.changesEmitter.fire();
    for (const ed of vscode.window.visibleTextEditors) {
      if (pathKey(ed.document.uri.fsPath) === k) this.decorate(ed);
    }
  }

  /** Revert one changed block to its original lines, keeping the rest. */
  private async revertHunk(uri: vscode.Uri, hunkIndex: number) {
    const k = pathKey(uri.fsPath);
    const r = this.reviews.get(k);
    if (!r) return;
    const hunk = r.hunks[hunkIndex];
    if (!hunk) return;

    const current = await readFileOrNull(uri.fsPath);
    if (current == null) return;
    const lines = current.split("\n");
    const count = hunk.newEnd >= hunk.newStart ? hunk.newEnd - hunk.newStart + 1 : 0;
    lines.splice(hunk.newStart, count, ...hunk.orig);
    const reverted = lines.join("\n");
    await vscode.workspace.fs.writeFile(uri, Buffer.from(reverted, "utf8"));

    if (reverted === (r.original ?? "")) {
      this.clear(uri.fsPath);
      return;
    }
    // Recompute the review against the original snapshot.
    const stats = diffStats(r.original ?? "", reverted);
    this.reviews.set(k, {
      ...r,
      ranges: stats.ranges,
      added: stats.added,
      removed: stats.removed,
      hunks: stats.hunks,
    });
    this.emitter.fire();
    this.changesEmitter.fire();
    for (const ed of vscode.window.visibleTextEditors) {
      if (pathKey(ed.document.uri.fsPath) === k) this.decorate(ed);
    }
  }

  private async openDiff(uri: vscode.Uri) {
    const r = this.reviews.get(pathKey(uri.fsPath));
    if (!r) return;
    const left = makeVirtual("before:" + uri.fsPath, r.original ?? "");
    await vscode.commands.executeCommand(
      "vscode.diff",
      left,
      uri,
      `Agent ✎ ${uri.path.split("/").pop()} — before ↔ now`
    );
  }
}
