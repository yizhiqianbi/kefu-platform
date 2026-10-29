"""Knowledge engine adapter. Everything the platform needs from RAGFlow goes through here,
so swapping the engine later only touches this file."""
import json
import re
import time

import httpx

import settings

CITE_RE = re.compile(r"\s*\[ID:\d+\]")
http = httpx.AsyncClient(timeout=httpx.Timeout(30, read=60), trust_env=False)


class EngineError(RuntimeError):
    pass


def clean(text):
    return CITE_RE.sub("", text or "").strip()


def _headers():
    return {"Authorization": f"Bearer {settings.ragflow_key()}"}


async def call(method, path, *, timeout=60, **kw):
    try:
        r = await http.request(method, settings.RAGFLOW_URL + path, headers=_headers(), timeout=timeout, **kw)
        res = r.json()
    except (httpx.HTTPError, ValueError) as e:
        raise EngineError(f"知识库服务连不上：{e!r}"[:200]) from e
    if res.get("code") != 0:
        raise EngineError(res.get("message") or f"知识库服务返回错误 {res.get('code')}")
    return res.get("data")


async def health():
    try:
        await call("GET", "/datasets", params={"page_size": 1}, timeout=5)
        return True
    except EngineError:
        return False


# ---------- models ----------

async def pick_model(kind, name=""):
    """Tenant model id for a model type ('chat' | 'embedding'), by name or the first available."""
    models = await call("GET", "/models", params={"page_size": 200})
    cands = [m for m in models if kind in (m.get("model_type") or [])]
    if name:
        cands = [m for m in cands if m["name"] == name]
    if not cands:
        raise EngineError(f"RAGFlow 里没有可用的{'对话' if kind == 'chat' else '向量'}模型{('：' + name) if name else ''}")
    return cands[0]["model_id"]


# ---------- datasets and documents ----------

async def create_dataset(name, chunk_method):
    embed = await pick_model("embedding", settings.RAGFLOW_EMBED_MODEL)
    data = await call("POST", "/datasets", json={"name": name, "chunk_method": chunk_method, "embedding_model": embed})
    return data["id"]


async def dataset_stats(ids):
    out = {}
    for i in ids:
        data = await call("GET", "/datasets", params={"id": i, "page_size": 1})
        for d in data:
            out[d["id"]] = {"name": d["name"], "docs": d.get("document_count") or 0, "chunks": d.get("chunk_count") or 0}
    return out


async def _paged(path, key, limit=2000, **params):
    out, page = [], 1
    while len(out) < limit:
        data = await call("GET", path, params={**params, "page": page, "page_size": 100})
        items = data.get(key, [])
        out += items
        if len(items) < 100:
            break
        page += 1
    return out


async def list_docs(dataset_id):
    out = []
    for d in await _paged(f"/datasets/{dataset_id}/documents", "docs", orderby="create_time", desc="true"):
        msg = (d.get("progress_msg") or "").strip().splitlines()
        out.append({
            "id": d["id"], "name": d["name"], "size": d.get("size") or 0, "run": d.get("run"),
            "progress": round(d.get("progress") or 0, 2), "chunks": d.get("chunk_count") or 0,
            "created": (d.get("create_time") or 0) / 1000, "message": msg[-1][:160] if msg else "",
        })
    return out


async def upload_docs(dataset_id, files):
    """files: list of (filename, bytes, content_type). Returns new document ids."""
    data = await call("POST", f"/datasets/{dataset_id}/documents", timeout=300,
                      files=[("file", (name, blob, ctype or "application/octet-stream")) for name, blob, ctype in files])
    return [d["id"] for d in data]


async def parse_docs(dataset_id, doc_ids):
    await call("POST", f"/datasets/{dataset_id}/documents/parse", json={"document_ids": doc_ids})


async def delete_docs(dataset_id, doc_ids):
    await call("DELETE", f"/datasets/{dataset_id}/documents", json={"ids": doc_ids})


async def list_chunks(dataset_id, doc_id, limit=2000):
    return [c.get("content") or "" for c in await _paged(f"/datasets/{dataset_id}/documents/{doc_id}/chunks", "chunks", limit)]


async def add_qa_chunk(dataset_id, doc_id, question, answer, alt_questions=()):
    """Write one Q&A pair into a 问答库 document, in the same shape the qa parser produces."""
    head = question if not alt_questions else question + "\n" + " / ".join(alt_questions)
    data = await call("POST", f"/datasets/{dataset_id}/documents/{doc_id}/chunks",
                      json={"content": f"问题：{head}\t回答：{answer}", "questions": [question, *alt_questions]})
    return data["chunk"]["id"]


async def delete_chunks(dataset_id, doc_id, chunk_ids):
    await call("DELETE", f"/datasets/{dataset_id}/documents/{doc_id}/chunks", json={"chunk_ids": chunk_ids})


# ---------- chats ----------

KNOWLEDGE_BLOCK = "\n\n以下是知识库内容：\n{knowledge}\n以上是知识库内容。"


async def create_chat(name, dataset_ids, rules, empty_response, prologue, threshold=0.2):
    llm = await pick_model("chat", settings.RAGFLOW_CHAT_MODEL)
    data = await call("POST", "/chats", json={
        "name": name, "dataset_ids": dataset_ids, "tenant_llm_id": llm,
        "llm_setting": {"temperature": 0.1},
        "similarity_threshold": threshold, "vector_similarity_weight": 0.3, "top_n": 8,
        "prompt_config": {
            "system": rules.strip() + KNOWLEDGE_BLOCK, "empty_response": empty_response, "prologue": prologue,
            "quote": True, "refine_multiturn": False, "tts": False,
            "parameters": [{"key": "knowledge", "optional": False}],
        },
    })
    return data["id"]


