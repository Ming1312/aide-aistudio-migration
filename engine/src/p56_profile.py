"""
p56_profile.py — Phase 5.6A：Universal Data Profiling（七份資料用完全相同的程序剖析；只讀、不訓練、不預測）

不依場域名稱決定怎麼分析：每份資料都產生相同的表格（欄位、時間序列、分布、時間結構、多變量）。語義（物理量、單位狀態、欄位型態）只用來『避免誤判』，
例如：狀態碼、累計計數器、校正斜率、風向角不會被當成一般連續量測；零值、缺值、卡值、條件式零值、合法平台值是分開處理的（沿用 Phase 5.5 的 p55_quality 語義）。

重要原則
* 資料有時間缺口：自相關、延遲相關一律只用『兩端都有觀測』的時間點配對（不插補、不把不連續資料當成等間距序列）。
* 時間戳記只有『日期＋小時』且沒有時區：標示 TIMEZONE_UNVERIFIED；時鐘漂移無法評估（沒有分鐘資訊）。
* 相關不是因果。延遲相關的檢定考慮自相關（有效樣本數 n_eff），並對整批檢定做 Benjamini–Hochberg 校正；報告檢定總數。
"""
from __future__ import annotations

import math
import sys
import warnings
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))

import p55_analysis as AN  # noqa: E402
import p55_classify as CL  # noqa: E402
import p55_quality as QL  # noqa: E402

warnings.filterwarnings("ignore", message=".*ConstantInputWarning.*")
warnings.filterwarnings("ignore", category=Warning, module="scipy")
TZ_STATUS = "TIMEZONE_UNVERIFIED"
CLOCK_DRIFT = "NOT_ASSESSABLE（只有日期＋小時，沒有分鐘或第二個時鐘）"
ACF_LAGS = (1, 3, 6, 12, 24, 48, 168)
MIN_PAIRS = 100
MIN_SPAN_DAYS_DAILY, MIN_SPAN_DAYS_WEEKLY = 7, 28
LAG_RANGE = range(-12, 13)
LAG_MIN_ALIGNED = 200
Q_THRESHOLD, R_THRESHOLD = 0.01, 0.30
REDUNDANT_RHO = 0.98
MAX_MULTICOLLINEARITY_COLS = 15


# ------------------------------------------------------------------------------ 共用
def continuous_columns(b: dict, min_obs_frac: float = 0.0) -> list[str]:
    """可作為『連續量測』分析的欄位：型態為 continuous／derived_index、分類不是 UNKNOWN、且有足夠觀測。"""
    n = len(b["df"])
    return [r.original_column_name for r in b["cls"]["rows"] if r.measurement_kind in ("continuous", "derived_index") and r.classification_status != CL.UNKNOWN
            and r.numeric_evidence["n_observed"] >= max(48, min_obs_frac * n)]


def grid(b: dict) -> pd.DataFrame:
    """等間隔（1h）時間軸；缺的時間點是 NaN（不插補）。"""
    return QL.hourly_frame(b["df"])


def segments_of(present: np.ndarray, min_len: int = 1) -> list[tuple[int, int]]:
    return [(a, z) for a, z in QL.runs_of(present) if z - a + 1 >= min_len]


def lagged_corr(x: np.ndarray, y: np.ndarray, lag: int, method: str = "pearson") -> tuple[float, int]:
    """corr(x[t], y[t+lag])：只用兩端都有觀測的時間點（不插補）。lag>0 ＝ x 領先 y。"""
    if lag > 0:
        a, c = x[:-lag], y[lag:]
    elif lag < 0:
        a, c = x[-lag:], y[:lag]
    else:
        a, c = x, y
    m = ~np.isnan(a) & ~np.isnan(c)
    n = int(m.sum())
    if n < MIN_PAIRS:
        return float("nan"), n
    a, c = a[m], c[m]
    if method == "spearman":
        a, c = pd.Series(a).rank().to_numpy(), pd.Series(c).rank().to_numpy()
    if np.std(a) == 0 or np.std(c) == 0:
        return float("nan"), n
    return float(np.corrcoef(a, c)[0, 1]), n


