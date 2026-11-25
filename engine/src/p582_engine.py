"""
p582_engine.py — Phase 5.8.2：多場域 Research Forecasting Engine（內部真實資料平台；研究預測，不是正式決策）

* 配方（recipe）完全沿用 Phase 5.6 的『凍結協定』（p56_core.PROTOCOL，雜湊 c369471038d0ca64）：切分、特徵集 F0／F1、固定超參數 HGB／XGBoost、
  Linear AR（Ridge）、持續性、移動平均、季節性 Naive。本模組不調參數、不搜尋、不新增模型；哪個特徵集（F0／F1）用於 HGB／XGBoost，
  依 Phase 5.6 紀錄中『驗證期 MAE 最低』的變體決定（凍結的選擇規則），不看 Holdout。
* Phase 5.6／5.7 只留下『指標與預測紀錄』（outputs/phase5_6/runs、predictions）；那次實驗在記憶體中訓練、沒有保存可載入的模型檔
  （只有羊舍 Phase 2.5／2.6／3 的正式 HGB 有 artifact）。所以本階段依凍結配方在獨立研究目錄 outputs/phase5_8_2/artifacts 重建模型並保存，
  不寫入 models/、不寫入 Model Registry、不覆寫任何既有檔案。重建結果與 Phase 5.6 的驗證／Holdout MAE 逐一比對（見 verify_task）。
* 因果性：預測時只用『預測起點（含）以前』的資料——特徵由截斷到起點的資料現算（features_at），不是讀取預先算好的結果；測試以破壞未來資料驗證。
* 研究預測（Research Forecasting）≠ 正式決策：這些模型沒有登記在 Model Registry、也沒有被送進 Compatibility Gate（gate_status 如實回報實際狀態，不寫死任何 Gate 結果）；不進入 Risk Policy 或 Decision Engine。
* 資料只有歷史：所有預測都是『歷史時點模擬預測』，不是即時監控。
"""
from __future__ import annotations

import hashlib
import json
import sys
import warnings
from functools import lru_cache
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))

import p55_analysis as AN  # noqa: E402
import p56_bench as BN  # noqa: E402
import p56_core as CO  # noqa: E402
import p56_profile as PR  # noqa: E402
import p56_tasks as TK  # noqa: E402

warnings.filterwarnings("ignore")
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "outputs" / "phase5_8_2"
ART = OUT / "artifacts"
MANIFEST = ART / "manifest.json"
RUNS56 = ROOT / "outputs" / "phase5_6" / "runs"
INVENTORY56 = ROOT / "outputs" / "phase5_6" / "candidate_task_inventory.csv"
MATRIX57 = ROOT / "outputs" / "phase5_7" / "model_recommendation_matrix.csv"

RECIPE_VERSION = "p582-recipe-v1"
HORIZONS = (1, 3, 6)
FAMILIES = ("HGB", "XGB")
MODEL_ORDER = ("persistence", "moving_average", "seasonal_naive_24h", "linear_ar4", "HGB", "XGB")
MODEL_ZH = {"persistence": "Persistence（持續性）", "moving_average": "Moving Average（移動平均）", "seasonal_naive_24h": "Seasonal Naive（24 小時季節性）",
            "linear_ar4": "Linear AR（線性自迴歸）", "HGB": "HGB（HistGradientBoosting）", "XGB": "XGBoost"}
BASELINES = ("persistence", "moving_average", "seasonal_naive_24h", "linear_ar4")
# 預測區間（預先登記，在看到任何覆蓋率之前決定）：以『驗證期』殘差做 split-conformal 校正；只有 Holdout 的實際覆蓋率落在目標附近才顯示；
# 起點必須在校正資料之後（驗證期之後），避免用同一批資料校正又評估。
INTERVAL_RULE = {"method": "split-conformal on VALIDATION absolute residuals", "coverage_target": 0.90, "accept_lo": 0.85, "accept_hi": 0.95, "min_calibration_n": 100,
                 "applies_to_origins": "strictly after the last validation origin (holdout or later)"}
MIN_GAIN = CO.PROTOCOL["recommendation_rules"]["min_ml_gain"]          # 0.05（凍結）
RESEARCH_STATUS = "Research Candidate｜Validation Pending（探索性；未經獨立驗證）"
BASELINE_STATUS = "Baseline（參考方法；非 AI 模型）"
MODE_LABEL = "歷史時點模擬預測"


class ForecastRefused(Exception):
    """要求無法安全執行（資料不足、模型不存在、特徵不完整…）；訊息是給使用者看的具體原因。"""


# ============================================================ 任務登錄與資格
def split_task(task_id: str) -> tuple[str, str, int]:
    stem, target, hh = task_id.split("::")
    return stem, target, int(hh[1:])


def make_task_id(stem: str, target: str, h: int) -> str:
    return f"{stem}::{target}::h{h}"


@lru_cache(maxsize=1)
def _runs() -> dict:
    out = {}
    for f in sorted(RUNS56.glob("*.json")):
        d = json.loads(f.read_text(encoding="utf-8"))
        v = d.get("variant", {})
        if v.get("delay_h", 0) == 0 and v.get("train_fraction_of_train", 1.0) == 1.0:
            out[d["task_id"]] = d
    return out


def run_record(task_id: str) -> dict:
    r = _runs().get(task_id)
    if r is None:
        raise ForecastRefused(f"{task_id} 沒有 Phase 5.6 的實驗紀錄（沒有凍結配方可以依循），不建立模型。")
    return r


@lru_cache(maxsize=1)
def _inventory() -> pd.DataFrame:
    return pd.read_csv(INVENTORY56).set_index("task_id")


@lru_cache(maxsize=1)
def _matrix57() -> pd.DataFrame:
    return pd.read_csv(MATRIX57).set_index("task_id")


