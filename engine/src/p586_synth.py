"""
p586_synth.py — Phase 5.8.6：合成感測資料產生器（本機；只用來測試『持續資料更新』流程，不是真實資料）

設計
  * 只『唯讀』載入七份原始 CSV 來估計每個場域的特性（邊際分布、日夜週期、感測器之間的相依、自相關、累積計數器行為）。
    不寫回、不改動原始檔。
  * 方法：潛在驅動（溫度／日照／濕度／風）→ 每個感測器以 Gaussian copula + 經驗分位數映射到『真實資料的值域與離散度』；
    日夜週期的峰值時間、振幅、雲量逐日隨機；天氣用慢速 AR(1)；加入趨勢轉折；每欄有自己的 AR 噪音。
  * 情境（正常／不規則週期／趨勢轉折／正常但不尋常／關係改變／緩慢漂移／校正跳階／短事件／卡值／缺值／斷線／重複／延遲／混合）
    在『值域』或『驅動層』注入，並寫下**獨立的情境真值**（data/synthetic_truth/，匯入／分析／預測模組一律不讀）。
  * 固定種子：同一組 (場域, 種子, 情境, 起點, 長度) 永遠得到逐位元相同的資料。
  * 輸出檔頭有 `SYNTHETIC` 標記列；批次檔與原始資料隔離（data/synthetic_batches/）。
  * 物理合理性的約束（相對濕度≤100、PM10≥PM2.5、THI 公式…）由 p586_plausibility.enforce 統一執行。

注意：合成資料『不是』真實資料；不得用來證明任何模型在真實世界的表現。
"""
from __future__ import annotations

import hashlib
import json
import os
import zlib
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.stats import norm

import domain_schema as DS
import p55_quality as QL

ROOT = Path(__file__).resolve().parent.parent
BATCH_DIR = ROOT / "data" / "synthetic_batches"
TRUTH_DIR = ROOT / "data" / "synthetic_truth"
GENERATOR_VERSION = "p586-synth-v2"
SYNTH_MARK = "SYNTHETIC"

SCENARIOS = {
    "normal": "一般正常（日夜週期、天氣變化、隨機波動）",
    "irregular_cycle": "不規則週期（日夜振幅與峰值時間逐日變化、偶爾相位偏移）",
    "trend_change": "趨勢轉折（環境水準長期位移；不是故障）",
    "unusual_benign": "正常但不尋常（熱浪／鋒面暴雨／假日低負載；不應當成故障警報）",
    "relationship_change": "感測器關係改變（原本連動的感測器脫鉤）",
    "slow_drift": "感測器緩慢漂移（簡單門檻看不出來）",
    "calibration_step": "校正跳階（固定偏移量）",
    "short_event": "短事件（1–4 小時的尖峰或下探）",
    "stuck_sensor": "卡值（讀值不再變動）",
    "missing": "缺值（單格缺值與連續缺值區塊）",
    "outage": "斷線／斷電（整列缺失，或整列歸零）",
    "duplicate": "重複列（完全相同，與時間相同但值不同的衝突列）",
    "delayed": "延遲到達（先到的批次缺一段，之後才補上）",
    "mixed": "混合（多種事件同時出現）",
    # ---- Phase 5.8.7：『留存驗證專用』情境（偵測器設計與調參期間不得使用；形狀與前面的情境不同）
    "exp_drift": "加速漂移（指數成長的偏移）",
    "intermittent_stuck": "間歇卡值（同一感測器反覆卡住 7–12 小時，共 3 次）",
    "multi_spike": "多感測器同時尖峰（2–3 個感測器同一時段）",
    "transient_step": "暫時性偏移（偏移 3–5 天後自行回復）",
    "noisy_sensor": "雜訊變大（平均不變、變異變大 4–7 天）",
}
HELDOUT_SCENARIOS = ("exp_drift", "intermittent_stuck", "multi_spike", "transient_step", "noisy_sensor")
MIXED_PARTS = ("irregular_cycle", "slow_drift", "short_event", "missing", "duplicate", "unusual_benign")

# 驅動代理欄（真實資料中代表溫度／濕度／風速的欄位）
DRIVERS = {
    "羊舍": {"T": "成羊區平均溫度", "H": "成羊區平均濕度", "W": "風速"},
    "專家系統": {"T": "OA4 溫度", "H": "OA4 濕度", "W": "UW485 風速"},
    "三爺宮溪": {"T": "水溫"},
    "工地微氣候": {"T": "溫度", "H": "濕度", "W": "風速"},
    "東北角": {"T": "TEMP", "H": "RH", "W": "風速"},
    "育成一厰": {"T": "TEMP", "H": "RH", "W": "風速"},
    "育成北側": {"T": "溫度", "H": "濕度", "W": "風速"},
}
# 各場域可注入異常的感測器（依領域意義挑選；不存在的欄位會被略過）
TARGETS = {
    "羊舍": dict(drift=["ID4-溫度", "ID4-濕度", "ID4-CO2"], spike=["ID4-CO2", "成羊區平均CO2", "成羊區平均濕度"], stuck=["ID4-溫度", "ID4-CO2"], step=["ID4-CO2", "ID4-濕度"]),
    "專家系統": dict(drift=["pH1 即時值", "DO1 即時值", "ORP1 即時值", "SC1 即時值"], spike=["SC1 即時值", "DO2 即時值", "CPM 系統總和功率"], stuck=["pH2 即時值", "DO3 即時值", "水位高度"], step=["pH3 即時值", "ORP3 即時值"]),
    "三爺宮溪": dict(drift=["pH", "EC", "DO"], spike=["EC", "DO"], stuck=["pH", "水溫"], step=["pH", "EC"]),
    "工地微氣候": dict(drift=["溫度", "濕度", "噪音"], spike=["PM2.5", "PM10", "噪音"], stuck=["溫度", "濕度"], step=["溫度", "PM10"]),
    "東北角": dict(drift=["TEMP", "RH", "PM2.5"], spike=["PM2.5", "CO", "TVOC", "PM10"], stuck=["TEMP", "RH"], step=["PM10", "TEMP"]),
    "育成一厰": dict(drift=["TEMP", "RH", "PM2.5"], spike=["PM2.5", "CO", "TVOC(PID)", "PM10"], stuck=["TEMP", "RH"], step=["PM10", "TEMP"]),
    "育成北側": dict(drift=["溫度", "濕度", "PM2.5"], spike=["PM2.5", "CO", "PM10"], stuck=["溫度", "濕度"], step=["PM10", "溫度"]),
}
SIBLING_MIN_CORR = 0.7        # 只有真正緊密連動的同類感測器才當作父節點（避免把無關感測器的雜訊借進來）
NEG_SPIKE = ("DO",)          # 溶氧類的短事件是『下探』（例如曝氣停止），其餘是尖峰


