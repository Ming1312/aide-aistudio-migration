#!/usr/bin/env bash
# start_tunnel.sh — 開啟 Cloudflare Quick Tunnel（臨時「公開」HTTPS 網址）。
#   只能由你在終端機「手動」執行，並在提示時親自輸入確認句；不能在管線、cron、背景或自動化裡執行。
#   執行前會再次確認：引擎在本機健康、確實唯讀、寫入端點全部拒絕、磁碟空間足夠。任何一項不符就不開。
#   Tunnel 預設 4 小時後自動關閉（AIDE_TUNNEL_MAX_HOURS 可調）；用 ./stop_demo.sh 隨時關閉。
# 用法：  ./start_tunnel.sh
set -Eeuo pipefail
# shellcheck source=lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
sanitize_env

case "${1:-}" in
  -h|--help) awk 'NR>1 && /^#/ {print; next} NR>1 {exit}' "${BASH_SOURCE[0]}"; exit 0 ;;
  "") ;;
  *) die "不認得的參數：$1" ;;
esac

# ---- 0. 必須是真人在終端機前（stdin 與 stdout 都是 tty）
if [ ! -t 0 ] || [ ! -t 1 ] || [ ! -r /dev/tty ]; then
  die "這支腳本只能由人在互動式終端機手動執行（偵測到管線、重新導向或自動化），未開啟任何東西"
fi

TUNNEL_STARTED=0
cleanup() {
  local rc=$?
  if [ "$rc" -ne 0 ] && [ "$TUNNEL_STARTED" = 1 ]; then
    echo "[停止] 驗證沒有通過：立刻關閉 Tunnel" >&2
    kill_tunnel || true
    log_event "start_tunnel FAILED rc=$rc；Tunnel 已關閉"
  fi
}
kill_tunnel() {
  local pid; pid="$(cat "$TUNNEL_PID_FILE" 2>/dev/null || true)"
  if [[ "$pid" =~ ^[0-9]+$ ]] && tunnel_pid_alive; then
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
    kill -KILL -- "-$pid" 2>/dev/null || true
  fi
  rm -f "$TUNNEL_PID_FILE" "$TUNNEL_URL_FILE" "$TUNNEL_STARTED_FILE"
}
trap cleanup EXIT

# ---- 1. 前置條件（全部通過才會走到確認提示）
say "== 1/4 前置檢查（還沒有開任何東西）"
command -v cloudflared >/dev/null 2>&1 || die "沒有安裝 cloudflared（見 README 第一次安裝）"
command -v docker >/dev/null 2>&1 || die "沒有安裝 docker"
[ -f "$ENV_FILE" ] || die "找不到設定檔 $ENV_FILE：請先執行 ./start_local.sh"
if tunnel_pid_alive; then
  say "Tunnel 已經在執行，網址：$(cat "$TUNNEL_URL_FILE" 2>/dev/null || echo '未知')。要關閉請執行 ./stop_demo.sh"
  TUNNEL_STARTED=0; exit 0
fi
bash "$AIDE_KIT_DIR/preflight.sh" --quiet --for-tunnel || die "preflight 有失敗項目，不開 Tunnel"
[ "$(docker inspect -f '{{.State.Health.Status}}' "$ENGINE_CONTAINER" 2>/dev/null || echo none)" = healthy ] || die "引擎容器不是 healthy：請先 ./start_local.sh"
api readonly --base "$BASE_URL" || die "引擎不是唯讀：不開 Tunnel"
api unauth --base "$BASE_URL" || die "無金鑰沒有被擋成 401：不開 Tunnel"
api deny-writes --base "$BASE_URL" || die "寫入端點沒有全部拒絕：不開 Tunnel"
is_ours "$ENGINE_CONTAINER" && is_ours "$CADDY_CONTAINER" || die "容器不屬於 $PROJECT 專案：不開 Tunnel"
caddy_ports_ok || die "Caddy 的連接埠發佈不是『每一行都綁在 $LOCAL_HOST』：不開 Tunnel"
docker port "$CADDY_CONTAINER" | grep -q -- "-> $LOCAL_HOST:$LOCAL_PORT" || die "Caddy 沒有綁在 $LOCAL_HOST:$LOCAL_PORT：不開 Tunnel"
engine_unpublished || die "引擎 8080 被發佈了：不開 Tunnel"
compose_gate || die "compose 設定不符合預期：不開 Tunnel"
g="$(free_gb "$LIVE_STORE_HOST")"
[ -n "$g" ] && [ "$g" -ge "$MIN_FREE_GB" ] || die "磁碟可用空間不足（${g:-?} GB < ${MIN_FREE_GB} GB）：不開 Tunnel。$FREE_NOTE"
kb="$(store_kb || true)"
if [[ "${kb:-}" =~ ^[0-9]+$ ]] && [ $((kb / 1024)) -ge "$WARN_STORE_MB" ]; then
  warn "版本庫已有 $((kb / 1024)) MB（>= ${WARN_STORE_MB} MB）。$FREE_NOTE"
fi
say "前置檢查全部通過。"

# ---- 2. 警告與確認（必須親自輸入）
cat <<EOF

