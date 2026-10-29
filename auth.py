"""Passwords, sessions and request context (current user + current tenant)."""
import hashlib
import hmac
import secrets

from fastapi import HTTPException, Request

import db
import settings

COOKIE = "muxu_session"


def hash_password(pw):
    salt = secrets.token_bytes(16)
    h = hashlib.scrypt(pw.encode(), salt=salt, n=2 ** 14, r=8, p=1, dklen=32)
    return f"scrypt${salt.hex()}${h.hex()}"


def check_password(pw, stored):
    try:
        _, salt, h = stored.split("$")
        cand = hashlib.scrypt(pw.encode(), salt=bytes.fromhex(salt), n=2 ** 14, r=8, p=1, dklen=32)
        return hmac.compare_digest(cand.hex(), h)
    except (ValueError, TypeError):
        return False


def new_password():
    return secrets.token_urlsafe(9)


def start_session(user_id):
    token = secrets.token_urlsafe(32)
    db.x("DELETE FROM sessions WHERE expires < :t", t=db.now())
    db.insert(db.sessions, token=token, user_id=user_id, expires=db.now() + settings.SESSION_DAYS * 86400)
    db.x("UPDATE users SET last_login=:t WHERE id=:id", t=db.now(), id=user_id)
    return token


def load_tenant(row):
    if not row:
        return None
    t = dict(row)
    t["brand"] = db.loads(t["brand"], {})
    t["rag"] = db.loads(t["rag"], {})
    return t


def tenant_by_slug(slug):
    return load_tenant(db.q("SELECT * FROM tenants WHERE slug=:s", one=True, s=slug))


def tenant_by_id(tid):
    return load_tenant(db.q("SELECT * FROM tenants WHERE id=:i", one=True, i=tid))


def user_tenants(user):
    if user["is_platform_admin"]:
        rows = db.q("SELECT id, slug, name, status FROM tenants ORDER BY id")
        return [{**r, "role": "admin"} for r in rows]
    return db.q("SELECT t.id, t.slug, t.name, t.status, m.role FROM memberships m JOIN tenants t ON t.id=m.tenant_id "
                "WHERE m.user_id=:u ORDER BY t.id", u=user["id"])


def current_user(request: Request):
    token = request.cookies.get(COOKIE)
    row = token and db.q("SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=:t AND s.expires>:n",
                         one=True, t=token, n=db.now())
    if not row or row["status"] != "active":
        raise HTTPException(401, "请先登录")
    return {**row, "token": token}


def platform_admin(request: Request):
    user = current_user(request)
    if not user["is_platform_admin"]:
        raise HTTPException(403, "只有平台管理员可以操作")
    return user


class Ctx:
    def __init__(self, user, tenant, role):
        self.user, self.tenant, self.role = user, tenant, role

    @property
    def tid(self):
        return self.tenant["id"]

    def require_admin(self):
        if self.role != "admin":
            raise HTTPException(403, "需要这个客户的管理员权限")


def tenant_ctx(request: Request):
    """Every tenant-scoped console endpoint depends on this; it is the only place tenant access is decided."""
    user = current_user(request)
    slug = request.headers.get("x-tenant") or request.query_params.get("tenant") or ""
    tenant = tenant_by_slug(slug)
    if not tenant:
        raise HTTPException(404, "没有这个客户")
    if user["is_platform_admin"]:
        role = "admin"
    else:
        m = db.q("SELECT role FROM memberships WHERE user_id=:u AND tenant_id=:t", one=True, u=user["id"], t=tenant["id"])
        if not m:
            raise HTTPException(403, "你没有这个客户的权限")
        role = m["role"]
    return Ctx(user, tenant, role)
