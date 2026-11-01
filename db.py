"""Schema and small query helpers. Works on SQLite (dev) and PostgreSQL (DATABASE_URL)."""
import json
import time

from sqlalchemy import (Boolean, Column, Float, ForeignKey, Index, Integer, MetaData, PrimaryKeyConstraint, String, Table,
                        Text, UniqueConstraint, create_engine, event, inspect, text)

import settings

engine = create_engine(
    settings.DATABASE_URL,
    pool_pre_ping=True,
    connect_args={"check_same_thread": False} if settings.DATABASE_URL.startswith("sqlite") else {},
)

if settings.DATABASE_URL.startswith("sqlite"):
    @event.listens_for(engine, "connect")
    def _sqlite_pragmas(conn, _):
        cur = conn.cursor()
        cur.execute("PRAGMA journal_mode=WAL")
        cur.execute("PRAGMA foreign_keys=ON")
        cur.close()

meta = MetaData()

tenants = Table(
    "tenants", meta,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("slug", String(40), nullable=False, unique=True),
    Column("name", String(80), nullable=False),
    Column("status", String(16), nullable=False, default="active"),   # active | disabled
    Column("brand", Text, nullable=False, default="{}"),
    Column("rag", Text, nullable=False, default="{}"),
    Column("rules", Text, nullable=False, default=""),
    Column("empty_response", Text, nullable=False, default=""),
    Column("truth_extra", Text, nullable=False, default=""),
    Column("live", String(16), nullable=False, default="main"),
    Column("quota_month", Integer, nullable=False, default=0),         # customer questions per month, 0 = unlimited
    Column("created", Float, nullable=False),
)

users = Table(
    "users", meta,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("email", String(120), nullable=False, unique=True),
    Column("name", String(60), nullable=False, default=""),
    Column("password_hash", String(255), nullable=False),
    Column("is_platform_admin", Boolean, nullable=False, default=False),
    Column("status", String(16), nullable=False, default="active"),
    Column("must_change_password", Boolean, nullable=False, default=True),
    Column("created", Float, nullable=False),
    Column("last_login", Float),
)

