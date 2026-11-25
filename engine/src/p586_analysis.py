"""
p586_analysis.py — Phase 5.8.6：資料更新後的分析更新（概況、品質、異常）

* 輸入一律是『版本庫某一版』（原始唯讀資料＋追加列）；快取鍵含版本 id 與 canonical 雜湊，版本一變就重算，回復舊版本即得到舊結果。
* 不讀情境真值；不改任何既有研究結果（只在記憶體中計算，或由工具寫到 outputs/phase5_8_6/）。
"""
from __future__ import annotations

import pandas as pd

import p55_quality as QL
import p586_anomaly as AM
import p586_store as ST

_CACHE: dict = {}


def _key(store: ST.Store, seq: int, what: str):
    if seq == 0:
        sha = store.real_sha16()
    else:
        sha = next(v["canonical_sha256"] for v in store.versions() if v["seq"] == seq)
    return (str(store.base), seq, sha, what)


def grid(store: ST.Store, seq: int | None = None) -> tuple[pd.DataFrame, pd.Series]:
    """延伸後的每小時資料格（缺的小時是 NaN）＋每小時的來源標記（real／synthetic／unverified_import／missing）。"""
    seq = store.current_seq() if seq is None else int(seq)
    k = _key(store, seq, "grid")
    if k not in _CACHE:
        ext = store.extended(seq)
        e = ext.drop_duplicates("timestamp", keep="first")
        g = QL.hourly_frame(e[["timestamp"] + store.cols])
        src = e.set_index("timestamp")["_source"].reindex(g.index).fillna("missing")
        _CACHE.clear() if len(_CACHE) > 40 else None
        _CACHE[k] = (g, src)
    return _CACHE[k]


def new_data_start(store: ST.Store, seq: int | None = None):
    rows = store.load_rows(seq)
    return None if rows.empty else pd.Timestamp(rows["timestamp"].min())


def overview(store: ST.Store, seq: int | None = None) -> dict:
    seq = store.current_seq() if seq is None else int(seq)
    g, src = grid(store, seq)
    real_n = int((src == "real").sum())
    return {"seq": seq, "version_id": store.version_id(seq), "hours_total": int(len(g)), "rows_real": real_n, "rows_appended": int(src.isin(["synthetic", "unverified_import"]).sum()),
            "rows_by_source": src.value_counts().to_dict(), "range": [str(g.index.min()), str(g.index.max())], "appended_range": None if new_data_start(store, seq) is None else [str(new_data_start(store, seq)), str(g.index.max())],
            "contains_synthetic": bool((src == "synthetic").any()), "missing_hours_after_real": int(((src == "missing") & (g.index > src[src == "real"].index.max())).sum())}


def quality_table(store: ST.Store, seq: int | None = None) -> pd.DataFrame:
    """每個感測器：原始期間 vs 追加期間 的筆數、缺值率、平均、標準差、範圍（只描述，不判斷好壞）。"""
    seq = store.current_seq() if seq is None else int(seq)
    g, src = grid(store, seq)
    new = g[src.isin(["synthetic", "unverified_import", "missing"]) & (g.index > src[src == "real"].index.max())]
    old = g[src == "real"]
    rows = []
    for c in store.cols:
        a, b = old[c], new[c]
        rows.append({"sensor": c, "real_n": int(a.notna().sum()), "new_n": int(b.notna().sum()), "new_missing_rate": round(float(b.isna().mean()), 3) if len(b) else float("nan"),
                     "real_mean": float(a.mean()), "new_mean": float(b.mean()) if b.notna().any() else float("nan"), "real_sd": float(a.std()), "new_sd": float(b.std()) if b.notna().sum() > 1 else float("nan"),
                     "new_min": float(b.min()) if b.notna().any() else float("nan"), "new_max": float(b.max()) if b.notna().any() else float("nan")})
    return pd.DataFrame(rows)


def anomalies(store: ST.Store, seq: int | None = None) -> dict:
    seq = store.current_seq() if seq is None else int(seq)
    k = _key(store, seq, "anomaly")
    if k not in _CACHE:
        g, _ = grid(store, seq)
        t0 = new_data_start(store, seq)
        _CACHE[k] = AM.analyze(g, store.stem, t_from=t0) if t0 is not None else {"events": pd.DataFrame(columns=AM.EVENT_COLS), "info": {"unmonitorable": []}, "t_from": None, "n_hours": 0, "disclaimer": AM.analyze.__doc__ or ""}
    return _CACHE[k]


