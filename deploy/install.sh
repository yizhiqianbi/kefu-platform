#!/usr/bin/env bash
# 在新服务器上安装客服平台（RAGFlow 要先按 README 第 1 步跑起来）。
#   sudo bash deploy/install.sh
# 密钥可以提前放进环境变量 RAGFLOW_API_KEY / LLM_API_KEY，否则会提示输入；只写进 /etc/kefu/，权限 600。
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "请用 root 或 sudo 运行" >&2; exit 1; }

SRC="$(cd "$(dirname "$0")/.." && pwd)"
APP=/opt/kefu-platform
DATA=/var/lib/muxu
SECRETS=/etc/kefu

python3 -c 'import sys; sys.exit(sys.version_info < (3, 10))' || { echo "需要 Python 3.10 以上" >&2; exit 1; }
if ! python3 -m venv --help >/dev/null 2>&1 || ! command -v nginx >/dev/null; then
  if command -v apt-get >/dev/null; then
    apt-get update && apt-get install -y python3-venv nginx curl
  else
    echo "请先装好 python3-venv、nginx、curl" >&2; exit 1
  fi
fi

if [ "$SRC" != "$APP" ]; then
  mkdir -p "$APP"
  cp -a "$SRC"/. "$APP"/
fi
cd "$APP"
python3 -m venv .venv
.venv/bin/pip install -q --upgrade pip
.venv/bin/pip install -q -r requirements.txt

mkdir -p "$DATA" "$SECRETS"
chmod 700 "$DATA" "$SECRETS"
ask_secret() {
  local name=$1 file=$2 prompt=$3 value=${!1:-}
  if [ -s "$file" ] && [ -z "$value" ]; then return; fi
  if [ -z "$value" ]; then read -rsp "$prompt: " value; echo; fi
  [ -n "$value" ] || { echo "$name 不能为空" >&2; exit 1; }
  printf %s "$value" >"$file"
  chmod 600 "$file"
}
ask_secret RAGFLOW_API_KEY "$SECRETS/ragflow_api_key" "RAGFlow API Key"
ask_secret LLM_API_KEY "$SECRETS/llm_api_key" "评分和起草用的模型 Key（OpenRouter / DeepSeek 等）"

if [ ! -f .env ]; then
  cat >.env <<EOF
MUXU_DATA_DIR=$DATA
RAGFLOW_URL=${RAGFLOW_URL:-http://127.0.0.1:9380/api/v1}
RAGFLOW_API_KEY_FILE=$SECRETS/ragflow_api_key
LLM_BASE_URL=${LLM_BASE_URL:-https://openrouter.ai/api/v1}
LLM_API_KEY_FILE=$SECRETS/llm_api_key
JUDGE_MODEL=${JUDGE_MODEL:-deepseek/deepseek-v4-pro}
DEFAULT_TENANT=${DEFAULT_TENANT:-muxu}
EOF
  echo "已生成 $APP/.env，换模型渠道时改这里（字段说明见 .env.example）"
fi

cp deploy/muxu.service /etc/systemd/system/muxu.service
systemctl daemon-reload
systemctl enable muxu >/dev/null
systemctl restart muxu

cp deploy/nginx/kefu.conf /etc/nginx/conf.d/kefu.conf
# Debian/Ubuntu 自带的 default 站点也监听 80，会抢掉 kefu.conf
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable nginx >/dev/null
systemctl reload nginx 2>/dev/null || systemctl start nginx

for _ in $(seq 1 30); do
  if curl -sf -o /dev/null http://127.0.0.1/muxu/console/; then
    echo "装好了：http://<服务器地址>/muxu/console/"
    [ -f "$DATA/.admin_password" ] && echo "平台管理员 admin@muxu.local，初始密码在 $DATA/.admin_password"
    exit 0
  fi
  sleep 1
done
echo "服务没起来，看日志：journalctl -u muxu -n 50" >&2
exit 1
