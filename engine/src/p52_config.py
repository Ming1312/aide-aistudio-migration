"""
p52_config.py — Phase 5.2：專家系統 DO 統計異常偵測的『凍結設定』（Manifest）

這個檔案在任何 holdout 評估之前寫定。它同時是：
  * 實驗設計的唯一來源（時間切分、參數格、選擇規則、升級準則）
  * 偵測器版本的來源（detector_version / threshold_version / config hash）
Manifest 的雜湊會寫入 outputs/phase5_2/experiment_manifest.json、holdout 帳本與每個事件的 config_hash。
改動任何設定 = 新的 config hash = 新的事件 ID（舊事件不會被誤認為同一個）。

研究定位：Unsupervised / Weakly Supervised Statistical Anomaly Detection Prototype。
沒有設備故障標籤；沒有任何輸出是故障機率；沒有任何門檻是 JNC 確認的安全標準。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))

import traceability as TR  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "outputs" / "phase5_2"
MODEL_DIR = ROOT / "models" / "phase52"

MANIFEST_VERSION = "p52-manifest-v1"
DETECTOR_FAMILY = "do_anomaly"
DETECTOR_VERSION = "p52.0.1"
THRESHOLD_VERSION = "p52-thr-v1"
EVENT_RULES_VERSION = "p52-events-v1"
FEATURE_VERSION = "p52-feat-v1"
INPUT_SCHEMA_VERSION = "expert_system_c22-wide-hourly-v1"

DOMAIN_ID, SITE_ID, STREAM_ID, DATASET_STEM = "aquaculture_pond", "expert_system_c22", "sensor_host", "專家系統"
CHANNELS = ("DO1 即時值", "DO2 即時值", "DO3 即時值")      # 單一通道各自建模；探頭與池位對應未確認 → 不合併、不互相比較
SENSOR_SLUG = {"DO1 即時值": "do1", "DO2 即時值": "do2", "DO3 即時值": "do3"}
WATER_TEMP, CONTEXT_COL = "DO1水溫", "CPM 總電流"
CROSS_CHECK_COLS = ("DO1 即時值", "DO2 即時值", "DO3 即時值", "DO1水溫", "pH1 即時值", "ORP1 即時值")   # 『全通道同時為 0』的判斷欄位

# ---- 時間切分（來自 Phase 5.1 規劃：有效窗 2026-07-01 16:00 起；前 60% 估計、後 40% 留出）
T_TRAIN_START = pd.Timestamp("2026-07-01 16:00")
T_VAL_START = pd.Timestamp("2026-08-10 00:00")
T_HOLDOUT_START = pd.Timestamp("2026-08-24 12:00")
SPLITS = {"train": (T_TRAIN_START, T_VAL_START), "validation": (T_VAL_START, T_HOLDOUT_START), "holdout": (T_HOLDOUT_START, None)}
PRE_WINDOW_NOTE = "2026-07-01 16:00 以前的資料（6 月）不參與擬合、選擇或評估：存在 3 個資料缺口與全通道為 0 的列，且已列入 Phase 5.1 的『有效窗』定義之外"

# ---- 規則門檻（每一個都標明來源；沒有 ENTERPRISE_CONFIRMED）
#      source ∈ PHYSICAL_LIMIT_INFERRED | DATA_DISTRIBUTION | ENGINEERING_HEURISTIC，且全部帶 EXPLORATORY_THRESHOLD 旗標
RULES = {
    "sensor_gap_hours": {"value": 6, "source": "ENGINEERING_HEURISTIC", "flag": "EXPLORATORY_THRESHOLD",
                         "basis": "連續缺值 ≥6 小時視為資料流中斷；訓練＋驗證期缺口為 10/64/107 小時，短於 6 小時的缺值只記為 MISSING_DATA"},
    "zero_run_min_hours": {"value": 1, "source": "ENGINEERING_HEURISTIC", "flag": "EXPLORATORY_THRESHOLD",
                           "basis": "任何 DO=0 都需要人工驗證（物理上可能接近 0，也可能是感測器／通訊／系統編碼）；事件長度就是零值區塊長度，不預設任何一種解釋"},
    "nonzero_flatline_hours": {"value": 12, "source": "DATA_DISTRIBUTION", "flag": "EXPLORATORY_THRESHOLD",
                               "basis": "DO 解析度 0.01 mg/L；訓練＋驗證期最長非零同值區塊為 6 小時，取其 2 倍。Phase 1／5.1 曾用 24 小時，此處更敏感但同樣未經企業確認"},
    "do_physical_min": {"value": 0.0, "source": "PHYSICAL_LIMIT_INFERRED", "flag": "EXPLORATORY_THRESHOLD", "basis": "DO 不可為負（單位 mg/L 為推測、未經確認）"},
    "do_physical_max": {"value": 20.0, "source": "PHYSICAL_LIMIT_INFERRED", "flag": "EXPLORATORY_THRESHOLD", "basis": "超過約 20 mg/L 在淡水／鹽水中不合理（單位為推測）"},
    "abrupt_change_k": {"value": 8.0, "source": "DATA_DISTRIBUTION", "flag": "EXPLORATORY_THRESHOLD",
                        "basis": "|1 小時變化| ≥ k × 訓練期穩健尺度（1.4826×MAD）；k=8 沿用 Phase 1／5.1 的突跳候選規則"},
}
ABRUPT_SCALE_FLOOR = 0.05          # 穩健尺度下限（mg/L）：MAD≈0 時的保護（需 >0）

# ---- 偵測器通用設定
WARMUP_HOURS = 24                  # 每個連續片段開始後至少要有的有效歷史小時數；之前的狀態是 UNKNOWN
SEGMENT_RESET_GAP_HOURS = 6        # 缺值 ≥ 此長度 → 基準／片段重置（不跨缺口計算）
MIN_VALID_FRAC = 0.8               # 滾動視窗內有效點比例下限，不足 → 特徵為 NaN（UNKNOWN）
MAD_FLOOR_FRAC = 0.02              # Robust Z 尺度下限：訓練期 (q95−q05) 的 2%
ALERT_BUDGET_QUANTILE = 0.99       # 所有偵測器相同的名目警報預算：門檻 = 重擬合資料上分數的 99% 分位（名目 1% 警報小時）
BUDGET_SENSITIVITY_QUANTILES = (0.98, 0.99, 0.995)

# ---- 事件規則（所有偵測器相同 → 公平比較）
EVENT_RULES = {"version": EVENT_RULES_VERSION, "persist_on_hours": 2, "clear_hours": 3, "max_unknown_hours": 24,
               "note": "ALERT 連續 2 小時 → 事件開始（起點為第一個 ALERT 小時）；連續 3 個 NORMAL 小時 → 解除；缺值／UNKNOWN 不解除事件、不累計解除；"
                       "UNKNOWN 連續 24 小時 → 事件以 INTERRUPTED_DATA_GAP 結束且結束時間為未知；事件 ID 只由起點決定"}
EVENT_RULES["level1_clear_hours"] = {"SENSOR_GAP": 1, "ZERO_RUN_REQUIRES_VERIFICATION": 1, "NONZERO_FLATLINE": 1, "INVALID_VALUE_CANDIDATE": 1, "ABRUPT_CHANGE": 3}
LEVEL1_PERSIST = 1                 # Level-1（資料品質）事件由規則條件本身定義持續性（例如零值 ≥3 小時），不再另外要求持續

# ---- 超參數格（驗證期選擇；每個偵測器很小的格，避免多重比較失控）
GRID = {
    "robust_z": [{"stat": "level_and_d3"}],
    "ewma": [{"lam": lam, "baseline_hours": bh} for lam in (0.1, 0.3) for bh in (72, 168)],
    "iforest": [{"features": fs, "max_samples": ms} for fs in ("basic", "basic_trend") for ms in (128, 256)],
    "iforest_ctx": [{"features": "basic_trend+load", "max_samples": 256}],
}
IF_FIXED = {"n_estimators": 200, "random_state": 52, "contamination": "auto", "n_jobs": 1}

# ---- 合成異常（單位：σ_ref = 訓練期 DO 水準的穩健標準差 1.4826×MAD；單一方向各一半）
SYNTH = {
    "seed": 5200, "n_per_scenario": {"validation": 12, "holdout": 20}, "min_spacing_hours": 24, "detect_window_after_hours": 6,
    "scenarios": [
        {"type": "spike", "magnitude_sigma": 3.0, "duration_h": 1}, {"type": "spike", "magnitude_sigma": 5.0, "duration_h": 1},
        {"type": "step", "magnitude_sigma": 1.0, "duration_h": 48}, {"type": "step", "magnitude_sigma": 2.0, "duration_h": 48}, {"type": "step", "magnitude_sigma": 3.0, "duration_h": 48},
        {"type": "drift", "magnitude_sigma": 2.0, "duration_h": 48}, {"type": "drift", "magnitude_sigma": 3.0, "duration_h": 48},
        {"type": "flatline", "magnitude_sigma": 0.0, "duration_h": 12}, {"type": "flatline", "magnitude_sigma": 0.0, "duration_h": 24},
        {"type": "zero_run", "magnitude_sigma": 0.0, "duration_h": 3}, {"type": "zero_run", "magnitude_sigma": 0.0, "duration_h": 12},
        {"type": "missing_segment", "magnitude_sigma": 0.0, "duration_h": 6}, {"type": "missing_segment", "magnitude_sigma": 0.0, "duration_h": 24},
    ],
}

SYNTH["detect_window_note"] = ("偵測成功 = 在『注入區間＋其後 detect_window_after_hours 小時』內出現偵測器自己的事件（detected_at 落在該區間）；"
                              "控制複本（未注入）在同一區間已有事件者不納入；偵測延遲 = detected_at − 注入起點")
SYNTH["slice_hours_before"], SYNTH["slice_hours_after"] = 240, 30      # 每個注入只在一段局部切片上評分（切片以前的歷史足夠暖機與 EWMA 基準）

# ---- 負載脈絡與穩定度研究的固定設定
CONTEXT = {"transition_band_frac": 0.10, "coincidence_hours": 2, "lead_lag_max_hours": 6, "permutation_n": 2000, "permutation_seed": 5201,
           "min_alert_hours_for_test": 10, "note": "低／高負載切點 = 開發期 CPM 的 Otsu 雙峰切點（需類間變異占比 ≥0.5）；TRANSITION = 切點±(10% × 切點到較近模態的距離)的緩衝帶，或與前一個有值小時的區域不同（即跨越切點的那一小時）；皆為候選統計狀態，非已確認運轉模式"}
STABILITY = {"iforest_extra_seeds": (53, 54), "contamination_trim_fraction": 0.05, "contamination_note": "污染研究：預設（全部訓練列）／排除 Level-1 可疑列（突變前後 3 小時）／迭代修剪分數最高 5% 後重擬合"}

# ---- 驗證期選擇規則（無標籤，事先固定）
SELECTION = {
    "stage": "validation_only", "metric": "mean_detection_rate_over_spike_step_drift_on_validation_synthetic_copies",
    "constraint": "validation alert-hour share <= 0.05 (若全部違反 → 選 alert-hour share 最小者)",
    "tie_break": ["lower events_per_day on validation", "fewer features / simpler configuration"],
    "refit_policy": "選定後以 train+validation 重擬合（統計量、模型、門檻），超參數保持凍結；holdout 完全不參與",
}

# ---- 保留／升級準則（事先固定）
PROMOTION = {
    "retain_rule": "在滿足全部 gate 的偵測器中，保留最簡單者；Isolation Forest 只有在『相同警報預算與事件規則下，holdout 合成偵測率（spike/step/drift 平均）"
                   "比最佳簡單基準（Robust Z／EWMA）高 ≥ 0.10 且不更不穩定』時才保留。",
    "simplicity_order": ["rule_based", "robust_z", "ewma", "iforest", "iforest_ctx"],
    "roles": {"LEVEL1_data_quality": ["rule_based"], "LEVEL2_statistical": ["robust_z", "ewma", "iforest", "iforest_ctx"]},
    "role_rule": "兩個角色各自保留：Level 1 = rule_based（資料品質候選，不比較準確度）；Level 2 = 在滿足數值 gate 的 Level 2 偵測器中保留最簡單者（robust_z < ewma < iforest < iforest_ctx）。"
                 "沒有任何 Level 2 偵測器滿足 gate → 不保留 Level 2 偵測器（結果只作探索），Level 2 卡片維持 Candidate。",
    "gates": {
        "data_quality_masks_applied": True, "temporal_causality_tests_pass": True, "traceability_tests_pass": True, "version_compat_tests_pass": True,
        "holdout_alert_hour_share_max": 0.05, "holdout_events_per_day_max": 1.0, "synthetic_min_mean_detection_rate": 0.5, "limitations_recorded": True},
    "promotion_label_if_pass": "Validated Prototype for Statistical Anomaly Detection (NOT an equipment failure detector)",
    "registry_status_if_pass": "Experimental", "registry_status_if_fail": "Candidate",
    "equipment_inspection_candidate_rule": {
        "requires": ["development-period (train+validation) permutation test p < 0.01 for association between DO anomaly onset and load transition/low-load",
                     "same-direction association in holdout", "event coincides with load transition or low load within ±2 hours"],
        "default": "not issued; context only"},
}
BANNED_CLAIMS = ("故障機率", "設備故障已確認", "曝氣機故障", "停機", "準確率", "failure probability", "confirmed fault")


def manifest() -> dict:
    return {
        "manifest_version": MANIFEST_VERSION, "positioning": "Unsupervised / Weakly Supervised Statistical Anomaly Detection Prototype (no fault labels)",
        "detector_family": DETECTOR_FAMILY, "detector_version": DETECTOR_VERSION, "threshold_version": THRESHOLD_VERSION, "feature_version": FEATURE_VERSION,
        "input_schema_version": INPUT_SCHEMA_VERSION, "domain_id": DOMAIN_ID, "site_id": SITE_ID, "stream_id": STREAM_ID, "dataset": DATASET_STEM,
        "channels": list(CHANNELS), "context_column": CONTEXT_COL, "channels_independent": "DO1/2/3 各自建模；探頭與池位對應未確認，不合併",
        "splits": {k: [str(a), None if b is None else str(b)] for k, (a, b) in SPLITS.items()}, "pre_window_note": PRE_WINDOW_NOTE,
        "rules": RULES, "abrupt_scale_floor": ABRUPT_SCALE_FLOOR, "warmup_hours": WARMUP_HOURS, "segment_reset_gap_hours": SEGMENT_RESET_GAP_HOURS,
        "min_valid_frac": MIN_VALID_FRAC, "mad_floor_frac": MAD_FLOOR_FRAC, "alert_budget_quantile": ALERT_BUDGET_QUANTILE,
        "budget_sensitivity_quantiles": list(BUDGET_SENSITIVITY_QUANTILES), "event_rules": EVENT_RULES, "level1_persist": LEVEL1_PERSIST,
        "grid": GRID, "iforest_fixed": IF_FIXED, "synthetic": SYNTH, "context": CONTEXT, "stability": STABILITY, "selection": SELECTION, "promotion": PROMOTION,
        "leakage_controls": ["所有特徵只用當下與過去（滾動視窗不含未來）", "不跨缺口計算差分／滾動統計；片段重置後有暖機期", "統計量、門檻、模型只用訓練（重擬合時用訓練＋驗證）",
                             "holdout 只評估一次（holdout_ledger.json 記錄；重跑必須得到相同摘要）", "合成異常只注入評估資料的複本，原始 CSV 不被改動"],
        "forbidden": ["不得宣稱真實設備故障預測或診斷準確率", "不得輸出故障機率", "不得使用未確認的 DO 門檻產生正式危險警報", "不得把異常寫入任何設備控制流程"],
    }


def manifest_hash() -> str:
    return TR.compute_config_sha256(json.loads(json.dumps(manifest(), default=str)))


def detector_config_hash(selected: dict | None) -> str:
    """偵測器設定雜湊 = Manifest 的規則／事件／版本部分 + 選定的超參數。改動任一項 → 事件 ID 改變。"""
    core = {"detector_version": DETECTOR_VERSION, "threshold_version": THRESHOLD_VERSION, "feature_version": FEATURE_VERSION, "rules": RULES,
            "abrupt_scale_floor": ABRUPT_SCALE_FLOOR, "warmup": WARMUP_HOURS, "reset_gap": SEGMENT_RESET_GAP_HOURS, "min_valid_frac": MIN_VALID_FRAC,
            "mad_floor_frac": MAD_FLOOR_FRAC, "budget_q": ALERT_BUDGET_QUANTILE, "event_rules": EVENT_RULES, "selected": selected or {}}
    return TR.compute_config_sha256(json.loads(json.dumps(core, default=str)))
