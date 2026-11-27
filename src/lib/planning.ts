// 長期規劃（管理員）：把各場域的歷史資料事件整理成統計（事實），再交給 AI（或規則式備援）提出短／中／長期規劃。
// 這裡只做統計與規則；AI 只能引用這些統計，不能自己產生數字（伺服器端會核對）。
import type { Fact } from "../../contracts/types";
import type { ParsedCsvRow } from "../types/app";
import { KIND_INFO, sensorCompleteness, summarize, type EventKind, type MaskResult, type ResolvedEvent } from "./events";

const DAY = 86_400_000;

export interface SensorRisk {
  datasetId: string;
  domain: string;
  sensor: string;
  /** 資料故障類事件數（斷線、缺值、卡住、維修，或人工確認為故障） */
  faults: number;
  hours: number;
  lastEnd: string;
  kinds: EventKind[];
  recurring: boolean;
}

export interface DomainEventStats {
  datasetId: string;
  name: string;
  events: number;
  faults: number;
  masked: number;
  maskedHours: number;
  spanDays: number;
  /** 資料故障事件：每 30 天幾次 */
  faultsPer30d: number;
  completenessPct: number | null;
  byKind: Partial<Record<EventKind, number>>;
  longest: { kind: EventKind; sensor: string; hours: number; start: string } | null;
  /** 資料故障事件開始時刻的尖峰 3 小時窗（事件夠多時才有） */
  peak: { fromHour: number; share: number } | null;
  trend: "up" | "down" | "flat" | null;
  topSensors: SensorRisk[];
}

export const isFault = (e: ResolvedEvent): boolean => e.status !== "real" && (e.status === "fault" || KIND_INFO[e.kind].group === "fault" || e.kind === "maintenance");

const shortName = (n: string) => n.split("（")[0];

export function buildDomainStats(datasetId: string, name: string, events: ResolvedEvent[], rows: ParsedCsvRow[] | null, masked: MaskResult | null): DomainEventStats {
  const live = events.filter((e) => !e.archived || e.source !== "precomputed");
  const sum = summarize(live);
  const faults = live.filter(isFault);
  const lo = Math.min(rows?.[0]?.tsMs ?? Infinity, ...live.map((e) => e.startMs));
  const hi = Math.max(rows?.[rows.length - 1]?.tsMs ?? -Infinity, ...live.map((e) => e.endMs));
  const spanDays = Number.isFinite(lo) && Number.isFinite(hi) && hi > lo ? Math.max(1, Math.round((hi - lo) / DAY)) : 0;

  let longest: DomainEventStats["longest"] = null;
  for (const e of faults) if (!longest || e.hours > longest.hours) longest = { kind: e.kind, sensor: e.sensor, hours: e.hours, start: e.start };

  let peak: DomainEventStats["peak"] = null;
  if (faults.length >= 8) {
    const hist = new Array<number>(24).fill(0);
    for (const e of faults) hist[new Date(e.startMs).getHours()] += 1;
    let best = 0;
    let at = 0;
    for (let h = 0; h < 24; h++) {
      const n = hist[h] + hist[(h + 1) % 24] + hist[(h + 2) % 24];
      if (n > best) {
        best = n;
        at = h;
      }
    }
    const share = best / faults.length;
    if (share >= 0.45) peak = { fromHour: at, share };
  }

  let trend: DomainEventStats["trend"] = null;
  if (faults.length >= 6 && Number.isFinite(lo) && hi > lo) {
    const mid = (lo + hi) / 2;
    const a = faults.filter((e) => e.startMs < mid).length;
    const b = faults.length - a;
    trend = b >= a * 1.5 + 1 ? "up" : a >= b * 1.5 + 1 ? "down" : "flat";
  }

  const per = new Map<string, SensorRisk>();
  for (const e of faults) {
    if (e.sensor === "*") continue;
    const r = per.get(e.sensor) ?? { datasetId, domain: shortName(name), sensor: e.sensor, faults: 0, hours: 0, lastEnd: "", kinds: [], recurring: false };
    r.faults += 1;
    r.hours += e.hours;
    if (e.end > r.lastEnd) r.lastEnd = e.end;
    if (!r.kinds.includes(e.kind)) r.kinds.push(e.kind);
    per.set(e.sensor, r);
  }
  const topSensors = [...per.values()]
    .map((r) => ({ ...r, recurring: r.faults >= 3 }))
    .sort((a, b) => b.faults * 2 + b.hours / 24 - (a.faults * 2 + a.hours / 24))
    .slice(0, 5);

  let completenessPct: number | null = null;
  if (rows && rows.length > 0 && masked) {
    const sensors = Array.from(new Set(rows.slice(0, 5).flatMap((r) => Object.keys(r.values))));
    const c = sensorCompleteness(rows, sensors, masked);
    completenessPct = c.length ? c.reduce((a, x) => a + x.validPct, 0) / c.length : null;
  }

  return {
    datasetId,
    name,
    events: sum.total,
    faults: faults.length,
    masked: sum.masked,
    maskedHours: sum.maskedHours,
    spanDays,
    faultsPer30d: spanDays > 0 ? Number(((faults.length * 30) / spanDays).toFixed(1)) : 0,
    completenessPct,
    byKind: sum.byKind,
    longest,
    peak,
    trend,
    topSensors,
  };
}

