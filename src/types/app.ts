import type {
  AnomaliesResponse,
  DataKind,
  DecisionExplainResponse,
  DecisionSupportResponse,
  DemoBatch,
  ExplainRequest,
  ExplainResponse,
  ForecastResponse,
  PrecomputedForecasts,
  PrecomputedFormalSheep,
  Provenance,
  RealCatalog,
} from "../../contracts/types";

export type PageId =
  // 日常使用 (Tier 1)
  | "overview"
  | "domain_home"
  | "live_forecast"
  | "decision_support"
  | "data_update"
  | "explorer"
  | "model_lifecycle"
  // 羊舍決策 (Tier 2 — 只在羊舍顯示)
  | "sheep_risk"
  | "sheep_actions"
  | "sheep_diagnosis"
  | "sheep_forecast"
  | "sheep_replay"
  // 進階研究 (Tier 3)
  | "catalog"
  | "provenance"
  | "guide"
  | "ai_overview"
  | "decision_guide"
  | "model_performance"
  | "team_review";

export interface NavItem {
  id: PageId;
  label: string;
  tier: "daily" | "sheep" | "advanced";
  syntheticAllowed?: boolean;
}

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

export interface VerifyBatchReport {
  batch: DemoBatch;
  rows: number;
  start: string;
  end: string;
  duplicateTimestamps: number;
  gapCount: number;
  longestGapHours: number;
  overlapWithCurrent: number;
  allRowsHaveSyntheticFlag: boolean;
  passed: boolean;
  issues: string[];
}

export interface DemoVersionRecord {
  version: string;
  step: number;
  code: string;
  label: string;
  committedAt: string;
  rowCount: number;
  rangeStart: string;
  rangeEnd: string;
  batchSha256: string;
}

export interface DemoAuditEntry {
  id: string;
  at: string;
  action: "INIT" | "VERIFY" | "COMMIT" | "ROLLBACK";
  detail: string;
  version: string;
}

export interface DemoStepOutput {
  step: number;
  label: string;
  import_ok: boolean;
  import_s: number;
  triage_s: number;
  version: string;
  rows_appended: number;
  contains_synthetic: boolean;
  n_data_quality: number;
  n_signal: number;
  n_environment_suppressed: number;
  n_stale_tasks: number;
  alerts_true: number;
  alerts_false: number;
  missed: Array<Record<string, unknown>>;
  environment_events: Array<{ event: string; wrongly_alarmed: number }>;
  false_alert_examples: Array<{
    kind: string;
    column: string;
    start: string;
    end: string;
    matches: unknown[];
  }>;
  cards: Array<{
    level: "ok" | "warn" | "alert" | string;
    title: string;
    has_evidence: boolean;
    lead_sensor: string | null;
  }>;
  // 不建模場域沒有 guard、retrain_allowed、forecast 這三者
  guard?: {
    recommendation: string;
    raw: string;
    sensor_health: string;
    seconds: number;
  };
  retrain_allowed?: boolean;
  forecast?: {
    task: string;
    n_methods: number;
    applicability: string;
    seconds: number;
    spread: number;
  };
}

export interface DemoStepOutputsFile {
  schema: string;
  data_kind: "synthetic";
  source: string;
  warning: string;
  domains: Record<
    string,
    {
      stem: string;
      task: string;
      steps: DemoStepOutput[];
    }
  >;
}

export interface SyntheticTruthEvent {
  event_id: string;
  domain: string;
  scenario: string;
  type: string;
  category: string;
  columns: string[];
  start: string;
  end: string;
  should_alert: boolean;
  step: number;
  description: string;
  total_shift_sigma?: number;
}

export interface SyntheticTruthFile {
  batch_id: string;
  domain: string;
  meta: Record<string, unknown>;
  events: SyntheticTruthEvent[];
}

export interface DomainSyntheticState {
  currentStep: number;
  activeVersionIndex: number;
  versions: DemoVersionRecord[];
  auditLog: DemoAuditEntry[];
  verifiedStep: number | null;
  lastVerifyReport: VerifyBatchReport | null;
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
