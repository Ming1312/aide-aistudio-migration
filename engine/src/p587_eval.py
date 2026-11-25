"""
p587_eval.py — Phase 5.8.7：異常分析的事件層級評估指標（Precision／Recall／FPR／警報頻率）

* 只有驗收工具與測試 import 這個模組（它讀『情境真值』）；偵測器、版本庫、網頁一律不得 import（tests 以 AST 強制）。
* 警報（alert）＝偵測器輸出的事件，先以同一規則合併（同感測器、同類別、間隔 ≤12 小時合併成一筆），舊版與新版用完全相同的合併與比對規則。
* 比對（match）：時間重疊（真值窗口 [起點−6h, 終點+24h]）且感測器相符（真值感測器含該欄，或真值為 '*'，或警報為 '*'；
  羊舍的 THI 是溫濕度公式導出的欄位，來源感測器的真值也解釋 THI 警報）。
* 指標
    Recall      ＝ 被至少一筆警報命中的真值事件 ÷ 應警報的真值事件（分『異常訊號』『資料品質』兩類與各情境類型）
    Precision   ＝ 命中某個真值事件的警報 ÷ 全部警報（命中『正常但不尋常』窗口的警報算誤報，另外列出）
    FPR         ＝ 被警報覆蓋的『乾淨 (感測器, 日)』單元 ÷ 乾淨單元（乾淨＝該日前後 12 小時沒有任何真值事件，含正常但不尋常）
    警報頻率    ＝ 正常情境每個場域每 7 天的警報數
* 這些是『合成情境』上的系統可靠度量測，不是真實現場的驗證。
"""
from __future__ import annotations

import numpy as np
import pandas as pd

IMPORT_LAYER = ("duplicate_identical", "duplicate_conflict", "delayed_arrival")
QUALITY_TYPES = ("stuck_sensor", "intermittent_stuck", "outage_zeros", "outage_absent", "missing_block")
SIGNAL_TYPES = ("slow_drift", "calibration_step", "short_event", "relationship_change", "exp_drift", "multi_spike", "transient_step", "noisy_sensor")
DERIVED = {"羊舍": {"成羊區THI": ("成羊區平均溫度", "成羊區平均濕度"), "仔羊區THI": ("ID4-溫度", "ID4-濕度")}}
PRE_H, POST_H, BUFFER_H, MERGE_GAP_H = 6, 24, 12, 12
ALERT_COLS = ["system", "category", "kind", "column", "start", "end", "detected_at", "score"]


def truth_class(t: dict) -> str:
    return "data_quality" if t["type"] in QUALITY_TYPES else "signal"


def should_alert_truth(events: list[dict]) -> list[dict]:
    """Recall／Precision 的真值集合：所有『異常訊號』與『資料品質』事件（含缺值區塊；重複／延遲屬匯入層，不在此）。"""
    return [e for e in events if e["type"] not in IMPORT_LAYER and e["category"] in ("anomaly", "data_quality")]


def merge_alerts(a: pd.DataFrame, gap_h: int = MERGE_GAP_H) -> pd.DataFrame:
    """同感測器、同類別的警報若間隔 ≤ gap_h 小時就合併（取最早偵測時間、最大強度）。"""
    if a.empty:
        return a.copy()
    rows = []
    for (col, cat, sysn), g in a.sort_values("start").groupby(["column", "category", "system"], sort=False):
        cur = None
        for r in g.itertuples():
            if cur is not None and pd.Timestamp(r.start) <= pd.Timestamp(cur["end"]) + pd.Timedelta(hours=gap_h):
                cur["end"] = max(pd.Timestamp(cur["end"]), pd.Timestamp(r.end))
                cur["detected_at"] = min(pd.Timestamp(cur["detected_at"]), pd.Timestamp(r.detected_at))
                cur["score"] = max(cur["score"], r.score)
                if r.kind not in cur["kind"].split("+"):
                    cur["kind"] += "+" + r.kind
            else:
                if cur is not None:
                    rows.append(cur)
                cur = {"system": sysn, "category": cat, "kind": r.kind, "column": col, "start": pd.Timestamp(r.start), "end": pd.Timestamp(r.end), "detected_at": pd.Timestamp(r.detected_at), "score": float(r.score)}
        if cur is not None:
            rows.append(cur)
    return pd.DataFrame(rows, columns=ALERT_COLS).sort_values("start").reset_index(drop=True)


def _col_ok(stem: str, truth_cols: list[str], col: str) -> bool:
    if "*" in truth_cols or col == "*":
        return True
    if truth_cols == ["CPM*"]:
        return col.startswith("CPM")
    if col in truth_cols:
        return True
    src = DERIVED.get(stem, {}).get(col)
    return bool(src and set(src) & set(truth_cols))


def _ov(a0, a1, b0, b1) -> bool:
    return pd.Timestamp(a0) <= pd.Timestamp(b1) and pd.Timestamp(b0) <= pd.Timestamp(a1)


