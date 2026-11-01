"""网站 SEO / GEO.

- 访问统计：客户官网装 site-kit（Cloudflare Pages 函数 + /k.js，不用 cookie、不存 IP），数据先存在官网自己的 D1 里，
  这里每半小时用 stats.key 拉一次增量，存进 site_hits，按 UTC 日期汇总日活、来源、页面、询盘点击、AI 爬虫来访。
- 站点体检：抓 robots.txt / sitemap / llms.txt 和页面，按 SEO、GEO 两张评分表打分，列出要改的地方。
- GEO 监测：每周拿买家会问的问题去问联网 AI（Perplexity Sonar 等），看回答有没有提到、引用我们，排第几，常被提到的是谁。
"""
import asyncio
import io
import json
import logging
import re
import secrets
import time
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urljoin, urlparse
from urllib.robotparser import RobotFileParser
from xml.etree import ElementTree

import httpx
from bs4 import BeautifulSoup

import db
import llm
import settings

log = logging.getLogger("seo")
ROOT = settings.DATA_DIR / "seo"
KIT = Path(__file__).resolve().parent / "site-kit"
SYNC_EVERY = 1800
WEEK = 7 * 86400
CONTACT_EVENTS = ("inquiry", "form", "email", "phone", "whatsapp", "quote")
AI_KINDS = ("ai_search", "ai_user", "ai_train")

ENGINES = {
    "perplexity/sonar": {"name": "Perplexity", "model": "perplexity/sonar", "body": {}},
    "web:deepseek": {"name": "DeepSeek + 网页搜索", "model": "deepseek/deepseek-v4.1-flash",
                     "body": {"plugins": [{"id": "web", "max_results": 6}]}},
}
EXTRACT_MODEL = settings.AGENT_MODEL or "deepseek/deepseek-v4.1-flash"

DEFAULT_CFG = {"site": "", "brand_terms": [], "domains": [], "questions": [], "engines": ["perplexity/sonar"],
               "geo_weekly": True, "audit_weekly": True, "budget_month": 3.0}

BOT_KIND = {
    "ai_search": ["OAI-SearchBot", "PerplexityBot", "Claude-SearchBot", "DuckAssistBot"],
    "ai_user": ["ChatGPT-User", "Claude-User", "Perplexity-User", "MistralAI-User", "meta-externalfetcher"],
    "ai_train": ["GPTBot", "ClaudeBot", "anthropic-ai", "Google-Extended", "Applebot-Extended", "Bytespider", "CCBot",
                 "meta-externalagent", "Amazonbot", "cohere-ai", "Diffbot", "Timpibot", "ImagesiftBot"],
    "search": ["Googlebot", "Google-InspectionTool", "GoogleOther", "AdsBot-Google", "Storebot-Google", "bingbot",
               "BingPreview", "Applebot", "DuckDuckBot", "YandexBot", "Baiduspider", "PetalBot", "Sogou", "YisouSpider"],
    "seo": ["AhrefsBot", "SemrushBot", "MJ12bot", "DotBot", "DataForSeoBot", "Chrome-Lighthouse"],
    "social": ["facebookexternalhit", "FacebookBot", "Twitterbot", "LinkedInBot", "WhatsApp", "TelegramBot", "Slackbot", "Discordbot"],
}
BOT_KIND_LABEL = {"ai_search": "AI 搜索", "ai_user": "AI 替用户来看", "ai_train": "AI 训练抓取", "search": "搜索引擎",
                  "seo": "SEO 工具", "social": "社交预览", "other": "其他程序"}
BOT_OF = {n: k for k, names in BOT_KIND.items() for n in names}
BOT_NOTE = {"GPTBot": "OpenAI 训练", "OAI-SearchBot": "ChatGPT 搜索索引", "ChatGPT-User": "ChatGPT 用户让它打开网页",
            "ClaudeBot": "Anthropic 训练", "Claude-User": "Claude 用户让它打开网页", "Claude-SearchBot": "Claude 搜索索引",
            "PerplexityBot": "Perplexity 搜索索引", "Perplexity-User": "Perplexity 用户让它打开网页",
            "Googlebot": "Google 搜索（也供 AI 概览）", "bingbot": "Bing 搜索（ChatGPT 联网也用 Bing）",
            "Applebot": "Apple 搜索 / Siri", "Bytespider": "字节跳动", "CCBot": "Common Crawl（很多模型的训练数据）",
            "meta-externalagent": "Meta AI 训练", "Amazonbot": "Amazon / Alexa"}

SOURCES = [  # (label, host pattern)
    ("AI", r"chatgpt\.com|openai\.com|perplexity\.ai|gemini\.google|bard\.google|copilot\.microsoft|claude\.ai|deepseek\.com"
           r"|kimi\.(com|moonshot)|doubao\.com|you\.com|phind\.com|poe\.com|meta\.ai|grok\.com|x\.ai|mistral\.ai|yuanbao|tongyi"),
    ("搜索", r"(^|\.)google\.|bing\.com|duckduckgo|yandex|baidu|yahoo|ecosia|naver|so\.com|sogou|seznam|qwant|brave\.com|startpage"),
    ("社交", r"facebook|fb\.com|instagram|linkedin|lnkd\.in|(^|\.)t\.co$|twitter|(^|\.)x\.com|tiktok|youtube|youtu\.be|reddit"
           r"|pinterest|whatsapp|wa\.me|telegram|t\.me|vk\.com|weibo|xiaohongshu"),
]
SOURCE_RE = [(lab, re.compile(p, re.I)) for lab, p in SOURCES]


class SeoError(RuntimeError):
    pass


def now():
    return time.time()


def utc_day(ts=None):
    return datetime.fromtimestamp(ts if ts is not None else now(), timezone.utc).strftime("%Y-%m-%d")


def tdir(tid):
    d = ROOT / str(int(tid))
    d.mkdir(parents=True, exist_ok=True)
    d.chmod(0o700)
    return d


def config(tid):
    row = db.q("SELECT data FROM seo_cfg WHERE tenant_id=:t", one=True, t=tid)
    return {**DEFAULT_CFG, **(db.loads(row["data"], {}) if row else {})}


def state(tid):
    row = db.q("SELECT state FROM seo_cfg WHERE tenant_id=:t", one=True, t=tid)
    return db.loads(row["state"], {}) if row else {}


def _ensure_row(tid):
    if not db.scalar("SELECT COUNT(*) FROM seo_cfg WHERE tenant_id=:t", t=tid):
        db.insert(db.seo_cfg, tenant_id=tid, data="{}", state="{}")


def save_config(tid, data):
    _ensure_row(tid)
    db.x("UPDATE seo_cfg SET data=:d WHERE tenant_id=:t", d=db.dumps({**config(tid), **data}), t=tid)


def save_state(tid, **kw):
    _ensure_row(tid)
    db.x("UPDATE seo_cfg SET state=:d WHERE tenant_id=:t", d=db.dumps({**state(tid), **kw}), t=tid)


def site_root(url):
    """https://host (no path); raises on anything that isn't a public http(s) site."""
    u = urlparse((url or "").strip())
    if u.scheme not in ("http", "https") or not u.hostname or ("." not in u.hostname and not u.port):
        raise SeoError("网址要以 https:// 开头，比如 https://www.example.com")
    return f"{u.scheme}://{u.netloc}"


