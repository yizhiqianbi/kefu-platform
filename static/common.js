// Shared helpers for the customer page and the console.
(function () {
  const i = location.pathname.indexOf("/muxu/");
  const BASE = (i >= 0 ? location.pathname.slice(0, i) : "") + "/muxu/";

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  // Escape first, then apply a tiny markdown subset: bold, lists, paragraphs, phone links.
  function md(text) {
    const lines = esc(text).split(/\n/);
    let html = "", list = null;
    const close = () => { if (list) { html += `</${list}>`; list = null; } };
    for (const raw of lines) {
      const line = raw.trimEnd();
      let m;
      if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) {
        if (list !== "ul") { close(); html += "<ul>"; list = "ul"; }
        html += `<li>${inline(m[1])}</li>`;
      } else if ((m = line.match(/^\s*\d+[.)、]\s*(.*)$/))) {
        if (list !== "ol") { close(); html += "<ol>"; list = "ol"; }
        html += `<li>${inline(m[1])}</li>`;
      } else if (!line.trim()) {
        close();
      } else {
        close();
        html += `<p>${inline(line)}</p>`;
      }
    }
    close();
    return html;
  }

  function inline(s) {
    return s
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^\d-])(1[3-9]\d-?\d{4}-?\d{4}|0\d{2,3}-\d{4}-\d{4}|0\d{2,3}-\d{7,8})(?![\d-])/g,
        (_, pre, tel) => `${pre}<a class="tel" href="tel:${tel.replace(/-/g, "")}">${tel}</a>`);
  }

  function errorFrom(status, data) {
    let msg = data && (data.error || data.detail);
    if (Array.isArray(msg)) msg = "提交的内容格式不对。";
    return Object.assign(new Error(msg || `服务出错（${status}）`), { status });
  }

  async function api(path, opts = {}) {
    const init = { method: opts.method || "GET", headers: { ...(opts.headers || {}) }, credentials: "same-origin" };
    if (opts.body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }
    let r;
    try {
      r = await fetch(BASE + path, init);
    } catch (e) {
      throw Object.assign(new Error("网络连不上，请检查网络后重试。"), { kind: "network" });
    }
    let data = null;
    try { data = await r.json(); } catch (e) { /* empty body */ }
    if (!r.ok) throw errorFrom(r.status, data);
    return data;
  }

  // Multipart upload with progress (fetch cannot report upload progress).
  function upload(path, form, { headers = {}, onProgress } = {}) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", BASE + path);
      xhr.withCredentials = true;
      Object.entries(headers).forEach(([k, v]) => xhr.setRequestHeader(k, v));
      xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
      xhr.onload = () => {
        let data = null;
        try { data = JSON.parse(xhr.responseText); } catch (e) { /* not json */ }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(errorFrom(xhr.status, data));
      };
      xhr.onerror = () => reject(Object.assign(new Error("网络连不上，上传失败。"), { kind: "network" }));
      xhr.send(form);
    });
  }

  // POST and read a server-sent event stream. Calls onEvent(name, data) per event.
  async function stream(path, body, { signal, onEvent, headers = {} }) {
    let r;
    try {
      r = await fetch(BASE + path, {
        method: "POST", credentials: "same-origin", signal,
        headers: { ...headers, "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      if (e.name === "AbortError") throw e;
      throw Object.assign(new Error("网络连不上，请检查网络后重试。"), { kind: "network" });
    }
    if (!r.ok) {
      let msg = null;
      try { const d = await r.json(); msg = d.error || d.detail; } catch (e) { /* not json */ }
      if (Array.isArray(msg)) msg = "提交的内容格式不对。";
      throw Object.assign(new Error(msg || `服务出错（${r.status}）`), { status: r.status, kind: "http" });
    }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let k;
      while ((k = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, k);
        buf = buf.slice(k + 2);
        let ev = "message", data = "";
        for (const l of block.split("\n")) {
          if (l.startsWith("event:")) ev = l.slice(6).trim();
          else if (l.startsWith("data:")) data += l.slice(5).trim();
        }
        if (data) {
          try { onEvent(ev, JSON.parse(data)); } catch (e) { if (e.name !== "SyntaxError") throw e; }
        }
      }
    }
  }

  function uid() {
    return (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)).replace(/-/g, "").slice(0, 24);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      const ta = Object.assign(document.createElement("textarea"), { value: text });
      ta.style.cssText = "position:fixed;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    }
  }

  const ICON = {
    up: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10v10H4V10h3Zm2 10h8.2a2 2 0 0 0 2-1.6l1.3-6.5A2 2 0 0 0 18.5 9.5H14l.8-4a1.6 1.6 0 0 0-2.9-1.2L9 9.5V20Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>',
    down: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 14V4H4v10h3Zm2-10h8.2a2 2 0 0 1 2 1.6l1.3 6.5a2 2 0 0 1-2 2.4H14l.8 4a1.6 1.6 0 0 1-2.9 1.2L9 14.5V4Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>',
    copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>',
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    send: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5m0 0-6 6m6-6 6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    stop: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor"/></svg>',
    phone: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.6 3.5h2.6l1.4 4-2 1.3a11 11 0 0 0 6.6 6.6l1.3-2 4 1.4v2.6a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.6 5.7a2 2 0 0 1 2-2.2Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>',
    person: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3.6" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
    plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>',
    retry: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v4.5h4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>',
    arrow: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13m-5-5 5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    doc: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 7 20V3.5Z M14 3.5v4h4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
  };

  window.MX = { BASE, esc, md, api, upload, stream, uid, copyText, ICON };
})();
