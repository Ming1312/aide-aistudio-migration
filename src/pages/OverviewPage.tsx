import React, { useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock,
  HelpCircle,
  Play,
  RefreshCw,
} from "lucide-react";
import type {
  AnomaliesResponse,
  RealDataset,
} from "../../contracts/types";
import { fetchOverviewStatus, loadRealCsv } from "../lib/dataLoader";
import {
  formatOverviewColumnsPreview,
  formatOverviewKindsSummary,
} from "../lib/overviewFormat";
import type {
  CheckedDomainSummary,
  OverviewStatusResponse,
  OverviewWindowHours,
  PageId,
} from "../types/app";

interface OverviewPageProps {
  datasets: RealDataset[];
  anomaliesMap: Record<string, AnomaliesResponse>;
  checkedDomains: Record<string, CheckedDomainSummary>;
  overviewStatus: OverviewStatusResponse | null;
  overviewWindowHours: OverviewWindowHours;
  onUpdateOverviewStatus: (status: OverviewStatusResponse) => void;
  onChangeOverviewWindowHours: (hours: OverviewWindowHours) => void;
  onUpdateCheckedDomain: (id: string, summary: CheckedDomainSummary) => void;
  onSelectDomainAndNavigate: (id: string, page: PageId) => void;
}

const WINDOW_OPTIONS: OverviewWindowHours[] = [24, 72, 168];

function getCommonCauseHint(kind: string): string {
  switch (kind) {
    case "drift_or_offset":
      return "常見可能原因：感測器零點隨時間緩慢偏移、探頭附著髒污或結垢，或是現場局部環境條件與其他感測器出現真實差異（資料本身無法證實）。";
    case "stuck_value":
    case "stuck_sensor":
    case "flatline":
      return "常見可能原因：通訊模組暫時重傳最後一筆讀值、感測器取樣停滯，或是當下環境確實維持長時間穩定（資料本身無法證實）。";
    case "out_of_historical_range":
      return "常見可能原因：短時極端天氣／現場作業變化、採樣雜訊突波，或量測尺度異常（資料本身無法證實）。";
    default:
      return "常見可能原因：現場環境劇烈變化、量測元件偏移或資料傳輸中斷，需由現場人員對照作業紀錄確認（資料本身無法證實）。";
  }
}

