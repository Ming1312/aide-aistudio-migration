# GitHub Actions 真實執行結果（Ming1312/aide-aistudio-migration，分支 ci/docker-acceptance）

| 次數 | Run ID | Commit | 結果 |
|---|---|---|---|
| 1 | 45397881111 | b2ca050 | 失敗：步驟 1–9 通過；步驟 10 的 C3（>6MB 請求）失敗，原因是測試用戶端 urllib 在 Caddy 提早回 413 並關連線時得到 BrokenPipe（引擎日誌沒有收到該 POST，代表 Caddy 確實擋下）。 |
| 2 | 45398211524 | 12e8f9a | **成功：15 個步驟全部通過** |

main 始終是 7d266da，沒有改動。日誌是 GitHub 回傳的原文（金鑰已被 Actions 遮蔽為 ***），已確認不含金鑰。

Run 2 網址：https://github.com/Ming1312/aide-aistudio-migration/actions/runs/45398211524