# ============================================================ 場域特性（唯讀估計）
@dataclass
class ColProf:
    name: str
    kind: str                          # const | alias | cumulative | discrete | angle | cont
    alias_of: str | None = None
    const: float = 0.0
    probs: np.ndarray | None = None
    q: np.ndarray | None = None
    levels: np.ndarray | None = None
    cum: np.ndarray | None = None
    decimals: int = 2
    lo: float = 0.0
    hi: float = 0.0
    mean: float = 0.0
    sd: float = 0.0
    beta: dict = field(default_factory=dict)
    r2: float = 0.0
    phi: float = 0.5
    last: float = float("nan")
    ns_last: float = float("nan")


@dataclass
class Profile:
    stem: str
    cols: list
    prof: dict
    raw_sha16: str
    last_ts: pd.Timestamp
    zT_last: float
    sd_T_raw: float = 1.0
    rho_TS: float = 0.5                      # 真實資料中『溫度（排名正規分數）與日照形狀』的相關：決定日夜週期占溫度變異的比重
    clean: pd.DataFrame | None = None       # 去除『整列歸零（斷線）』後的真實小時資料（只供特性估計與相似度比較）


def _ns(s: pd.Series) -> pd.Series:
    r = s.rank(method="average")
    n = int(r.notna().sum())
    return pd.Series(norm.ppf((r - 0.5) / max(n, 1)), index=s.index)


def _decimals(v: np.ndarray) -> int:
    for d in range(0, 5):
        if np.allclose(np.round(v, d), v, atol=1e-9):
            return d
    return 4


def _ac1(x: np.ndarray) -> float:
    x = x[~np.isnan(x)]
    if len(x) < 30 or np.std(x) == 0:
        return 0.5
    return float(np.clip(np.corrcoef(x[:-1], x[1:])[0, 1], 0.0, 0.9995))


def _daylight(hr: np.ndarray) -> np.ndarray:
    return np.clip(np.sin(np.pi * (hr - 6.0) / 12.0), 0, None)


_SD_DAYLIGHT = float(_daylight(np.arange(24)).std())
_MU_DAYLIGHT = float(_daylight(np.arange(24)).mean())


def _std_daylight(hr: np.ndarray) -> np.ndarray:
    return (_daylight(hr) - _MU_DAYLIGHT) / _SD_DAYLIGHT


