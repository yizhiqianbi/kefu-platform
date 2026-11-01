"""个人号和企业微信渠道：用 Telegram / WhatsApp / Instagram 的个人账号，或企业微信的微信客服收发私信。

每个个人号在 Chatwoot 里是一个 API 收件箱：对方发来的私信由这里写进收件箱（客户消息），
收件箱里发出的消息（AI 或同事）由 Chatwoot 推到 hook_url，再由这里用个人号发出去。
这样 AI 流程、会话页、客户页都和官方渠道一样走 Chatwoot，不用分两套。

Telegram 用官方的用户协议（MTProto，Telethon）；WhatsApp 用 Baileys（wa-bridge/ 旁路 Node 服务）；
Instagram 用 instagrapi 定时拉私信；Messenger 用 ws3-fca（fb-bridge/，一个号一个 Node 进程）；
TikTok 没有可用的库，在本机无界面浏览器里开网页版私信来读和发。这几个都是社区逆向或模拟网页，
平台随时可能改协议或封号，只建议用测试号或能承受风险的号。
企业微信走官方的微信客服接口（自建应用），消息靠回调通知或定时拉取。
会话文件和 API 密钥只放在 data/personal/{id}/（700/600），不进数据库，不回给浏览器。
"""
import asyncio
import hashlib
import json
import logging
import os
import random
import re
import secrets
import shutil
import subprocess
import threading
import time
from pathlib import Path
from urllib.parse import urlparse

import httpx

import chatwoot
import db
import settings

log = logging.getLogger("personal")

PLATFORMS = {
    "telegram": {"channel": "tg_personal", "label": "Telegram 个人号", "short": "Telegram"},
    "whatsapp": {"channel": "wa_personal", "label": "WhatsApp 个人号", "short": "WhatsApp"},
    "instagram": {"channel": "ig_personal", "label": "Instagram 个人号", "short": "Instagram"},
    "wecom": {"channel": "wecom_kf", "label": "企业微信客服", "short": "企业微信"},
    "messenger": {"channel": "fb_personal", "label": "Messenger 个人号", "short": "Messenger"},
    "tiktok": {"channel": "tt_personal", "label": "TikTok 个人号", "short": "TikTok"},
}
ECHO_TTL = 120          # seconds a message we wrote ourselves is remembered, so it isn't bounced back
IG_POLL = (25, 45)      # Instagram has no push for unofficial clients; poll at a jittered interval


class PersonalError(RuntimeError):
    pass


# ---------- files ----------

def root():
    d = settings.DATA_DIR / "personal"
    d.mkdir(mode=0o700, exist_ok=True)
    return d


def acc_dir(acc_id):
    d = root() / str(acc_id)
    d.mkdir(mode=0o700, exist_ok=True)
    return d


def read_json(path):
    return json.loads(path.read_text()) if path.exists() else {}


def write_json(path, data):
    path.write_text(json.dumps(data))
    path.chmod(0o600)


def proxy():
    """Platforms are reached through PERSONAL_PROXY (defaults to the machine's HTTPS proxy)."""
    return settings.PERSONAL_PROXY


# ---------- accounts ----------

def account(acc_id):
    return db.q("SELECT * FROM personal_accounts WHERE id=:a", one=True, a=acc_id)


def accounts(tid=None):
    if tid is None:
        return db.q("SELECT * FROM personal_accounts ORDER BY id")
    return db.q("SELECT * FROM personal_accounts WHERE tenant_id=:t ORDER BY id", t=tid)


def by_token(token):
    return db.q("SELECT * FROM personal_accounts WHERE hook_token=:h", one=True, h=token) if token else None


def set_status(acc_id, status, error="", **kw):
    sets = ", ".join(f"{k}=:{k}" for k in kw)
    db.x(f"UPDATE personal_accounts SET status=:s, error=:e, updated=:u{', ' + sets if sets else ''} WHERE id=:a",
         s=status, e=error[:500], u=time.time(), a=acc_id, **kw)


def refresh_channels():
    """Tell the Chatwoot layer which API inboxes are personal accounts, so they get their own channel name."""
    chatwoot.PERSONAL_INBOXES.clear()
    for a in accounts():
        if a["inbox_id"]:
            chatwoot.PERSONAL_INBOXES[a["inbox_id"]] = PLATFORMS[a["platform"]]["channel"]


def hook_url(token):
    return f"{settings.MUXU_PUBLIC_URL}/muxu/api/personal/hook/{token}"


async def create(tid, platform, name):
    if platform not in PLATFORMS:
        raise PersonalError("不支持这个平台")
    p = PLATFORMS[platform]
    token = secrets.token_urlsafe(24)
    box = await chatwoot.as_admin(tid, "POST", "/inboxes", json={
        "name": f"{p['label']} · {name}"[:60], "channel": {"type": "api", "webhook_url": hook_url(token)}})
    acc_id = db.insert(db.personal_accounts, tenant_id=tid, platform=platform, name=name[:80], inbox_id=box["id"], hook_token=token,
                       status="待登录", created=time.time(), updated=time.time())
    await chatwoot.attach_all(tid)
    chatwoot.forget_inboxes(tid)
    refresh_channels()
    return account(acc_id)


async def logout(acc):
    await DRIVERS[acc["platform"]].stop(acc, logout=True)
    shutil.rmtree(root() / str(acc["id"]), ignore_errors=True)
    set_status(acc["id"], "待登录", handle="", since=0)


async def remove(acc):
    """Log out and delete the inbox with its conversations."""
    await logout(acc)
    if acc["inbox_id"]:
        try:
            await chatwoot.as_admin(acc["tenant_id"], "DELETE", f"/inboxes/{acc['inbox_id']}")
        except chatwoot.ChatwootError as e:
            if "404" not in str(e):
                raise
    db.x("DELETE FROM personal_accounts WHERE id=:a", a=acc["id"])
    chatwoot.forget_inboxes(acc["tenant_id"])
    refresh_channels()


def view(acc):
    p = PLATFORMS[acc["platform"]]
    return {"id": acc["id"], "platform": acc["platform"], "label": p["label"], "short": p["short"], "name": acc["name"],
            "handle": acc["handle"], "inbox_id": acc["inbox_id"], "status": acc["status"], "error": acc["error"],
            "peers": db.scalar("SELECT COUNT(*) FROM personal_peers WHERE account_id=:a", a=acc["id"]),
            "login": DRIVERS[acc["platform"]].login_state(acc["id"])}


# ---------- echo guards ----------
# Three loops to break: what we write into Chatwoot comes back through the inbox webhook; what we send on the platform
# comes back as the account's own message; and the same platform message can arrive twice (live and on reconnect).

_echo: dict[tuple, float] = {}


def _key(*parts):
    return tuple(str(p) for p in parts)


def _remember(*parts):
    now = time.time()
    for k in [k for k, t in _echo.items() if t < now]:
        _echo.pop(k, None)
    _echo[_key(*parts)] = now + ECHO_TTL


def _seen(*parts):
    t = _echo.get(_key(*parts))
    return bool(t and t > time.time())


def _digest(text):
    return hashlib.sha1((text or "").strip().encode()).hexdigest()[:16]


# ---------- platform -> Chatwoot ----------

_locks: dict[tuple, asyncio.Lock] = {}


def media_text(platform, media, text):
    if not media:
        return text
    hint = f"[{media}]"
    return f"{hint} {text}" if text else f"{hint}（客户发了{media}，在 {PLATFORMS[platform]['short']} 上查看）"


async def _peer(acc, peer, name):
    row = db.q("SELECT * FROM personal_peers WHERE account_id=:a AND peer=:p", one=True, a=acc["id"], p=peer)
    if row and row["contact_id"]:
        if name and name != row["name"]:
            db.x("UPDATE personal_peers SET name=:n WHERE id=:i", n=name[:200], i=row["id"])
        return row
    tid = acc["tenant_id"]
    ident = f"personal:{acc['id']}:{peer}"
    attrs = {"platform": acc["platform"], "personal_account": acc["id"], "peer": peer}
    try:
        data = await chatwoot.as_admin(tid, "POST", "/contacts", json={
            "name": (name or peer)[:200], "identifier": ident, "inbox_id": acc["inbox_id"], "additional_attributes": attrs})
        contact = (data.get("payload") or {}).get("contact") or data.get("payload") or data
    except chatwoot.ChatwootError as e:
        if "422" not in str(e):
            raise
        found = await chatwoot.as_admin(tid, "GET", "/contacts/search", params={"q": ident})
        contact = next((c for c in found.get("payload", []) if c.get("identifier") == ident), None)
        if not contact:
            raise
    if row:
        db.x("UPDATE personal_peers SET contact_id=:c, name=:n WHERE id=:i", c=contact["id"], n=(name or row["name"])[:200], i=row["id"])
    else:
        db.insert(db.personal_peers, account_id=acc["id"], peer=peer, name=(name or "")[:200], contact_id=contact["id"], created=time.time())
    return db.q("SELECT * FROM personal_peers WHERE account_id=:a AND peer=:p", one=True, a=acc["id"], p=peer)


