#!/usr/bin/env bash
# start_local.sh — 在你的電腦上啟動 AIDE 引擎（Docker）＋Caddy，唯讀展示模式。
#   * Caddy 只綁 127.0.0.1:8088（只有這台電腦自己連得到）；引擎 8080 不發佈到主機。
#   * 這支腳本不會開 Tunnel、不會碰雲端、不會安裝任何軟體、不會呼叫 sudo。
#   * 第一次執行會：驗證封包 SHA-256 → 解開 → 產生 API 金鑰檔（權限 600，不顯示）→ 建置映像 → 啟動。
# 用法：  ./start_local.sh [--interval 秒數] [--no-feed] [--rebuild]
#   --interval N  內部合成資料流每 N 秒推進一次（預設 900；最小 60）。越短，版本庫長得越快。
#   --no-feed     關閉內部合成資料流（資料凍結，版本庫不再成長；即時預測停在最後一版）
#   --rebuild     重新建置映像（預設只在映像不存在時建置）
# 失敗時：只要容器已經啟動，會自動「停止」容器（不刪任何資料），不會留下半成品服務。
set -Eeuo pipefail
# shellcheck source=lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
sanitize_env

INTERVAL=""; NO_FEED=0; REBUILD=0
while [ $# -gt 0 ]; do
  case "$1" in
    --interval) shift; INTERVAL="${1:-}"; [[ "$INTERVAL" =~ ^[0-9]+$ ]] && [ "$INTERVAL" -ge 60 ] || die "--interval 需要 >= 60 的整數秒數" ;;
    --no-feed) NO_FEED=1 ;;
    --rebuild) REBUILD=1 ;;
    -h|--help) awk 'NR>1 && /^#/ {print; next} NR>1 {exit}' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) die "不認得的參數：$1" ;;
  esac
  shift
done

STARTED=0
cleanup() {
  local rc=$?
  if [ "$rc" -ne 0 ] && [ "$STARTED" = 1 ]; then
    echo "[停止] 啟動沒有完成（結束碼 $rc）：正在停止容器（資料與版本庫不會被刪除）" >&2
    compose stop >/dev/null 2>&1 || true
    log_event "start_local FAILED rc=$rc；容器已停止"
  fi
}
trap cleanup EXIT

say "== 1/8 啟動前檢查"
bash "$AIDE_KIT_DIR/preflight.sh" --quiet || die "preflight 有失敗項目，未啟動任何東西"

