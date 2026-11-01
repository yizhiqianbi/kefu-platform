"""搜索引擎后台：Google Search Console 和 Bing Webmaster Tools 的展示、点击、关键词、页面.

- Google：客户在 Google Cloud 建服务账号、把它加进 Search Console，JSON 密钥上传到 data/seo/{tid}/google.json（600）。
  这里自己签 JWT 换只读令牌（webmasters.readonly），不引入 Google 的 SDK。第一次拉最近 16 个月，之后每 6 小时重拉最近 5 天。
- Bing：Bing Webmaster 的 API 密钥存 data/seo/{tid}/bing.key（600）。每次整份重拉（Bing 只给大约半年，关键词和页面按周汇总）。
- 存在 search_rows：每天 × 维度（total / query / page / country / device）× 值，排名存「排名 × 展示」的和，汇总时再除。
"""
import base64
import json
import logging
import re
import time
from datetime import date, datetime, timedelta, timezone
from urllib.parse import quote, urlparse

import httpx
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding

import db
from seo import SeoError, save_state, state, tdir

log = logging.getLogger("search")
GOOGLE_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly"
GSC = "https://www.googleapis.com/webmasters/v3"
BING = "https://ssl.bing.com/webmaster/api.svc/json"
SYNC_EVERY = 6 * 3600
HISTORY_DAYS = 486  # Search Console keeps 16 months
GOOGLE_DIMS = ("total", "query", "page", "country", "device")
ENGINE_NAME = {"google": "Google", "bing": "Bing"}

# ISO 3166 alpha-3 (what Search Console returns, lower case) → alpha-2, from CLDR territory aliases.
A3 = """
aaaAA abwAW afgAF agoAO aiaAI alaAX albAL andAD antCW areAE argAR armAM ascAC asmAS ataAQ atfTF atgAG ausAU autAT azeAZ
bdiBI belBE benBJ besBQ bfaBF bgdBD bgrBG bhrBH bhsBS bihBA blmBL blrBY blzBZ bmuBM bolBO braBR brbBB brnBN btnBT burMM
bvtBV bwaBW cafCF canCA cckCC cheCH chlCL chnCN civCI cmrCM codCD cogCG cokCK colCO comKM cptCP cpvCV criCR cubCU cuwCW
cxrCX cymKY cypCY czeCZ ddrDE deuDE dgaDG djiDJ dmaDM dnkDK domDO dzaDZ ecuEC egyEG eriER eshEH espES estEE ethET finFI
fjiFJ flkFK fraFR froFO fsmFM fxxFR gabGA gbrGB geoGE ggyGG ghaGH gibGI ginGN glpGP gmbGM gnbGW gnqGQ grcGR grdGD grlGL
gtmGT gufGF gumGU guyGY hkgHK hmdHM hndHN hrvHR htiHT hunHU idnID imnIM indIN iotIO irlIE irnIR irqIQ islIS isrIL itaIT
jamJM jeyJE jorJO jpnJP kazKZ kenKE kgzKG khmKH kirKI knaKN korKR kwtKW laoLA lbnLB lbrLR lbyLY lcaLC lieLI lkaLK lsoLS
ltuLT luxLU lvaLV macMO mafMF marMA mcoMC mdaMD mdgMG mdvMV mexMX mhlMH mkdMK mliML mltMT mmrMM mneME mngMN mnpMP mozMZ
mrtMR msrMS mtqMQ musMU mwiMW mysMY mytYT namNA nclNC nerNE nfkNF ngaNG nicNI niuNU nldNL norNO nplNP nruNR ntzSA nzlNZ
omnOM pakPK panPA pcnPN perPE phlPH plwPW pngPG polPL priPR prkKP prtPT pryPY psePS pyfPF qatQA qmmQM qnnQN qppQP qqqQQ
qrrQR qssQS qttQT quuEU qvvQV qwwQW qxxQX qyyQY qzzQZ reuRE rouRO rusRU rwaRW sauSA scgRS sdnSD senSN sgpSG sgsGS shnSH
sjmSJ slbSB sleSL slvSV smrSM somSO spmPM srbRS ssdSS stpST sunRU surSR svkSK svnSI sweSE swzSZ sxmSX sycSC syrSY taaTA
tcaTC tcdTD tgoTG thaTH tjkTJ tklTK tkmTM tlsTL tmpTL tonTO ttoTT tunTN turTR tuvTV twnTW tzaTZ ugaUG ukrUA umiUM uryUY
usaUS uzbUZ vatVA vctVC venVE vgbVG virVI vnmVN vutVU wlfWF wsmWS xaaXA xbbXB xccXC xddXD xeeXE xffXF xggXG xhhXH xiiXI
xjjXJ xkkXK xllXL xmmXM xnnXN xooXO xppXP xqqXQ xrrXR xssXS xttXT xuuXU xvvXV xwwXW xxxXX xyyXY xzzXZ yemYE ymdYE yugRS
zafZA zarCD zmbZM zweZW zzzZZ
"""
ALPHA2 = {x[:3]: x[3:] for x in A3.split()}


