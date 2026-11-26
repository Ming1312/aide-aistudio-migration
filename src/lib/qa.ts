// 問答與 AI 分析用的事實清單，以及沒有 Gemini 時的本機規則式回答（只引用已計算的數字）。
import type { Fact } from "../../contracts/types";
import { SAFETY_RANK, SAFETY_TEXT, fmtVal, overallLevel, type DomainStatus } from "./status";

export function statusLine(s: DomainStatus): string {
  if (!s.hasModel || !s.policy) return `${s.name}：${s.noModelReason ?? "無風險模型"}`;
  const hs = s.horizons
    .map((h) => `${h.h} 小時後預測 ${fmtVal(h.point)} ${s.unit}（${SAFETY_TEXT[h.level]}${h.pCaution !== null ? `，越過注意線機率 ${Math.round(h.pCaution * 100)}%` : ""}）`)
    .join("；");
  return `${s.name}：${s.policy.sensor} 目前 ${fmtVal(s.current)} ${s.unit}；${hs}；整體${SAFETY_TEXT[s.level]}（注意線 ${s.policy.caution}、警戒線 ${s.policy.alarm}，假定門檻）`;
}

/** 一行精簡版（問答清單用） */
export function shortLine(s: DomainStatus): string {
  if (!s.hasModel || !s.policy) return `${s.name.split("（")[0]}：無模型`;
  const hs = s.horizons.map((h) => `+${h.h}h ${fmtVal(h.point)}`).join("、");
  return `${s.name.split("（")[0]}（${SAFETY_TEXT[s.level]}）：現在 ${fmtVal(s.current)}、${hs} ${s.unit}`;
}

export function buildFacts(list: DomainStatus[]): Fact[] {
  return list.slice(0, 40).map((s, i) => ({ id: `s${i + 1}`, text: statusLine(s) }));
}

export function buildDomainFacts(s: DomainStatus): Fact[] {
  const facts: Fact[] = [{ id: "d1", text: statusLine(s) }];
  if (s.incomplete) facts.push({ id: "d0", text: s.incomplete });
  if (s.asOf) facts.push({ id: "d2", text: `資料截至 ${s.asOf}（資料來源：${s.source === "import" ? "匯入資料＋簡易基準預測" : "預計算研究預測"}）` });
  facts.push({
    id: "d3",
    text: s.reliability === "reliable" ? "感測器可信度：正常" : `感測器可信度：${s.reliability}（${s.reliabilityFindings.join("；") || "有疑慮"}）`,
  });
  facts.push({ id: "d4", text: `近 24 小時偵測器候選事件 ${s.recentEvents} 筆`, value: s.recentEvents, unit: "筆" });
  return facts;
}

export interface LocalAnswer {
  text: string;
  focusId: string | null;
}

export function answerLocal(question: string, list: DomainStatus[]): LocalAnswer {
  const q = question.trim();
  const withModel = list.filter((s) => s.hasModel);
  const named = list.find((s) => q.includes(s.name.split("（")[0]) || q.includes(s.datasetId));
  const risky = withModel
    .filter((s) => s.level !== "safe")
    .sort((a, b) => SAFETY_RANK[b.level] - SAFETY_RANK[a.level]);

  if (named) {
    if (/資料|可信|感測/.test(q) && named.hasModel) {
      return {
        text:
          named.reliability === "reliable"
            ? `${named.name}：感測器可信度正常。`
            : `${named.name}：感測器可信度「${named.reliability}」— ${named.reliabilityFindings.join("；") || "請先確認資料"}`,
        focusId: named.datasetId,
      };
    }
    return { text: statusLine(named), focusId: named.datasetId };
  }
  if (/建議|怎麼辦|處置|該做/.test(q)) {
    const w = risky[0];
    if (!w || !w.policy) return { text: "目前沒有需要處置的場域。", focusId: null };
    const acts = w.level === "danger" ? w.policy.actions.alarm : w.level === "data" ? w.policy.actions.dataSuspect : w.policy.actions.caution;
    return { text: `${w.name}（${SAFETY_TEXT[w.level]}）建議：${acts.join("；")}`, focusId: w.datasetId };
  }
  if (/資料|可信/.test(q)) {
    const bad = withModel.filter((s) => s.reliability !== "reliable");
    return {
      text: bad.length === 0 ? "所有場域的感測器可信度正常。" : bad.map((s) => `${s.name}：${s.reliability}`).join("；"),
      focusId: bad[0]?.datasetId ?? null,
    };
  }
  if (risky.length === 0) {
    return {
      text: `未來 1–3 小時各場域預測都未超過假定門檻（${withModel.length} 個有模型的場域）。這不代表設備或環境正常。`,
      focusId: null,
    };
  }
  const top = risky.slice(0, 4).map(shortLine).join("\n");
  return {
    text: `${risky.length} 個場域需要注意：\n${top}`,
    focusId: risky[0].datasetId,
  };
}

/** 決策頁的本機分析（沒有 Gemini 時）：三句以內。 */
export function analyzeLocal(s: DomainStatus): string[] {
  if (!s.hasModel || !s.policy) return [s.noModelReason ?? "無風險模型"];
  const out: string[] = [];
  out.push(`${s.policy.sensor} 目前 ${fmtVal(s.current)} ${s.unit}，${SAFETY_TEXT[s.currentLevel]}。`);
  for (const h of s.horizons) {
    const range = h.lower !== null && h.upper !== null ? `（90% 區間 ${fmtVal(h.lower)}～${fmtVal(h.upper)}）` : "";
    out.push(`${h.h} 小時後預測 ${fmtVal(h.point)} ${s.unit}${range}，${SAFETY_TEXT[h.level]}。`);
  }
  if (s.reliability !== "reliable") out.push(`感測器可信度「${s.reliability}」：${s.reliabilityFindings.join("；")}`);
  if (s.recentEvents > 0) out.push(`近 24 小時有 ${s.recentEvents} 筆候選事件。`);
  return out;
}
