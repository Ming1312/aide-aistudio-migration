#!/usr/bin/env bash
# preflight.sh — 啟動前檢查（唯讀：不安裝、不建立、不啟動、不刪除任何東西，也不呼叫 sudo）。
# 用法：  ./preflight.sh [--quiet] [--for-tunnel]
#   --quiet       只顯示警告與失敗
#   --for-tunnel  cloudflared 缺少時視為失敗（預設只警告，因為只有 start_tunnel.sh 需要它）
# 結束碼：0 沒有失敗（可有警告）；1 有失敗。
set -Eeuo pipefail
# shellcheck source=lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

FOR_TUNNEL=0
for a in "$@"; do
  case "$a" in
    --quiet) QUIET=1 ;;
    --for-tunnel) FOR_TUNNEL=1 ;;
    -h|--help) awk 'NR>1 && /^#/ {print; next} NR>1 {exit}' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) die "不認得的參數：$a" ;;
  esac
done

for v in DOCKER_HOST DOCKER_CONTEXT COMPOSE_FILE COMPOSE_PROFILES COMPOSE_ENV_FILES COMPOSE_PROJECT_NAME; do
  if [ -n "${!v:-}" ]; then warn "你的 shell 環境有 $v：腳本會忽略它（避免指到別的 Docker 目標或設定）"; fi
done
sanitize_env

[ "$QUIET" = 1 ] || say "== AIDE 展示 preflight（只檢查，不改變任何東西）  DEMO_HOME=$DEMO_HOME"

# ---------------------------------------------------------------- 1. 基本工具
for t in bash curl python3 openssl tar sha256sum awk ss df sort; do
  if command -v "$t" >/dev/null 2>&1; then pass "工具：$t"; else fail "缺少工具：$t"; fi
done
[ "$(uname -s)" = Linux ] && pass "作業系統：Linux $(uname -m)" || fail "只支援 Linux"

# ---------------------------------------------------------------- 2. Docker 與 Compose
if command -v docker >/dev/null 2>&1; then
  pass "docker 已安裝：$(docker --version 2>/dev/null | head -n 1)"
  if timeout 15 docker info >/dev/null 2>&1; then
    pass "docker 服務可連線（目前使用者有權限）"
  else
    fail "docker 服務無法連線，或目前使用者沒有權限"
    hint "確認服務已啟動；並把你自己的使用者加入 docker 群組後重新登入（這需要你自己用 sudo 做，本套件不會做）"
  fi
  ep="$(docker_endpoint)"
  case "$ep" in
    unix://*) pass "docker 目標是本機：$ep" ;;
    *) fail "docker 目標不是本機 unix socket（${ep:-讀不到}）：拒絕使用"; hint "切回本機：docker context use default（並確認沒有設 DOCKER_HOST）" ;;
  esac
  cv="$(docker compose version --short 2>/dev/null || true)"
  if [ -z "$cv" ]; then
    fail "找不到 docker compose 外掛（需要 Compose v2）"
  elif ver_ge "$cv" "2.24.0"; then
    pass "docker compose $cv（>= 2.24.0，支援 !override）"
  else
    fail "docker compose $cv 太舊：覆蓋檔使用 !override，需要 >= 2.24.0"
    hint "舊版會把 80/443 一起發佈到所有網路介面，所以一律拒絕；請改用 Docker 官方套件庫的新版（由你安裝）"
  fi
else
  fail "沒有安裝 docker"
  hint "這是第一次安裝步驟，見 README；本套件不會幫你安裝"
fi

# ---------------------------------------------------------------- 3. cloudflared（只有開 Tunnel 才需要）
if command -v cloudflared >/dev/null 2>&1; then
  pass "cloudflared 已安裝：$(cloudflared --version 2>/dev/null | head -n 1)"
else
  if [ "$FOR_TUNNEL" = 1 ]; then fail "沒有安裝 cloudflared（開 Quick Tunnel 需要）"; else warn "沒有安裝 cloudflared：只影響 start_tunnel.sh；本機展示不需要它"; fi
fi
for cfg in "$HOME/.cloudflared/config.yml" "$HOME/.cloudflared/config.yaml" /etc/cloudflared/config.yml /etc/cloudflared/config.yaml; do
  if [ -e "$cfg" ]; then warn "發現 cloudflared 設定檔 $cfg：可能讓 Quick Tunnel 行為不同；請確認它不是你的其他 Tunnel"; fi
done