def key_file(tid):
    return tdir(tid) / "stats.key"


def stats_key(tid):
    f = key_file(tid)
    return f.read_text().strip() if f.exists() else ""


def new_key(tid):
    key = secrets.token_urlsafe(32)
    f = key_file(tid)
    f.write_text(key)
    f.chmod(0o600)
    save_state(tid, last_id=0, error="")
    return key


def kit_zip():
    """site-kit as a zip, for customers to drop into their Cloudflare Pages project."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted(KIT.rglob("*")):
            if f.is_file():
                z.write(f, f.relative_to(KIT).as_posix())
    return buf.getvalue()


# ---------- sync ----------

def client(timeout=30, **kw):
    return httpx.AsyncClient(timeout=httpx.Timeout(timeout, connect=15), follow_redirects=True, **kw)


async def sync(tid):
    cfg = config(tid)
    key = stats_key(tid)
    if not cfg["site"] or not key:
        return 0
    host = urlparse(cfg["site"]).hostname
    st = state(tid)
    after = int(st.get("last_id") or 0)
    if st.get("site") != host:
        after = 0
    got = 0
    try:
        async with client() as c:
            for _ in range(50):
                r = await c.get(cfg["site"] + "/k/r", params={"after": after, "limit": 2000}, headers={"Authorization": f"Bearer {key}"})
                if r.status_code == 403:
                    raise SeoError("官网拒绝了统计密钥：Cloudflare 里的 STATS_KEY 和这里的不一样")
                if r.status_code == 404:
                    raise SeoError("官网上没有统计接口 /k/r：site-kit 还没装好或没部署")
                if r.status_code != 200 or "json" not in r.headers.get("content-type", ""):
                    raise SeoError(f"统计接口返回 {r.status_code}")
                d = r.json()
                rows = d.get("rows") or []
                if rows:
                    store(tid, host, rows)
                    after = max(int(x["id"]) for x in rows)
                    got += len(rows)
                if not d.get("more"):
                    break
    except httpx.HTTPError as e:
        save_state(tid, error=f"连不上官网：{type(e).__name__}", tried=now())
        return got
    except SeoError as e:
        save_state(tid, error=str(e), tried=now())
        return got
    save_state(tid, last_id=after, site=host, synced=now(), tried=now(), error="")
    return got


def store(tid, host, rows):
    vals = []
    for x in rows:
        ts = float(x.get("ts") or 0) / 1000
        vals.append({"tenant_id": tid, "site": host, "rid": int(x["id"]), "ts": ts, "day": utc_day(ts), "k": (x.get("k") or "")[:4],
                     "path": (x.get("path") or "")[:200], "ref": (x.get("ref") or "")[:120], "cc": (x.get("cc") or "")[:2],
                     "dev": (x.get("dev") or "")[:8], "lang": (x.get("lang") or "")[:12], "vid": (x.get("vid") or "")[:16],
                     "name": (x.get("name") or "")[:40], "utm": (x.get("utm") or "")[:60],
                     "secs": x.get("secs"), "status": x.get("status")})
    lo = min(v["rid"] for v in vals)
    with db.engine.begin() as c:
        c.execute(db.text("DELETE FROM site_hits WHERE tenant_id=:t AND site=:s AND rid>=:r"), {"t": tid, "s": host, "r": lo})
        c.execute(db.site_hits.insert(), vals)


# ---------- traffic report ----------

def source_of(ref):
    if not ref:
        return "直接访问"
    for lab, rx in SOURCE_RE:
        if rx.search(ref):
            return lab
    return "其他网站"


def bot_kind(name):
    return BOT_OF.get(name, "other")


def _days(d0, n):
    start = datetime.strptime(d0, "%Y-%m-%d")
    return [(start + timedelta(days=i)).strftime("%Y-%m-%d") for i in range(n)]


def traffic(tid, days=30):
    days = max(1, min(int(days), 90))
    today = utc_day()
    d0 = (datetime.strptime(today, "%Y-%m-%d") - timedelta(days=days - 1)).strftime("%Y-%m-%d")
    p0 = (datetime.strptime(d0, "%Y-%m-%d") - timedelta(days=days)).strftime("%Y-%m-%d")
    P = {"t": tid, "d0": d0, "p0": p0}
    W = "tenant_id=:t AND day>=:d0"
    contact = "(" + ",".join(f"'{e}'" for e in CONTACT_EVENTS) + ")"

    def totals(lo, hi_excl=None):
        cond = "tenant_id=:t AND day>=:lo" + (" AND day<:hi" if hi_excl else "")
        p = {"t": tid, "lo": lo, "hi": hi_excl}
        pv = db.q(f"SELECT COUNT(*) AS pv, COUNT(DISTINCT day || vid) AS v FROM site_hits WHERE {cond} AND k='pv'", one=True, **p)
        ev = db.q(f"SELECT COUNT(*) AS n, COUNT(DISTINCT day || vid) AS v FROM site_hits WHERE {cond} AND k='ev' AND name IN {contact}", one=True, **p)
        secs = db.scalar(f"SELECT AVG(secs) FROM site_hits WHERE {cond} AND k='end' AND secs BETWEEN 1 AND 1800", **p)
        ai = db.scalar(f"SELECT COUNT(*) FROM site_hits WHERE {cond} AND k='pv' AND ref<>''", **p)
        bots = db.q(f"SELECT name, COUNT(*) AS n FROM site_hits WHERE {cond} AND k='bot' GROUP BY name", **p)
        return {"visitors": pv["v"] or 0, "pv": pv["pv"] or 0, "contacts": ev["n"] or 0, "contact_visitors": ev["v"] or 0,
                "avg_secs": round(secs or 0), "ref_pv": ai or 0,
                "ai_bot": sum(b["n"] for b in bots if bot_kind(b["name"]) in AI_KINDS),
                "search_bot": sum(b["n"] for b in bots if bot_kind(b["name"]) == "search")}

    cur, prev = totals(d0), totals(p0, d0)
    first = db.scalar("SELECT MIN(day) FROM site_hits WHERE tenant_id=:t", t=tid) or today
    span = (datetime.strptime(today, "%Y-%m-%d") - datetime.strptime(max(d0, first), "%Y-%m-%d")).days + 1
    cur["per_day"] = round(cur["visitors"] / max(1, span), 1)
    cur["span_days"] = span
    cur["conversion"] = round(100 * cur["contact_visitors"] / cur["visitors"], 1) if cur["visitors"] else 0

    series = {d: {"day": d, "dau": 0, "pv": 0, "contacts": 0, "ai_bot": 0, "search_bot": 0} for d in _days(d0, days)}
    for r in db.q(f"SELECT day, COUNT(DISTINCT vid) AS dau, COUNT(*) AS pv FROM site_hits WHERE {W} AND k='pv' GROUP BY day", **P):
        series[r["day"]].update(dau=r["dau"], pv=r["pv"])
    for r in db.q(f"SELECT day, COUNT(*) AS n FROM site_hits WHERE {W} AND k='ev' AND name IN {contact} GROUP BY day", **P):
        series[r["day"]]["contacts"] = r["n"]
    for r in db.q(f"SELECT day, name, COUNT(*) AS n FROM site_hits WHERE {W} AND k='bot' GROUP BY day, name", **P):
        kind = bot_kind(r["name"])
        if kind in AI_KINDS:
            series[r["day"]]["ai_bot"] += r["n"]
        elif kind == "search":
            series[r["day"]]["search_bot"] += r["n"]

    # A visitor-day belongs to the source of its first page view; later reloads carry no referrer.
    landing = {}
    for r in db.q(f"SELECT day, vid, ref FROM site_hits WHERE {W} AND k='pv' ORDER BY ts", **P):
        landing.setdefault((r["day"], r["vid"]), r["ref"])
    sources, by_ref = {}, {}
    for ref in landing.values():
        s = source_of(ref)
        sources[s] = sources.get(s, 0) + 1
        if ref:
            by_ref[ref] = by_ref.get(ref, 0) + 1
    refs = sorted(({"host": h, "source": source_of(h), "visitors": v} for h, v in by_ref.items()), key=lambda x: -x["visitors"])

    def group(col, k="pv", limit=12, where=""):
        return db.q(f"SELECT {col} AS key, COUNT(*) AS n, COUNT(DISTINCT day || vid) AS v FROM site_hits WHERE {W} AND k='{k}' {where} "
                    f"GROUP BY {col} ORDER BY v DESC, n DESC LIMIT {int(limit)}", **P)

    secs_by_path = {r["path"]: round(r["s"]) for r in db.q(
        f"SELECT path, AVG(secs) AS s FROM site_hits WHERE {W} AND k='end' AND secs BETWEEN 1 AND 1800 GROUP BY path", **P)}
    pages = [{"path": r["key"], "pv": r["n"], "visitors": r["v"], "avg_secs": secs_by_path.get(r["key"], 0)} for r in group("path", limit=20)]

    bots = {}
    for r in db.q(f"SELECT name, COUNT(*) AS n, MAX(ts) AS last, COUNT(DISTINCT path) AS paths FROM site_hits WHERE {W} AND k='bot' "
                  f"GROUP BY name ORDER BY n DESC", **P):
        bots[r["name"]] = {"name": r["name"], "kind": bot_kind(r["name"]), "label": BOT_KIND_LABEL[bot_kind(r["name"])],
                           "note": BOT_NOTE.get(r["name"], ""), "n": r["n"], "last": r["last"], "paths": r["paths"], "top": []}
    for r in db.q(f"SELECT name, path, COUNT(*) AS n FROM site_hits WHERE {W} AND k='bot' GROUP BY name, path ORDER BY n DESC", **P):
        b = bots.get(r["name"])
        if b and len(b["top"]) < 4:
            b["top"].append({"path": r["path"], "n": r["n"]})
    special = {r["path"]: r["n"] for r in db.q(
        f"SELECT path, COUNT(*) AS n FROM site_hits WHERE {W} AND k='bot' AND path IN ('/llms.txt','/robots.txt','/sitemap.xml') GROUP BY path", **P)}

    recent = db.q(f"SELECT ts, day, vid, name, path, cc, dev, lang FROM site_hits WHERE {W} AND k='ev' AND name IN {contact} "
                  "ORDER BY ts DESC LIMIT 15", **P)
    for r in recent:
        first = db.q("SELECT ref, utm FROM site_hits WHERE tenant_id=:t AND day=:d AND vid=:v AND k='pv' ORDER BY ts LIMIT 1",
                     one=True, t=tid, d=r.pop("day"), v=r.pop("vid"))
        r["came_from"] = (first or {}).get("ref") or (first or {}).get("utm") or ""
        r["source"] = source_of(first["ref"]) if first and first["ref"] else "utm 链接" if first and first["utm"] else "直接访问"

    online = db.scalar("SELECT COUNT(DISTINCT vid) FROM site_hits WHERE tenant_id=:t AND k='pv' AND ts>:s", t=tid, s=now() - 1800) or 0
    return {"days": days, "from": d0, "to": today, "total": cur, "prev": prev, "online": online, "series": list(series.values()),
            "sources": sorted(({"source": k, "visitors": v} for k, v in sources.items()), key=lambda x: -x["visitors"]),
            "refs": refs[:15], "utm": [x for x in group("utm") if x["key"]], "pages": pages,
            "countries": group("cc"), "devices": group("dev", limit=5), "langs": group("lang"),
            "events": group("name", k="ev"), "bots": list(bots.values()), "bot_files": special, "recent": recent,
            "has_data": bool(db.scalar("SELECT COUNT(*) FROM site_hits WHERE tenant_id=:t", t=tid))}


# ---------- site audit ----------

AUDIT_UA = "Mozilla/5.0 (compatible; MuxuSiteAudit/1.0; site health check)"
AI_UAS = {"GPTBot": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot",
          "OAI-SearchBot": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot",
          "ClaudeBot": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
          "PerplexityBot": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)",
          "Googlebot": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
          "bingbot": "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)"}
ROBOT_NAMES = ["GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "PerplexityBot", "Google-Extended", "Googlebot", "bingbot", "CCBot"]
UNIT_RX = re.compile(r"\d[\d,.]*\s?(?:BTU|W|kW|Wh|kWh|V|Ah|mAh|A|Hz|dB|dBA|kg|g|lbs?|mm|cm|m|in|ft|m²|㎡|m³|L|°C|℃|°F|%|h|hrs?|min|"
                     r"pcs|units?|sets?|days?|years?|台|天|年|小时|平方米|万)\b", re.I)
CERT_RX = re.compile(r"\b(CE|FCC|UL|ETL|RoHS|ISO\s?9001|ISO\s?14001|CB|SAA|KC|PSE|UKCA|BSCI|SGS|TÜV|TUV|CCC|ERP|REACH)\b")
BLOG_RX = re.compile(r"/(blog|blogs|news|guide|guides|article|articles|insights|resources|how-to|faq)s?(/|$)", re.I)


async def fetch(c, url, ua=AUDIT_UA, method="GET"):
    t = time.monotonic()
    try:
        r = await c.request(method, url, headers={"User-Agent": ua, "Accept-Language": "en"})
        return {"url": url, "final": str(r.url), "status": r.status_code, "ms": round((time.monotonic() - t) * 1000),
                "type": r.headers.get("content-type", ""), "xrobots": r.headers.get("x-robots-tag", ""),
                "text": r.text if method == "GET" and len(r.content) < 3_000_000 else "", "redirects": len(r.history)}
    except httpx.HTTPError as e:
        return {"url": url, "final": url, "status": 0, "ms": round((time.monotonic() - t) * 1000), "error": type(e).__name__,
                "text": "", "type": "", "xrobots": "", "redirects": 0}


def ld_items(soup):
    out, bad = [], 0
    for s in soup.find_all("script", type="application/ld+json"):
        try:
            v = json.loads(s.string or s.get_text() or "")
        except ValueError:
            bad += 1
            continue
        stack = [v]
        while stack:
            x = stack.pop()
            if isinstance(x, list):
                stack.extend(x)
            elif isinstance(x, dict):
                if "@type" in x:
                    out.append(x)
                stack.extend(v2 for k2, v2 in x.items() if k2 != "@context" and isinstance(v2, (list, dict)))
    return out, bad


def types_of(item):
    t = item.get("@type")
    return set(t if isinstance(t, list) else [t])


def visible_text(soup):
    s = BeautifulSoup(str(soup), "html.parser")
    for t in s(["script", "style", "noscript", "template", "svg"]):
        t.decompose()
    return re.sub(r"\s+", " ", s.get_text(" ")).strip()


def word_count(text):
    cjk = len(re.findall(r"[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]", text))
    return len(re.findall(r"[A-Za-zÀ-ÿĀ-žА-я\u0600-\u06ff]+(?:['’-][A-Za-zÀ-ÿ]+)*", text)) + cjk // 2


def parse_page(res, host):
    soup = BeautifulSoup(res["text"], "html.parser")
    head_meta = lambda **kw: (soup.find("meta", attrs=kw) or {}).get("content", "") if soup.find("meta", attrs=kw) else ""
    title = (soup.title.string or "").strip() if soup.title and soup.title.string else ""
    canon = soup.find("link", rel=lambda v: v and "canonical" in v)
    alts = [l.get("hreflang") for l in soup.find_all("link", rel=lambda v: v and "alternate" in v) if l.get("hreflang")]
    items, bad = ld_items(soup)
    imgs = soup.find_all("img")
    text = visible_text(soup)
    links = set()
    for a in soup.find_all("a", href=True):
        u = urljoin(res["final"], a["href"]).split("#")[0]
        if urlparse(u).hostname == host and urlparse(u).scheme in ("http", "https"):
            links.add(u)
    heads = [h.get_text(" ", strip=True) for h in soup.find_all(["h2", "h3"])]
    org = next((i for i in items if types_of(i) & {"Organization", "Corporation", "LocalBusiness", "Manufacturer"}), None)
    products = [i for i in items if "Product" in types_of(i)]
    faq = next((i for i in items if "FAQPage" in types_of(i)), None)
    robots_meta = head_meta(name="robots").lower()
    return {
        "url": res["url"], "final": res["final"], "status": res["status"], "ms": res["ms"], "title": title,
        "desc": head_meta(name="description").strip(), "lang": (soup.html or {}).get("lang", "") if soup.html else "",
        "canonical": canon.get("href", "") if canon else "", "hreflang": alts,
        "noindex": "noindex" in robots_meta or "noindex" in res.get("xrobots", "").lower(),
        "h1": [h.get_text(" ", strip=True)[:120] for h in soup.find_all("h1")], "subheads": len(heads),
        "questions": sum(1 for h in heads if h.rstrip().endswith(("?", "？"))),
        "viewport": bool(soup.find("meta", attrs={"name": "viewport"})),
        "og": {k: bool(head_meta(property=f"og:{k}")) for k in ("title", "description", "image")},
        "twitter": bool(head_meta(name="twitter:card")),
        "ld_types": sorted({t for i in items for t in types_of(i) if isinstance(t, str)}), "ld_bad": bad,
        "org": {k: bool(org.get(k)) for k in ("name", "legalName", "alternateName", "logo", "url", "sameAs", "telephone", "email", "address",
                                               "contactPoint", "foundingDate")} if org else None,
        "same_as": len(org.get("sameAs") or []) if org and isinstance(org.get("sameAs"), list) else (1 if org and org.get("sameAs") else 0),
        "products": len(products), "products_full": sum(1 for p in products if p.get("brand") and (p.get("model") or p.get("sku"))),
        "products_specs": sum(1 for p in products if p.get("additionalProperty") or p.get("weight") or p.get("width")),
        "products_offers": sum(1 for p in products if p.get("offers")),
        "faq": len(faq.get("mainEntity") or []) if faq else 0,
        "imgs": len(imgs), "imgs_noalt": sum(1 for i in imgs if not (i.get("alt") or "").strip()),
        "tables": len(soup.find_all("table")), "words": word_count(text), "facts": len(UNIT_RX.findall(text)),
        "certs": sorted(set(m.group(1).upper().replace(" ", "") for m in CERT_RX.finditer(text))),
        "email": bool(re.search(r"[\w.+-]+@[\w-]+\.[\w.]+", text)) or bool(soup.find("a", href=re.compile(r"^mailto:"))),
        "phone": bool(soup.find("a", href=re.compile(r"^tel:"))) or bool(re.search(r"\+\d[\d\s()-]{7,}", text)),
        "address": bool(org and org.get("address")) or bool(re.search(r"\b(road|street|avenue|district|province|building|room|"
                                                                       r"industrial|zone|town|city)\b|路|号|区|镇|省", text, re.I)),
        "company_facts": bool(re.search(r"\b(founded|established|since)\s+(in\s+)?(19|20)\d\d\b|成立于|始于|\d[\d,]*\s?(m²|㎡|square met)", text, re.I)),
        "links": sorted(links)[:200],
    }


def robots_check(text, url):
    rp = RobotFileParser()
    rp.parse(text.splitlines())
    return {n: rp.can_fetch(n, url) for n in ROBOT_NAMES}


def sitemap_urls(text):
    try:
        root = ElementTree.fromstring(text.encode() if isinstance(text, str) else text)
    except ElementTree.ParseError:
        return None, False
    ns = "{http://www.sitemaps.org/schemas/sitemap/0.9}"
    locs = [e.text.strip() for e in root.iter(f"{ns}loc") if e.text]
    return locs, root.tag.endswith("sitemapindex")


async def pagespeed(c, url):
    """Google PageSpeed Insights, mobile. Without PAGESPEED_API_KEY it shares Google's anonymous daily quota and often gets 429."""
    params = [("url", url), ("strategy", "mobile"), ("category", "performance"), ("category", "seo"),
              ("category", "accessibility"), ("category", "best-practices")]
    if settings.secret("PAGESPEED_API_KEY"):
        params.append(("key", settings.secret("PAGESPEED_API_KEY")))
    try:
        r = await c.get("https://www.googleapis.com/pagespeedonline/v5/runPagespeed", timeout=120, params=params)
        if r.status_code != 200:
            return {"error": "Google 免费额度用完了，配 PAGESPEED_API_KEY 后每次都能测" if r.status_code == 429 else f"PageSpeed 返回 {r.status_code}"}
        d = r.json()
        cats = d["lighthouseResult"]["categories"]
        au = d["lighthouseResult"]["audits"]
        return {"performance": round(100 * (cats["performance"]["score"] or 0)), "seo": round(100 * (cats["seo"]["score"] or 0)),
                "accessibility": round(100 * (cats["accessibility"]["score"] or 0)),
                "best_practices": round(100 * (cats["best-practices"]["score"] or 0)),
                "lcp": au.get("largest-contentful-paint", {}).get("displayValue", ""), "cls": au.get("cumulative-layout-shift", {}).get("displayValue", ""),
                "tbt": au.get("total-blocking-time", {}).get("displayValue", "")}
    except (httpx.HTTPError, KeyError, ValueError, TypeError):
        return None


