import * as vscode from "vscode";
import { Conversation } from "./conversations";

/**
 * Render a stored conversation to a self-contained Markdown document and write
 * it under `.agent-ide/exports/`. Lets a chat leave the editor — paste into a
 * PR, share a transcript, archive a session. Tool-call lines and status noise
 * are folded down so the result reads like a conversation, not a log dump.
 */

export function conversationToMarkdown(conv: Conversation): string {
  const out: string[] = [];
  out.push(`# ${conv.title || "Agent IDE conversation"}`);
  out.push("");
  out.push(`> Exported ${new Date().toLocaleString()}`);
  if (conv.model) out.push(`> Model: \`${conv.model}\``);
  if (conv.mode) out.push(`> Mode: \`${conv.mode}\``);
  out.push("");

  for (const m of conv.messages) {
    switch (m.kind) {
      case "user":
        out.push("## 🧑 You", "", m.text, "");
        break;
      case "assistant":
        out.push("## ✦ Agent", "", m.text, "");
        break;
      case "thinking":
        if (m.text.trim()) {
          out.push("<details><summary>💭 Thinking</summary>", "", m.text, "", "</details>", "");
        }
        break;
      case "tool":
        out.push("```", m.text, "```", "");
        break;
      case "error":
        out.push(`> ⚠ ${m.text}`, "");
        break;
      case "status":
        // Streamed status chatter ("✓ done", "working…") isn't worth keeping.
        break;
    }
  }
  return out.join("\n");
}

/**
 * Export to `.agent-ide/exports/agent-<title>-<ts>.md` in the first workspace
 * folder. With no folder open, fall back to an untitled Markdown buffer.
 * Returns the written file uri (or undefined for the untitled fallback).
 */
export async function exportConversation(conv: Conversation): Promise<vscode.Uri | undefined> {
  const md = conversationToMarkdown(conv);
  const folder = vscode.workspace.workspaceFolders?.[0];

  if (!folder) {
    const doc = await vscode.workspace.openTextDocument({ language: "markdown", content: md });
    await vscode.window.showTextDocument(doc, { preview: false });
    return undefined;
  }

  const safe = (conv.title || "conversation").replace(/[^\w.-]+/g, "-").slice(0, 50) || "conversation";
  const dir = vscode.Uri.joinPath(folder.uri, ".agent-ide", "exports");
  await vscode.workspace.fs.createDirectory(dir);
  const target = vscode.Uri.joinPath(dir, `agent-${safe}-${Date.now()}.md`);
  await vscode.workspace.fs.writeFile(target, Buffer.from(md, "utf8"));
  return target;
}
