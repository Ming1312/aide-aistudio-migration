import React, { useEffect, useMemo, useState } from "react";
import { ChevronDown, X } from "lucide-react";
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
import type { ModelKey, PrecomputedForecasts, RealDataset } from "../../contracts/types";
import { MODEL_ORDER } from "../../contracts/types";
import { CANDIDATE_POLICIES, findTask, pointValue } from "../lib/candidateRisk";
import { loadRealCsv } from "../lib/dataLoader";
import { buildLiveTask, mergeRows, toHourly } from "../lib/liveSeries";
import { parseLocalTimestampMs } from "../lib/trendChart";
import type { ParsedCsvRow } from "../types/app";
import { Card, Chip, SERIES_COLORS, SERIES_DASH } from "../components/ui";

interface Props {
  dataset: RealDataset;
  forecasts: PrecomputedForecasts | null;
  importedRows: ParsedCsvRow[];
}

const MODEL_LABEL: Record<ModelKey, string> = {
  persistence: "持續性",
  moving_average: "滑動平均",
  seasonal_naive_24h: "24h 季節",
  linear_ar4: "線性 AR",
  HGB: "HGB",
  XGB: "XGBoost",
};

const RANGES: Array<{ id: string; label: string; hours: number | null }> = [
  { id: "3d", label: "3 天", hours: 72 },
  { id: "7d", label: "7 天", hours: 168 },
  { id: "30d", label: "30 天", hours: 720 },
  { id: "all", label: "全部", hours: null },
];

const MAX_SERIES = 6;
const H = 3_600_000;