# ------------------------------------------------------------------ 2. 解開封包（先驗證，再解開）
say "== 2/8 引擎封包"
if [ ! -d "$ENGINE_DIR" ]; then
  actual="$(sha256sum "$BUNDLE_PATH" | awk '{print $1}')"
  [ "$actual" = "$EXPECTED_ENGINE_SHA256" ] || die "封包 SHA-256 不符，拒絕解開"
  bad="$(tar tzf "$BUNDLE_PATH" | grep -E '^/|(^|/)\.\.(/|$)' || true)"
  [ -z "$bad" ] || die "封包含有絕對路徑或 .. 路徑，拒絕解開"
  # 注意：不能用 `tar tzf | head -n 1 | grep -q`：head 提早結束會讓 tar 收到 SIGPIPE，在 pipefail 下整條管線變成失敗（第一次實跑踩到）。
  # 改用 sed -n 1p：會讀完整份清單，不會提早關閉管線。
  first_entry="$(tar tzf "$BUNDLE_PATH" | sed -n '1p')"
  top_other="$(tar tzf "$BUNDLE_PATH" | grep -v '^aide/' || true)"
  [[ "$first_entry" == aide/* ]] || die "封包最上層不是 aide/，拒絕解開"
  [ -z "$top_other" ] || die "封包含有 aide/ 以外的路徑，拒絕解開"
  mkdir -p "$ENGINE_ROOT"
  tar xzf "$BUNDLE_PATH" -C "$ENGINE_ROOT" --no-same-owner
  printf '%s\n' "$EXPECTED_ENGINE_SHA256" > "$ENGINE_ROOT/.bundle_sha256"
  say "已解開到 $ENGINE_DIR（SHA-256 已驗證）"
else
  say "沿用已解開的 $ENGINE_DIR（preflight 已確認它來自正確封包）"
fi
head -n 1 "$ENGINE_DIR/VERSION" | grep -q "^$EXPECTED_ENGINE_VERSION_PREFIX" || die "引擎版本不是 $EXPECTED_ENGINE_VERSION_PREFIX"

# ------------------------------------------------------------------ 3. 設定檔（金鑰只在這個檔案）
say "== 3/8 設定檔（金鑰不會顯示）"
mkdir -p "$STATE_DIR"; chmod 700 "$STATE_DIR"
if [ ! -f "$ENV_FILE" ]; then
  (
    umask 077
    # 金鑰不放進任何 shell 變數：直接由 openssl 經管線寫進檔案（就算被 xtrace 也看不到值）
    {
      echo "# AIDE 本機唯讀展示設定。這個檔案含有金鑰：權限必須是 600，不要貼到任何地方。"
      echo "# 刻意沒有 AIDE_ADMIN_KEY、AIDE_ALLOW_SIM、任何 Gemini／Google 金鑰（唯讀）。"
      echo "AIDE_DOMAIN=http://:80"
      openssl rand -hex 32 | sed 's/^/AIDE_API_KEY=/'
      echo "AIDE_RATE_PER_MIN=600"
      echo "AIDE_STALE_AFTER_H=6"
      echo "AIDE_SIM_FEED=1"
      echo "AIDE_SIM_INTERVAL_S=$DEFAULT_INTERVAL_S"
      echo "AIDE_SIM_HOURS=1"
    } > "$ENV_FILE"
  )
  say "已建立 $ENV_FILE（權限 600）。金鑰沒有顯示；要貼到 AI Studio 時用 ./copy_key.sh。"
  log_event "env 檔已建立（金鑰未顯示）"
fi
chmod 600 "$ENV_FILE"
if [ -n "$INTERVAL" ]; then sed -i -E "s/^AIDE_SIM_INTERVAL_S=.*/AIDE_SIM_INTERVAL_S=$INTERVAL/" "$ENV_FILE"; fi
if [ "$NO_FEED" = 1 ]; then sed -i -E "s/^AIDE_SIM_FEED=.*/AIDE_SIM_FEED=0/" "$ENV_FILE"; fi
chmod 600 "$ENV_FILE"
if [ -e "$DEPLOY_DIR/.env" ] && [ ! -L "$DEPLOY_DIR/.env" ]; then die "$DEPLOY_DIR/.env 已經是一個一般檔案：不覆蓋，請你自己確認後處理"; fi
ln -sfn "$ENV_FILE" "$DEPLOY_DIR/.env"
# 白名單檢查（在 --interval／--no-feed 修改之後再做）：任何不在清單內的名稱、格式問題、缺值都拒絕啟動
problem="$(env_file_problem "$ENV_FILE")" || die "設定檔不合格：$problem"
feed_now="$(env_value "$ENV_FILE" AIDE_SIM_FEED)"
int_now="$(env_value "$ENV_FILE" AIDE_SIM_INTERVAL_S)"
say "資料流：AIDE_SIM_FEED=$feed_now、每 ${int_now} 秒一輪（合成資料，帶 SYNTHETIC 標記）"

say "== 4/8 再檢查一次（含設定檔）"
bash "$AIDE_KIT_DIR/preflight.sh" --quiet || die "preflight 有失敗項目，未啟動任何東西"

# ------------------------------------------------------------------ 5. compose 設定與建置
say "== 5/8 compose 設定驗證與映像"
# 注意：絕不印出 `compose config` 的完整輸出（它會把 env 檔內容展開，含 API 金鑰）；錯誤訊息也不原樣轉印
if [ -n "$(compose config -q 2>&1 >/dev/null || true)" ]; then die "docker compose config 有警告或錯誤（為避免洩漏設定內容，不顯示細節；請檢查 $DEPLOY_DIR/docker-compose.yml 與 $AIDE_KIT_DIR/docker-compose.demo.yml）"; fi
compose_gate || die "compose 設定不符合『只綁 127.0.0.1:8088、引擎不發佈、唯讀、固定掛載』：未建置也未啟動"
say "compose 守門通過：只綁 127.0.0.1:8088、引擎 8080 不發佈、沒有管理金鑰／Gemini／AIDE_DATA_DIR、掛載固定、Caddy 映像固定 digest"
if [ "$REBUILD" = 1 ] || ! docker image inspect "$ENGINE_IMAGE" >/dev/null 2>&1; then
  say "建置引擎映像（第一次會下載 Python 套件，需要幾分鐘；日誌：$BUILD_LOG）"
  ( umask 077; : > "$BUILD_LOG" )
  if ! compose build engine >> "$BUILD_LOG" 2>&1; then
    tail -n 30 "$BUILD_LOG" >&2
    die "映像建置失敗（完整日誌在 $BUILD_LOG）"
  fi
  log_event "映像已建置"
else
  say "映像 $ENGINE_IMAGE 已存在，略過建置（要重建用 --rebuild）"
fi

# ------------------------------------------------------------------ 6. 啟動
say "== 6/8 啟動容器（只綁 $LOCAL_HOST:$LOCAL_PORT）"
STARTED=1
compose up -d --no-build --force-recreate
healthy=0
for _ in $(seq 1 60); do
  s="$(docker inspect -f '{{.State.Health.Status}}' "$ENGINE_CONTAINER" 2>/dev/null || echo none)"
  if [ "$s" = healthy ]; then healthy=1; break; fi
  sleep 3
done
[ "$healthy" = 1 ] || die "引擎 180 秒內沒有變成 healthy（用 docker logs $ENGINE_CONTAINER --tail 30 查看）"
up=0
for _ in $(seq 1 30); do curl -fsS --noproxy '*' --max-time 3 "$BASE_URL/health" >/dev/null 2>&1 && { up=1; break; }; sleep 2; done
[ "$up" = 1 ] || die "Caddy 沒有回應 $BASE_URL/health"

# ------------------------------------------------------------------ 7. 唯讀與暴露面驗證（任何一項失敗都會停止容器）
say "== 7/8 唯讀與暴露面驗證"
api readonly --base "$BASE_URL" || die "引擎不是唯讀（live_writes_enabled 或 live_sim_enabled 不是 false）"
api unauth --base "$BASE_URL" || die "無金鑰或錯誤金鑰沒有被擋成 401"
api deny-writes --base "$BASE_URL" || die "寫入端點沒有全部拒絕"
is_ours "$ENGINE_CONTAINER" && is_ours "$CADDY_CONTAINER" || die "容器不屬於 $PROJECT 專案（名稱被別的專案佔用？）"
caddy_ports_ok || die "Caddy 的連接埠發佈不是『每一行都綁在 $LOCAL_HOST』（或讀不到）"
engine_unpublished || die "引擎容器有對主機發佈連接埠（8080 不可發佈）"
if port_listeners "$LOCAL_PORT" | grep -v "^$LOCAL_HOST:" | grep -q .; then die "$LOCAL_PORT 有非迴路位址在監聽"; fi
# 先把「名稱」收進變數再比對（只取 = 之前；值不會進變數）。不用 `| grep -q`：提早結束會讓上游 SIGPIPE，pipefail 下可能漏判。
env_names="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$ENGINE_CONTAINER" | cut -d= -f1)"
if grep -Eq "^($FORBIDDEN_ENV_NAMES)$" <<<"$env_names"; then die "引擎容器環境變數含有不允許的名稱"; fi
grep -qx 'AIDE_API_KEY' <<<"$env_names" || die "引擎容器沒有 AIDE_API_KEY（讀取名稱失敗？）"
say "確認：唯讀、寫入端點全部拒絕、只綁 $LOCAL_HOST:$LOCAL_PORT、引擎 8080 未發佈、沒有管理金鑰或 Gemini 設定"

# ------------------------------------------------------------------ 8. 合成標記（等第一個版本；不是致命）
say "== 8/8 合成資料標記檢查（最多等 2 分鐘）"
rc=3
if [ "$feed_now" = 1 ]; then
  for _ in $(seq 1 24); do
    rc=0; api synthetic --base "$BASE_URL" >/dev/null 2>&1 || rc=$?
    [ "$rc" = 3 ] || break
    sleep 5
  done
  case "$rc" in
    0) say "羊舍即時預測的所有任務都標了 contains_synthetic（合成資料）" ;;
    3) warn "還沒有第一個預測版本（資料流需要一點時間）；稍後用 ./status.sh 檢查" ;;
    *) die "即時預測有任務沒有標記為合成資料：停止，請回報" ;;
  esac
else
  say "資料流已關閉（--no-feed）：沒有即時合成資料可檢查"
fi

STARTED=0
log_event "start_local OK（只綁 $LOCAL_HOST:$LOCAL_PORT；interval=$int_now；feed=$feed_now）"
say ""
say "完成。本機網址：$BASE_URL（只有這台電腦連得到）。"
say "目前沒有任何公開網址。要讓 AI Studio 連進來，請先讀 README，再手動執行 ./start_tunnel.sh。"
say "已知限制（F12）：唯讀模式下，管理者在 App 按寫入會看到 502「引擎憑證設定有誤」——真正原因是這個部署唯讀，不是憑證問題。"
