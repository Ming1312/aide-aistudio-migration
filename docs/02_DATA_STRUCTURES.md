# 02 資料結構（遷移時必須保持的格式與不變式）

## 1. 感測資料：每小時寬表

| 欄位 | 型別 | 說明 |
|---|---|---|
| `timestamp` | `YYYY-MM-DD HH:MM:SS` | 每小時一列；**未標示時區**（本地時間，尚未向資料提供者確認；`timestamp_status = naive_local_hourly_unconfirmed`） |
| `<感測器名稱>` … | number／空白 | 一個感測器一欄；空白＝沒有讀值（**不插補、不平滑、不刪列**） |
| `__synthetic` | `1` | 只出現在合成展示資料；**每一列都帶**，合成旗標不能被資料處理流程丟掉 |

* 原始企業匯出檔是 UTF-16／Tab、表頭帶場域前綴（例如 `<前綴> - pH`）、時間拆成『日期＋小時』。遷移包裡的展示資料已轉成乾淨 UTF-8、去前綴、單一 `timestamp`；轉換工具 `tools/p63_build_demo_synthetic.py`（專案內）。
* 欄位意義（`catalog_demo.json`）：`key`（欄名）、`unit`、`unit_status`（`UNVERIFIED_INFERRED_HIGH|MEDIUM|LOW`，**單位是推測的**）、`category`、`sensor_type`、`measurement_kind`（`continuous|state_code|…`）。

## 2. 合成展示資料（`public/data/demo_synthetic/`）

```
manifest.json            # 七場域 × 五個批次（D1…D5）：file、rows、start、end、sha256、pre_imported、truth_events、故事摘要
catalog_demo.json        # 欄位意義（沒有任何真實統計數字）
<domain_id>/D1.csv … D5.csv
truth/<domain_id>_D<n>.truth.json   # 注入的情境真值；只供對照驗收，不得餵給偵測器或模型
```
* D1 日常正常（預先匯入）→ D2 環境改變（熱浪／暴雨；**不是**故障）→ D3 感測器開始漂移 → D4 漂移持續 → D5 卡值＋斷線。每週 168 小時（D5 為 160）。
* 同一個固定種子；同一組參數永遠逐位元相同。

## 2b. 真實資料（`public/data/real_public/`；使用者聲明可公開展示）

```
<domain_id>.csv         # timestamp, <感測器欄…>, __real=1；乾淨 UTF-8；與原始檔逐格相同（不插補、不平滑、不刪列）
catalog_real.json       # RealCatalog：欄位說明（原始表頭、單位與可信度、分類、物理範圍、統計、缺值）、時間資訊、可預測任務
PROVENANCE.json         # Provenance：使用者聲明、來源（無網址）、授權（無標準授權）、已確認／尚未提供、剩餘項目、原檔 sha256、個資自動掃描
DATA_USE_STATEMENT.md   # 給人看的來源與使用聲明
DATA_DICTIONARY.csv     # 124 個欄位的說明總表
precomputed/forecasts.json | anomalies.json | formal_sheep.json   # 引擎的真實輸出（預計算、離線；非即時）
```
* 時間戳記未標示時區；單位是推測的（`unit_status`）；累積計數器（電度、運轉時間…）只能遞增，零值是否正常依感測器意義而定（`zero_semantics`）。
* 真實檔只有 `__real`，合成檔只有 `__synthetic`；兩種旗標不會同時出現。

## 3. 資料版本庫（追加式、可稽核、可復原；`p586_store.Store`）