def policy(task_id: str) -> tuple[bool, list[str]]:
    """這個任務能不能開放 Research Forecasting？規則來自凍結協定的資格門檻（不看任何模型表現）。回傳 (是否開放, 原因／限制)。"""
    try:
        rec = run_record(task_id)
    except ForecastRefused as e:
        return False, [str(e)]
    inv = _inventory().loc[task_id]
    E = CO.PROTOCOL["eligibility"]
    why: list[str] = []
    if rec.get("status") != "OK":
        return False, [f"Phase 5.6 的實驗狀態是 {rec.get('status')}：{rec.get('reason', '')}"]
    if inv["decision"] == "INELIGIBLE":
        return False, ["Eligibility Gate：INELIGIBLE（" + str(inv["reasons"]) + "）"]
    frac = float(inv["observed_frac"])
    if frac < E["min_observed_frac_conditional"]:
        return False, [f"資料不足：這個場域只有 {int(inv['observed_hours'])}／{int(round(inv['observed_hours'] / frac))} 小時有讀值（{frac:.0%}），低於凍結協定的最低觀測比例 {E['min_observed_frac_conditional']:.0%}；"
                       f"連續區段只有 {int(inv['continuous_segments'])} 段（最長 {int(inv['longest_segment_h'])} 小時）；各切分的樣本：訓練 {int(inv['n_train'])}、驗證 {int(inv['n_validation'])}、Holdout {int(inv['n_holdout'])}。"
                       "Phase 5.7 也判定學習曲線與滾動評估資料不足。系統不強行建立模型；需要累積更多連續資料。"]
    if inv["decision"] == "CONDITIONAL":
        why.append("Eligibility Gate：CONDITIONAL（" + str(inv["reasons"]).split(" | ")[0] + "）")
    return True, why


def registry() -> pd.DataFrame:
    """105 個 Phase 5.6 任務的總表（任務 × 資格 × 實驗證據）。"""
    rows = []
    inv, m57 = _inventory(), _matrix57()
    for tid, rec in sorted(_runs().items()):
        stem, target, h = split_task(tid)
        ok, why = policy(tid)
        i = inv.loc[tid]
        r57 = m57.loc[tid] if tid in m57.index else None
        rows.append({"task_id": tid, "domain": stem, "sensor": target, "horizon_h": h, "enabled": ok, "policy_notes": "；".join(why), "eligibility": i["decision"], "observed_frac": float(i["observed_frac"]),
                     "unit_status": i["unit_status"], "phase56_decision": rec.get("decision"), "phase56_best_ml": rec.get("best_ml"), "seasonal_valid": bool(rec["seasonal_naive"]["valid"]),
                     "f1_available": bool(rec["f1_available"]), "promotion_57": None if r57 is None else r57["promotion_decision"], "uncertainty_57": None if r57 is None else r57["uncertainty_status"],
                     "n_train": rec["split"]["train"], "n_validation": rec["split"]["validation"], "n_holdout": rec["split"]["holdout"]})
    return pd.DataFrame(rows)


def enabled_tasks(domain: str | None = None) -> list[str]:
    return [t for t in sorted(_runs()) if policy(t)[0] and (domain is None or split_task(t)[0] == domain)]


# ============================================================ 配方重建（與 p56_bench.run_on_frame 的前半段相同）
@lru_cache(maxsize=12)
def _context_cached(task_id: str, data_sha: str) -> dict:
    stem, target, h = split_task(task_id)
    b = AN.load_bundle(stem)
    assert b["sha256"] == data_sha
    g = PR.grid(b)
    pool = TK.eligible_feature_pool(b, target)
    return recipe_frame(g, target, h, pool) | {"stem": stem, "target": target, "h": h, "data_sha": data_sha, "classification": next((r for r in b["cls"]["rows"] if r.original_column_name == target), None)}


def context(task_id: str) -> dict:
    stem, _, _ = split_task(task_id)
    b = AN.load_bundle(stem)
    return _context_cached(task_id, b["sha256"])


def recipe_frame(g: pd.DataFrame, target: str, h: int, pool: list[str], delay: int = 0) -> dict:
    """依凍結協定決定：特徵、可用起點、時間順序切分、交叉特徵（只用訓練起點選）。與 p56_bench.run_on_frame 的邏輯逐步相同。"""
    P = CO.PROTOCOL
    y = g[target].to_numpy(float)
    span_days = (g.index.max() - g.index.min()) / pd.Timedelta(days=1)
    use_dow = bool(span_days >= P["dow_min_span_days"])
    F0 = CO.own_features(g, target, delay, use_dow)
    base_ok = CO.usable_mask(y, h, delay)

    def complete(df):
        return ~df.isna().any(axis=1).to_numpy()
    f0_ok = complete(F0)
    origins0 = np.where(base_ok & f0_ok)[0]
    sp0 = CO.chrono_split(origins0, h)
    cross = BN.select_cross(g, pool, target, h, sp0["train"], delay)
    F1 = pd.concat([F0, CO.cross_features(g, cross, delay)], axis=1) if cross else F0
    f1_ok = complete(F1)
    origins1 = np.where(base_ok & f0_ok & f1_ok)[0]
    sp1 = CO.chrono_split(origins1, h)
    use_f1 = bool(cross) and min(len(sp1["train"]), len(sp1["validation"]), len(sp1["holdout"])) >= P["eligibility"]["split_conditional"] and len(origins1) >= 0.5 * len(origins0)
    origins, sp = (origins1, sp1) if use_f1 else (origins0, sp0)
    yy = np.full(len(y), np.nan)
    yy[: len(y) - h] = y[h:]
    train_std = float(np.std(yy[sp["train"]])) if len(sp["train"]) else float("nan")
    sv, sinfo = BN.seasonal_valid(g, target, int(sp["train"][-1]) + h) if len(sp["train"]) else (False, {})
    return {"g": g, "y": y, "yy": yy, "ysh": g[target].shift(delay).to_numpy(float), "F0": F0, "F1": F1 if use_f1 else None, "use_f1": use_f1, "cross": list(cross) if use_f1 else [], "use_dow": use_dow,
            "origins": origins, "sp": sp, "train_std": train_std, "seasonal_valid": bool(sv), "seasonal_info": sinfo, "f1_cols": list(F1.columns) if use_f1 else [], "f0_cols": list(F0.columns), "pool": pool}


