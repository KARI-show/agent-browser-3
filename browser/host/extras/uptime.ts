import { z } from "zod";
import type { ExtraFeature } from "./types";

// Uptime monitors: HTTP status checks on a schedule, built on the watcher machinery (chrome.alarms in
// the service worker, system notifications, Telegram) — a watcher of mode "status" that fetches the URL
// instead of opening a tab and keeps a history of status codes and latencies. browser/extras/uptime.js
// implements the tools, the ⏱ Uptime tab and the quick commands; the check itself lives in
// browser/extension/automation.js (doRun, mode === "status").
export const uptime: ExtraFeature = {
  id: "uptime",
  prompt: `## Uptime
- browser_uptime_add monitors a site's availability: an HTTP status check (HEAD, GET fallback, 15 s timeout) every few minutes in the background, with the panel closed and no model involved. The first check sets the baseline; afterwards every flip (200 → 503, a timeout, back to 200) is reported with a system notification and a Telegram message when the bot is set up. Use it when the user wants to know "when the site goes down / comes back"; browser_watch_create is for content changes.
- browser_uptime_list shows each monitor's state (up/down), last status and latency, failures in a row and the uptime % over the stored history (24 h at 5 min); browser_uptime_delete stops one.`,
  tools: [
    {
      name: "browser_uptime_add",
      feature: "uptime",
      readOnly: false,
      description:
        "Monitor a site's uptime: an HTTP status check (HEAD, GET fallback, 15 s timeout) on a schedule in the " +
        "background, with the panel closed — no page is opened, no model is involved. The first check sets the " +
        "baseline; afterwards every flip (200 → 503, a timeout, back to 200) is reported with a system " +
        "notification and a Telegram message (when the bot is set up), and each check's status code and latency " +
        "go into a 24 h history. Returns the monitor's id.",
      shape: {
        url: z.string().optional().describe("Address to monitor (default: the current tab)"),
        name: z.string().optional().describe("Short name shown in notifications (default: the host)"),
        every: z.number().min(1).max(10080).optional().describe("Minutes between checks (default 5, minimum 1)"),
        expect: z.number().int().min(100).max(599).optional().describe("The HTTP status that counts as up (default 200)"),
        telegram: z.boolean().optional().describe("Also send flips to Telegram (default true when the bot is configured)"),
      },
    },
    {
      name: "browser_uptime_list",
      feature: "uptime",
      readOnly: true,
      description:
        "List the uptime monitors: up/down/unknown, last status code and latency, failures in a row, checks, " +
        "failures, average latency and uptime % over the stored history, and since when each one runs.",
      shape: {},
    },
    {
      name: "browser_uptime_delete",
      feature: "uptime",
      readOnly: false,
      description: "Stop and delete an uptime monitor, by id (from browser_uptime_list) or by name.",
      shape: {
        id: z.string().optional().describe("Monitor id (wch_…)"),
        name: z.string().optional().describe("Or its name"),
      },
    },
  ],
};
