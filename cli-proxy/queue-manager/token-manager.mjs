/**
 * Reads and auto-refreshes the Claude CLI OAuth token.
 * Token file: ~/.claude/.credentials.json
 *
 * The access token is used as Bearer auth for the Anthropic API.
 * When it expires, we use the refresh token to get a new one.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CREDS_PATH = join(homedir(), ".claude", ".credentials.json");
const REFRESH_MARGIN_MS = 5 * 60 * 1000; // refresh 5 min before expiry
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"; // Claude Code public client

let cached = null;
let refreshTimer = null;

function loadFromDisk() {
  const raw = readFileSync(CREDS_PATH, "utf8");
  const data = JSON.parse(raw);
  const oauth = data.claudeAiOauth;
  if (!oauth?.accessToken) throw new Error("No accessToken in credentials file");
  return {
    accessToken: oauth.accessToken,
    refreshToken: oauth.refreshToken,
    expiresAt: oauth.expiresAt || Date.now() + 3600_000,
    scopes: oauth.scopes || [],
    subscriptionType: oauth.subscriptionType || "unknown",
  };
}

function saveToDisk(creds) {
  const raw = readFileSync(CREDS_PATH, "utf8");
  const data = JSON.parse(raw);
  data.claudeAiOauth = {
    ...data.claudeAiOauth,
    accessToken: creds.accessToken,
    refreshToken: creds.refreshToken,
    expiresAt: creds.expiresAt,
  };
  writeFileSync(CREDS_PATH, JSON.stringify(data), { mode: 0o600 });
}

async function doRefresh(refreshToken) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    refresh_token: refreshToken,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
  };
}

function scheduleRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  if (!cached) return;
  const delay = Math.max(10_000, cached.expiresAt - Date.now() - REFRESH_MARGIN_MS);
  refreshTimer = setTimeout(async () => {
    try {
      console.log("[token] refreshing access token...");
      const fresh = await doRefresh(cached.refreshToken);
      cached.accessToken = fresh.accessToken;
      cached.refreshToken = fresh.refreshToken;
      cached.expiresAt = fresh.expiresAt;
      saveToDisk(cached);
      console.log("[token] refreshed, expires at", new Date(cached.expiresAt).toISOString());
      scheduleRefresh();
    } catch (e) {
      console.error("[token] refresh failed:", e.message);
      // Retry in 30s
      refreshTimer = setTimeout(() => scheduleRefresh(), 30_000);
    }
  }, delay);
  refreshTimer.unref?.();
  console.log(`[token] next refresh in ${Math.round(delay / 1000)}s`);
}

export async function init() {
  try {
    cached = loadFromDisk();
    console.log(`[token] loaded, sub=${cached.subscriptionType}, expires=${new Date(cached.expiresAt).toISOString()}`);
    if (cached.expiresAt - Date.now() < REFRESH_MARGIN_MS) {
      console.log("[token] token expired or close to expiry, refreshing immediately...");
      try {
        const fresh = await doRefresh(cached.refreshToken);
        cached.accessToken = fresh.accessToken;
        cached.refreshToken = fresh.refreshToken;
        cached.expiresAt = fresh.expiresAt;
        saveToDisk(cached);
      } catch (e) {
        console.error("[token] refresh failed:", e.message);
        console.warn("[token] server will start but API calls will fail until `claude login` is run");
      }
    }
    scheduleRefresh();
    return cached;
  } catch (e) {
    console.error("[token] init failed:", e.message);
    console.warn("[token] server will start WITHOUT a valid token. Run `claude login` on this machine.");
    cached = { accessToken: "", refreshToken: "", expiresAt: 0, scopes: [], subscriptionType: "none" };
    return cached;
  }
}

export function getAccessToken() {
  if (!cached) throw new Error("Token manager not initialized");
  return cached.accessToken;
}

export function getBearer() {
  return `Bearer ${getAccessToken()}`;
}
