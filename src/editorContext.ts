import * as vscode from "vscode";

export interface DiagItem {
  file: string;   // absolute fsPath
  rel: string;    // workspace-relative path
  line: number;   // 1-based
  col: number;    // 1-based
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  source?: string;
}

// Map VS Code's numeric severity enum to our string union. Kept as a small
// lookup so callers always get a stable, serializable severity value.
function severityToString(s: vscode.DiagnosticSeverity): DiagItem["severity"] {
  switch (s) {
    case vscode.DiagnosticSeverity.Error:
      return "error";
    case vscode.DiagnosticSeverity.Warning:
      return "warning";
    case vscode.DiagnosticSeverity.Information:
      return "info";
    case vscode.DiagnosticSeverity.Hint:
      return "hint";
    default:
      return "info";
  }
}

// Convert a (uri, diagnostic) pair into our flat DiagItem. Positions in the
// VS Code API are 0-based, so we add 1 for human/agent-friendly 1-based output.
function toDiagItem(uri: vscode.Uri, d: vscode.Diagnostic): DiagItem {
  return {
    file: uri.fsPath,
    rel: vscode.workspace.asRelativePath(uri),
    line: d.range.start.line + 1,
    col: d.range.start.character + 1,
    severity: severityToString(d.severity),
    message: d.message,
    source: d.source,
  };
}

// Errors sort before warnings; everything else keeps relative order. Used so
// the most actionable problems appear first in prompts and loops.
function severityRank(sev: DiagItem["severity"]): number {
  return sev === "error" ? 0 : 1;
}

function isErrorOrWarning(sev: DiagItem["severity"]): boolean {
  return sev === "error" || sev === "warning";
}

// Collect all Error+Warning diagnostics in the workspace as DiagItems. Info and
// hint are deliberately dropped: they are rarely worth an agent's attention.
function collectErrorWarningDiagnostics(): DiagItem[] {
  const items: DiagItem[] = [];
  for (const [uri, diags] of vscode.languages.getDiagnostics()) {
    for (const d of diags) {
      const item = toDiagItem(uri, d);
      if (isErrorOrWarning(item.severity)) {
        items.push(item);
      }
    }
  }
  // Stable-ish sort: errors first, then by file/line so output is deterministic.
  items.sort((a, b) => {
    const r = severityRank(a.severity) - severityRank(b.severity);
    if (r !== 0) return r;
    if (a.rel !== b.rel) return a.rel < b.rel ? -1 : 1;
    return a.line - b.line;
  });
  return items;
}

// Normalize an absolute path for case-insensitive comparison on Windows, where
// the same file can be referenced with differing drive-letter case and slash
// direction. Lowercasing + forward slashes gives a single canonical key.
function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

// Errors+warnings for the given absolute file paths (for the diagnostics loop).
export function diagnosticsFor(paths: string[]): DiagItem[] {
  const wanted = new Set(paths.map(normalizePath));
  const items: DiagItem[] = [];
  for (const [uri, diags] of vscode.languages.getDiagnostics()) {
    if (!wanted.has(normalizePath(uri.fsPath))) continue;
    for (const d of diags) {
      const item = toDiagItem(uri, d);
      if (isErrorOrWarning(item.severity)) {
        items.push(item);
      }
    }
  }
  return items;
}

// All workspace error/warning diagnostics, capped.
export function allDiagnostics(max = 50): DiagItem[] {
  return collectErrorWarningDiagnostics().slice(0, max);
}

// A compact markdown block describing active file, selection, open tabs, and
// current problems. Returns "" when there is nothing useful to include.
export function gatherEditorContext(opts?: {
  includeDiagnostics?: boolean;
  includeTabs?: boolean;
}): string {
  // Default to including everything when no options object is supplied.
  const includeDiagnostics = opts?.includeDiagnostics ?? true;
  const includeTabs = opts?.includeTabs ?? true;

  const lines: string[] = [];

  // --- Active file + selection -------------------------------------------
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const doc = editor.document;
    const rel = vscode.workspace.asRelativePath(doc.uri);
    lines.push(`Active file: ${rel} (${doc.languageId})`);

    const sel = editor.selection;
    if (!sel.isEmpty) {
      const startLine = sel.start.line + 1;
      const endLine = sel.end.line + 1;
      lines.push(`Selection: lines ${startLine}-${endLine}`);

      // Only inline the selected text when it's small enough to stay compact.
      const lineCount = endLine - startLine + 1;
      if (lineCount <= 40) {
        const text = doc.getText(sel);
        lines.push("```" + doc.languageId);
        lines.push(text);
        lines.push("```");
      }
    } else {
      lines.push(`Cursor at line ${sel.active.line + 1}`);
    }
  }

  // --- Open tabs ----------------------------------------------------------
  const seenTabs = new Set<string>();
  const tabRels: string[] = [];
  if (includeTabs) {
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input;
        // Only real text documents have a meaningful file URI; skip diff/webview
        // and other non-text tab inputs.
        if (input instanceof vscode.TabInputText) {
          const rel = vscode.workspace.asRelativePath(input.uri);
          if (!seenTabs.has(rel)) {
            seenTabs.add(rel);
            tabRels.push(rel);
          }
        }
      }
    }
  }
  const cappedTabs = tabRels.slice(0, 20);
  if (cappedTabs.length > 0) {
    lines.push("");
    lines.push(`Open tabs (${cappedTabs.length}):`);
    for (const rel of cappedTabs) {
      lines.push(`- ${rel}`);
    }
  }

  // --- Diagnostics --------------------------------------------------------
  let diagItems: DiagItem[] = [];
  if (includeDiagnostics) {
    diagItems = collectErrorWarningDiagnostics();
    if (diagItems.length > 0) {
      const CAP = 30;
      const shown = diagItems.slice(0, CAP);
      lines.push("");
      lines.push(`Problems (${diagItems.length}):`);
      for (const it of shown) {
        const src = it.source ? ` (${it.source})` : "";
        lines.push(`- ${it.rel}:${it.line}:${it.col} [${it.severity}] ${it.message}${src}`);
      }
      const omitted = diagItems.length - shown.length;
      if (omitted > 0) {
        lines.push(`…(+${omitted} more)`);
      }
    }
  }

  // Nothing meaningful to report: no editor, no tabs, no diagnostics.
  if (!editor && cappedTabs.length === 0 && diagItems.length === 0) {
    return "";
  }

  // Wrap in a clearly delimited header so the agent can distinguish this
  // auto-injected context from the user's actual prompt.
  return ["## Editor context (auto-included)", ...lines].join("\n");
}
