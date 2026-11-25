#!/usr/bin/env bash
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MARKER="$(mktemp)"
WRANGLER_PID=""
trap 'kill "$WRANGLER_PID" 2>/dev/null; pkill -P "$WRANGLER_PID" 2>/dev/null; rm -f "$MARKER"; exit 0' INT TERM
touch "$MARKER"

watch_paths=("$ROOT/src" "$ROOT/lib" "$ROOT/public" "$ROOT/wrangler.jsonc")

changed() {
    local p
    for p in "${watch_paths[@]}"; do
        if [ -e "$p" ]; then
            if [ -f "$p" ]; then
                [ "$p" -nt "$MARKER" ] && return 0
            else
                [ -n "$(find "$p" -newer "$MARKER" -print -quit 2>/dev/null)" ] && return 0
            fi
        fi
    done
    return 1
}

while true; do
    npx wrangler dev --port ${PORT:-8791} --inspector-port ${INSPECTOR_PORT:-9235} &
    WRANGLER_PID=$!
    while kill -0 "$WRANGLER_PID" 2>/dev/null; do
        if changed; then
            touch "$MARKER"
            echo "[dev-loop] 检测到代码变化，重启 wrangler..."
            kill "$WRANGLER_PID" 2>/dev/null
            sleep 1
            pkill -P "$WRANGLER_PID" 2>/dev/null
            break
        fi
        sleep 0.5
    done
    wait "$WRANGLER_PID" 2>/dev/null
    echo "[dev-loop] wrangler 已停止，1 秒后重启（Ctrl+C 结束）..."
    sleep 1
done
