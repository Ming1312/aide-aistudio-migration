import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import express from "express";
import type { DecisionExplainResponse, DecisionSupportResponse } from "../contracts/types.ts";
import { makeHash } from "../reference/adminAuth.ts";
import { createApiRouter } from "./routes.ts";

async function withServer(
  options: Parameters<typeof createApiRouter>[0],
  fn: (baseUrl: string) => Promise<void>
) {
  const app = express();
  app.set("trust proxy", 1);
  app.use("/api", createApiRouter(options));
  // Mirror Vite/prod SPA fallback in server.ts so unmatched GET routes serve index.html
  app.use((_req, res) => {
    res.type("html").sendFile(path.resolve(process.cwd(), "index.html"));
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("GET /api/decision/:datasetId：合法場域回 200，未知場域回 404，不含任何金鑰", async () => {
  await withServer({ engineBaseUrl: "", geminiBundle: null }, async (base) => {
    const okRes = await fetch(`${base}/api/decision/sanyegong_creek`);
    assert.equal(okRes.status, 200);
    const data = (await okRes.json()) as DecisionSupportResponse & { source: string };
    assert.equal(data.dataset_id, "sanyegong_creek");
    assert.equal(data.source, "precomputed");
    assert.equal(data.tier_summary.formal_risk, 0);

    const notFound = await fetch(`${base}/api/decision/unknown_site`);
    assert.equal(notFound.status, 404);

    const sheepRes = await fetch(`${base}/api/decision/sheep_barn`);
    assert.equal(sheepRes.status, 200);
    const sheep = (await sheepRes.json()) as DecisionSupportResponse;
    assert.equal(sheep.tier_summary.formal_risk, 1);
  });
});

test("POST /api/decision/explain：沒有金鑰時退回規則層原文；不信任前端傳入的建議", async () => {
  await withServer({ engineBaseUrl: "", geminiBundle: null }, async (base) => {
    const res = await fetch(`${base}/api/decision/explain`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dataset_id: "rearing_plant_1_north",
        question: "請問這個場域可以預測嗎？",
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as DecisionExplainResponse;
    assert.equal(body.overview_source, "rule_based");
    assert.ok(body.items.every((i) => i.plain_text_source === "rule_based"));
    assert.ok(body.disclaimers.some((d) => d.includes("不是 AI 改寫")));
  });
});

test("POST /api/decision/explain：未知場域 404、問題過長或本文過大 400", async () => {
  await withServer({ engineBaseUrl: "", geminiBundle: null }, async (base) => {
    const nf = await fetch(`${base}/api/decision/explain`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataset_id: "nope" }),
    });
    assert.equal(nf.status, 404);

    const longQ = await fetch(`${base}/api/decision/explain`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dataset_id: "sheep_barn",
        question: "a".repeat(301),
      }),
    });
    assert.equal(longQ.status, 400);

    const hugeBody = await fetch(`${base}/api/decision/explain`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dataset_id: "sheep_barn",
        extra: "x".repeat(70_000),
      }),
    });
    assert.equal(hugeBody.status, 400);
  });
});

test("POST /api/decision/explain：超過每分鐘 10 次回 429，且偽造 X-Forwarded-For 第一個值不能繞過限制", async () => {
  await withServer(
    { engineBaseUrl: "", geminiBundle: null, maxPerIp: 10, maxGlobal: 60 },
    async (base) => {
      for (let i = 0; i < 10; i++) {
        // Spoof the first value in X-Forwarded-For while the trailing hop IP remains 203.0.113.9
        const res = await fetch(`${base}/api/decision/explain`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Forwarded-For": `198.51.100.${i}, 203.0.113.9`,
          },
          body: JSON.stringify({ dataset_id: "sanyegong_creek" }),
        });
        assert.equal(res.status, 200, `Request ${i + 1} should succeed`);
      }

      const blocked = await fetch(`${base}/api/decision/explain`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-For": "198.51.100.250, 203.0.113.9",
        },
        body: JSON.stringify({ dataset_id: "sanyegong_creek" }),
      });
      assert.equal(blocked.status, 429);
      const err = (await blocked.json()) as { detail: string };
      assert.equal(err.detail, "請求過於頻繁，請稍後再試");
    }
  );
});

test("GET /api/health/gemini-probe 已移除（回傳前端首頁 HTML 而非 JSON）", async () => {
  await withServer({ engineBaseUrl: "", geminiBundle: null }, async (base) => {
    const res = await fetch(`${base}/api/health/gemini-probe`);
    assert.equal(res.status, 200);
    const contentType = res.headers.get("content-type") ?? "";
    assert.ok(contentType.includes("text/html"), `Expected text/html, got ${contentType}`);
    const html = await res.text();
    assert.ok(html.includes("<div id=\"root\">"), "Expected SPA index.html response");
  });
});

