// Prototype: rebuild a truncated copy of a session as a NEW session id, then
// resume it and check the model "forgot" the dropped turn. Original untouched.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const cwd = "C:\\Users\\Administrator\\agent-ide";
const projDir =
  "C:\\Users\\Administrator\\.claude\\projects\\c--Users-Administrator-agent-ide";

// pick the most recent session file
const files = readdirSync(projDir)
  .filter((f) => f.endsWith(".jsonl"))
  .map((f) => join(projDir, f));
const orig = files
  .map((f) => ({ f, t: readFileSync(f, "utf8").length }))
  .sort((a, b) => b.t - a.t)[0].f;

const lines = readFileSync(orig, "utf8").split(/\r?\n/).filter(Boolean);
const newId = randomUUID();

// Keep lines until the user turn that says "Add a comment..." (drop it onward).
const kept = [];
let dropped = 0;
let cutting = false;
for (const ln of lines) {
  let o;
  try {
    o = JSON.parse(ln);
  } catch {
    continue;
  }
  if (!cutting && o.type === "user") {
    const c = o.message?.content;
    const txt = typeof c === "string" ? c : Array.isArray(c) ? c.find((b) => b.type === "text")?.text || "" : "";
    if (/add a comment/i.test(txt)) cutting = true;
  }
  if (cutting) {
    dropped++;
    continue;
  }
  o.sessionId = newId;
  kept.push(JSON.stringify(o));
}

const newFile = join(projDir, `${newId}.jsonl`);
writeFileSync(newFile, kept.join("\n") + "\n", "utf8");
console.log(`orig lines: ${lines.length}, kept: ${kept.length}, dropped: ${dropped}`);
console.log(`new session: ${newId}`);

// Resume the truncated session and ask what the last request was.
const q = query({
  prompt: "In ONE short sentence: what was my most recent request to you before this message?",
  options: { cwd, model: "sonnet", resume: newId, allowedTools: [], disallowedTools: ["Bash", "Edit", "Write"] },
});
let text = "";
for await (const m of q) {
  if (m.type === "assistant") for (const b of m.message.content) if (b.type === "text") text += b.text;
}
console.log("\nmodel recalls:", text.trim());
console.log("\nForgot the dropped 'add comment' turn:", !/comment/i.test(text));
console.log("Remembers earlier 'list files' context:", /file|typescript|\bts\b|list/i.test(text));
