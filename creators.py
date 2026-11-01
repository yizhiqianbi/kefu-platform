"""达人名单导入（认得 FastMoss、Kalodata 等工具导出的表头）和按达人画像的 AI 评分。"""
import csv
import io
import re

import openpyxl

import db
import grading
import llm

# 表头别名：比较时忽略大小写和空格。认不出的列原样存进 metrics，评分和起草时会参考。
ALIASES = {
    "kind": ["类型", "type"],
    "name": ["称呼", "达人昵称", "昵称", "达人名称", "达人名", "名称", "creator", "creatorname", "nickname", "name", "displayname"],
    "handle": ["tiktok账号", "达人账号", "账号", "达人id", "tiktokid", "用户名", "handle", "username", "uniqueid", "unique_id", "@"],
    "profile_url": ["主页链接", "达人主页", "主页", "主页地址", "达人链接", "链接", "profileurl", "profilelink", "profile", "url", "link"],
    "email": ["邮箱", "联系邮箱", "电子邮箱", "达人邮箱", "email", "e-mail", "emailaddress", "contactemail", "businessemail"],
    "country": ["国家", "国家/地区", "地区", "所在地区", "所属地区", "country", "region", "country/region", "location"],
    "language": ["语言", "language"],
    "followers": ["粉丝数", "粉丝", "粉丝量", "粉丝总数", "followers", "followercount", "followerscount", "fans"],
    "niche": ["领域/品类", "领域", "品类", "带货类目", "类目", "主营类目", "主推类目", "达人类型", "达人分类", "category",
              "categories", "niche", "tags"],
    "company": ["公司", "company"],
    "last_order": ["最近订单", "lastorder"],
    "notes": ["备注", "简介", "达人简介", "个人简介", "bio", "notes", "signature"],
}
NORM = {re.sub(r"\s+", "", a.lower()): field for field, names in ALIASES.items() for a in names}
EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
METRICS_MAX = 20


def norm(h):
    return re.sub(r"\s+", "", str(h or "").strip().lower()).lstrip("*")


def read_table(name, raw):
    """Rows of strings from an xlsx or csv upload."""
    if name.lower().endswith(".csv"):
        for enc in ("utf-8-sig", "gb18030"):
            try:
                text = raw.decode(enc)
                break
            except UnicodeDecodeError:
                continue
        else:
            raise ValueError("CSV 编码认不出来，请另存为 UTF-8")
        return [[c.strip() for c in r] for r in csv.reader(io.StringIO(text))]
    wb = openpyxl.load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
    return [["" if v is None else str(v).strip() for v in r] for r in wb.active.iter_rows(values_only=True)]


def parse(name, raw):
    """Contact dicts (raw strings) plus how the headers were understood."""
    rows = read_table(name, raw)
    # Exports often start with a title row; the header is the first row with at least two known columns.
    head_at = next((i for i, r in enumerate(rows[:6]) if sum(norm(h) in NORM for h in r) >= 2), None)
    if head_at is None:
        raise ValueError("认不出表头：至少要有「昵称 / 称呼」「账号」「粉丝数」「邮箱」这类列里的两列")
    head = rows[head_at]
    mapping, extra = {}, []
    for i, h in enumerate(head):
        field = NORM.get(norm(h))
        if field and field not in mapping.values():
            mapping[i] = field
        elif h:
            extra.append((i, h))
    out = []
    for r in rows[head_at + 1:]:
        if not any(r):
            continue
        item = {f: (r[i] if i < len(r) else "") for i, f in mapping.items()}
        metrics = {h: r[i] for i, h in extra[:METRICS_MAX] if i < len(r) and r[i] not in ("", "-", "--")}
        m = EMAIL_RE.search(item.get("email", ""))
        item["email"] = m.group(0).lower() if m else ""
        item["metrics"] = {k: v[:80] for k, v in metrics.items()}
        out.append(item)
    return out, {"columns": sorted(set(mapping.values())), "extra": [h for _, h in extra[:METRICS_MAX]]}


SCORE_PROMPT = """你在帮「{name}」筛选合作推广的达人（寄样测评、带货）。

【公司和产品】
{company}

【理想达人画像（运营填写）】
- 目标国家 / 地区：{countries}
- 领域：{niches}
- 粉丝数：{fmin} 到 {fmax}
- 其他要求：{notes}

【候选达人】
{contact}

按画像给这位达人打 0–100 分。最重要的是他的受众会不会买我们的产品（领域、内容和产品用途是否对口），其次是国家、粉丝量级，再看带货和互动数据（有的话）。
- 90 以上：非常对口，优先联系；70–89：对口；50–69：勉强；50 以下：不对口或明显不符合画像。
- 资料少就按已有信息保守打分，不要编造他的内容。
只输出 JSON：{{"score": 整数, "reason": "一句中文理由，说清加分点和减分点"}}"""


async def company_brief(tenant):
    b = tenant["brand"]
    qa = "\n".join(f"- {p}" for p in await grading.qa_pairs(tenant))
    return "\n".join(x for x in (f"{tenant['name']}：{b.get('lead') or b.get('welcome') or ''}", qa[:3000]) if x.strip())


def profile_text(contact):
    rows = [("称呼", contact["name"]), ("TikTok 账号", contact["handle"]), ("国家", contact["country"]), ("语言", contact["language"]),
            ("粉丝数", contact["followers"] or ""), ("领域 / 品类", contact["niche"]), ("简介 / 备注", contact["notes"])]
    rows += list(db.loads(contact["metrics"], {}).items())
    return "\n".join(f"- {k}：{v}" for k, v in rows if v)


async def score(tenant, contact, profile, company):
    data = await llm.chat_json([{"role": "user", "content": SCORE_PROMPT.format(
        name=tenant["name"], company=company or "（没有资料）", countries=profile.get("countries") or "不限",
        niches=profile.get("niches") or "和产品相关即可", fmin=profile.get("followers_min") or "不限",
        fmax=profile.get("followers_max") or "不限", notes=profile.get("notes") or "无", contact=profile_text(contact))}],
        tenant_id=tenant["id"], kind="score")
    try:
        value = max(0, min(100, int(data.get("score"))))
    except (TypeError, ValueError) as e:
        raise llm.LLMError("模型没有给出分数") from e
    reason = str(data.get("reason") or "").strip()[:300]
    db.x("UPDATE contacts SET score=:s, score_reason=:r, updated=:u WHERE id=:c", s=value, r=reason, u=db.now(), c=contact["id"])
    return value, reason
