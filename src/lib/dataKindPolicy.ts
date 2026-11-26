import type { DataKind, PageId } from "../types/app";

export const SHEEP_ONLY_PAGES: ReadonlySet<PageId> = new Set<PageId>([
  "sheep_risk",
  "sheep_actions",
  "sheep_diagnosis",
  "sheep_forecast",
  "sheep_replay",
]);

export const REAL_ONLY_GUARDED_PAGES: ReadonlySet<PageId> = new Set<PageId>([
  "decision_support",
  "sheep_risk",
  "sheep_actions",
  "sheep_diagnosis",
  "sheep_forecast",
  "sheep_replay",
]);

export const ALWAYS_REAL_CONTENT_PAGES: ReadonlySet<PageId> = new Set<PageId>([
  "domain_home",
  "model_lifecycle",
  "catalog",
  "provenance",
  "guide",
  "ai_overview",
  "decision_guide",
  "model_performance",
  "team_review",
]);

export function isRealOnlyGuardedPage(page: PageId): boolean {
  return REAL_ONLY_GUARDED_PAGES.has(page);
}

export function isNavItemVisible(
  itemId: PageId,
  tier: "daily" | "sheep" | "advanced",
  globalDataKind: DataKind,
  datasetId: string
): boolean {
  if (tier === "sheep") {
    // 「場域決策」5 頁：七個場域都有（羊舍＝正式引擎輸出；其餘＝研究預測＋假定門檻），只有真實資料模式
    return globalDataKind === "real";
  }
  if (globalDataKind === "synthetic" && REAL_ONLY_GUARDED_PAGES.has(itemId)) {
    return false;
  }
  return true;
}

/**
 * 決定頂部橫幅顯示「真實感測資料」或「合成（模擬）展示資料」：
 * - 「資料更新」頁只處理合成資料 → 永遠顯示合成橫幅
 * - 「總覽」、「資料探索與分析」依內容切換真實／合成 → 跟隨全域切換
 * - 只展示真實資料／文件之頁面（含場域看板、模型維護與進階研究頁） → 永遠顯示真實橫幅
 * - 「決策輔助」與羊舍專屬 5 頁：在真實模式顯示真實橫幅；在合成模式時隱藏於導覽，
 *   若直接進入則只顯示「此頁只有真實資料」提示與切換按鈕（不渲染任何真實內容），橫幅維持合成標示以免與按鈕語意矛盾。
 */
export function getEffectiveBannerKind(
  activePage: PageId,
  globalDataKind: DataKind
): DataKind {
  if (activePage === "data_update") {
    return "synthetic";
  }
  if (activePage === "overview" || activePage === "explorer") {
    return globalDataKind;
  }
  if (activePage === "live_forecast") {
    return "real";
  }
  if (ALWAYS_REAL_CONTENT_PAGES.has(activePage)) {
    return "real";
  }
  if (REAL_ONLY_GUARDED_PAGES.has(activePage)) {
    return globalDataKind;
  }
  return globalDataKind;
}
