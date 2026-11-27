import type {
  AnomalyEvent,
  ModelKey,
  PrecomputedForecastTask,
} from "../../contracts/types";
import {
  classify,
  currentValueAt,
  pointValue,
  type CandidatePolicy,
  type RiskDirection,
} from "./candidateRisk.ts";

/**
 * 嚴格回放引擎（非羊舍場域）。
 *
 * 羊舍的決策頁（風險評估／AI 預測／歷史回放）顯示的是凍結正式引擎在「每個起點」的輸出：
 * 現況、點預測、90% 預測區間、超過門檻的機率、警報線、風險等級與原因、感測器可信度、簡單基準對照。
 * 這裡對其他場域做**同一套輸出**，但資料來源與方法不同，必須誠實標示：
 *   - 預測：引擎預先算好的研究預測（預設用該任務的最佳基準，也可改選六種方法），不是凍結的正式模型；
 *   - 區間：split-conformal——只用「起點當下已經抵達真值」的最近 72 筆殘差校正（名目 90%）；
 *   - 超標機率：同一批殘差的經驗分布（平移到點預測上）；
 *   - 警報線：只用起點當下已抵達的歷史事件，以「召回率 0.9」為目標選出（事件太少時用預設 0.15）；
 *   - 門檻：假定值（見 candidateRisk.ts），未經確認。
 * 所有量都是因果的：起點 t 的輸出只用目標時間 ≤ t 的真值。
 */

export const CAL_WINDOW = 72;
export const MIN_CAL = 24;
export const COVERAGE = 0.9;
export const RECALL_TARGET = 0.9;
export const DEFAULT_CUTOFF = 0.15;
export const CUTOFF_HISTORY = 120;
export const MIN_EVENTS_FOR_CUTOFF = 3;

export type ReplayRiskLevel = "low" | "elevated" | "high" | "unavailable";
export type Reliability = "reliable" | "warning" | "unreliable";

export interface ReplayRow {
  idx: number;
  asOf: string;
  targetTime: string;
  period: string;
  inSample: boolean;
  current: number | null;
  point: number | null;
  actual: number | null;
  interval: { lower: number; upper: number; coverage: number; method: string } | null;
  nCal: number;
  pCaution: number | null;
  pAlarm: number | null;
  cutoff: number | null;
  cutoffSource: "recall_target" | "default" | null;
  alert: boolean;
  /** 起點當下的觀測值已達注意線（反應式規則會警報） */
  reactiveAlert: boolean;
  /** 實際值（目標時間）達到注意線 */
  event: boolean;
  riskLevel: ReplayRiskLevel;
  reasons: string[];
  reliability: Reliability;
  reliabilityFindings: string[];
  handling: "normal" | "data_first";
  references: { persistence: number | null; seasonalNaive: number | null };
}

export function crosses(value: number, direction: RiskDirection, line: number): boolean {
  return direction === "above" ? value >= line : value <= line;
}

export function conformalQuantile(absScores: number[], level: number): { q: number; exact: boolean } {
  const s = [...absScores].filter(Number.isFinite).sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return { q: Number.NaN, exact: false };
  const k = Math.ceil((n + 1) * level);
  if (k > n) return { q: s[n - 1], exact: false };
  return { q: s[k - 1], exact: true };
}

/** 殘差經驗分布平移到點預測上，估計越過 line 的機率（Laplace 平滑，避免 0 與 1） */
export function exceedProbability(
  point: number,
  residuals: number[],
  direction: RiskDirection,
  line: number
): number | null {
  if (residuals.length === 0) return null;
  let c = 0;
  for (const r of residuals) if (crosses(point + r, direction, line)) c++;
  return (c + 1) / (residuals.length + 2);
}

function tms(s: string): number {
  return new Date(s.replace(" ", "T") + "Z").getTime();
}

const SUSPECT_KINDS = new Set([
  "stuck_sensor",
  "drift_or_offset",
  "outage_missing_rows",
  "outage_zero_rows",
  "decoupling",
]);