# ============================================================ 訓練（依凍結配方）
def chosen_variants(task_id: str) -> dict:
    """HGB／XGBoost 各用哪個特徵集：Phase 5.6 紀錄中『驗證期 MAE 最低』的變體（凍結規則；不看 Holdout）。"""
    ml = run_record(task_id)["results"]["ml"]
    out = {}
    for fam in FAMILIES:
        cands = {k: v for k, v in ml.items() if k.startswith(fam + "-") and "validation" in v}
        if not cands:
            raise ForecastRefused(f"{task_id}：Phase 5.6 沒有 {fam} 的評估紀錄。")
        out[fam] = min(cands, key=lambda k: cands[k]["validation"]["MAE"])
    return out


def _x(ctx: dict, variant: str) -> tuple[np.ndarray, list[str]]:
    fs = variant.split("-")[1]
    F = ctx["F1"] if (fs == "F1" and ctx["use_f1"]) else ctx["F0"]
    return F.to_numpy(), list(F.columns)


def fit_all(task_id: str) -> dict:
    """依凍結配方訓練 Linear AR、HGB、XGBoost（只用 train 起點；目標時間早於驗證期起點）。"""
    from sklearn.linear_model import Ridge
    ctx = context(task_id)
    run = run_record(task_id)
    tr, yy = ctx["sp"]["train"], ctx["yy"]
    var = chosen_variants(task_id)
    models, feats = {}, {}
    cols = ["lag0", "lag1", "lag2", "lag3"]
    models["linear_ar4"] = Ridge(alpha=1.0).fit(ctx["F0"][cols].to_numpy()[tr], yy[tr])
    feats["linear_ar4"] = cols
    for fam, v in var.items():
        X, names = _x(ctx, v)
        models[fam] = BN.make_model(fam).fit(X[tr], yy[tr])
        feats[fam] = names
    return {"models": models, "feature_names": feats, "variants": var, "train_n": int(len(tr)), "run": run}


# ============================================================ Artifact（研究用；不在 models/、不在 Model Registry）
def _env() -> dict:
    return BN.environment()


def _sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def artifact_path(task_id: str) -> Path:
    return ART / (BN.safe(task_id) + ".joblib")


def load_manifest() -> dict:
    if not MANIFEST.is_file():
        return {"artifacts": {}}
    return json.loads(MANIFEST.read_text(encoding="utf-8"))


def build_artifact(task_id: str, manifest: dict) -> dict:
    import joblib
    ok, why = policy(task_id)
    if not ok:
        raise ForecastRefused("；".join(why))
    ctx = context(task_id)
    fit = fit_all(task_id)
    stem, target, h = split_task(task_id)
    frozen = CO.check_frozen()
    meta = {"task_id": task_id, "domain": stem, "target": target, "horizon_h": h, "recipe_version": RECIPE_VERSION, "protocol_hash": frozen["protocol_hash"], "data_sha256_16": BN.data_hash(stem),
            "data_sha256": ctx["data_sha"], "variants": fit["variants"], "feature_names": fit["feature_names"], "cross_sensors": ctx["cross"], "use_dow": ctx["use_dow"], "use_f1": ctx["use_f1"],
            "seasonal_valid": ctx["seasonal_valid"], "train_n": fit["train_n"], "train_std": ctx["train_std"], "periods": run_record(task_id)["periods"], "environment": _env(),
            "built_at": pd.Timestamp.now().isoformat(timespec="seconds"), "status": RESEARCH_STATUS}
    ART.mkdir(parents=True, exist_ok=True)
    p = artifact_path(task_id)
    joblib.dump({"meta": meta, "models": fit["models"]}, p, compress=3)
    sha = _sha(p)
    ver = {k: f"{RECIPE_VERSION}+{frozen['protocol_hash'][:8]}+{(fit['variants'].get(k) or k)}+{sha[:8]}" for k in ("HGB", "XGB", "linear_ar4")}
    manifest["artifacts"][task_id] = {"file": p.name, "sha256": sha, "bytes": p.stat().st_size, "versions": ver, "meta": {k: meta[k] for k in ("domain", "target", "horizon_h", "protocol_hash", "data_sha256_16", "variants", "train_n", "periods", "environment", "built_at")}}
    return manifest["artifacts"][task_id]


@lru_cache(maxsize=64)
def _load_cached(task_id: str, sha: str):
    import joblib
    return joblib.load(artifact_path(task_id))


def load_artifact(task_id: str) -> dict:
    """載入並驗證：manifest 的 sha256、任務身分（場域／感測器／時距）、資料雜湊（資料變了就不信任舊模型）。任何不符就拒絕。"""
    man = load_manifest()["artifacts"].get(task_id)
    if man is None:
        raise ForecastRefused(f"{task_id} 沒有研究模型 artifact（尚未依凍結配方建立，或這個任務不符合資格）。")
    p = artifact_path(task_id)
    if not p.is_file():
        raise ForecastRefused(f"{task_id} 的 artifact 檔案遺失。")
    if _sha(p) != man["sha256"]:
        raise ForecastRefused(f"{task_id} 的 artifact 雜湊與 manifest 不符：檔案可能被改動，拒絕使用。")
    a = _load_cached(task_id, man["sha256"])
    stem, target, h = split_task(task_id)
    m = a["meta"]
    if (m["domain"], m["target"], m["horizon_h"], m["task_id"]) != (stem, target, h, task_id):
        raise ForecastRefused("artifact 的場域／感測器／時距與請求不同：拒絕（不同任務不能共用模型）。")
    if m["data_sha256_16"] != BN.data_hash(stem):
        raise ForecastRefused(f"{stem} 的原始資料已改變（雜湊與訓練時不同）：舊模型不再可信，需要重建。")
    return {"meta": m, "models": a["models"], "versions": man["versions"], "sha256": man["sha256"]}


