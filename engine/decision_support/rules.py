"""
decision_support/rules.py — 通用多場域決策輔助（純函式：同樣的證據永遠得到同樣的建議；不讀檔、不連網、不訓練、不碰時間）

資料流：  證據包（引擎的真實輸出）──► Evidence[]（可追溯） ──► Recommendation[]（分三層、附可信程度與限制） ──► validate()（硬性護欄）

三層（見 policy_registry.json）
  general             一般建議：資料檢查、監測、模型適用性
  needs_human_review  需要人工確認的異常：偵測器的『候選事件』，不是故障判定
  formal_risk         正式風險決策：只有登錄表登記的正式引擎（目前只有羊舍），而且政策門檻仍是候選值，必須如實標示

硬性規則（validate() 會逐條檢查，違反就拒絕輸出）
  1. 不得產生沒有登錄的警戒門檻／合格範圍；偵測器自己的歷史參考值只能當證據引用並註明『不是警戒門檻』
  2. 不得下『故障／損壞／需要更換』的結論
  3. 不得產生或暗示自動控制指令；行動只能來自登錄表的 allowed_actions
  4. 資料不足或模型不適用時，只給資料檢查建議，不得出現任何預測值
  5. formal_risk 只能出現在登錄表標記 formal_engine 的場域；羊舍的正式輸出原樣引用，不改寫
  6. 每項建議都必須有存在的證據編號、可信程度、限制
本模組不修改任何引擎輸出；只整理與分層。
"""
from __future__ import annotations

import copy
import json
import re
from pathlib import Path

SCHEMA = "aide-decision-support-v1"
HERE = Path(__file__).resolve().parent
REGISTRY = json.loads((HERE / "policy_registry.json").read_text(encoding="utf-8"))
TIERS = tuple(REGISTRY["tiers"])
CONF_LEVELS = tuple(REGISTRY["confidence_ladder"])
ACTIONS = tuple(REGISTRY["allowed_actions"])
DP = REGISTRY["design_parameters"]

# 偵測器事件種類 ↔ 資料品質掃描的連續區段種類（獨立的第二條分析路徑；只有這些對應，沒有的就不交叉佐證）
QUALITY_COMPAT = {"stuck_sensor": {"flatline"}, "outage_missing_rows": {"missing"}, "outage_zero_rows": {"zero"}}
RUN_ZH = {"flatline": "讀值不變（卡值）", "zero": "零值", "missing": "缺值"}
KIND_ZH = {"stuck_sensor": "讀值卡住", "out_of_historical_range": "超出歷史範圍", "outage_missing_rows": "整列缺失（斷線）", "outage_zero_rows": "整列歸零（斷電／斷線）",
           "drift_or_offset": "漂移或偏移", "short_event_or_step": "短暫突波或階躍", "decoupling": "與其他感測器脫鉤", "variance_increase": "雜訊變大", "missing_block": "連續缺值"}

GENERIC_LIMITS = [
    "感測器單位是依欄位名稱與數值分布推測的，尚未經資料提供者確認。",
    "時間戳記未標示時區（本地時間；尚未向資料提供者確認）。",
    "這是研究用的決策輔助：不控制任何設備，所有處置都由人決定。",
]

# 硬性護欄的字樣（validate() 與 TypeScript 側的核對共用同一組語意）
FAULT_RE = re.compile(r"(已故障|確定故障|確認故障|故障了|損壞了|已損壞|壞掉了|壞了|需要更換|必須更換|應更換|請更換)")
ACTUATION_RE = re.compile(r"(自動(?:開啟|關閉|調整|控制|啟動|停止)|直接(?:調整|控制)設備|已(?:開啟|關閉)(?:風扇|設備|閥))")
THRESHOLD_RE = re.compile(r"(?:超過|高於|低於|大於|小於|不得超過|須低於|必須低於|警戒值|警戒線|合格範圍|標準值)\s*[:：]?\s*[0-9]")
PREDICTION_RE = re.compile(r"(?:預測|預計|預估)[^。，；：:\n]{0,12}?(?:為|是|會|將|達到|升到|降到|到達|約)\s*[0-9]")


