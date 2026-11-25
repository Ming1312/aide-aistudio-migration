"""
p55_analysis.py — Phase 5.5：由『真實資料』現算的分析（描述性／探索性；不訓練模型、不預測、不控制設備）

每個分析函式都回傳統一結構（make_result）：
    {task, title, sensors, range, method, tables{名稱: DataFrame}, charts[{kind,...}], findings[], meaning[], cannot_prove[], next_steps[], evidence{}, caveats[]}
  findings    ＝ 資料實際算出什麼（全部由資料現算）
  meaning     ＝ 這可能代表什麼（只用『可能』、不下因果結論）
  cannot_prove＝ 這個分析不能證明什麼
  next_steps  ＝ 人工可以做的下一步（不是設備操作命令）
所有結果都可以由 (原始 CSV 的 sha256、方法、參數) 重現；沒有任何隨機成分。
模型型分析（羊舍 THI 預測與風險、專家系統 DO 異常偵測）不在這裡重做，仍由 Phase 3／5.2 的既有服務經 Compatibility Gate 執行。
"""
from __future__ import annotations

import hashlib
import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))

import domain_schema as DS  # noqa: E402
import p55_classify as CL  # noqa: E402
import p55_quality as Q  # noqa: E402

QUANTILES = (0.01, 0.05, 0.25, 0.75, 0.95, 0.99)
_CACHE: dict = {}


# ------------------------------------------------------------------------------ 載入
def load_bundle(stem: str, root: Path | None = None) -> dict:
    """讀取登記的原始 CSV（唯讀）並一次完成分類與品質分析。以檔案內容的 sha256 當快取鍵：檔案一變就重算。"""
    spec = DS.spec_for(stem)
    path = (Path(root) / "data" / "raw" / f"{stem}.csv") if root else spec.path
    sha = hashlib.sha256(path.read_bytes()).hexdigest()
    key = (stem, sha)
    if key not in _CACHE:
        df, meta = DS.load_domain(stem, Path(root) if root else None)
        cls = CL.classify_dataset(stem, df, Path(root) if root else None)
        q = Q.analyze_dataset(df, cls)
        _CACHE.clear() if len(_CACHE) > 14 else None
        _CACHE[key] = {"stem": stem, "spec": spec, "path_name": path.name, "sha256": sha, "df": df, "meta": meta, "cls": cls, "quality": q}
    return _CACHE[key]


def slice_range(df: pd.DataFrame, t0=None, t1=None) -> pd.DataFrame:
    d = df
    if t0 is not None:
        d = d[d["timestamp"] >= pd.Timestamp(t0)]
    if t1 is not None:
        d = d[d["timestamp"] <= pd.Timestamp(t1)]
    return d.reset_index(drop=True)


def make_result(task: str, title: str, *, sensors=(), method: str = "", tables=None, charts=None, findings=None, meaning=None, cannot_prove=None, next_steps=None, evidence=None, caveats=None, rng=None) -> dict:
    return {"task": task, "title": title, "sensors": list(sensors), "range": rng, "method": method, "tables": tables or {}, "charts": charts or [], "findings": findings or [], "meaning": meaning or [],
            "cannot_prove": cannot_prove or [], "next_steps": next_steps or [], "evidence": evidence or {}, "caveats": caveats or []}


def _sc(bundle, col):
    return next(r for r in bundle["cls"]["rows"] if r.original_column_name == col)


def _rng(df):
    return (str(df["timestamp"].min()), str(df["timestamp"].max())) if len(df) else None


# ------------------------------------------------------------------------------ 概況
def overview(bundle: dict) -> dict:
    df, c, q, spec = bundle["df"], bundle["cls"], bundle["quality"], bundle["spec"]
    t = q["timestamp"]
    limits = [spec.notes] if spec.notes else []
    limits += ["時間戳記沒有時區（naive local，未經 JNC 確認）；所有單位都來自欄名推測，沒有任何單位經 JNC 確認。", "沒有任何設備故障或維修標籤，因此任何異常只能稱為『候選』。"]
    if t["timestamp_coverage"] < 0.5:
        limits.append(f"時間涵蓋率只有 {t['timestamp_coverage']:.1%}：大部分時段沒有資料。")
    ov = {"原始檔名": bundle["path_name"], "檔案 sha256（前 16 碼）": bundle["sha256"][:16], "編碼／分隔": f"{bundle['meta']['encoding']}／{bundle['meta']['delimiter']}", "資料筆數": t["n_rows"],
          "時間起": str(t["start"]), "時間迄": str(t["end"]), "預期小時數": t["expected_hours"], "時間涵蓋率": f"{t['timestamp_coverage']:.1%}", "感測器欄位數": len(c["rows"]), "取樣頻率": c["sampling_frequency"],
          "Domain 類型（由感測器組成推導）": c["domain_type"], "分類結果（CLASSIFIED／UNVERIFIED／UNKNOWN）": f"{c['n_classified']}／{c['n_unverified']}／{c['n_unknown']}",
          "平均觀測完整度": f"{q['mean_observed_frac']:.1%}"}
    return make_result("dataset_overview", "資料概況", sensors=[], method="讀取原始 CSV（唯讀）；欄位數、筆數與時間範圍直接由資料計算", tables={"概況": pd.DataFrame({"項目": list(ov), "值": [str(v) for v in ov.values()]}), "已知限制": pd.DataFrame({"限制": limits})},
                       findings=[f"{bundle['path_name']}：{t['n_rows']} 筆、{len(c['rows'])} 個感測器欄位，{str(t['start'])[:16]} 至 {str(t['end'])[:16]}。",
                                 f"分類：{c['n_classified']} 個已分類、{c['n_unverified']} 個待確認（UNVERIFIED）、{c['n_unknown']} 個未知（UNKNOWN）。"],
                       evidence=ov, caveats=limits, rng=_rng(df))


