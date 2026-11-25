"""
load_data.py — 讀取 JNC 企業感測器 CSV 的通用工具

為什麼需要這個檔案？
  企業匯出的 CSV 不是標準 UTF-8 / 逗號分隔：
  - 編碼：UTF-16（檔案開頭有 BOM：FF FE）
  - 分隔：Tab（\t）
  - 部分檔案（工地微氣候）在真正表頭前多了幾行說明
  - 時間拆成「日期」+「小時」兩欄，且格式不一致（2026/1/1 vs 2026/06/01）
  所以 pd.read_csv("xxx.csv") 直接讀會變成亂碼或只有一欄。
"""
import io
from pathlib import Path

import pandas as pd


def detect_encoding(raw: bytes) -> str:
    """依檔案開頭的 BOM（Byte Order Mark）判斷編碼。"""
    if raw[:2] in (b"\xff\xfe", b"\xfe\xff"):
        return "utf-16"
    if raw[:3] == b"\xef\xbb\xbf":
        return "utf-8-sig"
    try:
        raw.decode("utf-8")
        return "utf-8"
    except UnicodeDecodeError:
        return "cp950"  # 繁體中文 Windows 常見編碼


def detect_delimiter(line: str) -> str:
    """看表頭那一行哪種分隔符號最多。"""
    candidates = ["\t", ",", ";"]
    return max(candidates, key=line.count)


def find_header_row(lines: list[str]) -> int:
    """找到含有「日期」的那一行，它才是真正的表頭。"""
    for i, line in enumerate(lines[:20]):
        if line.startswith("日期"):
            return i
    raise ValueError("前 20 行找不到以『日期』開頭的表頭")


def load_sensor_csv(path: str | Path) -> tuple[pd.DataFrame, dict]:
    """
    讀取一份感測器 CSV，回傳 (DataFrame, 讀取資訊 meta)。
    DataFrame 的 index 是 timestamp（每小時一筆），欄位名稱已去掉場域前綴。
    """
    path = Path(path)
    raw = path.read_bytes()
    enc = detect_encoding(raw)
    text = raw.decode(enc)
    lines = text.splitlines()
    header_idx = find_header_row(lines)
    sep = detect_delimiter(lines[header_idx])

    df = pd.read_csv(
        io.StringIO("\n".join(lines[header_idx:])),
        sep=sep,
        dtype=str,  # 先全部當字串讀，之後再自己轉數字，才能發現奇怪的值
    )

    # 移除完全空白的欄位（有些檔案每行結尾多一個 Tab）
    df = df.loc[:, [c for c in df.columns if not str(c).startswith("Unnamed")]]

    # 欄名「仁德三爺宮溪 - pH」→ 前綴 site_prefix="仁德三爺宮溪"、欄名="pH"
    rename, prefixes = {}, set()
    for c in df.columns[2:]:
        if " - " in c:
            pre, name = c.split(" - ", 1)
            prefixes.add(pre.strip())
            rename[c] = name.strip()
    # 若同一檔案有多個子系統（例如專家系統有 感測器主機 / 微氣候 / 電力）
    # 去前綴後可能撞名，撞名時保留子系統名稱
    names = list(rename.values())
    dup = {n for n in names if names.count(n) > 1}
    for c in list(rename):
        if rename[c] in dup:
            rename[c] = c.replace(" - ", "_")
    df = df.rename(columns=rename)

    # 日期 + 小時 → timestamp
    ts = pd.to_datetime(df["日期"].str.strip(), format="mixed") + pd.to_timedelta(
        df["小時"].astype(int), unit="h"
    )
    df = df.drop(columns=["日期", "小時"])
    df.insert(0, "timestamp", ts)

    # 文字 → 數字。空字串會變成 NaN（缺值）；無法轉的文字也會變成 NaN 並被記錄
    bad_text = {}
    for c in df.columns[1:]:
        s = df[c].str.strip()
        num = pd.to_numeric(s, errors="coerce")
        n_bad = int((s.notna() & (s != "") & num.isna()).sum())
        if n_bad:
            bad_text[c] = n_bad
        df[c] = num

    meta = {
        "file": path.name,
        "encoding": enc,
        "delimiter": "TAB" if sep == "\t" else sep,
        "header_row(0-based)": header_idx,
        "skipped_preamble": " | ".join(l.replace("\t", " ").strip() for l in lines[:header_idx]),
        "column_prefixes": " / ".join(sorted(prefixes)),
        "non_numeric_cells": bad_text,
    }
    return df, meta


if __name__ == "__main__":
    # 直接執行這個檔案時，示範讀取所有 CSV
    raw_dir = Path(__file__).resolve().parent.parent / "data" / "raw"
    for f in sorted(raw_dir.glob("*.csv")):
        d, m = load_sensor_csv(f)
        print(f"{f.name:12s} rows={len(d):5d} cols={d.shape[1]-1:3d} "
              f"{d.timestamp.min()} → {d.timestamp.max()}  enc={m['encoding']}")