def _fmt(x, nd=2):
    if x is None:
        return "—"
    if isinstance(x, int):
        return str(x)
    s = f"{float(x):.{nd}f}"
    return s.rstrip("0").rstrip(".") if "." in s else s


def _pct(x):
    return "—" if x is None else f"{abs(float(x)) * 100:.1f}%"


def _conf(level: str, basis: list[tuple[str, str]], cap: str | None = None) -> dict:
    assert level in CONF_LEVELS, level
    return {"level": level, "basis": [{"code": c, "text": t} for c, t in basis], "cap_reason": cap}


class _Ids:
    def __init__(self, prefix):
        self.p, self.n = prefix, 0

    def next(self, tag=""):
        self.n += 1
        return f"{self.p}-{tag}{self.n:02d}" if tag else f"{self.p}-{self.n:02d}"


# --------------------------------------------------------------------------- 證據
def _ev(eid, kind, ds, source, summary, data, window=None):
    e = {"id": eid, "kind": kind, "dataset_id": ds, "data_kind": "real", "source": source, "summary": summary, "data": data}
    if window:
        e["window"] = window
    return e


def _overlap(a0, a1, b0, b1) -> bool:
    return not (a1 < b0 or b1 < a0)


def merge_events(events: list[dict]) -> list[dict]:
    """同一種類、時間重疊的事件合併成一組（例如 DO 與 DO飽和度 同時卡住 = 一件事）。不比較不同種類的分數（量尺不同）。"""
    groups: list[dict] = []
    by_kind: dict[str, list[dict]] = {}
    for e in events:
        by_kind.setdefault(e["kind"], []).append(e)
    for kind, es in by_kind.items():
        es = sorted(es, key=lambda e: (e["start"], e["end"]))
        cur = None
        for e in es:
            if cur and e["start"] <= cur["end"]:
                cur["members"].append(e)
                cur["end"] = max(cur["end"], e["end"])
            else:
                cur = {"kind": kind, "start": e["start"], "end": e["end"], "members": [e]}
                groups.append(cur)
    for g in groups:
        g["columns"] = sorted({m["column"] for m in g["members"]})
        g["detectors"] = sorted({m["detector"] for m in g["members"]})
        g["score"] = max(m["score"] for m in g["members"])
        g["member_index"] = [i for i, m in enumerate(events) if m in g["members"]]
    return groups


def _hours(s: str, e: str) -> int:
    from datetime import datetime
    f = "%Y-%m-%d %H:%M:%S"
    return int(round((datetime.strptime(e, f) - datetime.strptime(s, f)).total_seconds() / 3600)) + 1


