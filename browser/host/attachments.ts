/**
 * Attachment handling the host can unit-test: data-URL parsing, the size limit
 * for a kind of file, file-name sanitising and the startup clean-up of old
 * uploads. Writing the file itself stays in host.ts.
 */
import * as fs from "fs";
import * as path from "path";

// Same limits as the standalone panel (browser/standalone/localHost.ts): the API
// refuses images over 5 MB (base64) and bounds a whole request at 32 MB, so a
// file the model could never see is refused at paste time, not on every turn.
export const MAX_IMAGE_BYTES = 3_500_000;
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
/** Uploads older than this are deleted when the host starts. */
export const ATTACHMENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;

/** `data:<mime>[;param=value…];base64,<data>` — parameters (e.g. `;name=a.png`) are allowed and ignored. */
export function parseDataUrl(dataUrl: unknown): { mime: string; data: string } | null {
  const m = /^data:([\w.+-]+\/[\w.+-]+)?(?:;[\w=.+-]+)*;base64,([A-Za-z0-9+/=\s]+)$/.exec(typeof dataUrl === "string" ? dataUrl : "");
  return m ? { mime: m[1] || "application/octet-stream", data: m[2].replace(/\s+/g, "") } : null;
}

export function isImageAttachment(mime: string, name: string): boolean {
  return /^image\//.test(mime) || IMAGE_EXT.test(name);
}

/** The byte cap for this kind of file. */
export function attachmentLimit(mime: string, name: string): number {
  if (isImageAttachment(mime, name)) return MAX_IMAGE_BYTES;
  if (mime === "application/pdf" || /\.pdf$/i.test(name)) return MAX_DOCUMENT_BYTES;
  return MAX_ATTACHMENT_BYTES;
}

/** A base name safe to put under the upload directory: no path parts, no odd characters, bounded length. */
export function safeAttachmentName(name: unknown, mime: string): string {
  const fallback = mime.startsWith("image/") ? "pasted.png" : "file";
  const base = path.basename(typeof name === "string" && name ? name : fallback).replace(/[^\w.\-]+/g, "_");
  return (base.replace(/^\.+$/, "") || fallback).slice(0, 120);
}

/** Names of the files past the TTL, i.e. what the startup clean-up removes. */
export function expiredFiles(files: Array<{ name: string; mtimeMs: number }>, now = Date.now(), ttlMs = ATTACHMENT_TTL_MS): string[] {
  return files.filter((f) => now - f.mtimeMs > ttlMs).map((f) => f.name);
}

/** Delete uploads older than the TTL. Attachments are only referenced from the chat they were sent in, so a week is plenty. */
export function pruneAttachments(dir: string, now = Date.now(), ttlMs = ATTACHMENT_TTL_MS): string[] {
  const files: Array<{ name: string; mtimeMs: number }> = [];
  for (const name of fs.readdirSync(dir)) {
    try {
      const st = fs.statSync(path.join(dir, name));
      if (st.isFile()) files.push({ name, mtimeMs: st.mtimeMs });
    } catch {
      /* vanished between readdir and stat */
    }
  }
  const expired = expiredFiles(files, now, ttlMs);
  for (const name of expired) fs.rmSync(path.join(dir, name), { force: true });
  return expired;
}
