import React, { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AnomaliesResponse,
  PrecomputedForecasts,
  RealCatalog,
} from "../contracts/types";
import { AdminModal } from "./components/AdminModal";
import { ExplainModal } from "./components/ExplainModal";
import { Layout } from "./components/Layout";
import { PageErrorBoundary } from "./components/PageErrorBoundary";
import {
  fetchAdminRole,
  fetchApiHealth,
  loadPrecomputedAnomalies,
  loadPrecomputedForecasts,
  loadRealCatalog,
} from "./lib/dataLoader";
import { AdvancedPages } from "./pages/AdvancedPages";
import { DomainDecisionPages } from "./pages/DomainDecisionPages";
import { DecisionSupportPage } from "./pages/DecisionSupportPage";
import { DomainHomePage } from "./pages/DomainHomePage";
import { ExplorerPage } from "./pages/ExplorerPage";
import { LiveForecastPage } from "./pages/LiveForecastPage";
import { ModelLifecyclePage } from "./pages/ModelLifecyclePage";
import { OverviewPage } from "./pages/OverviewPage";
import type { LiveBannerKind } from "./lib/liveForecast";
import type {
  AdminRoleStatus,
  ApiHealthStatus,
  CheckedDomainSummary,
  ExplainModalPayload,
  OverviewStatusResponse,
  OverviewWindowHours,
  PageId,
} from "./types/app";

const VALID_PAGE_IDS = new Set<PageId>([
  "overview",
  "domain_home",
  "live_forecast",
  "decision_support",
  "explorer",
  "model_lifecycle",
  "decision_risk",
  "decision_actions",
  "decision_diagnosis",
  "decision_forecast",
  "decision_replay",
  "catalog",
  "provenance",
  "guide",
  "ai_overview",
  "decision_guide",
  "model_performance",
  "team_review",
]);

function readInitialRouteState(): {
  page: PageId;
  dataset: string | null;
} {
  if (typeof window === "undefined") {
    return { page: "overview", dataset: null };
  }
  const params = new URLSearchParams(window.location.search);
  const rawPage = params.get("page");
  const rawDataset = params.get("dataset");
  const page: PageId =
    rawPage && VALID_PAGE_IDS.has(rawPage as PageId)
      ? (rawPage as PageId)
      : "overview";
  return { page, dataset: rawDataset };
}