# ============================================================ 因果特徵：只用起點（含）以前
def features_at(task_id: str, origin) -> dict:
    """由『截斷到起點』的資料現算特徵（不使用起點之後的任何一筆）。回傳 F0／F1 的最後一列與基準方法需要的值。"""
    ctx = context(task_id)
    a_meta = load_artifact(task_id)["meta"]
    g, target, h = ctx["g"], ctx["target"], ctx["h"]
    t = pd.Timestamp(origin)
    if t not in g.index:
        raise ForecastRefused(f"{t} 不在資料的每小時時間軸上。")
    gt = g.loc[t - pd.Timedelta(hours=72): t]                    # 72 小時視窗已足夠 25 小時歷史；不含 t 之後的資料
    F0 = CO.own_features(gt, target, 0, a_meta["use_dow"]).iloc[-1]
    F1 = pd.concat([CO.own_features(gt, target, 0, a_meta["use_dow"]), CO.cross_features(gt, a_meta["cross_sensors"], 0)], axis=1).iloc[-1] if a_meta["use_f1"] else None
    y_t = gt[target].iloc[-1]
    seas = None
    if h <= 24:
        tt = t + pd.Timedelta(hours=h - 24)
        seas = g.loc[tt, target] if tt in g.index and tt <= t else np.nan
    return {"F0": F0, "F1": F1, "y_t": float(y_t) if y_t == y_t else float("nan"), "seasonal": None if seas is None else float(seas), "window": (gt.index[0], gt.index[-1])}


def last_observation(task_id: str, origin) -> tuple[pd.Timestamp | None, float | None]:
    ctx = context(task_id)
    s = ctx["g"].loc[:pd.Timestamp(origin), ctx["target"]].dropna()
    return (s.index[-1], float(s.iloc[-1])) if len(s) else (None, None)


def origin_period(task_id: str, origin) -> str:
    ctx = context(task_id)
    g, sp = ctx["g"], ctx["sp"]
    i = g.index.get_loc(pd.Timestamp(origin))
    if len(sp["train"]) and i <= sp["train"][-1]:
        return "train"
    if len(sp["validation"]) and i <= sp["validation"][-1]:
        return "validation"
    if len(sp["holdout"]) and i <= sp["holdout"][-1]:
        return "holdout"
    return "latest"


PERIOD_ZH = {"train": "訓練期（樣本內，不是評估）", "validation": "驗證期（模型訓練之後的資料；用於挑選特徵集，屬開發期）", "holdout": "留存測試期（Holdout；探索性確認，非獨立驗證）", "latest": "最新資料（目標時間可能尚無觀測）"}


def origin_options(task_id: str) -> pd.DatetimeIndex:
    """可以當預測起點的時間：目標自己的 25 小時歷史完整（F0 特徵完整）。更細的限制（交叉特徵缺值）由預測時逐模型說明。"""
    ctx = context(task_id)
    ok = ~ctx["F0"].isna().any(axis=1).to_numpy()
    return ctx["g"].index[ok]


# ============================================================ 單點預測
def _row(F: pd.Series, names: list[str]) -> np.ndarray | None:
    v = F[names].to_numpy(float)
    return None if np.isnan(v).any() else v.reshape(1, -1)


def forecast(task_id: str, origin, model_keys: tuple = MODEL_ORDER) -> dict:
    """在指定起點對一個任務執行預測。每個模型各自回傳 {value} 或 {refused: 原因}（不插補、不借用其他模型）。"""
    ok, why = policy(task_id)
    if not ok:
        raise ForecastRefused("；".join(why))
    a = load_artifact(task_id)
    ctx = context(task_id)
    stem, target, h = split_task(task_id)
    t = pd.Timestamp(origin)
    fe = features_at(task_id, t)
    target_ts = t + pd.Timedelta(hours=h)
    last_ts, last_val = last_observation(task_id, t)
    g = ctx["g"]
    actual = None
    if target_ts in g.index and g.loc[target_ts, target] == g.loc[target_ts, target]:
        actual = float(g.loc[target_ts, target])
    res = {}
    for k in model_keys:
        try:
            if k == "persistence":
                if fe["y_t"] != fe["y_t"]:
                    raise ForecastRefused("起點當下沒有讀值")
                res[k] = {"value": fe["y_t"]}
            elif k == "moving_average":
                v = fe["F0"]["roll_mean6"]
                if v != v:
                    raise ForecastRefused("起點以前 6 小時內有缺值")
                res[k] = {"value": float(v)}
            elif k == "seasonal_naive_24h":
                if not a["meta"]["seasonal_valid"]:
                    raise ForecastRefused("季節性基準在訓練期未通過有效性檢查（日週期不夠強），依凍結協定不使用")
                if fe["seasonal"] is None or fe["seasonal"] != fe["seasonal"]:
                    raise ForecastRefused("起點 24 小時前對應時刻沒有讀值")
                res[k] = {"value": fe["seasonal"]}
            else:
                names = a["meta"]["feature_names"][k]
                F = fe["F1"] if (k != "linear_ar4" and a["meta"]["variants"][k].endswith("F1") and fe["F1"] is not None) else fe["F0"]
                x = _row(F, names)
                if x is None:
                    miss = [n for n in names if F[n] != F[n]]
                    raise ForecastRefused(f"起點以前的特徵不完整（缺 {', '.join(miss[:4])}{'…' if len(miss) > 4 else ''}）；不插補、不猜測")
                res[k] = {"value": float(a["models"][k].predict(x)[0])}
        except ForecastRefused as e:
            res[k] = {"refused": str(e)}
    per = origin_period(task_id, t)
    versions = {k: a["versions"].get(k, f"{RECIPE_VERSION}（基準方法，無訓練參數）") for k in model_keys}
    cls = ctx.get("classification")
    return {"task_id": task_id, "domain": stem, "sensor": target, "horizon_h": h, "mode": MODE_LABEL, "forecast_origin": t, "target_timestamp": target_ts, "last_observation_time": last_ts,
            "last_observation_value": last_val, "data_last_timestamp": g[target].dropna().index[-1], "data_cutoff": t, "actual": actual, "period": per, "period_zh": PERIOD_ZH[per],
            "unit": getattr(cls, "unit", "?"), "unit_status": getattr(cls, "unit_verification_status", "UNVERIFIED"), "predictions": res, "versions": versions, "variants": a["meta"]["variants"],
            "research_status": RESEARCH_STATUS, "baseline_status": BASELINE_STATUS, "artifact_sha256": a["sha256"], "feature_window": fe["window"]}


