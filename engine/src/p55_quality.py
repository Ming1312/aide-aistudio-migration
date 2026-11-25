"""
p55_quality.py — Phase 5.5：語義化的資料品質分析（純 pandas／numpy；不改資料、不補值、不訓練）

重點：把下面幾件事分開，不能混為一談——
  * 真正缺值：該小時沒有收到資料（整列不存在），或該列的這個感測器是空白（NaN）。0 不是缺值。
  * 合法零值：零是該感測器的常態（降雨量、風靜止、設備關閉、北方 0°）。長時間為 0 通常不是問題。
  * 長時間零值（需脈絡確認）：低負載、低濃度、夜間太陽能等，零可能正常，也可能是感測或通訊問題；要看脈絡。
  * 可疑零值（待驗證）：溫度、濕度、溶氧、pH 等物理上不太可能長時間剛好為 0；仍然只是候選，不等於設備故障。
  * 非零 Flatline：連續多小時讀值完全相同（非零）；可能是真的沒變化，也可能是感測器停止更新。
  * 感測器狀態未知：分類為 UNKNOWN 的欄位，一律不下判斷。
所有『候選』都只是統計現象，不是已確認的設備故障。
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))

import p55_classify as CL  # noqa: E402

MIN_ZERO_SUSPICIOUS_H = 3        # 可疑零值：連續 ≥ 3 小時
MIN_ZERO_CONTEXT_H = 24          # 脈絡相關的零值：連續 ≥ 24 小時才標示『長時間』
MIN_FLAT_H = 6                   # 非零 Flatline 的『最低』門檻：連續 ≥ 6 小時完全相同。實際門檻依該感測器自己的重複率提高（見 flat_threshold）
CHANCE_BUDGET = 0.5              # 偶然出現這麼長的重複區段，在整段資料裡的期望次數必須 < 0.5，才視為 Flatline 候選
MIN_MISSING_RUN_H = 3
OUTLIER_Z = 5.0                  # 穩健 Z（MAD）> 5 才是候選離群值
PLATEAU_GROUPS = ("Device Power",)   # 電池滿電、夜間太陽能最低值等『上下限平台』：停在該感測器的最大／最小值，多半是正常現象
EXPECTED_CONSTANT_KINDS = ("state_code", "calibration_parameter", "cumulative_counter")


def runs_of(mask: np.ndarray) -> list[tuple[int, int]]:
    """布林陣列中連續為 True 的區段 [(起, 迄)]（含兩端）。"""
    m = np.asarray(mask, dtype=bool)
    if not m.any():
        return []
    d = np.diff(np.r_[0, m.astype(np.int8), 0])
    return list(zip(np.where(d == 1)[0], np.where(d == -1)[0] - 1))


def hourly_frame(df: pd.DataFrame, step_h: float = 1.0) -> pd.DataFrame:
    """補成完整的等間隔時間軸（缺的時間點是 NaN；不插補）。重複時間戳記保留第一筆（重複另外回報）。"""
    d = df.drop_duplicates("timestamp", keep="first").set_index("timestamp").sort_index()
    full = pd.date_range(d.index.min(), d.index.max(), freq=pd.Timedelta(hours=step_h))
    return d.reindex(full).rename_axis("timestamp")


def timestamp_quality(df: pd.DataFrame, step_h: float = 1.0) -> dict:
    ts = pd.to_datetime(df["timestamp"])
    srt = ts.sort_values()
    dt = srt.diff().dropna()
    gaps = []
    for i in np.where(dt > pd.Timedelta(hours=step_h * 1.5))[0]:
        a, b = srt.iloc[i], srt.iloc[i + 1]
        gaps.append({"after": a, "before": b, "missing_hours": int(round((b - a) / pd.Timedelta(hours=step_h))) - 1})
    n_exp = int(round((srt.max() - srt.min()) / pd.Timedelta(hours=step_h))) + 1
    nu = int(ts.nunique())
    return {"n_rows": int(len(ts)), "n_unique_timestamps": nu, "duplicate_timestamps": int(len(ts) - nu), "is_sorted": bool(ts.is_monotonic_increasing), "start": srt.min(), "end": srt.max(),
            "expected_hours": n_exp, "missing_hours_from_gaps": int(sum(g["missing_hours"] for g in gaps)), "n_gaps": len(gaps), "longest_gap_hours": max([g["missing_hours"] for g in gaps], default=0),
            "timestamp_coverage": round(nu / n_exp, 4), "gaps": gaps}


def flat_threshold(v: np.ndarray) -> int:
    """Flatline 的最短長度：依這個感測器『自己』相鄰兩小時相同的比例 p 來決定。
    若相同只是偶然（機率 p），連續 L 個相同的期望次數 ≈ n·p^(L-1)；要求它 < CHANCE_BUDGET，且至少 MIN_FLAT_H。
    解析度低、變化慢的感測器（p 高）門檻自然提高；高解析度感測器（p 低）維持 6 小時。"""
    x = v[~np.isnan(v)]
    if len(x) < 30:
        return MIN_FLAT_H
    p = float((x[1:] == x[:-1]).mean())
    if p <= 0 or p >= 1:
        return MIN_FLAT_H
    return max(MIN_FLAT_H, int(math.ceil(1 + math.log(CHANCE_BUDGET / len(x)) / math.log(p))))


def _zero_label(sem: str, hours: int) -> tuple[str, str] | None:
    """零值區段 → (語義標籤, 嚴重度)。回傳 None 代表不需要標示。"""
    if sem == CL.ZERO_LEGIT:
        return ("合法零值：此感測器為 0 是常態（例如沒有降雨、靜風、設備關閉），不視為異常", "info") if hours >= MIN_ZERO_CONTEXT_H else None
    if sem == CL.ZERO_CONTEXT:
        return ("長時間零值：可能是真實的低值／低負載／夜間，也可能是感測或通訊問題，需要脈絡確認", "check") if hours >= MIN_ZERO_CONTEXT_H else None
    return ("可疑零值：物理上不太可能長時間剛好為 0，需人工驗證（候選，不等於設備故障）", "verify") if hours >= MIN_ZERO_SUSPICIOUS_H else None


def analyze_sensor(h: pd.Series, sc: CL.SensorClass, step_h: float = 1.0) -> dict:
    """h：已補成等間隔時間軸的序列（缺的時間點是 NaN）。回傳 {summary, runs, outliers}。"""
    v = h.astype(float)
    ts = h.index
    n = len(v)
    nan = v.isna().to_numpy()
    runs: list[dict] = []
    unknown = sc.classification_status == CL.UNKNOWN
    for a, b in runs_of(nan):
        if b - a + 1 >= MIN_MISSING_RUN_H:
            runs.append({"sensor": sc.original_column_name, "run_type": "missing", "start": ts[a], "end": ts[b], "hours": int(b - a + 1), "label": "真正缺值：這段時間沒有資料（不補值、不當成 0）", "severity": "check"})
    zero = (v == 0).to_numpy()
    n_zero = int(zero.sum())
    kind = sc.measurement_kind
    for a, b in runs_of(zero):
        hrs = int(b - a + 1)
        lab = (("感測器狀態未知：不下判斷", "info") if hrs >= MIN_ZERO_SUSPICIOUS_H else None) if unknown else _zero_label(sc.zero_semantics, hrs)
        if lab:
            runs.append({"sensor": sc.original_column_name, "run_type": "zero", "start": ts[a], "end": ts[b], "hours": hrs, "label": lab[0], "severity": lab[1]})
    obs = v.dropna()
    flat_min = flat_threshold(v.to_numpy())
    n_flat_hours = 0
    if kind not in EXPECTED_CONSTANT_KINDS and not unknown:
        arr = v.to_numpy()
        same = np.r_[False, (arr[1:] == arr[:-1]) & ~nan[1:] & ~nan[:-1] & (arr[1:] != 0)]
        lo_v, hi_v = (float(obs.min()), float(obs.max())) if len(obs) else (None, None)
        for a, b in runs_of(same):
            length = int(b - a + 2)
            if length >= flat_min:
                val = float(arr[b])
                plateau = sc.sensor_group in PLATEAU_GROUPS and (val == hi_v or val == lo_v)
                if not plateau:
                    n_flat_hours += length
                runs.append({"sensor": sc.original_column_name, "run_type": "flatline", "start": ts[a - 1], "end": ts[b], "hours": length,
                             "label": ("上下限平台：停在該感測器觀測到的最大／最小值（例如電池滿電、夜間太陽能最低值），多半是正常現象" if plateau else
                                       f"非零 Flatline：連續 {length} 小時讀值完全相同（超過此感測器重複率下偶然出現的長度 {flat_min} 小時）；可能是真的沒變化，也可能是感測器停止更新"),
                             "severity": "info" if plateau else "check"})
    # 離群值候選（穩健 Z）
    outliers = []
    n_out = 0
    if len(obs) >= 30 and kind in ("continuous", "derived_index") and not unknown:
        med = float(obs.median())
        mad = float((obs - med).abs().median())
        if mad > 0:
            z = 0.6745 * (v - med) / mad
            o = z.abs() > OUTLIER_Z
            n_out = int(o.sum())
            for t in z[o].abs().sort_values(ascending=False).index[:5]:
                outliers.append({"sensor": sc.original_column_name, "time": t, "value": float(v[t]), "robust_z": round(float(z[t]), 1)})
    # 無效值（超出推測物理範圍；只是候選）
    lo, hi = None, None
    n_invalid = 0
    if not unknown and kind in ("continuous", "derived_index", "circular_angle"):
        sem_lo_hi = _phys_range(sc.original_column_name)
        if sem_lo_hi:
            lo, hi = sem_lo_hi
            n_invalid = int(((obs < lo) | (obs > hi)).sum())
    summary = {"sensor": sc.original_column_name, "sensor_type": sc.sensor_type, "classification_status": sc.classification_status, "n_hours": int(n), "n_observed": int(len(obs)),
               "observed_frac": round(float(len(obs) / n), 4) if n else None, "missing_hours": int(nan.sum()), "zero_hours": n_zero, "zero_frac_of_observed": round(n_zero / len(obs), 4) if len(obs) else None,
               "n_zero_runs_flagged": sum(1 for r in runs if r["run_type"] == "zero" and r["severity"] != "info"), "n_zero_runs_legit_long": sum(1 for r in runs if r["run_type"] == "zero" and r["severity"] == "info"),
               "flatline_hours": n_flat_hours, "n_flatline_runs": sum(1 for r in runs if r["run_type"] == "flatline"), "n_missing_runs": sum(1 for r in runs if r["run_type"] == "missing"),
               "outlier_candidates": n_out, "invalid_candidates": n_invalid, "expected_range": None if lo is None else f"[{lo:g}, {hi:g}]", "zero_semantics": sc.zero_semantics,
               "state_unknown": unknown}
    return {"summary": summary, "runs": runs, "outliers": outliers}


def _phys_range(col: str):
    import sensor_meta as SM
    s = SM.lookup(col)
    return (s["phys_min"], s["phys_max"]) if s["phys_min"] is not None and s["unit"] not in SM.STATE_UNITS else None


def _explain_conditional_zeros(h: pd.DataFrame, cls: dict, R: pd.DataFrame) -> pd.DataFrame:
    """熱指數這類『導出指標』在條件不成立時會被記成 0（例如溫度低於適用下限）。若資料顯示：該指標為 0 的列，溫度全都低於（或等於）它非零時的最低溫度，
    才把零值區段改標為『條件式零值』；沒有這個證據就維持原標籤。證據寫進標籤，不是假設。"""
    if R.empty:
        return R
    temps = [r.original_column_name for r in cls["rows"] if r.sensor_type == "Air Temperature"]
    out = R.copy()
    for r in cls["rows"]:
        if r.sensor_type != "Heat Index" or not temps:
            continue
        col = r.original_column_name
        # 同一子系統的溫度優先（欄名前綴相同，例如 'OA4 熱指數' ↔ 'OA4 溫度'）
        pre = col.split(" ")[0] if " " in col else ""
        tcol = next((t for t in temps if pre and t.startswith(pre)), temps[0])
        x = h[[col, tcol]].dropna()
        z, nz = x[x[col] == 0][tcol], x[x[col] != 0][tcol]
        if len(z) >= 24 and len(nz) >= 24 and float(z.max()) <= float(nz.min()) + 0.5:
            m = (out["sensor"] == col) & (out["run_type"] == "zero")
            out.loc[m, "label"] = (f"條件式零值：{col} 為 0 的列，{tcol} 全部 ≤ {float(z.max()):.1f}（{col} 非零時最低 {float(nz.min()):.1f}），"
                                   "與『低溫時不適用而記為 0』一致（資料證據，廠商定義仍未確認）")
            out.loc[m, "severity"] = "info"
    return out


def all_zero_rows(df: pd.DataFrame, cls: dict) -> dict:
    """整列所有『連續型』感測器同時為 0（或全 NaN）的列：很可能是感測主機沒有回報、被記成 0（Phase 5.2 的 prep 也有同樣的遮蔽）。只報告，不修改。"""
    cols = [r.original_column_name for r in cls["rows"] if r.measurement_kind in ("continuous", "derived_index") and r.classification_status != CL.UNKNOWN]
    if len(cols) < 3:
        return {"n_rows": 0, "hours": []}
    x = df[cols]
    mask = ((x == 0) | x.isna()).all(axis=1) & (x == 0).any(axis=1)
    return {"n_rows": int(mask.sum()), "hours": [pd.Timestamp(t) for t in df.loc[mask, "timestamp"].tolist()][:200], "n_sensors_checked": len(cols)}


def analyze_dataset(df: pd.DataFrame, cls: dict) -> dict:
    step = cls.get("frequency_h") or 1.0
    tq = timestamp_quality(df, step)
    h = hourly_frame(df, step)
    sensors, runs, outl = [], [], []
    for r in cls["rows"]:
        out = analyze_sensor(h[r.original_column_name], r, step)
        sensors.append(out["summary"])
        runs += out["runs"]
        outl += out["outliers"]
    S = pd.DataFrame(sensors)
    R = pd.DataFrame(runs, columns=["sensor", "run_type", "start", "end", "hours", "label", "severity"]).sort_values(["hours"], ascending=False).reset_index(drop=True) if runs else pd.DataFrame(
        columns=["sensor", "run_type", "start", "end", "hours", "label", "severity"])
    R = _explain_conditional_zeros(h, cls, R)
    obs_frac = float(S["observed_frac"].mean()) if len(S) else None
    az = all_zero_rows(df, cls)
    return {"timestamp": tq, "sensors": S, "runs": R, "outliers": pd.DataFrame(outl), "all_zero_rows": az, "mean_observed_frac": None if obs_frac is None else round(obs_frac, 4),
            "n_invalid_candidates": int(S["invalid_candidates"].sum()) if len(S) else 0, "n_flagged_runs": int((R["severity"] != "info").sum()) if len(R) else 0}
