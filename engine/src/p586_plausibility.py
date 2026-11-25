"""
p586_plausibility.py — 合成資料的物理合理性：約束（generator 用）＋檢查（驗收用）

* enforce(stem, df)：把產生的資料壓回物理上可能的範圍（值域、相對濕度、PM10≥PM2.5、THI 公式、功率因數、累積計數器單調…）。
* check(stem, df)：獨立檢查同一批規則（不依賴 generator 的內部狀態），回傳每條規則的違反數／率，另含統計相似度
  （平均、離散度、日夜振幅、溫濕度相關方向、每小時變化量）。
* 這裡不判斷『異常是否被偵測到』，只回答『資料本身是否像一份合理的感測器紀錄』。
"""
from __future__ import annotations

import numpy as np
import pandas as pd

import domain_schema as DS
import p55_quality as QL
from p55_analysis import thi_from

THI_PAIRS = {"羊舍": (("成羊區THI", "成羊區平均溫度", "成羊區平均濕度"), ("仔羊區THI", "ID4-溫度", "ID4-濕度"))}
PM_PAIR = ("PM2.5", "PM10")
POWER = ("CPM 系統總和功率", "CPM 總和視在功率", "CPM 總和功率因數")
_WIDEN = 0.25


def _prof(stem):
    import p586_synth as SY
    return SY.profile(stem)


def _is_rh(c: str) -> bool:
    return "濕度" in c or c == "RH"


def envelope(stem: str, col: str) -> tuple[float, float]:
    P = _prof(stem)
    cp = P.prof[col]
    sem = DS.column_semantics(col)
    span = max(cp.hi - cp.lo, 1e-9)
    lo, hi = cp.lo - _WIDEN * span, cp.hi + _WIDEN * span
    if sem["phys_min"] is not None:
        lo = max(lo, float(sem["phys_min"]))
    if sem["phys_max"] is not None:
        hi = min(hi, float(sem["phys_max"]))
    if cp.lo >= 0:
        lo = max(lo, 0.0)
    if _is_rh(col):
        lo, hi = max(lo, 0.0), min(hi, 100.0)
    return float(lo), float(hi)


def _thi_offset(stem: str, thi: str, t: str, h: str) -> float:
    df, _ = DS.load_domain(stem)
    return float((df[thi] - thi_from(df[t], df[h])).mean())


_OFF: dict = {}


def thi_offset(stem, thi, t, h) -> float:
    k = (stem, thi)
    if k not in _OFF:
        _OFF[k] = _thi_offset(stem, thi, t, h)
    return _OFF[k]


def enforce(stem: str, df: pd.DataFrame, keep_stuck=()) -> pd.DataFrame:
    P = _prof(stem)
    d = df.copy()
    for c in P.cols:
        cp = P.prof[c]
        if cp.kind in ("cont", "angle"):
            lo, hi = envelope(stem, c)
            v = d[c].to_numpy(float)
            if cp.kind == "angle":
                v = v % 360.0
            else:
                v = np.clip(v, lo, hi)
            d[c] = np.round(v, cp.decimals)
        elif cp.kind == "discrete":
            lv = cp.levels
            v = d[c].to_numpy(float)
            d[c] = lv[np.abs(v[:, None] - lv[None, :]).argmin(axis=1)]
        elif cp.kind == "cumulative":
            d[c] = np.maximum.accumulate(d[c].to_numpy(float))
    a, b = PM_PAIR
    if a in d.columns and b in d.columns:
        d[b] = np.maximum(d[b], d[a])
    if stem == "專家系統":
        p, s, pf = POWER
        # 功率因數保持自己的邊際分布，視在功率由 有功／功率因數 導出（因此 S ≥ P 且 PF ≈ P/S）
        ok = (d[p] > 5) & (d[pf] > 0.3)
        d.loc[ok, s] = np.round(d.loc[ok, p] / d.loc[ok, pf], 1)
        d[s] = np.maximum(d[s], d[p])
    for thi, t, h in THI_PAIRS.get(stem, ()):
        d[thi] = np.round(thi_from(d[t], d[h]) + thi_offset(stem, thi, t, h), 1)
    for c, t0, t1 in keep_stuck:
        m = (d["timestamp"] >= t0) & (d["timestamp"] <= t1)
        first = d.loc[m, c].iloc[0]
        d.loc[m, c] = first
    return d


