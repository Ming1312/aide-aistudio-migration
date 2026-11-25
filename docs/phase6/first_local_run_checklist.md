# 第一次本機安裝與測試檢查表（只限本機；不含 cloudflared 與 Tunnel）

**使用方式**
- 一次只做一個階段；每一步先看「預期」，不符就照「停止條件」停下，把畫面貼給我，不要自己重試。
- 全程**不要**執行：`docker compose config`（不帶 `-q`，會印出金鑰）、`docker inspect aide-engine`（不加 `-f`，會印出金鑰）、`bash -x …`、`set -x`。
- 本表不包含 cloudflared、Tunnel、AI Studio、GitHub。那些要你另外授權。
- 標 **（你）** 的步驟需要你的 sudo 或你自己決定；其他指令我可以在你授權後代為執行。
- 目錄約定：`KIT=<repo>/demo_kit`，`cd "$KIT"` 後執行腳本。

---

## 階段 0　基準紀錄（唯讀，沒有任何改變）

| 步驟 | 指令 | 預期 | 停止條件 |
|---|---|---|---|
| 0.1 | `cd "$KIT" && for f in *.sh; do bash -n "$f" && echo OK $f; done` | 7 個都 `OK` | 任何一個報錯 |
| 0.2 | `docker --version; podman --version` | 兩個都「找不到指令」（目前沒裝） | 已經有 docker／podman（先停，我要重評估衝突） |
| 0.3 | `sysctl net.ipv4.ip_forward; ip -o -4 addr show \| awk '{print $2,$4}'; ls -ld /var/lib/aide /var/backups/aide 2>&1` | `ip_forward = 0`；只有 `lo`、`enp4s0 192.168.1.142/24`；兩個目錄不存在 | 與審查時不同（先停） |
| 0.4 | `env \| cut -d= -f1 \| grep -E '^(DOCKER_\|COMPOSE_\|http_proxy\|https_proxy\|HTTP_PROXY\|HTTPS_PROXY)$' \|\| echo 沒有` | `沒有` | 有任何一個（先告訴我；腳本會忽略 DOCKER_／COMPOSE_，但我要知道） |
| 0.5 | `ss -ltn \| awk 'NR>1{print $4}' \| sort > ~/ss_before.txt` | 存下目前的監聽清單，之後比對 | — |

## 階段 1　安裝 Docker（你；需要 sudo）

照 Docker 官方文件「Install using the apt repository」：<https://docs.docker.com/engine/install/ubuntu/>。**不要**安裝 cloudflared。

| 步驟 | 指令 | 預期 | 停止條件 |
|---|---|---|---|
| 1.1 | `docker --version; docker compose version` | 有版本；**Compose ≥ 2.24.0** | Compose 低於 2.24.0；安裝出現錯誤 |
| 1.2 | `sudo usermod -aG docker "$USER"` 後**登出再登入** | `id \| grep -c docker` 為 `1` | 沒有重新登入就繼續 |
| 1.3 | `docker info >/dev/null && echo 可連線` | `可連線`（不需要 sudo） | 權限錯誤 |
| 1.4 | `docker context show; docker context inspect "$(docker context show)" --format '{{.Endpoints.docker.Host}}'` | `default`；`unix:///var/run/docker.sock` | 任何其他值（尤其 `ssh://`、`tcp://`） |
| 1.5 | `docker ps -a; docker images` | 兩個都是空的 | 有不認得的容器或映像 |
| 1.6 | `sysctl net.ipv4.ip_forward; ip -o -4 addr show \| awk '{print $2,$4}'` | `ip_forward = 1`（Docker 設的，預期內）；多了 `docker0 172.17.0.1/16`；`192.168.1.0/24` 不受影響 | 區網連線異常、或 `docker0` 網段與你的 VPN／區網重疊 |
| 1.7 | `systemctl is-enabled docker` | `enabled`（開機自動啟動，預期內；想關掉由你決定） | — |

## 階段 2　封包與持久化目錄

