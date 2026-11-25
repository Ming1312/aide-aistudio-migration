// 引擎 /v1/live/* 的『真實回應』（見 docs/11_LIVE_PIPELINE.md、python_engine_private/live/service.py）→ 前端頁面使用的型別。
// 只做欄位對應與形狀整理，不產生任何數字、預測或狀態判斷；缺必要欄位時丟 LiveFormatError。
import { LiveFormatError } from "./liveForecast";

const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

export function adaptLiveDomains(raw: unknown): unknown {
  if (!Array.isArray(raw)) throw new LiveFormatError();
  return {
    domains: raw.map((d) => {
      if (!isObj(d) || typeof d.dataset_id !== "string") throw new LiveFormatError();
      return {
        dataset_id: d.dataset_id,
        mode: d.mode,
        current_version: d.current_seq === 0 ? null : `v${String(d.current_seq).padStart(4, "0")}`,
        latest_source: d.latest_source ?? null,
        is_stale: d.freshness === "stale",
        data_end: d.data_end ?? null,
        n_tasks: isObj(d.forecast) ? (d.forecast.n_ok as number) : undefined,
      };
    }),
  };
}

export function adaptLiveStatus(raw: unknown): unknown {
  if (!isObj(raw) || typeof raw.dataset_id !== "string" || !Array.isArray(raw.flags) || typeof raw.freshness !== "string") throw new LiveFormatError();
  const fc = isObj(raw.forecast) ? raw.forecast : null;
  return {
    dataset_id: raw.dataset_id,
    data_end: raw.data_end ?? null,
    mode: raw.mode === "simulated" ? "sim" : raw.mode,
    is_stale: raw.freshness === "stale",
    stale_after_h: raw.stale_after_h ?? null,
    hours_since_last: raw.staleness_h ?? null,
    current_version: raw.version_id ?? null,
    latest_source: raw.latest_source ?? null,
    contains_synthetic: raw.latest_source === "synthetic",
    forecast_matches_version: fc ? Boolean(fc.up_to_date) : null,
    forecast_data_version: fc ? (fc.data_version as string) : null,
    issued_at: fc ? (fc.issued_at as string) : null,
    n_tasks: fc ? (fc.n_ok as number) : 0,
    flags: raw.flags,
    health: { ok: raw.health === "ok", status: String(raw.health), detail: raw.health === "ok" ? "沒有旗標" : "有旗標需要留意" },
  };
}

export function adaptLiveForecast(raw: unknown): unknown {
  if (!isObj(raw) || typeof raw.dataset_id !== "string" || !Array.isArray(raw.tasks)) throw new LiveFormatError();
  const tasks = (raw.tasks as unknown[]).filter((t) => isObj(t) && isObj(t.models)).map((t) => {
    const x = t as Record<string, any>;
    const hist = isObj(x.history) && Array.isArray(x.history.times) ? x.history.times.map((tm: string, i: number) => ({ time: tm, value: x.history.values[i] ?? null })) : [];
    const ap = isObj(x.applicability) ? x.applicability : null;
    return {
      task_id: x.task_id,
      sensor: x.sensor,
      horizon_h: x.horizon_h,
      origin: x.origin,
      target_timestamp: x.target_time,
      contains_synthetic: Boolean(x.contains_synthetic),
      issued_at: raw.issued_at,
      data_version: x.data_version,
      history: hist,
      applicability: ap ? { status: ap.status, reasons: (ap.reasons as any[]).map((r) => (typeof r === "string" ? r : r.text)) } : undefined,
      models: x.models,
    };
  });
  const guard = isObj(raw.guard) ? { alerts_ok: Boolean(raw.guard.alerts_ok), reason: (raw.guard.error as string) ?? null } : undefined;
  return {
    dataset_id: raw.dataset_id,
    data_version: raw.data_version ?? null,
    issued_at: raw.issued_at ?? null,
    contains_synthetic: tasks.some((t) => t.contains_synthetic),
    n_tasks: raw.n_tasks,
    guard,
    tasks,
    limits: [raw.disclaimer].filter(Boolean),
    no_claim: "研究預測（探索性、未經獨立前瞻驗證）；沒有任何警戒門檻；不控制任何設備。",
  };
}

export function adaptLiveMonitor(raw: unknown): unknown {
  if (!isObj(raw) || typeof raw.dataset_id !== "string" || !Array.isArray(raw.tasks)) throw new LiveFormatError();
  return {
    dataset_id: raw.dataset_id,
    note: raw.note,
    n_matured: raw.n_matured,
    tasks: (raw.tasks as any[]).map((t) => ({
      task_id: t.task_id,
      sensor: t.sensor,
      horizon_h: t.horizon_h,
      n_matured: t.n_matured,
      methods: Object.fromEntries(Object.entries(t.mae as Record<string, number>).map(([k, v]) => [k, { mae: v, delta_vs_persistence: k === "persistence" ? 0 : (t.rel_to_persistence?.[k] ?? null), n: t.n_matured }])),
    })),
  };
}