@lru_cache(maxsize=8)
def _profile_cached(stem: str, raw_sha16: str) -> Profile:
    df, _ = DS.load_domain(stem)
    g = QL.hourly_frame(df)
    cols = list(g.columns)
    drv0 = DRIVERS[stem]
    mono = [c for c in cols if (g[c].diff().dropna() >= 0).mean() > 0.99 and g[c].nunique() > 3]
    pos = [c for c in cols if g[c].median() > 0 and c not in mono and g[c].nunique() > 12]
    out = ((g[pos] == 0).sum(axis=1) / max(len(pos), 1) >= 0.5) if len(pos) >= 3 else pd.Series(False, index=g.index)
    zt = (g[drv0["T"]] == 0) & ((g[drv0["H"]] == 0) if drv0.get("H") else True)
    out = out | zt                                                    # 溫度與濕度同時為 0＝感測器斷線的假讀值
    cl = g.copy()
    cl.loc[out.to_numpy()] = np.nan                                  # 真實資料裡的整列歸零（斷線）不當作正常分布
    for c in cols:                                                   # 單一感測器的假零值（讀值從不接近 0 的量，如氣壓、溫度、pH）
        v = cl[c]
        nz = v[v != 0].dropna()
        zf = float((v == 0).mean())
        if 0 < zf < 0.3 and len(nz) > 50 and nz.median() > 0 and nz.quantile(0.01) > 0.15 * nz.median():
            cl.loc[v == 0, c] = np.nan
    hr = g.index.hour.to_numpy()
    zS = pd.Series(_std_daylight(hr), index=g.index)
    drv = DRIVERS[stem]
    prof: dict[str, ColProf] = {}
    ns: dict[str, pd.Series] = {}
    prev: list[str] = []
    for c in cols:
        v = cl[c]
        vv = v.dropna()
        cp = ColProf(c, "cont")
        if len(vv) < 10 or vv.nunique() <= 1:
            cp.kind, cp.const = "const", float(vv.iloc[-1]) if len(vv) else 0.0
            prof[c] = cp
            prev.append(c)
            continue
        alias = None
        if vv.nunique() > 3:
            for b in prev:
                if prof[b].kind in ("const", "alias"):
                    continue
                w = pd.concat([v, cl[b]], axis=1).dropna()
                if len(w) > 20 and (w.iloc[:, 0] == w.iloc[:, 1]).mean() >= 0.99:
                    alias = b
                    break
        if alias:
            cp.kind, cp.alias_of = "alias", alias
            prof[c] = cp
            prev.append(c)
            continue
        d = v.diff()
        dd = d.dropna()
        cp.decimals = _decimals(vv.to_numpy())
        cp.lo, cp.hi = float(vv.quantile(0.0005)), float(vv.quantile(0.9995))
        cp.mean, cp.sd = float(vv.mean()), float(vv.std())
        cp.last = float(g[c].dropna().iloc[-1]) if g[c].notna().any() else float("nan")
        if (dd >= 0).mean() > 0.99 and vv.max() > vv.min() and (vv.nunique() > 12 or any(k in c for k in ("次數", "電度", "時間"))):
            cp.kind = "cumulative"
            inc = d.clip(lower=0)
            base = inc
        elif vv.nunique() <= 12:
            cp.kind = "discrete"
            base = v
        elif "風向" in c:
            cp.kind = "angle"
            base = v
        else:
            base = v
        bv = base.dropna()
        if cp.kind == "discrete":
            lv, cn = np.unique(bv.to_numpy(), return_counts=True)
            cp.levels, cp.cum = lv, np.cumsum(cn) / cn.sum()
        else:
            p = np.linspace(0.002, 0.998, 300)
            cp.probs = np.r_[0.0, p, 1.0]
            cp.q = np.r_[bv.quantile(0.0005), bv.quantile(p).to_numpy(), bv.quantile(0.9995)]
            if cp.kind == "cumulative":
                cp.decimals = _decimals(bv.to_numpy())
        ns[c] = _ns(base)
        prof[c] = cp
        prev.append(c)
    # --- 稀疏的高斯連結（copula）結構：每個感測器對『驅動（溫度、日照、濕度、風）』與『已生成的最相關同類感測器（最多 4 個）』做迴歸
    #     這樣同一物理量的多個感測器（例如 ID4 溫度與成羊區平均溫度）會像真實資料一樣緊密連動，而不是各自獨立的雜訊。
    Tc, Hc, Wc = drv["T"], drv.get("H"), drv.get("W")
    order = [Tc] + [c for c in (Hc, Wc) if c] + [c for c in cols if c not in (Tc, Hc, Wc)]
    srcs: dict[str, pd.Series] = {"S": zS}
    for c in order:
        cp = prof[c]
        if cp.kind in ("const", "alias") or c not in ns:
            continue
        y = ns[c]
        if c == Tc:
            cp.beta, cp.r2, cp.phi = {}, 1.0, _ac1(y.to_numpy())
            srcs[c] = y
            continue
        parents = [Tc, "S"] + ([Hc] if (Hc and c not in (Hc, Wc)) else []) + ([Wc] if (Wc and c not in (Hc, Wc)) else [])
        if c not in (Hc, Wc):
            cand = []
            for o in srcs:
                if o in parents or o == "S" or prof[o].kind not in ("cont", "angle"):
                    continue
                w0 = pd.concat([y, srcs[o]], axis=1).dropna()
                if len(w0) > 200 and w0.iloc[:, 0].std() > 0 and w0.iloc[:, 1].std() > 0:
                    cand.append((abs(float(w0.iloc[:, 0].corr(w0.iloc[:, 1]))), o))
            parents += [o for cc, o in sorted(cand, reverse=True)[:4] if cc >= SIBLING_MIN_CORR]
        X = pd.concat({k: srcs[k] for k in parents}, axis=1)
        w = pd.concat([y.rename("__y"), X], axis=1).dropna()
        if len(w) < 50:
            cp.beta, cp.r2, cp.phi = {}, 0.0, 0.5
            srcs[c] = y
            continue
        A = w[parents].to_numpy()
        beta = np.linalg.solve(A.T @ A + 1e-3 * len(w) * np.eye(A.shape[1]), A.T @ w["__y"].to_numpy())
        res = w["__y"].to_numpy() - A @ beta
        r2 = float(max(0.0, 1 - res.var() / max(w["__y"].var(), 1e-9)))
        tot = float(np.sum(beta ** 2))
        if tot > 0.995:
            beta = beta * np.sqrt(0.995 / tot)
            r2 = min(r2, 0.995)
        cp.beta, cp.r2 = dict(zip(parents, [float(v) for v in beta])), r2
        full = pd.Series(np.nan, index=g.index)
        full.loc[w.index] = res
        cp.phi = _ac1(full.to_numpy())
        srcs[c] = y
    for c in cols:                                                   # 很平滑的慢變量（水位、氣壓、探頭水溫…）：排名轉換會把小幅抖動放大，改以原始值的自相關為下限
        cp = prof[c]
        if cp.kind in ("cont", "angle") and c in ns:
            raw_ac = _ac1(cl[c].to_numpy(float))
            if raw_ac > 0.95:
                cp.phi = max(cp.phi, raw_ac)
    zT = ns[Tc]
    # 真實資料尾端的狀態（讓追加的合成資料從真實資料『接續』）
    last_ts = g.index[-1]
    zt_tail = zT.dropna().iloc[-6:]
    for c, cp in prof.items():
        if c in ns and ns[c].notna().any():
            cp.ns_last = float(ns[c].dropna().iloc[-1])
    return Profile(stem, cols, prof, DS.dataset_fingerprint(DS.spec_for(stem)), last_ts, float(zt_tail.mean()) if len(zt_tail) else 0.0, rho_TS=float(np.clip(pd.concat([ns[Tc], zS], axis=1).dropna().corr().iloc[0, 1], 0.05, 0.95)), clean=cl)


def profile(stem: str) -> Profile:
    return _profile_cached(stem, DS.dataset_fingerprint(DS.spec_for(stem)))


# ============================================================ 驅動與欄位生成
def _ar1(rng, n: int, phi: float, x0: float = 0.0) -> np.ndarray:
    """單位變異數的 AR(1)。"""
    e = rng.standard_normal(n) * np.sqrt(1 - phi ** 2)
    x = np.empty(n)
    prev = x0
    for i in range(n):
        prev = phi * prev + e[i]
        x[i] = prev
    return x


@lru_cache(maxsize=64)
def _driver_norm(amp_sd: float, jitter: float, a: float) -> tuple[float, float]:
    """以固定校準序列估計驅動原始值的平均與標準差（讓 zT 近似標準常態；不隨批次改變，趨勢才不會被抹平）。"""
    rng = np.random.default_rng(20260101)
    ts = pd.date_range("2026-01-01", periods=24 * 90, freq="h")
    raw = _driver_raw(rng, ts, amp_sd, jitter, 0.0, a)["T"]
    return float(raw.mean()), float(raw.std())


