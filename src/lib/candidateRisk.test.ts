import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AnomalyEvent, PrecomputedForecasts } from "../../contracts/types";
import {
  CANDIDATE_POLICIES,
  NO_RISK_REASONS,
  applyOverride,
  assessAt,
  backtest,
  classify,
  dataHealth,
  decide,
  findTask,
  latestIndex,
} from "./candidateRisk.ts";
import {
  chartRows,
  importSteps,
  revealedTruths,
  runningMae,
  startCursor,
} from "./demoImport.ts";

const forecasts = JSON.parse(
  readFileSync(new URL("../../public/data/real_public/precomputed/forecasts.json", import.meta.url), "utf8")
) as PrecomputedForecasts;

test("六個場域各有一組假定門檻；羊舍與育成北側沒有，且有說明原因", () => {
  const ids = Object.keys(CANDIDATE_POLICIES).sort();
  assert.deepEqual(ids, [
    "construction_site_cb13505",
    "expert_system_c22",
    "northeast_corner",
    "rearing_plant_1",
    "sanyegong_creek",
  ]);
  assert.ok(NO_RISK_REASONS.sheep_barn.includes("正式決策引擎"));
  assert.ok(NO_RISK_REASONS.rearing_plant_1_north.includes("不建立預測模型"));
});

test("每個政策的感測器與三個時距都找得到預先算好的任務，門檻方向一致", () => {
  for (const p of Object.values(CANDIDATE_POLICIES)) {
    for (const h of [1, 3, 6]) {
      const t = findTask(forecasts, p.datasetId, p.sensor, h);
      assert.ok(t, `${p.datasetId} ${p.sensor} h${h}`);
      assert.ok(t.points.length > 100);
    }
    if (p.direction === "above") assert.ok(p.alarm >= p.caution);
    else assert.ok(p.alarm <= p.caution);
  }
});

test("classify：above 與 below 兩個方向", () => {
  const above = CANDIDATE_POLICIES.construction_site_cb13505;
  assert.equal(classify(60, above), "normal");
  assert.equal(classify(65, above), "caution");
  assert.equal(classify(75, above), "alarm");
  const below = CANDIDATE_POLICIES.expert_system_c22;
  assert.equal(classify(4.5, below), "normal");
  assert.equal(classify(4.0, below), "caution");
  assert.equal(classify(3.5, below), "alarm");
  assert.equal(classify(Number.NaN, below), "normal");
});

test("applyOverride 會修正反向的門檻", () => {
  const above = applyOverride(CANDIDATE_POLICIES.rearing_plant_1, 32, 30);
  assert.equal(above.alarm, 32);
  const below = applyOverride(CANDIDATE_POLICIES.expert_system_c22, 3, 4);
  assert.equal(below.alarm, 3);
});

test("歷史回放：混淆矩陣加總＝有真值的起點數，且只用真值已抵達的點；與反應式規則並排", () => {
  for (const p of Object.values(CANDIDATE_POLICIES)) {
    const t = findTask(forecasts, p.datasetId, p.sensor, 3)!;
    const bt = backtest(t, p, t.best_baseline);
    const sum = (c: { tp: number; fn: number; fp: number; tn: number }) => c.tp + c.fn + c.fp + c.tn;
    assert.equal(sum(bt.model), bt.n);
    assert.equal(sum(bt.reactive), bt.n);
    assert.equal(bt.events, bt.model.tp + bt.model.fn);
    assert.ok(bt.n > 100);
    for (const r of bt.rows) assert.ok(Number.isFinite(r.actual));
  }
});

test("每個政策在回放視窗內至少有一次候選事件（示範不是全程平靜）", () => {
  for (const p of Object.values(CANDIDATE_POLICIES)) {
    const t = findTask(forecasts, p.datasetId, p.sensor, 3)!;
    const bt = backtest(t, p, t.best_baseline);
    assert.ok(bt.events > 0, `${p.datasetId} 沒有事件`);
  }
});

