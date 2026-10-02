import { execFile } from "child_process";
import { promisify } from "util";

// Promisified execFile (not exec): we pass arguments as a discrete argv array so
// the shell never parses them, sidestepping shell-injection from branch names,
// commit messages, or paths containing spaces / metacharacters.
const run = promisify(execFile);

// Diffs can be large; bump maxBuffer well above the ~1MB default so git output
// isn't truncated into an ENOBUFS error.
const MAX_BUFFER = 10 * 1024 * 1024;

const EXEC_OPTS = { maxBuffer: MAX_BUFFER } as const;

export interface GitStatus {
  branch: string;
  staged: string[];
  unstaged: string[];
  untracked: string[];
  clean: boolean;
}

/**
 * Returns true when `cwd` is inside a git work tree. `git rev-parse` exits
 * non-zero (and prints to stderr) when run outside a repo, so we treat any
 * thrown error as "not a repo" rather than propagating it.
 */
export async function isRepo(cwd: string): Promise<boolean> {
  try {
    await run("git", ["rev-parse", "--is-inside-work-tree"], { cwd, ...EXEC_OPTS });
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads the working-tree status. We use `--porcelain=v1` because it is a stable,
 * script-friendly format (immune to locale/config changes), and `--branch` so the
 * leading `## ...` header gives us the current branch name in the same call.
 */
export async function status(cwd: string): Promise<GitStatus> {
  const { stdout } = await run(
    "git",
    ["status", "--porcelain=v1", "--branch"],
    { cwd, ...EXEC_OPTS }
  );

  let branch = "HEAD";
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];

  // Split on newlines; porcelain lines are terminated by \n. Drop the trailing
  // empty element from the final newline.
  const lines = stdout.split("\n").filter((l) => l.length > 0);

  for (const line of lines) {
    if (line.startsWith("## ")) {
      branch = parseBranch(line.slice(3));
      continue;
    }

    // Each entry is "XY <path>": X = index (staged) status, Y = worktree
    // (unstaged) status. "??" denotes an untracked file.
    const x = line[0];
    const y = line[1];
    // Skip the single space separator at index 2 to get the path. Renames are
    // reported as "orig -> new"; we keep the whole field as-is.
    const path = line.slice(3);

    if (x === "?" && y === "?") {
      untracked.push(path);
      continue;
    }
    // A space means "unmodified" in that column; anything else is a real change.
    if (x !== " " && x !== "?") {
      staged.push(path);
    }
    if (y !== " " && y !== "?") {
      unstaged.push(path);
    }
  }

  return {
    branch,
    staged,
    unstaged,
    untracked,
    clean: staged.length === 0 && unstaged.length === 0 && untracked.length === 0,
  };
}

/**
 * Extracts the branch name from the porcelain `## ` header body. Examples:
 *   "main...origin/main [ahead 1]" -> "main"
 *   "feature/x"                    -> "feature/x"
 *   "HEAD (no branch)"             -> "HEAD" (detached HEAD)
 */
function parseBranch(header: string): string {
  // Detached HEAD is reported as "## HEAD (no branch)".
  if (header.startsWith("HEAD ") || header === "HEAD") {
    return "HEAD";
  }
  // Strip any "...upstream" tracking suffix, then any trailing " [ahead/behind]".
  const local = header.split("...")[0];
  return local.split(" ")[0];
}

const DIFF_LIMIT = 20000;

/**
 * Returns the unified diff for the working tree, or for the staged changes when
 * `staged` is true. The result is capped at 20000 chars to keep it manageable for
 * display; a note is appended when truncation occurs.
 */
export async function diff(cwd: string, staged = false): Promise<string> {
  const args = staged ? ["diff", "--staged"] : ["diff"];
  const { stdout } = await run("git", args, { cwd, ...EXEC_OPTS });

  if (stdout.length > DIFF_LIMIT) {
    return stdout.slice(0, DIFF_LIMIT) + "\n…(diff truncated)…";
  }
  return stdout;
}

/**
 * Stages all changes, including deletions and untracked files (`git add -A`).
 */
export async function stageAll(cwd: string): Promise<void> {
  await run("git", ["add", "-A"], { cwd, ...EXEC_OPTS });
}

/**
 * Creates a commit with the given message and returns git's stdout. The message
 * is passed as a single argv element, so no manual quoting/escaping is needed.
 * Throws with git's own output when the commit fails (e.g. nothing to commit).
 */
export async function commit(cwd: string, message: string): Promise<string> {
  try {
    const { stdout } = await run(
      "git",
      ["commit", "-m", message],
      { cwd, ...EXEC_OPTS }
    );
    return stdout;
  } catch (err) {
    // execFile errors expose the subprocess stdout/stderr; surface whichever
    // carries git's explanation (e.g. "nothing to commit, working tree clean").
    const e = err as { stderr?: string; stdout?: string; message?: string };
    const detail = (e.stderr || e.stdout || e.message || "git commit failed").trim();
    throw new Error(detail);
  }
}
