"""
p587_detect.py — Phase 5.8.7：異常分析 v2（每個場域、每個感測器各自校準；分開『異常訊號』與『資料品質』）

和 v1（p586_anomaly，保留不動）的差別
  1. 門檻不再是全域常數：每個 (場域, 感測器, 統計量) 的門檻來自『只含正常資料』的校準批次（p587_calib；種子與調參／留存集互不相交），
     門檻＝校準批次最大值的某個分位 × 全域 margin（margin 是唯一在調參集上選擇的全域超參數）。
  2. 短事件：同時刻殘差的多尺度滾動平均（1/2/3/4/6 小時），各尺度各自門檻；超過 max_short_h 小時的持續偏離不再當成『短事件』，
     改走『位準改變』判斷——被其他感測器（關係殘差）解釋的視為環境變化（熱浪、暴雨…），不警報、另外列出。
  3. 緩慢漂移／偏移：關係殘差的每日 CUSUM（可監測的感測器）；無法由其他感測器預測的感測器改用『與 7–14 天前同時刻』的自我參照 CUSUM，
     且同時有許多感測器一起動就視為環境變化。
  4. 雜訊變大：24 小時一階差分標準差相對校準基準的比值。
  5. 卡值：連續相同長度的上限依每個感測器在正常資料中的最長連續相同長度校準（本來就常常相同的感測器如實『無法偵測』）。
  6. 資料品質：缺值區塊（≥2 小時）、整列缺失、整列歸零、卡值。分類為 data_quality；其餘為 signal。
輸出是『候選警報』：不是故障判定，也不是準確度宣稱。
"""
from __future__ import annotations

import json
import warnings
from functools import lru_cache
from pathlib import Path

import numpy as np
import pandas as pd

import domain_schema as DS
import p586_anomaly as AM
import p586_synth as SY
import p587_eval as EV

ROOT = Path(__file__).resolve().parent.parent
CALIB_DIR = ROOT / "outputs" / "phase5_8_7" / "calibration"
WINDOWS = (1, 2, 3, 4, 6)
ZCAP = 30.0
Z_FLOOR_SCALE_FRAC = 0.7       # z 的尺度下限：校準期『局部穩健尺度』中位數的比例
Z_FLOOR_STD_FRAC = 0.15        # …與校準期殘差標準差的比例（取較大者；避免零膨脹感測器的尺度趨近 0 而讓 z 爆炸）
CONFIG = {"margin": 1.15, "quantile": 1.0, "k": 0.5, "max_short_h": 12, "level_margin": 1.15, "broad_frac": 0.25, "min_missing_h": 2, "stuck_margin": 1.25, "quality_min_zero_frac": 0.5}


# ============================================================ 原始序列（與門檻無關）
def _daily_mask(index: pd.DatetimeIndex, t_from) -> np.ndarray:
    return np.asarray(index >= pd.Timestamp(t_from))


def resid_parts(x: pd.Series, sd_c: float, decimals: int) -> tuple[np.ndarray, np.ndarray]:
    """同時刻殘差 r＝x_t − 前 1–7 天同一小時的中位數；sc＝『截至前一小時』過去 14 天殘差的穩健尺度（因果）。"""
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
    sc = r.shift(1).rolling(336, min_periods=96).apply(AM._mad_sd, raw=True).to_numpy()
    return r.to_numpy(), sc


def raw_series(g: pd.DataFrame, stem: str, t_from) -> dict:
    """每個連續感測器的原始統計序列（z、關係殘差 e、自我參照遠期殘差 dl、一階差分 d1）。"""
    P = SY.profile(stem)
    ref = AM.reference(stem)
    out = {}
    for c in ref["cols"]:
        x = g[c]
        r_, sc_ = resid_parts(x, P.prof[c].sd, P.prof[c].decimals)
        R = ref["rel"].get(c)
        e = np.full(len(g), np.nan)
        if R and R["monitorable"]:
            X = g[R["pred"]]
            A = ((X - pd.Series(R["mu"])) / pd.Series(R["sd"])).to_numpy()
            e = x.to_numpy(float) - np.c_[A, np.ones(len(A))] @ np.array(R["beta"])
        xv = x.to_numpy(float)
        n = len(xv)
        stack = np.full((8, n), np.nan)
        for j, k in enumerate(range(7, 15)):
            if n > 24 * k:
                stack[j, 24 * k:] = xv[:-24 * k]
        with np.errstate(all="ignore"), warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            cnt = (~np.isnan(stack)).sum(axis=0)
            base = np.where(cnt >= 4, np.nanmedian(stack, axis=0), np.nan)
        out[c] = {"r": r_, "sc": sc_, "floor0": max(0.04 * P.prof[c].sd, 10.0 ** (-P.prof[c].decimals) * 2), "e": e, "dl": xv - base, "d1": np.r_[np.nan, np.diff(xv)], "x": xv, "monitorable": bool(R and R["monitorable"])}
    return out


