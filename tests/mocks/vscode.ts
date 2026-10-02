/**
 * Minimal in-memory mock of the `vscode` module — just the surface that
 * CheckpointManager / RulesManager touch. Wired in by the test build
 * (tests/run.mjs aliases `vscode` → this file).
 */
import * as fs from "fs";

export class MementoMock {
  private map = new Map<string, unknown>();
  get<T>(key: string, def?: T): T {
    return (this.map.has(key) ? (this.map.get(key) as T) : (def as T))!;
  }
  async update(key: string, value: unknown): Promise<void> {
    this.map.set(key, value);
  }
}

export const Uri = {
  file: (p: string) => ({ fsPath: p, scheme: "file", toString: () => "file://" + p }),
  joinPath: (base: { fsPath: string }, ...parts: string[]) =>
    Uri.file([base.fsPath, ...parts].join("/")),
};

export const workspace = {
  workspaceFolders: undefined as unknown,
  fs: {
    async writeFile(uri: { fsPath: string }, content: Uint8Array): Promise<void> {
      fs.writeFileSync(uri.fsPath, Buffer.from(content));
    },
    async delete(uri: { fsPath: string }): Promise<void> {
      fs.unlinkSync(uri.fsPath); // throws when missing, like vscode.workspace.fs
    },
  },
  createFileSystemWatcher: () => ({
    onDidCreate: () => ({ dispose() {} }),
    onDidChange: () => ({ dispose() {} }),
    onDidDelete: () => ({ dispose() {} }),
    dispose() {},
  }),
  getConfiguration: () => ({ get: (_k: string, def?: unknown) => def }),
};

export const window = {
  showTextDocument: async () => undefined,
  createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
};

// Type-only exports used in signatures (erased at runtime, but keep names).
export type Memento = MementoMock;
export type ExtensionContext = { subscriptions: { push(d: unknown): void }[] };
