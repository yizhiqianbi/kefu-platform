"""AI for customer messages on Chatwoot channels.

Jev (a System One decision model) reads what the customer wants; a reply agent looks things up with read-only tools and writes;
fixed rules check the reply against what was looked up and decide whether it goes out, waits for review or goes to people.
Design: docs/agent-design.md.
"""
import asyncio
import json
import re
import time
from datetime import datetime

import chatwoot
import convs
import db
import engine
import grading
import llm
import settings

# key: (中文名, what it means — Jev and the fallback model both read this)
INTENTS = {
    "inquiry": ("咨询", "Asks about the product itself: specs, usage, compatibility, certification, shipping coverage, stock."),
    "policy": ("政策", "Asks what the company's terms are (warranty length, return policy, payment methods) without reporting a problem."),
    "quote": ("报价", "Asks for a price, discount, best offer, shipping cost, MOQ or lead time for an order."),
    "sample_partner": ("样品合作", "Asks for samples, distributorship, agency, wholesale partnership or influencer collaboration."),
    "after_sales": ("售后", "Reports a fault, damage, missing part or a product not working after purchase."),
    "complaint": ("投诉", "Expresses anger or dissatisfaction, threatens a bad review, or demands a refund or compensation."),
    "human": ("要找人", "Explicitly asks to talk to a real person, sales rep or phone call."),
    "greeting": ("问候", "Only greets, thanks or small talk with no request."),
    "irrelevant": ("无关", "Spam, advertising, scams, job seeking or unrelated to buying the product."),
}
# reply = the agent answers and may send; review = the agent drafts for a person; human = hand over; ignore = no reply
PATH = {"inquiry": "reply", "policy": "reply", "greeting": "reply", "quote": "review", "sample_partner": "review",
        "after_sales": "human", "complaint": "human", "human": "human", "irrelevant": "ignore"}
# When two judges disagree, the earlier one in this list wins.
CAUTION = ("complaint", "after_sales", "human", "quote", "sample_partner", "policy", "inquiry", "greeting", "irrelevant")

CONFIDENT = 0.85      # below this, Jev's intent is checked by the big model
ANGRY = 0.7
WANTS_HUMAN = 0.7
AUTO_CONF = 0.7       # the agent's own confidence needed to send without review
UNSUPPORTED = 0.5     # Jev: probability the reply says something the sources don't
MAX_STEPS = 4
MAX_SEARCH = 3
AGENT_TIMEOUT = 45
QA_MAX = 12000
MODES = ("off", "shadow", "router", "agent")

HUMAN_RE = re.compile(r"(?i)转人工|人工客服|找人工|真人|\bhuman\b|real person|live agent|representative"
                      r"|speak to (a |an )?(person|someone|agent)|talk to (a |an )?(person|someone|agent)")
NUM_RE = re.compile(r"\d+(?:[.,]\d+)*")
PROMISE_RE = re.compile(r"(?i)保证|一定|免费|包邮|退款|赔偿|guarantee|promise|free of charge|for free|\bfree\b|refund|compensat"
                        r"|reembols|rembours|erstatt|kostenlos|gratis")


class AgentError(RuntimeError):
    pass


def label(intent):
    return INTENTS.get(intent, (intent or "—",))[0]


# ---------- routing ----------

CLASSIFY_PROMPT = """判断客户最新这条消息想要什么。公司：{company}，渠道：{channel}。

【最近的对话（从早到晚）】
{thread}

【客户最新的消息】
{text}

意图只能选一个（英文代号）：
{intents}

只输出 JSON：{{"intent": "英文代号", "angry": true 或 false, "wants_human": true 或 false}}"""


def _questions(company):
    return {
        "intent": {"type": "choice", "instructions": f"What does the customer want in their latest message to {company}?",
                   "criteria": {k: v[1] for k, v in INTENTS.items()}},
        "angry": {"type": "noul", "instructions": "Is the customer angry or frustrated in their latest message?"},
        "wants_human": {"type": "noul", "instructions": "Does the customer ask to talk to a real person, a sales rep or by phone?"},
    }


