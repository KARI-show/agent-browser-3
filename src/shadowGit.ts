import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";
import { log } from "./log";

/**
 * Shadow-git checkpoints (the Cline pattern): a bare-ish git repo whose
 * GIT_DIR lives under globalStorage while GIT_WORK_TREE points at the
 * workspace. Each agent turn commits a whole-workspace snapshot BEFORE any
 * tool runs, so even files mutated by Bash/PowerShell (which the per-file
 * Edit/Write snapshots can't see) can be rolled back.
 *
 * - never touches the user's own .git (git always refuses to track ".git")
 * - respects the workspace .gitignore (node_modules etc. stay out)
 * - identity/config pinned via env so user git config can't break commits
 * - everything is best-effort: no git / huge repo / failure → feature
 *   silently degrades to the per-file snapshots
 */

const GIT_TIMEOUT_MS = 60_000;

export class ShadowGit {
  private initDone = false;
  private broken = false; // one hard failure disables it for the session

  constructor(
    private readonly workTree: string,
    private readonly gitDir: string
  ) {}

  private env(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      GIT_DIR: this.gitDir,
      GIT_WORK_TREE: this.workTree,
      // Isolate from user/system config (hooks, signing, autocrlf surprises).
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_CONFIG_SYSTEM: os.devNull,
      GIT_AUTHOR_NAME: "agent-ide",
      GIT_AUTHOR_EMAIL: "agent@local",
      GIT_COMMITTER_NAME: "agent-ide",
      GIT_COMMITTER_EMAIL: "agent@local",
    };
  }

  private git(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        "git",
        args,
        { env: this.env(), cwd: this.workTree, timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) reject(new Error(`git ${args[0]}: ${stderr || err.message}`));
          else resolve(stdout.trim());
        }
      );
    });
  }

  private async ensureInit(): Promise<boolean> {
    if (this.broken) return false;
    if (this.initDone) return true;
    try {
      if (!fs.existsSync(path.join(this.gitDir, "HEAD"))) {
        fs.mkdirSync(this.gitDir, { recursive: true });
        await this.git(["init", "--quiet"]);
      }
      this.initDone = true;
      return true;
    } catch (e) {
      this.broken = true;
      log.warn("shadow-git unavailable: " + (e as Error).message);
      return false;
    }
  }

  /**
   * Commit a whole-workspace snapshot; returns the commit sha. First run on a
   * big repo is slow (full add), later runs are incremental. Undefined on any
   * failure — callers treat the sha as optional.
   */
  async snapshot(label: string): Promise<string | undefined> {
    if (!(await this.ensureInit())) return undefined;
    try {
      await this.git(["add", "-A", "--", "."]);
      // Commit only when something actually changed since the last snapshot;
      // otherwise reuse HEAD (same state = same restore point).
      try {
        await this.git([
          "commit",
          "--quiet",
          "--no-verify",
          "--no-gpg-sign",
          "-m",
          label.slice(0, 100) || "snapshot",
        ]);
      } catch (e) {
        if (!/nothing to commit/i.test((e as Error).message)) throw e;
      }
      return await this.git(["rev-parse", "HEAD"]);
    } catch (e) {
      log.warn("shadow-git snapshot failed: " + (e as Error).message);
      return undefined;
    }
  }

  /**
   * Deep restore: put every tracked file back to the snapshot AND delete
   * files created since (git clean, honoring .gitignore). This is the "as if
   * the turn never ran" operation — including bash side effects.
   */
  async restore(sha: string): Promise<{ ok: boolean; error?: string }> {
    if (!(await this.ensureInit())) return { ok: false, error: "shadow git unavailable" };
    try {
      await this.git(["checkout", "--quiet", sha, "--", "."]);
      // Remove files that did not exist at the snapshot (still respecting
      // .gitignore — never touches node_modules/build outputs or the real .git).
      await this.git(["clean", "-fd", "--quiet"]);
      // Re-point the shadow index at the restored state so the next snapshot
      // diffs cleanly.
      await this.git(["add", "-A", "--", "."]);
      return { ok: true };
    } catch (e) {
      const error = (e as Error).message;
      log.error("shadow-git restore failed", e);
      return { ok: false, error };
    }
  }
}
