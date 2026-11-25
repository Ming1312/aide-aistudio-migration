# Phase 6.8 零費用方案：可行性與安全檢查（2026-11-24）

狀態：只做了研究與本機（127.0.0.1）測試。**沒有建立 Tunnel、沒有對外開放任何服務、沒有安裝任何軟體、沒有開啟任何計費。**

## 結論

| 問題 | 結論 |
|---|---|
| 零費用能不能做測試架構？ | **可以，限測試用途。** 你的 Ubuntu 電腦跑引擎，Cloudflare Quick Tunnel 提供臨時 HTTPS，AI Studio 的 App 透過它呼叫真引擎 |
| 能不能長期正式對外？ | **不行。** Quick Tunnel 官方標示只供測試與開發、沒有可用性保證、網址每次重開都會變 |
| 必須付費才能做的功能 | 標記為**暫不支援**：固定網址（需自有網域或具名 Tunnel）、24 小時穩定運行、Cloudflare 的存取控制／WAF／限流（沒有查證免費條件，不使用） |
| 管理 API 與資料更新權限 | **不經 Tunnel 公開**：公開的引擎不設管理金鑰，寫入端點全部停用 |
| Gemini | 不設定 `GEMINI_API_KEY`，解釋功能走既有規則式降級 |

## Cloudflare Quick Tunnel（依官方文件，頁面修改日 2026-09-30）

- 不需要 Cloudflare 帳號、網域或付款方式。
- 限制：沒有可用性保證；每個 Tunnel 同時最多 200 個處理中請求，超過回 429；不支援 SSE；**主機名稱每次建立都會變**；cloudflared 一停，網址就失效。
- 官方定位：測試與開發；正式用途請改用具名 Tunnel。
- 知道網址的人都連得到你的本機服務；`--allowed-mail` 需要瀏覽器互動，我們的 Node 伺服器沒辦法通過，所以**不能用**。保護只能靠「API 金鑰＋唯讀設定」。
- 對你的影響：
  1. 每次重開 Tunnel，AI Studio Secrets 的 `ENGINE_BASE_URL` 都要手動換成新網址。
  2. 電腦關機或 Tunnel 停止時，App 會誠實顯示「尚未連線」（已驗證過這個行為）。

## 建議架構

```
瀏覽器 → AI Studio 的 React/Node App ──HTTPS──▶ https://隨機名稱.trycloudflare.com
                                                   │（cloudflared，只從你的電腦往外連；路由器不開任何埠）
                                      你的電腦 127.0.0.1:8088：Caddy（只放行 /health、/v1/*、6MB 上限）
                                                   │（Docker 內部網路）
                                                engine:8080（Python 引擎，非 root，記憶體 2g）
```

Docker／Caddy 這段與 Phase 6.7 CI 通過的設定完全相同（CI 覆蓋檔把 Caddy 綁在 127.0.0.1:8088）。

## 「公開唯讀」設定（Tunnel 只對這個設定開）

| 設定 | 值 | 目的 |
|---|---|---|
| `AIDE_API_KEY` | 新產生的 64 字元亂數（不沿用任何舊值） | 所有 `/v1/*` 都要金鑰 |
| `AIDE_ADMIN_KEY` | **不設定** | 沒設定＝五個寫入端點全部停用 |
| `AIDE_ALLOW_SIM` | **不設定** | 模擬寫入端點也停用 |
| `AIDE_SIM_FEED` | `1`（`AIDE_SIM_INTERVAL_S=300`、`AIDE_SIM_HOURS=1`） | 引擎內部自己推進合成資料，App 才有會更新的即時預測；不需要任何對外寫入端點 |
| `AIDE_RATE_PER_MIN` | `600` | 引擎是依來源 IP 限流；經 Caddy／Tunnel 後所有人共用同一個 IP，所以這個額度是全體共用 |
| `AIDE_DOMAIN` | `http://:80` | Caddy 不申請憑證（HTTPS 由 Cloudflare 提供） |

需要寫入（匯入、回復、重算）時：**先停掉 Tunnel**，再用只在本機（127.0.0.1）的另一組設定操作。

## 本機測試結果（引擎 127.0.0.1，未經 Tunnel，真引擎＋Node 正式模式）

測試腳本：`local_readonly_security_test.py`。

| 項目 | 結果 |
|---|---|
| T1 設定 | `live_writes_enabled=false`、`live_sim_enabled=false`、`sim_feed=true` |
| T2 寫入端點 | 五個端點，帶正確 API 金鑰＋亂猜的管理金鑰，**全部 403**；完全沒金鑰 401 |
| T3 內部資料流 | 沒有任何寫入端點，版本仍自己推進（1 → 3，約 45 秒內，測試用 15 秒一輪） |
| T4 無金鑰灌量 | 3000 次請求 1.1 秒內全部 401；隨後正確金鑰請求仍 200（無金鑰請求不消耗限流額度） |
| T5 限流 | 正確金鑰超過每分鐘 120 次 → 429，視窗過後恢復 |
| T6 大本文 | 300MB 無金鑰 POST 在 1 秒內回 401，引擎記憶體只增加約 57MB（沒有整份緩衝）；Caddy 的 6MB 上限是額外防線 |
| T7 錯誤處理 | 壞 JSON 回 4xx，沒有堆疊或檔案路徑；`/docs`、`/openapi.json` 404 |
| Node 對這個設定 | 七場域 `status`／`forecast` 全部 200（含資料不足的育成北側）；預測 15 個任務、每個 6 種方法、全標合成；`gemini_configured=false` |
| 日誌 | Node 與引擎日誌沒有金鑰 |
| 資源（粗估） | 15 秒一輪時引擎約 54% 單核、記憶體約 330MB；改 300 秒一輪預期 CPU 約 3%（外推，未實測）。版本庫約 4 輪後 1.3MB（153 個檔案）；以 5 分鐘一輪推算每天約百 MB，**長時間成長與是否需要清理沒有驗證**（本機磁碟剩 345GB） |

