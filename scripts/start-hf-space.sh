#!/bin/sh
set -eu

APP_PORT="${APP_PORT:-7860}"
API_PORT="${PORT:-8787}"
DATA_DIR="${DATA_DIR:-/data}"
CHUNK_DIR="${CHUNK_DIR:-$DATA_DIR/chunks}"

mkdir -p "$DATA_DIR" "$CHUNK_DIR" /run/nginx /var/lib/nginx/tmp /var/log/nginx

sed \
  -e "s/__APP_PORT__/${APP_PORT}/g" \
  -e "s/__API_PORT__/${API_PORT}/g" \
  /app/frontend/nginx.huggingface.conf.template > /etc/nginx/http.d/default.conf

node /app/server/index.js &
api_pid=$!

nginx -g 'daemon off;' &
nginx_pid=$!

cleanup() {
  kill "$api_pid" "$nginx_pid" 2>/dev/null || true
}

trap cleanup INT TERM

while kill -0 "$api_pid" 2>/dev/null && kill -0 "$nginx_pid" 2>/dev/null; do
  sleep 1
done

cleanup
wait "$api_pid" 2>/dev/null || true
wait "$nginx_pid" 2>/dev/null || true
