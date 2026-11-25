# AIDE 本機唯讀展示套件（零費用、Phase 6.8）

在你自己的 Ubuntu 電腦上跑已通過 Phase 6.7 CI 的 Python 引擎（Docker＋Caddy），需要讓 AI Studio 連進來時，**手動**開 Cloudflare Quick Tunnel。

> **狀態：這些腳本已在 2026-11-24／25 實際執行並完成本機與遠端（Quick Tunnel）驗收**，結果見 `../docs/phase6/remote_acceptance_report.md`。管理者寫入流程（F12）、區網其他裝置、重新開機自動重啟、Tunnel 4 小時自動關閉尚未實測。

> **第一次本機安裝與測試請照 `../docs/phase6/first_local_run_checklist.md` 逐步做**（每一步有預期結果與停止條件；不含 cloudflared 與 Tunnel）。

## 三個一定要先知道的事

1. **Quick Tunnel 網址是「臨時的公開網址」，不是有身分驗證的私人連線。** 知道網址的任何人都連得到你電腦上的入口。保護只有：API 金鑰、唯讀設定、Caddy 只轉送 `/health` 與 `/v1/*`。網址每次重開都會變，Tunnel 停止後立刻失效。官方定位是測試與開發、沒有可用性保證。
2. **預設唯讀，而且沒有「開寫入」的選項。** 不設定 `AIDE_ADMIN_KEY`、`AIDE_ALLOW_SIM`，所以匯入、提交、回復、重算、模擬推進五個寫入端點全部 403。腳本發現設定檔含這些名稱（或 Gemini 金鑰）就拒絕啟動。
3. **已知限制 F12（沒有修）**：唯讀模式下，管理者在 App 按寫入會看到 502「引擎憑證設定有誤，請聯絡系統管理者」。**真正原因是這個部署唯讀，不是憑證問題。**「推進」按鈕在唯讀時會隱藏，其他寫入按鈕是否隱藏沒有驗證。

## 檔案

| 檔案 | 用途 |
|---|---|
| `preflight.sh` | 啟動前檢查（唯讀）：Docker、Compose 版本、cloudflared、封包 SHA-256、必要檔案、磁碟、連接埠、持久化目錄、設定檔 |
| `start_local.sh` | 啟動引擎＋Caddy，只綁 `127.0.0.1:8088`，引擎 8080 不發佈 |
| `start_tunnel.sh` | 開 Quick Tunnel；只能由你在終端機手動執行，並親自輸入確認句 |
| `stop_demo.sh` | 停止 Tunnel 與容器，**不刪除任何資料** |
| `status.sh` | 引擎／Tunnel／唯讀狀態、磁碟、版本庫大小、各場域版本、成長估計 |
| `copy_key.sh`＋`copy_key.py` | （額外）把 API 金鑰放進剪貼簿，不顯示在螢幕；按 Enter 或 45 秒後自動清空。用系統已有的 python3-gi（GTK3），不需要安裝 xclip |
| `lib.sh`、`demo_api.py`、`compose_gate.py`、`docker-compose.demo.yml` | 共用函式、HTTP 檢查小工具、啟動前 compose 守門、Caddy 只綁本機的覆蓋檔（Caddy 映像固定 digest） |

## 資料放在哪裡

| 位置 | 內容 | 會被腳本刪除嗎 |
|---|---|---|
| `~/aide-demo/bundle/` | 你放進去的引擎封包 | 否 |
| `~/aide-demo/engine/aide/` | 驗證過 SHA-256 後解開的引擎、模型與資料 | 否 |
| `~/aide-demo/state/demo.env` | **API 金鑰**（權限 600） | 否 |
| `~/aide-demo/state/` 其他檔案 | Tunnel 的 PID／網址／日誌、建置日誌、事件日誌、成長紀錄（都不含金鑰） | 只有 Tunnel 的 PID／網址標記會在停止時清掉 |
| `/var/lib/aide/live_store` | 版本庫（合成資料流產生的所有版本） | **否**（只有你自己能刪） |
| `/var/backups/aide` | 備份輸出目錄 | 否 |

要換位置：`export AIDE_DEMO_HOME=/別的路徑`（每支腳本都吃這個變數）。

## 安裝會改變你 Ubuntu 的哪些地方（安裝前請先看）

