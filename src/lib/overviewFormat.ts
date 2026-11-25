const OVERVIEW_KIND_LABELS: Record<string, string> = {
  stuck_sensor: "讀值卡住",
  drift_or_offset: "漂移或偏移",
  out_of_historical_range: "超出歷史範圍",
  outage_missing_rows: "整列缺失（斷線）",
  outage_zero_rows: "整列歸零（斷電／斷線）",
  short_event_or_step: "短暫突波或階躍",
  decoupled_from_peers: "與其他感測器脫鉤",
  decoupling: "與其他感測器脫鉤",
  peer_decoupling: "與其他感測器脫鉤",
  variance_increase: "雜訊變大",
  noise_increase: "雜訊變大",
};

export function formatOverviewKindZh(kind: string): string {
  return OVERVIEW_KIND_LABELS[kind] ?? kind;
}

export function formatOverviewKindsSummary(
  kinds: Record<string, number>
): string[] {
  return Object.entries(kinds)
    .filter(([, count]) => typeof count === "number" && count > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([kind, count]) => `${formatOverviewKindZh(kind)} × ${count}`);
}

export function formatOverviewColumnsPreview(
  columns: string[],
  limit = 4
): string {
  if (!Array.isArray(columns) || columns.length === 0) return "";
  const head = columns.slice(0, limit);
  if (columns.length <= limit) return head.join("、");
  return `${head.join("、")} 等 ${columns.length} 個感測器`;
}
