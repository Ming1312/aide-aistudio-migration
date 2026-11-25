import { MODEL_ORDER } from "../../contracts/types";
import type {
  LiveDomainsResponse,
  LiveEventItem,
  LiveEventsResponse,
  LiveForecastResponse,
  LiveForecastTask,
  LiveMonitorResponse,
  LivePendingResponse,
  LiveStatusResponse,
  LiveVersionEntry,
  LiveVersionsResponse,
  LiveWriteResult,
  ModelKey,
} from "../../contracts/types";
import { parseLocalTimestampMs } from "./trendChart";

export const LIVE_OFFLINE_MESSAGE = "尚未連線到 Python 引擎，即時預測不可用";
export const LIVE_FORMAT_ERROR_MESSAGE = "引擎回應格式不符";

export class LiveOfflineError extends Error {
  readonly isOffline = true;
  readonly status?: number;

  constructor(message = LIVE_OFFLINE_MESSAGE, status?: number) {
    super(message);
    this.name = "LiveOfflineError";
    this.status = status;
  }
}

export class LiveFormatError extends Error {
  readonly isFormatError = true;

  constructor(message = LIVE_FORMAT_ERROR_MESSAGE) {
    super(message);
    this.name = "LiveFormatError";
  }
}

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return Boolean(val) && typeof val === "object" && !Array.isArray(val);
}

export function validateLiveDomainsResponse(raw: unknown): LiveDomainsResponse {
  if (!isPlainObject(raw) || !Array.isArray(raw.domains)) {
    throw new LiveFormatError();
  }
  for (const item of raw.domains) {
    if (!isPlainObject(item) || typeof item.dataset_id !== "string") {
      throw new LiveFormatError();
    }
  }
  return raw as unknown as LiveDomainsResponse;
}

export function validateLiveStatusResponse(raw: unknown): LiveStatusResponse {
  if (
    !isPlainObject(raw) ||
    typeof raw.dataset_id !== "string" ||
    typeof raw.is_stale !== "boolean" ||
    typeof raw.mode !== "string" ||
    !Array.isArray(raw.flags)
  ) {
    throw new LiveFormatError();
  }
  return raw as unknown as LiveStatusResponse;
}

export function validateLiveForecastResponse(raw: unknown): LiveForecastResponse {
  if (
    !isPlainObject(raw) ||
    typeof raw.dataset_id !== "string" ||
    typeof raw.contains_synthetic !== "boolean" ||
    !Array.isArray(raw.tasks)
  ) {
    throw new LiveFormatError();
  }
  if (raw.history !== undefined && raw.history !== null && !isPlainObject(raw.history)) {
    throw new LiveFormatError();
  }
  if (raw.guard !== undefined && raw.guard !== null && !isPlainObject(raw.guard)) {
    throw new LiveFormatError();
  }
  for (const task of raw.tasks) {
    if (
      !isPlainObject(task) ||
      typeof task.task_id !== "string" ||
      typeof task.sensor !== "string" ||
      typeof task.horizon_h !== "number" ||
      typeof task.target_timestamp !== "string" ||
      !isPlainObject(task.models)
    ) {
      throw new LiveFormatError();
    }
  }
  return raw as unknown as LiveForecastResponse;
}

export function validateLiveMonitorResponse(raw: unknown): LiveMonitorResponse {
  if (
    !isPlainObject(raw) ||
    typeof raw.dataset_id !== "string" ||
    typeof raw.n_matured !== "number" ||
    !Array.isArray(raw.tasks)
  ) {
    throw new LiveFormatError();
  }
  for (const task of raw.tasks) {
    if (
      !isPlainObject(task) ||
      typeof task.task_id !== "string" ||
      typeof task.sensor !== "string" ||
      typeof task.horizon_h !== "number" ||
      !isPlainObject(task.methods)
    ) {
      throw new LiveFormatError();
    }
  }
  return raw as unknown as LiveMonitorResponse;
}

export function validateLiveVersionsResponse(raw: unknown): LiveVersionsResponse {
  if (!Array.isArray(raw)) {
    throw new LiveFormatError();
  }
  for (const item of raw) {
    if (
      !isPlainObject(item) ||
      typeof item.version_id !== "string" ||
      typeof item.created_at !== "string" ||
      typeof item.rows_added !== "number" ||
      typeof item.source !== "string"
    ) {
      throw new LiveFormatError();
    }
  }
  return raw as unknown as LiveVersionsResponse;
}

export function validateLivePendingResponse(raw: unknown): LivePendingResponse {
  if (!Array.isArray(raw)) {
    throw new LiveFormatError();
  }
  for (const item of raw) {
    if (!isPlainObject(item) || typeof item.upload_id !== "string") {
      throw new LiveFormatError();
    }
    if (item.blocks !== undefined && item.blocks !== null && !Array.isArray(item.blocks)) {
      throw new LiveFormatError();
    }
  }
  return raw as unknown as LivePendingResponse;
}