test("模型備援路由測試：503 換下一個模型、單一模型逾時換下一個模型、並回傳實際 model_used", async () => {
  const attempted503: string[] = [];
  await withServer(
    {
      engineBaseUrl: "",
      geminiBundle: {
        model: "gemini-3.5-flash-lite",
        models: [
          "gemini-3.5-flash-lite",
          "gemini-3.1-flash-lite",
          "gemini-4-hydrogen",
        ],
        ai: {
          models: {
            async generateContent(args) {
              attempted503.push(args.model);
              if (args.model === "gemini-3.5-flash-lite") {
                const e = new Error("UNAVAILABLE") as Error & { status?: number };
                e.status = 503;
                throw e;
              }
              return {
                text: JSON.stringify({
                  overview: "目前僅呈現既有觀測事實摘要，並由現場人員持續確認。",
                  items: [],
                  cannot_conclude: ["資料未提供故障或因果證明。"],
                }),
              };
            },
          },
        },
      },
    },
    async (base) => {
      const res = await fetch(`${base}/api/decision/explain`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dataset_id: "sanyegong_creek" }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as DecisionExplainResponse & {
        model_used?: string;
        fallback_category?: string;
      };
      assert.deepEqual(attempted503, [
        "gemini-3.5-flash-lite",
        "gemini-3.1-flash-lite",
      ]);
      assert.equal(body.overview_source, "gemini");
      assert.equal(body.model_used, "gemini-3.1-flash-lite");
      assert.equal(body.fallback_category, undefined);
    }
  );

  // Timeout fallback on /api/ai/explain
  const attemptedTimeout: string[] = [];
  await withServer(
    {
      engineBaseUrl: "",
      perModelTimeoutMs: 30,
      totalTimeoutMs: 500,
      geminiBundle: {
        model: "gemini-3.5-flash-lite",
        models: [
          "gemini-3.5-flash-lite",
          "gemini-3.1-flash-lite",
          "gemini-4-hydrogen",
        ],
        ai: {
          models: {
            generateContent(args) {
              attemptedTimeout.push(args.model);
              if (args.model === "gemini-3.5-flash-lite") {
                return new Promise(() => {
                  // Never resolves -> triggers 30ms per-model timeout
                });
              }
              return Promise.resolve({
                text: JSON.stringify({
                  summary: "樣本共 100 筆。",
                  observations: [{ text: "樣本共 100 筆", cites: ["f1"] }],
                  possible_causes: [],
                  cannot_conclude: ["無法由單一統計確認現場設備狀態。"],
                  suggested_checks: ["請人工覆核原始量測記錄。"],
                  disclaimers: [],
                }),
              });
            },
          },
        },
      },
    },
    async (base) => {
      const res = await fetch(`${base}/api/ai/explain`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "data",
          data_kind: "real",
          dataset_id: "sanyegong_creek",
          facts: [{ id: "f1", text: "樣本共 100 筆", value: 100 }],
        }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        model_used?: string;
        fallback_category?: string;
        guard: { ok: boolean };
      };
      assert.deepEqual(attemptedTimeout, [
        "gemini-3.5-flash-lite",
        "gemini-3.1-flash-lite",
      ]);
      assert.equal(body.model_used, "gemini-3.1-flash-lite");
      assert.equal(body.fallback_category, undefined);
      assert.equal(body.guard.ok, true);
    }
  );
});

test("auth 不重試下一個模型；全部失敗時回規則層原文並以最後一次失敗類別作為 fallback_category", async () => {
  // 1. auth does not retry
  const authAttempts: string[] = [];
  await withServer(
    {
      engineBaseUrl: "",
      geminiBundle: {
        model: "gemini-3.5-flash-lite",
        models: [
          "gemini-3.5-flash-lite",
          "gemini-3.1-flash-lite",
          "gemini-4-hydrogen",
        ],
        ai: {
          models: {
            async generateContent(args) {
              authAttempts.push(args.model);
              const e = new Error("PERMISSION_DENIED: invalid key") as Error & {
                status?: number;
              };
              e.status = 403;
              throw e;
            },
          },
        },
      },
    },
    async (base) => {
      const res = await fetch(`${base}/api/decision/explain`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dataset_id: "sanyegong_creek" }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as DecisionExplainResponse & {
        fallback_category?: string;
      };
      assert.deepEqual(authAttempts, ["gemini-3.5-flash-lite"]);
      assert.equal(body.overview_source, "rule_based");
      assert.equal(body.fallback_category, "auth");
    }
  );

  // 2. All models fail -> uses LAST failure category for fallback_category & /api/health
  const allFailAttempts: string[] = [];
  await withServer(
    {
      engineBaseUrl: "",
      perModelTimeoutMs: 30,
      totalTimeoutMs: 500,
      geminiBundle: {
        model: "gemini-3.5-flash-lite",
        models: [
          "gemini-3.5-flash-lite",
          "gemini-3.1-flash-lite",
          "gemini-4-hydrogen",
        ],
        ai: {
          models: {
            async generateContent(args) {
              allFailAttempts.push(args.model);
              if (args.model === "gemini-3.5-flash-lite") {
                const e = new Error("UNAVAILABLE") as Error & { status?: number };
                e.status = 503;
                throw e;
              }
              if (args.model === "gemini-3.1-flash-lite") {
                return new Promise(() => {
                  // triggers timeout -> retries next
                });
              }
              const e = new Error("models/gemini-4-hydrogen is not found") as Error & {
                status?: number;
              };
              e.status = 404;
              throw e;
            },
          },
        },
      },
    },
    async (base) => {
      const decRes = await fetch(`${base}/api/decision/explain`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dataset_id: "sanyegong_creek" }),
      });
      assert.equal(decRes.status, 200);
      const decBody = (await decRes.json()) as DecisionExplainResponse & {
        fallback_category?: string;
      };
      assert.deepEqual(allFailAttempts, [
        "gemini-3.5-flash-lite",
        "gemini-3.1-flash-lite",
        "gemini-4-hydrogen",
      ]);
      assert.equal(decBody.overview_source, "rule_based");
      assert.ok(decBody.items.every((i) => i.plain_text_source === "rule_based"));
      assert.equal(decBody.fallback_category, "model_not_found");

      const healthRes = await fetch(`${base}/api/health`);
      const healthBody = (await healthRes.json()) as {
        gemini_last_error: { category: string; at: string; message?: string } | null;
      };
      assert.ok(healthBody.gemini_last_error);
      assert.equal(healthBody.gemini_last_error.category, "model_not_found");
      assert.equal(typeof healthBody.gemini_last_error.at, "string");
      assert.equal(healthBody.gemini_last_error.message, undefined);
    }
  );
});

