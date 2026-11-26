import React, { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Database,
  History,
  ShieldAlert,
  SlidersHorizontal,
  Stethoscope,
} from "lucide-react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type {
  AnomaliesResponse,
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
  classify,
  findTask,
  pointValue,
  rate,
} from "../lib/candidateRisk";
import { buildReplayRows, summarizeReplay, type ReplayRiskLevel } from "../lib/replayEngine";
import type { ApiHealthStatus, PageId } from "../types/app";

interface Props {
  page: Extract<PageId, "sheep_risk" | "sheep_actions" | "sheep_diagnosis" | "sheep_forecast" | "sheep_replay">;
  dataset: RealDataset;
  precomputedForecasts: PrecomputedForecasts | null;
  anomalies: AnomaliesResponse | undefined;
  health: ApiHealthStatus | null;
}

const MODEL_LABEL: Record<ModelKey, string> = {
  persistence: "持續性",
  moving_average: "滑動平均",
  seasonal_naive_24h: "24h 季節 Naive",
  linear_ar4: "線性 AR",
  HGB: "HGB",
  XGB: "XGBoost",
};

const RISK_TEXT: Record<ReplayRiskLevel, string> = {
  low: "低（low）",
  elevated: "升高（elevated）",
  high: "高（high）",
  unavailable: "無法評估",
};

const RELIABILITY_TEXT = { reliable: "reliable", warning: "warning", unreliable: "unreliable" } as const;

const KIND_ZH: Record<string, string> = {
  short_event_or_step: "短事件或階躍",
  drift_or_offset: "漂移或偏移",
  decoupling: "與同類感測器脫鉤",
  stuck_sensor: "讀值卡住",
  out_of_historical_range: "超出歷史範圍",
  outage_missing_rows: "整列缺失（斷線）",
  outage_zero_rows: "整列歸零（斷線）",
};

const num = (v: number | null | undefined, d = 2) =>
  v === null || v === undefined || !Number.isFinite(v) ? "—" : v.toFixed(d);
const pct = (v: number | null) => (v === null ? "—" : `${(100 * v).toFixed(0)}%`);