```
<root>/<場域>/
  manifest.json      # {base_raw_sha16, stem, store_version, versions:[{seq, version_id, batch_id, approved_by, canonical_rows, canonical_sha256, entry_hash, prev_hash, license_note, notes, created_at, filename}]}
  current.json       # {"seq": N}  ← 『目前資料』指標
  audit.jsonl        # 每行 {action: stage|commit|rollback|recover, detail, t, prev, hash}  雜湊鏈
  versions/vNNNN/    # canonical.csv, delta.csv, validation_report.json
  quarantine/        # stage 後尚未核准的上傳
  lock               # 檔案鎖
```
不變式（遷移後必須全部成立，驗收項目 V-01…V-08）：
1. 原始資料永遠唯讀；『目前資料』＝原始資料＋版本庫第 `current.seq` 版的追加列。
2. 匯入＝ stage（隔離＋驗證＋合併預覽）→ commit（核准後才寫入）；任何 BLOCK／失敗都不改變 current。
3. 版本只增不減；回復＝把 current 指回舊版本並寫稽核，**不刪任何版本**。
4. 提交是原子的（暫存→改名→manifest 追加＝提交點→current 指標）；中途當機由 `recover()` 前滾／回滾，不留半個版本。
5. manifest 與稽核日誌各自有雜湊鏈；`verify()` 抓得到竄改；載入時 fail closed。
6. 每一列記錄來源：`_source`（`synthetic|unverified_import`）、`_batch_id`、`_version`。
7. 版本庫模組**不讀、不引用**情境真值（`tests/test_phase586_isolation.py` 以 AST 強制）。

## 4. 預測紀錄（`p588_ledger.Ledger`；追加式、雜湊鏈）

`predictions.jsonl` 每筆：`id, recorded_at, task_id, domain, sensor, horizon_h, origin, target_time, mode(forward|backtest), data_version, data_seq, predictions{<model>: {value}|{refused}}, applicability{status, reasons[{category, level, text}]}, artifact_sha256, model_version, contains_synthetic, last_observation[time, value]`。
`outcomes.jsonl`：真值出現後的比對（實際值、各模型誤差、真值所在資料版本；真值被更正時**追加 revision**，不改舊紀錄）。
規則：同一 `(任務, 起點, 資料版本, 模型版本)` 只存一次；效能追蹤只用 `forward`；樣本 < 30 不排名；含合成資料一律標『不是驗證證據』。

## 5. 模型版本管理（`p589_registry.Registry`；每個版本庫、每個任務各自一份）

```
<root>/<場域>/models/<task>/vNNNN/{model.joblib, meta.json(不可變)}
<root>/<場域>/models/<task>/active.json     # 目前啟用的版本（v0＝研究 artifact，唯讀引用）
<root>/<場域>/registry.jsonl                # 事件：train|compare|promote|rollback|reject（雜湊鏈）
```
啟用模式：`experimental`（只影響這個版本庫的新資料預測；含合成列只能是這種）／`formal`（**一律被 `formal_gate` 擋**）。

## 6. 預測回應（引擎輸出；契約見 `docs/04`）

`ForecastResponse`：`data_kind, mode("歷史時點模擬預測"), dataset_id, task_id, sensor, horizon_h, unit, unit_status, forecast_origin, target_timestamp, last_observation_*, actual_at_target, period(train|validation|holdout|latest), best_baseline, models{persistence, moving_average, seasonal_naive_24h, linear_ar4, HGB, XGB → {label, kind, value|refused, version, variant, validation{n,MAE,RMSE}, holdout{…}, evidence?, interval?}}, history[], future_actual[], research_status, artifact_sha256, limits[], no_claim`。
* 任何模型都可能 `refused`（原因字串）：**不插補、不借用其他模型**。
* `interval`（HGB／XGB）：探索性 split-conformal 90% 區間（`interval-v2`）；`shown` 只由『校正資料足夠且起點在校正資料之後』決定，Holdout 覆蓋率只是描述性診斷。

## 7. 異常事件

`AnomalyEvent`：`detector(threshold|resid_z|relation|stuck|quality), kind, column, start, end, detected_at, score, note` ＋ `kind_zh, hours`。輸出是『候選事件』，**不是故障判定**。

## 8. 其他紀錄
* 決策紀錄（`ActionLogger`）：`record_type`（`ai_recommendation|human_simulation|observed_historical_data|verified_real_action`）；回放模式下 `verified_real_action` 一律被拒；`is_simulated=True`；`action_time_semantics=replay_clock_simulated`。
* 審查問題（`ReviewStore`）：`issue_id(ISS-YYYYMMDD-NNNN)`、`reviewer_alias`、`issue_category(data|analysis_result|model_status|event|recommendation|traceability|usability|performance|documentation|other)`、`severity(low|medium|high|blocker)`、`status(Open|Investigating|Fixed|Verified|Won't Fix)`；狀態機有限制；Won't Fix 必須附理由。