def acf_gap_aware(x: np.ndarray, lag: int) -> tuple[float, int]:
    """自相關（只用相距 lag 小時、兩端都有觀測的配對；以全序列平均與變異標準化）。"""
    m = ~np.isnan(x)
    if m.sum() < MIN_PAIRS:
        return float("nan"), 0
    mu, var = float(np.nanmean(x)), float(np.nanvar(x))
    if var == 0:
        return float("nan"), 0
    a, c = x[:-lag], x[lag:]
    ok = ~np.isnan(a) & ~np.isnan(c)
    n = int(ok.sum())
    if n < MIN_PAIRS:
        return float("nan"), n
    return float(np.mean((a[ok] - mu) * (c[ok] - mu)) / var), n


def n_eff(n: int, r1x: float, r1y: float) -> float:
    """有效樣本數（Bartlett 近似）：考慮兩個序列的一階自相關。下限 5。"""
    if not (r1x == r1x and r1y == r1y):
        return float(max(n, 5))
    prod = max(min(r1x * r1y, 0.99), -0.99)
    return float(max(5.0, n * (1 - prod) / (1 + prod)))


def corr_pvalue(r: float, neff: float) -> float:
    from scipy import stats
    if r != r or abs(r) >= 1 or neff <= 2:
        return float("nan")
    t = r * math.sqrt((neff - 2) / (1 - r * r))
    return float(2 * stats.t.sf(abs(t), neff - 2))


def bh_adjust(p: np.ndarray) -> np.ndarray:
    """Benjamini–Hochberg 校正（忽略 NaN）。回傳與輸入同形狀的 q 值。"""
    p = np.asarray(p, dtype=float)
    q = np.full_like(p, np.nan)
    ok = ~np.isnan(p)
    pv = p[ok]
    if pv.size == 0:
        return q
    order = np.argsort(pv)
    ranked = pv[order] * pv.size / (np.arange(pv.size) + 1)
    ranked = np.minimum.accumulate(ranked[::-1])[::-1]
    out = np.empty_like(pv)
    out[order] = np.minimum(ranked, 1.0)
    q[ok] = out
    return q


# ------------------------------------------------------------------------------ A1 欄位剖析
def inferred_type(r: CL.SensorClass, s: pd.Series) -> str:
    v = s.dropna()
    if v.empty:
        return "empty"
    if r.measurement_kind == "state_code":
        return "categorical_code"
    if r.measurement_kind == "cumulative_counter":
        return "counter"
    if v.nunique() == 1:
        return "constant"
    if bool(np.all(np.isclose(v, np.round(v)))) and v.nunique() <= 12:
        return "low_cardinality_integer"
    if bool(np.all(np.isclose(v, np.round(v)))) and v.is_monotonic_increasing:
        return "counter_or_identifier_like"
    return "continuous_float"


def semantic_class(r: CL.SensorClass, itype: str) -> str:
    if itype in ("constant", "empty"):
        return itype
    if itype == "counter_or_identifier_like":
        return "identifier_or_counter"
    if r.sensor_type == "Battery Level":
        return "bounded_percentage(plateau at limits is legitimate)"
    return {"continuous": "continuous_measurement", "derived_index": "derived_index", "state_code": "state_code", "cumulative_counter": "counter", "circular_angle": "circular_angle",
            "calibration_parameter": "calibration_parameter"}.get(r.measurement_kind, "unknown")


