"""
p586_anomaly.py — Phase 5.8.6：新資料的異常／品質分析（不讀任何情境真值）

偵測器（各自獨立，結果分開呈現；不合併成一個『分數』，也不宣稱準確度）
  threshold      簡單門檻：超出『真實歷史資料』的最小／最大值（對照組：看不到緩慢漂移、校正跳階、關係改變）
  resid_z        同時刻殘差：x_t 減去前 1–7 天同一小時的中位數，以過去 14 天殘差的穩健尺度標準化（短事件、跳階起點）
  relation       關係監測：以其他感測器預測該感測器（在『真實』資料上擬合的 ridge），看每日殘差平均的 CUSUM（緩慢漂移、校正偏移）
                 與殘差變異是否暴增（感測器脫鉤）。R² 不足的感測器『無法監測』，會明確列出，不假裝有看。
  stuck          卡值：連續相同讀值的長度超過真實資料中該感測器的正常上限
  quality_*      資料品質：缺值區塊、整列缺失（斷線）、整列歸零（斷電假讀值）、時間缺口

所有參考量（包絡、關係、尺度）只用『真實歷史資料』估計；新資料只被拿來偵測，不被拿來學習。
輸出的是『候選事件』，不是故障判定。
"""
from __future__ import annotations

import warnings
from functools import lru_cache

import numpy as np
import pandas as pd

import domain_schema as DS
import p586_synth as SY

DETECTORS = ("threshold", "resid_z", "relation", "stuck", "quality")
EVENT_COLS = ["detector", "kind", "column", "start", "end", "detected_at", "score", "note"]


def _runs(mask: np.ndarray) -> list[tuple[int, int]]:
    out, i, n = [], 0, len(mask)
    while i < n:
        if mask[i]:
            j = i
            while j + 1 < n and mask[j + 1]:
                j += 1
            out.append((i, j))
            i = j + 1
        else:
            i += 1
    return out


def _mad_sd(x: np.ndarray) -> float:
    x = x[~np.isnan(x)]
    if len(x) < 10:
        return float("nan")
    return float(1.4826 * np.median(np.abs(x - np.median(x))))


# ============================================================ 參考量（只用真實歷史資料）
@lru_cache(maxsize=8)
def _reference(stem: str, raw_sha16: str) -> dict:
    P = SY.profile(stem)
    cl = P.clean
    cont = [c for c in P.cols if P.prof[c].kind == "cont"]
    ref = {"cols": cont, "rel": {}, "run_limit": {}, "envelope": {}, "z_cal": {}}
    for c in cont:
        v = cl[c].dropna()
        ref["envelope"][c] = (float(v.min()), float(v.max()))
        run = (cl[c].diff() == 0).astype(int)
        mx = run.groupby((run == 0).cumsum()).sum()
        ref["run_limit"][c] = int(max(8, 2 * (mx.quantile(0.999) + 1 if len(mx) else 8)))
        zr = np.abs(_resid_z(cl[c], P.prof[c].sd, P.prof[c].decimals))
        zr = zr[~np.isnan(zr)]
        ref["z_cal"][c] = float(1.5 * np.quantile(zr, 0.999)) if len(zr) > 200 else 0.0
    for c in cont:
        cand = []
        for o in cont:
            if o == c:
                continue
            w = cl[[c, o]].dropna()
            if len(w) > 200 and w[c].std() > 0 and w[o].std() > 0:
                cand.append((abs(w[c].corr(w[o])), o))
        cand.sort(reverse=True)
        pred = [o for _, o in cand[:6]]
        if not pred:
            continue
        w = cl[[c] + pred].dropna()
        if len(w) < 200:
            continue
        mu, sd = w[pred].mean(), w[pred].std().replace(0, 1)
        A = ((w[pred] - mu) / sd).to_numpy()
        A1 = np.c_[A, np.ones(len(A))]
        beta = np.linalg.solve(A1.T @ A1 + 1.0 * np.diag([1] * A.shape[1] + [0]), A1.T @ w[c].to_numpy())
        res = w[c].to_numpy() - A1 @ beta
        r2 = 1 - res.var() / max(w[c].var(), 1e-12)
        full = pd.Series(np.nan, index=cl.index)
        full.loc[w.index] = res
        daily = full.groupby(full.index.normalize()).agg(["mean", "count"])
        dm = daily.loc[daily["count"] >= 18, "mean"].to_numpy()
        sig_day = float(max(_mad_sd(dm), np.std(res) * 0.15, 1e-9))
        # 以『真實歷史』自己的每日殘差校準 CUSUM 與變異門檻（真實資料本身的季節性變化不應被當成故障）
        zd = (daily.loc[daily["count"] >= 18, "mean"] / sig_day)
        days = zd.index
        sp = sn = mx_c = 0.0
        prev_day = None
        for d_, z_ in zd.items():
            if prev_day is not None and (d_ - prev_day).days > 1:
                sp = sn = 0.0
            sp, sn = max(0.0, sp + z_ - 0.5), max(0.0, sn - z_ - 0.5)
            mx_c = max(mx_c, sp, sn)
            prev_day = d_
        msq = full.groupby(full.index.normalize()).agg(lambda q: np.nanmean(q ** 2) if q.notna().sum() >= 12 else np.nan).dropna()
        var_q = float(np.quantile(msq / max(np.std(res) ** 2, 1e-12), 0.99)) if len(msq) >= 10 else 3.0
        ref["rel"][c] = {"h_cal": float(mx_c), "var_cal": var_q, "pred": pred, "mu": mu.to_dict(), "sd": sd.to_dict(), "beta": beta.tolist(), "sigma_e": float(np.std(res)), "r2": float(r2), "sigma_day": sig_day,
                         "monitorable": bool(r2 >= 0.3 and len(dm) >= 20)}
    return ref