test("GET /api/overview/status：預設 24 小時、支援 72/168、非法參數回 400、缺檔回 503、超過速率限制回 429", async () => {
  await withServer({ engineBaseUrl: "", geminiBundle: null }, async (base) => {
    // 1. Default (24h)
    const res24 = await fetch(`${base}/api/overview/status`);
    assert.equal(res24.status, 200);
    const body24 = (await res24.json()) as {
      window_hours: number;
      meta: { generated_at: string; definition: string; no_claim: string };
      datasets: Record<
        string,
        { dataset_id: string; status: string; n_events: number; window_hours: number }
      >;
      summary: { has_issue: number; none_recent: number };
    };
    assert.equal(body24.window_hours, 24);
    assert.ok(body24.meta.generated_at);
    assert.ok(body24.meta.definition);
    assert.ok(body24.meta.no_claim);
    assert.equal(body24.summary.has_issue, 4);
    assert.equal(body24.summary.none_recent, 3);
    assert.equal(body24.datasets.sheep_barn.n_events, 3);
    assert.equal(body24.datasets.sheep_barn.status, "has_issue");
    assert.equal(body24.datasets.sanyegong_creek.n_events, 0);
    assert.equal(body24.datasets.sanyegong_creek.status, "none_recent");
    assert.equal(body24.datasets.construction_site_cb13505.n_events, 0);
    assert.equal(body24.datasets.rearing_plant_1.n_events, 0);
    assert.equal(body24.datasets.rearing_plant_1_north.n_events, 11);

    // 2. 72h and 168h
    const res72 = await fetch(`${base}/api/overview/status?window_hours=72`);
    assert.equal(res72.status, 200);
    const body72 = (await res72.json()) as typeof body24;
    assert.equal(body72.window_hours, 72);
    assert.equal(body72.datasets.construction_site_cb13505.n_events, 4);
    assert.equal(body72.datasets.rearing_plant_1.n_events, 2);

    const res168 = await fetch(`${base}/api/overview/status?window_hours=168`);
    assert.equal(res168.status, 200);
    const body168 = (await res168.json()) as typeof body24;
    assert.equal(body168.window_hours, 168);
    assert.equal(body168.datasets.expert_system_c22.n_events, 21);
    assert.equal(body168.datasets.construction_site_cb13505.n_events, 17);
    assert.equal(body168.datasets.northeast_corner.n_events, 17);
    assert.equal(body168.datasets.rearing_plant_1.n_events, 11);

    // 3. Invalid window_hours -> 400
    for (const bad of ["12", "48", "0", "abc", "24h"]) {
      const badRes = await fetch(
        `${base}/api/overview/status?window_hours=${encodeURIComponent(bad)}`
      );
      assert.equal(badRes.status, 400, `window_hours=${bad} should return 400`);
    }
  });

  // 4. Missing overview_status.json -> 503
  await withServer(
    {
      engineBaseUrl: "",
      geminiBundle: null,
      overviewStatusPath: "public/data/real_public/precomputed/__missing_overview_status.json",
    },
    async (base) => {
      const res503 = await fetch(`${base}/api/overview/status`);
      assert.equal(res503.status, 503);
    }
  );

  // 5. Rate limit: 10 requests per minute per IP (req.ip), 11th returns 429
  await withServer(
    { engineBaseUrl: "", geminiBundle: null, maxPerIp: 10, maxGlobal: 60 },
    async (base) => {
      for (let i = 0; i < 10; i++) {
        const res = await fetch(`${base}/api/overview/status?window_hours=24`, {
          headers: {
            "X-Forwarded-For": `198.51.100.${i}, 203.0.113.55`,
          },
        });
        assert.equal(res.status, 200, `Overview request ${i + 1} should succeed`);
      }
      const blocked = await fetch(`${base}/api/overview/status?window_hours=24`, {
        headers: {
          "X-Forwarded-For": "198.51.100.250, 203.0.113.55",
        },
      });
      assert.equal(blocked.status, 429);
    }
  );
});

async function withMockEngine(
  handler: (
    req: http.IncomingMessage,
    bodyText: string,
    res: http.ServerResponse
  ) => void | Promise<void>,
  fn: (engineUrl: string) => Promise<void>
) {
  const srv = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.from(c)));
    req.on("end", () => {
      void handler(req, Buffer.concat(chunks).toString("utf-8"), res);
    });
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const addr = srv.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
}

