import React, { useEffect, useMemo, useState } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  AlertTriangle,
  ClipboardList,
  History,
  ShieldAlert,
  Stethoscope,
  TrendingUp,
} from "lucide-react";
import type {
  AnomaliesResponse,
  AnomalyEvent,
  ModelKey,
  PrecomputedForecasts,
  RealDataset,
} from "../../contracts/types";
import { MODEL_ORDER } from "../../contracts/types";
import {
  ASSUMED_BADGE,
  CANDIDATE_POLICIES,
  DEFAULT_HORIZONS,
  LEVEL_TEXT,
  NO_RISK_REASONS,
  applyOverride,
  assessAt,
  backtest,
  dataHealth,
  decide,
  findTask,
  latestIndex,
  pointValue,
  rate,
  type RiskLevel,
} from "../lib/candidateRisk";
import type { PageId } from "../types/app";

interface Props {
  datasets: RealDataset[];
  datasetId: string;
  onSelectDataset: (id: string) => void;
  precomputedForecasts: PrecomputedForecasts | null;
  anomaliesMap: Record<string, AnomaliesResponse>;
  onNavigate: (page: PageId) => void;
}

type Tab = "risk" | "actions" | "diagnosis" | "forecast" | "replay";

const TABS: Array<{ id: Tab; label: string; icon: React.ReactNode }> = [
  { id: "risk", label: "風險評估", icon: <ShieldAlert className="h-4 w-4" /> },
  { id: "actions", label: "處置決策", icon: <ClipboardList className="h-4 w-4" /> },
  { id: "diagnosis", label: "異常診斷", icon: <Stethoscope className="h-4 w-4" /> },
  { id: "forecast", label: "預測", icon: <TrendingUp className="h-4 w-4" /> },
  { id: "replay", label: "歷史回放", icon: <History className="h-4 w-4" /> },
];

const LEVEL_STYLE: Record<RiskLevel, string> = {
  normal: "bg-emerald-50 border-emerald-200 text-emerald-900",
  caution: "bg-amber-50 border-amber-300 text-amber-950",
  alarm: "bg-rose-50 border-rose-300 text-rose-950",
};

const MODEL_LABEL: Record<ModelKey, string> = {
  persistence: "持續性",
  moving_average: "滑動平均",
  seasonal_naive_24h: "24h 季節 Naive",
  linear_ar4: "線性 AR",
  HGB: "HGB",
  XGB: "XGBoost",
};

const KIND_ZH: Record<string, string> = {
  short_event_or_step: "短事件或階躍",
  drift_or_offset: "漂移或偏移",
  decoupling: "與同類感測器脫鉤",
  stuck_sensor: "讀值卡住",
  out_of_historical_range: "超出歷史範圍",
  outage_missing_rows: "整列缺失（斷線）",
  outage_zero_rows: "整列歸零（斷線）",
};
const kindZh = (e: AnomalyEvent) => KIND_ZH[e.kind] ?? (e.kind_zh || e.kind);

const num = (v: number | null | undefined, d = 2) =>
  v === null || v === undefined || !Number.isFinite(v) ? "—" : v.toFixed(d);
const pct = (v: number | null) => (v === null ? "—" : `${(100 * v).toFixed(0)}%`);