def column_profile(b: dict) -> pd.DataFrame:
    df, stem = b["df"], b["stem"]
    S = b["quality"]["sensors"].set_index("sensor")
    runs = b["quality"]["runs"]
    rows = []
    for r in b["cls"]["rows"]:
        c = r.original_column_name
        s = pd.to_numeric(df[c], errors="coerce")
        v = s.dropna()
        itype = inferred_type(r, s)
        rr = runs[runs["sensor"] == c] if len(runs) else runs
        flags = []
        if len(rr):
            for rt, g in rr.groupby("run_type"):
                nf = int((g["severity"] != "info").sum())
                if nf:
                    flags.append(f"{rt.upper()}_RUNS:{nf}")
                ni = int((g["severity"] == "info").sum())
                if ni:
                    flags.append(f"{rt.upper()}_INFO:{ni}")
        if int(S.loc[c, "invalid_candidates"]):
            flags.append(f"OUT_OF_EXPECTED_RANGE:{int(S.loc[c, 'invalid_candidates'])}")
        if int(S.loc[c, "outlier_candidates"]):
            flags.append(f"OUTLIER_CANDIDATES:{int(S.loc[c, 'outlier_candidates'])}")
        if r.classification_status != CL.CLASSIFIED:
            flags.append(f"CLASSIFICATION_{r.classification_status}")
        row = {"domain": stem, "column": c, "inferred_type": itype, "semantic_class": semantic_class(r, itype), "n_rows": int(len(s)), "n_observed": int(len(v)), "missing_rate": round(1 - len(v) / len(s), 4) if len(s) else np.nan,
               "unique_count": int(v.nunique()), "min": v.min() if len(v) else np.nan, "max": v.max() if len(v) else np.nan, "mean": v.mean() if len(v) else np.nan, "median": v.median() if len(v) else np.nan,
               "std": v.std(ddof=1) if len(v) > 1 else np.nan, **{f"q{int(q * 100):02d}": (v.quantile(q) if len(v) else np.nan) for q in AN.QUANTILES},
               "constant_ratio": round(float((v == v.mode().iloc[0]).mean()), 4) if len(v) else np.nan, "zero_ratio": round(float((v == 0).mean()), 4) if len(v) else np.nan,
               "suspected_physical_quantity": r.sensor_type, "sensor_group": r.sensor_group, "unit": r.unit, "unit_status": r.unit_verification_status, "classification_status": r.classification_status,
               "quality_flags": ";".join(flags) or "NONE"}
        rows.append(row)
    return pd.DataFrame(rows)


# ------------------------------------------------------------------------------ A2 時間序列剖析
def timeseries_profile(b: dict) -> dict:
    d = b["df"]
    t = b["quality"]["timestamp"]
    ts = pd.to_datetime(d["timestamp"]).drop_duplicates().sort_values().reset_index(drop=True)
    step = pd.Timedelta(hours=b["cls"].get("frequency_h") or 1)
    full = pd.date_range(ts.min(), ts.max(), freq=step)
    present = np.isin(full, ts.to_numpy())
    segs = segments_of(present)
    lens = [z - a + 1 for a, z in segs]
    diffs = ts.diff().dropna()
    mode = diffs.mode().iloc[0] if len(diffs) else step
    cols = [r.original_column_name for r in b["cls"]["rows"]]
    all_missing = int(d[cols].isna().all(axis=1).sum())
    return {"domain": b["stem"], "start": str(t["start"]), "end": str(t["end"]), "observed_rows": t["n_rows"], "expected_rows": t["expected_hours"], "sampling_interval_h": float(mode / pd.Timedelta(hours=1)),
            "coverage": t["timestamp_coverage"], "missing_timestamps": t["expected_hours"] - t["n_unique_timestamps"], "duplicate_timestamps": t["duplicate_timestamps"], "n_continuous_segments": len(segs),
            "longest_continuous_segment_h": max(lens, default=0), "segments_ge_24h": int(sum(x >= 24 for x in lens)), "segments_ge_168h": int(sum(x >= 168 for x in lens)),
            "irregular_sampling_fraction": round(float((diffs != mode).mean()), 4) if len(diffs) else 0.0, "rows_with_all_sensors_missing": all_missing, "clock_drift": CLOCK_DRIFT, "timezone_status": TZ_STATUS,
            "continuous_segment_lengths_top5": ";".join(str(x) for x in sorted(lens, reverse=True)[:5])}


# ------------------------------------------------------------------------------ A3 分布
def bimodality(x: np.ndarray) -> tuple[float, int]:
    n = len(x)
    if n < 100:
        return float("nan"), 0
    s = pd.Series(x)
    skew, kurt = float(s.skew()), float(s.kurt())
    bc = (skew ** 2 + 1) / (kurt + 3 * (n - 1) ** 2 / ((n - 2) * (n - 3)))
    from scipy.signal import find_peaks
    h, _ = np.histogram(x, bins=min(40, max(10, int(math.sqrt(n)))))
    sm = np.convolve(h, np.ones(3) / 3, mode="same")
    pk, _ = find_peaks(sm, prominence=0.1 * sm.max())
    return float(bc), int(len(pk))