test("即時預測代理：引擎離線回 503、:id 非法回 404、引擎 404 原樣轉發、/health 回即時布林旗標", async () => {
  // 1. Offline engine -> 503 exact detail + health booleans false
  await withServer(
    { engineBaseUrl: "", engineApiKey: "secret-api", engineAdminKey: "secret-admin", geminiBundle: null },
    async (base) => {
      const hRes = await fetch(`${base}/api/health`);
      const hBody = (await hRes.json()) as Record<string, unknown>;
      assert.equal(hBody.live_engine_connected, false);
      assert.equal(hBody.live_writes_enabled, false);
      assert.equal(hBody.live_sim_enabled, false);
      assert.equal(JSON.stringify(hBody).includes("secret-api"), false);
      assert.equal(JSON.stringify(hBody).includes("secret-admin"), false);

      const stRes = await fetch(`${base}/api/live/sheep_barn/status`);
      assert.equal(stRes.status, 503);
      assert.deepEqual(await stRes.json(), {
        detail: "尚未連線到 Python 引擎，即時預測不可用",
      });

      const nfRes = await fetch(`${base}/api/live/invalid_site/status`);
      assert.equal(nfRes.status, 404);
    }
  );

  // 2. Mock engine connected: forwards X-API-Key, forwards 404 / 4xx detail, sanitizes secret/URL, /health booleans true
  const apiKey = "test-engine-api-key-999";
  const adminKey = "test-engine-admin-key-888";
  const seenHeaders: Array<{ url: string; apiKey?: string; adminKey?: string }> = [];

  await withMockEngine(
    (req, _bodyText, res) => {
      seenHeaders.push({
        url: req.url || "",
        apiKey: String(req.headers["x-api-key"] || ""),
        adminKey: req.headers["x-admin-key"] ? String(req.headers["x-admin-key"]) : undefined,
      });
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/health") {
        res.end(
          JSON.stringify({
            ok: true,
            version: "aistudio-1.0.0",
            read_only: true,
            live_engine_connected: true,
            live_writes_enabled: true,
            live_sim_enabled: true,
          })
        );
        return;
      }
      if (req.url === "/v1/live/sheep_barn/forecast") {
        res.statusCode = 404;
        res.end(JSON.stringify({ detail: "該場域尚無即時預測輸出" }));
        return;
      }
      if (req.url === "/v1/live/sheep_barn/status") {
        res.end(
          JSON.stringify({
            dataset_id: "sheep_barn",
            data_end: "2026-08-13 14:00:00",
            mode: "sim",
            is_stale: false,
            stale_after_h: 3,
            current_version: "v2",
            latest_source: "synthetic",
            flags: [{ text: `資料來源測試 ${apiKey}` }],
          })
        );
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ detail: "Not found" }));
    },
    async (engineUrl) => {
      await withServer(
        {
          engineBaseUrl: engineUrl,
          engineApiKey: apiKey,
          engineAdminKey: adminKey,
          geminiBundle: null,
        },
        async (base) => {
          const hRes = await fetch(`${base}/api/health`);
          const hBody = (await hRes.json()) as Record<string, unknown>;
          assert.equal(hBody.live_engine_connected, true);
          assert.equal(hBody.live_writes_enabled, true);
          assert.equal(hBody.live_sim_enabled, true);

          const stRes = await fetch(`${base}/api/live/sheep_barn/status`);
          assert.equal(stRes.status, 200);
          const stText = await stRes.text();
          assert.equal(stText.includes(apiKey), false);
          assert.equal(stText.includes(adminKey), false);

          const fcRes = await fetch(`${base}/api/live/sheep_barn/forecast`);
          assert.equal(fcRes.status, 404);
          assert.deepEqual(await fcRes.json(), { detail: "該場域尚無即時預測輸出" });

          const readReq = seenHeaders.find((h) => h.url === "/v1/live/sheep_barn/status");
          assert.equal(readReq?.apiKey, apiKey);
          assert.equal(readReq?.adminKey, undefined);
        }
      );
    }
  );
});

test("即時預測寫入代理：非管理者 403、管理者帶雙金鑰並強制覆寫 approved_by、4xx 原樣轉發、ingest 6MB 與一般 64KB 上限", async () => {
  const adminHash = makeHash("secret-pass-123", 100_000);
  const apiKey = "live-api-key-111";
  const adminKey = "live-admin-key-222";
  const receivedWrites: Array<{ url: string; apiKey?: string; adminKey?: string; body: Record<string, unknown> }> = [];

  await withMockEngine(
    (req, bodyText, res) => {
      res.setHeader("Content-Type", "application/json");
      const parsed = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {};
      receivedWrites.push({
        url: req.url || "",
        apiKey: String(req.headers["x-api-key"] || ""),
        adminKey: String(req.headers["x-admin-key"] || ""),
        body: parsed,
      });
      if (req.url === "/v1/live/sheep_barn/rollback") {
        res.statusCode = 422;
        res.end(JSON.stringify({ detail: "回復原因需至少 6 個字" }));
        return;
      }
      res.end(
        JSON.stringify({
          ok: true,
          decision: "COMMITTED",
          version_id: "v3",
        })
      );
    },
    async (engineUrl) => {
      await withServer(
        {
          adminHash,
          engineBaseUrl: engineUrl,
          engineApiKey: apiKey,
          engineAdminKey: adminKey,
          geminiBundle: null,
        },
        async (base) => {
          // 1. Non-admin -> 403 on all write actions
          for (const action of ["ingest", "commit", "rollback", "recompute", "sim/tick"]) {
            const unauth = await fetch(`${base}/api/live/sheep_barn/${action}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({}),
            });
            assert.equal(unauth.status, 403, `${action} must reject non-admin with 403`);
          }
          assert.equal(receivedWrites.length, 0);

          // 2. Login as admin and capture session cookie
          const loginRes = await fetch(`${base}/api/admin/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ passphrase: "secret-pass-123" }),
          });
          assert.equal(loginRes.status, 200);
          const cookieHeader = (loginRes.headers.get("set-cookie") || "").split(";")[0];
          assert.ok(cookieHeader.includes("aide_sid="));

          // 3. Oversized > 64kb on /commit fails with 400
          const bigCommit = await fetch(`${base}/api/live/sheep_barn/commit`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Cookie: cookieHeader },
            body: JSON.stringify({ upload_id: "u1", pad: "x".repeat(80_000) }),
          });
          assert.equal(bigCommit.status, 400);

          // 4. Medium > 64kb (~120kb) on /ingest succeeds (6MB allowance) & overrides approved_by
          const mediumIngest = await fetch(`${base}/api/live/sheep_barn/ingest`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Cookie: cookieHeader },
            body: JSON.stringify({
              source: "synthetic",
              license_note: "demo stream",
              approved_by: "attacker-spoofed",
              csv_text: "timestamp,x\n" + "2026-08-13 15:00:00,1\n".repeat(5000),
            }),
          });
          assert.equal(mediumIngest.status, 200);
          const ingestBody = (await mediumIngest.json()) as { decision: string };
          assert.equal(ingestBody.decision, "COMMITTED");
          assert.equal(receivedWrites[0].apiKey, apiKey);
          assert.equal(receivedWrites[0].adminKey, adminKey);
          assert.notEqual(receivedWrites[0].body.approved_by, "attacker-spoofed");
          assert.ok(String(receivedWrites[0].body.approved_by).startsWith("admin:"));

          // 5. > 6MB on /ingest rejected with 413
          const hugeIngest = await fetch(`${base}/api/live/sheep_barn/ingest`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Cookie: cookieHeader },
            body: JSON.stringify({ csv_text: "a".repeat(6_300_000) }),
          });
          assert.equal(hugeIngest.status, 413);

          // 6. Upstream 4xx detail forwarded verbatim
          const rbRes = await fetch(`${base}/api/live/sheep_barn/rollback`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Cookie: cookieHeader },
            body: JSON.stringify({ to_version: "v1", reason: "短" }),
          });
          assert.equal(rbRes.status, 422);
          assert.deepEqual(await rbRes.json(), { detail: "回復原因需至少 6 個字" });
        }
      );
    }
  );
});