export const App: React.FC = () => {
  const [catalog, setCatalog] = useState<RealCatalog | null>(null);
  const [anomaliesMap, setAnomaliesMap] = useState<
    Record<string, AnomaliesResponse>
  >({});
  const [precomputedForecasts, setPrecomputedForecasts] =
    useState<PrecomputedForecasts | null>(null);
  const [health, setHealth] = useState<ApiHealthStatus | null>(null);
  const [adminRole, setAdminRole] = useState<AdminRoleStatus>({
    configured: false,
    role: "viewer",
  });
  const [bootLoading, setBootLoading] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);

  // App UI state
  const initialRoute = useMemo(() => readInitialRouteState(), []);
  const [datasetId, setDatasetId] = useState<string>(
    initialRoute.dataset || "sheep_barn"
  );
  const [activePage, setActivePage] = useState<PageId>(initialRoute.page);
  const [checkedDomains, setCheckedDomains] = useState<
    Record<string, CheckedDomainSummary>
  >({});
  const [overviewStatus, setOverviewStatus] =
    useState<OverviewStatusResponse | null>(null);
  const [overviewWindowHours, setOverviewWindowHours] =
    useState<OverviewWindowHours>(24);
  const [liveBannerKind, setLiveBannerKind] =
    useState<LiveBannerKind>("offline");
  const [explainPayload, setExplainPayload] =
    useState<ExplainModalPayload | null>(null);
  const [adminModalOpen, setAdminModalOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setBootLoading(true);
    setBootError(null);

    Promise.all([
      loadRealCatalog(),
      loadPrecomputedAnomalies(),
      loadPrecomputedForecasts(),
      fetchApiHealth().catch(() => null),
      fetchAdminRole().catch(() => ({ configured: false, role: "viewer" as const })),
    ])
      .then(
        ([
          cat,
          anomFile,
          fcFile,
          healthRes,
          roleRes,
        ]) => {
          if (cancelled) return;
          setCatalog(cat);
          setAnomaliesMap(anomFile.datasets ?? {});
          setPrecomputedForecasts(fcFile);
          if (healthRes) setHealth(healthRes);
          setAdminRole(roleRes);

          if (cat.datasets.length > 0) {
            const requested = initialRoute.dataset
              ? cat.datasets.find((d) => d.id === initialRoute.dataset)
              : undefined;
            if (requested) {
              setDatasetId(requested.id);
            } else {
              const hasSheep = cat.datasets.some((d) => d.id === "sheep_barn");
              setDatasetId(hasSheep ? "sheep_barn" : cat.datasets[0].id);
            }
          }
        }
      )
      .catch((err) => {
        if (!cancelled) {
          setBootError(
            err instanceof Error ? err.message : "載入平台資料失敗"
          );
        }
      })
      .finally(() => {
        if (!cancelled) setBootLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const datasets = useMemo(() => catalog?.datasets ?? [], [catalog]);
  const activeDataset = useMemo(
    () => datasets.find((d) => d.id === datasetId) ?? datasets[0],
    [datasets, datasetId]
  );

  const handleChangeDataset = useCallback(
    (nextId: string) => {
      setDatasetId(nextId);
    },
    []
  );

  const handleSelectDomainAndNavigate = useCallback(
    (nextId: string, targetPage: PageId) => {
      setDatasetId(nextId);
      setActivePage(targetPage);
    },
    []
  );

  const handleNavigate = useCallback(
    (page: PageId) => {
      setActivePage(page);
    },
    []
  );

  const handleUpdateCheckedDomain = useCallback(
    (id: string, summary: CheckedDomainSummary) => {
      setCheckedDomains((prev) => ({ ...prev, [id]: summary }));
    },
    []
  );

  if (bootLoading) {
    return (
      <div className="min-h-screen bg-[#F5F7FA] flex items-center justify-center p-6">
        <div className="bg-white border border-slate-200 rounded-lg p-6 max-w-md w-full text-center space-y-2 shadow-xs">
          <div className="text-base font-semibold text-slate-900">
            正在載入 AIDE 智慧環境監測與決策平台…
          </div>
          <div className="text-xs text-slate-500">
            正在讀取 7 場域目錄與離線預計算輸出
          </div>
        </div>
      </div>
    );
  }

  if (bootError || !activeDataset) {
    return (
      <div className="min-h-screen bg-[#F5F7FA] flex items-center justify-center p-6">
        <div className="bg-white border border-rose-200 rounded-lg p-6 max-w-md w-full space-y-2">
          <div className="text-base font-semibold text-rose-800">
            無法啟動平台資料
          </div>
          <div className="text-sm text-slate-700">
            {bootError ?? "找不到場域目錄設定"}
          </div>
        </div>
      </div>
    );
  }

  const renderPage = () => {
    switch (activePage) {
      case "overview":
        return (
          <OverviewPage
            datasets={datasets}
            anomaliesMap={anomaliesMap}
            checkedDomains={checkedDomains}
            overviewStatus={overviewStatus}
            overviewWindowHours={overviewWindowHours}
            onUpdateOverviewStatus={setOverviewStatus}
            onChangeOverviewWindowHours={setOverviewWindowHours}
            onUpdateCheckedDomain={handleUpdateCheckedDomain}
            onSelectDomainAndNavigate={handleSelectDomainAndNavigate}
          />
        );
      case "domain_home":
        return (
          <DomainHomePage
            dataset={activeDataset}
            anomalies={anomaliesMap[activeDataset.id]}
            precomputedForecasts={precomputedForecasts}
            health={health}
            onNavigate={handleNavigate}
            onOpenExplain={setExplainPayload}
          />
        );
      case "live_forecast":
        return (
          <LiveForecastPage
            datasets={datasets}
            datasetId={activeDataset.id}
            onSelectDataset={handleChangeDataset}
            health={health}
            adminRole={adminRole}
            onLiveBannerChange={setLiveBannerKind}
            precomputedForecasts={precomputedForecasts}
          />
        );
      case "decision_support":
        return (
          <DecisionSupportPage
            datasets={datasets}
            datasetId={activeDataset.id}
            onSelectDataset={handleChangeDataset}
          />
        );
      case "explorer":
        return (
          <ExplorerPage
            dataset={activeDataset}
            onNavigate={handleNavigate}
            onOpenExplain={setExplainPayload}
          />
        );
      case "model_lifecycle":
        return <ModelLifecyclePage dataset={activeDataset} health={health} />;
      case "decision_risk":
      case "decision_actions":
      case "decision_diagnosis":
      case "decision_forecast":
      case "decision_replay":
        return (
          <DomainDecisionPages
            page={activePage}
            dataset={activeDataset}
            precomputedForecasts={precomputedForecasts}
            anomalies={anomaliesMap[activeDataset.id]}
            health={health}
          />
        );
      case "catalog":
      case "provenance":
      case "guide":
      case "ai_overview":
      case "decision_guide":
      case "model_performance":
      case "team_review":
        return (
          <AdvancedPages
            page={activePage}
            datasets={datasets}
            precomputedForecasts={precomputedForecasts}
            onSelectDomainAndNavigate={handleSelectDomainAndNavigate}
          />
        );
    }
  };

  return (
    <>
      <Layout
        datasets={datasets}
        datasetId={activeDataset.id}
        onChangeDataset={handleChangeDataset}
        activePage={activePage}
        onNavigate={handleNavigate}
        health={health}
        adminRole={adminRole}
        onOpenAdmin={() => setAdminModalOpen(true)}
        liveBannerKind={liveBannerKind}
      >
        <PageErrorBoundary pageKey={`${activePage}:${activeDataset.id}`}>
          {renderPage()}
        </PageErrorBoundary>
      </Layout>

      <ExplainModal
        payload={explainPayload}
        onClose={() => setExplainPayload(null)}
      />

      <AdminModal
        open={adminModalOpen}
        onClose={() => setAdminModalOpen(false)}
        adminRole={adminRole}
        onRoleUpdated={setAdminRole}
      />
    </>
  );
};

export default App;
