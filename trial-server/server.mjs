#!/usr/bin/env node
/**
 * Node runner for the free-trial gateway:
 *   ANTHROPIC_API_KEY=sk-ant-… PORT=8787 node server.mjs
 * See README.md for every setting. Zero dependencies (Node 20.3+).
 */
import * as http from "node:http";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as path from "node:path";
import { loadConfig } from "./config.mjs";
import { createHandler } from "./handler.mjs";
import { FileStore, MemoryStore } from "./store.mjs";

/** Serve `handler` (Request -> Response) on a Node http server. */
export function serve(handler, { port = 8787, host = "0.0.0.0" } = {}) {
  const server = http.createServer(async (req, res) => {
    // Client went away (closed the panel, pressed Stop): abort the upstream request too.
    const ctrl = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) ctrl.abort();
    });
    try {
      const url = `http://${req.headers.host || "localhost"}${req.url}`;
      const hasBody = req.method !== "GET" && req.method !== "HEAD";
      const request = new Request(url, {
        method: req.method,
        headers: req.headers,
        body: hasBody ? Readable.toWeb(req) : undefined,
        duplex: hasBody ? "half" : undefined,
        signal: ctrl.signal,
      });
      const response = await handler(request, { ip: req.socket.remoteAddress });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (!response.body) return void res.end();
      const reader = response.body.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        // Wait for the socket to drain — or for the client to leave: a 'drain' that never comes
        // must not park this loop (and the request's slot and charge) forever.
        if (!res.write(value)) await new Promise((r) => (res.once("drain", r), res.once("close", r)));
        if (ctrl.signal.aborted || res.destroyed) {
          ctrl.abort();
          reader.cancel().catch(() => {});
          break;
        }
      }
      res.end();
    } catch (e) {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "Internal error." } }));
    }
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}

// CLI entry
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  if (!cfg.apiKey) {
    console.error("ANTHROPIC_API_KEY is not set — the trial gateway needs the operator's key.");
    process.exit(1);
  }
  const dataFile = process.env.TRIAL_DATA_FILE || path.join(path.dirname(fileURLToPath(import.meta.url)), "data", "trial.json");
  let store;
  try {
    store = process.env.TRIAL_DATA_FILE === "memory" ? new MemoryStore() : new FileStore(dataFile);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  const handler = createHandler(cfg, store);
  const port = Number(process.env.PORT || 8787);
  const server = await serve(handler, { port });
  console.log(`trial gateway on :${port} — models ${cfg.models.join(", ")} — ${cfg.enabled ? "enabled" : "PAUSED"} — data ${process.env.TRIAL_DATA_FILE === "memory" ? "in memory" : dataFile}`);
  console.log(`sign-in codes: ${cfg.auth.resendKey ? "emailed from " + cfg.auth.mailFrom : "PRINTED TO THIS LOG (no RESEND_API_KEY)"} — ${cfg.auth.allowedEmails.length ? cfg.auth.allowedEmails.length + " invited address(es)/domain(s)" : "open to any address"} — admin API ${cfg.auth.adminToken ? "on" : "off (no ADMIN_TOKEN)"}`);
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.once(sig, async () => {
      // Stop taking new requests, let running ones finish and record their spend, then save.
      server.close();
      console.log(`${sig}: draining ${handler.inflight()} request(s)…`);
      await handler.drain(15_000);
      store.flush?.();
      process.exit(0);
    });
  }
}
