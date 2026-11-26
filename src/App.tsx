import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { AnomaliesResponse, PrecomputedForecasts, RealCatalog } from "../contracts/types";
import { AdminModal } from "./components/AdminModal";
import { Layout } from "./components/Layout";
import { PageErrorBoundary } from "./components/PageErrorBoundary";
import {
  fetchAdminRole,
  loadPrecomputedAnomalies,
  loadPrecomputedForecasts,
  loadRealCatalog,
  loadRealCsv,
} from "./lib/dataLoader";
import { mergeRows } from "./lib/liveSeries";
import { loadJson, saveJson } from "./lib/storage";
import { computeDomainStatus, type StatusInput, type ThresholdOverrides } from "./lib/status";
import { useImporter } from "./lib/useImporter";
import { DataPage } from "./pages/DataPage";
import { DecisionPage } from "./pages/DecisionPage";
import { ImportPage } from "./pages/ImportPage";
import { OverviewPage } from "./pages/OverviewPage";
import { SettingsPage } from "./pages/SettingsPage";
import type { AdminRoleStatus, ParsedCsvRow, PageId } from "./types/app";

const VALID_PAGES = new Set<PageId>(["overview", "data", "decision", "import", "settings"]);
const OVERRIDES_KEY = "aide.thresholds.v1";
const DEFAULT_DS_KEY = "aide.defaultDataset.v1";

function readInitialRoute(): { page: PageId; dataset: string | null } {
  const params = new URLSearchParams(window.location.search);
  const rawPage = params.get("page");
  return {
    page: rawPage && VALID_PAGES.has(rawPage as PageId) ? (rawPage as PageId) : "overview",
    dataset: params.get("dataset"),
  };
}

