// AI 問答／分析：先問伺服器（有設定 Gemini 時回 Gemini 的結果；沒有時伺服器回規則式備援，這裡改用本機規則式）。
import type { Fact } from "../../contracts/types";
import { requestGeneralExplain } from "./dataLoader";

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
