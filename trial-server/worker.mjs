/**
 * Cloudflare Worker entry for the trial gateway (same handler as the Node
 * server). Settings are Worker variables/secrets with the names documented in
 * README.md; counters live in the D1 database bound as DB.
 */
import { loadConfig } from "./config.mjs";
import { createHandler } from "./handler.mjs";
import { D1Store } from "./d1store.mjs";

let cached = null; // per isolate
let lastPrune = 0;

function setup(env) {
  if (cached) return cached;
  // Behind Cloudflare the client address is in cf-connecting-ip — set by Cloudflare, not spoofable by the client.
  const cfg = loadConfig({ TRUST_IP_HEADER: "cf-connecting-ip", ...env });
  if (!cfg.apiKey) throw new Error("ANTHROPIC_API_KEY secret is not set (wrangler secret put ANTHROPIC_API_KEY)");
  if (!env.DB) throw new Error("D1 binding DB is missing (see wrangler.toml)");
  const store = new D1Store(env.DB);
  cached = { store, handler: createHandler(cfg, store) };
  return cached;
}

export default {
  async fetch(request, env, ctx) {
    let s;
    try {
      s = setup(env);
    } catch (e) {
      console.error("trial gateway misconfigured: " + e.message);
      return new Response(JSON.stringify({ type: "error", error: { type: "api_error", message: "The free trial is not configured." } }), { status: 503, headers: { "content-type": "application/json" } });
    }
    if (Date.now() - lastPrune > 3_600_000) {
      lastPrune = Date.now();
      ctx.waitUntil(s.store.prune().catch((e) => console.error("prune failed: " + e.message)));
    }
    return s.handler(request, { ip: request.headers.get("cf-connecting-ip") || "", waitUntil: (p) => ctx.waitUntil(p) });
  },
};