================================ 重要警告 ================================
 Quick Tunnel 會產生一個「臨時的公開網址」（https://隨機名稱.trycloudflare.com）。

  * 這【不是】有身分驗證的私人連線。知道網址的任何人都連得到你這台電腦上的引擎入口。
  * 唯一的保護是：(1) API 金鑰（沒有金鑰的請求一律 401）(2) 唯讀設定（沒有管理金鑰，
    匯入／提交／回復／重算／模擬推進全部 403）(3) Caddy 只轉送 /health 與 /v1/*。
  * /health 不需要金鑰：會公開引擎版本、函式庫版本與各資料集雜湊。
  * Quick Tunnel 由 Cloudflare 終止 TLS：Cloudflare 的邊緣伺服器看得到所有流量，包含 X-API-Key。
    所以這把金鑰只該用在這個展示；用完請換新（刪除 demo.env 後重新 start_local.sh，再更新 AI Studio）。
  * 引擎依來源 IP 限流；經 Tunnel 後所有人共用同一個額度。有人灌請求時，你自己的 App
    可能暫時收到 429（Quick Tunnel 同時最多 200 個處理中請求，超過也回 429）。
  * 網址每次重開都會變；Tunnel 停止後網址立刻失效。官方說明：Quick Tunnel 只供測試與開發，
    沒有可用性保證。
  * 展示資料是合成資料流（帶 SYNTHETIC 標記）與你已聲明可公開展示的七場域資料。
  * 已知限制 F12：唯讀模式下，管理者在 App 按寫入會看到 502「引擎憑證設定有誤」；
    真正原因是這個部署唯讀，不是憑證問題。
  * 這個 Tunnel 會在 ${TUNNEL_MAX_HOURS} 小時後自動關閉。
==========================================================================

EOF
printf '要開啟公開網址，請輸入這句話（完全一樣）：  我了解這是臨時公開網址\n> '
IFS= read -r answer < /dev/tty || answer=""
[ "$answer" = "我了解這是臨時公開網址" ] || die "確認句不符，沒有開啟 Tunnel"

# ---- 3. 開啟（背景、獨立行程群組；最長 TUNNEL_MAX_HOURS 小時）
say "== 3/4 開啟 Quick Tunnel"
secs=$((TUNNEL_MAX_HOURS * 3600))
( umask 077; : > "$TUNNEL_LOG" )
TUNNEL_STARTED=1
setsid bash -c 'echo $$ > "$1"; shift; exec "$@"' _ "$TUNNEL_PID_FILE" \
  timeout --signal=TERM --kill-after=30 "$secs" cloudflared tunnel --no-autoupdate --url "$BASE_URL" \
  >> "$TUNNEL_LOG" 2>&1 < /dev/null &
date +%s > "$TUNNEL_STARTED_FILE"
url=""
for i in $(seq 1 30); do
  url="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | head -n 1 || true)"
  [ -n "$url" ] && break
  # cloudflared 提早結束：把日誌最後兩行（只有 cloudflared 自己的訊息，不含金鑰）直接顯示出來，才知道是限流（429）還是網路問題
  if [ "$i" -gt 5 ]; then tunnel_pid_alive || die "cloudflared 已經結束。日誌最後幾行：$(grep -v '^$' "$TUNNEL_LOG" | tail -n 2 | cut -c1-200 | tr '\n' ' ')（完整日誌：$TUNNEL_LOG）"; fi
  sleep 1
done
[ -n "$url" ] || die "30 秒內沒有取得 Tunnel 網址（日誌：$TUNNEL_LOG）"
( umask 077; printf '%s\n' "$url" > "$TUNNEL_URL_FILE" )

# ---- 4. 從公開網址那一側驗證（任何一項失敗就關掉）
say "== 4/4 從公開網址驗證"
ok=0
# 新的 trycloudflare 主機名稱的 DNS 通常要 1 分鐘左右才解析得到（第二次實跑：45 秒不夠就被誤判失敗）。最多等 3 分鐘；仍然 fail-closed。
say "（新網址的 DNS 需要一點時間，最多等 3 分鐘）"
for _ in $(seq 1 60); do
  if curl -fsS --noproxy '*' --max-time 10 "$url/health" >/dev/null 2>&1; then ok=1; break; fi
  sleep 3
done
[ "$ok" = 1 ] || die "公開網址 $url 的 /health 等了 3 分鐘仍沒有回應（DNS 或 Cloudflare 邊緣尚未就緒；Tunnel 已關閉，可稍後重試）"
api readonly --base "$url" || die "公開側看到的引擎不是唯讀"
api unauth --base "$url" || die "公開側：無金鑰沒有被擋成 401"
api deny-writes --base "$url" || die "公開側：寫入端點沒有全部拒絕"

TUNNEL_STARTED=0
log_event "Tunnel 已開啟（最長 ${TUNNEL_MAX_HOURS} 小時）"
cat <<EOF

Tunnel 已開啟並通過驗證：
  公開網址：$url
  自動關閉：約 ${TUNNEL_MAX_HOURS} 小時後（或執行 ./stop_demo.sh）

接下來由你在 AI Studio 的 Secrets 設定（值只由你填，不要貼到聊天）：
  ENGINE_BASE_URL = $url            （結尾不要加斜線）
  ENGINE_API_KEY  = 本機設定檔裡的 AIDE_API_KEY（用 ./copy_key.sh 複製到剪貼簿，不會顯示）
  ENGINE_ADMIN_KEY：AI Studio 可能要求有這個名稱；請維持隨機佔位字串（不是真的管理金鑰；引擎沒有管理金鑰）。
  不要設定 GEMINI_API_KEY。
用完請執行 ./stop_demo.sh。網址一停就失效；下次重開網址會變，要再改一次 ENGINE_BASE_URL。
EOF
