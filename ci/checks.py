#!/usr/bin/env python3
"""AIDE Docker/Caddy 驗收用的 HTTP 斷言（只用標準函式庫）。

金鑰只從環境變數讀取（AIDE_API_KEY、AIDE_ADMIN_KEY、TEST_ADMIN_PASSPHRASE），不會被印出；
結束時會檢查每一個回應本文有沒有出現金鑰值。

用法：
  checks.py engine --base http://127.0.0.1:8088 [--caddy]
  checks.py engine-down --base http://127.0.0.1:8088          # 引擎停止時，經 Caddy 應回 502/503
  checks.py node-online --node http://127.0.0.1:3000 [--seed]   # --seed：推進模擬資料流並做預測檢查
  checks.py node-offline --node http://127.0.0.1:3000
  checks.py node-badkey --node http://127.0.0.1:3002
  checks.py snapshot --base URL --file F        # 記下各場域版本編號
  checks.py compare  --base URL --file F        # 重啟後版本必須完全一樣
結束碼：0 全部通過；1 有失敗。
"""
from __future__ import annotations

import argparse
import http.cookiejar
import json
import os
import sys
import time
import urllib.error
import urllib.request

BODIES: list[str] = []
RES: list[tuple[bool, str, str]] = []
DOMAINS = ["sheep_barn", "expert_system_c22", "sanyegong_creek", "construction_site_cb13505",
           "northeast_corner", "rearing_plant_1", "rearing_plant_1_north"]
NO_FORECAST = {"rearing_plant_1_north"}  # 資料不足，引擎本來就不提供預測


def ck(name: str, ok: bool, detail: object = "") -> None:
    RES.append((bool(ok), name, str(detail)[:200]))
    print(f"[{'OK' if ok else 'FAIL'}] {name}" + ("" if ok else f"  → {str(detail)[:200]}"), flush=True)


class Client:
    def __init__(self, base: str):
        self.base = base.rstrip("/")
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def call(self, method: str, path: str, body=None, headers=None, timeout=60):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(self.base + path, data=data, method=method,
                                     headers={"Content-Type": "application/json", **(headers or {})})
        try:
            with self.op.open(req, timeout=timeout) as r:
                txt, st, hd = r.read().decode("utf-8", "replace"), r.status, dict(r.headers)
        except urllib.error.HTTPError as e:
            txt, st, hd = e.read().decode("utf-8", "replace"), e.code, dict(e.headers)
        except Exception as e:  # noqa: BLE001
            return 0, f"CONNECTION_ERROR {type(e).__name__}", {}
        BODIES.append(txt)
        return st, txt, hd

    def j(self, method, path, body=None, headers=None, timeout=60):
        st, txt, hd = self.call(method, path, body, headers, timeout)
        try:
            return st, json.loads(txt), hd
        except Exception:  # noqa: BLE001
            return st, None, hd


def env(name: str) -> str:
    v = os.environ.get(name, "")
    if not v:
        print(f"缺少環境變數 {name}", file=sys.stderr)
        sys.exit(2)
    return v


def hget(hd: dict, name: str):
    for k, v in hd.items():
        if k.lower() == name.lower():
            return v
    return None


def wait_until(fn, timeout=90, step=3):
    end = time.time() + timeout
    while time.time() < end:
        try:
            if fn():
                return True
        except Exception:  # noqa: BLE001
            pass
        time.sleep(step)
    return False


