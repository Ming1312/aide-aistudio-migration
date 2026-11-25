#!/usr/bin/env bash
# AIDE 本機唯讀展示套件：共用設定與函式。
# 這個檔案只會被其他腳本 source。source 本身不做任何事（不建立檔案、不啟動任何東西、不讀金鑰）。
# 安全規則（所有腳本共同遵守）：
#   * 金鑰只存在 $STATE_DIR/demo.env（權限 600）；任何腳本都不 cat／echo／記錄它；不用 set -x。
#   * 不設定 AIDE_ADMIN_KEY、AIDE_ALLOW_SIM、ENGINE_ADMIN_KEY、任何 Gemini／Google 金鑰。
#   * 不執行 sudo；需要 sudo 的事只「印出指令」讓使用者自己做。
#   * 不刪除 live_store、模型、版本紀錄；沒有任何 rm -rf 指向資料目錄。

# 不允許在 xtrace 下執行：xtrace 會把金鑰變數的內容印到終端機或日誌
case "$-" in *x*) echo "[停止] 不允許用 bash -x／set -x 執行這個套件（會把金鑰印出來）" >&2; exit 1 ;; esac
case ",${SHELLOPTS:-}," in *,xtrace,*) echo "[停止] 偵測到 SHELLOPTS=xtrace（會把金鑰印出來），請先 unset SHELLOPTS" >&2; exit 1 ;; esac

AIDE_KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---- 位置（可用環境變數覆蓋）
DEMO_HOME="${AIDE_DEMO_HOME:-$HOME/aide-demo}"
BUNDLE_NAME="aide-engine-aistudio-1.0.0-20261123.tar.gz"
BUNDLE_PATH="${AIDE_BUNDLE:-$DEMO_HOME/bundle/$BUNDLE_NAME}"
EXPECTED_ENGINE_SHA256="f088f8ed6795336b523ea62448b79a2d67ee6b709b129bfeee02ee9acc938149"   # 舊的 ffd4ec6f… 已失效，不可使用
EXPECTED_ENGINE_VERSION_PREFIX="aistudio-1.0.0"
# 封包內『會決定暴露面』的檔案雜湊（來自已驗證的封包 f088f8ed…；解開後再核對一次，防止被改過）
EXPECTED_COMPOSE_SHA256="74d6d11467cd126fef72b6239367ff4d84d6ecb660bd009691f4b3d243044553"
EXPECTED_CADDYFILE_SHA256="79d9bda54fedf9aa9810667ca23dd831710755e11ac69c72f2d4d85773b06c76"
EXPECTED_DOCKERFILE_SHA256="e14e5c3b78fc7106eb519d5fdb1da1d46f6c5ba2b784e0f0695bd7942d754b3b"
EXPECTED_DOCKERIGNORE_SHA256="5fcdcb5a5bb3ffd35c10d10139bb5cc1b89ab6f625634bc0191b79eb2b96fc09"
# Caddy 映像固定 digest（Phase 6.7 CI 實際拉到並通過驗收的那一個；不跟隨浮動標籤 caddy:2）
CADDY_IMAGE="caddy:2@sha256:4851e54a46b206517c574821bb5cc67f170d2156041e9fbc4c9193b45e84a75b"
ENGINE_ROOT="$DEMO_HOME/engine"
ENGINE_DIR="$ENGINE_ROOT/aide"
DEPLOY_DIR="$ENGINE_DIR/deploy"
STATE_DIR="$DEMO_HOME/state"
ENV_FILE="$STATE_DIR/demo.env"
TUNNEL_PID_FILE="$STATE_DIR/tunnel.pid"
TUNNEL_URL_FILE="$STATE_DIR/tunnel.url"
TUNNEL_STARTED_FILE="$STATE_DIR/tunnel.started"
TUNNEL_LOG="$STATE_DIR/tunnel.log"
BUILD_LOG="$STATE_DIR/build.log"
EVENT_LOG="$STATE_DIR/demo.log"
GROWTH_TSV="$STATE_DIR/growth.tsv"

