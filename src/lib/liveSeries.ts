// 匯入資料：解析、合併、轉成小時序列，並在瀏覽器內建立「簡易基準預測任務」
// （持續性＋3 小時滑動平均＋24 小時季節 Naive）。任務格式與預計算任務相同，
// 所以風險／區間／機率引擎（replayEngine）可原封不動使用。全部只用起點當下已抵達的資料（因果）。
import type { ModelKey, PrecomputedForecastTask, RealColumn } from "../../contracts/types";
import type { ParsedCsvRow } from "../types/app";
import { parseLocalTimestampMs } from "./trendChart";

const HOUR = 3_600_000;

export function fmtHour(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:00:00`;
}

// ---------- 解析 ----------

export interface ParsedImport {
  rows: ParsedCsvRow[];
  /** 對應到場域欄位的欄名（匯入檔欄名 → 場域欄位 key） */
  matched: Record<string, string>;
  unmatched: string[];
  timestampColumn: string | null;
  issues: string[];
  rawRowCount: number;
  /** 與場域「原始表頭」完全相同的欄數（用來判斷這份資料屬於哪個場域） */
  exactMatches: number;
}

function splitLine(line: string, delim: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (q && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else q = !q;
    } else if (ch === delim && !q) {
      cells.push(cur);
      cur = "";
    } else cur += ch;
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

function detectDelimiter(header: string): string {
  const counts: Array<[string, number]> = [",", "\t", ";"].map((d) => [d, header.split(d).length - 1]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ",";
}

const norm = (s: string) => s.toLowerCase().replace(/[\s_\-:：]+/g, "");

function matchColumn(header: string, columns: RealColumn[]): { key: string; exact: boolean } | null {
  const h = norm(header);
  if (!h) return null;
  for (const c of columns) if (c.raw_header && norm(c.raw_header) === h) return { key: c.key, exact: true };
  for (const c of columns) if (norm(c.key) === h) return { key: c.key, exact: false };
  // 表頭帶場域前綴（"<前綴> - pH"）時，以尾段比對
  const tail = norm(header.split(/\s-\s/).pop() ?? "");
  if (tail && tail !== h) {
    for (const c of columns) if (norm(c.key) === tail) return { key: c.key, exact: false };
  }
  return null;
}

const TS_HEADER = /^(日期|date|timestamp|datetime|time|時間|時間戳記?)$/i;

/** 把 2026/1/1、2026-1-1T8:00、2026.01.01 8:5 這類寫法補零成 2026-01-01 08:05:00（沒有時間就當 00:00:00）。 */
export function normalizeTimestamp(raw: string): string {
  const s = raw.trim();
  const m = s.match(/^(\d{4})[/.\-](\d{1,2})[/.\-](\d{1,2})(?:[T\s]+(\d{1,2})(?::(\d{1,2}))?(?::(\d{1,2}))?)?$/);
  if (!m) return s.replace(/\//g, "-").replace("T", " ");
  const p2 = (v: string | undefined) => String(Number(v ?? "0")).padStart(2, "0");
  return `${m[1]}-${p2(m[2])}-${p2(m[3])} ${p2(m[4])}:${p2(m[5])}:${p2(m[6])}`;
}

export function parseImportedText(text: string, columns: RealColumn[]): ParsedImport {
  const clean = text.replace(/^\uFEFF/, "");
  let lines = clean.split(/\r?\n/).filter((l) => l.trim().length > 0);
  // 表頭前面有說明列（例如圖例、備註）：在前 10 列找第一個含「日期／時間」欄名的列當表頭
  const headAt = lines.slice(0, 10).findIndex((l) => splitLine(l, detectDelimiter(l)).some((c) => TS_HEADER.test(c.trim())));
  if (headAt > 0) lines = lines.slice(headAt);
  const issues: string[] = [];
  if (lines.length < 2) {
    return { rows: [], matched: {}, unmatched: [], timestampColumn: null, issues: ["沒有資料列"], rawRowCount: 0, exactMatches: 0 };
  }
  if (/^\s*<(!doctype|html)/i.test(lines[0])) {
    return {
      rows: [],
      matched: {},
      unmatched: [],
      timestampColumn: null,
      issues: ["讀到的是網頁而不是 CSV：試算表需設為「知道連結的任何人可檢視」或「發布到網路」"],
      rawRowCount: 0,
      exactMatches: 0,
    };
  }
  const delim = detectDelimiter(lines[0]);
  const headers = splitLine(lines[0], delim);
  // 原始企業匯出格式：「日期」＋「小時」兩欄（例如 2026/06/01、8）
  const dateIdx = headers.findIndex((h) => /^(日期|date)$/i.test(h.trim()));
  const hourIdx = headers.findIndex((h) => /^(小時|時|hour|hr)$/i.test(h.trim()));
  const hasSingleTs = headers.some((h) => /^(timestamp|datetime|時間戳記?)$/i.test(h.trim()));
  const splitTs = dateIdx >= 0 && hourIdx >= 0 && !hasSingleTs;
  let tsIdx = splitTs ? dateIdx : headers.findIndex((h) => /^(timestamp|time|datetime|date|日期|時間|時間戳記?)$/i.test(h.trim()));
  if (tsIdx < 0) tsIdx = 0;
  const timestampColumn = splitTs ? `${headers[dateIdx]}＋${headers[hourIdx]}` : (headers[tsIdx] ?? null);
  const matched: Record<string, string> = {};
  const unmatched: string[] = [];
  let exactMatches = 0;
  headers.forEach((h, i) => {
    if (i === tsIdx || (splitTs && i === hourIdx)) return;
    const hit = matchColumn(h, columns);
    if (hit) {
      matched[h] = hit.key;
      if (hit.exact) exactMatches += 1;
    }
    else if (h) unmatched.push(h);
  });
  const rows: ParsedCsvRow[] = [];
  let badTs = 0;
  for (let r = 1; r < lines.length; r++) {
    const cells = splitLine(lines[r], delim);
    let tsRaw = cells[tsIdx] ?? "";
    if (splitTs) {
      const hh = Number((cells[hourIdx] ?? "").match(/\d+/)?.[0]);
      tsRaw = Number.isInteger(hh) && hh >= 0 && hh <= 23 ? `${tsRaw.trim()} ${String(hh).padStart(2, "0")}:00:00` : "";
    }
    // 容忍 "2026/11/27 08:00"、"2026/1/1"、"2026-11-27T08:00:00" 與 "2026-11-27 08:00"
    const tsNorm = normalizeTimestamp(tsRaw);
    const ms = parseLocalTimestampMs(tsNorm);
    if (!ms) {
      badTs++;
      continue;
    }
    const values: Record<string, number | null> = {};
    headers.forEach((h, i) => {
      if (splitTs && i === hourIdx) return;
      const key = matched[h];
      if (!key) return;
      const raw = (cells[i] ?? "").trim();
      const num = raw === "" ? NaN : Number(raw);
      values[key] = Number.isFinite(num) ? num : null;
    });
    rows.push({ timestamp: tsNorm.length === 16 ? `${tsNorm}:00` : tsNorm, tsMs: ms, values, rawCells: cells, flagValue: "import" });
  }
  if (badTs > 0) issues.push(`${badTs} 列的時間無法辨識，已略過`);
  if (!splitTs && timestampColumn && !/time|date|日期|時間/i.test(timestampColumn)) {
    issues.push(`未找到時間欄名稱，以第一欄「${timestampColumn}」當時間`);
  }
  if (Object.keys(matched).length === 0) issues.push("沒有任何欄位對應到此場域的感測器欄名");
  rows.sort((a, b) => a.tsMs - b.tsMs);
  return { rows, matched, unmatched, timestampColumn, issues, rawRowCount: lines.length - 1, exactMatches };
}

/** 匯入列蓋過同一時間的原始列；依時間排序。 */
export function mergeRows(base: ParsedCsvRow[], imported: ParsedCsvRow[]): ParsedCsvRow[] {
  if (imported.length === 0) return base;
  const byTs = new Map<number, ParsedCsvRow>();
  for (const r of base) byTs.set(r.tsMs, r);
  for (const r of imported) {
    const prev = byTs.get(r.tsMs);
    byTs.set(r.tsMs, prev ? { ...prev, values: { ...prev.values, ...r.values }, flagValue: "import" } : r);
  }
  return [...byTs.values()].sort((a, b) => a.tsMs - b.tsMs);
}

/** 以 tsMs 為鍵合併多次匯入（同一時間後者蓋前者）。 */
export function accumulateImported(prev: ParsedCsvRow[], next: ParsedCsvRow[]): ParsedCsvRow[] {
  const m = new Map<number, ParsedCsvRow>();
  for (const r of prev) m.set(r.tsMs, r);
  for (const r of next) {
    const p = m.get(r.tsMs);
    m.set(r.tsMs, p ? { ...p, values: { ...p.values, ...r.values } } : r);
  }
  return [...m.values()].sort((a, b) => a.tsMs - b.tsMs);
}

// ---------- 小時序列 ----------

/** 小時平均（只用有值者）；回傳 小時起點 ms → 值。 */
export function toHourly(rows: ParsedCsvRow[], sensor: string): Map<number, number> {
  const acc = new Map<number, { s: number; n: number }>();
  for (const r of rows) {
    const v = r.values[sensor];
    if (v === null || v === undefined || !Number.isFinite(v)) continue;
    const h = Math.floor(r.tsMs / HOUR) * HOUR;
    const a = acc.get(h) ?? { s: 0, n: 0 };
    a.s += v;
    a.n += 1;
    acc.set(h, a);
  }
  const out = new Map<number, number>();
  for (const [h, a] of acc) out.set(h, a.s / a.n);
  return out;
}

export const LIVE_MIN_HISTORY_H = 72;
export const LIVE_MAX_ORIGINS = 168;

/**
 * 以小時序列建立簡易基準預測任務。起點 t：持續性＝y[t]；滑動平均＝最近 3 小時平均；
 * 季節 Naive＝y[t+h-24]（需 h ≤ 24）。最後一個起點沒有真值（period "l"）。
 * 起點間隔小於一小時的缺值：該起點缺 y[t] 就略過。
 */
export function buildLiveTask(
  datasetId: string,
  sensor: string,
  unit: string,
  horizon: number,
  hourly: Map<number, number>
): PrecomputedForecastTask | null {
  const keys = [...hourly.keys()].sort((a, b) => a - b);
  if (keys.length < LIVE_MIN_HISTORY_H) return null;
  const last = keys[keys.length - 1];
  const origins: number[] = [];
  for (let t = last; origins.length < LIVE_MAX_ORIGINS && t >= keys[0]; t -= HOUR) {
    if (hourly.has(t)) origins.push(t);
  }
  origins.reverse();
  if (origins.length < LIVE_MIN_HISTORY_H) return null;
  const points: PrecomputedForecastTask["points"] = [];
  for (const t of origins) {
    const y = hourly.get(t)!;
    const target = t + horizon * HOUR;
    const actual = hourly.get(target);
    const prev: number[] = [];
    for (let k = 0; k < 3; k++) {
      const v = hourly.get(t - k * HOUR);
      if (v !== undefined) prev.push(v);
    }
    const ma = prev.length > 0 ? prev.reduce((a, b) => a + b, 0) / prev.length : null;
    const sn = hourly.get(target - 24 * HOUR);
    const isLatest = t === last;
    points.push([
      fmtHour(t),
      fmtHour(target),
      isLatest || actual === undefined ? null : actual,
      isLatest ? "l" : "h",
      y,
      ma,
      sn ?? null,
      null,
      null,
      null,
    ]);
  }
  return {
    dataset_id: datasetId,
    sensor,
    horizon_h: horizon,
    unit,
    unit_status: "inferred",
    columns: ["origin", "target", "actual", "period", "persistence", "moving_average", "seasonal_naive_24h", "linear_ar4", "HGB", "XGB"],
    points,
    best_baseline: "persistence" as ModelKey,
    variants: {},
    metrics: {},
    evidence: {} as PrecomputedForecastTask["evidence"],
    interval: {} as PrecomputedForecastTask["interval"],
    refused_at_latest: {},
    artifact_sha256: "browser-live",
    model_names: {} as PrecomputedForecastTask["model_names"],
    origin_range: [points[0][0], points[points.length - 1][0]],
  };
}
