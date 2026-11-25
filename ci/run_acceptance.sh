#!/usr/bin/env bash
# AIDE Docker／Caddy／整合驗收（在隔離的 GitHub-hosted runner 上執行）
#   - 不申請正式 TLS 憑證（AIDE_DOMAIN=http://:80）；Caddy 只綁 127.0.0.1:8088；不推送任何映像；不使用任何 repo secret
#   - 金鑰是這支腳本臨時產生的亂數，用 ::add-mask:: 遮蔽，只存在 runner 上
# 用法：從 repo 根目錄執行  bash ci/run_acceptance.sh
set -Eeuo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="${WORK:-${RUNNER_TEMP:-/tmp}/aide-ci}"
LOGS="$WORK/logs"
SUMMARY="${GITHUB_STEP_SUMMARY:-$WORK/summary.md}"
PROJECT=aide-ci
NODE_GOOD=3000
NODE_BAD=3002
BASE=http://127.0.0.1:8088
CHECKS="python3 $REPO/ci/checks.py"
STEPS=()

rm -rf "$WORK"; mkdir -p "$LOGS"
: > "$SUMMARY"

step()  { echo; echo "::group::$*"; CUR="$*"; }
ok()    { echo "::endgroup::"; echo "[PASS] $CUR"; STEPS+=("✅ $CUR"); }
fail()  { echo "::endgroup::"; echo "[FAIL] $CUR"; STEPS+=("❌ $CUR"); }
die()   { echo "::error::$*"; return 1; }   # return 1 會觸發 ERR trap（印出狀態、收尾、非 0 結束）

