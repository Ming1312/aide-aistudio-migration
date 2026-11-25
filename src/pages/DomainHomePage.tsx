import React, { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Calendar,
  CheckCircle2,
  Database,
  Download,
  FileCheck2,
  Info,
  Sparkles,
  Table2,
} from "lucide-react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceDot,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { MODEL_ORDER } from "../../contracts/types";
import type {
  AnomaliesResponse,
  DataKind,
  ForecastResponse,
  ModelKey,
  PrecomputedForecastTask,
  PrecomputedForecasts,
  RealDataset,
} from "../../contracts/types";
import { DataTableModal } from "../components/DataTableModal";
import {
  buildCsvDownloadText,
  detectTimeGaps,
  triggerCsvDownload,
} from "../lib/csv";
import {
  buildTrueTimeTrendSeries,
  formatChartTimeLabel,
  groupSensorsByUnit,
} from "../lib/trendChart";
import {
  fetchEngineForecast,
  loadRealCsv,
} from "../lib/dataLoader";
import { buildAnomalyFacts, buildForecastFacts } from "../lib/facts";
import type {
  ApiHealthStatus,
  ExplainModalPayload,
  PageId,
  ParsedCsvDataset,
} from "../types/app";

interface DomainHomePageProps {
  dataKind: DataKind;
  dataset: RealDataset;
  anomalies: AnomaliesResponse | undefined;
  precomputedForecasts: PrecomputedForecasts | null;
  health: ApiHealthStatus | null;
  onNavigate: (page: PageId) => void;
  onOpenExplain: (payload: ExplainModalPayload) => void;
}

const CHART_COLORS = ["#0B63CE", "#0EA5E9", "#D97706"];

const PERIOD_LABELS: Record<"t" | "v" | "h" | "l", string> = {
  t: "訓練期（樣本內，不是評估）",
  v: "驗證期",
  h: "留存測試期",
  l: "最新起點（尚無實際值）",
};

