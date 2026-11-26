import React, { useEffect, useState } from "react";
import { CheckCircle2, Lock, ShieldAlert, Unlock, X, XCircle } from "lucide-react";
import {
  fetchAdminRole,
  fetchAdminStatus,
  loginAdmin,
  logoutAdmin,
} from "../lib/dataLoader";
import {
  ADMIN_ROLE_LABEL,
  type AdminRoleStatus,
  type AdminStatusInfo,
} from "../types/app";

interface AdminModalProps {
  open: boolean;
  onClose: () => void;
  adminRole: AdminRoleStatus;
  onRoleUpdated: (next: AdminRoleStatus) => void;
}

const Flag: React.FC<{ ok: boolean; label: string; hint?: string }> = ({ ok, label, hint }) => (
  <li className="flex items-start gap-2">
    {ok ? (
      <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0 mt-0.5" />
    ) : (
      <XCircle className="h-4 w-4 text-slate-400 shrink-0 mt-0.5" />
    )}
    <span className="min-w-0">
      <span className="text-slate-900">{label}</span>
      <span className="ml-1 text-slate-500">{ok ? "已設定" : "未設定"}</span>
      {hint && <span className="block text-[11px] text-slate-500">{hint}</span>}
    </span>
  </li>
);

export const AdminModal: React.FC<AdminModalProps> = ({
  open,
  onClose,
  adminRole,
  onRoleUpdated,
}) => {
  const [account, setAccount] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [status, setStatus] = useState<AdminStatusInfo | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  const loggedIn = adminRole.role !== "viewer";
  const loginPossible = adminRole.configured || !!adminRole.demo_available;

  // 開啟視窗時重新讀角色（拿到最新的展示帳號提示）；登入後讀管理狀態
  useEffect(() => {
    if (!open) return;
    fetchAdminRole()
      .then((r) => onRoleUpdated(r))
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open || !loggedIn) {
      setStatus(null);
      setStatusError(null);
      return;
    }
    fetchAdminStatus()
      .then((s) => {
        setStatus(s);
        setStatusError(null);
      })
      .catch((e) => setStatusError(e instanceof Error ? e.message : "讀取失敗"));
  }, [open, loggedIn, adminRole.role]);

  if (!open) return null;

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setFeedback(null);
    try {
      const res = await loginAdmin(passphrase, account.trim() || undefined);
      setFeedback(res.message);
      if (res.ok) {
        setPassphrase("");
        try {
          onRoleUpdated(await fetchAdminRole());
        } catch {
          onRoleUpdated({ configured: adminRole.configured, role: res.role });
        }
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
      try {
        onRoleUpdated(await fetchAdminRole());
      } catch {
        onRoleUpdated({ configured: adminRole.configured, role: "viewer" });
      }
      setFeedback("已切回唯讀模式");
    } finally {
      setSubmitting(false);
    }
  };

  const hint = adminRole.demo_hint;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="管理者鎖定與權限設定"
    >
      <div className="bg-white border border-slate-200 rounded-lg max-w-md w-full shadow-xl max-h-[90vh] overflow-y-auto">
        <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
          <div className="flex items-center gap-2 font-semibold text-slate-900 text-sm">
            {loggedIn ? (
              <Unlock className="h-4 w-4 text-emerald-700" />
            ) : (
              <Lock className="h-4 w-4 text-slate-500" />
            )}
            管理者驗證（預設唯讀）
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded hover:bg-slate-100 text-slate-500"
            aria-label="關閉"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-5 space-y-4 text-sm">
          <div className="p-3 rounded-md bg-slate-50 border border-slate-200 text-xs text-slate-600 space-y-1">
            <div>
              目前角色：
              <strong className="text-slate-900" data-testid="admin-role-label">
                {ADMIN_ROLE_LABEL[adminRole.role]}
              </strong>
            </div>
            <div>
              密碼雜湊與引擎金鑰只存於伺服器端環境變數，前端不接觸；連續 5 次錯誤會鎖定該連線。
            </div>
          </div>

          {!loggedIn && hint && (
            <div
              data-testid="demo-account-hint"
              className="p-3 rounded-md bg-violet-50 border border-violet-200 text-xs text-violet-950 space-y-2"
            >
              <div className="font-semibold">展示預設帳號（公開值）</div>
              <div>
                帳號 <code className="font-mono">{hint.account}</code>　密碼{" "}
                <code className="font-mono">{hint.password}</code>
              </div>
              <div>
                這是給展示與評審操作用的<strong>公開預設帳號</strong>：只能看管理狀態與操作展示功能，
                <strong>不能寫入引擎</strong>。正式部署請在 Secrets 設定 ADMIN_PASSPHRASE_HASH，預設帳號就會自動停用。
              </div>
              <button
                type="button"
                className="px-2.5 py-1 rounded border border-violet-300 bg-white text-violet-900 hover:bg-violet-100"
                onClick={() => {
                  setAccount(hint.account);
                  setPassphrase(hint.password);
                }}
              >
                填入展示帳號
              </button>
            </div>
          )}

          {!loginPossible && !loggedIn ? (
            <div className="p-3 rounded-md bg-amber-50 border border-amber-200 text-amber-900 text-xs">
              伺服器沒有設定管理者，展示預設帳號也已停用（ADMIN_DEMO_DISABLED=1），系統維持全員唯讀。
            </div>
          ) : loggedIn ? (
            <button
              type="button"
              onClick={handleLogout}
              disabled={submitting}
              className="w-full py-2 px-3 rounded-md border border-slate-300 bg-white text-slate-800 font-medium hover:bg-slate-50"
            >
              登出，切回唯讀模式
            </button>
          ) : (
            <form onSubmit={handleLogin} className="space-y-3">
              <div>
                <label
                  htmlFor="admin-account-input"
                  className="block text-xs font-medium text-slate-700 mb-1"
                >
                  帳號
                </label>
                <input
                  id="admin-account-input"
                  type="text"
                  value={account}
                  onChange={(e) => setAccount(e.target.value)}
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-[#0B63CE] focus:outline-none"
                  placeholder={adminRole.configured ? "管理者帳號（預設 admin）" : "demo"}
                  autoComplete="username"
                />
              </div>
              <div>
                <label
                  htmlFor="admin-passphrase-input"
                  className="block text-xs font-medium text-slate-700 mb-1"
                >
                  密碼（由伺服器端驗證）
                </label>
                <input
                  id="admin-passphrase-input"
                  type="password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-[#0B63CE] focus:outline-none"
                  placeholder="請輸入密碼"
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

          {loggedIn && (
            <div className="border border-slate-200 rounded-md p-3 space-y-2" data-testid="admin-status-panel">
              <div className="font-semibold text-slate-900 text-xs">管理狀態（只顯示「是否設定」，不顯示任何值）</div>
              {statusError && <div className="text-xs text-rose-700">{statusError}</div>}
              {status && (
                <>
                  <ul className="space-y-1.5 text-xs">
                    <Flag ok={status.engine_url_configured} label="引擎網址（ENGINE_BASE_URL）" />
                    <Flag ok={status.engine_api_key_configured} label="引擎讀取金鑰（ENGINE_API_KEY）" />
                    <Flag
                      ok={status.engine_admin_key_configured}
                      label="引擎管理金鑰（ENGINE_ADMIN_KEY）"
                      hint="沒有設定時，引擎一律拒絕寫入（唯讀部署）"
                    />
                    <Flag ok={status.gemini_configured} label="Gemini 金鑰" hint="沒有設定時走規則式降級" />
                    <Flag
                      ok={status.real_admin_configured}
                      label="正式管理者（ADMIN_PASSPHRASE_HASH）"
                      hint={status.real_account_name ? `帳號：${status.real_account_name}` : undefined}
                    />
                  </ul>
                  <div className="text-xs text-slate-700">
                    引擎寫入：
                    <strong>{status.can_write_engine ? "此角色可嘗試寫入（仍需引擎端開放）" : "此角色不能寫入引擎"}</strong>
                  </div>
                  {status.demo_account_active && (
                    <div className="flex items-start gap-2 p-2 rounded bg-amber-50 border border-amber-200 text-[11px] text-amber-900">
                      <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5 text-amber-700" />
                      <span>
                        展示預設帳號目前啟用中（公開值）。正式部署前請設定 ADMIN_PASSPHRASE_HASH 以停用，或設定
                        ADMIN_DEMO_DISABLED=1。
                      </span>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
