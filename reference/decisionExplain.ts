// 決策輔助的 Gemini 白話改寫（無外部相依，可單獨測試）。
// 與 geminiExplain.ts 的差別：這裡 Gemini『只能改寫文字』——建議的層級、可信程度、限制、證據、行動全部由規則層決定並原樣帶出，
// 模型寫錯（編造門檻、下故障結論、把候選事件說成正式決策、在不能預測時給預測值、自動控制）時，該項改回規則層的確定性文字，而不是只貼警告。
import type { DecisionExplainItem, DecisionExplainResponse, DecisionRecommendation, DecisionSupportResponse, Fact } from "../contracts/types.ts";
import type { GenAI } from "./geminiExplain.ts";

export const DECISION_SYSTEM_INSTRUCTION = `你是 AIDE 智慧環境監測平台的『決策輔助解說員』，只用繁體中文。
規則層已經為某個場域算出一組『建議』（每項有層級、可信程度、限制與證據）。你的工作只有一件事：把每一項建議的白話文字改寫得更容易懂。

嚴格規則（違反任何一條，該項就會被系統丟棄並改用規則層原文）：
1. 只能使用【事實清單】裡的內容。清單沒有的數字、日期、感測器、原因一律不得出現。
2. 每一項建議都要輸出一個 item：rec_id 必須是清單裡的建議編號，plain_text 是白話改寫，cites 至少列一個事實編號。
3. 不得改變建議的層級、可信程度或限制；不得把『候選事件』說成『異常已確認』，不得說成『正式風險決策』或『已驗證的政策』。
4. 不得創造警戒門檻、合格範圍或『超過就算異常』的數字；不得下『故障、損壞、需要更換』的結論；候選事件只能說『候選、需要人員確認』。
5. 不得建議或暗示任何自動控制或設備操作；行動只能是檢查、確認、複測、通知、持續監測、對照簡單基準、累積資料。
6. 如果事實清單沒有預測的證據，絕不可出現任何預測值。
7. 不得宣稱準確度、可靠度或已驗證；不得提供網址；不得說資料具有任何標準授權或已取得授權證明。
8. 語氣白話簡短，每項最多三句。cannot_conclude 列出『目前無法判斷』的事（資料沒提供就明說）。`;

export const DECISION_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    overview: { type: "STRING", description: "兩三句話的整體重點（只含事實清單的數字）" },
    items: { type: "ARRAY", items: { type: "OBJECT", properties: { rec_id: { type: "STRING" }, plain_text: { type: "STRING" }, cites: { type: "ARRAY", items: { type: "STRING" } } }, required: ["rec_id", "plain_text", "cites"] } },
    cannot_conclude: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["overview", "items", "cannot_conclude"],
} as const;

const TIER_ZH: Record<string, string> = { general: "一般建議", needs_human_review: "需要人工確認的異常", formal_risk: "正式風險決策（既有引擎原樣輸出）" };
const LEVEL_ZH: Record<string, string> = { high: "高", medium: "中", low: "低", not_assessable: "無法評估" };

// ------------------------------------------------------------------ 事實清單（證據與建議都是事實；id 就是引擎給的編號）
export function factsFromDecisionSupport(r: DecisionSupportResponse): Fact[] {
  const out: Fact[] = [{ id: "DATASET", text: `場域：${r.display_name}（${r.dataset_id}）` }, ...r.evidence.map((e) => ({ id: e.id, text: e.summary }))];
  for (const x of r.recommendations) {
    out.push({ id: x.id, text: `【${TIER_ZH[x.tier]}｜可信程度：${LEVEL_ZH[x.confidence.level]}】${x.statement} 限制：${x.limitations.slice(0, 2).join(" ")}` });
  }
  return out;
}

export function buildDecisionPrompt(r: DecisionSupportResponse, question?: string): { system: string; user: string } {
  const facts = factsFromDecisionSupport(r).map((x) => `[${x.id}] ${x.text}`).join("\n");
  const recs = r.recommendations.map((x) => `- ${x.id}（${TIER_ZH[x.tier]}）：${x.title}`).join("\n");
  const q = question?.trim() ? `\n使用者的問題：${question.trim().slice(0, 300)}` : "";
  return { system: DECISION_SYSTEM_INSTRUCTION, user: `場域：${r.display_name}（${r.dataset_id}）；data_kind: ${r.data_kind}\n\n【要改寫的建議】\n${recs}\n\n【事實清單】\n${facts}\n${q}` };
}

