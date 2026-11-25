"""
p56_core.py — Phase 5.6：研究協定（PROTOCOL）與共用的因果資料建構

PROTOCOL 是『預先登記』的全部決策規則：資格門檻、切分、特徵、模型與固定超參數、選擇與推薦規則、預算、異常研究參數。
實驗開始前由 freeze_protocol() 寫入 outputs/phase5_6/experiment_protocol.json 並計算雜湊；之後任何一次實驗都會檢查雜湊，
常數若在凍結後被改動就拒絕執行（防止看過結果再調整規則）。超參數固定、不搜尋；不根據 Holdout 結果新增模型或調整參數。

因果性（沒有洩漏）：
* 特徵只用『預測起點 t（及更早，若有發布延遲 delay）』的資料；所有 rolling 都用 min_periods=window（視窗不完整就是 NaN，不補值）。
* 目標是 y[t+h]；缺的時間點不插補，不完整的樣本直接丟掉（所有模型與基準在同一批『共同評估點』上比較）。
* 切分依時間順序（Train → Validation → Holdout），並在切分處加『隔離區』（目標時間不得越過下一段的起點）；沒有隨機切分。
* 標準化等任何需要擬合的轉換只用訓練資料（本協定的模型不需要標準化；線性基準只用訓練資料擬合）。
"""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))

OUT = ROOT / "outputs" / "phase5_6"
PROTOCOL_FILE = OUT / "experiment_protocol.json"

PROTOCOL = {
    "version": "p56-protocol-v1",
    "horizons_h": [1, 3, 6],
    "history_h": 24,                                   # 每個樣本需要完整的 25 小時（t-24…t）觀測，且目標 y[t+h] 存在
    "split_fractions": {"train": 0.6, "validation": 0.2, "holdout": 0.2},   # 依可用樣本的時間順序；切分處有隔離區
    "rolling_origin_cv": {"n_folds": 3, "n_blocks": 4, "scheme": "expanding window on train∪validation; fold k trains on blocks ≤k and tests on block k+1 (purged)"},
    "eligibility": {"usable_eligible": 400, "usable_conditional": 150, "split_eligible": 100, "split_conditional": 40, "min_distinct": 10, "max_mode_ratio": 0.9, "min_observed_frac_conditional": 0.6,
                    "max_zero_ratio_conditional": 0.5},
    "target_kinds_allowed": ["continuous", "derived_index"],      # 狀態碼、計數器、校正斜率、風向角、識別碼都不是預測目標
    "feature_exclusions": {"measurement_kinds": ["state_code", "cumulative_counter", "calibration_parameter"], "classification": ["UNKNOWN"],
                           "reason": "反向因果（設備狀態）、編碼時間本身（累計計數器）、反映維護事件（校正斜率）；Phase 5.1 洩漏稽核的結論"},
    "feature_sets": {"F0": "own history (lags 0,1,2,3,6,12,24; rolling mean/std 6,24; min/max 24) + hour sin/cos (+ day-of-week sin/cos only if span ≥ 56 days)",
                     "F1": "F0 + up to 8 same-domain sensors (lags 0,3; rolling mean 6) chosen by |Spearman| with the target on TRAIN origins only; observed fraction on train ≥ 0.9"},
    "lags": [0, 1, 2, 3, 6, 12, 24], "roll_windows": [6, 24], "cross_lags": [0, 3], "cross_roll": 6, "max_cross_sensors": 8, "cross_min_train_obs_frac": 0.9, "dow_min_span_days": 56,
    "baselines": {"persistence": "y[t]", "moving_average": "mean(y[t-5..t])", "seasonal_naive_24h": "y[t+h-24]; valid only if on TRAIN: hour-of-day eta^2 ≥ 0.10 AND gap-aware ACF(24) ≥ 0.30",
                  "linear_ar4": "Ridge(alpha=1.0) on y[t],y[t-1],y[t-2],y[t-3]; fitted on train only"},
    "seasonal_valid_eta2": 0.10, "seasonal_valid_acf24": 0.30,
    "models": {"HGB": {"class": "sklearn.ensemble.HistGradientBoostingRegressor", "params": {"max_iter": 200, "learning_rate": 0.05, "max_depth": 4, "min_samples_leaf": 20, "early_stopping": False, "random_state": 0}},
               "XGB": {"class": "xgboost.XGBRegressor", "params": {"n_estimators": 300, "learning_rate": 0.05, "max_depth": 4, "subsample": 0.8, "colsample_bytree": 0.8, "reg_lambda": 1.0,
                                                                  "tree_method": "hist", "n_jobs": 2, "random_state": 0}}},
    "selection_rules": {"best_valid_baseline": "lowest VALIDATION MAE among valid baselines", "best_ml": "lowest VALIDATION MAE among HGB/XGB × F0/F1", "holdout_use": "reported once for confirmation; never used to select or tune"},
    "recommendation_rules": {"ml_candidate": "ML validation MAE improves ≥ 5% vs best valid baseline AND improves in ≥ 2 of 3 CV folds vs that fold's best baseline AND holdout relative improvement ≥ 0 (confirmation)",
                             "otherwise": "BASELINE_RECOMMENDED (the best valid baseline is kept; ML is not recommended just to have AI)", "min_ml_gain": 0.05, "unstable_baseline_mae_over_train_std": 0.01},
    "metrics": ["MAE", "RMSE", "Bias", "scaled_MAE (MAE / train std)", "relative_improvement vs persistence", "relative_improvement vs best valid baseline", "per-fold", "high-error periods (top 5% abs error)", "by target tercile"],
    "cross_domain_comparison": "only scaled_MAE and relative improvements; absolute MAE across different physical quantities/units is never ranked",
    "prediction_intervals": "not built in Phase 5.6 (no coverage claims); Phase 3 CQR parameters are not transferred to other domains",
    "publication_delay_sensitivity": {"delay_h": 1, "applies_to": "pilot tasks", "meaning": "features only use values ≤ t-1 (target still y[t+h])"},
    "budget": {"max_targets_per_domain": 5, "max_one_target_per_sensor_type": True,
               "operational_priority_sensor_types": ["Air Temperature", "Relative Humidity", "Temperature-Humidity Index (THI)", "Dissolved Oxygen", "pH", "Water Temperature", "Particulate Matter PM2.5", "Electrical Current (load)"],
               "priority": "ranking key (decided BEFORE any model result): (1) operational relevance: sensor types in operational_priority_sensor_types first; (2) ELIGIBLE before CONDITIONAL; (3) usable_samples(h=3) × (1 - zero_ratio) descending; (4) column order",
               "pilot": "highest-priority target per domain at h=3",
               "never": "no grid search; no new models or hyperparameters after seeing validation/holdout results"},
    "forecasting_holdout_disclosure": "all datasets were profiled in earlier phases; Phase 5.6 holdouts are exploratory time backtests, not blind or independent validation. For 專家系統 the last 20% overlaps the Phase 5.2 holdout window; the Phase 5.2 ledger is not touched and no anomaly detector is selected on it.",
    "anomaly": {"expert_system_anomaly_cutoff": "2026-08-24 11:00:00", "note": "Phase 5.2 holdout window (≥ 2026-08-24 12:00) is excluded from every Phase 5.6 anomaly-detector fit/selection/evaluation",
                "split": {"fit": 0.7, "validation": 0.3}, "robust_z_threshold": 5.0, "ewma": {"lambda": 0.2, "L": 3.0}, "cusum_on_daily_means": {"min_seg_days": 5, "thr_sd": 1.0},
                "isolation_forest": {"n_estimators": 100, "contamination": "auto", "random_state": 0, "exploratory_only": True}, "synthetic_injection": {"seed": 20260101, "n_per_type": 20, "magnitude_sd": [3.0, 6.0]},
                "claims": "no fault-detection accuracy, no equipment-failure recall; synthetic detection rates are reported per anomaly type and are not real-fault recall"},
    "research_status_path": ["Research Candidate", "Experiment Completed", "Validation Pending", "Eligible for Independent Review"],
}


