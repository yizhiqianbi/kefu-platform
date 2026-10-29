"""Move one tenant to another server: platform rows plus its RAGFlow datasets and assistants.

    python3 migrate.py export <客户代号> [输出文件]      # 旧服务器
    python3 migrate.py import <导出文件> [--slug 新代号]  # 新服务器，RAGFlow 里要先配好对话模型和向量模型
    python3 migrate.py remove <客户代号> --yes           # 删掉一个客户（导入失败后重来用）

The export is the parsed knowledge, not just the files: 资料库 chunks are written back as-is, so the new server
needs no OCR and answers from exactly the same text. 问答库 spreadsheets are re-parsed (fast and lossless).
The file holds customer data and password hashes; keep it chmod 600 and delete it after importing.
"""
import asyncio
import fcntl
import json
import os
import re
import shutil
import sys
import tarfile
import tempfile
import time
import uuid
from pathlib import Path

from sqlalchemy import Boolean

import db
import engine
import settings

VERSION = 1
TABLES = ["tests", "runs", "messages", "feedback", "handoffs", "gaps", "contacts", "outreach", "outreach_cfg", "llm_usage"]
CHAT_FIELDS = ["similarity_threshold", "vector_similarity_weight", "top_n", "llm_setting", "prompt_config"]


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


async def download(dataset_id, doc_id):
    r = await engine.http.get(f"{settings.RAGFLOW_URL}/datasets/{dataset_id}/documents/{doc_id}",
                              headers=engine._headers(), timeout=600)
    if r.status_code != 200 or r.headers.get("content-type", "").startswith("application/json"):
        raise engine.EngineError(f"下载文件失败：{r.text[:200]}")
    return r.content


# ---------- export ----------

async def export(slug, out):
    t = db.q("SELECT * FROM tenants WHERE slug=:s", one=True, s=slug)
    if not t:
        sys.exit(f"没有客户 {slug}")
    rag = db.loads(t["rag"], {})
    work = Path(tempfile.mkdtemp(prefix="kefu-export-"))
    try:
        manifest = {"version": VERSION, "exported": time.time(), "slug": slug,
                    "tenant": {k: v for k, v in t.items() if k not in ("id", "rag")},
                    "users": db.q("SELECT u.email, u.name, u.password_hash, u.status, u.must_change_password, u.created, "
                                  "m.role FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.tenant_id=:t", t=t["id"]),
                    "tables": {}, "datasets": {}, "chats": {}}
        for name in TABLES:
            manifest["tables"][name] = db.q(f"SELECT * FROM {name} WHERE tenant_id=:t", t=t["id"])
        run_ids = [r["id"] for r in manifest["tables"]["runs"]] or [-1]
        manifest["tables"]["results"] = db.q(f"SELECT * FROM results WHERE run_id IN ({','.join(map(str, run_ids))})")

        n = 0
        for role, ds_id in rag["datasets"].items():
            ds = (await engine.call("GET", "/datasets", params={"id": ds_id}))[0]
            entries = []
            for d in await engine._paged(f"/datasets/{ds_id}/documents", "docs", orderby="create_time", desc="false"):
                n += 1
                fname = f"files/{n:04d}{Path(d['name']).suffix}"
                (work / "files").mkdir(exist_ok=True)
                (work / fname).write_bytes(await download(ds_id, d["id"]))
                wb = d["id"] == rag.get("writeback_doc")
                chunks = [{"id": c["id"], "content": c.get("content") or "", "questions": c.get("questions") or [],
                           "important_keywords": c.get("important_keywords") or [], "available": c.get("available", True)}
                          for c in await engine._paged(f"/datasets/{ds_id}/documents/{d['id']}/chunks", "chunks", 100000)]
                reparse = role == "qa" and not wb and d.get("run") == "DONE"
                entries.append({"name": d["name"], "file": fname, "chunk_method": d.get("chunk_method") or ds["chunk_method"],
                                "writeback": wb, "reparse": reparse, "chunks": [] if reparse else chunks,
                                "chunk_count": len(chunks)})
                log(f"{role} {d['name']}  {len(chunks)} 段")
            manifest["datasets"][role] = {"id": ds_id, "chunk_method": ds["chunk_method"], "docs": entries}

        roles = {v: k for k, v in rag["datasets"].items()}
        for key, a in rag.get("assistants", {}).items():
            chat = await engine.call("GET", f"/chats/{a['chat_id']}")
            manifest["chats"][key] = {"label": a.get("label", ""), "threshold": a.get("threshold", 0.2),
                                      "datasets": [roles[i] for i in a["dataset_ids"]], "name": chat["name"],
                                      **{f: chat.get(f) for f in CHAT_FIELDS}}

        (work / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False))
        old_umask = os.umask(0o077)
        try:
            with tarfile.open(out, "w:gz") as tar:
                for p in sorted(work.rglob("*")):
                    tar.add(p, arcname=str(p.relative_to(work)), recursive=False)
        finally:
            os.umask(old_umask)
        os.chmod(out, 0o600)
        docs = sum(len(d["docs"]) for d in manifest["datasets"].values())
        log(f"导出完成：{out}（{Path(out).stat().st_size / 1e6:.0f} MB，{docs} 份文件，"
            f"{len(manifest['tables']['tests'])} 道测试题，{len(manifest['users'])} 个账号）")
    finally:
        shutil.rmtree(work, ignore_errors=True)