test("最新評估：最後一個起點沒有真值，風險等級取觀測與預測較高者；資料可疑時導向先處理資料", () => {
  const p = CANDIDATE_POLICIES.rearing_plant_1;
  const t = findTask(forecasts, p.datasetId, p.sensor, 3)!;
  const idx = latestIndex(t);
  assert.equal(t.points[idx][2], null);
  const a = assessAt(t, idx, p, t.best_baseline)!;
  assert.ok(a.forecast !== null);
  const ok = decide(p, a, { status: "ok", reasons: [] });
  assert.ok(ok.actions.length > 0);
  assert.equal(ok.dataSuspect, false);
  const bad = decide(p, a, { status: "suspect", reasons: ["卡值"] });
  assert.equal(bad.dataSuspect, true);
  assert.ok(bad.headline.includes("先處理資料"));
  // 所有行動只有檢查／確認／通知，沒有設備控制用語
  for (const pol of Object.values(CANDIDATE_POLICIES)) {
    const all = [...pol.actions.caution, ...pol.actions.alarm, ...pol.actions.dataSuspect].join("／");
    assert.ok(!/自動(啟動|關閉|控制|調整)|遠端(控制|啟動)|開啟風扇|關閉風扇/.test(all), pol.datasetId);
  }
});

test("資料可信度：最近 24 小時的卡值／漂移事件會標為 suspect，短事件只標 note", () => {
  const ev = (kind: string): AnomalyEvent => ({
    detector: "stuck", kind, kind_zh: kind, column: "TEMP", start: "2026-08-24 01:00:00",
    end: "2026-08-24 11:00:00", detected_at: "2026-08-24 11:00:00", hours: 10, score: 1, note: "",
  });
  assert.equal(dataHealth(null, [ev("stuck_sensor")], "TEMP", "2026-08-24 12:00:00").status, "suspect");
  assert.equal(dataHealth(null, [ev("short_event_or_step")], "TEMP", "2026-08-24 12:00:00").status, "note");
  assert.equal(dataHealth(null, [ev("stuck_sensor")], "TEMP", "2026-09-30 12:00:00").status, "ok");
  assert.equal(dataHealth(null, [{ ...ev("stuck_sensor"), column: "RH" }], "TEMP", "2026-08-24 12:00:00").status, "ok");
});

test("展示匯入：游標只往後、不超過最大值；版本號遞增；看不到游標以後的觀測", () => {
  const p = CANDIDATE_POLICIES.construction_site_cb13505;
  const t = findTask(forecasts, p.datasetId, p.sensor, 3)!;
  let c = startCursor(t);
  assert.equal(c, 71);
  const r1 = importSteps(t, c, 1, 1);
  assert.equal(r1.cursor, 72);
  assert.equal(r1.entry!.version, "demo-v0001");
  assert.equal(r1.entry!.rowsAdded, 1);
  c = r1.cursor;
  const rows = chartRows(t, c, t.best_baseline);
  const lastObs = rows.filter((r) => r.observed !== undefined).pop()!;
  assert.equal(lastObs.time, t.points[c][0]);
  assert.ok(rows.every((r) => r.observed === undefined || r.time <= t.points[c][0]));
  const end = importSteps(t, t.points.length - 1, 5, 9);
  assert.equal(end.cursor, t.points.length - 1);
  assert.equal(end.entry, null);
});

test("展示匯入的因果性：已揭露的真值，其目標時間不晚於游標起點；誤差只用已揭露真值", () => {
  const p = CANDIDATE_POLICIES.northeast_corner;
  const t = findTask(forecasts, p.datasetId, p.sensor, 6)!;
  const c = 100;
  const now = t.points[c][0];
  for (const r of revealedTruths(t, c, 20)) {
    assert.ok(r.target <= now);
    assert.ok(Number.isFinite(r.actual));
  }
  const m = runningMae(t, c);
  assert.ok(m.n > 0 && m.n <= c + 1);
  const m2 = runningMae(t, c + 10);
  assert.ok(m2.n >= m.n);
});
