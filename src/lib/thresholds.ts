// 風險門檻：由歷史資料的百分位數算出（預設注意＝P90、警戒＝P97.5；越低越危險的感測器取對稱的下尾），
// 管理員可以改百分位或直接改數字。優先順序：管理員調整 ＞ 歷史計算 ＞ 程式內的假定值。
// 百分位門檻只是「統計上多罕見」，不是安全標準；整段歷史都拿來算，所以對歷史資料本身是樣本內結果。
import type { AnomalyEvent } from "../../contracts/types";
import type { RiskDirection } from "./candidateRisk";
import type { ParsedCsvRow } from "../types/app";

export interface Pct {
  caution: number;
  alarm: number;
}
export const DEFAULT_PCT: Pct = { caution: 0.9, alarm: 0.975 };
/** 預先算好的分位數格點（越低越危險的感測器取 1 − p，所以格點對稱） */
export const GRID = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 0.975, 0.99] as const;
export const MIN_VALUES = 48;
export const PCT_MIN = 0.5;
export const PCT_MAX = 0.99;

export interface ThresholdRange {
  caution: number;
  alarm: number;
  direction: RiskDirection;
  /** 注意線＝警戒線（讀值幾乎不變，例如多半是 0）：這組門檻沒有意義，非代表感測器不納入監看 */
  degenerate?: boolean;
  source: "history" | "admin";
  /** 說明（來源、百分位、樣本數）；顯示用 */
  note: string;
}

export function quantile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const k = (sorted.length - 1) * Math.min(1, Math.max(0, p));
  const f = Math.floor(k);
  const c = Math.min(f + 1, sorted.length - 1);
  return sorted[f] + (sorted[c] - sorted[f]) * (k - f);
}

const round1 = (v: number) => Math.round(v * 10) / 10;

export function validPct(p: Pct): boolean {
  return p.caution >= PCT_MIN && p.alarm >= p.caution && p.alarm <= PCT_MAX && Number.isFinite(p.caution + p.alarm);
}

/** 方向 above：注意＝P(caution)、警戒＝P(alarm)；方向 below：取 1−p 的下尾 */
function tailProbs(direction: RiskDirection, pct: Pct): [number, number] {
  return direction === "above" ? [pct.caution, pct.alarm] : [1 - pct.caution, 1 - pct.alarm];
}

export function noteFor(pct: Pct, n: number, from: string, to: string): string {
  const f = (p: number) => `P${Math.round(p * 1000) / 10}`;
  return `歷史${f(pct.caution)}／${f(pct.alarm)}・${n} 筆・${from.slice(0, 10)}～${to.slice(0, 10)}`;
}

/** 用一串有效數值直接算（不足 MIN_VALUES 筆回 null） */
export function computeFromValues(
  values: number[],
  direction: RiskDirection,
  pct: Pct = DEFAULT_PCT,
  range: { from: string; to: string } = { from: "", to: "" },
  noteSuffix = ""
): ThresholdRange | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length < MIN_VALUES || !validPct(pct)) return null;
  const [pc, pa] = tailProbs(direction, pct);
  const caution = round1(quantile(v, pc));
  const alarm = round1(quantile(v, pa));
  return { caution, alarm, direction, degenerate: caution === alarm, source: "history", note: noteFor(pct, v.length, range.from, range.to) + noteSuffix };
}

/** 從「感測器的有效數值（略過斷電／歸零時段）」取值：離線產生表與匯入後重算共用 */
export function validValues(rows: ParsedCsvRow[], sensor: string, events: AnomalyEvent[]): { values: number[]; from: string; to: string; excluded: number } {
  const spans = events
    .filter((e) => e.kind === "outage_zero_rows")
    .map((e) => [Date.parse(e.start.replace(" ", "T")), Date.parse(e.end.replace(" ", "T"))] as const);
  const values: number[] = [];
  let excluded = 0;
  let from = "";
  let to = "";
  for (const r of rows) {
    const x = r.values[sensor];
    if (typeof x !== "number" || !Number.isFinite(x)) continue;
    if (spans.some(([a, b]) => r.tsMs >= a && r.tsMs <= b)) {
      excluded += 1;
      continue;
    }
    values.push(x);
    if (!from || r.timestamp < from) from = r.timestamp;
    if (!to || r.timestamp > to) to = r.timestamp;
  }
  return { values, from, to, excluded };
}

const fmtMs = (ms: number) => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/**
 * 原始（＋匯入）資料再併入引擎的即時觀測值：同一個時間點以引擎的為準，新時間點加進來。
 * 回傳的 added＝引擎新增的點數（用來在說明裡標示「含引擎資料 N 筆」）。
 */
export function validValuesWith(
  rows: ParsedCsvRow[],
  sensor: string,
  events: AnomalyEvent[],
  extra: Array<{ t: number; v: number }>
): { values: number[]; from: string; to: string; excluded: number; added: number } {
  const spans = events
    .filter((e) => e.kind === "outage_zero_rows")
    .map((e) => [Date.parse(e.start.replace(" ", "T")), Date.parse(e.end.replace(" ", "T"))] as const);
  const map = new Map<number, number>();
  let excluded = 0;
  for (const r of rows) {
    const x = r.values[sensor];
    if (typeof x !== "number" || !Number.isFinite(x)) continue;
    if (spans.some(([a, b]) => r.tsMs >= a && r.tsMs <= b)) {
      excluded += 1;
      continue;
    }
    map.set(r.tsMs, x);
  }
  let added = 0;
  for (const p of extra) {
    if (!Number.isFinite(p.v)) continue;
    if (!map.has(p.t)) added += 1;
    map.set(p.t, p.v);
  }
  const ts = [...map.keys()];
  return {
    values: [...map.values()],
    from: ts.length ? fmtMs(Math.min(...ts)) : "",
    to: ts.length ? fmtMs(Math.max(...ts)) : "",
    excluded,
    added,
  };
}