# ---------------------------------------------------------------- 4. 套件檔案與 SHA-256
for f in lib.sh demo_api.py docker-compose.demo.yml preflight.sh start_local.sh start_tunnel.sh stop_demo.sh status.sh; do
  [ -f "$AIDE_KIT_DIR/$f" ] && pass "套件檔案：$f" || fail "套件檔案缺少：$f"
done
if [ -f "$BUNDLE_PATH" ]; then
  actual="$(sha256sum "$BUNDLE_PATH" | awk '{print $1}')"
  if [ "$actual" = "$EXPECTED_ENGINE_SHA256" ]; then
    pass "引擎封包 SHA-256 相符（$BUNDLE_NAME）"
  else
    fail "引擎封包 SHA-256 不符：預期 $EXPECTED_ENGINE_SHA256，實際 $actual"
    hint "不要使用舊版封包（ffd4ec6f… 已失效）；請從 repo 分支 ci/docker-acceptance 的 ci/inputs/ 取得正確檔案"
  fi
else
  fail "找不到引擎封包：$BUNDLE_PATH"
  hint "把 $BUNDLE_NAME 放到 $(dirname "$BUNDLE_PATH")/（或用 AIDE_BUNDLE 指定路徑）"
fi

if [ -d "$ENGINE_DIR" ]; then
  marker="$ENGINE_ROOT/.bundle_sha256"
  if [ -f "$marker" ] && [ "$(cat "$marker")" = "$EXPECTED_ENGINE_SHA256" ]; then
    pass "已解開的引擎目錄來自通過驗證的封包"
  else
    fail "已解開的引擎目錄沒有『來自正確封包』的標記（$marker）"
    hint "不確定來源的目錄不會被使用；請把 $ENGINE_ROOT 改名備份後重跑 start_local.sh（它會重新驗證並解開；不會動 live_store）"
  fi
  for f in Dockerfile .dockerignore VERSION main.py deploy/docker-compose.yml deploy/Caddyfile; do
    [ -e "$ENGINE_DIR/$f" ] && pass "引擎檔案：$f" || fail "引擎檔案缺少：$f"
  done
  if [ -f "$ENGINE_DIR/VERSION" ] && head -n 1 "$ENGINE_DIR/VERSION" | grep -q "^$EXPECTED_ENGINE_VERSION_PREFIX"; then
    pass "引擎版本：$(head -n 1 "$ENGINE_DIR/VERSION")"
  else
    fail "引擎 VERSION 不是 $EXPECTED_ENGINE_VERSION_PREFIX"
  fi
    # 決定暴露面的四個檔案，必須與已驗證封包內的逐位元相同
  chk_hash() {  # 檔案 預期雜湊
    local got; got="$(sha256sum "$ENGINE_DIR/$1" 2>/dev/null | awk '{print $1}')"
    if [ "$got" = "$2" ]; then pass "雜湊相符：$1"; else fail "$1 與已驗證封包不同（被改過？）"; hint "不確定來源的目錄不會被使用；改名備份 $ENGINE_ROOT 後重跑 start_local.sh 會重新解開"; fi
  }
  chk_hash deploy/docker-compose.yml "$EXPECTED_COMPOSE_SHA256"
  chk_hash deploy/Caddyfile "$EXPECTED_CADDYFILE_SHA256"
  chk_hash Dockerfile "$EXPECTED_DOCKERFILE_SHA256"
  chk_hash .dockerignore "$EXPECTED_DOCKERIGNORE_SHA256"
  # 封包裡的 compose 必須仍是「引擎只 expose、不發佈 8080」的版本
  if grep -Eq '^[[:space:]]+-[[:space:]]*"?[0-9.:]*8080:8080' "$ENGINE_DIR/deploy/docker-compose.yml" 2>/dev/null; then
    fail "compose 檔把 8080 發佈到主機（不允許）"
  else
    pass "compose 檔沒有發佈引擎的 8080"
  fi
else
  [ "$QUIET" = 1 ] || say "[ 資訊 ] 引擎尚未解開（第一次執行 start_local.sh 時會先驗證 SHA-256 再解開）"
fi

# ---------------------------------------------------------------- 5. 磁碟空間
for target in "$DEMO_HOME" "$LIVE_STORE_HOST"; do
  g="$(free_gb "$target")"
  if [ -z "$g" ]; then
    fail "無法量測 $target 的可用空間"
  elif [ "$g" -lt "$MIN_FREE_GB" ]; then
    fail "$target 所在磁碟只剩 ${g} GB（< ${MIN_FREE_GB} GB）：拒絕啟動"; hint "$FREE_NOTE"
  elif [ "$g" -lt "$WARN_FREE_GB" ]; then
    warn "$target 所在磁碟剩 ${g} GB（< ${WARN_FREE_GB} GB）"
  else
    pass "$target 所在磁碟可用 ${g} GB"
  fi