# ============================================================ 評估（同一批共同評估點；真正呼叫已載入的模型）
def _batch(task_id: str) -> dict:
    a = load_artifact(task_id)
    ctx = context(task_id)
    idx_all = np.concatenate([ctx["sp"]["validation"], ctx["sp"]["holdout"]])
    split = np.array(["validation"] * len(ctx["sp"]["validation"]) + ["holdout"] * len(ctx["sp"]["holdout"]))
    P = {"persistence": ctx["ysh"][idx_all], "moving_average": ctx["F0"]["roll_mean6"].to_numpy()[idx_all]}
    if ctx["seasonal_valid"]:
        P["seasonal_naive_24h"] = ctx["y"][idx_all + ctx["h"] - 24]
    P["linear_ar4"] = a["models"]["linear_ar4"].predict(ctx["F0"][a["meta"]["feature_names"]["linear_ar4"]].to_numpy()[idx_all])
    for fam in FAMILIES:
        v = a["meta"]["variants"][fam]
        X = (ctx["F1"] if (v.endswith("F1") and ctx["use_f1"]) else ctx["F0"])[a["meta"]["feature_names"][fam]].to_numpy()
        P[fam] = a["models"][fam].predict(X[idx_all])
    g = ctx["g"]
    df = pd.DataFrame({"origin_time": g.index[idx_all], "target_time": g.index[idx_all + ctx["h"]], "split": split, "actual": ctx["yy"][idx_all]})
    for k in MODEL_ORDER:
        if k in P:
            df[k] = P[k]
    return {"df": df, "meta": a["meta"], "train_std": ctx["train_std"]}


EVIDENCE_LABEL_V2 = {"version": "evidence-label-v2", "label": "EXPLORATORY_SIGNAL",
                     "rule": "驗證期相對最佳基準改善 ≥ 5% 且 時間交叉驗證在 ≥ 3 折中勝出 ≥ 2 折；Holdout 不參與標籤",
                     "holdout": "只作描述性診斷（整段、前半、後半），不決定任何標籤", "independent_validation": False,
                     "note": "同時比較 180 個『任務 × 模型』；資料已被反覆檢視；訊號可能是偶然，也不是獨立驗證"}


def exploratory_signal(rel_val: float, cv_wins: int | None, cv_folds: int | None) -> bool:
    """證據標籤 v2：只由『開發期』資料決定（驗證期改善與時間交叉驗證）。**刻意不接受任何 Holdout 參數**——簽名由測試強制。"""
    return bool(rel_val == rel_val and rel_val >= MIN_GAIN and cv_folds is not None and cv_folds >= 3 and cv_wins is not None and cv_wins >= 2)


