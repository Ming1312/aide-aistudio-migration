import type {
  AnomaliesResponse,
  DecisionExplainResponse,
  ExplainRequest,
  ExplainResponse,
  ForecastRequest,
  ForecastResponse,
  LiveDomainsResponse,
  LiveEventsResponse,
  LiveForecastResponse,
  LiveMonitorResponse,
  LivePendingResponse,
  LiveStatusResponse,
  LiveVersionsResponse,
  LiveWriteResult,
  PrecomputedAnomalies,
  PrecomputedForecasts,
  PrecomputedFormalSheep,
  Provenance,
  RealCatalog,
} from "../../contracts/types";
import type {
  AdminRoleStatus,
  AdminStatusInfo,
  ApiHealthStatus,
  DecisionWithSource,
  OverviewStatusResponse,
  OverviewWindowHours,
  ParsedCsvDataset,
} from "../types/app";
import { parseCsvText } from "./csv";
import {
  LIVE_FORMAT_ERROR_MESSAGE,
  LIVE_OFFLINE_MESSAGE,
  LiveFormatError,
  LiveOfflineError,
  validateLiveDomainsResponse,
  validateLiveEventsResponse,
  validateLiveForecastResponse,
  validateLiveMonitorResponse,
  validateLivePendingResponse,
  validateLiveStatusResponse,
  validateLiveVersionsResponse,
  validateLiveWriteResult,
} from "./liveForecast";
import {
  adaptLiveDomains,
  adaptLiveForecast,
  adaptLiveMonitor,
  adaptLiveStatus,
} from "./liveAdapter";

const jsonCache = new Map<string, Promise<unknown>>();
const textCache = new Map<string, Promise<string>>();
const csvCache = new Map<string, Promise<ParsedCsvDataset>>();

async function fetchJsonCached<T>(url: string): Promise<T> {
  const existing = jsonCache.get(url);
  if (existing) return existing as Promise<T>;
  const promise = fetch(url).then(async (res) => {
    if (!res.ok) {
      throw new Error(`載入失敗（HTTP ${res.status}）：${url}`);
    }
    return (await res.json()) as T;
  });
  jsonCache.set(url, promise);
  return promise;
}

async function fetchTextCached(url: string): Promise<string> {
  const existing = textCache.get(url);
  if (existing) return existing;
  const promise = fetch(url).then(async (res) => {
    if (!res.ok) {
      throw new Error(`載入失敗（HTTP ${res.status}）：${url}`);
    }
    return await res.text();
  });
  textCache.set(url, promise);
  return promise;
}

export function loadRealCatalog(): Promise<RealCatalog> {
  return fetchJsonCached<RealCatalog>("/data/real_public/catalog_real.json");
}

export function loadProvenance(): Promise<Provenance> {
  return fetchJsonCached<Provenance>("/data/real_public/PROVENANCE.json");
}

export function loadDataUseStatement(): Promise<string> {
  return fetchTextCached("/data/real_public/DATA_USE_STATEMENT.md");
}

export function loadPrecomputedForecasts(): Promise<PrecomputedForecasts> {
  return fetchJsonCached<PrecomputedForecasts>(
    "/data/real_public/precomputed/forecasts.json"
  );
}

export function loadPrecomputedAnomalies(): Promise<PrecomputedAnomalies> {
  return fetchJsonCached<PrecomputedAnomalies>(
    "/data/real_public/precomputed/anomalies.json"
  );
}

export function loadPrecomputedFormalSheep(): Promise<PrecomputedFormalSheep> {
  return fetchJsonCached<PrecomputedFormalSheep>(
    "/data/real_public/precomputed/formal_sheep.json"
  );
}

export function loadRealCsv(datasetId: string): Promise<ParsedCsvDataset> {
  const key = `real:${datasetId}`;
  const existing = csvCache.get(key);
  if (existing) return existing;
  const promise = fetch(`/data/real_public/${encodeURIComponent(datasetId)}.csv`)
    .then(async (res) => {
      if (!res.ok) throw new Error(`無法載入真實資料 CSV（HTTP ${res.status}）`);
      const text = await res.text();
      return parseCsvText(text, "__real");
    });
  csvCache.set(key, promise);
  return promise;
}

// ---- 同源伺服器 API 呼叫 ----