// ---- 每個感測器一組門檻

export const sensorKey = (datasetId: string, sensor: string) => `${datasetId}::${sensor}`;

/** 哪些欄位算「可設門檻的感測器」：連續量與衍生指數；排除累計計數器、狀態碼、校正參數、角度 */
export function isThresholdSensor(col: { measurement_kind: string; is_cumulative_counter: boolean; n_observed: number }): boolean {
  return (col.measurement_kind === "continuous" || col.measurement_kind === "derived_index") && !col.is_cumulative_counter && col.n_observed >= MIN_VALUES;
}

/** 預設方向：溶氧、電量、電壓、訊號、飽和度「越低越危險」，其餘「越高越危險」（管理員可改） */
export function defaultDirection(sensor: string, unit: string): RiskDirection {
  if (/電量|電壓|訊號|CSQ|飽和|溶氧/.test(sensor)) return "below";
  if (/^DO/.test(sensor) && !/水溫/.test(sensor) && /mg\/L/.test(unit)) return "below";
  return "above";
}

// ---- 預先算好的表（public/data/real_public/precomputed/thresholds.json）

export interface ThresholdTableEntry {
  sensor: string;
  /** 預設方向（產生表時用；實際用的方向可被管理員改） */
  direction: RiskDirection;
  n: number;
  excluded: number;
  from: string;
  to: string;
  /** 分位數格點：機率（字串）→ 數值（以「值」本身排序，與方向無關） */
  grid: Record<string, number>;
}
export interface ThresholdTable {
  generated_at: string;
  grid: number[];
  note: string;
  datasets: Record<string, { sensors: Record<string, ThresholdTableEntry> }>;
}

export function buildEntry(sensor: string, direction: RiskDirection, v: { values: number[]; from: string; to: string; excluded: number }): ThresholdTableEntry {
  const sorted = [...v.values].sort((a, b) => a - b);
  const grid: Record<string, number> = {};
  for (const p of GRID) grid[String(p)] = Math.round(quantile(sorted, p) * 1e6) / 1e6;
  return { sensor, direction, n: sorted.length, excluded: v.excluded, from: v.from, to: v.to, grid };
}

/** 格點之間線性內插；超出 1%～99% 時取邊界 */
export function quantileFromGrid(entry: ThresholdTableEntry, p: number): number {
  const pts = GRID.map((g) => [g, entry.grid[String(g)]] as const);
  const x = Math.min(GRID[GRID.length - 1], Math.max(GRID[0], p));
  for (let i = 1; i < pts.length; i++) {
    if (x <= pts[i][0]) {
      const [x0, y0] = pts[i - 1];
      const [x1, y1] = pts[i];
      return x1 === x0 ? y1 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return pts[pts.length - 1][1];
}

export function fromEntry(entry: ThresholdTableEntry, pct: Pct = DEFAULT_PCT, direction: RiskDirection = entry.direction): ThresholdRange | null {
  if (entry.n < MIN_VALUES || !validPct(pct)) return null;
  const [pc, pa] = tailProbs(direction, pct);
  const caution = round1(quantileFromGrid(entry, pc));
  const alarm = round1(quantileFromGrid(entry, pa));
  return {
    caution,
    alarm,
    direction,
    degenerate: caution === alarm,
    source: "history",
    note: noteFor(pct, entry.n, entry.from, entry.to),
  };
}

/** key＝`${datasetId}::${sensor}` */
export type ThresholdMap = Record<string, ThresholdRange>;

/**
 * 優先順序：管理員調整 ＞ 歷史計算（匯入後以合併資料精確重算，否則用預先算好的表）＞（沒有 → 呼叫端退回假定值）。
 * dirs：管理員改過方向的感測器（key → 方向）；歷史門檻依「實際方向」計算。
 */
export function resolveThresholds(args: {
  table: ThresholdTable | null;
  pct: Pct;
  admin: Record<string, { caution: number; alarm: number }>;
  dirs?: Record<string, RiskDirection>;
  /** 匯入後可用精確重算的資料：key → 有效數值 */
  exact?: Record<string, { values: number[]; from: string; to: string; direction: RiskDirection; noteSuffix?: string }>;
}): { effective: ThresholdMap; history: ThresholdMap } {
  const history: ThresholdMap = {};
  const effective: ThresholdMap = {};
  const keys = new Set<string>();
  if (args.table) for (const [id, d] of Object.entries(args.table.datasets)) for (const sensor of Object.keys(d.sensors)) keys.add(sensorKey(id, sensor));
  for (const k of Object.keys(args.admin)) keys.add(k);
  for (const k of keys) {
    const [id, sensor] = k.split("::");
    const entry = args.table?.datasets[id]?.sensors[sensor];
    const dir = args.dirs?.[k] ?? entry?.direction ?? args.exact?.[k]?.direction ?? "above";
    const ex = args.exact?.[k];
    let h: ThresholdRange | null = ex ? computeFromValues(ex.values, dir, args.pct, { from: ex.from, to: ex.to }, ex.noteSuffix) : null;
    if (!h && entry) h = fromEntry(entry, args.pct, dir);
    if (h) history[k] = h;
    const a = args.admin[k];
    if (a) effective[k] = { caution: a.caution, alarm: a.alarm, direction: dir, source: "admin", note: "管理員調整" };
    else if (h) effective[k] = h;
  }
  return { effective, history };
}
