import React, { useEffect, useMemo, useRef, useState } from "react";
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
import { FlaskConical, Pause, Play, RotateCcw, StepForward } from "lucide-react";
import type {
  ModelKey,
  PrecomputedForecastTask,
  PrecomputedForecasts,
  RealDataset,
} from "../../contracts/types";
import { MODEL_ORDER } from "../../contracts/types";
import {
  CANDIDATE_POLICIES,
  LEVEL_TEXT,
  assessAt,
  classify,
  currentValueAt,
  pointValue,
} from "../lib/candidateRisk";
import {
  chartRows,
  importSteps,
  maxCursor,
  revealedTruths,
  runningMae,
  startCursor,
  type DemoLogEntry,
} from "../lib/demoImport";

interface Props {
  datasets: RealDataset[];
  datasetId: string;
  onSelectDataset: (id: string) => void;
  precomputedForecasts: PrecomputedForecasts | null;
}

const MODEL_LABEL: Record<ModelKey, string> = {
  persistence: "持續性",
  moving_average: "滑動平均",
  seasonal_naive_24h: "24h 季節 Naive",
  linear_ar4: "線性 AR",
  HGB: "HGB",
  XGB: "XGBoost",
};

const num = (v: number | null | undefined, d = 2) =>
  v === null || v === undefined || !Number.isFinite(v) ? "—" : v.toFixed(d);

