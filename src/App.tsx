import React, { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AnomaliesResponse,
  DataKind,
  DemoManifest,
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
  loadDemoManifest,
  loadDemoStepOutputs,
  loadPrecomputedAnomalies,
  loadPrecomputedForecasts,
  loadRealCatalog,
} from "./lib/dataLoader";
import { AdvancedPages } from "./pages/AdvancedPages";
import { DataUpdatePage } from "./pages/DataUpdatePage";
import { DecisionSupportPage } from "./pages/DecisionSupportPage";
import { DomainHomePage } from "./pages/DomainHomePage";
import { ExplorerPage } from "./pages/ExplorerPage";
import { LiveForecastPage } from "./pages/LiveForecastPage";
import { ModelLifecyclePage } from "./pages/ModelLifecyclePage";
import { OverviewPage } from "./pages/OverviewPage";
import { SheepDecisionPages } from "./pages/SheepDecisionPages";
import {
  isRealOnlyGuardedPage,
  SHEEP_ONLY_PAGES,
} from "./lib/dataKindPolicy";
import type { LiveBannerKind } from "./lib/liveForecast";
import type {
  AdminRoleStatus,
  ApiHealthStatus,
  CheckedDomainSummary,
  DemoStepOutputsFile,
  DomainSyntheticState,
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
  "data_update",
  "explorer",
  "model_lifecycle",
  "sheep_risk",
  "sheep_actions",
  "sheep_diagnosis",
  "sheep_forecast",
  "sheep_replay",
  "catalog",
  "provenance",
  "guide",
  "ai_overview",
  "decision_guide",
  "model_performance",
  "team_review",
]);

function readInitialRouteState(): {
  kind: DataKind;
  page: PageId;
  dataset: string | null;
} {
  if (typeof window === "undefined") {
    return { kind: "real", page: "overview", dataset: null };
  }
  const params = new URLSearchParams(window.location.search);
  const rawKind = params.get("kind");
  const rawPage = params.get("page");
  const rawDataset = params.get("dataset");
  const kind: DataKind = rawKind === "synthetic" ? "synthetic" : "real";
  const page: PageId =
    rawPage && VALID_PAGE_IDS.has(rawPage as PageId)
      ? (rawPage as PageId)
      : "overview";
  return { kind, page, dataset: rawDataset };
}

function buildInitialSyntheticStates(
  manifest: DemoManifest,
  stepOutputs: DemoStepOutputsFile | null
): Record<string, DomainSyntheticState> {
  const states: Record<string, DomainSyntheticState> = {};
  for (const domain of manifest.domains) {
    const d1Batch = domain.batches.find((b) => b.step === 1) ?? domain.batches[0];
    const d1Out = stepOutputs?.domains?.[domain.id]?.steps.find((s) => s.step === 1);
    const version = d1Out?.version ?? "v1.0";
    if (!d1Batch) continue;
    states[domain.id] = {
      currentStep: d1Batch.step,
      activeVersionIndex: 0,
      versions: [
        {
          version,
          step: d1Batch.step,
          code: d1Batch.code,
          label: d1Batch.label,
          committedAt: d1Batch.end,
          rowCount: d1Batch.rows,
          rangeStart: d1Batch.start,
          rangeEnd: d1Batch.end,
          batchSha256: d1Batch.sha256,
        },
      ],
      auditLog: [
        {
          id: `${domain.id}-init`,
          at: d1Batch.end,
          action: "INIT",
          detail: `預先匯入合成初始批次 ${d1Batch.code}（${d1Batch.label}，${d1Batch.rows} 列）`,
          version,
        },
      ],
      verifiedStep: null,
      lastVerifyReport: null,
    };
  }
  return states;
}

