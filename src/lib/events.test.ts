import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { PrecomputedAnomalies, PrecomputedForecasts, RealCatalog } from "../../contracts/types.ts";
import { parseCsvText } from "./csv.ts";
import {
  activeMaskedEvent,
  applyEventMask,
  detectDatasetEvents,
  detectRowGaps,
  detectSeriesEvents,
  dropCovered,
  fromAnomaly,
  resolveEvents,
  summarize,
  toAnomalyEvents,
  type DataEvent,
} from "./events.ts";
import { computeDomainStatus, type StatusInput } from "./status.ts";
import { buildLiveTask, toHourly } from "./liveSeries.ts";
import type { ParsedCsvRow } from "../types/app.ts";

const H = 3_600_000;
const T0 = Date.parse("2026-03-01T00:00:00");
const row = (i: number, values: Record<string, number | null>): ParsedCsvRow => ({ timestamp: "", tsMs: T0 + i * H, values, rawCells: [], flagValue: "t" });
const wave = (i: number) => 20 + 3 * Math.sin(i / 4) + (i % 7) * 0.01;

test("缺值連續段：3 小時以上才算事件；整欄都沒有值不算事件", () => {
  const pts = Array.from({ length: 30 }, (_, i) => ({ t: T0 + i * H, v: i >= 10 && i <= 14 ? null : i >= 20 && i <= 21 ? null : wave(i) }));
  const ev = detectSeriesEvents("d", "s", pts);
  const miss = ev.filter((e) => e.kind === "missing");
  assert.equal(miss.length, 1);
  assert.equal(miss[0].hours, 5);
  assert.deepEqual(detectSeriesEvents("d", "s", pts.map((p) => ({ ...p, v: null }))), []);
});

test("讀值卡住：連續 12 筆相同才算；開關量（幾乎沒變化的感測器）不算", () => {
  const pts = Array.from({ length: 60 }, (_, i) => ({ t: T0 + i * H, v: i >= 20 && i < 40 ? 21.5 : wave(i) }));
  const stuck = detectSeriesEvents("d", "s", pts).filter((e) => e.kind === "stuck");
  assert.equal(stuck.length, 1);
  assert.equal(stuck[0].hours, 20);
  const onoff = Array.from({ length: 60 }, (_, i) => ({ t: T0 + i * H, v: i % 30 < 15 ? 0 : 1 }));
  assert.equal(detectSeriesEvents("d", "s", onoff).filter((e) => e.kind === "stuck").length, 0);
});

test("太陽能電流這類有「常態休止值」的感測器：夜間連續的 0 不算卡住", () => {
  const pts = Array.from({ length: 96 }, (_, i) => ({ t: T0 + i * H, v: i % 24 < 14 ? 0 : 5 + Math.sin(i) + i * 0.001 }));
  assert.equal(detectSeriesEvents("d", "s", pts).filter((e) => e.kind === "stuck").length, 0);
});

test("整列缺失（斷線）：相隔超過 3 小時的兩列之間", () => {
  const rows = [row(0, { a: 1 }), row(1, { a: 1 }), row(8, { a: 1 })];
  const gaps = detectRowGaps("d", rows);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].sensor, "*");
  assert.equal(gaps[0].hours, 6);
});

test("已被離線偵測器涵蓋的事件不重複記錄；不同感測器／時段的保留", () => {
  const pre = fromAnomaly("d", { detector: "stuck", kind: "stuck_sensor", kind_zh: "x", column: "s", start: "2026-03-01 20:00:00", end: "2026-03-02 15:00:00", detected_at: "", hours: 20, score: 20, note: "" });
  const pts = Array.from({ length: 60 }, (_, i) => ({ t: T0 + i * H, v: i >= 20 && i < 40 ? 21.5 : wave(i) }));
  const det = detectSeriesEvents("d", "s", pts);
  assert.equal(dropCovered(det, [pre]).filter((e) => e.kind === "stuck").length, 0);
  const other = detectSeriesEvents("d", "other", pts);
  assert.equal(dropCovered(other, [pre]).filter((e) => e.kind === "stuck").length, 1);
});

