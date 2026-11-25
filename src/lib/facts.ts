import type {
  AnomaliesResponse,
  DataKind,
  Fact,
  MODEL_ORDER,
  PrecomputedForecastTask,
} from "../../contracts/types";
import type { DemoStepOutput } from "../types/app";
import type { ColumnStats } from "./csv";

export function buildForecastFacts(
  task: PrecomputedForecastTask,
  pointIndex: number,
  datasetId: string
): Fact[] {
  const row = task.points[pointIndex];
  if (!row) return [];
  const [origin, target, actual, period] = row;
  const periodMap: Record<string, string> = {
    t: "訓練期（樣本內）",
    v: "驗證期",
    h: "留存測試期",
    l: "最新起點（尚無實際值）",
  };
  const facts: Fact[] = [
    {
      id: "f1",
      text: `${datasetId} 感測器 ${task.sensor} 預測 +${task.horizon_h} 小時；起點 ${origin}，目標 ${target}（${periodMap[period] ?? period}）`,
    },
    {
      id: "f2",
      text: `最佳簡單基準為 ${task.best_baseline}；資料來源為預計算（離線）歷史時點模擬`,
    },
  ];
  if (actual !== null && Number.isFinite(actual)) {
    facts.push({
      id: "f3",
      text: "事後實際值",
      value: actual,
      unit: task.unit,
    });
  }
  const keys: Array<(typeof MODEL_ORDER)[number]> = [
    "persistence",
    "moving_average",
    "seasonal_naive_24h",
    "linear_ar4",
    "HGB",
    "XGB",
  ];
  keys.forEach((key, idx) => {
    const val = row[4 + idx] as number | null | undefined;
    if (val !== null && val !== undefined && Number.isFinite(val)) {
      const m = task.metrics[key];
      const valMae = m?.validation?.MAE;
      const holdMae = m?.holdout?.MAE;
      facts.push({
        id: `f${facts.length + 1}`,
        text: `${task.model_names[key] ?? key} 預測值${valMae !== undefined ? `（驗證期 MAE ${valMae.toFixed(4)}、留存期 MAE ${holdMae?.toFixed(4) ?? "無"}）` : ""}`,
        value: Number(val.toFixed(4)),
        unit: task.unit,
      });
    }
  });
  return facts;
}

export function buildAnomalyFacts(
  anomalies: AnomaliesResponse,
  maxEvents = 8
): Fact[] {
  const facts: Fact[] = [
    {
      id: "f1",
      text: `${anomalies.dataset_id} 偵測器共標出候選事件數（僅為候選，不是故障判定）`,
      value: anomalies.n_events,
      unit: "筆",
    },
  ];
  anomalies.events.slice(0, maxEvents).forEach((ev, i) => {
    facts.push({
      id: `f${i + 2}`,
      text: `${ev.kind_zh}（感測器 ${ev.column}）：${ev.start} 到 ${ev.end}，持續 ${ev.hours} 小時，分數 ${ev.score.toFixed(2)}；${ev.note}`,
      value: ev.hours,
      unit: "小時",
    });
  });
  return facts;
}

export function buildExplorerFacts(
  datasetName: string,
  start: string,
  end: string,
  rowCount: number,
  statsList: ColumnStats[],
  units: Record<string, string>,
  gapCount: number,
  longestGapHours: number
): Fact[] {
  const facts: Fact[] = [
    {
      id: "f1",
      text: `${datasetName} 檢視區間 ${start} 到 ${end}，共 ${rowCount} 筆，時間缺口 ${gapCount} 段（最長 ${longestGapHours} 小時）`,
      value: rowCount,
      unit: "筆",
    },
  ];
  statsList.slice(0, 6).forEach((st) => {
    const unit = units[st.sensor] ?? "";
    if (st.mean !== null && st.min !== null && st.max !== null) {
      facts.push({
        id: `f${facts.length + 1}`,
        text: `感測器 ${st.sensor}：觀測 ${st.observed} 筆（缺漏 ${st.missingRatePct.toFixed(1)}%），最小 ${st.min.toFixed(3)}、最大 ${st.max.toFixed(3)}、平均 ${st.mean.toFixed(3)} ${unit}（單位為推測）`,
        value: Number(st.mean.toFixed(3)),
        unit,
      });
    } else {
      facts.push({
        id: `f${facts.length + 1}`,
        text: `感測器 ${st.sensor} 在此區間沒有有效觀測值（缺漏 ${st.missingRatePct.toFixed(1)}%）`,
      });
    }
  });
  return facts;
}

export function buildSyntheticStepFacts(
  domainName: string,
  stepOut: DemoStepOutput,
  batchLabel: string,
  version: string,
  dataKind: DataKind = "synthetic"
): Fact[] {
  return [
    {
      id: "f1",
      text: `合成展示資料（${dataKind}）：${domainName} 步驟 D${stepOut.step}「${batchLabel}」，版本 ${version}，累積列數 ${stepOut.rows_appended}`,
      value: stepOut.rows_appended,
      unit: "列",
    },
    {
      id: "f2",
      text: `品質問題數 ${stepOut.n_data_quality}、異常訊號數 ${stepOut.n_signal}、環境變化抑制 ${stepOut.n_environment_suppressed}`,
      value: stepOut.n_signal,
      unit: "筆",
    },
    {
      id: "f3",
      text: stepOut.guard
        ? `守門建議：${stepOut.guard.recommendation}（感測器健康度 ${stepOut.guard.sensor_health}、允許重訓：${stepOut.retrain_allowed ? "是" : "否"}）`
        : "此場域資料不足，系統不建立預測模型，沒有守門建議與重訓資訊",
    },
    ...stepOut.cards.map((c, idx) => ({
      id: `f${idx + 4}`,
      text: `系統卡片（${c.level}）：${c.title}${c.lead_sensor ? `（主要感測器 ${c.lead_sensor}）` : ""}`,
    })),
  ];
}
