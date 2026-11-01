"""带货视频：简报 → 脚本（每个事实带出处）→ 分镜 → 镜头生成（OpenRouter 视频接口）→ 合成 → 审核。

合成走 video-studio/（Node 旁路服务）：Remotion 模板渲染，导演 agent 看帧改时间线 JSON；服务不可用时退回本机 ffmpeg。

Two kinds of video: `scene` (场景广告: real product photos, AI-animated product shots and AI scenes, captions, native audio)
and `avatar` (数字人口播: a HeyGen talking head reads the script, product B-roll is cut in over its voice).
Product close-ups only ever start from a real photo; every render carries a visible AI label and AIGC metadata.
The OpenRouter key lives in data/video/{tid}/keys.json (600), never in the database and never sent to the browser.
"""
import asyncio
import base64
import io
import json
import logging
import math
import os
import re
import secrets
import shutil
import subprocess
import threading
import time
import unicodedata
import uuid
from datetime import datetime
from pathlib import Path

import httpx
from PIL import Image, ImageDraw, ImageFont, ImageOps

import auth
import db
import grading
import llm
import settings

log = logging.getLogger("video")
ROOT = settings.DATA_DIR / "video"
http = httpx.AsyncClient(timeout=httpx.Timeout(60, read=180))

SHOT_MODELS = ["bytedance/seedance-2.5", "bytedance/seedance-2.0-fast", "kwaivgi/kling-v3.0-std", "kwaivgi/kling-v3.0-pro",
               "minimax/hailuo-3-max", "alibaba/wan-3.0"]
AVATAR_MODELS = ["heygen/avatar-iv"]
API_KINDS = ("motion", "scene", "avatar")
LOCAL_KINDS = ("photo", "card", "footage")
KINDS = API_KINDS + LOCAL_KINDS
KIND_LABEL = {"photo": "实物图推近", "motion": "实物图动起来", "scene": "AI 场景", "footage": "实拍素材", "card": "文字卡", "avatar": "数字人"}
ASSET_KINDS = {"photo": "产品照片", "scene": "实拍照片", "footage": "实拍视频", "logo": "Logo", "avatar": "数字人形象", "music": "音乐",
               "aiscene": "AI 场景图", "aiproduct": "AI 产品图", "cover": "封面海报"}
UPLOAD_KINDS = ("photo", "scene", "footage", "logo", "avatar", "music")
ASSET_EXT = {"photo": {".jpg", ".jpeg", ".png", ".webp"}, "scene": {".jpg", ".jpeg", ".png", ".webp"}, "logo": {".png", ".webp", ".jpg", ".jpeg"}, "avatar": {".jpg", ".jpeg", ".png", ".webp"},
             "footage": {".mp4", ".mov", ".webm", ".m4v"}, "music": {".mp3", ".m4a", ".wav", ".aac", ".ogg"},
             "aiscene": {".jpg"}, "aiproduct": {".jpg"}, "cover": {".jpg"}}
LANGS = {"en-US": ("English (US)", "AI-generated"), "en-GB": ("English (UK)", "AI-generated"), "de-DE": ("Deutsch", "KI-generiert"),
         "fr-FR": ("Français", "Généré par IA"), "es-ES": ("Español", "Generado por IA")}
ASPECTS = {"9:16": (1080, 1920), "16:9": (1920, 1080), "1:1": (1080, 1080)}
END_CTA = {"en": "Message us for a quote", "de": "Schreib uns für ein Angebot", "fr": "Écrivez-nous pour un devis",
           "es": "Escríbenos para un presupuesto"}
# Claims a regulator or platform would want evidence for (FTC, EU Green Claims / UCPD, TikTok Shop).
RISKY = {
    "en": r"\b(best|#1|no\.? ?1|number one|cheapest|guaranteed?|100 ?%|risk[- ]free|lifetime|eco[- ]friendly|climate[- ]neutral|"
          r"carbon[- ]neutral|environmentally friendly|sustainable|biodegradable|fda|cures?|medical[- ]grade|silent|whisper[- ]quiet|noiseless|"
          r"zero[- ]noise|instantly)\b",
    "de": r"\b(beste[nrs]?|nr\.? ?1|günstigste[nrs]?|garantiert|100 ?%|umweltfreundlich|klimaneutral|co2[- ]neutral|nachhaltig|lautlos|flüsterleise|sofort)\b",
    "fr": r"(\bmeilleure?s?\b|n° ?1|le moins cher|\bgaranti[es]*\b|100 ?%|écologique|neutre en carbone|respectueux de l'environnement|"
          r"\bdurable\b|silencieux|instantanément)",
    "es": r"(\bmejor(es)?\b|n\.?º ?1|más barato|garantizad[oa]s?|100 ?%|ecológic[oa]s?|neutro en carbono|respetuoso con el medio ambiente|"
          r"sostenible|silencioso|al instante)",
}
DEFAULT_CFG = {"budget_month": 20.0, "model": settings.VIDEO_MODEL, "resolution": "480p", "avatar_model": AVATAR_MODELS[0],
               "voices": {}, "review_by_other": True, "end_cta": "", "end_contact": "",
               "studio": True, "director": True, "director_model": "deepseek/deepseek-v4.1-flash"}
MAX_RUNNING = 4          # generation jobs per tenant at once
POLL = 10
AI_SECONDS = (4, 8)      # motion / scene shot length we ask for; the model's own limits are applied on top
WORDS_PER_SECOND = 2.5   # HeyGen speech, for estimates


class VideoError(RuntimeError):
    pass


# ---------- keys, config, files ----------

def tdir(tid):
    d = ROOT / str(int(tid))
    d.mkdir(parents=True, exist_ok=True, mode=0o700)
    return d


def pdir(tid, pid):
    d = tdir(tid) / f"p{int(pid)}"
    d.mkdir(exist_ok=True)
    return d


def own_key(tid):
    p = ROOT / str(int(tid)) / "keys.json"
    try:
        return (json.loads(p.read_text()).get("openrouter") or "").strip()
    except (OSError, ValueError):
        return ""


def set_key(tid, key):
    p = tdir(tid) / "keys.json"
    tmp = p.with_suffix(".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump({"openrouter": key.strip()} if key.strip() else {}, f)
    tmp.replace(p)


def platform_key_ok():
    return settings.VIDEO_PLATFORM_KEY and "openrouter.ai" in settings.LLM_BASE_URL and bool(settings.llm_key())


def api_key(tid):
    return own_key(tid) or (settings.llm_key() if platform_key_ok() else "")


def config(tid):
    row = db.q("SELECT data FROM video_cfg WHERE tenant_id=:t", one=True, t=tid)
    return {**DEFAULT_CFG, **db.loads(row["data"] if row else "", {})}


def save_config(tid, data):
    cfg = {k: data[k] for k in DEFAULT_CFG if k in data}
    if db.x("UPDATE video_cfg SET data=:d WHERE tenant_id=:t", d=db.dumps(cfg), t=tid) == 0:
        db.insert(db.video_cfg, tenant_id=tid, data=db.dumps(cfg))


def month_start():
    return datetime.now().replace(day=1, hour=0, minute=0, second=0, microsecond=0).timestamp()


def month_spent(tid):
    return float(db.scalar("SELECT COALESCE(SUM(amount), 0) FROM video_costs WHERE tenant_id=:t AND created>=:s", t=tid, s=month_start()) or 0)


# ---------- models and prices (OpenRouter's video model list) ----------

_catalog = {"at": 0.0, "models": {}}


async def catalog():
    if _catalog["models"] and time.time() - _catalog["at"] < 3600:
        return _catalog["models"]
    try:
        r = await http.get(settings.VIDEO_API_URL + "/videos/models")
        models = {m["id"]: m for m in r.json()["data"]}
        _catalog.update(at=time.time(), models=models)
    except (httpx.HTTPError, ValueError, KeyError) as e:
        log.warning("video model list: %r", e)
    return _catalog["models"]


def frame_size(res, aspect):
    short = int(re.sub(r"\D", "", res) or 720)
    a, b = (int(x) for x in aspect.split(":"))
    return (short, round(short * b / a)) if a < b else (round(short * a / b), short)


def per_second(m, res, aspect, audio=True):
    """USD per output second from OpenRouter's pricing SKUs, or None if the SKU names are new to us."""
    p = (m or {}).get("pricing_skus") or {}
    if "video_tokens" in p:
        w, h = (math.ceil(x / 16) * 16 for x in frame_size(res, aspect))  # billed on the encoder's 16-pixel blocks
        rate = float(p.get("video_tokens" if audio else "video_tokens_without_audio") or p["video_tokens"])
        return w * h * 24 / 1024 * rate
    sound = "with_audio" if audio else "without_audio"
    for k in (f"duration_seconds_{sound}_{res}", f"duration_seconds_{sound}", f"duration_seconds_{res}",
              f"image_to_video_duration_seconds_{res}", "duration_seconds"):
        if k in p:
            return float(p[k])
    for k in (f"cents_per_video_output_second_{res}", f"cents_per_second_output_{res}", "cents_per_second_output"):
        if k in p:
            return float(p[k]) / 100
    return None


def fit_res(m, want):
    have = (m or {}).get("supported_resolutions") or [want]
    if want in have:
        return want
    order = ["480p", "720p", "768p", "1080p", "1K", "2K", "4K"]
    above = [r for r in order[order.index(want) if want in order else 0:] if r in have]
    return above[0] if above else have[0]


def fit_seconds(m, sec, lo=AI_SECONDS[0], hi=AI_SECONDS[1]):
    durs = sorted((m or {}).get("supported_durations") or range(lo, hi + 1))
    sec = max(lo, min(hi, round(sec)))
    return min(durs, key=lambda d: (abs(d - sec), d))


async def model_options(res, aspect):
    cat = await catalog()
    out = []
    for mid in SHOT_MODELS + AVATAR_MODELS:
        m = cat.get(mid)
        r = fit_res(m, res) if mid in SHOT_MODELS else "1080p"
        out.append({"id": mid, "name": (m or {}).get("name", mid).split(": ", 1)[-1], "avatar": mid in AVATAR_MODELS,
                    "res": r, "per_second": per_second(m, r, aspect), "durations": (m or {}).get("supported_durations"),
                    "audio": bool((m or {}).get("generate_audio")), "listed": bool(m)})
    return out


# ---------- assets ----------

def asset_path(a):
    return tdir(a["tenant_id"]) / "assets" / a["file"]


def probe(path):
    try:
        out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,width,height:format=duration", "-of", "json", str(path)],
                             capture_output=True, text=True, timeout=30).stdout
        d = json.loads(out or "{}")
    except (subprocess.SubprocessError, ValueError):
        return {}
    v = next((s for s in d.get("streams", []) if s.get("codec_type") == "video"), {})
    return {"width": int(v.get("width") or 0), "height": int(v.get("height") or 0), "seconds": float((d.get("format") or {}).get("duration") or 0),
            "audio": any(s.get("codec_type") == "audio" for s in d.get("streams", []))}