done

# ---------------------------------------------------------------- 6. 連接埠
listeners="$(port_listeners "$LOCAL_PORT" || true)"
if [ -z "$listeners" ]; then
  pass "本機連接埠 $LOCAL_PORT 空閒"
elif command -v docker >/dev/null 2>&1 && docker port "$CADDY_CONTAINER" 2>/dev/null | grep -q "^80/tcp -> $LOCAL_HOST:$LOCAL_PORT"; then
  pass "連接埠 $LOCAL_PORT 目前由 $CADDY_CONTAINER 使用（只綁 $LOCAL_HOST）"
else
  fail "連接埠 $LOCAL_PORT 已被其他程式使用：$(echo "$listeners" | tr '\n' ' ')"
fi
if port_listeners 8080 | grep -Evq '^(127\.0\.0\.1|\[::1\]):' 2>/dev/null; then
  warn "本機有程式在非迴路位址監聽 8080（不是本套件的；本套件不會發佈引擎的 8080）"
fi

# ---------------------------------------------------------------- 7. 持久化目錄（需要你自己用 sudo 建立）
for d in "$LIVE_STORE_HOST" "$BACKUP_HOST"; do
  if [ -d "$d" ]; then
    owner="$(stat -c %u "$d" 2>/dev/null || echo '?')"
    if [ "$owner" = "$ENGINE_UID" ]; then pass "持久化目錄 $d（擁有者 uid $ENGINE_UID）"; else fail "$d 的擁有者是 uid $owner，需要 $ENGINE_UID"; hint "sudo chown $ENGINE_UID:$ENGINE_UID $d   （你自己執行；絕對不要 chown -R 到別的資料）"; fi
  else
    fail "持久化目錄不存在：$d"
    hint "sudo install -d -o $ENGINE_UID -g $ENGINE_UID -m 750 $LIVE_STORE_HOST $BACKUP_HOST   （你自己執行一次）"
  fi
done

# ---------------------------------------------------------------- 8. 設定檔與唯讀守門
if [ -f "$ENV_FILE" ]; then
  mode="$(stat -c %a "$ENV_FILE" 2>/dev/null || echo '?')"
  if [ "$mode" = 600 ]; then pass "設定檔權限 600"; else fail "設定檔權限是 $mode，必須是 600"; hint "chmod 600 \"$ENV_FILE\""; fi
  if problem="$(env_file_problem "$ENV_FILE")"; then
    pass "設定檔通過白名單檢查（只有允許的名稱；沒有管理金鑰、模擬寫入、Gemini、AIDE_DATA_DIR）；金鑰不顯示"
  else
    fail "設定檔不合格：$problem"
    hint "請自己編輯 $ENV_FILE（本套件不會幫你改）；要重新產生就刪掉它再跑 start_local.sh（會換新金鑰）"
  fi
else
  [ "$QUIET" = 1 ] || say "[ 資訊 ] 設定檔尚未建立（第一次執行 start_local.sh 時會產生並設成權限 600）"
fi
for v in AIDE_ADMIN_KEY AIDE_ALLOW_SIM ENGINE_ADMIN_KEY GEMINI_API_KEY GOOGLE_API_KEY; do
  if [ -n "${!v:-}" ]; then warn "你的 shell 環境有 $v：腳本會把它清掉，不會傳給引擎"; fi
done

# 容器名稱撞到別的專案：不碰別人的容器
for c in "$ENGINE_CONTAINER" "$CADDY_CONTAINER"; do
  if docker inspect "$c" >/dev/null 2>&1 && ! is_ours "$c"; then
    fail "已經有一個不屬於 $PROJECT 專案、名稱也叫 $c 的容器：拒絕啟動（不會動它）"
  fi
done

# ---------------------------------------------------------------- 9. 目前是否已有公開網址
if tunnel_pid_alive; then warn "Quick Tunnel 目前正在執行（網址：$(cat "$TUNNEL_URL_FILE" 2>/dev/null || echo '未知')）"; else pass "目前沒有本套件開的 Tunnel"; fi

[ "$QUIET" = 1 ] && [ "$FAIL_N" -eq 0 ] && exit 0   # --quiet 且沒有失敗：不再印總結（警告已在上面印過）
say ""
say "結果：通過 $PASS_N 項、警告 $WARN_N 項、失敗 $FAIL_N 項"
[ "$FAIL_N" -eq 0 ] || { say "有失敗項目：start_local.sh 會拒絕啟動。"; exit 1; }
exit 0