@lru_cache(maxsize=64)
def _calib_a(rho: float, amp_sd: float, jitter: float) -> float:
    """選日夜週期權重 a，使合成溫度與日照形狀的相關等於真實資料的相關 rho（二分搜尋；固定校準序列）。"""
    ts = pd.date_range("2026-01-01", periods=24 * 120, freq="h")

    def corr(a):
        r = _driver_raw(np.random.default_rng(777), ts, amp_sd, jitter, 0.0, a)
        return float(np.corrcoef(r["T"], _std_daylight(r["hr"]))[0, 1])
    lo, hi = 0.1, 4.0
    if corr(hi) < rho:
        return hi
    for _ in range(14):
        mid = (lo + hi) / 2
        lo, hi = (mid, hi) if corr(mid) < rho else (lo, mid)
    return round((lo + hi) / 2, 3)


@lru_cache(maxsize=1)
def _s_norm() -> tuple[float, float]:
    """有雲量的日照形狀（合成用）的平均與標準差：讓合成的 S 與真實迴歸用的『標準化日照』同尺度。"""
    ts = pd.date_range("2026-01-01", periods=24 * 200, freq="h")
    r = _driver_raw(np.random.default_rng(4242), ts, 0.18, 0.9, 0.0, 0.85)
    return float(r["S"].mean()), float(r["S"].std())


def _driver_raw(rng, ts: pd.DatetimeIndex, amp_sd: float, jitter: float, zT0: float, a: float = 0.85) -> dict:
    n = len(ts)
    hr = (ts.hour + ts.minute / 60).to_numpy()
    day = ((ts.normalize() - ts[0].normalize()).days).to_numpy()
    nd = int(day.max()) + 1
    peak = 14.0 + rng.normal(0, jitter, nd)
    amp = np.clip(np.exp(rng.normal(0, amp_sd, nd)), 0.25, 2.4)
    cloud = rng.beta(2, 3, nd)
    diurnal = amp[day] * np.cos(2 * np.pi * (hr - peak[day]) / 24.0) * (1 - 0.45 * cloud[day])
    syn = _ar1(rng, n, 0.985, 0.7 * zT0)
    noise = _ar1(rng, n, 0.6)
    T = a * diurnal + 0.95 * syn + 0.30 * noise
    Sraw = _daylight(hr) * (1 - 0.6 * cloud[day])
    return {"T": T, "S": Sraw, "cloud": cloud[day], "hr": hr, "day": day}


def _smooth(ts: pd.DatetimeIndex, t0, t1, ramp_h: float = 24.0, persist: bool = False) -> np.ndarray:
    """0→1 的平滑窗（半餘弦上升／下降）；persist=True 則上升後不再下降（趨勢轉折）。"""
    h = (ts - pd.Timestamp(t0)) / pd.Timedelta(hours=1)
    h = np.asarray(h, float)
    rise = np.clip(h / ramp_h, 0, 1)
    up = 0.5 - 0.5 * np.cos(np.pi * rise)
    if persist:
        return up
    L = (pd.Timestamp(t1) - pd.Timestamp(t0)) / pd.Timedelta(hours=1)
    fall = np.clip((h - (L - ramp_h)) / ramp_h, 0, 1)
    return up * (1 - (0.5 - 0.5 * np.cos(np.pi * fall)))


@dataclass
class Batch:
    stem: str
    batch_id: str
    df: pd.DataFrame                       # timestamp + 欄位（可含缺值）
    truth: list
    meta: dict
    extra_rows: pd.DataFrame | None = None  # 重複列（原樣附在檔案後面）
    late: "Batch | None" = None


def _rng_for(seed: int, stem: str, tag: str) -> np.random.Generator:
    return np.random.default_rng(np.random.SeedSequence([int(seed), zlib.crc32(stem.encode()), zlib.crc32(tag.encode())]))


def _gen_base(stem: str, seed: int, ts: pd.DatetimeIndex, cfg: dict, z_events: dict, tail_state: bool) -> pd.DataFrame:
    P = profile(stem)
    rng = _rng_for(seed, stem, "base")
    drv = DRIVERS[stem]
    n = len(ts)
    amp_sd, jitter = cfg["amp_sd"], cfg["jitter"]
    a_w = _calib_a(round(P.rho_TS, 2), round(amp_sd, 3), round(jitter, 3))
    mu, sd = _driver_norm(round(amp_sd, 3), round(jitter, 3), a_w)
    raw = _driver_raw(rng, ts, amp_sd, jitter, P.zT_last if tail_state else 0.0, a_w)
    zT = (raw["T"] - mu) / sd + z_events.get("dT", 0.0)
    S = (raw["S"] - _s_norm()[0]) / _s_norm()[1]
    src: dict[str, np.ndarray] = {"S": S, drv["T"]: zT}
    z: dict[str, np.ndarray] = {}
    out = {}
    Tc, Hc, Wc = drv["T"], drv.get("H"), drv.get("W")
    order = [Tc] + [c for c in (Hc, Wc) if c] + [c for c in P.cols if c not in (Tc, Hc, Wc)]
    rel = z_events.get("rel", {})
    for c in order:
        cp = P.prof[c]
        if cp.kind in ("const", "alias"):
            continue
        if c == Tc:
            zc = zT.copy()
        else:
            fitted = sum(b * src[k] for k, b in cp.beta.items() if k in src)
            if c == Hc:
                fitted = fitted + z_events.get("dH", 0.0)
            if c == Wc:
                fitted = fitted + z_events.get("dW", 0.0)
            scale = rel[c] if c in rel else np.ones(n)
            r2 = min(cp.r2, 0.995)
            idio = np.sqrt(np.maximum(1e-3, 1 - (scale ** 2) * r2))
            e0 = 0.0
            if tail_state and cp.phi > 0.98 and np.isfinite(cp.ns_last):
                f0 = float(np.asarray(fitted).ravel()[0]) if np.ndim(fitted) else float(fitted)
                e0 = float(np.clip((cp.ns_last - f0) / max(float(np.mean(idio)), 0.05), -3.5, 3.5))
            e = _ar1(rng, n, cp.phi, e0)
            zc = scale * fitted + idio * e
        z[c] = zc
        src[c] = zc
    for c in P.cols:
        cp = P.prof[c]
        if cp.kind == "const":
            out[c] = np.full(n, cp.const)
        elif cp.kind == "alias":
            continue
        else:
            u = norm.cdf(z[c])
            if cp.kind == "discrete":
                val = cp.levels[np.clip(np.searchsorted(cp.cum, u, side="left"), 0, len(cp.levels) - 1)]
            elif cp.kind == "cumulative":
                inc = np.round(np.interp(u, cp.probs, cp.q), cp.decimals)
                start = cp.last if np.isfinite(cp.last) else 0.0
                val = start + np.cumsum(np.clip(inc, 0, None))
            elif cp.kind == "angle":
                val = np.interp(u, cp.probs, cp.q) % 360.0
            else:
                val = np.round(np.interp(u, cp.probs, cp.q), cp.decimals)
            out[c] = np.asarray(val, float)
    for c in P.cols:
        if P.prof[c].kind == "alias":
            out[c] = out[P.prof[c].alias_of].copy()
    df = pd.DataFrame({"timestamp": ts, **{c: out[c] for c in P.cols}})
    return df


