import { spawn, execFile, ChildProcess } from "child_process";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { log } from "./log";

/**
 * Auto-managed cloudflared "quick tunnel" — gives the local relay a public HTTPS
 * URL (https://xxxx.trycloudflare.com) with zero config: no account, no domain.
 * The binary is located on PATH or downloaded per-platform into a cache dir, so
 * end users install nothing. The URL is ephemeral (changes per run) — fine,
 * because the Telegram bot hands out the current URL dynamically.
 */
export class TunnelManager {
  private proc?: ChildProcess;
  private url?: string;
  private bin?: string;

  constructor(private readonly cacheDir: string) {}

  get publicUrl(): string | undefined {
    return this.url;
  }

  /** Ensure a REACHABLE tunnel to the given local port; returns the public https
   *  URL. cloudflared occasionally hands out a URL that never resolves — so we
   *  verify each one end-to-end and regenerate (new URL) until one answers. */
  async ensure(port: number, configuredPath?: string): Promise<string> {
    if (this.url && this.proc && this.proc.exitCode === null && (await this.verify(this.url))) {
      return this.url;
    }
    const bin = await this.resolveBinary(configuredPath);
    // Reap any cloudflared left pointing at our port by a previous session that
    // didn't shut down cleanly (host crash / reload race) — so we never stack up
    // orphaned tunnels.
    await this.killStrayTunnels(port);
    for (let attempt = 1; attempt <= 3; attempt++) {
      this.dispose(); // kill any previous (dead) tunnel
      let url: string;
      try {
        url = await this.spawnTunnel(bin, port);
      } catch (e: any) {
        log.warn(`cloudflared: start failed (attempt ${attempt}) — ${e?.message ?? e}`);
        continue;
      }
      if (await this.verify(url)) return url;
      log.warn(`cloudflared: ${url} not reachable (attempt ${attempt}) — regenerating`);
    }
    throw new Error("cloudflared tunnel could not be established (3 attempts)");
  }

