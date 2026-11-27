import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { DEFAULT_PCT, resolveThresholds, sensorKey, validPct, validValuesWith, type Pct, type ThresholdTable } from "./lib/thresholds";
import { loadJson, saveJson } from "./lib/storage";
import { computeDomainStatus, type StatusInput, type ThresholdOverrides } from "./lib/status";
import {
  applyEventMask,
  detectDatasetEvents,
  dropCovered,
  fromAnomaly,
  toAnomalyEvents,
  type DataEvent,
  type MaskResult,
  type ResolvedEvent,
} from "./lib/events";
import { useEventLog } from "./lib/useEventLog";
import { useEngine } from "./lib/useEngine";
import { useImporter } from "./lib/useImporter";
import { useTasks } from "./lib/useTasks";
import { DataPage } from "./pages/DataPage";
import { DecisionPage } from "./pages/DecisionPage";
import { EventsPage } from "./pages/EventsPage";
import { PlanPage } from "./pages/PlanPage";
import { TasksPage } from "./pages/TasksPage";
import { ImportPage } from "./pages/ImportPage";
import { OverviewPage } from "./pages/OverviewPage";
import { SettingsPage } from "./pages/SettingsPage";
import type { AdminRoleStatus, ParsedCsvRow, PageId } from "./types/app";

