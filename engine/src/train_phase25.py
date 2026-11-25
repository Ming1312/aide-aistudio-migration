"""
train_phase25.py — 訓練並儲存 Phase 2.5 完整架構（models/phase25/）

執行：
  python src/train_phase25.py                                  # 用全部資料訓練正式模型
  python src/train_phase25.py --train-until "2026-08-09 00:00" --tag until0809   # 只用某時間以前（回測/重現用）

訓練步驟（與 evaluate_phase25.py 的外層折「完全相同」，所以可以互相驗證）：
  1. 起點 S = --train-until（預設：最後一筆資料之後）。訓練樣本 = 標籤時間 < S。
  2. 內層 walk-forward：S 前 5 天，每天 24 小時，用「當天以前」的資料訓練、預測當天 → 樣本外預測
  3. 由內層樣本外預測決定：CQR 校正量（90%、98%）、各候選門檻的警報線（目標 recall 0.9）
  4. 用全部訓練樣本重新訓練最終模型
  5. 感測器可信度模組用訓練期間資料學門檻
  6. 存檔：joblib bundle + meta JSON（含版本、hash、回測摘要、凍結紀錄）
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
import sklearn
import xgboost

sys.path.insert(0, str(Path(__file__).resolve().parent))
import features as F
import risk_assessment as RA
import risk_forecasting as RF
import uncertainty_estimation as UE
from load_data import load_sensor_csv
from risk_aware_pipeline import MODEL_VERSION
from sensor_reliability import SensorReliabilityAssessor

ROOT = Path(__file__).resolve().parent.parent
H, FS = 3, "B"
THRESHOLDS = (83.0, 84.0, 85.0)
INNER_DAYS = 5
TARGET_RECALL = 0.9


def fit_models(XB, XA, y, risk_head):
    m = {"point": RF.PointForecaster().fit(XB, y), "q": RF.QuantileForecaster("hgb").fit(XB, y)}  # 7 個分位數（與評估相同；排序修正分位數交叉）
    if risk_head == "linear_quantile":
        m["risk"] = RF.QuantileForecaster("linear").fit(XA, y)
    return m


def train(raw: Path, train_until, risk_head: str, backtest_summary: dict) -> dict:
    df, _ = load_sensor_csv(raw)
    grid = F.to_hourly_grid(df)
    XB, y = F.make_dataset(grid, H, FS)
    XA = F.build_features(grid, H, "A").loc[XB.index]
    S = pd.Timestamp(train_until) if train_until else XB.index.max() + pd.Timedelta(hours=H + 1)
    idx = XB.index
    purge = S - pd.Timedelta(hours=H)

    # ---- 內層 walk-forward（樣本外校正資料）
    rows = []
    for j in range(INNER_DAYS, 0, -1):
        b = S - pd.Timedelta(days=j)
        tr = idx < b - pd.Timedelta(hours=H)
        te = (idx >= b) & (idx < b + pd.Timedelta(hours=24)) & (idx < purge)
        if te.sum() == 0:
            continue
        mm = fit_models(XB[tr], XA[tr], y[tr], risk_head)
        r = pd.DataFrame(index=idx[te])
        r["y"], r["block"] = y[te].to_numpy(), j
        r["point"] = mm["point"].predict(XB[te])
        q = mm["q"].predict(XB[te])
        r["q_lo"], r["q_hi"] = q[:, 0], q[:, -1]
        if risk_head == "linear_quantile":
            r[[f"lq{i}" for i in range(len(RF.QUANTILE_LEVELS))]] = mm["risk"].predict(XA[te])
        rows.append(r)
    inner = pd.concat(rows)
    resid = (inner["y"] - inner["point"]).to_numpy()
    cqr90 = UE.cqr_margin(inner["q_lo"], inner["q_hi"], inner["y"], 0.10)
    cqr98 = UE.cqr_margin(inner["q_lo"], inner["q_hi"], inner["y"], 0.02)

    cutoffs, cut_meta = {}, {}
    blocks = inner["block"].to_numpy()
    for T in THRESHOLDS:
        if risk_head == "linear_quantile":
            p_in = UE.prob_exceed_from_quantiles(inner[[f"lq{i}" for i in range(len(RF.QUANTILE_LEVELS))]].to_numpy(), RF.QUANTILE_LEVELS, T)
        else:  # 留一個 block 的殘差（與 evaluate_phase25 相同）
            p_in = np.empty(len(inner))
            for b in np.unique(blocks):
                mb = blocks == b
                p_in[mb] = UE.prob_exceed_from_residuals(inner["point"][mb], resid[~mb], T)
        c, meta = RA.select_cutoff(p_in, inner["y"].to_numpy() >= T, TARGET_RECALL, default=0.5)
        cutoffs[T], cut_meta[T] = c, meta

    # ---- 最終模型
    tr = idx < purge
    final = fit_models(XB[tr], XA[tr], y[tr], risk_head)
    assessor = SensorReliabilityAssessor().fit(grid[grid.index < S])
    train_period = [str(idx[tr].min()), str(idx[tr].max() + pd.Timedelta(hours=H))]
    return {
        "model_version": MODEL_VERSION, "horizon": H, "feature_set": FS,
        "point_model": final["point"], "quantile_model": final["q"],
        "risk_model": final.get("risk"), "risk_head": risk_head, "risk_levels": RF.QUANTILE_LEVELS,
        "residuals": resid, "cqr_margin_90": float(cqr90), "cqr_margin_98": float(cqr98),
        "alert_cutoffs": cutoffs, "alert_cutoff_selection": {str(k): v for k, v in cut_meta.items()},
        "target_recall": TARGET_RECALL, "default_threshold": 84.0, "thresholds_status": "candidate_unconfirmed",
        "reliability": assessor.to_dict(),
        "train_period": train_period, "n_train": int(tr.sum()), "n_inner_calibration": len(inner),
        "inner_MAE_point": float(np.mean(np.abs(resid))),
        "backtest": backtest_summary,
        "created": datetime.now().isoformat(timespec="seconds"),
        "versions": {"python": sys.version.split()[0], "sklearn": sklearn.__version__, "xgboost": xgboost.__version__,
                     "pandas": pd.__version__, "numpy": np.__version__},
    }


def read_backtest_summary(risk_head: str) -> dict:
    """從 evaluate_phase25.py 的輸出取回測數字，寫進模型檔，讓推論輸出能誠實附上「這個模型在回測的表現」。"""
    p = ROOT / "outputs" / "phase25"
    try:
        u = pd.read_excel(p / "uncertainty_evaluation.xlsx", sheet_name="pooled")
        cov = float(u[(u.method == "HGB 分位數+CQR") & (u.nominal > 0.85)].coverage.iloc[0])
        pt = pd.read_excel(p / "model_comparison.xlsx", sheet_name="point_pooled")
        mae_ = float(pt[pt.method == "Phase2_HGB"].MAE.iloc[0])
        a = pd.read_excel(p / "risk_evaluation.xlsx", sheet_name="alert_metrics")
        pol = "ProbLinQ" if risk_head == "linear_quantile" else "ProbResid"
        r = a[(a.threshold == 84) & (a.policy == pol) & (a.target_recall.astype(str) == "0.9")].iloc[0]
        return {"source": "outputs/phase25 walk-forward backtest（非未看過的最終測試）", "MAE": round(mae_, 3),
                "interval_coverage": round(cov, 3), "alert_T84_recall": round(float(r.recall), 3),
                "alert_T84_FPR": round(float(r.FPR), 3), "alert_T84_precision": round(float(r.precision), 3)}
    except Exception as e:  # noqa: BLE001
        return {"source": f"無法讀取回測結果（請先執行 evaluate_phase25.py）：{e}"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", default=str(ROOT / "data" / "raw" / "羊舍.csv"))
    ap.add_argument("--train-until", default=None, help="只用標籤時間早於此時刻的資料（模擬過去某時點上線）")
    ap.add_argument("--risk-head", default="linear_quantile", choices=["linear_quantile", "residual"])
    ap.add_argument("--tag", default="")
    a = ap.parse_args()
    out_dir = ROOT / "models" / "phase25"
    out_dir.mkdir(parents=True, exist_ok=True)
    bundle = train(Path(a.input), a.train_until, a.risk_head, read_backtest_summary(a.risk_head))
    name = "thi_h3_phase25" + (f"_{a.tag}" if a.tag else "")
    path = out_dir / f"{name}.joblib"
    joblib.dump(bundle, path)
    sha = hashlib.sha256(path.read_bytes()).hexdigest()
    meta = {k: v for k, v in bundle.items() if k not in ("point_model", "quantile_model", "risk_model", "residuals", "reliability")}
    meta["alert_cutoffs"] = {str(k): v for k, v in bundle["alert_cutoffs"].items()}
    meta["sha256"] = sha
    meta["frozen_note"] = (f"此模型凍結於 {bundle['created']}，訓練資料截至 {bundle['train_period'][1]}。"
                           "之後的新資料從未被看過，是唯一能當作真正最終測試（prospective test）的資料。")
    (out_dir / f"{name}_meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1, default=str))
    # 載入檢查
    from risk_aware_pipeline import load_bundle
    load_bundle(path)
    print(f"已儲存 {path}（sha256 {sha[:16]}）")
    print(f"  訓練期間 {bundle['train_period']}，樣本 {bundle['n_train']}，內層校正 {bundle['n_inner_calibration']} 筆")
    print(f"  CQR 校正量 90%={bundle['cqr_margin_90']:.3f} 98%={bundle['cqr_margin_98']:.3f}；風險機率來源 {bundle['risk_head']}")
    print(f"  警報線（P 超標 ≥ c，目標 recall {TARGET_RECALL}）：{ {k: round(v, 3) for k, v in bundle['alert_cutoffs'].items()} }")


if __name__ == "__main__":
    main()
