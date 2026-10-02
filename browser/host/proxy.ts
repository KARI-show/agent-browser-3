import * as http from "http";
import * as net from "net";
import * as tls from "tls";

/**
 * Upstream proxy support for agent profiles. Chrome can't take proxy
 * credentials on its command line, so each profile runs a tiny forwarder on
 * 127.0.0.1 that speaks plain HTTP-proxy to the browser and talks to the
 * user's real proxy (HTTP CONNECT or SOCKS5, with optional username/password)
 * itself. The password therefore never appears in a process argument list or
 * in the browser's config. Hostnames are sent to the proxy unresolved, so DNS
 * lookups happen on the proxy's side too.
 */

export interface Upstream {
  type: "http" | "socks5";
  host: string;
  port: number;
  username?: string;
  password?: string;
}

const CONNECT_TIMEOUT_MS = 15_000;

/** Accepts "socks5://user:pass@host:1080", "http://host:8080" or "host:8080" (→ http). */
export function parseProxyString(input: string): Upstream {
  let s = input.trim();
  if (!s) throw new Error("Proxy address is empty.");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = "http://" + s;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new Error(`Can't read the proxy address "${input}". Use host:port or scheme://user:pass@host:port.`);
  }
  const scheme = u.protocol.replace(":", "").toLowerCase();
  const type = scheme === "socks5" || scheme === "socks5h" ? "socks5" : scheme === "http" || scheme === "https" ? "http" : null;
  if (!type) throw new Error(`Unsupported proxy type "${scheme}" — use http or socks5.`);
  const port = Number(u.port || (type === "socks5" ? 1080 : 8080));
  if (!u.hostname || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Can't read the proxy address "${input}".`);
  }
  return {
    type,
    host: u.hostname.replace(/^\[|\]$/g, ""),
    port,
    username: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
  };
}

/** Read from `socket` until `done(buffer)` returns a length to consume (or -1 to keep reading). */
function readUntil(socket: net.Socket, done: (buf: Buffer) => number, what: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => fail(new Error(`Timed out waiting for the proxy (${what}).`)), CONNECT_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", fail);
      socket.off("close", onClose);
    };
    const fail = (e: Error) => {
      cleanup();
      reject(e);
    };
    const onClose = () => fail(new Error(`The proxy closed the connection (${what}).`));
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const n = done(buf);
      if (n < 0) return;
      cleanup();
      // Bytes after the handshake belong to the tunnelled stream.
      if (buf.length > n) socket.unshift(buf.subarray(n));
      resolve(buf.subarray(0, n));
    };
    socket.on("data", onData);
    socket.on("error", fail);
    socket.on("close", onClose);
  });
}

function dial(up: Upstream): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: up.host, port: up.port });
    const timer = setTimeout(() => {
      s.destroy();
      reject(new Error(`Couldn't reach the proxy ${up.host}:${up.port} (timed out).`));
    }, CONNECT_TIMEOUT_MS);
    s.once("connect", () => {
      clearTimeout(timer);
      s.setNoDelay(true);
      resolve(s);
    });
    s.once("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(new Error(`Couldn't reach the proxy ${up.host}:${up.port} (${e.code || e.message}).`));
    });
  });
}

const SOCKS_ERRORS: Record<number, string> = {
  1: "general failure",
  2: "connection not allowed by the proxy's rules",
  3: "network unreachable",
  4: "host unreachable",
  5: "connection refused by the target",
  6: "TTL expired",
  7: "command not supported",
  8: "address type not supported",
};

async function socks5Handshake(s: net.Socket, up: Upstream, host: string, port: number): Promise<void> {
  const hasAuth = !!(up.username || up.password);
  s.write(Buffer.from(hasAuth ? [5, 2, 0, 2] : [5, 1, 0]));
  const choice = await readUntil(s, (b) => (b.length >= 2 ? 2 : -1), "SOCKS greeting");
  if (choice[0] !== 5) throw new Error("That isn't a SOCKS5 proxy (bad greeting). Check the proxy type.");
  if (choice[1] === 0xff) throw new Error("The SOCKS5 proxy rejected every login method offered.");
  if (choice[1] === 2) {
    const u = Buffer.from(up.username || "", "utf8");
    const p = Buffer.from(up.password || "", "utf8");
    if (u.length > 255 || p.length > 255) throw new Error("SOCKS5 username/password is too long.");
    s.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]));
    const auth = await readUntil(s, (b) => (b.length >= 2 ? 2 : -1), "SOCKS login");
    if (auth[1] !== 0) throw new Error("The proxy refused the username/password.");
  } else if (choice[1] !== 0) {
    throw new Error("The SOCKS5 proxy asked for an unsupported login method.");
  }
  const target = Buffer.from(host, "utf8");
  if (target.length > 255) throw new Error("Target host name is too long.");
  s.write(Buffer.concat([Buffer.from([5, 1, 0, 3, target.length]), target, Buffer.from([port >> 8, port & 0xff])]));
  await readUntil(
    s,
    (b) => {
      if (b.length < 5) return -1;
      const len = b[3] === 1 ? 10 : b[3] === 4 ? 22 : 7 + b[4];
      return b.length >= len ? len : -1;
    },
    "SOCKS connect"
  ).then((reply) => {
    if (reply[1] !== 0) throw new Error(`The SOCKS5 proxy couldn't connect to ${host}:${port}: ${SOCKS_ERRORS[reply[1]] || "error " + reply[1]}.`);
  });
}

