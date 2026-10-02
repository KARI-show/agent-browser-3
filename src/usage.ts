import * as vscode from "vscode";

/**
 * Lightweight usage HUD. Tracks cumulative cost + turn count for the workspace
 * and surfaces the live agent state (idle / working), active model, and running
 * cost in a status-bar item. Totals persist in workspaceState so they survive a
 * reload. Cost comes from the SDK result message (`total_cost_usd`); it's 0 on
 * subscription auth, in which case we just show state + model.
 */

interface UsageState {
  totalCostUsd: number;
  turns: number;
}

/** Shared cost formatter: more precision for sub-dollar amounts. */
export function formatCost(n: number): string {
  return n < 1 ? n.toFixed(4) : n.toFixed(2);
}

export class UsageTracker {
  private item: vscode.StatusBarItem;
  private cost: number;
  private turns: number;
  private model = "";
  private running = false;

  constructor(private state: vscode.Memento) {
    const s = state.get<UsageState>("usageTotals", { totalCostUsd: 0, turns: 0 });
    this.cost = s.totalCostUsd || 0;
    this.turns = s.turns || 0;
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = "agentIde.open";
    this.refresh();
  }

  get statusBarItem(): vscode.StatusBarItem {
    return this.item;
  }

  setVisible(visible: boolean) {
    if (visible) this.item.show();
    else this.item.hide();
  }

  setModel(model: string) {
    this.model = model || "";
    this.refresh();
  }

  setRunning(running: boolean) {
    this.running = running;
    this.refresh();
  }

  /** Record a completed turn; cost is optional (0 on subscription auth). */
  addTurn(costUsd?: number) {
    this.turns++;
    if (typeof costUsd === "number" && isFinite(costUsd) && costUsd > 0) {
      this.cost += costUsd;
    }
    void this.persist();
    this.refresh();
  }

  totals(): { cost: number; turns: number } {
    return { cost: this.cost, turns: this.turns };
  }

  async reset() {
    this.cost = 0;
    this.turns = 0;
    await this.persist();
    this.refresh();
  }

  private persist() {
    return this.state.update("usageTotals", {
      totalCostUsd: this.cost,
      turns: this.turns,
    });
  }

  private refresh() {
    const icon = this.running ? "$(sync~spin)" : "$(hubot)";
    const model = this.model ? ` ${this.model}` : "";
    const cost = this.cost > 0 ? ` · $${formatCost(this.cost)}` : "";
    this.item.text = `${icon} Agent${model}${cost}`;
    this.item.tooltip =
      `Agent IDE — ${this.running ? "working…" : "idle"}\n` +
      `Usage (workspace total): $${formatCost(this.cost)} over ${this.turns} turn(s)\n` +
      `Reset via “Agent IDE: Show Usage”. Click to open the panel.`;
  }

  dispose() {
    this.item.dispose();
  }
}
