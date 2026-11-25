# Phase 6.8 demo_kit 最後一次唯讀審查（2026-11-24）

範圍：重新逐行讀 `start_local.sh`、`start_tunnel.sh`、`lib.sh`，並追到它們操作的 `docker-compose.yml`、`Caddyfile`、`Dockerfile`、引擎 `main.py`／`live/`／`src/`（用 SHA-256 已驗證的封包解開檔）。
這一輪沒有安裝、沒有啟動任何服務、沒有產生金鑰、沒有推送、沒有建立 Tunnel。**原始 `demo_kit/` 一個位元都沒改**；修正只存在於 `review/demo_kit_review_fixes.patch`（等你同意才套用）。

## 結論

原始碼**大方向正確**（只綁 127.0.0.1、引擎不發佈、唯讀、金鑰不上命令列、停止不刪資料），但審查找到 **15 項發現（高 1、中 7、低 7）**，另有幾個只能「記錄與接受」的限制。**我建議第一次執行前一定要修的是 2-A（設定檔改白名單，含 `AIDE_DATA_DIR` 會讓資料消失的漏洞）、1-A（啟動前檢查解析後的 compose）、3-A（xtrace 會印出金鑰）、7-A（這台沒有剪貼簿工具，原版 `copy_key.sh` 不能用）**。修正已做成 patch，並用合成資料驗證過純函式與守門邏輯（見最後一節）。

## 八個問題逐項回答

### 1. 是否嚴格綁定 127.0.0.1、不會開放 8080 或管理端點？

| # | 嚴重度 | 問題（原始碼位置） | 最小修正 |
|---|---|---|---|
| 1-A | **中** | 暴露面只在「啟動之後」才檢查（`start_local.sh:132-135`）。啟動前只有 `compose config -q`（`:98`），只確認沒有警告，**沒有檢查解析後的 ports**。若覆蓋檔的 `!override` 沒生效（版本檢查被繞過或 Compose 行為不同），80／443 會先被發佈到所有介面幾秒鐘才被發現。Phase 6.7 的 CI 有做這個「解析後」檢查，kit 漏掉了 | 新增 `compose_gate.py`：用 `compose config --format json`（只經管線，不顯示）在**建置與啟動之前**驗證：服務只有 engine＋caddy；caddy 的 ports 恰好只有 `127.0.0.1:8088→80`；engine 沒有 ports；環境沒有禁用名稱；`AIDE_REQUIRE_KEY=1`、`AIDE_LIVE_ROOT` 固定；掛載恰好是兩個 bind mount；沒有 privileged／host network／cap_add；`AIDE_DOMAIN=http://:80`；Caddy 映像是固定 digest |
| 1-B | 低 | `start_tunnel.sh:57-58` 只檢查「有一行綁 127.0.0.1:8088」，不檢查**其他行**（若有人另外手動讓 Caddy 發佈 443 到 0.0.0.0，Tunnel 前檢查不會發現） | 抽成 `caddy_ports_ok`（每一行都必須是 127.0.0.1，空輸出也不合格），`start_local`／`start_tunnel`／`status` 共用，Tunnel 前再跑一次 `compose_gate` |
| 1-C | 低 | Caddy 映像是浮動標籤 `caddy:2`（正式 compose），第一次 `up` 會拉當下最新的。CI 通過的是特定 digest | 覆蓋檔固定成 `caddy:2@sha256:4851e54a…`（CI 日誌裡實際拉到的 digest），`compose_gate` 核對 |

已確認沒問題：引擎只用 `expose: "8080"`（`docker-compose.yml:17-18`），沒有 `ports`；Caddy 管理介面 2019 在容器內，未發佈（CI 日誌的 `docker compose ps` 顯示只有 `127.0.0.1:8088->80`）；寫入端點在引擎端由 `admin_guard`（`main.py:303-310`）擋，`AIDE_ADMIN_KEY` 為空時一律 403，kit 在啟動與開 Tunnel 前、公開網址側都實測過（`deny-writes` 用的是「帶 API 金鑰、不帶管理金鑰」，就算引擎誤開寫入也只會得到 401，不會真的寫入）。

### 2. 預設唯讀是否可靠？能不能被環境變數繼承或設定檔覆蓋？

