import * as vscode from "vscode";

/**
 * Serves in-memory virtual documents under the `agentide:` scheme so we can
 * open a native diff between a saved snapshot and the current file on demand.
 */
// Cap on retained virtual snapshots. Each "⇄ Diff" mints a fresh uri (seq++),
// so without eviction this map would grow unbounded over a long session.
const MAX_SNAPSHOTS = 40;

class VirtualProvider implements vscode.TextDocumentContentProvider {
  readonly scheme = "agentide";
  private contents = new Map<string, string>();
  private emitter = new vscode.EventEmitter<vscode.Uri>();
  onDidChange = this.emitter.event;

  set(uri: vscode.Uri, content: string) {
    this.contents.set(uri.toString(), content);
    // Evict oldest entries (Map preserves insertion order) to bound memory.
    while (this.contents.size > MAX_SNAPSHOTS) {
      const oldest = this.contents.keys().next().value;
      if (oldest === undefined) break;
      this.contents.delete(oldest);
    }
    // Notify VS Code the content changed so any open editor for this uri re-renders.
    this.emitter.fire(uri);
  }
  provideTextDocumentContent(uri: vscode.Uri): string {
    // Unknown uris return "" rather than undefined so the diff renders an empty side instead of failing.
    return this.contents.get(uri.toString()) ?? "";
  }
}

const provider = new VirtualProvider();
// Monotonic counter appended to virtual uris so each snapshot gets a distinct uri.
let seq = 0;

export function registerDiff(context: vscode.ExtensionContext) {
  // Register the provider on the extension's subscriptions so it's disposed automatically on deactivate.
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(provider.scheme, provider)
  );
}

/** Create a virtual document holding `content` and return its unique uri. */
export function makeVirtual(label: string, content: string): vscode.Uri {
  // The `?${++seq}` query bumps the uri each call so VS Code treats every snapshot as a fresh document and never serves a cached diff.
  const uri = vscode.Uri.parse(
    `${provider.scheme}://snapshot/${encodeURIComponent(label)}?${++seq}`
  );
  provider.set(uri, content);
  return uri;
}