async def _conversation(acc, p):
    """The peer's open conversation in this inbox; a resolved one is left closed and a new one started."""
    tid = acc["tenant_id"]
    if p["conv_id"]:
        try:
            c = await chatwoot.as_admin(tid, "GET", f"/conversations/{p['conv_id']}")
            if c.get("status") != "resolved":
                return p["conv_id"], c.get("status")
        except chatwoot.ChatwootError as e:
            if "404" not in str(e):
                raise
    c = await chatwoot.as_admin(tid, "POST", "/conversations", json={"inbox_id": acc["inbox_id"], "contact_id": p["contact_id"]})
    cid = c.get("display_id") or c["id"]
    db.x("UPDATE personal_peers SET conv_id=:c WHERE id=:i", c=cid, i=p["id"])
    return cid, c.get("status")


async def deliver(acc_id, peer, name, text, media="", from_me=False, msgid="", ts=0.0):
    """A message seen on the platform. Customer messages go in as incoming; what the owner typed on the phone goes in as
    outgoing and hands the conversation to people, so the AI doesn't talk over them."""
    acc = account(acc_id)
    if not acc or acc["status"] == "待登录":
        return
    if msgid and _seen("msg", acc_id, msgid):
        return
    if msgid:
        _remember("msg", acc_id, msgid)
    if ts and ts < acc["since"]:
        return
    content = media_text(acc["platform"], media, (text or "").strip())
    if not content:
        return
    if from_me and _seen("sent", acc_id, peer, _digest(text)):
        return
    lock = _locks.setdefault((acc_id, peer), asyncio.Lock())
    async with lock:
        p = await _peer(acc, peer, name)
        cid, status = await _conversation(acc, p)
        tid = acc["tenant_id"]
        if not from_me:
            db.x("UPDATE personal_peers SET last_in=:t, sent=0 WHERE id=:i", t=ts or time.time(), i=p["id"])
            await chatwoot.as_admin(tid, "POST", f"/conversations/{cid}/messages", json={"content": content, "message_type": "incoming"})
            return
        _remember("cw", cid, _digest(content))
        await chatwoot.as_admin(tid, "POST", f"/conversations/{cid}/messages", json={"content": content, "message_type": "outgoing"})
        if status == "pending":
            await chatwoot.set_status(tid, cid, "open")
            who = "有同事在企业微信里" if acc["platform"] == "wecom" else f"你在 {PLATFORMS[acc['platform']]['short']} 上"
            await chatwoot.send(tid, cid, f"{who}亲自回复了，这个会话改由人工处理，AI 先不插话。", private=True)


# ---------- Chatwoot -> platform ----------

async def outgoing(acc, ev):
    """Inbox webhook. Chatwoot gives up after 5 s and marks the message failed, so the platform send runs in the background."""
    if ev.get("event") != "message_created" or ev.get("message_type") != "outgoing" or ev.get("private"):
        return
    conv = ev.get("conversation") or {}
    cid = conv.get("display_id") or conv.get("id")
    content = (ev.get("content") or "").strip()
    links = [a.get("data_url") for a in ev.get("attachments") or [] if a.get("data_url")]
    if not cid or (not content and not links):
        return
    if _seen("cw", cid, _digest(content)):
        _echo.pop(_key("cw", cid, _digest(content)), None)
        return
    contact_id = ((conv.get("meta") or {}).get("sender") or {}).get("id") or (conv.get("contact_inbox") or {}).get("contact_id")
    p = db.q("SELECT * FROM personal_peers WHERE account_id=:a AND (contact_id=:c OR conv_id=:v) ORDER BY conv_id=:v DESC LIMIT 1",
             one=True, a=acc["id"], c=contact_id or -1, v=cid)
    if not p:
        await chatwoot.send(acc["tenant_id"], cid, "没找到这个会话对应的个人号联系人，消息没有发出去。", private=True)
        return
    text = "\n".join([content] + links).strip()
    asyncio.create_task(_send(acc, p, cid, text))


async def _send(acc, p, cid, text):
    _remember("sent", acc["id"], p["peer"], _digest(text))
    try:
        msgid = await DRIVERS[acc["platform"]].send(account(acc["id"]), p["peer"], text)
        if msgid:
            _remember("msg", acc["id"], msgid)
    except Exception as e:  # noqa: BLE001 - every platform fails differently; the agent sees the reason in the conversation
        log.warning("personal send failed acc=%s: %r", acc["id"], e)
        try:
            await chatwoot.send(acc["tenant_id"], cid, f"上一条没有通过{PLATFORMS[acc['platform']]['label']}发出去：{str(e)[:200]}", private=True)
        except chatwoot.ChatwootError:
            pass


# ---------- Telegram (official user API, MTProto) ----------

class Telegram:
    """Login: API ID/Hash from my.telegram.org + phone → code (and the cloud password if two-step verification is on)."""

    def __init__(self):
        self.clients = {}
        self.pending = {}   # acc id -> {"phone", "hash", "client"} while logging in

    def _client(self, acc_id, api_id, api_hash):
        from telethon import TelegramClient
        kw = {}
        if proxy():
            u = urlparse(proxy())
            kw["proxy"] = {"proxy_type": "http", "addr": u.hostname, "port": u.port or 80}
        return TelegramClient(str(acc_dir(acc_id) / "telegram"), int(api_id), api_hash, device_model="Muxu Desk",
                              system_version="Linux", app_version="1.0", connection_retries=None, retry_delay=5, **kw)

    def login_state(self, acc_id):
        p = self.pending.get(acc_id)
        return {"step": p["step"], "phone": p["phone"]} if p else {}

    async def send_code(self, acc, api_id, api_hash, phone):
        from telethon import errors
        await self.stop(acc)
        client = self._client(acc["id"], api_id, api_hash)
        try:
            await asyncio.wait_for(client.connect(), 30)
        except (OSError, asyncio.TimeoutError) as e:
            raise PersonalError(f"连不上 Telegram：{e!r}"[:200]) from e
        try:
            sent = await client.send_code_request(phone)
        except (errors.ApiIdInvalidError, errors.PhoneNumberInvalidError, errors.FloodWaitError) as e:
            await client.disconnect()
            raise PersonalError({"ApiIdInvalidError": "API ID 或 API Hash 不对", "PhoneNumberInvalidError": "手机号格式不对，要带国家码，如 +8613800000000"}
                                .get(type(e).__name__, f"Telegram 拒绝了：{e}")) from e
        write_json(acc_dir(acc["id"]) / "telegram.json", {"api_id": int(api_id), "api_hash": api_hash})
        self.pending[acc["id"]] = {"phone": phone, "hash": sent.phone_code_hash, "client": client, "step": "code"}

    async def sign_in(self, acc, code="", password=""):
        from telethon import errors
        p = self.pending.get(acc["id"])
        if not p:
            raise PersonalError("先获取验证码")
        client = p["client"]
        try:
            if p["step"] == "password":
                await client.sign_in(password=password)
            else:
                await client.sign_in(p["phone"], code.strip(), phone_code_hash=p["hash"])
        except errors.SessionPasswordNeededError:
            p["step"] = "password"
            return {"need": "password"}
        except (errors.PhoneCodeInvalidError, errors.PhoneCodeExpiredError, errors.PasswordHashInvalidError) as e:
            raise PersonalError({"PhoneCodeInvalidError": "验证码不对", "PhoneCodeExpiredError": "验证码过期了，重新获取",
                                 "PasswordHashInvalidError": "二步验证密码不对"}[type(e).__name__]) from e
        self.pending.pop(acc["id"], None)
        await self._online(acc, client, fresh=True)
        return {"ok": True}

    async def _online(self, acc, client, fresh=False):
        from telethon import events
        me = await client.get_me()
        handle = f"@{me.username}" if me.username else f"+{me.phone}"
        self.clients[acc["id"]] = client
        acc_id = acc["id"]

        @client.on(events.NewMessage(func=lambda e: e.is_private))
        async def on_message(e):
            chat = await e.get_chat()
            if getattr(chat, "bot", False) or getattr(chat, "is_self", False) or getattr(chat, "id", None) == me.id:
                return
            name = " ".join(x for x in (getattr(chat, "first_name", ""), getattr(chat, "last_name", "")) if x) or getattr(chat, "username", "") or ""
            media = ""
            if e.media:
                media = "图片" if e.photo else "语音" if e.voice else "视频" if e.video else "表情" if e.sticker else "文件"
            try:
                await deliver(acc_id, str(chat.id), name, e.raw_text or "", media, from_me=e.out, msgid=f"tg{e.id}:{chat.id}",
                              ts=e.date.timestamp() if e.date else 0)
            except Exception as ex:  # noqa: BLE001
                log.warning("telegram deliver failed acc=%s: %r", acc_id, ex)

        set_status(acc_id, "在线", handle=handle, **({"since": time.time()} if fresh else {}))

    async def start(self, acc):
        creds = read_json(acc_dir(acc["id"]) / "telegram.json")
        if not creds or not (acc_dir(acc["id"]) / "telegram.session").exists():
            return
        client = self._client(acc["id"], creds["api_id"], creds["api_hash"])
        try:
            await asyncio.wait_for(client.connect(), 30)
            if not await client.is_user_authorized():
                await client.disconnect()
                set_status(acc["id"], "需要重新登录", "Telegram 会话失效了（可能在手机上移除了这个设备）")
                return
            await self._online(acc, client)
        except (OSError, asyncio.TimeoutError) as e:
            set_status(acc["id"], "断开", f"连不上 Telegram：{e!r}"[:200])

    async def stop(self, acc, logout=False):
        for client in (self.clients.pop(acc["id"], None), (self.pending.pop(acc["id"], None) or {}).get("client")):
            if not client:
                continue
            try:
                if logout and await client.is_user_authorized():
                    await client.log_out()
                await client.disconnect()
            except Exception:  # noqa: BLE001
                pass

    async def send(self, acc, peer, text):
        client = self.clients.get(acc["id"])
        if not client or not client.is_connected():
            raise PersonalError("Telegram 个人号没有在线")
        m = await client.send_message(int(peer), text)
        return f"tg{m.id}:{peer}"


