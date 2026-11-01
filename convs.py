"""Conversations from Chatwoot channels: hosting state, routing a customer message, AI drafts for review, progress and follow-ups."""
import asyncio
import re
from datetime import datetime

import chatwoot
import db
import engine
import grading
import llm

# Hours after the customer's last message during which the platform still lets us reply; None = no limit.
WINDOW_H = {"whatsapp": 24, "instagram": 24, "messenger": 24, "tiktok": 48, "wecom_kf": 48}
STAGES = ("新询盘", "了解产品", "询价", "样品", "谈判", "已成交", "售后", "已流失")
FOLLOW_AFTER_H = 20          # draft a follow-up when the customer has been quiet this long after our reply
FOLLOW_AFTER_H_NO_WINDOW = 72
MAX_FOLLOWUPS = 2
QA_MAX = 12000

# Routing a hosted customer message. People handle these; the AI only says a colleague will follow up.
COMPLAIN_RE = re.compile(r"(?i)退款|退货|换货|投诉|差评|合同|律师|赔偿|refund|return (it|this|the)|complain|broken|defect|damaged"
                         r"|lawyer|chargeback|contract|warranty claim|reklamation|rückerstattung|remboursement|reembolso")
# The AI drafts an answer and a person approves it before it goes out.
REVIEW_RE = re.compile(r"(?i)报价|价格|多少钱|底价|折扣|优惠|佣金|起订|起批|样品|寄样|合作|代理|经销|批发|交期|账期|付款"
                       r"|price|pricing|quote|quotation|how much|\bcost|discount|commission|sample|wholesale|distribut"
                       r"|bulk|\bmoq\b|minimum order|lead time|payment terms|partnership|collab|sponsor|preis|angebot|prix|precio")


def channel_window(channel):
    return WINDOW_H.get(channel)


def state(tid, cid):
    return db.q("SELECT * FROM cw_convs WHERE tenant_id=:t AND conv_id=:c", one=True, t=tid, c=cid)


def inbox_hosted(tid, inbox_id):
    row = db.q("SELECT hosted FROM cw_inboxes WHERE tenant_id=:t AND inbox_id=:i", one=True, t=tid, i=inbox_id)
    return True if row is None else bool(row["hosted"])


def set_inbox_hosted(tid, inbox_id, hosted):
    if db.q("SELECT 1 AS x FROM cw_inboxes WHERE tenant_id=:t AND inbox_id=:i", one=True, t=tid, i=inbox_id):
        db.x("UPDATE cw_inboxes SET hosted=:h WHERE tenant_id=:t AND inbox_id=:i", h=hosted, t=tid, i=inbox_id)
    else:
        db.insert(db.cw_inboxes, tenant_id=tid, inbox_id=inbox_id, hosted=hosted)


def ensure(tid, cid, inbox_id=0, channel="", **vals):
    """The conversation's row; a new one starts in the inbox's default hosting mode."""
    row = state(tid, cid)
    if row:
        if vals:
            update(tid, cid, **vals)
            row = state(tid, cid)
        return row
    mode = vals.pop("mode", None) or ("ai" if inbox_hosted(tid, inbox_id) else "human")
    db.insert(db.cw_convs, tenant_id=tid, conv_id=cid, inbox_id=inbox_id, channel=channel, mode=mode, updated=db.now(), **vals)
    return state(tid, cid)


def update(tid, cid, **vals):
    if not vals:
        return
    sets = ", ".join(f"{k}=:{k}" for k in vals)
    db.x(f"UPDATE cw_convs SET {sets}, updated=:_u WHERE tenant_id=:_t AND conv_id=:_c", _u=db.now(), _t=tid, _c=cid, **vals)


async def set_mode(tid, cid, mode):
    """Hosting switch for one conversation. Chatwoot only runs our bot on pending conversations."""
    update(tid, cid, mode=mode)
    await chatwoot.set_status(tid, cid, "pending" if mode == "ai" else "open")


def pending_draft(tid, cid):
    return db.q("SELECT * FROM cw_drafts WHERE tenant_id=:t AND conv_id=:c AND status IN ('生成中', '待审核') ORDER BY id DESC LIMIT 1",
                one=True, t=tid, c=cid)


# ---------- contacts ----------

