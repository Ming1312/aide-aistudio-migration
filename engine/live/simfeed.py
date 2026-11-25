"""
live/simfeed.py — 模擬資料流（沒有真實即時資料來源時，用它讓整條管線真的跑起來）

* 資料由既有的合成資料產生器（p586_synth）產生：以各場域真實資料估計特性（日夜週期、感測器相依、自相關、值域），
  每一列都帶 SYNTHETIC 標記，匯入時被版本庫標成 source=synthetic；預測因此一律帶『合成資料』橫幅。
* 確定性：同一場域、同一位置永遠得到逐位元相同的資料。『下一批從哪裡開始』由版本庫目前的資料終點決定，
  所以回復到舊版本後，餵入的就是同樣的列（匯入是冪等的，不會重複）。
* 可注入事件情境（缺值、卡值、斷線…），用來驗證守門與適用性警告；情境真值不會被管線讀取。
* 這不是真實資料，也不能證明任何模型在真實世界的表現。
"""
from __future__ import annotations

import dataclasses
import zlib

import pandas as pd

import p586_synth as SY

from .service import LiveError, LiveService

SEGMENT_H = 24 * 14
BASE_SEED = 20260101


class SimFeed:
    def __init__(self, svc: LiveService, hours_per_tick: int = 12):
        self.svc = svc
        self.hours = int(hours_per_tick)
        self._cache: dict[tuple[str, int], SY.Batch] = {}

    def _segment(self, did: str, k: int) -> SY.Batch:
        key = (did, k)
        if key not in self._cache:
            stem = self.svc.stem(did)
            P = SY.profile(stem)
            start = P.last_ts + pd.Timedelta(hours=1) + pd.Timedelta(hours=SEGMENT_H * k)
            seed = BASE_SEED + zlib.crc32(stem.encode()) % 1000 + k
            self._cache[key] = SY.generate(stem, seed, hours=SEGMENT_H, scenarios=("normal",), start=start, tag=f"live{k}")
            if len(self._cache) > 24:
                self._cache.pop(next(iter(self._cache)))
        return self._cache[key]

    def _next_start(self, did: str) -> pd.Timestamp:
        store = self.svc.store(did)
        seq = store.current_seq()
        import p586_analysis as AN6
        g, _ = AN6.grid(store, seq)
        have = g.index[g.notna().any(axis=1)]
        return have.max() + pd.Timedelta(hours=1)

    def next_batch(self, did: str, hours: int | None = None, scenario: str | None = None) -> tuple[bytes, str, dict]:
        stem = self.svc.stem(did)
        hours = int(hours or self.hours)
        start = self._next_start(did)
        P = SY.profile(stem)
        if scenario and scenario != "normal":
            seed = BASE_SEED + 7919 + zlib.crc32(f"{stem}:{start}:{scenario}".encode()) % 100000
            b = SY.generate(stem, seed, hours=hours, scenarios=(scenario,), start=start, tag=f"ev-{scenario}")
        else:
            off = int((start - (P.last_ts + pd.Timedelta(hours=1))) / pd.Timedelta(hours=1))
            seg = off // SEGMENT_H
            s0 = off - seg * SEGMENT_H
            full = self._segment(did, seg)
            part = full.df.iloc[s0:s0 + hours]
            if len(part) < hours:                                         # 跨段：補下一段的開頭
                nxt = self._segment(did, seg + 1).df.iloc[: hours - len(part)]
                part = pd.concat([part, nxt])
            b = dataclasses.replace(full, df=part.reset_index(drop=True), batch_id=f"{full.batch_id}-{start:%Y%m%d%H}-{hours}h", extra_rows=None, late=None, truth=[])
        text = SY.batch_csv_text(b)
        t_end = pd.Timestamp(b.df["timestamp"].max())
        return text.encode("utf-8"), f"{b.batch_id}.csv", {"start": str(start), "end": str(t_end), "hours": int(len(b.df)), "scenario": scenario or "normal", "batch_id": b.batch_id}

    def tick(self, did: str, hours: int | None = None, scenario: str | None = None, approver: str = "sim-feed", advance_clock: bool = True) -> dict:
        raw, name, meta = self.next_batch(did, hours, scenario)
        res = self.svc.ingest(did, raw, name, "synthetic", "模擬資料流（本機產生，非真實資料；SYNTHETIC 標記）", approver)
        if advance_clock and res.get("committed"):
            self.svc.set_sim_clock(did, meta["end"])
        return {"batch": meta, **res}
