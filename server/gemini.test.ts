import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyGeminiError,
  getGeminiModelCandidates,
  isValidGeminiModelName,
  normalizeConfigForModel,
  PER_MODEL_TIMEOUT_MS,
  sanitizeErrorForLog,
  sanitizeErrorMessage,
  shouldRetryNextModel,
  TOTAL_REQUEST_TIMEOUT_MS,
  withModelFallback,
} from "./gemini.ts";
import type { GenAI } from "../reference/geminiExplain.ts";

test("預設模型清單順序、去重與逾時設定符合規格（8 秒／25 秒）", () => {
  assert.equal(PER_MODEL_TIMEOUT_MS, 8_000);
  assert.equal(TOTAL_REQUEST_TIMEOUT_MS, 25_000);

  assert.equal(
    isValidGeminiModelName("# 可選：要用的 Gemini 模型名稱（請在 AI Studio 選目前建議的 Flash 類模型）"),
    false
  );
  assert.equal(isValidGeminiModelName("   "), false);
  assert.equal(isValidGeminiModelName("gemini-3.5-flash-lite"), true);
  assert.equal(isValidGeminiModelName("models/gemini-4-hydrogen"), true);

  const candidates = getGeminiModelCandidates(
    "# 可選：要用的 Gemini 模型名稱（請在 AI Studio 選目前建議的 Flash 類模型）"
  );
  assert.deepEqual(candidates, [
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite",
    "gemini-4-hydrogen",
  ]);

  // Duplicate model name keeps only the first occurrence
  assert.deepEqual(getGeminiModelCandidates("gemini-3.1-flash-lite"), [
    "gemini-3.1-flash-lite",
    "gemini-3.5-flash-lite",
    "gemini-4-hydrogen",
  ]);

  assert.deepEqual(getGeminiModelCandidates("custom-flash-model"), [
    "custom-flash-model",
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite",
    "gemini-4-hydrogen",
  ]);

  const normalized = normalizeConfigForModel("gemini-4-hydrogen", {
    temperature: 0.2,
    responseMimeType: "application/json",
  });
  assert.equal("temperature" in normalized, false);
  assert.equal(normalized.responseMimeType, "application/json");
  assert.deepEqual(normalized.thinkingConfig, { thinkingLevel: "LOW" });
});

test("classifyGeminiError 涵蓋全部 7 個類別", () => {
  // 1. auth
  assert.equal(classifyGeminiError({ status: 401, message: "Unauthorized" }), "auth");
  assert.equal(
    classifyGeminiError({ status: 403, message: "PERMISSION_DENIED: caller lacks permission" }),
    "auth"
  );
  assert.equal(
    classifyGeminiError({
      status: 400,
      message: "API_KEY_INVALID: API key not valid. Please pass a valid API key.",
    }),
    "auth"
  );

  // 2. model_not_found
  assert.equal(
    classifyGeminiError({
      status: 404,
      message: "models/gemini-old is not found for API version v1beta",
    }),
    "model_not_found"
  );
  assert.equal(
    classifyGeminiError(new Error('{"error":{"code":404,"status":"NOT_FOUND"}}')),
    "model_not_found"
  );

  // 3. quota
  assert.equal(
    classifyGeminiError({ status: 429, message: "RESOURCE_EXHAUSTED: Quota exceeded" }),
    "quota"
  );

  // 4. bad_request
  assert.equal(
    classifyGeminiError({
      status: 400,
      message: 'INVALID_ARGUMENT: Unknown name "thinkingBudget" at generation_config',
    }),
    "bad_request"
  );

  // 5. timeout
  assert.equal(
    classifyGeminiError(new Error("Gemini request timeout (8000ms)")),
    "timeout"
  );
  const abortErr = new Error("The operation was aborted due to timeout");
  abortErr.name = "TimeoutError";
  assert.equal(classifyGeminiError(abortErr), "timeout");

  // 6. network
  const netErr = new TypeError("fetch failed");
  (netErr as TypeError & { cause?: unknown }).cause = { code: "ECONNREFUSED" };
  assert.equal(classifyGeminiError(netErr), "network");

  // 7. other
  assert.equal(
    classifyGeminiError(new Error("Unexpected parser glitch in upstream payload")),
    "other"
  );
});

