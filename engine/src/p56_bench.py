"""
p56_bench.py — Phase 5.6C：統一的時間序列 Benchmark（Baselines＋HGB＋XGBoost；時間順序切分；所有模型在同一批共同評估點上比較）

規則全部來自凍結的 PROTOCOL（p56_core）。這個模組不調參數、不搜尋、不新增模型；Holdout 只報告一次作為確認，不用來選擇。
輸出的每個數字都由程式現算；結果以任務為單位存成可恢復的 JSON（outputs/phase5_6/runs/）。
"""
from __future__ import annotations

import hashlib
import json
import math
import sys
import time
import warnings
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))

import p56_core as CO  # noqa: E402

warnings.filterwarnings("ignore")
P = CO.PROTOCOL
RUNS = CO.OUT / "runs"
BASELINES = ("persistence", "moving_average", "seasonal_naive_24h", "linear_ar4")
ML_VARIANTS = (("HGB", "F0"), ("HGB", "F1"), ("XGB", "F0"), ("XGB", "F1"))


# ------------------------------------------------------------------------------ 指標
def metrics(y: np.ndarray, p: np.ndarray, train_std: float) -> dict:
    e = p - y
    mae = float(np.mean(np.abs(e)))
    return {"n": int(len(y)), "MAE": mae, "RMSE": float(math.sqrt(np.mean(e ** 2))), "Bias": float(np.mean(e)), "scaled_MAE": mae / train_std if train_std > 0 else float("nan")}


def rel_improvement(base_mae: float, model_mae: float, train_std: float) -> tuple[float, str]:
    """(基準 MAE − 模型 MAE) / 基準 MAE。基準 MAE 太接近 0（相對於訓練標準差）時，百分比不穩定：回傳 NaN 並標示。"""
    if not (base_mae == base_mae) or train_std <= 0 or base_mae < P["recommendation_rules"]["unstable_baseline_mae_over_train_std"] * train_std:
        return float("nan"), "UNSTABLE_BASELINE"
    return (base_mae - model_mae) / base_mae, ""


# ------------------------------------------------------------------------------ 模型
def make_model(name: str):
    spec = P["models"][name]
    if name == "HGB":
        from sklearn.ensemble import HistGradientBoostingRegressor
        return HistGradientBoostingRegressor(**spec["params"])
    import xgboost as xgb
    return xgb.XGBRegressor(**spec["params"])


def select_cross(g: pd.DataFrame, pool: list[str], target: str, h: int, train_origins: np.ndarray, delay: int) -> list[str]:
    """只用『訓練 origin』挑同場域交叉特徵：訓練期觀測比例 ≥ 0.9，依 |Spearman(特徵(t), 目標(t+h))| 取前 8。"""
    if len(train_origins) < 50:
        return []
    y = g[target].to_numpy(float)
    yt = y[train_origins + h]
    scores = []
    for c in pool:
        x = g[c].shift(delay).to_numpy(float)[train_origins]
        ok = ~np.isnan(x) & ~np.isnan(yt)
        if ok.mean() < P["cross_min_train_obs_frac"] or ok.sum() < 50:
            continue
        a, b = pd.Series(x[ok]).rank().to_numpy(), pd.Series(yt[ok]).rank().to_numpy()
        if a.std() == 0 or b.std() == 0:
            continue
        scores.append((abs(float(np.corrcoef(a, b)[0, 1])), c))
    scores.sort(key=lambda s: (-s[0], pool.index(s[1])))
    return [c for _, c in scores[:P["max_cross_sensors"]]]


def seasonal_valid(g: pd.DataFrame, target: str, train_end_index: int) -> tuple[bool, dict]:
    """季節性基準是否有效：只看『訓練期』的資料（hour-of-day η²、gap-aware ACF(24)）。"""
    from p56_profile import acf_gap_aware, eta_squared
    x = g[target].to_numpy(float)[: train_end_index + 1]
    eta = eta_squared(x, g.index.hour.to_numpy()[: train_end_index + 1])
    ac, _ = acf_gap_aware(x, 24)
    ok = bool(eta == eta and ac == ac and eta >= P["seasonal_valid_eta2"] and ac >= P["seasonal_valid_acf24"])
    return ok, {"eta2_train": eta, "acf24_train": ac}


