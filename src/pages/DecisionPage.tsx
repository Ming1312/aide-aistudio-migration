import React, { useEffect, useMemo, useRef, useState } from "react";
import { Lock, Sparkles } from "lucide-react";
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
import { askAi, type AiResult } from "../lib/ai";
import { analyzeLocal, buildDomainFacts } from "../lib/qa";
import { loadJson, saveJson } from "../lib/storage";
import { SAFETY_TEXT, fmtVal, taskFor, type DomainStatus, type StatusInput } from "../lib/status";
import { Card, SAFETY_STYLE, SafetyBadge } from "../components/ui";

interface Props {
  status: DomainStatus;
  input: StatusInput;
  onOpenData: () => void;
  onOpenEvents: () => void;
  canRecord: boolean;
  onLogin: () => void;
}

interface LogEntry {
  at: string;
  datasetId: string;
  level: string;
  chosen: string[];
  note: string;
}

const LOG_KEY = "aide.decisions.v1";
const IGNORE = "忽略（不處理）";
const LATER = "稍後複查";

const hhmm = (ts: string) => ts.slice(5, 16).replace("-", "/");

interface Row {
  label: string;
  obs?: number | null;
  fc?: number | null;
  band?: [number, number] | null;
}

export const DecisionPage: React.FC<Props> = ({ status: domainStatus, input, onOpenData, onOpenEvents, canRecord, onLogin }) => {
  // 這個場域有多個受監看的感測器：預設看最嚴重的那個，也可以用上方的按鈕換
  const [selSensor, setSelSensor] = useState<string | null>(null);
  useEffect(() => setSelSensor(null), [domainStatus.datasetId]);
  const status = domainStatus.sensorStatuses.find((x) => x.sensor === selSensor) ?? domainStatus;
  const [ai, setAi] = useState<AiResult | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [chosen, setChosen] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [log, setLog] = useState<LogEntry[]>(() => loadJson<LogEntry[]>(LOG_KEY, []));
  const cache = useRef(new Map<string, AiResult | null>());
  const policy = status.policy;

  const key = `${status.datasetId}|${status.sensor}|${status.asOf}|${status.level}|${status.source}|${policy?.caution}|${policy?.alarm}|${status.quality?.masked ?? 0}`;
  useEffect(() => {
    setChosen([]);
    setNote("");
    if (!status.hasModel) {
      setAi(null);
      return;
    }
    if (cache.current.has(key)) {
      setAi(cache.current.get(key) ?? null);
      return;
    }
    let cancelled = false;
    setAiBusy(true);
    setAi(null);
    askAi(status.datasetId, buildDomainFacts(status), "請分析目前數據狀況，指出需要注意的重點。").then((r) => {
      if (cancelled) return;
      cache.current.set(key, r);
      setAi(r);
      setAiBusy(false);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const analysis: string[] = ai ? ai.lines : analyzeLocal(status);

  const options = useMemo(() => {
    if (!policy) return [] as string[];
    const base =
      status.level === "danger"
        ? policy.actions.alarm
        : status.level === "data"
          ? policy.actions.dataSuspect
          : status.level === "caution"
            ? policy.actions.caution
            : ["持續觀察"];
    return [...base, LATER, IGNORE];
  }, [policy, status.level]);

  // 圖：最近 72 小時觀測 ＋ 1／3 小時預測（含 90% 區間）
  const rows = useMemo<Row[]>(() => {
    if (!policy) return [];
    if (status.source === "engine" && status.history && status.history.length > 0) {
      const eo: Row[] = status.history.map((p) => ({ label: hhmm(p.t), obs: p.v }));
      const last = eo[eo.length - 1];
      if (last) last.fc = last.obs ?? null;
      for (const h of status.horizons) eo.push({ label: hhmm(h.target), fc: h.point, band: null });
      return eo;
    }
    const t1 = taskFor(input, policy, 1).task;
    if (!t1) return [];
    const pts = t1.points.slice(-72);
    const out: Row[] = pts.map((p) => ({ label: hhmm(String(p[0])), obs: typeof p[4] === "number" ? p[4] : null }));
    const last = out[out.length - 1];
    if (last) last.fc = last.obs ?? null;
    for (const h of status.horizons) {
      out.push({
        label: hhmm(h.target),
        fc: h.point,
        band: h.lower !== null && h.upper !== null ? [h.lower, h.upper] : null,
      });
    }
    return out;
  }, [policy, input, status.horizons, status.source, status.history]);

  const save = () => {
    if (!canRecord || chosen.length === 0) return;
    const entry: LogEntry = {
      at: new Date().toLocaleString("zh-TW", { hour12: false }),
      datasetId: status.datasetId,
      level: SAFETY_TEXT[status.level],
      chosen,
      note: note.trim().slice(0, 200),
    };
    const next = [entry, ...log].slice(0, 50);
    setLog(next);
    saveJson(LOG_KEY, next);
    setChosen([]);
    setNote("");
  };

  if (!status.hasModel || !policy) {
    return (
      <Card>
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="font-semibold text-slate-900">{status.name}</div>
            <div className="text-sm text-slate-600 mt-0.5">{status.noModelReason}</div>
          </div>
          <button type="button" onClick={onOpenData} className="px-3 py-1.5 rounded-md bg-[#0B63CE] text-white text-sm font-medium">
            看資料
          </button>
        </div>
      </Card>
    );
  }

  const st = SAFETY_STYLE[status.level];
  const myLog = log.filter((l) => l.datasetId === status.datasetId).slice(0, 5);
  const domain = rows.length > 0 ? ([
    Math.min(policy.caution, policy.alarm, ...rows.flatMap((r) => [r.obs ?? Infinity, r.fc ?? Infinity, r.band?.[0] ?? Infinity])),
    Math.max(policy.caution, policy.alarm, ...rows.flatMap((r) => [r.obs ?? -Infinity, r.fc ?? -Infinity, r.band?.[1] ?? -Infinity])),
  ] as [number, number]) : undefined;

  return (
    <div className="space-y-3">
      {domainStatus.sensorStatuses.length > 1 && (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="感測器" data-testid="sensor-chips">
          {domainStatus.sensorStatuses.map((x) => {
            const active = (selSensor ?? domainStatus.sensor) === x.sensor;
            return (
              <button
                key={x.sensor}
                type="button"
                onClick={() => setSelSensor(x.sensor)}
                aria-pressed={active}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-xs font-medium ${
                  active ? "bg-slate-900 border-slate-900 text-white" : "bg-white border-slate-300 text-slate-700 hover:bg-slate-50"
                }`}
              >
                <span className="inline-block h-2 w-2 rounded-full" style={{ background: SAFETY_STYLE[x.level].dot }} aria-hidden />
                {x.sensor}
                <span className="sr-only">{SAFETY_TEXT[x.level]}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* 狀態 */}
      <section className={`rounded-lg border p-4 flex flex-wrap items-center justify-between gap-3 ${st.bg} ${st.border} ${st.text}`} data-testid="decision-status" data-level={status.level}>
        <div>
          <div className="text-lg font-bold leading-tight">{status.name.split("（")[0]}</div>
          <div className="text-xs mt-0.5 opacity-80">
            {policy.sensor} 目前 {fmtVal(status.current)} {status.unit} ·{" "}
            {status.horizons.map((h) => `+${h.h}h ${fmtVal(h.point)}`).join(" · ")}
          </div>
        </div>
        <SafetyBadge level={status.level} className="text-sm" />
      </section>

      {status.incomplete && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-950" data-testid="incomplete-note">
          {status.incomplete}
          {status.asOf ? `（分析時點 ${status.asOf.slice(0, 16)}）` : ""}
        </div>
      )}

      {domainStatus.quality && domainStatus.quality.masked > 0 && (
        <div className="rounded-md border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 flex flex-wrap items-center justify-between gap-2" data-testid="quality-note">
          <span>
            已排除 {domainStatus.quality.masked} 項資料事件（約 {domainStatus.quality.maskedHours} 小時，斷線、缺值、卡住等）：不納入簡易預測與門檻，分析以正常資料為準。
          </span>
          <button type="button" onClick={onOpenEvents} className="font-semibold text-[#0B63CE] hover:underline whitespace-nowrap">
            查看事件 →
          </button>
        </div>
      )}

      {/* AI 分析 */}
      <Card
        title={
          <span className="inline-flex items-center gap-1.5">
            <Sparkles className="h-4 w-4 text-[#0B63CE]" />
            AI 分析
          </span>
        }
        right={<span className="text-[10px] text-slate-500">{aiBusy ? "分析中…" : ai ? "Gemini" : "規則式"}{status.source === "engine" ? (status.synthetic ? " · 引擎模擬流" : " · 引擎即時") : ""}</span>}
      >
        <ul className="space-y-1.5 text-sm text-slate-800" data-testid="ai-analysis">
          {aiBusy ? <li className="h-4 w-2/3 bg-slate-100 rounded animate-pulse" /> : analysis.map((l, i) => <li key={i}>• {l}</li>)}
        </ul>
      </Card>

      {/* 圖 */}
      <Card
        title={`${policy.sensor}（${status.unit}）`}
        right={
          <span className="text-[10px] text-slate-500" title={status.thresholdNote} data-testid="threshold-label">
            門檻：注意 {policy.caution}／警戒 {policy.alarm}（{status.thresholdSource === "history" ? "歷史百分位" : status.thresholdSource === "admin" ? "管理員調整" : "假定值"}）
          </span>
        }
      >
        <ResponsiveContainer width="100%" height={260}>
          <ComposedChart data={rows} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
            <CartesianGrid stroke="#e1e0d9" vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#898781" }} minTickGap={40} />
            <YAxis tick={{ fontSize: 11, fill: "#898781" }} width={44} domain={domain ? [Math.floor(domain[0]), Math.ceil(domain[1])] : ["auto", "auto"]} />
            <Tooltip formatter={(v: unknown) => (Array.isArray(v) ? `${fmtVal(v[0], 2)}～${fmtVal(v[1], 2)}` : fmtVal(Number(v), 2))} />
            <ReferenceLine y={policy.caution} stroke="#fab219" strokeDasharray="4 3" label={{ value: "注意", fontSize: 10, fill: "#52514e", position: "insideTopLeft" }} />
            <ReferenceLine y={policy.alarm} stroke="#d03b3b" strokeDasharray="4 3" label={{ value: "警戒", fontSize: 10, fill: "#52514e", position: "insideTopLeft" }} />
            <Area dataKey="band" name="90% 區間" stroke="none" fill="#2a78d6" fillOpacity={0.15} isAnimationActive={false} connectNulls />
            <Line dataKey="obs" name="觀測" stroke="#2a78d6" strokeWidth={1.8} dot={false} isAnimationActive={false} connectNulls />
            <Line dataKey="fc" name="預測" stroke="#eb6834" strokeWidth={2} strokeDasharray="5 3" dot={{ r: 3 }} isAnimationActive={false} connectNulls />
          </ComposedChart>
        </ResponsiveContainer>
      </Card>

      {/* 意見與決策 */}
      <Card title="建議選項" right={<span className="text-[10px] text-slate-500">系統不控制設備</span>}>
        <div className="space-y-1.5" data-testid="decision-options">
          {options.map((o) => {
            const on = chosen.includes(o);
            return (
              <label
                key={o}
                className={`flex items-start gap-2.5 px-3 py-2 rounded-md border text-sm cursor-pointer ${
                  on ? "border-[#0B63CE] bg-[#EFF6FF]" : "border-slate-200 hover:bg-slate-50"
                }`}
              >
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={on}
                  onChange={() => setChosen((c) => (c.includes(o) ? c.filter((x) => x !== o) : [...c, o]))}
                />
                <span>{o}</span>
              </label>
            );
          })}
        </div>
        {canRecord ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={200}
            placeholder="備註（選填）"
            aria-label="備註"
            className="flex-1 min-w-[10rem] rounded-md border border-slate-300 px-3 py-1.5 text-sm"
          />
          <button
            type="button"
            onClick={save}
            disabled={chosen.length === 0}
            className="px-4 py-1.5 rounded-md bg-[#0B63CE] text-white text-sm font-semibold disabled:opacity-40"
          >
            記錄決策
          </button>
        </div>
        ) : (
          <div className="mt-3 flex items-center gap-2 text-xs text-slate-500" data-testid="record-locked">
            <Lock className="h-3.5 w-3.5" />
            記錄決策需要員工或管理員身分
            <button type="button" onClick={onLogin} className="font-semibold text-[#0B63CE] hover:underline">
              登入
            </button>
          </div>
        )}
        {myLog.length > 0 && (
          <ul className="mt-3 pt-3 border-t border-slate-100 space-y-1 text-xs text-slate-600" data-testid="decision-log">
            {myLog.map((l, i) => (
              <li key={i}>
                <span className="text-slate-400 mr-2">{l.at}</span>
                {l.level}：{l.chosen.join("、")}
                {l.note && <span className="text-slate-400">（{l.note}）</span>}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
};