| 步驟 | 指令 | 預期 | 停止條件 |
|---|---|---|---|
| 2.1 | `mkdir -p ~/aide-demo/bundle && cp "<repo>/ci/inputs/aide-engine-aistudio-1.0.0-20261123.tar.gz" ~/aide-demo/bundle/` | 複製成功 | 檔案不存在 |
| 2.2 | `sha256sum ~/aide-demo/bundle/*.tar.gz` | `f088f8ed6795336b523ea62448b79a2d67ee6b709b129bfeee02ee9acc938149` | 任何不同的值（`ffd4ec6f…` 是已失效的舊版） |
| 2.3（你） | `sudo install -d -o 10001 -g 10001 -m 750 /var/lib/aide/live_store /var/backups/aide` | 無輸出 | 錯誤訊息 |
| 2.4 | `stat -c '%u %a %n' /var/lib/aide/live_store /var/backups/aide` | 兩行都是 `10001 750 …` | 擁有者或權限不同 |

## 階段 3　preflight（唯讀，不啟動任何東西）

| 步驟 | 指令 | 預期 | 停止條件 |
|---|---|---|---|
| 3.1 | `cd "$KIT" && ./preflight.sh` | 結尾 `失敗 0 項`；`WARN` 只允許「沒有安裝 cloudflared」；有 `[ OK ] docker 目標是本機：unix:///var/run/docker.sock`、`docker compose 2.x（>= 2.24.0，支援 !override）`、`引擎封包 SHA-256 相符`、兩個持久化目錄 uid 10001、`本機連接埠 8088 空閒`；「引擎尚未解開」與「設定檔尚未建立」是**資訊**行，正常 | 任何 `[FAIL]`（腳本會印出處理方式；照做前先貼給我） |

## 階段 4　第一次 `./start_local.sh`

執行：`./start_local.sh`（預設 900 秒一輪、資料流開啟）。**邊看邊對照下表**，每個 `== n/8` 都有預期輸出。

| 階段 | 預期輸出 | 停止條件（腳本會自己停；你看到就不要重試） |
|---|---|---|
| 1/8 啟動前檢查 | 沒有輸出就代表通過（`--quiet`） | 出現 `[FAIL]` 或 `[停止]` |
| 2/8 引擎封包 | `已解開到 …/aide（SHA-256 已驗證）` | `SHA-256 不符`、`封包含有絕對路徑`、`最上層不是 aide/` |
| 3/8 設定檔 | `已建立 …/demo.env（權限 600）。金鑰沒有顯示…`；`資料流：AIDE_SIM_FEED=1、每 900 秒一輪` | `設定檔不合格：…`（訊息只含行號或名稱，不含值） |
| 4/8 再檢查 | 無輸出＝通過 | 任何 `[FAIL]` |
| 5/8 compose | `compose 守門通過：只綁 127.0.0.1:8088、引擎 8080 不發佈…`；然後建置映像（第一次幾分鐘，日誌 `~/aide-demo/state/build.log`） | **`compose 設定不符合…`**（這是 `compose_gate.py` 第一次吃真的 Docker 輸出，見「待驗證項目」；它只列出不符的項目名稱，不含值；**停止，貼給我**）；`映像建置失敗`（看 build.log 最後 30 行，腳本已印出） |
| 6/8 啟動 | 沒有錯誤，等到 healthy | `180 秒內沒有變成 healthy`（腳本自動 `compose stop`；用 `docker logs aide-engine --tail 30` 看原因） |
| 7/8 驗證 | 三段 API 輸出：`readonly=yes live_writes_enabled=False live_sim_enabled=False`；`no-key=401 wrong-key=401`；五個寫入端點 `with-api-key=403`、`sim/tick: no-key=401`；最後一行 `確認：唯讀、寫入端點全部拒絕、只綁 127.0.0.1:8088…` | 任何 `[停止]`（腳本自動停容器） |
| 8/8 合成標記 | `羊舍即時預測的所有任務都標了 contains_synthetic`（或 `還沒有第一個預測版本` 警告，稍後再看） | `即時預測有任務沒有標記為合成資料` |

結尾應是：`完成。本機網址：http://127.0.0.1:8088（只有這台電腦連得到）。目前沒有任何公開網址。`

## 階段 5　獨立驗證（我不靠腳本自己的檢查；逐項手動、唯讀）

