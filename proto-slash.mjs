import { query } from "@anthropic-ai/claude-agent-sdk";

const q = query({
  prompt: "hi",
  options: { model: "sonnet", allowedTools: [], disallowedTools: ["Bash", "Edit", "Write"] },
});

for await (const m of q) {
  if (m.type === "system" && m.subtype === "init") {
    console.log("slash_commands:", JSON.stringify(m.slash_commands, null, 2));
  }
  if (m.type === "result") break;
}
