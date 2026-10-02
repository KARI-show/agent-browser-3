import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { randomUUID } from "crypto";

/**
 * Conversation rewind. The Agent SDK has no transcript rewind, but sessions are
 * stored as a message tree (JSONL of uuid/parentUuid nodes). To "go back", we
 * write a truncated COPY of the session as a new session id — dropping a chosen
 * user turn and everything after it — then resume that. The original session
 * file is never modified, so this is non-destructive.
 *
 * Verified: resuming the truncated session makes the model forget the dropped
 * turn while keeping all earlier context.
 */

function findSessionFile(sessionId: string): string | null {
  const base = path.join(os.homedir(), ".claude", "projects");
  try {
    for (const dir of fs.readdirSync(base)) {
      const f = path.join(base, dir, sessionId + ".jsonl");
      if (fs.existsSync(f)) return f;
    }
  } catch {
  }
  return null;
}

/** Delete the SDK session file for a conversation that's being removed. */
export function deleteSessionFile(sessionId: string): void {
  const file = findSessionFile(sessionId);
  if (file) {
    try {
      fs.unlinkSync(file);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Drop the `dropUserOrdinal`-th user turn (0-based, counting only real text
 * prompts, not tool results) and everything after it. Returns the new session
 * id, or null if it couldn't be built.
 */
export function truncateSession(
  sessionId: string,
  dropUserOrdinal: number
): string | null {
  const file = findSessionFile(sessionId);
  if (!file) return null;

  let lines: string[];
  try {
    lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  } catch {
    return null;
  }

  const newId = randomUUID();
  const kept: string[] = [];
  let userCount = -1;
  let cutting = false;

  for (const ln of lines) {
    let o: any;
    try {
      o = JSON.parse(ln);
    } catch {
      continue;
    }
    if (!cutting && o.type === "user") {
      const c = o.message?.content;
      const isText =
        typeof c === "string" ||
        (Array.isArray(c) && c.some((b: any) => b.type === "text"));
      if (isText) {
        userCount++;
        if (userCount === dropUserOrdinal) cutting = true;
      }
    }
    if (cutting) continue;
    o.sessionId = newId;
    kept.push(JSON.stringify(o));
  }

  if (kept.length === 0) return null;

  try {
    fs.writeFileSync(path.join(path.dirname(file), newId + ".jsonl"), kept.join("\n") + "\n", "utf8");
  } catch {
    return null;
  }
  return newId;
}