/** 起點 idx 的資料可信度：只看 idx 以前的觀測與起點前 24 小時內的候選事件（因果） */
export function reliabilityAt(
  task: PrecomputedForecastTask,
  idx: number,
  events: AnomalyEvent[],
  sensor: string
): { reliability: Reliability; findings: string[] } {
  const findings: string[] = [];
  let suspect = false;
  let note = false;
  const vals: number[] = [];
  for (let i = Math.max(0, idx - 5); i <= idx; i++) {
    const c = currentValueAt(task, i);
    if (c !== null) vals.push(c);
  }
  if (vals.length >= 6 && vals.every((v) => v === vals[0])) {
    suspect = true;
    findings.push(`最近 6 小時觀測值完全相同（${vals[0]}），疑似卡值`);
  }
  const asOf = task.points[idx]?.[0];
  if (asOf) {
    const end = tms(asOf);
    const begin = end - 24 * 3600 * 1000;
    for (const e of events) {
      if (!(e.column === sensor || e.kind.startsWith("outage"))) continue;
      const s = tms(e.start);
      const f = tms(e.end);
      if (f < begin || s > end) continue;
      const label = `${e.kind_zh || e.kind}（${e.start.slice(5, 16)}～${e.end.slice(5, 16)}）`;
      if (SUSPECT_KINDS.has(e.kind)) {
        suspect = true;
        findings.push(`起點前 24 小時內有候選事件：${label}`);
      } else {
        note = true;
        findings.push(`起點前 24 小時內有候選事件（僅供留意）：${label}`);
      }
    }
  }
  return { reliability: suspect ? "unreliable" : note ? "warning" : "reliable", findings };
}

/** 以召回率目標選警報線：事件列的機率由小到大，允許漏掉 E − ceil(0.9E) 個 */
export function pickCutoff(
  history: Array<{ p: number; event: boolean }>
): { cutoff: number; source: "recall_target" | "default" } {
  const ev = history.filter((h) => h.event).map((h) => h.p).sort((a, b) => a - b);
  if (ev.length < MIN_EVENTS_FOR_CUTOFF) return { cutoff: DEFAULT_CUTOFF, source: "default" };
  const need = Math.ceil(RECALL_TARGET * ev.length);
  const allowedMiss = ev.length - need;
  const c = ev[allowedMiss];
  return { cutoff: Math.min(0.5, Math.max(0.02, c)), source: "recall_target" };
}

