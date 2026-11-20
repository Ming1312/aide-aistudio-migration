# AIDE 專案說明（給 AI Studio Build Mode 的 AI 與接手的工程師讀）

## 這是什麼
**AIDE（Adaptive IoT Diagnosis & Decision Engine）智慧環境監測與決策平台**：把七個場域的感測資料放進同一條可檢查的流程——**資料進來 → 先確認資料可靠 → 再看預測與多模型比較 → 每個結論都附依據與限制 → 由人決定**。
目前正式運作的是本機／Streamlit 版（版本 1.1.0-rc3）。本 repo 是『搬到 Google AI Studio Build Mode』的**遷移包**：文件、契約、真實資料（使用者聲明可公開展示；來源：銘祥科技提供的 2026 全國 AI 專題創意競賽 AIoT 感測資料）、合成展示資料、參考實作；Python 引擎在別處（私有），以 API 提供。

## 七個場域
羊舍（`sheep_barn`；有正式 HGB 與決策引擎）、專家系統 C22 魚塭（`expert_system_c22`）、仁德三爺宮溪（`sanyegong_creek`，河川水質）、工地微氣候（`construction_site_cb13505`）、東北角（`northeast_corner`）、育成一廠（`rearing_plant_1`）、育成一廠北側（`rearing_plant_1_north`；資料太少，系統拒絕建模）。

## 名詞
* **歷史時點模擬預測**：在過去某個時間點，只用當時已有的資料預測後面幾小時；不是即時監控。
* **研究預測**：探索性、未經獨立前瞻驗證；留存測試期（Holdout）只是描述性診斷。
* **多模型比較**：六種方法並排（持續性、移動平均、24 小時季節性、線性自迴歸、HGB、XGBoost）；簡單方法常常已經夠好。
* **守門（guard）**：感測器疑似故障時，把建議改成『先處理資料』並擋下重新訓練（重訓只會把故障學進去）。
* **版本庫**：追加式、可稽核、可回復；原始資料永遠唯讀。
* **合成資料（SYNTHETIC）**：模擬的展示資料；每列帶 `__synthetic=1`。
* **候選事件**：異常偵測的輸出，需要現場確認，不是故障判定。

## 這個 repo 的內容
```
BUILD_MODE_PROMPT.md           貼給 Build Mode 的建站 Prompt（M1）
AI_STUDIO_PROJECT_BRIEF.md     本檔
docs/01…09                     功能清單、資料結構、模型依賴、API 契約、引擎 API 化方案、新舊比對與驗收、合成資料、安全政策、搬遷階段
contracts/                     openapi_engine_readonly.json（引擎唯讀 API 規格）、types.ts（全站型別）
reference/                     geminiExplain.ts（有根據的 Gemini 解釋＋核對）、adminAuth.ts（管理者解鎖）＋單元測試
public/data/real_public/       七場域完整真實資料（乾淨 CSV、欄位說明、來源與使用聲明、時間資訊）＋引擎預計算（離線）輸出
public/data/demo_synthetic/    七場域 × D1–D5 合成資料、manifest、欄位意義、注入真值（獨立檔案）
public/data/demo_precomputed/  引擎在合成資料上逐步（D1→D5）的真實輸出
.env.example                   環境變數名稱（沒有值）
```

## 目前完成度（誠實）
| 部分 | 狀態 |
|---|---|
| Python 引擎（唯讀預測／異常／品質；與舊引擎逐位元一致） | ✅ 完成並驗收（在 repo 外的私有資料夾） |
| 真實資料（使用者聲明可公開展示）、來源與使用聲明、預計算（離線）預測與異常 | ✅ |
| 合成展示資料與預計算輸出 | ✅ |
| Gemini 解釋的核對邏輯、管理者解鎖（含與 Python 雜湊相容測試） | ✅ 單元測試通過（12/12） |
| 前端與 Node 伺服器 | 🔵 待 Build Mode 依 `BUILD_MODE_PROMPT.md` 建立 |
| 版本庫／模型維護／羊舍決策等寫入類 API | 🟡 契約已定，待實作（M3–M5） |

## 必守規則（摘要；完整見 `docs/08`）
不假預測；不放金鑰與私人管理紀錄；真實與合成分開標示；**來源如實**（競賽方提供／無公開下載網址，不編網址；授權只有使用者聲明，不宣稱任何標準授權）；預設唯讀；不控制任何設備；Gemini 只解釋已算出的事實。