## 發現的問題與風險

1. **F12（新、輕微）**：引擎是唯讀設定時，管理者經 Node 按寫入（推進、重算、回復）會得到 502「引擎憑證設定有誤」，訊息誤導（真正原因是這個部署唯讀）。App 在 `live_sim_enabled=false` 時會隱藏「推進」按鈕，其他寫入按鈕是否隱藏我沒有驗證。**我沒有修改**（Phase 6.8 不新增功能）；之後可用一個小修正把「管理金鑰未設定」的 403 轉成「此部署為唯讀」。
2. **共用限流與可用性**：Quick Tunnel 沒有 WAF／限流可設。灌量攻擊不會拿到資料（401），但會佔用 200 個處理中請求上限，造成你自己的 App 暫時 429。對策：只在測試時段開 Tunnel、用完就停。
3. **`/health` 公開**：會揭露引擎版本、Python／pandas／numpy 版本、各資料集雜湊與旗標。Node 的連線探測需要它，風險低，接受。
4. **網址不是祕密**：金鑰才是；金鑰只放 AI Studio Secrets 與你電腦的 `.env`（權限 600）。懷疑外洩就換金鑰並重開 Tunnel。
5. 公開的資料是你已聲明可公開展示的七場域資料；合成資料都帶標記。

## 還不能驗證的（要等 Tunnel 真的開起來）

- AI Studio 執行環境能不能連到 trycloudflare.com、延遲有多少、Node 的 10 秒逾時夠不夠。
- 「唯讀設定」在 Docker 裡的行為：CI 驗過的是有管理金鑰的設定；唯讀設定我只在本機 uvicorn 驗過，程式碼相同，但沒有在 Docker 內跑。
- 修改 Secrets 後 AI Studio App 是否自動重啟並讀到新值。
- 200 個處理中請求上限在多人同時看七個場域時會不會碰到。
- 長時間運行（版本庫成長、記憶體、電腦睡眠）。

## 啟動步驟（你執行；我不會自己建立 Tunnel）

**A. 一次性準備**（需要你的 sudo）
1. Docker：需要 Docker Compose **2.24 以上**（CI 覆蓋檔用了 `!override`；Ubuntu 22.04 內建套件版本可能較舊，裝完請用 `docker compose version` 確認；不夠新就改裝 Docker 官方 apt 套件庫）。
2. cloudflared：用 Cloudflare 官方套件庫（pkg.cloudflare.com）或官方 `.deb`；裝之前請你確認來源。
3. 取得驗收包：repo 分支 `ci/docker-acceptance` 的 `ci/inputs/aide-engine-aistudio-1.0.0-20261123.tar.gz`（或本機 `outputs/phase6_3/deploy_bundle/` 同名檔）。解開前先比對 SHA-256 是 `f088f8ed6795336b523ea62448b79a2d67ee6b709b129bfeee02ee9acc938149`。

**B. 先只在本機跑（沒有 Tunnel）**
1. 解開、`openssl rand -hex 32` 產生新的 `AIDE_API_KEY`，寫成 `deploy/.env`（權限 600），內容照上面「公開唯讀」表格（不要放 `AIDE_ADMIN_KEY`）。
2. 建持久化目錄：`sudo install -d -o 10001 -g 10001 -m 750 /var/lib/aide/live_store /var/backups/aide`。
3. 用正式 compose 加 CI 覆蓋檔啟動（Caddy 只綁 127.0.0.1:8088），等 engine `healthy`。
4. 本機確認：`/health` 200、無金鑰 `/v1/live/domains` 401、帶金鑰 200、寫入端點 403。

**C. 開 Tunnel（測試時段才開）**
1. `cloudflared tunnel --no-autoupdate --url http://127.0.0.1:8088`，記下它印出的 `https://….trycloudflare.com`。
2. 在 AI Studio 的 Secrets 填 `ENGINE_BASE_URL`（那個網址，無結尾斜線）與 `ENGINE_API_KEY`（同 `.env` 的值）。不設定 `GEMINI_API_KEY`。值只由你填，不貼聊天。
3. 從外部驗證：`curl https://….trycloudflare.com/health` 200；無金鑰 `/v1/live/domains` 401。
4. 開 App 的「即時預測」：從「尚未連線」變成狀態與預測；七場域逐一點開。

**D. 用完**
`Ctrl+C` 停 cloudflared（網址立刻失效）→ `docker compose down`（資料保留在 `/var/lib/aide/live_store`）。下次重開要換 Secrets 裡的網址。

## 驗證分級

- **本次真的驗過**：唯讀設定的行為、限流、寫入停用、Node 對該設定的讀取與離線處理、日誌無金鑰。
- **之前 CI 真的驗過**：Docker 建置、Caddy、容器互通、重啟與持久化。
- **尚未驗證**：見上節。
