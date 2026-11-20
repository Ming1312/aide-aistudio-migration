// AIDE 契約型別（對應 contracts/openapi_engine_readonly.json 與 docs/04_API_CONTRACT.md）。
// 規則：data_kind 永遠要保留並顯示；合成資料不得與真實資料混在同一個圖例或同一份 Gemini 事實清單裡。

export type DataKind = "real" | "synthetic";

export type ModelKey = "persistence" | "moving_average" | "seasonal_naive_24h" | "linear_ar4" | "HGB" | "XGB";
export const MODEL_ORDER: ModelKey[] = ["persistence", "moving_average", "seasonal_naive_24h", "linear_ar4", "HGB", "XGB"];

export interface ErrorBody { detail: string }

export interface HealthResponse {
  ok: boolean; version: string; read_only: boolean; auth_required: boolean;
  datasets: Record<string, string>; // dataset_id -> sha256（原始資料雜湊）
  libs: Record<string, string>;
}

export interface SeriesResponse {
  dataset_id: string; data_kind: DataKind; n: number;
  timestamps: string[]; series: Record<string, Array<number | null>>;
}

export interface AnomalyEvent {
  detector: "threshold" | "resid_z" | "relation" | "stuck" | "quality";
  kind: string; kind_zh: string; column: string;
  start: string; end: string; detected_at: string; hours: number; score: number; note: string;
}
export interface AnomaliesResponse {
  dataset_id: string; data_kind: DataKind; n_events: number; events: AnomalyEvent[]; disclaimer: string; limits: string[];
}

export interface Metric { n: number; MAE: number; RMSE: number }
export interface IntervalInfo {
  shown: boolean; reason: string; status?: string; target_coverage?: number;
  lower: number | null; upper: number | null; holdout_coverage?: number | null; undercoverage_warning?: boolean;
}
export interface ModelForecast {
  label: string; kind: "ml" | "baseline";
  value: number | null;          // null 時一定有 refused
  refused: string | null;        // 拒絕原因（不插補、不借用其他模型）
  version?: string; variant?: string;
  validation: Metric | null; holdout: Metric | null;
  evidence?: string;             // HGB／XGB 的探索性證據文字（規則式；不是 LLM）
  interval?: IntervalInfo;
}
export interface ForecastRequest { dataset_id: string; sensor: string; horizon_h: number; origin?: string | null; history_hours?: number }
export interface ForecastResponse {
  data_kind: DataKind; mode: "歷史時點模擬預測"; dataset_id: string; task_id: string; sensor: string; horizon_h: number;
  unit: string; unit_status: string;
  forecast_origin: string; target_timestamp: string; last_observation_time: string | null; last_observation_value: number | null;
  actual_at_target: number | null; period: "train" | "validation" | "holdout" | "latest"; period_zh: string;
  best_baseline: ModelKey; models: Record<ModelKey, ModelForecast>;
  history: Array<{ time: string; value: number | null }>; future_actual: Array<{ time: string; value: number | null }>;
  origin_range: [string, string]; research_status: string; artifact_sha256: string;
  limits: string[]; no_claim: string;
  source?: "engine" | "precomputed_offline";   // Node 伺服器加上：資料來自即時引擎或離線預計算
  generated_at?: string;                        // 預計算才有
}

export interface FormalSheepRequest { as_of?: string; mode: "strict" | "full" }
export interface FormalSheepResponse {
  data_kind: "real"; dataset_id: "sheep_barn"; target: "成羊區THI"; horizon_h: 3; as_of: string; mode: "strict" | "full";
  model_version: string; train_until: string; in_sample: boolean;
  result: Record<string, unknown>;  // Phase 2.6 輸出（點預測、90% 區間、超標機率、window_risk…）原封不動
  warnings: string[]; limits: string[]; no_claim: string;
}

// ---- 展示資料（app_repo/public/data/demo_synthetic）
export interface DemoBatch { step: number; code: string; label: string; story: string | null; file: string; rows: number; start: string; end: string; sha256: string; pre_imported: boolean; truth_events: number }
export interface DemoDomain { id: string; stem: string; display_name: string; domain_type: string; story: Record<string, unknown>; batches: DemoBatch[] }
export interface DemoManifest { schema: string; data_kind: "synthetic"; banner: string; domains: DemoDomain[] }

