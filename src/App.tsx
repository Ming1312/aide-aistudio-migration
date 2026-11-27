import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { AnomaliesResponse, PrecomputedForecasts, RealCatalog } from "../contracts/types";
import { can } from "../contracts/permissions";
import { AdminModal } from "./components/AdminModal";
import { Layout } from "./components/Layout";
import { PageErrorBoundary } from "./components/PageErrorBoundary";
import {
  fetchAdminRole,
  loadPrecomputedAnomalies,
  loadPrecomputedForecasts,
  loadPrecomputedThresholds,
  loadRealCatalog,
  loadRealCsv,
} from "./lib/dataLoader";
import { mergeRows } from "./lib/liveSeries";
import { CANDIDATE_POLICIES, findTask } from "./lib/candidateRisk";
import type { RiskDirection } from "./lib/candidateRisk";
import { DEFAULT_PCT, resolveThresholds, sensorKey, validPct, validValues, type Pct, type ThresholdTable } from "./lib/thresholds";
import { loadJson, saveJson } from "./lib/storage";
import { computeDomainStatus, maskOutageRows, type StatusInput, type ThresholdOverrides } from "./lib/status";
import { useEngine } from "./lib/useEngine";
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
const PCT_KEY = "aide.thresholdPct.v1";
const DIRS_KEY = "aide.thresholdDirs.v1";

