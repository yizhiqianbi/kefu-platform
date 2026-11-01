// Page views and contact clicks, sent to /k/h on the same site. No cookies, no storage.
// Mark any other element to count with data-k="name"; forms count by data-k or their id.
(() => {
  if (navigator.webdriver) return;
  const t0 = Date.now();
  const send = (o) => {
    const body = JSON.stringify({ ...o, p: location.pathname, l: document.documentElement.lang || "" });
    if (!(navigator.sendBeacon && navigator.sendBeacon("/k/h", new Blob([body], { type: "text/plain" }))))
      fetch("/k/h", { method: "POST", body, keepalive: true }).catch(() => {});
  };
  const q = new URLSearchParams(location.search);
  send({ k: "pv", r: document.referrer, u: q.get("utm_source") || q.get("ref") || "" });

  const once = new Set();
  const ev = (n) => n && send({ k: "ev", n });
  document.addEventListener("click", (e) => {
    const a = e.target.closest && e.target.closest("a,button,[data-k]");
    if (!a) return;
    const h = a.getAttribute("href") || "";
    ev(a.dataset.k || (h.startsWith("mailto:") ? "email" : h.startsWith("tel:") ? "phone"
      : /wa\.me|whatsapp\.com/.test(h) ? "whatsapp" : a.dataset.quote ? "quote" : ""));
  }, true);
  document.addEventListener("submit", (e) => ev(e.target.dataset.k || e.target.id || "form"), true);
  document.addEventListener("play", (e) => {
    const n = "play:" + (e.target.dataset.k || "video");
    if (!once.has(n)) once.add(n), ev(n);
  }, true);

  let ended = false;
  addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "hidden" || ended) return;
    ended = true;
    send({ k: "end", s: Math.round((Date.now() - t0) / 1000) });
  });
})();
