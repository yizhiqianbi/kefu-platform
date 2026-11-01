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
      out: { tab: "待审核", kind: "", status: "", search: "", sort: "", picked: new Set(), contacts: [], msgs: [], cfg: null, ap: null },
      cv: { social: { filter: "active", channel: "", q: "", cur: null }, email: { filter: "active", channel: "", q: "", cur: null } },
      cust: { kind: "", q: "" },
      vid: { cur: null, cfg: null, assetKind: "" },
      seo: { days: 30, audit: 0, run: 0, qs: null, sdays: 28, engine: "google" },
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
    overview: { title: "总览", group: "t", render: renderDashboard },
    kb: { title: "资料和问答", group: "t", render: renderKb },
    chat: { title: "对话", group: "t", render: renderChat },
    gaps: { title: "待补问题", group: "t", render: renderGaps, badge: "gaps" },
    status: { title: "上线状态", group: "t", render: renderOverview },
    tests: { title: "测试题", group: "t", render: renderTests },
    runs: { title: "回归测试", group: "t", render: renderRuns, badge: "runs" },
    retrieve: { title: "检索调试", group: "t", render: renderRetrieve },
    mail: { title: "收件", group: "t", render: (g) => renderConvs(g, "email"), full: true, badge: "mail" },
    outreach: { title: "外联", group: "t", render: renderOutreach, badge: "outreach" },
    social: { title: "会话", group: "t", render: (g) => renderConvs(g, "social"), full: true, badge: "social" },
    handoffs: { title: "转人工记录", group: "t", render: renderHandoffs, badge: "handoffs" },
    channels: { title: "渠道设置", group: "t", render: renderChannels },
    inbox: { title: "完整收件箱", group: "t", render: renderInbox, full: true, hidden: true },
    customers: { title: "客户", group: "t", render: renderCustomers },
    videos: { title: "视频", group: "t", render: renderVideos, badge: "video" },
    vassets: { title: "素材库", group: "t", render: renderVideoAssets },
    vsettings: { title: "视频设置", group: "t", render: renderVideoSettings },
    seo: { title: "官网流量", group: "t", render: renderSeo },
    seosearch: { title: "搜索表现", group: "t", render: renderSeoSearch },
    seoaudit: { title: "站点体检", group: "t", render: renderSeoAudit },
    geo: { title: "AI 可见度", group: "t", render: renderGeo },
    seosettings: { title: "接入和设置", group: "t", render: renderSeoSettings },
    settings: { title: "设置", group: "t", render: renderSettings },
    tenants: { title: "客户", group: "p", render: renderTenants },
    users: { title: "账号", group: "p", render: renderUsers },
  };
  // Sidebar modules; each lists its pages, shown as tabs under the title.
  const MODULES = [
    { key: "overview", title: "总览", pages: ["overview"] },
    { key: "kb", title: "知识库", pages: ["kb", "chat", "gaps", "status", "tests", "runs", "retrieve"] },
    { key: "mail", title: "邮件", pages: ["mail", "outreach"] },
    { key: "social", title: "社媒消息", pages: ["social", "handoffs", "channels", "inbox"] },
    { key: "video", title: "视频", pages: ["videos", "vassets", "vsettings"] },
    { key: "seo", title: "SEO / GEO", pages: ["seo", "seosearch", "seoaudit", "geo", "seosettings"] },
    { key: "customers", title: "客户", pages: ["customers"] },
    { key: "settings", title: "设置", pages: ["settings"] },
  ];
  const moduleOf = (page) => MODULES.find((m) => m.pages.includes(page));

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
    const mod = (m) => `<a href="#${m.pages[0]}" data-mod="${m.key}">${m.title}<span class="badge" data-badge="mod:${m.key}" hidden></span></a>`;
    $("nav").innerHTML = (S.tenant ? `<div class="nav-group">运营</div>${MODULES.map(mod).join("")}` : "") +
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
    const m = moduleOf(S.current);
    document.querySelectorAll("#nav a").forEach((a) => a.classList.toggle("on", a.dataset.page === S.current || (!!m && a.dataset.mod === m.key)));
    const tabs = $("modTabs");
    const shown = m && PAGES[S.current]?.group === "t" ? m.pages.filter((k) => !PAGES[k].hidden || k === S.current) : [];
    tabs.hidden = shown.length < 2;
    tabs.innerHTML = shown.length < 2 ? "" : shown.map((k) => `<a href="#${k}" class="${k === S.current ? "on" : ""}">${PAGES[k].title}${PAGES[k].badge ? `<span class="badge" data-badge="${PAGES[k].badge}" hidden></span>` : ""}</a>`).join("");
    updateBadges();
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
    document.body.classList.toggle("full-page", !!p.full);
    const title = p.group === "t" ? moduleOf(name)?.title || p.title : p.title;
    $("pageTitle").textContent = title;
    document.title = `${title} · ${p.group === "t" ? tenantInfo()?.name : "平台后台"} · 运营台`;
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
    const n = { gaps: c.gaps_open, handoffs: c.handoffs_new, runs: S.ov?.running?.length, outreach: (c.outreach_review || 0) + (c.outreach_due || 0),
      social: (c.social_human || 0) + (c.social_review || 0), mail: (c.mail_human || 0) + (c.mail_review || 0), video: c.video_review };
    MODULES.forEach((m) => { n["mod:" + m.key] = m.pages.reduce((s, k) => s + (PAGES[k].badge && PAGES[k].badge !== "runs" ? n[PAGES[k].badge] || 0 : 0), 0); });
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
      } else if (S.current === "status" && $("modal").hidden) {
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
    if (!o || S.current !== "status") return;
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
        <td>${h.phone.includes("@") ? `<a href="mailto:${esc(h.phone)}">${esc(h.phone)}</a>` : h.phone ? `<a href="tel:${esc(h.phone)}" class="num">${esc(h.phone)}</a>` : '<span class="faint">—</span>'}</td>
        <td>${h.question ? `<div>${esc(h.question)}</div>` : ""}${h.note && h.note !== h.question ? `<div class="muted" style="font-size:13px">${esc(h.note)}</div>` : ""}${!h.question && !h.note ? '<span class="faint">—</span>' : ""}
          ${h.chatwoot_url ? `<div><a href="#social" data-cw="${esc(h.chatwoot_url)}" style="font-size:13px">打开这个会话</a></div>` : ""}</td>
        <td><select data-h="${h.id}">${H_STATUS.map((s) => `<option ${s === h.status ? "selected" : ""}>${s}</option>`).join("")}</select></td></tr>`).join("")}
      </tbody></table>`;
    page.querySelectorAll("[data-cw]").forEach((a) => a.addEventListener("click", (e) => {
      const cid = +(a.dataset.cw.match(/conversations\/(\d+)/) || [])[1];
      if (!cid) { S.cwTarget = a.dataset.cw; a.href = "#inbox"; return; }
      e.preventDefault();
      openConv(cid, /邮件|email/i.test(a.closest("tr")?.textContent || "") ? "email" : "social");
    }));
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

  // ---------- inbox (Chatwoot, embedded) ----------

  // Chatwoot keeps its own login in a SameSite=Lax cookie, so it must be served from the same site as the console
  // (same host on another port, or a sibling subdomain). The first visit per tenant signs in with a one-time SSO link.
  const cwSigned = new Set();

  async function renderInbox(g) {
    page.innerHTML = loading(2);
    let d;
    try {
      d = await tc("channels");
    } catch (e) {
      if (!stale(g)) page.innerHTML = errorBox("收件箱读取失败：" + e.message, () => renderInbox(g));
      return;
    }
    if (stale(g)) return;
    if (!d.configured || !d.linked) {
      page.innerHTML = `<div class="card empty"><b>还没开通渠道</b>先到 <a href="#channels">渠道</a> 页开通，各渠道的客户消息会汇总到这里。</div>`;
      return;
    }
    const home = `${d.url}/app/accounts/${d.account_id}/dashboard`;
    const target = S.cwTarget || home;
    S.cwTarget = null;
    actions.innerHTML = `<span class="tag ${d.enabled ? "ok" : "plain"}">AI 自动回答${d.enabled ? "开着" : "已关闭"}</span>
      <button class="btn" id="cwHome">回到收件箱首页</button><button class="btn" id="cwPop">新窗口打开</button>`;
    page.innerHTML = '<iframe class="cw-frame" id="cwFrame" title="收件箱" allow="clipboard-write; microphone; camera"></iframe>';
    const frame = $("cwFrame");
    $("cwHome").addEventListener("click", () => { frame.src = home; });
    $("cwPop").addEventListener("click", () => window.open(frame.src && !frame.src.includes("sso_auth_token") ? frame.src : home, "_blank"));
    if (cwSigned.has(S.tenant)) {
      frame.src = target;
      return;
    }
    let r;
    try {
      r = await tc("channels/login", { method: "POST" });
    } catch (e) {
      if (!stale(g)) page.innerHTML = errorBox("登录收件箱失败：" + e.message, () => renderInbox(g));
      return;
    }
    if (stale(g)) return;
    // The SSO page signs in, then reloads into the dashboard; go to the wanted conversation after that second load.
    let loads = 0;
    frame.addEventListener("load", function onLoad() {
      if (++loads < 2) return;
      frame.removeEventListener("load", onLoad);
      cwSigned.add(S.tenant);
      if (target !== home) frame.src = target;
    });
    frame.src = r.url;
  }

  // ---------- channels (Chatwoot) ----------

  // Setup guides, checked against Chatwoot v4.19.1. `admin` = keys a platform admin fills once at
  // /super_admin/app_config?config=…; `hooks` = callback paths on the inbox domain to paste into each platform.
  const CW_GUIDES = [
    {
      key: "whatsapp", name: "WhatsApp", tag: "要 Meta 应用", wait: "号码验证当天；企业认证几天到几周",
      prep: ["Meta 商务账号（business.facebook.com），建议先做企业认证，不认证每天只能给少量新客户发消息",
        "一个没注册过 WhatsApp 的号码，能收短信或电话验证码",
        "Meta 开发者应用（developers.facebook.com，类型选「商务」），添加 WhatsApp 产品"],
      steps: ["开发者应用 → WhatsApp → API 设置：添加并验证你的号码，记下「电话号码 ID」和「WhatsApp Business 账户 ID」",
        "商务管理平台 → 系统用户：新建一个系统用户，把这个应用和 WhatsApp 账户分配给它，生成<b>永久令牌</b>，勾 whatsapp_business_messaging 和 whatsapp_business_management",
        "收件箱 → 设置 → 收件箱 → 添加收件箱 → WhatsApp → 服务商选「WhatsApp Cloud」，填号码（带国家码，如 +8613…）、电话号码 ID、商业账户 ID、永久令牌",
        "建好后打开这个收件箱的设置 → 「配置」，复制里面的回调地址和 Webhook 校验令牌，填到开发者应用 → WhatsApp → 配置 → Webhook，订阅字段勾 <code>messages</code>",
        "回到本页，点「给新收件箱接上 AI」"],
      hooks: [["回调地址（建好收件箱后以设置页显示的为准）", "/webhooks/whatsapp/+你的号码"]],
      limits: ["客户最后一条消息 24 小时后，只能发 Meta 审核过的模板消息", "Meta 按会话收费",
        "WhatsApp 条款不允许通用 AI 助手：平台的提示词已限定只回答本企业业务"],
    },
    {
      key: "instagram", name: "Instagram", tag: "要 Meta 审核", wait: "权限审核几天到几周",
      prep: ["Instagram 专业账号（商家或创作者账号）", "同一个 Meta 开发者应用，添加「Instagram」产品（用 Instagram 登录的 API）",
        "隐私政策页面的网址（审核必填，放官网即可）和一段操作录屏"],
      admin: ["INSTAGRAM_APP_ID、INSTAGRAM_APP_SECRET：开发者应用 → Instagram → API 设置里的 Instagram 应用编号和密钥",
        "INSTAGRAM_VERIFY_TOKEN：自己定一串随机字符，下面配 Webhook 时填同一串"],
      adminPage: "instagram",
      steps: ["开发者应用 → Instagram → API 设置 → 配置 Webhook：回调地址填下面的 Webhook 地址，验证口令填 INSTAGRAM_VERIFY_TOKEN，订阅 <code>messages</code>、<code>messaging_postbacks</code>、<code>messaging_seen</code>",
        "同一页「设置商务登录」：重定向网址填下面的授权回调地址",
        "应用审核 → 申请 instagram_business_basic、instagram_business_manage_messages 的高级权限；通过后把应用切到「上线」模式",
        "收件箱 → 设置 → 收件箱 → 添加收件箱 → Instagram → 用 Instagram 账号登录并授权",
        "回到本页，点「给新收件箱接上 AI」"],
      hooks: [["Webhook 地址", "/webhooks/instagram"], ["授权回调地址", "/instagram/callback"]],
      limits: ["客户最后一条消息 24 小时内能回复；申请 human_agent 权限并在超级管理员后台打开 ENABLE_INSTAGRAM_CHANNEL_HUMAN_AGENT 后，人工可延长到 7 天",
        "单条最长 1000 字，AI 的长回答会自动按句子拆开发"],
    },
    {
      key: "messenger", name: "Facebook Messenger", tag: "要 Meta 审核", wait: "pages_messaging 审核几天到几周",
      prep: ["公司的 Facebook 主页，你是主页管理员", "同一个 Meta 开发者应用，添加 Messenger 和「Facebook 登录」两个产品"],
      admin: ["FB_APP_ID、FB_APP_SECRET：开发者应用 → 设置 → 基本", "FB_VERIFY_TOKEN：自己定一串随机字符，下面配 Webhook 时填同一串"],
      adminPage: "facebook",
      steps: ["开发者应用 → 设置 → 基本：应用域名填收件箱域名",
        "Facebook 登录 → 设置：有效 OAuth 跳转 URI 填收件箱地址",
        "Messenger → 设置 → Webhook：回调地址填下面的地址，验证口令填 FB_VERIFY_TOKEN，订阅 <code>messages</code>、<code>messaging_postbacks</code>、<code>message_deliveries</code>、<code>message_reads</code>",
        "应用审核 → 申请 pages_messaging、pages_show_list、pages_manage_metadata、business_management",
        "收件箱 → 设置 → 收件箱 → 添加收件箱 → Messenger → 用 Facebook 登录，选主页",
        "回到本页，点「给新收件箱接上 AI」"],
      hooks: [["Webhook 地址", "/bot"]],
      limits: ["客户最后一条消息 24 小时内能回复", "单条最长 2000 字"],
    },
    {
      key: "tiktok", name: "TikTok", tag: "要 TikTok 开发者权限", wait: "权限审核时间不定",
      prep: ["TikTok 企业号（Business Account，个人号不行）",
        "TikTok for Business 开发者账号（business-api.tiktok.com/portal），建一个应用，申请私信（Business Messaging）权限",
        "私信接口不是所有国家和地区都开放，申请前先确认账号所在地区能用"],
      admin: ["TIKTOK_APP_ID、TIKTOK_APP_SECRET：开发者平台里这个应用的 App ID 和 Secret"],
      adminPage: "tiktok",
      steps: ["开发者应用 → 授权设置：重定向地址填下面的授权回调地址",
        "Webhook 设置：地址填下面的 Webhook 地址",
        "权限范围要全部勾上，少一个授权会失败：user.info.basic、user.info.username、user.info.stats、user.info.profile、user.account.type、user.insights、message.list.read、message.list.send、message.list.manage",
        "收件箱 → 设置 → 收件箱 → 添加收件箱 → TikTok → 用企业号登录授权",
        "回到本页，点「给新收件箱接上 AI」"],
      hooks: [["Webhook 地址", "/webhooks/tiktok"], ["授权回调地址", "/tiktok/callback"]],
      limits: ["只能回复对方先发来的私信，<b>不能主动给达人发</b>，达人外联还是在「邮件 → 外联」里起草后人工发",
        "对方最后一条消息 48 小时内能回复", "单条最长 950 字"],
    },
    {
      key: "telegram", name: "Telegram", tag: "最简单", wait: "5 分钟",
      prep: ["一个 Telegram 账号"],
      steps: ["在 Telegram 里找 @BotFather，发 <code>/newbot</code>，按提示起名，拿到 bot token",
        "收件箱 → 设置 → 收件箱 → 添加收件箱 → Telegram → 填 token。回调由 Chatwoot 自动注册，不用手填",
        "回到本页，点「给新收件箱接上 AI」，用手机给这个 bot 发条消息试试"],
      limits: ["不能主动给客户发起会话", "适合最先接，用来验证整条链路"],
    },
    {
      key: "email", name: "邮件", tag: "不用审核", wait: "10 分钟",
      prep: ["一个<b>询盘专用</b>邮箱（企业邮箱、Gmail、Outlook 都行），在邮箱设置里打开 IMAP 和 SMTP，生成授权码（不是登录密码）"],
      steps: ["收件箱 → 设置 → 收件箱 → 添加收件箱 → 电子邮件 → 「其他服务商」，填邮箱地址",
        "建好后打开这个收件箱的设置 → 「配置」：打开 IMAP，填收信服务器（如腾讯企业邮 imap.exmail.qq.com，端口 993，SSL）；打开 SMTP，填发信服务器（如 smtp.exmail.qq.com，端口 465，SSL）。用户名是邮箱地址，密码填授权码",
        "Chatwoot 每分钟收一次信。Gmail、Outlook 想用一键登录，要平台管理员在超级管理员后台配 Google 或 Microsoft 的 OAuth；用授权码更简单",
        "回到本页，点「给新收件箱接上 AI」"],
      limits: ["外联也可以用这个邮箱发：在「邮件 → 外联 → 自动运营」把发信方式选成这个收件箱，对方的回复会回到外联里等审核", "单条最长 25,000 字"],
    },
    {
      key: "line", name: "LINE", tag: "不用审核", wait: "20 分钟",
      prep: ["LINE 官方账号", "LINE Developers 控制台里建一个 Messaging API 频道"],
      steps: ["频道设置里记下 Channel ID、Channel secret，再签发一个长期的 Channel access token",
        "收件箱 → 设置 → 收件箱 → 添加收件箱 → LINE → 填这三项",
        "把下面的回调地址填到频道 → Messaging API → Webhook URL（把 Channel ID 换成你的），打开 Use webhook",
        "LINE Official Account Manager 里关掉「自动回应讯息」和「加入好友的欢迎讯息」，免得和 AI 抢着回",
        "回到本页，点「给新收件箱接上 AI」"],
      hooks: [["回调地址", "/webhooks/line/你的ChannelID"]],
      limits: ["单条最长 2000 字"],
    },
    {
      key: "sms", name: "短信（Twilio）", tag: "按条收费", wait: "30 分钟",
      prep: ["Twilio 账号和一个能收发短信的号码"],
      steps: ["Twilio 控制台记下 Account SID 和 Auth Token",
        "收件箱 → 设置 → 收件箱 → 添加收件箱 → 短信 → 选 Twilio，填 SID、Token 和号码",
        "Twilio 号码设置 → Messaging → 有消息进来时的 Webhook 填下面的地址",
        "回到本页，点「给新收件箱接上 AI」"],
      hooks: [["Webhook 地址", "/twilio/callback"]],
      limits: ["单条最长 320 字，按条收费"],
    },
  ];

  function cwBase(url) {
    return url || "https://inbox.你的域名";
  }

  function cwPublic(url) {
    return /^https:\/\//.test(url || "") && !/^https:\/\/(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|localhost)/.test(url);
  }

  function guideCards(d) {
    const ok = cwPublic(d.url);
    return `<div class="section"><h2>接入教程</h2>
      <div class="card section cw-pre"><h3>开始前（平台管理员做一次）</h3><ol>
        <li><b>收件箱要有公网 HTTPS 域名</b>，Meta、TikTok、Telegram 的服务器要能不登录直接访问到它（公司内网域名、挂了登录网关的都不行），并且和运营台在同一个主域名下，比如运营台 <code>kefu.xxx.com</code>、收件箱 <code>inbox.xxx.com</code>，否则嵌在运营台里会掉登录。
          现在的地址是 <code>${esc(cwBase(d.url))}</code>${ok ? "" : '，<span class="bad-text">不是公网 HTTPS，WhatsApp、Instagram、TikTok、Telegram 的消息推不进来，只能先演示和用邮件</span>'}。</li>
        <li><b>建一个 Meta 开发者应用</b>，WhatsApp、Instagram、Messenger 共用，同时提交企业认证。审核是整个接入里最慢的一步，第一周就提交。</li>
        <li><b>填各平台的应用密钥</b>：用超级管理员登录 ${S.me?.is_platform_admin && d.url ? `<a href="${esc(d.url)}/super_admin" target="_blank" rel="noopener">收件箱后台</a>` : "收件箱后台（<code>/super_admin</code>）"} → 设置，每个渠道要填哪几项写在下面的卡片里。</li>
        <li><b>每加完一个收件箱</b>，回本页点「给新收件箱接上 AI」，新消息才会先由 AI 回答。</li></ol></div>
      <div class="cw-guides">${CW_GUIDES.map((x) => `<button type="button" class="card cw-guide" data-guide="${x.key}">
        <b>${esc(x.name)}</b><span class="tag ${x.tag === "最简单" || x.tag === "不用审核" ? "ok" : "warn"}">${esc(x.tag)}</span>
        <span class="faint">大约 ${esc(x.wait)}</span></button>`).join("")}
        <div class="card cw-guide off"><b>微信客服 / 企业微信</b><span class="tag ok">已支持</span><span class="faint">在上面「个人号和企业微信」里点「添加」，选企业微信</span></div>
        <div class="card cw-guide off"><b>网站聊天</b><span class="tag ok">已有</span><span class="faint">用平台自带的咨询页，带品牌样式和引用出处</span></div></div></div>`;
  }

  function openGuide(d, key) {
    const x = CW_GUIDES.find((y) => y.key === key);
    const base = cwBase(d.url);
    const list = (arr) => `<ol>${arr.map((s) => `<li>${s}</li>`).join("")}</ol>`;
    const hooks = (x.hooks || []).map(([label, path]) => [label, base + path]);
    const body = `<div class="cw-guide-body">
      <h4>要准备</h4><ul>${x.prep.map((s) => `<li>${s}</li>`).join("")}</ul>
      ${x.admin ? `<h4>平台管理员填密钥</h4><p class="legend">超级管理员后台 → 设置 → ${esc(x.name)}${S.me?.is_platform_admin && d.url ? `（<a href="${esc(d.url)}/super_admin/app_config?config=${x.adminPage}" target="_blank" rel="noopener">直接打开</a>）` : ""}</p>
        <ul>${x.admin.map((s) => `<li>${s}</li>`).join("")}</ul>` : ""}
      <h4>步骤</h4>${list(x.steps)}
      ${hooks.length ? `<h4>要填的地址</h4><div class="secret">${hooks.map(([k, v]) => `<div class="secret-row"><span>${esc(k)}</span><code>${esc(v)}</code>
        <button type="button" class="btn sm" data-copy="${esc(v)}">复制</button></div>`).join("")}</div>` : ""}
      <h4>限制</h4><ul>${x.limits.map((s) => `<li>${s}</li>`).join("")}</ul></div>`;
    dialog({
      title: `接入 ${x.name}`, wide: true, body, ok: d.linked ? "去收件箱里添加" : "知道了", cancel: d.linked ? "关闭" : null,
      onOpen(el) {
        el.querySelectorAll("[data-copy]").forEach((b) => b.addEventListener("click", async () => {
          b.textContent = (await copyText(b.dataset.copy)) ? "已复制" : "复制失败";
          setTimeout(() => { b.textContent = "复制"; }, 1500);
        }));
      },
    }).then((go) => {
      if (go && d.linked) {
        S.cwTarget = `${d.url}/app/accounts/${d.account_id}/settings/inboxes/new`;
        location.hash = "#inbox";
      }
    });
  }

  function bindGuides(d) {
    page.querySelectorAll("[data-guide]").forEach((b) => b.addEventListener("click", () => openGuide(d, b.dataset.guide)));
  }

  async function renderChannels(g) {
    page.innerHTML = loading(3);
    let d;
    try {
      d = await tc("channels");
    } catch (e) {
      if (!stale(g)) page.innerHTML = errorBox("渠道信息读取失败：" + e.message, () => renderChannels(g));
      return;
    }
    if (stale(g)) return;
    if (!d.configured) {
      page.innerHTML = `<div class="card empty"><b>这台服务器还没接 Chatwoot</b>WhatsApp、Instagram、Messenger、TikTok、邮件、Telegram 等渠道通过 Chatwoot 接入。
        请平台管理员部署 Chatwoot，并在 .env 里填 CHATWOOT_URL 和 CHATWOOT_PLATFORM_TOKEN。</div>${guideCards(d)}`;
      bindGuides(d);
      return;
    }
    if (!d.linked) {
      page.innerHTML = `<div class="card section"><h3>开通多渠道客服</h3>
        <p class="legend">开通后会给这个客户建一个独立的收件箱，WhatsApp、Instagram、TikTok、邮件等渠道的消息都汇到这里。客户消息先由 AI 按知识库回答；答不上、问价格合同、或者客户要找人时，会话转给收件箱里的同事，同时记一条转人工和待补问题。</p>
        ${d.can_manage ? '<button class="btn primary" id="cwLink">开通</button>' : '<p class="faint">需要这个客户的管理员来开通。</p>'}</div>${guideCards(d)}`;
      bindGuides(d);
      $("cwLink")?.addEventListener("click", async (e) => {
        e.target.disabled = true;
        e.target.innerHTML = '<span class="spin"></span>开通中';
        try {
          await tc("channels/link", { method: "POST" });
          toast("已开通");
          renderChannels(g);
        } catch (err) {
          toast(err.message, true);
          e.target.disabled = false;
          e.target.textContent = "开通";
        }
      });
      return;
    }
    const missing = d.inboxes.filter((b) => !b.bot).length;
    const stats = d.stats.length ? `<table class="t static"><thead><tr><th>渠道</th><th style="width:120px">本月客户提问</th><th style="width:100px">转人工</th><th style="width:130px">AI 独立解决</th></tr></thead>
      <tbody>${d.stats.map((s) => `<tr><td>${esc(s.label)}</td><td class="num">${fmtNum(s.questions)}</td><td class="num">${fmtNum(s.handoffs)}</td>
        <td class="num">${s.questions ? Math.round((100 * (s.questions - s.handoffs)) / s.questions) + "%" : "—"}</td></tr>`).join("")}</tbody></table>`
      : '<p class="faint" style="margin:0">本月还没有渠道消息</p>';
    page.innerHTML = `
      <div class="card live-bar"><div>
        <span class="tag ${d.enabled ? "ok" : "plain"}">AI 自动回答${d.enabled ? "开着" : "已关闭，新消息直接给同事"}</span>
        ${missing ? `<span class="tag warn">${missing} 个收件箱还没接 AI</span>` : ""}</div>
        <div class="row-actions">${d.can_manage ? `<button class="btn" id="cwToggle">${d.enabled ? "关闭 AI 回答" : "打开 AI 回答"}</button>` : ""}
          ${d.can_manage && missing ? '<button class="btn" id="cwAttach">给新收件箱接上 AI</button>' : ""}
          <button class="btn primary" id="cwOpen">打开完整收件箱</button></div></div>
      <div class="section"><h2>收件箱</h2><div class="card">
        ${d.inboxes.length ? "" : '<p class="faint" style="margin:0">还没有接入任何渠道。先看下面的教程，建议从 Telegram 或邮件开始。</p>'}
        <table class="t static"${d.inboxes.length ? "" : " hidden"}><thead><tr><th>名称</th><th style="width:140px">渠道</th><th style="width:120px">AI</th><th style="width:170px">新会话默认</th></tr></thead>
        <tbody>${d.inboxes.map((b) => `<tr><td>${esc(b.name)}</td><td>${esc(b.label)}</td>
          <td>${b.bot ? '<span class="tag ok">已接上</span>' : '<span class="tag warn">没接 AI</span>'}</td>
          <td><div class="seg sm" role="group"><button type="button" data-host="${b.id}" data-v="1" class="${b.hosted ? "on" : ""}">AI 托管</button><button type="button" data-host="${b.id}" data-v="0" class="${b.hosted ? "" : "on"}">人工</button></div></td></tr>`).join("")}</tbody></table>
        ${d.inboxes.length ? '<p class="faint" style="margin:8px 0 0;font-size:12.5px">AI 托管：咨询类问题 AI 直接回；报价、跟进先起草等人审核；投诉和要找人的转人工。每个会话还可以在「会话」里单独切换。</p>' : ""}
        <p class="legend" style="margin:12px 0 0">要加新渠道，点下面教程里对应的卡片，按步骤做；加完回来点「给新收件箱接上 AI」。</p></div></div>
      <div class="section"><h2>个人号和企业微信</h2><div class="card" id="personalCard"></div></div>
      <div class="section"><h2>AI 怎么处理客户消息</h2><div class="card" id="agentCard"></div></div>
      <div class="section"><h2>本月各渠道</h2><div class="card">${stats}</div></div>
      ${guideCards(d)}`;
    bindGuides(d);
    drawAgentCard(g, d);
    drawPersonal(g);
    $("cwOpen").addEventListener("click", () => { location.hash = "#inbox"; });
    page.querySelectorAll("[data-host]").forEach((b) => b.addEventListener("click", async () => {
      if (b.classList.contains("on")) return;
      if (!isAdmin()) { toast("只有管理员可以改默认托管", true); return; }
      const hosted = b.dataset.v === "1";
      try {
        await tc(`channels/inboxes/${b.dataset.host}`, { method: "PUT", body: { hosted } });
        b.parentElement.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
        toast(hosted ? "这个渠道的新会话默认交给 AI" : "这个渠道的新会话默认由人工处理");
      } catch (e) {
        toast(e.message, true);
      }
    }));
    $("cwToggle")?.addEventListener("click", async () => {
      try {
        await tc("channels", { method: "PUT", body: { enabled: !d.enabled } });
        toast(d.enabled ? "已关闭 AI 回答" : "已打开 AI 回答");
        renderChannels(g);
      } catch (e) {
        toast(e.message, true);
      }
    });
    $("cwAttach")?.addEventListener("click", async () => {
      try {
        const r = await tc("channels/attach", { method: "POST" });
        toast(`已给 ${r.attached} 个收件箱接上 AI`);
        renderChannels(g);
      } catch (e) {
        toast(e.message, true);
      }
    });
  }

  // ---------- dashboard (老板总览) ----------

  const FUNNEL = ["未联系", "已联系", "已回复", "合作中", "已成交"];

  function ago(ts) {
    if (!ts) return "";
    const d = Date.now() / 1000 - ts;
    if (d < 60) return "刚刚";
    if (d < 3600) return Math.floor(d / 60) + " 分钟前";
    if (d < 86400) return Math.floor(d / 3600) + " 小时前";
    if (d < 7 * 86400) return Math.floor(d / 86400) + " 天前";
    const t = new Date(ts * 1000);
    return `${t.getMonth() + 1}-${t.getDate()}`;
  }

  function openConv(cid, channel, filter) {
    S.convOpen = cid;
    if (filter) S.convFilter = filter;
    goto(channel === "email" ? "#mail" : "#social");
  }

  async function renderDashboard(g) {
    actions.innerHTML = `<a class="btn" href="${siteUrl(S.tenant)}" target="_blank" rel="noopener">打开咨询页 ↗</a>`;
    page.innerHTML = loading(4);
    let d;
    try {
      [d] = await Promise.all([tc("dashboard"), refreshOverview()]);
    } catch (e) {
      if (!stale(g)) page.innerHTML = errorBox("总览读取失败：" + e.message, () => renderDashboard(g));
      return;
    }
    if (stale(g)) return;
    const o = S.ov, t = d.today, todo = d.todo;
    const lastLive = o.assistants[o.live]?.last_run;
    const rate = t.questions ? Math.round((100 * t.ai_solved) / t.questions) + "%" : "—";
    const todoN = todo.human + todo.review + todo.web_handoffs + todo.outreach_review;
    const max = Math.max(1, ...d.trend.map((x) => x.n));
    const chMax = Math.max(1, ...t.channels.map((x) => x.n));
    const todos = [
      [todo.human, "个会话等人回复", "social", "human"],
      [todo.review, "条 AI 草稿等审核", "social", "review"],
      [todo.web_handoffs, "位咨询页客户留了联系方式", "handoffs"],
      [todo.outreach_review, "封外联消息等审核", "outreach"],
      [todo.gaps, "个问题知识库答不上来", "gaps"],
    ];
    const funnelMax = Math.max(1, ...FUNNEL.map((k) => d.outreach.funnel[k] || 0));
    page.innerHTML = `
      ${o.tenant.status !== "active" ? '<div class="notice bad"><span>这个客户已被平台停用，咨询页暂停服务。</span></div>' : ""}
      ${!o.health.ragflow || !o.health.llm_key ? `<div class="notice bad"><span>${!o.health.ragflow ? "知识库引擎连不上" : "模型密钥缺失"}，AI 现在答不了客户。</span><a class="btn sm" href="#status">去看看</a></div>` : ""}
      ${!(lastLive && lastLive.summary.launch) ? '<div class="notice"><span>知识库还没达到上线标准，AI 的回答可能不准。</span><a class="btn sm" href="#status">看上线进度</a></div>' : ""}
      ${!d.linked ? '<div class="notice"><span>还没接入 WhatsApp、Instagram、TikTok 和邮箱，现在只统计咨询页。</span><a class="btn sm" href="#channels">去接入渠道</a></div>' : ""}
      <div class="grid four">
        <div class="card stat"><span>今天客户提问</span><b>${fmtNum(t.questions)}</b><span>${t.channels.length ? t.channels.map((c) => `${esc(c.label)} ${c.n}`).join(" · ") : "还没有"}</span></div>
        <div class="card stat"><span>AI 独立解决</span><b>${rate}</b><span>${fmtNum(t.ai_solved)} 条没转人工</span></div>
        <div class="card stat"><span>今天转人工</span><b>${fmtNum(t.handoffs)}</b><span>AI 答不了或客户要找人</span></div>
        <div class="card stat"><span>等你处理</span><b>${fmtNum(todoN)}</b><span>${todoN ? "见下方「要处理的事」" : "都处理完了"}</span></div>
      </div>
      <div class="grid two section">
        <div class="card"><h3>要处理的事</h3>
          <div class="todo-list">${todos.map(([n, text, page_, filter]) => `
            <a class="todo ${n ? "" : "done"}" href="#${page_}" ${filter ? `data-filter="${filter}"` : ""}><b>${n}</b><span>${text}</span><i>→</i></a>`).join("")}</div>
          ${d.waiting.length ? `<h3 style="margin-top:16px">等人回复的会话</h3><div class="list">${d.waiting.map((w) => `
            <a class="list-item link-row" href="#social" data-conv="${w.conv_id}" data-ch="${esc(w.channel)}"><span style="flex:1"><b>${esc(w.name || "未命名")}</b>
              <span class="tag plain">${esc(w.label)}</span></span><span class="faint">${esc(ago(w.last_in))}</span></a>`).join("")}</div>` : ""}
        </div>
        <div class="card"><h3>近 7 天客户提问</h3>
          <div class="spark">${d.trend.map((x) => `<div class="spark-col" title="${x.day}：${x.n} 条，转人工 ${x.h}">
            <span class="spark-n">${x.n || ""}</span><i style="height:${(x.n / max) * 100}%"><em style="height:${x.n ? (x.h / x.n) * 100 : 0}%"></em></i><span>${x.day.slice(3)}</span></div>`).join("")}</div>
          <p class="faint legend"><i class="lg-a"></i>AI 解决　<i class="lg-h"></i>转人工</p>
          ${t.channels.length ? `<h3 style="margin-top:12px">今天各渠道</h3>${t.channels.map((c) => `<div class="bar-row"><span>${esc(c.label)}</span>
            <span class="bar"><i style="width:${(c.n / chMax) * 100}%"></i></span><b>${c.n}</b></div>`).join("")}` : ""}
        </div>
      </div>
      <div class="section"><h2>意向客户</h2>
        <div class="card">${d.leads.length ? `<table class="t"><thead><tr><th>客户</th><th>渠道</th><th>进展</th><th>AI 判断</th><th>下一步</th><th>最近</th></tr></thead><tbody>
          ${d.leads.map((x) => `<tr data-conv="${x.conv_id}" data-ch="${esc(x.channel)}"><td><b>${esc(x.name || "未命名")}</b></td><td>${esc(x.label)}</td>
            <td><span class="tag warn">${esc(x.stage)}</span>${x.mode === "ai" ? ' <span class="tag ok">AI 跟进中</span>' : ""}</td>
            <td class="muted">${esc(x.summary)}</td><td>${esc(x.next_step)}</td><td class="faint nowrap">${esc(ago(x.last_in))}</td></tr>`).join("")}</tbody></table>`
          : '<div class="empty"><b>还没有到询价、样品或谈判阶段的客户</b>AI 会读每个会话，判断客户走到了哪一步</div>'}</div></div>
      <div class="grid two section">
        <div class="card"><h3>外联</h3>
          <div class="kv" style="margin-bottom:10px">今天发出 <b>${d.outreach.sent}</b> 封 · 收到回复 <b>${d.outreach.replies}</b> 封</div>
          ${FUNNEL.map((k) => `<div class="bar-row"><span>${k}</span><span class="bar"><i style="width:${((d.outreach.funnel[k] || 0) / funnelMax) * 100}%"></i></span><b>${d.outreach.funnel[k] || 0}</b></div>`).join("")}
          <p style="margin:10px 0 0"><a href="#outreach">去外联 →</a></p></div>
        <div class="card"><h3>知识库答不上来的问题</h3>
          ${d.gaps.length ? `<div class="list">${d.gaps.map((x) => `<div class="list-item"><span style="flex:1">${esc(x.question)}</span><span class="faint nowrap">${esc(ago(x.created))}</span></div>`).join("")}</div>
            <p style="margin:10px 0 0"><a href="#gaps">去补答案 →</a></p>` : '<div class="empty"><b>没有待补的问题</b>客户问到资料里没有的，会自动记到这里</div>'}</div>
      </div>`;
    page.querySelectorAll("[data-filter]").forEach((a) => a.addEventListener("click", () => { S.convFilter = a.dataset.filter; }));
    page.querySelectorAll("[data-conv]").forEach((el) => el.addEventListener("click", (e) => { e.preventDefault(); openConv(+el.dataset.conv, el.dataset.ch); }));
  }

  // ---------- conversations (邮件 · 收件 / 社媒消息 · 会话) ----------

  const CONV_FILTERS = [["active", "进行中"], ["human", "需要人工"], ["ai", "AI 托管"], ["review", "待审核"], ["resolved", "已结束"]];
  const CONV_POLL = 6000;

  async function renderConvs(g, scope) {
    const st = S.cv[scope];
    if (S.convOpen) { st.cur = S.convOpen; st.filter = S.convFilter || "active"; st.channel = ""; st.q = ""; S.convOpen = null; }
    if (S.convFilter) { st.filter = S.convFilter; S.convFilter = null; }
    st.items = []; st.page = 1; st.detail = null;
    page.innerHTML = `<div class="cv">
      <section class="cv-list">
        <div class="cv-tools">
          <div class="cv-filters" id="cvFilters"></div>
          <div class="cv-search"><select id="cvChannel"><option value="">全部渠道</option></select>
            <input id="cvQ" type="search" placeholder="${scope === "email" ? "搜发件人、主题、内容" : "搜名字、内容"}" value="${esc(st.q)}"></div>
        </div>
        <div class="cv-items" id="cvItems">${loading(4)}</div>
      </section>
      <section class="cv-main" id="cvMain"></section>
      <aside class="cv-side" id="cvSide"></aside>
    </div>`;
    $("cvQ").addEventListener("input", debounce(() => { st.q = $("cvQ").value.trim(); loadConvs(g, scope); }, 350));
    $("cvChannel").addEventListener("change", () => { st.channel = $("cvChannel").value; loadConvs(g, scope); });
    drawConvEmpty(scope);
    const ok = await loadConvs(g, scope);
    if (!ok || stale(g)) return;
    if (st.cur) openConvDetail(g, scope, st.cur);
    const tick = async () => {
      if (stale(g)) return;
      if (!document.hidden && $("modal").hidden) {
        await loadConvs(g, scope, { quiet: true });
        if (st.cur && !stale(g)) await refreshConvDetail(g, scope);
      }
      if (!stale(g)) setTimeout(tick, CONV_POLL);
    };
    setTimeout(tick, CONV_POLL);
  }

  async function loadConvs(g, scope, { quiet = false, more = false } = {}) {
    const st = S.cv[scope];
    const page_ = more ? st.page + 1 : 1;
    const qs = new URLSearchParams({ scope, filter: st.filter, channel: st.channel, q: st.q, page: page_ });
    let d;
    try {
      d = await tc("inbox/convs?" + qs);
    } catch (e) {
      if (stale(g)) return false;
      if (e.status === 404) {
        page.innerHTML = `<div class="card empty"><b>还没开通渠道</b>先在「社媒消息 → 渠道设置」开通，再把 WhatsApp、Instagram、TikTok 或邮箱接进来。
          <div style="margin-top:12px"><a class="btn primary" href="#channels">去渠道设置</a></div></div>`;
        return false;
      }
      if (!quiet) $("cvItems").innerHTML = errorBox("会话读取失败：" + e.message, () => loadConvs(g, scope));
      return false;
    }
    if (stale(g) || !$("cvItems")) return false;
    st.page = page_;
    st.items = more ? st.items.concat(d.items.filter((x) => !st.items.some((y) => y.id === x.id))) : d.items;
    st.more = d.more;
    st.counts = d.counts;
    st.inboxes = d.inboxes;
    $("cvFilters").innerHTML = CONV_FILTERS.map(([k, label]) => {
      const n = d.counts[k];
      return `<button type="button" class="chip ${k === st.filter ? "on" : ""}" data-f="${k}">${label}${n ? `<span class="c">${n}</span>` : ""}</button>`;
    }).join("");
    $("cvFilters").querySelectorAll("[data-f]").forEach((b) => b.addEventListener("click", () => { st.filter = b.dataset.f; loadConvs(g, scope); }));
    const sel = $("cvChannel");
    sel.innerHTML = `<option value="">全部渠道</option>${d.channels.map((c) => `<option value="${esc(c.channel)}" ${c.channel === st.channel ? "selected" : ""}>${esc(c.label)}</option>`).join("")}`;
    sel.hidden = d.channels.length < 2;
    drawConvItems(g, scope);
    return true;
  }

  function convTags(c) {
    const mode = c.status === "resolved" ? '<span class="tag plain">已结束</span>'
      : c.outreach ? '<span class="tag plain">外联</span>'
      : c.mode === "ai" ? '<span class="tag ok">AI 托管</span>' : '<span class="tag warn">人工</span>';
    return `${mode}${c.draft ? '<span class="tag warn">待审核</span>' : ""}${c.stage ? `<span class="tag plain">${esc(c.stage)}</span>` : ""}`;
  }

  function drawConvItems(g, scope) {
    const st = S.cv[scope], box = $("cvItems");
    if (!st.items.length) {
      box.innerHTML = !st.inboxes
        ? `<div class="empty"><b>${scope === "email" ? "还没接入邮箱" : "还没接入社媒渠道"}</b>${scope === "email"
          ? "在「社媒消息 → 渠道设置」的教程里选「邮件」，把企业邮箱接进来" : "在「渠道设置」按教程接入 WhatsApp、Instagram、TikTok"}
          <div style="margin-top:10px"><a class="btn sm" href="#channels">去渠道设置</a></div></div>`
        : `<div class="empty"><b>没有${CONV_FILTERS.find((f) => f[0] === st.filter)[1]}的会话</b>${st.q ? "换个关键词试试" : "新消息会自动出现在这里"}</div>`;
      return;
    }
    const top = box.scrollTop;
    box.innerHTML = st.items.map((c) => `
      <button type="button" class="cv-item ${c.id === st.cur ? "on" : ""}" data-cid="${c.id}">
        <span class="av">${c.avatar ? `<img src="${esc(c.avatar)}" alt="">` : esc((c.name || "?").slice(0, 1).toUpperCase())}</span>
        <span class="cv-item-body">
          <span class="cv-item-top"><b>${esc(c.name)}</b><span class="faint">${esc(ago(c.last.at))}</span></span>
          ${c.subject ? `<span class="cv-item-subj">${esc(c.subject)}</span>` : ""}
          <span class="cv-item-sub ${c.last.kind}">${c.last.kind === "out" ? "↩ " : c.last.kind === "note" ? "备注：" : ""}${esc(c.last.content || "（附件）")}</span>
          <span class="cv-item-tags"><span class="tag plain">${esc(c.label)}</span>${convTags(c)}${c.unread ? `<span class="badge">${c.unread}</span>` : ""}</span>
        </span>
      </button>`).join("") + (st.more ? '<button type="button" class="btn sm ghost block" id="cvMore">加载更多</button>' : "");
    box.scrollTop = top;
    box.querySelectorAll("[data-cid]").forEach((b) => b.addEventListener("click", () => openConvDetail(g, scope, +b.dataset.cid)));
    if ($("cvMore")) $("cvMore").onclick = () => loadConvs(g, scope, { more: true });
  }

  function drawConvEmpty(scope) {
    $("cvMain").innerHTML = `<div class="cv-blank"><b>选一个会话</b><span>${scope === "email"
      ? "客户发到企业邮箱的邮件都在这里。外联邮件的回复在「外联」里审核。"
      : "AI 托管的会话由 AI 直接回咨询类问题；报价和跟进会先起草，等你审核；投诉和要找人的，会转给你。"}</span></div>`;
    $("cvSide").innerHTML = "";
  }

  async function openConvDetail(g, scope, cid) {
    const st = S.cv[scope];
    st.cur = cid;
    st.detail = null;
    $("cvItems").querySelectorAll("[data-cid]").forEach((b) => b.classList.toggle("on", +b.dataset.cid === cid));
    $("cvMain").innerHTML = `<div style="padding:18px">${loading(3)}</div>`;
    $("cvSide").innerHTML = "";
    let d;
    try {
      d = await tc(`inbox/convs/${cid}`);
    } catch (e) {
      if (!stale(g) && st.cur === cid) $("cvMain").innerHTML = `<div style="padding:18px">${errorBox("会话读取失败：" + e.message, () => openConvDetail(g, scope, cid))}</div>`;
      return;
    }
    if (stale(g) || st.cur !== cid) return;
    st.detail = d;
    const item = st.items.find((x) => x.id === cid);
    if (item) { item.unread = 0; drawConvItems(g, scope); }
    drawConvMain(g, scope);
    drawConvSide(g, scope);
  }

  async function refreshConvDetail(g, scope) {
    const st = S.cv[scope], cur = st.detail;
    if (!cur) return;
    let d;
    try { d = await tc(`inbox/convs/${cur.id}`); } catch (e) { return; }
    if (stale(g) || st.cur !== cur.id || !st.detail) return;
    const lastId = (m) => (m.messages.length ? m.messages[m.messages.length - 1].id : 0);
    const draftKey = (m) => (m.draft ? `${m.draft.id}:${m.draft.status}` : "");
    const changed = lastId(d) !== lastId(cur) || d.mode !== cur.mode || d.status !== cur.status || draftKey(d) !== draftKey(cur);
    if (!changed) return;
    d.messages = cur.messages.filter((m) => m.id < (d.messages[0]?.id || Infinity)).concat(d.messages);
    d.more = cur.more;
    st.detail = d;
    drawConvHead(g, scope);
    drawConvMsgs(g, scope, true);
    const editing = document.activeElement && document.activeElement.id === "cvDraftText";
    if (!editing || draftKey(d) !== draftKey(cur)) drawConvDraft(g, scope);
    drawConvSide(g, scope);
  }

  function drawConvMain(g, scope) {
    const d = S.cv[scope].detail;
    $("cvMain").innerHTML = `
      <header class="cv-head" id="cvHead"></header>
      <div class="cv-msgs" id="cvMsgs"></div>
      <div id="cvDraft"></div>
      <div class="cv-compose">
        ${d.can_reply === false ? `<p class="cv-warn">已超过${esc(d.label)}的 ${d.window_h} 小时回复时限，客户再发消息之前只能发模板消息（在完整收件箱里发）。</p>` : ""}
        <textarea id="cvText" rows="3" placeholder="回复 ${esc(d.name)}…（Ctrl+Enter 发送）"></textarea>
        <div class="cv-compose-bar">
          <label class="check"><input type="checkbox" id="cvPrivate"> 内部备注（客户看不到）</label>
          <span style="flex:1"></span>
          <button type="button" class="btn sm" id="cvSuggest">AI 帮写</button>
          <button type="button" class="btn sm primary" id="cvSend">发送</button>
        </div>
      </div>`;
    drawConvHead(g, scope);
    drawConvMsgs(g, scope);
    drawConvDraft(g, scope);
    const text = $("cvText");
    $("cvPrivate").addEventListener("change", () => {
      text.classList.toggle("note", $("cvPrivate").checked);
      $("cvSend").textContent = $("cvPrivate").checked ? "加备注" : "发送";
    });
    text.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $("cvSend").click(); } });
    $("cvSend").onclick = () => sendConvMessage(g, scope);
    $("cvSuggest").onclick = async () => {
      const b = $("cvSuggest");
      if (text.value.trim() && !(await confirmBox("替换输入框里的内容？", "<p>AI 写好的回复会替换你现在输入的内容。</p>", "替换"))) return;
      b.disabled = true;
      b.innerHTML = '<span class="spin"></span>AI 在写';
      try {
        const r = await tc(`inbox/convs/${d.id}/suggest`, { method: "POST" });
        if (S.cv[scope].detail?.id !== d.id) return;
        text.value = r.text;
        text.focus();
        if (r.note) toast("AI 提醒：" + r.note);
      } catch (e) {
        toast(e.message, true);
      } finally {
        b.disabled = false;
        b.textContent = "AI 帮写";
      }
    };
  }

  function drawConvHead(g, scope) {
    const d = S.cv[scope].detail;
    $("cvHead").innerHTML = `
      <div class="cv-head-who"><h3>${esc(d.name)}</h3>
        <div class="faint">${esc(d.label)}${d.inbox ? " · " + esc(d.inbox) : ""}${d.subject ? " · " + esc(d.subject) : ""}</div></div>
      <div class="cv-head-actions">
        ${d.outreach ? '<span class="tag plain" title="外联邮件的回复由「外联」里的 AI 起草、人工审核">外联邮件</span>'
          : `<div class="seg sm" role="group"><button type="button" data-mode="ai" class="${d.mode === "ai" ? "on" : ""}">AI 托管</button><button type="button" data-mode="human" class="${d.mode === "human" ? "on" : ""}">人工</button></div>`}
        <button type="button" class="btn sm" id="cvResolve">${d.status === "resolved" ? "重新打开" : "结束会话"}</button>
      </div>`;
    $("cvHead").querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", async () => {
      if (b.dataset.mode === d.mode) return;
      try {
        await tc(`inbox/convs/${d.id}/mode`, { method: "PUT", body: { mode: b.dataset.mode } });
        toast(b.dataset.mode === "ai" ? "已交给 AI：咨询直接回，报价和跟进先起草等你审核" : "你接手了这个会话，AI 不再自动回复");
        await refreshAfterAction(g, scope);
      } catch (e) {
        toast(e.message, true);
      }
    }));
    $("cvResolve").onclick = async () => {
      const resolve = d.status !== "resolved";
      try {
        await tc(`inbox/convs/${d.id}/status`, { method: "POST", body: { status: resolve ? "resolved" : "open" } });
        toast(resolve ? "会话已结束，客户再发消息会重新打开" : "会话已重新打开");
        await refreshAfterAction(g, scope);
      } catch (e) {
        toast(e.message, true);
      }
    };
  }

  function msgBubble(m) {
    if (m.kind === "activity") return `<div class="msg activity"><span>${esc(m.content)}</span><span class="faint">${esc(m.at_text.slice(5))}</span></div>`;
    const who = m.kind === "in" ? m.sender : m.sender_type === "agent_bot" ? "AI" : m.sender || "我们";
    const att = m.attachments.map((a) => a.type === "image"
      ? `<a href="${esc(a.url)}" target="_blank" rel="noopener"><img class="msg-img" src="${esc(a.url)}" alt=""></a>`
      : `<a class="msg-file" href="${esc(a.url)}" target="_blank" rel="noopener">📎 ${esc(decodeURIComponent(a.name) || "附件")}</a>`).join("");
    return `<div class="msg ${m.kind}${m.sender_type === "agent_bot" ? " bot" : ""}">
      <div class="msg-meta">${m.kind === "note" ? "内部备注 · " : ""}${esc(who)} · ${esc(m.at_text.slice(5))}</div>
      ${m.subject ? `<div class="msg-subj">${esc(m.subject)}</div>` : ""}
      ${m.content ? `<div class="msg-body">${esc(m.content)}</div>` : ""}${att}
      ${m.failed ? `<div class="msg-err">没发出去${m.error ? "：" + esc(m.error) : ""}</div>` : ""}
    </div>`;
  }

  function drawConvMsgs(g, scope, keepScroll) {
    const d = S.cv[scope].detail, box = $("cvMsgs");
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    box.innerHTML = (d.more ? '<div style="text-align:center"><button type="button" class="btn sm ghost" id="cvOlder">更早的消息</button></div>' : "") +
      (d.messages.length ? d.messages.map(msgBubble).join("") : '<div class="cv-blank"><span>还没有消息</span></div>');
    if (!keepScroll || atBottom) box.scrollTop = box.scrollHeight;
    if ($("cvOlder")) $("cvOlder").onclick = async () => {
      const b = $("cvOlder");
      b.disabled = true;
      try {
        const r = await tc(`inbox/convs/${d.id}?before=${d.messages[0].id}`);
        if (S.cv[scope].detail !== d) return;
        const h = box.scrollHeight;
        d.messages = r.messages.concat(d.messages);
        d.more = r.more;
        drawConvMsgs(g, scope, true);
        box.scrollTop = box.scrollHeight - h;
      } catch (e) {
        toast(e.message, true);
        b.disabled = false;
      }
    };
  }

  function drawConvDraft(g, scope) {
    const d = S.cv[scope].detail, x = d.draft, box = $("cvDraft");
    if (!x) { box.innerHTML = ""; return; }
    if (x.status === "生成中") {
      box.innerHTML = `<div class="cv-draft"><span class="spin"></span>AI 正在起草${esc(x.kind)}…</div>`;
      return;
    }
    box.innerHTML = `<div class="cv-draft">
      <div class="cv-draft-head"><b>AI 起草的${esc(x.kind)}</b><span class="tag warn">待审核</span>
        ${x.question ? `<span class="faint clamp">回复：${esc(x.question)}</span>` : ""}</div>
      ${x.note ? `<p class="cv-draft-note">${esc(x.note)}</p>` : ""}
      <textarea id="cvDraftText" rows="4">${esc(x.text)}</textarea>
      <div class="cv-draft-bar"><span class="faint">可以直接改，改完再发</span><span style="flex:1"></span>
        <button type="button" class="btn sm ghost danger" id="cvDraftDrop">丢弃</button>
        <button type="button" class="btn sm primary" id="cvDraftSend">审核通过，发送</button></div>
    </div>`;
    $("cvDraftDrop").onclick = async () => {
      try {
        await tc(`inbox/drafts/${x.id}/discard`, { method: "POST" });
        toast("草稿已丢弃");
        await refreshAfterAction(g, scope);
      } catch (e) { toast(e.message, true); }
    };
    $("cvDraftSend").onclick = async () => {
      const b = $("cvDraftSend"), text = $("cvDraftText").value.trim();
      if (!text) { toast("草稿是空的", true); return; }
      b.disabled = true;
      b.innerHTML = '<span class="spin"></span>发送中';
      try {
        await tc(`inbox/drafts/${x.id}/send`, { method: "POST", body: { text } });
        toast("已发送");
        await refreshAfterAction(g, scope);
      } catch (e) {
        toast(e.message, true);
        b.disabled = false;
        b.textContent = "审核通过，发送";
      }
    };
  }

  function drawConvSide(g, scope) {
    const d = S.cv[scope].detail, c = d.contact;
    let window_ = "";
    if (d.window_h) {
      const left = d.last_in ? d.window_h - (Date.now() / 1000 - d.last_in) / 3600 : null;
      window_ = left === null ? `${esc(d.label)}要求客户发消息后 ${d.window_h} 小时内回复`
        : left > 0 ? `还剩 <b>${left < 1 ? "不到 1" : Math.floor(left)}</b> 小时（${esc(d.label)}限 ${d.window_h} 小时内回复）`
        : `<span class="bad-text">已超过 ${d.window_h} 小时回复时限</span>`;
    }
    $("cvSide").innerHTML = `
      <div class="cv-card"><h4>客户</h4>
        <div class="cv-contact"><b>${esc(c?.name || d.name)}</b>${c ? `<span class="tag plain">${esc(c.kind)}</span>` : ""}</div>
        <div class="cv-kv">
          ${d.email ? `<div><span>邮箱</span>${esc(d.email)}</div>` : ""}${d.phone ? `<div><span>电话</span>${esc(d.phone)}</div>` : ""}
          ${c?.company ? `<div><span>公司</span>${esc(c.company)}</div>` : ""}${c?.country ? `<div><span>国家</span>${esc(c.country)}</div>` : ""}
        </div>
        ${c ? `<button type="button" class="btn sm" id="cvCustomer">客户档案</button>` : ""}</div>
      <div class="cv-card"><h4>跟进进度 ${d.stage ? `<span class="tag warn">${esc(d.stage)}</span>` : ""}</h4>
        ${d.summary ? `<p>${esc(d.summary)}</p>` : '<p class="faint">AI 还没总结这个会话</p>'}
        ${d.next_step ? `<p class="cv-next"><span>下一步</span>${esc(d.next_step)}</p>` : ""}
        <button type="button" class="btn sm" id="cvSummary">${d.summary ? "重新总结" : "AI 总结"}</button></div>
      ${window_ ? `<div class="cv-card"><h4>回复时限</h4><p>${window_}</p></div>` : ""}
      ${d.agent ? `<div class="cv-card"><h4>AI 怎么判断的 ${d.agent.mode === "shadow" ? '<span class="tag plain">影子</span>' : ""}</h4>
        <p><span class="tag plain">${esc(d.agent.label)}${d.agent.confidence == null ? "" : ` ${Math.round(d.agent.confidence * 100)}%`}</span> → ${esc(d.agent.action_text)}</p>
        ${d.agent.reason ? `<p class="faint">${esc(d.agent.reason)}</p>` : ""}
        <button type="button" class="link" id="cvAgent">看判断过程</button></div>` : ""}
      <div class="cv-card"><h4>托管说明</h4><p class="faint">${d.outreach ? "这是我们发出的外联邮件，客户的回复由 AI 起草，在「外联」里审核后发出。"
        : d.mode === "ai" ? "AI 托管中：咨询类直接回答；报价、跟进会先起草等你审核；投诉或客户要找人会转给你。客户 20 小时没回，AI 会起草一条跟进。"
        : "人工处理中：AI 不会自动回复。处理完可以点「结束会话」，客户再来消息时按渠道默认设置重新托管。"}</p>
        <a href="#inbox" id="cvFull">在完整收件箱里打开</a></div>`;
    if ($("cvCustomer")) $("cvCustomer").onclick = () => openCustomer(c.id);
    if ($("cvAgent")) $("cvAgent").onclick = () => dialog({ title: "AI 的判断过程", body: agentRunDetail(d.agent), ok: "关闭", cancel: null, wide: true });
    $("cvFull").onclick = () => { S.cwTarget = d.chatwoot_url; };
    $("cvSummary").onclick = async () => {
      const b = $("cvSummary");
      b.disabled = true;
      b.innerHTML = '<span class="spin"></span>总结中';
      try {
        const r = await tc(`inbox/convs/${d.id}/summary`, { method: "POST" });
        if (S.cv[scope].detail !== d) return;
        Object.assign(d, { stage: r.stage, summary: r.summary, next_step: r.next_step });
        drawConvSide(g, scope);
        const item = S.cv[scope].items.find((x) => x.id === d.id);
        if (item) { item.stage = r.stage; drawConvItems(g, scope); }
      } catch (e) {
        toast(e.message, true);
        b.disabled = false;
        b.textContent = "AI 总结";
      }
    };
  }

  async function sendConvMessage(g, scope) {
    const d = S.cv[scope].detail, text = $("cvText"), b = $("cvSend"), priv = $("cvPrivate").checked;
    const content = text.value.trim();
    if (!content) return;
    b.disabled = true;
    try {
      const r = await tc(`inbox/convs/${d.id}/messages`, { method: "POST", body: { content, private: priv } });
      text.value = "";
      if (r.switched) toast("你接手了这个会话，AI 不再自动回复");
      await refreshAfterAction(g, scope);
    } catch (e) {
      toast(e.message, true);
    } finally {
      b.disabled = false;
    }
  }

  async function refreshAfterAction(g, scope) {
    await Promise.all([refreshConvDetail(g, scope), loadConvs(g, scope, { quiet: true }), refreshOverview()]);
  }

  // ---------- customers (客户) ----------

  async function renderCustomers(g) {
    const st = S.cust;
    page.innerHTML = `<div class="filters"><span id="custKinds" style="display:contents"></span>
      <input type="search" id="custQ" placeholder="搜名字、邮箱、电话、公司" value="${esc(st.q)}" style="width:240px"></div>
      <div class="card" id="custList" style="padding:0">${loading(5)}</div>`;
    $("custQ").addEventListener("input", debounce(() => { st.q = $("custQ").value.trim(); loadCustomers(g); }, 300));
    loadCustomers(g);
  }

  async function loadCustomers(g) {
    const st = S.cust;
    let d;
    try {
      d = await tc("customers?" + new URLSearchParams({ kind: st.kind, q: st.q }));
    } catch (e) {
      if (!stale(g)) $("custList").innerHTML = errorBox("客户读取失败：" + e.message, () => loadCustomers(g));
      return;
    }
    if (stale(g)) return;
    $("custKinds").innerHTML = [["", "全部", d.total]].concat(d.kinds.map((k) => [k, k, d.counts[k] || 0])).map(([k, label, n]) =>
      `<button type="button" class="chip ${k === st.kind ? "on" : ""}" data-k="${esc(k)}">${esc(label)}<span class="c">${n}</span></button>`).join("");
    $("custKinds").querySelectorAll("[data-k]").forEach((b) => b.addEventListener("click", () => { st.kind = b.dataset.k; loadCustomers(g); }));
    if (!d.items.length) {
      $("custList").innerHTML = `<div class="empty"><b>${d.total ? "没有符合条件的客户" : "还没有客户"}</b>${d.total ? "换个筛选试试"
        : "社媒和邮件里来咨询的人会自动建档；外联对象可以在「邮件 → 外联」导入"}</div>`;
      return;
    }
    $("custList").innerHTML = `<table class="t"><thead><tr><th>客户</th><th>类型</th><th>渠道</th><th>进展</th><th>状态</th><th>最近往来</th></tr></thead><tbody>
      ${d.items.map((c) => `<tr data-id="${c.id}">
        <td><b>${esc(c.name || c.email || c.phone || c.handle || "未命名")}</b>${c.company ? `<div class="faint" style="font-size:12.5px">${esc(c.company)}</div>` : ""}</td>
        <td>${esc(c.kind)}</td>
        <td>${c.channels.map((x) => `<span class="tag plain">${esc(x.label)}</span>`).join(" ")}</td>
        <td>${c.stage ? `<span class="tag warn">${esc(c.stage)}</span>` : '<span class="faint">—</span>'}${c.open ? ` <span class="tag bad">${c.open} 个待回复</span>` : ""}</td>
        <td>${esc(c.status)}</td>
        <td class="faint nowrap">${esc(ago(c.last_at || c.updated))}</td></tr>`).join("")}</tbody></table>
      ${d.items.length >= 500 ? '<p class="faint" style="padding:10px 14px;margin:0">只显示最近 500 位，用搜索找更早的客户</p>' : ""}`;
    $("custList").querySelectorAll("tr[data-id]").forEach((tr) => tr.addEventListener("click", () => openCustomer(+tr.dataset.id, () => loadCustomers(g))));
  }

  async function openCustomer(id, onSaved) {
    let d;
    try {
      d = await tc(`customers/${id}`);
    } catch (e) {
      toast(e.message, true);
      return;
    }
    const c = d.contact;
    const opt = (list, v) => list.map((x) => `<option ${x === v ? "selected" : ""}>${esc(x)}</option>`).join("");
    const kv = [["邮箱", c.email], ["电话", c.phone], ["账号", c.handle], ["公司", c.company], ["国家", c.country], ["语言", c.language],
      ["领域", c.niche], ["粉丝", c.followers ? fmtNum(c.followers) : ""], ["上次下单", c.last_order], ["来源", c.source]].filter(([, v]) => v);
    const ok = await dialog({
      title: c.name || c.email || c.phone || "客户",
      wide: true, ok: "保存", cancel: "关闭",
      body: `<div class="cust form">
        <div class="cust-info">
          <div class="cv-kv">${kv.map(([k, v]) => `<div><span>${k}</span>${esc(String(v))}</div>`).join("")}
            ${c.profile_url ? `<div><span>主页</span><a href="${esc(c.profile_url)}" target="_blank" rel="noopener">打开 ↗</a></div>` : ""}</div>
          <div class="form-row"><label>类型<select name="kind">${opt(d.kinds, c.kind)}</select></label>
            <label>状态<select name="status">${opt(d.statuses, c.status)}</select></label></div>
          <label>备注<textarea name="notes" rows="3" maxlength="2000" placeholder="比如：老客户，上次买了 200 件，偏好 DHL">${esc(c.notes || "")}</textarea></label>
        </div>
        <h4>会话</h4>
        ${d.conversations.length ? `<div class="list">${d.conversations.map((x) => `
          <a class="list-item link-row" href="#social" data-conv="${x.conv_id}" data-ch="${esc(x.channel)}"><span style="flex:1;min-width:0">
            <span class="tag plain">${esc(x.label)}</span> ${x.stage ? `<span class="tag warn">${esc(x.stage)}</span>` : ""}
            ${x.status === "resolved" ? '<span class="tag plain">已结束</span>' : x.mode === "ai" ? '<span class="tag ok">AI 托管</span>' : '<span class="tag warn">人工</span>'}
            ${x.summary ? `<div class="muted clamp" style="font-size:13px;margin-top:4px">${esc(x.summary)}</div>` : ""}</span>
            <span class="faint nowrap">${esc(x.last_text.slice(5))}</span></a>`).join("")}</div>` : '<p class="faint">还没有会话</p>'}
        ${d.outreach.length ? `<h4>外联往来</h4><div class="list">${d.outreach.map((x) => `<div class="list-item"><span style="flex:1;min-width:0">
          <span class="tag ${x.step === "对方" ? "ok" : "plain"}">${x.step === "对方" ? "对方回复" : esc(x.step)}</span> <span class="faint">${esc(x.status)}</span>
          ${x.subject ? `<b style="margin-left:6px">${esc(x.subject)}</b>` : ""}<div class="muted clamp" style="font-size:13px;margin-top:4px">${esc(x.text)}</div></span>
          <span class="faint nowrap">${esc(x.at_text.slice(5))}</span></div>`).join("")}</div>` : ""}
      </div>`,
      onOpen(el) {
        el.querySelectorAll("[data-conv]").forEach((a) => a.addEventListener("click", (e) => {
          e.preventDefault();
          $("modalCancel").click();
          openConv(+a.dataset.conv, a.dataset.ch);
        }));
      },
      submit: (el) => tc(`customers/${id}`, { method: "PUT", body: { kind: field(el, "kind"), status: field(el, "status"), notes: field(el, "notes") } }),
    });
    if (ok) { toast("已保存"); if (onSaved) onSaved(); }
  }

  // ---------- personal accounts (personal.py) ----------

  const PERSONAL_PLATFORMS = [
    ["telegram", "Telegram", "官方用户协议，稳定。要先在 my.telegram.org 申请 API ID。"],
    ["whatsapp", "WhatsApp", "社区逆向协议（Baileys），用手机扫码登录。自动回复多了可能被封号。"],
    ["instagram", "Instagram", "社区逆向协议（instagrapi），每半分钟拉一次私信。风控最严，建议用测试号。"],
    ["wecom", "企业微信", "官方接口（微信客服）。客户在微信里点客服链接或扫码就能聊；客户每发一条，48 小时内最多回 5 条。"],
    ["messenger", "Messenger", "社区逆向协议（ws3-fca）。用账号密码在服务器的浏览器里登录，或贴浏览器里导出的 cookie。Facebook 风控严，建议用测试号。"],
    ["tiktok", "TikTok", "没有可用接口，在服务器的浏览器里开 TikTok 网页版私信，用 App 扫码登录，每半分钟看一次新私信。页面改版可能要跟着调。"],
  ];
  const PERSONAL_TAG = { 在线: "ok", 待登录: "plain", 断开: "warn", 需要重新登录: "warn" };

  async function drawPersonal(g) {
    const box = $("personalCard");
    if (!box) return;
    let d;
    try { d = await tc("personal"); } catch (e) { box.innerHTML = `<p class="bad-text" style="margin:0">${esc(e.message)}</p>`; return; }
    if (stale(g) || !$("personalCard")) return;
    box.innerHTML = `
      <p class="hint" style="margin:0 0 10px">企业微信走官方的微信客服接口，国内客户用微信就能找到你们。个人号用个人账号收发私信：不用等平台审核，也不需要外网域名。登录后对方发来的私信和官方渠道一样进「会话」，AI 按托管设置回复；
        你在手机上亲自回了，那个会话自动转人工。WhatsApp、Instagram、Messenger 用的是社区逆向的协议，TikTok 是模拟网页版，平台可能限制或封号，先用不怕封的号试。</p>
      ${d.items.length ? `<table class="t static"><thead><tr><th style="width:150px">平台</th><th>备注名</th><th style="width:170px">账号</th><th style="width:120px">状态</th><th style="width:80px">对话</th><th style="width:230px"></th></tr></thead>
        <tbody>${d.items.map((a) => `<tr><td>${esc(a.label)}</td><td>${esc(a.name)}</td><td class="muted">${esc(a.handle || "—")}</td>
          <td><span class="tag ${PERSONAL_TAG[a.status] || "plain"}" title="${esc(a.error)}">${esc(a.status)}</span></td><td class="num">${fmtNum(a.peers)}</td>
          <td class="row-actions">${d.can_manage ? `<button class="btn sm" data-plogin="${a.id}">${a.platform === "wecom" ? "配置" : a.status === "在线" ? "重新登录" : "登录"}</button>
            ${a.status !== "待登录" ? `<button class="btn sm" data-plogout="${a.id}">退出</button>` : ""}<button class="btn sm" data-pdel="${a.id}">删除</button>` : ""}</td></tr>
          ${a.error && a.status !== "在线" ? `<tr class="sub"><td></td><td colspan="5" class="faint" style="font-size:12.5px">${esc(a.error)}</td></tr>` : ""}`).join("")}</tbody></table>`
        : '<p class="faint" style="margin:0">还没有个人号。</p>'}
      ${d.can_manage ? '<div class="row-actions" style="margin-top:12px"><button class="btn" id="personalAdd">添加</button></div>' : ""}`;
    const find = (id) => d.items.find((a) => String(a.id) === String(id));
    $("personalAdd")?.addEventListener("click", () => personalAdd(g));
    box.querySelectorAll("[data-plogin]").forEach((b) => b.addEventListener("click", () => personalLogin(g, find(b.dataset.plogin))));
    box.querySelectorAll("[data-plogout]").forEach((b) => b.addEventListener("click", async () => {
      const a = find(b.dataset.plogout);
      if (!(await confirmBox("退出", `<p>退出「${esc(a.name)}」后不再收发消息，已有的会话记录保留。要再用就重新${a.platform === "wecom" ? "配置" : "登录"}。</p>`, "退出"))) return;
      try { await tc(`personal/${a.id}/logout`, { method: "POST" }); toast("已退出"); } catch (e) { toast(e.message, true); }
      drawPersonal(g);
    }));
    box.querySelectorAll("[data-pdel]").forEach((b) => b.addEventListener("click", async () => {
      const a = find(b.dataset.pdel);
      if (!(await confirmBox("删除个人号", `<p>删除「${esc(a.name)}」会退出登录，并删掉它在收件箱里的全部会话记录，不能恢复。</p>`, "删除", true))) return;
      try { await tc(`personal/${a.id}`, { method: "DELETE" }); toast("已删除"); } catch (e) { toast(e.message, true); }
      drawPersonal(g);
    }));
  }

  async function personalAdd(g) {
    let platform = "telegram";
    const acc = await dialog({
      title: "添加个人号或企业微信", ok: "下一步",
      body: `<div class="seg" role="group" id="ppSeg">${PERSONAL_PLATFORMS.map(([k, label]) => `<button type="button" data-pp="${k}" class="${k === platform ? "on" : ""}">${label}</button>`).join("")}</div>
        <p class="hint" id="ppHint" style="margin:8px 0 14px">${esc(PERSONAL_PLATFORMS[0][2])}</p>
        <label class="fld"><span>备注名</span><input name="name" maxlength="40" placeholder="如：Hazel 的 WhatsApp"></label>`,
      onOpen: (el) => el.querySelectorAll("[data-pp]").forEach((b) => b.addEventListener("click", () => {
        platform = b.dataset.pp;
        el.querySelectorAll("[data-pp]").forEach((x) => x.classList.toggle("on", x === b));
        $("ppHint").textContent = PERSONAL_PLATFORMS.find((p) => p[0] === platform)[2];
      })),
      submit: async (el) => {
        const name = field(el, "name").value.trim();
        if (!name) throw new Error("填个备注名，方便区分是谁的号");
        return tc("personal", { method: "POST", body: { platform, name } });
      },
    });
    if (!acc) return;
    drawPersonal(g);
    personalLogin(g, acc);
  }

  function personalLogin(g, acc) {
    let open = true, timer = null;
    const err = (m) => { $("modalErr").textContent = m || ""; };
    const body = () => $("plBody");
    const post = async (data, btn) => {
      err("");
      if (btn) { btn.disabled = true; btn.dataset.t = btn.textContent; btn.innerHTML = `<span class="spin"></span>${esc(btn.textContent)}`; }
      try {
        return await tc(`personal/${acc.id}/login`, { method: "POST", body: data });
      } catch (e) {
        err(e.message);
        return null;
      } finally {
        if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = btn.dataset.t; }
      }
    };
    const success = (a) => {
      clearTimeout(timer);
      body().innerHTML = `<p><span class="tag ok">登录成功</span> ${esc(a.handle || "")}</p>
        <p class="hint">从现在起对方发来的私信会出现在「社媒消息 → 会话」里，渠道显示为「${esc(a.label)}」，AI 按托管设置处理。登录前的聊天记录不会导进来。</p>`;
      $("modalCancel").textContent = "完成";
    };
    let round = 0;
    const stopPoll = () => { round++; clearTimeout(timer); };
    const poll = (draw) => {
      stopPoll();
      const mine = round;
      const tick = async () => {
        if (!open || mine !== round) return;
        try {
          const a = await tc(`personal/${acc.id}`);
          if (!open || mine !== round) return;
          const done = acc.platform === "instagram" ? a.login.step !== "code" : acc.platform === "messenger" ? a.login.step === "done" : true;
          if (a.status === "在线" && done) return success(a);
          draw(a);
        } catch (e) { err(e.message); }
        timer = setTimeout(tick, 2000);
      };
      tick();
    };

    const telegram = (step = "start") => {
      if (step === "start") {
        body().innerHTML = `<ol class="hint" style="margin:0 0 12px;padding-left:18px">
            <li>用这个号的手机号登录 <a href="https://my.telegram.org/apps" target="_blank" rel="noopener">my.telegram.org</a>，进 API development tools，随便填个应用名，拿到 api_id 和 api_hash。</li>
            <li>回来填下面三项，Telegram 会把验证码发到这个号的 Telegram App 里。</li></ol>
          <div class="grid2"><label class="fld"><span>API ID</span><input name="api_id" inputmode="numeric" autocomplete="off"></label>
          <label class="fld"><span>API Hash</span><input name="api_hash" autocomplete="off"></label></div>
          <label class="fld"><span>手机号（带国家码）</span><input name="phone" placeholder="+8613800000000" autocomplete="off"></label>
          <button class="btn primary" id="plGo">获取验证码</button>`;
        $("plGo").onclick = async () => {
          const v = (n) => body().querySelector(`[name=${n}]`).value.trim();
          const r = await post({ api_id: v("api_id"), api_hash: v("api_hash"), phone: v("phone") }, $("plGo"));
          if (r) telegram("code");
        };
      } else {
        const pw = step === "password";
        body().innerHTML = `<p class="hint">${pw ? "这个号开了两步验证，填 Telegram 的云密码。" : "验证码已发到这个号的 Telegram App（不是短信），填进来。"}</p>
          <label class="fld"><span>${pw ? "两步验证密码" : "验证码"}</span><input name="v" ${pw ? 'type="password"' : 'inputmode="numeric"'} autocomplete="off"></label>
          <button class="btn primary" id="plGo">登录</button>`;
        $("plGo").onclick = async () => {
          const val = body().querySelector("[name=v]").value.trim();
          const r = await post(pw ? { password: val } : { code: val }, $("plGo"));
          if (!r) return;
          if (r.need === "password") telegram("password");
          else success(r.account);
        };
      }
      body().querySelector("input")?.focus();
    };

    const whatsapp = () => {
      body().innerHTML = `<p class="hint">在手机 WhatsApp 里打开「设置 → 已关联的设备 → 关联新设备」，扫下面的码。扫不了码的话填手机号，用配对码关联。</p>
        <label class="fld"><span>手机号（可不填，带国家码）</span><input name="phone" placeholder="+8613800000000" autocomplete="off"></label>
        <button class="btn primary" id="plGo">生成二维码</button><div id="plWa" style="margin-top:14px"></div>`;
      $("plGo").onclick = async () => {
        const phone = body().querySelector("[name=phone]").value.trim();
        const r = await post({ phone }, $("plGo"));
        if (!r) return;
        $("plGo").textContent = "重新生成";
        poll((a) => {
          const box = $("plWa");
          if (!box) return;
          const l = a.login || {};
          box.innerHTML = l.code ? `<p>在手机 WhatsApp「关联新设备 → 改用电话号码关联」里输入：</p><p class="pair-code">${esc(l.code.replace(/(.{4})/, "$1-"))}</p>`
            : l.qr ? `<img class="wa-qr" src="${l.qr}" alt="WhatsApp 登录二维码"><p class="faint" style="font-size:12.5px">二维码每 20 秒左右刷新一次，这里会自动更新。</p>`
            : l.state === "connecting" || !l.state ? `<p class="faint"><span class="spin"></span>正在连接 WhatsApp…</p>` : "";
          if (["expired", "logged_out", "closed"].includes(l.state)) {
            err(l.error || a.error || "连接断开了，点「重新生成」");
            if (l.state === "expired") { clearTimeout(timer); box.innerHTML = ""; }
          }
        });
      };
    };

    const instagram = () => {
      body().innerHTML = `<p class="hint">密码只用来这一次登录，不保存；以后靠登录后的会话文件。Instagram 可能要求填短信、邮箱或验证器里的码。</p>
        <label class="fld"><span>用户名</span><input name="username" autocomplete="off" placeholder="不带 @"></label>
        <label class="fld"><span>密码</span><input name="password" type="password" autocomplete="new-password"></label>
        <button class="btn primary" id="plGo">登录</button><div id="plIg" style="margin-top:14px"></div>`;
      $("plGo").onclick = async () => {
        const v = (n) => body().querySelector(`[name=${n}]`).value;
        const r = await post({ username: v("username").trim(), password: v("password") }, $("plGo"));
        if (!r) return;
        let asked = "";
        poll((a) => {
          const box = $("plIg"), l = a.login || {};
          if (!box) return;
          if (l.step === "code") {
            if (asked === l.prompt) return;
            asked = l.prompt;
            box.innerHTML = `<p>${esc(l.prompt)}</p><label class="fld"><span>验证码</span><input name="code" inputmode="numeric" autocomplete="off"></label>
              <button class="btn primary" id="plCode">提交</button>`;
            box.querySelector("input").focus();
            $("plCode").onclick = async () => {
              const ok = await post({ code: box.querySelector("[name=code]").value.trim() }, $("plCode"));
              if (ok) { asked = ""; box.innerHTML = '<p class="faint"><span class="spin"></span>正在登录…</p>'; }
            };
          } else if (l.step === "failed") {
            clearTimeout(timer);
            box.innerHTML = "";
            err(l.error || "登录失败");
          } else if (!asked) {
            box.innerHTML = '<p class="faint"><span class="spin"></span>正在登录 Instagram，可能要十几秒…</p>';
          }
        });
      };
    };

    const wecom = (step = "start", kfs = [], info = {}) => {
      if (step === "start") {
        body().innerHTML = `<ol class="hint" style="margin:0 0 12px;padding-left:18px">
            <li>企业微信管理后台「应用管理 → 自建 → 创建应用」，可见范围要包含接待客服的同事，记下应用的 Secret；企业 ID 在「我的企业」最下面。</li>
            <li>「微信客服 → API」：「可调用接口的应用」选这个自建应用；「通过 API 管理微信客服账号」选上要接的客服账号。</li>
            <li>应用的「企业可信 IP」要加上这台服务器的出口 IP。不知道是哪个就先点下一步，报错里会写。新建的应用要先配好「接收消息服务器 URL」才能填可信 IP。</li></ol>
          <label class="fld"><span>企业 ID（corpid）</span><input name="corpid" autocomplete="off" placeholder="ww 开头"></label>
          <label class="fld"><span>自建应用 Secret</span><input name="secret" type="password" autocomplete="new-password"></label>
          <button class="btn primary" id="plGo">下一步：选客服账号</button>`;
        $("plGo").onclick = async () => {
          const v = (n) => body().querySelector(`[name=${n}]`).value.trim();
          const r = await post({ corpid: v("corpid"), secret: v("secret") }, $("plGo"));
          if (r) wecom("kf", r.accounts, r.account.login || {});
        };
        return;
      }
      const url = info.callback_url;
      body().innerHTML = `<p class="hint">选要接 AI 的客服账号。客户找这个客服账号的消息会进「社媒消息 → 会话」，渠道显示「企业微信客服」。</p>
        <div class="kf-list">${kfs.map((k, i) => `<label class="check"><input type="radio" name="kf" value="${esc(k.open_kfid)}" ${i === 0 ? "checked" : ""}> ${esc(k.name || k.open_kfid)}</label>`).join("")}</div>
        ${url ? `<h4>接收消息（推荐）</h4>
          <p class="hint">在自建应用「接收消息 → 设置 API 接收」里填下面的 URL，Token 和 EncodingAESKey 点「随机获取」后抄到这里。<b>先在这里点完成，再回企业微信点保存</b>，企业微信保存时会来校验。不填就每 15 秒拉一次消息。</p>
          <label class="fld"><span>URL</span><input readonly value="${esc(url)}" onclick="this.select()"></label>
          <div class="grid2"><label class="fld"><span>Token</span><input name="cb_token" autocomplete="off"></label>
          <label class="fld"><span>EncodingAESKey</span><input name="cb_aes" autocomplete="off" maxlength="43"></label></div>`
          : '<p class="hint">这台服务器没有配公网地址（<code>CALLBACK_BASE_URL</code>），企业微信推不过来，改为每 15 秒拉一次消息，客户发消息后最多十几秒 AI 才看到。</p>'}
        <button class="btn primary" id="plGo">完成</button>`;
      $("plGo").onclick = async () => {
        const v = (n) => body().querySelector(`[name=${n}]`)?.value.trim() || "";
        const kf = body().querySelector("[name=kf]:checked")?.value || "";
        const r = await post({ kf_id: kf, cb_token: v("cb_token"), cb_aes: v("cb_aes") }, $("plGo"));
        if (r) success(r.account);
      };
    };

    const messenger = (how = "password") => {
      body().innerHTML = `<div class="seg" role="group" id="plHow"><button type="button" data-how="password" class="${how === "password" ? "on" : ""}">账号密码</button><button type="button" data-how="cookies" class="${how === "cookies" ? "on" : ""}">贴 cookie</button></div>
        ${how === "password" ? `<p class="hint" style="margin:8px 0 12px">服务器上的浏览器替你打开 facebook.com 登录，密码不保存。Facebook 可能要你在手机上点「是我本人」或填验证码，这里会显示它的页面截图。</p>
          <label class="fld"><span>邮箱或手机号</span><input name="email" autocomplete="off"></label>
          <label class="fld"><span>密码</span><input name="password" type="password" autocomplete="new-password"></label>
          <button class="btn primary" id="plGo">登录</button>`
        : `<p class="hint" style="margin:8px 0 12px">账号密码登录被拦时用：在自己电脑的浏览器里登录 facebook.com，用 Cookie-Editor 之类的扩展「导出 JSON」，或在开发者工具里复制请求头里的 Cookie，贴到下面。要有 c_user 和 xs 两项。</p>
          <label class="fld"><span>cookie</span><textarea name="cookies" rows="5" autocomplete="off" placeholder='[{"name":"c_user","value":"..."}, ...] 或 c_user=...; xs=...'></textarea></label>
          <button class="btn primary" id="plGo">连接</button>`}
        <div id="plFb" style="margin-top:14px"></div>`;
      body().querySelectorAll("[data-how]").forEach((b) => b.addEventListener("click", () => { stopPoll(); err(""); messenger(b.dataset.how); }));
      $("plGo").onclick = async () => {
        const v = (n) => body().querySelector(`[name=${n}]`).value;
        const r = await post(how === "password" ? { email: v("email").trim(), password: v("password") } : { cookies: v("cookies") }, $("plGo"));
        if (!r) return;
        let asked = false;
        poll((a) => {
          const box = $("plFb"), l = a.login || {};
          if (!box) return;
          const pic = l.shot ? `<img class="fb-shot" src="${l.shot}" alt="Facebook 页面截图">` : "";
          if (l.step === "code") {
            if (!asked) {
              asked = true;
              box.innerHTML = `<p>${esc(l.prompt)}</p><label class="fld"><span>验证码（在手机上点了确认就不用填）</span><input name="code" inputmode="numeric" autocomplete="off"></label>
                <button class="btn primary" id="plCode">提交</button><div id="plShot"></div>`;
              $("plCode").onclick = async () => {
                if (await post({ code: box.querySelector("[name=code]").value.trim() }, $("plCode"))) box.querySelector("[name=code]").value = "";
              };
            }
            $("plShot").innerHTML = pic;
          } else if (l.step === "failed") {
            clearTimeout(timer);
            box.innerHTML = pic;
            err(l.error || "登录失败");
          } else if (!asked) {
            box.innerHTML = `<p class="faint"><span class="spin"></span>${how === "password" ? "正在登录 Facebook，可能要半分钟…" : "正在连接 Messenger…"}</p>${pic}`;
          }
        });
      };
    };

    const tiktok = () => {
      body().innerHTML = `<p class="hint">在手机 TikTok 里点「我 → 右上角 ☰ → 扫一扫」（或首页搜索框旁的扫码），扫下面的码并确认登录。服务器上的浏览器会一直开着这个号的网页版私信。</p>
        <button class="btn primary" id="plGo">生成二维码</button><div id="plTt" style="margin-top:14px"></div>`;
      $("plGo").onclick = async () => {
        const r = await post({}, $("plGo"));
        if (!r) return;
        $("plGo").textContent = "重新生成";
        poll((a) => {
          const box = $("plTt"), l = a.login || {};
          if (!box) return;
          box.innerHTML = l.qr ? `<img class="wa-qr" src="${l.qr}" alt="TikTok 登录二维码"><p class="faint" style="font-size:12.5px">二维码过期会自动刷新，这里每两秒更新一次。</p>`
            : ["expired", "failed"].includes(l.state) ? "" : `<p class="faint"><span class="spin"></span>${l.state === "open" ? "登录成功，正在打开私信…" : "正在打开 TikTok 登录页…"}</p>`;
          if (["expired", "failed"].includes(l.state)) { clearTimeout(timer); err(l.error || "登录失败"); }
        });
      };
    };

    dialog({ title: `${acc.platform === "wecom" ? "连接" : "登录"}${acc.label}「${acc.name}」`, body: '<div id="plBody"></div>', ok: null, cancel: "关闭", onOpen: () => ({ telegram, whatsapp, instagram, wecom, messenger, tiktok })[acc.platform]() })
      .then(() => { open = false; clearTimeout(timer); drawPersonal(g); });
  }

  // ---------- AI pipeline (agent.py) ----------

  const AGENT_MODES = [
    ["off", "旧流程", "按关键词分流，知识库直接回答。"],
    ["shadow", "影子模式", "照旧流程处理客户；新流程在后台跟着判断，只记录不发，用来和旧流程对比。"],
    ["router", "新分流 + 旧回答", "用决策模型 Jev 判断客户要什么（看得懂各种语言），回答仍由知识库直接生成。"],
    ["agent", "新流程", "Jev 分流；AI 自己查资料写回复，数字和承诺逐条核对出处。核对通过的咨询、政策、问候直接发，报价和合作先起草等审核，投诉、售后和要找人的转人工。"],
  ];

  function agentRunRow(x) {
    const conf = x.confidence == null ? "" : ` ${Math.round(x.confidence * 100)}%`;
    return `<tr data-run="${x.id}"><td class="faint nowrap">${esc(x.created_text.slice(5))}</td><td><div class="clamp">${esc(x.question)}</div></td>
      <td><span class="tag plain">${esc(x.label)}${conf}</span></td>
      <td>${esc(x.action_text)}</td>${x.mode === "shadow" ? `<td class="${x.actual && x.actual !== x.action ? "bad-text" : ""}">${esc(x.actual_text)}</td>` : "<td class=\"faint\">—</td>"}
      <td class="muted"><div class="clamp">${esc(x.reason)}</div></td></tr>`;
  }

  function agentRunDetail(x) {
    const f = x.final || {};
    return `<div class="cv-kv">
        <div><span>客户</span>${esc(x.question)}</div>
        <div><span>意图</span>${esc(x.label)}${x.confidence == null ? "" : `（把握 ${Math.round(x.confidence * 100)}%）`} · ${esc(x.by)}${x.angry >= 0.5 ? ` · 生气 ${Math.round(x.angry * 100)}%` : ""}</div>
        <div><span>处理</span>${esc(x.action_text)}${x.mode === "shadow" ? `（影子模式，没执行；旧流程实际：${esc(x.actual_text)}）` : ""}</div>
        ${x.reason ? `<div><span>原因</span>${esc(x.reason)}</div>` : ""}
        ${x.notes.length ? `<div><span>备注</span>${x.notes.map(esc).join("；")}</div>` : ""}
        <div><span>耗时</span>${(x.ms / 1000).toFixed(1)} 秒</div></div>
      ${x.steps.length ? `<h4>查了什么</h4><ul class="agent-steps">${x.steps.map((st) => st.tool === "search_kb"
        ? `<li>查资料「${esc(st.query)}」${st.auto ? "（自动）" : ""}：${st.hits.length ? [...new Set(st.hits)].map(esc).join("、") : "没查到"}</li>` : "<li>看了客户档案和以前的往来</li>").join("")}</ul>` : ""}
      ${x.reply ? `<h4>AI 写的回复</h4><div class="msg-body" style="margin-bottom:8px">${esc(x.reply)}</div>
        <p class="faint" style="font-size:12.5px;margin:0">引用 ${esc((f.cites || []).join("、") || "无")} · 自评把握 ${f.confidence ?? "—"}${f.unsupported != null ? ` · Jev 判断有无依据外内容 ${Math.round(f.unsupported * 100)}%` : ""}</p>` : ""}
      ${x.checks.length ? `<h4>没通过的核对</h4><ul class="agent-steps">${x.checks.map((c) => `<li class="bad-text">${esc(c)}</li>`).join("")}</ul>` : ""}`;
  }

  async function drawAgentCard(g, d) {
    const box = $("agentCard");
    if (!box) return;
    const mode = d.agent_mode || "shadow";
    let runs = null;
    try { runs = await tc("channels/agent-runs"); } catch (e) { /* the card still shows the switch */ }
    if (stale(g) || !$("agentCard")) return;
    const cur = AGENT_MODES.find((m) => m[0] === mode) || AGENT_MODES[1];
    const sh = runs?.shadow;
    box.innerHTML = `
      <div class="agent-head"><div class="seg sm" role="group">${AGENT_MODES.map(([k, label]) =>
        `<button type="button" data-amode="${k}" class="${k === mode ? "on" : ""}">${label}</button>`).join("")}</div>
        <button type="button" class="btn sm" id="agentEval">跑分流测试</button></div>
      <p class="hint" style="margin:10px 0 0">${esc(cur[2])}</p>
      ${sh && sh.total ? `<p class="kv" style="margin-top:10px">近 7 天影子模式 <b>${sh.total}</b> 条：和旧流程处理一致 <b>${Math.round((100 * sh.agree) / sh.total)}%</b>；
        旧流程直接发、新流程会先审核或转人工的 <b>${sh.stricter}</b> 条</p>` : ""}
      <div id="agentEvalOut"></div>
      ${runs && runs.items.length ? `<h4 style="margin:16px 0 6px">最近的 AI 判断</h4>
        <table class="t"><thead><tr><th style="width:90px">时间</th><th>客户消息</th><th style="width:110px">意图</th><th style="width:90px">新流程</th><th style="width:90px">旧流程</th><th>原因</th></tr></thead>
        <tbody>${runs.items.slice(0, 30).map(agentRunRow).join("")}</tbody></table>`
        : '<p class="faint" style="margin:12px 0 0;font-size:13px">还没有 AI 判断记录。客户在社媒或邮件发来消息后，这里会列出每条的判断和处理。</p>'}`;
    box.querySelectorAll("[data-amode]").forEach((b) => b.addEventListener("click", async () => {
      if (b.dataset.amode === mode) return;
      if (!isAdmin()) { toast("只有管理员可以切换 AI 流程", true); return; }
      try {
        await tc("channels/agent", { method: "PUT", body: { mode: b.dataset.amode } });
        toast(`已切到「${AGENT_MODES.find((m) => m[0] === b.dataset.amode)[1]}」`);
        drawAgentCard(g, { ...d, agent_mode: b.dataset.amode });
      } catch (e) {
        toast(e.message, true);
      }
    }));
    box.querySelectorAll("[data-run]").forEach((tr) => tr.addEventListener("click", () => {
      const x = runs.items.find((r) => String(r.id) === tr.dataset.run);
      dialog({ title: "AI 的判断过程", body: agentRunDetail(x), ok: "关闭", cancel: null, wide: true });
    }));
    $("agentEval").onclick = async () => {
      const b = $("agentEval"), out = $("agentEvalOut");
      b.disabled = true;
      b.innerHTML = '<span class="spin"></span>测试中，十几秒';
      try {
        const r = await tc("channels/agent-eval", { method: "POST" });
        out.innerHTML = `<p class="kv" style="margin-top:12px">${r.total} 条测试消息（中、英、西、德、法、葡、日）：意图判对 <b>${r.ok}</b>，去向判对 <b>${r.path_ok}</b>；
            该转人工的 <b>${r.human_ok}/${r.human_total}</b> 条${r.human_ok === r.human_total ? "全部转了" : '<span class="bad-text">有漏的</span>'} · ${r.seconds} 秒</p>
          <details class="agent-eval"><summary>看每条的判断</summary><table class="t static"><thead><tr><th>消息</th><th style="width:100px">应该</th><th style="width:150px">判成</th><th style="width:140px">谁判的</th></tr></thead>
          <tbody>${r.rows.map((x) => `<tr><td>${esc(x.text)}</td><td>${esc(x.want_label)}</td>
            <td class="${x.ok ? "" : "bad-text"}">${x.ok ? "✓" : "✗"} ${esc(x.got_label)}${x.confidence == null ? "" : ` ${Math.round(x.confidence * 100)}%`}</td><td class="faint">${esc(x.by)}</td></tr>`).join("")}</tbody></table></details>`;
      } catch (e) {
        toast(e.message, true);
      }
      b.disabled = false;
      b.textContent = "跑分流测试";
    };
  }

  // ---------- outreach (主动跟进) ----------

  const OUT_TABS = [["待审核", "待审核"], ["待发送", "待发送"], ["待跟进", "待跟进"], ["联系人", "联系人"], ["记录", "发送记录"], ["自动", "自动运营"], ["设置", "外联要点"]];
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
      const [contacts, msgs, cfg, ap] = await Promise.all([tc("contacts"), tc("outreach"), tc("outreach-settings"), tc("autopilot")]);
      if (stale(g)) return;
      Object.assign(S.out, { contacts, msgs, cfg, ap });
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
    $("otabs").innerHTML = OUT_TABS.map(([k, label]) => `<button class="${S.out.tab === k ? "on" : ""}" data-t="${k}">${label}${k === "设置" || k === "自动" ? "" : ` <span class="faint num">${outCount(k)}</span>`}</button>`).join("");
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
    else if (tab === "自动") drawAutopilot(g, S.out.ap);
    else drawOutCfg(g);
  }

  function outHead(m) {
    return `<div class="gap-meta"><b class="o-name">${esc(m.name)}</b>${m.sim ? '<span class="tag warn">模拟</span>' : ""}${m.exp ? '<span class="tag warn">体验</span>' : ""}${m.handle ? `<span class="num">@${esc(m.handle)}</span>` : ""}
      <span class="tag plain">${esc(m.kind)}</span>${m.country || m.language ? `<span>${esc([m.country, m.language].filter(Boolean).join(" · "))}</span>` : ""}
      ${m.channel === "email" ? `<span class="tag plain">邮件</span><span class="num">${esc(m.email)}</span>` : ""}
      <span class="tag plain">${esc(m.scenario)} · ${esc(m.step)}</span><span>${esc(m.time_text)}</span>${m.approved_by === "自动运营" || m.created_by === "自动运营" ? '<span class="tag warn">自动运营</span>' : ""}
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
    const mail = m.channel === "email";
    const sendBtns = m.sim || m.exp ? `<button class="btn sm primary" data-a="sent">${m.exp ? "发到体验页" : "模拟发出"}</button>`
      : mail ? '<button class="btn sm primary" data-a="sent">立即发送</button>'
      : '<button class="btn sm" data-a="open">复制并打开 TikTok</button><button class="btn sm primary" data-a="sent">我已发出</button>';
    return `<div class="card gap" data-id="${m.id}">${outHead(m)}
      <div class="draft">${mail ? `<input data-k="subject" class="o-subject" maxlength="150" value="${esc(m.subject)}" placeholder="邮件主题" aria-label="邮件主题">` : ""}
        <textarea data-k="text" rows="${mail ? 7 : 5}" maxlength="2000">${esc(m.text)}</textarea>
        <div class="o-note"><span class="num cnt">${m.text.length} 字</span>${m.note ? `<span>AI 说明：${esc(m.note)}</span>` : ""}</div></div>
      <div class="gap-actions">${ready ? `<span class="faint" style="font-size:12.5px">${esc(m.approved_by)} 已审核通过</span>` : ""}<span class="grow"></span>
        ${ready ? `<button class="btn sm ghost" data-a="reject">撤回</button>${sendBtns}`
          : `<button class="btn sm ghost" data-a="reject">不发</button><button class="btn sm" data-a="redraft">重新起草</button><button class="btn sm primary" data-a="approve">${mail ? "通过并发送" : "通过"}</button>`}
      </div></div>`;
  }

  function drawOutQueue(g, tab) {
    const list = S.out.msgs.filter((m) => (tab === "待审核" ? ["生成中", "待审核", "失败"] : ["待发送"]).includes(m.status));
    if (!list.length) {
      $("obody").innerHTML = tab === "待审核"
        ? '<div class="card empty"><b>没有待审核的私信</b>到「联系人」勾选达人或客户，点「AI 起草私信」；对方回复后在「往来记录」里贴进来，AI 会起草回复</div>'
        : '<div class="card empty"><b>没有待发送的私信</b>审核通过的私信会到这里，复制到 TikTok 发出后点「我已发出」；邮件通过后直接发出，不经过这里</div>';
      return;
    }
    $("obody").innerHTML = `<p class="legend">${tab === "待审核" ? "AI 起草的消息要人工看过才能发。可以直接改文字，改完点「通过」；邮件点「通过并发送」会马上从你的邮箱发出。"
      : "TikTok 私信：点「复制并打开 TikTok」，在 TikTok 里粘贴发出后回来点「我已发出」，系统会按设置的天数提醒跟进。邮件在这里说明上次没发出去，检查邮箱设置后点「立即发送」。"}</p>${list.map(outCard).join("")}`;
    $("obody").querySelectorAll(".gap[data-id]").forEach((card) => bindOutCard(card, g));
  }

  function bindOutCard(card, g) {
    const m = S.out.msgs.find((x) => x.id === Number(card.dataset.id));
    const ta = card.querySelector('[data-k="text"]');
    const subj = card.querySelector('[data-k="subject"]');
    if (ta) {
      ta.addEventListener("input", () => { ta.classList.add("dirty"); card.querySelector(".cnt").textContent = `${ta.value.length} 字`; });
    }
    subj?.addEventListener("input", () => subj.classList.add("dirty"));
    const save = async () => {
      if (!ta || !(ta.classList.contains("dirty") || subj?.classList.contains("dirty"))) return;
      if (!ta.value.trim()) throw new Error("消息不能为空");
      if (subj && !subj.value.trim()) throw new Error("邮件主题不能为空");
      Object.assign(m, await tc(`outreach/${m.id}`, { method: "PUT", body: subj ? { text: ta.value, subject: subj.value } : { text: ta.value } }));
      ta.classList.remove("dirty");
      subj?.classList.remove("dirty");
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
        const r = await tc(`outreach/${m.id}/${a}`, { method: "POST" });
        const days = S.out.cfg?.followup_days?.[m.scenario];
        const mailed = m.channel === "email" && r.status === "已发送";
        const sentMsg = m.exp ? "已发到体验页" : m.sim ? "已模拟发出，对方正在回复…" : mailed ? `邮件已发出${days ? `，${days} 天后没回复会提醒跟进` : ""}`
          : days ? `已记录，${days} 天后没回复会提醒跟进` : "已记录发送";
        toast({ approve: mailed ? sentMsg : "已通过，到「待发送」里发出", reject: "这条不发了", redraft: "正在重新起草", sent: sentMsg }[a]);
        refreshOverview();
        loadOutreach(g);
      } catch (e) {
        toast(e.message, true);
        if (e.status === 502) loadOutreach(g);
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
      && (!q || [c.name, c.handle, c.email, c.country, c.niche, c.company, c.notes, c.source].join(" ").toLowerCase().includes(q)));
    if (o.sort === "score") rows.sort((a, b) => (b.score ?? -2) - (a.score ?? -2));
    const minScore = S.out.ap?.pilot?.min_score ?? 70;
    const scoreCell = (c) => c.score == null ? '<span class="faint">—</span>'
      : c.score < 0 ? '<span class="tag bad" title="评分失败，点「AI 评分」重试">失败</span>'
      : `<span class="tag ${c.score >= minScore ? "ok" : "plain"} num" title="${esc(c.score_reason)}">${c.score}</span>`;
    [...o.picked].forEach((id) => { if (!all.some((c) => c.id === id)) o.picked.delete(id); });
    $("obody").innerHTML = `
      <div class="filters">
        <button class="chip ${!o.kind ? "on" : ""}" data-kind="">全部<span class="c">${all.length}</span></button>
        ${OUT_KINDS.map((k) => `<button class="chip ${o.kind === k ? "on" : ""}" data-kind="${k}">${k}<span class="c">${all.filter((c) => c.kind === k).length}</span></button>`).join("")}
        <select id="ostatus"><option value="">全部状态</option>${OUT_STATUS.map((s) => `<option ${o.status === s ? "selected" : ""}>${s}</option>`).join("")}</select>
        <input id="osearch" placeholder="搜称呼、账号、邮箱、国家、领域" value="${esc(o.search)}">
        <select id="osort"><option value="">按更新时间</option><option value="score" ${o.sort === "score" ? "selected" : ""}>按评分从高到低</option></select>
      </div>
      <div class="o-bar"><label class="check-all"><input type="checkbox" id="oall"> 全选当前 ${rows.length} 位</label><span class="muted" id="opicked"></span><span class="grow"></span>
        <button class="btn sm" id="oscore" title="按「自动运营」里的达人画像打 0–100 分；不勾选就给所有没打分的达人打">AI 评分</button>
        <select id="oscen"><option value="">场景：按类型自动选</option>${OUT_SCENARIOS.map((s) => `<option>${s}</option>`).join("")}</select>
        <button class="btn primary sm" id="ogen">AI 起草私信</button></div>
      ${rows.length ? `<table class="t"><thead><tr><th style="width:34px"></th><th style="width:190px">联系人</th><th style="width:64px">评分</th><th style="width:72px">类型</th><th style="width:110px">国家 · 语言</th>
        <th style="width:80px">粉丝</th><th>领域 / 最近订单</th><th style="width:84px">状态</th><th style="width:220px">最近往来</th></tr></thead>
        <tbody>${rows.map((c) => `<tr data-c="${c.id}" class="${o.picked.has(c.id) ? "sel" : ""}"><td><input type="checkbox" data-pick="${c.id}" ${o.picked.has(c.id) ? "checked" : ""}></td>
          <td><b>${esc(c.name)}</b>${c.sim ? ' <span class="tag warn">模拟</span>' : ""}${c.exp ? ' <span class="tag warn">体验</span>' : ""}${c.handle ? `<div class="faint num">@${esc(c.handle)}</div>` : ""}${c.email ? `<div class="faint num">${esc(c.email)}</div>` : ""}${c.company ? `<div class="faint">${esc(c.company)}</div>` : ""}</td>
          <td>${scoreCell(c)}</td><td>${esc(c.kind)}${c.source ? `<div class="faint" style="font-size:12px">${esc(c.source)}</div>` : ""}</td><td>${esc([c.country, c.language].filter(Boolean).join(" · ") || "—")}</td>
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
    $("osort").addEventListener("change", (e) => { o.sort = e.target.value; drawContacts(g); });
    $("oscore").addEventListener("click", async (e) => {
      const b = e.currentTarget;
      b.disabled = true;
      b.innerHTML = '<span class="spin"></span>评分中…';
      try {
        const r = await tc("contacts/score", { method: "POST", body: { contact_ids: [...o.picked] } });
        if (r.scored) o.sort = "score";
        toast(r.scored ? `打完 ${r.scored} 位，已按评分排序` : "没有要打分的达人：不勾选时只给还没分数的达人打，每次最多 20 位");
        o.picked.clear();
        if (!stale(g)) loadOutreach(g);
      } catch (err) {
        toast(err.message, true);
        b.disabled = false;
        b.textContent = "AI 评分";
      }
    });
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

  const MAIL_PRESETS = {
    aliyun: ["阿里企业邮箱", "smtp.qiye.aliyun.com", 465, "imap.qiye.aliyun.com", 993],
    tencent: ["腾讯企业邮", "smtp.exmail.qq.com", 465, "imap.exmail.qq.com", 993],
    netease: ["网易企业邮箱", "smtphz.qiye.163.com", 465, "imaphz.qiye.163.com", 993],
    gmail: ["Google Workspace / Gmail", "smtp.gmail.com", 465, "imap.gmail.com", 993],
    outlook: ["Microsoft 365 / Outlook", "smtp.office365.com", 587, "outlook.office365.com", 993],
  };

  async function drawAutopilot(g, view) {
    if (!view) {
      $("obody").innerHTML = loading(5);
      try {
        view = await tc("autopilot");
      } catch (e) {
        if (!stale(g)) $("obody").innerHTML = errorBox("读取失败：" + e.message, () => drawAutopilot(g));
        return;
      }
    }
    if (stale(g) || S.out.tab !== "自动") return;
    S.out.ap = view;
    if (view.inboxes) S.out.mailInboxes = view.inboxes;
    const boxes = S.out.mailInboxes || [];
    const { profile: pf, pilot: p, mail: ml, today: td, creators: cr, funnel, reviewed: rv } = view;
    const on = p.enabled;
    const every = view.interval ? `每 ${Math.max(1, Math.round(view.interval / 60))} 分钟跑一轮` : "服务器没开定时调度，只能手动「立即运行一次」";
    const ratio = rv.total ? Math.round((rv.as_is / rv.total) * 100) : 0;
    const advice = rv.total < 20 ? `人工审核满 20 条后再考虑放权（现在 ${rv.total} 条）`
      : ratio >= 80 ? `最近 ${rv.total} 条里 ${ratio}% 原样通过，可以考虑切到「自动发送」`
      : `最近 ${rv.total} 条里只有 ${ratio}% 原样通过，建议先改「外联要点」和达人画像，继续审核`;
    const num = (name, label, v, min, max, hint = "") => `<label>${label}<input type="number" name="${name}" min="${min}" max="${max}" value="${v}">${hint ? `<span class="faint hint">${hint}</span>` : ""}</label>`;
    const txt = (name, label, v, ph = "", max = 200, type = "text") => `<label>${label}<input type="${type}" name="${name}" maxlength="${max}" value="${esc(v ?? "")}" placeholder="${esc(ph)}"></label>`;
    $("obody").innerHTML = `
      <div class="card o-pilot ${on ? "on" : ""}">
        <div><b>${on ? "自动运营已开启" : "自动运营已关闭"}</b><span class="tag ${on ? (p.mode === "auto" ? "warn" : "ok") : "plain"}">${p.mode === "auto" ? "自动发送" : "审核后发送"}</span>
          <span class="tag ${ml.ready ? "ok" : "bad"}">${ml.ready ? "邮箱已配好" : "邮箱没配好"}</span></div>
        <p class="faint hint">${on ? every : "打开后，系统会按下面的设置给新达人打分、给高分达人写建联邮件、到期写跟进、收邮件回复并起草回复。"}
          ${!ml.ready ? "邮箱没配好时只起草不发送，起草的消息要你复制到 TikTok 手动发。" : ""}
          需要谈价格、佣金、合同或对方投诉的消息，无论哪种模式都会留给人工。</p>
        <div class="o-bar" style="margin:6px 0 0"><button class="btn sm ${on ? "" : "primary"}" id="aptoggle">${on ? "关闭自动运营" : "打开自动运营"}</button>
          <button class="btn sm" id="aprun">立即运行一次</button><span class="grow"></span>
          ${td.review ? `<button class="link" id="apreview">${td.review} 条等你审核 →</button>` : ""}</div>
      </div>
      <div class="grid four section">
        <div class="card stat"><span>今天新建联</span><b>${td.new}</b><span>上限 ${p.daily_new} 位</span></div>
        <div class="card stat"><span>今天发出</span><b>${td.sent}</b><span>建联、跟进和回复</span></div>
        <div class="card stat"><span>今天收到回复</span><b>${td.replies}</b><span>邮件自动收取</span></div>
        <div class="card stat"><span>等你审核</span><b>${td.review}</b><span>${p.mode === "auto" ? "只剩需要人工的" : "全部要人工看"}</span></div>
      </div>
      <div class="grid two section">
        <div class="card"><div class="card-head"><h3>达人名单</h3><span class="faint num">共 ${cr.total} 位</span></div>
          <div class="kv"><span>有邮箱 <b>${cr.with_email}</b></span><span>待评分 <b>${cr.unscored}</b></span><span>${p.min_score} 分以上 <b>${cr.qualified}</b></span></div>
          <div class="kv" style="margin-top:8px">${Object.entries(funnel).map(([k, v]) => `<span>${esc(k)} <b>${v}</b></span>`).join("")}</div>
          <p class="faint hint" style="margin-top:8px">只联系有邮箱、评分达标、状态是「未联系」的达人。名单从 FastMoss、Kalodata 导出后在「联系人」里导入。</p></div>
        <div class="card"><div class="card-head"><h3>放权参考</h3><span class="faint num">最近 ${rv.total} 条人工审核</span></div>
          <div class="kv"><span>原样通过 <b>${rv.as_is}</b></span><span>改过再发 <b>${rv.edited}</b></span><span>不发 <b>${rv.rejected}</b></span></div>
          <p class="hint" style="margin-top:8px">${esc(advice)}</p></div>
      </div>
      <form class="card form settings-form section" id="apform" style="max-width:860px">
        <h3>运行方式</h3>
        <div class="form-row">
          <label>发送方式<select name="mode"><option value="review" ${p.mode === "review" ? "selected" : ""}>审核后发送：AI 起草，人工通过才发</option>
            <option value="auto" ${p.mode === "auto" ? "selected" : ""}>自动发送：不需要人工的直接发</option></select></label>
          ${num("min_score", "评分达到多少才联系", p.min_score, 0, 100)}${num("daily_new", "每天最多新联系几位", p.daily_new, 1, 200, "新邮箱建议从 10–20 起步")}
        </div>
        <label class="check"><input type="checkbox" name="tiktok" ${p.tiktok ? "checked" : ""}> 没有邮箱的达人也起草 TikTok 私信（要你手动复制发出）</label>
        <h3>达人画像 <span class="faint hint">AI 按这个给达人打 0–100 分；改了以后，还没联系的达人会重新打分</span></h3>
        <div class="form-row">${txt("countries", "目标国家", pf.countries, "如：美国、加拿大、德国、澳大利亚", 300)}${txt("niches", "目标领域", pf.niches, "如：露营、房车、户外、宠物", 300)}</div>
        <div class="form-row">${num("followers_min", "粉丝下限", pf.followers_min, 0, 100000000, "0 是不限")}${num("followers_max", "粉丝上限", pf.followers_max, 0, 1000000000, "0 是不限")}</div>
        <label>补充要求<textarea name="pnotes" rows="2" maxlength="1000" placeholder="如：优先近 30 天有带货数据的；不要美妆、游戏类">${esc(pf.notes)}</textarea></label>
        <h3>发信方式</h3>
        <div class="form-row"><label>怎么发<select name="via">
            <option value="smtp" ${ml.via !== "chatwoot" ? "selected" : ""}>用下面的邮箱直接发，回复用 IMAP 收</option>
            <option value="chatwoot" ${ml.via === "chatwoot" ? "selected" : ""} ${boxes.length ? "" : "disabled"}>用「社媒消息」里接入的邮件收件箱发${boxes.length ? "" : "（还没接入）"}</option></select></label>
          <label id="apinbox">邮件收件箱<select name="inbox_id">${boxes.map((b) => `<option value="${b.id}" ${b.id === ml.inbox_id ? "selected" : ""}>${esc(b.name)}${b.email ? ` · ${esc(b.email)}` : ""}</option>`).join("")}</select></label></div>
        <p class="faint hint" id="apviahint"></p>
        <div id="apsmtp" class="ap-smtp">
        <h3>发信邮箱 <span class="faint hint">用公司的企业邮箱发和收；建议单独开一个外联专用邮箱</span></h3>
        <div class="form-row"><label>常用邮箱<select id="apreset"><option value="">选一个自动填服务器</option>${Object.entries(MAIL_PRESETS).map(([k, v]) => `<option value="${k}">${v[0]}</option>`).join("")}</select></label>
          ${txt("from_name", "发件人名称", ml.from_name, "如：Hazel · HAFYOUNG", 80)}</div>
        <div class="form-row">${txt("address", "发信邮箱", ml.address, "如：hazel@hafyoung.com", 200, "email")}${txt("username", "登录账号", ml.username, "不填就用发信邮箱", 200)}
          <label>密码 / 授权码<input type="password" name="password" maxlength="300" autocomplete="new-password" placeholder="${ml.has_password ? "已保存，不改就留空" : "企业邮箱一般要用授权码"}"></label></div>
        <div class="form-row">${txt("smtp_host", "SMTP 服务器", ml.smtp_host, "如：smtp.qiye.aliyun.com")}${num("smtp_port", "SMTP 端口", ml.smtp_port, 1, 65535)}
          ${txt("imap_host", "IMAP 服务器", ml.imap_host, "收回复用；如：imap.qiye.aliyun.com")}${num("imap_port", "IMAP 端口", ml.imap_port, 1, 65535)}</div>
        </div>
        <label>公司地址（写在邮件末尾）<input name="postal" maxlength="300" value="${esc(ml.postal)}" placeholder="如：Foshan, Guangdong, China"><span class="faint hint">美国、欧盟的营销邮件规定要有发件方地址和退订说明；退订说明系统会自动加</span></label>
        <div class="form-actions" style="display:flex;gap:8px"><button class="btn primary" type="submit">保存</button><button class="btn" type="button" id="apcheck">测试邮箱</button>
          ${ml.has_password ? '<button class="btn ghost" type="button" id="apclear">清除密码</button>' : ""}</div>
      </form>
      <div class="section"><h2>运行记录</h2><div class="card">${view.events.length ? `<div class="list">${view.events.map((e) => `<div class="list-item"><span class="faint num" style="width:92px;flex:none">${esc(e.time_text.slice(5))}</span>
        <span class="tag plain" style="flex:none">${esc(e.kind)}</span><span>${esc(e.text)}</span></div>`).join("")}</div>` : '<div class="faint">还没有运行记录</div>'}</div></div>`;

    const form = $("apform");
    form.addEventListener("input", () => form.classList.add("dirty"));
    const syncVia = () => {
      const inbox = field(form, "via") === "chatwoot";
      $("apsmtp").hidden = inbox;
      $("apinbox").hidden = !inbox;
      $("apviahint").textContent = inbox
        ? "外联邮件从这个收件箱发出，每位达人一个会话；对方回复后 AI 起草回复，在「待审核」里等你通过。收件箱的 IMAP、SMTP 在完整收件箱的收件箱设置里配。"
        : boxes.length ? "也可以改用「社媒消息」里接入的邮件收件箱发，往来邮件能在「邮件 → 收件」里看到。" : "";
    };
    form.querySelector('[name="via"]').addEventListener("change", syncVia);
    syncVia();
    const body = (patch = {}) => ({
      pilot: { enabled: on, mode: field(form, "mode"), min_score: Number(field(form, "min_score") || 0), daily_new: Number(field(form, "daily_new") || 1), tiktok: field(form, "tiktok"), ...patch },
      profile: { countries: field(form, "countries"), niches: field(form, "niches"), followers_min: Number(field(form, "followers_min") || 0),
        followers_max: Number(field(form, "followers_max") || 0), notes: field(form, "pnotes") },
      mail: Object.fromEntries(["via", "from_name", "address", "username", "smtp_host", "imap_host", "postal", "password"].map((k) => [k, field(form, k)])
        .concat([["smtp_port", Number(field(form, "smtp_port") || 465)], ["imap_port", Number(field(form, "imap_port") || 993)],
          ["inbox_id", Number(field(form, "inbox_id") || 0)]])),
    });
    const save = async (b, msg) => {
      const v = await tc("autopilot", { method: "PUT", body: b });
      toast(msg);
      drawAutopilot(g, v);
      return v;
    };
    const busy = (btn, label) => { btn.disabled = true; btn.innerHTML = `<span class="spin"></span>${label}`; };
    $("apreset").addEventListener("change", (e) => {
      const v = MAIL_PRESETS[e.target.value];
      if (!v) return;
      [["smtp_host", v[1]], ["smtp_port", v[2]], ["imap_host", v[3]], ["imap_port", v[4]]].forEach(([k, x]) => { form.querySelector(`[name="${k}"]`).value = x; });
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const b = body();
      if (on && b.pilot.mode === "auto" && p.mode !== "auto" && !(await confirmAuto())) return;
      try { await save(b, "已保存"); } catch (err) { toast(err.message, true); }
    });
    $("aptoggle").addEventListener("click", async (e) => {
      const b = body({ enabled: !on });
      if (!on && b.pilot.mode === "auto" && !(await confirmAuto())) return;
      busy(e.currentTarget, on ? "关闭中…" : "打开中…");
      try { await save(b, on ? "自动运营已关闭，已起草的消息还在「待审核」里" : `自动运营已打开，${view.interval ? "几分钟内会跑第一轮" : "点「立即运行一次」开始"}`); }
      catch (err) { toast(err.message, true); drawAutopilot(g, view); }
    });
    $("aprun").addEventListener("click", async (e) => {
      busy(e.currentTarget, "运行中，打分和起草要一两分钟…");
      try { const v = await tc("autopilot/run", { method: "POST" }); toast("这一轮跑完了，看下面的运行记录"); refreshOverview(); drawAutopilot(g, v); }
      catch (err) { toast(err.message, true); drawAutopilot(g, view); }
    });
    $("apcheck").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      busy(btn, "正在登录邮箱，最多半分钟…");
      try {
        const v = await tc("autopilot", { method: "PUT", body: body() });
        const r = await tc("autopilot/check-mail", { method: "POST" });
        if (r.ok) toast("发信和收信都连上了");
        else await dialog({ title: "邮箱有问题", cancel: null, ok: "知道了", body: `<ul class="o-skip">${r.problems.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` });
        drawAutopilot(g, v);
      } catch (err) {
        toast(err.message, true);
        btn.disabled = false;
        btn.textContent = "测试邮箱";
      }
    });
    $("apclear")?.addEventListener("click", async () => {
      if (!(await confirmBox("清除邮箱密码？", "<p>清除后不能再自动发邮件和收回复。</p>", "清除", true))) return;
      try { await save({ ...body(), mail: { ...body().mail, password: "", clear_password: true } }, "密码已清除"); } catch (err) { toast(err.message, true); }
    });
    $("apreview")?.addEventListener("click", () => { S.out.tab = "待审核"; drawOutreach(g); });

    function confirmAuto() {
      return confirmBox("切到自动发送？", `<p>不需要人工的邮件（建联、跟进、普通回复）会直接从你的邮箱发出，不再等你通过。涉及价格、佣金、合同、投诉的仍然留给人工。</p>
        <p class="faint">${esc(advice)}。</p>`, "切到自动发送");
    }
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
      <div class="form-row">${inp("handle", "TikTok 账号", "如：@mia.camps")}${inp("profile_url", "主页链接", "不填就按账号生成", 300)}${inp("email", "邮箱", "有邮箱就能自动发邮件", 200)}</div>
      <div class="form-row">${inp("country", "国家", "如：美国", 60)}${inp("language", "语言", "如：英语", 30)}<label>粉丝数<input name="followers" value="${c.followers || ""}" placeholder="如：12.5k"></label></div>
      <div class="form-row">${inp("niche", "领域 / 品类", "如：露营、房车")}${inp("company", "公司", "B 端客户填")}</div>
      <label>最近订单<input name="last_order" maxlength="1000" value="${esc(c.last_order || "")}" placeholder="如：2026-05 ROG-1 × 200 台"></label>
      <label>备注<textarea name="notes" rows="2" maxlength="1000" placeholder="AI 起草时会参考，如：做过竞品测评、偏好视频合作">${esc(c.notes || "")}</textarea></label></div>`;
  }

  const contactBody = (el) => Object.fromEntries(["kind", "name", "status", "handle", "profile_url", "email", "country", "language", "followers", "niche", "company", "last_order", "notes"].map((k) => [k, field(el, k)]));

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
    fp.accept = ".xlsx,.csv";
    fp.multiple = false;
    fp.value = "";
    fp.onchange = async () => {
      const f = fp.files[0];
      if (!f) return;
      const form = new FormData();
      form.append("file", f);
      try {
        const r = await upload("api/console/contacts/import", form, { headers: { "X-Tenant": S.tenant } });
        const msg = [r.source && `${r.source} 名单`, r.added && `新增 ${r.added} 位`, r.updated && `更新 ${r.updated} 位`, r.skipped && `跳过 ${r.skipped} 行（类型或称呼不对）`,
          r.extra?.length && `另外 ${r.extra.length} 列数据（${r.extra.slice(0, 3).join("、")}${r.extra.length > 3 ? "等" : ""}）评分时会参考`].filter(Boolean).join("，");
        toast(r.added || r.updated ? msg : "没有导入任何联系人：表头要有称呼或账号，可以对照名单模板", !(r.added || r.updated));
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
      return `<div class="o-msg ${mine ? "out" : "in"}"><div class="o-meta">${mine ? `我方 · ${esc(m.scenario)} · ${esc(m.step)}` : "对方"} · ${m.channel === "email" ? "邮件 · " : ""}${esc(m.time_text)} ${tag}</div>
        ${m.channel === "email" && m.subject ? `<div class="o-meta"><b>${esc(m.subject)}</b></div>` : ""}
        <div class="o-text">${esc(m.text || (m.status === "生成中" ? (mine ? "AI 正在起草…" : "对方正在输入…") : ""))}</div></div>`;
    };
    const sent = shown.filter((m) => m.status === "已发送" || m.status === "已收到");
    const waiting = (c.sim || c.inbox_url) && c.followup_at && sent.length && sent[sent.length - 1].step !== "对方";
    const ok = await dialog({
      title: `${c.name}${c.handle ? " · @" + c.handle : ""}${c.sim ? "（模拟）" : ""}`, wide: true, ok: "录入回复", cancel: "关闭",
      body: `<div class="gap-meta" style="margin-bottom:10px"><span class="tag plain">${esc(c.kind)}</span><span class="tag ${OUT_STATUS_TAG[c.status] || "plain"}">${esc(c.status)}</span>
          ${esc([c.country, c.language, c.followers ? fmtNum(c.followers) + " 粉丝" : "", c.niche, c.company, c.email].filter(Boolean).join(" · "))}
          <span class="grow"></span>${c.profile_url ? `<a href="${esc(c.profile_url)}" target="_blank" rel="noopener">打开 TikTok 主页 ↗</a>` : ""}
          ${c.inbox_url ? `<a href="${esc(c.inbox_url)}" target="_blank" rel="noopener">打开体验页 ↗</a>` : ""}
          ${waiting ? '<button type="button" class="link" data-x="skip">快进到跟进日</button>' : ""}
          <button type="button" class="link" data-x="edit">编辑资料</button><button type="button" class="link danger" data-x="del">删除</button></div>
        ${c.last_order || c.notes ? `<div class="gap-bot" style="margin-bottom:10px">${esc([c.last_order && "最近订单：" + c.last_order, c.notes && "备注：" + c.notes].filter(Boolean).join("　"))}</div>` : ""}
        ${c.score != null ? `<div class="gap-bot" style="margin-bottom:10px">AI 评分 <b class="num">${c.score < 0 ? "失败" : c.score}</b>　${esc(c.score_reason)}</div>` : ""}
        ${Object.keys(c.metrics || {}).length ? `<div class="kv" style="margin-bottom:10px">${Object.entries(c.metrics).map(([k, v]) => `<span>${esc(k)} <b>${esc(String(v))}</b></span>`).join("")}</div>` : ""}
        <div class="o-thread">${shown.length ? shown.map(bubble).join("") : '<div class="faint" style="text-align:center;padding:18px 0">还没有往来</div>'}</div>
        <div class="form" style="margin-top:12px">
          <label><span>对方的回复 <span class="faint">${c.email && S.out.ap?.mail?.ready ? "邮件回复会自动收进来；TikTok 或其他渠道的回复原文粘贴到这里" : "从 TikTok 复制过来，原文粘贴"}</span></span><textarea name="reply" rows="3" maxlength="4000"></textarea></label>
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

  const pickContact = (c) => Object.fromEntries(["kind", "name", "status", "handle", "profile_url", "email", "country", "language", "followers", "niche", "company", "last_order", "notes"].map((k) => [k, c[k] ?? ""]));

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

  // ---------- video (video.py) ----------

  const VID_KIND = { scene: "场景广告", avatar: "数字人口播" };
  const VID_TAG = { 写脚本中: "warn", 出分镜中: "warn", 生成中: "warn", 合成中: "warn", 脚本: "plain", 分镜: "plain", 有失败: "bad", 出错: "bad",
    待审核: "warn", 已通过: "ok", 打回: "bad" };
  const VID_BUSY = ["写脚本中", "出分镜中", "生成中", "合成中"];
  const SHOT_TAG = { 排队: "plain", 生成中: "warn", 完成: "ok", 失败: "bad" };
  const PLATFORMS = ["TikTok", "Instagram Reels", "YouTube Shorts", "YouTube", "阿里国际站"];
  const REVIEW_ITEMS = [["product", "产品外形、颜色、按钮、出风口、Logo、配件数量和实物照片一致"], ["facts", "台词和字幕里的参数和资料一致，没有遗留的标红说法"],
    ["consent", "出镜的人有授权记录（数字人形象写了授权）"], ["label", "有 AI 标识，字幕没有错字，结尾联系方式正确"]];
  const usd = (n) => "$" + Number(n || 0).toFixed(2);
  const vfile = (pid, name, dl) => fileUrl(`video/projects/${pid}/files/${name}`) + (dl ? "&dl=1" : "");
  const afile = (id, thumb) => fileUrl(`video/assets/${id}/file`) + (thumb ? "&thumb=1" : "");
  let vidTimer = null;

  async function videoCfg(force) {
    if (!S.vid.cfg || force) S.vid.cfg = await tc("video/config");
    return S.vid.cfg;
  }

  async function renderVideos(g) {
    clearTimeout(vidTimer);
    if (S.vid.cur) return drawVideo(g, S.vid.cur);
    actions.innerHTML = `<button class="btn primary" id="vidNew">新建视频</button>`;
    $("vidNew").addEventListener("click", () => newVideo(g));
    page.innerHTML = loading(4);
    let d;
    try { d = await tc("video/projects"); } catch (e) {
      if (!stale(g)) page.innerHTML = errorBox("视频读取失败：" + e.message, () => renderVideos(g));
      return;
    }
    if (stale(g)) return;
    const bar = `<p class="hint" style="margin:0 0 12px">本月视频生成已花 <b>${usd(d.spent)}</b>，预算 ${usd(d.budget)}。脚本和分镜只花几分钱的大模型费用，点「开始生成」前会先报价。</p>`;
    if (!d.items.length) {
      page.innerHTML = bar + `<div class="card empty"><b>还没有视频</b>先到「素材库」上传产品实物照片（产品近景只能用实物），再新建一条：选产品、市场和语言，AI 写带出处的脚本、排分镜，确认报价后生成镜头、自动合成。
        <div style="margin-top:14px;display:flex;gap:8px;justify-content:center"><a class="btn" href="#vassets">去素材库</a><button class="btn primary" data-go="new">新建视频</button></div></div>`;
      page.querySelector('[data-go="new"]').addEventListener("click", () => newVideo(g));
      return;
    }
    page.innerHTML = bar + `<div class="card" style="padding:0"><table class="t"><thead><tr><th>视频</th><th style="width:110px">类型</th><th style="width:150px">语言 · 画幅</th>
      <th style="width:100px">状态</th><th style="width:80px">花费</th><th style="width:120px">更新</th></tr></thead><tbody>
      ${d.items.map((p) => `<tr data-id="${p.id}"><td><b>${esc(p.title || p.product || "未命名")}</b><div class="faint" style="font-size:12.5px">${esc(p.product)} · ${esc(p.created_name)}</div></td>
        <td>${VID_KIND[p.kind] || p.kind}</td><td class="muted">${esc(p.lang)} · ${esc(p.aspect)} · ${p.seconds} 秒</td>
        <td><span class="tag ${VID_TAG[p.status] || "plain"}">${esc(p.status)}</span></td><td class="num">${usd(p.cost)}</td><td class="faint nowrap">${esc(ago(p.updated))}</td></tr>`).join("")}
      </tbody></table></div>`;
    page.querySelectorAll("tr[data-id]").forEach((tr) => tr.addEventListener("click", () => { S.vid.cur = +tr.dataset.id; renderVideos(g); }));
    if (d.items.some((p) => VID_BUSY.includes(p.status))) vidTimer = setTimeout(() => { if (!stale(g) && S.current === "videos" && !S.vid.cur) renderVideos(g); }, 6000);
  }

  async function newVideo(g) {
    let cfg, as;
    try { [cfg, as] = await Promise.all([videoCfg(), tc("video/assets")]); } catch (e) { toast(e.message, true); return; }
    const by = (k) => as.items.filter((a) => a.kind === k);
    const tags = [...new Set(as.items.map((a) => a.tag).filter(Boolean))];
    const shotModels = cfg.models.filter((m) => !m.avatar);
    const res = await dialog({
      title: "新建视频", wide: true, ok: "写脚本",
      body: `<div class="form">
        <div class="seg" id="nvKind"><button type="button" data-k="scene" class="on">场景广告</button><button type="button" data-k="avatar">数字人口播</button></div>
        <p class="hint" id="nvKindHint"></p>
        <div class="form-row"><label>产品<input name="product" maxlength="120" placeholder="如：COG-2 户外便携式空调"></label>
          <label>素材库里的型号<input name="tag" maxlength="80" list="nvTags" placeholder="用来挑这款的照片"><datalist id="nvTags">${tags.map((t) => `<option value="${esc(t)}">`).join("")}</datalist></label></div>
        <div class="form-row"><label>语言<select name="lang">${cfg.langs.map((l) => `<option value="${l.code}">${esc(l.name)}</option>`).join("")}</select></label>
          <label>市场<input name="market" maxlength="60" placeholder="如：美国露营人群"></label>
          <label>平台<select name="platform">${PLATFORMS.map((p) => `<option>${p}</option>`).join("")}</select></label></div>
        <div class="form-row"><label>画幅<select name="aspect">${cfg.aspects.map((a) => `<option>${a}</option>`).join("")}</select></label>
          <label>时长<select name="seconds">${[15, 30, 45, 60].map((n) => `<option value="${n}" ${n === 30 ? "selected" : ""}>${n} 秒</option>`).join("")}</select></label>
          <label>背景音乐<select name="music"><option value="">不加</option>${by("music").map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join("")}</select></label></div>
        <label>想讲的卖点<input name="points" maxlength="500" placeholder="留空让 AI 从产品资料里挑"></label>
        <div class="form-row"><label>面向谁<input name="audience" maxlength="200" placeholder="如：露营、房车用户；或 OEM 采购商"></label>
          <label>补充要求<input name="notes" maxlength="500" placeholder="如：语气轻松，多讲安静和省电"></label></div>
        <div id="nvScene" class="form-row"><label>AI 镜头模型<select name="model">${shotModels.map((m) => `<option value="${m.id}" ${m.id === cfg.cfg.model ? "selected" : ""}>${esc(m.name)}${m.per_second ? ` · 约 ${usd(m.per_second)}/秒` : ""}</option>`).join("")}</select></label>
          <label>清晰度<select name="resolution">${["480p", "720p", "1080p"].map((r) => `<option ${r === cfg.cfg.resolution ? "selected" : ""}>${r}</option>`).join("")}</select></label></div>
        <div id="nvAvatar" class="form-row" hidden><label>数字人形象<select name="avatar">${by("avatar").length ? by("avatar").map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join("") : '<option value="">素材库里还没有，先去上传</option>'}</select></label>
          <label>声音<select name="gender"><option value="female">女声</option><option value="male">男声</option></select></label>
          <label>音色 ID（可不填）<input name="voice" maxlength="80" placeholder="不填用设置里的音色，没设就用 HeyGen 内置的"></label></div>
        <p class="hint">脚本只根据「知识库」里的产品资料写，每个数字都要能指回原文；写完你可以改，标红的说法改掉才能往下走。</p></div>`,
      onOpen(el) {
        const hint = { scene: "实物照片推近、实物图动起来、AI 生成的使用场景和文字卡拼成一条，字幕讲卖点，声音用 AI 镜头自带的环境声。",
          avatar: "数字人（HeyGen）对着镜头把脚本讲完，中间插产品画面。数字人形象要在素材库里上传，并写明本人授权。" };
        const set = (k) => {
          el.querySelectorAll("#nvKind button").forEach((b) => b.classList.toggle("on", b.dataset.k === k));
          el.querySelector("#nvAvatar").hidden = k !== "avatar";
          el.querySelector("#nvKindHint").textContent = hint[k];
          el.dataset.kind = k;
        };
        el.querySelectorAll("#nvKind button").forEach((b) => b.addEventListener("click", () => set(b.dataset.k)));
        set("scene");
      },
      async submit(el) {
        const kind = el.dataset.kind;
        if (!field(el, "product")) throw new Error("请填产品");
        if (kind === "avatar" && !field(el, "avatar")) throw new Error("先到素材库上传数字人形象");
        return tc("video/projects", { method: "POST", body: { kind, product: field(el, "product"), tag: field(el, "tag"), lang: field(el, "lang"),
          market: field(el, "market"), platform: field(el, "platform"), aspect: field(el, "aspect"), seconds: +field(el, "seconds"), points: field(el, "points"),
          audience: field(el, "audience"), notes: field(el, "notes"), model: field(el, "model"), resolution: field(el, "resolution"),
          music_asset_id: +field(el, "music") || null, avatar_asset_id: kind === "avatar" ? +field(el, "avatar") : null, voice_id: kind === "avatar" ? field(el, "voice") : "",
          voice_gender: field(el, "gender") || "female" } });
      },
    });
    if (!res) return;
    S.vid.cur = res.id;
    if (!stale(g)) renderVideos(g);
  }

  async function drawVideo(g, pid) {
    clearTimeout(vidTimer);
    actions.innerHTML = `<button class="btn" id="vidBack">← 全部视频</button>`;
    $("vidBack").addEventListener("click", () => { S.vid.cur = null; renderVideos(g); });
    if (!page.querySelector(".vid")) page.innerHTML = loading(5);
    let d, as;
    try { [d, as] = await Promise.all([tc(`video/projects/${pid}`), tc("video/assets")]); } catch (e) {
      if (!stale(g)) page.innerHTML = errorBox("读取失败：" + e.message, () => drawVideo(g, pid));
      if (e.status === 404) S.vid.cur = null;
      return;
    }
    if (stale(g) || S.vid.cur !== pid) return;
    const keepScroll = window.scrollY;
    const p = d.project, b = d.brief, busy = VID_BUSY.includes(p.status);
    const assetBy = Object.fromEntries(as.items.map((a) => [a.id, a]));
    page.innerHTML = `<div class="vid">
      <div class="card"><div class="card-head"><div><h3 style="margin:0">${esc(p.title || b.product)} <span class="tag ${VID_TAG[p.status] || "plain"}">${esc(p.status)}</span></h3>
        <div class="kv" style="margin-top:6px"><span>${VID_KIND[p.kind]}</span><span>${esc(b.product)}</span><span>${esc(b.lang)} · ${esc(b.market || "")}</span>
          <span>${esc(b.platform)} · ${esc(b.aspect)} · ${b.seconds} 秒</span><span>已花 <b>${usd(d.cost)}</b></span><span>${esc(p.created_name)}</span></div></div>
        <div class="page-actions"><button class="btn sm ghost" id="vRename">改标题</button><button class="btn sm ghost danger" id="vDel" ${busy ? "disabled" : ""}>删除</button></div></div>
        ${p.error ? `<div class="err-box" style="margin-top:8px"><span>${esc(p.error)}</span></div>` : ""}
        ${busy ? `<p class="hint"><span class="spin"></span> ${esc(p.status)}…${p.status === "生成中" ? "每个 AI 镜头一般 1–5 分钟，页面会自己刷新，可以先去做别的。" : ""}</p>` : ""}</div>
      ${vidScript(d)}
      ${vidBoard(d, assetBy)}
      ${vidRenders(d)}</div>`;
    window.scrollTo(0, keepScroll);
    wireVideo(g, d, as, assetBy);
    if (busy || d.shots.some((s) => ["排队", "生成中"].includes(s.status))) vidTimer = setTimeout(() => { if (!stale(g) && S.current === "videos" && S.vid.cur === pid) drawVideo(g, pid); }, 5000);
  }

  function issuesHtml(list) {
    return (list || []).length ? `<ul class="vid-issues">${list.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "";
  }

  function vidScript(d) {
    const sc = d.script, p = d.project;
    if (!sc.segments) return p.status === "写脚本中" ? "" : `<div class="card"><h3>脚本</h3><p class="faint">还没有脚本。</p><button class="btn primary" data-v="rewrite">写脚本</button></div>`;
    const locked = VID_BUSY.includes(p.status);
    const hi = sc.hook_issues || [];
    return `<div class="card vid-script"><div class="card-head"><h3 style="margin:0">脚本</h3><div class="page-actions">
        <button class="btn sm" data-v="rewrite" ${locked ? "disabled" : ""}>重写</button><button class="btn sm" data-v="save-script" ${locked ? "disabled" : ""}>保存并重新检查</button></div></div>
      <p class="hint" style="margin-bottom:10px">每个数字和参数都要能在产品资料里找到原文（下面灰字是出处）。标红的说法要改掉，或删掉这句；管理员核对过也可以放行。</p>
      <h4 class="sub-label">开头（选一个）</h4>
      ${sc.hooks.map((h, i) => `<div class="vid-line"><label class="check"><input type="radio" name="hook" value="${i}" ${i === sc.hook ? "checked" : ""}></label>
        <div style="flex:1"><input class="vid-in" data-hook="${i}" value="${esc(h)}" maxlength="200">${issuesHtml(hi[i])}</div></div>`).join("")}
      <h4 class="sub-label">正文</h4>
      ${sc.segments.map((s, i) => `<div class="vid-line" data-seg="${i}"><span class="tag plain">${esc(s.part || "段")}</span>
        <div style="flex:1;min-width:0"><textarea class="vid-in" rows="2" data-text="${i}" maxlength="400">${esc(s.text)}</textarea>
          ${s.zh ? `<div class="faint" style="font-size:12.5px">${esc(s.zh)}</div>` : ""}
          ${(s.facts || []).map((f, k) => `<div class="vid-fact" data-fact="${i}:${k}"><span>${esc(f.claim)}</span><span class="faint">出处：「${esc(f.quote)}」</span>
            <button class="btn sm ghost" data-dropfact="${i}:${k}" title="删掉这条出处">×</button></div>`).join("")}
          ${issuesHtml(s.issues)}</div>
        <label class="vid-sec"><input type="number" min="1" max="20" data-sec="${i}" value="${s.seconds}"> 秒</label></div>`).join("")}
      <div class="form-actions">${sc.override_by ? `<span class="faint">管理员 ${esc(sc.override_by)} 已核对放行</span>` : d.blocked ? '<span class="bad-text" style="margin-right:auto">还有标红的说法</span>' : '<span class="faint">检查通过</span>'}
        ${d.blocked && isAdmin() ? `<button class="btn" data-v="override">我核对过，放行</button>` : ""}
        <button class="btn primary" data-v="board" ${d.blocked || locked ? "disabled" : ""}>${d.shots.length ? "重新出分镜" : "出分镜"}</button></div></div>`;
  }

  function shotThumb(d, s, assetBy) {
    const a = assetBy[s.asset_id];
    if (s.file) return `<video src="${vfile(d.project.id, s.file)}#t=0.5" muted loop playsinline preload="metadata" class="vid-thumb" data-hoverplay></video>`;
    if (a && a.kind === "footage") return `<img src="${afile(a.id, true)}" class="vid-thumb" alt="">`;
    if (a && a.kind !== "music") return `<img src="${afile(a.id)}" class="vid-thumb" alt="">`;
    if (s.kind === "card") return `<div class="vid-thumb vid-card"><b>${esc(s.card.title || "")}</b>${(s.card.lines || []).map((x) => `<span>${esc(x)}</span>`).join("")}</div>`;
    return `<div class="vid-thumb vid-empty">${esc(s.label)}</div>`;
  }

  function vidBoard(d, assetBy) {
    const p = d.project;
    if (!d.shots.length) return p.status === "出分镜中" ? "" : (d.script.segments ? `<div class="card"><h3>分镜</h3><p class="faint">脚本检查通过后点「出分镜」。</p></div>` : "");
    const locked = VID_BUSY.includes(p.status);
    const segName = (i) => i < 0 ? "全片" : i === 0 ? "开头" : `第 ${i} 段`;
    const todo = d.shots.filter((s) => s.ai && ["", "失败"].includes(s.status)).length;
    const allDone = d.shots.every((s) => !s.ai || s.status === "完成");
    const total = d.shots.filter((s) => p.kind !== "avatar" || s.kind === "avatar").reduce((n, s) => n + s.seconds, 0);
    return `<div class="card"><div class="card-head"><h3 style="margin:0">分镜 <span class="faint num" style="font-weight:400;font-size:13px">${d.shots.length} 个镜头 · 约 ${Math.round(total)} 秒</span></h3>
        <div class="page-actions"><button class="btn sm" data-v="add-shot" ${locked ? "disabled" : ""}>加镜头</button></div></div>
      ${p.kind === "avatar" ? '<p class="hint" style="margin-bottom:8px">数字人讲完整个脚本；下面的产品画面按段插在口播中间，声音仍是数字人的。</p>' : ""}
      <div class="vid-shots">${d.shots.map((s) => `<div class="vid-shot" data-shot="${s.id}">
        ${shotThumb(d, s, assetBy)}
        <div class="vid-shot-body"><div class="vid-shot-head"><b class="num">#${s.idx}</b><span class="tag plain">${esc(s.label)}</span><span class="faint">${segName(s.seg)} · ${s.seconds} 秒</span>
          ${s.ai ? `<span class="tag ${SHOT_TAG[s.status] || "plain"}">${esc(s.status || "待生成")}</span>${s.cost ? `<span class="faint num">${usd(s.cost)}</span>` : ""}` : '<span class="faint">本机合成，不花钱</span>'}</div>
          ${s.ai ? `<div class="faint vid-prompt">${esc(s.model)}：${esc(s.prompt)}</div>` : ""}
          ${s.kind === "card" ? `<div class="faint vid-prompt">${esc(s.card.title)}${(s.card.lines || []).map((x) => " / " + esc(x)).join("")}</div>` : ""}
          ${s.asset_id && assetBy[s.asset_id] ? `<div class="faint" style="font-size:12px">素材：${esc(assetBy[s.asset_id].name)}${assetBy[s.asset_id].tag ? ` · ${esc(assetBy[s.asset_id].tag)}` : ""}</div>` : ""}
          ${s.error ? `<div class="bad-text" style="font-size:12.5px">${esc(s.error)}</div>` : ""}
          <div class="vid-shot-acts">${locked ? "" : `<button class="btn sm ghost" data-edit="${s.id}">编辑</button>
            ${s.kind !== "avatar" ? `<button class="btn sm ghost" data-move="${s.id}:-1" title="上移">↑</button><button class="btn sm ghost" data-move="${s.id}:1" title="下移">↓</button>
            <button class="btn sm ghost danger" data-delshot="${s.id}">删除</button>` : ""}
            ${s.ai && ["完成", "失败"].includes(s.status) ? `<button class="btn sm ghost" data-redo="${s.id}">重做</button>` : ""}`}
            ${locked && p.status === "生成中" && s.status === "失败" ? `<button class="btn sm ghost" data-redo="${s.id}">重做</button>` : ""}</div></div></div>`).join("")}</div>
      <div class="form-actions"><span class="faint">${todo ? `还要生成 ${todo} 个 AI 镜头，预计 <b>${usd(d.estimate)}</b>；` : ""}本月已花 ${usd(d.spent)} / 预算 ${usd(d.budget)}${d.has_key ? "" : " · <span class=\"bad-text\">还没有 OpenRouter 密钥</span>"}</span>
        ${allDone && !locked && d.renders.length ? `<button class="btn" data-v="compose">重新合成</button>` : ""}
        <button class="btn primary" data-v="start" ${locked || (!todo && d.renders.length) ? "disabled" : ""}>${todo ? `开始生成（${usd(d.estimate)}）` : "合成成片"}</button></div></div>`;
  }

  function vidRenders(d) {
    if (!d.renders.length) return "";
    const p = d.project, r = d.renders[0];
    const rv = r.review || {};
    return `<div class="card"><div class="card-head"><h3 style="margin:0">成片 <span class="tag ${r.status === "已通过" ? "ok" : r.status === "打回" ? "bad" : "warn"}">${esc(r.status)}</span>
        <span class="faint num" style="font-weight:400;font-size:13px">${r.seconds} 秒 · ${esc(r.created_text)} · ${r.engine === "remotion" ? "新版模板" : "旧版合成"}</span></h3>
        <div class="page-actions">${r.status === "已通过" ? `<a class="btn sm primary" href="${vfile(p.id, r.file, true)}">下载 MP4</a><a class="btn sm" href="${vfile(p.id, r.file.replace(".mp4", ".srt"), true)}">下载字幕</a>` : ""}</div></div>
      ${r.notes ? `<p class="vid-notes"><b>${r.engine === "remotion" ? "导演说明" : "说明"}</b>${esc(r.notes)}</p>` : ""}
      <div class="vid-render"><video src="${vfile(p.id, r.file)}#t=0.5" controls playsinline preload="metadata" class="vid-player vid-${esc(d.brief.aspect.replace(":", "x"))}"></video>
        <div class="vid-review"><h4 class="sub-label">每秒一帧，对照实物照片看产品有没有走样</h4><img src="${vfile(p.id, r.file.replace(".mp4", ".jpg"))}" class="vid-grid" alt="帧网格">
          ${r.status === "待审核" ? (d.can_review ? `<div class="form" style="margin-top:12px">${REVIEW_ITEMS.map(([k, t]) => `<label class="check"><input type="checkbox" name="rv_${k}"> ${esc(t)}</label>`).join("")}
            <label>意见<textarea name="rv_note" rows="2" maxlength="500" placeholder="打回时写清楚哪一秒、哪里不对"></textarea></label>
            <div class="form-actions"><span class="faint">内容编号 ${esc(r.content_id.slice(0, 12))}，已写进文件的 AIGC 元数据</span><button class="btn danger" data-review="0">打回</button><button class="btn primary" data-review="1">通过</button></div></div>`
            : '<p class="hint" style="margin-top:12px">审核要换一个人：提交生成的人不能自己审。</p>')
          : `<p class="hint" style="margin-top:12px">${esc(r.reviewer)} ${esc(r.reviewed_text)} ${r.status === "已通过" ? "审核通过" : "打回"}${rv.note ? `：${esc(rv.note)}` : ""}。${r.status === "已通过" ? "发布到 TikTok 时记得打开「AI 生成内容」开关。" : ""}</p>`}</div></div>
      ${d.renders.length > 1 ? `<p class="faint" style="font-size:12.5px;margin:10px 0 0">之前的版本：${d.renders.slice(1).map((x) => `<a href="${vfile(p.id, x.file)}" target="_blank" rel="noopener">${esc(x.created_text.slice(5))}（${esc(x.status)}）</a>`).join("、")}</p>` : ""}</div>`;
  }

  function collectScript() {
    const el = page.querySelector(".vid-script");
    const sc = JSON.parse(JSON.stringify(S.vid.data.script));
    sc.hooks = sc.hooks.map((h, i) => el.querySelector(`[data-hook="${i}"]`).value.trim());
    sc.hook = +(el.querySelector('input[name="hook"]:checked')?.value || 0);
    sc.segments.forEach((s, i) => {
      s.text = el.querySelector(`[data-text="${i}"]`).value.trim();
      s.seconds = Math.max(1, Math.min(20, +el.querySelector(`[data-sec="${i}"]`).value || s.seconds));
      s.facts = (s.facts || []).filter((f, k) => !(S.vid.dropped || new Set()).has(`${i}:${k}`));
    });
    return { hooks: sc.hooks, hook: sc.hook, segments: sc.segments.map(({ part, seconds, text, zh, facts }) => ({ part, seconds, text, zh, facts })) };
  }

  function wireVideo(g, d, as, assetBy) {
    const pid = d.project.id;
    S.vid.data = d;
    S.vid.dropped = new Set();
    const again = () => drawVideo(g, pid);
    const act = async (path, body, msg) => {
      try { const r = await tc(`video/projects/${pid}/${path}`, { method: "POST", body }); if (msg) toast(msg); again(); return r; } catch (e) { toast(e.message, true); }
    };
    const on = (sel, fn) => page.querySelectorAll(sel).forEach((b) => b.addEventListener("click", () => fn(b)));
    $("vRename")?.addEventListener("click", async () => {
      const ok = await dialog({ title: "改标题", body: `<div class="form"><label>标题<input name="t" maxlength="120" value="${esc(d.project.title)}"></label></div>`, ok: "保存",
        submit: (el) => tc(`video/projects/${pid}`, { method: "PATCH", body: { title: field(el, "t") } }) });
      if (ok) again();
    });
    $("vDel")?.addEventListener("click", async () => {
      if (!(await confirmBox("删除这条视频？", "<p>脚本、分镜、生成的镜头和成片都会删掉，已经花的钱不会退。</p>", "删除", true))) return;
      try { await tc(`video/projects/${pid}`, { method: "DELETE" }); S.vid.cur = null; toast("已删除"); renderVideos(g); } catch (e) { toast(e.message, true); }
    });
    on('[data-v="rewrite"]', async () => {
      if (d.script.segments && !(await confirmBox("重写脚本？", "<p>现在的脚本和你的修改会被替换。</p>", "重写"))) return;
      act("script", undefined, "开始重写");
    });
    on('[data-v="save-script"]', async () => {
      try { const r = await tc(`video/projects/${pid}/script`, { method: "PUT", body: collectScript() }); toast(r.blocked ? "已保存，还有标红的说法" : "已保存，检查通过"); again(); } catch (e) { toast(e.message, true); }
    });
    on("[data-dropfact]", (b) => { S.vid.dropped.add(b.dataset.dropfact); b.closest(".vid-fact").remove(); toast("删掉了这条出处，点「保存并重新检查」生效"); });
    on('[data-v="override"]', async () => {
      if (!(await confirmBox("放行标红的说法？", "<p>放行后会记下你的名字。确认你已经对照产品资料核对过这些说法，且有证据支持。</p>", "我核对过"))) return;
      act("script/override", undefined, "已放行");
    });
    on('[data-v="board"]', async () => {
      if (d.shots.length && !(await confirmBox("重新出分镜？", "<p>现在的镜头会被替换，已经生成的 AI 镜头也会丢掉。</p>", "重新出", true))) return;
      act("board", undefined, "开始出分镜");
    });
    on('[data-v="add-shot"]', () => editShot(g, d, as, null));
    on("[data-edit]", (b) => editShot(g, d, as, d.shots.find((s) => s.id === +b.dataset.edit)));
    on("[data-move]", (b) => { const [sid, by] = b.dataset.move.split(":"); act(`shots/${sid}/move`, { by: +by }); });
    on("[data-delshot]", async (b) => {
      try { await tc(`video/projects/${pid}/shots/${b.dataset.delshot}`, { method: "DELETE" }); again(); } catch (e) { toast(e.message, true); }
    });
    on("[data-redo]", async (b) => {
      const s = d.shots.find((x) => x.id === +b.dataset.redo);
      const price = s.kind === "avatar" ? "每秒约 $0.05" : "几毛到一两美元，看模型和时长";
      if (!(await confirmBox("重做这个镜头？", `<p>会按现在的画面描述重新生成，再花一次钱（${price}）。想改描述就先点「编辑」。</p>`, "重做"))) return;
      act(`shots/${b.dataset.redo}/redo`, undefined, "已排队");
    });
    on('[data-v="start"]', async () => {
      const todo = d.shots.filter((s) => s.ai && ["", "失败"].includes(s.status)).length;
      if (todo && !(await confirmBox("开始生成？", `<p>要生成 ${todo} 个 AI 镜头，预计 <b>${usd(d.estimate)}</b>（按 OpenRouter 标价估算，以实际扣费为准）。本月已花 ${usd(d.spent)}，预算 ${usd(d.budget)}。</p>
        <p class="faint">镜头生成好后会自动合成成片，一般 3–10 分钟。</p>`, "开始生成"))) return;
      act("start", undefined, todo ? "已开始生成" : "开始合成");
    });
    on('[data-v="compose"]', () => act("compose", undefined, "开始合成"));
    on("[data-review]", async (b) => {
      const el = page.querySelector(".vid-review");
      const checks = Object.fromEntries(REVIEW_ITEMS.map(([k]) => [k, el.querySelector(`[name="rv_${k}"]`).checked]));
      try {
        await tc(`video/projects/${pid}/renders/${d.renders[0].id}/review`, { method: "POST", body: { ok: b.dataset.review === "1", checks, note: el.querySelector('[name="rv_note"]').value.trim() } });
        toast(b.dataset.review === "1" ? "已通过，可以下载了" : "已打回");
        refreshOverview();
        again();
      } catch (e) { toast(e.message, true); }
    });
    page.querySelectorAll("[data-hoverplay]").forEach((v) => {
      v.addEventListener("mouseenter", () => v.play().catch(() => {}));
      v.addEventListener("mouseleave", () => { v.pause(); v.currentTime = 0; });
    });
  }

  async function editShot(g, d, as, s) {
    let cfg;
    try { cfg = await videoCfg(); } catch (e) { toast(e.message, true); return; }
    const p = d.project;
    const kinds = Object.entries(cfg.kinds).filter(([k]) => k !== "avatar" || (s && s.kind === "avatar"));
    const segs = d.lines.map((x, i) => [i, `${i === 0 ? "开头" : `第 ${i} 段`}：${x.text.slice(0, 40)}`]);
    const cur = s || { kind: "photo", seg: 0, seconds: 3, asset_id: null, model: d.brief.model || cfg.cfg.model, prompt: "", card: { title: "", lines: [] } };
    const opts = (kind) => as.items.filter((a) => a.kind === ({ photo: "photo", motion: "photo", footage: "footage", avatar: "avatar" })[kind]);
    const ok = await dialog({
      title: s ? `编辑镜头 #${s.idx}` : "加镜头", wide: true, ok: "保存",
      body: `<div class="form">
        <div class="form-row"><label>做法<select name="kind">${kinds.map(([k, t]) => `<option value="${k}" ${k === cur.kind ? "selected" : ""}>${t}</option>`).join("")}</select></label>
          ${cur.kind === "avatar" ? "" : `<label>属于<select name="seg">${segs.map(([i, t]) => `<option value="${i}" ${i === cur.seg ? "selected" : ""}>${esc(t)}</option>`).join("")}</select></label>`}
          <label>秒数<input name="seconds" type="number" min="1" max="30" step="0.5" value="${cur.seconds}"></label></div>
        <p class="hint" data-k-hint></p>
        <label data-for="asset">素材<select name="asset"></select></label>
        <label data-for="model">视频模型<select name="model">${cfg.models.filter((m) => !m.avatar).map((m) => `<option value="${m.id}" ${m.id === cur.model ? "selected" : ""}>${esc(m.name)}${m.per_second ? ` · 约 ${usd(m.per_second)}/秒` : ""}${m.durations ? `（${Math.min(...m.durations)}–${Math.max(...m.durations)} 秒）` : ""}</option>`).join("")}</select></label>
        <label data-for="prompt">画面描述（写给视频模型，英文效果最好）<textarea name="prompt" rows="5" maxlength="3000">${esc(cur.prompt)}</textarea></label>
        <div data-for="card" class="form"><label>标题<input name="title" maxlength="60" value="${esc(cur.card?.title || "")}"></label>
          ${[0, 1, 2].map((i) => `<label>第 ${i + 1} 行<input name="line${i}" maxlength="80" value="${esc(cur.card?.lines?.[i] || "")}"></label>`).join("")}</div></div>`,
      onOpen(el) {
        const hints = { photo: "实物照片做缓慢推近，本机合成，不花钱，产品不会走样。", motion: "实物照片做首帧，AI 让镜头和光线动起来。描述里写明产品保持不变，生成后要仔细审。",
          scene: "AI 生成使用场景。画面里不要出现我们的产品，也不要有品牌、文字、Logo。", footage: "从素材库里的实拍视频截一段。", card: "本机渲染的文字卡：参数、保修、工厂这类有出处的信息。",
          avatar: p.kind === "avatar" ? "数字人讲的整段话。改了要重新生成数字人镜头。" : "" };
        const sync = () => {
          const k = field(el, "kind");
          el.querySelector("[data-k-hint]").textContent = hints[k] || "";
          const list = opts(k);
          const sel = el.querySelector('[name="asset"]');
          sel.innerHTML = list.length ? list.map((a) => `<option value="${a.id}" ${a.id === cur.asset_id ? "selected" : ""}>${esc(a.name)}${a.tag ? " · " + esc(a.tag) : ""}</option>`).join("") : '<option value="">素材库里没有这类素材</option>';
          el.querySelector('[data-for="asset"]').hidden = !["photo", "motion", "footage", "avatar"].includes(k);
          el.querySelector('[data-for="model"]').hidden = !["motion", "scene"].includes(k);
          el.querySelector('[data-for="prompt"]').hidden = !["motion", "scene", "avatar"].includes(k);
          el.querySelector('[data-for="card"]').hidden = k !== "card";
          if (k === "motion" && !field(el, "prompt")) el.querySelector('[name="prompt"]').value = "The camera slowly pushes in; soft light sweeps across the product. The product stays exactly as in the first frame: same shape, color, buttons, vents and logo. No text, no people. Quiet room tone.";
        };
        el.querySelector('[name="kind"]').addEventListener("change", sync);
        sync();
      },
      submit(el) {
        const body = { kind: field(el, "kind"), seg: cur.kind === "avatar" ? -1 : +field(el, "seg"), seconds: +field(el, "seconds"), asset_id: +field(el, "asset") || null,
          model: field(el, "model"), prompt: field(el, "prompt"), title: field(el, "title"), lines: [0, 1, 2].map((i) => field(el, `line${i}`)).filter(Boolean) };
        return s ? tc(`video/projects/${p.id}/shots/${s.id}`, { method: "PUT", body }) : tc(`video/projects/${p.id}/shots`, { method: "POST", body });
      },
    });
    if (ok && !stale(g)) drawVideo(g, p.id);
  }

  async function renderVideoAssets(g) {
    actions.innerHTML = `<button class="btn" id="vaGen">AI 生图</button><button class="btn" id="vaCover">做封面 / 海报</button><button class="btn primary" id="vaUp">上传素材</button>`;
    page.innerHTML = loading(4);
    let d, cfg;
    try { [d, cfg] = await Promise.all([tc("video/assets"), videoCfg()]); } catch (e) {
      if (!stale(g)) page.innerHTML = errorBox("素材读取失败：" + e.message, () => renderVideoAssets(g));
      return;
    }
    if (stale(g)) return;
    $("vaUp").addEventListener("click", () => uploadAssets(g, cfg));
    $("vaGen").addEventListener("click", () => generateImages(g, cfg, d.items));
    $("vaCover").addEventListener("click", () => makeCover(g, cfg, d.items));
    const k = S.vid.assetKind;
    const items = d.items.filter((a) => !k || a.kind === k);
    const counts = d.items.reduce((m, a) => ({ ...m, [a.kind]: (m[a.kind] || 0) + 1 }), {});
    page.innerHTML = `<p class="hint" style="margin:0 0 12px">产品近景只能来自这里的实物照片（白底或透明底最好），每个主推型号 5–10 张：正面、侧面、细节、使用场景。型号填对，分镜才会挑这款的照片。
        数字人形象要本人书面同意；音乐要有商用授权。AI 生成的图片自动带 AI 标识；参考产品照片生成的图要有人和实物核对过才会被用到。</p>
      <div class="filters">${[["", "全部", d.items.length], ...Object.entries(cfg.asset_kinds).map(([kk, t]) => [kk, t, counts[kk] || 0])].map(([kk, t, n]) =>
        `<button type="button" class="chip ${kk === k ? "on" : ""}" data-k="${kk}">${esc(t)}<span class="c">${n}</span></button>`).join("")}</div>
      ${items.length ? `<div class="asset-grid">${items.map((a) => `<div class="asset-card">
        ${a.kind === "music" ? `<div class="asset-img vid-empty">♪ ${Math.round(a.seconds)} 秒</div>` : `<img class="asset-img ${a.kind === "logo" ? "logo" : ""}" src="${afile(a.id, a.kind === "footage")}" alt="" loading="lazy">`}
        <div class="asset-meta"><b title="${esc(a.name)}">${a.review ? '<span class="tag warn">待审核</span> ' : ""}${esc(a.name)}</b><span class="faint">${esc(a.label)}${a.tag ? ` · ${esc(a.tag)}` : ""}${a.seconds ? ` · ${Math.round(a.seconds)} 秒` : a.width ? ` · ${a.width}×${a.height}` : ""}</span>
          ${a.model && a.kind !== "cover" ? `<span class="faint clamp" title="${esc(a.prompt)}">${esc(a.model.split("/").pop())} · ${esc(a.prompt)}</span>` : ""}
          ${a.consent ? `<span class="faint clamp" title="${esc(a.consent)}">${a.kind === "aiproduct" ? "" : "授权："}${esc(a.consent)}</span>` : ""}
          <div class="vid-shot-acts">${a.review ? `<button class="btn sm primary" data-ap="${a.id}">核对</button>` : ""}${a.kind === "cover" ? `<a class="btn sm" href="${afile(a.id)}&download=1">下载</a>` : ""}${["aiscene", "scene"].includes(a.kind) ? `<button class="btn sm ghost" data-cv="${a.id}">做封面</button>` : ""}<button class="btn sm ghost" data-ed="${a.id}">改名 / 型号</button><button class="btn sm ghost danger" data-del="${a.id}">删除</button></div></div></div>`).join("")}</div>`
      : `<div class="card empty"><b>${d.items.length ? "这类还没有素材" : "素材库是空的"}</b>先上传产品实物照片</div>`}`;
    page.querySelectorAll("[data-k]").forEach((b) => b.addEventListener("click", () => { S.vid.assetKind = b.dataset.k; renderVideoAssets(g); }));
    page.querySelectorAll("[data-ed]").forEach((b) => b.addEventListener("click", async () => {
      const a = d.items.find((x) => x.id === +b.dataset.ed);
      const ok = await dialog({ title: "改素材", ok: "保存", body: `<div class="form"><label>名称<input name="n" maxlength="120" value="${esc(a.name)}"></label>
        <label>型号<input name="t" maxlength="80" value="${esc(a.tag)}" placeholder="如：COG-2"></label></div>`,
        submit: (el) => tc(`video/assets/${a.id}`, { method: "PATCH", body: { name: field(el, "n"), tag: field(el, "t") } }) });
      if (ok) renderVideoAssets(g);
    }));
    page.querySelectorAll("[data-cv]").forEach((b) => b.addEventListener("click", () => makeCover(g, cfg, d.items, +b.dataset.cv)));
    page.querySelectorAll("[data-ap]").forEach((b) => b.addEventListener("click", () => approveImage(g, d.items.find((x) => x.id === +b.dataset.ap), d.items)));
    page.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => {
      if (!(await confirmBox("删除这个素材？", "<p>删除后分镜里就不能再用它。</p>", "删除", true))) return;
      try { await tc(`video/assets/${b.dataset.del}`, { method: "DELETE" }); toast("已删除"); renderVideoAssets(g); } catch (e) { toast(e.message, true); }
    }));
  }

  async function approveImage(g, a, items) {
    const ref = items.find((x) => x.id === a.ref_id);
    const ok = await dialog({
      title: "核对 AI 产品图", ok: "外观一致，通过", wide: true,
      body: `<p class="hint" style="margin-top:0">逐项对比：外形和比例、颜色和材质、按键、出风口、屏幕、Logo 和印字。有任何一处不一样就删掉重生成，不要通过。通过后只会当整张场景图用，不会用作产品特写。</p>
        <div class="img-compare"><figure><img src="${afile(a.id)}" alt=""><figcaption>AI 生成</figcaption></figure>
        <figure>${ref ? `<img src="${afile(ref.id)}" alt="">` : '<div class="vid-empty">参考照片已删除</div>'}<figcaption>实物照片${ref ? " · " + esc(ref.name) : ""}</figcaption></figure></div>
        <label class="check"><input type="checkbox" name="agree"> 我已逐项核对，产品外观和实物一致</label>`,
      submit(el) {
        if (!field(el, "agree")) throw new Error("先勾选确认");
        return tc(`video/assets/${a.id}/approve`, { method: "POST" });
      },
    });
    if (ok) { toast("已通过，导演可以用这张图了"); renderVideoAssets(g); }
  }

  async function makeCover(g, cfg, items, bg0 = 0) {
    const photos = items.filter((a) => a.kind === "photo");
    const bgs = items.filter((a) => ["aiscene", "scene"].includes(a.kind));
    if (!photos.length) return toast("先上传产品照片", true);
    const ok = await dialog({
      title: "做封面 / 海报", ok: "生成", wide: true,
      body: `<div class="form"><p class="hint" style="margin-top:0">产品一定用实物照片，背景可以用 AI 场景图、实拍照片或品牌色。用了 AI 背景会自动加 AI 标识。本机渲染，不花钱。</p>
        <div class="form-row"><label class="grow">产品照片<select name="product">${photos.map((a) => `<option value="${a.id}">${esc(a.name)}${a.tag ? " · " + esc(a.tag) : ""}</option>`).join("")}</select></label>
          <label class="grow">背景<select name="bg"><option value="">品牌色</option>${bgs.map((a) => `<option value="${a.id}" ${a.id === bg0 ? "selected" : ""}>${esc(a.label)} · ${esc(a.name)}</option>`).join("")}</select></label></div>
        <div class="cover-pick"><img data-p alt=""><img data-b alt=""></div>
        <label>标题<input name="title" maxlength="60" placeholder="例：Cool Air for *Hot Jobs*（用 * 包住的词会变成强调色）"></label>
        <label>副标题<input name="sub" maxlength="100" placeholder="例：Portable AC for workshops, kitchens and sites"></label>
        <div class="form-row">${[0, 1, 2].map((i) => `<label>卖点 ${i + 1}<input name="pt${i}" maxlength="28" placeholder="${["220V plug-in", "No install", "Factory direct"][i]}"></label>`).join("")}</div>
        <div class="form-row"><label class="grow">行动号召<input name="cta" maxlength="50" placeholder="例：Message us for a quote"></label>
          <label>画幅<select name="aspect">${(cfg.cover_aspects || ["9:16"]).map((x) => `<option>${x}</option>`).join("")}</select></label>
          <label>AI 标识语言<select name="lang">${cfg.langs.map((l) => `<option value="${l.code}">${esc(l.name)}</option>`).join("")}</select></label></div>
        <p class="hint">数字和认证只写有出处的；“best / #1 / guaranteed / eco-friendly”这类说法会被拦下。</p></div>`,
      onOpen(el) {
        const sync = () => {
          const pi = el.querySelector("[data-p]"), bi = el.querySelector("[data-b]");
          pi.src = afile(field(el, "product"));
          bi.hidden = !field(el, "bg");
          if (field(el, "bg")) bi.src = afile(field(el, "bg"));
        };
        el.querySelectorAll('[name="product"], [name="bg"]').forEach((x) => x.addEventListener("change", sync));
        sync();
      },
      async submit(el) {
        if (!field(el, "title")) throw new Error("写个标题");
        return tc("video/covers", { method: "POST", body: { product_id: +field(el, "product"), bg_id: +field(el, "bg") || null, title: field(el, "title"),
          sub: field(el, "sub"), points: [0, 1, 2].map((i) => field(el, `pt${i}`)).filter(Boolean), cta: field(el, "cta"), aspect: field(el, "aspect"), lang: field(el, "lang") } });
      },
    });
    if (!ok) return;
    toast("封面做好了，在「封面海报」里下载");
    S.vid.assetKind = "cover";
    renderVideoAssets(g);
  }

  async function generateImages(g, cfg, items) {
    const photos = items.filter((a) => a.kind === "photo");
    const models = cfg.image_models || [];
    const ok = await dialog({
      title: "AI 生图", ok: "生成", wide: true,
      body: `<div class="form">
        <div class="seg-pick"><label class="check"><input type="radio" name="mode" value="scene" checked> <b>空场景</b><span class="faint">画面里没有产品，合成时把真实产品照片放在上面，产品不会走样（推荐）</span></label>
          <label class="check"><input type="radio" name="mode" value="ref"> <b>参考产品照片生成</b><span class="faint">把产品放进场景里。模型会重画产品，要人工和实物核对后才能用</span></label></div>
        <div data-for="ref" class="form-row"><label class="grow">参考的产品照片<select name="ref">${photos.length ? photos.map((a) => `<option value="${a.id}">${esc(a.name)}${a.tag ? " · " + esc(a.tag) : ""}</option>`).join("") : '<option value="">素材库里还没有产品照片</option>'}</select></label>
          <img class="ref-thumb" alt=""></div>
        <label>想要的画面<textarea name="idea" rows="3" maxlength="1500" placeholder="例：中东沙漠边的建筑工地，正午强光，工人休息的阴凉棚，热浪；或：东南亚小餐馆的后厨，闷热，蒸汽"></textarea></label>
        <div class="form-row"><label class="grow">模型<select name="model"></select></label>
          <label>画幅<select name="aspect">${(cfg.image_aspects || ["9:16"]).map((x) => `<option>${x}</option>`).join("")}</select></label>
          <label>张数<select name="n">${[1, 2, 3, 4].map((x) => `<option ${x === 2 ? "selected" : ""}>${x}</option>`).join("")}</select></label>
          <label data-for="tag">型号<input name="tag" maxlength="80" placeholder="可不填；填了只给这款用"></label></div>
        <p class="hint" data-est></p></div>`,
      onOpen(el) {
        const sync = () => {
          const mode = el.querySelector('[name="mode"]:checked').value;
          const cur = field(el, "model");
          const list = models.filter((m) => m.modes.includes(mode));
          el.querySelector('[name="model"]').innerHTML = list.map((m) => `<option value="${m.id}" ${m.id === cur ? "selected" : ""}>${esc(m.name)} · ${usd(m.price)}/张 · ${esc(m.note)}</option>`).join("");
          el.querySelector('[data-for="ref"]').hidden = mode !== "ref";
          el.querySelector('[data-for="tag"]').hidden = mode === "ref";
          const r = el.querySelector(".ref-thumb"), rid = field(el, "ref");
          r.hidden = mode !== "ref" || !rid;
          if (rid) r.src = afile(rid);
          const m = models.find((x) => x.id === field(el, "model"));
          el.querySelector("[data-est]").textContent = m ? `预计 ${usd(m.price * +field(el, "n"))}，从视频预算里扣；每张 15 秒到 2 分钟，几张同时出。生成的图自动带 AI 标识，存进素材库。` : "";
        };
        el.querySelectorAll('[name="mode"], [name="model"], [name="n"], [name="ref"]').forEach((x) => x.addEventListener("change", sync));
        sync();
      },
      async submit(el) {
        const mode = el.querySelector('[name="mode"]:checked').value;
        if (mode === "ref" && !field(el, "ref")) throw new Error("先上传产品照片");
        if (field(el, "idea").length < 2) throw new Error("写一下想要的画面");
        const r = await tc("video/images", { method: "POST", body: { mode, idea: field(el, "idea"), model: field(el, "model"), aspect: field(el, "aspect"),
          n: +field(el, "n"), ref_id: mode === "ref" ? +field(el, "ref") : null, tag: mode === "ref" ? "" : field(el, "tag") } });
        return { n: r.ids.length, mode };
      },
    });
    if (!ok) return;
    toast(ok.mode === "ref" ? `生成了 ${ok.n} 张，核对后才能用` : `生成了 ${ok.n} 张场景图`);
    S.vid.assetKind = ok.mode === "ref" ? "aiproduct" : "aiscene";
    renderVideoAssets(g);
  }

  async function uploadAssets(g, cfg) {
    const kind0 = (cfg.upload_kinds || []).includes(S.vid.assetKind) ? S.vid.assetKind : "photo";
    const ok = await dialog({
      title: "上传素材", ok: "上传", wide: true,
      body: `<div class="form"><div class="form-row"><label>类型<select name="kind">${(cfg.upload_kinds || Object.keys(cfg.asset_kinds)).map((k) => `<option value="${k}" ${k === kind0 ? "selected" : ""}>${cfg.asset_kinds[k]}</option>`).join("")}</select></label>
          <label>型号<input name="tag" maxlength="80" placeholder="产品照片填型号，如 COG-2；实拍照片是工厂、产线、使用场景"></label>
          <label>来源<select name="source">${["实拍", "官网", "达人", "AI"].map((x) => `<option>${x}</option>`).join("")}</select></label></div>
        <label>文件<input type="file" name="files" multiple></label><p class="hint" data-ext></p>
        <label data-consent>授权说明<textarea name="consent" rows="3" maxlength="1000"></textarea></label>
        <label class="check" data-agree><input type="checkbox" name="agree"> 本人已书面同意把自己的肖像用于 AI 数字人视频，授权书已存档</label>
        <div class="progress" hidden><i style="width:0"></i></div></div>`,
      onOpen(el) {
        const sync = () => {
          const k = field(el, "kind");
          el.querySelector("[data-ext]").textContent = `支持 ${cfg.exts[k].join(" ")}，单个不超过 ${cfg.max_mb} MB`;
          el.querySelector('[name="files"]').accept = cfg.exts[k].join(",");
          el.querySelector("[data-consent]").hidden = !["avatar", "music"].includes(k);
          el.querySelector("[data-agree]").hidden = k !== "avatar";
          el.querySelector('[name="consent"]').placeholder = k === "avatar" ? "谁（姓名）、用在哪（如：TikTok 广告和官网）、到什么时候；只用正脸、光线均匀的照片" : "曲库名称和授权编号，或「自己创作」";
        };
        el.querySelector('[name="kind"]').addEventListener("change", sync);
        sync();
      },
      async submit(el) {
        const files = [...el.querySelector('[name="files"]').files];
        const k = field(el, "kind");
        if (!files.length) throw new Error("选文件");
        if (k === "avatar" && !field(el, "agree")) throw new Error("数字人形象要本人书面同意");
        if (["avatar", "music"].includes(k) && !field(el, "consent")) throw new Error("写明授权");
        const form = new FormData();
        files.forEach((f) => form.append("files", f));
        [["kind", k], ["tag", field(el, "tag")], ["source", field(el, "source")], ["consent", field(el, "consent")]].forEach(([n, v]) => form.append(n, v));
        const bar = el.querySelector(".progress");
        bar.hidden = false;
        return upload("api/console/video/assets", form, { headers: { "X-Tenant": S.tenant }, onProgress: (x) => { bar.querySelector("i").style.width = `${Math.round(x * 100)}%`; } });
      },
    });
    if (ok) { toast("已上传"); renderVideoAssets(g); }
  }

  async function renderVideoSettings(g) {
    page.innerHTML = loading(4);
    let d;
    try { d = await videoCfg(true); } catch (e) {
      if (!stale(g)) page.innerHTML = errorBox("设置读取失败：" + e.message, () => renderVideoSettings(g));
      return;
    }
    if (stale(g)) return;
    const c = d.cfg, admin = isAdmin();
    const keyText = d.own_key ? '<span class="tag ok">已填自己的密钥</span>' : d.platform_key ? '<span class="tag plain">用平台的账号（平台付费）</span>' : '<span class="tag bad">没有密钥，不能生成</span>';
    page.innerHTML = `<div class="card settings-form"><h3>生成账号</h3>
        <p class="hint">AI 镜头和数字人都走 OpenRouter 的视频接口（一个账号能用 Seedance、可灵、海螺、Wan、HeyGen）。密钥只存在服务器上，不会显示在页面里。</p>
        <div class="kv" style="margin:10px 0">${keyText}<span>本月已花 <b>${usd(d.spent)}</b></span></div>
        ${admin ? `<div class="form-row tight"><input class="grow" type="password" id="vsKey" placeholder="sk-or-…（留空保存 = 清除自己的密钥）" autocomplete="off"><button class="btn" id="vsKeySave">保存密钥</button></div>` : ""}</div>
      <div class="card settings-form"><h3>默认设置</h3><div class="form">
        <div class="form-row"><label>每月预算（美元）<input name="budget" type="number" min="0" step="1" value="${c.budget_month}" ${admin ? "" : "readonly"}></label>
          <label>AI 镜头默认模型<select name="model" ${admin ? "" : "disabled"}>${d.models.filter((m) => !m.avatar).map((m) => `<option value="${m.id}" ${m.id === c.model ? "selected" : ""}>${esc(m.name)}${m.per_second ? ` · 约 ${usd(m.per_second)}/秒` : ""}${m.audio ? " · 带声音" : " · 无声"}</option>`).join("")}</select></label>
          <label>默认清晰度<select name="resolution" ${admin ? "" : "disabled"}>${["480p", "720p", "1080p"].map((r) => `<option ${r === c.resolution ? "selected" : ""}>${r}</option>`).join("")}</select></label></div>
        <p class="hint">价格是 OpenRouter 标价按 ${esc(c.resolution)} 竖版估算的；成片统一输出 1080×1920，480p 的 AI 镜头会放大，适合先试效果。数字人（HeyGen Avatar IV）约 $0.05/秒。</p>
        <div class="form-row"><label>结尾卡的行动号召<input name="cta" maxlength="80" value="${esc(c.end_cta)}" placeholder="留空按语言自动：Message us for a quote" ${admin ? "" : "readonly"}></label>
          <label>结尾卡的联系方式<input name="contact" maxlength="120" value="${esc(c.end_contact)}" placeholder="留空用销售电话" ${admin ? "" : "readonly"}></label></div>
        <h4 class="sub-label">数字人默认音色（HeyGen voice_id，按语言）</h4>
        <div class="form-row">${d.langs.map((l) => `<label>${esc(l.name)}<input name="voice_${l.code}" maxlength="80" value="${esc(c.voices[l.code] || "")}" placeholder="不填用 HeyGen 内置男/女声" ${admin ? "" : "readonly"}></label>`).join("")}</div>
        <h4 class="sub-label">合成</h4>
        <label class="check"><input type="checkbox" name="studio" ${c.studio !== false ? "checked" : ""} ${admin ? "" : "disabled"}> 用新版模板合成（产品标注、数字滚动、动态字幕、转场、背景音乐；出错会自动退回旧版）</label>
        <div class="form-row"><label class="check grow"><input type="checkbox" name="director" ${c.director !== false ? "checked" : ""} ${admin ? "" : "disabled"}> AI 导演：看渲染出的画面，改剪辑、标注和字幕，最多改十几轮（DeepSeek Flash 每条不到 $0.01，从视频预算里扣）</label>
          <label>导演模型<select name="director_model" ${admin ? "" : "disabled"}>${(d.director_models || []).map((m) => `<option ${m === c.director_model ? "selected" : ""}>${esc(m)}</option>`).join("")}</select></label></div>
        <label class="check"><input type="checkbox" name="other" ${c.review_by_other ? "checked" : ""} ${admin ? "" : "disabled"}> 成片要换一个人审核（提交生成的人不能自己审）</label>
        ${admin ? `<div class="form-actions"><span class="faint">只有管理员能改</span><button class="btn primary" id="vsSave">保存</button></div>` : ""}</div></div>`;
    $("vsKeySave")?.addEventListener("click", async () => {
      try { await tc("video/key", { method: "PUT", body: { key: $("vsKey").value.trim() } }); toast($("vsKey").value.trim() ? "密钥已保存" : "已清除"); renderVideoSettings(g); } catch (e) { toast(e.message, true); }
    });
    $("vsSave")?.addEventListener("click", async () => {
      const el = page;
      try {
        await tc("video/config", { method: "PUT", body: { budget_month: +field(el, "budget"), model: field(el, "model"), resolution: field(el, "resolution"),
          end_cta: field(el, "cta"), end_contact: field(el, "contact"), review_by_other: field(el, "other"),
          studio: field(el, "studio"), director: field(el, "director"), director_model: field(el, "director_model"),
          voices: Object.fromEntries(d.langs.map((l) => [l.code, field(el, `voice_${l.code}`)])) } });
        toast("已保存");
        S.vid.cfg = null;
      } catch (e) { toast(e.message, true); }
    });
  }

  // ---------- SEO / GEO ----------

  const SEO_EVENT = { inquiry: "提交询盘表单", form: "提交表单", email: "点邮箱", phone: "点电话", whatsapp: "点 WhatsApp", quote: "点询价按钮",
    "play:film": "看产品影片", "play:video": "看视频" };
  const SEO_DEV = { desktop: "电脑", mobile: "手机", tablet: "平板" };
  const region = (() => {
    try {
      const d = new Intl.DisplayNames(["zh-CN"], { type: "region" });
      return (c) => (c && /^[A-Z]{2}$/.test(c) && c !== "XX" ? d.of(c) : "未知");
    } catch (e) { return (c) => c || "未知"; }
  })();
  const fmtSecs = (s) => (!s ? "—" : s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`);
  const change = (a, b) => (!b ? (a ? '<em class="up">新增</em>' : "") : `<em class="${a >= b ? "up" : "down"}">${a >= b ? "↑" : "↓"} ${Math.abs(Math.round(((a - b) / b) * 100))}%</em>`);
  const niceMax = (m) => { const p = 10 ** Math.floor(Math.log10(Math.max(1, m))), t = Math.ceil(m / p) * p; return t < 10 && t % 2 ? t + 1 : t; };
  const bars = (rows, label, val) => {
    const max = Math.max(1, ...rows.map(val));
    return rows.map((r) => `<div class="bar-row wide"><span title="${esc(label(r))}">${esc(label(r))}</span><span class="bar"><i style="width:${(val(r) / max) * 100}%"></i></span><b>${fmtNum(val(r))}</b></div>`).join("");
  };

  function lineChart(series, lines, h = 190) {
    const w = 760, L = 36, R = 10, T = 12, B = 24;
    const top = niceMax(Math.max(1, ...series.flatMap((d) => lines.map((l) => d[l.key]))));
    const x = (i) => L + (series.length < 2 ? 0 : (i * (w - L - R)) / (series.length - 1));
    const y = (v) => T + (h - T - B) * (1 - v / top);
    const step = Math.ceil(series.length / 10);
    const grid = [0, 0.5, 1].map((f) => `<line x1="${L}" x2="${w - R}" y1="${y(top * f)}" y2="${y(top * f)}"/><text x="${L - 6}" y="${y(top * f) + 4}" text-anchor="end">${Math.round(top * f)}</text>`).join("");
    const days = series.map((d, i) => (i % step === 0 || i === series.length - 1 ? `<text x="${x(i)}" y="${h - 6}" text-anchor="middle">${d.day.slice(5)}</text>` : "")).join("");
    const paths = lines.map((l) => {
      const pts = series.map((d, i) => `${x(i).toFixed(1)},${y(d[l.key]).toFixed(1)}`);
      return (l.area ? `<path d="M${pts.join(" L")} L${x(series.length - 1)},${y(0)} L${x(0)},${y(0)} Z" fill="${l.color}" opacity=".1"/>` : "") +
        `<polyline points="${pts.join(" ")}" fill="none" stroke="${l.color}" stroke-width="${l.width || 2}" stroke-linejoin="round" ${l.dash ? 'stroke-dasharray="4 4"' : ""}/>`;
    }).join("");
    const cw = (w - L - R) / Math.max(1, series.length - 1);
    const tips = series.map((d, i) => `<rect x="${x(i) - cw / 2}" y="0" width="${cw}" height="${h - B}"><title>${d.day}\n${lines.map((l) => `${l.name}：${d[l.key]}`).join("\n")}</title></rect>`).join("");
    return `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img"><g class="grid">${grid}</g><g class="days">${days}</g>${paths}<g class="tips">${tips}</g></svg>
      <p class="legend">${lines.map((l) => `<i style="background:${l.color}"></i>${esc(l.name)}`).join("")}</p>`;
  }

  async function renderSeo(g) {
    const st = S.seo;
    actions.innerHTML = `<select id="seoDays" aria-label="时间范围">${[[7, "近 7 天"], [30, "近 30 天"], [90, "近 90 天"]].map(([v, t]) =>
      `<option value="${v}" ${v === st.days ? "selected" : ""}>${t}</option>`).join("")}</select><button class="btn" id="seoSync">立即同步</button>`;
    page.innerHTML = loading(4);
    let d;
    try { d = await tc(`seo/traffic?days=${st.days}`); } catch (e) {
      if (!stale(g)) page.innerHTML = errorBox("流量读取失败：" + e.message, () => renderSeo(g));
      return;
    }
    if (stale(g)) return;
    $("seoDays").addEventListener("change", (e) => { st.days = +e.target.value; renderSeo(g); });
    $("seoSync").addEventListener("click", async (e) => {
      e.target.disabled = true;
      try { const r = await tc("seo/sync", { method: "POST" }); toast(`同步了 ${r.rows} 条`); renderSeo(g); } catch (err) { toast(err.message, true); e.target.disabled = false; }
    });
    if (!d.site || !d.has_key) {
      page.innerHTML = `<div class="card empty"><b>还没接入官网统计</b>填上官网网址、生成统计密钥，把安装包放进官网（Cloudflare Pages），就能看到每天多少人来、从哪来、点了几次询盘<p style="margin-top:12px"><a class="btn primary" href="#seosettings">去接入</a></p></div>`;
      return;
    }
    const t = d.total, p = d.prev;
    const aiSrc = d.sources.find((s) => s.source === "AI")?.visitors || 0;
    const aiBots = d.bots.filter((b) => ["ai_search", "ai_user", "ai_train"].includes(b.kind));
    page.innerHTML = `
      ${d.sync_error ? `<div class="notice bad"><span>同步出错：${esc(d.sync_error)}</span><a class="btn sm" href="#seosettings">看设置</a></div>` : ""}
      ${!d.has_data ? '<div class="notice"><span>还没有收到数据：确认官网已经部署了统计脚本，打开官网点几下，再点「立即同步」。</span></div>' : ""}
      <p class="hint" style="margin:0 0 12px">${esc(d.site)} · ${esc(d.from)} 到 ${esc(d.to)}（日期按 UTC 划分，时间是北京时间）· 上次同步 ${esc(d.synced_text || "还没有")}
        · 不用 cookie，同一个人一天内只算一次，换天重新算；爬虫不算访客</p>
      <div class="grid four">
        <div class="card stat"><span>日均访客</span><b>${t.per_day}</b><span>${t.span_days < d.days ? `有数据的 ${t.span_days} 天里` : ""}共 ${fmtNum(t.visitors)} 人·天 ${change(t.visitors, p.visitors)} · 现在在线 ${d.online}</span></div>
        <div class="card stat"><span>浏览量</span><b>${fmtNum(t.pv)}</b><span>平均停留 ${fmtSecs(t.avg_secs)} ${change(t.pv, p.pv)}</span></div>
        <div class="card stat"><span>询盘动作</span><b>${fmtNum(t.contacts)}</b><span>${t.conversion}% 的访客点了邮箱 / 电话 / 表单 ${change(t.contacts, p.contacts)}</span></div>
        <div class="card stat"><span>AI 爬虫来访</span><b>${fmtNum(t.ai_bot)}</b><span>搜索引擎 ${fmtNum(t.search_bot)} 次 · 从 AI 点进来 ${aiSrc} 人</span></div>
      </div>
      <div class="card section"><h3>每天访客</h3>
        ${lineChart(d.series, [{ key: "dau", name: "访客（日活）", color: "var(--wood)", area: true, width: 2.5 }, { key: "pv", name: "浏览量", color: "var(--ink-3)", dash: true, width: 1.5 },
          { key: "contacts", name: "询盘动作", color: "var(--ok)" }])}</div>
      <div class="grid two section">
        <div class="card"><h3>从哪来</h3>
          ${d.sources.length ? bars(d.sources, (s) => s.source, (s) => s.visitors) : '<div class="empty">还没有访客</div>'}
          ${d.refs.length ? `<h4 class="sub-label" style="margin:14px 0 6px">来源网站</h4><table class="t"><tbody>${d.refs.map((r) =>
            `<tr><td>${esc(r.host)}</td><td><span class="tag plain">${esc(r.source)}</span></td><td class="num">${r.visitors} 人</td></tr>`).join("")}</tbody></table>` : ""}
          ${d.utm.length ? `<h4 class="sub-label" style="margin:14px 0 6px">带 utm_source 的链接</h4>${bars(d.utm, (u) => u.key, (u) => u.v)}` : ""}
          <p class="hint">「AI」是从 ChatGPT、Perplexity、Gemini、Copilot、DeepSeek、Kimi 等点进来的人，GEO 做得好这一项会涨。</p></div>
        <div class="card"><h3>热门页面</h3>${d.pages.length ? `<table class="t"><thead><tr><th>页面</th><th>浏览</th><th>访客</th><th>平均停留</th></tr></thead><tbody>
          ${d.pages.map((x) => `<tr><td><code>${esc(x.path)}</code></td><td class="num">${x.pv}</td><td class="num">${x.visitors}</td><td class="nowrap">${fmtSecs(x.avg_secs)}</td></tr>`).join("")}</tbody></table>`
          : '<div class="empty">还没有浏览</div>'}</div>
      </div>
      <div class="grid two section">
        <div class="card"><h3>国家和地区</h3>${d.countries.length ? bars(d.countries, (c) => region(c.key), (c) => c.v) : '<div class="empty">还没有数据</div>'}</div>
        <div class="card"><h3>设备和语言版本</h3>${bars(d.devices, (x) => SEO_DEV[x.key] || x.key || "未知", (x) => x.v)}
          <h4 class="sub-label" style="margin:14px 0 6px">看的语言版本</h4>${bars(d.langs, (x) => x.key || "未标语言", (x) => x.v)}</div>
      </div>
      <div class="card section"><h3>最近的询盘动作</h3>${d.recent.length ? `<table class="t"><thead><tr><th>时间</th><th>动作</th><th>页面</th><th>国家</th><th>设备</th><th>这个人从哪来</th></tr></thead><tbody>
        ${d.recent.map((r) => `<tr><td class="nowrap">${esc(ago(r.ts))}</td><td><b>${esc(SEO_EVENT[r.name] || r.name)}</b></td><td><code>${esc(r.path)}</code></td>
          <td>${esc(region(r.cc))}</td><td>${esc(SEO_DEV[r.dev] || r.dev)}</td><td>${r.came_from ? `${esc(r.came_from)} <span class="tag plain">${esc(r.source)}</span>` : '<span class="faint">直接访问</span>'}</td></tr>`).join("")}</tbody></table>`
        : '<div class="empty"><b>还没有人点邮箱、电话或提交询盘</b>表单只是打开邮件程序，对方是否真的发出要以邮箱为准</div>'}
        ${d.events.length ? `<div class="kv" style="margin-top:10px">${d.events.map((e) => `<span>${esc(SEO_EVENT[e.key] || e.key)} <b>${e.n}</b></span>`).join("")}</div>` : ""}</div>
      <div class="card section"><h3>爬虫来访</h3>
        <div class="kv" style="margin-bottom:10px"><span>llms.txt 被读 <b>${d.bot_files["/llms.txt"] || 0}</b> 次</span><span>robots.txt <b>${d.bot_files["/robots.txt"] || 0}</b> 次</span>
          <span>sitemap.xml <b>${d.bot_files["/sitemap.xml"] || 0}</b> 次</span><span>AI 爬虫 <b>${aiBots.length}</b> 种</span></div>
        ${d.bots.length ? `${lineChart(d.series, [{ key: "ai_bot", name: "AI 爬虫", color: "var(--wood)" }, { key: "search_bot", name: "搜索引擎", color: "var(--ok)" }], 140)}
          <table class="t"><thead><tr><th>爬虫</th><th>类别</th><th>次数</th><th>最近</th><th>常看</th></tr></thead><tbody>
          ${d.bots.map((b) => `<tr><td><b>${esc(b.name)}</b>${b.note ? `<div class="faint">${esc(b.note)}</div>` : ""}</td><td><span class="tag ${["ai_search", "ai_user", "ai_train"].includes(b.kind) ? "warn" : b.kind === "search" ? "ok" : "plain"}">${esc(b.label)}</span></td>
            <td class="num">${b.n}</td><td class="nowrap">${esc(ago(b.last))}</td><td>${b.top.map((x) => `<code>${esc(x.path)}</code> ${x.n}`).join("　")}</td></tr>`).join("")}</tbody></table>`
          : '<div class="empty">还没有爬虫来过</div>'}
        <p class="hint">「AI 替用户来看」说明有人在 ChatGPT / Claude / Perplexity 里问到了需要打开官网的问题；「AI 搜索」是 AI 搜索引擎在建索引。</p></div>`;
  }

  const pathOf = (u) => { try { const x = new URL(u); return x.pathname + x.search; } catch (e) { return u; } };
  const posChange = (a, b) => (a == null || b == null ? "" : `<em class="${a <= b ? "up" : "down"}">${a <= b ? "↑" : "↓"} ${Math.abs(a - b).toFixed(1)} 名</em>`);

  async function renderSeoSearch(g) {
    const st = S.seo;
    actions.innerHTML = `<select id="ssEng" aria-label="搜索引擎">${[["google", "Google"], ["bing", "Bing"]].map(([v, t]) => `<option value="${v}" ${v === st.engine ? "selected" : ""}>${t}</option>`).join("")}</select>
      <select id="ssDays" aria-label="时间范围">${[[7, "近 7 天"], [28, "近 28 天"], [90, "近 3 个月"], [180, "近 6 个月"], [486, "近 16 个月"]].map(([v, t]) =>
      `<option value="${v}" ${v === st.sdays ? "selected" : ""}>${t}</option>`).join("")}</select><button class="btn" id="ssSync">立即同步</button>`;
    page.innerHTML = loading(4);
    let d;
    try { d = await tc(`seo/search?days=${st.sdays}&engine=${st.engine}`); } catch (e) {
      if (!stale(g)) page.innerHTML = errorBox("搜索数据读取失败：" + e.message, () => renderSeoSearch(g));
      return;
    }
    if (stale(g)) return;
    $("ssEng").addEventListener("change", (e) => { st.engine = e.target.value; renderSeoSearch(g); });
    $("ssDays").addEventListener("change", (e) => { st.sdays = +e.target.value; renderSeoSearch(g); });
    $("ssSync").addEventListener("click", async (e) => {
      e.target.disabled = true;
      try { const r = await tc("seo/search/sync", { method: "POST" }); toast(r.errors.length ? r.errors.join("；") : "同步好了", !!r.errors.length); renderSeoSearch(g); } catch (err) { toast(err.message, true); e.target.disabled = false; }
    });
    const s = d.status[st.engine], name = st.engine === "google" ? "Google Search Console" : "Bing Webmaster Tools";
    if (!s.connected) {
      page.innerHTML = `<div class="card empty"><b>还没接入 ${name}</b>接入后能看到过去${st.engine === "google" ? " 16 个月" : "半年"}里，网站在搜索结果里被展示了多少次、被点了多少次、靠哪些词、排第几
        <p style="margin-top:12px"><a class="btn primary" href="#seosettings">去接入</a></p></div>`;
      return;
    }
    const t = d.total, p = d.prev;
    const qTable = (rows) => `<table class="t"><thead><tr><th>搜索词</th><th>点击</th><th>展示</th><th>点击率</th><th>排名</th></tr></thead><tbody>
      ${rows.map((q) => `<tr><td>${esc(q.key)}</td><td class="num">${q.clicks}</td><td class="num">${fmtNum(q.impressions)}</td><td class="num">${q.ctr}%</td><td class="num">${q.position ?? "—"}</td></tr>`).join("")}</tbody></table>`;
    page.innerHTML = `
      ${s.error ? `<div class="notice bad"><span>${esc(s.error)}</span><a class="btn sm" href="#seosettings">看设置</a></div>` : ""}
      ${!d.has_data ? `<div class="notice"><span>${s.synced_text ? "还没有数据：新网站要等搜索引擎收录、开始展示，通常几天到几周。" : "正在拉第一批数据，过一两分钟刷新。"}</span></div>` : ""}
      <p class="hint" style="margin:0 0 12px">${esc(s.site || "还没选网站")} · ${esc(d.from)} 到 ${esc(d.to)} · 上次同步 ${esc(s.synced_text || "还没有")}${d.first_day ? ` · 最早数据 ${esc(d.first_day)}` : ""}
        · ${st.engine === "google" ? "Google 的数据晚 2–3 天" : "Bing 的数据晚几天，搜索词和页面按周汇总"}</p>
      <div class="grid four">
        <div class="card stat"><span>点击</span><b>${fmtNum(t.clicks)}</b><span>从搜索结果点进官网 ${change(t.clicks, p.clicks)}</span></div>
        <div class="card stat"><span>展示</span><b>${fmtNum(t.impressions)}</b><span>出现在搜索结果里 ${change(t.impressions, p.impressions)}</span></div>
        <div class="card stat"><span>点击率</span><b>${t.ctr}%</b><span>上一期 ${p.ctr}%</span></div>
        <div class="card stat"><span>平均排名</span><b>${t.position ?? "—"}</b><span>越小越靠前 ${posChange(t.position, p.position)}</span></div>
      </div>
      <div class="grid two section">
        <div class="card"><h3>每天展示</h3>${lineChart(d.series, [{ key: "impressions", name: "展示", color: "var(--ink-3)", area: true }], 160)}</div>
        <div class="card"><h3>每天点击</h3>${lineChart(d.series, [{ key: "clicks", name: "点击", color: "var(--wood)", area: true, width: 2.5 }], 160)}</div>
      </div>
      ${d.chances.length ? `<div class="card section"><h3>差一点上首页的词</h3><p class="hint" style="margin-top:0">排名 4–20、展示不少：把这些词写进对应页面的标题、小标题和正文，补参数和 FAQ，最容易涨点击。</p>${qTable(d.chances)}</div>` : ""}
      <div class="grid two section">
        <div class="card"><h3>搜索词</h3>${d.queries.length ? qTable(d.queries.slice(0, 25)) : '<div class="empty">还没有搜索词（Google 会隐藏搜索量很少的词）</div>'}</div>
        <div class="card"><h3>页面</h3>${d.pages.length ? `<table class="t"><thead><tr><th>页面</th><th>点击</th><th>展示</th><th>排名</th></tr></thead><tbody>
          ${d.pages.map((x) => `<tr><td><code title="${esc(x.key)}">${esc(pathOf(x.key))}</code></td><td class="num">${x.clicks}</td><td class="num">${fmtNum(x.impressions)}</td><td class="num">${x.position ?? "—"}</td></tr>`).join("")}</tbody></table>`
          : '<div class="empty">还没有数据</div>'}</div>
      </div>
      ${st.engine === "google" ? `<div class="grid two section">
        <div class="card"><h3>国家和地区（按展示）</h3>${d.countries.length ? bars(d.countries, (c) => region(c.key), (c) => c.impressions) : '<div class="empty">还没有数据</div>'}</div>
        <div class="card"><h3>设备（按展示）</h3>${d.devices.length ? bars(d.devices, (x) => ({ DESKTOP: "电脑", MOBILE: "手机", TABLET: "平板" })[x.key] || x.key, (x) => x.impressions) : '<div class="empty">还没有数据</div>'}
          ${(s.sitemaps || []).length ? `<h4 class="sub-label" style="margin:14px 0 6px">站点地图</h4><table class="t"><tbody>${s.sitemaps.map((m) =>
            `<tr><td><code>${esc(pathOf(m.path))}</code></td><td>${m.pending ? '<span class="tag warn">处理中</span>' : m.errors ? `<span class="tag bad">${m.errors} 个错误</span>` : '<span class="tag ok">正常</span>'}</td><td class="num">${m.urls} 个网址</td><td class="nowrap faint">${esc((m.downloaded || m.submitted || "").slice(0, 10))}</td></tr>`).join("")}</tbody></table>`
            : '<p class="hint">Search Console 里还没提交站点地图：在「站点地图」里提交 sitemap.xml。</p>'}</div></div>` : ""}`;
  }

  async function renderSeoAudit(g) {
    const st = S.seo;
    page.innerHTML = loading(4);
    let d;
    try { d = await tc(`seo/audits?id=${st.audit || 0}`); } catch (e) {
      if (!stale(g)) page.innerHTML = errorBox("体检读取失败：" + e.message, () => renderSeoAudit(g));
      return;
    }
    if (stale(g)) return;
    actions.innerHTML = `${d.items.length > 1 ? `<select id="auPick" aria-label="历史体检">${d.items.map((a) => `<option value="${a.id}" ${a.id === d.current?.id ? "selected" : ""}>${esc(a.created_text)} · ${a.status === "完成" ? `SEO ${a.seo} / GEO ${a.geo}` : a.status}</option>`).join("")}</select>` : ""}
      <button class="btn primary" id="auRun" ${d.running ? "disabled" : ""}>${d.running ? '<span class="spin"></span>体检中' : "重新体检"}</button>`;
    $("auPick")?.addEventListener("change", (e) => { st.audit = +e.target.value; renderSeoAudit(g); });
    $("auRun").addEventListener("click", async () => {
      try { await tc("seo/audits", { method: "POST" }); st.audit = 0; toast("开始体检，大约 1 分钟"); renderSeoAudit(g); } catch (e) { toast(e.message, true); }
    });
    if (d.running) setTimeout(() => { if (!stale(g)) renderSeoAudit(g); }, 5000);
    const last = d.items[0];
    const head = last && last.status === "出错" ? `<div class="notice bad"><span>上次体检出错：${esc(last.error)}</span></div>` : "";
    if (!d.current) {
      page.innerHTML = head + `<div class="card empty"><b>${d.running ? "正在体检，大约 1 分钟" : "还没有体检过"}</b>会抓 robots.txt、sitemap、llms.txt 和 sitemap 里的页面（最多 25 页），
        用 AI 爬虫的身份访问首页，按 SEO 和 GEO 两张评分表打分${d.running ? "" : '<p style="margin-top:12px">先在「接入和设置」里填官网网址，再点右上角「重新体检」</p>'}</div>`;
      return;
    }
    const a = d.current, x = a.data;
    const psi = x.psi && x.psi.performance !== undefined ? x.psi : null;
    const dimCard = (title, total, dims) => `<div class="card"><div class="card-head"><h3>${title}</h3><span class="score-sm"><b>${total}</b> / 100</span></div>
      ${dims.map((m) => `<details class="dim"><summary><span>${esc(m.name)}</span><span class="bar"><i style="width:${(m.got / m.max) * 100}%"></i></span><b>${m.got} / ${m.max}</b></summary>
        <ul>${m.items.map((i) => `<li class="${i.got >= i.max ? "ok" : i.got ? "part" : "miss"}"><span>${esc(i.text)}</span><b>${i.got} / ${i.max}</b></li>`).join("")}</ul></details>`).join("")}</div>`;
    page.innerHTML = head + `
      <p class="hint" style="margin:0 0 12px">${esc(a.site)} · ${esc(a.created_text)} · ${esc(a.by || "")} · 抓了 ${x.pages.length} 页 · 评分表是按常见审核项自拟的，用来排优先级和前后对比</p>
      <div class="grid four">
        <div class="card stat"><span>SEO</span><b>${a.seo}</b><span>搜索引擎收录和排名的基础</span></div>
        <div class="card stat"><span>GEO</span><b>${a.geo}</b><span>能不能被 AI 搜索读懂、引用</span></div>
        <div class="card stat"><span>手机端性能（PageSpeed）</span><b>${psi ? psi.performance : "—"}</b><span>${psi ? `LCP ${esc(psi.lcp)} · CLS ${esc(psi.cls)} · TBT ${esc(psi.tbt)}` : esc(x.psi?.error || "没测")}</span></div>
        <div class="card stat"><span>AI 爬虫能不能进来</span><b>${Object.values(x.bots).filter((v) => v === 200).length} / ${Object.keys(x.bots).length}</b><span>${Object.entries(x.bots).map(([k, v]) => `${k} ${v}`).join(" · ")}</span></div>
      </div>
      <div class="card section"><h3>要改的地方 <span class="faint" style="font-weight:400">按影响排序，括号里是能拿回的分</span></h3>
        ${x.issues.length ? `<div class="list">${x.issues.map((i) => `<div class="list-item"><span class="tag ${i.sev === "高" ? "bad" : i.sev === "中" ? "warn" : "plain"}">${i.sev}</span>
          <span class="tag plain">${i.card}</span><span style="flex:1">${esc(i.text)}</span><span class="faint nowrap">+${i.lost}</span></div>`).join("")}</div>` : '<div class="empty">没有要改的</div>'}
        <p class="hint">参数、认证、成立年份、官方账号这类内容只能由你们提供真实数据，不能让 AI 编。</p></div>
      <div class="grid two section">${dimCard("SEO 评分", a.seo, x.seo)}${dimCard("GEO 评分", a.geo, x.geo)}</div>
      <div class="card section"><h3>逐页检查</h3><div style="overflow-x:auto"><table class="t"><thead><tr><th>页面</th><th>状态</th><th>响应</th><th>标题</th><th>描述</th><th>H1</th><th>正文</th><th>参数</th><th>结构化数据</th></tr></thead><tbody>
        ${x.pages.map((p) => `<tr><td><code>${esc(new URL(p.final).pathname)}</code> <span class="faint">${esc(p.lang)}</span></td><td>${p.status}</td><td class="num">${p.ms} ms</td>
          <td class="${p.title.length < 15 || p.title.length > 65 ? "bad-text" : ""}" title="${esc(p.title)}">${p.title.length} 字符</td>
          <td class="${p.desc.length < 50 || p.desc.length > 170 ? "bad-text" : ""}">${p.desc.length} 字符</td><td class="${p.h1.length !== 1 ? "bad-text" : ""}">${p.h1.length}</td>
          <td class="num">${p.words} 词</td><td class="num">${p.facts}</td><td class="faint">${esc(p.ld_types.filter((t) => !["Answer", "Question", "PostalAddress", "ListItem", "Offer", "Brand", "ContactPoint", "ImageObject"].includes(t)).join(" "))}</td></tr>`).join("")}</tbody></table></div>
        <div class="kv" style="margin-top:10px"><span>sitemap <b>${x.sitemap.count}</b> 个网址</span><span>llms.txt <b>${x.llms.status === 200 ? `${x.llms.words} 词` : "没有"}</b></span>
          <span>不存在的网址返回 <b>${x.not_found}</b></span><span>死链 <b>${x.broken.length}</b></span>
          <span>robots.txt 放行：${Object.entries(x.robots.checks).map(([k, v]) => `${k} ${v ? "✓" : "✗"}`).join(" ")}</span></div></div>`;
  }

  async function renderGeo(g) {
    const st = S.seo;
    page.innerHTML = loading(4);
    let d;
    try { d = await tc(`seo/geo?run=${st.run || 0}`); } catch (e) {
      if (!stale(g)) page.innerHTML = errorBox("读取失败：" + e.message, () => renderGeo(g));
      return;
    }
    if (stale(g)) return;
    if (!st.qs) st.qs = d.questions.slice();
    const r = d.run, done = (d.runs || []).filter((x) => x.status === "完成" && x.asked);
    actions.innerHTML = `${d.runs.length > 1 ? `<select id="geoPick" aria-label="历史">${d.runs.map((x) => `<option value="${x.id}" ${x.id === r?.id ? "selected" : ""}>${esc(x.created_text)} · ${x.status === "完成" ? `提到 ${x.mentioned}/${x.asked}` : x.status}</option>`).join("")}</select>` : ""}
      <button class="btn primary" id="geoRun" ${d.running ? "disabled" : ""}>${d.running ? '<span class="spin"></span>正在问' : `现在问一轮（约 ${usd(d.estimate)}）`}</button>`;
    $("geoPick")?.addEventListener("change", (e) => { st.run = +e.target.value; renderGeo(g); });
    $("geoRun").addEventListener("click", async () => {
      try { await tc("seo/geo/runs", { method: "POST" }); st.run = 0; toast("开始了，每个问题十几秒"); renderGeo(g); } catch (e) { toast(e.message, true); }
    });
    if (d.running) setTimeout(() => { if (!stale(g)) renderGeo(g); }, 6000);
    const pct = (a, b) => (b ? Math.round((100 * a) / b) + "%" : "—");
    const ranked = d.answers.filter((a) => a.position);
    const ans = (a) => `<tr data-ans="${a.id}"><td>${esc(a.question)}<div class="faint">${esc(a.qkind)} · ${esc(a.lang)} · ${esc(d.engines[a.engine] || a.engine)}</div></td>
      <td>${a.error ? `<span class="tag bad" title="${esc(a.error)}">没问成</span>` : a.mentioned ? '<span class="tag ok">提到了</span>' : '<span class="tag plain">没提到</span>'}</td>
      <td>${a.cited ? '<span class="tag ok">引用官网</span>' : ""}</td><td class="num nowrap">${a.position ? `第 ${a.position}` : ""}</td>
      <td class="muted">${a.brands.slice(0, 5).map(esc).join("、")}</td></tr>`;
    page.innerHTML = `
      ${r && r.status === "出错" ? `<div class="notice bad"><span>${esc(r.error)}</span></div>` : ""}
      <p class="hint" style="margin:0 0 12px">拿买家会问的问题去问联网的 AI 搜索，看回答里有没有提到我们（品牌词：${esc(d.brand_terms.join("、") || "还没填")}）、有没有引用官网、排第几。
        ${d.runs.length ? "" : "每周自动问一轮，也可以随时手动问。"}本月已花 ${usd(d.spent)}，预算 ${usd(d.budget)}。</p>
      ${r ? `<div class="grid four">
        <div class="card stat"><span>被提到</span><b>${pct(r.mentioned, r.asked)}</b><span>${r.mentioned} / ${r.asked} 个回答${done.length > 1 ? ` · 上一轮 ${pct(done[1].mentioned, done[1].asked)}` : ""}</span></div>
        <div class="card stat"><span>引用了官网</span><b>${pct(r.cited, r.asked)}</b><span>${r.cited} 个回答的来源里有官网</span></div>
        <div class="card stat"><span>提到时平均排第</span><b>${ranked.length ? (ranked.reduce((s, a) => s + a.position, 0) / ranked.length).toFixed(1) : "—"}</b><span>在回答提到的所有品牌里</span></div>
        <div class="card stat"><span>这一轮花费</span><b>${usd(r.cost)}</b><span>${esc(r.created_text)} · ${esc(r.by)}${r.status === "进行中" ? " · 进行中" : ""}</span></div></div>` : ""}
      ${done.length > 1 ? `<div class="card section"><h3>每轮被提到的比例</h3><div class="spark">${done.slice(0, 12).reverse().map((x) =>
        `<div class="spark-col" title="${esc(x.created_text)}：${x.mentioned}/${x.asked}"><span class="spark-n">${pct(x.mentioned, x.asked)}</span><i style="height:${(x.mentioned / x.asked) * 100}%"></i><span>${esc(x.created_text.slice(5, 10))}</span></div>`).join("")}</div></div>` : ""}
      ${d.answers.length ? `<div class="card section"><h3>每个问题的回答 <span class="faint" style="font-weight:400">点开看 AI 的原话和来源</span></h3>
        <table class="t"><thead><tr><th>问题</th><th class="nowrap">提到</th><th class="nowrap">引用</th><th class="nowrap">排名</th><th>回答里的品牌</th></tr></thead><tbody>${d.answers.map(ans).join("")}</tbody></table></div>
      <div class="grid two section">
        <div class="card"><h3>常被 AI 推荐的其他品牌</h3>${d.rivals.length ? bars(d.rivals, (x) => x.name, (x) => x.n) : '<div class="empty">没有</div>'}
          <p class="hint">这些就是 AI 眼里的同类，值得看看他们官网写了什么、在哪些平台上有资料。</p></div>
        <div class="card"><h3>AI 引用最多的网站</h3>${d.domains.length ? bars(d.domains, (x) => x.host, (x) => x.n) : '<div class="empty">没有</div>'}
          <p class="hint">在这些网站上有资料（B2B 平台店铺、行业目录、评测、问答），被 AI 推荐的机会更大。</p></div></div>` : ""}
      <div class="card section"><div class="card-head"><h3>要问的问题（${st.qs.length}）</h3>
        <span><button class="btn sm" id="qSuggest">AI 帮我列问题</button> <button class="btn sm primary" id="qSave">保存问题</button></span></div>
        <p class="hint">大部分写不带品牌名的问题（买家还不知道你们），少量带品牌名的检查 AI 对你们的了解对不对。改完点「保存问题」。</p>
        <div class="list" id="qList">${st.qs.map((q, i) => `<div class="list-item"><span class="tag plain">${esc(q.kind)}</span><span class="faint">${esc(q.lang)}</span>
          <span style="flex:1">${esc(q.q)}</span><button class="btn sm ghost danger" data-qdel="${i}">删除</button></div>`).join("") || '<div class="empty">还没有问题</div>'}</div>
        <div class="form-row tight" style="margin-top:10px"><select id="qKind">${["品类", "采购", "对比", "品牌"].map((k) => `<option>${k}</option>`).join("")}</select>
          <input id="qLang" value="en" maxlength="8" style="width:70px" aria-label="语言"><input class="grow" id="qText" maxlength="300" placeholder="比如：Which factories make drainage-free tent air conditioners?"><button class="btn" id="qAdd">添加</button></div></div>`;
    const redraw = () => renderGeo(g);
    page.querySelectorAll("[data-qdel]").forEach((b) => b.addEventListener("click", () => { st.qs.splice(+b.dataset.qdel, 1); redraw(); }));
    $("qAdd").addEventListener("click", () => {
      const q = $("qText").value.trim();
      if (q.length < 4) return toast("问题太短", true);
      st.qs.push({ q, lang: $("qLang").value.trim() || "en", kind: $("qKind").value });
      redraw();
    });
    $("qSave").addEventListener("click", async () => {
      try { const res = await tc("seo/geo/questions", { method: "PUT", body: { questions: st.qs } }); toast(`已保存，每轮约 ${usd(res.estimate)}`); st.qs = null; redraw(); } catch (e) { toast(e.message, true); }
    });
    $("qSuggest").addEventListener("click", async (e) => {
      e.target.disabled = true;
      e.target.innerHTML = '<span class="spin"></span>正在想（约 1 分钟）';
      let sug;
      try { sug = (await tc("seo/geo/suggest", { method: "POST" })).questions; } catch (err) { toast(err.message, true); e.target.disabled = false; e.target.textContent = "AI 帮我列问题"; return; }
      if (stale(g)) return;
      const have = new Set(st.qs.map((q) => q.q));
      const ok = await dialog({
        title: "AI 列的问题", ok: "加进去", wide: true,
        body: `<p class="hint">根据官网 llms.txt 和资料库写的，勾掉不合适的。</p><div class="list">${sug.map((q, i) => `<label class="list-item check"><input type="checkbox" data-i="${i}" ${have.has(q.q) ? "disabled" : "checked"}>
          <span class="tag plain">${esc(q.kind)}</span><span class="faint">${esc(q.lang)}</span><span style="flex:1">${esc(q.q)}</span></label>`).join("")}</div>`,
        submit: (el) => [...el.querySelectorAll("input[data-i]:checked")].map((c) => sug[+c.dataset.i]),
      });
      if (ok && ok.length) { st.qs.push(...ok); toast(`加了 ${ok.length} 个，记得保存`); }
      redraw();
    });
    page.querySelectorAll("[data-ans]").forEach((tr) => tr.addEventListener("click", () => {
      const a = d.answers.find((x) => x.id === +tr.dataset.ans);
      dialog({ title: a.question, wide: true, ok: "关闭", cancel: null,
        body: `<div class="kv" style="margin-bottom:10px"><span>${esc(d.engines[a.engine] || a.engine)}</span><span>${a.mentioned ? "提到了我们" : "没提到我们"}</span>${a.position ? `<span>排第 <b>${a.position}</b></span>` : ""}<span>花费 ${usd(a.cost)}</span></div>
          ${a.error ? `<div class="notice bad"><span>${esc(a.error)}</span></div>` : `<div class="answer geo-answer">${md(a.answer)}</div>`}
          ${a.citations.length ? `<h4 class="sub-label" style="margin:14px 0 6px">来源（${a.citations.length}）</h4><ol class="geo-cites">${a.citations.map((c) =>
            `<li><a href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">${esc(c.title || c.url)}</a> <span class="faint">${esc(new URL(c.url).hostname)}</span></li>`).join("")}</ol>` : ""}` });
    }));
  }

  async function renderSeoSettings(g) {
    page.innerHTML = loading(4);
    let d;
    try { d = await tc("seo/config"); } catch (e) {
      if (!stale(g)) page.innerHTML = errorBox("设置读取失败：" + e.message, () => renderSeoSettings(g));
      return;
    }
    if (stale(g)) return;
    const c = d.cfg, admin = isAdmin(), ro = admin ? "" : "readonly", dis = admin ? "" : "disabled";
    page.innerHTML = `<div class="card settings-form"><h3>官网</h3><div class="form">
        <div class="form-row"><label class="grow">官网网址<input name="site" maxlength="200" value="${esc(c.site)}" placeholder="https://www.example.com" ${ro}></label>
          <label>官网域名（判断 AI 有没有引用）<input name="domains" maxlength="300" value="${esc(c.domains.join(", "))}" placeholder="example.com, example.cn" ${ro}></label></div>
        <label>品牌词（判断 AI 有没有提到我们，逗号分开：品牌、公司英文名、中文名）<input name="terms" maxlength="500" value="${esc(c.brand_terms.join(", "))}" placeholder="HAFYOUNG, SpaceCool, Foshan Hanyang, 瀚泱" ${ro}></label>
        <h4 class="sub-label">GEO 监测</h4>
        <div class="form-row">${d.engines.map((e) => `<label class="check"><input type="checkbox" name="eng" value="${esc(e.id)}" ${c.engines.includes(e.id) ? "checked" : ""} ${dis}> ${esc(e.name)}</label>`).join("")}
          <label>每月预算（美元）<input name="budget" type="number" min="0" step="0.5" value="${c.budget_month}" ${ro}></label></div>
        <p class="hint">Perplexity Sonar 每问约 $0.006，DeepSeek + 网页搜索约 $0.01；${c.questions.length} 个问题每轮约 ${usd(d.estimate)}，本月已花 ${usd(d.spent)}。</p>
        <label class="check"><input type="checkbox" name="geo_weekly" ${c.geo_weekly ? "checked" : ""} ${dis}> 每周自动问一轮</label>
        <label class="check"><input type="checkbox" name="audit_weekly" ${c.audit_weekly ? "checked" : ""} ${dis}> 每周自动体检一次</label>
        ${d.pagespeed_key ? "" : '<p class="hint">体检里的手机端性能用 Google PageSpeed，没配 PAGESPEED_API_KEY 时共用 Google 的免费额度，经常测不了。</p>'}
        ${admin ? '<div class="form-actions"><span class="faint">只有管理员能改</span><button class="btn primary" id="seoSave">保存</button></div>' : ""}</div></div>
      <div class="card settings-form"><h3>访问统计</h3>
        <div class="kv" style="margin:6px 0 12px">${d.has_key ? '<span class="tag ok">已生成统计密钥</span>' : '<span class="tag bad">还没有统计密钥</span>'}
          <span>上次同步 <b>${esc(d.synced_text || "还没有")}</b></span>${d.sync_error ? `<span class="bad-text">${esc(d.sync_error)}</span>` : ""}</div>
        <p class="hint">适用于放在 Cloudflare Pages 上的官网（免费套餐够用）。统计数据先存在你们自己的 Cloudflare D1 里，平台每半小时用密钥拉一次；不用 cookie、不存 IP，不需要弹 cookie 同意框。</p>
        <ol class="steps-list">
          <li>点「下载安装包」，把里面的 <code>functions/</code>、<code>lib/</code> 放进官网项目根目录，<code>public/k.js</code> 放到网站根目录（和 index.html 同级）</li>
          <li>每个页面的 <code>&lt;/head&gt;</code> 前加一行 <code>&lt;script src="/k.js" defer&gt;&lt;/script&gt;</code></li>
          <li>Cloudflare 后台建一个 D1 数据库，在 Pages 项目「设置 → 绑定」里绑定为 <code>DB</code></li>
          <li>点「生成统计密钥」，把密钥加到 Pages 项目「设置 → 变量和机密」，名字 <code>STATS_KEY</code>，类型选「密钥」</li>
          <li>如果项目里有 <code>_routes.json</code>，include 里要有页面路径和 <code>/k/*</code>（安装包里有示例）</li>
          <li>重新部署，打开官网点几下，回到「官网流量」点「立即同步」</li></ol>
        <div class="form-actions"><a class="btn" href="${fileUrl("seo/kit.zip")}">下载安装包</a>${admin ? `<button class="btn ${d.has_key ? "" : "primary"}" id="seoKey">${d.has_key ? "换一个密钥" : "生成统计密钥"}</button>` : ""}</div></div>
      <div id="seoSearchCard"><div class="card settings-form">${loading(2)}</div></div>`;
    drawSearchSettings(g, admin, c.domains[0] || "");
    $("seoSave")?.addEventListener("click", async () => {
      const split = (s) => s.split(/[,，\n]/).map((x) => x.trim()).filter(Boolean);
      try {
        await tc("seo/config", { method: "PUT", body: { site: field(page, "site"), domains: split(field(page, "domains")), brand_terms: split(field(page, "terms")),
          engines: [...page.querySelectorAll('[name="eng"]:checked')].map((x) => x.value), budget_month: +field(page, "budget") || 0,
          geo_weekly: field(page, "geo_weekly"), audit_weekly: field(page, "audit_weekly") } });
        toast("已保存");
        renderSeoSettings(g);
      } catch (e) { toast(e.message, true); }
    });
    $("seoKey")?.addEventListener("click", async () => {
      if (d.has_key && !(await confirmBox("换一个统计密钥？", "<p>换了以后要把新密钥填到 Cloudflare 的 STATS_KEY 并重新部署，之前的密钥立刻失效。</p>", "换"))) return;
      try {
        const r = await tc("seo/key", { method: "POST" });
        await showSecret("统计密钥", [["STATS_KEY", r.key]], "只显示这一次。填到 Cloudflare Pages 项目的「变量和机密」里，类型选「密钥」。");
        renderSeoSettings(g);
      } catch (e) { toast(e.message, true); }
    });
  }

  async function drawSearchSettings(g, admin, domain) {
    const box = $("seoSearchCard");
    let d;
    try { d = await tc("seo/search?days=7"); } catch (e) { if (box) box.innerHTML = errorBox("读取失败：" + e.message, () => drawSearchSettings(g, admin, domain)); return; }
    if (stale(g) || !box) return;
    const go = d.status.google, bi = d.status.bing;
    const line = (s) => `<div class="kv" style="margin:6px 0 10px">${s.connected ? '<span class="tag ok">已接入</span>' : '<span class="tag plain">没接入</span>'}
      ${s.site ? `<span>网站 <b>${esc(s.site)}</b></span>` : ""}${s.connected ? `<span>上次同步 <b>${esc(s.synced_text || "还没有")}</b></span>` : ""}${s.error ? `<span class="bad-text">${esc(s.error)}</span>` : ""}</div>`;
    box.innerHTML = `<div class="card settings-form"><h3>搜索引擎后台</h3>
      <p class="hint">接入后能看到过去的搜索数据：网站在 Google / Bing 搜索结果里被展示、被点击了多少次，靠哪些词、排第几。只读，平台改不了你们的 Search Console。</p>
      <h4 class="sub-label">Google Search Console</h4>${line(go)}
      ${go.client_email ? `<p class="hint">服务账号：<code>${esc(go.client_email)}</code>（要在 Search Console 里加成用户）</p>` : ""}
      <ol class="steps-list">
        <li>打开 <a href="https://search.google.com/search-console" target="_blank" rel="noopener">Search Console</a>，添加资源，选「网域」，填 <code>${esc(domain || "你们的域名")}</code>；按提示到域名服务商（如西部数码）加一条 TXT 解析，回来点验证</li>
        <li>打开 <a href="https://console.cloud.google.com/" target="_blank" rel="noopener">Google Cloud</a>，新建项目，在「API 和服务」里启用 <b>Google Search Console API</b></li>
        <li>「IAM 和管理 → 服务账号」新建一个服务账号（不用给角色），进去「密钥 → 添加密钥 → JSON」，下载 JSON 文件</li>
        <li>回到 Search Console「设置 → 用户和权限 → 添加用户」，填服务账号的邮箱（xxx@xxx.iam.gserviceaccount.com），权限选「受限」</li>
        <li>在下面上传 JSON 文件；第一次会拉最近 16 个月，之后每 6 小时更新</li></ol>
      ${admin ? `<div class="form-actions"><label class="btn ${go.connected ? "" : "primary"}">${go.connected ? "换密钥文件" : "上传 JSON 密钥文件"}<input type="file" id="ssGFile" accept=".json,application/json" hidden></label>
        ${go.connected ? '<button class="btn" id="ssGSite">换网站</button><button class="btn ghost danger" id="ssGOff">断开</button>' : ""}</div>` : ""}
      <h4 class="sub-label" style="margin-top:18px">Bing Webmaster Tools</h4>${line(bi)}
      <ol class="steps-list">
        <li>用微软账号登录 <a href="https://www.bing.com/webmasters" target="_blank" rel="noopener">Bing Webmaster</a>，选「从 Google Search Console 导入」，一步导入网站和验证（先做完上面 Google 的第 1 步）</li>
        <li>右上角齿轮「设置 → API 访问 → API 密钥」，生成密钥，填到下面</li></ol>
      ${admin ? `<div class="form-row tight"><input class="grow" type="password" id="ssBKey" placeholder="${bi.connected ? "已保存，填新的会替换" : "Bing API 密钥"}" autocomplete="off"><button class="btn" id="ssBSave">保存</button>
        ${bi.connected ? '<button class="btn" id="ssBSite">换网站</button><button class="btn ghost danger" id="ssBOff">断开</button>' : ""}</div>` : ""}</div>`;
    const done = (r, what) => {
      toast(r.sites && !r.sites.length ? `${what}已保存，但账号里还看不到验证过的网站` : `${what}已接入，正在拉数据`, r.sites && !r.sites.length);
      drawSearchSettings(g, admin, domain);
    };
    $("ssGFile")?.addEventListener("change", async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      try { done(await tc("seo/search/google", { method: "PUT", body: { secret: await f.text() } }), "Google "); } catch (err) { toast(err.message, true); }
      e.target.value = "";
    });
    $("ssBSave")?.addEventListener("click", async () => {
      const k = $("ssBKey").value.trim();
      if (!k) return toast("先填密钥", true);
      try { done(await tc("seo/search/bing", { method: "PUT", body: { secret: k } }), "Bing "); } catch (err) { toast(err.message, true); }
    });
    const pickSite = async (engine) => {
      let r;
      try { r = await tc(`seo/search/${engine}/sites`); } catch (err) { return toast(err.message, true); }
      if (!r.sites.length) return toast("账号里还看不到验证过的网站", true);
      const ok = await dialog({ title: "选网站", ok: "用这个", body: `<div class="form"><label>网站<select name="site">${r.sites.map((x) => `<option>${esc(x)}</option>`).join("")}</select></label>
          <p class="hint">「sc-domain:」开头的是网域资源，包含 http、https 和带不带 www 的所有网址，选它最全。换网站会清掉已拉的数据重新拉。</p></div>`,
        submit: (el) => tc(`seo/search/${engine}/site`, { method: "PUT", body: { site: field(el, "site") } }) });
      if (ok) { toast("已换，正在重新拉数据"); drawSearchSettings(g, admin, domain); }
    };
    $("ssGSite")?.addEventListener("click", () => pickSite("google"));
    $("ssBSite")?.addEventListener("click", () => pickSite("bing"));
    for (const [id, engine, n] of [["ssGOff", "google", "Google"], ["ssBOff", "bing", "Bing"]]) {
      $(id)?.addEventListener("click", async () => {
        if (!(await confirmBox(`断开 ${n}？`, "<p>会删掉密钥和已拉的搜索数据。</p>", "断开", true))) return;
        try { await tc(`seo/search/${engine}`, { method: "DELETE" }); toast("已断开"); drawSearchSettings(g, admin, domain); } catch (err) { toast(err.message, true); }
      });
    }
  }

  boot();
})();
