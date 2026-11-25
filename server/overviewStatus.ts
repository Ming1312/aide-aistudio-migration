export type OverviewWindowHours = 24 | 72 | 168;

export const VALID_OVERVIEW_WINDOWS = new Set<number>([24, 72, 168]);

export interface OverviewWindowBucket {
  n_events: number;
  kinds: Record<string, number>;
  columns: string[];
}

export interface OverviewStatusDatasetEntry {
  dataset_id?: string;
  display_name?: string;
  data_end: string;
  total_events: number;
  last_event_end?: string;
  hours_since_last_event: number;
  windows: Record<string, OverviewWindowBucket>;
}

export interface OverviewStatusFile {
  meta: {
    generated_at: string;
    kind?: string;
    engine_version?: string;
    windows_hours?: number[];
    definition: string;
    no_claim: string;
  };
  datasets: Record<string, OverviewStatusDatasetEntry>;
}

export interface ComputedDomainStatus {
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

export class InvalidWindowHoursError extends Error {
  readonly status = 400;
  constructor(message = "window_hours 僅支援 24、72 或 168") {
    super(message);
    this.name = "InvalidWindowHoursError";
  }
}

export function parseWindowHours(raw: unknown): OverviewWindowHours {
  if (raw === undefined || raw === null || raw === "") {
    return 24;
  }
  if (typeof raw === "number") {
    if (Number.isInteger(raw) && VALID_OVERVIEW_WINDOWS.has(raw)) {
      return raw as OverviewWindowHours;
    }
    throw new InvalidWindowHoursError();
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!/^(24|72|168)$/.test(trimmed)) {
      throw new InvalidWindowHoursError();
    }
    return Number(trimmed) as OverviewWindowHours;
  }
  throw new InvalidWindowHoursError();
}

export function computeDomainStatus(
  entry: OverviewStatusDatasetEntry,
  windowHours: number,
  datasetId?: string
): ComputedDomainStatus {
  if (!Number.isInteger(windowHours) || !VALID_OVERVIEW_WINDOWS.has(windowHours)) {
    throw new InvalidWindowHoursError();
  }
  if (!entry || typeof entry !== "object" || !entry.windows) {
    throw new Error("無效的場域狀態資料結構");
  }

  const win = entry.windows[String(windowHours)];
  const nEvents = typeof win?.n_events === "number" ? win.n_events : 0;
  const status: "has_issue" | "none_recent" =
    nEvents > 0 ? "has_issue" : "none_recent";

  return {
    dataset_id: datasetId ?? entry.dataset_id ?? "",
    status,
    window_hours: windowHours as OverviewWindowHours,
    n_events: nEvents,
    kinds: win?.kinds ? { ...win.kinds } : {},
    columns: Array.isArray(win?.columns) ? [...win.columns] : [],
    total_events: entry.total_events,
    hours_since_last_event: entry.hours_since_last_event,
    data_end: entry.data_end,
  };
}
