(function () {
  const { api, stream, md, esc, uid, copyText, ICON } = window.MX;
  const $ = (id) => document.getElementById(id);
  const thread = $("thread"), input = $("input"), sendBtn = $("send"), form = $("form");
  let cfg = window.MX_CFG;
  const SLUG = cfg.slug;
  const PUB = `api/public/${SLUG}/`;
  const EMBED = new URLSearchParams(location.search).has("embed");
  const KEY_SID = `mx.${SLUG}.sid`, KEY_TURNS = `mx.${SLUG}.turns`;
  const WATCHDOG_MS = 100000;
  const PHONE_RE = /^(1[3-9]\d{9}|0\d{2,3}-?\d{7,8})$/;

  let sid = localStorage.getItem(KEY_SID) || newSid();
  let turns = load();
  let busy = null;            // { ctrl, turn, timers }
  let online = navigator.onLine;
  let stick = true;

  function newSid() { const s = uid(); localStorage.setItem(KEY_SID, s); return s; }
  function load() {
    try {
      const t = JSON.parse(localStorage.getItem(KEY_TURNS) || "[]");
      t.forEach((x) => { if (x.status === "streaming") x.status = x.text ? "stopped" : "error"; });
      return t;
    } catch (e) { return []; }
  }
  function save() {
    try { localStorage.setItem(KEY_TURNS, JSON.stringify(turns.slice(-60))); } catch (e) { /* storage full or disabled */ }
  }

  // ---------- rendering ----------

  function telLink(label, n) {
    return n ? `<a class="tel" href="tel:${n.replace(/-/g, "")}">${label ? label + " " : ""}${esc(n)}</a>` : "";
  }
  function phoneLinks() {
    return [telLink("销售", cfg.sales_phone), telLink("售后", cfg.service_phone)].filter(Boolean).join("");
  }
  const mainPhone = () => cfg.sales_phone || cfg.service_phone || "";

  function renderAll() {
    thread.innerHTML = "";
    if (!turns.length) thread.appendChild(heroEl());
    turns.forEach((t) => thread.appendChild(turnEl(t)));
    refreshChips();
    scrollEnd(true);
  }

  function heroEl() {
    const el = document.createElement("section");
    el.className = "hero";
    const items = cfg.quick.map((x) => (Array.isArray(x) ? x : ["", x]));
    el.innerHTML = `<h2>您好，想了解点什么？</h2><p>${esc(cfg.welcome)}</p>
      <div class="qgrid">${items.map(([tag, q]) => `<button class="qcard" type="button" data-q="${esc(q)}">
        ${tag ? `<span class="qtag">${esc(tag)}</span>` : ""}<span class="qtext">${esc(q)}${ICON.arrow}</span></button>`).join("")}</div>`;
    el.querySelectorAll(".qcard").forEach((b) => b.addEventListener("click", () => send(b.dataset.q)));
    return el;
  }

  function refreshChips() {
    thread.querySelectorAll(".qcard").forEach((b) => { b.disabled = !!busy; });
  }

  function turnEl(t) {
    const el = document.createElement("div");
    el.dataset.id = t.id;
    if (t.role === "user") {
      el.className = "row user";
      el.innerHTML = `<div class="col"><div class="bubble"></div></div>`;
      el.querySelector(".bubble").textContent = t.text;
      return el;
    }
    if (t.role === "note") {
      el.className = "row bot";
      el.innerHTML = `<div class="avatar">${esc(cfg.short.slice(0, 1))}</div><div class="col"><div class="card done">
        <span class="ck">${ICON.check}</span><div><h3>已提交回电请求</h3><p>同事会打给 ${esc(t.text)}，您也可以继续在这里提问。</p></div></div></div>`;
      return el;
    }
    el.className = "row bot" + (t.status === "streaming" ? " streaming" : "");
    el.innerHTML = `<div class="avatar">${esc(cfg.short.slice(0, 1))}</div><div class="col"></div>`;
    fillBot(el.querySelector(".col"), t);
    return el;
  }

  function fillBot(col, t) {
    let html = "";
    if (t.status === "streaming" && !t.text) {
      html += `<div class="bubble"><span class="typing" aria-label="正在输入"><i></i><i></i><i></i></span></div>`;
      if (t.hint) html += `<p class="wait-hint">${esc(t.hint)}</p>`;
    } else if (t.text) {
      html += `<div class="bubble">${md(t.text)}</div>`;
    }
    if (t.status === "ok") {
      html += `<div class="meta">
        <button type="button" data-act="copy" title="复制" aria-label="复制">${ICON.copy}</button>
        <button type="button" data-act="up" class="${t.rating === "up" ? "on" : ""}" title="有帮助" aria-label="有帮助" aria-pressed="${t.rating === "up"}">${ICON.up}</button>
        <button type="button" data-act="down" class="down ${t.rating === "down" ? "on" : ""}" title="没帮助" aria-label="没帮助" aria-pressed="${t.rating === "down"}">${ICON.down}</button>
        ${t.rating === "down" ? `<span class="note">已记下，我们会补上这个问题</span>` : ""}
      </div>`;
      const tel = mainPhone() ? `<a href="tel:${mainPhone().replace(/-/g, "")}">${ICON.phone}直接打电话</a>` : "";
      if (t.handoff && couldNotAnswer(t.text)) {
        html += `<div class="card"><h3>这个问题请同事来答</h3><p>留个电话，同事会打给您${tel ? "；也可以直接打过去" : ""}。</p>
          <div class="card-actions"><button type="button" class="main" data-act="handoff">${ICON.person}留电话回电</button>${tel}</div></div>`;
      } else if (t.handoff) {
        html += `<div class="handoff-line"><span>需要同事跟进？</span>
          <button type="button" data-act="handoff">${ICON.person}留电话回电</button>${tel}</div>`;
      }
    } else if (t.status === "stopped") {
      html += `<div class="meta"><span class="note">已停止回答</span>
        <button type="button" data-act="retry">${ICON.retry}重新回答</button></div>`;
    } else if (t.status === "error") {
      html += `<div class="card err"><h3>${esc(t.errTitle || "没能回答")}</h3><p>${esc(t.err || "请稍后重试。")}</p>
        <div class="card-actions"><button type="button" class="main" data-act="retry">${ICON.retry}重试</button>
        <button type="button" data-act="handoff">${ICON.person}转人工</button></div></div>`;
    }
    col.innerHTML = html;
    col.querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", () => onAction(t, b.dataset.act, b)));
  }

  // The bot gave no real answer (the configured empty response, or a short "let me check").
  function couldNotAnswer(text) {
    return /^这个问题我需要确认/.test(text) || text.length < 70;
  }

  function update(t) {
    const el = thread.querySelector(`[data-id="${t.id}"]`);
    if (!el) return;
    el.classList.toggle("streaming", t.status === "streaming");
    fillBot(el.querySelector(".col"), t);
    scrollEnd();
  }

  function append(t) {
    thread.querySelector(".hero")?.remove();
    turns.push(t);
    thread.appendChild(turnEl(t));
    scrollEnd(true);
  }

  // ---------- scrolling ----------

  function nearBottom() { return thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80; }
  function scrollEnd(force) {
    if (force) stick = true;
    if (stick) {
      requestAnimationFrame(() => { thread.scrollTop = thread.scrollHeight; });
      $("jump").hidden = true;
    } else {
      $("jump").hidden = false;
    }
  }
  thread.addEventListener("scroll", () => {
    stick = nearBottom();
    if (stick) $("jump").hidden = true;
  }, { passive: true });
  $("jump").addEventListener("click", () => scrollEnd(true));

  // ---------- sending ----------

  function history(beforeIndex) {
    const out = [];
    for (let i = 0; i < beforeIndex; i++) {
      const t = turns[i], next = turns[i + 1];
      if (t.role === "user" && next && next.role === "bot" && next.status === "ok") {
        out.push({ role: "user", content: t.text }, { role: "assistant", content: next.text });
      }
    }
    return out.slice(-6);
  }

  async function send(text, { reuse } = {}) {
    text = (text || "").trim();
    if (!text || busy) return;
    if (text.length > cfg.max_len) { toast(`问题太长了，请控制在 ${cfg.max_len} 字以内`); return; }
    if (!online) { toast(offlineText()); checkHealth(); return; }

    let userTurn = reuse;
    if (!userTurn) {
      userTurn = { id: uid(), role: "user", text };
      append(userTurn);
    }
    const bot = { id: uid(), role: "bot", text: "", status: "streaming", q: text };
    append(bot);
    const hist = history(turns.indexOf(userTurn));

    const ctrl = new AbortController();
    const timers = [
      setTimeout(() => { if (!bot.text) { bot.hint = "正在翻资料，稍等…"; update(bot); } }, 7000),
      setTimeout(() => { if (!bot.text) { bot.hint = "比平时慢一些，还在等回复…"; update(bot); } }, 22000),
      setTimeout(() => { ctrl.abort("timeout"); }, WATCHDOG_MS),
    ];
    busy = { ctrl, turn: bot, timers };
    setBusy(true);

    let finished = false;
    try {
      await stream(PUB + "chat", { session_id: sid, question: text, history: hist }, {
        signal: ctrl.signal,
        onEvent(ev, d) {
          if (ev === "delta") {
            bot.text += d.text;
            update(bot);
          } else if (ev === "done") {
            Object.assign(bot, { text: d.text, mid: d.message_id, handoff: d.handoff_suggested, status: "ok" });
            finished = true;
          } else if (ev === "error") {
            Object.assign(bot, { status: "error", errTitle: d.kind === "timeout" ? "回答超时了" : "暂时没法回答", err: d.message });
            finished = true;
          }
        },
      });
      if (!finished) Object.assign(bot, { status: "error", errTitle: "回答中断了", err: "连接意外断开，可以重试一次。" });
    } catch (e) {
      if (e.name === "AbortError" || ctrl.signal.aborted) {
        if (ctrl.signal.reason === "timeout") Object.assign(bot, { status: "error", errTitle: "回答超时了", err: "等了很久还没回复，可以重试；着急的话直接打销售电话。" });
        else bot.status = "stopped";
      } else if (e.status === 429) {
        Object.assign(bot, { status: "error", errTitle: "提问有点频繁", err: e.message });
      } else {
        Object.assign(bot, { status: "error", errTitle: "没能连上客服", err: e.message });
      }
    } finally {
      timers.forEach(clearTimeout);
      delete bot.hint;
      busy = null;
      setBusy(false);
      update(bot);
      save();
    }
  }

  function setBusy(on) {
    sendBtn.classList.toggle("stop", on);
    sendBtn.innerHTML = on ? ICON.stop : ICON.send;
    sendBtn.setAttribute("aria-label", on ? "停止回答" : "发送");
    sendBtn.title = on ? "停止回答" : "发送";
    sendBtn.disabled = on ? false : !input.value.trim() || input.value.trim().length > cfg.max_len;
    setStatus();
    refreshChips();
  }

  function setStatus() {
    const s = $("status");
    s.classList.toggle("off", !online);
    s.classList.toggle("busy", online && !!busy);
    $("statusText").textContent = !online ? "连接中断" : busy ? "正在回复…" : "在线";
  }

  function onAction(t, act, btn) {
    if (act === "copy") {
      copyText(t.text).then((ok) => {
        toast(ok ? "已复制" : "复制失败，请长按选择文字");
        if (ok) { btn.innerHTML = ICON.check; setTimeout(() => { btn.innerHTML = ICON.copy; }, 1400); }
      });
    } else if (act === "up" || act === "down") {
      const rating = t.rating === act ? "none" : act;
      const prev = t.rating;
      t.rating = rating === "none" ? undefined : rating;
      update(t);
      save();
      api(PUB + "feedback", { method: "POST", body: { message_id: t.mid, rating } }).catch(() => {
        t.rating = prev;
        update(t);
        save();
        toast("反馈没提交成功，请稍后再点一次");
      });
    } else if (act === "retry") {
      if (busy) return;
      const i = turns.indexOf(t);
      const userTurn = turns[i - 1];
      turns.splice(i, 1);
      thread.querySelector(`[data-id="${t.id}"]`)?.remove();
      if (userTurn && userTurn.role === "user") send(userTurn.text, { reuse: userTurn });
    } else if (act === "handoff") {
      openSheet(t.q);
    }
  }

  // ---------- composer ----------

  function autosize() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 140) + "px";
    const n = input.value.trim().length;
    const c = $("count");
    c.hidden = n < cfg.max_len - 100;
    c.textContent = `${n}/${cfg.max_len}`;
    c.classList.toggle("over", n > cfg.max_len);
    if (!busy) sendBtn.disabled = !n || n > cfg.max_len;
  }
  input.addEventListener("input", autosize);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      if (!busy) form.requestSubmit();
    }
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (busy) { busy.ctrl.abort("user"); return; }
    const text = input.value.trim();
    if (!text) return;
    if (text.length > cfg.max_len) { toast(`问题太长了，请控制在 ${cfg.max_len} 字以内`); return; }
    if (!online) { toast(offlineText()); checkHealth(); return; }
    input.value = "";
    autosize();
    send(text);
  });

  $("newChat").addEventListener("click", () => {
    if (!turns.length) { input.focus(); return; }
    if (busy) busy.ctrl.abort("user");
    const backup = { sid, turns };
    turns = [];
    sid = newSid();
    save();
    renderAll();
    toast("已开始新对话", {
      action: "撤销",
      onAction() {
        sid = backup.sid;
        localStorage.setItem(KEY_SID, sid);
        turns = backup.turns;
        save();
        renderAll();
      },
    });
  });

  // ---------- handoff sheet ----------

  const sheet = $("sheet"), hForm = $("handoffForm");
  let sheetQuestion = "", lastFocus = null;

  function openSheet(question) {
    sheetQuestion = question || [...turns].reverse().find((t) => t.role === "user")?.text || "";
    lastFocus = document.activeElement;
    $("sheetForm").hidden = false;
    $("sheetDone").hidden = true;
    $("handoffErr").textContent = "";
    $("phoneErr").textContent = "";
    hForm.phone.removeAttribute("aria-invalid");
    if (!hForm.note.value && sheetQuestion) hForm.note.value = sheetQuestion;
    sheet.hidden = false;
    document.body.style.overflow = "hidden";
    setTimeout(() => (hForm.name.value ? hForm.phone : hForm.name).focus(), 60);
  }
  function closeSheet() {
    sheet.hidden = true;
    document.body.style.overflow = "";
    lastFocus?.focus?.();
  }
  sheet.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) closeSheet(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !sheet.hidden) closeSheet(); });
  hForm.phone.addEventListener("input", () => { $("phoneErr").textContent = ""; hForm.phone.removeAttribute("aria-invalid"); });

  hForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const phone = hForm.phone.value.replace(/[\s()（）]/g, "");
    if (!PHONE_RE.test(phone)) {
      $("phoneErr").textContent = "请填 11 位手机号，或带区号的座机（如 0769-12345678）";
      hForm.phone.setAttribute("aria-invalid", "true");
      hForm.phone.focus();
      return;
    }
    const btn = $("handoffSubmit");
    btn.disabled = true;
    btn.textContent = "提交中…";
    $("handoffErr").textContent = "";
    try {
      await api(PUB + "handoff", {
        method: "POST",
        body: { session_id: sid, name: hForm.name.value.trim(), phone, note: hForm.note.value.trim(), question: sheetQuestion },
      });
      const masked = phone.length === 11 ? phone.slice(0, 3) + "****" + phone.slice(7) : phone;
      $("doneTel").textContent = masked;
      $("sheetForm").hidden = true;
      $("sheetDone").hidden = false;
      sheet.querySelector("#sheetDone .primary").focus();
      hForm.note.value = "";
      append({ id: uid(), role: "note", text: masked });
      save();
    } catch (err) {
      $("handoffErr").textContent = err.message + "　也可以直接打电话。";
    } finally {
      btn.disabled = false;
      btn.textContent = "提交";
    }
  });

  // ---------- connectivity ----------

  const NET_DOWN = "网络断开了，恢复后可以继续提问。";
  const SVC_DOWN = "客服系统正在维护，稍后再试；着急的话直接打电话。";
  function offlineText() { return $("offline").textContent || NET_DOWN; }

  async function checkHealth() {
    if (!navigator.onLine) { online = false; setStatus(); $("offline").textContent = NET_DOWN; $("offline").hidden = false; return; }
    try {
      const h = await api(PUB + "health");
      online = !!h.ok;
      $("offline").textContent = h.ok ? "" : SVC_DOWN;
    } catch (e) {
      online = false;
      $("offline").textContent = NET_DOWN;
    }
    $("offline").hidden = online;
    setStatus();
  }
  window.addEventListener("online", checkHealth);
  window.addEventListener("offline", checkHealth);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) checkHealth(); });
  setInterval(() => { if (!document.hidden && !busy) checkHealth(); }, 45000);

  // ---------- toast ----------

  let toastTimer = null;
  function toast(msg, opts = {}) {
    const el = $("toast");
    el.innerHTML = esc(msg) + (opts.action ? ` <button type="button" class="toast-act">${esc(opts.action)}</button>` : "");
    el.style.pointerEvents = opts.action ? "auto" : "none";
    el.classList.add("show");
    if (opts.action) {
      el.querySelector(".toast-act").addEventListener("click", () => { el.classList.remove("show"); opts.onAction(); });
    }
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), opts.action ? 5000 : 1800);
  }

  // ---------- boot ----------

  $("newChat").innerHTML = ICON.plus;
  $("handoffBtn").innerHTML = ICON.person + "<span>转人工</span>";
  $("handoffBtn").addEventListener("click", () => openSheet());
  sheet.querySelector(".sheet-x").innerHTML = ICON.close;
  sheet.querySelector(".done-mark").innerHTML = ICON.check;
  sendBtn.innerHTML = ICON.send;

  $("closeEmbed").innerHTML = ICON.close;
  $("closeEmbed").addEventListener("click", () => parent.postMessage({ type: "mx-close" }, "*"));

  function applyConfig() {
    const root = document.documentElement.style;
    if (/^#[0-9a-f]{6}$/i.test(cfg.accent || "")) root.setProperty("--accent", cfg.accent);
    if (/^#[0-9a-f]{6}$/i.test(cfg.dark || "")) root.setProperty("--walnut", cfg.dark);
    document.body.classList.toggle("embed", EMBED);
    document.querySelectorAll(".mark").forEach((m) => { m.textContent = (cfg.short || cfg.name).slice(0, 1); });
    document.querySelectorAll(".bs-name").forEach((m) => { m.textContent = cfg.name; });
    $("bsEyebrow").textContent = cfg.eyebrow || "";
    $("bsHeadline").innerHTML = (cfg.headline || [cfg.name]).filter(Boolean).map((l) => `<span>${esc(l)}</span>`).join("");
    $("bsLead").textContent = cfg.lead || "";
    $("bsFacts").innerHTML = (cfg.facts || []).slice(0, 4).map(([num, unit, label]) =>
      `<div><dt>${esc(num)}<small>${esc(unit || "")}</small></dt><dd>${esc(label || "")}</dd></div>`).join("");
    $("bsFacts").hidden = !(cfg.facts || []).length;
    $("bsPhones").innerHTML = phoneLinks();
    $("bsNote").textContent = cfg.foot_note || "";
    $("disclaimer").textContent = cfg.disclaimer || "";
    $("sheetPhones").innerHTML = phoneLinks();
    $("sheetPhonesLine").hidden = !mainPhone();
    if (cfg.status !== "active") {
      $("paused").hidden = false;
      $("pausedText").innerHTML = mainPhone() ? `请直接电话联系：${phoneLinks()}` : "请稍后再来。";
    }
    renderAll();
  }

  applyConfig();
  checkHealth();
  autosize();
  if (matchMedia("(pointer: fine)").matches) input.focus();
})();
