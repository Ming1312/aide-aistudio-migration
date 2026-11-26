// 各場域「現在與未來 1／3 小時」的安全狀態。
// 用既有的候選風險政策（假定門檻）＋因果回放引擎；資料來源是預計算預測，或（有匯入資料時）瀏覽器內建立的簡易基準預測。
import type {
  AnomaliesResponse,
  LiveForecastResponse,
  LiveForecastTask,
  LiveStatusResponse,
  ModelKey,
  PrecomputedForecastTask,
  PrecomputedForecasts,
  RealDataset,
} from "../../contracts/types";
import type { ParsedCsvRow } from "../types/app";
import {
  CANDIDATE_POLICIES,
  NO_RISK_REASONS,
  applyOverride,
  classify,
  findTask,
  type CandidatePolicy,
  type RiskLevel,
} from "./candidateRisk";
import { buildLiveTask, toHourly } from "./liveSeries";
import { buildReplayRows, type ReplayRow } from "./replayEngine";

export type Safety = "safe" | "caution" | "danger" | "data" | "none";
export const SAFETY_RANK: Record<Safety, number> = { none: -1, safe: 0, caution: 1, data: 2, danger: 3 };
export const SAFETY_TEXT: Record<Safety, string> = {
  safe: "安全",
  caution: "注意",
  data: "先確認資料",
  danger: "危險",
  none: "無模型",
};

export const STATUS_HORIZONS = [1, 3] as const;

export interface Threshold {
  caution: number;
  alarm: number;
}
export type ThresholdOverrides = Record<string, Threshold>;

export interface HorizonView {
  h: number;
  origin: string;
  target: string;
  point: number | null;
  lower: number | null;
  upper: number | null;
  pCaution: number | null;
  level: Safety;
  alert: boolean;
  reasons: string[];
}

export interface DomainStatus {
  datasetId: string;
  name: string;
  hasModel: boolean;
  noModelReason: string | null;
  sensor: string | null;
  sensorLabel: string | null;
  unit: string;
  policy: CandidatePolicy | null;
  asOf: string | null;
  current: number | null;
  currentLevel: Safety;
  horizons: HorizonView[];
  level: Safety;
  source: "precomputed" | "import" | "engine";
  /** 引擎資料流是模擬（合成）資料時為 true */
  synthetic: boolean;
  /** 引擎即時資料的觀測歷史（決策頁圖用） */
  history?: Array<{ t: string; v: number | null }>;
  reliability: "reliable" | "warning" | "unreliable";
  reliabilityFindings: string[];
  recentEvents: number;
  /** 預測式警報線被觸發 */
  alert: boolean;
  /** 最近 48 小時觀測值（迷你圖） */
  spark: Array<number | null>;
}

function fromRisk(l: RiskLevel | null): Safety {
  return l === "alarm" ? "danger" : l === "caution" ? "caution" : "safe";
}

function maxSafety(a: Safety, b: Safety): Safety {
  return SAFETY_RANK[b] > SAFETY_RANK[a] ? b : a;
}

function viewFromRow(h: number, row: ReplayRow, policy: CandidatePolicy): HorizonView {
  let level: Safety;
  if (row.riskLevel === "high") level = "danger";
  else if (row.riskLevel === "elevated") level = "caution";
  else if (row.riskLevel === "low") level = "safe";
  else level = row.point !== null ? fromRisk(classify(row.point, policy)) : "safe";
  if (row.point !== null) level = maxSafety(level, fromRisk(classify(row.point, policy)));
  if (row.alert && level === "safe") level = "caution";
  return {
    h,
    origin: row.asOf,
    target: row.targetTime,
    point: row.point,
    lower: row.interval?.lower ?? null,
    upper: row.interval?.upper ?? null,
    pCaution: row.pCaution,
    level,
    alert: row.alert,
    reasons: row.reasons,
  };
}

export interface StatusInput {
  dataset: RealDataset;
  forecasts: PrecomputedForecasts | null;
  anomalies: AnomaliesResponse | undefined;
  overrides?: ThresholdOverrides;
  /** 有匯入資料時傳入「原始＋匯入」合併後的列；沒有則用預計算預測 */
  liveRows?: ParsedCsvRow[] | null;
  /** 連到本機引擎時的即時預測（優先順序：匯入資料 > 引擎 > 預計算） */
  engine?: EngineDomain | null;
}

