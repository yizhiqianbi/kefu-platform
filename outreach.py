"""主动跟进：AI 起草发给达人、B 端客户、老买家的 TikTok 私信，人工审核后再发。"""
from datetime import datetime

import db
import engine
import grading
import llm

KINDS = ("达人", "B端客户", "买家")
SCENARIOS = ("达人建联", "老客户复购", "售后回访")
CONTACT_STATUS = ("未联系", "已联系", "已回复", "合作中", "已成交", "不再联系")
PENDING = ("生成中", "待审核", "待发送")
TEXT_MAX = 2000  # TikTok Shop IM text limit
QA_MAX = 16000

KIND_DESC = {
    "达人": "TikTok 达人（内容创作者）",
    "B端客户": "B 端客户（经销商、批发商、零售商）",
    "买家": "买过我们产品的客户",
}

GOAL = {
    "达人建联": "邀请对方合作推广我们的产品（寄样测评、带货）。说明为什么找他（结合他的领域和受众），挑一两个和他受众相关的产品卖点。",
    "老客户复购": "联系买过我们产品的客户，结合他上次买的东西，介绍新品或提醒旺季备货，问他接下来的补货计划。",
    "售后回访": "联系已经收到货的客户，问使用情况；公司资料里有和他买的产品相关的使用提示就挑一条写上，没有就不写；邀请他反馈或留评价；他有问题就转人工处理。",
}

DEFAULT_CFG = {
    "sender": "",
    "briefs": {s: "" for s in SCENARIOS},
    "followup_days": {"达人建联": 3, "老客户复购": 7, "售后回访": 7},
    "max_followups": 2,
}

PROMPT = """你是「{name}」的外联专员，在 TikTok 私信里主动联系{kind_desc}。现在要写{step_desc}
今天是 {today}。提到季节时按对方所在国家判断（注意南北半球）。

【场景】{scenario}：{goal}

【这次的要点（运营填写，可以直接用）】
{brief}

【对方资料】
{contact}

【之前的往来（从早到晚）】
{thread}

【公司资料（产品事实只能来自这里和上面的要点）】
{chunks}

【公司对外沟通规则】
{rules}

写作要求：
- 用对方的语言写：看对方资料里的语言，没写就按国家判断，判断不了用英文。
- 像真人发私信：开头直接称呼对方，不用「Dear Sir/Madam」，不堆表情和话题标签。对达人可以轻松一点，对 B 端客户用正式称呼（如德语用 Sie、日语用敬语）。{length}
- 型号和参数照抄公司资料原文，同一个数字必须和它的型号出现在同一段资料里；拿不准就不写数字。使用建议也只能用资料里写了的。
- 价格、折扣、佣金比例、寄样条件、交期承诺：要点里没写的不写具体数字，说具体方案私信发给对方或约时间详聊。
- 不说「最」「第一」「100%」，不提竞品，不提公司内部资料。
- 结尾给一个对方很容易回答的问题。
- 署名：{sender}
- 对方的话涉及投诉、退款、要报价或合同、要求承诺，或者明确拒绝合作时，needs_human 设为 true，在 note 里说明原因；对方明确拒绝时，text 只写一句礼貌的收尾。

只输出 JSON：{{"text": "要发出去的私信原文", "note": "写给审核人的一句中文：用了哪些事实、哪里要人工确认（不要写字段名）", "needs_human": false}}"""

CHECK_PROMPT = """下面是一条准备发给客户的私信草稿，以及写它时能用的资料。逐条核对草稿里的事实：型号、参数数字、功能、使用建议、季节和时间说法（今天是 {today}，对方在 {country}）。

【运营给的要点】
{brief}

【对方资料（关于对方的信息以这里为准，可以引用）】
{contact}

【之前的往来】
{thread}

【公司资料】
{chunks}

【草稿】
{text}

核对标准：
- 每个型号和它的数字必须在问答库同一条里对得上（例如问答库写 C11 1100W，草稿写 C11 1400W 就是错的）；峰值功率不能说成制冷量；资料里没有的使用建议、功能、承诺，以及资料里没写的技术名词（如红外、热泵、变频、静音级别），都算没有依据。
- 关于对方的信息（订单、领域、国家）对照对方资料和往来记录，对得上就保留。
- 全文要用同一种语言（对方的语言），混进其他语言的词要翻译掉。
- 结尾要有署名：{sender}，缺了就补上。
有错、没依据或不合要求的，改正或删掉，其余文字和语气保持不变。都没问题就原样返回。

只输出 JSON：{{"text": "核对后的私信", "fixes": ["改了什么，用中文一句话说清，没改就是空数组"]}}"""