async function httpConnect(s: net.Socket, up: Upstream, host: string, port: number): Promise<void> {
  const auth = up.username || up.password
    ? `Proxy-Authorization: Basic ${Buffer.from(`${up.username || ""}:${up.password || ""}`).toString("base64")}\r\n`
    : "";
  const target = host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
  s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth}Proxy-Connection: keep-alive\r\n\r\n`);
  const head = await readUntil(
    s,
    (b) => {
      const i = b.indexOf("\r\n\r\n");
      return i < 0 ? -1 : i + 4;
    },
    "HTTP CONNECT"
  );
  const status = /^HTTP\/1\.[01] (\d{3})/.exec(head.toString("latin1"));
  const code = status ? Number(status[1]) : 0;
  if (code === 200) return;
  if (code === 407) throw new Error("The proxy refused the username/password (407).");
  throw new Error(`The proxy refused the tunnel to ${target}${code ? ` (HTTP ${code})` : " (not an HTTP proxy? check the type)"}.`);
}

/** Open a TCP tunnel to host:port through the upstream proxy. */
export async function connectVia(up: Upstream, host: string, port: number): Promise<net.Socket> {
  const s = await dial(up);
  try {
    if (up.type === "socks5") await socks5Handshake(s, up, host, port);
    else await httpConnect(s, up, host, port);
    return s;
  } catch (e) {
    s.destroy();
    throw e;
  }
}

export interface Forwarder {
  port: number;
  close(): Promise<void>;
}

function splitHostPort(target: string, defaultPort: number): { host: string; port: number } | null {
  const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(target) || /^([^:]+)(?::(\d+))?$/.exec(target);
  if (!m) return null;
  return { host: m[1], port: m[2] ? Number(m[2]) : defaultPort };
}

/** Start the loopback forwarder for one profile. `port` 0 picks a free one. */
export function startForwarder(
  up: Upstream,
  port = 0,
  onError: (msg: string) => void = () => {},
  /** When set, clients must present it as Basic proxy auth (user "agent"), so other local programs can't ride this proxy. */
  token?: string
): Promise<Forwarder> {
  const wantAuth = token ? "Basic " + Buffer.from(`agent:${token}`).toString("base64") : undefined;
  const authorised = (h: http.IncomingHttpHeaders) => !wantAuth || h["proxy-authorization"] === wantAuth;
  const server = http.createServer();
  const sockets = new Set<net.Socket>();
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
    s.on("error", () => {});
  });

  // HTTPS (and anything else tunnelled): CONNECT host:port
  server.on("connect", async (req, client: net.Socket, head) => {
    if (!authorised(req.headers)) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="agent"\r\n\r\n');
      return;
    }
    const t = splitHostPort(req.url || "", 443);
    if (!t) {
      client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    try {
      const upstream = await connectVia(up, t.host, t.port);
      sockets.add(upstream);
      upstream.on("close", () => sockets.delete(upstream));
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    } catch (e) {
      onError(`CONNECT ${req.url}: ${(e as Error).message}`);
      client.end(`HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\n\r\n${(e as Error).message}\r\n`);
    }
  });

  // Plain http:// requests arrive with an absolute URI.
  server.on("request", (req, res) => {
    if (!authorised(req.headers)) {
      res.writeHead(407, { "Proxy-Authenticate": 'Basic realm="agent"' }).end();
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url || "");
    } catch {
      res.writeHead(400).end("Bad proxy request");
      return;
    }
    if (url.protocol !== "http:") {
      res.writeHead(400).end("Only http:// is forwarded here");
      return;
    }
    const headers = { ...req.headers };
    delete headers["proxy-connection"];
    delete headers["proxy-authorization"];
    const fail = (e: Error) => {
      onError(`GET ${url.host}: ${e.message}`);
      if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" });
      res.end(e.message + "\n");
    };
    const relay = (out: http.ClientRequest) => {
      out.on("response", (ur) => {
        res.writeHead(ur.statusCode || 502, ur.headers);
        ur.pipe(res);
      });
      out.on("error", fail);
      req.pipe(out);
    };
    if (up.type === "http") {
      // Ask the upstream proxy to fetch it (absolute-URI form) with our credentials.
      if (up.username || up.password) {
        headers["proxy-authorization"] = "Basic " + Buffer.from(`${up.username || ""}:${up.password || ""}`).toString("base64");
      }
      relay(http.request({ host: up.host, port: up.port, method: req.method, path: req.url, headers, agent: false }));
      return;
    }
    // SOCKS: tunnel to the origin first, then speak ordinary origin-form HTTP over it.
    connectVia(up, url.hostname, Number(url.port || 80)).then((sock) => {
      sockets.add(sock);
      sock.on("close", () => sockets.delete(sock));
      // No `agent`: Node only honours createConnection when no agent is in play.
      relay(http.request({ method: req.method, path: url.pathname + url.search, headers, createConnection: () => sock }));
    }, fail);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      resolve({
        port: (server.address() as net.AddressInfo).port,
        close: () =>
          new Promise<void>((r) => {
            for (const s of sockets) s.destroy();
            server.close(() => r());
          }),
      });
    });
  });
}

export interface IpEndpoint {
  host: string;
  port: number;
  tls: boolean;
}
const DEFAULT_ENDPOINT: IpEndpoint = { host: "api.ipify.org", port: 443, tls: true };

/** GET / on an IP-echo service over an already-open (or direct) socket; resolves the address it reports. */
function readIp(raw: net.Socket, ep: IpEndpoint): Promise<string> {
  const stream: net.Socket = ep.tls ? tls.connect({ socket: raw, servername: ep.host }) : raw;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stream.destroy();
      reject(new Error("the IP-check site didn't answer in time"));
    }, CONNECT_TIMEOUT_MS);
    let body = "";
    stream.on("data", (d) => (body += d.toString("utf8")));
    stream.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`the IP-check site couldn't be read through it (${(e as NodeJS.ErrnoException).code || e.message.split("\n")[0]})`));
    });
    stream.on("end", () => {
      clearTimeout(timer);
      const ip = body.split("\r\n\r\n").slice(1).join("\r\n\r\n").trim().split(/\s+/)[0];
      /^[0-9a-f:.]{3,45}$/i.test(ip) ? resolve(ip) : reject(new Error(`the IP-check site gave an unexpected answer`));
    });
    stream.write(`GET / HTTP/1.1\r\nHost: ${ep.host}\r\nUser-Agent: curl/8\r\nConnection: close\r\n\r\n`);
  });
}