def version_table(store: ST.Store) -> pd.DataFrame:
    cur = store.current_seq()
    rows = [{"seq": 0, "version_id": store.version_id(0), "created_at": "—", "source": "real（原始資料，唯讀）", "rows_added": 0, "time_range": "—", "approved_by": "—", "is_current": cur == 0}]
    for v in store.versions():
        rows.append({"seq": v["seq"], "version_id": v["version_id"], "created_at": v["created_at"], "source": v["source"] + ("（合成）" if v["synthetic_marked"] else ""), "rows_added": v["rows_added"],
                     "time_range": f"{v['time_range'][0][:16]} → {v['time_range'][1][:16]}", "approved_by": v["approved_by"], "is_current": v["seq"] == cur})
    return pd.DataFrame(rows)


# ============================================================ Phase 5.8.7：三類問題分開（資料品質／異常訊號／模型過舊）
STALE_DAYS = 60


def alerts(store: ST.Store, seq: int | None = None) -> dict:
    """v2 偵測（每個場域、每個感測器各自校準；p587_detect）。快取鍵含版本。回傳 {alerts, suppressed, info, t_from, disclaimer}。"""
    import p587_detect as D
    seq = store.current_seq() if seq is None else int(seq)
    k = _key(store, seq, "alerts_v2")
    if k not in _CACHE:
        g, _ = grid(store, seq)
        t0 = new_data_start(store, seq)
        if t0 is None:
            empty = pd.DataFrame(columns=["system", "category", "kind", "column", "start", "end", "detected_at", "score", "note", "detector", "ratio"])
            _CACHE[k] = {"alerts": empty, "suppressed": pd.DataFrame(columns=["column", "start", "end", "reason", "kind"]), "info": {"stuck_undetectable": [], "relation_unmonitorable": []}, "t_from": None, "disclaimer": ""}
        else:
            _CACHE[k] = D.analyze(g, store.stem, t_from=t0)
    return _CACHE[k]


def import_layer_issues(store: ST.Store, seq: int | None = None) -> pd.DataFrame:
    """各版本在匯入時處理掉的重複／衝突列（資料品質問題；來自版本紀錄，不讀情境真值）。"""
    seq = store.current_seq() if seq is None else int(seq)
    rows = []
    for v in store.versions():
        if v["seq"] <= seq and (v["rows_dup_identical"] or v["rows_conflict"] or v["rows_updated"]):
            rows.append({"版本": f"v{v['seq']:04d}", "來源檔": v["filename"], "完全相同的重複列（已去重）": v["rows_dup_identical"], "同時間但數值不同的衝突列": v["rows_conflict"], "補進缺值的更新列": v["rows_updated"]})
    return pd.DataFrame(rows)


def model_staleness(store: ST.Store, seq: int | None = None) -> pd.DataFrame:
    """既有研究模型相對於『目前資料版本』的陳舊度：獨立於任何異常警報。"""
    import p582_engine as E
    import p586_forecast as FC
    seq = store.current_seq() if seq is None else int(seq)
    g, _ = grid(store, seq)
    end = g.index.max()
    rows = []
    for t in FC.tasks(store.stem):
        ref = FC.train_ref(store, t)
        days = (end - ref["train_end"]) / pd.Timedelta(days=1)
        rows.append({"task": t, "sensor": E.split_task(t)[1], "horizon_h": E.split_task(t)[2], "model_trained_through": ref["train_end"], "data_through": end, "staleness_days": round(float(days), 1), "stale": bool(days > STALE_DAYS)})
    return pd.DataFrame(rows)


def triage(store: ST.Store, seq: int | None = None) -> dict:
    """把『模型過舊』『資料品質問題』『異常訊號』分成三組（互不混在一起）；被其他感測器解釋的環境變化另外列出（不警報）。"""
    seq = store.current_seq() if seq is None else int(seq)
    res = alerts(store, seq)
    a = res["alerts"]
    stale = model_staleness(store, seq)
    return {"data_quality": a[a["category"] == "data_quality"].reset_index(drop=True) if len(a) else a, "import_issues": import_layer_issues(store, seq), "signal": a[a["category"] == "signal"].reset_index(drop=True) if len(a) else a,
            "model_stale": stale, "environment": res["suppressed"], "info": res["info"], "disclaimer": res["disclaimer"]}
