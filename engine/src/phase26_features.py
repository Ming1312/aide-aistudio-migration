"""
phase26_features.py — Phase 2.6 的標籤（Label）與基準特徵

沿用 Phase 2 的 features.py 作為「特徵」的唯一來源（訓練與推論相同），這裡只新增「標籤」：

  y3   = THI(t+3)                          Phase 2/2.5 的目標
  ymax = max{THI(t+1), THI(t+2), THI(t+3)} Phase 2.6 新目標：未來三小時內最高 THI

【標籤的安全規則】
  1. 用「時間戳記」查值（reindex），不是用 row 位置 shift。
  2. 只要 t+1、t+2、t+3 任何一個沒有資料，ymax 就是 NaN（不是只取有資料的那幾個）。
     原因：缺的那一小時可能正好是最高點，直接取剩下的最大值會得到偏低的錯誤標籤。
  3. ymax 只能當標籤或事後分析；任何特徵都不得使用它。
  4. 事件定義（只用於評估）：
       E3   = THI(t+3) ≥ T                 「三小時後」是否超標
       Emax = max THI(t+1..t+3) ≥ T         「未來三小時內」是否出現超標
     Emax ⊇ E3（E3 發生則 Emax 必發生），兩者是不同任務，不能直接比較 MAE。
"""
from __future__ import annotations

import numpy as np
import pandas as pd

import features as F

HOUR_FEATURES = ["hour_sin", "hour_cos"]


def future_matrix(grid: pd.DataFrame, horizon: int = 3) -> np.ndarray:
    """shape (n, horizon)：第 k 欄 = THI(t+k+1)，以時間戳記對齊；沒有資料的地方為 NaN。"""
    thi = grid[F.TARGET]
    cols = [thi.reindex(grid.index + pd.Timedelta(hours=k)).to_numpy() for k in range(1, horizon + 1)]
    return np.column_stack(cols)


def make_max_label(grid: pd.DataFrame, horizon: int = 3) -> pd.Series:
    M = future_matrix(grid, horizon)
    ymax = np.where(np.isnan(M).any(axis=1), np.nan, np.nanmax(np.where(np.isnan(M), -np.inf, M), axis=1))
    return pd.Series(ymax, index=grid.index, name=f"thi_max_t+1..t+{horizon}")


def yesterday_window_max(grid: pd.DataFrame, horizon: int = 3) -> pd.Series:
    """
    Seasonal Naive 的「最大值」版本：昨天同一個窗口 [t+1−24, t+3−24] 的最大 THI。
    這個窗口在 t 時刻已經全部過去（最晚是 t−21），所以可以安全使用。
    """
    thi = grid[F.TARGET]
    lags = np.column_stack([thi.shift(24 - k).to_numpy() for k in range(1, horizon + 1)])
    v = np.where(np.isnan(lags).any(axis=1), np.nan, np.max(np.where(np.isnan(lags), -np.inf, lags), axis=1))
    return pd.Series(v, index=grid.index, name="yday_window_max")


def make_dataset26(grid: pd.DataFrame, horizon: int = 3, feature_set: str = "B"):
    """
    回傳 (XB, XA, y3, ymax, snm)，全部使用相同的 origin 集合（所有特徵與兩個標籤都有值）。
    XB/XA = Phase 2 的特徵集 B/A（不新增特徵；Phase 2.6 是最後一輪預先界定的研究）。
    snm（昨天同窗口最大值）只用於 Seasonal Naive 基準，不是模型特徵。
    """
    XB = F.build_features(grid, horizon, feature_set)
    XA = F.build_features(grid, horizon, "A")
    y3 = F.make_label(grid, horizon)
    ymax = make_max_label(grid, horizon)
    snm = yesterday_window_max(grid, horizon)
    ok = XB.notna().all(axis=1) & XA.notna().all(axis=1) & y3.notna() & ymax.notna() & snm.notna()
    return XB[ok], XA[ok], y3[ok], ymax[ok], snm[ok]


def rapid_rise(y3: pd.Series, now: pd.Series, thresh: float = 2.0) -> pd.Series:
    """【事後分析專用】THI(t+3) − THI(t) > thresh。不得作為模型輸入。"""
    return (y3 - now) > thresh