| 步驟 | 會改變 | 影響 |
|---|---|---|
| 安裝 Docker（官方套件庫） | 新增 apt 來源與金鑰；安裝 docker-ce、containerd.io 等；**docker 服務開機自動啟動**；Docker 會修改防火牆規則並把 `net.ipv4.ip_forward` 設成 1（目前是 0）；映像與快取放在 `/var/lib/docker`（約 1.5 GB） | 這台目前**沒有**任何 docker／podman／containerd／runc 套件，所以官方文件的「移除衝突套件」步驟不會刪到你現有的東西。Docker 預設網段（172.17.0.0/16 起）與你目前的區網 192.168.1.0/24 不衝突；若你之後連 VPN 用了 172.x 網段才需要留意 |
| `sudo usermod -aG docker "$USER"` | 你的使用者加入 docker 群組，需重新登入 | **docker 群組等同 root 權限**（能掛載任何目錄）。這是這個展示的權衡；不想長期保留，展示結束後可用 `sudo gpasswd -d "$USER" docker` 移除 |
| 安裝 cloudflared | 新增 Cloudflare 的 apt 來源與金鑰；之後 `apt upgrade` 會從那裡更新它 | 只安裝程式，**不會**建立任何 Tunnel 或常駐服務（我們不執行 `cloudflared service install`） |
| `sudo install -d … /var/lib/aide/live_store /var/backups/aide` | 新增兩個目錄（擁有者 uid 10001） | 只有引擎容器會用 |
| 第一次 `start_local.sh` | 新增 `~/aide-demo/`；下載 Python 套件與 Caddy 映像；啟動兩個容器 | 容器設了 `restart: unless-stopped`：**電腦重開機後，引擎與 Caddy 會自動回來**（仍然只綁 127.0.0.1；Tunnel 不會自動回來）。要徹底停掉請用 `./stop_demo.sh` |

不會改變：你現有的 Python／Node／其他開發環境、ssh、防火牆規則（ufw 不動；我們的連接埠只綁 127.0.0.1）、任何現有專案與檔案。

## 第一次安裝（只做一次）

下面每一步都由你執行；套件不會幫你安裝任何東西。

**1. 安裝 Docker（含 Compose，需要 2.24 以上）**
照 Docker 官方文件「Install using the apt repository」安裝：<https://docs.docker.com/engine/install/ubuntu/>。Ubuntu 22.04 內建套件的 Compose 可能太舊（覆蓋檔用 `!override`，舊版會把 80／443 一起發佈到所有網路介面，所以 preflight 會拒絕）。
安裝後把你的使用者加入 docker 群組並**重新登入**：

```bash
sudo usermod -aG docker "$USER"
```

確認：

```bash
docker --version
docker compose version
```

**2. 安裝 cloudflared（只有開 Tunnel 需要）**
照 Cloudflare 官方下載頁安裝：<https://developers.cloudflare.com/tunnel/downloads/>（套件庫 pkg.cloudflare.com 或官方 `.deb`）。確認：

```bash
cloudflared --version
```

**3. 放引擎封包**（來源與雜湊都和 Phase 6.7 CI 驗過的相同）

```bash
mkdir -p ~/aide-demo/bundle
cp "<repo>/ci/inputs/aide-engine-aistudio-1.0.0-20261123.tar.gz" ~/aide-demo/bundle/
```

腳本會比對 SHA-256 必須是 `f088f8ed6795336b523ea62448b79a2d67ee6b709b129bfeee02ee9acc938149`（舊的 `ffd4ec6f…` 已失效，會被拒絕）。

**4. 建立持久化目錄**（版本庫；擁有者要是引擎容器的使用者 uid 10001）

```bash
sudo install -d -o 10001 -g 10001 -m 750 /var/lib/aide/live_store /var/backups/aide
```

**5. 跑 preflight**

```bash
cd "<repo>/demo_kit"
./preflight.sh
```

全部 `[ OK ]` 才繼續。`[WARN] 沒有安裝 cloudflared` 在這一步可以先忽略。有 `[FAIL]` 時，它會印出該怎麼處理。

## 啟動（本機，沒有任何公開網址）

```bash
./start_local.sh
```

