import React, { useMemo, useState } from "react";
import { ChevronDown, ClipboardList, Compass, Lock, Plus, Sparkles } from "lucide-react";
import type { RealDataset } from "../../contracts/types";
import type { ParsedCsvRow } from "../types/app";
import { askPlan } from "../lib/ai";
import { GROUP_ZH, KIND_INFO, type EventGroup, type MaskResult, type ResolvedEvent } from "../lib/events";
import { HORIZON_ZH, TREND_ZH, buildDomainStats, buildLocalPlan, buildPlanFacts, rankSensors, type Horizon, type Plan, type PlanItem } from "../lib/planning";
import type { Task, TaskInput } from "../../contracts/tasks";
import { NewTaskForm, TaskBoard } from "./TasksPage";
import { Card } from "../components/ui";
import { GROUP_COLOR } from "./EventsPage";

interface Props {
  datasets: RealDataset[];
  events: ResolvedEvent[];
  data: Map<string, { merged: ParsedCsvRow[]; masked: MaskResult; rawLastMs: number | null }>;
  allowed: boolean;
  onLogin: () => void;
  onOpenEvents: (datasetId: string) => void;
  /** 管理員指派給員工的任務（伺服器端共用） */
  tasks: Task[] | null;
  tasksPersistent: boolean;
  onCreateTask: (input: TaskInput) => Promise<string | null>;
  onUpdateTask: (id: string, patch: TaskInput) => Promise<string | null>;
  onDeleteTask: (id: string) => Promise<string | null>;
}

const HORIZONS: Horizon[] = ["short", "mid", "long"];
const H_STYLE: Record<Horizon, string> = { short: "border-rose-200 bg-rose-50/40", mid: "border-amber-200 bg-amber-50/40", long: "border-sky-200 bg-sky-50/40" };
const GROUPS: EventGroup[] = ["fault", "suspect", "real", "note"];

const Tile: React.FC<{ label: string; value: React.ReactNode; hint?: string }> = ({ label, value, hint }) => (
  <div className="rounded-lg border border-slate-200 bg-white px-3.5 py-3">
    <div className="text-[11px] text-slate-500">{label}</div>
    <div className="text-2xl font-bold tabular-nums text-slate-900 leading-tight truncate">{value}</div>
    {hint && <div className="text-[11px] text-slate-500 mt-0.5 truncate">{hint}</div>}
  </div>
);

