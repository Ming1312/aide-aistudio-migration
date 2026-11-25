"""
p52_data.py — Phase 5.2：專家系統 DO／CPM 資料載入、時間格點、資料品質狀態（Level 1）

* 資料一律由原始 CSV 讀取（不硬編碼 Phase 5.1 的數字），不改動原始檔。
* 開發階段（stage='dev'）的載入函式**物理上拿不到** holdout 資料：回傳的資料在 holdout 起點之前截斷。
  只有 stage='final'（需要 Manifest 與選擇結果存在，並寫入 holdout 帳本）與 stage='service'（凍結之後的歷史回放，只含 as_of 以前）能看到更晚的資料。
* 所有『當下狀態』的欄位都是因果的：第 t 小時的值只由 ≤ t 的資料決定。
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))

import domain_schema as DS  # noqa: E402
import p52_config as C  # noqa: E402

ROOT = C.ROOT


class HoldoutAccessError(RuntimeError):
    pass


def load_raw(stem: str = C.DATASET_STEM, root: Path | str | None = None) -> pd.DataFrame:
    df, _ = DS.load_domain(stem, Path(root) if root else None)
    return df.drop_duplicates("timestamp", keep="first").reset_index(drop=True)


def hourly_frame(stage: str = "dev", as_of=None, root: Path | str | None = None, raw: pd.DataFrame | None = None, stem: str = C.DATASET_STEM) -> pd.DataFrame:
    """完整每小時格點（缺的整點為 NaN），欄位 present = 該時間戳記在 CSV 中真的存在。
    stage: 'dev'（<holdout 起點）｜'final'（全部；呼叫端負責帳本）｜'service'（≤ as_of）。"""
    if stage not in ("dev", "final", "service"):
        raise ValueError(f"未知 stage {stage!r}")
    raw = load_raw(stem, root) if raw is None else raw
    raw = raw[raw.timestamp >= C.T_TRAIN_START] if stem == C.DATASET_STEM else raw
    if stage == "dev":
        raw = raw[raw.timestamp < C.T_HOLDOUT_START]
    elif stage == "service":
        if as_of is None:
            raise ValueError("service 階段必須指定 as_of")
        raw = raw[raw.timestamp <= pd.Timestamp(as_of)]
    if raw.empty:
        raise ValueError("沒有可用資料")
    raw = raw.drop_duplicates("timestamp", keep="first")                       # 重複時間戳記：保留第一筆（不平均、不猜）
    on_grid = raw["timestamp"] == raw["timestamp"].dt.floor("h")
    n_off = int((~on_grid).sum())
    x = raw[on_grid].set_index("timestamp")                                    # 不在整點上的列不對齊到格點（視為該小時缺值），並記錄筆數
    grid = pd.date_range(x.index.min(), x.index.max(), freq="h")
    out = x.reindex(grid)
    out.attrs["off_grid_rows_dropped"] = n_off
    out["present"] = pd.Series(True, index=x.index).reindex(grid).fillna(False).astype(bool)
    out.index.name = "timestamp"
    return out


def run_length(b: pd.Series) -> pd.Series:
    """連續 True 的『到目前為止』長度（因果；False 時為 0）。"""
    b = b.fillna(False).astype(bool)
    return b.groupby((~b).cumsum()).cumsum().astype(int)


def prepare_channel(frame: pd.DataFrame, channel: str, rules: dict | None = None) -> pd.DataFrame:
    """單一 DO 通道的因果品質狀態。y_clean = 只保留可用於統計的值（缺值、DO=0、負值、超出物理上限的值一律遮蔽為 NaN，不插補）。"""
    R = rules or C.RULES
    y = frame[channel].astype(float)
    present = frame["present"]
    cross = [c for c in C.CROSS_CHECK_COLS if c in frame.columns]
    allzero = ((frame[cross] == 0).all(axis=1) & frame[cross].notna().all(axis=1)) if len(cross) >= 2 else pd.Series(False, index=frame.index)   # 少於 2 個交叉欄位（例如其他場域）→ 不做『全通道為 0』判斷
    missing = y.isna()
    zero = (y == 0)
    invalid = ((y < R["do_physical_min"]["value"]) | (y > R["do_physical_max"]["value"])) & y.notna()
    usable = y.notna() & ~zero & ~invalid
    y_clean = y.where(usable)
    gap_run = run_length(missing)
    zero_run = run_length(zero)
    grp = (y != y.shift()).cumsum()
    flat_len = (y.groupby(grp).cumcount() + 1).where(y.notna() & ~zero, 0)
    d1_valid = y_clean.notna() & y_clean.shift().notna()
    out = pd.DataFrame({"y": y, "y_clean": y_clean, "present": present, "missing": missing, "zero": zero, "invalid": invalid, "allzero_row": allzero,
                        "gap_run": gap_run, "zero_run": zero_run, "flat_len": flat_len, "d1_valid": d1_valid, "usable": usable}, index=frame.index)
    # 片段：長缺口（y_clean 連續 NaN ≥ reset 小時）之後開始新片段；seg_age = 片段內累計有效小時數
    nan_run = run_length(y_clean.isna())
    new_seg = (y_clean.notna() & (nan_run.shift(fill_value=0) >= C.SEGMENT_RESET_GAP_HOURS))
    new_seg.iloc[0] = True
    out["segment"] = new_seg.cumsum()
    out["seg_age"] = y_clean.notna().groupby(out["segment"]).cumsum().astype(int)
    for extra in (C.CONTEXT_COL, C.WATER_TEMP):
        if extra in frame.columns:
            out[extra] = frame[extra]
    return out


def context_clean(frame: pd.DataFrame) -> pd.Series:
    """CPM 電流：缺值與『全通道同時為 0 的列』遮蔽為 NaN（那是系統級的 0，不是低負載）。"""
    cross = [c for c in C.CROSS_CHECK_COLS if c in frame.columns]
    allzero = ((frame[cross] == 0).all(axis=1) & frame[cross].notna().all(axis=1)) if len(cross) >= 2 else pd.Series(False, index=frame.index)
    return frame[C.CONTEXT_COL].astype(float).where(~allzero)


def split_masks(index: pd.DatetimeIndex) -> dict:
    out = {}
    for k, (a, b) in C.SPLITS.items():
        out[k] = pd.Series((index >= a) & (True if b is None else (index < b)), index=index)
    return out


# ============================================================ 資料稽核（Step 1）
def data_audit(frame: pd.DataFrame, stage_label: str) -> pd.DataFrame:
    """由原始資料重新計算的稽核表（每個 DO 通道＋CPM）。不使用 Phase 5.1 的硬編碼數字。"""
    rows = []
    for ch in (*C.CHANNELS, C.CONTEXT_COL, C.WATER_TEMP):
        s = frame[ch].astype(float)
        pc = prepare_channel(frame, ch) if ch in C.CHANNELS else None
        nan_runs = run_length(s.isna())
        ends = nan_runs[(nan_runs > 0) & (nan_runs.shift(-1, fill_value=0) == 0)]
        v = s.dropna()
        rows.append({
            "stage": stage_label, "column": ch, "range_start": frame.index.min(), "range_end": frame.index.max(), "grid_hours": len(frame),
            "rows_present": int(frame["present"].sum()), "timestamp_coverage_pct": round(100 * frame["present"].mean(), 2),
            "n_missing_hours": int(s.isna().sum()), "n_gaps_ge_reset": int((ends >= C.SEGMENT_RESET_GAP_HOURS).sum()), "longest_gap_h": int(ends.max()) if len(ends) else 0,
            "n_zero": int((v == 0).sum()), "n_negative": int((v < 0).sum()), "n_above_physical_max": int((v > C.RULES["do_physical_max"]["value"]).sum()),
            "n_allchannel_zero_rows": int(prepare_channel(frame, C.CHANNELS[0])["allzero_row"].sum()),
            "longest_zero_run_h": int(pc["zero_run"].max()) if pc is not None else None, "longest_nonzero_flat_run_h": int(pc["flat_len"].max()) if pc is not None else None,
            "mean": float(v.mean()) if len(v) else np.nan, "std": float(v.std()) if len(v) > 1 else np.nan, "median": float(v.median()) if len(v) else np.nan,
            "min": float(v.min()) if len(v) else np.nan, "max": float(v.max()) if len(v) else np.nan,
            "unit_status": DS.column_semantics(ch)["unit_status"], "unit_inferred": DS.column_semantics(ch)["unit"], "timezone": "none(naive)",
            "note": "單位為推測、未經 JNC 確認；時間戳記無時區"})
    return pd.DataFrame(rows)
