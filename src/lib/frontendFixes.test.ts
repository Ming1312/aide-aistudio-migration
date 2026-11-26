import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getEffectiveBannerKind,
  isNavItemVisible,
  isRealOnlyGuardedPage,
} from "./dataKindPolicy";
import {
  buildTrueTimeTrendSeries,
  formatChartTimeLabel,
  groupSensorsByUnit,
  parseLocalTimestampMs,
} from "./trendChart";
import type { ParsedCsvRow } from "../types/app";

function makeRow(ts: string, values: Record<string, number | null>): ParsedCsvRow {
  return {
    timestamp: ts,
    tsMs: parseLocalTimestampMs(ts),
    values,
    rawCells: [],
    flagValue: "1",
  };
}

test("dataKindPolicy：橫幅依頁面內容決定，合成模式隱藏決策輔助與羊舍 5 頁", () => {
  // Always real pages stay 'real' even when global toggle is 'synthetic'
  assert.equal(getEffectiveBannerKind("domain_home", "synthetic"), "real");
  assert.equal(getEffectiveBannerKind("catalog", "synthetic"), "real");
  assert.equal(getEffectiveBannerKind("provenance", "synthetic"), "real");
  assert.equal(getEffectiveBannerKind("model_performance", "synthetic"), "real");

  // Data update is always 'synthetic' even when global toggle is 'real'
  assert.equal(getEffectiveBannerKind("data_update", "real"), "synthetic");

  // Overview & Explorer follow global toggle
  assert.equal(getEffectiveBannerKind("overview", "real"), "real");
  assert.equal(getEffectiveBannerKind("overview", "synthetic"), "synthetic");
  assert.equal(getEffectiveBannerKind("explorer", "real"), "real");
  assert.equal(getEffectiveBannerKind("explorer", "synthetic"), "synthetic");

  // Guarded real-only pages
  for (const page of [
    "decision_support",
    "decision_risk",
    "decision_actions",
    "decision_diagnosis",
    "decision_forecast",
    "decision_replay",
  ] as const) {
    assert.equal(isRealOnlyGuardedPage(page), true);
    // 七個場域一視同仁：同一頁在每個場域都一樣（真實模式可見、合成模式隱藏）
    for (const ds of [
      "sheep_barn",
      "expert_system_c22",
      "sanyegong_creek",
      "construction_site_cb13505",
      "northeast_corner",
      "rearing_plant_1",
      "rearing_plant_1_north",
    ]) {
      const tier = page === "decision_support" ? "daily" : "decision";
      assert.equal(isNavItemVisible(page, tier, "synthetic", ds), false, `${page} ${ds} synthetic`);
      assert.equal(isNavItemVisible(page, tier, "real", ds), true, `${page} ${ds} real`);
    }
  }
});

test("groupSensorsByUnit：相同單位合併成一組，不同單位拆成各自獨立的小圖清單", () => {
  const units = {
    "溫度": "°C",
    "濕度": "%",
    "CO2": "ppm",
    "溫度2": "°C",
  };
  assert.deepEqual(groupSensorsByUnit(["溫度", "溫度2"], units), [
    { unit: "°C", sensors: ["溫度", "溫度2"] },
  ]);
  assert.deepEqual(groupSensorsByUnit(["溫度", "濕度", "溫度2", "CO2"], units), [
    { unit: "°C", sensors: ["溫度", "溫度2"] },
    { unit: "%", sensors: ["濕度"] },
    { unit: "ppm", sensors: ["CO2"] },
  ]);
});

test("buildTrueTimeTrendSeries：保持真實時間刻度，並在缺口處插入 null 斷開點而不壓縮成連續", () => {
  const rows: ParsedCsvRow[] = [
    makeRow("2026-01-01 00:00:00", { temp: 20 }),
    makeRow("2026-01-01 01:00:00", { temp: 21 }),
    // 10-hour gap: 02:00 .. 11:00 missing
    makeRow("2026-01-01 12:00:00", { temp: 25 }),
    makeRow("2026-01-01 13:00:00", { temp: 26 }),
  ];

  const result = buildTrueTimeTrendSeries(rows, ["temp"], "hourly", 360);
  assert.equal(result.gaps.length, 1);
  assert.equal(result.gaps[0].missingSteps, 10);
  assert.equal(result.domain?.[0], parseLocalTimestampMs("2026-01-01 00:00:00"));
  assert.equal(result.domain?.[1], parseLocalTimestampMs("2026-01-01 13:00:00"));

  // Points should have 2 valid points, 2 null gap-break points, 2 valid points = 6 points
  assert.equal(result.points.length, 6);
  assert.equal(result.points[2].isGapBreak, true);
  assert.equal(result.points[2].temp, null);
  assert.equal(result.points[3].isGapBreak, true);
  assert.equal(result.points[3].temp, null);

  // True time spacing preserved: tsMs jumps by 11 hours between index 1 and index 4
  const gapSpanHours = (result.points[4].tsMs - result.points[1].tsMs) / 3_600_000;
  assert.equal(gapSpanHours, 11);

  assert.equal(
    formatChartTimeLabel(parseLocalTimestampMs("2026-01-01 13:00:00"), "hourly"),
    "01-01 13:00"
  );
  assert.equal(
    formatChartTimeLabel(parseLocalTimestampMs("2026-01-01"), "daily"),
    "01-01"
  );
});
