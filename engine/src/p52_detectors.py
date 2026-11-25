"""
p52_detectors.py — Phase 5.2：因果、對缺口敏感的 DO 異常偵測器

偵測器（全部單一 DO 通道；Level 2 的狀態只有 NORMAL / ALERT / UNKNOWN）
  rule_based   Level 1 資料品質規則（缺口、零值區塊、非零卡值、不合理值、突變）→ 多種事件型態
  robust_z     訓練期統計量（median、MAD）的 Robust Z：水準偏離與 3 小時變化的較大者
  ewma         快速 EWMA 與『過去 N 小時滾動中位數基準』的差（持續偏移偵測）
  iforest      Isolation Forest（視窗特徵，DO-only 或 DO+負載脈絡）

因果性與缺口規則（有測試）
  * 第 t 小時的分數只用 ≤ t 的資料（滾動視窗、shift、ewm 皆為因果）。
  * 不跨缺口：缺值／零值／不合理值先遮蔽為 NaN；長缺口（≥ SEGMENT_RESET_GAP_HOURS）後開始新片段，滾動統計與 EWMA 不跨片段；
    差分遇到 NaN 就是 NaN，所以資料恢復後的第一筆不會被當成突跳。
  * 片段開始後至少 WARMUP_HOURS 個有效小時才給分數，之前是 UNKNOWN。
  * 分數不是機率：robust_z／ewma 的分數是『標準化偏離倍數』，iforest 的分數是 −score_samples（越大越異常）；
    門檻 = 擬合資料分數的名目分位數（警報預算），不是機率。
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))

import p52_config as C  # noqa: E402
import p52_data as D  # noqa: E402

UNKNOWN, NORMAL, ALERT = "UNKNOWN", "NORMAL", "ALERT"


class DetectorNotTrainable(ValueError):
    pass


class DetectorNotFitted(RuntimeError):
    pass


# ============================================================ 共用：因果滾動、尺度
def seg_roll(s: pd.Series, seg: pd.Series, window: int, fn: str, min_frac: float = C.MIN_VALID_FRAC, min_periods: int | None = None) -> pd.Series:
    mp = min_periods if min_periods is not None else max(2, math.ceil(min_frac * window))
    r = s.groupby(seg).rolling(window, min_periods=mp)
    out = getattr(r, fn)()
    out.index = out.index.droplevel(0)
    return out.reindex(s.index)


def robust_scale(x: np.ndarray, floor: float) -> tuple[float, float, bool]:
    """(median, sigma, guard_applied)。sigma = max(1.4826·MAD, floor)；floor ≤ 0 → 不可訓練。"""
    x = np.asarray(x, float)
    x = x[np.isfinite(x)]
    if len(x) < 30:
        raise DetectorNotTrainable(f"訓練資料不足（{len(x)} < 30 個有效點）")
    med = float(np.median(x))
    mad = float(np.median(np.abs(x - med))) * 1.4826
    if floor <= 0:
        raise DetectorNotTrainable("尺度下限 ≤ 0：特徵幾乎恆定，無法建立穩健尺度")
    return med, max(mad, floor), mad < floor


OTSU_MIN_BETWEEN_FRACTION = 0.85     # 單峰常態資料的類間變異占比約 0.63、均勻分布約 0.76；真實 CPM 為 0.979。
#                                      凍結的 Manifest 文字寫 ≥0.5（測試發現這對單峰資料太寬鬆）；真實資料不受影響（0.979 同時滿足兩者），所以凍結後修正程式、不重凍結。


def otsu_threshold(v: np.ndarray, bins: int = 64) -> float | None:
    """一維兩群分割（Otsu）：資料導出的『低負載／高負載』切點；雙峰不明顯（類間變異占比 < OTSU_MIN_BETWEEN_FRACTION）→ None。"""
    v = np.asarray(v, float)
    v = v[np.isfinite(v)]
    if len(v) < 50 or np.ptp(v) == 0:
        return None
    hist, edges = np.histogram(v, bins=bins)
    p = hist / hist.sum()
    mids = (edges[:-1] + edges[1:]) / 2
    w0 = np.cumsum(p)
    m0 = np.cumsum(p * mids)
    mt = m0[-1]
    with np.errstate(divide="ignore", invalid="ignore"):
        sb = (mt * w0 - m0) ** 2 / (w0 * (1 - w0))
    sb = np.nan_to_num(sb, nan=-1)
    k = int(np.argmax(sb))
    total_var = float(np.var(v))
    if total_var == 0 or sb[k] / total_var < OTSU_MIN_BETWEEN_FRACTION:
        return None
    return float(edges[k + 1])


# ============================================================ 特徵（因果）
def features(pc: pd.DataFrame, kind: str, load_threshold: float | None = None) -> pd.DataFrame:
    y, seg = pc["y_clean"], pc["segment"]
    d1 = y - y.shift(1)
    d3 = y - y.shift(3)
    f = pd.DataFrame(index=pc.index)
    f["y"] = y
    f["d1"] = d1
    f["d3"] = d3
    f["mean6"] = seg_roll(y, seg, 6, "mean")
    f["std6"] = seg_roll(y, seg, 6, "std")
    f["dev_med24"] = y - seg_roll(y.shift(1), seg, 24, "median")                    # 與『過去 24 小時（不含當下）』中位數的偏差
    if kind in ("basic_trend", "basic_trend+load"):
        idx = np.arange(6, dtype=float)

        def slope(w):
            if np.isnan(w).any():
                return np.nan
            return float(np.polyfit(idx, w, 1)[0])
        f["slope6"] = y.groupby(seg).rolling(6, min_periods=6).apply(slope, raw=True).droplevel(0).reindex(y.index)
        f["std24"] = seg_roll(y, seg, 24, "std")
    if kind == "basic_trend+load":
        cur = pc[C.CONTEXT_COL] if C.CONTEXT_COL in pc else pd.Series(np.nan, index=pc.index)
        f["cur"] = cur
        f["d1_cur"] = cur - cur.shift(1)
        f["low_load"] = (cur < load_threshold).astype(float).where(cur.notna()) if load_threshold is not None else np.nan
    return f


def unknown_reason(pc: pd.DataFrame, feat_ok: pd.Series) -> pd.Series:
    r = pd.Series("", index=pc.index, dtype=object)
    r[~feat_ok] = "FEATURE_NAN"
    r[pc["seg_age"] < C.WARMUP_HOURS] = "WARMUP"
    r[pc["zero"] | pc["invalid"]] = "MASKED_INVALID"
    r[pc["missing"]] = "MISSING"
    return r


def finalize(score: pd.Series, pc: pd.DataFrame, thr: float | None) -> pd.DataFrame:
    ok = score.notna() & (pc["seg_age"] >= C.WARMUP_HOURS) & pc["usable"]
    sc = score.where(ok)
    reason = unknown_reason(pc, score.notna())
    state = pd.Series(UNKNOWN, index=pc.index, dtype=object)
    if thr is not None:
        state[ok & (sc >= thr)] = ALERT
        state[ok & (sc < thr)] = NORMAL
    return pd.DataFrame({"score": sc, "state": state, "unknown_reason": reason.where(state == UNKNOWN, "")})


# ============================================================ Level 2 偵測器
class Level2Detector:
    detector_id = ""
    cfg: dict

    def __init__(self, cfg: dict | None = None):
        self.cfg = dict(cfg or {})
        self.fitted = False
        self.threshold: float | None = None
        self.reference_scores: np.ndarray | None = None

    # 子類實作
    def _fit_stats(self, pc: pd.DataFrame, rows: pd.Series, ctx: dict) -> None: ...
    def _raw_score(self, pc: pd.DataFrame) -> pd.Series: ...

    def fit(self, pc: pd.DataFrame, fit_mask: pd.Series | None = None, budget_q: float = C.ALERT_BUDGET_QUANTILE) -> "Level2Detector":
        mask = pd.Series(True, index=pc.index) if fit_mask is None else fit_mask.reindex(pc.index).fillna(False)
        rows = mask & pc["usable"] & (pc["seg_age"] >= C.WARMUP_HOURS)
        if rows.sum() < 60:
            raise DetectorNotTrainable(f"訓練資料不足：可用列 {int(rows.sum())} < 60")
        self._fit_stats(pc, rows, {})
        sc = self._raw_score(pc)[rows].dropna()
        if len(sc) < 30:
            raise DetectorNotTrainable("可評分的訓練列不足 30")
        self.reference_scores = np.sort(sc.to_numpy())
        self.set_budget(budget_q)
        self.fitted = True
        return self

    def set_budget(self, q: float) -> None:
        self.budget_q = q
        self.threshold = float(np.quantile(self.reference_scores, q))

    def score(self, pc: pd.DataFrame) -> pd.DataFrame:
        if not self.fitted:
            raise DetectorNotFitted(f"{self.detector_id} 尚未訓練")
        out = finalize(self._raw_score(pc), pc, self.threshold)
        out["score_percentile"] = np.searchsorted(self.reference_scores, out["score"].to_numpy(), side="right") / len(self.reference_scores)
        out.loc[out["score"].isna(), "score_percentile"] = np.nan
        return out

    def state_dict(self) -> dict:
        return {"detector_id": self.detector_id, "cfg": self.cfg, "threshold": self.threshold, "budget_q": self.budget_q}

    def _load_stats(self, d: dict) -> None:
        raise NotImplementedError(f"{self.detector_id} 不支援由 artifact 載入（只有 robust_z 與 rule_based 會被服務）")

    @classmethod
    def from_state(cls, d: dict, reference_scores) -> "Level2Detector":
        """由凍結的 artifact 狀態重建（服務用）：不看任何資料、不重新擬合。"""
        if d.get("detector_id") != cls.detector_id:
            raise ValueError(f"artifact 的 detector_id={d.get('detector_id')!r} 與 {cls.detector_id!r} 不符")
        o = cls(d.get("cfg"))
        o._load_stats(d)
        o.reference_scores = np.sort(np.asarray(reference_scores, float))
        o.budget_q = float(d["budget_q"])
        o.threshold = float(d["threshold"])
        o.fitted = True
        return o


class RobustZ(Level2Detector):
    detector_id = "robust_z"

    def _fit_stats(self, pc, rows, ctx):
        y = pc.loc[rows, "y_clean"]
        floor_level = C.MAD_FLOOR_FRAC * float(y.quantile(0.95) - y.quantile(0.05))
        self.med, self.sig, self.guard_level = robust_scale(y.to_numpy(), floor_level)
        d3 = (pc["y_clean"] - pc["y_clean"].shift(3))[rows]
        floor_d3 = C.MAD_FLOOR_FRAC * float(d3.quantile(0.95) - d3.quantile(0.05)) if d3.notna().sum() > 5 else 0.0
        self.med3, self.sig3, self.guard_d3 = robust_scale(d3.dropna().to_numpy(), floor_d3)

    def _load_stats(self, d):
        self.med, self.sig, self.med3, self.sig3 = d["median"], d["sigma"], d["median_d3"], d["sigma_d3"]
        self.guard_level, self.guard_d3 = d["mad_guard_level"], d["mad_guard_d3"]

    def _raw_score(self, pc):
        y = pc["y_clean"]
        z1 = (y - self.med).abs() / self.sig
        z3 = ((y - y.shift(3)) - self.med3).abs() / self.sig3
        return pd.concat([z1, z3], axis=1).max(axis=1, skipna=False)

    def state_dict(self):
        d = super().state_dict()
        d.update(median=self.med, sigma=self.sig, median_d3=self.med3, sigma_d3=self.sig3, mad_guard_level=bool(self.guard_level), mad_guard_d3=bool(self.guard_d3))
        return d


class EWMA(Level2Detector):
    detector_id = "ewma"
    SKIP = 6                                                  # 基準不含最近 6 小時，使『剛發生的偏移』可被看見

    def _dev(self, pc):
        y, seg = pc["y_clean"], pc["segment"]
        lam, bh = self.cfg["lam"], self.cfg["baseline_hours"]
        ew = y.groupby(seg).transform(lambda s: s.ewm(alpha=lam, adjust=False, ignore_na=True).mean())
        ew = ew.where(y.notna())
        base = seg_roll(y.shift(self.SKIP), seg, bh, "median", min_periods=24)
        return ew - base

    def _fit_stats(self, pc, rows, ctx):
        dev = self._dev(pc)[rows].dropna()
        floor = C.MAD_FLOOR_FRAC * float(dev.quantile(0.95) - dev.quantile(0.05)) if len(dev) > 5 else 0.0
        self.med, self.sig, self.guard = robust_scale(dev.to_numpy(), floor)

    def _raw_score(self, pc):
        return ((self._dev(pc) - self.med).abs() / self.sig)

    def state_dict(self):
        d = super().state_dict()
        d.update(center=self.med, sigma=self.sig, mad_guard=bool(self.guard))
        return d


class IForest(Level2Detector):
    detector_id = "iforest"

    def __init__(self, cfg=None):
        super().__init__(cfg)
        self.model = None
        self.load_threshold = None
        self.columns: list[str] = []

    @property
    def kind(self):
        return self.cfg.get("features", "basic")

    def _features(self, pc):
        return features(pc, self.kind, self.load_threshold)

    def _fit_stats(self, pc, rows, ctx):
        from sklearn.ensemble import IsolationForest
        if "load" in self.kind:
            self.load_threshold = otsu_threshold(pc.loc[rows, C.CONTEXT_COL].to_numpy()) if C.CONTEXT_COL in pc else None
            if self.load_threshold is None:
                raise DetectorNotTrainable("CPM 電流不是明顯雙峰，無法導出負載狀態切點；不建立含負載脈絡的模型")
        F = self._features(pc)
        self.columns = list(F.columns)
        X = F[rows].dropna()
        if len(X) < 60:
            raise DetectorNotTrainable(f"完整特徵列不足：{len(X)} < 60")
        if ((X.std() / (1.0 + X.abs().mean())) < 1e-9).all():                   # 相對尺度判斷（滾動標準差有浮點誤差，不會剛好是 0）
            raise DetectorNotTrainable("所有特徵恆定")
        ms = min(int(self.cfg.get("max_samples", 256)), len(X))
        self.model = IsolationForest(max_samples=ms, **{**C.IF_FIXED, "random_state": int(self.cfg.get("seed", C.IF_FIXED["random_state"]))}).fit(X.to_numpy())

    def _raw_score(self, pc):
        F = self._features(pc)
        ok = F.notna().all(axis=1)
        s = pd.Series(np.nan, index=pc.index)
        if ok.any():
            s[ok] = -self.model.score_samples(F[ok].to_numpy())
        return s

    def state_dict(self):
        d = super().state_dict()
        d.update(features=self.columns, load_threshold=self.load_threshold, n_estimators=C.IF_FIXED["n_estimators"], random_state=C.IF_FIXED["random_state"])
        return d


class IForestCtx(IForest):
    detector_id = "iforest_ctx"


DETECTORS = {"robust_z": RobustZ, "ewma": EWMA, "iforest": IForest, "iforest_ctx": IForestCtx}


def make(detector_id: str, cfg: dict | None = None) -> Level2Detector:
    if detector_id not in DETECTORS:
        raise KeyError(f"未知的偵測器 {detector_id!r}（可用：{sorted(DETECTORS)}）")
    return DETECTORS[detector_id](cfg)


# ============================================================ Level 1：規則型（Baseline A）
EVENT_TYPES_L1 = ("SENSOR_GAP", "ZERO_RUN_REQUIRES_VERIFICATION", "NONZERO_FLATLINE", "INVALID_VALUE_CANDIDATE", "ABRUPT_CHANGE")


class RuleBased:
    detector_id = "rule_based"

    def __init__(self, rules: dict | None = None):
        self.rules = rules or C.RULES
        self.fitted = False
        self.abrupt_scale = None

    def fit(self, pc: pd.DataFrame, fit_mask: pd.Series | None = None) -> "RuleBased":
        mask = pd.Series(True, index=pc.index) if fit_mask is None else fit_mask.reindex(pc.index).fillna(False)
        y = pc["y_clean"]
        d1 = (y - y.shift(1))[mask & pc["usable"]].dropna()
        if len(d1) < 30:
            raise DetectorNotTrainable("訓練資料不足，無法估計突變尺度")
        mad = float(np.median(np.abs(d1 - np.median(d1)))) * 1.4826
        self.abrupt_guard = mad < C.ABRUPT_SCALE_FLOOR
        self.abrupt_scale = max(mad, C.ABRUPT_SCALE_FLOOR)
        self.fitted = True
        return self

    def alerts(self, pc: pd.DataFrame) -> dict[str, pd.DataFrame]:
        """每種事件型態一個 DataFrame：alert（bool）、known（該小時是否有資料可判斷）、run_start（run 型態的起點，起點必然 ≤ 當下）。"""
        if not self.fitted:
            raise DetectorNotFitted("rule_based 尚未訓練（突變尺度來自訓練期）")
        R = self.rules
        one = pd.Timedelta(hours=1)
        idx = pc.index
        k = R["abrupt_change_k"]["value"]
        out = {}
        gap_alert = pc["gap_run"] >= R["sensor_gap_hours"]["value"]
        out["SENSOR_GAP"] = pd.DataFrame({"alert": gap_alert, "known": pd.Series(True, index=idx), "run_start": idx - (pc["gap_run"] - 1).clip(lower=0) * one}, index=idx)
        zr = pc["zero_run"] >= R["zero_run_min_hours"]["value"]
        out["ZERO_RUN_REQUIRES_VERIFICATION"] = pd.DataFrame({"alert": zr, "known": ~pc["missing"], "run_start": idx - (pc["zero_run"] - 1).clip(lower=0) * one}, index=idx)
        fl = pc["flat_len"] >= R["nonzero_flatline_hours"]["value"]
        out["NONZERO_FLATLINE"] = pd.DataFrame({"alert": fl, "known": ~pc["missing"], "run_start": idx - (pc["flat_len"] - 1).clip(lower=0) * one}, index=idx)
        out["INVALID_VALUE_CANDIDATE"] = pd.DataFrame({"alert": pc["invalid"], "known": ~pc["missing"], "run_start": idx}, index=idx)
        d1 = (pc["y_clean"] - pc["y_clean"].shift(1)).abs()
        out["ABRUPT_CHANGE"] = pd.DataFrame({"alert": d1 >= k * self.abrupt_scale, "known": pc["d1_valid"], "run_start": idx}, index=idx)
        return out

    @classmethod
    def from_state(cls, d: dict) -> "RuleBased":
        if d.get("detector_id") != cls.detector_id:
            raise ValueError(f"artifact 的 detector_id={d.get('detector_id')!r} 與 rule_based 不符")
        for k, v in d["rules"].items():                                   # 規則門檻必須與目前版本相同；不同 → 版本不相容，拒絕（不靜默套用新門檻）
            cur = C.RULES[k]
            if (cur["value"], cur["source"], cur["flag"]) != (v["value"], v["source"], v["flag"]):
                raise ValueError(f"規則 {k} 與 artifact 凍結的版本不同（artifact {v['value']} vs 目前 {cur['value']}）：版本不相容")
        o = cls()
        o.abrupt_scale, o.abrupt_guard, o.fitted = float(d["abrupt_scale"]), bool(d.get("abrupt_guard", False)), True
        return o

    def state_dict(self):
        return {"detector_id": self.detector_id, "abrupt_scale": self.abrupt_scale, "abrupt_guard": bool(getattr(self, "abrupt_guard", False)),
                "rules": {k: {"value": v["value"], "source": v["source"], "flag": v["flag"]} for k, v in self.rules.items()}}
