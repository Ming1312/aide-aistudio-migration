// 產生 public/data/real_public/precomputed/thresholds.json：每個場域的政策感測器在整段歷史資料上的分位數格點。
// 用法：  npx tsx tools/build_thresholds.mts      （資料或政策感測器改了就重跑；測試會檢查這份檔案沒有過期）
import { readFileSync, writeFileSync } from "node:fs";
import type { PrecomputedAnomalies } from "../contracts/types.ts";
import { parseCsvText } from "../src/lib/csv.ts";
import { CANDIDATE_POLICIES } from "../src/lib/candidateRisk.ts";
import { GRID, buildEntry, validValues, type ThresholdTable } from "../src/lib/thresholds.ts";

const R = "public/data/real_public/";
const anomalies = JSON.parse(readFileSync(R + "precomputed/anomalies.json", "utf-8")) as PrecomputedAnomalies;
const table: ThresholdTable = {
  generated_at: "from-real_public-csv",
  grid: [...GRID],
  note: "各場域政策感測器的有效數值分位數（略過偵測器標出的整列歸零時段）；門檻預設注意＝P90、警戒＝P97.5（越低越危險的取對稱下尾）。是統計上的罕見程度，不是安全標準。",
  datasets: {},
};
for (const [id, p] of Object.entries(CANDIDATE_POLICIES)) {
  const rows = parseCsvText(readFileSync(`${R}${id}.csv`, "utf-8"), "__real").rows;
  table.datasets[id] = buildEntry(p.sensor, p.direction, validValues(rows, p.sensor, anomalies.datasets[id]?.events ?? []));
}
writeFileSync(R + "precomputed/thresholds.json", JSON.stringify(table, null, 1) + "\n");
console.log(Object.entries(table.datasets).map(([id, e]) => `${id} n=${e.n} excluded=${e.excluded} P90=${e.grid["0.9"]} P97.5=${e.grid["0.975"]} P10=${e.grid["0.1"]} P2.5=${e.grid["0.025"]}`).join("\n"));
