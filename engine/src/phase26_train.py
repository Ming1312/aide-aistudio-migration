"""
phase26_train.py — 訓練並儲存 Phase 2.6 附加模型（models/phase26/）

Phase 2.6 的結論是「正式預測模型仍用 Phase 2.5，不改動」。這裡只多訓練一個「實驗性、不納入正式判定」的附加頭：

  window_risk_model = 線性分位數迴歸（Linear Quantile Regression, 7 個分位數），目標 ymax = max THI(t+1..t+3)
                      特徵 = 特徵集 A（20 欄，與 Phase 2.5 風險頭相同）
  → 轉成 P(未來 3 小時內最高 THI ≥ T)，再用「內層 walk-forward」的樣本外資料選警報線：
        F15 = 在驗證 FPR ≤ 0.15 之下 Recall 最高；  R90 = 在驗證 Recall ≥ 0.9 之下 FPR 最低

訓練流程與 phase26_evaluate.py 的外層折完全相同（所以能互相驗證，tests/test_phase26.py 會檢查）：
  1. S = --train-until（預設：最後一筆資料之後）；訓練樣本 = 標籤時間 < S（前 3 小時 purge）
  2. 內層 walk-forward：S 之前 5 天，每天 24 小時，只用該天以前的資料訓練 → 樣本外機率
  3. 由內層樣本外機率決定警報線（各候選門檻 83/84/85）
  4. 用全部訓練樣本重新訓練最終模型並存檔

執行：
  python src/phase26_train.py                                  # 用全部資料
  python src/phase26_train.py --train-until "2026-08-09 00:00" --tag until0809   # 與評估第 7 折相同（驗證用）
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

sys.path.insert(0, str(Path(__file__).resolve().parent))
import features as F
import phase26_features as PF
import phase26_models as PM
import risk_assessment as RA
import risk_forecasting as RF
import uncertainty_estimation as UE
from load_data import load_sensor_csv

ROOT = Path(__file__).resolve().parent.parent
H, FS = 3, "B"
THRESHOLDS = (83.0, 84.0, 85.0)
INNER_DAYS = 5
POLICIES = {"F15": ("fpr", 0.15), "R90": ("recall", 0.90)}
MODEL_VERSION26 = "phase2_6"


def _cutoffs(score, event):
    out = {}
    for pol, (kind, val) in POLICIES.items():
        if kind == "recall":
            c, _ = RA.select_cutoff(score, event, val, default=None)
        else:
            c = PM.select_cutoff_fpr(score, event, val, default=None)
        out[pol] = None if c is None else float(c)
    return out


def train(raw: Path, train_until, phase25_path: Path) -> dict:
    df, _ = load_sensor_csv(raw)
    grid = F.to_hourly_grid(df)
    XB, XA, y3, ymax, snm = PF.make_dataset26(grid, H, FS)
    idx = XB.index
    S = pd.Timestamp(train_until) if train_until else idx.max() + pd.Timedelta(hours=H + 1)
    purge = S - pd.Timedelta(hours=H)

    inner = []
    for j in range(INNER_DAYS, 0, -1):
        b = S - pd.Timedelta(days=j)
        tr = idx < b - pd.Timedelta(hours=H)
        te = (idx >= b) & (idx < b + pd.Timedelta(hours=24)) & (idx < purge)
        if te.sum() == 0:
            continue
        mm = RF.QuantileForecaster("linear").fit(XA[tr], ymax[tr])
        q = mm.predict(XA[te])
        r = pd.DataFrame(q, index=idx[te], columns=[f"q{i}" for i in range(q.shape[1])])
        r["ymax"], r["block"] = ymax[te].to_numpy(), j
        inner.append(r)
    inner = pd.concat(inner)
    qcols = [f"q{i}" for i in range(len(RF.QUANTILE_LEVELS))]

    cutoffs, n_ev = {}, {}
    for T in THRESHOLDS:
        p_in = UE.prob_exceed_from_quantiles(inner[qcols].to_numpy(), RF.QUANTILE_LEVELS, T)
        e_in = inner["ymax"].to_numpy() >= T
        cutoffs[T] = _cutoffs(p_in, e_in)
        n_ev[T] = int(e_in.sum())

    tr = idx < purge
    final = RF.QuantileForecaster("linear").fit(XA[tr], ymax[tr])
    p25 = Path(phase25_path)
    return {
        "model_version": MODEL_VERSION26, "status": "experimental_auxiliary_not_retained_by_predeclared_criterion",
        "horizon": H, "feature_set_window_head": "A",
        "window_risk_model": final, "risk_levels": RF.QUANTILE_LEVELS,
        "window_alert_cutoffs": {str(T): v for T, v in cutoffs.items()}, "inner_events": {str(T): v for T, v in n_ev.items()},
        "default_policy": "F15", "default_threshold": 84.0, "thresholds_status": "candidate_unconfirmed",
        "phase25_bundle": {"relative_path": str(p25.relative_to(ROOT)) if p25.is_absolute() and ROOT in p25.parents else str(p25),
                           "sha256": hashlib.sha256(p25.read_bytes()).hexdigest()},
        "train_period": [str(idx[tr].min()), str(idx[tr].max() + pd.Timedelta(hours=H))], "n_train": int(tr.sum()), "n_inner": len(inner),
        "created": datetime.now().isoformat(timespec="seconds"),
        "versions": {"python": sys.version.split()[0], "sklearn": sklearn.__version__, "pandas": pd.__version__, "numpy": np.__version__},
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", default=str(ROOT / "data" / "raw" / "羊舍.csv"))
    ap.add_argument("--train-until", default=None)
    ap.add_argument("--tag", default="")
    a = ap.parse_args()
    p25 = ROOT / "models" / "phase25" / ("thi_h3_phase25" + (f"_{a.tag}" if a.tag else "") + ".joblib")
    if not p25.exists():
        print(f"找不到對應的 Phase 2.5 模型 {p25}；請先執行 python src/train_phase25.py" + (f" --train-until ... --tag {a.tag}" if a.tag else ""))
        sys.exit(2)
    b = train(Path(a.input), a.train_until, p25)
    out = ROOT / "models" / "phase26"
    out.mkdir(parents=True, exist_ok=True)
    name = "thi_h3_phase26" + (f"_{a.tag}" if a.tag else "")
    path = out / f"{name}.joblib"
    joblib.dump(b, path)
    meta = {k: v for k, v in b.items() if k != "window_risk_model"}
    meta["sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
    meta["note"] = ("附加的『未來 3 小時內是否超標』風險頭，屬實驗性。正式預測（點預測、區間、y3 風險）仍由 Phase 2.5 模型提供。"
                    "依事先宣告的標準，Phase 2.6 沒有任何改良被納入正式判定（見 outputs/phase26/phase26_report.md）。")
    (out / f"{name}_meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1, default=str))
    print(f"已儲存 {path}（sha256 {meta['sha256'][:16]}）；訓練 {b['train_period']}，樣本 {b['n_train']}，內層 {b['n_inner']}")
    print("警報線（P(3h 內超標) ≥ c）：", json.dumps(b["window_alert_cutoffs"]))


if __name__ == "__main__":
    main()
