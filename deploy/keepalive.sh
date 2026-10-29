#!/usr/bin/env bash
# 守护：每分钟检查知识库引擎、客服平台和 21048 网关，连续两次不通就重跑 start_ragflow.sh（只补启动挂掉的部分）。
BASE=/home/hubin/ragflow-local
LOG="$BASE/logs/keepalive.log"
mkdir -p "$BASE/logs"

up() { curl -sf --noproxy '*' -o /dev/null --max-time 10 "$1"; }
all_up() {
  up http://127.0.0.1:9380/v1/system/healthz && up http://127.0.0.1:8770/muxu/console/ && up http://127.0.0.1:21048/muxu/
}

echo "$(date '+%F %T') keepalive 启动" >>"$LOG"
while true; do
  if ! all_up; then
    sleep 30
    if ! all_up; then
      echo "$(date '+%F %T') 有服务不通，重新拉起" >>"$LOG"
      bash "$BASE/start_ragflow.sh" >>"$LOG" 2>&1
    fi
  fi
  sleep 60
done
