# 04 API 契約（Python 引擎 ⇄ AI Studio 的 Node 伺服器）

> 狀態標記：**✅ 已實作並驗收**（`python_engine_private/main.py`；機器可讀規格 `contracts/openapi_engine_readonly.json`）／**🟡 PLANNED**（契約已定、尚未實作；對應的既有函式已列出，遷移階段 M3–M5 實作）。
> 型別：`contracts/types.ts`。

## 0. 通則

* **瀏覽器永遠不直接呼叫引擎。** 流程是 `瀏覽器 → AI Studio 的 Node 伺服器（/api/*） → Python 引擎`。引擎網址與金鑰只存在 Node 伺服器的 Secrets（`ENGINE_BASE_URL`、`ENGINE_API_KEY`）。
* 引擎驗證 `X-API-Key`（常數時間比較）；`/health` 免金鑰。沒設定 `AIDE_API_KEY` 時引擎仍可跑，但**部署時必須設定**。
* 角色：`viewer`（預設，唯讀）／`admin`。**角色由 Node 伺服器決定**（管理者密碼雜湊放 Secrets、PBKDF2-HMAC-SHA256 200k 次、5 次錯誤鎖定、沒設定時全唯讀），再以 `X-AIDE-Role: admin` 轉給引擎；引擎只信任帶有效 `X-API-Key` 的請求。W 類端點沒有 `admin` 一律 403。
* 所有回應都有 `data_kind: "real"|"synthetic"`；預測與分析回應都有 `limits[]`（限制聲明）。前端與 Gemini 必須原樣顯示或引用。
* 錯誤格式：`{"detail": "<給使用者看的具體原因>"}`；**資料不足／不適用一律用 422＋原因**，不得回傳『湊出來』的預測。
* 速率限制：預設每 IP 每分鐘 120 次（429）。

## 1. 已實作（✅ 唯讀；全部通過 `tools/p63_api_check.py`）

| 方法 路徑 | 用途 | 對應舊功能 |
|---|---|---|
| `GET /health` | 版本、七份資料雜湊、`read_only:true`、是否需金鑰 | 啟動檢查 |
| `GET /v1/datasets` | 資料集清單 | Domain Catalog |
| `GET /v1/datasets/{id}/series?columns=a,b&start&end&resample=none\|1D&max_points` | 時間序列（欄位白名單、最多 12 欄、最多 5000 點） | Sensor Analytics 圖表 |
| `GET /v1/datasets/{id}/quality` | 缺值／卡值／零值／離群候選 | 資料品質 |
| `GET /v1/datasets/{id}/anomalies?limit` | 候選異常事件（`AnomalyEvent[]`）＋免責聲明 | Anomaly Diagnosis（統計偵測） |
| `GET /v1/decision-support/{id}` | 通用決策輔助（`DecisionSupportResponse`）：證據（可追溯）→ 分層建議（一般／需人工確認／正式風險）→ 可信程度與限制；唯讀、不產生新預測或門檻 | 七場域決策輔助（見 `docs/10_DECISION_SUPPORT.md`）；羊舍的正式決策引擎保持原樣 |
| `GET /v1/forecast/tasks?dataset_id` | 預測任務清單與是否開放（含不開放原因） | AI 預測任務選單 |
| `POST /v1/forecast` `{dataset_id, sensor, horizon_h(1–6), origin?, history_hours?}` | **六種方法並排預測**（既有 HGB／XGBoost／Linear AR＋三個基準）＋各模型驗證／留存誤差＋探索性證據文字＋探索性區間＋歷史曲線＋事後實際值 | Domain Home 多模型比較、AI 預測 |
| `POST /v1/formal/sheep-thi` `{as_of?, mode: strict\|full}` | 羊舍 THI 正式 HGB：`strict` 只用『當時已存在』的凍結模型（最早凍結點之前拒絕，**不改用全資料模型**）；`full` 只供示範並警示樣本內 | AI Prediction／Risk／Historical Replay |

驗收事實（Phase 6.3）：90 個任務全部 200；API 回傳的 540 個模型預測值與直接呼叫既有 `p582_engine.forecast` **逐位元相同（差異 0）**；育成北側拒絕並說明資料不足；不合法欄位／起點／時距 422；沒有任何寫入端點；金鑰與速率限制有效；回應不含本機路徑。

## 2. 規劃中（🟡 PLANNED；寫入與狀態類）

### 2.1 工作區（workspace）
舊系統的『版本庫』是每個場域一個資料夾（`Store(stem, root)`）。API 化的做法：**一個 workspace＝一個隔離的版本庫根目錄**（從展示種子初始化；`workspace_id` 由 Node 伺服器依使用者／分頁簽發）。引擎的儲存必須在回應裡誠實標示 `storage: ephemeral|persistent`；`ephemeral` 時介面要明講『不會永久保存』。

