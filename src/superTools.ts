import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { z } from "zod";
import { spawn, execFile, ChildProcess } from "child_process";

/**
 * "Super tools" — extra in-process tools handed to the agent via an SDK MCP
 * server (createSdkMcpServer). They run in the extension host, so they get full
 * access to VS Code, the filesystem, child processes, and (later) a browser.
 *
 * Everything here is EXPERIMENTAL and gated behind the `agentIde.superTools`
 * setting so it never touches the default/production behaviour.
 *
 * This first cut ships the "Hands" capability: a managed long-running dev server
 * the agent can start, tail logs from, and stop — something the blocking Bash
 * tool can't do.
 */

const MAX_LOG_LINES = 600;

/** A long-running process (dev server, watcher) with a ring buffer of output. */
export class DevServerManager {
  private proc?: ChildProcess;
  private command = "";
  private startedAt = 0;
  private lines: string[] = [];
  private out: vscode.OutputChannel;

  constructor() {
    this.out = vscode.window.createOutputChannel("Agent IDE — Dev Server");
  }

  private push(chunk: string) {
    this.out.append(chunk);
    const parts = chunk.split(/\r?\n/);
    for (const p of parts) {
      if (p === "") continue;
      this.lines.push(p);
    }
    if (this.lines.length > MAX_LOG_LINES) {
      this.lines = this.lines.slice(-MAX_LOG_LINES);
    }
  }

  start(command: string, cwd: string): string {
    this.stop(); // one server at a time
    this.lines = [];
    this.command = command;
    this.startedAt = Date.now();
    this.out.clear();
    this.out.appendLine(`$ ${command}\n`);
    // shell:true so npm scripts / && chains work cross-platform. On POSIX the
    // shell gets its own process group, so stop() can take down the whole tree
    // (sh → npm → node) — killing just the shell leaves the server holding the port.
    const p = spawn(command, { cwd, shell: true, detached: process.platform !== "win32" });
    this.proc = p;
    // A server we already stopped/replaced exits asynchronously; its output and
    // "[process exited]" must not land in the new server's log.
    const live = () => this.proc === p;
    p.stdout?.on("data", (d) => live() && this.push(d.toString()));
    p.stderr?.on("data", (d) => live() && this.push(d.toString()));
    p.on("exit", (code) => live() && this.push(`\n[process exited with code ${code}]\n`));
    p.on("error", (e) => live() && this.push(`\n[spawn error: ${e.message}]\n`));
    return `Started: ${command} (pid ${p.pid ?? "?"})`;
  }

  logs(maxLines = 120): string {
    const tail = this.lines.slice(-maxLines);
    return tail.length ? tail.join("\n") : "(no output yet)";
  }

  status(): string {
    if (!this.proc || this.proc.exitCode !== null) {
      return this.command
        ? `Not running (last: ${this.command}${this.proc ? `, exit ${this.proc.exitCode}` : ""}).`
        : "No dev server has been started.";
    }
    const secs = Math.round((Date.now() - this.startedAt) / 1000);
    return `Running: ${this.command} (pid ${this.proc.pid}, up ${secs}s).`;
  }

  stop(): string {
    if (!this.proc || this.proc.exitCode !== null) return "No running dev server.";
    const pid = this.proc.pid;
    try {
      if (process.platform === "win32" && pid) {
        // Kill the whole tree — npm spawns child node processes.
        execFile("taskkill", ["/pid", String(pid), "/T", "/F"]);
      } else if (pid) {
        // Negative pid = the process group start() created: the whole tree.
        try {
          process.kill(-pid, "SIGTERM");
        } catch {
          this.proc.kill("SIGTERM");
        }
      }
    } catch {
      /* ignore */
    }
    this.proc = undefined;
    return "Stopped the dev server.";
  }

  dispose() {
    this.stop();
    this.out.dispose();
  }
}

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

export interface SuperModules {
  eyes: boolean;
  hands: boolean;
  memory: boolean;
  scale: boolean;
}

export interface SuperToolsDeps {
  cwd: string;
  dev: DevServerManager;
  /** Model + env for nested subagent runs (Scale). */
  model: string;
  env: Record<string, string>;
  /** Optional explicit model for subagents (falls back to `model`). */
  subagentModel?: string;
  /** Which capability modules are enabled (toggled from the header settings). */
  modules: SuperModules;
  /** Emit live progress to the panel (orchestrator rounds, worker fan-out, …). */
  notify?: (text: string) => void;
  /** Cooperative cancel — checked at round boundaries by the orchestrator. */
  aborted?: () => boolean;
  /** When set, `orchestrate` opens a background window instead of running inline. */
  launchOrchestrator?: (goal: string) => void;
}