它會依序：preflight → 驗證並解開封包 → 產生 API 金鑰檔（權限 600，**不顯示**）→ `docker compose config` → 建置映像（第一次要幾分鐘）→ 啟動 → 驗證「唯讀、五個寫入端點全 403、無金鑰 401、只綁 127.0.0.1:8088、引擎 8080 未發佈、容器沒有管理金鑰或 Gemini 設定」→ 等第一個合成資料版本並檢查 `contains_synthetic`。任何一步失敗，已啟動的容器會被**停止**（資料不會被刪）。

選項：
- `--interval 秒數`：合成資料流多久推進一輪（預設 900 秒；最小 60）。越短，版本庫長得越快。
- `--no-feed`：關閉資料流（資料凍結，版本庫不再成長；即時預測停在最後一版）。
- `--rebuild`：重新建置映像。

啟動後看狀態：

```bash
./status.sh
```

## 連線 AI Studio（臨時公開）

**只在你要用的時段做。**

**1. 開 Tunnel**

```bash
./start_tunnel.sh
```

它會先確認引擎健康、唯讀、寫入全拒絕、磁碟足夠，然後顯示一段警告，要你**親自輸入**確認句才會開。開啟後會從公開網址那一側再驗證一次（`/health` 200、無金鑰 401、寫入全 403），任何一項失敗就自動關掉。它在非互動環境（管線、cron、背景）會直接拒絕。Tunnel 預設 **4 小時後自動關閉**（`AIDE_TUNNEL_MAX_HOURS` 可調）。

**2. 在 AI Studio 填 Secrets**（值只由你填，不要貼到聊天）
- `ENGINE_BASE_URL`：腳本印出的 `https://….trycloudflare.com`（結尾不加斜線）
- `ENGINE_API_KEY`：執行 `./copy_key.sh` 複製（不會顯示），貼進去；完成後清空剪貼簿
- `ENGINE_ADMIN_KEY`：AI Studio 可能要求有這個名稱，維持**隨機佔位字串**即可（不是真的管理金鑰；引擎沒有管理金鑰）
- **不要設定 `GEMINI_API_KEY`**：解釋功能會走既有的規則式降級（App 會標示非 AI 生成）

**3. 驗證**：開 App 的「即時預測」頁，應該從「尚未連線」變成各場域的狀態與預測；七場域逐一點開；預測應標示合成資料。

**4. 看公開側狀態**：`./status.sh --check-tunnel`

## 停止

```bash
./stop_demo.sh
```

先關 Tunnel（公開網址立刻失效），再停止並移除容器。**不刪除**：版本庫、備份目錄、模型與引擎目錄、映像、設定檔與金鑰。下次 `./start_local.sh` 版本紀錄會接續。

只關公開網址、容器繼續在本機跑：`./stop_demo.sh --tunnel-only`。

重開 Tunnel 後網址會變，要把 AI Studio 的 `ENGINE_BASE_URL` 改成新的。

## 磁碟與版本庫成長

合成資料流每一輪都會替每個場域新增一個版本。引擎本身沒有看到自動清理機制，**這個套件也不會自動刪除任何資料**。

- `status.sh` 會顯示可用空間、版本庫大小、各場域版本數，並把紀錄寫進 `~/aide-demo/state/growth.tsv`，累積超過 1 小時後給出「約幾 MB／天」與「約可再撐幾天」。
- 門檻（可用環境變數調整）：可用空間 < 20 GB 警告（`AIDE_WARN_FREE_GB`）；< 10 GB 拒絕啟動與拒絕開 Tunnel（`AIDE_MIN_FREE_GB`）；版本庫 >= 2048 MB 警告（`AIDE_WARN_STORE_MB`）。
- 要減緩成長：`./start_local.sh --interval 1800`（放慢）或 `--no-feed`（凍結）。要清理舊版本、備份或搬移，由你自己決定與操作。
- 測得的粗估（本機測試，15 秒一輪）：約 4 輪後版本庫 1.3 MB。長時間成長**沒有驗證過**。

## 剪貼簿與金鑰的使用方式

