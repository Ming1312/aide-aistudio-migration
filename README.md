# AIDE 智慧環境監測與決策平台（v1.1.0）

七個真實資料場域（羊舍、專家系統 C22、三爺宮溪、工地 CB13505、東北角、育成一廠、育成一廠北側）的環境監測、預測、資料更新與決策輔助。
由兩部分組成：

| 部分 | 內容 | 執行位置 |
|---|---|---|
| **App**（本 repo 根目錄） | React + Express/Node。Google AI Studio Build Mode 產生並匯出的版本；Node 端代理 Python 引擎、保管 Secrets | AI Studio（Cloud Run）或本機 `npm run dev` |
| **Python 引擎**（`engine/`、`ci/inputs/`） | FastAPI；HGB／XGBoost 與基準模型；唯讀 API、合成資料流、決策輔助 | 你自己電腦上的 Docker（`demo_kit/`），只在本機執行、不對公網開放（封包檔案本身在本 repo 內） |

原始 Streamlit 研究專案與其模型、凍結的研究結果**不在、也沒有被這個 repo 修改**。

> 這個 repo 含七場域的真實資料（使用者已聲明可公開展示；來源與使用聲明見 `public/data/real_public/DATA_USE_STATEMENT.md`）與合成展示資料，兩者分開標示。**自 2026-11-25 起本 repository 為公開（public）**，包含七場域真實資料，以及 `ci/inputs/` 引擎封包內的原始 CSV 與模型。資料授權只有使用者聲明（本競賽專題範圍），沒有標準開放授權；競賽以外的再散布或商業使用請先向資料提供者確認。

## 結案文件（v1.1.0 最終交付）

| 文件 | 內容 |
|---|---|
| [`docs/final/01_PROJECT_SUMMARY.md`](docs/final/01_PROJECT_SUMMARY.md) | **成果說明**（給指導老師與評審）：動機、問題定義、創新性、方法、結果、功能、價值、限制 |
| [`docs/final/02_ARCHITECTURE_AND_DATAFLOW.md`](docs/final/02_ARCHITECTURE_AND_DATAFLOW.md) | 系統架構與資料流、安全設計 |
| [`docs/final/03_MODELS_RESEARCH_AND_VALIDATION.md`](docs/final/03_MODELS_RESEARCH_AND_VALIDATION.md) | AI 模型、研究方法與驗證結果（含出處） |
| [`docs/final/04_DOMAIN_FEATURES_AND_USAGE.md`](docs/final/04_DOMAIN_FEATURES_AND_USAGE.md) | 七場域功能與使用說明 |
| [`docs/final/05_OPERATIONS_MANUAL.md`](docs/final/05_OPERATIONS_MANUAL.md) | 本機啟動、停止、免費 Tunnel、AI Studio 設定手冊 |
| [`docs/final/06_FINAL_ACCEPTANCE_REPORT.md`](docs/final/06_FINAL_ACCEPTANCE_REPORT.md) | **最終驗收報告**：已完成／已驗證／部分完成／未驗證 |
| [`docs/final/07_LIMITATIONS_AND_FUTURE_WORK.md`](docs/final/07_LIMITATIONS_AND_FUTURE_WORK.md) | 已知限制與未來發展方向 |
| [`docs/final/08_DEMO_SCRIPT.md`](docs/final/08_DEMO_SCRIPT.md) | 競賽展示操作腳本 |
| [`docs/final/00_FINAL_DELIVERABLES.md`](docs/final/00_FINAL_DELIVERABLES.md) | 最終交付清單與檔案位置 |

**一句話現況**：功能已凍結，不再新增功能、模型或部署架構。沒有開放中的阻擋性問題；F12（唯讀部署下管理者寫入顯示誤導訊息）等非阻擋問題與限制如實保留，見驗收報告。

## 分支

| 分支 | 內容 |
|---|---|
| `release/aide-v1.1.0` | **完整最新版（結案版本）**：App（含 F10、F11、F13 修正）、Python 引擎原始碼、Docker 部署設定、CI 驗收腳本、`demo_kit/`、Phase 6.5～6.8 文件、`docs/final/` 結案文件 |
| `main` | 較早的遷移包（Phase 6.4 為止），保留未動 |
| `ci/docker-acceptance` | Phase 6.7 的 Docker／Caddy 隔離驗收（GitHub Actions），保留未動 |

## 目錄

