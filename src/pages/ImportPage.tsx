import React, { useState } from "react";
import { CheckCircle2, Download, FileUp, Link2, Lock, RefreshCw, Table2, Trash2, XCircle } from "lucide-react";
import type { RealDataset } from "../../contracts/types";
import { resolveSourceUrl, type SourceKind } from "../lib/importSources";
import { planWholeSheet, type TabPlan } from "../lib/sheetImport";
import type { Importer, SourceStatus } from "../lib/useImporter";
import { Card, Chip } from "../components/ui";

interface Props {
  datasets: RealDataset[];
  datasetId: string;
  importer: Importer;
  canImport: boolean;
  onLogin: () => void;
}

type Mode = "all" | "sheet" | "url" | "file" | "paste";

const MODES: Array<{ id: Mode; label: string; icon: React.ReactNode }> = [
  { id: "all", label: "整份試算表", icon: <Table2 className="h-4 w-4" /> },
  { id: "sheet", label: "Google 試算表", icon: <Table2 className="h-4 w-4" /> },
  { id: "url", label: "CSV 網址", icon: <Link2 className="h-4 w-4" /> },
  { id: "file", label: "上傳檔案", icon: <FileUp className="h-4 w-4" /> },
  { id: "paste", label: "貼上", icon: <Table2 className="h-4 w-4" /> },
];

const EVERY = [
  { v: 0, label: "手動" },
  { v: 1, label: "每 1 分鐘" },
  { v: 5, label: "每 5 分鐘" },
  { v: 15, label: "每 15 分鐘" },
  { v: 60, label: "每小時" },
];

const StatusLine: React.FC<{ st: SourceStatus | null }> = ({ st }) => {
  if (!st) return null;
  return (
    <div className="space-y-1" data-testid="import-status">
      <div className={`inline-flex items-center gap-1.5 text-xs font-medium ${st.ok ? "text-emerald-800" : "text-red-800"}`}>
        {st.ok ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
        {st.message}
        <span className="text-slate-400 font-normal">{st.at}</span>
      </div>
      {st.matched.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {st.matched.map((m) => (
            <span key={m} className="px-1.5 py-0.5 rounded bg-emerald-50 border border-emerald-200 text-[11px] text-emerald-900">
              {m}
            </span>
          ))}
          {st.unmatched.slice(0, 6).map((m) => (
            <span key={m} className="px-1.5 py-0.5 rounded bg-slate-100 text-[11px] text-slate-500 line-through" title="未對應，已略過">
              {m}
            </span>
          ))}
        </div>
      )}
      {st.issues.length > 0 && <div className="text-[11px] text-amber-800">{st.issues.join("；")}</div>}
    </div>
  );
};

