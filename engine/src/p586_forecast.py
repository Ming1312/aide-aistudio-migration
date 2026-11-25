"""
p586_forecast.py — Phase 5.8.6：既有研究模型在『追加資料』上的預測、適用性檢查與全模型比較

原則
  * 只載入『既有』研究 artifact（outputs/phase5_8_2/artifacts；雜湊與 manifest 驗證）；不重新訓練、不改參數、不新增模型、不寫入 models/。
  * 預測特徵由截斷到起點的資料現算（與 p582_engine.features_at 相同公式；有『等價測試』對照）。
  * 每次預測都附『適用性評估』：模型訓練期、資料陳舊度、輸入分布與訓練期的差距、起點附近的候選異常事件（只用起點當下已被偵測的事件，不偷看未來）、
    資料是否含合成列。不適用就明確警告；絕不自動宣稱準確度。
  * 在追加資料上算出的誤差只是『系統穩定性檢查』，**不是**模型效能驗證證據（合成資料不能證明真實世界的表現）。
"""
from __future__ import annotations

from functools import lru_cache

import numpy as np
import pandas as pd

import p56_core as CO
import p582_engine as E
import p586_analysis as AN6
import p586_store as ST

MODELS = E.MODEL_ORDER
SYNTH_BANNER = "此預測使用的資料含合成（模擬）列：只是系統流程測試，不是真實預測，更不能當作模型表現的證據。"
NO_CLAIM = "這裡不宣稱任何準確度：追加資料不是獨立驗證集，且模型從未在這段資料上被驗證過。"
SHIFT_Z = 3.0
OUT_FRAC = 0.5
STALE_DAYS = 60
KIND_ZH = {"short_event": "短暫突波", "level_shift": "持續偏離", "drift": "緩慢漂移", "relation_decoupling": "與其他感測器脫鉤", "variance_increase": "雜訊變大", "stuck_sensor": "讀值卡住", "missing_block": "連續缺值",
           "outage_missing_rows": "整列缺失（斷線）", "outage_zero_rows": "整列歸零（斷電／斷線）"}


def tasks(stem: str) -> list[str]:
    return E.enabled_tasks(stem)


@lru_cache(maxsize=64)
def _train_ref(task_id: str) -> dict:
    ctx = E.context(task_id)
    g, sp, target = ctx["g"], ctx["sp"], ctx["target"]
    tr = sp["train"]
    y = g[target].iloc[tr].dropna()
    F = (ctx["F1"] if ctx["use_f1"] else ctx["F0"]).iloc[tr]
    return {"train_end": g.index[tr[-1]], "train_start": g.index[tr[0]], "y_lo": float(y.quantile(0.005)), "y_hi": float(y.quantile(0.995)), "y_mean": float(y.mean()), "y_sd": float(y.std() or 1.0),
            "f_lo": F.quantile(0.005), "f_hi": F.quantile(0.995), "raw_data_sha": ctx["data_sha"]}


def active_artifact(store: ST.Store, task_id: str) -> dict:
    """這個版本庫目前啟用的模型版本（v0＝研究 artifact；重新訓練後人工啟用的版本）。損壞時 fail closed。"""
    import p589_registry as RG
    return RG.Registry(store).resolve(task_id)


def train_ref(store: ST.Store, task_id: str, art: dict | None = None) -> dict:
    """適用性與陳舊度用的訓練期參考量：v0 用研究期；重訓版本用它自己的 meta。"""
    art = art or active_artifact(store, task_id)
    if art.get("version", 0) == 0:
        return _train_ref(task_id)
    m = art["meta"]
    return {"train_end": pd.Timestamp(m["train_end"]), "train_start": pd.Timestamp(m["train_window"][0]), "y_lo": m["y_lo"], "y_hi": m["y_hi"], "y_mean": m["y_mean"], "y_sd": m["y_sd"],
            "f_lo": pd.Series(m["f_lo"]), "f_hi": pd.Series(m["f_hi"]), "raw_data_sha": None}