export const CandidateRiskPage: React.FC<Props> = ({
  datasets,
  datasetId,
  onSelectDataset,
  precomputedForecasts,
  anomaliesMap,
  onNavigate,
}) => {
  const [tab, setTab] = useState<Tab>("risk");
  const [horizon, setHorizon] = useState<number>(3);
  const basePolicy = CANDIDATE_POLICIES[datasetId];
  const [cautionIn, setCautionIn] = useState<number>(basePolicy?.caution ?? 0);
  const [alarmIn, setAlarmIn] = useState<number>(basePolicy?.alarm ?? 0);
  const [modelOverride, setModelOverride] = useState<ModelKey | "">("");
  const [humanLog, setHumanLog] = useState<Array<{ at: string; choice: string }>>([]);

  useEffect(() => {
    const p = CANDIDATE_POLICIES[datasetId];
    if (p) {
      setCautionIn(p.caution);
      setAlarmIn(p.alarm);
    }
    setModelOverride("");
    setHumanLog([]);
    setTab(p ? "risk" : "diagnosis");
  }, [datasetId]);

  const dataset = datasets.find((d) => d.id === datasetId);
  const anomalies = anomaliesMap[datasetId];
  const events: AnomalyEvent[] = anomalies?.events ?? [];
  const policy = useMemo(
    () => (basePolicy ? applyOverride(basePolicy, cautionIn, alarmIn) : null),
    [basePolicy, cautionIn, alarmIn]
  );
  const task = useMemo(
    () => (policy ? findTask(precomputedForecasts, datasetId, policy.sensor, horizon) : null),
    [policy, precomputedForecasts, datasetId, horizon]
  );
  const model: ModelKey = (modelOverride || task?.best_baseline || "persistence") as ModelKey;
  const idx = task ? latestIndex(task) : -1;
  const assessment = useMemo(
    () => (task && policy ? assessAt(task, idx, policy, model) : null),
    [task, policy, idx, model]
  );
  const health = useMemo(
    () => dataHealth(task, events, policy?.sensor ?? "", assessment?.origin ?? null),
    [task, events, policy, assessment]
  );
  const decision = useMemo(
    () => (policy ? decide(policy, assessment, health) : null),
    [policy, assessment, health]
  );
  const bt = useMemo(
    () => (task && policy ? backtest(task, policy, model) : null),
    [task, policy, model]
  );
  const horizonRows = useMemo(() => {
    if (!policy) return [];
    return DEFAULT_HORIZONS.map((h) => {
      const t = findTask(precomputedForecasts, datasetId, policy.sensor, h);
      if (!t) return { h, a: null, model: null as ModelKey | null };
      const m = (modelOverride || t.best_baseline) as ModelKey;
      return { h, a: assessAt(t, latestIndex(t), policy, m), model: m };
    });
  }, [policy, precomputedForecasts, datasetId, modelOverride]);

  const header = (
    <section className="bg-white border border-slate-200 rounded-lg p-4 sm:p-5 space-y-3 min-w-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-slate-900 break-words">
            候選風險決策{dataset ? `：${dataset.display_name}` : ""}
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            預測 → 資料可信度檢查 → 風險等級 → 檢查／確認／通知。與羊舍的決策流程同一結構，但所有門檻都是假定值。
          </p>
        </div>
        <label className="text-xs text-slate-600 flex items-center gap-2">
          場域
          <select
            data-testid="candidate-risk-dataset"
            className="border border-slate-300 rounded px-2 py-1 text-sm bg-white"
            value={datasetId}
            onChange={(e) => onSelectDataset(e.target.value)}
          >
            {datasets.map((d) => (
              <option key={d.id} value={d.id}>
                {d.display_name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div
        data-testid="assumed-threshold-banner"
        className="flex items-start gap-2 p-3 rounded-md bg-amber-50 border border-amber-300 text-xs text-amber-950"
      >
        <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-amber-700" />
        <div>
          <strong>{ASSUMED_BADGE}</strong>。這些數字<strong>不是</strong>資料提供者或標準給的警戒值，也沒有故障標籤可驗證；
          只用來讓決策流程在每個場域跑起來。<strong>系統不控制任何設備</strong>，行動只有「檢查／確認／通知」；
          預測是研究預測（探索性、未經獨立前瞻驗證）。
        </div>
      </div>
    </section>
  );

  if (!policy) {
    const reason = NO_RISK_REASONS[datasetId];
    return (
      <div className="space-y-5 min-w-0">
        {header}
        <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-3">
          <h2 className="text-base font-bold text-slate-900">此場域沒有候選風險決策</h2>
          <p className="text-sm text-slate-700 break-words" data-testid="no-risk-reason">
            {reason ?? "此場域沒有登錄候選風險政策。"}
          </p>
          {datasetId === "sheep_barn" && (
            <button
              type="button"
              className="px-3 py-1.5 rounded bg-[#0B63CE] text-white text-sm"
              onClick={() => onNavigate("sheep_risk")}
            >
              前往羊舍決策（風險評估）
            </button>
          )}
        </section>
        {datasetId !== "sheep_barn" && (
          <DiagnosisPanel events={events} sensor={null} health={null} anomalies={anomalies} />
        )}
      </div>
    );
  }

  return (
    <div className="space-y-5 min-w-0" data-testid="candidate-risk-page">
      {header}

      <section className="bg-white border border-slate-200 rounded-lg p-4 space-y-3 min-w-0">
        <div className="flex flex-wrap items-end gap-4 text-xs text-slate-700">
          <div>
            <div className="font-semibold text-slate-900">決策目標</div>
            <div className="text-sm">
              {policy.sensor}（{policy.unit}；{policy.direction === "above" ? "越高越危險" : "越低越危險"}）
            </div>
          </div>
          <label className="flex flex-col gap-1">
            注意線（假定）
            <input
              type="number"
              step="any"
              className="border border-slate-300 rounded px-2 py-1 w-24 text-sm"
              value={cautionIn}
              onChange={(e) => setCautionIn(Number(e.target.value))}
              data-testid="caution-input"
            />
          </label>
          <label className="flex flex-col gap-1">
            警戒線（假定）
            <input
              type="number"
              step="any"
              className="border border-slate-300 rounded px-2 py-1 w-24 text-sm"
              value={alarmIn}
              onChange={(e) => setAlarmIn(Number(e.target.value))}
              data-testid="alarm-input"
            />
          </label>
          <button
            type="button"
            className="px-2.5 py-1 rounded border border-slate-300 text-slate-700 hover:bg-slate-50"
            onClick={() => {
              setCautionIn(basePolicy.caution);
              setAlarmIn(basePolicy.alarm);
            }}
          >
            還原預設假定值
          </button>
          <label className="flex flex-col gap-1">
            預測時距
            <select
              className="border border-slate-300 rounded px-2 py-1 text-sm bg-white"
              value={horizon}
              onChange={(e) => setHorizon(Number(e.target.value))}
            >
              {DEFAULT_HORIZONS.map((h) => (
                <option key={h} value={h}>
                  {h} 小時後
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            預測方法
            <select
              className="border border-slate-300 rounded px-2 py-1 text-sm bg-white"
              value={modelOverride}
              onChange={(e) => setModelOverride(e.target.value as ModelKey | "")}
            >
              <option value="">預設（此任務最佳基準：{task ? MODEL_LABEL[task.best_baseline] : "—"}）</option>
              {MODEL_ORDER.map((m) => (
                <option key={m} value={m}>
                  {MODEL_LABEL[m]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="text-xs text-slate-500">
          畫面上改的門檻只存在這個瀏覽器分頁，重新整理就回到預設假定值；不會寫入任何地方。
        </p>
      </section>

      <div className="flex flex-wrap gap-2" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm border ${
              tab === t.id
                ? "bg-[#0B63CE] text-white border-[#0B63CE]"
                : "bg-white text-slate-700 border-slate-300 hover:bg-slate-50"
            }`}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      {!task && (
        <section className="bg-white border border-slate-200 rounded-lg p-5 text-sm text-slate-700">
          找不到此場域的預先計算預測（{policy.sensor}，{horizon} 小時）。
        </section>
      )}

      {task && decision && tab === "risk" && (
        <section className="space-y-4">
          <div
            data-testid="risk-level-card"
            className={`border rounded-lg p-4 sm:p-5 space-y-2 ${
              decision.dataSuspect ? "bg-rose-50 border-rose-300 text-rose-950" : LEVEL_STYLE[decision.level]
            }`}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="px-2.5 py-1 rounded text-xs font-bold border border-current/30">
                {decision.dataSuspect ? "先處理資料" : LEVEL_TEXT[decision.level]}
              </span>
              <h2 className="text-base font-bold break-words">{decision.headline}</h2>
            </div>
            <div className="grid sm:grid-cols-3 gap-3 text-sm">
              <div>
                <div className="text-xs opacity-80">起點（資料最後時間）</div>
                <div className="font-mono">{assessment?.origin ?? "—"}</div>
              </div>
              <div>
                <div className="text-xs opacity-80">此刻觀測值</div>
                <div className="text-lg font-semibold">
                  {num(assessment?.current)} {policy.unit}
                </div>
              </div>
              <div>
                <div className="text-xs opacity-80">
                  {horizon} 小時後預測（{MODEL_LABEL[model]}）
                </div>
                <div className="text-lg font-semibold">
                  {num(assessment?.forecast)} {policy.unit}
                  {assessment?.forecastLevel && (
                    <span className="ml-2 text-xs">（{LEVEL_TEXT[assessment.forecastLevel]}）</span>
                  )}
                </div>
              </div>
            </div>
            <div className="text-xs opacity-90">
              注意線 {policy.caution}、警戒線 {policy.alarm} {policy.unit}（假定）。距注意線：
              {assessment?.marginToCaution === null || assessment?.marginToCaution === undefined
                ? "—"
                : `${num(assessment.marginToCaution)} ${policy.unit}（正＝仍在安全側）`}
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-lg p-4 space-y-2">
            <h3 className="text-sm font-bold text-slate-900">三個時距的預測與等級</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-slate-500 border-b">
                    <th className="py-1 pr-3">時距</th>
                    <th className="py-1 pr-3">方法</th>
                    <th className="py-1 pr-3">預測值</th>
                    <th className="py-1 pr-3">等級</th>
                  </tr>
                </thead>
                <tbody>
                  {horizonRows.map((r) => (
                    <tr key={r.h} className="border-b border-slate-100">
                      <td className="py-1 pr-3">{r.h} 小時後</td>
                      <td className="py-1 pr-3">{r.model ? MODEL_LABEL[r.model] : "—"}</td>
                      <td className="py-1 pr-3">
                        {num(r.a?.forecast)} {policy.unit}
                      </td>
                      <td className="py-1 pr-3">{r.a?.forecastLevel ? LEVEL_TEXT[r.a.forecastLevel] : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div
            data-testid="data-health"
            className={`border rounded-lg p-4 text-sm space-y-1 ${
              health.status === "suspect"
                ? "bg-rose-50 border-rose-300 text-rose-950"
                : health.status === "note"
                ? "bg-amber-50 border-amber-200 text-amber-950"
                : "bg-white border-slate-200 text-slate-800"
            }`}
          >
            <div className="font-semibold">
              資料可信度：
              {health.status === "ok" ? "未發現問題" : health.status === "note" ? "有留意事項" : "疑似有問題，先處理資料"}
            </div>
            {health.reasons.map((r, i) => (
              <div key={i} className="text-xs">• {r}</div>
            ))}
            {health.reasons.length === 0 && (
              <div className="text-xs text-slate-500">最近 24 小時沒有該感測器的卡值、漂移或斷線候選事件，且觀測值沒有連續相同。</div>
            )}
          </div>

          <div className="bg-slate-50 border border-slate-200 rounded-lg p-4 text-xs text-slate-700 space-y-1">
            <div className="font-semibold text-slate-900">為什麼用這個目標與這組數字（全部假定）</div>
            <div className="break-words">{policy.basis}</div>
          </div>
        </section>
      )}

      {task && decision && tab === "actions" && (
        <section className="space-y-4">
          <div className={`border rounded-lg p-4 space-y-2 ${LEVEL_STYLE[decision.level]}`}>
            <h2 className="text-base font-bold">{decision.headline}</h2>
            <ul className="list-disc pl-5 text-sm space-y-1" data-testid="candidate-actions">
              {decision.actions.map((a, i) => (
                <li key={i}>{a}</li>
              ))}
            </ul>
            <p className="text-xs opacity-90">
              行動只有「檢查／確認／通知」，沒有任何設備控制。是否處置、如何處置全部由人決定。
            </p>
          </div>
          <div className="bg-white border border-slate-200 rounded-lg p-4 space-y-2">
            <h3 className="text-sm font-bold text-slate-900">人工決策（展示用，不寫入引擎）</h3>
            <div className="flex flex-wrap gap-2">
              {["接受建議", "拒絕建議", "修改後執行", "不處置"].map((c) => (
                <button
                  key={c}
                  type="button"
                  className="px-3 py-1.5 rounded border border-slate-300 text-sm hover:bg-slate-50"
                  onClick={() =>
                    setHumanLog((l) => [{ at: new Date().toLocaleTimeString("zh-TW", { hour12: false }), choice: c }, ...l].slice(0, 8))
                  }
                >
                  {c}
                </button>
              ))}
            </div>
            {humanLog.length > 0 ? (
              <ul className="text-xs text-slate-700 space-y-0.5">
                {humanLog.map((l, i) => (
                  <li key={i}>
                    {l.at}　{l.choice}（僅存在這個分頁的記憶體；重新整理即消失）
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-slate-500">尚未選擇。這個頁面不會寫入任何紀錄，也不會觸發任何動作。</p>
            )}
          </div>
        </section>
      )}

      {tab === "diagnosis" && (
        <DiagnosisPanel events={events} sensor={policy.sensor} health={health} anomalies={anomalies} />
      )}

      {task && tab === "forecast" && (
        <section className="space-y-4">
          <div className="bg-white border border-slate-200 rounded-lg p-4 space-y-3">
            <h2 className="text-base font-bold text-slate-900">
              {policy.sensor}：{horizon} 小時後預測（六種方法）
            </h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-slate-500 border-b">
                    <th className="py-1 pr-3">方法</th>
                    <th className="py-1 pr-3">最新預測</th>
                    <th className="py-1 pr-3">等級</th>
                    <th className="py-1 pr-3">驗證期 MAE</th>
                    <th className="py-1 pr-3">留存期 MAE</th>
                  </tr>
                </thead>
                <tbody>
                  {MODEL_ORDER.map((m) => {
                    const v = pointValue(task, idx, m);
                    const a = assessAt(task, idx, policy, m);
                    const mt = task.metrics?.[m];
                    return (
                      <tr key={m} className={`border-b border-slate-100 ${m === model ? "bg-blue-50" : ""}`}>
                        <td className="py-1 pr-3">
                          {MODEL_LABEL[m]}
                          {m === task.best_baseline ? "（最佳基準）" : ""}
                        </td>
                        <td className="py-1 pr-3">{v === null ? "拒絕／無" : `${num(v)} ${policy.unit}`}</td>
                        <td className="py-1 pr-3">{a?.forecastLevel ? LEVEL_TEXT[a.forecastLevel] : "—"}</td>
                        <td className="py-1 pr-3">{num(mt?.validation?.MAE, 3)}</td>
                        <td className="py-1 pr-3">{num(mt?.holdout?.MAE, 3)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-slate-500">
              簡單方法常常已經夠好；ML 沒有勝出是正常結果。MAE 單位同感測器（{policy.unit}），不可跨感測器比較。研究預測：探索性、未經獨立前瞻驗證。
            </p>
          </div>
          <ForecastChart task={task} model={model} policy={policy} />
        </section>
      )}

      {task && bt && tab === "replay" && (
        <section className="space-y-4">
          <div className="bg-white border border-slate-200 rounded-lg p-4 space-y-3" data-testid="replay-summary">
            <h2 className="text-base font-bold text-slate-900">歷史回放（最近 {bt.n} 個真值已到達的預測起點）</h2>
            <p className="text-xs text-slate-600">
              事件＝實際值達到「注意線」以上；警報＝預測值達到「注意線」以上。右欄「反應式規則」是「現在的讀值已超標才警報」，用來看預測有沒有比單純看現值更早。
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-slate-500 border-b">
                    <th className="py-1 pr-3">指標</th>
                    <th className="py-1 pr-3">預測式（{MODEL_LABEL[model]}）</th>
                    <th className="py-1 pr-3">反應式（看現值）</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    ["事件數", String(bt.events), String(bt.events)],
                    ["抓到（TP）", String(bt.model.tp), String(bt.reactive.tp)],
                    ["漏報（FN）", String(bt.model.fn), String(bt.reactive.fn)],
                    ["誤報（FP）", String(bt.model.fp), String(bt.reactive.fp)],
                    ["正常（TN）", String(bt.model.tn), String(bt.reactive.tn)],
                    ["召回率", pct(rate(bt.model.tp, bt.model.tp + bt.model.fn)), pct(rate(bt.reactive.tp, bt.reactive.tp + bt.reactive.fn))],
                    ["誤報率", pct(rate(bt.model.fp, bt.model.fp + bt.model.tn)), pct(rate(bt.reactive.fp, bt.reactive.fp + bt.reactive.tn))],
                    ["精確率", pct(rate(bt.model.tp, bt.model.tp + bt.model.fp)), pct(rate(bt.reactive.tp, bt.reactive.tp + bt.reactive.fp))],
                  ].map((r) => (
                    <tr key={r[0]} className="border-b border-slate-100">
                      <td className="py-1 pr-3">{r[0]}</td>
                      <td className="py-1 pr-3">{r[1]}</td>
                      <td className="py-1 pr-3">{r[2]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-slate-500">
              警戒等級事件 {bt.alarmEvents} 次，預測抓到 {bt.alarmCaught} 次。樣本只有 {bt.n} 個起點、事件很少，門檻又是假定值：
              這些比例只是「流程示範」，<strong>不是效能證據</strong>，不能宣稱預測式優於反應式。
            </p>
          </div>
          <ReplayChart bt={bt} policy={policy} />
        </section>
      )}
    </div>
  );
};

const ForecastChart: React.FC<{
  task: NonNullable<ReturnType<typeof findTask>>;
  model: ModelKey;
  policy: NonNullable<(typeof CANDIDATE_POLICIES)[string]>;
}> = ({ task, model, policy }) => {
  const data = useMemo(() => {
    const rows: Array<{ time: string; observed?: number; forecast?: number }> = [];
    const start = Math.max(0, task.points.length - 72);
    for (let i = start; i < task.points.length; i++) {
      const p = task.points[i];
      const cur = pointValue(task, i, "persistence");
      const fc = pointValue(task, i, model);
      rows.push({ time: p[0].slice(5, 16), observed: cur ?? undefined });
      if (fc !== null) rows.push({ time: p[1].slice(5, 16), forecast: fc });
    }
    const merged = new Map<string, { time: string; observed?: number; forecast?: number }>();
    for (const r of rows) {
      const m = merged.get(r.time) ?? { time: r.time };
      if (r.observed !== undefined) m.observed = r.observed;
      if (r.forecast !== undefined) m.forecast = r.forecast;
      merged.set(r.time, m);
    }
    return [...merged.values()].sort((a, b) => (a.time < b.time ? -1 : 1));
  }, [task, model]);
  return (
    <div className="bg-white border border-slate-200 rounded-lg p-4">
      <h3 className="text-sm font-bold text-slate-900 mb-2">最近 72 小時：觀測與 {task.horizon_h} 小時後預測</h3>
      <div style={{ width: "100%", height: 280 }}>
        <ResponsiveContainer>
          <LineChart data={data} margin={{ top: 8, right: 12, bottom: 8, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
            <XAxis dataKey="time" tick={{ fontSize: 10 }} minTickGap={32} />
            <YAxis tick={{ fontSize: 11 }} domain={["auto", "auto"]} unit={` ${policy.unit}`} width={70} />
            <Tooltip />
            <Legend />
            <ReferenceLine y={policy.caution} stroke="#d97706" strokeDasharray="4 4" label={{ value: "注意（假定）", fontSize: 10, fill: "#b45309" }} />
            <ReferenceLine y={policy.alarm} stroke="#dc2626" strokeDasharray="4 4" label={{ value: "警戒（假定）", fontSize: 10, fill: "#b91c1c" }} />
            <Line type="monotone" dataKey="observed" name="觀測" stroke="#0B63CE" dot={false} connectNulls />
            <Line type="monotone" dataKey="forecast" name={`預測（${MODEL_LABEL[model]}）`} stroke="#7C3AED" dot={{ r: 2 }} connectNulls />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};

const ReplayChart: React.FC<{
  bt: ReturnType<typeof backtest>;
  policy: NonNullable<(typeof CANDIDATE_POLICIES)[string]>;
}> = ({ bt, policy }) => {
  const data = bt.rows.map((r) => ({
    time: r.target.slice(5, 16),
    actual: r.actual,
    forecast: r.forecast,
  }));
  return (
    <div className="bg-white border border-slate-200 rounded-lg p-4">
      <h3 className="text-sm font-bold text-slate-900 mb-2">實際值與當時的預測（以目標時間對齊）</h3>
      <div style={{ width: "100%", height: 280 }}>
        <ResponsiveContainer>
          <LineChart data={data} margin={{ top: 8, right: 12, bottom: 8, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
            <XAxis dataKey="time" tick={{ fontSize: 10 }} minTickGap={32} />
            <YAxis tick={{ fontSize: 11 }} domain={["auto", "auto"]} unit={` ${policy.unit}`} width={70} />
            <Tooltip />
            <Legend />
            <ReferenceLine y={policy.caution} stroke="#d97706" strokeDasharray="4 4" />
            <ReferenceLine y={policy.alarm} stroke="#dc2626" strokeDasharray="4 4" />
            <Line type="monotone" dataKey="actual" name="實際" stroke="#0B63CE" dot={false} />
            <Line type="monotone" dataKey="forecast" name="預測" stroke="#7C3AED" dot={false} strokeDasharray="5 3" />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};

const DiagnosisPanel: React.FC<{
  events: AnomalyEvent[];
  sensor: string | null;
  health: ReturnType<typeof dataHealth> | null;
  anomalies: AnomaliesResponse | undefined;
}> = ({ events, sensor, health, anomalies }) => {
  const own = sensor ? events.filter((e) => e.column === sensor) : [];
  const recent = [...events].sort((a, b) => (a.end < b.end ? 1 : -1)).slice(0, 12);
  const byKind = events.reduce<Record<string, number>>((m, e) => {
    const k = kindZh(e);
    m[k] = (m[k] ?? 0) + 1;
    return m;
  }, {});
  return (
    <section className="space-y-4" data-testid="candidate-diagnosis">
      <div className="bg-white border border-slate-200 rounded-lg p-4 space-y-2">
        <h2 className="text-base font-bold text-slate-900">異常診斷（候選事件，不是故障判定）</h2>
        <p className="text-xs text-slate-600">
          {anomalies?.disclaimer ?? "偵測器只用真實歷史資料建立參考，沒有故障標籤，也沒有宣稱準確度。"}
        </p>
        <div className="text-sm text-slate-800">
          此場域共 {events.length} 筆候選事件：
          {Object.entries(byKind).map(([k, v]) => `${k} ${v}`).join("、") || "無"}。
          {sensor ? `其中「${sensor}」有 ${own.length} 筆。` : ""}
        </div>
        {health && health.reasons.length > 0 && (
          <ul className="text-xs text-rose-900 list-disc pl-5">
            {health.reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        )}
      </div>
      <div className="bg-white border border-slate-200 rounded-lg p-4 overflow-x-auto">
        <h3 className="text-sm font-bold text-slate-900 mb-2">最近的候選事件（最多 12 筆）</h3>
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-slate-500 border-b">
              <th className="py-1 pr-3">種類</th>
              <th className="py-1 pr-3">感測器</th>
              <th className="py-1 pr-3">開始</th>
              <th className="py-1 pr-3">結束</th>
              <th className="py-1 pr-3">小時</th>
              <th className="py-1 pr-3">說明</th>
            </tr>
          </thead>
          <tbody>
            {recent.map((e, i) => (
              <tr key={i} className="border-b border-slate-100 align-top">
                <td className="py-1 pr-3">{kindZh(e)}</td>
                <td className="py-1 pr-3">{e.column}</td>
                <td className="py-1 pr-3 font-mono">{e.start.slice(0, 16)}</td>
                <td className="py-1 pr-3 font-mono">{e.end.slice(0, 16)}</td>
                <td className="py-1 pr-3">{e.hours}</td>
                <td className="py-1 pr-3 break-words">{e.note}</td>
              </tr>
            ))}
            {recent.length === 0 && (
              <tr>
                <td className="py-2 text-slate-500" colSpan={6}>
                  沒有候選事件。
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <p className="text-xs text-slate-500 mt-2">
          「可能原因」（探頭老化、接線鬆脫…）資料本身無法驗證；需要現場確認或維護紀錄。
        </p>
      </div>
    </section>
  );
};
