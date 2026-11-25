#!/usr/bin/env bash
# 輪詢七場域狀態；任何場域 health != ok 就以非 0 結束（可接到你自己的監看服務或 cron 郵件）。
# 用法：AIDE_URL=https://你的網域 AIDE_API_KEY=… ./healthcheck.sh
set -euo pipefail
: "${AIDE_URL:?}" "${AIDE_API_KEY:?}"
out=$(curl -fsS -H "X-API-Key: ${AIDE_API_KEY}" "${AIDE_URL}/v1/live/domains")
python3 - "$out" <<'PY'
import json, sys
d = json.loads(sys.argv[1])
bad = [x for x in d if x["health"] != "ok"]
for x in d:
    print(("OK   " if x["health"] == "ok" else "ATTN ") + x["dataset_id"].ljust(26) + " " + str(x["freshness"]) + " " + "; ".join(f["code"] for f in x["flags"]))
sys.exit(1 if bad else 0)
PY
