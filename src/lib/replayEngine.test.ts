import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { PrecomputedForecasts, AnomalyEvent } from "../../contracts/types";
import { CANDIDATE_POLICIES, findTask } from "./candidateRisk.ts";
import {
  CAL_WINDOW,
  MIN_CAL,
  buildReplayRows,
  conformalQuantile,
  exceedProbability,
  pickCutoff,
  summarizeReplay,
} from "./replayEngine.ts";

const forecasts = JSON.parse(
  readFileSync(new URL("../../public/data/real_public/precomputed/forecasts.json", import.meta.url), "utf8")
) as PrecomputedForecasts;

test("conformalQuantile：有限樣本修正；樣本不足時回最大值並標示不精確", () => {
  assert.equal(conformalQuantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9).q, 10);
  const big = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.deepEqual(conformalQuantile(big, 0.9), { q: 91, exact: true });
  assert.equal(conformalQuantile([1, 2], 0.9).exact, false);
  assert.ok(Number.isNaN(conformalQuantile([], 0.9).q));
});

test("exceedProbability：方向與平滑", () => {
  const res = [-1, 0, 1, 2];
  assert.equal(exceedProbability(10, res, "above", 11), (2 + 1) / (4 + 2)); // 11、12 達到
  assert.equal(exceedProbability(10, res, "below", 9), (1 + 1) / (4 + 2));  // 只有 9 達到
  assert.equal(exceedProbability(10, [], "above", 11), null);
});

test("pickCutoff：事件不足用預設；足夠時以召回率 0.9 選線", () => {
  assert.deepEqual(pickCutoff([{ p: 0.5, event: true }]), { cutoff: 0.15, source: "default" });
  const hist = Array.from({ length: 10 }, (_, i) => ({ p: (i + 1) / 20, event: true })); // 0.05..0.5
  const c = pickCutoff(hist);
  assert.equal(c.source, "recall_target");
  // 10 個事件需抓到 9 個 → 允許漏 1 個 → 線＝第 2 小的 p＝0.10
  assert.ok(Math.abs(c.cutoff - 0.1) < 1e-9);
});

test("回放列：每個場域政策都產生 168 列；前段沒有足夠已抵達殘差就不給區間；其後有區間且 lower<point<upper", () => {
  for (const p of Object.values(CANDIDATE_POLICIES)) {
    const t = findTask(forecasts, p.datasetId, p.sensor, 3)!;
    const rows = buildReplayRows(t, p, t.best_baseline, []);
    assert.equal(rows.length, t.points.length);
    assert.equal(rows[0].interval, null);
    assert.equal(rows[0].pCaution, null);
    assert.ok(rows[0].reasons[0].includes("校正資料不足"));
    const withIv = rows.filter((r) => r.interval);
    assert.ok(withIv.length > 60, p.datasetId);
    for (const r of withIv) {
      assert.ok(r.interval!.lower <= (r.point as number) && (r.point as number) <= r.interval!.upper);
      assert.ok(r.pCaution! > 0 && r.pCaution! < 1);
      assert.ok(r.nCal >= MIN_CAL && r.nCal <= CAL_WINDOW);
    }
  }
});

test("因果性：改變某列「目標時間在起點之後」的真值，不會改變該列的任何輸出", () => {
  const p = CANDIDATE_POLICIES.construction_site_cb13505;
  const t = findTask(forecasts, p.datasetId, p.sensor, 3)!;
  const base = buildReplayRows(t, p, t.best_baseline, []);
  const k = 100;
  // 竄改所有目標時間晚於 k 起點的真值
  const t2 = JSON.parse(JSON.stringify(t)) as typeof t;
  for (let j = 0; j < t2.points.length; j++) {
    if (t2.points[j][1] > t2.points[k][0] && t2.points[j][2] !== null) t2.points[j][2] = 1e6;
  }
  const alt = buildReplayRows(t2, p, t2.best_baseline, []);
  for (const f of ["interval", "pCaution", "pAlarm", "cutoff", "alert", "riskLevel", "reasons"] as const) {
    assert.deepEqual(alt[k][f], base[k][f], f);
  }
});

test("可信度：觀測值連續相同或有候選事件會導向「先處理資料」", () => {
  const p = CANDIDATE_POLICIES.rearing_plant_1;
  const t = findTask(forecasts, p.datasetId, p.sensor, 3)!;
  const ev: AnomalyEvent = {
    detector: "stuck", kind: "stuck_sensor", kind_zh: "讀值卡住", column: p.sensor,
    start: "2026-08-20 00:00:00", end: "2026-08-31 23:00:00", detected_at: "", hours: 100, score: 1, note: "",
  };
  const rows = buildReplayRows(t, p, t.best_baseline, [ev]);
  const last = rows[rows.length - 1];
  assert.equal(last.reliability, "unreliable");
  assert.equal(last.handling, "data_first");
  assert.ok(last.reliabilityFindings.length > 0);
  const none = buildReplayRows(t, p, t.best_baseline, []);
  assert.equal(none[none.length - 1].handling, "normal");
});

test("回放摘要：混淆矩陣加總等於可用列數；與反應式並排；事件數一致", () => {
  for (const p of Object.values(CANDIDATE_POLICIES)) {
    const t = findTask(forecasts, p.datasetId, p.sensor, 3)!;
    const s = summarizeReplay(buildReplayRows(t, p, t.best_baseline, []));
    const sum = (c: { tp: number; fn: number; fp: number; tn: number }) => c.tp + c.fn + c.fp + c.tn;
    assert.equal(sum(s.model), s.n);
    assert.equal(sum(s.reactive), s.n);
    assert.equal(s.model.tp + s.model.fn, s.reactive.tp + s.reactive.fn);
    assert.ok(s.n > 50);
  }
});