export interface EngineDomain {
  forecast: LiveForecastResponse;
  status: LiveStatusResponse | null;
}

export function taskFor(
  input: StatusInput,
  policy: CandidatePolicy,
  horizon: number
): { task: PrecomputedForecastTask | null; source: "precomputed" | "import" } {
  if (input.liveRows && input.liveRows.length > 0) {
    const t = buildLiveTask(
      input.dataset.id,
      policy.sensor,
      policy.unit,
      horizon,
      toHourly(input.liveRows, policy.sensor)
    );
    if (t) return { task: t, source: "import" };
  }
  return { task: findTask(input.forecasts, input.dataset.id, policy.sensor, horizon), source: "precomputed" };
}

export function computeDomainStatus(input: StatusInput): DomainStatus {
  const { dataset } = input;
  const base = CANDIDATE_POLICIES[dataset.id];
  const empty: DomainStatus = {
    datasetId: dataset.id,
    name: dataset.display_name,
    hasModel: false,
    noModelReason: NO_RISK_REASONS[dataset.id] ?? "沒有風險政策",
    sensor: null,
    sensorLabel: null,
    unit: "",
    policy: null,
    asOf: null,
    current: null,
    currentLevel: "none",
    horizons: [],
    level: "none",
    source: "precomputed",
    synthetic: false,
    reliability: "reliable",
    reliabilityFindings: [],
    recentEvents: 0,
    alert: false,
    spark: [],
  };
  if (!base) return empty;
  const o = input.overrides?.[dataset.id];
  const policy = o ? applyOverride(base, o.caution, o.alarm) : base;
  const events = input.anomalies?.events ?? [];

  const hasImport = !!input.liveRows && input.liveRows.length > 0;
  if (!hasImport && input.engine) {
    const fromEngine = computeFromEngine(input, policy, empty);
    if (fromEngine) return fromEngine;
  }

  const horizons: HorizonView[] = [];
  let source: "precomputed" | "import" = "precomputed";
  let lastRow: ReplayRow | null = null;
  let spark: Array<number | null> = [];
  for (const h of STATUS_HORIZONS) {
    const { task, source: src } = taskFor(input, policy, h);
    if (!task) continue;
    source = src;
    const model = (src === "import" ? "persistence" : task.best_baseline) as ModelKey;
    const rows = buildReplayRows(task, policy, model, events);
    const row = rows[rows.length - 1];
    if (!row) continue;
    horizons.push(viewFromRow(h, row, policy));
    if (h === 1 || spark.length === 0) {
      spark = task.points.slice(-48).map((p) => (typeof p[4] === "number" ? p[4] : null));
    }
    if (h === 1 || !lastRow) lastRow = row;
  }
  if (horizons.length === 0 || !lastRow) {
    return { ...empty, hasModel: true, noModelReason: "沒有可用的預測資料", sensor: policy.sensor, unit: policy.unit, policy };
  }
  const col = dataset.columns.find((c) => c.key === policy.sensor);
  const currentLevel = lastRow.current === null ? "safe" : fromRisk(classify(lastRow.current, policy));
  let level: Safety = currentLevel;
  for (const v of horizons) level = maxSafety(level, v.level);
  const unreliable = lastRow.reliability === "unreliable";
  if (unreliable && level !== "danger") level = "data";
  const recent = events.filter((e) => e.end >= shiftDays(lastRow!.asOf, -1)).length;
  return {
    datasetId: dataset.id,
    name: dataset.display_name,
    hasModel: true,
    noModelReason: null,
    sensor: policy.sensor,
    sensorLabel: col?.description ? col.key : policy.sensor,
    unit: policy.unit,
    policy,
    asOf: lastRow.asOf,
    current: lastRow.current,
    currentLevel,
    horizons,
    level,
    source,
    synthetic: false,
    reliability: lastRow.reliability,
    reliabilityFindings: lastRow.reliabilityFindings,
    recentEvents: recent,
    alert: horizons.some((v) => v.alert),
    spark,
  };
}