export const OverviewPage: React.FC<OverviewPageProps> = ({
  datasets,
  anomaliesMap,
  checkedDomains,
  overviewStatus,
  overviewWindowHours,
  onUpdateOverviewStatus,
  onChangeOverviewWindowHours,
  onUpdateCheckedDomain,
  onSelectDomainAndNavigate,
}) => {
  const [checking, setChecking] = useState(false);
  const [windowSwitching, setWindowSwitching] = useState(false);
  const [progressIdx, setProgressIdx] = useState(0);
  const [progressName, setProgressName] = useState("");
  const [elapsedSec, setElapsedSec] = useState(0);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [windowError, setWindowError] = useState<string | null>(null);

  const handleCheckAllDomains = async () => {
    if (checking || datasets.length === 0) return;
    setChecking(true);
    setCheckError(null);
    setWindowError(null);
    setElapsedSec(0);
    const startMs = Date.now();
    const timer = window.setInterval(() => {
      setElapsedSec(Number(((Date.now() - startMs) / 1000).toFixed(1)));
    }, 100);

    try {
      for (let i = 0; i < datasets.length; i += 1) {
        const ds = datasets[i];
        setProgressIdx(i + 1);
        setProgressName(ds.display_name);

        const parsed = await loadRealCsv(ds.id);
        let totalCells = 0;
        let missingCells = 0;
        for (const row of parsed.rows) {
          for (const s of parsed.sensorHeaders) {
            totalCells += 1;
            if (row.values[s] === null || row.values[s] === undefined) {
              missingCells += 1;
            }
          }
        }
        const missingRatePct =
          totalCells > 0 ? (missingCells / totalCells) * 100 : 0;
        const anom = anomaliesMap[ds.id];
        const nAnomalies = anom?.n_events ?? 0;
        const nTasks = ds.forecast_tasks.filter((t) => t.enabled).length;
        const latestTs =
          parsed.rows[parsed.rows.length - 1]?.timestamp ?? ds.time.end;

        onUpdateCheckedDomain(`real:${ds.id}`, {
          datasetId: ds.id,
          checkedAt: new Date().toLocaleTimeString("zh-Hant", {
            hour12: false,
          }),
          rows: parsed.rows.length,
          missingRatePct,
          nAnomalies,
          nTasks,
          latestTimestamp: latestTs,
          statusLabel: "已檢查",
        });
      }

      const statusRes = await fetchOverviewStatus(overviewWindowHours);
      onUpdateOverviewStatus(statusRes);

      setElapsedSec(Number(((Date.now() - startMs) / 1000).toFixed(1)));
    } catch (err) {
      setCheckError(err instanceof Error ? err.message : "檢查過程發生錯誤");
    } finally {
      window.clearInterval(timer);
      setChecking(false);
    }
  };

  const handleSwitchWindow = async (nextHours: OverviewWindowHours) => {
    if (windowSwitching || checking) return;
    setWindowError(null);
    onChangeOverviewWindowHours(nextHours);
    setWindowSwitching(true);
    try {
      const statusRes = await fetchOverviewStatus(nextHours);
      onUpdateOverviewStatus(statusRes);
    } catch (err) {
      setWindowError(
        err instanceof Error ? err.message : "切換時間範圍失敗"
      );
    } finally {
      setWindowSwitching(false);
    }
  };

  const attentionItems = useMemo(() => {
    const list: Array<{
      datasetId: string;
      datasetName: string;
      kindZh: string;
      kind: string;
      column: string;
      start: string;
      end: string;
      hours: number;
      score: number;
      note: string;
    }> = [];
    for (const ds of datasets) {
      const anom = anomaliesMap[ds.id];
      if (!anom) continue;
      for (const ev of anom.events.slice(0, 2)) {
        list.push({
          datasetId: ds.id,
          datasetName: ds.display_name,
          kindZh: ev.kind_zh,
          kind: ev.kind,
          column: ev.column,
          start: ev.start,
          end: ev.end,
          hours: ev.hours,
          score: ev.score,
          note: ev.note,
        });
      }
    }
    return list;
  }, [datasets, anomaliesMap]);

  return (
    <div className="space-y-6 min-w-0">
      {/* Page Header & Action Bar */}
      <div className="bg-white border border-slate-200 rounded-lg p-4 sm:p-5 flex flex-wrap items-center justify-between gap-4 min-w-0">
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-slate-900">
            七場域環境監測總覽
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            目前檢視「真實感測資料」（7 個場域）。未執行檢查前各場域維持「尚未檢查」狀態，不顯示任何結論；不代表設備正常。
          </p>
        </div>

        <button
          type="button"
          onClick={handleCheckAllDomains}
          disabled={checking || datasets.length === 0}
          className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-md bg-[#0B63CE] text-white text-sm font-medium hover:bg-[#0952AD] disabled:opacity-60 w-full sm:w-auto shrink-0"
        >
          {checking ? (
            <>
              <RefreshCw className="h-4 w-4 animate-spin" />
              檢查中…
            </>
          ) : (
            <>
              <Play className="h-4 w-4" />
              檢查所有場域（7 場域）
            </>
          )}
        </button>
      </div>

      {/* Sequential Progress Bar */}
      {(checking || elapsedSec > 0 || checkError) && (
        <div className="bg-white border border-slate-200 rounded-lg p-4 space-y-2 min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="font-medium text-slate-800">
              {checking
                ? `正在檢查「${progressName}」（${progressIdx}／${datasets.length}）…`
                : checkError
                ? "檢查未完成"
                : `已完成全部 ${datasets.length} 個場域檢查`}
            </span>
            <span className="font-mono-tabular text-slate-500 inline-flex items-center gap-1">
              <Clock className="h-3.5 w-3.5" />
              已花時間：{elapsedSec.toFixed(1)} 秒
            </span>
          </div>
          <div className="h-2 w-full bg-slate-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-[#0B63CE] transition-all duration-200"
              style={{
                width: `${
                  datasets.length > 0
                    ? Math.round(
                        ((checking ? progressIdx : datasets.length) /
                          datasets.length) *
                          100
                      )
                    : 0
                }%`,
              }}
            />
          </div>
          {checkError && (
            <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded px-2.5 py-1.5 break-words">
              {checkError}
            </div>
          )}
        </div>
      )}

      {/* Checked Overview Summary + Window Switcher (Real mode after checking) */}
      {overviewStatus && (
        <section
          aria-label="檢查結果摘要與時間範圍"
          className="bg-white border border-slate-200 rounded-lg p-4 sm:p-5 space-y-3 min-w-0"
        >
          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3 min-w-0">
            <div className="space-y-1 min-w-0">
              <div
                data-testid="overview-summary-text"
                className="text-sm sm:text-base font-semibold text-slate-900 break-words"
              >
                有狀況 {overviewStatus.summary.has_issue} 個、近期未發現{" "}
                {overviewStatus.summary.none_recent} 個（時間範圍：資料最後一筆往前{" "}
                {overviewStatus.window_hours} 小時）
              </div>
              <div className="text-xs text-slate-600">
                不代表設備正常：系統沒有經驗證的門檻，不判斷『正常』。
              </div>
            </div>

            <div className="flex flex-col sm:flex-row sm:items-center gap-2 min-w-0 shrink-0">
              <div
                role="group"
                aria-label="時間範圍切換"
                className="inline-flex flex-wrap items-center gap-1.5"
              >
                {WINDOW_OPTIONS.map((win) => {
                  const active = overviewWindowHours === win;
                  return (
                    <button
                      key={win}
                      type="button"
                      aria-pressed={active}
                      disabled={windowSwitching || checking}
                      onClick={() => handleSwitchWindow(win)}
                      className={`px-3 py-1.5 rounded-md text-xs font-medium border transition-colors ${
                        active
                          ? "bg-[#0B63CE] text-white border-[#0B63CE]"
                          : "bg-white text-slate-700 border-slate-300 hover:bg-slate-50"
                      } disabled:opacity-60`}
                    >
                      {win} 小時
                    </button>
                  );
                })}
              </div>
              <span className="text-[11px] text-slate-500">
                以各場域資料最後一筆為基準；時間範圍是呈現選擇，不是門檻
              </span>
            </div>
          </div>

          {windowSwitching && (
            <div className="text-xs text-slate-500 inline-flex items-center gap-1.5">
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              正在更新時間範圍檢視…
            </div>
          )}

          {windowError && (
            <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded px-2.5 py-1.5 break-words">
              {windowError}
            </div>
          )}
        </section>
      )}

      {/* 7 Domain Cards Grid */}
      <section aria-label="七場域摘要卡片" className="min-w-0">
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 min-w-0">
          {datasets.map((ds) => {
            const cacheKey = `real:${ds.id}`;
            const checked = checkedDomains[cacheKey];
            const domainStatus = overviewStatus?.datasets?.[ds.id];
            const anom = anomaliesMap[ds.id];
            const enabledTasks = ds.forecast_tasks.filter((t) => t.enabled).length;
            const meanMissing =
              ds.columns.length > 0
                ? (ds.columns.reduce((acc, c) => acc + (c.missing_frac ?? 0), 0) /
                    ds.columns.length) *
                  100
                : 0;

            const kindBadges = domainStatus
              ? formatOverviewKindsSummary(domainStatus.kinds)
              : [];
            const columnPreview = domainStatus
              ? formatOverviewColumnsPreview(domainStatus.columns, 4)
              : "";

            const isChecked = Boolean(domainStatus);

            return (
              <article
                key={ds.id}
                data-domain-card={ds.id}
                className="bg-white border border-slate-200 rounded-lg p-4 flex flex-col justify-between gap-3 hover:border-slate-300 transition-colors min-w-0"
              >
                <div className="space-y-2.5 min-w-0">
                  <div className="flex items-start justify-between gap-2 min-w-0">
                    <div className="min-w-0">
                      <h2 className="text-base font-semibold text-slate-900 break-words">
                        {ds.display_name}
                      </h2>
                      <div className="text-xs text-slate-500 mt-0.5 break-all">
                        {ds.domain_type} · {ds.id}
                      </div>
                    </div>
                    {isChecked ? (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-slate-700 shrink-0">
                        <CheckCircle2 className="h-3.5 w-3.5 text-[#0B63CE]" />
                        已檢查{checked ? ` (${checked.checkedAt})` : ""}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 shrink-0">
                        <HelpCircle className="h-3.5 w-3.5" />
                        尚未檢查
                      </span>
                    )}
                  </div>

                  {ds.id === "rearing_plant_1_north" && (
                    <div>
                      <span className="inline-block text-[11px] font-medium px-2 py-0.5 rounded bg-slate-100 text-slate-700 border border-slate-300">
                        此場域不提供預測（資料不足）
                      </span>
                    </div>
                  )}

                  <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs pt-2 border-t border-slate-100 min-w-0">
                    <div className="min-w-0">
                      <dt className="text-slate-500">資料期間（未標時區）</dt>
                      <dd className="font-mono-tabular text-slate-800 mt-0.5 break-words">
                        {ds.time.start.slice(0, 10)} ～ {ds.time.end.slice(0, 10)}
                      </dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-slate-500">資料列數／感測器數</dt>
                      <dd className="font-mono-tabular text-slate-800 mt-0.5">
                        {ds.time.rows} 列 · {ds.columns.length} 欄
                      </dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-slate-500">平均缺值率／時間缺口</dt>
                      <dd className="font-mono-tabular text-slate-800 mt-0.5">
                        {(checked ? checked.missingRatePct : meanMissing).toFixed(1)}% ·{" "}
                        {ds.time.n_gaps ?? 0} 段
                      </dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-slate-500">預測任務／候選事件</dt>
                      <dd className="font-mono-tabular text-slate-800 mt-0.5">
                        {ds.id === "rearing_plant_1_north"
                          ? "0 任務（不建模型）"
                          : `${enabledTasks} 任務`}{" "}
                        · {anom?.n_events ?? 0} 候選
                      </dd>
                    </div>
                  </dl>

                  {/* Real mode status result block (ONLY rendered after clicking check) */}
                  {domainStatus && (
                    domainStatus.status === "has_issue" ? (
                      <div className="rounded-md bg-amber-50 border border-amber-200 p-3 space-y-1.5 text-xs text-amber-950 min-w-0">
                        <div className="font-semibold text-amber-900 break-words">
                          有狀況（最近 {domainStatus.window_hours} 小時有{" "}
                          {domainStatus.n_events} 筆候選事件，待人員確認）
                        </div>
                        {kindBadges.length > 0 && (
                          <div className="text-amber-900 break-words">
                            事件種類：{kindBadges.join("、")}
                          </div>
                        )}
                        {columnPreview && (
                          <div className="text-amber-900 break-words">
                            涉及感測器：{columnPreview}
                          </div>
                        )}
                        <div className="text-[11px] text-amber-800 pt-1 border-t border-amber-200/80">
                          不代表設備正常：系統沒有經驗證的門檻，不判斷『正常』
                        </div>
                      </div>
                    ) : (
                      <div className="rounded-md bg-emerald-50 border border-emerald-200 p-3 space-y-1.5 text-xs text-emerald-950 min-w-0">
                        <div className="font-semibold text-emerald-900">
                          近期未發現狀況
                        </div>
                        <div className="text-emerald-900 break-words">
                          最近 {domainStatus.window_hours} 小時沒有候選事件；歷史上共{" "}
                          {domainStatus.total_events} 筆（見決策輔助）
                        </div>
                        <div className="text-[11px] text-emerald-800 pt-1 border-t border-emerald-200/80">
                          不代表設備正常：系統沒有經驗證的門檻，不判斷『正常』
                        </div>
                      </div>
                    )
                  )}

                </div>

                <div className="pt-2 border-t border-slate-100 flex flex-wrap items-center justify-between gap-2 min-w-0">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => onSelectDomainAndNavigate(ds.id, "domain_home")}
                      className="inline-flex items-center gap-1 text-xs font-semibold text-[#0B63CE] hover:underline"
                    >
                      進入場域看板
                      <ArrowRight className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <div className="flex items-center gap-3 text-xs">
                    <button
                      type="button"
                      onClick={() =>
                        onSelectDomainAndNavigate(ds.id, "decision_support")
                      }
                      className="text-slate-600 hover:text-[#0B63CE] font-medium"
                    >
                      決策輔助
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        onSelectDomainAndNavigate(ds.id, "explorer")
                      }
                      className="text-slate-600 hover:text-[#0B63CE] font-medium"
                    >
                      探索資料
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      {/* 需要注意的事 */}
      <section className="bg-white border border-slate-200 rounded-lg p-4 sm:p-5 space-y-4 min-w-0">
        <div className="flex flex-wrap items-center justify-between gap-2 min-w-0">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-slate-900 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0" />
              <span>需要注意的事（候選事件摘要，不是故障判定）</span>
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              列舉各場域偵測器分數最高的候選事件，並拆分為「發生什麼／可能原因／建議怎麼做／資料依據」四段；所有候選皆需人工確認。
            </p>
          </div>
        </div>

        {attentionItems.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5 min-w-0">
            {attentionItems.map((item, idx) => (
              <div
                key={`${item.datasetId}-${idx}`}
                className="border border-slate-200 rounded-md p-3.5 bg-slate-50/70 space-y-2 text-xs min-w-0"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 min-w-0">
                  <button
                    type="button"
                    onClick={() =>
                      onSelectDomainAndNavigate(item.datasetId, "domain_home")
                    }
                    className="font-semibold text-sm text-[#0B63CE] hover:underline text-left break-words min-w-0"
                  >
                    {item.datasetName}
                  </button>
                  <span className="text-amber-800 font-medium shrink-0">
                    候選事件・{item.kindZh}
                  </span>
                </div>

                <div className="space-y-1.5 text-slate-700 leading-relaxed break-words">
                  <div>
                    <strong className="text-slate-900">發生什麼：</strong>
                    偵測器在「{item.column}」標出「{item.kindZh}」候選事件（
                    {item.note}）。這是候選，不是設備故障判定。
                  </div>
                  <div>
                    <strong className="text-slate-900">可能原因：</strong>
                    {getCommonCauseHint(item.kind)}
                  </div>
                  <div>
                    <strong className="text-slate-900">建議怎麼做：</strong>
                    請現場人員確認感測器來源與現場作業紀錄，並以人工複測對照（本系統不控制任何設備）。
                  </div>
                  <div className="font-mono-tabular text-slate-600 pt-1 border-t border-slate-200 break-words">
                    <strong className="text-slate-800 font-sans">
                      資料依據：
                    </strong>
                    感測器 {item.column} ｜ 起訖 {item.start} ～ {item.end} ｜
                    持續 {item.hours} 小時 ｜ 分數強度 {item.score.toFixed(2)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-xs text-slate-500 py-4">
            目前尚未載入候選事件或各場域無候選事件。
          </div>
        )}
      </section>
    </div>
  );
};