class Card:
    """One score table: add(dimension, points, max, note, issue) collects scores and the fixes worth doing."""

    def __init__(self):
        self.dims, self.issues = {}, []

    def add(self, dim, got, out_of, ok_note, fix=None, sev="中"):
        got = max(0, min(out_of, round(got, 1)))
        d = self.dims.setdefault(dim, {"name": dim, "got": 0, "max": 0, "items": []})
        d["got"] += got
        d["max"] += out_of
        d["items"].append({"text": ok_note, "got": got, "max": out_of})
        if fix and got < out_of:
            self.issues.append({"dim": dim, "sev": sev, "text": fix, "lost": round(out_of - got, 1)})

    def total(self):
        return round(sum(d["got"] for d in self.dims.values()) * 100 / max(1, sum(d["max"] for d in self.dims.values())))


def score(site, pages, robots, sitemap, llms, bots, nf, http_ok, broken, psi):
    home = pages[0]
    ok = [p for p in pages if p["status"] == 200]
    n = max(1, len(ok))
    frac = lambda f: sum(1 for p in ok if f(p)) / n
    all_items = {t for p in ok for t in p["ld_types"]}
    org = next((p["org"] for p in ok if p["org"]), None)
    same_as = max((p["same_as"] for p in ok), default=0)
    facts = sum(p["facts"] for p in ok)
    certs = sorted({c for p in ok for c in p["certs"]})
    faq = max((p["faq"] for p in ok), default=0)
    sm_urls = sitemap.get("urls") or []

    s = Card()
    D = "抓取与收录"
    s.add(D, 4 if robots["status"] == 200 and robots["checks"].get("Googlebot") else (2 if robots["status"] != 200 else 0), 4,
          "robots.txt 可访问且放行搜索引擎", "robots.txt 缺失或挡住了 Googlebot：放行搜索引擎，并写上 Sitemap 地址", "高")
    s.add(D, 4 if sm_urls and sitemap.get("ok200", 0) == len(sm_urls) else (2 if sm_urls else 0), 4,
          f"sitemap 有 {len(sm_urls)} 个网址", "没有可用的 sitemap.xml，或里面有打不开的网址：生成 sitemap 并在 robots.txt 里声明", "高")
    s.add(D, 4 * (1 - frac(lambda p: p["noindex"])), 4, "页面没有 noindex", "有页面带 noindex，搜索引擎不会收录：去掉 noindex", "高")
    s.add(D, 4 * frac(lambda p: p["canonical"]), 4, "页面都有 canonical", "部分页面没有 canonical：每页写上自己的规范网址")
    s.add(D, (2 if nf == 404 else 0) + (0 if http_ok is False else 2), 4,
          "不存在的网址返回真 404，http 跳到 https" + ("（http 跳转没测成）" if http_ok is None else ""),
          ("不存在的网址没有返回 404（软 404）；" if nf != 404 else "") + ("http 没有 301 到 https" if http_ok is False else ""))
    D = "页面元素（标题 / 描述 / H 标签）"
    s.add(D, 6 * frac(lambda p: p["title"]) + 4 * frac(lambda p: 15 <= len(p["title"]) <= 65), 10, "标题齐全、长度合适",
          "标题缺失或太长 / 太短：每页 15–65 个字符，带品类词和品牌", "高")
    s.add(D, 6 * frac(lambda p: p["desc"]) + 4 * frac(lambda p: 50 <= len(p["desc"]) <= 170), 10, "描述齐全、长度合适",
          "meta description 缺失或长度不合适：每页 50–170 字符，写清卖什么、给谁、有什么区别")
    s.add(D, 5 * frac(lambda p: len(p["h1"]) == 1), 5, "每页一个 H1", "有页面没有 H1 或有多个 H1：每页一个，写主关键词")
    s.add(D, 2 * frac(lambda p: p["lang"]), 2, "html 标了语言", "<html> 没有 lang 属性")
    imgs = sum(p["imgs"] for p in ok)
    s.add(D, 3 * (1 - sum(p["imgs_noalt"] for p in ok) / imgs) if imgs else 3, 3, "图片有 alt", "有图片缺 alt 文字：用一句话描述图片里的产品或场景", "低")
    D = "内容"
    avg_words = sum(p["words"] for p in ok) / n
    s.add(D, 10 if avg_words >= 800 else 6 if avg_words >= 400 else 3 if avg_words >= 200 else 0, 10, f"每页平均约 {round(avg_words)} 词",
          "正文偏少：写清参数、用途、对比、FAQ，主要页面至少 400–800 词")
    pages_n = len(sm_urls) or len(ok)
    s.add(D, 6 if pages_n >= 10 else 3 if pages_n >= 3 else 0, 6, f"可收录网址 {pages_n} 个",
          "可收录的网址太少：每个型号单独做详情页，加选购指南 / 博客", "中")
    s.add(D, 4 if home["subheads"] >= 6 else 2 if home["subheads"] >= 3 else 0, 4, "有清楚的小标题结构", "首页小标题（H2/H3）太少，内容分块不清楚", "低")
    D = "技术与移动端"
    s.add(D, 3 if home["viewport"] else 0, 3, "适配手机（viewport）", "没有 viewport，手机上显示不正常", "高")
    avg_ms = sum(p["ms"] for p in ok) / n
    s.add(D, 4 if avg_ms < 800 else 2 if avg_ms < 2000 else 0, 4, f"平均响应约 {round(avg_ms)} ms（从本平台测）", "页面响应慢：开 CDN、压缩图片、减少重定向")
    if psi and "performance" in psi:
        p = psi["performance"]
        s.add(D, 5 if p >= 90 else 4 if p >= 70 else 2 if p >= 50 else 1, 5, f"PageSpeed 移动端性能 {p}",
              f"移动端性能 {p} 分（LCP {psi['lcp']}）：压缩首屏图片、推迟非必要脚本")
    s.add(D, 3 if not broken else max(0, 3 - len(broken)), 3, "站内链接没有死链", f"有 {len(broken)} 个站内链接打不开：修好或去掉", "中")
    D = "结构化数据与社交分享"
    s.add(D, 3 if all_items else 0, 3, "有 JSON-LD 结构化数据", "没有结构化数据：至少加 Organization、Product、FAQPage", "高")
    s.add(D, 3 if org else 0, 3, "有 Organization", "没有 Organization 结构化数据")
    s.add(D, 3 if "Product" in all_items else 0, 3, "有 Product", "没有 Product 结构化数据：每个型号一个，写品牌、型号、描述")
    s.add(D, 2 if all_items & {"FAQPage", "BreadcrumbList"} else 0, 2, "有 FAQPage / 面包屑", "没有 FAQPage 结构化数据", "低")
    s.add(D, 2 * frac(lambda p: all(p["og"].values())) + (1 if home["twitter"] else 0) + (0 if any(p["ld_bad"] for p in ok) else 1), 4,
          "Open Graph / Twitter Card 齐全，JSON-LD 能解析", "分享卡片（og:title / og:description / og:image）不全，或 JSON-LD 有语法错误", "低")

    g = Card()
    D = "AI 爬虫可访问性"
    rc = robots["checks"]
    ai_names = ["GPTBot", "OAI-SearchBot", "ClaudeBot", "PerplexityBot", "Google-Extended"]
    blocked = [x for x in ai_names if not rc.get(x, True)]
    g.add(D, 8 * (1 - len(blocked) / len(ai_names)), 8, "robots.txt 放行主要 AI 爬虫",
          f"robots.txt 挡住了 {'、'.join(blocked)}：想被 AI 搜索引用，至少放行 OAI-SearchBot、PerplexityBot、Claude-SearchBot", "高")
    fine = [k for k, v in bots.items() if v == 200]
    g.add(D, 4 * len(fine) / max(1, len(bots)), 4, "用 AI 爬虫身份访问首页能打开",
          f"用 {'、'.join(k for k in bots if k not in fine)} 身份访问被拒（{', '.join(str(v) for k, v in bots.items() if k not in fine)}）："
          "检查 Cloudflare 的 Bot Fight Mode / WAF 是否拦了 AI 爬虫", "高")
    g.add(D, 4 if home["words"] >= 200 else 2 if home["words"] >= 80 else 0, 4, "正文是服务端直出的",
          "首页 HTML 里几乎没有正文（可能全靠 JavaScript 渲染），AI 爬虫大多不执行脚本", "高")
    lw = word_count(llms.get("text", "")) if llms.get("status") == 200 else 0
    g.add(D, 4 if lw >= 100 else 2 if lw else 0, 4, f"有 llms.txt（约 {lw} 词）", "没有 /llms.txt：用一页纯文本写清公司、品牌、型号、联系方式，方便 AI 读", "低")
    D = "品牌实体清晰度"
    o = org or {}
    g.add(D, (4 if o.get("name") else 0) + (3 if o.get("legalName") or o.get("alternateName") else 0) + (3 if o.get("url") else 0)
          + (2 if o.get("logo") else 0), 12, "Organization 写了名称、法定名 / 别名、网址、Logo",
          "Organization 不完整：写上 legalName（工商注册名）、alternateName（品牌名、中文名）、url、logo", "中")
    g.add(D, 5 if same_as >= 3 else 3 if same_as else 0, 5, f"sameAs 链接 {same_as} 个",
          "没有 sameAs：在 Organization 里列出 LinkedIn、阿里巴巴国际站、YouTube、Facebook 等官方账号，AI 靠它确认是同一家公司", "中")
    g.add(D, 3 if o.get("telephone") or o.get("email") or o.get("contactPoint") else 0, 3, "结构化数据里有联系方式",
          "Organization 里没有电话 / 邮箱", "低")
    D = "可被引用的事实内容"
    g.add(D, 15 if facts >= 30 else 10 if facts >= 15 else 5 if facts >= 5 else 0, 15, f"页面上有约 {facts} 个带单位的数字",
          "带单位的硬参数太少（功率、制冷量、噪音、尺寸、重量、电池、交期、起订量）：AI 回答里引用的大多是这类数字", "高")
    g.add(D, 5 if any(p["tables"] for p in ok) else 0, 5, "有参数表", "没有参数表：每个型号一张表，AI 和买家都容易对比", "中")
    g.add(D, 5 if any(p["products_specs"] for p in ok) else 0, 5, "Product 结构化数据带参数",
          "Product 结构化数据里没有参数（additionalProperty、weight 等）", "低")
    D = "结构化数据"
    g.add(D, 5 if any(p["products_full"] for p in ok) else 0, 5, "Product 写了品牌和型号", "Product 缺 brand 或 model", "中")
    g.add(D, 5 if faq else 0, 5, f"FAQPage {faq} 问", "没有 FAQPage：把买家常问的问题和答案标出来", "中")
    g.add(D, 2 if all_items & {"VideoObject", "Article", "BlogPosting", "HowTo", "ImageObject"} else 0, 2, "有视频 / 文章类结构化数据",
          "没有 VideoObject / Article 结构化数据", "低")
    g.add(D, 3 if not any(p["ld_bad"] for p in ok) and all_items else 0, 3, "JSON-LD 能正常解析", "JSON-LD 有语法错误或不存在", "中")
    D = "问答与专题内容"
    g.add(D, 5 if faq >= 5 or sum(p["questions"] for p in ok) >= 5 else 2 if faq or any(p["questions"] for p in ok) else 0, 5,
          "有 5 个以上问答", "问答太少：写 5–10 个买家真会问的问题（排水、电压、噪音、起订量、交期、认证）", "中")
    blog = sum(1 for u in sm_urls if BLOG_RX.search(urlparse(u).path))
    g.add(D, 5 if blog >= 3 else 2 if blog else 0, 5, f"选购指南 / 博客 {blog} 篇",
          "没有选购指南或博客：写 3–5 篇，例如「帐篷空调怎么选」「免排水制冷原理」，每篇引用自家型号参数", "中")
    D = "信任信号"
    g.add(D, (2 if any(p["phone"] for p in ok) else 0) + (1 if any(p["email"] for p in ok) else 0) + (2 if any(p["address"] for p in ok) else 0), 5,
          "有电话、邮箱、地址", "页面上缺电话、邮箱或详细地址", "中")
    g.add(D, 3 if certs else 0, 3, f"提到认证：{'、'.join(certs) or '无'}", "没有写认证（CE / FCC / UL / ISO 9001 等）：有就写上编号或证书图", "中")
    g.add(D, 2 if any(p["company_facts"] for p in ok) else 0, 2, "有成立年份 / 工厂面积等公司事实",
          "没有成立年份、工厂面积、产能、出口国家等公司事实", "低")
    return s, g


