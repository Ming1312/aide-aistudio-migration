import React, { useState } from "react";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  BookOpen,
  CheckCircle2,
  Compass,
  Database,
  FileCheck2,
  GitBranch,
  History,
  Layers,
  Lock,
  Menu,
  Radio,
  ShieldAlert,
  SlidersHorizontal,
  Sparkles,
  Stethoscope,
  Unlock,
  Wrench,
  X,
} from "lucide-react";
import type { DataKind, RealDataset } from "../../contracts/types";
import {
  getEffectiveBannerKind,
  isNavItemVisible,
  isRealOnlyGuardedPage,
} from "../lib/dataKindPolicy";
import type { LiveBannerKind } from "../lib/liveForecast";
import type {
  AdminRoleStatus,
  ApiHealthStatus,
  DomainSyntheticState,
  NavItem,
  PageId,
} from "../types/app";

export const NAV_ITEMS: NavItem[] = [
  { id: "overview", label: "總覽", tier: "daily" },
  { id: "domain_home", label: "場域看板", tier: "daily" },
  { id: "live_forecast", label: "即時預測", tier: "daily" },
  { id: "decision_support", label: "決策輔助", tier: "daily" },
  { id: "candidate_risk", label: "候選風險決策", tier: "daily" },
  { id: "data_update", label: "資料更新", tier: "daily", syntheticAllowed: true },
  { id: "explorer", label: "資料探索與分析", tier: "daily" },
  { id: "model_lifecycle", label: "模型維護", tier: "daily" },
  // 羊舍決策（僅 sheep_barn 顯示）
  { id: "sheep_risk", label: "風險評估", tier: "sheep" },
  { id: "sheep_actions", label: "處置決策", tier: "sheep" },
  { id: "sheep_diagnosis", label: "異常診斷", tier: "sheep" },
  { id: "sheep_forecast", label: "羊舍 AI 預測", tier: "sheep" },
  { id: "sheep_replay", label: "歷史回放", tier: "sheep" },
  // 進階研究
  { id: "catalog", label: "場域目錄", tier: "advanced" },
  { id: "provenance", label: "資料來源與使用聲明", tier: "advanced" },
  { id: "guide", label: "導覽簡介", tier: "advanced" },
  { id: "ai_overview", label: "AI 研究總覽", tier: "advanced" },
  { id: "decision_guide", label: "決策支援說明", tier: "advanced" },
  { id: "model_performance", label: "模型表現", tier: "advanced" },
  { id: "team_review", label: "組員審查", tier: "advanced" },
];

const NAV_ICONS: Record<PageId, React.ReactNode> = {
  overview: <Layers className="h-4 w-4" />,
  domain_home: <Activity className="h-4 w-4" />,
  live_forecast: <Radio className="h-4 w-4" />,
  decision_support: <Sparkles className="h-4 w-4" />,
  candidate_risk: <ShieldAlert className="h-4 w-4" />,
  data_update: <Database className="h-4 w-4" />,
  explorer: <BarChart3 className="h-4 w-4" />,
  model_lifecycle: <Wrench className="h-4 w-4" />,
  sheep_risk: <ShieldAlert className="h-4 w-4" />,
  sheep_actions: <SlidersHorizontal className="h-4 w-4" />,
  sheep_diagnosis: <Stethoscope className="h-4 w-4" />,
  sheep_forecast: <Activity className="h-4 w-4" />,
  sheep_replay: <History className="h-4 w-4" />,
  catalog: <Compass className="h-4 w-4" />,
  provenance: <FileCheck2 className="h-4 w-4" />,
  guide: <BookOpen className="h-4 w-4" />,
  ai_overview: <GitBranch className="h-4 w-4" />,
  decision_guide: <Compass className="h-4 w-4" />,
  model_performance: <BarChart3 className="h-4 w-4" />,
  team_review: <CheckCircle2 className="h-4 w-4" />,
};

interface LayoutProps {
  dataKind: DataKind;
  onChangeDataKind: (kind: DataKind) => void;
  datasets: RealDataset[];
  datasetId: string;
  onChangeDataset: (id: string) => void;
  activePage: PageId;
  onNavigate: (page: PageId) => void;
  health: ApiHealthStatus | null;
  adminRole: AdminRoleStatus;
  onOpenAdmin: () => void;
  syntheticState?: DomainSyntheticState;
  liveBannerKind?: LiveBannerKind;
  children: React.ReactNode;
}

