"""Screenshot walkthrough of the multi-tenant platform (python3 shots.py [out_dir])."""
import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:21048/muxu/"
OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/muxushots")
OUT.mkdir(parents=True, exist_ok=True)
DATA = Path(__file__).parent / "data"
ADMIN_PW = (DATA / ".admin_password").read_text().strip()
ACC = json.loads((DATA / ".demo_accounts.json").read_text())
errors = []

MOCK_SITE = """<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>安途驾校官网</title>
<style>body{margin:0;font:16px/1.7 -apple-system,'PingFang SC','Noto Sans CJK SC',sans-serif;color:#1d2a3a;background:#f4f7fb}
header{background:#14243a;color:#fff;padding:18px 48px;display:flex;justify-content:space-between}header b{font-size:20px}
.hero{padding:80px 48px;background:linear-gradient(120deg,#14243a,#2f6fb0);color:#fff}.hero h1{font-size:44px;margin:0 0 12px}
.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:20px;padding:40px 48px}.cards div{background:#fff;border-radius:14px;padding:24px;box-shadow:0 4px 18px rgba(0,0,0,.05)}</style>
</head><body><header><b>安途驾校</b><span>首页　班型　报名　联系我们</span></header>
<section class="hero"><h1>学车不绕路，安心拿驾照</h1><p>东莞南城 · 6 万平方米训练场 · 120 台教练车</p></section>
<section class="cards"><div><h3>C1 手动挡</h3>4280 元起</div><div><h3>C2 自动挡</h3>4580 元起</div><div><h3>VIP 一对一</h3>6980 元</div></section>
<script src="%sembed.js" data-tenant="antu" data-color="#2f6fb0" async></script></body></html>""" % BASE


def watch(page, tag):
    page.on("console", lambda m: m.type == "error" and errors.append(f"[{tag}] {m.text}"))
    page.on("pageerror", lambda e: errors.append(f"[{tag}] pageerror {e}"))


def login(pg, email, pw):
    pg.goto(BASE + "console/")
    pg.wait_for_selector("#loginEmail")
    pg.fill("#loginEmail", email)
    pg.fill("#loginPw", pw)
    pg.keyboard.press("Enter")
    pg.wait_for_selector("#shell:not([hidden])", timeout=15000)


def go(pg, hash_, wait, name, full=True):
    pg.evaluate(f"location.hash = '{hash_}'")
    pg.wait_for_selector(wait, timeout=30000)
    pg.wait_for_timeout(600)
    pg.screenshot(path=OUT / name, full_page=full)


