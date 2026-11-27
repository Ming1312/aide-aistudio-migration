import React, { useEffect, useState } from "react";
import { ChevronRight, Lock, RefreshCw, Unlock } from "lucide-react";
import type { RealDataset } from "../../contracts/types";
import { CANDIDATE_POLICIES } from "../lib/candidateRisk";
import { DEFAULT_PCT, PCT_MAX, PCT_MIN, validPct, type Pct, type ThresholdMap } from "../lib/thresholds";
import { loadDataUseStatement } from "../lib/dataLoader";
import type { ThresholdOverrides } from "../lib/status";
import type { EngineState } from "../lib/useEngine";
import { ADMIN_ROLE_LABEL, type AdminRoleStatus } from "../types/app";
import { Card } from "../components/ui";

interface Props {
  datasets: RealDataset[];
  defaultDatasetId: string;
  onChangeDefaultDataset: (id: string) => void;
  overrides: ThresholdOverrides;
  onChangeOverrides: (next: ThresholdOverrides) => void;
  adminRole: AdminRoleStatus;
  onOpenAdmin: () => void;
  canEditThresholds: boolean;
  /** 實際使用的門檻（管理員調整 ＞ 歷史計算 ＞ 假定值）與純歷史計算的門檻 */
  thresholds: ThresholdMap;
  historyThresholds: ThresholdMap;
  pct: Pct;
  onChangePct: (next: Pct) => void;
  /** null = 這個角色看不到引擎狀態 */
  engine: EngineState | null;
}

const Fold: React.FC<{ title: string; children: React.ReactNode; onOpen?: () => void }> = ({ title, children, onOpen }) => (
  <details
    className="group border border-slate-200 rounded-md bg-white"
    onToggle={(e) => (e.currentTarget as HTMLDetailsElement).open && onOpen?.()}
  >
    <summary className="flex items-center gap-2 px-3 py-2.5 cursor-pointer text-sm font-medium text-slate-900 list-none">
      <ChevronRight className="h-4 w-4 text-slate-400 transition-transform group-open:rotate-90" />
      {title}
    </summary>
    <div className="px-4 pb-3 pt-0.5 text-sm text-slate-700 space-y-1.5 leading-relaxed">{children}</div>
  </details>
);

