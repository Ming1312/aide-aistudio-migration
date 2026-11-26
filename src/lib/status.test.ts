import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { PrecomputedAnomalies, PrecomputedForecasts, RealCatalog } from "../../contracts/types.ts";
import { answerLocal } from "./qa.ts";
import { computeDomainStatus, overallLevel, type StatusInput } from "./status.ts";
import type { ParsedCsvRow } from "../types/app.ts";

const read = <T,>(f: string): T => JSON.parse(readFileSync(`public/data/real_public/${f}`, "utf-8")) as T;
const catalog = read<RealCatalog>("catalog_real.json");
const forecasts = read<PrecomputedForecasts>("precomputed/forecasts.json");
const anomalies = read<PrecomputedAnomalies>("precomputed/anomalies.json");

const input = (id: string, extra: Partial<StatusInput> = {}): StatusInput => ({
  dataset: catalog.datasets.find((d) => d.id === id)!,
  forecasts,
  anomalies: anomalies.datasets[id],
  ...extra,
});

test("七個場域：北側無模型；其餘各有 +1h／+3h 預測與迷你圖", () => {
  const all = catalog.datasets.map((d) => computeDomainStatus(input(d.id)));
  assert.equal(all.length, 7);
  const north = all.find((s) => s.datasetId === "rearing_plant_1_north")!;
  assert.equal(north.level, "none");
  assert.equal(north.hasModel, false);
  for (const s of all.filter((x) => x.hasModel)) {
    assert.deepEqual(s.horizons.map((h) => h.h), [1, 3], s.datasetId);
    assert.ok(s.spark.length > 24, s.datasetId);
    assert.ok(s.asOf);
  }
  assert.notEqual(overallLevel(all), "none");
});

test("門檻覆寫會改變等級（把羊舍門檻調到遠高於資料 → 安全）", () => {
  const base = computeDomainStatus(input("sheep_barn"));
  const raised = computeDomainStatus(input("sheep_barn", { overrides: { sheep_barn: { caution: 200, alarm: 300 } } }));
  // 感測器可信度另算：可能是「先確認資料」，但風險本身（現在與各時距）必為安全
  assert.equal(raised.currentLevel, "safe");
  assert.ok(raised.horizons.every((h) => h.level === "safe"));
  assert.ok(raised.level === "safe" || raised.level === "data");
  assert.ok(raised.policy!.caution === 200 && base.policy!.caution === 84);
});

test("匯入資料：有 ≥72 小時歷史時改用匯入資料（source=import），等級跟著最新值", () => {
  const H = 3_600_000;
  const t0 = Date.parse("2026-08-14T00:00:00");
  const rows: ParsedCsvRow[] = [];
  for (let i = 0; i < 100; i++) {
    const v = i < 94 ? 80 : 90; // 最後 6 小時升到 90（遠高於警戒線 86）
    rows.push({ timestamp: "x", tsMs: t0 + i * H, values: { "成羊區THI": v }, rawCells: [], flagValue: "import" });
  }
  const s = computeDomainStatus(input("sheep_barn", { liveRows: rows }));
  assert.equal(s.source, "import");
  assert.equal(s.level, "danger");
  assert.equal(s.current, 90);
  const few = computeDomainStatus(input("sheep_barn", { liveRows: rows.slice(0, 10) }));
  assert.equal(few.source, "precomputed");
});

test("本機問答：指名場域回該場域；全部安全時回安全；不會丟例外", () => {
  const all = catalog.datasets.map((d) => computeDomainStatus(input(d.id)));
  assert.match(answerLocal("羊舍現在怎麼樣", all).text, /羊舍/);
  assert.equal(answerLocal("羊舍現在怎麼樣", all).focusId, "sheep_barn");
  assert.ok(answerLocal("哪個場域最危險？", all).text.length > 0);
  assert.ok(answerLocal("", []).text.length > 0);
  const safe = catalog.datasets.map((d) =>
    computeDomainStatus(input(d.id, { overrides: Object.fromEntries(catalog.datasets.map((x) => [x.id, { caution: 1e6, alarm: 2e6 }])) }))
  );
  assert.ok(answerLocal("未來 3 小時需要注意什麼？", safe).text.length > 0);
});
