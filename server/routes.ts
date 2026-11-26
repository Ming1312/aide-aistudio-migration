import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import express from "express";
import type { NextFunction, Request, Response, Router } from "express";
import type {
  AnomaliesResponse,
  DecisionSupportResponse,
  ExplainRequest,
  PrecomputedAnomalies,
} from "../contracts/types.ts";
import { can } from "../contracts/permissions.ts";
import { extractSheetId, parseSheetTabs, sheetTabsUrl } from "../contracts/sheetTabs.ts";
import { AdminGate, DEMO_ACCOUNT, DEMO_PASSWORD, DEMO_STAFF_ACCOUNT, DEMO_STAFF_PASSWORD } from "../reference/adminAuth.ts";
import {
  explainDecision,
  ruleBasedExplain,
} from "../reference/decisionExplain.ts";
import type { GenAI } from "../reference/geminiExplain.ts";
import { explain } from "../reference/geminiExplain.ts";
import {
  classifyGeminiError,
  createGeminiAdapter,
  getGeminiModelCandidates,
  ruleBasedGeneralExplain,
  sanitizeDisclaimers,
  sanitizeErrorForLog,
  withModelFallback,
} from "./gemini.ts";
import type { GeminiClientBundle, GeminiErrorCategory } from "./gemini.ts";
import { fetchImportText, parseExtraHosts } from "./importProxy.ts";
import {
  computeDomainStatus,
  InvalidWindowHoursError,
  parseWindowHours,
  type ComputedDomainStatus,
  type OverviewStatusFile,
} from "./overviewStatus.ts";

export const VALID_DATASET_IDS = new Set([
  "sheep_barn",
  "expert_system_c22",
  "sanyegong_creek",
  "construction_site_cb13505",
  "northeast_corner",
  "rearing_plant_1",
  "rearing_plant_1_north",
]);

class RateLimiter {
  private perIp = new Map<string, number[]>();
  private globalHits: number[] = [];
  private readonly windowMs: number;
  private readonly maxPerIp: number;
  private readonly maxGlobal: number;

  constructor(windowMs = 60_000, maxPerIp = 10, maxGlobal = 60) {
    this.windowMs = windowMs;
    this.maxPerIp = maxPerIp;
    this.maxGlobal = maxGlobal;
  }