追蹤結果：
- **環境變數繼承**：正式 compose 的 engine `environment:` 只有三個固定值（`AIDE_LIVE_ROOT`、`AIDE_REQUIRE_KEY`、`AIDE_DOCS`），沒有 `${…}` 或「只寫名稱」的穿透寫法，所以 shell 裡的 `AIDE_ADMIN_KEY` **不會**進到引擎（`sanitize_env` 是額外保險）。`environment:` 的優先權高於 `env_file:`，所以 env 檔也**蓋不掉**那三個值。
- **但**：`lib.sh:102-104` 的 `sanitize_env` 只清了 6 個名稱，**沒有清 `DOCKER_HOST`、`DOCKER_CONTEXT`、`COMPOSE_FILE`、`COMPOSE_PROFILES`、`COMPOSE_ENV_FILES`、`COMPOSE_PROJECT_NAME`**。若你的 shell 有 `DOCKER_HOST=ssh://別台機器`，所有 compose／docker 指令會打到別台機器的 Docker（`/var/lib/aide/live_store` 也會是遠端的）。

| # | 嚴重度 | 問題 | 最小修正 |
|---|---|---|---|
| 2-A | **高（第一次執行前就該修）** | 設定檔檢查是**黑名單**（`FORBIDDEN_ENV_NAMES`，`lib.sh:53`；`start_local.sh:82`）。引擎實際讀的環境變數我用程式碼列出來了：`AIDE_ADMIN_KEY AIDE_ALLOWED_ORIGINS AIDE_ALLOW_SIM AIDE_API_KEY AIDE_DATA_DIR AIDE_DOCS AIDE_LIVE_ROOT AIDE_MAX_UPLOAD_BYTES AIDE_RATE_PER_MIN AIDE_REQUIRE_KEY AIDE_SIM_FEED AIDE_SIM_HOURS AIDE_SIM_INTERVAL_S AIDE_STALE_AFTER_H`。黑名單漏了 **`AIDE_DATA_DIR`**（`src/p586_store.py:47` 會把儲存位置改到 `$AIDE_DATA_DIR/store`，**把資料導離持久化掛載，容器移除就遺失**）與 `AIDE_ALLOWED_ORIGINS`（放寬 CORS）。也沒擋 `export X=…`、引號內換行、行內註解等格式 | 改**白名單**：env 檔只允許 7 個名稱（`AIDE_DOMAIN`、`AIDE_API_KEY`、`AIDE_RATE_PER_MIN`、`AIDE_STALE_AFTER_H`、`AIDE_SIM_FEED`、`AIDE_SIM_INTERVAL_S`、`AIDE_SIM_HOURS`），嚴格格式（`NAME=值`，值不含空白、無 export、無行內註解），並驗證各值（金鑰為 32 字元以上英數字、`AIDE_DOMAIN=http://:80`、`AIDE_SIM_FEED` 為 0／1、其餘為整數）。錯誤訊息只含行號與名稱，不含值。`compose_gate` 再檢查一次解析後的環境 |
| 2-B | **中** | `sanitize_env` 沒清 `DOCKER_*`／`COMPOSE_*`（見上） | 一併清掉；`preflight` 另外要求 docker 目標是本機 unix socket（`docker context inspect` 的 Host 以 `unix://` 開頭），否則拒絕 |
| 2-C | 低 | 解開後的 `deploy/docker-compose.yml`、`Caddyfile`、`Dockerfile`、`.dockerignore` 沒有再核對（只有 `.bundle_sha256` 標記檔，任何人都能寫） | `preflight` 對這四個檔案核對 SHA-256（值取自已驗證封包：compose `74d6d114…`、Caddyfile `79d9bda5…`、Dockerfile `e14e5c3b…`、.dockerignore `5fcdcb5a…`） |

### 3. API Key 是否可能出現在命令列、日誌、程序資訊或錯誤輸出？

逐一追蹤的結論：
- **命令列／程序資訊：乾淨。** 產生金鑰用 `openssl rand`（argv 無值）＋ builtin `echo`；API 檢查都走 `demo_api.py`，金鑰只在 HTTP 標頭；kit 內沒有任何帶金鑰的 `curl`；`ps` 看到的 cloudflared 指令列只有 `--url http://127.0.0.1:8088`。
- **日誌：乾淨。** `log_event` 只記事件名稱；`tunnel.log` 以 umask 077 建立；`build.log` 沒有金鑰（無 build args）。
- **找到的洩漏路徑：**

