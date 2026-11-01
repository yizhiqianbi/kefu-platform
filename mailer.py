"""邮件渠道：用客户自己的企业邮箱 SMTP 发信、IMAP 收回复。密码只存在数据目录里（600），不进数据库、不回给浏览器。"""
import email
import html
import imaplib
import json
import re
import smtplib
import ssl
from concurrent.futures import ThreadPoolExecutor
from email.message import EmailMessage
from email.policy import default as email_policy
from email.utils import formataddr, formatdate, make_msgid, parseaddr

import settings

TIMEOUT = 30
FETCH_MAX = 50
OPT_OUT = re.compile(r"\b(unsubscribe|opt[ -]?out|remove me|stop emailing|not interested|no thanks|no, thanks)\b|退订|不再联系|别再发|不感兴趣", re.I)
QUOTE_START = re.compile(r"^(on .{4,200}wrote:|-{2,} ?original message ?-{2,}|from: .+|发件人[:：].*|在 .{2,80}写道[:：]?|.{2,80} 于 .{2,60}写道[:：]?)$", re.I)


def _dir():
    d = settings.DATA_DIR / "mail"
    d.mkdir(mode=0o700, exist_ok=True)
    return d


def password(tid):
    p = _dir() / f"{tid}.secret"
    return p.read_text().strip() if p.exists() else ""


def set_password(tid, value):
    p = _dir() / f"{tid}.secret"
    if not value:
        p.unlink(missing_ok=True)
        return
    p.write_text(value)
    p.chmod(0o600)


def via_inbox(cfg):
    """Outreach mail goes out through the tenant's Chatwoot email inbox; replies come back through its webhook."""
    return cfg.get("via") == "chatwoot" and bool(cfg.get("inbox_id"))


def ready(cfg, tid):
    if cfg.get("via") == "chatwoot":
        return via_inbox(cfg)
    return bool(cfg.get("address") and cfg.get("smtp_host") and password(tid))


def _state_path(tid):
    return _dir() / f"{tid}.state.json"


def footer(cfg):
    lines = ["--", cfg.get("from_name") or "", cfg.get("postal") or "",
             "If you'd rather not hear from us, just reply \"unsubscribe\" and we won't email you again."]
    return "\n".join(x for x in lines if x)


def send(cfg, tid, to, subject, body, in_reply_to="", references=""):
    """Send a plain-text email; returns its Message-ID."""
    msg = EmailMessage()
    msg["From"] = formataddr((cfg.get("from_name") or "", cfg["address"]))
    msg["To"] = to
    msg["Subject"] = subject
    msg["Date"] = formatdate(localtime=True)
    msg["Message-ID"] = make_msgid(domain=cfg["address"].split("@")[-1])
    if in_reply_to:
        msg["In-Reply-To"] = in_reply_to
        msg["References"] = (references + " " + in_reply_to).strip()
    msg.set_content(body + "\n\n" + footer(cfg))
    server = _smtp(cfg, tid)
    try:
        server.send_message(msg)
    finally:
        try:
            server.quit()
        except smtplib.SMTPException:
            pass
    return msg["Message-ID"]


def _smtp(cfg, tid):
    port = int(cfg.get("smtp_port") or 465)
    ctx = ssl.create_default_context()
    if port == 465:
        server = smtplib.SMTP_SSL(cfg["smtp_host"], port, timeout=TIMEOUT, context=ctx)
    else:
        server = smtplib.SMTP(cfg["smtp_host"], port, timeout=TIMEOUT)
        server.starttls(context=ctx)
    server.login(cfg.get("username") or cfg["address"], password(tid))
    return server


def body_text(msg):
    part = msg.get_body(preferencelist=("plain", "html"))
    if part is None:
        return ""
    text = part.get_content()
    if part.get_content_type() == "text/html":
        text = re.sub(r"(?is)<(script|style).*?</\1>", "", text)
        text = re.sub(r"(?i)<br\s*/?>|</p>|</div>", "\n", text)
        text = html.unescape(re.sub(r"<[^>]+>", "", text))
    return text


