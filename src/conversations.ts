import * as vscode from "vscode";

/**
 * Persisted chat history. Each conversation keeps its own transcript (for the
 * UI) plus the SDK `sessionId` (for `resume`, so the model keeps full context).
 * Stored in workspaceState, so past dialogs reopen after an editor restart.
 */

export type MsgKind = "user" | "assistant" | "thinking" | "tool" | "status" | "error";

export interface ConvMsg {
  kind: MsgKind;
  text: string;
  /** For user messages: the checkpoint opened for this turn (so rewind can find
   *  it reliably by id, not by fragile label-text matching). */
  cpId?: string;
  /** For tool messages: structured data so a reloaded chat can rebuild the rich
   *  tool/terminal card (with output), not a flat text line. `durationMs` is the
   *  wall-clock time the tool took (measured host-side between use and result). */
  tool?: { name: string; input: any; result?: string; isError?: boolean; durationMs?: number };
}

export interface Conversation {
  id: string;
  sessionId?: string;
  /** When set (and sessionId not yet assigned), the next run forks from this session. */
  forkFrom?: string;
  title: string;
  time: number;
  model?: string;
  mode?: "agent" | "ask" | "plan" | "acceptEdits";
  /** Pinned chats sort to the top and are kept regardless of the 50-item cap. */
  pinned?: boolean;
  /** User renamed the title manually — don't auto-overwrite it from the first message. */
  renamed?: boolean;
  /** Pending file changes (with diff hunks) so they survive a reload. */
  changes?: any[];
  /** Last-known context-window usage for this chat (for the composer bar);
   *  persisted so the bar shows immediately on reload. */
  context?: { used: number; max: number; pct: number; model?: string };
  messages: ConvMsg[];
}

export class ConversationStore {
  constructor(private state: vscode.Memento) {}

  /** Pinned first, then most-recent first. */
  list(): Conversation[] {
    return this.state
      .get<Conversation[]>("conversations", [])
      .slice()
      .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.time - a.time);
  }

  get(id: string): Conversation | undefined {
    return this.list().find((c) => c.id === id);
  }

  async save(conv: Conversation): Promise<void> {
    const rest = this.list().filter((c) => c.id !== conv.id);
    const all = [conv, ...rest];
    // Keep all pinned chats; cap the unpinned tail so storage stays bounded.
    const pinned = all.filter((c) => c.pinned);
    const unpinned = all.filter((c) => !c.pinned).slice(0, 50);
    await this.state.update("conversations", [...pinned, ...unpinned]);
  }

  async remove(id: string): Promise<void> {
    await this.state.update(
      "conversations",
      this.list().filter((c) => c.id !== id)
    );
  }

  /** Patch a stored conversation in place (title, pinned, …). */
  async patch(id: string, fields: Partial<Conversation>): Promise<void> {
    const conv = this.get(id);
    if (!conv) return;
    await this.save({ ...conv, ...fields });
  }
}
