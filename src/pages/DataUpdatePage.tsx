import React, { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  History,
  Lock,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Upload,
} from "lucide-react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { DemoDomain, DemoManifest, RealDataset } from "../../contracts/types";
import {
  buildCsvDownloadText,
  detectTimeGaps,
  downsampleSeries,
  triggerCsvDownload,
} from "../lib/csv";
import {
  loadDemoStepOutputs,
  loadSyntheticCsv,
  loadSyntheticTruth,
} from "../lib/dataLoader";
import { buildSyntheticStepFacts } from "../lib/facts";
import type {
  DemoStepOutputsFile,
  DomainSyntheticState,
  ExplainModalPayload,
  ParsedCsvDataset,
  ParsedCsvRow,
  SyntheticTruthFile,
  VerifyBatchReport,
} from "../types/app";

interface DataUpdatePageProps {
  dataset: RealDataset;
  demoManifest: DemoManifest | null;
  syntheticState: DomainSyntheticState;
  onUpdateSyntheticState: (
    datasetId: string,
    updater: (prev: DomainSyntheticState) => DomainSyntheticState
  ) => void;
  onOpenExplain: (payload: ExplainModalPayload) => void;
}

export const DataUpdatePage: React.FC<DataUpdatePageProps> = ({
  dataset,
  demoManifest,
  syntheticState,
  onUpdateSyntheticState,
  onOpenExplain,
}) => {
  const synthDomain: DemoDomain | undefined = demoManifest?.domains.find(
    (d) => d.id === dataset.id
  );

  const [stepOutputsFile, setStepOutputsFile] =
    useState<DemoStepOutputsFile | null>(null);
  const [timelineDataset, setTimelineDataset] =
    useState<ParsedCsvDataset | null>(null);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [truthExpanded, setTruthExpanded] = useState(false);
  const [truthFile, setTruthFile] = useState<SyntheticTruthFile | null>(null);
  const [selectedSensor, setSelectedSensor] = useState<string>("");

  const activeVersion =
    syntheticState.versions[syntheticState.activeVersionIndex];
  const activeStep = activeVersion?.step ?? syntheticState.currentStep;
  const nextBatch = synthDomain?.batches.find((b) => b.step === activeStep + 1);

  useEffect(() => {
    loadDemoStepOutputs().then(setStepOutputsFile).catch(() => {});
  }, []);

  // Load merged synthetic CSVs from D1..activeStep (strictly synthetic only)
  useEffect(() => {
    if (!synthDomain) return;
    let cancelled = false;
    setTimelineLoading(true);
    const batchesToLoad = synthDomain.batches.slice(0, activeStep);
    Promise.all(batchesToLoad.map((b) => loadSyntheticCsv(dataset.id, b.code)))
      .then((parts) => {
        if (cancelled || parts.length === 0) return;
        const base = parts[0];
        const mergedRows: ParsedCsvRow[] = [];
        for (const p of parts) {
          mergedRows.push(...p.rows);
        }
        setTimelineDataset({
          headers: base.headers,
          sensorHeaders: base.sensorHeaders,
          flagColumn: "__synthetic",
          rows: mergedRows,
        });
        if (!selectedSensor || !base.sensorHeaders.includes(selectedSensor)) {
          const preferred =
            (synthDomain.story.drift_column as string | undefined) ||
            base.sensorHeaders.find((h) => !h.includes("帆布")) ||
            base.sensorHeaders[0] ||
            "";
          setSelectedSensor(preferred);
        }
      })
      .finally(() => {
        if (!cancelled) setTimelineLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [synthDomain, dataset.id, activeStep, selectedSensor]);

  // Load truth file for current activeStep when expanded
  useEffect(() => {
    if (!truthExpanded) return;
    loadSyntheticTruth(dataset.id, `D${activeStep}`)
      .then(setTruthFile)
      .catch(() => setTruthFile(null));
  }, [truthExpanded, dataset.id, activeStep]);

  const currentDomainStepOutputs =
    stepOutputsFile?.domains[dataset.id]?.steps ?? [];
  const currentStepOutput = currentDomainStepOutputs.find(
    (s) => s.step === activeStep
  );

  // ① Verify (non-mutating)
  const handleVerifyNext = async () => {
    if (!nextBatch || !timelineDataset) return;
    setVerifying(true);
    try {
      const nextParsed = await loadSyntheticCsv(dataset.id, nextBatch.code);
      const gaps = detectTimeGaps(nextParsed.rows);
      const existingTs = new Set(timelineDataset.rows.map((r) => r.timestamp));
      let overlapWithCurrent = 0;
      for (const r of nextParsed.rows) {
        if (existingTs.has(r.timestamp)) overlapWithCurrent += 1;
      }
      const allRowsHaveSyntheticFlag =
        nextParsed.headers.includes("__synthetic") &&
        !nextParsed.headers.includes("__real") &&
        nextParsed.rows.every((r) => r.flagValue === "1");

      const issues: string[] = [];
      if (!allRowsHaveSyntheticFlag) {
        issues.push("存在未標記 __synthetic=1 的資料列，禁止寫入");
      }
      if (gaps.duplicateTimestamps > 0) {
        issues.push(`批次內有 ${gaps.duplicateTimestamps} 筆重複時間戳記`);
      }
      if (overlapWithCurrent > 0) {
        issues.push(`與目前版本有 ${overlapWithCurrent} 筆時間重疊`);
      }

      const report: VerifyBatchReport = {
        batch: nextBatch,
        rows: nextParsed.rows.length,
        start: nextParsed.rows[0]?.timestamp ?? nextBatch.start,
        end:
          nextParsed.rows[nextParsed.rows.length - 1]?.timestamp ??
          nextBatch.end,
        duplicateTimestamps: gaps.duplicateTimestamps,
        gapCount: gaps.nGaps,
        longestGapHours: gaps.longestGapHours,
        overlapWithCurrent,
        allRowsHaveSyntheticFlag,
        passed: allRowsHaveSyntheticFlag && overlapWithCurrent === 0,
        issues,
      };

      onUpdateSyntheticState(dataset.id, (prev) => ({
        ...prev,
        verifiedStep: report.passed ? nextBatch.step : null,
        lastVerifyReport: report,
        auditLog: [
          {
            id: `audit-${Date.now()}`,
            at: new Date().toLocaleTimeString("zh-Hant", { hour12: false }),
            action: "VERIFY",
            detail: `驗證 ${nextBatch.code}（${nextBatch.label}）：${report.rows} 列，${
              report.passed ? "通過（未寫入版本）" : "未通過"
            }`,
            version: activeVersion.version,
          },
          ...prev.auditLog,
        ],
      }));
    } finally {
      setVerifying(false);
    }
  };

  // ② Approve & Commit in-memory
  const handleCommitNext = () => {
    if (!nextBatch || syntheticState.verifiedStep !== nextBatch.step) return;
    const stepOut = currentDomainStepOutputs.find(
      (s) => s.step === nextBatch.step
    );
    const newVersionStr =
      stepOut?.version ||
      `${synthDomain?.stem ?? dataset.id}-v000${nextBatch.step}-demo`;
    const prevRows = activeVersion?.rowCount ?? 0;

    onUpdateSyntheticState(dataset.id, (prev) => {
      const nextVersions = [
        ...prev.versions,
        {
          version: newVersionStr,
          step: nextBatch.step,
          code: nextBatch.code,
          label: nextBatch.label,
          committedAt: new Date().toLocaleTimeString("zh-Hant", {
            hour12: false,
          }),
          rowCount: prevRows + nextBatch.rows,
          rangeStart: prev.versions[0]?.rangeStart ?? nextBatch.start,
          rangeEnd: nextBatch.end,
          batchSha256: nextBatch.sha256,
        },
      ];
      return {
        currentStep: nextBatch.step,
        activeVersionIndex: nextVersions.length - 1,
        versions: nextVersions,
        verifiedStep: null,
        lastVerifyReport: null,
        auditLog: [
          {
            id: `audit-${Date.now()}`,
            at: new Date().toLocaleTimeString("zh-Hant", { hour12: false }),
            action: "COMMIT",
            detail: `核准並寫入（記憶體展示）${nextBatch.code}「${nextBatch.label}」，新增 ${nextBatch.rows} 列`,
            version: newVersionStr,
          },
          ...prev.auditLog,
        ],
      };
    });
  };

  // Rollback (non-destructive)
  const handleRollback = (idx: number) => {
    const targetVer = syntheticState.versions[idx];
    if (!targetVer) return;
    onUpdateSyntheticState(dataset.id, (prev) => ({
      ...prev,
      currentStep: targetVer.step,
      activeVersionIndex: idx,
      verifiedStep: null,
      lastVerifyReport: null,
      auditLog: [
        {
          id: `audit-${Date.now()}`,
          at: new Date().toLocaleTimeString("zh-Hant", { hour12: false }),
          action: "ROLLBACK",
          detail: `回復目前指標至版本 ${targetVer.version}（D1–D${targetVer.step}）；既有版本紀錄不刪除`,
          version: targetVer.version,
        },
        ...prev.auditLog,
      ],
    }));
  };

  const handleDownloadSyntheticCsv = () => {
    if (!timelineDataset) return;
    const text = buildCsvDownloadText(timelineDataset, timelineDataset.rows);
    triggerCsvDownload(
      `${dataset.id}_synthetic_D1_to_D${activeStep}.csv`,
      text
    );
  };

  const chartData = useMemo(() => {
    if (!timelineDataset || !selectedSensor) return [];
    const sampled = downsampleSeries(timelineDataset.rows, 300);
    return sampled.map((r) => ({
      timestamp: r.timestamp.slice(5, 16),
      value: r.values[selectedSensor] ?? null,
    }));
  }, [timelineDataset, selectedSensor]);

  return (
    <div className="space-y-6">
      {/* Header & Ephemeral Notice */}
      <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-slate-900">
              資料更新流程展示（合成資料 D1 → D5）
            </h1>
            <p className="text-sm text-slate-600 mt-1">
              場域：{synthDomain?.display_name ?? dataset.display_name}｜本頁只處理合成展示批次（
              <code className="font-mono-tabular">__synthetic=1</code>
              ），嚴格不修改、不混入任何真實感測資料。
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={!timelineDataset}
              onClick={handleDownloadSyntheticCsv}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-slate-300 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              <Download className="h-3.5 w-3.5" />
              下載合成 CSV（__synthetic=1）
            </button>
            <button
              type="button"
              disabled
              title="M1 展示模式不開放上傳；需要 Python 引擎與真實版本庫"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-slate-200 bg-slate-100 text-xs font-medium text-slate-400 cursor-not-allowed"
            >
              <Upload className="h-3.5 w-3.5" />
              上傳 CSV（M1 未開放）
            </button>
          </div>
        </div>

        <div className="p-3 rounded-md bg-amber-50 border border-amber-300 text-xs text-amber-950 flex items-center gap-2">
          <Lock className="h-4 w-4 text-amber-700 shrink-0" />
          <span>
            <strong>展示：未寫入任何真實版本庫；重新整理即回到初始。</strong>
            所有核准與回復只在瀏覽器記憶體模擬版本指標。
          </span>
        </div>
      </section>

      {/* Two-step Verify -> Commit Workflow */}
      <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-slate-900">
            兩步驟安全匯入：目前版本 D1–D{activeStep}
          </h2>
          {currentStepOutput && (
            <button
              type="button"
              onClick={() =>
                onOpenExplain({
                  title: `${synthDomain?.display_name ?? dataset.id}・合成步驟 D${activeStep} 白話解釋`,
                  request: {
                    kind: "data",
                    data_kind: "synthetic",
                    dataset_id: dataset.id,
                    facts: buildSyntheticStepFacts(
                      synthDomain?.display_name ?? dataset.display_name,
                      currentStepOutput,
                      activeVersion.label,
                      activeVersion.version,
                      "synthetic"
                    ),
                  },
                })
              }
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-slate-300 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              <Sparkles className="h-3.5 w-3.5 text-[#0B63CE]" />
              用白話解釋目前合成版本
            </button>
          )}
        </div>

        {/* Batch Timeline Progress */}
        {synthDomain && (
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
            {synthDomain.batches.map((b) => {
              const imported = b.step <= activeStep;
              const isNext = b.step === activeStep + 1;
              return (
                <div
                  key={b.code}
                  className={`p-2.5 rounded-md border text-xs ${
                    imported
                      ? "bg-amber-50 border-amber-300 text-amber-950"
                      : isNext
                        ? "bg-blue-50 border-blue-300 text-blue-950"
                        : "bg-slate-50 border-slate-200 text-slate-500"
                  }`}
                >
                  <div className="font-semibold">
                    {b.code}：{b.label}
                  </div>
                  <div className="font-mono-tabular text-[11px] mt-0.5">
                    {b.rows} 列 · {imported ? "已納入目前版本" : isNext ? "待匯入" : "尚未到達"}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Next batch action */}
        {nextBatch ? (
          <div className="p-4 rounded-md bg-slate-50 border border-slate-200 space-y-3 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-sm font-semibold text-slate-900">
                  下一批待匯入：{nextBatch.code}「{nextBatch.label}」
                </div>
                <div className="text-slate-600 mt-0.5">{nextBatch.story}</div>
                <div className="font-mono-tabular text-slate-500 mt-1">
                  期間：{nextBatch.start} ～ {nextBatch.end}（{nextBatch.rows} 列）
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={verifying || timelineLoading}
                  onClick={handleVerifyNext}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md border border-[#0B63CE] bg-white text-[#0B63CE] font-semibold hover:bg-blue-50 disabled:opacity-50"
                >
                  <ShieldCheck className="h-4 w-4" />
                  {verifying ? "驗證中…" : `① 驗證 ${nextBatch.code}（不寫入）`}
                </button>
                <button
                  type="button"
                  disabled={syntheticState.verifiedStep !== nextBatch.step}
                  onClick={handleCommitNext}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md bg-[#0B63CE] text-white font-semibold hover:bg-[#0952AD] disabled:bg-slate-300 disabled:text-slate-500"
                >
                  <CheckCircle2 className="h-4 w-4" />
                  ② 核准並寫入新版本（展示）
                </button>
              </div>
            </div>

            {syntheticState.lastVerifyReport && (
              <div
                className={`p-3 rounded border ${
                  syntheticState.lastVerifyReport.passed
                    ? "bg-emerald-50 border-emerald-200 text-emerald-950"
                    : "bg-rose-50 border-rose-200 text-rose-950"
                }`}
              >
                <div className="font-semibold">
                  驗證報告（{syntheticState.lastVerifyReport.batch.code}，尚未寫入版本）：
                </div>
                <div className="font-mono-tabular mt-1">
                  列數：{syntheticState.lastVerifyReport.rows} ｜ 時間：
                  {syntheticState.lastVerifyReport.start} ～{" "}
                  {syntheticState.lastVerifyReport.end} ｜ 重複時間戳：
                  {syntheticState.lastVerifyReport.duplicateTimestamps} ｜ 與現有重疊：
                  {syntheticState.lastVerifyReport.overlapWithCurrent} ｜ 缺口：
                  {syntheticState.lastVerifyReport.gapCount} 段（最長{" "}
                  {syntheticState.lastVerifyReport.longestGapHours}h）｜ 全部含 __synthetic=1：
                  {syntheticState.lastVerifyReport.allRowsHaveSyntheticFlag
                    ? "是"
                    : "否"}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="p-3 rounded-md bg-emerald-50 border border-emerald-200 text-xs text-emerald-900">
            已完成此場域 D1–D5 全部五批合成展示匯入！你可以使用下方版本表的「回復到版本」回到任何先前的展示狀態。
          </div>
        )}
      </section>

      {/* Precomputed Step Outputs + Guard Warning */}
      {currentStepOutput && (
        <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              引擎步驟預計算結果（D{activeStep}：{currentStepOutput.label}）
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              來源：Python 引擎在合成展示資料 D1→D{activeStep} 的逐步真實輸出；展示情境是挑選過的，不是效能宣稱。
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {currentStepOutput.cards.map((c, idx) => (
              <div
                key={idx}
                className={`p-3.5 rounded-md border text-xs ${
                  c.level === "ok"
                    ? "bg-emerald-50 border-emerald-200 text-emerald-950"
                    : "bg-amber-50 border-amber-300 text-amber-950"
                }`}
              >
                <div className="font-semibold text-sm">{c.title}</div>
                {c.lead_sensor && (
                  <div className="mt-1">主要先導感測器：{c.lead_sensor}</div>
                )}
              </div>
            ))}
          </div>

          {/* Model Guard Status */}
          {currentStepOutput.guard ? (
            <div
              className={`p-4 rounded-md border text-xs space-y-1.5 ${
                currentStepOutput.guard.recommendation === "fix_data_first"
                  ? "bg-rose-50 border-rose-300 text-rose-950"
                  : "bg-slate-50 border-slate-200 text-slate-800"
              }`}
            >
              <div className="font-semibold text-sm flex items-center gap-2">
                {currentStepOutput.guard.recommendation === "fix_data_first" ? (
                  <>
                    <AlertTriangle className="h-4 w-4 text-rose-700" />
                    守門建議：fix_data_first（先處理資料，不建議重訓）
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="h-4 w-4 text-emerald-700" />
                    守門建議：{currentStepOutput.guard.recommendation}
                  </>
                )}
              </div>
              <div>
                感測器健康度：{currentStepOutput.guard.sensor_health} ｜ 允許重新訓練：
                {currentStepOutput.retrain_allowed ? "是（仍需人工按下）" : "否（被守門擋下）"} ｜
                預測任務（{currentStepOutput.forecast?.task ?? "無"}）適用性：
                {currentStepOutput.forecast?.applicability ?? "不適用"}
              </div>
              <div className="font-mono-tabular text-slate-600">
                品質問題數：{currentStepOutput.n_data_quality} ｜ 異常訊號數：
                {currentStepOutput.n_signal} ｜ 環境變化抑制：
                {currentStepOutput.n_environment_suppressed} ｜ 對照真值命中：
                {currentStepOutput.alerts_true}、誤報：{currentStepOutput.alerts_false}
              </div>
            </div>
          ) : (
            <div className="p-4 rounded-md border border-slate-200 bg-slate-50 text-xs text-slate-800 space-y-1.5">
              <div className="font-semibold text-sm">
                此場域不建立預測模型，沒有守門建議
              </div>
              <div>
                資料不足，依平台政策不建模、不重新訓練、不顯示預測。以下僅是資料品質與異常訊號的計數。
              </div>
              <div className="font-mono-tabular text-slate-600">
                品質問題數：{currentStepOutput.n_data_quality} ｜ 異常訊號數：
                {currentStepOutput.n_signal} ｜ 環境變化抑制：
                {currentStepOutput.n_environment_suppressed} ｜ 對照真值命中：
                {currentStepOutput.alerts_true}、誤報：{currentStepOutput.alerts_false}
              </div>
            </div>
          )}
        </section>
      )}

      {/* Synthetic Timeline Chart */}
      <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              目前合成時間線趨勢（D1–D{activeStep}，僅合成資料）
            </h2>
            <div className="text-xs text-slate-500">
              總列數：{timelineDataset?.rows.length ?? 0} 列
            </div>
          </div>
          {timelineDataset && (
            <select
              value={selectedSensor}
              onChange={(e) => setSelectedSensor(e.target.value)}
              className="rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-800"
            >
              {timelineDataset.sensorHeaders.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="h-60 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
              <XAxis dataKey="timestamp" tick={{ fontSize: 11, fill: "#64748B" }} minTickGap={24} />
              <YAxis tick={{ fontSize: 11, fill: "#64748B" }} width={52} domain={["auto", "auto"]} />
              <Tooltip />
              <Legend wrapperStyle={{ fontSize: "12px" }} />
              <Line
                type="monotone"
                dataKey="value"
                name={`${selectedSensor}（合成）`}
                stroke="#D97706"
                strokeWidth={1.8}
                dot={false}
                connectNulls={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </section>

      {/* Version Table & Non-Destructive Rollback */}
      <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-slate-900 flex items-center gap-2">
            <History className="h-4 w-4 text-[#0B63CE]" />
            合成版本表與回復（不刪除任何歷史版本）
          </h2>
          <span className="text-xs text-slate-500">
            展示：未寫入任何真實版本庫；重新整理即回到初始
          </span>
        </div>

        <div className="overflow-x-auto border border-slate-200 rounded-md">
          <table className="min-w-full text-xs border-collapse">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-700">
              <tr>
                <th className="px-3 py-2 text-left font-semibold">狀態</th>
                <th className="px-3 py-2 text-left font-semibold">版本編號</th>
                <th className="px-3 py-2 text-left font-semibold">批次步驟</th>
                <th className="px-3 py-2 text-right font-semibold">累積列數</th>
                <th className="px-3 py-2 text-left font-semibold">資料範圍</th>
                <th className="px-3 py-2 text-right font-semibold">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {syntheticState.versions.map((v, idx) => {
                const isActive = idx === syntheticState.activeVersionIndex;
                return (
                  <tr key={`${v.version}-${idx}`} className={isActive ? "bg-amber-50/70" : ""}>
                    <td className="px-3 py-2 font-semibold">
                      {isActive ? (
                        <span className="text-amber-900">目前使用</span>
                      ) : (
                        <span className="text-slate-400">歷史版本</span>
                      )}
                    </td>
                    <td className="px-3 py-2 font-mono-tabular text-slate-800">
                      {v.version}
                    </td>
                    <td className="px-3 py-2">
                      {v.code} · {v.label}
                    </td>
                    <td className="px-3 py-2 text-right font-mono-tabular">
                      {v.rowCount}
                    </td>
                    <td className="px-3 py-2 font-mono-tabular text-slate-600">
                      {v.rangeStart} ～ {v.rangeEnd}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        disabled={isActive}
                        onClick={() => handleRollback(idx)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-40"
                      >
                        <RotateCcw className="h-3 w-3" />
                        回復到版本
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Audit log */}
        <div className="space-y-1.5">
          <div className="text-xs font-semibold text-slate-700">
            展示稽核紀錄（瀏覽器記憶體）
          </div>
          <div className="max-h-40 overflow-y-auto border border-slate-200 rounded-md divide-y divide-slate-100 text-xs">
            {syntheticState.auditLog.map((entry) => (
              <div
                key={entry.id}
                className="px-3 py-2 flex flex-wrap items-center justify-between gap-2"
              >
                <div>
                  <span className="font-mono-tabular font-semibold text-slate-700 mr-2">
                    [{entry.action}]
                  </span>
                  <span className="text-slate-800">{entry.detail}</span>
                </div>
                <span className="font-mono-tabular text-slate-400">
                  {entry.at} · {entry.version}
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Expandable Ground Truth (for verification comparison only) */}
      <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-2 text-xs">
        <button
          type="button"
          onClick={() => setTruthExpanded((v) => !v)}
          className="font-semibold text-[#0B63CE] hover:underline"
        >
          {truthExpanded
            ? "▼ 收合「注入情境真值（僅供驗收對照）」"
            : "▶ 展開「注入情境真值（僅供驗收對照）」"}
        </button>
        {truthExpanded && (
          <div className="pt-2 space-y-2">
            <div className="p-2.5 rounded bg-slate-50 border border-slate-200 text-slate-600">
              以下為本合成資料生成腳本事先注入的情境事件，僅供展示驗收對照，不是偵測器在真實資料上的效能宣稱。
            </div>
            {truthFile && truthFile.events.length > 0 ? (
              <div className="space-y-1.5">
                {truthFile.events.map((ev) => (
                  <div
                    key={ev.event_id}
                    className="p-2.5 rounded border border-slate-200 font-mono-tabular text-slate-700"
                  >
                    <strong>{ev.scenario}</strong> ({ev.columns.join(", ")})：
                    {ev.start} ～ {ev.end} ｜ {ev.description}
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-slate-500">
                步驟 D{activeStep} 沒有注入異常事件（正常情境）。
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
};
