// Document Converter — browser-native file conversion. Everything runs in the
// side panel with web APIs; no server, no runtime dependencies.
//
//   CSV ↔ JSON · Markdown → HTML · HTML table → CSV / JSON · text → file
//   image format / resize (Canvas) · screenshot → PNG / JPEG
//   Markdown / HTML → PDF: the document is prepared here and rendered by
//   browserTools.js through the DevTools protocol (no print dialog).
//
// Entry: AgentConverter.convert(opts) (a global — the side panel and the service worker both load this file)
//          → { blob, filename, mimeType, rows?, size?, text? }   a file to save
//          → { html, filename, mimeType }                        a document to render to PDF
//          → { error }
//        AgentConverter.download(blob, filename) → { ok, filename, size } | { ok: false, error }
(function () {

  // ── CSV parser/generator ───────────────────────────────────────────────

  function parseCSV(text, delimiter) {
    delimiter = delimiter || ",";
    var rows = [];
    var row = [];
    var field = "";
    var inQuote = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (inQuote) {
        if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
        else if (ch === '"') inQuote = false;
        else field += ch;
      } else {
        if (ch === '"') inQuote = true;
        else if (ch === delimiter) { row.push(field); field = ""; }
        else if (ch === "\n" || (ch === "\r" && text[i + 1] === "\n")) {
          if (ch === "\r") i++;
          row.push(field); field = "";
          if (row.length > 1 || row[0] !== "") rows.push(row);
          row = [];
        } else field += ch;
      }
    }
    row.push(field);
    if (row.length > 1 || row[0] !== "") rows.push(row);
    return rows;
  }

  function toCSV(rows, delimiter) {
    delimiter = delimiter || ",";
    return rows.map(function (row) {
      return row.map(function (cell) {
        var s = String(cell == null ? "" : cell);
        if (s.indexOf(delimiter) !== -1 || s.indexOf('"') !== -1 || s.indexOf("\n") !== -1) {
          return '"' + s.replace(/"/g, '""') + '"';
        }
        return s;
      }).join(delimiter);
    }).join("\n");
  }

  // ── Markdown → HTML (lightweight) ──────────────────────────────────────

  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // Fenced code is lifted out first, so nothing inside it is formatted or wrapped in <p>.
  function mdToHtml(md) {
    var blocks = [];
    var src = String(md || "").replace(/\r\n?/g, "\n").replace(/```[\w-]*\n([\s\S]*?)```/g, function (_, code) {
      blocks.push("<pre><code>" + escapeHtml(code.replace(/\n$/, "")) + "</code></pre>");
      return "\u0000" + (blocks.length - 1) + "\u0000";
    });
    var html = escapeHtml(src)
      // Headers
      .replace(/^######\s+(.+)$/gm, "<h6>$1</h6>")
      .replace(/^#####\s+(.+)$/gm, "<h5>$1</h5>")
      .replace(/^####\s+(.+)$/gm, "<h4>$1</h4>")
      .replace(/^###\s+(.+)$/gm, "<h3>$1</h3>")
      .replace(/^##\s+(.+)$/gm, "<h2>$1</h2>")
      .replace(/^#\s+(.+)$/gm, "<h1>$1</h1>")
      // Bold, italic, code
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
      .replace(/`([^`\n]+)`/g, "<code>$1</code>")
      // Links, images
      .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img src="$2" alt="$1" style="max-width:100%"/>')
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
      // Lists
      .replace(/^\s*[-*]\s+(.+)$/gm, "<li>$1</li>")
      .replace(/(<li>.*<\/li>\n?)+/g, "<ul>$&</ul>")
      // Horizontal rule
      .replace(/^---+$/gm, "<hr/>")
      // Paragraphs (lines not already wrapped, and not a code-block placeholder)
      .replace(/^(?!<[huplo]|<li|<hr|<pre|\u0000)(.+)$/gm, "<p>$1</p>");
    return html.replace(/\u0000(\d+)\u0000/g, function (_, i) { return blocks[Number(i)]; });
  }

  var DOC_STYLE =
    "body{font-family:system-ui,sans-serif;max-width:800px;margin:40px auto;line-height:1.6;color:#222}" +
    "pre{background:#f5f5f5;padding:12px;overflow-x:auto}code{background:#f0f0f0;padding:2px 4px}pre code{background:none;padding:0}" +
    "table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:8px;text-align:left}th{background:#f5f5f5}" +
    "img{max-width:100%}h1,h2,h3{margin-top:1.5em}";

  /** A complete HTML document around a body fragment (titles and user text are escaped). */
  function wrapDocument(title, bodyHtml) {
    return "<!DOCTYPE html><html><head><meta charset='utf-8'><title>" + escapeHtml(title || "Document") +
      "</title><style>" + DOC_STYLE + "</style></head><body>" + bodyHtml + "</body></html>";
  }

  // ── HTML table → structured data ───────────────────────────────────────

  // Parsed in a detached document: the HTML comes from a page or the model and must not run here.
  function htmlTableToRows(html) {
    var doc = new DOMParser().parseFromString(String(html || ""), "text/html");
    var table = doc.querySelector("table");
    if (!table) return null;
    var rows = [];
    table.querySelectorAll("tr").forEach(function (tr) {
      var cells = [];
      tr.querySelectorAll("th, td").forEach(function (cell) {
        cells.push(cell.textContent.replace(/\s+/g, " ").trim());
      });
      if (cells.length) rows.push(cells);
    });
    return rows;
  }

  // ── Image conversion via Canvas ────────────────────────────────────────

  // Quality may come as 0–1 or 0–100 (the tools document both); Canvas wants 0–1.
  function canvasQuality(q, fallback) {
    var n = Number(q);
    if (!(n > 0)) return fallback;
    return n > 1 ? Math.min(1, n / 100) : n;
  }

  async function convertImage(dataUrl, opts) {
    var format = opts.format || "image/png";
    var quality = canvasQuality(opts.quality, 0.85);
    var maxWidth = opts.maxWidth || 0;
    var maxHeight = opts.maxHeight || 0;

    var blob = await (await fetch(dataUrl)).blob();
    var bmp = await createImageBitmap(blob);
    var w = bmp.width, h = bmp.height;

    if (maxWidth && w > maxWidth) { h = Math.round(h * maxWidth / w); w = maxWidth; }
    if (maxHeight && h > maxHeight) { w = Math.round(w * maxHeight / h); h = maxHeight; }

    var canvas = new OffscreenCanvas(w, h);
    canvas.getContext("2d").drawImage(bmp, 0, 0, w, h);
    bmp.close();

    return canvas.convertToBlob({ type: format, quality: quality });
  }

  // ── Generate downloadable file from data ───────────────────────────────

  function makeBlob(content, mimeType) {
    if (content instanceof Blob) return content;
    if (content instanceof ArrayBuffer || content instanceof Uint8Array) {
      return new Blob([content], { type: mimeType || "application/octet-stream" });
    }
    return new Blob([content], { type: mimeType || "text/plain;charset=utf-8" });
  }

  // ── Download ───────────────────────────────────────────────────────────
  // Saves to the downloads folder and waits for the file to be complete. It is
  // never opened: chrome.downloads.open needs a user gesture a tool call lacks.

  // A service worker (background.js, running a recipe for a watcher) has no URL.createObjectURL:
  // the file goes as a data: URL instead.
  function blobUrl(blob) {
    if (typeof URL.createObjectURL === "function") return Promise.resolve(URL.createObjectURL(blob));
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  }
  function revoke(url) {
    if (url.indexOf("blob:") === 0) URL.revokeObjectURL(url);
  }

  function download(blob, filename) {
    return blobUrl(blob).then(function (url) { return downloadUrl(url, filename); });
  }

  function downloadUrl(url, filename) {
    return new Promise(function (resolve) {
      chrome.downloads.download({ url: url, filename: filename, conflictAction: "uniquify" }, function (id) {
        if (chrome.runtime.lastError) {
          revoke(url);
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        var checks = 0;
        var timer = setInterval(function () {
          chrome.downloads.search({ id: id }, function (items) {
            if (!items || !items.length) { clearInterval(timer); revoke(url); resolve({ ok: false, error: "the download disappeared" }); return; }
            var item = items[0];
            if (item.state === "complete") {
              clearInterval(timer);
              revoke(url);
              resolve({ ok: true, filename: item.filename, size: item.fileSize });
            } else if (item.state === "interrupted") {
              clearInterval(timer);
              revoke(url);
              resolve({ ok: false, error: item.error || "interrupted" });
            } else if (++checks > 60) {
              clearInterval(timer);
              revoke(url);
              resolve({ ok: false, error: "the download did not finish within 30 s" });
            }
          });
        }, 500);
      });
    });
  }

  // ── Main convert function ──────────────────────────────────────────────

  async function convert(opts) {
    var from = (opts.from || "").toLowerCase();
    var to = (opts.to || "").toLowerCase();
    var data = opts.data || "";
    var filename = opts.filename || "";

    // CSV → JSON
    if (from === "csv" && to === "json") {
      var rows = parseCSV(data, opts.delimiter);
      if (!rows.length) return { error: "Empty CSV" };
      var headers = rows[0];
      var objects = rows.slice(1).map(function (r) {
        var obj = {};
        headers.forEach(function (h, i) { obj[h] = r[i] || ""; });
        return obj;
      });
      var json = JSON.stringify(objects, null, 2);
      return { blob: makeBlob(json, "application/json"), text: json, filename: filename || "data.json", mimeType: "application/json", rows: objects.length };
    }

    // JSON → CSV
    if (from === "json" && to === "csv") {
      var arr;
      try { arr = typeof data === "string" ? JSON.parse(data) : data; } catch (e) { return { error: "Invalid JSON: " + e.message }; }
      if (!Array.isArray(arr) || !arr.length) return { error: "Expected JSON array of objects" };
      var keys = Object.keys(arr[0]);
      var csvRows = [keys];
      arr.forEach(function (obj) { csvRows.push(keys.map(function (k) { return obj[k]; })); });
      var csv = toCSV(csvRows, opts.delimiter);
      return { blob: makeBlob(csv, "text/csv"), text: csv, filename: filename || "data.csv", mimeType: "text/csv", rows: arr.length };
    }

    // Markdown → HTML / PDF
    if (from === "md" && (to === "html" || to === "pdf")) {
      var fullHtml = wrapDocument(opts.title, mdToHtml(data));
      if (to === "pdf") return { html: fullHtml, filename: filename || "document.pdf", mimeType: "application/pdf" };
      return { blob: makeBlob(fullHtml, "text/html"), text: fullHtml, filename: filename || "document.html", mimeType: "text/html" };
    }

    // HTML → PDF (a fragment gets the document styles; a full document is rendered as is)
    if (from === "html" && to === "pdf") {
      var doc = /<html[\s>]/i.test(data) ? data : wrapDocument(opts.title, data);
      return { html: doc, filename: filename || "document.pdf", mimeType: "application/pdf" };
    }

    // HTML table → CSV / JSON
    if (from === "table" && (to === "csv" || to === "json")) {
      var tableRows = htmlTableToRows(data);
      if (!tableRows) return { error: "No table found in the HTML" };
      if (to === "json") {
        var h = tableRows[0];
        var objs = tableRows.slice(1).map(function (r) {
          var o = {};
          h.forEach(function (k, i) { o[k] = r[i] || ""; });
          return o;
        });
        var j = JSON.stringify(objs, null, 2);
        return { blob: makeBlob(j, "application/json"), text: j, filename: filename || "table.json", mimeType: "application/json", rows: objs.length };
      }
      var c = toCSV(tableRows, opts.delimiter);
      return { blob: makeBlob(c, "text/csv"), text: c, filename: filename || "table.csv", mimeType: "text/csv", rows: tableRows.length };
    }

    // Text → file (any text to downloadable file)
    if (from === "text" && to) {
      var ext = to.replace(/^\./, "");
      var mime = { txt: "text/plain", html: "text/html", css: "text/css", js: "text/javascript",
        json: "application/json", xml: "application/xml", csv: "text/csv", md: "text/markdown",
        svg: "image/svg+xml", py: "text/x-python", sh: "text/x-shellscript" }[ext] || "text/plain";
      return { blob: makeBlob(data, mime), filename: filename || ("file." + ext), mimeType: mime };
    }

    // Image conversion (PNG ↔ JPEG ↔ WebP, resize)
    if ((from === "image" || /^data:image\//.test(data)) && to) {
      var formats = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };
      var fmt = formats[to];
      if (!fmt) return { error: "Supported image formats: png, jpg, webp" };
      if (!/^data:image\//.test(data)) return { error: "Image input must be a data: URL (data:image/png;base64,…)" };
      var imgBlob = await convertImage(data, { format: fmt, quality: opts.quality, maxWidth: opts.maxWidth, maxHeight: opts.maxHeight });
      var imgExt = to === "jpeg" ? "jpg" : to;
      return { blob: imgBlob, filename: filename || ("image." + imgExt), mimeType: fmt, size: imgBlob.size };
    }

    // Page screenshot → PNG / JPEG file. The caller names the window of the tab the agent works in;
    // without it, the panel's own window is used.
    if (from === "screenshot") {
      var windowId = opts.windowId;
      if (windowId === undefined) {
        var tab = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab[0]) return { error: "No active tab" };
        windowId = tab[0].windowId;
      }
      var jpeg = to === "jpg" || to === "jpeg";
      var capture = { format: jpeg ? "jpeg" : "png" };
      if (jpeg) capture.quality = Math.round(canvasQuality(opts.quality, 0.8) * 100);
      var dataUrl = await chrome.tabs.captureVisibleTab(windowId, capture);
      var binary = atob(dataUrl.split(",")[1]);
      var bytes = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      var screenshotBlob = new Blob([bytes], { type: jpeg ? "image/jpeg" : "image/png" });
      return { blob: screenshotBlob, filename: filename || ("screenshot." + (jpeg ? "jpg" : "png")), mimeType: screenshotBlob.type, size: screenshotBlob.size };
    }

    return { error: "Unknown conversion: " + from + " → " + to + ". Supported: csv↔json, md→html, md→pdf, html→pdf, table→csv, table→json, text→(any), image→(png/jpg/webp), screenshot→png/jpg" };
  }

  // ── Expose ─────────────────────────────────────────────────────────────

  globalThis.AgentConverter = {
    convert: convert,
    download: download,
    parseCSV: parseCSV,
    toCSV: toCSV,
    mdToHtml: mdToHtml,
  };
})();
