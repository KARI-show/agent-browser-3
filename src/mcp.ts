import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

/**
 * MCP (Model Context Protocol) servers for the agent. Configured the same way
 * Claude Code does it: a `.mcp.json` at the workspace root —
 *
 *   { "mcpServers": {
 *       "github":  { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] },
 *       "linear":  { "type": "http", "url": "https://mcp.linear.app/mcp" } } }
 *
 * — merged over the global `agentIde.mcpServers` setting (workspace file wins
 * on name collisions). The result feeds runAgent's mcpServers option, which
 * the SDK forwards to the CLI. Cursor's `.cursor/mcp.json` is read too, so a
 * repo configured for Cursor lights up here with zero work.
 */

export interface McpServerInfo {
  name: string;
  /** "stdio" | "http" | "sse" | "?" — for display only. */
  transport: string;
  /** command line or url — for display only. */
  detail: string;
  /** Where it came from: ".mcp.json" | ".cursor/mcp.json" | "settings". */
  source: string;
}

// Strict JSON (no comments): VS Code lints .mcp.json as plain JSON, and the
// claude CLI reads the file natively too. parseJsonc below still TOLERATES
// //-comments if the user adds them, but we never ship any.
export const DEFAULT_MCP_TEMPLATE = `{
  "mcpServers": {
    "example-stdio": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-example"]
    },
    "example-http": {
      "type": "http",
      "url": "https://example.com/mcp"
    }
  }
}
`;

/** Strip //-comments so the template (and hand-edited files) still parse. */
function parseJsonc(text: string): any {
  return JSON.parse(text.replace(/^\s*\/\/.*$/gm, ""));
}

export class McpManager {
  private watcher?: vscode.FileSystemWatcher;

  constructor(
    private readonly root: () => string | undefined,
    private readonly onChanged: () => void
  ) {}

  watch(context: vscode.ExtensionContext) {
    this.watcher = vscode.workspace.createFileSystemWatcher(
      "**/{.mcp.json,.cursor/mcp.json}"
    );
    const bust = () => this.onChanged();
    this.watcher.onDidCreate(bust);
    this.watcher.onDidChange(bust);
    this.watcher.onDidDelete(bust);
    context.subscriptions.push(this.watcher);
  }

  /** The workspace .mcp.json path (whether or not it exists yet). */
  filePath(): string | undefined {
    const root = this.root();
    return root ? path.join(root, ".mcp.json") : undefined;
  }

  private readFile(rel: string): Record<string, unknown> {
    const root = this.root();
    if (!root) return {};
    try {
      const raw = fs.readFileSync(path.join(root, rel), "utf8");
      const parsed = parseJsonc(raw);
      const servers = parsed?.mcpServers;
      return servers && typeof servers === "object" ? servers : {};
    } catch {
      return {}; // missing / unparsable → contribute nothing
    }
  }

  /** Merged server map for runAgent: settings < .cursor/mcp.json < .mcp.json */
  servers(): Record<string, unknown> {
    const fromSettings =
      vscode.workspace.getConfiguration("agentIde").get<Record<string, unknown>>("mcpServers") ||
      {};
    return {
      ...fromSettings,
      ...this.readFile(path.join(".cursor", "mcp.json")),
      ...this.readFile(".mcp.json"),
    };
  }

  /** Display list for the settings menu (name + transport + origin). */
  list(): McpServerInfo[] {
    const describe = (cfg: any): { transport: string; detail: string } => {
      if (cfg && typeof cfg === "object") {
        if (typeof cfg.url === "string") {
          return { transport: cfg.type === "sse" ? "sse" : "http", detail: cfg.url };
        }
        if (typeof cfg.command === "string") {
          const args = Array.isArray(cfg.args) ? cfg.args.join(" ") : "";
          return { transport: "stdio", detail: `${cfg.command} ${args}`.trim() };
        }
      }
      return { transport: "?", detail: "" };
    };
    const out: McpServerInfo[] = [];
    const add = (map: Record<string, unknown>, source: string) => {
      for (const [name, cfg] of Object.entries(map)) {
        const d = describe(cfg);
        const existing = out.findIndex((s) => s.name === name);
        const info = { name, source, ...d };
        if (existing >= 0) out[existing] = info; // later source wins (same merge order)
        else out.push(info);
      }
    };
    add(
      vscode.workspace.getConfiguration("agentIde").get<Record<string, unknown>>("mcpServers") ||
        {},
      "settings"
    );
    add(this.readFile(path.join(".cursor", "mcp.json")), ".cursor/mcp.json");
    add(this.readFile(".mcp.json"), ".mcp.json");
    return out;
  }

  /** Create .mcp.json from the template (no-op if present). Returns the path. */
  async createDefault(): Promise<string | undefined> {
    const p = this.filePath();
    if (!p) return undefined;
    if (!fs.existsSync(p)) fs.writeFileSync(p, DEFAULT_MCP_TEMPLATE, "utf8");
    return p;
  }
}
