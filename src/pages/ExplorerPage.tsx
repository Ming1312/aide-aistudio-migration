import React, { useEffect, useMemo, useState } from "react";
import {
  Clock,
  Download,
  FileCheck2,
  Sparkles,
  Table2,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { RealDataset } from "../../contracts/types";
import { DataTableModal } from "../components/DataTableModal";
import {
  buildCsvDownloadText,
  computeColumnStats,
  computeDiurnalProfile,
  computeHistogram,
  computePearsonMatrix,
  detectTimeGaps,
  downsampleSeries,
  triggerCsvDownload,
} from "../lib/csv";
import type { ColumnStats } from "../lib/csv";
import { loadRealCsv } from "../lib/dataLoader";
import { buildExplorerFacts } from "../lib/facts";
import type {
  ExplainModalPayload,
  PageId,
  ParsedCsvDataset,
  ParsedCsvRow,
} from "../types/app";

type AnalysisType =
  | "overview"
  | "quality"
  | "stats"
  | "trend"
  | "distribution"
  | "daily_cycle"
  | "correlation"
  | "runs";

const ANALYSIS_TABS: Array<{ id: AnalysisType; label: string }> = [
  { id: "overview", label: "概況" },
  { id: "quality", label: "品質" },
  { id: "stats", label: "描述統計" },
  { id: "trend", label: "趨勢" },
  { id: "distribution", label: "分布直方圖" },
  { id: "daily_cycle", label: "日週期" },
  { id: "correlation", label: "相關" },
  { id: "runs", label: "缺口・零值・卡值標示" },
];

interface ExplorerPageProps {
  dataset: RealDataset;
  onNavigate: (page: PageId) => void;
  onOpenExplain: (payload: ExplainModalPayload) => void;
}

export const ExplorerPage: React.FC<ExplorerPageProps> = ({
  dataset,
  onNavigate,
  onOpenExplain,
}) => {
  const [viewMode, setViewMode] = useState<"analysis" | "columns">("analysis");
  const [analysisType, setAnalysisType] = useState<AnalysisType>("trend");
  const [selectedSensors, setSelectedSensors] = useState<string[]>([]);
  const [startIdx, setStartIdx] = useState(0);
  const [endIdx, setEndIdx] = useState(0);
  const [csvData, setCsvData] = useState<ParsedCsvDataset | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tableOpen, setTableOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const loadPromise = loadRealCsv(dataset.id);

    loadPromise
      .then((parsed) => {
        if (cancelled) return;
        setCsvData(parsed);
        setStartIdx(0);
        setEndIdx(Math.max(0, parsed.rows.length - 1));
        const continuous = dataset.columns
          .filter((c) => c.measurement_kind !== "state_code")
          .map((c) => c.key)
          .filter((k) => parsed.sensorHeaders.includes(k));
        const initial =
          continuous.length > 0
            ? continuous.slice(0, 3)
            : parsed.sensorHeaders.slice(0, 3);
        setSelectedSensors(initial);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "載入資料失敗");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [dataset.id, dataset.columns]);

  const slicedRows = useMemo(() => {
    if (!csvData || csvData.rows.length === 0) return [];
    const lo = Math.max(0, Math.min(startIdx, endIdx));
    const hi = Math.min(csvData.rows.length - 1, Math.max(startIdx, endIdx));
    return csvData.rows.slice(lo, hi + 1);
  }, [csvData, startIdx, endIdx]);

  const gapReport = useMemo(() => detectTimeGaps(slicedRows), [slicedRows]);

  const columnMetaMap = useMemo(() => {
    const m = new Map<string, RealDataset["columns"][number]>();
    for (const c of dataset.columns) m.set(c.key, c);
    return m;
  }, [dataset.columns]);

  const unitsMap = useMemo(() => {
    const out: Record<string, string> = {};
    for (const c of dataset.columns) out[c.key] = c.unit;
    return out;
  }, [dataset.columns]);

  const selectedStats: ColumnStats[] = useMemo(
    () => selectedSensors.map((s) => computeColumnStats(slicedRows, s)),
    [slicedRows, selectedSensors]
  );

  const allColumnStats: ColumnStats[] = useMemo(() => {
    if (!csvData) return [];
    return csvData.sensorHeaders.map((s) => computeColumnStats(slicedRows, s));
  }, [csvData, slicedRows]);

  const primarySensor = selectedSensors[0] ?? csvData?.sensorHeaders[0] ?? "";

  const trendChartData = useMemo(() => {
    const sampled = downsampleSeries(slicedRows, 360);
    return sampled.map((r) => {
      const obj: Record<string, string | number | null> = {
        timestamp: r.timestamp.slice(5, 16),
      };
      for (const s of selectedSensors) {
        obj[s] = r.values[s] ?? null;
      }
      return obj;
    });
  }, [slicedRows, selectedSensors]);

  const histogramData = useMemo(
    () => (primarySensor ? computeHistogram(slicedRows, primarySensor, 12) : []),
    [slicedRows, primarySensor]
  );

  const diurnalData = useMemo(
    () =>
      selectedSensors.length > 0
        ? computeDiurnalProfile(slicedRows, selectedSensors)
        : [],
    [slicedRows, selectedSensors]
  );

  const correlationData = useMemo(() => {
    const list =
      selectedSensors.length >= 2
        ? selectedSensors
        : csvData?.sensorHeaders.slice(0, 6) ?? [];
    return computePearsonMatrix(slicedRows, list);
  }, [slicedRows, selectedSensors, csvData]);

  // Rule-based 4-part explanation computed strictly from actual numbers (no Gemini fabrication)
  const fourPartInsight = useMemo(() => {
    const first = selectedStats[0];
    const startTs = slicedRows[0]?.timestamp ?? "-";
    const endTs = slicedRows[slicedRows.length - 1]?.timestamp ?? "-";
    const unit = first ? unitsMap[first.sensor] ?? "" : "";
    const totalMissing = allColumnStats.reduce((a, b) => a + b.missing, 0);
    const totalCells = allColumnStats.reduce((a, b) => a + b.totalRows, 0);
    const overallMissPct = totalCells > 0 ? (totalMissing / totalCells) * 100 : 0;

    let observed = `在 ${startTs} 到 ${endTs} 共 ${slicedRows.length} 筆資料中，平均缺漏率為 ${overallMissPct.toFixed(2)}%，時間缺口 ${gapReport.nGaps} 段（最長 ${gapReport.longestGapHours} 小時）。`;
    if (first && first.mean !== null && first.min !== null && first.max !== null) {
      observed += ` 主選感測器「${first.sensor}」有效 ${first.observed} 筆，範圍 ${first.min.toFixed(3)} ～ ${first.max.toFixed(3)} ${unit}（平均 ${first.mean.toFixed(3)}、標準差 ${(first.std ?? 0).toFixed(3)}；最長連續卡值 ${first.longestFlatlineHours} 小時）。`;
    }

    const meaningMap: Record<AnalysisType, string> = {
      overview: "反映該期間資料的完整度與整體涵蓋範圍；可先確認是否存在整段斷線或未記錄小時。",
      quality: "缺漏、零值與卡值可能是感測器休眠／停機／傳輸中斷，也可能是正常低負載狀態。",
      stats: "平均數與分位數呈現一般作業區間；標準差較大時表示該時段波動顯著。",
      trend: "趨勢線的起伏反映時序變化；空白斷裂處表示原始資料本身為空或時間跳號。",
      distribution: "直方圖呈現各數值區間的出現次數，雙峰或長尾通常對應日夜或不同負載階段。",
      daily_cycle: "24 小時平均輪廓反映日夜週期性變化（例如日照、氣溫或作業排程影響）。",
      correlation: "線性相關係數只描述兩感測器同向或反向變化的程度，不代表因果關係。",
      runs: "長時間零值與非零卡值屬於品質檢核線索，代表讀值固定不變的時數。",
    };

    const cannotProve =
      "目前僅憑這組時序數字，無法證明設備是否真的故障、無法確定單位推論是否 100% 符合現場儀器設定、也無法將關聯性直接視為因果或推論未來走向。";

    const nextStep =
      gapReport.nGaps > 0 || (first && first.longestFlatlineHours >= 6)
        ? "建議先至「缺口・零值・卡值標示」與「欄位說明」確認時間缺口與卡值時段是否對應現場停機／校正作業，再決定後續分析或人工複測。"
        : "可切換至「日週期」或「相關」交叉觀察感測器同步性，並搭配「場域看板」與「決策輔助」檢視既有離線引擎建議。";

    return {
      observed,
      meaning: meaningMap[analysisType],
      cannotProve,
      nextStep,
    };
  }, [
    selectedStats,
    allColumnStats,
    slicedRows,
    gapReport,
    analysisType,
    unitsMap,
  ]);

  const toggleSensor = (s: string) => {
    setSelectedSensors((prev) =>
      prev.includes(s) ? (prev.length > 1 ? prev.filter((x) => x !== s) : prev) : [...prev, s]
    );
  };

  const handleDownloadSliceCsv = () => {
    if (!csvData) return;
    const text = buildCsvDownloadText(csvData, slicedRows);
    triggerCsvDownload(
      `${dataset.id}_real_explorer.csv`,
      text
    );
  };

  const tableRowsForModal = useMemo(
    () =>
      slicedRows.map((r) => {
        const out: Record<string, string | number | null> = {
          timestamp: r.timestamp,
        };
        for (const s of selectedSensors) out[s] = r.values[s] ?? null;
        out[csvData?.flagColumn ?? "__real"] = r.flagValue;
        return out;
      }),
    [slicedRows, selectedSensors, csvData]
  );

  const colors = ["#0B63CE", "#0EA5E9", "#D97706", "#10B981", "#6366F1"];

  return (
    <div className="space-y-6">
      {/* Header + View Switch */}
      <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-slate-900">
              資料探索與分析：{dataset.display_name}
            </h1>
            <p className="text-xs text-slate-600 mt-1">
              所有統計數字皆於瀏覽器直接對目前{" "}
              <strong>真實資料（__real=1）</strong>{" "}
              計算；不使用 Gemini 產生任何數字或預測。
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-md border border-slate-200 bg-slate-100 p-0.5 text-xs">
              <button
                type="button"
                onClick={() => setViewMode("analysis")}
                className={`px-3 py-1.5 rounded font-medium ${
                  viewMode === "analysis"
                    ? "bg-white text-slate-900 shadow-xs"
                    : "text-slate-600"
                }`}
              >
                圖表與統計分析
              </button>
              <button
                type="button"
                onClick={() => setViewMode("columns")}
                className={`px-3 py-1.5 rounded font-medium ${
                  viewMode === "columns"
                    ? "bg-white text-slate-900 shadow-xs"
                    : "text-slate-600"
                }`}
              >
                欄位說明（{dataset.columns.length} 欄）
              </button>
            </div>

            <button
              type="button"
              disabled={!csvData || slicedRows.length === 0}
              onClick={() =>
                onOpenExplain({
                  title: `${dataset.display_name}・資料探索白話解釋`,
                  request: {
                    kind: "data",
                    data_kind: "real",
                    dataset_id: dataset.id,
                    facts: buildExplorerFacts(
                      dataset.display_name,
                      slicedRows[0]?.timestamp ?? "-",
                      slicedRows[slicedRows.length - 1]?.timestamp ?? "-",
                      slicedRows.length,
                      selectedStats,
                      unitsMap,
                      gapReport.nGaps,
                      gapReport.longestGapHours
                    ),
                  },
                })
              }
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-slate-300 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              <Sparkles className="h-3.5 w-3.5 text-[#0B63CE]" />
              用白話解釋
            </button>
          </div>
        </div>

        {/* 時間資訊面板 */}
        <div className="p-3.5 rounded-md bg-slate-50 border border-slate-200 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
          <div>
            <div className="text-slate-500 flex items-center gap-1">
              <Clock className="h-3.5 w-3.5" />
              資料期間（目前檢視）
            </div>
            <div className="font-mono-tabular font-medium text-slate-900 mt-0.5">
              {slicedRows[0]?.timestamp ?? "-"} ～{" "}
              {slicedRows[slicedRows.length - 1]?.timestamp ?? "-"}
            </div>
          </div>
          <div>
            <div className="text-slate-500">取樣頻率／列數</div>
            <div className="font-mono-tabular font-medium text-slate-900 mt-0.5">
              {dataset.time.sampling} · {slicedRows.length} 列
            </div>
          </div>
          <div>
            <div className="text-slate-500">時間缺口數／最長缺口</div>
            <div className="font-mono-tabular font-medium text-slate-900 mt-0.5">
              {gapReport.nGaps} 段 · 最長 {gapReport.longestGapHours} 小時
            </div>
          </div>
          <div>
            <div className="text-slate-500">時間戳記時區</div>
            <div className="font-medium text-amber-900 mt-0.5">
              未標示（本地時間；尚未向資料提供者確認）
            </div>
          </div>
        </div>
      </section>

      {loading ? (
        <div className="bg-white border border-slate-200 rounded-lg p-8 text-center text-xs text-slate-500">
          正在載入資料並計算瀏覽器端統計…
        </div>
      ) : error ? (
        <div className="p-4 rounded-lg bg-rose-50 border border-rose-200 text-xs text-rose-800">
          {error}
        </div>
      ) : viewMode === "columns" ? (
        /* 欄位說明分頁 */
        <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                欄位說明與單位推論清冊（{dataset.columns.length} 個欄位）
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                所有單位均依欄位名稱與數值分布「推測」，尚未經資料提供者確認；分類狀態與推測物理範圍如下。
              </p>
            </div>
            <button
              type="button"
              onClick={handleDownloadSliceCsv}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[#0B63CE] text-white text-xs font-medium hover:bg-[#0952AD]"
            >
              <Download className="h-3.5 w-3.5" />
              下載 CSV（含 {csvData?.flagColumn}）
            </button>
          </div>

          <div className="overflow-x-auto border border-slate-200 rounded-md">
            <table className="min-w-full text-xs border-collapse">
              <thead className="bg-slate-50 border-b border-slate-200 text-slate-700">
                <tr>
                  <th className="px-3 py-2 text-left font-semibold">欄位名稱 / 原始表頭</th>
                  <th className="px-3 py-2 text-left font-semibold">單位（推測與可信度）</th>
                  <th className="px-3 py-2 text-left font-semibold">分類</th>
                  <th className="px-3 py-2 text-left font-semibold">推測物理範圍</th>
                  <th className="px-3 py-2 text-right font-semibold">缺值率</th>
                  <th className="px-3 py-2 text-right font-semibold">最小 / 最大 / 平均</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {dataset.columns.map((col) => {
                  const st = allColumnStats.find((x) => x.sensor === col.key);
                  return (
                    <tr key={col.key} className="hover:bg-slate-50/70">
                      <td className="px-3 py-2">
                        <div className="font-semibold text-slate-900">{col.key}</div>
                        <div className="font-mono-tabular text-[11px] text-slate-500">
                          {col.raw_header}
                        </div>
                        <div className="text-[11px] text-slate-600 mt-0.5">
                          {col.description}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <div className="font-medium text-slate-900">
                          {col.unit}（推測）
                        </div>
                        <div className="text-[11px] font-mono-tabular text-amber-800">
                          {col.unit_status}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-slate-700">
                        <div>{col.category}</div>
                        <div className="text-[11px] text-slate-500">
                          {col.sensor_type}
                        </div>
                      </td>
                      <td className="px-3 py-2 font-mono-tabular text-slate-700">
                        {col.physical_range
                          ? `[${col.physical_range[0]}, ${col.physical_range[1]}]`
                          : "未定義"}
                      </td>
                      <td className="px-3 py-2 text-right font-mono-tabular text-slate-700">
                        {st
                          ? `${st.missingRatePct.toFixed(1)}%`
                          : col.missing_frac !== null
                            ? `${(col.missing_frac * 100).toFixed(1)}%`
                            : "—"}
                      </td>
                      <td className="px-3 py-2 text-right font-mono-tabular text-slate-700">
                        {st && st.mean !== null
                          ? `${st.min?.toFixed(2)} / ${st.max?.toFixed(2)} / ${st.mean.toFixed(2)}`
                          : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ) : (
        /* 分析視圖 */
        <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
          {/* Single-row Filter Bar above Charts */}
          <div className="p-3 rounded-md bg-slate-50 border border-slate-200 flex flex-wrap items-center justify-between gap-3 text-xs">
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-1.5">
                <span className="font-medium text-slate-600">分析類型：</span>
                <select
                  value={analysisType}
                  onChange={(e) => setAnalysisType(e.target.value as AnalysisType)}
                  className="rounded border border-slate-300 bg-white px-2.5 py-1 text-slate-800"
                >
                  {ANALYSIS_TABS.map((tab) => (
                    <option key={tab.id} value={tab.id}>
                      {tab.label}
                    </option>
                  ))}
                </select>
              </div>

              {csvData && csvData.rows.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-medium text-slate-600">時間起訖：</span>
                  <select
                    value={startIdx}
                    onChange={(e) => setStartIdx(Number(e.target.value))}
                    className="rounded border border-slate-300 bg-white px-2 py-1 font-mono-tabular text-slate-800 max-w-[155px]"
                  >
                    {csvData.rows
                      .filter((_, i) => i % Math.max(1, Math.floor(csvData.rows.length / 40)) === 0 || i === 0)
                      .map((r) => {
                        const idx = csvData.rows.indexOf(r);
                        return (
                          <option key={r.timestamp} value={idx}>
                            {r.timestamp.slice(0, 16)}
                          </option>
                        );
                      })}
                  </select>
                  <span>～</span>
                  <select
                    value={endIdx}
                    onChange={(e) => setEndIdx(Number(e.target.value))}
                    className="rounded border border-slate-300 bg-white px-2 py-1 font-mono-tabular text-slate-800 max-w-[155px]"
                  >
                    {csvData.rows
                      .filter(
                        (_, i) =>
                          i % Math.max(1, Math.floor(csvData.rows.length / 40)) === 0 ||
                          i === csvData.rows.length - 1
                      )
                      .map((r) => {
                        const idx = csvData.rows.indexOf(r);
                        return (
                          <option key={r.timestamp} value={idx}>
                            {r.timestamp.slice(0, 16)}
                          </option>
                        );
                      })}
                  </select>
                </div>
              )}
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={!csvData}
                onClick={() => setTableOpen(true)}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
              >
                <Table2 className="h-3.5 w-3.5" />
                查看表格
              </button>
              <button
                type="button"
                disabled={!csvData}
                onClick={handleDownloadSliceCsv}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-[#0B63CE] text-white font-medium hover:bg-[#0952AD]"
              >
                <Download className="h-3.5 w-3.5" />
                下載 CSV（{csvData?.flagColumn ?? "__real"}）
              </button>
              <button
                type="button"
                onClick={() => onNavigate("provenance")}
                className="inline-flex items-center gap-1 text-[#0B63CE] hover:underline"
              >
                <FileCheck2 className="h-3.5 w-3.5" />
                來源聲明
              </button>
            </div>
          </div>

          {/* Multi-sensor Picker */}
          {csvData && (
            <div className="flex flex-wrap gap-1.5">
              {csvData.sensorHeaders.map((s) => {
                const active = selectedSensors.includes(s);
                return (
                  <button
                    key={s}
                    type="button"
                    onClick={() => toggleSensor(s)}
                    className={`px-2 py-1 rounded text-xs border transition-colors ${
                      active
                        ? "bg-[#0B63CE] text-white border-[#0B63CE] font-medium"
                        : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50"
                    }`}
                  >
                    {s}
                  </button>
                );
              })}
            </div>
          )}

          {/* 4-part deterministic insight */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
            <div className="p-3 rounded border border-slate-200 bg-slate-50 space-y-1">
              <div className="font-semibold text-slate-900">1. 我們觀察到什麼</div>
              <p className="text-slate-700 leading-relaxed">
                {fourPartInsight.observed}
              </p>
            </div>
            <div className="p-3 rounded border border-slate-200 bg-slate-50 space-y-1">
              <div className="font-semibold text-slate-900">2. 可能代表什麼</div>
              <p className="text-slate-700 leading-relaxed">
                {fourPartInsight.meaning}
              </p>
            </div>
            <div className="p-3 rounded border border-slate-200 bg-slate-50 space-y-1">
              <div className="font-semibold text-slate-900">3. 目前不能證明什麼</div>
              <p className="text-slate-700 leading-relaxed">
                {fourPartInsight.cannotProve}
              </p>
            </div>
            <div className="p-3 rounded border border-slate-200 bg-slate-50 space-y-1">
              <div className="font-semibold text-slate-900">4. 下一步建議</div>
              <p className="text-slate-700 leading-relaxed">
                {fourPartInsight.nextStep}
              </p>
            </div>
          </div>

          {/* Analysis Body by Type */}
          {analysisType === "overview" && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
              <div className="p-3 rounded border border-slate-200">
                <div className="text-slate-500">檢視列數</div>
                <div className="text-lg font-bold font-mono-tabular mt-0.5">
                  {slicedRows.length}
                </div>
              </div>
              <div className="p-3 rounded border border-slate-200">
                <div className="text-slate-500">感測器欄數</div>
                <div className="text-lg font-bold font-mono-tabular mt-0.5">
                  {csvData?.sensorHeaders.length ?? 0}
                </div>
              </div>
              <div className="p-3 rounded border border-slate-200">
                <div className="text-slate-500">重複時間戳記</div>
                <div className="text-lg font-bold font-mono-tabular mt-0.5">
                  {gapReport.duplicateTimestamps}
                </div>
              </div>
              <div className="p-3 rounded border border-slate-200">
                <div className="text-slate-500">時間缺口總時數</div>
                <div className="text-lg font-bold font-mono-tabular mt-0.5">
                  {gapReport.totalMissingHours} 小時
                </div>
              </div>
            </div>
          )}

          {(analysisType === "quality" || analysisType === "stats") && (
            <div className="overflow-x-auto border border-slate-200 rounded-md">
              <table className="min-w-full text-xs border-collapse">
                <thead className="bg-slate-50 border-b border-slate-200 text-slate-700">
                  <tr>
                    <th className="px-3 py-2 text-left font-semibold">感測器</th>
                    <th className="px-3 py-2 text-left font-semibold">單位（推測）</th>
                    <th className="px-3 py-2 text-right font-semibold">有效 / 缺漏</th>
                    <th className="px-3 py-2 text-right font-semibold">最小 / 最大</th>
                    <th className="px-3 py-2 text-right font-semibold">平均 ± 標準差</th>
                    <th className="px-3 py-2 text-right font-semibold">Q25 / 中位 / Q75</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 font-mono-tabular">
                  {selectedStats.map((st) => (
                    <tr key={st.sensor}>
                      <td className="px-3 py-2 font-sans font-semibold text-slate-900">
                        {st.sensor}
                      </td>
                      <td className="px-3 py-2 font-sans text-slate-600">
                        {columnMetaMap.get(st.sensor)?.unit ?? "未知"}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {st.observed} / {st.missing} ({st.missingRatePct.toFixed(1)}%)
                      </td>
                      <td className="px-3 py-2 text-right">
                        {st.min !== null ? `${st.min.toFixed(3)} / ${st.max?.toFixed(3)}` : "—"}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {st.mean !== null
                          ? `${st.mean.toFixed(3)} ± ${(st.std ?? 0).toFixed(3)}`
                          : "—"}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {st.median !== null
                          ? `${st.q25?.toFixed(2)} / ${st.median.toFixed(2)} / ${st.q75?.toFixed(2)}`
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {analysisType === "trend" && (
            <div className="h-72 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={trendChartData} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                  <XAxis dataKey="timestamp" tick={{ fontSize: 11, fill: "#64748B" }} minTickGap={26} />
                  <YAxis tick={{ fontSize: 11, fill: "#64748B" }} width={52} />
                  <Tooltip />
                  <Legend wrapperStyle={{ fontSize: "12px" }} />
                  {selectedSensors.map((s, idx) => (
                    <Line
                      key={s}
                      type="monotone"
                      dataKey={s}
                      stroke={colors[idx % colors.length]}
                      strokeWidth={1.7}
                      dot={false}
                      connectNulls={false}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}

          {analysisType === "distribution" && (
            <div className="space-y-2">
              <div className="text-xs text-slate-600">
                分布直方圖（顯示第一個已選感測器：<strong>{primarySensor}</strong>）
              </div>
              <div className="h-72 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={histogramData} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                    <XAxis dataKey="bin" tick={{ fontSize: 10, fill: "#64748B" }} />
                    <YAxis tick={{ fontSize: 11, fill: "#64748B" }} width={46} />
                    <Tooltip />
                    <Bar dataKey="count" name="筆數" fill="#0B63CE" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {analysisType === "daily_cycle" && (
            <div className="space-y-2">
              <div className="text-xs text-slate-600">
                24 小時日週期平均輪廓（本地時間 00:00–23:00）
              </div>
              <div className="h-72 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={diurnalData} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                    <XAxis dataKey="hour" tick={{ fontSize: 11, fill: "#64748B" }} />
                    <YAxis tick={{ fontSize: 11, fill: "#64748B" }} width={52} />
                    <Tooltip />
                    <Legend wrapperStyle={{ fontSize: "12px" }} />
                    {selectedSensors.map((s, idx) => (
                      <Line
                        key={s}
                        type="monotone"
                        dataKey={s}
                        stroke={colors[idx % colors.length]}
                        strokeWidth={2}
                        dot={{ r: 2.5 }}
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {analysisType === "correlation" && (
            <div className="overflow-x-auto border border-slate-200 rounded-md">
              <table className="min-w-full text-xs border-collapse font-mono-tabular">
                <thead className="bg-slate-50 border-b border-slate-200">
                  <tr>
                    <th className="px-3 py-2 text-left font-sans font-semibold text-slate-700">
                      Pearson r
                    </th>
                    {correlationData.sensors.map((s) => (
                      <th key={s} className="px-3 py-2 text-right font-sans font-semibold text-slate-700">
                        {s}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {correlationData.sensors.map((rowSensor, rIdx) => (
                    <tr key={rowSensor}>
                      <td className="px-3 py-2 font-sans font-semibold text-slate-900">
                        {rowSensor}
                      </td>
                      {correlationData.matrix[rIdx].map((val, cIdx) => (
                        <td
                          key={cIdx}
                          className={`px-3 py-2 text-right ${
                            val !== null && Math.abs(val) >= 0.7 && rIdx !== cIdx
                              ? "font-semibold text-[#0B63CE] bg-blue-50/50"
                              : "text-slate-700"
                          }`}
                        >
                          {val !== null ? val.toFixed(3) : "—"}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {analysisType === "runs" && (
            <div className="space-y-4">
              <div className="overflow-x-auto border border-slate-200 rounded-md">
                <table className="min-w-full text-xs border-collapse">
                  <thead className="bg-slate-50 border-b border-slate-200 text-slate-700">
                    <tr>
                      <th className="px-3 py-2 text-left font-semibold">感測器</th>
                      <th className="px-3 py-2 text-right font-semibold">缺漏筆數</th>
                      <th className="px-3 py-2 text-right font-semibold">零值筆數</th>
                      <th className="px-3 py-2 text-right font-semibold">最長連續零值 (h)</th>
                      <th className="px-3 py-2 text-right font-semibold">最長讀值不變卡值 (h)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 font-mono-tabular">
                    {selectedStats.map((st) => (
                      <tr key={st.sensor}>
                        <td className="px-3 py-2 font-sans font-semibold text-slate-900">
                          {st.sensor}
                        </td>
                        <td className="px-3 py-2 text-right">{st.missing}</td>
                        <td className="px-3 py-2 text-right">{st.zeroCount}</td>
                        <td className="px-3 py-2 text-right">{st.longestZeroHours}</td>
                        <td className="px-3 py-2 text-right">{st.longestFlatlineHours}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {gapReport.segments.length > 0 && (
                <div className="p-3 rounded border border-amber-200 bg-amber-50 text-xs text-amber-950 space-y-1">
                  <div className="font-semibold">時間缺口明細：</div>
                  {gapReport.segments.map((g, i) => (
                    <div key={i} className="font-mono-tabular">
                      • {g.start} ～ {g.end}（缺 {g.missingHours} 小時）
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </section>
      )}

      <DataTableModal
        open={tableOpen}
        onClose={() => setTableOpen(false)}
        title={`${dataset.display_name}・資料探索完整表格`}
        subtitle={"資料類型：真實資料（__real=1）｜未降採樣原始數值"}
        columns={["timestamp", ...selectedSensors, csvData?.flagColumn ?? "__real"]}
        rows={tableRowsForModal}
        onDownloadCsv={handleDownloadSliceCsv}
      />
    </div>
  );
};
