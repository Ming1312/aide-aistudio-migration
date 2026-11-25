"""
p589_registry.py — Phase 5.8.9：模型版本管理（每個版本庫、每個預測任務各自一份；追加式；不碰既有研究 artifact）

* v0 ＝ Phase 5.8.2 的研究 artifact（outputs/phase5_8_2/artifacts；唯讀，只引用、不複製、不修改）。
* 人工重新訓練產生的 candidate 存在 <版本庫>/models/<任務>/vNNNN/（model.joblib＋meta.json，meta 不可變）。
* active.json 指向『目前用來預測新資料的版本』；啟用／回復只是切換指標（寫事件、保留所有版本）。
* 事件日誌 registry.jsonl 有雜湊鏈：train／compare／promote／rollback／reject。
* 啟用有兩種：experimental（本機、這個版本庫內用於新資料預測；資料含合成列時只能是這種）與 formal（正式升級）。
  **formal 目前一律被 formal_gate 擋下**：合成資料不得作為正式升級的驗證依據；而且來源授權、獨立前瞻評估、審查者與 P1-2 嚴格 Gate 都還沒有證據。
* 啟用只影響這個版本庫內的新資料預測；羊舍正式決策流程、Model Registry、既有 artifact 與研究結果完全不受影響。
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

import pandas as pd

import p56_bench as BN
import p582_engine as E
import p586_store as ST

MIN_FORMAL_EVAL = 168


FAULT = {"point": None}                       # 測試用：模擬在指定步驟當機


class SimulatedCrash(Exception):
    pass


def _fault(point: str):
    if FAULT["point"] == point:
        raise SimulatedCrash(point)


class RegistryError(Exception):
    pass


class FormalRefused(RegistryError):
    pass


def _sha(o) -> str:
    return hashlib.sha256(json.dumps(o, ensure_ascii=False, sort_keys=True, default=str).encode("utf-8")).hexdigest()


def _fsha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def _atomic(p: Path, data: bytes):
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(f".{p.name}.tmp{os.getpid()}")
    with open(tmp, "wb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, p)


def formal_gate(meta: dict, compare: dict | None, reviewer: str | None = None) -> dict:
    """正式升級的必要條件檢查（全部通過才可能 formal；目前沒有任何版本能通過）。"""
    c = []
    c.append(("訓練期與評估期都不含合成資料", not meta.get("contains_synthetic", True), "含合成（模擬）資料：合成資料不得作為正式升級的驗證依據"))
    c.append(("資料來源已確認授權的真實資料", False, "版本庫匯入的來源最高只到 unverified_import（授權未確認）；目前沒有『已確認授權』這個狀態"))
    c.append(("評估期晚於所有開發資料（獨立前瞻評估）", bool(compare and compare.get("eval_after_train")), "需要比較結果顯示評估期完全晚於訓練期；且該段資料之前沒有被用來選擇或調整任何東西"))
    c.append((f"評估樣本 ≥ {MIN_FORMAL_EVAL} 個起點", bool(compare and compare.get("n_eval", 0) >= MIN_FORMAL_EVAL), "樣本不足時不做正式結論"))
    c.append(("審查者與訓練者不同人", bool(reviewer and reviewer != meta.get("trained_by")), "需要另一位審查者"))
    c.append(("通過 P1-2 加強 Gate 的證據檢查", False, "本階段沒有把版本庫模型接到加強 Gate（需要審查證據與 Holdout 帳本）"))
    return {"eligible": all(ok for _, ok, _ in c), "checks": [{"check": n, "ok": ok, "why": "" if ok else w} for n, ok, w in c]}


class Registry:
    def __init__(self, store: ST.Store, recover: bool = True):
        self.store = store
        self.dir = store.base / "models"
        self.log_path = self.dir / "registry.jsonl"
        self.recovery_notes: list[str] = self.recover() if recover else []

    # ---- 事件日誌
    def events(self) -> list[dict]:
        """事件日誌；最後一行若是當機留下的半行（沒有換行結尾且無法解析）就忽略（recover() 會截掉）。"""
        if not self.log_path.is_file():
            return []
        raw = self.log_path.read_bytes().decode("utf-8", errors="replace")
        out = []
        lines = raw.split("\n")
        for i, l in enumerate(lines):
            if not l.strip():
                continue
            try:
                out.append(json.loads(l))
            except ValueError:
                if i == len(lines) - 1:
                    continue                                          # 半行
                raise RegistryError("事件日誌中間有損壞的紀錄")
        return out

    def _heal_log(self) -> bool:
        if not self.log_path.is_file():
            return False
        b = self.log_path.read_bytes()
        if b and not b.endswith(b"\n"):
            cut = b.rfind(b"\n") + 1
            with open(self.log_path, "wb") as f:
                f.write(b[:cut])
                f.flush()
                os.fsync(f.fileno())
            return True
        return False

    def _event(self, kind: str, task: str, **kw) -> dict:
        ev = self.events()
        rec = {"t": str(pd.Timestamp.now()), "kind": kind, "task": task, **kw, "prev": ev[-1]["hash"] if ev else "0" * 16}
        rec["hash"] = _sha({k: v for k, v in rec.items() if k != "hash"})[:16]
        self.dir.mkdir(parents=True, exist_ok=True)
        self._heal_log()
        with open(self.log_path, "ab") as f:
            f.write(json.dumps(rec, ensure_ascii=False, sort_keys=True, default=str).encode("utf-8") + b"\n")
            f.flush()
            os.fsync(f.fileno())
        return rec

    def note(self, kind: str, task: str, **kw) -> dict:
        """寫一筆事件（例如『人工覆寫守門』）；追加式、有雜湊鏈。"""
        with self.store.lock():
            return self._event(kind, task, **kw)

    # ---- 路徑
    def tdir(self, task: str) -> Path:
        return self.dir / BN.safe(task)

    def vdir(self, task: str, v: int) -> Path:
        return self.tdir(task) / f"v{v:04d}"

    # ---- 版本
    def version_ids(self, task: str) -> list[int]:
        d = self.tdir(task)
        return sorted(int(p.name[1:]) for p in d.glob("v[0-9][0-9][0-9][0-9]") if (p / "meta.json").is_file()) if d.is_dir() else []

    def meta(self, task: str, v: int) -> dict:
        if v == 0:
            a = E.load_artifact(task)
            m = a["meta"]
            return {"version": 0, "task": task, "kind": "research_artifact", "trained_by": "Phase 5.8.2（研究 artifact）", "created_at": m.get("built_at"), "data_version_id": "原始資料（v0000）", "contains_synthetic": False,
                    "train_end": None, "sha256": a["sha256"], "evidence_class": "research_artifact", "parent": None}
        p = self.vdir(task, v) / "meta.json"
        if not p.is_file():
            raise RegistryError(f"{task} 沒有版本 v{v:04d}")
        return json.loads(p.read_text(encoding="utf-8"))

    def get(self, task: str, v: int) -> dict:
        """載入並驗證某版本；雜湊不符就拒絕。回傳 {meta, models, sha256, version}（與 p582_engine.load_artifact 同形狀）。"""
        import joblib
        if v == 0:
            a = E.load_artifact(task)
            return {**a, "version": 0}
        m = self.meta(task, v)
        p = self.vdir(task, v) / "model.joblib"
        if not p.is_file() or _fsha(p) != m["sha256"]:
            raise RegistryError(f"{task} v{v:04d} 的模型檔遺失或雜湊不符（可能被改動）：拒絕使用")
        a = joblib.load(p)
        return {"meta": a["meta"], "models": a["models"], "versions": None, "sha256": m["sha256"], "version": v}

    def active(self, task: str) -> int:
        p = self.tdir(task) / "active.json"
        if not p.is_file():
            return 0
        try:
            return int(json.loads(p.read_text(encoding="utf-8"))["version"])
        except (ValueError, KeyError) as e:
            raise RegistryError("active 指標損壞") from e

    def resolve(self, task: str) -> dict:
        """預測用：目前啟用的版本；啟用版本損壞時 fail closed（不偷偷退回舊版）。"""
        return self.get(task, self.active(task))

    def add_candidate(self, task: str, models: dict, meta: dict) -> int:
        import joblib
        with self.store.lock():
            v = (max(self.version_ids(task)) if self.version_ids(task) else 0) + 1
            d = self.vdir(task, v)
            d.mkdir(parents=True, exist_ok=True)
            jp = d / "model.joblib"
            joblib.dump({"meta": {**meta, "version": v}, "models": models}, jp, compress=3)
            _fault("after_joblib")
            full = {**meta, "version": v, "task": task, "kind": "retrained_candidate", "sha256": _fsha(jp), "bytes": jp.stat().st_size}
            _atomic(d / "meta.json", json.dumps(full, ensure_ascii=False, sort_keys=True, indent=1, default=str).encode("utf-8"))
            _fault("after_meta")
            self._event("train", task, version=v, by=meta.get("trained_by"), data_version=meta.get("data_version_id"), sha256=full["sha256"], contains_synthetic=meta.get("contains_synthetic"))
            return v

    # ---- 比較結果
    def save_compare(self, task: str, v: int, compare: dict):
        with self.store.lock():
            _atomic(self.vdir(task, v) / "compare.json", json.dumps(compare, ensure_ascii=False, sort_keys=True, indent=1, default=str).encode("utf-8"))
            self._event("compare", task, version=v, incumbent=compare.get("incumbent_version"), verdict=compare.get("verdict"), n_eval=compare.get("n_eval"))

    def compare_of(self, task: str, v: int) -> dict | None:
        p = self.vdir(task, v) / "compare.json"
        return json.loads(p.read_text(encoding="utf-8")) if p.is_file() else None

    # ---- 啟用／回復
    def promote(self, task: str, v: int, by: str, reason: str, mode: str = "experimental", reviewer: str | None = None) -> dict:
        if not str(by or "").strip() or not str(reason or "").strip():
            raise RegistryError("啟用必須記錄操作者與原因")
        if v == 0:
            raise RegistryError("v0 是研究 artifact；要回到它請用『回復』")
        m = self.get(task, v)["meta"] and self.meta(task, v)                      # 先驗證模型檔
        comp = self.compare_of(task, v)
        if comp is None:
            raise RegistryError("這個版本還沒有『新舊比較』結果：先比較再啟用")
        if mode == "formal":
            g = formal_gate(m, comp, reviewer)
            if not g["eligible"]:
                self._event("reject", task, version=v, by=by, reason="formal 被擋下：" + "；".join(c["check"] for c in g["checks"] if not c["ok"]))
                raise FormalRefused("正式升級被擋下：" + "；".join(f"{c['check']}（{c['why']}）" for c in g["checks"] if not c["ok"]))
        elif mode != "experimental":
            raise RegistryError(f"未知的啟用方式：{mode}")
        with self.store.lock():
            prev = self.active(task)
            ev = self._event("promote", task, version=v, previous=prev, by=by, reason=reason, mode=mode, contains_synthetic=m.get("contains_synthetic"))
            _fault("after_event")
            _atomic(self.tdir(task) / "active.json", json.dumps({"version": v, "mode": mode}).encode())
            return ev

    def rollback(self, task: str, to_version: int, by: str, reason: str) -> dict:
        if not str(by or "").strip() or not str(reason or "").strip():
            raise RegistryError("回復必須記錄操作者與原因")
        self.get(task, to_version)                                                   # 目標版本必須完好
        with self.store.lock():
            prev = self.active(task)
            ev = self._event("rollback", task, version=int(to_version), previous=prev, by=by, reason=reason)
            _fault("after_event")
            _atomic(self.tdir(task) / "active.json", json.dumps({"version": int(to_version), "mode": "rollback"}).encode())
            return ev

    # ---- 當機復原
    def recover(self) -> list[str]:
        """清掉未完成的版本目錄、補上缺的 train 事件、讓 active 指標與最後一筆啟用／回復事件一致、截掉日誌的半行。持有版本庫鎖時才動作（取不到就略過）。"""
        notes: list[str] = []
        if not self.dir.is_dir():
            return notes
        try:
            with self.store.lock(timeout=0.3):
                if self._heal_log():
                    notes.append("截掉事件日誌的半行")
                ev = self.events()
                trained = {(e["task"], e.get("version")) for e in ev if e["kind"] == "train"}
                for td in [p for p in self.dir.iterdir() if p.is_dir()]:
                    for tmp in list(td.glob(".*.tmp*")):
                        tmp.unlink(missing_ok=True)
                    for vd in sorted(td.glob("v[0-9][0-9][0-9][0-9]")):
                        mp = vd / "meta.json"
                        if not mp.is_file():
                            for f in vd.rglob("*"):
                                f.unlink() if f.is_file() else None
                            for f in sorted(vd.rglob("*"), reverse=True):
                                f.rmdir()
                            vd.rmdir()
                            notes.append(f"移除未完成的版本目錄 {td.name}/{vd.name}")
                            continue
                        m = json.loads(mp.read_text(encoding="utf-8"))
                        if (m.get("task"), m["version"]) not in trained:
                            self._event("train", m["task"], version=m["version"], by=m.get("trained_by"), data_version=m.get("data_version_id"), sha256=m.get("sha256"), contains_synthetic=m.get("contains_synthetic"), recovered=True)
                            notes.append(f"補上 {m['task']} v{m['version']:04d} 缺少的 train 事件")
                last: dict[str, dict] = {}
                for e in self.events():
                    if e["kind"] in ("promote", "rollback"):
                        last[e["task"]] = e
                for task, e in last.items():
                    if self.active(task) != e["version"]:
                        _atomic(self.tdir(task) / "active.json", json.dumps({"version": int(e["version"]), "mode": "recovered"}).encode())
                        notes.append(f"{task}：active 指標與最後一筆事件不一致，已依事件補正為 v{int(e['version']):04d}")
        except ST.StoreBusy:
            pass
        return notes

    # ---- 完整性
    def verify(self) -> dict:
        problems, prev = [], "0" * 16
        for r in self.events():
            if r.get("prev") != prev:
                problems.append("事件日誌雜湊鏈中斷")
                break
            if _sha({k: v for k, v in r.items() if k != "hash"})[:16] != r.get("hash"):
                problems.append("事件日誌有被改動的紀錄")
                break
            prev = r["hash"]
        if self.dir.is_dir():
            for td in self.dir.iterdir():
                if td.is_dir():
                    for vd in sorted(td.glob("v[0-9][0-9][0-9][0-9]")):
                        mp, jp = vd / "meta.json", vd / "model.joblib"
                        if not mp.is_file() or not jp.is_file():
                            problems.append(f"{td.name}/{vd.name} 檔案不完整")
                        elif _fsha(jp) != json.loads(mp.read_text(encoding="utf-8"))["sha256"]:
                            problems.append(f"{td.name}/{vd.name} 模型檔雜湊不符")
        return {"ok": not problems, "problems": problems, "events": len(self.events())}

    def history(self, task: str) -> list[dict]:
        return [e for e in self.events() if e["task"] == task]
