"""
p56_tasks.py — Phase 5.6B：Candidate AI Task Generation、Eligibility Gate、Data Leakage Audit、實驗預算（沒有評估任何模型）

不預設七份資料都要建立預測模型：先為每個『場域 × 感測欄位 × 預測時距』產生候選任務，再用可稽核的 Eligibility Gate 判定 ELIGIBLE／CONDITIONAL／INELIGIBLE，
拒絕一定有原因。這個模組只看資料結構（可用樣本、連續區段、切分大小、變異、欄位語義），不看任何模型表現。
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))

import p55_analysis as AN  # noqa: E402
import p55_classify as CL  # noqa: E402
import p56_core as CO  # noqa: E402
import p56_profile as PR  # noqa: E402

ELIGIBLE, CONDITIONAL, INELIGIBLE = "ELIGIBLE", "CONDITIONAL", "INELIGIBLE"
PASS, WARN, FAIL = "PASS", "WARN", "FAIL"
CHECKS = [("horizon_supported_by_sampling_interval", True), ("target_is_interpretable", True), ("target_is_a_measurement_not_an_identifier_or_code", True), ("enough_valid_observations", True),
          ("enough_continuous_history", True), ("reasonable_variance", True), ("train_validation_holdout_possible", True), ("derived_target_or_feature_leakage", True),
          ("features_available_at_prediction_time", False), ("no_unconfirmed_unit_or_physical_assumption_required", False), ("comparable_baseline_exists", True)]
NOT_A_TARGET = {"state_code": "狀態碼（類別編碼）不是連續量測", "cumulative_counter": "累計計數器（會編碼時間本身）不是預測目標", "calibration_parameter": "校正參數反映維護事件，不是環境量測",
                "circular_angle": "圓形變數（0°與360°相同）需要專用方法，本階段不預測"}


def eligible_feature_pool(b: dict, target: str) -> list[str]:
    ex = CO.PROTOCOL["feature_exclusions"]
    return [r.original_column_name for r in b["cls"]["rows"] if r.original_column_name != target and r.measurement_kind not in ex["measurement_kinds"] and r.classification_status not in ex["classification"]
            and r.measurement_kind in ("continuous", "derived_index") and r.numeric_evidence["n_observed"] >= 100]


def feature_audit_table(b: dict) -> pd.DataFrame:
    """每個欄位『能不能當特徵』與原因（洩漏稽核的欄位級結果）。"""
    ex = CO.PROTOCOL["feature_exclusions"]
    rows = []
    for r in b["cls"]["rows"]:
        if r.measurement_kind in ex["measurement_kinds"]:
            role, why = "EXCLUDED_AS_FEATURE", NOT_A_TARGET.get(r.measurement_kind, "") + "；" + ex["reason"]
        elif r.classification_status in ex["classification"]:
            role, why = "EXCLUDED_AS_FEATURE", "分類為 UNKNOWN：不推測語義，不當特徵"
        elif r.measurement_kind == "circular_angle":
            role, why = "EXCLUDED_AS_FEATURE", "圓形變數需要專用編碼；本階段不當特徵"
        elif r.numeric_evidence["n_observed"] < 100:
            role, why = "EXCLUDED_AS_FEATURE", "有效觀測不足 100 筆"
        else:
            role, why = "ALLOWED_AS_CROSS_SENSOR_FEATURE", "只用預測起點（含）以前的值；可用時間依時間戳記語義，尚未確認（見 TIMESTAMP_SEMANTICS_UNCONFIRMED）"
        rows.append({"domain": b["stem"], "column": r.original_column_name, "sensor_type": r.sensor_type, "measurement_kind": r.measurement_kind, "feature_role": role, "reason": why})
    return pd.DataFrame(rows)


def candidate_for(b: dict, g: pd.DataFrame, r: CL.SensorClass, h: int, step_h: float) -> tuple[dict, list[dict]]:
    stem, c = b["stem"], r.original_column_name
    P = CO.PROTOCOL
    E = P["eligibility"]
    y = g[c].to_numpy(dtype=float)
    obs = y[~np.isnan(y)]
    n = len(y)
    delay = 0
    um = CO.usable_mask(y, h, delay)
    origins = np.where(um)[0]
    sp = CO.chrono_split(origins, h)
    present = ~np.isnan(y)
    segs = PR.segments_of(present)
    lens = [z - a + 1 for a, z in segs]
    ts = g.index
    pool = eligible_feature_pool(b, c)
    mode_ratio = float((obs == pd.Series(obs).mode().iloc[0]).mean()) if len(obs) else 1.0
    zero_ratio = float((obs == 0).mean()) if len(obs) else 1.0
    distinct = int(pd.Series(obs).nunique()) if len(obs) else 0
    kinds_ok = r.measurement_kind in P["target_kinds_allowed"]
    ck: list[dict] = []

    def add(name, status, detail):
        ck.append({"check": name, "status": status, "detail": detail, "affects_decision": dict(CHECKS)[name]})
    # 1 時距
    ok_h = abs(h / step_h - round(h / step_h)) < 1e-9 and h >= step_h
    add("horizon_supported_by_sampling_interval", PASS if ok_h else FAIL, f"取樣間隔 {step_h:g} h；預測時距 {h} h" + ("" if ok_h else "：不是取樣間隔的整數倍，不插值創造資料"))
    # 2 可解釋
    add("target_is_interpretable", {CL.CLASSIFIED: PASS, CL.UNVERIFIED: WARN, CL.UNKNOWN: FAIL}[r.classification_status], f"感測器類型 {r.sensor_type}；分類狀態 {r.classification_status}" + ("；探頭對應／單位／語義尚未確認" if r.classification_status == CL.UNVERIFIED else ""))
    # 3 不是識別碼或代碼
    if not kinds_ok:
        add("target_is_a_measurement_not_an_identifier_or_code", FAIL, NOT_A_TARGET.get(r.measurement_kind, f"型態 {r.measurement_kind} 不是連續量測"))
    elif r.measurement_kind == "derived_index":
        add("target_is_a_measurement_not_an_identifier_or_code", PASS, "導出指標（由其他感測量以公式計算）；仍是有意義的連續量")
    else:
        add("target_is_a_measurement_not_an_identifier_or_code", PASS, "連續量測")
    # 4 有效觀測與可用樣本
    us = int(len(origins))
    st = PASS if us >= E["usable_eligible"] else (WARN if us >= E["usable_conditional"] else FAIL)
    add("enough_valid_observations", st, f"觀測 {len(obs)}／{n} 小時（{len(obs) / n:.0%}）；可用樣本（完整 25 小時歷史且目標存在）{us}")
    # 5 連續歷史
    ll = max(lens, default=0)
    add("enough_continuous_history", PASS if ll >= 168 else (WARN if ll >= 49 else FAIL), f"此欄位 {len(lens)} 個連續區段，最長 {ll} 小時（需 ≥168 小時為 PASS、≥49 小時為 WARN）")
    # 6 變異
    if distinct < E["min_distinct"] or mode_ratio > E["max_mode_ratio"] or (len(obs) and np.std(obs) == 0):
        add("reasonable_variance", FAIL, f"相異值 {distinct}、眾數占比 {mode_ratio:.0%}：近乎常數，沒有可預測的變化")
    elif zero_ratio > E["max_zero_ratio_conditional"]:
        add("reasonable_variance", WARN, f"零值占 {zero_ratio:.0%}（零膨脹）；零的語義依感測器而定")
    else:
        add("reasonable_variance", PASS, f"相異值 {distinct}、眾數占比 {mode_ratio:.0%}、零值占 {zero_ratio:.0%}")
    # 7 切分
    ns = (len(sp["train"]), len(sp["validation"]), len(sp["holdout"]))
    mn = min(ns)
    add("train_validation_holdout_possible", PASS if mn >= E["split_eligible"] else (WARN if mn >= E["split_conditional"] else FAIL), f"依時間順序切分（含隔離區）：train {ns[0]}、validation {ns[1]}、holdout {ns[2]}")
    # 8 導出變數
    der = r.measurement_kind == "derived_index"
    add("derived_target_or_feature_leakage", WARN if der else PASS, ("目標是導出指標：特徵只用預測起點以前的值；導出關係已在剖析中記錄，不使用目標當下之後的資訊" if der else "目標不是導出指標；設備狀態／計數器／校正參數已排除出特徵"))
    # 9 可得時間
    add("features_available_at_prediction_time", WARN if pool else PASS, ("自身歷史＋日曆特徵（確定可得）" + (f"；另有 {len(pool)} 個同場域感測器可作交叉特徵，其可得時間依時間戳記語義尚未確認（TIMESTAMP_SEMANTICS_UNCONFIRMED），pilot 另做發布延遲 1 小時的敏感度分析" if pool else "")))
    # 10 單位
    add("no_unconfirmed_unit_or_physical_assumption_required", WARN if r.unit_verification_status != "UNKNOWN" else PASS, f"單位 {r.unit}（{r.unit_verification_status}）：任務只用相對指標，不需要確認的單位；絕對 MAE 不跨物理量比較")
    # 11 基準
    add("comparable_baseline_exists", PASS if us >= 1 else FAIL, "持續性與移動平均只需要過去觀測；季節性基準是否有效在訓練期內決定（協定第 baselines 條）")
    fails = [x for x in ck if x["affects_decision"] and x["status"] == FAIL]
    warns = [x for x in ck if x["affects_decision"] and x["status"] == WARN]
    decision = INELIGIBLE if fails else (CONDITIONAL if warns else ELIGIBLE)
    reasons = [f"{x['check']}: {x['detail']}" for x in (fails or warns)]
    lk = []
    if der:
        lk.append("DERIVED_TARGET")
    if pool:
        lk.append("CROSS_SENSOR_AVAILABILITY_UNVERIFIED")
    lk.append("TIMESTAMP_SEMANTICS_UNCONFIRMED")
    t0 = ts[sp["train"][0]] if len(sp["train"]) else None
    row = {"task_id": f"{stem}::{c}::h{h}", "domain": stem, "domain_id": b["cls"]["domain_id"], "target_column": c, "sensor_type": r.sensor_type, "forecast_horizon_h": h, "sampling_interval_h": step_h,
           "usable_history": us, "observed_hours": int(len(obs)), "observed_frac": round(len(obs) / n, 4), "continuous_segments": len(lens), "longest_segment_h": ll, "n_train": ns[0], "n_validation": ns[1], "n_holdout": ns[2],
           "train_start": str(ts[sp["train"][0]]) if len(sp["train"]) else "", "validation_start": str(ts[sp["val_start"]]) if sp["val_start"] is not None else "", "holdout_start": str(ts[sp["hold_start"]]) if sp["hold_start"] is not None else "",
           "candidate_features": "F0(own history+calendar)" + (f"; F1(+{min(len(pool), CO.PROTOCOL['max_cross_sensors'])} of {len(pool)} same-domain sensors, chosen on train only)" if pool else ""), "n_cross_pool": len(pool),
           "leakage_risks": ";".join(lk), "baseline_feasibility": "persistence,moving_average,linear_ar4 feasible; seasonal_naive decided on train" if us else "none", "model_feasibility": ("HGB,XGB" if decision != INELIGIBLE else "none"),
           "unit": r.unit, "unit_status": r.unit_verification_status, "classification_status": r.classification_status, "zero_ratio": round(zero_ratio, 4), "mode_ratio": round(mode_ratio, 4), "decision": decision,
           "reasons": " | ".join(reasons) if reasons else "all affecting checks passed"}
    return row, [{"task_id": row["task_id"], **x} for x in ck]


def generate(stems: list[str]) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    inv, chk, feat = [], [], []
    for stem in stems:
        b = AN.load_bundle(stem)
        g = PR.grid(b)
        step_h = b["cls"].get("frequency_h") or 1.0
        feat.append(feature_audit_table(b))
        for r in b["cls"]["rows"]:
            # 候選＝所有欄位 × 所有時距（不是連續量測的欄位也產生候選，由 Gate 拒絕並說明原因）
            for h in CO.PROTOCOL["horizons_h"]:
                row, ck = candidate_for(b, g, r, h, step_h)
                inv.append(row)
                chk += ck
    return pd.DataFrame(inv), pd.DataFrame(chk), pd.concat(feat, ignore_index=True)


# ------------------------------------------------------------------------------ 預算與 Pilot（預先登記的排序，不看任何模型表現）
def select_budget(inv: pd.DataFrame) -> dict:
    B = CO.PROTOCOL["budget"]
    ok = inv[inv["decision"].isin([ELIGIBLE, CONDITIONAL])].copy()
    h3 = ok[ok["forecast_horizon_h"] == 3].copy()
    h3["tier"] = np.where(h3["decision"] == ELIGIBLE, 0, 1)
    h3["op_rank"] = np.where(h3["sensor_type"].isin(B["operational_priority_sensor_types"]), 0, 1)
    h3["priority"] = h3["usable_history"] * (1 - h3["zero_ratio"])
    h3["col_order"] = h3.groupby("domain").cumcount()
    chosen_targets = {}
    for dom, grp in h3.groupby("domain", sort=False):
        grp = grp.sort_values(["op_rank", "tier", "priority", "col_order"], ascending=[True, True, False, True])
        seen, picked = set(), []
        for r in grp.itertuples():
            if B["max_one_target_per_sensor_type"] and r.sensor_type in seen:
                continue
            seen.add(r.sensor_type)
            picked.append(r.target_column)
            if len(picked) >= B["max_targets_per_domain"]:
                break
        chosen_targets[dom] = picked
    ids = [r.task_id for r in ok.itertuples() if r.target_column in chosen_targets.get(r.domain, [])]
    pilot = [f"{dom}::{cols[0]}::h3" for dom, cols in chosen_targets.items() if cols and f"{dom}::{cols[0]}::h3" in set(ok["task_id"])]
    return {"chosen_targets": chosen_targets, "task_ids": ids, "pilot_task_ids": pilot}


def resource_estimate(inv: pd.DataFrame, plan: dict, fit_seconds: dict | None = None) -> dict:
    fs = fit_seconds or {"HGB": 0.8, "XGB": 0.6}
    n_tasks = len(plan["task_ids"])
    ml_variants = 4                                    # HGB/XGB × F0/F1
    folds = CO.PROTOCOL["rolling_origin_cv"]["n_folds"] + 1
    fits = n_tasks * ml_variants * folds
    return {"candidate_tasks": int(len(inv)), "eligible": int((inv["decision"] == ELIGIBLE).sum()), "conditional": int((inv["decision"] == CONDITIONAL).sum()), "ineligible": int((inv["decision"] == INELIGIBLE).sum()),
            "tasks_in_budget": n_tasks, "pilot_tasks": len(plan["pilot_task_ids"]), "ml_variants_per_task": ml_variants, "model_fits": fits, "baseline_fits": n_tasks * 1 * folds,
            "estimated_runtime_min": round(fits * (fs["HGB"] + fs["XGB"]) / 2 / 60, 1), "estimated_peak_memory_mb": 600, "estimated_storage_mb": round(n_tasks * 0.05, 1),
            "note": "估計值：由 pilot 前的單次擬合時間推算；所有任務可中斷／恢復（每個任務一個結果檔）"}
