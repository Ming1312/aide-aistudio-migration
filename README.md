# AIDE → Google AI Studio 遷移包（app_repo）

這個資料夾可以推到你的 GitHub repo，再用 AI Studio Build Mode 的 **Import from GitHub** 匯入。
裡面有七場域**真實資料**（使用者聲明可公開展示；來源與使用聲明見 `public/data/real_public/DATA_USE_STATEMENT.md`）與**合成**展示資料，兩者分開標示；**沒有** API Key、憑證、私人管理紀錄或原始 UTF-16 檔（`tools/p63_verify_package.py` 會檢查）。
**注意**：推到公開 repo 就等於公開這批資料——請依你對授權範圍的判斷決定 repo 是否公開（建議先用私有）。

1. 先讀 `AI_STUDIO_PROJECT_BRIEF.md`，再讀 `docs/01…10`（`docs/10_DECISION_SUPPORT.md`＝七場域通用決策輔助）。
2. 把 `BUILD_MODE_PROMPT.md` 的『Prompt 本文』貼進 Build Mode（M1）；M1 完成並驗收後，再貼 `BUILD_MODE_PROMPT_M2_DECISION.md` 的『Prompt 本文』（M2：七場域決策輔助）。
3. 在 Settings → Secrets 設定（見 `.env.example`）。Python 引擎在 `../python_engine_private/`（私有部署，不要放進這個 repo）。

測試參考實作：`node --experimental-strip-types --test reference/adminAuth.test.ts reference/geminiExplain.test.ts reference/decisionExplain.test.ts`（Node ≥ 22.6）。
