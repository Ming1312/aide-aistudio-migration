# Phase 6.8 遠端整合驗收報告（AI Studio → Node → Cloudflare Quick Tunnel → Caddy → Python 引擎）

驗收日期：2026-11-25（本機時間 22:47 開 Tunnel，約 00:44 關閉）
結論：**遠端整合 PASS（含 2 項已記錄的 App 缺陷與 1 項未能實測項目）**
成本：新增費用 0（無信用卡、無付費資源、無付費 API；Gemini 為 AI Studio Free Tier，驗收期間未呼叫任何 AI 解釋端點）

## 1. 開 Tunnel 前的安全再驗證（start_tunnel.sh，由使用者親自輸入確認句）
| 項目 | 結果 |
|---|---|
| 寫入端點 sim/tick、ingest、commit、rollback、recompute | 全部 403（PASS；關 Tunnel 後本機再測仍全 403） |
| 引擎 8080 | 未發佈到主機（PASS） |
| Caddy | 只綁 127.0.0.1:8088（PASS；`ss` 只看到 127.0.0.1:8088） |
| 無金鑰／錯誤金鑰 | 401（本機與公開側皆 PASS） |
| 公開側 `/docs`、`/` | 404；只轉送 /health 與 /v1/*（PASS） |

## 2. 資料流（PASS）
- App `/api/health`：`engine_connected:true`、`live_engine_connected:true`、`read_only:true`、`live_writes_enabled:false`、`live_sim_enabled:false`。
- 引擎日誌可見來自 Caddy 的 App 請求（`/v1/datasets`、`/v1/live/*`、`/v1/decision-support/*`、`/v1/datasets/*/anomalies`、`/v1/forecast`）。
- 七場域 × 異常分析／決策輔助：`source` 皆為 `engine`（14/14）；即時狀態、版本清單皆 200。

## 3. 七場域瀏覽器實測（PASS）
| 場域 | 即時預測 | 異常 | 決策輔助 | 合成標示 |
|---|---|---|---|---|
| sheep_barn | 15 組預測、版本 v0013→v0014 | engine | engine | 有橫幅與 source: synthetic |
| expert_system_c22 | 15 組 | engine | engine | 有 |
| sanyegong_creek | 15 組 | engine | engine | 有 |
| construction_site_cb13505 | 15 組 | engine | engine | 有 |
| northeast_corner | 15 組 | engine | engine | 有 |
| rearing_plant_1 | 15 組 | engine | engine | 有 |
| rearing_plant_1_north | 依政策「此場域不提供預測」（資料不足），不顯示圖表與數值 | engine | engine | 有 |
- 決策輔助頁標示「引擎即時」與產生時間；候選異常皆標「候選事件，不是故障判定」。
- 真實資料總覽（871～2881 列等）仍由真實資料頁顯示，與合成流分離。

## 4. 自動更新（PASS）
排程推進（每 900 秒、1 模擬小時）於 00:42:47 把各場域推進到第 14 版；App 在未手動重新整理下，30 秒輪詢內由 `羊舍-v0013` 更新為 `羊舍-v0014`，資料終點 03:00 → 04:00。

## 5. Tunnel 停止後（PASS）
- 舊網址回 530，cloudflared 程序已結束。
- `/api/health`：`engine_connected:false`，訊息「Python 引擎健康檢查失敗，已切換為離線預計算模式」。
- 決策輔助 `source: precomputed`、異常 `precomputed_offline`；即時預測頁保留上次畫面並顯示「自動更新失敗（保留上次畫面）：尚未連線到 Python 引擎」，沒有拿預計算檔冒充即時預測。
- 本機版本庫保留：各場域 14 版、共 98 版（開 Tunnel 前 84 版）。

## 6. 發現的問題
| 編號 | 嚴重度 | 內容 | 狀態 |
|---|---|---|---|
| F12 | 低 | 唯讀部署下，管理者按寫入會看到 502「引擎憑證設定有誤」，真因是引擎停用寫入（403 body：管理金鑰未設定）。檢視者看不到任何寫入按鈕，只有管理者會碰到。 | **未能實測**（需管理者密碼，我不輸入也不索取）；已提供最小修正 `f12_readonly_message.patch`，尚未套用 |
| F13（新，**已修正並驗證**） | 中 | 「資料更新」頁在**育成一廠北側**必然出現「此頁發生錯誤」。主控台：`DataUpdatePage.tsx:585 Cannot read properties of undefined (reading 'recommendation')`（`currentStepOutput.guard` 為 undefined，該場域沒有模型所以沒有 guard）。其餘 6 場域正常。與 Tunnel／引擎無關，資料來自 App 內建的步驟輸出檔。錯誤邊界有接住，其他頁面不受影響。 | 2026-11-25 已修：`guard`／`forecast`／`retrain_allowed` 改為可選欄位（`src/types/app.ts`）；`buildSyntheticStepFacts` 與資料更新頁在沒有 guard 時改顯示「此場域不建立預測模型，沒有守門建議」。驗證：本機型別檢查前後對照（只改型別時會報 4 個錯，加上修正後 0 個新錯）、新增單元測試 2 項通過；AI Studio 的 Gemini 回報 `tsc --noEmit` 與 `npm run build` 通過；真實 App 七場域資料更新頁全部正常（育成北側顯示說明區塊，其餘六場域守門建議畫面不變）。修正內容見 `f13_data_update_guard.patch`（含新增測試，AI Studio 內尚未加入該測試檔）。**尚未同步到 GitHub**（Sync to GitHub 未按；GitHub 與本機 zip 仍是舊版） |
| 觀察 | 資訊 | 引擎離線時，直接 fetch `/api/live/<場域>/status` 得到 200 的 HTML（疑為平台代理對 503 的處理），但 UI 仍正確顯示離線訊息。原因未深究。 | 記錄 |

## 7. 未驗證項目
管理者登入後的寫入流程（F12）、其他裝置經區網連線、重新開機後自動重啟、Tunnel 4 小時自動關閉的實際行為、`copy_key.py` 在本次沒有用到（金鑰由使用者自行貼入 Secrets）。

## 8. 收尾與建議
0. **2026-11-25 已執行收尾**：`./stop_demo.sh` 已停止並移除容器（`live_store`、備份、映像、模型保留），舊金鑰檔 `demo.env` 已刪除；下次 `./start_local.sh` 會產生新金鑰。AI Studio Secrets 裡的舊 `ENGINE_API_KEY` 已無對應引擎，下次重開時要更新。
1. （已完成，見上）Tunnel 已關閉；本機容器已停止。
2. **換掉 demo 金鑰**（已完成前半；後半待下次重開）：Quick Tunnel 由 Cloudflare 終止 TLS，看得到 X-API-Key。流程：`./stop_demo.sh` → 刪除 `~/aide-demo/state/demo.env` → `./start_local.sh` 產生新金鑰 → 下次開 Tunnel 後更新 AI Studio 的 `ENGINE_BASE_URL` 與 `ENGINE_API_KEY`。
3. 建議 `gh auth logout`，並視需要把自己移出 docker 群組。
4. AI Studio Secrets 裡其他項目（`ENGINE_ADMIN_KEY`、`ADMIN_PASSPHRASE…`、`GEMINI_MODEL`）可能仍是範例文字；因引擎沒有管理金鑰，不影響本次結果。