def features_at_ext(task_id: str, g: pd.DataFrame, origin, a_meta: dict) -> dict:
    """與 p582_engine.features_at 相同，但資料來自延伸資料格 g。只用起點（含）以前。"""
    stem, target, h = E.split_task(task_id)
    t = pd.Timestamp(origin)
    if t not in g.index:
        raise E.ForecastRefused(f"{t} 不在資料的每小時時間軸上。")
    gt = g.loc[t - pd.Timedelta(hours=72): t]
    F0 = CO.own_features(gt, target, 0, a_meta["use_dow"]).iloc[-1]
    F1 = pd.concat([CO.own_features(gt, target, 0, a_meta["use_dow"]), CO.cross_features(gt, a_meta["cross_sensors"], 0)], axis=1).iloc[-1] if a_meta["use_f1"] else None
    y_t = gt[target].iloc[-1]
    seas = None
    if h <= 24:
        tt = t + pd.Timedelta(hours=h - 24)
        seas = g.loc[tt, target] if tt in g.index and tt <= t else np.nan
    return {"F0": F0, "F1": F1, "y_t": float(y_t) if y_t == y_t else float("nan"), "seasonal": None if seas is None else float(seas)}


def predict_models(task_id: str, g: pd.DataFrame, origin, model_keys=MODELS, art: dict | None = None) -> dict:
    """各模型各自回傳 {value} 或 {refused: 原因}（不插補、不借用其他模型）。與 p582_engine.forecast 的邏輯逐步相同。"""
    ok, why = E.policy(task_id)
    if not ok:
        raise E.ForecastRefused("；".join(why))
    a = art if art is not None else E.load_artifact(task_id)
    fe = features_at_ext(task_id, g, origin, a["meta"])
    res = {}
    for k in model_keys:
        try:
            if k == "persistence":
                if fe["y_t"] != fe["y_t"]:
                    raise E.ForecastRefused("起點當下沒有讀值")
                res[k] = {"value": fe["y_t"]}
            elif k == "moving_average":
                v = fe["F0"]["roll_mean6"]
                if v != v:
                    raise E.ForecastRefused("起點以前 6 小時內有缺值")
                res[k] = {"value": float(v)}
            elif k == "seasonal_naive_24h":
                if not a["meta"]["seasonal_valid"]:
                    raise E.ForecastRefused("季節性基準在訓練期未通過有效性檢查（日週期不夠強），依凍結協定不使用")
                if fe["seasonal"] is None or fe["seasonal"] != fe["seasonal"]:
                    raise E.ForecastRefused("起點 24 小時前對應時刻沒有讀值")
                res[k] = {"value": fe["seasonal"]}
            else:
                names = a["meta"]["feature_names"][k]
                F = fe["F1"] if (k != "linear_ar4" and a["meta"]["variants"][k].endswith("F1") and fe["F1"] is not None) else fe["F0"]
                x = E._row(F, names)
                if x is None:
                    miss = [n for n in names if F[n] != F[n]]
                    raise E.ForecastRefused(f"起點以前的特徵不完整（缺 {', '.join(miss[:4])}{'…' if len(miss) > 4 else ''}）；不插補、不猜測")
                res[k] = {"value": float(a["models"][k].predict(x)[0])}
        except E.ForecastRefused as e:
            res[k] = {"refused": str(e)}
    return {"predictions": res, "features": fe, "artifact_sha256": a["sha256"], "variants": a["meta"]["variants"], "meta": a["meta"], "model_version": a.get("version", 0)}


