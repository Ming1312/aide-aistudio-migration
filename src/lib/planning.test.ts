import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDomainStats, buildLocalPlan, buildPlanFacts, rankSensors } from "./planning.ts";
import { resolveEvents, type DataEvent } from "./events.ts";

const H = 3_600_000;
const T0 = Date.parse("2026-03-01T00:00:00");
let n = 0;
const ev = (ds: string, sensor: string, kind: DataEvent["kind"], startH: number, hours: number): DataEvent => ({
  id: `${ds}|${sensor}|${kind}|${n++}`,
  datasetId: ds,
  sensor,
  kind,
  start: new Date(T0 + startH * H).toISOString().slice(0, 16).replace("T", " "),
  end: new Date(T0 + (startH + hours) * H).toISOString().slice(0, 16).replace("T", " "),
  startMs: T0 + startH * H,
  endMs: T0 + (startH + hours - 1) * H,
  hours,
  source: "detected",
  note: "",
});

test("統計：資料故障、反覆感測器、最長事件；使用者標成真實事件的不算故障", () => {
  const list = [
    ev("a", "pH", "stuck", 10, 20),
    ev("a", "pH", "stuck", 100, 15),
    ev("a", "pH", "missing", 300, 5),
    ev("a", "DO", "row_gap", 400, 30),
    ev("a", "EC", "spike", 500, 1),
  ];
  const resolved = resolveEvents(list, { [list[3].id]: { status: "real" } });
  const s = buildDomainStats("a", "場域A（測試）", resolved, null, null);
  assert.equal(s.events, 5);
  assert.equal(s.faults, 3);
  assert.equal(s.topSensors[0].sensor, "pH");
  assert.equal(s.topSensors[0].recurring, true);
  assert.equal(s.longest?.hours, 20);
  const all = rankSensors([s]);
  assert.equal(all.length, 1);
});

test("事實清單：AI 只能引用這裡的數字；規則式規劃每項都有依據，且沒有事件時不亂編", () => {
  const list = [ev("a", "pH", "stuck", 10, 20), ev("a", "pH", "stuck", 100, 15), ev("a", "pH", "stuck", 200, 12), ev("a", "*", "row_gap", 400, 48)];
  const s = buildDomainStats("a", "場域A（測試）", resolveEvents(list, {}), null, null);
  const facts = buildPlanFacts([s], rankSensors([s]));
  assert.ok(facts.length >= 3 && facts.length <= 60);
  assert.ok(new Set(facts.map((f) => f.id)).size === facts.length);
  assert.ok(facts.some((f) => f.text.includes("pH") && f.text.includes("3 次")));
  const plan = buildLocalPlan([s], rankSensors([s]));
  assert.equal(plan.source, "local");
  assert.ok(plan.items.some((i) => i.horizon === "short" && i.text.includes("pH")));
  assert.ok(plan.items.some((i) => i.horizon === "short" && i.text.includes("通訊"))); // 斷線 48 小時
  assert.ok(plan.items.some((i) => i.horizon === "long"));
  assert.ok(plan.items.filter((i) => i.horizon !== "long").every((i) => i.basis));
  const empty = buildLocalPlan([buildDomainStats("b", "場域B", [], null, null)], []);
  assert.match(empty.summary, /沒有足夠/);
  assert.ok(empty.items.every((i) => i.horizon === "long"));
});
