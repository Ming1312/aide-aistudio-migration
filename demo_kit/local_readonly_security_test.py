import json, os, sys, time, urllib.request, urllib.error, resource, subprocess, threading
BASE = os.environ.get("BASE", "http://127.0.0.1:18090")
API = os.environ["AIDE_API_KEY"]
def req(method, path, body=None, headers=None, timeout=60, raw=None):
    data = raw if raw is not None else (None if body is None else json.dumps(body).encode())
    r = urllib.request.Request(BASE + path, data=data, method=method, headers={"Content-Type": "application/json", **(headers or {})})
    t = time.time()
    try:
        with urllib.request.urlopen(r, timeout=timeout) as x:
            return x.status, x.read().decode("utf-8", "replace"), time.time() - t, dict(x.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace"), time.time() - t, dict(e.headers)
    except Exception as e:
        return 0, type(e).__name__, time.time() - t, {}
K = {"X-API-Key": API}
out = []
def ck(n, ok, d=""):
    out.append(ok); print(("[OK]  " if ok else "[FAIL] ") + n + ("" if ok else f" → {str(d)[:200]}"), flush=True)

st, h, _, _ = req("GET", "/health"); h = json.loads(h)
ck("T1 公開引擎設定：寫入停用、模擬端點停用、內部資料流開啟", h["live_writes_enabled"] is False and h["live_sim_enabled"] is False and h["sim_feed"] is True, {k: h[k] for k in ("live_writes_enabled", "live_sim_enabled", "sim_feed")})
print("   /health 對外揭露的欄位：", sorted(h.keys()), "｜libs:", h["libs"])
codes = []
for ep in ("ingest", "commit", "rollback", "recompute", "sim/tick"):
    for adm in ({}, {"X-Admin-Key": "guess-" + "x" * 20}):
        s, t, _, _ = req("POST", f"/v1/live/sheep_barn/{ep}", {"hours": 1}, {**K, **adm})
        codes.append((ep, s))
ck("T2 五個寫入端點，即使帶正確 API 金鑰＋亂猜管理金鑰，全部 403（管理金鑰未設定＝寫入功能停用）", all(c == 403 for _, c in codes), codes)
s, t, _, _ = req("POST", "/v1/live/sheep_barn/sim/tick", {"hours": 1})
ck("T2 完全沒帶金鑰打寫入端點 → 401（不洩漏『管理功能存在』以外的資訊）", s == 401, (s, t[:80]))
# T3 daemon
v0 = {d: len(json.loads(req("GET", f"/v1/live/{d}/versions", headers=K)[1])) for d in ("sheep_barn", "sanyegong_creek", "rearing_plant_1_north")}
time.sleep(float(os.environ.get("WAIT", "40")))
v1 = {d: len(json.loads(req("GET", f"/v1/live/{d}/versions", headers=K)[1])) for d in v0}
print("   versions before/after:", v0, v1)
ck("T3 內部模擬資料流在沒有任何寫入端點的情況下自己推進版本", all(v1[d] > v0[d] for d in ("sheep_barn", "sanyegong_creek")), (v0, v1))
# T4 unauthenticated flood
N = 3000; res = []
def flood():
    for _ in range(N // 6):
        res.append(req("GET", "/v1/live/domains", timeout=20)[0])
ths = [threading.Thread(target=flood) for _ in range(6)]; t0 = time.time(); [t.start() for t in ths]; [t.join() for t in ths]
dt = time.time() - t0
s, _, lat, _ = req("GET", "/v1/live/domains", headers=K)
ck(f"T4 {N} 次無金鑰請求（{dt:.1f}s）全部 401，且隨後正確金鑰請求仍 200（無金鑰的請求不消耗速率額度）", set(res) == {401} and s == 200, (set(res), s))
# T5 valid key flood → 429 then recover
RATE = int(os.environ.get("RATE", "120"))
c = [req("GET", "/health")[0] for _ in range(1)]
sts = [req("GET", "/v1/live/domains", headers=K)[0] for _ in range(RATE + 30)]
n429 = sts.count(429)
ck(f"T5 正確金鑰超過每分鐘 {RATE} 次 → 429（限流有作用）", n429 > 0, (sts.count(200), n429))
# T6 oversized body without a reverse proxy
big = b'{"x":"' + b"a" * (30 * 1024 * 1024) + b'"}'
t0 = time.time(); s, t, dtb, _ = req("POST", "/v1/forecast", headers={}, raw=big, timeout=120)
print(f"   T6 無金鑰、30MB 本文直打引擎 → HTTP {s}，{dtb:.1f}s（記憶體影響要另外量；結果見 feasibility_report.md）")
s, t, _, _ = req("POST", "/v1/forecast", raw=b"{not json", headers=K)
ck("T7 壞 JSON → 4xx，沒有 stack trace／檔案路徑", s in (400, 422) and "Traceback" not in t and "/home/" not in t and "File \"" not in t, (s, t[:120]))
s, t, _, hd = req("GET", "/v1/nope", headers=K)
ck("T7 不存在的路徑 → 404、不洩漏伺服器標頭細節", s == 404, (s, t[:80]))
s, t, _, _ = req("GET", "/docs"); s2, _, _, _ = req("GET", "/openapi.json")
ck("T7 /docs、/openapi.json 不對外（AIDE_DOCS=0）", s == 404 and s2 == 404, (s, s2))
print(f"\n問題 {out.count(False)}／{len(out)} 項")
sys.exit(1 if False in out else 0)