# ------------------------------------------------------------------------------ 單一任務
def run_on_frame(g: pd.DataFrame, target: str, h: int, pool: list[str], delay: int = 0, train_fraction_of_train: float = 1.0) -> dict:
    """g：等間隔（1h）、index 為時間、缺的時間點是 NaN 的 DataFrame。pool：可作交叉特徵的同場域欄位（已排除狀態碼／計數器／校正參數）。"""
    t0 = time.time()
    y = g[target].to_numpy(float)
    span_days = (g.index.max() - g.index.min()) / pd.Timedelta(days=1)
    use_dow = span_days >= P["dow_min_span_days"]
    F0 = CO.own_features(g, target, delay, use_dow)
    base_ok = CO.usable_mask(y, h, delay)

    def complete(cols_df):
        return ~cols_df.isna().any(axis=1).to_numpy()
    f0_ok = complete(F0)
    # 以 F0 的可用樣本做第一次切分，用訓練 origin 挑交叉特徵；若加入交叉特徵會讓共同評估點大幅減少，退回 F0
    origins0 = np.where(base_ok & f0_ok)[0]
    sp0 = CO.chrono_split(origins0, h)
    cross = select_cross(g, pool, target, h, sp0["train"], delay)
    F1 = pd.concat([F0, CO.cross_features(g, cross, delay)], axis=1) if cross else F0
    f1_ok = complete(F1)
    origins1 = np.where(base_ok & f0_ok & f1_ok)[0]
    sp1 = CO.chrono_split(origins1, h)
    use_f1 = bool(cross) and min(len(sp1["train"]), len(sp1["validation"]), len(sp1["holdout"])) >= P["eligibility"]["split_conditional"] and len(origins1) >= 0.5 * len(origins0)
    origins = origins1 if use_f1 else origins0
    sp = sp1 if use_f1 else sp0
    out = {"target": target, "horizon_h": h, "delay_h": delay, "n_origins_F0": int(len(origins0)), "n_origins_common": int(len(origins)), "f1_available": use_f1, "cross_sensors": cross if use_f1 else [],
           "split": {k: int(len(sp[k])) for k in ("train", "validation", "holdout")}}
    if min(len(sp["train"]), len(sp["validation"]), len(sp["holdout"])) < P["eligibility"]["split_conditional"]:
        return {**out, "status": "INSUFFICIENT_DATA", "reason": "共同評估點的 train／validation／holdout 其中之一少於 40"}
    ts = g.index
    out["periods"] = {s: [str(ts[sp[s][0]]), str(ts[sp[s][-1]])] for s in ("train", "validation", "holdout") if len(sp[s])}
    tr_all = sp["train"]
    if train_fraction_of_train < 1.0:
        tr_all = tr_all[int(len(tr_all) * (1 - train_fraction_of_train)):]
    ytrue_all = np.full(len(y), np.nan)
    ytrue_all[: len(y) - h] = y[h:]
    train_std = float(np.std(ytrue_all[sp["train"]]))
    out["train_std"] = train_std
    sv, sinfo = seasonal_valid(g, target, int(sp["train"][-1]) + h)
    out["seasonal_naive"] = {"valid": sv, **sinfo}
    yy = ytrue_all
    ysh = g[target].shift(delay).to_numpy(float)           # y[t-delay]

    def base_preds(idx, train_idx) -> dict:
        d = {"persistence": ysh[idx], "moving_average": F0["roll_mean6"].to_numpy()[idx]}
        if sv:
            d["seasonal_naive_24h"] = y[idx + h - 24]
        from sklearn.linear_model import Ridge
        cols = ["lag0", "lag1", "lag2", "lag3"]
        lin = Ridge(alpha=1.0).fit(F0[cols].to_numpy()[train_idx], yy[train_idx])
        d["linear_ar4"] = lin.predict(F0[cols].to_numpy()[idx])
        return d

    def fit_predict(variant, train_idx, test_idxs):
        name, fs = variant
        X = (F1 if (fs == "F1" and use_f1) else F0).to_numpy()
        m = make_model(name).fit(X[train_idx], yy[train_idx])
        return [m.predict(X[i]) for i in test_idxs]

    folds = CO.cv_folds(np.concatenate([sp["train"], sp["validation"]]), h)
    res = {"baselines": {}, "ml": {}}
    # --- final：train → validation / holdout
    bp_val, bp_hold = base_preds(sp["validation"], tr_all), base_preds(sp["holdout"], tr_all)
    for b in bp_val:
        res["baselines"][b] = {"validation": metrics(yy[sp["validation"]], bp_val[b], train_std), "holdout": metrics(yy[sp["holdout"]], bp_hold[b], train_std), "folds": []}
    for v in ML_VARIANTS:
        if v[1] == "F1" and not use_f1:
            continue
        pv, ph = fit_predict(v, tr_all, [sp["validation"], sp["holdout"]])
        res["ml"][f"{v[0]}-{v[1]}"] = {"validation": metrics(yy[sp["validation"]], pv, train_std), "holdout": metrics(yy[sp["holdout"]], ph, train_std), "folds": [], "_pv": pv, "_ph": ph}
    # --- rolling-origin CV（每折：挑交叉特徵只用該折的訓練 origin；基準與模型在同一折的同一批測試點）
    if train_fraction_of_train >= 1.0:
        for f in folds:
            tr_f, te_f = f["train"], f["test"]
            sv_f, _ = seasonal_valid(g, target, int(tr_f[-1]) + h) if len(tr_f) else (False, {})
            bpf = {"persistence": ysh[te_f], "moving_average": F0["roll_mean6"].to_numpy()[te_f]}
            if sv_f:
                bpf["seasonal_naive_24h"] = y[te_f + h - 24]
            from sklearn.linear_model import Ridge
            cols = ["lag0", "lag1", "lag2", "lag3"]
            bpf["linear_ar4"] = Ridge(alpha=1.0).fit(F0[cols].to_numpy()[tr_f], yy[tr_f]).predict(F0[cols].to_numpy()[te_f])
            tstd = float(np.std(yy[tr_f])) or 1.0
            for b, p in bpf.items():
                res["baselines"].setdefault(b, {"folds": []})["folds"].append({"fold": f["fold"], **metrics(yy[te_f], p, tstd), "train_std": tstd})
            cross_f = select_cross(g, pool, target, h, tr_f, delay) if use_f1 else []
            F1f = pd.concat([F0, CO.cross_features(g, cross_f, delay)], axis=1) if cross_f else F0
            ok_tr, ok_te = ~np.isnan(F1f.to_numpy()[tr_f]).any(axis=1), ~np.isnan(F1f.to_numpy()[te_f]).any(axis=1)
            for v in ML_VARIANTS:
                if v[1] == "F1" and not (use_f1 and cross_f):
                    continue
                X = (F1f if v[1] == "F1" else F0).to_numpy()
                trm = tr_f[ok_tr] if v[1] == "F1" else tr_f
                tem = te_f[ok_te] if v[1] == "F1" else te_f
                if len(trm) < 40 or len(tem) < 10:
                    continue
                pr = make_model(v[0]).fit(X[trm], yy[trm]).predict(X[tem])
                # 同一折的基準也要在同一批 tem 上評估（共同評估點）
                pos = np.isin(te_f, tem)
                res["ml"].setdefault(f"{v[0]}-{v[1]}", {"folds": []})["folds"].append({"fold": f["fold"], **metrics(yy[tem], pr, tstd), "train_std": tstd,
                                                                                      "baseline_maes_on_same_points": {b: float(np.mean(np.abs(bpf[b][pos] - yy[tem]))) for b in bpf}})
    # --- 選擇（只用 validation）與推薦規則
    valid_b = list(bp_val.keys())
    best_b = min(valid_b, key=lambda b: res["baselines"][b]["validation"]["MAE"])
    ml_names = [k for k, v in res["ml"].items() if "validation" in v]
    best_ml = min(ml_names, key=lambda k: res["ml"][k]["validation"]["MAE"]) if ml_names else None
    bb_val, bb_hold = res["baselines"][best_b]["validation"]["MAE"], res["baselines"][best_b]["holdout"]["MAE"]
    per_val, per_hold = res["baselines"]["persistence"]["validation"]["MAE"], res["baselines"]["persistence"]["holdout"]["MAE"]
    for k, v in res["ml"].items():
        if "validation" not in v:
            continue
        v["rel_vs_persistence"] = {s: rel_improvement(res["baselines"]["persistence"][s]["MAE"], v[s]["MAE"], train_std)[0] for s in ("validation", "holdout")}
        v["rel_vs_best_valid_baseline"] = {s: rel_improvement(res["baselines"][best_b][s]["MAE"], v[s]["MAE"], train_std)[0] for s in ("validation", "holdout")}
    for b, v in res["baselines"].items():
        if "validation" in v:
            v["rel_vs_persistence"] = {s: rel_improvement(res["baselines"]["persistence"][s]["MAE"], v[s]["MAE"], train_std)[0] for s in ("validation", "holdout")}
    decision, why = _decide(res, best_b, best_ml, train_std)
    if train_fraction_of_train < 1.0:
        decision, why = "SENSITIVITY_ONLY", "訓練量敏感度分析：不做 CV，不產生推薦；" + why
    out.update({"status": "OK", "best_valid_baseline": best_b, "best_ml": best_ml, "decision": decision, "decision_reason": why, "results": _strip(res)})
    # 預測值（供圖表：validation／holdout 的實際值、持續性、最佳基準、最佳 ML）
    pred = []
    for s in ("validation", "holdout"):
        idx = sp[s]
        pb = (bp_val if s == "validation" else bp_hold)
        row = pd.DataFrame({"origin_time": ts[idx], "target_time": ts[idx + h], "split": s, "actual": yy[idx], "persistence": pb["persistence"], "best_baseline": pb[best_b]})
        if best_ml:
            row["best_ml"] = res["ml"][best_ml]["_pv" if s == "validation" else "_ph"]
        pred.append(row)
    out["_predictions"] = pd.concat(pred, ignore_index=True)
    out["high_error"] = _high_error(out["_predictions"], best_b, best_ml, yy[sp["train"]])
    out["runtime_s"] = round(time.time() - t0, 2)
    return out


