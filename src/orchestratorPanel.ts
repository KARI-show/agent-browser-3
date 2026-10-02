import * as vscode from "vscode";
import * as crypto from "crypto";
import { runOrchestrate, SuperToolsDeps, DevServerManager } from "./superTools";
import { log } from "./log";

/**
 * A standalone "Orchestrator" window (WebviewPanel, opened beside the editor —
 * draggable out to its own OS window). It runs the multi-round orchestrator in
 * the BACKGROUND so the user keeps chatting in the main panel while a lead agent
 * fans out parallel workers here and streams progress.
 *
 * The window opens immediately and is always closeable (tab ✕ or its Close
 * button). If no goal is supplied it shows a goal field + Start, so there's no
 * separate modal to dismiss.
 */
export interface OrchestratorOpts {
  model: string;
  maxRounds: number;
  maxWorkers: number;
}

export class OrchestratorPanel {
  private panel: vscode.WebviewPanel;
  private running = false;
  private abortFlag = false;

  constructor(
    private readonly dev: DevServerManager,
    private readonly opts: OrchestratorOpts,
    goal?: string
  ) {
    this.panel = vscode.window.createWebviewPanel(
      "agentIdeOrchestrator",
      "🧭 Orchestrator",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage((m) => {
      if (m?.type === "start") {
        const g = (m.goal || "").trim();
        if (g && !this.running) void this.run(g);
      } else if (m?.type === "stop") {
        this.abortFlag = true;
        this.post({ type: "log", text: "🛑 Stopping after the current round…" });
      } else if (m?.type === "close") {
        this.panel.dispose();
      }
    });
    this.panel.onDidDispose(() => {
      this.abortFlag = true;
    });

    const g = (goal || "").trim();
    if (g) {
      void this.run(g);
    } else {
      this.post({ type: "idle" });
    }
  }

  private post(m: unknown) {
    this.panel.webview.postMessage(m);
  }

  /** Persist the final plan so it survives closing the window (it used to live
   *  only in the webview and was lost on close). Best-effort. */
  private async persist(cwd: string, goal: string, result: string) {
    try {
      const dir = vscode.Uri.joinPath(vscode.Uri.file(cwd), ".agent-ide", "orchestrator");
      await vscode.workspace.fs.createDirectory(dir);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const file = vscode.Uri.joinPath(dir, `${stamp}.md`);
      const body = `# Orchestrator result\n\n**Goal:** ${goal}\n\n---\n\n${result}\n`;
      await vscode.workspace.fs.writeFile(file, Buffer.from(body, "utf8"));
      this.post({ type: "log", text: `💾 Saved plan → ${vscode.workspace.asRelativePath(file)}` });
    } catch {
      /* best-effort — never fail the run over persistence */
    }
  }

  private async run(goal: string) {
    if (this.running) return;
    this.running = true;
    this.abortFlag = false;
    this.post({ type: "start", goal });

    const cfg = vscode.workspace.getConfiguration("agentIde");
    const apiKey = cfg.get<string>("apiKey") || undefined;
    const baseUrl = cfg.get<string>("baseUrl") || undefined;
    const folder = vscode.workspace.workspaceFolders?.[0];
    const cwd = folder?.uri.fsPath || process.cwd();

    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    if (apiKey) env.ANTHROPIC_API_KEY = apiKey;
    else delete env.ANTHROPIC_API_KEY;
    if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl;

    try {
      const sdk = await import("@anthropic-ai/claude-agent-sdk");
      const deps: SuperToolsDeps = {
        cwd,
        dev: this.dev,
        model: this.opts.model,
        env,
        modules: { eyes: false, hands: false, memory: false, scale: true },
        subagentModel: cfg.get<string>("subagentModel") || undefined,
        notify: (t) => this.post({ type: "log", text: t }),
        aborted: () => this.abortFlag,
      };
      const result = await runOrchestrate(
        sdk,
        deps,
        goal,
        this.opts.maxRounds,
        this.opts.maxWorkers
      );
      this.post({ type: "result", text: result });
      void this.persist(cwd, goal, result);
      if (!this.abortFlag) {
        vscode.window.showInformationMessage("🧭 Orchestrator finished.", "Show").then((s) => {
          if (s) this.panel.reveal(vscode.ViewColumn.Beside);
        });
      }
    } catch (e: any) {
      log.error("orchestrator run failed", e);
      this.post({ type: "error", text: e?.message || String(e) });
    } finally {
      this.running = false;
    }
  }

  private html(): string {
    const nonce = crypto.randomBytes(16).toString("base64");
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    return `<!DOCTYPE html><html><head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
    background: var(--vscode-editor-background); margin: 0; padding: 16px; }
  h2 { margin: 0 0 4px; font-size: 1.05em; }
  .goal { opacity: .8; font-size: .9em; margin-bottom: 12px; }
  #setup { display:flex; flex-direction:column; gap:8px; margin-bottom:14px; }
  textarea { width:100%; box-sizing:border-box; resize:vertical; min-height:64px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border:1px solid var(--vscode-input-border, rgba(127,127,127,.3)); border-radius:8px;
    padding:8px 10px; font-family:inherit; font-size:.95em; }
  textarea:focus { outline:none; border-color: var(--vscode-focusBorder); }
  textarea:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 1px; }
  button:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation-duration: .001ms !important; animation-iteration-count: 1 !important; transition-duration: .001ms !important; }
  }
  #bar { display:flex; gap:8px; align-items:center; margin-bottom:12px; }
  .spin { width:12px; height:12px; border-radius:50%;
    border:2px solid var(--vscode-textLink-foreground); border-right-color:transparent;
    animation:spin .8s linear infinite; }
  .spin.done { animation:none; border-color: var(--vscode-testing-iconPassed,#3fb950); border-right-color:transparent; }
  @keyframes spin { to { transform: rotate(360deg); } }
  #status { font-size:.85em; opacity:.85; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border:none; border-radius:6px; padding:5px 14px; cursor:pointer; font-size:.85em; font-weight:600; }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  #feed { font-family: var(--vscode-editor-font-family, monospace); font-size:.85em;
    line-height:1.6; border:1px solid var(--vscode-panel-border, rgba(127,127,127,.25));
    border-radius:8px; padding:10px 12px; max-height:40vh; overflow:auto; margin-bottom:14px; }
  #feed:empty { display:none; }
  .line { white-space:pre-wrap; }
  #result { white-space:pre-wrap; line-height:1.55; }
  #result:empty { display:none; }
  .rhead { font-weight:700; color: var(--vscode-textLink-foreground); margin:8px 0 6px; border-top:1px solid var(--vscode-panel-border,rgba(127,127,127,.25)); padding-top:12px; }
  .hidden { display:none !important; }
</style></head><body>
  <h2>🧭 Orchestrator</h2>
  <div class="goal hidden" id="goal"></div>

  <div id="setup">
    <textarea id="goalInput" placeholder="What should the team work on? e.g. Analyze the project's UI and produce a prioritized improvement plan"></textarea>
    <div style="display:flex; gap:8px;">
      <button id="startBtn">Start</button>
      <button class="secondary" id="closeBtn1">Close</button>
    </div>
  </div>

  <div id="bar" class="hidden">
    <span class="spin" id="spin"></span>
    <span id="status">starting…</span>
    <span style="flex:1"></span>
    <button class="secondary" id="stopBtn">Stop</button>
    <button class="secondary" id="closeBtn2">Close</button>
  </div>

  <div id="feed"></div>
  <div id="result"></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const feed = $('feed'), status = $('status'), spin = $('spin'), resultEl = $('result');
  const setup = $('setup'), bar = $('bar');
  $('startBtn').addEventListener('click', () => {
    const goal = $('goalInput').value.trim();
    if (goal) vscode.postMessage({ type:'start', goal });
  });
  $('closeBtn1').addEventListener('click', () => vscode.postMessage({ type:'close' }));
  $('closeBtn2').addEventListener('click', () => vscode.postMessage({ type:'close' }));
  $('stopBtn').addEventListener('click', () => { vscode.postMessage({ type:'stop' }); status.textContent='stopping…'; });
  function add(text) {
    const d = document.createElement('div'); d.className='line'; d.textContent=text;
    feed.appendChild(d); feed.scrollTop = feed.scrollHeight;
    status.textContent = text.replace(/^🧭\\s*/, '');
  }
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'idle') { setup.classList.remove('hidden'); $('goalInput').focus(); }
    else if (m.type === 'start') {
      setup.classList.add('hidden'); bar.classList.remove('hidden');
      const g = $('goal'); g.textContent = m.goal; g.classList.remove('hidden');
    }
    else if (m.type === 'log') { add(m.text); }
    else if (m.type === 'result' || m.type === 'error') {
      spin.classList.add('done');
      status.textContent = m.type === 'error' ? 'error' : 'done';
      resultEl.innerHTML = '<div class="rhead">' + (m.type === 'error' ? '⚠ Error' : '✓ Final plan') + '</div>';
      const body = document.createElement('div'); body.textContent = m.text; resultEl.appendChild(body);
    }
  });
</script></body></html>`;
  }
}
