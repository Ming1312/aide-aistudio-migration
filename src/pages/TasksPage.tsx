import React, { useMemo, useState } from "react";
import { CheckCircle2, ClipboardList, Pencil, Plus, Trash2 } from "lucide-react";
import type { RealDataset } from "../../contracts/types";
import { TASK_PRIORITY_ZH, TASK_STATUS_ZH, isOverdue, type Task, type TaskHorizon, type TaskInput, type TaskPriority, type TaskStatus } from "../../contracts/tasks";
import { Card, Chip } from "../components/ui";

export const todayStr = (): string => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const PRIO_RANK: Record<TaskPriority, number> = { high: 0, normal: 1, low: 2 };
const PRIO_STYLE: Record<TaskPriority, string> = { high: "bg-rose-50 text-rose-800 border-rose-200", normal: "bg-slate-50 text-slate-700 border-slate-200", low: "bg-sky-50 text-sky-800 border-sky-200" };
const HORIZON_SHORT: Record<TaskHorizon, string> = { short: "短期", mid: "中期", long: "長期" };

/** 未完成的在前；高優先、期限近的在前 */
export function sortTasks(list: Task[]): Task[] {
  return [...list].sort((a, b) => {
    const da = a.status === "done" ? 1 : 0;
    const db = b.status === "done" ? 1 : 0;
    if (da !== db) return da - db;
    if (PRIO_RANK[a.priority] !== PRIO_RANK[b.priority]) return PRIO_RANK[a.priority] - PRIO_RANK[b.priority];
    return (a.due ?? "9999").localeCompare(b.due ?? "9999") || b.createdAt.localeCompare(a.createdAt);
  });
}

interface BoardProps {
  tasks: Task[];
  datasets: RealDataset[];
  canAssign: boolean;
  onUpdate: (id: string, patch: TaskInput) => Promise<string | null>;
  onDelete?: (id: string) => Promise<string | null>;
  onOpenEvents: (datasetId: string) => void;
}

type Filter = "open" | TaskStatus | "all";

