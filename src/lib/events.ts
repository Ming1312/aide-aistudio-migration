// 資料事件：缺值、斷線、卡住、突然跳動…。
// 來源有三種：離線偵測器（anomalies.json）、瀏覽器內對原始＋匯入資料的偵測、人工補記。
// 每個事件有「是否排除於分析之外」：排除的時段不進門檻計算、不進簡易預測（視為缺值），
// 並把「資料不可信」告訴決策與 AI，讓模型只用正常資料說話。預設只排除資料故障類（斷線、缺值、卡住、維修）；
// 突然跳動／漂移／超出歷史範圍可能是真實事件，預設保留，由人標註後才排除。
import type { AnomalyEvent } from "../../contracts/types";
import type { ParsedCsvRow } from "../types/app";
import { parseLocalTimestampMs } from "./trendChart";

const HOUR = 3_600_000;

export type EventKind =
  | "outage_zero"
  | "row_gap"
  | "missing"
  | "stuck"
  | "spike"
  | "drift"
  | "decoupling"
  | "out_of_range"
  | "maintenance"
  | "other";

export type EventGroup = "fault" | "suspect" | "real" | "note";

export const KIND_INFO: Record<EventKind, { zh: string; group: EventGroup; mask: boolean }> = {
  outage_zero: { zh: "斷電（整列歸零）", group: "fault", mask: true },
  row_gap: { zh: "斷線（整列缺失）", group: "fault", mask: true },
  missing: { zh: "缺值", group: "fault", mask: true },
  stuck: { zh: "讀值卡住", group: "fault", mask: true },
  spike: { zh: "突然跳動", group: "suspect", mask: false },
  drift: { zh: "漂移／偏移", group: "suspect", mask: false },
  decoupling: { zh: "與其他感測器脫鉤", group: "suspect", mask: false },
  out_of_range: { zh: "超出歷史範圍", group: "real", mask: false },
  maintenance: { zh: "維修／校正", group: "note", mask: true },
  other: { zh: "其他", group: "note", mask: false },
};

export const GROUP_ZH: Record<EventGroup, string> = {
  fault: "資料故障",
  suspect: "疑似異常",
  real: "可能是真實事件",
  note: "人工記錄",
};

/** 事件類型的顯示順序 */
export const KIND_ORDER: EventKind[] = ["row_gap", "outage_zero", "missing", "stuck", "spike", "drift", "decoupling", "out_of_range", "maintenance", "other"];

export type EventStatus = "fault" | "real" | "pending";
export const STATUS_ZH: Record<EventStatus, string> = { fault: "確認是資料故障", real: "確認是真實事件", pending: "待查" };

export interface DataEvent {
  id: string;
  datasetId: string;
  /** 感測器欄名；"*" ＝整個場域（整列） */
  sensor: string;
  kind: EventKind;
  start: string;
  end: string;
  startMs: number;
  endMs: number;
  hours: number;
  source: "precomputed" | "detected" | "manual";
  score?: number;
  note: string;
  /** 離線偵測器的原始事件（重新交給預測引擎判斷可信度時用） */
  raw?: AnomalyEvent;
}

export interface EventAnnotation {
  mask?: boolean;
  status?: EventStatus;
  comment?: string;
  by?: string;
  at?: string;
}

export interface ResolvedEvent extends DataEvent {
  /** 是否排除於分析之外（預設依類型，標註可覆蓋） */
  mask: boolean;
  defaultMask: boolean;
  status: EventStatus | null;
  comment: string;
  /** 目前資料裡已經看不到，只存在於歷史紀錄 */
  archived: boolean;
  firstSeen?: string;
}

