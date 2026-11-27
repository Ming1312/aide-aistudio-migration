// Gemini 自然語言解釋：『有根據』的實作範本（無外部相依，可單獨測試）。
// 設計：Gemini 只負責把『引擎已經算出的事實』說成白話；它不產生數字、不做預測、不下診斷。
//   1) 事實清單（Fact[]）由引擎回應整理而來，每條有 id；
//   2) 提示詞要求每個論點都附 cites（引用哪幾個 fact id）；
//   3) 回來之後在伺服器端核對：引用的 id 必須存在；回答中的每個數字必須出現在事實清單裡；
//   4) 限制聲明由伺服器強制附加，不靠模型記得要寫。
// 金鑰只在伺服器端（GEMINI_API_KEY）；本檔不接觸金鑰。
import type { AnomaliesResponse, DataKind, ExplainRequest, ExplainResponse, Fact, ForecastResponse } from "../contracts/types.ts";

export const SYSTEM_INSTRUCTION = `你是 AIDE 智慧環境監測平台的『解說員』，只用繁體中文。
你的工作：把使用者畫面上『已經由系統算出』的資料、預測與異常事件，說成任何人都看得懂的話。

嚴格規則（違反任何一條就是錯誤）：
1. 你只能使用【事實清單】裡的內容。清單沒有的數字、日期、感測器、原因，一律不得出現；不知道就明說『資料沒有提供』。
2. 你不做預測、不重新計算、不推測沒有給你的數值。預測值只能照抄清單。
3. 每個『觀察』與『可能原因』都要在 cites 列出所依據的事實 id（如 ["f1","f3"]）。沒有依據的句子不要寫。
4. 『可能原因』只能是常見原因的列舉（例如探頭老化、接線鬆脫），語氣是『可能』，並說明資料本身無法證實；絕不可說『一定是』『確定是』。
5. 不得宣稱準確度或可靠度；模型是研究預測（探索性、未經獨立前瞻驗證）。不得說『準確』『可靠』『已驗證』。
6. 若 data_kind 是 synthetic，必須明講這是合成（模擬）資料，不是真實資料，不能代表真實世界。
7. 這個系統不控制任何設備。建議的行動只能是『檢查、確認、通知、比對』這類由人執行的事；不得建議『自動開關』『直接調整設備』。
8. 若有任何模型被標示 refused（拒絕預測），要原樣說明原因，不得用其他模型『補上』。
9. 關於資料來源與授權：只能說「銘祥科技提供的 2026 全國 AI 專題創意競賽 AIoT 感測資料（競賽方提供、無公開下載網址）；使用者已確認可用於本競賽專題」。不得提供任何網址，不得說資料具有 CC BY、CC0 或任何標準開放授權，不得說「已取得授權證明」或「官方授權」。
10. 輸出必須是符合 schema 的 JSON；每段簡短、白話、不用專業縮寫（若用 MAE 等縮寫要先解釋）。`;

export const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    summary: { type: "STRING", description: "兩三句話的重點" },
    observations: { type: "ARRAY", items: { type: "OBJECT", properties: { text: { type: "STRING" }, cites: { type: "ARRAY", items: { type: "STRING" } } }, required: ["text", "cites"] } },
    possible_causes: { type: "ARRAY", items: { type: "OBJECT", properties: { text: { type: "STRING" }, cites: { type: "ARRAY", items: { type: "STRING" } } }, required: ["text", "cites"] } },
    cannot_conclude: { type: "ARRAY", items: { type: "STRING" } },
    suggested_checks: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["summary", "observations", "possible_causes", "cannot_conclude", "suggested_checks"],
} as const;

// ------------------------------------------------------------------ 事實清單
const f = (id: string, text: string, value?: number | string, unit?: string): Fact => ({ id, text, value, unit });
const fmt = (x: number | null | undefined, d = 2) => (x === null || x === undefined || !Number.isFinite(x) ? "—" : Number(x.toFixed(d)).toString());