| 步驟 | 指令 | 預期 | 停止條件 |
|---|---|---|---|
| 5.1 | `./status.sh` | 兩個容器 `running / healthy`；`Caddy 對主機發佈：80/tcp -> 127.0.0.1:8088`；`引擎 8080：未發佈到主機（正確）`；`唯讀：是`；Tunnel `未開啟`；磁碟可用 GB；版本庫大小；七場域版本數；`合成標記…`；`總結：正常。`（或只有「版本庫大小：…」資訊） | `總結` 為 `有嚴重問題` |
| 5.2 | `docker ps --format '{{.Names}}\t{{.Ports}}'` | `aide-caddy` 的 Ports 只有 `127.0.0.1:8088->80/tcp`（可有 `443/tcp, 2019/tcp` 這種**沒有 `->`** 的）；`aide-engine` 只有 `8080/tcp` | 出現 `0.0.0.0:` 或 `:::` |
| 5.3 | `ss -ltn \| awk 'NR>1{print $4}' \| sort > ~/ss_after.txt; diff ~/ss_before.txt ~/ss_after.txt` | 只多了 `127.0.0.1:8088`（可能再多 Docker 自己的內部項目，但**不可有** `0.0.0.0:8088`、`*:8088`、任何 `:8080`、`:80`、`:443`） | 多了任何非 127.0.0.1 的監聽 |
| 5.4 | 從**同一區網的另一台裝置**（手機瀏覽器或另一台電腦）開 `http://192.168.1.142:8088/health` | 連不上（拒絕連線或逾時） | 連得上（立刻 `./stop_demo.sh` 並告訴我） |
| 5.5 | `curl -s http://127.0.0.1:8088/health \| python3 -c "import sys,json;h=json.load(sys.stdin);print({k:h[k] for k in ('version','read_only','live_writes_enabled','live_sim_enabled','sim_feed','auth_required')})"` | `version` 以 `aistudio-1.0.0` 開頭、`live_writes_enabled False`、`live_sim_enabled False`、`sim_feed True`、`auth_required True` | 任何寫入旗標是 True |
| 5.6 | `for p in /v1/live/domains /docs /openapi.json / /.env; do printf '%s ' $p; curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8088$p; done` | `/v1/live/domains 401`、其餘四個 `404` | 任何 200 |
| 5.7 | `docker exec aide-engine id -u` | `10001` | 不是 10001 |
| 5.8 | `docker inspect -f '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{println}}{{end}}' aide-engine` | 恰好兩行：`/var/lib/aide/live_store -> /app/data/live_store`、`/var/backups/aide -> /backups` | 多或少一行 |
| 5.9 | `docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' aide-engine \| cut -d= -f1 \| sort` | 名稱清單**不含** `AIDE_ADMIN_KEY`、`AIDE_ALLOW_SIM`、`AIDE_DATA_DIR`、`AIDE_ALLOWED_ORIGINS`、`GEMINI_*`、`GOOGLE_*`；含 `AIDE_API_KEY`、`AIDE_REQUIRE_KEY`、`AIDE_LIVE_ROOT` | 出現任何禁用名稱 |
| 5.10 | `docker stats --no-stream --format '{{.Name}} {{.MemUsage}} {{.CPUPerc}}'` | engine 記憶體遠低於 2GiB 上限 | 接近 2GiB |
| 5.11 | 金鑰洩漏掃描（金鑰不在命令列）：<br>`( docker logs aide-engine 2>&1; docker logs aide-caddy 2>&1; cat ~/aide-demo/state/*.log ~/aide-demo/state/demo.log 2>/dev/null; ps -eo args ) \| python3 -B -c "import sys,os;k=[l.split('=',1)[1].strip() for l in open(os.path.expanduser('~/aide-demo/state/demo.env')) if l.startswith('AIDE_API_KEY=')][0];print('洩漏' if k in sys.stdin.read() else '乾淨')"` | `乾淨` | `洩漏`（立刻 `./stop_demo.sh`，刪除 `demo.env`，告訴我是哪一類輸出） |
| 5.12 | `stat -c '%a' ~/aide-demo/state ~/aide-demo/state/demo.env; cut -d= -f1 ~/aide-demo/state/demo.env \| grep -v '^#'` | `700`、`600`；名稱恰好 7 個：`AIDE_DOMAIN AIDE_API_KEY AIDE_RATE_PER_MIN AIDE_STALE_AFTER_H AIDE_SIM_FEED AIDE_SIM_INTERVAL_S AIDE_SIM_HOURS`（只顯示名稱，不顯示值） | 權限不對、或有別的名稱 |
| 5.13（待驗證） | `./copy_key.sh`，到文字編輯器貼上確認有內容後，回終端機按 Enter；再貼一次 | 第一次貼得到 64 字元；按 Enter 後顯示 `剪貼簿已清空。`，再貼是空的；不按 Enter 則 45 秒後同樣清空；`ps -eo args \| grep -c copy_key.py` 結束後為 `0`（只算 grep 自己） | 無法複製、沒清空、或留下行程。**貼完請立刻清掉編輯器內容並不要儲存**；若你的桌面有剪貼簿歷史工具，請一併檢查 |

