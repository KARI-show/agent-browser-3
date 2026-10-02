// Proves multi-turn memory: turn 2 resumes turn 1's session and recalls context.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agent-resume-"));
const opts = { cwd: dir, model: "sonnet", allowedTools: [], disallowedTools: ["Bash", "Write", "Edit"] };

async function run(prompt, resume) {
  const q = query({ prompt, options: resume ? { ...opts, resume } : opts });
  let text = "";
  let sessionId;
  for await (const m of q) {
    if (m.session_id && !sessionId) sessionId = m.session_id;
    if (m.type === "assistant") {
      for (const b of m.message.content) if (b.type === "text") text += b.text;
    }
  }
  return { text: text.trim(), sessionId };
}

const t1 = await run("Remember this codeword exactly: BANANA42. Just reply: OK.");
console.log("turn1 session:", t1.sessionId);
console.log("turn1 says:", t1.text);

const t2 = await run("What was the codeword I gave you? Reply with only the word.", t1.sessionId);
console.log("turn2 session:", t2.sessionId, "(same as turn1:", t2.sessionId === t1.sessionId, ")");
console.log("turn2 recalls:", t2.text);

console.log("\nMEMORY OK:", /BANANA42/.test(t2.text));
