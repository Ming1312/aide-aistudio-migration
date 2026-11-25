import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import type {
  ExplainRequest,
  ExplainResponse,
  Fact,
} from "../contracts/types.ts";
import type { GenAI } from "../reference/geminiExplain.ts";
import { mandatoryDisclaimers } from "../reference/geminiExplain.ts";

export type GeminiErrorCategory =
  | "auth"
  | "model_not_found"
  | "quota"
  | "bad_request"
  | "timeout"
  | "network"
  | "other";

export interface SanitizedErrorLog {
  category: GeminiErrorCategory;
  status: number | null;
  name: string;
  message: string;
}

export interface GeminiClientBundle {
  ai: GenAI;
  model: string;
  models: string[];
  lastUsedModel: string | null;
}

export const DEFAULT_FLASH_MODELS = [
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-4-hydrogen",
] as const;

export const PER_MODEL_TIMEOUT_MS = 8_000;
export const TOTAL_REQUEST_TIMEOUT_MS = 25_000;

const VALID_MODEL_NAME_RE = /^(?:models\/)?[a-zA-Z0-9][a-zA-Z0-9._-]{1,127}$/;

export function isValidGeminiModelName(name: string | undefined): name is string {
  if (!name) return false;
  const trimmed = name.trim();
  if (!trimmed || trimmed.startsWith("#")) return false;
  return VALID_MODEL_NAME_RE.test(trimmed);
}

export function getGeminiModelCandidates(
  envModel = process.env.GEMINI_MODEL
): string[] {
  const candidates: string[] = [];
  const trimmed = envModel?.trim();
  if (isValidGeminiModelName(trimmed)) {
    candidates.push(trimmed);
  }
  for (const fallback of DEFAULT_FLASH_MODELS) {
    if (!candidates.includes(fallback)) {
      candidates.push(fallback);
    }
  }
  return candidates;
}

function extractErrorDetails(err: unknown): {
  status: number | null;
  name: string;
  code: string;
  message: string;
} {
  if (!err || typeof err !== "object") {
    return {
      status: null,
      name: "Error",
      code: "",
      message: String(err ?? ""),
    };
  }
  const e = err as {
    status?: unknown;
    statusCode?: unknown;
    name?: unknown;
    code?: unknown;
    message?: unknown;
    response?: { status?: unknown };
    cause?: { code?: unknown; status?: unknown; message?: unknown };
  };

  let status: number | null = null;
  for (const rawStatus of [
    e.status,
    e.statusCode,
    e.response?.status,
    e.cause?.status,
  ]) {
    if (
      typeof rawStatus === "number" &&
      Number.isInteger(rawStatus) &&
      rawStatus >= 100 &&
      rawStatus <= 599
    ) {
      status = rawStatus;
      break;
    }
  }

  const name = typeof e.name === "string" && e.name ? e.name : "Error";
  const code =
    typeof e.code === "string"
      ? e.code
      : typeof e.cause?.code === "string"
        ? e.cause.code
        : "";
  const msgPart = typeof e.message === "string" ? e.message : String(err);
  const causeMsg =
    typeof e.cause?.message === "string" && !msgPart.includes(e.cause.message)
      ? ` (${e.cause.message})`
      : "";
  const message = `${msgPart}${causeMsg}`;

  if (status === null) {
    const jsonCodeMatch = message.match(/"code"\s*:\s*(\d{3})\b/);
    if (jsonCodeMatch) {
      const parsed = Number(jsonCodeMatch[1]);
      if (parsed >= 400 && parsed <= 599) status = parsed;
    }
  }

  return { status, name, code, message };
}

