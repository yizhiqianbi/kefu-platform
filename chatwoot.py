"""Chatwoot 渠道层：每个客户一个 Chatwoot account，平台的 agent bot 回答各渠道的客户消息，答不了就交给收件箱里的坐席。
令牌只存在数据目录里（600），不进数据库、不回给浏览器。"""
import hashlib
import hmac
import json
import re
import secrets
import string
import time

import httpx

import db
import settings

http = httpx.AsyncClient(timeout=httpx.Timeout(20), trust_env=False)

CHANNELS = {
    "Channel::Api": "api", "Channel::WebWidget": "widget", "Channel::Email": "email", "Channel::Whatsapp": "whatsapp",
    "Channel::FacebookPage": "messenger", "Channel::Instagram": "instagram", "Channel::Telegram": "telegram",
    "Channel::Line": "line", "Channel::Sms": "sms", "Channel::TwilioSms": "sms", "Channel::Tiktok": "tiktok",
}
CHANNEL_LABEL = {"api": "接口", "widget": "网站聊天", "email": "邮件", "whatsapp": "WhatsApp", "messenger": "Messenger",
                 "instagram": "Instagram", "telegram": "Telegram", "line": "LINE", "sms": "短信", "tiktok": "TikTok",
                 "tg_personal": "Telegram 个人号", "wa_personal": "WhatsApp 个人号", "ig_personal": "Instagram 个人号",
                 "wecom_kf": "企业微信客服", "fb_personal": "Messenger 个人号", "tt_personal": "TikTok 个人号"}
# Longest single message each channel accepts; longer answers are split by sentence.
MAX_CHARS = {"instagram": 1000, "tiktok": 950, "messenger": 2000, "line": 2000, "sms": 320, "telegram": 4000, "whatsapp": 4000,
             "tg_personal": 4000, "wa_personal": 4000, "ig_personal": 1000, "wecom_kf": 600,
             "fb_personal": 2000, "tt_personal": 950}
# API inboxes that are personal accounts (personal.py) -> their channel name; filled at startup.
PERSONAL_INBOXES: dict[int, str] = {}
# Chatwoot's own AI (Captain) needs an OpenAI key and overlaps with ours; the rest are hidden from the trimmed UI.
ACCOUNT_FEATURES = {"captain_tasks": False, "help_center": False, "campaigns": False}


class ChatwootError(RuntimeError):
    pass


def url():
    return settings.CHATWOOT_URL


def platform_token():
    return settings.secret("CHATWOOT_PLATFORM_TOKEN")


def configured():
    return bool(url() and platform_token())


def channel_of(channel_type, inbox_id=None):
    if inbox_id in PERSONAL_INBOXES:
        return PERSONAL_INBOXES[inbox_id]
    return CHANNELS.get(channel_type or "", "chatwoot")


# ---------- secrets ----------

def _dir():
    d = settings.DATA_DIR / "chatwoot"
    d.mkdir(mode=0o700, exist_ok=True)
    return d


def secret(tid):
    p = _dir() / f"{tid}.secret"
    return json.loads(p.read_text()) if p.exists() else {}


def save_secret(tid, data):
    p = _dir() / f"{tid}.secret"
    p.write_text(json.dumps(data))
    p.chmod(0o600)


def drop_secret(tid):
    (_dir() / f"{tid}.secret").unlink(missing_ok=True)


def link(tid):
    return db.q("SELECT * FROM chatwoot_links WHERE tenant_id=:t", one=True, t=tid)


def link_by_token(token):
    return db.q("SELECT * FROM chatwoot_links WHERE hook_token=:h", one=True, h=token) if token else None


# ---------- http ----------

async def _call(method, path, token, **kw):
    try:
        r = await http.request(method, url() + path, headers={"api_access_token": token}, **kw)
    except httpx.HTTPError as e:
        raise ChatwootError(f"Chatwoot 连不上：{e!r}"[:200]) from e
    if r.status_code >= 400:
        try:
            detail = r.json()
            detail = detail.get("message") or detail.get("error") or detail.get("errors") or detail
        except ValueError:
            detail = r.text[:200]
        raise ChatwootError(f"Chatwoot 返回 {r.status_code}：{detail}"[:300])
    return r.json() if r.content else {}


async def platform(method, path, **kw):
    return await _call(method, "/platform/api/v1" + path, platform_token(), **kw)


async def as_admin(tid, method, path, **kw):
    s = secret(tid)
    return await _call(method, f"/api/v1/accounts/{s['account_id']}" + path, s["admin_token"], **kw)


async def as_bot(tid, method, path, **kw):
    s = secret(tid)
    return await _call(method, f"/api/v1/accounts/{s['account_id']}" + path, s["bot_token"], **kw)


def _password():
    """Chatwoot wants upper, lower, digit and a symbol; nobody types it, people sign in through SSO links."""
    pool = string.ascii_letters + string.digits
    return "".join(secrets.choice(pool) for _ in range(20)) + "aA1!"


# ---------- provisioning ----------

