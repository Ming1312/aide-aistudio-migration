"""
phase26_models.py — Phase 2.6 模型元件

  DeltaForecaster      預測「變化量」y − THI(t)，再加回 THI(t)。kind = hgb / ridge / xgb。
                       y 可以是 THI(t+3)（Phase 2.5 原始模型）或 max THI(t+1..t+3)（實驗 A）。
  DiurnalBaseline      日夜規律基準：THI(t) + 「同一個起點小時的平均變化量」（只用訓練資料）。
  ResidualForecaster   兩層：Forecast = DiurnalBaseline + 殘差模型（實驗 B）。
                       drop_hour=True 時殘差模型看不到 hour_sin/hour_cos，無法「重新學一次日夜週期」。
  helpers              select_cutoff_fpr（在驗證資料上選警報線）、recall_at_fpr、block_bootstrap

分位數模型與 CQR 直接沿用 Phase 2.5 的 risk_forecasting.QuantileForecaster 與 uncertainty_estimation。
"""
from __future__ import annotations

import numpy as np
import pandas as pd
import xgboost as xgb
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.linear_model import Ridge
from sklearn.metrics import roc_curve
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

import risk_forecasting as RF
from phase26_features import HOUR_FEATURES

RIDGE_ALPHA = 100.0       # Phase 2 以 CV 選出（set A）
XGB_ROUNDS = RF.XGB_ROUNDS


def _now(X) -> np.ndarray:
    return X["thi_now"].to_numpy(float)


class DeltaForecaster:
    def __init__(self, kind: str = "hgb"):
        if kind not in ("hgb", "ridge", "xgb"):
            raise ValueError(kind)
        self.kind = kind

    def fit(self, X, y):
        d = np.asarray(y, float) - _now(X)
        self.features_ = list(X.columns)
        if self.kind == "hgb":
            self.model = HistGradientBoostingRegressor(random_state=0, **RF.HGB_PARAMS).fit(X, d)
        elif self.kind == "ridge":
            self.model = make_pipeline(StandardScaler(), Ridge(alpha=RIDGE_ALPHA)).fit(X, d)
        else:
            p = dict(RF.XGB_PARAMS, objective="reg:squarederror")
            self.model = xgb.train(p, xgb.DMatrix(X.to_numpy(float), label=d), XGB_ROUNDS)
        return self

    def predict_delta(self, X) -> np.ndarray:
        Xf = X[self.features_]
        if self.kind == "xgb":
            return self.model.predict(xgb.DMatrix(Xf.to_numpy(float)))
        return self.model.predict(Xf)

    def predict(self, X) -> np.ndarray:
        return _now(X) + self.predict_delta(X)


class DiurnalBaseline:
    """日夜規律基準：預測 = THI(t) + mean_{同起點小時, 訓練資料}(y − THI(t))。只用訓練資料。"""

    def fit(self, X, y):
        d = pd.Series(np.asarray(y, float) - _now(X), index=X.index)
        self.by_hour_ = d.groupby(X.index.hour).mean().reindex(range(24))
        self.global_ = float(d.mean())
        self.by_hour_ = self.by_hour_.fillna(self.global_)
        self.counts_ = d.groupby(X.index.hour).size().reindex(range(24)).fillna(0).astype(int)
        return self

    def expected_delta(self, X) -> np.ndarray:
        return self.by_hour_.reindex(X.index.hour).to_numpy(float)

    def predict(self, X) -> np.ndarray:
        return _now(X) + self.expected_delta(X)


class ResidualForecaster:
    """
    Forecast = DiurnalBaseline + 殘差模型。
      殘差 r = y − baseline(X)，也就是「今天比日夜規律多/少了多少」。
      殘差模型 ← 其餘特徵（thi_chg、昨天同時段、感測器…）。
    注意：baseline 用「訓練資料自己」算出，所以訓練殘差比真正未見資料的殘差略小（輕微樂觀），
          這對 HGB 殘差模型會造成輕微的過度自信；正因如此要用 walk-forward 實測，不能只看理論。
    """

    def __init__(self, kind: str = "hgb", drop_hour: bool = False):
        self.kind, self.drop_hour = kind, drop_hour

    def _cols(self, X):
        return X.drop(columns=[c for c in HOUR_FEATURES if c in X.columns]) if self.drop_hour else X

    def fit(self, X, y):
        self.base = DiurnalBaseline().fit(X, y)
        r = np.asarray(y, float) - self.base.predict(X)
        Xc = self._cols(X)
        self.features_ = list(Xc.columns)
        if self.kind == "hgb":
            self.model = HistGradientBoostingRegressor(random_state=0, **RF.HGB_PARAMS).fit(Xc, r)
        else:
            self.model = make_pipeline(StandardScaler(), Ridge(alpha=RIDGE_ALPHA)).fit(Xc, r)
        return self

    def predict_residual(self, X) -> np.ndarray:
        return self.model.predict(X[self.features_])

    def predict(self, X) -> np.ndarray:
        return self.base.predict(X) + self.predict_residual(X)


# ------------------------------------------------------------------ 警報線選擇
def select_cutoff_fpr(score, event, max_fpr: float, default=None):
    """
    在驗證資料上選警報線 c（score ≥ c 警報）：
    在「驗證誤報率 FPR ≤ max_fpr」的所有 c 中，選 Recall 最高者（平手取較高的 c）。
    驗證資料只有一種類別時回傳 default。
    """
    s, e = np.asarray(score, float), np.asarray(event, bool)
    if e.sum() == 0 or (~e).sum() == 0:
        return default
    best = None
    for c in np.unique(s):
        a = s >= c
        fpr = (a & ~e).sum() / (~e).sum()
        if fpr <= max_fpr:
            rec = (a & e).sum() / e.sum()
            if best is None or rec > best[1] or (rec == best[1] and c > best[0]):
                best = (c, rec)
    return float(best[0]) if best else float(np.max(s) + 1e-9)       # 達不到就不警報


def recall_at_fpr(event, score, fpr_targets=(0.10, 0.15, 0.20)):
    """pooled ROC 曲線上，FPR ≤ 目標時能達到的最高 Recall（用來比較『排序能力』，與選門檻無關）。"""
    e = np.asarray(event, int)
    if e.sum() == 0 or e.sum() == len(e):
        return {f: np.nan for f in fpr_targets}
    fpr, tpr, _ = roc_curve(e, np.asarray(score, float))
    return {f: float(tpr[fpr <= f].max()) for f in fpr_targets}


def block_bootstrap(stat_fn, n, block=24, B=1000, seed=0):
    """24 小時區塊 bootstrap：回傳 (2.5%, 97.5%, P(stat>0))。stat_fn(ix) 以索引陣列計算統計量。"""
    rng = np.random.default_rng(seed)
    starts_all = np.arange(0, max(n - block + 1, 1))
    k = int(np.ceil(n / block))
    vals = []
    for _ in range(B):
        st = rng.choice(starts_all, size=k, replace=True)
        ix = np.concatenate([np.arange(s, min(s + block, n)) for s in st])[:n]
        v = stat_fn(ix)
        if v is not None and np.isfinite(v):
            vals.append(v)
    vals = np.asarray(vals)
    return float(np.quantile(vals, 0.025)), float(np.quantile(vals, 0.975)), float((vals > 0).mean())
