# 部署前檢查清單（AIDE 引擎＋AI Studio App）

> 日期：2026-11-23。本清單依 `docs/13_VM_DEPLOY_STEPS.md` 與第 6.6 階段兩輪驗收整理。
> 我沒有建立任何雲端資源、沒有推送、沒有向你要金鑰。`[ ]` 都是你要做的；金鑰值只填在伺服器 `.env` 與 AI Studio Secrets，不要貼到聊天。

## A　部署封包已過期 → ✅ 已於 2026-11-23 16:35 重新打包並驗證

`outputs/phase6_3/deploy_bundle/aide-engine-aistudio-1.0.0-20261123.tar.gz` 是 02:00 打包的，之後引擎 `main.py`（02:36，第 6.6 階段修正）和 `deploy/env.template`（10:49）又改過。**直接上傳這包會部署到舊版引擎。**

- [x] 已重新打包（314 個檔案，21,865,723 位元組），新雜湊 `f088f8ed6795336b523ea62448b79a2d67ee6b709b129bfeee02ee9acc938149`；上傳到虛擬機後要與這個值逐字比對。重打包指令：
  ```bash
  python tools/p65_make_deploy_bundle.py outputs/phase6_3/aistudio_migration outputs/phase6_3/deploy_bundle
  sha256sum outputs/phase6_3/deploy_bundle/aide-engine-*.tar.gz
  ```
- [x] 新包檔名與舊包相同，已直接覆蓋（舊雜湊以 `ffd4ec6f…` 開頭，不要再用）；抽出新包確認 `main.py`、`deploy/env.template` 與來源逐位元相同，無 `.env`/金鑰檔/`__pycache__`/`live_store`，金鑰樣式掃描 0 筆
- [x] `p63_verify_package.py` 34/34；另從抽出的封包用 uvicorn 啟動：`/health` 200、無金鑰與錯金鑰 `/v1/live/domains` 皆 401、正確金鑰 200、`/docs` 404、日誌無金鑰

## B　在有 Docker 的機器上先驗證（我這台沒有 Docker）

已做的靜態檢查（**不等於**實際建置）：三個 `.sh` 通過 `bash -n`；`docker-compose.yml` 可被 YAML 解析（engine＋caddy、engine 記憶體 2g、健康檢查、只對外 80/443）；Caddyfile 與 Dockerfile 人工檢視無明顯問題。下列項目仍需有 Docker／Caddy 的環境。

可以是任何有 Docker 的電腦，或直接在新虛擬機上做（第一次建置失敗不影響其他東西）。

- [ ] `docker compose config`（在 `deploy/` 目錄、有 `.env` 時）能解析、無警告
- [ ] `docker compose up -d --build` 成功；`docker compose ps` 顯示 engine `healthy`
- [ ] `docker run --rm -v ./Caddyfile:/etc/caddy/Caddyfile caddy:2 caddy validate --config /etc/caddy/Caddyfile`（或等效）通過
- [ ] 憑證：網域 DNS 已指到虛擬機，Caddy 日誌顯示取得 Let's Encrypt 憑證（`docker logs` 看，不會有金鑰）
- [ ] 失敗時把 `docker logs aide-engine --tail 30` 最後 30 行貼給我

## C　雲端虛擬機

- [ ] Ubuntu 24.04 x86_64、2 vCPU、≥4 GB 記憶體、20–30 GB 磁碟、固定外部 IP
- [ ] 防火牆：只開 80、443；SSH 限你的來源 IP；**不開 8080**
- [ ] 只用 SSH 金鑰登入、不用 root；`unattended-upgrades` 已開
- [ ] 網域 A 記錄指到固定 IP（或 `<IP>.sslip.io`）
- [ ] 先在雲端帳號設好**預算警示**（我沒有查證任何價格，以官方試算為準）
- [ ] 封包用 `scp` 上傳；虛擬機上 `sha256sum` 與本機雜湊逐字比對
- [ ] `/opt/aide/deploy/.env` 權限 600；`AIDE_API_KEY`、`AIDE_ADMIN_KEY` 各用一次 `openssl rand -hex 32`，兩個不同；`.env` 值那一行只放值本身，說明寫在 `#` 註解行
- [ ] 依你的決定設定 `AIDE_SIM_FEED` / `AIDE_ALLOW_SIM`（預設開，資料為合成並帶 SYNTHETIC 標記、App 顯示橘色橫幅）