test("預設只排除資料故障類；標註「確認是真實事件」就保留、「確認是資料故障」就排除；人工標註優先", () => {
  const rows = Array.from({ length: 60 }, (_, i) => row(i, { s: i >= 20 && i < 40 ? 21.5 : wave(i), t: wave(i) }));
  const evs = detectDatasetEvents("d", rows, ["s", "t"]);
  const stuck = evs.find((e) => e.kind === "stuck")!;
  const r0 = resolveEvents(evs, {});
  assert.equal(r0.find((e) => e.id === stuck.id)!.mask, true);
  assert.equal(resolveEvents(evs, { [stuck.id]: { status: "real" } }).find((e) => e.id === stuck.id)!.mask, false);
  assert.equal(resolveEvents(evs, { [stuck.id]: { status: "real", mask: true } }).find((e) => e.id === stuck.id)!.mask, true);
  const spike: DataEvent = { ...stuck, id: "x|s|spike|1", kind: "spike" };
  assert.equal(resolveEvents([spike], {})[0].mask, false);
  assert.equal(resolveEvents([spike], { [spike.id]: { status: "fault" } })[0].mask, true);
});

test("排除：感測器事件只把該感測器設成缺值；整場域事件拿掉整列；統計與時數", () => {
  const rows = Array.from({ length: 50 }, (_, i) => row(i, { s: wave(i), t: wave(i) + 1 }));
  const mk = (sensor: string, a: number, b: number, kind: DataEvent["kind"] = "stuck") =>
    resolveEvents([{ id: `${sensor}${a}`, datasetId: "d", sensor, kind, start: "", end: "", startMs: T0 + a * H, endMs: T0 + b * H, hours: b - a + 1, source: "manual", note: "" }], {})[0];
  const m = applyEventMask(rows, [mk("s", 10, 14), mk("*", 30, 32, "outage_zero")]);
  assert.equal(m.droppedRows, 3);
  assert.equal(m.rows.length, 47);
  assert.equal(m.maskedCells, 5);
  assert.equal(m.rows.find((r) => r.tsMs === T0 + 12 * H)!.values.s, null);
  assert.equal(m.rows.find((r) => r.tsMs === T0 + 12 * H)!.values.t, wave(12) + 1);
  assert.equal(m.perSensor.s, 8, "整列拿掉的 3 筆也算被排除的有效讀值（門檻計算用）");
  // 原本的列沒有被改動
  assert.equal(rows[12].values.s, wave(12));
  // 沒有任何排除時原封不動
  assert.equal(applyEventMask(rows, []).rows, rows);
  const sm = summarize([mk("s", 10, 14), mk("t", 12, 20), mk("*", 30, 32, "outage_zero")]);
  assert.equal(sm.total, 3);
  assert.equal(sm.masked, 3);
  assert.equal(sm.maskedHours, 11 + 3); // 10~20 與 30~32 的聯集
});

test("簡易預測避開缺值：被排除的時段不進預測任務，最後一個起點是最後有效資料", () => {
  const rows = Array.from({ length: 120 }, (_, i) => row(i, { s: wave(i) }));
  const ev = resolveEvents([{ id: "e", datasetId: "d", sensor: "s", kind: "stuck", start: "", end: "", startMs: T0 + 100 * H, endMs: T0 + 119 * H, hours: 20, source: "manual", note: "" }], {});
  const masked = applyEventMask(rows, ev).rows;
  const full = buildLiveTask("d", "s", "u", 1, toHourly(rows, "s"))!;
  const task = buildLiveTask("d", "s", "u", 1, toHourly(masked, "s"))!;
  assert.ok(task.points[task.points.length - 1][0] < full.points[full.points.length - 1][0]);
  assert.ok(task.points.every((p) => p[4] === null || Number.isFinite(p[4] as number)));
  assert.equal(task.points[task.points.length - 1][4], wave(99));
});