def save_asset(tid, kind, name, fileobj, tag="", source="", consent="", by=""):
    ext = Path(name).suffix.lower()
    if kind not in UPLOAD_KINDS:
        raise VideoError("没有这种素材类型")
    if ext not in ASSET_EXT[kind]:
        raise VideoError(f"{ASSET_KINDS[kind]}只支持 {' '.join(sorted(ASSET_EXT[kind]))}")
    if kind in ("avatar", "music") and not consent.strip():
        raise VideoError("数字人形象要写明本人授权（谁、用在哪、到什么时候）；音乐要写明版权来源")
    d = tdir(tid) / "assets"
    d.mkdir(exist_ok=True)
    fname = uuid.uuid4().hex[:16] + ext
    path = d / fname
    limit = settings.VIDEO_UPLOAD_MAX_MB * 1024 * 1024
    size = 0
    with open(path, "wb") as out:
        while chunk := fileobj.read(1 << 20):
            size += len(chunk)
            if size > limit:
                out.close()
                path.unlink(missing_ok=True)
                raise VideoError(f"{name} 超过 {settings.VIDEO_UPLOAD_MAX_MB} MB")
            out.write(chunk)
    if not size:
        path.unlink(missing_ok=True)
        raise VideoError(f"{name} 是空文件")
    info = {"width": 0, "height": 0, "seconds": 0.0}
    try:
        if kind in ("photo", "scene", "logo", "avatar"):
            with Image.open(path) as im:
                info.update(width=im.width, height=im.height)
        else:
            p = probe(path)
            if not p.get("seconds"):
                raise VideoError(f"{name} 读不出来，换个格式再传")
            info.update(width=p["width"], height=p["height"], seconds=round(p["seconds"], 2))
            if kind == "footage":
                subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{p['seconds'] / 2:.2f}", "-i", str(path), "-frames:v", "1",
                                "-vf", "scale=480:-2", str(path.with_suffix(".jpg"))], timeout=60)
    except (OSError, Image.UnidentifiedImageError, subprocess.SubprocessError) as e:
        path.unlink(missing_ok=True)
        raise VideoError(f"{name} 读不出来，换个格式再传") from e
    except VideoError:
        path.unlink(missing_ok=True)
        raise
    return db.insert(db.video_assets, tenant_id=tid, kind=kind, name=Path(name).stem[:120], tag=tag.strip()[:80], file=fname, size=size,
                     source=source[:16], consent=consent.strip()[:1000], created_by=by[:60], created=db.now(), **info)


def delete_asset(a):
    p = asset_path(a)
    p.unlink(missing_ok=True)
    if a["kind"] == "footage":
        p.with_suffix(".jpg").unlink(missing_ok=True)
    db.x("DELETE FROM video_assets WHERE id=:i", i=a["id"])


def assets(tid):
    return db.q("SELECT * FROM video_assets WHERE tenant_id=:t ORDER BY kind, tag, id", t=tid)


def flat_image(path):
    """RGB with transparency flattened onto white (product cut-outs are often transparent PNG/WebP)."""
    with Image.open(path) as im:
        im = ImageOps.exif_transpose(im)
        if im.mode in ("RGBA", "LA", "P"):
            im = im.convert("RGBA")
            bg = Image.new("RGB", im.size, (255, 255, 255))
            bg.paste(im, mask=im.getchannel("A"))
            return bg
        return im.convert("RGB")


