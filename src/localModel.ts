import * as vscode from "vscode";
import { spawn, ChildProcess } from "child_process";
import { log } from "./log";

/**
 * Hybrid engine: runs the bundled Anthropic↔OpenAI proxy as a child process so
 * the Claude Agent SDK can talk to a LOCAL OpenAI-compatible runtime (LM Studio,
 * llama.cpp, Ollama) instead of the Anthropic API. Starting it sets
 * `agentIde.baseUrl`; stopping clears it — so the whole extension transparently
 * switches between the Claude subscription and a local model.
 *
 * We spawn the SAME executable that hosts the extension with
 * ELECTRON_RUN_AS_NODE=1, so it runs as plain Node — no dependency on a separate
 * `node` being on PATH.
 */
export class LocalModelManager {
  private proc?: ChildProcess;
  private port = 8787;

  constructor(private readonly proxyScript: string) {}

  get running(): boolean {
    return !!this.proc && this.proc.exitCode === null;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  start(opts: { port: number; upstream: string; model?: string }): void {
    this.stop(); // one proxy at a time
    this.port = opts.port;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      PORT: String(opts.port),
      UPSTREAM: opts.upstream,
      UPSTREAM_MODEL: opts.model ?? "",
    };
    log.info(`[local-model] starting proxy on ${this.baseUrl} → ${opts.upstream}`);
    this.proc = spawn(process.execPath, [this.proxyScript], { env });
    this.proc.stdout?.on("data", (d) => log.info("[local-model] " + d.toString().trimEnd()));
    this.proc.stderr?.on("data", (d) => log.warn("[local-model] " + d.toString().trimEnd()));
    this.proc.on("exit", (code) => log.info(`[local-model] proxy exited (code ${code})`));
    this.proc.on("error", (e) => log.error("[local-model] spawn error", e));
  }

  stop(): void {
    if (this.proc && this.proc.exitCode === null) {
      try {
        this.proc.kill();
      } catch {
        /* ignore */
      }
    }
    this.proc = undefined;
  }

  dispose(): void {
    this.stop();
  }
}
