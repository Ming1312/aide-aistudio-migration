import React, { useMemo, useState } from "react";
import { ChevronDown, Lock, Plus, Trash2 } from "lucide-react";
import type { RealDataset } from "../../contracts/types";
import type { ParsedCsvRow } from "../types/app";
import {
  GROUP_ZH,
  KIND_INFO,
  KIND_ORDER,
  STATUS_ZH,
  sensorCompleteness,
  summarize,
  type EventAnnotation,
  type EventGroup,
  type EventKind,
  type EventStatus,
  type MaskResult,
  type ResolvedEvent,
} from "../lib/events";
import type { NewManualEvent } from "../lib/useEventLog";
import { Card, Chip } from "../components/ui";

interface Props {
  dataset: RealDataset;
  events: ResolvedEvent[];
  rows: ParsedCsvRow[] | null;
  masked: MaskResult | null;
  canManage: boolean;
  onAnnotate: (id: string, patch: EventAnnotation) => void;
  onAddManual: (e: NewManualEvent) => void;
  onRemoveManual: (id: string) => void;
  onLogin: () => void;
  historyCount: number;
}

// 事件類別色（類別型，固定順序；每個類別同時有文字標籤，不單靠顏色）
export const GROUP_COLOR: Record<EventGroup, string> = { fault: "#eb6834", suspect: "#6250d6", real: "#2a78d6", note: "#898781" };
const SOURCE_ZH = { precomputed: "離線偵測器", detected: "資料偵測", manual: "人工記錄" } as const;
const MANUAL_KINDS: EventKind[] = ["maintenance", "outage_zero", "missing", "stuck", "spike", "drift", "other"];
const PAGE = 30;

const mmdd = (s: string) => s.slice(5, 16);

const KindDot: React.FC<{ kind: EventKind }> = ({ kind }) => (
  <span className="inline-block h-2.5 w-2.5 rounded-sm shrink-0" style={{ background: GROUP_COLOR[KIND_INFO[kind].group] }} aria-hidden />
);

const Tile: React.FC<{ label: string; value: React.ReactNode; hint?: string }> = ({ label, value, hint }) => (
  <div className="rounded-lg border border-slate-200 bg-white px-3.5 py-3">
    <div className="text-[11px] text-slate-500">{label}</div>
    <div className="text-2xl font-bold tabular-nums text-slate-900 leading-tight">{value}</div>
    {hint && <div className="text-[11px] text-slate-500 mt-0.5">{hint}</div>}
  </div>
);

