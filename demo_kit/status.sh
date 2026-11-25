#!/usr/bin/env bash
# status.sh — 顯示目前狀態（唯讀：只讀取，不啟動、不停止、不改設定、不刪資料；金鑰不會顯示）。
#   引擎／Caddy 狀態、唯讀狀態、Tunnel 狀態、磁碟與版本庫大小、各場域資料版本、成長估計。
# 用法：  ./status.sh [--check-tunnel]
#   --check-tunnel  另外從公開網址那一側打一次 /health 與 401 檢查（會經過網際網路）
# 結束碼：0 正常；1 有警告（例如磁碟偏低、版本庫偏大）；2 有嚴重問題（例如磁碟低於下限、引擎不是唯讀）。
set -Eeuo pipefail
# shellcheck source=lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

CHECK_TUNNEL=0
case "${1:-}" in
  --check-tunnel) CHECK_TUNNEL=1 ;;
  -h|--help) awk 'NR>1 && /^#/ {print; next} NR>1 {exit}' "${BASH_SOURCE[0]}"; exit 0 ;;
  "") ;;
  *) die "不認得的參數：$1" ;;
esac
LEVEL=0
raise() { [ "$1" -gt "$LEVEL" ] && LEVEL="$1"; return 0; }

say "== AIDE 展示狀態  $(date '+%F %T')   DEMO_HOME=$DEMO_HOME"

# ---------------------------------------------------------------- 引擎與 Caddy
say ""; say "[引擎與 Caddy]"
if ! command -v docker >/dev/null 2>&1; then
  say "  docker：未安裝"; raise 2
else
  for c in "$ENGINE_CONTAINER" "$CADDY_CONTAINER"; do
    st="$(docker inspect -f '{{.State.Status}}{{if .State.Health}} / {{.State.Health.Status}}{{end}}' "$c" 2>/dev/null || echo '未建立')"
    say "  $c：$st"
  done
  pub="$(docker port "$CADDY_CONTAINER" 2>/dev/null || true)"
  if [ -n "$pub" ]; then
    say "  Caddy 對主機發佈：$(printf '%s' "$pub" | tr '\n' ' ')"
    if ! loopback_only_text "$pub"; then say "  !! Caddy 發佈到迴路以外的位址"; raise 2; fi
    if ! is_ours "$CADDY_CONTAINER"; then say "  !! $CADDY_CONTAINER 不屬於 $PROJECT 專案（名稱被別的專案佔用）"; raise 2; fi
  fi
  if engine_unpublished; then say "  引擎 8080：未發佈到主機（正確）"; else say "  !! 引擎容器有對主機發佈連接埠"; raise 2; fi
fi

# ---------------------------------------------------------------- 唯讀狀態
say ""; say "[唯讀狀態]"
if h="$(api health --base "$BASE_URL" 2>/dev/null)"; then
  printf '%s\n' "$h" | sed 's/^/  /'
  if api readonly --base "$BASE_URL" >/dev/null 2>&1; then
    say "  → 唯讀：是（沒有管理金鑰，寫入與模擬推進端點全部停用）"
  else
    say "  !! 引擎不是唯讀（live_writes_enabled 或 live_sim_enabled 不是 false）"; raise 2
  fi
  say "  已知限制 F12：唯讀模式下，管理者在 App 按寫入會看到 502「引擎憑證設定有誤」，真正原因是這個部署唯讀。"
else
  say "  引擎沒有回應 $BASE_URL/health（可能沒啟動）"
  raise 1
fi

# ---------------------------------------------------------------- Tunnel
say ""; say "[Quick Tunnel（臨時公開網址，不等於有身分驗證的私人連線）]"
if tunnel_pid_alive; then
  url="$(cat "$TUNNEL_URL_FILE" 2>/dev/null || echo '未知')"
  started="$(cat "$TUNNEL_STARTED_FILE" 2>/dev/null || echo 0)"
  now="$(date +%s)"
  if [[ "$started" =~ ^[0-9]+$ ]] && [ "$started" -gt 0 ]; then
    left=$(( TUNNEL_MAX_HOURS * 3600 - (now - started) ))
    [ "$left" -lt 0 ] && left=0
    left_txt="約 $((left / 60)) 分鐘後自動關閉"
  else
    left_txt="剩餘時間未知"
  fi
  say "  狀態：執行中（公開）   網址：$url   $left_txt"
  say "  !! 目前任何知道網址的人都連得到入口（仍需 API 金鑰才拿得到資料）。用完請 ./stop_demo.sh"
  raise 1
  if [ "$CHECK_TUNNEL" = 1 ] && [ "$url" != "未知" ]; then
    if curl -fsS --noproxy '*' --max-time 10 "$url/health" >/dev/null 2>&1; then
      say "  公開側 /health：200"
      api unauth --base "$url" | sed 's/^/  公開側：/' || { say "  !! 公開側的無金鑰檢查不是 401"; raise 2; }
    else
      say "  公開側 /health：沒有回應"; raise 1
    fi
  fi
