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
  range: { from: string; to: string } = { from: "", to: "" }
): ThresholdRange | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length < MIN_VALUES || !validPct(pct)) return null;
  const [pc, pa] = tailProbs(direction, pct);
  return { caution: round1(quantile(v, pc)), alarm: round1(quantile(v, pa)), source: "history", note: noteFor(pct, v.length, range.from, range.to) };
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

// ---- 預先算好的表（public/data/real_public/precomputed/thresholds.json）

export interface ThresholdTableEntry {
  sensor: string;
  direction: RiskDirection;
  n: number;
  excluded: number;
  from: string;
  to: string;
  /** 分位數格點：機率（字串）→ 數值 */
  grid: Record<string, number>;
}
export interface ThresholdTable {
  generated_at: string;
  grid: number[];
  note: string;
  datasets: Record<string, ThresholdTableEntry>;
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

export function fromEntry(entry: ThresholdTableEntry, pct: Pct = DEFAULT_PCT): ThresholdRange | null {
  if (entry.n < MIN_VALUES || !validPct(pct)) return null;
  const [pc, pa] = tailProbs(entry.direction, pct);
  return {
    caution: round1(quantileFromGrid(entry, pc)),
    alarm: round1(quantileFromGrid(entry, pa)),
    source: "history",
    note: noteFor(pct, entry.n, entry.from, entry.to),
  };
}

export type ThresholdMap = Record<string, ThresholdRange>;

/** 優先順序：管理員調整 ＞ 歷史計算（匯入後以合併資料精確重算，否則用預先算好的表）＞（沒有 → 呼叫端退回假定值） */
export function resolveThresholds(args: {
  datasetIds: string[];
  table: ThresholdTable | null;
  pct: Pct;
  admin: Record<string, { caution: number; alarm: number }>;
  /** 匯入後可用精確重算的資料：datasetId → 有效數值 */
  exact?: Record<string, { values: number[]; from: string; to: string; direction: RiskDirection }>;
}): { effective: ThresholdMap; history: ThresholdMap } {
  const history: ThresholdMap = {};
  const effective: ThresholdMap = {};
  for (const id of args.datasetIds) {
    const ex = args.exact?.[id];
    let h: ThresholdRange | null = ex ? computeFromValues(ex.values, ex.direction, args.pct, { from: ex.from, to: ex.to }) : null;
    if (!h && args.table?.datasets[id]) h = fromEntry(args.table.datasets[id], args.pct);
    if (h) history[id] = h;
    const a = args.admin[id];
    if (a) effective[id] = { caution: a.caution, alarm: a.alarm, source: "admin", note: "管理員調整" };
    else if (h) effective[id] = h;
  }
  return { effective, history };
}
