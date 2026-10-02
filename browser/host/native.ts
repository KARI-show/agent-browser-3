/**
 * Chrome native messaging over stdio: every message is a 4-byte little-endian
 * length followed by UTF-8 JSON. stdout carries protocol frames ONLY — a stray
 * console.log would corrupt the stream, so diagnostics go to the log file.
 */

// Chrome rejects host→extension messages over 1 MB. Anything bigger (a long
// chat's loadConversation) is split into chunks the side panel reassembles.
export const MAX_FRAME = 900 * 1024;

export class NativePort {
  private buf = Buffer.alloc(0);
  private chunkSeq = 0;

  constructor(
    private onMessage: (msg: any) => void,
    private onClose: () => void
  ) {
    process.stdin.on("data", (chunk: Buffer) => this.read(chunk));
    process.stdin.on("end", () => this.onClose());
    process.stdin.on("error", () => this.onClose());
  }

  private read(chunk: Buffer) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32LE(0);
      if (this.buf.length < 4 + len) return;
      const body = this.buf.subarray(4, 4 + len).toString("utf8");
      this.buf = this.buf.subarray(4 + len);
      let msg: any;
      try {
        msg = JSON.parse(body);
      } catch {
        continue; // malformed frame from the extension — drop it
      }
      if (msg && typeof msg === "object") this.onMessage(msg);
    }
  }

  send(msg: unknown) {
    for (const frame of encodeFrames(msg, ++this.chunkSeq)) process.stdout.write(frame);
  }
}

/**
 * Encode one message as native-messaging frames: a single frame, or `__chunk`
 * frames when the JSON exceeds the 1 MB host→extension cap. `chunkId` tags the
 * pieces so the panel (browser/extension/shim.js) can reassemble them.
 */
export function encodeFrames(msg: unknown, chunkId: number): Buffer[] {
  const json = JSON.stringify(msg);
  if (Buffer.byteLength(json, "utf8") <= MAX_FRAME) return [frame(json)];
  // Split on UTF-16 units (a split surrogate pair survives: JSON escapes it
  // and the panel re-joins the string). An eighth of the byte budget covers
  // 3-byte characters doubled by re-escaping the already-JSON payload.
  const step = Math.floor(MAX_FRAME / 8);
  const total = Math.ceil(json.length / step);
  const frames: Buffer[] = [];
  for (let i = 0; i < total; i++) {
    frames.push(
      frame(JSON.stringify({ type: "__chunk", id: chunkId, i, total, data: json.slice(i * step, (i + 1) * step) }))
    );
  }
  return frames;
}

function frame(json: string): Buffer {
  const body = Buffer.from(json, "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}