# ---------- WhatsApp (Baileys, through wa-bridge/) ----------

class WhatsApp:
    """Login: scan the QR code in WhatsApp → 已关联的设备, or enter the 8-character pairing code shown for a phone number."""
    PORT = 8771

    def __init__(self):
        self.http = httpx.AsyncClient(timeout=httpx.Timeout(20), trust_env=False)
        self.proc = None
        self.live = {}      # acc id -> last state from the bridge (qr, code, error)

    @staticmethod
    def token():
        p = root() / "wa-bridge.token"
        if not p.exists():
            p.write_text(secrets.token_urlsafe(32))
            p.chmod(0o600)
        return p.read_text().strip()

    def login_state(self, acc_id):
        s = self.live.get(acc_id) or {}
        return {k: s.get(k) for k in ("state", "qr", "code", "error") if s.get(k)}

    async def _call(self, path, body=None):
        try:
            r = await self.http.request("POST" if body is not None else "GET", f"http://127.0.0.1:{self.PORT}{path}",
                                        json=body, headers={"x-bridge-token": self.token()})
        except httpx.HTTPError as e:
            raise PersonalError(f"WhatsApp 连接服务没在运行：{e!r}"[:200]) from e
        data = r.json() if r.content else {}
        if r.status_code >= 400:
            raise PersonalError(data.get("error") or f"WhatsApp 连接服务返回 {r.status_code}")
        return data

    async def ensure(self):
        """Start wa-bridge/ (Node) if it isn't answering; it lives as long as this server."""
        try:
            await self._call("/health")
            return
        except PersonalError:
            pass
        here = Path(__file__).parent / "wa-bridge"
        if not (here / "node_modules").exists() or not shutil.which("node"):
            raise PersonalError("WhatsApp 个人号要先在 wa-bridge/ 里运行 npm install")
        self.token()
        logs = Path(settings.env("MUXU_LOG", str(Path(__file__).resolve().parent.parent / "logs" / "muxu.log"))).parent
        logs.mkdir(parents=True, exist_ok=True)
        logf = open(logs / "wa-bridge.log", "ab")
        env = {**os.environ, "MUXU_DATA_DIR": str(settings.DATA_DIR), "WA_BRIDGE_PORT": str(self.PORT),
               "PERSONAL_PROXY": proxy(), "MUXU_INTERNAL_URL": "http://127.0.0.1:8770"}
        self.proc = subprocess.Popen(["node", str(here / "index.mjs")], cwd=here, env=env, stdout=logf, stderr=logf, start_new_session=True)
        for _ in range(30):
            await asyncio.sleep(0.5)
            try:
                await self._call("/health")
                return
            except PersonalError:
                continue
        raise PersonalError("WhatsApp 连接服务启动失败，看 wa-bridge.log")

    async def begin(self, acc, phone=""):
        await self.ensure()
        set_status(acc["id"], "待登录", "", handle="", since=0)
        self.live[acc["id"]] = await self._call("/start", {"id": acc["id"], "phone": phone, "fresh": True})
        return self.live[acc["id"]]

    async def status(self, acc):
        try:
            self.live[acc["id"]] = await self._call(f"/status?id={acc['id']}")
        except PersonalError:
            pass
        return self.live.get(acc["id"]) or {}

    async def event(self, ev):
        acc_id = int(ev.get("id") or 0)
        acc = account(acc_id)
        if not acc:
            return
        if ev.get("type") == "state":
            self.live[acc_id] = {**self.live.get(acc_id, {}), "state": ev.get("state"), "error": ev.get("error")}
            state = ev.get("state")
            if state == "open":
                me = ev.get("me") or {}
                handle = "+" + (me.get("id") or "").split("@")[0].split(":")[0]
                fresh = acc["status"] != "在线" and not acc["since"]
                set_status(acc_id, "在线", handle=handle, **({"since": time.time()} if fresh else {}))
            elif state == "logged_out" and acc["status"] in ("在线", "断开"):
                set_status(acc_id, "需要重新登录", ev.get("error") or "")
            elif state == "closed" and acc["status"] == "在线":
                set_status(acc_id, "断开", ev.get("error") or "")
            return
        if ev.get("type") == "message":
            peer = ev.get("jid") or ""
            name = ev.get("name") or (ev.get("pn") or "").split("@")[0]
            await deliver(acc_id, peer, name, ev.get("text") or "", ev.get("media") or "", from_me=bool(ev.get("from_me")),
                          msgid=f"wa{ev.get('msgid')}", ts=float(ev.get("ts") or 0))

    async def start(self, acc):
        if read_json(acc_dir(acc["id"]) / "wa-auth" / "creds.json").get("me"):
            await self.ensure()
            self.live[acc["id"]] = await self._call("/start", {"id": acc["id"]})

    async def stop(self, acc, logout=False):
        self.live.pop(acc["id"], None)
        try:
            await self._call("/stop", {"id": acc["id"], "logout": logout})
        except PersonalError:
            pass

    async def send(self, acc, peer, text):
        r = await self._call("/send", {"id": acc["id"], "jid": peer, "text": text})
        return f"wa{r.get('msgid')}" if r.get("msgid") else ""


# ---------- Instagram (instagrapi, polling) ----------

