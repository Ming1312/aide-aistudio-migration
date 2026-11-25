# 02　系統架構與資料流

> 本文件描述 **v1.1.0 實際存在並驗證過的架構**，沒有描述尚未建置的部分。未驗證項目見 [06 最終驗收報告](06_FINAL_ACCEPTANCE_REPORT.md)。

## 1　三個層次

| 層 | 內容 | 在哪裡執行 | 本 repo 位置 |
|---|---|---|---|
| **研究層**（原始研究專案） | 資料稽核、羊舍 THI 預測、風險感知框架、決策引擎、異常偵測、資料更新與模型維護、Streamlit 內部平台 | 本機（`handoff_extracted/`） | **不在本 repo**；沒有被修改，原始研究結果與模型凍結 |
| **引擎層**（Python 唯讀 API） | 從研究層取出、以 FastAPI 提供的預測／異常／決策輔助／即時資料流；Docker＋Caddy 部署 | 使用者電腦上的 Docker（`demo_kit/`），私有 | `engine/`（文字原始碼）、`ci/inputs/aide-engine-…tar.gz`（含模型與資料的完整封包） |
| **展示層**（AI Studio App） | React 前端＋Express/Node 伺服器；Node 代理引擎、保管 Secrets、呼叫 Gemini（選用） | Google AI Studio（Build Mode）或本機 `npm run dev` | 專案根目錄（`src/`、`server/`、`server.ts`） |

## 2　資料流

```
                        （研究層：不連線，只提供模型與資料給引擎封包）
                                         │ 打包（SHA-256 固定）
                                         ▼
 瀏覽器 ──HTTPS──▶ AI Studio App（Node） ──HTTPS＋X-API-Key──▶ Cloudflare Quick Tunnel ──▶ Caddy ──▶ Python 引擎
  (React)          │  /api/health                              （臨時公開網址，           127.0.0.1:8088   (容器內 8080，
                   │  /api/datasets、/api/forecast             只在展示時段開）            只轉送           不發佈)
                   │  /api/decision/:id                                                   /health、/v1/*
                   │  /api/live/*                                                           │
                   │  /api/ai/explain（Gemini，選用）                                       ▼
                   ▼                                                              /var/lib/aide/live_store
           引擎離線時：預計算結果（public/data/…/precomputed）                      （版本庫，bind mount，持久）
```

要點：

1. **瀏覽器永遠只呼叫同源的 `/api/*`**。引擎網址、`ENGINE_API_KEY`、管理者密碼雜湊都只在 Node 伺服器端，不會出現在前端程式或網路請求中。
2. **引擎預設唯讀**：沒有設定 `AIDE_ADMIN_KEY` 與 `AIDE_ALLOW_SIM`，匯入／提交／回復／重算／模擬推進五個寫入端點一律 403。
3. **Caddy 只綁 `127.0.0.1:8088`，引擎 8080 不發佈到主機**；Caddy 只轉送 `/health` 與 `/v1/*`，`/docs` 與 `/` 回 404。
4. **離線降級而不是假預測**：引擎連不上時
   - 決策輔助改用預計算結果並標示 `precomputed`；
   - 異常分析標示 `precomputed_offline`；
   - 即時預測頁保留上次畫面並說明「自動更新失敗」，**不會拿預計算檔冒充即時預測**。
5. **真實資料與合成資料分開**：真實資料（`public/data/real_public/`，每列 `__real=1`，與原始檔逐格相同）只用於探索與分析；合成資料（`demo_synthetic/`、引擎內建資料流，帶 `synthetic` 標記）只用於示範流程。兩者在介面上永遠分開標示。

## 3　App 的頁面與資料來源