/** 全部場域裡最該先處理的感測器（資料故障次數與時數） */
export function rankSensors(stats: DomainEventStats[], max = 8): SensorRisk[] {
  return stats
    .flatMap((s) => s.topSensors)
    .sort((a, b) => b.faults * 2 + b.hours / 24 - (a.faults * 2 + a.hours / 24))
    .slice(0, max);
}

const KIND_LIST = (byKind: DomainEventStats["byKind"]) =>
  (Object.entries(byKind) as Array<[EventKind, number]>)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([k, n]) => `${KIND_INFO[k].zh} ${n} 筆`)
    .join("、");

export const TREND_ZH = { up: "增加", down: "減少", flat: "持平" } as const;

/** 交給 AI 的事實清單（AI 只能引用這裡出現的數字） */
export function buildPlanFacts(stats: DomainEventStats[], ranking: SensorRisk[]): Fact[] {
  const facts: Fact[] = [];
  const add = (text: string, value?: number, unit?: string) => facts.push({ id: `p${facts.length + 1}`, text, value, unit });
  const tot = stats.reduce((a, s) => a + s.events, 0);
  const totFault = stats.reduce((a, s) => a + s.faults, 0);
  add(`七個場域的資料事件紀錄共 ${tot} 筆，其中資料故障類（斷線、缺值、卡住、維修）${totFault} 筆`, tot, "筆");
  for (const s of stats) {
    if (s.events === 0) continue;
    add(
      `${shortName(s.name)}：事件 ${s.events} 筆（${KIND_LIST(s.byKind)}），資料故障 ${s.faults} 筆，資料涵蓋約 ${s.spanDays} 天，平均每 30 天 ${s.faultsPer30d} 次；已排除於分析 ${s.masked} 筆、約 ${s.maskedHours} 小時${s.completenessPct !== null ? `；感測器讀值完整度平均 ${s.completenessPct.toFixed(1)}%` : ""}`
    );
    if (s.longest) add(`${shortName(s.name)}：最長的資料故障是「${KIND_INFO[s.longest.kind].zh}」${s.longest.sensor === "*" ? "（整個場域）" : `（${s.longest.sensor}）`}，持續 ${s.longest.hours} 小時，始於 ${s.longest.start.slice(0, 16)}`, s.longest.hours, "小時");
    if (s.peak) add(`${shortName(s.name)}：資料故障集中在 ${s.peak.fromHour} 點到 ${s.peak.fromHour + 3} 點開始（占 ${Math.round(s.peak.share * 100)}%）`);
    if (s.trend) add(`${shortName(s.name)}：前後半段比較，資料故障事件${TREND_ZH[s.trend]}`);
  }
  for (const r of ranking) {
    add(`反覆出問題的感測器：${r.domain}的「${r.sensor}」資料故障 ${r.faults} 次、合計 ${r.hours} 小時，類型 ${r.kinds.map((k) => KIND_INFO[k].zh).join("、")}，最近一次到 ${r.lastEnd.slice(0, 16)}`, r.faults, "次");
  }
  return facts.slice(0, 60);
}

export type Horizon = "short" | "mid" | "long";
export const HORIZON_ZH: Record<Horizon, string> = { short: "短期（一個月內）", mid: "中期（一季內）", long: "長期（半年以上）" };

export interface PlanItem {
  id: string;
  horizon: Horizon;
  text: string;
  /** 依據（哪個場域、哪個統計） */
  basis?: string;
  /** 規則式規劃會帶出對應的場域與感測器，指派成任務時可直接連到事件頁 */
  datasetId?: string;
  sensor?: string;
}

export interface Plan {
  summary: string;
  findings: string[];
  causes: string[];
  items: PlanItem[];
  limits: string[];
  source: "gemini" | "local";
  /** AI 回答含有對不上系統統計的數字時為 false */
  grounded: boolean;
}