/** Best-effort JSON extraction from a model response (handles ```json fences). */
function parseJsonLoose(s: string): any {
  if (!s) return null;
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : s;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Run a focused, read-only subagent and return its final text (Scale). Runs on
 * the SAME account/model as the parent (deps.model — e.g. Opus), NOT a cheaper
 * default. Has a hard timeout so a stuck worker can't hang a whole round.
 */
const WORKER_EDIT_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit)$/;

/** The LEAD answers a worker's question (workers are headless — no user UI). */
async function answerAsLead(
  sdk: any,
  deps: SuperToolsDeps,
  questionInput: any,
  workerTask: string
): Promise<string> {
  const qs = (questionInput?.questions || [])
    .map((q: any, i: number) => {
      const opts = (q.options || [])
        .map((o: any) => `  - ${o.label}${o.description ? ` (${o.description})` : ""}`)
        .join("\n");
      return `Q${i + 1} [${q.header || ""}]: ${q.question}\n${opts}`;
    })
    .join("\n\n");
  const prompt =
    `You are the LEAD of a research team. A worker is investigating this task:\n"${workerTask}"\n\n` +
    `The worker asked:\n${qs}\n\n` +
    `Answer decisively and concisely so the worker can proceed. If options are listed, ` +
    `pick one (or give a clear directive). Do NOT ask anything back — just answer.`;
  // Leaf call (default opts → AskUserQuestion disallowed, so no recursion).
  return runSubagent(sdk, deps, prompt);
}

async function runSubagent(
  sdk: any,
  deps: SuperToolsDeps,
  task: string,
  opts: { timeoutMs?: number; leadAnswers?: boolean } = {}
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 180000;
  const queryOptions: any = {
    cwd: deps.cwd,
    // Explicit model = same as the parent run (capable, not Haiku).
    model: deps.subagentModel || deps.model,
    env: deps.env,
    // plan mode: the subagent investigates and reports — it never edits, so
    // parallel subagents can't conflict with the main agent's changes.
    permissionMode: "plan",
  };
  if (opts.leadAnswers) {
    // Route the worker's questions to the LEAD instead of a (nonexistent) UI.
    queryOptions.canUseTool = async (toolName: string, input: Record<string, unknown>) => {
      if (toolName === "AskUserQuestion") {
        const ans = await answerAsLead(sdk, deps, input, task);
        return { behavior: "deny", message: `Your lead answered: ${ans}` } as const;
      }
      if (WORKER_EDIT_TOOLS.test(toolName)) {
        return { behavior: "deny", message: "Workers are read-only." } as const;
      }
      return { behavior: "allow", updatedInput: input } as const;
    };
  } else {
    // Headless leaf agents have no UI — AskUserQuestion would hang them.
    queryOptions.disallowedTools = ["AskUserQuestion"];
  }
  const q = sdk.query({ prompt: task, options: queryOptions });

  let out = "";
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      (q as any).interrupt?.();
    } catch {
      /* ignore */
    }
  }, timeoutMs);

  try {
    for await (const m of q as AsyncIterable<any>) {
      if (m.type === "assistant") {
        for (const b of m.message.content) {
          if (b.type === "text") out += b.text;
        }
      } else if (m.type === "result") {
        break;
      }
    }
  } catch {
    /* a failed/aborted subagent just yields whatever text it produced */
  } finally {
    clearTimeout(timer);
  }

  const trimmed = out.trim();
  if (trimmed) return trimmed;
  return timedOut ? "(subagent timed out)" : "(subagent returned nothing)";
}

/**
 * Iterative multi-agent orchestrator (Scale 2.0). Breaks a goal into angles,
 * fans out PARALLEL read-only workers, collects their findings, and re-plans each
 * round (a lead agent that tasks other agents) until it can return a final
 * consolidated plan — streaming progress to the panel the whole time.
 */
