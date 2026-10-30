"""在 RAGFlow 容器里运行：建管理员账号、接入模型渠道、设默认模型、生成 API Key。

    docker compose exec -T -e RF_EMAIL -e RF_PASSWORD -e MODEL_KEY -e MODEL_PROVIDER ragflow-cpu python3 - < bootstrap.py

MODEL_PROVIDER 是 bailian（阿里百炼，默认）或 openrouter；CHAT_MODEL / EMBED_MODEL / VISION_MODEL 可以覆盖默认模型。
可以重复运行。成功时最后一行输出 API Key，其余信息写到 stderr。
"""
import os
import sys
import time

sys.path.insert(0, "/ragflow")
import requests  # noqa: E402
from api.utils.crypt import crypt  # noqa: E402

BASE = "http://127.0.0.1:9380/api/v1"
PRESETS = {
    "bailian": {
        "provider": "Tongyi-Qianwen", "instance": "bailian",
        "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "chat": ("deepseek-v4-flash", 1048576), "embed": ("text-embedding-v4", 8192),
        "vision": ("qwen3-vl-flash", 262144),
    },
    "openrouter": {
        "provider": "OpenRouter", "instance": "openrouter",
        "base_url": "https://openrouter.ai/api/v1",
        "chat": ("deepseek/deepseek-v4.1-flash", 65536), "embed": ("qwen/qwen3-embedding-8b", 32000),
        "vision": ("google/gemini-3.1-flash-lite", 65536),
    },
}

S = requests.Session()
S.trust_env = False


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def die(msg):
    log("失败：" + msg)
    sys.exit(1)


def login(email, password):
    r = S.post(f"{BASE}/auth/login", json={"email": email, "password": crypt(password)}, timeout=60)
    return r.headers.get("Authorization") if r.json().get("code") == 0 else None


def main():
    p = PRESETS.get(os.environ.get("MODEL_PROVIDER", "bailian")) or die("MODEL_PROVIDER 只能是 bailian 或 openrouter")
    chat = os.environ.get("CHAT_MODEL") or p["chat"][0]
    embed = os.environ.get("EMBED_MODEL") or p["embed"][0]
    vision = os.environ.get("VISION_MODEL") or p["vision"][0]
    models = [
        {"model_type": ["chat"], "model_name": chat, "max_tokens": p["chat"][1]},
        {"model_type": ["embedding"], "model_name": embed, "max_tokens": p["embed"][1]},
        {"model_type": ["chat", "image2text"], "model_name": vision, "max_tokens": p["vision"][1]},
    ]
    email, password, key = os.environ["RF_EMAIL"], os.environ["RF_PASSWORD"], os.environ["MODEL_KEY"]

    auth = login(email, password)
    if not auth:
        r = S.post(f"{BASE}/users", json={"email": email, "nickname": "admin", "password": crypt(password)}, timeout=60).json()
        if r.get("code") != 0:
            die(f"注册 RAGFlow 管理员：{r.get('message')}")
        auth = login(email, password) or die("注册后登录不上")
    log("RAGFlow 管理员已就绪：", email)

    def call(method, path, **kw):
        r = S.request(method, f"{BASE}{path}", headers={"Authorization": auth}, timeout=kw.pop("timeout", 120), **kw)
        try:
            return r.json()
        except ValueError:
            return {"code": r.status_code, "message": r.text[:300]}

    r = call("PUT", "/providers", json={"provider_name": p["provider"]})
    if r.get("code") != 0 and "already exists" not in str(r.get("message")):
        die(f"添加模型渠道 {p['provider']}：{r.get('message')}")

    r = call("POST", f"/providers/{p['provider']}/instances", timeout=300, json={
        "instance_name": p["instance"], "api_key": key, "base_url": p["base_url"], "region": "", "model_info": models})
    if r.get("code") == 0:
        log("模型 Key 校验通过，已接入：", chat, embed, vision)
    elif "already exists" in str(r.get("message")):
        log("模型渠道之前已接入，跳过（换 Key 请在 RAGFlow 页面里改）")
    else:
        die(f"接入模型（多半是 Key 不对或没开通模型）：{r.get('message')}")

    ids = {}
    for _ in range(10):
        listed = call("GET", "/models", params={"page_size": 200}).get("data") or []
        ids = {m["name"]: m["model_id"] for m in listed}
        if all(m["model_name"] in ids for m in models):
            break
        time.sleep(3)
    for kind, name in [("chat", chat), ("embedding", embed), ("image2text", vision), ("vision", vision)]:
        if name not in ids:
            die(f"RAGFlow 里找不到模型 {name}")
        r = call("PATCH", "/models/default", json={"model_type": kind, "model_id": ids[name]})
        if r.get("code") != 0 and kind != "vision":
            die(f"设默认{kind}模型：{r.get('message')}")

    tokens = call("GET", "/system/tokens").get("data") or []
    token = tokens[0]["token"] if tokens else (call("POST", "/system/tokens").get("data") or {}).get("token")
    if not token:
        die("生成 API Key 失败")
    print(token)


if __name__ == "__main__":
    main()
