"""
p55_classify.py — Phase 5.5：Domain / Sensor Type / Analysis Task 階層式分類

目標：不是『看檔名決定能做什麼』，而是由資料欄位本身的證據決定。每個欄位的分類證據來自：
  1. 欄位名稱規則（SENSOR_RULES，越具體的規則在前）
  2. 單位與物理合理範圍（沿用 sensor_meta 的推測；沒有任何單位經 JNC 確認）
  3. 實際觀測值（是否落在合理範圍、離散值個數、是否整數／狀態碼、是否常數）
  4. 時間頻率與時間戳記語義（DS.TIMESTAMP_SEMANTICS）
  5. Domain Schema 的備註（例如探頭與池位的對應未確認）
Domain 類型也由『感測器組成』推導（例如：有設備狀態碼＋室內氣體＋THI → Livestock Environment），不是由檔名。

分類狀態：
  CLASSIFIED  規則命中、單位可信度為高／中、觀測值與物理範圍一致、沒有已知的對應疑慮
  UNVERIFIED  規則命中，但單位可信度低、名稱本身有歧義（例如 SC）、探頭與位置對應未確認、狀態碼意義未確認，或觀測值與範圍不一致
  UNKNOWN     沒有任何規則命中（不強行分類）
單位未知時 unit = UNKNOWN，絕不猜測。本模組只讀資料、不改資料、不訓練、不預測。
"""
from __future__ import annotations

import re
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))

import domain_schema as DS  # noqa: E402
import sensor_meta as SM  # noqa: E402

CLASSIFIED, UNVERIFIED, UNKNOWN = "CLASSIFIED", "UNVERIFIED", "UNKNOWN"
IN_RANGE_MIN_FRAC = 0.95
# 零值語義：legitimate＝零是該感測器的常態（降雨、風靜止、設備關閉、北方 0°）；context＝零可能正常（低負載、低濃度），要看脈絡；suspicious＝物理上不太可能長時間剛好為零，需要驗證
ZERO_LEGIT, ZERO_CONTEXT, ZERO_SUSPICIOUS = "legitimate", "context_dependent", "suspicious"