on_error() {
  local code=$?
  trap - ERR
  fail "${CUR:-未知步驟}（結束碼 $code）"
  echo "---- docker compose ps ----"; (cd "$ENGINE_DIR/deploy" 2>/dev/null && docker compose -p $PROJECT ps -a) || true
  echo "---- engine 最後 40 行（金鑰已被遮蔽）----"; docker logs aide-engine --tail 40 2>&1 || true
  echo "---- caddy 最後 20 行 ----"; docker logs aide-caddy --tail 20 2>&1 || true
  finish "$code"
}
finish() {
  local code="${1:-0}"
  {
    echo "## AIDE Docker／Caddy 驗收"
    echo
    printf '%s\n' "${STEPS[@]}"
    echo
    echo "| 項目 | 版本／雜湊 |"; echo "|---|---|"
    echo "| Python 引擎封包 | \`$(cat "$ENGINE_DIR/VERSION" 2>/dev/null)\`，SHA-256 \`${ENGINE_SHA:-?}\` |"
    echo "| Node／React App（Build Mode 匯出） | package.json \`${APP_NAME:-?} ${APP_VER:-?}\`，zip SHA-256 \`${APP_SHA:-?}\` |"
    echo "| docker compose | \`$(docker compose version --short 2>/dev/null)\` |"
  } >> "$SUMMARY"
  # 收尾：停容器、停 Node、清掉暫存金鑰檔；日誌先掃過金鑰再留下
  for f in "$WORK"/node_*.pid; do [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null || true; done
  if [ -d "${ENGINE_DIR:-/nonexistent}/deploy" ]; then
    (cd "$ENGINE_DIR/deploy" && docker compose -p $PROJECT logs --no-color > "$LOGS/compose.log" 2>&1) || true
    (cd "$ENGINE_DIR/deploy" && docker compose -p $PROJECT down -v --remove-orphans >> "$LOGS/compose.log" 2>&1) || true
  fi
  if [ -n "${AIDE_API_KEY:-}" ]; then
    hits=$(grep -rlF -e "$AIDE_API_KEY" -e "$AIDE_ADMIN_KEY" -e "${TEST_ADMIN_PASSPHRASE:-@@none@@}" "$LOGS" 2>/dev/null | wc -l || true)
    if [ "${hits:-0}" != "0" ]; then echo "::error::日誌含有金鑰值，已刪除日誌"; rm -rf "$LOGS"; mkdir -p "$LOGS"; code=1; fi
  fi
  rm -f "$ENGINE_DIR/deploy/.env" 2>/dev/null || true
  exit "$code"
}
trap on_error ERR
ENGINE_DIR="$WORK/engine/aide"

# ------------------------------------------------------------------ 1. 輸入檔雜湊
step "1 驗證輸入檔 SHA-256（不符就停止，不用舊版冒充）"
cd "$REPO"
grep -v '^#' ci/EXPECTED_SHA256 | sha256sum -c -
ENGINE_SHA=$(sha256sum ci/inputs/aide-engine-aistudio-1.0.0-20261123.tar.gz | cut -d' ' -f1)
APP_SHA=$(sha256sum ci/inputs/aide-app-buildmode-export-20261124.zip | cut -d' ' -f1)
ok

# ------------------------------------------------------------------ 2. 解開
step "2 解開 Python 封包與 Node App（各自獨立資料夾）"
mkdir -p "$WORK/engine" "$WORK/app"
tar xzf ci/inputs/aide-engine-aistudio-1.0.0-20261123.tar.gz -C "$WORK/engine"
unzip -q ci/inputs/aide-app-buildmode-export-20261124.zip -d "$WORK/app"
APP_NAME=$(python3 -c "import json;print(json.load(open('$WORK/app/package.json'))['name'])")
APP_VER=$(python3 -c "import json;print(json.load(open('$WORK/app/package.json'))['version'])")
echo "Python 引擎：$(cat "$ENGINE_DIR/VERSION")"
echo "Node App：$APP_NAME $APP_VER"
test -f "$ENGINE_DIR/Dockerfile" && test -f "$ENGINE_DIR/deploy/docker-compose.yml" && test -f "$ENGINE_DIR/deploy/Caddyfile"
ok

# ------------------------------------------------------------------ 3. 建置前：建置內容掃描
step "3 建置前掃描：封包內不得有 .env、金鑰檔、日誌、live_store 內容"
cd "$ENGINE_DIR"
bad=$(find . \( -name '.env' -o -name '.env.*' ! -name '.env.example' -o -name '*.pem' -o -name '*.key' -o -name 'id_rsa*' -o -name '*.log' -o -name 'audit.jsonl' \) -not -path './deploy/*' | head)
[ -z "$bad" ] || die "封包內有不該出現的檔案：$bad"
[ -z "$(find ./data/live_store -type f 2>/dev/null | head -1)" ] || die "封包內有 live_store 內容"
if grep -rIlE -e 'AIza[0-9A-Za-z_-]{30,}' -e '-----BEGIN [A-Z ]*PRIVATE KEY' -e 'ghp_[A-Za-z0-9]{30,}' -e 'sk-[A-Za-z0-9]{30,}' . ; then die "封包內有疑似金鑰字串"; fi
# .env.example 與 env.template 不得帶真值（等號後面只能是空白或 # 註解）
for f in .env.example deploy/env.template; do
  if grep -E '^(AIDE_API_KEY|AIDE_ADMIN_KEY|GEMINI_API_KEY)=[[:space:]]*[^[:space:]#]' "$f"; then die "$f 帶有金鑰值"; fi
done
ok

# ------------------------------------------------------------------ 4. 臨時金鑰與 .env
step "4 產生臨時測試金鑰（遮蔽）、準備 .env 與持久化目錄（比照 vm_setup.sh：擁有者 uid 10001）"
AIDE_API_KEY=$(openssl rand -hex 32); AIDE_ADMIN_KEY=$(openssl rand -hex 32); TEST_ADMIN_PASSPHRASE=$(openssl rand -hex 12)
echo "::add-mask::$AIDE_API_KEY"; echo "::add-mask::$AIDE_ADMIN_KEY"; echo "::add-mask::$TEST_ADMIN_PASSPHRASE"
export AIDE_API_KEY AIDE_ADMIN_KEY TEST_ADMIN_PASSPHRASE
umask 077
cat > "$ENGINE_DIR/deploy/.env" <<EOF
AIDE_DOMAIN=http://:80
AIDE_API_KEY=$AIDE_API_KEY
AIDE_ADMIN_KEY=$AIDE_ADMIN_KEY
AIDE_RATE_PER_MIN=600
AIDE_STALE_AFTER_H=6
AIDE_SIM_FEED=
AIDE_ALLOW_SIM=1
EOF
umask 022
sudo install -d -o 10001 -g 10001 -m 750 /var/lib/aide/live_store /var/backups/aide
ok

# ------------------------------------------------------------------ 5. compose config
step "5 docker compose config（正式檔單獨一次、加 CI 覆蓋檔一次；不得有警告）"
cd "$ENGINE_DIR/deploy"
docker compose version
docker compose -p $PROJECT -f docker-compose.yml config -q 2> "$LOGS/config_prod.err"
[ ! -s "$LOGS/config_prod.err" ] || { cat "$LOGS/config_prod.err"; die "正式 compose 檔有警告"; }
CF=(-p $PROJECT -f docker-compose.yml -f "$REPO/ci/docker-compose.ci.yml")
docker compose "${CF[@]}" config -q 2> "$LOGS/config_ci.err"
[ ! -s "$LOGS/config_ci.err" ] || { cat "$LOGS/config_ci.err"; die "CI compose 組合有警告"; }
docker compose "${CF[@]}" config > "$WORK/compose.resolved.yml"
python3 - "$WORK/compose.resolved.yml" <<'PY'
import sys,re
t=open(sys.argv[1]).read()
assert re.search(r'127\.0\.0\.1.*8088|host_ip: 127\.0\.0\.1', t), "Caddy 沒有綁在 127.0.0.1"
assert not re.search(r'published: "?(80|443)"?\n', t), "CI 不應發佈 80/443"
assert not re.search(r'published: "?8080"?', t), "引擎 8080 不應對外發佈"
print("compose 解析結果：Caddy 只綁 127.0.0.1:8088；引擎 8080 沒有發佈。")
PY
ok

# ------------------------------------------------------------------ 6. Caddy 設定驗證
step "6 Caddy 設定驗證（正式網域形式與 CI 形式）＋轉送規則檢查"
for dom in engine.example.test 'http://:80'; do
  docker run --rm -e AIDE_DOMAIN="$dom" -v "$ENGINE_DIR/deploy/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2 \
    caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1 | tee -a "$LOGS/caddy_validate.log"
done
docker run --rm -e AIDE_DOMAIN=engine.example.test -v "$ENGINE_DIR/deploy/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2 \
  caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile > "$WORK/caddy.json" 2>/dev/null
python3 - "$WORK/caddy.json" <<'PY'
import json,sys
t=open(sys.argv[1]).read(); j=json.loads(t)
assert "engine:8080" in t, "沒有轉送到 engine:8080"
assert '"/health"' in t and '"/v1/*"' in t, "路徑規則不是只有 /health 與 /v1/*"
assert "Not Found" in t, "缺少 404 預設回應"
assert "max_size" in t, "缺少請求大小限制"
print("Caddy 轉送規則符合：只轉送 /health 與 /v1/* 到 engine:8080，其餘 404，有請求大小限制。")
PY
ok

# ------------------------------------------------------------------ 7. 建置
step "7 docker compose build（--no-cache，不推送映像）"
docker compose "${CF[@]}" build --no-cache --progress=plain engine 2>&1 | tee "$LOGS/build.log"
IMG=$(docker compose "${CF[@]}" config --images | grep -v caddy | head -1)
docker image inspect "$IMG" > /dev/null
ok

# ------------------------------------------------------------------ 8. 映像內容檢查
step "8 映像內容檢查：沒有 .env／金鑰／日誌／live_store 內容／deploy 資料夾；以非 root 執行"
CID=$(docker create "$IMG")
docker export "$CID" | tar -t > "$WORK/image_files.txt"
mkdir -p "$WORK/imgfs"; docker export "$CID" | tar -x -C "$WORK/imgfs" --exclude='dev/*' 2>/dev/null || true
docker rm "$CID" > /dev/null
if grep -E '(^|/)(\.env(\..*)?|id_rsa.*|.*\.pem|.*\.key|audit\.jsonl)$' "$WORK/image_files.txt" | grep -v '\.env\.example$' | grep -E '^app/' ; then die "映像內有 .env／金鑰檔"; fi
if grep -E '^app/deploy/' "$WORK/image_files.txt" | head -1 | grep -q .; then die "映像內有 deploy/（應被 .dockerignore 排除）"; fi
if grep -E '^app/data/live_store/.+' "$WORK/image_files.txt" | grep -v '/$' | head -1 | grep -q .; then die "映像內有 live_store 內容"; fi
if grep -E '^app/.*\.(log|pyc)$|__pycache__' "$WORK/image_files.txt" | head -1 | grep -q .; then die "映像內有日誌或 pyc"; fi
grep -rIlF -e "$AIDE_API_KEY" -e "$AIDE_ADMIN_KEY" "$WORK/imgfs/app" && die "映像檔案系統含有測試金鑰"
docker image inspect "$IMG" --format '{{json .Config.Env}}' | grep -qF -e "$AIDE_API_KEY" -e "$AIDE_ADMIN_KEY" && die "映像設定含有測試金鑰"
docker history --no-trunc "$IMG" | grep -qF -e "$AIDE_API_KEY" -e "$AIDE_ADMIN_KEY" && die "映像歷史含有測試金鑰"
grep -qF -e "$AIDE_API_KEY" -e "$AIDE_ADMIN_KEY" "$LOGS/build.log" && die "建置日誌含有測試金鑰"
[ "$(docker image inspect "$IMG" --format '{{.Config.User}}')" = "aide" ] || die "映像不是以 aide 使用者執行"
echo "映像檔數：$(wc -l < "$WORK/image_files.txt")；大小：$(docker image inspect "$IMG" --format '{{.Size}}') bytes"
rm -rf "$WORK/imgfs"
ok

# ------------------------------------------------------------------ 9. 啟動
step "9 docker compose up -d（等待 engine healthy）"
docker compose "${CF[@]}" up -d --no-build
wait_http() { for _ in $(seq 1 40); do curl -fsS --max-time 3 "$BASE/health" >/dev/null 2>&1 && return 0; sleep 2; done; return 1; }
wait_healthy() { for _ in $(seq 1 60); do s=$(docker inspect -f '{{.State.Health.Status}}' aide-engine 2>/dev/null || echo none); [ "$s" = healthy ] && return 0; sleep 3; done; return 1; }
wait_healthy || die "engine 在 180 秒內沒有變成 healthy"
docker compose "${CF[@]}" ps
[ "$(docker inspect -f '{{.State.Running}}' aide-caddy)" = true ]
wait_http || die "Caddy 沒有回應"
ok

# ------------------------------------------------------------------ 10. 引擎＋Caddy 斷言
step "10 引擎／Caddy：/health、401、七場域、寫入需管理金鑰、404 規則、安全標頭、6MB 上限"
$CHECKS engine --base $BASE --caddy 2>&1 | tee "$LOGS/checks_engine.log"
ok

# ------------------------------------------------------------------ 11. 容器互通與隔離
step "11 容器互通：caddy → engine:8080（容器網路）；8080 不對主機發佈；非 root；記憶體上限"
docker compose "${CF[@]}" exec -T caddy wget -qO- http://engine:8080/health | grep -q '"ok":true'
if curl -fsS --max-time 3 http://127.0.0.1:8080/health >/dev/null 2>&1; then die "主機的 127.0.0.1:8080 可以連到引擎（不該對外發佈）"; fi
[ -z "$(docker port aide-engine 2>/dev/null)" ] || die "engine 有對主機發佈連接埠：$(docker port aide-engine)"
[ "$(docker exec aide-engine id -u)" = 10001 ] || die "engine 不是以 uid 10001 執行"
[ "$(docker inspect -f '{{.HostConfig.Memory}}' aide-engine)" = 2147483648 ] || die "engine 記憶體上限不是 2g"
docker exec aide-engine sh -c 'test -w /app/data/live_store' || die "engine 不能寫入 live_store（掛載權限）"
ok

# ------------------------------------------------------------------ 12. Node App 建置與啟動
step "12 Node App：npm install、tsc、單元測試、vite build"
cd "$WORK/app"
npm install --no-audit --no-fund --loglevel=error 2>&1 | tail -3
npx tsc --noEmit
npm test 2>&1 | tee "$LOGS/node_tests.log" | grep -E '^# (tests|pass|fail)'
grep -q '^# fail 0' "$LOGS/node_tests.log"
npx tsx --test server/gemini.test.ts server/overviewStatus.test.ts src/lib/frontendFixes.test.ts src/lib/liveForecast.test.ts 2>&1 | tee "$LOGS/node_tests_frontend.log" | grep -E '^# (tests|pass|fail)'
grep -q '^# fail 0' "$LOGS/node_tests_frontend.log"
npx vite build 2>&1 | tail -2
ok

step "13 Node App → Caddy → 引擎：整合檢查（正確金鑰的 Node 與錯誤金鑰的 Node）"
HASH=$(TP="$TEST_ADMIN_PASSPHRASE" node --experimental-strip-types -e 'import("./reference/adminAuth.ts").then(async m=>process.stdout.write(await m.makeHash(process.env.TP)))')
[ -n "$HASH" ] || die "無法產生管理者密碼雜湊"
start_node() { # port, engine-api-key
  PORT=$1 NODE_ENV=production ENGINE_BASE_URL=$BASE ENGINE_API_KEY=$2 ENGINE_ADMIN_KEY=$AIDE_ADMIN_KEY ADMIN_PASSPHRASE_HASH="$HASH" \
    nohup npx tsx server.ts >> "$LOGS/node_$1.log" 2>&1 &
  echo $! > "$WORK/node_$1.pid"
}
start_node $NODE_GOOD "$AIDE_API_KEY"
start_node $NODE_BAD "wrong-key-for-ci"
for p in $NODE_GOOD $NODE_BAD; do for _ in $(seq 1 30); do curl -fsS "http://127.0.0.1:$p/api/health" >/dev/null 2>&1 && break; sleep 2; done; done
$CHECKS node-online --node http://127.0.0.1:$NODE_GOOD --engine-base $BASE --seed 2>&1 | tee "$LOGS/checks_node.log"
$CHECKS node-badkey --node http://127.0.0.1:$NODE_BAD 2>&1 | tee -a "$LOGS/checks_node.log"
$CHECKS snapshot --base $BASE --file "$WORK/versions.json"
ok

# ------------------------------------------------------------------ 14. 停止／重啟／健康狀態
step "14a 引擎容器 restart：回到 healthy、資料版本保留"
cd "$ENGINE_DIR/deploy"
docker compose "${CF[@]}" restart engine
wait_healthy || die "restart 後 engine 沒有恢復 healthy"
wait_http || die "Caddy 沒有回應"
$CHECKS compare --base $BASE --file "$WORK/versions.json"
$CHECKS engine --base $BASE 2>&1 | tail -3
ok

step "14b 引擎停止：Caddy 回 502/503、Node 轉離線且不回舊資料；啟動後 Node 自動恢復"
docker compose "${CF[@]}" stop engine
$CHECKS engine-down --base $BASE
$CHECKS node-offline --node http://127.0.0.1:$NODE_GOOD
docker compose "${CF[@]}" start engine
wait_healthy || die "start 後 engine 沒有恢復 healthy"
wait_http || die "Caddy 沒有回應"
$CHECKS node-recover --node http://127.0.0.1:$NODE_GOOD
ok

step "14c 整組 down（不刪資料）再 up：資料版本仍保留；磁碟上的版本庫擁有者是 uid 10001"
docker compose "${CF[@]}" down
docker compose "${CF[@]}" up -d --no-build
wait_healthy || die "down/up 後 engine 沒有恢復 healthy"
wait_http || die "Caddy 沒有回應"
$CHECKS compare --base $BASE --file "$WORK/versions.json"
[ "$(sudo stat -c %u /var/lib/aide/live_store)" = 10001 ]
[ -n "$(sudo find /var/lib/aide/live_store -type f | head -1)" ] || die "live_store 沒有任何檔案（持久化沒有生效）"
ok

# ------------------------------------------------------------------ 15. 日誌與收尾
step "15 日誌檢查（引擎／Caddy 日誌不含金鑰）"
docker compose "${CF[@]}" logs --no-color > "$LOGS/compose.log" 2>&1
! grep -qF -e "$AIDE_API_KEY" -e "$AIDE_ADMIN_KEY" -e "$TEST_ADMIN_PASSPHRASE" "$LOGS/compose.log" "$LOGS"/node_*.log
ok

trap - ERR
finish 0
