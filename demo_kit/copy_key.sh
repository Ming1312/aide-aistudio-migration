#!/usr/bin/env bash
# copy_key.sh — 把 AIDE_API_KEY 放進剪貼簿（不顯示、不寫日誌、不放命令列），按 Enter 或 45 秒後自動清空。
# 用在把 ENGINE_API_KEY 貼進 AI Studio Secrets 時。用系統已有的 python3-gi（GTK3），不需要安裝 xclip 等工具。
# 注意：如果你的桌面有「剪貼簿歷史」工具，它可能保存複製過的內容，請自行確認。
set -Eeuo pipefail
# shellcheck source=lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
[ -t 0 ] && [ -t 1 ] || die "請在互動式終端機手動執行（偵測到管線或重新導向），沒有複製任何東西"
[ -f "$ENV_FILE" ] || die "找不到 $ENV_FILE：請先 ./start_local.sh"
[ "$(stat -c %a "$ENV_FILE")" = 600 ] || die "$ENV_FILE 權限不是 600：先 chmod 600 再用"
env_name_set "$ENV_FILE" AIDE_API_KEY || die "設定檔沒有 AIDE_API_KEY"
log_event "copy_key 執行（金鑰未顯示）"
python3 "$AIDE_KIT_DIR/copy_key.py" "$ENV_FILE"
