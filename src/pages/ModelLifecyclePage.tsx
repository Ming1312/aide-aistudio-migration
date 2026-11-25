import React from "react";
import { GitBranch, Lock, ShieldAlert, Wrench } from "lucide-react";
import type { RealDataset } from "../../contracts/types";
import type { ApiHealthStatus } from "../types/app";

interface ModelLifecyclePageProps {
  dataset: RealDataset;
  health: ApiHealthStatus | null;
}

const LIFECYCLE_STEPS = [
  {
    step: "1. 持續監測與資料健康度掃描",
    detail:
      "每次新批次資料匯入後，先執行時間缺口、零值、卡值與多感測器漂移檢查（如資料更新頁 D1–D5 展示）。",
  },
  {
    step: "2. 守門建議判斷（fix_data_first vs consider_retraining）",
    detail:
      "若偵測到感測器健康度為 suspect（疑為卡值、漂移或斷線），守門機制輸出 fix_data_first，強制阻擋重訓（HTTP 409），避免將壞資料學進模型。",
  },
  {
    step: "3. 人工確認並手動觸發重新訓練",
    detail:
      "只有人工確認現場資料正常並填寫確認原因（≥ 8 字）後，才可由管理者手動按下重訓，產生候選模型（不自動啟用）。",
  },
  {
    step: "4. 新舊模型留存期並排比較",
    detail:
      "候選模型與現有模型在驗證期、留存期及簡單基準（Persistence / Linear AR）並排比較 MAE 與 RMSE。",
  },
  {
    step: "5. 啟用或回復（不刪除歷史版本）",
    detail:
      "僅研究者探索模型可依序啟用或回復版本指標，所有操作寫入雜湊鏈稽核紀錄；正式（formal）模型升級永遠鎖定為不可用（403）。",
  },
];

export const ModelLifecyclePage: React.FC<ModelLifecyclePageProps> = ({
  dataset,
  health,
}) => {
  const engineOnline = Boolean(health?.engine_connected);

  return (
    <div className="space-y-6">
      <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-slate-900 flex items-center gap-2">
              <Wrench className="h-5 w-5 text-[#0B63CE]" />
              模型維護與生命週期管理
            </h1>
            <p className="text-sm text-slate-600 mt-1">
              目前場域：{dataset.display_name}｜模型維護遵守「人為確認、不自動重訓、不自動啟用、不覆蓋正式政策模型」原則。
            </p>
          </div>
          <span className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded border border-slate-300 bg-slate-50 text-slate-700">
            <Lock className="h-3.5 w-3.5" />
            {engineOnline ? "唯讀引擎模式（寫入需 M4）" : "尚未連線到 Python 引擎"}
          </span>
        </div>

        <div className="p-3.5 rounded-md bg-amber-50 border border-amber-200 text-xs text-amber-950 space-y-1">
          <div className="font-semibold">
            {engineOnline
              ? "目前連線為唯讀引擎（M1/M2）：模型重訓與版本啟用屬於後續寫入階段（M4），此處操作按鈕維持停用。"
              : "尚未連線到 Python 引擎：M1 階段無寫入端點，模型重訓、啟用與回復按鈕全部停用。"}
          </div>
          <div>
            可先至「資料更新（合成展示）」實際操作 D3／D4 觸發{" "}
            <code className="font-mono-tabular">fix_data_first</code> 守門擋下重訓的情境。
          </div>
        </div>
      </section>

      {/* 5-step workflow */}
      <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
        <h2 className="text-base font-semibold text-slate-900 flex items-center gap-2">
          <GitBranch className="h-4 w-4 text-[#0B63CE]" />
          標準模型維護五步驟
        </h2>

        <div className="space-y-3">
          {LIFECYCLE_STEPS.map((item) => (
            <div
              key={item.step}
              className="p-3.5 rounded-md border border-slate-200 bg-slate-50/70 space-y-1"
            >
              <div className="text-sm font-semibold text-slate-900">
                {item.step}
              </div>
              <p className="text-xs text-slate-700 leading-relaxed">
                {item.detail}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Guard Rules + Disabled Action Buttons */}
      <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
        <div className="p-3.5 rounded-md border border-rose-200 bg-rose-50 text-xs text-rose-950 space-y-1">
          <div className="font-semibold flex items-center gap-1.5">
            <ShieldAlert className="h-4 w-4 text-rose-700" />
            Formal Gate 永久鎖定說明
          </div>
          <p>
            已凍結之正式模型（如羊舍 Phase 2.6 strict replay）受{" "}
            <code className="font-mono-tabular">formal_gate</code>{" "}
            保護，任何自動化流程或介面皆無法就地覆寫或升級為正式政策模型（API 回傳 403），必須另行完成獨立前瞻驗證與書面政策審查。
          </p>
        </div>

        <div className="flex flex-wrap gap-2 pt-1">
          <button
            type="button"
            disabled
            title="尚未連線到 Python 引擎（寫入操作於 M1 停用）"
            className="px-3.5 py-2 rounded-md bg-slate-200 text-slate-500 text-xs font-medium cursor-not-allowed"
          >
            執行守門檢查（需要引擎）
          </button>
          <button
            type="button"
            disabled
            title="尚未連線到 Python 引擎（寫入操作於 M1 停用）"
            className="px-3.5 py-2 rounded-md bg-slate-200 text-slate-500 text-xs font-medium cursor-not-allowed"
          >
            人工觸發重新訓練候選模型（需要引擎）
          </button>
          <button
            type="button"
            disabled
            title="尚未連線到 Python 引擎（寫入操作於 M1 停用）"
            className="px-3.5 py-2 rounded-md bg-slate-200 text-slate-500 text-xs font-medium cursor-not-allowed"
          >
            啟用／回復模型版本（需要引擎）
          </button>
          <button
            type="button"
            disabled
            title="formal 模型升級永遠不可用（formal_gate）"
            className="px-3.5 py-2 rounded-md border border-rose-200 bg-rose-50 text-rose-400 text-xs font-medium cursor-not-allowed"
          >
            升級為正式政策模型（formal_gate 永久禁止）
          </button>
        </div>
      </section>
    </div>
  );
};