/** 沒有 Gemini 時的規則式規劃：每一條都標明依據。 */
export function buildLocalPlan(stats: DomainEventStats[], ranking: SensorRisk[]): Plan {
  const items: PlanItem[] = [];
  const findings: string[] = [];
  const add = (horizon: Horizon, text: string, basis?: string, ref?: { datasetId: string; sensor?: string }) => items.push({ id: `${horizon}-${items.length + 1}`, horizon, text, basis, ...ref });
  const withEvents = stats.filter((s) => s.events > 0);
  const totFault = stats.reduce((a, s) => a + s.faults, 0);
  const worst = [...stats].sort((a, b) => b.faultsPer30d - a.faultsPer30d)[0];

  for (const r of ranking.filter((x) => x.recurring).slice(0, 3)) {
    add("short", `到現場檢查「${r.sensor}」（${r.domain}）的探頭、接線與供電；確認後排入校正或更換。`, `${r.domain}「${r.sensor}」資料故障 ${r.faults} 次、合計 ${r.hours} 小時`, { datasetId: r.datasetId, sensor: r.sensor });
  }
  for (const s of withEvents) {
    if (s.longest && s.longest.hours >= 24 && (s.longest.kind === "row_gap" || s.longest.kind === "outage_zero")) {
      add("short", `${shortName(s.name)}：檢查電源與通訊線路，並設定「超過數小時沒有新資料」就通知負責人。`, `最長一次${KIND_INFO[s.longest.kind].zh}持續 ${s.longest.hours} 小時`, { datasetId: s.datasetId });
      add("mid", `${shortName(s.name)}：評估備援電源與備援通訊（例如備用網路），降低整場域斷線。`, `最長一次${KIND_INFO[s.longest.kind].zh}持續 ${s.longest.hours} 小時`, { datasetId: s.datasetId });
    }
    if (s.completenessPct !== null && s.completenessPct < 85) {
      add("mid", `${shortName(s.name)}：建立缺漏資料的補登流程，並評估在關鍵位置加裝備援感測器。`, `讀值完整度平均 ${s.completenessPct.toFixed(1)}%`, { datasetId: s.datasetId });
    }
    if ((s.byKind.stuck ?? 0) >= 3) {
      add("mid", `${shortName(s.name)}：把「讀值卡住」納入定期巡檢，訂出各感測器的校正週期。`, `讀值卡住 ${s.byKind.stuck} 筆`, { datasetId: s.datasetId });
    }
    if (s.peak) {
      add("mid", `${shortName(s.name)}：把巡檢與維護安排在 ${s.peak.fromHour} 點之前，避開資料故障集中的時段。`, `資料故障集中在 ${s.peak.fromHour} 點到 ${s.peak.fromHour + 3} 點（${Math.round(s.peak.share * 100)}%）`, { datasetId: s.datasetId });
    }
    if (s.trend === "up") {
      add("short", `${shortName(s.name)}：資料故障事件後半段變多，先釐清原因（設備老化、環境變化、人為變動）。`, "前後半段比較：事件增加", { datasetId: s.datasetId });
    }
  }
  add("long", "每季複審一次風險門檻：事件排除後重算百分位，確認門檻仍符合現況。", "門檻來自歷史資料，會隨事件排除與新資料改變");
  add("long", "累積至少一整年的資料後，再評估季節性與長期趨勢，並檢討預測模型是否需要重新訓練與獨立驗證。", "目前模型是研究預測，尚未經獨立前瞻驗證");
  if (totFault > 0) add("long", "固定每月回顧事件紀錄，把「原因與處理方式」寫進備註，累積成維護知識庫。", `目前共 ${totFault} 筆資料故障事件`);

  if (withEvents.length === 0) findings.push("目前沒有資料事件紀錄，無法從歷史找規律。");
  else {
    findings.push(`資料故障事件共 ${totFault} 筆；平均每 30 天最多的是${worst ? shortName(worst.name) : "—"}（${worst?.faultsPer30d ?? 0} 次）。`);
    for (const r of ranking.slice(0, 3)) findings.push(`「${r.sensor}」（${r.domain}）資料故障 ${r.faults} 次、合計 ${r.hours} 小時。`);
    for (const s of withEvents.filter((x) => x.trend)) findings.push(`${shortName(s.name)}：資料故障事件${TREND_ZH[s.trend!]}。`);
  }
  return {
    summary:
      withEvents.length === 0
        ? "目前沒有足夠的歷史事件可規劃。"
        : `共 ${totFault} 筆資料故障事件；先處理反覆出問題的感測器與斷線較長的場域，再從供電、通訊、校正與門檻複審做長期改善。`,
    findings,
    causes: [],
    items,
    limits: ["這份規則式規劃只依事件統計，無法判斷事件的真正原因，需現場確認。", "事件偵測是候選事件，不是故障判定；人工標註會影響統計。"],
    source: "local",
    grounded: true,
  };
}