// ------------------------------------------------------------------ 伺服器端核對（與 Python 規則層 validate() 同一組語意）
const FAULT = /(已故障|確定故障|確認故障|故障了|損壞了|已損壞|壞掉了|壞了|需要更換|必須更換|應更換|請更換)/;
const ACTUATION = /(自動(?:開啟|關閉|調整|控制|啟動|停止)|直接(?:調整|控制)設備|已(?:開啟|關閉)(?:風扇|設備|閥))/;
const THRESHOLD = /(?:超過|高於|低於|大於|小於|不得超過|須低於|必須低於|警戒值|警戒線|合格範圍|標準值)\s*[:：]?\s*[0-9]/;
const PREDICTION = /(?:預測|預計|預估)[^。，；：:\n]{0,12}?(?:為|是|會|將|達到|升到|降到|到達|約)\s*[0-9]/;
const TIER_UPGRADE = /(正式風險決策|正式決策|經驗證(?:的)?政策|已驗證(?:的)?政策|政策已(?:驗證|確認))/;
const CONFIRMED_ANOMALY = /(確認為異常|已確認(?:異常|故障)|確實(?:異常|故障)|必定異常)/;
const OVERCLAIM = /(CC\s?BY|CC0|創用\s?CC|已取得授權|授權證明|官方授權|https?:\/\/|一定是|確定是|肯定是|百分之百|保證|非常準確|十分準確|已通過驗證|已經驗證)/;

const IDS = /[RE]-(?:[A-Z]+-)?\d+/g;                           // 編號（如 R-AN-03）不算數字
const NUM = /-?\d+(?:\.\d+)?/g;
const numbersIn = (s: string): number[] => (s.replace(IDS, " ").match(NUM) ?? []).map(Number).filter(Number.isFinite);
const near = (a: number, b: number) => Math.abs(Math.abs(a) - Math.abs(b)) <= Math.max(0.011, Math.abs(b) * 0.005);   // 日期的連字號會被當成負號：比較絕對值

function allowedNumbers(r: DecisionSupportResponse): number[] {
  return factsFromDecisionSupport(r).flatMap((f) => numbersIn(f.text));
}

export function checkText(text: string, rec: DecisionRecommendation | null, r: DecisionSupportResponse, allowed: number[]): string[] {
  const why: string[] = [];
  const bad = [...new Set(numbersIn(text).filter((n) => !allowed.some((a) => near(n, a))).map(String))];
  if (bad.length) why.push(`數字對不上事實清單：${bad.join("、")}`);
  if (FAULT.test(text)) why.push("出現故障／更換結論");
  if (ACTUATION.test(text)) why.push("出現自動控制字樣");
  if (OVERCLAIM.test(text)) why.push("出現過度肯定、網址或授權字樣");
  if (!rec || rec.tier !== "formal_risk") {
    if (THRESHOLD.test(text)) why.push("出現門檻式字樣（非正式層不得有）");
    if (TIER_UPGRADE.test(text)) why.push("把非正式建議說成正式決策／已驗證政策");
  }
  if (rec && rec.tier === "needs_human_review" && CONFIRMED_ANOMALY.test(text)) why.push("把候選事件說成已確認的異常");
  const hasForecast = r.evidence.some((e) => e.kind === "forecast_task" || e.kind === "formal_decision");
  if (!hasForecast && PREDICTION.test(text)) why.push("沒有預測證據卻出現預測值");
  if (r.capability.forecast.status === "not_available" && r.capability.formal_risk.status === "not_available" && PREDICTION.test(text)) why.push("此場域不提供預測卻出現預測值");
  return why;
}

export function mandatoryDecisionDisclaimers(r: DecisionSupportResponse): string[] {
  const d = [
    "資料來源：銘祥科技提供的 2026 全國 AI 專題創意競賽 AIoT 感測資料（競賽方提供、無公開下載網址）；使用者已確認可用於本競賽專題（使用者聲明，沒有外部證明文件）。",
    "建議的層級、可信程度、限制與證據由規則層決定；AI 只改寫白話，不能更動。本段文字可能有疏漏，請以證據與畫面數字為準。",
    "系統不控制任何設備；所有處置都由人判斷與執行。",
  ];
  if (r.tier_summary.needs_human_review > 0) d.push("『需要人工確認』的項目是候選事件，不是故障判定；需要現場或資料來源確認。");
  if (r.capability.forecast.status === "available") d.push("預測是研究預測（探索性、尚未經獨立前瞻驗證），模式是歷史時點模擬，不是即時監控。");
  else d.push("此場域目前不提供預測：" + (r.capability.forecast.reason ?? "資料不足或模型不適用") + "；這裡只有資料檢查與異常確認建議。");
  if (r.capability.formal_risk.status === "available") d.push("正式風險決策只來自既有羊舍決策引擎；其門檻仍是候選值、未經資料提供者確認。");
  else d.push("此場域沒有登錄的正式決策引擎與經驗證政策，所以沒有『正式風險決策』。");
  return d;
}

const baseItem = (x: DecisionRecommendation): Omit<DecisionExplainItem, "plain_text" | "plain_text_source" | "cites" | "fallback_reasons"> =>
  ({ rec_id: x.id, tier: x.tier, title: x.title, action_codes: x.action_codes, evidence_ids: x.evidence_ids, confidence: x.confidence, limitations: x.limitations, applicability: x.applicability });

export function ruleBasedOverview(r: DecisionSupportResponse): string {
  const t = r.tier_summary;
  return `${r.display_name}：共 ${r.recommendations.length} 項建議（一般 ${t.general} 項、需要人工確認 ${t.needs_human_review} 項、正式風險決策 ${t.formal_risk} 項）。`;
}

