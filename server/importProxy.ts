// 資料匯入中心的伺服器端取檔：只允許 https、白名單網域、體積與逾時上限，手動追蹤轉址（每一跳都重新檢查）。
// 不帶任何憑證；試算表必須是「知道連結的任何人可檢視」或「發布到網路」。
export const DEFAULT_IMPORT_HOSTS = [
  "docs.google.com",
  "drive.google.com",
  "googleusercontent.com",
  "raw.githubusercontent.com",
  "gist.githubusercontent.com",
];
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
export const IMPORT_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;

export function parseExtraHosts(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^[a-z0-9.-]+$/.test(s));
}

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

export function checkImportUrl(raw: string, extraHosts: string[] = []): UrlCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "網址格式不正確" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "只接受 https 網址" };
  if (url.username || url.password) return { ok: false, reason: "網址不可含帳號密碼" };
  if (url.port && url.port !== "443") return { ok: false, reason: "不接受自訂連接埠" };
  const host = url.hostname.toLowerCase();
  const allowed = [...DEFAULT_IMPORT_HOSTS, ...extraHosts].some((h) => host === h || host.endsWith(`.${h}`));
  if (!allowed) return { ok: false, reason: `不在允許的網域清單內：${host}` };
  return { ok: true, url };
}

export type FetchLike = (url: string, init: { redirect: "manual"; signal: AbortSignal; headers: Record<string, string> }) => Promise<Response>;

export async function fetchImportText(
  raw: string,
  extraHosts: string[] = [],
  fetchImpl: FetchLike = fetch as unknown as FetchLike
): Promise<{ ok: true; text: string } | { ok: false; status: number; reason: string }> {
  let current = raw;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const check = checkImportUrl(current, extraHosts);
    if (!check.ok) return { ok: false, status: 400, reason: check.reason };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), IMPORT_TIMEOUT_MS);
    try {
      const res = await fetchImpl(check.url.toString(), {
        redirect: "manual",
        signal: ctl.signal,
        headers: { Accept: "text/csv,text/plain,*/*" },
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) return { ok: false, status: 502, reason: "轉址缺少目的地" };
        current = new URL(loc, check.url).toString();
        continue;
      }
      if (!res.ok) {
        return { ok: false, status: 502, reason: `來源回應 HTTP ${res.status}（試算表是否已開放檢視？）` };
      }
      const len = Number(res.headers.get("content-length") ?? "0");
      if (len > MAX_IMPORT_BYTES) return { ok: false, status: 413, reason: "檔案超過 5 MB" };
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength > MAX_IMPORT_BYTES) return { ok: false, status: 413, reason: "檔案超過 5 MB" };
      return { ok: true, text: new TextDecoder("utf-8").decode(buf) };
    } catch {
      return { ok: false, status: 502, reason: "取檔失敗或逾時" };
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, status: 502, reason: "轉址次數過多" };
}
