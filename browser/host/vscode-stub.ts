import * as fs from "fs";

/**
 * Minimal stand-in for the `vscode` module, aliased in by the browser host
 * build. The shared modules (agent.ts → log.ts, superTools.ts) only touch an
 * output channel and config defaults, so that is all this provides.
 */

function appendLog(line: string) {
  const file = process.env.AGENT_BROWSER_LOG;
  if (!file) return;
  try {
    fs.appendFileSync(file, line + "\n");
  } catch {
    /* logging must never take the host down */
  }
}

export const window = {
  createOutputChannel(name: string) {
    return {
      appendLine: (line: string) => appendLog(`[${name}] ${line}`),
      append: (text: string) => appendLog(`[${name}] ${text}`),
      show: () => {},
      dispose: () => {},
    };
  },
};

export const workspace = {
  getConfiguration() {
    return { get: <T>(_key: string, defaultValue?: T) => defaultValue };
  },
};