async def _jev_route(tenant, text, thread, channel, kind):
    state = {"company": tenant["name"], "channel": chatwoot.CHANNEL_LABEL.get(channel, channel), "customer_kind": kind or "未知",
             "recent_conversation": thread, "customer_message": text}
    a = await llm.decide(state, _questions(tenant["name"]), tenant_id=tenant["id"], kind="router")
    it = a["intent"]
    probs = {k: round(float(v), 3) for k, v in (it.get("probabilities") or {}).items()}
    conf = it.get("confidence")
    conf = float(conf) if conf is not None else max(probs.values(), default=0.0)
    noul = lambda x: float(x.get("noul", x.get("probability", 0)) or 0)  # noqa: E731
    if it.get("choice") not in INTENTS:
        raise llm.LLMError(f"判断模型返回了不认识的意图：{it.get('choice')}")
    return {"intent": it["choice"], "confidence": round(conf, 3), "probs": probs,
            "angry": round(noul(a["angry"]), 3), "wants_human": round(noul(a["wants_human"]), 3)}


async def _llm_route(tenant, text, thread, channel):
    data = await llm.chat_json([{"role": "user", "content": CLASSIFY_PROMPT.format(
        company=tenant["name"], channel=chatwoot.CHANNEL_LABEL.get(channel, channel), thread=thread, text=text,
        intents="\n".join(f"- {k}：{v[1]}" for k, v in INTENTS.items()))}], tenant_id=tenant["id"], kind="router")
    if data.get("intent") not in INTENTS:
        raise llm.LLMError(f"模型返回了不认识的意图：{data.get('intent')}")
    return {"intent": data["intent"], "angry": 1.0 if data.get("angry") else 0.0, "wants_human": 1.0 if data.get("wants_human") else 0.0}


def _regex_route(text):
    if convs.COMPLAIN_RE.search(text):
        return "complaint"
    if HUMAN_RE.search(text):
        return "human"
    return "quote" if convs.REVIEW_RE.search(text) else "inquiry"


async def route(tenant, text, thread="", channel="", kind=""):
    """What the customer wants and where the message goes. Never raises: falls back from Jev to the big model to keywords."""
    t0 = time.time()
    r = {"by": "", "intent": "", "confidence": None, "probs": {}, "angry": 0.0, "wants_human": 0.0, "force_review": False, "notes": []}
    jev = big = None
    try:
        jev = await _jev_route(tenant, text, thread, channel, kind)
    except (llm.LLMError, KeyError, TypeError, ValueError) as e:
        r["notes"].append(f"Jev 没判出来：{str(e)[:120]}")
    if jev is None or jev["confidence"] < CONFIDENT:
        try:
            big = await _llm_route(tenant, text, thread, channel)
        except (llm.LLMError, ValueError) as e:
            r["notes"].append(f"大模型没判出来：{str(e)[:120]}")
    if jev:
        r.update(jev, by="jev")
        if big:
            if big["intent"] == jev["intent"]:
                r["by"] = "jev+大模型（一致）"
            else:
                r["by"] = "jev+大模型（不一致）"
                r["notes"].append(f"Jev 判{label(jev['intent'])}（把握 {jev['confidence']:.2f}），大模型判{label(big['intent'])}，按更谨慎的处理")
                r["intent"] = min(jev["intent"], big["intent"], key=CAUTION.index)
                r["force_review"] = True
            r["angry"] = max(r["angry"], big["angry"])
            r["wants_human"] = max(r["wants_human"], big["wants_human"])
    elif big:
        r.update(big, by="大模型")
    else:
        r.update(intent=_regex_route(text), by="关键词")
    r["label"] = label(r["intent"])
    r["path"] = PATH[r["intent"]]
    r["reason"] = f"{r['label']}类消息"
    if r["path"] != "human":
        if r["angry"] >= ANGRY:
            r.update(path="human", reason=f"客户在生气（概率 {r['angry']:.2f}）")
        elif r["wants_human"] >= WANTS_HUMAN:
            r.update(path="human", reason=f"客户要找人（概率 {r['wants_human']:.2f}）")
        elif HUMAN_RE.search(text) or convs.COMPLAIN_RE.search(text):
            r.update(path="human", reason="命中投诉或转人工关键词")
    r["ms"] = int((time.time() - t0) * 1000)
    return r