# (名稱規則, sensor_type, 感測器群組, 測量型態, 零值語義, 說明)。順序重要：越具體越前面（CO2 在 CO 前、DO飽和度 在 DO 前、斜率 最先）。
SENSOR_RULES: list[tuple[str, str, str, str, str, str]] = [
    (r"斜率", "Calibration Slope", "Calibration", "calibration_parameter", ZERO_SUSPICIOUS, "探頭校正斜率；變動代表重新校正或設定改變，不是環境量測"),
    (r"帆布|遮陽|風扇-|加開|減開", "Device Actuator State", "Actuator", "state_code", ZERO_LEGIT, "設備狀態碼；意義未經 JNC 確認，不解讀"),
    (r"THI", "Temperature-Humidity Index (THI)", "Derived Index", "derived_index", ZERO_SUSPICIOUS, "由溫度與濕度導出的指數（無單位）"),
    (r"熱危害風險等級|危害等級", "Heat Hazard Level", "Derived Index", "state_code", ZERO_LEGIT, "分級碼；廠商定義未確認"),
    (r"熱指數", "Heat Index", "Derived Index", "derived_index", ZERO_SUSPICIOUS, "由溫濕度導出的熱指數"),
    (r"DO飽和度", "Dissolved Oxygen Saturation", "Water Quality", "continuous", ZERO_SUSPICIOUS, "溶氧飽和百分比"),
    (r"DO\d?水溫|水溫", "Water Temperature", "Water Quality", "continuous", ZERO_SUSPICIOUS, "水溫（探頭內建或獨立）"),
    (r"(?<![A-Za-z])DO\d?(?![A-Za-z])", "Dissolved Oxygen", "Water Quality", "continuous", ZERO_SUSPICIOUS, "溶氧 Dissolved Oxygen"),
    (r"ORP", "Oxidation-Reduction Potential (ORP)", "Water Quality", "continuous", ZERO_SUSPICIOUS, "氧化還原電位"),
    (r"pH", "pH", "Water Quality", "continuous", ZERO_SUSPICIOUS, "酸鹼值"),
    (r"(?<![A-Za-z])SC\d?", "Salinity or Conductivity (SC, ambiguous)", "Water Quality", "continuous", ZERO_SUSPICIOUS, "SC 可能是鹽度或比導電度，名稱本身有歧義"),
    (r"(?<![A-Za-z])EC(?![A-Za-z])", "Electrical Conductivity (EC)", "Water Quality", "continuous", ZERO_SUSPICIOUS, "導電度"),
    (r"水位", "Water Level", "Water Quality", "continuous", ZERO_SUSPICIOUS, "水位高度"),
    (r"大氣壓力", "Atmospheric Pressure", "Weather", "continuous", ZERO_SUSPICIOUS, "大氣壓力"),
    (r"風速", "Wind Speed", "Weather", "continuous", ZERO_LEGIT, "風速（靜風為 0 是常態）"),
    (r"風向", "Wind Direction", "Weather", "circular_angle", ZERO_LEGIT, "風向角（0° 與 360° 相同，是圓形變數）"),
    (r"雨量", "Rainfall", "Weather", "continuous", ZERO_LEGIT, "雨量（長時間為 0 通常只是沒下雨）"),
    (r"(?<![A-Za-z])TEMP|溫度", "Air Temperature", "Climate", "continuous", ZERO_SUSPICIOUS, "氣溫／舍內溫度"),
    (r"(?<![A-Za-z])RH(?![A-Za-z])|濕度", "Relative Humidity", "Climate", "continuous", ZERO_SUSPICIOUS, "相對濕度"),
    (r"PM2\.5", "Particulate Matter PM2.5", "Air Quality", "continuous", ZERO_CONTEXT, "細懸浮微粒"),
    (r"PM10", "Particulate Matter PM10", "Air Quality", "continuous", ZERO_CONTEXT, "懸浮微粒"),
    (r"HCHO", "Formaldehyde (HCHO)", "Air Quality", "continuous", ZERO_CONTEXT, "甲醛"),
    (r"CO2", "Carbon Dioxide (CO2)", "Air Quality", "continuous", ZERO_SUSPICIOUS, "二氧化碳（室外底值約數百 ppm，不會為 0）"),
    (r"(?<![A-Za-z])CO(?![A-Za-z0-9])", "Carbon Monoxide (CO)", "Air Quality", "continuous", ZERO_CONTEXT, "一氧化碳"),
    (r"TVOC", "Total Volatile Organic Compounds (TVOC)", "Air Quality", "continuous", ZERO_CONTEXT, "總揮發性有機物；單位與量程需確認"),
    (r"NH3", "Ammonia (NH3)", "Air Quality", "continuous", ZERO_CONTEXT, "氨氣；數值極小，需確認單位"),
    (r"CH4", "Methane (CH4)", "Air Quality", "continuous", ZERO_CONTEXT, "甲烷；單位需確認"),
    (r"噪音", "Noise Level", "Environment", "continuous", ZERO_SUSPICIOUS, "噪音"),
    (r"太陽能電壓", "Solar Panel Voltage", "Device Power", "continuous", ZERO_CONTEXT, "太陽能板電壓（夜間為 0 是常態）"),
    (r"太陽能電流", "Solar Panel Current", "Device Power", "continuous", ZERO_CONTEXT, "太陽能板電流（夜間為 0 是常態）"),
    (r"充電電流", "Battery Charge Current", "Device Power", "continuous", ZERO_CONTEXT, "電池充電電流"),
    (r"電池電量", "Battery Level", "Device Power", "continuous", ZERO_SUSPICIOUS, "電池剩餘電量"),
    (r"電池電壓", "Battery Voltage", "Device Power", "continuous", ZERO_SUSPICIOUS, "電池電壓"),
    (r"電壓\(V\)", "Supply Voltage", "Device Power", "continuous", ZERO_SUSPICIOUS, "供電電壓"),
    (r"相電壓", "Phase Voltage", "Electrical", "continuous", ZERO_SUSPICIOUS, "平均相電壓"),
    (r"平均電流|總電流", "Electrical Current (load)", "Electrical", "continuous", ZERO_CONTEXT, "負載電流（低電流可能只是低負載或停機，不等於故障）"),
    (r"視在功率", "Apparent Power", "Electrical", "continuous", ZERO_CONTEXT, "視在功率"),
    (r"無功功率", "Reactive Power", "Electrical", "continuous", ZERO_CONTEXT, "無功功率"),
    (r"功率因數", "Power Factor", "Electrical", "continuous", ZERO_CONTEXT, "功率因數"),
    (r"總和功率", "Active Power", "Electrical", "continuous", ZERO_CONTEXT, "有功功率"),
    (r"頻率", "Grid Frequency", "Electrical", "continuous", ZERO_SUSPICIOUS, "電網頻率"),
    (r"電度|用電度數", "Cumulative Energy Counter", "Electrical", "cumulative_counter", ZERO_CONTEXT, "累計電能計數器，只能遞增"),
    (r"訊號強度|4G訊號", "Signal Strength", "Device Health", "continuous", ZERO_SUSPICIOUS, "4G 訊號強度 CSQ"),
    (r"運轉時間|送電時間", "Uptime Counter", "Device Health", "cumulative_counter", ZERO_CONTEXT, "累計運轉秒數；歸零代表重新開機"),
    (r"開機次數", "Boot Counter", "Device Health", "cumulative_counter", ZERO_CONTEXT, "累計開機次數；增加代表重新開機"),
]
_COMPILED = [(re.compile(p), *rest) for p, *rest in SENSOR_RULES]
AMBIGUOUS_TYPES = {"Salinity or Conductivity (SC, ambiguous)", "Total Volatile Organic Compounds (TVOC)", "Ammonia (NH3)", "Methane (CH4)", "Device Actuator State", "Heat Hazard Level"}
PROBE_POSITION_RE = re.compile(r"^(?:pH|DO|ORP|SC)[123](?!\d)")             # 多探頭：探頭與池位的對應尚未確認（DS 備註）
# 每種感測器型態可做的『資料層』分析（不含模型）；模型型任務由 p55_recommend 另外判斷
GENERIC_TASKS = ("dataset_overview", "data_quality", "descriptive_statistics", "trend_analysis", "distribution")
KIND_TASKS = {"continuous": GENERIC_TASKS + ("daily_cycle", "flatline_zero_analysis", "outlier_candidates"), "state_code": ("dataset_overview", "data_quality", "descriptive_statistics", "state_distribution"),
              "cumulative_counter": ("dataset_overview", "data_quality", "descriptive_statistics", "counter_reset_events"), "circular_angle": GENERIC_TASKS + ("daily_cycle",),
              "calibration_parameter": ("dataset_overview", "data_quality", "descriptive_statistics", "calibration_events"), "derived_index": GENERIC_TASKS + ("daily_cycle", "flatline_zero_analysis")}
