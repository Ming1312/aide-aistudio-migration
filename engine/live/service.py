"""
live/service.py — Phase 6.5：『新資料進來 → 驗證 → 版本庫 → 自動重算預測 → 監測』的即時管線（引擎端）

全部建立在『已驗收的既有元件』上，不新增任何模型、門檻或控制指令：
  * p586_store.Store     追加式、可稽核、可回復的資料版本庫（stage 隔離驗證 → commit 核准；原始資料永遠唯讀；雜湊鏈；當機復原）
  * p586_forecast        既有 6 種方法（持續性、移動平均、24h 季節性、線性 AR、HGB、XGBoost）在『版本庫某一版』上的預測＋適用性檢查
  * p586_analysis        每一版的品質與候選異常

這個模組加上的東西：
  1. ingest()：stage →（沒有 BLOCK、沒有衝突才）自動 commit → 重算預測；有問題的批次留在隔離區等人處理，不會半套寫入
  2. recompute()：對每個已開放的預測任務，在『最新起點』（目標時間在資料之後＝前瞻預測）重算 6 種方法，並寫入不可改的發佈紀錄
  3. monitor()：目標時間已經到來的舊預測，回頭與實際值比較（線上穩定性監測；資料含合成列時只是流程檢查，不是模型效能）
  4. status()：資料新鮮度、預測是否對得上目前版本、待處理的上傳、版本庫完整性
  5. rollback()：把 current 指回舊版本（寫稽核）並重算預測

誠實規則：
  * 預測仍是研究預測（探索性、未經獨立前瞻驗證）；沒有任何警戒門檻；寫入新資料不會重新訓練模型。
  * 模擬資料流的每一列都帶 SYNTHETIC 標記，預測結果一律帶 contains_synthetic 與橫幅；真實來源必須由管理者以 unverified_import 匯入並附授權說明。
  * 『資料過舊』的小時數是營運監測的設定值（AIDE_STALE_AFTER_H，預設 6），不是物理或安全門檻。
"""
from __future__ import annotations

import json
import math
import os
import threading
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd

import domain_schema as DS  # noqa: F401
import p582_engine as E
import p586_analysis as AN6
import p586_forecast as FC
import p586_store as ST

STALE_AFTER_H = float(os.environ.get("AIDE_STALE_AFTER_H", "6"))
HISTORY_H = 72
SYNTH_BANNER = FC.SYNTH_BANNER
LIVE_VERSION = "aide-live-1"


def _clean(o):
    if isinstance(o, dict):
        return {str(k): _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_clean(v) for v in o]
    if isinstance(o, pd.DataFrame):
        return _clean(o.to_dict("records"))
    if isinstance(o, (pd.Timestamp, datetime)):
        return str(o)
    if isinstance(o, np.integer):
        return int(o)
    if isinstance(o, (np.floating, float)):
        f = float(o)
        return f if math.isfinite(f) else None
    if isinstance(o, np.bool_):
        return bool(o)
    return o