```
src/ server/ server.ts           App（前端、Node 代理、測試）
reference/ contracts/ tools/     管理者驗證、Gemini 解釋、API 契約、雜湊產生器
public/data/                     真實資料（real_public）與合成資料（demo_synthetic）、預計算結果
engine/                          Python 引擎的「文字原始碼」與部署設定（不含模型與資料，見下）
ci/                              Docker／Caddy 驗收腳本；inputs/ 內是引擎封包與 App 匯出（SHA-256 固定在 EXPECTED_SHA256）
demo_kit/                        本機唯讀展示套件（啟動／停止／Tunnel／狀態檢查）
docs/01…10                       遷移規格；docs/phase6/ 是 Phase 6.6～6.8 的整合與驗收報告、patch；docs/final/ 是結案文件
.github/workflows/               docker-acceptance（只在 ci/docker-acceptance 分支或手動觸發）
```

`engine/` 是從 `ci/inputs/aide-engine-aistudio-1.0.0-20261123.tar.gz`（SHA-256 `f088f8ed…938149`）取出的文字部分，方便審閱；**模型（`models/`）、資料（`data/`）、輸出（`outputs/`）只在那個 tar.gz 裡**。實際部署一律用 tar.gz。

## 開發、測試與建置

需要 Node ≥ 22。

```bash
npm install
npm run lint     # tsc --noEmit
npm test         # tsx --test，9 個測試檔、63 項
npm run build    # vite build
npm run dev      # tsx server.ts（本機開發，埠由 server.ts 決定）
```

版本 v1.1.0 發佈前結果：`tsc` 0 錯誤；63/63 測試通過；Vite build 成功。

## 本機啟動 Python 引擎（唯讀、零費用）

完整步驟、安裝會改變系統的哪些地方、資料放哪裡，都在 [`demo_kit/README.md`](demo_kit/README.md)。摘要（Ubuntu、需 Docker Compose ≥ 2.24）：

```bash
mkdir -p ~/aide-demo/bundle
cp ci/inputs/aide-engine-aistudio-1.0.0-20261123.tar.gz ~/aide-demo/bundle/
cd demo_kit
./preflight.sh        # 啟動前檢查（唯讀）
./start_local.sh      # 引擎＋Caddy，只綁 127.0.0.1:8088；第一次會產生 API 金鑰（不顯示）
./status.sh           # 狀態
```

- 預設**唯讀**：沒有 `AIDE_ADMIN_KEY`、`AIDE_ALLOW_SIM`，匯入／提交／回復／重算／模擬推進全部回 403。
- 引擎 8080 不發佈到主機；Caddy 只綁 `127.0.0.1`。
- 引擎內建合成資料流，預設每 900 秒推進 1 個模擬小時，所有合成資料帶 `synthetic` 標記，不會當成真實資料。
- 停止並保留資料：`./stop_demo.sh`。要換金鑰：停止後刪除 `~/aide-demo/state/demo.env`，下次 `./start_local.sh` 會產生新的。

## 免費 Tunnel（Cloudflare Quick Tunnel，只在要用的時段開）

AI Studio 在雲端，連不到你電腦的 `127.0.0.1`。展示時用 Quick Tunnel 暫時開一個公開 HTTPS 網址（免費、不需帳號與信用卡）：

```bash
cd demo_kit
./start_tunnel.sh     # 只能在互動式終端機手動執行；要親自輸入確認句；預設 4 小時後自動關閉
./stop_demo.sh --tunnel-only
```

務必知道：

- 網址是**臨時的公開網址**，不是有身分驗證的私人連線；唯一保護是 API 金鑰、唯讀設定、Caddy 只轉送 `/health` 與 `/v1/*`。
- Quick Tunnel 由 Cloudflare 終止 TLS，Cloudflare 看得到 `X-API-Key`。**金鑰只用在這個展示，用完就換。**
- 網址每次重開都會變；Cloudflare 官方說明 Quick Tunnel 只供測試與開發，沒有可用性保證。
- 這不是正式部署；長期使用需要自己的網域與 named tunnel／反向代理與認證。

## AI Studio Secrets 設定

只在 AI Studio → Settings → Secrets 填值，**不要把值寫進 repo、貼進 Prompt 或聊天**。`.env.example` 只列名稱（刻意不放任何範例值或註解：AI Studio 會把 `.env.example` 內的文字自動填進 Secrets，曾因此讓 App 誤用範例文字而顯示離線）。

