"""
risk_assessment.py — 由「預測值 + 區間 + 超標機率 + 感測器可信度」產生風險等級與原因，並提供風險偵測指標。

重要：THRESHOLD（例：84）只是「分析用的候選門檻」，不是 JNC 確認的熱緊迫標準。
      所有輸出都標示 threshold_status = "candidate_unconfirmed"。
"""
from __future__ import annotations

import numpy as np
from sklearn.metrics import average_precision_score, precision_recall_curve

CANDIDATE_THRESHOLDS = (83.0, 84.0, 85.0)
DEFAULT_THRESHOLD = 84.0


# ------------------------------------------------------------------ 指標
def alert_metrics(event, alert) -> dict:
    e, a = np.asarray(event, bool), np.asarray(alert, bool)
    tp, fp = int((a & e).sum()), int((a & ~e).sum())
    fn, tn = int((~a & e).sum()), int((~a & ~e).sum())
    rec = tp / (tp + fn) if tp + fn else np.nan
    prec = tp / (tp + fp) if tp + fp else np.nan
    f1 = 2 * prec * rec / (prec + rec) if (tp and not np.isnan(prec) and not np.isnan(rec)) else 0.0
    return dict(n=len(e), events=tp + fn, alerts=tp + fp, TP=tp, FP=fp, FN=fn, TN=tn,
                recall=rec, precision=prec, F1=f1,
                FPR=fp / (fp + tn) if fp + tn else np.nan, FNR=fn / (tp + fn) if tp + fn else np.nan)


def select_cutoff(score, event, target_recall: float = 0.9, default: float | None = None):
    """
    在「驗證資料」上選警報門檻 c（score ≥ c 就警報）：
      在 recall ≥ target_recall 的所有 c 中，選誤報率（FPR）最低的；平手取較高的 c。
      驗證資料沒有事件時回傳 default（無法選，誠實地退回預設值）。
    這個規則是事先宣告的，不看測試資料。
    """
    s, e = np.asarray(score, float), np.asarray(event, bool)
    if e.sum() == 0 or (~e).sum() == 0:
        return default, {"reason": "validation has a single class"}
    cands = np.unique(s)
    best = None
    for c in cands:
        a = s >= c
        rec = (a & e).sum() / e.sum()
        fpr = (a & ~e).sum() / (~e).sum()
        if rec >= target_recall and (best is None or fpr < best[1] or (fpr == best[1] and c > best[0])):
            best = (c, fpr, rec)
    if best is None:
        return float(cands.min()), {"reason": "target recall not reachable; alert on everything"}
    return float(best[0]), {"val_FPR": float(best[1]), "val_recall": float(best[2]), "val_events": int(e.sum())}


def pr_curve(event, score):
    p, r, t = precision_recall_curve(np.asarray(event, int), np.asarray(score, float))
    return p, r, t


def average_precision(event, score) -> float:
    e = np.asarray(event, int)
    return float(average_precision_score(e, score)) if 0 < e.sum() < len(e) else np.nan


def brier(prob, event) -> float:
    return float(np.mean((np.asarray(prob, float) - np.asarray(event, float)) ** 2))


def log_loss(prob, event) -> float:
    p = np.clip(np.asarray(prob, float), 1e-4, 1 - 1e-4)
    e = np.asarray(event, float)
    return float(-np.mean(e * np.log(p) + (1 - e) * np.log(1 - p)))


def reliability_table(prob, event, bins=(0, .1, .3, .5, .7, .9, 1.0001)):
    """Calibration：把預測機率分箱，比較「平均預測機率」與「實際發生比例」。理想狀況兩者相等。"""
    p, e = np.asarray(prob, float), np.asarray(event, float)
    rows = []
    for lo, hi in zip(bins[:-1], bins[1:]):
        m = (p >= lo) & (p < hi)
        rows.append(dict(bin=f"[{lo:.1f},{min(hi, 1):.1f})", n=int(m.sum()),
                         mean_predicted=float(p[m].mean()) if m.any() else np.nan,
                         observed_rate=float(e[m].mean()) if m.any() else np.nan))
    return rows


# ------------------------------------------------------------------ 風險等級（給 Phase 3 使用）
def assess_risk(point, lower, upper, p_exceed, reliability_status: str, threshold: float = DEFAULT_THRESHOLD,
                alert_cutoff: float | None = None, high_cutoff: float = 0.5, threshold_status="candidate_unconfirmed"):
    """
    規則（可解釋、可替換）：
      unknown   沒有可信的預測（輸入不可信而拒絕預測）
      high      P(THI ≥ T) ≥ max(high_cutoff, alert_cutoff)（較可能超標）           → alert = True
      elevated  P(THI ≥ T) ≥ alert_cutoff（驗證資料上選出、目標 recall 0.9 的警報線） → alert = True
      watch     未達警報線，但 90% 區間上界 ≥ T（有可能超標，僅提示，不警報）
      normal    其他
    為什麼「區間上界 ≥ T」不直接算 elevated？回測中 90% 區間寬約 4.5 THI，下午幾乎每小時上界都超過 84，
    若直接警報會造成警報疲勞；因此只作為提示等級，讓 Phase 3 決定是否處理。
    回傳 (risk_level, reasons)。
    """
    reasons = []
    if point is None:
        return "unknown", ["沒有可信的預測值，無法評估風險（請人工檢查感測器）"]
    cut = alert_cutoff if alert_cutoff is not None else high_cutoff
    if p_exceed is not None and p_exceed >= max(high_cutoff, cut):
        reasons.append(f"P(THI ≥ {threshold:g}) ≈ {p_exceed:.2f}，≥ {max(high_cutoff, cut):.2f}")
        level = "high"
    elif p_exceed is not None and p_exceed >= cut:
        reasons.append(f"P(THI ≥ {threshold:g}) ≈ {p_exceed:.2f}，超過警報線 {cut:.2f}（以 recall 0.9 為目標選出）")
        level = "elevated"
    elif upper is not None and upper >= threshold:
        reasons.append(f"未達警報線（P ≈ {p_exceed:.2f} < {cut:.2f}），但預測區間上界 {upper:.1f} ≥ 候選門檻 {threshold:g}")
        level = "watch"
    else:
        level = "normal"
        reasons.append(f"預測與區間上界皆低於候選門檻 {threshold:g}")
    if reliability_status == "warning":
        reasons.append("輸入資料有疑點（見 sensor_reliability.findings），風險判斷可信度較低")
    reasons.append(f"門檻 {threshold:g} 為候選值（{threshold_status}），非 JNC 確認之熱緊迫標準")
    return level, reasons