  check(ip: string, now = Date.now()): { allowed: boolean; reason?: string } {
    const cutoff = now - this.windowMs;
    this.globalHits = this.globalHits.filter((t) => t > cutoff);
    if (this.globalHits.length >= this.maxGlobal) {
      return { allowed: false, reason: "global" };
    }
    const hits = (this.perIp.get(ip) ?? []).filter((t) => t > cutoff);
    if (hits.length >= this.maxPerIp) {
      this.perIp.set(ip, hits);
      return { allowed: false, reason: "ip" };
    }
    hits.push(now);
    this.perIp.set(ip, hits);
    this.globalHits.push(now);
    return { allowed: true };
  }
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function getOrCreateSessionId(req: Request, res: Response): string {
  const cookies = parseCookies(req.headers.cookie);
  const existing = cookies.aide_sid;
  if (existing && /^[a-zA-Z0-9-]{8,64}$/.test(existing)) {
    return existing;
  }
  const sid = randomUUID();
  res.setHeader(
    "Set-Cookie",
    `aide_sid=${encodeURIComponent(sid)}; HttpOnly; SameSite=Lax; Path=/`
  );
  return sid;
}

function loadJsonFile<T>(relPath: string): T {
  const fullPath = path.resolve(process.cwd(), relPath);
  return JSON.parse(readFileSync(fullPath, "utf-8")) as T;
}

async function fetchEngineJson(
  engineBaseUrl: string,
  engineApiKey: string,
  endpointPath: string,
  init?: RequestInit,
  timeoutMs = 10_000
): Promise<{
  ok: boolean;
  status: number;
  data: unknown;
  isJsonContentType: boolean;
  parseError: boolean;
}> {
  const base = engineBaseUrl.replace(/\/+$/, "");
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (engineApiKey) {
    headers["X-API-Key"] = engineApiKey;
  }
  if (init?.body) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(`${base}${endpointPath}`, {
    ...init,
    headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const contentType = res.headers.get("content-type") ?? "";
  const isJsonContentType = /application\/json/i.test(contentType);
  const text = await res.text();
  let parsed: unknown = null;
  let parseError = false;
  if (!isJsonContentType) {
    parsed = { detail: "尚未連線到 Python 引擎，即時預測不可用" };
  } else {
    try {
      parsed = text ? JSON.parse(text) : null;
      if (text && parsed === null && text.trim() !== "null") {
        parseError = true;
      }
    } catch {
      parseError = true;
      parsed = { detail: "引擎回應格式不符" };
    }
  }
  return {
    ok: res.ok,
    status: res.status,
    data: parsed,
    isJsonContentType,
    parseError,
  };
}

export interface ApiRouterOptions {
  adminHash?: string;
  /** 正式管理者帳號名稱（預設環境變數 ADMIN_ACCOUNT，再預設 admin） */
  adminAccount?: string;
  /** 沒有正式管理者時是否開放展示預設帳號（預設：除非 ADMIN_DEMO_DISABLED=1） */
  adminDemoEnabled?: boolean;
  /** 正式員工帳號的雜湊（預設環境變數 STAFF_PASSPHRASE_HASH）與名稱（STAFF_ACCOUNT，預設 staff） */
  staffHash?: string;
  staffAccount?: string;
  engineBaseUrl?: string;
  engineApiKey?: string;
  engineAdminKey?: string;
  geminiBundle?: { ai: GenAI; model: string; models?: string[] } | null;
  rateLimitWindowMs?: number;
  maxPerIp?: number;
  maxGlobal?: number;
  liveReadMaxPerIp?: number;
  liveWriteMaxPerIp?: number;
  engineTimeoutMs?: number;
  perModelTimeoutMs?: number;
  totalTimeoutMs?: number;
  overviewStatusPath?: string;
}

function sanitizeLiveText(text: string, secrets: string[]): string {
  let out = String(text ?? "");
  for (const secret of secrets) {
    if (secret && secret.length > 0) {
      out = out.split(secret).join("[REDACTED]");
    }
  }
  out = out.replace(/https?:\/\/[^\s"'`<>)]+/gi, "[REDACTED_URL]");
  return out;
}

function sanitizeLivePayload(payload: unknown, secrets: string[]): unknown {
  if (typeof payload === "string") {
    return sanitizeLiveText(payload, secrets);
  }
  if (Array.isArray(payload)) {
    return payload.map((item) => sanitizeLivePayload(item, secrets));
  }
  if (payload && typeof payload === "object") {
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(payload)) {
      clean[k] = sanitizeLivePayload(v, secrets);
    }
    return clean;
  }
  return payload;
}

const ENGINE_CREDENTIAL_DETAIL = "引擎憑證設定有誤，請聯絡系統管理者";

function isEngineAuthFailure(status: number): boolean {
  return status === 401 || status === 403;
}

let lastCredentialWarnAt = 0;
function warnEngineCredential(endpointPath: string, status: number): void {
  const now = Date.now();
  if (now - lastCredentialWarnAt < 60_000) return; // 一分鐘最多一行，避免洗版
  lastCredentialWarnAt = now;
  // 只記錄『哪個端點、什麼狀態碼』；不要記錄任何金鑰、位址、引擎回應本文
  console.warn(`[engine] 引擎拒絕憑證：${endpointPath} → HTTP ${status}`);
}

function normalizeEngineErrorBody(
  data: unknown,
  fallbackDetail: string
): Record<string, unknown> {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { detail: fallbackDetail };
  }
  const obj = { ...(data as Record<string, unknown>) };
  if (Array.isArray(obj.detail)) {
    const msgs = obj.detail
      .map((item) => {
        if (typeof item === "string") return item.trim();
        if (item && typeof item === "object") {
          const msg = (item as Record<string, unknown>).msg;
          if (typeof msg === "string" && msg.trim()) return msg.trim();
        }
        return "";
      })
      .filter(Boolean);
    obj.detail = msgs.length > 0 ? msgs.join("；") : fallbackDetail;
  } else if (typeof obj.detail !== "string" || !obj.detail.trim()) {
    if (obj.detail !== undefined && obj.detail !== null) {
      obj.detail = String(obj.detail).trim() || fallbackDetail;
    } else {
      obj.detail = fallbackDetail;
    }
  }
  return obj;
}

export function createApiRouter(options: ApiRouterOptions = {}): Router {
  const router = express.Router();

  const adminGate = new AdminGate(
    options.adminHash !== undefined
      ? options.adminHash
      : process.env.ADMIN_PASSPHRASE_HASH,
    5,
    {
      account: options.adminAccount ?? process.env.ADMIN_ACCOUNT,
      staffHash: options.staffHash !== undefined ? options.staffHash : process.env.STAFF_PASSPHRASE_HASH,
      staffAccount: options.staffAccount ?? process.env.STAFF_ACCOUNT,
      demoEnabled:
        options.adminDemoEnabled !== undefined
          ? options.adminDemoEnabled
          : process.env.ADMIN_DEMO_DISABLED !== "1",
    }
  );

  const engineExpected = loadJsonFile<{ api_version_prefix: string }>(
    "public/data/engine_expected.json"
  );
  const precomputedAnomalies = loadJsonFile<PrecomputedAnomalies>(
    "public/data/real_public/precomputed/anomalies.json"
  );
  const precomputedDecision = loadJsonFile<{
    meta: { generated_at: string };
    datasets: Record<string, DecisionSupportResponse>;
  }>("public/data/real_public/precomputed/decision_support.json");
  const realCatalog = loadJsonFile<Record<string, unknown>>(
    "public/data/real_public/catalog_real.json"
  );

  const limiter = new RateLimiter(
    options.rateLimitWindowMs ?? 60_000,
    options.maxPerIp ?? 10,
    options.maxGlobal ?? 60
  );

  const overviewLimiter = new RateLimiter(
    options.rateLimitWindowMs ?? 60_000,
    options.maxPerIp ?? 10,
    options.maxGlobal ?? 60
  );

  const liveReadLimiter = new RateLimiter(
    options.rateLimitWindowMs ?? 60_000,
    options.liveReadMaxPerIp ?? 60,
    Math.max(options.maxGlobal ?? 600, (options.liveReadMaxPerIp ?? 60) * 10)
  );

  const liveWriteLimiter = new RateLimiter(
    options.rateLimitWindowMs ?? 60_000,
    options.liveWriteMaxPerIp ?? 10,
    options.maxGlobal ?? 60
  );

  let geminiLastError: { category: GeminiErrorCategory; at: string } | null =
    null;
  let credCache: { at: number; result: "ok" | "rejected" } | null = null;

  async function probeEngineCredentials(
    base: string,
    key: string
  ): Promise<"ok" | "rejected" | "unknown"> {
    if (credCache && Date.now() - credCache.at < 15_000) return credCache.result;
    try {
      const r = await fetchEngineJson(base, key, "/v1/datasets", undefined, 5000);
      if (isEngineAuthFailure(r.status)) {
        credCache = { at: Date.now(), result: "rejected" };
        return "rejected";
      }
      if (r.ok) {
        credCache = { at: Date.now(), result: "ok" };
        return "ok";
      }
      return "unknown"; // 404／5xx／非 JSON 等：無法判斷，不改變原本的健康判定，也不快取
    } catch {
      return "unknown";
    }
  }

  const getEngineConfig = () => {
    const base =
      options.engineBaseUrl !== undefined
        ? options.engineBaseUrl
        : process.env.ENGINE_BASE_URL?.trim() || "";
    const key =
      options.engineApiKey !== undefined
        ? options.engineApiKey
        : process.env.ENGINE_API_KEY?.trim() || "";
    const adminKey =
      options.engineAdminKey !== undefined
        ? options.engineAdminKey
        : process.env.ENGINE_ADMIN_KEY?.trim() || "";
    return { base, key, adminKey };
  };

  const resolveGemini = (): GeminiClientBundle | null => {
    if (options.geminiBundle !== undefined) {
      if (options.geminiBundle === null) return null;
      const models =
        options.geminiBundle.models ??
        getGeminiModelCandidates(options.geminiBundle.model);
      const bundle: GeminiClientBundle = {
        ai: null as unknown as GenAI,
        model: options.geminiBundle.model,
        models,
        lastUsedModel: null,
      };
      bundle.ai = withModelFallback(options.geminiBundle.ai, models, {
        perModelTimeoutMs: options.perModelTimeoutMs,
        totalTimeoutMs: options.totalTimeoutMs,
        onSuccessModel: (used) => {
          bundle.lastUsedModel = used;
        },
      });
      return bundle;
    }
    return createGeminiAdapter(
      options.perModelTimeoutMs,
      options.totalTimeoutMs
    );
  };

  const json64kb = express.json({ limit: "64kb" });
  const json6mb = express.json({ limit: "6mb" });
  router.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method === "POST" && /^\/live\/[^/]+\/ingest$/.test(req.path)) {
      json6mb(req, res, next);
    } else {
      json64kb(req, res, next);
    }
  });