def _daily(arr: np.ndarray, index: pd.DatetimeIndex, t_from, min_count: int = 12) -> pd.Series:
    s = pd.Series(arr, index=index)
    s = s[np.asarray(index >= pd.Timestamp(t_from))]
    d = s.groupby(s.index.normalize()).agg(["mean", "count"])
    return d.loc[d["count"] >= min_count, "mean"]


def cusum_path(zd: np.ndarray, k: float) -> np.ndarray:
    sp = sn = 0.0
    out = np.zeros(len(zd))
    for i, z in enumerate(zd):
        sp, sn = max(0.0, sp + z - k), max(0.0, sn - z - k)
        out[i] = max(sp, sn)
    return out


def derived_stats(raw: dict, index: pd.DatetimeIndex, t_from, scales: dict, k: float) -> dict:
    """依校準尺度算出可與門檻比較的統計序列。scales 缺項時回傳 None（校準第一階段用）。"""
    e, dl, d1 = raw["e"], raw["dl"], raw["d1"]
    floor = scales.get("z_floor") or raw["floor0"]
    z = raw["r"] / np.maximum(raw["sc"], floor)
    az = np.abs(np.nan_to_num(z, nan=0.0)).clip(max=ZCAP)
    st = {"z": z, "m": {w: pd.Series(az).rolling(w, min_periods=w).mean().to_numpy() for w in WINDOWS}}
    sig_e, sd_rel, sd_lag, vbase = scales.get("sigma_e"), scales.get("sigma_day_rel"), scales.get("sigma_day_lag"), scales.get("vol_base")
    st["lv"] = None
    if sig_e and raw["monitorable"]:
        st["lv"] = pd.Series(e / sig_e).rolling(24, min_periods=12).mean().abs().to_numpy()
    st["mr"] = None
    if sig_e and raw["monitorable"]:
        ae = np.abs(np.nan_to_num(e / sig_e, nan=0.0)).clip(max=ZCAP)
        st["mr"] = {w: pd.Series(ae).rolling(w, min_periods=w).mean().to_numpy() for w in WINDOWS}
    st["rv"] = None
    if sig_e and raw["monitorable"]:
        st["rv"] = pd.Series((e / sig_e) ** 2).rolling(48, min_periods=24).mean().to_numpy()
    st["cus_rel"] = None
    if sd_rel and raw["monitorable"]:
        dm = _daily(e, index, t_from)
        st["cus_rel"] = (dm.index, cusum_path((dm / sd_rel).to_numpy(), k))
    st["cus_lag"] = None
    if sd_lag:
        dm = _daily(dl, index, t_from)
        st["cus_lag"] = (dm.index, cusum_path((dm / sd_lag).to_numpy(), k))
    st["vol"] = None
    if vbase:
        st["vol"] = (pd.Series(d1).rolling(24, min_periods=18).std().to_numpy() / vbase)
    return st


def flat_runs(x: np.ndarray) -> np.ndarray:
    """每個位置『到此為止連續相同的筆數』（第一筆為 1）。"""
    same = np.r_[False, (np.diff(x) == 0) & ~np.isnan(x[1:]) & ~np.isnan(x[:-1])]
    out = np.ones(len(x))
    run = 1
    for i in range(1, len(x)):
        run = run + 1 if same[i] else 1
        out[i] = run
    return out


