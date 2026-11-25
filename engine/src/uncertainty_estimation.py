"""
uncertainty_estimation.py — Phase 2.5 改良 B：預測區間與超標機率

【共同前提】所有「校正資料（calibration set）」都必須是「樣本外」的預測誤差：
  也就是模型在「沒看過的時間段」上犯的錯。用訓練資料自己的殘差會嚴重低估誤差。
  evaluate_phase25.py / train_phase25.py 用「內層 walk-forward」產生這些樣本外殘差。

方法
  residual_interval       Phase 2 的做法：點預測 + 樣本外殘差的分位數
  split_conformal         對稱版：點預測 ± 樣本外 |殘差| 的 conformal 分位數
  cqr_margin / cqr        Conformalized Quantile Regression（Romano et al., 2019）
  mondrian_conformal      依「時段」分組各自校正（誤差大小隨時段不同）
  AdaptiveConformal       ACI（Gibbs & Candès, 2021）：依最近是否覆蓋，線上調整 α
  prob_exceed_*           P(THI ≥ T)：由殘差分布或分位數推得

【時間序列的限制】一般 conformal 的保證是「若校正資料與新資料可交換（exchangeable）」，
  覆蓋率 ≥ 1−α。時間序列有自相關、有季節/天氣變化，這個前提不成立，
  所以保證「不適用」；我們只能用回測量測「實際」覆蓋率，並用 ACI 等方法緩解。
"""
from __future__ import annotations

import math

import numpy as np
import pandas as pd


# ------------------------------------------------------------------ 基本工具
def conformal_quantile(scores, alpha: float) -> float:
    """有限樣本修正的分位數：第 ⌈(n+1)(1−α)⌉ 小的值。n 太小（做不到）時回傳 +inf（誠實：無法給區間）。"""
    s = np.sort(np.asarray(scores, float))
    s = s[~np.isnan(s)]
    n = len(s)
    k = math.ceil((n + 1) * (1 - alpha))
    if n == 0 or k > n:
        return float("inf")
    return float(s[k - 1])


def residual_interval(point, residuals, alpha: float):
    """Phase 2 式：[point + q_{α/2}(r), point + q_{1−α/2}(r)]，r = y − pred（樣本外）。"""
    r = np.asarray(residuals, float)
    lo, hi = np.quantile(r, [alpha / 2, 1 - alpha / 2])
    p = np.asarray(point, float)
    return p + lo, p + hi


def split_conformal(point, residuals, alpha: float):
    m = conformal_quantile(np.abs(residuals), alpha)
    p = np.asarray(point, float)
    return p - m, p + m


def cqr_scores(q_lo, q_hi, y):
    """CQR 的 conformity score：E = max(q_lo − y, y − q_hi)。>0 代表落在區間外多遠；<0 代表在區間內。"""
    return np.maximum(np.asarray(q_lo, float) - np.asarray(y, float), np.asarray(y, float) - np.asarray(q_hi, float))


def cqr_margin(cal_q_lo, cal_q_hi, cal_y, alpha: float) -> float:
    return conformal_quantile(cqr_scores(cal_q_lo, cal_q_hi, cal_y), alpha)


def cqr(q_lo, q_hi, margin: float):
    """區間 = [q_lo − m, q_hi + m]。m 可以是負的（原始分位數區間太寬時會縮小）。"""
    return np.asarray(q_lo) - margin, np.asarray(q_hi) + margin


HOUR_GROUPS = {"night(0-5)": range(0, 6), "morning(6-11)": range(6, 12),
               "afternoon(12-17)": range(12, 18), "evening(18-23)": range(18, 24)}


def hour_group(target_hours) -> np.ndarray:
    lut = {h: g for g, hs in HOUR_GROUPS.items() for h in hs}
    return np.array([lut[int(h)] for h in target_hours])


def mondrian_conformal(point, target_hours, cal_residuals, cal_target_hours, alpha: float, min_group: int = 20):
    """依目標時段分組的 split conformal；某組校正資料 < min_group 筆時改用全體（避免小樣本亂跳）。"""
    p = np.asarray(point, float)
    g_te, g_cal = hour_group(target_hours), hour_group(cal_target_hours)
    r = np.abs(np.asarray(cal_residuals, float))
    m_all = conformal_quantile(r, alpha)
    m = np.empty(len(p))
    for g in np.unique(g_te):
        rg = r[g_cal == g]
        m[g_te == g] = conformal_quantile(rg, alpha) if len(rg) >= min_group else m_all
    return p - m, p + m