STEP = {
    "首次": ("第一条私信。", "控制在 80 个英文单词或 150 个汉字以内。"),
    "跟进": ("一条跟进私信：对方还没回复，这是第 {n} 次跟进。简短提醒，换个角度给一个新理由，不要重复上一条。", "控制在 50 个英文单词或 100 个汉字以内。"),
    "回复": ("对对方最新一条消息的回复：先回应对方说的内容，再推进下一步。", "控制在 120 个英文单词或 200 个汉字以内。"),
}


SIM_CONTACTS = [
    dict(kind="达人", name="Mia", handle="mia.camps", country="美国", language="英语", followers=12500, niche="露营 / 帐篷装备测评",
         notes="做帐篷露营装备测评，常在夏天夜里露营",
         persona="美国露营博主，对帐篷空调有兴趣但谨慎。第一次回复：说有兴趣，问佣金比例，问能不能免费寄样到洛杉矶。"
                 "之后如果对方没给具体佣金和寄样条件、只说会确认，就说等消息，再顺便问噪音大不大（你晚上睡帐篷）。"
                 "如果对方给了明确的佣金和寄样条件，就答应合作并说收件城市是 Los Angeles。"),
    dict(kind="达人", name="Lukas", handle="lukas.vanlife", country="德国", language="德语", followers=48000, niche="房车改装 / Vanlife",
         notes="技术流房车改装博主，测评很较真",
         persona="挑剔的技术型博主。第一次回复：怀疑「不用接排水管真的行吗？实际噪音多少分贝？」。"
                 "如果对方回答具体、有数字、没有夸大，就说可以考虑测评，但要先看规格书。"
                 "如果对方用了「最安静」「第一」「完美」这类夸大说法，就冷淡地说不感兴趣。"),
    dict(kind="达人", name="Sora", handle="sora_solocamp", country="日本", language="日语", followers=8000, niche="ソロキャンプ",
         persona="很忙的日本单人露营博主。收到第一条私信时不回复（reply 留空）。"
                 "收到跟进私信后才回复：简短地问有没有日本用的 100V 版本。之后对方怎么答都礼貌地说再考虑一下。"),
    dict(kind="B端客户", name="Ahmed", handle="desertcamp.ae", country="阿联酋", language="英语", company="Desert Camp Supplies LLC",
         niche="露营用品批发", last_order="2026-03 COG-3 × 300 台",
         persona="经销商采购经理，说话直接。第一次回复：要 500 台 COG-3+ 的报价和交期，问能不能给 10% 折扣。"
                 "如果对方直接答应折扣或报了具体价格，就要求书面确认；如果对方说转给业务员，就留下 WhatsApp +971 50 000 0000，说等报价。"),
    dict(kind="B端客户", name="Jonas", handle="outdoorshop.de", country="德国", language="德语", company="Outdoor Shop GmbH",
         niche="户外用品零售", last_order="2026-05 ROG-1 × 200 台",
         persona="老客户，零售店老板，语气正式。第一次回复：说 ROG-1 今年卖得一般，顾客说冬天用不上，问有没有能制热的型号、起订量多少。"
                 "接着问能不能混批（不同型号一起凑起订量）。"),
    dict(kind="买家", name="Kenji", handle="kenji_rv", country="日本", language="日语", last_order="2026-08 Space Cool-C11 × 1 台",
         notes="已收货",
         persona="买了 Space Cool-C11 的房车用户，有点生气。收到回访后抱怨：用了两周，最近机器底部漏水，地板都湿了，要求退货或换货。"
                 "对方如果只道歉不给处理办法，就更不满，说要给差评。"),
    dict(kind="买家", name="Chloe", handle="chloe.outback", country="澳大利亚", language="英语", last_order="2026-09 POG-1 × 1 台",
         notes="已收货",
         persona="很满意的买家。收到回访后说用得很好，愿意留好评；顺便问 POG-1 冬天能不能当暖风用（她记得有冷暖款，但不确定自己买的是哪种）。"),
]

ROLE_PROMPT = """这是外联演练。你扮演 TikTok 上的「{name}」（{kind}，{country}），收到了「{tenant}」发来的私信。

【你的人设和剧本（对方看不到）】
{persona}

【到目前为止的对话（从早到晚）】
{thread}

按人设回复对方最新的一条私信：像真人发私信，一般 1–3 句，用{language}，不要提到演练或扮演。
只有剧本明确写了这一次不回复时，silent 才设为 true；其他情况都要写出 reply。

只输出 JSON：{{"silent": false, "reply": "你的回复"}}"""