| 方法 路徑 | 角色 | 對應既有函式 |
|---|---|---|
| `POST /v1/workspaces` `{seed: "demo"}` | admin | 展示種子初始化（`p62_cloud.bootstrap`） |
| `GET /v1/workspaces/{ws}/domains/{id}/overview` | viewer | `p586_analysis.overview／triage／alerts／quality_table`、`p60_plain.domain_status／cards` |
| `GET /v1/workspaces/{ws}/domains/{id}/home` | viewer | `p588_home.summary`（場域看板整頁內容） |

### 2.2 資料更新與版本（W）
| 方法 路徑 | 角色 | 對應既有函式 | 重點 |
|---|---|---|---|
| `GET …/versions` | viewer | `Store.versions／current_seq` | |
| `POST …/imports:stage`（multipart：file／或 `{demo_batch:"D2"}`＋`source`＋`license_note`＋`policy`） | admin | `Store.stage` | 回 `upload_id`＋驗證報告＋合併預覽；PII 掃描；**BLOCK 不改 current** |
| `POST …/imports/{upload_id}:commit` `{approved_by, notes}` | admin | `Store.commit` | 兩步驟原子提交 |
| `POST …/versions:rollback` `{to_seq, by, reason}` | admin | `Store.rollback` | 不刪任何版本 |
| `GET …/audit`、`GET …/verify` | viewer | `Store.audit／verify` | 雜湊鏈完整性 |

### 2.3 預測紀錄（W）
`POST …/forecasts:compare`（`p586_forecast.compare_all`，含適用性）、`POST …/ledger/predictions`（`Ledger.record`）、`POST …/ledger:reconcile`（`Ledger.reconcile`）、`GET …/ledger/performance`（`Ledger.performance`）。

### 2.4 模型維護（W）
| 方法 路徑 | 角色 | 對應既有函式 |
|---|---|---|
| `GET …/models/{task}/monitor` | viewer | `p59_guard.guarded_monitor`（外包 `p589_monitor.monitor`） |
| `POST …/models/{task}/retrain` `{by, override_reason?}` | admin | `p59_guard.guarded_retrain`（疑似感測器故障時 409，除非填『確認原因』≥ 8 字） |
| `GET …/models/{task}/versions`、`…/compare/{v}` | viewer | `Registry.version_ids／compare_of` |
| `POST …/models/{task}:promote` `{version, by, reason, mode:"experimental"}` | admin | `Registry.promote`（`formal` 一律 403＋`formal_gate` 原因） |
| `POST …/models/{task}:rollback` `{to_version, by, reason}` | admin | `Registry.rollback` |

### 2.5 羊舍決策與審查（W）
`POST /v1/sheep/decision` `{as_of, mode}`（`decision_engine`；長任務→回 `job_id`，`GET /v1/jobs/{id}` 回 `{progress, elapsed_s, eta_s}`）、`POST /v1/sheep/decisions/{id}/human`（`ActionLogger.record_human_decision`；`verified_real_action` 一律 422）、`GET/POST /v1/review/issues`、`PATCH /v1/review/issues/{id}/status`、`GET /v1/review/export`、`POST /v1/review/import`（`ReviewStore`）。

### 2.6 資料探索（R）
`POST /v1/analytics/{task}`（`p55_analysis.run_task`：概況、品質、描述統計、趨勢、分布、日週期、相關、分段位移、缺口／零值／Flatline、離群候選、可預測性）；研究證據表（Phase 5.6／5.7）是**靜態唯讀結果**，打包成 JSON 由前端讀取即可（不需要引擎）。

## 3. 規劃端點的共同規則
1. 任何 W 端點：先驗 `X-API-Key`＋`X-AIDE-Role: admin`；每次寫入都產生稽核紀錄（誰、何時、為何）。
2. 回應一律帶 `data_version`（版本庫版本 ID）與 `contains_synthetic`；含合成列的結果標『流程示範，不是模型驗證』。
3. 長任務（>3 秒）走 job：`202 {job_id}` → 輪詢 `GET /v1/jobs/{id}`（真實進度，不是假的轉圈）。
4. 引擎重啟後 `ephemeral` workspace 會消失——這是**要被明講**的限制，不是 bug。
5. 契約變更要 bump `API_VERSION`，Node 伺服器啟動時比對 `/health` 的版本與資料雜湊，不符就降級並告警。

## 4. Node 伺服器（AI Studio 內）對前端的端點（建議）
`GET /api/datasets`、`GET /api/series`、`POST /api/forecast`、`POST /api/formal/sheep-thi`、`GET /api/anomalies`（以上＝代理引擎；引擎離線時回『預計算（離線）』並標示）、`POST /api/ai/explain`（Gemini；見 `docs/08` 與 `reference/geminiExplain.ts`）、`GET /api/decision/:datasetId`（代理 `GET /v1/decision-support/{id}`；引擎離線時回 `precomputed/decision_support.json` 並標示『預計算（離線）』）、`POST /api/decision/explain`（Gemini 白話改寫；見 `docs/10` 與 `reference/decisionExplain.ts`）、`POST /api/admin/login`（管理者解鎖）。
