import React, { useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Database,
  Info,
  Loader2,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import type {
  ConfidenceLevel,
  DecisionEvidence,
  DecisionExplainItem,
  DecisionExplainResponse,
  DecisionRecommendation,
  RealDataset,
} from "../../contracts/types";
import {
  fetchDecisionSupport,
  requestDecisionExplain,
} from "../lib/dataLoader";
import type { DecisionWithSource } from "../types/app";

interface DecisionSupportPageProps {
  datasets: RealDataset[];
  datasetId: string;
  onSelectDataset: (id: string) => void;
}

const ACTION_LABELS: Record<string, string> = {
  continue_monitoring: "持續監測",
  increase_monitoring: "加強監測",
  check_data_transmission: "檢查資料傳輸",
  verify_sensor_source: "確認感測器來源",
  manual_remeasure: "人工複測",
  request_human_confirmation: "請人員確認",
  notify_owner: "通知負責人",
  use_baseline_as_reference: "以簡單基準對照",
  accumulate_data: "累積更多資料",
};

const CONFIDENCE_LABELS: Record<
  ConfidenceLevel,
  { label: string; className: string }
> = {
  high: {
    label: "高（high）",
    className: "text-emerald-800 bg-emerald-50 border-emerald-200",
  },
  medium: {
    label: "中（medium）",
    className: "text-blue-800 bg-blue-50 border-blue-200",
  },
  low: {
    label: "低（low）",
    className: "text-amber-800 bg-amber-50 border-amber-200",
  },
  not_assessable: {
    label: "無法評估（not_assessable）",
    className: "text-slate-700 bg-slate-100 border-slate-200",
  },
};

export const DecisionSupportPage: React.FC<DecisionSupportPageProps> = ({
  datasets,
  datasetId,
  onSelectDataset,
}) => {
  const [data, setData] = useState<DecisionWithSource | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [question, setQuestion] = useState("");
  const [explaining, setExplaining] = useState(false);
  const [explainError, setExplainError] = useState<string | null>(null);
  const [explainResult, setExplainResult] =
    useState<DecisionExplainResponse | null>(null);

  const [expandedEvidence, setExpandedEvidence] = useState<
    Record<string, boolean>
  >({});

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setExplainResult(null);
    setExplainError(null);
    setExpandedEvidence({});
    fetchDecisionSupport(datasetId)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "無法載入決策輔助資料");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [datasetId]);

  const handleExplain = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!data || explaining) return;
    setExplaining(true);
    setExplainError(null);
    try {
      const res = await requestDecisionExplain(datasetId, question);
      setExplainResult(res);
    } catch (err) {
      setExplainError(
        err instanceof Error ? err.message : "白話改寫請求失敗"
      );
    } finally {
      setExplaining(false);
    }
  };

  const toggleEvidence = (recId: string) => {
    setExpandedEvidence((prev) => ({ ...prev, [recId]: !prev[recId] }));
  };

  const isSheep = data?.dataset_id === "sheep_barn";

  const evidenceMap = new Map<string, DecisionEvidence>(
    (data?.evidence ?? []).map((ev) => [ev.id, ev])
  );

  const explainItemMap = new Map<string, DecisionExplainItem>(
    (explainResult?.items ?? []).map((it) => [it.rec_id, it])
  );

  const needsReviewRecs = (data?.recommendations ?? []).filter(
    (r) => r.tier === "needs_human_review"
  );
  const generalRecs = (data?.recommendations ?? []).filter(
    (r) => r.tier === "general"
  );
  // formal_risk 嚴格只允許出現在 sheep_barn
  const formalRiskRecs = isSheep
    ? (data?.recommendations ?? []).filter((r) => r.tier === "formal_risk")
    : [];

  const allRuleBased =
    explainResult &&
    explainResult.overview_source === "rule_based" &&
    explainResult.items.every((i) => i.plain_text_source === "rule_based");

  const renderRecommendationCard = (
    rec: DecisionRecommendation,
    variant: "needs_human_review" | "general" | "formal_risk"
  ) => {
    const conf = CONFIDENCE_LABELS[rec.confidence.level];
    const isExpanded = Boolean(expandedEvidence[rec.id]);
    const linkedEvidence = rec.evidence_ids
      .map((eid) => evidenceMap.get(eid))
      .filter((x): x is DecisionEvidence => Boolean(x));
    const explained = explainItemMap.get(rec.id);

    const cardBorder =
      variant === "needs_human_review"
        ? "border-amber-300 bg-white"
        : variant === "formal_risk"
          ? "border-blue-300 bg-white"
          : "border-slate-200 bg-white";

    return (
      <article
        key={rec.id}
        className={`rounded-md border p-4 space-y-3 min-w-0 ${cardBorder}`}
      >
        <div className="flex flex-wrap items-start justify-between gap-2 min-w-0">
          <div className="space-y-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="font-mono-tabular text-slate-500">{rec.id}</span>
              {variant === "needs_human_review" && (
                <span className="font-semibold text-amber-800 bg-amber-100 px-2 py-0.5 rounded">
                  候選事件，不是故障判定
                </span>
              )}
              {variant === "formal_risk" && (
                <span className="font-semibold text-blue-900 bg-blue-100 px-2 py-0.5 rounded">
                  正式模型輸出・門檻 84 為候選值
                </span>
              )}
            </div>
            <h3 className="text-sm font-semibold text-slate-900 break-words">
              {rec.title}
            </h3>
          </div>

          {variant === "formal_risk" ? (
            <div className="flex flex-wrap items-center gap-2 min-w-0">
              <span className="text-xs font-medium px-2.5 py-1 rounded border shrink-0 text-slate-700 bg-slate-100 border-slate-300">
                引用忠實度：{conf.label}
              </span>
              <span className="text-xs font-medium text-slate-700">
                門檻 84 為候選值，未經確認
              </span>
            </div>
          ) : (
            <span
              className={`text-xs font-medium px-2.5 py-1 rounded border shrink-0 ${conf.className}`}
            >
              可信程度：{conf.label}
            </span>
          )}
        </div>

        {/* Rule-layer deterministic statement */}
        <p className="text-sm text-slate-800 leading-relaxed">
          {rec.statement}
        </p>

        {/* Gemini / Rule-based Plain Language Rewrite block */}
        {explained && (
          <div
            className={`p-3 rounded-md border text-xs space-y-1.5 ${
              explained.plain_text_source === "gemini"
                ? "bg-blue-50/70 border-blue-200 text-slate-800"
                : "bg-slate-50 border-slate-200 text-slate-800"
            }`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span
                className={`font-semibold px-2 py-0.5 rounded ${
                  explained.plain_text_source === "gemini"
                    ? "bg-[#0B63CE] text-white"
                    : "bg-slate-200 text-slate-800"
                }`}
              >
                {explained.plain_text_source === "gemini"
                  ? "Gemini 改寫"
                  : "規則層原文"}
              </span>
              {explained.cites.length > 0 && (
                <span className="font-mono-tabular text-slate-500">
                  引用證據：{explained.cites.join(", ")}
                </span>
              )}
            </div>
            <p className="text-sm leading-relaxed">{explained.plain_text}</p>
            {explained.fallback_reasons.length > 0 && (
              <div className="text-amber-800">
                退回原因：{explained.fallback_reasons.join("；")}
              </div>
            )}
          </div>
        )}

        {/* Allowed actions */}
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="font-medium text-slate-500">建議行動（無設備控制）：</span>
          {rec.action_codes.map((code) => (
            <span
              key={code}
              className="px-2 py-0.5 rounded bg-slate-100 text-slate-700 font-medium"
            >
              {ACTION_LABELS[code] ?? code}
            </span>
          ))}
        </div>

        {/* Confidence basis + cap reason */}
        <div className="p-2.5 rounded bg-slate-50 border border-slate-200 text-xs text-slate-700 space-y-1">
          <div>
            <strong className="text-slate-900">可信程度依據：</strong>
            {rec.confidence.basis.map((b) => b.text).join("；")}
          </div>
          {rec.confidence.cap_reason && (
            <div className="text-slate-600">
              <strong className="text-slate-800">上限原因：</strong>
              {rec.confidence.cap_reason}
            </div>
          )}
        </div>

        {/* Applicability & Limitations */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
          <div className="p-2.5 rounded border border-slate-200 bg-white space-y-1">
            <div className="font-semibold text-slate-700">適用條件</div>
            <div className="text-slate-700">適用：{rec.applicability.applies_to}</div>
            {rec.applicability.not_applicable_when.length > 0 && (
              <div className="text-slate-500">
                不適用：{rec.applicability.not_applicable_when.join("；")}
              </div>
            )}
          </div>
          <div className="p-2.5 rounded border border-slate-200 bg-white space-y-1">
            <div className="font-semibold text-slate-700">限制與邊界</div>
            <ul className="list-disc list-inside text-slate-600 space-y-0.5">
              {rec.limitations.map((lim, idx) => (
                <li key={idx}>{lim}</li>
              ))}
            </ul>
          </div>
        </div>

        {/* Expandable Evidence */}
        <div>
          <button
            type="button"
            onClick={() => toggleEvidence(rec.id)}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#0B63CE] hover:underline"
          >
            {isExpanded ? (
              <>
                <ChevronUp className="h-3.5 w-3.5" />
                收合可追溯證據（{rec.evidence_ids.join(", ")}）
              </>
            ) : (
              <>
                <ChevronDown className="h-3.5 w-3.5" />
                展開可追溯證據（{rec.evidence_ids.join(", ")}）
              </>
            )}
          </button>

          {isExpanded && (
            <div className="mt-2 space-y-2">
              {linkedEvidence.map((ev) => (
                <div
                  key={ev.id}
                  className="p-3 rounded border border-slate-200 bg-slate-50 text-xs space-y-1 min-w-0 overflow-x-auto"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 font-mono-tabular text-slate-600 min-w-0">
                    <span className="font-semibold text-slate-900">
                      [{ev.id}] {ev.kind}
                    </span>
                    <span className="break-all">
                      來源：{ev.source.artifact} · {ev.source.pointer}（
                      {ev.source.engine_version}）
                    </span>
                  </div>
                  <div className="text-slate-800 break-words">{ev.summary}</div>
                  {ev.window && (
                    <div className="font-mono-tabular text-slate-500 break-all">
                      時窗：{ev.window.start} ～ {ev.window.end}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </article>
    );
  };

  return (
    <div className="space-y-6 min-w-0">
      {/* Page Header + 7-Domain Switcher + Honest Source Metadata */}
      <section className="bg-white border border-slate-200 rounded-lg p-4 sm:p-5 space-y-4 min-w-0">
        <div className="flex flex-wrap items-start justify-between gap-4 min-w-0">
          <div className="space-y-1 min-w-0">
            <h1 className="text-xl font-bold text-slate-900">
              七場域決策輔助
            </h1>
            <p className="text-xs text-slate-600">
              所有建議、層級、可信程度與數字均來自規則層與既有引擎輸出；前端不產生任何門檻、故障結論、預測值或設備控制指令。
            </p>
          </div>

          <div className="w-full sm:w-auto flex flex-col sm:flex-row sm:items-center gap-1.5 sm:gap-2 min-w-0">
            <label
              htmlFor="decision-domain-select"
              className="text-xs font-medium text-slate-600 shrink-0"
            >
              切換場域：
            </label>
            <select
              id="decision-domain-select"
              value={datasetId}
              onChange={(e) => onSelectDataset(e.target.value)}
              className="w-full sm:w-auto max-w-full min-w-0 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-800"
            >
              {datasets.map((ds) => (
                <option key={ds.id} value={ds.id}>
                  {ds.display_name}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Top Source & Provenance Bar */}
        {data && (
          <div className="p-3 rounded-md bg-slate-50 border border-slate-200 text-xs text-slate-700 flex flex-wrap items-center justify-between gap-2 min-w-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 min-w-0">
              <span>
                資料種類：<strong className="text-slate-900">真實資料</strong>
              </span>
              <span className="break-words">
                來源：競賽方提供／無公開下載網址；使用者確認可用於本競賽專題；無外部證明文件
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2 font-mono-tabular text-slate-600 min-w-0 break-all">
              <Database className="h-3.5 w-3.5 text-[#0B63CE] shrink-0" />
              <span>
                {data.source === "engine" ? "引擎即時" : "預計算（離線）"}
              </span>
              {data.generated_at && (
                <span>｜產生時間：{data.generated_at}</span>
              )}
            </div>
          </div>
        )}
      </section>

      {loading && (
        <div className="bg-white border border-slate-200 rounded-lg p-8 flex items-center justify-center gap-2 text-sm text-slate-600">
          <Loader2 className="h-5 w-5 animate-spin text-[#0B63CE]" />
          載入 {datasetId} 決策輔助中…
        </div>
      )}

      {error && (
        <div className="p-4 rounded-lg bg-rose-50 border border-rose-200 text-sm text-rose-800">
          {error}
        </div>
      )}

      {!loading && data && (
        <>
          {/* 1. 四項能力卡 */}
          <section aria-label="場域分析能力狀態" className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="bg-white border border-slate-200 rounded-lg p-4 space-y-1">
              <div className="text-xs text-slate-500">資料品質檢查</div>
              <div className="text-sm font-semibold text-emerald-700 flex items-center gap-1.5">
                <CheckCircle2 className="h-4 w-4" />
                {data.capability.data_checks ? "可用" : "不可用"}
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-lg p-4 space-y-1">
              <div className="text-xs text-slate-500">候選異常確認</div>
              <div className="text-sm font-semibold text-emerald-700 flex items-center gap-1.5">
                <CheckCircle2 className="h-4 w-4" />
                {data.capability.anomaly_review ? "可用（僅候選）" : "不可用"}
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-lg p-4 space-y-1">
              <div className="text-xs text-slate-500">歷史時點模擬預測</div>
              {data.capability.forecast.status === "available" ? (
                <div className="text-sm font-semibold text-emerald-700 flex items-center gap-1.5">
                  <CheckCircle2 className="h-4 w-4" />
                  可用（探索性）
                </div>
              ) : (
                <div>
                  <div className="text-sm font-semibold text-slate-800 flex items-center gap-1.5">
                    <Info className="h-4 w-4 text-slate-500" />
                    此場域不提供預測
                  </div>
                  {data.capability.forecast.reason && (
                    <div className="text-xs text-slate-600 mt-1">
                      {data.capability.forecast.reason}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="bg-white border border-slate-200 rounded-lg p-4 space-y-1">
              <div className="text-xs text-slate-500">
                {isSheep ? "正式風險決策引擎" : "專用風險模型狀態"}
              </div>
              {isSheep && data.capability.formal_risk.status === "available" ? (
                <div>
                  <div className="text-sm font-semibold text-[#0B63CE] flex items-center gap-1.5">
                    <ShieldAlert className="h-4 w-4" />
                    可用（門檻 84 為候選值）
                  </div>
                  <div className="text-xs text-slate-600 mt-1">
                    {data.capability.formal_risk.validated_policy
                      ? "政策已驗證"
                      : "目前沒有經驗證的政策"}
                  </div>
                </div>
              ) : (
                <div>
                  <div className="text-sm font-semibold text-slate-700 flex items-center gap-1.5">
                    <Info className="h-4 w-4 text-slate-400" />
                    未登錄（無此層輸出）
                  </div>
                  <div className="text-xs text-slate-500 mt-1">
                    {data.capability.formal_risk.reason || "此場域沒有登錄專用風險模型"}
                  </div>
                </div>
              )}
            </div>
          </section>

          {/* Confidence Meaning + Plain-Language Gemini Trigger */}
          <section className="bg-white border border-slate-200 rounded-lg p-4 sm:p-5 space-y-4 min-w-0">
            <div className="p-3 rounded-md bg-blue-50/70 border border-blue-200 text-xs text-blue-950">
              <strong>可信程度說明：</strong>
              {data.policy.confidence_meaning}
            </div>

            <form
              onSubmit={handleExplain}
              className="flex flex-col sm:flex-row sm:flex-wrap items-stretch sm:items-center gap-2 min-w-0"
            >
              <input
                type="text"
                maxLength={300}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="選填問題（最多 300 字）：例如「我現在該先請現場人員確認哪幾件事？」"
                className="w-full sm:flex-1 min-w-0 rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-[#0B63CE] focus:outline-none"
              />
              <button
                type="submit"
                disabled={explaining}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-[#0B63CE] text-white text-sm font-medium hover:bg-[#0952AD] disabled:opacity-50"
              >
                {explaining ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    改寫中…
                  </>
                ) : (
                  <>
                    <Sparkles className="h-4 w-4" />
                    用白話解釋
                  </>
                )}
              </button>
            </form>

            {explainError && (
              <div className="p-3 rounded-md bg-rose-50 border border-rose-200 text-xs text-rose-800">
                {explainError}
              </div>
            )}

            {explainResult && (
              <div className="p-4 rounded-md border border-slate-200 bg-slate-50 space-y-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span
                      className={`text-xs font-semibold px-2 py-0.5 rounded ${
                        explainResult.overview_source === "gemini"
                          ? "bg-[#0B63CE] text-white"
                          : "bg-slate-200 text-slate-800"
                      }`}
                    >
                      {explainResult.overview_source === "gemini"
                        ? "Gemini 改寫"
                        : "規則層原文"}
                    </span>
                    <span className="font-semibold text-slate-900">
                      決策輔助總覽
                    </span>
                  </div>
                </div>

                {allRuleBased && (
                  <div className="p-2.5 rounded bg-amber-50 border border-amber-200 text-xs text-amber-900">
                    <strong>注意：</strong>
                    目前未連線 Gemini 或改寫未通過核對，整頁顯示為「規則層原文」，<strong>不是 AI 改寫</strong>。
                  </div>
                )}

                {(!explainResult.guard.ok ||
                  explainResult.guard.fallback_items.length > 0) &&
                  !allRuleBased && (
                    <div className="p-2.5 rounded bg-amber-50 border border-amber-300 text-xs text-amber-950 space-y-1">
                      <div className="font-semibold">
                        部分項目已改回規則層原文（{explainResult.guard.fallback_items.join(", ")}）
                      </div>
                      {explainResult.guard.issues.length > 0 && (
                        <div>原因：{explainResult.guard.issues.join("；")}</div>
                      )}
                    </div>
                  )}

                <p className="text-slate-800 leading-relaxed">
                  {explainResult.overview}
                </p>

                {explainResult.cannot_conclude.length > 0 && (
                  <div className="text-xs text-slate-600">
                    <strong className="text-slate-800">不能直接斷定的事：</strong>
                    {explainResult.cannot_conclude.join("；")}
                  </div>
                )}

                <div className="pt-2 border-t border-slate-200 text-xs text-slate-600 space-y-0.5">
                  {explainResult.disclaimers.map((d, i) => (
                    <div key={i}>• {d}</div>
                  ))}
                </div>
              </div>
            )}
          </section>

          {/* 2. 需要人工確認的異常（黃色獨立區塊） */}
          <section
            aria-label="需要人工確認的異常"
            className="rounded-lg border border-amber-300 bg-amber-50/70 p-5 space-y-4"
          >
            <div>
              <h2 className="text-base font-bold text-amber-950 flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-700" />
                需要人工確認的異常（{needsReviewRecs.length} 項）
              </h2>
              <p className="text-xs text-amber-900 mt-1">
                以下皆為偵測器或資料品質掃描標出的「候選事件，不是故障判定」，必須由人員現場或查資料來源確認。系統不判斷故障、不建議更換設備、不控制任何設備。
              </p>
            </div>

            {needsReviewRecs.length === 0 ? (
              <div className="p-4 rounded bg-white border border-amber-200 text-xs text-slate-600">
                此場域目前沒有列入人工確認清單的候選異常項目。
              </div>
            ) : (
              <div className="space-y-3">
                {needsReviewRecs.map((rec) =>
                  renderRecommendationCard(rec, "needs_human_review")
                )}
              </div>
            )}
          </section>

          {/* 3. 一般建議（中性樣式） */}
          <section
            aria-label="一般建議"
            className="rounded-lg border border-slate-200 bg-slate-50/70 p-5 space-y-4"
          >
            <div>
              <h2 className="text-base font-bold text-slate-900">
                一般建議（{generalRecs.length} 項）
              </h2>
              <p className="text-xs text-slate-600 mt-1">
                資料檢查、監測提醒與模型適用性說明；不涉及風險判定。
              </p>
            </div>

            {data.capability.forecast.status === "not_available" && (
              <div className="p-3.5 rounded-md bg-white border border-slate-300 text-xs text-slate-800">
                <strong>此場域不提供預測：</strong>
                {data.capability.forecast.reason}
              </div>
            )}

            <div className="space-y-3">
              {generalRecs.map((rec) =>
                renderRecommendationCard(rec, "general")
              )}
            </div>
          </section>

          {/* 4. 正式風險決策（嚴格只出現在羊舍） */}
          {isSheep && (
            <section
              aria-label="正式風險決策"
              className="rounded-lg border border-blue-300 bg-blue-50/70 p-5 space-y-4"
            >
              <div className="space-y-1.5">
                <h2 className="text-base font-bold text-blue-950 flex items-center gap-2">
                  <ShieldAlert className="h-4 w-4 text-[#0B63CE]" />
                  正式風險決策（僅羊舍；原樣引用既有決策引擎）
                </h2>
                <div className="text-xs text-blue-950 space-y-1">
                  <div>
                    • <strong>門檻 84 為候選值，未經資料提供者確認</strong>；
                    {data.capability.formal_risk.validated_policy
                      ? "政策已驗證"
                      : "目前沒有經驗證的政策"}
                    。
                  </div>
                  <div>
                    • <strong>系統不控制任何設備</strong>（所有現場調整由人員決定）。
                  </div>
                </div>
              </div>

              <div className="space-y-3">
                {formalRiskRecs.map((rec) =>
                  renderRecommendationCard(rec, "formal_risk")
                )}
              </div>
            </section>
          )}

          {/* 場域通用限制 */}
          <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-2 text-xs text-slate-600">
            <div className="font-semibold text-slate-800">
              通用限制與誠實說明
            </div>
            <ul className="list-disc list-inside space-y-1">
              {data.generic_limitations.map((lim, idx) => (
                <li key={idx}>{lim}</li>
              ))}
            </ul>
            {data.notes && (
              <div className="pt-2 border-t border-slate-100 text-slate-500">
                註記：{data.notes}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
};