@lru_cache(maxsize=64)
def _evaluate_cached(task_id: str, sha: str) -> dict:
    B = _batch(task_id)
    df, std = B["df"], B["train_std"]
    mets = {}
    for k in MODEL_ORDER:
        if k not in df:
            continue
        mets[k] = {s: BN.metrics(df.loc[df.split == s, "actual"].to_numpy(), df.loc[df.split == s, k].to_numpy(), std) for s in ("validation", "holdout")}
    valid_b = [k for k in BASELINES if k in mets]
    best_b = min(valid_b, key=lambda k: mets[k]["validation"]["MAE"])
    run = run_record(task_id)
    ho = df[df.split == "holdout"].reset_index(drop=True)
    halves = (ho.iloc[: len(ho) // 2], ho.iloc[len(ho) // 2:])

    def _half_rel(d, k):
        r, _ = BN.rel_improvement(float(np.mean(np.abs(d[best_b] - d["actual"]))), float(np.mean(np.abs(d[k] - d["actual"]))), std)
        return r
    ev = {}
    for k in MODEL_ORDER:
        if k not in mets:
            continue
        rv, _ = BN.rel_improvement(mets[best_b]["validation"]["MAE"], mets[k]["validation"]["MAE"], std)
        rh, _ = BN.rel_improvement(mets[best_b]["holdout"]["MAE"], mets[k]["holdout"]["MAE"], std)
        wins, nf = (None, None)
        signal, supported, hold = None, None, None
        if k in FAMILIES:
            folds = run["results"]["ml"][B["meta"]["variants"][k]]["folds"]
            nf = len(folds)
            wins = sum(int(f["MAE"] < min(f["baseline_maes_on_same_points"].values())) for f in folds)
            signal = exploratory_signal(rv, wins, nf)                                           # v2：不含 Holdout
            supported = bool(rv == rv and rv >= MIN_GAIN and nf >= 3 and wins >= 2 and rh == rh and rh >= 0)    # v1（LEGACY）：Holdout 是接受條件；只為重現舊結果保留，不得用於對外標籤
            r1, r2 = _half_rel(halves[0], k), _half_rel(halves[1], k)
            hold = {"overall": rh, "first_half": r1, "second_half": r2, "both_halves_nonnegative": bool(r1 == r1 and r2 == r2 and r1 >= 0 and r2 >= 0)}
        ev[k] = {"rel_val": rv, "rel_hold": rh, "cv_wins": wins, "cv_folds": nf, "signal": signal, "holdout": hold, "supported": supported}
    return {"df": df, "metrics": mets, "best_baseline": best_b, "evidence": ev, "train_std": std, "variants": B["meta"]["variants"]}


def evaluate(task_id: str) -> dict:
    a = load_artifact(task_id)
    return _evaluate_cached(task_id, a["sha256"])


NO_EVIDENCE_TEXT = "目前尚無足夠證據證明此模型優於簡單基準。"


def evidence_text(task_id: str, model_key: str) -> str:
    """機器學習模型的探索性證據說明（規則式；沒有 LLM）。v2：標籤不含 Holdout；不暗示已完成獨立驗證。"""
    E = evaluate(task_id)
    ev = E["evidence"].get(model_key)
    if ev is None or model_key not in FAMILIES:
        return ""
    bb = MODEL_ZH[E["best_baseline"]]
    h = ev["holdout"]

    def f(x):
        return "—" if x != x else f"{x:+.1%}"
    if ev["signal"]:
        return (f"探索性訊號（EXPLORATORY_SIGNAL；**不是獨立驗證**）：{MODEL_ZH[model_key]}（{E['variants'][model_key]}）在開發期——驗證期相對最佳基準 {bb} 改善 {f(ev['rel_val'])}、時間交叉驗證勝 {ev['cv_wins']}/{ev['cv_folds']} 折——"
                f"達到訊號條件。Holdout（描述性、非獨立）：整段 {f(h['overall'])}、前半 {f(h['first_half'])}、後半 {f(h['second_half'])}。"
                "這批資料已被反覆檢視，且同時比較了 180 個『任務 × 模型』，部分訊號可能是偶然；這不代表模型在新資料上仍然較好。")
    parts = []
    if ev["rel_val"] == ev["rel_val"]:
        parts.append(f"驗證期 {f(ev['rel_val'])}（訊號條件 ≥ +{MIN_GAIN:.0%}）")
    if ev["cv_wins"] is not None:
        parts.append(f"交叉驗證勝 {ev['cv_wins']}/{ev['cv_folds']} 折（訊號條件 ≥ 2）")
    parts.append(f"Holdout（描述性）整段 {f(h['overall'])}、前半 {f(h['first_half'])}、後半 {f(h['second_half'])}")
    return NO_EVIDENCE_TEXT + "　相對最佳基準 " + bb + "：" + "；".join(parts) + "。"


# ============================================================ 預測區間
# v1（LEGACY，Phase 5.8.2）：以 Holdout 覆蓋率決定『顯示與否』，再把同一個 Holdout 覆蓋率當成結果回報——事後篩選偏差（Phase 5.8.4 稽核 F2）。
# 只為重現舊結果與稽核保留（tools/p582_build_forecast.py 的舊矩陣、舊測試）；網站與新報告不得使用。
@lru_cache(maxsize=256)
def _interval_cached(task_id: str, model_key: str, sha: str) -> dict:
    R = INTERVAL_RULE
    E = _evaluate_cached(task_id, sha)
    df = E["df"]
    if model_key not in df:
        return {"valid": False, "reason": "這個模型在此任務沒有預測"}
    cal = df[df.split == "validation"]
    hold = df[df.split == "holdout"]
    if len(cal) < R["min_calibration_n"]:
        return {"valid": False, "reason": f"校正資料只有 {len(cal)} 筆（需要 ≥ {R['min_calibration_n']}），不建立預測區間"}
    res = np.sort(np.abs(cal["actual"].to_numpy() - cal[model_key].to_numpy()))
    n = len(res)
    k = int(np.ceil((n + 1) * R["coverage_target"]))
    q = float(res[min(k, n) - 1])
    cov = float(np.mean(np.abs(hold["actual"].to_numpy() - hold[model_key].to_numpy()) <= q))
    ok = R["accept_lo"] <= cov <= R["accept_hi"]
    return {"valid": bool(ok), "q": q, "holdout_coverage": cov, "n_calibration": n, "n_holdout": int(len(hold)),
            "reason": ("" if ok else f"Holdout 實際覆蓋率 {cov:.0%} 不在可接受範圍 {R['accept_lo']:.0%}～{R['accept_hi']:.0%}（目標 {R['coverage_target']:.0%}）：區間不可靠，不顯示")}


def interval_v1_legacy(task_id: str, model_key: str, origin) -> dict:
    """LEGACY（v1）：見上。不得用於網站或新報告。"""
    a = load_artifact(task_id)
    info = dict(_interval_cached(task_id, model_key, a["sha256"]))
    if info.get("valid") and origin_period(task_id, origin) not in ("holdout", "latest"):
        return {"valid": False, "reason": "這個起點在校正資料之內（訓練期或驗證期）：用同一批資料校正又評估，不顯示區間"}
    return info


# v2（本修正）：校正＝驗證期殘差（與 v1 相同）；**不以 Holdout 篩選**——只要校正資料足夠、起點在校正資料之後就顯示，一律標為『探索性、尚未獨立驗證』。
# Holdout 覆蓋率只是『描述性診斷』（整段、前半、後半＋區塊 bootstrap 信賴區間）；偏低時只加警示，不隱藏、不宣稱通過。
INTERVAL_PROTOCOL_V2 = {"version": "interval-v2", "status": "EXPLORATORY_UNVALIDATED", "method": "split-conformal on VALIDATION absolute residuals", "coverage_target": 0.90, "min_calibration_n": 100,
                        "screening": "none: 顯示與否不由 Holdout 決定", "display_origins": "strictly after the last validation origin (holdout or later)",
                        "diagnostics": {"holdout_overall": True, "first_half": True, "second_half": True, "ci": {"method": "moving-block bootstrap", "block": 24, "n_boot": 2000, "seed": 0, "level": 0.95}},
                        "undercoverage_warning_below": 0.85, "claims": "不宣稱區間已通過驗證；覆蓋率數字只是描述，沒有被用來選擇區間"}


def interval_protocol_hash() -> str:
    return hashlib.sha256(json.dumps(INTERVAL_PROTOCOL_V2, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()[:16]


def block_bootstrap_ci(ind: np.ndarray, block: int = 24, n_boot: int = 2000, seed: int = 0, level: float = 0.95) -> tuple[float, float]:
    """對 0/1 覆蓋指標做時間區塊 bootstrap（連續 block 個起點為一塊，固定種子；有自相關時比二項區間誠實）。"""
    ind = np.asarray(ind, float)
    n = len(ind)
    if n == 0:
        return float("nan"), float("nan")
    blocks = [ind[i: i + block] for i in range(0, n, block)]
    bm = np.array([b.mean() for b in blocks])
    bs = np.array([len(b) for b in blocks], float)
    rng = np.random.default_rng(seed)
    idx = rng.integers(0, len(blocks), size=(n_boot, len(blocks)))
    cov = (bm[idx] * bs[idx]).sum(axis=1) / bs[idx].sum(axis=1)
    a = (1 - level) / 2
    return float(np.quantile(cov, a)), float(np.quantile(cov, 1 - a))


@lru_cache(maxsize=256)
def _interval_v2_cached(task_id: str, model_key: str, sha: str) -> dict:
    P = INTERVAL_PROTOCOL_V2
    df = _evaluate_cached(task_id, sha)["df"]
    base = {"protocol": P["version"], "status": P["status"], "target": P["coverage_target"], "protocol_hash": interval_protocol_hash()}
    if model_key not in df:
        return {**base, "available": False, "reason": "這個模型在此任務沒有預測"}
    cal, hold = df[df.split == "validation"], df[df.split == "holdout"].reset_index(drop=True)
    if len(cal) < P["min_calibration_n"]:
        return {**base, "available": False, "reason": f"校正資料只有 {len(cal)} 筆（需要 ≥ {P['min_calibration_n']}），不建立預測區間"}
    res = np.sort(np.abs(cal["actual"].to_numpy() - cal[model_key].to_numpy()))
    n = len(res)
    q = float(res[min(int(np.ceil((n + 1) * P["coverage_target"])), n) - 1])
    ind = (np.abs(hold["actual"].to_numpy() - hold[model_key].to_numpy()) <= q).astype(float)
    h = len(ind) // 2
    d = P["diagnostics"]["ci"]
    lo, hi = block_bootstrap_ci(ind, d["block"], d["n_boot"], d["seed"], d["level"])
    cov = float(ind.mean()) if len(ind) else float("nan")
    return {**base, "available": True, "q": q, "n_calibration": n, "n_holdout": int(len(ind)), "holdout_coverage": cov, "coverage_first_half": float(ind[:h].mean()) if h else float("nan"),
            "coverage_second_half": float(ind[h:].mean()) if len(ind) - h else float("nan"), "coverage_ci": (lo, hi), "undercoverage": bool(cov == cov and cov < P["undercoverage_warning_below"])}


def interval(task_id: str, model_key: str, origin) -> dict:
    """v2：某起點的探索性預測區間。`shown` 只由『校正資料足夠』與『起點在校正資料之後』決定；Holdout 覆蓋率只是描述性診斷與警示，**不決定是否顯示**。"""
    a = load_artifact(task_id)
    info = dict(_interval_v2_cached(task_id, model_key, a["sha256"]))
    if not info.get("available"):
        return {**info, "shown": False}
    if origin_period(task_id, origin) not in ("holdout", "latest"):
        return {**info, "shown": False, "reason": "這個起點在校正資料之內（訓練期或驗證期）：不顯示區間（用同一批資料校正又評估沒有意義）"}
    return {**info, "shown": True, "reason": ""}


# ============================================================ 歷史曲線
def history(task_id: str, origin, hours: int = 72) -> pd.DataFrame:
    """起點以前的實際觀測（含起點）。不包含起點之後的資料。"""
    ctx = context(task_id)
    t = pd.Timestamp(origin)
    s = ctx["g"].loc[t - pd.Timedelta(hours=hours): t, ctx["target"]]
    return s.rename("value").rename_axis("time").reset_index()


def future_actual(task_id: str, origin, extra_hours: int = 0) -> pd.DataFrame:
    """揭曉用：起點之後 h 小時內的實際值（只在使用者要對照時才使用；預測本身不使用）。"""
    ctx = context(task_id)
    t = pd.Timestamp(origin)
    s = ctx["g"].loc[t: t + pd.Timedelta(hours=ctx["h"] + extra_hours), ctx["target"]]
    return s.rename("value").rename_axis("time").reset_index()


# ============================================================ 正式決策隔離（Compatibility Gate）
GATE_OUTCOMES = ("NO_REGISTRY", "NOT_REGISTERED", "GATE_REFUSED", "GATE_ALLOWED_OR_DEGRADED")


def _gate_text(g: dict) -> str:
    """畫面與 API 共用的說明文字；每個 outcome 只描述『實際發生的事』。"""
    q = g.get("select_result") or {}
    if g["outcome"] == "NO_REGISTRY":
        return ("這個版本沒有正式 Model Registry，研究預測**沒有被送進任何 Compatibility Gate**（沒有執行任何 Gate 檢查）。研究預測不能當作決策依據，也不會進入風險政策或決策引擎。")
    if g["outcome"] == "NOT_REGISTERED":
        if q.get("error"):
            return f"研究模型沒有登記卡片；對正式 Registry 的查詢失敗（{q['error']}），沒有取得任何 Gate 結果。"
        f = f"正式 Gate 對這個任務的實際查詢結果：{('找到正式模型 ' + q['selected_card']) if q.get('selected_card') else '沒有任何可用的正式模型'}（{q.get('decision', '—')}" + (f"；失敗檢查：{', '.join(q['failed_checks'])}" if q.get("failed_checks") else "") + "）。"
        return "研究模型**沒有登記卡片**，所以沒有任何 Gate 檢查可以對它執行（它不是被 Gate 擋下，而是從來沒有被送進 Gate）。" + f
    if g["outcome"] == "GATE_REFUSED":
        return f"Compatibility Gate 對這張卡片的實際檢查結果：REFUSE；失敗檢查：{', '.join(g['failed_checks']) or '—'}。"
    return (f"Compatibility Gate 對這張卡片的實際檢查結果：{str(g['decision']).upper()}（警告：{', '.join(g['failed_checks']) or '無'}）。**注意：現行 Gate 只核對中繼資料，不核對獨立驗證證據**（見 Phase 5.8.5 強化方案）。")


def gate_status(task_id: str, model_key: str) -> dict:
    """研究模型與正式 Compatibility Gate 的**實際**關係。

    只回報實際發生的事（Phase 5.8.5 修正，取代寫死的 'refuse'）：
      NO_REGISTRY               執行環境沒有 Model Registry（雲端發布包）；沒有任何 Gate 檢查。
      NOT_REGISTERED            有 Registry，但這個研究模型沒有卡片；沒有 Gate 檢查可以對它執行。`select_result` 是正式 Gate 對『同一任務』的實際查詢結果。
      GATE_REFUSED / GATE_ALLOWED_OR_DEGRADED   Registry 內有這個研究模型的卡片，`check_compatibility` 的實際結果。
    `decision` 只會是 GateResult.decision 的複本（沒有卡片時是 None）。本函式不建立、不修改任何卡片，也不升級任何模型。
    """
    stem, target, h = split_task(task_id)
    a = load_artifact(task_id)
    mid = f"research_{model_key}_{BN.safe(task_id)[:14]}"
    g = {"task_id": task_id, "model_key": model_key, "model_id": mid, "model_version": a["versions"].get(model_key, ""), "outcome": None, "registry_available": False, "gate_evaluated": False,
         "registered": False, "decision": None, "failed_checks": [], "select_result": None, "formal_model_for_this_task": None}
    try:                                              # 內部平台有 Model Registry；沒有它的發布包（雲端版）沒有任何 Gate 可以呼叫
        import domain_registry as DR
        reg = DR.DomainModelRegistry()
    except Exception:                                 # noqa: BLE001
        g["outcome"] = "NO_REGISTRY"
        g["text"] = _gate_text(g)
        return g
    g["registry_available"] = True
    cards = [c for c in reg.cards if c.model_id == mid]
    g["registered"] = bool(cards)
    req = None
    try:
        req = DR.request_for_dataset(stem, "forecast_risk", target, h)
        sel = reg.select(req)                          # 正式 Gate 對『同一個任務』的實際查詢（實際呼叫 check_compatibility）
        if sel[0] is None:
            res = sel[1]
            g["select_result"] = {"selected_card": None, "decision": (res[0].decision if res else None), "failed_checks": sorted({c.name for r in res for c in r.blocking})}
        else:
            g["select_result"] = {"selected_card": sel[0].key, "decision": sel[1].decision, "failed_checks": [c.name for c in (sel[1].blocking + sel[1].warnings)]}
            g["formal_model_for_this_task"] = sel[0].key
        g["gate_evaluated"] = True
    except Exception as e:                            # noqa: BLE001
        g["select_result"] = {"error": type(e).__name__}
    if cards and req is not None:
        r = DR.check_compatibility(cards[0], req)
        g["decision"] = r.decision
        g["failed_checks"] = [c.name for c in r.checks if not c.passed]
        g["gate_evaluated"] = True
        g["outcome"] = "GATE_REFUSED" if r.decision == "refuse" else "GATE_ALLOWED_OR_DEGRADED"
    else:
        g["outcome"] = "NOT_REGISTERED"
    g["text"] = _gate_text(g)
    return g


def decision_engine_gate_note(stem: str) -> str:
    return "羊舍的正式預測與決策由既有 Phase 3 流程（HGB＋CQR＋ProbLinQ＋Reliability Gate）執行，不受這份研究預測影響。" if stem == "羊舍" else "這個場域沒有任何已核准的正式預測模型；研究預測不能取代。"


# ============================================================ 驗證：重建 = 保存的 artifact = Phase 5.6 紀錄
def verify_task(task_id: str, tol: float = 1e-9) -> dict:
    """從頭依凍結配方重建模型（不讀取保存的 artifact），比對 (1) 保存 artifact 的預測、(2) Phase 5.6 紀錄的驗證／Holdout MAE。"""
    ctx = context(task_id)
    run = run_record(task_id)
    fit = fit_all(task_id)
    a = load_artifact(task_id)
    idx_all = np.concatenate([ctx["sp"]["validation"], ctx["sp"]["holdout"]])
    out = {"task_id": task_id, "max_pred_diff_vs_artifact": 0.0, "mae_diffs_vs_phase56": {}}
    for k in ("linear_ar4",) + FAMILIES:
        names = fit["feature_names"][k]
        F = ctx["F1"] if (k in FAMILIES and fit["variants"][k].endswith("F1") and ctx["use_f1"]) else ctx["F0"]
        X = F[names].to_numpy()[idx_all]
        p_new, p_art = fit["models"][k].predict(X), a["models"][k].predict(X)
        out["max_pred_diff_vs_artifact"] = max(out["max_pred_diff_vs_artifact"], float(np.max(np.abs(p_new - p_art))))
        if k in FAMILIES:
            rec = run["results"]["ml"][fit["variants"][k]]
            yv = ctx["yy"][ctx["sp"]["validation"]]
            yh = ctx["yy"][ctx["sp"]["holdout"]]
            nv = len(ctx["sp"]["validation"])
            mv, mh = float(np.mean(np.abs(p_new[:nv] - yv))), float(np.mean(np.abs(p_new[nv:] - yh)))
            out["mae_diffs_vs_phase56"][k] = {"validation": abs(mv - rec["validation"]["MAE"]), "holdout": abs(mh - rec["holdout"]["MAE"]), "variant": fit["variants"][k]}
    d = [v for kv in out["mae_diffs_vs_phase56"].values() for v in (kv["validation"], kv["holdout"])]
    out["reproduces_phase56"] = bool(max(d) <= max(tol, 1e-6) and out["max_pred_diff_vs_artifact"] <= tol)
    out["max_mae_diff"] = float(max(d))
    return out
