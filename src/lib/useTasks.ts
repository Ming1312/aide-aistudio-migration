// 任務清單（伺服器端共用，管理員與員工看到同一份）：員工以上才讀得到；30 秒輪詢一次。
import { useCallback, useEffect, useState } from "react";
import type { Task, TaskInput } from "../../contracts/tasks";
import { sessionHeaders } from "./session";

export interface TasksApi {
  /** null＝沒有權限（訪客）或還沒載入 */
  tasks: Task[] | null;
  persistent: boolean;
  error: string | null;
  create: (input: TaskInput) => Promise<string | null>;
  update: (id: string, patch: TaskInput) => Promise<string | null>;
  remove: (id: string) => Promise<string | null>;
}

async function call(method: string, url: string, body?: unknown): Promise<{ ok: boolean; data: unknown }> {
  const res = await fetch(`/api/tasks${url}`, {
    method,
    headers: { "Content-Type": "application/json", ...sessionHeaders() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* 沒有本文 */
  }
  return { ok: res.ok, data };
}

const detail = (d: unknown): string => (d && typeof d === "object" && typeof (d as { detail?: unknown }).detail === "string" ? (d as { detail: string }).detail : "操作失敗");

/** enabled＝目前角色能查看任務；roleKey 變了（登入／登出）就重讀 */
export function useTasks(enabled: boolean, roleKey: string): TasksApi {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [persistent, setPersistent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await call("GET", "");
      if (!r.ok) {
        setTasks(null);
        setError(detail(r.data));
        return;
      }
      const d = r.data as { tasks: Task[]; persistent?: boolean };
      setTasks(d.tasks);
      setPersistent(!!d.persistent);
      setError(null);
    } catch {
      setError("讀不到任務（連不上伺服器）");
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      setTasks(null);
      setError(null);
      return;
    }
    void load();
    const t = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(t);
  }, [enabled, roleKey, load]);

  const act = useCallback(
    async (method: string, url: string, body?: unknown): Promise<string | null> => {
      try {
        const r = await call(method, url, body);
        if (!r.ok) return detail(r.data);
        await load();
        return null;
      } catch {
        return "連不上伺服器";
      }
    },
    [load]
  );

  return {
    tasks,
    persistent,
    error,
    create: (input) => act("POST", "", input),
    update: (id, patch) => act("PATCH", `/${id}`, patch),
    remove: (id) => act("DELETE", `/${id}`),
  };
}
