import type { ParsedCsvDataset, ParsedCsvRow } from "../types/app";

function parseTimestampMs(ts: string): number {
  const normalized = ts.trim().replace(" ", "T");
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? 0 : ms;
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      cells.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells;
}

export function parseCsvText(
  text: string,
  expectedFlag: "__real" | "__synthetic"
): ParsedCsvDataset {
  const clean = text.replace(/^\uFEFF/, "");
  const lines = clean.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    return {
      headers: [],
      sensorHeaders: [],
      flagColumn: expectedFlag,
      rows: [],
    };
  }
  const headers = splitCsvLine(lines[0]).map((h) => h.trim());
  const flagIdx = headers.indexOf(expectedFlag);
  const tsIdx = headers.indexOf("timestamp");
  const sensorHeaders = headers.filter(
    (h) => h !== "timestamp" && h !== "__real" && h !== "__synthetic"
  );

  const rows: ParsedCsvRow[] = [];
  for (let r = 1; r < lines.length; r += 1) {
    const rawCells = splitCsvLine(lines[r]);
    if (rawCells.length < 2) continue;
    const timestamp = (tsIdx >= 0 ? rawCells[tsIdx] : rawCells[0] ?? "").trim();
    const values: Record<string, number | null> = {};
    for (let c = 0; c < headers.length; c += 1) {
      const h = headers[c];
      if (h === "timestamp" || h === "__real" || h === "__synthetic") continue;
      const raw = (rawCells[c] ?? "").trim();
      if (raw === "") {
        values[h] = null;
      } else {
        const num = Number(raw);
        values[h] = Number.isFinite(num) ? num : null;
      }
    }
    const flagValue =
      flagIdx >= 0 ? (rawCells[flagIdx] ?? "1").trim() : "1";
    rows.push({
      timestamp,
      tsMs: parseTimestampMs(timestamp),
      values,
      rawCells,
      flagValue,
    });
  }

  return {
    headers,
    sensorHeaders,
    flagColumn: expectedFlag,
    rows,
  };
}