export const App: React.FC = () => {
  const [catalog, setCatalog] = useState<RealCatalog | null>(null);
  const [anomaliesMap, setAnomaliesMap] = useState<
    Record<string, AnomaliesResponse>
  >({});
  const [precomputedForecasts, setPrecomputedForecasts] =
    useState<PrecomputedForecasts | null>(null);
  const [demoManifest, setDemoManifest] = useState<DemoManifest | null>(null);
  const [syntheticStates, setSyntheticStates] = useState<
    Record<string, DomainSyntheticState>
  >({});
  const [health, setHealth] = useState<ApiHealthStatus | null>(null);
  const [adminRole, setAdminRole] = useState<AdminRoleStatus>({
    configured: false,
    role: "viewer",
  });
  const [bootLoading, setBootLoading] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);

  // App UI state
  const initialRoute = useMemo(() => readInitialRouteState(), []);
  const [dataKind, setDataKind] = useState<DataKind>(initialRoute.kind);
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
      loadDemoManifest(),
      loadDemoStepOutputs().catch(() => null),
      fetchApiHealth().catch(() => null),
      fetchAdminRole().catch(() => ({ configured: false, role: "viewer" as const })),
    ])
      .then(
        ([
          cat,
          anomFile,
          fcFile,
          manifest,
          stepOutputs,
          healthRes,
          roleRes,
        ]) => {
          if (cancelled) return;
          setCatalog(cat);
          setAnomaliesMap(anomFile.datasets ?? {});
          setPrecomputedForecasts(fcFile);
          setDemoManifest(manifest);
          setSyntheticStates(buildInitialSyntheticStates(manifest, stepOutputs));
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
      if (nextId !== "sheep_barn" && SHEEP_ONLY_PAGES.has(activePage)) {
        setActivePage("domain_home");
      }
    },
    [activePage]
  );

  const handleSelectDomainAndNavigate = useCallback(
    (nextId: string, targetPage: PageId) => {
      setDatasetId(nextId);
      if (nextId !== "sheep_barn" && SHEEP_ONLY_PAGES.has(targetPage)) {
        setActivePage("domain_home");
      } else {
        setActivePage(targetPage);
      }
    },
    []
  );

  const handleNavigate = useCallback(
    (page: PageId) => {
      if (
        datasetId !== "sheep_barn" &&
        SHEEP_ONLY_PAGES.has(page) &&
        dataKind !== "synthetic"
      ) {
        setActivePage("domain_home");
        return;
      }
      setActivePage(page);
    },
    [datasetId, dataKind]
  );

  const handleUpdateCheckedDomain = useCallback(
    (id: string, summary: CheckedDomainSummary) => {
      setCheckedDomains((prev) => ({ ...prev, [id]: summary }));
    },
    []
  );

  const handleUpdateSyntheticState = useCallback(
    (
      id: string,
      updater: (prev: DomainSyntheticState) => DomainSyntheticState
    ) => {
      setSyntheticStates((prev) => {
        const current = prev[id];
        if (!current) return prev;
        return { ...prev, [id]: updater(current) };
      });
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
            正在讀取 7 場域目錄、離線預計算輸出與合成展示清單
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

  const currentSyntheticState = syntheticStates[activeDataset.id];

  const renderPage = () => {
    if (dataKind === "synthetic" && isRealOnlyGuardedPage(activePage)) {
      return (
        <section
          aria-label="僅支援真實資料提示"
          className="bg-white border border-slate-200 rounded-lg p-5 sm:p-6 space-y-4 max-w-xl"
        >
          <h1 className="text-lg font-bold text-slate-900">
            此頁只有真實資料
          </h1>
          <p className="text-sm text-slate-600 leading-relaxed">
            「決策輔助」與羊舍專屬 5 頁僅使用真實感測資料，不支援合成展示資料。請切換回真實資料模式後再檢視內容。
          </p>
          <div>
            <button
              type="button"
              onClick={() => {
                setDataKind("real");
                if (
                  SHEEP_ONLY_PAGES.has(activePage) &&
                  activeDataset.id !== "sheep_barn"
                ) {
                  setDatasetId("sheep_barn");
                }
              }}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-[#0B63CE] text-white text-sm font-medium hover:bg-[#0952AD]"
            >
              切到真實資料
            </button>
          </div>
        </section>
      );
    }

    switch (activePage) {
      case "overview":
        return (
          <OverviewPage
            dataKind={dataKind}
            datasets={datasets}
            anomaliesMap={anomaliesMap}
            demoManifest={demoManifest}
            syntheticStates={syntheticStates}
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
            dataKind={dataKind}
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
      case "data_update":
        return currentSyntheticState ? (
          <DataUpdatePage
            dataset={activeDataset}
            demoManifest={demoManifest}
            syntheticState={currentSyntheticState}
            onUpdateSyntheticState={handleUpdateSyntheticState}
            onOpenExplain={setExplainPayload}
          />
        ) : null;
      case "explorer":
        return (
          <ExplorerPage
            dataKind={dataKind}
            dataset={activeDataset}
            demoManifest={demoManifest}
            syntheticState={currentSyntheticState}
            onNavigate={handleNavigate}
            onOpenExplain={setExplainPayload}
          />
        );
      case "model_lifecycle":
        return <ModelLifecyclePage dataset={activeDataset} health={health} />;
      case "sheep_risk":
      case "sheep_actions":
      case "sheep_diagnosis":
      case "sheep_forecast":
      case "sheep_replay":
        if (activeDataset.id === "sheep_barn") {
          return (
            <SheepDecisionPages
              page={activePage}
              anomalies={anomaliesMap["sheep_barn"]}
              health={health}
            />
          );
        }
        return (
          <DomainHomePage
            dataKind={dataKind}
            dataset={activeDataset}
            anomalies={anomaliesMap[activeDataset.id]}
            precomputedForecasts={precomputedForecasts}
            health={health}
            onNavigate={handleNavigate}
            onOpenExplain={setExplainPayload}
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
        dataKind={dataKind}
        onChangeDataKind={setDataKind}
        datasets={datasets}
        datasetId={activeDataset.id}
        onChangeDataset={handleChangeDataset}
        activePage={activePage}
        onNavigate={handleNavigate}
        health={health}
        adminRole={adminRole}
        onOpenAdmin={() => setAdminModalOpen(true)}
        syntheticState={currentSyntheticState}
        liveBannerKind={liveBannerKind}
      >
        <PageErrorBoundary pageKey={`${activePage}:${activeDataset.id}:${dataKind}`}>
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
