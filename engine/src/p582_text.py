"""p582_text.py — Phase 5.8.2：AI 預測結果的白話解釋（規則式模板＋真實計算結果；沒有 LLM、沒有手寫數字）。"""
from __future__ import annotations

import numpy as np
import pandas as pd

import p582_engine as E


def _fmt(v) -> str:
    return "—" if v is None or v != v else f"{v:.4g}"


def explain(res: dict, model_key: str) -> dict:
    """四段式：觀察／可能代表／不能證明／下一步。res 來自 p582_engine.forecast。"""
    task = res["task_id"]
    p = res["predictions"][model_key]
    unit = res["unit"]
    name = E.MODEL_ZH[model_key]
    if "value" not in p:
        return {"observed": f"{name} 在這個起點沒有產生預測：{p['refused']}", "meaning": "系統不插補缺值，也不改用其他模型代替；請選擇其他起點或其他模型。",
                "cannot_prove": "沒有預測不代表『正常』或『沒有變化』。", "next": "選擇起點前 24 小時資料完整的時間，或換一個模型。"}
    obs = f"以 {res['forecast_origin']:%Y-%m-%d %H:%M} 為預測起點（{E.MODE_LABEL}），{name} 預測 {res['target_timestamp']:%Y-%m-%d %H:%M}（{res['horizon_h']} 小時後）的 {res['sensor']} 為 {_fmt(p['value'])} {unit}。"
    if res["actual"] is not None:
        err = p["value"] - res["actual"]
        obs += f" 事後對照的實際值是 {_fmt(res['actual'])} {unit}（誤差 {err:+.3g}；預測時沒有使用這個值）。"
    else:
        obs += " 這個目標時間在資料中沒有觀測值，無法對照。"
    ev = E.evaluate(task)
    if model_key in E.FAMILIES:
        meaning = E.evidence_text(task, model_key)
    elif model_key == ev["best_baseline"]:
        meaning = f"{name} 是這個任務在驗證期表現最好的簡單基準（Phase 5.6 凍結規則）；機器學習模型要有明確的優勢才值得使用。"
    else:
        meaning = f"{name} 是簡單基準之一；在驗證期不是最佳基準（最佳是 {E.MODEL_ZH[ev['best_baseline']]}）。"
    cant = ["這是對已存在的歷史資料做的『歷史時點模擬預測』，不是即時監控；資料最後一筆是 " + f"{res['data_last_timestamp']:%Y-%m-%d %H:%M}" + "。",
            "探索性歷史回測不是獨立前瞻驗證；單位與時區尚未確認；不能證明模型在新資料上仍然準確。"]
    if res["period"] in ("train", "validation"):
        cant.append("這個起點屬於" + ("訓練期（樣本內）" if res["period"] == "train" else "驗證期（模型訓練之後、開發期）") + "，這個預測不能當作模型表現的證據。")
    if res["sensor"] and res["domain"] == "專家系統":
        cant.append("專家系統的後段資料與 Phase 5.2 異常 Holdout 時段重疊；這裡沒有用它調整任何東西，但仍屬探索性。")
    nxt = "把這個結果當作研究參考；要用於決策，必須先取得新的獨立資料、通過獨立驗證並登記到 Model Registry 與 Compatibility Gate——目前沒有任何研究模型走完這條路。"
    return {"observed": obs, "meaning": meaning, "cannot_prove": " ".join(cant), "next": nxt}


def model_limit(res: dict, ev: dict, key: str) -> str:
    """每個模型在『這個起點』的研究限制（一行；規則式）。"""
    p = res["predictions"].get(key, {})
    if "value" not in p:
        return "沒有預測：" + p.get("refused", "—")
    if key in E.FAMILIES:
        e = ev["evidence"][key]
        sig = "有探索性訊號（非獨立驗證）" if e["signal"] else "尚無足夠證據優於簡單基準"
        extra = "；特徵集 F1 含同場域其他感測器（可得時間為假設）" if ev["variants"][key].endswith("F1") else ""
        return f"Research Candidate；{sig}{extra}"
    if key == ev["best_baseline"]:
        return "驗證期最佳的簡單基準（凍結規則）；不是 AI 模型"
    if key == "linear_ar4":
        return "簡單基準（Ridge，訓練期擬合）；不是 AI 模型"
    return "簡單基準；沒有訓練參數"


def compare_all(res: dict, ev: dict, task: str) -> pd.DataFrame:
    """同一個預測起點、全部適用模型的一張比較表（預測值、誤差、探索性區間、整體評估與研究限制）。
    單點誤差只是這個起點的結果，**不是**模型好壞的證據；整體評估看 Holdout MAE（描述性）。"""
    rows = []
    actual = res["actual"]
    for k in E.MODEL_ORDER:
        p = res["predictions"].get(k)
        if p is None or (k == "seasonal_naive_24h" and "value" not in p and k not in ev["metrics"]):
            if k == "seasonal_naive_24h":
                rows.append({"key": k, "模型": E.MODEL_ZH[k], "種類": "基準", "預測值": np.nan, "誤差（預測−實際）": np.nan, "絕對誤差": np.nan, "單點排名": np.nan, "Holdout MAE（整體，描述性）": np.nan,
                             "探索性區間下界": np.nan, "探索性區間上界": np.nan, "觀測覆蓋率（Holdout）": np.nan, "探索性訊號（非獨立驗證）": "—", "研究限制": "不適用：" + p.get("refused", "訓練期日週期不夠強，依凍結協定不使用") if p else "不適用：訓練期日週期不夠強，依凍結協定不使用"})
            continue
        v = p.get("value", np.nan)
        iv = E.interval(task, k, res["forecast_origin"]) if "value" in p else {"shown": False}
        lo = v - iv["q"] if iv.get("shown") else np.nan
        hi = v + iv["q"] if iv.get("shown") else np.nan
        err = v - actual if (actual is not None and "value" in p) else np.nan
        e = ev["evidence"].get(k, {})
        rows.append({"key": k, "模型": E.MODEL_ZH[k] + (" ★最佳基準" if k == ev["best_baseline"] else ""), "種類": "機器學習" if k in E.FAMILIES else "基準", "預測值": v, "誤差（預測−實際）": err,
                     "絕對誤差": abs(err) if err == err else np.nan, "單點排名": np.nan, "Holdout MAE（整體，描述性）": ev["metrics"][k]["holdout"]["MAE"] if k in ev["metrics"] else np.nan,
                     "探索性區間下界": lo, "探索性區間上界": hi, "觀測覆蓋率（Holdout）": iv.get("holdout_coverage", np.nan) if iv.get("shown") else np.nan,
                     "探索性訊號（非獨立驗證）": ("—" if k not in E.FAMILIES else ("有訊號" if e.get("signal") else "尚無訊號")), "研究限制": model_limit(res, ev, k)})
    df = pd.DataFrame(rows)
    if len(df) and df["絕對誤差"].notna().any():
        df["單點排名"] = df["絕對誤差"].rank(method="min")
    return df