export async function runOrchestrate(
  sdk: any,
  deps: SuperToolsDeps,
  goal: string,
  maxRounds: number,
  maxWorkers: number
): Promise<string> {
  const notify = deps.notify ?? (() => {});
  const isAborted = deps.aborted ?? (() => false);
  const accumulated: { round: number; angle: string; findings: string }[] = [];
  notify(`🧭 Orchestrator: analyzing goal — “${goal.slice(0, 90)}”`);

  for (let round = 1; round <= maxRounds; round++) {
    if (isAborted()) {
      notify("🛑 Stopped.");
      return "Orchestration stopped by user.";
    }
    const prior = accumulated.length
      ? accumulated.map((a) => `### [R${a.round}] ${a.angle}\n${a.findings}`).join("\n\n")
      : "none yet";
    const planPrompt =
      `You are the LEAD coordinating a team of parallel READ-ONLY workers toward this GOAL:\n${goal}\n\n` +
      `Findings gathered so far (from prior workers):\n${prior}\n\n` +
      `First CRITIQUE the prior findings: which are solid, which are weak, shallow, ` +
      `contradictory, unverified, or off-track? Then decide the next step — issue ` +
      `CORRECTIVE tasks where a worker was wrong/shallow/missed something (tell them ` +
      `exactly what to re-check or fix), plus new-angle tasks for remaining gaps.\n\n` +
      `Respond with ONLY a JSON object (no prose, no fences):\n` +
      `{\n` +
      `  "critique": "string",      // brief assessment of prior findings; "" on round 1\n` +
      `  "done": boolean,           // true when findings are solid & complete enough for a final plan\n` +
      `  "summary": "string",       // REQUIRED when done: final prioritized actionable plan, reconciling/correcting findings\n` +
      `  "tasks": [                 // when NOT done: independent tasks (parallel), each a different angle or a correction\n` +
      `    { "angle": "short label", "task": "self-contained instruction; if correcting a prior worker, state what was wrong and what to verify/redo" }\n` +
      `  ]\n}\n` +
      `Tasks must be independent (run in parallel). At most ${maxWorkers}. Prefer fewer, sharper, corrective tasks.`;

    notify(`🧭 Round ${round}: lead reviewing & planning…`);
    const planRaw = await runSubagent(sdk, deps, planPrompt);
    const plan = parseJsonLoose(planRaw);

    if (!plan) return planRaw; // unparseable → treat lead text as the answer
    if (plan.critique && String(plan.critique).trim()) {
      notify(`🔍 Lead critique: ${String(plan.critique).slice(0, 160)}`);
    }
    if (plan.done) {
      notify(`🧭 Done after ${round - 1} round(s).`);
      return plan.summary || planRaw;
    }

    let tasks: { angle: string; task: string }[] = Array.isArray(plan.tasks) ? plan.tasks : [];
    tasks = tasks.filter((t) => t && t.task).slice(0, maxWorkers);
    if (!tasks.length) return plan.summary || "Orchestrator produced no tasks.";

    notify(`🧭 Round ${round}: ${tasks.length} workers → ${tasks.map((t) => t.angle || "?").join(", ")}`);

    // allSettled: one worker failing must NOT lose the round's other findings.
    const settled = await Promise.allSettled(
      tasks.map((t) => {
        const wp =
          `You are ONE worker on a team. GOAL:\n${goal}\n\nYour angle: ${t.angle}\nYour task: ${t.task}\n\n` +
          `Investigate (READ-ONLY) and report concise, concrete findings and specific recommendations for YOUR angle only. Do not edit files.`;
        return runSubagent(sdk, deps, wp, { leadAnswers: true });
      })
    );
    let okCount = 0;
    settled.forEach((s, i) => {
      const angle = tasks[i].angle || "worker";
      if (s.status === "fulfilled") {
        okCount++;
        accumulated.push({ round, angle, findings: s.value });
      } else {
        accumulated.push({ round, angle, findings: `(worker failed: ${s.reason?.message ?? s.reason})` });
      }
    });
    notify(`🧭 Round ${round}: collected ${okCount}/${tasks.length} report(s).`);
  }

  notify("🧭 Synthesizing final plan…");
  const all = accumulated.map((a) => `### [R${a.round}] ${a.angle}\n${a.findings}`).join("\n\n");
  const synth =
    `GOAL:\n${goal}\n\nAll worker findings across rounds:\n${all}\n\n` +
    `Produce the FINAL consolidated, prioritized, concrete and actionable plan/answer for the goal.`;
  return await runSubagent(sdk, deps, synth);
}

/** Path to the per-project memory file the agent maintains across sessions. */
function memoryPath(cwd: string): string {
  return path.join(cwd, ".agent-ide", "memory.md");
}