def evaluate_run(stem: str, alerts: pd.DataFrame, truth: list[dict], t_from, t_to) -> dict:
    """單一批次的原始計數（之後跨批次相加再算指標）。alerts 已合併。"""
    t_from, t_to = pd.Timestamp(t_from), pd.Timestamp(t_to)
    T = should_alert_truth(truth)
    benign = [e for e in truth if e["category"] in ("benign_unusual", "regime_change")]
    rows = []
    for e in T:
        s, t = pd.Timestamp(e["start"]), pd.Timestamp(e["end"])
        hit = [r for r in alerts.itertuples() if _ov(r.start, r.end, s - pd.Timedelta(hours=PRE_H), t + pd.Timedelta(hours=POST_H)) and _col_ok(stem, e["columns"], r.column)]
        rows.append({"type": e["type"], "class": truth_class(e), "columns": "+".join(e["columns"]), "hit": bool(hit), "any_column_hit": any(_ov(r.start, r.end, s - pd.Timedelta(hours=PRE_H), t + pd.Timedelta(hours=POST_H)) for r in alerts.itertuples()),
                     "delay_h": float(max(0.0, (min(pd.Timestamp(h.detected_at) for h in hit) - s) / pd.Timedelta(hours=1))) if hit else np.nan})
    tp = fp = fp_benign = 0
    for r in alerts.itertuples():
        m = any(_ov(r.start, r.end, pd.Timestamp(e["start"]) - pd.Timedelta(hours=PRE_H), pd.Timestamp(e["end"]) + pd.Timedelta(hours=POST_H)) and _col_ok(stem, e["columns"], r.column) for e in T)
        if m:
            tp += 1
        else:
            fp += 1
            if any(_ov(r.start, r.end, pd.Timestamp(e["start"]) - pd.Timedelta(hours=BUFFER_H), pd.Timestamp(e["end"]) + pd.Timedelta(hours=BUFFER_H)) for e in benign):
                fp_benign += 1
    # 乾淨 (感測器, 日) 單元：該日前後 BUFFER_H 內沒有任何真值事件（含正常但不尋常）
    ev_all = [(pd.Timestamp(e["start"]) - pd.Timedelta(hours=BUFFER_H), pd.Timestamp(e["end"]) + pd.Timedelta(hours=BUFFER_H)) for e in truth if e["type"] not in IMPORT_LAYER]
    days = pd.date_range(t_from.normalize(), t_to.normalize(), freq="D")
    clean_days = [d for d in days if not any(_ov(d, d + pd.Timedelta(hours=23), a, b) for a, b in ev_all)]
    cols = sorted({r.column for r in alerts.itertuples() if r.column != "*"})
    flagged = 0
    for c in cols:
        ac = alerts[(alerts["column"] == c)]
        for d in clean_days:
            if any(_ov(r.start, r.end, d, d + pd.Timedelta(hours=23)) for r in ac.itertuples()):
                flagged += 1
    return {"truth": pd.DataFrame(rows), "tp_alerts": tp, "fp_alerts": fp, "fp_benign": fp_benign, "n_alerts": int(len(alerts)), "clean_days": len(clean_days), "flagged_clean_units": flagged,
            "hours": float((t_to - t_from) / pd.Timedelta(hours=1))}


def aggregate(runs: list[dict], n_columns: int) -> dict:
    """跨批次彙整。n_columns＝該場域的感測器數（FPR 的分母＝乾淨日數 × 感測器數）。"""
    tr = pd.concat([r["truth"] for r in runs if len(r["truth"])], ignore_index=True) if any(len(r["truth"]) for r in runs) else pd.DataFrame(columns=["type", "class", "hit", "delay_h"])
    tp, fp = sum(r["tp_alerts"] for r in runs), sum(r["fp_alerts"] for r in runs)
    out = {"alerts": tp + fp, "precision": tp / (tp + fp) if tp + fp else float("nan"), "fp_alerts": fp, "fp_on_benign": sum(r["fp_benign"] for r in runs),
           "fpr_unit": sum(r["flagged_clean_units"] for r in runs) / max(sum(r["clean_days"] for r in runs) * n_columns, 1), "alerts_per_7d": 7 * 24 * (tp + fp) / max(sum(r["hours"] for r in runs), 1),
           "fp_per_7d": 7 * 24 * fp / max(sum(r["hours"] for r in runs), 1), "truth_events": int(len(tr))}
    for cls in ("signal", "data_quality"):
        s = tr[tr["class"] == cls] if len(tr) else tr
        out[f"recall_{cls}"] = float(s["hit"].mean()) if len(s) else float("nan")
        out[f"n_{cls}"] = int(len(s))
    out["recall_all"] = float(tr["hit"].mean()) if len(tr) else float("nan")
    out["median_delay_h"] = float(tr.loc[tr["hit"], "delay_h"].median()) if len(tr) and tr["hit"].any() else float("nan")
    out["by_type"] = tr.groupby("type")["hit"].agg(["mean", "size"]).rename(columns={"mean": "recall", "size": "n"}).reset_index() if len(tr) else pd.DataFrame()
    return out
