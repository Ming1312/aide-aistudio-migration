import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Lock,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  Upload,
  WifiOff,
} from "lucide-react";
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { MODEL_ORDER } from "../../contracts/types";
import type {
  LiveEventsResponse,
  LiveForecastResponse,
  LiveMonitorResponse,
  LivePendingResponse,
  LiveStatusResponse,
  LiveVersionsResponse,
  LiveWriteResult,
  ModelKey,
  PrecomputedForecasts,
  RealDataset,
} from "../../contracts/types";
import {
  fetchLiveEvents,
  fetchLiveForecast,
  fetchLiveMonitor,
  fetchLivePending,
  fetchLiveStatus,
  fetchLiveVersions,
  postLiveCommit,
  postLiveIngest,
  postLiveRecompute,
  postLiveRollback,
  postLiveSimTick,
} from "../lib/dataLoader";
import {
  buildLiveSensorChartSeries,
  doesForecastMatchVersion,
  formatApplicabilityStatus,
  formatLiveClockMode,
  formatLiveDecisionZh,
  getDefaultRollbackTarget,
  getFreshnessDisplay,
  getLiveBannerKind,
  groupLiveTasksBySensor,
  isLiveDataSynthetic,
  LIVE_FORMAT_ERROR_MESSAGE,
  LIVE_METHOD_LABELS,
  LIVE_OFFLINE_MESSAGE,
  LiveFormatError,
  orderEventsNewestFirst,
  selectRecentVersionsNewestFirst,
  shouldRefetchForecastOnPoll,
  type LiveBannerKind,
} from "../lib/liveForecast";
import { formatChartTimeLabel } from "../lib/trendChart";
import { DemoImportSimulation } from "./DemoImportSimulation";
import type { AdminRoleStatus, ApiHealthStatus } from "../types/app";

interface LiveForecastPageProps {
  datasets: RealDataset[];
  datasetId: string;
  onSelectDataset: (id: string) => void;
  health: ApiHealthStatus | null;
  adminRole: AdminRoleStatus;
  onLiveBannerChange: (kind: LiveBannerKind) => void;
  /** 預先準備的資料（離線展示：模擬新資料匯入）；沒有也不影響即時模式 */
  precomputedForecasts?: PrecomputedForecasts | null;
}

type MarkerShape = "circle" | "square" | "triangle" | "diamond" | "cross" | "star";

const METHOD_VISUALS: Record<
  ModelKey,
  { color: string; shape: MarkerShape; label: string }
> = {
  persistence: { color: "#0B63CE", shape: "circle", label: "persistence（持續性）" },
  moving_average: { color: "#475569", shape: "square", label: "moving_average（滑動平均）" },
  seasonal_naive_24h: { color: "#0F766E", shape: "triangle", label: "seasonal_naive_24h" },
  linear_ar4: { color: "#7C3AED", shape: "diamond", label: "linear_ar4" },
  HGB: { color: "#D97706", shape: "cross", label: "HGB" },
  XGB: { color: "#BE123C", shape: "star", label: "XGB" },
};

const ShapeGlyph: React.FC<{
  shape: MarkerShape;
  color: string;
  size?: number;
}> = ({ shape, color, size = 12 }) => {
  const half = size / 2;
  const r = size * 0.36;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      {shape === "circle" && (
        <circle cx={half} cy={half} r={r} fill={color} stroke="#ffffff" strokeWidth={1} />
      )}
      {shape === "square" && (
        <rect
          x={half - r}
          y={half - r}
          width={r * 2}
          height={r * 2}
          fill={color}
          stroke="#ffffff"
          strokeWidth={1}
        />
      )}
      {shape === "triangle" && (
        <polygon
          points={`${half},${half - r - 0.5} ${half + r + 0.5},${half + r} ${half - r - 0.5},${half + r}`}
          fill={color}
          stroke="#ffffff"
          strokeWidth={1}
        />
      )}
      {shape === "diamond" && (
        <polygon
          points={`${half},${half - r - 0.8} ${half + r + 0.8},${half} ${half},${half + r + 0.8} ${half - r - 0.8},${half}`}
          fill={color}
          stroke="#ffffff"
          strokeWidth={1}
        />
      )}
      {shape === "cross" && (
        <path
          d={`M${half - r},${half - r} L${half + r},${half + r} M${half + r},${half - r} L${half - r},${half + r}`}
          stroke={color}
          strokeWidth={2.2}
          strokeLinecap="round"
        />
      )}
      {shape === "star" && (
        <polygon
          points={`${half},${half - r - 1} ${half + r * 0.38},${half - r * 0.32} ${half + r + 1},${half - r * 0.2} ${half + r * 0.5},${half + r * 0.3} ${half + r * 0.68},${half + r + 0.8} ${half},${half + r * 0.55} ${half - r * 0.68},${half + r + 0.8} ${half - r * 0.5},${half + r * 0.3} ${half - r - 1},${half - r * 0.2} ${half - r * 0.38},${half - r * 0.32}`}
          fill={color}
          stroke="#ffffff"
          strokeWidth={0.8}
        />
      )}
    </svg>
  );
};

function renderRechartsShapeDot(shape: MarkerShape, color: string) {
  return (props: {
    cx?: number;
    cy?: number;
    value?: number | null;
    index?: number;
  }) => {
    const { cx, cy, value, index } = props;
    if (
      typeof cx !== "number" ||
      typeof cy !== "number" ||
      typeof value !== "number" ||
      !Number.isFinite(value)
    ) {
      return <g key={`empty-${index ?? 0}`} />;
    }
    const r = 5;
    if (shape === "circle") {
      return (
        <circle
          key={`dot-${index}`}
          cx={cx}
          cy={cy}
          r={r}
          fill={color}
          stroke="#ffffff"
          strokeWidth={1.2}
        />
      );
    }
    if (shape === "square") {
      return (
        <rect
          key={`dot-${index}`}
          x={cx - r}
          y={cy - r}
          width={r * 2}
          height={r * 2}
          fill={color}
          stroke="#ffffff"
          strokeWidth={1.2}
        />
      );
    }
    if (shape === "triangle") {
      return (
        <polygon
          key={`dot-${index}`}
          points={`${cx},${cy - r - 1} ${cx + r + 1},${cy + r} ${cx - r - 1},${cy + r}`}
          fill={color}
          stroke="#ffffff"
          strokeWidth={1.2}
        />
      );
    }
    if (shape === "diamond") {
      return (
        <polygon
          key={`dot-${index}`}
          points={`${cx},${cy - r - 1.5} ${cx + r + 1.5},${cy} ${cx},${cy + r + 1.5} ${cx - r - 1.5},${cy}`}
          fill={color}
          stroke="#ffffff"
          strokeWidth={1.2}
        />
      );
    }
    if (shape === "cross") {
      return (
        <path
          key={`dot-${index}`}
          d={`M${cx - r},${cy - r} L${cx + r},${cy + r} M${cx + r},${cy - r} L${cx - r},${cy + r}`}
          stroke={color}
          strokeWidth={2.5}
          strokeLinecap="round"
        />
      );
    }
    return (
      <polygon
        key={`dot-${index}`}
        points={`${cx},${cy - r - 1.5} ${cx + r * 0.4},${cy - r * 0.35} ${cx + r + 1.5},${cy - r * 0.2} ${cx + r * 0.55},${cy + r * 0.32} ${cx + r * 0.72},${cy + r + 1} ${cx},${cy + r * 0.6} ${cx - r * 0.72},${cy + r + 1} ${cx - r * 0.55},${cy + r * 0.32} ${cx - r - 1.5},${cy - r * 0.2} ${cx - r * 0.4},${cy - r * 0.35}`}
        fill={color}
        stroke="#ffffff"
        strokeWidth={1}
      />
    );
  };
}

