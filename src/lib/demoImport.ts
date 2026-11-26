import type {
  ModelKey,
  PrecomputedForecastTask,
} from "../../contracts/types";
import { MODEL_ORDER } from "../../contracts/types";
import { currentValueAt, pointValue } from "./candidateRisk";

/**
 * 展示：預先準備好的資料＋模擬新資料匯入。
 *
 * 「預先準備好的資料」＝引擎預先算好的、每個任務最近 168 個預測起點（真實歷史資料上的預測與已到達的真值）。
 * 「模擬匯入」＝把展示游標一格一格往後推，像是新的一小時資料抵達：畫面只能看到游標以前的資料，
 * 並顯示「這一小時新到的真值」與「先前預測」的差，以及此刻重算的下一批預測。
 *
 * 這**不是即時資料**，也不是引擎在重算：所有數字都是預先算好的；版本號是展示用的記憶體計數，不會寫入任何資料庫。
 */

export const DEMO_MIN_HISTORY = 72;

export interface DemoLogEntry {
  seq: number;
  version: string;
  fromOrigin: string;
  toOrigin: string;
  rowsAdded: number;
}

export function startCursor(task: PrecomputedForecastTask): number {
  const n = task.points.length;
  if (n === 0) return 0;
  return Math.min(DEMO_MIN_HISTORY - 1, n - 1);
}

export function maxCursor(task: PrecomputedForecastTask): number {
  return Math.max(0, task.points.length - 1);
}

export function importSteps(
  task: PrecomputedForecastTask,
  cursor: number,
  steps: number,
  seq: number
): { cursor: number; entry: DemoLogEntry | null } {
  const next = Math.min(maxCursor(task), cursor + Math.max(1, steps));
  if (next === cursor) return { cursor, entry: null };
  return {
    cursor: next,
    entry: {
      seq,
      version: `demo-v${String(seq).padStart(4, "0")}`,
      fromOrigin: task.points[cursor][0],
      toOrigin: task.points[next][0],
      rowsAdded: next - cursor,
    },
  };
}

export interface DemoChartRow {
  time: string;
  observed?: number;
  /** 以目標時間對齊的預測（已到達真值者用來和觀測線比較） */
  forecast?: number;
  /** 此刻（游標）重算的下一批預測 */
  latestForecast?: number;
}

/** 游標以前可見的資料：觀測（y[t]）、以目標時間對齊的預測、游標當下的最新預測 */
export function chartRows(
  task: PrecomputedForecastTask,
  cursor: number,
  model: ModelKey
): DemoChartRow[] {
  const map = new Map<string, DemoChartRow>();
  const row = (t: string): DemoChartRow => {
    let r = map.get(t);
    if (!r) {
      r = { time: t };
      map.set(t, r);
    }
    return r;
  };
  for (let i = 0; i <= cursor && i < task.points.length; i++) {
    const p = task.points[i];
    const cur = currentValueAt(task, i);
    if (cur !== null) row(p[0]).observed = cur;
    const fc = pointValue(task, i, model);
    if (fc !== null) {
      if (i === cursor) row(p[1]).latestForecast = fc;
      else row(p[1]).forecast = fc;
    }
  }
  return [...map.values()].sort((a, b) => (a.time < b.time ? -1 : 1));
}

export interface RevealedTruth {
  forecastOrigin: string;
  target: string;
  actual: number;
  forecasts: Partial<Record<ModelKey, number | null>>;
}

/**
 * 因果性：只有「目標時間 ≤ 游標起點時間」的預測，真值才算已經抵達。
 * 回傳最近 n 筆已抵達的真值與當時各方法的預測。
 */
export function revealedTruths(
  task: PrecomputedForecastTask,
  cursor: number,
  n: number
): RevealedTruth[] {
  const now = task.points[cursor]?.[0];
  if (!now) return [];
  const out: RevealedTruth[] = [];
  for (let j = Math.min(cursor, task.points.length - 1); j >= 0 && out.length < n; j--) {
    const p = task.points[j];
    const actual = p[2];
    if (actual === null || actual === undefined) continue;
    if (p[1] > now) continue;
    const fcs: Partial<Record<ModelKey, number | null>> = {};
    for (const m of MODEL_ORDER) fcs[m] = pointValue(task, j, m);
    out.push({ forecastOrigin: p[0], target: p[1], actual, forecasts: fcs });
  }
  return out;
}

/** 到游標為止（只算真值已抵達者）各方法的平均絕對誤差 */
export function runningMae(
  task: PrecomputedForecastTask,
  cursor: number
): { n: number; mae: Record<ModelKey, number | null> } {
  const now = task.points[cursor]?.[0];
  const sums: Record<string, number> = {};
  const cnt: Record<string, number> = {};
  let n = 0;
  if (now) {
    for (let j = 0; j <= cursor && j < task.points.length; j++) {
      const p = task.points[j];
      const actual = p[2];
      if (actual === null || actual === undefined || p[1] > now) continue;
      let any = false;
      for (const m of MODEL_ORDER) {
        const v = pointValue(task, j, m);
        if (v === null) continue;
        sums[m] = (sums[m] ?? 0) + Math.abs(v - actual);
        cnt[m] = (cnt[m] ?? 0) + 1;
        any = true;
      }
      if (any) n++;
    }
  }
  const mae = {} as Record<ModelKey, number | null>;
  for (const m of MODEL_ORDER) mae[m] = cnt[m] ? sums[m] / cnt[m] : null;
  return { n, mae };
}
