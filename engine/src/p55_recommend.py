"""
p55_recommend.py — Phase 5.5：Adaptive Analysis Task Recommendation（依資料類型推薦分析，並分清楚四件事）

對每個候選分析任務，分別回答：
  suitable    ＝ 適合：資料型態（感測器類型、頻率、期間）上說得通
  implemented ＝ 已實作：平台裡真的有這個分析的程式（不是只有『適合用某種演算法』）
  validated   ＝ 已驗證：有被正式驗證過的模型（描述性分析不涉及模型，記為 not_applicable；Experimental 不算 Validated）
  executable  ＝ 現在可以執行：已實作，且先決條件成立；模型型任務還必須通過 Compatibility Gate
這四件事不能混為一談：適合 ≠ 已實作 ≠ 已驗證 ≠ 可執行。例如『工地微氣候』的溫濕度適合做短期預測，但沒有相容模型，所以只提供『基準方法評估』，不提供預測。
模型型任務（forecast_risk、anomaly_statistical）一律先經 Model Registry → GateRouter；Gate 拒絕就不可執行，不會改用別的場域的模型。Experimental 需要明確 opt-in，且 opt-in 不改變模型狀態。
沒有登記的資料（Unknown）只提供資料概況、欄位資訊、缺漏率、基本統計與可用性建議。
"""
from __future__ import annotations

import sys
from dataclasses import dataclass, field
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))

import domain_registry as DR  # noqa: E402
import domain_schema as DS  # noqa: E402
import p55_classify as CL  # noqa: E402
from p53_gate import GateRouter  # noqa: E402

NA = "not_applicable"
# 平台中『真的有程式』的模型型分析：stem → {task: 說明}
IMPLEMENTED_MODEL_TASKS = {"羊舍": {"forecast_risk": "Phase 3 決策引擎（HGB 點預測＋CQR 區間＋ProbLinQ 風險＋Reliability Gate），歷史回放"},
                           "專家系統": {"anomaly_statistical": "Phase 5.2 Experimental 統計異常偵測（規則式＋穩健 Z）＋ CPM 負載脈絡＋人工檢查建議"}}
TASK_LABEL = {
    "dataset_overview": "資料概況", "data_quality": "資料品質分析（缺值／零值／Flatline）", "descriptive_statistics": "描述統計", "trend_analysis": "趨勢分析", "distribution": "分布（直方圖／箱形圖）",
    "daily_cycle": "日週期分析", "correlation": "感測器關係（Spearman）", "segment_shift": "分段分布變化（漂移候選）", "calibration_events": "校正參數變動事件", "load_state": "負載狀態分析（電流）",
    "device_health": "裝置健康（計數器／訊號／供電）", "coverage_blocks": "涵蓋區塊與可用時間區段", "thi_derived": "THI 計算（導出指標）", "suspicious_segments": "可疑區段探索（候選）",
    "forecastability": "短期預測任務評估（基準方法，沒有模型）", "forecast_risk": "THI 預測與風險評估（模型）", "anomaly_statistical": "統計異常偵測（Experimental 模型）", "predictive_maintenance": "預測維護"}
MODEL_TASKS = ("forecast_risk", "anomaly_statistical", "predictive_maintenance")


@dataclass
class TaskRec:
    task_id: str
    label: str
    kind: str                                   # descriptive | model
    suitable: bool
    suitable_reason: str
    implemented: bool
    implemented_reason: str
    validated: str                              # yes | no | not_applicable
    validated_reason: str
    executable: bool
    executable_reason: str
    requires_opt_in: bool = False
    executable_with_opt_in: bool = False
    params: dict = field(default_factory=dict)
    gate: list = field(default_factory=list)

    def as_row(self) -> dict:
        d = {k: v for k, v in self.__dict__.items() if k not in ("gate", "params")}
        d["gate_decisions"] = "；".join(f"{g['target']}:{g['decision']}{'(opt-in)' if g['opt_in'] else ''}" for g in self.gate)
        return d


def _types(rows):
    return {r.sensor_type for r in rows}


def _usable(rows, kinds=("continuous", "derived_index", "circular_angle")):
    return [r for r in rows if r.measurement_kind in kinds and r.classification_status != CL.UNKNOWN and r.numeric_evidence["n_observed"] >= 48]


