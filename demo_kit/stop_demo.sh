#!/usr/bin/env bash
# stop_demo.sh — 停止 Tunnel 與容器。【不刪除任何資料】：
#   不使用 docker compose down -v／--volumes、不 rmi、不 prune、不 rm 任何資料目錄；
#   live_store（/var/lib/aide/live_store）、備份目錄、模型、已解開的引擎目錄、映像、設定檔與金鑰都保留。
# 用法：  ./stop_demo.sh [--tunnel-only]
#   --tunnel-only  只關公開網址，容器繼續在本機跑
set -Eeuo pipefail
# shellcheck source=lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

TUNNEL_ONLY=0
case "${1:-}" in
  --tunnel-only) TUNNEL_ONLY=1 ;;
  -h|--help) awk 'NR>1 && /^#/ {print; next} NR>1 {exit}' "${BASH_SOURCE[0]}"; exit 0 ;;
  "") ;;
  *) die "不認得的參數：$1" ;;
esac

# ---------------------------------------------------------------- 1. 先關公開網址
say "== 1/3 Quick Tunnel"
pid="$(cat "$TUNNEL_PID_FILE" 2>/dev/null || true)"
if [ -n "$pid" ] && tunnel_pid_alive; then
  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
  if kill -0 "$pid" 2>/dev/null; then kill -KILL -- "-$pid" 2>/dev/null || true; fi
  say "Tunnel 已關閉（公開網址立刻失效）"
  log_event "Tunnel 已由 stop_demo 關閉"
elif [ -n "$pid" ]; then
  say "PID 檔裡的行程已經不存在或不是 cloudflared（Tunnel 可能已自動到期關閉）；清除過期的標記"
else
  say "沒有由本套件開的 Tunnel"
fi
rm -f "$TUNNEL_PID_FILE" "$TUNNEL_URL_FILE" "$TUNNEL_STARTED_FILE"
# 不是我們開的 cloudflared：只提醒，不動它
others="$(pgrep -af 'cloudflared.*tunnel' 2>/dev/null | grep -F -e "$LOCAL_HOST:$LOCAL_PORT" || true)"
if [ -n "$others" ]; then
  warn "發現其他 cloudflared 行程也指向 $LOCAL_HOST:$LOCAL_PORT（不是本套件開的，我沒有動它）。請自己確認並關閉："
  printf '%s\n' "$others" >&2
fi

if [ "$TUNNEL_ONLY" = 1 ]; then
  say "== 只關了 Tunnel；容器仍在本機執行（$BASE_URL）"
  exit 0
fi

# ---------------------------------------------------------------- 2. 停止並移除容器（不碰資料）
say "== 2/3 容器"
if ! command -v docker >/dev/null 2>&1 || [ ! -d "$DEPLOY_DIR" ]; then
  say "沒有 docker 或引擎目錄，略過容器步驟"
else
  # 注意：這裡刻意沒有 -v／--volumes／--rmi。bind mount（live_store）本來就不會被 down 刪除。
  compose stop
  compose down --remove-orphans
  log_event "容器已停止並移除（資料保留）"
fi

# ---------------------------------------------------------------- 3. 確認資料還在
say "== 3/3 確認資料保留"
for d in "$LIVE_STORE_HOST" "$BACKUP_HOST"; do
  if [ -d "$d" ]; then say "保留：$d"; else warn "找不到 $d（本套件沒有刪它；請確認是不是還沒建立過）"; fi
done
[ -d "$ENGINE_DIR" ] && say "保留：$ENGINE_DIR（模型與引擎程式）"
docker image inspect "$ENGINE_IMAGE" >/dev/null 2>&1 && say "保留：映像 $ENGINE_IMAGE"
[ -f "$ENV_FILE" ] && say "保留：$ENV_FILE（API 金鑰，權限 600）"
say ""
say "已停止。目前沒有任何服務在執行，也沒有公開網址。下次用 ./start_local.sh 啟動；版本紀錄會接續。"
