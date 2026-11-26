// 管理者解鎖（伺服器端；與 Python 的 p62_access 同一種雜湊格式：pbkdf2$<迭代>$<鹽hex>$<雜湊hex>）。
// 預設唯讀：沒有設定雜湊＝所有人唯讀（fail closed）；5 次錯誤鎖定該連線；密碼不存、不記錄。
// 產生雜湊：python tools/make_admin_hash.py（在你自己的終端機；輸入不會顯示）→ 把 admin_passphrase_hash 的值放進 AI Studio Secrets 的 ADMIN_PASSPHRASE_HASH。
import { pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";

export function verifyHash(passphrase: string, stored: string | undefined | null): boolean {
  try {
    const [kind, it, saltHex, want] = String(stored ?? "").split("$");
    if (kind !== "pbkdf2" || !passphrase || !/^[0-9a-f]+$/i.test(saltHex ?? "") || !/^[0-9a-f]+$/i.test(want ?? "")) return false;
    const iters = Number(it);
    if (!Number.isInteger(iters) || iters < 100_000 || iters > 5_000_000) return false;
    const got = pbkdf2Sync(Buffer.from(passphrase, "utf8"), Buffer.from(saltHex, "hex"), iters, want.length / 2, "sha256");
    const exp = Buffer.from(want, "hex");
    return got.length === exp.length && timingSafeEqual(got, exp);
  } catch { return false; }
}

export function makeHash(passphrase: string, iters = 200_000): string {
  const salt = randomBytes(16);
  return `pbkdf2$${iters}$${salt.toString("hex")}$${pbkdf2Sync(Buffer.from(passphrase, "utf8"), salt, iters, 32, "sha256").toString("hex")}`;
}

export type Role = "viewer" | "staff" | "demo_admin" | "admin";
export interface LoginResult { ok: boolean; role: Role; remaining: number; locked: boolean; message: string }

/**
 * 展示用預設帳號（公開寫在程式與文件裡，所以**絕對不能**取得任何寫入權限）。
 * - 只有在「沒有設定正式管理者（ADMIN_PASSPHRASE_HASH）」時才可登入；一旦設定正式管理者，預設帳號自動停用。
 * - 角色是 demo_admin（展示管理者）：能看「管理狀態」面板、操作展示功能；
 *   伺服器永遠不會替它轉送 ENGINE_ADMIN_KEY，也不會讓它呼叫引擎的任何寫入端點。
 * - 可用環境變數 ADMIN_DEMO_DISABLED=1 完全關閉。
 */
export const DEMO_ACCOUNT = "demo";
export const DEMO_PASSWORD = "aide-demo";
export const DEFAULT_REAL_ACCOUNT = "admin";
/** 展示用的員工帳號（同樣是公開值；只有員工的權限，沒有管理權限） */
export const DEMO_STAFF_ACCOUNT = "staff";
export const DEMO_STAFF_PASSWORD = "aide-staff";
export const DEFAULT_STAFF_ACCOUNT = "staff";

export interface AdminGateOptions {
  /** 正式管理者的帳號名稱（預設 admin） */
  account?: string;
  /** 是否在「沒有設定任何正式帳號」時開放展示預設帳號 */
  demoEnabled?: boolean;
  /** 正式員工帳號的雜湊（STAFF_PASSPHRASE_HASH）與名稱（預設 staff） */
  staffHash?: string;
  staffAccount?: string;
}

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

const normAccount = (v: string | undefined | null) => String(v ?? "").trim().toLowerCase();

export class AdminGate {
  private sessions = new Map<string, Role>();
  private fails = new Map<string, number>();
  private readonly hash: string | undefined;
  private readonly maxTries: number;
  private readonly account: string;
  private readonly demoEnabled: boolean;
  private readonly staffHash: string | undefined;
  private readonly staffAccount: string;
  constructor(hash: string | undefined, maxTries = 5, opts: AdminGateOptions = {}) {
    this.hash = hash;
    this.maxTries = maxTries;
    this.account = normAccount(opts.account) || DEFAULT_REAL_ACCOUNT;
    this.demoEnabled = opts.demoEnabled === true;
    this.staffHash = opts.staffHash || undefined;
    this.staffAccount = normAccount(opts.staffAccount) || DEFAULT_STAFF_ACCOUNT;
  }
  /** 是否設定了正式員工帳號（雜湊） */
  staffConfigured(): boolean { return !!this.staffHash; }
  realStaffAccountName(): string { return this.staffAccount; }
  /** 是否設定了正式管理者（雜湊） */
  configured(): boolean { return !!this.hash; }
  /** 展示預設帳號（demo、staff）目前是否可用：沒有設定任何正式帳號（管理者或員工）且未被停用 */
  demoAvailable(): boolean { return !this.hash && !this.staffHash && this.demoEnabled; }
  realAccountName(): string { return this.account; }
  role(sessionId: string): Role { return this.sessions.get(sessionId) ?? "viewer"; }
  private fail(sessionId: string, used: number): LoginResult {
    this.fails.set(sessionId, used + 1);
    const remaining = this.maxTries - used - 1;
    return { ok: false, role: "viewer", remaining, locked: remaining <= 0, message: `帳號或密碼不正確（已錯 ${used + 1} 次，最多 ${this.maxTries} 次）` };
  }
  /**
   * login(sessionId, passphrase, account?)：account 省略時，正式管理者模式視為正式帳號、展示模式視為展示帳號
   * （與舊版「只輸入密碼」相容）。
   */
  login(sessionId: string, passphrase: string, account?: string): LoginResult {
    if (!this.hash && !this.staffHash && !this.demoEnabled) return { ok: false, role: "viewer", remaining: 0, locked: false, message: "尚未設定任何帳號；所有人以訪客身分唯讀" };
    const used = this.fails.get(sessionId) ?? 0;
    if (used >= this.maxTries) return { ok: false, role: "viewer", remaining: 0, locked: true, message: "錯誤次數過多，這個連線已鎖定；重新整理頁面後再試" };
    const acct = account === undefined || normAccount(account) === "" ? undefined : normAccount(account);
    const ok = (role: Role, message: string): LoginResult => {
      this.sessions.set(sessionId, role); this.fails.delete(sessionId);
      return { ok: true, role, remaining: this.maxTries, locked: false, message };
    };
    // 正式管理者
    if (this.hash && (acct === undefined || acct === this.account) && verifyHash(passphrase, this.hash)) return ok("admin", "已登入管理員");
    // 正式員工
    if (this.staffHash && (acct === undefined || acct === this.staffAccount) && verifyHash(passphrase, this.staffHash)) return ok("staff", "已登入員工");
    // 展示預設帳號：只有在沒有任何正式帳號時
    if (this.demoAvailable() && passphrase) {
      if ((acct === undefined || acct === DEMO_ACCOUNT) && sameText(passphrase, DEMO_PASSWORD)) return ok("demo_admin", "已以展示管理員登入（不能寫入引擎）");
      if ((acct === undefined || acct === DEMO_STAFF_ACCOUNT) && sameText(passphrase, DEMO_STAFF_PASSWORD)) return ok("staff", "已以展示員工登入");
    }
    return this.fail(sessionId, used);
  }
  logout(sessionId: string) { this.sessions.delete(sessionId); }
}
