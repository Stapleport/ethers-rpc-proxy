#!/usr/bin/env bash
# Stapleport Stapleport_worker/ethers-rpc-proxy 双模式部署（CF Worker ethers-rpc-proxy，纯后端 worker 无前端 build 步骤）
# worker 名出处：本仓 wrangler.jsonc name=ethers-rpc-proxy
# 机制：dev = wrangler versions upload（只传版不切流量，版本 id 记 .deploy-pending）
#       promote = 读 .deploy-pending 版本 id → wrangler versions deploy --version-id <id>（提升为生效，可回滚），完毕删记录
#       禁用裸 wrangler deploy（跳确认门立即生效）。
# 用法：./deploy.sh dev|promote；无参 = 打印本用法并 exit 1
set -euo pipefail
cd "$(dirname "$0")"
MODE="${1:-}"
case "$MODE" in
  dev)
    OUT=$(npx wrangler versions upload 2>&1)
    echo "$OUT"
    ID=$(echo "$OUT" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)
    [ -n "$ID" ] || { echo "未从 versions upload 输出抓到版本 id，查上方输出"; exit 1; }
    echo "$ID" > .deploy-pending
    echo "新版已上传未生效：$ID（记入 .deploy-pending）；确认后 ./deploy.sh promote"
    ;;
  promote)
    [ -f .deploy-pending ] || { echo "缺 .deploy-pending：先跑 ./deploy.sh dev"; exit 1; }
    ID=$(cat .deploy-pending)
    npx wrangler versions deploy --version-id "$ID"
    rm -f .deploy-pending
    echo "已提升 $ID 为生效版本（worker: ethers-rpc-proxy）"
    ;;
  *) echo "用法: ./deploy.sh dev|promote（dev=传新版不切流量；promote=提升为生效，需确认）"; exit 1 ;;
esac