def hook_url(token):
    return f"{settings.MUXU_PUBLIC_URL}/muxu/api/chatwoot/hook/{token}"


async def provision(tenant):
    """Account + a service admin (creates inboxes, attaches the bot) + the agent bot."""
    tid = tenant["id"]
    token = secrets.token_urlsafe(24)
    account = await platform("POST", "/accounts", json={"name": tenant["name"], "locale": "zh_CN", "features": ACCOUNT_FEATURES})
    aid = account["id"]
    try:
        admin = await platform("POST", "/users", json={
            "name": f"{tenant['name']} 平台服务号", "email": f"svc-{tenant['slug']}-{secrets.token_hex(4)}@{settings.CHATWOOT_MAIL_DOMAIN}",
            "password": _password()})
        await platform("POST", f"/accounts/{aid}/account_users", json={"user_id": admin["id"], "role": "administrator"})
        bot = await platform("POST", "/agent_bots", json={
            "name": "AI 客服", "description": "客服平台的知识库机器人，答不了的转给人工", "outgoing_url": hook_url(token),
            "account_id": aid})
        save_secret(tid, {"account_id": aid, "admin_id": admin["id"], "admin_token": admin["access_token"],
                          "bot_id": bot["id"], "bot_token": bot["access_token"], "users": {}})
        s = secret(tid)
        s["bot_secret"] = (await as_admin(tid, "GET", f"/agent_bots/{bot['id']}"))["secret"]
        save_secret(tid, s)
    except (ChatwootError, KeyError) as e:
        drop_secret(tid)
        try:
            await platform("DELETE", f"/accounts/{aid}")
        except ChatwootError:
            pass
        raise ChatwootError(f"开通失败：{e}") from e
    db.x("DELETE FROM chatwoot_links WHERE tenant_id=:t", t=tid)
    db.insert(db.chatwoot_links, tenant_id=tid, account_id=aid, bot_id=bot["id"], hook_token=token, enabled=True, created=db.now())
    return link(tid)


async def deprovision(tid):
    s = secret(tid)
    if s.get("account_id"):
        await platform("DELETE", f"/accounts/{s['account_id']}")
    drop_secret(tid)
    db.x("DELETE FROM chatwoot_links WHERE tenant_id=:t", t=tid)


async def attach(tid, inbox_id, bot_id):
    await as_admin(tid, "POST", f"/inboxes/{inbox_id}/set_agent_bot", json={"agent_bot": bot_id})


async def inboxes(tid):
    """Every inbox with its channel and whether our bot answers it; inboxes added later in Chatwoot get the bot here."""
    bot_id = secret(tid).get("bot_id")
    out = []
    for ib in (await as_admin(tid, "GET", "/inboxes")).get("payload", []):
        bot = (await as_admin(tid, "GET", f"/inboxes/{ib['id']}/agent_bot")).get("agent_bot") or {}
        out.append({"id": ib["id"], "name": ib["name"], "channel": channel_of(ib.get("channel_type"), ib["id"]),
                    "identifier": ib.get("inbox_identifier") or "", "bot": bot.get("id") == bot_id})
    return out


async def attach_all(tid):
    bot_id = secret(tid)["bot_id"]
    n = 0
    for ib in await inboxes(tid):
        if not ib["bot"]:
            await attach(tid, ib["id"], bot_id)
            n += 1
    return n


async def _member(tid, user, role):
    """One Chatwoot user per platform user, added to this tenant's account."""
    s = secret(tid)
    cw_uid = s["users"].get(str(user["id"]))
    if not cw_uid:
        created = await platform("POST", "/users", json={"name": user["name"] or user["email"], "email": user["email"], "password": _password()})
        cw_uid = created["id"]
        s["users"][str(user["id"])] = cw_uid
        s.setdefault("tokens", {})[str(cw_uid)] = created.get("access_token") or ""
        save_secret(tid, s)
    if not s.get("joined", {}).get(str(cw_uid)):
        try:
            await platform("POST", f"/accounts/{s['account_id']}/account_users",
                           json={"user_id": cw_uid, "role": "administrator" if role == "admin" else "agent"})
        except ChatwootError as e:
            if "422" not in str(e):
                raise
        s = secret(tid)
        s.setdefault("joined", {})[str(cw_uid)] = True
        save_secret(tid, s)
    return cw_uid


async def sso(tid, user, role):
    """Returns a one-time login link for the user's Chatwoot account."""
    cw_uid = await _member(tid, user, role)
    return (await platform("GET", f"/users/{cw_uid}/login"))["url"]


async def user_token(tid, user, role):
    """The access token of the user's Chatwoot account, so what people send from the console shows their name."""
    cw_uid = await _member(tid, user, role)
    s = secret(tid)
    tok = s.get("tokens", {}).get(str(cw_uid))
    if not tok:
        tok = (await platform("GET", f"/users/{cw_uid}"))["access_token"]
        s.setdefault("tokens", {})[str(cw_uid)] = tok
        save_secret(tid, s)
    return tok