// ----- Eyes: headless-browser screenshots via the system Chrome/Edge -----
// No heavy dependency: we drive the browser's built-in `--headless --screenshot`
// CLI, so the agent can SEE a running page (and dump its rendered DOM).
let cachedBrowser: string | null | undefined;
function findBrowser(): string | undefined {
  if (cachedBrowser !== undefined) return cachedBrowser ?? undefined;
  const pf = process.env["ProgramFiles"] || "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const local = process.env.LOCALAPPDATA || "";
  const candidates =
    process.platform === "win32"
      ? [
          path.join(pf86, "Microsoft\\Edge\\Application\\msedge.exe"),
          path.join(pf, "Microsoft\\Edge\\Application\\msedge.exe"),
          path.join(pf, "Google\\Chrome\\Application\\chrome.exe"),
          path.join(pf86, "Google\\Chrome\\Application\\chrome.exe"),
          local ? path.join(local, "Google\\Chrome\\Application\\chrome.exe") : "",
        ]
      : process.platform === "darwin"
        ? [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
          ]
        : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge"];
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c)) {
        cachedBrowser = c;
        return c;
      }
    } catch {
      /* ignore */
    }
  }
  cachedBrowser = null;
  return undefined;
}

function runBrowser(browser: string, args: string[], timeoutMs = 20000): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(browser, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      // Chrome/Edge often exit non-zero in headless one-shot mode even on success;
      // the screenshot file / stdout is what matters, so don't treat code as fatal.
      resolve({ stdout: stdout?.toString() ?? "" });
      void err;
      void reject;
    });
  });
}

/**
 * Build the SDK MCP server exposing the super tools. `sdk` is the dynamically
 * imported @anthropic-ai/claude-agent-sdk module (ESM), so we use its `tool`
 * and `createSdkMcpServer` helpers with the same bundled zod.
 */
