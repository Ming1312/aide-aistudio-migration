// 任務清單：記憶體＋（有給路徑時）寫到 JSON 檔，重啟後還在。員工與管理員在不同裝置上看到的是同一份。
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { MAX_TASKS, type ParsedTask, type Task } from "../contracts/tasks.ts";

// 伺服器本地時間（YYYY-MM-DD HH:mm），和畫面上其他時間一致
const stamp = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

export class TaskStore {
  private tasks: Task[] = [];
  /** 有寫檔路徑且最近一次寫入成功 */
  persistent = false;

  constructor(private readonly file: string | null) {
    if (file) {
      try {
        const raw = JSON.parse(readFileSync(file, "utf-8")) as { tasks?: Task[] };
        if (Array.isArray(raw.tasks)) this.tasks = raw.tasks.slice(0, MAX_TASKS);
      } catch {
        /* 沒有檔案或壞掉：從空的開始 */
      }
      this.persistent = this.save();
    }
  }

  private save(): boolean {
    if (!this.file) return false;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ tasks: this.tasks }, null, 1), "utf-8");
      renameSync(tmp, this.file);
      return true;
    } catch {
      return false;
    }
  }

  private commit() {
    if (this.file) this.persistent = this.save();
  }

  list(): Task[] {
    return [...this.tasks].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  create(input: ParsedTask, by: string): Task | null {
    if (this.tasks.length >= MAX_TASKS || !input.title) return null;
    const now = stamp();
    const t: Task = {
      id: randomUUID(),
      title: input.title,
      detail: input.detail ?? "",
      datasetId: input.datasetId ?? null,
      sensor: input.sensor ?? null,
      horizon: input.horizon ?? null,
      priority: input.priority ?? "normal",
      due: input.due ?? null,
      assignee: input.assignee ?? "員工",
      status: input.status ?? "todo",
      note: input.note ?? "",
      createdBy: by,
      createdAt: now,
      updatedAt: now,
      updatedBy: by,
      doneAt: input.status === "done" ? now : null,
    };
    this.tasks.push(t);
    this.commit();
    return t;
  }

  update(id: string, patch: ParsedTask, by: string): Task | null {
    const i = this.tasks.findIndex((t) => t.id === id);
    if (i < 0) return null;
    const cur = this.tasks[i];
    const now = stamp();
    const next: Task = { ...cur, ...patch, updatedAt: now, updatedBy: by };
    if (patch.status && patch.status !== cur.status) next.doneAt = patch.status === "done" ? now : null;
    this.tasks[i] = next;
    this.commit();
    return next;
  }

  remove(id: string): boolean {
    const n = this.tasks.length;
    this.tasks = this.tasks.filter((t) => t.id !== id);
    if (this.tasks.length === n) return false;
    this.commit();
    return true;
  }
}
