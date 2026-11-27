// 連到你電腦上的分析引擎：定時問 /api/health，連上時抓各場域的即時預測與狀態。
// 引擎網址與金鑰只存在伺服器環境變數；這裡只透過同源的 /api/live/* 讀取（唯讀）。
import { useCallback, useEffect, useRef, useState } from "react";
import { parseLocalTimestampMs } from "./trendChart";
import { fetchApiHealth, fetchLiveForecast, fetchLiveStatus } from "./dataLoader";
import type { EngineDomain } from "./status";

export interface EngineState {
  checked: boolean;
  connected: boolean;
  version: string | null;
  readOnly: boolean;
  synthetic: boolean;
  lastAt: string | null;
  error: string | null;
  busy: boolean;
  data: Record<string, EngineDomain>;
  /** 累積下來的引擎觀測值（key＝場域::感測器）：每次輪詢把引擎給的歷史視窗併進來，依時間去重 */
  series: Record<string, Array<{ t: number; v: number }>>;
  refresh: () => void;
}

const MAX_POINTS = 20000;

export const ENGINE_POLL_SEC = 30;

export function useEngine(datasetIds: string[], enabled = true): EngineState {
  const [state, setState] = useState<Omit<EngineState, "refresh">>({
    checked: false,
    connected: false,
    version: null,
    readOnly: true,
    synthetic: false,
    lastAt: null,
    error: null,
    busy: false,
    data: {},
    series: {},
  });
  const acc = useRef(new Map<string, Map<number, number>>());
  const idsKey = datasetIds.join(",");
  const alive = useRef(true);

  const run = useCallback(async () => {
    setState((s) => ({ ...s, busy: true }));
    const at = new Date().toLocaleTimeString("zh-TW", { hour12: false });
    try {
      const health = await fetchApiHealth();
      const connected = health.engine_connected === true && health.live_engine_connected !== false;
      if (!connected) {
        if (alive.current)
          setState((s) => ({
            ...s,
            checked: true,
            connected: false,
            version: health.engine_version,
            readOnly: health.read_only,
            synthetic: false,
            lastAt: at,
            error: health.warning_message,
            busy: false,
            data: {},
          }));
        return;
      }
      const ids = idsKey ? idsKey.split(",") : [];
      const results = await Promise.all(
        ids.map(async (id) => {
          const [f, st] = await Promise.allSettled([fetchLiveForecast(id), fetchLiveStatus(id)]);
          if (f.status !== "fulfilled") return [id, null, f.reason] as const;
          return [id, { forecast: f.value, status: st.status === "fulfilled" ? st.value : null } as EngineDomain, null] as const;
        })
      );
      const data: Record<string, EngineDomain> = {};
      let firstErr: string | null = null;
      for (const [id, d, err] of results) {
        if (d) data[id] = d;
        else if (!firstErr && err) firstErr = err instanceof Error ? err.message : "讀取失敗";
      }
      // 累積引擎的觀測歷史（同一個感測器的多個預測時距共用同一段歷史）
      for (const [id, d] of Object.entries(data)) {
        for (const t of d.forecast.tasks) {
          const key = `${id}::${t.sensor}`;
          let m = acc.current.get(key);
          if (!m) acc.current.set(key, (m = new Map()));
          for (const p of t.history ?? []) {
            const ms = parseLocalTimestampMs(p.time);
            if (ms > 0 && typeof p.value === "number" && Number.isFinite(p.value)) m.set(ms, p.value);
          }
          while (m.size > MAX_POINTS) m.delete(Math.min(...m.keys()));
        }
      }
      const series: Record<string, Array<{ t: number; v: number }>> = {};
      for (const [k, m] of acc.current) series[k] = [...m.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ t, v }));
      const got = Object.keys(data).length;
      if (alive.current)
        setState({
          checked: true,
          connected: got > 0,
          version: health.engine_version,
          readOnly: health.read_only,
          synthetic: Object.values(data).some((d) => d.forecast.contains_synthetic || d.status?.contains_synthetic === true),
          lastAt: at,
          error: got > 0 ? null : firstErr ?? "引擎沒有回傳即時預測",
          busy: false,
          data,
          series,
        });
    } catch (e) {
      if (alive.current)
        setState((s) => ({
          ...s,
          checked: true,
          connected: false,
          lastAt: at,
          error: e instanceof Error ? e.message : "連線失敗",
          busy: false,
          data: {},
        }));
    }
  }, [idsKey]);

  useEffect(() => {
    alive.current = true;
    if (!enabled || !idsKey) return;
    void run();
    const t = window.setInterval(() => {
      if (!document.hidden) void run();
    }, ENGINE_POLL_SEC * 1000);
    return () => {
      alive.current = false;
      window.clearInterval(t);
    };
  }, [enabled, idsKey, run]);

  return { ...state, refresh: () => void run() };
}
