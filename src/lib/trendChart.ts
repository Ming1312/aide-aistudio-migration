import type { ParsedCsvRow } from "../types/app";
import { downsampleSeries, resampleDailyMean } from "./csv";

export interface SensorUnitGroup {
  unit: string;
  sensors: string[];
}

export interface TrueTimeGapBand {
  startMs: number;
  endMs: number;
  startLabel: string;
  endLabel: string;
  missingSteps: number;
}

export interface TrueTimePoint {
  tsMs: number;
  timestamp: string;
  isGapBreak?: boolean;
  [sensorOrMeta: string]: number | string | boolean | null | undefined;
}

export interface TrueTimeTrendResult {
  points: TrueTimePoint[];
  gaps: TrueTimeGapBand[];
  domain: [number, number] | null;
}

export function groupSensorsByUnit(
  sensors: string[],
  unitBySensor: Record<string, string>
): SensorUnitGroup[] {
  const groups = new Map<string, string[]>();
  for (const sensor of sensors) {
    const rawUnit = unitBySensor[sensor]?.trim();
    const unit = rawUnit && rawUnit.length > 0 ? rawUnit : "未標示單位";
    const list = groups.get(unit);
    if (list) {
      list.push(sensor);
    } else {
      groups.set(unit, [sensor]);
    }
  }
  return Array.from(groups.entries()).map(([unit, groupedSensors]) => ({
    unit,
    sensors: groupedSensors,
  }));
}

export function parseLocalTimestampMs(ts: string): number {
  const trimmed = ts.trim();
  if (!trimmed) return 0;
  const isoLocal = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
    ? `${trimmed}T00:00:00`
    : trimmed.replace(" ", "T");
  const ms = Date.parse(isoLocal);
  return Number.isNaN(ms) ? 0 : ms;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function formatChartTimeLabel(
  tsMs: number,
  resolution: "hourly" | "daily",
  withYear = false
): string {
  if (!Number.isFinite(tsMs) || tsMs <= 0) return "";
  const d = new Date(tsMs);
  const yyyy = d.getFullYear();
  const mm = pad2(d.getMonth() + 1);
  const dd = pad2(d.getDate());
  if (resolution === "daily") {
    return withYear ? `${yyyy}-${mm}-${dd}` : `${mm}-${dd}`;
  }
  const hh = pad2(d.getHours());
  const mi = pad2(d.getMinutes());
  return withYear ? `${yyyy}-${mm}-${dd} ${hh}:${mi}` : `${mm}-${dd} ${hh}:${mi}`;
}

export function buildTrueTimeTrendSeries(
  rows: ParsedCsvRow[],
  sensors: string[],
  resolution: "hourly" | "daily",
  maxPoints = 360
): TrueTimeTrendResult {
  if (rows.length === 0 || sensors.length === 0) {
    return { points: [], gaps: [], domain: null };
  }

  const basePoints: Array<{
    tsMs: number;
    timestamp: string;
    values: Record<string, number | null>;
  }> = [];

  if (resolution === "daily") {
    const daily = resampleDailyMean(rows, sensors);
    for (const d of daily) {
      const tsMs = parseLocalTimestampMs(d.timestamp);
      if (tsMs > 0) {
        basePoints.push({
          tsMs,
          timestamp: d.timestamp,
          values: d.values,
        });
      }
    }
  } else {
    for (const r of rows) {
      const tsMs = r.tsMs > 0 ? r.tsMs : parseLocalTimestampMs(r.timestamp);
      if (tsMs > 0) {
        basePoints.push({
          tsMs,
          timestamp: r.timestamp,
          values: r.values,
        });
      }
    }
  }

  if (basePoints.length === 0) {
    return { points: [], gaps: [], domain: null };
  }

  basePoints.sort((a, b) => a.tsMs - b.tsMs);

  const stepMs = resolution === "daily" ? 86_400_000 : 3_600_000;
  const gapThresholdMs = stepMs * 1.5;

  // Split into contiguous segments whenever time jumps beyond gapThresholdMs
  const segments: Array<typeof basePoints> = [[basePoints[0]]];
  const gaps: TrueTimeGapBand[] = [];

  for (let i = 1; i < basePoints.length; i += 1) {
    const prev = basePoints[i - 1];
    const curr = basePoints[i];
    const deltaMs = curr.tsMs - prev.tsMs;
    if (deltaMs > gapThresholdMs) {
      const missingSteps = Math.max(1, Math.round(deltaMs / stepMs) - 1);
      gaps.push({
        startMs: prev.tsMs,
        endMs: curr.tsMs,
        startLabel: prev.timestamp,
        endLabel: curr.timestamp,
        missingSteps,
      });
      segments.push([curr]);
    } else {
      segments[segments.length - 1].push(curr);
    }
  }

  // Downsample proportionally per segment so gap edges are NEVER lost
  const totalCount = basePoints.length;
  const sampledSegments = segments.map((seg) => {
    if (totalCount <= maxPoints) return seg;
    const target = Math.max(
      Math.min(seg.length, 2),
      Math.round((seg.length / totalCount) * maxPoints)
    );
    return downsampleSeries(seg, target);
  });

  const points: TrueTimePoint[] = [];
  const makeNullValues = (): Record<string, null> => {
    const out: Record<string, null> = {};
    for (const s of sensors) out[s] = null;
    return out;
  };

  for (let sIdx = 0; sIdx < sampledSegments.length; sIdx += 1) {
    const seg = sampledSegments[sIdx];
    for (const pt of seg) {
      const entry: TrueTimePoint = {
        tsMs: pt.tsMs,
        timestamp: pt.timestamp,
      };
      for (const s of sensors) {
        entry[s] = pt.values[s] ?? null;
      }
      points.push(entry);
    }

    if (sIdx < sampledSegments.length - 1) {
      const lastPt = seg[seg.length - 1];
      const nextPt = sampledSegments[sIdx + 1][0];
      const breakStart = lastPt.tsMs + stepMs;
      const breakEnd = nextPt.tsMs - stepMs;
      points.push({
        tsMs: breakStart,
        timestamp: formatChartTimeLabel(breakStart, resolution, true),
        isGapBreak: true,
        ...makeNullValues(),
      });
      if (breakEnd > breakStart) {
        points.push({
          tsMs: breakEnd,
          timestamp: formatChartTimeLabel(breakEnd, resolution, true),
          isGapBreak: true,
          ...makeNullValues(),
        });
      }
    }
  }

  const domain: [number, number] = [
    basePoints[0].tsMs,
    basePoints[basePoints.length - 1].tsMs,
  ];

  return { points, gaps, domain };
}