| # | 嚴重度 | 問題 | 最小修正 |
|---|---|---|---|
| 3-A | **中** | `start_local.sh:65-70` 把金鑰放進 shell 變數 `key` 再 `echo`。若你用 `bash -x start_local.sh` 或環境有 `SHELLOPTS=xtrace`，**金鑰會被 trace 印到終端機**（`set -x` 本身 kit 沒用，但使用者可以加） | ①金鑰不放變數：`openssl rand -hex 32 \| sed 's/^/AIDE_API_KEY=/'` 直接寫進檔案；②`lib.sh` 開頭偵測 xtrace（`$-` 含 x 或 `SHELLOPTS` 含 xtrace）就拒絕執行 |
| 3-B | **中** | `urllib` 與 `curl` 會使用 `http_proxy`／`https_proxy` 環境變數。若你的環境設了 proxy 又沒設 `no_proxy=127.0.0.1`，**帶著 `X-API-Key` 的本機請求會被送到 proxy**（這台目前沒設，但「其他開發環境」可能會） | `demo_api.py` 用 `ProxyHandler({})`；kit 的 `curl` 一律加 `--noproxy '*'`（公開網址檢查也一樣：需要走 proxy 才能上網時會「失敗並關閉 Tunnel」，是 fail-closed） |
| 3-C | 低 | `start_local.sh:98-99` 失敗時把 `compose config -q` 的錯誤原樣印出；compose 解析 env 檔失敗的訊息可能引用出錯的那一行（若剛好是金鑰那行就洩漏） | 不轉印細節，只說「有警告或錯誤」並指向檔案位置 |
| 3-D | 資訊（無法修，要接受並告知） | **Cloudflare 終止 TLS，看得到所有流量，包含 `X-API-Key`**；金鑰在容器環境變數，docker 群組的人用 `docker inspect aide-engine` 就看得到 | 在 Tunnel 警告與 README 明寫；建議「這把金鑰只用於展示，用完換新」（刪除 `demo.env` 後重新 `start_local.sh`） |

另外確認：`docker compose config`（不帶 `-q`）會把 env 檔內容展開、含金鑰，**kit 沒有任何地方使用它**；`docker inspect … \| cut -d= -f1` 只輸出變數名稱，值只在管線裡。

### 4. 啟動失敗與停止時，是否只影響 AIDE 容器？

- **範圍正確**：所有 compose 操作都帶 `-p aide-demo`，`stop`／`down --remove-orphans` 只作用在標籤為 `com.docker.compose.project=aide-demo` 的容器；沒有 `docker stop $(docker ps -q)`、沒有 `prune`、沒有 `rmi`、沒有 `-v`；失敗清理只呼叫 `compose stop`（`start_local.sh:33`）。
- **問題：**

| # | 嚴重度 | 問題 | 最小修正 |
|---|---|---|---|
| 4-A | 中 | 正式 compose 用**固定** `container_name: aide-engine`／`aide-caddy`（`docker-compose.yml:7,29`），而 kit 的檢查與 `docker exec`（`lib.sh` 的 `store_kb`、`start_local` 的 `docker port`／`docker inspect`、`start_tunnel`、`status`）都是**用名稱**。若別的專案恰好有同名容器：`up` 會衝突失敗（不會誤動別人的），但後續的 `docker port`／`docker exec` 可能查到別人的容器，做出錯誤判斷 | 新增 `is_ours`（容器的 compose 專案標籤必須是 `aide-demo`），`preflight`（同名但不是我們的就拒絕）、`start_local`、`start_tunnel`、`status`、`store_kb` 都先檢查 |
| 4-B | 低 | `tunnel_pid_alive`（`lib.sh:118-124`）只檢查指令列含 `cloudflared tunnel`。若過期的 PID 檔裡的號碼被**你自己另一個 cloudflared**重用，`stop_demo.sh` 會把它關掉 | 同時要求指令列含 `--url http://127.0.0.1:8088`（已用假行程測試：別人的 `--url …9999` 不會被認成我們的） |

注意（不是缺陷，要告知）：容器有 `restart: unless-stopped`，所以 `start_local.sh` 成功後**重開機會自動回來**（仍只綁 127.0.0.1，Tunnel 不會回來）；`stop_demo.sh`（`down`）會徹底移除它們。

### 5. live_store、模型與版本資料是否確實持久化？停止腳本會不會刪除？

