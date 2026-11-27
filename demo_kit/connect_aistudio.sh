#!/usr/bin/env bash
# connect_aistudio.sh — 一步一步帶你把這台電腦上的引擎接到 AI Studio（Cloudflare Quick Tunnel）。
#   1) 開 Tunnel（./start_tunnel.sh：會顯示警告，要你親自輸入確認句；我不替你輸入）
#   2) 把 Tunnel 網址放進剪貼簿 → 貼到 AI Studio Secrets 的 ENGINE_BASE_URL
#   3) 把引擎讀取金鑰放進剪貼簿（不顯示）→ 貼到 AI Studio Secrets 的 ENGINE_API_KEY
#   4) 提醒怎麼確認、怎麼關閉
# 只能在互動式終端機手動執行。不設定 ENGINE_ADMIN_KEY：引擎維持唯讀。
set -Eeuo pipefail
# shellcheck source=lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
[ -t 0 ] && [ -t 1 ] || die "請在互動式終端機手動執行"

say "== 步驟 1/4  開 Tunnel"
bash "$AIDE_KIT_DIR/start_tunnel.sh"
[ -f "$TUNNEL_URL_FILE" ] || die "沒有取得 Tunnel 網址（上一步沒有成功）"
URL="$(head -n 1 "$TUNNEL_URL_FILE")"
[[ "$URL" =~ ^https://[a-z0-9-]+\.trycloudflare\.com$ ]] || die "網址格式不正確：$URL"

say ""
say "== 步驟 2/4  網址"
say "Tunnel 網址：$URL"
say "已放進剪貼簿。請到 AI Studio → Settings → Secrets，新增（或更新）："
say "    名稱  ENGINE_BASE_URL"
say "    值    貼上（結尾不要加斜線）"
python3 "$AIDE_KIT_DIR/copy_text.py" "$URL" || warn "無法使用剪貼簿，請手動複製上面的網址"

say ""
say "== 步驟 3/4  金鑰（不顯示）"
say "按 Enter 後，金鑰會放進剪貼簿 45 秒（或再按 Enter 立即清空）。貼到 Secrets："
say "    名稱  ENGINE_API_KEY"
say "    值    貼上"
say "不要設 ENGINE_ADMIN_KEY（引擎維持唯讀）。"
printf '準備好了就按 Enter ＞ '
IFS= read -r _ < /dev/tty || true
bash "$AIDE_KIT_DIR/copy_key.sh"

say ""
say "== 步驟 4/4  確認與關閉"
say "1. 儲存 Secrets 後等 AI Studio 重啟；"
say "2. 打開 App：總覽橫幅出現「● 引擎即時（模擬資料流）」，卡片來源變成「引擎・模擬流」就成功；"
say "3. Tunnel 預設 ${TUNNEL_MAX_HOURS:-4} 小時後自動關閉；網址每次重開都會變，要重新貼 ENGINE_BASE_URL；"
say "4. 用完請關閉：  ./stop_demo.sh   （同時關 Tunnel 與容器，不刪資料）"
say "5. 這把金鑰經過 Cloudflare：展示完建議換新（刪除 demo.env 後重新 ./start_local.sh，再更新 AI Studio 的 ENGINE_API_KEY）。"