def strip_quoted(text):
    out = []
    for line in text.replace("\r\n", "\n").split("\n"):
        s = line.strip()
        if s.startswith(">") or QUOTE_START.match(s):
            break
        out.append(line.rstrip())
    return "\n".join(out).strip()


def _connect(cfg, tid):
    conn = imaplib.IMAP4_SSL(cfg["imap_host"], int(cfg.get("imap_port") or 993), timeout=TIMEOUT)
    conn.login(cfg.get("username") or cfg["address"], password(tid))
    try:
        # 网易等邮箱要求客户端先报 ID，不报会拒绝 SELECT
        imaplib.Commands.setdefault("ID", ("AUTH", "SELECTED"))
        conn._simple_command("ID", '("name" "kefu-platform" "version" "1.0")')
    except imaplib.IMAP4.error:
        pass
    return conn


def fetch(cfg, tid):
    """New messages in INBOX since the last call. The first call only records where the inbox is now."""
    path = _state_path(tid)
    state = json.loads(path.read_text()) if path.exists() else {}
    conn = _connect(cfg, tid)
    try:
        typ, data = conn.select("INBOX", readonly=True)
        if typ != "OK":
            raise imaplib.IMAP4.error(f"打不开收件箱：{data}")
        typ, data = conn.status("INBOX", "(UIDVALIDITY UIDNEXT)")
        info = dict(re.findall(r"(UIDVALIDITY|UIDNEXT) (\d+)", data[0].decode()))
        validity, uidnext = info.get("UIDVALIDITY", ""), int(info.get("UIDNEXT", "1"))
        if state.get("uidvalidity") != validity:
            path.write_text(json.dumps({"uidvalidity": validity, "last_uid": uidnext - 1}))
            return []
        last = int(state.get("last_uid", 0))
        typ, data = conn.uid("search", None, f"UID {last + 1}:*")
        uids = sorted(int(u) for u in (data[0] or b"").split() if int(u) > last)[:FETCH_MAX]
        out = []
        for uid in uids:
            typ, parts = conn.uid("fetch", str(uid), "(BODY.PEEK[])")
            raw = next((p[1] for p in parts if isinstance(p, tuple)), None)
            if raw:
                msg = email.message_from_bytes(raw, policy=email_policy)
                out.append({"uid": uid, "from": parseaddr(str(msg.get("From", "")))[1].lower(),
                            "subject": str(msg.get("Subject", "")), "message_id": str(msg.get("Message-ID", "")).strip(),
                            "in_reply_to": str(msg.get("In-Reply-To", "")).strip(), "text": strip_quoted(body_text(msg))[:4000]})
            last = uid
        path.write_text(json.dumps({"uidvalidity": validity, "last_uid": last}))
        return out
    finally:
        try:
            conn.logout()
        except (imaplib.IMAP4.error, OSError):
            pass


def check(cfg, tid):
    """Log in to SMTP and IMAP without sending anything; returns a list of problems."""
    def smtp():
        try:
            _smtp(cfg, tid).quit()
        except (OSError, smtplib.SMTPException) as e:
            return f"发信（SMTP）登录失败：{e}"

    def imap():
        if not cfg.get("imap_host"):
            return "没填收信服务器（IMAP），对方的回复收不进来"
        try:
            conn = _connect(cfg, tid)
            conn.select("INBOX", readonly=True)
            conn.logout()
        except (OSError, imaplib.IMAP4.error) as e:
            return f"收信（IMAP）登录失败：{e}"

    with ThreadPoolExecutor(2) as pool:
        return [p for p in pool.map(lambda f: f(), (smtp, imap)) if p]


def is_opt_out(text):
    return bool(OPT_OUT.search(text[:400]))
