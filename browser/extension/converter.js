// ═══════════════════════════════════════════════════════════════════════════
// Document Converter — browser-native file conversion engine
//
// All conversions run locally in the extension using browser APIs + pure JS.
// No server calls. No external dependencies at runtime.
//
// Supported:
//   HTML/page → PDF          (print-based)
//   HTML table → CSV/JSON    (DOM parsing)
//   CSV ↔ JSON               (pure JS)
//   Markdown → HTML          (regex-based lightweight parser)
//   Image format conversion  (Canvas API: PNG ↔ JPEG ↔ WebP)
//   Image resize/compress    (Canvas API)
//   Page → screenshot PNG    (tabs.captureVisibleTab)
//   Text/HTML → downloadable file
//
// Entry: window.AgentConverter.convert(opts) → {blob, filename, mimeType}
//        window.AgentConverter.downloadAndOpen(blob, filename)
// ═══════════════════════════════════════════════════════════════════════════
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

  function mdToHtml(md) {
    var html = md
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      // Headers
      .replace(/^######\s+(.+)$/gm, "<h6>$1</h6>")
      .replace(/^#####\s+(.+)$/gm, "<h5>$1</h5>")
      .replace(/^####\s+(.+)$/gm, "<h4>$1</h4>")
      .replace(/^###\s+(.+)$/gm, "<h3>$1</h3>")
      .replace(/^##\s+(.+)$/gm, "<h2>$1</h2>")
      .replace(/^#\s+(.+)$/gm, "<h1>$1</h1>")
      // Bold, italic, code
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      // Links, images
      .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" style="max-width:100%"/>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
      // Lists
      .replace(/^\s*[-*]\s+(.+)$/gm, "<li>$1</li>")
      .replace(/(<li>.*<\/li>\n?)+/g, "<ul>$&</ul>")
      // Horizontal rule
      .replace(/^---+$/gm, "<hr/>")
      // Code blocks
      .replace(/```[\w]*\n([\s\S]*?)```/g, "<pre><code>$1</code></pre>")
      // Paragraphs (lines not already wrapped)
      .replace(/^(?!<[huplo]|<li|<hr|<pre)(.+)$/gm, "<p>$1</p>");
    return html;
  }

  // ── HTML table → structured data ───────────────────────────────────────

  function htmlTableToRows(html) {
    var div = document.createElement("div");
    div.innerHTML = html;
    var table = div.querySelector("table");
    if (!table) return null;
    var rows = [];
    table.querySelectorAll("tr").forEach(function (tr) {
      var cells = [];
      tr.querySelectorAll("th, td").forEach(function (cell) {
        cells.push(cell.innerText.replace(/\s+/g, " ").trim());
      });
      if (cells.length) rows.push(cells);
    });
    return rows;
  }

  // ── Image conversion via Canvas ────────────────────────────────────────

  async function convertImage(dataUrl, opts) {
    var format = opts.format || "image/png";
    var quality = opts.quality || 0.85;
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

    var outBlob = await canvas.convertToBlob({ type: format, quality: quality });
    return outBlob;
  }

  // ── HTML → printable PDF (via print) ───────────────────────────────────

  function htmlToPrintPdf(html, title) {
    // Open a hidden window, write HTML, trigger print (saves as PDF)
    return new Promise(function (resolve) {
      var w = window.open("", "_blank", "width=800,height=600");
      if (!w) { resolve(null); return; }
      w.document.write("<!DOCTYPE html><html><head><title>" + (title || "Document") + "</title>" +
        "<style>body{font-family:system-ui,sans-serif;margin:40px;line-height:1.6;color:#222}" +
        "table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:8px;text-align:left}" +
        "th{background:#f5f5f5}pre{background:#f5f5f5;padding:12px;overflow-x:auto}" +
        "img{max-width:100%}h1,h2,h3{margin-top:1.5em}</style></head><body>" +
        html + "</body></html>");
      w.document.close();
      // Give it a moment to render, then print
      setTimeout(function () {
        w.print();
        setTimeout(function () { w.close(); resolve(true); }, 1000);
      }, 500);
    });
  }

  // ── Generate downloadable file from data ───────────────────────────────

  function makeBlob(content, mimeType) {
    if (content instanceof Blob) return content;
    if (content instanceof ArrayBuffer || content instanceof Uint8Array) {
      return new Blob([content], { type: mimeType || "application/octet-stream" });
    }
    return new Blob([content], { type: mimeType || "text/plain;charset=utf-8" });
  }

  // ── Download + Open ────────────────────────────────────────────────────

  var SAFE_OPEN = /\.(pdf|docx?|xlsx?|csv|txt|html?|png|jpe?g|gif|webp|svg|json|xml|md|rtf)$/i;

  function downloadAndOpen(blob, filename, forceOpen) {
    var url = URL.createObjectURL(blob);
    return new Promise(function (resolve) {
      chrome.downloads.download({ url: url, filename: filename, conflictAction: "uniquify" }, function (id) {
        if (chrome.runtime.lastError) {
          URL.revokeObjectURL(url);
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        var checks = 0;
        var timer = setInterval(function () {
          chrome.downloads.search({ id: id }, function (items) {
            if (!items || !items.length) { clearInterval(timer); resolve({ ok: false, error: "not found" }); return; }
            var item = items[0];
            if (item.state === "complete") {
              clearInterval(timer);
              URL.revokeObjectURL(url);
              if (!(forceOpen || SAFE_OPEN.test(filename))) {
                resolve({ ok: true, filename: item.filename, opened: false, size: item.fileSize });
                return;
              }
              // chrome.downloads.open needs a user gesture; a tool call never has
              // one, so it rejects (a Promise in MV3). Report what actually
              // happened instead of claiming "opened" and leaking the rejection.
              Promise.resolve()
                .then(function () { return chrome.downloads.open(id); })
                .then(
                  function () { resolve({ ok: true, filename: item.filename, opened: true, size: item.fileSize }); },
                  function () { resolve({ ok: true, filename: item.filename, opened: false, size: item.fileSize }); }
                );
            } else if (item.state === "interrupted") {
              clearInterval(timer);
              resolve({ ok: false, error: item.error || "interrupted" });
            } else if (++checks > 60) {
              clearInterval(timer);
              resolve({ ok: false, error: "timeout" });
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
      var blob = makeBlob(json, "application/json");
      return { blob: blob, text: json, filename: filename || "data.json", mimeType: "application/json", rows: objects.length };
    }

    // JSON → CSV
    if (from === "json" && to === "csv") {
      var arr = typeof data === "string" ? JSON.parse(data) : data;
      if (!Array.isArray(arr) || !arr.length) return { error: "Expected JSON array of objects" };
      var keys = Object.keys(arr[0]);
      var csvRows = [keys];
      arr.forEach(function (obj) { csvRows.push(keys.map(function (k) { return obj[k]; })); });
      var csv = toCSV(csvRows, opts.delimiter);
      var blob2 = makeBlob(csv, "text/csv");
      return { blob: blob2, text: csv, filename: filename || "data.csv", mimeType: "text/csv", rows: arr.length };
    }

    // Markdown → HTML
    if (from === "md" && (to === "html" || to === "pdf")) {
      var html = mdToHtml(data);
      if (to === "pdf") {
        await htmlToPrintPdf(html, opts.title);
        return { text: "PDF print dialog opened. Save as PDF from the print dialog.", filename: "document.pdf" };
      }
      var fullHtml = "<!DOCTYPE html><html><head><meta charset='utf-8'><title>" + (opts.title || "Document") +
        "</title><style>body{font-family:system-ui,sans-serif;max-width:800px;margin:40px auto;line-height:1.6;color:#222}" +
        "pre{background:#f5f5f5;padding:12px;overflow-x:auto}code{background:#f0f0f0;padding:2px 4px}" +
        "table{border-collapse:collapse}th,td{border:1px solid #ccc;padding:8px}</style></head><body>" +
        html + "</body></html>";
      var blob3 = makeBlob(fullHtml, "text/html");
      return { blob: blob3, text: fullHtml, filename: filename || "document.html", mimeType: "text/html" };
    }

    // HTML → PDF (print-based)
    if (from === "html" && to === "pdf") {
      await htmlToPrintPdf(data, opts.title);
      return { text: "PDF print dialog opened. Choose 'Save as PDF' as the printer.", filename: "document.pdf" };
    }

    // HTML table → CSV
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
      var c = toCSV(tableRows);
      return { blob: makeBlob(c, "text/csv"), text: c, filename: filename || "table.csv", mimeType: "text/csv", rows: tableRows.length };
    }

    // Text → file (any text to downloadable file)
    if (from === "text" && to) {
      var ext = to.replace(/^\./, "");
      var mime = { txt: "text/plain", html: "text/html", css: "text/css", js: "text/javascript",
        json: "application/json", xml: "application/xml", csv: "text/csv", md: "text/markdown",
        svg: "image/svg+xml", py: "text/x-python", sh: "text/x-shellscript" }[ext] || "text/plain";
      var b = makeBlob(data, mime);
      return { blob: b, filename: filename || ("file." + ext), mimeType: mime };
    }

    // Image conversion (PNG ↔ JPEG ↔ WebP, resize)
    if ((from === "image" || /^data:image\//.test(data)) && to) {
      var formats = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };
      var fmt = formats[to];
      if (!fmt) return { error: "Supported image formats: png, jpg, webp" };
      var imgBlob = await convertImage(data, { format: fmt, quality: opts.quality, maxWidth: opts.maxWidth, maxHeight: opts.maxHeight });
      var imgExt = to === "jpeg" ? "jpg" : to;
      return { blob: imgBlob, filename: filename || ("image." + imgExt), mimeType: fmt, size: imgBlob.size };
    }

    // Page screenshot → PNG file
    if (from === "screenshot") {
      var tab = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab[0]) return { error: "No active tab" };
      var dataUrl = await chrome.tabs.captureVisibleTab(tab[0].windowId, { format: to === "jpg" ? "jpeg" : "png", quality: opts.quality || 80 });
      var imgData = dataUrl.split(",")[1];
      var binary = atob(imgData);
      var bytes = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      var ext2 = to === "jpg" ? "jpg" : "png";
      var screenshotBlob = new Blob([bytes], { type: "image/" + (ext2 === "jpg" ? "jpeg" : "png") });
      return { blob: screenshotBlob, filename: filename || ("screenshot." + ext2), mimeType: screenshotBlob.type, size: screenshotBlob.size };
    }

    return { error: "Unknown conversion: " + from + " → " + to + ". Supported: csv↔json, md→html, md→pdf, html→pdf, table→csv, table→json, text→(any), image→(png/jpg/webp), screenshot→png" };
  }

  // ── Expose ─────────────────────────────────────────────────────────────

  window.AgentConverter = {
    convert: convert,
    downloadAndOpen: downloadAndOpen,
    parseCSV: parseCSV,
    toCSV: toCSV,
    mdToHtml: mdToHtml,
    SAFE_OPEN: SAFE_OPEN,
  };
})();