# ============================================================ 校準檔
@lru_cache(maxsize=16)
def load_calibration(stem: str, path: str | None = None) -> dict:
    p = Path(path) if path else CALIB_DIR / f"{stem}.json"
    if not p.is_file():
        raise FileNotFoundError(f"{stem} 還沒有校準檔（執行 python tools/p587_calibrate.py）")
    return json.loads(p.read_text(encoding="utf-8"))


def thresholds(cal: dict, c: str, cfg: dict) -> dict:
    """由校準批次的最大值清單套用 margin 得到門檻。"""
    C = cal["cols"][c]
    q, M = cfg["quantile"], cfg["margin"]

    def th(lst, floor):
        return max(float(np.quantile(lst, q)) * M, floor) if lst else float("inf")
    return {"z_floor": C.get("z_floor"), "short": {int(w): th(C["max_short"][str(w)], 4.0 if int(w) == 1 else 3.0) for w in WINDOWS}, "level": th(C["max_level"], 1.5) if C["max_level"] else float("inf"),
            "h_rel": th(C["max_cus_rel"], 4.0) if C["max_cus_rel"] else float("inf"), "h_lag": th(C["max_cus_lag"], 4.0) if C["max_cus_lag"] else float("inf"),
            "vol": th(C["max_vol"], 1.5) if C["max_vol"] else float("inf"), "rv": th(C["max_rv"], 3.0) if C.get("max_rv") else float("inf"), "mr": ({int(w): th(C["max_mr"][str(w)], 4.0 if int(w) == 1 else 3.0) for w in WINDOWS} if C.get("max_mr") and C["max_mr"].get("1") else None), "stuck_L": int(max(6, np.ceil(max(C["max_flat"] or [0]) * cfg["stuck_margin"]) + 1)), **{k: C[k] for k in ("sigma_e", "sigma_day_rel", "sigma_day_lag", "vol_base", "monitorable")}}


CONFIG_FILE = ROOT / "outputs" / "phase5_8_7" / "config_per_domain.json"


@lru_cache(maxsize=1)
def _domain_configs() -> dict:
    return json.loads(CONFIG_FILE.read_text(encoding="utf-8"))["domains"] if CONFIG_FILE.is_file() else {}


def domain_config(stem: str) -> dict:
    """每個場域各自的靈敏度（margin、quantile）：由 tools/p587_select.py 依事先固定的警報預算選出。"""
    c = _domain_configs().get(stem, {})
    return {k: c[k] for k in ("margin", "quantile") if k in c}


# ============================================================ 偵測
def _alert(cat, kind, col, t0, t1, det, score, note="", sub="", ratio=1.0) -> dict:
    return {"system": "v2", "category": cat, "kind": kind, "column": col, "start": pd.Timestamp(t0), "end": pd.Timestamp(t1), "detected_at": pd.Timestamp(det), "score": float(score), "note": note, "detector": sub, "ratio": float(ratio)}