  // Body parser / oversized payload error handler -> 413 on ingest, 400 on other routes
  router.use(
    (err: unknown, req: Request, res: Response, next: NextFunction) => {
      if (err && typeof err === "object") {
        const e = err as { type?: string; status?: number; message?: string };
        if (e.type === "entity.too.large" || e.status === 413) {
          if (req.method === "POST" && /^\/live\/[^/]+\/ingest$/.test(req.path)) {
            res.status(413).json({ detail: "上傳資料超過 6 MB 上限，請縮小後再試" });
            return;
          }
          res.status(400).json({ detail: "請求本文過大，請縮短內容後再試" });
          return;
        }
        if (err instanceof SyntaxError || e.type === "entity.parse.failed") {
          res.status(400).json({ detail: "請求 JSON 格式不正確" });
          return;
        }
      }
      next(err);
    }
  );

  // Health check
  router.get("/health", async (_req: Request, res: Response) => {
    const { base, key } = getEngineConfig();
    const geminiConfigured = Boolean(
      options.geminiBundle ?? process.env.GEMINI_API_KEY?.trim()
    );
    if (!base) {
      res.json({
        ok: true,
        engine_connected: false,
        engine_version: null,
        read_only: true,
        version_warning: false,
        warning_message: null,
        gemini_configured: geminiConfigured,
        gemini_last_error: geminiLastError,
        admin_configured: adminGate.configured(),
        precomputed_available: true,
        live_engine_connected: false,
        live_writes_enabled: false,
        live_sim_enabled: false,
      });
      return;
    }
    try {
      const result = await fetchEngineJson(base, key, "/health", undefined, 5000);
      if (!result.ok || !result.data || typeof result.data !== "object") {
        res.json({
          ok: true,
          engine_connected: false,
          engine_version: null,
          read_only: true,
          version_warning: false,
          warning_message: "Python 引擎健康檢查失敗，已切換為離線預計算模式",
          gemini_configured: geminiConfigured,
          gemini_last_error: geminiLastError,
          admin_configured: adminGate.configured(),
          precomputed_available: true,
          live_engine_connected: false,
          live_writes_enabled: false,
          live_sim_enabled: false,
        });
        return;
      }
      const d = result.data as {
        ok?: boolean;
        version?: string;
        read_only?: boolean;
        live_engine_connected?: boolean;
        live_writes_enabled?: boolean;
        live_sim_enabled?: boolean;
      };
      const version = String(d.version ?? "");
      const readOnly = d.read_only === true;
      const versionOk = version.startsWith(engineExpected.api_version_prefix);
      const liveEngineConnected = Boolean(
        d.live_engine_connected ?? (readOnly && d.ok)
      );
      const liveWritesEnabled = Boolean(d.live_writes_enabled);
      const liveSimEnabled = Boolean(d.live_sim_enabled);

      if (!readOnly) {
        res.json({
          ok: true,
          engine_connected: false,
          engine_version: version || null,
          read_only: false,
          version_warning: true,
          warning_message:
            "遠端引擎未標示 read_only=true，依安全政策視為離線並改用預計算資料",
          gemini_configured: geminiConfigured,
          gemini_last_error: geminiLastError,
          admin_configured: adminGate.configured(),
          precomputed_available: true,
          live_engine_connected: liveEngineConnected,
          live_writes_enabled: liveWritesEnabled,
          live_sim_enabled: liveSimEnabled,
        });
        return;
      }
      const credStatus = await probeEngineCredentials(base, key);
      if (credStatus === "rejected") {
        res.json({
          ok: true,
          engine_connected: false,
          engine_version: version || null,
          read_only: true,
          version_warning: false,
          warning_message:
            "Python 引擎拒絕目前的存取憑證，已切換為離線預計算模式；請管理者檢查伺服器設定",
          gemini_configured: geminiConfigured,
          gemini_last_error: geminiLastError,
          admin_configured: adminGate.configured(),
          precomputed_available: true,
          live_engine_connected: false,
          live_writes_enabled: false,
          live_sim_enabled: false,
        });
        return;
      }
      res.json({
        ok: true,
        engine_connected: Boolean(d.ok),
        engine_version: version || null,
        read_only: true,
        version_warning: !versionOk,
        warning_message: versionOk
          ? null
          : `引擎版本 (${version}) 與預期前綴 (${engineExpected.api_version_prefix}) 不符`,
        gemini_configured: geminiConfigured,
        gemini_last_error: geminiLastError,
        admin_configured: adminGate.configured(),
        precomputed_available: true,
        live_engine_connected: liveEngineConnected,
        live_writes_enabled: liveWritesEnabled,
        live_sim_enabled: liveSimEnabled,
      });
    } catch {
      res.json({
        ok: true,
        engine_connected: false,
        engine_version: null,
        read_only: true,
        version_warning: false,
        warning_message: "無法連線到 Python 引擎，已切換為離線預計算模式",
        gemini_configured: geminiConfigured,
        gemini_last_error: geminiLastError,
        admin_configured: adminGate.configured(),
        precomputed_available: true,
        live_engine_connected: false,
        live_writes_enabled: false,
        live_sim_enabled: false,
      });
    }
  });

