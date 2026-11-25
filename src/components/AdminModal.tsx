import React, { useState } from "react";
import { Lock, Unlock, X } from "lucide-react";
import { loginAdmin, logoutAdmin } from "../lib/dataLoader";
import type { AdminRoleStatus } from "../types/app";

interface AdminModalProps {
  open: boolean;
  onClose: () => void;
  adminRole: AdminRoleStatus;
  onRoleUpdated: (next: AdminRoleStatus) => void;
}

export const AdminModal: React.FC<AdminModalProps> = ({
  open,
  onClose,
  adminRole,
  onRoleUpdated,
}) => {
  const [passphrase, setPassphrase] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  if (!open) return null;

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setFeedback(null);
    try {
      const res = await loginAdmin(passphrase);
      setFeedback(res.message);
      if (res.ok) {
        onRoleUpdated({ configured: adminRole.configured, role: res.role });
        setPassphrase("");
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
      onRoleUpdated({ configured: adminRole.configured, role: "viewer" });
      setFeedback("已切回唯讀模式");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="管理者鎖定與權限設定"
    >
      <div className="bg-white border border-slate-200 rounded-lg max-w-md w-full shadow-xl">
        <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
          <div className="flex items-center gap-2 font-semibold text-slate-900 text-sm">
            {adminRole.role === "admin" ? (
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
              <strong className="text-slate-900">
                {adminRole.role === "admin" ? "管理者（admin）" : "訪客（viewer / 唯讀）"}
              </strong>
            </div>
            <div>
              密碼雜湊只存於伺服器端環境變數，前端與瀏覽器網路請求不接觸任何雜湊或金鑰；連續 5 次錯誤將鎖定 15 分鐘。
            </div>
          </div>

          {!adminRole.configured ? (
            <div className="p-3 rounded-md bg-amber-50 border border-amber-200 text-amber-900 text-xs">
              伺服器尚未設定管理者密碼雜湊，依安全政策系統維持全員唯讀（不提供後門解鎖）。
            </div>
          ) : adminRole.role === "admin" ? (
            <button
              type="button"
              onClick={handleLogout}
              disabled={submitting}
              className="w-full py-2 px-3 rounded-md border border-slate-300 bg-white text-slate-800 font-medium hover:bg-slate-50"
            >
              登出管理者，切回唯讀模式
            </button>
          ) : (
            <form onSubmit={handleLogin} className="space-y-3">
              <div>
                <label
                  htmlFor="admin-passphrase-input"
                  className="block text-xs font-medium text-slate-700 mb-1"
                >
                  輸入管理者密碼（由伺服器端驗證）
                </label>
                <input
                  id="admin-passphrase-input"
                  type="password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-[#0B63CE] focus:outline-none"
                  placeholder="請輸入密碼"
                  autoComplete="off"
                />
              </div>
              <button
                type="submit"
                disabled={submitting || !passphrase}
                className="w-full py-2 px-3 rounded-md bg-[#0B63CE] text-white font-medium hover:bg-[#0952AD] disabled:opacity-50"
              >
                {submitting ? "驗證中…" : "解鎖管理者"}
              </button>
            </form>
          )}

          {feedback && (
            <div className="p-2.5 rounded bg-slate-100 text-slate-800 text-xs">
              {feedback}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
