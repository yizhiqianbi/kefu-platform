"""自动运营：定时给新达人打分，按每日上限建联，到期自动跟进，收邮件回复并起草回复；自动模式下不需要人工的邮件直接发出。

和 server.py 共用起草、发送、录入回复的逻辑，启动时由 server 通过 hooks 注入，避免循环引用。
"""
import asyncio
import logging
from datetime import datetime
from types import SimpleNamespace

import auth
import creators
import db
import llm
import mailer
import outreach
import settings

INTERVAL = int(settings.env("PILOT_INTERVAL", "120"))  # seconds; 0 turns the scheduler off
BY = "自动运营"
SCORE_BATCH = 20
SEND_GAP = 3            # seconds between two emails from one mailbox
SEND_CAP_FACTOR = 4     # all emails per day (first contacts + follow-ups + replies) <= daily_new × this
hooks = SimpleNamespace(queue=None, deliver=None, record_reply=None, scenario_for=None)
log = logging.getLogger("pilot")


def event(tid, kind, text):
    last = db.q("SELECT kind, text FROM pilot_events WHERE tenant_id=:t ORDER BY id DESC LIMIT 1", one=True, t=tid)
    if kind == "出错" and last and last["kind"] == kind and last["text"] == text[:500]:
        return
    db.insert(db.pilot_events, tenant_id=tid, kind=kind, text=text[:500], created=db.now())


def today_start():
    return datetime.now().replace(hour=0, minute=0, second=0, microsecond=0).timestamp()


def has_pending(cid):
    return bool(db.q("SELECT id FROM outreach WHERE contact_id=:c AND status IN ('生成中', '待审核', '待发送')", one=True, c=cid))


REAL = "persona='' AND inbox_token=''"


async def score_new(tenant, cfg, ids=None):
    """Score creators that have no score yet (or the given ids). A failed score is stored as -1 so it isn't retried forever."""
    if ids:
        marks = ", ".join(str(int(i)) for i in ids)
        rows = db.q(f"SELECT * FROM contacts WHERE tenant_id=:t AND id IN ({marks})", t=tenant["id"])
    else:
        rows = db.q(f"SELECT * FROM contacts WHERE tenant_id=:t AND kind='达人' AND score IS NULL AND {REAL} ORDER BY id LIMIT :n",
                    t=tenant["id"], n=SCORE_BATCH)
    if not rows:
        return 0
    company = await creators.company_brief(tenant)
    sem = asyncio.Semaphore(4)
    failed = []

    async def one(c):
        async with sem:
            try:
                await creators.score(tenant, c, cfg["profile"], company)
            except llm.LLMError as e:
                failed.append(c["name"])
                db.x("UPDATE contacts SET score=-1, score_reason=:r WHERE id=:c", r=f"评分失败：{str(e)[:200]}", c=c["id"])

    await asyncio.gather(*(one(c) for c in rows))
    done = len(rows) - len(failed)
    if done:
        event(tenant["id"], "评分", f"给 {done} 位达人打了分")
    if failed:
        event(tenant["id"], "出错", f"{len(failed)} 位达人评分失败（{'、'.join(failed[:5])}），可以在联系人里重新评分")
    return done


async def fetch_replies(tenant, cfg):
    tid = tenant["id"]
    got = await asyncio.to_thread(mailer.fetch, cfg["mail"], tid)
    n = 0
    for m in got:
        c = db.q(f"SELECT * FROM contacts WHERE tenant_id=:t AND lower(email)=:e AND {REAL}", one=True, t=tid, e=m["from"])
        if not c or not m["text"]:
            continue
        if m["message_id"] and db.q("SELECT id FROM outreach WHERE tenant_id=:t AND mail_id=:m", one=True, t=tid, m=m["message_id"]):
            continue
        scenario = hooks.scenario_for(c)
        hooks.record_reply(c, scenario, m["text"], c["name"], channel="email", mail_id=m["message_id"], subject=m["subject"])
        n += 1
        if mailer.is_opt_out(m["text"]):
            db.x("UPDATE contacts SET status='不再联系', followup_at=NULL, updated=:u WHERE id=:c", u=db.now(), c=c["id"])
            db.x("UPDATE outreach SET status='已拒绝', note='对方要求不再联系，自动撤下' WHERE contact_id=:c AND status IN ('生成中', '待审核', '待发送')", c=c["id"])
            event(tid, "退订", f"{c['name']} 回复不再联系，已停止跟进")
            continue
        event(tid, "收到", f"{c['name']} 回复了邮件")
        db.x("DELETE FROM outreach WHERE contact_id=:c AND status IN ('待审核', '待发送', '失败')", c=c["id"])
        if not has_pending(c["id"]):
            hooks.queue(tenant, BY, db.q("SELECT * FROM contacts WHERE id=:c", one=True, c=c["id"]), scenario, "回复")
    return n