- `./copy_key.sh` 把金鑰放進剪貼簿（螢幕上不顯示），**貼好後回到終端機按 Enter 就立刻清空**；沒按的話 45 秒後自動清空；Ctrl+C 也會清空。它不留下背景行程，金鑰不經過命令列。
- 限制：X11 桌面上，任何程式在剪貼簿有內容的期間都讀得到它；若你的桌面有「剪貼簿歷史」工具，它可能保存一份。這就是只放 45 秒、貼完立刻清的原因。
- Quick Tunnel 由 Cloudflare 終止 TLS：Cloudflare 的邊緣看得到所有流量，包含 `X-API-Key`。所以**這把金鑰只該用在這個展示，用完就換**：`./stop_demo.sh` → 刪除 `~/aide-demo/state/demo.env` → 下次 `./start_local.sh` 會產生新金鑰 → 更新 AI Studio 的 `ENGINE_API_KEY`。
- 金鑰在容器環境變數裡：docker 群組的人用 `docker inspect aide-engine` 看得到。單人電腦可以接受；多人共用的電腦不要用這個方式。

## 安全設計摘要

- 金鑰只在 `~/aide-demo/state/demo.env`（權限 600）。腳本不 `cat`、不 `echo`、不放命令列、不寫進日誌、不用 `set -x`；`demo_api.py` 只把金鑰放進請求標頭，例外只印類別名稱。
- 設定檔採**白名單**：只允許 `AIDE_DOMAIN`、`AIDE_API_KEY`、`AIDE_RATE_PER_MIN`、`AIDE_STALE_AFTER_H`、`AIDE_SIM_FEED`、`AIDE_SIM_INTERVAL_S`、`AIDE_SIM_HOURS`，其他任何名稱（管理金鑰、模擬寫入、Gemini、`AIDE_DATA_DIR`、`AIDE_ALLOWED_ORIGINS`…）都拒絕啟動；shell 環境裡的同名變數與 `DOCKER_*`／`COMPOSE_*` 會被清掉。啟動前還會用 `compose_gate.py` 檢查『真正會被啟動的 compose 設定』（只綁 127.0.0.1:8088、引擎不發佈、掛載固定、無特權、Caddy 映像固定 digest）。
- Caddy 只綁 `127.0.0.1:8088`；引擎 8080 只在容器網路內；啟動後會檢查 `docker port` 與本機監聽位址。
- 腳本不呼叫 `sudo`（需要時只印指令給你）、不安裝軟體、不推送 GitHub、不使用任何付費服務。
- `/health` 不需要金鑰，會公開引擎版本、函式庫版本與各資料集雜湊（Node 的連線探測需要它；風險低，接受）。
- 引擎依來源 IP 限流；經 Tunnel 後所有人共用同一個額度（預設 `AIDE_RATE_PER_MIN=600`）。Quick Tunnel 沒有 WAF／限流可設，灌請求時你自己的 App 可能暫時收到 429。

## 還沒驗證的

- 這些腳本**從未實際執行**：語法（`bash -n`）、Python 編譯、靜態掃描與純函式檢查通過，但沒有 Docker 與 cloudflared 的實機跑過。
- 「唯讀設定」在 Docker 內的行為（CI 驗過的是有管理金鑰的設定；唯讀設定只在本機 uvicorn 驗過）。
- AI Studio 執行環境能否連到 trycloudflare.com、延遲、Node 的 10 秒逾時、修改 Secrets 後 App 是否自動重啟。
- 多人同時看七場域時是否碰到 200 個處理中請求的上限。
- 長時間運行：版本庫成長、記憶體、電腦睡眠或關機。

## 常見狀況

| 狀況 | 處理 |
|---|---|
| preflight：Compose 太舊 | 改裝 Docker 官方套件庫的新版；不要硬跑 |
| preflight：持久化目錄不存在或擁有者不對 | 照它印出的 `sudo install -d …` 自己執行一次 |
| `start_local.sh` 說設定檔含不允許的名稱 | 自己編輯 `~/aide-demo/state/demo.env`，移除管理金鑰、模擬寫入或 Gemini 的行 |
| `start_tunnel.sh` 說「只能手動執行」 | 要在互動式終端機直接輸入指令，不能經過管線、cron 或自動化 |
| App 顯示「尚未連線」 | 引擎或 Tunnel 沒開，或 `ENGINE_BASE_URL` 還是舊網址 |
| App 顯示 502「引擎憑證設定有誤」 | 若是在「按寫入」時出現，就是 F12（唯讀的正常結果）；若是在讀取時出現，代表 `ENGINE_API_KEY` 與本機 `demo.env` 不一致 |
| 懷疑金鑰外洩 | `./stop_demo.sh`，刪除 `~/aide-demo/state/demo.env`（下次啟動會產生新的），再更新 AI Studio 的 `ENGINE_API_KEY` |