# ------------------------------------------------------------------------------ 描述統計與分布
def describe(df: pd.DataFrame, cols: list[str]) -> pd.DataFrame:
    rows = []
    for c in cols:
        v = pd.to_numeric(df[c], errors="coerce").dropna()
        r = {"sensor": c, "count": int(len(v))}
        if len(v):
            r.update({"mean": v.mean(), "median": v.median(), "std": v.std(ddof=1) if len(v) > 1 else float("nan"), "min": v.min(), "max": v.max(), **{f"q{int(q * 100):02d}": v.quantile(q) for q in QUANTILES}})
        rows.append(r)
    return pd.DataFrame(rows)


def descriptive_statistics(bundle: dict, sensors: list[str], t0=None, t1=None) -> dict:
    d = slice_range(bundle["df"], t0, t1)
    t = describe(d, sensors)
    miss = [f"{r['sensor']}：沒有觀測值" for r in t.to_dict("records") if r["count"] == 0]
    return make_result("descriptive_statistics", "描述統計", sensors=sensors, rng=_rng(d), method="count／mean／median／std（ddof=1）／min／max／分位數；只用有觀測值的小時（0 是觀測值，不是缺值）",
                       tables={"統計": t}, findings=[f"{r['sensor']}：平均 {r['mean']:.3g}、中位數 {r['median']:.3g}、範圍 {r['min']:.3g}～{r['max']:.3g}（n={r['count']}）" for r in t.dropna(subset=['mean']).to_dict("records")] + miss,
                       meaning=["平均與中位數差距大，代表分布偏斜或有極端值。"], cannot_prove=["統計量只描述這段資料，不能代表其他時期或其他場域。", "單位是推測值，尚未經 JNC 確認。"])


def histogram(v: pd.Series, bins: int | None = None) -> pd.DataFrame:
    x = pd.to_numeric(v, errors="coerce").dropna().to_numpy()
    if len(x) == 0:
        return pd.DataFrame(columns=["lo", "hi", "count"])
    if bins is None:
        iqr = np.subtract(*np.percentile(x, [75, 25]))
        w = 2 * iqr / (len(x) ** (1 / 3)) if iqr > 0 else 0
        bins = int(np.clip(math.ceil((x.max() - x.min()) / w), 10, 60)) if w > 0 and x.max() > x.min() else 10
    cnt, edges = np.histogram(x, bins=bins)
    return pd.DataFrame({"lo": edges[:-1], "hi": edges[1:], "count": cnt})


def box_stats(v: pd.Series) -> dict:
    x = pd.to_numeric(v, errors="coerce").dropna()
    if x.empty:
        return {}
    q1, med, q3 = x.quantile([.25, .5, .75])
    iqr = q3 - q1
    lo_w, hi_w = x[x >= q1 - 1.5 * iqr].min(), x[x <= q3 + 1.5 * iqr].max()
    return {"q1": float(q1), "median": float(med), "q3": float(q3), "whisker_lo": float(lo_w), "whisker_hi": float(hi_w), "n_outside_whiskers": int(((x < lo_w) | (x > hi_w)).sum()), "n": int(len(x))}


def hour_profile(df: pd.DataFrame, col: str) -> pd.DataFrame:
    d = df[["timestamp", col]].dropna()
    g = d.groupby(d["timestamp"].dt.hour)[col]
    return pd.DataFrame({"hour": g.median().index, "median": g.median().values, "q25": g.quantile(.25).values, "q75": g.quantile(.75).values, "n": g.size().values})


def distribution(bundle: dict, sensors: list[str], t0=None, t1=None) -> dict:
    d = slice_range(bundle["df"], t0, t1)
    hist = {c: histogram(d[c]) for c in sensors}
    box = pd.DataFrame([{"sensor": c, **box_stats(d[c])} for c in sensors])
    f = [f"{r['sensor']}：四分位 {r['q1']:.3g}／{r['median']:.3g}／{r['q3']:.3g}，鬚外 {r['n_outside_whiskers']} 點（候選極端值，不是故障）" for r in box.dropna(subset=['q1']).to_dict("records")] if len(box) and "q1" in box else []
    return make_result("distribution", "分布", sensors=sensors, rng=_rng(d), method="直方圖（Freedman–Diaconis 分箱，10–60 箱）、箱形圖（1.5×IQR 鬚）", tables={"箱形統計": box, **{f"直方圖｜{c}": h for c, h in hist.items()}},
                       charts=[{"kind": "hist", "table": f"直方圖｜{c}", "title": c} for c in sensors], findings=f, meaning=["分布集中或分成兩群，可能反映日夜、運轉狀態或感測器解析度。"],
                       cannot_prove=["分布形狀不能說明原因；兩群不等於兩種設備狀態。"])


