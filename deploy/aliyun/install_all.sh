#!/usr/bin/env bash
# 阿里云 ECS（Ubuntu 22.04 / 24.04）一键安装：Docker、RAGFlow、客服平台，模型全部走阿里百炼。
#   sudo bash deploy/aliyun/install_all.sh                               # 装一个空平台
#   sudo bash deploy/aliyun/install_all.sh /root/hafyoung-export.tar.gz  # 顺便导入一个客户
# 会问两样东西，也可以提前用环境变量给：
#   DASHSCOPE_API_KEY  阿里百炼 API Key
#   DOCKER_MIRROR      容器镜像服务 ACR 的镜像加速器地址（https://xxxx.mirror.aliyuncs.com）
# 可以重复运行：已生成的密码、Key、数据都会保留。
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "请用 root 或 sudo 运行" >&2; exit 1; }
command -v apt-get >/dev/null || { echo "这个脚本按 Ubuntu 写的，买服务器时请选 Ubuntu 22.04 或 24.04" >&2; exit 1; }

HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$(cd "$HERE/../.." && pwd)"
BUNDLE="$SRC/deploy/ragflow"
RF="/opt/ragflow"
APP="/opt/kefu-platform"
SECRETS="/etc/kefu"
BAILIAN="https://dashscope.aliyuncs.com/compatible-mode/v1"
CHAT_MODEL=${CHAT_MODEL:-deepseek-v4-flash}
EMBED_MODEL=${EMBED_MODEL:-text-embedding-v4}
VISION_MODEL=${VISION_MODEL:-qwen3-vl-flash}
JUDGE_MODEL=${JUDGE_MODEL:-deepseek-v4-pro}
RAGFLOW_IMAGE=${RAGFLOW_IMAGE:-registry.cn-hangzhou.aliyuncs.com/infiniflow/ragflow:v0.27.3}
export PIP_INDEX_URL=${PIP_INDEX_URL:-https://mirrors.aliyun.com/pypi/simple/}
export DEBIAN_FRONTEND=noninteractive

EXPORT=${1:-}
if [ -n "$EXPORT" ]; then
  [ -f "$EXPORT" ] || { echo "找不到导出包：$EXPORT" >&2; exit 1; }
  EXPORT=$(realpath "$EXPORT")
fi

step() { printf '\n==> %s\n' "$*"; }
rand() { head -c 64 /dev/urandom | sha256sum | cut -c1-"${1:-24}"; }

step "检查机器配置"
mem_gb=$(awk '/MemTotal/ {print int($2 / 1048576 + 0.5)}' /proc/meminfo)
disk_gb=$(df -BG --output=avail / | tail -1 | tr -dc 0-9)
echo "内存 ${mem_gb}G，系统盘剩余 ${disk_gb}G"
[ "$mem_gb" -ge 15 ] || { echo "内存不够：RAGFlow 至少要 16G" >&2; exit 1; }
[ "$disk_gb" -ge 50 ] || echo "提醒：磁盘剩余不到 50G，镜像加资料很快会满，建议把系统盘扩到 100G"

step "系统参数和基础软件"
echo "vm.max_map_count=262144" >/etc/sysctl.d/99-ragflow.conf
sysctl -q -w vm.max_map_count=262144
apt-get update -q
apt-get install -y -q ca-certificates curl gnupg python3 python3-venv nginx

mkdir -p "$SECRETS"
chmod 700 "$SECRETS"

step "百炼 API Key"
if [ ! -s "$SECRETS/llm_api_key" ]; then
  key=${DASHSCOPE_API_KEY:-}
  [ -n "$key" ] || { read -rsp "阿里百炼 API Key（sk- 开头，输入时不显示）: " key; echo; }
  [ -n "$key" ] || { echo "Key 不能为空" >&2; exit 1; }
  printf %s "$key" >"$SECRETS/llm_api_key"
  chmod 600 "$SECRETS/llm_api_key"
fi
hdr=$(mktemp)
chmod 600 "$hdr"
printf 'Authorization: Bearer %s\n' "$(cat "$SECRETS/llm_api_key")" >"$hdr"
code=$(curl -s -o /tmp/bailian-check.json -w '%{http_code}' --max-time 120 "$BAILIAN/chat/completions" \
  -H @"$hdr" -H 'Content-Type: application/json' \
  -d "{\"model\":\"$JUDGE_MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"回复 OK\"}],\"max_tokens\":16}" || true)
rm -f "$hdr"
if [ "$code" != 200 ]; then
  echo "百炼调用失败（HTTP $code）：$(head -c 300 /tmp/bailian-check.json 2>/dev/null)" >&2
  echo "检查 Key 是否正确、账号是否已开通百炼并有余额；Key 错了就删掉 $SECRETS/llm_api_key 再运行" >&2
  exit 1
fi
echo "Key 可用（$JUDGE_MODEL 调通了）"

step "Docker"
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://mirrors.aliyun.com/docker-ce/linux/ubuntu/gpg | gpg --batch --yes --dearmor -o /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://mirrors.aliyun.com/docker-ce/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    >/etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-compose-plugin
fi
if [ ! -f /etc/docker/daemon.json ]; then
  mirror=${DOCKER_MIRROR:-}
  [ -n "$mirror" ] || read -rp "ACR 镜像加速器地址（https://xxxx.mirror.aliyuncs.com，没有就直接回车）: " mirror
  mirrors="\"https://docker.m.daocloud.io\""
  [ -z "$mirror" ] || mirrors="\"$mirror\", $mirrors"
  mkdir -p /etc/docker
  cat >/etc/docker/daemon.json <<EOF
{
  "registry-mirrors": [$mirrors],
  "log-driver": "json-file",
  "log-opts": {"max-size": "50m", "max-file": "3"}
}
EOF
  systemctl restart docker
else
  echo "已有 /etc/docker/daemon.json，不改它（镜像拉不下来时检查里面的 registry-mirrors）"
fi
systemctl enable --now docker >/dev/null

step "RAGFlow"
mkdir -p "$RF/docker"
tar -C "$BUNDLE/docker" --exclude=./env.template -cf - . | tar -C "$RF/docker" -xf -
ENVF="$RF/docker/.env"
set_env() {
  if grep -q "^$1=" "$ENVF"; then sed -i "s|^$1=.*|$1=$2|" "$ENVF"; else echo "$1=$2" >>"$ENVF"; fi
}
if [ ! -f "$ENVF" ]; then
  cp "$BUNDLE/docker/env.template" "$ENVF"
  chmod 600 "$ENVF"
  for k in ELASTIC_PASSWORD MYSQL_PASSWORD MINIO_PASSWORD REDIS_PASSWORD ADMIN_DEFAULT_PASSWORD; do set_env "$k" "$(rand 24)"; done
  set_env SECRET_KEY "$(rand 64)"
  # 这些变量只用在端口映射上；全部只绑本机，公网只留 nginx 的 80/443
  for kv in ES_PORT=1200 EXPOSE_MYSQL_PORT=3306 MINIO_PORT=9000 MINIO_CONSOLE_PORT=9001 REDIS_PORT=6379 \
            SVR_WEB_HTTP_PORT=8080 SVR_WEB_HTTPS_PORT=8443 SVR_HTTP_PORT=9380 ADMIN_SVR_HTTP_PORT=9381 \
            SVR_MCP_PORT=9382 GO_HTTP_PORT=9384 GO_ADMIN_PORT=9383; do
    set_env "${kv%%=*}" "127.0.0.1:${kv#*=}"
  done
  set_env HF_ENDPOINT https://hf-mirror.com
  set_env TZ Asia/Shanghai
  # Elasticsearch 默认占 8G，16G 的机器给它 6G，留够内存给 RAGFlow 解析文件
  [ "$mem_gb" -ge 24 ] || set_env MEM_LIMIT 6442450944
fi
set_env RAGFLOW_IMAGE "$RAGFLOW_IMAGE"
cd "$RF/docker"
for i in 1 2 3; do
  docker compose pull && break
  [ "$i" = 3 ] && { echo "镜像拉取失败：检查 /etc/docker/daemon.json 里的镜像加速器地址" >&2; exit 1; }
  echo "拉取失败，30 秒后重试（第 $i 次）"
  sleep 30
done
docker compose up -d
echo "等 RAGFlow 启动（第一次大概 3 到 10 分钟）"
for i in $(seq 1 240); do
  curl -sf -o /dev/null --max-time 5 http://127.0.0.1:9380/api/v1/system/healthz && break
  [ "$i" = 240 ] && { echo "RAGFlow 20 分钟还没起来，看日志：cd $RF/docker && docker compose logs --tail 100 ragflow-cpu" >&2; exit 1; }
  sleep 5
done
echo "RAGFlow 已启动"

step "RAGFlow 初始化：管理员账号、百炼模型、API Key"
if [ ! -s "$SECRETS/ragflow_admin" ]; then
  printf 'admin@kefu.local\n%s\n' "$(rand 20)" >"$SECRETS/ragflow_admin"
  chmod 600 "$SECRETS/ragflow_admin"
fi
RF_EMAIL=$(sed -n 1p "$SECRETS/ragflow_admin")
RF_PASSWORD=$(sed -n 2p "$SECRETS/ragflow_admin")
MODEL_KEY=$(cat "$SECRETS/llm_api_key")
MODEL_PROVIDER=bailian
export RF_EMAIL RF_PASSWORD MODEL_KEY MODEL_PROVIDER CHAT_MODEL EMBED_MODEL VISION_MODEL
token=$(docker compose exec -T -w /ragflow -e RF_EMAIL -e RF_PASSWORD -e MODEL_KEY -e MODEL_PROVIDER \
          -e CHAT_MODEL -e EMBED_MODEL -e VISION_MODEL ragflow-cpu python3 - <"$BUNDLE/bootstrap.py" | tail -1) || token=""
unset RF_PASSWORD MODEL_KEY
[ -n "$token" ] || { echo "RAGFlow 初始化失败，原因见上面；修好后重新运行本脚本即可" >&2; exit 1; }
printf %s "$token" >"$SECRETS/ragflow_api_key"
chmod 600 "$SECRETS/ragflow_api_key"
unset token

step "客服平台"
tenant=${DEFAULT_TENANT:-}
if [ -z "$tenant" ] && [ -n "$EXPORT" ]; then
  tenant=$(tar -xzOf "$EXPORT" manifest.json | python3 -c 'import json, sys; print(json.load(sys.stdin)["slug"])')
fi
RAGFLOW_URL=http://127.0.0.1:9380/api/v1 RAGFLOW_CHAT_MODEL="$CHAT_MODEL" RAGFLOW_EMBED_MODEL="$EMBED_MODEL" \
  LLM_BASE_URL="$BAILIAN" JUDGE_MODEL="$JUDGE_MODEL" DEFAULT_TENANT="${tenant:-muxu}" \
  bash "$SRC/deploy/install.sh"

if [ -n "$EXPORT" ]; then
  step "导入客户 $tenant（资料要在百炼上重新算向量，几百份文件大概 10 到 40 分钟）"
  cd "$APP"
  if .venv/bin/python migrate.py import "$EXPORT"; then
    systemctl restart muxu
  else
    echo "导入没成功，原因见上面。修好后单独重跑：cd $APP && .venv/bin/python migrate.py import $EXPORT" >&2
  fi
fi

ip=$(curl -s --max-time 3 http://100.100.100.200/latest/meta-data/eipv4 || true)
[ -n "$ip" ] || ip=$(curl -s --max-time 3 http://100.100.100.200/latest/meta-data/public-ipv4 || true)
[ -n "$ip" ] || ip="<服务器公网IP>"
cat <<EOF

======================== 装好了 ========================
运营台      http://$ip/muxu/console/
            平台管理员 admin@muxu.local，初始密码：cat /var/lib/muxu/.admin_password
咨询页      http://$ip/muxu/${tenant:+（就是 $tenant；其他客户是 /muxu/c/客户代号/）}
RAGFlow     只开在本机，要看后台就在自己电脑上运行：
              ssh -L 8080:127.0.0.1:8080 root@$ip
            然后打开 http://localhost:8080，账号密码：cat $SECRETS/ragflow_admin
模型        问答 $CHAT_MODEL，向量 $EMBED_MODEL，识图 $VISION_MODEL，评分和起草 $JUDGE_MODEL（都在百炼）
密钥和密码  $SECRETS/、$ENVF（权限 600，别外传）
========================================================
EOF