| 名稱 | 填什麼 |
|---|---|
| `ENGINE_BASE_URL` | `start_tunnel.sh` 印出的 `https://….trycloudflare.com`，結尾不加斜線 |
| `ENGINE_API_KEY` | 與引擎 `AIDE_API_KEY` 同值；用 `demo_kit/copy_key.sh` 複製到剪貼簿再貼上 |
| `ENGINE_ADMIN_KEY` | AI Studio 可能要求這個名稱；**維持隨機佔位字串**（引擎沒有管理金鑰，不是真的金鑰） |
| `ADMIN_PASSPHRASE_HASH` | 管理者密碼的雜湊（`pbkdf2$…`）；用 `tools/make_admin_hash.py` 在自己的終端機產生。**不設定＝所有人唯讀** |
| `GEMINI_API_KEY` | 不要自己貼；展示維持 Free Tier，不呼叫付費 API。沒有金鑰時解釋功能走規則式降級並標示「非 AI 生成」 |
| `GEMINI_MODEL` | 可選 |

填好後按 Apply changes，開 `/api/health` 應看到 `engine_connected: true`、`live_writes_enabled: false`。
引擎連不上時 App 不會當機：決策輔助改用預計算結果並標示來源（`precomputed`），即時預測頁保留上次畫面並說明離線，不會拿預計算檔冒充即時預測。

> **v1.1.0 之後的本機變更（尚未推送、未在 AI Studio 驗證）**：「場域決策」五頁（風險評估、處置決策、異常診斷、AI 預測、歷史回放）七個場域一視同仁（研究預測＋假定門檻；羊舍不再有專屬頁）；即時預測頁在沒有引擎時改為「預先準備資料＋模擬新資料匯入」展示。另有：管理者改為「帳號＋密碼」登入，並提供**公開的展示預設帳號 `demo`／`aide-demo`**（只能看管理狀態、**不能寫入引擎**；一設定 `ADMIN_PASSPHRASE_HASH` 就自動停用）、F12 訊息修正。見 [`docs/final/09_CHANGES_AFTER_V1_1_0.md`](docs/final/09_CHANGES_AFTER_V1_1_0.md)。

## 已驗證與已知限制

2026-11-25 完成的遠端整合驗收（AI Studio → Node → Cloudflare Quick Tunnel → Caddy → Python 引擎；零新增費用）：七場域的預測／異常／決策輔助皆來自引擎、自動更新（30 秒輪詢，v13→v14）、Tunnel 關閉後的離線降級。細節見 [`docs/phase6/remote_acceptance_report.md`](docs/phase6/remote_acceptance_report.md)。

| 項目 | 狀態 |
|---|---|
| **F12（未修正）** | 唯讀部署下，**管理者**在 App 按寫入（匯入／提交／回復／重算／模擬推進）會看到 502「引擎憑證設定有誤」；真正原因是引擎停用寫入（403：管理金鑰未設定）。檢視者看不到寫入按鈕，不受影響。最小修正已寫成 [`docs/phase6/patches/f12_readonly_message.patch`](docs/phase6/patches/f12_readonly_message.patch)，**尚未套用、尚未實測**（需管理者登入，密碼只由使用者輸入） |
| F10、F11 | 已修正（`server/routes.ts` 等），含在本版與 CI 輸入的 App 匯出內 |
| F13 | 已修正（育成一廠北側「資料更新」頁不再崩潰）；新增 2 項單元測試 `src/lib/stepFactsNoGuard.test.ts` |
| 尚未驗證 | 管理者寫入流程、區網其他裝置連線、電腦重開機後自動重啟、Tunnel 4 小時自動關閉的實際行為、版本庫長時間成長 |
| 平台觀察 | 引擎離線時直接 `fetch /api/live/<場域>/status` 得到 200 的 HTML（疑為平台代理處理 503），UI 仍正確顯示離線；原因未深究 |
| 研究性質 | 預測為「探索性、未經獨立前瞻驗證」；候選異常是「候選事件，不是故障判定」；系統不控制任何設備 |

## CI

`ci/` 與 `.github/workflows/docker-acceptance.yml` 是 Phase 6.7 的隔離驗收，只在 `ci/docker-acceptance` 分支推送或手動觸發時執行，不使用任何 repo secret。`ci/EXPECTED_SHA256` 固定的是**當時**的 App 匯出（含 F10／F11，不含 F13）與引擎封包；本版 App 原始碼在根目錄，兩者不同是刻意保留的驗收證據。
