# AIDE Python 引擎（預測 API＋即時管線）— 私有資料夾

**不要把這個資料夾推到公開 repo，也不要放進 AI Studio 專案。** 它含模型與真實感測 CSV（`data/raw/`，與專案內原檔逐位元相同）。

* 本機啟動（需 Python 3.13）：`pip install -r requirements.txt && AIDE_API_KEY=<長隨機字串> uvicorn main:app --port 8080`
* 容器：`docker build -t aide-engine .`（**尚未實測 Docker 建置**；已實測的是同一組程式與版本在隔離 venv 的 TestClient 驗收）
* 端點與契約：`../app_repo/docs/04_API_CONTRACT.md`、`../app_repo/contracts/openapi_engine.json`
* **預設唯讀**：沒設定 `AIDE_ADMIN_KEY` 時所有寫入端點回 403。設定後才開啟即時管線的 5 個寫入端點（匯入／核准／回復／重算／推進模擬資料流），仍然**不重訓、不改模型與原始資料**。
* 決策輔助：`GET /v1/decision-support/{dataset_id}`（`decision_support/`：規則層＋證據收集＋政策登錄表；不新增任何模型、門檻或控制指令；說明見 `../app_repo/docs/10_DECISION_SUPPORT.md`）。
* 驗收：`<venv>/bin/python tools/p63_api_check.py <遷移包根目錄>`（專案 `tools/`；90 個預測任務、安全檢查）
* `src/` 是專案 `src/` 的子集（41 個模組，**逐位元相同、未修改**；其中 6 個是即時管線需要的版本庫／預測／分析模組）；`outputs/phase5_8_7/calibration/` 是偵測器的各場域校準檔（缺它適用性守門會靜默失效，引擎會主動偵測並標旗）；`MIGRATION_MANIFEST.json` 記錄每個檔案的 sha256。
* 即時管線（Phase 6.5）：`live/`（`service.py` 管線、`simfeed.py` 模擬資料流、`backup.py` 備份還原）。說明 `../app_repo/docs/11_LIVE_PIPELINE.md`；部署與營運 `../app_repo/docs/12_DEPLOYMENT_RUNBOOK.md`；驗收 `<venv>/bin/python tools/p65_live_check.py <遷移包根目錄>`（38 項）。
* 雲端虛擬機部署：`deploy/`（`docker-compose.yml`、`Caddyfile`、`env.template`、`vm_setup.sh`、`backup.sh`、`healthcheck.sh`）；步驟見 `../app_repo/docs/13_VM_DEPLOY_STEPS.md`；打包 `tools/p65_make_deploy_bundle.py`、遠端驗收 `tools/p65_remote_check.py`。
* 儲存：只有 `AIDE_LIVE_ROOT`（預設 `./data/live_store`）會被寫入，內容是版本庫、稽核、預測發佈紀錄與事件；部署時必須是持久化的本機磁碟，且固定單一執行個體。
* 本機展示（模擬資料流會每 60 秒自動推進並重算預測）：`AIDE_API_KEY=<長隨機字串> AIDE_ADMIN_KEY=<另一個長隨機字串> AIDE_SIM_FEED=1 AIDE_ALLOW_SIM=1 uvicorn main:app --port 8080`。這是**展示用**，資料全是合成（SYNTHETIC）；真實部署不要開這兩個旗標。
