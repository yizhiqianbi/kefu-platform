"""All deployment-specific values come from the environment (or a .env file next to this module)."""
import os
from pathlib import Path

HERE = Path(__file__).resolve().parent


def _load_dotenv(path):
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_dotenv(HERE / ".env")


def env(key, default=""):
    return os.environ.get(key, default)


def secret(key):
    """Read KEY directly, or from the file named by KEY_FILE."""
    if os.environ.get(key):
        return os.environ[key].strip()
    path = os.environ.get(f"{key}_FILE")
    if path and Path(path).exists():
        return Path(path).read_text().strip()
    return ""


DATA_DIR = Path(env("MUXU_DATA_DIR", str(HERE / "data")))
DATA_DIR.mkdir(parents=True, exist_ok=True)
DATABASE_URL = env("DATABASE_URL", f"sqlite:///{DATA_DIR / 'platform.db'}")

RAGFLOW_URL = env("RAGFLOW_URL", "http://127.0.0.1:9380/api/v1").rstrip("/")
RAGFLOW_CHAT_MODEL = env("RAGFLOW_CHAT_MODEL")        # model name in RAGFlow; empty = first chat model
RAGFLOW_EMBED_MODEL = env("RAGFLOW_EMBED_MODEL")      # empty = first embedding model

# Any OpenAI-compatible endpoint: OpenRouter, DeepSeek, 百炼, 火山方舟, an internal gateway...
LLM_BASE_URL = env("LLM_BASE_URL", "https://openrouter.ai/api/v1").rstrip("/")
JUDGE_MODEL = env("JUDGE_MODEL", "deepseek/deepseek-v4-pro")
ROUTER_MODEL = env("ROUTER_MODEL", "typesafe/jev-1.13")      # System One decision model for routing and checks
AGENT_MODEL = env("AGENT_MODEL", "deepseek/deepseek-v4.1-flash")  # reply agent; empty = JUDGE_MODEL

DEFAULT_TENANT = env("DEFAULT_TENANT", "muxu")
SESSION_DAYS = int(env("SESSION_DAYS", "7"))
UPLOAD_MAX_MB = int(env("UPLOAD_MAX_MB", "30"))

# Chatwoot channel layer; empty CHATWOOT_URL = the 渠道 page only explains how to set it up.
CHATWOOT_URL = env("CHATWOOT_URL").rstrip("/")                                   # how this server reaches Chatwoot
CHATWOOT_PUBLIC_URL = env("CHATWOOT_PUBLIC_URL", CHATWOOT_URL).rstrip("/")       # how browsers reach it
CHATWOOT_MAIL_DOMAIN = env("CHATWOOT_MAIL_DOMAIN", "kefu.local")                 # service accounts' email domain
MUXU_PUBLIC_URL = env("MUXU_PUBLIC_URL", "http://127.0.0.1:8770").rstrip("/")    # how Chatwoot reaches this server
# 个人号（Telegram / WhatsApp / Instagram）连平台用的代理；不填就用本机的 HTTPS_PROXY，海外服务器上留空
PERSONAL_PROXY = env("PERSONAL_PROXY", env("HTTPS_PROXY", env("https_proxy")))
# 外部平台（企业微信）回调本服务用的公网地址，如 https://kefu.example.com；不填 = 没有公网地址，企业微信改为定时拉消息
CALLBACK_BASE_URL = env("CALLBACK_BASE_URL").rstrip("/")
CHATWOOT_DEBOUNCE = float(env("CHATWOOT_DEBOUNCE", "3"))                         # seconds to wait for follow-up messages
# 带货视频：镜头走 OpenRouter 的视频接口。客户没填自己的密钥时，VIDEO_PLATFORM_KEY=1 就用平台的 LLM_API_KEY（平台付费）
VIDEO_API_URL = env("VIDEO_API_URL", "https://openrouter.ai/api/v1").rstrip("/")
VIDEO_PLATFORM_KEY = env("VIDEO_PLATFORM_KEY", "1") == "1"
VIDEO_MODEL = env("VIDEO_MODEL", "bytedance/seedance-2.5")
VIDEO_UPLOAD_MAX_MB = int(env("VIDEO_UPLOAD_MAX_MB", "200"))


def ragflow_key():
    return secret("RAGFLOW_API_KEY")


def llm_key():
    return secret("LLM_API_KEY")