export function factsFromForecast(r: ForecastResponse): Fact[] {
  const out: Fact[] = [];
  let n = 1;
  const add = (t: string, v?: number | string, u?: string) => out.push(f(`f${n++}`, t, v, u));
  add(`預測對象：${r.dataset_id} 的 ${r.sensor}，預測 ${r.horizon_h} 小時後（${r.mode}，不是即時監控）`);
  add(`預測起點 ${r.forecast_origin}，目標時間 ${r.target_timestamp}；起點所屬期間：${r.period_zh}`);
  if (r.last_observation_value !== null) add(`起點最後一筆觀測值 ${fmt(r.last_observation_value)} ${r.unit}`, r.last_observation_value, r.unit);
  if (r.actual_at_target !== null) add(`目標時間的實際值（事後揭曉）${fmt(r.actual_at_target)} ${r.unit}`, r.actual_at_target, r.unit);
  add(`單位 ${r.unit}（單位是推測的，狀態 ${r.unit_status}，尚未經資料提供者確認）`);
  add(`最佳基準方法（驗證期誤差最低的簡單方法）：${r.best_baseline}`);
  for (const [k, m] of Object.entries(r.models)) {
    if (m.value !== null) {
      add(`${m.label} 預測 ${fmt(m.value)} ${r.unit}`, m.value, r.unit);
      if (m.interval?.shown && m.interval.lower !== null && m.interval.upper !== null) add(`${m.label} 的探索性 90% 區間 ${fmt(m.interval.lower)} ~ ${fmt(m.interval.upper)} ${r.unit}（尚未獨立驗證）`);
    } else add(`${m.label} 拒絕預測：${m.refused ?? "原因未提供"}`);
    if (m.holdout) add(`${m.label} 在留存測試期平均絕對誤差 MAE ${fmt(m.holdout.MAE, 3)}（樣本 ${m.holdout.n} 筆；留存測試期不是獨立驗證）`, m.holdout.MAE);
    if (m.evidence) add(`${m.label} 的證據說明：${m.evidence}`);
  }
  add(`研究狀態：${r.research_status}`);
  add(r.no_claim);
  return out;
}

export function factsFromAnomalies(a: AnomaliesResponse, top = 8): Fact[] {
  const out: Fact[] = [];
  let n = 1;
  out.push(f(`f${n++}`, `${a.dataset_id} 共偵測到 ${a.n_events} 個候選異常事件（候選＝需要現場確認，不是故障判定）`, a.n_events));
  for (const e of a.events.slice(0, top)) out.push(f(`f${n++}`, `${e.kind_zh}：感測器「${e.column}」，${e.start} 到 ${e.end}（約 ${e.hours} 小時），強度分數 ${fmt(e.score)}；偵測器：${e.detector}；說明：${e.note}`, e.score));
  out.push(f(`f${n++}`, a.disclaimer));
  return out;
}

export function mandatoryDisclaimers(kind: ExplainRequest["kind"], dataKind: DataKind): string[] {
  const d = ["本段文字由 AI 依系統算出的結果整理，可能有疏漏；請以畫面上的數字為準。", "系統不控制任何設備；所有建議都由人判斷與執行。"];
  if (dataKind === "real") d.unshift("資料來源：銘祥科技提供的 2026 全國 AI 專題創意競賽 AIoT 感測資料（競賽方提供、無公開下載網址）；使用者已確認可用於本競賽專題（使用者聲明，沒有外部證明文件，也沒有標準開放授權）。");
  if (dataKind === "synthetic") d.unshift("這是合成（模擬）展示資料，不是真實資料，不能用來判斷真實世界的表現。");
  if (kind === "forecast" || kind === "compare") d.push("預測是研究預測（探索性、尚未經獨立前瞻驗證），模式是歷史時點模擬，不是即時監控。");
  if (kind === "anomaly") d.push("異常事件是候選事件，需要現場確認，不是故障判定。");
  if (kind === "plan") d.push("長期規劃是依歷史資料事件的統計提出的建議，不是預測未來；實際排程、預算與是否採用由管理員判斷。");
  return d;
}

// ------------------------------------------------------------------ 提示詞
/** 長期規劃（管理員）：沿用同一組欄位與核對機制，只是各欄位的用途不同。 */
export const PLAN_GUIDE = `【輸出要求：長期規劃】
這是給管理員的長期規劃分析。事實清單是各場域「歷史資料事件」（缺值、斷線、卡住、突然跳動…）的統計。
- summary：兩三句話，說明整體資料品質與最需要先處理的重點。
- observations：從歷史事件看到的規律（哪些場域或感測器反覆出事、事件集中的時段、增加或減少的趨勢），每條都要 cites。
- possible_causes：這些規律的常見結構性原因（例如探頭老化、供電不穩、通訊不穩），語氣是「可能」，需 cites。
- suggested_checks：規劃項目。每一條以【短期】、【中期】或【長期】開頭（短期＝一個月內可做，中期＝一季內，長期＝半年以上）；內容是由人執行的維護、校正、備援、門檻複審、資料補強、流程建立。不得出現事實清單沒有的數字，也不要寫具體日期或金額。
- cannot_conclude：這份分析無法判斷的事（例如事件的真正原因、之後是否一定再發生）。`;