## 階段 6　資料流、持久化、停止與重啟

| 步驟 | 指令 | 預期 | 停止條件 |
|---|---|---|---|
| 6.1 | 等 **30 分鐘以上**，再 `./status.sh` | 各場域版本數比 5.1 多（約 +2；每 900 秒一輪、每輪每場域 +1）；`./status.sh` 會寫入 `~/aide-demo/state/growth.tsv` | 版本數沒有增加（看 `docker logs aide-engine --tail 50`，應只有一般請求日誌，沒有 `sim tick failed`） |
| 6.2 | 隔 ≥ 1 小時再 `./status.sh` | 出現「成長估計：約 N MB／天」；我預期約 25 MB／天（外推，未實測） | 估計 > 200 MB／天，或可用空間 < 20 GB |
| 6.3 | 記下 `./status.sh` 的各場域版本數與 `總計`（記為 N1），然後 `docker restart aide-engine` 並等 healthy，再 `./status.sh` | 版本數 ≥ N1，沒有歸零；`唯讀：是` 仍成立 | 版本數變少或歸零 |
| 6.4 | `./stop_demo.sh` | 依序 `沒有由本套件開的 Tunnel`、停止並移除容器、`保留：/var/lib/aide/live_store`、`/var/backups/aide`、引擎目錄、映像、`demo.env`；結尾 `已停止。目前沒有任何服務在執行，也沒有公開網址。` | 任何錯誤；或出現「找不到 /var/lib/aide/live_store」 |
| 6.5 | `docker ps -a \| grep -c aide; ls -ld /var/lib/aide/live_store; docker images --format '{{.Repository}}' \| grep -c aide-demo-engine; ls ~/aide-demo` | `0`；目錄仍在；映像 `1`；`bundle engine state` 都在 | 目錄或映像消失 |
| 6.6（你） | `sudo ls /var/lib/aide/live_store \| head; sudo du -sh /var/lib/aide/live_store` | 有七個場域的資料夾、大小與 6.1 相近 | 空的 |
| 6.7 | `./start_local.sh`（第二次） | 不再解開封包、不再建置映像；`沿用已解開的…`、`映像 … 已存在，略過建置`、金鑰**不變**（不會產生新金鑰）；7/8 通過 | 任何 `[停止]` |
| 6.8 | `./status.sh` | 各場域版本數 **≥ N1 且接續成長**（不是從 1 重新開始） | 版本數少於 N1 |
| 6.9（可選，驗證「不影響其他 Docker 專案」） | 你先啟動一個無關容器 `docker run -d --name zz-other busybox sleep 3600`，再 `./stop_demo.sh`，然後 `docker ps --format '{{.Names}}'` | `zz-other` 仍在執行；`./stop_demo.sh` 沒有動它。**測完你自己** `docker rm -f zz-other`（這是你的容器，腳本不會刪） | `zz-other` 被停止 |

## 階段 7　負面測試（確認守門真的會擋；可選但建議）

做之前先備份：`cp -p ~/aide-demo/state/demo.env ~/aide-demo/state/demo.env.bak`（內含金鑰，測完刪除）。

