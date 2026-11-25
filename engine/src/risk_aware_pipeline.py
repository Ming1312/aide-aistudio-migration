"""
risk_aware_pipeline.py — JNC Risk-Aware AIoT Prediction Framework（推論端的組裝）

  IoT 感測資料（CSV）
    → [1] Sensor Reliability Module      sensor_reliability.py   可信度 + 原因
    → [2] 應對策略（事先由 Experiment 4 決定）
           unreliable 且只有 THI 通道壞 → 用溫濕度重建 THI（感測器冗餘）
           unreliable 其他               → 拒絕預測（輸出 null，要求人工檢查）
           warning                       → 正常預測，但區間放寬到 98%
    → [3] Feature Engineering            features.py（與訓練完全相同）
    → [4] Forecasting Model              Phase 2 HGB 點預測（未改動）
    → [5] Uncertainty Estimation         HGB 分位數 + CQR 校正（90%）
    → [6] Risk Assessment                P(THI ≥ T) + 警報線（內層驗證選出）→ risk_level + 原因
    → 結構化輸出（JSON，給 Phase 3 決策引擎）

每個模組都可單獨測試、單獨替換（例如換掉風險機率的來源，只需改 bundle["risk_head"]）。
本檔「不訓練」任何東西：只載入 models/phase25/ 的 bundle。
"""
from __future__ import annotations

import hashlib
from pathlib import Path

import joblib
import numpy as np
import pandas as pd

import features as F
import risk_assessment as RA
import uncertainty_estimation as UE
from sensor_reliability import SensorReliabilityAssessor

MODEL_VERSION = "phase2_5"