async def audit(tid, aid):
    cfg = config(tid)
    site = cfg["site"]
    host = urlparse(site).hostname
    async with client(25) as c:
        robots, llms, home_http, nf = await asyncio.gather(fetch(c, site + "/robots.txt"), fetch(c, site + "/llms.txt"),
                                                           fetch(c, f"http://{urlparse(site).netloc}/"),
                                                           fetch(c, site + f"/__missing-{secrets.token_hex(4)}"))
        rtext = robots["text"] if robots["status"] == 200 else ""
        sm_link = next((l.split(":", 1)[1].strip() for l in rtext.splitlines() if l.lower().startswith("sitemap:")), site + "/sitemap.xml")
        sm = await fetch(c, sm_link)
        urls, is_index = sitemap_urls(sm["text"]) if sm["status"] == 200 else (None, False)
        if is_index and urls:
            subs = await asyncio.gather(*[fetch(c, u) for u in urls[:5]])
            urls = [u for r in subs if r["status"] == 200 for u in (sitemap_urls(r["text"])[0] or [])]
        urls = [u for u in (urls or []) if urlparse(u).hostname == host]
        want = list(dict.fromkeys([site + "/"] + urls))[:25]
        sem = asyncio.Semaphore(4)

        async def one(u):
            async with sem:
                return await fetch(c, u)
        res = await asyncio.gather(*[one(u) for u in want])
        pages = [parse_page(r, host) for r in res if r["status"] == 200 and "html" in r["type"]]
        if not pages:
            raise SeoError(f"首页打不开（{res[0].get('status') or res[0].get('error')}）")
        ok200 = sum(1 for u, r in zip(want, res) if u in urls and r["status"] == 200)
        unchecked = sorted({l for p in pages for l in p["links"]} - set(want) - {site, site + "/"})[:40]
        linkres = await asyncio.gather(*[one(u) for u in unchecked])
        broken = [{"url": r["url"], "status": r["status"] or r.get("error")} for r in linkres if not r["status"] or r["status"] >= 400]
        botres = await asyncio.gather(*[fetch(c, site + "/", ua) for ua in AI_UAS.values()])
        bots = {k: r["status"] for k, r in zip(AI_UAS, botres)}
        psi = await pagespeed(c, site + "/")
    robots_info = {"status": robots["status"], "checks": robots_check(rtext, site + "/") if rtext else {n: True for n in ROBOT_NAMES},
                   "sitemap_declared": "sitemap:" in rtext.lower()}
    sitemap = {"url": sm_link, "status": sm["status"], "urls": urls, "ok200": ok200}
    # an HTTP proxy in front of this server may answer plain http itself (502 etc.); then the redirect is unknown
    http_ok = True if home_http["final"].startswith("https://") else None if not home_http["status"] or home_http["status"] >= 500 else False
    s, g = score(site, pages, robots_info, sitemap, {"status": llms["status"], "text": llms["text"]}, bots, nf["status"], http_ok, broken, psi)
    for p in pages:
        p.pop("links", None)
    sev = {"高": 0, "中": 1, "低": 2}
    data = {"site": site, "pages": pages, "robots": robots_info, "sitemap": {**sitemap, "urls": urls[:50], "count": len(urls)},
            "llms": {"status": llms["status"], "words": word_count(llms["text"]) if llms["status"] == 200 else 0},
            "bots": bots, "not_found": nf["status"], "http_to_https": http_ok, "broken": broken[:20], "psi": psi,
            "seo": list(s.dims.values()), "geo": list(g.dims.values()),
            "issues": sorted([{**i, "card": "SEO"} for i in s.issues] + [{**i, "card": "GEO"} for i in g.issues],
                             key=lambda i: (sev[i["sev"]], -i["lost"]))}
    db.x("UPDATE seo_audits SET status='完成', seo=:s, geo=:g, data=:d, finished=:f WHERE id=:i",
         s=s.total(), g=g.total(), d=db.dumps(data), f=now(), i=aid)