export const EventsPage: React.FC<Props> = ({ dataset, events, rows, masked, canManage, onAnnotate, onAddManual, onRemoveManual, onLogin, historyCount }) => {
  const [kinds, setKinds] = useState<Set<EventKind>>(new Set());
  const [sensor, setSensor] = useState("");
  const [onlyMasked, setOnlyMasked] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const [focus, setFocus] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [showComp, setShowComp] = useState(false);

  const sum = useMemo(() => summarize(events), [events]);
  const kindCounts = useMemo(() => KIND_ORDER.filter((k) => (sum.byKind[k] ?? 0) > 0).map((k) => ({ kind: k, n: sum.byKind[k] ?? 0 })), [sum]);
  const sensorsWithEvents = useMemo(() => Object.entries(sum.bySensor).sort((a, b) => b[1] - a[1]), [sum]);

  const shown = useMemo(
    () => events.filter((e) => (kinds.size === 0 || kinds.has(e.kind)) && (!sensor || e.sensor === sensor) && (!onlyMasked || e.mask)),
    [events, kinds, sensor, onlyMasked]
  );

  const sensors = useMemo(() => (rows && rows[0] ? Array.from(new Set(rows.slice(0, 5).flatMap((r) => Object.keys(r.values)))) : []), [rows]);
  const comp = useMemo(() => (rows && masked ? sensorCompleteness(rows, sensors, masked).sort((a, b) => a.validPct - b.validPct) : []), [rows, masked, sensors]);
  const avgComplete = comp.length ? comp.reduce((a, c) => a + c.validPct, 0) / comp.length : null;

  const toggleKind = (k: EventKind) =>
    setKinds((cur) => {
      const n = new Set(cur);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  return (
    <div className="space-y-4" data-testid="events-page">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Tile label="事件紀錄" value={sum.total} hint={historyCount > 0 ? `本裝置累計記錄 ${historyCount} 筆（全場域）` : undefined} />
        <Tile label="已排除於分析" value={sum.masked} hint="不進門檻與簡易預測" />
        <Tile label="受影響時數" value={`${sum.maskedHours} h`} hint="至少一個感測器被排除" />
        <Tile label="資料完整度" value={avgComplete === null ? "—" : `${avgComplete.toFixed(1)}%`} hint="各感測器有效讀值平均" />
      </div>

      {!canManage && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-700">
          <span className="inline-flex items-center gap-2">
            <Lock className="h-4 w-4 text-slate-400" />
            訪客只能查看；員工以上可標註與補記事件
          </span>
          <button type="button" onClick={onLogin} className="px-3 py-1.5 rounded-md bg-[#0B63CE] text-white text-xs font-semibold hover:bg-[#0952AD]">
            登入
          </button>
        </div>
      )}

      <Card title={`${dataset.display_name.split("（")[0]} 事件時間軸`}>
        {events.length === 0 ? (
          <div className="text-sm text-slate-500 py-6 text-center">這個場域目前沒有事件紀錄。</div>
        ) : (
          <>
            <div className="flex flex-wrap gap-1.5 mb-3" role="group" aria-label="事件類型（可複選篩選）">
              {kindCounts.map(({ kind, n }) => (
                <Chip key={kind} active={kinds.has(kind)} onClick={() => toggleKind(kind)} title={GROUP_ZH[KIND_INFO[kind].group]}>
                  <span className="inline-flex items-center gap-1.5">
                    {!kinds.has(kind) && <KindDot kind={kind} />}
                    {KIND_INFO[kind].zh} {n}
                  </span>
                </Chip>
              ))}
            </div>
            <Timeline events={shown} allEvents={events} rows={rows} focus={focus} onFocus={setFocus} />
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-600" aria-label="圖例">
              {(Object.keys(GROUP_ZH) as EventGroup[]).map((g) => (
                <span key={g} className="inline-flex items-center gap-1.5">
                  <span className="inline-block h-2.5 w-4 rounded-sm" style={{ background: GROUP_COLOR[g] }} />
                  {GROUP_ZH[g]}
                </span>
              ))}
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-block h-2.5 w-4 rounded-sm border" style={{ borderColor: "#475569", background: "repeating-linear-gradient(45deg,#fff 0 2px,#94a3b8 2px 3px)" }} />
                淡色＝保留在分析中
              </span>
            </div>
          </>
        )}
      </Card>

      <Card
        title={`事件清單（${shown.length}）`}
        right={
          <div className="flex items-center gap-2">
            <label className="inline-flex items-center gap-1.5 text-xs text-slate-700">
              <input type="checkbox" checked={onlyMasked} onChange={(e) => setOnlyMasked(e.target.checked)} />
              只看排除中
            </label>
            <select
              value={sensor}
              onChange={(e) => setSensor(e.target.value)}
              aria-label="感測器"
              className="max-w-[9rem] rounded-md border border-slate-300 bg-white px-2 py-1 text-xs"
            >
              <option value="">全部感測器</option>
              {sensorsWithEvents.map(([s, n]) => (
                <option key={s} value={s}>
                  {s === "*" ? "整個場域" : s}（{n}）
                </option>
              ))}
            </select>
          </div>
        }
      >
        {shown.length === 0 ? (
          <div className="text-sm text-slate-500 py-4 text-center">沒有符合條件的事件。</div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {shown.slice(0, limit).map((e) => (
              <EventRow
                key={e.id}
                e={e}
                canManage={canManage}
                focused={focus === e.id}
                onAnnotate={onAnnotate}
                onRemoveManual={onRemoveManual}
              />
            ))}
          </ul>
        )}
        {shown.length > limit && (
          <button type="button" onClick={() => setLimit((l) => l + PAGE)} className="mt-3 w-full py-2 rounded-md border border-slate-300 text-sm text-slate-700 hover:bg-slate-50">
            顯示更多（還有 {shown.length - limit} 筆）
          </button>
        )}
      </Card>

      {canManage && (
        <Card
          title="補記事件"
          right={
            <button type="button" onClick={() => setShowAdd((v) => !v)} className="inline-flex items-center gap-1 text-xs font-semibold text-[#0B63CE]">
              <Plus className="h-3.5 w-3.5" />
              {showAdd ? "收起" : "新增"}
            </button>
          }
        >
          {showAdd ? (
            <AddForm sensors={sensors} datasetId={dataset.id} onAdd={(e) => { onAddManual(e); setShowAdd(false); }} />
          ) : (
            <div className="text-xs text-slate-500">偵測不到的事件（例如維修、校正、停電通知）可以自己補記，並選擇是否排除於分析。</div>
          )}
        </Card>
      )}

      <Card
        title="各感測器完整度"
        right={
          <button type="button" onClick={() => setShowComp((v) => !v)} className="inline-flex items-center gap-1 text-xs text-slate-600" aria-expanded={showComp}>
            {showComp ? "收起" : "展開"}
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showComp ? "rotate-180" : ""}`} />
          </button>
        }
      >
        {comp.length === 0 ? (
          <div className="text-xs text-slate-500">資料載入中…</div>
        ) : (
          <ul className="space-y-1.5">
            {(showComp ? comp : comp.slice(0, 5)).map((c) => (
              <li key={c.sensor} className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-2 text-xs">
                <span className="truncate text-slate-800" title={c.sensor}>
                  {c.sensor}
                </span>
                <span className="h-2 rounded bg-slate-100 overflow-hidden" aria-hidden>
                  <span className="block h-full bg-[#2a78d6]" style={{ width: `${c.validPct}%` }} />
                </span>
                <span className="tabular-nums text-slate-700 w-28 text-right">
                  {c.validPct.toFixed(1)}%{c.excluded > 0 ? `・排除 ${c.excluded}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
        {!showComp && comp.length > 5 && <div className="mt-2 text-[11px] text-slate-500">先顯示最不完整的 5 個感測器</div>}
      </Card>
    </div>
  );
};

// ---------- 時間軸 ----------

const Timeline: React.FC<{ events: ResolvedEvent[]; allEvents: ResolvedEvent[]; rows: ParsedCsvRow[] | null; focus: string | null; onFocus: (id: string | null) => void }> = ({
  events,
  allEvents,
  rows,
  focus,
  onFocus,
}) => {
  const W = 760;
  const LABEL = 110;
  const ROW = 18;
  const lanes = useMemo(() => {
    const cnt = new Map<string, number>();
    for (const e of allEvents) cnt.set(e.sensor, (cnt.get(e.sensor) ?? 0) + 1);
    return [...cnt.entries()]
      .sort((a, b) => (a[0] === "*" ? -1 : b[0] === "*" ? 1 : b[1] - a[1]))
      .slice(0, 12)
      .map(([s]) => s);
  }, [allEvents]);
  const lo = Math.min(rows?.[0]?.tsMs ?? Infinity, ...allEvents.map((e) => e.startMs));
  const hi = Math.max(rows?.[rows.length - 1]?.tsMs ?? -Infinity, ...allEvents.map((e) => e.endMs));
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return null;
  const x = (ms: number) => LABEL + ((ms - lo) / (hi - lo)) * (W - LABEL - 8);
  const H = lanes.length * ROW + 22;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => lo + f * (hi - lo));
  const tick = (ms: number) => {
    const d = new Date(ms);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  };
  const hiddenLanes = new Set(events.map((e) => e.sensor));
  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[520px]" role="img" aria-label={`事件時間軸：${lanes.length} 個感測器、${allEvents.length} 筆事件；詳細內容見下方事件清單`}>
        {lanes.map((s, i) => (
          <g key={s}>
            <line x1={LABEL} x2={W - 8} y1={i * ROW + ROW - 2} y2={i * ROW + ROW - 2} stroke="#e2e8f0" strokeWidth={1} />
            <text x={LABEL - 6} y={i * ROW + 12} textAnchor="end" fontSize={10} fill="#475569">
              {(s === "*" ? "整個場域" : s).slice(0, 14)}
            </text>
          </g>
        ))}
        {ticks.map((t, i) => (
          <text key={i} x={x(t)} y={H - 4} textAnchor={i === 0 ? "start" : i === ticks.length - 1 ? "end" : "middle"} fontSize={10} fill="#64748b">
            {tick(t)}
          </text>
        ))}
        {events.map((e) => {
          const lane = lanes.indexOf(e.sensor);
          if (lane < 0 || !hiddenLanes.has(e.sensor)) return null;
          const x1 = x(e.startMs);
          const w = Math.max(3, x(e.endMs + 3_600_000) - x1);
          const color = GROUP_COLOR[KIND_INFO[e.kind].group];
          return (
            <rect
              key={e.id}
              x={x1}
              y={lane * ROW + 3}
              width={w}
              height={ROW - 7}
              rx={2}
              fill={color}
              fillOpacity={e.mask ? 0.95 : 0.35}
              stroke={focus === e.id ? "#0f172a" : e.mask ? "none" : color}
              strokeWidth={focus === e.id ? 2 : 1}
              onClick={() => onFocus(focus === e.id ? null : e.id)}
              style={{ cursor: "pointer" }}
            >
              <title>{`${KIND_INFO[e.kind].zh}｜${e.sensor === "*" ? "整個場域" : e.sensor}｜${mmdd(e.start)} ~ ${mmdd(e.end)}（${e.hours} 小時）${e.mask ? "｜排除於分析" : ""}`}</title>
            </rect>
          );
        })}
      </svg>
    </div>
  );
};