export const Layout: React.FC<LayoutProps> = ({
  dataKind,
  onChangeDataKind,
  datasets,
  datasetId,
  onChangeDataset,
  activePage,
  onNavigate,
  health,
  adminRole,
  onOpenAdmin,
  syntheticState,
  liveBannerKind = "offline",
  children,
}) => {
  const [mobileOpen, setMobileOpen] = useState(false);

  const activeDataset = datasets.find((d) => d.id === datasetId);
  const isSheep = datasetId === "sheep_barn";

  // 橫幅永遠由「該頁內容的資料種類」決定，而非全域切換
  const effectiveBannerKind: DataKind =
    activePage === "live_forecast"
      ? liveBannerKind === "synthetic"
        ? "synthetic"
        : "real"
      : getEffectiveBannerKind(activePage, dataKind);
  const isBlockedRealOnlyInSynthetic =
    dataKind === "synthetic" && isRealOnlyGuardedPage(activePage);

  const currentSynthVersion =
    syntheticState?.versions[syntheticState.activeVersionIndex];

  const periodOrVersionLabel =
    activePage === "live_forecast"
      ? liveBannerKind === "synthetic"
        ? "即時預測資料流（合成模擬）"
        : liveBannerKind === "real"
          ? "即時預測資料流（真實匯入）"
          : "即時預測資料流（尚未連線）"
      : isBlockedRealOnlyInSynthetic
        ? "合成展示模式（此頁僅支援真實資料）"
        : effectiveBannerKind === "synthetic"
          ? currentSynthVersion
            ? `合成版本：${currentSynthVersion.version}（D1–D${currentSynthVersion.step}｜${currentSynthVersion.rowCount} 列）`
            : "合成展示版本（瀏覽器記憶體）"
          : activeDataset
            ? `真實資料期間：${activeDataset.time.start.slice(0, 10)} ～ ${activeDataset.time.end.slice(0, 10)}（${activeDataset.time.rows} 列）`
            : "載入中…";

  const handleSelectPage = (page: PageId) => {
    onNavigate(page);
    setMobileOpen(false);
  };

  const renderNavSection = (title: string, items: NavItem[]) => (
    <div className="mb-5">
      <div className="px-3 mb-1.5 text-[11px] font-semibold tracking-wider text-slate-400 uppercase">
        {title}
      </div>
      <div className="space-y-0.5">
        {items.map((item) => {
          const active = activePage === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => handleSelectPage(item.id)}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors text-left ${
                active
                  ? "bg-[#0B63CE] text-white font-medium"
                  : "text-slate-700 hover:bg-slate-100 hover:text-slate-900"
              }`}
            >
              <span className={active ? "text-white" : "text-slate-400"}>
                {NAV_ICONS[item.id]}
              </span>
              <span className="truncate">{item.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );

  const sidebarContent = (
    <div className="flex flex-col h-full bg-white border-r border-slate-200">
      <div className="px-4 py-4 border-b border-slate-200">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="text-sm font-bold text-slate-900 tracking-tight">
              AIDE 環境監測與決策平台
            </div>
            <div className="text-[11px] text-slate-500 mt-0.5">
              七場域感測・預計算與 Gemini 解釋
            </div>
          </div>
          <button
            type="button"
            onClick={() => setMobileOpen(false)}
            className="lg:hidden p-1.5 rounded-md text-slate-500 hover:bg-slate-100"
            aria-label="關閉選單"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* 資料類型常駐切換 */}
        <div className="mt-3.5">
          <div className="text-[11px] font-medium text-slate-500 mb-1.5">
            資料類型（嚴格分開）
          </div>
          <div className="grid grid-cols-2 gap-1 p-1 rounded-md bg-slate-100 border border-slate-200">
            <button
              type="button"
              onClick={() => onChangeDataKind("real")}
              className={`py-1.5 px-2 rounded text-xs font-semibold transition-colors ${
                dataKind === "real"
                  ? "bg-[#0B63CE] text-white shadow-xs"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              真實資料
            </button>
            <button
              type="button"
              onClick={() => onChangeDataKind("synthetic")}
              className={`py-1.5 px-2 rounded text-xs font-semibold transition-colors ${
                dataKind === "synthetic"
                  ? "bg-amber-600 text-white shadow-xs"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              合成展示
            </button>
          </div>
        </div>

        {/* 場域選擇 */}
        <div className="mt-3">
          <label
            htmlFor="sidebar-dataset-select"
            className="block text-[11px] font-medium text-slate-500 mb-1"
          >
            目前場域（7 場域）
          </label>
          <select
            id="sidebar-dataset-select"
            value={datasetId}
            onChange={(e) => onChangeDataset(e.target.value)}
            className="w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-800 focus:border-[#0B63CE] focus:outline-none"
          >
            {datasets.map((ds) => (
              <option key={ds.id} value={ds.id}>
                {ds.display_name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* 三層導覽 */}
      <nav className="flex-1 overflow-y-auto px-2.5 py-4" aria-label="主導覽">
        {renderNavSection(
          "日常使用",
          NAV_ITEMS.filter(
            (i) =>
              i.tier === "daily" &&
              isNavItemVisible(i.id, i.tier, dataKind, datasetId)
          )
        )}
        {isSheep &&
          dataKind === "real" &&
          renderNavSection(
            "羊舍決策（專屬）",
            NAV_ITEMS.filter((i) => i.tier === "sheep")
          )}
        {renderNavSection(
          "進階研究",
          NAV_ITEMS.filter(
            (i) =>
              i.tier === "advanced" &&
              isNavItemVisible(i.id, i.tier, dataKind, datasetId)
          )
        )}
      </nav>

      {/* 引擎與權限狀態摘要 */}
      <div className="px-3.5 py-3 border-t border-slate-200 bg-slate-50 text-xs text-slate-600 space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-slate-500">分析引擎</span>
          {health?.engine_connected ? (
            <span className="inline-flex items-center gap-1 font-medium text-emerald-700">
              <CheckCircle2 className="h-3.5 w-3.5" />
              引擎即時（唯讀）
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 font-medium text-slate-700">
              <Database className="h-3.5 w-3.5 text-slate-500" />
              離線預計算模式
            </span>
          )}
        </div>
        {health?.version_warning && health.warning_message && (
          <div className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1">
            {health.warning_message}
          </div>
        )}
        <div className="flex items-center justify-between gap-2">
          <span className="text-slate-500">權限狀態</span>
          <span className="font-medium text-slate-700">
            {adminRole.role === "admin" ? "管理者已解鎖" : "預設唯讀"}
          </span>
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen flex bg-[#F5F7FA] text-slate-900">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:block w-64 shrink-0 sticky top-0 h-screen">
        {sidebarContent}
      </aside>

      {/* Mobile Drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-slate-900/40"
            onClick={() => setMobileOpen(false)}
          />
          <div className="relative z-10 w-72 max-w-[85vw] h-full">
            {sidebarContent}
          </div>
        </div>
      )}

      {/* Main Content Column */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Top Context Header */}
        <header className="sticky top-0 z-30 bg-white border-b border-slate-200">
          <div className="max-w-[1180px] mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <button
                type="button"
                onClick={() => setMobileOpen(true)}
                className="lg:hidden p-1.5 -ml-1 rounded-md border border-slate-200 text-slate-700 hover:bg-slate-50"
                aria-label="開啟導覽選單"
              >
                <Menu className="h-4 w-4" />
              </button>
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-semibold text-slate-900 truncate">
                    {activeDataset?.display_name ?? datasetId}
                  </span>
                  <span className="text-slate-300 hidden sm:inline">/</span>
                  <span className="text-xs text-slate-500 font-mono-tabular truncate hidden sm:inline">
                    {periodOrVersionLabel}
                  </span>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => handleSelectPage("provenance")}
                className="hidden sm:inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-slate-200 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                <FileCheck2 className="h-3.5 w-3.5 text-[#0B63CE]" />
                資料來源與使用聲明
              </button>
              <button
                type="button"
                onClick={onOpenAdmin}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border text-xs font-medium transition-colors ${
                  adminRole.role === "admin"
                    ? "border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100"
                    : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                }`}
              >
                {adminRole.role === "admin" ? (
                  <>
                    <Unlock className="h-3.5 w-3.5" />
                    管理者模式
                  </>
                ) : (
                  <>
                    <Lock className="h-3.5 w-3.5 text-slate-400" />
                    唯讀
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Persistent Data-Kind Banner */}
          {activePage === "live_forecast" ? (
            liveBannerKind === "synthetic" ? (
              <div
                data-testid="live-header-banner"
                className="bg-amber-50 border-t border-b border-amber-300"
              >
                <div className="max-w-[1180px] mx-auto px-4 sm:px-6 py-2 flex flex-wrap items-center justify-between gap-2 text-xs text-amber-950">
                  <div className="flex items-start sm:items-center gap-2">
                    <AlertTriangle className="h-4 w-4 text-amber-700 shrink-0 mt-0.5 sm:mt-0" />
                    <span className="font-medium">
                      此頁是模擬資料流（合成）：不是真實資料；預測只是流程展示，不能代表真實世界
                    </span>
                  </div>
                </div>
              </div>
            ) : liveBannerKind === "real" ? (
              <div
                data-testid="live-header-banner"
                className="bg-[#EFF6FF] border-t border-b border-blue-200"
              >
                <div className="max-w-[1180px] mx-auto px-4 sm:px-6 py-2 flex flex-wrap items-center justify-between gap-2 text-xs text-blue-950">
                  <div className="flex items-start sm:items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-[#0B63CE] shrink-0 mt-0.5 sm:mt-0" />
                    <span>
                      <strong className="font-semibold">真實感測資料流</strong>
                      <span className="mx-1.5 text-blue-400">｜</span>
                      來源：真實匯入（研究預測・探索性，未經獨立前瞻驗證）
                    </span>
                  </div>
                </div>
              </div>
            ) : (
              <div
                data-testid="live-header-banner"
                className="bg-slate-100 border-t border-b border-slate-300"
              >
                <div className="max-w-[1180px] mx-auto px-4 sm:px-6 py-2 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-700">
                  <div className="flex items-start sm:items-center gap-2">
                    <Database className="h-4 w-4 text-slate-500 shrink-0 mt-0.5 sm:mt-0" />
                    <span>
                      即時預測資料流：僅接受 Python 引擎即時回應，不用離線預計算檔取代。
                    </span>
                  </div>
                </div>
              </div>
            )
          ) : effectiveBannerKind === "real" ? (
            <div className="bg-[#EFF6FF] border-t border-b border-blue-200">
              <div className="max-w-[1180px] mx-auto px-4 sm:px-6 py-2 flex flex-wrap items-center justify-between gap-2 text-xs text-blue-950">
                <div className="flex items-start sm:items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-[#0B63CE] shrink-0 mt-0.5 sm:mt-0" />
                  <span>
                    <strong className="font-semibold">真實感測資料</strong>
                    <span className="mx-1.5 text-blue-400">｜</span>
                    資料來源：銘祥科技提供的 2026 全國 AI 專題創意競賽 AIoT 感測資料（競賽方提供／無公開下載網址）
                    <span className="mx-1.5 text-blue-400">｜</span>
                    使用者已確認可公開展示（使用者聲明；無外部證明文件）
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => handleSelectPage("provenance")}
                  className="text-[#0B63CE] font-semibold hover:underline shrink-0"
                >
                  查看資料來源與使用聲明 →
                </button>
              </div>
            </div>
          ) : (
            <div className="bg-amber-50 border-t border-b border-amber-300">
              <div className="max-w-[1180px] mx-auto px-4 sm:px-6 py-2 flex flex-wrap items-center justify-between gap-2 text-xs text-amber-950">
                <div className="flex items-start sm:items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-amber-700 shrink-0 mt-0.5 sm:mt-0" />
                  <span>
                    <strong className="font-semibold">
                      合成（模擬）展示資料
                    </strong>
                    ：不是真實資料，不能用來證明任何模型在真實世界的表現。（每列皆標記{" "}
                    <code className="font-mono-tabular bg-amber-100 px-1 rounded">
                      __synthetic=1
                    </code>
                    ）
                  </span>
                </div>
                {activePage !== "data_update" && (
                  <button
                    type="button"
                    onClick={() => onChangeDataKind("real")}
                    className="text-amber-900 font-semibold hover:underline shrink-0"
                  >
                    切回真實資料 →
                  </button>
                )}
              </div>
            </div>
          )}
        </header>

        {/* Page Body */}
        <main className="flex-1 min-w-0 max-w-[1180px] w-full mx-auto px-4 sm:px-6 py-6">
          {children}
        </main>

        {/* Footer */}
        <footer className="border-t border-slate-200 bg-white mt-8">
          <div className="max-w-[1180px] mx-auto px-4 sm:px-6 py-4 text-xs text-slate-500 flex flex-wrap items-center justify-between gap-2">
            <div>
              AIDE 智慧環境監測與決策平台｜真實與合成資料嚴格分離｜時間戳記：未標示時區（本地時間）｜感測器單位為推測，尚未經資料提供者確認
            </div>
            <div>
              預計算結果為研究預測（探索性，未經獨立前瞻驗證）；系統不控制任何設備
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
};