test("即時預測獨立速率限制：讀取 60 次/分（不與 Gemini 共用）、寫入 10 次/分", async () => {
  const adminHash = makeHash("rate-pass-123", 100_000);
  await withMockEngine(
    (req, _body, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/v1/live/domains") {
        res.end(JSON.stringify({ domains: [] }));
        return;
      }
      res.end(JSON.stringify({ ok: true }));
    },
    async (engineUrl) => {
      await withServer(
        {
          adminHash,
          engineBaseUrl: engineUrl,
          engineApiKey: "k1",
          engineAdminKey: "k2",
          geminiBundle: null,
          maxPerIp: 10,
          liveReadMaxPerIp: 60,
          liveWriteMaxPerIp: 10,
        },
        async (base) => {
          // Burn 10 Gemini explain requests first -> Gemini hits 429, live read must STILL allow 60/min
          const aiBody = JSON.stringify({
            kind: "data",
            data_kind: "real",
            dataset_id: "sanyegong_creek",
            facts: [{ id: "f1", text: "樣本共 100 筆", value: 100 }],
          });
          for (let i = 0; i < 10; i++) {
            const g = await fetch(`${base}/api/ai/explain`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Forwarded-For": "203.0.113.77",
              },
              body: aiBody,
            });
            assert.equal(g.status, 200);
          }
          const gBlocked = await fetch(`${base}/api/ai/explain`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Forwarded-For": "203.0.113.77",
            },
            body: aiBody,
          });
          assert.equal(gBlocked.status, 429);

          // Live reads from same IP get full independent 60/min quota
          for (let i = 0; i < 60; i++) {
            const r = await fetch(`${base}/api/live/domains`, {
              headers: { "X-Forwarded-For": "203.0.113.77" },
            });
            assert.equal(r.status, 200, `Live read ${i + 1} should succeed`);
          }
          const rBlocked = await fetch(`${base}/api/live/domains`, {
            headers: { "X-Forwarded-For": "203.0.113.77" },
          });
          assert.equal(rBlocked.status, 429);

          // Live writes get 10/min
          const loginRes = await fetch(`${base}/api/admin/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ passphrase: "rate-pass-123" }),
          });
          const cookie = (loginRes.headers.get("set-cookie") || "").split(";")[0];
          for (let i = 0; i < 10; i++) {
            const w = await fetch(`${base}/api/live/sheep_barn/recompute`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Cookie: cookie,
                "X-Forwarded-For": "203.0.113.88",
              },
              body: JSON.stringify({}),
            });
            assert.equal(w.status, 200);
          }
          const wBlocked = await fetch(`${base}/api/live/sheep_barn/recompute`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Cookie: cookie,
              "X-Forwarded-For": "203.0.113.88",
            },
            body: JSON.stringify({}),
          });
          assert.equal(wBlocked.status, 429);
        }
      );
    }
  );
});

test("即時預測代理形狀與 Content-Type：/versions /pending /events 轉發陣列；非 JSON 回 503 離線；壞 JSON 回 502 格式不符", async () => {
  await withMockEngine(
    (req, _body, res) => {
      if (req.url === "/v1/live/sanyegong_creek/versions") {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify([
            {
              seq: 1,
              version_id: "三爺宮溪-v0001-98bc51164927",
              created_at: "2026-11-23 01:47:29.402949",
              rows_added: 6,
              source: "synthetic",
              approved_by: "sim-feed",
              time_range: ["2026-05-01 01:00:00", "2026-05-01 06:00:00"],
              synthetic_marked: true,
              is_current: true,
            },
          ])
        );
        return;
      }
      if (req.url === "/v1/live/sanyegong_creek/pending") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify([]));
        return;
      }
      if (req.url === "/v1/live/sanyegong_creek/events") {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify([
            {
              t: "2026-11-23 01:47:29",
              kind: "ingest_committed",
              upload_id: "up-9243accb1be9",
              seq: 1,
            },
          ])
        );
        return;
      }
      if (req.url === "/v1/live/sheep_barn/status") {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end("<html><body>upstream down</body></html>");
        return;
      }
      if (req.url === "/v1/live/sheep_barn/forecast") {
        res.setHeader("Content-Type", "application/json");
        res.end("<html>not json</html>");
        return;
      }
      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ detail: "not found" }));
    },
    async (engineUrl) => {
      await withServer(
        { engineBaseUrl: engineUrl, engineApiKey: "k1", geminiBundle: null },
        async (base) => {
          const verRes = await fetch(`${base}/api/live/sanyegong_creek/versions`);
          assert.equal(verRes.status, 200);
          const verJson = (await verRes.json()) as unknown[];
          assert.equal(Array.isArray(verJson), true);
          assert.equal((verJson[0] as { seq: number }).seq, 1);

          const penRes = await fetch(`${base}/api/live/sanyegong_creek/pending`);
          assert.equal(penRes.status, 200);
          assert.deepEqual(await penRes.json(), []);

          const evRes = await fetch(`${base}/api/live/sanyegong_creek/events`);
          assert.equal(evRes.status, 200);
          const evJson = (await evRes.json()) as unknown[];
          assert.equal(Array.isArray(evJson), true);
          assert.equal((evJson[0] as { kind: string }).kind, "ingest_committed");

          const htmlRes = await fetch(`${base}/api/live/sheep_barn/status`);
          assert.equal(htmlRes.status, 503);
          assert.deepEqual(await htmlRes.json(), {
            detail: "尚未連線到 Python 引擎，即時預測不可用",
          });

          const badJsonRes = await fetch(`${base}/api/live/sheep_barn/forecast`);
          assert.equal(badJsonRes.status, 502);
          assert.deepEqual(await badJsonRes.json(), {
            detail: "引擎回應格式不符",
          });
        }
      );
    }
  );
});

test("FastAPI 422 陣列 detail 正規化：/api/forecast、/api/formal/sheep-thi、/api/live/* 皆將 msg 以全形分號串接並保留去敏", async () => {
  const adminHash = makeHash("norm-pass-123", 100_000);
  const apiKey = "norm-api-secret";
  await withMockEngine(
    (req, _body, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/v1/forecast" || req.url === "/v1/formal/sheep-thi") {
        res.statusCode = 422;
        res.end(
          JSON.stringify({
            detail: [
              { loc: ["body", "origin"], msg: "起點時間格式錯誤", type: "value_error" },
              { loc: ["body", "horizon_h"], msg: "預測時距必須大於 0", type: "greater_than" },
            ],
          })
        );
        return;
      }
      if (req.url === "/v1/live/sheep_barn/status") {
        res.statusCode = 422;
        res.end(
          JSON.stringify({
            detail: [{ loc: ["query", "x"], msg: `參數無效 ${apiKey}`, type: "value_error" }],
          })
        );
        return;
      }
      if (req.url === "/v1/live/sheep_barn/rollback") {
        res.statusCode = 422;
        res.end(
          JSON.stringify({
            detail: [
              { loc: ["body", "reason"], msg: "回復原因需至少 6 個字", type: "string_too_short" },
              { loc: ["body", "to_version"], msg: "目標版本不可為空", type: "value_error" },
            ],
          })
        );
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ detail: "Not found" }));
    },
    async (engineUrl) => {
      await withServer(
        {
          adminHash,
          engineBaseUrl: engineUrl,
          engineApiKey: apiKey,
          geminiBundle: null,
        },
        async (base) => {
          // 1. /api/forecast
          const fcRes = await fetch(`${base}/api/forecast`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              dataset_id: "sheep_barn",
              sensor: "成羊區THI",
              horizon_h: 1,
              origin: "bad-date",
            }),
          });
          assert.equal(fcRes.status, 422);
          assert.deepEqual(await fcRes.json(), {
            detail: "起點時間格式錯誤；預測時距必須大於 0",
          });

          // 2. /api/formal/sheep-thi
          const thiRes = await fetch(`${base}/api/formal/sheep-thi`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          });
          assert.equal(thiRes.status, 422);
          assert.deepEqual(await thiRes.json(), {
            detail: "起點時間格式錯誤；預測時距必須大於 0",
          });

          // 3. /api/live/:id/status (GET) + secret sanitization
          const liveGetRes = await fetch(`${base}/api/live/sheep_barn/status`);
          assert.equal(liveGetRes.status, 422);
          const liveGetBody = (await liveGetRes.json()) as { detail: string };
          assert.equal(liveGetBody.detail.includes(apiKey), false);
          assert.equal(liveGetBody.detail, "參數無效 [REDACTED]");

          // 4. /api/live/:id/rollback (POST)
          const loginRes = await fetch(`${base}/api/admin/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ passphrase: "norm-pass-123" }),
          });
          const cookie = (loginRes.headers.get("set-cookie") || "").split(";")[0];
          const livePostRes = await fetch(`${base}/api/live/sheep_barn/rollback`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Cookie: cookie },
            body: JSON.stringify({ to_version: "", reason: "a" }),
          });
          assert.equal(livePostRes.status, 422);
          assert.deepEqual(await livePostRes.json(), {
            detail: "回復原因需至少 6 個字；目標版本不可為空",
          });
        }
      );
    }
  );
});