def follow_up(tenant, cfg):
    tid, limit = tenant["id"], cfg["max_followups"]
    rows = db.q(f"SELECT * FROM contacts WHERE tenant_id=:t AND status IN ('已联系', '已回复') AND followup_at IS NOT NULL "
                f"AND followup_at<=:now AND {REAL} AND (email<>'' OR :tk)", t=tid, now=db.now(), tk=bool(cfg["pilot"].get("tiktok")))
    n = 0
    for c in rows:
        thread = outreach.thread_of(c["id"])
        if not thread or thread[-1]["step"] == "对方" or has_pending(c["id"]):
            continue
        if c["followups"] >= limit:
            db.x("UPDATE contacts SET followup_at=NULL WHERE id=:c", c=c["id"])
            event(tid, "停止", f"{c['name']} 跟进 {c['followups']} 次都没回复，不再追")
            continue
        hooks.queue(tenant, BY, c, hooks.scenario_for(c), "跟进")
        n += 1
    if n:
        event(tid, "起草", f"给 {n} 位到期没回复的联系人起草跟进")
    return n


def start_new(tenant, cfg):
    tid, p = tenant["id"], cfg["pilot"]
    used = db.scalar("SELECT COUNT(*) FROM outreach WHERE tenant_id=:t AND step='首次' AND created>=:d AND status NOT IN ('已拒绝', '失败')",
                     t=tid, d=today_start()) or 0
    room = int(p["daily_new"]) - used
    if room <= 0:
        return 0
    reach = "(email<>'' OR handle<>'')" if p.get("tiktok") else "email<>''"
    rows = db.q(f"SELECT * FROM contacts WHERE tenant_id=:t AND kind='达人' AND status='未联系' AND score>=:s AND {REAL} AND {reach} "
                "ORDER BY score DESC, id LIMIT :n", t=tid, s=int(p["min_score"]), n=room * 2)
    n = 0
    for c in rows:
        if n >= room:
            break
        if outreach.thread_of(c["id"]) or has_pending(c["id"]):
            continue
        hooks.queue(tenant, BY, c, "达人建联", "首次")
        n += 1
    if n:
        event(tid, "起草", f"给 {n} 位高分达人起草建联{'邮件' if not p.get('tiktok') else '消息'}（今天已用 {used + n}/{p['daily_new']}）")
    return n


async def release(tenant, cfg):
    tid, p = tenant["id"], cfg["pilot"]
    if p["mode"] == "auto":
        db.x("UPDATE outreach SET status='待发送', approved_by=:b WHERE tenant_id=:t AND status='待审核' AND channel='email' "
             "AND step<>'对方' AND needs_human=:f", b=BY, t=tid, f=False)
    if not mailer.ready(cfg["mail"], tid):
        return 0
    cap = int(p["daily_new"]) * SEND_CAP_FACTOR
    sent = db.scalar("SELECT COUNT(*) FROM outreach WHERE tenant_id=:t AND channel='email' AND step<>'对方' AND status='已发送' AND sent_at>=:d",
                     t=tid, d=today_start()) or 0
    rows = db.q("SELECT * FROM outreach WHERE tenant_id=:t AND status='待发送' AND channel='email' ORDER BY id LIMIT :n",
                t=tid, n=max(0, cap - sent))
    n = 0
    for m in rows:
        c = db.q("SELECT * FROM contacts WHERE id=:c", one=True, c=m["contact_id"])
        try:
            await hooks.deliver(tenant, m, c, m["approved_by"] or BY)
            n += 1
        except Exception as e:  # noqa: BLE001
            db.x("UPDATE outreach SET status='失败', note=:n WHERE id=:m", n=f"发送失败：{str(e)[:200]}", m=m["id"])
            event(tid, "出错", f"发给 {c['name']} 的邮件没发出去：{str(e)[:150]}")
        await asyncio.sleep(SEND_GAP)
    if n:
        event(tid, "发送", f"发出 {n} 封邮件")
    if sent + n >= cap and rows:
        event(tid, "停止", f"今天已发 {sent + n} 封，到了每日上限，剩下的明天再发")
    return n


async def tick(tenant, force=False):
    cfg = outreach.cfg(tenant["id"])
    if not (cfg["pilot"]["enabled"] or force):
        return
    tid = tenant["id"]
    await score_new(tenant, cfg)
    if mailer.ready(cfg["mail"], tid) and cfg["mail"].get("imap_host") and not mailer.via_inbox(cfg["mail"]):
        try:
            await fetch_replies(tenant, cfg)
        except Exception as e:  # noqa: BLE001
            event(tid, "出错", f"收邮件失败：{str(e)[:200]}")
    follow_up(tenant, cfg)
    start_new(tenant, cfg)
    await release(tenant, cfg)


async def loop():
    while INTERVAL > 0:
        for row in db.q("SELECT slug FROM tenants"):
            try:
                t = auth.tenant_by_slug(row["slug"])
                if t:
                    await tick(t)
            except Exception:  # noqa: BLE001
                log.exception("autopilot tick failed for %s", row["slug"])
        await asyncio.sleep(INTERVAL)
