// 匯入來源：Google 試算表網址正規化、取檔（先直連、被 CORS 擋下時走伺服器代理）。
export type SourceKind = "sheet" | "url";

/** 把 Google 試算表的分享／編輯網址轉成 CSV 匯出網址；已是匯出或發布網址則原樣回傳。 */
export function normalizeSheetUrl(input: string): string | null {
  const raw = input.trim();
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.hostname !== "docs.google.com") return null;
  const published = u.pathname.match(/^\/spreadsheets\/d\/e\/[^/]+\/pub/);
  if (published) {
    if (!u.searchParams.get("output")) u.searchParams.set("output", "csv");
    return u.toString();
  }
  const m = u.pathname.match(/^\/spreadsheets\/d\/([^/]+)/);
  if (!m) return null;
  if (u.pathname.endsWith("/export") && u.searchParams.get("format") === "csv") return u.toString();
  const gidFromHash = u.hash.match(/gid=(\d+)/)?.[1];
  const gid = u.searchParams.get("gid") ?? gidFromHash ?? "0";
  return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv&gid=${encodeURIComponent(gid)}`;
}

export function resolveSourceUrl(kind: SourceKind, input: string): string | null {
  if (kind === "sheet") return normalizeSheetUrl(input);
  try {
    const u = new URL(input.trim());
    return u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

export async function fetchCsvText(url: string): Promise<{ text: string; via: "direct" | "proxy" }> {
  try {
    const res = await fetch(url, { redirect: "follow" });
    if (res.ok) return { text: await res.text(), via: "direct" };
  } catch {
    /* CORS 或網路：改走代理 */
  }
  let res: Response;
  try {
    res = await fetch(`/api/import/fetch?url=${encodeURIComponent(url)}`);
  } catch {
    throw new Error("無法連線：請確認網路，或改用上傳檔案");
  }
  const data = (await res.json().catch(() => ({}))) as { text?: string; detail?: string };
  if (!res.ok || typeof data.text !== "string") {
    throw new Error(data.detail || `取檔失敗（HTTP ${res.status}）`);
  }
  return { text: data.text, via: "proxy" };
}
