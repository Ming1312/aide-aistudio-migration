// 管理員指派給員工的任務：前端與伺服器共用的型別與驗證（沒有 Node 或瀏覽器專屬的東西）。
export type TaskStatus = "todo" | "doing" | "done";
export type TaskPriority = "high" | "normal" | "low";
export type TaskHorizon = "short" | "mid" | "long";

export const TASK_STATUS_ZH: Record<TaskStatus, string> = { todo: "待辦", doing: "進行中", done: "完成" };
export const TASK_PRIORITY_ZH: Record<TaskPriority, string> = { high: "高", normal: "一般", low: "低" };

export interface Task {
  id: string;
  title: string;
  detail: string;
  datasetId: string | null;
  sensor: string | null;
  horizon: TaskHorizon | null;
  priority: TaskPriority;
  /** 期限 YYYY-MM-DD；沒有就是 null */
  due: string | null;
  /** 指派對象的顯示名稱（員工是一個角色，這裡只是備註用，例如「小王」） */
  assignee: string;
  status: TaskStatus;
  /** 員工回報的進度或完成說明 */
  note: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
  doneAt: string | null;
}

export interface TaskInput {
  title?: unknown;
  detail?: unknown;
  datasetId?: unknown;
  sensor?: unknown;
  horizon?: unknown;
  priority?: unknown;
  due?: unknown;
  assignee?: unknown;
  status?: unknown;
  note?: unknown;
}

export const MAX_TASKS = 300;

const str = (v: unknown, max: number): string | undefined => (typeof v === "string" ? v.trim().slice(0, max) : undefined);

export type ParsedTask = Partial<Pick<Task, "title" | "detail" | "datasetId" | "sensor" | "horizon" | "priority" | "due" | "assignee" | "status" | "note">>;

/** 驗證並整理輸入；不合法的欄位回傳在 errors。只回傳有給的欄位。 */
export function parseTaskInput(raw: TaskInput | undefined, validDatasets: ReadonlySet<string>): { value: ParsedTask; errors: string[] } {
  const value: ParsedTask = {};
  const errors: string[] = [];
  const b = raw ?? {};
  if (b.title !== undefined) {
    const t = str(b.title, 80);
    if (!t) errors.push("任務標題不能空白（最多 80 字）");
    else value.title = t;
  }
  if (b.detail !== undefined) value.detail = str(b.detail, 400) ?? "";
  if (b.note !== undefined) value.note = str(b.note, 300) ?? "";
  if (b.assignee !== undefined) value.assignee = str(b.assignee, 20) || "員工";
  if (b.sensor !== undefined) value.sensor = b.sensor === null || b.sensor === "" ? null : (str(b.sensor, 60) ?? null);
  if (b.datasetId !== undefined) {
    if (b.datasetId === null || b.datasetId === "") value.datasetId = null;
    else if (typeof b.datasetId === "string" && validDatasets.has(b.datasetId)) value.datasetId = b.datasetId;
    else errors.push("找不到指定的場域");
  }
  if (b.horizon !== undefined) {
    if (b.horizon === null || b.horizon === "") value.horizon = null;
    else if (b.horizon === "short" || b.horizon === "mid" || b.horizon === "long") value.horizon = b.horizon;
    else errors.push("期程只能是短期、中期或長期");
  }
  if (b.priority !== undefined) {
    if (b.priority === "high" || b.priority === "normal" || b.priority === "low") value.priority = b.priority;
    else errors.push("優先度只能是高、一般或低");
  }
  if (b.due !== undefined) {
    if (b.due === null || b.due === "") value.due = null;
    else if (typeof b.due === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.due) && !Number.isNaN(Date.parse(b.due))) value.due = b.due;
    else errors.push("期限格式要是 YYYY-MM-DD");
  }
  if (b.status !== undefined) {
    if (b.status === "todo" || b.status === "doing" || b.status === "done") value.status = b.status;
    else errors.push("狀態只能是待辦、進行中或完成");
  }
  return { value, errors };
}

/** 今天（本地日期）之前的期限算逾期；已完成的不算 */
export function isOverdue(t: Pick<Task, "due" | "status">, today: string): boolean {
  return t.status !== "done" && !!t.due && t.due < today;
}