def now():
    return time.time()


def google_file(tid):
    return tdir(tid) / "google.json"


def bing_file(tid):
    return tdir(tid) / "bing.key"


def _write_secret(path, text):
    path.touch(mode=0o600, exist_ok=True)
    path.chmod(0o600)
    path.write_text(text)


def sstate(tid):
    return state(tid).get("search") or {}


def save_sstate(tid, engine, **kw):
    s = sstate(tid)
    s[engine] = {**(s.get(engine) or {}), **kw}
    save_state(tid, search=s)


# ---------- Google ----------

def google_creds(tid):
    f = google_file(tid)
    return json.loads(f.read_text()) if f.exists() else None


def check_google_json(text):
    try:
        d = json.loads(text)
    except ValueError:
        raise SeoError("不是 JSON 文件：在 Google Cloud 的服务账号里「添加密钥 → JSON」下载的那个文件") from None
    if d.get("type") != "service_account" or not d.get("client_email") or "PRIVATE KEY" not in str(d.get("private_key")):
        raise SeoError("这不是服务账号的密钥文件（要 type 为 service_account，里面有 client_email 和 private_key）")
    try:
        serialization.load_pem_private_key(d["private_key"].encode(), password=None)
    except (ValueError, TypeError):
        raise SeoError("密钥文件里的私钥读不出来，重新下载一份") from None
    return {k: d[k] for k in ("type", "client_email", "private_key", "token_uri") if k in d}