def product_canvas(path, w, h):
    """The photo centred on a canvas of the video's shape, a little above centre so captions don't cover it."""
    im = flat_image(path)
    px = im.getpixel((2, 2))
    canvas = Image.new("RGB", (w, h), px)
    im.thumbnail((int(w * 0.92), int(h * 0.62)), Image.LANCZOS)
    canvas.paste(im, ((w - im.width) // 2, int(h * 0.43 - im.height / 2)))
    return canvas


def data_url(im, quality=90):
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=quality)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


# ---------- script ----------

ZH_NUM = str.maketrans({"一": "1", "二": "2", "两": "2", "三": "3", "四": "4", "五": "5", "六": "6", "七": "7", "八": "8", "九": "9", "十": "10"})


def norm(s):
    s = unicodedata.normalize("NFKC", str(s or "")).lower().translate(ZH_NUM)
    s = re.sub(r"[×✕*]", "x", s)
    return re.sub(r"[\s,，、.。:：;；!！?？()（）\[\]【】\"'“”‘’/\\|~～\-–—_]+", "", s)


def numbers(text):
    out = []
    for n in re.findall(r"\d+(?:[.,]\d+)*", str(text or "")):
        if re.fullmatch(r"\d{1,3}([.,]\d{3})+", n):
            n = re.sub(r"[.,]", "", n)
        out.append(n.replace(",", "."))
    return out


def check_script(script, truth, lang):
    """Mark, per line, facts whose quote isn't in the material, numbers without a quote, and claims that need evidence."""
    t = norm(truth)
    risky = re.compile(RISKY.get(lang[:2], RISKY["en"]), re.I)

    def claims(text):
        return [f"「{m.group(0)}」是需要证据的说法，删掉或改成资料里的原话" for m in risky.finditer(text or "")]

    script["hook_issues"] = [[f"数字 {n} 在资料里找不到" for n in numbers(h) if n.replace(".", "") not in t] + claims(h)
                             for h in script.get("hooks", [])]
    for seg in script.get("segments", []):
        issues, quotes = [], []
        for f in seg.get("facts", []):
            q = norm(f.get("quote"))
            if not q or q not in t:
                issues.append(f"出处在资料里找不到：「{str(f.get('quote') or '')[:40]}」")
            else:
                quotes.append(q)
        joined = "".join(quotes)
        issues += [f"数字 {n} 没有出处" for n in dict.fromkeys(numbers(seg.get("text"))) if n.replace(".", "") not in joined.replace(".", "")]
        seg["issues"] = issues + claims(seg.get("text"))
    return script


def script_blocked(script):
    if script.get("override_by"):
        return False
    hook = script.get("hook", 0)
    hi = script.get("hook_issues", [])
    return bool((hi[hook] if hook < len(hi) else []) or any(s.get("issues") for s in script.get("segments", [])))


def lines(script):
    """Hook first, then the segments: what is said or shown, in order. Index = shot.seg."""
    hooks = script.get("hooks") or [""]
    h = hooks[min(script.get("hook", 0), len(hooks) - 1)]
    return [{"part": "开头", "text": h, "seconds": 3}] + [{"part": s.get("part", ""), "text": s.get("text", ""), "seconds": s.get("seconds", 4)}
                                                       for s in script.get("segments", [])]


SCRIPT_PROMPT = """你是带货短视频编导，给「{brand}」写一条{kind_label}脚本。

【简报】
- 产品：{product}
- 市场和语言：{market}；台词和字幕全部用 {lang_name}
- 平台和画幅：{platform}，{aspect}
- 总时长：约 {seconds} 秒
- 想讲的卖点：{points}
- 面向谁：{audience}
- 补充要求：{notes}

【产品资料原文（唯一事实来源）】
{truth}

要求：
1. 结构：开头钩子 → 痛点或场景 → 产品和 2–3 个卖点 → 信任（工厂、保修、产量这类资料里有的事实）→ 行动号召。
2. 每段 text 是{text_kind}，用 {lang_name}，口语、短句。
3. 凡是数字、型号、参数、认证、保修、产量、交期，都必须来自上面的资料，并在 facts 里逐条给出：claim 是这句话里的说法；quote 是从资料原文里逐字复制的一小段（保持原文语言，不翻译、不改数字和单位，10–40 个字）。资料里没有的，不写。
4. 数字保留资料里的写法和单位（cm、m²、BTU、W、KG），不换算成英寸、平方英尺、磅。
5. 不写绝对化和要证据的说法：best、#1、cheapest、guaranteed、100%、eco-friendly、climate neutral、silent、instantly，以及德语、法语、西语里的同类说法。
6. 不写产品做不到的效果（瞬间结冰、冷透整个房间），面积按资料里的适用面积写。
7. hooks 给 3 个不同角度的开头，每个 3 秒内能看完或说完，最好不带数字；segments 不含开头。
8. seconds 是这段大约占几秒，加上开头 3 秒约等于总时长。{extra}
只输出 JSON：
{{"title": "中文标题，12 字以内", "hooks": ["", "", ""], "segments": [{{"part": "痛点|产品|信任|行动", "seconds": 5, "text": "", "zh": "这句的中文意思", "facts": [{{"claim": "", "quote": ""}}]}}]}}"""

TEXT_KIND = {"scene": "屏幕上的字幕（画面里没有旁白），每句不超过 12 个词",
             "avatar": "数字人对着镜头说的话，一段一到三句，像真人介绍自家产品"}
KIND_NAME = {"scene": "场景广告", "avatar": "数字人口播"}


async def write_script(tenant, pid):
    p = db.q("SELECT * FROM video_projects WHERE id=:i", one=True, i=pid)
    b = db.loads(p["brief"], {})
    truth = await grading.build_truth(tenant)
    lang = b.get("lang", "en-US")
    prompt = SCRIPT_PROMPT.format(
        brand=tenant["name"], kind_label=KIND_NAME[p["kind"]], product=b.get("product") or "（没填）", market=b.get("market") or lang,
        lang_name=LANGS.get(lang, (lang,))[0], platform=b.get("platform") or "TikTok", aspect=b.get("aspect", "9:16"),
        seconds=b.get("seconds", 30), points=b.get("points") or "从资料里挑最打动这类人的 2–3 个", audience=b.get("audience") or "按产品推断",
        notes=b.get("notes") or "无", truth=truth[:30000], text_kind=TEXT_KIND[p["kind"]],
        extra="\n9. 数字人口播一共说大约 " + str(round(b.get("seconds", 30) * WORDS_PER_SECOND)) + " 个词。" if p["kind"] == "avatar" else "")
    data = await llm.chat_json([{"role": "user", "content": prompt}], tenant_id=tenant["id"], kind="video", temperature=0.6, model=settings.AGENT_MODEL)
    hooks = [str(h).strip()[:200] for h in (data.get("hooks") or []) if str(h).strip()][:3]
    segs = [{"part": str(s.get("part") or "")[:8], "seconds": max(1, min(20, int(float(s.get("seconds") or 4)))),
             "text": str(s.get("text") or "").strip()[:400], "zh": str(s.get("zh") or "").strip()[:300],
             "facts": [{"claim": str(f.get("claim") or "")[:200], "quote": str(f.get("quote") or "")[:200]}
                       for f in (s.get("facts") or []) if isinstance(f, dict)][:6]}
            for s in (data.get("segments") or []) if isinstance(s, dict) and str(s.get("text") or "").strip()][:8]
    if not hooks or not segs:
        raise llm.LLMError("模型没写出完整的脚本，再试一次")
    script = check_script({"hooks": hooks, "hook": 0, "segments": segs}, truth, lang)
    title = (p["title"] or str(data.get("title") or "")[:40] or b.get("product", "")[:40])
    db.x("UPDATE video_projects SET script=:s, title=:ti, status='脚本', error='', updated=:u WHERE id=:i",
         s=db.dumps(script), ti=title, u=db.now(), i=pid)


async def recheck(tenant, script, lang):
    return check_script(script, await grading.build_truth(tenant), lang)


# ---------- storyboard ----------

BOARD_PROMPT = """你是带货短视频分镜师。把下面的脚本拆成镜头，画幅 {aspect}，总时长约 {seconds} 秒。

【脚本】（seg 是段号；text 是这段的字幕或台词）
{script}

【素材库】（asset_id 只能从这里选）
{assets}

镜头做法（kind）：
- photo：产品实物照片，本机做缓慢推近。不花钱，产品绝对不走样。参数、近景优先用它。要 asset_id（产品照片）。
- motion：用产品实物照片做首帧，AI 让镜头和光线动起来（推近、轻微环绕、光影扫过、出风效果），产品本身不能变。要 asset_id（产品照片）。全片 1–2 个。
- scene：AI 生成的使用场景（闷热的帐篷、房车、宿舍、夏天的户外），画面里不出现我们的产品，也不出现任何品牌、文字、Logo。
- footage：素材库里的实拍视频（工厂、生产线、质检），要 asset_id（实拍视频）。
- card：本机渲染的文字卡，参数或信任信息。title 一行，lines 最多 3 行，只用脚本里已有的说法，和脚本同一种语言。
{avatar_rule}
规则：
1. 每个镜头写明属于哪一段（seg），一段 1–3 个镜头；镜头顺序就是成片顺序。
2. photo、card 2–4 秒；motion、scene {lo}–{hi} 秒；footage 2–5 秒。
3. motion、scene 的 prompt 用英文写给视频模型：主体、环境、光线、镜头运动、声音（只要环境声，不要对白、旁白、歌词）。motion 的 prompt 必须包含 "the product stays exactly as in the first frame: same shape, color, buttons, vents and logo"。scene 的 prompt 必须包含 "no product, no brand names, no text, no logos"。画面里不出现可辨认的真人面孔特写。
4. 不要排结尾卡，系统会自动加。
只输出 JSON：{{"shots": [{{"seg": 0, "kind": "photo", "seconds": 3, "asset_id": 12, "prompt": "", "title": "", "lines": []}}]}}"""

AVATAR_RULE = ("- 这是数字人口播：数字人从头到尾讲完整个脚本，这里只排插在口播中间、盖在数字人画面上的产品画面（B-roll），声音仍是数字人的。"
               "开头（seg 0）和行动号召那段不插，其余每段 0–2 个。不要排 avatar 镜头。")


def asset_lines(rows, tag):
    keep = [a for a in rows if a["kind"] in ("photo", "footage")]
    if tag:
        tagged = [a for a in keep if a["kind"] == "footage" or tag.lower() in a["tag"].lower()]
        keep = tagged or keep
    return keep, "\n".join(f"- asset_id {a['id']}：{ASSET_KINDS[a['kind']]}，型号「{a['tag'] or '未标'}」，{a['name']}"
                           + (f"，{a['seconds']:.0f} 秒" if a["kind"] == "footage" else "") for a in keep) or "（没有素材）"


async def make_board(tenant, pid):
    p = db.q("SELECT * FROM video_projects WHERE id=:i", one=True, i=pid)
    b, script = db.loads(p["brief"], {}), db.loads(p["script"], {})
    cfg = config(tenant["id"])
    cat = await catalog()
    model = b.get("model") or cfg["model"]
    m = cat.get(model)
    lo, hi = fit_seconds(m, AI_SECONDS[0]), fit_seconds(m, AI_SECONDS[1])
    rows, listing = asset_lines(assets(tenant["id"]), b.get("tag", ""))
    by_id = {a["id"]: a for a in rows}
    photos = [a for a in rows if a["kind"] == "photo"]
    ln = lines(script)
    text = "\n".join(f"seg {i}（{x['part']}，约 {x['seconds']} 秒）：{x['text']}" for i, x in enumerate(ln))
    data = await llm.chat_json([{"role": "user", "content": BOARD_PROMPT.format(
        aspect=b.get("aspect", "9:16"), seconds=b.get("seconds", 30), script=text, assets=listing,
        avatar_rule=AVATAR_RULE if p["kind"] == "avatar" else "", lo=lo, hi=hi)}],
        tenant_id=tenant["id"], kind="video", temperature=0.4, model=settings.AGENT_MODEL)
    shots = []
    for s in data.get("shots") or []:
        if not isinstance(s, dict) or s.get("kind") not in KINDS or s.get("kind") == "avatar":
            continue
        kind, aid = s["kind"], s.get("asset_id")
        a = by_id.get(aid) if isinstance(aid, int) else None
        if kind in ("photo", "motion") and (not a or a["kind"] != "photo"):
            a = photos[len(shots) % len(photos)] if photos else None
            if not a:
                kind = "card" if kind == "photo" else "scene"
        if kind == "footage" and (not a or a["kind"] != "footage"):
            continue
        sec = float(s.get("seconds") or 3)
        if kind in ("motion", "scene"):
            sec = fit_seconds(m, sec, lo, hi)
        else:
            sec = max(2.0, min(5.0, sec))
            if kind == "footage":
                sec = min(sec, a["seconds"] or sec)
        seg = max(0, min(len(ln) - 1, int(s.get("seg") or 0)))
        card = {"title": str(s.get("title") or "")[:60], "lines": [str(x)[:80] for x in (s.get("lines") or [])][:3]} if kind == "card" else {}
        if kind == "card" and not card["title"]:
            card["title"] = ln[seg]["text"][:60]
        prompt = str(s.get("prompt") or "").strip()[:1500] if kind in ("motion", "scene") else ""
        shots.append(dict(seg=seg, kind=kind, seconds=sec, asset_id=a["id"] if a and kind in ("photo", "motion", "footage") else None,
                          model=model if kind in ("motion", "scene") else "", prompt=prompt, card=db.dumps(card)))
    if p["kind"] == "scene" and not shots:
        raise llm.LLMError("模型没排出镜头，再试一次")
    db.x("DELETE FROM video_shots WHERE project_id=:p", p=pid)
    if p["kind"] == "avatar":
        say = speakable(" ".join(x["text"] for x in ln if x["text"]), b.get("lang", "en-US"))
        db.insert(db.video_shots, project_id=pid, tenant_id=tenant["id"], idx=0, seg=-1, kind="avatar", seconds=round(len(say.split()) / WORDS_PER_SECOND, 1),
                  asset_id=b.get("avatar_asset_id"), model=cfg["avatar_model"], prompt=say, card="{}", updated=db.now())
    for i, s in enumerate(shots, start=1):
        db.insert(db.video_shots, project_id=pid, tenant_id=tenant["id"], idx=i, updated=db.now(), **s)
    db.x("UPDATE video_projects SET status='分镜', error='', updated=:u WHERE id=:i", u=db.now(), i=pid)


UNITS = {  # unit: en, de, fr, es
    "m²": ("square meters", "Quadratmeter", "mètres carrés", "metros cuadrados"),
    "m2": ("square meters", "Quadratmeter", "mètres carrés", "metros cuadrados"),
    "°C": ("degrees Celsius", "Grad Celsius", "degrés Celsius", "grados Celsius"),
    "°F": ("degrees Fahrenheit", "Grad Fahrenheit", "degrés Fahrenheit", "grados Fahrenheit"),
    "mAh": ("milliamp hours", "Milliamperestunden", "milliampères-heure", "miliamperios hora"),
    "Wh": ("watt hours", "Wattstunden", "wattheures", "vatios hora"),
    "kW": ("kilowatts", "Kilowatt", "kilowatts", "kilovatios"),
    "W": ("watts", "Watt", "watts", "vatios"),
    "kg": ("kilograms", "Kilogramm", "kilogrammes", "kilogramos"),
    "dB": ("decibels", "Dezibel", "décibels", "decibelios"),
    "h": ("hours", "Stunden", "heures", "horas"),
    "%": ("percent", "Prozent", "pour cent", "por ciento"),
}
RANGE_WORD = ("to", "bis", "à", "a")


def speakable(text, lang):
    """Text for the avatar's TTS: units and ranges written out the way they are said."""
    li = {"en": 0, "de": 1, "fr": 2, "es": 3}.get(lang[:2], 0)
    text = re.sub(r"(\d)\s*[-–~]\s*(\d)", rf"\1 {RANGE_WORD[li]} \2", text)
    units = "|".join(re.escape(u) for u in sorted(UNITS, key=len, reverse=True))
    text = re.sub(rf"(\d)\s*({units})(?![A-Za-z0-9²])", lambda m: f"{m[1]} {UNITS[m[2]][li]}", text)
    text = re.sub(r"(\d)\s*BTU\b", r"\1 BTU", text)
    return re.sub(r"(?<![A-Za-z])BTU\b", "B T U", text)


def shots_of(pid):
    return db.q("SELECT * FROM video_shots WHERE project_id=:p ORDER BY idx, id", p=pid)


async def estimate(tid, pid, only_pending=True):
    p = db.q("SELECT brief FROM video_projects WHERE id=:i", one=True, i=pid)
    b, cfg, cat = db.loads(p["brief"], {}), config(tid), await catalog()
    total, unknown = 0.0, []
    for s in shots_of(pid):
        if s["kind"] not in API_KINDS or (only_pending and s["status"] in ("完成", "排队", "生成中")):
            continue
        m = cat.get(s["model"])
        res = "1080p" if s["kind"] == "avatar" else fit_res(m, b.get("resolution") or cfg["resolution"])
        ps = per_second(m, res, b.get("aspect", "9:16"))
        if ps is None:
            unknown.append(s["model"])
        else:
            total += ps * s["seconds"]
    return round(total, 2), unknown


# ---------- generation ----------

HEYGEN_VOICES = {  # avatar-iv needs a voice for text scripts; these are HeyGen's stock voices
    "en": {"female": "16a09e4706f74997ba4ed05ea11470f6", "male": "6be73833ef9a4eb0aeee399b8fe9d62b"},  # Cassidy / Andrew
    "de": {"female": "5d25200b1d4442d6b7265a9ff5fad582", "male": "0971fe1493314d1f9a43602cf4a3b210"},  # Leonie / Otto
    "fr": {"female": "4b1de1582d2c477485ad2e0c2717f0ff", "male": "29b464727cc249f3bdf42f82562409f8"},  # Chloe / Thomas
    "es": {"female": "246cdbf530954380a62109f3107fce0d", "male": "707365599f8545d5b6ce7a32a20e9c93"},  # Amelia / Antonio
}


def job_body(s, p, cfg, cat):
    b = db.loads(p["brief"], {})
    aspect = b.get("aspect", "9:16")
    body = {"model": s["model"], "prompt": s["prompt"], "aspect_ratio": aspect}
    a = db.q("SELECT * FROM video_assets WHERE id=:i AND tenant_id=:t", one=True, i=s["asset_id"] or 0, t=p["tenant_id"])
    if s["kind"] == "avatar":
        if not a:
            raise VideoError("没选数字人形象，到素材库上传一张授权过的正脸照片")
        body.update(resolution="1080p", input_references=[{"type": "image_url", "image_url": {"url": data_url(flat_image(asset_path(a)))}}])
        lang = b.get("lang", "en-US")
        voice = b.get("voice_id") or cfg["voices"].get(lang) or HEYGEN_VOICES.get(lang[:2], HEYGEN_VOICES["en"])[b.get("voice_gender") or "female"]
        body["provider"] = {"options": {"heygen": {"voice_id": voice}}}
        return body
    m = cat.get(s["model"])
    res = fit_res(m, b.get("resolution") or cfg["resolution"])
    body.update(duration=int(s["seconds"]), resolution=res)
    if (m or {}).get("generate_audio"):
        body["generate_audio"] = True
    if s["kind"] == "motion":
        if not a:
            raise VideoError("这个镜头要选一张产品照片")
        w, h = frame_size(res, aspect)
        body["frame_images"] = [{"type": "image_url", "image_url": {"url": data_url(product_canvas(asset_path(a), w, h))}, "frame_type": "first_frame"}]
    return body


def err_text(r):
    try:
        e = r.json().get("error") or {}
        msg = e.get("message") if isinstance(e, dict) else str(e)
    except ValueError:
        msg = r.text[:200]
    if r.status_code == 402:
        return "OpenRouter 余额不足，充值后点「重做」"
    if r.status_code == 403:
        return f"OpenRouter 拒绝了这个模型（{msg}），换一个模型"
    return f"{r.status_code}：{msg}"


async def submit(s, key, cat):
    p = db.q("SELECT * FROM video_projects WHERE id=:i", one=True, i=s["project_id"])
    try:
        body = job_body(s, p, config(p["tenant_id"]), cat)
        r = await http.post(settings.VIDEO_API_URL + "/videos", json=body, headers={"Authorization": f"Bearer {key}"})
    except VideoError as e:
        return fail(s, str(e))
    except httpx.HTTPError as e:
        log.warning("video submit %s: %r", s["id"], e)
        return  # stays queued; next tick tries again
    if r.status_code >= 500 or r.status_code == 429:
        return
    if r.status_code >= 400 or not r.json().get("id"):
        return fail(s, err_text(r))
    db.x("UPDATE video_shots SET status='生成中', job_id=:j, error='', updated=:u WHERE id=:i", j=r.json()["id"], u=db.now(), i=s["id"])


def fail(s, msg):
    db.x("UPDATE video_shots SET status='失败', error=:e, updated=:u WHERE id=:i", e=msg[:500], u=db.now(), i=s["id"])


async def poll(s, key):
    h = {"Authorization": f"Bearer {key}"}
    try:
        r = await http.get(f"{settings.VIDEO_API_URL}/videos/{s['job_id']}", headers=h)
        if r.status_code >= 500 or r.status_code == 429:
            return
        if r.status_code >= 400:
            return fail(s, err_text(r))
        st = r.json()
        cost = float((st.get("usage") or {}).get("cost") or 0)
        if cost and not s["cost"]:
            db.insert(db.video_costs, tenant_id=s["tenant_id"], project_id=s["project_id"], shot_id=s["id"], model=s["model"],
                      seconds=s["seconds"], amount=cost, created=db.now())
            db.x("UPDATE video_shots SET cost=cost+:c WHERE id=:i", c=cost, i=s["id"])
        if st.get("status") == "completed":
            v = await http.get(st["unsigned_urls"][0], headers=h)
            v.raise_for_status()
            name = f"shot{s['id']}-{s['tries']}.mp4"
            (pdir(s["tenant_id"], s["project_id"]) / name).write_bytes(v.content)
            info = probe(pdir(s["tenant_id"], s["project_id"]) / name)
            secs = round(info.get("seconds") or s["seconds"], 2) if s["kind"] == "avatar" else s["seconds"]
            db.x("UPDATE video_shots SET status='完成', file=:f, seconds=:sec, cost=CASE WHEN cost=0 THEN :c ELSE cost END, updated=:u WHERE id=:i",
                 f=name, sec=secs, c=cost, u=db.now(), i=s["id"])
        elif st.get("status") in ("failed", "cancelled", "expired"):
            if s["tries"] < 1:
                db.x("UPDATE video_shots SET status='排队', job_id='', tries=tries+1, error=:e, updated=:u WHERE id=:i",
                     e=str(st.get("error") or "")[:300], u=db.now(), i=s["id"])
            else:
                fail(s, "生成失败：" + str(st.get("error") or st.get("status")))
    except (httpx.HTTPError, ValueError, KeyError, IndexError) as e:
        log.warning("video poll %s: %r", s["id"], e)


async def tick():
    cat = await catalog()
    active = db.q("SELECT * FROM video_shots WHERE status IN ('排队','生成中') ORDER BY id")
    for tid in sorted({s["tenant_id"] for s in active}):
        key = api_key(tid)
        mine = [s for s in active if s["tenant_id"] == tid]
        if not key:
            for s in mine:
                fail(s, "没有 OpenRouter 密钥，到「视频 → 设置」里填")
            continue
        for s in [s for s in mine if s["status"] == "生成中"]:
            await poll(s, key)
        running = db.scalar("SELECT COUNT(*) FROM video_shots WHERE tenant_id=:t AND status='生成中'", t=tid)
        for s in [s for s in mine if s["status"] == "排队"][:max(0, MAX_RUNNING - running)]:
            await submit(s, key, cat)
    for p in db.q("SELECT id, tenant_id FROM video_projects WHERE status='生成中'"):
        st = [s["status"] for s in shots_of(p["id"]) if s["kind"] in API_KINDS]
        if any(x in ("排队", "生成中") for x in st):
            continue
        if any(x != "完成" for x in st):
            db.x("UPDATE video_projects SET status='有失败', updated=:u WHERE id=:i", u=db.now(), i=p["id"])
            continue
        db.x("UPDATE video_projects SET status='合成中', updated=:u WHERE id=:i", u=db.now(), i=p["id"])
        spawn_compose(p["tenant_id"], p["id"])


_tasks = set()


def spawn(coro):
    t = asyncio.create_task(coro)
    _tasks.add(t)
    t.add_done_callback(_tasks.discard)
    return t


def spawn_compose(tid, pid, by=0):
    async def run():
        try:
            rid = await asyncio.to_thread(compose, tid, pid, by)
            db.x("UPDATE video_projects SET status='待审核', error='', updated=:u WHERE id=:i", u=db.now(), i=pid)
            log.info("video %s rendered %s", pid, rid)
        except Exception as e:  # noqa: BLE001 - shown to the operator on the project
            log.exception("compose %s", pid)
            db.x("UPDATE video_projects SET status='出错', error=:e, updated=:u WHERE id=:i", e=f"合成失败：{e}"[:500], u=db.now(), i=pid)
    spawn(run())


async def loop():
    db.x("UPDATE video_projects SET status='出错', error='服务重启，这一步中断了，点重试' WHERE status IN ('写脚本中','出分镜中')")
    db.x("UPDATE video_projects SET status='生成中' WHERE status='合成中'")
    while True:
        try:
            await tick()
        except Exception:  # noqa: BLE001 - keep the loop alive
            log.exception("video tick")
        await asyncio.sleep(POLL)


def start(tid, pid, user_id):
    """Queue every AI shot that isn't done yet; local-only boards go straight to composing."""
    todo = [s for s in shots_of(pid) if s["kind"] in API_KINDS and s["status"] in ("", "失败")]
    for s in todo:
        db.x("UPDATE video_shots SET status='排队', job_id='', tries=0, error='', updated=:u WHERE id=:i", u=db.now(), i=s["id"])
    db.x("UPDATE video_projects SET status='生成中', created_by=CASE WHEN created_by=0 THEN :b ELSE created_by END, error='', updated=:u WHERE id=:i",
         b=user_id, u=db.now(), i=pid)
    return len(todo)


# ---------- composing ----------

FONT_DIRS = [Path(os.environ.get("VIDEO_FONT_DIR", "/nonexistent")), Path("/root/.fonts/inter/extras/ttf"), Path("/usr/share/fonts/truetype/inter"),
             Path("/usr/share/fonts/opentype/inter"), Path("/usr/share/fonts/truetype/dejavu")]
FONT_NAMES = {"black": ["Inter-Black.ttf", "Inter-ExtraBold.ttf", "DejaVuSans-Bold.ttf"], "bold": ["Inter-Bold.ttf", "DejaVuSans-Bold.ttf"],
              "regular": ["Inter-Medium.ttf", "Inter-Regular.ttf", "DejaVuSans.ttf"]}


def font_file(weight):
    for name in FONT_NAMES[weight]:
        for d in FONT_DIRS:
            if (d / name).exists():
                return d / name
    raise VideoError("找不到字体：装 Inter 或 DejaVu Sans，或设置 VIDEO_FONT_DIR")


def font(weight, size):
    return ImageFont.truetype(str(font_file(weight)), size)


def fonts_dir():
    """A directory holding just the caption font, for libass (this ffmpeg has no fontconfig)."""
    d = ROOT / "fonts"
    d.mkdir(parents=True, exist_ok=True)
    src = font_file("bold")
    if not (d / src.name).exists():
        shutil.copy(src, d / src.name)
    return d, ImageFont.truetype(str(src), 10).getname()[0]


def hex_rgb(h, default):
    m = re.fullmatch(r"#?([0-9a-fA-F]{6})", str(h or ""))
    return tuple(int(m.group(1)[i:i + 2], 16) for i in (0, 2, 4)) if m else default


def wrap(draw, text, f, width):
    out = []
    for para in str(text).split("\n"):
        cur = ""
        for word in para.split():
            nxt = f"{cur} {word}".strip()
            if draw.textlength(nxt, font=f) <= width or not cur:
                cur = nxt
            else:
                out.append(cur)
                cur = word
        out.append(cur)
    return [x for x in out if x]


def logo_image(tid):
    """The first logo, turned white if it is dark (cards have a dark background)."""
    a = db.q("SELECT * FROM video_assets WHERE tenant_id=:t AND kind='logo' ORDER BY id LIMIT 1", one=True, t=tid)
    if not a:
        return None
    with Image.open(asset_path(a)) as im:
        im = ImageOps.exif_transpose(im).convert("RGBA")
    alpha = im.getchannel("A")
    if alpha.getextrema()[0] == 255:
        return im
    lum = ImageOps.grayscale(im.convert("RGB"))
    seen = [v for v, m in zip(lum.getdata(), alpha.getdata()) if m > 128]
    if seen and sum(seen) / len(seen) < 110:
        white = Image.new("RGBA", im.size, (255, 255, 255, 255))
        white.putalpha(alpha)
        return white
    return im


def card_image(w, h, title, rows, brand, tid, big=False):
    dark, accent = hex_rgb(brand.get("dark"), (31, 33, 71)), hex_rgb(brand.get("accent"), (232, 102, 42))
    im = Image.new("RGB", (w, h), dark)
    d = ImageDraw.Draw(im)
    unit = min(w, h) / 1080
    pad = int(90 * unit)
    logo = logo_image(tid)
    if logo:
        logo.thumbnail((int(w * 0.5), int(140 * unit)), Image.LANCZOS)
        im.paste(logo, ((w - logo.width) // 2, int(h * 0.14)), logo)
    ft = font("black", int((96 if big else 80) * unit))
    fl = font("bold", int(54 * unit))
    tl = wrap(d, title, ft, w - 2 * pad)
    ll = [x for r in rows for x in wrap(d, r, fl, w - 2 * pad)]
    th, lh = int(ft.size * 1.18), int(fl.size * 1.45)
    y = int(h * 0.40 - (len(tl) * th + int(40 * unit) + len(ll) * lh) / 2)
    for t in tl:
        d.text(((w - d.textlength(t, font=ft)) / 2, y), t, font=ft, fill=(255, 255, 255))
        y += th
    d.rectangle(((w - 120 * unit) / 2, y + 14 * unit, (w + 120 * unit) / 2, y + 22 * unit), fill=accent)
    y += int(40 * unit)
    for t in ll:
        d.text(((w - d.textlength(t, font=fl)) / 2, y), t, font=fl, fill=(225, 228, 240))
        y += lh
    return im


def ff(args, timeout=600, cwd=None):
    r = subprocess.run(["ffmpeg", "-v", "error", "-y", *args], capture_output=True, text=True, timeout=timeout, cwd=cwd)
    if r.returncode:
        raise VideoError("ffmpeg：" + (r.stderr.strip().splitlines() or ["未知错误"])[-1][:300])


ENC = ["-r", "30", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
       "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2"]


def still_clip(img, sec, out, w, h, zoom=0.06):
    """A slow push-in on a still: the source is upscaled first so zoompan doesn't jitter."""
    src = out.with_suffix(".png")
    img.save(src)
    n = max(1, int(round(sec * 30)))
    vf = (f"scale={w * 3 // 2}:{h * 3 // 2},zoompan=z='1+{zoom}*on/{n}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d={n}:s={w}x{h}:fps=30,"
          f"format=yuv420p,setsar=1")
    ff(["-i", str(src), "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-filter_complex", f"[0:v]{vf}[v]",
        "-map", "[v]", "-map", "1:a", "-t", f"{sec:.3f}", *ENC, str(out)])
    src.unlink(missing_ok=True)


def video_clip(src, sec, out, w, h, start=0.0, keep_audio=True):
    """30 fps, exactly `sec` long (the last frame is held if the source is short). Same shape: fill the frame;
    a different shape (landscape footage in a vertical video): fit it over a blurred copy instead of cropping most of it away."""
    info = probe(src)
    tail = f"setsar=1,fps=30,format=yuv420p,tpad=stop_mode=clone:stop_duration={sec:.3f}"
    ratio = (info.get("width") or w) / (info.get("height") or h)
    if abs(ratio - w / h) / (w / h) > 0.25:
        vf = (f"split[bg][fg];[bg]scale={w // 8}:{h // 8}:force_original_aspect_ratio=increase,crop={w // 8}:{h // 8},boxblur=6,"
              f"scale={w}:{h}[bgb];[fg]scale={w}:{h}:force_original_aspect_ratio=decrease[fgs];[bgb][fgs]overlay=(W-w)/2:(H-h)*0.42,{tail}")
    else:
        vf = f"scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},{tail}"
    has_audio = keep_audio and info.get("audio")
    args = ["-ss", f"{start:.3f}", "-i", str(src)]
    if has_audio:
        fc, amap = f"[0:v]{vf}[v];[0:a]aresample=48000,aformat=channel_layouts=stereo,apad[a]", "[a]"
    else:
        args += ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"]
        fc, amap = f"[0:v]{vf}[v]", "1:a"
    ff([*args, "-filter_complex", fc, "-map", "[v]", "-map", amap, "-t", f"{sec:.3f}", *ENC, str(out)])


def concat(parts, out):
    lst = out.with_suffix(".txt")
    lst.write_text("".join(f"file '{p.name}'\n" for p in parts))
    ff(["-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy", str(out)])
    lst.unlink(missing_ok=True)


def ass_time(t):
    t = max(0.0, t)
    return f"{int(t // 3600)}:{int(t % 3600 // 60):02d}:{t % 60:05.2f}"


def srt_time(t):
    ms = int(round(max(0.0, t) * 1000))
    return f"{ms // 3600000:02d}:{ms % 3600000 // 60000:02d}:{ms % 60000 // 1000:02d},{ms % 1000:03d}"


def chunks(text, max_words=8):
    """Split a caption into phrases shown one after another: at punctuation first, long clauses into even halves."""
    out = []
    for clause in re.split(r"(?<=[,;:—])\s+|(?<=[.!?])\s+(?=[A-ZÀ-ÖØ-Þ¿¡\"“])", str(text).strip()):
        words = clause.split()
        if not words:
            continue
        if out and len(out[-1].split()) + len(words) <= max_words and not re.search(r"[.!?]$", out[-1]):
            out[-1] += " " + clause
            continue
        n = math.ceil(len(words) / max_words)
        size = math.ceil(len(words) / n)
        out += [" ".join(words[i:i + size]) for i in range(0, len(words), size)]
    return out


def caption_events(windows):
    """(start, end, text) per phrase; each window's time is shared by word count."""
    ev = []
    for start, end, text in windows:
        parts = chunks(text)
        total = sum(len(p.split()) for p in parts) or 1
        t = start
        for p in parts:
            d = (end - start) * len(p.split()) / total
            ev.append((t, t + d, p))
            t += d
    return ev


def off_cards(events, spans):
    """Burned-in captions skip text cards, which already show the words: a phrase mostly under a card is
    dropped, otherwise it is trimmed to its longest uncovered part."""
    out = []
    for a, b, text in events:
        free = [(a, b)]
        for c0, c1 in spans:
            free = [piece for x0, x1 in free for piece in ((x0, min(x1, c0)), (max(x0, c1), x1)) if piece[1] - piece[0] > 0.05]
        if free:
            x0, x1 = max(free, key=lambda f: f[1] - f[0])
            if x1 - x0 >= max(0.6, (b - a) / 2):
                out.append((x0, x1, text))
    return out


def write_subs(path, w, h, events, label, total, font_name):
    unit = min(w, h) / 1080
    esc = lambda s: str(s).replace("\\", "/").replace("{", "(").replace("}", ")").replace("\n", "\\N")  # noqa: E731
    head = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {w}
PlayResY: {h}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,{font_name},{int(66 * unit)},&H00FFFFFF,&H00FFFFFF,&H00101010,&H78000000,-1,0,0,0,100,100,0,0,1,{max(3, int(5 * unit))},2,2,{int(70 * unit)},{int(170 * unit) if h > w else int(70 * unit)},{int(h * (0.24 if h > w else 0.12))},1
Style: Tag,{font_name},{int(30 * unit)},&H00FFFFFF,&H00FFFFFF,&H64000000,&H64000000,-1,0,0,0,100,100,0,0,3,{int(8 * unit)},0,7,{int(40 * unit)},{int(40 * unit)},{int(h * 0.05)},1
Style: TagBig,{font_name},{int(54 * unit)},&H00FFFFFF,&H00FFFFFF,&H50000000,&H50000000,-1,0,0,0,100,100,0,0,3,{int(14 * unit)},0,8,0,0,{int(h * 0.11)},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    rows = [f"Dialogue: 1,{ass_time(0)},{ass_time(2.5)},TagBig,,0,0,0,,{esc(label)}",
            f"Dialogue: 1,{ass_time(2.5)},{ass_time(total)},Tag,,0,0,0,,{esc(label)}"]
    rows += [f"Dialogue: 0,{ass_time(a)},{ass_time(b)},Cap,,0,0,0,,{esc(t)}" for a, b, t in events]
    path.write_text(head + "\n".join(rows) + "\n")


def compose_ffmpeg(tid, pid, by=0, notes=""):
    """The fallback: shots → one timeline → captions, AI label, music, AIGC metadata, all in ffmpeg. Returns the render id."""
    p = db.q("SELECT * FROM video_projects WHERE id=:i AND tenant_id=:t", one=True, i=pid, t=tid)
    tenant = auth.tenant_by_id(tid)
    b, script, cfg = db.loads(p["brief"], {}), db.loads(p["script"], {}), config(tid)
    w, h = ASPECTS.get(b.get("aspect", "9:16"), ASPECTS["9:16"])
    lang = b.get("lang", "en-US")
    ln = lines(script)
    shots = shots_of(pid)
    out_dir = pdir(tid, pid)
    work = out_dir / "build"
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir()
    get_asset = lambda i: db.q("SELECT * FROM video_assets WHERE id=:i AND tenant_id=:t", one=True, i=i or 0, t=tid)  # noqa: E731

    def render_shot(s):
        out = work / f"s{s['id']}.mp4"
        a = get_asset(s["asset_id"])
        if s["kind"] == "photo":
            if not a:
                raise VideoError(f"第 {s['idx']} 个镜头的照片被删了")
            still_clip(product_canvas(asset_path(a), w, h), s["seconds"], out, w, h)
        elif s["kind"] == "card":
            c = db.loads(s["card"], {})
            still_clip(card_image(w, h, c.get("title", ""), c.get("lines", []), tenant["brand"], tid), s["seconds"], out, w, h, zoom=0.03)
        elif s["kind"] == "footage":
            if not a:
                raise VideoError(f"第 {s['idx']} 个镜头的视频素材被删了")
            video_clip(asset_path(a), s["seconds"], out, w, h, start=max(0.0, (a["seconds"] - s["seconds"]) / 2), keep_audio=False)
        else:
            if not s["file"]:
                raise VideoError(f"第 {s['idx']} 个镜头还没生成")
            video_clip(out_dir / s["file"], s["seconds"], out, w, h)
        return out

    end_sec = 2.5
    end_png = card_image(w, h, cfg["end_cta"] or END_CTA.get(lang[:2], END_CTA["en"]),
                         [cfg["end_contact"] or tenant["brand"].get("sales_phone") or ""], tenant["brand"], tid, big=True)
    end = work / "end.mp4"
    still_clip(end_png, end_sec, end, w, h, zoom=0.02)
    broll = [s for s in shots if s["kind"] != "avatar"]
    cards = []
    if p["kind"] == "avatar":
        av = next((s for s in shots if s["kind"] == "avatar"), None)
        if not av or not av["file"]:
            raise VideoError("数字人镜头还没生成")
        base = work / "avatar.mp4"
        dur = probe(out_dir / av["file"]).get("seconds") or av["seconds"]
        video_clip(out_dir / av["file"], dur, base, w, h)
        words = [max(1, len(x["text"].split())) for x in ln]
        total_w = sum(words)
        windows, t = [], 0.0
        for x, n in zip(ln, words):
            windows.append((t, t + dur * n / total_w, x["text"]))
            t += dur * n / total_w
        inserts = []
        for i, (a0, a1, _) in enumerate(windows):
            mine = [s for s in broll if s["seg"] == i]
            t = a0 + 0.4
            for s in mine:
                d = min(s["seconds"], a1 - 0.3 - t)
                if d < 1.2:
                    break
                inserts.append((t, d, render_shot({**s, "seconds": d})))
                if s["kind"] == "card":
                    cards.append((t, t + d))
                t += d
        body = work / "body.mp4"
        if inserts:
            args, fc, last = ["-i", str(base)], [], "[0:v]"
            for k, (t0, d, f) in enumerate(inserts, start=1):
                args += ["-i", str(f)]
                fc.append(f"[{k}:v]setpts=PTS-STARTPTS+{t0:.3f}/TB[b{k}];{last}[b{k}]overlay=enable='between(t,{t0:.3f},{t0 + d:.3f})':eof_action=pass[o{k}]")
                last = f"[o{k}]"
            ff([*args, "-filter_complex", ";".join(fc), "-map", last, "-map", "0:a", *ENC, str(body)])
        else:
            body = base
        main_dur = dur
    else:
        parts, windows, t = [], [], 0.0
        for i, x in enumerate(ln):
            mine = [s for s in broll if s["seg"] == i]
            if not mine:
                continue
            t0 = t
            for s in mine:
                parts.append(render_shot(s))
                if s["kind"] == "card":
                    cards.append((t, t + s["seconds"]))
                t += s["seconds"]
            windows.append((t0, t, x["text"]))
        if not parts:
            raise VideoError("分镜是空的")
        body = work / "body.mp4"
        concat(parts, body)
        main_dur = t
    full = work / "full.mp4"
    concat([body, end], full)
    total = main_dur + end_sec
    fdir, fname = fonts_dir()
    events = caption_events(windows)
    write_subs(work / "subs.ass", w, h, off_cards(events, cards), LANGS.get(lang, ("", "AI-generated"))[1], total, fname)
    music = get_asset(b.get("music_asset_id"))
    args = ["-i", str(full)]
    if music:
        args += ["-stream_loop", "-1", "-i", str(asset_path(music))]
        af = ("[0:a]asplit[a0][a1];[1:a]aresample=48000,aformat=channel_layouts=stereo,volume=0.28[m];"
              "[m][a1]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400[md];"
              "[a0][md]amix=inputs=2:duration=first:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11[a]")
    else:
        af = "[0:a]loudnorm=I=-14:TP=-1.5:LRA=11[a]"
    content_id = uuid.uuid4().hex
    models = sorted({s["model"] for s in shots if s["kind"] in API_KINDS and s["model"]})
    aigc = {"AIGC": {"Label": "1", "ContentProducer": f"{tenant['name']} via 智能客服平台", "ProduceID": content_id,
                     "ContentPropagator": tenant["name"], "Models": models}}
    rid = db.insert(db.video_renders, project_id=pid, tenant_id=tid, file="", seconds=round(total, 2), content_id=content_id,
                    status="待审核", created_by=by or p["created_by"], created=db.now(), engine="ffmpeg", notes=notes)
    name = f"render{rid}.mp4"
    try:
        ff([*args, "-filter_complex", f"[0:v]ass=subs.ass:fontsdir={fdir}[v];{af}", "-map", "[v]", "-map", "[a]", "-t", f"{total:.3f}",
            "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k",
            "-movflags", "+faststart+use_metadata_tags", "-metadata", f"title={p['title']}",
            "-metadata", f"comment={json.dumps(aigc, ensure_ascii=False)}",
            "-metadata", "description=AI-generated content (AIGC). " + ", ".join(models), "-metadata", f"aigc_content_id={content_id}",
            str(out_dir / name)], timeout=1200, cwd=work)
    except Exception:
        db.x("DELETE FROM video_renders WHERE id=:i", i=rid)
        raise
    (out_dir / f"render{rid}.srt").write_text("\n".join(f"{i}\n{srt_time(a)} --> {srt_time(b2)}\n{t}\n" for i, (a, b2, t) in enumerate(events, start=1)))
    rows = max(1, math.ceil(total / 8))
    ff(["-i", str(out_dir / name), "-vf", f"fps=1,scale={180 if h > w else 240}:-2,tile=8x{rows}:padding=4:color=white", "-frames:v", "1",
        str(out_dir / f"render{rid}.jpg")])
    db.x("UPDATE video_renders SET file=:f WHERE id=:i", f=name, i=rid)
    shutil.rmtree(work, ignore_errors=True)
    return rid


# ---------- AI images (OpenRouter /images) ----------
# scene: a setting with no product in it; the real product photo is laid on top by the templates, so it can't drift.
# ref:   the product photo goes in as a reference. Models redraw it, so these wait for a person to compare with the
#        real product (review 待审核) and are only ever used as whole pictures, never as the product close-up.

IMAGE_MODELS = {  # id: (name, USD per image as billed at the resolution we ask for, resolution, note, modes)
    "bytedance-seed/seedream-5-0-flash": ("Seedream 5 Flash", 0.018, "2K", "约 15 秒，参考产品图也稳", ("scene", "ref")),
    "black-forest-labs/flux-3-image-klein": ("FLUX 3 Klein", 0.014, "2K", "最便宜，适合多出几张挑", ("scene", "ref")),
    "qwen/qwen-image-3": ("Qwen Image 3", 0.03, "2K", "画面干净，要一分钟左右", ("scene", "ref")),
    "bytedance-seed/seedream-5-0-pro": ("Seedream 5 Pro", 0.045, "1K", "细节更好，半分钟到两分钟", ("scene", "ref")),
    "black-forest-labs/flux-3-image": ("FLUX 3", 0.048, "1K", "质感好", ("scene", "ref")),
    "krea/k3-edit": ("Krea K3 Edit", 0.05, "1K", "只做参考图编辑", ("ref",)),
}
IMAGE_ASPECTS = ("9:16", "16:9", "1:1", "4:5", "3:4")
SCENE_GUARD = ("Photorealistic photo. Do not show any product, appliance, air conditioner, fan, heater, device, box or packaging. "
               "No text, letters, logos, watermarks or brand names. No recognisable real people. "
               "Leave clean empty space in the lower middle where a product will be placed later.")
REF_GUARD = ("The product in the reference image must stay exactly the same: same shape, proportions, colours, materials, buttons, vents, "
             "screen, logo and printed text. Do not add, remove or redesign any part. Change only the surroundings and lighting. "
             "No added text, captions or watermarks.")
IMAGE_PROMPT = """把运营的想法写成一条给生图模型的英文提示词（60–110 词），只输出 JSON：{{"prompt": "...", "name": "4–10 个字的中文短名"}}
{rule}
- 写清：地点、时间和光线、镜头（景别、角度）、氛围、真实摄影质感；适合 {aspect} 画幅
- 不要写任何文字、Logo、品牌名；不要出现可辨认的真人
产品：{product}
运营的想法：{idea}"""
SCENE_RULE = "- 这是空场景：画面里不能有产品或任何电器，只描述环境，并在画面中下方留出放产品的空位"
REF_RULE = "- 参考图里是真实产品：只描述把它放在什么场景、什么位置、怎样的光线；不要描述产品本身的外观，用 \"the product from the reference image\" 指代"


class ImageError(VideoError):
    pass


async def image_prompt(tid, mode, idea, product="", aspect="9:16"):
    if not re.search(r"[\u3400-\u9fff]", idea) and len(idea.split()) >= 12:
        return idea.strip(), " ".join(idea.split()[:4])
    d = await llm.chat_json([{"role": "user", "content": IMAGE_PROMPT.format(rule=SCENE_RULE if mode == "scene" else REF_RULE,
                                                                           aspect=aspect, product=product or "-", idea=idea)}],
                            tenant_id=tid, kind="video", temperature=0.5, model=settings.AGENT_MODEL)
    prompt = str(d.get("prompt") or "").strip()
    if len(prompt) < 20:
        raise ImageError("提示词没写出来，再试一次")
    return prompt[:2000], str(d.get("name") or idea)[:20]


def save_ai_image(tid, raw, kind, name, model, prompt, tag="", ref_id=None, by=""):
    """JPEG with the AIGC note in EXIF; product images start out waiting for review."""
    d = tdir(tid) / "assets"
    d.mkdir(exist_ok=True)
    fname = uuid.uuid4().hex[:16] + ".jpg"
    with Image.open(io.BytesIO(raw)) as im:
        im = ImageOps.exif_transpose(im).convert("RGB")
        exif = Image.Exif()
        exif[0x010E] = f"AI-generated (AIGC) with {model}"
        exif[0x0131] = "智能客服平台"
        im.save(d / fname, "JPEG", quality=92, exif=exif)
        w, h = im.size
    return db.insert(db.video_assets, tenant_id=tid, kind=kind, name=name[:120], tag=tag[:80], file=fname, size=(d / fname).stat().st_size,
                     width=w, height=h, seconds=0, source="AI", consent="", created_by=by[:60], created=db.now(), prompt=prompt[:4000],
                     model=model, review="待审核" if kind == "aiproduct" else "", ref_id=ref_id)


async def generate_images(tid, mode, idea, model, aspect="9:16", n=2, ref_id=None, tag="", by=""):
    """Returns the new asset ids. mode: scene | ref."""
    if model not in IMAGE_MODELS or mode not in IMAGE_MODELS[model][4]:
        raise ImageError("这个模型不支持这种出图方式")
    if aspect not in IMAGE_ASPECTS:
        raise ImageError("画幅不对")
    n = max(1, min(4, int(n)))
    key = api_key(tid)
    if not key:
        raise ImageError("没有 OpenRouter 密钥，去「视频设置」填一个")
    name, price, res, _, _ = IMAGE_MODELS[model]
    cfg = config(tid)
    if month_spent(tid) + price * n > float(cfg["budget_month"] or 0):
        raise ImageError(f"超出本月视频预算（${cfg['budget_month']:.0f}，已花 ${month_spent(tid):.2f}）")
    ref = None
    if mode == "ref":
        ref = db.q("SELECT * FROM video_assets WHERE id=:i AND tenant_id=:t AND kind='photo'", one=True, i=ref_id or 0, t=tid)
        if not ref or not asset_path(ref).exists():
            raise ImageError("选一张素材库里的产品照片当参考")
        tag = tag or ref["tag"]
    prompt, short = await image_prompt(tid, mode, idea, (ref or {}).get("tag") or tag, aspect)
    body = {"model": model, "prompt": f"{prompt}\n\n{SCENE_GUARD if mode == 'scene' else REF_GUARD}", "aspect_ratio": aspect, "n": 1,
            "resolution": res}
    if ref:
        im = flat_image(asset_path(ref))
        im.thumbnail((1536, 1536))
        body["input_references"] = [{"type": "image_url", "image_url": {"url": data_url(im)}}]

    async def one(c):
        r = await c.post(settings.VIDEO_API_URL + "/images", json=body, headers={"Authorization": f"Bearer {key}"})
        try:
            d = r.json()
        except ValueError:
            raise ImageError(f"生图接口返回 {r.status_code}") from None
        if not d.get("data"):
            msg = (d.get("error") or {}).get("message") or f"HTTP {r.status_code}"
            raise ImageError("这个模型拒绝了请求（服务条款限制），换一个模型" if r.status_code == 403 else f"生图失败：{msg[:200]}")
        cost = float((d.get("usage") or {}).get("cost") or price)
        db.insert(db.video_costs, tenant_id=tid, project_id=0, shot_id=0, model=model, seconds=0, amount=cost, created=db.now())
        return [base64.b64decode(x["b64_json"]) for x in d["data"] if x.get("b64_json")]

    async with httpx.AsyncClient(timeout=httpx.Timeout(30, read=300)) as c:
        got = await asyncio.gather(*[one(c) for _ in range(n)], return_exceptions=True)
    images = [raw for g in got if isinstance(g, list) for raw in g]
    if not images:
        err = next((g for g in got if isinstance(g, Exception)), None)
        raise err if isinstance(err, VideoError) else ImageError(f"生图失败：{err!r}"[:200])
    kind = "aiscene" if mode == "scene" else "aiproduct"
    label = "AI 场景" if mode == "scene" else "AI 产品图"
    return [await asyncio.to_thread(save_ai_image, tid, raw, kind, f"{label} · {short}", model, prompt, tag, ref["id"] if ref else None, by)
            for raw in images]


def approve_image(a, who_name):
    db.x("UPDATE video_assets SET review='', consent=:c WHERE id=:i",
         c=f"产品外观已和实物照片核对：{who_name}，{datetime.now().strftime('%Y-%m-%d %H:%M')}", i=a["id"])


COVER_SIZES = {"9:16": (1080, 1920), "4:5": (1080, 1350), "1:1": (1080, 1080), "16:9": (1920, 1080)}


def make_cover(tid, product_id, bg_id, title, sub="", points=(), cta="", aspect="9:16", lang="en-US", by=""):
    """Cover / poster from the Cover template: real product photo over a scene (AI or real) or the brand colours. Returns the asset id."""
    if aspect not in COVER_SIZES:
        raise VideoError("画幅不对")
    rows = {a["id"]: a for a in assets(tid)}
    prod = rows.get(product_id or 0)
    if not prod or prod["kind"] != "photo" or not asset_path(prod).exists():
        raise VideoError("选一张产品照片")
    bg = rows.get(bg_id or 0) if bg_id else None
    if bg_id and (not bg or bg["kind"] not in ("aiscene", "scene") or not asset_path(bg).exists()):
        raise VideoError("背景只能用实拍照片或 AI 场景图")
    texts = [title, sub, cta, *points]
    risky = re.compile(RISKY.get(lang[:2], RISKY["en"]), re.I | re.U)
    bad = next((m.group(0) for t in texts if t for m in [risky.search(t)] if m), None)
    if bad:
        raise VideoError(f"「{bad}」这种说法平台和监管会要证据，换个说法")
    studio.ensure()
    work = tdir(tid) / "covers" / uuid.uuid4().hex[:12]
    work.mkdir(parents=True)
    try:
        info = {}

        def put(a, pre):
            name = f"{pre}{a['id']}{asset_path(a).suffix.lower()}"
            link(asset_path(a), work / name)
            info[name] = {"w": a["width"], "h": a["height"]}
            if pre == "p" and has_alpha(asset_path(a)):
                with Image.open(asset_path(a)) as im:
                    box = im.convert("RGBA").getchannel("A").point(lambda v: 255 if v > 40 else 0).getbbox()
                info[name].update(alpha=True, bottom=round(box[3] / im.height, 3) if box else 1)
            return name

        src = put(prod, "p")
        bg_src = put(bg, "g") if bg else ""
        logo = next((a for a in rows.values() if a["kind"] == "logo" and asset_path(a).exists()), None)
        tenant = auth.tenant_by_id(tid)
        ai = bool(bg and bg["source"] == "AI")
        w, h = COVER_SIZES[aspect]
        props = {"width": w, "height": h, "src": src, "bg_src": bg_src, "logo": put(logo, "logo") if logo else "", "title": title, "sub": sub,
                 "points": [x for x in points if x][:3], "cta": cta, "info": info, "label": LANGS.get(lang, ("", "AI-generated"))[1] if ai else "",
                 "brand": {k: tenant["brand"].get(k) for k in ("dark", "accent") if tenant["brand"].get(k)}}
        studio.call("/cover", {"dir": str(work), "props": props, "out": "cover.jpg"}, timeout=300)
        d = tdir(tid) / "assets"
        d.mkdir(exist_ok=True)
        fname = uuid.uuid4().hex[:16] + ".jpg"
        with Image.open(work / "cover.jpg") as im:
            exif = Image.Exif()
            if ai:
                exif[0x010E] = f"AI-generated (AIGC) background with {bg['model']}; product is a real photo"
            exif[0x0131] = "智能客服平台"
            im.convert("RGB").save(d / fname, "JPEG", quality=92, exif=exif)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    return db.insert(db.video_assets, tenant_id=tid, kind="cover", name=f"{aspect} · {title.replace('*', '')}"[:120], tag=prod["tag"], file=fname,
                     size=(d / fname).stat().st_size, width=w, height=h, seconds=0, source="AI" if ai else "模板", consent="", created_by=by[:60],
                     created=db.now(), prompt=json.dumps({"title": title, "sub": sub, "points": list(points), "cta": cta, "product": product_id,
                                                          "bg": bg_id}, ensure_ascii=False), model=bg["model"] if ai else "", review="", ref_id=product_id)


# ---------- studio: Remotion templates and the director agent (video-studio/, Node, 127.0.0.1 only) ----------

STUDIO_HERE = Path(__file__).resolve().parent / "video-studio"
STUDIO_PORT = int(os.environ.get("VIDEO_STUDIO_PORT", "8772"))
DIRECTOR_MODELS = ["deepseek/deepseek-v4.1-flash", "qwen/qwen3.8-flash", "z-ai/glm-5.3-flash", "x-ai/grok-4.7"]
DIRECTOR_MAX_COST = 0.3  # USD per run, at the model's catalog price
NAME_OK = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$")


class StudioMissing(VideoError):
    pass


class Studio:
    def __init__(self):
        self.proc = None
        self.lock = threading.Lock()
        self.http = httpx.Client(timeout=httpx.Timeout(30), trust_env=False)

    @staticmethod
    def token():
        p = ROOT / "studio.token"
        if not p.exists():
            ROOT.mkdir(parents=True, exist_ok=True)
            fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as f:
                f.write(secrets.token_urlsafe(32))
        return p.read_text().strip()

    def call(self, path, body=None, timeout=60):
        try:
            r = self.http.request("POST" if body is not None else "GET", f"http://127.0.0.1:{STUDIO_PORT}{path}", json=body,
                                  headers={"x-studio-token": self.token()}, timeout=httpx.Timeout(30, read=timeout))
        except httpx.HTTPError as e:
            raise StudioMissing(f"视频模板服务没在运行：{e!r}"[:200]) from e
        data = r.json() if r.content else {}
        if r.status_code >= 400:
            raise VideoError("视频模板服务：" + str(data.get("error") or r.status_code)[:300])
        return data

    def ready(self):
        try:
            return bool(self.call("/health", timeout=5).get("ready"))
        except VideoError:
            return False

    def ensure(self):
        """Start video-studio/ if it isn't answering. The first start bundles the templates (about a minute)."""
        with self.lock:
            if self.ready():
                return
            if not (self.proc and self.proc.poll() is None):
                if not (STUDIO_HERE / "node_modules").exists() or not shutil.which("node"):
                    raise StudioMissing("视频模板服务没装：在 video-studio/ 里运行 npm install --ignore-scripts")
                self.token()
                logs = Path(settings.env("MUXU_LOG", str(Path(__file__).resolve().parent.parent / "logs" / "muxu.log"))).parent
                logs.mkdir(parents=True, exist_ok=True)
                logf = open(logs / "video-studio.log", "ab")
                env = {**os.environ, "MUXU_DATA_DIR": str(settings.DATA_DIR), "STUDIO_PORT": str(STUDIO_PORT), "NODE_USE_ENV_PROXY": "1"}
                env.pop("STUDIO_TOKEN", None)
                self.proc = subprocess.Popen(["node", str(STUDIO_HERE / "server.mjs")], cwd=STUDIO_HERE, env=env, stdout=logf, stderr=logf,
                                             start_new_session=True)
            for _ in range(360):
                time.sleep(0.5)
                if self.ready():
                    return
                if self.proc.poll() is not None:
                    break
            raise StudioMissing("视频模板服务启动失败，看 video-studio.log")


studio = Studio()


def link(src, dst):
    try:
        os.link(src, dst)
    except OSError:
        shutil.copy(src, dst)


def has_alpha(path):
    try:
        with Image.open(path) as im:
            return im.mode in ("RGBA", "LA", "P") and im.convert("RGBA").getchannel("A").getextrema()[0] < 250
    except OSError:
        return False


def studio_material(tid, p, shots, work):
    """Hard-link everything the timeline may use into the build dir under short names.
    Returns (material for the lint, sizes for the templates, shot id → name, asset id → name)."""
    b = db.loads(p["brief"], {})
    out_dir = pdir(tid, p["id"])
    mat, info, by_shot, by_asset = {}, {}, {}, {}

    def put(name, src, kind, w=0, h=0, seconds=0.0, note="", alpha=False):
        link(src, work / name)
        mat[name] = {k: v for k, v in {"kind": kind, "w": w, "h": h, "seconds": round(seconds or 0, 2), "note": note[:160]}.items() if v}
        if w and h:
            info[name] = {"w": w, "h": h, **({"alpha": True} if alpha else {})}
        return name

    for s in shots:
        if s["kind"] in API_KINDS and s["file"] and (out_dir / s["file"]).exists():
            pi = probe(out_dir / s["file"])
            kind = "avatar" if s["kind"] == "avatar" else "ai"
            note = "the presenter" if kind == "avatar" else f"{KIND_LABEL[s['kind']]}; {s['prompt'][:110]}"
            by_shot[s["id"]] = put(f"{kind}{s['id']}.mp4", out_dir / s["file"], kind, pi.get("width"), pi.get("height"),
                                   pi.get("seconds") or s["seconds"], note)
    rows = assets(tid)
    used = {s["asset_id"] for s in shots if s["asset_id"]}
    tag = (b.get("tag") or "").lower()

    def pick(kind, limit):
        mine = [a for a in rows if a["kind"] == kind and not a["review"]]
        if tag and kind in ("photo", "aiproduct"):
            mine = [a for a in mine if tag in a["tag"].lower()] or ([] if kind == "aiproduct" else mine)
        elif tag and kind == "aiscene":
            mine = [a for a in mine if not a["tag"] or tag in a["tag"].lower()]
        return sorted(mine, key=lambda a: (a["id"] not in used, -a["id"] if kind.startswith("ai") else a["id"]))[:limit]

    prefix = {"photo": ("p", "product"), "scene": ("s", "scene"), "footage": ("f", "footage"), "aiscene": ("g", "aiscene"),
              "aiproduct": ("r", "aiproduct")}
    for kind, limit in (("photo", 4), ("scene", 6), ("footage", 3), ("aiscene", 4), ("aiproduct", 3)):
        for a in pick(kind, limit):
            path = asset_path(a)
            if not path.exists():
                continue
            pre, mk = prefix[kind]
            note = a["name"] + (f", {a['tag']}" if a["tag"] else "")
            alpha = kind == "photo" and has_alpha(path)
            if kind == "photo":
                note += ", cut-out (transparent)" if alpha else ", has its own background: prefer bg light, or bg scene (shown on a white plaque)"
            elif kind == "aiscene":
                note = "AI-generated setting without the product: " + a["prompt"][:120]
            elif kind == "aiproduct":
                note = "AI-generated picture of the product in use, checked by a person: " + a["prompt"][:100]
            by_asset[a["id"]] = put(f"{pre}{a['id']}{path.suffix.lower()}", path, mk, a["width"], a["height"], a["seconds"], note, alpha)
    logo = next((a for a in rows if a["kind"] == "logo" and asset_path(a).exists()), None)
    if logo:
        by_asset[logo["id"]] = put(f"logo{logo['id']}{asset_path(logo).suffix.lower()}", asset_path(logo), "logo", logo["width"], logo["height"])
    music = db.q("SELECT * FROM video_assets WHERE id=:i AND tenant_id=:t AND kind='music'", one=True, i=b.get("music_asset_id") or 0, t=tid)
    if music and asset_path(music).exists():
        by_asset[music["id"]] = put(f"m{music['id']}{asset_path(music).suffix.lower()}", asset_path(music), "music", seconds=music["seconds"])
    return mat, info, by_shot, by_asset


def split_text(text, n):
    words = str(text).split()
    if n <= 1 or len(words) < n * 2:
        return [str(text)] + [""] * (n - 1)
    size = math.ceil(len(words) / n)
    return ([" ".join(words[i:i + size]) for i in range(0, len(words), size)] + [""] * n)[:n]


def clamp(v, lo, hi):
    return max(lo, min(hi, float(v)))


def draft_timeline(tid, p, shots, ln, by_shot, by_asset):
    """A mechanical first cut from the storyboard: the director improves it, and it is what renders if the director is off."""
    b, cfg = db.loads(p["brief"], {}), config(tid)
    tenant = auth.tenant_by_id(tid)
    w, h = ASPECTS.get(b.get("aspect", "9:16"), ASPECTS["9:16"])
    lang = b.get("lang", "en-US")
    assets_by_id = {a["id"]: a for a in assets(tid)}

    def scene_of(s, sec=None):
        sec = float(sec or s["seconds"])
        a = assets_by_id.get(s["asset_id"])
        if s["kind"] == "photo" and s["asset_id"] in by_asset:
            return {"type": "product", "src": by_asset[s["asset_id"]], "seconds": clamp(sec, 1.2, 4.5), "bg": "light", "motion": "push"}
        if s["kind"] == "card":
            c = db.loads(s["card"], {})
            return {"type": "title", "lines": [c.get("title", "")] + c.get("lines", [])[:2], "seconds": clamp(sec, 0.8, 3.5), "bg": "dark"}
        if s["kind"] in ("motion", "scene") and s["id"] in by_shot:
            return {"type": "clip", "src": by_shot[s["id"]], "seconds": clamp(sec, 0.8, 8), "volume": 1}
        if s["kind"] == "footage" and s["asset_id"] in by_asset:
            sec = clamp(min(sec, a["seconds"] or sec), 0.8, 8)
            return {"type": "clip", "src": by_asset[s["asset_id"]], "seconds": sec, "trim": round(max(0.0, ((a["seconds"] or sec) - sec) / 2), 2),
                    "volume": 0, "zoom": "in"}
        return None

    product = next((n for n in by_asset.values() if n.startswith("p")), None)
    setting = next((n for n in by_asset.values() if n.startswith("g")), None)
    end = {"type": "end", "seconds": 2.5, "transition": "fade", "src": product,
           "cta": cfg["end_cta"] or END_CTA.get(lang[:2], END_CTA["en"]),
           "contact": cfg["end_contact"] or tenant["brand"].get("sales_phone") or ""}
    t = {"fps": 30, "width": w, "height": h, "scenes": []}
    broll = [s for s in shots if s["kind"] != "avatar"]
    if p["kind"] == "avatar":
        av = next((s for s in shots if s["kind"] == "avatar" and s["id"] in by_shot), None)
        if not av:
            raise VideoError("数字人镜头还没生成")
        dur = probe(pdir(tid, p["id"]) / av["file"]).get("seconds") or av["seconds"]
        words = [max(1, len(x["text"].split())) for x in ln]
        windows, at = [], 0.0
        for x, n in zip(ln, words):
            windows.append((at, at + dur * n / sum(words), x["text"]))
            at += dur * n / sum(words)
        for i, (a0, a1, _) in enumerate(windows):
            at = a0 + 0.4
            for s in [s for s in broll if s["seg"] == i]:
                d = min(s["seconds"], a1 - 0.3 - at)
                sc = scene_of(s, d) if d >= 1.2 else None
                if not sc:
                    break
                t["scenes"].append({**sc, "at": round(at, 2), "seconds": round(d, 2), "layout": "full"})
                at += d
        t["avatar"] = {"src": by_shot[av["id"]], "seconds": round(dur, 2), "zooms": []}
        t["captions"] = [{"text": x, "start": round(a0, 2), "end": round(a1, 2)} for a0, a1, x in windows if x]
    else:
        trans = ["slide", "cut", "wipe", "cut"]
        for i, x in enumerate(ln):
            mine = [sc_s for sc_s in ((s, scene_of(s)) for s in broll if s["seg"] == i) if sc_s[1]]
            texts = split_text(x["text"], len([1 for _, sc in mine if sc["type"] != "title"]) or 1)
            k = 0
            for s, sc in mine:
                if sc["type"] != "title":
                    sc["caption"] = texts[k] if k < len(texts) else ""
                    k += 1
                sc["transition"] = trans[len(t["scenes"]) % 4] if t["scenes"] else "cut"
                t["scenes"].append(sc)
        if not t["scenes"]:
            raise VideoError("分镜是空的")
        first = next((sc for sc in t["scenes"] if sc["type"] == "product"), None)
        if setting and first:
            first.update(bg="scene", bg_src=setting)
    t["scenes"].append(end)
    return t


def material_sheet(work, mat):
    """Every picture with its name, for the director (videos: a few frames with their time)."""
    f = font("bold", 20)
    cells = []

    def cell(img, label):
        img = img.convert("RGBA")
        bg = Image.new("RGBA", img.size, (232, 232, 232, 255))
        bg.alpha_composite(img)
        bg.thumbnail((300, 236))
        c = Image.new("RGB", (310, 276), "white")
        c.paste(bg.convert("RGB"), ((310 - bg.width) // 2, 4))
        ImageDraw.Draw(c).text((8, 248), label[:30], fill="black", font=f)
        return c

    for name, m in mat.items():
        if m["kind"] == "music":
            continue
        if name.endswith(".mp4") or m["kind"] in ("footage", "ai", "avatar"):
            dur = m.get("seconds") or 1
            fracs = (0.15, 0.5, 0.85) if m["kind"] == "ai" else (0.1, 0.25, 0.4, 0.55, 0.7, 0.85) if dur > 20 else (0.2, 0.4, 0.6, 0.8)
            for frac in ((0.5,) if m["kind"] == "avatar" else fracs):
                at = round(dur * frac, 1)
                tmp = work / "_frame.jpg"
                try:
                    ff(["-ss", f"{at}", "-i", str(work / name), "-frames:v", "1", "-vf", "scale=480:-2", str(tmp)], timeout=60)
                    with Image.open(tmp) as im:
                        cells.append(cell(im, f"{name} @ {at:g}s"))
                except (VideoError, OSError):
                    pass
        else:
            try:
                with Image.open(work / name) as im:
                    cells.append(cell(im, name))
            except OSError:
                pass
        if len(cells) >= 28:
            break
    (work / "_frame.jpg").unlink(missing_ok=True)
    cols = 4
    sheet = Image.new("RGB", (310 * cols, 276 * max(1, math.ceil(len(cells) / cols))), "white")
    for i, c in enumerate(cells):
        sheet.paste(c, ((i % cols) * 310, (i // cols) * 276))
    out = work / "material.jpg"
    sheet.save(out, quality=85)
    return out


def director_brief(tid, p, ln, script, target):
    b = db.loads(p["brief"], {})
    tenant = auth.tenant_by_id(tid)
    facts = [f"- {f.get('claim', '')} (source: \"{f.get('quote', '')}\")" for s in script.get("segments", []) for f in s.get("facts", []) if f.get("quote")]
    return "\n".join([
        f"Brand: {tenant['name']}. Product: {b.get('product') or '-'}. Market: {b.get('market') or b.get('lang', 'en-US')}; "
        f"on-screen language: {LANGS.get(b.get('lang', 'en-US'), ('English',))[0]}.",
        f"Kind: {'presenter video (avatar mode)' if p['kind'] == 'avatar' else 'scene ad'}, {b.get('aspect', '9:16')}, {b.get('platform') or 'TikTok'}. "
        f"Target about {target:.0f} s. Audience: {b.get('audience') or 'overseas buyers'}.",
        "Approved script lines (facts checked), in order:",
        *[f"- {x['part'] or 'line'}: {x['text']}" for x in ln if x["text"]],
        "Facts with their source quotes:", *(facts or ["- (only what the script lines say)"]),
    ])


def compose_studio(tid, pid, by=0):
    """Remotion render of a timeline the director has checked frame by frame. Returns the render id."""
    p = db.q("SELECT * FROM video_projects WHERE id=:i AND tenant_id=:t", one=True, i=pid, t=tid)
    tenant = auth.tenant_by_id(tid)
    b, script, cfg = db.loads(p["brief"], {}), db.loads(p["script"], {}), config(tid)
    lang = b.get("lang", "en-US")
    ln, shots = lines(script), shots_of(pid)
    studio.ensure()
    out_dir = pdir(tid, pid)
    work = out_dir / "build"
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir()
    mat, info, by_shot, by_asset = studio_material(tid, p, shots, work)
    draft = draft_timeline(tid, p, shots, ln, by_shot, by_asset)
    contact = next((s.get("contact", "") for s in draft["scenes"] if s["type"] == "end"), "")
    said = " ".join([x["text"] for x in ln] + [" ".join([c.get("title", "")] + c.get("lines", [])) for c in (db.loads(s["card"], {}) for s in shots)]
                    + [b.get("product") or "", b.get("tag") or ""])
    target = (draft["avatar"]["seconds"] + 2.5) if draft.get("avatar") else float(b.get("seconds") or 30)
    rules = {"material": mat, "allowed_numbers": sorted({n.replace(".", "") for n in numbers(said)}), "contact": contact,
             "risky": RISKY.get(lang[:2], RISKY["en"]), "target_seconds": round(target)}
    logo = next((n for n, m in mat.items() if m["kind"] == "logo"), "")
    music = next((n for n, m in mat.items() if m["kind"] == "music"), "")
    extra = {"label": LANGS.get(lang, ("", "AI-generated"))[1], "logo": logo, "info": info,
             "brand": {k: tenant["brand"].get(k) for k in ("dark", "accent") if tenant["brand"].get(k)}, **({"music": {"src": music}} if music else {})}
    timeline, notes, director = draft, "", ""
    key = api_key(tid)
    if not cfg.get("director", True):
        notes = "没开导演，按分镜直接出片。"
    elif not key:
        notes = "没有 OpenRouter 密钥，导演没上场，按分镜直接出片。"
    elif month_spent(tid) + DIRECTOR_MAX_COST > float(cfg["budget_month"] or 0):
        notes = "本月视频预算快用完了，导演没上场，按分镜直接出片。"
    else:
        director = cfg.get("director_model") or DIRECTOR_MODELS[0]
        looks = []
        for name, m in mat.items():
            if m["kind"] == "product" and len(looks) < 2:
                im = flat_image(work / name)
                im.thumbnail((1024, 1024))
                im.save(work / f"look-{Path(name).stem}.jpg", quality=88)
                looks.append(str(work / f"look-{Path(name).stem}.jpg"))
        try:
            res = studio.call("/direct", {"dir": str(work), "timeline": draft, "rules": rules, "extra": extra,
                                          "brief": director_brief(tid, p, ln, script, target),
                                          "images": [str(material_sheet(work, mat)), *looks], "model": director, "apiKey": key,
                                          "maxTurns": 14, "maxCost": DIRECTOR_MAX_COST}, timeout=1500)
        except VideoError as e:
            log.warning("director %s: %s", pid, e)
            res = {"timeline": None, "stop": str(e)}
        finally:
            key = ""
        if res.get("cost"):
            db.insert(db.video_costs, tenant_id=tid, project_id=pid, shot_id=0, model=director, seconds=0, amount=float(res["cost"]), created=db.now())
        if res.get("timeline"):
            timeline = res["timeline"]
            notes = res.get("notes") or ("导演没写完说明就到了步数上限，这是它最后一版没有错误的剪辑。" if not res.get("done") else "")
        else:
            notes = f"导演没交稿（{str(res.get('stop') or '没有原因')[:120]}），按分镜直接出片。"
    props = {**timeline, **extra}
    got = studio.call("/render", {"dir": str(work), "timeline": props, "out": "studio.mp4"}, timeout=1800)
    total = float(got["seconds"])
    content_id = uuid.uuid4().hex
    used = {s.get("src") for s in timeline.get("scenes", [])} | {s.get("bg_src") for s in timeline.get("scenes", [])}
    pics = {int(n[1:].split(".")[0]) for n in used if n and n[0] in "gr" and n[1:].split(".")[0].isdigit()}
    image_models = {a["model"] for a in assets(tid) if a["id"] in pics and a["model"]}
    models = sorted({s["model"] for s in shots if s["kind"] in API_KINDS and s["model"]} | image_models | ({director} if director else set()))
    aigc = {"AIGC": {"Label": "1", "ContentProducer": f"{tenant['name']} via 智能客服平台", "ProduceID": content_id,
                     "ContentPropagator": tenant["name"], "Models": models}}
    rid = db.insert(db.video_renders, project_id=pid, tenant_id=tid, file="", seconds=round(total, 2), content_id=content_id, status="待审核",
                    created_by=by or p["created_by"], created=db.now(), engine="remotion", timeline=db.dumps(timeline), notes=notes[:1000])
    name = f"render{rid}.mp4"
    try:
        ff(["-i", str(work / "studio.mp4"), "-map", "0:v", "-map", "0:a", "-c:v", "copy", "-af", "loudnorm=I=-14:TP=-1.5:LRA=11",
            "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart+use_metadata_tags", "-metadata", f"title={p['title']}",
            "-metadata", f"comment={json.dumps(aigc, ensure_ascii=False)}",
            "-metadata", "description=AI-generated content (AIGC). " + ", ".join(models), "-metadata", f"aigc_content_id={content_id}",
            str(out_dir / name)], timeout=600)
    except Exception:
        db.x("DELETE FROM video_renders WHERE id=:i", i=rid)
        raise
    events = caption_events([(c["start"], c["end"], c["text"]) for c in got.get("captions", [])])
    (out_dir / f"render{rid}.srt").write_text("\n".join(f"{i}\n{srt_time(a)} --> {srt_time(b2)}\n{t}\n" for i, (a, b2, t) in enumerate(events, start=1)))
    w, h = timeline.get("width", 1080), timeline.get("height", 1920)
    ff(["-i", str(out_dir / name), "-vf", f"fps=1,scale={180 if h > w else 240}:-2,tile=8x{max(1, math.ceil(total / 8))}:padding=4:color=white",
        "-frames:v", "1", str(out_dir / f"render{rid}.jpg")])
    db.x("UPDATE video_renders SET file=:f WHERE id=:i", f=name, i=rid)
    shutil.rmtree(work, ignore_errors=True)
    return rid


def compose(tid, pid, by=0):
    """The Remotion path when it is on and installed; ffmpeg otherwise, or if it fails (the render says why)."""
    if not config(tid).get("studio", True):
        return compose_ffmpeg(tid, pid, by)
    try:
        return compose_studio(tid, pid, by)
    except StudioMissing as e:
        log.warning("studio unavailable for %s: %s", pid, e)
        return compose_ffmpeg(tid, pid, by, notes=f"新版模板没用上（{e}），这一版是旧版合成。")
    except Exception as e:  # noqa: BLE001 - the old path still gives the operator a video to review
        log.exception("studio compose %s", pid)
        return compose_ffmpeg(tid, pid, by, notes=f"新版模板出错（{str(e)[:160]}），这一版是旧版合成。")