# ============================================================ 獨立檢查
def check(stem: str, df: pd.DataFrame, ts_col: str = "timestamp") -> pd.DataFrame:
    """回傳規則表：rule, violations, rows_checked, rate, ok。"""
    P = _prof(stem)
    rg = P.clean
    rows = []

    def add(rule, viol, n, note="", allow=0.0):
        rate = viol / max(n, 1)
        rows.append({"rule": rule, "violations": int(viol), "checked": int(n), "rate": round(rate, 5), "ok": bool(rate <= allow), "allowed_rate": allow, "note": note})

    ts = pd.DatetimeIndex(df[ts_col])
    add("時間戳記嚴格遞增且無重複", int((np.diff(ts.asi8) <= 0).sum()), max(len(ts) - 1, 1))
    add("時間戳記都在整點", int((ts.minute != 0).sum() + (ts.second != 0).sum()), len(ts))
    x = df.drop(columns=[ts_col]).to_numpy(float)
    add("沒有無限值", int(np.isinf(x).sum()), x.size)
    for c in P.cols:
        cp = P.prof[c]
        v = df[c].to_numpy(float)
        m = ~np.isnan(v)
        if cp.kind in ("cont", "angle"):
            lo, hi = envelope(stem, c)
            if cp.kind == "angle":
                add(f"{c}：風向在 [0,360)", int(((v[m] < 0) | (v[m] >= 360)).sum()), m.sum())
            else:
                derived = any(c == t_[0] for t_ in THI_PAIRS.get(stem, ())) or c in ("CPM 總和視在功率",)
                add(f"{c}：在物理／實測包絡內", int(((v[m] < lo - 1e-9) | (v[m] > hi + 1e-9)).sum()), m.sum(), f"[{lo:.3g},{hi:.3g}]" + ("；導出欄位，容許 0.5%" if derived else ""), allow=0.005 if derived else 0.0)
        if cp.kind == "cumulative":
            dv = np.diff(v[m])
            add(f"{c}：累積計數器不遞減", int((dv < -1e-9).sum()), len(dv))
        if cp.kind == "discrete":
            add(f"{c}：狀態值在真實出現過的集合內", int((~np.isin(v[m], cp.levels)).sum()), m.sum())
    a, b = PM_PAIR
    if a in df.columns and b in df.columns:
        w = df[[a, b]].dropna()
        add("PM10 ≥ PM2.5", int((w[b] < w[a] - 1e-9).sum()), len(w))
    for c in df.columns:
        if _is_rh(c):
            w = df[c].dropna()
            add(f"{c}：相對濕度 0–100", int(((w < 0) | (w > 100)).sum()), len(w))
    for thi, t, h in THI_PAIRS.get(stem, ()):
        w = df[[thi, t, h]].dropna()
        diff = (w[thi] - (thi_from(w[t], w[h]) + thi_offset(stem, thi, t, h))).abs()
        add(f"{thi} 與溫濕度的公式一致（容差 0.6）", int((diff > 0.6).sum()), len(w))
    if stem == "專家系統":
        w = df[list(POWER)].dropna()
        add("視在功率 ≥ 有功功率", int((w[POWER[1]] < w[POWER[0]] - 1e-6).sum()), len(w))
        w2 = w[w[POWER[1]] > 10]
        add("功率因數 ≈ 有功／視在（容差 0.15；軟性：容許 2%）", int(((w2[POWER[0]] / w2[POWER[1]]) - w2[POWER[2]]).abs().gt(0.15).sum()), len(w2), "真實資料本身也有少數偏離", allow=0.02)
    # 變化速率：每小時變化不得遠超過真實資料最大變化（只檢查非異常的連續讀值）
    n_rate = v_rate = 0
    for c in P.cols:
        if P.prof[c].kind != "cont":
            continue
        rd = rg[c].diff().abs().dropna()
        lim = 3.0 * float(rd.quantile(0.999)) + 1e-9
        d1 = df.set_index(ts_col)[c].diff().abs().dropna()
        d1 = d1[(d1.index.to_series().diff() == pd.Timedelta(hours=1)).reindex(d1.index, fill_value=False)]
        n_rate += len(d1)
        v_rate += int((d1 > lim).sum())
    add("每小時變化量不超過真實資料 99.9% 分位的 3 倍（軟性：容許 0.5%）", v_rate, n_rate,
        "軟性規則：合成序列在極少數步驟比真實資料粗糙；含刻意注入的尖峰事件時超出屬情境，不是資料錯誤", allow=0.005)
    return pd.DataFrame(rows)


def similarity(stem: str, df: pd.DataFrame, ts_col: str = "timestamp") -> pd.DataFrame:
    """與真實資料的統計相似度（不是『相同』；是『像不像同一個場域的感測器』）。"""
    P = _prof(stem)
    rg = P.clean
    d = df.set_index(ts_col)
    out = []
    import p586_synth as _SY                                                               # noqa: PLC0415  延遲匯入（避免循環匯入）
    drv = _SY.DRIVERS[stem]
    for c in P.cols:
        cp = P.prof[c]
        if cp.kind in ("const", "alias"):
            continue
        s = d[c].dropna()
        if len(s) < 24:
            continue
        r = rg[c].dropna()
        if cp.kind == "cumulative":
            s, r = s.diff().dropna(), r.diff().clip(lower=0).dropna()
        rsd = lambda x: max(float(x.quantile(0.75) - x.quantile(0.25)) / 1.349, 0.5 * float(x.std() if x.std() == x.std() else 0), 1e-9)       # 穩健標準差（下限＝半個標準差，避免階梯狀慢變量被放大）
        mean_z = (s.median() - r.median()) / rsd(r)
        sd_ratio = rsd(s) / rsd(r)
        amp = lambda x: float(x.groupby(x.index.hour).mean().agg(lambda q: q.max() - q.min()))
        ar, as_ = amp(r), amp(s)
        out.append({"column": c, "kind": cp.kind, "median_shift_in_real_sd": round(float(mean_z), 2), "sd_ratio": round(float(sd_ratio), 2),
                    "diurnal_amp_ratio": round(as_ / ar, 2) if ar > 0 else np.nan, "in_envelope_frac": round(float(((s >= r.min() - 0.25 * (r.max() - r.min())) & (s <= r.max() + 0.25 * (r.max() - r.min()))).mean()), 3)})
    sim = pd.DataFrame(out)
    t, h = drv["T"], drv.get("H")
    extra = {}
    if h:
        ok_r = rg[[t, h]].dropna()
        ok_s = d[[t, h]].dropna()
        extra = {"corr_T_H_real": round(float(ok_r[t].corr(ok_r[h])), 2), "corr_T_H_synth": round(float(ok_s[t].corr(ok_s[h])), 2)}
    sim.attrs["extra"] = extra
    return sim