with sync_playwright() as p:
    b = p.chromium.launch()

    # customer pages, desktop: two tenants, same code
    ctx = b.new_context(viewport={"width": 1280, "height": 820}, locale="zh-CN")
    pg = ctx.new_page()
    watch(pg, "customer")
    pg.goto(BASE)
    pg.wait_for_timeout(800)
    pg.screenshot(path=OUT / "c1_muxu.png")
    pg.goto(BASE + "c/antu/")
    pg.wait_for_timeout(800)
    pg.screenshot(path=OUT / "c2_antu.png")
    pg.click("text=学车多少钱？")
    pg.wait_for_selector(".row.bot .meta", timeout=60000)
    pg.fill("#input", "你们教练凶不凶")
    pg.keyboard.press("Enter")
    pg.wait_for_selector(".row.bot >> nth=1 >> .meta", timeout=60000)
    pg.wait_for_timeout(500)
    pg.screenshot(path=OUT / "c3_antu_answers.png")
    ctx.close()

    # customer page, mobile
    ctx = b.new_context(viewport={"width": 390, "height": 780}, device_scale_factor=2, is_mobile=True, has_touch=True, locale="zh-CN")
    pg = ctx.new_page()
    watch(pg, "mobile")
    pg.goto(BASE + "c/antu/")
    pg.wait_for_timeout(800)
    pg.screenshot(path=OUT / "m1_antu.png")
    ctx.close()

    # embed widget on a mock customer website
    ctx = b.new_context(viewport={"width": 1280, "height": 820}, locale="zh-CN")
    pg = ctx.new_page()
    watch(pg, "embed")
    pg.set_content(MOCK_SITE)
    pg.wait_for_selector(".mx-btn")
    pg.wait_for_timeout(300)
    pg.screenshot(path=OUT / "e1_site.png")
    pg.click(".mx-btn")
    pg.wait_for_timeout(1500)
    pg.screenshot(path=OUT / "e2_site_open.png")
    ctx.close()

    # console as platform admin
    ctx = b.new_context(viewport={"width": 1400, "height": 900}, locale="zh-CN")
    pg = ctx.new_page()
    watch(pg, "admin")
    pg.goto(BASE + "console/")
    pg.wait_for_selector("#loginEmail")
    pg.screenshot(path=OUT / "k0_login.png")
    pg.evaluate("localStorage.setItem('mx.console.tenant', 'muxu')")
    login(pg, "admin@muxu.local", ADMIN_PW)
    go(pg, "#overview", ".score", "k1_muxu_overview.png")
    go(pg, "#tenants", "table.t", "p1_tenants.png")
    pg.click("#tnew")
    pg.wait_for_selector("#modal:not([hidden])")
    pg.fill("[name=name]", "示例客户")
    pg.fill("[name=slug]", "demo-co")
    pg.screenshot(path=OUT / "p2_new_tenant.png")
    pg.click("#modalCancel")
    go(pg, "#users", "table.t", "p3_users.png")
    pg.select_option("#tenantSel", "antu")
    pg.wait_for_selector(".score", timeout=15000)
    pg.wait_for_timeout(600)
    pg.screenshot(path=OUT / "k2_antu_overview.png", full_page=True)
    go(pg, "#kb", ".kb table", "k3_kb.png")
    go(pg, "#tests", "table.t", "k4_tests.png")
    go(pg, "#runs", "#compare table", "k5_runs.png")
    pg.click("[data-f=bad], [data-f=safe]")
    pg.wait_for_timeout(300)
    if pg.locator("#compare tbody tr").count():
        pg.click("#compare tbody tr >> nth=0")
        pg.wait_for_timeout(500)
        pg.screenshot(path=OUT / "k6_drawer.png")
        pg.keyboard.press("Escape")
    go(pg, "#gaps", ".gap, .empty", "k7_gaps.png")
    if pg.locator("[data-a=write]").count():
        pg.click("[data-a=write] >> nth=0")
        pg.wait_for_selector("#modal:not([hidden])")
        pg.wait_for_timeout(300)
        pg.screenshot(path=OUT / "k8_writeback.png")
        pg.click("#modalCancel")
    go(pg, "#settings", "#brandForm", "k9_settings_brand.png")
    for tab, wait, name in (("rules", "#rulesForm", "k10_rules.png"), ("embed", ".code", "k11_embed.png"),
                            ("members", "#sbody table", "k12_members.png"), ("usage", "#sbody table", "k13_usage.png")):
        pg.click(f"[data-st={tab}]")
        pg.wait_for_selector(wait, timeout=15000)
        pg.wait_for_timeout(400)
        pg.screenshot(path=OUT / name, full_page=True)
    ctx.close()

    # console as a tenant operator: only their tenant, read-only settings
    ctx = b.new_context(viewport={"width": 1400, "height": 900}, locale="zh-CN")
    pg = ctx.new_page()
    watch(pg, "operator")
    login(pg, "li@antu.example", ACC["li@antu.example"]["password"])
    go(pg, "#overview", ".score", "o1_operator_overview.png", full=False)
    go(pg, "#settings", "#brandForm", "o2_operator_settings.png", full=False)
    ctx.close()
    b.close()

print("errors:", errors or "none")
print("saved to", OUT)