def distribution_profile(b: dict) -> pd.DataFrame:
    df, stem = b["df"], b["stem"]
    S = b["quality"]["sensors"].set_index("sensor")
    runs = b["quality"]["runs"]
    n = len(df)
    rows = []
    for c in continuous_columns(b):
        v = pd.to_numeric(df[c], errors="coerce").dropna().to_numpy()
        half = len(df) // 2
        a = pd.to_numeric(df[c].iloc[:half], errors="coerce").dropna().to_numpy()
        z = pd.to_numeric(df[c].iloc[half:], errors="coerce").dropna().to_numpy()
        ks = AN.ks_stat(a, z) if len(a) >= 72 and len(z) >= 72 else float("nan")
        iqr = float(np.subtract(*np.percentile(v, [75, 25])))
        shift = (np.median(z) - np.median(a)) / iqr if (len(a) and len(z) and iqr > 0) else float("nan")
        bc, peaks = bimodality(v)
        rr = runs[runs["sensor"] == c] if len(runs) else runs
        def cnt(rt, sev=None):
            if not len(rr):
                return 0
            g = rr[rr["run_type"] == rt]
            return int(len(g) if sev is None else (g["severity"] == sev).sum())
        s = pd.Series(v)
        rows.append({"domain": stem, "column": c, "n_observed": len(v), "skewness": float(s.skew()), "excess_kurtosis": float(s.kurt()), "outlier_candidates_robust_z5": int(S.loc[c, "outlier_candidates"]),
                     "zero_runs_flagged": int(S.loc[c, "n_zero_runs_flagged"]), "zero_runs_legit_or_conditional_long": int(S.loc[c, "n_zero_runs_legit_long"]), "flatline_runs_flagged": cnt("flatline", "check"),
                     "flatline_plateau_info": cnt("flatline", "info"), "bimodality_coefficient": bc, "histogram_peaks": peaks, "suspected_multimodal": bool(bc == bc and bc > 0.555 and peaks >= 2),
                     "ks_D_first_vs_second_half": ks, "median_shift_first_to_second_half_in_IQR": shift, "distribution_shift_candidate": bool(ks == ks and ks >= 0.3)})
    return pd.DataFrame(rows)


# ------------------------------------------------------------------------------ A4 時間結構
def eta_squared(values: np.ndarray, groups: np.ndarray) -> float:
    m = ~np.isnan(values)
    v, g = values[m], groups[m]
    tot = float(((v - v.mean()) ** 2).sum())
    if tot == 0 or len(v) < 30:
        return float("nan")
    bet = float(sum(len(v[g == k]) * (v[g == k].mean() - v.mean()) ** 2 for k in np.unique(g)))
    return bet / tot


def binary_segmentation(x: np.ndarray, min_seg: int = 5, thr: float = 1.0, max_cp: int = 3) -> list[int]:
    """平均數位移的二元分割（在『每日平均』序列上）。候選條件：兩側各 ≥ min_seg 天、位移 ≥ thr × 合併標準差。只是候選，不是確認的變化點。"""
    cps: list[int] = []

    def rec(lo: int, hi: int):
        if len(cps) >= max_cp or hi - lo < 2 * min_seg:
            return
        seg = x[lo:hi]
        best, bi = 0.0, None
        sd = float(np.std(seg)) or 1.0
        for i in range(min_seg, len(seg) - min_seg + 1):
            d = abs(seg[:i].mean() - seg[i:].mean()) / sd
            if d > best:
                best, bi = d, i
        if bi is not None and best >= thr:
            cps.append(lo + bi)
            rec(lo, lo + bi)
            rec(lo + bi, hi)
    rec(0, len(x))
    return sorted(cps)