# ---------- import ----------

def fix_types(table, row):
    for col in table.columns:
        if col.name in row and isinstance(col.type, Boolean) and row[col.name] is not None:
            row[col.name] = bool(row[col.name])
    return row


async def wait_parsed(dataset_id, doc_ids, timeout=3600):
    t0 = time.time()
    while time.time() - t0 < timeout:
        docs = {d["id"]: d for d in await engine.list_docs(dataset_id)}
        left = [i for i in doc_ids if docs.get(i, {}).get("run") not in ("DONE", "FAIL")]
        if not left:
            failed = [docs[i]["name"] for i in doc_ids if docs[i]["run"] == "FAIL"]
            if failed:
                raise engine.EngineError(f"解析失败：{', '.join(failed)}")
            return
        await asyncio.sleep(5)
    raise engine.EngineError("解析超时")


async def import_(path, slug=None):
    lock = open(settings.DATA_DIR / ".migrate.lock", "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        sys.exit("已经有一个导入在跑，等它结束再来")
    db.init()
    work = Path(tempfile.mkdtemp(prefix="kefu-import-"))
    try:
        with tarfile.open(path) as tar:
            try:
                tar.extractall(work, filter="data")
            except TypeError:  # Python without tarfile extraction filters
                for member in tar.getmembers():
                    if member.name.startswith(("/", "..")) or ".." in Path(member.name).parts or not (member.isfile() or member.isdir()):
                        sys.exit(f"导出文件里有可疑路径：{member.name}")
                tar.extractall(work)
        m = json.loads((work / "manifest.json").read_text())
        if m.get("version") != VERSION:
            sys.exit("导出文件版本不对")
        old, slug = m["slug"], slug or m["slug"]
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,39}", slug):
            sys.exit("客户代号只能用小写字母、数字和横线")
        if db.q("SELECT id FROM tenants WHERE slug=:s", one=True, s=slug):
            sys.exit(f"这台服务器上已经有客户 {slug}；要重来先运行 python3 migrate.py remove {slug} --yes")
        try:
            await engine.call("GET", "/datasets", params={"page_size": 1}, timeout=30)
            await engine.pick_model("embedding", settings.RAGFLOW_EMBED_MODEL)
            await engine.pick_model("chat", settings.RAGFLOW_CHAT_MODEL)
        except engine.EngineError as e:
            sys.exit(f"RAGFlow 还没准备好：{e}（检查 .env 里的 RAGFLOW_URL、API Key，以及 RAGFlow 里有没有配对话和向量模型）")

        created = {"datasets": [], "chats": []}
        try:
            rag, chunk_map = await rebuild_ragflow(m, work, old, slug, created)
            tid = insert_rows(m, slug, rag, chunk_map)
        except BaseException:
            log("导入失败，正在删掉已经在 RAGFlow 里建好的知识库和助手")
            await engine.deprovision(created)
            raise
        log(f"导入完成：客户 {slug}（id {tid}），账号：{', '.join(u['email'] for u in m['users'])}，密码和旧服务器上相同")
    finally:
        shutil.rmtree(work, ignore_errors=True)