function escapeCsvCell(cell: string): string {
  if (/[",\n\r]/.test(cell)) {
    return `"${cell.replace(/"/g, '""')}"`;
  }
  return cell;
}

/**
 * 依原始 CSV 列輸出（保留 __real 或 __synthetic 欄、不改動數值）。
 * 若傳入 selectedColumns，只保留 timestamp + 選取欄 + flagColumn，確保下載與真實資料/合成資料分開。
 */
export function buildCsvDownloadText(
  dataset: ParsedCsvDataset,
  rows: ParsedCsvRow[],
  selectedColumns?: string[]
): string {
  if (!selectedColumns || selectedColumns.length === 0) {
    const headerLine = dataset.headers.map(escapeCsvCell).join(",");
    const bodyLines = rows.map((row) =>
      row.rawCells.map((c) => escapeCsvCell(c)).join(",")
    );
    return "\uFEFF" + [headerLine, ...bodyLines].join("\n");
  }

  const keepHeaders = [
    "timestamp",
    ...selectedColumns.filter((c) => dataset.headers.includes(c)),
    dataset.flagColumn,
  ];
  const indices = keepHeaders.map((h) => dataset.headers.indexOf(h));
  const headerLine = keepHeaders.map(escapeCsvCell).join(",");
  const bodyLines = rows.map((row) =>
    indices
      .map((idx) => escapeCsvCell(idx >= 0 ? row.rawCells[idx] ?? "" : ""))
      .join(",")
  );
  return "\uFEFF" + [headerLine, ...bodyLines].join("\n");
}

export function triggerCsvDownload(filename: string, csvText: string): void {
  const blob = new Blob([csvText], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export interface ColumnStats {
  sensor: string;
  totalRows: number;
  observed: number;
  missing: number;
  missingRatePct: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  std: number | null;
  median: number | null;
  q25: number | null;
  q75: number | null;
  zeroCount: number;
  longestFlatlineHours: number;
  longestZeroHours: number;
}

function quantile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export function computeColumnStats(
  rows: ParsedCsvRow[],
  sensor: string
): ColumnStats {
  const vals: number[] = [];
  let missing = 0;
  let zeroCount = 0;
  let longestFlatline = 0;
  let currentFlat = 0;
  let prevVal: number | null = null;
  let longestZero = 0;
  let currentZero = 0;

  for (const row of rows) {
    const v = row.values[sensor];
    if (v === null || v === undefined || !Number.isFinite(v)) {
      missing += 1;
      currentFlat = 0;
      currentZero = 0;
      prevVal = null;
      continue;
    }
    vals.push(v);
    if (v === 0) {
      zeroCount += 1;
      currentZero += 1;
      if (currentZero > longestZero) longestZero = currentZero;
    } else {
      currentZero = 0;
    }

    if (prevVal !== null && v === prevVal) {
      currentFlat += 1;
    } else {
      currentFlat = 1;
    }
    if (currentFlat > longestFlatline) longestFlatline = currentFlat;
    prevVal = v;
  }

  const observed = vals.length;
  const totalRows = rows.length;
  if (observed === 0) {
    return {
      sensor,
      totalRows,
      observed: 0,
      missing,
      missingRatePct: totalRows > 0 ? 100 : 0,
      min: null,
      max: null,
      mean: null,
      std: null,
      median: null,
      q25: null,
      q75: null,
      zeroCount: 0,
      longestFlatlineHours: 0,
      longestZeroHours: 0,
    };
  }

  let sum = 0;
  let min = vals[0];
  let max = vals[0];
  for (const v of vals) {
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const mean = sum / observed;
  let varSum = 0;
  for (const v of vals) {
    varSum += (v - mean) ** 2;
  }
  const std = observed > 1 ? Math.sqrt(varSum / (observed - 1)) : 0;
  const sorted = [...vals].sort((a, b) => a - b);

  return {
    sensor,
    totalRows,
    observed,
    missing,
    missingRatePct: totalRows > 0 ? (missing / totalRows) * 100 : 0,
    min,
    max,
    mean,
    std,
    median: quantile(sorted, 0.5),
    q25: quantile(sorted, 0.25),
    q75: quantile(sorted, 0.75),
    zeroCount,
    longestFlatlineHours: longestFlatline,
    longestZeroHours: longestZero,
  };
}

export interface TimeGapSegment {
  start: string;
  end: string;
  missingHours: number;
}

export function detectTimeGaps(rows: ParsedCsvRow[]): {
  nGaps: number;
  longestGapHours: number;
  totalMissingHours: number;
  segments: TimeGapSegment[];
  duplicateTimestamps: number;
} {
  const segments: TimeGapSegment[] = [];
  let duplicateTimestamps = 0;
  let longestGapHours = 0;
  let totalMissingHours = 0;
  const seen = new Set<string>();

  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    if (seen.has(r.timestamp)) {
      duplicateTimestamps += 1;
    } else {
      seen.add(r.timestamp);
    }
    if (i > 0) {
      const prev = rows[i - 1];
      if (prev.tsMs > 0 && r.tsMs > prev.tsMs) {
        const diffH = Math.round((r.tsMs - prev.tsMs) / 3_600_000);
        if (diffH > 1) {
          const miss = diffH - 1;
          totalMissingHours += miss;
          if (miss > longestGapHours) longestGapHours = miss;
          segments.push({
            start: prev.timestamp,
            end: r.timestamp,
            missingHours: miss,
          });
        }
      }
    }
  }

  return {
    nGaps: segments.length,
    longestGapHours,
    totalMissingHours,
    segments,
    duplicateTimestamps,
  };
}

export function resampleDailyMean(
  rows: ParsedCsvRow[],
  sensors: string[]
): Array<{ timestamp: string; values: Record<string, number | null> }> {
  const groups = new Map<
    string,
    { sums: Record<string, number>; counts: Record<string, number> }
  >();
  for (const row of rows) {
    const day = row.timestamp.slice(0, 10);
    if (!day) continue;
    let g = groups.get(day);
    if (!g) {
      g = { sums: {}, counts: {} };
      groups.set(day, g);
    }
    for (const s of sensors) {
      const v = row.values[s];
      if (v !== null && v !== undefined && Number.isFinite(v)) {
        g.sums[s] = (g.sums[s] ?? 0) + v;
        g.counts[s] = (g.counts[s] ?? 0) + 1;
      }
    }
  }
  const out: Array<{ timestamp: string; values: Record<string, number | null> }> = [];
  for (const [day, g] of groups.entries()) {
    const values: Record<string, number | null> = {};
    for (const s of sensors) {
      const cnt = g.counts[s] ?? 0;
      values[s] = cnt > 0 ? Number((g.sums[s] / cnt).toFixed(4)) : null;
    }
    out.push({ timestamp: day, values });
  }
  return out;
}

/**
 * 僅供圖表渲染降採樣（保留首尾與均勻取樣）；下載與統計永遠使用完整原始資料。
 */
export function downsampleSeries<T>(items: T[], maxPoints = 360): T[] {
  if (items.length <= maxPoints) return items;
  const step = (items.length - 1) / (maxPoints - 1);
  const out: T[] = [];
  for (let i = 0; i < maxPoints; i += 1) {
    out.push(items[Math.round(i * step)]);
  }
  return out;
}

export function computeHistogram(
  rows: ParsedCsvRow[],
  sensor: string,
  binsCount = 12
): Array<{ bin: string; count: number; from: number; to: number }> {
  const vals: number[] = [];
  for (const r of rows) {
    const v = r.values[sensor];
    if (v !== null && v !== undefined && Number.isFinite(v)) vals.push(v);
  }
  if (vals.length === 0) return [];
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  if (min === max) {
    return [{ bin: `${min.toFixed(2)}`, count: vals.length, from: min, to: max }];
  }
  const width = (max - min) / binsCount;
  const counts = new Array<number>(binsCount).fill(0);
  for (const v of vals) {
    let idx = Math.floor((v - min) / width);
    if (idx >= binsCount) idx = binsCount - 1;
    if (idx < 0) idx = 0;
    counts[idx] += 1;
  }
  return counts.map((count, i) => {
    const from = min + i * width;
    const to = min + (i + 1) * width;
    const decimals = Math.abs(width) < 0.1 ? 3 : Math.abs(width) < 1 ? 2 : 1;
    return {
      bin: `${from.toFixed(decimals)}–${to.toFixed(decimals)}`,
      count,
      from,
      to,
    };
  });
}

export function computeDiurnalProfile(
  rows: ParsedCsvRow[],
  sensors: string[]
): Array<Record<string, number | string | null>> {
  const sums: Array<Record<string, number>> = Array.from({ length: 24 }, () => ({}));
  const cnts: Array<Record<string, number>> = Array.from({ length: 24 }, () => ({}));
  for (const row of rows) {
    const hhStr = row.timestamp.slice(11, 13);
    const hh = Number.parseInt(hhStr, 10);
    if (Number.isNaN(hh) || hh < 0 || hh > 23) continue;
    for (const s of sensors) {
      const v = row.values[s];
      if (v !== null && v !== undefined && Number.isFinite(v)) {
        sums[hh][s] = (sums[hh][s] ?? 0) + v;
        cnts[hh][s] = (cnts[hh][s] ?? 0) + 1;
      }
    }
  }
  return Array.from({ length: 24 }, (_, hh) => {
    const entry: Record<string, number | string | null> = {
      hour: `${String(hh).padStart(2, "0")}:00`,
    };
    for (const s of sensors) {
      const c = cnts[hh][s] ?? 0;
      entry[s] = c > 0 ? Number((sums[hh][s] / c).toFixed(4)) : null;
    }
    return entry;
  });
}

export function computePearsonMatrix(
  rows: ParsedCsvRow[],
  sensors: string[]
): { sensors: string[]; matrix: Array<Array<number | null>> } {
  const n = sensors.length;
  const matrix: Array<Array<number | null>> = Array.from({ length: n }, () =>
    new Array<number | null>(n).fill(null)
  );
  for (let i = 0; i < n; i += 1) {
    matrix[i][i] = 1;
    for (let j = i + 1; j < n; j += 1) {
      const xs: number[] = [];
      const ys: number[] = [];
      for (const r of rows) {
        const vx = r.values[sensors[i]];
        const vy = r.values[sensors[j]];
        if (
          vx !== null &&
          vx !== undefined &&
          vy !== null &&
          vy !== undefined &&
          Number.isFinite(vx) &&
          Number.isFinite(vy)
        ) {
          xs.push(vx);
          ys.push(vy);
        }
      }
      if (xs.length < 3) {
        matrix[i][j] = null;
        matrix[j][i] = null;
        continue;
      }
      const meanX = xs.reduce((a, b) => a + b, 0) / xs.length;
      const meanY = ys.reduce((a, b) => a + b, 0) / ys.length;
      let num = 0;
      let dx2 = 0;
      let dy2 = 0;
      for (let k = 0; k < xs.length; k += 1) {
        const dx = xs[k] - meanX;
        const dy = ys[k] - meanY;
        num += dx * dy;
        dx2 += dx * dx;
        dy2 += dy * dy;
      }
      const denom = Math.sqrt(dx2 * dy2);
      const corr = denom > 0 ? Number((num / denom).toFixed(3)) : null;
      matrix[i][j] = corr;
      matrix[j][i] = corr;
    }
  }
  return { sensors, matrix };
}