export const App: React.FC = () => {
  const [catalog, setCatalog] = useState<RealCatalog | null>(null);
  const [anomaliesMap, setAnomaliesMap] = useState<Record<string, AnomaliesResponse>>({});
  const [forecasts, setForecasts] = useState<PrecomputedForecasts | null>(null);
  const [adminRole, setAdminRole] = useState<AdminRoleStatus>({ configured: false, role: "viewer" });
  const [bootLoading, setBootLoading] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);

  const initialRoute = useMemo(() => readInitialRoute(), []);
  const [datasetId, setDatasetId] = useState<string>(initialRoute.dataset || loadJson<string>(DEFAULT_DS_KEY, "sheep_barn"));
  const [activePage, setActivePage] = useState<PageId>(initialRoute.page);
  const [overrides, setOverrides] = useState<ThresholdOverrides>(() => loadJson<ThresholdOverrides>(OVERRIDES_KEY, {}));
  const [adminModalOpen, setAdminModalOpen] = useState(false);
  const [baseRows, setBaseRows] = useState<Record<string, ParsedCsvRow[]>>({});

  const importer = useImporter(catalog);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      loadRealCatalog(),
      loadPrecomputedAnomalies(),
      loadPrecomputedForecasts(),
      fetchAdminRole().catch(() => ({ configured: false, role: "viewer" as const })),
    ])
      .then(([cat, anom, fc, role]) => {
        if (cancelled) return;
        setCatalog(cat);
        setAnomaliesMap(anom.datasets ?? {});
        setForecasts(fc);
        setAdminRole(role);
        setDatasetId((cur) => (cat.datasets.some((d) => d.id === cur) ? cur : cat.datasets[0]?.id ?? cur));
      })
      .catch((err) => !cancelled && setBootError(err instanceof Error ? err.message : "載入平台資料失敗"))
      .finally(() => !cancelled && setBootLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  // 有匯入資料的場域才需要原始 CSV（合併後建立簡易預測）
  const importedIds = Object.keys(importer.imported).filter((id) => importer.imported[id].length > 0);
  const importedKey = importedIds.join(",");
  useEffect(() => {
    let cancelled = false;
    for (const id of importedIds) {
      if (baseRows[id]) continue;
      loadRealCsv(id)
        .then((d) => !cancelled && setBaseRows((m) => (m[id] ? m : { ...m, [id]: d.rows })))
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [importedKey]);

  const datasets = useMemo(() => catalog?.datasets ?? [], [catalog]);
  const activeDataset = datasets.find((d) => d.id === datasetId) ?? datasets[0];

  const inputs = useMemo(() => {
    const m = new Map<string, StatusInput>();
    for (const ds of datasets) {
      const imp = importer.imported[ds.id];
      const base = baseRows[ds.id];
      m.set(ds.id, {
        dataset: ds,
        forecasts,
        anomalies: anomaliesMap[ds.id],
        overrides,
        liveRows: imp && imp.length > 0 && base ? mergeRows(base, imp) : null,
      });
    }
    return m;
  }, [datasets, forecasts, anomaliesMap, overrides, importer.imported, baseRows]);

  const statuses = useMemo(() => datasets.map((d) => computeDomainStatus(inputs.get(d.id)!)), [datasets, inputs]);

  const navigate = useCallback((page: PageId) => setActivePage(page), []);
  const openDecision = useCallback((id: string) => {
    setDatasetId(id);
    setActivePage("decision");
  }, []);
  const openData = useCallback((id: string) => {
    setDatasetId(id);
    setActivePage("data");
  }, []);

  const changeOverrides = useCallback((next: ThresholdOverrides) => {
    setOverrides(next);
    saveJson(OVERRIDES_KEY, next);
  }, []);
  const changeDefault = useCallback((id: string) => {
    setDatasetId(id);
    saveJson(DEFAULT_DS_KEY, id);
  }, []);

  if (bootLoading) {
    return (
      <div className="min-h-screen bg-[#F5F7FA] grid place-items-center text-sm text-slate-500" role="status">
        載入中…
      </div>
    );
  }
  if (bootError || !activeDataset) {
    return (
      <div className="min-h-screen bg-[#F5F7FA] grid place-items-center p-6">
        <div className="bg-white border border-rose-200 rounded-lg p-6 max-w-md text-sm text-rose-800">{bootError ?? "找不到場域目錄"}</div>
      </div>
    );
  }

  const activeStatus = statuses.find((s) => s.datasetId === activeDataset.id)!;

  const renderPage = () => {
    switch (activePage) {
      case "overview":
        return <OverviewPage statuses={statuses} onOpenDecision={openDecision} onOpenData={openData} />;
      case "data":
        return <DataPage dataset={activeDataset} forecasts={forecasts} importedRows={importer.imported[activeDataset.id] ?? []} />;
      case "decision":
        return <DecisionPage status={activeStatus} input={inputs.get(activeDataset.id)!} onOpenData={() => openData(activeDataset.id)} />;
      case "import":
        return <ImportPage datasets={datasets} datasetId={activeDataset.id} importer={importer} />;
      case "settings":
        return (
          <SettingsPage
            datasets={datasets}
            defaultDatasetId={activeDataset.id}
            onChangeDefaultDataset={changeDefault}
            overrides={overrides}
            onChangeOverrides={changeOverrides}
            adminRole={adminRole}
            onOpenAdmin={() => setAdminModalOpen(true)}
          />
        );
    }
  };

  return (
    <>
      <Layout
        datasets={datasets}
        datasetId={activeDataset.id}
        onChangeDataset={setDatasetId}
        activePage={activePage}
        onNavigate={navigate}
        adminRole={adminRole}
        onOpenAdmin={() => setAdminModalOpen(true)}
        importCount={importedIds.length}
      >
        <PageErrorBoundary pageKey={`${activePage}:${activeDataset.id}`}>{renderPage()}</PageErrorBoundary>
      </Layout>
      <AdminModal open={adminModalOpen} onClose={() => setAdminModalOpen(false)} adminRole={adminRole} onRoleUpdated={setAdminRole} />
    </>
  );
};
export default App;
