"""
p52_context.py — Phase 5.2：CPM 總電流的設備負載脈絡（只描述統計關聯，不推論因果）

* 負載狀態是『統計導出的候選狀態』：LOW / HIGH / TRANSITION / UNKNOWN。切點 = 開發期 CPM 的 Otsu 雙峰切點；不是已確認的設備運轉模式。
* CPM 對應的設備尚未確認；電流下降不被解讀成停機。全通道同時為 0 的列已在 p52_pipeline.prep 遮蔽成 NaN（UNKNOWN）。
* load_states() 是因果的：第 t 小時的狀態只由 ≤ t 的電流決定。
* 關聯檢定使用循環平移置換（保留序列自相關），以 p 值與富集倍率描述；它們是關聯證據，不是因果。
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))

import p52_config as C  # noqa: E402

LOW, HIGH, TRANSITION, UNKNOWN = "LOW", "HIGH", "TRANSITION", "UNKNOWN"


def fit_load_model(cur: pd.Series, fit_mask: pd.Series | None = None) -> dict | None:
    """由擬合期的 CPM 導出負載切點。雙峰不明顯 → None（不建立負載狀態，也不建立含負載脈絡的模型）。"""
    from p52_detectors import otsu_threshold
    v = cur if fit_mask is None else cur[fit_mask.reindex(cur.index).fillna(False)]
    v = v.dropna()
    thr = otsu_threshold(v.to_numpy())
    if thr is None:
        return None
    lo, hi = float(v[v < thr].median()), float(v[v >= thr].median())
    band = C.CONTEXT["transition_band_frac"] * min(thr - lo, hi - thr)          # 緩衝帶相對於『切點到較近模態』的距離，避免寬帶吞掉整個低負載模態
    return {"threshold": float(thr), "low_mode": lo, "high_mode": hi, "band": float(band), "n_fit_hours": int(len(v)),
            "low_hours": int((v < thr).sum()), "note": C.CONTEXT["note"]}


def load_states(cur: pd.Series, model: dict | None) -> pd.DataFrame:
    """候選負載狀態（因果）。TRANSITION = 落在切點±band 的緩衝帶，或與前一個有值小時的區域不同。"""
    if model is None:
        return pd.DataFrame({"state": UNKNOWN, "transition": False}, index=cur.index)
    thr, band = model["threshold"], model["band"]
    state = pd.Series(UNKNOWN, index=cur.index, dtype=object)
    state[cur < thr - band] = LOW
    state[cur > thr + band] = HIGH
    state[cur.notna() & (cur >= thr - band) & (cur <= thr + band)] = TRANSITION
    prev = state.where(state.isin([LOW, HIGH])).shift(1)
    crossed = state.isin([LOW, HIGH]) & prev.notna() & (state != prev)
    state[crossed] = TRANSITION
    return pd.DataFrame({"state": state, "transition": state == TRANSITION}, index=cur.index)


def near_transition_or_low(ls: pd.DataFrame, hours: int | None = None) -> pd.Series:
    """事後分析用（非即時）：該小時為 LOW，或 ±hours 小時內有 TRANSITION。UNKNOWN 的小時 → NaN（不納入檢定）。"""
    h = C.CONTEXT["coincidence_hours"] if hours is None else hours
    tr = ls["transition"].astype(float).rolling(2 * h + 1, center=True, min_periods=1).max() > 0
    out = ((ls["state"] == LOW) | tr).astype(float)
    return out.where(ls["state"] != UNKNOWN)


def do_by_load(y: pd.Series, ls: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for st in (LOW, HIGH, TRANSITION):
        v = y[(ls["state"] == st)].dropna()
        rows.append({"load_state": st, "n_hours": int(len(v)), "do_median": float(v.median()) if len(v) else np.nan,
                     "do_q25": float(v.quantile(.25)) if len(v) else np.nan, "do_q75": float(v.quantile(.75)) if len(v) else np.nan})
    return pd.DataFrame(rows)


def permutation_enrichment(alert: pd.Series, near: pd.Series, n: int | None = None, seed: int | None = None, min_alert: int | None = None) -> dict:
    """alert：布林（該小時 ALERT）；near：事後脈絡指標（LOW 或鄰近 TRANSITION，NaN = 未知）。
    統計量 = ALERT 小時落在 near 的比例；基準 = 全部有脈絡小時中 near 的比例；p = 循環平移 alert 的單尾置換 p 值。"""
    n = C.CONTEXT["permutation_n"] if n is None else n
    seed = C.CONTEXT["permutation_seed"] if seed is None else seed
    min_alert = C.CONTEXT["min_alert_hours_for_test"] if min_alert is None else min_alert
    ok = near.notna().to_numpy()
    a = alert.reindex(near.index).fillna(False).to_numpy(bool)
    b = near.fillna(0).to_numpy(float)
    n_alert = int((a & ok).sum())
    base = float(b[ok].mean()) if ok.any() else np.nan
    if n_alert < min_alert:
        return {"n_alert_hours_with_context": n_alert, "base_rate": base, "alert_near_share": np.nan, "enrichment": np.nan, "p_value": np.nan,
                "status": f"INSUFFICIENT_ALERTS(<{min_alert})"}
    stat = float(b[a & ok].mean())
    rng = np.random.default_rng(seed)
    L = len(a)
    cnt = 0
    for _ in range(n):
        s = int(rng.integers(1, L))
        ar = np.roll(a, s)
        m = ar & ok
        if m.sum() and b[m].mean() >= stat:
            cnt += 1
    return {"n_alert_hours_with_context": n_alert, "base_rate": base, "alert_near_share": stat, "enrichment": stat / base if base else np.nan,
            "p_value": (cnt + 1) / (n + 1), "status": "TESTED"}


def lead_lag(y: pd.Series, cur: pd.Series, max_lag: int | None = None, n_null: int = 300, seed: int | None = None) -> pd.DataFrame:
    """ΔDO 與 ΔCPM 的交叉相關。lag k>0：CPM 的變化發生在 DO 變化『之前』k 小時（CPM leads）；k<0：DO leads。
    差分遇 NaN 即 NaN（不跨缺口）；以循環平移估計『最大 |r|』的 95% 虛無上界。只描述時間先後的統計關聯，不是因果。"""
    K = C.CONTEXT["lead_lag_max_hours"] if max_lag is None else max_lag
    seed = C.CONTEXT["permutation_seed"] if seed is None else seed
    dy, dc = y.diff(), cur.diff()

    def corr_at(a, b, k):
        x, z = a, b.shift(k)
        m = x.notna() & z.notna()
        return float(np.corrcoef(x[m], z[m])[0, 1]) if m.sum() > 30 and x[m].std() > 0 and z[m].std() > 0 else np.nan
    rows = [{"lag_h": k, "corr": corr_at(dy, dc, k), "n_pairs": int((dy.notna() & dc.shift(k).notna()).sum())} for k in range(-K, K + 1)]
    out = pd.DataFrame(rows)
    rng = np.random.default_rng(seed)
    nulls = []
    arr = dc.to_numpy()
    for _ in range(n_null):
        s = int(rng.integers(24, len(arr) - 24)) if len(arr) > 60 else 1
        dcs = pd.Series(np.roll(arr, s), index=dc.index)
        c = [abs(corr_at(dy, dcs, k)) for k in range(-K, K + 1)]
        nulls.append(np.nanmax(c) if not np.all(np.isnan(c)) else np.nan)
    ub = float(np.nanquantile(nulls, 0.95)) if nulls else np.nan
    out["null_max_abs_corr_p95"] = ub
    out["exceeds_null"] = out["corr"].abs() > ub
    return out