export const DomainDecisionPages: React.FC<Props> = ({
  page,
  dataset,
  precomputedForecasts,
  anomalies,
  health,
}) => {
  const datasetId = dataset.id;
  const basePolicy = CANDIDATE_POLICIES[datasetId];
  const [horizon, setHorizon] = useState(3);
  const [model, setModel] = useState<ModelKey | "">("");
  const [cautionIn, setCautionIn] = useState(basePolicy?.caution ?? 0);
  const [alarmIn, setAlarmIn] = useState(basePolicy?.alarm ?? 0);
  const [selectedIdx, setSelectedIdx] = useState(-1);
  const [humanLog, setHumanLog] = useState<Array<{ at: string; choice: string }>>([]);

  useEffect(() => {
    const p = CANDIDATE_POLICIES[datasetId];
    setCautionIn(p?.caution ?? 0);
    setAlarmIn(p?.alarm ?? 0);
    setModel("");
    setSelectedIdx(-1);
    setHumanLog([]);
  }, [datasetId]);

  const policy = useMemo(
    () => (basePolicy ? applyOverride(basePolicy, cautionIn, alarmIn) : null),
    [basePolicy, cautionIn, alarmIn]
  );
  const task = useMemo(
    () => (policy ? findTask(precomputedForecasts, datasetId, policy.sensor, horizon) : null),
    [policy, precomputedForecasts, datasetId, horizon]
  );
  const activeModel = (model || task?.best_baseline || "persistence") as ModelKey;
  const events = anomalies?.events ?? [];
  const rows = useMemo(
    () => (task && policy ? buildReplayRows(task, policy, activeModel, events) : []),
    [task, policy, activeModel, events]
  );
  const summary = useMemo(() => summarizeReplay(rows), [rows]);
  const idx = selectedIdx >= 0 && selectedIdx < rows.length ? selectedIdx : rows.length - 1;
  const row = rows[idx];

  const banner = (
    <div className="p-3.5 rounded-md bg-amber-50 border border-amber-300 text-xs text-amber-950 space-y-1" data-testid="domain-decision-banner">
      <div className="font-semibold flex items-center gap-1.5">
        <ShieldAlert className="h-4 w-4 text-amber-700" />
        {dataset.display_name}決策政策邊界與誠實標示
      </div>
      <div>
        • {policy ? <><strong>{ASSUMED_BADGE}</strong>：注意線 {policy.caution}、警戒線 {policy.alarm} {policy.unit}（{policy.sensor}）。</> : <>此場域沒有候選風險門檻。</>}
        目前<strong>沒有經驗證的政策</strong>（validated_policy = false）。
      </div>
      <div>• <strong>系統不控制任何設備</strong>（所有處置均由人員決定）。預測是研究預測（探索性、未經獨立前瞻驗證）。</div>
      {policy && (
        <div>
          • 與羊舍的差別：羊舍是凍結的正式引擎輸出；本頁是<strong>預先算好的研究預測</strong>＋滾動 split-conformal 區間＋殘差機率，
          全部只用「起點當下已抵達的真值」（因果），不是凍結的正式模型。
        </div>
      )}
    </div>
  );

  const titleMap: Record<Props["page"], string> = {
    sheep_risk: "風險評估",
    sheep_forecast: "AI 預測",
    sheep_replay: "歷史回放",
    sheep_diagnosis: "異常診斷（候選事件檢視，不是故障判定）",
    sheep_actions: "處置決策與人工紀錄",
  };

  const header = (icon: React.ReactNode, sub?: React.ReactNode) => (
    <div className="flex flex-wrap items-start justify-between gap-3 min-w-0">
      <div className="min-w-0">
        <h1 className="text-xl font-bold text-slate-900 flex items-center gap-2 break-words">
          {icon}
          <span className="min-w-0">
            {dataset.display_name}　{titleMap[page]}
            {policy && page !== "sheep_diagnosis" && page !== "sheep_actions" ? `（${policy.sensor} +${horizon} 小時・嚴格回放）` : ""}
          </span>
        </h1>
        {sub && <p className="text-xs text-slate-600 mt-1 flex flex-wrap items-center gap-1.5 min-w-0 break-words">{sub}</p>}
      </div>
      <span className="text-xs px-2.5 py-1 rounded border border-slate-200 bg-slate-50 text-slate-700 font-mono-tabular shrink-0">
        {health?.engine_connected ? "引擎已連線（唯讀）" : "離線預計算模式"}
      </span>
    </div>
  );

  // ---------- 異常診斷（所有場域；與羊舍同一版型）
  if (page === "sheep_diagnosis") {
    const evs = [...events].sort((a, b) => (a.end < b.end ? 1 : -1));
    return (
      <div className="space-y-6 min-w-0" data-testid="domain-diagnosis-page">
        <section className="bg-white border border-slate-200 rounded-lg p-4 sm:p-5 space-y-4 min-w-0">
          {header(<Stethoscope className="h-5 w-5 text-[#0B63CE] shrink-0" />)}
          {banner}
          {row && row.reliabilityFindings.length > 0 && (
            <div className="p-3 rounded-md bg-rose-50 border border-rose-200 text-xs text-rose-950 space-y-0.5">
              <div className="font-semibold">目前起點（{row.asOf}）的資料可信度：{RELIABILITY_TEXT[row.reliability]}</div>
              {row.reliabilityFindings.map((f, i) => (
                <div key={i}>• {f}</div>
              ))}
            </div>
          )}
          {evs.length > 0 ? (
            <div className="space-y-2.5 min-w-0">
              {evs.slice(0, 60).map((ev, i) => (
                <div key={i} className="p-3.5 rounded-md border border-amber-200 bg-amber-50/70 text-xs space-y-1 min-w-0 overflow-x-auto">
                  <div className="font-semibold text-amber-950 break-words">
                    候選事件：{KIND_ZH[ev.kind] ?? ev.kind_zh}（感測器 {ev.column}）
                  </div>
                  <div className="text-slate-700 break-words">{ev.note}</div>
                  <div className="font-mono-tabular text-slate-600 break-words">
                    起訖：{ev.start} ～ {ev.end}（{ev.hours} 小時）｜ 偵測器：{ev.detector} ｜ 分數：{ev.score.toFixed(2)}
                  </div>
                </div>
              ))}
              {evs.length > 60 && <div className="text-xs text-slate-500">另有 {evs.length - 60} 筆較早的候選事件未列出。</div>}
            </div>
          ) : (
            <div className="text-xs text-slate-500">無異常事件。</div>
          )}
        </section>
      </div>
    );
  }

  // ---------- 沒有政策的場域（育成北側）
  if (!policy || !task) {
    return (
      <div className="space-y-6 min-w-0">
        <section className="bg-white border border-slate-200 rounded-lg p-4 sm:p-5 space-y-3 min-w-0">
          {header(<ShieldAlert className="h-5 w-5 text-[#0B63CE] shrink-0" />)}
          <div className="text-sm text-slate-800 break-words" data-testid="no-risk-reason">
            {!policy
              ? NO_RISK_REASONS[datasetId] ?? "此場域沒有登錄候選風險政策。"
              : `找不到此場域的預先計算預測（${policy.sensor}，${horizon} 小時）。`}
          </div>
          <p className="text-xs text-slate-500">仍可使用「異常診斷」檢視候選事件，以及「決策輔助」的一般建議與需要人工確認的異常。</p>
        </section>
      </div>
    );
  }

  // ---------- 處置決策
  if (page === "sheep_actions") {
    const lvl = row ? row.riskLevel : "unavailable";
    const actions =
      row?.handling === "data_first"
        ? policy.actions.dataSuspect
        : lvl === "high"
        ? policy.actions.alarm
        : lvl === "elevated"
        ? policy.actions.caution
        : ["持續觀察；沒有需要的行動"];
    return (
      <div className="space-y-6 min-w-0" data-testid="domain-actions-page">
        <section className="bg-white border border-slate-200 rounded-lg p-4 sm:p-5 space-y-4 min-w-0">
          {header(<SlidersHorizontal className="h-5 w-5 text-[#0B63CE] shrink-0" />, <>依最新起點（{row?.asOf ?? "—"}）的風險等級列出候選措施</>)}
          {banner}
          <div className="p-4 rounded-md bg-slate-50 border border-slate-200 text-xs text-slate-700 space-y-2 min-w-0">
            <div className="font-semibold text-slate-900">
              最新起點：風險 {RISK_TEXT[lvl]}；資料可信度 {row ? RELIABILITY_TEXT[row.reliability] : "—"}
              {row?.handling === "data_first" ? "（先處理資料）" : ""}
            </div>
            <ul className="list-disc pl-5 space-y-1" data-testid="domain-actions-list">
              {actions.map((a, i) => (
                <li key={i}>{a}</li>
              ))}
            </ul>
            <p className="break-words">行動只有「檢查／確認／通知」；任何設備處置皆由現場人員依實際狀況決定並手動執行，本平台不控制設備。</p>
          </div>
          <div className="p-4 rounded-md bg-white border border-slate-200 text-xs space-y-2">
            <div className="font-semibold text-slate-900">人工決策（展示用，只存在這個分頁的記憶體，不寫入引擎）</div>
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
            {humanLog.length === 0 ? (
              <div className="text-slate-500">尚未選擇；這個頁面不會寫入任何紀錄，也不會觸發任何動作。</div>
            ) : (
              humanLog.map((l, i) => (
                <div key={i} className="text-slate-700">
                  {l.at}　{l.choice}（重新整理即消失）
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    );
  }

  // ---------- 風險評估／AI 預測／歷史回放（與羊舍同一版型）
  const chartData = rows.map((r) => ({
    asOf: r.asOf.slice(5, 16),
    current: r.current,
    point: r.point,
    band: r.interval ? [r.interval.lower, r.interval.upper] : undefined,
  }));
  const replayData = rows.map((r) => ({
    time: r.targetTime.slice(5, 16),
    actual: r.actual,
    forecast: r.point,
    band: r.interval ? [r.interval.lower, r.interval.upper] : undefined,
  }));
  const icon = page === "sheep_replay" ? <History className="h-5 w-5 text-[#0B63CE] shrink-0" /> : <ShieldAlert className="h-5 w-5 text-[#0B63CE] shrink-0" />;

  return (
    <div className="space-y-6 min-w-0" data-testid="domain-decision-page">
      <section className="bg-white border border-slate-200 rounded-lg p-4 sm:p-5 space-y-4 min-w-0">
        {header(
          icon,
          <>
            <Database className="h-3.5 w-3.5 text-[#0B63CE] shrink-0" />
            <span>
              預計算（離線）：引擎預先算好的研究預測，嚴格回放共 {rows.length} 個起點，產生於{" "}
              <span className="font-mono-tabular">{precomputedForecasts?.meta.generated_at ?? "-"}</span>；不是即時監控
            </span>
          </>
        )}
        {banner}

        <div className="flex flex-wrap items-end gap-4 text-xs text-slate-700">
          <label className="flex flex-col gap-1">
            注意線（假定）
            <input type="number" step="any" className="border border-slate-300 rounded px-2 py-1 w-24 text-sm" value={cautionIn} onChange={(e) => setCautionIn(Number(e.target.value))} data-testid="caution-input" />
          </label>
          <label className="flex flex-col gap-1">
            警戒線（假定）
            <input type="number" step="any" className="border border-slate-300 rounded px-2 py-1 w-24 text-sm" value={alarmIn} onChange={(e) => setAlarmIn(Number(e.target.value))} data-testid="alarm-input" />
          </label>
          <button type="button" className="px-2.5 py-1 rounded border border-slate-300 hover:bg-slate-50" onClick={() => { setCautionIn(basePolicy.caution); setAlarmIn(basePolicy.alarm); }}>
            還原預設假定值
          </button>
          <label className="flex flex-col gap-1">
            預測時距
            <select className="border border-slate-300 rounded px-2 py-1 text-sm bg-white" value={horizon} onChange={(e) => { setHorizon(Number(e.target.value)); setSelectedIdx(-1); }}>
              {DEFAULT_HORIZONS.map((h) => (
                <option key={h} value={h}>{h} 小時後</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            預測方法
            <select className="border border-slate-300 rounded px-2 py-1 text-sm bg-white" value={model} onChange={(e) => setModel(e.target.value as ModelKey | "")}>
              <option value="">預設（最佳基準：{MODEL_LABEL[task.best_baseline]}）</option>
              {MODEL_ORDER.map((m) => (
                <option key={m} value={m}>{MODEL_LABEL[m]}</option>
              ))}
            </select>
          </label>
        </div>

        {rows.length === 0 || !row ? (
          <div className="py-8 text-center text-xs text-slate-500">沒有可回放的起點。</div>
        ) : (
          <div className="space-y-4 min-w-0">
            <div className="p-3 rounded-md bg-slate-50 border border-slate-200 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-2.5 text-xs min-w-0">
              <div className="w-full lg:flex-1 flex flex-col sm:flex-row sm:items-center gap-1.5 sm:gap-2 min-w-0">
                <label htmlFor="domain-asof-select" className="font-medium text-slate-700 shrink-0">選擇嚴格回放時點（as_of）：</label>
                <select id="domain-asof-select" value={idx} onChange={(e) => setSelectedIdx(Number(e.target.value))} className="w-full max-w-full min-w-0 rounded border border-slate-300 bg-white px-2.5 py-1.5 font-mono-tabular text-slate-800" data-testid="domain-asof-select">
                  {rows.map((r, i) => (
                    <option key={r.asOf} value={i}>
                      {r.asOf}（{policy.sensor} {num(r.current)} → 預測 {num(r.point)}｜{RISK_TEXT[r.riskLevel]}）
                    </option>
                  ))}
                </select>
              </div>
              <div className="font-mono-tabular text-slate-600 shrink-0 break-all">預測方法：{MODEL_LABEL[activeModel]}（研究預測，未註冊、未經獨立驗證）</div>
            </div>

            {row.inSample && (
              <div className="p-3 rounded-md bg-amber-50 border border-amber-300 text-xs text-amber-950 font-semibold flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-700" />
                樣本內警示（period = {row.period}）：此時點落於訓練／驗證期，不是預測能力的證據。
              </div>
            )}

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs min-w-0" data-testid="domain-cards">
              <div className="p-3 rounded border border-slate-200 bg-white min-w-0 break-words">
                <div className="text-slate-500">起點現況 {policy.sensor}</div>
                <div className="text-lg font-bold font-mono-tabular text-slate-900 mt-0.5">{num(row.current)} {policy.unit}</div>
              </div>
              <div className="p-3 rounded border border-slate-200 bg-white min-w-0 break-words">
                <div className="text-slate-500">目標 +{horizon}h 點預測（90% 區間）</div>
                <div className="text-lg font-bold font-mono-tabular text-[#0B63CE] mt-0.5">{num(row.point)}</div>
                <div className="font-mono-tabular text-slate-500">
                  {row.interval ? `[${num(row.interval.lower)} ～ ${num(row.interval.upper)}]` : "（校正資料不足，無區間）"}
                </div>
              </div>
              <div className="p-3 rounded border border-slate-200 bg-white min-w-0 break-words">
                <div className="text-slate-500">越過候選注意線 {policy.caution} 的機率</div>
                <div className="text-lg font-bold font-mono-tabular text-slate-900 mt-0.5" data-testid="domain-pcaution">
                  {row.pCaution !== null ? `${(row.pCaution * 100).toFixed(1)}%` : "—"}
                </div>
                <div className="text-slate-500" data-testid="domain-risk-level">風險等級：{RISK_TEXT[row.riskLevel]}{row.alert ? "・警報" : ""}</div>
              </div>
              <div className="p-3 rounded border border-slate-200 bg-white min-w-0 break-words">
                <div className="text-slate-500">感測器可信度／簡單基準</div>
                <div className="text-sm font-semibold text-slate-900 mt-0.5 break-words">
                  {RELIABILITY_TEXT[row.reliability]} · {row.handling === "data_first" ? "先處理資料" : "normal"}
                </div>
                <div className="font-mono-tabular text-slate-500 mt-0.5">昨日同期：{num(row.references.seasonalNaive)}</div>
              </div>
            </div>

            <div className="p-3.5 rounded-md bg-slate-50 border border-slate-200 text-xs space-y-1 min-w-0 overflow-x-auto">
              <div className="font-semibold text-slate-800">模型輸出原因（假定門檻）</div>
              {row.reasons.map((r, i) => (
                <div key={i} className="text-slate-700 break-words">• {r}</div>
              ))}
              {row.reliabilityFindings.map((r, i) => (
                <div key={`f-${i}`} className="text-rose-800 break-words">• 資料可信度：{r}</div>
              ))}
              <div className="text-slate-500">區間方法：{row.interval?.method ?? "—"}；已抵達校正殘差 {row.nCal} 筆</div>
            </div>

            <div className="h-72 w-full min-w-0 overflow-x-auto">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData} margin={{ top: 10, right: 16, left: 0, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                  <XAxis dataKey="asOf" tick={{ fontSize: 11, fill: "#64748B" }} minTickGap={24} />
                  <YAxis tick={{ fontSize: 11, fill: "#64748B" }} width={56} domain={["auto", "auto"]} />
                  <Tooltip />
                  <ReferenceLine y={policy.caution} stroke="#D97706" strokeDasharray="4 4" label={{ value: `候選注意線 ${policy.caution}（假定）`, fontSize: 11, fill: "#B45309", position: "insideTopRight" }} />
                  <ReferenceLine y={policy.alarm} stroke="#DC2626" strokeDasharray="4 4" label={{ value: `警戒線 ${policy.alarm}（假定）`, fontSize: 11, fill: "#B91C1C", position: "insideBottomRight" }} />
                  <Area type="monotone" dataKey="band" name="90% 預測區間" stroke="none" fill="#0B63CE" fillOpacity={0.14} />
                  <Line type="monotone" dataKey="current" name={`起點 ${policy.sensor}`} stroke="#64748B" strokeWidth={1.5} dot={false} />
                  <Line type="monotone" dataKey="point" name={`+${horizon}h 點預測`} stroke="#0B63CE" strokeWidth={2} dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            {page === "sheep_forecast" && (
              <div className="overflow-x-auto">
                <table className="w-full text-xs" data-testid="domain-methods-table">
                  <thead>
                    <tr className="text-left text-slate-500 border-b">
                      <th className="py-1 pr-3">方法</th>
                      <th className="py-1 pr-3">最新預測</th>
                      <th className="py-1 pr-3">等級</th>
                      <th className="py-1 pr-3">驗證期 MAE</th>
                      <th className="py-1 pr-3">留存期 MAE</th>
                    </tr>
                  </thead>
                  <tbody>
                    {MODEL_ORDER.map((m) => {
                      const v = pointValue(task, task.points.length - 1, m);
                      const mt = task.metrics?.[m];
                      return (
                        <tr key={m} className={`border-b border-slate-100 ${m === activeModel ? "bg-blue-50" : ""}`}>
                          <td className="py-1 pr-3">{MODEL_LABEL[m]}{m === task.best_baseline ? "（最佳基準）" : ""}</td>
                          <td className="py-1 pr-3">{v === null ? "拒絕／無" : `${num(v)} ${policy.unit}`}</td>
                          <td className="py-1 pr-3">{v === null ? "—" : LEVEL_TEXT[classify(v, policy)]}</td>
                          <td className="py-1 pr-3">{num(mt?.validation?.MAE, 3)}</td>
                          <td className="py-1 pr-3">{num(mt?.holdout?.MAE, 3)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <p className="text-[11px] text-slate-500 mt-1">簡單方法常常已經夠好；ML 沒有勝出是正常結果。MAE 單位同感測器，不可跨感測器比較。</p>
              </div>
            )}

            {page === "sheep_replay" && (
              <div className="space-y-3" data-testid="domain-replay-summary">
                <div className="h-64 w-full min-w-0 overflow-x-auto">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={replayData} margin={{ top: 10, right: 16, left: 0, bottom: 8 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                      <XAxis dataKey="time" tick={{ fontSize: 11, fill: "#64748B" }} minTickGap={24} />
                      <YAxis tick={{ fontSize: 11, fill: "#64748B" }} width={56} domain={["auto", "auto"]} />
                      <Tooltip />
                      <ReferenceLine y={policy.caution} stroke="#D97706" strokeDasharray="4 4" />
                      <Area type="monotone" dataKey="band" name="90% 預測區間" stroke="none" fill="#7C3AED" fillOpacity={0.12} />
                      <Line type="monotone" dataKey="actual" name="實際（目標時間）" stroke="#0B63CE" strokeWidth={2} dot={false} />
                      <Line type="monotone" dataKey="forecast" name="當時的預測" stroke="#7C3AED" strokeDasharray="5 3" dot={false} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-slate-500 border-b">
                        <th className="py-1 pr-3">指標（{summary.n} 個真值已抵達的起點）</th>
                        <th className="py-1 pr-3">預測式警報</th>
                        <th className="py-1 pr-3">反應式（現值已超標才警報）</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[
                        ["事件數（實際達注意線）", String(summary.events), String(summary.events)],
                        ["抓到（TP）／漏報（FN）", `${summary.model.tp}／${summary.model.fn}`, `${summary.reactive.tp}／${summary.reactive.fn}`],
                        ["誤報（FP）／正常（TN）", `${summary.model.fp}／${summary.model.tn}`, `${summary.reactive.fp}／${summary.reactive.tn}`],
                        ["召回率", pct(rate(summary.model.tp, summary.model.tp + summary.model.fn)), pct(rate(summary.reactive.tp, summary.reactive.tp + summary.reactive.fn))],
                        ["誤報率", pct(rate(summary.model.fp, summary.model.fp + summary.model.tn)), pct(rate(summary.reactive.fp, summary.reactive.fp + summary.reactive.tn))],
                        ["精確率", pct(rate(summary.model.tp, summary.model.tp + summary.model.fp)), pct(rate(summary.reactive.tp, summary.reactive.tp + summary.reactive.fp))],
                        ["警報段數（連續警報合併）", String(summary.modelEpisodes), String(summary.reactiveEpisodes)],
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
                <p className="text-[11px] text-slate-500">
                  樣本只有 {summary.n} 個起點、事件很少，門檻又是假定值：這些比例只是「流程示範」，<strong>不是效能證據</strong>，不能宣稱預測式優於反應式。
                </p>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
};