export const TaskBoard: React.FC<BoardProps> = ({ tasks, datasets, canAssign, onUpdate, onDelete, onOpenEvents }) => {
  const [filter, setFilter] = useState<Filter>("open");
  const [err, setErr] = useState<string | null>(null);
  const today = todayStr();
  const counts = useMemo(() => ({ open: tasks.filter((t) => t.status !== "done").length, todo: tasks.filter((t) => t.status === "todo").length, doing: tasks.filter((t) => t.status === "doing").length, done: tasks.filter((t) => t.status === "done").length, all: tasks.length }), [tasks]);
  const shown = useMemo(() => sortTasks(tasks.filter((t) => (filter === "all" ? true : filter === "open" ? t.status !== "done" : t.status === filter))), [tasks, filter]);
  const FILTERS: Array<[Filter, string]> = [["open", "未完成"], ["todo", "待辦"], ["doing", "進行中"], ["done", "完成"], ["all", "全部"]];
  const run = async (p: Promise<string | null>) => setErr(await p);

  return (
    <div className="space-y-3" data-testid="task-board">
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="任務篩選">
        {FILTERS.map(([f, label]) => (
          <Chip key={f} active={filter === f} onClick={() => setFilter(f)}>
            {label} {counts[f]}
          </Chip>
        ))}
      </div>
      {err && <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-md px-2.5 py-1.5">{err}</div>}
      {shown.length === 0 ? (
        <div className="text-sm text-slate-500 py-6 text-center">{counts.all === 0 ? (canAssign ? "還沒有任務。從上面的規劃按「指派給員工」，或自己新增一個。" : "目前沒有指派給你的任務。") : "這個分類沒有任務。"}</div>
      ) : (
        <ul className="space-y-2">
          {shown.map((t) => (
            <TaskCard key={t.id} t={t} datasets={datasets} canAssign={canAssign} overdue={isOverdue(t, today)} onUpdate={(p) => run(onUpdate(t.id, p))} onDelete={onDelete ? () => run(onDelete(t.id)) : undefined} onOpenEvents={onOpenEvents} />
          ))}
        </ul>
      )}
    </div>
  );
};

const TaskCard: React.FC<{
  t: Task;
  datasets: RealDataset[];
  canAssign: boolean;
  overdue: boolean;
  onUpdate: (p: TaskInput) => void;
  onDelete?: () => void;
  onOpenEvents: (datasetId: string) => void;
}> = ({ t, datasets, canAssign, overdue, onUpdate, onDelete, onOpenEvents }) => {
  const [edit, setEdit] = useState(false);
  const [note, setNote] = useState(t.note);
  const [form, setForm] = useState({ title: t.title, detail: t.detail, due: t.due ?? "", priority: t.priority, assignee: t.assignee });
  const ds = datasets.find((d) => d.id === t.datasetId);
  const done = t.status === "done";
  return (
    <li className={`rounded-lg border bg-white p-3 ${overdue ? "border-rose-300" : "border-slate-200"}`} data-testid="task-card" data-status={t.status}>
      {edit ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
          <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} maxLength={80} aria-label="標題" className="sm:col-span-2 rounded-md border border-slate-300 px-2.5 py-1.5" />
          <textarea value={form.detail} onChange={(e) => setForm({ ...form, detail: e.target.value })} maxLength={400} rows={2} aria-label="說明" className="sm:col-span-2 rounded-md border border-slate-300 px-2.5 py-1.5" />
          <label className="text-xs text-slate-600">
            期限
            <input type="date" value={form.due} onChange={(e) => setForm({ ...form, due: e.target.value })} className="mt-0.5 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm" />
          </label>
          <label className="text-xs text-slate-600">
            優先度
            <select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value as TaskPriority })} className="mt-0.5 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm">
              {(Object.keys(TASK_PRIORITY_ZH) as TaskPriority[]).map((p) => (
                <option key={p} value={p}>
                  {TASK_PRIORITY_ZH[p]}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-slate-600 sm:col-span-2">
            指派給（備註名稱）
            <input value={form.assignee} onChange={(e) => setForm({ ...form, assignee: e.target.value })} maxLength={20} className="mt-0.5 w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm" />
          </label>
          <div className="sm:col-span-2 flex justify-end gap-2">
            <button type="button" onClick={() => setEdit(false)} className="px-3 py-1.5 rounded-md border border-slate-300 text-xs text-slate-700">
              取消
            </button>
            <button
              type="button"
              onClick={() => {
                onUpdate({ title: form.title, detail: form.detail, due: form.due || null, priority: form.priority, assignee: form.assignee });
                setEdit(false);
              }}
              className="px-3 py-1.5 rounded-md bg-[#0B63CE] text-white text-xs font-semibold"
            >
              儲存
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className={`text-sm font-semibold ${done ? "text-slate-400 line-through" : "text-slate-900"}`}>{t.title}</div>
              {t.detail && <div className="text-xs text-slate-600 mt-0.5">{t.detail}</div>}
            </div>
            <select
              value={t.status}
              onChange={(e) => onUpdate({ status: e.target.value })}
              aria-label="進度"
              className={`shrink-0 rounded-md border px-2 py-1 text-xs font-medium ${t.status === "done" ? "bg-emerald-50 border-emerald-200 text-emerald-900" : t.status === "doing" ? "bg-sky-50 border-sky-200 text-sky-900" : "bg-white border-slate-300 text-slate-800"}`}
            >
              {(Object.keys(TASK_STATUS_ZH) as TaskStatus[]).map((s) => (
                <option key={s} value={s}>
                  {TASK_STATUS_ZH[s]}
                </option>
              ))}
            </select>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-600">
            <span className={`rounded border px-1.5 py-0.5 font-medium ${PRIO_STYLE[t.priority]}`}>優先 {TASK_PRIORITY_ZH[t.priority]}</span>
            {t.due && <span className={overdue ? "font-semibold text-rose-700" : ""}>{overdue ? "已逾期・" : "期限 "}{t.due}</span>}
            {ds && (
              <button type="button" onClick={() => onOpenEvents(ds.id)} className="text-[#0B63CE] hover:underline">
                {ds.display_name.split("（")[0]}
                {t.sensor ? `・${t.sensor}` : ""}
              </button>
            )}
            {t.horizon && <span>{HORIZON_SHORT[t.horizon]}規劃</span>}
            <span>指派給 {t.assignee}</span>
            <span className="text-slate-400">
              {t.createdBy} 於 {t.createdAt.slice(0, 10)} 建立
              {done && t.doneAt ? `・${t.updatedBy} 於 ${t.doneAt.slice(0, 16)} 完成` : ""}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onBlur={() => note !== t.note && onUpdate({ note })}
              maxLength={300}
              placeholder="進度或完成說明（例如：已更換接頭）"
              aria-label="進度說明"
              className="flex-1 min-w-[12rem] rounded-md border border-slate-300 px-2.5 py-1 text-xs focus:border-[#0B63CE] focus:outline-none"
            />
            {!done && (
              <button type="button" onClick={() => onUpdate({ status: "done", note })} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-emerald-600 text-white text-xs font-semibold hover:bg-emerald-700">
                <CheckCircle2 className="h-3.5 w-3.5" />
                完成
              </button>
            )}
            {canAssign && (
              <>
                <button type="button" onClick={() => setEdit(true)} className="p-1.5 rounded text-slate-500 hover:bg-slate-100" aria-label="編輯任務">
                  <Pencil className="h-4 w-4" />
                </button>
                {onDelete && (
                  <button type="button" onClick={onDelete} className="p-1.5 rounded text-slate-500 hover:text-rose-700 hover:bg-rose-50" aria-label="刪除任務">
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </>
            )}
          </div>
        </>
      )}
    </li>
  );
};

/** 管理員自己新增任務（不經過 AI 規劃） */
export const NewTaskForm: React.FC<{ datasets: RealDataset[]; onCreate: (input: TaskInput) => Promise<string | null> }> = ({ datasets, onCreate }) => {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ title: "", detail: "", datasetId: "", due: "", priority: "normal" as TaskPriority, assignee: "員工" });
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const m = await onCreate({ title: f.title, detail: f.detail, datasetId: f.datasetId || null, due: f.due || null, priority: f.priority, assignee: f.assignee });
    setErr(m);
    if (!m) {
      setF({ ...f, title: "", detail: "", due: "" });
      setOpen(false);
    }
  };
  if (!open)
    return (
      <button type="button" onClick={() => setOpen(true)} className="inline-flex items-center gap-1 text-xs font-semibold text-[#0B63CE]">
        <Plus className="h-3.5 w-3.5" />
        新增任務
      </button>
    );
  return (
    <form onSubmit={submit} className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm rounded-lg border border-slate-200 bg-slate-50/50 p-3">
      <input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} maxLength={80} placeholder="任務標題" aria-label="任務標題" className="sm:col-span-2 rounded-md border border-slate-300 px-2.5 py-1.5" />
      <textarea value={f.detail} onChange={(e) => setF({ ...f, detail: e.target.value })} maxLength={400} rows={2} placeholder="說明（選填）" aria-label="任務說明" className="sm:col-span-2 rounded-md border border-slate-300 px-2.5 py-1.5" />
      <select value={f.datasetId} onChange={(e) => setF({ ...f, datasetId: e.target.value })} aria-label="場域" className="rounded-md border border-slate-300 bg-white px-2 py-1.5">
        <option value="">不指定場域</option>
        {datasets.map((d) => (
          <option key={d.id} value={d.id}>
            {d.display_name.split("（")[0]}
          </option>
        ))}
      </select>
      <input type="date" value={f.due} onChange={(e) => setF({ ...f, due: e.target.value })} aria-label="期限" className="rounded-md border border-slate-300 px-2 py-1.5" />
      <select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value as TaskPriority })} aria-label="優先度" className="rounded-md border border-slate-300 bg-white px-2 py-1.5">
        {(Object.keys(TASK_PRIORITY_ZH) as TaskPriority[]).map((p) => (
          <option key={p} value={p}>
            優先 {TASK_PRIORITY_ZH[p]}
          </option>
        ))}
      </select>
      <input value={f.assignee} onChange={(e) => setF({ ...f, assignee: e.target.value })} maxLength={20} placeholder="指派給（備註名稱）" aria-label="指派給" className="rounded-md border border-slate-300 px-2.5 py-1.5" />
      {err && <div className="sm:col-span-2 text-xs text-rose-700">{err}</div>}
      <div className="sm:col-span-2 flex justify-end gap-2">
        <button type="button" onClick={() => setOpen(false)} className="px-3 py-1.5 rounded-md border border-slate-300 text-xs text-slate-700">
          取消
        </button>
        <button type="submit" disabled={!f.title.trim()} className="px-3 py-1.5 rounded-md bg-[#0B63CE] text-white text-xs font-semibold disabled:opacity-50">
          指派給員工
        </button>
      </div>
    </form>
  );
};

/** 員工的「任務」頁 */
export const TasksPage: React.FC<{
  tasks: Task[] | null;
  error: string | null;
  datasets: RealDataset[];
  onUpdate: (id: string, patch: TaskInput) => Promise<string | null>;
  onOpenEvents: (datasetId: string) => void;
}> = ({ tasks, error, datasets, onUpdate, onOpenEvents }) => (
  <div className="space-y-4" data-testid="tasks-page">
    <Card
      title={
        <span className="inline-flex items-center gap-1.5">
          <ClipboardList className="h-4 w-4 text-[#0B63CE]" />
          管理員指派的任務
        </span>
      }
    >
      {tasks === null ? (
        <div className="text-sm text-slate-500 py-6 text-center">{error ?? "載入中…"}</div>
      ) : (
        <TaskBoard tasks={tasks} datasets={datasets} canAssign={false} onUpdate={onUpdate} onOpenEvents={onOpenEvents} />
      )}
    </Card>
    <div className="text-[11px] text-slate-500">更改進度與說明會即時存到伺服器，管理員那邊會看到。</div>
  </div>
);