async def add_chunk(ds_id, doc_id, c, chunk_map, gate):
    body = {"content": c["content"], "questions": c["questions"], "important_keywords": c["important_keywords"]}
    async with gate:
        for attempt in range(3):
            try:
                new = (await engine.call("POST", f"/datasets/{ds_id}/documents/{doc_id}/chunks", json=body, timeout=120))["chunk"]["id"]
                break
            except engine.EngineError:
                if attempt == 2:
                    raise
                await asyncio.sleep(3 * (attempt + 1))
        if not c["available"]:
            await engine.call("PATCH", f"/datasets/{ds_id}/documents/{doc_id}/chunks/{new}", json={"available": False})
    chunk_map[c["id"]] = new


async def rebuild_ragflow(m, work, old, slug, created):
    ds_ids, chunk_map, rag = {}, {}, {"datasets": {}, "assistants": {}}
    gate = asyncio.Semaphore(int(os.environ.get("MIGRATE_CONCURRENCY", "8")))
    for role, ds in m["datasets"].items():
        suffix = "问答库" if role == "qa" else "资料库" if role == "docs" else role
        ds_id = await engine.create_dataset(f"{slug}-{suffix}", ds["chunk_method"])
        created["datasets"].append(ds_id)
        ds_ids[role] = rag["datasets"][role] = ds_id
        to_parse = []
        for i, d in enumerate(ds["docs"], 1):
            blob = (work / d["file"]).read_bytes()
            doc_id = (await engine.upload_docs(ds_id, [(d["name"], blob, None)]))[0]
            if d["chunk_method"] != ds["chunk_method"]:
                await engine.call("PATCH", f"/datasets/{ds_id}/documents/{doc_id}", json={"chunk_method": d["chunk_method"]})
            if d["writeback"]:
                rag["writeback_doc"] = doc_id
            if d["reparse"]:
                to_parse.append(doc_id)
            # Image chunks can have no text; RAGFlow's parser keeps them but the chunk API rejects empty content.
            await asyncio.gather(*(add_chunk(ds_id, doc_id, c, chunk_map, gate) for c in d["chunks"] if c["content"].strip()))
            log(f"{suffix} {i}/{len(ds['docs'])} {d['name']}  {d['chunk_count']} 段{'（重新解析）' if d['reparse'] else ''}")
        if to_parse:
            await engine.parse_docs(ds_id, to_parse)
            log(f"{suffix} 等待解析 {len(to_parse)} 份文件…")
            await wait_parsed(ds_id, to_parse)

    t = m["tenant"]
    for key, c in m["chats"].items():
        dataset_ids = [ds_ids[r] for r in c["datasets"]]
        name = c["name"].replace(old, slug, 1)
        chat_id = await engine.create_chat(name, dataset_ids, t["rules"], t["empty_response"],
                                           (c.get("prompt_config") or {}).get("prologue", ""), c["threshold"])
        created["chats"].append(chat_id)
        await engine.call("PATCH", f"/chats/{chat_id}", json={f: c[f] for f in CHAT_FIELDS if c.get(f) is not None})
        rag["assistants"][key] = {"label": c["label"], "chat_id": chat_id, "dataset_ids": dataset_ids, "threshold": c["threshold"]}
        log(f"助手 {name} 建好了")
    return rag, chunk_map