test("引擎憑證被拒：health 轉為離線、代理回 502 通用訊息、不洩漏金鑰", async () => {
  const adminHash = makeHash("cred-pass-123", 100_000);
  const apiKey = "wrong-engine-api-key-999";
  const adminKey = "wrong-engine-admin-key-888";
  let datasetsProbeCount = 0;

  await withMockEngine(
    (req, _body, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/health") {
        res.end(
          JSON.stringify({
            ok: true,
            version: "aistudio-1.0.0",
            read_only: true,
            live_engine_connected: true,
            live_writes_enabled: true,
            live_sim_enabled: true,
          })
        );
        return;
      }
      if (req.url === "/v1/datasets") {
        datasetsProbeCount += 1;
        res.statusCode = 401;
        res.end(JSON.stringify({ detail: "缺少或錯誤的 X-API-Key" }));
        return;
      }
      if (req.url === "/v1/live/sheep_barn/sim/tick") {
        res.statusCode = 403;
        res.end(JSON.stringify({ detail: "缺少或錯誤的 X-Admin-Key" }));
        return;
      }
      res.statusCode = 401;
      res.end(JSON.stringify({ detail: "缺少或錯誤的 X-API-Key" }));
    },
    async (engineUrl) => {
      await withServer(
        {
          adminHash,
          engineBaseUrl: engineUrl,
          engineApiKey: apiKey,
          engineAdminKey: adminKey,
          geminiBundle: null,
        },
        async (base) => {
          // 1. /api/health turns offline when /v1/datasets rejects credentials, and caches for 15s
          const h1Res = await fetch(`${base}/api/health`);
          assert.equal(h1Res.status, 200);
          const h1Text = await h1Res.text();
          const h1 = JSON.parse(h1Text) as Record<string, unknown>;
          assert.equal(h1.engine_connected, false);
          assert.equal(h1.live_engine_connected, false);
          assert.equal(h1.live_writes_enabled, false);
          assert.ok(String(h1.warning_message ?? "").includes("拒絕"));
          assert.equal(h1Text.includes(apiKey), false);
          assert.equal(h1Text.includes(adminKey), false);
          assert.equal(h1Text.includes(engineUrl), false);

          const h2Res = await fetch(`${base}/api/health`);
          assert.equal(h2Res.status, 200);
          const h2 = (await h2Res.json()) as Record<string, unknown>;
          assert.equal(h2.engine_connected, false);
          assert.equal(datasetsProbeCount, 1);

          // 2. Proxy read & forecast routes return 502 with generic detail and without X-API-Key
          for (const check of [
            () => fetch(`${base}/api/live/sheep_barn/status`),
            () => fetch(`${base}/api/live/domains`),
            () =>
              fetch(`${base}/api/forecast`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  dataset_id: "sheep_barn",
                  sensor: "成羊區THI",
                  horizon_h: 1,
                  origin: "2026-08-13 14:00:00",
                }),
              }),
            () =>
              fetch(`${base}/api/formal/sheep-thi`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({}),
              }),
          ]) {
            const res = await check();
            assert.equal(res.status, 502);
            const rawText = await res.text();
            assert.equal(rawText.includes("X-API-Key"), false);
            assert.deepEqual(JSON.parse(rawText), {
              detail: "引擎憑證設定有誤，請聯絡系統管理者",
            });
          }

          // 3. Non-admin calling write endpoint STILL returns Node's own 403
          const unauthRes = await fetch(`${base}/api/live/sheep_barn/sim/tick`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ scenario: "normal" }),
          });
          assert.equal(unauthRes.status, 403);
          assert.deepEqual(await unauthRes.json(), {
            detail: "僅限管理者操作，請先完成管理者驗證",
          });

          // 4. Admin calling write endpoint when engine returns 403 -> Node returns 502 generic message
          const loginRes = await fetch(`${base}/api/admin/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ passphrase: "cred-pass-123" }),
          });
          assert.equal(loginRes.status, 200);
          const cookie = (loginRes.headers.get("set-cookie") || "").split(";")[0];

          const tickRes = await fetch(`${base}/api/live/sheep_barn/sim/tick`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Cookie: cookie },
            body: JSON.stringify({ scenario: "normal" }),
          });
          assert.equal(tickRes.status, 502);
          const tickText = await tickRes.text();
          assert.equal(tickText.includes("X-Admin-Key"), false);
          assert.deepEqual(JSON.parse(tickText), {
            detail: "引擎憑證設定有誤，請聯絡系統管理者",
          });
        }
      );
    }
  );

  // 5. Regression: mock engine only implements /health and returns 404 on /v1/datasets & 404/422 on routes
  await withMockEngine(
    (req, _body, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/health") {
        res.end(
          JSON.stringify({
            ok: true,
            version: "aistudio-1.0.0",
            read_only: true,
          })
        );
        return;
      }
      if (req.url === "/v1/live/sheep_barn/forecast") {
        res.statusCode = 404;
        res.end(JSON.stringify({ detail: "該場域尚無即時預測輸出" }));
        return;
      }
      if (req.url === "/v1/forecast") {
        res.statusCode = 422;
        res.end(
          JSON.stringify({
            detail: [{ loc: ["body", "origin"], msg: "起點時間格式錯誤", type: "value_error" }],
          })
        );
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ detail: "Not found" }));
    },
    async (engineUrl) => {
      await withServer(
        { engineBaseUrl: engineUrl, engineApiKey: "k", geminiBundle: null },
        async (base) => {
          const hRes = await fetch(`${base}/api/health`);
          assert.equal(hRes.status, 200);
          const hBody = (await hRes.json()) as Record<string, unknown>;
          assert.equal(hBody.engine_connected, true);

          const fc404 = await fetch(`${base}/api/live/sheep_barn/forecast`);
          assert.equal(fc404.status, 404);
          assert.deepEqual(await fc404.json(), { detail: "該場域尚無即時預測輸出" });

          const fc422 = await fetch(`${base}/api/forecast`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              dataset_id: "sheep_barn",
              sensor: "成羊區THI",
              horizon_h: 1,
              origin: "bad",
            }),
          });
          assert.equal(fc422.status, 422);
          assert.deepEqual(await fc422.json(), { detail: "起點時間格式錯誤" });
        }
      );
    }
  );
});




// ---------------- 管理者：展示預設帳號、管理狀態、F12 ----------------
async function loginAs(base: string, body: Record<string, unknown>) {
  const res = await fetch(`${base}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const cookie = (res.headers.get("set-cookie") || "").split(";")[0];
  return { res, cookie, json: (await res.json()) as Record<string, unknown> };
}

