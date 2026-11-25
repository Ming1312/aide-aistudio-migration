"""
AIDE Python API（Phase 6.3）— 為 Google AI Studio 網站提供『真正的』預測與分析。

* 唯讀服務：沒有任何寫入端點；不接受檔案上傳；不重新訓練；不改模型、不改資料。
* 真實資料：只讀 data/raw 的七份真實感測 CSV（雜湊在 /health 回報）。合成展示資料不經過這支 API（它們是前端的獨立靜態檔案）。
* 模型：沿用既有的 HGB／XGBoost 與基準方法（研究 artifact：outputs/phase5_8_2/artifacts，每個載入前驗證 sha256；羊舍 THI 正式 HGB：models/）。
* 存取：設定環境變數 AIDE_API_KEY 後，所有 /v1/* 都要帶 X-API-Key；/health 不需要。金鑰只放在伺服器端的環境變數，不放在程式碼或前端。
* 這是研究預測（探索性、未經獨立驗證），不是正式決策；回應內都附有限制說明。

啟動：uvicorn main:app --host 0.0.0.0 --port 8080
"""
from __future__ import annotations

import hmac
import json
import math
import os
import sys
import threading
import time
from collections import defaultdict, deque
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
os.environ.setdefault("OMP_NUM_THREADS", "2")
sys.path.insert(0, str(HERE / "src"))

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from pydantic import BaseModel, Field  # noqa: E402

import p55_analysis as AN  # noqa: E402
import p56_profile as PR  # noqa: E402
import p582_engine as E  # noqa: E402
import p586_anomaly as ANOM  # noqa: E402
from live.service import LiveError, LiveService  # noqa: E402
from live.simfeed import SimFeed  # noqa: E402
from decision_support import collect as DSC  # noqa: E402
from decision_support import rules as DSR  # noqa: E402

VERSION = (HERE / "VERSION").read_text(encoding="utf-8").strip() if (HERE / "VERSION").is_file() else "dev"
CATALOG = json.loads((HERE / "catalog.json").read_text(encoding="utf-8"))
DS = {d["id"]: d for d in CATALOG["datasets"]}
API_KEY = os.environ.get("AIDE_API_KEY", "")
if os.environ.get("AIDE_REQUIRE_KEY") == "1" and not API_KEY:
    raise RuntimeError("AIDE_REQUIRE_KEY=1 但沒有設定 AIDE_API_KEY：拒絕啟動（引擎不可在沒有金鑰的情況下對外提供服務）")
ADMIN_KEY = os.environ.get("AIDE_ADMIN_KEY", "")                       # 寫入類端點（匯入、提交、回復、重算）專用；沒設定＝寫入功能停用
LIVE_ROOT = Path(os.environ.get("AIDE_LIVE_ROOT", str(HERE / "data" / "live_store")))
ALLOW_SIM = os.environ.get("AIDE_ALLOW_SIM") == "1"                      # 允許用 API 推進『模擬資料流』（展示用）
SIM_DAEMON = os.environ.get("AIDE_SIM_FEED") == "1"                      # 啟動時開背景模擬資料流
SIM_INTERVAL_S = float(os.environ.get("AIDE_SIM_INTERVAL_S", "60"))
SIM_HOURS = int(os.environ.get("AIDE_SIM_HOURS", "12"))
MAX_UPLOAD_BYTES = int(os.environ.get("AIDE_MAX_UPLOAD_BYTES", str(5 * 1024 * 1024)))
ORIGINS = [o.strip() for o in os.environ.get("AIDE_ALLOWED_ORIGINS", "").split(",") if o.strip()]
RATE_PER_MIN = int(os.environ.get("AIDE_RATE_PER_MIN", "120"))
LOCK = threading.RLock()                                           # 預測引擎的快取不是為多執行緒寫入設計的：串行化重的運算（RLock：決策輔助端點持有鎖時會再呼叫同樣需要鎖的函式）
KIND_ZH = {"short_event": "短暫突波", "level_shift": "持續偏離", "drift": "緩慢漂移", "drift_or_offset": "漂移或偏移", "relation_decoupling": "與其他感測器脫鉤", "variance_increase": "雜訊變大",
           "stuck_sensor": "讀值卡住", "stuck": "讀值卡住", "missing_block": "連續缺值", "out_of_historical_range": "超出歷史範圍", "outage_missing_rows": "整列缺失（斷線）",
           "outage_zero_rows": "整列歸零（斷電／斷線）"}
