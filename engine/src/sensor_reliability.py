"""
sensor_reliability.py — Phase 2.5 改良 C：感測器可信度評估模組（Sensor Reliability Assessment）

這個模組「獨立於預測模型」：它只看輸入資料，回答「這批輸入可不可信？為什麼？」
狀態只有三種，而且每一項判斷都留下原因（findings）：
  reliable   沒發現問題
  warning    有疑點，但仍可能是真實現象（例：超出訓練範圍、短缺口已補值、變化很快）
  unreliable 幾乎可以確定輸入有問題（例：超出物理範圍、卡值、THI 與溫濕度公式不一致）
我們刻意「不」輸出 0~100 分：沒有標註過的真實故障資料可校正，分數無法解讀成機率。

門檻從哪裡來？fit() 只看訓練資料學：
  - 每個連續型感測器在正常資料中「連續相同值」最長幾小時 → 卡值門檻 = max(6, 2 × 最長值)
  - 每小時最大變化量 → 突跳門檻
  - THI 與 NRC 公式（由溫濕度計算）的差 → 一致性門檻
  - 兩個溫度感測點（成羊區平均 vs ID4）差值與其 24 小時平均 → 不一致 / 漂移門檻
  - 每個時段的 THI 平均與標準差 → 「對這個時段來說不尋常」
感測器分類（不同類別用不同規則，避免誤判）：
  continuous  溫度、濕度、THI：檢查卡值、突跳、範圍
  rain        雨量：長時間 0 是正常的，不檢查卡值；只檢查負值與物理上限
  state       風扇/捲簾/遮陽狀態碼：長時間不變是正常的；只檢查「沒見過的代碼」
"""
from __future__ import annotations

import json

import numpy as np
import pandas as pd

import features as F

STATUS_ORDER = {"reliable": 0, "warning": 1, "unreliable": 2}

# 物理合理範圍（與 sensor_meta.py 一致）
PHYSICAL = {F.TARGET: (50, 100), F.TEMP: (0, 45), F.RH: (1, 100), F.ID4_T: (0, 45), F.ID4_RH: (1, 100), F.RAIN: (0, 200)}
CONTINUOUS = [F.TARGET, F.TEMP, F.RH, F.ID4_T, F.ID4_RH]


def nrc_thi(temp_c, rh):
    """NRC (1971) 溫濕指數：THI = 1.8T + 32 − (0.55 − 0.0055·RH)(1.8T − 26)。"""
    t, h = np.asarray(temp_c, float), np.asarray(rh, float)
    return 1.8 * t + 32 - (0.55 - 0.0055 * h) * (1.8 * t - 26)


def _max_identical_run(s: pd.Series) -> int:
    s = s.dropna()
    if s.empty:
        return 0
    return int(s.groupby((s != s.shift()).cumsum()).size().max())


def _tail_identical_run(s: pd.Series) -> int:
    v = s.to_numpy(float)
    if len(v) == 0 or np.isnan(v[-1]):
        return 0
    n = 1
    while n < len(v) and v[-1 - n] == v[-1]:
        n += 1
    return n


