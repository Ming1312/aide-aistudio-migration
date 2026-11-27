import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { PrecomputedAnomalies, PrecomputedForecasts, RealCatalog } from "../../contracts/types.ts";
import { parseCsvText } from "./csv.ts";
import { answerLocal } from "./qa.ts";
import { computeDomainStatus, maskOutageRows, overallLevel, type StatusInput } from "./status.ts";
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

test("七個場域：各有 +1h／+3h 預測與迷你圖；北側沒有預計算預測，沒有資料時回報原因", () => {
  const all = catalog.datasets.map((d) => computeDomainStatus(input(d.id)));
  assert.equal(all.length, 7);
  const north = all.find((s) => s.datasetId === "rearing_plant_1_north")!;
  assert.equal(north.level, "none");
  assert.equal(north.hasModel, true);
  assert.ok(north.noModelReason);
  for (const s of all.filter((x) => x.datasetId !== "rearing_plant_1_north")) {
    assert.deepEqual(s.horizons.map((h) => h.h), [1, 3], s.datasetId);
    assert.ok(s.spark.length > 24, s.datasetId);
    assert.ok(s.asOf);
    assert.equal(s.source, "precomputed");
  }
  assert.notEqual(overallLevel(all), "none");
});

test("育成北側：資料不完整仍做分析（簡易預測）；略過斷電／歸零時段、依最後有效資料；有提醒文字", () => {
  const raw = readFileSync("public/data/real_public/rearing_plant_1_north.csv", "utf-8");
  const rows = parseCsvText(raw, "__real").rows;
  const ev = anomalies.datasets["rearing_plant_1_north"].events;
  const m = maskOutageRows(rows, ev);
  assert.ok(m.masked > 0 && m.rows.length < rows.length);
  const s = computeDomainStatus(input("rearing_plant_1_north", { liveRows: m.rows, liveIsBase: true, maskedRows: m.masked }));
  assert.equal(s.source, "baseline");
  assert.deepEqual(s.horizons.map((h) => h.h), [1, 3]);
  assert.ok(s.incomplete && s.incomplete.includes("資料不完整") && s.incomplete.includes("略過"));
  assert.ok(s.current !== null && s.current > 5, "最後有效資料不是 0");
  assert.ok(["safe", "caution", "danger"].includes(s.level));
  // 有預計算預測的場域不受 liveIsBase 影響
  const sheep = computeDomainStatus(input("sheep_barn", { liveRows: m.rows, liveIsBase: true }));
  assert.equal(sheep.source, "precomputed");
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

// ---- 歷史百分位門檻（每個感測器各一組）
import { CANDIDATE_POLICIES } from "./candidateRisk.ts";
import { DEFAULT_PCT, GRID, buildEntry, computeFromValues, defaultDirection, fromEntry, isThresholdSensor, quantile, quantileFromGrid, resolveThresholds, sensorKey, validPct, validValues, type ThresholdTable } from "./thresholds.ts";

const thrTable = JSON.parse(readFileSync("public/data/real_public/precomputed/thresholds.json", "utf-8")) as ThresholdTable;
const KEY = (id: string) => sensorKey(id, CANDIDATE_POLICIES[id].sensor);

test("quantile／computeFromValues：已知答案；越低越危險取對稱下尾；樣本不足或百分位不合法回 null", () => {
  const v = Array.from({ length: 101 }, (_, i) => i); // 0..100
  assert.equal(quantile(v, 0.9), 90);
  assert.equal(quantile(v, 0.975), 97.5);
  const up = computeFromValues(v, "above")!;
  assert.deepEqual([up.caution, up.alarm, up.direction], [90, 97.5, "above"]);
  const down = computeFromValues(v, "below")!;
  assert.deepEqual([down.caution, down.alarm], [10, 2.5]);
  assert.equal(computeFromValues(v.slice(0, 20), "above"), null);
  assert.equal(computeFromValues(v, "above", { caution: 0.99, alarm: 0.9 }), null);
  assert.equal(validPct({ caution: 0.4, alarm: 0.9 }), false);
  assert.equal(validPct(DEFAULT_PCT), true);
});

test("每個場域有多個感測器的門檻，只含連續量與衍生指數；政策感測器在其中", () => {
  let total = 0;
  for (const ds of catalog.datasets) {
    const sensors = thrTable.datasets[ds.id].sensors;
    const keys = Object.keys(sensors);
    total += keys.length;
    assert.ok(keys.length >= 5, `${ds.id} 只有 ${keys.length} 個`);
    assert.ok(keys.includes(CANDIDATE_POLICIES[ds.id].sensor), ds.id);
    for (const k of keys) {
      const col = ds.columns.find((c) => c.key === k)!;
      assert.ok(isThresholdSensor(col), `${ds.id}/${k}`);
      assert.ok(!col.is_cumulative_counter && col.measurement_kind !== "state_code");
    }
  }
  assert.ok(total >= 60, `共 ${total}`);
  assert.equal(defaultDirection("DO1 即時值", "mg/L"), "below");
  assert.equal(defaultDirection("DO1水溫", "°C"), "above");
  assert.equal(defaultDirection("電池電量", "%"), "below");
  assert.equal(defaultDirection("PM2.5", "µg/m³"), "above");
});

test("thresholds.json 沒有過期：與 CSV 重算一致；方向正確（above：警戒≥注意；below：警戒≤注意）", () => {
  for (const ds of catalog.datasets) {
    const events = anomalies.datasets[ds.id]?.events ?? [];
    const rows = parseCsvText(readFileSync(`public/data/real_public/${ds.id}.csv`, "utf-8"), "__real").rows;
    for (const [sensor, e] of Object.entries(thrTable.datasets[ds.id].sensors)) {
      const fresh = buildEntry(sensor, e.direction, validValues(rows, sensor, events));
      assert.equal(fresh.n, e.n, `${ds.id}/${sensor}`);
      for (const g of GRID) assert.ok(Math.abs(fresh.grid[String(g)] - e.grid[String(g)]) < 1e-6, `${ds.id}/${sensor} P${g}`);
      const t = fromEntry(e)!;
      assert.ok(t, `${ds.id}/${sensor}`);
      if (e.direction === "above") assert.ok(t.alarm >= t.caution, `${ds.id}/${sensor}`);
      else assert.ok(t.alarm <= t.caution, `${ds.id}/${sensor}`);
    }
  }
  assert.ok(thrTable.datasets["rearing_plant_1_north"].sensors["溫度"].excluded > 0, "北側的斷電歸零時段被略過");
});

test("格點內插與方向覆寫：P92.5 落在 P90 與 P95 之間；改成 below 取下尾", () => {
  const e = thrTable.datasets["sheep_barn"].sensors["成羊區THI"];
  const mid = quantileFromGrid(e, 0.925);
  assert.ok(mid >= e.grid["0.9"] && mid <= e.grid["0.95"]);
  assert.equal(quantileFromGrid(e, 0.999), e.grid["0.99"]);
  const up = fromEntry(e, DEFAULT_PCT, "above")!;
  const dn = fromEntry(e, DEFAULT_PCT, "below")!;
  assert.ok(dn.caution < up.caution && dn.direction === "below");
});

test("門檻優先順序：管理員調整 ＞ 歷史計算；方向可改；匯入後精確重算；沒有表時不產生歷史門檻", () => {
  const k = KEY("sheep_barn");
  const k2 = KEY("expert_system_c22");
  const r1 = resolveThresholds({ table: thrTable, pct: DEFAULT_PCT, admin: {} });
  assert.equal(r1.effective[k].source, "history");
  assert.equal(r1.effective[k].caution, r1.history[k].caution);
  assert.ok(Object.keys(r1.effective).length >= 60);
  const r2 = resolveThresholds({ table: thrTable, pct: DEFAULT_PCT, admin: { [k]: { caution: 90, alarm: 95 } } });
  assert.equal(r2.effective[k].source, "admin");
  assert.equal(r2.effective[k].caution, 90);
  assert.equal(r2.history[k].source, "history");
  assert.equal(r2.effective[k2].source, "history");
  const r3 = resolveThresholds({ table: thrTable, pct: DEFAULT_PCT, admin: {}, dirs: { [k]: "below" } });
  assert.equal(r3.effective[k].direction, "below");
  assert.ok(r3.effective[k].caution < r1.effective[k].caution);
  const vals = Array.from({ length: 100 }, (_, i) => i);
  const r4 = resolveThresholds({ table: thrTable, pct: DEFAULT_PCT, admin: {}, exact: { [k]: { values: vals, from: "a", to: "b", direction: "above" } } });
  assert.equal(r4.effective[k].caution, 89.1);
  assert.deepEqual(Object.keys(resolveThresholds({ table: null, pct: DEFAULT_PCT, admin: {} }).effective), []);
});

test("多感測器狀態：每個有預測的感測器各自判斷，場域取最嚴重者；非代表感測器的「先確認資料」不拉高場域", () => {
  const { effective } = resolveThresholds({ table: thrTable, pct: DEFAULT_PCT, admin: {} });
  const s = computeDomainStatus(input("sheep_barn", { overrides: effective }));
  assert.equal(s.thresholdSource, "history");
  assert.ok(s.thresholdNote.includes("P90"));
  assert.ok(s.sensorStatuses.length >= 3, `監看 ${s.sensorStatuses.length}`);
  assert.ok(!s.sensorStatuses.some((x) => x.sensor === "ID4-CH4"), "讀值幾乎不變（注意線＝警戒線）的感測器不納入監看");
  assert.ok(s.sensorStatuses.some((x) => x.isPolicySensor && x.sensor === "成羊區THI"));
  assert.ok(s.sensorStatuses.every((x) => x.horizons.length > 0 && x.policy));
  // 把「非代表」感測器的門檻壓到極低 → 該感測器危險，場域跟著危險，主要感測器換成它
  const other = s.sensorStatuses.find((x) => !x.isPolicySensor)!;
  const squeezed = computeDomainStatus(input("sheep_barn", { overrides: { ...effective, [sensorKey("sheep_barn", other.sensor!)]: { caution: -1e6, alarm: -1e5, direction: "above", source: "admin", note: "管理員調整" } } }));
  assert.equal(squeezed.level, "danger");
  assert.equal(squeezed.sensor, other.sensor);
  // 管理員調整的來源標示
  const a = computeDomainStatus(input("sheep_barn", { overrides: { [KEY("sheep_barn")]: { caution: 70, alarm: 75, direction: "above", source: "admin", note: "管理員調整" } } }));
  const pol = a.sensorStatuses.find((x) => x.isPolicySensor)!;
  assert.equal(pol.thresholdSource, "admin");
  assert.equal(pol.level, "danger");
  // 沒有歷史門檻時，代表感測器退回假定值
  const none = computeDomainStatus(input("sheep_barn"));
  assert.equal(none.thresholdSource, "assumed");
  assert.equal(none.sensorStatuses.length, 1);
});

import { validValuesWith } from "./thresholds.ts";

test("validValuesWith：引擎的觀測值併入原始資料（同時間以引擎為準、新時間加進來、略過歸零時段）；門檻隨之更新", () => {
  const H = 3_600_000;
  const t0 = Date.parse("2026-01-01T00:00:00");
  const rows: ParsedCsvRow[] = Array.from({ length: 100 }, (_, i) => ({ timestamp: "x", tsMs: t0 + i * H, values: { s: i }, rawCells: [], flagValue: "1" }));
  const events = [{ kind: "outage_zero_rows", start: "2026-01-01 00:00:00", end: "2026-01-01 04:00:00" }] as never;
  const extra = [
    { t: t0 + 99 * H, v: 500 }, // 取代
    { t: t0 + 100 * H, v: 600 }, // 新增
    { t: t0 + 101 * H, v: 700 }, // 新增
  ];
  const v = validValuesWith(rows, "s", events, extra);
  assert.equal(v.excluded, 5);
  assert.equal(v.added, 2);
  assert.equal(v.values.length, 100 - 5 + 2);
  assert.ok(v.values.includes(500) && !v.values.includes(99));
  const base = computeFromValues(validValuesWith(rows, "s", events, []).values, "above")!;
  const withEng = computeFromValues(v.values, "above", DEFAULT_PCT, { from: v.from, to: v.to }, "・含引擎資料 2 筆（模擬）")!;
  assert.ok(withEng.caution > base.caution, "引擎的高值把注意線拉高");
  assert.ok(withEng.note.includes("含引擎資料 2 筆"));
});
