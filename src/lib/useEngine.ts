// 連到你電腦上的分析引擎：定時問 /api/health，連上時抓各場域的即時預測與狀態。
// 引擎網址與金鑰只存在伺服器環境變數；這裡只透過同源的 /api/live/* 讀取（唯讀）。
import { useCallback, useEffect, useRef, useState } from "react";
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
  refresh: () => void;
}

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
  });
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