async def as_user(tid, token, method, path, **kw):
    return await _call(method, f"/api/v1/accounts/{secret(tid)['account_id']}" + path, token, **kw)


def verify(tid, body, timestamp, signature, max_age=300):
    """X-Chatwoot-Signature = sha256=HMAC(bot secret, "{timestamp}.{raw body}")."""
    key = secret(tid).get("bot_secret")
    if not key or not timestamp or not signature:
        return False
    try:
        if abs(time.time() - int(timestamp)) > max_age:
            return False
    except ValueError:
        return False
    want = "sha256=" + hmac.new(key.encode(), timestamp.encode() + b"." + body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(want, signature)


# ---------- conversations ----------
# Bot tokens may read a conversation, post messages and change status, but not list messages; history goes through the service admin.

async def conversation(tid, cid):
    return await as_bot(tid, "GET", f"/conversations/{cid}")


async def messages(tid, cid):
    """The latest 20 messages, private notes and activity lines left out."""
    data = await as_admin(tid, "GET", f"/conversations/{cid}/messages", params={"filter_internal_messages": "true"})
    return sorted(data.get("payload", []), key=lambda m: (m.get("created_at") or 0, m["id"]))


async def send(tid, cid, content, private=False):
    return await as_bot(tid, "POST", f"/conversations/{cid}/messages",
                        json={"content": content, "message_type": "outgoing", "private": private})


async def set_status(tid, cid, status):
    await as_bot(tid, "POST", f"/conversations/{cid}/toggle_status", json={"status": status})


_inbox_cache: dict[int, tuple[float, dict]] = {}


async def inbox_map(tid, max_age=30):
    """inbox id -> {name, channel}; read often by the conversation list, so cached briefly."""
    hit = _inbox_cache.get(tid)
    if hit and time.time() - hit[0] < max_age:
        return hit[1]
    data = await as_admin(tid, "GET", "/inboxes")
    out = {ib["id"]: {"id": ib["id"], "name": ib["name"], "channel": channel_of(ib.get("channel_type"), ib["id"]),
                      "email": ib.get("email") or ""} for ib in data.get("payload", [])}
    _inbox_cache[tid] = (time.time(), out)
    return out


def forget_inboxes(tid):
    _inbox_cache.pop(tid, None)


async def list_conversations(tid, page=1, status="all", inbox_id=None, query=""):
    params = {"status": status, "assignee_type": "all", "page": page, "sort_by": "last_activity_at_desc"}
    if inbox_id:
        params["inbox_id"] = inbox_id
    if query:
        params["q"] = query
        data = await as_admin(tid, "GET", "/conversations/search", params=params)
    else:
        data = await as_admin(tid, "GET", "/conversations", params=params)
    data = data.get("data", data)
    return data.get("payload", []), data.get("meta", {})


async def thread(tid, cid, before=None):
    """Messages including private notes and activity lines, oldest first."""
    params = {"before": before} if before else {}
    data = await as_admin(tid, "GET", f"/conversations/{cid}/messages", params=params)
    return sorted(data.get("payload", []), key=lambda m: (m.get("created_at") or 0, m["id"])), data.get("meta", {})


async def mark_read(tid, token, cid):
    await as_user(tid, token, "POST", f"/conversations/{cid}/update_last_seen")


async def find_contact(tid, email):
    data = await as_admin(tid, "GET", "/contacts/search", params={"q": email})
    for c in data.get("payload", []):
        if (c.get("email") or "").lower() == email.lower():
            return c
    return None


async def contact_for(tid, email, name):
    """The Chatwoot contact with this email, created if missing."""
    found = await find_contact(tid, email)
    if found:
        return found
    data = await as_admin(tid, "POST", "/contacts", json={"email": email, "name": name or email})
    return (data.get("payload") or {}).get("contact") or data.get("payload") or data


async def start_conversation(tid, token, inbox_id, contact_id, content, subject="", custom=None):
    """A new conversation we open ourselves (e.g. an outreach email); the first message is sent right away."""
    body = {"inbox_id": inbox_id, "contact_id": contact_id, "status": "open",
            "message": {"content": content}, "custom_attributes": custom or {}}
    if subject:
        body["additional_attributes"] = {"mail_subject": subject}
    return await as_user(tid, token, "POST", "/conversations", json=body)


def conversation_url(tid, cid):
    s = secret(tid)
    return f"{settings.CHATWOOT_PUBLIC_URL}/app/accounts/{s['account_id']}/conversations/{cid}" if s else ""


def split(text, limit):
    """Split on sentence ends so no piece exceeds the channel's limit."""
    if len(text) <= limit:
        return [text]
    parts, cur = [], ""
    for piece in re.split(r"(?<=[。！？!?.\n])", text):
        while len(piece) > limit:
            if cur:
                parts.append(cur)
                cur = ""
            parts.append(piece[:limit])
            piece = piece[limit:]
        if len(cur) + len(piece) > limit:
            parts.append(cur)
            cur = ""
        cur += piece
    if cur.strip():
        parts.append(cur)
    return [p.strip() for p in parts if p.strip()]