UNKNOWN_TASKS = ("dataset_overview", "data_quality", "descriptive_statistics", "column_info")


@dataclass(frozen=True)
class SensorClass:
    domain_id: str
    original_dataset_name: str
    display_name: str
    domain_type: str
    sensor_id: str
    sensor_type: str
    sensor_group: str
    measurement_kind: str
    original_column_name: str
    raw_header_name: str
    unit: str
    unit_verification_status: str
    sampling_frequency: str
    timestamp_status: str
    classification_evidence: str
    classification_status: str
    available_analysis_tasks: tuple
    zero_semantics: str
    numeric_evidence: dict

    def as_row(self) -> dict:
        d = self.__dict__.copy()
        d["available_analysis_tasks"] = list(self.available_analysis_tasks)
        return d


# ------------------------------------------------------------------------------ 欄位證據
def numeric_evidence(s: pd.Series, lo=None, hi=None) -> dict:
    v = pd.to_numeric(s, errors="coerce").astype(float)
    nz = v.dropna()
    ev = {"n": int(len(v)), "n_observed": int(len(nz)), "missing_frac": round(float(v.isna().mean()), 4) if len(v) else None, "distinct_values": int(nz.nunique()), "is_integer_valued": bool(len(nz) and np.all(np.isclose(nz, np.round(nz)))),
          "min": None if nz.empty else float(nz.min()), "max": None if nz.empty else float(nz.max()), "constant": bool(len(nz) and nz.nunique() == 1)}
    ev["fraction_in_expected_range"] = None if (nz.empty or lo is None or hi is None) else round(float(((nz >= lo) & (nz <= hi)).mean()), 4)
    return ev


def match_rule(col: str):
    for rx, st, grp, kind, zero, note in _COMPILED:
        if rx.search(col):
            return st, grp, kind, zero, note
    return None


