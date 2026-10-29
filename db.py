"""Schema and small query helpers. Works on SQLite (dev) and PostgreSQL (DATABASE_URL)."""
import json
import time

from sqlalchemy import (Boolean, Column, Float, ForeignKey, Integer, MetaData, PrimaryKeyConstraint, String, Table,
                        Text, UniqueConstraint, create_engine, event, text)

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
    Column("channel", String(16), nullable=False),                  # web | console
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
    Column("created", Float, nullable=False),
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