  // Admin auth
  router.get("/admin/role", (req: Request, res: Response) => {
    const sid = getOrCreateSessionId(req, res);
    const demo = adminGate.demoAvailable();
    res.json({
      configured: adminGate.configured(),
      role: adminGate.role(sid),
      demo_available: demo,
      // 展示預設帳號是公開值；正式管理者一旦設定就不再提供，也不回傳任何雜湊或金鑰
      staff_configured: adminGate.staffConfigured(),
      ...(demo
        ? {
            demo_hint: { account: DEMO_ACCOUNT, password: DEMO_PASSWORD },
            demo_staff_hint: { account: DEMO_STAFF_ACCOUNT, password: DEMO_STAFF_PASSWORD },
          }
        : {}),
    });
  });

  router.post("/admin/login", (req: Request, res: Response) => {
    const sid = getOrCreateSessionId(req, res);
    const body = req.body as { passphrase?: unknown; account?: unknown } | undefined;
    const passphrase =
      typeof body?.passphrase === "string" ? body.passphrase : "";
    const account = typeof body?.account === "string" ? body.account : undefined;
    const result = adminGate.login(sid, passphrase, account);
    const status = result.ok
      ? 200
      : !adminGate.configured() && !adminGate.staffConfigured() && !adminGate.demoAvailable()
      ? 403
      : result.locked
      ? 429
      : 401;
    res.status(status).json(result);
  });

  // 管理狀態（展示管理者與正式管理者可看）：只回傳「是否設定」的布林值，不回傳任何值
  router.get("/admin/status", (req: Request, res: Response) => {
    const sid = getOrCreateSessionId(req, res);
    const role = adminGate.role(sid);
    if (!can(role, "view_admin_status")) {
      res.status(403).json({ detail: "需要管理員身分" });
      return;
    }
    const { base, key, adminKey } = getEngineConfig();
    res.json({
      role,
      engine_url_configured: !!base,
      engine_api_key_configured: !!key,
      engine_admin_key_configured: !!adminKey,
      gemini_configured: !!options.geminiBundle || !!process.env.GEMINI_API_KEY,
      real_admin_configured: adminGate.configured(),
      staff_configured: adminGate.staffConfigured(),
      demo_account_active: adminGate.demoAvailable(),
      real_account_name: adminGate.configured() ? adminGate.realAccountName() : null,
      can_write_engine: role === "admin",
    });
  });

  router.post("/admin/logout", (req: Request, res: Response) => {
    const sid = getOrCreateSessionId(req, res);
    adminGate.logout(sid);
    res.json({ ok: true, role: "viewer" });
  });