test("最新資料落在排除中的事件：用最後有效資料分析，並要求先確認資料", () => {
  const catalog = JSON.parse(readFileSync("public/data/real_public/catalog_real.json", "utf-8")) as RealCatalog;
  const forecasts = JSON.parse(readFileSync("public/data/real_public/precomputed/forecasts.json", "utf-8")) as PrecomputedForecasts;
  const anomalies = JSON.parse(readFileSync("public/data/real_public/precomputed/anomalies.json", "utf-8")) as PrecomputedAnomalies;
  const id = "rearing_plant_1_north";
  const ds = catalog.datasets.find((d) => d.id === id)!;
  const rows = parseCsvText(readFileSync(`public/data/real_public/${id}.csv`, "utf-8"), "__real").rows;
  const pre = anomalies.datasets[id].events.map((e) => fromAnomaly(id, e));
  const sensor = "pH" in rows[0].values ? "pH" : Object.keys(rows[0].values).find((k) => rows.slice(-200).some((r) => typeof r.values[k] === "number"))!;
  const last = rows[rows.length - 1].tsMs;
  const manual: DataEvent = {
    id: `${id}|${sensor}|stuck|x`,
    datasetId: id,
    sensor: "*",
    kind: "maintenance",
    start: "",
    end: "",
    startMs: last - 3 * H,
    endMs: last,
    hours: 4,
    source: "manual",
    note: "維修",
  };
  const evs = resolveEvents([...pre, manual], {});
  assert.equal(activeMaskedEvent(resolveEvents([manual], {}), sensor, last)?.id, manual.id);
  assert.ok(activeMaskedEvent(evs, sensor, last), "資料尾端本來就有斷電事件");
  const masked = applyEventMask(rows, evs);
  const input: StatusInput = {
    dataset: ds,
    forecasts,
    anomalies: { ...anomalies.datasets[id], events: toAnomalyEvents(evs) },
    events: evs,
    rawLastMs: last,
    liveRows: masked.rows,
    liveIsBase: true,
    maskedRows: masked.droppedRows + masked.maskedCells,
  };
  const s = computeDomainStatus(input);
  assert.equal(s.source, "baseline");
  assert.ok(s.reliabilityFindings.some((f) => f.includes("最新資料落在")), s.reliabilityFindings.join("|"));
  assert.ok(["data", "danger"].includes(s.level));
  assert.ok(s.quality && s.quality.masked >= 1);
  // 標成「確認是真實事件」後不再拖累可信度
  const evs2 = resolveEvents([manual], { [manual.id]: { status: "real" } });
  assert.equal(activeMaskedEvent(evs2, sensor, last), null);
});

test("toAnomalyEvents：預設不變；使用者把離線偵測器的卡住改成「真實事件」就不再送進可信度判斷", () => {
  const pre = fromAnomaly("d", { detector: "stuck", kind: "stuck_sensor", kind_zh: "讀值卡住", column: "s", start: "2026-03-01 20:00:00", end: "2026-03-02 15:00:00", detected_at: "", hours: 20, score: 20, note: "" });
  assert.equal(toAnomalyEvents(resolveEvents([pre], {})).length, 1);
  assert.equal(toAnomalyEvents(resolveEvents([pre], { [pre.id]: { status: "real" } })).length, 0);
  const drift = fromAnomaly("d", { detector: "relation", kind: "drift_or_offset", kind_zh: "漂移", column: "s", start: "2026-03-01 20:00:00", end: "2026-03-02 15:00:00", detected_at: "", hours: 20, score: 2, note: "" });
  assert.equal(toAnomalyEvents(resolveEvents([drift], {})).length, 1, "預設行為不變");
  assert.equal(toAnomalyEvents(resolveEvents([drift], { [drift.id]: { status: "fault" } }))[0].kind, "maintenance_window");
});