def _strip(res: dict) -> dict:
    return {"baselines": res["baselines"], "ml": {k: {kk: vv for kk, vv in v.items() if not kk.startswith("_")} for k, v in res["ml"].items()}}


def _decide(res: dict, best_b: str, best_ml: str | None, train_std: float) -> tuple[str, str]:
    R = P["recommendation_rules"]
    if best_ml is None:
        return "INSUFFICIENT_DATA", "沒有可評估的 ML 變體"
    m = res["ml"][best_ml]
    bv = res["baselines"][best_b]["validation"]["MAE"]
    rv, flag = rel_improvement(bv, m["validation"]["MAE"], train_std)
    if flag:
        return "BASELINE_RECOMMENDED", f"基準 MAE 相對於訓練標準差過小（{flag}），改用基準；不使用不穩定的百分比"
    wins = 0
    nf = 0
    for f in m["folds"]:
        nf += 1
        bmin = min(f["baseline_maes_on_same_points"].values())
        wins += int(f["MAE"] < bmin)
    rh = m["rel_vs_best_valid_baseline"]["holdout"]
    ok = rv >= R["min_ml_gain"] and nf >= 3 and wins >= 2 and (rh == rh and rh >= 0)
    why = f"{best_ml}：validation 相對最佳基準（{best_b}）{rv:+.1%}；CV 勝 {wins}/{nf} 折；holdout {rh:+.1%}" if rh == rh else f"{best_ml}：validation {rv:+.1%}；CV 勝 {wins}/{nf}；holdout 不可計算"
    return ("ML_CANDIDATE" if ok else "BASELINE_RECOMMENDED"), why + ("" if ok else "（未同時達到預先登記的三項條件，保留基準）")


