#!/usr/bin/env python3
"""AIDE 展示套件用的 HTTP 小工具（只用標準函式庫）。

金鑰只從 --env 指定的檔案讀（AIDE_API_KEY=...），只放在請求標頭裡；
不會印出、不會放在命令列、不會寫進任何檔案。例外只印出例外類別名稱。

子命令（--base 預設 http://127.0.0.1:8088）：
  health        印出 /health 的關鍵欄位（不需金鑰）                 結束碼 0=取得
  readonly      檢查唯讀：live_writes_enabled、live_sim_enabled 都必須是 false   0=唯讀
  unauth        無金鑰、錯誤金鑰打 /v1/live/domains 都必須 401            0=符合
  deny-writes   五個寫入端點（帶正確 API 金鑰）都必須 403；無金鑰必須 401     0=符合
  versions      各場域版本數與總數（需要金鑰）
  synthetic     羊舍即時預測的每個任務都必須標 contains_synthetic        0=符合 3=尚無預測 1=有未標記
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request

# 不使用 http_proxy／https_proxy 等環境變數：本機檢查不能繞去 proxy，帶著 X-API-Key 的請求也不能被送到 proxy
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

DOMAINS = ["sheep_barn", "expert_system_c22", "sanyegong_creek", "construction_site_cb13505",
           "northeast_corner", "rearing_plant_1", "rearing_plant_1_north"]
WRITE_ENDPOINTS = ["sim/tick", "ingest", "commit", "rollback", "recompute"]


def read_key(path: str) -> str:
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                s = line.strip()
                if s.startswith("AIDE_API_KEY="):
                    return s.split("=", 1)[1].strip().strip("'\"")
    except OSError:
        pass
    return ""


def call(base: str, method: str, path: str, key: str | None = None, body=None, timeout: int = 15):
    headers = {"Content-Type": "application/json"}
    if key is not None:
        headers["X-API-Key"] = key
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(base.rstrip("/") + path, data=data, method=method, headers=headers)
    try:
        with OPENER.open(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001  只回報類別名稱，避免把含有網址或標頭的訊息印出來
        return 0, type(e).__name__


def need_key(a) -> str:
    k = read_key(a.env)
    if not k:
        print("讀不到 AIDE_API_KEY（env 檔不存在或沒有這一行）", file=sys.stderr)
        sys.exit(2)
    return k


def cmd_health(a) -> int:
    st, txt = call(a.base, "GET", "/health")
    try:
        h = json.loads(txt)
    except Exception:  # noqa: BLE001
        print(f"health: HTTP {st}（不是 JSON）")
        return 1
    if st != 200:
        print(f"health: HTTP {st}")
        return 1
    for k in ("version", "auth_required", "read_only", "live_writes_enabled", "live_sim_enabled", "sim_feed"):
        print(f"{k}={h.get(k)}")
    return 0


def cmd_readonly(a) -> int:
    st, txt = call(a.base, "GET", "/health")
    try:
        h = json.loads(txt)
    except Exception:  # noqa: BLE001
        print(f"無法讀取 /health（HTTP {st}）")
        return 1
    ok = st == 200 and h.get("read_only") is True and h.get("live_writes_enabled") is False and h.get("live_sim_enabled") is False
    print(f"readonly={'yes' if ok else 'NO'} live_writes_enabled={h.get('live_writes_enabled')} live_sim_enabled={h.get('live_sim_enabled')}")
    return 0 if ok else 1


def cmd_unauth(a) -> int:
    s1, _ = call(a.base, "GET", "/v1/live/domains")
    s2, _ = call(a.base, "GET", "/v1/live/domains", key="wrong-key-for-check")
    print(f"no-key={s1} wrong-key={s2}")
    return 0 if (s1 == 401 and s2 == 401) else 1


def cmd_deny_writes(a) -> int:
    key = need_key(a)
    bad = []
    for ep in WRITE_ENDPOINTS:
        s, _ = call(a.base, "POST", f"/v1/live/{DOMAINS[0]}/{ep}", key=key, body={"hours": 1})
        print(f"{ep}: with-api-key={s}")
        if s != 403:
            bad.append((ep, s))
    s, _ = call(a.base, "POST", f"/v1/live/{DOMAINS[0]}/sim/tick", body={"hours": 1})
    print(f"sim/tick: no-key={s}")
    if s != 401:
        bad.append(("sim/tick(no-key)", s))
    return 0 if not bad else 1


def cmd_versions(a) -> int:
    key = need_key(a)
    total, errs = 0, 0
    for d in DOMAINS:
        s, txt = call(a.base, "GET", f"/v1/live/{d}/versions", key=key)
        if s == 200:
            try:
                n = len(json.loads(txt))
            except Exception:  # noqa: BLE001
                n = -1
        else:
            n = -1
        if n < 0:
            errs += 1
            print(f"{d}\tHTTP {s}")
        else:
            total += n
            print(f"{d}\t{n}")
    print(f"total\t{total}")
    return 0 if errs == 0 else 1


def cmd_synthetic(a) -> int:
    key = need_key(a)
    s, txt = call(a.base, "GET", "/v1/live/sheep_barn/forecast", key=key)
    if s == 404:
        print("尚無預測（內部資料流還沒產生第一個版本）")
        return 3
    try:
        tasks = json.loads(txt).get("tasks", [])
    except Exception:  # noqa: BLE001
        print(f"無法解析（HTTP {s}）")
        return 1
    flagged = sum(1 for t in tasks if t.get("contains_synthetic") is True)
    print(f"tasks={len(tasks)} synthetic_flagged={flagged}")
    return 0 if tasks and flagged == len(tasks) else 1


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("cmd", choices=["health", "readonly", "unauth", "deny-writes", "versions", "synthetic"])
    p.add_argument("--base", default="http://127.0.0.1:8088")
    p.add_argument("--env", default="")
    a = p.parse_args()
    fn = {"health": cmd_health, "readonly": cmd_readonly, "unauth": cmd_unauth, "deny-writes": cmd_deny_writes,
          "versions": cmd_versions, "synthetic": cmd_synthetic}[a.cmd]
    sys.exit(fn(a))


if __name__ == "__main__":
    main()