// ---- Gemini 解釋（Node 伺服器 /api/ai/explain）
export interface ExplainRequest {
  kind: "data" | "forecast" | "anomaly" | "compare";
  data_kind: DataKind;
  dataset_id: string;
  facts: Fact[];           // 由前端／Node 從引擎回應『整理』出的事實；Gemini 只能引用這裡的內容
  question?: string;
}
export interface Fact { id: string; text: string; value?: number | string; unit?: string }
export interface ExplainResponse {
  summary: string;
  observations: Array<{ text: string; cites: string[] }>;
  possible_causes: Array<{ text: string; cites: string[] }>;   // 一律是『常見原因的列舉』，不是診斷
  cannot_conclude: string[];
  suggested_checks: string[];                                    // 只有『檢查／確認／通知』類
  disclaimers: string[];                                         // 由伺服器強制附上（合成、探索性、非即時…）
  guard: { ungrounded_numbers: string[]; unknown_cites: string[]; ok: boolean };  // 伺服器端核對結果
}

// ---- 真實資料（public/data/real_public；使用者聲明可公開展示；與合成資料分開，永遠帶 __real=1）
export interface RealColumn {
  key: string; raw_header: string; unit: string; unit_status: string; unit_note: string; category: string; sensor_type: string; measurement_kind: string; description: string;
  classification_status: string; zero_semantics: string; is_cumulative_counter: boolean; physical_range: [number, number] | null;
  n_rows: number; n_observed: number; missing_frac: number | null; min: number | null; max: number | null; mean: number | null; std: number | null; distinct_values: number;
  available_analysis: string[]; evidence: string;
}
export interface RealDataset {
  id: string; display_name: string; domain_id: string; domain_type: string; data_kind: "real"; file: string;
  time: { start: string; end: string; rows: number; sampling: string; expected_hours: number | null; missing_hours_from_gaps: number | null; n_gaps: number | null; longest_gap_hours: number | null; timezone: string; timestamp_status: string };
  columns: RealColumn[]; forecast_tasks: Array<{ task_id: string; sensor: string; horizon_h: number; enabled: boolean; eligibility: string; policy_notes: string }>; provenance_ref: string;
}
export interface RealCatalog { schema: string; data_kind: "real"; provenance: string; datasets: RealDataset[] }

/** 來源與使用聲明：『已由使用者確認』與『尚未提供的外部證明』必須分開顯示。 */
export interface Provenance {
  schema: string; data_kind: "real";
  attestation: { kind: "user_attestation"; attested_by: string; attested_on: string; public_display_confirmed: true; datasets_covered: string[]; scope_uses: string[]; scope_basis: string; statement: string };
  source: { provider: string; programme: string; delivered_by: string; url: string | null; url_status: string; note: string };
  license: { standard_license_claimed: false; standard_license: null; terms_document: null; summary: string; evidence_status: "user_attestation_only"; external_evidence: null };
  timezone: { status: string; display: string };
  confirmed_by_user: string[]; not_provided: string[];
  remaining_items: Array<{ item: string; blocking: boolean; effect: string }>;
  datasets: Record<string, { display_name: string; original_file_name: string; original_sha256: string; rows: number; start: string; end: string; sampling: string; timezone: string; personal_data_check: { method: string; findings: number; checked_by_human: boolean; note: string } }>;
}

// ---- 預計算（離線）：引擎的真實輸出；不是即時；只涵蓋每個任務最近 168 個預測起點
export interface PrecomputedMeta { generated_at: string; source: string; kind: "precomputed_offline"; note: string; api_version: string }
export interface PrecomputedForecastTask {
  dataset_id: string; sensor: string; horizon_h: number; unit: string; unit_status: string;
  columns: ["origin", "target", "actual", "period", ...ModelKey[]];   // period：t 訓練期／v 驗證期／h 留存測試期／l 最新
  points: Array<[string, string, number | null, "t" | "v" | "h" | "l", ...Array<number | null>]>;
  best_baseline: ModelKey; variants: Record<string, string>;
  metrics: Record<string, { validation: Metric; holdout: Metric }>;
  evidence: Record<"HGB" | "XGB", string>;
  interval: Record<"HGB" | "XGB", { q: number | null; target: number; holdout_coverage: number | null; undercoverage_warning: boolean; status: string; available: boolean }>;  // 只有 period 為 h／l 的起點才顯示 value ± q
  refused_at_latest: Record<string, string>; artifact_sha256: string; model_names: Record<ModelKey, string>; origin_range: [string, string];
}
export interface PrecomputedForecasts { meta: PrecomputedMeta; tasks: Record<string, PrecomputedForecastTask> }
export interface PrecomputedAnomalies { meta: PrecomputedMeta; datasets: Record<string, AnomaliesResponse> }
export interface PrecomputedFormalSheep { meta: PrecomputedMeta; formal: { mode: "strict_replay"; n: number; rows: Array<{ as_of: string; model_version: string; in_sample: boolean; result: Record<string, unknown> }> } }