def correlations(bundle: dict, sensors: list[str], t0=None, t1=None) -> dict:
    full = slice_range(bundle["df"], t0, t1)
    d = full[sensors]
    r = d.rank().corr(min_periods=30)
    pairs = [(a, b, r.loc[a, b]) for i, a in enumerate(sensors) for b in sensors[i + 1:] if pd.notna(r.loc[a, b])]
    top = sorted(pairs, key=lambda x: -abs(x[2]))[:5]
    return make_result("correlation", "感測器之間的關係（Spearman）", sensors=sensors, rng=_rng(full), method="Spearman 等級相關（兩兩有值的小時）", tables={"相關矩陣": r.reset_index().rename(columns={"index": "sensor"})},
                       charts=[{"kind": "corr", "table": "相關矩陣"}], findings=[f"{a} 與 {b}：ρ={v:.2f}" for a, b, v in top],
                       meaning=["高相關代表兩者同步變化，可能共同受日夜或天氣影響。"], cannot_prove=["相關不是因果；同步變化不代表一個造成另一個。"])


# ------------------------------------------------------------------------------ 趨勢、日週期
def trend_analysis(bundle: dict, sensors: list[str], t0=None, t1=None) -> dict:
    d = slice_range(bundle["df"], t0, t1)
    h = Q.hourly_frame(d)
    rows = []
    for c in sensors:
        s = h[c].dropna()
        if len(s) < 48:
            rows.append({"sensor": c, "n": len(s), "slope_per_day": np.nan, "first_week_median": np.nan, "last_week_median": np.nan})
            continue
        x = (s.index - s.index[0]) / pd.Timedelta(days=1)
        slope = float(np.polyfit(x, s.to_numpy(), 1)[0])
        k = max(24 * 7, len(s) // 5)
        rows.append({"sensor": c, "n": len(s), "slope_per_day": slope, "first_week_median": float(s.iloc[:k].median()), "last_week_median": float(s.iloc[-k:].median())})
    T = pd.DataFrame(rows)
    return make_result("trend_analysis", "趨勢", sensors=sensors, rng=_rng(d), method="每日線性斜率（最小平方）與首尾區段中位數比較；缺的小時不補值", tables={"趨勢摘要": T},
                       charts=[{"kind": "timeseries", "sensors": sensors}], findings=[f"{r['sensor']}：每日斜率 {r['slope_per_day']:+.3g}；首段中位數 {r['first_week_median']:.3g} → 末段 {r['last_week_median']:.3g}" for r in rows if pd.notna(r["slope_per_day"])],
                       meaning=["斜率與首尾差距只描述這段資料的走向，可能是季節、天氣或感測器漂移。"], cannot_prove=["不能分辨真實變化與感測器漂移；線性斜率不是預測。"])


def daily_cycle(bundle: dict, sensors: list[str], t0=None, t1=None) -> dict:
    d = slice_range(bundle["df"], t0, t1)
    rows, prof = [], {}
    for c in sensors:
        s = d[["timestamp", c]].dropna()
        if len(s) < 72:
            rows.append({"sensor": c, "n": len(s)})
            continue
        p = hour_profile(d, c)
        prof[c] = p
        hr = s["timestamp"].dt.hour
        tot = float(((s[c] - s[c].mean()) ** 2).sum())
        bet = float(sum(len(g) * (g.mean() - s[c].mean()) ** 2 for _, g in s.groupby(hr)[c])) if tot > 0 else 0.0
        eta2 = bet / tot if tot > 0 else 0.0
        peak = int(p.loc[p["median"].idxmax(), "hour"])
        trough = int(p.loc[p["median"].idxmin(), "hour"])
        rows.append({"sensor": c, "n": len(s), "hour_of_day_explained_variance": eta2, "peak_hour": peak, "trough_hour": trough, "amplitude_median_range": float(p["median"].max() - p["median"].min())})
    T = pd.DataFrame(rows)
    f = [f"{r['sensor']}：一天中的時刻可解釋 {r['hour_of_day_explained_variance']:.0%} 的變異；中位數最高在 {r['peak_hour']:02d} 時、最低在 {r['trough_hour']:02d} 時" for r in rows if "peak_hour" in r]
    return make_result("daily_cycle", "日週期", sensors=sensors, rng=_rng(d), method="依『一天中的小時』分組：各小時的中位數與四分位；日週期強度＝組間變異占總變異的比例（η²）", tables={"日週期摘要": T, **{f"日內剖面｜{c}": p for c, p in prof.items()}},
                       charts=[{"kind": "hourprofile", "table": f"日內剖面｜{c}", "title": c} for c in prof], findings=f,
                       meaning=["η² 高代表這個感測器的變化主要跟著一天中的時刻走（例如日夜溫差、作業時段）。"], cannot_prove=["日週期不能說明原因；時刻與數值同步不等於時刻造成變化。", "只涵蓋這段資料的日數，無法代表季節變化。"])


# ------------------------------------------------------------------------------ 資料品質（Flatline／零值／離群）
def data_quality(bundle: dict, t0=None, t1=None, sensors: list[str] | None = None) -> dict:
    d = slice_range(bundle["df"], t0, t1)
    cls = {**bundle["cls"], "rows": [r for r in bundle["cls"]["rows"] if (sensors is None or r.original_column_name in sensors)]}
    q = Q.analyze_dataset(d, cls) if len(d) else bundle["quality"]
    t = q["timestamp"]
    S, R = q["sensors"], q["runs"]
    f = [f"時間涵蓋 {t['timestamp_coverage']:.1%}（{t['n_unique_timestamps']}／{t['expected_hours']} 小時）；時間缺口 {t['n_gaps']} 個，最長缺 {t['longest_gap_hours']} 小時；重複時間戳記 {t['duplicate_timestamps']} 筆。",
         f"需要確認的區段 {q['n_flagged_runs']} 段（缺值、可疑／長時間零值、非零 Flatline）；超出推測物理範圍的觀測 {q['n_invalid_candidates']} 筆（候選）。"]
    if q["all_zero_rows"]["n_rows"]:
        f.append(f"有 {q['all_zero_rows']['n_rows']} 列『所有連續型感測器同時為 0 或空白』：很可能是感測主機當時沒有回報而被記成 0（只報告，不修改）。")
    legit = int((R["severity"] == "info").sum()) if len(R) else 0
    if legit:
        f.append(f"另有 {legit} 段零值／平台屬於『合法或條件式』，不當成異常。")
    return make_result("data_quality", "資料品質", sensors=list(S["sensor"]) if len(S) else [], rng=_rng(d), method="缺值（整列缺少或空白）、重複、時間缺口、零值語義（合法／脈絡相關／可疑）、非零 Flatline（依感測器自身重複率的偶然門檻）、穩健 Z>5 離群候選、超出推測範圍候選",
                       tables={"時間戳記": pd.DataFrame([{k: (str(v) if isinstance(v, pd.Timestamp) else v) for k, v in t.items() if k != "gaps"}]), "時間缺口": pd.DataFrame([{**g, "after": str(g["after"]), "before": str(g["before"])} for g in t["gaps"]]),
                               "各感測器品質": S, "需要確認的區段": R, "離群候選": q["outliers"]}, charts=[{"kind": "quality_bars"}], findings=f,
                       meaning=["真正缺值、合法零值、長時間零值與非零 Flatline 是不同的狀況，需要不同的處理；它們都只是資料狀態。"],
                       cannot_prove=["這些都是候選，不能證明設備故障；零值或 Flatline 可能是真實的低值或沒有變化。", "離群值只表示偏離該感測器自己的分布，不是錯誤。"],
                       next_steps=["對『可疑零值』與『非零 Flatline』做現場複測或檢查通訊紀錄。", "單位與時區請向 JNC 確認。"], evidence={"all_zero_rows": q["all_zero_rows"]["n_rows"]})


# ------------------------------------------------------------------------------ 分段分布變化（漂移候選）
def ks_stat(a: np.ndarray, b: np.ndarray) -> float:
    a, b = np.sort(a[~np.isnan(a)]), np.sort(b[~np.isnan(b)])
    if len(a) == 0 or len(b) == 0:
        return float("nan")
    allv = np.concatenate([a, b])
    return float(np.max(np.abs(np.searchsorted(a, allv, side="right") / len(a) - np.searchsorted(b, allv, side="right") / len(b))))


def segment_shift(bundle: dict, sensors: list[str], n_segments: int = 4, t0=None, t1=None) -> dict:
    d = slice_range(bundle["df"], t0, t1)
    edges = pd.date_range(d["timestamp"].min(), d["timestamp"].max(), periods=n_segments + 1)
    rows, shifts = [], []
    for c in sensors:
        segs = []
        for i in range(n_segments):
            m = (d["timestamp"] >= edges[i]) & ((d["timestamp"] < edges[i + 1]) if i < n_segments - 1 else (d["timestamp"] <= edges[i + 1]))
            v = pd.to_numeric(d.loc[m, c], errors="coerce").dropna().to_numpy()
            segs.append(v)
            rows.append({"sensor": c, "segment": i + 1, "start": str(edges[i])[:10], "end": str(edges[i + 1])[:10], "n": int(len(v)), "median": float(np.median(v)) if len(v) else np.nan,
                         "iqr": float(np.subtract(*np.percentile(v, [75, 25]))) if len(v) else np.nan})
        for i in range(n_segments - 1):
            ks = ks_stat(segs[i], segs[i + 1])
            sc_ = float(np.subtract(*np.percentile(np.concatenate(segs), [75, 25]))) or float("nan")
            shift = (np.median(segs[i + 1]) - np.median(segs[i])) / sc_ if len(segs[i]) and len(segs[i + 1]) and sc_ == sc_ else float("nan")
            shifts.append({"sensor": c, "from_segment": i + 1, "to_segment": i + 2, "ks_D": ks, "median_shift_in_IQR": shift, "candidate": bool(ks == ks and ks >= 0.3 and min(len(segs[i]), len(segs[i + 1])) >= 72)})
    S, K = pd.DataFrame(rows), pd.DataFrame(shifts)
    cand = K[K["candidate"]] if len(K) else K
    return make_result("segment_shift", "不同時間區段的分布變化（漂移候選）", sensors=sensors, rng=_rng(d), method=f"把時間範圍等分成 {n_segments} 段，比較相鄰區段的分布：兩樣本 KS 統計量 D（0～1）與中位數位移（以全期 IQR 為單位）；D≥0.3 且每段≥72 筆列為『候選』",
                       tables={"各區段摘要": S, "相鄰區段比較": K}, charts=[{"kind": "segments"}],
                       findings=[f"{r['sensor']}：區段 {r['from_segment']}→{r['to_segment']} D={r['ks_D']:.2f}、中位數位移 {r['median_shift_in_IQR']:+.2f} IQR" for r in cand.to_dict("records")] or ["沒有相鄰區段達到候選門檻。"],
                       meaning=["分布變了，可能是季節或天氣的真實變化、水質事件、探頭漂移或重新校正。"],
                       cannot_prove=["不能分辨真實環境變化與感測器漂移；KS 距離大不代表設備有問題。", "三爺宮溪與專家系統是不同場域，這裡的方法沒有從專家系統的 DO 偵測器移植（Transfer Compatibility 仍是 Unverified）。"],
                       next_steps=["把候選區段與校正紀錄（斜率欄位）、現場人工量測對照。", "需要更多資料與外部參考值才能判斷是否為漂移。"])


def calibration_events(bundle: dict, t0=None, t1=None) -> dict:
    d = slice_range(bundle["df"], t0, t1)
    cols = [r.original_column_name for r in bundle["cls"]["rows"] if r.measurement_kind == "calibration_parameter"]
    ev = []
    for c in cols:
        s = d[["timestamp", c]].dropna().reset_index(drop=True)
        ch = s[c].diff().fillna(0) != 0
        for i in np.where(ch)[0]:
            ev.append({"sensor": c, "time": str(s.loc[i, "timestamp"]), "before": float(s.loc[i - 1, c]), "after": float(s.loc[i, c])})
    E = pd.DataFrame(ev, columns=["sensor", "time", "before", "after"])
    return make_result("calibration_events", "校正參數變動事件", sensors=cols, rng=_rng(d), method="校正斜率欄位數值發生變化的時間點", tables={"事件": E},
                       findings=[f"{c}：變動 {int((E['sensor'] == c).sum())} 次" for c in cols] or ["沒有校正參數欄位。"],
                       meaning=["斜率變動可能代表探頭被重新校正或設定被改；之後的讀值水準可能因此改變。"], cannot_prove=["不能證明校正的原因或結果；不能把斜率變動解讀為故障。"], next_steps=["與維護紀錄對照，確認校正時間。"])


# ------------------------------------------------------------------------------ 可預測性基準評估（沒有模型）
def forecastability(bundle: dict, sensors: list[str], horizon_h: int = 3, t0=None, t1=None) -> dict:
    d = slice_range(bundle["df"], t0, t1)
    h = Q.hourly_frame(d)
    rows = []
    for c in sensors:
        s = h[c]
        n = len(s)
        cut = int(n * 0.7)
        y, y_h, y_p = s.to_numpy(), s.shift(-horizon_h).to_numpy(), s.shift(24 - horizon_h).to_numpy()   # 目標 y[t+h]；持續性 y[t]；季節性 y[t+h-24]
        te = np.arange(cut, n - horizon_h)
        ok = ~np.isnan(y_h[te]) & ~np.isnan(y[te])
        ok2 = ok & ~np.isnan(y_p[te])
        mae_p = float(np.mean(np.abs(y_h[te][ok] - y[te][ok]))) if ok.sum() >= 30 else np.nan
        mae_s = float(np.mean(np.abs(y_h[te][ok2] - y_p[te][ok2]))) if ok2.sum() >= 30 else np.nan
        tr = np.arange(0, cut - horizon_h)
        okt = ~np.isnan(y[tr]) & ~np.isnan(y_h[tr])
        ac = float(np.corrcoef(y[tr][okt], y_h[tr][okt])[0, 1]) if okt.sum() >= 30 else np.nan
        rows.append({"sensor": c, "n_test_pairs": int(ok.sum()), "persistence_MAE": mae_p, "seasonal_naive_24h_MAE": mae_s, f"lag{horizon_h}h_autocorr_train": ac,
                     "series_std": float(np.nanstd(y)), "persistence_MAE_over_std": mae_p / float(np.nanstd(y)) if np.nanstd(y) else np.nan})
    T = pd.DataFrame(rows)
    return make_result("forecastability", f"短期（{horizon_h} 小時）預測任務評估：基準方法（沒有模型）", sensors=sensors, rng=_rng(d), method=f"時間順序切分（前 70% 訓練期、後 30% 測試期）；只比較兩個『不需訓練』的基準：持續性（y[t+{horizon_h}]≈y[t]）與 24 小時季節性（≈y[t+{horizon_h}−24]）；只用過去資料",
                       tables={"基準比較": T}, findings=[f"{r['sensor']}：持續性 MAE {r['persistence_MAE']:.3g}（約為標準差的 {r['persistence_MAE_over_std']:.2f} 倍）；24h 季節性 MAE {r['seasonal_naive_24h_MAE']:.3g}；訓練期 {horizon_h}h 自相關 {r[f'lag{horizon_h}h_autocorr_train']:.2f}" for r in rows if r["n_test_pairs"] >= 30],
                       meaning=["自相關高、基準誤差小，代表這個變數短期內相當可預測，值得評估建模；這只是『可以考慮建立模型』的證據。"],
                       cannot_prove=["這不是模型：沒有訓練、沒有驗證，不代表任何預測準確度。", "沒有企業確認的警報門檻，所以也不能做風險評估。"], next_steps=["與 JNC 確認預測目標、門檻與單位後，再依 Phase 5.1 的流程評估是否建模。"],
                       caveats=["基準誤差是資料特性，不是模型績效。"])


# ------------------------------------------------------------------------------ 涵蓋區塊（育成北側）
def coverage_blocks(bundle: dict, min_history_h: int = 336) -> dict:
    d = bundle["df"]
    cols = [r.original_column_name for r in bundle["cls"]["rows"] if r.classification_status != CL.UNKNOWN]
    h = Q.hourly_frame(d)
    present = h[cols].notna().any(axis=1).to_numpy()
    blocks = [{"start": str(h.index[a]), "end": str(h.index[b]), "hours": int(b - a + 1)} for a, b in Q.runs_of(present)]
    B = pd.DataFrame(blocks)
    n = len(h)
    longest = int(B["hours"].max()) if len(B) else 0
    usable = B[B["hours"] >= min_history_h] if len(B) else B
    gaps = [{"after": str(h.index[b]), "missing_hours": int(nb - b - 1)} for (a, b), (nb, _) in zip(Q.runs_of(present), Q.runs_of(present)[1:])]
    per = pd.DataFrame([{"sensor": c, "observed_hours": int(h[c].notna().sum()), "observed_frac": float(h[c].notna().mean())} for c in cols])
    why = []
    if longest < min_history_h:
        why.append(f"最長的連續有資料區塊只有 {longest} 小時，短於平台對時間序列任務要求的歷史長度 {min_history_h} 小時（Phase 5.2 的 min_history）。")
    if present.mean() < 0.5:
        why.append(f"整體只有 {present.mean():.1%} 的小時有資料。")
    return make_result("coverage_blocks", "涵蓋區塊與可用時間區段", sensors=cols, rng=_rng(d), method=f"逐小時判斷『是否有任何感測器有值』，找出連續有資料的區塊；可用區段＝連續 ≥ {min_history_h} 小時的區塊",
                       tables={"有資料的區塊": B, "區塊之間的缺口": pd.DataFrame(gaps), "各感測器觀測比例": per}, charts=[{"kind": "coverage_grid"}],
                       findings=[f"共 {len(B)} 個連續有資料的區塊、{int(present.sum())}／{n} 小時有資料（{present.mean():.1%}）；最長區塊 {longest} 小時。", f"連續 ≥ {min_history_h} 小時的可用區段：{len(usable)} 個。"] + why,
                       meaning=["資料太零碎，任何趨勢或模型都只能代表有資料的幾段；目前不適合做可靠的預測或異常偵測。"], cannot_prove=["不能說明資料為什麼中斷（電力、通訊或維護都有可能）。"],
                       next_steps=["先確認裝置供電與通訊；補齊資料後再評估分析。", "不建立模型，也不用插補假裝資料完整。"], evidence={"longest_block_h": longest, "n_usable_windows": int(len(usable)), "coverage": float(present.mean()), "min_history_h": min_history_h})


def device_health(bundle: dict, t0=None, t1=None) -> dict:
    d = slice_range(bundle["df"], t0, t1)
    cls = bundle["cls"]["rows"]
    cnt = [r.original_column_name for r in cls if r.sensor_type in ("Uptime Counter", "Boot Counter")]
    sig = [r.original_column_name for r in cls if r.sensor_type in ("Signal Strength", "Supply Voltage", "Battery Voltage")]
    ev = []
    for c in [x for x in cnt if "運轉" in x or "送電" in x]:
        s = d[["timestamp", c]].dropna().reset_index(drop=True)
        drops = np.where(s[c].diff() < 0)[0]
        for i in drops:
            ev.append({"counter": c, "time": str(s.loc[i, "timestamp"]), "before": float(s.loc[i - 1, c]), "after": float(s.loc[i, c])})
    E = pd.DataFrame(ev, columns=["counter", "time", "before", "after"])
    S = describe(d, sig)
    return make_result("device_health", "裝置健康（運轉計數器、訊號、供電）", sensors=cnt + sig, rng=_rng(d), method="累計運轉／送電時間下降＝計數器歸零（重新開機）；訊號與電壓只做描述統計", tables={"計數器歸零事件": E, "訊號與供電統計": S},
                       findings=[f"計數器歸零 {len(E)} 次（可能是重新開機或斷電後恢復）。"] + [f"{r['sensor']}：中位數 {r['median']:.3g}、範圍 {r['min']:.3g}～{r['max']:.3g}" for r in S.dropna(subset=['median']).to_dict('records')],
                       meaning=["頻繁歸零可能與供電或通訊不穩有關，也可能是排程重啟。"], cannot_prove=["不能證明資料中斷的原因，也不是設備故障的診斷。"], next_steps=["與現場確認供電與通訊紀錄。"])


# ------------------------------------------------------------------------------ 負載狀態（專家系統 CPM）
def load_state_analysis(bundle: dict, col: str, t0=None, t1=None) -> dict:
    import p52_context as CTX
    d = slice_range(bundle["df"], t0, t1)
    cur = d.set_index("timestamp")[col].astype(float)
    cur = cur.where(cur.index.isin(d.loc[~(d[[c for c in d.columns if c != "timestamp"]].eq(0) | d[[c for c in d.columns if c != "timestamp"]].isna()).all(axis=1), "timestamp"]))   # 整列同時為 0 的列視為未知（沿用 Phase 5.2 的遮蔽語義）
    model = CTX.fit_load_model(cur)
    if model is None:
        return make_result("load_state", "負載狀態", sensors=[col], rng=_rng(d), method="Otsu 雙峰切點", findings=["分布沒有明顯的雙峰：不建立高／低負載狀態。"], cannot_prove=["沒有狀態就不做脈絡推論。"])
    st = CTX.load_states(cur, model)["state"]
    runs = []
    for a, b in Q.runs_of((st == CTX.LOW).to_numpy()):
        runs.append({"start": str(cur.index[a]), "end": str(cur.index[b]), "hours": int(b - a + 1)})
    R = pd.DataFrame(runs, columns=["start", "end", "hours"]).sort_values("hours", ascending=False)
    share = st.value_counts(normalize=True).rename_axis("state").reset_index(name="fraction")
    hp = pd.DataFrame({"hour": range(24), "low_fraction": [float((st[st.index.hour == h] == CTX.LOW).sum() / max(int((st.index.hour == h).sum()), 1)) for h in range(24)]})
    long_low = R[R["hours"] >= 24]
    return make_result("load_state", "負載狀態（電流）", sensors=[col], rng=_rng(d), method="沿用 Phase 5.2 的 CPM 脈絡：Otsu 雙峰切點把電流分成 LOW／HIGH／TRANSITION／UNKNOWN（因果：第 t 小時只用 ≤t 的電流）",
                       tables={"狀態比例": share, "各小時低負載比例": hp, "低負載連續區段": R}, charts=[{"kind": "hist_state", "col": col}],
                       findings=[f"切點 {model['threshold']:.3g}（低負載眾數 {model['low_mode']:.3g}、高負載眾數 {model['high_mode']:.3g}）。"] + [f"{r.state}：{r.fraction:.1%}" for r in share.itertuples()] + [f"連續 ≥24 小時的低負載區段：{len(long_low)} 段，最長 {int(R['hours'].max()) if len(R) else 0} 小時。"],
                       meaning=["低負載區段可能是設備停機、排程、季節性操作或其他原因。"], cannot_prove=["低電流不等於故障：CPM 對應的設備尚未確認，也沒有任何停機標籤。", "狀態是統計導出的候選狀態，不是已確認的運轉模式。"],
                       next_steps=["向現場確認 CPM 對應的設備與運轉排程。"], caveats=["沿用 Phase 5.2 的定義；切點在整段資料上擬合，只作描述，不作預測。"], evidence={"threshold": model["threshold"]})


# ------------------------------------------------------------------------------ 導出指標：THI（描述性公式，不是模型）
def thi_from(t_c: pd.Series, rh: pd.Series) -> pd.Series:
    """NRC 公式：THI = (1.8·T + 32) − (0.55 − 0.0055·RH)·(1.8·T − 26)。純公式、無參數、不訓練。"""
    return (1.8 * t_c + 32) - (0.55 - 0.0055 * rh) * (1.8 * t_c - 26)


def thi_derived(bundle: dict, t_col: str, rh_col: str, t0=None, t1=None) -> dict:
    d = slice_range(bundle["df"], t0, t1)
    thi = thi_from(d[t_col], d[rh_col])
    built = [r.original_column_name for r in bundle["cls"]["rows"] if r.sensor_type.startswith("Temperature-Humidity Index")]
    ev, f = {}, []
    if built:
        x = pd.concat([thi.rename("calc"), d[built[0]].rename("given")], axis=1).dropna()
        if len(x) > 30:
            diff = (x["calc"] - x["given"]).abs()
            ev = {"given_column": built[0], "n": int(len(x)), "max_abs_diff": float(diff.max()), "median_abs_diff": float(diff.median()), "corr": float(x.corr().iloc[0, 1])}
            f.append(f"以公式由 {t_col}／{rh_col} 算出的 THI，與資料內建的 {built[0]} 相比：中位數差 {ev['median_abs_diff']:.3g}、最大差 {ev['max_abs_diff']:.3g}、相關 {ev['corr']:.4f}（n={ev['n']}）。")
    T = pd.DataFrame({"timestamp": d["timestamp"], "THI(calc)": thi})
    f.append(f"算出的 THI 範圍 {thi.min():.1f}～{thi.max():.1f}，中位數 {thi.median():.1f}（無單位的指數）。")
    return make_result("thi_derived", "THI 計算（導出指標）", sensors=[t_col, rh_col], rng=_rng(d), method="NRC 公式：THI=(1.8T+32)−(0.55−0.0055RH)(1.8T−26)；純公式、不訓練、不預測", tables={"THI": T}, charts=[{"kind": "timeseries_table", "table": "THI", "y": "THI(calc)"}], findings=f,
                       meaning=["THI 描述溫度與濕度合併後的環境熱負荷。"], cannot_prove=["算出 THI 不等於有可用的預測模型，也不等於有企業確認的警報門檻；沒有任何風險判斷。"], evidence=ev)


# ------------------------------------------------------------------------------ 可疑區段探索
def suspicious_segments(bundle: dict, t0=None, t1=None, top: int = 25) -> dict:
    d = slice_range(bundle["df"], t0, t1)
    q = Q.analyze_dataset(d, bundle["cls"]) if len(d) else bundle["quality"]
    R = q["runs"]
    R = R[R["severity"] != "info"].copy() if len(R) else R
    if len(R):
        R["start"], R["end"] = R["start"].astype(str), R["end"].astype(str)
    byw = R.groupby("run_type")["hours"].agg(["size", "max"]).reset_index() if len(R) else pd.DataFrame()
    return make_result("suspicious_segments", "可疑區段探索（候選）", rng=_rng(d), method="彙整資料品質分析找出的缺值、可疑／長時間零值與非零 Flatline 區段，依長度排序", tables={"區段（前 %d 長）" % top: R.head(top), "類型統計": byw, "離群候選": q["outliers"]},
                       findings=[f"共 {len(R)} 段需要確認的區段。"] + [f"{r.sensor}：{r.run_type} {r.hours} 小時（{str(r.start)[:16]} 起）" for r in R.head(5).itertuples()],
                       meaning=["這些區段值得人工看一眼；很多可能只是真實的低值、停機或沒有變化。"], cannot_prove=["不能證明這些區段是感測器或設備故障。"], next_steps=["從最長的區段開始人工複測或查通訊紀錄。"])


# ------------------------------------------------------------------------------ 時間序列（供圖表使用）
def timeseries_frame(bundle: dict, sensors: list[str], t0=None, t1=None) -> pd.DataFrame:
    d = slice_range(bundle["df"], t0, t1)
    h = Q.hourly_frame(d)
    return h[sensors].reset_index()


# ------------------------------------------------------------------------------ 任務分派（UI 與測試共用）
def run_task(bundle: dict, task: str, sensors: list[str] | None = None, t0=None, t1=None, params: dict | None = None) -> dict:
    """依任務 ID 執行描述性分析。sensors 為使用者選的感測器（原始欄名）。模型型任務（forecast_risk、anomaly_statistical）不在這裡：它們只能經 PlatformService＋Compatibility Gate。"""
    params = params or {}
    rows = bundle["cls"]["rows"]
    cont = [r.original_column_name for r in rows if r.measurement_kind in ("continuous", "derived_index", "circular_angle") and r.classification_status != CL.UNKNOWN]
    sel = [c for c in (sensors or []) if c in bundle["df"].columns] or cont[:4]
    if task == "dataset_overview":
        return overview(bundle)
    if task == "data_quality":
        return data_quality(bundle, t0, t1, sel if sensors else None)
    if task == "descriptive_statistics":
        return descriptive_statistics(bundle, sel, t0, t1)
    if task == "trend_analysis":
        return trend_analysis(bundle, sel, t0, t1)
    if task == "distribution":
        return distribution(bundle, sel, t0, t1)
    if task == "daily_cycle":
        return daily_cycle(bundle, sel, t0, t1)
    if task == "correlation":
        return correlations(bundle, sel if len(sel) >= 2 else cont[:6], t0, t1)
    if task == "segment_shift":
        wq = params.get("sensors") or [c for c in sel if _sc(bundle, c).sensor_group == "Water Quality"] or sel
        return segment_shift(bundle, wq, int(params.get("n_segments", 4)), t0, t1)
    if task == "calibration_events":
        return calibration_events(bundle, t0, t1)
    if task == "load_state":
        col = params.get("col") or next((r.original_column_name for r in rows if r.sensor_type == "Electrical Current (load)"), None)
        if col is None:
            raise ValueError("沒有負載電流感測器")
        return load_state_analysis(bundle, col, t0, t1)
    if task == "device_health":
        return device_health(bundle, t0, t1)
    if task == "coverage_blocks":
        return coverage_blocks(bundle, int(params.get("min_history_h", 336)))
    if task == "thi_derived":
        import p55_recommend as RC
        tr = (params.get("t_col"), params.get("rh_col")) if params.get("t_col") else RC.pick_temp_rh(rows)
        if not tr or not tr[0]:
            raise ValueError("需要溫度與濕度感測器")
        return thi_derived(bundle, tr[0], tr[1], t0, t1)
    if task == "suspicious_segments":
        return suspicious_segments(bundle, t0, t1)
    if task == "forecastability":
        s2 = params.get("sensors") or sel
        return forecastability(bundle, s2, int(params.get("horizon_h", 3)), t0, t1)
    raise KeyError(f"未知或不可由資料層執行的任務：{task}（模型型任務必須經 Compatibility Gate）")