def reference(stem: str) -> dict:
    return _reference(stem, DS.dataset_fingerprint(DS.spec_for(stem)))


# ============================================================ 偵測器
def _mk(det, kind, col, t0, t1, det_at, score, note="") -> dict:
    return {"detector": det, "kind": kind, "column": col, "start": pd.Timestamp(t0), "end": pd.Timestamp(t1), "detected_at": pd.Timestamp(det_at), "score": float(score), "note": note}


def det_threshold(g: pd.DataFrame, stem: str, t_from) -> list[dict]:
    ref, out = reference(stem), []
    for c in ref["cols"]:
        lo, hi = ref["envelope"][c]
        x = g[c]
        m = ((x < lo) | (x > hi)).to_numpy() & (g.index >= t_from)
        for a, b in _runs(m):
            out.append(_mk("threshold", "out_of_historical_range", c, g.index[a], g.index[b], g.index[a], float(np.nanmax(np.abs(x.iloc[a:b + 1] - (lo + hi) / 2)) / max(hi - lo, 1e-9) * 2), f"歷史範圍 [{lo:.3g},{hi:.3g}]"))
    return out


def _resid_z(x: pd.Series, sd_c: float, decimals: int) -> np.ndarray:
    """同時刻殘差的穩健 z（因果）：x_t − 前 1–7 天同一小時的中位數，除以『截至前一小時』過去 14 天殘差的穩健尺度。"""
    xv = x.to_numpy(float)
    n = len(xv)
    stack = np.full((7, n), np.nan)
    for k in range(1, 8):
        if n > 24 * k:
            stack[k - 1, 24 * k:] = xv[:-24 * k]
    with np.errstate(all="ignore"), warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        cnt = (~np.isnan(stack)).sum(axis=0)
        base = np.where(cnt >= 3, np.nanmedian(stack, axis=0), np.nan)
    r = pd.Series(xv - base, index=x.index)
    sc = r.shift(1).rolling(336, min_periods=96).apply(_mad_sd, raw=True)
    floor = max(0.04 * sd_c, 10.0 ** (-decimals) * 2)
    return (r / sc.clip(lower=floor)).to_numpy()


def det_resid_z(g: pd.DataFrame, stem: str, t_from, z_hi: float = 5.0, z_vhi: float = 8.0) -> list[dict]:
    ref, out = reference(stem), []
    P = SY.profile(stem)
    for c in ref["cols"]:
        z = _resid_z(g[c], P.prof[c].sd, P.prof[c].decimals)
        thr = max(z_hi, ref["z_cal"].get(c, 0.0))                       # 門檻不低於『真實歷史資料自己的 z 分布』的上緣
        m = (np.abs(z) >= thr) & np.asarray(g.index >= t_from)
        for a, b in _runs(m):
            peak = float(np.nanmax(np.abs(z[a:b + 1])))
            if (b - a + 1 >= 2) or peak >= max(z_vhi, 1.6 * thr):
                out.append(_mk("resid_z", "short_event_or_step", c, g.index[a], g.index[b], g.index[min(a + 1, b)], peak, f"與前 1–7 天同時刻相比異常（門檻 z≥{thr:.1f}，依真實歷史校準）"))
    return out