# ---------- GEO ----------

QUESTION_PROMPT = """你是外贸 B2B 的 GEO（AI 搜索优化）顾问。下面是一家公司的资料。请写 {n} 个海外买家会去问 ChatGPT、Perplexity 这类 AI 搜索的问题，
用来检查 AI 的回答里会不会推荐这家公司。

要求：
- 大部分（约 70%）是不带品牌名的品类问题：找工厂 / 供应商、按场景选型、按参数找产品、OEM 定制、批发起订量
- 约 15% 是对比问题（这类产品哪家好、和知名品牌比）；约 15% 带品牌名，检查 AI 对这家公司的了解
- 用买家的口吻，具体，像真人会搜的那样；不要编造这家公司没有的产品
- 主要用英文；如果资料显示主要市场有德语、法语、西班牙语等，可以有 2–4 个用那种语言
- kind 只能是：品类、采购、对比、品牌

只输出 JSON：{{"questions": [{{"q": "...", "lang": "en", "kind": "品类"}}]}}

公司资料：
{facts}"""

EXTRACT_PROMPT = """下面是 AI 搜索对一个买家问题的回答。按出现顺序列出回答里提到或推荐的品牌 / 公司名（不要产品型号、不要网站名，同一家只列一次）。
只输出 JSON：{{"brands": ["..."]}}

回答：
{answer}"""