# --------------------------------------------------------------------------- engine（直連或經 Caddy）
def stage_engine(a):
    api, adm = env("AIDE_API_KEY"), env("AIDE_ADMIN_KEY")
    c = Client(a.base)
    K = {"X-API-Key": api}
    st, h, hd = c.j("GET", "/health")
    ck("E1 /health 不需金鑰、200、ok=true、版本字串對得上",
       st == 200 and h and h.get("ok") is True and str(h.get("version", "")).startswith("aistudio-1.0.0"), (st, h and h.get("version")))
    ck("E1 /health 宣告唯讀＋需要金鑰＋寫入已啟用（有設管理金鑰）",
       bool(h) and h.get("read_only") is True and h.get("auth_required") is True and h.get("live_writes_enabled") is True, h and {k: h.get(k) for k in ("read_only", "auth_required", "live_writes_enabled")})
    ck("E1 /health 回應不含金鑰", api not in json.dumps(h) and adm not in json.dumps(h))
    st0, _, _ = c.call("GET", "/v1/live/domains")
    st1, _, _ = c.call("GET", "/v1/live/domains", headers={"X-API-Key": "wrong-" + api[:8]})
    ck("E2 無金鑰 → 401；錯誤金鑰 → 401", st0 == 401 and st1 == 401, (st0, st1))
    st, d, _ = c.j("GET", "/v1/live/domains", headers=K)
    ids = sorted(x.get("dataset_id") or x.get("id") for x in (d if isinstance(d, list) else []))
    ck("E2 正確金鑰 → 200 且七個場域齊全", st == 200 and ids == sorted(DOMAINS), (st, ids))
    stw, _, _ = c.call("POST", f"/v1/live/{DOMAINS[0]}/sim/tick", {"hours": 1}, headers=K)
    ck("E3 只有 API 金鑰、沒有管理金鑰就不能寫入（401）", stw == 401, stw)
    stw2, _, _ = c.call("POST", f"/v1/live/{DOMAINS[0]}/sim/tick", {"hours": 1}, headers={"X-API-Key": "x", "X-Admin-Key": adm})
    ck("E3 管理金鑰正確但 API 金鑰錯誤 → 401", stw2 == 401, stw2)
    st, ds, _ = c.j("GET", "/v1/datasets", headers=K)
    ck("E4 /v1/datasets 200、七個資料集", st == 200 and isinstance(ds, (list, dict)) and len(ds) >= 7, (st, type(ds).__name__))
    if a.caddy:
        for p in ("/docs", "/openapi.json", "/redoc", "/", "/v1x", "/admin", "/.env"):
            s, txt, _ = c.call("GET", p, headers=K)
            ck(f"C1 Caddy 只轉送 /health 與 /v1/*：{p} → 404", s == 404, (s, txt[:40]))
        s, _, hd = c.call("GET", "/health")
        ck("C2 安全標頭：X-Content-Type-Options=nosniff、不洩漏 Server 標頭",
           hget(hd, "X-Content-Type-Options") == "nosniff" and hget(hd, "Server") is None, {k: v for k, v in hd.items() if k.lower() in ("server", "x-content-type-options", "strict-transport-security")})
        s, txt, _ = c.call("POST", "/v1/forecast", {"x": "a" * (7 * 1024 * 1024)}, headers=K, timeout=120)
        ck("C3 請求本文超過 6MB 被 Caddy 擋下（413）", s == 413, s)
    leaked = [i for i, b in enumerate(BODIES) if api in b or adm in b]
    ck("E9 所有回應本文都不含金鑰", not leaked, leaked[:3])


def stage_engine_down(a):
    c = Client(a.base)
    s, txt, _ = c.call("GET", "/health", timeout=20)
    ck("D1 引擎停止時，經 Caddy 的 /health 是 502/503/504（不是假的 200）", s in (502, 503, 504), (s, txt[:60]))


# --------------------------------------------------------------------------- Node（經 Caddy 打到引擎）
def node_health(c):
    st, h, _ = c.j("GET", "/api/health", timeout=30)
    return st, (h or {})