def pick_temp_rh(rows) -> tuple[str, str] | None:
    """同一子系統（欄名前綴相同）的溫度與濕度優先配對；沒有就用第一個溫度與第一個濕度。"""
    t = [r.original_column_name for r in rows if r.sensor_type == "Air Temperature"]
    h = [r.original_column_name for r in rows if r.sensor_type == "Relative Humidity"]
    if not t or not h:
        return None
    for tc in t:
        pre = tc.split(" ")[0] if " " in tc else tc.replace("溫度", "").replace("TEMP", "")
        for hc in h:
            if pre and hc.startswith(pre):
                return tc, hc
    return t[0], h[0]


def _descriptive(task: str, ok: bool, why_suit: str, why_exec: str | None = None, params: dict | None = None) -> TaskRec:
    return TaskRec(task, TASK_LABEL[task], "descriptive", ok, why_suit, True, "平台已實作（src/p55_analysis.py；描述性、可重現）", NA, "描述性分析，不涉及模型；沒有驗證程度的問題",
                   ok, (why_exec or ("資料先決條件成立" if ok else "資料先決條件不成立：" + why_suit)), params=params or {})


def recommend_for_rows(cls: dict, quality: dict | None, df: pd.DataFrame | None, stem: str | None = None, router: GateRouter | None = None) -> list[TaskRec]:
    rows = cls["rows"]
    unknown_only = all(r.classification_status == CL.UNKNOWN for r in rows) if rows else True
    n_obs = int(sum(r.numeric_evidence["n_observed"] for r in rows))
    span_days = 0.0 if df is None or df.empty else float((df["timestamp"].max() - df["timestamp"].min()) / pd.Timedelta(days=1))
    cov = None if quality is None else quality["timestamp"]["timestamp_coverage"]
    recs = [_descriptive("dataset_overview", True, "任何資料都可以先看概況"), _descriptive("data_quality", True, "任何資料都可以做缺漏與品質分析"),
            _descriptive("descriptive_statistics", n_obs > 0, "至少需要一個有觀測值的欄位" if n_obs == 0 else "有觀測值")]
    if unknown_only:       # Unknown：只提供概況／欄位／缺漏率／基本統計／可用性建議；其餘一律不推薦
        for t in ("trend_analysis", "distribution", "daily_cycle", "thi_derived", "forecastability", "segment_shift", "load_state", "device_health", "calibration_events", "correlation"):
            recs.append(TaskRec(t, TASK_LABEL[t], "descriptive", False, "感測器類型未知（UNKNOWN）：不推測意義，不推薦需要語義的分析", True, "平台已實作", NA, "描述性分析", False, "分類為 UNKNOWN，只提供基本資訊"))
        return recs
    cont = _usable(rows)
    recs.append(_descriptive("trend_analysis", bool(cont), "需要至少一個連續型感測器（≥48 小時觀測）" if not cont else f"{len(cont)} 個連續型感測器可用"))
    recs.append(_descriptive("distribution", bool(cont), "需要連續型感測器" if not cont else "適合直方圖與箱形圖"))
    recs.append(_descriptive("correlation", len(cont) >= 2, "需要至少兩個連續型感測器"))
    daily = [r for r in cont if r.numeric_evidence["n_observed"] >= 72]
    recs.append(_descriptive("daily_cycle", bool(daily) and span_days >= 7, f"需要連續型感測器且期間 ≥ 7 天（目前 {span_days:.0f} 天）"))
    cal = [r for r in rows if r.measurement_kind == "calibration_parameter"]
    recs.append(_descriptive("calibration_events", bool(cal), "有校正斜率欄位" if cal else "沒有校正參數欄位"))
    cur = [r for r in rows if r.sensor_type == "Electrical Current (load)"]
    recs.append(_descriptive("load_state", bool(cur), "有負載電流感測器" if cur else "沒有負載電流感測器", params={"col": cur[0].original_column_name} if cur else {}))
    dev = [r for r in rows if r.sensor_type in ("Uptime Counter", "Boot Counter", "Signal Strength", "Supply Voltage")]
    recs.append(_descriptive("device_health", bool(dev), "有裝置計數器／訊號／供電欄位" if dev else "沒有裝置健康欄位"))
    wq = [r for r in cont if r.sensor_group == "Water Quality"]
    recs.append(_descriptive("segment_shift", bool(wq) and span_days >= 28, f"水質感測器且期間 ≥ 28 天（目前 {span_days:.0f} 天）" if wq else "分段分布變化目前只規劃用於水質感測器", params={"sensors": [r.original_column_name for r in wq][:6]}))
    low_cov = cov is not None and cov < 0.9
    recs.append(_descriptive("coverage_blocks", low_cov, f"時間涵蓋只有 {cov:.1%}，需要找出可用的連續區段" if low_cov else "時間涵蓋充足，不需要"))
    tr = pick_temp_rh(rows)
    recs.append(_descriptive("thi_derived", tr is not None, "有溫度與濕度，可用公式導出 THI" if tr else "需要溫度與濕度", params={"t_col": tr[0], "rh_col": tr[1]} if tr else {}))
    flagged = 0 if quality is None else quality["n_flagged_runs"]
    recs.append(_descriptive("suspicious_segments", flagged > 0, f"資料品質分析找到 {flagged} 段需要確認的區段" if flagged else "沒有需要確認的區段"))
    fc = [r for r in cont if r.sensor_type in ("Air Temperature", "Relative Humidity", "Water Temperature", "Dissolved Oxygen", "pH", "Atmospheric Pressure", "Particulate Matter PM2.5") and r.numeric_evidence["n_observed"] >= 24 * 14]
    enough_cov = cov is None or cov >= 0.5
    recs.append(_descriptive("forecastability", bool(fc) and span_days >= 14 and enough_cov, (f"時間涵蓋只有 {cov:.1%}（< 50%），連續資料太少，不評估預測任務" if not enough_cov else
                                                                                            ("有適合短期預測的連續型感測器且期間 ≥ 14 天" if fc else "沒有適合評估短期預測的感測器")), params={"sensors": [r.original_column_name for r in fc][:4]}))
    # ---- 模型型任務：Model Registry → Compatibility Gate
    if stem in DS.DOMAINS:
        router = router or GateRouter()
        recs += _model_recs(stem, rows, df, tr, cont, router)
    else:
        for t in MODEL_TASKS:
            recs.append(TaskRec(t, TASK_LABEL[t], "model", t != "predictive_maintenance" and bool(cont), "資料型態上說得通" if cont else "沒有連續型感測器", False, "沒有登記的場域：沒有任何模型卡片，也沒有實作", "no", "沒有已驗證的模型", False,
                                "未登記的資料集不能通過 Compatibility Gate（沒有 Domain Schema 與模型卡片）"))
    return recs