def det_relation(g: pd.DataFrame, stem: str, t_from, k: float = 0.5, h0: float = 5.0, var0: float = 3.0) -> tuple[list[dict], dict]:
    ref, out = reference(stem), []
    notes = {"unmonitorable": [c for c in ref["cols"] if c not in ref["rel"] or not ref["rel"][c]["monitorable"]]}
    for c, R in ref["rel"].items():
        if not R["monitorable"]:
            continue
        h = max(h0, 1.25 * R["h_cal"])
        var_ratio = max(var0, 1.5 * R["var_cal"])
        X = g[R["pred"]]
        A = ((X - pd.Series(R["mu"])) / pd.Series(R["sd"])).to_numpy()
        pred = np.c_[A, np.ones(len(A))] @ np.array(R["beta"])
        e = pd.Series(g[c].to_numpy() - pred, index=g.index)
        e = e[g.index >= t_from]
        d = e.groupby(e.index.normalize()).agg(["mean", "count", lambda q: np.nanmean(q ** 2)])
        d.columns = ["mean", "count", "msq"]
        d = d[d["count"] >= 12]
        if len(d) < 3:
            continue
        zd = (d["mean"] / R["sigma_day"]).to_numpy()
        sp = sn = 0.0
        run_start_p = run_start_n = None
        alarmed = None
        for i, z in enumerate(zd):
            sp_new, sn_new = max(0.0, sp + z - k), max(0.0, sn - z - k)
            if sp == 0 and sp_new > 0:
                run_start_p = i
            if sn == 0 and sn_new > 0:
                run_start_n = i
            sp, sn = sp_new, sn_new
            if alarmed is None and (sp > h or sn > h):
                s0 = run_start_p if sp > h else run_start_n
                alarmed = (s0, i, max(sp, sn), "上偏" if sp > h else "下偏")
        if alarmed:
            s0, i, sc, sign = alarmed
            out.append(_mk("relation", "drift_or_offset", c, d.index[s0], d.index[-1] + pd.Timedelta(hours=23), d.index[i] + pd.Timedelta(hours=23), sc, f"相對於其他感測器的預期值{sign}（CUSUM；每日殘差平均）"))
        # 脫鉤：殘差變異暴增（連續 ≥2 天）
        ratio = (d["msq"] / max(R["sigma_e"] ** 2, 1e-12)).to_numpy()
        hot = ratio >= var_ratio
        for a, b in _runs(hot):
            if b - a + 1 >= 2:
                out.append(_mk("relation", "decoupling", c, d.index[a], d.index[b] + pd.Timedelta(hours=23), d.index[a + 1] + pd.Timedelta(hours=23), float(ratio[a:b + 1].mean()), "與其他感測器的連動變弱（殘差變異暴增）"))
                break
    return out, notes


def det_stuck(g: pd.DataFrame, stem: str, t_from) -> list[dict]:
    ref, out = reference(stem), []
    for c in ref["cols"]:
        x = g[c]
        same = (x.diff() == 0).to_numpy() & np.asarray(g.index >= t_from)
        lim = ref["run_limit"][c]
        for a, b in _runs(same):
            if (b - a + 1) >= lim:
                out.append(_mk("stuck", "stuck_sensor", c, g.index[max(a - 1, 0)], g.index[b], g.index[min(a + lim - 1, b)], b - a + 2, f"連續 {b - a + 2} 筆相同（真實資料正常上限約 {lim}）"))
    return out


def det_quality(g: pd.DataFrame, stem: str, t_from) -> list[dict]:
    P = SY.profile(stem)
    out = []
    idx = g.index
    sel = idx >= t_from
    cont = [c for c in P.cols if P.prof[c].kind == "cont"]
    allna = g[cont].isna().all(axis=1).to_numpy()
    for a, b in _runs(allna & sel):
        out.append(_mk("quality", "outage_missing_rows", "*", idx[a], idx[b], idx[b], b - a + 1, "整列缺失（斷線）"))
    pos = [c for c in cont if P.prof[c].mean > 0 and P.prof[c].lo >= 0 and float((P.clean[c] == 0).mean()) < 0.05]     # 真實資料裡很少為 0 的感測器
    if len(pos) >= 3:
        zr = ((g[pos] == 0).sum(axis=1) / len(pos) >= 0.5).to_numpy() & sel
        for a, b in _runs(zr):
            out.append(_mk("quality", "outage_zero_rows", "*", idx[a], idx[b], idx[a], b - a + 1, "多數感測器同時為 0（斷電／斷線的假讀值）"))
    for c in cont:
        na = g[c].isna().to_numpy() & ~allna & sel
        for a, b in _runs(na):
            if b - a + 1 >= 3:
                out.append(_mk("quality", "missing_block", c, idx[a], idx[b], idx[min(a + 2, b)], b - a + 1, f"連續 {b - a + 1} 小時沒有讀值"))
    return out


# ============================================================ 彙整
def analyze(g: pd.DataFrame, stem: str, t_from=None, detectors=DETECTORS) -> dict:
    """g：延伸後的小時資料（真實＋追加；缺的小時是 NaN）。t_from：只報告這個時間之後（預設＝追加資料起點）。"""
    t_from = pd.Timestamp(t_from) if t_from is not None else g.index[0]
    ev: list[dict] = []
    info: dict = {}
    if "threshold" in detectors:
        ev += det_threshold(g, stem, t_from)
    if "resid_z" in detectors:
        ev += det_resid_z(g, stem, t_from)
    if "relation" in detectors:
        e, info = det_relation(g, stem, t_from)
        ev += e
    if "stuck" in detectors:
        ev += det_stuck(g, stem, t_from)
    if "quality" in detectors:
        ev += det_quality(g, stem, t_from)
    df = pd.DataFrame(ev, columns=EVENT_COLS).sort_values(["start", "detector", "column"]).reset_index(drop=True) if ev else pd.DataFrame(columns=EVENT_COLS)
    return {"events": df, "info": info, "t_from": t_from, "n_hours": int((g.index >= t_from).sum()),
            "disclaimer": "候選事件，不是故障判定；偵測器只用真實歷史資料建立參考，不讀任何情境真值，也沒有宣稱準確度。"}