export function validateLiveEventsResponse(raw: unknown): LiveEventsResponse {
  if (!Array.isArray(raw)) {
    throw new LiveFormatError();
  }
  for (const item of raw) {
    if (
      !isPlainObject(item) ||
      typeof item.t !== "string" ||
      typeof item.kind !== "string"
    ) {
      throw new LiveFormatError();
    }
  }
  return raw as unknown as LiveEventsResponse;
}

export function validateLiveWriteResult(raw: unknown): LiveWriteResult {
  if (!isPlainObject(raw)) {
    throw new LiveFormatError();
  }
  return raw as unknown as LiveWriteResult;
}

export function selectRecentVersionsNewestFirst(
  versions: LiveVersionEntry[],
  limit = 10
): LiveVersionEntry[] {
  if (!Array.isArray(versions) || versions.length === 0 || limit <= 0) {
    return [];
  }
  return versions.slice(-limit).reverse();
}

export function getDefaultRollbackTarget(
  versions: LiveVersionEntry[],
  currentVersion?: string | null
): string {
  if (!Array.isArray(versions) || versions.length <= 1) {
    return "";
  }
  let currentIdx = -1;
  if (currentVersion) {
    currentIdx = versions.findIndex((v) => v.version_id === currentVersion);
  }
  if (currentIdx === -1) {
    currentIdx = versions.findIndex((v) => v.is_current === true);
  }
  if (currentIdx === -1) {
    return versions[versions.length - 2]?.version_id ?? "";
  }
  if (currentIdx <= 0) {
    return "";
  }
  return versions[currentIdx - 1]?.version_id ?? "";
}

export function orderEventsNewestFirst(events: LiveEventItem[]): LiveEventItem[] {
  if (!Array.isArray(events) || events.length === 0) {
    return [];
  }
  return [...events].reverse();
}

export function isLiveDataSynthetic(
  status: LiveStatusResponse | null | undefined,
  forecast: LiveForecastResponse | null | undefined
): boolean {
  if (status?.latest_source === "synthetic" || status?.contains_synthetic === true) {
    return true;
  }
  if (forecast?.contains_synthetic === true || forecast?.data_kind === "synthetic") {
    return true;
  }
  if (forecast?.tasks?.some((t) => t.contains_synthetic === true)) {
    return true;
  }
  return false;
}

export type LiveBannerKind = "synthetic" | "real" | "offline";

export function getLiveBannerKind(
  status: LiveStatusResponse | null | undefined,
  forecast: LiveForecastResponse | null | undefined
): LiveBannerKind {
  if (isLiveDataSynthetic(status, forecast)) {
    return "synthetic";
  }
  if (status && status.latest_source) {
    return "real";
  }
  return "offline";
}

export interface FreshnessDisplay {
  isStale: boolean;
  badgeLabel: "新鮮" | "資料過舊";
  warningText: string | null;
  settingText: string;
}

export function getFreshnessDisplay(
  status: Pick<LiveStatusResponse, "is_stale" | "stale_after_h">
): FreshnessDisplay {
  const isStale = Boolean(status.is_stale);
  const settingText =
    typeof status.stale_after_h === "number" && Number.isFinite(status.stale_after_h)
      ? `超過 ${status.stale_after_h} 小時列為資料過舊（監測設定，不是門檻）`
      : "監測設定，不是門檻";
  return {
    isStale,
    badgeLabel: isStale ? "資料過舊" : "新鮮",
    warningText: isStale ? "預測可能已不代表現況" : null,
    settingText,
  };
}

export function formatLiveClockMode(mode: string | undefined | null): string {
  const m = String(mode ?? "").toLowerCase();
  if (m === "sim" || m === "simulated" || m === "simulation") {
    return "模擬時鐘";
  }
  if (m === "real" || m === "realtime" || m === "wall") {
    return "真實時鐘";
  }
  return mode ? String(mode) : "未標示";
}

export function doesForecastMatchVersion(
  status: LiveStatusResponse | null | undefined,
  forecast: LiveForecastResponse | null | undefined
): boolean | null {
  if (typeof status?.forecast_matches_version === "boolean") {
    return status.forecast_matches_version;
  }
  const cur = status?.current_version;
  const fcVer = forecast?.data_version ?? status?.forecast_data_version;
  if (!cur || !fcVer) return null;
  return cur === fcVer;
}

