"""
traceability.py — Phase 4.1：設定雜湊、警報事件識別、可靠度代碼語義（集中管理；不影響任何預測／風險／警報決策）

三件事
  1. Canonical Config Hash（config_hash_version = "canonical-v1"）
       對『解析後、合併後的設定內容』做穩定序列化再 SHA-256：與 YAML 註解／空白／鍵順序／整數或小數表示（84 vs 84.0）無關。
       Phase 3 留下兩種舊算法（都保留可讀、不覆寫舊資料）：
         file_bytes_v0     sha256(設定檔原始位元組)[:16]                  → App / demo 回放 / action_log 使用
         json_sort_keys_v0 sha256(json.dumps(raw, sort_keys=True))[:16]  → strict 回放 CSV（經 with_threshold(84.0)，門檻為 float）
       舊值只有在『用目前設定內容重算能重現該舊值』時才承認它對應到某個 canonical 值；無法重現者一律視為 unknown，不可信。
  2. Stable Alert Event ID：由警報『啟動時間』（啟動當下即已知，不含任何未來資訊）、場域、警報串流、設定雜湊決定。
       只有在警報狀態機的歷史來源完整（由嚴格回放起點冷啟動）時才宣稱 established；否則明確標示 not_established。
  3. 可靠度代碼語義：把「沒有異常」「未檢查」「檢查失敗」「有異常代碼」「舊資料無法判斷」分開，不再靠空字串／NaN 猜。
"""
from __future__ import annotations

import copy
import hashlib
import json
import math
from typing import Iterable

CONFIG_HASH_VERSION = "canonical-v1"
CONFIG_HASH_LEN = 16
LEGACY_FILE_BYTES = "file_bytes_v0"
LEGACY_JSON_SORT_KEYS = "json_sort_keys_v0"
LEGACY_ALGORITHMS = (LEGACY_FILE_BYTES, LEGACY_JSON_SORT_KEYS)