# ---- 網路：只綁本機迴路
LOCAL_HOST="127.0.0.1"
LOCAL_PORT="8088"
BASE_URL="http://$LOCAL_HOST:$LOCAL_PORT"
PROJECT="aide-demo"
ENGINE_CONTAINER="aide-engine"
CADDY_CONTAINER="aide-caddy"
ENGINE_IMAGE="${PROJECT}-engine"

# ---- 持久化目錄（與 Phase 6.7 CI 驗過的正式 compose 相同；需要 sudo 建立，由使用者自己做）
LIVE_STORE_HOST="/var/lib/aide/live_store"
BACKUP_HOST="/var/backups/aide"
ENGINE_UID=10001

# ---- 門檻（只用來警告或拒絕啟動；絕不自動刪資料）
MIN_FREE_GB="${AIDE_MIN_FREE_GB:-10}"        # 低於這個值：拒絕啟動／拒絕開 Tunnel
WARN_FREE_GB="${AIDE_WARN_FREE_GB:-20}"      # 低於這個值：警告
WARN_STORE_MB="${AIDE_WARN_STORE_MB:-2048}"  # 版本庫超過這個大小：警告
DEFAULT_INTERVAL_S=900                       # 內部合成資料流每 15 分鐘推進一次（報告建議 300；這裡預設放慢以減少版本成長）
TUNNEL_MAX_HOURS="${AIDE_TUNNEL_MAX_HOURS:-4}"

# 引擎 env 檔「只允許」這些名稱（白名單）；其他任何名稱一律拒絕。
# 例如 AIDE_ADMIN_KEY／AIDE_ALLOW_SIM（開寫入）、GEMINI_*、AIDE_DATA_DIR（會把資料導離持久化掛載）、AIDE_ALLOWED_ORIGINS 都不在內。
ALLOWED_ENV_NAMES='AIDE_DOMAIN|AIDE_API_KEY|AIDE_RATE_PER_MIN|AIDE_STALE_AFTER_H|AIDE_SIM_FEED|AIDE_SIM_INTERVAL_S|AIDE_SIM_HOURS'
FORBIDDEN_ENV_NAMES='AIDE_ADMIN_KEY|AIDE_ALLOW_SIM|ENGINE_ADMIN_KEY|GEMINI_API_KEY|GEMINI_MODEL|GOOGLE_API_KEY|AIDE_DATA_DIR|AIDE_ALLOWED_ORIGINS'

# ---- 輸出（可計數）
PASS_N=0; WARN_N=0; FAIL_N=0; QUIET=0
say()  { printf '%s\n' "$*"; }
pass() { PASS_N=$((PASS_N + 1)); [ "$QUIET" = 1 ] || printf '[ OK ] %s\n' "$*"; }
warn() { WARN_N=$((WARN_N + 1)); printf '[WARN] %s\n' "$*" >&2; }
fail() { FAIL_N=$((FAIL_N + 1)); printf '[FAIL] %s\n' "$*" >&2; }
die()  { printf '[停止] %s\n' "$*" >&2; exit 1; }
hint() { printf '       → %s\n' "$*" >&2; }

# 事件日誌：只記時間與事件名稱，不記任何金鑰或回應本文
log_event() {
  [ -d "$STATE_DIR" ] || return 0
  ( umask 077; printf '%s %s\n' "$(date '+%F %T')" "$*" >> "$EVENT_LOG" ) 2>/dev/null || true
}

# ---- 純函式（沒有副作用，可單獨檢查）
# ver_ge A B：版本 A 是否 >= B（只比較數字與點）
ver_ge() {
  local a="${1#v}" b="${2#v}"
  a="${a%%[!0-9.]*}"; b="${b%%[!0-9.]*}"
  [ -n "$a" ] && [ -n "$b" ] || return 1
  [ "$(printf '%s\n%s\n' "$b" "$a" | sort -V | head -n 1)" = "$b" ]
}

