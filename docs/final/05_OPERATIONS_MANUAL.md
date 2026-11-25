# 05　操作手冊：本機啟動、停止、免費 Tunnel 與 AI Studio 設定

> 完整細節（安裝會改變系統的哪些地方、資料放哪裡、安全設計）見 [`demo_kit/README.md`](../../demo_kit/README.md)；第一次本機安裝逐步檢核表見 [`docs/phase6/first_local_run_checklist.md`](../phase6/first_local_run_checklist.md)。本手冊是展示當天要用的精簡版。
>
> **零費用原則**：全程不需要信用卡、不使用付費資源、不呼叫付費 API。Cloudflare Quick Tunnel 不需帳號；Gemini 維持 AI Studio Free Tier（也可完全不設定，解釋功能走規則式降級）。

## 0　需要什麼

| 項目 | 說明 |
|---|---|
| 電腦 | Ubuntu（本專案在 Ubuntu 上驗收）；可用空間 ≥ 10 GB（< 20 GB 會警告，< 10 GB 拒絕啟動） |
| Docker | 含 Compose **≥ 2.24**（覆蓋檔使用 `!override`）；使用者在 `docker` 群組 |
| cloudflared | 只在要開 Tunnel 時需要；只安裝程式，不建立任何常駐服務 |
| 引擎封包 | `ci/inputs/aide-engine-aistudio-1.0.0-20261123.tar.gz`（SHA-256 `f088f8ed…938149`） |
| AI Studio | 專案 `aide-aistudio-migration`（Import from GitHub 建立）；Settings → Secrets |

第一次安裝 Docker／cloudflared 請照 `demo_kit/README.md`「第一次安裝」。安裝是你自己執行的，套件不會替你安裝任何東西。

## 1　本機啟動（只做引擎，不開公開網址）

```bash
mkdir -p ~/aide-demo/bundle
cp ci/inputs/aide-engine-aistudio-1.0.0-20261123.tar.gz ~/aide-demo/bundle/
cd demo_kit
./preflight.sh        # 啟動前檢查（唯讀，不開任何東西）
./start_local.sh      # 引擎＋Caddy；第一次會產生 API 金鑰（不顯示）
./status.sh           # 看狀態：容器、唯讀、各場域版本、磁碟
```

`start_local.sh` 完成時保證：

- Caddy 只綁 `127.0.0.1:8088`；引擎 8080 不發佈到主機。
- 引擎唯讀：沒有管理金鑰，五個寫入端點全部 403（腳本會實測）。
- 設定檔採白名單，檔案權限 600；金鑰不顯示、不寫日誌。
- 容器設有 `restart: unless-stopped`：**電腦重開機後引擎會自動回來**（Tunnel 不會）。

可調整：`./start_local.sh --interval 120`（合成資料流每 120 秒推進一次；預設 900，最小 60；越短版本庫長得越快，**設定會保存在設定檔裡**，展示後記得改回 900）、`--no-feed`（凍結資料流）。

## 2　開免費 Tunnel（只在要連 AI Studio 的時段做）

```bash
cd demo_kit
./start_tunnel.sh
```

腳本會：確認引擎健康、唯讀、寫入全拒絕、磁碟足夠 → 顯示警告 → **要你親自輸入**確認句 `我了解這是臨時公開網址` → 開 Tunnel → 從公開網址側再驗證一次（新網址的 DNS 可能要等到 3 分鐘）→ 印出 `https://隨機名稱.trycloudflare.com`。**只能在互動式終端機手動執行**（管線、cron、背景都會被拒絕）；預設 **4 小時後自動關閉**。

務必知道：

- 這是**臨時公開網址**，不是有身分驗證的私人連線；知道網址的人都連得到入口。唯一保護是 API 金鑰、唯讀設定、Caddy 只轉送 `/health` 與 `/v1/*`。
- Cloudflare 終止 TLS，**看得到 `X-API-Key`**——金鑰只用在這個展示，用完就換（見 §5）。
- 網址每次重開都會變；Quick Tunnel 只供測試與開發，沒有可用性保證。
- 展示資料是合成資料流與已聲明可公開展示的七場域資料。

## 3　AI Studio Secrets 設定（值只由你填，不要貼到聊天）

AI Studio → Settings → Secrets：

| 名稱 | 填什麼 |
|---|---|
| `ENGINE_BASE_URL` | Tunnel 印出的 `https://….trycloudflare.com`，**結尾不加斜線** |
| `ENGINE_API_KEY` | 執行 `./copy_key.sh` 複製到剪貼簿（螢幕不顯示；按 Enter 或 45 秒後自動清空）再貼上 |
| `ENGINE_ADMIN_KEY` | 若 AI Studio 要求這個名稱，填**隨機佔位字串**（不是真的管理金鑰；引擎沒有管理金鑰） |
| `ADMIN_PASSPHRASE_HASH` | 不設定＝所有人唯讀（展示建議不設定） |
| `GEMINI_API_KEY` | 不要自己貼；沒有時解釋功能走規則式降級並標示「非 AI 生成」 |

