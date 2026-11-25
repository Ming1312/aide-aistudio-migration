# Phase 6.8 本機驗收報告（2026-11-24）

結論：**本機部分 PASS**（Docker 唯讀引擎＋Caddy 在這台 Ubuntu 上真正運行，只綁 127.0.0.1:8088）。Tunnel／cloudflared／AI Studio 不在範圍內，未做。

環境：Ubuntu 22.04.5；Docker 29.10.0、Compose v5.8.0、containerd 2.4.2；引擎封包 SHA-256 `f088f8ed…938149`。證據：`local_run_baseline_before.txt`（安裝前基準）、`local_run_start_local_first_success.log`（第一次成功的 start_local 輸出，不含金鑰）。

| 項目 | 結果 | 證據 |
|---|---|---|
| Docker context 是本機、Compose ≥ 2.24 | PASS | `default`／`unix:///var/run/docker.sock`；Compose v5.8.0 |
| preflight | PASS | 通過 30 項、警告 1 項（cloudflared 未安裝，預期）、失敗 0 |
| `compose_gate.py` 解析真實 Compose 輸出 | **PASS**（原為待驗證） | 真 Compose v5.8.0 輸出通過守門 |
| Caddy 只綁 127.0.0.1:8088 | PASS | `docker ps`／`docker port`；`ss` 只多 `127.0.0.1:8088`；用區網 IP 192.168.1.142:8088 連線被拒 |
| 引擎 8080 不對外 | PASS | 容器沒有 `->` 發佈；192.168.1.142:8080 被拒；主機沒有 :8080 監聽 |
| 五個寫入端點拒絕 | PASS | 帶 API 金鑰皆 403；無金鑰 401；`live_writes_enabled=False`、`live_sim_enabled=False` |
| 無金鑰／錯金鑰 | PASS | 皆 401 |
| 路徑規則 | PASS | `/docs`、`/openapi.json`、`/`、`/.env`、`/admin` 皆 404 |
| 容器以非 root、固定掛載、記憶體上限 | PASS | uid 10001；只有 live_store 與 backups 兩個 bind mount；2 GiB 上限；引擎約 240 MiB |
| 容器環境無禁用名稱 | PASS | 無 AIDE_ADMIN_KEY／ALLOW_SIM／DATA_DIR／ALLOWED_ORIGINS／GEMINI／GOOGLE |
| 七場域資料 | PASS | `/v1/datasets` 七個；quality／anomalies／decision-support 七場域皆 200 |
| 真資料預測（適用模型） | PASS | 六個場域各取一個啟用任務 POST `/v1/forecast` 200；育成北側 0／15 任務啟用（資料不足，引擎本來就不建模）；羊舍正式 THI 200 |
| 即時預測（合成資料流） | PASS | 七場域 live 六個端點皆 200；羊舍 15 個任務全部標 `contains_synthetic`；預測全是前瞻、有合成橫幅；育成北側無預測任務（資料不足） |
| 持久化：容器 restart | PASS | 7→14 版本；舊版本 ID 完整、順序不變；各場域恰好 +1；資料終點往後 1 小時（接續、不重複、不從頭） |
| 持久化：stop → 容器移除 → start | PASS | 容器、網路移除；live_store、備份目錄、映像、引擎目錄、金鑰、Caddy 具名 volume 全保留；再啟動後 14→21，舊 ID 完整；金鑰未重新產生 |
| 排程資料流 | PASS | 28→35 版本，908 秒後觸發（設定 900 秒） |
| 不影響其他 Docker 專案 | PASS | 測試期間另跑無關容器 `zz-other`，`stop_demo.sh` 沒動它（測完我移除自己建的這個測試容器） |
| 同名容器碰撞 | PASS | 建立不屬於 aide-demo 的 `aide-engine`：preflight 與 start_local 拒絕，未啟動任何容器，沒動別人的容器 |
| 設定檔白名單 | PASS | 加入 AIDE_DATA_DIR／AIDE_ADMIN_KEY／AIDE_ALLOW_SIM／GEMINI_API_KEY 各自被擋（用假 DEMO_HOME 與假金鑰測） |
| xtrace／環境變數 | PASS | `bash -x ./start_local.sh` 立刻拒絕，金鑰與容器未變、trace 無金鑰；`DOCKER_HOST`／`COMPOSE_FILE` 被警告並忽略 |
| 金鑰洩漏 | PASS | 掃描日誌、docker 日誌、`ps`、state、暫存檔、背景任務輸出、shell 歷史：乾淨；整個家目錄與 /tmp 只有 `demo.env` 含金鑰（權限 600） |
| 其他開發環境 | PASS | Python 3.10.12／Node 22.23.5／npm 10.9.9／git 2.34.1 不變；apt 來源只多 docker.sources；預設路由與 DNS 不變 |

## 執行中修正的程式問題（demo_kit）
1. `start_local.sh`：`tar tzf | head -n 1 | grep -q` 在 pipefail 下被 SIGPIPE 誤判成「封包最上層不是 aide/」。改用 `sed -n 1p` 並多檢查「沒有 aide/ 以外的路徑」。
2. `start_local.sh`：容器環境變數名稱檢查同樣有 `| grep -q` 漏判風險，改為先收進變數再比對，並要求一定看得到 `AIDE_API_KEY`。
3. `preflight.sh`：`--quiet` 且沒有失敗時不再印總結行。

## 系統變動（Docker 安裝造成，預期內）
新增 docker.sources；docker 與 containerd 開機自動啟動；`ip_forward` 0→1；多了 `docker0 172.17.0.1/16` 與 compose 網路 `172.18.0.1/16`（與區網 192.168.1.0/24 不衝突）；`/var/lib/docker` 約 1.8 GB（映像 912 MB＋建置快取 858 MB，快取是否清理由你決定）；你的使用者加入 docker 群組（等同 root）。

## 剩餘／待驗證
- `copy_key.py`（GTK 剪貼簿）：需要你親手測（檢查表 5.13）。
- 從**另一台裝置**連 `192.168.1.142:8088`：我只能從本機用區網 IP 測（被拒）；你可用手機補測。
- F12（唯讀時按寫入的誤導訊息）：本機觀察不到，要 Tunnel＋AI Studio。
- 版本庫成長：實測增量約 35 KB／版本（864 KB@7 版 → 1108 KB@14 版），900 秒一輪約 23 MB／天（外推）；`status.sh` 的 1 小時成長估計要等跨度夠長。
- 重開機後容器是否自動回來（`restart: unless-stopped`）：未測。
- cloudflared、Tunnel、AI Studio 連線、Gemini 規則式降級：不在本階段。
