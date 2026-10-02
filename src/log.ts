import * as vscode from "vscode";

/**
 * One shared output channel for the whole extension. Previously failures were
 * swallowed in catch blocks (≈0 console.*, 1 showErrorMessage across 39 catches),
 * so background work — agent runs, auto-fix, orchestrator workers — could die
 * silently. Route diagnostics here; surface user-facing errors via `log.error`.
 */
let channel: vscode.OutputChannel | undefined;

function chan(): vscode.OutputChannel {
  if (!channel) channel = vscode.window.createOutputChannel("Agent IDE");
  return channel;
}

function stamp(): string {
  // HH:MM:SS.mmm — enough to correlate events without date noise.
  return new Date().toISOString().slice(11, 23);
}

export const log = {
  info(msg: string): void {
    chan().appendLine(`[${stamp()}] ${msg}`);
  },
  warn(msg: string): void {
    chan().appendLine(`[${stamp()}] WARN  ${msg}`);
  },
  error(msg: string, err?: unknown): void {
    let detail = "";
    if (err instanceof Error) detail = `\n${err.stack ?? err.message}`;
    else if (err != null) detail = `\n${String(err)}`;
    chan().appendLine(`[${stamp()}] ERROR ${msg}${detail}`);
  },
  show(): void {
    chan().show(true);
  },
  dispose(): void {
    channel?.dispose();
    channel = undefined;
  },
};
