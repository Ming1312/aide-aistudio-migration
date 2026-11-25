"""
decision_support/collect.py — 向『既有引擎』收集證據包（不訓練、不改任何引擎輸出、唯讀）。

證據包的每一塊都是引擎既有函式的原樣輸出：
  quality    p55_analysis.load_bundle(stem)["quality"]（缺漏、零值、卡值區段）
  anomalies  p586_anomaly.analyze（候選事件；與 /v1/datasets/{id}/anomalies 同一來源）
  forecasts  p582_engine.evaluate（基準與 HGB／XGBoost 的驗證／留存誤差、探索性訊號旗標）
  formal     羊舍：model_registry＋phase26_predict 的嚴格回放最新一筆（與 /v1/formal/sheep-thi 同一來源）
"""
from __future__ import annotations

import math
from datetime import datetime

import numpy as np
import pandas as pd


def _clean(o):
    if isinstance(o, dict):
        return {str(k): _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_clean(v) for v in o]
    if isinstance(o, pd.DataFrame):
        return _clean(o.to_dict("records"))
    if isinstance(o, (pd.Timestamp, datetime)):
        return str(o)
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating, float)):
        f = float(o)
        return f if math.isfinite(f) else None
    if isinstance(o, (np.bool_,)):
        return bool(o)
    return o


def quality_bundle(AN, stem: str) -> dict:
    q = AN.load_bundle(stem)["quality"]
    return _clean({"timestamp": q["timestamp"], "mean_observed_frac": q["mean_observed_frac"], "sensors": q["sensors"], "runs": q["runs"]})


def anomalies_bundle(M, dataset_id: str) -> dict:
    r = M.anomalies(dataset_id, limit=120)      # 與離線預計算（anomalies.json）及異常頁同一份清單：引擎依分數排序的前 120 筆
    return _clean(r)


def task_summary(E, d: dict, t: dict) -> dict:
    tid = t["task_id"]
    ev = E.evaluate(tid)
    opts = E.origin_options(tid)
    cls = E.context(tid).get("classification")
    return _clean({"task_id": tid, "dataset_id": d["id"], "sensor": t["sensor"], "horizon_h": t["horizon_h"], "unit": getattr(cls, "unit", "?"), "unit_status": getattr(cls, "unit_verification_status", "UNVERIFIED"),
                   "best_baseline": ev["best_baseline"], "evidence_flags": {k: ev["evidence"][k] for k in E.FAMILIES}, "origin_range": [str(opts[0]), str(opts[-1])]})


def forecasts_bundle(E, d: dict) -> dict:
    return {t["task_id"]: task_summary(E, d, t) for t in d["forecast_tasks"] if t["enabled"]}


def formal_latest(M, HERE) -> dict | None:
    """羊舍嚴格回放的最新一筆（只用『當時已存在』的凍結模型）。形狀與 formal_sheep.json 的 rows[i] 相同。"""
    import model_registry as MR
    import phase26_predict as P26
    from load_data import load_sensor_csv
    df, _ = load_sensor_csv(HERE / "data" / "raw" / "羊舍.csv")
    reg = MR.ModelRegistry()
    t = df["timestamp"].max()
    mv = reg.eligible(t)
    if mv is None:
        return None
    out = P26.predict26(df, reg.load(mv), as_of=t)
    return {"as_of": str(t), "model_version": mv.version, "in_sample": bool(reg.is_in_sample(mv, t)), "result": M.jsonable(out)}


def collect(M, d: dict, generated_at: str) -> dict:
    """M＝main 模組（取得 anomalies／jsonable／E／AN／HERE／VERSION）。"""
    from . import rules  # noqa: F401
    stem = d["stem"]
    reg = rules.REGISTRY["domains"].get(d["id"], {})
    bundle = {"dataset": {"id": d["id"], "display_name": d["display_name"], "time": d["time"], "forecast_tasks": d["forecast_tasks"]},
              "quality": quality_bundle(M.AN, stem), "anomalies": anomalies_bundle(M, d["id"]), "forecasts": forecasts_bundle(M.E, d),
              "formal": formal_latest(M, M.HERE) if reg.get("formal_engine") else None,
              "engine_version": M.VERSION, "generated_at": generated_at,
              "sources": {"quality": "引擎 quality（p55_analysis）", "anomalies": "引擎 anomalies（p586_anomaly）", "forecasts": "引擎 evaluate（p582_engine）",
                          "formal": "引擎 formal（model_registry＋phase26_predict，嚴格回放）", "catalog": "catalog.json"}}
    return bundle
