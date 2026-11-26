import React from "react";
import { BarChart3, Gauge, LayoutDashboard, Lock, Settings, ShieldCheck, Unlock, UploadCloud } from "lucide-react";
import type { RealDataset } from "../../contracts/types";
import type { AdminRoleStatus, PageId } from "../types/app";

export const NAV_ITEMS: Array<{ id: PageId; label: string; icon: React.ReactNode; needsDomain: boolean }> = [
  { id: "overview", label: "總覽", icon: <LayoutDashboard className="h-5 w-5" />, needsDomain: false },
  { id: "data", label: "資料", icon: <BarChart3 className="h-5 w-5" />, needsDomain: true },
  { id: "decision", label: "決策", icon: <ShieldCheck className="h-5 w-5" />, needsDomain: true },
  { id: "import", label: "匯入", icon: <UploadCloud className="h-5 w-5" />, needsDomain: false },
  { id: "settings", label: "設定", icon: <Settings className="h-5 w-5" />, needsDomain: false },
];

export const PAGE_TITLE: Record<PageId, string> = {
  overview: "整體總覽",
  data: "資料狀況",
  decision: "決策",
  import: "資料匯入中心",
  settings: "設定",
};

interface LayoutProps {
  datasets: RealDataset[];
  datasetId: string;
  onChangeDataset: (id: string) => void;
  activePage: PageId;
  onNavigate: (page: PageId) => void;
  adminRole: AdminRoleStatus;
  onOpenAdmin: () => void;
  importCount: number;
  children: React.ReactNode;
}

export const Layout: React.FC<LayoutProps> = ({
  datasets,
  datasetId,
  onChangeDataset,
  activePage,
  onNavigate,
  adminRole,
  onOpenAdmin,
  importCount,
  children,
}) => {
  const needsDomain = NAV_ITEMS.find((n) => n.id === activePage)?.needsDomain ?? false;

  const navButton = (item: (typeof NAV_ITEMS)[number], vertical: boolean) => {
    const active = activePage === item.id;
    return (
      <button
        key={item.id}
        type="button"
        onClick={() => onNavigate(item.id)}
        aria-current={active ? "page" : undefined}
        data-testid={`nav-${item.id}`}
        className={
          vertical
            ? `w-full flex items-center gap-3 px-3.5 py-2.5 rounded-md text-sm transition-colors ${
                active ? "bg-[#0B63CE] text-white font-semibold" : "text-slate-700 hover:bg-slate-100"
              }`
            : `flex-1 flex flex-col items-center gap-0.5 py-2 text-[11px] ${active ? "text-[#0B63CE] font-semibold" : "text-slate-500"}`
        }
      >
        <span className="relative">
          {item.icon}
          {item.id === "import" && importCount > 0 && <span className="absolute -top-1 -right-2 h-2 w-2 rounded-full bg-emerald-500" aria-label="已有匯入資料" />}
        </span>
        {item.label}
      </button>
    );
  };

  return (
    <div className="min-h-screen flex bg-[#F5F7FA] text-slate-900">
      <aside className="hidden lg:flex flex-col w-52 shrink-0 sticky top-0 h-screen bg-white border-r border-slate-200">
        <div className="px-4 py-4 border-b border-slate-200 flex items-center gap-2">
          <Gauge className="h-5 w-5 text-[#0B63CE]" />
          <div className="text-sm font-bold tracking-tight">AIDE</div>
        </div>
        <nav className="flex-1 px-2.5 py-3 space-y-1" aria-label="主導覽">
          {NAV_ITEMS.map((n) => navButton(n, true))}
        </nav>
      </aside>

      <div className="flex-1 min-w-0 flex flex-col pb-16 lg:pb-0">
        <header className="sticky top-0 z-30 bg-white border-b border-slate-200">
          <div className="max-w-[1180px] mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <h1 className="text-base font-bold text-slate-900 whitespace-nowrap">{PAGE_TITLE[activePage]}</h1>
              {needsDomain && (
                <select
                  id="sidebar-dataset-select"
                  value={datasetId}
                  onChange={(e) => onChangeDataset(e.target.value)}
                  aria-label="場域"
                  className="min-w-0 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-800 focus:border-[#0B63CE] focus:outline-none"
                >
                  {datasets.map((ds) => (
                    <option key={ds.id} value={ds.id}>
                      {ds.display_name}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <button
              type="button"
              onClick={onOpenAdmin}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border text-xs font-medium ${
                adminRole.role === "admin"
                  ? "border-emerald-300 bg-emerald-50 text-emerald-800"
                  : adminRole.role === "demo_admin"
                    ? "border-violet-300 bg-violet-50 text-violet-800"
                    : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
              }`}
            >
              {adminRole.role === "viewer" ? <Lock className="h-3.5 w-3.5 text-slate-400" /> : <Unlock className="h-3.5 w-3.5" />}
              {adminRole.role === "admin" ? "管理者" : adminRole.role === "demo_admin" ? "展示管理者" : "唯讀"}
            </button>
          </div>
        </header>

        <main className="flex-1 min-w-0 max-w-[1180px] w-full mx-auto px-4 sm:px-6 py-4">{children}</main>
      </div>

      <nav className="lg:hidden fixed bottom-0 inset-x-0 z-40 bg-white border-t border-slate-200 flex" aria-label="主導覽（手機）">
        {NAV_ITEMS.map((n) => navButton(n, false))}
      </nav>
    </div>
  );
};