class SensorReliabilityAssessor:
    def __init__(self, window_hours: int = 24, max_fill_hours: int = 2):
        self.window_hours, self.max_fill_hours = window_hours, max_fill_hours
        self.params: dict = {}

    # ---------------------------------------------------------- 學門檻（只用訓練資料）
    def fit(self, grid: pd.DataFrame):
        p = {"stuck_hours": {}, "max_step": {}, "train_range": {}, "state_codes": {}}
        for c in CONTINUOUS:
            if c not in grid:
                continue
            s = grid[c]
            p["stuck_hours"][c] = int(max(6, 2 * _max_identical_run(s)))
            p["max_step"][c] = float(s.diff().abs().max())
            p["train_range"][c] = [float(s.min()), float(s.max())]
        if F.RAIN in grid:
            p["train_range"][F.RAIN] = [0.0, float(grid[F.RAIN].max())]
        for c in [*F.FANS, F.CURTAIN, F.SHADE]:
            if c in grid:
                p["state_codes"][c] = sorted(float(v) for v in grid[c].dropna().unique())
        r = grid[F.TARGET] - nrc_thi(grid[F.TEMP], grid[F.RH])
        p["nrc_offset_mean"], p["nrc_offset_std"] = float(r.mean()), float(r.std())
        p["nrc_tolerance"] = float(max(0.5, 5 * r.std()))
        for name, a, b in (("temp_gap", F.ID4_T, F.TEMP), ("rh_gap", F.ID4_RH, F.RH)):
            gap = grid[a] - grid[b]
            g24 = gap.rolling(24, min_periods=18).mean()
            p[name] = {"min": float(gap.min()), "max": float(gap.max()),
                       "mean24_min": float(g24.min()), "mean24_max": float(g24.max())}
        hourly = grid[F.TARGET].groupby(grid.index.hour)
        p["thi_hour_mean"] = hourly.mean().reindex(range(24)).tolist()
        p["thi_hour_std"] = hourly.std().reindex(range(24)).fillna(hourly.std().mean()).tolist()
        p["train_period"] = [str(grid.index.min()), str(grid.index.max())]
        self.params = p
        return self

    # ---------------------------------------------------------- 存/讀
    def to_dict(self):
        return {"window_hours": self.window_hours, "max_fill_hours": self.max_fill_hours, "params": self.params}

    @classmethod
    def from_dict(cls, d):
        obj = cls(d["window_hours"], d["max_fill_hours"])
        obj.params = d["params"]
        return obj

    # ---------------------------------------------------------- 評估
    def assess(self, grid: pd.DataFrame, origin: pd.Timestamp, required_columns, raw_duplicates: int = 0) -> dict:
        """
        grid: 完整每小時格子（未補值；缺的小時為 NaN）。origin: 預測起點。
        required_columns: 模型實際使用的欄位；其他欄位的問題只當作 info，不影響狀態。
        """
        p = self.params
        origin = pd.Timestamp(origin)
        w = grid.loc[origin - pd.Timedelta(hours=self.window_hours - 1): origin]
        req = set(required_columns)
        findings = []

        def add(code, sensor, severity, reason, **evidence):
            if sensor is not None and sensor not in req and severity != "info":
                severity = "info"
            findings.append(dict(code=code, sensor=sensor, severity=severity, reason=reason,
                                 evidence={k: (round(v, 3) if isinstance(v, float) else v) for k, v in evidence.items()}))

        # 1) 時間戳記 / 缺值 / 缺口
        expected = self.window_hours
        if len(w) < expected:
            add("INSUFFICIENT_HISTORY", None, "unreliable", f"起點前只有 {len(w)} 小時資料，需要 {expected} 小時", hours=len(w))
        if raw_duplicates:
            add("DUPLICATE_TIMESTAMPS", None, "warning", f"原始資料有 {raw_duplicates} 筆重複時間（保留最後一筆）", n=raw_duplicates)
        for c in req:
            if c not in grid:
                add("MISSING_COLUMN", c, "unreliable", "必要欄位不存在")
                continue
            s = w[c]
            if s.isna().any():
                run = s.isna().astype(int).groupby(s.notna().cumsum()).sum().max()
                if pd.isna(s.iloc[-1]):
                    add("MISSING_AT_ORIGIN", c, "unreliable", "預測起點當下沒有讀值")
                elif run > self.max_fill_hours:
                    add("LONG_GAP", c, "unreliable", f"連續缺值 {int(run)} 小時，超過可補上限 {self.max_fill_hours}", gap_hours=int(run))
                else:
                    add("SHORT_GAP_FILLED", c, "warning", f"有 {int(s.isna().sum())} 小時缺值，以前一筆補上", missing=int(s.isna().sum()))

        if any(f["severity"] == "unreliable" and f["code"] in ("INSUFFICIENT_HISTORY", "MISSING_COLUMN") for f in findings):
            return self._summarize(findings, origin)

        filled = w.ffill(limit=self.max_fill_hours)
        last = filled.iloc[-1]

        # 2) 物理範圍 / 訓練範圍（OOD）
        for c, (lo, hi) in PHYSICAL.items():
            if c not in filled:
                continue
            s = filled[c].dropna()
            bad = s[(s < lo) | (s > hi)]
            if len(bad):
                add("PHYSICALLY_IMPLAUSIBLE", c, "unreliable", f"出現物理上不合理的值 {bad.iloc[-1]}（合理範圍 {lo}~{hi}）",
                    value=float(bad.iloc[-1]), n=int(len(bad)))
            elif c in p["train_range"]:
                tlo, thi_ = p["train_range"][c]
                v = float(last[c]) if not pd.isna(last[c]) else np.nan
                if not np.isnan(v) and (v < tlo or v > thi_):
                    add("OUT_OF_TRAINING_RANGE", c, "warning",
                        f"目前值 {v} 超出訓練資料範圍 {tlo}~{thi_}；可能是真實的新狀況，但模型沒學過", value=v)

        # 3) 卡值（只檢查連續型感測器）
        for c in CONTINUOUS:
            if c not in filled:
                continue
            run = _tail_identical_run(filled[c].dropna())
            lim = p["stuck_hours"].get(c, 6)
            if run >= lim:
                add("SENSOR_FROZEN", c, "unreliable", f"最近 {run} 小時讀值完全相同（訓練資料中正常最長只有 {lim // 2} 小時）",
                    run_hours=run, limit=lim)

        # 4) 突跳
        for c in CONTINUOUS:
            if c not in filled:
                continue
            step = float(abs(filled[c].iloc[-1] - filled[c].iloc[-2])) if len(filled) >= 2 else 0.0
            lim = p["max_step"].get(c, np.inf)
            if step > lim:
                add("SUDDEN_JUMP", c, "warning", f"最近 1 小時變化 {step:.2f}，超過訓練資料中的最大變化 {lim:.2f}",
                    step=step, limit=lim)

        # 5) 狀態碼：只檢查沒見過的代碼（長時間不變是正常的）
        for c, codes in p["state_codes"].items():
            if c in filled and not pd.isna(last[c]) and float(last[c]) not in codes:
                add("UNKNOWN_STATE_CODE", c, "warning", f"狀態碼 {last[c]} 不曾出現在訓練資料（已知：{codes}）", value=float(last[c]))

        # 6) 冗餘一致性：THI 應等於 NRC(溫度, 濕度) + 固定偏移
        r = filled[F.TARGET] - nrc_thi(filled[F.TEMP], filled[F.RH]) - p["nrc_offset_mean"]
        r_recent = r.iloc[-6:].abs()
        if r_recent.max() > p["nrc_tolerance"]:
            add("THI_INCONSISTENT_WITH_TEMP_RH", F.TARGET, "unreliable",
                f"THI 與溫濕度公式計算值相差 {r_recent.max():.2f}（容許 {p['nrc_tolerance']:.2f}）；THI 或溫濕度其中之一有問題",
                max_abs_diff=float(r_recent.max()))

        # 7) 兩個感測點互相比對：瞬間不一致 / 慢慢漂移
        for name, a, b in (("temp_gap", F.ID4_T, F.TEMP), ("rh_gap", F.ID4_RH, F.RH)):
            gp = p[name]
            gap = filled[a] - filled[b]
            g_now = float(gap.iloc[-1])
            g24 = float(gap.mean())
            margin = 0.5 if name == "temp_gap" else 3.0
            if g_now < gp["min"] - margin or g_now > gp["max"] + margin:
                add("SENSOR_DISAGREEMENT", b, "warning",
                    f"{a} 與 {b} 相差 {g_now:.2f}，超出訓練時的範圍 {gp['min']:.2f}~{gp['max']:.2f}；無法判斷是哪一支有問題",
                    gap=g_now)
            elif g24 < gp["mean24_min"] - margin / 2 or g24 > gp["mean24_max"] + margin / 2:
                add("POSSIBLE_DRIFT", b, "warning",
                    f"{a} 與 {b} 的 24 小時平均差 {g24:.2f}，超出訓練時 {gp['mean24_min']:.2f}~{gp['mean24_max']:.2f}；可能有一支漂移",
                    mean24_gap=g24)

        # 8) 對這個時段而言不尋常（可能是真實的熱浪，所以只是 warning）
        h = origin.hour
        z = (float(last[F.TARGET]) - p["thi_hour_mean"][h]) / max(p["thi_hour_std"][h], 0.3)
        if abs(z) > 4:
            add("UNUSUAL_FOR_HOUR", F.TARGET, "warning", f"THI 對 {h} 點而言偏離平常 {z:+.1f} 個標準差", z=z)

        # 9) 季節外推
        t0, t1 = (pd.Timestamp(x) for x in p["train_period"])
        if origin > t1 + pd.Timedelta(days=14) or origin < t0 - pd.Timedelta(days=14):
            add("SEASON_EXTRAPOLATION", None, "warning", f"起點 {origin.date()} 距離訓練期間 {t0.date()}~{t1.date()} 超過 14 天")

        return self._summarize(findings, origin)

    def thi_channel_reconstructable(self, report: dict) -> bool:
        """
        感測器冗餘（redundancy）：若「只有 THI 這一路」有問題，而溫度、濕度本身正常、且與另一個感測點 ID4 一致，
        就可用 NRC 公式從溫濕度重建 THI。若溫濕度也有疑點，無法判斷誰錯，不重建。
        """
        thi_bad = [f for f in report["findings"] if f["sensor"] == F.TARGET and f["severity"] == "unreliable"]
        others_bad = [f for f in report["findings"] if f["sensor"] in (F.TEMP, F.RH, F.ID4_T, F.ID4_RH)
                      and f["severity"] in ("warning", "unreliable")]
        global_bad = [f for f in report["findings"] if f["sensor"] is None and f["severity"] == "unreliable"]
        return bool(thi_bad) and not others_bad and not global_bad

    def reconstruct_thi(self, grid: pd.DataFrame) -> pd.Series:
        return pd.Series(np.round(nrc_thi(grid[F.TEMP], grid[F.RH]) + self.params["nrc_offset_mean"], 1), index=grid.index)

    @staticmethod
    def _summarize(findings, origin):
        status = "reliable"
        for f in findings:
            if f["severity"] in STATUS_ORDER and STATUS_ORDER[f["severity"]] > STATUS_ORDER[status]:
                status = f["severity"]
        return {"status": status, "origin": str(origin), "findings": findings,
                "reasons": [f["reason"] for f in findings if f["severity"] != "info"]}


if __name__ == "__main__":
    from load_data import load_sensor_csv
    from pathlib import Path
    df, _ = load_sensor_csv(Path(__file__).resolve().parent.parent / "data" / "raw" / "羊舍.csv")
    g = F.to_hourly_grid(df)
    a = SensorReliabilityAssessor().fit(g)
    print(json.dumps(a.assess(g, g.index[-1], F.REQUIRED_COLUMNS["B"]), ensure_ascii=False, indent=1))