def _gate_targets(reg: DR.DomainModelRegistry, site: str, task: str, fallback: list[str]) -> list[str]:
    t = sorted({c.target_variable for c in reg.cards if c.site_id == site and c.task_type == task})
    return t or fallback


def _model_recs(stem, rows, df, tr, cont, router) -> list[TaskRec]:
    spec = DS.spec_for(stem)
    reg = router.registry
    as_of = pd.Timestamp(df["timestamp"].max()) if df is not None and len(df) else None
    impl = IMPLEMENTED_MODEL_TASKS.get(stem, {})
    out = []
    # forecast_risk
    has_th = tr is not None
    fr_targets = _gate_targets(reg, spec.site_id, "forecast_risk", [tr[0]] if tr else [])
    gate_fr = []
    for tgt in fr_targets:
        for opt in (False,):
            o = router.check(stem, "forecast_risk", tgt, horizon_h=3, as_of=as_of, replay_mode="strict", allow_experimental=opt)
            gate_fr.append({"target": tgt, "decision": o.decision, "opt_in": opt, "reasons": list(o.reasons)[:3], "card": o.card.key if o.card else None})
    allowed = [g for g in gate_fr if g["decision"] in ("allow", "degrade")]
    st = reg.status_of(spec.site_id, "forecast_risk")
    out.append(TaskRec("forecast_risk", TASK_LABEL["forecast_risk"], "model", has_th, "有溫度與濕度，THI 預測在資料型態上說得通" if has_th else "沒有溫度＋濕度", "forecast_risk" in impl,
                       impl.get("forecast_risk", "平台沒有為這個場域實作預測模型（沒有已訓練的模型 artifact）"), "yes" if st == DR.ST_VALIDATED else "no",
                       f"Model Registry 狀態：{st}" + ("（探索性歷史回測，不是獨立前瞻驗證）" if st == DR.ST_VALIDATED else ""), bool(allowed) and "forecast_risk" in impl,
                       ("Compatibility Gate 放行：" + allowed[0]["card"]) if allowed else "Compatibility Gate 拒絕：" + ("；".join(gate_fr[0]["reasons"]) if gate_fr and gate_fr[0]["reasons"] else "沒有相容的模型卡片"), gate=gate_fr))
    # anomaly_statistical
    an_targets = _gate_targets(reg, spec.site_id, "anomaly_statistical", [])
    gate_an, allowed0, allowed1 = [], [], []
    for tgt in an_targets:
        for opt in (False, True):
            o = router.check(stem, "anomaly_statistical", tgt, as_of=as_of, replay_mode="strict" if (as_of is not None and spec.site_id != "expert_system_c22") else ("strict" if as_of is not None and as_of > pd.Timestamp("2026-08-24 11:00") else "demonstration"), allow_experimental=opt)
            g = {"target": tgt, "decision": o.decision, "opt_in": opt, "reasons": list(o.reasons)[:3], "card": o.card.key if o.card else None}
            gate_an.append(g)
            if o.decision in ("allow", "degrade"):
                (allowed1 if opt else allowed0).append(g)
    st_an = reg.status_of(spec.site_id, "anomaly_statistical")
    suit_an = bool(cont)
    impl_an = "anomaly_statistical" in impl
    ex = bool(allowed0) and impl_an
    ex_opt = bool(allowed1) and impl_an
    why = ("Compatibility Gate 放行" if ex else ("需要 Experimental opt-in：Gate 在明確同意後才放行（opt-in 不改變模型狀態）" if ex_opt else "Compatibility Gate 拒絕：" + ("；".join((gate_an[0]["reasons"] if gate_an else [])[:2]) or "沒有相容的偵測器卡片")))
    out.append(TaskRec("anomaly_statistical", TASK_LABEL["anomaly_statistical"], "model", suit_an, "有連續型感測器，統計異常偵測在資料型態上說得通" if suit_an else "沒有連續型感測器", impl_an,
                       impl.get("anomaly_statistical", "平台沒有為這個場域實作異常偵測器（只有 Candidate 卡片／沒有 artifact）"), "no", f"Model Registry 狀態：{st_an}；Experimental 不是 Validated，也沒有故障標籤可驗證", ex, why,
                       requires_opt_in=bool(allowed1) and not allowed0, executable_with_opt_in=ex_opt, gate=gate_an))
    out.append(TaskRec("predictive_maintenance", TASK_LABEL["predictive_maintenance"], "model", False, "沒有設備故障紀錄、維修時間或停機標籤：Insufficient Evidence", False, "未實作", "no", "沒有可驗證的標籤", False, "不可執行：沒有標籤，不能宣稱任何預測維護能力"))
    return out


