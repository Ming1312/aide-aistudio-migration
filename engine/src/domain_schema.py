"""
domain_schema.py — Phase 5.1：多場域資料 Schema（Domain / Site / Stream / Sensor / Measurement）

目的
  Phase 1～4 只有「羊舍」一個正式場域，其他六份 CSV 只被當作資料盤點與探索性實驗。多場域之後，
  每筆觀測都必須能回答：它屬於哪個 Domain / Site / Stream / Sensor？單位是什麼、這個單位有多可信？
  資料品質如何？來自哪一份資料集的哪個版本？

設計原則
  * 不建立單一大型資料表：存放仍是各場域的寬表（load_data.load_sensor_csv 的結果）。
    `to_long()` 只是『邏輯 Schema』的具體化——需要時才展開，不改動寬表、不寫回原始檔。
  * 單位只來自 sensor_meta.py 的「依欄名推測」，**沒有任何一個單位被 JNC 確認**，所以 unit_status 最高只到
    inferred_high；找不到規則的欄位是 unknown，絕不自行換算成某個物理單位。
  * domain_id 是依『感測器欄位組成』做的工程分群，屬暫定（待 JNC 確認），不是官方分類。
  * 本模組只讀取資料，不訓練、不預測、不做任何決策。
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd

from load_data import detect_delimiter, detect_encoding, find_header_row, load_sensor_csv
from sensor_meta import STATE_UNITS, is_cumulative, lookup

ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = ROOT / "data" / "raw"
SCHEMA_VERSION = "domain-schema-v1"
FEATURE_PIPELINE_VERSION = "wide-hourly-v1"          # 目前所有場域的寬表（日期+小時 → 每小時 timestamp）
TIMESTAMP_SEMANTICS = "naive_local_hourly_unconfirmed"   # CSV 沒有時區；整點值代表『該小時起點』還是『該小時平均』未經 JNC 確認

LONG_COLUMNS = ["domain_id", "site_id", "stream_id", "sensor_id", "timestamp", "measurement_name", "measurement_value",
                "measurement_unit", "unit_status", "value_kind", "quality_status", "source_dataset_id", "source_version"]

UNIT_STATUS = ("inferred_high", "inferred_medium", "inferred_low", "unknown")     # 沒有 "confirmed"：CSV 與已知文件都不含單位
VALUE_KINDS = ("continuous", "state_code", "cumulative_counter", "circular_angle", "calibration_parameter", "derived_index")
QUALITY_STATUS = ("ok", "missing", "out_of_expected_range_candidate")
_CONF_TO_STATUS = {"高": "inferred_high", "中": "inferred_medium", "低": "inferred_low"}


@dataclass(frozen=True)
class DomainSpec:
    dataset_stem: str                      # data/raw/<stem>.csv
    domain_id: str
    site_id: str
    display_name: str
    streams: tuple = ()                    # ((欄名前綴關鍵字, stream_id), ...)；比對 CSV 原始表頭
    default_stream: str = "main"
    notes: str = ""

    @property
    def dataset_id(self) -> str:
        return f"ds:{self.site_id}"

    @property
    def path(self) -> Path:
        return RAW_DIR / f"{self.dataset_stem}.csv"


# 依 CSV 實際欄位（不是檔名）分群：
#   羊舍            設備狀態碼＋舍內溫濕度/CO2/NH3/CH4＋THI → 畜舍環境
#   專家系統        DO/pH/ORP/SC/水位＋微氣候＋設備用電     → 水產養殖池
#   三爺宮溪        pH/EC/DO/水溫＋太陽能供電               → 河川水質站
#   工地微氣候      風/溫濕/熱指數/PM/噪音（無氣體）         → 工地微氣候
#   東北角/育成一厰/育成北側  風/溫濕/PM/HCHO/CO/TVOC        → 空氣品質微氣候（同一組感測器配置）
DOMAINS: dict[str, DomainSpec] = {s.dataset_stem: s for s in (
    DomainSpec("羊舍", "livestock_barn", "sheep_barn", "羊舍（成羊區／仔羊區）", (("DO22340", "barn_controller"),), "barn_controller",
               "名稱 DO22340 為控制器代號；設備狀態碼（帆布／遮陽／風扇）意義未經確認"),
    DomainSpec("專家系統", "aquaculture_pond", "expert_system_c22", "專家系統 C22（魚塭）",
               (("感測器主機", "sensor_host"), ("微氣候", "microclimate"), ("魚塭", "pond"), ("設備用電", "equipment_power")), "sensor_host",
               "四個子系統共用一個時間軸；DO1/2/3、pH1/2/3、ORP1/2/3、SC1/2/3 為三組探頭，與池位的對應未確認"),
    DomainSpec("三爺宮溪", "river_water_station", "sanyegong_creek", "仁德三爺宮溪（河川水質站）", (("仁德三爺宮溪", "water_station"),), "water_station",
               "太陽能供電站；含電池與太陽能電壓/電流（設備電源）"),
    DomainSpec("工地微氣候", "construction_microclimate", "construction_site_cb13505", "工地微氣候 CB13505", (("CB13505", "microclimate_station"),), "microclimate_station",
               "檔案前 2 行有說明列（HH、HI 代碼，意義未說明）；欄位含熱指數與危害等級（廠商定義未確認）"),
    DomainSpec("東北角", "air_quality_microclimate", "northeast_corner", "東北角", (("東北角", "air_station"),), "air_station",
               "室內或室外未說明"),
    DomainSpec("育成一厰", "air_quality_microclimate", "rearing_plant_1", "育成一廠（檔名為「厰」、欄位前綴為「廠」）", (("育成一廠", "air_station"),), "air_station",
               "檔名與欄位前綴用字不同；視為同一場域"),
    DomainSpec("育成北側", "air_quality_microclimate", "rearing_plant_1_north", "育成一廠北側", (("育成一廠北側", "air_station"),), "air_station",
               "同時回報裝置健康欄位（訊號強度、運轉時間、開機次數、送電時間、電壓）；時間覆蓋率低"),
)}


def spec_for(stem_or_domain: str) -> DomainSpec:
    if stem_or_domain in DOMAINS:
        return DOMAINS[stem_or_domain]
    raise KeyError(f"未知的資料集／場域：{stem_or_domain!r}（已登記：{sorted(DOMAINS)}）")


def domain_ids() -> list[str]:
    return sorted({s.domain_id for s in DOMAINS.values()})


def specs_of_domain(domain_id: str) -> list[DomainSpec]:
    out = [s for s in DOMAINS.values() if s.domain_id == domain_id]
    if not out:
        raise KeyError(f"未知的 domain_id：{domain_id!r}（已登記：{domain_ids()}）")
    return out


# ------------------------------------------------------------ 資料集身分
def file_sha256(path: Path | str) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def dataset_fingerprint(spec: DomainSpec, root: Path | None = None) -> str:
    """資料集內容指紋（整份檔案位元組的 SHA-256 前 16 碼）；檔案不存在回傳 MISSING，讓依賴指紋隨之改變。"""
    p = (Path(root) / "data" / "raw" / f"{spec.dataset_stem}.csv") if root else spec.path
    return file_sha256(p)[:16] if p.is_file() else "MISSING"


def source_version(spec: DomainSpec, root: Path | None = None) -> str:
    return f"{spec.dataset_id}@{SCHEMA_VERSION}+sha256:{dataset_fingerprint(spec, root)}"


# ------------------------------------------------------------ 欄位語義（單位、型態）
def column_semantics(col: str) -> dict:
    """某欄位的單位／型態推測。不確定一律保守：unknown 單位、continuous 型態不會被自動換算。"""
    m = lookup(col)
    if m["unit"] in STATE_UNITS and m["unit"] == "狀態碼":
        kind = "state_code"
    elif is_cumulative(col):
        kind = "cumulative_counter"
    elif m["unit"] == "°" and "風向" in col:
        kind = "circular_angle"
    elif "斜率" in col:
        kind = "calibration_parameter"
    elif m["category"] == "環境指標" or "飽和度" in col:
        kind = "derived_index"
    else:
        kind = "continuous"
    return {"unit": m["unit"], "unit_status": _CONF_TO_STATUS.get(m["unit_confidence"], "unknown") if m["unit"] != "未知" else "unknown",
            "category": m["category"], "phys_min": m["phys_min"], "phys_max": m["phys_max"], "value_kind": kind, "note": m["note"]}


def raw_header_origin(path: Path | str) -> dict[str, tuple[str, str]]:
    """讀 CSV 原始表頭，回傳 {去前綴後的欄名（與 load_sensor_csv 相同規則）: (原始欄名, 前綴)}。"""
    raw = Path(path).read_bytes()
    lines = raw.decode(detect_encoding(raw)).splitlines()
    h = find_header_row(lines)
    cols = [c.strip() for c in lines[h].split(detect_delimiter(lines[h])) if c.strip() and not c.startswith("Unnamed")][2:]
    pairs = []
    for c in cols:
        pre, name = (c.split(" - ", 1) + [""])[:2] if " - " in c else ("", c)
        pairs.append((c, pre.strip(), name.strip()))
    names = [n for _, _, n in pairs]
    out = {}
    for c, pre, n in pairs:
        key = c.replace(" - ", "_") if names.count(n) > 1 else n          # 與 load_sensor_csv 的撞名處理一致
        out[key] = (c, pre)
    return out


def stream_of(spec: DomainSpec, prefix: str) -> str:
    for kw, sid in spec.streams:
        if kw in prefix:
            return sid
    return spec.default_stream


# ------------------------------------------------------------ 邏輯 Schema 展開
def to_long(df: pd.DataFrame, spec: DomainSpec, origin: dict | None = None, root: Path | None = None) -> pd.DataFrame:
    """寬表 → 長表（LONG_COLUMNS）。不改動 df、不填補缺值、不換算單位。
    quality_status：missing = NaN（0 不是缺值）；out_of_expected_range_candidate = 超出『依欄名推測的物理範圍』——只是候選，不是故障判定。"""
    origin = origin if origin is not None else (raw_header_origin(spec.path) if spec.path.is_file() else {})
    ver, dsid = source_version(spec, root), spec.dataset_id
    ts = pd.to_datetime(df["timestamp"])
    frames = []
    for col in [c for c in df.columns if c != "timestamp"]:
        sem = column_semantics(col)
        pre = origin.get(col, ("", ""))[1]
        v = pd.to_numeric(df[col], errors="coerce").astype(float)
        q = np.where(v.isna(), "missing", "ok").astype(object)
        lo, hi = sem["phys_min"], sem["phys_max"]
        if lo is not None and hi is not None and sem["value_kind"] != "state_code":
            q[(~v.isna()) & ((v < lo) | (v > hi)).to_numpy()] = "out_of_expected_range_candidate"
        frames.append(pd.DataFrame({
            "domain_id": spec.domain_id, "site_id": spec.site_id, "stream_id": stream_of(spec, pre),
            "sensor_id": f"{spec.site_id}/{col}", "timestamp": ts, "measurement_name": col, "measurement_value": v,
            "measurement_unit": sem["unit"], "unit_status": sem["unit_status"], "value_kind": sem["value_kind"],
            "quality_status": q, "source_dataset_id": dsid, "source_version": ver}))
    return pd.concat(frames, ignore_index=True)[LONG_COLUMNS] if frames else pd.DataFrame(columns=LONG_COLUMNS)


def validate_long(long_df: pd.DataFrame) -> list[str]:
    """Schema 驗證：欄位齊全、列舉值合法、(sensor_id, timestamp) 不重複、單位未知時不得標成高可信。回傳問題清單（空 = 通過）。"""
    problems = []
    miss = [c for c in LONG_COLUMNS if c not in long_df.columns]
    if miss:
        return [f"缺少欄位：{miss}"]
    if (~long_df["unit_status"].isin(UNIT_STATUS)).any():
        problems.append("unit_status 含未定義的值")
    if (~long_df["value_kind"].isin(VALUE_KINDS)).any():
        problems.append("value_kind 含未定義的值")
    if (~long_df["quality_status"].isin(QUALITY_STATUS)).any():
        problems.append("quality_status 含未定義的值")
    if long_df.duplicated(["sensor_id", "timestamp"]).any():
        problems.append("同一感測器同一時間有重複觀測")
    if ((long_df["measurement_unit"] == "未知") & (long_df["unit_status"] != "unknown")).any():
        problems.append("單位為『未知』卻標成已推測")
    if (long_df["measurement_value"].isna() & (long_df["quality_status"] != "missing")).any():
        problems.append("NaN 值未標為 missing")
    return problems


def load_domain(stem: str, root: Path | None = None) -> tuple[pd.DataFrame, dict]:
    """讀取登記的資料集（寬表）。root 供測試用的複製目錄。"""
    spec = spec_for(stem)
    p = (Path(root) / "data" / "raw" / f"{stem}.csv") if root else spec.path
    df, meta = load_sensor_csv(p)
    return df.sort_values("timestamp").reset_index(drop=True), meta
