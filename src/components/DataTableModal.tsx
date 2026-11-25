import React, { useMemo, useState } from "react";
import { ArrowUpDown, Download, X } from "lucide-react";

interface DataTableModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  columns: string[];
  rows: Array<Record<string, string | number | null>>;
  onDownloadCsv: () => void;
  downloadLabel?: string;
}

export const DataTableModal: React.FC<DataTableModalProps> = ({
  open,
  onClose,
  title,
  subtitle,
  columns,
  rows,
  onDownloadCsv,
  downloadLabel = "下載完整資料 CSV",
}) => {
  const [sortCol, setSortCol] = useState<string>(columns[0] ?? "timestamp");
  const [sortAsc, setSortAsc] = useState(false);
  const [page, setPage] = useState(0);
  const pageSize = 50;

  const sortedRows = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      const va = a[sortCol];
      const vb = b[sortCol];
      if (va === null || va === undefined) return 1;
      if (vb === null || vb === undefined) return -1;
      if (typeof va === "number" && typeof vb === "number") {
        return sortAsc ? va - vb : vb - va;
      }
      return sortAsc
        ? String(va).localeCompare(String(vb))
        : String(vb).localeCompare(String(va));
    });
    return copy;
  }, [rows, sortCol, sortAsc]);

  if (!open) return null;

  const totalPages = Math.max(1, Math.ceil(sortedRows.length / pageSize));
  const safePage = Math.min(page, totalPages - 1);
  const pageRows = sortedRows.slice(
    safePage * pageSize,
    (safePage + 1) * pageSize
  );

  const handleSort = (col: string) => {
    if (sortCol === col) {
      setSortAsc(!sortAsc);
    } else {
      setSortCol(col);
      setSortAsc(true);
    }
    setPage(0);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="bg-white border border-slate-200 rounded-lg max-w-5xl w-full max-h-[90vh] flex flex-col shadow-xl">
        <div className="px-5 py-3.5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-base font-semibold text-slate-900">{title}</h3>
            {subtitle && (
              <div className="text-xs text-slate-500 mt-0.5">{subtitle}</div>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onDownloadCsv}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[#0B63CE] text-white text-xs font-medium hover:bg-[#0952AD]"
            >
              <Download className="h-3.5 w-3.5" />
              {downloadLabel}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded hover:bg-slate-100 text-slate-500"
              aria-label="關閉"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-auto">
          <table className="min-w-full text-xs border-collapse">
            <thead className="sticky top-0 bg-slate-50 border-b border-slate-200">
              <tr>
                {columns.map((col) => (
                  <th
                    key={col}
                    className="px-3 py-2 text-left font-semibold text-slate-700 whitespace-nowrap"
                  >
                    <button
                      type="button"
                      onClick={() => handleSort(col)}
                      className="inline-flex items-center gap-1 hover:text-[#0B63CE]"
                    >
                      {col}
                      <ArrowUpDown className="h-3 w-3 text-slate-400" />
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 font-mono-tabular">
              {pageRows.map((row, idx) => (
                <tr key={idx} className="hover:bg-slate-50">
                  {columns.map((col) => {
                    const v = row[col];
                    return (
                      <td
                        key={col}
                        className="px-3 py-1.5 whitespace-nowrap text-slate-700"
                      >
                        {v === null || v === undefined ? (
                          <span className="text-slate-300">缺值</span>
                        ) : (
                          String(v)
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="px-5 py-2.5 border-t border-slate-200 bg-slate-50 flex items-center justify-between text-xs text-slate-600">
          <span className="font-mono-tabular">
            共 {sortedRows.length} 列（第 {safePage + 1} / {totalPages} 頁）
          </span>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={safePage === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              className="px-2.5 py-1 rounded border border-slate-300 bg-white disabled:opacity-40"
            >
              上一頁
            </button>
            <button
              type="button"
              disabled={safePage >= totalPages - 1}
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              className="px-2.5 py-1 rounded border border-slate-300 bg-white disabled:opacity-40"
            >
              下一頁
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
