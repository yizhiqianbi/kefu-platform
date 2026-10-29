// 把在线咨询挂到网站右下角：<script src=".../muxu/embed.js" data-tenant="客户标识" data-color="#b06a3b" async></script>
(function () {
  var me = document.currentScript;
  if (!me || window.__mxEmbed) return;
  window.__mxEmbed = true;
  var slug = me.getAttribute("data-tenant");
  if (!slug) return;
  var base = me.src.replace(/embed\.js(\?.*)?$/, "");
  var color = /^#[0-9a-f]{6}$/i.test(me.getAttribute("data-color") || "") ? me.getAttribute("data-color") : "#2a201a";
  var label = me.getAttribute("data-label") || "在线咨询";

  var css = document.createElement("style");
  css.textContent =
    ".mx-btn{position:fixed;right:20px;bottom:20px;z-index:2147483000;display:flex;align-items:center;gap:8px;height:48px;padding:0 20px;" +
    "border:0;border-radius:999px;background:" + color + ";color:#fff;font:500 15px/1 -apple-system,'PingFang SC','Microsoft YaHei',sans-serif;" +
    "box-shadow:0 8px 24px rgba(0,0,0,.18);cursor:pointer;transition:transform .15s}" +
    ".mx-btn:hover{transform:translateY(-2px)}.mx-btn svg{width:20px;height:20px}" +
    ".mx-panel{position:fixed;right:20px;bottom:84px;z-index:2147483000;width:400px;height:min(640px,calc(100vh - 110px));border:0;" +
    "border-radius:18px;box-shadow:0 20px 60px rgba(0,0,0,.22);background:#fff;opacity:0;transform:translateY(12px);pointer-events:none;" +
    "transition:opacity .2s,transform .2s}.mx-panel.open{opacity:1;transform:none;pointer-events:auto}" +
    "@media (max-width:520px){.mx-panel{right:0;bottom:0;width:100vw;height:100vh;border-radius:0}.mx-panel.open+.mx-btn{display:none}}";
  document.head.appendChild(css);

  var frame = document.createElement("iframe");
  frame.className = "mx-panel";
  frame.title = label;
  frame.setAttribute("allow", "clipboard-write");
  var btn = document.createElement("button");
  btn.className = "mx-btn";
  btn.type = "button";
  btn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 4v-4h0A1.5 1.5 0 0 1 4 14.5v-9Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg><span></span>';
  btn.querySelector("span").textContent = label;

  function toggle(open) {
    if (open && !frame.src) frame.src = base + "c/" + encodeURIComponent(slug) + "/?embed=1";
    frame.classList.toggle("open", open);
    btn.setAttribute("aria-expanded", open ? "true" : "false");
  }
  btn.addEventListener("click", function () { toggle(!frame.classList.contains("open")); });
  window.addEventListener("message", function (e) {
    if (e.source === frame.contentWindow && e.data && e.data.type === "mx-close") toggle(false);
  });
  document.body.appendChild(frame);
  document.body.appendChild(btn);
})();
