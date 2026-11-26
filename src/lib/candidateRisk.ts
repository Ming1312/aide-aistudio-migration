import type {
  AnomalyEvent,
  ModelKey,
  PrecomputedForecastTask,
  PrecomputedForecasts,
} from "../../contracts/types";

/**
 * 候選風險決策（六個非羊舍場域）。
 *
 * 重要：這裡所有「門檻」都是**假定值**（assumed）——沒有任何一個經資料提供者確認，也沒有故障標籤可驗證。
 * 它們只是讓「預測 → 風險等級 → 檢查／確認／通知」流程能在每個場域跑起來的示範參數，
 * 使用者可在畫面上修改。羊舍的 THI 84 同樣只是候選值，但羊舍另有凍結的正式決策引擎（見羊舍決策頁）。
 * 系統不控制任何設備；行動只有「檢查／確認／通知」。
 */

export type RiskLevel = "normal" | "caution" | "alarm";
export type RiskDirection = "above" | "below";

export interface CandidatePolicy {
  datasetId: string;
  sensor: string;
  unit: string;
  direction: RiskDirection;
  caution: number;
  alarm: number;
  /** 為什麼選這個感測器與這組數字（誠實說明；全部是假定） */
  basis: string;
  /** 只有檢查／確認／通知；沒有任何設備控制 */
  actions: { caution: string[]; alarm: string[]; dataSuspect: string[] };
}

export const ASSUMED_BADGE = "假定門檻・未經資料提供者確認・僅供展示";

export const CANDIDATE_POLICIES: Record<string, CandidatePolicy> = {
  expert_system_c22: {
    datasetId: "expert_system_c22",
    sensor: "DO1 即時值",
    unit: "mg/L",
    direction: "below",
    caution: 4.0,
    alarm: 3.5,
    basis:
      "魚塭的溶氧偏低是常見的管理風險。常見養殖慣例的緊迫線更低（約 3 mg/L），但最近 168 小時的資料範圍是 3.25～4.83 mg/L；為了讓示範流程不會全程沒有事件，這裡假定較高的兩條線。DO 探頭本身有漂移與階躍問題，因此資料可信度檢查優先。",
    actions: {
      caution: [
        "到現場確認 DO 探頭是否乾淨、讀值是否合理",
        "查看設備用電是否有停機（CPM 總電流）",
        "通知負責人留意接下來幾小時的 DO",
      ],
      alarm: [
        "立即通知現場人員到池邊確認溶氧（以手持儀器對照）",
        "確認增氧相關設備的運作狀態（只確認，系統不控制）",
        "記錄當下讀值與時間，供後續對照",
      ],
      dataSuspect: [
        "先處理資料：檢查探頭是否卡值、被清洗或剛校正",
        "確認前先不要依賴此預測",
      ],
    },
  },
  sanyegong_creek: {
    datasetId: "sanyegong_creek",
    sensor: "電池電量",
    unit: "%",
    direction: "below",
    caution: 90,
    alarm: 80,
    basis:
      "河川站的水質（DO、pH）受探頭卡值與校正切換影響，預測可信度低；站台靠太陽能與電池供電，電量過低會造成斷線與資料缺口，所以以「供電健康」作為候選風險。最近 168 小時電量範圍 73～100%，兩條線為假定值。",
    actions: {
      caution: [
        "確認太陽能板是否被遮蔽或髒污（現場或影像確認）",
        "通知維護人員排程巡檢",
      ],
      alarm: [
        "盡快通知維護人員確認供電（可能造成斷線與資料缺口）",
        "確認電池與充電電流讀值是否合理",
      ],
      dataSuspect: [
        "先處理資料：電池電量讀值卡住時不能代表實際供電狀況",
      ],
    },
  },
  construction_site_cb13505: {
    datasetId: "construction_site_cb13505",
    sensor: "噪音",
    unit: "dB(A)",
    direction: "above",
    caution: 65,
    alarm: 75,
    basis:
      "工地噪音是施工管理常見的風險，噪音在本資料中有穩定的日週期與機器學習增益（噪音三個時距全部是 ML 候選）。實際管制值依地方規範與時段而不同；這裡的 65／75 dB(A) 是假定值，最近 168 小時最大 77.9 dB(A)。",
    actions: {
      caution: [
        "確認目前施工作業與測點周邊狀況（是否有臨時作業）",
        "通知現場主管留意接下來數小時的噪音",
      ],
      alarm: [
        "通知現場主管確認高噪音作業並檢視是否需要調整時段（由人決定）",
        "記錄時間與作業內容，供後續查核",
      ],
      dataSuspect: ["先處理資料：確認噪音計是否卡值或被遮擋"],
    },
  },
  northeast_corner: {
    datasetId: "northeast_corner",
    sensor: "PM2.5",
    unit: "µg/m³",
    direction: "above",
    caution: 15,
    alarm: 25,
    basis:
      "懸浮微粒是環境監測站最常見的關注項目。常見空氣品質標準的 24 小時值約 35 µg/m³，但最近 168 小時最大只有 28.3，為了讓示範流程有事件，這裡假定較低的 15／25。PM2.5 沒有 ML 候選，預測使用基準方法。",
    actions: {
      caution: [
        "確認周邊是否有短期污染來源（施工、燃燒、交通）",
        "通知負責人持續觀察",
      ],
      alarm: [
        "通知負責人確認現場狀況並檢視感測器是否正常",
        "記錄當下讀值與時間",
      ],
      dataSuspect: ["先處理資料：PM2.5 近期有漂移或卡值候選事件，請先檢查感測器"],
    },
  },
  rearing_plant_1: {
    datasetId: "rearing_plant_1",
    sensor: "TEMP",
    unit: "°C",
    direction: "above",
    caution: 30,
    alarm: 33,
    basis:
      "育成廠房內的高溫是常見的管理風險，TEMP 有日週期且是 ML 候選（h3、h6）。最近 168 小時範圍 25.3～34.2 °C，30／33 °C 是假定值，不是設施或動物的確認門檻。",
    actions: {
      caution: [
        "確認通風與遮蔽狀況（現場確認，系統不控制設備）",
        "通知負責人留意接下來的溫度走勢",
      ],
      alarm: [
        "通知現場人員確認通風與降溫措施是否需要人工處置",
        "記錄當下讀值、時間與現場狀況",
      ],
      dataSuspect: ["先處理資料：TEMP 近期有卡值事件，請先檢查感測器"],
    },
  },
};