## D　遠端驗收（部署完先做，再接 AI Studio）

- [ ] `AIDE_API_KEY=… AIDE_ADMIN_KEY=… python tools/p65_remote_check.py https://你的網域` 全部 `[OK]`
  （HTTPS 與安全標頭、無金鑰／錯金鑰 401、`/docs` 不對外、七場域預測、守門、寫入需管理金鑰、壞批次被拒且版本不變）
- [ ] 確認 `https://你的網域:8080` 連不上

## E　AI Studio Secrets（只填值）

- [ ] `ENGINE_BASE_URL` = `https://你的網域`（無結尾斜線、無路徑）
- [ ] `ENGINE_API_KEY` = 同 `AIDE_API_KEY`
- [ ] `ENGINE_ADMIN_KEY` = 同 `AIDE_ADMIN_KEY`（畫面上跳出的 `ENGINE_ADMIN_K…` 提示就是這個）
- [ ] `ADMIN_PASSPHRASE_HASH`（格式 `pbkdf2$200000$salt$hash`，用你自己的密碼產生；明文密碼不貼給我）
- [ ] `GEMINI_API_KEY` 與 `GEMINI_MODEL`（你之前授權我改過 `GEMINI_MODEL`，確認仍是你要的值）
- [ ] 存檔後開「即時預測」頁：從「尚未連線」變成狀態卡與預測

## F　上線後驗收（接上之後我可以做）

- [ ] 在已部署的 App 對真引擎重跑：即時預測頁、七場域、管理者登入與推進、回復版本（**F5 回復預設目標還沒實機驗證**，需要至少兩個版本）
- [ ] 真實 Gemini 說明呼叫一次（本機堆疊沒測過）
- [ ] CSV 檔案選取對話框（尚未測）
- [ ] 手機實機看一次
- [ ] 小問題決定：「單位：未標示」（引擎不回單位）、斷線時是否清空畫面（目前保留上次預測並標「自動更新失敗」）

## G　營運

- [ ] 每日備份 cron：`17 3 * * * /opt/aide/deploy/backup.sh >> /var/log/aide-backup.log 2>&1`
- [ ] 備份**複製到虛擬機以外**，並至少演練一次還原（`docs/12` 第 4 節）
- [ ] `healthcheck.sh` 接到你自己的監看（任何場域 `ATTN` 就非 0 結束）
- [ ] 金鑰外洩流程：換 `.env` 值 → `docker compose up -d` → 同步換 AI Studio Secrets → 檢查 `audit.jsonl`
- [ ] 不再使用時整個刪除（虛擬機、磁碟、固定 IP、防火牆規則）；停機後磁碟與 IP 仍計費

## H　你這邊還要清的

- [ ] 刪除 GitHub deploy key：`aide-deploy-phase6.2`、`aide-aistudio-deploy`
- [ ] 要把新的套件檔推到 GitHub，需要新的 deploy key（我不會自己建）
- [ ] 刪除 `~/下載/aide-aistudio-migration.zip` 與 `~/下載/aide-app-source-extra.json`（匯出的 App 原始碼，不需要保留）

## 仍未驗證（誠實清單）

Docker／compose／Caddy／TLS、真實 Gemini（本機堆疊）、F5 實機、CSV 檔案選取、長時間運作與多人負載、部署後 AI Studio 對真引擎、雲端實際費用。