  // Datasets catalog
  router.get("/datasets", async (_req: Request, res: Response) => {
    const { base, key } = getEngineConfig();
    if (base) {
      try {
        const result = await fetchEngineJson(base, key, "/v1/datasets", undefined, 8000);
        if (result.ok) {
          res.json(result.data);
          return;
        }
      } catch {
        // Fallback to static catalog
      }
    }
    res.json(realCatalog);
  });

  // Overview status across 7 real domains
  router.get("/overview/status", (req: Request, res: Response) => {
    const clientIp = req.ip || req.socket.remoteAddress || "unknown";
    const rate = overviewLimiter.check(clientIp);
    if (!rate.allowed) {
      res.status(429).json({ detail: "請求過於頻繁，請稍後再試" });
      return;
    }

    let windowHours: 24 | 72 | 168;
    try {
      windowHours = parseWindowHours(req.query.window_hours);
    } catch (err) {
      if (err instanceof InvalidWindowHoursError) {
        res.status(400).json({ detail: err.message });
        return;
      }
      res.status(400).json({ detail: "window_hours 參數格式不正確" });
      return;
    }

    const statusFilePath = options.overviewStatusPath
      ? path.resolve(options.overviewStatusPath)
      : path.resolve(
          process.cwd(),
          "public/data/real_public/precomputed/overview_status.json"
        );

    let parsed: OverviewStatusFile;
    try {
      parsed = JSON.parse(
        readFileSync(statusFilePath, "utf-8")
      ) as OverviewStatusFile;
      if (!parsed || !parsed.meta || !parsed.datasets) {
        throw new Error("Invalid overview_status.json structure");
      }
    } catch {
      res.status(503).json({
        detail: "找不到或無法讀取總覽狀態預計算檔案（overview_status.json）",
      });
      return;
    }

    const datasetsOut: Record<string, ComputedDomainStatus> = {};
    let hasIssueCount = 0;
    let noneRecentCount = 0;

    for (const id of VALID_DATASET_IDS) {
      const entry = parsed.datasets[id];
      if (!entry) continue;
      const computed = computeDomainStatus(entry, windowHours, id);
      datasetsOut[id] = computed;
      if (computed.status === "has_issue") {
        hasIssueCount += 1;
      } else {
        noneRecentCount += 1;
      }
    }

    res.json({
      window_hours: windowHours,
      meta: {
        generated_at: parsed.meta.generated_at,
        definition: parsed.meta.definition,
        no_claim: parsed.meta.no_claim,
      },
      datasets: datasetsOut,
      summary: {
        has_issue: hasIssueCount,
        none_recent: noneRecentCount,
      },
    });
  });

  // Anomalies
  router.get("/datasets/:id/anomalies", async (req: Request, res: Response) => {
    const datasetId = String(req.params.id ?? "");
    if (!VALID_DATASET_IDS.has(datasetId)) {
      res.status(404).json({ detail: "找不到指定的場域資料集" });
      return;
    }
    const { base, key } = getEngineConfig();
    if (base) {
      try {
        const result = await fetchEngineJson(
          base,
          key,
          `/v1/datasets/${encodeURIComponent(datasetId)}/anomalies`,
          undefined,
          10_000
        );
        if (result.ok && result.data && typeof result.data === "object") {
          res.json({
            ...(result.data as AnomaliesResponse),
            source: "engine",
          });
          return;
        }
      } catch {
        // Fallback to precomputed
      }
    }
    const offline = precomputedAnomalies.datasets[datasetId];
    if (!offline) {
      res.status(404).json({ detail: "找不到該場域的異常偵測資料" });
      return;
    }
    res.json({
      ...offline,
      source: "precomputed_offline",
      generated_at: precomputedAnomalies.meta.generated_at,
    });
  });

  // Forecast proxy (offline -> 503 per M1 spec)
  router.post("/forecast", async (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown> | undefined;
    const datasetId = String(body?.dataset_id ?? "");
    if (!VALID_DATASET_IDS.has(datasetId)) {
      res.status(404).json({ detail: "找不到指定的場域資料集" });
      return;
    }
    if (datasetId === "rearing_plant_1_north") {
      res.status(422).json({
        detail: "育成一廠北側資料太少（約 387 列、連續區段短），系統不建立模型",
      });
      return;
    }
    const { base, key } = getEngineConfig();
    if (!base) {
      res.status(503).json({ detail: "尚未連線到 Python 引擎" });
      return;
    }
    try {
      const result = await fetchEngineJson(
        base,
        key,
        "/v1/forecast",
        {
          method: "POST",
          body: JSON.stringify(body),
        },
        15_000
      );
      if (isEngineAuthFailure(result.status)) {
        warnEngineCredential("/v1/forecast", result.status);
        res.status(502).json({ detail: ENGINE_CREDENTIAL_DETAIL });
        return;
      }
      if (!result.ok) {
        res
          .status(result.status)
          .json(normalizeEngineErrorBody(result.data, "引擎預測失敗"));
        return;
      }
      res.json({
        ...(result.data as Record<string, unknown>),
        source: "engine",
      });
    } catch {
      res.status(503).json({ detail: "Python 引擎連線逾時或無法使用" });
    }
  });