# nearest_existing PATH：往上找第一個存在的目錄（df 需要存在的路徑）
nearest_existing() {
  local p="$1"
  while [ ! -e "$p" ] && [ "$p" != "/" ]; do p="$(dirname "$p")"; done
  printf '%s' "$p"
}

# free_gb PATH：該路徑所在檔案系統的可用空間（整數 GB）
free_gb() {
  df -Pk "$(nearest_existing "$1")" 2>/dev/null | awk 'NR==2 {printf "%d", $4/1024/1024}'
}

# env_has_name FILE NAME_REGEX：env 檔裡有沒有這些名稱的「設定行」（忽略註解行；不輸出任何值）
env_has_name() {
  grep -Eq "^[[:space:]]*(export[[:space:]]+)?($2)[[:space:]]*=" "$1" 2>/dev/null
}

# env_name_set FILE NAME：該名稱是否有非空的值（不輸出值）
env_name_set() {
  grep -Eq "^[[:space:]]*$2[[:space:]]*=[[:space:]]*[^[:space:]#]" "$1" 2>/dev/null
}

# 清掉 shell 環境裡可能讓引擎變成可寫入或啟用 Gemini 的變數（只影響這個腳本的子行程）
# 同時清掉會改變 docker／compose 目標的變數（例如 DOCKER_HOST 指到別台機器、COMPOSE_FILE 換掉設定檔）。
sanitize_env() {
  unset AIDE_ADMIN_KEY AIDE_ALLOW_SIM ENGINE_ADMIN_KEY GEMINI_API_KEY GEMINI_MODEL GOOGLE_API_KEY || true
  unset DOCKER_HOST DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH \
        COMPOSE_FILE COMPOSE_PATH_SEPARATOR COMPOSE_PROFILES COMPOSE_ENV_FILES COMPOSE_PROJECT_NAME \
        COMPOSE_IGNORE_ORPHANS COMPOSE_REMOVE_ORPHANS || true
}

# ---- 指令包裝
compose() {
  docker compose -p "$PROJECT" --project-directory "$DEPLOY_DIR" \
    -f "$DEPLOY_DIR/docker-compose.yml" -f "$AIDE_KIT_DIR/docker-compose.demo.yml" "$@"
}

api() { python3 "$AIDE_KIT_DIR/demo_api.py" --env "$ENV_FILE" "$@"; }

# port_listeners PORT：列出本機正在監聽該埠的位址
port_listeners() { ss -ltn 2>/dev/null | awk -v p=":$1\$" '$4 ~ p {print $4}'; }

# 確認 PID 檔裡的行程真的是我們開的 cloudflared（指令列要有 cloudflared tunnel 與我們的 --url；避免 PID 被重用後誤殺別的行程）
tunnel_pid_alive() {
  [ -f "$TUNNEL_PID_FILE" ] || return 1
  local pid args; pid="$(cat "$TUNNEL_PID_FILE" 2>/dev/null || true)"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  args="$(ps -o args= -p "$pid" 2>/dev/null || true)"
  [[ "$args" == *"cloudflared tunnel"* && "$args" == *"--url $BASE_URL"* ]]
}

# 版本庫大小（KB）：只能從容器內量（主機目錄是 uid 10001 擁有，一般使用者讀不到）
store_kb() {
  is_ours "$ENGINE_CONTAINER" || return 0
  docker exec "$ENGINE_CONTAINER" du -sk /app/data/live_store 2>/dev/null | awk '{print $1}'
}

FREE_NOTE="本套件不會自動刪除任何資料；空間不足時請你自己決定要清理什麼（例如先停止資料流或備份後再處理）。"

