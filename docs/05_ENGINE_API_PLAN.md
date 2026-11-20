# 05 Python AI 引擎的保留與 API 化方案

## 1. 決策：保留 Python 引擎，用 API 包起來；不重寫成 JavaScript

| 選項 | 結論 | 理由 |
|---|---|---|
| A. 引擎保留 Python，FastAPI 包裝，獨立部署 | **採用** | 模型是 scikit-learn／XGBoost pickle；特徵、因果性、守門、版本庫、雜湊鏈全部是既有、已測試的程式（1,600+ 項測試、543 筆回放 `real_decision_diff: 0`） |
| B. 把 HGB／XGBoost 匯出成 JSON 在瀏覽器推論 | 不採用（目前） | 等於換一個實作，要重做全部驗證；樹模型可行但特徵工程與守門要逐項重寫；之後若需要離線推論再評估，必須先做『逐位元一致』測試 |
| C. 用 Gemini 或簡化公式『假裝』預測 | **禁止** | 會取代原本模型；違反『不可用假預測取代原本模型』 |
| D. Pyodide 在瀏覽器跑 Python | 不採用 | sklearn 1.9.1／xgboost 3.4.1 pickle 與記憶體限制；啟動慢 |

AI Studio Build Mode 的應用是 React 前端＋Node.js 伺服器；**沒有 Python 執行環境**。所以引擎必須在別處執行（Cloud Run／其他容器主機／你自己的機器），Node 伺服器以 HTTP 呼叫它。

## 2. 目標架構

```
瀏覽器（React；AI Studio 預覽／已發布網址）
   │  /api/*（同源；沒有任何金鑰）
Node.js 伺服器（AI Studio Build Mode）
   │  Secrets：GEMINI_API_KEY（AI Studio 自動提供）、ENGINE_BASE_URL、ENGINE_API_KEY、ADMIN_PASSPHRASE_HASH
   ├── Gemini（@google/genai）：只解釋『事實清單』（reference/geminiExplain.ts）
   └── HTTPS ──► Python 引擎（FastAPI；python_engine_private/；容器）
                    ├─ 真實資料（唯讀）、模型 artifact（sha256 驗證）
                    └─ workspace 版本庫（W 類功能；PLANNED）
```

## 3. 已完成的引擎（Phase 6.3；`python_engine_private/main.py`）
* 唯讀、無寫入端點；FastAPI＋uvicorn；`X-API-Key`、速率限制、可選 CORS 白名單。
* 直接重用既有模組（`p582_engine`、`p586_anomaly`、`p55_analysis`、`phase26_predict`、`model_registry` 等 35 個 `src` 模組的 import 閉包；**沒有修改任何一個**）。
* 驗收：90 個任務、540 個預測值與既有引擎逐位元相同；`tools/p63_api_check.py` 全部通過。
* 離線備援：`tools/p63_build_precomputed.py` 用同一份引擎產生『預計算』結果（見 `optional_real_data_bundle/`；只有在你決定使用真實資料時才用）；合成展示的逐步輸出已在 `public/data/demo_precomputed/`。

## 4. W 類功能的 API 化做法（PLANNED，M3–M5）
1. **workspace 抽象**：把 `Store(stem, root)` 的 `root` 參數化成 `<WORKSPACES_ROOT>/<workspace_id>`（既有程式已支援自訂 root／`AIDE_DATA_DIR`）；`POST /v1/workspaces` 從展示種子複製。
2. **逐一包裝既有函式**（見 `docs/04` §2）；包裝層只做：驗證輸入、轉 JSON、轉例外（`StoreError→409`、`RetrainBlocked→409`、`FormalRefused→403`、`ForecastRefused→422`）、寫稽核。**不改既有演算法。**
3. **長任務 job 化**：決策時間線（約 18–20 秒）、檢查所有場域（約 13 秒）、重訓。既有 `CausalTimeline.progress` 與 `ui60.run_with_progress` 的進度機制直接轉成 `GET /v1/jobs/{id}`。
4. **儲存**：預設 `ephemeral`（容器本機磁碟，重啟即消失，必須明講）；若要持久化，掛載 volume（Cloud Run 可用 Cloud Storage FUSE／Filestore；單一寫入者）。**版本庫有檔案鎖與雜湊鏈，不適合多個引擎實例同時寫同一個 workspace**——部署時 `max-instances=1` 或以 workspace 做 sticky routing。
5. **多人使用**：舊系統是單一版本庫；遷移後每個使用者／分頁一個 workspace，避免互相覆蓋（Phase 6.2 的『共用同一份暫存資料』限制就此解除）。
6. **管理者**：W 端點需要 `admin`；角色由 Node 伺服器驗證（同 Phase 6.2：PBKDF2 密碼雜湊放 Secrets）。

## 5. 部署（你的決定；本次沒有做任何部署）
* 容器：`python_engine_private/Dockerfile`（Python 3.13-slim、釘死版本、非 root、唯讀檔案系統可行）。建議 1 vCPU／≥ 1 GiB、`max-instances=1`。
* **私有部署**：引擎含模型與（真實）資料，**不要**放進公開 repo、不要讓它不帶金鑰就公開。
* 沒有引擎時，網站降級為：合成展示資料＋預計算輸出，並在每頁標示『離線預計算；預測不是即時引擎產生』。

## 6. 資料與部署的邊界
* 真實資料已由使用者聲明可公開展示（見 `docs/08` §2），所以乾淨副本與預計算輸出放在 `app_repo/public/data/real_public/`，網站在**沒有引擎**時也能做完整真實資料探索，並顯示引擎事先算好的真實預測（『預計算（離線）』）。
* 引擎仍需要原始資料與模型檔，因此仍是**私有部署**（`python_engine_private/`）。放到第三方雲端時，原始檔會在該平台上；使用者聲明的範圍是『本競賽專題（含雲端網站呈現、AI Studio App 開發）』，仍請把部署位置與費用當成你的決定。
* 引擎的 API 金鑰不放進 repo；Node 伺服器與引擎以 `X-API-Key` 互相驗證。