async def update_chat_prompt(chat_id, rules, empty_response):
    chat = await call("GET", f"/chats/{chat_id}")
    pc = dict(chat.get("prompt_config") or {})
    pc["system"] = rules.strip() + KNOWLEDGE_BLOCK
    pc["empty_response"] = empty_response
    await call("PATCH", f"/chats/{chat_id}", json={"prompt_config": pc})


async def delete_chats(ids):
    await call("DELETE", "/chats", json={"ids": ids})


def simplify_refs(ref):
    chunks = ref.get("chunks", []) if isinstance(ref, dict) else (ref or [])
    return [{"doc": c.get("document_name") or c.get("doc_name") or "", "content": (c.get("content") or "")[:600],
             "similarity": c.get("similarity")} for c in chunks]


async def ask(chat_id, messages):
    """Non-streaming answer. Returns (answer, refs, seconds)."""
    import asyncio
    body = {"model": "model", "messages": messages, "stream": False, "extra_body": {"reference": True}}
    t0 = time.time()
    last = None
    for attempt in range(3):
        try:
            r = await http.post(f"{settings.RAGFLOW_URL}/openai/{chat_id}/chat/completions", headers=_headers(), json=body, timeout=120)
            res = r.json()
            if res.get("choices"):
                msg = res["choices"][0]["message"]
                return clean(msg.get("content")), simplify_refs(msg.get("reference")), round(time.time() - t0, 1)
            last = res.get("message") or str(res)[:200]
        except (httpx.HTTPError, ValueError) as e:
            last = repr(e)
        await asyncio.sleep(2 * (attempt + 1))
    raise EngineError(f"知识库没有返回答案：{last}")


async def stream(chat_id, messages, first_token_timeout=40):
    """Yield ("delta", text) ... then ("final", text, refs)."""
    body = {"model": "model", "messages": messages, "stream": True, "extra_body": {"reference": True}}
    raw, final, refs = "", None, []
    async with http.stream("POST", f"{settings.RAGFLOW_URL}/openai/{chat_id}/chat/completions", headers=_headers(),
                           json=body, timeout=httpx.Timeout(30, read=first_token_timeout)) as r:
        if r.status_code != 200:
            raise EngineError(f"知识库服务返回 {r.status_code}")
        async for line in r.aiter_lines():
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                break
            try:
                chunk = json.loads(data)
            except ValueError:
                continue
            if chunk.get("code") not in (None, 0):
                raise EngineError(chunk.get("message") or "知识库出错")
            choices = chunk.get("choices") or []
            if not choices:
                continue
            delta = choices[0].get("delta") or {}
            if delta.get("content"):
                raw += delta["content"]
                yield ("delta", delta["content"])
            if delta.get("final_content"):
                final = delta["final_content"]
            if delta.get("reference"):
                refs = simplify_refs(delta["reference"])
    yield ("final", clean(final or raw), refs)


async def retrieve(dataset_ids, question, top=8, vector_weight=0.3):
    data = await call("POST", "/retrieval", json={
        "question": question, "dataset_ids": dataset_ids, "similarity_threshold": 0.0,
        "vector_similarity_weight": vector_weight, "top_k": 1024, "page_size": top})
    return [{
        "doc": c.get("document_keyword") or c.get("document_name") or "",
        "content": c.get("content") or "",
        "similarity": round(c.get("similarity") or 0, 3),
        "vector": round(c.get("vector_similarity") or 0, 3),
        "term": round(c.get("term_similarity") or 0, 3),
    } for c in data["chunks"]]


# ---------- provisioning ----------

WRITEBACK_DOC = "运营台写回.txt"


BASICS_DOC = "基本信息.txt"


async def provision(slug, name, rules, empty_response, prologue, basics, contact_answer):
    """Create the 资料库 + 问答库, a write-back document, and the main assistant for a new tenant.

    RAGFlow refuses to create a chat over a dataset with no chunks, so each dataset gets one seed entry first.
    """
    created = {"datasets": [], "chats": []}
    try:
        docs_id = await create_dataset(f"{slug}-资料库", "naive")
        created["datasets"].append(docs_id)
        qa_id = await create_dataset(f"{slug}-问答库", "qa")
        created["datasets"].append(qa_id)
        wb_id = (await upload_docs(qa_id, [(WRITEBACK_DOC, "运营台写回的问答对会追加到这份文件里。\n".encode(), "text/plain")]))[0]
        await add_qa_chunk(qa_id, wb_id, "怎么联系人工客服？", contact_answer, ["电话多少", "找人工", "联系方式"])
        basics_id = (await upload_docs(docs_id, [(BASICS_DOC, basics.encode(), "text/plain")]))[0]
        await call("POST", f"/datasets/{docs_id}/documents/{basics_id}/chunks", json={"content": basics})
        chat_id = await create_chat(f"{slug}-主助手", [qa_id, docs_id], rules, empty_response, prologue)
        created["chats"].append(chat_id)
    except EngineError:
        await deprovision(created)
        raise
    return {
        "datasets": {"docs": docs_id, "qa": qa_id},
        "writeback_doc": wb_id,
        "assistants": {"main": {"label": "主助手（问答库 + 资料库）", "chat_id": chat_id, "dataset_ids": [qa_id, docs_id], "threshold": 0.2}},
    }


async def deprovision(created):
    if created.get("chats"):
        try:
            await delete_chats(created["chats"])
        except EngineError:
            pass
    if created.get("datasets"):
        try:
            await call("DELETE", "/datasets", json={"ids": created["datasets"]})
        except EngineError:
            pass