# ---------- reply agent ----------

AGENT_PROMPT = """你是「{name}」的客服，正在{channel}上回复客户。今天是 {today}。

【公司对外沟通规则】
{rules}

【问答库：标准答案，以这里为准，引用时写 qa】
{qa}

你可以用两个工具。每一步只输出一个 JSON：
- 查资料库：{{"step": "tool", "tool": "search_kb", "args": {{"query": "关键词"}}}}。用型号、产品名、参数名去查；没查到就换个说法（中文、英文都行）再查，最多查 {max_search} 次。
- 看这位客户的档案和以前的往来：{{"step": "tool", "tool": "get_customer", "args": {{}}}}。客户提到以前聊过、下过单，或者要报价时用。
写好后输出：{{"step": "final", "reply": "发给客户的原文", "cites": ["kb:2", "qa"], "confidence": 0 到 1 的数, "needs_human": false, "note": "给同事的一句中文：依据是什么、哪里要确认", "language": "客户用的语言代码，如 en", "points": {{"product": "", "qty": "", "destination": ""}}}}

写回复的要求：
- 用客户的语言写，像真人发消息，简短直接，{length}
- 事实（型号、参数、价格、起订量、交期、保修）只能来自问答库和查到的资料，用到的出处都写进 cites。型号和参数照抄原文。
- 资料里没有的不写，拿不准的数字不写。查不到答案时 needs_human 填 true，回复说请同事跟进，附上规则里的联系方式。
- 不承诺退款、赔偿、免费、交期，不说「最」「第一」「100%」，不提竞品，不提公司内部资料。
- {task}"""

TASK = {
    "reply": "回答客户的问题。",
    "policy": "客户问的是公司政策，照问答库或资料里的条款原文说。",
    "greeting": "客户只是打招呼或道谢，礼貌地简短回一句，问问需要什么帮助，不用查资料。",
    "review": "这条会先由同事审核再发出。资料里有价格、起订量、交期就照写；没有的不写数字，说明还需要客户提供哪些信息（型号、数量、目的地），以便同事报价。",
    "suggest": "同事会看过再发。",
}

_qa_cache: dict[int, tuple[float, str]] = {}


async def qa_text(tenant):
    hit = _qa_cache.get(tenant["id"])
    if hit and time.time() - hit[0] < 120:
        return hit[1]
    text = "\n".join(f"- {p}" for p in await grading.qa_pairs(tenant))[:QA_MAX] or "（空）"
    _qa_cache[tenant["id"]] = (time.time(), text)
    return text


def dataset_ids(tenant):
    a = tenant["rag"].get("assistants", {}).get(tenant.get("live") or "main") or {}
    return a.get("dataset_ids") or [x for x in (tenant["rag"].get("datasets", {}).get(k) for k in ("qa", "docs")) if x]


