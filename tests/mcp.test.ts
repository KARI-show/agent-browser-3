import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { McpManager } from "../src/mcp";

function tmpws(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentide-mcp-"));
}

function mgr(root: string): McpManager {
  return new McpManager(
    () => root,
    () => {}
  );
}

test("reads .mcp.json (Claude Code format) with comments tolerated", () => {
  const ws = tmpws();
  fs.writeFileSync(
    path.join(ws, ".mcp.json"),
    `{
  // project tools
  "mcpServers": {
    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] },
    "linear": { "type": "http", "url": "https://mcp.linear.app/mcp" }
  }
}`,
    "utf8"
  );
  const servers = mgr(ws).servers();
  assert.deepEqual(Object.keys(servers).sort(), ["github", "linear"]);
  const list = mgr(ws).list();
  assert.equal(list.find((s) => s.name === "github")!.transport, "stdio");
  assert.equal(list.find((s) => s.name === "linear")!.transport, "http");
});

test(".mcp.json wins over .cursor/mcp.json on name collisions", () => {
  const ws = tmpws();
  fs.mkdirSync(path.join(ws, ".cursor"), { recursive: true });
  fs.writeFileSync(
    path.join(ws, ".cursor", "mcp.json"),
    JSON.stringify({ mcpServers: { tool: { command: "cursor-version" }, only: { command: "x" } } }),
    "utf8"
  );
  fs.writeFileSync(
    path.join(ws, ".mcp.json"),
    JSON.stringify({ mcpServers: { tool: { command: "project-version" } } }),
    "utf8"
  );
  const servers = mgr(ws).servers() as any;
  assert.equal(servers.tool.command, "project-version");
  assert.ok(servers.only, "cursor-only server still present");
});

test("missing/broken files contribute nothing", () => {
  const ws = tmpws();
  fs.writeFileSync(path.join(ws, ".mcp.json"), "{ not json", "utf8");
  assert.deepEqual(mgr(ws).servers(), {});
  assert.deepEqual(mgr(ws).list(), []);
});

test("createDefault writes the template once, never clobbers", async () => {
  const ws = tmpws();
  const m = mgr(ws);
  const p = await m.createDefault();
  assert.ok(p && fs.existsSync(p));
  fs.writeFileSync(p!, '{"mcpServers":{"mine":{"command":"x"}}}', "utf8");
  await m.createDefault();
  assert.ok(fs.readFileSync(p!, "utf8").includes("mine"));
});
