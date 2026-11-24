# AIDE Docker／Caddy 隔離驗收（CI）

在乾淨的 GitHub-hosted Linux runner 上，真正建置並啟動 Python 引擎容器＋Caddy，再用 Node App 打過去。

## 版本（兩件事分開記）

| 項目 | 版本 | SHA-256 |
|---|---|---|
| Python 引擎部署封包（Docker 建置來源） | `aistudio-1.0.0`（來源平台 1.1.0-rc3） | `f088f8ed6795336b523ea62448b79a2d67ee6b709b129bfeee02ee9acc938149`（沒變，舊的 `ffd4ec6f…` 已失效） |
| Node／React App（Build Mode 匯出，含 F10／F11） | `aide-environmental-platform 1.1.0` | zip `dc2238440a916cd601f287d096b82d40937f5bea98a0f3f1838d6581a7ef0cbd` |

`ci/EXPECTED_SHA256` 固定這兩個值；不符時第 1 步就停止。Node App 在 AI Studio／Cloud Run 執行，不在這個 compose 裡，所以 CI 是在 runner 上以 `NODE_ENV=production` 直接啟動它（不是容器）。

## 檔案（全部是新增，在新分支 `ci/docker-acceptance`，不動 main、不動既有檔案）

```
.github/workflows/docker-acceptance.yml   最小權限 workflow（permissions: contents: read）
ci/run_acceptance.sh                      15 個步驟的驗收腳本
ci/checks.py                              只用標準函式庫的 HTTP 斷言
ci/docker-compose.ci.yml                  只把 Caddy 改綁 127.0.0.1:8088
ci/EXPECTED_SHA256                        兩個輸入檔的固定雜湊
ci/inputs/aide-engine-aistudio-1.0.0-20261123.tar.gz   21,865,723 bytes
ci/inputs/aide-app-buildmode-export-20261124.zip       8,142,438 bytes
ci/README.md
```

`ci/inputs/` 內含真實感測資料與模型（你已聲明可公開展示；repo 是 private）。不含 `.env`、金鑰、日誌、live_store。

## 最小操作（不需要新 Repository、不需要新 Deploy Key）

我沒有 GitHub 憑證，也不要你給。請用你自己平常的 git 登入，在你的終端機執行（`<包資料夾>` 是本資料夾 `ci_pack` 的完整路徑）：

```bash
mkdir aide-ci && cd aide-ci && git init -b ci/docker-acceptance
cp -r "<包資料夾>"/. .
git add -A && git status --short
```

先看 `git status` 只有上面列的檔案（8 個檔案），再（新分支與 main 沒有共同歷史，是刻意的：不碰 main、不動既有檔案）：

```bash
git commit -m "ci: docker/caddy acceptance (isolated)"
git remote add origin https://github.com/Ming1312/aide-aistudio-migration.git
git push -u origin ci/docker-acceptance
```

push 後會自動執行（`push` 觸發，只限這個分支）。看結果：GitHub → Actions → docker-acceptance；摘要頁會列出每個步驟與兩個版本。

不想用指令：在 GitHub 網頁 → 分支選單新建 `ci/docker-acceptance` → Add file → Upload files，把本資料夾內容（含 `.github` 資料夾）拖進去也行（單檔 25 MB 內都可以）。

## 驗收項目對應

| 步驟 | 內容 |
|---|---|
| 1–2 | 雜湊比對、分開解開兩個封包、印出兩個版本 |
| 3 | 建置前掃描：無 `.env`／金鑰檔／日誌／live_store 內容／疑似金鑰字串；範本不帶值 |
| 4 | 臨時亂數金鑰（`::add-mask::` 遮蔽）、`.env`、`/var/lib/aide/live_store` 擁有者 uid 10001（比照 vm_setup.sh） |
| 5 | `docker compose config`：正式檔單獨一次、加 CI 覆蓋一次，都不得有警告；解析結果確認 8080／80／443 沒對外 |
| 6 | `caddy validate`（正式網域形式與 `http://:80`）＋ `caddy adapt` 檢查只轉送 `/health`、`/v1/*`，其餘 404，有大小限制 |
| 7 | `docker compose build --no-cache`（不推送任何映像） |
| 8 | 映像檢查：無 `.env`／金鑰／日誌／pyc／`deploy/`／live_store 內容；映像設定與歷史無金鑰；使用者 `aide` |
| 9 | `up -d`，等 engine `healthy` |
| 10 | 經 Caddy：`/health` 不需金鑰、無金鑰與錯金鑰 401、七場域、寫入需管理金鑰、`/docs` 等 404、安全標頭、6MB 上限 413 |
| 11 | 容器互通（caddy→engine:8080）、8080 不對主機發佈、uid 10001、記憶體 2g、可寫 live_store |
| 12–13 | Node App：`npm install`、tsc、61 個測試、vite build；Node→Caddy→引擎整合（含推進模擬資料、預測與引擎逐項相同、錯誤金鑰的 Node 回 502） |
| 14 | `restart`／`stop`→`start`／`down`→`up`：回到 healthy、版本不變、Node 離線與自動恢復 |
| 15 | 日誌掃描金鑰；`down -v`；日誌留存 7 天 |

## 不做的事

不申請 TLS 憑證（`AIDE_DOMAIN=http://:80`）、不開放公網（Caddy 只綁 runner 的 127.0.0.1）、不推送映像、不使用 repo secrets、不改 Streamlit。

## 這包在送出前做過什麼、沒做過什麼

做過（在我的電腦，沒有 Docker）：`bash -n`、`py_compile`、YAML 解析；對真引擎＋Node（production 模式）實跑 `checks.py` 的引擎、Node、錯誤金鑰、版本保留、離線與恢復各階段，全部通過；全新 `npm install` 後 tsc／39＋22 測試／vite build 通過；建置前掃描在乾淨解開的封包上實跑（抓到並修掉一個範本誤判）。

沒做過：任何 `docker`、`compose`、`caddy` 指令、整份腳本的一次完整執行、actionlint／shellcheck（沒有裝，也沒有下載執行檔）。`Dockerfile` 在 `python:3.13-slim` 上安裝 `requirements.txt` 是第一次真的跑。CI 失敗是可能的，失敗的步驟名稱與日誌就是下一步的依據。
