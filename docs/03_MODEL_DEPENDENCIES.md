# 03 模型與執行環境依賴（為什麼模型不能搬進瀏覽器，也不能用假預測取代）

## 1. 模型清單

| 類別 | 內容 | 檔案（在 `python_engine_private/`） | 數量 |
|---|---|---|---|
| **研究預測模型**（Phase 5.8.2，凍結配方 `p582-recipe-v1`、協定雜湊 `c369471038d0ca64`） | 每個『場域×感測器×時距(1/3/6h)』：HGB（HistGradientBoosting）、XGBoost、Linear AR（Ridge）＋四個基準（持續性、移動平均、24h 季節性、線性）；特徵集 F0（自身）／F1（含交叉感測器）由驗證期 MAE 決定 | `outputs/phase5_8_2/artifacts/*.joblib`＋`manifest.json`（每個檔案有 sha256；載入前驗證） | 90 個任務 |
| **羊舍正式模型**（Phase 2.5／2.6／3） | 成羊區 THI 3 小時後：HGB 分位數（點預測＋90% 區間、CQR 校正）、超標機率 P(THI(t+3) ≥ T)、視窗風險附加頭；7 個『嚴格回測凍結模型』（`strict_until_YYYYMMDD`）＋ 1 個全資料模型（只供示範，樣本內） | `models/phase25/*.joblib`、`models/phase26/*.joblib`、`models/phase3/model_registry.json`（sha256） | 8 組 |
| **專家系統偵測器**（Phase 5.2，Experimental） | DO 通道的 robust-z／rule-based 偵測器；需使用者勾選同意才啟用；Compatibility Gate 會拒絕未同意的請求 | `models/phase52/*.json` | 6 個 |
| **統計異常偵測**（Phase 5.8.6／5.8.7，無模型檔） | threshold／resid_z／relation(CUSUM)／stuck／quality 偵測器；每個感測器個別校準；『被其他感測器解釋的環境變化』不算故障 | 程式（`src/p586_anomaly.py`、`p587_*.py`） | 5 種 |
| **重新訓練產生的候選模型** | 用更新資料、同一配方重新擬合；存在版本庫 `models/<task>/vNNNN/` | 執行時產生 | — |

## 2. 為什麼必須是 Python 引擎

* `.joblib` 是 Python pickle，內含 scikit-learn 1.9.1 與 xgboost 3.4.1 的物件；**只能在相同的 Python 3.13＋套件版本執行**。瀏覽器／Node 不能載入。
* 特徵由截斷到預測起點的資料『現算』（`p56_core.own_features/cross_features`），因果性（不讀未來）是核心保證；用 JS 重寫既有特徵與模型＝等於換了一個模型，必須重做全部驗證。
* **不可用假預測取代原本模型**：前端不得內建任何『看起來像預測』的函式（例如用線性外推、隨機數或把持續性當 HGB）。離線備援只能是**引擎事先算好的真實輸出**，而且必須標示『預計算（離線）』與產生時間。

## 3. 執行環境（釘死版本；模型檔依賴同一組）

```
Python 3.13
pandas==3.0.5  numpy==2.5.3  scipy==1.18.1  scikit-learn==1.9.1  joblib==1.6.0  xgboost-cpu==3.4.1  PyYAML==6.0.3  openpyxl==3.1.5
fastapi  uvicorn  httpx        # API 層（遷移新增；不影響模型）
```
* 載入時有環境檢查：artifact 的 meta 記錄訓練時的版本；資料雜湊（`data_sha256_16`）不符就**拒絕使用舊模型**。
* 記憶體：引擎尖峰約 0.6 GB（Phase 6.2 量測 556 MB）；建議容器 ≥ 1 GB；第一次載入羊舍決策時間線約 18–20 秒（需預先載入或進度條）。
* CPU 即可；不需要 GPU。`OMP_NUM_THREADS=2`。

## 4. 凍結與不可改的東西（遷移時不得重新實作或調參）
* 協定與切分、特徵、固定超參數；`MIN_GAIN=0.05`；證據標籤規則 `evidence-label-v2`（EXPLORATORY_SIGNAL：驗證期相對最佳基準改善 ≥ 5% 且時間交叉驗證勝 ≥ 2/3 折；Holdout 不參與標籤）；區間協定 `interval-v2`。
* 守門 `p59_guard`（疑似感測器故障時把建議改成『先處理資料』，擋下重訓）。
* Phase 5.2 Holdout digest `bc245dbda50b60c9`；羊舍 543 筆回放 `real_decision_diff: 0`。這兩項是遷移後『引擎沒被改壞』的回歸基準（見 `docs/06`）。

## 5. 模型限制（介面與 Gemini 解釋都必須帶著）
* 所有預測是**研究預測（探索性、未經獨立前瞻驗證）**；Holdout 不是盲測；同時比較 180 個『任務×模型』，部分訊號可能是偶然。
* 預測模式是『歷史時點模擬預測』，**不是即時監控**，不控制任何設備。
* 單位是推測的；84 是羊舍 THI 的候選警戒值，不是資料提供者確認的標準。
* 在合成資料上跑出的誤差只是『流程穩定性檢查』，**不是**模型表現的證據。
