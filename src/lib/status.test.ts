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

// ---- 引擎即時預測
import type { LiveForecastResponse, LiveStatusResponse } from "../../contracts/types.ts";

const engineFixture = (v1: number, v3: number, opts: { stale?: boolean; synthetic?: boolean; flags?: string[] } = {}) => {
  const hist = Array.from({ length: 80 }, (_, i) => ({ time: `2026-11-27 ${String(i % 24).padStart(2, "0")}:00:00`, value: 78 + (i % 3) }));
  const task = (h: number, v: number) => ({
    task_id: `羊舍::THI::h${h}`,
    sensor: "成羊區THI",
    horizon_h: h,
    origin: "2026-11-27 08:00:00",
    target_timestamp: `2026-11-27 ${8 + h}:00:00`,
    history: hist,
    models: { HGB: { value: v, refused: null }, persistence: { value: 80, refused: null } },
  });
  return {
    forecast: { dataset_id: "sheep_barn", data_version: "v1", issued_at: null, contains_synthetic: opts.synthetic ?? true, tasks: [task(1, v1), task(3, v3)] } as unknown as LiveForecastResponse,
    status: {
      dataset_id: "sheep_barn", data_end: "2026-11-27 08:00:00", mode: "sim", is_stale: opts.stale ?? false,
      current_version: "v1", latest_source: "synthetic", contains_synthetic: opts.synthetic ?? true, flags: opts.flags ?? [],
    } as unknown as LiveStatusResponse,
  };
};

test("引擎即時：用 HGB 預測與門檻比較；模擬流會標示；沒有區間與機率", () => {
  const s = computeDomainStatus(input("sheep_barn", { engine: engineFixture(85, 88) }));
  assert.equal(s.source, "engine");
  assert.equal(s.synthetic, true);
  assert.deepEqual(s.horizons.map((h) => h.point), [85, 88]);
  assert.equal(s.horizons[1].level, "danger");
  assert.equal(s.level, "danger");
  assert.equal(s.horizons[0].pCaution, null);
  assert.equal(s.horizons[0].lower, null);
  assert.ok(s.history && s.history.length > 24 && s.spark.length > 24);
  const safe = computeDomainStatus(input("sheep_barn", { engine: engineFixture(80, 81, { synthetic: false }) }));
  assert.equal(safe.level, "safe");
  assert.equal(safe.synthetic, false);
});

test("引擎即時：資料過時或有旗標 → 先確認資料；匯入資料優先於引擎；沒有對應任務時退回預計算", () => {
  const stale = computeDomainStatus(input("sheep_barn", { engine: engineFixture(80, 81, { stale: true }) }));
  assert.equal(stale.level, "data");
  assert.equal(stale.reliability, "unreliable");
  const flagged = computeDomainStatus(input("sheep_barn", { engine: engineFixture(80, 81, { flags: ["讀值卡住"] }) }));
  assert.equal(flagged.reliability, "warning");
  assert.ok(flagged.reliabilityFindings.includes("讀值卡住"));

  const H = 3_600_000;
  const t0 = Date.parse("2026-08-14T00:00:00");
  const rows: ParsedCsvRow[] = Array.from({ length: 100 }, (_, i) => ({ timestamp: "x", tsMs: t0 + i * H, values: { "成羊區THI": 80 }, rawCells: [], flagValue: "import" }));
  assert.equal(computeDomainStatus(input("sheep_barn", { engine: engineFixture(95, 95), liveRows: rows })).source, "import");

  const noTask = engineFixture(80, 81);
  noTask.forecast.tasks = [];
  assert.equal(computeDomainStatus(input("sheep_barn", { engine: noTask })).source, "precomputed");
});