/** 舊版的管理員調整以場域代號為鍵（只有政策感測器）；轉成「場域::感測器」 */
function migrateOverrides(raw: ThresholdOverrides): ThresholdOverrides {
  const out: ThresholdOverrides = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k.includes("::")) out[k] = v;
    else if (CANDIDATE_POLICIES[k]) out[sensorKey(k, CANDIDATE_POLICIES[k].sensor)] = v;
  }
  return out;
}

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
  const [overrides, setOverrides] = useState<ThresholdOverrides>(() => migrateOverrides(loadJson<ThresholdOverrides>(OVERRIDES_KEY, {})));
  const [dirs, setDirs] = useState<Record<string, RiskDirection>>(() => loadJson<Record<string, RiskDirection>>(DIRS_KEY, {}));
  const [thresholdTable, setThresholdTable] = useState<ThresholdTable | null>(null);
  const [pct, setPct] = useState<Pct>(() => {
    const p = loadJson<Pct>(PCT_KEY, DEFAULT_PCT);
    return validPct(p) ? p : DEFAULT_PCT;
  });
  const [adminModalOpen, setAdminModalOpen] = useState(false);
  const [baseRows, setBaseRows] = useState<Record<string, ParsedCsvRow[]>>({});

  const importer = useImporter(catalog, can(adminRole.role, "import_data"));
  const datasetIdsKey = useMemo(() => (catalog?.datasets ?? []).map((d) => d.id), [catalog]);
  const engine = useEngine(datasetIdsKey, datasetIdsKey.length > 0);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      loadRealCatalog(),
      loadPrecomputedAnomalies(),
      loadPrecomputedForecasts(),
      fetchAdminRole().catch(() => ({ configured: false, role: "viewer" as const })),
      loadPrecomputedThresholds().catch(() => null),
    ])
      .then(([cat, anom, fc, role, thr]) => {
        if (!cancelled) setThresholdTable(thr);
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

  // 需要原始 CSV 的場域：有匯入資料者（合併後建立簡易預測），以及「有風險政策但沒有預計算預測」者（例如資料不完整的育成一廠北側）
  const importedIds = Object.keys(importer.imported).filter((id) => importer.imported[id].length > 0);
  const baselineIds = useMemo(
    () =>
      (catalog?.datasets ?? [])
        .filter((d) => {
          const p = CANDIDATE_POLICIES[d.id];
          return !!p && !!forecasts && !findTask(forecasts, d.id, p.sensor, 1);
        })
        .map((d) => d.id),
    [catalog, forecasts]
  );
  const needBase = Array.from(new Set([...importedIds, ...baselineIds]));
  const importedKey = needBase.join(",");
  useEffect(() => {
    let cancelled = false;
    for (const id of needBase) {
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

  // 風險門檻：管理員調整 ＞ 歷史百分位計算（匯入資料後以合併資料精確重算）＞ 程式內的假定值
  const thresholds = useMemo(() => {
    const exact: Record<string, { values: number[]; from: string; to: string; direction: RiskDirection }> = {};
    for (const ds of datasets) {
      const imp = importer.imported[ds.id];
      const base = baseRows[ds.id];
      const sensors = thresholdTable?.datasets[ds.id]?.sensors;
      if (!sensors || !imp || imp.length === 0 || !base) continue;
      const merged = mergeRows(base, imp);
      const events = anomaliesMap[ds.id]?.events ?? [];
      for (const [sensor, entry] of Object.entries(sensors)) {
        const v = validValues(merged, sensor, events);
        exact[sensorKey(ds.id, sensor)] = { values: v.values, from: v.from, to: v.to, direction: dirs[sensorKey(ds.id, sensor)] ?? entry.direction };
      }
    }
    return resolveThresholds({ table: thresholdTable, pct, admin: overrides, dirs, exact });
  }, [datasets, thresholdTable, pct, overrides, dirs, importer.imported, baseRows, anomaliesMap]);

  const inputs = useMemo(() => {
    const m = new Map<string, StatusInput>();
    for (const ds of datasets) {
      const imp = importer.imported[ds.id];
      const base = baseRows[ds.id];
      m.set(ds.id, {
        dataset: ds,
        forecasts,
        anomalies: anomaliesMap[ds.id],
        overrides: thresholds.effective,
        // 匯入資料比原始資料更新時才改用匯入資料做預測（內容相同的重複匯入不降低預測品質）；
        // 沒有預計算預測的場域（資料不完整）一律用原始＋匯入資料建立簡易預測
        ...(() => {
          const importNewer = !!imp && imp.length > 0 && !!base && base.length > 0 && imp[imp.length - 1].tsMs > base[base.length - 1].tsMs;
          if (importNewer) return { liveRows: mergeRows(base!, imp!), liveIsBase: false };
          if (baselineIds.includes(ds.id) && base && base.length > 0) {
            const m = maskOutageRows(mergeRows(base, imp ?? []), anomaliesMap[ds.id]?.events ?? []);
            return { liveRows: m.rows, liveIsBase: true, maskedRows: m.masked };
          }
          return { liveRows: null, liveIsBase: false };
        })(),
        engine: engine.data[ds.id] ?? null,
      });
    }
    return m;
  }, [datasets, forecasts, anomaliesMap, thresholds, importer.imported, baseRows, engine.data, baselineIds]);

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
  const changeDirs = useCallback((next: Record<string, RiskDirection>) => {
    setDirs(next);
    saveJson(DIRS_KEY, next);
  }, []);
  const changePct = useCallback((next: Pct) => {
    setPct(next);
    saveJson(PCT_KEY, next);
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
        return <OverviewPage
            statuses={statuses}
            engine={{ connected: engine.connected, synthetic: engine.synthetic, lastAt: engine.lastAt }}
            onOpenDecision={openDecision}
            onOpenData={openData}
          />;
      case "data":
        return <DataPage dataset={activeDataset} forecasts={forecasts} importedRows={importer.imported[activeDataset.id] ?? []} thresholds={thresholds.effective} />;
      case "decision":
        return <DecisionPage
            status={activeStatus}
            input={inputs.get(activeDataset.id)!}
            onOpenData={() => openData(activeDataset.id)}
            canRecord={can(adminRole.role, "record_decision")}
            onLogin={() => setAdminModalOpen(true)}
          />;
      case "import":
        return <ImportPage datasets={datasets} datasetId={activeDataset.id} importer={importer} canImport={can(adminRole.role, "import_data")} onLogin={() => setAdminModalOpen(true)} />;
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
            canEditThresholds={can(adminRole.role, "edit_thresholds")}
            thresholds={thresholds.effective}
            historyThresholds={thresholds.history}
            pct={pct}
            onChangePct={changePct}
            dirs={dirs}
            onChangeDirs={changeDirs}
            thresholdTable={thresholdTable}
            monitored={Object.fromEntries(statuses.map((st) => [st.datasetId, st.sensorStatuses.map((x) => x.sensor ?? "")]))}
            engine={can(adminRole.role, "view_engine") ? engine : null}
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