- **持久化路徑**：版本庫是 bind mount `/var/lib/aide/live_store → /app/data/live_store`（`docker-compose.yml:15`），`AIDE_LIVE_ROOT` 在 compose `environment:` 固定（env 檔蓋不掉）。引擎的寫檔我逐處查過：只有 `live/service.py`（`self.root` 之下）與 `live/backup.py`（輸出到掛載的 `/backups`）。模擬資料流的「下一批從哪裡開始」由版本庫目前的資料終點決定（`live/simfeed.py` 的 `_next_start`），記憶體快取只是加速，所以重啟與重建容器後**接續而且冪等**。Phase 6.7 CI 也實測過 restart 與 down→up 後版本不變。
- **模型**：在映像內（唯讀使用）與已解開的 `~/aide-demo/engine/aide/`；停止不碰。
- **停止腳本**：`stop_demo.sh` 只有 `compose stop`、`compose down --remove-orphans`（無 `-v`／`--volumes`／`--rmi`），沒有任何 `rm` 指向資料；只 `rm -f` Tunnel 的 PID／網址／開始時間標記檔。bind mount 本來就不會被 `down` 刪除；Caddy 的具名 volume（憑證與設定快取）也保留。
- **風險：** 2-A 的 `AIDE_DATA_DIR` 若被放進 env 檔，資料會寫到容器內而在 `down` 時消失 —— 已由白名單與 `compose_gate` 擋掉。
- **尚未做、建議（patch 不含）**：`stop_demo.sh` 停止前記下各場域版本數，`start_local.sh` 啟動後比對，變少就警告。這能把「持久化」從「我讀程式碼相信」變成「每次都驗證」。

### 6. Tunnel 的手動確認與四小時自動關閉是否可靠？

- **手動確認**：`[ -t 0 ] && [ -t 1 ]`、`/dev/tty` 可讀，並從 `/dev/tty` 讀確認句。它能擋掉管線、cron、`nohup`、一般自動化，**但不是安全邊界**：用 pty 的自動化（`script`、`expect`、`tmux send-keys`、有 pty 的 agent）可以通過，確認句也印在畫面上。它的作用是「確保是有意的動作」，真正的邊界是「我不會在你沒明確要求時執行它」。
- **四小時**：`timeout --signal=TERM 14400 cloudflared …` 在 `setsid` 的獨立行程群組裡；終端機關掉不會送 SIGHUP（沒有控制終端），所以 Tunnel 會繼續到期；電腦睡眠期間 Tunnel 本來就斷線，醒來時 `timeout` 的計時已過就會關。`status.sh` 的剩餘時間是用開始時間算的。
- **問題：**

| # | 嚴重度 | 問題 | 最小修正 |
|---|---|---|---|
| 6-A | 低 | `timeout` 只送 TERM，沒有 `--kill-after`。cloudflared 收到 TERM 會做優雅關閉（預設寬限約 30 秒），若卡住，`timeout` 會一直等，Tunnel 不會真的在 4 小時關掉 | `timeout --signal=TERM --kill-after=30 …` |
| 6-B | 低 | 4-B 的 PID 重用問題也影響 `start_tunnel.sh` 的 `kill_tunnel` | 同 4-B |

已確認：`TUNNEL_STARTED=1` 在啟動**之前**就設好，所以啟動過程任何一步失敗（`die`）或 Ctrl+C，EXIT trap 都會關掉 Tunnel；`cloudflared` 的啟動點在全檔只有一處，在確認句檢查之後。

### 7. `copy_key.sh` 的剪貼簿安全性，以及是否有更安全的方式？

| # | 嚴重度 | 問題 | 最小修正 |
|---|---|---|---|
| 7-A | **中（可用性）** | 這台是 **X11＋GNOME，沒有安裝 `wl-copy`、`xclip`、`xsel`**（我查過）。原始 `copy_key.sh` 會落到「找不到剪貼簿工具」分支而拒絕，等於這個功能目前**不能用**，README 也沒提到要先裝 | 改用系統已有的 `python3-gi`（GTK3，我查過可 import）：新增 `copy_key.py`，**不安裝任何東西** |
| 7-B | 中（安全） | 原版把金鑰放進剪貼簿後就結束，**不會清除**，只靠 README 提醒。X11 剪貼簿內容可被任何程式讀取 | `copy_key.py` 在前景持有剪貼簿：貼好後按 Enter 立刻清空，**45 秒自動清空**，Ctrl+C／SIGTERM 也清空；不呼叫 `store()`（不要求剪貼簿管理員另存一份）；不留背景行程；金鑰不經命令列 |

仍存在的限制（要告知）：剪貼簿有內容的那段時間，X11 上的任何程式都讀得到；若桌面有剪貼簿歷史工具會被保存。更安全到更不安全的選項：①密碼管理員自己存、自己貼（金鑰不經過這個套件，最好，但要你自己維護）；②`copy_key.py`（最短暴露窗口）；③自己用編輯器開 `demo.env` 複製（螢幕與截圖都會看到，最差）。

### 8. README 安裝步驟會不會改變你目前其他的開發環境？

我查了這台（唯讀查詢）：**沒有任何 docker／podman／containerd／runc／libvirt／lxc／virtualbox 套件**，沒有 snap 的 docker／lxd；唯一網路介面是 `lo` 與 `enp4s0 192.168.1.142/24`；`net.ipv4.ip_forward = 0`；沒有 `DOCKER_*`／`COMPOSE_*`／proxy 環境變數；ufw 狀態我讀不到（需要 root）。

