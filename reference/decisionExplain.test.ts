// 執行：node --experimental-strip-types --test reference/decisionExplain.test.ts   （Node ≥ 22.6）
// 用『真實資料的決策輔助輸出』（public/data/real_public/precomputed/decision_support.json）走完整流程；Gemini 用測試替身（不連網、不使用任何金鑰）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildDecisionPrompt, explainDecision, factsFromDecisionSupport, finalizeDecision, ruleBasedExplain } from "./decisionExplain.ts";
import type { DecisionSupportResponse } from "../contracts/types.ts";

const DS = JSON.parse(readFileSync(new URL("../public/data/real_public/precomputed/decision_support.json", import.meta.url), "utf-8")).datasets as Record<string, DecisionSupportResponse>;
const creek = DS["sanyegong_creek"], north = DS["rearing_plant_1_north"], sheep = DS["sheep_barn"];
const fake = (obj: unknown) => ({ models: { generateContent: async () => ({ text: typeof obj === "string" ? obj : JSON.stringify(obj) }) } });
const good = (r: DecisionSupportResponse) => ({ overview: ruleOv(r), items: r.recommendations.map((x) => ({ rec_id: x.id, plain_text: x.statement, cites: x.evidence_ids })), cannot_conclude: ["資料沒有提供的內容目前無法判斷。"] });
const ruleOv = (r: DecisionSupportResponse) => `${r.display_name}：共 ${r.recommendations.length} 項建議。`;
const replace = (r: DecisionSupportResponse, id: string, text: string) => { const g = good(r); g.items.find((i) => i.rec_id === id)!.plain_text = text; return g; };

test("七場域的決策輔助檔都存在，且層級分配符合登錄表（只有羊舍有 formal_risk）", () => {
  assert.equal(Object.keys(DS).length, 7);
  for (const [id, r] of Object.entries(DS)) {
    assert.equal(r.tier_summary.formal_risk, id === "sheep_barn" ? 1 : 0, id);
    assert.ok(r.recommendations.every((x) => x.evidence_ids.length > 0 && x.limitations.length > 0 && x.confidence.basis.length > 0), id);
  }
});

test("三爺宮溪：事實清單與提示詞，沒有金鑰或本機路徑", () => {
  const facts = factsFromDecisionSupport(creek);
  assert.ok(facts.some((f) => f.id.startsWith("E-AN")) && facts.some((f) => f.id.startsWith("R-")));
  const { system, user } = buildDecisionPrompt(creek);
  assert.doesNotMatch(system + user, /AIza|\/home\/|GEMINI_API_KEY/);
  assert.match(system, /不得創造警戒門檻/);
});

test("三爺宮溪（端到端）：誠實的 Gemini 改寫通過核對，層級／可信程度／限制由規則層原樣帶出", async () => {
  const r = await explainDecision(creek, fake(good(creek)), "test-model");
  assert.equal(r.guard.ok, true, JSON.stringify(r.guard));
  assert.ok(r.items.every((i) => i.plain_text_source === "gemini"));
  for (const it of r.items) { const src = creek.recommendations.find((x) => x.id === it.rec_id)!; assert.equal(it.tier, src.tier); assert.deepEqual(it.confidence, src.confidence); assert.deepEqual(it.limitations, src.limitations); }
  assert.ok(r.items.some((i) => i.tier === "needs_human_review") && r.items.every((i) => i.tier !== "formal_risk"));
  assert.ok(r.disclaimers.some((d) => d.includes("沒有登錄的正式決策引擎")));
});

test("編造警戒門檻 → 該項改回規則層原文，其他項不受影響", () => {
  const id = creek.recommendations.find((x) => x.category === "model_applicability")!.id;
  const r = finalizeDecision(replace(creek, id, "DO 低於 5 就算異常，請立刻處理。"), creek);
  const it = r.items.find((i) => i.rec_id === id)!;
  assert.equal(it.plain_text_source, "rule_based");
  assert.ok(it.fallback_reasons.some((w) => w.includes("門檻") || w.includes("數字")));
  assert.equal(it.plain_text, creek.recommendations.find((x) => x.id === id)!.statement);
  assert.ok(r.items.filter((i) => i.rec_id !== id).every((i) => i.plain_text_source === "gemini"));
  assert.equal(r.guard.ok, false);
});

