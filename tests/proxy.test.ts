import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "http";
import * as net from "net";
import { parseProxyString, connectVia, startForwarder, testProxy, Upstream } from "../browser/host/proxy";

// ---- fixtures: an origin server plus real HTTP-CONNECT and SOCKS5 proxies ----

function origin(): Promise<{ port: number; close: () => void; hits: string[] }> {
  const hits: string[] = [];
  const s = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url} host=${req.headers.host}`);
    res.setHeader("content-type", "text/plain");
    res.end("origin says hi");
  });
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r({ port: (s.address() as net.AddressInfo).port, close: () => s.close(), hits })));
}

/** HTTP proxy requiring Basic auth; resolves every hostname to 127.0.0.1 (like a proxy with private DNS). */
function httpProxy(user: string, pass: string, originPort: number) {
  const want = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
  const seen: string[] = [];
  const s = http.createServer((req, res) => {
    if (req.headers["proxy-authorization"] !== want) return void res.writeHead(407).end();
    seen.push(`GET ${req.url}`);
    const u = new URL(req.url!);
    const out = http.request({ host: "127.0.0.1", port: originPort, path: u.pathname, method: req.method, headers: { host: u.host } }, (o) => {
      res.writeHead(o.statusCode!, o.headers);
      o.pipe(res);
    });
    req.pipe(out);
  });
  s.on("connect", (req, sock) => {
    if (req.headers["proxy-authorization"] !== want) return void sock.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
    seen.push(`CONNECT ${req.url}`);
    const up = net.connect(originPort, "127.0.0.1", () => {
      sock.write("HTTP/1.1 200 OK\r\n\r\n");
      up.pipe(sock);
      sock.pipe(up);
    });
    up.on("error", () => sock.destroy());
  });
  return new Promise<{ port: number; seen: string[]; close: () => void }>((r) =>
    s.listen(0, "127.0.0.1", () => r({ port: (s.address() as net.AddressInfo).port, seen, close: () => s.close() }))
  );
}

/** Minimal SOCKS5 server: user/pass auth, CONNECT by domain name, maps every name to 127.0.0.1. */
function socksProxy(user: string, pass: string, originPort: number) {
  const seen: string[] = [];
  const s = net.createServer((c) => {
    let stage = 0;
    let buf = Buffer.alloc(0);
    c.on("error", () => {});
    c.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (stage === 0 && buf.length >= 2 && buf.length >= 2 + buf[1]) {
        const methods = [...buf.subarray(2, 2 + buf[1])];
        buf = buf.subarray(2 + buf[1]);
        if (!methods.includes(2)) return void c.end(Buffer.from([5, 0xff]));
        c.write(Buffer.from([5, 2]));
        stage = 1;
      }
      if (stage === 1 && buf.length >= 2 && buf.length >= 3 + buf[1] + buf[2 + buf[1]]) {
        const ul = buf[1];
        const u = buf.subarray(2, 2 + ul).toString();
        const pl = buf[2 + ul];
        const p = buf.subarray(3 + ul, 3 + ul + pl).toString();
        buf = buf.subarray(3 + ul + pl);
        if (u !== user || p !== pass) return void c.end(Buffer.from([1, 1]));
        c.write(Buffer.from([1, 0]));
        stage = 2;
      }
      if (stage === 2 && buf.length >= 5 && buf.length >= 7 + buf[4]) {
        const host = buf.subarray(5, 5 + buf[4]).toString();
        const port = buf.readUInt16BE(5 + buf[4]);
        const rest = buf.subarray(7 + buf[4]);
        stage = 3;
        seen.push(`${host}:${port}`);
        const up = net.connect(originPort, "127.0.0.1", () => {
          c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          if (rest.length) up.write(rest);
          up.pipe(c);
          c.pipe(up);
        });
        up.on("error", () => c.destroy());
      }
    });
  });
  return new Promise<{ port: number; seen: string[]; close: () => void }>((r) =>
    s.listen(0, "127.0.0.1", () => r({ port: (s.address() as net.AddressInfo).port, seen, close: () => s.close() }))
  );
}

function getViaForwarder(fwdPort: number, url: string, method: "GET" | "CONNECT" = "GET"): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: fwdPort, method: "GET", path: url, headers: { host: new URL(url).host } }, (res) => {
      let b = "";
      res.on("data", (d) => (b += d));
      res.on("end", () => resolve(`${res.statusCode} ${b}`));
    });
    req.on("error", reject);
    req.end();
  });
}

// ---- parsing ----

test("parseProxyString understands schemes, credentials and defaults", () => {
  assert.deepEqual(parseProxyString("1.2.3.4:8080"), { type: "http", host: "1.2.3.4", port: 8080, username: undefined, password: undefined });
  assert.deepEqual(parseProxyString("socks5://us%40er:p%3Ass@proxy.example:1081"), {
    type: "socks5", host: "proxy.example", port: 1081, username: "us@er", password: "p:ss",
  });
  assert.equal(parseProxyString("socks5h://h").port, 1080);
  assert.equal(parseProxyString("http://h").port, 8080);
  assert.throws(() => parseProxyString("ftp://h:1"), /Unsupported proxy type/);
  assert.throws(() => parseProxyString(""), /empty/);
  assert.throws(() => parseProxyString("http://h:99999"), /Can't read/);
});

// ---- tunnels ----

test("connectVia tunnels through an authenticated HTTP proxy and a SOCKS5 proxy, sending the hostname unresolved", async () => {
  const o = await origin();
  const hp = await httpProxy("bob", "s3cret", o.port);
  const sp = await socksProxy("bob", "s3cret", o.port);
  try {
    for (const up of [
      { type: "http", host: "127.0.0.1", port: hp.port, username: "bob", password: "s3cret" },
      { type: "socks5", host: "127.0.0.1", port: sp.port, username: "bob", password: "s3cret" },
    ] as Upstream[]) {
      const s = await connectVia(up, "only-known-to-proxy.test", 80);
      s.write("GET / HTTP/1.1\r\nHost: only-known-to-proxy.test\r\nConnection: close\r\n\r\n");
      const body = await new Promise<string>((r) => {
        let b = "";
        s.on("data", (d) => (b += d));
        s.on("end", () => r(b));
      });
      assert.match(body, /origin says hi/, up.type);
    }
    assert.ok(hp.seen.includes("CONNECT only-known-to-proxy.test:80"));
    assert.ok(sp.seen.includes("only-known-to-proxy.test:80"));
  } finally {
    o.close(); hp.close(); sp.close();
  }
});

test("wrong credentials give a clear error for both proxy types", async () => {
  const o = await origin();
  const hp = await httpProxy("bob", "s3cret", o.port);
  const sp = await socksProxy("bob", "s3cret", o.port);
  try {
    await assert.rejects(connectVia({ type: "http", host: "127.0.0.1", port: hp.port, username: "bob", password: "nope" }, "x.test", 80), /username\/password/);
    await assert.rejects(connectVia({ type: "socks5", host: "127.0.0.1", port: sp.port, username: "bob", password: "nope" }, "x.test", 80), /username\/password/);
    await assert.rejects(connectVia({ type: "socks5", host: "127.0.0.1", port: hp.port }, "x.test", 80), /SOCKS5|closed|Timed out/);
    await assert.rejects(connectVia({ type: "http", host: "127.0.0.1", port: 1 }, "x.test", 80), /Couldn't reach the proxy/);
  } finally {
    o.close(); hp.close(); sp.close();
  }
});

// ---- the loopback forwarder the browser talks to ----

test("forwarder: plain http and CONNECT go through SOCKS5-with-password and HTTP-with-password upstreams", async () => {
  const o = await origin();
  const hp = await httpProxy("bob", "s3cret", o.port);
  const sp = await socksProxy("bob", "s3cret", o.port);
  const errors: string[] = [];
  try {
    for (const [up, seen] of [
      [{ type: "socks5", host: "127.0.0.1", port: sp.port, username: "bob", password: "s3cret" }, sp.seen],
      [{ type: "http", host: "127.0.0.1", port: hp.port, username: "bob", password: "s3cret" }, hp.seen],
    ] as Array<[Upstream, string[]]>) {
      const f = await startForwarder(up, 0, (m) => errors.push(m));
      try {
        // Plain http:// as a browser sends it: absolute-URI request line.
        assert.equal(await getViaForwarder(f.port, "http://plain.test/hello"), "200 origin says hi");
        // https-style tunnel: CONNECT, then raw bytes.
        const sock = net.connect(f.port, "127.0.0.1");
        sock.write("CONNECT tunnel.test:80 HTTP/1.1\r\nHost: tunnel.test:80\r\n\r\n");
        const reply = await new Promise<string>((r) => sock.once("data", (d) => r(d.toString())));
        assert.match(reply, /^HTTP\/1\.1 200/);
        sock.write("GET / HTTP/1.1\r\nHost: tunnel.test\r\nConnection: close\r\n\r\n");
        const body = await new Promise<string>((r) => {
          let b = "";
          sock.on("data", (d) => (b += d));
          sock.on("end", () => r(b));
        });
        assert.match(body, /origin says hi/);
        assert.ok(seen.some((s) => s.includes("tunnel.test")), "upstream saw the hostname, not an IP");
      } finally {
        await f.close();
      }
    }
    assert.deepEqual(errors, []);
  } finally {
    o.close(); hp.close(); sp.close();
  }
});

test("forwarder: a bad upstream turns into a readable 502 for the browser", async () => {
  const f = await startForwarder({ type: "socks5", host: "127.0.0.1", port: 1 });
  try {
    const out = await getViaForwarder(f.port, "http://x.test/");
    assert.match(out, /^502 .*Couldn't reach the proxy/);
  } finally {
    await f.close();
  }
});

test("forwarder with a token refuses clients that don't present it", async () => {
  const o = await origin();
  const sp = await socksProxy("bob", "s3cret", o.port);
  const f = await startForwarder({ type: "socks5", host: "127.0.0.1", port: sp.port, username: "bob", password: "s3cret" }, 0, () => {}, "tok123");
  try {
    assert.match(await getViaForwarder(f.port, "http://plain.test/"), /^407/);
    const authed = await new Promise<string>((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port: f.port, method: "GET", path: "http://plain.test/", headers: { host: "plain.test", "proxy-authorization": "Basic " + Buffer.from("agent:tok123").toString("base64") } },
        (res) => {
          let b = "";
          res.on("data", (d) => (b += d));
          res.on("end", () => resolve(`${res.statusCode} ${b}`));
        }
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(authed, "200 origin says hi");
    const sock = net.connect(f.port, "127.0.0.1");
    sock.write("CONNECT x.test:80 HTTP/1.1\r\nHost: x.test:80\r\n\r\n");
    assert.match(await new Promise<string>((r) => sock.once("data", (d) => r(d.toString()))), /^HTTP\/1\.1 407/);
    sock.destroy();
  } finally {
    await f.close(); o.close(); sp.close();
  }
});

test("testProxy reports the exit address and flags a proxy that doesn't hide yours", async () => {
  // A plain-HTTP "IP echo": answers with the fixed address it is told to.
  let answer = "203.0.113.7";
  const echo = http.createServer((_q, r) => r.end(answer));
  await new Promise<void>((r) => echo.listen(0, "127.0.0.1", () => r()));
  const echoPort = (echo.address() as net.AddressInfo).port;
  const hp = await httpProxy("bob", "s3cret", echoPort);
  const ep = { host: "ipecho.test", port: 80, tls: false };
  try {
    const good = await testProxy({ type: "http", host: "127.0.0.1", port: hp.port, username: "bob", password: "s3cret" }, ep);
    assert.equal(good.ok, true);
    assert.equal(good.proxyIp, "203.0.113.7");
    assert.match(good.message, /^Works\. Sites see 203\.0\.113\.7/);

    const bad = await testProxy({ type: "http", host: "127.0.0.1", port: hp.port, username: "bob", password: "wrong" }, ep);
    assert.equal(bad.ok, false);
    assert.match(bad.message, /username\/password/);

    const dead = await testProxy({ type: "http", host: "127.0.0.1", port: 1 }, ep);
    assert.equal(dead.ok, false);
    assert.match(dead.message, /Couldn't reach the proxy/);
  } finally {
    echo.close(); hp.close();
  }
});