export function fmtMs(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:00`;
}

export function eventId(datasetId: string, sensor: string, kind: EventKind, start: string): string {
  return `${datasetId}|${sensor}|${kind}|${start}`;
}

function make(datasetId: string, sensor: string, kind: EventKind, startMs: number, endMs: number, source: DataEvent["source"], note: string, extra: Partial<DataEvent> = {}): DataEvent {
  const start = fmtMs(startMs);
  return {
    id: eventId(datasetId, sensor, kind, start),
    datasetId,
    sensor,
    kind,
    start,
    end: fmtMs(endMs),
    startMs,
    endMs,
    hours: Math.max(1, Math.round((endMs - startMs) / HOUR) + 1),
    source,
    note,
    ...extra,
  };
}

// ---------- 離線偵測器事件 → 統一格式 ----------

const ANOMALY_KIND: Record<string, EventKind> = {
  outage_zero_rows: "outage_zero",
  outage_missing_rows: "row_gap",
  stuck_sensor: "stuck",
  short_event_or_step: "spike",
  drift_or_offset: "drift",
  decoupling: "decoupling",
  out_of_historical_range: "out_of_range",
};

export function fromAnomaly(datasetId: string, e: AnomalyEvent): DataEvent {
  const kind = ANOMALY_KIND[e.kind] ?? "other";
  const sensor = e.column || "*";
  const startMs = parseLocalTimestampMs(e.start);
  const endMs = parseLocalTimestampMs(e.end) || startMs;
  const ev = make(datasetId, sensor, kind, startMs, endMs, "precomputed", e.note ?? "", { score: e.score, raw: e });
  if (Number.isFinite(e.hours) && e.hours > 0) ev.hours = e.hours;
  return ev;
}

// ---------- 瀏覽器內偵測 ----------

export const MIN_MISSING_H = 3;
export const STUCK_MIN = 12;

export interface SeriesPoint {
  t: number;
  v: number | null;
}

function median(a: number[]): number {
  if (a.length === 0) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * 單一感測器的時間序列：缺值連續段、卡住（連續相同）。
 * 突然跳動、漂移這類要和「同時刻的歷史」比較才準，交給離線偵測器（anomalies.json），這裡不重複做。
 */
export function detectSeriesEvents(datasetId: string, sensor: string, pts: SeriesPoint[]): DataEvent[] {
  const out: DataEvent[] = [];
  if (pts.length === 0) return out;
  const valid = pts.filter((p): p is { t: number; v: number } => typeof p.v === "number" && Number.isFinite(p.v));
  if (valid.length === 0) return out; // 整欄都沒有值：不是「事件」，在完整度裡呈現

  // 缺值連續段
  let i = 0;
  while (i < pts.length) {
    if (typeof pts[i].v === "number" && Number.isFinite(pts[i].v as number)) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < pts.length && !(typeof pts[j + 1].v === "number" && Number.isFinite(pts[j + 1].v as number))) j++;
    const hours = (pts[j].t - pts[i].t) / HOUR + 1;
    if (hours >= MIN_MISSING_H) out.push(make(datasetId, sensor, "missing", pts[i].t, pts[j].t, "detected", `連續 ${Math.round(hours)} 小時沒有讀值`));
    i = j + 1;
  }

  // 卡住：連續相同值。只對「變化夠多」的連續型感測器判斷（避免把開關量當卡住），
  // 並略過「常態值」（例如太陽能電流夜間的 0）：一個值在這一段以外還占 2% 以上的讀值，就是這個感測器的正常休止值
  const freq = new Map<number, number>();
  for (const p of valid) freq.set(p.v, (freq.get(p.v) ?? 0) + 1);
  if (freq.size >= 8) {
    let s = 0;
    for (let k = 1; k <= valid.length; k++) {
      if (k < valid.length && valid[k].v === valid[s].v) continue;
      const n = k - s;
      if (n >= STUCK_MIN && ((freq.get(valid[s].v) ?? 0) - n) / Math.max(1, valid.length - n) < 0.02) out.push(make(datasetId, sensor, "stuck", valid[s].t, valid[k - 1].t, "detected", `連續 ${n} 筆相同（${valid[s].v}）`, { score: n }));
      s = k;
    }
  }

  return out;
}

/** 整列缺失（斷線）：相鄰兩列相隔超過 MIN_MISSING_H 小時 */
export function detectRowGaps(datasetId: string, rows: ParsedCsvRow[]): DataEvent[] {
  const out: DataEvent[] = [];
  for (let i = 1; i < rows.length; i++) {
    const gapH = (rows[i].tsMs - rows[i - 1].tsMs) / HOUR - 1;
    if (gapH >= MIN_MISSING_H) out.push(make(datasetId, "*", "row_gap", rows[i - 1].tsMs + HOUR, rows[i].tsMs - HOUR, "detected", `整列缺失 ${Math.round(gapH)} 小時（斷線）`));
  }
  return out;
}

export function detectDatasetEvents(datasetId: string, rows: ParsedCsvRow[], sensors: string[]): DataEvent[] {
  if (rows.length === 0) return [];
  const sorted = rows;
  const out = detectRowGaps(datasetId, sorted);
  for (const s of sensors) {
    const pts: SeriesPoint[] = sorted.map((r) => ({ t: r.tsMs, v: r.values[s] ?? null }));
    out.push(...detectSeriesEvents(datasetId, s, pts));
  }
  return out;
}

const FAMILY: Partial<Record<EventKind, string>> = { missing: "gap", row_gap: "gap" };
const fam = (k: EventKind) => FAMILY[k] ?? k;

/** 偵測到的事件如果已被離線偵測器（同感測器、同類型、時間重疊）涵蓋，就不重複記錄。 */
export function dropCovered(detected: DataEvent[], known: DataEvent[]): DataEvent[] {
  return detected.filter((d) => {
    for (const k of known) {
      if (k.datasetId !== d.datasetId) continue;
      if (!(k.sensor === d.sensor || k.sensor === "*")) continue;
      if (fam(k.kind) !== fam(d.kind) && !(k.kind === "outage_zero" && d.kind === "row_gap")) continue;
      const ov = Math.min(d.endMs, k.endMs + HOUR) - Math.max(d.startMs, k.startMs - HOUR);
      if (ov >= 0 && ov >= 0.5 * (d.endMs - d.startMs)) return false;
    }
    return true;
  });
}

// ---------- 標註、排除、摘要 ----------

export function resolveEvents(list: DataEvent[], ann: Record<string, EventAnnotation>, currentIds?: Set<string>, firstSeen?: Record<string, string>): ResolvedEvent[] {
  return list.map((e) => {
    const a = ann[e.id];
    const defaultMask = KIND_INFO[e.kind].mask;
    const mask = a?.mask ?? (a?.status === "fault" ? true : a?.status === "real" ? false : defaultMask);
    return {
      ...e,
      mask,
      defaultMask,
      status: a?.status ?? null,
      comment: a?.comment ?? "",
      archived: currentIds ? !currentIds.has(e.id) && e.source !== "manual" : false,
      firstSeen: firstSeen?.[e.id],
    };
  });
}

export interface MaskResult {
  rows: ParsedCsvRow[];
  /** 被設為缺值的格數（感測器 × 時間） */
  maskedCells: number;
  /** 整列被拿掉的列數 */
  droppedRows: number;
  /** 各感測器被排除的筆數 */
  perSensor: Record<string, number>;
}

/** 把「排除於分析」的事件時段從資料拿掉：整列事件（斷電）移除整列；感測器事件把該感測器的值設成缺值。 */
export function applyEventMask(rows: ParsedCsvRow[], events: Array<Pick<ResolvedEvent, "sensor" | "startMs" | "endMs" | "mask" | "kind">>): MaskResult {
  const wholeRow: Array<[number, number]> = [];
  const bySensor = new Map<string, Array<[number, number]>>();
  for (const e of events) {
    if (!e.mask) continue;
    // 斷線（整列缺失）本來就沒有列，不必處理；只有「整列歸零」與整場域的人工事件需要把列拿掉
    if (e.sensor === "*") {
      if (e.kind === "row_gap") continue;
      wholeRow.push([e.startMs, e.endMs]);
    } else {
      const l = bySensor.get(e.sensor) ?? [];
      l.push([e.startMs, e.endMs]);
      bySensor.set(e.sensor, l);
    }
  }
  if (wholeRow.length === 0 && bySensor.size === 0) return { rows, maskedCells: 0, droppedRows: 0, perSensor: {} };
  const perSensor: Record<string, number> = {};
  let maskedCells = 0;
  let droppedRows = 0;
  const out: ParsedCsvRow[] = [];
  for (const r of rows) {
    if (wholeRow.some(([a, b]) => r.tsMs >= a && r.tsMs <= b)) {
      droppedRows += 1;
      for (const [s, v] of Object.entries(r.values)) if (typeof v === "number" && Number.isFinite(v)) perSensor[s] = (perSensor[s] ?? 0) + 1;
      continue;
    }
    let values: ParsedCsvRow["values"] | null = null;
    for (const [s, spans] of bySensor) {
      const v = r.values[s];
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      if (spans.some(([a, b]) => r.tsMs >= a && r.tsMs <= b)) {
        values = values ?? { ...r.values };
        values[s] = null;
        maskedCells += 1;
        perSensor[s] = (perSensor[s] ?? 0) + 1;
      }
    }
    out.push(values ? { ...r, values } : r);
  }
  return { rows: out, maskedCells, droppedRows, perSensor };
}

/** 把解析後的事件交回預測引擎判斷可信度用的格式：被排除的資料事件算「疑似」；使用者標成真實事件的不再拖累可信度。 */
export function toAnomalyEvents(events: ResolvedEvent[]): AnomalyEvent[] {
  const out: AnomalyEvent[] = [];
  const KIND: Partial<Record<EventKind, string>> = {
    missing: "missing_values",
    row_gap: "outage_missing_rows",
    outage_zero: "outage_zero_rows",
    stuck: "stuck_sensor",
  };
  for (const e of events) {
    if (e.source === "precomputed" && e.raw) {
      if (e.mask === e.defaultMask) out.push(e.raw);
      else if (e.mask) out.push({ ...e.raw, kind: KIND[e.kind] ?? "maintenance_window" });
      continue;
    }
    if (!e.mask) continue;
    out.push({
      detector: e.source === "manual" ? "manual" : "browser",
      kind: KIND[e.kind] ?? "maintenance_window",
      kind_zh: KIND_INFO[e.kind].zh,
      column: e.sensor,
      start: e.start,
      end: e.end,
      detected_at: e.end,
      score: e.score ?? e.hours,
      note: e.note,
      hours: e.hours,
    } as AnomalyEvent);
  }
  return out;
}

/** 資料最新時間仍落在「排除中」事件內（卡住、缺值…）：回傳該事件。 */
export function activeMaskedEvent(events: ResolvedEvent[] | undefined, sensor: string, asOfMs: number | null | undefined, tolMs = 1.5 * HOUR): ResolvedEvent | null {
  if (!events || !asOfMs) return null;
  let best: ResolvedEvent | null = null;
  for (const e of events) {
    if (!e.mask || e.archived || e.status === "real") continue;
    if (!(e.sensor === sensor || e.sensor === "*")) continue;
    if (e.startMs <= asOfMs + tolMs && e.endMs >= asOfMs - tolMs && (!best || e.endMs > best.endMs)) best = e;
  }
  return best;
}

export interface EventSummary {
  total: number;
  masked: number;
  /** 至少有一個感測器被排除的小時數（時段聯集） */
  maskedHours: number;
  byKind: Partial<Record<EventKind, number>>;
  bySensor: Record<string, number>;
  latestEnd: string | null;
}

export function summarize(events: ResolvedEvent[]): EventSummary {
  const byKind: EventSummary["byKind"] = {};
  const bySensor: Record<string, number> = {};
  let masked = 0;
  let latest = 0;
  const spans: Array<[number, number]> = [];
  for (const e of events) {
    byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
    bySensor[e.sensor] = (bySensor[e.sensor] ?? 0) + 1;
    latest = Math.max(latest, e.endMs);
    if (e.mask) {
      masked += 1;
      spans.push([e.startMs, e.endMs + HOUR]);
    }
  }
  spans.sort((a, b) => a[0] - b[0]);
  let maskedMs = 0;
  let curA = 0;
  let curB = 0;
  for (const [a, b] of spans) {
    if (a > curB) {
      maskedMs += curB - curA;
      curA = a;
      curB = b;
    } else curB = Math.max(curB, b);
  }
  maskedMs += curB - curA;
  return { total: events.length, masked, maskedHours: Math.round(maskedMs / HOUR), byKind, bySensor, latestEnd: latest ? fmtMs(latest) : null };
}

export interface SensorCompleteness {
  sensor: string;
  rows: number;
  valid: number;
  validPct: number;
  /** 被事件排除的有效筆數 */
  excluded: number;
}

export function sensorCompleteness(rows: ParsedCsvRow[], sensors: string[], masked: MaskResult): SensorCompleteness[] {
  // 分母用「資料涵蓋的時間長度（小時）」：整列缺失（斷線）也算不完整
  const spanH = rows.length > 1 ? Math.round((rows[rows.length - 1].tsMs - rows[0].tsMs) / HOUR) + 1 : rows.length;
  const denom = Math.max(rows.length, spanH);
  return sensors.map((s) => {
    let valid = 0;
    for (const r of rows) {
      const v = r.values[s];
      if (typeof v === "number" && Number.isFinite(v)) valid += 1;
    }
    return { sensor: s, rows: denom, valid, validPct: denom ? (100 * valid) / denom : 0, excluded: masked.perSensor[s] ?? 0 };
  });
}