README 步驟會造成的系統變動（已寫進 patch 後的 README「安裝會改變你 Ubuntu 的哪些地方」）：

- 新增 Docker 與 Cloudflare 兩個 apt 來源與金鑰；安裝 docker-ce 等套件；**docker 服務開機自動啟動**；Docker 會修改防火牆規則並把 `ip_forward` 設為 1；映像與快取在 `/var/lib/docker`（約 1.5 GB）。
- `usermod -aG docker`：**docker 群組等同 root 權限**；需重新登入。展示後可用 `sudo gpasswd -d "$USER" docker` 移除。
- 官方文件的「移除衝突套件」步驟在這台**不會刪到東西**（沒有衝突套件）。Docker 預設網段（172.17.0.0/16 起）與 192.168.1.0/24 不衝突。
- cloudflared 只安裝程式，不建立 Tunnel 或常駐服務。
- 新增 `/var/lib/aide`、`/var/backups/aide`、`~/aide-demo`。容器有 `restart: unless-stopped`（重開機後引擎與 Caddy 會自動回來，仍只綁 127.0.0.1）。
- **不會改變**：你現有的 Python／Node／其他專案與檔案、ssh、ufw 規則（我們的連接埠只綁 127.0.0.1）。
- 不採用 rootless Docker：我們用 `install -o 10001` 的 bind mount 依賴一般（rootful）Docker 的 uid 對應，rootless 會讓 uid 對應不同而失敗。

## 另外記錄（不修，供你決定）

- Caddy 層可再加「`/v1/live/*` 只允許 GET」的縱深防禦，但這會偏離 Phase 6.7 CI 驗過的 Caddyfile；目前靠「引擎層 403＋啟動前後與公開側三次實測」。
- `AIDE_SIM_FEED=0`（`--no-feed`）會寫進 env 檔並一直保留，沒有 `--feed` 開回來的旗標；要開回來需自己改檔或刪檔重建。
- F12（唯讀時按寫入顯示 502「引擎憑證設定有誤」）仍未修。
- 版本庫長時間成長仍未驗證（我估 900 秒一輪約 25 MB／天，依本機 4 輪後 1.3 MB 外推，**未實測**）。

## 這份修正本身怎麼驗證的（以及它的盲區）

- `patch -p1` 套在原始 kit 的拷貝上，結果與我預覽的版本逐位元相同；套用後 `bash -n` 與 `py_compile` 全過。
- 純函式與守門邏輯用**假資料**測試（沒有啟動任何服務、沒有真金鑰）：白名單 11 種 env 檔（含管理金鑰、`AIDE_DATA_DIR`、`export`、行內註解、引號內換行、短金鑰、錯誤網域、`FEED=2`、缺欄位）全部判定正確，且錯誤訊息不含金鑰值；`loopback_only_text` 5 種輸出判定正確；`compose_gate.py` 用 18 種合成 JSON（多發佈 443、綁 0.0.0.0、缺 ports、發佈 8080、管理金鑰、`AIDE_DATA_DIR`、掛載被改、privileged、host network、浮動映像標籤…）全部判定正確，且輸出不含金鑰；`tunnel_pid_alive` 用無害的假行程測試（我們的認得、別人的 cloudflared 不認）；`bash -x` 與 `SHELLOPTS=xtrace` 都被拒絕。
- **盲區（誠實）**：
  1. 我在套用修正的過程中，自己寫壞了一行（`if [ -n "$INTERVAL"; then`，少了 ` ]`），`bash -n` **沒抓到**（語法上合法，執行時才會錯），是我逐行看 diff 才發現並修掉的。這說明「語法檢查通過」不等於「邏輯正確」，第一次本機測試必須**分步驟、逐步看輸出**。
  2. `compose_gate.py` 假設了 `docker compose config --format json` 的輸出結構（ports 的 `host_ip`／`published`、volumes 的長格式、`environment` 是 map）。這和 CI 看到的 YAML 結構一致，但沒有用真的 Docker 輸出驗證。它是 fail-closed：若結構不同，會**拒絕啟動**並說明哪一項不符，不會放行。
  3. `copy_key.py` 的 GTK 剪貼簿行為（含 45 秒清空、Enter 清空）完全沒有執行過。
  4. 白名單的 `^[A-Z][A-Z0-9_]*=[^[:space:]]*$` 比 compose 實際接受的語法嚴格，不會放行不該放行的，但可能讓你手動加的合法行被拒絕（這是故意的）。
