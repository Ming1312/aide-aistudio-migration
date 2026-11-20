// 執行：node --experimental-strip-types --test reference/geminiExplain.test.ts   （Node ≥ 22.6）
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPrompt, explain, factsFromAnomalies, factsFromForecast, finalize, mandatoryDisclaimers, verifyGrounding } from "./geminiExplain.ts";
import type { AnomaliesResponse, ExplainRequest, ForecastResponse } from "../contracts/types.ts";

const fc = {
  data_kind: "synthetic", mode: "歷史時點模擬預測", dataset_id: "sheep_barn", task_id: "t", sensor: "成羊區THI", horizon_h: 3, unit: "指數", unit_status: "UNVERIFIED_INFERRED_HIGH",
  forecast_origin: "2026-08-10 12:00:00", target_timestamp: "2026-08-10 15:00:00", last_observation_time: "2026-08-10 12:00:00", last_observation_value: 81.4, actual_at_target: null,
  period: "holdout", period_zh: "留存測試期", best_baseline: "seasonal_naive_24h", research_status: "Research Candidate｜Validation Pending", artifact_sha256: "x", limits: [], no_claim: "不宣稱任何準確度",
  history: [], future_actual: [], origin_range: ["a", "b"],
  models: {
    persistence: { label: "持續性", kind: "baseline", value: 81.4, refused: null, validation: null, holdout: { n: 169, MAE: 1.4787, RMSE: 1.9 } },
    moving_average: { label: "移動平均", kind: "baseline", value: 80.1, refused: null, validation: null, holdout: null },
    seasonal_naive_24h: { label: "24 小時季節性", kind: "baseline", value: null, refused: "季節性基準未通過有效性檢查", validation: null, holdout: null },
    linear_ar4: { label: "線性自迴歸", kind: "baseline", value: 80.9, refused: null, validation: null, holdout: null },
    HGB: { label: "HGB", kind: "ml", value: 82.35, refused: null, validation: null, holdout: { n: 169, MAE: 0.9969, RMSE: 1.39 }, interval: { shown: true, reason: "", lower: 80.1, upper: 84.6 }, evidence: "目前尚無足夠證據證明此模型優於簡單基準。" },
    XGB: { label: "XGBoost", kind: "ml", value: 82.0, refused: null, validation: null, holdout: null },
  },
} as unknown as ForecastResponse;
const req = (over: Partial<ExplainRequest> = {}): ExplainRequest => ({ kind: "forecast", data_kind: "synthetic", dataset_id: "sheep_barn", facts: factsFromForecast(fc), ...over });

test("事實清單：保留拒絕原因，不補上其他模型", () => {
  const t = factsFromForecast(fc).map((x) => x.text).join("\n");
  assert.match(t, /拒絕預測：季節性基準未通過有效性檢查/);
  assert.match(t, /HGB 預測 82\.35/);
});

test("提示詞：含 data_kind、事實 id，沒有金鑰或本機路徑", () => {
  const { system, user } = buildPrompt(req());
  assert.match(user, /data_kind: synthetic/);
  assert.match(user, /\[f1\]/);
  assert.match(system, /不得宣稱準確度|不得宣稱準確度或可靠度/);
  assert.doesNotMatch(system + user, /AIza|\/home\//);
});

test("核對：事實裡的數字通過；憑空的數字被抓到", () => {
  const facts = factsFromForecast(fc);
  const ok = verifyGrounding({ summary: "HGB 預測 82.35，最後觀測 81.4。", observations: [{ text: "留存期 MAE 約 1.48", cites: ["f1"] }], possible_causes: [], cannot_conclude: [], suggested_checks: [] }, facts);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const bad = verifyGrounding({ summary: "預測會達到 91.7。", observations: [{ text: "x", cites: ["f999"] }, { text: "沒依據", cites: [] }], possible_causes: [], cannot_conclude: [], suggested_checks: [] }, facts);
  assert.deepEqual(bad.ungrounded_numbers, ["91.7"]);
  assert.deepEqual(bad.unknown_cites, ["f999"]);
  assert.equal(bad.uncited_claims, 1);
  assert.equal(bad.ok, false);
});

test("finalize：強制附加合成與探索性聲明；過度肯定語氣與未核對數字會被標記", () => {
  const raw = { summary: "一定是感測器壞了，溫度會到 99。", observations: [], possible_causes: [], cannot_conclude: [], suggested_checks: ["自動開啟風扇"] };
  const r = finalize(JSON.stringify(raw), req());
  assert.equal(r.guard.ok, false);
  assert.ok(r.guard.ungrounded_numbers.includes("99"));
  assert.ok(r.disclaimers.some((d) => d.includes("合成")));
  assert.ok(r.disclaimers.some((d) => d.includes("探索性")));
  assert.ok(r.disclaimers.some((d) => d.includes("過度肯定")));
});

test("真實資料不會附上『合成』聲明，而是附上如實的來源與授權聲明", () => {
  const d = mandatoryDisclaimers("data", "real");
  assert.ok(!d.some((x) => x.includes("合成")));
  assert.ok(d.some((x) => x.includes("銘祥科技") && x.includes("無公開下載網址") && x.includes("沒有標準開放授權")));
});

test("授權與網址：說了 CC BY／已取得授權證明／網址 → 被標記", () => {
  for (const bad of ["這批資料採用 CC BY 4.0 授權。", "資料已取得授權證明。", "來源見 https://example.com/data"]) {
    const r = finalize(JSON.stringify({ summary: bad, observations: [], possible_causes: [], cannot_conclude: [], suggested_checks: [] }), req({ data_kind: "real" }));
    assert.equal(r.guard.ok, false, bad);
    assert.ok(r.disclaimers.some((x) => x.includes("授權")));
  }
  const ok = finalize(JSON.stringify({ summary: "資料由競賽方提供，使用者已確認可用於本競賽專題。", observations: [], possible_causes: [], cannot_conclude: [], suggested_checks: [] }), req({ data_kind: "real" }));
  assert.equal(ok.guard.ok, true);
});

test("異常事件事實：標示為候選，不是故障判定", () => {
  const a = { dataset_id: "x", data_kind: "synthetic", n_events: 1, disclaimer: "候選事件，不是故障判定", limits: [], events: [{ detector: "relation", kind: "drift_or_offset", kind_zh: "漂移或偏移", column: "ID4-濕度", start: "a", end: "b", detected_at: "b", hours: 48, score: 7.5, note: "n" }] } as AnomaliesResponse;
  const t = factsFromAnomalies(a).map((x) => x.text).join("\n");
  assert.match(t, /候選異常事件/);
  assert.match(t, /漂移或偏移/);
});

test("explain：用假的 Gemini 回應走完整流程（不連網）", async () => {
  const ai = { models: { generateContent: async () => ({ text: JSON.stringify({ summary: "HGB 預測 82.35。", observations: [{ text: "持續性預測 81.4", cites: ["f3"] }], possible_causes: [], cannot_conclude: ["資料本身無法證實原因"], suggested_checks: ["到現場比對感測器"] }) }) } };
  const r = await explain(req(), ai, "test-model");
  assert.equal(r.guard.ok, true, JSON.stringify(r.guard));
  await assert.rejects(() => explain(req({ facts: [] }), ai, "m"));
});
