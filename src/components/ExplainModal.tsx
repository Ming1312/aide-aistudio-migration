import React, { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, Sparkles, X } from "lucide-react";
import { requestGeneralExplain } from "../lib/dataLoader";
import type { ExplainModalPayload, ExplainResponse } from "../types/app";

interface ExplainModalProps {
  payload: ExplainModalPayload | null;
  onClose: () => void;
}

export const ExplainModal: React.FC<ExplainModalProps> = ({
  payload,
  onClose,
}) => {
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ExplainResponse | null>(null);

  useEffect(() => {
    if (!payload) return;
    setQuestion("");
    setError(null);
    setResult(null);
    let cancelled = false;
    setLoading(true);
    requestGeneralExplain(payload.request)
      .then((res) => {
        if (!cancelled) setResult(res);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "白話解釋請求失敗");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [payload]);

  if (!payload) return null;

  const handleAsk = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await requestGeneralExplain({
        ...payload.request,
        question: question.trim() || undefined,
      });
      setResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "白話解釋請求失敗");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={payload.title}
    >
      <div className="bg-white border border-slate-200 rounded-lg max-w-2xl w-full max-h-[90vh] flex flex-col shadow-xl">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-[#0B63CE]" />
            <h2 className="text-base font-semibold text-slate-900">
              {payload.title}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-md text-slate-500 hover:bg-slate-100"
            aria-label="關閉"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4 text-sm">
          {/* Context bar */}
          <div
            className={`px-3 py-2 rounded-md border text-xs flex flex-wrap items-center justify-between gap-2 ${
              payload.request.data_kind === "synthetic"
                ? "bg-amber-50 border-amber-200 text-amber-900"
                : "bg-blue-50 border-blue-200 text-blue-900"
            }`}
          >
            <span>
              事實來源：
              <strong>
                {payload.request.data_kind === "synthetic"
                  ? "合成展示資料（非真實）"
                  : "真實感測資料"}
              </strong>
              ｜僅引用目前畫面產生的 {payload.request.facts.length} 條事實
            </span>
          </div>

          {/* Optional Question Form */}
          <form onSubmit={handleAsk} className="space-y-2">
            <label
              htmlFor="explain-question-input"
              className="block text-xs font-medium text-slate-600"
            >
              針對這組數字進一步提問（選填，最多 300 字；不會自行計算或預測）
            </label>
            <div className="flex gap-2">
              <input
                id="explain-question-input"
                type="text"
                maxLength={300}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="例如：為什麼模型誤差比簡單基準大？有哪些要先確認的？"
                className="flex-1 rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-[#0B63CE] focus:outline-none"
              />
              <button
                type="submit"
                disabled={loading}
                className="px-3.5 py-1.5 rounded-md bg-[#0B63CE] text-white text-sm font-medium hover:bg-[#0952AD] disabled:opacity-50 shrink-0"
              >
                {loading ? "產生中…" : "重新解釋"}
              </button>
            </div>
            <div className="text-[11px] text-slate-400 text-right font-mono-tabular">
              {question.length} / 300
            </div>
          </form>

          {loading && (
            <div className="py-8 flex flex-col items-center justify-center text-slate-600 gap-2">
              <Loader2 className="h-6 w-6 animate-spin text-[#0B63CE]" />
              <div className="text-xs">
                正在呼叫伺服器端 Gemini 解釋並執行數字／引用核對…
              </div>
            </div>
          )}

          {error && (
            <div className="p-3 rounded-md bg-rose-50 border border-rose-200 text-rose-800 text-xs">
              {error}
            </div>
          )}

          {!loading && result && (
            <div className="space-y-4">
              {/* Guard check status */}
              {!result.guard.ok ? (
                <div className="p-3 rounded-md bg-amber-50 border border-amber-300 text-amber-950 text-xs space-y-1">
                  <div className="font-semibold flex items-center gap-1.5">
                    <AlertTriangle className="h-4 w-4 text-amber-700" />
                    含有無法對上系統結果的數字或引用
                  </div>
                  {result.guard.ungrounded_numbers.length > 0 && (
                    <div>
                      未對上的數字：
                      {result.guard.ungrounded_numbers.join("、")}
                    </div>
                  )}
                  {result.guard.unknown_cites.length > 0 && (
                    <div>
                      未知的事實編號：{result.guard.unknown_cites.join("、")}
                    </div>
                  )}
                </div>
              ) : (
                <div className="px-3 py-1.5 rounded-md bg-emerald-50 border border-emerald-200 text-emerald-900 text-xs flex items-center gap-1.5">
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-700" />
                  伺服器端事實核對通過（所有數字與引用皆可對應目前畫面事實）
                </div>
              )}

              {/* Summary */}
              <div className="p-3.5 rounded-md bg-slate-50 border border-slate-200">
                <div className="text-xs font-semibold text-slate-500 mb-1">
                  白話摘要
                </div>
                <p className="text-slate-900 leading-relaxed">{result.summary}</p>
              </div>

              {/* Observations */}
              {result.observations.length > 0 && (
                <div>
                  <div className="text-xs font-semibold text-slate-700 mb-1.5">
                    系統觀察到的現象
                  </div>
                  <ul className="space-y-2">
                    {result.observations.map((obs, idx) => (
                      <li
                        key={idx}
                        className="p-2.5 rounded-md border border-slate-200 bg-white text-slate-800 flex flex-col gap-1"
                      >
                        <span>{obs.text}</span>
                        <span className="text-[11px] font-mono-tabular text-[#0B63CE]">
                          依據：{obs.cites.length > 0 ? obs.cites.join(", ") : "未標註"}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Possible causes */}
              {result.possible_causes.length > 0 && (
                <div>
                  <div className="text-xs font-semibold text-slate-700 mb-1.5">
                    可能原因（常見原因，資料本身無法證實）
                  </div>
                  <ul className="space-y-1.5 list-disc list-inside text-slate-700">
                    {result.possible_causes.map((c, idx) => (
                      <li key={idx}>
                        {c.text}
                        {c.cites.length > 0 && (
                          <span className="ml-1.5 text-[11px] font-mono-tabular text-slate-500">
                            （依據：{c.cites.join(", ")}）
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Cannot conclude */}
              {result.cannot_conclude.length > 0 && (
                <div>
                  <div className="text-xs font-semibold text-slate-700 mb-1">
                    目前不能判斷的事
                  </div>
                  <ul className="space-y-1 list-disc list-inside text-slate-600 text-xs">
                    {result.cannot_conclude.map((item, idx) => (
                      <li key={idx}>{item}</li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Suggested checks */}
              {result.suggested_checks.length > 0 && (
                <div>
                  <div className="text-xs font-semibold text-slate-700 mb-1">
                    建議人工檢查項目（不自動控制設備）
                  </div>
                  <ul className="space-y-1 list-disc list-inside text-slate-700 text-xs">
                    {result.suggested_checks.map((item, idx) => (
                      <li key={idx}>{item}</li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Server disclaimers */}
              <div className="p-3 rounded-md bg-slate-100 border border-slate-200 text-xs text-slate-600 space-y-1">
                <div className="font-semibold text-slate-700">
                  系統強制附加限制與聲明
                </div>
                {result.disclaimers.map((d, idx) => (
                  <div key={idx}>• {d}</div>
                ))}
              </div>

              {/* Raw Facts reference */}
              <details className="text-xs border border-slate-200 rounded-md p-3">
                <summary className="cursor-pointer font-medium text-slate-700">
                  檢視傳給伺服器的事實清單（{payload.request.facts.length} 條）
                </summary>
                <div className="mt-2 space-y-1 font-mono-tabular text-slate-600">
                  {payload.request.facts.map((f) => (
                    <div key={f.id}>
                      [{f.id}] {f.text}
                      {f.value !== undefined ? ` = ${f.value}` : ""}
                      {f.unit ? ` ${f.unit}` : ""}
                    </div>
                  ))}
                </div>
              </details>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