def month_start():
    d = datetime.now(timezone.utc)
    return datetime(d.year, d.month, 1, tzinfo=timezone.utc).timestamp()


def month_spent(tid):
    return float(db.scalar("SELECT COALESCE(SUM(cost), 0) FROM geo_runs WHERE tenant_id=:t AND created>=:m", t=tid, m=month_start()) or 0)


def estimate(cfg):
    per = {"perplexity/sonar": 0.0065, "web:deepseek": 0.011}
    return round(len(cfg["questions"]) * sum(per.get(e, 0.01) for e in cfg["engines"]), 3)


def brand_terms(cfg):
    terms = [t.strip() for t in cfg["brand_terms"] if t.strip()]
    return terms + [d.strip().lower() for d in cfg["domains"] if d.strip()]


def mentioned(text, terms):
    low = text.lower()
    hits = []
    for t in terms:
        rx = re.compile(r"(?<![\w-])" + re.escape(t.lower()) + r"(?![\w-])") if re.match(r"^[\w .&-]+$", t) else re.compile(re.escape(t.lower()))
        m = rx.search(low)
        if m:
            hits.append(m.start())
    return min(hits) if hits else None


def is_ours(name, terms):
    n = name.lower()
    return any(t.lower() in n or n in t.lower() for t in terms if len(t) >= 3 or not t.isascii())