export function classifyGeminiError(err: unknown): GeminiErrorCategory {
  const { status, name, code, message } = extractErrorDetails(err);
  const upperCode = code.toUpperCase();

  // 1. Timeout (our 20s / 10s timeout or Abort/TimeoutError)
  if (
    name === "AbortError" ||
    name === "TimeoutError" ||
    upperCode === "ETIMEDOUT" ||
    upperCode === "UND_ERR_CONNECT_TIMEOUT" ||
    upperCode === "UND_ERR_HEADERS_TIMEOUT" ||
    /timeout|timed out|逾時/i.test(message)
  ) {
    return "timeout";
  }

  // 2. Auth (401/403 or invalid API key / permission denied even when Google returns 400 API_KEY_INVALID)
  if (
    status === 401 ||
    status === 403 ||
    /API_KEY_INVALID|API key not valid|API key expired|PERMISSION_DENIED|UNAUTHENTICATED|invalid api key|unauthorized|forbidden|permission denied|未設定 GEMINI_API_KEY/i.test(
      message
    )
  ) {
    return "auth";
  }

  // 3. Model not found / unsupported (404)
  if (
    status === 404 ||
    /NOT_FOUND|models\/[^\s"'`]+ is not found|model [^\s"'`]+ is not found|is not supported for generateContent|model_not_found/i.test(
      message
    )
  ) {
    return "model_not_found";
  }

  // 4. Quota / rate limit (429)
  if (
    status === 429 ||
    /RESOURCE_EXHAUSTED|quota exceeded|rate.?limit|too many requests/i.test(
      message
    )
  ) {
    return "quota";
  }

  // 5. Bad request / schema / invalid parameter (400)
  if (
    status === 400 ||
    /INVALID_ARGUMENT|FAILED_PRECONDITION|bad request|invalid argument|responseSchema|response_schema|thinkingBudget|thinking_budget|unknown name/i.test(
      message
    )
  ) {
    return "bad_request";
  }

  // 6. Network errors
  const networkCodes = new Set([
    "ECONNREFUSED",
    "ECONNRESET",
    "ENOTFOUND",
    "EAI_AGAIN",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "EPIPE",
    "UND_ERR_SOCKET",
  ]);
  if (
    networkCodes.has(upperCode) ||
    /fetch failed|network error|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|getaddrinfo/i.test(
      message
    )
  ) {
    return "network";
  }

  return "other";
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function sanitizeErrorMessage(raw: string): string {
  let msg = raw;

  const secretValues = [
    process.env.GEMINI_API_KEY,
    process.env.ENGINE_API_KEY,
    process.env.ENGINE_BASE_URL,
    process.env.ADMIN_PASSPHRASE_HASH,
  ]
    .map((v) => v?.trim())
    .filter((v): v is string => Boolean(v && v.length >= 4));

  for (const secret of secretValues) {
    msg = msg.replace(new RegExp(escapeRegExp(secret), "g"), "[REDACTED]");
    try {
      const encoded = encodeURIComponent(secret);
      if (encoded !== secret) {
        msg = msg.replace(new RegExp(escapeRegExp(encoded), "g"), "[REDACTED]");
      }
    } catch {
      // ignore encodeURIComponent errors
    }
  }

  msg = msg
    .replace(/AIza[0-9A-Za-z_-]{8,}/g, "[REDACTED_KEY]")
    .replace(/([?&]key=)[^&\s"'<>]+/gi, "$1[REDACTED]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]")
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[REDACTED_URL]")
    .replace(/\s+/g, " ")
    .trim();

  if (msg.length > 200) {
    msg = `${msg.slice(0, 197)}...`;
  }
  return msg;
}

export function sanitizeErrorForLog(
  err: unknown,
  categoryOverride?: GeminiErrorCategory
): SanitizedErrorLog {
  const { status, name, message } = extractErrorDetails(err);
  const category = categoryOverride ?? classifyGeminiError(err);
  return {
    category,
    status,
    name,
    message: sanitizeErrorMessage(message),
  };
}

export function normalizeConfigForModel(
  modelName: string,
  config: Record<string, unknown>
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...config };
  const bare = modelName.replace(/^models\//, "");
  if (bare.startsWith("gemini-4-")) {
    delete next.temperature;
    delete next.topP;
    delete next.topK;
    delete next.candidateCount;
    if (!next.thinkingConfig) {
      next.thinkingConfig = { thinkingLevel: ThinkingLevel.LOW };
    }
  }
  return next;
}

export function shouldRetryNextModel(err: unknown): boolean {
  const category = classifyGeminiError(err);
  if (
    category === "auth" ||
    category === "quota" ||
    category === "bad_request"
  ) {
    return false;
  }
  if (category === "model_not_found" || category === "timeout") {
    return true;
  }
  const { status, message } = extractErrorDetails(err);
  if (status === 500 || status === 503) {
    return true;
  }
  if (/\b(?:500|503)\b|UNAVAILABLE/i.test(message)) {
    return true;
  }
  return false;
}

export interface ModelFallbackOptions {
  perModelTimeoutMs?: number;
  totalTimeoutMs?: number;
  onSuccessModel?: (model: string) => void;
}

export function withModelFallback(
  rawAi: GenAI,
  models: string[],
  optionsOrCallback?: ModelFallbackOptions | ((model: string) => void)
): GenAI {
  const opts: ModelFallbackOptions =
    typeof optionsOrCallback === "function"
      ? { onSuccessModel: optionsOrCallback }
      : (optionsOrCallback ?? {});
  const perModelTimeoutMs = opts.perModelTimeoutMs ?? PER_MODEL_TIMEOUT_MS;
  const totalTimeoutMs = opts.totalTimeoutMs ?? TOTAL_REQUEST_TIMEOUT_MS;

  return {
    models: {
      async generateContent(args) {
        const attemptList = Array.from(
          new Set([args.model, ...models].filter(Boolean))
        );

        const deadline = Date.now() + totalTimeoutMs;
        let lastErr: unknown = new Error("No Gemini model configured");

        for (let i = 0; i < attemptList.length; i += 1) {
          const remainingMs = deadline - Date.now();
          if (remainingMs <= 0) {
            throw lastErr;
          }

          const candidate = attemptList[i];
          const attemptTimeoutMs = Math.min(perModelTimeoutMs, remainingMs);
          const normalizedConfig = normalizeConfigForModel(
            candidate,
            args.config
          );
          const controller = new AbortController();
          let timer: ReturnType<typeof setTimeout> | undefined;

          try {
            const res = await Promise.race([
              rawAi.models.generateContent({
                model: candidate,
                contents: args.contents,
                config: {
                  ...normalizedConfig,
                  abortSignal: controller.signal,
                },
              }),
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                  controller.abort();
                  reject(
                    new Error(
                      `Gemini model ${candidate} request timeout (${attemptTimeoutMs}ms)`
                    )
                  );
                }, attemptTimeoutMs);
              }),
            ]);
            opts.onSuccessModel?.(candidate);
            return res;
          } catch (err) {
            lastErr = err;
            const hasNext = i < attemptList.length - 1;
            if (
              shouldRetryNextModel(err) &&
              hasNext &&
              deadline - Date.now() > 0
            ) {
              continue;
            }
            throw err;
          } finally {
            if (timer !== undefined) {
              clearTimeout(timer);
            }
          }
        }
        throw lastErr;
      },
    },
  };
}

