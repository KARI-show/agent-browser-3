// Shared validation helpers for the relay hub — extracted so they can be
// unit-tested without importing hub.mjs (which starts a server on import).
import { timingSafeEqual } from "node:crypto";

// ── hardening limits (audit: no validation on relay messages → DoS) ──
export const MAX_PAYLOAD = 1 * 1024 * 1024; // 1 MB per ws message
export const MAX_ID_LEN = 64; // ids/names/channels are short strings, not blobs
export const MAX_SUBS = 256; // channels one client may watch
export const RATE_WINDOW_MS = 10_000;
export const RATE_MAX_MSGS = 400; // ~40 msg/s sustained is far above real traffic

/** Constant-time token check — string compare leaks length/prefix timing. */
export function makeTokenChecker(token) {
  const b = Buffer.from(String(token ?? ""));
  return (candidate) => {
    const a = Buffer.from(String(candidate ?? ""));
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  };
}

/** Short printable id (nodeId/chatId/clientId/channel): no control chars. */
export function isId(v, max = MAX_ID_LEN) {
  return typeof v === "string" && v.length > 0 && v.length <= max && !/[\x00-\x1f]/.test(v);
}

/** Per-socket sliding-window rate limiter. Returns true when the caller
 *  should drop the connection. */
export function makeRateLimiter(maxMsgs = RATE_MAX_MSGS, windowMs = RATE_WINDOW_MS, now = Date.now) {
  let count = 0;
  let start = now();
  return () => {
    const t = now();
    if (t - start > windowMs) {
      start = t;
      count = 0;
    }
    return ++count > maxMsgs;
  };
}
