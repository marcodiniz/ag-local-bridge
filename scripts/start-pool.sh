#!/usr/bin/env bash
# start-pool.sh — Launch headless AG sidecar pool instances (2-5)
# Pool 1 is your main AG window — no need to launch headless.
# Usage: ./scripts/start-pool.sh [start|stop|status]

set -euo pipefail

POOLS=(2 3 4 5)
AG_BIN="/usr/bin/antigravity"
LOG_DIR="/tmp"

start_pool() {
  local n=$1
  local data_dir="$HOME/.ag-pool-$n"
  local log_file="$LOG_DIR/ag-pool-$n.log"
  local pid_file="$LOG_DIR/ag-pool-$n.pid"

  if [ -f "$pid_file" ] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
    echo "Pool $n already running (PID $(cat "$pid_file"))"
    return 0
  fi

  echo -n "Starting pool $n... "
  nohup bash -c "
    while true; do
      xvfb-run -a \"$AG_BIN\" \
        --user-data-dir \"$data_dir\" \
        --disable-gpu \
        --no-sandbox \
        --wait \
        > \"$log_file\" 2>&1
      echo \"[Watchdog] Pool $n crashed or was killed. Respawning in 5 seconds...\" >> \"$log_file\"
      sleep 5
    done
  " > /dev/null 2>&1 &
  local pid=$!
  echo "$pid" > "$pid_file"
  echo "PID $pid (watchdog)"
}

stop_pool() {
  local n=$1
  local pid_file="$LOG_DIR/ag-pool-$n.pid"

  if [ ! -f "$pid_file" ]; then
    echo "Pool $n: no PID file"
    return 0
  fi

  local pid
  pid=$(cat "$pid_file")
  if kill -0 "$pid" 2>/dev/null; then
    echo -n "Stopping pool $n (PID $pid)... "
    # Kill the entire process group spawned by the pool
    pkill -P "$pid" 2>/dev/null || true
    kill "$pid" 2>/dev/null || true
    sleep 1
    kill -9 "$pid" 2>/dev/null || true
    echo "done"
  else
    echo "Pool $n: not running"
  fi
  rm -f "$pid_file"
}

status_pool() {
  local n=$1
  local pid_file="$LOG_DIR/ag-pool-$n.pid"
  local sidecar_info

  if [ -f "$pid_file" ] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
    sidecar_info=$(ps aux | grep language_server_linux_x64 | grep -v grep | grep -v enable_lsp | grep -v workspace_id || true)
    echo "Pool $n: RUNNING (PID $(cat "$pid_file"))"
  else
    echo "Pool $n: STOPPED"
  fi
}

case "${1:-status}" in
  start)
    for n in "${POOLS[@]}"; do
      start_pool "$n"
      sleep 3  # stagger to avoid RAM spikes
    done
    echo ""
    echo "Waiting 20s for sidecars to initialize..."
    sleep 20
    echo ""
    echo "=== Sidecar Discovery ==="
    ps aux | grep language_server_linux_x64 | grep -v grep | \
      awk '{
        csrf = ""; port = "";
        if (match($0, /--csrf_token [a-f0-9-]+/)) {
          csrf = substr($0, RSTART + 13, RLENGTH - 13);
        }
        if (match($0, /--extension_server_port [0-9]+/)) {
          port = substr($0, RSTART + 24, RLENGTH - 24);
        }
        printf "  PID=%-8s Port=%-6s CSRF=%s\n", $2, port, csrf
      }'
    echo ""
    echo "Total sidecars: $(ps aux | grep language_server_linux_x64 | grep -v grep | wc -l)"
    ;;
  stop)
    for n in "${POOLS[@]}"; do
      stop_pool "$n"
    done
    # Also kill any orphan AG pool processes
    pkill -f "ag-pool-[2-5]" 2>/dev/null || true
    ;;
  status)
    for n in "${POOLS[@]}"; do
      status_pool "$n"
    done
    echo ""
    echo "=== All Sidecars ==="
    ps aux | grep language_server_linux_x64 | grep -v grep | \
      awk '{
        csrf = ""; port = "";
        if (match($0, /--csrf_token [a-f0-9-]+/)) {
          csrf = substr($0, RSTART + 13, RLENGTH - 13);
        }
        if (match($0, /--extension_server_port [0-9]+/)) {
          port = substr($0, RSTART + 24, RLENGTH - 24);
        }
        printf "  PID=%-8s Port=%-6s CSRF=%s RSS=%dMB\n", $2, port, csrf, $6/1024
      }'
    ;;
  *)
    echo "Usage: $0 [start|stop|status]"
    exit 1
    ;;
esac
