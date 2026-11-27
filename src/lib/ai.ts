// AI 問答／分析：先問伺服器（有設定 Gemini 時回 Gemini 的結果；沒有時伺服器回規則式備援，這裡改用本機規則式）。
import type { Fact } from "../../contracts/types";
import { requestGeneralExplain } from "./dataLoader";
import type { Plan, PlanItem, Horizon } from "./planning";

export interface AiResult {
  lines: string[];
  source: "gemini" | "local";
}

export async function askAi(datasetId: string, facts: Fact[], question: string, kind: "forecast" | "data" = "forecast"): Promise<AiResult | null> {
  try {
    const res = (await requestGeneralExplain({ kind, data_kind: "real", dataset_id: datasetId, facts, question })) as unknown as {
      summary?: string;
      observations?: Array<{ text: string }>;
      suggested_checks?: string[];
      fallback_category?: string;
    };
    if (res.fallback_category || !res.summary) return null;
    const lines = [res.summary, ...(res.observations ?? []).slice(0, 3).map((o) => o.text)];
    return { lines, source: "gemini" };
  } catch {
    return null;
  }
}

const HORIZON_PREFIX: Array<[RegExp, Horizon]> = [
  [/^\s*[【\[]\s*短期\s*[】\]]\s*/, "short"],
  [/^\s*[【\[]\s*中期\s*[】\]]\s*/, "mid"],
  [/^\s*[【\[]\s*長期\s*[】\]]\s*/, "long"],
];

/** 長期規劃：管理員才呼叫得動（伺服器端檢查）；沒有 Gemini 或失敗時回 null，由呼叫端改用規則式規劃。 */
export async function askPlan(datasetId: string, facts: Fact[], question?: string): Promise<Plan | null> {
  try {
    const res = (await requestGeneralExplain({ kind: "plan", data_kind: "real", dataset_id: datasetId, facts, question })) as unknown as {
      summary?: string;
      observations?: Array<{ text: string }>;
      possible_causes?: Array<{ text: string }>;
      suggested_checks?: string[];
      cannot_conclude?: string[];
      fallback_category?: string;
      guard?: { ok?: boolean };
    };
    if (res.fallback_category || !res.summary) return null;
    const items: PlanItem[] = (res.suggested_checks ?? []).map((t, i) => {
      let horizon: Horizon = "mid";
      let text = t;
      for (const [re, h] of HORIZON_PREFIX) {
        if (re.test(t)) {
          horizon = h;
          text = t.replace(re, "");
          break;
        }
      }
      return { id: `ai-${i + 1}`, horizon, text };
    });
    if (items.length === 0) return null;
    return {
      summary: res.summary,
      findings: (res.observations ?? []).map((o) => o.text),
      causes: (res.possible_causes ?? []).map((o) => o.text),
      items,
      limits: res.cannot_conclude ?? [],
      source: "gemini",
      grounded: res.guard?.ok !== false,
    };
  } catch {
    return null;
  }
}