function getApplicabilityBadgeClass(tone: "blue" | "amber" | "rose"): string {
  if (tone === "blue") {
    return "bg-blue-50 text-[#0B63CE] border-blue-200";
  }
  if (tone === "amber") {
    return "bg-amber-50 text-amber-800 border-amber-300";
  }
  return "bg-rose-50 text-rose-800 border-rose-300";
}

function getHttpStatus(err: unknown): number | undefined {
  if (err && typeof err === "object" && "status" in err) {
    return (err as { status?: number }).status;
  }
  return undefined;
}

export const LiveForecastPage: React.FC<LiveForecastPageProps> = ({
  datasets,
  datasetId,
  onSelectDataset,
  health,
  adminRole,
  onLiveBannerChange,
  precomputedForecasts,
}) => {
  const activeDataset = datasets.find((d) => d.id === datasetId);

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [offlineMessage, setOfflineMessage] = useState<string | null>(null);
  const [statusIsFormatError, setStatusIsFormatError] = useState(false);
  const [pollError, setPollError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);

  const [status, setStatus] = useState<LiveStatusResponse | null>(null);
  const [forecast, setForecast] = useState<LiveForecastResponse | null>(null);
  const [forecastError, setForecastError] = useState<string | null>(null);
  const [monitor, setMonitor] = useState<LiveMonitorResponse | null>(null);
  const [monitorError, setMonitorError] = useState<string | null>(null);
  const [versions, setVersions] = useState<LiveVersionsResponse | null>(null);
  const [versionsError, setVersionsError] = useState<string | null>(null);
  const [pending, setPending] = useState<LivePendingResponse | null>(null);
  const [pendingError, setPendingError] = useState<string | null>(null);
  const [events, setEvents] = useState<LiveEventsResponse | null>(null);
  const [eventsError, setEventsError] = useState<string | null>(null);

  const [expandedTaskIds, setExpandedTaskIds] = useState<Record<string, boolean>>({});

  // Admin panel state (only rendered when adminRole.role === "admin")
  const [ingestSource, setIngestSource] = useState<"synthetic" | "unverified_import">("synthetic");
  const [ingestLicenseNote, setIngestLicenseNote] = useState("");
  const [ingestCsvText, setIngestCsvText] = useState("");
  const [ingestFilename, setIngestFilename] = useState("");
  const [adminBusy, setAdminBusy] = useState(false);
  const [writeResult, setWriteResult] = useState<LiveWriteResult | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [commitNote, setCommitNote] = useState("");
  const [rollbackTarget, setRollbackTarget] = useState("");
  const [rollbackReason, setRollbackReason] = useState("");
  const [rollbackConfirmOpen, setRollbackConfirmOpen] = useState(false);
  const [simScenario, setSimScenario] = useState<"normal" | "missing" | "stuck" | "disconnect">("normal");

  const loadFullDetails = useCallback(
    async (targetDatasetId: string, nextStatus: LiveStatusResponse) => {
      const noForecastTasks = targetDatasetId === "rearing_plant_1_north";

      const [fcRes, monRes, verRes, penRes, evRes] = await Promise.allSettled([
        noForecastTasks
          ? Promise.resolve<LiveForecastResponse | null>(null)
          : fetchLiveForecast(targetDatasetId),
        fetchLiveMonitor(targetDatasetId),
        fetchLiveVersions(targetDatasetId),
        fetchLivePending(targetDatasetId),
        fetchLiveEvents(targetDatasetId),
      ]);

      if (fcRes.status === "fulfilled") {
        setForecast(fcRes.value);
        setForecastError(null);
      } else {
        setForecast(null);
        const st = getHttpStatus(fcRes.reason);
        setForecastError(
          fcRes.reason instanceof LiveFormatError
            ? LIVE_FORMAT_ERROR_MESSAGE
            : st === 404
              ? fcRes.reason instanceof Error
                ? fcRes.reason.message
                : "尚無即時預測資料"
              : fcRes.reason instanceof Error
                ? fcRes.reason.message
                : "載入即時預測失敗"
        );
      }

      if (monRes.status === "fulfilled") {
        setMonitor(monRes.value);
        setMonitorError(null);
      } else {
        setMonitor(null);
        setMonitorError(
          monRes.reason instanceof LiveFormatError
            ? LIVE_FORMAT_ERROR_MESSAGE
            : monRes.reason instanceof Error
              ? monRes.reason.message
              : null
        );
      }

      if (verRes.status === "fulfilled") {
        setVersions(verRes.value);
        setVersionsError(null);
      } else {
        setVersions(null);
        setVersionsError(
          verRes.reason instanceof LiveFormatError
            ? LIVE_FORMAT_ERROR_MESSAGE
            : verRes.reason instanceof Error
              ? verRes.reason.message
              : null
        );
      }

      if (penRes.status === "fulfilled") {
        setPending(penRes.value);
        setPendingError(null);
      } else {
        setPending(null);
        setPendingError(
          penRes.reason instanceof LiveFormatError
            ? LIVE_FORMAT_ERROR_MESSAGE
            : penRes.reason instanceof Error
              ? penRes.reason.message
              : null
        );
      }

      if (evRes.status === "fulfilled") {
        setEvents(evRes.value);
        setEventsError(null);
      } else {
        setEvents(null);
        setEventsError(
          evRes.reason instanceof LiveFormatError
            ? LIVE_FORMAT_ERROR_MESSAGE
            : evRes.reason instanceof Error
              ? evRes.reason.message
              : null
        );
      }
    },
    []
  );

  const loadInitialForDataset = useCallback(
    async (targetId: string, isCancelled?: () => boolean) => {
      setLoading(true);
      setOfflineMessage(null);
      setStatusIsFormatError(false);
      setPollError(null);
      setStatus(null);
      setForecast(null);
      setForecastError(null);
      setMonitor(null);
      setMonitorError(null);
      setVersions(null);
      setVersionsError(null);
      setPending(null);
      setPendingError(null);
      setEvents(null);
      setEventsError(null);
      setWriteResult(null);
      setWriteError(null);
      setRollbackTarget("");
      setRollbackConfirmOpen(false);
      onLiveBannerChange("offline");

      try {
        const nextStatus = await fetchLiveStatus(targetId);
        if (isCancelled?.()) return;
        setStatus(nextStatus);
        setLastUpdatedAt(
          new Date().toLocaleTimeString("zh-Hant", { hour12: false })
        );
        await loadFullDetails(targetId, nextStatus);
      } catch (err) {
        if (isCancelled?.()) return;
        const isFormatErr = err instanceof LiveFormatError;
        setStatusIsFormatError(isFormatErr);
        const msg = isFormatErr
          ? LIVE_FORMAT_ERROR_MESSAGE
          : err instanceof Error
            ? err.message
            : LIVE_OFFLINE_MESSAGE;
        setOfflineMessage(msg);
      } finally {
        if (!isCancelled?.()) setLoading(false);
      }
    },
    [loadFullDetails, onLiveBannerChange]
  );

  useEffect(() => {
    let cancelled = false;
    void loadInitialForDataset(datasetId, () => cancelled);
    return () => {
      cancelled = true;
    };
  }, [datasetId, loadInitialForDataset]);

  useEffect(() => {
    onLiveBannerChange(getLiveBannerKind(status, forecast));
  }, [status, forecast, onLiveBannerChange]);

  const pollStatus = useCallback(
    async (forceFull = false) => {
      if (loading) return;
      setRefreshing(true);
      try {
        const nextStatus = await fetchLiveStatus(datasetId);
        setPollError(null);
        setOfflineMessage(null);

        const needRefetch =
          forceFull || shouldRefetchForecastOnPoll(status, nextStatus, forecast);

        setStatus(nextStatus);
        setLastUpdatedAt(
          new Date().toLocaleTimeString("zh-Hant", { hour12: false })
        );

        if (needRefetch || !status) {
          await loadFullDetails(datasetId, nextStatus);
        } else {
          // Always refresh versions/pending/events/monitor if status polled cleanly after manual/sim change
          const [monRes, verRes, penRes, evRes] = await Promise.allSettled([
            fetchLiveMonitor(datasetId),
            fetchLiveVersions(datasetId),
            fetchLivePending(datasetId),
            fetchLiveEvents(datasetId),
          ]);
          if (monRes.status === "fulfilled") {
            setMonitor(monRes.value);
            setMonitorError(null);
          } else if (monRes.reason instanceof LiveFormatError) {
            setMonitor(null);
            setMonitorError(LIVE_FORMAT_ERROR_MESSAGE);
          }
          if (verRes.status === "fulfilled") {
            setVersions(verRes.value);
            setVersionsError(null);
          } else if (verRes.reason instanceof LiveFormatError) {
            setVersions(null);
            setVersionsError(LIVE_FORMAT_ERROR_MESSAGE);
          }
          if (penRes.status === "fulfilled") {
            setPending(penRes.value);
            setPendingError(null);
          } else if (penRes.reason instanceof LiveFormatError) {
            setPending(null);
            setPendingError(LIVE_FORMAT_ERROR_MESSAGE);
          }
          if (evRes.status === "fulfilled") {
            setEvents(evRes.value);
            setEventsError(null);
          } else if (evRes.reason instanceof LiveFormatError) {
            setEvents(null);
            setEventsError(LIVE_FORMAT_ERROR_MESSAGE);
          }
        }
      } catch (err) {
        const isFormatErr = err instanceof LiveFormatError;
        const msg = isFormatErr
          ? LIVE_FORMAT_ERROR_MESSAGE
          : err instanceof Error
            ? err.message
            : LIVE_OFFLINE_MESSAGE;
        if (!status) {
          setStatusIsFormatError(isFormatErr);
          setOfflineMessage(msg);
        } else {
          setPollError(
            isFormatErr
              ? LIVE_FORMAT_ERROR_MESSAGE
              : `自動更新失敗（保留上次畫面）：${msg}`
          );
        }
      } finally {
        setRefreshing(false);
      }
    },
    [datasetId, forecast, loadFullDetails, loading, status]
  );

  // 30s auto polling paused when document is hidden
  useEffect(() => {
    let timerId: number | null = null;
    const startPolling = () => {
      if (timerId !== null) window.clearInterval(timerId);
      timerId = window.setInterval(() => {
        if (document.visibilityState === "visible") {
          void pollStatus(false);
        }
      }, 30_000);
    };

    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        void pollStatus(false);
      }
    };

    startPolling();
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      if (timerId !== null) window.clearInterval(timerId);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [pollStatus]);

  const syntheticActive = useMemo(
    () => isLiveDataSynthetic(status, forecast),
    [status, forecast]
  );

  const freshness = useMemo(
    () => (status ? getFreshnessDisplay(status) : null),
    [status]
  );

  const versionMatches = useMemo(
    () => doesForecastMatchVersion(status, forecast),
    [status, forecast]
  );

  const isNoTasksDomain = useMemo(() => {
    if (datasetId === "rearing_plant_1_north") {
      return !forecast || forecast.n_tasks === 0 || forecast.tasks.length === 0;
    }
    if (forecast && forecast.n_tasks === 0) return true;
    return false;
  }, [datasetId, forecast]);

  const versionsSignature = useMemo(() => {
    if (!versions) return "";
    return `${status?.current_version ?? ""}|${versions
      .map((v) => `${v.version_id}:${v.is_current ? 1 : 0}`)
      .join(",")}`;
  }, [versions, status?.current_version]);

  useEffect(() => {
    if (!versions || versions.length === 0) {
      setRollbackTarget("");
      return;
    }
    setRollbackTarget(getDefaultRollbackTarget(versions, status?.current_version));
  }, [versionsSignature]); // eslint-disable-line react-hooks/exhaustive-deps

  const sensorGroups = useMemo(() => {
    if (!forecast || isNoTasksDomain) return [];
    return groupLiveTasksBySensor(forecast.tasks ?? []);
  }, [forecast, isNoTasksDomain]);

  const recentVersions = useMemo(
    () => selectRecentVersionsNewestFirst(versions ?? [], 10),
    [versions]
  );

  const rollbackVersionsNewestFirst = useMemo(
    () => [...(versions ?? [])].reverse(),
    [versions]
  );

  const recentEvents = useMemo(
    () => orderEventsNewestFirst(events ?? []),
    [events]
  );

  const handleFileSelected = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setIngestFilename(file.name);
    const text = await file.text();
    setIngestCsvText(text);
  };

  const handleIngest = async (e: React.FormEvent) => {
    e.preventDefault();
    setWriteError(null);
    setWriteResult(null);
    if (!ingestLicenseNote.trim()) {
      setWriteError("請填寫來源與使用聲明說明（必填）");
      return;
    }
    if (!ingestCsvText.trim()) {
      setWriteError("請選擇 CSV 檔案或貼上 CSV 內容");
      return;
    }
    setAdminBusy(true);
    try {
      const res = await postLiveIngest(datasetId, {
        csv_text: ingestCsvText,
        source: ingestSource,
        license_note: ingestLicenseNote.trim(),
        ...(ingestFilename ? { filename: ingestFilename } : {}),
      });
      setWriteResult(res);
      await pollStatus(true);
    } catch (err) {
      setWriteError(err instanceof Error ? err.message : "匯入失敗");
    } finally {
      setAdminBusy(false);
    }
  };

  const handleCommit = async (uploadId: string) => {
    setWriteError(null);
    setWriteResult(null);
    setAdminBusy(true);
    try {
      const res = await postLiveCommit(datasetId, {
        upload_id: uploadId,
        ...(commitNote.trim() ? { notes: commitNote.trim() } : {}),
      });
      setWriteResult(res);
      setCommitNote("");
      await pollStatus(true);
    } catch (err) {
      setWriteError(err instanceof Error ? err.message : "核准提交失敗");
    } finally {
      setAdminBusy(false);
    }
  };

  const handleConfirmRollback = async () => {
    setWriteError(null);
    setWriteResult(null);
    if (!rollbackTarget) {
      setWriteError("請選擇要回復的目標版本");
      return;
    }
    if (!rollbackReason.trim()) {
      setWriteError("請填寫回復原因");
      return;
    }
    setAdminBusy(true);
    try {
      const res = await postLiveRollback(datasetId, {
        to_version: rollbackTarget,
        reason: rollbackReason.trim(),
      });
      setWriteResult(res);
      setRollbackConfirmOpen(false);
      setRollbackReason("");
      await pollStatus(true);
    } catch (err) {
      setWriteError(err instanceof Error ? err.message : "回復版本失敗");
    } finally {
      setAdminBusy(false);
    }
  };

  const handleRecompute = async () => {
    setWriteError(null);
    setWriteResult(null);
    setAdminBusy(true);
    try {
      const res = await postLiveRecompute(datasetId);
      setWriteResult(res);
      await pollStatus(true);
    } catch (err) {
      setWriteError(err instanceof Error ? err.message : "重算失敗");
    } finally {
      setAdminBusy(false);
    }
  };

  const handleSimTick = async () => {
    setWriteError(null);
    setWriteResult(null);
    setAdminBusy(true);
    try {
      const res = await postLiveSimTick(datasetId, { scenario: simScenario });
      setWriteResult(res);
      await pollStatus(true);
    } catch (err) {
      setWriteError(err instanceof Error ? err.message : "推進模擬資料流失敗");
    } finally {
      setAdminBusy(false);
    }
  };

  return (
    <div className="space-y-6 min-w-0">
      {/* Synthetic stream hard separation notice */}
      {syntheticActive && (
        <div
          role="alert"
          className="bg-amber-50 border border-amber-300 rounded-lg p-4 text-xs sm:text-sm text-amber-950 flex items-start gap-2.5 min-w-0"
        >
          <AlertTriangle className="h-4 w-4 text-amber-700 shrink-0 mt-0.5" />
          <div className="min-w-0 break-words font-medium">
            此頁是模擬資料流（合成）：不是真實資料；預測只是流程展示，不能代表真實世界
          </div>
        </div>
      )}

      {/* Header & Domain Selector */}
      <section className="bg-white border border-slate-200 rounded-lg p-4 sm:p-5 space-y-4 min-w-0">
        <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4 min-w-0">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-bold text-slate-900">
                即時預測資料流
              </h1>
              <span className="text-[11px] font-medium px-2 py-0.5 rounded bg-slate-100 text-slate-700 border border-slate-300">
                研究預測（探索性、未經獨立前瞻驗證）
              </span>
            </div>
            <p className="text-xs sm:text-sm text-slate-600">
              所有即時狀態、預測點與監測指標皆直接來自 Python 引擎；無警戒門檻、無設備控制，不以離線預計算檔充當即時預測。
            </p>
          </div>

          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 w-full md:w-auto min-w-0">
            <label htmlFor="live-domain-select" className="sr-only">
              切換場域
            </label>
            <select
              id="live-domain-select"
              value={datasetId}
              onChange={(e) => onSelectDataset(e.target.value)}
              className="w-full sm:w-auto max-w-full min-w-0 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-800 focus:border-[#0B63CE] focus:outline-none"
            >
              {datasets.map((ds) => (
                <option key={ds.id} value={ds.id}>
                  {ds.display_name}
                </option>
              ))}
            </select>

            <button
              type="button"
              onClick={() => void pollStatus(true)}
              disabled={loading || refreshing}
              className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md border border-slate-300 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60 shrink-0"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`}
              />
              立即重新讀取
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 pt-2 border-t border-slate-100">
          <div className="inline-flex items-center gap-1.5">
            <Clock className="h-3.5 w-3.5" />
            <span>上次更新時間：{lastUpdatedAt ?? "尚未取得"}</span>
          </div>
          <span>每 30 秒自動輪詢狀態（分頁隱藏時自動暫停）</span>
        </div>

        {pollError && (
          <div className="text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded px-3 py-2 break-words">
            {pollError}
          </div>
        )}
      </section>

      {/* Loading */}
      {loading && (
        <section className="bg-white border border-slate-200 rounded-lg p-6 text-center text-sm text-slate-600">
          正在連線讀取即時預測狀態…
        </section>
      )}

      {/* Offline / format error state (503 / non-JSON / invalid format, no fallback to precomputed) */}
      {!loading && offlineMessage && !status && (
        <section
          data-testid="live-offline-card"
          className={`bg-white border rounded-lg p-5 sm:p-6 space-y-3 min-w-0 ${
            statusIsFormatError ? "border-rose-300" : "border-slate-300"
          }`}
        >
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-semibold border ${
                statusIsFormatError
                  ? "bg-rose-50 text-rose-800 border-rose-200"
                  : "bg-slate-100 text-slate-800 border-slate-300"
              }`}
            >
              {statusIsFormatError ? (
                <AlertTriangle className="h-3.5 w-3.5 text-rose-600" />
              ) : (
                <WifiOff className="h-3.5 w-3.5 text-slate-600" />
              )}
              {statusIsFormatError ? "格式錯誤" : "尚未連線"}
            </span>
            <h2 className="text-base font-bold text-slate-900">
              {statusIsFormatError ? LIVE_FORMAT_ERROR_MESSAGE : "即時預測不可用"}
            </h2>
          </div>
          <p className="text-sm text-slate-700 break-words">{offlineMessage}</p>
          {!statusIsFormatError && (
            <p className="text-xs text-slate-500">
              依資料誠實政策，引擎尚未連線時不會以離線預計算輸出充當即時預測。請確認分析引擎已連線後再試；
              在那之前，可以使用下方「展示：模擬新資料匯入」——它使用預先準備好的資料，並明確標示為展示。
            </p>
          )}
        </section>
      )}

      {/* 沒有即時資料流時：預先準備好的資料＋模擬新資料匯入（展示；不是即時） */}
      {!loading && !status && (
        <DemoImportSimulation
          datasets={datasets}
          datasetId={datasetId}
          onSelectDataset={onSelectDataset}
          precomputedForecasts={precomputedForecasts ?? null}
        />
      )}

      {/* Connected Status & Data Sections */}
      {!loading && status && (
        <>
          {/* Stale prominent alert */}
          {freshness?.warningText && (
            <div
              role="alert"
              className="bg-rose-50 border border-rose-300 rounded-lg p-4 flex items-start gap-2.5 text-xs sm:text-sm text-rose-900 min-w-0"
            >
              <AlertTriangle className="h-4 w-4 text-rose-700 shrink-0 mt-0.5" />
              <div className="min-w-0 break-words">
                <strong className="font-semibold">{freshness.warningText}</strong>
                <span className="ml-1.5 text-rose-800">
                  （{freshness.settingText}）
                </span>
              </div>
            </div>
          )}

          {/* Status Card */}
          <section
            aria-label="即時資料流狀態"
            className="bg-white border border-slate-200 rounded-lg p-4 sm:p-5 space-y-4 min-w-0"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 min-w-0">
              <h2 className="text-base font-semibold text-slate-900 flex items-center gap-2">
                <Activity className="h-4 w-4 text-[#0B63CE]" />
                場域即時狀態
              </h2>
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`text-xs font-medium px-2.5 py-0.5 rounded border ${
                    freshness?.isStale
                      ? "bg-amber-50 text-amber-900 border-amber-300"
                      : "bg-blue-50 text-[#0B63CE] border-blue-200"
                  }`}
                >
                  新鮮度：{freshness?.badgeLabel}
                </span>
                <span className="text-xs font-medium px-2.5 py-0.5 rounded border border-slate-200 bg-slate-50 text-slate-700">
                  {formatLiveClockMode(status.mode)}
                </span>
              </div>
            </div>

            <dl className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 text-xs min-w-0">
              <div className="border border-slate-200 rounded-md p-3 bg-slate-50/70 min-w-0">
                <dt className="text-slate-500">資料終點</dt>
                <dd className="font-mono-tabular text-sm font-semibold text-slate-900 mt-1 break-all">
                  {status.data_end ?? "-"}
                </dd>
                <div className="text-[11px] text-slate-500 mt-1">
                  {freshness?.settingText}
                </div>
              </div>

              <div className="border border-slate-200 rounded-md p-3 bg-slate-50/70 min-w-0">
                <dt className="text-slate-500">目前版本與預測對齊</dt>
                <dd className="font-mono-tabular text-sm font-semibold text-slate-900 mt-1 break-all">
                  {status.current_version ?? "-"}
                </dd>
                <div className="text-[11px] text-slate-600 mt-1">
                  {versionMatches === true
                    ? "預測與目前版本一致"
                    : versionMatches === false
                      ? "預測版本與目前資料版本尚未一致"
                      : "尚無可比對的預測版本"}
                  {status.latest_source ? ` · 來源：${status.latest_source}` : ""}
                </div>
              </div>

              <div className="border border-slate-200 rounded-md p-3 bg-slate-50/70 min-w-0">
                <dt className="text-slate-500">資料流健康資訊（health）</dt>
                <dd className="text-sm font-semibold text-slate-900 mt-1 break-words">
                  {typeof status.health === "string"
                    ? status.health
                    : status.health?.detail ??
                      status.health?.status ??
                      (status.health?.ok ? "連線運作中" : "已回報")}
                </dd>
                <div className="text-[11px] text-slate-500 mt-1">
                  研究預測（探索性、未經獨立前瞻驗證）
                </div>
              </div>
            </dl>

            {/* Engine flags[] verbatim text */}
            {Array.isArray(status.flags) && status.flags.length > 0 && (
              <div className="space-y-1.5 pt-2 border-t border-slate-100 min-w-0">
                <div className="text-xs font-medium text-slate-600">
                  引擎狀態標記（flags）
                </div>
                <div className="flex flex-wrap gap-2 min-w-0">
                  {status.flags
                    .map((f) => {
                      if (typeof f === "string") return f.trim();
                      const obj = f as unknown as Record<string, unknown>;
                      const candidate = obj.text ?? obj.message ?? obj.code ?? "";
                      return typeof candidate === "string" ? candidate.trim() : "";
                    })
                    .filter(Boolean)
                    .map((text, idx) => (
                      <span
                        key={idx}
                        className="text-xs px-2.5 py-1 rounded bg-slate-100 border border-slate-200 text-slate-800 break-words"
                      >
                        {text}
                      </span>
                    ))}
                </div>
              </div>
            )}
          </section>

          {/* Forecast Section */}
          {isNoTasksDomain ? (
            <section
              data-testid="live-no-tasks-card"
              className="bg-white border border-slate-200 rounded-lg p-5 space-y-2 min-w-0"
            >
              <h2 className="text-base font-semibold text-slate-900">
                此場域不提供預測
              </h2>
              <p className="text-xs sm:text-sm text-slate-600">
                {activeDataset?.display_name ?? datasetId}（n_tasks=0）：因可用連續區段不足，依平台政策不建立預測任務、不顯示預測圖表與數值。
              </p>
            </section>
          ) : (
            <section className="space-y-4 min-w-0" aria-label="即時預測結果">
              {forecast?.guard?.alerts_ok === false && (
                <div
                  role="alert"
                  className="bg-amber-50 border border-amber-300 rounded-lg p-4 flex items-start gap-2.5 text-xs sm:text-sm text-amber-950 min-w-0"
                >
                  <ShieldAlert className="h-4 w-4 text-amber-700 shrink-0 mt-0.5" />
                  <div className="min-w-0 break-words">
                    <strong className="font-semibold">適用性守門不可用</strong>
                    {forecast.guard.reason ? `：${forecast.guard.reason}` : ""}
                  </div>
                </div>
              )}

              {forecastError && !forecast && (
                <div className="bg-white border border-slate-200 rounded-lg p-5 text-sm text-slate-700 break-words">
                  {forecastError}
                </div>
              )}

              {!forecastError && !forecast && (
                <div className="bg-white border border-slate-200 rounded-lg p-5 text-sm text-slate-600">
                  尚無即時預測資料
                </div>
              )}

              {forecast && (
                <div className="space-y-5 min-w-0">
                  <div className="bg-white border border-slate-200 rounded-lg p-4 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600 min-w-0">
                    <div>
                      <strong className="text-slate-900">
                        研究預測（探索性、未經獨立前瞻驗證）
                      </strong>
                      <span className="ml-2">
                        目前沒有 90% 區間；無警戒門檻、無設備控制。
                      </span>
                    </div>
                    <div className="font-mono-tabular text-slate-700 break-all">
                      發出時間：{forecast.issued_at ?? "-"} ｜ 資料版本：
                      {forecast.data_version ?? "-"}
                    </div>
                  </div>

                  {sensorGroups.map((group) => {
                    const sharedHist = forecast.history?.[group.sensor];
                    const chartSeries = buildLiveSensorChartSeries(
                      group.tasks,
                      sharedHist
                    );

                    return (
                      <div
                        key={group.sensor}
                        data-live-sensor-chart={group.sensor}
                        className="bg-white border border-slate-200 rounded-lg p-4 sm:p-5 space-y-4 min-w-0"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2 min-w-0">
                          <div>
                            <h3 className="text-base font-semibold text-slate-900">
                              {group.sensor}（+1／+3／+6 小時研究預測）
                            </h3>
                            <div className="text-xs text-slate-500 mt-0.5">
                              單位：{group.unit || "未標示"} ｜ 最近 72 小時歷史與六種方法預測點（以不同幾何形狀區分；未使用雙 Y 軸）
                            </div>
                          </div>
                          <span className="text-[11px] px-2 py-0.5 rounded bg-slate-100 border border-slate-200 text-slate-700">
                            研究預測（探索性、未經獨立前瞻驗證）
                          </span>
                        </div>

                        {/* Shape + label custom legend */}
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-slate-700 bg-slate-50 border border-slate-200 rounded-md px-3 py-2">
                          <span className="inline-flex items-center gap-1.5 font-medium">
                            <span className="inline-block w-4 h-0.5 bg-slate-700" />
                            歷史觀測 (72h)
                          </span>
                          {MODEL_ORDER.map((mKey) => {
                            const vis = METHOD_VISUALS[mKey];
                            return (
                              <span
                                key={mKey}
                                className="inline-flex items-center gap-1.5"
                              >
                                <ShapeGlyph shape={vis.shape} color={vis.color} />
                                <span>{vis.label}</span>
                              </span>
                            );
                          })}
                        </div>

                        {/* Chart */}
                        <div className="w-full h-72 min-w-0">
                          <ResponsiveContainer width="100%" height="100%">
                            <ComposedChart
                              data={chartSeries}
                              margin={{ top: 10, right: 16, left: 0, bottom: 5 }}
                            >
                              <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                              <XAxis
                                dataKey="tsMs"
                                type="number"
                                scale="time"
                                domain={["auto", "auto"]}
                                tick={{ fontSize: 11, fill: "#64748B" }}
                                tickFormatter={(v) =>
                                  typeof v === "number"
                                    ? formatChartTimeLabel(v, "hourly")
                                    : String(v)
                                }
                              />
                              <YAxis
                                tick={{ fontSize: 11, fill: "#64748B" }}
                                width={52}
                                domain={["auto", "auto"]}
                              />
                              <Tooltip
                                labelFormatter={(v) =>
                                  typeof v === "number"
                                    ? formatChartTimeLabel(v, "hourly", true)
                                    : String(v)
                                }
                              />
                              <Line
                                type="monotone"
                                dataKey="historyValue"
                                name="歷史觀測 (72h)"
                                stroke="#334155"
                                strokeWidth={1.8}
                                dot={false}
                                connectNulls={false}
                                isAnimationActive={false}
                              />
                              {MODEL_ORDER.map((mKey) => {
                                const vis = METHOD_VISUALS[mKey];
                                return (
                                  <Line
                                    key={mKey}
                                    type="monotone"
                                    dataKey={mKey}
                                    name={vis.label}
                                    stroke="none"
                                    strokeWidth={0}
                                    connectNulls={false}
                                    isAnimationActive={false}
                                    dot={renderRechartsShapeDot(
                                      vis.shape,
                                      vis.color
                                    )}
                                    activeDot={{ r: 7 }}
                                  />
                                );
                              })}
                            </ComposedChart>
                          </ResponsiveContainer>
                        </div>

                        {/* Per-horizon applicability + 6-method prediction values table */}
                        <div className="space-y-3 min-w-0">
                          {group.tasks.map((task) => {
                            const appStatus = formatApplicabilityStatus(
                              task.applicability?.status
                            );
                            const reasons = [
                              ...(task.applicability?.reasons ?? []),
                              ...(task.applicability?.reason
                                ? [task.applicability.reason]
                                : []),
                              ...(task.applicability?.detail
                                ? [task.applicability.detail]
                                : []),
                            ];
                            const isExpanded = Boolean(
                              expandedTaskIds[task.task_id]
                            );

                            return (
                              <div
                                key={task.task_id}
                                className="border border-slate-200 rounded-md p-3 space-y-2.5 min-w-0"
                              >
                                <div className="flex flex-wrap items-center justify-between gap-2 text-xs min-w-0">
                                  <div className="flex flex-wrap items-center gap-2 min-w-0">
                                    <span className="font-semibold text-slate-900">
                                      +{task.horizon_h} 小時
                                    </span>
                                    <span className="font-mono-tabular text-slate-600">
                                      目標：{task.target_timestamp}
                                    </span>
                                    <span
                                      className={`px-2 py-0.5 rounded border font-medium ${getApplicabilityBadgeClass(
                                        appStatus.tone
                                      )}`}
                                    >
                                      適用性：{appStatus.label}
                                    </span>
                                    {reasons.length > 0 && (
                                      <button
                                        type="button"
                                        onClick={() =>
                                          setExpandedTaskIds((prev) => ({
                                            ...prev,
                                            [task.task_id]: !prev[task.task_id],
                                          }))
                                        }
                                        className="inline-flex items-center gap-1 text-[#0B63CE] hover:underline font-medium"
                                      >
                                        {isExpanded ? (
                                          <>
                                            收合原因
                                            <ChevronUp className="h-3.5 w-3.5" />
                                          </>
                                        ) : (
                                          <>
                                            查看原因 ({reasons.length})
                                            <ChevronDown className="h-3.5 w-3.5" />
                                          </>
                                        )}
                                      </button>
                                    )}
                                  </div>
                                  <div className="font-mono-tabular text-[11px] text-slate-500">
                                    issued_at：{task.issued_at ?? forecast.issued_at ?? "-"} ｜ 版本：
                                    {task.data_version ?? forecast.data_version ?? "-"}
                                  </div>
                                </div>

                                {isExpanded && reasons.length > 0 && (
                                  <ul className="list-disc pl-5 text-xs text-slate-700 bg-slate-50 border border-slate-200 rounded p-2.5 space-y-1">
                                    {reasons.map((r, idx) => (
                                      <li key={idx} className="break-words">
                                        {r}
                                      </li>
                                    ))}
                                  </ul>
                                )}

                                <div className="overflow-x-auto min-w-0">
                                  <table className="w-full text-xs border-collapse min-w-[520px]">
                                    <thead>
                                      <tr className="border-b border-slate-200 text-left text-slate-500">
                                        <th className="py-1.5 pr-3">預測方法</th>
                                        <th className="py-1.5 pr-3">研究預測值</th>
                                        <th className="py-1.5">狀態／拒絕原因</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {MODEL_ORDER.map((mKey) => {
                                        const entry = task.models?.[mKey];
                                        const val =
                                          entry &&
                                          typeof entry.value === "number" &&
                                          Number.isFinite(entry.value)
                                            ? entry.value
                                            : null;
                                        return (
                                          <tr
                                            key={mKey}
                                            className="border-b border-slate-100 last:border-none"
                                          >
                                            <td className="py-1.5 pr-3 font-medium text-slate-800 whitespace-nowrap">
                                              <span className="inline-flex items-center gap-1.5">
                                                <ShapeGlyph
                                                  shape={METHOD_VISUALS[mKey].shape}
                                                  color={METHOD_VISUALS[mKey].color}
                                                />
                                                {LIVE_METHOD_LABELS[mKey]} ({mKey})
                                              </span>
                                            </td>
                                            <td className="py-1.5 pr-3 font-mono-tabular text-slate-900 whitespace-nowrap">
                                              {val !== null
                                                ? `${val.toFixed(3)} ${group.unit}`
                                                : "—"}
                                            </td>
                                            <td className="py-1.5 text-slate-600 break-words">
                                              {val !== null
                                                ? "研究預測（探索性、未經獨立前瞻驗證）"
                                                : `已拒絕：${entry?.refused || "引擎未產生數值（不借用其他方法補上）"}`}
                                            </td>
                                          </tr>
                                        );
                                      })}
                                    </tbody>
                                  </table>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          )}

          {/* Monitor Section */}
          {!isNoTasksDomain && (monitor || monitorError) && (
            <section
              aria-label="流程穩定性監測"
              className="bg-white border border-slate-200 rounded-lg p-4 sm:p-5 space-y-3 min-w-0"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="text-base font-semibold text-slate-900">
                    流程穩定性監測，不是模型效能
                  </h2>
                  {monitor?.note && (
                    <p className="text-xs text-slate-600 mt-0.5 break-words">
                      {monitor.note}
                    </p>
                  )}
                </div>
                {monitor && (
                  <span className="font-mono-tabular text-xs px-2.5 py-1 rounded bg-slate-100 border border-slate-200 text-slate-800">
                    已到期比對數 n_matured：{monitor.n_matured ?? 0}
                  </span>
                )}
              </div>

              {monitorError ? (
                <div className="text-xs text-rose-800 bg-rose-50 border border-rose-200 rounded p-3">
                  {monitorError}
                </div>
              ) : monitor && monitor.tasks && monitor.tasks.length > 0 ? (
                <div className="overflow-x-auto min-w-0">
                  <table className="w-full text-xs border-collapse min-w-[620px]">
                    <thead>
                      <tr className="border-b border-slate-200 text-left text-slate-500">
                        <th className="py-2 pr-3">任務</th>
                        {MODEL_ORDER.map((m) => (
                          <th key={m} className="py-2 pr-3">
                            {m} MAE（vs persistence）
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {monitor.tasks.map((mt) => (
                        <tr
                          key={mt.task_id}
                          className="border-b border-slate-100 last:border-none"
                        >
                          <td className="py-2 pr-3 font-medium text-slate-800 whitespace-nowrap">
                            {mt.sensor} (+{mt.horizon_h}h)
                          </td>
                          {MODEL_ORDER.map((m) => {
                            const stat = mt.methods?.[m];
                            const gap =
                              stat?.delta_vs_persistence ??
                              stat?.persistence_gap ??
                              null;
                            return (
                              <td
                                key={m}
                                className="py-2 pr-3 font-mono-tabular text-slate-700 whitespace-nowrap"
                              >
                                {stat && typeof stat.mae === "number"
                                  ? `${stat.mae.toFixed(3)} (${
                                      typeof gap === "number"
                                        ? `${gap >= 0 ? "+" : ""}${gap.toFixed(3)}`
                                        : "-"
                                    })`
                                  : stat?.refused
                                    ? "拒絕"
                                    : "—"}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="text-xs text-slate-500">
                  尚無已到期的監測紀錄。
                </div>
              )}
            </section>
          )}

          {/* Versions, Pending Uploads, Events */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 min-w-0">
            <section className="bg-white border border-slate-200 rounded-lg p-4 sm:p-5 space-y-3 min-w-0">
              <h2 className="text-base font-semibold text-slate-900">
                最近 10 個版本
              </h2>
              {versionsError ? (
                <div className="text-xs text-rose-800 bg-rose-50 border border-rose-200 rounded p-3">
                  {versionsError}
                </div>
              ) : recentVersions.length > 0 ? (
                <div className="overflow-x-auto min-w-0">
                  <table className="w-full text-xs border-collapse min-w-[520px]">
                    <thead>
                      <tr className="border-b border-slate-200 text-left text-slate-500">
                        <th className="py-1.5 pr-2">版本 ID</th>
                        <th className="py-1.5 pr-2">建立時間</th>
                        <th className="py-1.5 pr-2">新增列數</th>
                        <th className="py-1.5 pr-2">來源</th>
                        <th className="py-1.5">核准者</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recentVersions.map((v) => {
                        const isCur =
                          v.is_current === true ||
                          (Boolean(status.current_version) &&
                            v.version_id === status.current_version);
                        return (
                          <tr
                            key={`${v.seq ?? ""}-${v.version_id}`}
                            className="border-b border-slate-100 last:border-none"
                          >
                            <td className="py-1.5 pr-2 font-mono-tabular font-medium text-slate-900">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <span>{v.version_id}</span>
                                {isCur && (
                                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-[#0B63CE] border border-blue-200 font-sans">
                                    目前版本
                                  </span>
                                )}
                              </div>
                              {Array.isArray(v.time_range) &&
                                v.time_range.length >= 2 && (
                                  <div className="text-[10px] text-slate-500 mt-0.5">
                                    {v.time_range[0]} ~ {v.time_range[1]}
                                  </div>
                                )}
                            </td>
                            <td className="py-1.5 pr-2 font-mono-tabular text-slate-600 whitespace-nowrap">
                              {v.created_at}
                            </td>
                            <td className="py-1.5 pr-2 font-mono-tabular text-slate-700">
                              {v.rows_added}
                            </td>
                            <td className="py-1.5 pr-2 text-slate-700">
                              {v.source}
                            </td>
                            <td className="py-1.5 text-slate-600">
                              {v.approved_by || "—"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="text-xs text-slate-500">尚無版本紀錄。</div>
              )}
            </section>

            <section className="bg-white border border-slate-200 rounded-lg p-4 sm:p-5 space-y-4 min-w-0">
              <div className="space-y-2 min-w-0">
                <h2 className="text-base font-semibold text-slate-900">
                  待處理上傳清單（隔離區）
                </h2>
                {pendingError ? (
                  <div className="text-xs text-rose-800 bg-rose-50 border border-rose-200 rounded p-3">
                    {pendingError}
                  </div>
                ) : pending && pending.length > 0 ? (
                  <div className="space-y-2">
                    {pending.map((item) => {
                      const blockList = item.blocks ?? item.reasons ?? [];
                      return (
                        <div
                          key={item.upload_id}
                          className="border border-amber-200 bg-amber-50/70 rounded-md p-2.5 text-xs space-y-1"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-1.5">
                            <span className="font-mono-tabular font-semibold text-amber-950">
                              {item.upload_id}
                            </span>
                            {item.status && (
                              <span className="text-[11px] px-1.5 py-0.5 rounded bg-white border border-amber-300 text-amber-900">
                                {item.status}
                              </span>
                            )}
                          </div>
                          <div className="text-amber-900 break-words">
                            {item.filename ? `檔案：${item.filename} ｜ ` : ""}
                            {typeof item.n_block === "number" || typeof item.n_warn === "number"
                              ? `阻擋：${item.n_block ?? 0}／警告：${item.n_warn ?? 0} ｜ `
                              : ""}
                            {typeof item.rows === "number" ? `列數：${item.rows} ｜ ` : ""}
                            時間：{item.staged_at ?? item.created_at ?? "-"}
                          </div>
                          {blockList.length > 0 && (
                            <div className="text-amber-800 break-words">
                              原因：{blockList.join("；")}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="text-xs text-slate-500">
                    目前沒有待人工核准的隔離上傳。
                  </div>
                )}
              </div>

              <div className="space-y-2 pt-3 border-t border-slate-100 min-w-0">
                <h2 className="text-base font-semibold text-slate-900">
                  最近事件紀錄
                </h2>
                {eventsError ? (
                  <div className="text-xs text-rose-800 bg-rose-50 border border-rose-200 rounded p-3">
                    {eventsError}
                  </div>
                ) : recentEvents.length > 0 ? (
                  <div className="space-y-1.5 max-h-60 overflow-y-auto pr-1">
                    {recentEvents.map((ev, idx) => (
                      <div
                        key={`${ev.seq ?? idx}-${ev.t}-${ev.kind}`}
                        className="border border-slate-200 rounded px-2.5 py-2 text-xs bg-slate-50/60 space-y-0.5"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-semibold text-slate-800">
                            {ev.kind}
                            {typeof ev.seq === "number" ? ` (#${ev.seq})` : ""}
                          </span>
                          <span className="font-mono-tabular text-[11px] text-slate-500">
                            {ev.t}
                          </span>
                        </div>
                        {(ev.upload_id || ev.version_id || ev.detail) && (
                          <div className="text-slate-700 break-words font-mono-tabular text-[11px]">
                            {[
                              ev.upload_id ? `upload: ${ev.upload_id}` : null,
                              ev.version_id ? `version: ${ev.version_id}` : null,
                              ev.detail ? String(ev.detail) : null,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-xs text-slate-500">尚無近期事件。</div>
                )}
              </div>
            </section>
          </div>
        </>
      )}

      {/* Admin Write Panel (STRICTLY hidden unless adminRole.role === "admin") */}
      {adminRole.role === "admin" && (
        <section
          data-testid="live-admin-panel"
          aria-label="即時預測管理者面板"
          className="bg-white border-2 border-[#0B63CE]/30 rounded-lg p-4 sm:p-5 space-y-5 min-w-0"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 pb-3">
            <div className="flex items-center gap-2">
              <Lock className="h-4 w-4 text-[#0B63CE]" />
              <h2 className="text-base font-bold text-slate-900">
                管理者操作面板（即時資料流寫入）
              </h2>
            </div>
            <span className="text-xs text-slate-500">
              所有核准人與變更稽核皆由伺服器端填入
            </span>
          </div>

          {writeError && (
            <div className="text-xs text-rose-800 bg-rose-50 border border-rose-200 rounded p-3 break-words">
              {writeError}
            </div>
          )}

          {writeResult && (
            <div className="text-xs text-slate-900 bg-blue-50 border border-blue-200 rounded p-3 space-y-1 break-words">
              <div className="font-semibold flex items-center gap-1.5 text-[#0B63CE]">
                <CheckCircle2 className="h-4 w-4" />
                操作結果：{formatLiveDecisionZh(writeResult.decision)}
              </div>
              {writeResult.version_id && (
                <div>版本：{writeResult.version_id}</div>
              )}
              {writeResult.upload_id && (
                <div>上傳編號：{writeResult.upload_id}</div>
              )}
              {typeof writeResult.rows_added === "number" && (
                <div>新增列數：{writeResult.rows_added}</div>
              )}
              {(writeResult.block_reasons ?? writeResult.reasons ?? []).length > 0 && (
                <ul className="list-disc pl-5 text-rose-800">
                  {(writeResult.block_reasons ?? writeResult.reasons ?? []).map(
                    (r, i) => (
                      <li key={i}>{r}</li>
                    )
                  )}
                </ul>
              )}
              {writeResult.message && <div>{writeResult.message}</div>}
            </div>
          )}

          {/* 1. CSV Ingest */}
          <form onSubmit={handleIngest} className="space-y-3 border border-slate-200 rounded-md p-3.5 min-w-0">
            <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-1.5">
              <Upload className="h-4 w-4 text-[#0B63CE]" />
              上傳 CSV 至即時資料流（上限 6 MB）
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <div className="space-y-1 min-w-0">
                <label className="block font-medium text-slate-700">
                  來源種類
                </label>
                <select
                  value={ingestSource}
                  onChange={(e) =>
                    setIngestSource(
                      e.target.value as "synthetic" | "unverified_import"
                    )
                  }
                  className="w-full max-w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm bg-white"
                >
                  <option value="synthetic">模擬資料流 (synthetic)</option>
                  <option value="unverified_import">
                    真實匯入待確認 (unverified_import)
                  </option>
                </select>
              </div>
              <div className="space-y-1 min-w-0">
                <label className="block font-medium text-slate-700">
                  來源與公開展示聲明（必填）
                </label>
                <input
                  type="text"
                  required
                  value={ingestLicenseNote}
                  onChange={(e) => setIngestLicenseNote(e.target.value)}
                  placeholder="例如：使用者確認可展示之模擬流／匯入批次說明"
                  className="w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm"
                />
              </div>
            </div>
            <div className="space-y-1.5 text-xs">
              <label className="block font-medium text-slate-700">
                選擇 CSV 檔案或直接貼上 CSV 文字
              </label>
              <input
                type="file"
                accept=".csv,text/csv"
                onChange={(e) => void handleFileSelected(e)}
                className="block w-full text-xs text-slate-600"
              />
              <textarea
                rows={3}
                value={ingestCsvText}
                onChange={(e) => setIngestCsvText(e.target.value)}
                placeholder="timestamp,..."
                className="w-full rounded-md border border-slate-300 p-2 font-mono-tabular text-xs"
              />
            </div>
            <button
              type="submit"
              disabled={adminBusy}
              className="px-3.5 py-1.5 rounded-md bg-[#0B63CE] text-white text-xs font-medium hover:bg-[#0952AD] disabled:opacity-60"
            >
              送出匯入檢查
            </button>
          </form>

          {/* 2. Pending quarantine commit */}
          {pending && pending.length > 0 && (
            <div className="space-y-2 border border-slate-200 rounded-md p-3.5 text-xs min-w-0">
              <h3 className="text-sm font-semibold text-slate-900">
                核准隔離區上傳
              </h3>
              <input
                type="text"
                value={commitNote}
                onChange={(e) => setCommitNote(e.target.value)}
                placeholder="核准備註（選填）"
                className="w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm"
              />
              <div className="space-y-2">
                {pending.map((item) => (
                  <div
                    key={item.upload_id}
                    className="flex flex-wrap items-center justify-between gap-2 bg-slate-50 border border-slate-200 rounded p-2"
                  >
                    <span className="font-mono-tabular text-slate-800">
                      {item.upload_id}
                      {item.filename ? ` · ${item.filename}` : ""}
                      {typeof item.n_block === "number"
                        ? `（阻擋 ${item.n_block}／警告 ${item.n_warn ?? 0}）`
                        : typeof item.rows === "number"
                          ? `（${item.rows} 列）`
                          : ""}
                    </span>
                    <button
                      type="button"
                      disabled={adminBusy}
                      onClick={() => void handleCommit(item.upload_id)}
                      className="px-2.5 py-1 rounded bg-[#0B63CE] text-white font-medium hover:bg-[#0952AD] disabled:opacity-60"
                    >
                      核准提交
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 3. Rollback & Recompute */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 min-w-0">
            <div className="border border-slate-200 rounded-md p-3.5 space-y-2.5 text-xs min-w-0">
              <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-1.5">
                <RotateCcw className="h-4 w-4 text-slate-700" />
                回復到指定版本
              </h3>
              <select
                value={rollbackTarget}
                onChange={(e) => setRollbackTarget(e.target.value)}
                className="w-full max-w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm bg-white"
              >
                <option value="">選擇目標版本</option>
                {rollbackVersionsNewestFirst.map((v) => (
                  <option key={v.version_id} value={v.version_id}>
                    {v.version_id}（{v.created_at}）
                  </option>
                ))}
              </select>
              <input
                type="text"
                value={rollbackReason}
                onChange={(e) => setRollbackReason(e.target.value)}
                placeholder="回復原因（必填）"
                className="w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm"
              />
              {!rollbackConfirmOpen ? (
                <button
                  type="button"
                  disabled={adminBusy || !rollbackTarget || !rollbackReason.trim()}
                  onClick={() => setRollbackConfirmOpen(true)}
                  className="px-3 py-1.5 rounded-md border border-rose-300 bg-rose-50 text-rose-800 font-medium hover:bg-rose-100 disabled:opacity-50"
                >
                  申請回復版本
                </button>
              ) : (
                <div className="bg-rose-50 border border-rose-300 rounded p-2.5 space-y-2">
                  <div className="font-medium text-rose-900">
                    二次確認：確定要將 {datasetId} 回復至 {rollbackTarget}？
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={adminBusy}
                      onClick={() => void handleConfirmRollback()}
                      className="px-3 py-1 rounded bg-rose-700 text-white font-medium hover:bg-rose-800"
                    >
                      確認回復
                    </button>
                    <button
                      type="button"
                      onClick={() => setRollbackConfirmOpen(false)}
                      className="px-3 py-1 rounded border border-slate-300 bg-white text-slate-700"
                    >
                      取消
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div className="space-y-3 min-w-0">
              {!isNoTasksDomain && (
                <div className="border border-slate-200 rounded-md p-3.5 space-y-2 text-xs">
                  <h3 className="text-sm font-semibold text-slate-900">
                    重算即時預測
                  </h3>
                  <button
                    type="button"
                    disabled={adminBusy}
                    onClick={() => void handleRecompute()}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-slate-800 text-white font-medium hover:bg-slate-900 disabled:opacity-60"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    重算此場域預測
                  </button>
                </div>
              )}

              {health?.live_sim_enabled && (
                <div className="border border-amber-200 bg-amber-50/50 rounded-md p-3.5 space-y-2 text-xs">
                  <h3 className="text-sm font-semibold text-amber-950 flex items-center gap-1.5">
                    <Play className="h-4 w-4 text-amber-700" />
                    推進模擬資料流（Sim Tick）
                  </h3>
                  <div className="flex flex-col sm:flex-row gap-2">
                    <select
                      value={simScenario}
                      onChange={(e) =>
                        setSimScenario(
                          e.target.value as "normal" | "missing" | "stuck" | "disconnect"
                        )
                      }
                      className="w-full sm:flex-1 rounded-md border border-slate-300 px-2.5 py-1.5 text-sm bg-white"
                    >
                      <option value="normal">情境：一般（不注入事件）</option>
                      <option value="missing">情境：缺值</option>
                      <option value="stuck">情境：卡值</option>
                      <option value="disconnect">情境：斷線</option>
                    </select>
                    <button
                      type="button"
                      disabled={adminBusy}
                      onClick={() => void handleSimTick()}
                      className="px-3 py-1.5 rounded-md bg-amber-600 text-white font-medium hover:bg-amber-700 disabled:opacity-60 shrink-0"
                    >
                      推進一步
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </section>
      )}
    </div>
  );
};
