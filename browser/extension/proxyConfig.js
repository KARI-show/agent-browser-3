// Proxy settings validation, shared by the options page (before saving) and the
// service worker (before applying) so the two can't disagree about what is valid.
// Plain script: loaded with <script> there and importScripts() here.
(function () {
  /** The reason a saved proxy config can't be applied, or null when it can (or is off). */
  function validate(c) {
    if (!c || !c.enabled) return null;
    var port = Number(c.port);
    if (!c.host || !String(c.host).trim()) return "Enter the proxy host.";
    if (!Number.isInteger(port) || port < 1 || port > 65535) return "Enter a port between 1 and 65535.";
    if (["http", "https", "socks5"].indexOf(c.type) === -1) return "Unknown proxy type.";
    return null;
  }

  globalThis.AgentProxyConfig = { validate: validate };
})();