def load_bundle(path) -> dict:
    path = Path(path)
    b = joblib.load(path)
    if b.get("model_version") != MODEL_VERSION:
        raise ValueError(f"{path} 不是 Phase 2.5 模型（model_version={b.get('model_version')}）")
    b["_sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()[:16]
    b["_assessor"] = SensorReliabilityAssessor.from_dict(b["reliability"])
    return b


def _round(v, n=2):
    return None if v is None or not np.isfinite(v) else round(float(v), n)


def predict(df: pd.DataFrame, bundle: dict, as_of=None, threshold: float | None = None, max_stale_hours: int = 2) -> dict:
    """
    df: load_sensor_csv() 的結果（timestamp + 感測欄位）。as_of: 模擬「現在」；只使用 ≤ as_of 的資料。
    回傳結構化 dict（欄位意義見 README「輸出格式」）。無法可靠估計的欄位一律為 None（JSON null）。
    """
    H, fs = bundle["horizon"], bundle["feature_set"]
    T = float(threshold if threshold is not None else bundle["default_threshold"])
    if T not in bundle["alert_cutoffs"]:
        raise ValueError(f"門檻 {T} 沒有在訓練時校正過；可用：{sorted(bundle['alert_cutoffs'])}")
    req = F.REQUIRED_COLUMNS[fs]
    out = {"forecast_target": "THI", "site": "羊舍 成羊區", "forecast_horizon_hours": H,
           "origin_time": None, "target_time": None, "current_thi": None,
           "point_prediction": None,
           "prediction_interval": {"lower": None, "upper": None, "nominal_coverage": None, "method": None,
                                   "backtest_empirical_coverage": bundle["backtest"].get("interval_coverage")},
           "prediction_uncertainty": None,
           "sensor_reliability": None, "reliability_findings": [], "handling": None,
           "risk": {"threshold": T, "threshold_status": "candidate_unconfirmed", "p_exceed": None,
                    "p_exceed_method": bundle["risk_head"], "alert": None, "alert_cutoff": bundle["alert_cutoffs"][T],
                    "risk_level": "unknown", "risk_reasons": []},
           "references": {}, "model_version": MODEL_VERSION,
           "model_info": {"bundle_sha256": bundle.get("_sha256"), "trained_on": bundle["train_period"],
                          "backtest_summary": bundle["backtest"]},
           "warnings": []}

    d = df.copy()
    if as_of is not None:
        d = d[d["timestamp"] <= pd.Timestamp(as_of)]
    n_dup = int(d["timestamp"].duplicated().sum())
    missing_cols = [c for c in req if c not in d.columns]
    if d.empty or missing_cols:
        out["sensor_reliability"] = "unreliable"
        out["handling"] = "refused"
        reason = f"缺少必要欄位：{missing_cols}" if missing_cols else "沒有資料"
        out["reliability_findings"] = [{"code": "MISSING_COLUMN" if missing_cols else "NO_DATA", "severity": "unreliable", "reason": reason}]
        out["risk"]["risk_reasons"] = [reason]
        return out
    grid = F.to_hourly_grid(d).iloc[-(24 * 5):]          # 特徵最多回看 24h；多留一點給檢查
    # 預測起點：最新一筆「THI 有值」的時間；落後太多就拒絕
    feed_end = grid.index[-1]
    valid = grid.index[grid[F.TARGET].notna()]
    origin = valid[-1] if len(valid) else feed_end
    stale = int((feed_end - origin) / pd.Timedelta(hours=1))
    out["origin_time"], out["target_time"] = str(origin), str(origin + pd.Timedelta(hours=H))
    if stale:
        out["warnings"].append(f"最新時刻 {feed_end} 沒有 THI，起點退回 {origin}（落後 {stale} 小時）")
    if stale > max_stale_hours:
        out["sensor_reliability"], out["handling"] = "unreliable", "refused"
        out["reliability_findings"] = [{"code": "STALE_DATA", "severity": "unreliable", "reason": f"THI 已 {stale} 小時沒有新讀值"}]
        out["risk"]["risk_reasons"] = ["資料過期，無法預測（請檢查感測器或傳輸）"]
        return out

    g = grid.loc[:origin]
    assessor: SensorReliabilityAssessor = bundle["_assessor"]
    rep = assessor.assess(g, origin, req, raw_duplicates=n_dup)
    status = rep["status"]
    out["sensor_reliability"] = status
    out["reliability_findings"] = [f for f in rep["findings"] if f["severity"] != "info"]
    out["current_thi"] = _round(g[F.TARGET].iloc[-1], 1) if not pd.isna(g[F.TARGET].iloc[-1]) else None

    gx = g
    handling = "normal"
    if status == "unreliable":
        if assessor.thi_channel_reconstructable(rep):
            gx = g.copy()
            gx[F.TARGET] = assessor.reconstruct_thi(g)
            handling = "thi_reconstructed_from_temp_rh"
            out["warnings"].append("THI 感測值不可信，但溫度/濕度正常且與 ID4 一致：已用 NRC 公式由溫濕度重建 THI 後預測（區間放寬至 98%）")
        else:
            out["handling"] = "refused"
            out["risk"]["risk_reasons"] = ["輸入資料不可信，拒絕預測，請人工檢查：" + "；".join(rep["reasons"][:3])]
            return out
    elif status == "warning":
        handling = "interval_widened"
    out["handling"] = handling

    X = F.build_features(F.fill_short_gaps(gx, assessor.max_fill_hours), H, fs).loc[[origin]]
    if X.isna().any(axis=1).iloc[0]:
        out["handling"], out["sensor_reliability"] = "refused", "unreliable"
        out["risk"]["risk_reasons"] = ["特徵無法完整計算（資料缺口），拒絕預測"]
        return out

    point = float(bundle["point_model"].predict(X)[0])
    q = bundle["quantile_model"].predict(X)[0]                     # [q05 ... q95]
    wide = handling != "normal"
    mg = bundle["cqr_margin_98"] if wide else bundle["cqr_margin_90"]
    lo, hi = q[0] - mg, q[-1] + mg
    out["point_prediction"] = _round(point)
    out["prediction_interval"].update(lower=_round(lo), upper=_round(hi), nominal_coverage=0.98 if wide else 0.90,
                                      method="HGB quantile q05/q95 + CQR" + (" (widened)" if wide else ""))
    out["prediction_uncertainty"] = {"interval_width": _round(hi - lo),
                                     "typical_abs_error_backtest": bundle["backtest"].get("MAE")}

    # 風險
    if bundle["risk_head"] == "linear_quantile":
        qq = bundle["risk_model"].predict(F.build_features(F.fill_short_gaps(gx, assessor.max_fill_hours), H, "A").loc[[origin]])
        p_ex = float(UE.prob_exceed_from_quantiles(qq, bundle["risk_levels"], T)[0])
    else:
        p_ex = float(UE.prob_exceed_from_residuals([point], bundle["residuals"], T)[0])
    cut = bundle["alert_cutoffs"][T]
    level, reasons = RA.assess_risk(point, lo, hi, p_ex, status, threshold=T, alert_cutoff=cut)
    if handling == "thi_reconstructed_from_temp_rh":
        reasons.insert(0, "此預測使用由溫濕度重建的 THI")
    out["risk"].update(p_exceed=_round(p_ex, 3), alert=bool(p_ex >= cut), risk_level=level, risk_reasons=reasons)

    yday = F.build_features(gx, H, "A").loc[origin, "thi_yday_at_target"]
    out["references"] = {"persistence": _round(gx[F.TARGET].iloc[-1]), "seasonal_naive_yesterday": _round(yday),
                         "note": "簡單基準，供人員對照；非模型輸出"}
    return out


def backtest(df: pd.DataFrame, bundle: dict, start=None, threshold: float | None = None) -> pd.DataFrame:
    """
    逐小時模擬上線：每個 origin 只用該時刻以前的資料呼叫 predict()，再與 t+H 的實際值比對。
    用途：在「新資料」（訓練期間之後）做前瞻測試，不重新訓練。
    """
    H = bundle["horizon"]
    ts = df["timestamp"].sort_values()
    ts = ts[ts >= pd.Timestamp(start)] if start is not None else ts.iloc[24:]
    actual = df.set_index("timestamp")[F.TARGET]
    rows = []
    for t in ts:
        r = predict(df, bundle, as_of=t, threshold=threshold)
        tgt = pd.Timestamp(r["target_time"]) if r["target_time"] else pd.Timestamp(t) + pd.Timedelta(hours=H)
        rows.append(dict(origin=r["origin_time"], target_time=tgt, handling=r["handling"], reliability=r["sensor_reliability"],
                         point=r["point_prediction"], lower=r["prediction_interval"]["lower"], upper=r["prediction_interval"]["upper"],
                         p_exceed=r["risk"]["p_exceed"], alert=r["risk"]["alert"], risk_level=r["risk"]["risk_level"],
                         actual=float(actual.get(tgt, np.nan)),
                         in_training_period=pd.Timestamp(t) <= pd.Timestamp(bundle["train_period"][1])))
    return pd.DataFrame(rows)