def _b64(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


async def google_token(c, sa):
    t = int(now())
    aud = sa.get("token_uri") or "https://oauth2.googleapis.com/token"
    head = _b64(json.dumps({"alg": "RS256", "typ": "JWT"}).encode())
    body = _b64(json.dumps({"iss": sa["client_email"], "scope": GOOGLE_SCOPE, "aud": aud, "iat": t, "exp": t + 3600}).encode())
    key = serialization.load_pem_private_key(sa["private_key"].encode(), password=None)
    sig = _b64(key.sign(f"{head}.{body}".encode(), padding.PKCS1v15(), hashes.SHA256()))
    r = await c.post(aud, data={"grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer", "assertion": f"{head}.{body}.{sig}"})
    d = r.json() if r.content else {}
    if r.status_code != 200 or not d.get("access_token"):
        raise SeoError(f"Google 不认这个服务账号：{d.get('error_description') or d.get('error') or r.status_code}")
    return d["access_token"]


def _gerr(r):
    try:
        msg = r.json().get("error", {}).get("message", "")
    except ValueError:
        msg = ""
    if r.status_code == 403 and ("has not been used" in msg or "disabled" in msg):
        return "Google Cloud 项目里还没启用 Google Search Console API"
    if r.status_code == 403:
        return "服务账号没有这个网站的权限：在 Search Console「设置 → 用户和权限」里把它加进去"
    return f"Search Console 返回 {r.status_code}：{msg[:200]}"


async def google_sites(tid, sa=None):
    sa = sa or google_creds(tid)
    if not sa:
        raise SeoError("还没上传 Google 服务账号密钥")
    async with httpx.AsyncClient(timeout=30) as c:
        tok = await google_token(c, sa)
        r = await c.get(f"{GSC}/sites", headers={"Authorization": f"Bearer {tok}"})
    if r.status_code != 200:
        raise SeoError(_gerr(r))
    return [s["siteUrl"] for s in r.json().get("siteEntry", []) if s.get("permissionLevel") != "siteUnverifiedUser"]


def pick_site(sites, domains, site):
    """Prefer the Domain property (covers http/https and www), then a URL prefix on our host."""
    host = urlparse(site or "").hostname or ""
    bare = {d.lower().removeprefix("www.") for d in domains} | ({host.removeprefix("www.")} if host else set())
    for s in sites:
        if s.startswith("sc-domain:") and s[10:].lower() in bare:
            return s
    for s in sites:
        h = (urlparse(s).hostname or "").lower()
        if h and h.removeprefix("www.") in bare:
            return s
    return sites[0] if len(sites) == 1 else ""


async def _gquery(c, tok, site, start, end, dims):
    rows, at = [], 0
    while True:
        r = await c.post(f"{GSC}/sites/{quote(site, safe='')}/searchAnalytics/query", headers={"Authorization": f"Bearer {tok}"},
                         json={"startDate": start, "endDate": end, "dimensions": dims, "rowLimit": 25000, "startRow": at,
                               "dataState": "all", "type": "web"})
        if r.status_code != 200:
            raise SeoError(_gerr(r))
        got = r.json().get("rows", [])
        rows += got
        if len(got) < 25000:
            return rows
        at += 25000


def _store(tid, engine, start, end, rows):
    with db.engine.begin() as conn:
        q = db.search_rows.delete().where(db.search_rows.c.tenant_id == tid, db.search_rows.c.engine == engine)
        if start:
            q = q.where(db.search_rows.c.day >= start, db.search_rows.c.day <= end)
        conn.execute(q)
        if rows:
            conn.execute(db.search_rows.insert(), [{"tenant_id": tid, "engine": engine, **r} for r in rows])


async def google_sync(tid, cfg):
    sa = google_creds(tid)
    st = sstate(tid).get("google") or {}
    site = st.get("site") or ""
    async with httpx.AsyncClient(timeout=httpx.Timeout(30, read=120)) as c:
        tok = await google_token(c, sa)
        if not site:
            r = await c.get(f"{GSC}/sites", headers={"Authorization": f"Bearer {tok}"})
            if r.status_code != 200:
                raise SeoError(_gerr(r))
            sites = [s["siteUrl"] for s in r.json().get("siteEntry", []) if s.get("permissionLevel") != "siteUnverifiedUser"]
            site = pick_site(sites, cfg["domains"], cfg["site"])
            if not site:
                raise SeoError("服务账号还看不到我们的网站：先在 Search Console 验证网站，再把服务账号加成用户" if not sites
                               else "服务账号能看到几个网站，去设置里选一个")
        today = date.today()
        last = db.scalar("SELECT MAX(day) FROM search_rows WHERE tenant_id=:t AND engine='google'", t=tid)
        start = (date.fromisoformat(last) - timedelta(days=4)) if last else today - timedelta(days=HISTORY_DAYS)
        start, end = start.isoformat(), today.isoformat()
        out = []
        for kind in GOOGLE_DIMS:
            dims = ["date"] if kind == "total" else ["date", kind]
            for r in await _gquery(c, tok, site, start, end, dims):
                key = "" if kind == "total" else r["keys"][1]
                if kind == "country":
                    key = ALPHA2.get(key.lower(), key.upper()[:2])
                out.append({"day": r["keys"][0], "kind": kind, "key": key[:300], "clicks": int(r.get("clicks") or 0),
                            "impressions": int(r.get("impressions") or 0),
                            "pos_sum": float(r.get("position") or 0) * int(r.get("impressions") or 0)})
        sm = await c.get(f"{GSC}/sites/{quote(site, safe='')}/sitemaps", headers={"Authorization": f"Bearer {tok}"})
        sitemaps = [{"path": s.get("path", ""), "submitted": s.get("lastSubmitted", ""), "downloaded": s.get("lastDownloaded", ""),
                     "errors": int(s.get("errors") or 0), "warnings": int(s.get("warnings") or 0), "pending": bool(s.get("isPending")),
                     "urls": sum(int(x.get("submitted") or 0) for x in s.get("contents", []))}
                    for s in (sm.json().get("sitemap", []) if sm.status_code == 200 else [])]
    _store(tid, "google", start, end, out)
    save_sstate(tid, "google", site=site, synced=now(), error="", sitemaps=sitemaps)
    return len(out)


# ---------- Bing ----------

def bing_key(tid):
    f = bing_file(tid)
    return f.read_text().strip() if f.exists() else ""


def _bdate(v):
    m = re.search(r"/Date\((-?\d+)", str(v or ""))
    return datetime.fromtimestamp(int(m.group(1)) / 1000, timezone.utc).date().isoformat() if m else ""


async def _bing(c, method, key, **params):
    r = await c.get(f"{BING}/{method}", params={**params, "apikey": key})
    if r.status_code in (400, 401, 403):
        try:
            msg = r.json().get("Message", "")
        except ValueError:
            msg = r.text[:200]
        raise SeoError("Bing 不认这个 API 密钥" if "apikey" in msg.lower() or r.status_code == 401 else f"Bing 返回 {r.status_code}：{msg[:200]}")
    if r.status_code != 200:
        raise SeoError(f"Bing 返回 {r.status_code}")
    return r.json().get("d") or []


async def bing_sites(key):
    async with httpx.AsyncClient(timeout=30) as c:
        return [s["Url"] for s in await _bing(c, "GetUserSites", key) if s.get("IsVerified")]


async def bing_sync(tid, cfg):
    key = bing_key(tid)
    st = sstate(tid).get("bing") or {}
    async with httpx.AsyncClient(timeout=httpx.Timeout(30, read=90)) as c:
        site = st.get("site") or ""
        if not site:
            sites = [s["Url"] for s in await _bing(c, "GetUserSites", key) if s.get("IsVerified")]
            site = pick_site(sites, cfg["domains"], cfg["site"])
            if not site:
                raise SeoError("Bing 账号里还没有验证过的网站：在 Bing Webmaster 里「从 Google Search Console 导入」最快" if not sites
                               else "Bing 账号里有几个网站，去设置里选一个")
        out = []
        for r in await _bing(c, "GetRankAndTrafficStats", key, siteUrl=site):
            if d := _bdate(r.get("Date")):
                out.append({"day": d, "kind": "total", "key": "", "clicks": int(r.get("Clicks") or 0), "impressions": int(r.get("Impressions") or 0),
                            "pos_sum": 0.0})
        for kind, method in (("query", "GetQueryStats"), ("page", "GetPageStats")):
            for r in await _bing(c, method, key, siteUrl=site):
                d, impr = _bdate(r.get("Date")), int(r.get("Impressions") or 0)
                pos = float(r.get("AvgImpressionPosition") or 0)
                if d and r.get("Query"):
                    out.append({"day": d, "kind": kind, "key": str(r["Query"])[:300], "clicks": int(r.get("Clicks") or 0), "impressions": impr,
                                "pos_sum": pos * impr if pos > 0 else 0.0})
    _store(tid, "bing", None, None, out)
    save_sstate(tid, "bing", site=site, synced=now(), error="")
    return len(out)


# ---------- sync, report ----------

async def sync(tid, cfg, force=False):
    """Both engines, each on its own clock; errors are kept per engine for the settings page."""
    got = {}
    for engine, ready, fn in (("google", google_creds(tid), google_sync), ("bing", bing_key(tid), bing_sync)):
        st = sstate(tid).get(engine) or {}
        if not ready or (not force and now() - float(st.get("tried") or 0) < SYNC_EVERY):
            continue
        save_sstate(tid, engine, tried=now())
        try:
            got[engine] = await fn(tid, cfg)
        except SeoError as e:
            save_sstate(tid, engine, error=str(e))
            got[engine] = str(e)
        except (httpx.HTTPError, ValueError, KeyError) as e:
            log.warning("search sync %s %s: %r", tid, engine, e)
            save_sstate(tid, engine, error=f"连不上 {ENGINE_NAME[engine]}：{e!r}"[:200])
            got[engine] = repr(e)
    return got


def _agg(rows):
    clicks, impr = sum(r["clicks"] for r in rows), sum(r["impressions"] for r in rows)
    pos_impr = sum(r["impressions"] for r in rows if r["pos_sum"])
    return {"clicks": clicks, "impressions": impr, "ctr": round(clicks / impr * 100, 2) if impr else 0,
            "position": round(sum(r["pos_sum"] for r in rows) / pos_impr, 1) if pos_impr else None}


def report(tid, days=28, engine="google"):
    days = max(7, min(int(days), HISTORY_DAYS))
    end = date.today()
    start = end - timedelta(days=days - 1)
    pstart = start - timedelta(days=days)
    rows = db.q("SELECT day, kind, key, clicks, impressions, pos_sum FROM search_rows WHERE tenant_id=:t AND engine=:e AND day>=:a",
                t=tid, e=engine, a=pstart.isoformat())
    cur = [r for r in rows if r["day"] >= start.isoformat()]
    prev = [r for r in rows if r["day"] < start.isoformat()]

    def top(kind, n=50):
        groups = {}
        for r in cur:
            if r["kind"] == kind:
                groups.setdefault(r["key"], []).append(r)
        out = [{"key": k, **_agg(v)} for k, v in groups.items()]
        return sorted(out, key=lambda x: (-x["clicks"], -x["impressions"]))[:n]

    by_day = {}
    for r in cur:
        if r["kind"] == "total":
            by_day.setdefault(r["day"], []).append(r)
    series = []
    for i in range(days):
        d = (start + timedelta(days=i)).isoformat()
        a = _agg(by_day.get(d, []))
        series.append({"day": d, "clicks": a["clicks"], "impressions": a["impressions"]})
    queries = top("query", 200)
    chances = sorted([q for q in queries if q["position"] and 4 <= q["position"] <= 20 and q["impressions"] >= 10],
                     key=lambda q: -q["impressions"])[:15]
    first = db.scalar("SELECT MIN(day) FROM search_rows WHERE tenant_id=:t AND engine=:e AND kind='total'", t=tid, e=engine)
    return {"engine": engine, "from": start.isoformat(), "to": end.isoformat(), "first_day": first or "",
            "total": _agg([r for r in cur if r["kind"] == "total"]), "prev": _agg([r for r in prev if r["kind"] == "total"]),
            "series": series, "queries": queries[:50], "chances": chances, "pages": top("page", 30), "countries": top("country", 20),
            "devices": top("device", 5), "has_data": bool(first)}


def status(tid):
    s = sstate(tid)
    sa = google_creds(tid)
    out = {}
    for engine, ok in (("google", bool(sa)), ("bing", bool(bing_key(tid)))):
        st = s.get(engine) or {}
        out[engine] = {"connected": ok, "site": st.get("site", ""), "synced": st.get("synced"), "error": st.get("error", ""),
                       **({"client_email": sa["client_email"], "sitemaps": st.get("sitemaps", [])} if engine == "google" and sa else {})}
    return out


async def connect_google(tid, text):
    sa = check_google_json(text)
    sites = await google_sites(tid, sa)
    _write_secret(google_file(tid), json.dumps(sa))
    save_sstate(tid, "google", site="", error="", tried=0)
    return sa["client_email"], sites


async def connect_bing(tid, key):
    key = key.strip()
    if not re.fullmatch(r"[A-Za-z0-9]{20,64}", key):
        raise SeoError("这不像 Bing Webmaster 的 API 密钥（一串 32 位左右的字母数字）")
    sites = await bing_sites(key)
    _write_secret(bing_file(tid), key)
    save_sstate(tid, "bing", site="", error="", tried=0)
    return sites


def disconnect(tid, engine):
    (google_file(tid) if engine == "google" else bing_file(tid)).unlink(missing_ok=True)
    db.x("DELETE FROM search_rows WHERE tenant_id=:t AND engine=:e", t=tid, e=engine)
    s = sstate(tid)
    s.pop(engine, None)
    save_state(tid, search=s)


def set_site(tid, engine, site):
    save_sstate(tid, engine, site=site, tried=0, error="")
    db.x("DELETE FROM search_rows WHERE tenant_id=:t AND engine=:e", t=tid, e=engine)


async def sites(tid, engine):
    if engine == "google":
        return await google_sites(tid)
    key = bing_key(tid)
    if not key:
        raise SeoError("还没填 Bing 的 API 密钥")
    return await bing_sites(key)
