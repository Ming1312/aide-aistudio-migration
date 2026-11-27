import React, { useRef, useState } from "react";
import { ArrowRight, CheckCircle2, ClipboardList, Send, Sparkles } from "lucide-react";
import { TASK_PRIORITY_ZH, TASK_STATUS_ZH, isOverdue, type Task } from "../../contracts/tasks";
import type { RealDataset } from "../../contracts/types";
import { sortTasks, todayStr } from "./TasksPage";
import { SAFETY_TEXT, SAFETY_RANK, fmtVal, overallLevel, type DomainStatus, type Safety } from "../lib/status";
import { askAi } from "../lib/ai";
import { answerLocal, buildFacts } from "../lib/qa";
import { Card, SAFETY_STYLE, SafetyBadge, Sparkline } from "../components/ui";

interface Props {
  statuses: DomainStatus[];
  engine: { connected: boolean; synthetic: boolean; lastAt: string | null };
  onOpenDecision: (datasetId: string) => void;
  onOpenData: (datasetId: string) => void;
  /** 任務（員工以上才有；訪客為 null） */
  tasks: Task[] | null;
  isAdmin: boolean;
  datasets: RealDataset[];
  onOpenTasks: () => void;
  onOpenEvents: (datasetId: string) => void;
}

const SUGGESTIONS = ["哪個場域最危險？", "未來 3 小時需要注意什麼？", "資料可信嗎？", "有什麼建議？"];

interface QA {
  q: string;
  lines: string[];
  source: "gemini" | "local";
  focusId: string | null;
}