async def role_play(tenant, contact):
    history = "\n".join(f"{'我' if m['step'] == '对方' else '对方'}：{m['text']}" for m in thread_of(contact["id"])[-12:])
    data = await llm.chat_json([{"role": "user", "content": ROLE_PROMPT.format(
        name=contact["name"], kind=contact["kind"], country=contact["country"] or "未知", tenant=tenant["name"],
        persona=contact["persona"], thread=history or "（还没有）", language=contact["language"] or "英语")}],
        tenant_id=tenant["id"], kind="outreach", temperature=0.7)
    return "" if data.get("silent") is True else (data.get("reply") or "").strip()


def cfg(tid):
    row = db.q("SELECT data FROM outreach_cfg WHERE tenant_id=:t", one=True, t=tid)
    data = db.loads(row["data"], {}) if row else {}
    out = {**DEFAULT_CFG, **data}
    out["briefs"] = {**DEFAULT_CFG["briefs"], **(data.get("briefs") or {})}
    out["followup_days"] = {**DEFAULT_CFG["followup_days"], **(data.get("followup_days") or {})}
    return out


def contact_text(c):
    rows = [("类型", c["kind"]), ("称呼", c["name"]), ("TikTok 账号", c["handle"]), ("国家", c["country"]),
            ("语言", c["language"]), ("粉丝数", c["followers"] or ""), ("领域 / 品类", c["niche"]),
            ("公司", c["company"]), ("最近订单", c["last_order"]), ("备注", c["notes"])]
    return "\n".join(f"- {k}：{v}" for k, v in rows if v)


def thread_of(contact_id):
    return db.q("SELECT * FROM outreach WHERE contact_id=:c AND status IN ('已发送', '已收到') ORDER BY COALESCE(sent_at, created)",
                c=contact_id)


def next_step(contact_id):
    thread = thread_of(contact_id)
    if not thread:
        return "首次"
    return "回复" if thread[-1]["step"] == "对方" else "跟进"


async def draft(tenant, contact, scenario, step):
    c = cfg(tenant["id"])
    thread = thread_of(contact["id"])
    brief = (c["briefs"].get(scenario) or "").strip()
    if step == "回复":
        query = thread[-1]["text"]
    else:
        query = " ".join(x for x in (scenario, contact["niche"], contact["last_order"], brief) if x)
    docs_id = tenant["rag"].get("datasets", {}).get("docs")
    chunks = await engine.retrieve([docs_id], query[:300] or tenant["name"], top=4) if docs_id else []
    qa = "\n".join(f"- {p}" for p in await grading.qa_pairs(tenant))[:QA_MAX]
    step_desc, length = STEP[step]
    today = datetime.now().strftime("%Y-%m-%d")
    brief = brief or "（运营这次没有填写要点）"
    sources = (f"〔问答库：按型号整理过的标准答案，以这里为准〕\n{qa or '（空）'}\n\n〔资料库检索片段：原文可能排版错乱，和问答库冲突时以问答库为准〕\n"
               + ("\n\n".join(f"[{x['doc']}]\n{x['content'][:600]}" for x in chunks) or "（没有检索到）"))
    history = "\n".join(f"{'对方' if m['step'] == '对方' else '我方'}：{m['text']}" for m in thread[-12:]) or "（还没有往来）"
    sender = c["sender"] or tenant["name"]
    prompt = PROMPT.format(
        name=tenant["name"], kind_desc=KIND_DESC[contact["kind"]], today=today,
        step_desc=step_desc.format(n=contact["followups"] + 1), scenario=scenario, goal=GOAL[scenario],
        brief=brief, contact=contact_text(contact), thread=history,
        chunks=sources, rules=tenant["rules"].strip() or "（无）", length=length, sender=sender)
    data = await llm.chat_json([{"role": "user", "content": prompt}], tenant_id=tenant["id"], kind="outreach", temperature=0.6)
    text = (data.get("text") or "").strip()
    if not text:
        raise llm.LLMError("模型没有写出私信")
    note = (data.get("note") or "").strip()
    checked = await llm.chat_json([{"role": "user", "content": CHECK_PROMPT.format(
        today=today, country=contact["country"] or "未知", brief=brief, contact=contact_text(contact), thread=history,
        chunks=sources, text=text, sender=sender)}],
        tenant_id=tenant["id"], kind="outreach", temperature=0.0)
    fixes = [f.strip() for f in checked.get("fixes") or [] if isinstance(f, str) and f.strip()]
    if fixes and (checked.get("text") or "").strip():
        text = checked["text"].strip()
        note = (note + " ｜ 核对时改了：" + "；".join(fixes)).strip(" ｜")
    return {"text": text[:TEXT_MAX], "note": note[:500], "needs_human": bool(data.get("needs_human"))}