def recommend(stem: str, bundle: dict | None = None, router: GateRouter | None = None) -> dict:
    """登記的資料集：回傳 {classification, recommendations, summary}。"""
    import p55_analysis as AN
    b = bundle or AN.load_bundle(stem)
    recs = recommend_for_rows(b["cls"], b["quality"], b["df"], stem, router)
    return {"stem": stem, "recommendations": recs, "classification": b["cls"], "summary": summarize(recs)}


def summarize(recs: list[TaskRec]) -> dict:
    d = [r for r in recs if r.kind == "descriptive"]
    m = [r for r in recs if r.kind == "model"]
    return {"suitable": sum(r.suitable for r in recs), "implemented": sum(r.implemented for r in recs), "executable_now": sum(r.executable for r in recs),
            "executable_descriptive": sum(r.executable for r in d), "executable_model": sum(r.executable for r in m), "executable_with_opt_in": [r.task_id for r in m if r.executable_with_opt_in and not r.executable],
            "model_validated": [r.task_id for r in m if r.validated == "yes"]}


def recommend_frame(df: pd.DataFrame, name: str = "uploaded") -> dict:
    """沒有登記的資料（Unknown Domain）：只用欄名與數值分類，推薦結果受限。"""
    import p55_quality as QL
    cls = CL.classify_frame(df, name)
    q = QL.analyze_dataset(df, cls) if "timestamp" in df.columns else None
    recs = recommend_for_rows(cls, q, df if "timestamp" in df.columns else None, None)
    return {"stem": name, "recommendations": recs, "classification": cls, "summary": summarize(recs)}


def to_table(recs: list[TaskRec]) -> pd.DataFrame:
    return pd.DataFrame([r.as_row() for r in recs])