def build(bundle: dict) -> dict:
    """bundle → 決策輔助回應。bundle 的內容全部來自引擎的真實輸出（見 collect.py）。"""
    ds = bundle["dataset"]
    did = ds["id"]
    reg = REGISTRY["domains"].get(did, {"formal_engine": False, "policy_status": "none", "validated_policy": False})
    src = bundle.get("sources", {})
    ver = bundle.get("engine_version", "")
    ev: list[dict] = []
    recs: list[dict] = []
    evid = _Ids("E")
    rid = _Ids("R")

    def S(artifact, pointer):
        return {"artifact": artifact, "pointer": pointer, "engine_version": ver}

    # ---- 涵蓋與時間（一律產生；是所有建議的共同前提）
    t = ds["time"]
    q = bundle.get("quality") or {}
    qs = q.get("sensors", [])
    n_missing_sensors = [s for s in qs if (s.get("missing_hours") or 0) > 0]
    cov = _ev(evid.next("COV-"), "coverage", did, S(src.get("quality", "quality"), "timestamp,sensors"),
              f"資料 {t['start']} 到 {t['end']}，共 {t['rows']} 筆（每小時一筆）；時間缺口 {t['n_gaps']} 段、缺 {t['missing_hours_from_gaps']} 小時；有缺漏的感測器 {len(n_missing_sensors)} 個，全部感測器平均有讀值比例 {_pct(q.get('mean_observed_frac'))}。",
              {"rows": t["rows"], "start": t["start"], "end": t["end"], "n_gaps": t["n_gaps"], "missing_hours_from_gaps": t["missing_hours_from_gaps"],
               "sensors_with_missing": len(n_missing_sensors), "mean_observed_frac": q.get("mean_observed_frac")},
              {"start": t["start"], "end": t["end"]})
    ev.append(cov)

    # ---- R-COV：資料缺漏（一般建議；缺漏筆數是直接計數 → high）
    if n_missing_sensors:
        worst = sorted(n_missing_sensors, key=lambda s: -s["missing_hours"])[: DP["top_sensors_missing"]]
        e = _ev(evid.next("DQ-"), "data_quality", did, S(src.get("quality", "quality"), "sensors[missing_hours>0]"),
                "缺漏最多的感測器：" + "；".join(f"{s['sensor']} 缺 {s['missing_hours']} 小時（有讀值比例 {_pct(s['observed_frac'])}）" for s in worst) + "。",
                {"sensors": [{"sensor": s["sensor"], "missing_hours": s["missing_hours"], "observed_frac": s["observed_frac"]} for s in worst], "n_sensors_with_missing": len(n_missing_sensors)})
        ev.append(e)
        recs.append(_rec(rid.next(), "general", "data_check", "先檢查資料缺漏，再使用這些感測器的分析結果",
                         ["check_data_pipeline", "verify_sensor_source"],
                         f"有 {len(n_missing_sensors)} 個感測器出現缺漏，缺漏最多的是 " + "、".join(s["sensor"] for s in worst) + "。缺漏是資料事實，原因不明；建議先檢查資料傳輸與來源，再解讀依賴這些感測器的圖表與預測。",
                         [cov["id"], e["id"]],
                         _conf("high", [("direct_count", "缺漏小時數是直接從資料計數得到的，不是推論。")]),
                         ["只說明『哪裡有缺』，不判斷原因（斷線、斷電、停機或感測器問題都有可能）。"],
                         {"applies_to": "此場域所有使用到上述感測器的分析", "not_applicable_when": ["資料已補齊或確認缺漏為正常停機"]}))

    # ---- R-AN：候選異常（需要人工確認）
    an = bundle.get("anomalies") or {"events": [], "n_events": 0}
    events = an.get("events", [])
    runs = q.get("runs", [])
    groups = merge_events(events)
    shown: list[dict] = []
    for kind in sorted({g["kind"] for g in groups}):
        gk = sorted([g for g in groups if g["kind"] == kind], key=lambda g: -g["score"])
        shown += gk[: DP["top_groups_per_kind"]]
    n_groups_total = len(groups)
    if events:
        ov = _ev(evid.next("AN-"), "anomaly_overview", did, S(src.get("anomalies", "anomalies"), "events"),
                 f"偵測器共輸出 {an.get('n_events', len(events))} 筆候選事件（引擎依分數排序，取前 {len(events)} 筆納入分析），合併成 {n_groups_total} 組（同種類且時間重疊者視為一組）；每個種類依該種類自己的分數各取前 {DP['top_groups_per_kind']} 組，共 {len(shown)} 組列入建議，其餘 {n_groups_total - len(shown)} 組不在人工確認清單內。",
                 {"n_events": an.get("n_events", len(events)), "n_events_used": len(events), "n_groups": n_groups_total, "n_groups_shown": len(shown), "n_groups_not_shown": n_groups_total - len(shown), "kinds": {k: sum(1 for g in groups if g['kind'] == k) for k in sorted({g['kind'] for g in groups})}})
        ev.append(ov)
    for g in shown:
        kzh = KIND_ZH.get(g["kind"], g["kind"])
        cols_txt = "、".join("整列（全部感測器）" if c == "*" else c for c in g["columns"])
        hrs = _hours(g["start"], g["end"])
        # 第二條獨立分析路徑：資料品質掃描的連續區段（只有登錄的對應種類才交叉佐證）
        corro = [r for r in runs if r["run_type"] in QUALITY_COMPAT.get(g["kind"], set()) and r["sensor"] in g["columns"] and _overlap(g["start"], g["end"], r["start"], r["end"])]
        sources = set(g["detectors"]) | ({"quality_runs"} if corro else set())
        notes = sorted({m["note"] for m in g["members"] if m.get("note")})[:2]
        e = _ev(evid.next("AN-"), "anomaly_candidate", did, S(src.get("anomalies", "anomalies"), "events[" + ",".join(str(i) for i in g["member_index"][:6]) + "]"),
                f"{kzh}：感測器 {cols_txt}，{g['start']} 到 {g['end']}（約 {hrs} 小時）；偵測器 {'、'.join(g['detectors'])}；分數 {_fmt(g['score'])}"
                + (f"；偵測器說明：{'；'.join(notes)}（偵測器參考值由此場域歷史資料推得，不是警戒門檻）" if notes else "")
                + (f"；資料品質掃描在同一時段、同一感測器也標出{len(corro)}段連續區段" if corro else "；資料品質掃描沒有在同一時段交叉佐證"),
                {"kind": g["kind"], "columns": g["columns"], "start": g["start"], "end": g["end"], "hours": hrs, "score": g["score"], "detectors": g["detectors"],
                 "n_members": len(g["members"]), "quality_corroboration": [{"sensor": r["sensor"], "run_type": r["run_type"], "start": r["start"], "end": r["end"], "hours": r["hours"], "severity": r["severity"]} for r in corro][:4]},
                {"start": g["start"], "end": g["end"]})
        ev.append(e)
        independent = len(sources)
        if independent >= 2:
            conf = _conf("medium", [("independent_paths", f"{independent} 條獨立實作的分析路徑對同一現象一致：{'、'.join(sorted(sources))}。這提高『資料中確實出現此現象』的把握，不代表原因已知，也不是現場證據。")], "候選事件沒有現場真值，可信程度最高 medium。")
        else:
            conf = _conf("low", [("single_path", f"只有一條分析路徑（{'、'.join(sorted(sources))}）。")], "候選事件沒有現場真值，可信程度最高 medium。")
        recs.append(_rec(rid.next("AN-"), "needs_human_review", "anomaly_review", f"請人員確認「{cols_txt}」的{kzh}候選事件（{g['start']} 起）",
                         ["verify_sensor_source", "manual_remeasure", "request_human_confirmation"],
                         f"偵測器在 {g['start']} 到 {g['end']}（約 {hrs} 小時）對 {cols_txt} 標出「{kzh}」候選事件。這是候選，不是故障判定；請到現場或查資料來源確認，並以人工複測對照。",
                         [e["id"]], conf,
                         ["候選事件只表示『與該場域自己的歷史行為不同』，不是故障、也不是危險；原因要由人確認。",
                          "偵測器沒有用任何情境真值校準，也沒有宣稱準確度。"],
                         {"applies_to": f"{cols_txt}，{g['start']} 到 {g['end']}", "not_applicable_when": ["現場已確認為正常作業（例如維護、校正、停機）"]}))
    if events and len(groups) > len(shown):
        recs.append(_rec(rid.next(), "general", "monitoring", "其餘候選事件先不逐一處理，列入持續監測",
                         ["continue_monitoring"],
                         f"另有 {len(groups) - len(shown)} 組候選事件沒有列入上面的人工確認清單（各種類只列分數最高的前 {DP['top_groups_per_kind']} 組）；完整清單可在異常頁查看。",
                         [ov["id"]], _conf("high", [("direct_count", "組數是直接計數。")]),
                         ["沒有列入清單不代表不重要，只是呈現上限。"],
                         {"applies_to": "此場域的候選異常總覽", "not_applicable_when": []}))

    # ---- R-QR：資料品質掃描標為『需要確認』的連續區段（引擎自己的旗標；單一路徑 → low）
    chk = [r for r in runs if r.get("severity") == "check"]
    if chk:
        by_s: dict[str, list[dict]] = {}
        for r in chk:
            by_s.setdefault(r["sensor"], []).append(r)
        top = sorted(by_s.items(), key=lambda kv: -sum(x["hours"] for x in kv[1]))[: DP["top_sensors_runs"]]
        for sensor, rs in top:
            longest = max(rs, key=lambda x: x["hours"])
            types = sorted({x["run_type"] for x in rs})
            types_zh = [RUN_ZH.get(x, x) for x in types]
            e = _ev(evid.next("QR-"), "quality_run", did, S(src.get("quality", "quality"), f"runs[sensor={sensor},severity=check]"),
                    f"感測器 {sensor}：資料品質掃描標出 {len(rs)} 段需要確認的連續區段（種類 {'、'.join(types_zh)}），合計 {sum(x['hours'] for x in rs)} 小時，最長一段 {longest['hours']} 小時（{longest['start']} 到 {longest['end']}）。引擎說明：{longest['label']}",
                    {"sensor": sensor, "n_runs": len(rs), "run_types": types, "total_hours": sum(x["hours"] for x in rs), "longest": {k: longest[k] for k in ("start", "end", "hours", "run_type")}},
                    {"start": min(x["start"] for x in rs), "end": max(x["end"] for x in rs)})
            ev.append(e)
            recs.append(_rec(rid.next("QR-"), "needs_human_review", "data_check", f"請人員依脈絡確認「{sensor}」的長時間{'、'.join(types_zh)}區段",
                             ["verify_sensor_source", "request_human_confirmation"],
                             f"資料品質掃描在 {sensor} 標出 {len(rs)} 段長時間的「{'、'.join(types_zh)}」區段（合計 {sum(x['hours'] for x in rs)} 小時，最長 {longest['hours']} 小時）。這可能是正常的穩定狀態（例如低值、低負載、夜間或停機），也可能是感測或通訊問題；需要有脈絡的人確認，系統不判斷。",
                             [e["id"]], _conf("low", [("single_path", "只有資料品質掃描一條分析路徑。")], "候選事件沒有現場真值，可信程度最高 medium。"),
                             ["連續區段只表示讀值長時間不變或為零，不代表感測器有問題。", "是否正常取決於感測器的意義與當時的運轉狀態。"],
                             {"applies_to": f"{sensor} 的{'、'.join(types_zh)}區段", "not_applicable_when": ["已確認為正常作業（維護、停機、夜間低值）"]}))

    # ---- R-FC / R-NA：預測（可用 → 模型適用性；不可用 → 明確拒絕，不給預測值）
    tasks = ds.get("forecast_tasks", [])
    enabled = [t_ for t_ in tasks if t_.get("enabled")]
    fcs = bundle.get("forecasts") or {}
    capability = {"data_checks": True, "anomaly_review": bool(events),
                  "forecast": {"status": "available" if enabled else "not_available", "reason": None},
                  "formal_risk": {"status": "available" if (reg.get("formal_engine") and bundle.get("formal")) else "not_available",
                                  "reason": None if reg.get("formal_engine") else "此場域沒有登錄的正式決策引擎與經驗證政策；只提供一般建議與需要人工確認的異常。",
                                  "policy_status": reg.get("policy_status", "none"), "validated_policy": bool(reg.get("validated_policy"))}}
    if not enabled:
        reasons = sorted({t_.get("policy_notes") for t_ in tasks if t_.get("policy_notes")})
        reason = reasons[0] if reasons else "引擎沒有為此場域開放任何預測任務。"
        capability["forecast"]["reason"] = reason
        e = _ev(evid.next("NA-"), "availability", did, S(src.get("catalog", "catalog"), "forecast_tasks[enabled=false]"),
                f"此場域沒有開放的預測任務（共 {len(tasks)} 個任務全部不可用）。原因：{reason}", {"n_tasks": len(tasks), "n_enabled": 0, "reason": reason, "rows": t["rows"]})
        ev.append(e)
        recs.append(_rec(rid.next(), "general", "model_applicability", "資料不足或模型不適用：不提供預測，先做資料檢查",
                         ["accumulate_more_data", "check_data_pipeline"],
                         "此場域目前不提供任何預測：" + reason + " 建議先改善資料的連續性與涵蓋，再評估是否可建模；在那之前只提供資料檢查與候選異常確認。",
                         [e["id"]], _conf("high", [("engine_refusal", "這是引擎依凍結協定的明確拒絕，不是推論。")]),
                         ["拒絕建模不代表資料沒有價值，只是目前的資料不足以支持可靠的預測。", "這裡不會出現任何預測值。"],
                         {"applies_to": "此場域所有預測任務", "not_applicable_when": ["累積足夠連續資料並重新評估後"]}))
    else:
        by_sensor: dict[str, list[dict]] = {}
        for t_ in enabled:
            f = fcs.get(t_["task_id"])
            if f:
                by_sensor.setdefault(f["sensor"], []).append(f)
        for sensor in sorted(by_sensor):
            fl = sorted(by_sensor[sensor], key=lambda f: f["horizon_h"])
            rows_, cites, any_supported = [], [], False
            all_agree_neg = True
            for f in fl:
                fam = {k: f["evidence_flags"][k] for k in f["evidence_flags"]}
                best_k = max(fam, key=lambda k: (fam[k]["rel_val"] if fam[k]["rel_val"] is not None else -9))
                b = fam[best_k]
                sup = any(fam[k].get("supported") for k in fam)
                any_supported = any_supported or sup
                if not (b["rel_val"] is not None and b["rel_hold"] is not None and b["rel_val"] <= 0 and b["rel_hold"] <= 0):
                    all_agree_neg = False
                rows_.append({"task_id": f["task_id"], "horizon_h": f["horizon_h"], "best_baseline": f["best_baseline"], "best_ml": best_k,
                              "rel_val": b["rel_val"], "rel_hold": b["rel_hold"], "cv_wins": b["cv_wins"], "cv_folds": b["cv_folds"], "supported": bool(sup),
                              "unit": f.get("unit"), "unit_status": f.get("unit_status")})
                e = _ev(evid.next("FC-"), "forecast_task", did, S(src.get("forecasts", "forecasts"), f"tasks[{rows_[-1]['task_id']}].metrics,evidence_flags"),
                        f"{sensor} 預測 +{f['horizon_h']} 小時：最佳簡單基準為 {f['best_baseline']}；表現最好的機器學習模型 {best_k}，驗證期誤差比基準{'低' if (b['rel_val'] or 0) > 0 else '高'} {_pct(b['rel_val'])}，留存期{'低' if (b['rel_hold'] or 0) > 0 else '高'} {_pct(b['rel_hold'])}；交叉驗證勝 {b['cv_wins']}／{b['cv_folds']} 折；"
                        f"{'達到' if sup else '未達'}探索性訊號條件。",
                        {k: rows_[-1][k] for k in ("task_id", "horizon_h", "best_baseline", "best_ml", "rel_val", "rel_hold", "cv_wins", "cv_folds", "supported")},
                        {"start": f["origin_range"][0], "end": f["origin_range"][1]})
                ev.append(e)
                cites.append(e["id"])
            base = fl[0]["best_baseline"]
            per_h = "；".join(f"+{r['horizon_h']} 小時（驗證期{'低' if (r['rel_val'] or 0) > 0 else '高'} {_pct(r['rel_val'])}、留存期{'低' if (r['rel_hold'] or 0) > 0 else '高'} {_pct(r['rel_hold'])}）" for r in rows_)
            sup_h = [r for r in rows_ if r["supported"]]
            if not any_supported:
                conf = _conf("medium", [("two_windows_agree", "驗證期與留存期的比較方向一致（機器學習模型都沒有勝過簡單基準）。")], "『沒有證據顯示模型較好』的說法在兩個評估期一致時最高 medium。") if all_agree_neg else \
                       _conf("low", [("windows_disagree", "驗證期與留存期的比較方向不一致（至少一個時距在其中一個評估期看起來較好，但沒有達到探索性訊號條件）。")], None)
                recs.append(_rec(rid.next(), "general", "model_applicability", f"{sensor} 的預測：目前沒有證據顯示機器學習模型比簡單基準好",
                                 ["use_baseline_as_reference", "continue_monitoring"],
                                 f"{sensor} 的 {len(rows_)} 個預測任務中，機器學習模型都沒有達到探索性訊號條件；建議以簡單基準（{base}）作為對照參考，不要把機器學習預測當成更可靠的依據。"
                                 f"最佳機器學習模型相對基準的誤差：{per_h}。" + ("" if all_agree_neg else "驗證期與留存期的方向不一致，結論更不穩。"),
                                 cites, conf,
                                 ["這是研究預測（探索性）；留存測試期只是描述性診斷，不是準確度保證。", "這是歷史時點模擬預測，不是即時監控。"],
                                 {"applies_to": f"{sensor} 的 {len(rows_)} 個預測任務", "not_applicable_when": ["資料分布明顯改變後重新評估"]}))
            else:
                recs.append(_rec(rid.next(), "general", "model_applicability", f"{sensor} 的預測：有探索性訊號，僅供參考",
                                 ["use_baseline_as_reference", "continue_monitoring"],
                                 f"{sensor} 只有 {'、'.join('+' + str(r['horizon_h']) + ' 小時' for r in sup_h)} 的機器學習模型達到探索性訊號條件，其他時距沒有；這只是探索性的，尚未經獨立前瞻驗證，建議與簡單基準（{base}）並排對照，不要單獨依賴。"
                                 f"最佳機器學習模型相對基準的誤差：{per_h}。",
                                 cites, _conf("low", [("exploratory_signal", "探索性訊號：未經獨立前瞻驗證。")], "『模型比基準好』這類正面說法最高 low。"),
                                 ["探索性訊號不等於可靠預測。", "這是歷史時點模擬預測，不是即時監控。"],
                                 {"applies_to": f"{sensor} 的 {len(rows_)} 個預測任務", "not_applicable_when": ["資料分布明顯改變後重新評估"]}))

    # ---- R-FM：正式風險決策（只有登錄表登記的正式引擎；原樣引用，不改寫）
    fm = bundle.get("formal")
    if reg.get("formal_engine") and fm:
        res = fm["result"]
        rk = res["risk"]
        e = _ev(evid.next("FM-"), "formal_decision", did, S(src.get("formal", "formal_sheep"), "formal.rows[-1]"),
                f"羊舍正式決策引擎（{fm['model_version']}，嚴格回放，樣本內：{'是' if fm['in_sample'] else '否'}）在 {fm['as_of']}：目前 THI {_fmt(res['current_thi'])}，3 小時後點預測 {_fmt(res['point_prediction'])}"
                f"（90% 區間 {_fmt(res['prediction_interval']['lower'])}–{_fmt(res['prediction_interval']['upper'])}）；風險等級 {rk['risk_level']}；超過候選門檻 {_fmt(rk['threshold'])} 的機率 {_fmt(rk['p_exceed'], 3)}；感測器可信度 {res['sensor_reliability']}；處置分類 {res['handling']}；引擎原因：{'；'.join(rk['risk_reasons'])}。",
                {"formal_row": copy.deepcopy(fm)}, {"start": res["origin_time"], "end": res["target_time"]})
        ev.append(e)
        recs.append(_rec(rid.next("FM-"), "formal_risk", "formal_risk", "羊舍正式決策輸出（原樣引用既有決策引擎）",
                         ["increase_monitoring", "request_human_confirmation"] if rk["risk_level"] not in ("normal",) else ["continue_monitoring"],
                         f"既有羊舍決策引擎在 {fm['as_of']} 輸出風險等級「{rk['risk_level']}」；原因：{'；'.join(rk['risk_reasons'])}。門檻 {_fmt(rk['threshold'])} 的狀態是「{rk['threshold_status']}」（候選值，不是確認的標準）。本系統不控制任何設備，處置由人決定。",
                         [e["id"]], _conf("high", [("registered_engine_verbatim", "原樣引用已登錄正式引擎的輸出，沒有改寫；『high』只代表引用忠實，不代表門檻已被確認。")]),
                         [reg["policy_note"], "預測是研究預測（探索性、未經獨立前瞻驗證）；這是歷史回放，不是即時系統。"],
                         {"applies_to": "羊舍成羊區 THI +3 小時", "not_applicable_when": ["全資料模型示範（樣本內）", "感測器可信度為 unreliable"]}))

    resp = {"schema": SCHEMA, "dataset_id": did, "display_name": ds["display_name"], "data_kind": "real", "engine_version": ver, "generated_at": bundle.get("generated_at"),
            "capability": capability,
            "policy": {"confidence_meaning": REGISTRY["confidence_meaning"], "registry_entry": {k: v for k, v in reg.items() if k in ("formal_engine", "policy_status", "validated_policy", "policy_note")},
                       "tiers": REGISTRY["tiers"], "confidence_ladder": REGISTRY["confidence_ladder"], "forbidden": REGISTRY["forbidden"]},
            "tier_summary": {t_: sum(1 for r in recs if r["tier"] == t_) for t_ in TIERS},
            "evidence": ev, "recommendations": recs, "generic_limitations": GENERIC_LIMITS,
            "notes": "每項建議的可信程度、限制與證據都由規則層決定；Gemini 只負責把它們改寫成白話，不能更動。"}
    problems = validate(resp)
    if problems:
        raise AssertionError("決策輔助違反硬性規則：" + "；".join(problems[:6]))
    return resp