export async function fetchApiHealth(): Promise<ApiHealthStatus> {
  const res = await fetch("/api/health");
  if (!res.ok) throw new Error(`健康檢查失敗（HTTP ${res.status}）`);
  return (await res.json()) as ApiHealthStatus;
}

export async function fetchOverviewStatus(
  windowHours: OverviewWindowHours = 24
): Promise<OverviewStatusResponse> {
  const res = await fetch(
    `/api/overview/status?window_hours=${encodeURIComponent(String(windowHours))}`
  );
  const data = (await res.json().catch(() => ({}))) as { detail?: string };
  if (!res.ok) {
    throw new Error(
      data.detail || `載入總覽場域狀態失敗（HTTP ${res.status}）`
    );
  }
  return data as OverviewStatusResponse;
}

export async function fetchAdminRole(): Promise<AdminRoleStatus> {
  const res = await fetch("/api/admin/role");
  if (!res.ok) throw new Error(`無法讀取角色（HTTP ${res.status}）`);
  return (await res.json()) as AdminRoleStatus;
}

export interface AdminLoginResponse {
  ok: boolean;
  role: "viewer" | "demo_admin" | "admin";
  locked?: boolean;
  remaining?: number;
  remainingTries?: number;
  message: string;
}

export async function loginAdmin(
  passphrase: string,
  account?: string
): Promise<AdminLoginResponse> {
  const res = await fetch("/api/admin/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(account ? { account, passphrase } : { passphrase }),
  });
  return (await res.json()) as AdminLoginResponse;
}

export async function fetchAdminStatus(): Promise<AdminStatusInfo> {
  const res = await fetch("/api/admin/status");
  if (!res.ok) throw new Error(`無法讀取管理狀態（HTTP ${res.status}）`);
  return (await res.json()) as AdminStatusInfo;
}

export async function logoutAdmin(): Promise<void> {
  await fetch("/api/admin/logout", { method: "POST" });
}

export async function fetchDatasetAnomalies(
  datasetId: string
): Promise<AnomaliesResponse & { source?: string; generated_at?: string }> {
  const res = await fetch(`/api/datasets/${encodeURIComponent(datasetId)}/anomalies`);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { detail?: string };
    throw new Error(err.detail || `載入異常分析失敗（HTTP ${res.status}）`);
  }
  return (await res.json()) as AnomaliesResponse & {
    source?: string;
    generated_at?: string;
  };
}

export async function fetchEngineForecast(
  body: ForecastRequest
): Promise<ForecastResponse> {
  const res = await fetch("/api/forecast", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error((data as { detail?: string }).detail || "引擎預測失敗");
  }
  return data as ForecastResponse;
}

export async function fetchDecisionSupport(
  datasetId: string
): Promise<DecisionWithSource> {
  const res = await fetch(`/api/decision/${encodeURIComponent(datasetId)}`);
  const data = await res.json();
  if (!res.ok) {
    throw new Error((data as { detail?: string }).detail || "載入決策輔助失敗");
  }
  return data as DecisionWithSource;
}

export async function requestDecisionExplain(
  datasetId: string,
  question?: string
): Promise<DecisionExplainResponse> {
  const res = await fetch("/api/decision/explain", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      dataset_id: datasetId,
      ...(question && question.trim() ? { question: question.trim() } : {}),
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error((data as { detail?: string }).detail || "決策白話解釋失敗");
  }
  return data as DecisionExplainResponse;
}

export async function requestGeneralExplain(
  req: ExplainRequest
): Promise<ExplainResponse> {
  const res = await fetch("/api/ai/explain", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error((data as { detail?: string }).detail || "白話解釋請求失敗");
  }
  return data as ExplainResponse;
}

// ---- 即時預測資料流 (/api/live/*) ----

