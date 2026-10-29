"""OpenAI-compatible model calls for grading, drafting and test generation, with per-tenant usage records."""
import asyncio
import json
import re

import httpx

import db
import settings

http = httpx.AsyncClient(timeout=httpx.Timeout(30, read=120))
# OpenRouter pads slow responses with keep-alive bytes, so the read timeout alone never fires.
DEADLINE = 120


class LLMError(RuntimeError):
    pass


def _record(tenant_id, kind, model, usage):
    db.insert(db.llm_usage, tenant_id=tenant_id, kind=kind, model=model,
              prompt_tokens=int((usage or {}).get("prompt_tokens") or 0),
              completion_tokens=int((usage or {}).get("completion_tokens") or 0), created=db.now())


async def chat_json(messages, *, tenant_id, kind, temperature=0.0, model=None, retries=3):
    """Ask for a JSON object and return it parsed."""
    model = model or settings.JUDGE_MODEL
    if not settings.llm_key():
        raise LLMError("没有配置模型密钥（LLM_API_KEY）")
    body = {"model": model, "temperature": temperature, "messages": messages, "response_format": {"type": "json_object"}}
    last = None
    for attempt in range(retries):
        try:
            r = await asyncio.wait_for(http.post(settings.LLM_BASE_URL + "/chat/completions", json=body,
                                                 headers={"Authorization": f"Bearer {settings.llm_key()}"}), DEADLINE)
            if r.status_code == 400 and "response_format" in body:
                body.pop("response_format")
                continue
            res = r.json()
            if "choices" not in res:
                last = (res.get("error") or {}).get("message") or str(res)[:200]
            else:
                _record(tenant_id, kind, model, res.get("usage"))
                text = res["choices"][0]["message"]["content"] or ""
                m = re.search(r"\{.*\}", text, re.S)
                if m:
                    return json.loads(m.group(0))
                last = f"模型没有返回 JSON：{text[:120]}"
        except asyncio.TimeoutError:
            last = f"模型 {DEADLINE} 秒没有返回"
        except (httpx.HTTPError, ValueError) as e:
            last = repr(e)[:200]
        await asyncio.sleep(1.5 * (attempt + 1))
    raise LLMError(last or "模型调用失败")