async def ask(engine, question):
    e = ENGINES[engine]
    body = {"model": e["model"], "messages": [{"role": "user", "content": question}], "usage": {"include": True}, **e["body"]}
    async with client(120) as c:
        r = await c.post(settings.LLM_BASE_URL + "/chat/completions", json=body, headers={"Authorization": f"Bearer {settings.llm_key()}"})
    d = r.json()
    if "choices" not in d:
        raise SeoError((d.get("error") or {}).get("message") or f"HTTP {r.status_code}")
    m = d["choices"][0]["message"]
    cites, seen = [], set()
    for a in m.get("annotations") or []:
        u = (a.get("url_citation") or {}).get("url") or ""
        if u and u not in seen:
            seen.add(u)
            cites.append({"url": u, "title": ((a.get("url_citation") or {}).get("title") or "")[:160]})
    return (m.get("content") or "").strip(), cites, float((d.get("usage") or {}).get("cost") or 0)


async def analyze(tid, answer, cites, cfg):
    terms = brand_terms(cfg)
    domains = [d.strip().lower().removeprefix("www.") for d in cfg["domains"] if d.strip()]
    pos_text = mentioned(answer, terms)
    cited = any((urlparse(c["url"]).hostname or "").lower().removeprefix("www.").endswith(tuple(domains)) for c in cites) if domains else False
    brands = []
    try:
        brands = (await llm.chat_json([{"role": "user", "content": EXTRACT_PROMPT.format(answer=answer[:6000])}],
                                      tenant_id=tid, kind="geo", model=EXTRACT_MODEL)).get("brands") or []
        brands = [str(b).strip()[:60] for b in brands if str(b).strip()][:20]
    except llm.LLMError as e:
        log.warning("geo extract: %s", e)
    position = next((i + 1 for i, b in enumerate(brands) if is_ours(b, terms)), None)
    if pos_text is not None and position is None:
        position = len([b for b in brands if answer.lower().find(b.lower()) != -1 and answer.lower().find(b.lower()) < pos_text]) + 1
    return pos_text is not None or cited, cited, position, brands