  // Formal sheep THI proxy
  router.post("/formal/sheep-thi", async (req: Request, res: Response) => {
    const { base, key } = getEngineConfig();
    if (!base) {
      res.status(503).json({ detail: "尚未連線到 Python 引擎" });
      return;
    }
    try {
      const result = await fetchEngineJson(
        base,
        key,
        "/v1/formal/sheep-thi",
        {
          method: "POST",
          body: JSON.stringify(req.body ?? {}),
        },
        15_000
      );
      if (isEngineAuthFailure(result.status)) {
        warnEngineCredential("/v1/formal/sheep-thi", result.status);
        res.status(502).json({ detail: ENGINE_CREDENTIAL_DETAIL });
        return;
      }
      if (!result.ok) {
        res
          .status(result.status)
          .json(normalizeEngineErrorBody(result.data, "羊舍正式 THI 計算失敗"));
        return;
      }
      res.json({
        ...(result.data as Record<string, unknown>),
        source: "engine",
      });
    } catch {
      res.status(503).json({ detail: "Python 引擎連線逾時或無法使用" });
    }
  });

  // General Gemini explanation
  // 資料匯入中心：由伺服器代為取得公開試算表／CSV 文字（白名單網域；瀏覽器直接取檔被 CORS 擋下時的備援）
  router.get("/import/fetch", async (req: Request, res: Response) => {
    const importRole = adminGate.role(getOrCreateSessionId(req, res));
    if (!can(importRole, "import_data")) {
      res.status(403).json({ detail: "資料匯入需要員工或管理員身分，請先登入" });
      return;
    }
    const clientIp = req.ip || req.socket.remoteAddress || "unknown";
    if (!liveReadLimiter.check(clientIp).allowed) {
      res.status(429).json({ detail: "請求過於頻繁，請稍後再試" });
      return;
    }
    const url = typeof req.query.url === "string" ? req.query.url : "";
    if (!url || url.length > 2000) {
      res.status(400).json({ detail: "缺少網址" });
      return;
    }
    const result = await fetchImportText(url, parseExtraHosts(process.env.IMPORT_ALLOWED_HOSTS));
    if (!result.ok) {
      res.status(result.status).json({ detail: result.reason });
      return;
    }
    res.json({ text: result.text });
  });

  // 整份試算表：列出所有工作表（名稱＋gid）。員工以上；只讀 docs.google.com 的 htmlview 頁面
  router.get("/import/sheet-tabs", async (req: Request, res: Response) => {
    const role = adminGate.role(getOrCreateSessionId(req, res));
    if (!can(role, "import_data")) {
      res.status(403).json({ detail: "資料匯入需要員工或管理員身分，請先登入" });
      return;
    }
    const clientIp = req.ip || req.socket.remoteAddress || "unknown";
    if (!liveReadLimiter.check(clientIp).allowed) {
      res.status(429).json({ detail: "請求過於頻繁，請稍後再試" });
      return;
    }
    const id = extractSheetId(typeof req.query.url === "string" ? req.query.url : "");
    if (!id) {
      res.status(400).json({ detail: "請貼上 Google 試算表網址" });
      return;
    }
    const result = await fetchImportText(sheetTabsUrl(id), []);
    if (!result.ok) {
      res.status(result.status).json({ detail: result.reason });
      return;
    }
    const tabs = parseSheetTabs(result.text);
    if (tabs.length === 0) {
      res.status(422).json({ detail: "讀不到工作表清單（試算表需設為「知道連結的任何人可檢視」）" });
      return;
    }
    res.json({ id, tabs });
  });

  router.post("/ai/explain", async (req: Request, res: Response) => {
    const clientIp = req.ip || req.socket.remoteAddress || "unknown";
    const rate = limiter.check(clientIp);
    if (!rate.allowed) {
      res.status(429).json({ detail: "請求過於頻繁，請稍後再試" });
      return;
    }

    const body = req.body as Partial<ExplainRequest> | undefined;
    if (
      !body ||
      !body.dataset_id ||
      !VALID_DATASET_IDS.has(body.dataset_id) ||
      !body.kind ||
      !body.data_kind ||
      !Array.isArray(body.facts) ||
      body.facts.length === 0
    ) {
      res.status(400).json({ detail: "缺少必要的事實清單或場域參數" });
      return;
    }
    if (body.facts.length > 80) {
      res.status(400).json({ detail: "事實清單項目過多" });
      return;
    }
    if (typeof body.question === "string" && body.question.trim().length > 300) {
      res.status(400).json({ detail: "問題文字不可超過 300 字" });
      return;
    }

    const explainReq: ExplainRequest = {
      kind: body.kind,
      data_kind: body.data_kind,
      dataset_id: body.dataset_id,
      facts: body.facts,
      question: typeof body.question === "string" ? body.question : undefined,
    };

    const gemini = resolveGemini();
    if (!gemini) {
      res.json({
        ...ruleBasedGeneralExplain(explainReq, "尚未設定 GEMINI_API_KEY"),
        fallback_category: "auth" as GeminiErrorCategory,
      });
      return;
    }

    try {
      const result = await explain(explainReq, gemini.ai, gemini.model);
      res.json({
        ...result,
        disclaimers: sanitizeDisclaimers(result.disclaimers),
        model_used: gemini.lastUsedModel ?? gemini.model,
      });
    } catch (err) {
      const category = classifyGeminiError(err);
      console.error("[gemini-error]", sanitizeErrorForLog(err, category));
      geminiLastError = { category, at: new Date().toISOString() };
      res.json({
        ...ruleBasedGeneralExplain(explainReq, "Gemini 呼叫失敗或逾時"),
        fallback_category: category,
      });
    }
  });

