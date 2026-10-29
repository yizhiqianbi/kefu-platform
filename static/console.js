(function () {
  const { api, upload, stream, md, esc, uid, copyText, BASE } = window.MX;
  const $ = (id) => document.getElementById(id);
  const page = $("page"), actions = $("pageActions");
  const VERDICTS = ["答对", "保守", "答错"];
  const TYPES = ["常规", "换说法", "库外", "诱导"];
  const EXPECTS = ["回答", "转人工", "拒答"];
  const ROLE = { admin: "管理员", operator: "运营" };
  const KEY_TENANT = "mx.console.tenant";
  const ORIGIN = location.origin;

  const S = {
    me: null, tenants: [], tenant: null, gen: 0, current: null, poll: null,
    ...freshTenantState(),
  };

  function freshTenantState() {
    return {
      ov: null, runs: [], runCache: {}, rows: [], drawerIndex: -1, gaps: [], tests: [],
      cmp: { left: null, right: null, filter: "all", type: "", search: "" },
      chat: { assistant: null, log: [], busy: null, prefill: "" },
      retrieve: { assistant: null, question: "", result: null },
      gapTab: "待处理", testType: "", testSearch: "", setTab: "brand",
      out: { tab: "待审核", kind: "", status: "", search: "", picked: new Set(), contacts: [], msgs: [], cfg: null },
    };
  }

  // ---------- helpers ----------

  async function call(path, opts) {
    try {
      return await api(path, opts);
    } catch (e) {
      if (e.status === 401) showLogin();
      throw e;
    }
  }
  const tc = (path, opts = {}) => call("api/console/" + path, { ...opts, headers: { ...(opts.headers || {}), "X-Tenant": S.tenant } });
  const ac = (path, opts) => call("api/admin/" + path, opts);
  const fileUrl = (path) => `${BASE}api/console/${path}?tenant=${encodeURIComponent(S.tenant)}`;
  const isAdmin = () => S.ov?.role === "admin" || S.me?.is_platform_admin;
  const tenantInfo = () => S.tenants.find((t) => t.slug === S.tenant);
  const siteUrl = (slug) => `${BASE}c/${encodeURIComponent(slug)}/`;
  const stale = (g) => g !== S.gen;

  let toastTimer;
  function toast(msg, bad) {
    const el = $("toast");
    el.textContent = msg;
    el.classList.toggle("bad", !!bad);
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), bad ? 3600 : 2000);
  }

  // A modal. `submit(bodyEl)` may throw to keep the dialog open with an error; its return value resolves the promise.
  function dialog({ title, body, ok = "确定", cancel = "取消", wide = false, danger = false, onOpen, submit }) {
    return new Promise((resolve) => {
      const m = $("modal"), okBtn = $("modalOk"), cancelBtn = $("modalCancel"), el = $("modalBody");
      m.querySelector(".modal").classList.toggle("wide", wide);
      $("modalTitle").textContent = title;
      el.innerHTML = body;
      $("modalErr").textContent = "";
      okBtn.textContent = ok;
      okBtn.className = "btn " + (danger ? "danger-fill" : "primary");
      okBtn.hidden = !ok;
      cancelBtn.textContent = cancel || "";
      cancelBtn.hidden = !cancel;
      m.hidden = false;
      if (onOpen) onOpen(el);
      const first = el.querySelector("input:not([type=checkbox]):not([readonly]), textarea:not([readonly]), select");
      setTimeout(() => (first || okBtn).focus(), 20);
      let busy = false;
      const close = (v) => { m.hidden = true; document.removeEventListener("keydown", onKey, true); resolve(v); };
      const go = async () => {
        if (busy) return;
        if (!submit) return close(true);
        busy = true;
        const txt = okBtn.textContent;
        okBtn.disabled = cancelBtn.disabled = true;
        okBtn.innerHTML = `<span class="spin"></span>${esc(txt)}`;
        $("modalErr").textContent = "";
        try {
          const v = await submit(el);
          close(v === undefined ? true : v);
        } catch (e) {
          $("modalErr").textContent = e.message;
        } finally {
          busy = false;
          okBtn.disabled = cancelBtn.disabled = false;
          okBtn.textContent = txt;
        }
      };
      const onKey = (e) => {
        if (e.key === "Escape" && !busy) { e.stopPropagation(); close(false); }
        if (e.key === "Enter" && !e.isComposing && e.target.tagName === "INPUT" && e.target.type !== "checkbox") { e.preventDefault(); go(); }
      };
      document.addEventListener("keydown", onKey, true);
      okBtn.onclick = go;
      cancelBtn.onclick = () => { if (!busy) close(false); };
      m.querySelector(".modal-backdrop").onclick = () => { if (!busy) close(false); };
    });
  }
  const confirmBox = (title, body, ok = "确定", danger = false) => dialog({ title, body, ok, danger });

  function field(el, name) {
    const f = el.querySelector(`[name="${name}"]`);
    if (!f) return "";
    return f.type === "checkbox" ? f.checked : f.value.trim();
  }

  // Shown once: temporary passwords and the like.
  function showSecret(title, rows, note) {
    return dialog({
      title, ok: "我已记下", cancel: null,
      body: `<div class="secret">${rows.map(([k, v]) => `<div class="secret-row"><span>${esc(k)}</span><code>${esc(v)}</code>
        <button type="button" class="btn sm" data-copy="${esc(v)}">复制</button></div>`).join("")}</div>
        ${note ? `<p class="faint" style="font-size:12.5px;margin:10px 0 0">${note}</p>` : ""}`,
      onOpen(el) {
        el.querySelectorAll("[data-copy]").forEach((b) => b.addEventListener("click", async () => {
          b.textContent = (await copyText(b.dataset.copy)) ? "已复制" : "复制失败";
          setTimeout(() => { b.textContent = "复制"; }, 1500);
        }));
      },
    });
  }

  function vpill(v, manual) {
    const k = VERDICTS.includes(v) || v === "待复核" ? v : "无";
    return `<span class="v v-${k}">${esc(v || "—")}</span>${manual ? '<span class="hand" title="人工判定">人工</span>' : ""}`;
  }

  function loading(n = 3) {
    return `<div class="card">${Array.from({ length: n }, (_, i) => `<div class="skeleton" style="width:${90 - i * 18}%"></div>`).join("")}</div>`;
  }

  function errorBox(msg, retry) {
    const id = "r" + uid().slice(0, 6);
    setTimeout(() => { const b = $(id); if (b) b.onclick = retry; });
    return `<div class="err-box"><span>${esc(msg)}</span><button class="btn sm" id="${id}">重试</button></div>`;
  }

  function debounce(fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }

  const fmtNum = (n) => Number(n || 0).toLocaleString("zh-CN");
  const fmtSize = (b) => (b > 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB");
  function assistantKeys() { return Object.keys(S.ov?.assistants || {}); }
  function aName(key) {
    const a = S.ov?.assistants?.[key];
    if (!a) return key;
    return key.length <= 2 ? `助手 ${key} · ${a.label}` : a.label;
  }
  function aShort(key) { return key.length <= 2 ? `助手 ${key}` : (S.ov?.assistants?.[key]?.label || key).replace(/（.*）/, ""); }

  function segAssistants(current, attr) {
    const keys = assistantKeys();
    if (keys.length < 2) return "";
    return `<div class="seg" role="group">${keys.map((k) =>
      `<button type="button" data-${attr}="${k}" class="${k === current ? "on" : ""}">${esc(aName(k))}</button>`).join("")}</div>`;
  }

  function launchCheck(s) {
    if (!s) return null;
    const why = [];
    if (s["答对"] < s.need) why.push(`答对 ${s["答对"]} 题，标准是至少 ${s.need} 题`);
    if (s.lib_ok < s.lib_total) why.push(`库外题有 ${s.lib_total - s.lib_ok} 道答错`);
    if (s.ind_ok < s.ind_total) why.push(`诱导题有 ${s.ind_total - s.ind_ok} 道答错`);
    const n = s["答对"] + s["保守"] + s["答错"] + s["待复核"];
    if (n < s.total) why.push(`只跑完 ${n}/${s.total} 题`);
    if (s["待复核"]) why.push(`${s["待复核"]} 题评分失败，待人工复核`);
    return why;
  }

  function stackBar(s) {
    const t = s.total || 1;
    const w = (n) => `${(n / t) * 100}%`;
    return `<div class="stack" title="答对 ${s["答对"]} · 保守 ${s["保守"]} · 答错 ${s["答错"]}">
      <i class="ok" style="width:${w(s["答对"])}"></i><i class="warn" style="width:${w(s["保守"])}"></i>
      <i class="bad" style="width:${w(s["答错"])}"></i><i class="grey" style="width:${w(s["待复核"])}"></i></div>`;
  }

  // ---------- auth ----------

  function showLogin() {
    stopPoll();
    S.gen++;
    $("shell").hidden = true;
    $("modal").hidden = true;
    $("login").hidden = false;
    $("loginPw").value = "";
    setTimeout(() => ($("loginEmail").value ? $("loginPw") : $("loginEmail")).focus(), 30);
  }

  $("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("loginBtn");
    btn.disabled = true;
    $("loginErr").textContent = "";
    try {
      const me = await api("api/auth/login", { method: "POST", body: { email: $("loginEmail").value, password: $("loginPw").value } });
      enter(me);
    } catch (err) {
      $("loginErr").textContent = err.message;
      $("loginPw").select();
    } finally {
      btn.disabled = false;
    }
  });

  $("logout").addEventListener("click", async () => {
    try { await api("api/auth/logout", { method: "POST" }); } catch (e) { /* already logged out */ }
    showLogin();
  });

  async function changePassword() {
    const ok = await dialog({
      title: "修改密码",
      body: `<div class="form">
        <label>原密码<input type="password" name="old" autocomplete="current-password"></label>
        <label>新密码<input type="password" name="new" autocomplete="new-password" placeholder="至少 8 位"></label>
        <label>再输一遍<input type="password" name="new2" autocomplete="new-password"></label></div>`,
      ok: "保存",
      async submit(el) {
        if (field(el, "new").length < 8) throw new Error("新密码至少 8 位");
        if (field(el, "new") !== field(el, "new2")) throw new Error("两次输入的新密码不一样");
        await call("api/auth/password", { method: "POST", body: { old: field(el, "old"), new: field(el, "new") } });
      },
    });
    if (ok) {
      S.me.must_change_password = false;
      $("pwNotice").hidden = true;
      toast("密码已修改，其他设备上的登录已退出");
    }
  }
  $("changePw").addEventListener("click", changePassword);
  $("pwNoticeBtn").addEventListener("click", changePassword);

  // ---------- shell, tenant switching and routing ----------

  const PAGES = {
    overview: { title: "总览", group: "t", render: renderOverview },
    kb: { title: "知识库", group: "t", render: renderKb },
    tests: { title: "测试题", group: "t", render: renderTests },
    runs: { title: "回归测试", group: "t", render: renderRuns, badge: "runs" },
    retrieve: { title: "检索调试", group: "t", render: renderRetrieve },
    chat: { title: "试聊", group: "t", render: renderChat },
    gaps: { title: "待补队列", group: "t", render: renderGaps, badge: "gaps" },
    handoffs: { title: "转人工", group: "t", render: renderHandoffs, badge: "handoffs" },
    outreach: { title: "主动跟进", group: "t", render: renderOutreach, badge: "outreach" },
    settings: { title: "设置", group: "t", render: renderSettings },
    tenants: { title: "客户", group: "p", render: renderTenants },
    users: { title: "账号", group: "p", render: renderUsers },
  };

  function enter(me) {
    S.me = me.user;
    S.tenants = me.tenants;
    const saved = localStorage.getItem(KEY_TENANT);
    const pick = S.tenants.find((t) => t.slug === saved) || S.tenants[0];
    if ((pick?.slug || null) !== S.tenant) Object.assign(S, freshTenantState());
    S.tenant = pick?.slug || null;
    $("login").hidden = true;
    $("shell").hidden = false;
    $("pwNotice").hidden = !S.me.must_change_password;
    drawSide();
    route();
  }

  async function reloadMe() {
    try {
      const me = await call("api/auth/me");
      S.me = me.user;
      S.tenants = me.tenants;
      if (!tenantInfo()) {
        Object.assign(S, freshTenantState());
        S.tenant = S.tenants[0]?.slug || null;
      }
      drawSide();
    } catch (e) { /* keep old */ }
  }

  function drawSide() {
    const t = tenantInfo();
    $("sideMark").textContent = t ? t.name.slice(0, 1) : "客";
    $("sideName").textContent = t ? t.name : "智能客服平台";
    $("sideSub").textContent = t ? `${ROLE[t.role] || ""} · 运营台` : "平台后台";
    const pick = $("tenantPick");
    if (S.tenants.length > 1) {
      pick.innerHTML = `<label class="sr-only" for="tenantSel">切换客户</label><select id="tenantSel">${S.tenants.map((x) =>
        `<option value="${esc(x.slug)}" ${x.slug === S.tenant ? "selected" : ""}>${esc(x.name)}${x.status !== "active" ? "（已停用）" : ""}</option>`).join("")}</select>`;
      $("tenantSel").addEventListener("change", (e) => switchTenant(e.target.value));
    } else {
      pick.innerHTML = "";
    }
    const item = (k) => `<a href="#${k}" data-page="${k}">${PAGES[k].title}${PAGES[k].badge ? `<span class="badge" data-badge="${PAGES[k].badge}" hidden></span>` : ""}</a>`;
    const tKeys = Object.keys(PAGES).filter((k) => PAGES[k].group === "t");
    $("nav").innerHTML = (S.tenant ? `<div class="nav-group">运营</div>${tKeys.map(item).join("")}` : "") +
      (S.me.is_platform_admin ? `<div class="nav-group">平台</div>${item("tenants")}${item("users")}` : "");
    $("openSite").hidden = !S.tenant;
    if (S.tenant) $("openSite").href = siteUrl(S.tenant);
    $("who").innerHTML = `<b>${esc(S.me.name || S.me.email)}</b><span>${esc(S.me.email)}${S.me.is_platform_admin ? " · 平台管理员" : ""}</span>`;
    markNav();
    updateBadges();
  }

  function switchTenant(slug) {
    if (slug === S.tenant) return;
    stopPoll();
    if (S.chat.busy) S.chat.busy.abort();
    Object.assign(S, freshTenantState());
    S.tenant = slug;
    localStorage.setItem(KEY_TENANT, slug);
    drawSide();
    const p = PAGES[S.current];
    if (!p || p.group !== "t") goto("#overview");
    else route();
    toast(`已切换到「${tenantInfo()?.name}」`);
  }

  function goto(hash) {
    if (location.hash === hash) route();
    else location.hash = hash;
  }

  function markNav() {
    document.querySelectorAll("#nav a").forEach((a) => a.classList.toggle("on", a.dataset.page === S.current));
  }

  async function route() {
    let name = (location.hash || "#overview").slice(1);
    if (!PAGES[name]) name = "overview";
    if (PAGES[name].group === "p" && !S.me.is_platform_admin) name = "overview";
    if (PAGES[name].group === "t" && !S.tenant) name = S.me.is_platform_admin ? "tenants" : "";
    S.gen++;
    const g = S.gen;
    closeDrawer();
    actions.innerHTML = "";
    if (!name) {
      S.current = null;
      $("pageTitle").textContent = "欢迎";
      page.innerHTML = '<div class="card empty"><b>你还没有加入任何客户</b>请联系平台管理员把你加进去</div>';
      return;
    }
    S.current = name;
    markNav();
    const p = PAGES[name];
    $("pageTitle").textContent = p.title;
    document.title = `${p.title} · ${p.group === "t" ? tenantInfo()?.name : "平台后台"} · 运营台`;
    if (p.group === "t" && !S.ov) {
      page.innerHTML = loading();
      try {
        S.ov = await tc("overview");
      } catch (e) {
        if (!stale(g) && e.status !== 401) page.innerHTML = errorBox("连不上后端：" + e.message, route);
        return;
      }
      if (stale(g)) return;
      updateBadges();
      if (S.ov.running.length) startPoll();
    }
    p.render(g);
  }
  window.addEventListener("hashchange", route);

  async function boot() {
    try {
      enter(await api("api/auth/me"));
    } catch (e) {
      if (e.status === 401) showLogin();
      else { $("login").hidden = true; $("shell").hidden = false; page.innerHTML = errorBox("连不上后端：" + e.message, boot); }
    }
  }

  function updateBadges() {
    const c = S.ov?.counts || {};
    const n = { gaps: c.gaps_open, handoffs: c.handoffs_new, runs: S.ov?.running?.length, outreach: (c.outreach_review || 0) + (c.outreach_due || 0) };
    document.querySelectorAll("[data-badge]").forEach((b) => {
      const v = n[b.dataset.badge];
      b.hidden = !v;
      b.textContent = v || "";
      b.classList.toggle("run", b.dataset.badge === "runs");
    });
  }

  async function refreshOverview() {
    if (!S.tenant) return;
    const slug = S.tenant;
    try {
      const ov = await tc("overview");
      if (slug === S.tenant) { S.ov = ov; updateBadges(); }
    } catch (e) { /* keep old */ }
  }

  // ---------- polling while a run is in progress ----------

  function startPoll() {
    if (S.poll) return;
    S.poll = setInterval(async () => {
      const before = (S.ov?.running || []).map((r) => r.id);
      await refreshOverview();
      const after = (S.ov?.running || []).map((r) => r.id);
      const finished = before.filter((id) => !after.includes(id));
      finished.forEach((id) => { delete S.runCache[id]; });
      if (finished.length) toast("一轮回归测试跑完了");
      if (S.current === "runs") {
        if (finished.length) { await loadRuns(); autoPickAfterFinish(finished); renderCompare(); }
        renderRunning();
      } else if (S.current === "overview" && $("modal").hidden) {
        drawOverview();
      }
      if (!after.length) stopPoll();
    }, 2000);
  }
  function stopPoll() { clearInterval(S.poll); S.poll = null; }

  async function startRun(key) {
    const n = S.ov.counts.tests;
    if (!n) {
      if (await confirmBox("还没有测试题", "<p>回归测试会把测试题逐一问机器人再自动评分。先去「测试题」页让 AI 生成一批，或导入 Excel。</p>", "去添加")) location.hash = "#tests";
      return;
    }
    const ok = await confirmBox(`跑一轮${aShort(key)}的回归测试？`,
      `<p>${n} 道测试题逐一提问，再由 ${esc(S.ov.judge_model)} 自动评分，大约 ${Math.max(1, Math.round(n / 20))}–${Math.max(2, Math.round(n / 12))} 分钟。</p><p class="faint">咨询页照常可用。跑完建议抽查答错和保守的题。</p>`,
      "开始测试");
    if (!ok) return;
    try {
      await tc("runs", { method: "POST", body: { assistant: key } });
      toast("已开始，可以在回归测试页看进度");
      await refreshOverview();
      startPoll();
      if (S.current !== "runs") location.hash = "#runs"; else { await loadRuns(); renderRunning(); }
    } catch (e) {
      toast(e.message, true);
    }
  }

  // ---------- overview ----------

  async function renderOverview(g) {
    drawOverview();
    await refreshOverview();
    if (!stale(g)) drawOverview();
  }

  function drawOverview() {
    const o = S.ov;
    if (!o || S.current !== "overview") return;
    const h = o.health, c = o.counts, u = o.usage_month, t = o.tenant;
    const keys = assistantKeys();
    const totalChunks = Math.max(0, ...keys.map((k) => o.assistants[k].chunks || 0));
    const lastLive = o.assistants[o.live]?.last_run;
    const steps = [
      [totalChunks > 0, "上传资料和问答对", "知识库", "#kb"],
      [c.tests > 0, "生成或导入测试题", "测试题", "#tests"],
      [!!lastLive, "跑一轮回归测试，看能答对多少", "回归测试", "#runs"],
      [!!(lastLive && lastLive.summary.launch), "达到上线标准", "回归测试", "#runs"],
      [false, "设置品牌，把咨询窗口嵌到官网", "设置", "#settings"],
    ];
    const showSteps = !(lastLive && lastLive.summary.launch && c.chats_today + (u.web_questions || 0) > 0);
    const quota = t.quota_month;
    actions.innerHTML = `<a class="btn" href="${siteUrl(t.slug)}" target="_blank" rel="noopener">打开咨询页 ↗</a>`;
    page.innerHTML = `
      ${t.status !== "active" ? '<div class="notice bad"><span>这个客户已被平台停用，咨询页暂停服务。</span></div>' : ""}
      <div class="card live-bar">
        <div><h3>咨询页当前使用</h3><div style="margin-top:8px">${keys.length > 1 ? segAssistants(o.live, "live") : `<b>${esc(aName(o.live))}</b>`}</div></div>
        <div class="health">
          <span class="tag ${h.ragflow ? "ok" : "bad"}">知识库引擎 ${h.ragflow ? "正常" : "连不上"}</span>
          <span class="tag ${h.llm_key ? "ok" : "bad"}">模型密钥${h.llm_key ? "已配置" : "缺失"}</span>
          <span class="tag plain">评分模型 ${esc(o.judge_model)}</span>
        </div>
      </div>
      ${showSteps ? `<div class="card section steps"><h3>开通后这样上线</h3><ol>${steps.map(([done, text, label, href], i) =>
        `<li class="${done ? "done" : ""}"><span class="step-n">${done ? "✓" : i + 1}</span><span>${text}</span><a href="${href}">去${label} →</a></li>`).join("")}</ol></div>` : ""}
      <div class="grid two section" style="margin-top:14px">${keys.map((k) => assistantCard(k, o.assistants[k], k === o.live)).join("")}</div>
      <div class="grid four section">
        <a class="card stat-card stat" href="#gaps"><span>待补问题</span><b>${c.gaps_open}</b><span>等人补答案</span></a>
        <a class="card stat-card stat" href="#handoffs"><span>新的转人工</span><b>${c.handoffs_new}</b><span>还没联系</span></a>
        <div class="card stat"><span>今天客户提问</span><b>${c.chats_today}</b><span>有用 ${c.up_today} · 没用 ${c.down_today}</span></div>
        <a class="card stat-card stat" href="#settings" data-tab="usage"><span>本月咨询</span><b>${fmtNum(u.web_questions)}</b>
          <span>${quota ? `配额 ${fmtNum(quota)} 条 · 已用 ${Math.round((u.web_questions / quota) * 100)}%` : "不限量"}</span></a>
      </div>
      <div class="section"><h2>最近的客户提问</h2><div class="card">${recentList(o.recent)}</div></div>`;
    page.querySelectorAll("[data-live]").forEach((b) => b.addEventListener("click", () => switchLive(b.dataset.live)));
    page.querySelectorAll("[data-run]").forEach((b) => b.addEventListener("click", () => startRun(b.dataset.run)));
    page.querySelector('[data-tab="usage"]').addEventListener("click", () => { S.setTab = "usage"; });
  }

  function assistantCard(key, a, live) {
    const r = a.last_run, s = r?.summary;
    const running = S.ov.running.find((x) => x.assistant === key);
    const why = launchCheck(s);
    return `<div class="card">
      <div class="card-head"><h3>${esc(aName(key))} ${live ? '<span class="tag ok">上线中</span>' : ""}</h3>
        ${running ? `<span class="tag warn">测试中 ${running.done}/${running.total}</span>` : `<button class="btn sm" data-run="${key}">跑一轮回归</button>`}</div>
      <div class="kv">知识库 <b>${a.docs}</b> 份文件 · <b>${a.chunks}</b> 个片段 · 相似度阈值 <b>${a.threshold}</b></div>
      ${s ? `
        <div class="score"><b>${s["答对"]}</b><span>/ ${s.total} 答对</span></div>
        ${stackBar(s)}
        <div class="kv"><span>保守 <b>${s["保守"]}</b></span><span>答错 <b>${s["答错"]}</b></span>${s["待复核"] ? `<span>待复核 <b>${s["待复核"]}</b></span>` : ""}
          <span>库外 <b>${s.lib_ok}/${s.lib_total}</b></span><span>诱导 <b>${s.ind_ok}/${s.ind_total}</b></span></div>
        <div class="launch ${why.length ? "no" : "yes"}">${why.length ? "还不能上线：" + why.map(esc).join("；") : `达到上线标准：答对 ≥ ${s.need}，库外和诱导题全部没答错`}</div>
        <p class="faint" style="margin:8px 0 0;font-size:12.5px">${esc(r.label)} · ${esc(r.finished_text)} · ${esc(r.grader)}　<a href="#runs">看明细</a></p>`
        : '<div class="empty"><b>还没有测试结果</b>点「跑一轮回归」看看它能答对几题</div>'}
    </div>`;
  }

  function recentList(rows) {
    if (!rows.length) return '<div class="empty"><b>还没有客户提问</b>打开咨询页问一句试试</div>';
    return `<div class="list">${rows.map((m) => `
      <div class="list-item"><div style="flex:1;min-width:0">
        <div><b>${esc(m.question)}</b></div>
        <div class="muted clamp" style="font-size:13px">${esc(m.answer || (m.status === "ok" ? "" : "（没有回答）"))}</div></div>
        <div style="text-align:right;flex:none;font-size:12px" class="faint">${esc(m.created_text.slice(5))}<br>
          ${m.status !== "ok" ? `<span class="tag bad">${{ timeout: "超时", stopped: "客户停止", error: "出错" }[m.status] || esc(m.status)}</span>` : ""}
          ${m.handoff ? '<span class="tag warn">转人工</span>' : ""}${m.rating === "down" ? '<span class="tag bad">没用</span>' : m.rating === "up" ? '<span class="tag ok">有用</span>' : ""}</div>
      </div>`).join("")}</div>`;
  }

  async function switchLive(key) {
    if (key === S.ov.live) return;
    if (!isAdmin()) { toast("只有管理员可以切换上线助手", true); return; }
    const ok = await confirmBox(`把咨询页切到${aShort(key)}？`,
      `<p>切换后新的提问由「${esc(aName(key))}」回答，正在进行的回答不受影响。</p>`, "切换");
    if (!ok) return;
    try {
      await tc("live", { method: "PUT", body: { assistant: key } });
      toast(`咨询页已切到${aShort(key)}`);
      await refreshOverview();
      drawOverview();
    } catch (e) {
      toast(e.message, true);
    }
  }

  // ---------- knowledge base ----------

  const KB_HELP = {
    qa: "一问一答，最准。Excel 两列：A 列问题（换行写同义问法，用 / 隔开），B 列答案，不要表头。",
    docs: "产品手册、价格表、政策文件等原始资料。机器人从里面检索片段来回答。",
  };
  const RUN_TEXT = { UNSTART: "未解析", RUNNING: "解析中", CANCEL: "已取消", DONE: "已就绪", FAIL: "解析失败" };
  let kbTimer = null;

  async function renderKb(g) {
    clearTimeout(kbTimer);
    page.innerHTML = loading(5);
    let data;
    try {
      data = await tc("kb");
    } catch (e) {
      if (!stale(g)) page.innerHTML = errorBox("知识库读取失败：" + e.message, () => renderKb(g));
      return;
    }
    if (stale(g)) return;
    drawKb(data, g);
  }

  function drawKb(data, g) {
    const exts = data.exts.join(" ");
    page.innerHTML = data.datasets.map((d) => {
      const chunks = d.docs.reduce((n, x) => n + x.chunks, 0);
      return `<div class="card kb section" data-kind="${d.kind}">
        <div class="card-head"><div><h3>${esc(d.label)} <span class="faint num" style="font-weight:400;font-size:13px">${d.docs.length} 份文件 · ${chunks} 个片段</span></h3>
          <p class="faint kb-help">${esc(KB_HELP[d.kind] || "")}</p></div>
          <div class="page-actions">${d.kind === "qa" ? `<a class="btn sm" href="${fileUrl("kb/qa-template.xlsx")}" download>下载模板</a>` : ""}
            <button class="btn sm primary" data-up="${d.kind}">上传文件</button></div></div>
        <div class="drop" data-drop="${d.kind}"><span>把文件拖到这里上传</span><span class="faint">支持 ${esc(exts)} · 单个不超过 ${data.max_mb} MB · 上传后自动解析</span></div>
        <div class="uploads" data-uploads="${d.kind}"></div>
        ${d.docs.length ? `<table class="t static kb-t"><thead><tr><th>文件</th><th style="width:80px">片段</th><th style="width:200px">状态</th><th style="width:110px">上传时间</th><th style="width:140px"></th></tr></thead>
          <tbody>${d.docs.map((x) => docRow(d.kind, x)).join("")}</tbody></table>`
          : '<div class="empty"><b>还没有文件</b>上传后几十秒就能被机器人检索到</div>'}
      </div>`;
    }).join("") || '<div class="card empty"><b>这个客户还没有知识库</b>请联系平台管理员</div>';

    page.querySelectorAll("[data-up]").forEach((b) => b.addEventListener("click", () => pickFiles(data, b.dataset.up, g)));
    page.querySelectorAll("[data-drop]").forEach((z) => {
      z.addEventListener("dragover", (e) => { e.preventDefault(); z.classList.add("over"); });
      z.addEventListener("dragleave", () => z.classList.remove("over"));
      z.addEventListener("drop", (e) => { e.preventDefault(); z.classList.remove("over"); uploadFiles(data, z.dataset.drop, [...e.dataTransfer.files], g); });
    });
    page.querySelectorAll("[data-parse]").forEach((b) => b.addEventListener("click", async () => {
      b.disabled = true;
      try { await tc(`kb/${b.dataset.kind}/docs/${b.dataset.parse}/parse`, { method: "POST" }); toast("已开始解析"); renderKb(g); } catch (e) { toast(e.message, true); b.disabled = false; }
    }));
    page.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => {
      if (!(await confirmBox("删除这份文件？", `<p>「${esc(b.dataset.name)}」和它的全部片段会从知识库删除，机器人马上就检索不到了。</p>`, "删除", true))) return;
      try { await tc(`kb/${b.dataset.kind}/docs/${b.dataset.del}`, { method: "DELETE" }); toast("已删除"); renderKb(g); } catch (e) { toast(e.message, true); }
    }));

    const busy = data.datasets.some((d) => d.docs.some((x) => x.run === "RUNNING" || (x.run === "UNSTART" && !x.writeback && Date.now() / 1000 - x.created < 90)));
    if (busy) kbTimer = setTimeout(async () => {
      if (stale(g) || S.current !== "kb") return;
      try { const d = await tc("kb"); if (!stale(g)) drawKb(d, g); } catch (e) { /* try again next time */ }
    }, 3000);
  }

  function docRow(kind, x) {
    let st;
    if (x.writeback) st = '<span class="tag ok">运营台写回</span>';
    else if (x.run === "RUNNING") st = `<div class="parse"><div class="progress"><i style="width:${Math.round(x.progress * 100)}%"></i></div><span class="num">${Math.round(x.progress * 100)}%</span></div>`;
    else if (x.run === "UNSTART" && x.chunks) st = '<span class="tag ok">已就绪</span>';
    else st = `<span class="tag ${x.run === "DONE" ? "ok" : x.run === "FAIL" ? "bad" : "plain"}" title="${esc(x.message)}">${RUN_TEXT[x.run] || esc(x.run)}</span>`;
    const canParse = !x.writeback && x.run !== "RUNNING" && !(x.run === "UNSTART" && x.chunks);
    return `<tr><td><div class="doc-name">${esc(x.name)}</div><div class="faint" style="font-size:12px">${fmtSize(x.size)}${x.run === "FAIL" && x.message ? " · " + esc(x.message) : ""}${x.writeback ? " · 待补队列写回的问答对，立即生效" : ""}</div></td>
      <td class="num">${x.chunks}</td><td>${st}</td><td class="faint num">${esc((x.created_text || "").slice(5))}</td>
      <td class="row-actions">${canParse ? `<button class="btn sm ghost" data-kind="${kind}" data-parse="${x.id}">${x.run === "DONE" ? "重新解析" : "解析"}</button>` : ""}
        ${!x.writeback && isAdmin() ? `<button class="btn sm ghost danger" data-kind="${kind}" data-del="${x.id}" data-name="${esc(x.name)}">删除</button>` : ""}</td></tr>`;
  }

  function pickFiles(data, kind, g) {
    const fp = $("filePick");
    fp.accept = data.exts.join(",");
    fp.multiple = true;
    fp.value = "";
    fp.onchange = () => uploadFiles(data, kind, [...fp.files], g);
    fp.click();
  }

  async function uploadFiles(data, kind, files, g) {
    if (!files.length) return;
    const bad = files.find((f) => !data.exts.includes("." + f.name.split(".").pop().toLowerCase()));
    if (bad) { toast(`不支持这种文件：${bad.name}`, true); return; }
    const big = files.find((f) => f.size > data.max_mb * 1048576);
    if (big) { toast(`${big.name} 超过 ${data.max_mb} MB`, true); return; }
    if (files.length > 20) { toast("一次最多上传 20 个文件", true); return; }
    const box = page.querySelector(`[data-uploads="${kind}"]`);
    const row = document.createElement("div");
    row.className = "upbar";
    row.innerHTML = `<span class="spin"></span><span>上传 ${files.length} 个文件：${esc(files.map((f) => f.name).join("、"))}</span><div class="progress"><i style="width:0"></i></div>`;
    box.appendChild(row);
    const form = new FormData();
    files.forEach((f) => form.append("files", f));
    try {
      await upload(`api/console/kb/${kind}/upload`, form, {
        headers: { "X-Tenant": S.tenant },
        onProgress: (p) => { row.querySelector("i").style.width = `${Math.round(p * 100)}%`; },
      });
      toast(`已上传 ${files.length} 个文件，正在解析`);
      if (!stale(g)) renderKb(g);
    } catch (e) {
      if (e.status === 401) { showLogin(); return; }
      row.classList.add("bad");
      row.innerHTML = `<span>上传失败：${esc(e.message)}</span>`;
      setTimeout(() => row.remove(), 6000);
    }
  }

  // ---------- tests ----------

  async function renderTests(g) {
    actions.innerHTML = `<button class="btn" id="tgen">AI 生成</button><button class="btn" id="timp">导入 Excel</button>
      <a class="btn" href="${fileUrl("tests/template.xlsx")}" download>下载模板</a><button class="btn primary" id="tadd">添加一题</button>`;
    $("tgen").addEventListener("click", () => generateTests(g));
    $("timp").addEventListener("click", () => importTests(g));
    $("tadd").addEventListener("click", () => editTest(null, g));
    page.innerHTML = loading(6);
    try {
      S.tests = await tc("tests");
    } catch (e) {
      if (!stale(g)) page.innerHTML = errorBox("测试题读取失败：" + e.message, () => renderTests(g));
      return;
    }
    if (!stale(g)) drawTests(g);
  }

  function drawTests(g) {
    const all = S.tests;
    if (!all.length) {
      page.innerHTML = `<div class="card empty"><b>还没有测试题</b>测试题是上线前的考卷：机器人要答对 90% 以上，库外和诱导题不能乱答。<br>
        可以让 AI 根据知识库生成一批，也可以按模板导入 Excel。
        <div style="margin-top:14px;display:flex;gap:8px;justify-content:center"><button class="btn primary" data-go="gen">AI 生成 20 道</button><button class="btn" data-go="imp">导入 Excel</button></div></div>`;
      page.querySelector('[data-go="gen"]').addEventListener("click", () => generateTests(g));
      page.querySelector('[data-go="imp"]').addEventListener("click", () => importTests(g));
      return;
    }
    const q = S.testSearch.trim().toLowerCase();
    const rows = all.filter((t) => (!S.testType || t.type === S.testType) && (!q || (t.code + t.q + t.points).toLowerCase().includes(q)));
    const need = Math.ceil(all.length * 0.9);
    page.innerHTML = `
      <p class="legend">回归测试会用这里的全部 ${all.length} 道题。上线标准：答对至少 ${need} 道，库外题和诱导题一道都不能答错。</p>
      <div class="filters">
        <button class="chip ${!S.testType ? "on" : ""}" data-ty="">全部<span class="c">${all.length}</span></button>
        ${TYPES.map((t) => `<button class="chip ${S.testType === t ? "on" : ""}" data-ty="${t}">${t}<span class="c">${all.filter((x) => x.type === t).length}</span></button>`).join("")}
        <input id="tsearch" placeholder="搜题号或内容" value="${esc(S.testSearch)}">
      </div>
      ${rows.length ? `<table class="t static"><thead><tr><th style="width:64px">题号</th><th style="width:76px">题型</th><th>客户原话</th>
        <th style="width:80px">期望</th><th>期望要点</th><th style="width:80px">来源</th><th style="width:120px"></th></tr></thead>
        <tbody>${rows.map((t) => `<tr><td class="id">${esc(t.code)}</td><td><span class="tag plain ty-${esc(t.type)}">${esc(t.type)}</span></td>
          <td class="q">${esc(t.q)}</td><td>${esc(t.expect)}</td><td class="muted" style="font-size:13px">${esc(t.points || "—")}</td>
          <td class="faint" style="font-size:12.5px">${esc(t.source || "")}</td>
          <td class="row-actions"><button class="btn sm ghost" data-edit="${esc(t.code)}">编辑</button><button class="btn sm ghost danger" data-rm="${esc(t.code)}">删除</button></td></tr>`).join("")}</tbody></table>`
        : '<div class="card empty"><b>没有符合条件的题</b></div>'}`;
    page.querySelectorAll("[data-ty]").forEach((b) => b.addEventListener("click", () => { S.testType = b.dataset.ty; drawTests(g); }));
    const sb = $("tsearch");
    sb.addEventListener("input", debounce(() => {
      S.testSearch = sb.value;
      drawTests(g);
      const n = $("tsearch"); n.focus(); n.setSelectionRange(n.value.length, n.value.length);
    }, 200));
    page.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => editTest(S.tests.find((t) => t.code === b.dataset.edit), g)));
    page.querySelectorAll("[data-rm]").forEach((b) => b.addEventListener("click", async () => {
      const t = S.tests.find((x) => x.code === b.dataset.rm);
      if (!(await confirmBox(`删除 ${t.code}？`, `<p>${esc(t.q)}</p><p class="faint">已经跑过的测试记录不受影响。</p>`, "删除", true))) return;
      try { await tc(`tests/${encodeURIComponent(t.code)}`, { method: "DELETE" }); toast("已删除"); refreshOverview(); renderTests(g); } catch (e) { toast(e.message, true); }
    }));
  }

  function testFormHtml(t = {}) {
    const opt = (list, v) => list.map((x) => `<option ${x === v ? "selected" : ""}>${x}</option>`).join("");
    return `<div class="form">
      <div class="form-row"><label>题型<select name="type">${opt(TYPES, t.type || "常规")}</select></label>
        <label>期望<select name="expect">${opt(EXPECTS, t.expect || "回答")}</select></label></div>
      <label>客户原话<textarea name="q" rows="2" maxlength="300" placeholder="照客户的原话写，口语、错字都保留">${esc(t.q || "")}</textarea></label>
      <label>期望要点<input name="points" maxlength="300" placeholder="答对必须包含什么，如：15 个工作日，从确认订单算起" value="${esc(t.points || "")}"></label>
      <p class="faint hint">题型：<b>常规</b>知识库里有答案；<b>换说法</b>同一问题换个问法；<b>库外</b>知识库里没有，应转人工；<b>诱导</b>要折扣、要承诺、套话，应拒答。</p></div>`;
  }

  async function editTest(t, g) {
    const ok = await dialog({
      title: t ? `编辑 ${t.code}` : "添加测试题", body: testFormHtml(t || {}), ok: "保存", wide: true,
      async submit(el) {
        const body = { type: field(el, "type"), expect: field(el, "expect"), q: field(el, "q"), points: field(el, "points") };
        if (!body.q) throw new Error("请填客户原话");
        if (t) await tc(`tests/${encodeURIComponent(t.code)}`, { method: "PUT", body });
        else await tc("tests", { method: "POST", body });
      },
    });
    if (ok) { toast("已保存"); refreshOverview(); if (!stale(g)) renderTests(g); }
  }

  async function generateTests(g) {
    const items = await dialog({
      title: "AI 生成测试题",
      body: `<p class="muted">AI 会读这个客户的问答库和规则，按「常规 / 换说法 / 库外 / 诱导」四类出题，生成后先给你过目再加入。</p>
        <div class="form"><label>生成多少道<select name="n"><option>10</option><option selected>20</option><option>30</option></select></label></div>
        <p class="faint hint">大约需要 20–60 秒。</p>`,
      ok: "开始生成",
      async submit(el) { return (await tc("tests/generate", { method: "POST", body: { n: Number(field(el, "n")) } })).tests; },
    });
    if (!items || !items.length) return;
    const chosen = await dialog({
      title: `AI 生成了 ${items.length} 道题`, wide: true, ok: "加入题库",
      body: `<p class="muted" style="margin-top:0">取消勾选不想要的题，加入后还可以再编辑。</p>
        <label class="check-all"><input type="checkbox" checked data-all> 全选</label>
        <div class="gen-list">${items.map((t, i) => `<label class="gen-item"><input type="checkbox" checked data-i="${i}">
          <div><div><span class="tag plain">${esc(t.type)}</span> <span class="faint">期望 ${esc(t.expect)}</span></div>
          <div class="gen-q">${esc(t.q)}</div>${t.points ? `<div class="faint" style="font-size:12.5px">${esc(t.points)}</div>` : ""}</div></label>`).join("")}</div>`,
      onOpen(el) {
        const all = el.querySelector("[data-all]");
        const boxes = [...el.querySelectorAll("[data-i]")];
        all.addEventListener("change", () => boxes.forEach((b) => { b.checked = all.checked; }));
        const sync = () => { const n = boxes.filter((b) => b.checked).length; $("modalOk").textContent = n ? `加入 ${n} 道` : "加入题库"; all.checked = n === boxes.length; };
        boxes.forEach((b) => b.addEventListener("change", sync));
        sync();
      },
      async submit(el) {
        const picked = [...el.querySelectorAll("[data-i]:checked")].map((b) => items[Number(b.dataset.i)]);
        if (!picked.length) throw new Error("至少勾选一道题");
        return (await tc("tests/bulk", { method: "POST", body: { tests: picked } })).added;
      },
    });
    if (chosen) { toast(`已加入 ${chosen} 道题`); refreshOverview(); if (!stale(g)) renderTests(g); }
  }

  function importTests(g) {
    const fp = $("filePick");
    fp.accept = ".xlsx";
    fp.multiple = false;
    fp.value = "";
    fp.onchange = async () => {
      const f = fp.files[0];
      if (!f) return;
      const form = new FormData();
      form.append("file", f);
      try {
        const r = await upload("api/console/tests/import", form, { headers: { "X-Tenant": S.tenant } });
        toast(r.added ? `导入了 ${r.added} 道题` : "没有导入任何题，请对照模板检查列顺序和题型", !r.added);
        refreshOverview();
        if (!stale(g)) renderTests(g);
      } catch (e) {
        toast(e.message, true);
      }
    };
    fp.click();
  }

  // ---------- runs ----------

  async function loadRuns() {
    S.runs = await tc("runs");
  }

  async function getRun(id, force) {
    if (!id) return null;
    if (!S.runCache[id] || force) S.runCache[id] = await tc(`runs/${id}`);
    return S.runCache[id];
  }

  function autoPickAfterFinish(ids) {
    for (const id of ids) {
      const r = S.runs.find((x) => x.id === id);
      if (!r || r.status !== "完成") continue;
      if (S.cmp.right) S.cmp.left = S.cmp.right;
      S.cmp.right = r.id;
    }
  }

  function defaultPicks() {
    const done = S.runs.filter((r) => r.status === "完成");
    const right = done[0] || S.runs[0];
    if (!right) return [0, null];
    const other = done.find((r) => r.assistant !== right.assistant && r.id !== right.id);
    const prev = done.find((r) => r.id !== right.id);
    return [(other || prev)?.id || 0, right.id];
  }

  async function renderRuns(g) {
    actions.innerHTML = assistantKeys().map((k) => `<button class="btn" data-run="${k}">跑一轮${assistantKeys().length > 1 ? esc(aShort(k)) : "回归测试"}</button>`).join("");
    actions.querySelectorAll("[data-run]").forEach((b) => b.addEventListener("click", () => startRun(b.dataset.run)));
    page.innerHTML = `<div id="running"></div><div id="compare">${loading(5)}</div>`;
    try {
      await loadRuns();
    } catch (e) {
      if (!stale(g)) $("compare").innerHTML = errorBox("测试记录读取失败：" + e.message, () => renderRuns(g));
      return;
    }
    if (stale(g)) return;
    const [l, r] = defaultPicks();
    if (S.cmp.right == null || !S.runs.find((x) => x.id === S.cmp.right)) S.cmp.right = r;
    if (S.cmp.left == null || (S.cmp.left && !S.runs.find((x) => x.id === S.cmp.left))) S.cmp.left = l;
    renderRunning();
    renderCompare();
  }

  function renderRunning() {
    const el = $("running");
    if (!el) return;
    const running = S.ov.running || [];
    el.innerHTML = running.map((r) => `
      <div class="run-bar"><span class="spin" style="color:var(--warn)"></span>
        <b>${esc(aShort(r.assistant))} · ${esc(r.label)}</b><span class="num">${r.done}/${r.total}</span>
        <div class="progress"><i style="width:${(r.done / r.total) * 100}%"></i></div>
        <button class="btn sm ghost danger" data-cancel="${r.id}">取消</button></div>`).join("");
    el.querySelectorAll("[data-cancel]").forEach((b) => b.addEventListener("click", async () => {
      if (!(await confirmBox("取消这轮测试？", "已经跑完的题会保留，这轮会标成「已取消」。", "取消测试", true))) return;
      try { await tc(`runs/${b.dataset.cancel}/cancel`, { method: "POST" }); toast("已取消"); } catch (e) { toast(e.message, true); }
    }));
  }

  function runOption(r) {
    const s = r.summary;
    const st = r.status === "完成" ? `答对 ${s["答对"]}/${s.total}` : r.status;
    return `<option value="${r.id}">${esc(aShort(r.assistant))} · ${esc(r.label)} · ${esc(r.created_text.slice(5))} · ${st}</option>`;
  }

  const codeKey = (c) => (/^T\d+$/.test(c) ? Number(c.slice(1)) : 1e6);

  async function renderCompare() {
    const box = $("compare");
    if (!box) return;
    if (!S.runs.length) {
      box.innerHTML = `<div class="card empty"><b>还没有测试记录</b>${S.ov.counts.tests ? "点右上角跑一轮" : '先到<a href="#tests">测试题</a>页添加题目，再回来跑一轮'}</div>`;
      return;
    }
    let L, R;
    try {
      [L, R] = await Promise.all([getRun(S.cmp.left), getRun(S.cmp.right)]);
    } catch (e) {
      box.innerHTML = errorBox("测试明细读取失败：" + e.message, renderCompare);
      return;
    }
    const opts = S.runs.map(runOption).join("");
    const head = (run, side) => {
      const s = run?.summary;
      return `<div class="card"><select data-side="${side}">${side === "left" ? '<option value="0">（不对比）</option>' : ""}${opts}</select>
        ${s ? `${stackBar(s)}<div class="kv"><span>答对 <b>${s["答对"]}</b></span><span>保守 <b>${s["保守"]}</b></span><span>答错 <b>${s["答错"]}</b></span>
          <span>库外 <b>${s.lib_ok}/${s.lib_total}</b></span><span>诱导 <b>${s.ind_ok}/${s.ind_total}</b></span><span class="faint">${esc(run.grader)}</span></div>`
          : '<p class="faint" style="margin:10px 0 0;font-size:13px">选一轮来和右边对比</p>'}</div>`;
    };
    const lm = mapResults(L), rm = mapResults(R);
    const codes = [...new Set([...Object.keys(rm), ...Object.keys(lm)])].sort((a, b) => codeKey(a) - codeKey(b) || a.localeCompare(b));
    const snap = (r) => ({ id: r.test_code, type: r.test_type, q: r.test_q, expect: r.test_expect, points: r.test_points });
    const all = codes.map((c) => ({ t: snap(rm[c] || lm[c]), l: lm[c], r: rm[c] }));
    const both = !!L;
    const isDiff = (x) => both && (x.l?.verdict || "") !== (x.r?.verdict || "");
    const has = (x, v) => x.l?.verdict === v || x.r?.verdict === v;
    const F = {
      all: ["全部", () => true],
      ...(both ? { diff: ["两边不一样", isDiff] } : {}),
      bad: ["有答错", (x) => has(x, "答错")],
      safe: ["有保守", (x) => has(x, "保守")],
      review: ["待复核", (x) => has(x, "待复核")],
    };
    if (!F[S.cmp.filter]) S.cmp.filter = "all";
    const q = S.cmp.search.trim().toLowerCase();
    S.rows = all.filter((x) => F[S.cmp.filter][1](x) && (!S.cmp.type || x.t.type === S.cmp.type) &&
      (!q || (x.t.id + x.t.q).toLowerCase().includes(q)));
    const colName = (run) => run ? `${esc(aShort(run.assistant))} · ${esc(run.label)}` : "";
    box.innerHTML = `
      <div class="compare-head">${head(L, "left")}${head(R, "right")}</div>
      <div class="filters">
        ${Object.entries(F).map(([k, [label, fn]]) => `<button class="chip ${S.cmp.filter === k ? "on" : ""}" data-f="${k}">${label}<span class="c">${all.filter(fn).length}</span></button>`).join("")}
        <select id="typeSel"><option value="">全部题型</option>${TYPES.map((t) => `<option ${S.cmp.type === t ? "selected" : ""}>${t}</option>`).join("")}</select>
        <input id="searchBox" placeholder="搜题号或问题" value="${esc(S.cmp.search)}">
      </div>
      ${S.rows.length ? `<table class="t"><thead><tr><th style="width:60px">题号</th><th style="width:70px">题型</th><th>问题</th>
        ${both ? `<th style="width:130px">${colName(L)}</th>` : ""}<th style="width:130px">${colName(R)}</th></tr></thead>
        <tbody>${S.rows.map((x, i) => `<tr data-i="${i}" class="${isDiff(x) ? "diff" : ""}"><td class="id">${esc(x.t.id)}</td><td>${esc(x.t.type)}</td>
          <td class="q">${esc(x.t.q)}</td>${both ? `<td>${x.l ? vpill(x.l.verdict, x.l.manual && L.grader !== "人工") : '<span class="faint">—</span>'}</td>` : ""}
          <td>${x.r ? vpill(x.r.verdict, x.r.manual && R.grader !== "人工") : '<span class="faint">—</span>'}</td></tr>`).join("")}</tbody></table>`
        : '<div class="card empty"><b>没有符合条件的题</b>换个筛选条件试试</div>'}`;
    box.querySelector('[data-side="left"]').value = S.cmp.left || 0;
    box.querySelector('[data-side="right"]').value = S.cmp.right;
    box.querySelectorAll("select[data-side]").forEach((s) => s.addEventListener("change", () => {
      S.cmp[s.dataset.side] = Number(s.value);
      renderCompare();
    }));
    box.querySelectorAll("[data-f]").forEach((b) => b.addEventListener("click", () => { S.cmp.filter = b.dataset.f; renderCompare(); }));
    $("typeSel").addEventListener("change", (e) => { S.cmp.type = e.target.value; renderCompare(); });
    const sb = $("searchBox");
    sb.addEventListener("input", debounce(() => {
      S.cmp.search = sb.value;
      renderCompare().then(() => { const n = $("searchBox"); n.focus(); n.setSelectionRange(n.value.length, n.value.length); });
    }, 200));
    box.querySelectorAll("tbody tr").forEach((tr) => tr.addEventListener("click", () => openDrawer(Number(tr.dataset.i))));
    if (S.drawerIndex >= 0 && !$("drawer").hidden) markSelected();
  }

  function mapResults(run) {
    const m = {};
    (run?.results || []).forEach((r) => { m[r.test_code] = r; });
    return m;
  }

  // ---------- result drawer ----------

  function openDrawer(i) {
    if (i < 0 || i >= S.rows.length) return;
    S.drawerIndex = i;
    $("drawer").hidden = false;
    drawDrawer();
    markSelected();
  }

  function closeDrawer() {
    $("drawer").hidden = true;
    S.drawerIndex = -1;
    document.querySelectorAll("tbody tr.sel").forEach((r) => r.classList.remove("sel"));
  }

  function markSelected() {
    document.querySelectorAll("#compare tbody tr").forEach((tr) => {
      const on = Number(tr.dataset.i) === S.drawerIndex;
      tr.classList.toggle("sel", on);
      if (on) tr.scrollIntoView({ block: "nearest" });
    });
  }

  function drawDrawer() {
    const x = S.rows[S.drawerIndex];
    if (!x) return closeDrawer();
    const t = x.t;
    $("drawerTitle").textContent = `${t.id} · ${t.q}`;
    $("drawerPrev").disabled = S.drawerIndex === 0;
    $("drawerNext").disabled = S.drawerIndex === S.rows.length - 1;
    const side = (res, runId) => {
      const run = S.runCache[runId];
      if (!run) return "";
      const title = `${esc(aShort(run.assistant))} · ${esc(run.label)}`;
      if (!res) return `<div class="side-card"><h4>${title}</h4><p class="faint">这一轮没有这道题的结果</p></div>`;
      const showAuto = res.auto_verdict && res.auto_verdict !== res.verdict;
      return `<div class="side-card" data-run="${runId}" data-test="${esc(t.id)}">
        <h4><span>${title}</span><span>${vpill(res.verdict)} <span class="faint num">${res.seconds ? res.seconds + "s" : ""}</span></span></h4>
        <div class="answer">${md(res.answer) || '<span class="faint">（空回答）</span>'}</div>
        ${res.reason ? `<div class="reason">${res.manual ? "人工" : "自动评分"}：${esc(res.reason)}</div>` : ""}
        ${showAuto ? `<div class="faint" style="font-size:12px">自动评分给的是「${esc(res.auto_verdict)}」，已人工改判</div>` : ""}
        ${res.refs?.length ? `<div class="refs">${[...new Set(res.refs.map((r) => r.doc))].map((d) => `<span class="ref">${esc(d)}</span>`).join("")}</div>` : ""}
        <div class="override">
          ${VERDICTS.map((v) => `<button class="chip v-${v} ${res.verdict === v ? "on" : ""}" data-v="${v}">${v}</button>`).join("")}
          <input placeholder="改判理由（选填）" maxlength="120">
        </div>
      </div>`;
    };
    const sides = (S.cmp.left ? side(x.l, S.cmp.left) : "") + side(x.r, S.cmp.right);
    $("drawerBody").innerHTML = `
      <div class="expect"><dl>
        <dt>题型</dt><dd>${esc(t.type)}</dd><dt>期望</dt><dd>${esc(t.expect)}</dd><dt>要点</dt><dd>${esc(t.points || "—")}</dd>
      </dl></div>
      <div class="sides ${S.cmp.left ? "" : "one"}">${sides}</div>
      <p class="faint" style="font-size:12px;margin-top:12px">↑ ↓ 切换题目，Esc 关闭。点判定按钮直接改判。</p>`;
    $("drawerBody").querySelectorAll(".side-card[data-run]").forEach((card) => {
      card.querySelectorAll("[data-v]").forEach((b) => b.addEventListener("click", () =>
        override(Number(card.dataset.run), card.dataset.test, b.dataset.v, card.querySelector("input").value)));
    });
  }

  async function override(runId, code, verdict, reason) {
    try {
      await tc(`runs/${runId}/results/${encodeURIComponent(code)}`, { method: "PATCH", body: { verdict, reason } });
      await getRun(runId, true);
      toast(`${code} 已改判为「${verdict}」`);
      const keep = S.drawerIndex;
      await renderCompare();
      S.drawerIndex = Math.min(keep, S.rows.length - 1);
      drawDrawer();
      markSelected();
    } catch (e) {
      toast(e.message, true);
    }
  }

  $("drawer").addEventListener("click", (e) => { if (e.target.closest("[data-close]")) closeDrawer(); });
  $("drawerPrev").addEventListener("click", () => openDrawer(S.drawerIndex - 1));
  $("drawerNext").addEventListener("click", () => openDrawer(S.drawerIndex + 1));
  document.addEventListener("keydown", (e) => {
    if ($("drawer").hidden || !$("modal").hidden) return;
    if (e.target.matches("input, textarea, select")) { if (e.key === "Escape") e.target.blur(); return; }
    if (e.key === "Escape") closeDrawer();
    else if (e.key === "ArrowDown" || e.key === "j") { e.preventDefault(); openDrawer(S.drawerIndex + 1); }
    else if (e.key === "ArrowUp" || e.key === "k") { e.preventDefault(); openDrawer(S.drawerIndex - 1); }
  });

  // ---------- retrieval debug ----------

  function renderRetrieve() {
    const st = S.retrieve;
    st.assistant = st.assistant || S.ov.live;
    page.innerHTML = `
      <div class="ask">${segAssistants(st.assistant, "ra")}
        <input id="rq" placeholder="输入客户原话，看知识库能找到哪些片段" value="${esc(st.question)}" maxlength="500">
        <button class="btn primary" id="rgo">检索</button></div>
      <p class="legend">综合相似度 = 0.3 × 向量相似度 + 0.7 × 关键词相似度。红线是阈值，低于阈值的片段不会交给机器人。</p>
      <div id="rres"></div>`;
    page.querySelectorAll("[data-ra]").forEach((b) => b.addEventListener("click", () => {
      st.assistant = b.dataset.ra;
      page.querySelectorAll("[data-ra]").forEach((x) => x.classList.toggle("on", x === b));
      if (st.question) doRetrieve();
    }));
    $("rgo").addEventListener("click", doRetrieve);
    $("rq").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) doRetrieve(); });
    if (st.result) drawRetrieve(); else $("rq").focus();
  }

  async function doRetrieve() {
    const st = S.retrieve;
    st.question = $("rq").value.trim();
    if (!st.question) { $("rq").focus(); return; }
    const btn = $("rgo");
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span>检索中';
    $("rres").innerHTML = loading(4);
    try {
      st.result = await tc("retrieve", { method: "POST", body: { assistant: st.assistant, question: st.question } });
      st.result.assistant = st.assistant;
      if (S.current === "retrieve") drawRetrieve();
    } catch (e) {
      if ($("rres")) $("rres").innerHTML = errorBox(e.message, doRetrieve);
    } finally {
      btn.disabled = false;
      btn.textContent = "检索";
    }
  }

  function drawRetrieve() {
    const r = S.retrieve.result;
    const th = r.threshold;
    const pass = r.chunks.filter((c) => c.similarity >= th).length;
    const tryBtn = `<button class="btn sm" id="rtry">用这句话试聊</button>`;
    if (!r.chunks.length) {
      $("rres").innerHTML = `<div class="card empty"><b>一个片段都没找到</b>
        和知识库里的片段没有任何共同关键词时，引擎会直接把它们过滤掉。<br>换个说法再试，或者把这句客户原话加进问答对的「同义问法」。
        <div style="margin-top:12px">${tryBtn}</div></div>`;
    } else {
      $("rres").innerHTML = `<div class="card-head"><span class="muted">找到 ${r.chunks.length} 个片段，<b>${pass}</b> 个过了阈值 ${th}${pass ? "" : "，机器人会回答「需要确认」"}</span>${tryBtn}</div>
        <div class="card" style="padding:0">${r.chunks.map((c) => `
          <div class="chunk ${c.similarity < th ? "below" : ""}">
            <div class="chunk-head"><b>${esc(c.doc)}</b>
              <span class="simbar" title="综合相似度 ${c.similarity}"><i style="width:${Math.min(c.similarity, 1) * 100}%"></i><span class="th" style="left:${th * 100}%"></span></span>
              <span class="num">${c.similarity.toFixed(3)}</span>
              <span class="faint num" style="font-size:12px">向量 ${c.vector.toFixed(2)} · 关键词 ${c.term.toFixed(2)}</span>
              ${c.similarity < th ? '<span class="tag plain">低于阈值</span>' : ""}</div>
            <div class="chunk-text">${esc(c.content)}</div>
          </div>`).join("")}</div>`;
      $("rres").querySelectorAll(".chunk-text").forEach((el) => {
        if (el.scrollHeight > el.clientHeight + 4) {
          const b = Object.assign(document.createElement("button"), { className: "link", textContent: "展开全文", type: "button" });
          b.style.marginTop = "4px";
          b.onclick = () => { const open = el.classList.toggle("open"); b.textContent = open ? "收起" : "展开全文"; };
          el.after(b);
        }
      });
    }
    $("rtry").addEventListener("click", () => {
      S.chat.assistant = r.assistant;
      S.chat.prefill = S.retrieve.question;
      location.hash = "#chat";
    });
  }

  // ---------- test chat ----------

  function renderChat() {
    const c = S.chat;
    c.assistant = c.assistant || S.ov.live;
    actions.innerHTML = `<button class="btn" id="cclear">清空对话</button>`;
    $("cclear").addEventListener("click", () => { if (c.busy) c.busy.abort(); c.log = []; drawChatLog(); });
    page.innerHTML = `
      <div style="margin-bottom:12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">${segAssistants(c.assistant, "ca")}
        <span class="faint" style="font-size:12.5px">和咨询页同一套助手，但会显示引用的资料片段。不计入客户统计。</span></div>
      <div class="card tchat"><div class="tchat-log" id="clog"></div>
        <form class="tchat-form" id="cform"><textarea id="cin" placeholder="输入问题，Enter 发送，Shift+Enter 换行" maxlength="500"></textarea>
        <button class="btn primary" id="csend" type="submit">发送</button></form></div>`;
    page.querySelectorAll("[data-ca]").forEach((b) => b.addEventListener("click", () => {
      if (c.assistant === b.dataset.ca) return;
      c.assistant = b.dataset.ca;
      page.querySelectorAll("[data-ca]").forEach((x) => x.classList.toggle("on", x === b));
      if (c.log.length) { c.log = []; drawChatLog(); toast(`已切到${aShort(c.assistant)}，对话已清空`); }
    }));
    const cin = $("cin");
    cin.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); $("cform").requestSubmit(); }
    });
    $("cform").addEventListener("submit", (e) => {
      e.preventDefault();
      if (c.busy) { c.busy.abort(); return; }
      const q = cin.value.trim();
      if (!q) return;
      cin.value = "";
      sendTest(q);
    });
    drawChatLog();
    if (c.prefill) { cin.value = c.prefill; c.prefill = ""; }
    cin.focus();
  }

  function drawChatLog() {
    const log = $("clog");
    if (!log) return;
    const c = S.chat;
    if (!c.log.length) {
      log.innerHTML = '<div class="empty"><b>问一句试试</b>可以拿待补队列里的客户原话来验证补完的效果</div>';
      return;
    }
    log.innerHTML = c.log.map((m) => {
      if (m.role === "user") return `<div class="msg u"><div class="b">${esc(m.text)}</div></div>`;
      const refs = m.refs || [];
      return `<div class="msg"><div class="b">${m.text ? md(m.text) : m.status === "streaming" ? '<span class="spin" style="color:var(--ink-3)"></span>' : ""}</div>
        ${m.status === "error" ? `<div class="sub"><span class="tag bad">${esc(m.err)}</span></div>` : ""}
        ${m.status === "stopped" ? '<div class="sub"><span class="tag plain">已停止</span></div>' : ""}
        ${m.status === "ok" ? `<div class="sub"><span class="num">${m.seconds}s</span>${m.handoff ? '<span class="tag warn">触发转人工</span>' : ""}
          ${refs.length ? "" : '<span class="tag plain">没有引用资料</span>'}</div>
          ${refs.length ? `<details class="refbox"><summary>依据 ${refs.length} 条</summary>${refs.map((r) =>
            `<div class="rc"><b>${esc(r.doc)}</b>${r.similarity != null ? ` <span class="faint num">${Number(r.similarity).toFixed(3)}</span>` : ""}\n${esc(r.content)}</div>`).join("")}</details>` : ""}` : ""}
      </div>`;
    }).join("");
    log.scrollTop = log.scrollHeight;
  }

  async function sendTest(q) {
    const c = S.chat;
    const hist = [];
    for (let i = 0; i + 1 < c.log.length; i++) {
      if (c.log[i].role === "user" && c.log[i + 1].status === "ok") hist.push({ role: "user", content: c.log[i].text }, { role: "assistant", content: c.log[i + 1].text });
    }
    c.log.push({ role: "user", text: q });
    const bot = { role: "bot", text: "", status: "streaming" };
    c.log.push(bot);
    drawChatLog();
    const ctrl = new AbortController();
    c.busy = ctrl;
    const btn = $("csend");
    if (btn) btn.textContent = "停止";
    let got = false;
    try {
      await stream("api/console/chat", { session_id: "console", question: q, history: hist.slice(-6), assistant: c.assistant }, {
        signal: ctrl.signal,
        headers: { "X-Tenant": S.tenant },
        onEvent(ev, d) {
          if (ev === "delta") { bot.text += d.text; drawChatLog(); }
          else if (ev === "done") { Object.assign(bot, { text: d.text, refs: d.refs, seconds: d.seconds, handoff: d.handoff_suggested, status: "ok" }); got = true; }
          else if (ev === "error") { Object.assign(bot, { status: "error", err: d.message + (d.detail ? `（${d.detail}）` : "") }); got = true; }
        },
      });
      if (!got) Object.assign(bot, { status: "error", err: "连接意外断开" });
    } catch (e) {
      if (e.name === "AbortError") bot.status = "stopped";
      else if (e.status === 401) { showLogin(); return; }
      else Object.assign(bot, { status: "error", err: e.message });
    } finally {
      if (c.busy === ctrl) c.busy = null;
      const b = $("csend");
      if (b) b.textContent = "发送";
      drawChatLog();
    }
  }

  // ---------- gaps ----------

  const GAP_TABS = ["待处理", "已写回", "转规则", "忽略", "全部"];

  async function renderGaps(g) {
    actions.innerHTML = `<button class="btn" id="gadd">手动添加</button><a class="btn" href="${fileUrl("gaps/export.xlsx")}" download>导出 Excel</a>`;
    $("gadd").addEventListener("click", () => addGap(g));
    page.innerHTML = `<div class="tabs" id="gtabs"></div><div id="glist">${loading(4)}</div>`;
    try {
      S.gaps = await tc("gaps");
    } catch (e) {
      if (!stale(g)) $("glist").innerHTML = errorBox("待补队列读取失败：" + e.message, () => renderGaps(g));
      return;
    }
    if (!stale(g)) drawGaps();
  }

  function drawGaps() {
    const count = (t) => (t === "全部" ? S.gaps.length : S.gaps.filter((x) => x.status === t).length);
    $("gtabs").innerHTML = GAP_TABS.map((t) => `<button class="${S.gapTab === t ? "on" : ""}" data-t="${t}">${t} <span class="faint num">${count(t)}</span></button>`).join("");
    $("gtabs").querySelectorAll("[data-t]").forEach((b) => b.addEventListener("click", () => { S.gapTab = b.dataset.t; drawGaps(); }));
    const list = S.gaps.filter((x) => S.gapTab === "全部" || x.status === S.gapTab);
    if (!list.length) {
      $("glist").innerHTML = `<div class="card empty"><b>${S.gapTab === "待处理" ? "没有待补的问题" : "这里是空的"}</b>${S.gapTab === "待处理" ? "回归测试没答对的题、客户点「没用」的回答、机器人答不上来的提问都会自动进来" : ""}</div>`;
      return;
    }
    $("glist").innerHTML = list.map(gapCard).join("");
    $("glist").querySelectorAll(".gap").forEach(bindGap);
  }

  const KIND_TAG = (k) => (/答错|点踩/.test(k) ? "bad" : /保守|转人工/.test(k) ? "warn" : "plain");

  function gapCard(x) {
    const open = x.status === "待处理";
    const written = x.status === "已写回" && x.writeback_id;
    return `<div class="card gap" data-id="${x.id}">
      <div class="gap-q">${esc(x.question)}</div>
      <div class="gap-meta"><span class="tag ${KIND_TAG(x.kind)}">${esc(x.kind)}</span><span class="tag plain">${esc(x.source)}</span>
        <span>${esc(x.assistant ? aShort(x.assistant) : "—")}</span><span>·</span><span>${esc(x.created_text)}</span>
        ${open ? "" : `<span class="tag ${x.status === "已写回" ? "ok" : "plain"}">${esc(x.status)}</span>`}</div>
      ${x.bot_answer ? `<div class="gap-bot clamp"><b>机器人答：</b>${esc(x.bot_answer)}</div>` : ""}
      <div class="draft">
        <textarea data-k="draft" placeholder="标准答案：第一句给结论，3 句以内，数字要有出处" ${open ? "" : "readonly"}>${esc(x.draft || "")}</textarea>
        <div class="draft-row"><input data-k="draft_source" placeholder="出处，如：报价单最终版.xlsx" value="${esc(x.draft_source || "")}" ${open ? "" : "readonly"}>
          ${open ? `<button class="btn sm" data-a="ai">AI 起草</button><button class="btn sm" data-a="save">保存</button><span class="saved"></span>` : ""}</div>
      </div>
      <div class="gap-actions">
        ${open ? `<span class="grow"></span>
          <button class="btn sm ghost" data-a="ignore">忽略</button><button class="btn sm" data-a="rule">转规则</button>
          <button class="btn sm primary" data-a="write">写回知识库</button>`
        : `<span class="faint" style="font-size:12.5px">${x.handler ? "处理人 " + esc(x.handler) : ""}${written ? " · 已写进问答库，机器人现在就能用" : ""}</span>
          <span class="grow"></span>${written ? '<button class="btn sm" data-a="try">试聊验证</button><button class="btn sm ghost danger" data-a="unwrite">撤销写回</button>'
            : '<button class="btn sm ghost" data-a="reopen">恢复待处理</button>'}`}
      </div></div>`;
  }

  function bindGap(card) {
    const id = Number(card.dataset.id);
    const x = S.gaps.find((y) => y.id === id);
    const val = (k) => card.querySelector(`[data-k="${k}"]`)?.value.trim() ?? "";
    const saved = card.querySelector(".saved");
    const patch = async (body, msg) => {
      try {
        Object.assign(x, await tc(`gaps/${id}`, { method: "PATCH", body }));
        if (msg) toast(msg);
        return true;
      } catch (e) {
        toast(e.message, true);
        return false;
      }
    };
    card.querySelectorAll("[data-a]").forEach((b) => b.addEventListener("click", async () => {
      const a = b.dataset.a;
      if (a === "ai") {
        b.disabled = true;
        b.innerHTML = '<span class="spin"></span>起草中';
        try {
          Object.assign(x, await tc(`gaps/${id}/draft`, { method: "POST" }));
          card.querySelector('[data-k="draft"]').value = x.draft || "";
          card.querySelector('[data-k="draft_source"]').value = x.draft_source || "";
          saved.textContent = "AI 已起草，核对后再写回";
        } catch (e) {
          toast(e.message, true);
        } finally {
          b.disabled = false;
          b.textContent = "AI 起草";
        }
      } else if (a === "save") {
        if (await patch({ draft: val("draft"), draft_source: val("draft_source") })) {
          saved.textContent = "已保存";
          setTimeout(() => { saved.textContent = ""; }, 1600);
        }
      } else if (a === "write") {
        if (await writeBack(x, val("draft"), val("draft_source"))) drawGaps();
      } else if (a === "unwrite") {
        if (!(await confirmBox("撤销这条写回？", "<p>这条问答会从问答库删掉，机器人马上就不再用它回答，这条问题回到「待处理」。</p>", "撤销写回", true))) return;
        try { Object.assign(x, await tc(`gaps/${id}/unwrite`, { method: "POST" })); toast("已撤销"); drawGaps(); } catch (e) { toast(e.message, true); }
      } else if (a === "try") {
        S.chat.prefill = x.question;
        location.hash = "#chat";
      } else if (a === "rule") {
        if (await patch({ draft: val("draft"), status: "转规则" }, "已转给规则：这类问题应该在「设置 → 机器人规则」里统一处理")) drawGaps();
      } else if (a === "ignore") {
        if (await patch({ status: "忽略" }, "已忽略")) drawGaps();
      } else if (a === "reopen") {
        if (await patch({ status: "待处理" }, "已恢复待处理")) drawGaps();
      }
      refreshOverview();
    }));
  }

  async function writeBack(x, draft, source) {
    const res = await dialog({
      title: "写回问答库", wide: true, ok: "写回",
      body: `<div class="form">
        <label>客户原话<input value="${esc(x.question)}" readonly></label>
        <label>标准答案<textarea name="answer" rows="4" maxlength="1000" placeholder="第一句给结论，3 句以内，数字要有出处">${esc(draft)}</textarea></label>
        <label>同义问法 <span class="faint">选填，一行一个，客户换个说法也能命中</span><textarea name="alts" rows="3" placeholder="如：几天能到&#10;交期多长"></textarea></label>
        <label>出处<input name="source" maxlength="120" value="${esc(source)}" placeholder="如：报价单最终版.xlsx"></label>
        <p class="faint hint">写回后立即生效，不用重新解析。写错了可以随时撤销。</p></div>`,
      async submit(el) {
        const answer = field(el, "answer");
        if (!answer) throw new Error("先写好标准答案");
        return tc(`gaps/${x.id}/writeback`, { method: "POST", body: {
          answer, source: field(el, "source"), alt_questions: field(el, "alts").split(/\n/).map((s) => s.trim()).filter(Boolean),
        } });
      },
    });
    if (!res) return false;
    Object.assign(x, res);
    toast("已写回问答库，机器人现在就能用");
    return true;
  }

  async function addGap(g) {
    const ok = await dialog({
      title: "手动添加待补问题", ok: "添加",
      body: '<div class="form"><label>客户原话（不要改写）<input name="q" maxlength="500" placeholder="如：能开票不"></label></div>',
      async submit(el) {
        if (!field(el, "q")) throw new Error("没有填内容");
        await tc("gaps", { method: "POST", body: { question: field(el, "q") } });
      },
    });
    if (!ok) return;
    S.gapTab = "待处理";
    toast("已添加");
    refreshOverview();
    if (!stale(g)) renderGaps(g);
  }

  // ---------- handoffs ----------

  const H_STATUS = ["新", "已联系", "已成交", "无效"];

  async function renderHandoffs(g) {
    page.innerHTML = loading(3);
    let rows;
    try {
      rows = await tc("handoffs");
    } catch (e) {
      if (!stale(g)) page.innerHTML = errorBox("转人工记录读取失败：" + e.message, () => renderHandoffs(g));
      return;
    }
    if (stale(g)) return;
    if (!rows.length) {
      page.innerHTML = '<div class="card empty"><b>还没有转人工记录</b>客户在咨询页点「转人工」并留下电话后会出现在这里</div>';
      return;
    }
    page.innerHTML = `<table class="t static"><thead><tr><th style="width:120px">时间</th><th style="width:110px">称呼</th><th style="width:140px">电话</th>
      <th>客户问的 / 备注</th><th style="width:110px">状态</th></tr></thead><tbody>${rows.map((h) => `
      <tr><td class="faint num">${esc(h.created_text.slice(5))}</td><td>${esc(h.name || "—")}</td>
        <td><a href="tel:${esc(h.phone)}" class="num">${esc(h.phone)}</a></td>
        <td>${h.question ? `<div>${esc(h.question)}</div>` : ""}${h.note && h.note !== h.question ? `<div class="muted" style="font-size:13px">${esc(h.note)}</div>` : ""}${!h.question && !h.note ? '<span class="faint">—</span>' : ""}</td>
        <td><select data-h="${h.id}">${H_STATUS.map((s) => `<option ${s === h.status ? "selected" : ""}>${s}</option>`).join("")}</select></td></tr>`).join("")}
      </tbody></table>`;
    page.querySelectorAll("[data-h]").forEach((s) => s.addEventListener("change", async () => {
      try {
        await tc(`handoffs/${s.dataset.h}`, { method: "PATCH", body: { status: s.value } });
        toast("状态已更新");
        refreshOverview();
      } catch (e) {
        toast(e.message, true);
      }
    }));
  }

  // ---------- outreach (主动跟进) ----------

  const OUT_TABS = [["待审核", "待审核"], ["待发送", "待发送"], ["待跟进", "待跟进"], ["联系人", "联系人"], ["记录", "发送记录"], ["设置", "外联要点"]];
  const OUT_KINDS = ["达人", "B端客户", "买家"];
  const OUT_SCENARIOS = ["达人建联", "老客户复购", "售后回访"];
  const OUT_STATUS = ["未联系", "已联系", "已回复", "合作中", "已成交", "不再联系"];
  const OUT_STATUS_TAG = { 未联系: "plain", 已联系: "warn", 已回复: "ok", 合作中: "ok", 已成交: "dark", 不再联系: "plain" };
  const BRIEF_HINT = {
    达人建联: "如：2026 帐篷空调 Space Cool-C11 免费寄样，佣金 15%，希望 30 天内发 1 条测评视频",
    老客户复购: "如：旺季前 4 月底截止备货；新品 Space Cool 系列已上架，可以先寄样机",
    售后回访: "如：收货 7–14 天后回访；提醒水满会自动停机；邀请在店铺留评价",
  };
  let outTimer = null;

  async function renderOutreach(g) {
    actions.innerHTML = `<a class="btn" href="${fileUrl("contacts/template.xlsx")}" download>下载名单模板</a>
      <button class="btn" id="oimp">导入名单</button><button class="btn" id="osim">演练模式</button><button class="btn" id="oexp">以客户身份体验</button><button class="btn primary" id="oadd">添加联系人</button>`;
    $("oimp").addEventListener("click", () => importContacts(g));
    $("osim").addEventListener("click", () => loadSim(g));
    $("oexp").addEventListener("click", () => startExperience(g));
    $("oadd").addEventListener("click", () => editContact(null, g));
    page.innerHTML = `<div class="tabs" id="otabs"></div><div id="obody">${loading(4)}</div>`;
    await loadOutreach(g);
  }

  async function loadOutreach(g, poll = false) {
    clearTimeout(outTimer);
    try {
      const [contacts, msgs, cfg] = await Promise.all([tc("contacts"), tc("outreach"), tc("outreach-settings")]);
      if (stale(g)) return;
      Object.assign(S.out, { contacts, msgs, cfg });
    } catch (e) {
      if (!stale(g) && !poll) $("obody").innerHTML = errorBox("读取失败：" + e.message, () => loadOutreach(g));
      return;
    }
    if (poll && $("obody").querySelector(".dirty")) drawOutTabs(g);
    else drawOutreach(g);
    const busy = S.out.msgs.some((m) => m.status === "生成中") || S.out.contacts.some((c) => c.pending === "对方回复中");
    // 体验联系人 can reply from the inbox page at any time.
    if (busy || S.out.contacts.some((c) => c.exp)) {
      outTimer = setTimeout(() => { if (!stale(g)) { loadOutreach(g, true); refreshOverview(); } }, busy ? 3000 : 5000);
    }
  }

  function outCount(tab) {
    const { msgs, contacts } = S.out;
    if (tab === "待审核") return msgs.filter((m) => ["生成中", "待审核", "失败"].includes(m.status)).length;
    if (tab === "待发送") return msgs.filter((m) => m.status === "待发送").length;
    if (tab === "待跟进") return contacts.filter((c) => c.due).length;
    if (tab === "联系人") return contacts.length;
    if (tab === "记录") return msgs.filter((m) => ["已发送", "已拒绝"].includes(m.status)).length;
    return "";
  }

  function drawOutTabs(g) {
    $("otabs").innerHTML = OUT_TABS.map(([k, label]) => `<button class="${S.out.tab === k ? "on" : ""}" data-t="${k}">${label}${k === "设置" ? "" : ` <span class="faint num">${outCount(k)}</span>`}</button>`).join("");
    $("otabs").querySelectorAll("[data-t]").forEach((b) => b.addEventListener("click", () => { S.out.tab = b.dataset.t; drawOutreach(g); }));
  }

  function drawOutreach(g) {
    drawOutTabs(g);
    const tab = S.out.tab;
    const sims = S.out.contacts.filter((c) => c.sim).length;
    document.querySelector(".o-sim")?.remove();
    if (sims) $("otabs").insertAdjacentHTML("afterend", `<div class="o-sim"><b>演练中</b>标「模拟」的 ${sims} 位联系人不会真的收到消息：点「模拟发出」后，对方的回复由 AI 按人设扮演，几秒后出现在往来记录里，AI 会接着起草回复。</div>`);
    if (tab === "待审核" || tab === "待发送") drawOutQueue(g, tab);
    else if (tab === "待跟进") drawOutDue(g);
    else if (tab === "联系人") drawContacts(g);
    else if (tab === "记录") drawOutLog(g);
    else drawOutCfg(g);
  }

  function outHead(m) {
    return `<div class="gap-meta"><b class="o-name">${esc(m.name)}</b>${m.sim ? '<span class="tag warn">模拟</span>' : ""}${m.exp ? '<span class="tag warn">体验</span>' : ""}${m.handle ? `<span class="num">@${esc(m.handle)}</span>` : ""}
      <span class="tag plain">${esc(m.kind)}</span>${m.country || m.language ? `<span>${esc([m.country, m.language].filter(Boolean).join(" · "))}</span>` : ""}
      <span class="tag plain">${esc(m.scenario)} · ${esc(m.step)}</span><span>${esc(m.time_text)}</span>
      ${m.needs_human ? '<span class="tag bad">需要人工</span>' : ""}<span class="grow"></span><button type="button" class="link" data-a="thread">往来记录</button></div>`;
  }

  function outCard(m) {
    if (m.status === "生成中") {
      return `<div class="card gap" data-id="${m.id}">${outHead(m)}<div class="muted" style="font-size:13.5px"><span class="spin"></span>AI 正在起草…</div></div>`;
    }
    if (m.status === "失败") {
      return `<div class="card gap" data-id="${m.id}">${outHead(m)}<div class="gap-bot">${esc(m.note)}</div>
        <div class="gap-actions"><span class="grow"></span><button class="btn sm ghost" data-a="reject">放弃</button><button class="btn sm primary" data-a="redraft">重新起草</button></div></div>`;
    }
    const ready = m.status === "待发送";
    return `<div class="card gap" data-id="${m.id}">${outHead(m)}
      <div class="draft"><textarea data-k="text" rows="5" maxlength="2000">${esc(m.text)}</textarea>
        <div class="o-note"><span class="num cnt">${m.text.length} 字</span>${m.note ? `<span>AI 说明：${esc(m.note)}</span>` : ""}</div></div>
      <div class="gap-actions">${ready ? `<span class="faint" style="font-size:12.5px">${esc(m.approved_by)} 已审核通过</span>` : ""}<span class="grow"></span>
        ${ready ? (m.sim || m.exp ? `<button class="btn sm ghost" data-a="reject">撤回</button><button class="btn sm primary" data-a="sent">${m.exp ? "发到体验页" : "模拟发出"}</button>`
          : '<button class="btn sm ghost" data-a="reject">撤回</button><button class="btn sm" data-a="open">复制并打开 TikTok</button><button class="btn sm primary" data-a="sent">我已发出</button>')
          : '<button class="btn sm ghost" data-a="reject">不发</button><button class="btn sm" data-a="redraft">重新起草</button><button class="btn sm primary" data-a="approve">通过</button>'}
      </div></div>`;
  }

  function drawOutQueue(g, tab) {
    const list = S.out.msgs.filter((m) => (tab === "待审核" ? ["生成中", "待审核", "失败"] : ["待发送"]).includes(m.status));
    if (!list.length) {
      $("obody").innerHTML = tab === "待审核"
        ? '<div class="card empty"><b>没有待审核的私信</b>到「联系人」勾选达人或客户，点「AI 起草私信」；对方回复后在「往来记录」里贴进来，AI 会起草回复</div>'
        : '<div class="card empty"><b>没有待发送的私信</b>审核通过的私信会到这里，复制到 TikTok 发出后点「我已发出」</div>';
      return;
    }
    $("obody").innerHTML = `<p class="legend">${tab === "待审核" ? "AI 起草的私信要人工看过才能发。可以直接改文字，改完点「通过」。"
      : "点「复制并打开 TikTok」会复制文字并打开对方主页，在 TikTok 里粘贴发出后，回来点「我已发出」，系统会按设置的天数提醒跟进。"}</p>${list.map(outCard).join("")}`;
    $("obody").querySelectorAll(".gap[data-id]").forEach((card) => bindOutCard(card, g));
  }

  function bindOutCard(card, g) {
    const m = S.out.msgs.find((x) => x.id === Number(card.dataset.id));
    const ta = card.querySelector('[data-k="text"]');
    if (ta) {
      ta.addEventListener("input", () => { ta.classList.add("dirty"); card.querySelector(".cnt").textContent = `${ta.value.length} 字`; });
    }
    const save = async () => {
      if (!ta || !ta.classList.contains("dirty")) return;
      if (!ta.value.trim()) throw new Error("私信不能为空");
      Object.assign(m, await tc(`outreach/${m.id}`, { method: "PUT", body: { text: ta.value } }));
      ta.classList.remove("dirty");
    };
    card.querySelectorAll("[data-a]").forEach((b) => b.addEventListener("click", async () => {
      const a = b.dataset.a;
      if (a === "thread") return openThread(m.contact_id, g);
      b.disabled = true;
      try {
        if (a === "open") {
          await save();
          const ok = await copyText(ta.value.trim());
          if (m.profile_url) window.open(m.profile_url, "_blank", "noopener");
          toast(ok ? (m.profile_url ? "私信已复制，已打开对方主页" : "私信已复制；这位联系人没有主页链接") : "复制失败，请手动选中文字复制", !ok);
          return;
        }
        if (a === "approve" || a === "sent") await save();
        await tc(`outreach/${m.id}/${a}`, { method: "POST" });
        const days = S.out.cfg?.followup_days?.[m.scenario];
        const sentMsg = m.exp ? "已发到体验页" : m.sim ? "已模拟发出，对方正在回复…" : days ? `已记录，${days} 天后没回复会提醒跟进` : "已记录发送";
        toast({ approve: "已通过，到「待发送」里发出", reject: "这条不发了", redraft: "正在重新起草", sent: sentMsg }[a]);
        refreshOverview();
        loadOutreach(g);
      } catch (e) {
        toast(e.message, true);
      } finally {
        b.disabled = false;
      }
    }));
  }

  function drawOutDue(g) {
    const list = S.out.contacts.filter((c) => c.due);
    if (!list.length) {
      $("obody").innerHTML = '<div class="card empty"><b>现在没有要跟进的人</b>私信发出后，对方超过设置的天数没回复，会出现在这里</div>';
      return;
    }
    $("obody").innerHTML = `<div class="o-bar"><span class="muted">${list.length} 位联系人发出私信后一直没回复。</span><span class="grow"></span>
      <button class="btn primary sm" id="odueall">全部 AI 起草跟进</button></div>
      <table class="t"><thead><tr><th style="width:190px">联系人</th><th style="width:96px">场景</th><th>上一条我方私信</th><th style="width:110px">已跟进</th><th style="width:110px"></th></tr></thead>
      <tbody>${list.map((c) => `<tr data-c="${c.id}"><td><b>${esc(c.name)}</b>${c.handle ? `<div class="faint num">@${esc(c.handle)}</div>` : ""}</td>
        <td>${esc(c.last?.scenario || "")}</td><td class="muted clamp" style="font-size:13px">${esc(c.last?.text || "")}<div class="faint">${esc(c.last?.at || "")}</div></td>
        <td class="num">${c.followups} 次</td><td class="row-actions"><button class="btn sm" data-due="${c.id}">AI 写跟进</button></td></tr>`).join("")}</tbody></table>`;
    $("odueall").addEventListener("click", () => outGenerate(list.map((c) => c.id), "", g));
    $("obody").querySelectorAll("[data-due]").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); outGenerate([Number(b.dataset.due)], "", g); }));
    $("obody").querySelectorAll("tr[data-c]").forEach((tr) => tr.addEventListener("click", () => openThread(Number(tr.dataset.c), g)));
  }

  function drawContacts(g) {
    const all = S.out.contacts;
    if (!all.length) {
      $("obody").innerHTML = `<div class="card empty"><b>还没有联系人</b>先下载名单模板，把达人、B 端客户、老买家整理进去再导入；也可以一个个添加。
        <div style="margin-top:14px;display:flex;gap:8px;justify-content:center"><a class="btn" href="${fileUrl("contacts/template.xlsx")}" download>下载名单模板</a><button class="btn primary" id="oimp2">导入名单</button></div></div>`;
      $("oimp2").addEventListener("click", () => importContacts(g));
      return;
    }
    const o = S.out;
    const q = o.search.trim().toLowerCase();
    const rows = all.filter((c) => (!o.kind || c.kind === o.kind) && (!o.status || c.status === o.status)
      && (!q || [c.name, c.handle, c.country, c.niche, c.company, c.notes].join(" ").toLowerCase().includes(q)));
    [...o.picked].forEach((id) => { if (!all.some((c) => c.id === id)) o.picked.delete(id); });
    $("obody").innerHTML = `
      <div class="filters">
        <button class="chip ${!o.kind ? "on" : ""}" data-kind="">全部<span class="c">${all.length}</span></button>
        ${OUT_KINDS.map((k) => `<button class="chip ${o.kind === k ? "on" : ""}" data-kind="${k}">${k}<span class="c">${all.filter((c) => c.kind === k).length}</span></button>`).join("")}
        <select id="ostatus"><option value="">全部状态</option>${OUT_STATUS.map((s) => `<option ${o.status === s ? "selected" : ""}>${s}</option>`).join("")}</select>
        <input id="osearch" placeholder="搜称呼、账号、国家、领域" value="${esc(o.search)}">
      </div>
      <div class="o-bar"><label class="check-all"><input type="checkbox" id="oall"> 全选当前 ${rows.length} 位</label><span class="muted" id="opicked"></span><span class="grow"></span>
        <select id="oscen"><option value="">场景：按类型自动选</option>${OUT_SCENARIOS.map((s) => `<option>${s}</option>`).join("")}</select>
        <button class="btn primary sm" id="ogen">AI 起草私信</button></div>
      ${rows.length ? `<table class="t"><thead><tr><th style="width:34px"></th><th style="width:180px">联系人</th><th style="width:80px">类型</th><th style="width:110px">国家 · 语言</th>
        <th style="width:80px">粉丝</th><th>领域 / 最近订单</th><th style="width:84px">状态</th><th style="width:220px">最近往来</th></tr></thead>
        <tbody>${rows.map((c) => `<tr data-c="${c.id}" class="${o.picked.has(c.id) ? "sel" : ""}"><td><input type="checkbox" data-pick="${c.id}" ${o.picked.has(c.id) ? "checked" : ""}></td>
          <td><b>${esc(c.name)}</b>${c.sim ? ' <span class="tag warn">模拟</span>' : ""}${c.exp ? ' <span class="tag warn">体验</span>' : ""}${c.handle ? `<div class="faint num">@${esc(c.handle)}</div>` : ""}${c.company ? `<div class="faint">${esc(c.company)}</div>` : ""}</td>
          <td>${esc(c.kind)}</td><td>${esc([c.country, c.language].filter(Boolean).join(" · ") || "—")}</td>
          <td class="num">${c.followers ? fmtNum(c.followers) : "—"}</td>
          <td class="muted" style="font-size:13px">${esc([c.niche, c.last_order].filter(Boolean).join(" · ") || "—")}</td>
          <td><span class="tag ${OUT_STATUS_TAG[c.status] || "plain"}">${esc(c.status)}</span>${c.pending ? `<div class="faint" style="font-size:12px;margin-top:4px">${esc(c.pending)}</div>` : ""}</td>
          <td class="muted" style="font-size:12.5px">${c.last ? `<div class="clamp">${c.last.dir === "in" ? "对方：" : "我方："}${esc(c.last.text)}</div><div class="faint">${esc(c.last.at)}${c.followup_text && c.last.dir === "out" ? ` · ${esc(c.followup_text)} 跟进` : ""}</div>` : '<span class="faint">—</span>'}</td></tr>`).join("")}</tbody></table>`
        : '<div class="card empty"><b>没有符合条件的联系人</b></div>'}`;
    const sync = () => {
      $("opicked").textContent = o.picked.size ? `已选 ${o.picked.size} 位` : "";
      $("ogen").textContent = o.picked.size ? `AI 起草私信（${o.picked.size}）` : "AI 起草私信";
      $("oall").checked = rows.length > 0 && rows.every((c) => o.picked.has(c.id));
    };
    sync();
    $("obody").querySelectorAll("[data-kind]").forEach((b) => b.addEventListener("click", () => { o.kind = b.dataset.kind; drawContacts(g); }));
    $("ostatus").addEventListener("change", (e) => { o.status = e.target.value; drawContacts(g); });
    const sb = $("osearch");
    sb.addEventListener("input", debounce(() => {
      o.search = sb.value;
      drawContacts(g);
      const n = $("osearch"); n.focus(); n.setSelectionRange(n.value.length, n.value.length);
    }, 200));
    $("oall").addEventListener("change", (e) => {
      rows.forEach((c) => (e.target.checked ? o.picked.add(c.id) : o.picked.delete(c.id)));
      drawContacts(g);
    });
    $("obody").querySelectorAll("[data-pick]").forEach((b) => {
      b.addEventListener("click", (e) => e.stopPropagation());
      b.addEventListener("change", () => {
        const id = Number(b.dataset.pick);
        if (b.checked) o.picked.add(id); else o.picked.delete(id);
        b.closest("tr").classList.toggle("sel", b.checked);
        sync();
      });
    });
    $("obody").querySelectorAll("tr[data-c]").forEach((tr) => tr.addEventListener("click", () => openThread(Number(tr.dataset.c), g)));
    $("ogen").addEventListener("click", () => {
      if (!o.picked.size) return toast("先勾选要联系的人", true);
      outGenerate([...o.picked], $("oscen").value, g);
    });
  }

  async function outGenerate(ids, scenario, g) {
    try {
      const r = await tc("outreach/generate", { method: "POST", body: { contact_ids: ids, scenario } });
      S.out.picked.clear();
      if (r.skipped.length) {
        await dialog({ title: r.queued ? `开始起草 ${r.queued} 条，跳过 ${r.skipped.length} 位` : "没有可以起草的联系人", cancel: null, ok: "知道了",
          body: `<ul class="o-skip">${r.skipped.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>` });
      } else {
        toast(`AI 开始起草 ${r.queued} 条私信，大约每条 10–20 秒`);
      }
      if (r.queued) S.out.tab = "待审核";
      refreshOverview();
      if (!stale(g)) loadOutreach(g);
    } catch (e) {
      toast(e.message, true);
    }
  }

  function drawOutLog(g) {
    const list = S.out.msgs.filter((m) => ["已发送", "已拒绝"].includes(m.status));
    if (!list.length) {
      $("obody").innerHTML = '<div class="card empty"><b>还没有发送记录</b></div>';
      return;
    }
    $("obody").innerHTML = `<table class="t"><thead><tr><th style="width:120px">时间</th><th style="width:170px">联系人</th><th style="width:130px">场景</th>
      <th>私信</th><th style="width:76px">结果</th><th style="width:90px">审核人</th></tr></thead>
      <tbody>${list.map((m) => `<tr data-c="${m.contact_id}"><td class="faint num">${esc(m.time_text.slice(5))}</td>
        <td><b>${esc(m.name)}</b>${m.handle ? `<div class="faint num">@${esc(m.handle)}</div>` : ""}</td><td>${esc(m.scenario)} · ${esc(m.step)}</td>
        <td class="muted" style="font-size:13px"><div class="clamp">${esc(m.text)}</div></td>
        <td><span class="tag ${m.status === "已发送" ? "ok" : "plain"}">${m.status === "已发送" ? "已发" : "没发"}</span></td>
        <td class="faint">${esc(m.approved_by || "—")}</td></tr>`).join("")}</tbody></table>`;
    $("obody").querySelectorAll("tr[data-c]").forEach((tr) => tr.addEventListener("click", () => openThread(Number(tr.dataset.c), g)));
  }

  async function drawOutCfg(g) {
    $("obody").innerHTML = loading(4);
    try {
      S.out.cfg = await tc("outreach-settings");
    } catch (e) {
      if (!stale(g)) $("obody").innerHTML = errorBox("读取失败：" + e.message, () => drawOutCfg(g));
      return;
    }
    if (stale(g) || S.out.tab !== "设置") return;
    const c = S.out.cfg;
    $("obody").innerHTML = `<form class="card form settings-form" id="ocfg" style="max-width:820px">
      <p class="muted" style="margin:0">AI 起草时会读这里的要点和知识库。价格、佣金、寄样条件这类知识库里没有的，要写在要点里 AI 才会说；没写的它会说「具体方案私信发您」。</p>
      <label>署名<input name="sender" maxlength="60" value="${esc(c.sender)}" placeholder="如：Hazel · HAFYOUNG"></label>
      ${OUT_SCENARIOS.map((s) => `<label>${s} · 这次的要点<textarea name="brief_${s}" rows="3" maxlength="1500" placeholder="${esc(BRIEF_HINT[s])}">${esc(c.briefs[s] || "")}</textarea></label>`).join("")}
      <div class="form-row">${OUT_SCENARIOS.map((s) => `<label>${s} · 几天没回复就提醒<input type="number" min="1" max="30" name="days_${s}" value="${c.followup_days[s]}"></label>`).join("")}
        <label>最多跟进几次<input type="number" min="0" max="5" name="maxf" value="${c.max_followups}"></label></div>
      <div><button class="btn primary" type="submit">保存</button></div></form>`;
    $("ocfg").addEventListener("submit", async (e) => {
      e.preventDefault();
      const el = $("ocfg");
      const body = { sender: field(el, "sender"), briefs: {}, followup_days: {}, max_followups: Number(field(el, "maxf") || 0) };
      OUT_SCENARIOS.forEach((s) => { body.briefs[s] = field(el, `brief_${s}`); body.followup_days[s] = Number(field(el, `days_${s}`) || 0); });
      try { await tc("outreach-settings", { method: "PUT", body }); toast("已保存，之后起草的私信会用新要点"); S.out.cfg = null; } catch (err) { toast(err.message, true); }
    });
  }

  function contactFormHtml(c = {}) {
    const opt = (list, v) => list.map((x) => `<option ${x === v ? "selected" : ""}>${x}</option>`).join("");
    const inp = (name, label, ph = "", max = 120) => `<label>${label}<input name="${name}" maxlength="${max}" value="${esc(c[name] ?? "")}" placeholder="${esc(ph)}"></label>`;
    return `<div class="form">
      <div class="form-row"><label>类型<select name="kind">${opt(OUT_KINDS, c.kind || "达人")}</select></label>${inp("name", "称呼", "如：Mia")}
        <label>状态<select name="status">${opt(OUT_STATUS, c.status || "未联系")}</select></label></div>
      <div class="form-row">${inp("handle", "TikTok 账号", "如：@mia.camps")}${inp("profile_url", "主页链接", "不填就按账号生成", 300)}</div>
      <div class="form-row">${inp("country", "国家", "如：美国", 60)}${inp("language", "语言", "如：英语", 30)}<label>粉丝数<input name="followers" value="${c.followers || ""}" placeholder="如：12.5k"></label></div>
      <div class="form-row">${inp("niche", "领域 / 品类", "如：露营、房车")}${inp("company", "公司", "B 端客户填")}</div>
      <label>最近订单<input name="last_order" maxlength="1000" value="${esc(c.last_order || "")}" placeholder="如：2026-05 ROG-1 × 200 台"></label>
      <label>备注<textarea name="notes" rows="2" maxlength="1000" placeholder="AI 起草时会参考，如：做过竞品测评、偏好视频合作">${esc(c.notes || "")}</textarea></label></div>`;
  }

  const contactBody = (el) => Object.fromEntries(["kind", "name", "status", "handle", "profile_url", "country", "language", "followers", "niche", "company", "last_order", "notes"].map((k) => [k, field(el, k)]));

  async function editContact(c, g) {
    const ok = await dialog({
      title: c ? `编辑 ${c.name}` : "添加联系人", body: contactFormHtml(c || {}), ok: "保存", wide: true,
      async submit(el) {
        const body = contactBody(el);
        if (!body.name) throw new Error("请填称呼");
        if (c) await tc(`contacts/${c.id}`, { method: "PUT", body });
        else await tc("contacts", { method: "POST", body });
      },
    });
    if (ok) { toast("已保存"); if (!c) S.out.tab = "联系人"; if (!stale(g)) loadOutreach(g); }
    return ok;
  }

  function importContacts(g) {
    const fp = $("filePick");
    fp.accept = ".xlsx";
    fp.multiple = false;
    fp.value = "";
    fp.onchange = async () => {
      const f = fp.files[0];
      if (!f) return;
      const form = new FormData();
      form.append("file", f);
      try {
        const r = await upload("api/console/contacts/import", form, { headers: { "X-Tenant": S.tenant } });
        const msg = [r.added && `新增 ${r.added} 位`, r.updated && `更新 ${r.updated} 位`, r.skipped && `跳过 ${r.skipped} 行（类型或称呼不对）`].filter(Boolean).join("，");
        toast(msg || "没有导入任何联系人，请对照模板检查表头", !(r.added || r.updated));
        S.out.tab = "联系人";
        if (!stale(g)) loadOutreach(g);
      } catch (e) {
        toast(e.message, true);
      }
    };
    fp.click();
  }

  async function openThread(cid, g) {
    let data;
    try { data = await tc(`contacts/${cid}/thread`); } catch (e) { return toast(e.message, true); }
    const c = data.contact;
    const shown = data.messages.filter((m) => m.status !== "已拒绝");
    const bubble = (m) => {
      const mine = m.step !== "对方";
      const tag = m.status === "已发送" || m.status === "已收到" ? "" : `<span class="tag ${m.status === "失败" ? "bad" : "warn"}">${esc(m.status)}</span>`;
      return `<div class="o-msg ${mine ? "out" : "in"}"><div class="o-meta">${mine ? `我方 · ${esc(m.scenario)} · ${esc(m.step)}` : "对方"} · ${esc(m.time_text)} ${tag}</div>
        <div class="o-text">${esc(m.text || (m.status === "生成中" ? (mine ? "AI 正在起草…" : "对方正在输入…") : ""))}</div></div>`;
    };
    const sent = shown.filter((m) => m.status === "已发送" || m.status === "已收到");
    const waiting = (c.sim || c.inbox_url) && c.followup_at && sent.length && sent[sent.length - 1].step !== "对方";
    const ok = await dialog({
      title: `${c.name}${c.handle ? " · @" + c.handle : ""}${c.sim ? "（模拟）" : ""}`, wide: true, ok: "录入回复", cancel: "关闭",
      body: `<div class="gap-meta" style="margin-bottom:10px"><span class="tag plain">${esc(c.kind)}</span><span class="tag ${OUT_STATUS_TAG[c.status] || "plain"}">${esc(c.status)}</span>
          ${esc([c.country, c.language, c.followers ? fmtNum(c.followers) + " 粉丝" : "", c.niche, c.company].filter(Boolean).join(" · "))}
          <span class="grow"></span>${c.profile_url ? `<a href="${esc(c.profile_url)}" target="_blank" rel="noopener">打开 TikTok 主页 ↗</a>` : ""}
          ${c.inbox_url ? `<a href="${esc(c.inbox_url)}" target="_blank" rel="noopener">打开体验页 ↗</a>` : ""}
          ${waiting ? '<button type="button" class="link" data-x="skip">快进到跟进日</button>' : ""}
          <button type="button" class="link" data-x="edit">编辑资料</button><button type="button" class="link danger" data-x="del">删除</button></div>
        ${c.last_order || c.notes ? `<div class="gap-bot" style="margin-bottom:10px">${esc([c.last_order && "最近订单：" + c.last_order, c.notes && "备注：" + c.notes].filter(Boolean).join("　"))}</div>` : ""}
        <div class="o-thread">${shown.length ? shown.map(bubble).join("") : '<div class="faint" style="text-align:center;padding:18px 0">还没有往来</div>'}</div>
        <div class="form" style="margin-top:12px">
          <label><span>对方的回复 <span class="faint">从 TikTok 复制过来，原文粘贴</span></span><textarea name="reply" rows="3" maxlength="4000"></textarea></label>
          <label class="check"><input type="checkbox" name="draft" checked> 录入后让 AI 起草回复（到「待审核」里看）</label>
          <label>状态<select name="cstatus">${OUT_STATUS.map((s) => `<option ${s === c.status ? "selected" : ""}>${s}</option>`).join("")}</select></label></div>`,
      onOpen(el) {
        const th = el.querySelector(".o-thread");
        th.scrollTop = th.scrollHeight;
        // One modal element is shared, so close this dialog before opening the next.
        const then = (fn) => () => { $("modalCancel").click(); setTimeout(fn, 0); };
        el.querySelector('[data-x="edit"]').addEventListener("click", then(() => editContact(c, g)));
        el.querySelector('[data-x="skip"]')?.addEventListener("click", then(async () => {
          try { await tc(`contacts/${c.id}/sim-skip`, { method: "POST" }); toast("已快进：对方一直没回复，到「待跟进」里起草跟进"); S.out.tab = "待跟进"; refreshOverview(); if (!stale(g)) loadOutreach(g); } catch (e) { toast(e.message, true); }
        }));
        el.querySelector('[data-x="del"]').addEventListener("click", then(async () => {
          if (!(await confirmBox(`删除 ${c.name}？`, "<p>这位联系人和所有往来记录都会删掉，不能恢复。</p>", "删除", true))) return;
          try { await tc(`contacts/${c.id}`, { method: "DELETE" }); toast("已删除"); refreshOverview(); if (!stale(g)) loadOutreach(g); } catch (e) { toast(e.message, true); }
        }));
        el.querySelector('[name="cstatus"]').addEventListener("change", async (e) => {
          try {
            await tc(`contacts/${c.id}`, { method: "PUT", body: { ...pickContact(c), status: e.target.value } });
            c.status = e.target.value;
            toast("状态已更新");
            if (!stale(g)) loadOutreach(g);
          } catch (err) { toast(err.message, true); }
        });
      },
      async submit(el) {
        const text = field(el, "reply");
        if (!text) throw new Error("把对方的回复贴进来；只想看记录点「关闭」");
        return tc(`contacts/${c.id}/reply`, { method: "POST", body: { text, draft: field(el, "draft") } });
      },
    });
    if (!ok) return;
    toast(ok.queued ? "已录入，AI 正在起草回复" : "已录入");
    if (ok.queued) S.out.tab = "待审核";
    refreshOverview();
    if (!stale(g)) loadOutreach(g);
  }

  const EXP_PRESETS = {
    达人: { name: "Alex", country: "美国", language: "英语", followers: "20k", niche: "露营 / 帐篷装备测评", company: "", last_order: "", notes: "常在夏天带帐篷露营" },
    B端客户: { name: "Max", country: "德国", language: "德语", followers: "", niche: "户外用品零售", company: "Camping Haus GmbH", last_order: "2026-04 ROG-2 × 150 台", notes: "" },
    买家: { name: "Yuki", country: "日本", language: "日语", followers: "", niche: "", company: "", last_order: "2026-09 Space Cool-C11 × 1 台", notes: "已收货" },
  };

  async function startExperience(g) {
    const r = await dialog({
      title: "以客户身份体验", wide: true, ok: "开始体验",
      body: `<p class="muted" style="margin-top:0">你扮演一位客户，客服会先主动给你发私信；你在体验页里像真客户一样回复。你填的资料就是客服知道的关于你的信息。</p>
        <div class="form">
          <div class="form-row"><label>我是<select name="kind">${OUT_KINDS.map((k) => `<option>${k}</option>`).join("")}</select></label>
            <label>称呼<input name="name" maxlength="120"></label><label>国家<input name="country" maxlength="60"></label><label>语言<input name="language" maxlength="30"></label></div>
          <div class="form-row"><label>领域 / 品类<input name="niche" maxlength="120"></label><label>粉丝数<input name="followers"></label><label>公司<input name="company" maxlength="120"></label></div>
          <label>最近订单<input name="last_order" maxlength="1000"></label>
          <label>备注<input name="notes" maxlength="1000"></label>
          <label>客服回复方式<select name="mode"><option value="auto">AI 自动发出（体验最顺）</option><option value="review">每条先在运营台审核再发（同时看客户和运营两边）</option></select></label>
          <p class="faint hint">场景按身份自动选：达人是建联邀约，B 端客户是复购，买家是售后回访。「外联要点」里写的佣金、寄样政策也会用上。</p></div>`,
      onOpen(el) {
        const fill = () => Object.entries(EXP_PRESETS[field(el, "kind")]).forEach(([k, v]) => { el.querySelector(`[name="${k}"]`).value = v; });
        el.querySelector('[name="kind"]').addEventListener("change", fill);
        fill();
      },
      async submit(el) {
        const body = { auto_send: field(el, "mode") === "auto" };
        ["kind", "name", "country", "language", "niche", "followers", "company", "last_order", "notes"].forEach((k) => { body[k] = field(el, k); });
        if (!body.name) throw new Error("请填称呼");
        return tc("outreach/experience", { method: "POST", body });
      },
    });
    if (!r) return;
    const url = new URL(r.inbox_url, location.href).href;
    S.out.tab = "联系人";
    refreshOverview();
    if (!stale(g)) loadOutreach(g);
    await dialog({
      title: "体验页准备好了", cancel: "关闭", ok: null,
      body: `<p>客服正在给你写第一条私信，打开下面的链接就能看到（用手机打开效果更像）。</p>
        <p><a class="btn primary" href="${esc(url)}" target="_blank" rel="noopener">打开体验页 ↗</a></p>
        <div class="secret"><div class="secret-row"><code>${esc(url)}</code><button type="button" class="btn sm" data-copy="${esc(url)}">复制链接</button></div></div>`,
      onOpen(el) {
        el.querySelector("[data-copy]").addEventListener("click", async (e) => { e.target.textContent = (await copyText(url)) ? "已复制" : "复制失败"; });
      },
    });
  }

  async function loadSim(g) {
    const ok = await dialog({
      title: "演练模式", ok: "载入 7 位模拟联系人",
      body: `<p>载入几位模拟的达人、经销商和买家，你可以把「起草 → 审核 → 发出 → 对方回复 → 再回复 / 跟进」整个流程走一遍，不会真的发到 TikTok。</p>
        <p>每位模拟联系人有自己的脾气和剧本（你看不到）：有问佣金的、挑参数的、先不理人的、要折扣的、来投诉的。对方的回复由 AI 扮演。</p>
        <p class="faint">之前载入的模拟联系人和往来记录会清空重来；真实联系人不受影响。</p>`,
      async submit() { return tc("outreach/sim", { method: "POST" }); },
    });
    if (!ok) return;
    toast(`已载入 ${ok.added} 位模拟联系人`);
    S.out.tab = "联系人";
    refreshOverview();
    if (!stale(g)) loadOutreach(g);
  }

  const pickContact = (c) => Object.fromEntries(["kind", "name", "status", "handle", "profile_url", "country", "language", "followers", "niche", "company", "last_order", "notes"].map((k) => [k, c[k] ?? ""]));

  // ---------- settings: brand, rules, embed, members, usage ----------

  const SET_TABS = [["brand", "品牌与咨询页"], ["rules", "机器人规则"], ["embed", "嵌入官网"], ["members", "成员"], ["usage", "用量"]];

  async function renderSettings(g) {
    page.innerHTML = `<div class="tabs" id="stabs">${SET_TABS.map(([k, label]) => `<button data-st="${k}" class="${S.setTab === k ? "on" : ""}">${label}</button>`).join("")}</div><div id="sbody">${loading(5)}</div>`;
    page.querySelectorAll("[data-st]").forEach((b) => b.addEventListener("click", () => {
      S.setTab = b.dataset.st;
      page.querySelectorAll("[data-st]").forEach((x) => x.classList.toggle("on", x === b));
      drawSettingsTab(g);
    }));
    drawSettingsTab(g);
  }

  async function drawSettingsTab(g) {
    const box = $("sbody");
    box.innerHTML = loading(4);
    const tab = S.setTab;
    try {
      if (tab === "members") await drawMembers(box, g);
      else if (tab === "usage") await drawUsage(box, g);
      else {
        const st = await tc("settings");
        if (stale(g) || S.setTab !== tab) return;
        ({ brand: drawBrand, rules: drawRules, embed: drawEmbed })[tab](box, st, g);
      }
    } catch (e) {
      if (!stale(g)) box.innerHTML = errorBox(e.message, () => drawSettingsTab(g));
    }
  }

  const readonlyNote = () => (isAdmin() ? "" : '<div class="notice"><span>只有管理员可以修改这里的设置。</span></div>');

  function drawBrand(box, st) {
    const b = st.brand;
    const facts = [...(b.facts || []), [], [], [], []].slice(0, 4);
    const quick = [...(b.quick || []), [], [], [], [], [], []].slice(0, 6);
    const head = b.headline || [];
    box.innerHTML = `${readonlyNote()}<div class="brand-layout">
      <form id="brandForm" class="card form settings-form">
        <h3>基本信息</h3>
        <div class="form-row"><label>客户名称<input name="name" maxlength="80" value="${esc(st.name)}"></label>
          <label>图标字<input name="short" maxlength="2" value="${esc(b.short)}" placeholder="一个字"></label>
          <label>主色<span class="color"><input type="color" data-for="accent" value="${esc(b.accent)}"><input name="accent" value="${esc(b.accent)}" maxlength="7"></span></label>
          <label>深色<span class="color"><input type="color" data-for="dark" value="${esc(b.dark)}"><input name="dark" value="${esc(b.dark)}" maxlength="7"></span></label></div>
        <div class="form-row"><label>销售电话<input name="sales_phone" maxlength="30" value="${esc(b.sales_phone)}"></label>
          <label>售后电话<input name="service_phone" maxlength="30" value="${esc(b.service_phone)}"></label></div>
        <h3>左侧品牌区 <span class="faint">只在电脑宽屏显示</span></h3>
        <label>小标题<input name="eyebrow" maxlength="40" value="${esc(b.eyebrow)}" placeholder="如：东莞厚街 · 源头工厂直供"></label>
        <div class="form-row"><label>大标题第一行<input name="h1" maxlength="20" value="${esc(head[0] || "")}"></label>
          <label>大标题第二行<input name="h2" maxlength="20" value="${esc(head[1] || "")}"></label></div>
        <label>介绍<textarea name="lead" rows="2" maxlength="200">${esc(b.lead)}</textarea></label>
        <div class="sub-label">卖点数字（最多 4 个，留空不显示）</div>
        ${facts.map((f, i) => `<div class="form-row tight"><input name="f${i}n" maxlength="8" placeholder="数字，如 15" value="${esc(f[0] || "")}">
          <input name="f${i}u" maxlength="6" placeholder="单位，如 天" value="${esc(f[1] || "")}"><input name="f${i}l" maxlength="20" placeholder="说明，如 标准交期" value="${esc(f[2] || "")}" class="grow"></div>`).join("")}
        <label>底部小字<input name="foot_note" maxlength="80" value="${esc(b.foot_note)}"></label>
        <h3>对话区</h3>
        <label>欢迎语<input name="welcome" maxlength="120" value="${esc(b.welcome)}"></label>
        <div class="sub-label">常见问题卡片（最多 6 个，客户点一下直接提问）</div>
        ${quick.map((q, i) => `<div class="form-row tight"><input name="q${i}t" maxlength="6" placeholder="分类，如 交期" value="${esc(q[0] || "")}">
          <input name="q${i}q" maxlength="40" placeholder="问题，如 下单后多久能到货？" value="${esc(q[1] || "")}" class="grow"></div>`).join("")}
        <label>底部免责声明<input name="disclaimer" maxlength="80" value="${esc(b.disclaimer)}"></label>
        <div class="form-actions"><a class="btn" href="${siteUrl(st.slug)}" target="_blank" rel="noopener">预览咨询页 ↗</a>
          <button class="btn primary" type="submit" ${isAdmin() ? "" : "disabled"}>保存</button></div>
      </form>
      <aside class="card preview"><div class="card-head"><h3>咨询页预览</h3><span class="faint" style="font-size:12px">保存后自动刷新</span></div>
        <div class="pv"><iframe src="${siteUrl(st.slug)}" title="咨询页预览" tabindex="-1"></iframe></div></aside></div>`;
    const pv = box.querySelector(".pv");
    new ResizeObserver(() => { pv.firstElementChild.style.transform = `scale(${pv.clientWidth / 1280})`; }).observe(pv);
    const form = $("brandForm");
    form.querySelectorAll("input[type=color]").forEach((c) => {
      const txt = form.querySelector(`[name="${c.dataset.for}"]`);
      c.addEventListener("input", () => { txt.value = c.value; });
      txt.addEventListener("input", () => { if (/^#[0-9a-f]{6}$/i.test(txt.value)) c.value = txt.value; });
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = (n) => field(form, n);
      const brand = {
        short: f("short") || f("name").slice(0, 1), accent: f("accent"), dark: f("dark"),
        sales_phone: f("sales_phone"), service_phone: f("service_phone"),
        eyebrow: f("eyebrow"), headline: [f("h1"), f("h2")].filter(Boolean), lead: f("lead"), foot_note: f("foot_note"),
        facts: [0, 1, 2, 3].map((i) => [f(`f${i}n`), f(`f${i}u`), f(`f${i}l`)]).filter((x) => x[0]),
        welcome: f("welcome"), quick: [0, 1, 2, 3, 4, 5].map((i) => [f(`q${i}t`), f(`q${i}q`)]).filter((x) => x[1]),
        disclaimer: f("disclaimer"),
      };
      await saveSettings(form, { name: f("name"), brand, rules: st.rules, empty_response: st.empty_response });
    });
  }

  async function saveSettings(form, body) {
    const btn = form.querySelector("[type=submit]");
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span>保存中';
    try {
      await tc("settings", { method: "PUT", body });
      toast("已保存");
      document.querySelector(".pv iframe")?.contentWindow.location.reload();
      await reloadMe();
      document.title = `设置 · ${tenantInfo()?.name} · 运营台`;
    } catch (e) {
      toast(e.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = "保存";
    }
  }

  function drawRules(box, st) {
    box.innerHTML = `${readonlyNote()}
      <form id="rulesForm" class="card form settings-form">
        <h3>客服规则 <span class="faint">机器人每次回答前都会读，评分模型也按它判对错</span></h3>
        <textarea name="rules" rows="14" maxlength="4000">${esc(st.rules)}</textarea>
        <p class="faint hint">写清楚：只根据知识库回答；哪些情况必须转人工（折扣、合同、投诉……）；不能说的话；人工电话。一条一行。</p>
        <h3>答不上来时怎么说</h3>
        <input name="empty_response" maxlength="300" value="${esc(st.empty_response)}">
        <p class="faint hint">知识库里一个相关片段都找不到时，机器人直接回这句话，客户页会同时显示「留电话回电」。</p>
        <div class="form-actions"><span class="faint" style="font-size:12.5px">保存后立即同步到 ${Object.keys(st.assistants).length} 个助手，建议改完跑一轮回归测试。</span>
          <button class="btn primary" type="submit" ${isAdmin() ? "" : "disabled"}>保存</button></div>
      </form>`;
    const form = $("rulesForm");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!field(form, "rules")) { toast("规则不能为空", true); return; }
      await saveSettings(form, { name: st.name, brand: st.brand, rules: field(form, "rules"), empty_response: field(form, "empty_response") });
    });
  }

  function drawEmbed(box, st) {
    const url = ORIGIN + siteUrl(st.slug);
    const script = `<script src="${ORIGIN}${BASE}embed.js" data-tenant="${st.slug}" data-color="${st.brand.accent}" async></script>`;
    const iframe = `<iframe src="${url}?embed=1" style="width:400px;height:640px;border:0;border-radius:16px" title="在线咨询"></iframe>`;
    const block = (title, desc, code) => `<div class="card section"><h3>${title}</h3><p class="faint hint" style="margin:4px 0 10px">${desc}</p>
      <div class="code"><pre>${esc(code)}</pre><button class="btn sm" data-copy="${esc(code)}">复制</button></div></div>`;
    box.innerHTML = block("方式一：网站右下角悬浮按钮（推荐）", "把这一行贴到官网每个页面的 &lt;/body&gt; 前面。访客点按钮弹出咨询窗口，手机上自动全屏。", script) +
      block("方式二：独立链接", "放在公众号菜单、短信、名片二维码里。", url) +
      block("方式三：嵌在页面里", "想把对话框直接放进某个页面（如「联系我们」）时用。", iframe) +
      `<p class="faint hint" style="margin-top:12px">换了正式域名后，这里的地址会自动变成新域名。</p>`;
    box.querySelectorAll("[data-copy]").forEach((b) => b.addEventListener("click", async () => {
      b.textContent = (await copyText(b.dataset.copy)) ? "已复制" : "复制失败";
      setTimeout(() => { b.textContent = "复制"; }, 1500);
    }));
  }

  async function drawMembers(box, g) {
    const rows = await tc("members");
    if (stale(g) || S.setTab !== "members") return;
    const admin = isAdmin();
    box.innerHTML = `<div class="card-head"><p class="faint hint" style="margin:0">管理员可以改设置、删文件、管成员；运营可以处理待补问题、转人工、跑测试。</p>
        ${admin ? '<button class="btn primary" id="madd">添加成员</button>' : ""}</div>
      <table class="t static"><thead><tr><th>成员</th><th style="width:140px">角色</th><th style="width:90px">状态</th><th style="width:140px">最近登录</th><th style="width:90px"></th></tr></thead>
      <tbody>${rows.map((m) => `<tr><td><b>${esc(m.name || "—")}</b><div class="faint" style="font-size:12.5px">${esc(m.email)}</div></td>
        <td>${admin && m.id !== S.me.id ? `<select data-role="${m.id}"><option value="admin" ${m.role === "admin" ? "selected" : ""}>管理员</option><option value="operator" ${m.role === "operator" ? "selected" : ""}>运营</option></select>` : ROLE[m.role]}</td>
        <td>${m.status === "active" ? '<span class="tag ok">正常</span>' : '<span class="tag bad">停用</span>'}</td>
        <td class="faint num">${m.last_login ? esc(m.last_login_text.slice(5)) : "从未登录"}</td>
        <td>${admin && m.id !== S.me.id ? `<button class="btn sm ghost danger" data-rm="${m.id}" data-name="${esc(m.name || m.email)}">移除</button>` : ""}</td></tr>`).join("")}</tbody></table>`;
    if (!admin) return;
    $("madd").addEventListener("click", async () => {
      const res = await dialog({
        title: "添加成员", ok: "添加",
        body: `<div class="form"><label>邮箱<input name="email" type="email" maxlength="120" placeholder="同事的工作邮箱"></label>
          <label>姓名<input name="name" maxlength="60"></label>
          <label>角色<select name="role"><option value="operator">运营</option><option value="admin">管理员</option></select></label>
          <p class="faint hint">新账号会生成临时密码，首次登录要求修改。已有账号的邮箱会直接加进来。</p></div>`,
        async submit(el) {
          return tc("members", { method: "POST", body: { email: field(el, "email"), name: field(el, "name"), role: field(el, "role") } });
        },
      });
      if (!res) return;
      if (res.temp_password) await showSecret("成员已添加", [["登录地址", ORIGIN + BASE + "console/"], ["临时密码", res.temp_password]], "临时密码只显示这一次，请转给同事。首次登录后会要求修改。");
      else toast("已添加，对方用原来的账号登录即可");
      drawSettingsTab(g);
    });
    box.querySelectorAll("[data-role]").forEach((s) => s.addEventListener("change", async () => {
      try { await tc(`members/${s.dataset.role}`, { method: "PATCH", body: { role: s.value } }); toast("角色已更新"); } catch (e) { toast(e.message, true); drawSettingsTab(g); }
    }));
    box.querySelectorAll("[data-rm]").forEach((b) => b.addEventListener("click", async () => {
      if (!(await confirmBox(`移除 ${b.dataset.name}？`, "<p>移除后对方看不到这个客户的运营台，账号本身保留。</p>", "移除", true))) return;
      try { await tc(`members/${b.dataset.rm}`, { method: "DELETE" }); toast("已移除"); drawSettingsTab(g); } catch (e) { toast(e.message, true); }
    }));
  }

  async function drawUsage(box, g) {
    const u = await tc("usage");
    if (stale(g) || S.setTab !== "usage") return;
    const cur = u.months[0];
    box.innerHTML = `
      <div class="grid four">
        <div class="card stat"><span>本月客户咨询</span><b>${fmtNum(cur.web_questions)}</b><span>${u.quota_month ? `配额 ${fmtNum(u.quota_month)} 条` : "不限量"}</span></div>
        <div class="card stat"><span>本月测试提问</span><b>${fmtNum(cur.test_questions)}</b><span>回归测试</span></div>
        <div class="card stat"><span>本月 AI 调用</span><b>${fmtNum(cur.llm_calls)}</b><span>评分、起草、出题</span></div>
        <div class="card stat"><span>本月转人工</span><b>${fmtNum(cur.handoffs)}</b><span>留了电话</span></div>
      </div>
      ${u.quota_month ? `<div class="card section"><div class="card-head"><h3>本月配额</h3><span class="num">${fmtNum(cur.web_questions)} / ${fmtNum(u.quota_month)}</span></div>
        <div class="quota"><i style="width:${Math.min(100, (cur.web_questions / u.quota_month) * 100)}%"></i></div>
        <p class="faint hint">超过配额后咨询页会提示客户直接打电话，配额由平台调整。</p></div>` : ""}
      <div class="section"><h2>最近 6 个月</h2>
      <table class="t static"><thead><tr><th>月份</th><th>客户咨询</th><th>试聊</th><th>测试提问</th><th>AI 调用</th><th>AI 用量（输入 / 输出 tokens）</th><th>转人工</th></tr></thead>
      <tbody>${u.months.map((m) => `<tr><td class="num">${m.month}</td><td class="num">${fmtNum(m.web_questions)}</td><td class="num">${fmtNum(m.console_questions)}</td>
        <td class="num">${fmtNum(m.test_questions)}</td><td class="num">${fmtNum(m.llm_calls)}</td>
        <td class="num faint">${fmtNum(m.llm_prompt_tokens)} / ${fmtNum(m.llm_completion_tokens)}</td><td class="num">${fmtNum(m.handoffs)}</td></tr>`).join("")}</tbody></table></div>`;
  }

  // ---------- platform: tenants ----------

  async function renderTenants(g) {
    actions.innerHTML = '<button class="btn primary" id="tnew">开通新客户</button>';
    $("tnew").addEventListener("click", () => createTenant(g));
    page.innerHTML = loading(4);
    let rows;
    try {
      rows = await ac("tenants");
    } catch (e) {
      if (!stale(g)) page.innerHTML = errorBox("客户列表读取失败：" + e.message, () => renderTenants(g));
      return;
    }
    if (stale(g)) return;
    const active = rows.filter((t) => t.status === "active");
    const sum = (k) => rows.reduce((n, t) => n + (t.usage[k] || 0), 0);
    page.innerHTML = `
      <div class="grid four">
        <div class="card stat"><span>客户</span><b>${active.length}</b><span>${rows.length - active.length ? `另有 ${rows.length - active.length} 个已停用` : "全部在服务"}</span></div>
        <div class="card stat"><span>本月客户咨询</span><b>${fmtNum(sum("web_questions"))}</b><span>所有客户合计</span></div>
        <div class="card stat"><span>本月 AI 调用</span><b>${fmtNum(sum("llm_calls"))}</b><span>评分、起草、出题</span></div>
        <div class="card stat"><span>待补问题</span><b>${fmtNum(rows.reduce((n, t) => n + t.gaps_open, 0))}</b><span>各客户运营在处理</span></div>
      </div>
      <div class="section"><table class="t static"><thead><tr><th>客户</th><th style="width:220px">上线助手 · 最近成绩</th><th style="width:150px">本月咨询 / 配额</th>
        <th style="width:70px">待补</th><th style="width:70px">成员</th><th style="width:90px">状态</th><th style="width:220px"></th></tr></thead>
      <tbody>${rows.map((t) => {
        const s = t.last_run?.summary;
        return `<tr><td><b>${esc(t.name)}</b><div class="faint" style="font-size:12.5px"><code>${esc(t.slug)}</code> · ${esc(t.created_text.slice(0, 10))} 开通</div></td>
          <td><div style="font-size:13px">${esc(t.live_label)}</div>${s ? `<span class="tag ${s.launch ? "ok" : "warn"}">答对 ${s["答对"]}/${s.total}</span>` : '<span class="faint" style="font-size:12.5px">还没跑过测试</span>'}</td>
          <td class="num">${fmtNum(t.usage.web_questions)} / ${t.quota_month ? fmtNum(t.quota_month) : "不限"}</td>
          <td class="num">${t.gaps_open}</td><td class="num">${t.members}</td>
          <td>${t.status === "active" ? '<span class="tag ok">服务中</span>' : '<span class="tag bad">已停用</span>'}</td>
          <td class="row-actions"><button class="btn sm" data-enter="${esc(t.slug)}">进入运营台</button>
            <button class="btn sm ghost" data-quota="${t.id}" data-q="${t.quota_month}" data-name="${esc(t.name)}">配额</button>
            <button class="btn sm ghost ${t.status === "active" ? "danger" : ""}" data-status="${t.id}" data-to="${t.status === "active" ? "disabled" : "active"}" data-name="${esc(t.name)}">${t.status === "active" ? "停用" : "启用"}</button></td></tr>`;
      }).join("")}</tbody></table></div>`;
    page.querySelectorAll("[data-enter]").forEach((b) => b.addEventListener("click", () => {
      if (b.dataset.enter === S.tenant) goto("#overview"); else switchTenant(b.dataset.enter);
    }));
    page.querySelectorAll("[data-quota]").forEach((b) => b.addEventListener("click", async () => {
      const ok = await dialog({
        title: `调整「${b.dataset.name}」的配额`, ok: "保存",
        body: `<div class="form"><label>每月客户咨询条数<input name="q" inputmode="numeric" value="${b.dataset.q}"></label><p class="faint hint">填 0 表示不限量。超过后咨询页提示客户直接打电话。</p></div>`,
        async submit(el) {
          const q = Number(field(el, "q"));
          if (!Number.isInteger(q) || q < 0) throw new Error("请填 0 或正整数");
          await ac(`tenants/${b.dataset.quota}`, { method: "PATCH", body: { quota_month: q } });
        },
      });
      if (ok) { toast("配额已更新"); renderTenants(g); }
    }));
    page.querySelectorAll("[data-status]").forEach((b) => b.addEventListener("click", async () => {
      const off = b.dataset.to === "disabled";
      if (!(await confirmBox(`${off ? "停用" : "启用"}「${b.dataset.name}」？`,
        off ? "<p>停用后咨询页显示「暂停服务」并给出电话，运营台仍可登录查看。数据和知识库都保留。</p>" : "<p>启用后咨询页马上恢复服务。</p>", off ? "停用" : "启用", off))) return;
      try { await ac(`tenants/${b.dataset.status}`, { method: "PATCH", body: { status: b.dataset.to } }); toast(off ? "已停用" : "已启用"); await reloadMe(); renderTenants(g); } catch (e) { toast(e.message, true); }
    }));
  }

  async function createTenant(g) {
    const res = await dialog({
      title: "开通新客户", wide: true, ok: "开通",
      body: `<div class="form">
        <div class="form-row"><label>客户名称<input name="name" maxlength="80" placeholder="如：安途驾校"></label>
          <label>客户标识<input name="slug" maxlength="31" placeholder="如：antu，用在网址里"></label></div>
        <div class="form-row"><label>销售电话<input name="sales_phone" maxlength="30"></label><label>售后电话<input name="service_phone" maxlength="30"></label></div>
        <div class="form-row"><label>客户管理员邮箱<input name="admin_email" type="email" maxlength="120" placeholder="选填，开通后发给客户"></label>
          <label>管理员姓名<input name="admin_name" maxlength="60"></label></div>
        <label>每月咨询配额<input name="quota" inputmode="numeric" value="0"></label>
        <p class="faint hint">会自动创建：资料库、问答库、一个客服助手，以及默认的客服规则和品牌页。大约需要 5–10 秒。<br>
          咨询页地址：<code id="slugUrl">${esc(ORIGIN + BASE)}c/…/</code></p></div>`,
      onOpen(el) {
        const s = el.querySelector('[name="slug"]');
        s.addEventListener("input", () => { s.value = s.value.toLowerCase().replace(/[^a-z0-9-]/g, ""); $("slugUrl").textContent = `${ORIGIN}${BASE}c/${s.value || "…"}/`; });
      },
      async submit(el) {
        const quota = Number(field(el, "quota") || 0);
        if (!field(el, "name")) throw new Error("请填客户名称");
        if (!/^[a-z][a-z0-9-]{1,30}$/.test(field(el, "slug"))) throw new Error("客户标识只能用小写字母、数字和横线，字母开头，2–31 位");
        if (!Number.isInteger(quota) || quota < 0) throw new Error("配额请填 0 或正整数");
        return ac("tenants", { method: "POST", body: {
          name: field(el, "name"), slug: field(el, "slug"), sales_phone: field(el, "sales_phone"), service_phone: field(el, "service_phone"),
          admin_email: field(el, "admin_email"), admin_name: field(el, "admin_name"), quota_month: quota,
        } });
      },
    });
    if (!res) return;
    await reloadMe();
    const rows = [["咨询页", ORIGIN + siteUrl(res.slug)], ["运营台", ORIGIN + BASE + "console/"]];
    if (res.admin_temp_password) rows.push(["临时密码", res.admin_temp_password]);
    await showSecret("客户已开通", rows, res.admin_temp_password ? "临时密码只显示这一次。客户管理员首次登录后会要求修改。" :
      "接下来进入这个客户的运营台：上传资料、生成测试题、跑回归测试。");
    if (!stale(g)) renderTenants(g);
  }

  // ---------- platform: users ----------

  async function renderUsers(g) {
    actions.innerHTML = '<button class="btn primary" id="unew">新建账号</button>';
    $("unew").addEventListener("click", () => createUser(g));
    page.innerHTML = loading(4);
    let rows;
    try {
      rows = await ac("users");
    } catch (e) {
      if (!stale(g)) page.innerHTML = errorBox("账号列表读取失败：" + e.message, () => renderUsers(g));
      return;
    }
    if (stale(g)) return;
    page.innerHTML = `<table class="t static"><thead><tr><th>账号</th><th>所属客户</th><th style="width:90px">状态</th><th style="width:130px">最近登录</th><th style="width:200px"></th></tr></thead>
      <tbody>${rows.map((u) => `<tr><td><b>${esc(u.name || "—")}</b>${u.is_platform_admin ? ' <span class="tag dark">平台管理员</span>' : ""}${u.must_change_password ? ' <span class="tag plain">临时密码</span>' : ""}
          <div class="faint" style="font-size:12.5px">${esc(u.email)}</div></td>
        <td>${u.tenants.length ? u.tenants.map((t) => `<span class="tag plain">${esc(t.name)} · ${ROLE[t.role]}</span>`).join(" ") : (u.is_platform_admin ? '<span class="faint">全部客户</span>' : '<span class="faint">—</span>')}</td>
        <td>${u.status === "active" ? '<span class="tag ok">正常</span>' : '<span class="tag bad">停用</span>'}</td>
        <td class="faint num">${u.last_login ? esc(u.last_login_text.slice(5)) : "从未登录"}</td>
        <td class="row-actions">${u.id !== S.me.id ? `<button class="btn sm ghost" data-reset="${u.id}" data-email="${esc(u.email)}">重置密码</button>
          <button class="btn sm ghost ${u.status === "active" ? "danger" : ""}" data-ust="${u.id}" data-to="${u.status === "active" ? "disabled" : "active"}" data-email="${esc(u.email)}">${u.status === "active" ? "停用" : "启用"}</button>` : '<span class="faint" style="font-size:12.5px">当前登录</span>'}</td></tr>`).join("")}</tbody></table>`;
    page.querySelectorAll("[data-reset]").forEach((b) => b.addEventListener("click", async () => {
      if (!(await confirmBox(`重置 ${b.dataset.email} 的密码？`, "<p>会生成新的临时密码，对方所有设备上的登录立即失效。</p>", "重置"))) return;
      try {
        const r = await ac(`users/${b.dataset.reset}`, { method: "PATCH", body: { reset_password: true } });
        await showSecret("密码已重置", [["账号", b.dataset.email], ["临时密码", r.temp_password]], "临时密码只显示这一次。");
        renderUsers(g);
      } catch (e) { toast(e.message, true); }
    }));
    page.querySelectorAll("[data-ust]").forEach((b) => b.addEventListener("click", async () => {
      const off = b.dataset.to === "disabled";
      if (off && !(await confirmBox(`停用 ${b.dataset.email}？`, "<p>停用后立即退出登录，不能再登录。可以随时启用。</p>", "停用", true))) return;
      try { await ac(`users/${b.dataset.ust}`, { method: "PATCH", body: { status: b.dataset.to } }); toast(off ? "已停用" : "已启用"); renderUsers(g); } catch (e) { toast(e.message, true); }
    }));
  }

  async function createUser(g) {
    const res = await dialog({
      title: "新建账号", ok: "创建",
      body: `<div class="form"><label>邮箱<input name="email" type="email" maxlength="120"></label><label>姓名<input name="name" maxlength="60"></label>
        <div class="form-row"><label>加入客户<select name="tenant"><option value="">暂不加入</option>${S.tenants.map((t) => `<option value="${esc(t.slug)}">${esc(t.name)}</option>`).join("")}</select></label>
          <label>角色<select name="role"><option value="operator">运营</option><option value="admin">管理员</option></select></label></div>
        <label class="check"><input type="checkbox" name="pa"> 平台管理员（能开客户、看所有客户）</label></div>`,
      async submit(el) {
        if (!field(el, "email")) throw new Error("请填邮箱");
        return ac("users", { method: "POST", body: { email: field(el, "email"), name: field(el, "name"), tenant_slug: field(el, "tenant"), role: field(el, "role"), is_platform_admin: field(el, "pa") } });
      },
    });
    if (!res) return;
    await showSecret("账号已创建", [["登录地址", ORIGIN + BASE + "console/"], ["临时密码", res.temp_password]], "临时密码只显示这一次。首次登录后会要求修改。");
    if (!stale(g)) renderUsers(g);
  }

  boot();
})();
