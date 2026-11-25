"""
phase26_predict.py — Phase 2.6 獨立推論（不訓練、不讀未來）＋ Phase 3 歷史重播（Historical Replay）介面

  Phase 2.6 輸出 = Phase 2.5 的完整輸出（點預測、90% 區間、P(THI(t+3) ≥ T)、感測器可信度…，一個數字都不改）
                  + "window_risk"：P(未來 3 小時內最高 THI ≥ T) 與警報（實驗性附加頭）

用法：
  python src/phase26_predict.py --input data/raw/羊舍.csv --as-of "2026-08-10 12:00" --json out.json
  python src/phase26_predict.py --input data/raw/羊舍.csv --replay-from "2026-08-10 00:00" --replay-to "2026-08-10 23:00" --csv replay.csv
        ↑ 歷史重播：逐小時模擬上線，每個時間點只看得到 ≤ 該時刻的資料（Phase 3 的資料來源）

結束碼：0 = 有預測；2 = 拒絕預測 / 讀檔失敗。

程式介面（Phase 3 呼叫用）：
  load(model26_path=None) -> Bundle
  predict26(df, bundle, as_of=None, threshold=None, policy=None) -> dict   # 單一時間點，schema 見 README / 報告第 9 節
  replay(df, bundle, start, end, threshold=None) -> Iterator[dict]         # 逐小時，嚴格不看未來
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Iterator

import joblib
import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import features as F
import uncertainty_estimation as UE
from load_data import load_sensor_csv
from risk_aware_pipeline import load_bundle as load_bundle25
from risk_aware_pipeline import predict as predict25

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_MODEL = ROOT / "models" / "phase26" / "thi_h3_phase26.joblib"
MODEL_VERSION26 = "phase2_6"


class Bundle(dict):
    """phase26 bundle + 已載入的 phase25 bundle（b25）。"""


def load(model26_path=None) -> Bundle:
    p = Path(model26_path or DEFAULT_MODEL)
    b = joblib.load(p)
    if b.get("model_version") != MODEL_VERSION26:
        raise ValueError(f"{p} 不是 Phase 2.6 模型（model_version={b.get('model_version')}）")
    ref = b["phase25_bundle"]
    p25 = Path(ref["relative_path"])
    p25 = p25 if p25.is_absolute() else ROOT / p25
    if hashlib.sha256(p25.read_bytes()).hexdigest() != ref["sha256"]:
        raise ValueError(f"Phase 2.5 模型檔 {p25} 與訓練 Phase 2.6 時使用的版本不同（sha256 不符）。請重新訓練 Phase 2.6 附加模型。")
    B = Bundle(b)
    B["b25"] = load_bundle25(p25)
    B["_sha256"] = hashlib.sha256(p.read_bytes()).hexdigest()[:16]
    return B


def _window_block(T: float, bundle, policy: str) -> dict:
    cuts = bundle["window_alert_cutoffs"].get(f"{T:g}") or bundle["window_alert_cutoffs"].get(str(T))
    return {"definition": "max THI over t+1..t+3 >= threshold", "status": "experimental_not_retained_by_predeclared_criterion",
            "threshold": T, "policy": policy, "p_exceed_window": None, "alert": None,
            "alert_cutoff": None if cuts is None else cuts.get(policy), "alert_cutoffs_all": cuts,
            "reasons": []}


def predict26(df: pd.DataFrame, bundle: Bundle, as_of=None, threshold: float | None = None, policy: str | None = None) -> dict:
    b25 = bundle["b25"]
    T = float(threshold if threshold is not None else bundle["default_threshold"])
    policy = policy or bundle["default_policy"]
    out = predict25(df, b25, as_of=as_of, threshold=T)          # Phase 2.5 的輸出原封不動
    out["model_version_phase25"] = out.get("model_version")
    out["model_version"] = MODEL_VERSION26
    out["model_info"]["phase26_bundle_sha256"] = bundle.get("_sha256")
    w = _window_block(T, bundle, policy)
    out["window_risk"] = w
    if out["handling"] == "refused" or out["origin_time"] is None:
        w["reasons"].append("Phase 2.5 已拒絕預測（資料不可信/不足），不輸出視窗風險")
        return out
    H = bundle["horizon"]
    origin = pd.Timestamp(out["origin_time"])
    d = df.copy()
    if as_of is not None:
        d = d[d["timestamp"] <= pd.Timestamp(as_of)]
    grid = F.to_hourly_grid(d).iloc[-(24 * 5):]
    g = grid.loc[:origin]
    assessor = b25["_assessor"]
    gx = g
    if out["handling"] == "thi_reconstructed_from_temp_rh":
        gx = g.copy()
        gx[F.TARGET] = assessor.reconstruct_thi(g)
    XA = F.build_features(F.fill_short_gaps(gx, assessor.max_fill_hours), H, "A").loc[[origin]]
    if XA.isna().any(axis=1).iloc[0]:
        w["reasons"].append("特徵無法完整計算，不輸出視窗風險")
        return out
    q = bundle["window_risk_model"].predict(XA)
    p = float(UE.prob_exceed_from_quantiles(q, bundle["risk_levels"], T)[0])
    cut = w["alert_cutoff"]
    w["p_exceed_window"] = round(p, 3)
    if cut is None:
        w["alert"] = False
        w["reasons"].append("內層驗證資料無法選出警報線（事件/非事件只有一類），不發警報")
    else:
        w["alert"] = bool(p >= cut)
        w["reasons"].append(f"P(3 小時內最高 THI ≥ {T:g}) = {p:.2f}，警報線 {cut:.3f}（政策 {policy}）")
    if out["handling"] != "normal":
        w["reasons"].append(f"感測器處理方式為 {out['handling']}；此視窗風險未針對該情況另行校正")
    return out


def replay(df: pd.DataFrame, bundle: Bundle, start, end, threshold: float | None = None, policy: str | None = None) -> Iterator[dict]:
    """歷史重播：對 [start, end] 的每個整點，只用 ≤ 該整點的資料呼叫 predict26。"""
    for t in pd.date_range(pd.Timestamp(start), pd.Timestamp(end), freq="h"):
        r = predict26(df, bundle, as_of=t, threshold=threshold, policy=policy)
        r["as_of"] = str(t)
        yield r


def render(r: dict) -> str:
    L = ["=" * 70, "JNC Risk-Aware AIoT｜羊舍成羊區 THI（Phase 2.6 = Phase 2.5 + 視窗風險附加頭）", "=" * 70]
    L.append(f"感測器可信度 : {r['sensor_reliability']}   處理方式：{r['handling']}")
    L.append(f"預測起點     : {r['origin_time']}  → 目標 {r['target_time']}")
    if r["point_prediction"] is None:
        L.append("預測         : 無（拒絕預測）")
    else:
        pi = r["prediction_interval"]
        L.append(f"目前 THI     : {r['current_thi']}   中央預測(t+3h) : {r['point_prediction']}   區間 {pi['lower']} ～ {pi['upper']}")
    rk = r["risk"]
    L.append(f"[Phase 2.5] P(THI(t+3) ≥ {rk['threshold']:g}) = {rk['p_exceed']}  警報 = {rk['alert']}  風險 = {rk['risk_level']}")
    w = r["window_risk"]
    L.append(f"[實驗性]    P(未來3h內最高 THI ≥ {w['threshold']:g}) = {w['p_exceed_window']}  警報 = {w['alert']}（政策 {w['policy']}）")
    for s in w["reasons"] + r["warnings"]:
        L.append(f"   · {s}")
    return "\n".join(L)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--input", required=True)
    ap.add_argument("--model", default=str(DEFAULT_MODEL))
    ap.add_argument("--as-of", default=None)
    ap.add_argument("--threshold", type=float, default=None)
    ap.add_argument("--policy", default=None, choices=["F15", "R90"])
    ap.add_argument("--json", default=None)
    ap.add_argument("--replay-from", default=None)
    ap.add_argument("--replay-to", default=None)
    ap.add_argument("--csv", default=None)
    a = ap.parse_args()
    try:
        bundle = load(a.model)
    except Exception as e:  # noqa: BLE001
        print(f"無法載入模型 {a.model}：{e}\n請先執行 python src/phase26_train.py")
        sys.exit(2)
    try:
        df, _ = load_sensor_csv(Path(a.input))
    except Exception as e:  # noqa: BLE001
        print(f"無法讀取輸入檔 {a.input}：{e}")
        sys.exit(2)
    if a.replay_from:
        end = a.replay_to or df["timestamp"].max()
        rows = []
        for r in replay(df, bundle, a.replay_from, end, a.threshold, a.policy):
            rows.append(dict(as_of=r["as_of"], origin=r["origin_time"], reliability=r["sensor_reliability"], handling=r["handling"],
                             current_thi=r["current_thi"], point=r["point_prediction"], lower=r["prediction_interval"]["lower"],
                             upper=r["prediction_interval"]["upper"], p_exceed_y3=r["risk"]["p_exceed"], alert_y3=r["risk"]["alert"],
                             risk_level=r["risk"]["risk_level"], p_exceed_window=r["window_risk"]["p_exceed_window"],
                             alert_window=r["window_risk"]["alert"]))
        bt = pd.DataFrame(rows)
        print(bt.tail(10).to_string(index=False))
        if a.csv:
            bt.to_csv(a.csv, index=False, encoding="utf-8-sig")
            print(f"已寫出 {a.csv}（{len(bt)} 列）")
        sys.exit(0)
    try:
        r = predict26(df, bundle, as_of=a.as_of, threshold=a.threshold, policy=a.policy)
    except Exception as e:  # noqa: BLE001
        print(f"預測失敗：{e}")
        sys.exit(2)
    print(render(r))
    if a.json:
        Path(a.json).write_text(json.dumps(r, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    sys.exit(0 if r["point_prediction"] is not None else 2)


if __name__ == "__main__":
    main()