LIMITS = [
    "這是研究預測（探索性）：模型沒有經過獨立的前瞻驗證，留存測試期（Holdout）只是描述性診斷，不能當成準確度保證。",
    "所有預測都是『歷史時點模擬預測』：只用預測起點（含）以前的資料；這不是即時監控，也不控制任何設備。",
    "感測器單位是依欄位名稱與數值分布推測的，尚未經資料提供者確認。",
    "異常偵測輸出的是『候選事件』，不是故障判定；需要現場確認。",
]

app = FastAPI(title="AIDE Python API", version=VERSION, docs_url="/docs" if os.environ.get("AIDE_DOCS", "1") == "1" else None, redoc_url=None,
              openapi_url="/openapi.json" if os.environ.get("AIDE_DOCS", "1") == "1" else None)     # AIDE_DOCS=0（預設容器設定）時不對外提供 API 規格
if ORIGINS:
    app.add_middleware(CORSMiddleware, allow_origins=ORIGINS, allow_methods=["GET", "POST"], allow_headers=["X-API-Key", "Content-Type"], max_age=600)


# ------------------------------------------------------------------ 安全：金鑰、速率
_hits: dict[str, deque] = defaultdict(deque)


def guard(request: Request, x_api_key: str | None = Header(default=None)):
    if API_KEY and not hmac.compare_digest(x_api_key or "", API_KEY):
        raise HTTPException(401, "缺少或錯誤的 X-API-Key")
    ip = (request.client.host if request.client else "?")
    now = time.time()
    q = _hits[ip]
    while q and q[0] < now - 60:
        q.popleft()
    if len(q) >= RATE_PER_MIN:
        raise HTTPException(429, "請求太頻繁，請稍後再試")
    q.append(now)


