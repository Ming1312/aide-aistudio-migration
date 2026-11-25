#!/usr/bin/env bash
# 每日備份版本庫（建議用 cron：17 3 * * * /opt/aide/deploy/backup.sh >> /var/log/aide-backup.log 2>&1）
# 備份檔在 /var/backups/aide；請另外把它複製到「這台機器以外」的地方（雲端儲存、你的電腦），沒有異地備份等於沒有備份。
set -euo pipefail
docker exec aide-engine python -m live.backup create /app/data/live_store /backups
# 只保留最近 14 份；保留策略請依你的需要調整
ls -1t /var/backups/aide/aide-live-*.tar.gz 2>/dev/null | tail -n +15 | while read -r f; do rm -f "$f" "$f.manifest.json"; done