# ============================================================ 情境規劃與注入
def _pick(rng, names: list, avail) -> str | None:
    ok = [c for c in names if c in avail]
    return ok[int(rng.integers(len(ok)))] if ok else None


def _ev(batch_id, stem, scenario, typ, cat, cols, t0, t1, **kw) -> dict:
    return {"event_id": f"{batch_id}#{typ}#{pd.Timestamp(t0):%Y%m%d%H}#{'+'.join(cols)[:30]}", "batch_id": batch_id, "domain": stem, "scenario": scenario, "type": typ, "category": cat,
            "columns": list(cols), "start": str(pd.Timestamp(t0)), "end": str(pd.Timestamp(t1)), **kw}


def generate(stem: str, seed: int, hours: int = 24 * 21, scenarios=("normal",), start=None, intensity: float = 1.0, tag: str = "") -> Batch:
    """產生一個批次。同樣的參數永遠產生逐位元相同的結果。"""
    if isinstance(scenarios, str):
        scenarios = (scenarios,)
    scs: list[str] = []
    for s in scenarios:
        if s not in SCENARIOS:
            raise ValueError(f"未知情境：{s}")
        scs.extend(MIXED_PARTS if s == "mixed" else [s])
    P = profile(stem)
    st = (P.last_ts + pd.Timedelta(hours=1)) if start is None else pd.Timestamp(start).floor("h")
    ts = pd.date_range(st, periods=int(hours), freq="h")
    batch_id = f"SYNTH-{stem}-{'+'.join(dict.fromkeys(scenarios))}-s{seed}-{st:%Y%m%d%H}-{hours}h{('-' + tag) if tag else ''}"
    rng = _rng_for(seed, stem, "plan:" + "+".join(scs))
    avail = set(P.cols)
    tail_state = (st - P.last_ts) <= pd.Timedelta(hours=72) and st > P.last_ts
    cfg = {"amp_sd": 0.18, "jitter": 0.9}
    z_events: dict = {"dT": np.zeros(len(ts)), "dH": np.zeros(len(ts)), "dW": np.zeros(len(ts)), "rel": {}}
    truth: list[dict] = []
    value_ops: list = []           # (kind, col, t0, t1, magnitude)
    struct_ops: list = []
    L = len(ts)

    def when(frac_lo, frac_hi, dur_h):
        lo, hi = int(L * frac_lo), max(int(L * frac_hi) - int(dur_h), int(L * frac_lo) + 1)
        i0 = int(rng.integers(lo, max(hi, lo + 1)))
        return ts[min(i0, L - 1)], ts[min(i0 + int(dur_h) - 1, L - 1)]

    drv = DRIVERS[stem]
    for sc in scs:
        k = float(intensity)
        if sc == "irregular_cycle":
            cfg["amp_sd"], cfg["jitter"] = 0.45 * k, 2.2 * k
            t0, t1 = ts[0], ts[-1]
            truth.append(_ev(batch_id, stem, sc, "irregular_cycle", "benign_unusual", [drv["T"]], t0, t1, description="日夜振幅與峰值時間逐日變化（正常的不規則）", should_alert=False))
        elif sc == "trend_change":
            t0, t1 = when(0.3, 0.55, 24 * 4)
            amp = float(rng.choice([-1, 1])) * rng.uniform(0.9, 1.6) * k
            z_events["dT"] = z_events["dT"] + amp * _smooth(ts, t0, ts[-1], ramp_h=24 * 4, persist=True)
            truth.append(_ev(batch_id, stem, sc, "trend_change", "regime_change", [drv["T"]], t0, ts[-1], magnitude_sigma=round(amp, 2), description="環境水準轉折（相關感測器一起移動）", should_alert=False))
        elif sc == "unusual_benign":
            kind = str(rng.choice(["heatwave", "storm"] + (["holiday_low_load"] if stem == "專家系統" else [])))
            dur = int(rng.integers(48, 96)) if kind != "storm" else int(rng.integers(8, 20))
            t0, t1 = when(0.25, 0.7, dur)
            w = _smooth(ts, t0, t1, ramp_h=min(24, dur // 3))
            if kind == "heatwave":
                z_events["dT"] = z_events["dT"] + 2.1 * k * w
                z_events["dH"] = z_events["dH"] - 0.6 * w
            elif kind == "storm":
                z_events["dT"] = z_events["dT"] - 1.3 * k * w
                z_events["dH"] = z_events["dH"] + 1.4 * w
                z_events["dW"] = z_events["dW"] + 1.6 * w
            else:
                value_ops.append(("scale_prefix", "CPM", t0, t1, 0.55))
            truth.append(_ev(batch_id, stem, sc, kind, "benign_unusual", [drv["T"]] if kind != "holiday_low_load" else ["CPM*"], t0, t1, description="正常但不尋常的環境／負載變化", should_alert=False))
        elif sc == "relationship_change":
            cand = [c for c in P.cols if P.prof[c].kind in ("cont", "discrete") and c != drv["T"] and P.prof[c].r2 > 0.45]
            if cand:
                c = cand[int(rng.integers(len(cand)))]
                t0, _ = when(0.3, 0.5, 24)
                z_events["rel"][c] = 1 - _smooth(ts, t0, ts[-1], ramp_h=12, persist=True) * rng.uniform(0.85, 1.0)
                truth.append(_ev(batch_id, stem, sc, "relationship_change", "anomaly", [c], t0, ts[-1], description=f"{c} 與其他感測器的連動消失（數值仍在合理範圍）", should_alert=True))
        elif sc in ("slow_drift", "calibration_step", "short_event", "stuck_sensor"):
            key = {"slow_drift": "drift", "calibration_step": "step", "short_event": "spike", "stuck_sensor": "stuck"}[sc]
            col = _pick(rng, TARGETS[stem][key], avail)
            if col is None:
                continue
            cp = P.prof[col]
            sd_c = max(cp.sd, 1e-6)
            if sc == "slow_drift":
                t0, _ = when(0.1, 0.35, 24)
                tot = float(rng.choice([-1, 1])) * rng.uniform(1.6, 3.0) * sd_c * k
                value_ops.append(("drift", col, t0, ts[-1], tot))
                truth.append(_ev(batch_id, stem, sc, "slow_drift", "anomaly", [col], t0, ts[-1], total_shift_sigma=round(tot / sd_c, 2), per_day_sigma=round(tot / sd_c / ((ts[-1] - t0) / pd.Timedelta(days=1)), 3),
                                 description="緩慢漂移（每日位移遠小於單點雜訊）", should_alert=True))
            elif sc == "calibration_step":
                t0, _ = when(0.3, 0.55, 24)
                off = float(rng.choice([-1, 1])) * rng.uniform(1.4, 2.6) * sd_c * k
                value_ops.append(("step", col, t0, ts[-1], off))
                truth.append(_ev(batch_id, stem, sc, "calibration_step", "anomaly", [col], t0, ts[-1], shift_sigma=round(off / sd_c, 2), description="校正跳階：固定偏移", should_alert=True))
            elif sc == "short_event":
                for j in range(int(rng.integers(2, 4))):
                    col = _pick(rng, TARGETS[stem][key], avail)
                    dur = int(rng.integers(1, 5))
                    t0, t1 = when(0.1, 0.95, dur)
                    sign = -1.0 if col.startswith(NEG_SPIKE) else 1.0
                    mag = sign * rng.uniform(3.5, 6.0) * sd_c * k
                    value_ops.append(("spike", col, t0, t1, mag))
                    truth.append(_ev(batch_id, stem, sc, "short_event", "anomaly", [col], t0, t1, magnitude_sigma=round(mag / sd_c, 2), description="短暫尖峰／下探", should_alert=True))
            else:
                dur = int(rng.integers(12, 30))
                t0, t1 = when(0.2, 0.7, dur)
                value_ops.append(("stuck", col, t0, t1, 0.0))
                truth.append(_ev(batch_id, stem, sc, "stuck_sensor", "anomaly", [col], t0, t1, description="讀值卡住不動", should_alert=True))
        elif sc == "exp_drift":
            col = _pick(rng, TARGETS[stem]["drift"], avail)
            if col is None:
                continue
            sd_c = max(P.prof[col].sd, 1e-6)
            t0, _ = when(0.1, 0.35, 24)
            tot = float(rng.choice([-1, 1])) * rng.uniform(2.0, 3.5) * sd_c * k
            value_ops.append(("expdrift", col, t0, ts[-1], tot))
            truth.append(_ev(batch_id, stem, sc, "exp_drift", "anomaly", [col], t0, ts[-1], total_shift_sigma=round(tot / sd_c, 2), description="加速漂移（指數成長）", should_alert=True))
        elif sc == "intermittent_stuck":
            col = _pick(rng, TARGETS[stem]["stuck"], avail)
            if col is None:
                continue
            for lo, hi in ((0.05, 0.3), (0.35, 0.6), (0.65, 0.9)):
                dur = int(rng.integers(7, 13))
                t0, t1 = when(lo, hi, dur)
                value_ops.append(("stuck", col, t0, t1, 0.0))
                truth.append(_ev(batch_id, stem, sc, "intermittent_stuck", "anomaly", [col], t0, t1, description="間歇卡值", should_alert=True))
        elif sc == "multi_spike":
            cols = [c for c in TARGETS[stem]["spike"] if c in avail][:3]
            if len(cols) < 2:
                cols = [c for c in TARGETS[stem]["drift"] if c in avail][:2]
            dur = int(rng.integers(2, 6))
            t0, t1 = when(0.2, 0.8, dur)
            for c in cols:
                sd_c = max(P.prof[c].sd, 1e-6)
                sign = -1.0 if c.startswith(NEG_SPIKE) else 1.0
                mag = sign * rng.uniform(3.5, 6.0) * sd_c * k
                value_ops.append(("spike", c, t0, t1, mag))
                truth.append(_ev(batch_id, stem, sc, "multi_spike", "anomaly", [c], t0, t1, magnitude_sigma=round(mag / sd_c, 2), description="多感測器同時尖峰", should_alert=True))
        elif sc == "transient_step":
            col = _pick(rng, TARGETS[stem]["step"], avail)
            if col is None:
                continue
            sd_c = max(P.prof[col].sd, 1e-6)
            dur = int(rng.integers(72, 121))
            t0, t1 = when(0.15, 0.6, dur)
            off = float(rng.choice([-1, 1])) * rng.uniform(1.4, 2.6) * sd_c * k
            value_ops.append(("step", col, t0, t1, off))
            truth.append(_ev(batch_id, stem, sc, "transient_step", "anomaly", [col], t0, t1, shift_sigma=round(off / sd_c, 2), description="暫時性偏移（之後回復）", should_alert=True))
        elif sc == "noisy_sensor":
            col = _pick(rng, TARGETS[stem]["drift"], avail)
            if col is None:
                continue
            sd_c = max(P.prof[col].sd, 1e-6)
            dur = int(rng.integers(96, 169))
            t0, t1 = when(0.15, 0.7, dur)
            value_ops.append(("noise", col, t0, t1, rng.uniform(0.8, 1.5) * sd_c * k))
            truth.append(_ev(batch_id, stem, sc, "noisy_sensor", "anomaly", [col], t0, t1, description="雜訊變大（平均不變）", should_alert=True))
        elif sc == "missing":
            cols = [c for c in P.cols if P.prof[c].kind not in ("const",)]
            for j in range(int(rng.integers(3, 6))):
                c = cols[int(rng.integers(len(cols)))]
                dur = int(rng.integers(2, 9))
                t0, t1 = when(0.05, 0.95, dur)
                struct_ops.append(("blank", [c], t0, t1))
                truth.append(_ev(batch_id, stem, sc, "missing_block", "data_quality", [c], t0, t1, description="連續缺值", should_alert=False))
            struct_ops.append(("blank_random", None, ts[0], ts[-1], float(rng.uniform(0.005, 0.02))))
        elif sc == "outage":
            for j in range(int(rng.integers(1, 3))):
                dur = int(rng.integers(4, 31))
                t0, t1 = when(0.1, 0.9, dur)
                mode = str(rng.choice(["absent", "zeros"]))
                struct_ops.append(("outage_" + mode, None, t0, t1))
                truth.append(_ev(batch_id, stem, sc, "outage_" + mode, "data_quality", ["*"], t0, t1, description="整列缺失" if mode == "absent" else "整列歸零（斷電／斷線的假讀值）", should_alert=True))
        elif sc == "duplicate":
            struct_ops.append(("dup", None, ts[0], ts[-1], float(rng.uniform(0.01, 0.03)), int(rng.integers(2, 5))))
        elif sc == "delayed":
            dur = int(rng.integers(24, 72))
            t0, t1 = when(0.3, 0.7, dur)
            struct_ops.append(("delay", None, t0, t1))
            truth.append(_ev(batch_id, stem, sc, "delayed_arrival", "data_quality", ["*"], t0, t1, description="這一段稍晚才送達（先到的批次缺一段）", should_alert=False))

    df = _gen_base(stem, seed, ts, cfg, z_events, tail_state)
    # ---- 值域層注入
    idx = {t: i for i, t in enumerate(ts)}
    for kind, col, t0, t1, mag in value_ops:
        i0, i1 = idx[pd.Timestamp(t0)], idx[pd.Timestamp(t1)]
        if kind == "scale_prefix":
            for c in P.cols:
                if c.startswith(col) and P.prof[c].kind == "cont":
                    df.loc[df.index[i0:i1 + 1], c] = df.loc[df.index[i0:i1 + 1], c] * mag
            continue
        seg = slice(i0, i1 + 1)
        if kind == "drift":
            ramp = np.linspace(0, 1, i1 - i0 + 1)
            df.iloc[seg, df.columns.get_loc(col)] += mag * ramp
        elif kind == "step":
            df.iloc[seg, df.columns.get_loc(col)] += mag
        elif kind == "spike":
            bump = np.hanning(max(i1 - i0 + 3, 3))[1:-1][: i1 - i0 + 1] if i1 > i0 else np.array([1.0])
            df.iloc[seg, df.columns.get_loc(col)] += mag * (bump / bump.max())
        elif kind == "stuck":
            v = df.iloc[i0, df.columns.get_loc(col)]
            df.iloc[seg, df.columns.get_loc(col)] = v
        elif kind == "expdrift":
            u = np.linspace(0, 1, i1 - i0 + 1)
            df.iloc[seg, df.columns.get_loc(col)] += mag * (np.expm1(3 * u) / np.expm1(3.0))
        elif kind == "noise":
            nz = _rng_for(seed, stem, f"noise:{col}:{i0}").standard_normal(i1 - i0 + 1) * mag
            df.iloc[seg, df.columns.get_loc(col)] += nz
    import p586_plausibility as PL
    df = PL.enforce(stem, df, keep_stuck=[(c, t0, t1) for k_, c, t0, t1, _ in value_ops if k_ == "stuck"])
    # ---- 結構層（缺值／斷線／重複／延遲）
    extra = None
    late = None
    for op in struct_ops:
        kind = op[0]
        if kind == "blank":
            _, cols, t0, t1 = op
            m = (df["timestamp"] >= t0) & (df["timestamp"] <= t1)
            df.loc[m, cols] = np.nan
        elif kind == "blank_random":
            rate = op[4]
            r2 = _rng_for(seed, stem, "blank_random")
            cols = [c for c in P.cols if P.prof[c].kind != "const"]
            mask = r2.random((len(df), len(cols))) < rate
            sub = df[cols].to_numpy(float)
            sub[mask] = np.nan
            df[cols] = sub
        elif kind == "outage_zeros":
            _, _, t0, t1 = op
            m = ((df["timestamp"] >= t0) & (df["timestamp"] <= t1)).to_numpy()
            for c in P.cols:
                if P.prof[c].kind in ("cont", "discrete", "angle"):
                    df.loc[m, c] = 0.0
        elif kind == "outage_absent":
            _, _, t0, t1 = op
            df = df[~((df["timestamp"] >= t0) & (df["timestamp"] <= t1))].reset_index(drop=True)
    for op in struct_ops:
        if op[0] == "dup":
            _, _, t0, t1, rate, n_conf = op
            r2 = _rng_for(seed, stem, "dup")
            k_same = max(1, int(round(rate * len(df))))
            pick = r2.choice(len(df), size=min(k_same, len(df)), replace=False)
            same = df.iloc[np.sort(pick)].copy()
            conf_i = r2.choice(len(df), size=min(n_conf, len(df)), replace=False)
            conf = df.iloc[np.sort(conf_i)].copy()
            num = [c for c in P.cols if P.prof[c].kind == "cont"]
            for j in range(len(conf)):
                c = num[int(r2.integers(len(num)))]
                conf.iloc[j, conf.columns.get_loc(c)] = round(float(conf.iloc[j][c]) * 1.07 + 0.3, P.prof[c].decimals)
            extra = pd.concat([same, conf], ignore_index=True)
            truth.append(_ev(batch_id, stem, "duplicate", "duplicate_identical", "data_quality", ["*"], same["timestamp"].min(), same["timestamp"].max(), n_rows=int(len(same)), timestamps=[str(t) for t in same["timestamp"]], description="完全相同的重複列", should_alert=False))
            truth.append(_ev(batch_id, stem, "duplicate", "duplicate_conflict", "data_quality", ["*"], conf["timestamp"].min(), conf["timestamp"].max(), n_rows=int(len(conf)), timestamps=[str(t) for t in conf["timestamp"]], description="時間相同但數值不同的衝突列", should_alert=True))
    for op in struct_ops:
        if op[0] == "delay":
            _, _, t0, t1 = op
            m = (df["timestamp"] >= t0) & (df["timestamp"] <= t1)
            late_df = df[m].reset_index(drop=True)
            df = df[~m].reset_index(drop=True)
            late = Batch(stem, batch_id + "-LATE", late_df, [], {"role": "late_arrival_of", "parent": batch_id})
    meta = {"source": "synthetic", "generator": GENERATOR_VERSION, "seed": int(seed), "scenarios": list(scenarios), "stem": stem, "start": str(ts[0]), "hours": int(hours), "intensity": float(intensity),
            "continues_real_data": bool(tail_state), "real_raw_sha16": P.raw_sha16, "note": "合成資料：不是真實資料，不得作為真實模型效能的驗證證據。"}
    for ev in truth:
        ev["generator_seed"] = int(seed)
    if late is not None:
        late.meta = {**meta, "role": "late_arrival_of", "parent": batch_id}
    return Batch(stem, batch_id, df, truth, meta, extra, late)


def batch_root() -> Path:
    if os.environ.get("P586_BATCH_ROOT"):
        return Path(os.environ["P586_BATCH_ROOT"])
    return Path(os.environ["AIDE_DATA_DIR"]) / "batches" if os.environ.get("AIDE_DATA_DIR") else BATCH_DIR


def truth_root() -> Path:
    if os.environ.get("P586_TRUTH_ROOT"):
        return Path(os.environ["P586_TRUTH_ROOT"])
    return Path(os.environ["AIDE_DATA_DIR"]) / "truth" if os.environ.get("AIDE_DATA_DIR") else TRUTH_DIR


# ============================================================ 寫檔（與真實 CSV 同格式）與真值
def _fmt(v, dec: int) -> str:
    if v is None or (isinstance(v, float) and not np.isfinite(v)):
        return ""
    f = f"{float(v):.{max(dec, 0)}f}"
    return f.rstrip("0").rstrip(".") if "." in f else f


def batch_csv_text(b: Batch, style: str = "raw") -> str:
    P = profile(b.stem)
    spec = DS.spec_for(b.stem)
    header = DS.raw_header_origin(spec.path)
    raw_cols = [header[c][0] for c in P.cols]
    mark = f"{SYNTH_MARK}\tgenerator={b.meta['generator']}\tseed={b.meta['seed']}\tscenarios={'+'.join(b.meta['scenarios'])}\tbatch_id={b.batch_id}\tNOT_REAL_DATA"
    lines = [mark, "\t".join(["日期", "小時"] + raw_cols)]
    frames = [b.df] + ([b.extra_rows] if b.extra_rows is not None else [])
    for fr in frames:
        for _, r in fr.iterrows():
            t = pd.Timestamp(r["timestamp"])
            lines.append("\t".join([f"{t.year}/{t.month}/{t.day}", str(t.hour)] + [_fmt(r[c], P.prof[c].decimals) for c in P.cols]))
    return "\n".join(lines) + "\n"


def write_batch(b: Batch, out_dir: Path | None = None, truth_dir: Path | None = None) -> dict:
    """批次檔寫入 synthetic_batches/<場域>/；真值寫入獨立的 synthetic_truth/（匯入與分析流程不讀）。"""
    od = Path(out_dir or batch_root()) / b.stem
    td = Path(truth_dir or truth_root())
    od.mkdir(parents=True, exist_ok=True)
    td.mkdir(parents=True, exist_ok=True)
    path = od / f"{b.batch_id}.csv"
    path.write_bytes(batch_csv_text(b).encode("utf-16"))
    sha = hashlib.sha256(path.read_bytes()).hexdigest()
    (od / f"{b.batch_id}.meta.json").write_text(json.dumps({**b.meta, "batch_id": b.batch_id, "file_sha256": sha, "n_rows_in_file": int(len(b.df) + (0 if b.extra_rows is None else len(b.extra_rows)))}, ensure_ascii=False, indent=1), encoding="utf-8")
    (td / f"{b.batch_id}.truth.json").write_text(json.dumps({"batch_id": b.batch_id, "domain": b.stem, "meta": b.meta, "events": b.truth}, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    res = {"path": path, "sha256": sha, "late": None}
    if b.late is not None:
        res["late"] = write_batch(b.late, out_dir, truth_dir)
    return res


def list_batches(stem: str | None = None, root: Path | None = None) -> list[dict]:
    """列出可匯入的合成批次（只讀 meta，不讀真值）。"""
    base = Path(root or batch_root())
    out = []
    for p in sorted(base.glob("*/*.meta.json")):
        if stem and p.parent.name != stem:
            continue
        m = json.loads(p.read_text(encoding="utf-8"))
        m["path"] = str(p.with_name(p.name.replace(".meta.json", ".csv")))
        out.append(m)
    return out