/** 沒有候選風險決策的場域（資料不足，依平台政策不建模） */
export const NO_RISK_REASONS: Record<string, string> = {
  rearing_plant_1_north:
    "此場域只有 387 列（涵蓋 17.6%），連續區段短，依平台政策不建立預測模型，也就沒有「預測式」風險決策。仍可使用資料品質、缺口與候選異常診斷。",
  sheep_barn:
    "羊舍已有凍結的正式決策引擎（HGB＋CQR＋ProbLinQ＋可靠度檢查＋警報管理），請見「羊舍決策」五個頁面；門檻 THI 84 同樣只是候選值。",
};

export function classify(value: number, policy: CandidatePolicy): RiskLevel {
  if (!Number.isFinite(value)) return "normal";
  if (policy.direction === "above") {
    if (value >= policy.alarm) return "alarm";
    if (value >= policy.caution) return "caution";
    return "normal";
  }
  if (value <= policy.alarm) return "alarm";
  if (value <= policy.caution) return "caution";
  return "normal";
}

export function levelRank(l: RiskLevel): number {
  return l === "alarm" ? 2 : l === "caution" ? 1 : 0;
}

export const LEVEL_TEXT: Record<RiskLevel, string> = {
  normal: "正常",
  caution: "注意",
  alarm: "警戒",
};

export const DEFAULT_HORIZONS = [1, 3, 6] as const;

export function findTask(
  forecasts: PrecomputedForecasts | null,
  datasetId: string,
  sensor: string,
  horizon: number
): PrecomputedForecastTask | null {
  if (!forecasts) return null;
  for (const t of Object.values(forecasts.tasks)) {
    if (t.dataset_id === datasetId && t.sensor === sensor && t.horizon_h === horizon) {
      return t;
    }
  }
  return null;
}

function colIndex(task: PrecomputedForecastTask, model: ModelKey): number {
  return (task.columns as string[]).indexOf(model);
}