# ============================================================ 1. Config hash
def _normalize(o):
    """穩定化：dict 以字串鍵排序（序列化時）、tuple→list、整數值的 float → int（84.0 ≡ 84）；NaN/Inf 拒絕。"""
    if isinstance(o, bool) or o is None or isinstance(o, str):
        return o
    if isinstance(o, int):
        return int(o)
    if isinstance(o, float):
        if not math.isfinite(o):
            raise ValueError("設定內容不可含 NaN / Inf")
        return int(o) if o.is_integer() else o
    if isinstance(o, dict):
        if any(not isinstance(k, str) for k in o):
            raise ValueError("設定的鍵必須是字串")
        return {k: _normalize(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_normalize(v) for v in o]
    raise TypeError(f"設定含不支援的型別：{type(o).__name__}")


def canonical_config_json(config: dict) -> str:
    """Canonical JSON：UTF-8、鍵排序、無多餘空白（分隔符 ',' ':'）、ensure_ascii=False、allow_nan=False。"""
    return json.dumps(_normalize(config), sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def compute_config_sha256(config: dict) -> str:
    """Canonical Config Hash（canonical-v1）：sha256(canonical_json.encode('utf-8')) 的前 16 個十六進位字元。"""
    return hashlib.sha256(canonical_config_json(config).encode("utf-8")).hexdigest()[:CONFIG_HASH_LEN]


def legacy_file_bytes_sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:CONFIG_HASH_LEN]


def legacy_json_sort_keys_sha256(raw: dict) -> str:
    """Phase 3 risk_policy.with_threshold 當時的算法（逐字保留，只用於辨識舊資料）。"""
    return hashlib.sha256(json.dumps(raw, sort_keys=True).encode()).hexdigest()[:CONFIG_HASH_LEN]


def _json_legacy_variants(raw: dict) -> list[dict]:
    """舊算法當時實際雜湊的內容變體：設定原樣，以及 with_threshold(T) 把門檻改成 float 的版本。"""
    out = [raw]
    t = (raw.get("risk") or {}).get("threshold")
    if isinstance(t, (int, float)) and not isinstance(t, bool):
        r = copy.deepcopy(raw)
        r["risk"]["threshold"] = float(t)
        out.append(r)
    return out


def identify_legacy_config_hash(value: str, raw: dict, file_sha256_legacy: str | None = None) -> dict:
    """辨識一個舊版 config_sha256。只有『用目前設定內容重算可重現』才承認；回傳可驗證的對應：
       {"status": "verified_legacy"|"canonical"|"unknown", "algorithm", "canonical", "evidence"}"""
    v = str(value).strip().lower()
    canon = compute_config_sha256(raw)
    if v == canon:
        return {"status": "canonical", "algorithm": CONFIG_HASH_VERSION, "canonical": canon, "evidence": "recomputed canonical hash equals value"}
    if file_sha256_legacy and v == file_sha256_legacy:
        return {"status": "verified_legacy", "algorithm": LEGACY_FILE_BYTES, "canonical": canon,
                "evidence": "sha256(current policy file bytes)[:16] reproduces the value; file content parses to the config whose canonical hash is given"}
    for i, var in enumerate(_json_legacy_variants(raw)):
        if v == legacy_json_sort_keys_sha256(var):
            return {"status": "verified_legacy", "algorithm": LEGACY_JSON_SORT_KEYS, "canonical": canon,
                    "evidence": "json.dumps(raw, sort_keys=True) reproduces the value" + ("" if i == 0 else " (threshold coerced to float, as with_threshold() did)")}
    return {"status": "unknown", "algorithm": None, "canonical": None,
            "evidence": "value cannot be reproduced from the current policy content: either a different policy version or an unknown algorithm; NOT trusted"}


# ============================================================ 2. Stable alert event id
STREAM_HIGH_THI = "high_thi"
EVENT_STATUS = ("established", "left_censored", "not_established_partial_history", "not_established_demonstration", "no_active_alert", "not_advanced")


def stable_alert_event_id(site: str, stream: str, config_sha256: str, onset_time) -> str:
    """穩定警報事件 ID：只由（場域、串流、設定 canonical 雜湊、警報啟動時間）決定。
    不含執行次數、列順序、隨機值、結束時間或任何未來資訊。形式：AEV-<site>-<啟動時間>-<8 碼雜湊>。"""
    import pandas as pd
    t = pd.Timestamp(onset_time)
    basis = f"{site}|{stream}|{config_sha256}|{t:%Y-%m-%dT%H:%M:%S}"
    return f"AEV-{site}-{t:%Y%m%dT%H%M}-{hashlib.sha256(basis.encode('utf-8')).hexdigest()[:8]}"


# ============================================================ 3. Reliability codes
R_CLEAN, R_FINDINGS, R_NOT_CHECKED, R_FAILED, R_UNKNOWN = "checked_clean", "checked_findings", "not_checked", "check_failed", "unknown_legacy"
RELIABILITY_STATES = (R_CLEAN, R_FINDINGS, R_NOT_CHECKED, R_FAILED, R_UNKNOWN)
_STATUS_THAT_RAN_CHECK = ("reliable", "warning", "unreliable")
_NA = (None, "", "nan", "NaN", "None")


def _is_na(x) -> bool:
    if x is None:
        return True
    if isinstance(x, float) and math.isnan(x):
        return True
    try:
        import pandas as pd
        if x is pd.NA:
            return True
    except ImportError:                                    # pragma: no cover
        pass
    return isinstance(x, str) and x.strip() in ("", "nan", "NaN", "None", "<NA>")


def serialize_reliability_codes(codes: Iterable[str]) -> str:
    """寫入 CSV 的格式：代碼以 '|' 連接，保留原順序；沒有代碼 → ''（是否『已檢查』由 reliability_check_state 另外記錄，不再靠這個空字串）。"""
    return "|".join(str(c) for c in codes)


def deserialize_reliability_codes(raw) -> tuple[str, ...]:
    """CSV/None/NaN/''/list → 代碼 tuple（空 → ()）。注意：這只還原『代碼集合』，不回答『有沒有檢查過』。"""
    if _is_na(raw):
        return ()
    if isinstance(raw, (list, tuple, set)):
        return tuple(str(c) for c in raw)
    return tuple(c for c in str(raw).split("|") if c)


def reliability_check_state(decision_status: str | None, sensor_reliability: str | None, codes: Iterable[str]) -> str:
    """新紀錄的明確語義（由決策本身判斷，不靠猜）。"""
    codes = tuple(codes)
    if decision_status == "error":
        return R_FAILED
    if sensor_reliability in _STATUS_THAT_RAN_CHECK or decision_status == "refused_input":
        return R_FINDINGS if codes else R_CLEAN
    return R_NOT_CHECKED                                   # skipped_no_eligible_model 等：根本沒有執行可靠度檢查


def normalize_reliability(raw_codes, decision_status=None, sensor_reliability=None, check_state=None) -> dict:
    """舊資料／新資料共用的正規化。回傳 {"state", "codes"(排序後 tuple), "basis"}。
    - 有明確 check_state → 直接採用（新格式）。
    - 沒有：有代碼 → checked_findings（代碼本身就是『檢查過且有發現』的證據）。
    - 沒有代碼且 status/reliability 明確表示檢查已執行 → checked_clean；表示根本沒檢查 → not_checked；
      其餘（欄位也不可得）→ unknown_legacy。**不會**把未知或錯誤默默當成「沒有異常」。"""
    codes = tuple(sorted(set(deserialize_reliability_codes(raw_codes))))
    if check_state is not None and not _is_na(check_state):
        if check_state not in RELIABILITY_STATES:
            return {"state": R_UNKNOWN, "codes": codes, "basis": f"unrecognized check_state {check_state!r}"}
        return {"state": check_state, "codes": codes, "basis": "explicit"}
    if codes:
        return {"state": R_FINDINGS, "codes": codes, "basis": "codes present"}
    st = None if _is_na(decision_status) else str(decision_status)
    sr = None if _is_na(sensor_reliability) else str(sensor_reliability)
    if st == "error":
        return {"state": R_FAILED, "codes": (), "basis": "decision status=error"}
    if sr in _STATUS_THAT_RAN_CHECK or st == "refused_input":
        return {"state": R_CLEAN, "codes": (), "basis": f"sensor_reliability={sr}, status={st}, no codes"}
    if st in ("skipped_no_eligible_model",):
        return {"state": R_NOT_CHECKED, "codes": (), "basis": f"status={st}"}
    return {"state": R_UNKNOWN, "codes": (), "basis": "no codes and no status/reliability to interpret"}


def read_csv_preserving_empty(path, **kw):
    """讀 Phase 3 風格 CSV，但字串欄位（reliability_codes / reason_codes / action_codes）用 converter 原樣讀入：
    空字串維持 ''，不會被 pandas 預設悄悄轉成 NaN（那會讓『沒有代碼』與『資料缺失』混在一起）。其餘欄位照 pandas 預設。"""
    import pandas as pd
    enc = kw.pop("encoding", "utf-8-sig")
    head = pd.read_csv(path, nrows=0, encoding=enc).columns
    conv = {c: (lambda v: v) for c in ("reliability_codes", "reason_codes", "action_codes") if c in head}
    return pd.read_csv(path, converters=conv, encoding=enc, **kw)