export const SettingsPage: React.FC<Props> = ({
  datasets,
  defaultDatasetId,
  onChangeDefaultDataset,
  overrides,
  onChangeOverrides,
  adminRole,
  onOpenAdmin,
  canEditThresholds,
  thresholds,
  historyThresholds,
  pct,
  onChangePct,
  engine,
}) => {
  const [pctDraft, setPctDraft] = useState({ caution: String(Math.round(pct.caution * 1000) / 10), alarm: String(Math.round(pct.alarm * 1000) / 10) });
  const draftPct: Pct = { caution: Number(pctDraft.caution) / 100, alarm: Number(pctDraft.alarm) / 100 };
  const draftOk = validPct(draftPct);
  const draftChanged = draftOk && (draftPct.caution !== pct.caution || draftPct.alarm !== pct.alarm);
  const [statement, setStatement] = useState<string | null>(null);
  const [wantStatement, setWantStatement] = useState(false);
  useEffect(() => {
    if (!wantStatement || statement !== null) return;
    loadDataUseStatement()
      .then(setStatement)
      .catch(() => setStatement("無法載入"));
  }, [wantStatement, statement]);

  const setThreshold = (id: string, field: "caution" | "alarm", raw: string) => {
    const base = CANDIDATE_POLICIES[id];
    if (!base) return;
    const v = Number(raw);
    if (!Number.isFinite(v)) return;
    const cur = overrides[id] ?? thresholds[id] ?? { caution: base.caution, alarm: base.alarm };
    onChangeOverrides({ ...overrides, [id]: { caution: cur.caution, alarm: cur.alarm, [field]: v } });
  };
  const reset = (id: string) => {
    const { [id]: _drop, ...rest } = overrides;
    onChangeOverrides(rest);
  };

  return (
    <div className="space-y-3">
      <Card title="基本">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <label className="flex items-center gap-2 text-sm text-slate-700">
            預設場域
            <select
              value={defaultDatasetId}
              onChange={(e) => onChangeDefaultDataset(e.target.value)}
              className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm"
            >
              {datasets.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.display_name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={onOpenAdmin}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md border border-slate-300 bg-white text-sm text-slate-800 hover:bg-slate-50"
          >
            {adminRole.role === "viewer" ? <Lock className="h-4 w-4 text-slate-400" /> : <Unlock className="h-4 w-4 text-emerald-700" />}
            角色：{ADMIN_ROLE_LABEL[adminRole.role]}
          </button>
        </div>
      </Card>

      {engine && (
        <Card
          title="引擎連線"
          right={
            <button
              type="button"
              onClick={engine.refresh}
              disabled={engine.busy}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-[#0B63CE] hover:underline disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${engine.busy ? "animate-spin" : ""}`} />
              重新檢查
            </button>
          }
        >
          <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2 text-sm" data-testid="engine-card">
            <div>
              <dt className="text-xs text-slate-500">狀態</dt>
              <dd className={`font-semibold ${engine.connected ? "text-emerald-700" : "text-slate-600"}`}>
                {!engine.checked ? "檢查中…" : engine.connected ? "已連線" : "未連線"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">資料來源</dt>
              <dd className="text-slate-900">{engine.connected ? (engine.synthetic ? "引擎模擬資料流" : "引擎即時資料") : "離線預計算"}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">版本／模式</dt>
              <dd className="text-slate-900">
                {engine.version ?? "—"}
                {engine.connected && <span className="text-slate-500">・{engine.readOnly ? "唯讀" : "可寫"}</span>}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">最後檢查</dt>
              <dd className="text-slate-900">{engine.lastAt ?? "—"}</dd>
            </div>
          </dl>
          {!engine.connected && engine.checked && (
            <div className="mt-2 text-xs text-slate-500">{engine.error ?? "尚未設定引擎，使用離線預計算結果"}（做法見下方「連接電腦上的引擎」）</div>
          )}
        </Card>
      )}

      <Card
        title="風險門檻"
        right={<span className="text-[10px] text-slate-500">{canEditThresholds ? "預設由歷史資料計算，可手動調整" : "預設由歷史資料計算；修改需要管理員身分"}</span>}
      >
        <div className="flex flex-wrap items-end gap-x-4 gap-y-2 mb-3" data-testid="pct-controls">
          <label className="text-xs text-slate-600">
            注意百分位（%）
            <input
              type="number"
              step="0.5"
              min={PCT_MIN * 100}
              max={PCT_MAX * 100}
              value={pctDraft.caution}
              disabled={!canEditThresholds}
              aria-label="注意百分位"
              onChange={(e) => setPctDraft((d) => ({ ...d, caution: e.target.value }))}
              className="block mt-0.5 w-20 rounded border border-slate-300 px-2 py-1 text-sm tabular-nums disabled:bg-slate-50 disabled:text-slate-500"
            />
          </label>
          <label className="text-xs text-slate-600">
            警戒百分位（%）
            <input
              type="number"
              step="0.5"
              min={PCT_MIN * 100}
              max={PCT_MAX * 100}
              value={pctDraft.alarm}
              disabled={!canEditThresholds}
              aria-label="警戒百分位"
              onChange={(e) => setPctDraft((d) => ({ ...d, alarm: e.target.value }))}
              className="block mt-0.5 w-20 rounded border border-slate-300 px-2 py-1 text-sm tabular-nums disabled:bg-slate-50 disabled:text-slate-500"
            />
          </label>
          {canEditThresholds && (
            <>
              <button
                type="button"
                disabled={!draftChanged}
                onClick={() => onChangePct(draftPct)}
                className="px-3 py-1.5 rounded-md bg-[#0B63CE] text-white text-xs font-semibold disabled:opacity-40"
              >
                套用
              </button>
              <button
                type="button"
                onClick={() => {
                  onChangePct(DEFAULT_PCT);
                  setPctDraft({ caution: "90", alarm: "97.5" });
                }}
                className="text-xs text-slate-500 hover:underline"
              >
                恢復 P90／P97.5
              </button>
              {!draftOk && <span className="text-xs text-red-700">需 {PCT_MIN * 100}～{PCT_MAX * 100}，且警戒 ≥ 注意</span>}
            </>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="threshold-table">
            <thead>
              <tr className="text-left text-xs text-slate-500">
                <th className="py-1 pr-3 font-medium">場域</th>
                <th className="py-1 pr-3 font-medium">感測器</th>
                <th className="py-1 pr-3 font-medium">注意</th>
                <th className="py-1 pr-3 font-medium">警戒</th>
                <th className="py-1 font-medium">來源</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {datasets.map((d) => {
                const p = CANDIDATE_POLICIES[d.id];
                if (!p) {
                  return (
                    <tr key={d.id} className="border-t border-slate-100 text-slate-400">
                      <td className="py-1.5 pr-3">{d.display_name.split("（")[0]}</td>
                      <td colSpan={5}>無風險模型</td>
                    </tr>
                  );
                }
                const o = overrides[d.id];
                const eff = thresholds[d.id] ?? { caution: p.caution, alarm: p.alarm, source: undefined, note: "假定值（沒有歷史資料可算）" };
                const hist = historyThresholds[d.id];
                return (
                  <tr key={d.id} className="border-t border-slate-100" data-source={o ? "admin" : hist ? "history" : "assumed"}>
                    <td className="py-1.5 pr-3 text-slate-900">{d.display_name.split("（")[0]}</td>
                    <td className="py-1.5 pr-3 text-slate-600">
                      {p.sensor} <span className="text-slate-400">{p.unit}</span> <span className="text-slate-400">{p.direction === "above" ? "↑" : "↓"}</span>
                    </td>
                    {(["caution", "alarm"] as const).map((f) => (
                      <td key={f} className="py-1.5 pr-3">
                        <input
                          type="number"
                          step="any"
                          aria-label={`${d.display_name} ${f === "caution" ? "注意" : "警戒"}`}
                          value={eff[f]}
                          disabled={!canEditThresholds}
                          onChange={(e) => setThreshold(d.id, f, e.target.value)}
                          className={`w-20 rounded border px-2 py-1 text-sm tabular-nums disabled:bg-slate-50 disabled:text-slate-500 ${o ? "border-[#0B63CE] bg-[#EFF6FF]" : "border-slate-300"}`}
                        />
                      </td>
                    ))}
                    <td className="py-1.5 pr-2 text-[11px] text-slate-500 max-w-[14rem]">
                      {o ? (
                        <span>
                          管理員調整
                          {hist && (
                            <span className="text-slate-400">
                              （歷史計算：{hist.caution}／{hist.alarm}）
                            </span>
                          )}
                        </span>
                      ) : (
                        eff.note
                      )}
                    </td>
                    <td className="py-1.5">
                      {o && canEditThresholds && (
                        <button type="button" onClick={() => reset(d.id)} className="text-xs text-[#0B63CE] hover:underline whitespace-nowrap">
                          {hist ? "重設為歷史計算" : "重設"}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="分析原理">
        <div className="space-y-2" data-testid="principles">
          <Fold title="安全等級怎麼來">
            <p>每個場域用一個代表感測器，搭配「注意」「警戒」兩條門檻。取「現在」「+1 小時」「+3 小時」中最嚴重的一個當整體等級。</p>
            <p>感測器可信度不足時，改顯示「先確認資料」，避免依壞資料做決策。</p>
            <p>門檻預設由該感測器的歷史資料算出：注意＝第 90 百分位、警戒＝第 97.5 百分位（越低越危險的感測器取對稱的下尾），略過偵測器標出的斷電歸零時段。這是「統計上多罕見」，不是安全標準，也不是資料提供者確認的值；整段歷史都拿來算，所以對歷史資料本身是樣本內的結果。管理員可以改百分位或直接改數字；匯入新資料後會用合併資料重算。</p>
          </Fold>
          <Fold title="預測怎麼算">
            <p>預設使用預先算好的研究預測（六種方法，預設該任務最佳的基準）。匯入新資料後，改在瀏覽器內用簡易基準預測（持續性）。</p>
            <p>預測是探索性的，沒有經過獨立前瞻驗證。</p>
          </Fold>
          <Fold title="區間與機率">
            <p>區間：用最近 72 筆已知誤差做 split-conformal，名目 90%。越過門檻機率：同一批誤差的經驗分布。</p>
            <p>警報線：只用當時已發生的事件，以「抓到 90% 事件」為目標；代價是誤報偏高。全部只用起點當下已抵達的資料。</p>
          </Fold>
          <Fold title="感測器可信度">
            <p>連續 6 小時讀值完全相同，或前 24 小時內偵測到卡值、漂移、斷線候選事件，就標為可信度不足。候選事件需人工確認，不是故障判定。</p>
          </Fold>
          <Fold title="連接電腦上的引擎">
            <p>1. 在你的電腦啟動引擎（需要 Docker）：<code className="text-xs bg-slate-100 px-1 rounded">bash demo_kit/start_local.sh</code></p>
            <p>2. 用這個指令啟動本 App，它會自動讀取金鑰（不顯示）並連到 127.0.0.1:8088：<code className="text-xs bg-slate-100 px-1 rounded">bash scripts/dev_with_engine.sh</code></p>
            <p>3. 回到這裡按「重新檢查」。連上後，總覽與決策改用引擎的即時預測，每 30 秒更新；引擎沒開時自動回到離線預計算。</p>
            <p>引擎內建的資料流是模擬（合成）資料，畫面會標示。App 只讀取、不寫入引擎。</p>
          </Fold>
          <Fold title="匯入資料">
            <p>欄名需與場域感測器相同（或原始表頭）；第一欄為時間。同一時間的新資料會覆蓋舊資料，並以小時平均處理。至少 72 小時歷史才會產生預測。</p>
            <p>Google 試算表需設為「知道連結的任何人可檢視」；伺服器只代取白名單網域的檔案。更新頻率在頁面開著時才會執行。</p>
          </Fold>
          <Fold title="限制">
            <p>系統不控制任何設備；所有處置由人員決定。預計算資料截至各場域資料結束時間，不是即時。</p>
          </Fold>
          <Fold title="資料來源與使用聲明" onOpen={() => setWantStatement(true)}>
            <pre className="whitespace-pre-wrap text-xs text-slate-600 font-sans max-h-72 overflow-y-auto">{statement ?? "載入中…"}</pre>
          </Fold>
        </div>
      </Card>
    </div>
  );
};
