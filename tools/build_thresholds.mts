// 產生 public/data/real_public/precomputed/thresholds.json：每個場域「所有連續量感測器」在整段歷史資料上的分位數格點。
// 用法：  npx tsx tools/build_thresholds.mts      （資料改了就重跑；測試會檢查這份檔案沒有過期）
import { readFileSync, writeFileSync } from "node:fs";
import type { PrecomputedAnomalies, RealCatalog } from "../contracts/types.ts";
import { parseCsvText } from "../src/lib/csv.ts";
import { CANDIDATE_POLICIES } from "../src/lib/candidateRisk.ts";
import { GRID, buildEntry, defaultDirection, isThresholdSensor, validValues, type ThresholdTable } from "../src/lib/thresholds.ts";

const R = "public/data/real_public/";
const catalog = JSON.parse(readFileSync(R + "catalog_real.json", "utf-8")) as RealCatalog;
const anomalies = JSON.parse(readFileSync(R + "precomputed/anomalies.json", "utf-8")) as PrecomputedAnomalies;
const table: ThresholdTable = {
  generated_at: "from-real_public-csv",
  grid: [...GRID],
  note: "各場域連續量感測器的有效數值分位數（略過偵測器標出的整列歸零時段）；門檻預設注意＝P90、警戒＝P97.5（越低越危險的取對稱下尾）。是統計上的罕見程度，不是安全標準。",
  datasets: {},
};
for (const ds of catalog.datasets) {
  const rows = parseCsvText(readFileSync(`${R}${ds.id}.csv`, "utf-8"), "__real").rows;
  const events = anomalies.datasets[ds.id]?.events ?? [];
  const sensors: ThresholdTable["datasets"][string]["sensors"] = {};
  for (const col of ds.columns) {
    if (!isThresholdSensor(col)) continue;
    const pol = CANDIDATE_POLICIES[ds.id];
    const direction = pol && pol.sensor === col.key ? pol.direction : defaultDirection(col.key, col.unit);
    const v = validValues(rows, col.key, events);
    if (v.values.length < 48) continue;
    sensors[col.key] = buildEntry(col.key, direction, v);
  }
  table.datasets[ds.id] = { sensors };
}
writeFileSync(R + "precomputed/thresholds.json", JSON.stringify(table) + "\n");
console.log(Object.entries(table.datasets).map(([id, d]) => `${id}: ${Object.keys(d.sensors).length} sensors`).join("\n"));