def temporal_profile(b: dict) -> tuple[pd.DataFrame, pd.DataFrame]:
    g = grid(b)
    stem = b["stem"]
    span_days = (g.index.max() - g.index.min()) / pd.Timedelta(days=1)
    rows, cps = [], []
    hours = g.index.hour.to_numpy()
    dows = g.index.dayofweek.to_numpy()
    for c in continuous_columns(b):
        x = g[c].to_numpy(dtype=float)
        nobs = int((~np.isnan(x)).sum())
        row = {"domain": stem, "column": c, "n_observed": nobs, "span_days": round(span_days, 1)}
        for lag in ACF_LAGS:
            r, n = acf_gap_aware(x, lag)
            row[f"acf_lag{lag}h"] = r
            row[f"acf_lag{lag}h_pairs"] = n
        row["daily_seasonality_eta2"] = eta_squared(x, hours) if span_days >= MIN_SPAN_DAYS_DAILY and nobs >= 72 else float("nan")
        weekly_ok = span_days >= MIN_SPAN_DAYS_WEEKLY and nobs >= 24 * 28
        row["weekly_seasonality_eta2"] = eta_squared(x, dows) if weekly_ok else float("nan")
        row["weekly_note"] = "" if weekly_ok else f"INSUFFICIENT_SPAN（需 ≥ {MIN_SPAN_DAYS_WEEKLY} 天且 ≥ 4 週的觀測；目前 {span_days:.0f} 天）"
        obs_idx = np.where(~np.isnan(x))[0]
        if nobs >= 48:
            t_days = obs_idx / 24.0
            from scipy import stats
            rho, _ = stats.spearmanr(t_days, x[obs_idx])
            row["trend_spearman_rho"] = float(rho)
            row["trend_slope_per_day"] = float(np.polyfit(t_days, x[obs_idx], 1)[0])
        rs = pd.Series(x).rolling(24, min_periods=20).std()
        row["rolling24_std_median"] = float(rs.median()) if rs.notna().any() else float("nan")
        row["rolling24_std_cv"] = float(rs.std() / rs.mean()) if rs.notna().sum() > 10 and rs.mean() else float("nan")
        v = x[~np.isnan(x)]
        half = len(x) // 2
        a, z = x[:half][~np.isnan(x[:half])], x[half:][~np.isnan(x[half:])]
        iqr = float(np.subtract(*np.percentile(v, [75, 25]))) if len(v) else float("nan")
        row["temporal_stability_median_shift_in_IQR"] = float(abs(np.median(z) - np.median(a)) / iqr) if len(a) > 30 and len(z) > 30 and iqr > 0 else float("nan")
        daily = pd.Series(x, index=g.index).groupby(g.index.normalize()).agg(["mean", "count"])
        daily = daily[daily["count"] >= 18]
        row["n_days_with_enough_data"] = int(len(daily))
        found = binary_segmentation(daily["mean"].to_numpy()) if len(daily) >= 12 else []
        row["change_point_candidates"] = len(found)
        for i in found:
            cps.append({"domain": stem, "column": c, "candidate_date": str(daily.index[i].date()), "mean_before": float(daily["mean"].iloc[max(0, i - 5):i].mean()), "mean_after": float(daily["mean"].iloc[i:i + 5].mean()),
                        "note": "候選：只表示每日平均有位移，不代表設備或環境事件已確認"})
        rows.append(row)
    return pd.DataFrame(rows), pd.DataFrame(cps, columns=["domain", "column", "candidate_date", "mean_before", "mean_after", "note"])