| 頁面 | 資料來源 | 引擎離線時 |
|---|---|---|
| 總覽、資料探索與分析、資料來源與使用聲明 | 真實資料 CSV（隨 App 一起發佈） | 照常運作 |
| 場域看板 | 真實資料＋引擎預測 | 預測改為預計算／不可用並標示 |
| **即時預測** | 引擎 `/v1/live/*`（合成資料流上的預測、監測、版本） | 保留上次畫面＋說明；不顯示預計算冒充 |
| **決策輔助**（七場域） | 引擎 `/v1/decision-support/{id}`；Gemini 只改寫白話 | 預計算（標示） |
| **資料更新**（合成展示 D1～D5） | 隨 App 發佈的預計算步驟輸出（`step_outputs.json`，原研究平台在合成批次上的真實輸出） | 照常運作 |
| 模型維護 | 說明頁；寫入按鈕停用 | 同左 |
| 羊舍決策（風險評估、處置決策、異常診斷、AI 預測、歷史回放） | 羊舍正式決策引擎的輸出（原樣引用） | 預計算 |

## 4　引擎的主要端點（唯讀）

`/health`（不需金鑰）、`/v1/datasets`、`/v1/datasets/{id}/anomalies`、`/v1/forecast`、`/v1/decision-support/{id}`、`/v1/live/domains`、`/v1/live/{id}/{status|forecast|monitor|versions|pending|events}`。
寫入端點 `/v1/live/{id}/{ingest|commit|rollback|recompute|sim/tick}` 存在，但沒有管理金鑰時一律 403。完整契約：[`docs/04_API_CONTRACT.md`](../04_API_CONTRACT.md)、`contracts/openapi_engine_readonly.json`。

## 5　即時預測資料流（合成）

引擎內建一個**合成資料產生器**（`engine/live/simfeed.py`，由研究層的合成資料產生器改寫）：預設每 900 秒推進 1 個模擬小時，每次推進後自動「暫存 → 提交 → 重算最新前向預測 → 監測」，並在版本庫留下新版本。所有這些資料都帶合成標記。

> **這不是連接真實現場設備。** 目前沒有任何真實即時資料來源接進系統；即時預測頁顯示的是「合成資料流上的預測」，用來示範「新資料進來後預測如何自動更新」。

## 6　安全設計摘要

| 面向 | 做法 |
|---|---|
| 金鑰 | 只存在 AI Studio Secrets 與引擎主機的 `~/aide-demo/state/demo.env`（權限 600）；腳本不 `cat`、不放命令列、不寫日誌 |
| 引擎設定檔 | 白名單：只允許 7 個變數名稱，其他（含 `AIDE_DATA_DIR`、管理金鑰）一律拒絕啟動 |
| 啟動前守門 | `compose_gate.py` 檢查「解析後」的 compose：服務數、連接埠、環境變數、掛載、映像 digest |
| Tunnel | 只能在互動式終端機手動開，要親自輸入確認句；預設 4 小時自動關閉；開前再驗證唯讀與寫入全拒絕 |
| 管理者 | 密碼只以 PBKDF2 雜湊存在 Node 伺服器；未設定＝所有人唯讀；5 次錯誤鎖定 |
| Gemini | 只改寫白話；層級、可信程度、限制、證據、行動全部由規則層帶出；核對失敗改回規則層原文；無金鑰時走規則式降級並標示「非 AI 生成」 |
| 決策輔助護欄 | 不得創造警戒門檻、不得下設備故障結論、不得產生自動控制指令；行動只能來自白名單 |
| Quick Tunnel 的限制 | Cloudflare 終止 TLS，看得到 `X-API-Key`；網址是臨時公開網址；金鑰用完即換 |

## 7　重現性與版本固定

- 引擎封包 `aide-engine-aistudio-1.0.0-20261123.tar.gz`，SHA-256 `f088f8ed6795336b523ea62448b79a2d67ee6b709b129bfeee02ee9acc938149`；`ci/EXPECTED_SHA256` 固定，不符就停止。
- Caddy 映像固定 digest；`demo_kit/preflight.sh` 另外核對 compose、Caddyfile、Dockerfile、.dockerignore 的 SHA-256。
- App 依賴版本寫在 `package.json`；`npm run lint`、`npm test`、`npm run build` 為釋出前三項檢查。