export interface ProxyTestResult {
  ok: boolean;
  message: string;
  proxyIp?: string;
  directIp?: string;
  ms?: number;
}

/**
 * Connectivity check for the settings form: opens a tunnel through the proxy
 * (that alone proves address, type and login), then asks an IP-echo service
 * which address it sees, next to the direct one for comparison.
 */
export async function testProxy(up: Upstream, ep: IpEndpoint = DEFAULT_ENDPOINT): Promise<ProxyTestResult> {
  const t0 = Date.now();
  let tunnel: net.Socket;
  try {
    tunnel = await connectVia(up, ep.host, ep.port);
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  let proxyIp: string;
  try {
    proxyIp = await readIp(tunnel, ep);
  } catch (e) {
    tunnel.destroy();
    return { ok: false, message: `The proxy accepted the connection, but ${(e as Error).message}. It may block this site — try browsing through it.` };
  }
  const ms = Date.now() - t0;
  let directIp: string | undefined;
  try {
    directIp = await readIp(net.connect({ host: ep.host, port: ep.port }), ep);
  } catch {
    /* the direct lookup is only for comparison */
  }
  const same = directIp && directIp === proxyIp;
  return {
    ok: true,
    proxyIp,
    directIp,
    ms,
    message: same
      ? `Connected, but sites see your normal IP (${proxyIp}) — this proxy isn't hiding it.`
      : `Works. Sites see ${proxyIp}${directIp ? ` (your direct IP is ${directIp})` : ""} · ${ms} ms.`,
  };
}