def _dumps(o) -> bytes:
    return json.dumps(_clean(o), ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")


def _now_s() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


class LiveError(Exception):
    pass


class LiveService:
    def __init__(self, root: str | Path, catalog: dict | None = None, now_fn=None):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.now_fn = now_fn or _now_s
        self._stems: dict[str, str] = {}
        if catalog:
            self._stems = {d["id"]: d["stem"] for d in catalog["datasets"]}
        self._locks: dict[str, threading.RLock] = {}
        self._stores: dict[str, ST.Store] = {}
        self._guard = threading.Lock()

    # ------------------------------------------------------------------ 基本
    def stem(self, did: str) -> str:
        if did not in self._stems:
            raise LiveError(f"沒有這個場域：{did}")
        return self._stems[did]

    def ids(self) -> list[str]:
        return list(self._stems)

    def lock(self, did: str) -> threading.RLock:
        with self._guard:
            return self._locks.setdefault(did, threading.RLock())

    def store(self, did: str) -> ST.Store:
        stem = self.stem(did)
        with self._guard:
            if did not in self._stores:
                self._stores[did] = ST.Store(stem, root=self.root)
            return self._stores[did]

    def _ldir(self, did: str) -> Path:
        d = self.root / self.stem(did) / "live"
        d.mkdir(parents=True, exist_ok=True)
        return d

    def _state(self, did: str) -> dict:
        p = self._ldir(did) / "state.json"
        if p.is_file():
            return json.loads(p.read_text(encoding="utf-8"))
        return {"mode": "real", "sim_clock": None, "last_ingest_at": None, "last_forecast_at": None, "last_error": None, "ingest_count": 0, "refused_count": 0, "held_count": 0}

    def _save_state(self, did: str, st: dict):
        ST._atomic_write(self._ldir(did) / "state.json", _dumps(st))

    def _event(self, did: str, kind: str, detail: dict):
        line = json.dumps(_clean({"t": self.now_fn(), "kind": kind, **detail}), ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        with open(self._ldir(did) / "events.jsonl", "a", encoding="utf-8") as f:
            f.write(line + "\n")

    def set_sim_clock(self, did: str, clock: str | None):
        """模擬資料流的時鐘（＝模擬『現在』）。None＝改回真實時鐘。"""
        with self.lock(did):
            st = self._state(did)
            st["mode"] = "simulated" if clock else "real"
            st["sim_clock"] = str(clock) if clock else None
            self._save_state(did, st)

    def clock(self, did: str) -> pd.Timestamp:
        st = self._state(did)
        if st["mode"] == "simulated" and st["sim_clock"]:
            return pd.Timestamp(st["sim_clock"])
        return pd.Timestamp(self.now_fn())

    # ------------------------------------------------------------------ 匯入
    def ingest(self, did: str, raw: bytes, filename: str, source: str, license_note: str, approver: str, policy: str | None = None, auto_commit: bool = True) -> dict:
        """stage → 條件式 commit → 重算預測。任何一步失敗都不會留下半套狀態（Store 本身是兩步驟原子提交）。"""
        with self.lock(did):
            store = self.store(did)
            st = self._state(did)
            try:
                rep = store.stage(raw, filename, source, license_note, policy)
            except ST.StoreError as e:
                st["refused_count"] += 1
                st["last_error"] = {"at": self.now_fn(), "stage": "stage", "message": str(e)[:200]}
                self._save_state(did, st)
                self._event(did, "ingest_error", {"stage": "stage", "message": str(e)[:200]})
                raise LiveError(str(e)) from e
            out = {"upload_id": rep["upload_id"], "status": rep["status"], "n_block": rep["n_block"], "n_warn": rep["n_warn"], "findings": rep["findings"][:20], "counts": rep["counts"],
                   "time_range_new": rep.get("time_range_new"), "committed": False, "decision": None}
            if rep["status"] == "REJECTED":
                st["refused_count"] += 1
                st["last_error"] = {"at": self.now_fn(), "stage": "validate", "message": "；".join(f["message"] for f in rep["findings"] if f["severity"] == "BLOCK")[:200]}
                out["decision"] = "refused_blocked"
                self._event(did, "ingest_refused", {"upload_id": rep["upload_id"], "blocks": [f["message"] for f in rep["findings"] if f["severity"] == "BLOCK"][:3]})
            elif rep["status"] == "NOOP":
                conflicts = rep["counts"].get("rows_conflict_real", 0) + rep["counts"].get("rows_conflict_store", 0) + rep["counts"].get("rows_intra_file_conflict", 0)
                out["decision"] = "noop_conflicts_kept_existing" if conflicts else "noop_nothing_new"
                if conflicts:
                    out["reason"] = f"{conflicts} 列與既有資料的值不同，依規則保留既有資料、沒有寫入任何東西"
                st["refused_count"] += 1 if conflicts else 0
                self._event(did, "ingest_noop", {"upload_id": rep["upload_id"], "conflicts": conflicts})
            else:
                conflicts = rep["counts"].get("rows_conflict_real", 0) + rep["counts"].get("rows_conflict_store", 0) + rep["counts"].get("rows_intra_file_conflict", 0)
                if not auto_commit or conflicts:
                    st["held_count"] += 1
                    out["decision"] = "held_for_review" if conflicts else "held_manual"
                    out["reason"] = f"有 {conflicts} 列與既有資料衝突，需要人員決定（stage 報告在隔離區）" if conflicts else "未啟用自動提交"
                    self._event(did, "ingest_held", {"upload_id": rep["upload_id"], "conflicts": conflicts})
                else:
                    c = store.commit(rep["upload_id"], approver, notes=f"自動提交（規則：沒有 BLOCK、沒有衝突）；來源 {source}")
                    out["committed"] = bool(c.get("committed"))
                    out["version"] = c.get("version")
                    out["decision"] = "committed" if out["committed"] else "commit_refused"
                    st["ingest_count"] += 1 if out["committed"] else 0
                    if out["committed"]:
                        st["last_error"] = None                       # 成功提交＝上一次的失敗已經過去
                        st["last_ingest_at"] = self.now_fn()
                    self._event(did, "ingest_committed" if out["committed"] else "ingest_commit_refused", {"upload_id": rep["upload_id"], "seq": (c.get("version") or {}).get("seq")})
            self._save_state(did, st)
            if out["committed"]:
                out["forecast"] = self.recompute(did, reason="new_version")["summary"]
            return out

    def commit_pending(self, did: str, upload_id: str, approver: str, notes: str = "") -> dict:
        with self.lock(did):
            store = self.store(did)
            c = store.commit(upload_id, approver, notes)
            st = self._state(did)
            if c.get("committed"):
                st["ingest_count"] += 1
                st["last_error"] = None
                st["last_ingest_at"] = self.now_fn()
            self._save_state(did, st)
            self._event(did, "commit_pending", {"upload_id": upload_id, "committed": bool(c.get("committed")), "by": approver})
            res = {"committed": bool(c.get("committed")), "version": c.get("version"), "findings": c.get("findings", [])[:10]}
            if res["committed"]:
                res["forecast"] = self.recompute(did, reason="new_version")["summary"]
            return res

    def rollback(self, did: str, to_seq: int, by: str, reason: str = "") -> dict:
        with self.lock(did):
            store = self.store(did)
            r = store.rollback(int(to_seq), by, reason)
            self._event(did, "rollback", {"from": r["from"], "to": r["to"], "by": by})
            r["forecast"] = self.recompute(did, reason="rollback")["summary"]
            return r

    # ------------------------------------------------------------------ 預測
    def _ser(self, store: ST.Store, seq: int, r: dict) -> dict:
        stem, target, h = E.split_task(r["task_id"])
        g, _ = AN6.grid(store, seq)
        o = pd.Timestamp(r["origin"])
        hist = g[target].loc[o - pd.Timedelta(hours=HISTORY_H - 1): o]
        models = {}
        for row in r["table"].to_dict("records"):
            models[row["model"]] = {"label": row["label"], "value": row["prediction"], "refused": row["refused"] if isinstance(row["refused"], str) else None}
        ap = r["applicability"]
        lo, lv = r["last_observation"]
        return {"task_id": r["task_id"], "sensor": target, "horizon_h": h, "origin": o, "target_time": r["target_time"], "data_version": r["data_version"], "models": models,
                "applicability": {"status": ap["status"], "reasons": [{"level": x["level"], "category": x.get("category"), "text": x["text"]} for x in ap["reasons"] if x["level"] != "info"], "facts": ap["facts"]},
                "last_observation": {"time": lo, "value": lv}, "contains_synthetic": bool(r["contains_synthetic"]), "synthetic_banner": SYNTH_BANNER if r["contains_synthetic"] else None,
                "artifact_sha256": r["artifact_sha256"], "model_version": r["model_version"], "research_status": r["research_status"], "claims": r["claims"],
                "history": {"times": [str(t) for t in hist.index], "values": [None if v != v else float(v) for v in hist.to_numpy()]}}

    def guard_health(self, did: str) -> dict:
        """適用性評估依賴『起點當下已偵測到的候選警報』（p587_detect 與各場域校準檔）。這一步缺檔時預測端會靜默略過警報檢查，
        所以每次重算都主動確認它可用，不可用就明講（不能讓守門悄悄失效）。"""
        store = self.store(did)
        try:
            a = AN6.alerts(store, store.current_seq())
            return {"alerts_ok": True, "n_alerts_in_new_data": int(len(a["alerts"])), "error": None}
        except Exception as e:  # noqa: BLE001
            return {"alerts_ok": False, "n_alerts_in_new_data": None, "error": f"{type(e).__name__}：{str(e)[:120]}"}

    def recompute(self, did: str, reason: str = "manual") -> dict:
        """目前版本的『最新起點』預測（前瞻：目標時間在資料之後）。每個任務各自隔離：一個任務失敗不影響其他任務。"""
        with self.lock(did):
            store = self.store(did)
            stem = self.stem(did)
            seq = store.current_seq()
            vid = store.version_id(seq)
            now = self.now_fn()
            items, n_ok, n_refused, n_err = [], 0, 0, 0
            log_lines = []
            for tid in FC.tasks(stem):
                try:
                    o = FC.latest_origin(store, seq, tid)
                    if o is None:
                        items.append({"task_id": tid, "refused": "目前資料沒有『目標連續 25 小時』的起點，不提供預測。"})
                        n_refused += 1
                        continue
                    r = FC.compare_all(store, seq, tid, o)
                    it = self._ser(store, seq, r)
                    items.append(it)
                    n_ok += 1
                    log_lines.append({"issued_at": now, "data_version": vid, "seq": seq, "task_id": tid, "origin": str(o), "target_time": str(it["target_time"]),
                                      "predictions": {k: v["value"] for k, v in it["models"].items()}, "contains_synthetic": it["contains_synthetic"], "applicability": it["applicability"]["status"]})
                except E.ForecastRefused as e:
                    items.append({"task_id": tid, "refused": str(e)[:200]})
                    n_refused += 1
                except Exception as e:  # noqa: BLE001 — 單一任務失敗不得拖垮整批；只記錄類別
                    items.append({"task_id": tid, "error": type(e).__name__})
                    n_err += 1
                    self._event(did, "forecast_error", {"task_id": tid, "error": type(e).__name__})
            g, _ = AN6.grid(store, seq)
            gh = self.guard_health(did)
            payload = {"schema": "aide-live-forecast-v1", "guard": gh, "dataset_id": did, "data_version": vid, "seq": seq, "issued_at": now, "reason": reason, "data_end": str(g.index[g.notna().any(axis=1)].max()),
                       "n_tasks": len(items), "n_ok": n_ok, "n_refused": n_refused, "n_error": n_err, "tasks": items,
                       "disclaimer": "研究預測（探索性、未經獨立前瞻驗證）；沒有任何警戒門檻；不控制任何設備。" + (" " + SYNTH_BANNER if any(i.get("contains_synthetic") for i in items) else "")}
            ST._atomic_write(self._ldir(did) / "forecast_latest.json", _dumps(payload))
            if log_lines:
                seen = set()
                lp = self._ldir(did) / "forecast_log.jsonl"
                if lp.is_file():
                    for ln in lp.read_text(encoding="utf-8").splitlines():
                        try:
                            d = json.loads(ln)
                            seen.add((d["task_id"], d["origin"], d["data_version"]))
                        except Exception:  # noqa: BLE001
                            pass
                with open(lp, "a", encoding="utf-8") as f:
                    for d in log_lines:
                        if (d["task_id"], d["origin"], d["data_version"]) not in seen:
                            f.write(json.dumps(_clean(d), ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n")
            st = self._state(did)
            st["last_forecast_at"] = now
            self._save_state(did, st)
            self._event(did, "forecast", {"seq": seq, "version": vid, "ok": n_ok, "refused": n_refused, "error": n_err, "reason": reason})
            return {"summary": {"data_version": vid, "seq": seq, "n_ok": n_ok, "n_refused": n_refused, "n_error": n_err, "issued_at": now}, "payload": payload}

    def latest(self, did: str) -> dict | None:
        p = self._ldir(did) / "forecast_latest.json"
        return json.loads(p.read_text(encoding="utf-8")) if p.is_file() else None

    def forecast_log(self, did: str, limit: int = 200) -> list[dict]:
        p = self._ldir(did) / "forecast_log.jsonl"
        if not p.is_file():
            return []
        rows = []
        for ln in p.read_text(encoding="utf-8").splitlines()[-max(1, min(limit, 5000)):]:
            try:
                rows.append(json.loads(ln))
            except Exception:  # noqa: BLE001
                continue
        return rows

    # ------------------------------------------------------------------ 監測
    def monitor(self, did: str) -> dict:
        """已到期的舊預測 vs 實際值。這是『線上穩定性監測』：預測是否持續產出、誤差是否在合理範圍（與持續性基準比）。
        資料含合成列時不是模型效能證據。"""
        with self.lock(did):
            store = self.store(did)
            seq = store.current_seq()
            g, src = AN6.grid(store, seq)
            log = self.forecast_log(did, 5000)
            per: dict[str, dict] = {}
            n_matured = n_pending = 0
            seen = set()
            for d in log:
                key = (d["task_id"], d["origin"], d["target_time"])
                if key in seen:
                    continue
                seen.add(key)
                stem, target, h = E.split_task(d["task_id"])
                tt = pd.Timestamp(d["target_time"])
                act = g[target].get(tt) if tt in g.index else None
                if act is None or act != act:
                    n_pending += 1
                    continue
                n_matured += 1
                rec = per.setdefault(d["task_id"], {"sensor": target, "horizon_h": h, "n": 0, "n_synthetic": 0, "abs_err": {}})
                rec["n"] += 1
                rec["n_synthetic"] += 1 if d.get("contains_synthetic") else 0
                for k, v in d["predictions"].items():
                    if v is not None:
                        rec["abs_err"].setdefault(k, []).append(abs(float(v) - float(act)))
            tasks = []
            for tid, rec in per.items():
                mae = {k: float(np.mean(v)) for k, v in rec["abs_err"].items()}
                base = mae.get("persistence")
                tasks.append({"task_id": tid, "sensor": rec["sensor"], "horizon_h": rec["horizon_h"], "n_matured": rec["n"], "n_synthetic": rec["n_synthetic"], "mae": mae,
                              "rel_to_persistence": {k: (None if not base else 1 - v / base) for k, v in mae.items() if k != "persistence"}})
            return {"dataset_id": did, "n_matured": n_matured, "n_pending": n_pending, "tasks": sorted(tasks, key=lambda x: x["task_id"]),
                    "note": "只是『流程是否持續正常運作』的監測。資料含合成（模擬）列時，這些誤差不是模型效能證據，也不能用來宣稱任何模型較好。"}

    # ------------------------------------------------------------------ 狀態
    def versions(self, did: str) -> list[dict]:
        s = self.store(did)
        cur = s.current_seq()
        return [{"seq": v["seq"], "version_id": v["version_id"], "created_at": v["created_at"], "rows_added": v["rows_added"], "source": v["source"], "approved_by": v["approved_by"],
                 "time_range": v["time_range"], "synthetic_marked": v["synthetic_marked"], "is_current": v["seq"] == cur} for v in s.versions()]

    def pending(self, did: str) -> list[dict]:
        s = self.store(did)
        done = {v["upload_sha256"] for v in s.versions()}
        out = []
        for d in sorted(s.qdir.glob("up-*")):
            rp = d / "report.json"
            if not rp.is_file():
                continue
            rep = json.loads(rp.read_text(encoding="utf-8"))
            if rep.get("upload_sha256") in done or rep.get("status") != "READY":
                continue                                                  # 已提交的、被拒絕的、沒有新資料的：不是『等人處理』
            out.append({"upload_id": d.name, "status": rep["status"], "n_block": rep["n_block"], "n_warn": rep["n_warn"], "filename": rep["filename"], "staged_at": rep.get("staged_at"),
                        "blocks": [f["message"] for f in rep["findings"] if f["severity"] == "BLOCK"][:3]})
        return out

    def status(self, did: str, verify: bool = False) -> dict:
        with self.lock(did):
            store = self.store(did)
            st = self._state(did)
            seq = store.current_seq()
            vid = store.version_id(seq)
            g, src = AN6.grid(store, seq)
            have = g.index[g.notna().any(axis=1)]
            data_end = have.max() if len(have) else None
            clk = self.clock(did)
            stale_h = None if data_end is None else round((clk - data_end) / pd.Timedelta(hours=1), 1)
            fresh = "unknown" if stale_h is None else ("fresh" if stale_h <= STALE_AFTER_H else "stale")
            lat = self.latest(did)
            fc_ok = bool(lat) and lat.get("data_version") == vid
            pend = self.pending(did)
            flags = []
            if fresh == "stale":
                flags.append({"code": "data_stale", "text": f"最後一筆資料距目前時鐘 {stale_h} 小時（監測設定：超過 {STALE_AFTER_H:g} 小時視為過舊；這是營運設定，不是門檻判斷）"})
            if lat is not None and lat.get("guard") and not lat["guard"].get("alerts_ok"):
                flags.append({"code": "guard_unavailable", "text": f"適用性守門的『候選警報檢查』不可用（{lat['guard'].get('error')}）：預測不會因資料品質事件而降級，請修復後再使用"})
            if lat is None:
                flags.append({"code": "no_forecast", "text": "還沒有產生過預測"})
            elif not fc_ok:
                flags.append({"code": "forecast_behind", "text": f"預測是依據版本 {lat.get('data_version')} 算的，目前資料版本是 {vid}：需要重算"})
            if pend:
                flags.append({"code": "pending_uploads", "text": f"有 {len(pend)} 個上傳停在隔離區，等待人員處理"})
            if st.get("last_error"):
                flags.append({"code": "last_error", "text": f"最近一次匯入失敗：{st['last_error'].get('message')}"})
            integrity = None
            if verify:
                try:
                    integrity = store.verify()
                except Exception as e:  # noqa: BLE001
                    integrity = {"ok": False, "error": type(e).__name__}
            src_now = src.loc[have.max()] if len(have) else None
            return {"schema": "aide-live-status-v1", "dataset_id": did, "stem": self.stem(did), "current_seq": seq, "version_id": vid, "n_versions": len(store.versions()),
                    "data_end": None if data_end is None else str(data_end), "rows": int(len(have)), "latest_source": src_now, "mode": st["mode"], "clock": str(clk), "staleness_h": stale_h, "freshness": fresh,
                    "stale_after_h": STALE_AFTER_H, "forecast": None if lat is None else {"data_version": lat["data_version"], "issued_at": lat["issued_at"], "n_ok": lat["n_ok"], "n_refused": lat["n_refused"], "n_error": lat["n_error"], "up_to_date": fc_ok},
                    "pending_uploads": len(pend), "counters": {k: st.get(k, 0) for k in ("ingest_count", "refused_count", "held_count")}, "last_ingest_at": st.get("last_ingest_at"), "last_error": st.get("last_error"),
                    "flags": flags, "health": "ok" if not flags else "attention", "integrity": integrity, "live_version": LIVE_VERSION}

    def events(self, did: str, limit: int = 100) -> list[dict]:
        p = self._ldir(did) / "events.jsonl"
        if not p.is_file():
            return []
        out = []
        for ln in p.read_text(encoding="utf-8").splitlines()[-max(1, min(limit, 1000)):]:
            try:
                out.append(json.loads(ln))
            except Exception:  # noqa: BLE001
                continue
        return out
