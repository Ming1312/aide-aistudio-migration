// 事件紀錄：目前資料裡找得到的事件＋「看過就記下來」的歷史＋人工標註與補記。
// 存在這台裝置的瀏覽器（和決策紀錄、門檻設定一樣）；事件本身是從資料重新算出來的，所以紀錄只多存了
//「第一次看到的時間」「來源資料之後不見了的事件」「人的標註」。
import { useCallback, useEffect, useMemo, useState } from "react";
import { loadJson, saveJson } from "./storage";
import { eventId, resolveEvents, type DataEvent, type EventAnnotation, type EventKind, type ResolvedEvent } from "./events";

const KEY = "aide.eventLog.v1";
const MAX_HISTORY = 2000;

interface LogState {
  ann: Record<string, EventAnnotation>;
  manual: DataEvent[];
  history: Record<string, { ev: DataEvent; firstSeen: string }>;
}

const nowStr = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const EMPTY: LogState = { ann: {}, manual: [], history: {} };

function load(): LogState {
  const s = loadJson<Partial<LogState>>(KEY, EMPTY);
  return { ann: s.ann ?? {}, manual: s.manual ?? [], history: s.history ?? {} };
}

export interface NewManualEvent {
  datasetId: string;
  sensor: string;
  kind: EventKind;
  startMs: number;
  endMs: number;
  note: string;
}

export interface EventLog {
  events: ResolvedEvent[];
  historyCount: number;
  annotate: (id: string, patch: EventAnnotation, by: string) => void;
  addManual: (e: NewManualEvent, by: string) => void;
  removeManual: (id: string) => void;
}

/**
 * current：這一刻從離線偵測器＋資料偵測得到的事件；ready：已經完成資料偵測的場域
 * （還沒載入資料的場域不能把歷史裡的偵測事件當成「已消失」）。
 */
export function useEventLog(current: DataEvent[], ready: Set<string>): EventLog {
  const [state, setState] = useState<LogState>(load);

  // 第一次看到的事件記進歷史
  useEffect(() => {
    setState((prev) => {
      let changed = false;
      const history = { ...prev.history };
      const now = nowStr();
      for (const e of current) {
        if (e.source === "precomputed" || history[e.id]) continue; // 離線偵測器的事件每次都會重新載入，不用存
        const { raw: _raw, ...rest } = e;
        void _raw;
        history[e.id] = { ev: rest, firstSeen: now };
        changed = true;
      }
      if (!changed) return prev;
      const keys = Object.keys(history);
      if (keys.length > MAX_HISTORY) {
        keys
          .filter((k) => !prev.ann[k])
          .sort((a, b) => history[a].firstSeen.localeCompare(history[b].firstSeen))
          .slice(0, keys.length - MAX_HISTORY)
          .forEach((k) => delete history[k]);
      }
      const next = { ...prev, history };
      saveJson(KEY, next);
      return next;
    });
  }, [current]);

  const events = useMemo(() => {
    const ids = new Set(current.map((e) => e.id));
    const list: DataEvent[] = [...current];
    const firstSeen: Record<string, string> = {};
    for (const [id, h] of Object.entries(state.history)) {
      firstSeen[id] = h.firstSeen;
      if (ids.has(id)) continue;
      if (h.ev.source === "detected" && !ready.has(h.ev.datasetId)) continue;
      list.push(h.ev);
    }
    list.push(...state.manual);
    return resolveEvents(list, state.ann, ids, firstSeen).sort((a, b) => b.startMs - a.startMs);
  }, [current, ready, state]);

  const commit = useCallback((fn: (s: LogState) => LogState) => {
    setState((prev) => {
      const next = fn(prev);
      saveJson(KEY, next);
      return next;
    });
  }, []);

  const annotate = useCallback(
    (id: string, patch: EventAnnotation, by: string) =>
      commit((s) => {
        const merged: EventAnnotation = { ...s.ann[id], ...patch, by, at: nowStr() };
        // 改成「確認是資料故障／真實事件」就讓排除跟著狀態走，除非使用者另外指定
        if (patch.status && patch.mask === undefined) delete merged.mask;
        if (patch.comment !== undefined) merged.comment = patch.comment.slice(0, 200);
        return { ...s, ann: { ...s.ann, [id]: merged } };
      }),
    [commit]
  );

  const addManual = useCallback(
    (e: NewManualEvent, by: string) =>
      commit((s) => {
        const start = new Date(e.startMs);
        const p = (n: number) => String(n).padStart(2, "0");
        const startStr = `${start.getFullYear()}-${p(start.getMonth() + 1)}-${p(start.getDate())} ${p(start.getHours())}:${p(start.getMinutes())}:00`;
        const end = new Date(e.endMs);
        const endStr = `${end.getFullYear()}-${p(end.getMonth() + 1)}-${p(end.getDate())} ${p(end.getHours())}:${p(end.getMinutes())}:00`;
        const id = eventId(e.datasetId, e.sensor, e.kind, startStr);
        if (s.manual.some((m) => m.id === id)) return s;
        const ev: DataEvent = {
          id,
          datasetId: e.datasetId,
          sensor: e.sensor,
          kind: e.kind,
          start: startStr,
          end: endStr,
          startMs: e.startMs,
          endMs: e.endMs,
          hours: Math.max(1, Math.round((e.endMs - e.startMs) / 3_600_000) + 1),
          source: "manual",
          note: e.note.slice(0, 200),
        };
        return { ...s, manual: [...s.manual, ev], ann: { ...s.ann, [id]: { ...s.ann[id], by, at: nowStr() } } };
      }),
    [commit]
  );

  const removeManual = useCallback((id: string) => commit((s) => ({ ...s, manual: s.manual.filter((m) => m.id !== id) })), [commit]);

  return { events, historyCount: Object.keys(state.history).length, annotate, addManual, removeManual };
}