export const PlanPage: React.FC<Props> = ({ datasets, events, data, allowed, onLogin, onOpenEvents, tasks, tasksPersistent, onCreateTask, onUpdateTask, onDeleteTask }) => {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);
  const [question, setQuestion] = useState("");
  const [showFacts, setShowFacts] = useState(false);
  const [assignErr, setAssignErr] = useState<string | null>(null);

  const stats = useMemo(
    () =>
      datasets.map((ds) => {
        const evs = events.filter((e) => e.datasetId === ds.id);
        const d = data.get(ds.id);
        return buildDomainStats(ds.id, ds.display_name, evs, d?.merged ?? null, d?.masked ?? null);
      }),
    [datasets, events, data]
  );
  const ranking = useMemo(() => rankSensors(stats), [stats]);
  const facts = useMemo(() => buildPlanFacts(stats, ranking), [stats, ranking]);

  const totals = useMemo(() => {
    const ev = stats.reduce((a, s) => a + s.events, 0);
    const f = stats.reduce((a, s) => a + s.faults, 0);
    const worst = [...stats].sort((a, b) => b.faultsPer30d - a.faultsPer30d)[0];
    return { ev, f, worst };
  }, [stats]);
  const maxEv = Math.max(1, ...stats.map((s) => s.events));
  const maxRisk = Math.max(1, ...ranking.map((r) => r.faults));

  const generate = async () => {
    if (busy) return;
    setBusy(true);
    setPlan(null);
    const ai = await askPlan(datasets[0]?.id ?? "sheep_barn", facts, question.trim() || undefined);
    setPlan(ai ?? buildLocalPlan(stats, ranking));
    setBusy(false);
  };

  const taskTitle = (it: PlanItem) => it.text.slice(0, 80);
  const assign = async (it: PlanItem) => {
    setAssignErr(await onCreateTask({ title: taskTitle(it), detail: it.basis ? `依據：${it.basis}` : "", datasetId: it.datasetId ?? null, sensor: it.sensor ?? null, horizon: it.horizon, priority: it.horizon === "short" ? "high" : "normal" }));
  };

  if (!allowed) {
    return (
      <div className="max-w-xl mx-auto mt-8 text-center space-y-3" data-testid="plan-locked">
        <div className="mx-auto h-12 w-12 rounded-full bg-slate-100 grid place-items-center">
          <Lock className="h-5 w-5 text-slate-500" />
        </div>
        <div className="text-base font-semibold text-slate-900">長期規劃只給管理員</div>
        <div className="text-sm text-slate-600">用 AI 分析歷史資料事件，提出短、中、長期的維護與改善規劃。請用管理員登入。</div>
        <button type="button" onClick={onLogin} className="px-4 py-2 rounded-md bg-[#0B63CE] text-white text-sm font-semibold hover:bg-[#0952AD]">
          登入
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="plan-page">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Tile label="歷史事件" value={totals.ev} hint="七個場域合計" />
        <Tile label="資料故障" value={totals.f} hint="斷線、缺值、卡住、維修" />
        <Tile label="最常出問題的場域" value={totals.worst && totals.worst.faults > 0 ? totals.worst.name.split("（")[0] : "—"} hint={totals.worst && totals.worst.faults > 0 ? `每 30 天約 ${totals.worst.faultsPer30d} 次` : undefined} />
        <Tile label="反覆出問題的感測器" value={ranking.filter((r) => r.recurring).length} hint="資料故障 3 次以上" />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-5 gap-4">
        <Card title="各場域事件概況" className="xl:col-span-3">
          <ul className="space-y-3">
            {stats.map((s) => {
              const byGroup = GROUPS.map((g) => ({
                g,
                n: (Object.entries(s.byKind) as Array<[keyof typeof KIND_INFO, number]>).filter(([k]) => KIND_INFO[k].group === g).reduce((a, [, n]) => a + n, 0),
              }));
              return (
                <li key={s.datasetId}>
                  <button type="button" onClick={() => onOpenEvents(s.datasetId)} className="w-full text-left group" aria-label={`查看 ${s.name.split("（")[0]} 的事件`}>
                    <div className="flex items-baseline justify-between gap-2 text-sm">
                      <span className="font-medium text-slate-900 group-hover:text-[#0B63CE] truncate">{s.name.split("（")[0]}</span>
                      <span className="text-xs text-slate-600 tabular-nums whitespace-nowrap">
                        {s.events} 筆
                        {s.faults > 0 ? `・故障 ${s.faults}・每 30 天 ${s.faultsPer30d} 次` : ""}
                        {s.trend ? `・${TREND_ZH[s.trend]}` : ""}
                      </span>
                    </div>
                    <div className="mt-1 flex h-3 gap-0.5" style={{ width: `${Math.max(4, (100 * s.events) / maxEv)}%` }} aria-hidden>
                      {byGroup
                        .filter((x) => x.n > 0)
                        .map((x) => (
                          <span key={x.g} className="h-full rounded-sm" style={{ flex: x.n, background: GROUP_COLOR[x.g] }} title={`${GROUP_ZH[x.g]} ${x.n}`} />
                        ))}
                    </div>
                    {s.completenessPct !== null && <div className="text-[11px] text-slate-500 mt-0.5">讀值完整度 {s.completenessPct.toFixed(1)}%</div>}
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="mt-3 text-[11px] text-slate-500">離線偵測器的事件，每個場域最多載入前 120 筆；加上資料偵測與人工記錄。</div>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-600">
            {GROUPS.map((g) => (
              <span key={g} className="inline-flex items-center gap-1.5">
                <span className="inline-block h-2.5 w-4 rounded-sm" style={{ background: GROUP_COLOR[g] }} />
                {GROUP_ZH[g]}
              </span>
            ))}
          </div>
        </Card>

        <Card title="優先處理的感測器" className="xl:col-span-2">
          {ranking.length === 0 ? (
            <div className="text-sm text-slate-500 py-4 text-center">目前沒有資料故障的紀錄。</div>
          ) : (
            <ul className="space-y-2.5">
              {ranking.map((r) => (
                <li key={`${r.datasetId}-${r.sensor}`} className="text-sm">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-slate-900" title={r.sensor}>
                      {r.sensor}
                    </span>
                    <span className="text-xs text-slate-600 tabular-nums whitespace-nowrap">
                      {r.faults} 次・{r.hours} 小時
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="h-2 rounded-sm" style={{ width: `${(100 * r.faults) / maxRisk}%`, minWidth: 6, background: GROUP_COLOR.fault }} aria-hidden />
                    <span className="text-[11px] text-slate-500 truncate">
                      {r.domain}
                      {r.recurring ? "・反覆" : ""}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card
        title={
          <span className="inline-flex items-center gap-1.5">
            <Sparkles className="h-4 w-4 text-[#0B63CE]" />
            AI 長期規劃
          </span>
        }
        right={plan && <span className="text-[11px] text-slate-500">{plan.source === "gemini" ? "Gemini" : "規則式（未連到 Gemini）"}</span>}
      >
        <div className="flex flex-wrap gap-2 mb-3">
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            maxLength={200}
            placeholder="想聚焦的方向（選填），例如：怎麼降低斷線"
            aria-label="想聚焦的方向"
            className="flex-1 min-w-[12rem] rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-[#0B63CE] focus:outline-none"
          />
          <button
            type="button"
            onClick={() => void generate()}
            disabled={busy || totals.ev === 0}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-[#0B63CE] text-white text-sm font-semibold hover:bg-[#0952AD] disabled:opacity-50"
          >
            <Compass className="h-4 w-4" />
            {busy ? "分析中…" : plan ? "重新產生" : "產生規劃"}
          </button>
        </div>

        {!plan && !busy && <div className="text-xs text-slate-500">AI 會讀取上面的事件統計，提出短、中、長期的規劃；連不到 Gemini 時改用規則式規劃。</div>}

        {plan && (
          <div className="space-y-4" data-testid="plan-result">
            <p className="text-sm text-slate-900 font-medium">{plan.summary}</p>
            {!plan.grounded && <div className="text-xs rounded-md bg-amber-50 border border-amber-200 text-amber-900 px-2.5 py-1.5">這段說明含有對不上事件統計的數字，請以上方統計為準。</div>}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
              {HORIZONS.map((h) => {
                const list = plan.items.filter((i) => i.horizon === h);
                return (
                  <div key={h} className={`rounded-lg border p-3 ${H_STYLE[h]}`}>
                    <div className="text-xs font-semibold text-slate-800 mb-2">{HORIZON_ZH[h]}</div>
                    {list.length === 0 ? (
                      <div className="text-xs text-slate-500">沒有項目</div>
                    ) : (
                      <ul className="space-y-2">
                        {list.map((it) => {
                          const added = !!tasks?.some((t) => t.title === taskTitle(it));
                          return (
                            <li key={it.id} className="text-sm text-slate-900 bg-white rounded-md border border-slate-200 p-2.5">
                              <div>{it.text}</div>
                              {it.basis && <div className="text-[11px] text-slate-500 mt-1">依據：{it.basis}</div>}
                              <button
                                type="button"
                                onClick={() => void assign(it)}
                                disabled={added}
                                className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-semibold text-[#0B63CE] disabled:text-slate-400"
                              >
                                <Plus className="h-3 w-3" />
                                {added ? "已指派給員工" : "指派給員工"}
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>
            {plan.findings.length > 0 && (
              <div>
                <div className="text-xs font-semibold text-slate-700 mb-1">從歷史看到的規律</div>
                <ul className="list-disc pl-5 space-y-0.5 text-sm text-slate-800">
                  {plan.findings.map((f, i) => (
                    <li key={i}>{f}</li>
                  ))}
                </ul>
              </div>
            )}
            {plan.causes.length > 0 && (
              <div>
                <div className="text-xs font-semibold text-slate-700 mb-1">可能的原因（需現場確認）</div>
                <ul className="list-disc pl-5 space-y-0.5 text-sm text-slate-800">
                  {plan.causes.map((f, i) => (
                    <li key={i}>{f}</li>
                  ))}
                </ul>
              </div>
            )}
            {plan.limits.length > 0 && <div className="text-[11px] text-slate-500">限制：{plan.limits.join("；")}</div>}
          </div>
        )}

        <div className="mt-3 border-t border-slate-100 pt-2">
          <button type="button" onClick={() => setShowFacts((v) => !v)} className="inline-flex items-center gap-1 text-[11px] text-slate-600" aria-expanded={showFacts}>
            AI 看到的統計（{facts.length} 條）
            <ChevronDown className={`h-3 w-3 transition-transform ${showFacts ? "rotate-180" : ""}`} />
          </button>
          {showFacts && (
            <ul className="mt-1.5 space-y-0.5 text-[11px] text-slate-600 max-h-56 overflow-y-auto">
              {facts.map((f) => (
                <li key={f.id}>
                  <span className="text-slate-400">[{f.id}]</span> {f.text}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      <Card
        title={
          <span className="inline-flex items-center gap-1.5">
            <ClipboardList className="h-4 w-4 text-[#0B63CE]" />
            指派給員工的任務{tasks ? `（${tasks.filter((t) => t.status !== "done").length} 項未完成）` : ""}
          </span>
        }
        right={<NewTaskForm datasets={datasets} onCreate={onCreateTask} />}
        data-testid="plan-tasks"
      >
        {assignErr && <div className="mb-2 text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-md px-2.5 py-1.5">{assignErr}</div>}
        {tasks === null ? (
          <div className="text-sm text-slate-500 py-4 text-center">載入中…</div>
        ) : (
          <TaskBoard tasks={tasks} datasets={datasets} canAssign onUpdate={onUpdateTask} onDelete={onDeleteTask} onOpenEvents={onOpenEvents} />
        )}
        {!tasksPersistent && tasks !== null && <div className="mt-2 text-[11px] text-amber-800">伺服器沒有存檔位置，重新啟動後任務會清空（可用環境變數 TASKS_FILE 指定）。</div>}
      </Card>
    </div>
  );
};

