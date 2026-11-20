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

export type Role = "viewer" | "admin";
export interface LoginResult { ok: boolean; role: Role; remaining: number; locked: boolean; message: string }

export class AdminGate {
  private admins = new Set<string>();
  private fails = new Map<string, number>();
  private readonly hash: string | undefined;
  private readonly maxTries: number;
  constructor(hash: string | undefined, maxTries = 5) { this.hash = hash; this.maxTries = maxTries; }
  configured(): boolean { return !!this.hash; }
  role(sessionId: string): Role { return this.admins.has(sessionId) ? "admin" : "viewer"; }
  login(sessionId: string, passphrase: string): LoginResult {
    if (!this.hash) return { ok: false, role: "viewer", remaining: 0, locked: false, message: "尚未設定管理者；所有人唯讀" };
    const used = this.fails.get(sessionId) ?? 0;
    if (used >= this.maxTries) return { ok: false, role: "viewer", remaining: 0, locked: true, message: "錯誤次數過多，這個連線已鎖定；重新整理頁面後再試" };
    if (verifyHash(passphrase, this.hash)) { this.admins.add(sessionId); this.fails.delete(sessionId); return { ok: true, role: "admin", remaining: this.maxTries, locked: false, message: "已解鎖管理者" }; }
    this.fails.set(sessionId, used + 1);
    const remaining = this.maxTries - used - 1;
    return { ok: false, role: "viewer", remaining, locked: remaining <= 0, message: `密碼不正確（已錯 ${used + 1} 次，最多 ${this.maxTries} 次）` };
  }
  logout(sessionId: string) { this.admins.delete(sessionId); }
}