// ---------- 單一事件 ----------

const EventRow: React.FC<{
  e: ResolvedEvent;
  canManage: boolean;
  focused: boolean;
  onAnnotate: (id: string, patch: EventAnnotation) => void;
  onRemoveManual: (id: string) => void;
}> = ({ e, canManage, focused, onAnnotate, onRemoveManual }) => {
  const info = KIND_INFO[e.kind];
  const [comment, setComment] = useState(e.comment);
  const ref = React.useRef<HTMLLIElement>(null);
  React.useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [focused]);
  return (
    <li ref={ref} className={`py-3 ${focused ? "bg-sky-50 -mx-2 px-2 rounded" : ""}`} data-testid="event-row" data-kind={e.kind} data-mask={e.mask ? "1" : "0"}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
            <span className="inline-flex items-center gap-1.5 font-semibold text-slate-900">
              <KindDot kind={e.kind} />
              {info.zh}
            </span>
            <span className="text-slate-700 truncate">{e.sensor === "*" ? "整個場域" : e.sensor}</span>
          </div>
          <div className="text-xs text-slate-600 tabular-nums">
            {e.start.slice(0, 16)} → {e.end.slice(0, 16)}（{e.hours} 小時）
          </div>
          <div className="text-[11px] text-slate-500 mt-0.5">
            {SOURCE_ZH[e.source]}
            {e.firstSeen && e.source !== "precomputed" ? `・首次記錄 ${e.firstSeen}` : ""}
            {e.archived ? "・目前資料已看不到（僅留歷史）" : ""}
            {e.note ? `・${e.note}` : ""}
          </div>
        </div>
        <label className={`shrink-0 inline-flex flex-col items-center gap-0.5 text-[10px] ${canManage ? "text-slate-700" : "text-slate-400"}`} title={canManage ? "排除後不進門檻與簡易預測" : "需要員工以上登入"}>
          <button
            type="button"
            role="switch"
            aria-checked={e.mask}
            aria-label="排除於分析"
            disabled={!canManage}
            onClick={() => onAnnotate(e.id, { mask: !e.mask })}
            className={`relative h-5 w-9 rounded-full transition-colors ${e.mask ? "bg-[#0B63CE]" : "bg-slate-300"} ${canManage ? "" : "opacity-60 cursor-not-allowed"}`}
          >
            <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${e.mask ? "left-[18px]" : "left-0.5"}`} />
          </button>
          排除於分析
        </label>
      </div>
      {canManage && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <select
            value={e.status ?? ""}
            onChange={(ev) => onAnnotate(e.id, { status: (ev.target.value || undefined) as EventStatus | undefined })}
            aria-label="判斷"
            className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs"
          >
            <option value="">未判斷</option>
            {(Object.keys(STATUS_ZH) as EventStatus[]).map((s) => (
              <option key={s} value={s}>
                {STATUS_ZH[s]}
              </option>
            ))}
          </select>
          <input
            value={comment}
            onChange={(ev) => setComment(ev.target.value)}
            onBlur={() => comment !== e.comment && onAnnotate(e.id, { comment })}
            maxLength={200}
            placeholder="備註（原因、處理方式）"
            aria-label="備註"
            className="flex-1 min-w-[10rem] rounded-md border border-slate-300 px-2 py-1 text-xs focus:border-[#0B63CE] focus:outline-none"
          />
          {e.source === "manual" && (
            <button type="button" onClick={() => onRemoveManual(e.id)} className="p-1.5 rounded text-slate-500 hover:text-rose-700 hover:bg-rose-50" aria-label="刪除這筆補記">
              <Trash2 className="h-4 w-4" />
            </button>
          )}
        </div>
      )}
      {!canManage && e.comment && <div className="mt-1 text-xs text-slate-700">備註：{e.comment}</div>}
    </li>
  );
};

// ---------- 補記 ----------

const AddForm: React.FC<{ sensors: string[]; datasetId: string; onAdd: (e: NewManualEvent) => void }> = ({ sensors, datasetId, onAdd }) => {
  const [sensor, setSensor] = useState("*");
  const [kind, setKind] = useState<EventKind>("maintenance");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const submit = (ev: React.FormEvent) => {
    ev.preventDefault();
    const a = Date.parse(start);
    const b = Date.parse(end || start);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return setErr("請選擇開始時間");
    if (b < a) return setErr("結束時間不能早於開始時間");
    setErr(null);
    onAdd({ datasetId, sensor, kind, startMs: a, endMs: b, note });
  };
  return (
    <form onSubmit={submit} className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
      <label className="block">
        <span className="block text-xs text-slate-600 mb-1">感測器</span>
        <select value={sensor} onChange={(e) => setSensor(e.target.value)} className="w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5">
          <option value="*">整個場域</option>
          {sensors.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="block text-xs text-slate-600 mb-1">類型</span>
        <select value={kind} onChange={(e) => setKind(e.target.value as EventKind)} className="w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5">
          {MANUAL_KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_INFO[k].zh}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="block text-xs text-slate-600 mb-1">開始</span>
        <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} className="w-full rounded-md border border-slate-300 px-2.5 py-1.5" />
      </label>
      <label className="block">
        <span className="block text-xs text-slate-600 mb-1">結束</span>
        <input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} className="w-full rounded-md border border-slate-300 px-2.5 py-1.5" />
      </label>
      <label className="block sm:col-span-2">
        <span className="block text-xs text-slate-600 mb-1">說明</span>
        <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="例如：探頭清潔校正" className="w-full rounded-md border border-slate-300 px-2.5 py-1.5" />
      </label>
      {err && <div className="sm:col-span-2 text-xs text-rose-700">{err}</div>}
      <div className="sm:col-span-2 flex items-center justify-between gap-3">
        <span className="text-[11px] text-slate-500">維修／校正與斷電、缺值、卡住預設排除於分析；可在清單中改。</span>
        <button type="submit" className="px-4 py-1.5 rounded-md bg-[#0B63CE] text-white text-sm font-semibold hover:bg-[#0952AD]">
          記錄
        </button>
      </div>
    </form>
  );
};