export function formatLiveDecisionZh(decision: string | undefined | null): string {
  const raw = String(decision ?? "").trim().toUpperCase();
  switch (raw) {
    case "COMMITTED":
    case "COMMIT":
      return "已提交";
    case "NO_NEW_DATA":
    case "NOOP":
    case "NO_DATA":
      return "沒有新資料";
    case "KEPT_EXISTING":
    case "SKIPPED_EXISTING":
    case "KEEP_EXISTING":
      return "保留既有資料未寫入";
    case "BLOCKED":
    case "BLOCK":
    case "REJECTED":
      return "被拒絕";
    case "QUARANTINED":
    case "QUARANTINE":
    case "PENDING":
    case "PENDING_APPROVAL":
    case "NEEDS_APPROVAL":
      return "留待人工核准";
    default:
      return decision ? String(decision) : "已完成";
  }
}

export function formatApplicabilityStatus(status: string | undefined | null): {
  label: "可用" | "需留意" | "不適用";
  tone: "blue" | "amber" | "rose";
} {
  const s = String(status ?? "").toLowerCase();
  if (s === "usable" || s === "available" || s === "ok" || s === "可用") {
    return { label: "可用", tone: "blue" };
  }
  if (
    s === "caution" ||
    s === "warning" ||
    s === "needs_review" ||
    s === "degraded" ||
    s === "需留意"
  ) {
    return { label: "需留意", tone: "amber" };
  }
  return { label: "不適用", tone: "rose" };
}

export interface LiveSensorTaskGroup {
  sensor: string;
  unit: string;
  tasks: LiveForecastTask[];
}

export function groupLiveTasksBySensor(
  tasks: LiveForecastTask[]
): LiveSensorTaskGroup[] {
  const groups = new Map<string, LiveSensorTaskGroup>();
  for (const task of tasks) {
    const existing = groups.get(task.sensor);
    if (existing) {
      existing.tasks.push(task);
    } else {
      groups.set(task.sensor, {
        sensor: task.sensor,
        unit: task.unit ?? "",
        tasks: [task],
      });
    }
  }
  for (const group of groups.values()) {
    group.tasks.sort((a, b) => a.horizon_h - b.horizon_h);
  }
  return Array.from(groups.values());
}

export interface LiveSensorChartPoint {
  tsMs: number;
  time: string;
  historyValue?: number | null;
  persistence?: number | null;
  moving_average?: number | null;
  seasonal_naive_24h?: number | null;
  linear_ar4?: number | null;
  HGB?: number | null;
  XGB?: number | null;
}

export function buildLiveSensorChartSeries(
  tasksForSensor: LiveForecastTask[],
  sharedHistory?: Array<{ time: string; value: number | null }>
): LiveSensorChartPoint[] {
  const byTs = new Map<number, LiveSensorChartPoint>();

  const historySource =
    sharedHistory && sharedHistory.length > 0
      ? sharedHistory
      : tasksForSensor.find((t) => Array.isArray(t.history) && t.history.length > 0)
          ?.history ?? [];

  for (const pt of historySource) {
    if (!pt || typeof pt.time !== "string") continue;
    const tsMs = parseLocalTimestampMs(pt.time);
    if (tsMs === null) continue;
    byTs.set(tsMs, {
      tsMs,
      time: pt.time,
      historyValue: pt.value,
    });
  }

  for (const task of tasksForSensor) {
    const tsMs = parseLocalTimestampMs(task.target_timestamp);
    if (tsMs === null) continue;
    const row = byTs.get(tsMs) ?? {
      tsMs,
      time: task.target_timestamp,
    };
    for (const modelKey of MODEL_ORDER) {
      const m = task.models?.[modelKey];
      if (m && typeof m.value === "number" && Number.isFinite(m.value)) {
        (row as unknown as Record<string, unknown>)[modelKey] = m.value;
      }
    }
    byTs.set(tsMs, row);
  }

  return Array.from(byTs.values()).sort((a, b) => a.tsMs - b.tsMs);
}

export function shouldRefetchForecastOnPoll(
  prevStatus: LiveStatusResponse | null,
  nextStatus: LiveStatusResponse,
  prevForecast: LiveForecastResponse | null
): boolean {
  if (!prevForecast) {
    return (nextStatus.n_tasks ?? 1) > 0;
  }
  const prevVersion =
    prevForecast.data_version ??
    prevStatus?.forecast_data_version ??
    prevStatus?.current_version ??
    null;
  const nextVersion =
    nextStatus.forecast_data_version ?? nextStatus.current_version ?? null;
  if (nextVersion && nextVersion !== prevVersion) {
    return true;
  }
  const prevIssued = prevForecast.issued_at ?? prevStatus?.issued_at ?? null;
  const nextIssued = nextStatus.issued_at ?? null;
  if (nextIssued && nextIssued !== prevIssued) {
    return true;
  }
  return false;
}

export const LIVE_METHOD_LABELS: Record<ModelKey, string> = {
  persistence: "持續性基準",
  moving_average: "滑動平均",
  seasonal_naive_24h: "24h 季節基準",
  linear_ar4: "線性 AR(4)",
  HGB: "HGB",
  XGB: "XGB",
};
