#!/usr/bin/env bash
# wrangler 4.x 的热重载有两档毛病：有时整个进程退出，有时进程活着但 worker 假死。
# 这里干脆不用它的热更新：自己轮询源码目录，检测到文件变化就杀掉 wrangler 干净重启。
# 效果：改代码后 1~2 秒内服务恢复最新版本，浏览器刷新即可。
# 退出：Ctrl+C（会杀掉 wrangler 及其 workerd 子进程）。
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MARKER="$(mktemp)"
WRANGLER_PID=""
trap 'kill "$WRANGLER_PID" 2>/dev/null; pkill -P "$WRANGLER_PID" 2>/dev/null; rm -f "$MARKER"; exit 0' INT TERM
touch "$MARKER"

# wrangler 自己也监听 public/ 并触发热重载（会假死），所以 public 也要监控：
# 一旦页面有改动，同样走"杀掉重启"的干净路径，不给 wrangler 自己 reload 的机会
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
    npx wrangler dev &
    WRANGLER_PID=$!
    # 监视 wrangler：进程死了或文件变了都跳出内层循环 → 重启
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