// 規則層原文（不經過 Gemini；Gemini 不可用時整份都用這個）
export function ruleBasedExplain(r: DecisionSupportResponse, reason = "規則式摘要"): DecisionExplainResponse {
  const items = r.recommendations.map((x) => ({ ...baseItem(x), plain_text: x.statement, plain_text_source: "rule_based" as const, cites: x.evidence_ids, fallback_reasons: [reason] }));
  return { dataset_id: r.dataset_id, overview: ruleBasedOverview(r), overview_source: "rule_based", items, cannot_conclude: ["規則式摘要不含 AI 改寫；候選事件的原因與設備狀態都需要人員確認。"],
    disclaimers: [...mandatoryDecisionDisclaimers(r), `⚠️ 本頁是規則層的原文（${reason}），不是 AI 改寫。`], guard: { ok: true, fallback_items: items.map((i) => i.rec_id), dropped_unknown_items: [], issues: [] } };
}

type Parsed = { overview?: string; items?: Array<{ rec_id?: string; plain_text?: string; cites?: string[] }>; cannot_conclude?: string[] };

export function finalizeDecision(raw: unknown, r: DecisionSupportResponse): DecisionExplainResponse {
  let p: Parsed;
  try { p = (typeof raw === "string" ? JSON.parse(raw) : raw) as Parsed; } catch { return ruleBasedExplain(r, "Gemini 回應不是有效的 JSON"); }
  const recs = new Map(r.recommendations.map((x) => [x.id, x] as const));
  const factIds = new Set(factsFromDecisionSupport(r).map((f) => f.id));
  const allowed = allowedNumbers(r);
  const taken = new Map<string, { plain_text: string; cites: string[] }>();
  const dropped: string[] = [];
  const issues: string[] = [];
  for (const it of p.items ?? []) {
    const id = String(it.rec_id ?? "");
    if (!recs.has(id)) { dropped.push(id || "(空白)"); continue; }
    if (taken.has(id)) { issues.push(`${id} 重複，只採用第一個`); continue; }
    taken.set(id, { plain_text: String(it.plain_text ?? "").trim(), cites: (it.cites ?? []).map(String) });
  }
  const items: DecisionExplainItem[] = [];
  const fallback: string[] = [];
  for (const x of r.recommendations) {
    const t = taken.get(x.id);
    const why: string[] = [];
    if (!t || !t.plain_text) why.push("Gemini 沒有為這一項輸出文字");
    else {
      why.push(...checkText(t.plain_text, x, r, allowed));
      if (t.cites.length === 0) why.push("沒有引用任何事實編號");
      const unknown = t.cites.filter((c) => !factIds.has(c));
      if (unknown.length) why.push(`引用了不存在的事實編號：${unknown.join("、")}`);
    }
    if (why.length) { fallback.push(x.id); items.push({ ...baseItem(x), plain_text: x.statement, plain_text_source: "rule_based", cites: x.evidence_ids, fallback_reasons: why }); }
    else items.push({ ...baseItem(x), plain_text: t!.plain_text, plain_text_source: "gemini", cites: t!.cites, fallback_reasons: [] });
  }
  const ov = String(p.overview ?? "").trim();
  const ovWhy = ov ? checkText(ov, null, r, allowed) : ["沒有整體重點"];
  const overview = ovWhy.length ? ruleBasedOverview(r) : ov;
  if (ovWhy.length) issues.push("整體重點改用規則層文字：" + ovWhy.join("；"));
  const cc = (p.cannot_conclude ?? []).map(String).filter((s) => s && checkText(s, null, r, allowed).length === 0).slice(0, 6);
  const disclaimers = mandatoryDecisionDisclaimers(r);
  if (fallback.length) disclaimers.push(`⚠️ ${fallback.length} 項因 AI 改寫沒有通過核對，已改用規則層原文（標示為『規則層原文』）。`);
  return { dataset_id: r.dataset_id, overview, overview_source: ovWhy.length ? "rule_based" : "gemini", items, cannot_conclude: cc.length ? cc : ["資料沒有提供的內容目前無法判斷。"], disclaimers,
    guard: { ok: fallback.length === 0 && dropped.length === 0 && ovWhy.length === 0, fallback_items: fallback, dropped_unknown_items: dropped, issues } };
}

// ------------------------------------------------------------------ 呼叫 Gemini（薄包裝；金鑰與模型名稱由呼叫端提供；任何失敗都退回規則層原文）
export async function explainDecision(r: DecisionSupportResponse, ai: GenAI, model: string, question?: string): Promise<DecisionExplainResponse> {
  if (!r.recommendations.length) throw new Error("沒有建議可以改寫");
  const { system, user } = buildDecisionPrompt(r, question);
  try {
    const res = await ai.models.generateContent({ model, contents: user, config: { systemInstruction: system, responseMimeType: "application/json", responseSchema: DECISION_RESPONSE_SCHEMA, temperature: 0.2 } });
    return finalizeDecision(res.text ?? "{}", r);
  } catch (e) {
    return ruleBasedExplain(r, "Gemini 呼叫失敗或逾時");
  }
}