  // Helper to obtain DecisionSupportResponse for a dataset
  async function loadDecisionSupport(
    datasetId: string
  ): Promise<{ payload: DecisionSupportResponse; source: "engine" | "precomputed" } | null> {
    if (!VALID_DATASET_IDS.has(datasetId)) return null;
    const { base, key } = getEngineConfig();
    if (base) {
      try {
        const result = await fetchEngineJson(
          base,
          key,
          `/v1/decision-support/${encodeURIComponent(datasetId)}`,
          undefined,
          10_000
        );
        if (result.ok && result.data && typeof result.data === "object") {
          return {
            payload: result.data as DecisionSupportResponse,
            source: "engine",
          };
        }
      } catch {
        // Fall through to precomputed
      }
    }
    const offline = precomputedDecision.datasets[datasetId];
    if (!offline) return null;
    return {
      payload: {
        ...offline,
        generated_at: offline.generated_at ?? precomputedDecision.meta.generated_at,
      },
      source: "precomputed",
    };
  }

  // M2: GET /api/decision/:datasetId
  router.get("/decision/:datasetId", async (req: Request, res: Response) => {
    const datasetId = String(req.params.datasetId ?? "");
    if (!VALID_DATASET_IDS.has(datasetId)) {
      res.status(404).json({ detail: "找不到指定的場域資料集" });
      return;
    }
    const resolved = await loadDecisionSupport(datasetId);
    if (!resolved) {
      res.status(404).json({ detail: "找不到該場域的決策輔助資料" });
      return;
    }
    res.json({
      ...resolved.payload,
      source: resolved.source,
    });
  });

  // M2: POST /api/decision/explain (server loads DecisionSupportResponse itself; never trusts client recommendations)
  router.post("/decision/explain", async (req: Request, res: Response) => {
    const clientIp = req.ip || req.socket.remoteAddress || "unknown";
    const rate = limiter.check(clientIp);
    if (!rate.allowed) {
      res.status(429).json({ detail: "請求過於頻繁，請稍後再試" });
      return;
    }

    const body = req.body as { dataset_id?: unknown; question?: unknown } | undefined;
    if (!body || typeof body.dataset_id !== "string") {
      res.status(400).json({ detail: "請提供有效的 dataset_id" });
      return;
    }
    const datasetId = body.dataset_id.trim();
    if (!VALID_DATASET_IDS.has(datasetId)) {
      res.status(404).json({ detail: "找不到指定的場域資料集" });
      return;
    }
    if (body.question !== undefined && typeof body.question !== "string") {
      res.status(400).json({ detail: "question 必須為文字" });
      return;
    }
    const question =
      typeof body.question === "string" ? body.question.trim() : undefined;
    if (question && question.length > 300) {
      res.status(400).json({ detail: "問題文字不可超過 300 字" });
      return;
    }

    const resolved = await loadDecisionSupport(datasetId);
    if (!resolved) {
      res.status(404).json({ detail: "找不到該場域的決策輔助資料" });
      return;
    }

    const gemini = resolveGemini();
    if (!gemini) {
      res.json({
        ...ruleBasedExplain(resolved.payload, "未設定 GEMINI_API_KEY"),
        fallback_category: "auth" as GeminiErrorCategory,
      });
      return;
    }

    let capturedError: unknown = null;
    const trackedAi: GenAI = {
      models: {
        async generateContent(args) {
          try {
            return await gemini.ai.models.generateContent(args);
          } catch (err) {
            capturedError = err;
            throw err;
          }
        },
      },
    };

    const result = await explainDecision(
      resolved.payload,
      trackedAi,
      gemini.model,
      question
    );

    if (capturedError !== null) {
      const category = classifyGeminiError(capturedError);
      console.error("[gemini-error]", sanitizeErrorForLog(capturedError, category));
      geminiLastError = { category, at: new Date().toISOString() };
      res.json({
        ...result,
        fallback_category: category,
      });
      return;
    }

    res.json({
      ...result,
      model_used: gemini.lastUsedModel ?? gemini.model,
    });
  });

  // ---- 即時預測資料流代理（/api/live/* ⇄ /v1/live/*）----
  async function proxyLiveGet(
    req: Request,
    res: Response,
    enginePath: string,
    datasetId?: string
  ) {
    const clientIp = req.ip || req.socket.remoteAddress || "unknown";
    const rate = liveReadLimiter.check(clientIp);
    if (!rate.allowed) {
      res.status(429).json({ detail: "請求過於頻繁，請稍後再試" });
      return;
    }

    if (datasetId !== undefined && !VALID_DATASET_IDS.has(datasetId)) {
      res.status(404).json({ detail: "找不到指定的場域資料集" });
      return;
    }

    const { base, key, adminKey } = getEngineConfig();
    if (!base) {
      res.status(503).json({ detail: "尚未連線到 Python 引擎，即時預測不可用" });
      return;
    }

    const secrets = [base, key, adminKey];
    try {
      const result = await fetchEngineJson(
        base,
        key,
        enginePath,
        undefined,
        options.engineTimeoutMs ?? 10_000
      );
      if (!result.isJsonContentType || result.status >= 500) {
        res.status(503).json({ detail: "尚未連線到 Python 引擎，即時預測不可用" });
        return;
      }
      if (result.parseError) {
        res.status(502).json({ detail: "引擎回應格式不符" });
        return;
      }
      if (isEngineAuthFailure(result.status)) {
        warnEngineCredential(enginePath, result.status);
        res.status(502).json({ detail: ENGINE_CREDENTIAL_DETAIL });
        return;
      }
      if (!result.ok) {
        const sanitized = sanitizeLivePayload(result.data, secrets);
        const fallback = result.status === 404 ? "尚無即時預測資料" : "引擎請求失敗";
        res.status(result.status).json(normalizeEngineErrorBody(sanitized, fallback));
        return;
      }
      res.status(200).json(sanitizeLivePayload(result.data, secrets));
    } catch {
      res.status(503).json({ detail: "尚未連線到 Python 引擎，即時預測不可用" });
    }
  }