export const ImportPage: React.FC<Props> = ({ datasets, datasetId, importer, canImport, onLogin }) => {
  const [mode, setMode] = useState<Mode>("all");
  const [plans, setPlans] = useState<TabPlan[] | null>(null);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [progress, setProgress] = useState<string | null>(null);
  const [allMsg, setAllMsg] = useState<string | null>(null);
  const [target, setTarget] = useState(datasetId);
  const [url, setUrl] = useState("");
  const [every, setEvery] = useState(5);
  const [pasted, setPasted] = useState("");
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<SourceStatus | null>(null);
  const ds = datasets.find((d) => d.id === target) ?? datasets[0];

  const connect = async () => {
    const kind: SourceKind = mode === "sheet" ? "sheet" : "url";
    if (!resolveSourceUrl(kind, url)) {
      setLast({ at: "", ok: false, message: kind === "sheet" ? "請貼上 Google 試算表網址" : "請輸入 https 開頭的網址", rows: 0, added: 0, matched: [], unmatched: [], issues: [] });
      return;
    }
    setBusy(true);
    const src = importer.addSource({ kind, datasetId: target, url: url.trim(), everyMin: every });
    const st = await importer.runSource(src);
    setLast(st);
    setBusy(false);
  };

  const readAll = async () => {
    setBusy(true);
    setPlans(null);
    setAllMsg(null);
    try {
      const { plans: ps } = await planWholeSheet(url, datasets, (d, t) => setProgress(`${d}/${t}`));
      setPlans(ps);
      setPicked(Object.fromEntries(ps.map((p) => [p.tab.gid, !!p.datasetId])));
      setTargets(Object.fromEntries(ps.map((p) => [p.tab.gid, p.datasetId ?? ""])));
    } catch (e) {
      setAllMsg(e instanceof Error ? e.message : "讀取失敗");
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const importAll = () => {
    if (!plans) return;
    let ok = 0;
    let rows = 0;
    let added = 0;
    for (const p of plans) {
      const ds = targets[p.tab.gid];
      if (!picked[p.tab.gid] || !ds || !p.text) continue;
      const src = importer.addSource({ kind: "sheet", datasetId: ds, url: p.csvUrl, everyMin: every });
      const st = importer.ingestText(ds, p.text, `試算表「${p.tab.name}」`, src.id);
      if (st.ok) {
        ok += 1;
        rows += st.rows;
        added += st.added;
      }
    }
    setAllMsg(`已匯入 ${ok} 張工作表，共 ${rows} 列（新增 ${added}）${every > 0 ? `；每 ${every} 分鐘自動更新` : ""}`);
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      setLast({ at: "", ok: false, message: "檔案超過 5 MB", rows: 0, added: 0, matched: [], unmatched: [], issues: [] });
      return;
    }
    setLast(importer.ingestText(target, await file.text(), file.name));
  };

  const downloadTemplate = () => {
    const keys = ds.columns.filter((c) => c.n_observed > 0).map((c) => c.key);
    const head = ["timestamp", ...keys].map((h) => (/[",]/.test(h) ? `"${h.replace(/"/g, '""')}"` : h)).join(",");
    const blob = new Blob([`﻿${head}\n`], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${ds.id}_template.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const importedList = Object.entries(importer.imported).filter(([, r]) => r.length > 0);

  if (!canImport) {
    return (
      <Card>
        <div className="flex flex-wrap items-center gap-3" data-testid="import-locked">
          <Lock className="h-5 w-5 text-slate-400" />
          <div className="text-sm text-slate-700">資料匯入需要員工或管理員身分</div>
          <button type="button" onClick={onLogin} className="ml-auto px-4 py-1.5 rounded-md bg-[#0B63CE] text-white text-sm font-semibold">
            登入
          </button>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <Card>
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <label className="text-xs text-slate-500" htmlFor="import-target">
            匯入到
          </label>
          <select
            id="import-target"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm"
          >
            {datasets.map((d) => (
              <option key={d.id} value={d.id}>
                {d.display_name}
              </option>
            ))}
          </select>
          <button type="button" onClick={downloadTemplate} className="ml-auto inline-flex items-center gap-1.5 text-xs font-medium text-[#0B63CE] hover:underline">
            <Download className="h-3.5 w-3.5" />
            下載欄位範本
          </button>
        </div>

        <div className="flex flex-wrap gap-1.5 mb-3" role="tablist" aria-label="匯入方式">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              role="tab"
              aria-selected={mode === m.id}
              onClick={() => {
                setMode(m.id);
                setLast(null);
              }}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border text-sm font-medium ${
                mode === m.id ? "bg-[#0B63CE] border-[#0B63CE] text-white" : "bg-white border-slate-300 text-slate-700 hover:bg-slate-50"
              }`}
            >
              {m.icon}
              {m.label}
            </button>
          ))}
        </div>

        {mode === "all" && (
          <div className="space-y-3">
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://docs.google.com/spreadsheets/d/…"
              aria-label="試算表網址"
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-[#0B63CE] focus:outline-none"
            />
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void readAll()}
                disabled={busy || !url.trim()}
                className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-md bg-[#0B63CE] text-white text-sm font-semibold disabled:opacity-40"
              >
                {busy && <RefreshCw className="h-4 w-4 animate-spin" />}
                {busy && progress ? `讀取中 ${progress}` : "讀取所有工作表"}
              </button>
              <span className="text-[11px] text-slate-500">每張工作表依欄位自動對應場域</span>
            </div>
            {plans && (
              <div className="space-y-2" data-testid="sheet-plan">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-slate-500">
                        <th className="py-1 pr-2" />
                        <th className="py-1 pr-3 font-medium">工作表</th>
                        <th className="py-1 pr-3 font-medium">匯入到</th>
                        <th className="py-1 pr-3 font-medium">列數</th>
                        <th className="py-1 font-medium">時間範圍</th>
                      </tr>
                    </thead>
                    <tbody>
                      {plans.map((p) => (
                        <tr key={p.tab.gid} className="border-t border-slate-100" data-testid="sheet-plan-row">
                          <td className="py-1.5 pr-2">
                            <input
                              type="checkbox"
                              aria-label={`匯入 ${p.tab.name}`}
                              checked={!!picked[p.tab.gid]}
                              disabled={!p.text || !targets[p.tab.gid]}
                              onChange={(e) => setPicked((m) => ({ ...m, [p.tab.gid]: e.target.checked }))}
                            />
                          </td>
                          <td className="py-1.5 pr-3 text-slate-900">{p.tab.name}</td>
                          <td className="py-1.5 pr-3">
                            {p.text ? (
                              <select
                                value={targets[p.tab.gid] ?? ""}
                                onChange={(e) => setTargets((m) => ({ ...m, [p.tab.gid]: e.target.value }))}
                                aria-label={`${p.tab.name} 對應場域`}
                                className="rounded border border-slate-300 bg-white px-1.5 py-1 text-xs"
                              >
                                <option value="">（略過）</option>
                                {datasets.map((d) => (
                                  <option key={d.id} value={d.id}>
                                    {d.display_name.split("（")[0]}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <span className="text-xs text-red-700">{p.error}</span>
                            )}
                            {p.text && p.error && <span className="ml-1 text-xs text-amber-800">{p.error}</span>}
                          </td>
                          <td className="py-1.5 pr-3 tabular-nums text-slate-700">{p.rows || "—"}</td>
                          <td className="py-1.5 text-xs text-slate-500">{p.first && p.last ? `${p.first.slice(0, 10)} ～ ${p.last.slice(0, 10)}` : ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    value={every}
                    onChange={(e) => setEvery(Number(e.target.value))}
                    aria-label="更新頻率"
                    className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm"
                  >
                    {EVERY.map((e) => (
                      <option key={e.v} value={e.v}>
                        {e.label}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={importAll}
                    disabled={!plans.some((p) => picked[p.tab.gid] && targets[p.tab.gid] && p.text)}
                    className="px-4 py-1.5 rounded-md bg-[#0B63CE] text-white text-sm font-semibold disabled:opacity-40"
                  >
                    全部匯入
                  </button>
                </div>
              </div>
            )}
            {allMsg && (
              <div className={`text-xs font-medium ${/^已匯入/.test(allMsg) ? "text-emerald-800" : "text-red-800"}`} data-testid="sheet-all-msg">
                {allMsg}
              </div>
            )}
          </div>
        )}

        {(mode === "sheet" || mode === "url") && (
          <div className="space-y-2">
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={mode === "sheet" ? "https://docs.google.com/spreadsheets/d/…" : "https://…/data.csv"}
              aria-label="來源網址"
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-[#0B63CE] focus:outline-none"
            />
            {mode === "sheet" && <div className="text-[11px] text-slate-500">試算表需設為「知道連結的任何人可檢視」；第一欄為時間，欄名需與場域感測器相同。</div>}
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={every}
                onChange={(e) => setEvery(Number(e.target.value))}
                aria-label="更新頻率"
                className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm"
              >
                {EVERY.map((e) => (
                  <option key={e.v} value={e.v}>
                    {e.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => void connect()}
                disabled={busy || !url.trim()}
                className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-md bg-[#0B63CE] text-white text-sm font-semibold disabled:opacity-40"
              >
                {busy && <RefreshCw className="h-4 w-4 animate-spin" />}
                連接並匯入
              </button>
            </div>
          </div>
        )}

        {mode === "file" && (
          <label className="flex flex-col items-center justify-center gap-1.5 border-2 border-dashed border-slate-300 rounded-lg py-8 text-sm text-slate-600 cursor-pointer hover:bg-slate-50">
            <FileUp className="h-6 w-6 text-slate-400" />
            選擇 CSV 檔
            <input type="file" accept=".csv,.txt,text/csv" className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} />
          </label>
        )}

        {mode === "paste" && (
          <div className="space-y-2">
            <textarea
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              rows={6}
              aria-label="貼上資料"
              placeholder={"timestamp,TEMP,RH\n2026-11-27 08:00,25.1,61"}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm font-mono focus:border-[#0B63CE] focus:outline-none"
            />
            <button
              type="button"
              disabled={!pasted.trim()}
              onClick={() => setLast(importer.ingestText(target, pasted, "貼上"))}
              className="px-4 py-1.5 rounded-md bg-[#0B63CE] text-white text-sm font-semibold disabled:opacity-40"
            >
              匯入
            </button>
          </div>
        )}

        <div className="mt-3">
          <StatusLine st={last} />
        </div>
      </Card>

      {/* 已連接的來源 */}
      {importer.sources.length > 0 && (
        <Card title="已連接">
          <ul className="divide-y divide-slate-100" data-testid="source-list">
            {importer.sources.map((s) => {
              const dn = datasets.find((d) => d.id === s.datasetId)?.display_name ?? s.datasetId;
              const st = importer.status[s.id] ?? null;
              return (
                <li key={s.id} className="py-2.5 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-slate-900">{dn.split("（")[0]}</span>
                    <span className="text-[11px] text-slate-400 truncate max-w-[16rem]">{s.kind === "sheet" ? "試算表" : "CSV"} · {s.url}</span>
                    <div className="ml-auto flex items-center gap-1.5">
                      <select
                        value={s.everyMin}
                        onChange={(e) => importer.updateSource(s.id, { everyMin: Number(e.target.value) })}
                        aria-label="更新頻率"
                        className="rounded border border-slate-300 bg-white px-1.5 py-1 text-xs"
                      >
                        {EVERY.map((e) => (
                          <option key={e.v} value={e.v}>
                            {e.label}
                          </option>
                        ))}
                      </select>
                      <Chip onClick={() => void importer.runSource(s)}>立即更新</Chip>
                      <button type="button" aria-label="移除來源" onClick={() => importer.removeSource(s.id)} className="p-1.5 rounded hover:bg-slate-100 text-slate-500">
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                  <StatusLine st={st} />
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {/* 已匯入的資料 */}
      {importedList.length > 0 && (
        <Card title="已匯入">
          <ul className="space-y-1.5 text-sm" data-testid="imported-list">
            {importedList.map(([id, rows]) => (
              <li key={id} className="flex items-center gap-3">
                <span className="font-medium text-slate-900">{(datasets.find((d) => d.id === id)?.display_name ?? id).split("（")[0]}</span>
                <span className="text-xs text-slate-500">
                  {rows.length} 列 · {rows[0].timestamp.slice(0, 16)} ～ {rows[rows.length - 1].timestamp.slice(0, 16)}
                </span>
                <button type="button" onClick={() => importer.clearImported(id)} className="ml-auto text-xs text-slate-500 hover:text-red-700">
                  清除
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {importer.log.length > 0 && (
        <Card title="紀錄">
          <ul className="space-y-1 text-xs text-slate-600" data-testid="import-log">
            {importer.log.slice(0, 6).map((l, i) => (
              <li key={i} className="flex items-center gap-2">
                {l.ok ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-700" /> : <XCircle className="h-3.5 w-3.5 text-red-700" />}
                <span className="text-slate-400">{l.at}</span>
                <span>{l.label}</span>
                <span className="text-slate-500">{l.message}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
};
