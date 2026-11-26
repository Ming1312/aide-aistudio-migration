import React, { useEffect, useState } from "react";
import { CheckCircle2, Lock, ShieldAlert, Unlock, X, XCircle } from "lucide-react";
import { PERMISSION_LABEL, PERMISSION_ORDER, can, type Role } from "../../contracts/permissions";
import { fetchAdminRole, fetchAdminStatus, loginAdmin, logoutAdmin } from "../lib/dataLoader";
import { ADMIN_ROLE_LABEL, type AdminRoleStatus, type AdminStatusInfo } from "../types/app";

interface AdminModalProps {
  open: boolean;
  onClose: () => void;
  adminRole: AdminRoleStatus;
  onRoleUpdated: (next: AdminRoleStatus) => void;
}

const Flag: React.FC<{ ok: boolean; label: string }> = ({ ok, label }) => (
  <li className="flex items-center gap-2">
    {ok ? <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" /> : <XCircle className="h-4 w-4 text-slate-400 shrink-0" />}
    <span className="text-slate-900">{label}</span>
    <span className="text-slate-500">{ok ? "已設定" : "未設定"}</span>
  </li>
);

const MATRIX_ROLES: Array<{ role: Role; label: string }> = [
  { role: "viewer", label: "訪客" },
  { role: "staff", label: "員工" },
  { role: "admin", label: "管理員" },
];

export const AdminModal: React.FC<AdminModalProps> = ({ open, onClose, adminRole, onRoleUpdated }) => {
  const [account, setAccount] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [status, setStatus] = useState<AdminStatusInfo | null>(null);

  const loggedIn = adminRole.role !== "viewer";
  const loginPossible = adminRole.configured || !!adminRole.staff_configured || !!adminRole.demo_available;
  const hints = [adminRole.demo_staff_hint && { ...adminRole.demo_staff_hint, label: "員工" }, adminRole.demo_hint && { ...adminRole.demo_hint, label: "管理員（展示）" }].filter(
    Boolean
  ) as Array<{ account: string; password: string; label: string }>;

  useEffect(() => {
    if (!open) return;
    fetchAdminRole()
      .then(onRoleUpdated)
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open || !can(adminRole.role, "view_admin_status")) {
      setStatus(null);
      return;
    }
    fetchAdminStatus()
      .then(setStatus)
      .catch(() => setStatus(null));
  }, [open, adminRole.role]);

  if (!open) return null;

  const refreshRole = async (fallback: Role) => {
    try {
      onRoleUpdated(await fetchAdminRole());
    } catch {
      onRoleUpdated({ configured: adminRole.configured, role: fallback });
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setFeedback(null);
    try {
      const res = await loginAdmin(passphrase, account.trim() || undefined);
      setFeedback(res.message);
      if (res.ok) {
        setPassphrase("");
        await refreshRole(res.role);
      }
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : "驗證失敗");
    } finally {
      setSubmitting(false);
    }
  };

  const handleLogout = async () => {
    setSubmitting(true);
    try {
      await logoutAdmin();
      await refreshRole("viewer");
      setFeedback("已切回訪客");
    } finally {
      setSubmitting(false);
    }
  };

  const shownRole: Role = adminRole.role === "demo_admin" ? "admin" : adminRole.role;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4" role="dialog" aria-modal="true" aria-label="登入與角色">
      <div className="bg-white border border-slate-200 rounded-lg max-w-md w-full shadow-xl max-h-[90vh] overflow-y-auto">
        <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
          <div className="flex items-center gap-2 font-semibold text-slate-900 text-sm">
            {loggedIn ? <Unlock className="h-4 w-4 text-emerald-700" /> : <Lock className="h-4 w-4 text-slate-500" />}
            目前角色：
            <span data-testid="admin-role-label">{ADMIN_ROLE_LABEL[adminRole.role]}</span>
          </div>
          <button type="button" onClick={onClose} className="p-1 rounded hover:bg-slate-100 text-slate-500" aria-label="關閉">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-5 space-y-4 text-sm">
          {/* 角色權限表 */}
          <table className="w-full text-xs" data-testid="role-matrix">
            <thead>
              <tr className="text-slate-500">
                <th className="text-left font-medium py-1">權限</th>
                {MATRIX_ROLES.map((r) => (
                  <th key={r.role} className={`font-medium py-1 ${shownRole === r.role ? "text-[#0B63CE]" : ""}`}>
                    {r.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr className="border-t border-slate-100">
                <td className="py-1 text-slate-700">查看與 AI 問答</td>
                {MATRIX_ROLES.map((r) => (
                  <td key={r.role} className="text-center text-emerald-700">✓</td>
                ))}
              </tr>
              {PERMISSION_ORDER.map((p) => (
                <tr key={p} className="border-t border-slate-100">
                  <td className="py-1 text-slate-700">{PERMISSION_LABEL[p]}</td>
                  {MATRIX_ROLES.map((r) => (
                    <td key={r.role} className="text-center">
                      {can(r.role, p) ? <span className="text-emerald-700">✓</span> : <span className="text-slate-300">—</span>}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>

          {!loggedIn && hints.length > 0 && (
            <div data-testid="demo-account-hint" className="p-3 rounded-md bg-violet-50 border border-violet-200 text-xs text-violet-950 space-y-1.5">
              <div className="font-semibold">展示帳號（公開值）</div>
              {hints.map((h) => (
                <div key={h.account} className="flex items-center gap-2 flex-wrap">
                  <span className="w-24 shrink-0">{h.label}</span>
                  <code className="font-mono">{h.account}</code>
                  <code className="font-mono">{h.password}</code>
                  <button
                    type="button"
                    className="ml-auto px-2 py-0.5 rounded border border-violet-300 bg-white text-violet-900 hover:bg-violet-100"
                    onClick={() => {
                      setAccount(h.account);
                      setPassphrase(h.password);
                    }}
                  >
                    填入
                  </button>
                </div>
              ))}
              <div className="text-[11px] text-violet-800">展示帳號都不能寫入引擎。設定正式帳號後會自動停用。</div>
            </div>
          )}

          {!loginPossible && !loggedIn ? (
            <div className="p-3 rounded-md bg-amber-50 border border-amber-200 text-amber-900 text-xs">沒有可用的帳號，全員以訪客身分唯讀。</div>
          ) : loggedIn ? (
            <button
              type="button"
              onClick={handleLogout}
              disabled={submitting}
              className="w-full py-2 px-3 rounded-md border border-slate-300 bg-white text-slate-800 font-medium hover:bg-slate-50"
            >
              登出（切回訪客）
            </button>
          ) : (
            <form onSubmit={handleLogin} className="space-y-3">
              <div>
                <label htmlFor="admin-account-input" className="block text-xs font-medium text-slate-700 mb-1">
                  帳號
                </label>
                <input
                  id="admin-account-input"
                  type="text"
                  value={account}
                  onChange={(e) => setAccount(e.target.value)}
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-[#0B63CE] focus:outline-none"
                  autoComplete="username"
                />
              </div>
              <div>
                <label htmlFor="admin-passphrase-input" className="block text-xs font-medium text-slate-700 mb-1">
                  密碼
                </label>
                <input
                  id="admin-passphrase-input"
                  type="password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-[#0B63CE] focus:outline-none"
                  autoComplete="current-password"
                />
              </div>
              <button
                type="submit"
                disabled={submitting || !passphrase}
                className="w-full py-2 px-3 rounded-md bg-[#0B63CE] text-white font-medium hover:bg-[#0952AD] disabled:opacity-50"
              >
                {submitting ? "驗證中…" : "登入"}
              </button>
            </form>
          )}

          {feedback && (
            <div className="p-2.5 rounded bg-slate-100 text-slate-800 text-xs" data-testid="admin-feedback">
              {feedback}
            </div>
          )}

          {status && (
            <div className="border border-slate-200 rounded-md p-3 space-y-2" data-testid="admin-status-panel">
              <div className="font-semibold text-slate-900 text-xs">管理狀態（只顯示「是否設定」）</div>
              <ul className="space-y-1 text-xs">
                <Flag ok={status.engine_url_configured} label="引擎網址" />
                <Flag ok={status.engine_api_key_configured} label="引擎讀取金鑰" />
                <Flag ok={status.engine_admin_key_configured} label="引擎管理金鑰" />
                <Flag ok={status.gemini_configured} label="Gemini 金鑰" />
                <Flag ok={status.real_admin_configured} label="正式管理員" />
                <Flag ok={!!status.staff_configured} label="正式員工" />
              </ul>
              <div className="text-xs text-slate-700">
                引擎寫入：<strong>{status.can_write_engine ? "可嘗試（仍需引擎端開放）" : "不能寫入"}</strong>
              </div>
              {status.demo_account_active && (
                <div className="flex items-start gap-2 p-2 rounded bg-amber-50 border border-amber-200 text-[11px] text-amber-900">
                  <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5 text-amber-700" />
                  <span>展示帳號啟用中（公開值）。正式部署前請設定 ADMIN_PASSPHRASE_HASH／STAFF_PASSPHRASE_HASH，或設 ADMIN_DEMO_DISABLED=1。</span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