# ============================================================ 適用性
def applicability(store: ST.Store, seq: int, task_id: str, origin, fe: dict | None = None, art: dict | None = None) -> dict:
    """回傳 {status: ok|caution|not_applicable, reasons: [{level, text}], facts: {...}}。規則式；沒有 LLM、沒有準確度宣稱。"""
    stem, target, h = E.split_task(task_id)
    t = pd.Timestamp(origin)
    g, src = AN6.grid(store, seq)
    ref = train_ref(store, task_id, art)
    reasons, facts = [], {}
    # 模型與資料版本
    stale = (t - ref["train_end"]) / pd.Timedelta(days=1)
    facts.update(model_trained_through=str(ref["train_end"]), data_version=store.version_id(seq), staleness_days=round(float(stale), 1))
    reasons.append({"level": "info", "category": "model_stale", "text": f"【模型過舊檢查】模型訓練於原始資料版本（{ref['train_start']:%Y-%m-%d} → {ref['train_end']:%Y-%m-%d}）；目前資料版本 {store.version_id(seq)}；起點距訓練期結束 {stale:.0f} 天。"})
    if stale > STALE_DAYS:
        reasons.append({"level": "caution", "category": "model_stale", "text": f"【模型過舊】模型比這個起點舊 {stale:.0f} 天（>{STALE_DAYS} 天）：季節或設備狀態可能已改變，預測不應被信任。"})
    # 輸入分布 vs 訓練期
    w = g.loc[t - pd.Timedelta(hours=23): t, target].dropna()
    if len(w):
        out_frac = float(((w < ref["y_lo"]) | (w > ref["y_hi"])).mean())
        z = float((w.mean() - ref["y_mean"]) / ref["y_sd"])
        facts.update(window_out_of_train_range_frac=round(out_frac, 3), window_mean_shift_in_train_sd=round(z, 2))
        if out_frac > OUT_FRAC:
            reasons.append({"level": "not_applicable", "category": "input_shift", "text": f"【輸入超出訓練範圍】起點前 24 小時有 {out_frac:.0%} 的讀值超出訓練期範圍：模型沒見過這種輸入，外推不可靠。"})
        elif abs(z) > SHIFT_Z:
            reasons.append({"level": "caution", "category": "input_shift", "text": f"【輸入分布偏移】起點前 24 小時平均與訓練期平均相差 {z:+.1f} 個訓練期標準差（>{SHIFT_Z:g}）：輸入分布已明顯偏移。"})
    if fe is not None:
        F = fe["F1"] if fe.get("F1") is not None else fe["F0"]
        lo, hi = ref["f_lo"], ref["f_hi"]
        common = [c for c in F.index if c in lo.index]
        bad = [c for c in common if F[c] == F[c] and (F[c] < lo[c] or F[c] > hi[c])]
        facts["features_out_of_train_range"] = len(bad)
        if common and len(bad) / len(common) > 0.5:
            reasons.append({"level": "caution", "category": "input_shift", "text": f"【輸入分布偏移】超過一半（{len(bad)}/{len(common)}）的特徵超出訓練期的 0.5–99.5% 範圍。"})
    # 起點當下『已偵測到』的候選警報（因果：detected_at ≤ 起點）；v2（p587_detect）依場域與感測器個別校準
    try:
        ev = AN6.alerts(store, seq)["alerts"]
    except FileNotFoundError:
        ev = pd.DataFrame(columns=["category", "kind", "column", "start", "end", "detected_at", "detector"])
    if len(ev):
        win0 = t - pd.Timedelta(hours=72)
        hit = ev[(ev["detected_at"] <= t) & (ev["end"] >= win0) & (ev["start"] <= t) & ev["column"].isin([target, "*"])]
        for r in hit.itertuples():
            lvl = "not_applicable" if r.kind in ("stuck_sensor", "outage_zero_rows", "outage_missing_rows") else "caution"
            cat = "資料品質問題" if r.category == "data_quality" else "異常訊號"
            reasons.append({"level": lvl, "category": r.category, "text": f"【{cat}】起點前 72 小時內，偵測器已標出候選警報：{KIND_ZH.get(r.kind, r.kind)}（{r.kind}；{r.start:%m-%d %H:%M} → {r.end:%m-%d %H:%M}）。輸入可能不可信。"})
        facts["detected_events_in_window"] = int(len(hit))
    # 來源
    s = src.loc[t - pd.Timedelta(hours=72): t]
    synth = int(s.isin(["synthetic"]).sum())
    facts["synthetic_rows_in_window"] = synth
    if synth:
        reasons.append({"level": "synthetic", "category": "synthetic", "text": SYNTH_BANNER})
    level = "ok"
    if any(r["level"] == "caution" for r in reasons):
        level = "caution"
    if any(r["level"] == "not_applicable" for r in reasons):
        level = "not_applicable"
    return {"status": level, "reasons": reasons, "facts": facts, "claims": NO_CLAIM}


def origins(store: ST.Store, seq: int, task_id: str) -> pd.DatetimeIndex:
    """追加資料區的可用起點（目標有 25 小時完整歷史）。"""
    stem, target, h = E.split_task(task_id)
    g, _ = AN6.grid(store, seq)
    t0 = AN6.new_data_start(store, seq)
    if t0 is None:
        return pd.DatetimeIndex([])
    p = g[target].notna().astype(int)
    full = p.rolling(25, min_periods=25).sum() == 25
    return g.index[(g.index >= t0) & full.to_numpy()]


def latest_origin(store: ST.Store, seq: int | None, task_id: str):
    """目前資料版本中『最新的、目標有連續 25 小時歷史』的預測起點（目標時間在資料之後 → 前瞻預測）。沒有就回傳 None。"""
    seq = store.current_seq() if seq is None else int(seq)
    target = E.split_task(task_id)[1]
    g, _ = AN6.grid(store, seq)
    full = (g[target].notna().astype(int).rolling(25, min_periods=25).sum() == 25).to_numpy()
    idx = g.index[full]
    return idx[-1] if len(idx) else None