export const DomainHomePage: React.FC<DomainHomePageProps> = ({
  dataKind,
  dataset,
  anomalies,
  precomputedForecasts,
  health,
  onNavigate,
  onOpenExplain,
}) => {
  const [csvData, setCsvData] = useState<ParsedCsvDataset | null>(null);
  const [csvLoading, setCsvLoading] = useState(false);
  const [csvError, setCsvError] = useState<string | null>(null);

  // Trend controls
  const [selectedSensors, setSelectedSensors] = useState<string[]>([]);
  const [rangePreset, setRangePreset] = useState<"all" | "7d" | "3d" | "24h">("all");
  const [resolution, setResolution] = useState<"hourly" | "daily">("hourly");
  const [showGaps, setShowGaps] = useState(true);
  const [tableOpen, setTableOpen] = useState(false);

  // Forecast controls
  const domainTasks = useMemo(() => {
    if (!precomputedForecasts) return [] as Array<{ key: string; task: PrecomputedForecastTask }>;
    return Object.entries(precomputedForecasts.tasks)
      .filter(([, t]) => t.dataset_id === dataset.id)
      .map(([key, task]) => ({ key, task }));
  }, [precomputedForecasts, dataset.id]);

  const [selectedTaskKey, setSelectedTaskKey] = useState<string>("");
  const [originIndex, setOriginIndex] = useState<number>(0);

  // Optional live engine forecast override
  const [liveOriginInput, setLiveOriginInput] = useState("");
  const [liveForecast, setLiveForecast] = useState<ForecastResponse | null>(null);
  const [liveLoading, setLiveLoading] = useState(false);
  const [liveError, setLiveError] = useState<string | null>(null);

  useEffect(() => {
    setLiveForecast(null);
    setLiveError(null);
    if (domainTasks.length > 0) {
      setSelectedTaskKey(domainTasks[0].key);
      const pts = domainTasks[0].task.points;
      setOriginIndex(Math.max(0, pts.length - 1));
    } else {
      setSelectedTaskKey("");
      setOriginIndex(0);
    }
  }, [dataset.id, domainTasks]);

  useEffect(() => {
    let cancelled = false;
    setCsvLoading(true);
    setCsvError(null);
    loadRealCsv(dataset.id)
      .then((parsed) => {
        if (cancelled) return;
        setCsvData(parsed);
        const continuous = dataset.columns
          .filter((c) => c.measurement_kind !== "state_code")
          .map((c) => c.key)
          .filter((k) => parsed.sensorHeaders.includes(k));
        const defaults =
          continuous.length > 0
            ? continuous.slice(0, 2)
            : parsed.sensorHeaders.slice(0, 2);
        setSelectedSensors(defaults);
      })
      .catch((err) => {
        if (!cancelled) {
          setCsvError(err instanceof Error ? err.message : "載入 CSV 失敗");
        }
      })
      .finally(() => {
        if (!cancelled) setCsvLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [dataset.id, dataset.columns]);

  const filteredRows = useMemo(() => {
    if (!csvData) return [];
    const rows = csvData.rows;
    if (rangePreset === "all" || rows.length === 0) return rows;
    const hoursMap = { "7d": 168, "3d": 72, "24h": 24 };
    const count = hoursMap[rangePreset];
    return rows.slice(Math.max(0, rows.length - count));
  }, [csvData, rangePreset]);

  const gapReport = useMemo(() => detectTimeGaps(filteredRows), [filteredRows]);

  const unitBySensor = useMemo(() => {
    const map: Record<string, string> = {};
    for (const col of dataset.columns) {
      map[col.key] = col.unit;
    }
    return map;
  }, [dataset.columns]);

  const sensorUnitGroups = useMemo(
    () => groupSensorsByUnit(selectedSensors, unitBySensor),
    [selectedSensors, unitBySensor]
  );

  const trueTimeResult = useMemo(
    () =>
      buildTrueTimeTrendSeries(filteredRows, selectedSensors, resolution, 360),
    [filteredRows, selectedSensors, resolution]
  );

  const toggleSensor = (sensor: string) => {
    setSelectedSensors((prev) => {
      if (prev.includes(sensor)) {
        return prev.length > 1 ? prev.filter((s) => s !== sensor) : prev;
      }
      if (prev.length >= 3) {
        return [...prev.slice(1), sensor];
      }
      return [...prev, sensor];
    });
  };

  const handleDownloadTrendCsv = () => {
    if (!csvData) return;
    const text = buildCsvDownloadText(csvData, filteredRows);
    triggerCsvDownload(`${dataset.id}_real_view.csv`, text);
  };

  const activeTaskObj = domainTasks.find((t) => t.key === selectedTaskKey);
  const activeTask = activeTaskObj?.task ?? null;
  const activePoint = activeTask?.points[originIndex] ?? null;

  useEffect(() => {
    if (activeTask && originIndex >= activeTask.points.length) {
      setOriginIndex(Math.max(0, activeTask.points.length - 1));
    }
  }, [activeTask, originIndex]);

  const forecastHistoryChartData = useMemo(() => {
    if (!activeTask || !activePoint || !csvData) return [];
    const [origin, target, actual] = activePoint;
    const idx = csvData.rows.findIndex((r) => r.timestamp === origin);
    const historySlice =
      idx >= 0
        ? csvData.rows.slice(Math.max(0, idx - 23), idx + 1)
        : csvData.rows.slice(-24);
    const rows = historySlice.map((r) => ({
      time: r.timestamp.slice(5, 16),
      fullTime: r.timestamp,
      actual: r.values[activeTask.sensor] ?? null,
    }));
    rows.push({
      time: target.slice(5, 16),
      fullTime: target,
      actual: actual ?? null,
    });
    return rows;
  }, [activeTask, activePoint, csvData]);

  const handleLiveForecast = async () => {
    if (!activeTask || !health?.engine_connected) return;
    setLiveLoading(true);
    setLiveError(null);
    setLiveForecast(null);
    try {
      const resp = await fetchEngineForecast({
        dataset_id: dataset.id,
        sensor: activeTask.sensor,
        horizon_h: activeTask.horizon_h,
        origin: liveOriginInput.trim() || null,
        history_hours: 24,
      });
      setLiveForecast(resp);
    } catch (err) {
      setLiveForecast(null);
      setLiveError(err instanceof Error ? err.message : "引擎預測呼叫失敗");
    } finally {
      setLiveLoading(false);
    }
  };

  const tableRowsForModal = useMemo(
    () =>
      filteredRows.map((r) => {
        const out: Record<string, string | number | null> = {
          timestamp: r.timestamp,
        };
        for (const s of selectedSensors) {
          out[s] = r.values[s] ?? null;
        }
        out.__real = r.flagValue;
        return out;
      }),
    [filteredRows, selectedSensors]
  );

  const isNorthRefused = dataset.id === "rearing_plant_1_north";

  return (
    <div className="space-y-6">
      {/* Synthetic Notice if user switched dataKind to synthetic */}
      {dataKind === "synthetic" && (
        <div className="p-4 rounded-lg bg-amber-50 border border-amber-300 text-xs text-amber-950 flex flex-wrap items-center justify-between gap-2">
          <div>
            <strong>提醒：</strong>目前側邊欄資料類型為「合成展示」。場域看板僅展示真實感測資料與預計算輸出；若要操作合成 D1–D5 流程，請前往「資料更新」。
          </div>
          <button
            type="button"
            onClick={() => onNavigate("data_update")}
            className="font-semibold text-amber-900 underline"
          >
            前往資料更新（合成展示）→
          </button>
        </div>
      )}

      {/* Status Summary & KPI Strip */}
      <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-slate-900">
              {dataset.display_name}・場域看板
            </h1>
            <p className="text-sm text-slate-600 mt-1">
              {isNorthRefused
                ? "一句話狀態：資料量不足（約 387 列、連續區段短，最長缺口 1,597 小時），系統只提供資料探索與品質檢查，不建立預測模型。"
                : `一句話狀態：涵蓋 ${dataset.time.rows} 小時觀測資料（${dataset.time.start.slice(0, 10)} ～ ${dataset.time.end.slice(0, 10)}），偵測器共標出 ${anomalies?.n_events ?? 0} 筆候選事件待人工確認，已有 ${domainTasks.length} 項離線預計算預測任務。`}
            </p>
          </div>
          <button
            type="button"
            onClick={() => onNavigate("decision_support")}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-[#0B63CE] text-[#0B63CE] text-xs font-semibold hover:bg-blue-50"
          >
            前往此場域決策輔助
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2 border-t border-slate-100">
          <div className="p-3 rounded-md bg-slate-50 border border-slate-200">
            <div className="text-[11px] text-slate-500">資料列數（__real=1）</div>
            <div className="text-lg font-bold font-mono-tabular text-slate-900 mt-0.5">
              {dataset.time.rows}
            </div>
          </div>
          <div className="p-3 rounded-md bg-slate-50 border border-slate-200">
            <div className="text-[11px] text-slate-500">感測器欄位數</div>
            <div className="text-lg font-bold font-mono-tabular text-slate-900 mt-0.5">
              {dataset.columns.length}
            </div>
          </div>
          <div className="p-3 rounded-md bg-slate-50 border border-slate-200">
            <div className="text-[11px] text-slate-500">時間缺口（最長）</div>
            <div className="text-lg font-bold font-mono-tabular text-slate-900 mt-0.5">
              {dataset.time.n_gaps ?? 0} 段（{dataset.time.longest_gap_hours ?? 0}h）
            </div>
          </div>
          <div className="p-3 rounded-md bg-slate-50 border border-slate-200">
            <div className="text-[11px] text-slate-500">候選異常事件</div>
            <div className="text-lg font-bold font-mono-tabular text-slate-900 mt-0.5">
              {anomalies?.n_events ?? 0} 筆
            </div>
          </div>
        </div>
      </section>

      {/* Sensor Trend Section */}
      <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              感測器趨勢（最多選 3 個感測器）
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              圖表超過 360 點時採均勻降採樣以維持流暢；「查看表格」與「下載 CSV」一律使用完整原始數值（保留{" "}
              <code className="font-mono-tabular">__real</code> 欄）。
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={!csvData}
              onClick={() => setTableOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-slate-300 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              <Table2 className="h-3.5 w-3.5" />
              查看表格
            </button>
            <button
              type="button"
              disabled={!csvData}
              onClick={handleDownloadTrendCsv}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[#0B63CE] text-white text-xs font-medium hover:bg-[#0952AD] disabled:opacity-50"
            >
              <Download className="h-3.5 w-3.5" />
              下載 CSV（含 __real）
            </button>
            <button
              type="button"
              onClick={() => onNavigate("provenance")}
              className="inline-flex items-center gap-1 text-xs font-medium text-[#0B63CE] hover:underline px-1.5"
            >
              <FileCheck2 className="h-3.5 w-3.5" />
              資料來源與使用聲明
            </button>
          </div>
        </div>

        {/* Single-row Filter Bar */}
        <div className="p-3 rounded-md bg-slate-50 border border-slate-200 flex flex-wrap items-center gap-3 text-xs min-w-0">
          <div className="w-full sm:w-auto flex flex-col sm:flex-row sm:items-center gap-1.5 min-w-0">
            <div className="flex items-center gap-1.5 shrink-0">
              <Calendar className="h-3.5 w-3.5 text-slate-400" />
              <span className="text-slate-600 font-medium">時間範圍：</span>
            </div>
            <select
              value={rangePreset}
              onChange={(e) =>
                setRangePreset(e.target.value as "all" | "7d" | "3d" | "24h")
              }
              className="w-full sm:w-auto max-w-full min-w-0 rounded border border-slate-300 bg-white px-2 py-1 text-slate-800"
            >
              <option value="all">全部期間（{csvData?.rows.length ?? dataset.time.rows} 列）</option>
              <option value="7d">最近 7 天（168 小時）</option>
              <option value="3d">最近 3 天（72 小時）</option>
              <option value="24h">最近 24 小時</option>
            </select>
          </div>

          <div className="w-full sm:w-auto flex flex-col sm:flex-row sm:items-center gap-1.5 min-w-0">
            <span className="text-slate-600 font-medium shrink-0">解析度：</span>
            <select
              value={resolution}
              onChange={(e) =>
                setResolution(e.target.value as "hourly" | "daily")
              }
              className="w-full sm:w-auto max-w-full min-w-0 rounded border border-slate-300 bg-white px-2 py-1 text-slate-800"
            >
              <option value="hourly">每小時</option>
              <option value="daily">日平均</option>
            </select>
          </div>

          <label className="inline-flex items-center gap-1.5 cursor-pointer text-slate-700">
            <input
              type="checkbox"
              checked={showGaps}
              onChange={(e) => setShowGaps(e.target.checked)}
              className="rounded border-slate-300 text-[#0B63CE]"
            />
            標示時間缺口（目前區間 {gapReport.nGaps} 段）
          </label>
        </div>

        {/* Sensor Selection Checkboxes (<=3) */}
        {csvData && (
          <div className="flex flex-wrap gap-1.5">
            {csvData.sensorHeaders.slice(0, 18).map((s) => {
              const active = selectedSensors.includes(s);
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => toggleSensor(s)}
                  className={`px-2.5 py-1 rounded text-xs border transition-colors ${
                    active
                      ? "bg-[#0B63CE] text-white border-[#0B63CE] font-medium"
                      : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50"
                  }`}
                >
                  {s}
                </button>
              );
            })}
            {csvData.sensorHeaders.length > 18 && (
              <button
                type="button"
                onClick={() => onNavigate("explorer")}
                className="px-2.5 py-1 rounded text-xs text-[#0B63CE] hover:underline"
              >
                全部 {csvData.sensorHeaders.length} 欄請見「資料探索」→
              </button>
            )}
          </div>
        )}

        {/* Chart Area (strictly grouped by unit, true time scale, explicit gap breaks) */}
        {csvLoading ? (
          <div className="h-64 flex items-center justify-center text-xs text-slate-500">
            正在載入 {dataset.display_name} 感測資料…
          </div>
        ) : csvError ? (
          <div className="p-4 rounded bg-rose-50 border border-rose-200 text-xs text-rose-700">
            {csvError}
          </div>
        ) : trueTimeResult.points.length === 0 || sensorUnitGroups.length === 0 ? (
          <div className="h-64 flex items-center justify-center text-xs text-slate-500">
            請至少選擇一個感測器。
          </div>
        ) : (
          <div className="space-y-4 min-w-0" data-testid="domain-trend-charts">
            {sensorUnitGroups.length > 1 && (
              <div className="text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded px-3 py-2">
                已選擇不同單位的感測器，系統依單位拆分為{" "}
                <strong>{sensorUnitGroups.length}</strong> 張獨立小圖上下排列（不使用雙 Y 軸）；時間軸依實際時間比例繪製，缺口處直接斷開。
              </div>
            )}

            {sensorUnitGroups.map((group) => (
              <div
                key={group.unit}
                className="p-3 rounded-md border border-slate-200 bg-white space-y-2 min-w-0"
                data-unit-chart={group.unit}
              >
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="font-semibold text-slate-800">
                    單位：{group.unit}（推測）
                  </span>
                  <span className="text-slate-500 break-words">
                    感測器：{group.sensors.join("、")}
                  </span>
                </div>

                <div
                  className={`${
                    sensorUnitGroups.length > 1 ? "h-56" : "h-72"
                  } w-full min-w-0`}
                >
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart
                      data={trueTimeResult.points}
                      margin={{ top: 8, right: 16, left: 0, bottom: 8 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                      <XAxis
                        dataKey="tsMs"
                        type="number"
                        scale="time"
                        domain={trueTimeResult.domain ?? ["auto", "auto"]}
                        tick={{ fontSize: 11, fill: "#64748B" }}
                        tickFormatter={(ts: number) =>
                          formatChartTimeLabel(Number(ts), resolution)
                        }
                        minTickGap={32}
                      />
                      <YAxis
                        tick={{ fontSize: 11, fill: "#64748B" }}
                        width={56}
                        domain={["auto", "auto"]}
                      />
                      <Tooltip
                        labelFormatter={(ts) =>
                          formatChartTimeLabel(Number(ts), resolution, true)
                        }
                        contentStyle={{
                          fontSize: "12px",
                          borderColor: "#CBD5E1",
                          borderRadius: "6px",
                        }}
                      />
                      <Legend wrapperStyle={{ fontSize: "12px" }} />
                      {showGaps &&
                        trueTimeResult.gaps.map((gap, gIdx) => (
                          <ReferenceArea
                            key={`${gap.startMs}-${gIdx}`}
                            x1={gap.startMs}
                            x2={gap.endMs}
                            fill="#F59E0B"
                            fillOpacity={0.14}
                            stroke="#D97706"
                            strokeDasharray="3 3"
                            strokeOpacity={0.5}
                          />
                        ))}
                      {group.sensors.map((s) => {
                        const colorIdx = selectedSensors.indexOf(s);
                        const color =
                          CHART_COLORS[
                            (colorIdx >= 0 ? colorIdx : 0) % CHART_COLORS.length
                          ];
                        return (
                          <Line
                            key={s}
                            type="monotone"
                            dataKey={s}
                            name={`${s} (${group.unit})`}
                            stroke={color}
                            strokeWidth={1.8}
                            dot={false}
                            connectNulls={false}
                            isAnimationActive={false}
                          />
                        );
                      })}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
            ))}
          </div>
        )}

        {showGaps && gapReport.nGaps > 0 && (
          <div className="p-3 rounded-md bg-amber-50 border border-amber-200 text-xs text-amber-900 space-y-1">
            <div className="font-semibold">
              此時間範圍偵測到 {gapReport.nGaps} 段時間缺口（共缺 {gapReport.totalMissingHours} 小時，最長 {gapReport.longestGapHours} 小時）：
            </div>
            <div className="font-mono-tabular">
              {gapReport.segments.slice(0, 4).map((g, i) => (
                <span key={i} className="mr-3 inline-block">
                  {g.start} → {g.end}（缺 {g.missingHours}h）
                </span>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* Candidate Anomaly Cards */}
      <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              異常分析（候選事件，不是故障判定）
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              {anomalies?.disclaimer || "統計偵測器標出與歷史行為不同的區段，不是設備故障判定。"}｜注意：異常區段「起點與持續時間是演算法估計值」。
            </p>
          </div>
          {anomalies && (
            <button
              type="button"
              onClick={() =>
                onOpenExplain({
                  title: `${dataset.display_name}・候選異常白話解釋`,
                  request: {
                    kind: "anomaly",
                    data_kind: "real",
                    dataset_id: dataset.id,
                    facts: buildAnomalyFacts(anomalies),
                  },
                })
              }
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-slate-300 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              <Sparkles className="h-3.5 w-3.5 text-[#0B63CE]" />
              用白話解釋異常
            </button>
          )}
        </div>

        {!anomalies || anomalies.events.length === 0 ? (
          <div className="p-4 rounded-md bg-slate-50 border border-slate-200 text-xs text-slate-600">
            此場域在離線偵測輸出中沒有標出候選異常事件。
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {anomalies.events.slice(0, 6).map((ev, i) => (
              <div
                key={i}
                className="p-3.5 rounded-md border border-amber-200 bg-amber-50/60 text-xs space-y-1.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-amber-950 flex items-center gap-1.5">
                    <AlertTriangle className="h-3.5 w-3.5 text-amber-700" />
                    {ev.kind_zh}：{ev.column}
                  </span>
                  <span className="text-[11px] font-medium text-amber-800">
                    候選事件・起點是估計值
                  </span>
                </div>
                <div className="text-slate-700">{ev.note}</div>
                <div className="font-mono-tabular text-slate-600 pt-1 border-t border-amber-200/70">
                  起訖：{ev.start} ～ {ev.end} ｜ 持續：{ev.hours} 小時 ｜
                  偵測器：{ev.detector} ｜ 分數：{ev.score.toFixed(2)}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Forecast & 6-Model Comparison Section */}
      <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              歷史時點模擬預測與六模型並排比較
            </h2>
            {precomputedForecasts && !isNorthRefused && (
              <div className="text-xs text-slate-600 mt-1 flex items-center gap-1.5">
                <Database className="h-3.5 w-3.5 text-[#0B63CE]" />
                <span>
                  預計算（離線）：Python 引擎的真實輸出，產生於{" "}
                  <span className="font-mono-tabular">
                    {precomputedForecasts.meta.generated_at}
                  </span>
                  ；只涵蓋每個任務最近 168 個預測起點；不是即時
                </span>
              </div>
            )}
          </div>

          {!isNorthRefused && activeTask && (
            <button
              type="button"
              onClick={() =>
                onOpenExplain({
                  title: `${dataset.display_name}・${activeTask.sensor} (+${activeTask.horizon_h}h) 預測白話解釋`,
                  request: {
                    kind: "forecast",
                    data_kind: "real",
                    dataset_id: dataset.id,
                    facts: buildForecastFacts(activeTask, originIndex, dataset.id),
                  },
                })
              }
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-slate-300 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              <Sparkles className="h-3.5 w-3.5 text-[#0B63CE]" />
              用白話解釋預測比較
            </button>
          )}
        </div>

        {isNorthRefused ? (
          <div className="p-4 rounded-md bg-slate-50 border border-slate-200 text-sm text-slate-700 space-y-1.5">
            <div className="font-semibold text-slate-900 flex items-center gap-2">
              <Info className="h-4 w-4 text-slate-500" />
              育成一廠北側：資料太少（約 387 列、連續區段短），系統不建立模型
            </div>
            <p className="text-xs text-slate-600">
              依資料門檻政策，本場域不提供任何預計算或即時預測，也不進行模型比較或強制補值。請使用「資料探索與分析」或「決策輔助」檢視資料品質與人工檢查建議。
            </p>
          </div>
        ) : !activeTask || !activePoint ? (
          <div className="p-4 rounded-md bg-slate-50 border border-slate-200 text-xs text-slate-600">
            載入預計算預測資料中…
          </div>
        ) : (
          <div className="space-y-4">
            {/* Task & Origin Selectors */}
            <div className="p-3.5 rounded-md bg-slate-50 border border-slate-200 grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
              <div>
                <label className="block font-medium text-slate-600 mb-1">
                  選擇預測任務（感測器 × 時距）
                </label>
                <select
                  value={selectedTaskKey}
                  onChange={(e) => {
                    const nextKey = e.target.value;
                    setSelectedTaskKey(nextKey);
                    const found = domainTasks.find((t) => t.key === nextKey);
                    if (found) {
                      setOriginIndex(Math.max(0, found.task.points.length - 1));
                    }
                    setLiveForecast(null);
                  }}
                  className="w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 text-slate-800"
                >
                  {domainTasks.map(({ key, task }) => (
                    <option key={key} value={key}>
                      {task.sensor}（+{task.horizon_h} 小時｜單位：{task.unit} 推測）
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block font-medium text-slate-600 mb-1">
                  選擇預計算起點（最近 {activeTask.points.length} 個起點）
                </label>
                <select
                  value={originIndex}
                  onChange={(e) => setOriginIndex(Number(e.target.value))}
                  className="w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 font-mono-tabular text-slate-800"
                >
                  {activeTask.points.map((pt, idx) => (
                    <option key={pt[0]} value={idx}>
                      {pt[0]} → {pt[1]}（{PERIOD_LABELS[pt[3]]}）
                    </option>
                  ))}
                </select>
              </div>

              {/* Arbitrary origin engine action (disabled when offline) */}
              <div className="md:col-span-2 pt-2 border-t border-slate-200 flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="text"
                    value={liveOriginInput}
                    onChange={(e) => setLiveOriginInput(e.target.value)}
                    disabled={!health?.engine_connected}
                    placeholder="任意起點 YYYY-MM-DD HH:MM:SS（需引擎連線）"
                    className="rounded border border-slate-300 bg-white px-2.5 py-1 font-mono-tabular text-xs w-full sm:w-64 max-w-full disabled:bg-slate-100 disabled:text-slate-400"
                  />
                  <button
                    type="button"
                    disabled={!health?.engine_connected || liveLoading}
                    onClick={handleLiveForecast}
                    className="px-3 py-1 rounded bg-[#0B63CE] text-white font-medium disabled:bg-slate-300 disabled:text-slate-600"
                  >
                    {liveLoading ? "引擎計算中…" : "任意起點即時查詢"}
                  </button>
                </div>
                {!health?.engine_connected && (
                  <span className="text-slate-500">
                    需要連線 Python 引擎才可查詢非預計算起點（目前展示離線預計算輸出）。
                  </span>
                )}
              </div>
              {liveError && (
                <div className="md:col-span-2 text-rose-700">{liveError}</div>
              )}
              {liveForecast && (
                <div className="md:col-span-2 p-2.5 rounded bg-emerald-50 border border-emerald-200 text-emerald-900">
                  已取得引擎即時回應（起點 {liveForecast.forecast_origin}，來源：{liveForecast.source}）。
                </div>
              )}
            </div>

            {/* Selected Origin Metadata */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
              <div className="p-3 rounded border border-slate-200 bg-white">
                <div className="text-slate-500">預測起點 → 目標時間</div>
                <div className="font-mono-tabular font-semibold text-slate-900 mt-0.5">
                  {activePoint[0]}
                  <br />→ {activePoint[1]}
                </div>
              </div>
              <div className="p-3 rounded border border-slate-200 bg-white">
                <div className="text-slate-500">起點所屬期間</div>
                <div className="font-semibold text-slate-900 mt-0.5">
                  {PERIOD_LABELS[activePoint[3]]}
                </div>
              </div>
              <div className="p-3 rounded border border-slate-200 bg-white">
                <div className="text-slate-500">事後實際值（若已揭曉）</div>
                <div className="font-mono-tabular font-semibold text-slate-900 mt-0.5">
                  {activePoint[2] !== null
                    ? `${activePoint[2]} ${activeTask.unit}`
                    : "尚未揭曉（最新起點）"}
                </div>
              </div>
              <div className="p-3 rounded border border-slate-200 bg-white">
                <div className="text-slate-500">最佳簡單基準／研究狀態</div>
                <div className="font-semibold text-slate-900 mt-0.5">
                  {activeTask.model_names[activeTask.best_baseline] ??
                    activeTask.best_baseline}
                  <div className="text-[11px] font-normal text-slate-500 mt-0.5">
                    研究預測（探索性），不是獨立驗證
                  </div>
                </div>
              </div>
            </div>

            {/* 6-Model Side-by-Side Comparison Table */}
            <div className="overflow-x-auto border border-slate-200 rounded-md">
              <table className="min-w-full text-xs border-collapse">
                <thead className="bg-slate-50 border-b border-slate-200 text-slate-700">
                  <tr>
                    <th className="px-3 py-2 text-left font-semibold">模型方法</th>
                    <th className="px-3 py-2 text-right font-semibold">
                      點預測值（{activeTask.unit}，推測）
                    </th>
                    <th className="px-3 py-2 text-left font-semibold">
                      探索性 90% 區間（僅 h／l 顯示）
                    </th>
                    <th className="px-3 py-2 text-right font-semibold">
                      驗證期 MAE (n)
                    </th>
                    <th className="px-3 py-2 text-right font-semibold">
                      留存測試期 MAE (n)
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {MODEL_ORDER.map((mKey: ModelKey, mIdx) => {
                    const predVal = activePoint[4 + mIdx] as number | null;
                    const periodCode = activePoint[3];
                    const refusedReason =
                      predVal === null
                        ? activeTask.refused_at_latest?.[mKey] ||
                          "資料條件不足或未通過資格條件，引擎拒絕輸出（不補值）"
                        : null;
                    const metric = activeTask.metrics[mKey];
                    const isMl = mKey === "HGB" || mKey === "XGB";
                    const intervalInfo = isMl
                      ? activeTask.interval[mKey as "HGB" | "XGB"]
                      : null;
                    const showInterval =
                      isMl &&
                      predVal !== null &&
                      (periodCode === "h" || periodCode === "l") &&
                      intervalInfo?.available &&
                      intervalInfo.q !== null;

                    return (
                      <tr key={mKey} className="hover:bg-slate-50/70">
                        <td className="px-3 py-2 font-medium text-slate-900">
                          {activeTask.model_names[mKey] ?? mKey}
                          {mKey === activeTask.best_baseline && (
                            <span className="ml-1.5 text-[11px] text-[#0B63CE]">
                              （最佳簡單基準）
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right font-mono-tabular">
                          {predVal !== null ? (
                            <span className="font-semibold text-slate-900">
                              {predVal.toFixed(4)}
                            </span>
                          ) : (
                            <span className="text-rose-700 font-sans">
                              拒絕輸出：{refusedReason}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-slate-600 font-mono-tabular">
                          {!isMl ? (
                            <span className="text-slate-400 font-sans">基準法無區間</span>
                          ) : showInterval && intervalInfo?.q !== null && predVal !== null ? (
                            <span>
                              [{(predVal - intervalInfo.q).toFixed(3)} ～{" "}
                              {(predVal + intervalInfo.q).toFixed(3)}]{" "}
                              <span className="font-sans text-[11px] text-amber-800">
                                （±{intervalInfo.q.toFixed(3)}・尚未獨立驗證）
                              </span>
                            </span>
                          ) : (
                            <span className="font-sans text-slate-500">
                              {periodCode === "t" || periodCode === "v"
                                ? "訓練／驗證期不顯示（避免樣本內樂觀偏差）"
                                : "此任務無可用區間"}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right font-mono-tabular text-slate-700">
                          {metric?.validation
                            ? `${metric.validation.MAE.toFixed(4)} (${metric.validation.n})`
                            : "—"}
                        </td>
                        <td className="px-3 py-2 text-right font-mono-tabular text-slate-700">
                          {metric?.holdout
                            ? `${metric.holdout.MAE.toFixed(4)} (${metric.holdout.n})`
                            : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* HGB / XGB Exploratory Evidence */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
              {(["HGB", "XGB"] as const).map((mlKey) => (
                <div
                  key={mlKey}
                  className="p-3 rounded-md bg-slate-50 border border-slate-200 space-y-1"
                >
                  <div className="font-semibold text-slate-800 flex items-center gap-1.5">
                    <CheckCircle2 className="h-3.5 w-3.5 text-[#0B63CE]" />
                    {activeTask.model_names[mlKey]} 探索性證據文字（規則式，非 LLM）
                  </div>
                  <p className="text-slate-700 leading-relaxed">
                    {activeTask.evidence[mlKey]}
                  </p>
                </div>
              ))}
            </div>

            {/* History + 6 Model Points Chart */}
            {forecastHistoryChartData.length > 0 && (
              <div className="pt-2">
                <div className="text-xs font-medium text-slate-600 mb-2">
                  最近 24 小時實際值與目標時刻（{activePoint[1]}）六模型預測對照圖
                </div>
                <div className="h-64 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart
                      data={forecastHistoryChartData}
                      margin={{ top: 10, right: 20, left: 0, bottom: 8 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                      <XAxis
                        dataKey="time"
                        tick={{ fontSize: 11, fill: "#64748B" }}
                        minTickGap={20}
                      />
                      <YAxis
                        tick={{ fontSize: 11, fill: "#64748B" }}
                        width={52}
                        domain={["auto", "auto"]}
                      />
                      <Tooltip />
                      <Line
                        type="monotone"
                        dataKey="actual"
                        name="實際觀測值"
                        stroke="#0F172A"
                        strokeWidth={2}
                        dot={{ r: 2.5 }}
                        connectNulls={false}
                      />
                      {MODEL_ORDER.map((mKey, mIdx) => {
                        const val = activePoint[4 + mIdx] as number | null;
                        if (val === null) return null;
                        const colors = [
                          "#64748B",
                          "#94A3B8",
                          "#0EA5E9",
                          "#10B981",
                          "#0B63CE",
                          "#D97706",
                        ];
                        return (
                          <ReferenceDot
                            key={mKey}
                            x={activePoint[1].slice(5, 16)}
                            y={val}
                            r={5}
                            fill={colors[mIdx]}
                            stroke="#FFFFFF"
                            strokeWidth={1.5}
                          />
                        );
                      })}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      <DataTableModal
        open={tableOpen}
        onClose={() => setTableOpen(false)}
        title={`${dataset.display_name}・感測資料表格（含 __real）`}
        subtitle="表格與下載皆使用未降採樣之完整資料，保留原始時間戳記與 __real=1 標記"
        columns={["timestamp", ...selectedSensors, "__real"]}
        rows={tableRowsForModal}
        onDownloadCsv={handleDownloadTrendCsv}
      />
    </div>
  );
};
