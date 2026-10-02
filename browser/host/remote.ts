import { spawn, ChildProcess } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as net from "net";
import * as path from "path";
import { TunnelManager } from "../../src/tunnel";
import { log } from "../../src/log";

/** build.mjs ships relay/hub.mjs, relay/bot.mjs and the web app next to host.js. */
const RELAY_DIR = path.join(__dirname, "relay");

export interface RemoteInfo {
  /** Where the side panel joins as a node (loopback). */
  relayUrl: string;
  token: string;
  /** Public https address for the phone; empty if the tunnel failed. */
  publicUrl: string;
  tunnelError?: string;
  /** Whether the relay's Telegram bot (navigation + Mini App) is running. */
  bot: boolean;
}

/**
 * Remote access for the browser extension without VS Code: the same pieces
 * VS Code's "Agent IDE: Remote" runs — the relay hub on loopback, a cloudflared
 * quick tunnel for a public https address, and the Telegram bot — owned by a
 * helper process that lives as long as the side panel's port to it.
 */
export class RemoteServices {
  private relay?: ChildProcess;
  private bot?: ChildProcess;
  private tunnel?: TunnelManager;
  private readonly token = crypto.randomBytes(16).toString("hex");

  constructor(private readonly dataDir: string) {}

  async start(opts: { botToken?: string; userId?: string }): Promise<RemoteInfo> {
    const hub = path.join(RELAY_DIR, "hub.mjs");
    if (!fs.existsSync(hub)) throw new Error("This helper has no relay files — reinstall or update the helper.");
    this.stop();

    // A fresh free port each time: never collides with VS Code's own relay
    // (8790) or a relay a crashed helper left behind with another token.
    const port = await freePort();
    this.relay = this.spawnNode("relay", hub, { RELAY_TOKEN: this.token, PORT: String(port), RELAY_HOST: "127.0.0.1" });
    await this.waitForRelay(port);
    const relayUrl = `ws://127.0.0.1:${port}`;

    let publicUrl = "";
    let tunnelError: string | undefined;
    try {
      this.tunnel = new TunnelManager(path.join(this.dataDir, "bin"));
      publicUrl = await this.tunnel.ensure(port);
    } catch (e) {
      tunnelError = (e as Error).message;
      log.warn(`remote: no public tunnel — ${tunnelError}`);
    }

    const botToken = (opts.botToken || "").trim();
    const userId = (opts.userId || "").trim();
    let bot = false;
    if (botToken && userId) {
      this.bot = this.spawnNode("bot", path.join(RELAY_DIR, "bot.mjs"), {
        BOT_TOKEN: botToken,
        TG_USER_ID: userId,
        RELAY_URL: relayUrl,
        RELAY_TOKEN: this.token,
        PUBLIC_URL: publicUrl,
        BOT_APP_NAME: "Agent Browser",
        BOT_EMPTY_HINT: "Nothing online yet — keep the Agent Browser side panel open, then tap Refresh.",
      });
      bot = true;
    }
    log.info(`remote: relay ${relayUrl}, public ${publicUrl || "—"}, bot ${bot ? "on" : "off"}`);
    return { relayUrl, token: this.token, publicUrl, tunnelError, bot };
  }

  stop() {
    this.tunnel?.dispose();
    this.tunnel = undefined;
    for (const cp of [this.bot, this.relay]) {
      if (cp && cp.exitCode === null) {
        try {
          cp.kill();
        } catch {
          /* already gone */
        }
      }
    }
    this.bot = undefined;
    this.relay = undefined;
  }

  private spawnNode(name: string, script: string, env: Record<string, string>): ChildProcess {
    // stdout is this host's native-messaging channel: a child must never inherit
    // it (one stray line would corrupt the protocol). Its output goes to host.log.
    const cp = spawn(process.execPath, [script], {
      cwd: RELAY_DIR,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    cp.stdout?.on("data", (d) => log.info(`${name}: ${String(d).trim()}`));
    cp.stderr?.on("data", (d) => log.warn(`${name}: ${String(d).trim()}`));
    cp.on("exit", (code) => log.info(`${name} exited (${code})`));
    cp.on("error", (e) => log.error(`${name} failed to start`, e));
    return cp;
  }

  private async waitForRelay(port: number) {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (!this.relay || this.relay.exitCode !== null) {
        throw new Error("The relay exited right after starting — see ~/.agent-browser/host.log.");
      }
      try {
        const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1000) });
        if (r.ok) return;
      } catch {
        /* not listening yet */
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("The relay didn't start in time — see ~/.agent-browser/host.log.");
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}
