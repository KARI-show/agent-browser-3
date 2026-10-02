import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

/**
 * Project rules (Cursor-style): standing instructions the agent follows on
 * every task in this workspace. Discovered from the well-known rule files,
 * injected into the first prompt of each session, and surfaced in the UI so
 * it's always visible WHICH rules the agent is relying on.
 *
 * - CLAUDE.md is "native": the claude CLI auto-loads it as project memory, so
 *   we surface it in the chip but do NOT inject it (would double up).
 * - Everything else (.agentiderules, AGENTS.md, .cursorrules, .cursor/rules/*)
 *   is read + injected as a <project-rules> block.
 */

export interface RuleFile {
  /** Display name, e.g. "AGENTS.md" or ".cursor/rules/api.mdc". */
  name: string;
  /** Absolute path (click-to-open in the UI). */
  path: string;
  /** Content length in chars (0 = unreadable/empty). */
  chars: number;
  /** Auto-loaded by the claude CLI itself — shown, but not injected by us. */
  native: boolean;
}

const NATIVE_FILES = ["CLAUDE.md"];
const RULE_FILES = [".agentiderules", "AGENTS.md", ".cursorrules"];
const CURSOR_RULES_DIR = path.join(".cursor", "rules");
/** Injection cap — keep rules from eating the context window. */
const MAX_INJECT_CHARS = 24_000;

export const DEFAULT_RULES_TEMPLATE = `# Project rules

Standing instructions for the AI agent working in this repo.
Keep each rule short and imperative — these are read on every task.

## Style
- (example) Prefer small, focused edits over big rewrites.

## Stack
- (example) TypeScript strict mode; no new runtime dependencies without asking.

## Don't
- (example) Never commit or push unless explicitly asked.
`;

export class RulesManager {
  private watcher?: vscode.FileSystemWatcher;
  private cache: RuleFile[] | null = null;

  constructor(
    private readonly root: () => string | undefined,
    private readonly onChanged: () => void
  ) {}

  /** Start watching rule files so the UI chip refreshes live. */
  watch(context: vscode.ExtensionContext) {
    this.watcher = vscode.workspace.createFileSystemWatcher(
      "**/{CLAUDE.md,AGENTS.md,.agentiderules,.cursorrules,.cursor/rules/*}"
    );
    const bust = () => {
      this.cache = null;
      this.onChanged();
    };
    this.watcher.onDidCreate(bust);
    this.watcher.onDidChange(bust);
    this.watcher.onDidDelete(bust);
    context.subscriptions.push(this.watcher);
  }

  /** All rule files present in the workspace root (cached until a change). */
  list(): RuleFile[] {
    if (this.cache) return this.cache;
    const root = this.root();
    if (!root) return [];
    const out: RuleFile[] = [];
    const push = (rel: string, native: boolean) => {
      const abs = path.join(root, rel);
      try {
        const st = fs.statSync(abs);
        if (!st.isFile()) return;
        out.push({ name: rel, path: abs, chars: st.size, native });
      } catch {
        /* not present */
      }
    };
    for (const f of NATIVE_FILES) push(f, true);
    for (const f of RULE_FILES) push(f, false);
    // Cursor-style rules directory: .cursor/rules/*.mdc (or .md)
    try {
      const dir = path.join(root, CURSOR_RULES_DIR);
      for (const f of fs.readdirSync(dir)) {
        if (/\.(mdc?|md)$/i.test(f)) push(path.join(CURSOR_RULES_DIR, f), false);
      }
    } catch {
      /* no .cursor/rules */
    }
    this.cache = out;
    return out;
  }

  /**
   * The <project-rules> block to inject into the first prompt of a session.
   * Empty string when there's nothing (or only native files) to inject.
   */
  injectionBlock(): string {
    const files = this.list().filter((f) => !f.native && f.chars > 0);
    if (!files.length) return "";
    let budget = MAX_INJECT_CHARS;
    const parts: string[] = [];
    for (const f of files) {
      if (budget <= 0) break;
      let body = "";
      try {
        body = fs.readFileSync(f.path, "utf8").trim();
      } catch {
        continue;
      }
      if (!body) continue;
      if (body.length > budget) body = body.slice(0, budget) + "\n…(truncated)";
      budget -= body.length;
      parts.push(`<rules source="${f.name}">\n${body}\n</rules>`);
    }
    if (!parts.length) return "";
    return (
      "<project-rules>\n" +
      "The user has defined standing rules for this project. Follow them on every task.\n" +
      parts.join("\n") +
      "\n</project-rules>"
    );
  }

  /** Names shown in the per-turn "relying on" note (native included). */
  activeNames(): string[] {
    return this.list()
      .filter((f) => f.chars > 0)
      .map((f) => f.name);
  }

  /** Create AGENTS.md from the template (no-op if it already exists). */
  async createDefault(): Promise<string | undefined> {
    const root = this.root();
    if (!root) return undefined;
    const abs = path.join(root, "AGENTS.md");
    if (!fs.existsSync(abs)) fs.writeFileSync(abs, DEFAULT_RULES_TEMPLATE, "utf8");
    this.cache = null;
    return abs;
  }
}