def upsert_contact(tid, sender, channel):
    """Link a Chatwoot contact to the platform's contacts, matching by Chatwoot id, then email, then phone; new people are 询盘客户."""
    cw_id = sender.get("id")
    email = (sender.get("email") or "").strip().lower()
    phone = (sender.get("phone_number") or "").strip()
    name = (sender.get("name") or email or phone or "未命名").strip()[:120]
    row = None
    if cw_id:
        row = db.q("SELECT * FROM contacts WHERE tenant_id=:t AND cw_contact_id=:c", one=True, t=tid, c=cw_id)
    if not row and email:
        row = db.q("SELECT * FROM contacts WHERE tenant_id=:t AND lower(email)=:e AND persona='' AND inbox_token=''", one=True, t=tid, e=email)
    if not row and phone:
        row = db.q("SELECT * FROM contacts WHERE tenant_id=:t AND phone=:p AND persona='' AND inbox_token=''", one=True, t=tid, p=phone)
    now = db.now()
    if row:
        db.x("UPDATE contacts SET cw_contact_id=:c, email=CASE WHEN email='' THEN :e ELSE email END, "
             "phone=CASE WHEN phone='' THEN :p ELSE phone END, updated=:u WHERE id=:id",
             c=cw_id, e=email, p=phone, u=now, id=row["id"])
        return row["id"]
    return db.insert(db.contacts, tenant_id=tid, kind="询盘客户", name=name, email=email, phone=phone, cw_contact_id=cw_id,
                     status="已回复", source=chatwoot.CHANNEL_LABEL.get(channel, channel), created=now, updated=now)


# ---------- AI drafts ----------

DRAFT_PROMPT = """你是「{name}」的客服，正在{channel}上和客户聊天。{task}
今天是 {today}。

【之前的对话（从早到晚）】
{thread}

【公司资料（产品事实只能来自这里）】
{chunks}

【公司对外沟通规则】
{rules}

写作要求：
- 用客户的语言写，像真人发消息，简短直接，{length}
- 型号和参数照抄公司资料原文；资料里没有的不写，拿不准的数字不写。
- 价格、折扣、佣金、起订量、交期：资料里写了就照资料说，没写的不编数字，说会请同事尽快给具体方案。
- 不说「最」「第一」「100%」，不提竞品，不提公司内部资料。

只输出 JSON：{{"text": "要发给客户的消息原文", "note": "写给审核人的一句中文：用了哪些事实、哪里要人工确认"}}"""

TASKS = {
    "回复": "客户最新的消息涉及报价或合作条件，按规则要先由同事审核。请起草一条回复，审核通过后发出。",
    "帮写": "请起草一条回复客户最新消息的消息，同事看过再发。",
    "跟进": "客户已经 {hours} 小时没回复我们上一条消息了，这是第 {n} 次跟进。写一条简短的跟进，换个角度给一个继续聊下去的理由，不要重复上一条，结尾问一个容易回答的问题。",
}


def thread_text(msgs, limit=14):
    out = []
    for m in msgs[-limit:]:
        if m.get("private") or not (m.get("content") or "").strip() or m.get("message_type") not in (0, 1):
            continue
        out.append(f"{'客户' if m['message_type'] == 0 else '我方'}：{m['content'].strip()[:800]}")
    return "\n".join(out) or "（还没有往来）"


async def sources(tenant, query):
    docs_id = tenant["rag"].get("datasets", {}).get("docs")
    chunks = await engine.retrieve([docs_id], query[:300] or tenant["name"], top=4) if docs_id else []
    qa = "\n".join(f"- {p}" for p in await grading.qa_pairs(tenant))[:QA_MAX]
    return (f"〔问答库：标准答案，以这里为准〕\n{qa or '（空）'}\n\n〔资料库检索片段〕\n"
            + ("\n\n".join(f"[{x['doc']}]\n{x['content'][:600]}" for x in chunks) or "（没有检索到）"))


async def write_draft(tenant, msgs, channel, kind, query="", n=1, hours=0):
    prompt = DRAFT_PROMPT.format(
        name=tenant["name"], channel=chatwoot.CHANNEL_LABEL.get(channel, channel),
        task=TASKS[kind].format(hours=int(hours), n=n), today=datetime.now().strftime("%Y-%m-%d"),
        thread=thread_text(msgs), chunks=await sources(tenant, query or thread_text(msgs, 4)),
        rules=tenant["rules"].strip() or "（无）",
        length="控制在 60 个英文单词或 120 个汉字以内。" if kind == "跟进" else "邮件可以分两三段，控制在 200 个英文单词以内。" if channel == "email" else "控制在 120 个英文单词或 200 个汉字以内。")
    data = await llm.chat_json([{"role": "user", "content": prompt}], tenant_id=tenant["id"], kind="inbox", temperature=0.5)
    text = (data.get("text") or "").strip()
    if not text:
        raise llm.LLMError("模型没有写出回复")
    return text, (data.get("note") or "").strip()[:500]


def add_draft(tid, cid, channel, kind, question, note):
    return db.insert(db.cw_drafts, tenant_id=tid, conv_id=cid, channel=channel, kind=kind, question=question[:2000],
                     note=note[:500], status="生成中", created=db.now(), updated=db.now())