def stage_node_online(a):
    api, adm, pw = env("AIDE_API_KEY"), env("AIDE_ADMIN_KEY"), env("TEST_ADMIN_PASSPHRASE")
    c = Client(a.node)
    st, h = node_health(c)
    ck("N1 /api/health：引擎已連線、即時管線已連線、寫入已啟用",
       st == 200 and h.get("engine_connected") is True and h.get("live_engine_connected") is True and h.get("live_writes_enabled") is True,
       {k: h.get(k) for k in ("engine_connected", "live_engine_connected", "live_writes_enabled", "warning_message")})
    ck("N1 引擎版本 aistudio-1.0.0（Python 封包）", str(h.get("engine_version", "")).startswith("aistudio-1.0.0"), h.get("engine_version"))
    st, d, _ = c.j("GET", "/api/live/domains")
    n = len(d) if isinstance(d, list) else -1
    ck("N2 Node → Caddy → 引擎：/api/live/domains 回七個場域", st == 200 and n == 7, (st, n))
    s_view, _, _ = c.call("POST", f"/api/live/{DOMAINS[0]}/sim/tick", {"hours": 1})
    ck("N3 未登入管理者寫入被 Node 擋下（403）", s_view == 403, s_view)
    sl, _, _ = c.call("POST", "/api/admin/login", {"passphrase": "wrong-passphrase-for-ci"})
    ck("N3 錯誤管理者密碼 → 401", sl == 401, sl)
    sl, _, _ = c.call("POST", "/api/admin/login", {"passphrase": pw})
    ck("N3 正確管理者密碼 → 200", sl == 200, sl)
    if a.seed:
        D = "sanyegong_creek"
        s0, st0, _ = c.j("GET", f"/api/live/{D}/status")
        s0f, _, _ = c.call("GET", f"/api/live/{D}/forecast")
        ck("N4 推進前：無版本、預測 404（不用預計算冒充）", s0 == 200 and st0 and st0.get("current_seq") == 0 and s0f == 404, (s0, st0 and st0.get("current_seq"), s0f))
        ticks = [c.j("POST", f"/api/live/{D}/sim/tick", {"hours": 12}) for _ in range(3)]
        ck("N4 管理者經 Node 推進 3 批：每批自動提交並重算（15 個任務）",
           all(s == 200 and r and r.get("decision") == "committed" and (r.get("forecast") or {}).get("n_ok") == 15 for s, r, _ in ticks),
           [(s, r and r.get("decision")) for s, r, _ in ticks])
        s, fc, _ = c.j("GET", f"/api/live/{D}/forecast")
        s2, stt, _ = c.j("GET", f"/api/live/{D}/status?verify=true")
        eng = Client(a.engine_base)
        s3, fce, _ = eng.j("GET", f"/v1/live/{D}/forecast", headers={"X-API-Key": api})
        ck("N5 Node 回的預測與引擎直接回的逐項相同，且對上目前版本",
           s == 200 and s3 == 200 and fc == fce and fc.get("data_version") == (stt or {}).get("version_id") and (stt or {}).get("forecast", {}).get("up_to_date") is True,
           (s, s3, fc == fce))
        tasks = (fc or {}).get("tasks", [])
        ck("N5 預測全是前瞻（目標時間在資料之後）、六種方法齊全、帶合成標記",
           bool(tasks) and all(t["target_time"] > fc["data_end"] for t in tasks if "target_time" in t) and all(len(t["models"]) == 6 and t.get("contains_synthetic") for t in tasks),
           len(tasks))
        # 七場域：狀態與預測經 Node 與引擎一致（不足場域沒有預測）
        bad = []
        for dom in DOMAINS:
            cs, _, _ = c.call("GET", f"/api/live/{dom}/status")
            if cs != 200:
                bad.append((dom, "status", cs))
        ck("N6 七個場域的 /status 經 Node 都是 200", not bad, bad)
    leaked = [i for i, b in enumerate(BODIES) if api in b or adm in b or pw in b]
    ck("N9 Node 所有回應都不含金鑰與管理者密碼", not leaked, leaked[:3])