def jsonable(o):
    if isinstance(o, dict):
        return {str(k): jsonable(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [jsonable(x) for x in o]
    if isinstance(o, pd.DataFrame):
        return jsonable(o.to_dict("records"))
    if isinstance(o, pd.Series):
        return jsonable(o.to_dict())
    if isinstance(o, (pd.Timestamp, datetime)):
        return None if pd.isna(o) else str(o)
    if isinstance(o, (np.bool_, bool)):
        return bool(o)
    if isinstance(o, (np.integer, int)):
        return int(o)
    if isinstance(o, (np.floating, float)):
        f = float(o)
        return f if math.isfinite(f) else None
    if o is None or isinstance(o, str):
        return o
    if isinstance(o, (np.ndarray,)):
        return jsonable(o.tolist())
    return str(o)


def ds_or_404(dataset_id: str) -> dict:
    d = DS.get(dataset_id)
    if d is None:
        raise HTTPException(404, f"沒有這個資料集：{dataset_id}。可用：{', '.join(DS)}")
    return d


# ------------------------------------------------------------------ 基本資訊
@app.get("/health")
def health():
    """不需金鑰。回報版本與資料雜湊，供網站啟動時檢查『API 與資料是否對得上』。"""
    return {"ok": True, "version": VERSION, "datasets": {k: v["original"]["sha256"] for k, v in DS.items()}, "auth_required": bool(API_KEY), "read_only": True, "live_writes_enabled": bool(ADMIN_KEY), "live_sim_enabled": bool(ADMIN_KEY) and ALLOW_SIM, "sim_feed": SIM_DAEMON,   # read_only＝/v1 的資料與預測端點唯讀；唯一會寫入的是 /v1/live/*，且必須有管理金鑰（live_writes_enabled）
            "libs": {"python": sys.version.split()[0], "pandas": pd.__version__, "numpy": np.__version__}}


@app.get("/v1/datasets", dependencies=[Depends(guard)])
def datasets():
    return [{"id": d["id"], "name": d["display_name"], "rows": d["time"]["rows"], "start": d["time"]["start"], "end": d["time"]["end"], "columns": len(d["columns"]),
             "forecast_tasks": sum(t["enabled"] for t in d["forecast_tasks"])} for d in DS.values()]


@app.get("/v1/datasets/{dataset_id}/series", dependencies=[Depends(guard)])
def series(dataset_id: str, columns: str = Query(..., description="逗號分隔的欄位名稱（最多 12 個）"), start: str | None = None, end: str | None = None,
           resample: str = Query("none", pattern="^(none|1D)$"), max_points: int = Query(3000, ge=10, le=5000)):
    d = ds_or_404(dataset_id)
    cols = [c for c in columns.split(",") if c]
    known = {c["key"] for c in d["columns"]}
    bad = [c for c in cols if c not in known]
    if bad or not cols or len(cols) > 12:
        raise HTTPException(422, f"欄位不合法或超過 12 個：{bad or cols}")
    with LOCK:
        df = AN.load_bundle(d["stem"])["df"]
    df = AN.slice_range(df, start, end)
    if resample == "1D":
        df = df.set_index("timestamp")[cols].resample("1D").mean().reset_index()
    elif len(df) > max_points:
        df = df.iloc[np.linspace(0, len(df) - 1, max_points).astype(int)]
    return jsonable({"dataset_id": dataset_id, "data_kind": "real", "timestamps": df["timestamp"].astype(str).tolist(), "series": {c: df[c].tolist() for c in cols}, "n": len(df)})


@app.get("/v1/datasets/{dataset_id}/quality", dependencies=[Depends(guard)])
def quality(dataset_id: str):
    d = ds_or_404(dataset_id)
    with LOCK:
        q = AN.load_bundle(d["stem"])["quality"]
    return jsonable({"dataset_id": dataset_id, "data_kind": "real", "timestamp": q["timestamp"], "mean_observed_frac": q["mean_observed_frac"], "sensors": q["sensors"],
                     "flagged_runs": q["runs"].head(60), "outlier_candidates": q["outliers"].head(60), "all_zero_rows": q["all_zero_rows"],
                     "note": "離群值與卡值是『候選』，需要現場確認；零值是否正常依感測器意義而定。"})


@app.get("/v1/datasets/{dataset_id}/anomalies", dependencies=[Depends(guard)])
def anomalies(dataset_id: str, limit: int = Query(80, ge=1, le=300)):
    d = ds_or_404(dataset_id)
    with LOCK:
        b = AN.load_bundle(d["stem"])
        g = PR.grid(b)
        r = ANOM.analyze(g, d["stem"])
    ev = r["events"].copy()
    if len(ev):
        ev["kind_zh"] = ev["kind"].map(lambda k: KIND_ZH.get(k, k))
        ev["hours"] = ((ev["end"] - ev["start"]).dt.total_seconds() / 3600 + 1).round().astype(int)
        ev = ev.sort_values("score", ascending=False)
    return jsonable({"dataset_id": dataset_id, "data_kind": "real", "n_events": int(len(ev)), "events": ev.head(limit), "disclaimer": r["disclaimer"], "limits": LIMITS})


# ------------------------------------------------------------------ 預測（既有 HGB／XGBoost＋基準方法）
@app.get("/v1/forecast/tasks", dependencies=[Depends(guard)])
def forecast_tasks(dataset_id: str | None = None):
    out = []
    for d in DS.values():
        if dataset_id and d["id"] != dataset_id:
            continue
        for t in d["forecast_tasks"]:
            ok, why = E.policy(t["task_id"])
            out.append({"dataset_id": d["id"], "task_id": t["task_id"], "sensor": t["sensor"], "horizon_h": t["horizon_h"], "enabled": bool(ok), "notes": "；".join(why)})
    return out


class ForecastReq(BaseModel):
    dataset_id: str
    sensor: str
    horizon_h: int = Field(ge=1, le=6)
    origin: str | None = Field(default=None, description="預測起點（整點，例如 2026-08-10 12:00:00）；省略＝資料最後一個可用的起點")
    history_hours: int = Field(default=72, ge=6, le=168)


def forecast_payload(d: dict, sensor: str, h: int, origin: str | None, history_hours: int = 72) -> dict:
    stem = d["stem"]
    task = E.make_task_id(stem, sensor, h)
    ok, why = E.policy(task) if task in {t["task_id"] for t in d["forecast_tasks"]} else (False, [f"沒有這個預測任務：{task}"])
    if not ok:
        raise HTTPException(422, "；".join(why))
    opts = E.origin_options(task)
    t = pd.Timestamp(origin) if origin else opts[-1]
    if t not in opts:
        raise HTTPException(422, f"{t} 不是可用的預測起點（需要自己的 25 小時歷史完整）。可用範圍：{opts[0]} ~ {opts[-1]}")
    try:
        r = E.forecast(task, t)
    except E.ForecastRefused as e:
        raise HTTPException(422, str(e)) from e
    ev = E.evaluate(task)
    models = {}
    for k in E.MODEL_ORDER:
        p = r["predictions"].get(k, {"refused": "沒有這個模型的預測"})
        m = ev["metrics"].get(k)
        item = {"label": E.MODEL_ZH[k], "kind": "ml" if k in E.FAMILIES else "baseline", "value": p.get("value"), "refused": p.get("refused"),
                "version": r["versions"].get(k), "variant": ev["variants"].get(k),
                "validation": m and {"n": m["validation"]["n"], "MAE": m["validation"]["MAE"], "RMSE": m["validation"]["RMSE"]},
                "holdout": m and {"n": m["holdout"]["n"], "MAE": m["holdout"]["MAE"], "RMSE": m["holdout"]["RMSE"]}}
        if k in E.FAMILIES:
            item["evidence"] = E.evidence_text(task, k)
            item["evidence_flags"] = ev["evidence"][k]
        if item["value"] is not None and k in E.FAMILIES:
            iv = E.interval(task, k, t)
            item["interval"] = {"shown": bool(iv.get("shown")), "reason": iv.get("reason", ""), "status": iv.get("status"), "target_coverage": iv.get("target"),
                                "lower": item["value"] - iv["q"] if iv.get("shown") else None, "upper": item["value"] + iv["q"] if iv.get("shown") else None,
                                "holdout_coverage": iv.get("holdout_coverage"), "undercoverage_warning": iv.get("undercoverage")}
        models[k] = item
    hist = E.history(task, t, history_hours)
    fut = E.future_actual(task, t)
    return jsonable({
        "data_kind": "real", "mode": r["mode"], "dataset_id": d["id"], "task_id": task, "sensor": sensor, "horizon_h": h, "unit": r["unit"], "unit_status": r["unit_status"],
        "forecast_origin": r["forecast_origin"], "target_timestamp": r["target_timestamp"], "last_observation_time": r["last_observation_time"],
        "last_observation_value": r["last_observation_value"], "actual_at_target": r["actual"], "period": r["period"], "period_zh": r["period_zh"],
        "best_baseline": ev["best_baseline"], "models": models, "history": hist, "future_actual": fut, "origin_range": [opts[0], opts[-1]],
        "research_status": r["research_status"], "artifact_sha256": r["artifact_sha256"], "limits": LIMITS,
        "no_claim": "這裡不宣稱任何準確度；留存測試期（Holdout）不是獨立驗證。"})


@app.post("/v1/forecast", dependencies=[Depends(guard)])
def forecast(req: ForecastReq):
    d = ds_or_404(req.dataset_id)
    with LOCK:
        return forecast_payload(d, req.sensor, req.horizon_h, req.origin, req.history_hours)


# ------------------------------------------------------------------ 羊舍 THI 正式模型（Phase 2.5／2.6／3；保持原樣）
class FormalReq(BaseModel):
    as_of: str | None = Field(default=None, description="預測時間點（整點）；省略＝資料最後一筆")
    mode: str = Field(default="strict", pattern="^(strict|full)$", description="strict＝只用『當時已經存在』的凍結模型（嚴格歷史回測）；full＝全資料模型（只供示範，樣本內）")


@app.post("/v1/formal/sheep-thi", dependencies=[Depends(guard)])
def formal_sheep(req: FormalReq):
    import model_registry as MR
    import phase26_predict as P26
    from load_data import load_sensor_csv
    with LOCK:
        df, _ = load_sensor_csv(HERE / "data" / "raw" / "羊舍.csv")
        reg = MR.ModelRegistry()
        t = pd.Timestamp(req.as_of) if req.as_of else df["timestamp"].max()
        if req.mode == "strict":
            mv = reg.eligible(t)
            if mv is None:
                raise HTTPException(422, f"{t} 之前沒有任何『當時已存在』的凍結模型（最早 {reg.first_eligible_time()}）。依協定不改用全資料模型。")
        else:
            mv = reg.full
        bundle = reg.load(mv)
        out = P26.predict26(df, bundle, as_of=t)
    in_sample = bool(reg.is_in_sample(mv, t))
    return jsonable({"data_kind": "real", "dataset_id": "sheep_barn", "target": "成羊區THI", "horizon_h": 3, "as_of": t, "mode": req.mode, "model_version": mv.version,
                     "train_until": mv.train_until, "in_sample": in_sample, "result": out,
                     "warnings": (["這個時間點落在模型的訓練期間內（樣本內）：不能當成預測能力的證據。"] if in_sample else []) + (["full 模式使用全資料模型：只供示範。"] if req.mode == "full" else []),
                     "limits": LIMITS, "no_claim": "不宣稱準確度；這是歷史回放，不是即時系統。84 是候選警戒值，不是 JNC 確認的標準。"})


# ------------------------------------------------------------------ 決策輔助（唯讀；規則層 + 證據；不含任何預測以外的新模型）
@app.get("/v1/decision-support/{dataset_id}", dependencies=[Depends(guard)])
def decision_support(dataset_id: str):
    """七場域通用的決策輔助：證據（可追溯）→ 分層建議（一般／需人工確認／正式風險）→ 可信程度與限制。
    不產生任何新的預測、門檻或控制指令；Gemini 的白話改寫在 Node 端，且不得更動這裡的層級、可信程度與限制。"""
    d = ds_or_404(dataset_id)
    with LOCK:
        bundle = DSC.collect(sys.modules[__name__], d, datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
    try:
        return jsonable(DSR.build(bundle))
    except AssertionError as e:
        raise HTTPException(500, str(e)[:300])


# ------------------------------------------------------------------ 即時管線（Phase 6.5）：資料進來 → 驗證 → 版本庫 → 自動重算預測 → 監測
LIVE = LiveService(LIVE_ROOT, CATALOG)
FEED = SimFeed(LIVE, SIM_HOURS)


def admin_guard(request: Request, x_admin_key: str | None = Header(default=None)):
    """寫入類端點：需要 X-API-Key（若設定）＋獨立的 X-Admin-Key。沒設定 AIDE_ADMIN_KEY ＝ 寫入功能整個停用。"""
    guard(request, request.headers.get("x-api-key"))
    if not ADMIN_KEY:
        raise HTTPException(403, "管理金鑰未設定（AIDE_ADMIN_KEY）：寫入功能停用")
    if not hmac.compare_digest(x_admin_key or "", ADMIN_KEY):
        raise HTTPException(401, "缺少或錯誤的 X-Admin-Key")


def _live(did: str):
    ds_or_404(did)
    return LIVE


def _who(v: str | None) -> str:
    v = "".join(ch for ch in (v or "admin-api") if ch.isalnum() or ch in "-_.@ ")[:40].strip()
    return v or "admin-api"


@app.get("/v1/live/domains", dependencies=[Depends(guard)])
def live_domains():
    with LOCK:
        return jsonable([{k: v for k, v in LIVE.status(d).items() if k in ("dataset_id", "current_seq", "data_end", "freshness", "staleness_h", "health", "flags", "forecast", "mode", "latest_source")} for d in DS])


@app.get("/v1/live/{dataset_id}/status", dependencies=[Depends(guard)])
def live_status(dataset_id: str, verify: bool = False):
    with LOCK:
        return jsonable(_live(dataset_id).status(dataset_id, verify=verify))


@app.get("/v1/live/{dataset_id}/forecast", dependencies=[Depends(guard)])
def live_forecast(dataset_id: str):
    with LOCK:
        r = _live(dataset_id).latest(dataset_id)
    if r is None:
        raise HTTPException(404, "還沒有產生過預測（尚無資料版本或尚未重算）")
    return r


@app.get("/v1/live/{dataset_id}/forecast/log", dependencies=[Depends(guard)])
def live_forecast_log(dataset_id: str, limit: int = Query(200, ge=1, le=2000)):
    return jsonable(_live(dataset_id).forecast_log(dataset_id, limit))


@app.get("/v1/live/{dataset_id}/monitor", dependencies=[Depends(guard)])
def live_monitor(dataset_id: str):
    with LOCK:
        return jsonable(_live(dataset_id).monitor(dataset_id))


@app.get("/v1/live/{dataset_id}/versions", dependencies=[Depends(guard)])
def live_versions(dataset_id: str):
    with LOCK:
        return jsonable(_live(dataset_id).versions(dataset_id))


@app.get("/v1/live/{dataset_id}/pending", dependencies=[Depends(guard)])
def live_pending(dataset_id: str):
    with LOCK:
        return jsonable(_live(dataset_id).pending(dataset_id))


@app.get("/v1/live/{dataset_id}/events", dependencies=[Depends(guard)])
def live_events(dataset_id: str, limit: int = Query(100, ge=1, le=1000)):
    return jsonable(_live(dataset_id).events(dataset_id, limit))


class IngestReq(BaseModel):
    filename: str = Field(min_length=1, max_length=120)
    source: str = Field(pattern="^(synthetic|unverified_import)$")
    license_note: str = Field(min_length=1, max_length=500, description="來源與授權說明（可寫 UNVERIFIED）")
    csv_text: str = Field(min_length=1)
    policy: str | None = Field(default=None, pattern="^(keep_existing|prefer_new|reject)$")
    auto_commit: bool = True
    approved_by: str | None = None


class CommitReq(BaseModel):
    upload_id: str = Field(pattern="^up-[0-9a-f]{12}$")
    approved_by: str | None = None
    notes: str = Field(default="", max_length=300)


class RollbackReq(BaseModel):
    to_seq: int = Field(ge=0)
    reason: str = Field(default="", max_length=300)
    approved_by: str | None = None


class SimTickReq(BaseModel):
    hours: int = Field(default=SIM_HOURS, ge=1, le=72)
    scenario: str | None = Field(default=None, pattern="^(normal|missing|stuck_sensor|outage|short_event|slow_drift|calibration_step|duplicate|mixed)$")


def _live_call(fn):
    try:
        with LOCK:
            return jsonable(fn())
    except LiveError as e:
        raise HTTPException(422, str(e)[:300])
    except Exception as e:  # noqa: BLE001
        if e.__class__.__name__ in ("StoreError", "StoreBusy", "StoreCorrupt"):
            raise HTTPException(409 if e.__class__.__name__ == "StoreBusy" else 422, str(e)[:300])
        raise


@app.post("/v1/live/{dataset_id}/ingest", dependencies=[Depends(admin_guard)])
def live_ingest(dataset_id: str, req: IngestReq):
    raw = req.csv_text.encode("utf-8")
    if len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, f"檔案超過上限 {MAX_UPLOAD_BYTES} 位元組")
    return _live_call(lambda: _live(dataset_id).ingest(dataset_id, raw, req.filename, req.source, req.license_note, _who(req.approved_by), req.policy, req.auto_commit))


@app.post("/v1/live/{dataset_id}/commit", dependencies=[Depends(admin_guard)])
def live_commit(dataset_id: str, req: CommitReq):
    return _live_call(lambda: _live(dataset_id).commit_pending(dataset_id, req.upload_id, _who(req.approved_by), req.notes))


@app.post("/v1/live/{dataset_id}/rollback", dependencies=[Depends(admin_guard)])
def live_rollback(dataset_id: str, req: RollbackReq):
    return _live_call(lambda: _live(dataset_id).rollback(dataset_id, req.to_seq, _who(req.approved_by), req.reason))


@app.post("/v1/live/{dataset_id}/recompute", dependencies=[Depends(admin_guard)])
def live_recompute(dataset_id: str):
    return _live_call(lambda: _live(dataset_id).recompute(dataset_id, reason="manual")["summary"])


@app.post("/v1/live/{dataset_id}/sim/tick", dependencies=[Depends(admin_guard)])
def live_sim_tick(dataset_id: str, req: SimTickReq):
    if not ALLOW_SIM:
        raise HTTPException(403, "模擬資料流未啟用（AIDE_ALLOW_SIM=1）")
    return _live_call(lambda: FEED.tick(dataset_id, req.hours, req.scenario))


def _sim_daemon():
    """背景模擬資料流：每隔 SIM_INTERVAL_S 秒，每個場域各推進 SIM_HOURS 小時。任何錯誤只記錄、不中斷。"""
    import logging
    import threading
    log = logging.getLogger("aide.live")

    def loop():
        n = 0
        while True:
            for did in list(DS):
                try:
                    with LOCK:
                        FEED.tick(did, SIM_HOURS, None, approver="sim-daemon")
                except Exception as e:  # noqa: BLE001
                    log.error("sim tick failed: %s %s", did, e.__class__.__name__)
            n += 1
            time.sleep(max(1.0, SIM_INTERVAL_S))

    threading.Thread(target=loop, name="aide-sim-feed", daemon=True).start()


if SIM_DAEMON:
    _sim_daemon()
