// 匯入控制器：管理來源設定、定時輪詢、累積匯入列。放在 App 層，切換頁面也不會中斷。
import { useCallback, useEffect, useRef, useState } from "react";
import type { RealCatalog } from "../../contracts/types";
import type { ParsedCsvRow } from "../types/app";
import { fetchCsvText, resolveSourceUrl, type SourceKind } from "./importSources";
import { accumulateImported, parseImportedText } from "./liveSeries";
import { loadJson, saveJson } from "./storage";

export interface ImportSource {
  id: string;
  kind: SourceKind;
  datasetId: string;
  url: string;
  /** 0 = 不自動更新（分鐘） */
  everyMin: number;
}

export interface SourceStatus {
  at: string | null;
  ok: boolean;
  message: string;
  rows: number;
  added: number;
  matched: string[];
  unmatched: string[];
  issues: string[];
}

export interface ImportLogEntry {
  at: string;
  datasetId: string;
  label: string;
  rows: number;
  added: number;
  ok: boolean;
  message: string;
}

const SOURCES_KEY = "aide.import.sources.v1";

export function useImporter(catalog: RealCatalog | null, pollEnabled = true) {
  const [sources, setSources] = useState<ImportSource[]>(() => loadJson<ImportSource[]>(SOURCES_KEY, []));
  const [imported, setImported] = useState<Record<string, ParsedCsvRow[]>>({});
  const [status, setStatus] = useState<Record<string, SourceStatus>>({});
  const [log, setLog] = useState<ImportLogEntry[]>([]);
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;
  const catalogRef = useRef(catalog);
  catalogRef.current = catalog;
  const importedRef = useRef(imported);
  importedRef.current = imported;

  useEffect(() => saveJson(SOURCES_KEY, sources), [sources]);

  const pushLog = useCallback((e: ImportLogEntry) => setLog((l) => [e, ...l].slice(0, 30)), []);

  /** 把一段 CSV 文字匯入指定場域；回傳摘要。 */
  const ingestText = useCallback(
    (datasetId: string, text: string, label: string, sourceId?: string): SourceStatus => {
      const ds = catalogRef.current?.datasets.find((d) => d.id === datasetId);
      const at = new Date().toLocaleString("zh-TW", { hour12: false });
      if (!ds) {
        const st: SourceStatus = { at, ok: false, message: "找不到場域", rows: 0, added: 0, matched: [], unmatched: [], issues: [] };
        return st;
      }
      const parsed = parseImportedText(text, ds.columns);
      const prev = importedRef.current[datasetId] ?? [];
      const known = new Set(prev.map((r) => r.tsMs));
      const added = parsed.rows.filter((r) => !known.has(r.tsMs)).length;
      const ok = parsed.rows.length > 0 && Object.keys(parsed.matched).length > 0;
      if (ok) {
        setImported((m) => ({ ...m, [datasetId]: accumulateImported(m[datasetId] ?? [], parsed.rows) }));
      }
      const st: SourceStatus = {
        at,
        ok,
        message: ok ? `匯入 ${parsed.rows.length} 列（新增 ${added}）` : parsed.issues[0] ?? "沒有可匯入的資料",
        rows: parsed.rows.length,
        added,
        matched: Object.values(parsed.matched),
        unmatched: parsed.unmatched,
        issues: parsed.issues,
      };
      if (sourceId) setStatus((s) => ({ ...s, [sourceId]: st }));
      pushLog({ at, datasetId, label, rows: parsed.rows.length, added, ok, message: st.message });
      return st;
    },
    [pushLog]
  );

  const runSource = useCallback(
    async (src: ImportSource): Promise<SourceStatus> => {
      const at = new Date().toLocaleString("zh-TW", { hour12: false });
      const url = resolveSourceUrl(src.kind, src.url);
      if (!url) {
        const st: SourceStatus = { at, ok: false, message: "網址不正確", rows: 0, added: 0, matched: [], unmatched: [], issues: [] };
        setStatus((s) => ({ ...s, [src.id]: st }));
        return st;
      }
      try {
        const { text } = await fetchCsvText(url);
        return ingestText(src.datasetId, text, src.kind === "sheet" ? "Google 試算表" : "CSV 網址", src.id);
      } catch (e) {
        const st: SourceStatus = {
          at,
          ok: false,
          message: e instanceof Error ? e.message : "取檔失敗",
          rows: 0,
          added: 0,
          matched: [],
          unmatched: [],
          issues: [],
        };
        setStatus((s) => ({ ...s, [src.id]: st }));
        pushLog({ at, datasetId: src.datasetId, label: src.kind === "sheet" ? "Google 試算表" : "CSV 網址", rows: 0, added: 0, ok: false, message: st.message });
        return st;
      }
    },
    [ingestText, pushLog]
  );

  const addSource = useCallback((src: Omit<ImportSource, "id">): ImportSource => {
    const full = { ...src, id: `src-${Date.now().toString(36)}` };
    setSources((s) => [...s, full]);
    return full;
  }, []);

  const updateSource = useCallback((id: string, patch: Partial<ImportSource>) => {
    setSources((s) => s.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  }, []);

  const removeSource = useCallback((id: string) => {
    setSources((s) => s.filter((x) => x.id !== id));
    setStatus((s) => {
      const { [id]: _drop, ...rest } = s;
      return rest;
    });
  }, []);

  const clearImported = useCallback((datasetId: string) => {
    setImported((m) => {
      const { [datasetId]: _drop, ...rest } = m;
      return rest;
    });
  }, []);

  // 定時輪詢：每個設定了間隔的來源一個計時器；輪詢到才抓，頁面開著才會更新
  useEffect(() => {
    if (!pollEnabled) return;
    const timers = sources
      .filter((s) => s.everyMin > 0)
      .map((s) => window.setInterval(() => void runSource(s), s.everyMin * 60_000));
    return () => timers.forEach((t) => window.clearInterval(t));
  }, [sources, runSource, pollEnabled]);

  return { sources, imported, status, log, ingestText, runSource, addSource, updateSource, removeSource, clearImported };
}

export type Importer = ReturnType<typeof useImporter>;