export const DemoImportSimulation: React.FC<Props> = ({
  datasets,
  datasetId,
  onSelectDataset,
  precomputedForecasts,
}) => {
  const tasks = useMemo(() => {
    if (!precomputedForecasts) return [] as Array<[string, PrecomputedForecastTask]>;
    return Object.entries(precomputedForecasts.tasks)
      .filter(([, t]) => t.dataset_id === datasetId)
      .sort((a, b) =>
        a[1].sensor === b[1].sensor
          ? a[1].horizon_h - b[1].horizon_h
          : a[1].sensor < b[1].sensor
          ? -1
          : 1
      );
  }, [precomputedForecasts, datasetId]);

  const [taskKey, setTaskKey] = useState<string>("");
  const [model, setModel] = useState<ModelKey | "">("");
  const [cursor, setCursor] = useState(0);
  const [log, setLog] = useState<DemoLogEntry[]>([]);
  const [playing, setPlaying] = useState(false);
  const seqRef = useRef(0);

  const dataset = datasets.find((d) => d.id === datasetId);
  const task = tasks.find(([k]) => k === taskKey)?.[1] ?? null;

  // 換場域：預設選第一個任務（優先 3 小時）
  useEffect(() => {
    setPlaying(false);
    const pick = tasks.find(([, t]) => t.horizon_h === 3) ?? tasks[0];
    setTaskKey(pick ? pick[0] : "");
    setModel("");
  }, [datasetId, tasks]);

  // 換任務：重設展示
  useEffect(() => {
    setPlaying(false);
    setLog([]);
    seqRef.current = 0;
    setCursor(task ? startCursor(task) : 0);
  }, [taskKey, task]);

  const activeModel = (model || task?.best_baseline || "persistence") as ModelKey;
  const atEnd = task ? cursor >= maxCursor(task) : true;

  const doImport = (steps: number) => {
    if (!task) return;
    const nextSeq = seqRef.current + 1;
    const r = importSteps(task, cursor, steps, nextSeq);
    if (!r.entry) return;
    seqRef.current = nextSeq;
    const entry = r.entry;
    setLog((l) => [entry, ...l].slice(0, 8));
    setCursor(r.cursor);
  };

  useEffect(() => {
    if (!playing || !task) return;
    if (atEnd) {
      setPlaying(false);
      return;
    }
    const id = window.setTimeout(() => doImport(1), 900);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, cursor, atEnd, task]);

  const rows = useMemo(
    () => (task ? chartRows(task, cursor, activeModel).slice(-96) : []),
    [task, cursor, activeModel]
  );
  const revealed = useMemo(() => (task ? revealedTruths(task, cursor, 5) : []), [task, cursor]);
  const mae = useMemo(() => (task ? runningMae(task, cursor) : null), [task, cursor]);
  const policy = CANDIDATE_POLICIES[datasetId];
  const risk = useMemo(() => {
    if (!task || !policy || policy.sensor !== task.sensor) return null;
    return assessAt(task, cursor, policy, activeModel);
  }, [task, policy, cursor, activeModel]);

  return (
    <section
      data-testid="demo-import-simulation"
      className="bg-white border border-violet-300 rounded-lg p-4 sm:p-5 space-y-4 min-w-0"
    >
      <div
        className="flex items-start gap-2 p-3 rounded-md bg-violet-50 border border-violet-300 text-xs text-violet-950"
        data-testid="demo-import-banner"
      >
        <FlaskConical className="h-4 w-4 shrink-0 mt-0.5 text-violet-700" />
        <div>
          <strong>展示：預先準備好的資料＋模擬新資料匯入（不是即時資料）</strong>。
          資料來自引擎預先算好的歷史預測（真實歷史資料上、每個任務最近 168 個預測起點）。
          按「匯入」只是把展示時間往後推，像是新的一小時資料抵達；畫面看不到游標以後的資料。
          版本號是展示用的記憶體計數，<strong>不會寫入任何資料庫</strong>，重新整理就回到起點。
          這<strong>不是</strong>引擎的即時預測，也沒有連接任何現場設備。
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-4 text-xs text-slate-700">
        <label className="flex flex-col gap-1">
          場域
          <select
            className="border border-slate-300 rounded px-2 py-1 text-sm bg-white"
            value={datasetId}
            onChange={(e) => onSelectDataset(e.target.value)}
            data-testid="demo-dataset"
          >
            {datasets.map((d) => (
              <option key={d.id} value={d.id}>
                {d.display_name}
              </option>
            ))}
          </select>
        </label>
        {tasks.length > 0 && (
          <>
            <label className="flex flex-col gap-1">
              感測器與時距
              <select
                className="border border-slate-300 rounded px-2 py-1 text-sm bg-white"
                value={taskKey}
                onChange={(e) => setTaskKey(e.target.value)}
                data-testid="demo-task"
              >
                {tasks.map(([k, t]) => (
                  <option key={k} value={k}>
                    {t.sensor}・{t.horizon_h} 小時後
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              預測方法
              <select
                className="border border-slate-300 rounded px-2 py-1 text-sm bg-white"
                value={model}
                onChange={(e) => setModel(e.target.value as ModelKey | "")}
              >
                <option value="">預設（最佳基準）</option>
                {MODEL_ORDER.map((m) => (
                  <option key={m} value={m}>
                    {MODEL_LABEL[m]}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
      </div>

      {!task && (
        <div className="text-sm text-slate-700 bg-slate-50 border border-slate-200 rounded p-3" data-testid="demo-no-tasks">
          {dataset?.display_name ?? "此場域"}沒有預先準備的預測資料（資料不足，依平台政策不建立預測模型，也不借用其他場域的模型），無法示範新資料匯入。
        </div>
      )}

      {task && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={atEnd}
              onClick={() => doImport(1)}
              data-testid="demo-import-1"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-violet-700 text-white text-sm disabled:opacity-40"
            >
              <StepForward className="h-4 w-4" />
              匯入下一小時資料
            </button>
            <button
              type="button"
              disabled={atEnd}
              onClick={() => doImport(6)}
              className="px-3 py-1.5 rounded border border-violet-300 text-violet-900 text-sm disabled:opacity-40"
            >
              匯入 6 小時
            </button>
            <button
              type="button"
              disabled={atEnd}
              onClick={() => doImport(24)}
              className="px-3 py-1.5 rounded border border-violet-300 text-violet-900 text-sm disabled:opacity-40"
            >
              匯入 24 小時
            </button>
            <button
              type="button"
              disabled={atEnd}
              onClick={() => setPlaying((p) => !p)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-slate-300 text-slate-800 text-sm disabled:opacity-40"
            >
              {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
              {playing ? "暫停" : "自動播放"}
            </button>
            <button
              type="button"
              onClick={() => {
                setPlaying(false);
                setLog([]);
                seqRef.current = 0;
                setCursor(startCursor(task));
              }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-slate-300 text-slate-800 text-sm"
            >
              <RotateCcw className="h-4 w-4" />
              重設
            </button>
            {atEnd && <span className="text-xs text-slate-500">已匯入到預先準備資料的最後一筆</span>}
          </div>

          <div className="grid sm:grid-cols-3 gap-3 text-sm" data-testid="demo-status">
            <div className="border border-slate-200 rounded p-3">
              <div className="text-xs text-slate-500">展示資料終點（已匯入到）</div>
              <div className="font-mono" data-testid="demo-cursor-time">{task.points[cursor]?.[0]}</div>
              <div className="text-xs text-slate-500 mt-1">
                目前版本：{log[0]?.version ?? "demo-v0000（初始）"}；已看到 {cursor + 1} / {task.points.length} 個起點
              </div>
            </div>
            <div className="border border-slate-200 rounded p-3">
              <div className="text-xs text-slate-500">此刻觀測值</div>
              <div className="text-lg font-semibold">
                {num(currentValueAt(task, cursor))} {task.unit}
              </div>
              <div className="text-xs text-slate-500">單位為推測，未經資料提供者確認</div>
            </div>
            <div className="border border-slate-200 rounded p-3">
              <div className="text-xs text-slate-500">
                此刻重算的 {task.horizon_h} 小時後預測（{MODEL_LABEL[activeModel]}）
              </div>
              <div className="text-lg font-semibold">
                {num(pointValue(task, cursor, activeModel))} {task.unit}
              </div>
              <div className="text-xs text-slate-500">
                目標時間 {task.points[cursor]?.[1]?.slice(5, 16)}
              </div>
            </div>
          </div>

          {risk && policy && (
            <div className="text-sm border border-amber-300 bg-amber-50 text-amber-950 rounded p-3" data-testid="demo-risk">
              候選風險（假定門檻：注意 {policy.caution}、警戒 {policy.alarm} {policy.unit}）：現值
              {risk.current !== null ? LEVEL_TEXT[classify(risk.current, policy)] : "—"}，預測
              {risk.forecast !== null ? LEVEL_TEXT[classify(risk.forecast, policy)] : "—"}。
              完整流程見「場域決策」的「風險評估」「歷史回放」；門檻未經確認。
            </div>
          )}

          <div style={{ width: "100%", height: 260 }}>
            <ResponsiveContainer>
              <LineChart data={rows.map((r) => ({ ...r, time: r.time.slice(5, 16) }))} margin={{ top: 8, right: 12, bottom: 8, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="time" tick={{ fontSize: 10 }} minTickGap={32} />
                <YAxis tick={{ fontSize: 11 }} domain={["auto", "auto"]} unit={` ${task.unit}`} width={70} />
                <Tooltip />
                <Legend />
                {policy && policy.sensor === task.sensor && (
                  <ReferenceLine y={policy.caution} stroke="#d97706" strokeDasharray="4 4" />
                )}
                <Line type="monotone" dataKey="observed" name="已匯入的觀測" stroke="#0B63CE" dot={false} connectNulls />
                <Line type="monotone" dataKey="forecast" name="先前的預測（對齊目標時間）" stroke="#7C3AED" dot={false} strokeDasharray="5 3" connectNulls />
                <Line type="monotone" dataKey="latestForecast" name="此刻重算的預測" stroke="#dc2626" dot={{ r: 5 }} connectNulls />
              </LineChart>
            </ResponsiveContainer>
          </div>

          <div className="grid lg:grid-cols-2 gap-4">
            <div className="border border-slate-200 rounded p-3 space-y-2 overflow-x-auto">
              <h3 className="text-sm font-bold text-slate-900">剛到達的真值 vs 當時的預測（最近 5 筆）</h3>
              <table className="w-full text-xs" data-testid="demo-revealed">
                <thead>
                  <tr className="text-left text-slate-500 border-b">
                    <th className="py-1 pr-2">目標時間</th>
                    <th className="py-1 pr-2">真值</th>
                    <th className="py-1 pr-2">{MODEL_LABEL[activeModel]}預測</th>
                    <th className="py-1 pr-2">誤差</th>
                  </tr>
                </thead>
                <tbody>
                  {revealed.map((r) => {
                    const f = r.forecasts[activeModel] ?? null;
                    return (
                      <tr key={r.target} className="border-b border-slate-100">
                        <td className="py-1 pr-2 font-mono">{r.target.slice(5, 16)}</td>
                        <td className="py-1 pr-2">{num(r.actual)}</td>
                        <td className="py-1 pr-2">{num(f)}</td>
                        <td className="py-1 pr-2">{f === null ? "—" : num(f - r.actual)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="border border-slate-200 rounded p-3 space-y-2 overflow-x-auto">
              <h3 className="text-sm font-bold text-slate-900">到目前為止各方法的平均絕對誤差（真值已到達者，n={mae?.n ?? 0}）</h3>
              <table className="w-full text-xs">
                <tbody>
                  {MODEL_ORDER.map((m) => (
                    <tr key={m} className="border-b border-slate-100">
                      <td className="py-1 pr-2">{MODEL_LABEL[m]}</td>
                      <td className="py-1 pr-2">{num(mae?.mae[m], 3)} {task.unit}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-[11px] text-slate-500">
                簡單方法常常已經夠好；樣本少時誤差排序會一直變動，不能當作模型優劣的證據。
              </p>
            </div>
          </div>

          <div className="border border-slate-200 rounded p-3 space-y-1 text-xs" data-testid="demo-log">
            <h3 className="text-sm font-bold text-slate-900">匯入紀錄（展示用，只存在這個分頁）</h3>
            {log.length === 0 ? (
              <div className="text-slate-500">尚未匯入。按上方「匯入下一小時資料」。</div>
            ) : (
              log.map((l) => (
                <div key={l.seq} className="font-mono text-slate-700">
                  {l.version}　{l.fromOrigin.slice(5, 16)} → {l.toOrigin.slice(5, 16)}　新增 {l.rowsAdded} 筆
                </div>
              ))
            )}
          </div>
        </>
      )}
    </section>
  );
};
