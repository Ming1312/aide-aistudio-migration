import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSyntheticStepFacts } from "./facts.ts";
import type { DemoStepOutput } from "../types/app";

const base = {
  step: 1, label: "D1", version: "v1", rows_appended: 10, cards: [],
  n_data_quality: 1, n_signal: 2, n_environment_suppressed: 0,
  alerts_true: 0, alerts_false: 0,
} as unknown as DemoStepOutput;

test("不建模場域（沒有 guard／forecast）也能產生白話解釋用的事實，不會丟例外", () => {
  const facts = buildSyntheticStepFacts("育成一廠北側", base, "D1", "v1");
  const f3 = facts.find((f) => f.id === "f3");
  assert.ok(f3 && f3.text.includes("不建立預測模型"));
});

test("有 guard 的場域維持原本的守門建議文字", () => {
  const withGuard = { ...base, guard: { recommendation: "fix_data_first", raw: "", sensor_health: "ok", seconds: 0 }, retrain_allowed: false } as DemoStepOutput;
  const f3 = buildSyntheticStepFacts("羊舍", withGuard, "D1", "v1").find((f) => f.id === "f3");
  assert.ok(f3 && f3.text.includes("守門建議：fix_data_first") && f3.text.includes("允許重訓：否"));
});
