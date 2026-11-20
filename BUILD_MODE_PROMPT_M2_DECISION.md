# M2：七場域通用「決策輔助」（貼給 Build Mode 的追加 Prompt）

> 使用時機：M1（`BUILD_MODE_PROMPT.md`）已完成並驗收之後。把下方「Prompt 本文」整段貼進 Build Mode。需要先把 repo 重新同步到最新的 `main`（本 Prompt 依賴新增的 `docs/10_DECISION_SUPPORT.md`、`contracts/types.ts`、`reference/decisionExplain.ts`、`public/data/real_public/precomputed/decision_support.json`）。

## Prompt 本文

請在現有 App 上新增「決策輔助」功能，涵蓋全部七個場域。**先完整閱讀**：`docs/10_DECISION_SUPPORT.md`、`contracts/types.ts`（DecisionSupportResponse 等型別）、`reference/decisionExplain.ts` 與其測試、`public/data/real_public/precomputed/decision_support.json`。不要重新發明這些文件已經定義的東西，也不要改動 `public/data/` 底下的任何檔案。

### 硬規則（違反任何一條就是錯誤）
1. **前端不產生任何建議、數字、門檻或預測。** 所有內容只來自 `GET /api/decision/:datasetId` 的回應（引擎線上時代理 `GET /v1/decision-support/{id}`；引擎離線或沒設定時讀 `public/data/real_public/precomputed/decision_support.json`，並標示『預計算（離線）』與 `generated_at`）。
2. **三層分開呈現，不能混在同一個清單或同一種樣式：** 一般建議（`general`）、需要人工確認的異常（`needs_human_review`）、正式風險決策（`formal_risk`）。`formal_risk` 只會出現在羊舍；其他場域的頁面不得出現這個區塊，也不得出現『正式風險決策』字樣。
3. **每一項建議都要顯示**：可信程度（等級＋依據＋上限原因）、限制、適用條件（`applicability`），並可展開看證據（證據編號、來源檔案與指標、含數字的說明）。可信程度旁邊要有一句話說明它的意思：「對『資料中確實出現此現象』的把握，不是對設備是否故障或原因的把握」（取自 `policy.confidence_meaning`）。
4. **『需要人工確認』每一項都要寫『候選事件，不是故障判定』**；不得出現『故障』『損壞』『需要更換』的結論，不得出現自動控制或設備操作的按鈕或文字。
5. **資料不足的場域**（`capability.forecast.status = not_available`，目前是育成一廠北側）：顯示『此場域不提供預測』與 `capability.forecast.reason`，只呈現資料檢查與異常確認建議；沒有任何預測值、預測圖或預測按鈕。
6. **羊舍的正式輸出**必須顯示『門檻 84 為候選值，未經資料提供者確認』與『系統不控制任何設備』，並顯示 `validated_policy: false` 的白話說法（『目前沒有經驗證的政策』）。
7. **資料來源與授權**只能寫「競賽方提供／無公開下載網址」與「使用者確認可用於本競賽專題（完整資料展示、雲端網站呈現、資料分析、機器學習預測、Google AI Studio App 開發）；無外部證明文件」。全站不得有網址，也不得出現 CC BY、CC0、Creative Commons、標準開放授權、授權證明等字樣（否定句也不行）。
8. 金鑰與雜湊只在 Node 伺服器端；前端與網路請求不得出現任何金鑰。瀏覽器只呼叫同源 `/api/*`。

### 後端（`server/routes.ts`）
* `GET /api/decision/:datasetId`：datasetId 必須是七個場域之一，否則 404。引擎可用時代理引擎（加 `X-API-Key`，10 秒逾時，逾時或失敗就退回離線檔，回應加 `source: "engine" | "precomputed"`）。
* `POST /api/decision/explain`，本文 `{ dataset_id, question? }`（**不要接受前端傳來的建議或事實**，伺服器自己取得該場域的決策輔助回應）：
  * 用 `reference/decisionExplain.ts` 的 `explainDecision`（`@google/genai`，模型名稱讀 `GEMINI_MODEL`）；沒有金鑰、逾時或失敗時用 `ruleBasedExplain`，並讓畫面明講『不是 AI 改寫』。
  * 速率限制：每個來源 IP 每分鐘最多 10 次，另加全站每分鐘 60 次；超過回 429 `{"detail":"請求過於頻繁，請稍後再試"}`。**來源 IP 用 `app.set("trust proxy", 1)` 後的 `req.ip`，不要信任 `X-Forwarded-For` 的第一個值（訪客可偽造）。** 問題文字最多 300 字。
  * 回應用 `DecisionExplainResponse`；每項要帶 `plain_text_source`（`gemini` 或 `rule_based`）。
* 不得記錄或回傳 `ENGINE_BASE_URL`、`ENGINE_API_KEY`、`GEMINI_API_KEY`、`ADMIN_PASSPHRASE_HASH` 的值。

### 前端
* 導覽加入「決策輔助」（日常使用層），預設顯示目前選取的場域；七場域都可切換。頁首固定顯示：資料種類（真實）、來源標示、『預計算（離線）』或『引擎即時』、產生時間。
* 頁面結構：
  1. **能力卡**：資料檢查／異常確認／預測／正式風險決策四項各自『可用』或『不可用＋原因』。
  2. **需要人工確認的異常**（醒目的黃色區塊）：每項標題、時間範圍、可信程度徽章、『候選，不是故障判定』、行動（只能是檢查／確認／複測／通知），可展開證據。
  3. **一般建議**（中性樣式）：資料檢查、模型適用性（例如『目前沒有證據顯示機器學習模型比簡單基準好，建議以簡單基準對照』）、監測。
  4. **正式風險決策**（只有羊舍；獨立的藍色區塊）。
  5. **「用白話解釋」按鈕**：呼叫 `/api/decision/explain`，在每項建議下顯示白話文字與來源徽章（『Gemini 改寫』或『規則層原文』）；`guard.ok = false` 時顯示『部分項目已改回規則層原文』與原因。
* 手機寬度（約 390px）可操作。

### 測試（請實際執行並回報結果）
* `node --experimental-strip-types --test reference/decisionExplain.test.ts` 全數通過（不得修改這個測試或 `reference/` 的邏輯）。
* 為 `GET /api/decision/:datasetId` 與 `POST /api/decision/explain` 寫路由測試：404、429、本文過大 400、沒有金鑰時退回規則層原文、`X-Forwarded-For` 偽造不能繞過限制。
* `tsc --noEmit` 零錯誤。

### 完成後請逐項回報（是／否＋證據）
1. 七場域都有『決策輔助』頁嗎？`formal_risk` 區塊只在羊舍出現嗎？
2. 每項建議都顯示可信程度（含依據）、限制、適用條件，並可展開證據嗎？
3. 『需要人工確認』每一項都標『候選、不是故障判定』嗎？有沒有任何『故障／需要更換』字樣？
4. 育成一廠北側有沒有任何預測值、預測圖或預測按鈕？（應為沒有）
5. 羊舍頁有沒有顯示『門檻 84 為候選值，未經確認』與『沒有經驗證的政策』？
6. 每段白話文字都標示『Gemini 改寫』或『規則層原文』嗎？Gemini 失敗時整頁明講不是 AI 改寫嗎？
7. 全站有沒有網址、CC BY／CC0／標準開放授權／授權證明字樣？（應為沒有）
8. 前端原始碼與瀏覽器網路請求有沒有任何金鑰？
9. 速率限制是否用 `req.ip`，偽造 `X-Forwarded-For` 能否繞過？
10. 前端有沒有自己產生任何建議、數字、門檻或預測？（應為沒有）
