import { query } from "@anthropic-ai/claude-agent-sdk";

const q = query({
  prompt: "hi",
  options: { model: "sonnet", allowedTools: [], disallowedTools: ["Bash", "Edit", "Write"] },
});

// supportedModels may be available on the query object
try {
  const models = await q.supportedModels?.();
  console.log("supportedModels type:", typeof q.supportedModels);
  console.log("count:", Array.isArray(models) ? models.length : "n/a");
  console.log(JSON.stringify(models, null, 2));
} catch (e) {
  console.log("error:", e.message);
}
// drain a bit so the process can exit cleanly
try {
  for await (const m of q) {
    if (m.type === "result") break;
  }
} catch {}
