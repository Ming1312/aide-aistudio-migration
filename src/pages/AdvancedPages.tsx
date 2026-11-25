import React, { useEffect, useMemo, useState } from "react";
import {
  BookOpen,
  CheckCircle2,
  Compass,
  FileCheck2,
  GitBranch,
  Lock,
  ShieldAlert,
} from "lucide-react";
import { MODEL_ORDER } from "../../contracts/types";
import type {
  PrecomputedForecasts,
  Provenance,
  RealDataset,
} from "../../contracts/types";
import {
  loadDataUseStatement,
  loadProvenance,
} from "../lib/dataLoader";
import type { PageId } from "../types/app";

interface AdvancedPagesProps {
  page: Extract<
    PageId,
    | "catalog"
    | "provenance"
    | "guide"
    | "ai_overview"
    | "decision_guide"
    | "model_performance"
    | "team_review"
  >;
  datasets: RealDataset[];
  precomputedForecasts: PrecomputedForecasts | null;
  onSelectDomainAndNavigate: (id: string, page: PageId) => void;
}

export const AdvancedPages: React.FC<AdvancedPagesProps> = ({
  page,
  datasets,
  precomputedForecasts,
  onSelectDomainAndNavigate,
}) => {
  const [provenance, setProvenance] = useState<Provenance | null>(null);
  const [statementMd, setStatementMd] = useState<string>("");

  useEffect(() => {
    if (page === "provenance") {
      loadProvenance().then(setProvenance).catch(() => {});
      loadDataUseStatement().then(setStatementMd).catch(() => {});
    }
  }, [page]);

  const perfSummaryRows = useMemo(() => {
    if (!precomputedForecasts) return [];
    return Object.entries(precomputedForecasts.tasks).map(([taskId, t]) => {
      const bestBaseMae = t.metrics[t.best_baseline]?.holdout?.MAE ?? null;
      const hgbHoldMae = t.metrics.HGB?.holdout?.MAE ?? null;
      const xgbHoldMae = t.metrics.XGB?.holdout?.MAE ?? null;
      const bestMl =
        hgbHoldMae !== null && xgbHoldMae !== null
          ? hgbHoldMae <= xgbHoldMae
            ? { name: "HGB", mae: hgbHoldMae }
            : { name: "XGB", mae: xgbHoldMae }
          : null;
      return {
        taskId,
        datasetId: t.dataset_id,
        sensor: t.sensor,
        horizonH: t.horizon_h,
        unit: t.unit,
        bestBaseline: t.best_baseline,
        bestBaseMae,
        bestMl,
        hasExploratorySignal:
          t.evidence.HGB.includes("探索性訊號") ||
          t.evidence.XGB.includes("探索性訊號"),
      };
    });
  }, [precomputedForecasts]);

  if (page === "provenance") {
    return (
      <div className="space-y-6">
        <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-3">
          <h1 className="text-xl font-bold text-slate-900 flex items-center gap-2">
            <FileCheck2 className="h-5 w-5 text-[#0B63CE]" />
            資料來源與使用聲明（真實感測資料）
          </h1>
          <div className="p-3.5 rounded-md bg-blue-50 border border-blue-200 text-xs text-blue-950 space-y-1">
            <div>
              <strong>資料提供者：</strong>
              {provenance?.source.provider ?? "銘祥科技"}（
              {provenance?.source.programme ??
                "2026 全國 AI 專題創意競賽 AIoT 感測資料"}
              ）
            </div>
            <div>
              <strong>來源管道：</strong>
              {provenance?.source.url_status ?? "競賽方提供／無公開下載網址"}
            </div>
            <div>
              <strong>證據狀態：</strong>
              <code className="font-mono-tabular bg-blue-100 px-1.5 py-0.5 rounded">
                {provenance?.license.evidence_status ?? "user_attestation_only"}
              </code>
              （{provenance?.license.summary ?? "使用者確認上述專題用途可以使用；沒有外部證明文件。"}）
            </div>
          </div>
        </section>

        {/* Two-column strict separation: Confirmed by User vs Not Provided */}
        <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="bg-white border border-emerald-200 rounded-lg p-5 space-y-3">
            <h2 className="text-base font-bold text-emerald-900 flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-emerald-700" />
              已由使用者確認
            </h2>
            <p className="text-xs text-slate-600">
              確認者：{provenance?.attestation.attested_by ?? "專案使用者"}（
              {provenance?.attestation.attested_on ?? "2026-11-20"}）｜聲明依據：
              {provenance?.attestation.scope_basis ?? "本競賽專題"}
            </p>
            <ul className="space-y-2 text-xs text-slate-800 list-disc list-inside">
              {(provenance?.confirmed_by_user ?? []).map((item, idx) => (
                <li key={idx}>{item}</li>
              ))}
            </ul>
            <div className="pt-2 border-t border-slate-100 text-xs text-slate-600">
              涵蓋用途：{(provenance?.attestation.scope_uses ?? []).join("、")}
            </div>
          </div>

          <div className="bg-white border border-amber-300 rounded-lg p-5 space-y-3">
            <h2 className="text-base font-bold text-amber-950 flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-amber-700" />
              尚未提供的外部證明文件
            </h2>
            <p className="text-xs text-amber-900">
              以下文件目前並未附於本專案，網站不會假稱擁有任何外部書面文件或公開條款：
            </p>
            <ul className="space-y-2 text-xs text-slate-800 list-disc list-inside">
              {(provenance?.not_provided ?? []).map((item, idx) => (
                <li key={idx}>{item}</li>
              ))}
            </ul>
          </div>
        </section>

        {/* Remaining items & Per-dataset hashes */}
        {provenance && (
          <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
            <h2 className="text-base font-semibold text-slate-900">
              待確認事項與七場域檔案摘要
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
              {provenance.remaining_items.map((r, i) => (
                <div
                  key={i}
                  className="p-3 rounded border border-slate-200 bg-slate-50 space-y-1"
                >
                  <div className="font-semibold text-slate-900">{r.item}</div>
                  <div className="text-slate-600">影響：{r.effect}</div>
                </div>
              ))}
            </div>

            <div className="overflow-x-auto border border-slate-200 rounded-md">
              <table className="min-w-full text-xs border-collapse">
                <thead className="bg-slate-50 border-b border-slate-200 text-slate-700">
                  <tr>
                    <th className="px-3 py-2 text-left font-semibold">場域</th>
                    <th className="px-3 py-2 text-right font-semibold">列數</th>
                    <th className="px-3 py-2 text-left font-semibold">期間</th>
                    <th className="px-3 py-2 text-left font-semibold">個資自動掃描</th>
                    <th className="px-3 py-2 text-left font-semibold">原檔 SHA-256 前綴</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {Object.entries(provenance.datasets).map(([id, info]) => (
                    <tr key={id}>
                      <td className="px-3 py-2 font-medium text-slate-900">
                        {info.display_name}
                      </td>
                      <td className="px-3 py-2 text-right font-mono-tabular">
                        {info.rows}
                      </td>
                      <td className="px-3 py-2 font-mono-tabular text-slate-600">
                        {info.start.slice(0, 10)} ～ {info.end.slice(0, 10)}
                      </td>
                      <td className="px-3 py-2 text-slate-600">
                        {info.personal_data_check.findings} 項（人工確認：
                        {info.personal_data_check.checked_by_human ? "是" : "尚未"}）
                      </td>
                      <td className="px-3 py-2 font-mono-tabular text-slate-500">
                        {info.original_sha256.slice(0, 16)}…
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {statementMd && (
          <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-2">
            <h2 className="text-sm font-semibold text-slate-800">
              DATA_USE_STATEMENT 原文
            </h2>
            <pre className="whitespace-pre-wrap text-xs text-slate-700 bg-slate-50 border border-slate-200 rounded p-4 font-sans leading-relaxed">
              {statementMd}
            </pre>
          </section>
        )}
      </div>
    );
  }

  if (page === "catalog") {
    return (
      <div className="space-y-6">
        <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
          <div>
            <h1 className="text-xl font-bold text-slate-900 flex items-center gap-2">
              <Compass className="h-5 w-5 text-[#0B63CE]" />
              場域目錄（七場域資料盤點）
            </h1>
            <p className="text-xs text-slate-600 mt-1">
              包含七個場域的取樣頻率、時間缺口、感測欄位數量、預測資格與不可用原因（真實資料 `__real=1`）。
            </p>
          </div>

          <div className="overflow-x-auto border border-slate-200 rounded-md">
            <table className="min-w-full text-xs border-collapse">
              <thead className="bg-slate-50 border-b border-slate-200 text-slate-700">
                <tr>
                  <th className="px-3 py-2 text-left font-semibold">場域名稱</th>
                  <th className="px-3 py-2 text-left font-semibold">類型</th>
                  <th className="px-3 py-2 text-right font-semibold">列數 / 欄數</th>
                  <th className="px-3 py-2 text-left font-semibold">資料期間（未標時區）</th>
                  <th className="px-3 py-2 text-left font-semibold">預測任務與限制</th>
                  <th className="px-3 py-2 text-right font-semibold">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {datasets.map((ds) => {
                  const enabledTasks = ds.forecast_tasks.filter((t) => t.enabled);
                  return (
                    <tr key={ds.id} className="hover:bg-slate-50/70">
                      <td className="px-3 py-2.5 font-semibold text-slate-900">
                        {ds.display_name}
                      </td>
                      <td className="px-3 py-2.5 text-slate-600">{ds.domain_type}</td>
                      <td className="px-3 py-2.5 text-right font-mono-tabular">
                        {ds.time.rows} / {ds.columns.length}
                      </td>
                      <td className="px-3 py-2.5 font-mono-tabular text-slate-600">
                        {ds.time.start.slice(0, 10)} ～ {ds.time.end.slice(0, 10)}
                        <div className="text-[11px] text-slate-400">
                          缺口 {ds.time.n_gaps ?? 0} 段（最長 {ds.time.longest_gap_hours ?? 0}h）
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-slate-700">
                        {ds.id === "rearing_plant_1_north" ? (
                          <span className="text-rose-700 font-medium">
                            0 任務（資料太少、連續區段短，系統不建立模型）
                          </span>
                        ) : (
                          <span>{enabledTasks.length} 項預計算任務可用（1h/3h/6h）</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right space-x-2">
                        <button
                          type="button"
                          onClick={() =>
                            onSelectDomainAndNavigate(ds.id, "domain_home")
                          }
                          className="text-[#0B63CE] font-semibold hover:underline"
                        >
                          看板
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            onSelectDomainAndNavigate(ds.id, "explorer")
                          }
                          className="text-slate-700 font-medium hover:underline"
                        >
                          探索
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    );
  }

  if (page === "guide") {
    const steps = [
      {
        n: "步驟 1",
        title: "分辨真實資料與合成展示資料",
        body: "側邊欄與頁首橫幅會常駐標示目前所在的資料類型：藍色為「真實感測資料（__real=1）」；橘色為「合成展示資料（__synthetic=1）」，兩者永遠不在同一張圖表、下載檔或 Gemini 事實清單中混用。",
      },
      {
        n: "步驟 2",
        title: "從總覽檢查七個場域",
        body: "進入「總覽」後可按下「檢查所有場域」，系統會逐一掃描 7 個場域並列出需要人工確認的候選事件（包含發生什麼／可能原因／建議怎麼做／資料依據）。",
      },
      {
        n: "步驟 3",
        title: "探索原始數據與時間缺口",
        body: "在「場域看板」或「資料探索與分析」中，可自由挑選感測器、區間、日週期、直方圖與相關矩陣，並下載完整未經竄改的原始 CSV。",
      },
      {
        n: "步驟 4",
        title: "檢視離線預計算預測與決策輔助",
        body: "在「場域看板」與「決策輔助」可比較 6 種模型的驗證／留存期表現，以及三層分開的建議（一般建議、需要人工確認的異常、僅限羊舍的正式風險決策）。",
      },
      {
        n: "步驟 5",
        title: "使用 Gemini 有根據的白話解釋",
        body: "按下「用白話解釋」時，伺服器只把畫面上已算出的事實清單送給 Gemini，並逐筆核對數字與引用編號；若 Gemini 連線失敗或核對未過，系統自動退回規則層原文。",
      },
    ];

    return (
      <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
        <h1 className="text-xl font-bold text-slate-900 flex items-center gap-2">
          <BookOpen className="h-5 w-5 text-[#0B63CE]" />
          導覽簡介（五步驟認識平台）
        </h1>
        <div className="space-y-3">
          {steps.map((s) => (
            <div
              key={s.n}
              className="p-4 rounded-md border border-slate-200 bg-slate-50 space-y-1"
            >
              <div className="text-xs font-semibold text-[#0B63CE]">{s.n}</div>
              <div className="text-sm font-bold text-slate-900">{s.title}</div>
              <p className="text-xs text-slate-700 leading-relaxed">{s.body}</p>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (page === "ai_overview") {
    return (
      <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-4 text-xs text-slate-700 leading-relaxed">
        <h1 className="text-xl font-bold text-slate-900 flex items-center gap-2">
          <GitBranch className="h-5 w-5 text-[#0B63CE]" />
          AI 研究總覽
        </h1>
        <p>
          本平台在六個具備足夠連續時段的場域（共 90 個「感測器 × 1/3/6 小時」預測任務）上，嚴格區分訓練期、驗證期與留存測試期（Holdout），將 HGB 與 XGBoost 與四種無學習門檻的簡單基準（Persistence、Moving Average、Seasonal Naive 24h、Linear AR4）並排比較。
        </p>
        <div className="p-3.5 rounded border border-slate-200 bg-slate-50 space-y-1">
          <div className="font-semibold text-slate-900">關鍵研究原則</div>
          <div>• 拒絕補值與借用：資料不足或季節性條件未通過的模型直接回傳拒絕原因（refused），不硬湊數字。</div>
          <div>• 探索性定位：同時比較多組任務時部分優勢可能為偶然，必須經過獨立前瞻驗證才可宣稱效能。</div>
          <div>• 育成一廠北側因僅約 387 列且斷裂極長（最長缺口 1,597 小時），明確拒絕建模。</div>
        </div>
      </div>
    );
  }

  if (page === "decision_guide") {
    return (
      <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-4 text-xs text-slate-700 leading-relaxed">
        <h1 className="text-xl font-bold text-slate-900">決策支援說明</h1>
        <p>
          決策輔助頁強制將建議分為三層，避免把統計候選訊號誤當成設備故障或正式風險政策：
        </p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="p-3.5 rounded border border-amber-300 bg-amber-50">
            <div className="font-semibold text-amber-950">需要人工確認的異常</div>
            <p className="mt-1 text-amber-900">
              由統計偵測器或資料品質掃描產生，永遠標示「候選事件，不是故障判定」，可信程度上限為 medium。
            </p>
          </div>
          <div className="p-3.5 rounded border border-slate-200 bg-slate-50">
            <div className="font-semibold text-slate-900">一般建議</div>
            <p className="mt-1">
              彙整資料覆蓋率、缺漏情況與預測模型相對基準的表現，協助人員決定是否繼續觀察或對照簡單基準。
            </p>
          </div>
          <div className="p-3.5 rounded border border-blue-200 bg-blue-50">
            <div className="font-semibold text-blue-950">正式風險決策（僅羊舍）</div>
            <p className="mt-1 text-blue-900">
              原樣引用已凍結之 Phase 2.6 羊舍 THI 模型回放，目前門檻 84 為候選值且尚未經確認，系統不控制任何設備。
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (page === "model_performance") {
    return (
      <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900">
            多模型表現彙總（來自離線預計算 metrics）
          </h1>
          <p className="text-xs text-slate-600 mt-1">
            下列數值直接彙整自 <code className="font-mono-tabular">forecasts.json</code>（共{" "}
            {perfSummaryRows.length} 個任務；預計算於{" "}
            <span className="font-mono-tabular">
              {precomputedForecasts?.meta.generated_at ?? "-"}
            </span>
            ）。驗證與留存測試僅為歷史回測，不是前瞻獨立驗證。
          </p>
        </div>

        <div className="overflow-x-auto border border-slate-200 rounded-md max-h-[60vh]">
          <table className="min-w-full text-xs border-collapse">
            <thead className="sticky top-0 bg-slate-50 border-b border-slate-200 text-slate-700">
              <tr>
                <th className="px-3 py-2 text-left font-semibold">任務 ID</th>
                <th className="px-3 py-2 text-left font-semibold">最佳簡單基準</th>
                <th className="px-3 py-2 text-right font-semibold">基準留存 MAE</th>
                <th className="px-3 py-2 text-left font-semibold">最佳 ML</th>
                <th className="px-3 py-2 text-right font-semibold">ML 留存 MAE</th>
                <th className="px-3 py-2 text-left font-semibold">探索性訊號</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 font-mono-tabular">
              {perfSummaryRows.map((row) => (
                <tr key={row.taskId} className="hover:bg-slate-50/70">
                  <td className="px-3 py-2 font-sans font-medium text-slate-900">
                    {row.taskId}
                  </td>
                  <td className="px-3 py-2 font-sans text-slate-700">
                    {row.bestBaseline}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {row.bestBaseMae !== null ? row.bestBaseMae.toFixed(4) : "—"}
                  </td>
                  <td className="px-3 py-2 font-sans text-slate-700">
                    {row.bestMl?.name ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {row.bestMl ? row.bestMl.mae.toFixed(4) : "—"}
                  </td>
                  <td className="px-3 py-2 font-sans">
                    {row.hasExploratorySignal ? (
                      <span className="text-[#0B63CE] font-medium">達條件（探索性）</span>
                    ) : (
                      <span className="text-slate-500">證據不足</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="text-[11px] text-slate-500">
          並排比較模型清單：{MODEL_ORDER.join("、")}。
        </div>
      </div>
    );
  }

  // team_review
  return (
    <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-xl font-bold text-slate-900">組員審查紀錄</h1>
        <span className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded border border-slate-200 bg-slate-50 text-slate-600">
          <Lock className="h-3.5 w-3.5" />
          M1 階段停用
        </span>
      </div>
      <p className="text-xs text-slate-600">
        組員審查紀錄需透過具備持久化與敏感個資攔截的伺服器端審查端點（M5）；在未連線狀態下維持停用與唯讀，不保留未驗證表單。
      </p>
      <button
        type="button"
        disabled
        className="px-3.5 py-2 rounded-md bg-slate-200 text-slate-500 text-xs font-medium cursor-not-allowed"
      >
        新增審查意見（需要 Python 引擎）
      </button>
    </div>
  );
};