test("展示預設帳號：/admin/role 提供公開提示；登入後是展示管理者；可看管理狀態（只有布林值）；寫入一律 403 且引擎完全沒收到請求", async () => {
  const seen: string[] = [];
  await withMockEngine(
    (req, _b, res) => {
      seen.push(`${req.method} ${req.url}`);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    },
    async (engineUrl) => {
      await withServer(
        { engineBaseUrl: engineUrl, engineApiKey: "k-read-123", engineAdminKey: "k-admin-456", geminiBundle: null, adminDemoEnabled: true },
        async (base) => {
          const role = (await (await fetch(`${base}/api/admin/role`)).json()) as {
            configured: boolean; role: string; demo_available: boolean; demo_hint?: { account: string; password: string };
          };
          assert.equal(role.configured, false);
          assert.equal(role.demo_available, true);
          assert.equal(role.demo_hint?.account, "demo");
          assert.equal(role.role, "viewer");

          // 沒登入：管理狀態 403
          assert.equal((await fetch(`${base}/api/admin/status`)).status, 403);

          // 錯誤密碼 401
          assert.equal((await loginAs(base, { account: "demo", passphrase: "nope" })).res.status, 401);

          const ok = await loginAs(base, { account: "demo", passphrase: "aide-demo" });
          assert.equal(ok.res.status, 200);
          assert.equal(ok.json.role, "demo_admin");
          const headers = { Cookie: ok.cookie, "Content-Type": "application/json" };

          const st = await fetch(`${base}/api/admin/status`, { headers });
          assert.equal(st.status, 200);
          const stText = await st.text();
          const stat = JSON.parse(stText) as Record<string, unknown>;
          assert.equal(stat.role, "demo_admin");
          assert.equal(stat.engine_admin_key_configured, true);
          assert.equal(stat.can_write_engine, false);
          assert.equal(stat.demo_account_active, true);
          // 絕不洩漏任何值
          for (const secret of ["k-read-123", "k-admin-456", engineUrl, "aide-demo"]) assert.equal(stText.includes(secret), false, secret);

          // 展示管理者不能寫入：五個寫入端點都 403，引擎沒收到任何東西
          for (const action of ["ingest", "commit", "rollback", "recompute", "sim/tick"]) {
            const w = await fetch(`${base}/api/live/sheep_barn/${action}`, { method: "POST", headers, body: "{}" });
            assert.equal(w.status, 403, action);
            const j = (await w.json()) as { detail: string };
            assert.ok(j.detail.includes("展示管理者不能寫入引擎"));
          }
          assert.equal(seen.filter((s) => s.startsWith("POST")).length, 0);

          // 登出後回到 viewer
          await fetch(`${base}/api/admin/logout`, { method: "POST", headers });
          assert.equal(((await (await fetch(`${base}/api/admin/role`, { headers })).json()) as { role: string }).role, "viewer");
        }
      );
    }
  );
});

