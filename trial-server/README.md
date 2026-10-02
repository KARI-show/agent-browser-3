# Trial gateway

The server behind the extension's **free trial**. It is an Anthropic-compatible
proxy that holds *your* API key and enforces limits, so people can try Agent
Browser without an account — and your key never reaches the browser.

```
extension (official SDK)  ──  trial token  ──▶  this gateway  ── your key ──▶  api.anthropic.com
```

The extension talks to it exactly like to the real API (`POST /v1/messages`
streaming, `GET /v1/models`), with a per-install **trial token** in place of a
key. Everything else in the extension is unchanged.

## Run

```bash
ANTHROPIC_API_KEY=sk-ant-… node trial-server/server.mjs      # listens on :8787
```

Zero dependencies, Node 20.3+. Put it behind HTTPS (Caddy, nginx, Cloudflare
Tunnel …) — browsers won't send keys to plain-http hosts you don't control, and
neither should you. Behind a proxy set `TRUST_IP_HEADER` (see below).
`handler.mjs` is plain `Request → Response` (WebCrypto, no Node built-ins), so the
same code runs as a Cloudflare Worker (`worker.mjs`, below) or, with your own store
(the interface is a few methods, see `store.mjs`), on other platforms.

State (hashed tokens + spend counters) lives in `trial-server/data/trial.json`
(`TRIAL_DATA_FILE`, or `memory` for none). One process only.

## Run on Cloudflare (recommended)

No server to look after, HTTPS and a public address included, and the client
address arrives in `cf-connecting-ip` (set by Cloudflare, not spoofable).
Counters live in **D1**; every update is one atomic SQL upsert, so parallel
requests can't lose or double-count spend (Workers KV can't guarantee that —
don't swap it in).

```bash
cd trial-server
npm i -g wrangler && wrangler login
wrangler d1 create agent-trial            # paste the database_id it prints into wrangler.toml
wrangler d1 execute agent-trial --remote --file=schema.sql
wrangler secret put ANTHROPIC_API_KEY     # and ANTHROPIC_WORKSPACE_ID if your key needs one
wrangler deploy                           # prints https://agent-trial-gateway.<you>.workers.dev
```

Then build the extension with that address:
`AGENT_TRIAL_URL=https://agent-trial-gateway.<you>.workers.dev node browser/build.mjs`.
Settings are Worker variables with the names below (`[vars]` in `wrangler.toml`,
or the dashboard). Use the **Workers Paid** plan for real traffic: the free plan
allows 10 ms of CPU per request, and parsing a chat with screenshots can exceed
that. Tested in the real Workers runtime (`wrangler dev`, workerd + D1): sign-up,
streaming, key swap, atomic counters under parallel load, charge for a cancelled
stream, exhaustion, per-address limits. Not tested here: your account's limits,
custom domains and Cloudflare's own rate-limit/WAF rules (worth adding in front —
a rate-limiting rule on `/register` is the cheapest extra protection).

## Settings (environment)

| Variable | Default | |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | — | **required**, stays on the server |
| `ANTHROPIC_WORKSPACE_ID` | — | needed when the key isn't scoped to a workspace |
| `TRIAL_MODELS` | `claude-haiku-4-5,claude-sonnet-5-5` | allow-list; the first is the extension's default |
| `TRIAL_TOKEN_DAILY_USD` | `0.25` | per install, per UTC day |
| `TRIAL_TOKEN_TOTAL_USD` | `1.00` | per install, lifetime |
| `TRIAL_IP_DAILY_USD` | `0.75` | per network (IPv6 grouped by /64) per day |
| `TRIAL_GLOBAL_DAILY_USD` | `20` | **hard ceiling for the whole trial per day** |
| `TRIAL_REGISTER_PER_IP_DAY` | `3` | new trial tokens per network per day |
| `TRIAL_MAX_REGISTERED` | `100000` | stored tokens; sign-ups pause beyond this |
| `TRIAL_TOKEN_RPM` / `TRIAL_IP_RPM` | `90` / `240` | requests per minute per token / per network |
| `TRIAL_MAX_CONCURRENT` | `24` | requests in flight across the whole gateway (bounds buffered request bodies) |
| `TRIAL_MAX_TOKENS` | `8192` | output cap per request (clamped, not refused) |
| `TRIAL_MAX_BODY_BYTES` | `6291456` | request size cap (screenshots are the bulk) |
| `TRIAL_ENABLED` | `true` | `false` = kill switch: sign-ups and requests answer 503 |
| `ALLOWED_ORIGINS` | the extension's id | CORS allow-list (comma separated) |
| `TRUST_IP_HEADER` | — | e.g. `x-forwarded-for` / `cf-connecting-ip` — **only** behind infrastructure that sets it |
| `PORT` | `8787` | |

## What it enforces

- Only the allow-listed models; `max_tokens` clamped; effort above `high` clamped.
- No server tools (web search, code execution…), no betas, `mcp_servers`,
  `container`, `service_tier` or other extra fields — nothing that adds cost you
  didn't budget.
- **Money is reserved before a request goes upstream.** The gateway estimates the
  worst case (input tokens from the body — images at a fixed ceiling — priced at the
  dearest cache tier, plus all of `max_tokens` at the output price), adds it to the
  per-token, per-network and global counters and refuses if any would go over.
  When the request finishes the reservation is replaced by the real cost from the
  stream's usage (cache reads/writes priced correctly, incl. the 1-hour tier).
  Parallel requests therefore can't overshoot.
- A request that is **cancelled** without final usage is charged what it plausibly
  used: input from `message_start`, output as the larger of streamed characters and
  elapsed time × 300 tokens/s, capped at `max_tokens` (hidden reasoning is not
  visible in characters, time is). A non-streaming request keeps running upstream
  after the client leaves and is charged its real usage.
- Three requests per token at a time; request-rate limits per token and per network;
  a cap on requests in flight overall; new tokens limited per network.
- Refusals are API-shaped with `x-should-retry: false`, so the SDK shows the
  message at once instead of backing off.
- Upstream errors are **re-written, never relayed**: rate limits and outages become
  generic "busy / had a problem" messages; only a user's own plain request error
  keeps its message (and only that message). Anything about your key, credit,
  workspace or organization becomes "temporarily unavailable". Redirects from the
  upstream are never followed (the operator key would go along).
- A malformed number in the environment (`0,25`, `$20`) stops startup instead of
  silently switching a budget off; a corrupt state file also stops startup rather
  than resetting every budget; shutdown waits for running requests so their spend
  is recorded.
- Request bodies are never logged; log lines carry counters only.

## Things to decide / know

- **Anonymous by design.** A determined person can still farm free usage with many
  IPs; the per-network and global caps bound the damage to a number you choose.
  Add a CAPTCHA to `/register` (Cloudflare Turnstile is the usual choice) or
  require sign-in if abuse shows up.
- **Privacy.** Trial traffic (prompts, page text, screenshots) passes through
  your server to Anthropic. Say so in the extension and your privacy policy; this
  gateway does not store it.
- **Anthropic's terms** apply to what you run here (Commercial Terms — your key,
  your bill). If you later *charge* for access, check their rules on reselling
  API usage first.
- Put a spending limit on the Anthropic workspace as a second safety net.

## Endpoints

`POST /register` → `{ token, models, limits }` · `GET /status` (token) →
remaining allowance · `GET /v1/models` (token) · `POST /v1/messages` (token) ·
`GET /health`.
