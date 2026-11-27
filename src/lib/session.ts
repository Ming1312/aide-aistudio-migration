// 登入狀態的備援：有些環境（手機瀏覽器、App 內建瀏覽器、AI Studio 的內嵌預覽）會擋掉「跨站內嵌頁面」的 cookie，
// 登入後角色就掉回訪客。伺服器在 /api/admin/role 回傳連線代號，這裡存在 localStorage，之後每個 /api 請求用
// X-Aide-Session 標頭帶回去；cookie 能用時兩者是同一個代號。
const KEY = "aide.session.v1";

export function sessionHeaders(): Record<string, string> {
  try {
    const s = window.localStorage.getItem(KEY);
    return s ? { "X-Aide-Session": s } : {};
  } catch {
    return {};
  }
}

export function rememberSession(session: unknown): void {
  if (typeof session !== "string" || !/^[a-zA-Z0-9-]{8,64}$/.test(session)) return;
  try {
    if (!window.localStorage.getItem(KEY)) window.localStorage.setItem(KEY, session);
  } catch {
    /* 私人視窗或被封鎖：只靠 cookie */
  }
}