class Instagram:
    """Login: username + password, then the code Instagram sends by SMS/e-mail or from the authenticator app if it asks.
    instagrapi is blocking, so each account runs in its own thread and hands messages back to the event loop."""

    def __init__(self):
        self.clients = {}
        self.login = {}     # acc id -> {"step": running|code|done|failed, "prompt", "error", "event", "code"}
        self.stops = {}
        self.loop = None

    def login_state(self, acc_id):
        s = self.login.get(acc_id)
        return {k: s[k] for k in ("step", "prompt", "error") if s.get(k)} if s else {}

    def _new(self):
        from instagrapi import Client
        cl = Client()
        cl.delay_range = [1, 3]
        if proxy():
            cl.set_proxy(proxy())
        return cl

    def _wait_code(self, acc_id, prompt):
        s = self.login[acc_id]
        s.update(step="code", prompt=prompt, code="")
        s["event"].clear()
        if not s["event"].wait(600):
            raise PersonalError("10 分钟内没有填验证码")
        s["step"] = "running"
        return s["code"]

    def _login(self, acc_id, username, password):
        from instagrapi import exceptions as E
        s = self.login[acc_id]
        cl = self._new()
        cl.challenge_code_handler = lambda _u, choice=None: self._wait_code(
            acc_id, f"Instagram 把验证码发到了你的{'邮箱' if 'mail' in str(choice).lower() else '手机'}，填进来")
        try:
            try:
                cl.login(username, password)
            except E.TwoFactorRequired:
                code = self._wait_code(acc_id, "这个号开了两步验证，填验证器 App 或短信里的 6 位码")
                cl.login(username, password, verification_code=code)
            cl.dump_settings(acc_dir(acc_id) / "instagram.json")
            (acc_dir(acc_id) / "instagram.json").chmod(0o600)
        except Exception as e:  # noqa: BLE001
            msg = {"BadPassword": "密码不对", "PleaseWaitFewMinutes": "Instagram 让等几分钟再试",
                   "RecaptchaChallengeForm": "Instagram 要求人机验证，先在手机上登录一次再来",
                   "ChallengeUnknownStep": "Instagram 要求的验证这里处理不了，先在手机 App 里确认是本人登录"}.get(type(e).__name__, str(e)[:200])
            s.update(step="failed", error=msg)
            return
        s.update(step="done", prompt="", error="")
        self.clients[acc_id] = cl
        set_status(acc_id, "在线", handle=f"@{username}", since=time.time())
        self._spawn_poll(acc_id)

    def begin(self, acc, username, password):
        self.loop = asyncio.get_running_loop()
        self._halt(acc["id"])
        self.login[acc["id"]] = {"step": "running", "prompt": "", "error": "", "event": threading.Event(), "code": ""}
        threading.Thread(target=self._login, args=(acc["id"], username.strip().lstrip("@"), password), daemon=True).start()

    def submit(self, acc, code):
        s = self.login.get(acc["id"])
        if not s or s.get("step") != "code":
            raise PersonalError("现在不需要验证码")
        s["code"] = code.strip()
        s["event"].set()

    def _spawn_poll(self, acc_id):
        stop = threading.Event()
        self.stops[acc_id] = stop
        threading.Thread(target=self._poll, args=(acc_id, stop), daemon=True).start()

    def _poll(self, acc_id, stop):
        from instagrapi import exceptions as E
        cl = self.clients[acc_id]
        me = str(cl.user_id)
        backoff = 0
        while not stop.wait(random.uniform(*IG_POLL) + backoff):
            try:
                threads = cl.direct_threads(amount=20) + cl.direct_pending_inbox(amount=20)
                backoff = 0
            except (E.LoginRequired, E.ChallengeRequired) as e:
                set_status(acc_id, "需要重新登录", f"Instagram 要求重新登录（{type(e).__name__}）")
                return
            except Exception as e:  # noqa: BLE001 - rate limits and network errors: slow down and retry
                backoff = min(600, (backoff or 30) * 2)
                set_status(acc_id, "断开", f"拉私信失败，{int(backoff)} 秒后再试：{str(e)[:120]}")
                continue
            if (account(acc_id) or {}).get("status") == "断开":
                set_status(acc_id, "在线")
            for t in threads:
                if t.is_group or not t.users:
                    continue
                u = t.users[0]
                for m in sorted(t.messages or [], key=lambda m: m.timestamp):
                    text = m.text or ""
                    media = "" if text else {"media": "图片", "voice_media": "语音", "clip": "视频", "reel_share": "Reels",
                                             "story_share": "快拍", "media_share": "帖子", "animated_media": "表情"}.get(m.item_type, "消息")
                    fut = asyncio.run_coroutine_threadsafe(deliver(
                        acc_id, str(t.id), u.full_name or u.username, text, media, from_me=str(m.user_id) == me,
                        msgid=f"ig{m.id}", ts=m.timestamp.timestamp()), self.loop)
                    try:
                        fut.result(60)
                    except Exception as e:  # noqa: BLE001
                        log.warning("instagram deliver failed acc=%s: %r", acc_id, e)

    def _halt(self, acc_id):
        stop = self.stops.pop(acc_id, None)
        if stop:
            stop.set()
        self.clients.pop(acc_id, None)

    async def start(self, acc):
        path = acc_dir(acc["id"]) / "instagram.json"
        if not path.exists():
            return
        self.loop = asyncio.get_running_loop()

        def resume():
            cl = self._new()
            cl.load_settings(path)
            cl.account_info()
            return cl
        try:
            cl = await asyncio.to_thread(resume)
        except Exception as e:  # noqa: BLE001
            set_status(acc["id"], "需要重新登录", f"Instagram 会话失效了：{str(e)[:150]}")
            return
        self.clients[acc["id"]] = cl
        set_status(acc["id"], "在线")
        self._spawn_poll(acc["id"])

    async def stop(self, acc, logout=False):
        cl = self.clients.get(acc["id"])
        self._halt(acc["id"])
        s = self.login.pop(acc["id"], None)
        if s:
            s["event"].set()
        if logout and cl:
            try:
                await asyncio.to_thread(cl.logout)
            except Exception:  # noqa: BLE001
                pass

    async def send(self, acc, peer, text):
        cl = self.clients.get(acc["id"])
        if not cl:
            raise PersonalError("Instagram 个人号没有在线")
        m = await asyncio.to_thread(cl.direct_send, text, [], [int(peer)])
        return f"ig{m.id}" if getattr(m, "id", None) else ""


# ---------- 企业微信 · 微信客服 (official API) ----------

WECOM_API = "https://qyapi.weixin.qq.com/cgi-bin/"
WECOM_WINDOW = 48 * 3600
WECOM_MAX_SENT = 5


def wecom_crypt(aes_key):
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    key = __import__("base64").b64decode(aes_key + "=")
    return Cipher(algorithms.AES(key), modes.CBC(key[:16]))


def wecom_signature(token, timestamp, nonce, encrypted):
    return hashlib.sha1("".join(sorted([token, timestamp, nonce, encrypted])).encode()).hexdigest()


def wecom_decrypt(aes_key, encrypted, corpid):
    """企业微信回调加密：AES-256-CBC，明文 = 16 字节随机串 + 4 字节长度 + 消息 + corpid。"""
    import base64
    import struct
    d = wecom_crypt(aes_key).decryptor()
    raw = d.update(base64.b64decode(encrypted)) + d.finalize()
    raw = raw[:-raw[-1]]
    n = struct.unpack(">I", raw[16:20])[0]
    msg, rid = raw[20:20 + n], raw[20 + n:].decode()
    if rid != corpid:
        raise PersonalError("回调消息不是这个企业的")
    return msg.decode()


def wecom_text(m):
    t = m.get("msgtype")
    body = m.get(t) or {}
    if t == "text":
        return body.get("content", ""), ""
    simple = {"image": "图片", "voice": "语音", "video": "视频", "file": "文件", "business_card": "名片"}
    if t in simple:
        return "", simple[t]
    if t == "location":
        return f"[位置] {body.get('name', '')} {body.get('address', '')}".strip(), ""
    if t == "link":
        return f"[链接] {body.get('title', '')} {body.get('url', '')}".strip(), ""
    if t == "miniprogram":
        return f"[小程序] {body.get('title', '')}".strip(), ""
    if t == "merged_msg":
        return f"[聊天记录] {body.get('title', '')}".strip(), ""
    if t == "channels_shop_product":
        return f"[视频号商品] {body.get('product_title') or body.get('title', '')}".strip(), ""
    return "", t or "消息"