export function createSuperToolsServer(sdk: any, deps: SuperToolsDeps): any {
  const { cwd, dev } = deps;

  const devStart = sdk.tool(
    "dev_server_start",
    "Start a long-running dev server / watcher (e.g. 'npm run dev'). Replaces any " +
      "previously started one. Returns immediately; use dev_server_logs to read output.",
    { command: z.string().describe("The shell command to run, e.g. 'npm run dev'") },
    async (args: { command: string }) => text(dev.start(args.command, cwd))
  );

  const devLogs = sdk.tool(
    "dev_server_logs",
    "Read recent output (stdout+stderr) from the running dev server. Use this to " +
      "see compile errors, request logs, or whether it booted.",
    { maxLines: z.number().int().min(1).max(600).optional().describe("How many trailing lines (default 120)") },
    async (args: { maxLines?: number }) => text(dev.logs(args.maxLines ?? 120))
  );

  const devStatus = sdk.tool(
    "dev_server_status",
    "Check whether the dev server is running, its command and uptime.",
    {},
    async () => text(dev.status())
  );

  const devStop = sdk.tool(
    "dev_server_stop",
    "Stop the running dev server (kills the whole process tree).",
    {},
    async () => text(dev.stop())
  );

  // ----- Scale: subagents -----
  const spawnSubagent = sdk.tool(
    "spawn_subagent",
    "Delegate a focused, READ-ONLY investigation to a parallel subagent and get " +
      "its written report back. Great for 'analyze X', 'find everywhere we do Y', " +
      "'summarize how Z works'. The subagent cannot edit files. Call it multiple " +
      "times for parallel research.",
    {
      task: z
        .string()
        .describe("A self-contained task for the subagent, e.g. 'Map how auth works across the codebase and list the key files.'"),
    },
    async (args: { task: string }) => text(await runSubagent(sdk, deps, args.task, { leadAnswers: true }))
  );

  const orchestrate = sdk.tool(
    "orchestrate",
    "Run a MULTI-ROUND orchestrator for a big, open-ended goal. A lead agent breaks " +
      "the goal into angles, fans out PARALLEL read-only worker subagents to investigate " +
      "each, collects their findings, then re-plans the next round — looping until it can " +
      "return a final consolidated, prioritized plan. Use for goals like 'improve the UI', " +
      "'audit performance', 'plan a refactor'. Progress streams live to the panel.",
    {
      goal: z.string().describe("The high-level goal to orchestrate toward."),
      maxRounds: z.number().int().min(1).max(6).optional().describe("Max planning rounds (default 3)."),
      maxWorkers: z.number().int().min(1).max(10).optional().describe("Max parallel workers per round (default 4)."),
    },
    async (args: { goal: string; maxRounds?: number; maxWorkers?: number }) => {
      // Prefer the background window so the chat stays free; fall back to inline.
      if (deps.launchOrchestrator) {
        deps.launchOrchestrator(args.goal);
        return text(
          `Orchestration started in a separate background window for: "${args.goal}". ` +
            `It runs independently — you can keep working here; the final plan appears in that window.`
        );
      }
      return text(await runOrchestrate(sdk, deps, args.goal, args.maxRounds ?? 3, args.maxWorkers ?? 4));
    }
  );

  // ----- Memory: persistent project notes -----
  const memoryRead = sdk.tool(
    "project_memory_read",
    "Read the persistent project memory (.agent-ide/memory.md) — decisions, " +
      "conventions, architecture notes you saved earlier. Read this early to " +
      "recall context across sessions.",
    {},
    async () => {
      try {
        const p = memoryPath(cwd);
        if (!fs.existsSync(p)) return text("(no project memory yet)");
        return text(fs.readFileSync(p, "utf8") || "(empty)");
      } catch (e: any) {
        return text(`Could not read memory: ${e?.message || e}`);
      }
    }
  );

  const memoryWrite = sdk.tool(
    "project_memory_write",
    "Save a durable note to project memory (.agent-ide/memory.md) so it survives " +
      "across sessions. Use 'append' to add, 'replace' to overwrite everything.",
    {
      content: z.string().describe("Markdown note to store."),
      mode: z.enum(["append", "replace"]).optional().describe("append (default) or replace"),
    },
    async (args: { content: string; mode?: "append" | "replace" }) => {
      try {
        const p = memoryPath(cwd);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        if (args.mode === "replace") {
          fs.writeFileSync(p, args.content, "utf8");
        } else {
          const prev = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
          fs.writeFileSync(p, (prev ? prev.trimEnd() + "\n\n" : "") + args.content + "\n", "utf8");
        }
        return text(`Saved to project memory (${args.mode || "append"}).`);
      } catch (e: any) {
        return text(`Could not write memory: ${e?.message || e}`);
      }
    }
  );

  // ----- Eyes: headless browser -----
  const browserShot = sdk.tool(
    "browser_screenshot",
    "Open a URL in a headless browser and return a SCREENSHOT image so you can SEE " +
      "the page. Use this to visually verify UI changes or check a running dev server.",
    {
      url: z.string().describe("URL to open, e.g. http://localhost:3000"),
      width: z.number().int().min(200).max(3840).optional().describe("viewport width (default 1280)"),
      height: z.number().int().min(200).max(2160).optional().describe("viewport height (default 800)"),
    },
    async (args: { url: string; width?: number; height?: number }) => {
      const browser = findBrowser();
      if (!browser) {
        return text("No Chrome/Edge found to take a screenshot. Install Google Chrome or Microsoft Edge.");
      }
      const w = args.width ?? 1280;
      const h = args.height ?? 800;
      const out = path.join(os.tmpdir(), `agentide-shot-${Date.now()}.png`);
      await runBrowser(browser, [
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        `--screenshot=${out}`,
        `--window-size=${w},${h}`,
        args.url,
      ]);
      if (!fs.existsSync(out)) {
        return text(`Screenshot failed — no image produced. Is ${args.url} reachable?`);
      }
      const data = fs.readFileSync(out).toString("base64");
      try {
        fs.unlinkSync(out);
      } catch {
        /* ignore */
      }
      return {
        content: [
          { type: "image" as const, data, mimeType: "image/png" },
          { type: "text" as const, text: `Screenshot of ${args.url} (${w}x${h}).` },
        ],
      };
    }
  );

  const browserHtml = sdk.tool(
    "browser_html",
    "Open a URL in a headless browser and return its RENDERED DOM (after JS runs). " +
      "Use to inspect live markup, find selectors, or read dynamically-generated content.",
    { url: z.string().describe("URL to open") },
    async (args: { url: string }) => {
      const browser = findBrowser();
      if (!browser) return text("No Chrome/Edge found. Install Google Chrome or Microsoft Edge.");
      const { stdout } = await runBrowser(browser, ["--headless=new", "--disable-gpu", "--dump-dom", args.url]);
      const html = stdout.slice(0, 20000);
      return text(html ? html + (stdout.length > 20000 ? "\n…(truncated)…" : "") : "(no DOM returned)");
    }
  );

  // Only expose the tools for the capability modules that are enabled.
  const m = deps.modules;
  const tools: any[] = [];
  if (m.hands) tools.push(devStart, devLogs, devStatus, devStop);
  if (m.scale) tools.push(spawnSubagent, orchestrate);
  if (m.memory) tools.push(memoryRead, memoryWrite);
  if (m.eyes) tools.push(browserShot, browserHtml);

  return sdk.createSdkMcpServer({
    name: "agentide-tools",
    version: "0.1.0",
    tools,
  });
}