test("設定正式管理者後，展示預設帳號停用且不再提示；正式帳號名稱必須相符；關閉開關也停用", async () => {
  const adminHash = makeHash("real-pass-xyz-123", 100_000);
  await withServer({ engineBaseUrl: "", geminiBundle: null, adminHash, adminAccount: "boss", adminDemoEnabled: true }, async (base) => {
    const role = (await (await fetch(`${base}/api/admin/role`)).json()) as { configured: boolean; demo_available: boolean; demo_hint?: unknown };
    assert.equal(role.configured, true);
    assert.equal(role.demo_available, false);
    assert.equal(role.demo_hint, undefined);
    assert.equal((await loginAs(base, { account: "demo", passphrase: "aide-demo" })).res.status, 401);
    assert.equal((await loginAs(base, { account: "admin", passphrase: "real-pass-xyz-123" })).res.status, 401); // 帳號不是 boss
    const ok = await loginAs(base, { account: "boss", passphrase: "real-pass-xyz-123" });
    assert.equal(ok.res.status, 200);
    assert.equal(ok.json.role, "admin");
    const st = (await (await fetch(`${base}/api/admin/status`, { headers: { Cookie: ok.cookie } })).json()) as Record<string, unknown>;
    assert.equal(st.can_write_engine, true);
    assert.equal(st.demo_account_active, false);
    assert.equal(st.real_account_name, "boss");
  });
  await withServer({ engineBaseUrl: "", geminiBundle: null, adminDemoEnabled: false }, async (base) => {
    const role = (await (await fetch(`${base}/api/admin/role`)).json()) as { demo_available: boolean };
    assert.equal(role.demo_available, false);
    assert.equal((await loginAs(base, { account: "demo", passphrase: "aide-demo" })).res.status, 403);
  });
});

test("F12：引擎因沒有管理金鑰而停用寫入（403 寫入功能停用）→ 管理者看到「唯讀展示」403，而不是 502 憑證錯誤；其他 403 仍是 502", async () => {
  const adminHash = makeHash("f12-pass-123456", 100_000);
  let mode: "readonly" | "badkey" = "readonly";
  await withMockEngine(
    (_req, _b, res) => {
      res.setHeader("Content-Type", "application/json");
      res.statusCode = 403;
      res.end(JSON.stringify({ detail: mode === "readonly" ? "管理金鑰未設定（AIDE_ADMIN_KEY）：寫入功能停用" : "缺少或錯誤的 X-Admin-Key" }));
    },
    async (engineUrl) => {
      await withServer({ adminHash, engineBaseUrl: engineUrl, engineApiKey: "k1", engineAdminKey: "k2", geminiBundle: null }, async (base) => {
        const ok = await loginAs(base, { passphrase: "f12-pass-123456" });
        const headers = { Cookie: ok.cookie, "Content-Type": "application/json" };
        const r1 = await fetch(`${base}/api/live/sheep_barn/sim/tick`, { method: "POST", headers, body: "{}" });
        assert.equal(r1.status, 403);
        const t1 = await r1.text();
        assert.ok(t1.includes("此部署為唯讀展示"));
        assert.equal(t1.includes("憑證"), false);
        mode = "badkey";
        const r2 = await fetch(`${base}/api/live/sheep_barn/sim/tick`, { method: "POST", headers, body: "{}" });
        assert.equal(r2.status, 502);
        assert.ok((await r2.text()).includes("引擎憑證設定有誤"));
      });
    }
  );
});
