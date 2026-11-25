"""
p586_store.py — Phase 5.8.6：追加式、可稽核、可復原的資料版本庫（依 outputs/phase5_8_5/continuous_data_spec.md）

不變式
  * data/raw/*.csv 永遠唯讀：版本庫只存『追加的列』；『目前資料』＝ 原始資料（唯讀載入）＋ 版本庫某一版的追加列。
  * 匯入＝ stage（隔離＋驗證＋合併預覽）→ commit（核准後才寫入）。任何 BLOCK 或失敗都不會改變 current。
  * 版本只增不減；回復 ＝ 把 current 指回舊版本（寫稽核紀錄），不刪任何版本。
  * 提交是兩步驟的原子操作（暫存目錄→改名→manifest 追加＝提交點→current 指標），中途當機由 recover() 前滾或回滾，
    不會留下半個版本；manifest 與稽核日誌各自有雜湊鏈，竄改會被 verify() 抓到，載入時 fail closed。
  * 來源明確標示：每一列都記錄 _source（synthetic / unverified_import）、_batch_id、_version。
  * 這個模組不讀、不引用情境真值（data/synthetic_truth）。
"""
from __future__ import annotations

import contextlib
import hashlib
import io
import json
import os
import re
import time
from pathlib import Path

import numpy as np
import pandas as pd

import domain_schema as DS
from load_data import detect_delimiter, detect_encoding, find_header_row

ROOT = Path(__file__).resolve().parent.parent
STORE_ROOT = ROOT / "data" / "synthetic_store"
STORE_VERSION = "p586-store-v1"
MAX_BYTES = 20 * 1024 * 1024
MAX_ROWS = 200_000
LOCK_STALE_S = 900
LOCK_UNREADABLE_S = 5.0     # 讀不出內容的鎖檔，超過這個秒數才視為殘留
META_COLS = ("_batch_id", "_source", "_version")
SOURCES = ("synthetic", "unverified_import")
POLICIES = (None, "keep_existing", "prefer_new", "reject")
SYNTH_MARK = "SYNTHETIC"


def default_root() -> Path:
    """版本庫根目錄：預設 data/synthetic_store；測試或隔離執行可用環境變數 P586_STORE_ROOT 改到別處（網頁程式碼不直接讀環境變數）。"""
    if os.environ.get("P586_STORE_ROOT"):
        return Path(os.environ["P586_STORE_ROOT"])
    if os.environ.get("AIDE_DATA_DIR"):                              # Phase 5.9：單一持久化資料夾（雲端掛載的 persistent volume）
        return Path(os.environ["AIDE_DATA_DIR"]) / "store"
    return STORE_ROOT


class StoreError(Exception):
    pass


class StoreCorrupt(StoreError):
    pass


class StoreBusy(StoreError):
    pass


class SimulatedCrash(Exception):
    """測試用：模擬在指定位置斷電。"""


FAULT = {"point": None}


def _fault(point: str):
    if FAULT["point"] == point:
        raise SimulatedCrash(point)