async def fill_draft(tenant, did, msgs, channel, kind, query="", n=1, hours=0):
    try:
        text, note = await write_draft(tenant, msgs, channel, kind, query, n, hours)
        row = db.q("SELECT note FROM cw_drafts WHERE id=:d", one=True, d=did)
        note = " ｜ ".join(x for x in ((row or {}).get("note", ""), note) if x)
        db.x("UPDATE cw_drafts SET text=:x, note=:n, status='待审核', updated=:u WHERE id=:d AND status='生成中'",
             x=text, n=note[:500], u=db.now(), d=did)
    except Exception as e:  # noqa: BLE001
        db.x("UPDATE cw_drafts SET status='失败', note=:n, updated=:u WHERE id=:d", n=f"起草失败：{str(e)[:200]}", u=db.now(), d=did)


# ---------- progress ----------

SUMMARY_PROMPT = """下面是「{name}」和一位客户在{channel}上的对话。判断这单生意走到哪一步，写给销售看。

【对话（从早到晚）】
{thread}

阶段只能从这些里选一个：{stages}

只输出 JSON：{{"stage": "阶段", "summary": "一两句中文：客户是谁、要什么、关心什么", "next_step": "一句中文：我们下一步该做什么"}}"""


async def summarize(tenant, tid, cid, msgs, channel):
    data = await llm.chat_json([{"role": "user", "content": SUMMARY_PROMPT.format(
        name=tenant["name"], channel=chatwoot.CHANNEL_LABEL.get(channel, channel), thread=thread_text(msgs, 30),
        stages="、".join(STAGES))}], tenant_id=tid, kind="inbox", temperature=0.0)
    stage = data.get("stage") if data.get("stage") in STAGES else ""
    vals = {"stage": stage, "summary": str(data.get("summary") or "")[:500], "next_step": str(data.get("next_step") or "")[:300]}
    update(tid, cid, **vals)
    return vals


# ---------- scheduler ----------

TICK = 300
SUMMARY_PER_TICK = 8


async def follow_ups(tenant):
    """Hosted conversations where the customer went quiet after our reply: draft a follow-up for review, inside the reply window."""
    tid, now = tenant["id"], db.now()
    rows = db.q("SELECT * FROM cw_convs WHERE tenant_id=:t AND mode='ai' AND outreach=:f AND status IN ('pending', 'open') "
                "AND last_in IS NOT NULL AND last_out IS NOT NULL AND last_out>last_in AND followups<:m",
                t=tid, f=False, m=MAX_FOLLOWUPS)
    n = 0
    for st in rows:
        window = channel_window(st["channel"])
        quiet = (now - st["last_out"]) / 3600
        if window:
            left = window - (now - st["last_in"]) / 3600
            if left < 0.5 or quiet < min(FOLLOW_AFTER_H, window - 3):
                continue
        elif quiet < FOLLOW_AFTER_H_NO_WINDOW:
            continue
        if pending_draft(tid, st["conv_id"]):
            continue
        msgs, _ = await chatwoot.thread(tid, st["conv_id"])
        update(tid, st["conv_id"], followups=st["followups"] + 1)
        note = f"客户 {int(quiet)} 小时没回复，AI 起草了第 {st['followups'] + 1} 次跟进"
        if window:
            note += f"，{left:.0f} 小时内不发就过了{chatwoot.CHANNEL_LABEL.get(st['channel'], st['channel'])}的回复时限"
        did = add_draft(tid, st["conv_id"], st["channel"], "跟进", "", note)
        await fill_draft(tenant, did, msgs, st["channel"], "跟进", n=st["followups"] + 1, hours=quiet)
        n += 1
    return n


async def refresh_summaries(tenant):
    tid = tenant["id"]
    rows = db.q("SELECT * FROM cw_convs WHERE tenant_id=:t AND last_in IS NOT NULL AND last_in<:quiet "
                "AND (summarized IS NULL OR summarized<last_in) ORDER BY last_in DESC LIMIT :n",
                t=tid, quiet=db.now() - 120, n=SUMMARY_PER_TICK)
    for st in rows:
        msgs, _ = await chatwoot.thread(tid, st["conv_id"])
        await summarize(tenant, tid, st["conv_id"], msgs, st["channel"])
        update(tid, st["conv_id"], summarized=db.now())


async def loop(tenant_by_id, log):
    while True:
        await asyncio.sleep(TICK)
        for lk in db.q("SELECT tenant_id FROM chatwoot_links WHERE enabled=:e", e=True):
            t = tenant_by_id(lk["tenant_id"])
            if not t or t["status"] != "active":
                continue
            for job in (follow_ups, refresh_summaries):
                try:
                    await job(t)
                except Exception:  # noqa: BLE001
                    log.exception("%s failed for tenant %s", job.__name__, lk["tenant_id"])