def _high_error(pred: pd.DataFrame, best_b: str, best_ml: str | None, train_y: np.ndarray) -> dict:
    h = pred[pred["split"] == "holdout"].copy()
    if len(h) < 20:
        return {}
    out = {}
    cols = {"best_baseline": "best_baseline"} | ({"best_ml": "best_ml"} if "best_ml" in h else {})
    q = np.quantile(train_y, [1 / 3, 2 / 3])
    terc = np.digitize(h["actual"].to_numpy(), q)
    for nm, c in cols.items():
        err = (h[c] - h["actual"]).abs().to_numpy()
        top = err >= np.quantile(err, 0.95)
        hrs = pd.to_datetime(h["origin_time"]).dt.hour.to_numpy()[top]
        blocks = np.bincount(hrs // 6, minlength=4) / max(top.sum(), 1)
        out[nm] = {"top5pct_threshold_abs_err": float(np.quantile(err, 0.95)), "top5pct_share_of_total_abs_error": float(err[top].sum() / err.sum()), "top5pct_hour_block_shares_00_06_12_18": [float(x) for x in blocks],
                   "MAE_by_target_tercile_low_mid_high": [float(err[terc == k].mean()) if (terc == k).any() else None for k in range(3)]}
    return out


# ------------------------------------------------------------------------------ 載入真實任務、持久化
def safe(task_id: str) -> str:
    return hashlib.sha256(task_id.encode("utf-8")).hexdigest()[:10] + "_" + "".join(ch if ch.isalnum() else "_" for ch in task_id)[:50]


def data_hash(stem: str) -> str:
    import domain_schema as DS
    return hashlib.sha256(DS.spec_for(stem).path.read_bytes()).hexdigest()[:16]


def environment() -> dict:
    import importlib.metadata as md
    return {"python": sys.version.split()[0], **{p: md.version(p) for p in ("scikit-learn", "xgboost", "pandas", "numpy", "scipy")}}


def run_task(task_id: str, delay: int = 0, train_fraction_of_train: float = 1.0, force: bool = False) -> dict:
    import p55_analysis as AN
    import p56_profile as PR
    import p56_tasks as TK
    frozen = CO.check_frozen()
    tag = f"{task_id}|delay{delay}|tf{train_fraction_of_train:g}"
    RUNS.mkdir(parents=True, exist_ok=True)
    fp = RUNS / (safe(tag) + ".json")
    chash = CO.code_hash()
    if fp.is_file() and not force:
        cur = json.loads(fp.read_text(encoding="utf-8"))
        if cur.get("protocol_hash") == frozen["protocol_hash"] and cur.get("code_hash") == chash:
            return cur
    stem, target, hh = task_id.split("::")
    h = int(hh[1:])
    b = AN.load_bundle(stem)
    g = PR.grid(b)
    pool = TK.eligible_feature_pool(b, target)
    r = run_on_frame(g, target, h, pool, delay, train_fraction_of_train)
    pred = r.pop("_predictions", None)
    rec = {"task_id": task_id, "variant": {"delay_h": delay, "train_fraction_of_train": train_fraction_of_train}, "domain": stem, "protocol_hash": frozen["protocol_hash"], "frozen_at": frozen["frozen_at"], "code_hash": chash,
           "data_hash": data_hash(stem), "environment": environment(), "ran_at": pd.Timestamp.now().isoformat(timespec="seconds"), **r}
    fp.write_text(json.dumps(rec, ensure_ascii=False, default=lambda o: None if (isinstance(o, float) and o != o) else (float(o) if isinstance(o, (np.floating,)) else int(o) if isinstance(o, np.integer) else str(o))), encoding="utf-8")
    if pred is not None and delay == 0 and train_fraction_of_train >= 1.0:
        (CO.OUT / "predictions").mkdir(exist_ok=True)
        pred.to_csv(CO.OUT / "predictions" / (safe(task_id) + ".csv"), index=False, encoding="utf-8-sig")
    return rec
