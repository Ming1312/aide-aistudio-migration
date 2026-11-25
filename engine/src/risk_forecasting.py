"""
risk_forecasting.py — Phase 2.5 改良 A：風險敏感式預測模型

本檔只負責「模型」：給特徵 X，輸出預測。風險判斷與區間校正在其他模組。
所有回歸模型都預測「變化量」delta = THI(t+H) − THI(t)，再加回 thi_now，
與 Phase 2 完全相同（因此可以公平比較）。

包含：
  PointForecaster        Phase 2 的 HGB 點預測（Experiment 1 的原始模型）
  QuantileForecaster     分位數回歸：HGB / XGBoost / 線性 QuantileRegressor
  AsymmetricXGBForecaster 自訂非對稱損失（高 THI 時低估懲罰 k 倍）的 XGBoost
  RiskClassifier         直接分類：P(THI(t+H) ≥ T)，HGB 或 Logistic Regression
  HourlyClimatologyProb  只看「目標時刻是幾點」的超標機率（日夜週期基準）
"""
from __future__ import annotations

import numpy as np
import pandas as pd
import xgboost as xgb
from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor
from sklearn.linear_model import LogisticRegression, QuantileRegressor
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

# Phase 2 以 CV 選出的超參數（models/selection_h3.json）。Phase 2.5 不重新調參：
# 資料少時，多一輪調參就多一分「對驗證資料過擬合」的風險。
HGB_PARAMS = dict(learning_rate=0.03, max_leaf_nodes=4, min_samples_leaf=20, max_iter=250, l2_regularization=1.0)
XGB_PARAMS = dict(max_depth=3, learning_rate=0.03, min_child_weight=15, subsample=0.8, colsample_bytree=0.8,
                  reg_lambda=1.0, tree_method="hist", seed=0, nthread=1)
XGB_ROUNDS = 100
QUANTILE_LEVELS = (0.05, 0.10, 0.25, 0.50, 0.75, 0.90, 0.95)


def _delta(X: pd.DataFrame, y: pd.Series) -> np.ndarray:
    return (np.asarray(y, float) - X["thi_now"].to_numpy(float))


# ------------------------------------------------------------------ 點預測（Phase 2 原始模型）
class PointForecaster:
    def __init__(self, params: dict | None = None):
        self.params = params or HGB_PARAMS
        self.model = None

    def fit(self, X, y):
        self.model = HistGradientBoostingRegressor(random_state=0, **self.params).fit(X, _delta(X, y))
        self.features_ = list(X.columns)
        return self

    def predict(self, X) -> np.ndarray:
        return X["thi_now"].to_numpy(float) + self.model.predict(X[self.features_])


# ------------------------------------------------------------------ 分位數回歸（A1 / B1）
class QuantileForecaster:
    """
    Quantile Regression：對每個分位數 τ 學一個函數 q_τ(X)，使 P(y ≤ q_τ(X)) ≈ τ。
    做法是最小化 pinball loss：ρ_τ(u) = max(τ·u, (τ−1)·u)，u = y − q。
      τ=0.9 時，低估（u>0）每單位罰 0.9，高估每單位只罰 0.1 → 模型被推向「偏高」的位置。
    kind:
      "hgb"    每個 τ 一個 HistGradientBoostingRegressor(loss="quantile")
      "xgb"    一個 XGBoost 模型同時輸出多個 τ（objective="reg:quantileerror"）
      "linear" 每個 τ 一個線性 QuantileRegressor（小資料時最不容易過擬合）
    輸出會「排序」以消除分位數交叉（quantile crossing；rearrangement 方法）。
    """

    def __init__(self, kind: str = "hgb", levels=QUANTILE_LEVELS, linear_alpha: float = 0.001):
        if kind not in ("hgb", "xgb", "linear"):
            raise ValueError(kind)
        self.kind, self.levels, self.linear_alpha = kind, tuple(levels), linear_alpha
        self.models = None

    def fit(self, X, y):
        d = _delta(X, y)
        self.features_ = list(X.columns)
        if self.kind == "hgb":
            self.models = [HistGradientBoostingRegressor(loss="quantile", quantile=q, random_state=0, **HGB_PARAMS).fit(X, d)
                           for q in self.levels]
        elif self.kind == "xgb":
            p = dict(XGB_PARAMS, objective="reg:quantileerror", quantile_alpha=np.array(self.levels))
            self.models = xgb.train(p, xgb.DMatrix(X.to_numpy(float), label=d), XGB_ROUNDS)
        else:
            self.models = [make_pipeline(StandardScaler(), QuantileRegressor(quantile=q, alpha=self.linear_alpha,
                                                                             solver="highs")).fit(X, d)
                           for q in self.levels]
        return self

    def predict(self, X) -> np.ndarray:
        """回傳 shape (n, len(levels)) 的 THI 分位數（絕對值，已排序）。"""
        Xf = X[self.features_]
        if self.kind == "xgb":
            q = self.models.predict(xgb.DMatrix(Xf.to_numpy(float)))
            q = q.reshape(len(Xf), -1)
        else:
            q = np.column_stack([m.predict(Xf) for m in self.models])
        q = np.sort(q, axis=1)
        return X["thi_now"].to_numpy(float)[:, None] + q


