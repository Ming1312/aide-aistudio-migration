import React from "react";
import { AlertTriangle, CheckCircle2, MinusCircle, ShieldAlert, Wrench } from "lucide-react";
import { SAFETY_TEXT, type Safety } from "../lib/status";

// 狀態色（reserved：只用在狀態，不用在資料系列）；一律搭配圖示＋文字，不單靠顏色
export const SAFETY_STYLE: Record<Safety, { bg: string; border: string; text: string; dot: string; icon: React.ReactNode }> = {
  safe: { bg: "bg-emerald-50", border: "border-emerald-200", text: "text-emerald-900", dot: "#0ca30c", icon: <CheckCircle2 className="h-4 w-4" /> },
  caution: { bg: "bg-amber-50", border: "border-amber-300", text: "text-amber-950", dot: "#fab219", icon: <AlertTriangle className="h-4 w-4" /> },
  data: { bg: "bg-orange-50", border: "border-orange-300", text: "text-orange-950", dot: "#ec835a", icon: <Wrench className="h-4 w-4" /> },
  danger: { bg: "bg-red-50", border: "border-red-300", text: "text-red-950", dot: "#d03b3b", icon: <ShieldAlert className="h-4 w-4" /> },
  none: { bg: "bg-slate-50", border: "border-slate-200", text: "text-slate-600", dot: "#898781", icon: <MinusCircle className="h-4 w-4" /> },
};

export const SafetyBadge: React.FC<{ level: Safety; className?: string }> = ({ level, className = "" }) => {
  const st = SAFETY_STYLE[level];
  return (
    <span
      data-level={level}
      className={`inline-flex items-center gap-1 whitespace-nowrap shrink-0 rounded-full border px-2 py-0.5 text-xs font-semibold ${st.bg} ${st.border} ${st.text} ${className}`}
    >
      {st.icon}
      {SAFETY_TEXT[level]}
    </span>
  );
};

// 資料系列色（依固定順序；已通過調色盤驗證，低對比的放最後，並搭配虛線樣式與圖例）
export const SERIES_COLORS = ["#2a78d6", "#eb6834", "#6250d6", "#1baf7a", "#e87ba4", "#eda100"];
export const SERIES_DASH = ["", "6 3", "2 3", "10 3 2 3", "1 4", "8 4"];

export const Sparkline: React.FC<{
  values: Array<number | null>;
  lines?: Array<{ y: number; color: string }>;
  color?: string;
  width?: number;
  height?: number;
}> = ({ values, lines = [], color = "#2a78d6", width = 120, height = 36 }) => {
  const nums = values.filter((v): v is number => typeof v === "number");
  if (nums.length < 2) return <div style={{ width, height }} className="rounded bg-slate-50" aria-hidden />;
  const all = [...nums, ...lines.map((l) => l.y)];
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const span = hi - lo || 1;
  const x = (i: number) => (i / (values.length - 1)) * (width - 2) + 1;
  const y = (v: number) => height - 2 - ((v - lo) / span) * (height - 4);
  let d = "";
  let pen = false;
  values.forEach((v, i) => {
    if (typeof v !== "number") {
      pen = false;
      return;
    }
    d += `${pen ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)} `;
    pen = true;
  });
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="近 48 小時趨勢">
      {lines.map((l, i) => (
        <line key={i} x1={0} x2={width} y1={y(l.y)} y2={y(l.y)} stroke={l.color} strokeWidth={1} strokeDasharray="3 3" opacity={0.7} />
      ))}
      <path d={d} fill="none" stroke={color} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
};

export const Card: React.FC<{ title?: React.ReactNode; right?: React.ReactNode; className?: string; "data-testid"?: string; children: React.ReactNode }> = ({
  title,
  right,
  className = "",
  children,
  "data-testid": testId,
}) => (
  <section data-testid={testId} className={`bg-white border border-slate-200 rounded-lg p-4 ${className}`}>
    {(title || right) && (
      <div className="flex items-center justify-between gap-2 mb-3">
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
        {right}
      </div>
    )}
    {children}
  </section>
);

export const Chip: React.FC<{ active?: boolean; onClick?: () => void; children: React.ReactNode; title?: string }> = ({
  active,
  onClick,
  children,
  title,
}) => (
  <button
    type="button"
    title={title}
    onClick={onClick}
    aria-pressed={active}
    className={`px-2.5 py-1 rounded-md border text-xs font-medium transition-colors ${
      active ? "bg-[#0B63CE] border-[#0B63CE] text-white" : "bg-white border-slate-300 text-slate-700 hover:bg-slate-50"
    }`}
  >
    {children}
  </button>
);