const fmtTick = (ms: number) => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}h`;
};

type Pt = { t: number; [k: string]: number | null | Record<string, number | null> };

export const DataPage: React.FC<Props> = ({ dataset, forecasts, importedRows }) => {
  const [baseRows, setBaseRows] = useState<ParsedCsvRow[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [overlay, setOverlay] = useState(true);
  const [normalize, setNormalize] = useState(true);
  const [rangeId, setRangeId] = useState("7d");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [showForecast, setShowForecast] = useState(false);
  const [horizon, setHorizon] = useState(3);
  const [model, setModel] = useState<ModelKey | "best">("best");
  const [listOpen, setListOpen] = useState(false);
  const [search, setSearch] = useState("");

  useEffect(() => {
    let cancelled = false;
    setBaseRows(null);
    setLoadErr(null);
    loadRealCsv(dataset.id)
      .then((d) => !cancelled && setBaseRows(d.rows))
      .catch((e) => !cancelled && setLoadErr(e instanceof TypeError ? "連不上資料伺服器（網頁伺服器可能已關閉）：請確認伺服器仍在執行後重新整理" : e instanceof Error ? e.message : "載入失敗"));
    return () => {
      cancelled = true;
    };
  }, [dataset.id]);

  useEffect(() => {
    const p = CANDIDATE_POLICIES[dataset.id];
    const first = dataset.columns.find((c) => c.key === p?.sensor) ?? dataset.columns.find((c) => c.n_observed > 0);
    setPicked(first ? [first.key] : []);
    setListOpen(false);
    setSearch("");
    setStartDate("");
    setEndDate("");
  }, [dataset.id, dataset.columns]);

  const rows = useMemo(() => (baseRows ? mergeRows(baseRows, importedRows) : []), [baseRows, importedRows]);
  const importStart = importedRows.length > 0 ? importedRows[0].tsMs : null;
  const columns = dataset.columns.filter((c) => c.n_observed > 0);
  const colByKey = useMemo(() => new Map(dataset.columns.map((c) => [c.key, c])), [dataset.columns]);
  const unitOf = (k: string) => colByKey.get(k)?.unit ?? "";

  const range = RANGES.find((r) => r.id === rangeId)!;
  const custom = startDate !== "" || endDate !== "";
  const bounds = useMemo(
    () => (rows.length > 0 ? { min: rows[0].timestamp.slice(0, 10), max: rows[rows.length - 1].timestamp.slice(0, 10) } : null),
    [rows]
  );
  const visibleRows = useMemo(() => {
    if (rows.length === 0) return rows;
    if (custom) {
      const from = startDate ? parseLocalTimestampMs(`${startDate} 00:00:00`) : -Infinity;
      const to = endDate ? parseLocalTimestampMs(`${endDate} 23:59:59`) : Infinity;
      return rows.filter((r) => r.tsMs >= from && r.tsMs <= to);
    }
    if (range.hours === null) return rows;
    const end = rows[rows.length - 1].tsMs;
    return rows.filter((r) => r.tsMs >= end - range.hours! * H);
  }, [rows, range, custom, startDate, endDate]);

  const units = new Set(picked.map(unitOf));
  const mixedUnits = units.size > 1;
  const doNormalize = overlay && picked.length > 1 && (normalize || mixedUnits);

  // 每個已選感測器的預測任務（預計算；有匯入資料時改用瀏覽器內的簡易基準預測）
  const tasks = useMemo(() => {
    const m = new Map<string, ReturnType<typeof findTask>>();
    for (const s of picked) {
      let t = null as ReturnType<typeof findTask>;
      if (importedRows.length > 0 && rows.length > 0) {
        t = buildLiveTask(dataset.id, s, unitOf(s), horizon, toHourly(rows, s));
      }
      if (!t) t = findTask(forecasts, dataset.id, s, horizon);
      m.set(s, t);
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked, importedRows, rows, forecasts, dataset.id, horizon]);

  const { points, ranges } = useMemo(() => {
    const byT = new Map<number, Pt>();
    const get = (t: number): Pt => {
      let p = byT.get(t);
      if (!p) {
        p = { t, __raw: {} };
        byT.set(t, p);
      }
      return p;
    };
    // 縮放（最小最大值，限於顯示範圍）
    const rng: Record<string, [number, number]> = {};
    const stride = Math.max(1, Math.ceil(visibleRows.length / 700));
    const used = visibleRows.filter((_, i) => i % stride === 0 || i === visibleRows.length - 1);
    for (const s of picked) {
      let lo = Infinity;
      let hi = -Infinity;
      for (const r of visibleRows) {
        const v = r.values[s];
        if (typeof v === "number") {
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
        }
      }
      rng[s] = [lo, hi];
    }
    const tr = (s: string, v: number) => {
      if (!doNormalize) return v;
      const [lo, hi] = rng[s];
      return hi > lo ? ((v - lo) / (hi - lo)) * 100 : 50;
    };
    const t0 = visibleRows.length > 0 ? visibleRows[0].tsMs : 0;
    for (const r of used) {
      const p = get(r.tsMs);
      for (const s of picked) {
        const v = r.values[s];
        if (typeof v === "number") {
          p[s] = tr(s, v);
          (p.__raw as Record<string, number | null>)[s] = v;
        }
      }
    }
    if (showForecast) {
      for (const s of picked) {
        const task = tasks.get(s);
        if (!task) continue;
        const col = (model === "best" ? task.best_baseline : model) as ModelKey;
        task.points.forEach((pt, i) => {
          const target = parseLocalTimestampMs(String(pt[1]));
          if (target < t0) return;
          const v = pointValue(task, i, col);
          if (v === null) return;
          const p = get(target);
          p[`${s}·預測`] = tr(s, v);
          (p.__raw as Record<string, number | null>)[`${s}·預測`] = v;
        });
      }
    }
    return { points: [...byT.values()].sort((a, b) => a.t - b.t), ranges: rng };
  }, [visibleRows, picked, showForecast, tasks, model, doNormalize]);

  const togglePick = (k: string) =>
    setPicked((p) => (p.includes(k) ? p.filter((x) => x !== k) : p.length >= MAX_SERIES ? p : [...p, k]));

  const forecastMissing = showForecast ? picked.filter((s) => !tasks.get(s)) : [];
  const filtered = columns.filter((c) => !search || c.key.toLowerCase().includes(search.toLowerCase()));

  const tooltipFmt = (payload: ReadonlyArray<{ dataKey?: unknown; color?: string; payload?: Pt }>, label: number) => (
    <div className="bg-white border border-slate-200 rounded-md shadow-sm px-2.5 py-2 text-xs space-y-0.5">
      <div className="font-semibold text-slate-900">{new Date(label).toLocaleString("zh-TW", { hour12: false }).slice(0, 16)}</div>
      {payload.map((p) => {
        const key = String(p.dataKey);
        const raw = (p.payload?.__raw as Record<string, number | null> | undefined)?.[key];
        const base = key.replace("·預測", "");
        return (
          <div key={key} className="flex items-center gap-1.5 text-slate-700">
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: p.color }} />
            <span>{key}</span>
            <span className="font-mono tabular-nums ml-auto pl-3">
              {typeof raw === "number" ? raw.toFixed(2) : "—"} {unitOf(base)}
            </span>
          </div>
        );
      })}
    </div>
  );

  const chartFor = (keys: string[], height: number, yLabel?: string) => {
    const seriesKeys = keys.flatMap((k) => (showForecast && tasks.get(k) ? [k, `${k}·預測`] : [k]));
    return (
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={points} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
          <CartesianGrid stroke="#e1e0d9" vertical={false} />
          <XAxis dataKey="t" type="number" scale="time" domain={["dataMin", "dataMax"]} tickFormatter={fmtTick} tick={{ fontSize: 11, fill: "#898781" }} minTickGap={48} />
          <YAxis
            tick={{ fontSize: 11, fill: "#898781" }}
            width={44}
            domain={doNormalize ? [0, 100] : ["auto", "auto"]}
            tickFormatter={(v: number) => (doNormalize ? `${Math.round(v)}%` : String(Math.round(v * 10) / 10))}
            label={yLabel ? { value: yLabel, angle: -90, position: "insideLeft", fontSize: 11, fill: "#898781" } : undefined}
          />
          <Tooltip content={({ payload, label }) => (payload && payload.length ? tooltipFmt(payload as never, Number(label)) : null)} />
          {importStart !== null && points.length > 0 && importStart >= points[0].t && (
            <ReferenceLine x={importStart} stroke="#898781" strokeDasharray="4 4" label={{ value: "匯入起點", fontSize: 10, fill: "#898781", position: "insideTopRight" }} />
          )}
          {seriesKeys.map((k) => {
            const base = k.replace("·預測", "");
            const idx = Math.max(0, picked.indexOf(base));
            const isF = k.endsWith("·預測");
            return (
              <Line
                key={k}
                dataKey={k}
                name={k}
                type="monotone"
                stroke={SERIES_COLORS[idx % SERIES_COLORS.length]}
                strokeWidth={isF ? 2 : 1.8}
                strokeDasharray={isF ? "5 3" : SERIES_DASH[idx % SERIES_DASH.length]}
                dot={isF ? { r: 2.5 } : false}
                activeDot={{ r: 4 }}
                connectNulls={isF}
                isAnimationActive={false}
              />
            );
          })}
          {keys.length * (showForecast ? 2 : 1) > 1 && <Legend wrapperStyle={{ fontSize: 12 }} />}
        </LineChart>
      </ResponsiveContainer>
    );
  };

  return (
    <div className="space-y-3">
      {/* 控制列 */}
      <Card className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <button
              type="button"
              onClick={() => setListOpen((o) => !o)}
              aria-expanded={listOpen}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-slate-300 bg-white text-sm font-medium text-slate-800 hover:bg-slate-50"
            >
              選擇數據（{picked.length}/{MAX_SERIES}）
              <ChevronDown className="h-4 w-4" />
            </button>
            {listOpen && (
              <div className="absolute z-20 mt-1 w-72 max-w-[85vw] bg-white border border-slate-200 rounded-md shadow-lg p-2">
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="搜尋感測器"
                  aria-label="搜尋感測器"
                  className="w-full mb-2 rounded border border-slate-300 px-2 py-1 text-sm"
                />
                <ul className="max-h-64 overflow-y-auto space-y-0.5" data-testid="sensor-list">
                  {filtered.map((c) => {
                    const on = picked.includes(c.key);
                    const disabled = !on && picked.length >= MAX_SERIES;
                    return (
                      <li key={c.key}>
                        <label className={`flex items-center gap-2 px-2 py-1 rounded text-sm ${disabled ? "opacity-40" : "hover:bg-slate-50 cursor-pointer"}`}>
                          <input type="checkbox" checked={on} disabled={disabled} onChange={() => togglePick(c.key)} />
                          <span className="truncate">{c.key}</span>
                          <span className="ml-auto text-[11px] text-slate-400">{c.unit}</span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </div>
          {picked.map((k, i) => (
            <span key={k} className="inline-flex items-center gap-1.5 pl-2 pr-1 py-1 rounded-md bg-slate-100 text-xs text-slate-800">
              <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: SERIES_COLORS[i % SERIES_COLORS.length] }} />
              {k}
              <button type="button" aria-label={`移除 ${k}`} onClick={() => togglePick(k)} className="p-0.5 rounded hover:bg-slate-200">
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="flex gap-1" role="group" aria-label="範圍">
            {RANGES.map((r) => (
              <Chip
                key={r.id}
                active={!custom && rangeId === r.id}
                onClick={() => {
                  setRangeId(r.id);
                  setStartDate("");
                  setEndDate("");
                }}
              >
                {r.label}
              </Chip>
            ))}
          </div>
          <div className="flex items-center gap-1.5 text-xs text-slate-600" role="group" aria-label="日期範圍">
            <label className="inline-flex items-center gap-1">
              起點
              <input
                type="date"
                value={startDate}
                min={bounds?.min}
                max={endDate || bounds?.max}
                onChange={(e) => setStartDate(e.target.value)}
                aria-label="起始日期"
                className={`rounded-md border px-1.5 py-1 text-xs ${startDate ? "border-[#0B63CE] bg-[#EFF6FF]" : "border-slate-300 bg-white"}`}
              />
            </label>
            <label className="inline-flex items-center gap-1">
              終點
              <input
                type="date"
                value={endDate}
                min={startDate || bounds?.min}
                max={bounds?.max}
                onChange={(e) => setEndDate(e.target.value)}
                aria-label="結束日期"
                className={`rounded-md border px-1.5 py-1 text-xs ${endDate ? "border-[#0B63CE] bg-[#EFF6FF]" : "border-slate-300 bg-white"}`}
              />
            </label>
            {custom && (
              <button
                type="button"
                onClick={() => {
                  setStartDate("");
                  setEndDate("");
                }}
                className="text-slate-500 hover:underline"
              >
                清除
              </button>
            )}
          </div>
          <div className="flex gap-1" role="group" aria-label="顯示方式">
            <Chip active={overlay} onClick={() => setOverlay(true)}>
              疊圖
            </Chip>
            <Chip active={!overlay} onClick={() => setOverlay(false)}>
              分圖
            </Chip>
          </div>
          {overlay && picked.length > 1 && (
            <label className="inline-flex items-center gap-1.5 text-xs text-slate-700">
              <input type="checkbox" checked={doNormalize} disabled={mixedUnits} onChange={(e) => setNormalize(e.target.checked)} />
              標準化（0–100%）
            </label>
          )}
          <div className="flex items-center gap-1.5">
            <Chip active={showForecast} onClick={() => setShowForecast((v) => !v)}>
              加入預測
            </Chip>
            {showForecast && (
              <>
                <select
                  value={horizon}
                  onChange={(e) => setHorizon(Number(e.target.value))}
                  aria-label="預測時距"
                  className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs"
                >
                  {[1, 3, 6].map((h) => (
                    <option key={h} value={h}>
                      +{h} 小時
                    </option>
                  ))}
                </select>
                <select
                  value={model}
                  onChange={(e) => setModel(e.target.value as ModelKey | "best")}
                  aria-label="預測方法"
                  className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs"
                >
                  <option value="best">最佳基準</option>
                  {MODEL_ORDER.map((m) => (
                    <option key={m} value={m}>
                      {MODEL_LABEL[m]}
                    </option>
                  ))}
                </select>
              </>
            )}
          </div>
        </div>
        {forecastMissing.length > 0 && <div className="text-xs text-amber-800">無預測：{forecastMissing.join("、")}</div>}
      </Card>

      {/* 圖 */}
      <Card data-testid="data-chart">
        {loadErr ? (
          <div className="text-sm text-red-700">{loadErr}</div>
        ) : !baseRows ? (
          <div className="h-72 grid place-items-center text-sm text-slate-500">載入中…</div>
        ) : picked.length === 0 ? (
          <div className="h-72 grid place-items-center text-sm text-slate-500">請選擇數據</div>
        ) : visibleRows.length === 0 ? (
          <div className="h-72 grid place-items-center text-sm text-slate-500" data-testid="no-rows">
            這段日期沒有資料{bounds ? `（資料範圍 ${bounds.min} ～ ${bounds.max}）` : ""}
          </div>
        ) : overlay ? (
          chartFor(picked, 360, doNormalize ? undefined : units.size === 1 ? [...units][0] : undefined)
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {picked.map((k) => (
              <div key={k}>
                <div className="text-xs font-semibold text-slate-700 mb-1">
                  {k} <span className="font-normal text-slate-400">{unitOf(k)}</span>
                  {ranges[k] && Number.isFinite(ranges[k][0]) && (
                    <span className="font-normal text-slate-400 ml-2">
                      {ranges[k][0].toFixed(1)}～{ranges[k][1].toFixed(1)}
                    </span>
                  )}
                </div>
                {chartFor([k], 200)}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
};