class WeCom:
    """Login: 企业 ID + 自建应用 Secret → pick the 微信客服 account; optionally the callback Token / EncodingAESKey.
    Without a public callback URL the account is polled (sync_msg without a token is rate limited, so not too often)."""
    POLL = 15           # seconds, polling mode
    POLL_CALLBACK = 120  # seconds, safety net when callbacks arrive

    def __init__(self):
        self.http = None
        self.tokens = {}    # acc id -> (access_token, expires)
        self.pending = {}   # acc id -> {"corpid", "secret", "accounts"} between the two login steps
        self.tasks = {}
        self.locks = {}

    def client(self):
        if self.http is None:
            self.http = httpx.AsyncClient(timeout=httpx.Timeout(15), proxy=proxy() or None, trust_env=False)
        return self.http

    @staticmethod
    def cfg(acc_id):
        return read_json(acc_dir(acc_id) / "wecom.json")

    @staticmethod
    def callback_url(acc):
        return f"{settings.CALLBACK_BASE_URL}/muxu/api/wecom/callback/{acc['hook_token']}" if settings.CALLBACK_BASE_URL else ""

    def login_state(self, acc_id):
        acc = account(acc_id)
        cfg = self.cfg(acc_id)
        p = self.pending.get(acc_id)
        out = {"callback_url": self.callback_url(acc) if acc else "", "mode": "回调" if cfg.get("cb_token") else "定时拉取" if cfg else ""}
        if p:
            out.update(step="kf", accounts=p["accounts"])
        return out

    async def _token(self, acc_id, corpid, secret, fresh=False):
        hit = self.tokens.get(acc_id)
        if hit and hit[1] > time.time() and not fresh:
            return hit[0]
        r = await self.client().get(WECOM_API + "gettoken", params={"corpid": corpid, "corpsecret": secret})
        data = r.json()
        if data.get("errcode"):
            raise PersonalError(self._explain(data))
        self.tokens[acc_id] = (data["access_token"], time.time() + int(data.get("expires_in", 7200)) - 300)
        return data["access_token"]

    @staticmethod
    def _explain(data):
        code, msg = data.get("errcode"), str(data.get("errmsg") or "")
        ip = msg.split("from ip:")[-1].split(",")[0].strip() if "from ip:" in msg else ""
        known = {
            40013: "企业 ID 不对", 40001: "Secret 不对", 40091: "Secret 不对",
            60020: f"企业微信不允许这台服务器调接口：在自建应用的「企业可信 IP」里加上 {ip or '服务器的出口 IP'}",
            48002: "这个自建应用没有微信客服权限：在「微信客服 → API → 可调用接口的应用」里选上它",
            95000: "这个客服账号还没交给 API 管理：在「微信客服 → 通过 API 管理微信客服账号」里选上它",
            95018: "客户已经超过 48 小时没发消息，或者这 48 小时里已经回满 5 条，要等客户再发消息",
            45009: "调接口太频繁了，稍后再试",
        }
        return known.get(code, f"企业微信返回 {code}：{msg[:120]}")

    async def _api(self, acc, path, body=None, creds=None):
        cfg = creds or self.cfg(acc["id"])
        for fresh in (False, True):
            tok = await self._token(acc["id"], cfg["corpid"], cfg["secret"], fresh)
            url = WECOM_API + path
            try:
                r = await (self.client().post(url, params={"access_token": tok}, json=body) if body is not None
                           else self.client().get(url, params={"access_token": tok}))
            except httpx.HTTPError as e:
                raise PersonalError(f"连不上企业微信：{e!r}"[:200]) from e
            data = r.json()
            if data.get("errcode") in (40014, 42001) and not fresh:
                continue
            if data.get("errcode"):
                err = PersonalError(self._explain(data))
                err.code = data.get("errcode")
                raise err
            return data
        return {}

    async def check(self, acc, corpid, secret):
        creds = {"corpid": corpid, "secret": secret}
        self.tokens.pop(acc["id"], None)
        data = await self._api(acc, "kf/account/list", {"offset": 0, "limit": 100}, creds=creds)
        accounts = [{"open_kfid": a["open_kfid"], "name": a.get("name", "")} for a in data.get("account_list", [])]
        if not accounts:
            raise PersonalError("这个企业还没有微信客服账号：先在企业微信后台「微信客服」里建一个，再交给 API 管理")
        self.pending[acc["id"]] = {**creds, "accounts": accounts}
        return accounts

    async def finish(self, acc, kf_id, cb_token="", cb_aes=""):
        p = self.pending.get(acc["id"])
        if not p:
            raise PersonalError("先填企业 ID 和 Secret")
        kf = next((a for a in p["accounts"] if a["open_kfid"] == kf_id), None)
        if not kf:
            raise PersonalError("选一个客服账号")
        if bool(cb_token) != bool(cb_aes) or (cb_aes and len(cb_aes) != 43):
            raise PersonalError("回调的 Token 和 EncodingAESKey 要一起填，EncodingAESKey 是 43 位")
        await self.stop(acc)
        old = self.cfg(acc["id"])
        same = old.get("open_kfid") == kf_id and old.get("corpid") == p["corpid"]
        write_json(acc_dir(acc["id"]) / "wecom.json", {"corpid": p["corpid"], "secret": p["secret"], "open_kfid": kf_id,
                                                       "kf_name": kf["name"], "cb_token": cb_token, "cb_aes": cb_aes,
                                                       "cursor": old.get("cursor", "") if same else ""})
        self.pending.pop(acc["id"], None)
        set_status(acc["id"], "在线", handle=kf["name"] or kf_id, **({} if same else {"since": time.time()}))
        self._spawn(account(acc["id"]))
        return {"ok": True}

    def callback_check(self, acc, signature, timestamp, nonce, encrypted):
        cfg = self.cfg(acc["id"])
        if not cfg.get("cb_token"):
            raise PersonalError("没有配置回调")
        if not secrets.compare_digest(wecom_signature(cfg["cb_token"], timestamp, nonce, encrypted), signature or ""):
            raise PersonalError("签名不对")
        return wecom_decrypt(cfg["cb_aes"], encrypted, cfg["corpid"])

    def notify(self, acc, xml_text):
        """A decrypted callback: kf_msg_or_event carries a token that lifts sync_msg's rate limit for 10 minutes."""
        import xml.etree.ElementTree as ET
        root_el = ET.fromstring(xml_text)
        if (root_el.findtext("Event") or "") != "kf_msg_or_event":
            return
        asyncio.create_task(self._sync_now(acc["id"], root_el.findtext("Token") or ""))

    async def _sync_now(self, acc_id, token):
        try:
            await self.sync(account(acc_id), token)
        except Exception as e:  # noqa: BLE001
            set_status(acc_id, "断开", str(e) if isinstance(e, PersonalError) else f"拉消息失败：{str(e)[:150]}")

    async def sync(self, acc, token=""):
        if not acc:
            return
        lock = self.locks.setdefault(acc["id"], asyncio.Lock())
        async with lock:
            cfg = self.cfg(acc["id"])
            if not cfg:
                return
            cursor = cfg.get("cursor", "")
            for _ in range(20):
                body = {"cursor": cursor, "limit": 1000, "open_kfid": cfg["open_kfid"]}
                if token:
                    body["token"] = token
                data = await self._api(acc, "kf/sync_msg", body)
                for m in data.get("msg_list", []):
                    try:
                        await self._handle(acc, cfg, m)
                    except Exception as e:  # noqa: BLE001
                        log.warning("wecom message failed acc=%s: %r", acc["id"], e)
                cursor = data.get("next_cursor") or cursor
                cfg = {**self.cfg(acc["id"]), "cursor": cursor}
                write_json(acc_dir(acc["id"]) / "wecom.json", cfg)
                if not data.get("has_more"):
                    break

    async def _handle(self, acc, cfg, m):
        if m.get("msgtype") == "event":
            ev = m.get("event") or {}
            if ev.get("event_type") == "msg_send_fail":
                log.warning("wecom send failed acc=%s user=%s msgid=%s type=%s", acc["id"], ev.get("external_userid"), ev.get("fail_msgid"), ev.get("fail_type"))
            return
        if m.get("origin") not in (3, 5) or m.get("open_kfid") != cfg["open_kfid"]:
            return
        peer = m.get("external_userid") or ""
        row = db.q("SELECT name FROM personal_peers WHERE account_id=:a AND peer=:p", one=True, a=acc["id"], p=peer)
        name = row["name"] if row and row["name"] else await self._nickname(acc, peer)
        text, media = wecom_text(m)
        await deliver(acc["id"], peer, name, text, media, from_me=m.get("origin") == 5, msgid=f"wk{m.get('msgid')}",
                      ts=float(m.get("send_time") or 0))

    async def _nickname(self, acc, peer):
        try:
            data = await self._api(acc, "kf/customer/batchget", {"external_userid_list": [peer], "need_enter_session_context": 0})
            return ((data.get("customer_list") or [{}])[0]).get("nickname", "")
        except PersonalError:
            return ""

    def _spawn(self, acc):
        old = self.tasks.pop(acc["id"], None)
        if old:
            old.cancel()
        self.tasks[acc["id"]] = asyncio.create_task(self._loop(acc["id"]))

    async def _loop(self, acc_id):
        backoff = 0
        while True:
            acc = account(acc_id)
            if not acc or not self.cfg(acc_id):
                return
            try:
                await self.sync(acc)
                backoff = 0
                if acc["status"] != "在线":
                    set_status(acc_id, "在线")
            except Exception as e:  # noqa: BLE001 - wrong setup and rate limits alike: report it and slow down
                backoff = min(600, (backoff or 15) * 2)
                set_status(acc_id, "断开", str(e) if isinstance(e, PersonalError) else f"拉消息失败：{str(e)[:150]}")
            await asyncio.sleep((self.POLL_CALLBACK if self.cfg(acc_id).get("cb_token") else self.POLL) + backoff)

    async def start(self, acc):
        if self.cfg(acc["id"]):
            self._spawn(acc)

    async def stop(self, acc, logout=False):
        t = self.tasks.pop(acc["id"], None)
        if t:
            t.cancel()
        self.tokens.pop(acc["id"], None)
        self.pending.pop(acc["id"], None)

    async def send(self, acc, peer, text):
        p = db.q("SELECT * FROM personal_peers WHERE account_id=:a AND peer=:p", one=True, a=acc["id"], p=peer)
        if not p or time.time() - p["last_in"] > WECOM_WINDOW:
            raise PersonalError("客户超过 48 小时没发消息，企业微信不让再发，要等客户先发")
        if p["sent"] >= WECOM_MAX_SENT:
            raise PersonalError("客户每发一条消息，企业微信只让回 5 条，这次已经回满了，等客户再发")
        cfg = self.cfg(acc["id"])
        data = await self._api(acc, "kf/send_msg", {"touser": peer, "open_kfid": cfg["open_kfid"], "msgtype": "text", "text": {"content": text}})
        db.x("UPDATE personal_peers SET sent=sent+1 WHERE id=:i", i=p["id"])
        return f"wk{data.get('msgid')}" if data.get("msgid") else ""