memberships = Table(
    "memberships", meta,
    Column("user_id", Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
    Column("tenant_id", Integer, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False),
    Column("role", String(16), nullable=False, default="operator"),    # admin | operator
    PrimaryKeyConstraint("user_id", "tenant_id"),
)

sessions = Table(
    "sessions", meta,
    Column("token", String(64), primary_key=True),
    Column("user_id", Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
    Column("expires", Float, nullable=False),
)

tests = Table(
    "tests", meta,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("tenant_id", Integer, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True),
    Column("code", String(16), nullable=False),
    Column("type", String(16), nullable=False),
    Column("q", Text, nullable=False),
    Column("expect", String(16), nullable=False),
    Column("points", Text, nullable=False, default=""),
    Column("source", String(16), nullable=False, default="手动"),
    Column("created", Float, nullable=False),
    UniqueConstraint("tenant_id", "code"),
)

runs = Table(
    "runs", meta,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("tenant_id", Integer, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True),
    Column("assistant", String(16), nullable=False),
    Column("label", String(60), nullable=False),
    Column("grader", String(80), nullable=False),
    Column("status", String(16), nullable=False),
    Column("total", Integer, nullable=False),
    Column("done", Integer, nullable=False, default=0),
    Column("created", Float, nullable=False),
    Column("finished", Float),
    Column("error", Text),
)

results = Table(
    "results", meta,
    Column("run_id", Integer, ForeignKey("runs.id", ondelete="CASCADE"), nullable=False),
    Column("test_code", String(16), nullable=False),
    Column("test_type", String(16), nullable=False),
    Column("test_q", Text, nullable=False),
    Column("test_expect", String(16), nullable=False),
    Column("test_points", Text, nullable=False, default=""),
    Column("answer", Text, nullable=False, default=""),
    Column("refs", Text, nullable=False, default="[]"),
    Column("seconds", Float, nullable=False, default=0),
    Column("verdict", String(16), nullable=False),
    Column("reason", Text, nullable=False, default=""),
    Column("auto_verdict", String(16)),
    Column("manual", Boolean, nullable=False, default=False),
    PrimaryKeyConstraint("run_id", "test_code"),
)

messages = Table(
    "messages", meta,
    Column("id", String(32), primary_key=True),
    Column("tenant_id", Integer, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True),
    Column("session_id", String(64), nullable=False),
    Column("assistant", String(16), nullable=False),
    Column("question", Text, nullable=False),
    Column("answer", Text, nullable=False, default=""),
    Column("refs", Text, nullable=False, default="[]"),
    Column("seconds", Float, nullable=False, default=0),
    Column("status", String(16), nullable=False),
    Column("handoff", Boolean, nullable=False, default=False),
    Column("chars", Integer, nullable=False, default=0),
    Column("channel", String(16), nullable=False),                  # web | console | a Chatwoot channel (whatsapp, email...)
    Column("created", Float, nullable=False, index=True),
)

feedback = Table(
    "feedback", meta,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("tenant_id", Integer, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True),
    Column("message_id", String(32), nullable=False, unique=True),
    Column("rating", String(8), nullable=False),
    Column("comment", Text, nullable=False, default=""),
    Column("created", Float, nullable=False),
)

handoffs = Table(
    "handoffs", meta,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("tenant_id", Integer, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True),
    Column("session_id", String(64), nullable=False),
    Column("name", String(60), nullable=False, default=""),
    Column("phone", String(30), nullable=False),
    Column("note", Text, nullable=False, default=""),
    Column("question", Text, nullable=False, default=""),
    Column("status", String(16), nullable=False, default="新"),
    Column("chatwoot_url", String(300), nullable=False, default=""),  # set = handed off inside a Chatwoot conversation
    Column("created", Float, nullable=False),
)

chatwoot_links = Table(
    "chatwoot_links", meta,
    Column("tenant_id", Integer, ForeignKey("tenants.id", ondelete="CASCADE"), primary_key=True),
    Column("account_id", Integer, nullable=False),
    Column("bot_id", Integer, nullable=False),
    Column("hook_token", String(64), nullable=False, unique=True),
    Column("enabled", Boolean, nullable=False, default=True),        # off = new conversations go straight to people
    # off = keyword routing + RAGFlow; shadow = that, plus agent.py decides in the background without acting;
    # router = Jev routing + RAGFlow answers; agent = Jev routing + the reply agent
    Column("agent_mode", String(8), nullable=False, default="shadow"),
    Column("created", Float, nullable=False),
)
# Per inbox: whether new conversations start hosted by the AI.
cw_inboxes = Table(
    "cw_inboxes", meta,
    Column("tenant_id", Integer, ForeignKey("tenants.id", ondelete="CASCADE"), primary_key=True),
    Column("inbox_id", Integer, primary_key=True),
    Column("hosted", Boolean, nullable=False, default=True),
)
# Our state for a Chatwoot conversation. `mode` is the source of truth; Chatwoot's status follows it (ai = pending, human = open).
cw_convs = Table(
    "cw_convs", meta,
    Column("tenant_id", Integer, ForeignKey("tenants.id", ondelete="CASCADE"), primary_key=True),
    Column("conv_id", Integer, primary_key=True),                     # Chatwoot display_id
    Column("inbox_id", Integer, nullable=False, default=0),
    Column("channel", String(16), nullable=False, default=""),
    Column("contact_id", Integer),                                    # contacts.id of the customer
    Column("mode", String(8), nullable=False, default="ai"),          # ai | human
    Column("status", String(10), nullable=False, default="pending"),  # Chatwoot's: pending | open | resolved | snoozed
    Column("outreach", Boolean, nullable=False, default=False),       # started by 外联: replies go to the outreach flow
    Column("stage", String(16), nullable=False, default=""),          # AI's read of where the deal is
    Column("summary", Text, nullable=False, default=""),
    Column("next_step", Text, nullable=False, default=""),
    Column("summarized", Float),
    Column("last_in", Float),                                         # customer's latest message
    Column("last_out", Float),                                        # our latest reply (AI or people)
    Column("followups", Integer, nullable=False, default=0),          # AI follow-ups since the customer last wrote
    Column("updated", Float, nullable=False),
)
cw_drafts = Table(
    "cw_drafts", meta,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("tenant_id", Integer, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True),
    Column("conv_id", Integer, nullable=False, index=True),
    Column("channel", String(16), nullable=False, default=""),
    Column("kind", String(8), nullable=False),                        # 回复 | 跟进
    Column("question", Text, nullable=False, default=""),
    Column("text", Text, nullable=False, default=""),
    Column("note", Text, nullable=False, default=""),                 # why it needs review, what to check
    Column("status", String(8), nullable=False),                      # 生成中 | 待审核 | 已发送 | 已丢弃 | 失败
    Column("handled_by", String(60), nullable=False, default=""),
    Column("created", Float, nullable=False),
    Column("updated", Float, nullable=False),
)

# One decision by agent.py on a customer message: routing, tool steps, checks and what was done (or, in shadow mode, would have been).
agent_runs = Table(
    "agent_runs", meta,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("tenant_id", Integer, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True),
    Column("conv_id", Integer, nullable=False, index=True),
    Column("channel", String(16), nullable=False, default=""),
    Column("mode", String(8), nullable=False),                        # shadow | router | agent | suggest
    Column("question", Text, nullable=False, default=""),
    Column("intent", String(16), nullable=False, default=""),
    Column("route", Text, nullable=False, default="{}"),              # intent, probabilities, angry, by, path
    Column("steps", Text, nullable=False, default="[]"),              # tool calls and what they returned
    Column("reply", Text, nullable=False, default=""),
    Column("checks", Text, nullable=False, default="[]"),             # failed checks, in Chinese
    Column("action", String(8), nullable=False, default=""),          # send | review | handoff | ignore
    Column("actual", String(8), nullable=False, default=""),          # shadow mode: what the live pipeline did
    Column("ms", Integer, nullable=False, default=0),
    Column("created", Float, nullable=False, index=True),
)

# A personal account (Telegram / WhatsApp / Instagram) logged in through personal.py, shown in Chatwoot as an API inbox.
# Sessions and API keys live in data/personal/{id}/ (600), never in the database.
personal_accounts = Table(
    "personal_accounts", meta,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("tenant_id", Integer, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True),
    Column("platform", String(16), nullable=False),                   # telegram | whatsapp | instagram | wecom
    Column("name", String(80), nullable=False, default=""),
    Column("handle", String(120), nullable=False, default=""),        # phone number or username once logged in
    Column("inbox_id", Integer, nullable=False, default=0),
    Column("hook_token", String(64), nullable=False, unique=True),
    Column("status", String(16), nullable=False, default="待登录"),   # 待登录 | 在线 | 断开 | 需要重新登录
    Column("error", Text, nullable=False, default=""),
    Column("since", Float, nullable=False, default=0),                # messages older than this are history, not forwarded
    Column("created", Float, nullable=False),
    Column("updated", Float, nullable=False),
)

# Who an account talks to: the platform's id for the chat and the Chatwoot contact standing for them.
personal_peers = Table(
    "personal_peers", meta,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("account_id", Integer, ForeignKey("personal_accounts.id", ondelete="CASCADE"), nullable=False),
    Column("peer", String(120), nullable=False),
    Column("name", String(200), nullable=False, default=""),
    Column("contact_id", Integer, nullable=False, default=0),
    Column("conv_id", Integer, nullable=False, default=0),
    Column("last_in", Float, nullable=False, default=0),              # when they last wrote; 企业微信 only allows replies for 48 h
    Column("sent", Integer, nullable=False, default=0),               # our messages since then; 企业微信 allows 5
    Column("created", Float, nullable=False),
    UniqueConstraint("account_id", "peer"),
)

gaps = Table(
    "gaps", meta,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("tenant_id", Integer, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True),
    Column("source", String(16), nullable=False),
    Column("ref", String(64), nullable=False, default=""),
    Column("assistant", String(16), nullable=False, default=""),
    Column("question", Text, nullable=False),
    Column("bot_answer", Text, nullable=False, default=""),
    Column("kind", String(120), nullable=False),
    Column("draft", Text, nullable=False, default=""),
    Column("draft_source", Text, nullable=False, default=""),
    Column("status", String(16), nullable=False, default="待处理"),
    Column("handler", String(60), nullable=False, default=""),
    Column("writeback_id", String(80), nullable=False, default=""),
    Column("created", Float, nullable=False),
    Column("updated", Float, nullable=False),
)

contacts = Table(
    "contacts", meta,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("tenant_id", Integer, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True),
    Column("kind", String(16), nullable=False),                       # 达人 | B端客户 | 买家
    Column("name", String(120), nullable=False),
    Column("handle", String(120), nullable=False, default=""),        # TikTok @handle
    Column("profile_url", String(300), nullable=False, default=""),
    Column("country", String(60), nullable=False, default=""),
    Column("language", String(30), nullable=False, default=""),
    Column("followers", Integer, nullable=False, default=0),
    Column("niche", String(120), nullable=False, default=""),
    Column("company", String(120), nullable=False, default=""),
    Column("last_order", Text, nullable=False, default=""),
    Column("notes", Text, nullable=False, default=""),
    Column("status", String(16), nullable=False, default="未联系"),
    Column("followups", Integer, nullable=False, default=0),
    Column("followup_at", Float),
    Column("persona", Text, nullable=False, default=""),             # non-empty = 演练联系人, replies are role-played
    Column("inbox_token", String(40), nullable=False, default=""),   # non-empty = 体验联系人, a person reads /muxu/inbox/{token}
    Column("auto_send", Boolean, nullable=False, default=False),     # 体验联系人: send AI drafts without review
    Column("email", String(200), nullable=False, default=""),        # set = outreach goes by email (autopilot can send)
    Column("phone", String(40), nullable=False, default=""),
    Column("cw_contact_id", Integer),                                 # the same person in Chatwoot

    Column("source", String(40), nullable=False, default=""),        # where the row came from, e.g. FastMoss
    Column("score", Integer),                                         # AI fit score 0-100 against the creator profile
    Column("score_reason", Text, nullable=False, default=""),
    Column("metrics", Text, nullable=False, default="{}"),           # extra columns from data tools: GMV, avg views...
    Column("created", Float, nullable=False),
    Column("updated", Float, nullable=False),
)

outreach = Table(
    "outreach", meta,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("tenant_id", Integer, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True),
    Column("contact_id", Integer, ForeignKey("contacts.id", ondelete="CASCADE"), nullable=False, index=True),
    Column("scenario", String(16), nullable=False),                   # 达人建联 | 老客户复购 | 售后回访
    Column("step", String(16), nullable=False),                       # 首次 | 跟进 | 回复 | 对方
    Column("text", Text, nullable=False, default=""),
    Column("note", Text, nullable=False, default=""),                 # AI's note to the reviewer
    Column("needs_human", Boolean, nullable=False, default=False),
    Column("status", String(16), nullable=False),                     # 生成中 | 待审核 | 待发送 | 已发送 | 已拒绝 | 失败 | 已收到
    Column("created_by", String(60), nullable=False, default=""),
    Column("approved_by", String(60), nullable=False, default=""),
    Column("channel", String(12), nullable=False, default="tiktok"),  # tiktok (sent by hand) | email
    Column("subject", String(200), nullable=False, default=""),
    Column("mail_id", String(250), nullable=False, default=""),       # Message-ID of a sent or received email
    Column("edited", Boolean, nullable=False, default=False),         # reviewer changed the AI draft
    Column("created", Float, nullable=False),
    Column("sent_at", Float),
)

pilot_events = Table(
    "pilot_events", meta,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("tenant_id", Integer, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True),
    Column("kind", String(16), nullable=False),                       # 评分 | 起草 | 发送 | 收到 | 退订 | 出错
    Column("text", Text, nullable=False),
    Column("created", Float, nullable=False, index=True),
)

outreach_cfg = Table(
    "outreach_cfg", meta,
    Column("tenant_id", Integer, ForeignKey("tenants.id", ondelete="CASCADE"), primary_key=True),
    Column("data", Text, nullable=False, default="{}"),
)

# 带货视频（video.py）. Files live in data/video/{tid}/; provider keys in data/video/{tid}/keys.json (600), never here.
video_cfg = Table(
    "video_cfg", meta,
    Column("tenant_id", Integer, ForeignKey("tenants.id", ondelete="CASCADE"), primary_key=True),
    Column("data", Text, nullable=False, default="{}"),
)
video_assets = Table(
    "video_assets", meta,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("tenant_id", Integer, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True),
    Column("kind", String(12), nullable=False),                       # photo | footage | logo | avatar | music
    Column("name", String(120), nullable=False, default=""),
    Column("tag", String(80), nullable=False, default=""),            # product model, e.g. COG-2
    Column("file", String(80), nullable=False),
    Column("size", Integer, nullable=False, default=0),
    Column("width", Integer, nullable=False, default=0),
    Column("height", Integer, nullable=False, default=0),
    Column("seconds", Float, nullable=False, default=0),
    Column("source", String(16), nullable=False, default=""),         # 实拍 | 官网 | 达人 | AI
    Column("consent", Text, nullable=False, default=""),              # avatar / music: who agreed, for what, until when
    Column("created_by", String(60), nullable=False, default=""),
    Column("created", Float, nullable=False),
    # generated images: the prompt and model; AI product images wait for a person to check the product ("待审核" → "")
    Column("prompt", Text, nullable=False, default=""),
    Column("model", String(80), nullable=False, default=""),
    Column("review", String(8), nullable=False, default=""),
    Column("ref_id", Integer),                                        # the product photo an AI product image was made from
)
video_projects = Table(
    "video_projects", meta,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("tenant_id", Integer, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True),
    Column("title", String(120), nullable=False, default=""),
    Column("kind", String(8), nullable=False),                        # scene | avatar
    Column("brief", Text, nullable=False, default="{}"),
    Column("script", Text, nullable=False, default="{}"),             # hooks, segments with facts and issues
    # 写脚本中 | 脚本 | 出分镜中 | 分镜 | 生成中 | 有失败 | 合成中 | 待审核 | 已通过 | 打回 | 出错
    Column("status", String(16), nullable=False),
    Column("error", Text, nullable=False, default=""),
    Column("created_by", Integer, nullable=False, default=0),
    Column("created_name", String(60), nullable=False, default=""),
    Column("created", Float, nullable=False),
    Column("updated", Float, nullable=False),
)
video_shots = Table(
    "video_shots", meta,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("project_id", Integer, ForeignKey("video_projects.id", ondelete="CASCADE"), nullable=False, index=True),
    Column("tenant_id", Integer, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True),
    Column("idx", Integer, nullable=False, default=0),
    Column("seg", Integer, nullable=False, default=0),                # script segment; -1 = the avatar's full take
    Column("kind", String(8), nullable=False),                        # photo | motion | scene | footage | card | avatar
    Column("seconds", Float, nullable=False, default=3),
    Column("asset_id", Integer),
    Column("model", String(80), nullable=False, default=""),
    Column("prompt", Text, nullable=False, default=""),
    Column("card", Text, nullable=False, default="{}"),               # card shots: title, lines
    Column("status", String(10), nullable=False, default=""),         # "" | 排队 | 生成中 | 完成 | 失败
    Column("job_id", String(80), nullable=False, default=""),
    Column("tries", Integer, nullable=False, default=0),
    Column("cost", Float, nullable=False, default=0),
    Column("error", Text, nullable=False, default=""),
    Column("file", String(80), nullable=False, default=""),
    Column("updated", Float, nullable=False),
)
video_renders = Table(
    "video_renders", meta,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("project_id", Integer, ForeignKey("video_projects.id", ondelete="CASCADE"), nullable=False, index=True),
    Column("tenant_id", Integer, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True),
    Column("file", String(80), nullable=False),
    Column("seconds", Float, nullable=False, default=0),
    Column("content_id", String(40), nullable=False),                 # written into the file's AIGC metadata
    Column("status", String(10), nullable=False),                     # 待审核 | 已通过 | 打回
    Column("review", Text, nullable=False, default="{}"),
    Column("created_by", Integer, nullable=False, default=0),
    Column("reviewer", String(60), nullable=False, default=""),
    Column("created", Float, nullable=False),
    Column("reviewed", Float),
    Column("engine", String(12), nullable=False, default="ffmpeg"),   # ffmpeg | remotion
    Column("timeline", Text, nullable=False, default="{}"),           # remotion: the timeline JSON that was rendered
    Column("notes", Text, nullable=False, default=""),                # the director's notes
)
video_costs = Table(
    "video_costs", meta,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("tenant_id", Integer, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True),
    Column("project_id", Integer, nullable=False, default=0),
    Column("shot_id", Integer, nullable=False, default=0),
    Column("model", String(80), nullable=False),
    Column("seconds", Float, nullable=False, default=0),
    Column("amount", Float, nullable=False, default=0),               # USD, as billed by OpenRouter
    Column("created", Float, nullable=False, index=True),
)

# 网站 SEO / GEO（seo.py）. The site's stats key lives in data/seo/{tid}/stats.key (600), never here.
seo_cfg = Table(
    "seo_cfg", meta,
    Column("tenant_id", Integer, ForeignKey("tenants.id", ondelete="CASCADE"), primary_key=True),
    Column("data", Text, nullable=False, default="{}"),
    Column("state", Text, nullable=False, default="{}"),              # sync cursor and last error, written by the loop
)
site_hits = Table(
    "site_hits", meta,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("tenant_id", Integer, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False),
    Column("site", String(120), nullable=False),                      # host the row came from
    Column("rid", Integer, nullable=False),                           # row id on the site's D1
    Column("ts", Float, nullable=False),
    Column("day", String(10), nullable=False),                        # UTC date, the visitor hash rotates with it
    Column("k", String(4), nullable=False),                           # pv | ev | end | bot
    Column("path", String(200), nullable=False, default=""),
    Column("ref", String(120), nullable=False, default=""),           # referrer host
    Column("cc", String(2), nullable=False, default=""),
    Column("dev", String(8), nullable=False, default=""),
    Column("lang", String(12), nullable=False, default=""),
    Column("vid", String(16), nullable=False, default=""),
    Column("name", String(40), nullable=False, default=""),           # event name, or the crawler's name
    Column("utm", String(60), nullable=False, default=""),
    Column("secs", Integer),
    Column("status", Integer),
    UniqueConstraint("tenant_id", "site", "rid"),
)
Index("ix_site_hits_tday", site_hits.c.tenant_id, site_hits.c.day, site_hits.c.k)
seo_audits = Table(
    "seo_audits", meta,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("tenant_id", Integer, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True),
    Column("site", String(200), nullable=False),
    Column("status", String(8), nullable=False),                      # 进行中 | 完成 | 出错
    Column("seo", Integer),
    Column("geo", Integer),
    Column("data", Text, nullable=False, default="{}"),
    Column("error", Text, nullable=False, default=""),
    Column("by", String(60), nullable=False, default=""),
    Column("created", Float, nullable=False),
    Column("finished", Float),
)
geo_runs = Table(
    "geo_runs", meta,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("tenant_id", Integer, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True),
    Column("status", String(8), nullable=False),                      # 进行中 | 完成 | 出错
    Column("asked", Integer, nullable=False, default=0),
    Column("mentioned", Integer, nullable=False, default=0),
    Column("cited", Integer, nullable=False, default=0),
    Column("cost", Float, nullable=False, default=0),
    Column("error", Text, nullable=False, default=""),
    Column("by", String(60), nullable=False, default=""),
    Column("created", Float, nullable=False),
    Column("finished", Float),
)
geo_answers = Table(
    "geo_answers", meta,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("run_id", Integer, ForeignKey("geo_runs.id", ondelete="CASCADE"), nullable=False, index=True),
    Column("tenant_id", Integer, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False, index=True),
    Column("question", Text, nullable=False),
    Column("qkind", String(8), nullable=False, default=""),
    Column("lang", String(8), nullable=False, default=""),
    Column("engine", String(60), nullable=False),
    Column("mentioned", Boolean, nullable=False, default=False),
    Column("cited", Boolean, nullable=False, default=False),
    Column("position", Integer),                                      # our rank among the brands named, 1 = first
    Column("brands", Text, nullable=False, default="[]"),
    Column("citations", Text, nullable=False, default="[]"),
    Column("answer", Text, nullable=False, default=""),
    Column("cost", Float, nullable=False, default=0),
    Column("error", Text, nullable=False, default=""),
    Column("created", Float, nullable=False),
)
# Google Search Console / Bing Webmaster (search.py); credentials live in data/seo/{tid}/google.json and bing.key (600).
search_rows = Table(
    "search_rows", meta,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("tenant_id", Integer, ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False),
    Column("engine", String(8), nullable=False),                      # google | bing
    Column("day", String(10), nullable=False),                        # Bing query / page rows are weekly buckets
    Column("kind", String(8), nullable=False),                        # total | query | page | country | device
    Column("key", String(300), nullable=False, default=""),
    Column("clicks", Integer, nullable=False, default=0),
    Column("impressions", Integer, nullable=False, default=0),
    Column("pos_sum", Float, nullable=False, default=0),              # average position × impressions
)
Index("ix_search_rows_t", search_rows.c.tenant_id, search_rows.c.engine, search_rows.c.day)

llm_usage = Table(
    "llm_usage", meta,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("tenant_id", Integer, ForeignKey("tenants.id", ondelete="CASCADE"), index=True),
    Column("kind", String(16), nullable=False),                     # judge | draft | testgen
    Column("model", String(80), nullable=False),
    Column("prompt_tokens", Integer, nullable=False, default=0),
    Column("completion_tokens", Integer, nullable=False, default=0),
    Column("created", Float, nullable=False, index=True),
)


def init():
    meta.create_all(engine)
    # create_all never alters existing tables; add columns introduced after a table was first created.
    added = {
        "contacts": {"persona": "TEXT NOT NULL DEFAULT ''", "inbox_token": "VARCHAR(40) NOT NULL DEFAULT ''",
                     "auto_send": "BOOLEAN NOT NULL DEFAULT FALSE", "email": "VARCHAR(200) NOT NULL DEFAULT ''",
                     "source": "VARCHAR(40) NOT NULL DEFAULT ''", "score": "INTEGER",
                     "score_reason": "TEXT NOT NULL DEFAULT ''", "metrics": "TEXT NOT NULL DEFAULT '{}'",
                     "phone": "VARCHAR(40) NOT NULL DEFAULT ''", "cw_contact_id": "INTEGER"},
        "outreach": {"channel": "VARCHAR(12) NOT NULL DEFAULT 'tiktok'", "subject": "VARCHAR(200) NOT NULL DEFAULT ''",
                     "mail_id": "VARCHAR(250) NOT NULL DEFAULT ''", "edited": "BOOLEAN NOT NULL DEFAULT FALSE"},
        "handoffs": {"chatwoot_url": "VARCHAR(300) NOT NULL DEFAULT ''"},
        "chatwoot_links": {"agent_mode": "VARCHAR(8) NOT NULL DEFAULT 'shadow'"},
        "personal_peers": {"last_in": "FLOAT NOT NULL DEFAULT 0", "sent": "INTEGER NOT NULL DEFAULT 0"},
        "video_renders": {"engine": "VARCHAR(12) NOT NULL DEFAULT 'ffmpeg'", "timeline": "TEXT NOT NULL DEFAULT '{}'",
                          "notes": "TEXT NOT NULL DEFAULT ''"},
        "video_assets": {"prompt": "TEXT NOT NULL DEFAULT ''", "model": "VARCHAR(80) NOT NULL DEFAULT ''",
                         "review": "VARCHAR(8) NOT NULL DEFAULT ''", "ref_id": "INTEGER"},
    }
    with engine.begin() as c:
        for table, cols in added.items():
            have = {col["name"] for col in inspect(c).get_columns(table)}
            for name, ddl in cols.items():
                if name not in have:
                    c.execute(text(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}"))


def now():
    return time.time()


def q(sql, one=False, **params):
    with engine.connect() as c:
        rows = [dict(r._mapping) for r in c.execute(text(sql), params)]
    return (rows[0] if rows else None) if one else rows


def x(sql, **params):
    with engine.begin() as c:
        return c.execute(text(sql), params).rowcount


def insert(table, **values):
    with engine.begin() as c:
        res = c.execute(table.insert().values(**values))
        pk = res.inserted_primary_key
        return pk[0] if pk and len(pk) == 1 else None


def scalar(sql, **params):
    with engine.connect() as c:
        return c.execute(text(sql), params).scalar()


def loads(s, default=None):
    try:
        return json.loads(s) if s else default
    except ValueError:
        return default


def dumps(obj):
    return json.dumps(obj, ensure_ascii=False)