async function fetchLiveJson<T>(
  url: string,
  validate: (raw: unknown) => T,
  init?: RequestInit
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new LiveOfflineError(LIVE_OFFLINE_MESSAGE);
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (!/application\/json/i.test(contentType)) {
    throw new LiveOfflineError(LIVE_OFFLINE_MESSAGE, res.status);
  }

  const text = await res.text().catch(() => "");
  let parsed: unknown = null;
  let parseFailed = false;
  if (!text.trim()) {
    parseFailed = true;
  } else {
    try {
      parsed = JSON.parse(text);
    } catch {
      parseFailed = true;
    }
  }

  if (!res.ok) {
    const detail =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as { detail?: unknown }).detail
        : undefined;
    const detailStr = typeof detail === "string" && detail.trim() ? detail : undefined;

    if (res.status === 502 && detailStr === LIVE_FORMAT_ERROR_MESSAGE) {
      throw new LiveFormatError(LIVE_FORMAT_ERROR_MESSAGE);
    }
    if (res.status >= 500) {
      throw new LiveOfflineError(detailStr || LIVE_OFFLINE_MESSAGE, res.status);
    }
    if (parseFailed) {
      throw new LiveFormatError(LIVE_FORMAT_ERROR_MESSAGE);
    }
    const err = new Error(
      detailStr || `即時預測端點請求失敗（HTTP ${res.status}）`
    ) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }

  if (parseFailed) {
    throw new LiveFormatError(LIVE_FORMAT_ERROR_MESSAGE);
  }

  return validate(parsed);
}

export function fetchLiveDomains(): Promise<LiveDomainsResponse> {
  return fetchLiveJson("/api/live/domains", (raw) =>
    validateLiveDomainsResponse(adaptLiveDomains(raw))
  );
}

export function fetchLiveStatus(datasetId: string): Promise<LiveStatusResponse> {
  return fetchLiveJson(
    `/api/live/${encodeURIComponent(datasetId)}/status`,
    (raw) => validateLiveStatusResponse(adaptLiveStatus(raw))
  );
}

export function fetchLiveForecast(
  datasetId: string
): Promise<LiveForecastResponse> {
  return fetchLiveJson(
    `/api/live/${encodeURIComponent(datasetId)}/forecast`,
    (raw) => validateLiveForecastResponse(adaptLiveForecast(raw))
  );
}

export function fetchLiveMonitor(
  datasetId: string
): Promise<LiveMonitorResponse> {
  return fetchLiveJson(
    `/api/live/${encodeURIComponent(datasetId)}/monitor`,
    (raw) => validateLiveMonitorResponse(adaptLiveMonitor(raw))
  );
}

export function fetchLiveVersions(
  datasetId: string
): Promise<LiveVersionsResponse> {
  return fetchLiveJson(
    `/api/live/${encodeURIComponent(datasetId)}/versions`,
    validateLiveVersionsResponse
  );
}

export function fetchLivePending(
  datasetId: string
): Promise<LivePendingResponse> {
  return fetchLiveJson(
    `/api/live/${encodeURIComponent(datasetId)}/pending`,
    validateLivePendingResponse
  );
}

export function fetchLiveEvents(
  datasetId: string
): Promise<LiveEventsResponse> {
  return fetchLiveJson(
    `/api/live/${encodeURIComponent(datasetId)}/events`,
    validateLiveEventsResponse
  );
}

export function postLiveIngest(
  datasetId: string,
  payload: {
    csv_text: string;
    source: "synthetic" | "unverified_import";
    license_note: string;
    filename?: string;
  }
): Promise<LiveWriteResult> {
  return fetchLiveJson(
    `/api/live/${encodeURIComponent(datasetId)}/ingest`,
    validateLiveWriteResult,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }
  );
}

export function postLiveCommit(
  datasetId: string,
  payload: { upload_id: string; notes?: string }
): Promise<LiveWriteResult> {
  return fetchLiveJson(
    `/api/live/${encodeURIComponent(datasetId)}/commit`,
    validateLiveWriteResult,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }
  );
}

export function postLiveRollback(
  datasetId: string,
  payload: { to_version: string; reason: string }
): Promise<LiveWriteResult> {
  return fetchLiveJson(
    `/api/live/${encodeURIComponent(datasetId)}/rollback`,
    validateLiveWriteResult,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }
  );
}

export function postLiveRecompute(datasetId: string): Promise<LiveWriteResult> {
  return fetchLiveJson(
    `/api/live/${encodeURIComponent(datasetId)}/recompute`,
    validateLiveWriteResult,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }
  );
}

export function postLiveSimTick(
  datasetId: string,
  payload: { scenario: "normal" | "missing" | "stuck" | "disconnect" }
): Promise<LiveWriteResult> {
  return fetchLiveJson(
    `/api/live/${encodeURIComponent(datasetId)}/sim/tick`,
    validateLiveWriteResult,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }
  );
}