test("下故障結論／自動控制 → 改回規則層原文", () => {
  const id = creek.recommendations.find((x) => x.tier === "needs_human_review")!.id;
  for (const bad of ["感測器已故障，需要更換。", "系統會自動開啟設備處理。"]) {
    const it = finalizeDecision(replace(creek, id, bad), creek).items.find((i) => i.rec_id === id)!;
    assert.equal(it.plain_text_source, "rule_based", bad);
  }
});

test("把候選事件說成正式風險決策／已確認異常 → 擋下；層級不會被模型改寫", () => {
  const id = creek.recommendations.find((x) => x.tier === "needs_human_review")!.id;
  for (const bad of ["這是正式風險決策，請依政策處理。", "已確認為異常事件。"]) {
    const r = finalizeDecision(replace(creek, id, bad), creek);
    const it = r.items.find((i) => i.rec_id === id)!;
    assert.equal(it.plain_text_source, "rule_based", bad);
    assert.equal(it.tier, "needs_human_review");
  }
});

test("育成一廠北側（資料不足）：只有資料檢查建議；模型說出預測值會被擋下", () => {
  assert.equal(north.capability.forecast.status, "not_available");
  assert.ok(north.evidence.every((e) => e.kind !== "forecast_task" && e.kind !== "formal_decision"));
  assert.ok(north.recommendations.some((x) => x.category === "model_applicability"));
  const id = north.recommendations[0].id;
  const r = finalizeDecision(replace(north, id, "溫度預測會達到 31 度。"), north);
  assert.equal(r.items.find((i) => i.rec_id === id)!.plain_text_source, "rule_based");
  assert.ok(r.disclaimers.some((d) => d.includes("目前不提供預測")));
});

test("羊舍：formal_risk 原樣引用，門檻候選值如實標示；其他場域的 formal_risk 不存在", () => {
  const fm = sheep.recommendations.find((x) => x.tier === "formal_risk")!;
  assert.ok(fm.statement.includes("candidate_unconfirmed"));
  assert.equal(sheep.capability.formal_risk.validated_policy, false);
  const r = finalizeDecision(good(sheep), sheep);
  assert.equal(r.guard.ok, true, JSON.stringify(r.guard));
  assert.ok(r.disclaimers.some((d) => d.includes("候選值")));
});

test("漏項、未知編號、重複、沒有 cites、引用不存在的事實 → 補回規則層原文／丟棄", () => {
  const g = good(creek);
  const first = g.items[0].rec_id;
  const raw = { ...g, items: [...g.items.slice(2), { rec_id: "R-999", plain_text: "憑空的建議", cites: ["E-COV-01"] }, { rec_id: first, plain_text: "x", cites: [] }] };
  const r = finalizeDecision(raw, creek);
  assert.equal(r.items.length, creek.recommendations.length);
  assert.deepEqual(r.guard.dropped_unknown_items, ["R-999"]);
  assert.equal(r.items[0].plain_text_source, "rule_based");
  assert.equal(r.items[1].plain_text_source, "rule_based");
  const raw2 = good(creek); raw2.items[0].cites = ["E-NOPE-99"];
  assert.equal(finalizeDecision(raw2, creek).items[0].plain_text_source, "rule_based");
});

test("授權、網址、過度肯定語氣 → 擋下", () => {
  const id = creek.recommendations[0].id;
  for (const bad of ["這批資料採用 CC BY 授權。", "資料已取得授權證明。", "來源見 https://example.com", "一定是探頭壞掉。"]) {
    assert.equal(finalizeDecision(replace(creek, id, bad), creek).items.find((i) => i.rec_id === id)!.plain_text_source, "rule_based", bad);
  }
});

test("Gemini 逾時／丟錯／回非 JSON → 整份退回規則層原文並明講", async () => {
  const boom = { models: { generateContent: async () => { throw new Error("timeout"); } } };
  const a = await explainDecision(creek, boom, "m");
  assert.ok(a.items.every((i) => i.plain_text_source === "rule_based") && a.disclaimers.some((d) => d.includes("不是 AI 改寫")));
  const b = await explainDecision(creek, fake("not json"), "m");
  assert.ok(b.items.every((i) => i.plain_text_source === "rule_based"));
  assert.deepEqual(ruleBasedExplain(creek).guard.fallback_items.length, creek.recommendations.length);
});

test("七場域都能走完整流程（規則層原文與誠實改寫），且規則層的文字本身通過同一套核對", async () => {
  for (const [id, r] of Object.entries(DS)) {
    const x = await explainDecision(r, fake(good(r)), "m");
    assert.equal(x.guard.ok, true, id + " " + JSON.stringify(x.guard));
    assert.equal(x.items.length, r.recommendations.length, id);
  }
});