/** 預測點的第 model 欄；沒有則為 null */
export function pointValue(
  task: PrecomputedForecastTask,
  idx: number,
  model: ModelKey
): number | null {
  const ci = colIndex(task, model);
  if (ci < 0) return null;
  const p = task.points[idx];
  if (!p) return null;
  const v = p[ci];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** 起點當下的觀測值＝持續性預測（y[t]） */
export function currentValueAt(task: PrecomputedForecastTask, idx: number): number | null {
  return pointValue(task, idx, "persistence");
}

export interface Assessment {
  origin: string;
  target: string;
  current: number | null;
  currentLevel: RiskLevel | null;
  forecast: number | null;
  forecastLevel: RiskLevel | null;
  /** 預測值離「注意線」的距離（正＝仍在安全側；同單位） */
  marginToCaution: number | null;
}

export function assessAt(
  task: PrecomputedForecastTask,
  idx: number,
  policy: CandidatePolicy,
  model: ModelKey
): Assessment | null {
  const p = task.points[idx];
  if (!p) return null;
  const cur = currentValueAt(task, idx);
  const fc = pointValue(task, idx, model);
  const margin =
    fc === null
      ? null
      : policy.direction === "above"
      ? policy.caution - fc
      : fc - policy.caution;
  return {
    origin: p[0],
    target: p[1],
    current: cur,
    currentLevel: cur === null ? null : classify(cur, policy),
    forecast: fc,
    forecastLevel: fc === null ? null : classify(fc, policy),
    marginToCaution: margin,
  };
}

export function latestIndex(task: PrecomputedForecastTask): number {
  return task.points.length - 1;
}

export interface BacktestRow {
  origin: string;
  target: string;
  actual: number;
  forecast: number;
  reactive: number | null;
  event: boolean;
  alert: boolean;
  reactiveAlert: boolean;
  alarmEvent: boolean;
  alarmAlert: boolean;
}

export interface Confusion {
  tp: number;
  fn: number;
  fp: number;
  tn: number;
}

export interface BacktestResult {
  n: number;
  rows: BacktestRow[];
  model: Confusion;
  reactive: Confusion;
  events: number;
  alarmEvents: number;
  alarmCaught: number;
}

export function emptyConfusion(): Confusion {
  return { tp: 0, fn: 0, fp: 0, tn: 0 };
}

function addConf(c: Confusion, event: boolean, alert: boolean) {
  if (event && alert) c.tp++;
  else if (event && !alert) c.fn++;
  else if (!event && alert) c.fp++;
  else c.tn++;
}

export function rate(num: number, den: number): number | null {
  return den > 0 ? num / den : null;
}

/** 歷史回放：預先算好的最近 168 個起點中，真值已到達者。與「現在讀值已超標」的反應式規則並排比較。 */
export function backtest(
  task: PrecomputedForecastTask,
  policy: CandidatePolicy,
  model: ModelKey
): BacktestResult {
  const rows: BacktestRow[] = [];
  const mc = emptyConfusion();
  const rc = emptyConfusion();
  let alarmEvents = 0;
  let alarmCaught = 0;
  for (let i = 0; i < task.points.length; i++) {
    const p = task.points[i];
    const actual = p[2];
    if (actual === null || actual === undefined) continue;
    const fc = pointValue(task, i, model);
    if (fc === null) continue;
    const cur = currentValueAt(task, i);
    const event = levelRank(classify(actual, policy)) >= 1;
    const alert = levelRank(classify(fc, policy)) >= 1;
    const reactiveAlert = cur !== null && levelRank(classify(cur, policy)) >= 1;
    const alarmEvent = classify(actual, policy) === "alarm";
    const alarmAlert = classify(fc, policy) === "alarm";
    addConf(mc, event, alert);
    addConf(rc, event, reactiveAlert);
    if (alarmEvent) {
      alarmEvents++;
      if (alarmAlert) alarmCaught++;
    }
    rows.push({
      origin: p[0],
      target: p[1],
      actual,
      forecast: fc,
      reactive: cur,
      event,
      alert,
      reactiveAlert,
      alarmEvent,
      alarmAlert,
    });
  }
  return {
    n: rows.length,
    rows,
    model: mc,
    reactive: rc,
    events: mc.tp + mc.fn,
    alarmEvents,
    alarmCaught,
  };
}

export type DataHealth = "ok" | "note" | "suspect";

export interface DataHealthResult {
  status: DataHealth;
  reasons: string[];
}

const SUSPECT_KINDS = new Set([
  "stuck_sensor",
  "drift_or_offset",
  "outage_missing_rows",
  "outage_zero_rows",
  "decoupling",
]);

function tms(s: string): number {
  return new Date(s.replace(" ", "T") + "Z").getTime();
}

/**
 * 資料可信度檢查：
 * (1) 觀測序列最近連續相同值（卡值） (2) 最近 24 小時與該感測器重疊的候選異常事件（卡值、漂移、斷線等）。
 * 與守門層同樣的精神：資料有問題時，建議先處理資料，不依賴預測。
 */
export function dataHealth(
  task: PrecomputedForecastTask | null,
  events: AnomalyEvent[],
  sensor: string,
  asOf: string | null
): DataHealthResult {
  const reasons: string[] = [];
  let status: DataHealth = "ok";
  if (task) {
    const vals: number[] = [];
    for (let i = Math.max(0, task.points.length - 6); i < task.points.length; i++) {
      const c = currentValueAt(task, i);
      if (c !== null) vals.push(c);
    }
    if (vals.length >= 6 && vals.every((v) => v === vals[0])) {
      status = "suspect";
      reasons.push(`最近 ${vals.length} 小時觀測值完全相同（${vals[0]}），疑似卡值`);
    }
  }
  if (asOf) {
    const end = tms(asOf);
    const begin = end - 24 * 3600 * 1000;
    for (const e of events) {
      const related = e.column === sensor || e.kind.startsWith("outage");
      if (!related) continue;
      const s = tms(e.start);
      const f = tms(e.end);
      if (f < begin || s > end) continue;
      const label = `${e.kind_zh || e.kind}（${e.start.slice(5, 16)}～${e.end.slice(5, 16)}）`;
      if (SUSPECT_KINDS.has(e.kind)) {
        status = "suspect";
        reasons.push(`最近 24 小時有候選事件：${label}`);
      } else {
        if (status === "ok") status = "note";
        reasons.push(`最近 24 小時有候選事件（僅供留意）：${label}`);
      }
    }
  }
  return { status, reasons };
}

export interface Decision {
  level: RiskLevel;
  headline: string;
  actions: string[];
  dataSuspect: boolean;
}

/** 風險等級取「現在觀測」與「預測」中較高者；資料可疑時導向「先處理資料」。 */
export function decide(
  policy: CandidatePolicy,
  a: Assessment | null,
  health: DataHealthResult
): Decision {
  const lv = Math.max(
    a?.currentLevel ? levelRank(a.currentLevel) : 0,
    a?.forecastLevel ? levelRank(a.forecastLevel) : 0
  );
  const level: RiskLevel = lv >= 2 ? "alarm" : lv === 1 ? "caution" : "normal";
  if (health.status === "suspect") {
    return {
      level,
      headline: "資料可信度不足：先處理資料，再判讀預測與風險等級",
      actions: policy.actions.dataSuspect,
      dataSuspect: true,
    };
  }
  if (level === "alarm") {
    return { level, headline: "候選風險：警戒（假定門檻）", actions: policy.actions.alarm, dataSuspect: false };
  }
  if (level === "caution") {
    return { level, headline: "候選風險：注意（假定門檻）", actions: policy.actions.caution, dataSuspect: false };
  }
  return {
    level,
    headline: "目前預測未超過假定門檻（不代表設備或環境正常）",
    actions: ["持續觀察；沒有需要的行動"],
    dataSuspect: false,
  };
}

export function applyOverride(
  base: CandidatePolicy,
  caution: number,
  alarm: number
): CandidatePolicy {
  // 方向一致性：above 時 alarm 必須 ≥ caution；below 時 alarm 必須 ≤ caution
  let c = caution;
  let a = alarm;
  if (base.direction === "above" && a < c) a = c;
  if (base.direction === "below" && a > c) a = c;
  return { ...base, caution: c, alarm: a };
}