def classify_column(col: str, series: pd.Series, *, header: str | None = None, spec: DS.DomainSpec | None = None, freq_label: str = "unknown", domain_type: str = "UNKNOWN",
                    stem: str = "") -> SensorClass:
    sem = SM.lookup(col)
    lo, hi = sem["phys_min"], sem["phys_max"]
    rule = match_rule(col)
    unit_known = sem["unit"] != "未知"
    conf_en = {"高": "HIGH", "中": "MEDIUM", "低": "LOW"}[sem["unit_confidence"]]
    unit_status = "UNKNOWN" if not unit_known else f"UNVERIFIED_INFERRED_{conf_en}"
    ev_num = numeric_evidence(series, lo if (rule and rule[2] not in ("state_code", "cumulative_counter")) else None, hi if (rule and rule[2] not in ("state_code", "cumulative_counter")) else None)
    sid = f"{spec.site_id}/{col}" if spec else col
    base = dict(domain_id=spec.domain_id if spec else "unknown", original_dataset_name=f"{stem}.csv" if stem else "", display_name=spec.display_name if spec else "", domain_type=domain_type, sensor_id=sid,
                original_column_name=col, raw_header_name=header or col, unit=sem["unit"] if unit_known else "UNKNOWN", unit_verification_status=unit_status, sampling_frequency=freq_label,
                timestamp_status=DS.TIMESTAMP_SEMANTICS, numeric_evidence=ev_num)
    if rule is None:
        return SensorClass(**base, sensor_type="UNKNOWN", sensor_group="UNKNOWN", measurement_kind="unknown", classification_evidence="欄位名稱沒有命中任何規則；不強行分類，也不推測單位",
                           classification_status=UNKNOWN, available_analysis_tasks=UNKNOWN_TASKS, zero_semantics=ZERO_CONTEXT)
    stype, grp, kind, zero, note = rule
    reasons, ok = [f"名稱規則：{stype}（{note}）", f"單位推測 {base['unit']}（可信度 {sem['unit_confidence']}；尚未經 JNC 確認）"], True
    if ev_num["n_observed"] == 0:
        ok = False
        reasons.append("沒有任何觀測值可佐證")
    elif ev_num["fraction_in_expected_range"] is not None:
        reasons.append(f"觀測值 {ev_num['fraction_in_expected_range']:.0%} 落在推測的物理範圍 [{lo:g}, {hi:g}] 內")
        if ev_num["fraction_in_expected_range"] < IN_RANGE_MIN_FRAC:
            ok = False
            reasons.append(f"低於 {IN_RANGE_MIN_FRAC:.0%}：觀測值與推測範圍不一致，需確認單位或感測器")
    if sem["unit_confidence"] == "低":
        ok = False
        reasons.append("單位可信度為『低』")
    if stype in AMBIGUOUS_TYPES:
        ok = False
        reasons.append("名稱或狀態碼意義有歧義，需向 JNC 確認")
    if PROBE_POSITION_RE.match(col):
        ok = False
        reasons.append("多探頭：探頭與池位／位置的對應尚未確認（Domain Schema 備註）")
    reasons.append(f"取樣頻率 {freq_label}；時間戳記無時區（{DS.TIMESTAMP_SEMANTICS}）")
    return SensorClass(**base, sensor_type=stype, sensor_group=grp, measurement_kind=kind, classification_evidence="；".join(reasons), classification_status=CLASSIFIED if ok else UNVERIFIED,
                       available_analysis_tasks=KIND_TASKS.get(kind, GENERIC_TASKS), zero_semantics=zero)


# ------------------------------------------------------------------------------ Domain 類型（由感測器組成推導）
DOMAIN_TYPES = ("Livestock Environment", "Water Quality", "Environmental Monitoring", "Microclimate", "Industrial Monitoring", "UNKNOWN")


def infer_domain_type(types: list[str], groups: list[str]) -> tuple[str, list[str], str]:
    """回傳 (主要類型, 次要類型, 證據)。規則看『感測器組成』，不看檔名。"""
    cnt = {g: groups.count(g) for g in set(groups)}
    n_water = sum(t in types for t in ("Dissolved Oxygen", "pH", "Oxidation-Reduction Potential (ORP)", "Electrical Conductivity (EC)", "Salinity or Conductivity (SC, ambiguous)", "Water Level"))
    n_air = sum(t in types for t in ("Particulate Matter PM2.5", "Particulate Matter PM10", "Formaldehyde (HCHO)", "Carbon Monoxide (CO)", "Total Volatile Organic Compounds (TVOC)", "Carbon Dioxide (CO2)",
                                      "Ammonia (NH3)", "Methane (CH4)"))
    has_climate = "Air Temperature" in types and "Relative Humidity" in types
    n_state = groups.count("Actuator")
    n_elec = cnt.get("Electrical", 0)
    secondary = []
    if n_state >= 3 and has_climate and any(t in types for t in ("Ammonia (NH3)", "Methane (CH4)", "Temperature-Humidity Index (THI)")):
        primary, ev = "Livestock Environment", f"設備狀態碼 {n_state} 個＋室內溫濕度＋氣體／THI 指標"
    elif n_water >= 2:
        primary, ev = "Water Quality", f"水質感測器 {n_water} 種（DO／pH／ORP／EC／SC／水位 等）"
    elif n_air >= 3:
        primary, ev = "Environmental Monitoring", f"空氣品質指標 {n_air} 種（PM／HCHO／CO／TVOC 等）"
    elif has_climate or "Wind Speed" in types:
        primary, ev = "Microclimate", "風／溫度／濕度等微氣候感測器為主"
    elif n_elec >= 3:
        primary, ev = "Industrial Monitoring", f"電力量測 {n_elec} 種"
    else:
        return "UNKNOWN", [], "感測器組成無法對應任何已知的 Domain 類型"
    if primary != "Industrial Monitoring" and n_elec >= 3:
        secondary.append("Industrial Monitoring")
    if primary not in ("Microclimate", "Environmental Monitoring") and (has_climate or "Wind Speed" in types) and primary != "Livestock Environment":
        secondary.append("Microclimate")
    if primary != "Environmental Monitoring" and n_air >= 3:
        secondary.append("Environmental Monitoring")
    if primary != "Water Quality" and n_water >= 2:
        secondary.append("Water Quality")
    return primary, secondary, ev + (f"；另有 {', '.join(secondary)} 類感測器" if secondary else "")


