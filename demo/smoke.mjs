// Headless smoke test of the engine: can the Agent SDK edit a local file?
import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agent-smoke-"));
console.log("workdir:", dir);

const q = query({
  prompt: "Create a file named hello.txt containing exactly the text: Hello from the agent",
  options: {
    cwd: dir,
    model: "sonnet",
    // Only the Write tool is auto-approved; nothing else can run.
    allowedTools: ["Write"],
    disallowedTools: ["Bash"],
  },
});

for await (const m of q) {
  if (m.type === "assistant") {
    for (const b of m.message.content) {
      if (b.type === "text") process.stdout.write(b.text);
      else if (b.type === "tool_use") console.log(`\n[tool] ${b.name}`);
    }
  } else if (m.type === "result") {
    console.log("\n[result]", m.subtype, "cost=$" + (m.total_cost_usd ?? 0));
  }
}

const target = join(dir, "hello.txt");
console.log("\nfile exists:", existsSync(target));
if (existsSync(target)) console.log("contents:", JSON.stringify(readFileSync(target, "utf8")));