# ---------- Messenger (ws3-fca, one Node process per account in fb-bridge/) ----------

def fb_cookies(text):
    """Cookies pasted from the browser: a Cookie-Editor style JSON export, or the Cookie header 'c_user=...; xs=...'."""
    text = (text or "").strip()
    try:
        data = json.loads(text)
        items = data.get("cookies", []) if isinstance(data, dict) else data
        jar = {(c.get("name") or c.get("key")): c.get("value") for c in items if isinstance(c, dict)}
    except ValueError:
        jar = dict(part.strip().split("=", 1) for part in text.split(";") if "=" in part)
    jar = {k.strip(): str(v).strip() for k, v in jar.items() if k and v}
    if not (jar.get("c_user") and jar.get("xs")):
        raise PersonalError("cookie 里要有 c_user 和 xs，先在浏览器里登录 facebook.com 再导出")
    return [{"key": k, "value": v, "domain": "facebook.com", "path": "/"} for k, v in jar.items()]


class Messenger:
    """Login: e-mail + password typed into facebook.com by the local browser (with the code or the approval on another device
    if Facebook asks), or cookies pasted from a browser where the account is logged in. The cookies then drive ws3-fca."""
    LOGIN_WAIT = 600
    RETRY = (30, 600)

    def __init__(self):
        self.procs = {}     # acc id -> {"proc", "pending", "rid", "stopping", "retries"}
        self.login = {}     # acc id -> {"step": running|code|done|failed, "prompt", "error", "shot", "code"}
        self.tasks = {}

    @staticmethod
    def state_file(acc_id):
        return acc_dir(acc_id) / "messenger.json"

    def login_state(self, acc_id):
        s = self.login.get(acc_id)
        return {k: s[k] for k in ("step", "prompt", "error", "shot") if s.get(k)} if s else {}

    # -- login through the browser --

    def begin(self, acc, email, password):
        self._cancel(acc["id"])
        self.login[acc["id"]] = {"step": "running", "prompt": "", "error": "", "shot": "", "code": asyncio.Queue()}
        self.tasks[acc["id"]] = asyncio.create_task(self._browser_login(acc["id"], email.strip(), password))

    def submit(self, acc, code):
        s = self.login.get(acc["id"])
        if not s or s["step"] != "code":
            raise PersonalError("现在不需要验证码")
        s["code"].put_nowait(code.strip())
        s.update(step="running", prompt="")

    def _cancel(self, acc_id):
        t = self.tasks.pop(acc_id, None)
        if t:
            t.cancel()

    async def _browser_login(self, acc_id, email, password):
        import browser
        s = self.login[acc_id]
        profile = acc_dir(acc_id) / "fb-browser"
        shutil.rmtree(profile, ignore_errors=True)
        ctx = None
        try:
            ctx = await browser.open_profile(profile)
            page = await browser.page_of(ctx)
            await page.goto("https://www.facebook.com/login", wait_until="domcontentloaded")
            for label in ("Allow all cookies", "Only allow essential cookies", "Decline optional cookies"):
                btn = page.get_by_role("button", name=label)
                if await btn.count():
                    await btn.first.click()
                    break
            await page.fill("input[name=email]", email)
            await page.fill("input[name=pass]", password)
            submit = page.locator("button[name=login], [type=submit]").or_(page.get_by_role("button", name="Log in"))
            if await submit.count():
                await submit.first.click()
            else:
                await page.press("input[name=pass]", "Enter")
            deadline = time.time() + self.LOGIN_WAIT
            stuck = 0
            while time.time() < deadline:
                await asyncio.sleep(3)
                jar = {c["name"]: c["value"] for c in await ctx.cookies("https://www.facebook.com")}
                if jar.get("c_user") and jar.get("xs") and "checkpoint" not in page.url:
                    write_json(self.state_file(acc_id), [{"key": k, "value": v, "domain": "facebook.com", "path": "/"} for k, v in jar.items()])
                    s.update(step="done", prompt="", error="", shot="")
                    break
                s["shot"] = await browser.shot(page, photo=True)
                url = page.url
                if any(k in url for k in ("checkpoint", "two_step", "two_factor", "approvals", "auth_platform")):
                    stuck = 0
                    if s["step"] != "code":
                        s.update(step="code", prompt="Facebook 要验证是本人：在手机上点「是我本人」，或把收到的验证码填进来（看下面的截图）")
                    try:
                        code = s["code"].get_nowait()
                    except asyncio.QueueEmpty:
                        continue
                    box = page.locator("input[autocomplete='one-time-code'], input[name=approvals_code], input[type=text], input[type=tel], input[type=number]")
                    if await box.count():
                        await box.first.fill(code)
                        await box.first.press("Enter")
                    continue
                if "/login" in url:
                    stuck += 1
                    if stuck >= 5:
                        s.update(step="failed", error="Facebook 没让登录：多半是邮箱或密码不对，或者要人机验证，看截图")
                        return
            else:
                s.update(step="failed", error="10 分钟内没有完成验证")
                return
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001 - the browser can fail in many ways; the user sees the reason
            s.update(step="failed", error=f"浏览器登录失败：{str(e)[:200]}")
            return
        finally:
            if ctx:
                await ctx.close()
            shutil.rmtree(profile, ignore_errors=True)
        await self._spawn(acc_id, fresh=True)

    async def cookies(self, acc, text):
        self._cancel(acc["id"])
        write_json(self.state_file(acc["id"]), fb_cookies(text))
        self.login[acc["id"]] = {"step": "running", "prompt": "", "error": "", "shot": "", "code": asyncio.Queue()}
        await self._spawn(acc["id"], fresh=True)

    # -- the Node worker --

    async def _spawn(self, acc_id, fresh=False):
        await self._kill(acc_id)
        here = Path(__file__).parent / "fb-bridge"
        if not (here / "node_modules").exists() or not shutil.which("node"):
            self._fail(acc_id, "Messenger 个人号要先在 fb-bridge/ 里运行 npm install --ignore-scripts")
            return
        import browser
        logs = Path(settings.env("MUXU_LOG", str(Path(__file__).resolve().parent.parent / "logs" / "muxu.log"))).parent
        logs.mkdir(parents=True, exist_ok=True)
        logf = open(logs / "fb-bridge.log", "ab")
        env = {**os.environ, "PERSONAL_PROXY": proxy(), "FB_USER_AGENT": browser.USER_AGENT}
        proc = await asyncio.create_subprocess_exec("node", str(here / "worker.js"), str(acc_dir(acc_id)), cwd=here, env=env,
                                                    stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=logf)
        logf.close()
        w = {"proc": proc, "pending": {}, "rid": 0, "stopping": False, "fresh": fresh,
             "retries": (self.procs.get(acc_id) or {}).get("retries", 0)}
        self.procs[acc_id] = w
        asyncio.create_task(self._read(acc_id, w))

    def _fail(self, acc_id, error):
        s = self.login.get(acc_id)
        if s and s["step"] != "done":
            s.update(step="failed", error=error)

    async def _read(self, acc_id, w):
        proc = w["proc"]
        while True:
            line = await proc.stdout.readline()
            if not line:
                break
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            try:
                await self._event(acc_id, w, ev)
            except Exception as e:  # noqa: BLE001
                log.warning("messenger event failed acc=%s: %r", acc_id, e)
        code = await proc.wait()
        for fut in w["pending"].values():
            if not fut.done():
                fut.set_exception(PersonalError("Messenger 连接断了"))
        if w["stopping"] or self.procs.get(acc_id) is not w:
            return
        self.procs.pop(acc_id, None)
        if code == 3:
            return
        w["retries"] += 1
        wait = min(self.RETRY[1], self.RETRY[0] * 2 ** (w["retries"] - 1))
        set_status(acc_id, "断开", f"Messenger 连接断开，{wait} 秒后重连")
        await asyncio.sleep(wait)
        acc = account(acc_id)
        if acc and acc_id not in self.procs and self.state_file(acc_id).exists():
            await self._spawn(acc_id)
            self.procs[acc_id]["retries"] = w["retries"]

    async def _event(self, acc_id, w, ev):
        acc = account(acc_id)
        if not acc:
            return
        if ev.get("type") == "reply":
            fut = w["pending"].pop(ev.get("rid"), None)
            if fut and not fut.done():
                if ev.get("error"):
                    fut.set_exception(PersonalError(f"Messenger 没发出去：{ev['error']}"))
                else:
                    fut.set_result(ev.get("msgid") or "")
            return
        if ev.get("type") == "state":
            state = ev.get("state")
            if state == "open":
                w["retries"] = 0
                me = ev.get("me") or {}
                fresh = w["fresh"] and not acc["since"]
                set_status(acc_id, "在线", "", handle=me.get("name") or f"fb:{me.get('id')}", **({"since": time.time()} if fresh else {}))
                if acc_id in self.login:
                    self.login[acc_id].update(step="done", error="", shot="")
            elif state == "logged_out":
                self._fail(acc_id, ev.get("error") or "Facebook 不认这个登录")
                if acc["status"] != "待登录" or acc["since"]:
                    set_status(acc_id, "需要重新登录", ev.get("error") or "")
                else:
                    self.state_file(acc_id).unlink(missing_ok=True)
            elif state == "closed":
                self._fail(acc_id, ev.get("error") or "连不上 Facebook")
            return
        if ev.get("type") == "message":
            await deliver(acc_id, ev.get("peer") or "", ev.get("name") or "", ev.get("text") or "", ev.get("media") or "",
                          from_me=bool(ev.get("from_me")), msgid=f"fb{ev.get('msgid')}" if ev.get("msgid") else "", ts=float(ev.get("ts") or 0))

    async def _kill(self, acc_id):
        w = self.procs.pop(acc_id, None)
        if not w or w["proc"].returncode is not None:
            return
        w["stopping"] = True
        try:
            w["proc"].stdin.write(b'{"op":"quit"}\n')
            await w["proc"].stdin.drain()
            await asyncio.wait_for(w["proc"].wait(), 5)
        except (OSError, asyncio.TimeoutError):
            w["proc"].kill()

    async def start(self, acc):
        if self.state_file(acc["id"]).exists():
            await self._spawn(acc["id"])

    async def stop(self, acc, logout=False):
        self._cancel(acc["id"])
        self.login.pop(acc["id"], None)
        await self._kill(acc["id"])

    async def send(self, acc, peer, text):
        w = self.procs.get(acc["id"])
        if not w or w["proc"].returncode is not None:
            raise PersonalError("Messenger 个人号没有在线")
        w["rid"] += 1
        fut = asyncio.get_running_loop().create_future()
        w["pending"][w["rid"]] = fut
        w["proc"].stdin.write((json.dumps({"op": "send", "rid": w["rid"], "peer": peer, "text": text}) + "\n").encode())
        await w["proc"].stdin.drain()
        try:
            return await asyncio.wait_for(fut, 40)
        except asyncio.TimeoutError as e:
            raise PersonalError("Messenger 40 秒没回发送结果") from e
        finally:
            w["pending"].pop(w["rid"], None)