def customer_text(tid, cid, contact_id):
    c = db.q("SELECT name, kind, company, country, status, notes, last_order, email, phone FROM contacts WHERE id=:c AND tenant_id=:t",
             one=True, c=contact_id, t=tid) if contact_id else None
    if not c:
        return "（没有这位客户的档案）"
    lines = [f"档案：{c['name']}，{c['kind']}，状态 {c['status']}"
             + "".join(f"，{k} {c[f]}" for k, f in (("公司", "company"), ("国家", "country"), ("上次下单", "last_order")) if c[f])]
    if c["notes"]:
        lines.append(f"备注：{c['notes'][:300]}")
    for x in db.q("SELECT channel, stage, summary FROM cw_convs WHERE tenant_id=:t AND contact_id=:c AND conv_id<>:v AND summary<>'' "
                  "ORDER BY COALESCE(last_in, updated) DESC LIMIT 4", t=tid, c=contact_id, v=cid):
        lines.append(f"其他会话（{chatwoot.CHANNEL_LABEL.get(x['channel'], x['channel'])}，{x['stage'] or '未判断'}）：{x['summary'][:200]}")
    for x in db.q("SELECT step, status, subject, text FROM outreach WHERE contact_id=:c AND status IN ('已发送', '已收到') "
                  "ORDER BY COALESCE(sent_at, created) DESC LIMIT 4", c=contact_id):
        lines.append(f"外联（{'对方' if x['step'] == '对方' else '我方' + x['step']}）：{(x['subject'] + ' ' if x['subject'] else '')}{x['text'][:200]}")
    return "\n".join(lines)


class Evidence:
    """Everything the agent looked up, numbered so the reply can cite it."""

    def __init__(self):
        self.kb = []          # (id, doc, content)
        self.customer = ""

    def add_chunks(self, chunks):
        out = []
        for c in chunks:
            if any(c["content"] == x[2] for x in self.kb):
                continue
            cid = f"kb:{len(self.kb) + 1}"
            self.kb.append((cid, c["doc"], c["content"][:700]))
            out.append(f"[{cid}]《{c['doc']}》\n{c['content'][:700]}")
        return "\n\n".join(out) or "（没有新的结果）"

    def ids(self):
        return {"qa", "customer"} | {x[0] for x in self.kb}


async def search_kb(tenant, query, top=4):
    ids = dataset_ids(tenant)
    return await engine.retrieve(ids, query[:300], top=top) if ids else []


def _length(channel, task):
    if task == "greeting":
        return "一两句话。"
    return "邮件可以分两三段，控制在 200 个英文单词以内。" if channel == "email" else "控制在 120 个英文单词或 200 个汉字以内。"


async def compose(tenant, tid, cid, question, msgs, channel, contact_id, task="reply"):
    """The tool loop. Returns the final JSON, the evidence and the steps taken."""
    qa = await qa_text(tenant)
    ev = Evidence()
    steps = []
    first = await search_kb(tenant, question) if task != "greeting" else []
    steps.append({"tool": "search_kb", "query": question[:120], "hits": [c["doc"] for c in first], "auto": True})
    system = AGENT_PROMPT.format(name=tenant["name"], channel=chatwoot.CHANNEL_LABEL.get(channel, channel),
                                 today=datetime.now().strftime("%Y-%m-%d"), rules=tenant["rules"].strip() or "（无）", qa=qa,
                                 max_search=MAX_SEARCH, length=_length(channel, task), task=TASK.get(task, TASK["reply"]))
    user = (f"【对话（从早到晚）】\n{convs.thread_text(msgs, 12)}\n\n【客户最新的消息，要回复的就是这条】\n{question}\n\n"
            f"【按客户消息先查的资料】\n{ev.add_chunks(first)}")
    messages = [{"role": "system", "content": system}, {"role": "user", "content": user}]
    seen = set()
    searches = 1
    for i in range(MAX_STEPS):
        if i == MAX_STEPS - 1:
            messages.append({"role": "user", "content": "不能再用工具了，请直接输出 final。"})
        data = await llm.chat_json(messages, tenant_id=tid, kind="agent", temperature=0.3, model=settings.AGENT_MODEL or None)
        messages.append({"role": "assistant", "content": json.dumps(data, ensure_ascii=False)})
        if data.get("step") == "final" or data.get("reply"):
            if not str(data.get("reply") or "").strip():
                raise AgentError("AI 没有写出回复")
            return data, ev, steps, qa
        tool, args = data.get("tool"), data.get("args") or {}
        key = (tool, json.dumps(args, sort_keys=True, ensure_ascii=False))
        if key in seen:
            result = "这个已经查过了。换个说法再查，或者直接输出 final。"
        elif tool == "search_kb" and searches < MAX_SEARCH:
            q = str(args.get("query") or "").strip() or question
            chunks = await search_kb(tenant, q)
            searches += 1
            steps.append({"tool": "search_kb", "query": q[:120], "hits": [c["doc"] for c in chunks]})
            result = f"【search_kb「{q}」的结果】\n{ev.add_chunks(chunks)}"
        elif tool == "search_kb":
            result = f"已经查了 {MAX_SEARCH} 次，不能再查了。资料里没有就 needs_human 填 true，直接输出 final。"
        elif tool == "get_customer":
            ev.customer = customer_text(tid, cid, contact_id)
            steps.append({"tool": "get_customer"})
            result = f"【get_customer 的结果，引用时写 customer】\n{ev.customer}"
        else:
            result = "没有这个工具。只能用 search_kb、get_customer，或者输出 final。"
        seen.add(key)
        messages.append({"role": "user", "content": result})
    raise AgentError(f"AI {MAX_STEPS} 步内没有写出回复")


