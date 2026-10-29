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

DEFAULT_TENANT = env("DEFAULT_TENANT", "muxu")
SESSION_DAYS = int(env("SESSION_DAYS", "7"))
UPLOAD_MAX_MB = int(env("UPLOAD_MAX_MB", "30"))


def ragflow_key():
    return secret("RAGFLOW_API_KEY")


def llm_key():
    return secret("LLM_API_KEY")