const ENGINE_MODEL_ORDER = ["HGB", "XGB", "persistence", "moving_average", "seasonal_naive_24h", "linear_ar4"];

function engineValue(task: LiveForecastTask): number | null {
  for (const k of ENGINE_MODEL_ORDER) {
    const m = task.models[k];
    if (m && typeof m.value === "number" && Number.isFinite(m.value) && !m.refused) return m.value;
  }
  return null;
}

function flagText(f: unknown): string {
  if (typeof f === "string") return f;
  if (f && typeof f === "object" && typeof (f as { text?: unknown }).text === "string") return (f as { text: string }).text;
  return "";
}

/** 引擎即時預測 → 狀態。只做欄位整理與門檻比較；沒有區間與機率（引擎即時輸出沒有）。 */
export function computeFromEngine(input: StatusInput, policy: CandidatePolicy, empty: DomainStatus): DomainStatus | null {
  const eng = input.engine;
  if (!eng) return null;
  const tasks = eng.forecast.tasks.filter((t) => t.sensor === policy.sensor);
  const horizons: HorizonView[] = [];
  for (const h of STATUS_HORIZONS) {
    const t = tasks.find((x) => x.horizon_h === h);
    if (!t) continue;
    const point = engineValue(t);
    if (point === null) continue;
    horizons.push({
      h,
      origin: t.origin ?? eng.status?.data_end ?? "",
      target: t.target_timestamp,
      point,
      lower: null,
      upper: null,
      pCaution: null,
      level: fromRisk(classify(point, policy)),
      alert: false,
      reasons: [],
    });
  }
  if (horizons.length === 0) return null;
  const hist = (tasks[0]?.history ?? eng.forecast.history?.[policy.sensor] ?? []).slice(-72);
  const lastVal = [...hist].reverse().find((p) => typeof p.value === "number")?.value ?? null;
  const currentLevel: Safety = lastVal === null ? "safe" : fromRisk(classify(lastVal, policy));
  let level: Safety = currentLevel;
  for (const v of horizons) level = maxSafety(level, v.level);

  const findings: string[] = [];
  let reliability: DomainStatus["reliability"] = "reliable";
  if (eng.status?.is_stale) {
    reliability = "unreliable";
    findings.push("引擎資料已過時（太久沒有新資料）");
  }
  const flags = (eng.status?.flags ?? []).map(flagText).filter(Boolean);
  if (flags.length > 0) {
    if (reliability === "reliable") reliability = "warning";
    findings.push(...flags.slice(0, 3));
  }
  if (reliability === "unreliable" && level !== "danger") level = "data";
  const synthetic = eng.forecast.contains_synthetic || eng.status?.contains_synthetic === true;
  const col = input.dataset.columns.find((c) => c.key === policy.sensor);
  return {
    ...empty,
    hasModel: true,
    noModelReason: null,
    sensor: policy.sensor,
    sensorLabel: col?.description ? col.key : policy.sensor,
    unit: policy.unit,
    policy,
    asOf: horizons[0].origin || eng.status?.data_end || null,
    current: lastVal,
    currentLevel,
    horizons,
    level,
    source: "engine",
    synthetic,
    history: hist.map((p) => ({ t: p.time, v: typeof p.value === "number" ? p.value : null })),
    reliability,
    reliabilityFindings: findings,
    recentEvents: 0,
    alert: false,
    spark: hist.slice(-48).map((p) => (typeof p.value === "number" ? p.value : null)),
  };
}

function shiftDays(ts: string, days: number): string {
  const ms = Date.parse(ts.replace(" ", "T")) + days * 86_400_000;
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:00`;
}

export function overallLevel(list: DomainStatus[]): Safety {
  let lv: Safety = "safe";
  for (const s of list) if (s.level !== "none") lv = maxSafety(lv, s.level);
  return lv;
}

export const fmtVal = (v: number | null | undefined, d = 1) =>
  v === null || v === undefined || !Number.isFinite(v) ? "—" : v.toFixed(d);
