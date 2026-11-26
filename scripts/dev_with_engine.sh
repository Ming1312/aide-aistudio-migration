#!/usr/bin/env bash
# 啟動本 App，並連到你電腦上的分析引擎（demo_kit/start_local.sh 啟動的那一個）。
#   * 引擎網址固定為 http://127.0.0.1:8088（只有這台電腦連得到）。
#   * 讀取金鑰從 ~/aide-demo/state/demo.env 取出，只放進這個 Node 行程的環境變數；不顯示、不寫檔、不記錄。
#   * 不啟動 Docker、不開 Tunnel；引擎沒開時 App 照常用離線預計算結果。
# 用法：  bash scripts/dev_with_engine.sh [PORT]      （預設 3000）
set -Eeuo pipefail
STATE_DIR="${AIDE_DEMO_HOME:-$HOME/aide-demo}/state"
ENV_FILE="$STATE_DIR/demo.env"
[ -f "$ENV_FILE" ] || { echo "找不到 $ENV_FILE：請先執行 demo_kit/start_local.sh 建立引擎" >&2; exit 1; }
key="$(grep -E '^AIDE_API_KEY=[A-Za-z0-9]{32,}$' "$ENV_FILE" | head -n 1 | cut -d= -f2-)"
[ -n "$key" ] || { echo "demo.env 裡沒有有效的 AIDE_API_KEY" >&2; exit 1; }
if ! curl -fsS --max-time 3 http://127.0.0.1:8088/health >/dev/null 2>&1; then
  echo "提醒：http://127.0.0.1:8088 目前連不上引擎（Docker 沒開？）。App 仍會啟動，並使用離線預計算結果。" >&2
fi
export ENGINE_BASE_URL="http://127.0.0.1:8088"
export ENGINE_API_KEY="$key"
export PORT="${1:-3000}"
unset key
cd "$(dirname "${BASH_SOURCE[0]}")/.."
exec npm run dev