# ============================================================ 檔案工具
def _fsync_dir(p: Path):
    with contextlib.suppress(OSError):
        fd = os.open(str(p), os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def _atomic_write(path: Path, data: bytes):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp{os.getpid()}")
    with open(tmp, "wb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)
    _fsync_dir(path.parent)


def _sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def _jd(o) -> bytes:
    return json.dumps(o, ensure_ascii=False, sort_keys=True, indent=1, default=str).encode("utf-8")


# ============================================================ 解析（V1–V3、V6）
def _finding(rule, sev, msg, count=None, examples=None) -> dict:
    d = {"rule": rule, "severity": sev, "message": msg}
    if count is not None:
        d["count"] = int(count)
    if examples:
        d["examples"] = [str(e) for e in examples[:5]]
    return d


def parse_upload(raw: bytes, stem: str) -> tuple[pd.DataFrame | None, dict, list]:
    """把上傳位元組解析成寬表（timestamp＋登記欄位）。回傳 (df|None, info, findings)。不寫任何檔案。"""
    F: list[dict] = []
    info: dict = {"bytes": len(raw), "sha256": _sha(raw)}
    if len(raw) == 0:
        return None, info, [_finding("V1", "BLOCK", "檔案是空的")]
    if len(raw) > MAX_BYTES:
        return None, info, [_finding("V1", "BLOCK", f"檔案超過大小上限 {MAX_BYTES // 1024 // 1024} MB")]
    enc = detect_encoding(raw)
    if enc != "utf-16" and b"\x00" in raw[:4096]:
        return None, info, [_finding("V1", "BLOCK", "含二進位內容（NUL 位元組），不是文字 CSV")]
    try:
        text = raw.decode(enc)
    except Exception as e:                                             # noqa: BLE001
        return None, info, [_finding("V1", "BLOCK", f"無法以 {enc} 解碼：{type(e).__name__}")]
    info["encoding"] = enc
    lines = text.splitlines()
    if len(lines) > MAX_ROWS + 25:
        return None, info, [_finding("V1", "BLOCK", f"列數超過上限 {MAX_ROWS}")]
    try:
        h = find_header_row(lines)
    except ValueError as e:
        return None, info, [_finding("V2", "BLOCK", str(e))]
    info["preamble"] = " | ".join(l.replace("\t", " ").strip() for l in lines[:h])
    info["synthetic_marker"] = any(l.startswith(SYNTH_MARK) for l in lines[:h])
    m = re.search(r"batch_id=([^\s\t]+)", info["preamble"])
    info["marker_batch_id"] = m.group(1) if m else None
    sep = detect_delimiter(lines[h])
    try:
        df = pd.read_csv(io.StringIO("\n".join(lines[h:])), sep=sep, dtype=str, keep_default_na=False)
    except Exception as e:                                             # noqa: BLE001
        return None, info, [_finding("V1", "BLOCK", f"CSV 結構無法解析：{type(e).__name__}")]
    df = df.loc[:, [c for c in df.columns if not str(c).startswith("Unnamed") and str(c).strip() != ""]]
    if "日期" not in df.columns or "小時" not in df.columns:
        return None, info, [_finding("V2", "BLOCK", "缺少『日期』或『小時』欄")]
    # --- V2：欄位集合（去前綴後）與登記一致
    reg = list(DS.raw_header_origin(DS.spec_for(stem).path).keys())
    rename, prefixes = {}, []
    for c in df.columns[2:]:
        rename[c] = c.split(" - ", 1)[1].strip() if " - " in c else c.strip()
    names = list(rename.values())
    dup = {n for n in names if names.count(n) > 1}
    for c in list(rename):
        if rename[c] in dup:
            rename[c] = c.replace(" - ", "_")
    df = df.rename(columns=rename)
    got = list(df.columns[2:])
    missing = [c for c in reg if c not in got]
    extra = [c for c in got if c not in reg]
    if len(set(got)) != len(got):
        F.append(_finding("V2", "BLOCK", "欄名重複"))
    if missing:
        F.append(_finding("V2", "BLOCK", f"缺少已登記欄位（欄位更名或遺漏，不猜測）：{len(missing)} 欄", len(missing), missing))
    if extra:
        F.append(_finding("V2", "WARN", f"有 {len(extra)} 個未登記的新欄位：不會被匯入（新增感測器需要先分類）", len(extra), extra))
    if missing:
        return None, info, F
    # --- V3：日期＋小時
    dt = pd.to_datetime(df["日期"].str.strip(), format="mixed", errors="coerce")
    hr = pd.to_numeric(df["小時"].str.strip(), errors="coerce")
    bad_date = dt.isna()
    bad_hour = hr.isna() | (hr < 0) | (hr > 23) | (hr != np.floor(hr.fillna(0)))
    if bad_date.any() or bad_hour.any():
        ex = [f"第{i + 1}列 日期={df['日期'].iloc[i]!r} 小時={df['小時'].iloc[i]!r}" for i in np.where((bad_date | bad_hour).to_numpy())[0]]
        F.append(_finding("V3", "BLOCK", "日期或小時無法解析，或小時不在 0–23", int((bad_date | bad_hour).sum()), ex))
        return None, info, F
    ts = dt + pd.to_timedelta(hr.astype(int), unit="h")
    # --- V6：數值型別
    num = {}
    bad_cells = []
    nonfinite = 0
    for c in reg:
        s = df[c].str.strip()
        v = pd.to_numeric(s, errors="coerce")
        bad = (s != "") & v.isna()
        if bad.any():
            bad_cells += [f"{c}@第{i + 1}列={s.iloc[i]!r}" for i in np.where(bad.to_numpy())[0][:3]]
        nonfinite += int(np.isinf(v.to_numpy(float)).sum())
        num[c] = v
    if bad_cells or nonfinite:
        F.append(_finding("V6", "BLOCK", "數值欄含非數值文字或無限值", len(bad_cells) + nonfinite, bad_cells))
        return None, info, F
    out = pd.DataFrame({"timestamp": ts, **num})
    info["rows_in_file"] = int(len(out))
    info["columns"] = reg
    info["extra_columns"] = extra
    info["raw_text_for_pii"] = text
    return out, info, F


_PII = {
    "email": re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"),
    "tw_mobile": re.compile(r"(?<!\d)(?:\+?886[- ]?|0)9\d{2}[- ]?\d{3}[- ]?\d{3}(?!\d)"),
    "tw_national_id": re.compile(r"(?<![A-Za-z0-9])[A-Z][12]\d{8}(?![0-9])"),
    "ipv4": re.compile(r"(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])"),
    "mac": re.compile(r"(?i)\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b"),
    "url": re.compile(r"(?i)\bhttps?://\S+|\bwww\.\S+"),
}
_PII_NAMES = ("姓名", "電話", "手機", "email", "e-mail", "信箱", "地址", "住址", "身分證", "座標", "經緯度", "latitude", "longitude", "gps", "lat", "lon")


def scan_pii(text: str, columns: list[str]) -> list[dict]:
    hits = []
    for c in columns:
        lc = c.lower()
        for n in _PII_NAMES:
            if (n.isascii() and len(n) <= 3 and re.search(rf"(?<![a-z]){re.escape(n)}(?![a-z])", lc)) or ((not n.isascii() or len(n) > 3) and n in lc):
                hits.append({"kind": "column_name", "detail": c})
                break
    for k, rx in _PII.items():
        m = rx.findall(text)
        if m:
            hits.append({"kind": k, "detail": f"{len(m)} 處", "count": len(m)})
    return hits


# ============================================================ 值比較工具
def _eq(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    return (a == b) | (np.isnan(a) & np.isnan(b)) | (np.abs(a - b) <= 1e-9 + 1e-9 * np.abs(b))


def _canon_csv(df: pd.DataFrame, cols: list[str]) -> bytes:
    d = df.sort_values("timestamp").reset_index(drop=True)
    out = io.StringIO()
    out.write(",".join(["timestamp"] + [f'"{c}"' if ("," in c or '"' in c) else c for c in cols] + list(META_COLS)) + "\n")
    X = d[cols].to_numpy(float)
    for i in range(len(d)):
        cells = ["" if np.isnan(x) else format(float(x), ".10g") for x in X[i]]
        out.write(",".join([pd.Timestamp(d["timestamp"].iloc[i]).strftime("%Y-%m-%d %H:%M:%S")] + cells + [str(d[m].iloc[i]) for m in META_COLS]) + "\n")
    return out.getvalue().encode("utf-8")


def _read_canon(b: bytes, cols: list[str]) -> pd.DataFrame:
    df = pd.read_csv(io.BytesIO(b), dtype={m: str for m in META_COLS}, keep_default_na=False, na_values=[""])
    df["timestamp"] = pd.to_datetime(df["timestamp"])
    for c in cols:
        df[c] = pd.to_numeric(df[c], errors="coerce").astype(float)
    for m in META_COLS:
        df[m] = df[m].fillna("").astype(str)
    return df[["timestamp"] + cols + list(META_COLS)]


def empty_frame(cols: list[str]) -> pd.DataFrame:
    d = pd.DataFrame({"timestamp": pd.to_datetime([])})
    for c in cols:
        d[c] = pd.Series(dtype=float)
    for m in META_COLS:
        d[m] = pd.Series(dtype=str)
    return d


# ============================================================ 版本庫
class Store:
    def __init__(self, stem: str, root: Path | str | None = None, now=None):
        self.stem = DS.spec_for(stem).dataset_stem
        self.base = Path(root or default_root()) / self.stem
        self.vdir = self.base / "versions"
        self.qdir = self.base / "quarantine"
        self.base.mkdir(parents=True, exist_ok=True)
        self.vdir.mkdir(exist_ok=True)
        self.qdir.mkdir(exist_ok=True)
        self.now = pd.Timestamp(now) if now is not None else None
        self.cols = list(DS.raw_header_origin(DS.spec_for(self.stem).path).keys())
        self._real = None
        self.recovery_notes: list[str] = []
        self.recover()

    # ---- 路徑
    @property
    def manifest_path(self): return self.base / "manifest.json"
    @property
    def current_path(self): return self.base / "current.json"
    @property
    def audit_path(self): return self.base / "audit.jsonl"
    @property
    def journal_path(self): return self.base / "journal.json"
    @property
    def lock_path(self): return self.base / "lock"

    def _now(self) -> pd.Timestamp:
        return self.now if self.now is not None else pd.Timestamp.now()

    # ---- 原始資料（唯讀）
    def real(self) -> pd.DataFrame:
        if self._real is None:
            df, _ = DS.load_domain(self.stem)
            self._real = df.drop_duplicates("timestamp", keep="first").set_index("timestamp").sort_index()
        return self._real

    def real_sha16(self) -> str:
        return DS.dataset_fingerprint(DS.spec_for(self.stem))

    # ---- 鎖
    @contextlib.contextmanager
    def lock(self, timeout: float = 10.0):
        t0 = time.time()
        while True:
            try:
                fd = os.open(self.lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                os.write(fd, json.dumps({"pid": os.getpid(), "t": time.time()}).encode())
                os.close(fd)
                break
            except FileExistsError:
                try:
                    info = json.loads(self.lock_path.read_text())
                    alive = _pid_alive(int(info["pid"]))
                    if (not alive) or (time.time() - float(info["t"]) > LOCK_STALE_S):
                        self.lock_path.unlink(missing_ok=True)
                        self._audit("lock_stolen", {"stale_pid": info.get("pid")}, locked=True)
                        continue
                except (ValueError, OSError, KeyError):
                    # 鎖檔剛被建立、持有者還沒寫入內容（O_EXCL 建立與寫入之間的空窗）時，內容是空的／讀不出來：
                    # 這不是壞掉的鎖，不能刪（刪了就會有兩個程序同時持有鎖，造成同一個版本號被寫兩次）。只有放了一陣子還是讀不出來才當作殘留。
                    try:
                        age = time.time() - self.lock_path.stat().st_mtime
                    except OSError:
                        continue                                                   # 鎖已經被釋放：重新嘗試取得
                    if age > LOCK_UNREADABLE_S:
                        self.lock_path.unlink(missing_ok=True)
                        continue
                    if time.time() - t0 > timeout:
                        raise StoreBusy("版本庫正被另一個程序使用（鎖）")
                    time.sleep(0.05)
                    continue
                if time.time() - t0 > timeout:
                    raise StoreBusy("版本庫正被另一個程序使用（鎖）")
                time.sleep(0.05)
        try:
            yield
        finally:
            self.lock_path.unlink(missing_ok=True)

    # ---- manifest / current / audit
    def manifest(self) -> dict:
        if not self.manifest_path.is_file():
            return {"store_version": STORE_VERSION, "stem": self.stem, "base_raw_sha16": self.real_sha16(), "versions": []}
        try:
            return json.loads(self.manifest_path.read_text(encoding="utf-8"))
        except ValueError as e:
            raise StoreCorrupt(f"manifest 無法解析：{e}") from e

    def current_seq(self) -> int:
        if not self.current_path.is_file():
            return 0
        try:
            return int(json.loads(self.current_path.read_text())["seq"])
        except (ValueError, KeyError) as e:
            raise StoreCorrupt("current 指標損壞") from e

    def _entry_hash(self, e: dict) -> str:
        return _sha(_jd({k: v for k, v in e.items() if k != "entry_hash"}))

    def _audit(self, action: str, detail: dict, locked: bool = False):
        prev = "0" * 16
        if self.audit_path.is_file():
            last = self.audit_path.read_text(encoding="utf-8").strip().splitlines()
            if last:
                try:
                    prev = json.loads(last[-1])["hash"]
                except (ValueError, KeyError):
                    prev = "CORRUPT"
        rec = {"t": str(self._now()), "action": action, "detail": detail, "prev": prev}
        rec["hash"] = _sha(_jd(rec))[:16]
        with open(self.audit_path, "ab") as f:
            f.write(json.dumps(rec, ensure_ascii=False, sort_keys=True, default=str).encode("utf-8") + b"\n")
            f.flush()
            os.fsync(f.fileno())

    def audit(self) -> list[dict]:
        if not self.audit_path.is_file():
            return []
        out = []
        for l in self.audit_path.read_text(encoding="utf-8").splitlines():
            with contextlib.suppress(ValueError):
                out.append(json.loads(l))
        return out

    # ---- 復原
    def recover(self):
        """啟動時呼叫：處理上次當機留下的暫存與日誌。前滾（manifest 已含新版本）或回滾（尚未提交）。"""
        if self.lock_path.is_file():
            try:
                info = json.loads(self.lock_path.read_text())
                if _pid_alive(int(info["pid"])):
                    return                                               # 另一個存活程序持有鎖：不動
                self.lock_path.unlink(missing_ok=True)
            except (OSError, ValueError, KeyError):
                self.lock_path.unlink(missing_ok=True)
        for d in list(self.vdir.glob(".tmp-*")):
            _rm_tree(d)
            self.recovery_notes.append(f"清除未完成的暫存目錄 {d.name}")
        if self.journal_path.is_file():
            try:
                j = json.loads(self.journal_path.read_text())
            except ValueError:
                j = {}
            m = self.manifest()
            seqs = {v["seq"] for v in m["versions"]}
            to = j.get("to_seq")
            if to in seqs:
                if self.current_seq() != to and j.get("kind") == "commit":
                    _atomic_write(self.current_path, _jd({"seq": to}))
                self.recovery_notes.append(f"前滾：版本 {to} 已提交，補完 current 指標")
                self._audit("recover_roll_forward", {"to_seq": to})
            else:
                d = self.vdir / f"v{int(to):04d}" if to else None
                if d is not None and d.is_dir():
                    _rm_tree(d)
                self.recovery_notes.append(f"回滾：版本 {to} 未提交，已移除未引用的目錄")
                self._audit("recover_roll_back", {"to_seq": to})
            self.journal_path.unlink(missing_ok=True)
        # 未被 manifest 引用的版本目錄（提交前當機）
        m = self.manifest()
        known = {f"v{v['seq']:04d}" for v in m["versions"]}
        for d in self.vdir.glob("v[0-9][0-9][0-9][0-9]"):
            if d.name not in known:
                _rm_tree(d)
                self.recovery_notes.append(f"移除未被 manifest 引用的孤兒目錄 {d.name}")
                self._audit("orphan_removed", {"dir": d.name})

    # ---- 讀取
    def versions(self) -> list[dict]:
        return self.manifest()["versions"]

    def version_id(self, seq: int | None = None) -> str:
        seq = self.current_seq() if seq is None else seq
        if seq == 0:
            return f"{self.stem}-v0000-{self.real_sha16()[:12]}"
        v = next(v for v in self.versions() if v["seq"] == seq)
        return v["version_id"]

    def load_rows(self, seq: int | None = None) -> pd.DataFrame:
        """版本庫某一版的追加列（含來源標記）。驗證 sha256；不符就 fail closed。"""
        seq = self.current_seq() if seq is None else int(seq)
        if seq == 0:
            return empty_frame(self.cols)
        v = next((v for v in self.versions() if v["seq"] == seq), None)
        if v is None:
            raise StoreCorrupt(f"版本 {seq} 不在 manifest 中")
        p = self.vdir / f"v{seq:04d}" / "canonical.csv"
        if not p.is_file():
            raise StoreCorrupt(f"版本 {seq} 的 canonical.csv 遺失")
        b = p.read_bytes()
        if _sha(b) != v["canonical_sha256"]:
            raise StoreCorrupt(f"版本 {seq} 的 canonical.csv 雜湊與 manifest 不符（檔案可能被改動）")
        return _read_canon(b, self.cols)

    def extended(self, seq: int | None = None) -> pd.DataFrame:
        """原始資料（唯讀）＋追加列，依時間排序；多一欄 _source（real / synthetic / unverified_import）。"""
        r = self.real().reset_index()
        r = r[["timestamp"] + self.cols].copy()
        r["_source"] = "real"
        r["_batch_id"] = ""
        r["_version"] = "v0"
        s = self.load_rows(seq)
        out = pd.concat([r, s[["timestamp"] + self.cols + ["_source", "_batch_id", "_version"]]], ignore_index=True)
        return out.sort_values("timestamp", kind="stable").reset_index(drop=True)

    def verify(self) -> dict:
        """完整性檢查。ok＝全部通過；current_ok＝『目前版本』可安全使用（manifest／雜湊鏈／目前版本的 canonical／原始資料雜湊皆完好）。
        其他（已封存）版本的檔案被改動只列入 archived_problems：不影響目前版本，但該版本不能被回復過去（rollback 會先驗證）。"""
        problems, archived = [], []
        try:
            m = self.manifest()
        except StoreCorrupt as e:
            return {"ok": False, "current_ok": False, "problems": [str(e)], "archived_problems": [], "current": None}
        try:
            cur = self.current_seq()
        except StoreCorrupt as e:
            problems.append(str(e))
            cur = None
        prev = "0" * 16
        for i, v in enumerate(m["versions"]):
            if v["seq"] != i + 1:
                problems.append(f"版本序號不連續：第 {i + 1} 筆是 {v['seq']}")
            if v.get("prev_entry_hash") != prev:
                problems.append(f"版本 {v['seq']} 的雜湊鏈中斷")
            if self._entry_hash(v) != v.get("entry_hash"):
                problems.append(f"版本 {v['seq']} 的 manifest 紀錄被改動")
            prev = v.get("entry_hash", "")
            p = self.vdir / f"v{v['seq']:04d}" / "canonical.csv"
            msg = None
            if not p.is_file():
                msg = f"版本 {v['seq']} 的 canonical.csv 遺失"
            elif _sha(p.read_bytes()) != v["canonical_sha256"]:
                msg = f"版本 {v['seq']} 的 canonical.csv 雜湊不符"
            if msg:
                (problems if v["seq"] == cur else archived).append(msg)
        if m.get("base_raw_sha16") not in (None, self.real_sha16()):
            problems.append("原始資料雜湊與建立版本庫時不同（原始檔被改動？）")
        if cur and cur not in {v["seq"] for v in m["versions"]}:
            problems.append(f"current={cur} 不在 manifest 中")
        ph = "0" * 16
        for a in self.audit():
            if a.get("prev") != ph:
                problems.append("稽核日誌的雜湊鏈中斷")
                break
            h = _sha(_jd({k: v for k, v in a.items() if k != "hash"}))[:16]
            if h != a.get("hash"):
                problems.append("稽核日誌有被改動的紀錄")
                break
            ph = a["hash"]
        return {"ok": not problems and not archived, "current_ok": not problems, "problems": problems + archived, "archived_problems": archived, "current": cur, "n_versions": len(m["versions"])}

    # ============================================================ 匯入：stage
    def stage(self, raw: bytes, filename: str, source: str, license_note: str, policy: str | None = None) -> dict:
        """隔離＋驗證＋合併預覽。不改動版本庫（只在 quarantine 留下位元組與報告）。"""
        if policy not in POLICIES:
            raise StoreError(f"未知的衝突處理方式：{policy!r}")
        safe_name = re.sub(r"[^\w.\-]", "_", Path(str(filename)).name)[:80] or "upload"
        up_sha = _sha(raw)
        upload_id = f"up-{up_sha[:12]}"
        qd = self.qdir / upload_id
        qd.mkdir(parents=True, exist_ok=True)
        _atomic_write(qd / "upload.bin", raw)
        rep = self._analyze(raw, safe_name, source, license_note, policy)
        rep.update({"upload_id": upload_id, "filename": safe_name, "upload_sha256": up_sha, "policy": policy, "staged_at": str(self._now())})
        _atomic_write(qd / "report.json", _jd({k: v for k, v in rep.items() if k not in ("_delta", "_new_store")}))
        self._audit("stage", {"upload_id": upload_id, "status": rep["status"], "blocks": rep["n_block"], "rows_new": rep["counts"].get("rows_new", 0)})
        return {k: v for k, v in rep.items() if not k.startswith("_")}

    def _analyze(self, raw: bytes, filename: str, source: str, license_note: str, policy: str | None) -> dict:
        import p586_plausibility as PL
        F: list[dict] = []
        df, info, pf = parse_upload(raw, self.stem)
        F += pf
        counts: dict = {"rows_in_file": info.get("rows_in_file", 0)}
        # V11：來源與授權聲明、合成標記一致性
        if source not in SOURCES:
            F.append(_finding("V11", "BLOCK", f"來源聲明必須是 {SOURCES}"))
        if not str(license_note or "").strip():
            F.append(_finding("V11", "BLOCK", "必須填寫『來源與授權說明』（可寫 UNVERIFIED）"))
        marker = bool(info.get("synthetic_marker"))
        if source == "synthetic" and not marker:
            F.append(_finding("V11", "BLOCK", "宣告為合成資料，但檔案沒有 SYNTHETIC 標記列（合成資料必須明確標示）"))
        if source != "synthetic" and marker:
            F.append(_finding("V11", "BLOCK", "檔案帶有 SYNTHETIC 標記，卻被宣告為非合成來源（來源衝突）"))
        # V10：個資
        if "raw_text_for_pii" in info:
            hits = scan_pii(info.pop("raw_text_for_pii"), list(info.get("columns", [])) + list(info.get("extra_columns", [])))
            if hits:
                F.append(_finding("V10", "BLOCK", "偵測到疑似個資／敏感欄位", len(hits), [f"{h['kind']}:{h['detail']}" for h in hits]))
        info.pop("raw_text_for_pii", None)
        plan = None
        if df is not None and not any(f["severity"] == "BLOCK" for f in F if f["rule"] in ("V1", "V2", "V3", "V6")):
            plan = self._plan(df, source, filename, policy, F, counts, PL)
        n_block = sum(f["severity"] == "BLOCK" for f in F)
        status = "REJECTED" if n_block else ("NOOP" if (plan is not None and plan["delta"].empty) else "READY")
        rep = {"status": status, "n_block": n_block, "n_warn": sum(f["severity"] == "WARN" for f in F), "findings": F, "counts": counts, "info": {k: v for k, v in info.items() if k not in ("columns",)},
               "source": source, "license_note": str(license_note or ""), "can_commit": status == "READY"}
        if plan is not None:
            rep["time_range_new"] = [str(plan["delta"]["timestamp"].min()), str(plan["delta"]["timestamp"].max())] if len(plan["delta"]) else None
            rep["relation_to_current"] = plan["relation"]
            rep["_delta"], rep["_new_store"] = plan["delta"], plan["new_store"]
        return rep

    def _plan(self, df: pd.DataFrame, source: str, filename: str, policy: str | None, F: list, counts: dict, PL) -> dict:
        cols = self.cols
        real = self.real()
        store = self.load_rows()
        now = self._now()
        # --- 檔案內：排序、重複
        if not df["timestamp"].is_monotonic_increasing:
            F.append(_finding("V3", "WARN", "檔案內時間未遞增，已排序（延遲到達的資料屬正常）"))
        order = np.argsort(df["timestamp"].to_numpy(), kind="stable")
        d = df.iloc[order].reset_index(drop=True)
        n_intra_dup = n_intra_conf = 0
        keep = np.ones(len(d), bool)
        ts = d["timestamp"].to_numpy()
        X = d[cols].to_numpy(float)
        i = 0
        groups = pd.Series(range(len(d))).groupby(d["timestamp"].to_numpy()).apply(list)
        for g in groups:
            if len(g) < 2:
                continue
            first = g[0]
            same = [j for j in g[1:] if _eq(X[j], X[first]).all()]
            diff = [j for j in g[1:] if j not in same]
            n_intra_dup += len(same)
            for j in same:
                keep[j] = False
            if diff:
                n_intra_conf += len(diff)
                if policy == "prefer_new":
                    last = diff[-1]
                    keep[first] = False
                    for j in g[1:]:
                        if j != last:
                            keep[j] = False
                else:                                                   # keep_existing（保留第一筆）；None/reject 由 BLOCK 擋下
                    for j in diff:
                        keep[j] = False
        counts.update(rows_intra_file_duplicate_identical=n_intra_dup, rows_intra_file_conflict=n_intra_conf)
        if n_intra_dup:
            F.append(_finding("V5", "INFO", f"檔案內有 {n_intra_dup} 列與同時間戳記的列完全相同（已去重）", n_intra_dup))
        if n_intra_conf:
            if policy in (None, "reject"):
                F.append(_finding("V5", "BLOCK", f"檔案內有 {n_intra_conf} 列時間戳記相同但數值不同：請選擇處理方式（保留第一筆／採用最後一筆）或拒絕", n_intra_conf))
            else:
                F.append(_finding("V5", "WARN", f"檔案內 {n_intra_conf} 列衝突，依『{policy}』處理", n_intra_conf))
        d = d[keep].reset_index(drop=True)
        # --- V3 時間範圍
        tmin, tmax = d["timestamp"].min(), d["timestamp"].max()
        if tmax > now:
            F.append(_finding("V3", "BLOCK", f"含未來的時間戳記（{tmax} 晚於現在 {now:%Y-%m-%d %H:%M}）", int((d["timestamp"] > now).sum())))
        if tmin < real.index.min() - pd.Timedelta(days=30):
            F.append(_finding("V3", "BLOCK", f"時間早於已知資料起點超過 30 天（{tmin}）"))
        # --- V4 與目前版本的關係 + V5/V12 重疊比對
        last_known = max(real.index.max(), store["timestamp"].max() if len(store) else real.index.max())
        relation = "append" if tmin > last_known else ("backfill" if tmax < real.index.min() else "overlap")
        if tmin > last_known and (tmin - last_known) > pd.Timedelta(days=365):
            F.append(_finding("V4", "WARN", f"新資料與既有資料相隔 {(tmin - last_known).days} 天"))
        if relation == "backfill":
            F.append(_finding("V4", "WARN", "回補：新資料早於既有資料起點"))
        gap_h = (tmin - last_known) / pd.Timedelta(hours=1) - 1
        if relation == "append" and gap_h > 0:
            F.append(_finding("V4", "INFO", f"與既有資料之間有 {int(gap_h)} 小時缺口（不插補）", int(gap_h)))
        real_idx = real.index
        store_idx = pd.DatetimeIndex(store["timestamp"]) if len(store) else pd.DatetimeIndex([])
        in_real = d["timestamp"].isin(real_idx).to_numpy()
        in_store = d["timestamp"].isin(store_idx).to_numpy()
        counts["rows_overlap_real"] = int(in_real.sum())
        counts["rows_overlap_store"] = int((in_store & ~in_real).sum())
        # 與原始資料重疊：只比對，不改
        dup_real = conf_real = 0
        if in_real.any():
            A = d.loc[in_real, cols].to_numpy(float)
            B = real.loc[pd.DatetimeIndex(d.loc[in_real, "timestamp"]), cols].to_numpy(float)
            e = _eq(A, B).all(axis=1)
            dup_real, conf_real = int(e.sum()), int((~e).sum())
        counts.update(rows_dup_identical_real=dup_real, rows_conflict_real=conf_real)
        if conf_real:
            if policy == "reject":
                F.append(_finding("V12", "BLOCK", f"{conf_real} 列與原始資料同時間但數值不同（原始資料不可改）", conf_real))
            else:
                F.append(_finding("V12", "WARN", f"{conf_real} 列與原始資料同時間但數值不同：原始資料不可改，這些列被忽略", conf_real))
        # 與版本庫重疊
        sidx = store.set_index("timestamp") if len(store) else None
        new_rows, upd_rows = [], []
        dup_store = fill_store = conf_store = 0
        for k in np.where(~in_real)[0]:
            t = d["timestamp"].iloc[k]
            row = d.iloc[k]
            if sidx is not None and t in sidx.index:
                old = sidx.loc[t, cols].to_numpy(float)
                new = row[cols].to_numpy(float)
                same = _eq(new, old)
                if same.all():
                    dup_store += 1
                    continue
                conflict = ~same & ~np.isnan(new) & ~np.isnan(old)
                fill = ~same & ~np.isnan(new) & np.isnan(old)
                merged = old.copy()
                merged[fill] = new[fill]
                if conflict.any():
                    conf_store += 1
                    if policy == "prefer_new":
                        merged[conflict] = new[conflict]
                    elif policy == "reject":
                        pass
                if (~_eq(merged, old)).any():
                    fill_store += int(fill.any())
                    r = row.copy()
                    r[cols] = merged
                    upd_rows.append(r)
            else:
                new_rows.append(row)
        counts.update(rows_dup_identical_store=dup_store, rows_conflict_store=conf_store, rows_fill_store=fill_store)
        if dup_store + dup_real:
            F.append(_finding("V5", "INFO", f"{dup_store + dup_real} 列與既有資料完全相同（去重，不重複寫入）", dup_store + dup_real))
        if conf_store:
            if policy in (None, "reject"):
                F.append(_finding("V12", "BLOCK", f"{conf_store} 列與版本庫既有列同時間但數值不同：請選擇『保留既有值』或『採用新值』，或拒絕", conf_store))
            else:
                F.append(_finding("V12", "WARN", f"{conf_store} 列衝突，依『{policy}』處理（舊值保留在舊版本）", conf_store))
        if fill_store:
            F.append(_finding("V4", "WARN", f"{fill_store} 列補上既有列的缺值（延遲到達）", fill_store))
        delta = pd.DataFrame(new_rows + upd_rows)
        if delta.empty:
            delta = empty_frame(cols)[["timestamp"] + cols]
        else:
            delta = delta[["timestamp"] + cols].reset_index(drop=True)
            delta["timestamp"] = pd.to_datetime(delta["timestamp"])
            for c in cols:
                delta[c] = delta[c].astype(float)
            delta = delta.sort_values("timestamp").reset_index(drop=True)
        counts.update(rows_new=int(len(new_rows)), rows_updated=int(len(upd_rows)), rows_delta=int(len(delta)))
        # --- V7/V8/V13：品質提示（不擋）
        if len(delta):
            self._quality_findings(delta, F, PL)
        # --- 合併後的新版本庫列
        new_store = store
        if len(delta):
            add = delta.copy()
            add["_batch_id"], add["_source"], add["_version"] = filename, source, "pending"
            keep_old = store[~store["timestamp"].isin(add["timestamp"])] if len(store) else store
            new_store = pd.concat([keep_old, add], ignore_index=True).sort_values("timestamp", kind="stable").reset_index(drop=True)
        return {"delta": delta, "new_store": new_store, "relation": relation}

    def _quality_findings(self, delta: pd.DataFrame, F: list, PL):
        import p586_synth as SY
        P = SY.profile(self.stem)
        out_rng = []
        for c in self.cols:
            cp = P.prof[c]
            if cp.kind in ("cont",):
                lo, hi = PL.envelope(self.stem, c)
                v = delta[c].dropna()
                n = int(((v < lo) | (v > hi)).sum())
                if n:
                    out_rng.append(f"{c}:{n}")
        if out_rng:
            F.append(_finding("V7", "WARN", "有讀值超出物理／歷史合理範圍（只標記為候選異常，不刪除）", len(out_rng), out_rng))
        num = delta[self.cols]
        pos = [c for c in self.cols if P.prof[c].kind in ("cont",) and P.prof[c].mean > 0]
        zero_rows = int(((num[pos] == 0).sum(axis=1) / max(len(pos), 1) >= 0.5).sum()) if len(pos) >= 3 else 0
        if zero_rows:
            F.append(_finding("V8", "WARN", f"{zero_rows} 列多數感測器同時為 0（疑似斷電／斷線的假讀值）", zero_rows))
        flat = []
        import p586_anomaly as AM                                              # 只用真實歷史資料算出的『正常連續相同長度上限』
        lim = AM.reference(self.stem)["run_limit"]
        for c in self.cols:
            if P.prof[c].kind == "cont" and len(delta) >= 12:
                s = delta[c]
                run = (s.diff() == 0).astype(int)
                mx = int(run.groupby((run == 0).cumsum()).sum().max()) if len(run) else 0
                if mx + 1 >= lim.get(c, 12):
                    flat.append(f"{c}:連續{mx + 1}筆相同（真實資料正常上限約 {lim.get(c, 12)}）")
        if flat:
            F.append(_finding("V8", "WARN", "有感測器讀值連續不變的時間超過真實資料的正常上限（疑似卡值）", len(flat), flat))
        miss = {c: int(delta[c].isna().sum()) for c in self.cols if delta[c].isna().any()}
        if miss:
            F.append(_finding("V8", "INFO", f"{len(miss)} 個感測器有缺值（不插補）", sum(miss.values()), [f"{k}:{v}" for k, v in list(miss.items())[:5]]))
        F.append(_finding("V9", "INFO", "單位與時區仍為『未經 JNC 確認』；新資料不會讓它們升級"))
        psi = []
        for c in self.cols:
            if P.prof[c].kind == "cont" and delta[c].notna().sum() >= 48:
                r = P.clean[c].dropna()
                qs = np.unique(np.quantile(r, np.linspace(0, 1, 11)))
                if len(qs) < 4:
                    continue
                e = np.histogram(np.clip(r, qs[0], qs[-1]), bins=qs)[0] / len(r) + 1e-4
                a = np.histogram(np.clip(delta[c].dropna(), qs[0], qs[-1]), bins=qs)[0] / delta[c].notna().sum() + 1e-4
                psi.append((float(np.sum((a - e) * np.log(a / e))), c))
        psi.sort(reverse=True)
        if psi and psi[0][0] > 0.25:
            F.append(_finding("V13", "INFO", "分布與歷史資料有明顯差異（PSI>0.25；提示，不是拒絕理由）", len([p for p in psi if p[0] > 0.25]), [f"{c}:PSI={p:.2f}" for p, c in psi[:5]]))

    # ============================================================ 匯入：commit
    def commit(self, upload_id: str, approved_by: str, notes: str = "") -> dict:
        """核准並寫入新版本。重新針對『目前』版本庫計畫一次（避免 stage 與 commit 之間狀態已變）。"""
        qd = self.qdir / upload_id
        if not re.fullmatch(r"up-[0-9a-f]{12}", upload_id) or not (qd / "upload.bin").is_file():
            raise StoreError("找不到這個上傳（upload_id 不合法或不存在）")
        raw = (qd / "upload.bin").read_bytes()
        rep0 = json.loads((qd / "report.json").read_text(encoding="utf-8"))
        if _sha(raw) != rep0["upload_sha256"]:
            raise StoreError("隔離區的上傳檔雜湊與驗證報告不符：拒絕提交")
        if not str(approved_by or "").strip():
            raise StoreError("提交必須記錄核准者")
        with self.lock():
            self.recover()
            rep = self._analyze(raw, rep0["filename"], rep0["source"], rep0["license_note"], rep0.get("policy"))
            rep.update({"upload_id": upload_id, "filename": rep0["filename"], "upload_sha256": rep0["upload_sha256"], "policy": rep0.get("policy")})
            if rep["status"] == "REJECTED":
                self._audit("commit_refused", {"upload_id": upload_id, "blocks": [f["message"] for f in rep["findings"] if f["severity"] == "BLOCK"][:3]})
                return {k: v for k, v in rep.items() if not k.startswith("_")} | {"committed": False}
            if rep["status"] == "NOOP":
                self._audit("commit_noop", {"upload_id": upload_id})
                return {k: v for k, v in rep.items() if not k.startswith("_")} | {"committed": False, "reason": "沒有新資料可寫入（全部與既有資料相同）"}
            return self._write_version(rep, approved_by, notes)

    def _write_version(self, rep: dict, approved_by: str, notes: str) -> dict:
        m = self.manifest()
        seq = len(m["versions"]) + 1
        prev = self.current_seq()
        new_store = rep["_new_store"].copy()
        vtag = f"v{seq:04d}"
        # 本版新增／更新的列標上版本；其餘維持原版本標記
        pending = new_store["_version"] == "pending"
        new_store.loc[pending, "_version"] = vtag
        new_store.loc[pending, "_batch_id"] = rep["info"].get("marker_batch_id") or rep["filename"]
        canon = _canon_csv(new_store, self.cols)
        delta = rep["_delta"].copy()
        delta["_source"], delta["_batch_id"], delta["_version"] = rep["source"], rep["info"].get("marker_batch_id") or rep["filename"], vtag
        delta_b = _canon_csv(delta, self.cols)
        report = {k: v for k, v in rep.items() if not k.startswith("_")}
        report_b = _jd(report)
        _atomic_write(self.journal_path, _jd({"kind": "commit", "to_seq": seq, "from_seq": prev, "t": str(self._now())}))
        _fault("after_journal")
        tmp = self.vdir / f".tmp-{vtag}"
        _rm_tree(tmp)
        tmp.mkdir()
        for name, b in (("canonical.csv", canon), ("delta.csv", delta_b), ("validation_report.json", report_b)):
            with open(tmp / name, "wb") as f:
                f.write(b)
                f.flush()
                os.fsync(f.fileno())
        _fault("after_tmp_written")
        os.replace(tmp, self.vdir / vtag)
        _fsync_dir(self.vdir)
        _fault("after_dir_rename")
        entry = {"seq": seq, "version_id": f"{self.stem}-{vtag}-{_sha(canon)[:12]}", "parent": prev, "created_at": str(self._now()), "batch_id": rep["info"].get("marker_batch_id") or rep["filename"],
                 "filename": rep["filename"], "upload_sha256": rep["upload_sha256"], "source": rep["source"], "license_note": rep["license_note"], "policy": rep.get("policy"), "approved_by": approved_by, "notes": notes,
                 "rows_added": rep["counts"]["rows_new"], "rows_updated": rep["counts"]["rows_updated"], "rows_dup_identical": rep["counts"]["rows_dup_identical_real"] + rep["counts"]["rows_dup_identical_store"] + rep["counts"]["rows_intra_file_duplicate_identical"],
                 "rows_conflict": rep["counts"]["rows_conflict_real"] + rep["counts"]["rows_conflict_store"] + rep["counts"]["rows_intra_file_conflict"], "canonical_rows": int(len(new_store)),
                 "time_range": [str(new_store["timestamp"].min()), str(new_store["timestamp"].max())], "canonical_sha256": _sha(canon), "validation_sha256": _sha(report_b),
                 "synthetic_marked": bool(rep["info"].get("synthetic_marker")), "base_raw_sha16": self.real_sha16(), "store_version": STORE_VERSION,
                 "prev_entry_hash": m["versions"][-1]["entry_hash"] if m["versions"] else "0" * 16}
        entry["entry_hash"] = self._entry_hash(entry)
        m["versions"].append(entry)
        m["base_raw_sha16"] = self.real_sha16()
        _atomic_write(self.manifest_path, _jd(m))                          # ← 提交點
        _fault("after_manifest")
        _atomic_write(self.current_path, _jd({"seq": seq}))
        _fault("after_current")
        self._audit("commit", {"seq": seq, "version_id": entry["version_id"], "rows_added": entry["rows_added"], "source": entry["source"], "approved_by": approved_by, "upload_id": rep["upload_id"]})
        self.journal_path.unlink(missing_ok=True)
        return {k: v for k, v in rep.items() if not k.startswith("_")} | {"committed": True, "version": entry}

    # ============================================================ 回復
    def rollback(self, to_seq: int, by: str, reason: str = "") -> dict:
        with self.lock():
            self.recover()
            m = self.manifest()
            if to_seq != 0 and to_seq not in {v["seq"] for v in m["versions"]}:
                raise StoreError(f"沒有版本 {to_seq}")
            if to_seq:
                self.load_rows(to_seq)                                    # 先驗證該版完好，才切過去
            frm = self.current_seq()
            _atomic_write(self.current_path, _jd({"seq": int(to_seq)}))
            self._audit("rollback", {"from": frm, "to": int(to_seq), "by": by, "reason": reason})
        return {"from": frm, "to": int(to_seq)}

    def import_file(self, path: str | Path, source: str, license_note: str, approved_by: str, policy: str | None = None, notes: str = "") -> dict:
        """便利函式：stage + commit。"""
        p = Path(path)
        st = self.stage(p.read_bytes(), p.name, source, license_note, policy)
        if not st["can_commit"]:
            return st | {"committed": False}
        return self.commit(st["upload_id"], approved_by, notes)


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True                                                       # 程序存在但屬於別的使用者
    except OSError:
        return False
    return True


def _rm_tree(p: Path):
    p = Path(p)
    if not p.exists():
        return
    for q in sorted(p.rglob("*"), reverse=True):
        q.unlink() if (q.is_file() or q.is_symlink()) else q.rmdir()
    p.rmdir()
