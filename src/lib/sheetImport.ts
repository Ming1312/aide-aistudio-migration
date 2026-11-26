// 整份 Google 試算表一次匯入：列出所有工作表 → 逐張取 CSV → 依欄位自動判斷屬於哪個場域。
import type { RealDataset } from "../../contracts/types";
import { extractSheetId, sheetCsvUrl, type SheetTab } from "../../contracts/sheetTabs";
import { fetchCsvText } from "./importSources";
import { parseImportedText } from "./liveSeries";

export interface TabPlan {
  tab: SheetTab;
  text: string | null;
  error: string | null;
  /** 自動判斷的場域（欄位對應最多者）；null＝沒有可用對應 */
  datasetId: string | null;
  rows: number;
  matched: number;
  first: string | null;
  last: string | null;
  csvUrl: string;
}

/** 依欄位判斷場域：與原始表頭完全相同的欄位權重最高，其次是欄名相符數、最後是工作表名稱。至少要對上 2 欄。 */
export function guessDataset(tabName: string, text: string, datasets: RealDataset[]): { datasetId: string; score: number; matched: number } | null {
  let best: { datasetId: string; score: number; matched: number } | null = null;
  for (const ds of datasets) {
    const p = parseImportedText(text, ds.columns);
    const matched = Object.keys(p.matched).length;
    if (matched < 2 || p.rows.length === 0) continue;
    const short = ds.display_name.split("（")[0];
    const nameBonus = tabName && (short.includes(tabName) || tabName.includes(short)) ? 500 : 0;
    const score = p.exactMatches * 1000 + matched + nameBonus;
    if (!best || score > best.score) best = { datasetId: ds.id, score, matched };
  }
  return best;
}

export async function listSheetTabs(url: string): Promise<{ id: string; tabs: SheetTab[] }> {
  let res: Response;
  try {
    res = await fetch(`/api/import/sheet-tabs?url=${encodeURIComponent(url)}`);
  } catch {
    throw new Error("連不上資料伺服器（網頁伺服器可能已關閉）");
  }
  const data = (await res.json().catch(() => ({}))) as { id?: string; tabs?: SheetTab[]; detail?: string };
  if (!res.ok || !data.id || !data.tabs) throw new Error(data.detail || `讀取工作表失敗（HTTP ${res.status}）`);
  return { id: data.id, tabs: data.tabs };
}

/** 讀取整份試算表並產生每張工作表的匯入計畫（不寫入任何資料）。 */
export async function planWholeSheet(
  url: string,
  datasets: RealDataset[],
  onProgress?: (done: number, total: number) => void
): Promise<{ id: string; plans: TabPlan[] }> {
  if (!extractSheetId(url)) throw new Error("請貼上 Google 試算表網址");
  const { id, tabs } = await listSheetTabs(url);
  const plans: TabPlan[] = [];
  for (let i = 0; i < tabs.length; i++) {
    const tab = tabs[i];
    const csvUrl = sheetCsvUrl(id, tab.gid);
    try {
      const { text } = await fetchCsvText(csvUrl);
      const guess = guessDataset(tab.name, text, datasets);
      const ds = guess ? datasets.find((d) => d.id === guess.datasetId) : undefined;
      const parsed = ds ? parseImportedText(text, ds.columns) : null;
      plans.push({
        tab,
        text,
        error: guess ? null : "欄位對不到任何場域",
        datasetId: guess?.datasetId ?? null,
        rows: parsed?.rows.length ?? 0,
        matched: guess?.matched ?? 0,
        first: parsed?.rows[0]?.timestamp ?? null,
        last: parsed?.rows[parsed.rows.length - 1]?.timestamp ?? null,
        csvUrl,
      });
    } catch (e) {
      plans.push({ tab, text: null, error: e instanceof Error ? e.message : "取檔失敗", datasetId: null, rows: 0, matched: 0, first: null, last: null, csvUrl });
    }
    onProgress?.(i + 1, tabs.length);
  }
  return { id, plans };
}
