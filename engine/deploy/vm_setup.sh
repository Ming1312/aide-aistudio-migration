#!/usr/bin/env bash
# 在全新的 Ubuntu 22.04／24.04（x86_64）虛擬機上執行一次：安裝 Docker、建立持久化資料夾。
# 不含任何金鑰；不改防火牆（請在雲端平台的防火牆規則只開 80、443，SSH 限定你的來源）。
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then echo "請用 sudo 執行"; exit 1; fi
apt-get update -y
apt-get install -y docker.io docker-compose-v2 curl ca-certificates
systemctl enable --now docker
mkdir -p /var/lib/aide/live_store /var/backups/aide
chown -R 10001:10001 /var/lib/aide/live_store /var/backups/aide       # 容器內使用者 aide 的 uid
chmod 750 /var/lib/aide /var/backups/aide
echo "完成。下一步：把引擎資料夾放到 /opt/aide（見 docs/13），複製 env.template 成 .env 並填值，然後 docker compose up -d --build"