def _rec(rid_, tier, category, title, actions, statement, evidence_ids, confidence, limits, applicability) -> dict:
    return {"id": rid_, "tier": tier, "category": category, "title": title, "action_codes": actions, "statement": statement, "evidence_ids": evidence_ids,
            "confidence": confidence, "limitations": limits + GENERIC_LIMITS, "applicability": applicability, "status": "active",
            "guard": {"thresholds_invented": False, "fault_verdict": False, "actuation": False}}


# --------------------------------------------------------------------------- 硬性護欄
def validate(resp: dict) -> list[str]:
    P: list[str] = []
    did = resp["dataset_id"]
    reg = REGISTRY["domains"].get(did, {"formal_engine": False})
    ids = {e["id"] for e in resp["evidence"]}
    if len(ids) != len(resp["evidence"]):
        P.append("證據編號重複")
    rid_seen = set()
    has_forecast_ev = any(e["kind"] == "forecast_task" for e in resp["evidence"])
    for r in resp["recommendations"]:
        if r["id"] in rid_seen:
            P.append(f"{r['id']}：建議編號重複")
        rid_seen.add(r["id"])
        if r["tier"] not in TIERS:
            P.append(f"{r['id']}：未知的層級 {r['tier']}")
        if r["tier"] == "formal_risk" and not reg.get("formal_engine"):
            P.append(f"{r['id']}：{did} 沒有登錄的正式決策引擎，不得出現 formal_risk")
        if not r["evidence_ids"] or any(i not in ids for i in r["evidence_ids"]):
            P.append(f"{r['id']}：證據編號缺漏或不存在")
        if r["confidence"]["level"] not in CONF_LEVELS or not r["confidence"]["basis"]:
            P.append(f"{r['id']}：可信程度缺漏或沒有依據")
        if r["tier"] == "needs_human_review" and r["confidence"]["level"] in ("high",):
            P.append(f"{r['id']}：候選事件的可信程度不得是 high")
        if not r["limitations"]:
            P.append(f"{r['id']}：缺少限制")
        if any(a not in ACTIONS for a in r["action_codes"]):
            P.append(f"{r['id']}：行動不在登錄的 allowed_actions 內")
        txt = r["title"] + "\n" + r["statement"]
        if FAULT_RE.search(txt):
            P.append(f"{r['id']}：出現故障／更換結論字樣")
        if ACTUATION_RE.search(txt):
            P.append(f"{r['id']}：出現自動控制字樣")
        if r["tier"] != "formal_risk" and THRESHOLD_RE.search(txt):
            P.append(f"{r['id']}：非正式層出現門檻式字樣")
        if not has_forecast_ev and PREDICTION_RE.search(txt):
            P.append(f"{r['id']}：沒有預測證據卻出現預測值")
    if resp["capability"]["forecast"]["status"] == "not_available":
        if any(e["kind"] == "forecast_task" for e in resp["evidence"]):
            P.append("預測不可用卻有預測證據")
    return P
