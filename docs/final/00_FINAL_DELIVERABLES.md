# 00　最終交付清單（v1.1.0 結案）

## 1　GitHub 版本

| 項目 | 內容 |
|---|---|
| Repository | https://github.com/Ming1312/aide-aistudio-migration（**public**，2026-11-25 起公開；含原始 CSV 與模型，授權範圍見 07） |
| 結案分支 | `release/aide-v1.1.0`：https://github.com/Ming1312/aide-aistudio-migration/tree/release/aide-v1.1.0 |
| App／引擎程式碼版本 | commit `32934f1c2016dce0b065e4c3a8fccf57c2e9fcec`（2026-11-25；之後的 commit 只新增文件） |
| 結案文件版本 | 該分支最新 commit（`git log -1 release/aide-v1.1.0`；確切 SHA 隨交付訊息提供） |
| 保留未動 | `main`（`7d266da`）、`ci/docker-acceptance`（`12e8f9a`） |

## 2　交付文件

| 要求 | 文件 | 位置 |
|---|---|---|
| 完整專案 README | `README.md` | repo 根目錄 |
| 系統架構與資料流說明 | [02_ARCHITECTURE_AND_DATAFLOW.md](02_ARCHITECTURE_AND_DATAFLOW.md) | `docs/final/` |
| AI 模型、研究方法與驗證結果 | [03_MODELS_RESEARCH_AND_VALIDATION.md](03_MODELS_RESEARCH_AND_VALIDATION.md) | `docs/final/` |
| 七場域功能與使用說明 | [04_DOMAIN_FEATURES_AND_USAGE.md](04_DOMAIN_FEATURES_AND_USAGE.md) | `docs/final/` |
| 本機啟動、停止、免費 Tunnel 及 AI Studio 設定手冊 | [05_OPERATIONS_MANUAL.md](05_OPERATIONS_MANUAL.md)（細節：`demo_kit/README.md`） | `docs/final/`、`demo_kit/` |
| 最終驗收報告 | [06_FINAL_ACCEPTANCE_REPORT.md](06_FINAL_ACCEPTANCE_REPORT.md) | `docs/final/` |
| 已知限制及未來發展方向 | [07_LIMITATIONS_AND_FUTURE_WORK.md](07_LIMITATIONS_AND_FUTURE_WORK.md) | `docs/final/` |
| 競賽展示操作腳本 | [08_DEMO_SCRIPT.md](08_DEMO_SCRIPT.md) | `docs/final/` |
| 給指導老師與評審的成果說明 | [01_PROJECT_SUMMARY.md](01_PROJECT_SUMMARY.md) | `docs/final/` |
| 可列印版（01～08 合訂） | `AIDE_v1.1.0_final_documents.pdf` | `docs/final/` |

## 3　程式與證據

| 內容 | 位置 |
|---|---|
| AI Studio App（React／Node）、測試 | `src/`、`server/`、`server.ts`、`reference/`、`contracts/` |
| Python 引擎文字原始碼與部署設定 | `engine/`（含模型與資料的完整封包：`ci/inputs/aide-engine-aistudio-1.0.0-20261123.tar.gz`，SHA-256 `f088f8ed…938149`） |
| Docker／Caddy 隔離驗收（GitHub Actions） | `ci/`、`.github/workflows/docker-acceptance.yml`；證據 `docs/phase6/phase6_7_ci_run.md` |
| 展示套件（啟動／停止／Tunnel／狀態／換金鑰） | `demo_kit/` |
| Phase 6.6～6.8 整合與驗收報告、F12／F13 patch | `docs/phase6/`、`docs/phase6/patches/` |
| 遷移規格、API 契約、決策輔助、安全政策 | `docs/01…10`、`contracts/` |
| 真實資料與合成展示資料 | `public/data/real_public/`、`public/data/demo_synthetic/` |
| **原始研究專案**（Streamlit 平台、模型、原始 CSV、各階段報告 `outputs/phase2…phase6_8/`） | 本機 `~/桌面/ai專題競賽/handoff_extracted/`（**不在 GitHub、沒有被修改**） |
| 本機結案文件副本 | `~/桌面/ai專題競賽/handoff_extracted/outputs/final_delivery/` |

## 4　驗收狀態一覽（完整見 06）

| 狀態 | 項目 |
|---|---|
| **已驗證** | 七場域真實資料探索；六場域預測（各 15 組）與北側拒絕建模；合成資料流與自動更新；七場域決策輔助；資料更新展示（含 F13）；離線降級；引擎唯讀與寫入全拒絕；Docker／Caddy；免費 Quick Tunnel（一次完整演練）；展示套件 |
| **已完成（未完全驗證）** | Gemini 白話改寫（規則式降級已驗證，真實 Gemini 未實測） |
| **部分完成** | 模型維護頁（寫入按鈕停用）；羊舍決策頁（唯讀呈現，人工決策不寫入） |
| **未驗證／未做** | 管理者寫入流程（F12）；區網其他裝置、重開機自動重啟、Tunnel 4 小時自動關閉、長時間版本庫成長、負載；**獨立前瞻驗證（未做）**；連接真實現場設備（**沒有**） |

## 5　剩餘限制（摘要，完整見 07）

沒有獨立盲測，結果為探索性回測；沒有故障標籤，異常為候選事件；THI 84 為候選門檻；即時資料流為合成；F12 未修正（非阻擋）；資料授權僅有使用者聲明（本競賽專題範圍），而 repo 已公開；Quick Tunnel 僅供展示與測試。

## 6　安全收尾狀態

Docker 容器已停止並移除；Tunnel 已關閉（沒有 cloudflared 行程、8088 沒有監聽）；舊 demo 金鑰已刪除；repo 內沒有金鑰、`.env`、私人日誌或執行中的版本庫；零費用；模型、資料、版本庫（`/var/lib/aide/live_store`）、備份、映像與測試證據全部保留。

使用者尚待自行處理（建議）：AI Studio Secrets 殘留的舊 `ENGINE_API_KEY`／`ENGINE_BASE_URL`（下次展示重設）；`gh auth logout` 並撤銷 GitHub CLI 的 OAuth 授權。