test("sanitizeErrorMessage 與 sanitizeErrorForLog 會去除 API key、環境變數密鑰與網址並截斷至 200 字", () => {
  const prevKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "super-secret-env-token-9988";
  try {
    const raw =
      "Error calling https://generativelanguage.googleapis.com/v1beta/models/x?key=AIzaSyFakeSecret1234567890 with env token super-secret-env-token-9988 and " +
      "detail ".repeat(50);

    const cleaned = sanitizeErrorMessage(raw);
    assert.ok(cleaned.length <= 200, `Expected <= 200 chars, got ${cleaned.length}`);
    assert.equal(cleaned.includes("AIza"), false);
    assert.equal(cleaned.includes("super-secret-env-token-9988"), false);
    assert.equal(cleaned.includes("https://"), false);
    assert.equal(cleaned.includes("generativelanguage.googleapis.com"), false);

    const logEntry = sanitizeErrorForLog({
      status: 403,
      name: "ApiError",
      message: "Denied for AIzaSyAnotherFakeKey987654 at https://example.com/v1",
    });
    assert.equal(logEntry.category, "auth");
    assert.equal(logEntry.status, 403);
    assert.equal(logEntry.name, "ApiError");
    assert.equal(logEntry.message.includes("AIza"), false);
    assert.equal(logEntry.message.includes("https://"), false);
  } finally {
    if (prevKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prevKey;
  }
});

test("shouldRetryNextModel：503 / 500 / model_not_found / timeout 會重試；auth / quota / bad_request 不重試", () => {
  assert.equal(shouldRetryNextModel({ status: 404, message: "NOT_FOUND" }), true);
  assert.equal(shouldRetryNextModel({ status: 503, message: "UNAVAILABLE" }), true);
  assert.equal(shouldRetryNextModel({ status: 500, message: "Internal error" }), true);
  assert.equal(shouldRetryNextModel(new Error("Gemini model x request timeout (8000ms)")), true);

  assert.equal(shouldRetryNextModel({ status: 401, message: "Unauthorized" }), false);
  assert.equal(shouldRetryNextModel({ status: 403, message: "PERMISSION_DENIED" }), false);
  assert.equal(shouldRetryNextModel({ status: 400, message: "API_KEY_INVALID" }), false);
  assert.equal(shouldRetryNextModel({ status: 429, message: "RESOURCE_EXHAUSTED" }), false);
  assert.equal(shouldRetryNextModel({ status: 400, message: "INVALID_ARGUMENT" }), false);
});

test("withModelFallback：404 / 503 / 500 與單一模型逾時會換下一個模型，並記錄實際成功模型", async () => {
  const models = [
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite",
    "gemini-4-hydrogen",
  ];

  // 1. 503 UNAVAILABLE falls back to next model
  const attempted503: string[] = [];
  let used503: string | null = null;
  const ai503ThenOk: GenAI = {
    models: {
      async generateContent(args) {
        attempted503.push(args.model);
        if (args.model === "gemini-3.5-flash-lite") {
          const err = new Error('{"error":{"code":503,"status":"UNAVAILABLE"}}') as Error & {
            status?: number;
          };
          err.status = 503;
          throw err;
        }
        return { text: "OK-503" };
      },
    },
  };
  const wrapped503 = withModelFallback(ai503ThenOk, models, (m) => {
    used503 = m;
  });
  const res503 = await wrapped503.models.generateContent({
    model: "gemini-3.5-flash-lite",
    contents: "hi",
    config: {},
  });
  assert.equal(res503.text, "OK-503");
  assert.deepEqual(attempted503, ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"]);
  assert.equal(used503, "gemini-3.1-flash-lite");

  // 2. 500 + 404 falls back to 3rd model
  const attempted500: string[] = [];
  let used500: string | null = null;
  const ai500And404ThenOk: GenAI = {
    models: {
      async generateContent(args) {
        attempted500.push(args.model);
        if (args.model === "gemini-3.5-flash-lite") {
          const err = new Error("Internal server error") as Error & { status?: number };
          err.status = 500;
          throw err;
        }
        if (args.model === "gemini-3.1-flash-lite") {
          const err = new Error("models/gemini-3.1-flash-lite is not found") as Error & {
            status?: number;
          };
          err.status = 404;
          throw err;
        }
        return { text: "OK-4H" };
      },
    },
  };
  const wrapped500 = withModelFallback(ai500And404ThenOk, models, (m) => {
    used500 = m;
  });
  const res500 = await wrapped500.models.generateContent({
    model: "gemini-3.5-flash-lite",
    contents: "hi",
    config: { temperature: 0.2 },
  });
  assert.equal(res500.text, "OK-4H");
  assert.deepEqual(attempted500, models);
  assert.equal(used500, "gemini-4-hydrogen");

  // 3. Per-model timeout switches to next model
  const attemptedTimeout: string[] = [];
  let usedTimeout: string | null = null;
  const aiTimeoutThenOk: GenAI = {
    models: {
      generateContent(args) {
        attemptedTimeout.push(args.model);
        if (args.model === "gemini-3.5-flash-lite") {
          return new Promise((_resolve, reject) => {
            const signal = (args.config as { abortSignal?: AbortSignal }).abortSignal;
            signal?.addEventListener("abort", () => {
              const abortErr = new Error("aborted by per-model timeout");
              abortErr.name = "AbortError";
              reject(abortErr);
            });
          });
        }
        return Promise.resolve({ text: "OK-AFTER-TIMEOUT" });
      },
    },
  };
  const wrappedTimeout = withModelFallback(aiTimeoutThenOk, models, {
    perModelTimeoutMs: 25,
    totalTimeoutMs: 500,
    onSuccessModel: (m) => {
      usedTimeout = m;
    },
  });
  const resTimeout = await wrappedTimeout.models.generateContent({
    model: "gemini-3.5-flash-lite",
    contents: "hi",
    config: {},
  });
  assert.equal(resTimeout.text, "OK-AFTER-TIMEOUT");
  assert.deepEqual(attemptedTimeout, ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"]);
  assert.equal(usedTimeout, "gemini-3.1-flash-lite");
});

test("withModelFallback：auth / quota / bad_request 不重試；全部失敗時丟出最後一次失敗", async () => {
  const models = [
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite",
    "gemini-4-hydrogen",
  ];

  // auth must NOT retry
  const authAttempts: string[] = [];
  const wrappedAuth = withModelFallback(
    {
      models: {
        async generateContent(args) {
          authAttempts.push(args.model);
          const err = new Error("Unauthorized") as Error & { status?: number };
          err.status = 401;
          throw err;
        },
      },
    },
    models
  );
  await assert.rejects(
    () =>
      wrappedAuth.models.generateContent({
        model: "gemini-3.5-flash-lite",
        contents: "hi",
        config: {},
      }),
    /Unauthorized/
  );
  assert.deepEqual(authAttempts, ["gemini-3.5-flash-lite"]);

  // quota must NOT retry
  const quotaAttempts: string[] = [];
  const wrappedQuota = withModelFallback(
    {
      models: {
        async generateContent(args) {
          quotaAttempts.push(args.model);
          const err = new Error("RESOURCE_EXHAUSTED") as Error & { status?: number };
          err.status = 429;
          throw err;
        },
      },
    },
    models
  );
  await assert.rejects(
    () =>
      wrappedQuota.models.generateContent({
        model: "gemini-3.5-flash-lite",
        contents: "hi",
        config: {},
      }),
    /RESOURCE_EXHAUSTED/
  );
  assert.deepEqual(quotaAttempts, ["gemini-3.5-flash-lite"]);

  // bad_request must NOT retry
  const badAttempts: string[] = [];
  const wrappedBad = withModelFallback(
    {
      models: {
        async generateContent(args) {
          badAttempts.push(args.model);
          const err = new Error("INVALID_ARGUMENT: bad schema") as Error & {
            status?: number;
          };
          err.status = 400;
          throw err;
        },
      },
    },
    models
  );
  await assert.rejects(
    () =>
      wrappedBad.models.generateContent({
        model: "gemini-3.5-flash-lite",
        contents: "hi",
        config: {},
      }),
    /INVALID_ARGUMENT/
  );
  assert.deepEqual(badAttempts, ["gemini-3.5-flash-lite"]);

  // All models fail -> throws the LAST error
  const allAttempts: string[] = [];
  const wrappedAllFail = withModelFallback(
    {
      models: {
        async generateContent(args) {
          allAttempts.push(args.model);
          if (args.model === "gemini-3.5-flash-lite") {
            const err = new Error("UNAVAILABLE") as Error & { status?: number };
            err.status = 503;
            throw err;
          }
          if (args.model === "gemini-3.1-flash-lite") {
            const err = new Error("Internal error") as Error & { status?: number };
            err.status = 500;
            throw err;
          }
          const err = new Error("models/gemini-4-hydrogen is not found") as Error & {
            status?: number;
          };
          err.status = 404;
          throw err;
        },
      },
    },
    models
  );
  await assert.rejects(
    async () =>
      wrappedAllFail.models.generateContent({
        model: "gemini-3.5-flash-lite",
        contents: "hi",
        config: {},
      }),
    (err) => classifyGeminiError(err) === "model_not_found"
  );
  assert.deepEqual(allAttempts, models);

  // Overall totalTimeoutMs cap stops further attempts
  const cappedAttempts: string[] = [];
  const wrappedCapped = withModelFallback(
    {
      models: {
        generateContent(args) {
          cappedAttempts.push(args.model);
          return new Promise((_resolve, reject) => {
            setTimeout(() => {
              const err = new Error("UNAVAILABLE") as Error & { status?: number };
              err.status = 503;
              reject(err);
            }, 35);
          });
        },
      },
    },
    models,
    { perModelTimeoutMs: 50, totalTimeoutMs: 30 }
  );
  await assert.rejects(
    async () =>
      wrappedCapped.models.generateContent({
        model: "gemini-3.5-flash-lite",
        contents: "hi",
        config: {},
      }),
    (err) => classifyGeminiError(err) === "timeout"
  );
  assert.deepEqual(cappedAttempts, ["gemini-3.5-flash-lite"]);
});
