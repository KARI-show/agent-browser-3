import { loadAuthConfig } from "./auth.mjs";

/**
 * All limits come from the environment so the operator tunes them without code
 * changes. Money values are USD in the env, micro-USD internally.
 * A malformed number ("0,25", "$0.75") stops the server at startup: silently
 * turning it into NaN would switch that budget off.
 */
function num(env, name, dflt) {
  const raw = env[name];
  if (raw === undefined || raw === "") return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name}="${raw}" is not a valid non-negative number (use a dot for decimals, no currency sign).`);
  return n;
}
const usd = (env, name, dflt) => Math.round(num(env, name, dflt) * 1e6);
const list = (v, d) => (v ?? d).split(",").map((s) => s.trim()).filter(Boolean);

export function loadConfig(env = process.env) {
  const enabledRaw = (env.TRIAL_ENABLED ?? "true").toLowerCase();
  if (!["true", "false"].includes(enabledRaw)) throw new Error(`TRIAL_ENABLED="${env.TRIAL_ENABLED}" must be true or false.`);
  return {
    apiKey: env.ANTHROPIC_API_KEY || "",
    workspaceId: env.ANTHROPIC_WORKSPACE_ID || "",
    upstream: (env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, ""),
    enabled: enabledRaw === "true", // kill switch: TRIAL_ENABLED=false
    models: list(env.TRIAL_MODELS, "claude-haiku-4-5,claude-sonnet-5-5"),
    allowedOrigins: list(env.ALLOWED_ORIGINS, "chrome-extension://ppakaagcjnojicbdebhgkpjgikclbnlf"),
    // Which header carries the client IP behind your proxy/CDN ("x-forwarded-for", "cf-connecting-ip"…);
    // empty = use the socket address. Only set this when the header is set by infrastructure you control.
    ipHeader: (env.TRUST_IP_HEADER || "").toLowerCase(),
    maxTokensCap: num(env, "TRIAL_MAX_TOKENS", 8192),
    maxBodyBytes: num(env, "TRIAL_MAX_BODY_BYTES", 6 * 1024 * 1024),
    tokenDailyMicro: usd(env, "TRIAL_TOKEN_DAILY_USD", 0.25),
    tokenTotalMicro: usd(env, "TRIAL_TOKEN_TOTAL_USD", 1.0),
    ipDailyMicro: usd(env, "TRIAL_IP_DAILY_USD", 0.75),
    globalDailyMicro: usd(env, "TRIAL_GLOBAL_DAILY_USD", 20),
    // Requests per minute: per trial token, and per network (a household/office shares one).
    tokenRpm: num(env, "TRIAL_TOKEN_RPM", 90),
    ipRpm: num(env, "TRIAL_IP_RPM", 240),
    maxConcurrent: num(env, "TRIAL_MAX_CONCURRENT", 24), // whole gateway: bounds buffered request bodies
    upstreamTimeoutMs: num(env, "TRIAL_UPSTREAM_TIMEOUT_MS", 10 * 60_000),
    auth: loadAuthConfig(env), // email sign-in: AUTH_*, RESEND_API_KEY, MAIL_FROM, ADMIN_TOKEN
  };
}