const VALID_PAGES = new Set<PageId>(["overview", "data", "decision", "events", "import", "plan", "settings"]);
const OVERRIDES_KEY = "aide.thresholds.v1";
const DEFAULT_DS_KEY = "aide.defaultDataset.v1";
const PCT_KEY = "aide.thresholdPct.v1";
const DIRS_KEY = "aide.thresholdDirs.v1";
const ENG_THR_KEY = "aide.thresholdUseEngine.v1";

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
  const [useEngineThr, setUseEngineThr] = useState<boolean>(() => loadJson<boolean>(ENG_THR_KEY, true));
  const [dirs, setDirs] = useState<Record<string, RiskDirection>>(() => loadJson<Record<string, RiskDirection>>(DIRS_KEY, {}));
  const [thresholdTable, setThresholdTable] = useState<ThresholdTable | null>(null);
  const [pct, setPct] = useState<Pct>(() => {
    const p = loadJson<Pct>(PCT_KEY, DEFAULT_PCT);
    return validPct(p) ? p : DEFAULT_PCT;
  });
  const [adminModalOpen, setAdminModalOpen] = useState(false);
  const [baseRows, setBaseRows] = useState<Record<string, ParsedCsvRow[]>>({});

  const tasksApi = useTasks(can(adminRole.role, "view_tasks"), adminRole.role);
  const openTasks = tasksApi.tasks?.filter((t) => t.status !== "done").length ?? 0;
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
  // 資料事件（缺值、斷線、卡住）要對每個場域的原始資料做偵測與排除，門檻與簡易預測也要用排除後的資料，所以全部場域都載入
  const needBase = datasetIdsKey;
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

  // ---- 資料事件：離線偵測器 ＋ 瀏覽器對原始（＋匯入）資料的偵測 ＋ 人工標註；歷史會記下來 ----
  const preEvents = useMemo(() => datasets.flatMap((ds) => (anomaliesMap[ds.id]?.events ?? []).map((e) => fromAnomaly(ds.id, e))), [datasets, anomaliesMap]);
  const detectCache = useRef(new Map<string, { base: ParsedCsvRow[]; imp: ParsedCsvRow[] | undefined; events: DataEvent[] }>());
  const { currentEvents, readyDs } = useMemo(() => {
    const out: DataEvent[] = [...preEvents];
    const ready = new Set<string>();
    for (const ds of datasets) {
      const base = baseRows[ds.id];
      if (!base || base.length === 0) continue;
      const imp = importer.imported[ds.id];
      let c = detectCache.current.get(ds.id);
      if (!c || c.base !== base || c.imp !== imp) {
        const rows = imp && imp.length > 0 ? mergeRows(base, imp) : base;
        const sensors = Array.from(new Set(rows.slice(0, 5).flatMap((r) => Object.keys(r.values))));
        const known = preEvents.filter((e) => e.datasetId === ds.id);
        c = { base, imp, events: dropCovered(detectDatasetEvents(ds.id, rows, sensors), known) };
        detectCache.current.set(ds.id, c);
      }
      out.push(...c.events);
      ready.add(ds.id);
    }
    return { currentEvents: out, readyDs: ready };
  }, [datasets, preEvents, baseRows, importer.imported]);
  const eventLog = useEventLog(currentEvents, readyDs);
  const eventsByDs = useMemo(() => {
    const m = new Map<string, ResolvedEvent[]>();
    for (const e of eventLog.events) {
      const l = m.get(e.datasetId);
      if (l) l.push(e);
      else m.set(e.datasetId, [e]);
    }
    return m;
  }, [eventLog.events]);
  /** 各場域排除事件時段後的資料（原始＋匯入合併）；門檻與簡易預測都用這份 */
  const maskedByDs = useMemo(() => {
    const m = new Map<string, { merged: ParsedCsvRow[]; masked: MaskResult; rawLastMs: number | null }>();
    for (const ds of datasets) {
      const base = baseRows[ds.id];
      if (!base || base.length === 0) continue;
      const imp = importer.imported[ds.id] ?? [];
      const merged = imp.length > 0 ? mergeRows(base, imp) : base;
      m.set(ds.id, { merged, masked: applyEventMask(merged, eventsByDs.get(ds.id) ?? []), rawLastMs: merged[merged.length - 1]?.tsMs ?? null });
    }
    return m;
  }, [datasets, baseRows, importer.imported, eventsByDs]);

  // 風險門檻：管理員調整 ＞ 歷史百分位計算（匯入資料後以合併資料精確重算）＞ 程式內的假定值
  const thresholds = useMemo(() => {
    const exact: Record<string, { values: number[]; from: string; to: string; direction: RiskDirection; noteSuffix?: string }> = {};
    const useEng = useEngineThr && engine.connected;
    for (const ds of datasets) {
      const imp = importer.imported[ds.id] ?? [];
      const base = baseRows[ds.id];
      const sensors = thresholdTable?.datasets[ds.id]?.sensors;
      const md = maskedByDs.get(ds.id);
      if (!sensors || !base || !md) continue;
      const rows = md.masked.rows; // 已排除事件時段（斷電、卡住、維修…）的資料
      for (const [sensor, entry] of Object.entries(sensors)) {
        const key = sensorKey(ds.id, sensor);
        const extra = useEng ? engine.series[key] : undefined;
        const excluded = md.masked.perSensor[sensor] ?? 0;
        if (imp.length === 0 && !(extra && extra.length > 0) && excluded === 0) continue; // 沒有新資料、也沒有額外排除：用預先算好的表
        const v = validValuesWith(rows, sensor, [], extra ?? []);
        exact[key] = {
          values: v.values,
          from: v.from,
          to: v.to,
          direction: dirs[key] ?? entry.direction,
          noteSuffix: `${excluded > 0 ? `・已排除事件時段 ${excluded} 筆` : ""}${v.added > 0 ? `・含引擎資料 ${v.added} 筆${engine.synthetic ? "（模擬）" : ""}` : ""}`,
        };
      }
    }
    return resolveThresholds({ table: thresholdTable, pct, admin: overrides, dirs, exact });
  }, [datasets, thresholdTable, pct, overrides, dirs, importer.imported, baseRows, maskedByDs, useEngineThr, engine.connected, engine.series, engine.synthetic]);

  const inputs = useMemo(() => {
    const m = new Map<string, StatusInput>();
    for (const ds of datasets) {
      const imp = importer.imported[ds.id];
      const base = baseRows[ds.id];
      const md = maskedByDs.get(ds.id);
      const evs = eventsByDs.get(ds.id);
      const prev = anomaliesMap[ds.id];
      m.set(ds.id, {
        dataset: ds,
        forecasts,
        // 預測引擎判斷資料可信度用的事件：離線偵測器＋瀏覽器偵測＋人工標註（被排除的才算資料不可信）
        anomalies: evs
          ? { dataset_id: ds.id, data_kind: "real", n_events: prev?.n_events ?? evs.length, disclaimer: prev?.disclaimer ?? "", limits: prev?.limits ?? [], events: toAnomalyEvents(evs) }
          : prev,
        events: evs,
        rawLastMs: md?.rawLastMs ?? null,
        overrides: thresholds.effective,
        // 匯入資料比原始資料更新時才改用匯入資料做預測（內容相同的重複匯入不降低預測品質）；
        // 沒有預計算預測的場域（資料不完整）一律用原始＋匯入資料建立簡易預測
        ...(() => {
          const importNewer = !!imp && imp.length > 0 && !!base && base.length > 0 && imp[imp.length - 1].tsMs > base[base.length - 1].tsMs;
          const nMasked = md ? md.masked.droppedRows + md.masked.maskedCells : 0;
          if (importNewer && md) return { liveRows: md.masked.rows, liveIsBase: false, maskedRows: nMasked };
          if (baselineIds.includes(ds.id) && md && md.masked.rows.length > 0) {
            return { liveRows: md.masked.rows, liveIsBase: true, maskedRows: nMasked };
          }
          return { liveRows: null, liveIsBase: false };
        })(),
        engine: engine.data[ds.id] ?? null,
      });
    }
    return m;
  }, [datasets, forecasts, anomaliesMap, thresholds, importer.imported, baseRows, engine.data, baselineIds, maskedByDs, eventsByDs]);

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
  const changeUseEngineThr = useCallback((v: boolean) => {
    setUseEngineThr(v);
    saveJson(ENG_THR_KEY, v);
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
            tasks={tasksApi.tasks}
            isAdmin={can(adminRole.role, "assign_tasks")}
            datasets={datasets}
            onOpenTasks={() => setActivePage("plan")}
            onOpenEvents={(id) => {
              setDatasetId(id);
              setActivePage("events");
            }}
          />;
      case "data":
        return <DataPage dataset={activeDataset} forecasts={forecasts} importedRows={importer.imported[activeDataset.id] ?? []} thresholds={thresholds.effective} />;
      case "decision":
        return <DecisionPage
            status={activeStatus}
            input={inputs.get(activeDataset.id)!}
            onOpenData={() => openData(activeDataset.id)}
            onOpenEvents={() => setActivePage("events")}
            canRecord={can(adminRole.role, "record_decision")}
            onLogin={() => setAdminModalOpen(true)}
          />;
      case "events":
        return (
          <EventsPage
            dataset={activeDataset}
            events={eventsByDs.get(activeDataset.id) ?? []}
            rows={maskedByDs.get(activeDataset.id)?.merged ?? null}
            masked={maskedByDs.get(activeDataset.id)?.masked ?? null}
            canManage={can(adminRole.role, "manage_events")}
            onAnnotate={(id, patch) => eventLog.annotate(id, patch, adminRole.role)}
            onAddManual={(e) => eventLog.addManual(e, adminRole.role)}
            onRemoveManual={eventLog.removeManual}
            onLogin={() => setAdminModalOpen(true)}
            historyCount={eventLog.historyCount}
          />
        );
      case "plan": {
        const openEvents = (id: string) => {
          setDatasetId(id);
          setActivePage("events");
        };
        // 員工看到的是管理員指派的任務；管理員（與展示管理員）才是長期規劃
        if (adminRole.role === "staff") {
          return <TasksPage tasks={tasksApi.tasks} error={tasksApi.error} datasets={datasets} onUpdate={tasksApi.update} onOpenEvents={openEvents} />;
        }
        return (
          <PlanPage
            datasets={datasets}
            events={eventLog.events}
            data={maskedByDs}
            allowed={can(adminRole.role, "long_term_plan")}
            onLogin={() => setAdminModalOpen(true)}
            onOpenEvents={openEvents}
            tasks={tasksApi.tasks}
            tasksPersistent={tasksApi.persistent}
            onCreateTask={tasksApi.create}
            onUpdateTask={tasksApi.update}
            onDeleteTask={tasksApi.remove}
          />
        );
      }
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
            useEngineThr={useEngineThr}
            onChangeUseEngineThr={changeUseEngineThr}
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
        openTasks={openTasks}
      >
        <PageErrorBoundary pageKey={`${activePage}:${activeDataset.id}`}>{renderPage()}</PageErrorBoundary>
      </Layout>
      <AdminModal open={adminModalOpen} onClose={() => setAdminModalOpen(false)} adminRole={adminRole} onRoleUpdated={setAdminRole} />
    </>
  );
};
export default App;