# ---------- TikTok (the web inbox in the local browser) ----------
# No API and no community library for TikTok DMs: the account's www.tiktok.com/messages runs in a headless browser
# (which also computes TikTok's request signatures), new messages are read off the page and replies are typed in.
# The selectors follow the current web page; if TikTok redesigns it, they are all here.

TT = {
    "qr": "canvas",
    "list_item": "[data-e2e='chat-list-item']",
    "uniqueid": "[data-e2e='chat-uniqueid']",
    "nickname": "[data-e2e='chat-nickname']",
    "chat_item": "[data-e2e='chat-item']",
    "input": "[data-e2e='message-input-area'] [contenteditable='true'], div[contenteditable='true']",
    "message_button": "[data-e2e='message-button'], button:has-text('Message')",
}
TT_POLL = (20, 35)
TT_SEEN = 60            # messages remembered per conversation to tell new ones from old
TT_READ = """(sel) => {
  const items = [...document.querySelectorAll(sel)];
  const pane = (items[0] && items[0].parentElement || document.body).getBoundingClientRect();
  return items.map((el) => {
    const a = el.querySelector('a[href*="/@"]');
    const author = a ? (a.getAttribute('href').split('/@')[1] || '').split(/[/?#]/)[0] : '';
    const ps = [...el.querySelectorAll('p')].map((p) => p.innerText.trim()).filter(Boolean);
    const text = (ps.length ? ps.join('\\n') : el.innerText || '').trim();
    const bubble = (el.querySelector('p') || el).getBoundingClientRect();
    const right = (bubble.left + bubble.right) / 2 > (pane.left + pane.right) / 2;
    const media = text ? '' : el.querySelector('video') ? '视频' : el.querySelector('img') ? '图片' : '';
    return { author, right, text, media };
  });
}"""


def _tt_key(text):
    """A chat list entry without its relative time ("3m", "12:04", "Yesterday"), so the time ticking doesn't look like news."""
    lines = [l for l in (text or "").splitlines() if l.strip()]
    return "\n".join(l for l in lines if not re.fullmatch(r"\s*(\d+[smhdw]|\d{1,2}:\d{2}|yesterday|today|\d{1,2}[-/]\d{1,2}(?:[-/]\d{2,4})?)\s*", l, re.I))


