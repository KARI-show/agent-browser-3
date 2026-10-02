import * as fs from "fs";
import * as path from "path";

/**
 * vscode.Memento backed by one JSON file, so ConversationStore (written against
 * the VS Code API) persists the browser host's chats unchanged.
 */
export class FileMemento {
  private data: Record<string, unknown> = {};

  constructor(private file: string) {
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      return; // no state yet
    }
    try {
      this.data = JSON.parse(raw) || {};
    } catch {
      // Unreadable state: set it aside instead of starting empty and letting the
      // first save overwrite every chat the user had.
      try {
        fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
      } catch {
        /* keep going with empty state either way */
      }
      this.data = {};
    }
  }

  keys(): readonly string[] {
    return Object.keys(this.data);
  }

  // Copies, like VS Code's Memento: callers mutating a live conversation must
  // not change what's stored until they explicitly save it.
  get<T>(key: string, defaultValue?: T): T {
    return (key in this.data ? structuredClone(this.data[key]) : defaultValue) as T;
  }

  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) delete this.data[key];
    else this.data[key] = value;
    // Write-then-rename so a crash mid-write never leaves a truncated file.
    // Owner-only: chats hold page content from the user's logged-in sessions.
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}