class AdaptiveConformal:
    """
    ACI：α_{t+1} = α_t + γ(α − err_t)，err_t = 1 表示「上一個已知結果沒被區間蓋住」。
    沒蓋住 → α_t 變小 → 區間變寬；連續蓋住 → 區間慢慢變窄。
    時間序列特有的「延遲」：t 時刻的預測，要到 t+H 才知道對錯，所以只能用已到期的結果更新。
    """

    def __init__(self, alpha: float = 0.1, gamma: float = 0.005):
        self.alpha, self.gamma = alpha, gamma

    def run(self, times, lo_fn, hi_fn, y, horizon: int):
        """
        times: 依時間排序的 origin；lo_fn(i, a)/hi_fn(i, a) 給出第 i 筆在 α=a 時的區間；y: 實際值（只在到期後使用）。
        回傳 (lo, hi, alpha_path)。
        """
        times = pd.DatetimeIndex(times)
        a_t = self.alpha
        lo, hi, path = np.empty(len(times)), np.empty(len(times)), np.empty(len(times))
        pending = []                                   # (到期時間, 是否覆蓋)
        for i, t in enumerate(times):
            still = []
            for due, err in pending:                  # 只使用「t 時刻已經知道結果」的誤差
                if due <= t:
                    a_t = a_t + self.gamma * (self.alpha - err)
                else:
                    still.append((due, err))
            pending = still
            a_use = float(np.clip(a_t, 1e-3, 0.999))
            lo[i], hi[i], path[i] = lo_fn(i, a_use), hi_fn(i, a_use), a_use
            err = float(not (lo[i] <= y[i] <= hi[i]))
            pending.append((t + pd.Timedelta(hours=horizon), err))
        return lo, hi, path


# ------------------------------------------------------------------ 超標機率
def prob_exceed_from_residuals(point, residuals, threshold: float) -> np.ndarray:
    """
    Conformal predictive distribution（簡化版）：把樣本外殘差 r_j 加到點預測上，當作可能的未來值，
    P(y ≥ T) ≈ (#{point + r_j ≥ T} + 1) / (n + 2)   （+1/+2 避免輸出 0 或 1 的過度自信）
    """
    r = np.asarray(residuals, float)
    p = np.asarray(point, float)[:, None]
    return ((p + r[None, :] >= threshold).sum(axis=1) + 1.0) / (len(r) + 2.0)


def prob_exceed_from_quantiles(qmat, levels, threshold: float) -> np.ndarray:
    """
    由分位數組成分段線性的 CDF，P(y ≥ T) = 1 − F(T)。
    尾端（T 在最低/最高分位數之外）用最外側兩個分位數的斜率線性外插，再夾在 [0.005, 0.995]。
    """
    lv = np.asarray(levels, float)
    out = np.empty(len(qmat))
    for i, q in enumerate(np.asarray(qmat, float)):
        q = np.maximum.accumulate(q)
        if threshold <= q[0]:
            slope = (lv[1] - lv[0]) / max(q[1] - q[0], 1e-6)
            F = lv[0] - slope * (q[0] - threshold)
        elif threshold >= q[-1]:
            slope = (lv[-1] - lv[-2]) / max(q[-1] - q[-2], 1e-6)
            F = lv[-1] + slope * (threshold - q[-1])
        else:
            F = np.interp(threshold, q, lv)
        out[i] = 1.0 - F
    return np.clip(out, 0.005, 0.995)


# ------------------------------------------------------------------ 區間評估
def interval_metrics(lo, hi, y, alpha: float) -> dict:
    lo, hi, y = (np.asarray(v, float) for v in (lo, hi, y))
    ok = ~np.isnan(lo) & ~np.isnan(hi) & np.isfinite(lo) & np.isfinite(hi)
    lo, hi, y = lo[ok], hi[ok], y[ok]
    if len(y) == 0:
        return dict(n=0, coverage=np.nan, mean_width=np.nan, interval_score=np.nan)
    cover = (y >= lo) & (y <= hi)
    width = hi - lo
    # Winkler / interval score（Gneiting & Raftery 2007）：寬度 + 沒蓋住時的懲罰 (2/α)·距離。越小越好。
    score = width + (2 / alpha) * (lo - y) * (y < lo) + (2 / alpha) * (y - hi) * (y > hi)
    return dict(n=int(len(y)), coverage=float(cover.mean()), mean_width=float(width.mean()),
                interval_score=float(score.mean()), miss_below=float((y < lo).mean()), miss_above=float((y > hi).mean()))


def pinball_loss(qmat, levels, y) -> float:
    q = np.asarray(qmat, float)
    u = np.asarray(y, float)[:, None] - q
    tau = np.asarray(levels, float)[None, :]
    return float(np.mean(np.maximum(tau * u, (tau - 1) * u)))