export function buildReplayRows(
  task: PrecomputedForecastTask,
  policy: CandidatePolicy,
  model: ModelKey,
  events: AnomalyEvent[]
): ReplayRow[] {
  const pts = task.points;
  const n = pts.length;
  const point: Array<number | null> = new Array(n).fill(null);
  const actual: Array<number | null> = new Array(n).fill(null);
  const pC: Array<number | null> = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    point[i] = pointValue(task, i, model);
    const a = pts[i][2];
    actual[i] = a === null || a === undefined ? null : a;
  }
  const rows: ReplayRow[] = [];
  const seasonalCol = (task.columns as string[]).indexOf("seasonal_naive_24h");
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const asOf = p[0];
    // 起點當下已抵達真值的殘差（因果：目標時間 ≤ 起點時間）
    const matured: number[] = [];
    const maturedIdx: number[] = [];
    for (let j = i - 1; j >= 0 && matured.length < CAL_WINDOW; j--) {
      if (actual[j] === null || point[j] === null) continue;
      if (pts[j][1] > asOf) continue;
      matured.push((actual[j] as number) - (point[j] as number));
      maturedIdx.push(j);
    }
    const cur = currentValueAt(task, i);
    const pt = point[i];
    let interval: ReplayRow["interval"] = null;
    let pCaution: number | null = null;
    let pAlarm: number | null = null;
    if (pt !== null && matured.length >= MIN_CAL) {
      const { q } = conformalQuantile(matured.map(Math.abs), COVERAGE);
      interval = { lower: pt - q, upper: pt + q, coverage: COVERAGE, method: "split-conformal（滾動校正，最近 72 筆已抵達殘差）" };
      pCaution = exceedProbability(pt, matured, policy.direction, policy.caution);
      pAlarm = exceedProbability(pt, matured, policy.direction, policy.alarm);
    }
    pC[i] = pCaution;
    // 警報線：只用起點當下已抵達、且當時已有機率的歷史列
    const hist: Array<{ p: number; event: boolean }> = [];
    for (let j = i - 1; j >= 0 && hist.length < CUTOFF_HISTORY; j--) {
      if (actual[j] === null || pC[j] === null || pts[j][1] > asOf) continue;
      hist.push({ p: pC[j] as number, event: crosses(actual[j] as number, policy.direction, policy.caution) });
    }
    const cut = pCaution === null ? null : pickCutoff(hist);
    const alert = pCaution !== null && cut !== null && pCaution >= cut.cutoff;
    const rel = reliabilityAt(task, i, events, policy.sensor);
    const reactiveAlert = cur !== null && crosses(cur, policy.direction, policy.caution);
    const event = actual[i] !== null && crosses(actual[i] as number, policy.direction, policy.caution);
    const ptLevel = pt === null ? "normal" : classify(pt, policy);
    const curLevel = cur === null ? "normal" : classify(cur, policy);
    let riskLevel: ReplayRiskLevel = "unavailable";
    if (pCaution !== null && pAlarm !== null) {
      if (ptLevel === "alarm" || curLevel === "alarm" || pAlarm >= 0.5) riskLevel = "high";
      else if (alert || ptLevel === "caution") riskLevel = "elevated";
      else riskLevel = "low";
    } else if (pt !== null) {
      riskLevel = ptLevel === "alarm" ? "high" : ptLevel === "caution" ? "elevated" : "low";
    }
    const reasons: string[] = [];
    const dirWord = policy.direction === "above" ? "≥" : "≤";
    if (pCaution !== null && cut) {
      reasons.push(
        `P(${policy.sensor} ${dirWord} ${policy.caution}) ≈ ${pCaution.toFixed(2)}，${
          alert ? "超過" : "低於"
        }警報線 ${cut.cutoff.toFixed(2)}（${
          cut.source === "recall_target"
            ? "以召回率 0.9 為目標、只用起點前已抵達的歷史事件選出"
            : "歷史事件不足 3 筆，使用預設警報線"
        }）`
      );
    } else {
      reasons.push(`校正資料不足（已抵達殘差 ${matured.length} 筆 < ${MIN_CAL}）：不顯示區間與機率`);
    }
    if (pAlarm !== null) reasons.push(`P(${policy.sensor} ${dirWord} ${policy.alarm}（警戒線）) ≈ ${pAlarm.toFixed(2)}`);
    reasons.push(`注意線 ${policy.caution}、警戒線 ${policy.alarm} ${policy.unit} （門檻來源見「設定」；不是安全標準，未經資料提供者確認）`);
    rows.push({
      idx: i,
      asOf,
      targetTime: p[1],
      period: String(p[3] ?? ""),
      inSample: p[3] === "t" || p[3] === "v",
      current: cur,
      point: pt,
      actual: actual[i],
      interval,
      nCal: matured.length,
      pCaution,
      pAlarm,
      cutoff: cut ? cut.cutoff : null,
      cutoffSource: cut ? cut.source : null,
      alert,
      reactiveAlert,
      event,
      riskLevel,
      reasons,
      reliability: rel.reliability,
      reliabilityFindings: rel.findings,
      handling: rel.reliability === "unreliable" ? "data_first" : "normal",
      references: {
        persistence: cur,
        seasonalNaive: seasonalCol >= 0 && typeof p[seasonalCol] === "number" ? (p[seasonalCol] as number) : null,
      },
    });
  }
  return rows;
}

export interface ReplaySummary {
  n: number;
  events: number;
  model: { tp: number; fn: number; fp: number; tn: number };
  reactive: { tp: number; fn: number; fp: number; tn: number };
  modelEpisodes: number;
  reactiveEpisodes: number;
}

function episodes(flags: boolean[]): number {
  let c = 0;
  for (let i = 0; i < flags.length; i++) if (flags[i] && (i === 0 || !flags[i - 1])) c++;
  return c;
}

/** 回放摘要：只算真值已抵達且機率可用的列；與「現在讀值已超標才警報」的反應式規則並排 */
export function summarizeReplay(rows: ReplayRow[]): ReplaySummary {
  const used = rows.filter((r) => r.actual !== null && r.pCaution !== null);
  const model = { tp: 0, fn: 0, fp: 0, tn: 0 };
  const reactive = { tp: 0, fn: 0, fp: 0, tn: 0 };
  const add = (c: typeof model, ev: boolean, al: boolean) => {
    if (ev && al) c.tp++;
    else if (ev && !al) c.fn++;
    else if (!ev && al) c.fp++;
    else c.tn++;
  };
  for (const r of used) {
    add(model, r.event, r.alert);
    add(reactive, r.event, r.reactiveAlert);
  }
  return {
    n: used.length,
    events: model.tp + model.fn,
    model,
    reactive,
    modelEpisodes: episodes(used.map((r) => r.alert)),
    reactiveEpisodes: episodes(used.map((r) => r.reactiveAlert)),
  };
}