填完按 **Apply changes**。

> **已知陷阱**：AI Studio 會把 `.env.example` 內的文字自動填進 Secrets。若看到 Secrets 的值是範例文字，App 會顯示離線——請手動替換 `ENGINE_BASE_URL` 與 `ENGINE_API_KEY`。本 repo 的 `.env.example` 已改為只列名稱，沒有註解。

**驗證**（App 網址後加 `/api/health`，或看即時預測頁）：

```
engine_connected: true
live_engine_connected: true
read_only: true
live_writes_enabled: false
```

再開「即時預測」頁，各場域應該從「尚未連線」變成預測狀態；育成一廠北側依政策不提供預測。

## 4　停止

```bash
cd demo_kit
./stop_demo.sh                 # 先關 Tunnel（公開網址立刻失效），再停止並移除容器
./stop_demo.sh --tunnel-only   # 只關 Tunnel，容器繼續在本機跑
```

**不會刪除**：版本庫（`/var/lib/aide/live_store`）、備份目錄（`/var/backups/aide`）、模型與引擎目錄、映像、設定檔與金鑰。腳本不使用 `down -v`、`rmi`、`prune`。下次 `./start_local.sh` 版本紀錄會接續。

確認真的停了：

```bash
docker ps                      # 應該是空的
pgrep -af cloudflared          # 應該沒有輸出
ss -ltn | grep 8088            # 應該沒有輸出
```

## 5　換金鑰（每次展示結束後建議做）

```bash
cd demo_kit
./stop_demo.sh
rm ~/aide-demo/state/demo.env      # 刪除舊金鑰
./start_local.sh                   # 產生新金鑰；下次開 Tunnel 後，到 AI Studio 更新 ENGINE_BASE_URL 與 ENGINE_API_KEY
```

舊金鑰刪除後，AI Studio 裡殘留的舊 `ENGINE_API_KEY` 不對應任何引擎。

## 6　資料放在哪裡

| 位置 | 內容 |
|---|---|
| `~/aide-demo/bundle/` | 引擎封包 |
| `~/aide-demo/engine/aide/` | 驗證 SHA-256 後解開的引擎、模型與資料 |
| `~/aide-demo/state/demo.env` | **API 金鑰**（權限 600；不要提交、不要貼出） |
| `~/aide-demo/state/` 其他檔案 | Tunnel 標記、建置日誌、事件日誌、成長紀錄（不含金鑰；不要提交） |
| `/var/lib/aide/live_store` | 版本庫（合成資料流產生的所有版本；**執行中的資料，不進 Git**） |
| `/var/backups/aide` | 備份輸出 |

改位置：`export AIDE_DEMO_HOME=/別的路徑`。磁碟成長：合成資料流每輪替每個場域新增一個版本，**這個套件不會自動刪除任何資料**；`./status.sh` 會顯示可用空間與版本庫大小。長時間成長沒有驗證過。

## 7　疑難排解

| 現象 | 可能原因 | 處理 |
|---|---|---|
| `/api/health` 顯示 `engine_connected:false` | Tunnel 沒開／網址變了／Secrets 值是範例文字／金鑰不符 | 重新取得網址；逐一檢查兩個 Secrets（網址結尾不加斜線）；金鑰不符時 Node 會把引擎 401 轉成 502「引擎憑證設定有誤」 |
| 即時預測頁一直「尚未連線」 | 同上 | 同上；引擎離線時決策輔助仍可用預計算結果 |
| 管理者按寫入看到 502「引擎憑證設定有誤」 | **已知限制 F12**：真正原因是唯讀引擎停用寫入 | 這個部署預設就是唯讀；不是憑證問題 |
| `start_tunnel.sh` 說公開網址 `/health` 等了 3 分鐘沒回應 | 新 `trycloudflare.com` 主機名稱的 DNS／邊緣尚未就緒 | 腳本已自動關閉 Tunnel；稍後重試 |
| 公開網址回 429 | 引擎依來源 IP 限流，經 Tunnel 後所有人共用額度；或 Quick Tunnel 同時 200 個處理中請求上限 | 稍候；展示時不要同時開太多分頁 |
| `preflight.sh` 拒絕 | Docker／Compose 版本、封包 SHA-256、磁碟不足、設定檔不合白名單 | 腳本只說名稱與原因、不印值；照訊息處理 |
| 資料更新頁「此頁發生錯誤」 | 舊版 App（v1.1.0 之前）的 F13：育成北側沒有 guard | 使用本版（已修正） |

## 8　備案：引擎或網路出問題時

App 不會當機：決策輔助改用預計算結果並標示，總覽／探索／資料更新照常運作；即時預測頁保留上次畫面並說明離線。現場也可以直接展示 [`docs/phase6/remote_acceptance_report.md`](../phase6/remote_acceptance_report.md) 的驗收表與 [08 展示腳本](08_DEMO_SCRIPT.md) 的備案段。
