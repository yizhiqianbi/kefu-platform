#!/usr/bin/env bash
# Mac（Apple 芯片或 Intel，macOS 15 以上）一键安装：RAGFlow + 客服平台，全部跑在 Docker 里。
# 先装好并打开 Docker Desktop 或 OrbStack，然后用普通用户（不要 sudo）运行：
#   bash deploy/mac/install.sh                                   # 装一个空平台
#   bash deploy/mac/install.sh ~/Downloads/hafyoung-export.tar.gz  # 顺便导入一个客户
# 可选环境变量：
#   MODEL_PROVIDER  bailian（阿里百炼，默认，国内直连）或 openrouter（要能访问境外，模型和开发机完全一样）
#   MODEL_KEY       对应渠道的 API Key，不给就提示输入
#   KEFU_HOME       安装目录，默认 ~/kefu
#   KEFU_PORT       平台端口，默认 80（局域网可访问）；只给本机用就写 127.0.0.1:80
#   HUB_MIRROR      Docker Hub 镜像站，百炼模式默认 docker.m.daocloud.io，设成空字符串则直连
# 可以重复运行：已生成的密码、Key 和数据都会保留；升级平台代码也是解压新包后再跑一次。
set -euo pipefail
[ "$(uname -s)" = Darwin ] || { echo "这个脚本是给 macOS 用的；Linux 服务器请用 deploy/install.sh 或 deploy/aliyun/install_all.sh" >&2; exit 1; }
[ "$(id -u)" != 0 ] || { echo "不要用 sudo，直接用当前用户运行（Docker Desktop 是按用户装的）" >&2; exit 1; }

HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$(cd "$HERE/../.." && pwd)"
BUNDLE="$SRC/deploy/ragflow"
KEFU_HOME=${KEFU_HOME:-$HOME/kefu}
RF="$KEFU_HOME/ragflow"
SECRETS="$KEFU_HOME/secrets"
ENVF="$RF/.env"
PROVIDER=${MODEL_PROVIDER:-bailian}
SILO=pgsty/silo:RELEASE.2026-08-06T00-00-00Z

case "$PROVIDER" in
  bailian)
    LLM_BASE="https://dashscope.aliyuncs.com/compatible-mode/v1"
    CHAT=deepseek-v4-flash EMBED=text-embedding-v4 JUDGE=deepseek-v4-pro
    RAGFLOW_IMAGE=${RAGFLOW_IMAGE:-registry.cn-hangzhou.aliyuncs.com/infiniflow/ragflow:v0.27.3}
    HUB_MIRROR=${HUB_MIRROR-docker.m.daocloud.io}
    PIP_INDEX=https://mirrors.aliyun.com/pypi/simple/
    HF=https://hf-mirror.com
    KEY_PROMPT="阿里百炼 API Key（sk- 开头）" ;;
  openrouter)
    LLM_BASE="https://openrouter.ai/api/v1"
    CHAT=deepseek/deepseek-v4.1-flash EMBED=qwen/qwen3-embedding-8b JUDGE=deepseek/deepseek-v4-pro
    RAGFLOW_IMAGE=${RAGFLOW_IMAGE:-infiniflow/ragflow:v0.27.3}
    HUB_MIRROR=${HUB_MIRROR-}
    PIP_INDEX=https://pypi.org/simple
    HF=https://huggingface.co
    KEY_PROMPT="OpenRouter API Key（sk-or- 开头）" ;;
  *) echo "MODEL_PROVIDER 只能是 bailian 或 openrouter" >&2; exit 1 ;;
esac

EXPORT=${1:-}
if [ -n "$EXPORT" ]; then
  [ -f "$EXPORT" ] || { echo "找不到导出包：$EXPORT" >&2; exit 1; }
  EXPORT="$(cd "$(dirname "$EXPORT")" && pwd)/$(basename "$EXPORT")"
fi

step() { printf '\n==> %s\n' "$*"; }
rand() { openssl rand -hex 32 | cut -c1-"$1"; }
set_env() {
  if grep -q "^$1=" "$ENVF"; then sed -i.bak "s|^$1=.*|$1=$2|" "$ENVF" && rm -f "$ENVF.bak"; else echo "$1=$2" >>"$ENVF"; fi
}

