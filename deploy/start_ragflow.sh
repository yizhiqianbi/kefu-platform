#!/usr/bin/env bash
# Starts RAGFlow v0.27.3 (python backend) without Docker.
# Third-party services: MySQL 3306, Redis 6379, silo(MinIO) 9000, Elasticsearch 1200.
set -e
BASE=/home/hubin/ragflow-local
cd "$BASE/ragflow"
unset CLASSPATH
export PYTHONPATH="$PWD"
export HF_ENDPOINT=https://hf-mirror.com
export NLTK_ALLOW_PROXIED_URLOPEN=1
export REGISTER_ENABLED=0
PY="$PWD/.venv/bin/python"
mkdir -p "$BASE/logs"

pgrep -f mysqld >/dev/null || service mysql start
redis-cli -a infini_rag_flow ping >/dev/null 2>&1 || redis-server --port 6379 --bind 127.0.0.1 --requirepass infini_rag_flow \
  --maxmemory 4gb --maxmemory-policy noeviction --daemonize yes --dir "$BASE" --logfile "$BASE/redis.log"
pgrep -f 'silo server' >/dev/null || (MINIO_ROOT_USER=rag_flow MINIO_ROOT_PASSWORD=infini_rag_flow nohup "$BASE/silo/silo" server "$BASE/data/minio" \
  --address 127.0.0.1:9000 --console-address 127.0.0.1:9011 > "$BASE/minio.log" 2>&1 &)
ES="$BASE/elasticsearch-8.11.3"
pgrep -f org.elasticsearch.bootstrap >/dev/null || su es -c "env -u CLASSPATH -u JAVA_HOME $ES/bin/elasticsearch -d -p $ES/es.pid"
until curl -s -u elastic:infini_rag_flow http://127.0.0.1:1200/_cluster/health >/dev/null; do sleep 2; done

if ! pgrep -f "api/ragflow_server.py" >/dev/null; then
  "$PY" -c "from api.db.db_models import init_database_tables as init_web_db; init_web_db()"
  nohup "$PY" api/ragflow_server.py > "$BASE/logs/server.log" 2>&1 &
fi
JEMALLOC_PATH="$(pkg-config --variable=libdir jemalloc)/libjemalloc.so"
for i in 0 1 2 3; do
  pgrep -f "task_executor.py -i local_$i " >/dev/null || \
    LD_PRELOAD="$JEMALLOC_PATH" nohup "$PY" rag/svr/task_executor.py -i "local_$i" -t common > "$BASE/logs/task_$i.log" 2>&1 &
done
[ -d "$PWD/web/dist" ] && { pgrep -x nginx >/dev/null || nginx -c "$BASE/nginx/nginx.conf"; }
bash "$BASE/muxu/start.sh" || true
pgrep -f "$BASE/keepalive.sh" >/dev/null || (nohup bash "$BASE/keepalive.sh" >/dev/null 2>&1 &)
echo started
