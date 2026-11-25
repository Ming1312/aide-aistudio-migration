import React, { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Database,
  History,
  Lock,
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
import type { AnomaliesResponse, PrecomputedFormalSheep } from "../../contracts/types";
import { loadPrecomputedFormalSheep } from "../lib/dataLoader";
import type { ApiHealthStatus, PageId } from "../types/app";

interface SheepDecisionPagesProps {
  page: Extract<
    PageId,
    | "sheep_risk"
    | "sheep_actions"
    | "sheep_diagnosis"
    | "sheep_forecast"
    | "sheep_replay"
  >;
  anomalies: AnomaliesResponse | undefined;
  health: ApiHealthStatus | null;
}

interface FormalRowResult {
  forecast_target?: string;
  site?: string;
  origin_time?: string;
  target_time?: string;
  current_thi?: number;
  point_prediction?: number;
  prediction_interval?: {
    lower?: number;
    upper?: number;
    nominal_coverage?: number;
    method?: string;
  };
  sensor_reliability?: string;
  handling?: string;
  risk?: {
    threshold?: number;
    threshold_status?: string;
    p_exceed?: number;
    alert?: boolean;
    alert_cutoff?: number;
    risk_level?: string;
    risk_reasons?: string[];
  };
  window_risk?: {
    p_exceed_window?: number;
    alert?: boolean;
    alert_cutoff?: number;
    reasons?: string[];
  };
  references?: {
    persistence?: number;
    seasonal_naive_yesterday?: number;
  };
}

export const SheepDecisionPages: React.FC<SheepDecisionPagesProps> = ({
  page,
  anomalies,
  health,
}) => {
  const [formalData, setFormalData] = useState<PrecomputedFormalSheep | null>(
    null
  );
  const [loading, setLoading] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(0);

  useEffect(() => {
    setLoading(true);
    loadPrecomputedFormalSheep()
      .then((d) => {
        setFormalData(d);
        setSelectedIdx(Math.max(0, d.formal.rows.length - 1));
      })
      .finally(() => setLoading(false));
  }, []);

  const rows = formalData?.formal.rows ?? [];
  const activeRow = rows[selectedIdx] ?? rows[rows.length - 1];
  const res = (activeRow?.result ?? {}) as FormalRowResult;

  const chartData = useMemo(
    () =>
      rows.map((r) => {
        const rr = r.result as FormalRowResult;
        const lower = rr.prediction_interval?.lower ?? null;
        const upper = rr.prediction_interval?.upper ?? null;
        return {
          asOf: r.as_of.slice(5, 16),
          currentThi: rr.current_thi ?? null,
          pointPred: rr.point_prediction ?? null,
          bandRange:
            lower !== null && upper !== null ? [lower, upper] : undefined,
        };
      }),
    [rows]
  );

  const sheepGuardBanner = (
    <div className="p-3.5 rounded-md bg-blue-50 border border-blue-200 text-xs text-blue-950 space-y-1">
      <div className="font-semibold flex items-center gap-1.5">
        <ShieldAlert className="h-4 w-4 text-[#0B63CE]" />
        羊舍決策政策邊界與誠實標示
      </div>
      <div>
        • <strong>門檻 84 為候選值，未經資料提供者確認</strong>；
        <strong>目前沒有經驗證的政策</strong>（validated_policy = false）。
      </div>
      <div>
        • <strong>系統不控制任何設備</strong>（所有通風／降溫／現場處置均由人員決定）。
      </div>
    </div>
  );

  if (page === "sheep_forecast" || page === "sheep_replay" || page === "sheep_risk") {
    return (
      <div className="space-y-6 min-w-0">
        <section className="bg-white border border-slate-200 rounded-lg p-4 sm:p-5 space-y-4 min-w-0">
          <div className="flex flex-wrap items-start justify-between gap-3 min-w-0">
            <div className="min-w-0">
              <h1 className="text-xl font-bold text-slate-900 flex items-center gap-2 break-words">
                {page === "sheep_replay" ? (
                  <History className="h-5 w-5 text-[#0B63CE] shrink-0" />
                ) : (
                  <ShieldAlert className="h-5 w-5 text-[#0B63CE] shrink-0" />
                )}
                <span className="min-w-0">
                  {page === "sheep_forecast"
                    ? "羊舍 AI 預測（成羊區 THI +3 小時・嚴格回放）"
                    : page === "sheep_replay"
                      ? "羊舍歷史回放（最近 168 小時嚴格重播）"
                      : "羊舍風險評估（Phase 2.6 正式引擎輸出）"}
                </span>
              </h1>
              <p className="text-xs text-slate-600 mt-1 flex flex-wrap items-center gap-1.5 min-w-0 break-words">
                <Database className="h-3.5 w-3.5 text-[#0B63CE] shrink-0" />
                <span>
                  預計算（離線）：Python 引擎嚴格回放（strict_replay，共 {rows.length} 小時），產生於{" "}
                  <span className="font-mono-tabular break-all">
                    {formalData?.meta.generated_at ?? "-"}
                  </span>
                  ；不是即時監控
                </span>
              </p>
            </div>
            <span className="text-xs px-2.5 py-1 rounded border border-slate-200 bg-slate-50 text-slate-700 font-mono-tabular shrink-0">
              {health?.engine_connected ? "引擎已連線（唯讀）" : "離線預計算模式"}
            </span>
          </div>

          {sheepGuardBanner}

          {loading || !activeRow ? (
            <div className="py-8 text-center text-xs text-slate-500">
              正在載入羊舍嚴格回放輸出…
            </div>
          ) : (
            <div className="space-y-4 min-w-0">
              {/* Timepoint selector */}
              <div className="p-3 rounded-md bg-slate-50 border border-slate-200 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-2.5 text-xs min-w-0">
                <div className="w-full lg:flex-1 flex flex-col sm:flex-row sm:items-center gap-1.5 sm:gap-2 min-w-0">
                  <label
                    htmlFor="sheep-asof-select"
                    className="font-medium text-slate-700 shrink-0"
                  >
                    選擇嚴格回放時點（as_of）：
                  </label>
                  <select
                    id="sheep-asof-select"
                    value={selectedIdx}
                    onChange={(e) => setSelectedIdx(Number(e.target.value))}
                    className="w-full max-w-full min-w-0 rounded border border-slate-300 bg-white px-2.5 py-1.5 font-mono-tabular text-slate-800"
                  >
                    {rows.map((r, i) => {
                      const rr = r.result as FormalRowResult;
                      return (
                        <option key={r.as_of} value={i}>
                          {r.as_of}（THI {rr.current_thi ?? "-"} → 預測{" "}
                          {rr.point_prediction ?? "-"}｜
                          {rr.risk?.risk_level ?? "-"}）
                        </option>
                      );
                    })}
                  </select>
                </div>
                <div className="font-mono-tabular text-slate-600 shrink-0 break-all">
                  凍結模型版本：{activeRow.model_version}
                </div>
              </div>

              {activeRow.in_sample && (
                <div className="p-3 rounded-md bg-amber-50 border border-amber-300 text-xs text-amber-950 font-semibold flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-amber-700" />
                  樣本內警示（in_sample = true）：此時點落於模型訓練期間內，不是預測能力的證據。
                </div>
              )}

              {/* Metrics cards */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs min-w-0">
                <div className="p-3 rounded border border-slate-200 bg-white min-w-0 break-words">
                  <div className="text-slate-500">起點現況 THI</div>
                  <div className="text-lg font-bold font-mono-tabular text-slate-900 mt-0.5">
                    {res.current_thi ?? "—"}
                  </div>
                </div>
                <div className="p-3 rounded border border-slate-200 bg-white min-w-0 break-words">
                  <div className="text-slate-500">目標 +3h 點預測（90% 區間）</div>
                  <div className="text-lg font-bold font-mono-tabular text-[#0B63CE] mt-0.5">
                    {res.point_prediction ?? "—"}
                  </div>
                  <div className="font-mono-tabular text-slate-500">
                    [{res.prediction_interval?.lower ?? "—"} ～{" "}
                    {res.prediction_interval?.upper ?? "—"}]
                  </div>
                </div>
                <div className="p-3 rounded border border-slate-200 bg-white min-w-0 break-words">
                  <div className="text-slate-500">超過候選門檻 84 機率</div>
                  <div className="text-lg font-bold font-mono-tabular text-slate-900 mt-0.5">
                    {res.risk?.p_exceed !== undefined
                      ? `${(res.risk.p_exceed * 100).toFixed(1)}%`
                      : "—"}
                  </div>
                  <div className="text-slate-500">
                    風險等級：{res.risk?.risk_level ?? "—"}
                  </div>
                </div>
                <div className="p-3 rounded border border-slate-200 bg-white min-w-0 break-words">
                  <div className="text-slate-500">感測器可信度／簡單基準</div>
                  <div className="text-sm font-semibold text-slate-900 mt-0.5 break-words">
                    {res.sensor_reliability ?? "—"} · {res.handling ?? "—"}
                  </div>
                  <div className="font-mono-tabular text-slate-500 mt-0.5">
                    昨日同期：{res.references?.seasonal_naive_yesterday ?? "—"}
                  </div>
                </div>
              </div>

              {/* Risk reasons */}
              {res.risk?.risk_reasons && res.risk.risk_reasons.length > 0 && (
                <div className="p-3.5 rounded-md bg-slate-50 border border-slate-200 text-xs space-y-1 min-w-0 overflow-x-auto">
                  <div className="font-semibold text-slate-800">
                    模型輸出原因（候選門檻 84）
                  </div>
                  {res.risk.risk_reasons.map((reason, idx) => (
                    <div key={idx} className="text-slate-700 break-words">
                      • {reason}
                    </div>
                  ))}
                  {res.window_risk?.reasons?.map((r, idx) => (
                    <div key={`w-${idx}`} className="text-slate-600 break-words">
                      • 視窗風險（探索性）：{r}
                    </div>
                  ))}
                </div>
              )}

              {/* Replay Chart */}
              <div className="h-72 w-full min-w-0 overflow-x-auto">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart
                    data={chartData}
                    margin={{ top: 10, right: 16, left: 0, bottom: 8 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                    <XAxis
                      dataKey="asOf"
                      tick={{ fontSize: 11, fill: "#64748B" }}
                      minTickGap={24}
                    />
                    <YAxis
                      tick={{ fontSize: 11, fill: "#64748B" }}
                      width={48}
                      domain={["auto", "auto"]}
                    />
                    <Tooltip />
                    <ReferenceLine
                      y={84}
                      stroke="#D97706"
                      strokeDasharray="4 4"
                      label={{
                        value: "候選門檻 84（未確認）",
                        fontSize: 11,
                        fill: "#B45309",
                        position: "insideTopRight",
                      }}
                    />
                    <Area
                      type="monotone"
                      dataKey="bandRange"
                      name="90% 預測區間"
                      stroke="none"
                      fill="#0B63CE"
                      fillOpacity={0.14}
                    />
                    <Line
                      type="monotone"
                      dataKey="currentThi"
                      name="起點 THI"
                      stroke="#64748B"
                      strokeWidth={1.5}
                      dot={false}
                    />
                    <Line
                      type="monotone"
                      dataKey="pointPred"
                      name="+3h 點預測"
                      stroke="#0B63CE"
                      strokeWidth={2}
                      dot={false}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
        </section>
      </div>
    );
  }

  if (page === "sheep_diagnosis") {
    return (
      <div className="space-y-6 min-w-0">
        <section className="bg-white border border-slate-200 rounded-lg p-4 sm:p-5 space-y-4 min-w-0">
          <h1 className="text-xl font-bold text-slate-900 flex items-center gap-2 break-words">
            <Stethoscope className="h-5 w-5 text-[#0B63CE] shrink-0" />
            <span className="min-w-0">羊舍異常診斷（候選事件檢視，不是故障判定）</span>
          </h1>
          {sheepGuardBanner}

          {anomalies && anomalies.events.length > 0 ? (
            <div className="space-y-2.5 min-w-0">
              {anomalies.events.map((ev, idx) => (
                <div
                  key={idx}
                  className="p-3.5 rounded-md border border-amber-200 bg-amber-50/70 text-xs space-y-1 min-w-0 overflow-x-auto"
                >
                  <div className="font-semibold text-amber-950 break-words">
                    候選事件：{ev.kind_zh}（感測器 {ev.column}）
                  </div>
                  <div className="text-slate-700 break-words">{ev.note}</div>
                  <div className="font-mono-tabular text-slate-600 break-words">
                    起訖：{ev.start} ～ {ev.end}（{ev.hours} 小時）｜ 偵測器：
                    {ev.detector} ｜ 分數：{ev.score.toFixed(2)}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-xs text-slate-500">無異常事件。</div>
          )}
        </section>
      </div>
    );
  }

  // sheep_actions
  return (
    <div className="space-y-6 min-w-0">
      <section className="bg-white border border-slate-200 rounded-lg p-4 sm:p-5 space-y-4 min-w-0">
        <div className="flex flex-wrap items-center justify-between gap-2 min-w-0">
          <h1 className="text-xl font-bold text-slate-900 flex items-center gap-2 break-words">
            <SlidersHorizontal className="h-5 w-5 text-[#0B63CE] shrink-0" />
            <span className="min-w-0">羊舍處置決策與人工紀錄（M1 唯讀說明）</span>
          </h1>
          <span className="inline-flex items-center gap-1 text-xs text-slate-600 border border-slate-200 bg-slate-50 px-2.5 py-1 rounded shrink-0">
            <Lock className="h-3.5 w-3.5" />
            需要引擎寫入端點（M5）
          </span>
        </div>

        {sheepGuardBanner}

        <div className="p-4 rounded-md bg-slate-50 border border-slate-200 text-xs text-slate-700 space-y-2 min-w-0">
          <div className="font-semibold text-slate-900">
            人工決策紀錄操作規範
          </div>
          <p className="break-words">
            本平台僅提供人工檢查與決策建議紀錄功能；任何通風、遮陽、帆布或噴霧設備皆由現場人員依實際動物狀態決定並手動操作，系統不發送控制訊號。
          </p>
          <div className="pt-2 flex flex-wrap gap-2">
            <button
              type="button"
              disabled
              className="w-full sm:w-auto px-3.5 py-2 rounded-md bg-slate-200 text-slate-500 font-medium cursor-not-allowed"
            >
              記錄人員確認處置（尚未連線到 Python 引擎）
            </button>
          </div>
        </div>
      </section>
    </div>
  );
};
