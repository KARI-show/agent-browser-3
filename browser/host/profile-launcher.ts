/**
 * 背景：Extension-only profiles share one Chrome process with cookie/UA overrides.
 * All windows share the same network stack, localStorage, cache, TLS tickets.
 * For full isolation, launch a SEPARATE Chrome process with --user-data-dir
 * per profile = completely independent browser state.
 *
 * 设计意图：Native Host запускает Chrome/Edge с:
 *  - --user-data-dir=/path/to/profile (отдельные cookies, кэш, localStorage, IndexedDB)
 *  - --proxy-server=127.0.0.1:PORT (локальный forwarder → реальный прокси с auth)
 *  - --load-extension=/path/to/extension (наш extension загружается в каждый instance)
 *  - --disable-background-networking (меньше фоновых утечек)
 *
 * 约束：
 *  - Нужен установленный Chrome/Edge на машине
 *  - Extension путь должен быть абсолютным
 *  - Каждый Chrome instance = отдельный процесс, ~100-200MB RAM
 *  - Proxy forwarder запускается через существующий proxy.ts
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn, ChildProcess } from "child_process";
import { startForwarder, Forwarder, Upstream, parseProxyString } from "./proxy";

const PROFILES_DIR = path.join(
  process.env.AGENT_BROWSER_HOME || path.join(os.homedir(), ".agent-browser"),
  "profiles"
);

export interface ProfileConfig {
  id: string;
  name: string;
  proxy?: string;       // "socks5://user:pass@host:port" or "http://host:port"
  startUrl?: string;
  extensionPath?: string; // Path to unpacked extension directory
  extraArgs?: string[];   // Additional Chrome flags
}

interface RunningProfile {
  id: string;
  pid: number;
  process: ChildProcess;
  forwarder?: Forwarder;
  dataDir: string;
  startedAt: number;
}

const running = new Map<string, RunningProfile>();

/**
 * 背景：Chrome/Edge binary 在不同 OS 有不同默认路径。
 * 设计意图：按优先级搜索常见路径，Windows 优先 Edge（新装机都有）。
 */
function findBrowser(): string {
  const isWin = process.platform === "win32";
  const isMac = process.platform === "darwin";

  const candidates = isWin
    ? [
        path.join(process.env["PROGRAMFILES"] || "", "Google", "Chrome", "Application", "chrome.exe"),
        path.join(process.env["PROGRAMFILES(X86)"] || "", "Google", "Chrome", "Application", "chrome.exe"),
        path.join(process.env["LOCALAPPDATA"] || "", "Google", "Chrome", "Application", "chrome.exe"),
        path.join(process.env["PROGRAMFILES(X86)"] || "", "Microsoft", "Edge", "Application", "msedge.exe"),
        path.join(process.env["PROGRAMFILES"] || "", "Microsoft", "Edge", "Application", "msedge.exe"),
      ]
    : isMac
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]
      : [
          "/usr/bin/google-chrome",
          "/usr/bin/google-chrome-stable",
          "/usr/bin/chromium-browser",
          "/usr/bin/chromium",
          "/usr/bin/microsoft-edge",
          "/snap/bin/chromium",
        ];

  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {}
  }
  throw new Error(
    "Chrome/Edge not found. Install Chrome or set CHROME_PATH environment variable."
  );
}

/**
 * 背景：每个 profile 需要独立的 --user-data-dir。
 * 设计意图：创建 PROFILES_DIR/PROFILE_ID/ 目录，Chrome 自动初始化 profile 数据。
 * 如果目录已存在 = 复用上次的 cookies/localStorage/cache（持久化）。
 */
function ensureProfileDir(profileId: string): string {
  const dir = path.join(PROFILES_DIR, profileId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Launch a Chrome/Edge instance with a separate user-data-dir for full isolation.
 * Returns the running profile info.
 */
export async function launchProfile(config: ProfileConfig): Promise<{
  pid: number;
  dataDir: string;
  proxyPort?: number;
}> {
  if (running.has(config.id)) {
    const r = running.get(config.id)!;
    return { pid: r.pid, dataDir: r.dataDir, proxyPort: r.forwarder?.port };
  }

  const browserPath = process.env.CHROME_PATH || findBrowser();
  const dataDir = ensureProfileDir(config.id);

  const args: string[] = [
    `--user-data-dir=${dataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-translate",
    "--metrics-recording-only",
    "--disable-features=ChromeLabs,GlobalMediaControls",
  ];

  // Load our extension if path provided
  if (config.extensionPath) {
    args.push(`--load-extension=${config.extensionPath}`);
    args.push("--whitelisted-extension-id=PLACEHOLDER"); // Chrome needs explicit allow for sidePanel
  }

  // Proxy: start local forwarder that handles auth, Chrome talks to 127.0.0.1
  let forwarder: Forwarder | undefined;
  if (config.proxy) {
    const upstream = parseProxyString(config.proxy);
    forwarder = await startForwarder(upstream);
    args.push(`--proxy-server=http://127.0.0.1:${forwarder.port}`);
  }

  // Extra args
  if (config.extraArgs) {
    args.push(...config.extraArgs);
  }

  // Start URL
  args.push(config.startUrl || "about:blank");

  const child = spawn(browserPath, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  const profile: RunningProfile = {
    id: config.id,
    pid: child.pid!,
    process: child,
    forwarder,
    dataDir,
    startedAt: Date.now(),
  };
  running.set(config.id, profile);

  child.on("exit", () => {
    running.delete(config.id);
    if (forwarder) {
      forwarder.close().catch(() => {});
    }
  });

  return { pid: child.pid!, dataDir, proxyPort: forwarder?.port };
}

/** Stop a running profile's Chrome process and proxy forwarder. */
export function stopProfile(profileId: string): boolean {
  const r = running.get(profileId);
  if (!r) return false;
    try { r.process.kill(); } catch {}
  if (r.forwarder) {
    r.forwarder.close().catch(() => {});
  }
  running.delete(profileId);
  return true;
}

/** List all running profiles. */
export function listRunning(): Array<{ id: string; pid: number; dataDir: string; uptime: number }> {
  const out: Array<{ id: string; pid: number; dataDir: string; uptime: number }> = [];
  for (const [id, r] of running) {
    out.push({ id, pid: r.pid, dataDir: r.dataDir, uptime: Date.now() - r.startedAt });
  }
  return out;
}

/** Delete a profile's data directory (must be stopped first). */
export function deleteProfileData(profileId: string): boolean {
  if (running.has(profileId)) return false;
  const dir = path.join(PROFILES_DIR, profileId);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** List all profile directories (running + saved). */
export function listProfileDirs(): string[] {
  try {
    return fs.readdirSync(PROFILES_DIR).filter((name) => {
      try {
        return fs.statSync(path.join(PROFILES_DIR, name)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}