# ------------------------------------------------------------------------------ A5 多變量
def multivariate_profile(b: dict) -> dict:
    g = grid(b)
    stem = b["stem"]
    cols = [c for c in continuous_columns(b, 0.3)]
    X = g[cols].to_numpy(dtype=float)
    r1 = {c: acf_gap_aware(g[c].to_numpy(dtype=float), 1)[0] for c in cols}
    pair_rows, lag_rows = [], []
    p_all, idx = [], []
    for i, a in enumerate(cols):
        for j in range(i + 1, len(cols)):
            c = cols[j]
            pr, n = lagged_corr(X[:, i], X[:, j], 0, "pearson")
            sr, _ = lagged_corr(X[:, i], X[:, j], 0, "spearman")
            if n < MIN_PAIRS:
                continue
            ne = n_eff(n, r1[a], r1[c])
            pair_rows.append({"domain": stem, "sensor_a": a, "sensor_b": c, "n_pairs": n, "n_eff": round(ne, 1), "pearson": pr, "spearman": sr, "p_value": corr_pvalue(pr, ne),
                              "redundant_candidate": bool(sr == sr and abs(sr) >= REDUNDANT_RHO)})
            if n >= LAG_MIN_ALIGNED:
                for lag in LAG_RANGE:
                    r, nl = lagged_corr(X[:, i], X[:, j], lag)
                    if r == r:
                        lag_rows.append({"domain": stem, "leader": a, "follower": c, "lag_h": lag, "n_pairs": nl, "r": r, "p_value": corr_pvalue(r, n_eff(nl, r1[a], r1[c]))})
    P = pd.DataFrame(pair_rows)
    L = pd.DataFrame(lag_rows)
    n_tests_pairs, n_tests_lag = len(P), len(L)
    if len(P):
        P["q_value_BH"] = bh_adjust(P["p_value"].to_numpy())
    if len(L):
        L["q_value_BH"] = bh_adjust(L["p_value"].to_numpy())
    # 只保留『q<0.01 且 |r|≥0.3』的最佳延遲（每個感測器配對一筆）；檢定總數一併回報
    best = pd.DataFrame()
    if len(L):
        sig = L[(L["q_value_BH"] < Q_THRESHOLD) & (L["r"].abs() >= R_THRESHOLD)]
        if len(sig):
            best = sig.loc[sig.groupby(["leader", "follower"])["r"].apply(lambda s: s.abs().idxmax())].sort_values("r", key=lambda s: -s.abs())
            best = best.assign(note="Correlation ≠ Causation；延遲相關只描述時間同步程度；已用 n_eff 與 BH 校正")
    # 多重共線性（標準化後的完整樣本）
    vif = pd.DataFrame()
    cand = [c for c in cols][:MAX_MULTICOLLINEARITY_COLS]
    if len(cand) >= 3:
        Z = g[cand].dropna()
        if len(Z) >= 300:
            Zs = (Z - Z.mean()) / Z.std(ddof=0).replace(0, np.nan)
            Zs = Zs.dropna(axis=1)
            if Zs.shape[1] >= 3:
                R = np.corrcoef(Zs.to_numpy(), rowvar=False)
                try:
                    v = np.diag(np.linalg.inv(R))
                    vif = pd.DataFrame({"domain": stem, "sensor": Zs.columns, "VIF": v, "n_complete_rows": len(Zs), "condition_number": float(np.linalg.cond(R))})
                except np.linalg.LinAlgError:
                    vif = pd.DataFrame({"domain": stem, "sensor": Zs.columns, "VIF": np.inf, "n_complete_rows": len(Zs), "condition_number": float("inf")})
    # 可能的導出變數：資料內建 THI 與溫濕度公式一致（在所有溫度×濕度配對中，找出與該欄位最吻合的一組；只做描述）
    derived = []
    temps = [r.original_column_name for r in b["cls"]["rows"] if r.sensor_type == "Air Temperature"]
    rhs = [r.original_column_name for r in b["cls"]["rows"] if r.sensor_type == "Relative Humidity"]
    for thi in [r.original_column_name for r in b["cls"]["rows"] if r.sensor_type.startswith("Temperature-Humidity Index")]:
        bm = None
        for t_ in temps:
            for h_ in rhs:
                x = pd.concat([AN.thi_from(g[t_], g[h_]).rename("calc"), g[thi].rename("given")], axis=1).dropna()
                if len(x) > 100:
                    c = float(x.corr().iloc[0, 1])
                    if bm is None or c > bm[0]:
                        bm = (c, t_, h_, len(x), float((x["calc"] - x["given"]).abs().max()))
        if bm:
            derived.append({"domain": stem, "derived_column": thi, "formula": f"NRC THI({bm[1]}, {bm[2]})", "n": bm[3], "corr": bm[0], "max_abs_diff": bm[4],
                            "implication": "該欄位是溫濕度的導出變數（公式可由其來源欄位重現）；預測任務需確認特徵不含目標當下之後的資訊（見洩漏稽核）"})
    return {"pairs": P, "lag_best": best, "vif": vif, "derived": pd.DataFrame(derived), "n_tests": {"pairwise": n_tests_pairs, "lagged": n_tests_lag, "total": n_tests_pairs + n_tests_lag}, "n_sensors": len(cols)}


# ------------------------------------------------------------------------------ 全部資料
def profile_all(stems: list[str]) -> dict:
    out = {k: [] for k in ("columns", "timeseries", "distribution", "temporal", "change_points", "pairs", "lag_best", "vif", "derived")}
    tests = {}
    for stem in stems:
        b = AN.load_bundle(stem)
        out["columns"].append(column_profile(b))
        out["timeseries"].append(pd.DataFrame([timeseries_profile(b)]))
        out["distribution"].append(distribution_profile(b))
        t, cp = temporal_profile(b)
        out["temporal"].append(t)
        out["change_points"].append(cp)
        mv = multivariate_profile(b)
        for k in ("pairs", "lag_best", "vif", "derived"):
            out[k].append(mv[k])
        tests[stem] = {**mv["n_tests"], "n_sensors": mv["n_sensors"]}
    res = {k: pd.concat([x for x in v if len(x)], ignore_index=True) if any(len(x) for x in v) else pd.DataFrame() for k, v in out.items()}
    res["n_tests"] = tests
    return res