async def geo_run(tid, rid):
    cfg = config(tid)
    asked = hit = cites_n = 0
    cost = 0.0
    for q in cfg["questions"]:
        for eng in cfg["engines"]:
            if eng not in ENGINES:
                continue
            row = {"run_id": rid, "tenant_id": tid, "question": q["q"], "qkind": q.get("kind", ""), "lang": q.get("lang", ""),
                   "engine": eng, "created": now()}
            try:
                answer, cites, c = await ask(eng, q["q"])
                m, cited, position, brands = await analyze(tid, answer, cites, cfg)
                row.update(answer=answer[:12000], citations=db.dumps(cites[:30]), cost=c, mentioned=m, cited=cited,
                           position=position, brands=db.dumps(brands))
                cost += c
                asked += 1
                hit += m
                cites_n += cited
            except (SeoError, httpx.HTTPError, ValueError) as e:
                row.update(error=str(e)[:300])
            db.insert(db.geo_answers, **row)
            db.x("UPDATE geo_runs SET asked=:a, mentioned=:m, cited=:c, cost=:o WHERE id=:i", a=asked, m=hit, c=cites_n, o=cost, i=rid)
    db.x("UPDATE geo_runs SET status=:s, finished=:f, error=:e WHERE id=:i", s="完成" if asked else "出错", f=now(),
         e="" if asked else "一个问题都没问成，看看模型密钥", i=rid)


def geo_report(tid, run_id=None):
    runs = db.q("SELECT * FROM geo_runs WHERE tenant_id=:t ORDER BY id DESC LIMIT 12", t=tid)
    run = next((r for r in runs if r["id"] == run_id), None) if run_id else next((r for r in runs if r["status"] != "进行中"), runs[0] if runs else None)
    answers = db.q("SELECT * FROM geo_answers WHERE run_id=:r ORDER BY id", r=run["id"]) if run else []
    rivals = {}
    cfg = config(tid)
    terms = brand_terms(cfg)
    for a in answers:
        a["brands"] = db.loads(a["brands"], [])
        a["citations"] = db.loads(a["citations"], [])
        for i, b in enumerate(a["brands"]):
            if not is_ours(b, terms):
                r = rivals.setdefault(b.lower(), {"name": b, "n": 0, "first": 0})
                r["n"] += 1
                r["first"] += i == 0
    domains = {}
    for a in answers:
        for c in a["citations"]:
            h = (urlparse(c["url"]).hostname or "").removeprefix("www.")
            domains[h] = domains.get(h, 0) + 1
    return {"runs": runs, "run": run, "answers": answers, "rivals": sorted(rivals.values(), key=lambda r: (-r["n"], -r["first"]))[:15],
            "domains": sorted(({"host": k, "n": v} for k, v in domains.items()), key=lambda x: -x["n"])[:15]}


async def suggest_questions(tid, n=20):
    t = db.q("SELECT name, brand, truth_extra FROM tenants WHERE id=:t", one=True, t=tid)
    cfg = config(tid)
    brand = db.loads(t["brand"], {})
    facts = [f"公司：{t['name']}", f"品牌词：{', '.join(cfg['brand_terms'])}", f"官网：{cfg['site']}",
             "介绍：" + " / ".join(x for x in [*brand.get("headline", []), brand.get("lead", "")] if x)]
    if cfg["site"]:
        async with client(20) as c:
            r = await fetch(c, cfg["site"] + "/llms.txt")
        if r["status"] == 200 and "html" not in r["type"]:
            facts.append("官网 llms.txt：\n" + r["text"][:6000])
    facts.append("资料摘录：\n" + (t["truth_extra"] or "")[:5000])
    d = await llm.chat_json([{"role": "user", "content": QUESTION_PROMPT.format(n=n, facts="\n".join(facts))}], tenant_id=tid, kind="geo",
                            temperature=0.4)
    out = []
    for q in d.get("questions") or []:
        text = str(q.get("q") or "").strip()
        if 8 <= len(text) <= 300:
            out.append({"q": text, "lang": str(q.get("lang") or "en")[:8], "kind": q.get("kind") if q.get("kind") in ("品类", "采购", "对比", "品牌") else "品类"})
    return out[:40]


# ---------- background ----------

running = set()


def start_audit(tid, by=""):
    if ("audit", tid) in running:
        raise SeoError("体检正在进行")
    cfg = config(tid)
    if not cfg["site"]:
        raise SeoError("先在设置里填官网网址")
    aid = db.insert(db.seo_audits, tenant_id=tid, site=cfg["site"], status="进行中", by=by, created=now())
    _spawn(("audit", tid), _audit_job(tid, aid))
    return aid


async def _audit_job(tid, aid):
    try:
        await audit(tid, aid)
    except Exception as e:  # noqa: BLE001 - anything goes into the row
        log.exception("audit %s", tid)
        db.x("UPDATE seo_audits SET status='出错', error=:e, finished=:f WHERE id=:i",
             e=(str(e) if isinstance(e, SeoError) else repr(e))[:400], f=now(), i=aid)


def start_geo(tid, by=""):
    if ("geo", tid) in running:
        raise SeoError("这一轮还没问完")
    cfg = config(tid)
    if not cfg["questions"]:
        raise SeoError("先添加要问的问题")
    if not cfg["brand_terms"]:
        raise SeoError("先在设置里填品牌词，不然没法判断 AI 有没有提到我们")
    if not settings.llm_key():
        raise SeoError("没有配置模型密钥（LLM_API_KEY）")
    if month_spent(tid) + estimate(cfg) > cfg["budget_month"]:
        raise SeoError(f"超出 GEO 每月预算（${cfg['budget_month']:.2f}，本月已花 ${month_spent(tid):.2f}，这一轮约 ${estimate(cfg):.2f}）")
    rid = db.insert(db.geo_runs, tenant_id=tid, status="进行中", by=by, created=now())
    _spawn(("geo", tid), _geo_job(tid, rid))
    return rid


async def _geo_job(tid, rid):
    try:
        await geo_run(tid, rid)
    except Exception as e:  # noqa: BLE001
        log.exception("geo %s", tid)
        db.x("UPDATE geo_runs SET status='出错', error=:e, finished=:f WHERE id=:i", e=repr(e)[:400], f=now(), i=rid)


tasks = set()


def _spawn(key, coro):
    running.add(key)
    t = asyncio.create_task(coro)
    tasks.add(t)
    t.add_done_callback(lambda _: (running.discard(key), tasks.discard(t)))


async def loop():
    import search  # search imports this module
    db.x("UPDATE seo_audits SET status='出错', error='服务重启，体检中断' WHERE status='进行中'")
    db.x("UPDATE geo_runs SET status='出错', error='服务重启，中断' WHERE status='进行中'")
    await asyncio.sleep(20)
    while True:
        for row in db.q("SELECT tenant_id FROM seo_cfg"):
            tid = row["tenant_id"]
            try:
                cfg, st = config(tid), state(tid)
                if cfg["site"] and stats_key(tid) and now() - float(st.get("tried") or 0) >= SYNC_EVERY:
                    await sync(tid)
                await search.sync(tid, cfg)
                last_a = db.scalar("SELECT MAX(created) FROM seo_audits WHERE tenant_id=:t", t=tid) or 0
                if cfg["audit_weekly"] and cfg["site"] and now() - last_a >= WEEK:
                    start_audit(tid, "每周自动")
                last_g = db.scalar("SELECT MAX(created) FROM geo_runs WHERE tenant_id=:t", t=tid) or 0
                if cfg["geo_weekly"] and cfg["questions"] and cfg["brand_terms"] and now() - last_g >= WEEK:
                    start_geo(tid, "每周自动")
            except SeoError as e:
                log.info("seo %s: %s", tid, e)
            except Exception:  # noqa: BLE001
                log.exception("seo loop %s", tid)
        await asyncio.sleep(300)