# ------------------------------------------------------------------ 非對稱損失（A2）
def asymmetric_grad_hess(pred: np.ndarray, delta_true: np.ndarray, y_abs: np.ndarray,
                         k: float, soft_threshold: float):
    """
    自訂損失：L = w · (pred − y)²
      w = k  當「低估」(pred < y) 且 真實 THI ≥ soft_threshold
      w = 1  其他情況
    梯度 g = ∂L/∂pred = 2w(pred − y)；Hessian h = ∂²L/∂pred² = 2w（> 0，XGBoost 需要 h > 0）。
    w 在 pred = y 處不連續，但 L 在該點是連續且一階可導（兩邊導數都是 0），所以可用。
    注意：k=1 時就是一般的平方誤差。
    """
    w = np.where((pred < delta_true) & (y_abs >= soft_threshold), k, 1.0)
    return 2.0 * w * (pred - delta_true), 2.0 * w


class AsymmetricXGBForecaster:
    def __init__(self, k: float = 2.0, soft_threshold: float = 83.0, rounds: int = XGB_ROUNDS):
        self.k, self.soft_threshold, self.rounds = k, soft_threshold, rounds
        self.booster = None

    def fit(self, X, y):
        d = _delta(X, y)
        y_abs = np.asarray(y, float)
        self.features_ = list(X.columns)

        def obj(predt, dtrain):
            return asymmetric_grad_hess(predt, dtrain.get_label(), y_abs, self.k, self.soft_threshold)

        params = dict(XGB_PARAMS, base_score=float(np.mean(d)))
        self.booster = xgb.train(params, xgb.DMatrix(X.to_numpy(float), label=d), self.rounds, obj=obj)
        return self

    def predict(self, X) -> np.ndarray:
        return X["thi_now"].to_numpy(float) + self.booster.predict(xgb.DMatrix(X[self.features_].to_numpy(float)))


# ------------------------------------------------------------------ 直接分類（A3）
class RiskClassifier:
    """直接學 P(THI(t+H) ≥ T)。kind: "hgb"（樹）或 "logit"（Logistic Regression，較不易過擬合）。"""

    def __init__(self, threshold: float, kind: str = "logit"):
        self.threshold, self.kind = threshold, kind
        self.model = None

    def fit(self, X, y):
        z = (np.asarray(y, float) >= self.threshold).astype(int)
        self.features_ = list(X.columns)
        self.n_events_, self.n_ = int(z.sum()), len(z)
        if z.min() == z.max():                      # 訓練資料只有一種類別：無法訓練
            self.constant_ = float(z[0])
            return self
        self.constant_ = None
        if self.kind == "hgb":
            self.model = HistGradientBoostingClassifier(learning_rate=0.03, max_leaf_nodes=4, min_samples_leaf=20,
                                                        max_iter=200, l2_regularization=1.0, random_state=0)
        else:
            self.model = make_pipeline(StandardScaler(), LogisticRegression(C=0.1, max_iter=2000))
        self.model.fit(X, z)
        return self

    def predict_proba(self, X) -> np.ndarray:
        if self.constant_ is not None:
            return np.full(len(X), self.constant_)
        return self.model.predict_proba(X[self.features_])[:, 1]


class HourlyClimatologyProb:
    """基準：P(超標 | 目標時刻是幾點)，只用訓練資料；Laplace 平滑。代表「只知道日夜週期」能做到的程度。"""

    def __init__(self, threshold: float, horizon: int = 3):
        self.threshold, self.horizon = threshold, horizon

    def fit(self, X, y):
        h = (X.index + pd.Timedelta(hours=self.horizon)).hour
        z = (np.asarray(y, float) >= self.threshold).astype(float)
        g = pd.Series(z, index=h).groupby(level=0)
        self.p_ = ((g.sum() + 0.5) / (g.count() + 1.0)).reindex(range(24))
        self.p_ = self.p_.fillna(float(z.mean()))
        return self

    def predict_proba(self, X) -> np.ndarray:
        h = (X.index + pd.Timedelta(hours=self.horizon)).hour
        return self.p_.reindex(h).to_numpy(float)


# ------------------------------------------------------------------ 基準預測（與 Phase 2 定義一致）
def baseline_point_preds(Xtr, ytr, Xte, horizon: int = 3) -> dict:
    now = Xte["thi_now"].to_numpy(float)
    out = {"Persistence": now, "SeasonalNaive24h": Xte["thi_yday_at_target"].to_numpy(float)}
    d_tr = pd.Series(np.asarray(ytr, float) - Xtr["thi_now"].to_numpy(float), index=Xtr.index)
    by_hour = d_tr.groupby(Xtr.index.hour).mean()
    out["DiurnalDelta"] = now + by_hour.reindex(Xte.index.hour).fillna(0).to_numpy()
    return out
