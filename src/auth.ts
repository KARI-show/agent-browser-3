import * as fs from "fs";
import * as path from "path";

/**
 * True if the machine has some Claude credentials: an API key, or a
 * subscription login left behind by `claude login`. Shared by the VS Code
 * panel and the browser host so both gate runs the same way.
 */
export function hasClaudeCredentials(apiKey?: string): boolean {
  if (apiKey) return true;
  if (process.env.ANTHROPIC_API_KEY) return true;
  const home = process.env.USERPROFILE || process.env.HOME;
  if (!home) return false;
  try {
    const f = path.join(home, ".claude.json");
    if (fs.existsSync(f)) {
      const j = JSON.parse(fs.readFileSync(f, "utf8"));
      if (j && j.oauthAccount) return true;
    }
  } catch {
    /* ignore */
  }
  try {
    if (fs.existsSync(path.join(home, ".claude", ".credentials.json"))) return true;
  } catch {
    /* ignore */
  }
  return false;
}