def analyze(g: pd.DataFrame, stem: str, t_from=None, cfg: dict | None = None, calibration: dict | None = None) -> dict:
    cfg = {**CONFIG, **domain_config(stem), **(cfg or {})}
    cal = calibration or load_calibration(stem)
    t_from = pd.Timestamp(t_from) if t_from is not None else g.index[0]
    idx = g.index
    sel = np.asarray(idx >= t_from)
    raws = raw_series(g, stem, t_from)
    P = SY.profile(stem)
    alerts, suppressed = [], []
    th = {c: thresholds(cal, c, cfg) for c in raws}
    stats = {c: derived_stats(raws[c], idx, t_from, th[c], cfg["k"]) for c in raws}
    n_cols = len(raws)
    # ---- 位準改變／短事件（同時刻殘差；依持續時間分流）
    level_cols_by_time: list[tuple[str, int, int]] = []
    pending_long = []
    for c in raws:
        m = stats[c]["m"]
        hit = np.zeros(len(idx), bool)
        for w in WINDOWS:
            hit |= np.nan_to_num(m[w], nan=0.0) >= th[c]["short"][w]
        if stats[c]["mr"] is not None and th[c]["mr"]:
            for w in WINDOWS:
                hit |= np.nan_to_num(stats[c]["mr"][w], nan=0.0) >= th[c]["mr"][w]      # 與其他感測器不一致的突發偏離
        hit &= sel
        for a, b in AM._runs(hit):
            L = b - a + 1
            peak = float(np.nanmax(np.abs(np.nan_to_num(stats[c]["z"][a:b + 1], nan=0.0))))
            if L <= cfg["max_short_h"]:
                alerts.append(_alert("signal", "short_event", c, idx[a], idx[b], idx[min(a + 1, b)], peak, f"與前 1–7 天同時刻相比突然偏離（峰值 z={peak:.1f}；本感測器門檻已依校準設定）", "short"))
            else:
                pending_long.append((c, a, b, peak))
                level_cols_by_time.append((c, a, b))
    for c, a, b, peak in pending_long:
        lv = stats[c]["lv"]
        if lv is not None:
            seg = np.nan_to_num(lv[a:b + 1], nan=0.0)
            if seg.max() >= th[c]["level"]:
                alerts.append(_alert("signal", "level_shift", c, idx[a], idx[b], idx[a + int(np.argmax(seg >= th[c]["level"]))], float(seg.max()), "持續偏離，且無法由其他感測器解釋（關係殘差）", "level", ratio=float(seg.max()) / th[c]["level"]))
            else:
                suppressed.append({"column": c, "start": idx[a], "end": idx[b], "reason": "持續偏離但與其他感測器的關係正常 → 視為環境變化（不警報）", "kind": "environment_change"})
        else:
            conc = {cc for cc, aa, bb in level_cols_by_time if aa <= b and bb >= a}
            if len(conc) >= max(3, int(np.ceil(cfg["broad_frac"] * n_cols))):
                suppressed.append({"column": c, "start": idx[a], "end": idx[b], "reason": f"同時有 {len(conc)} 個感測器一起偏離 → 視為環境變化（不警報）", "kind": "environment_change"})
            else:
                alerts.append(_alert("signal", "level_shift", c, idx[a], idx[b], idx[a + 1], peak, "持續偏離，且只有少數感測器（本感測器無法由其他感測器預測）", "level"))
    # ---- 緩慢漂移（關係殘差 CUSUM；其次自我參照 CUSUM）
    lag_alarm: dict[str, tuple] = {}
    for c in raws:
        for key, hkey, kind, note in (("cus_rel", "h_rel", "drift", "相對於其他感測器的預期值持續單向偏移（每日殘差 CUSUM）"), ("cus_lag", "h_lag", "drift", "相對於 7–14 天前同時刻持續單向偏移（自我參照 CUSUM）")):
            s = stats[c][key]
            if s is None:
                continue
            if key == "cus_lag" and stats[c]["cus_rel"] is not None:
                continue                                                     # 可由關係監測的感測器不再用自我參照（避免把環境變化當漂移）
            days, path = s
            if len(path) and path.max() >= th[c][hkey]:
                i = int(np.argmax(path >= th[c][hkey]))
                j = i
                while j > 0 and path[j - 1] > 0:
                    j -= 1
                if key == "cus_lag":
                    lag_alarm[c] = (days[j], days[-1] + pd.Timedelta(hours=23), days[i] + pd.Timedelta(hours=23), float(path.max()), note)
                else:
                    alerts.append(_alert("signal", kind, c, days[j], days[-1] + pd.Timedelta(hours=23), days[i] + pd.Timedelta(hours=23), float(path.max()), note, "drift_rel", ratio=float(path.max()) / th[c][hkey]))
    for c, (t0, t1, det, sc, note) in lag_alarm.items():
        conc = [cc for cc, v in lag_alarm.items() if v[0] <= t1 and v[1] >= t0]
        if len(conc) >= max(3, int(np.ceil(cfg["broad_frac"] * n_cols))):
            suppressed.append({"column": c, "start": t0, "end": t1, "reason": f"同時有 {len(conc)} 個感測器的自我參照偏移 → 視為環境變化（不警報）", "kind": "environment_change"})
        else:
            alerts.append(_alert("signal", "drift", c, t0, t1, det, sc, note, "drift_lag"))
    # ---- 關係脫鉤（與其他感測器的連動消失：關係殘差的變異暴增，平均不一定偏移）
    for c in raws:
        rv = stats[c]["rv"]
        if rv is None or not np.isfinite(th[c]["rv"]):
            continue
        hit = (np.nan_to_num(rv, nan=0.0) >= th[c]["rv"]) & sel
        for a, b in AM._runs(hit):
            if b - a + 1 >= 12:
                alerts.append(_alert("signal", "relation_decoupling", c, idx[a], idx[b], idx[min(a + 11, b)], float(np.nanmax(rv[a:b + 1])), "與其他感測器的連動變弱（關係殘差的變異明顯變大）", "decouple", ratio=float(np.nanmax(rv[a:b + 1])) / th[c]["rv"]))
    # ---- 雜訊變大
    for c in raws:
        v = stats[c]["vol"]
        if v is None or not np.isfinite(th[c]["vol"]):
            continue
        hit = (np.nan_to_num(v, nan=0.0) >= th[c]["vol"]) & sel
        for a, b in AM._runs(hit):
            if b - a + 1 >= 6:
                alerts.append(_alert("signal", "variance_increase", c, idx[a], idx[b], idx[min(a + 5, b)], float(np.nanmax(v[a:b + 1])), "雜訊（逐小時變化的標準差）明顯變大", "vol"))
    # ---- 資料品質：卡值、缺值區塊、整列缺失、整列歸零
    for c in raws:
        fr = flat_runs(raws[c]["x"])
        L = th[c]["stuck_L"]
        hit = (fr >= L) & sel
        for a, b in AM._runs(hit):
            alerts.append(_alert("data_quality", "stuck_sensor", c, idx[max(a - L + 1, 0)], idx[b], idx[a], float(fr[b]), f"連續 {int(fr[b])} 筆相同（本感測器在正常資料中的最長連續相同為 {int(L / cfg['stuck_margin'])} 筆左右）", "stuck"))
    cont = list(raws)
    allna = g[cont].isna().all(axis=1).to_numpy()
    for a, b in AM._runs(allna & sel):
        alerts.append(_alert("data_quality", "outage_missing_rows", "*", idx[a], idx[b], idx[b], b - a + 1, "整列缺失（斷線）", "quality"))
    pos = [c for c in cont if P.prof[c].mean > 0 and P.prof[c].lo >= 0 and float((P.clean[c] == 0).mean()) < 0.05]
    if len(pos) >= 3:
        zr = ((g[pos] == 0).sum(axis=1) / len(pos) >= cfg["quality_min_zero_frac"]).to_numpy() & sel
        for a, b in AM._runs(zr):
            alerts.append(_alert("data_quality", "outage_zero_rows", "*", idx[a], idx[b], idx[a], b - a + 1, "多數感測器同時為 0（斷電／斷線的假讀值）", "quality"))
    for c in [c for c in P.cols if P.prof[c].kind != "const"]:
        na = g[c].isna().to_numpy() & ~allna & sel
        for a, b in AM._runs(na):
            if b - a + 1 >= cfg["min_missing_h"]:
                alerts.append(_alert("data_quality", "missing_block", c, idx[a], idx[b], idx[min(a + cfg["min_missing_h"] - 1, b)], b - a + 1, f"連續 {b - a + 1} 小時沒有讀值", "quality"))
    A = pd.DataFrame(alerts, columns=[*EV.ALERT_COLS, "note", "detector", "ratio"]) if alerts else pd.DataFrame(columns=[*EV.ALERT_COLS, "note", "detector", "ratio"])
    A = A.sort_values(["start", "column"]).reset_index(drop=True)
    S = pd.DataFrame(suppressed, columns=["column", "start", "end", "reason", "kind"]) if suppressed else pd.DataFrame(columns=["column", "start", "end", "reason", "kind"])
    undet = [c for c in raws if th[c]["stuck_L"] > 24]
    unmon = [c for c in raws if not th[c]["monitorable"]]
    return {"alerts": A, "suppressed": S, "info": {"stuck_undetectable": undet, "relation_unmonitorable": unmon, "thresholds_margin": cfg["margin"]}, "t_from": t_from,
            "disclaimer": "候選警報，不是故障判定；門檻依場域、感測器個別校準，沒有宣稱準確度。"}


def alerts_frame(res: dict) -> pd.DataFrame:
    a = res["alerts"]
    return a[EV.ALERT_COLS].copy() if len(a) else pd.DataFrame(columns=EV.ALERT_COLS)