async def check(tenant, final, ev, qa, msgs):
    """Fixed rules (and one Jev question) on the reply. Returns the failed checks in Chinese."""
    reply = str(final.get("reply") or "")
    thread = convs.thread_text(msgs, 30)
    said = "\n".join((m.get("content") or "") for m in msgs if m.get("message_type") == 0 and not m.get("private"))
    evidence = "\n".join([tenant["rules"], tenant.get("empty_response") or "", qa, ev.customer, said]
                         + [f"{x[1]} {x[2]}" for x in ev.kb])
    flat = re.sub(r"[\s,]", "", evidence)
    failed = []
    bad = sorted({n for n in NUM_RE.findall(reply) if n.replace(",", "") not in flat})
    if bad:
        failed.append("这些数字在资料里找不到：" + "、".join(bad[:6]))
    promises = sorted({m.group(0).lower() for m in PROMISE_RE.finditer(reply)} - {w for w in
                      (m.group(0).lower() for m in PROMISE_RE.finditer(evidence))})
    if promises:
        failed.append("有资料里没有的承诺：" + "、".join(promises))
    cites = [str(c) for c in final.get("cites") or []]
    wrong = [c for c in cites if c not in ev.ids()]
    if wrong:
        failed.append("引用了不存在的出处：" + "、".join(wrong[:4]))
    sources = "\n\n".join([f"[qa]\n{qa}"] + [f"[{x[0]}]《{x[1]}》\n{x[2]}" for x in ev.kb] + ([f"[customer]\n{ev.customer}"] if ev.customer else []))
    try:
        a = await llm.decide({"sources": sources[:20000], "conversation": thread[-1500:], "reply": reply}, {"unsupported": {
            "type": "noul", "instructions": "Does the reply state any fact, number or commitment that is NOT supported by the sources?",
            "criteria": "Greetings, offers to help, saying a colleague will follow up, and asking the customer for details do not count."}},
            tenant_id=tenant["id"], kind="router")
        p = float(a["unsupported"].get("noul", a["unsupported"].get("probability", 0)) or 0)
        final["unsupported"] = round(p, 3)
        if p >= UNSUPPORTED:
            failed.append(f"Jev 判断回复里有资料里没有的内容（概率 {p:.2f}）")
    except (llm.LLMError, KeyError, TypeError, ValueError):
        final["unsupported"] = None
    return failed