step "检查 Mac 和 Docker"
arch=$(uname -m)
macos=$(sw_vers -productVersion)
echo "macOS $macos，$arch，内存 $(( $(sysctl -n hw.memsize) / 1073741824 ))G"
if [ "$arch" = arm64 ] && [ "${macos%%.*}" -lt 15 ]; then
  echo "提醒：RAGFlow 只有 x86 镜像，要靠 Rosetta 运行，macOS 15 以上的 Rosetta 才支持它用到的 AVX 指令，建议先升级系统"
fi
command -v docker >/dev/null || { echo "没找到 docker：先安装 Docker Desktop（https://www.docker.com/products/docker-desktop/）或 OrbStack 并打开" >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker 没在运行：打开 Docker Desktop / OrbStack，等它启动完再运行本脚本" >&2; exit 1; }
cv=$(docker compose version --short 2>/dev/null | sed 's/^v//')
cmajor=${cv%%.*} crest=${cv#*.}
cminor=${crest%%.*}
if [ -z "$cv" ] || [ "$cmajor" -lt 2 ] || { [ "$cmajor" = 2 ] && [ "$cminor" -lt 24 ]; }; then
  echo "Docker Compose 版本太旧（${cv:-没有}），请把 Docker Desktop / OrbStack 升级到最新" >&2; exit 1
fi
vm_mem=$(( $(docker info --format '{{.MemTotal}}') / 1048576 ))
echo "Docker 可用内存 ${vm_mem}M"
if [ "$vm_mem" -lt 7500 ]; then
  echo "Docker 可用内存太少：Docker Desktop → Settings → Resources 把内存调到 10G 以上（16G 的 Mac 调 10 到 12G），再运行" >&2; exit 1
elif [ "$vm_mem" -lt 9500 ]; then
  echo "提醒：Docker 可用内存不到 10G，同时解析很多文件时可能吃紧，建议在 Docker 设置里调大"
fi
disk_gb=$(df -g "$HOME" | awk 'NR==2 {print $4}')
[ "$disk_gb" -ge 40 ] || echo "提醒：磁盘剩余 ${disk_gb}G，镜像加资料至少要 40G"

mkdir -p "$RF" "$SECRETS" "$KEFU_HOME/platform"
chmod 700 "$SECRETS"

step "模型 Key（$PROVIDER）"
if [ ! -s "$SECRETS/llm_api_key" ]; then
  key=${MODEL_KEY:-}
  [ -n "$key" ] || { read -rsp "$KEY_PROMPT，输入时不显示: " key; echo; }
  [ -n "$key" ] || { echo "Key 不能为空" >&2; exit 1; }
  printf %s "$key" >"$SECRETS/llm_api_key"
  chmod 600 "$SECRETS/llm_api_key"
  unset key
fi
hdr=$(mktemp)
chmod 600 "$hdr"
printf 'Authorization: Bearer %s\n' "$(cat "$SECRETS/llm_api_key")" >"$hdr"
check=$(mktemp)
code=$(curl -s -o "$check" -w '%{http_code}' --max-time 120 "$LLM_BASE/chat/completions" \
  -H @"$hdr" -H 'Content-Type: application/json' \
  -d "{\"model\":\"$JUDGE\",\"messages\":[{\"role\":\"user\",\"content\":\"回复 OK\"}],\"max_tokens\":16}" || true)
rm -f "$hdr"
if [ "$code" != 200 ]; then
  echo "模型调用失败（HTTP $code）：$(head -c 300 "$check")" >&2
  echo "检查 Key 和余额；Key 填错了就删掉 $SECRETS/llm_api_key 再运行" >&2
  rm -f "$check"; exit 1
fi
rm -f "$check"
echo "Key 可用（$JUDGE 调通了）"

step "准备文件（$KEFU_HOME）"
rsync -a --delete --exclude .git --exclude .env --exclude .venv --exclude data --exclude logs \
  --exclude __pycache__ --exclude static/.hallmark "$SRC/" "$KEFU_HOME/platform/"
rsync -a --exclude env.template "$BUNDLE/docker/" "$RF/"
cp "$HERE/docker-compose.mac.yml" "$RF/"
if [ ! -f "$ENVF" ]; then
  cp "$BUNDLE/docker/env.template" "$ENVF"
  chmod 600 "$ENVF"
  for k in ELASTIC_PASSWORD MYSQL_PASSWORD MINIO_PASSWORD REDIS_PASSWORD ADMIN_DEFAULT_PASSWORD; do set_env "$k" "$(rand 24)"; done
  set_env SECRET_KEY "$(rand 64)"
  # 这些变量只用在端口映射上；RAGFlow 这一套全部只绑本机
  for kv in ES_PORT=1200 EXPOSE_MYSQL_PORT=3306 MINIO_PORT=9000 MINIO_CONSOLE_PORT=9001 REDIS_PORT=6379 \
            SVR_WEB_HTTP_PORT=8080 SVR_WEB_HTTPS_PORT=8443 SVR_HTTP_PORT=9380 ADMIN_SVR_HTTP_PORT=9381 \
            SVR_MCP_PORT=9382 GO_HTTP_PORT=9384 GO_ADMIN_PORT=9383; do
    set_env "${kv%%=*}" "127.0.0.1:${kv#*=}"
  done
  set_env MEM_LIMIT 4294967296
  set_env COMPOSE_PROJECT_NAME kefu
  set_env COMPOSE_FILE docker-compose.yml:docker-compose.mac.yml
  set_env KEFU_SRC ../platform
  set_env KEFU_SECRETS ../secrets
fi
set_env RAGFLOW_IMAGE "$RAGFLOW_IMAGE"
set_env HF_ENDPOINT "$HF"
set_env HUB_MIRROR "$HUB_MIRROR"
set_env KEFU_PIP_INDEX "$PIP_INDEX"
set_env KEFU_PORT "${KEFU_PORT:-$(sed -n 's/^KEFU_PORT=//p' "$ENVF" | grep . || echo 80)}"
set_env KEFU_LLM_BASE_URL "$LLM_BASE"
set_env KEFU_JUDGE_MODEL "$JUDGE"
set_env KEFU_CHAT_MODEL "$CHAT"
set_env KEFU_EMBED_MODEL "$EMBED"
cd "$RF"

step "拉镜像（第一次要下载约 10G，看网速）"
pull() {  # pull <镜像> [平台]：先走镜像站，不行再直连，最后统一打成 compose 里写的名字
  local name=$1 plat=${2:-} want=$1 i
  case "$name" in
    library/* | valkey/* | pgsty/*) [ -z "$HUB_MIRROR" ] || want="$HUB_MIRROR/$name" ;;
  esac
  docker image inspect "$want" >/dev/null 2>&1 && { echo "已有 $want"; return; }
  for i in 1 2 3; do
    if docker pull ${plat:+--platform "$plat"} "$want"; then return; fi
    if [ "$want" != "$name" ] && docker pull ${plat:+--platform "$plat"} "docker.io/$name"; then
      docker tag "docker.io/$name" "$want"; return
    fi
    echo "拉取 $name 失败，20 秒后重试（第 $i 次）"; sleep 20
  done
  echo "镜像 $name 拉不下来：检查网络，或在 Docker 设置的 Docker Engine 里配 registry-mirrors 后重试" >&2
  exit 1
}
pull library/elasticsearch:8.11.3
pull library/mysql:8.0.40
pull "$SILO"
pull valkey/valkey:8
pull library/python:3.12-slim
pull "$RAGFLOW_IMAGE" linux/amd64

step "检查 x86 运行环境（Rosetta）"
if ! docker run --rm --platform linux/amd64 --entrypoint python3 "$RAGFLOW_IMAGE" \
     -c "import numpy, onnxruntime; print('x86 环境正常')"; then
  echo "RAGFlow 的 x86 镜像跑不起来。Docker Desktop：Settings → General 勾选「Use Rosetta for x86_64/amd64 emulation on Apple Silicon」；" >&2
  echo "OrbStack 默认已开启。并确认 macOS 是 15 以上。改完重启 Docker 再运行本脚本。" >&2
  exit 1
fi

step "构建客服平台镜像并启动全部服务"
docker compose build kefu
docker compose up -d
echo "等 RAGFlow 启动（第一次大概 3 到 15 分钟，x86 模拟会慢一些）"
for i in $(seq 1 360); do
  curl -sf -o /dev/null --max-time 5 http://127.0.0.1:9380/api/v1/system/healthz && break
  [ "$i" = 360 ] && { echo "RAGFlow 30 分钟还没起来，看日志：cd $RF && docker compose logs --tail 100 ragflow-cpu" >&2; exit 1; }
  sleep 5
done
echo "RAGFlow 已启动"

step "RAGFlow 初始化：管理员账号、模型、API Key"
if [ ! -s "$SECRETS/ragflow_admin" ]; then
  printf 'admin@kefu.local\n%s\n' "$(rand 20)" >"$SECRETS/ragflow_admin"
  chmod 600 "$SECRETS/ragflow_admin"
fi
RF_EMAIL=$(sed -n 1p "$SECRETS/ragflow_admin")
RF_PASSWORD=$(sed -n 2p "$SECRETS/ragflow_admin")
MODEL_KEY=$(cat "$SECRETS/llm_api_key")
MODEL_PROVIDER=$PROVIDER
export RF_EMAIL RF_PASSWORD MODEL_KEY MODEL_PROVIDER
token=$(docker compose exec -T -w /ragflow -e RF_EMAIL -e RF_PASSWORD -e MODEL_KEY -e MODEL_PROVIDER \
          ragflow-cpu python3 - <"$BUNDLE/bootstrap.py" | tail -1) || token=""
unset RF_PASSWORD MODEL_KEY
[ -n "$token" ] || { echo "RAGFlow 初始化失败，原因见上面；修好后重新运行本脚本即可" >&2; exit 1; }
printf %s "$token" >"$SECRETS/ragflow_api_key"
chmod 600 "$SECRETS/ragflow_api_key"
unset token

port=$(sed -n 's/^KEFU_PORT=//p' "$ENVF")
url="http://127.0.0.1:${port##*:}"
for i in $(seq 1 60); do
  curl -sf -o /dev/null --max-time 5 "$url/muxu/console/" && break
  [ "$i" = 60 ] && { echo "客服平台没起来，看日志：cd $RF && docker compose logs --tail 100 kefu" >&2; exit 1; }
  sleep 2
done

tenant=$(sed -n 's/^KEFU_DEFAULT_TENANT=//p' "$ENVF")
if [ -n "$EXPORT" ]; then
  step "导入客户（资料要重新算向量，几百份文件大概 10 到 40 分钟）"
  docker compose cp "$EXPORT" kefu:/tmp/import.tar.gz
  slug=$(docker compose exec -T kefu python -c \
    "import json, tarfile; print(json.load(tarfile.open('/tmp/import.tar.gz').extractfile('manifest.json'))['slug'])")
  if docker compose exec -T kefu python migrate.py import /tmp/import.tar.gz; then
    tenant=$slug
    set_env KEFU_DEFAULT_TENANT "$tenant"
  else
    echo "导入没成功，原因见上面。修好后重新运行本脚本并带上导出包即可" >&2
  fi
  docker compose exec -T kefu rm -f /tmp/import.tar.gz
fi
docker compose up -d kefu >/dev/null

lan=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)
host=$(scutil --get LocalHostName 2>/dev/null || true)
p=${port##*:}
suffix=""
[ "$p" = 80 ] || suffix=":$p"
cat <<EOF

======================== 装好了 ========================
运营台      $url/muxu/console/
            平台管理员 admin@muxu.local，初始密码：
              cd $RF && docker compose exec kefu cat /data/.admin_password
咨询页      $url/muxu/${tenant:+（默认打开 $tenant；其他客户是 /muxu/c/客户代号/）}
EOF
if [ "${port%%:*}" = "$port" ] && [ -n "$lan" ]; then
  echo "局域网      http://$lan$suffix/muxu/   或   http://${host:-本机名}.local$suffix/muxu/"
fi
cat <<EOF
RAGFlow     http://127.0.0.1:8080 ，账号密码：cat $SECRETS/ragflow_admin
模型        $PROVIDER：问答 $CHAT，向量 $EMBED，评分和起草 $JUDGE
管理        cd $RF && docker compose ps | logs -f kefu | restart | stop
密钥和密码  $SECRETS/、$ENVF（别外传）
让 Mac 不睡眠、断电来电自动开机：sudo pmset -a sleep 0 disksleep 0 autorestart 1
========================================================
EOF
