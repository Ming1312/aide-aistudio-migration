// Google 試算表「整份匯入」：從網址取出試算表 ID，並從 htmlview 頁面解析所有工作表（名稱＋gid）。
// 前端與伺服器共用；只做字串處理。
export interface SheetTab {
  name: string;
  gid: string;
}

export function extractSheetId(input: string): string | null {
  try {
    const u = new URL(input.trim());
    if (u.hostname !== "docs.google.com") return null;
    return u.pathname.match(/^\/spreadsheets\/d\/(?!e\/)([A-Za-z0-9_-]{20,})/)?.[1] ?? null;
  } catch {
    return null;
  }
}

export function sheetTabsUrl(id: string): string {
  return `https://docs.google.com/spreadsheets/d/${id}/htmlview`;
}

export function sheetCsvUrl(id: string, gid: string): string {
  return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${encodeURIComponent(gid)}`;
}

/** 解析 htmlview 頁面裡的 items.push({name: "…", …, gid: "…"}) */
export function parseSheetTabs(html: string): SheetTab[] {
  const tabs: SheetTab[] = [];
  const re = /items\.push\(\{name:\s*"((?:[^"\\]|\\.)*)"[^}]*?gid:\s*"(\d+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    let name = m[1];
    try {
      name = JSON.parse(`"${m[1].replace(/\\x([0-9a-fA-F]{2})/g, "\\u00$1")}"`);
    } catch {
      /* 保留原字串 */
    }
    if (!tabs.some((t) => t.gid === m![2])) tabs.push({ name, gid: m[2] });
  }
  return tabs;
}