def gate(r, final, failed):
    """send | review | handoff, and why."""
    if r["path"] == "review":
        return "review", f"{r['label']}类消息要人工审核" + ("，资料里缺内容要同事补" if final.get("needs_human") else "")
    if final.get("needs_human"):
        return "handoff", "AI 查不到答案"
    if r.get("force_review"):
        return "review", "两个模型对意图判断不一致"
    if failed:
        return "review", "；".join(failed)
    try:
        conf = float(final.get("confidence"))
    except (TypeError, ValueError):
        conf = 0.0
    if conf < AUTO_CONF:
        return "review", f"AI 自评把握只有 {conf:.2f}"
    return "send", ""


async def answer(tenant, tid, cid, question, msgs, channel, contact_id, r):
    """Compose, check and gate a reply for a routed message. Nothing is sent here."""
    t0 = time.time()
    task = "review" if r["path"] == "review" else "policy" if r["intent"] == "policy" else "greeting" if r["intent"] == "greeting" else "reply"
    final, ev, steps, qa = await asyncio.wait_for(compose(tenant, tid, cid, question, msgs, channel, contact_id, task), AGENT_TIMEOUT)
    failed = await check(tenant, final, ev, qa, msgs)
    action, reason = gate(r, final, failed)
    cited = {str(c) for c in final.get("cites") or []}
    refs = [{"doc": x[1], "content": x[2][:600], "similarity": None} for x in ev.kb if x[0] in cited]
    note = " ｜ ".join(x for x in (reason, str(final.get("note") or "").strip()) if x)
    return {"reply": str(final["reply"]).strip(), "action": action, "reason": reason, "note": note[:500], "checks": failed,
            "steps": steps, "refs": refs, "final": {k: final.get(k) for k in ("cites", "confidence", "needs_human", "language", "points", "unsupported")},
            "ms": int((time.time() - t0) * 1000)}


async def suggest(tenant, tid, cid, question, msgs, channel, contact_id):
    """AI 帮写: the agent writes, the checks become a note for the colleague; never sent."""
    final, ev, steps, qa = await asyncio.wait_for(compose(tenant, tid, cid, question, msgs, channel, contact_id, "suggest"), AGENT_TIMEOUT)
    failed = await check(tenant, final, ev, qa, msgs)
    note = " ｜ ".join(x for x in ("；".join(failed), str(final.get("note") or "").strip()) if x)
    save(tid, cid, channel, "suggest", question, {}, steps, str(final["reply"]).strip(), failed, "", "", 0)
    return str(final["reply"]).strip(), note[:500]


# ---------- records ----------

def save(tid, cid, channel, mode, question, r, steps, reply, checks, action, actual="", ms=0):
    return db.insert(db.agent_runs, tenant_id=tid, conv_id=cid, channel=channel, mode=mode, question=question[:2000],
                     intent=(r or {}).get("intent", ""), route=db.dumps(r or {}), steps=db.dumps(steps or []), reply=reply[:4000],
                     checks=db.dumps(checks or []), action=action, actual=actual, ms=ms, created=db.now())


async def shadow(tenant, tid, cid, question, msgs, channel, contact_id, kind, actual):
    """Shadow mode: decide as if live, record it next to what the live pipeline did, act on nothing."""
    t0 = time.time()
    r = await route(tenant, question, convs.thread_text(msgs, 6), channel, kind)
    reply, checks, steps, action = "", [], [], {"human": "handoff", "ignore": "ignore"}.get(r["path"], "")
    if not action:
        try:
            res = await answer(tenant, tid, cid, question, msgs, channel, contact_id, r)
            reply, checks, steps, action = res["reply"], res["checks"], res["steps"], res["action"]
            r["reason"] = res["reason"] or r["reason"]
            r["final"] = res["final"]
        except (AgentError, llm.LLMError, engine.EngineError, asyncio.TimeoutError) as e:
            action, r["reason"] = "review", f"AI 出错：{str(e)[:120] or type(e).__name__}"
    save(tid, cid, channel, "shadow", question, r, steps, reply, checks, action, actual, int((time.time() - t0) * 1000))