def insert_rows(m, slug, rag, chunk_map):
    tb = m["tables"]
    with db.engine.begin() as conn:
        def add(table, row):
            res = conn.execute(table.insert().values(**fix_types(table, row)))
            pk = res.inserted_primary_key
            return pk[0] if pk and len(pk) == 1 else None

        tid = add(db.tenants, {**m["tenant"], "slug": slug, "rag": db.dumps(rag)})
        for u in m["users"]:
            role = u.pop("role")
            row = conn.execute(db.users.select().where(db.users.c.email == u["email"])).first()
            uid = row.id if row else add(db.users, {**u, "is_platform_admin": False})
            add(db.memberships, {"user_id": uid, "tenant_id": tid, "role": role})

        def copy(name, rows, drop_id=True, **fixups):
            table = db.meta.tables[name]
            out = {}
            for r in rows:
                old_id = r.get("id")
                r = {k: v for k, v in r.items() if not (drop_id and k == "id")}
                if "tenant_id" in r:
                    r["tenant_id"] = tid
                for col, fn in fixups.items():
                    r[col] = fn(r[col])
                out[old_id] = add(table, r)
            return out

        copy("tests", tb["tests"])
        runs = copy("runs", tb["runs"])
        copy("results", tb["results"], drop_id=False, run_id=lambda v: runs[v])
        msg_ids = {}
        for r in tb["messages"]:
            new = r["id"]
            if conn.execute(db.messages.select().where(db.messages.c.id == new)).first():
                new = uuid.uuid4().hex
            msg_ids[r["id"]] = new
            add(db.messages, {**r, "id": new, "tenant_id": tid})
        copy("feedback", tb["feedback"], message_id=lambda v: msg_ids.get(v, v))
        copy("handoffs", tb["handoffs"])
        copy("gaps", tb["gaps"], writeback_id=lambda v: chunk_map.get(v, ""))
        contacts = copy("contacts", tb["contacts"])
        copy("outreach", tb["outreach"], contact_id=lambda v: contacts[v])
        copy("outreach_cfg", tb["outreach_cfg"], drop_id=False)
        copy("llm_usage", tb["llm_usage"])
    return tid


# ---------- remove ----------

async def remove(slug):
    t = db.q("SELECT * FROM tenants WHERE slug=:s", one=True, s=slug)
    if not t:
        sys.exit(f"没有客户 {slug}")
    rag = db.loads(t["rag"], {})
    await engine.deprovision({"chats": [a["chat_id"] for a in rag.get("assistants", {}).values()],
                              "datasets": list(rag.get("datasets", {}).values())})
    tid = t["id"]
    db.x("DELETE FROM results WHERE run_id IN (SELECT id FROM runs WHERE tenant_id=:t)", t=tid)
    for name in ["outreach", "contacts", "outreach_cfg", "feedback", "messages", "handoffs", "gaps", "runs", "tests",
                 "llm_usage", "memberships"]:
        db.x(f"DELETE FROM {name} WHERE tenant_id=:t", t=tid)
    db.x("DELETE FROM tenants WHERE id=:t", t=tid)
    log(f"已删除客户 {slug}（账号保留，只去掉了它在这个客户下的成员身份）")


def main(argv):
    if len(argv) >= 2 and argv[0] == "export":
        out = argv[2] if len(argv) > 2 else f"{argv[1]}-export-{time.strftime('%Y%m%d')}.tar.gz"
        return asyncio.run(export(argv[1], out))
    if len(argv) >= 2 and argv[0] == "import":
        slug = argv[argv.index("--slug") + 1] if "--slug" in argv else None
        return asyncio.run(import_(argv[1], slug))
    if len(argv) >= 2 and argv[0] == "remove" and "--yes" in argv:
        return asyncio.run(remove(argv[1]))
    sys.exit(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