export function createGeminiAdapter(
  perModelTimeoutMs = PER_MODEL_TIMEOUT_MS,
  totalTimeoutMs = TOTAL_REQUEST_TIMEOUT_MS
): GeminiClientBundle | null {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) return null;
  const models = getGeminiModelCandidates();
  const primaryModel = models[0];

  const client = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });

  const rawAi: GenAI = {
    models: {
      async generateContent(args) {
        const response = await client.models.generateContent({
          model: args.model,
          contents: args.contents,
          config: args.config,
        });
        return { text: response.text };
      },
    },
  };

  const bundle: GeminiClientBundle = {
    ai: null as unknown as GenAI,
    model: primaryModel,
    models,
    lastUsedModel: null,
  };

  bundle.ai = withModelFallback(rawAi, models, {
    perModelTimeoutMs,
    totalTimeoutMs,
    onSuccessModel: (used) => {
      bundle.lastUsedModel = used;
    },
  });

  return bundle;
}

export function sanitizeDisclaimers(list: string[]): string[] {
  return list.map((line) =>
    line
      .replace(/也沒有標準開放授權/g, "也沒有外部證明文件")
      .replace(/標準開放授權/g, "外部授權文件")
  );
}

export function ruleBasedGeneralExplain(
  req: ExplainRequest,
  reason: string
): ExplainResponse {
  const topFacts: Fact[] = req.facts.slice(0, 8);
  const summaryParts = topFacts.slice(0, 3).map((f) => f.text);
  const summary =
    summaryParts.length > 0
      ? `系統摘要（${reason}）：${summaryParts.join("；")}`
      : `系統摘要（${reason}）：目前畫面提供 ${req.facts.length} 筆事實。`;

  const observations = topFacts.map((f) => ({
    text: f.text,
    cites: [f.id],
  }));

  const disclaimers = sanitizeDisclaimers(
    mandatoryDisclaimers(req.kind, req.data_kind)
  );
  disclaimers.push(`⚠️ 本段為依畫面事實整理的規則式摘要（${reason}），非 AI 生成。`);

  return {
    summary,
    observations,
    possible_causes: [],
    cannot_conclude: [
      "此段僅整理畫面上已計算出的數字與事實，無法單憑數值判斷設備或感測器物理原因。",
    ],
    suggested_checks: [
      "請以畫面上顯示的實際統計、趨勢與候選事件為準，並由人員依現場脈絡確認。",
    ],
    disclaimers,
    guard: {
      ungrounded_numbers: [],
      unknown_cites: [],
      ok: true,
    },
  };
}
