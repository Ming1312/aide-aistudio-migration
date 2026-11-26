import type {
  AnomaliesResponse,
  DataKind,
  DecisionExplainResponse,
  DecisionSupportResponse,
  ExplainRequest,
  ExplainResponse,
  ForecastResponse,
  PrecomputedForecasts,
  PrecomputedFormalSheep,
  Provenance,
  RealCatalog,
} from "../../contracts/types";

export type PageId = "overview" | "data" | "decision" | "import" | "settings";

export interface ApiHealthStatus {
  ok: boolean;
  engine_connected: boolean;
  engine_version: string | null;
  read_only: boolean;
  version_warning: boolean;
  warning_message: string | null;
  gemini_configured: boolean;
  admin_configured: boolean;
  precomputed_available: boolean;
  live_engine_connected?: boolean;
  live_writes_enabled?: boolean;
  live_sim_enabled?: boolean;
}

export type AdminRole = "viewer" | "demo_admin" | "admin";

export interface AdminRoleStatus {
  /** 是否設定了正式管理者（ADMIN_PASSPHRASE_HASH） */
  configured: boolean;
  role: AdminRole;
  /** 沒有正式管理者且未被停用時，伺服器開放公開的展示預設帳號 */
  demo_available?: boolean;
  demo_hint?: { account: string; password: string };
}

/** GET /api/admin/status：只有「是否設定」的布林值，沒有任何值 */
export interface AdminStatusInfo {
  role: AdminRole;
  engine_url_configured: boolean;
  engine_api_key_configured: boolean;
  engine_admin_key_configured: boolean;
  gemini_configured: boolean;
  real_admin_configured: boolean;
  demo_account_active: boolean;
  real_account_name: string | null;
  can_write_engine: boolean;
}

export const ADMIN_ROLE_LABEL: Record<AdminRole, string> = {
  viewer: "訪客（唯讀）",
  demo_admin: "展示管理者（不能寫入引擎）",
  admin: "管理者",
};

export interface ParsedCsvRow {
  timestamp: string;
  tsMs: number;
  values: Record<string, number | null>;
  rawCells: string[];
  flagValue: string;
}

export interface ParsedCsvDataset {
  headers: string[];
  sensorHeaders: string[];
  flagColumn: "__real" | "__synthetic";
  rows: ParsedCsvRow[];
}

export type DecisionWithSource = DecisionSupportResponse & {
  source?: "engine" | "precomputed";
};

export interface CheckedDomainSummary {
  datasetId: string;
  checkedAt: string;
  rows: number;
  missingRatePct: number;
  nAnomalies: number;
  nTasks: number;
  latestTimestamp: string;
  statusLabel: string;
}

export type OverviewWindowHours = 24 | 72 | 168;

export interface OverviewDomainStatusItem {
  dataset_id: string;
  status: "has_issue" | "none_recent";
  window_hours: OverviewWindowHours;
  n_events: number;
  kinds: Record<string, number>;
  columns: string[];
  total_events: number;
  hours_since_last_event: number;
  data_end: string;
}

export interface OverviewStatusResponse {
  window_hours: OverviewWindowHours;
  meta: {
    generated_at: string;
    definition: string;
    no_claim: string;
  };
  datasets: Record<string, OverviewDomainStatusItem>;
  summary: {
    has_issue: number;
    none_recent: number;
  };
}

export interface ExplainModalPayload {
  title: string;
  request: ExplainRequest;
}

export type {
  AnomaliesResponse,
  DataKind,
  DecisionExplainResponse,
  DecisionSupportResponse,
  ExplainRequest,
  ExplainResponse,
  ForecastResponse,
  PrecomputedForecasts,
  PrecomputedFormalSheep,
  Provenance,
  RealCatalog,
};