def protocol_hash() -> str:
    return hashlib.sha256(json.dumps(PROTOCOL, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()[:16]


def freeze_protocol() -> dict:
    """寫入凍結的協定（只在不存在時）。已存在且雜湊不同 → 拒絕（不能偷偷改規則）。"""
    OUT.mkdir(parents=True, exist_ok=True)
    h = protocol_hash()
    if PROTOCOL_FILE.is_file():
        cur = json.loads(PROTOCOL_FILE.read_text(encoding="utf-8"))
        if cur["protocol_hash"] != h:
            raise RuntimeError(f"協定在凍結後被改動：凍結 {cur['protocol_hash']} ≠ 目前 {h}。請還原，或以新版本（新檔案）重新登記並說明原因。")
        return cur
    from datetime import datetime
    rec = {"protocol_hash": h, "frozen_at": datetime.now().isoformat(timespec="seconds"), "protocol": PROTOCOL}
    PROTOCOL_FILE.write_text(json.dumps(rec, ensure_ascii=False, indent=1), encoding="utf-8")
    return rec


def check_frozen() -> dict:
    if not PROTOCOL_FILE.is_file():
        raise RuntimeError("實驗協定尚未凍結：請先執行 freeze_protocol()（在任何模型評估之前）")
    cur = json.loads(PROTOCOL_FILE.read_text(encoding="utf-8"))
    if cur["protocol_hash"] != protocol_hash():
        raise RuntimeError(f"協定與凍結版不同（凍結 {cur['protocol_hash']}、目前 {protocol_hash()}）：拒絕執行。")
    return cur


def code_hash(files=("src/p56_core.py", "src/p56_bench.py")) -> str:
    h = hashlib.sha256()
    for f in files:
        p = ROOT / f
        if p.is_file():
            h.update(p.read_bytes())
    return h.hexdigest()[:16]


# ------------------------------------------------------------------------------ 可用樣本與切分
def usable_mask(y: np.ndarray, h: int, delay: int = 0, hist: int | None = None) -> np.ndarray:
    """origin t 可用：y[t-delay-hist .. t-delay] 全部有觀測，且目標 y[t+h] 有觀測。"""
    hist = PROTOCOL["history_h"] if hist is None else hist
    n = len(y)
    present = ~np.isnan(y)
    c = np.r_[0, np.cumsum(present.astype(int))]
    t = np.arange(n)
    lo, hi = t - delay - hist, t - delay
    ok = (lo >= 0) & (t + h < n)
    out = np.zeros(n, dtype=bool)
    idx = np.where(ok)[0]
    out[idx] = ((c[hi[idx] + 1] - c[lo[idx]]) == hist + 1) & present[idx + h]
    return out


def chrono_split(origins: np.ndarray, h: int, fr: dict | None = None) -> dict:
    """依時間順序把可用 origin 切成 train／validation／holdout；切分處加隔離區：上一段的目標時間（t+h）必須早於下一段的第一個 origin。"""
    fr = fr or PROTOCOL["split_fractions"]
    o = np.sort(origins)
    n = len(o)
    i1, i2 = int(n * fr["train"]), int(n * (fr["train"] + fr["validation"]))
    if n == 0:
        return {"train": o, "validation": o, "holdout": o, "val_start": None, "hold_start": None}
    val_start, hold_start = o[i1] if i1 < n else None, o[i2] if i2 < n else None
    tr = o[:i1]
    va = o[i1:i2]
    ho = o[i2:]
    if val_start is not None:
        tr = tr[tr + h < val_start]
    if hold_start is not None:
        va = va[va + h < hold_start]
    return {"train": tr, "validation": va, "holdout": ho, "val_start": val_start, "hold_start": hold_start}


def cv_folds(origins: np.ndarray, h: int) -> list[dict]:
    """開發期的 Rolling-Origin（expanding window）：把 train∪validation 的 origin 依序分成 n_blocks 段；fold k 以前 k 段訓練、第 k+1 段測試（含隔離區）。"""
    cfg = PROTOCOL["rolling_origin_cv"]
    o = np.sort(origins)
    blocks = np.array_split(o, cfg["n_blocks"])
    folds = []
    for k in range(1, cfg["n_folds"] + 1):
        train = np.concatenate(blocks[:k])
        test = blocks[k]
        if len(test) == 0:
            continue
        train = train[train + h < test[0]]
        folds.append({"fold": k, "train": train, "test": test})
    return folds


# ------------------------------------------------------------------------------ 因果特徵
def own_features(g: pd.DataFrame, target: str, delay: int = 0, use_dow: bool = False) -> pd.DataFrame:
    """F0：只用目標自己的歷史（含 delay）與日曆特徵。所有 rolling 的視窗不完整就是 NaN。"""
    P = PROTOCOL
    y = g[target].shift(delay)
    F = {}
    for k in P["lags"]:
        F[f"lag{k}"] = y.shift(k)
    for w in P["roll_windows"]:
        F[f"roll_mean{w}"] = y.rolling(w, min_periods=w).mean()
        F[f"roll_std{w}"] = y.rolling(w, min_periods=w).std()
    F["roll_min24"] = y.rolling(24, min_periods=24).min()
    F["roll_max24"] = y.rolling(24, min_periods=24).max()
    hr = g.index.hour.to_numpy()
    F["hour_sin"] = np.sin(2 * np.pi * hr / 24)
    F["hour_cos"] = np.cos(2 * np.pi * hr / 24)
    if use_dow:
        dw = g.index.dayofweek.to_numpy()
        F["dow_sin"] = np.sin(2 * np.pi * dw / 7)
        F["dow_cos"] = np.cos(2 * np.pi * dw / 7)
    return pd.DataFrame(F, index=g.index)


def cross_features(g: pd.DataFrame, cols: list[str], delay: int = 0) -> pd.DataFrame:
    P = PROTOCOL
    F = {}
    for c in cols:
        y = g[c].shift(delay)
        for k in P["cross_lags"]:
            F[f"x[{c}]_lag{k}"] = y.shift(k)
        F[f"x[{c}]_roll{P['cross_roll']}"] = y.rolling(P["cross_roll"], min_periods=P["cross_roll"]).mean()
    return pd.DataFrame(F, index=g.index)