export const OverviewPage: React.FC<Props> = ({ statuses, engine, onOpenDecision, onOpenData, tasks, isAdmin, datasets, onOpenTasks, onOpenEvents }) => {
  const overall = overallLevel(statuses);
  const withModel = statuses.filter((s) => s.hasModel);
  const counts = (["danger", "data", "caution", "safe"] as Safety[]).map((l) => ({
    level: l,
    n: withModel.filter((s) => s.level === l).length,
  }));
  const worst = [...withModel].sort((a, b) => SAFETY_RANK[b.level] - SAFETY_RANK[a.level])[0];
  const needAttention = worst && SAFETY_RANK[worst.level] >= SAFETY_RANK.caution;
  const asOf = withModel.map((s) => s.asOf).filter(Boolean).sort().pop();

  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<QA[]>([]);
  const endRef = useRef<HTMLDivElement>(null);

  const ask = async (question: string) => {
    const q = question.trim();
    if (!q || busy) return;
    setBusy(true);
    setInput("");
    const local = answerLocal(q, statuses);
    const target = local.focusId ?? worst?.datasetId ?? statuses[0]?.datasetId;
    const ai = target ? await askAi(target, buildFacts(statuses), q) : null;
    setHistory((h) => [
      ...h,
      ai
        ? { q, lines: ai.lines, source: "gemini", focusId: local.focusId }
        : { q, lines: local.text.split("\n"), source: "local", focusId: local.focusId },
    ]);
    setBusy(false);
    window.setTimeout(() => endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 50);
  };

  return (
    <div className="space-y-4">
      {/* 整體狀態 */}
      <section
        data-testid="overall-banner"
        data-level={overall}
        className={`rounded-lg border p-4 flex flex-wrap items-center justify-between gap-3 ${SAFETY_STYLE[overall].bg} ${SAFETY_STYLE[overall].border} ${SAFETY_STYLE[overall].text}`}
      >
        <div className="flex items-center gap-3 min-w-0">
          <div className="scale-150 origin-left mr-2">{SAFETY_STYLE[overall].icon}</div>
          <div>
            <div className="text-lg font-bold leading-tight">
              未來 1–3 小時：
              {overall === "safe" ? "各場域安全" : overall === "data" ? "需先確認資料" : overall === "caution" ? "需要注意" : "有危險"}
            </div>
            <div className="text-xs mt-0.5 flex flex-wrap gap-x-3">
              {counts
                .filter((c) => c.n > 0)
                .map((c) => (
                  <span key={c.level}>
                    {SAFETY_TEXT[c.level]} {c.n}
                  </span>
                ))}
              {asOf && <span className="opacity-70">資料截至 {asOf.slice(0, 16)}</span>}
              {engine.connected && (
                <span data-testid="engine-chip" className="font-semibold">
                  ● 引擎即時{engine.synthetic ? "（模擬資料流）" : ""}・{engine.lastAt}
                </span>
              )}
            </div>
          </div>
        </div>
        {needAttention && worst && (
          <button
            type="button"
            onClick={() => onOpenDecision(worst.datasetId)}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md bg-slate-900 text-white text-sm font-semibold hover:bg-slate-700"
          >
            前往決策：{worst.name.split("（")[0]}
            <ArrowRight className="h-4 w-4" />
          </button>
        )}
      </section>

      {tasks !== null && <TasksCard tasks={tasks} isAdmin={isAdmin} datasets={datasets} onOpenTasks={onOpenTasks} onOpenEvents={onOpenEvents} />}

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        {/* 各場域 */}
        <div className="xl:col-span-2 grid grid-cols-1 sm:grid-cols-2 gap-3 content-start">
          {statuses.map((s) => (
            <button
              key={s.datasetId}
              type="button"
              data-testid={`domain-card-${s.datasetId}`}
              data-level={s.level}
              onClick={() => (s.hasModel ? onOpenDecision(s.datasetId) : onOpenData(s.datasetId))}
              className={`text-left rounded-lg border p-3.5 bg-white hover:shadow-sm transition-shadow ${
                SAFETY_RANK[s.level] >= SAFETY_RANK.caution ? SAFETY_STYLE[s.level].border : "border-slate-200"
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-semibold text-slate-900 truncate">{s.name.split("（")[0]}</div>
                  <div className="text-[11px] text-slate-500 truncate">
                    {s.hasModel ? `${s.policy?.sensor}${s.sensorStatuses.filter((x) => x.sensor !== s.sensor && (x.level === "caution" || x.level === "danger")).length > 0 ? `（另 ${s.sensorStatuses.filter((x) => x.sensor !== s.sensor && (x.level === "caution" || x.level === "danger")).length} 項異常）` : ""} · ${s.source === "import" ? "匯入資料" : s.source === "baseline" ? "簡易預測・資料不完整" : s.source === "engine" ? (s.synthetic ? "引擎・模擬流" : "引擎即時") : "預計算"}` : s.noModelReason}
                  </div>
                </div>
                <SafetyBadge level={s.level} />
              </div>
              {s.hasModel && s.policy && (
                <div className="mt-2.5 flex items-end justify-between gap-3">
                  <div>
                    <div className="text-2xl font-bold tabular-nums text-slate-900 leading-none">
                      {fmtVal(s.current)}
                      <span className="text-xs font-normal text-slate-500 ml-1">{s.unit}</span>
                    </div>
                    <div className="mt-1.5 flex gap-1.5">
                      {s.horizons.map((h) => (
                        <span
                          key={h.h}
                          className="inline-flex items-center gap-1 text-[11px] text-slate-700 bg-slate-50 border border-slate-200 rounded px-1.5 py-0.5"
                          title={`${h.h} 小時後預測 ${fmtVal(h.point)} ${s.unit}`}
                        >
                          <span className="inline-block h-2 w-2 rounded-full" style={{ background: SAFETY_STYLE[h.level].dot }} />
                          +{h.h}h {fmtVal(h.point)}
                        </span>
                      ))}
                    </div>
                  </div>
                  <Sparkline
                    values={s.spark}
                    lines={[
                      { y: s.policy.caution, color: "#fab219" },
                      { y: s.policy.alarm, color: "#d03b3b" },
                    ]}
                  />
                </div>
              )}
            </button>
          ))}
        </div>

        {/* AI 問答 */}
        <Card
          title={
            <span className="inline-flex items-center gap-1.5">
              <Sparkles className="h-4 w-4 text-[#0B63CE]" />
              AI 問答
            </span>
          }
          className="flex flex-col min-h-[320px] xl:sticky xl:top-20 xl:max-h-[calc(100vh-7rem)]"
        >
          <div className="flex-1 overflow-y-auto space-y-3 mb-3 pr-1" data-testid="qa-history" aria-live="polite">
            {history.length === 0 && (
              <div className="flex flex-wrap gap-1.5">
                {SUGGESTIONS.map((q) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => void ask(q)}
                    className="px-2.5 py-1 rounded-full border border-slate-300 text-xs text-slate-700 hover:bg-slate-50"
                  >
                    {q}
                  </button>
                ))}
              </div>
            )}
            {history.map((m, i) => (
              <div key={i} className="space-y-1.5">
                <div className="text-xs font-medium text-slate-900 bg-slate-100 rounded-md px-2.5 py-1.5 ml-6">{m.q}</div>
                <div className="text-sm text-slate-800 bg-[#EFF6FF] border border-blue-100 rounded-md px-2.5 py-2 mr-6 space-y-1">
                  {m.lines.map((l, j) => (
                    <p key={j}>{l}</p>
                  ))}
                  <div className="flex items-center justify-between pt-0.5">
                    <span className="text-[10px] text-slate-500">{m.source === "gemini" ? "Gemini" : "規則式"}</span>
                    {m.focusId && (
                      <button type="button" className="text-[11px] font-semibold text-[#0B63CE] hover:underline" onClick={() => onOpenDecision(m.focusId!)}>
                        前往決策 →
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
            {busy && <div className="text-xs text-slate-500">思考中…</div>}
            <div ref={endRef} />
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void ask(input);
            }}
            className="flex gap-2"
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              maxLength={200}
              placeholder="問問場域狀況…"
              aria-label="輸入問題"
              className="flex-1 min-w-0 rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-[#0B63CE] focus:outline-none"
            />
            <button type="submit" disabled={busy || !input.trim()} aria-label="送出" className="px-3 rounded-md bg-[#0B63CE] text-white disabled:opacity-40">
              <Send className="h-4 w-4" />
            </button>
          </form>
        </Card>
      </div>
    </div>
  );
};

const TasksCard: React.FC<{ tasks: Task[]; isAdmin: boolean; datasets: RealDataset[]; onOpenTasks: () => void; onOpenEvents: (id: string) => void }> = ({ tasks, isAdmin, datasets, onOpenTasks, onOpenEvents }) => {
  const today = todayStr();
  const open = tasks.filter((t) => t.status !== "done");
  const overdue = open.filter((t) => isOverdue(t, today)).length;
  const doing = open.filter((t) => t.status === "doing").length;
  const top = sortTasks(open).slice(0, 3);
  return (
    <section data-testid="overview-tasks" className={`rounded-lg border bg-white p-3.5 ${overdue > 0 ? "border-rose-300" : "border-slate-200"}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex items-center gap-2 text-sm font-semibold text-slate-900">
          <ClipboardList className="h-4 w-4 text-[#0B63CE]" />
          {isAdmin ? "指派給員工的任務" : "你的任務"}
          <span className="font-normal text-xs text-slate-600">
            {open.length === 0 ? "全部完成" : `未完成 ${open.length}${doing > 0 ? `・進行中 ${doing}` : ""}`}
            {overdue > 0 && <span className="ml-1.5 font-semibold text-rose-700">逾期 {overdue}</span>}
          </span>
        </div>
        <button type="button" onClick={onOpenTasks} className="inline-flex items-center gap-1 text-xs font-semibold text-[#0B63CE] hover:underline">
          {isAdmin ? "管理任務" : "查看全部"}
          <ArrowRight className="h-3.5 w-3.5" />
        </button>
      </div>
      {top.length === 0 ? (
        <div className="mt-2 inline-flex items-center gap-1.5 text-xs text-slate-600">
          <CheckCircle2 className="h-4 w-4 text-emerald-600" />
          {tasks.length === 0 ? (isAdmin ? "還沒有任務；到「規劃」頁指派。" : "目前沒有指派給你的任務。") : "沒有未完成的任務。"}
        </div>
      ) : (
        <ul className="mt-2 divide-y divide-slate-100">
          {top.map((t) => {
            const ds = datasets.find((d) => d.id === t.datasetId);
            const late = isOverdue(t, today);
            return (
              <li key={t.id} className="py-1.5 flex items-center justify-between gap-3 text-sm" data-testid="overview-task">
                <div className="min-w-0">
                  <div className="truncate text-slate-900">{t.title}</div>
                  <div className="text-[11px] text-slate-500 truncate">
                    {TASK_STATUS_ZH[t.status]}・優先 {TASK_PRIORITY_ZH[t.priority]}
                    {t.due ? `・${late ? "已逾期 " : "期限 "}${t.due}` : ""}
                    {ds ? `・${ds.display_name.split("（")[0]}` : ""}
                  </div>
                </div>
                {ds && (
                  <button type="button" onClick={() => onOpenEvents(ds.id)} className="shrink-0 text-[11px] font-semibold text-[#0B63CE] hover:underline">
                    看事件
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
};