# ---------------------------------------------------------------- 設定檔檢查（白名單；只輸出行號與名稱，絕不輸出值）
# 只允許：空行、# 註解行、NAME=值（NAME 為大寫英數底線；值不含空白；不可有 export、引號內換行、行內註解）
env_grammar_problems() {
  awk '/^[[:space:]]*$/ {next} /^[[:space:]]*#/ {next} /^[A-Z][A-Z0-9_]*=[^[:space:]]*$/ {next} {printf "%d ", NR; bad=1} END{exit bad}' "$1"
}
# 不在白名單內的名稱（只列名稱；呼叫前必須先通過 env_grammar_problems，否則可能把非名稱的行當成名稱）
env_unexpected_names() {
  grep -Ev '^[[:space:]]*(#|$)' "$1" | sed -nE 's/^([A-Z][A-Z0-9_]*)=.*/\1/p' | grep -Evx "$ALLOWED_ENV_NAMES" || true
}
# 取非機密欄位的值（不可用於 AIDE_API_KEY）
env_value() { grep -E "^$2=" "$1" 2>/dev/null | tail -n 1 | cut -d= -f2- || true; }
# env_file_problem FILE：有問題就印出一句話（不含任何值）並回傳 1
env_file_problem() {
  local f="$1" lines unexpected n
  lines="$(env_grammar_problems "$f" || true)"
  if [ -n "$lines" ]; then echo "格式不合（第 ${lines}行）：只允許空行、# 註解、NAME=值（值不能含空白、不能有 export 或行內註解）"; return 1; fi
  unexpected="$(env_unexpected_names "$f" | tr '\n' ' ')"
  if [ -n "$unexpected" ]; then echo "含有不在允許清單內的名稱：${unexpected}（只允許 ${ALLOWED_ENV_NAMES//|/、}；管理金鑰、模擬寫入、Gemini、AIDE_DATA_DIR 等一律不允許）"; return 1; fi
  grep -Eq '^AIDE_API_KEY=[A-Za-z0-9]{32,}$' "$f" || { echo "AIDE_API_KEY 缺少，或不是 32 字元以上的英數字"; return 1; }
  [ "$(env_value "$f" AIDE_DOMAIN)" = "http://:80" ] || { echo "AIDE_DOMAIN 必須是 http://:80（不可申請憑證）"; return 1; }
  case "$(env_value "$f" AIDE_SIM_FEED)" in 0|1) ;; *) echo "AIDE_SIM_FEED 必須是 0 或 1"; return 1 ;; esac
  for n in AIDE_RATE_PER_MIN AIDE_STALE_AFTER_H AIDE_SIM_INTERVAL_S AIDE_SIM_HOURS; do
    [[ "$(env_value "$f" "$n")" =~ ^[0-9]+$ ]] || { echo "$n 必須是整數"; return 1; }
  done
  return 0
}

# ---------------------------------------------------------------- 暴露面檢查
# loopback_only_text TEXT：docker port 的輸出，每一行都必須綁在 127.0.0.1；空輸入視為不合格
loopback_only_text() {
  [ -n "$1" ] || return 1
  ! printf '%s\n' "$1" | grep -v -- "-> $LOCAL_HOST:" | grep -q .
}
caddy_ports_ok()   { loopback_only_text "$(docker port "$CADDY_CONTAINER" 2>/dev/null || true)"; }
engine_unpublished() { [ -z "$(docker port "$ENGINE_CONTAINER" 2>/dev/null || true)" ]; }
# is_ours CONTAINER：該容器必須屬於 compose 專案 $PROJECT（避免容器名稱撞到別的專案時，檢查或操作到別人的容器）
is_ours() {
  [ "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$1" 2>/dev/null || true)" = "$PROJECT" ]
}
# 啟動前守門：檢查「真正會被啟動」的 compose 設定（ports、環境、掛載、特權）。輸出只經管線給 python，不會顯示金鑰。
compose_gate() { compose config --format json 2>/dev/null | python3 "$AIDE_KIT_DIR/compose_gate.py" "$CADDY_IMAGE"; }
# Docker 目標必須是本機 unix socket（不是遠端 DOCKER_HOST）
docker_endpoint() { docker context inspect "$(docker context show 2>/dev/null)" --format '{{.Endpoints.docker.Host}}' 2>/dev/null || true; }