| 步驟 | 指令 | 預期 | 停止條件／收尾 |
|---|---|---|---|
| 7.1 | `echo 'AIDE_DATA_DIR=/tmp' >> ~/aide-demo/state/demo.env; ./preflight.sh` | `[FAIL] 設定檔不合格：含有不在允許清單內的名稱：AIDE_DATA_DIR …`，結束碼 1 | 沒有被擋下 |
| 7.2 | `cp -p ~/aide-demo/state/demo.env.bak ~/aide-demo/state/demo.env; echo 'AIDE_ADMIN_KEY=x' >> ~/aide-demo/state/demo.env; ./preflight.sh` | 同上，名稱為 `AIDE_ADMIN_KEY` | 沒有被擋下 |
| 7.3 | `cp -p ~/aide-demo/state/demo.env.bak ~/aide-demo/state/demo.env; DOCKER_HOST=ssh://example ./preflight.sh` | 有 `[WARN] 你的 shell 環境有 DOCKER_HOST：腳本會忽略它`，且 docker 目標檢查仍通過 | 腳本去連 ssh |
| 7.4 | `bash -x ./start_local.sh` | 立刻 `[停止] 不允許用 bash -x／set -x 執行…`，沒有任何 trace 外洩的值 | 繼續往下跑 |
| 7.5 | `docker create --name aide-engine busybox true`（你；製造同名容器）然後 `./preflight.sh` | `[FAIL] 已經有一個不屬於 aide-demo 專案、名稱也叫 aide-engine 的容器` | 沒擋下。**測完你自己** `docker rm aide-engine`（必須先停掉我們的 aide-demo 專案再測；否則 Docker 本來就不允許同名） |
| 收尾 | `mv ~/aide-demo/state/demo.env.bak ~/aide-demo/state/demo.env`（或 `cp -p` 回去後 `shred -u` 備份）；`stat -c '%a' ~/aide-demo/state/demo.env` | `600`；`./preflight.sh` 恢復無 FAIL | 備份檔留在磁碟上 |

## 階段 8　結束或回復

- 結束展示：`./stop_demo.sh`。資料保留。
- 想徹底回復（**由你決定，腳本不會做**）：移除映像 `docker image rm aide-demo-engine`；刪除 `~/aide-demo`（含金鑰與已解開的引擎）；`sudo gpasswd -d "$USER" docker`；移除 `/var/lib/aide`、`/var/backups/aide`（**會刪掉版本庫**，先確認不需要）；解除安裝 Docker 照官方文件。
- **cloudflared 與 Tunnel 不在本表**：全部本機驗證通過後，由你另外授權才做。

---

## 待驗證項目（本表會順便驗證，但目前都是「未驗證」）

| 項目 | 目前狀態 | 在哪一步驗證 | 失敗時會怎樣 |
|---|---|---|---|
| `compose_gate.py` 對**真的** `docker compose config --format json` 輸出格式的假設（ports 的 `host_ip`／`published` 型別、volumes 長格式、`environment` 是 map 且含 env_file 的變數、`image` 欄位） | 只用合成 JSON 測過；與 CI 看到的 YAML 結構一致，但沒用真 Docker 輸出驗證 | 階段 4 的 5/8 | **Fail-closed**：它會拒絕啟動並只列出不符的項目名稱，不會放行；那時我再依真的輸出修正 |
| `copy_key.py` GTK 剪貼簿（Enter 清空、45 秒自動清空、Ctrl+C 清空、不留行程） | 完全沒執行過 | 階段 5 的 5.13 | 無法使用時改用密碼管理員自己存取（金鑰不經過本套件） |
| **F12**：唯讀時管理者在 App 按寫入會看到 502「引擎憑證設定有誤」 | 已知、未修；**本機測試觀察不到**（沒有 App 連進來） | 要等 Tunnel 與 AI Studio（另外授權） | 只是訊息誤導，不影響安全；README 與腳本都有警告 |
| 「唯讀設定」在 Docker 內的行為 | CI 驗過有管理金鑰的設定；唯讀設定只在本機 uvicorn 驗過 | 階段 4 的 7/8、階段 5 | 腳本會自動停止容器 |
| 版本庫長時間成長 | 外推約 25 MB／天（900 秒一輪），未實測 | 階段 6.1–6.2 | 用 `--interval 1800` 或 `--no-feed` |
| `restart: unless-stopped`：重開機後引擎與 Caddy 是否自動回來且仍只綁 127.0.0.1 | 未驗證 | 可選：你重開機後 `./status.sh` | 想避免就每次用完 `./stop_demo.sh`（會移除容器） |
| AI Studio 能否連到 trycloudflare.com、延遲與逾時、Secrets 改動後是否自動重啟 | 未驗證 | 不在本表（Tunnel 階段） | — |
