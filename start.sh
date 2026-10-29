#!/usr/bin/env bash
# 启动木序客服前端（127.0.0.1:8770，由 nginx 挂到 21048 的 /muxu/）
set -euo pipefail
cd "$(dirname "$0")"
LOG="${MUXU_LOG:-$(cd .. && pwd)/logs/muxu.log}"
mkdir -p "$(dirname "$LOG")"
if pgrep -f "uvicorn server:app --host 127.0.0.1 --port 8770" >/dev/null; then
  echo "muxu 已在运行"
  exit 0
fi
nohup python3 -m uvicorn server:app --host 127.0.0.1 --port 8770 --workers 1 >>"$LOG" 2>&1 &
for _ in $(seq 1 20); do
  if curl -sf --noproxy '*' -o /dev/null http://127.0.0.1:8770/muxu/console/; then
    echo "客服平台已启动：咨询页 /muxu/ ，运营台和平台后台 /muxu/console/"
    exit 0
  fi
  sleep 0.5
done
echo "muxu 启动失败，看日志 $LOG" >&2
exit 1