else
  say "  狀態：未開啟（沒有公開網址）"
  [ -f "$TUNNEL_PID_FILE" ] && say "  （有過期的 PID 標記；./stop_demo.sh 會清掉）"
fi

# ---------------------------------------------------------------- 磁碟與版本庫
say ""; say "[磁碟與版本庫]"
g="$(free_gb "$LIVE_STORE_HOST")"
if [ -z "$g" ]; then
  say "  無法量測磁碟可用空間"; raise 1
else
  say "  版本庫所在磁碟可用：${g} GB（警告 < ${WARN_FREE_GB} GB；拒絕啟動／開 Tunnel < ${MIN_FREE_GB} GB）"
  if [ "$g" -lt "$MIN_FREE_GB" ]; then say "  !! 低於下限。$FREE_NOTE"; raise 2
  elif [ "$g" -lt "$WARN_FREE_GB" ]; then say "  !  偏低。$FREE_NOTE"; raise 1; fi
fi
kb="$(store_kb 2>/dev/null || true)"
total=""
if [[ "${kb:-}" =~ ^[0-9]+$ ]]; then
  say "  版本庫大小（live_store）：$((kb / 1024)) MB（警告 >= ${WARN_STORE_MB} MB）"
  [ $((kb / 1024)) -ge "$WARN_STORE_MB" ] && { say "  !  版本庫偏大。$FREE_NOTE"; raise 1; }
else
  say "  版本庫大小：容器沒在執行，無法量測（主機目錄的擁有者是 uid $ENGINE_UID，一般使用者讀不到）"
fi

say ""; say "[各場域資料版本]"
if v="$(api versions --base "$BASE_URL" 2>/dev/null)"; then
  printf '%s\n' "$v" | awk -F'\t' '{printf "  %-28s %s\n", $1, $2}'
  total="$(printf '%s\n' "$v" | awk -F'\t' '$1=="total"{print $2}')"
else
  say "  讀不到版本（引擎沒回應，或設定檔缺金鑰）"; raise 1
fi

# 合成資料標記
rc=0; synout="$(api synthetic --base "$BASE_URL" 2>&1)" || rc=$?
case "$rc" in
  0) say "  合成標記：羊舍即時預測所有任務都有 contains_synthetic（$synout）" ;;
  3) say "  合成標記：尚無預測版本" ;;
  *) say "  !! 合成標記檢查未通過：$synout"; raise 2 ;;
esac

# ---------------------------------------------------------------- 成長紀錄與估計（只記錄，不刪除）
if [[ "${kb:-}" =~ ^[0-9]+$ ]] && [[ "${total:-}" =~ ^[0-9]+$ ]] && [ -d "$STATE_DIR" ]; then
  now="$(date +%s)"
  last="$(tail -n 1 "$GROWTH_TSV" 2>/dev/null | cut -f1 || true)"
  if [[ "${last:-}" =~ ^[0-9]+$ ]]; then gap=$((now - last)); else gap=99999; fi
  if [ "$gap" -ge 600 ]; then ( umask 077; printf '%s\t%s\t%s\n' "$now" "$kb" "$total" >> "$GROWTH_TSV" ); fi
  lines=0; [ -f "$GROWTH_TSV" ] && lines="$(wc -l < "$GROWTH_TSV")"
  if [ "$lines" -ge 2 ]; then
    first="$(tail -n 50 "$GROWTH_TSV" | head -n 1)"; lastl="$(tail -n 1 "$GROWTH_TSV")"
    t0="$(printf '%s' "$first" | cut -f1)"; k0="$(printf '%s' "$first" | cut -f2)"
    t1="$(printf '%s' "$lastl" | cut -f1)"; k1="$(printf '%s' "$lastl" | cut -f2)"
    span=$((t1 - t0))
    if [ "$span" -ge 3600 ] && [ "$k1" -ge "$k0" ]; then
      per_day=$(( (k1 - k0) * 86400 / span / 1024 ))
      say ""; say "[成長估計（依 growth.tsv 最近紀錄）]"
      say "  約 ${per_day} MB／天"
      if [ -n "$g" ] && [ "$per_day" -gt 0 ]; then say "  依目前可用空間約可再撐 $(( g * 1024 / per_day )) 天（未計入其他用途）"; fi
      say "  想減緩成長：./start_local.sh --interval 1800（放慢）或 --no-feed（凍結）。$FREE_NOTE"
    else
      say ""; say "[成長估計] 紀錄時間跨度不足 1 小時，再過一陣子執行 ./status.sh 會有估計值"
    fi
  fi
fi

say ""
case "$LEVEL" in
  0) say "總結：正常。" ;;
  1) say "總結：有需要注意的項目（上面標 !）。" ;;
  *) say "總結：有嚴重問題（上面標 !!）。公開網址正在執行的話，建議先 ./stop_demo.sh --tunnel-only。" ;;
esac
exit "$LEVEL"