class TikTok:
    """Login: scan the QR code with the TikTok app (Profile → ☰ → the scan icon). The account then stays logged in inside
    data/personal/{id}/tiktok-browser/."""
    LOGIN_WAIT = 300

    def __init__(self):
        self.ctx = {}
        self.page = {}
        self.locks = {}
        self.tasks = {}
        self.login = {}     # acc id -> {"state": qr|open|expired|failed, "qr", "error"}

    @staticmethod
    def profile(acc_id):
        return acc_dir(acc_id) / "tiktok-browser"

    @staticmethod
    def memory(acc_id):
        return acc_dir(acc_id) / "tiktok.json"

    def login_state(self, acc_id):
        s = self.login.get(acc_id) or {}
        return {k: s[k] for k in ("state", "qr", "error") if s.get(k)}

    async def _open(self, acc_id):
        import browser
        await self._close(acc_id)
        ctx = await browser.open_profile(self.profile(acc_id))
        self.ctx[acc_id] = ctx
        self.page[acc_id] = await browser.page_of(ctx)
        self.locks.setdefault(acc_id, asyncio.Lock())
        return self.page[acc_id]

    async def _close(self, acc_id):
        t = self.tasks.pop(acc_id, None)
        if t and t is not asyncio.current_task():
            t.cancel()
        self.page.pop(acc_id, None)
        ctx = self.ctx.pop(acc_id, None)
        if ctx:
            try:
                await ctx.close()
            except Exception:  # noqa: BLE001
                pass

    async def _logged_in(self, acc_id):
        ctx = self.ctx.get(acc_id)
        return bool(ctx and any(c["name"] == "sessionid" and c["value"] for c in await ctx.cookies("https://www.tiktok.com")))

    async def begin(self, acc):
        acc_id = acc["id"]
        await self._close(acc_id)
        shutil.rmtree(self.profile(acc_id), ignore_errors=True)
        self.memory(acc_id).unlink(missing_ok=True)
        set_status(acc_id, "待登录", "", handle="", since=0)
        self.login[acc_id] = {"state": "connecting"}
        page = await self._open(acc_id)
        self.tasks[acc_id] = asyncio.create_task(self._scan_qr(acc_id, page))
        return self.login[acc_id]

    async def _scan_qr(self, acc_id, page):
        import browser
        s = self.login[acc_id]
        try:
            await page.goto("https://www.tiktok.com/login/qrcode", wait_until="domcontentloaded")
            deadline = time.time() + self.LOGIN_WAIT
            while time.time() < deadline:
                if await self._logged_in(acc_id):
                    break
                qr = page.locator(TT["qr"]).first
                if await qr.count() and await qr.is_visible():
                    s.update(state="qr", qr=await browser.shot(qr), error="")
                refresh = page.get_by_text("Refresh", exact=False)
                if await refresh.count() and await refresh.first.is_visible():
                    await refresh.first.click()
                await asyncio.sleep(2)
            else:
                s.update(state="expired", qr="", error="5 分钟内没扫码，点「重新生成」再扫")
                await self._close(acc_id)
                return
            s.update(state="open", qr="", error="")
            me = await self._me(page)
            set_status(acc_id, "在线", "", handle=f"@{me}" if me else "", since=time.time())
            await self._inbox(acc_id, page)
            await self._baseline(acc_id, page)
            self.tasks[acc_id] = asyncio.create_task(self._loop(acc_id))
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            s.update(state="failed", qr="", error=f"TikTok 登录页出错：{str(e)[:200]}")
            await self._close(acc_id)

    async def _me(self, page):
        try:
            data = await page.evaluate("""async () => {
              const r = await fetch('/passport/web/account/info/?aid=1459', { credentials: 'include' });
              return r.ok ? r.json() : {};
            }""")
            return ((data or {}).get("data") or {}).get("username") or ""
        except Exception:  # noqa: BLE001
            return ""

    async def _inbox(self, acc_id, page):
        if "/messages" not in page.url:
            await page.goto("https://www.tiktok.com/messages?lang=en", wait_until="domcontentloaded")
        try:
            await page.wait_for_selector(TT["list_item"], timeout=20000)
        except Exception:  # noqa: BLE001 - an empty inbox has no list
            pass
        if "/login" in page.url or not await self._logged_in(acc_id):
            raise PersonalError("TikTok 退出了登录，要重新扫码")

    async def _open_chat(self, page, i):
        await page.locator(TT["list_item"]).nth(i).click()
        await page.wait_for_timeout(1500)
        header = page.locator(TT["uniqueid"]).first
        handle = (await header.inner_text()).strip().lstrip("@") if await header.count() else ""
        nick = page.locator(TT["nickname"]).first
        name = (await nick.inner_text()).strip() if await nick.count() else ""
        return handle, name, await page.evaluate(TT_READ, TT["chat_item"])

    @staticmethod
    def _sig(m):
        return _digest(f"{m['author']}|{m['right']}|{m['text']}|{m['media']}")

    async def _baseline(self, acc_id, page):
        """Right after login: remember what is already in the inbox, so only messages that arrive later go to the AI."""
        mem = {"list": {}, "seen": {}}
        keys = [_tt_key(t) for t in await page.locator(TT["list_item"]).all_inner_texts()]
        for i, key in enumerate(keys[:20]):
            try:
                handle, _name, msgs = await self._open_chat(page, i)
            except Exception:  # noqa: BLE001
                continue
            mem["list"][key] = handle
            if handle:
                mem["seen"][handle] = [self._sig(m) for m in msgs][-TT_SEEN:]
        write_json(self.memory(acc_id), mem)

    async def _loop(self, acc_id):
        backoff = 0
        while True:
            await asyncio.sleep(random.uniform(*TT_POLL) + backoff)
            acc, page = account(acc_id), self.page.get(acc_id)
            if not acc or not page:
                return
            try:
                async with self.locks[acc_id]:
                    await self._poll(acc, page)
                backoff = 0
                if acc["status"] != "在线":
                    set_status(acc_id, "在线")
            except PersonalError as e:
                set_status(acc_id, "需要重新登录", str(e))
                await self._close(acc_id)
                return
            except Exception as e:  # noqa: BLE001 - page hiccups: slow down and retry
                backoff = min(600, (backoff or 30) * 2)
                set_status(acc_id, "断开", f"读私信失败，{int(backoff)} 秒后再试：{str(e)[:120]}")

    async def _poll(self, acc, page):
        acc_id = acc["id"]
        await self._inbox(acc_id, page)
        mem = read_json(self.memory(acc_id)) or {"list": {}, "seen": {}}
        me = (acc["handle"] or "").lstrip("@").lower()
        keys = [_tt_key(t) for t in await page.locator(TT["list_item"]).all_inner_texts()]
        changed = [i for i, k in enumerate(keys[:30]) if k not in mem["list"]][:5]
        for i in changed:
            handle, name, msgs = await self._open_chat(page, i)
            mem["list"][keys[i]] = handle
            if not handle:
                continue
            seen = mem["seen"].get(handle, [])
            for m in self._new(msgs, seen, me):
                await deliver(acc_id, handle, name, m["text"], m["media"], from_me=self._mine(m, me))
            mem["seen"][handle] = [self._sig(m) for m in msgs][-TT_SEEN:]
        if len(mem["list"]) > 200:
            mem["list"] = {k: v for k, v in mem["list"].items() if k in keys}
        write_json(self.memory(acc_id), mem)

    @staticmethod
    def _mine(m, me):
        return m["author"].lower() == me if m["author"] and me else m["right"]

    def _new(self, msgs, seen, me):
        """The messages after the last one already seen; for a conversation never seen before, what came after our last reply."""
        sigs = [self._sig(m) for m in msgs]
        if seen:
            known = set(seen)
            last = max((i for i, s in enumerate(sigs) if s in known), default=-1)
            if last >= 0:
                return msgs[last + 1:]
        tail = []
        for m in reversed(msgs):
            if self._mine(m, me):
                break
            tail.append(m)
        return list(reversed(tail))[-5:]

    async def start(self, acc):
        acc_id = acc["id"]
        if not self.profile(acc_id).exists():
            return
        page = await self._open(acc_id)
        if not await self._logged_in(acc_id):
            await self._close(acc_id)
            set_status(acc_id, "需要重新登录", "TikTok 登录失效了，要重新扫码")
            return
        try:
            async with self.locks[acc_id]:
                await self._inbox(acc_id, page)
                if not self.memory(acc_id).exists():
                    await self._baseline(acc_id, page)
        except PersonalError as e:
            await self._close(acc_id)
            set_status(acc_id, "需要重新登录", str(e))
            return
        set_status(acc_id, "在线")
        self.tasks[acc_id] = asyncio.create_task(self._loop(acc_id))

    async def stop(self, acc, logout=False):
        self.login.pop(acc["id"], None)
        await self._close(acc["id"])

    async def send(self, acc, peer, text):
        acc_id = acc["id"]
        page = self.page.get(acc_id)
        if not page:
            raise PersonalError("TikTok 个人号没有在线")
        async with self.locks[acc_id]:
            await self._inbox(acc_id, page)
            mem = read_json(self.memory(acc_id)) or {"list": {}, "seen": {}}
            header = page.locator(TT["uniqueid"]).first
            current = (await header.inner_text()).strip().lstrip("@") if await header.count() else ""
            if current != peer:
                keys = [_tt_key(t) for t in await page.locator(TT["list_item"]).all_inner_texts()]
                i = next((i for i, k in enumerate(keys) if mem["list"].get(k) == peer), -1)
                if i >= 0:
                    current, _name, _msgs = await self._open_chat(page, i)
            if current != peer:
                await page.goto(f"https://www.tiktok.com/@{peer}?lang=en", wait_until="domcontentloaded")
                await page.locator(TT["message_button"]).first.click(timeout=20000)
                await page.wait_for_url("**/messages**", timeout=20000)
                await page.wait_for_timeout(2000)
            box = page.locator(TT["input"]).first
            await box.click(timeout=15000)
            for n, line in enumerate(text.split("\n")):
                if n:
                    await page.keyboard.press("Shift+Enter")
                await page.keyboard.type(line, delay=15)
            await page.keyboard.press("Enter")
            await page.wait_for_timeout(1500)
            msgs = await page.evaluate(TT_READ, TT["chat_item"])
            mem["seen"][peer] = [self._sig(m) for m in msgs][-TT_SEEN:]
            write_json(self.memory(acc_id), mem)
        return ""


DRIVERS = {"telegram": Telegram(), "whatsapp": WhatsApp(), "instagram": Instagram(), "wecom": WeCom(),
           "messenger": Messenger(), "tiktok": TikTok()}


async def startup():
    """Reconnect every account that has a saved session."""
    refresh_channels()
    for acc in accounts():
        try:
            await DRIVERS[acc["platform"]].start(acc)
        except Exception as e:  # noqa: BLE001
            set_status(acc["id"], "断开", f"启动时没连上：{str(e)[:200]}")