export function buildPrompt(req: ExplainRequest): { system: string; user: string } {
  const facts = req.facts.map((x) => `[${x.id}] ${x.text}`).join("\n");
  const q = req.question?.trim() ? `\n使用者的問題：${req.question.trim().slice(0, 300)}` : "\n請整體解釋這些資料。";
  const plan = req.kind === "plan" ? `\n${PLAN_GUIDE}` : "";
  return { system: SYSTEM_INSTRUCTION, user: `data_kind: ${req.data_kind}\n解釋類型: ${req.kind}\n\n【事實清單】\n${facts}\n${q}${plan}` };
}

// ------------------------------------------------------------------ 伺服器端核對
const NUM = /-?\d+(?:\.\d+)?/g;
const numbersIn = (s: string): number[] => (s.match(NUM) ?? []).map(Number).filter(Number.isFinite);

function allowedNumbers(facts: Fact[]): number[] {
  const set: number[] = [];
  for (const x of facts) { set.push(...numbersIn(x.text)); if (typeof x.value === "number") set.push(x.value); }
  return set;
}
const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(0.011, Math.abs(b) * 0.005);   // 容許四捨五入

export function verifyGrounding(parts: { summary: string; observations: Array<{ text: string; cites: string[] }>; possible_causes: Array<{ text: string; cites: string[] }>; cannot_conclude: string[]; suggested_checks: string[] }, facts: Fact[]) {
  const ids = new Set(facts.map((x) => x.id));
  const texts = [parts.summary, ...parts.observations.map((o) => o.text), ...parts.possible_causes.map((o) => o.text), ...parts.cannot_conclude, ...parts.suggested_checks];
  const allowed = allowedNumbers(facts);
  const ungrounded = [...new Set(texts.flatMap(numbersIn).filter((n) => !allowed.some((a) => near(n, a))).map(String))];
  const unknown = [...new Set([...parts.observations, ...parts.possible_causes].flatMap((o) => o.cites).filter((c) => !ids.has(c)))];
  const uncited = [...parts.observations, ...parts.possible_causes].filter((o) => o.cites.length === 0).length;
  return { ungrounded_numbers: ungrounded, unknown_cites: unknown, uncited_claims: uncited, ok: ungrounded.length === 0 && unknown.length === 0 && uncited === 0 };
}

const OVERCLAIM = /(CC\s?BY|CC0|創用\s?CC|已取得授權|授權證明|官方授權|https?:\/\/|一定是|確定是|肯定是|百分之百|保證|非常準確|十分準確|已通過驗證|已經驗證|自動(?:開啟|關閉|調整|控制)|直接(?:調整|控制)設備)/;

export function finalize(raw: unknown, req: ExplainRequest): ExplainResponse {
  const p = (typeof raw === "string" ? JSON.parse(raw) : raw) as ExplainResponse;
  const parts = { summary: String(p.summary ?? ""), observations: p.observations ?? [], possible_causes: p.possible_causes ?? [], cannot_conclude: p.cannot_conclude ?? [], suggested_checks: p.suggested_checks ?? [] };
  const g = verifyGrounding(parts, req.facts);
  const all = [parts.summary, ...parts.observations.map((o) => o.text), ...parts.possible_causes.map((o) => o.text), ...parts.suggested_checks].join("\n");
  const overclaim = OVERCLAIM.test(all);
  const disclaimers = mandatoryDisclaimers(req.kind, req.data_kind);
  if (!g.ok) disclaimers.push("⚠️ 這段說明含有無法對上系統結果的數字或引用，請勿採信該部分，並以畫面數字為準。");
  if (overclaim) disclaimers.push("⚠️ 這段說明含有過度肯定的用語，或提到了授權／網址（例如『一定是』、CC BY、網址）：請忽略該部分——資料本身無法證實原因，且資料沒有標準授權、也沒有公開下載網址。");
  if (req.data_kind === "synthetic" && !/合成|模擬/.test(all)) disclaimers.push("（本次說明沒有提到資料是合成的——請以上方標示為準。）");
  return { ...parts, disclaimers, guard: { ungrounded_numbers: g.ungrounded_numbers, unknown_cites: g.unknown_cites, ok: g.ok && !overclaim } };
}

// ------------------------------------------------------------------ 呼叫 Gemini（薄包裝；金鑰與模型名稱由呼叫端提供）
export interface GenAI { models: { generateContent(a: { model: string; contents: string; config: Record<string, unknown> }): Promise<{ text?: string }> } }

export async function explain(req: ExplainRequest, ai: GenAI, model: string): Promise<ExplainResponse> {
  if (!req.facts.length) throw new Error("沒有事實可以解釋");
  const { system, user } = buildPrompt(req);
  const res = await ai.models.generateContent({ model, contents: user, config: { systemInstruction: system, responseMimeType: "application/json", responseSchema: RESPONSE_SCHEMA, temperature: 0.2 } });
  return finalize(res.text ?? "{}", req);
}