def latest(tid, cid):
    row = db.q("SELECT * FROM agent_runs WHERE tenant_id=:t AND conv_id=:c AND mode<>'suggest' ORDER BY id DESC LIMIT 1", one=True, t=tid, c=cid)
    return view(row) if row else None


ACTION_TEXT = {"send": "直接发出", "review": "起草待审", "handoff": "转人工", "ignore": "不回复", "": "—"}


def view(row):
    r = db.loads(row["route"], {})
    return {"id": row["id"], "mode": row["mode"], "question": row["question"], "intent": row["intent"], "label": label(row["intent"]),
            "confidence": r.get("confidence"), "by": r.get("by", ""), "angry": r.get("angry"), "path": r.get("path", ""),
            "reason": r.get("reason", ""), "notes": r.get("notes", []), "final": r.get("final") or {},
            "steps": db.loads(row["steps"], []), "reply": row["reply"], "checks": db.loads(row["checks"], []),
            "action": row["action"], "action_text": ACTION_TEXT.get(row["action"], row["action"]),
            "actual": row["actual"], "actual_text": ACTION_TEXT.get(row["actual"], row["actual"]), "ms": row["ms"], "created": row["created"]}


# ---------- routing test set ----------

ROUTE_CASES = [
    ("What's your best offer for 300 pcs?", "quote"),
    ("¿Cuánto cuesta enviarlo a México?", "quote"),
    ("Wie teuer ist das Gerät?", "quote"),
    ("My unit stopped cooling after two days.", "after_sales"),
    ("I'm really disappointed, the AC is so loud I can't sleep.", "complaint"),
    ("Can I talk to someone from your team?", "human"),
    ("Is this returnable if it doesn't fit my tent?", "policy"),
    ("Do you ship to Brazil?", "inquiry"),
    ("Quanto custa?", "quote"),
    ("这个空调能用在车上吗", "inquiry"),
    ("你们最低多少台起订", "quote"),
    ("东西坏了，你们怎么处理", "after_sales"),
    ("Thanks a lot, have a nice weekend!", "greeting"),
    ("We are an SEO agency, we can rank your site #1 on Google, reply for a free audit.", "irrelevant"),
    ("I run a camping store in Austria, do you work with distributors?", "sample_partner"),
    ("Could you send one sample unit before we place a bulk order?", "sample_partner"),
    ("Third time asking. Where is my order?? This is ridiculous.", "complaint"),
    ("How long is the warranty?", "policy"),
    ("Est-ce que ça marche avec une batterie 12V ?", "inquiry"),
    ("Je veux être remboursé, l'appareil est arrivé cassé.", "complaint"),
    ("この製品の消費電力は何ワットですか？", "inquiry"),
    ("Please call me at +1 415 555 0134, I prefer to discuss by phone.", "human"),
    ("Hi", "greeting"),
    ("The remote control is missing from the box.", "after_sales"),
]


async def eval_routes(tenant):
    """Run the built-in routing cases. A wrong path matters more than a wrong label: 投诉 sent to 售后 is still handed to people."""
    t0 = time.time()
    sem = asyncio.Semaphore(6)

    async def one(text, want):
        async with sem:
            r = await route(tenant, text, "", "whatsapp")
        return {"text": text, "want": want, "want_label": label(want), "got": r["intent"], "got_label": r["label"], "by": r["by"],
                "confidence": r["confidence"], "angry": r["angry"], "path": r["path"], "want_path": PATH[want],
                "ok": r["intent"] == want, "path_ok": r["path"] == PATH[want] or (PATH[want] == "human" and r["path"] == "human")}
    rows = await asyncio.gather(*[one(t, w) for t, w in ROUTE_CASES])
    must = [x for x in rows if x["want_path"] == "human"]
    return {"rows": rows, "total": len(rows), "ok": sum(x["ok"] for x in rows), "path_ok": sum(x["path_ok"] for x in rows),
            "human_total": len(must), "human_ok": sum(x["path"] == "human" for x in must), "seconds": round(time.time() - t0, 1)}