def sampling_label(ts: pd.Series) -> tuple[str, float | None]:
    d = pd.to_datetime(ts).sort_values().diff().dropna()
    if d.empty:
        return "unknown", None
    mode = d.mode().iloc[0]
    h = float(mode / pd.Timedelta(hours=1))
    frac = float((d == mode).mean())
    return f"{h:g} h（{frac:.1%} 的間隔相同）", h


def classify_dataset(stem: str, df: pd.DataFrame | None = None, root: Path | None = None) -> dict:
    """分類一份登記的資料集：回傳 {rows: [SensorClass...], domain_type, secondary_types, domain_evidence, frequency_h, ...}。"""
    spec = DS.spec_for(stem)
    if df is None:
        df, _ = DS.load_domain(stem, root)
    origin = DS.raw_header_origin(spec.path if root is None else Path(root) / "data" / "raw" / f"{stem}.csv") if (root is not None or spec.path.is_file()) else {}
    label, freq_h = sampling_label(df["timestamp"])
    cols = [c for c in df.columns if c != "timestamp"]
    prelim = [match_rule(c) for c in cols]
    types = [r[0] if r else "UNKNOWN" for r in prelim]
    groups = [r[1] if r else "UNKNOWN" for r in prelim]
    dtype_, sec, dev = infer_domain_type(types, groups)
    rows = [classify_column(c, df[c], header=origin.get(c, (c, ""))[0], spec=spec, freq_label=label, domain_type=dtype_, stem=stem) for c in cols]
    return {"stem": stem, "original_dataset_name": f"{stem}.csv", "display_name": spec.display_name, "domain_id": spec.domain_id, "site_id": spec.site_id, "domain_type": dtype_, "secondary_types": sec,
            "domain_evidence": dev, "sampling_frequency": label, "frequency_h": freq_h, "rows": rows, "n_classified": sum(r.classification_status == CLASSIFIED for r in rows),
            "n_unverified": sum(r.classification_status == UNVERIFIED for r in rows), "n_unknown": sum(r.classification_status == UNKNOWN for r in rows)}


def classify_frame(df: pd.DataFrame, name: str = "uploaded") -> dict:
    """沒有登記的資料（Unknown Domain）：只用欄名與數值分類。沒有 Domain Schema，所以 domain_id／單位來源一律標示未登記。"""
    label, freq_h = sampling_label(df["timestamp"]) if "timestamp" in df.columns else ("unknown", None)
    cols = [c for c in df.columns if c != "timestamp"]
    prelim = [match_rule(c) for c in cols]
    dtype_, sec, dev = infer_domain_type([r[0] if r else "UNKNOWN" for r in prelim], [r[1] if r else "UNKNOWN" for r in prelim])
    rows = [classify_column(c, df[c], freq_label=label, domain_type=dtype_, stem=name) for c in cols]
    return {"stem": name, "domain_type": dtype_, "secondary_types": sec, "domain_evidence": dev, "sampling_frequency": label, "frequency_h": freq_h, "rows": rows,
            "n_classified": sum(r.classification_status == CLASSIFIED for r in rows), "n_unverified": sum(r.classification_status == UNVERIFIED for r in rows), "n_unknown": sum(r.classification_status == UNKNOWN for r in rows)}


def to_table(cls: dict) -> pd.DataFrame:
    return pd.DataFrame([r.as_row() for r in cls["rows"]])