  /** Hit the public URL until it answers 200 (DNS may take a few seconds). */
  private async verify(url: string): Promise<boolean> {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(url + "/healthz", { signal: AbortSignal.timeout(4000) });
        if (r.ok) return true;
      } catch {
        /* DNS not propagated / tunnel not live yet — retry */
      }
      await new Promise((res) => setTimeout(res, 1500));
    }
    return false;
  }

  dispose() {
    this.killProc(this.proc);
    this.proc = undefined;
    this.url = undefined;
  }

  /** Force-kill a tracked child + its tree. On Windows, Node's ChildProcess.kill()
   *  frequently leaves cloudflared.exe alive; taskkill /T /F reliably reaps it. */
  private killProc(proc?: ChildProcess) {
    if (!proc || proc.pid == null) return;
    const pid = proc.pid;
    if (process.platform === "win32") {
      try {
        execFile("taskkill", ["/PID", String(pid), "/T", "/F"], () => {});
      } catch {
        try { proc.kill(); } catch { /* ignore */ }
      }
    } else {
      try { proc.kill("SIGTERM"); } catch { /* ignore */ }
    }
  }

  /** Best-effort: kill cloudflared processes tunneling OUR local port that aren't
   *  tracked by this instance (orphans from a crashed/reloaded previous session). */
  private killStrayTunnels(port: number): Promise<void> {
    return new Promise((resolve) => {
      const myPid = this.proc?.pid;
      if (process.platform === "win32") {
        // Match by command line so we only touch tunnels for our port, never the
        // user's other cloudflared instances.
        const ps =
          `Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" | ` +
          `Where-Object { $_.CommandLine -like '*127.0.0.1:${port}*'` +
          (myPid ? ` -and $_.ProcessId -ne ${myPid}` : "") +
          ` } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
        execFile(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-Command", ps],
          () => resolve()
        );
      } else {
        // pkill -f matches against the full command line; exclude nothing fancy —
        // a fresh spawn happens right after, so reaping our own dead one is fine.
        execFile("pkill", ["-f", `cloudflared.*127\\.0\\.0\\.1:${port}`], () => resolve());
      }
    });
  }

  // ── binary resolution ──────────────────────────────────────────────────
  private async resolveBinary(configuredPath?: string): Promise<string> {
    if (configuredPath && fs.existsSync(configuredPath)) return configuredPath;
    if (this.bin && fs.existsSync(this.bin)) return this.bin;
    const onPath = await this.onPath();
    if (onPath) return (this.bin = onPath);
    const cached = this.cachedBinPath();
    if (fs.existsSync(cached)) return (this.bin = cached);
    log.info("cloudflared: downloading (one-time)…");
    await this.download(cached);
    return (this.bin = cached);
  }

  private onPath(): Promise<string | undefined> {
    return new Promise((res) => {
      execFile("cloudflared", ["--version"], (err) => res(err ? undefined : "cloudflared"));
    });
  }

  private cachedBinPath(): string {
    return path.join(this.cacheDir, process.platform === "win32" ? "cloudflared.exe" : "cloudflared");
  }

  private asset(): { name: string; tgz: boolean } {
    const a = process.arch;
    if (process.platform === "win32") {
      return { name: "cloudflared-windows-amd64.exe", tgz: false }; // amd64 runs under arm emulation
    }
    if (process.platform === "darwin") {
      return { name: a === "arm64" ? "cloudflared-darwin-arm64.tgz" : "cloudflared-darwin-amd64.tgz", tgz: true };
    }
    const arch = a === "arm64" ? "arm64" : a === "arm" ? "arm" : "amd64";
    return { name: `cloudflared-linux-${arch}`, tgz: false };
  }

  private async download(dest: string): Promise<void> {
    await fsp.mkdir(this.cacheDir, { recursive: true });
    const { name, tgz } = this.asset();
    const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/${name}`;
    const resp = await fetch(url, { redirect: "follow" });
    if (!resp.ok) throw new Error(`cloudflared download failed: HTTP ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    if (tgz) {
      // macOS ships a .tgz containing a single `cloudflared` binary — extract it.
      const tmp = path.join(this.cacheDir, "cf.tgz");
      await fsp.writeFile(tmp, buf);
      await new Promise<void>((res, rej) =>
        execFile("tar", ["-xzf", tmp, "-C", this.cacheDir], (e) => (e ? rej(e) : res()))
      );
      await fsp.rename(path.join(this.cacheDir, "cloudflared"), dest).catch(() => {});
      await fsp.unlink(tmp).catch(() => {});
      if (process.platform !== "win32") await fsp.chmod(dest, 0o755);
    } else {
      // Write-then-rename: a crash mid-write must not leave a truncated binary
      // at `dest`, which resolveBinary() would then trust forever.
      const part = dest + ".part";
      await fsp.writeFile(part, buf);
      if (process.platform !== "win32") await fsp.chmod(part, 0o755);
      await fsp.rename(part, dest);
    }
  }

  // ── tunnel process ─────────────────────────────────────────────────────
  private spawnTunnel(bin: string, port: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const cp = spawn(bin, [
        "tunnel",
        "--no-autoupdate",
        "--url",
        `http://127.0.0.1:${port}`,
      ]);
      this.proc = cp;
      let settled = false;
      const onData = (d: Buffer) => {
        const s = d.toString();
        const m = s.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
        if (m && !settled) {
          settled = true;
          this.url = m[0];
          log.info("cloudflared: tunnel up → " + this.url);
          resolve(this.url);
        }
      };
      cp.stdout?.on("data", onData);
      cp.stderr?.on("data", onData); // cloudflared prints the URL to stderr
      cp.on("exit", (code) => {
        log.info("cloudflared exited (" + code + ")");
        // A tunnel we killed while regenerating exits asynchronously — only the
        // CURRENT process may clear the URL, or it wipes the live replacement's.
        if (this.proc === cp) this.url = undefined;
        if (!settled) {
          settled = true;
          reject(new Error("cloudflared exited before a URL was assigned"));
        }
      });
      cp.on("error", (e) => {
        if (!settled) {
          settled = true;
          reject(e);
        }
      });
      setTimeout(() => {
        if (!settled) {
          settled = true;
          this.killProc(cp); // don't leave a URL-less cloudflared running
          reject(new Error("cloudflared timed out (no URL in 25s)"));
        }
      }, 25000);
    });
  }
}