  async function proxyLivePost(
    req: Request,
    res: Response,
    actionSegment: "ingest" | "commit" | "rollback" | "recompute" | "sim/tick"
  ) {
    const clientIp = req.ip || req.socket.remoteAddress || "unknown";
    const rate = liveWriteLimiter.check(clientIp);
    if (!rate.allowed) {
      res.status(429).json({ detail: "寫入請求過於頻繁，請稍後再試" });
      return;
    }

    const sid = getOrCreateSessionId(req, res);
    const writeRole = adminGate.role(sid);
    if (writeRole === "demo_admin") {
      res.status(403).json({
        detail:
          "展示管理者不能寫入引擎：寫入需要設定正式管理者（ADMIN_PASSPHRASE_HASH）並由其登入",
      });
      return;
    }
    if (writeRole !== "admin") {
      res.status(403).json({ detail: "僅限管理者操作，請先完成管理者驗證" });
      return;
    }

    const datasetId = String(req.params.id ?? "");
    if (!VALID_DATASET_IDS.has(datasetId)) {
      res.status(404).json({ detail: "找不到指定的場域資料集" });
      return;
    }

    const { base, key, adminKey } = getEngineConfig();
    if (!base) {
      res.status(503).json({ detail: "尚未連線到 Python 引擎，即時預測不可用" });
      return;
    }

    const rawBody =
      req.body && typeof req.body === "object" && !Array.isArray(req.body)
        ? { ...(req.body as Record<string, unknown>) }
        : {};
    delete rawBody.approved_by;
    const outboundBody: Record<string, unknown> = {
      ...rawBody,
      approved_by: `admin:${sid.slice(0, 8)}`,
    };

    const secrets = [base, key, adminKey];
    const headers: Record<string, string> = {};
    if (adminKey) {
      headers["X-Admin-Key"] = adminKey;
    }

    const enginePath = `/v1/live/${encodeURIComponent(datasetId)}/${actionSegment}`;
    try {
      const result = await fetchEngineJson(
        base,
        key,
        enginePath,
        {
          method: "POST",
          headers,
          body: JSON.stringify(outboundBody),
        },
        options.engineTimeoutMs ?? 10_000
      );
      if (!result.isJsonContentType || result.status >= 500) {
        res.status(503).json({ detail: "尚未連線到 Python 引擎，即時預測不可用" });
        return;
      }
      if (result.parseError) {
        res.status(502).json({ detail: "引擎回應格式不符" });
        return;
      }
      // F12：引擎沒有設定管理金鑰＝這個部署唯讀。不是憑證問題，直接說清楚。
      if (
        result.status === 403 &&
        result.data &&
        typeof result.data === "object" &&
        typeof (result.data as { detail?: unknown }).detail === "string" &&
        (result.data as { detail: string }).detail.includes("寫入功能停用")
      ) {
        res.status(403).json({
          detail:
            "此部署為唯讀展示：引擎已停用寫入（匯入／提交／回復／重算／模擬推進）",
        });
        return;
      }
      if (isEngineAuthFailure(result.status)) {
        warnEngineCredential(enginePath, result.status);
        res.status(502).json({ detail: ENGINE_CREDENTIAL_DETAIL });
        return;
      }
      if (!result.ok) {
        const sanitized = sanitizeLivePayload(result.data, secrets);
        res
          .status(result.status)
          .json(normalizeEngineErrorBody(sanitized, "引擎拒絕此寫入操作"));
        return;
      }
      res.status(result.status).json(sanitizeLivePayload(result.data, secrets));
    } catch {
      res.status(503).json({ detail: "尚未連線到 Python 引擎，即時預測不可用" });
    }
  }

  router.get("/live/domains", (req: Request, res: Response) => {
    void proxyLiveGet(req, res, "/v1/live/domains");
  });

  for (const segment of [
    "status",
    "forecast",
    "monitor",
    "versions",
    "pending",
    "events",
  ] as const) {
    router.get(`/live/:id/${segment}`, (req: Request, res: Response) => {
      const datasetId = String(req.params.id ?? "");
      void proxyLiveGet(
        req,
        res,
        `/v1/live/${encodeURIComponent(datasetId)}/${segment}`,
        datasetId
      );
    });
  }

  for (const action of [
    "ingest",
    "commit",
    "rollback",
    "recompute",
    "sim/tick",
  ] as const) {
    router.post(`/live/:id/${action}`, (req: Request, res: Response) => {
      void proxyLivePost(req, res, action);
    });
  }

  return router;
}