def forecast(store: ST.Store, seq: int | None, task_id: str, origin, model_keys=MODELS) -> dict:
    seq = store.current_seq() if seq is None else int(seq)
    g, src = AN6.grid(store, seq)
    t = pd.Timestamp(origin)
    art = active_artifact(store, task_id)
    r = predict_models(task_id, g, t, model_keys, art)
    stem, target, h = E.split_task(task_id)
    ap = applicability(store, seq, task_id, t, r["features"], art)
    tt = t + pd.Timedelta(hours=h)
    actual = float(g.loc[tt, target]) if tt in g.index and g.loc[tt, target] == g.loc[tt, target] else None
    last = g[target].loc[:t].dropna()
    return {"task_id": task_id, "domain": stem, "sensor": target, "horizon_h": h, "origin": t, "target_time": tt, "data_version": store.version_id(seq), "predictions": r["predictions"], "variants": r["variants"],
            "applicability": ap, "actual": actual, "last_observation": (last.index[-1], float(last.iloc[-1])) if len(last) else (None, None), "artifact_sha256": r["artifact_sha256"], "model_version": r["model_version"],
            "research_status": E.RESEARCH_STATUS, "claims": NO_CLAIM, "contains_synthetic": ap["facts"].get("synthetic_rows_in_window", 0) > 0}


def compare_all(store: ST.Store, seq: int | None, task_id: str, origin) -> dict:
    """一鍵比較所有適用模型：預測值、（若已有）實際值與誤差、適用性警告。誤差只是穩定性檢查。"""
    f = forecast(store, seq, task_id, origin)
    rows = []
    for k in MODELS:
        p = f["predictions"].get(k, {})
        v = p.get("value")
        rows.append({"model": k, "label": E.MODEL_ZH[k], "prediction": v, "refused": p.get("refused"), "abs_error": (abs(v - f["actual"]) if (v is not None and f["actual"] is not None) else None)})
    f["table"] = pd.DataFrame(rows)
    f["error_note"] = "誤差只是合成資料上的『穩定性檢查』，不是模型效能驗證；不得用來挑選或宣稱較佳模型。" if f["contains_synthetic"] else "此誤差只描述這一個時點，不是驗證。"
    return f


def replay(store: ST.Store, seq: int | None, task_id: str, max_origins: int = 96, stride: int | None = None) -> dict:
    """在追加資料區對多個起點重放預測（因果：每個起點只用起點以前的資料），回報各模型誤差與適用性分布。
    用途：檢查『流程在新資料上穩定運作、警告有出現』，不是效能驗證。"""
    seq = store.current_seq() if seq is None else int(seq)
    stem, target, h = E.split_task(task_id)
    og = origins(store, seq, task_id)
    g, _ = AN6.grid(store, seq)
    art = active_artifact(store, task_id)
    ok = [t for t in og if (t + pd.Timedelta(hours=h)) in g.index and g.loc[t + pd.Timedelta(hours=h), target] == g.loc[t + pd.Timedelta(hours=h), target]]
    if not ok:
        return {"task_id": task_id, "n_origins": 0, "table": pd.DataFrame(), "summary": pd.DataFrame(), "applicability": {}, "claims": NO_CLAIM}
    stride = stride or max(1, len(ok) // max_origins)
    ok = ok[::stride][:max_origins]
    recs, status = [], []
    for t in ok:
        r = predict_models(task_id, g, t, art=art)
        ap = applicability(store, seq, task_id, t, r["features"], art)
        status.append(ap["status"])
        act = float(g.loc[t + pd.Timedelta(hours=h), target])
        for k, p in r["predictions"].items():
            recs.append({"origin": t, "model": k, "prediction": p.get("value"), "actual": act, "abs_error": abs(p["value"] - act) if "value" in p else np.nan, "applicability": ap["status"], "refused": p.get("refused")})
    tab = pd.DataFrame(recs)
    common = tab.groupby("origin")["abs_error"].apply(lambda s: s.notna().all())
    use = tab[tab["origin"].isin(common[common].index)]
    summ = use.groupby("model").agg(n=("abs_error", "size"), MAE=("abs_error", "mean")).reindex([m for m in MODELS if m in use["model"].unique()]).reset_index() if len(use) else pd.DataFrame()
    return {"task_id": task_id, "n_origins": int(len(ok)), "n_common": int(common.sum()), "table": tab, "summary": summ, "applicability": pd.Series(status).value_counts().to_dict(),
            "claims": NO_CLAIM, "note": "穩定性檢查：流程是否在新資料上正常執行；不是效能驗證。"}