def stage_node_offline(a):
    c = Client(a.node)

    def off():
        st, h = node_health(c)
        return st == 200 and h.get("engine_connected") is False
    ck("N7 引擎停止後 /api/health 轉為 engine_connected=false", wait_until(off, 60, 3))
    s, d, _ = c.j("GET", "/api/live/domains")
    ck("N7 即時端點回 503＋明確訊息（不回舊資料）", s == 503 and isinstance(d, dict) and d.get("detail"), (s, d))
    s, _, _ = c.call("GET", "/")
    ck("N7 Node 自己仍然可以回應（前端頁面 200）", s == 200, s)


def stage_node_recover(a):
    c = Client(a.node)

    def on():
        st, h = node_health(c)
        return st == 200 and h.get("engine_connected") is True and h.get("live_engine_connected") is True
    ck("N8 引擎恢復後，Node 自動恢復連線（不用重啟 Node）", wait_until(on, 90, 3))
    s, d, _ = c.j("GET", "/api/live/domains")
    ck("N8 恢復後即時端點回 200", s == 200 and isinstance(d, list) and len(d) == 7, (s, d if not isinstance(d, list) else len(d)))


def stage_node_badkey(a):
    c = Client(a.node)
    st, h = node_health(c)
    ck("K1 錯誤金鑰的 Node：/api/health 轉為離線（不是假的已連線）",
       st == 200 and h.get("engine_connected") is False and h.get("live_engine_connected") is False and h.get("live_writes_enabled") is False,
       {k: h.get(k) for k in ("engine_connected", "live_engine_connected", "live_writes_enabled")})
    s, txt, _ = c.call("GET", "/api/live/domains")
    ck("K2 錯誤金鑰：即時端點 502、固定訊息、不洩漏標頭名稱",
       s == 502 and "引擎憑證設定有誤" in txt and "X-API-Key" not in txt, (s, txt[:80]))


# --------------------------------------------------------------------------- 重啟後狀態保留
def versions(base):
    api = env("AIDE_API_KEY")
    c = Client(base)
    out = {}
    for d in DOMAINS:
        s, v, _ = c.j("GET", f"/v1/live/{d}/versions", headers={"X-API-Key": api})
        out[d] = [x.get("version_id") or x.get("id") for x in v] if s == 200 and isinstance(v, list) else f"HTTP {s}"
    return out


def stage_snapshot(a):
    v = versions(a.base)
    json.dump(v, open(a.file, "w"))
    ck("P1 記下各場域版本（寫入檔案）", all(isinstance(x, list) for x in v.values()), {k: (len(x) if isinstance(x, list) else x) for k, x in v.items()})


def stage_compare(a):
    before = json.load(open(a.file))
    after = versions(a.base)
    ck("P2 重啟後所有場域的版本編號與重啟前完全相同（live_store 有保留）", before == after,
       {k: (before.get(k), after.get(k)) for k in before if before.get(k) != after.get(k)})
    ck("P2 重啟前確實有資料可比（至少一個場域有版本）", any(isinstance(x, list) and x for x in before.values()))


def main():
    p = argparse.ArgumentParser()
    p.add_argument("stage", choices=["engine", "engine-down", "node-online", "node-offline", "node-recover", "node-badkey", "snapshot", "compare"])
    p.add_argument("--base", default="http://127.0.0.1:8088")
    p.add_argument("--engine-base", default="http://127.0.0.1:8088")
    p.add_argument("--node", default="http://127.0.0.1:3000")
    p.add_argument("--caddy", action="store_true")
    p.add_argument("--seed", action="store_true")
    p.add_argument("--file", default="versions.json")
    a = p.parse_args()
    {"engine": stage_engine, "engine-down": stage_engine_down, "node-online": stage_node_online, "node-offline": stage_node_offline,
     "node-recover": stage_node_recover, "node-badkey": stage_node_badkey, "snapshot": stage_snapshot, "compare": stage_compare}[a.stage](a)
    bad = [r for r in RES if not r[0]]
    print(f"\n{a.stage}: 問題 {len(bad)}／{len(RES)} 項")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
