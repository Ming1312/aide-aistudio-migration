import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  LiveEventItem,
  LiveForecastResponse,
  LivePendingItem,
  LiveStatusResponse,
  LiveVersionEntry,
} from "../../contracts/types";
import {
  buildLiveSensorChartSeries,
  formatApplicabilityStatus,
  formatLiveDecisionZh,
  getDefaultRollbackTarget,
  getFreshnessDisplay,
  getLiveBannerKind,
  groupLiveTasksBySensor,
  isLiveDataSynthetic,
  LIVE_FORMAT_ERROR_MESSAGE,
  LIVE_OFFLINE_MESSAGE,
  LiveFormatError,
  LiveOfflineError,
  orderEventsNewestFirst,
  selectRecentVersionsNewestFirst,
  shouldRefetchForecastOnPoll,
  validateLiveEventsResponse,
  validateLiveForecastResponse,
  validateLivePendingResponse,
  validateLiveStatusResponse,
  validateLiveVersionsResponse,
} from "./liveForecast";
import {
  fetchLiveDomains,
  fetchLiveEvents,
  fetchLiveForecast,
  fetchLiveMonitor,
  fetchLivePending,
  fetchLiveStatus,
  fetchLiveVersions,
} from "./dataLoader";
import {
  adaptLiveDomains,
  adaptLiveForecast,
  adaptLiveMonitor,
  adaptLiveStatus,
} from "./liveAdapter";
import {
  validateLiveDomainsResponse,
  validateLiveMonitorResponse,
} from "./liveForecast";
import { LiveForecastPage } from "../pages/LiveForecastPage";
import { PageErrorBoundary } from "../components/PageErrorBoundary";

const baseStatus: LiveStatusResponse = {
  dataset_id: "sanyegong_creek",
  data_end: "2026-05-01 06:00:00",
  mode: "sim",
  is_stale: false,
  stale_after_h: 3,
  current_version: "三爺宮溪-v0012-98bc51164927",
  latest_source: "real",
  contains_synthetic: false,
  forecast_matches_version: true,
  forecast_data_version: "三爺宮溪-v0012-98bc51164927",
  issued_at: "2026-11-23 01:47:29",
  n_tasks: 2,
  flags: [],
};

function makeRealVersionFixture(seq: number, isCurrent = false): LiveVersionEntry {
  const num = String(seq).padStart(4, "0");
  return {
    seq,
    version_id: `三爺宮溪-v${num}-98bc51164927`,
    created_at: `2026-11-23 01:${String(seq).padStart(2, "0")}:29.402949`,
    rows_added: 6,
    source: "synthetic",
    approved_by: "sim-feed",
    time_range: ["2026-05-01 01:00:00", "2026-05-01 06:00:00"],
    synthetic_marked: true,
    is_current: isCurrent,
  };
}

const realEventsFixture: LiveEventItem[] = [
  {
    t: "2026-11-23 01:47:29",
    kind: "ingest_committed",
    upload_id: "up-9243accb1be9",
    seq: 1,
  },
  {
    t: "2026-11-23 01:48:29",
    kind: "recompute_done",
    upload_id: "up-9243accb1be9",
    seq: 2,
  },
];

const realPendingFixture: LivePendingItem[] = [
  {
    upload_id: "up-pending-01",
    status: "quarantined",
    n_block: 1,
    n_warn: 2,
    filename: "sanyegong_batch.csv",
    staged_at: "2026-11-23 01:50:00",
    blocks: ["缺值比例超過允許上限"],
  },
];

test("isLiveDataSynthetic 與 getLiveBannerKind：latest_source=synthetic 或 contains_synthetic=true 一律判為合成橫幅", () => {
  assert.equal(getLiveBannerKind(baseStatus, null), "real");
  assert.equal(getLiveBannerKind(null, null), "offline");

  const synthStatus: LiveStatusResponse = {
    ...baseStatus,
    latest_source: "synthetic",
  };
  assert.equal(isLiveDataSynthetic(synthStatus, null), true);
  assert.equal(getLiveBannerKind(synthStatus, null), "synthetic");

  const realStatusWithSynthForecast: LiveForecastResponse = {
    dataset_id: "sanyegong_creek",
    data_version: "v5",
    issued_at: "2026-11-23 01:47:29",
    contains_synthetic: true,
    tasks: [],
  };
  assert.equal(
    isLiveDataSynthetic(baseStatus, realStatusWithSynthForecast),
    true
  );
  assert.equal(
    getLiveBannerKind(baseStatus, realStatusWithSynthForecast),
    "synthetic"
  );
});

test("getFreshnessDisplay：資料新鮮／過舊判斷與『監測設定，不是門檻』文字", () => {
  const fresh = getFreshnessDisplay({ is_stale: false, stale_after_h: 4 });
  assert.equal(fresh.badgeLabel, "新鮮");
  assert.equal(fresh.warningText, null);
  assert.ok(fresh.settingText.includes("監測設定，不是門檻"));

  const stale = getFreshnessDisplay({ is_stale: true, stale_after_h: 6 });
  assert.equal(stale.badgeLabel, "資料過舊");
  assert.equal(stale.warningText, "預測可能已不代表現況");
  assert.ok(stale.settingText.includes("6 小時"));
  assert.ok(stale.settingText.includes("監測設定，不是門檻"));
});

test("formatLiveDecisionZh 與 formatApplicabilityStatus：完整對應引擎決策與適用性狀態", () => {
  assert.equal(formatLiveDecisionZh("COMMITTED"), "已提交");
  assert.equal(formatLiveDecisionZh("NO_NEW_DATA"), "沒有新資料");
  assert.equal(formatLiveDecisionZh("KEPT_EXISTING"), "保留既有資料未寫入");
  assert.equal(formatLiveDecisionZh("BLOCKED"), "被拒絕");
  assert.equal(formatLiveDecisionZh("QUARANTINED"), "留待人工核准");

  assert.equal(formatApplicabilityStatus("usable").label, "可用");
  assert.equal(formatApplicabilityStatus("caution").label, "需留意");
  assert.equal(formatApplicabilityStatus("not_applicable").label, "不適用");
});

test("groupLiveTasksBySensor 與 buildLiveSensorChartSeries：依感測器分組並排序 +1/+3/+6 時距", () => {
  const grouped = groupLiveTasksBySensor([
    {
      task_id: "t6",
      sensor: "成羊區THI",
      horizon_h: 6,
      unit: "指數",
      target_timestamp: "2026-08-13 20:00:00",
      models: { persistence: { value: 81.2, refused: null } },
    },
    {
      task_id: "t1",
      sensor: "成羊區THI",
      horizon_h: 1,
      unit: "指數",
      target_timestamp: "2026-08-13 15:00:00",
      models: { persistence: { value: 82.0, refused: null }, XGB: { value: null, refused: "最近缺值過多" } },
    },
    {
      task_id: "nh3_1",
      sensor: "ID4-NH3",
      horizon_h: 1,
      unit: "ppm",
      target_timestamp: "2026-08-13 15:00:00",
      models: { HGB: { value: 4.5, refused: null } },
    },
  ]);

  assert.equal(grouped.length, 2);
  assert.equal(grouped[0].sensor, "成羊區THI");
  assert.deepEqual(grouped[0].tasks.map((t) => t.horizon_h), [1, 6]);
  assert.equal(grouped[1].sensor, "ID4-NH3");

  const pts = buildLiveSensorChartSeries(grouped[0].tasks, [
    { time: "2026-08-13 13:00:00", value: 81.5 },
    { time: "2026-08-13 14:00:00", value: 82.0 },
  ]);
  assert.equal(pts.length, 4);
  assert.equal(pts[0].historyValue, 81.5);
  assert.equal(pts[2].persistence, 82.0);
  assert.equal(pts[2].XGB, undefined);
  assert.equal(pts[3].persistence, 81.2);
});

test("shouldRefetchForecastOnPoll：僅在 data_version 或 issued_at 變更時重抓預測", () => {
  const fc: LiveForecastResponse = {
    dataset_id: "sanyegong_creek",
    data_version: "三爺宮溪-v0012-98bc51164927",
    issued_at: "2026-11-23 01:47:29",
    contains_synthetic: false,
    tasks: [],
  };

  assert.equal(shouldRefetchForecastOnPoll(baseStatus, baseStatus, fc), false);
  assert.equal(
    shouldRefetchForecastOnPoll(
      baseStatus,
      { ...baseStatus, current_version: "v6", forecast_data_version: "v6" },
      fc
    ),
    true
  );
  assert.equal(
    shouldRefetchForecastOnPoll(
      baseStatus,
      { ...baseStatus, issued_at: "2026-11-23 02:05:00" },
      fc
    ),
    true
  );
});

test("真實陣列形狀：versions 取最後 10 筆新到舊顯示、events 反轉為新到舊、預設回復目前版本前一版、空陣列不報錯", () => {
  const twelveVersions = Array.from({ length: 12 }, (_, idx) =>
    makeRealVersionFixture(idx + 1, idx === 11)
  );
  assert.equal(validateLiveVersionsResponse(twelveVersions).length, 12);
  assert.equal(validateLiveVersionsResponse([]).length, 0);
  assert.equal(validateLivePendingResponse(realPendingFixture).length, 1);
  assert.equal(validateLivePendingResponse([]).length, 0);
  assert.equal(validateLiveEventsResponse(realEventsFixture).length, 2);
  assert.equal(validateLiveEventsResponse([]).length, 0);

  const recent10 = selectRecentVersionsNewestFirst(twelveVersions, 10);
  assert.equal(recent10.length, 10);
  assert.equal(recent10[0].seq, 12);
  assert.equal(recent10[9].seq, 3);
  assert.deepEqual(selectRecentVersionsNewestFirst([], 10), []);

  // Default rollback target: previous version of current
  assert.equal(
    getDefaultRollbackTarget(twelveVersions, "三爺宮溪-v0012-98bc51164927"),
    "三爺宮溪-v0011-98bc51164927"
  );
  assert.equal(
    getDefaultRollbackTarget(twelveVersions, "三爺宮溪-v0005-98bc51164927"),
    "三爺宮溪-v0004-98bc51164927"
  );
  assert.equal(getDefaultRollbackTarget([makeRealVersionFixture(1, true)]), "");
  assert.equal(getDefaultRollbackTarget([]), "");

  const orderedEvents = orderEventsNewestFirst(realEventsFixture);
  assert.equal(orderedEvents[0].seq, 2);
  assert.equal(orderedEvents[1].seq, 1);
});

test("回應格式與 Content-Type 驗證：HTML、物件／陣列互換、null、缺欄位回『引擎回應格式不符』；非 JSON 視為離線", async () => {
  // Shape mismatch cases in pure validators
  assert.throws(
    () => validateLiveVersionsResponse({ versions: [makeRealVersionFixture(1)] }),
    (err: unknown) => err instanceof LiveFormatError && err.message === LIVE_FORMAT_ERROR_MESSAGE
  );
  assert.throws(
    () => validateLivePendingResponse({ pending: [] }),
    (err: unknown) => err instanceof LiveFormatError && err.message === LIVE_FORMAT_ERROR_MESSAGE
  );
  assert.throws(
    () => validateLiveEventsResponse({ events: [] }),
    (err: unknown) => err instanceof LiveFormatError && err.message === LIVE_FORMAT_ERROR_MESSAGE
  );
  assert.throws(
    () => validateLiveStatusResponse([]),
    (err: unknown) => err instanceof LiveFormatError && err.message === LIVE_FORMAT_ERROR_MESSAGE
  );
  assert.throws(
    () => validateLiveStatusResponse(null),
    (err: unknown) => err instanceof LiveFormatError && err.message === LIVE_FORMAT_ERROR_MESSAGE
  );
  assert.throws(
    () => validateLiveStatusResponse({ dataset_id: "sheep_barn" }),
    (err: unknown) => err instanceof LiveFormatError && err.message === LIVE_FORMAT_ERROR_MESSAGE
  );
  assert.throws(
    () => validateLiveForecastResponse("<!doctype html><html></html>"),
    (err: unknown) => err instanceof LiveFormatError && err.message === LIVE_FORMAT_ERROR_MESSAGE
  );

  // fetchLive* tests with mocked global fetch
  const origFetch = globalThis.fetch;
  try {
    // 1. Non-application/json content-type -> treated as offline
    globalThis.fetch = (async () =>
      new Response("<!doctype html><html><body>offline</body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      })) as typeof fetch;

    await assert.rejects(
      () => fetchLiveStatus("sheep_barn"),
      (err: unknown) => err instanceof LiveOfflineError && err.message === LIVE_OFFLINE_MESSAGE
    );

    // 2. application/json with HTML body -> format error
    globalThis.fetch = (async () =>
      new Response("<html>bad gateway</html>", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;

    await assert.rejects(
      () => fetchLiveVersions("sheep_barn"),
      (err: unknown) => err instanceof LiveFormatError && err.message === LIVE_FORMAT_ERROR_MESSAGE
    );

    // 3. application/json returning object instead of array -> format error
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ versions: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;

    await assert.rejects(
      () => fetchLiveVersions("sheep_barn"),
      (err: unknown) => err instanceof LiveFormatError && err.message === LIVE_FORMAT_ERROR_MESSAGE
    );

    // 4. Real array shapes (including empty arrays) succeed without throwing
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.endsWith("/versions")) {
        return new Response(JSON.stringify([makeRealVersionFixture(1, true)]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/pending")) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/events")) {
        return new Response(JSON.stringify(realEventsFixture), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ detail: LIVE_OFFLINE_MESSAGE }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const vers = await fetchLiveVersions("sanyegong_creek");
    assert.equal(vers.length, 1);
    assert.equal(vers[0].version_id, "三爺宮溪-v0001-98bc51164927");
    const pend = await fetchLivePending("sanyegong_creek");
    assert.deepEqual(pend, []);
    const evs = await fetchLiveEvents("sanyegong_creek");
    assert.equal(evs[0].kind, "ingest_committed");

    await assert.rejects(
      () => fetchLiveStatus("sanyegong_creek"),
      (err: unknown) => err instanceof LiveOfflineError && err.message === LIVE_OFFLINE_MESSAGE
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("頁面與 ErrorBoundary 渲染：LiveForecastPage 初始渲染不拋例外；模擬情境文字已更新；ErrorBoundary 隔離單頁錯誤", () => {
  const html = renderToStaticMarkup(
    React.createElement(PageErrorBoundary, {
      pageKey: "live_forecast:sheep_barn:real",
      children: React.createElement(LiveForecastPage, {
        datasets: [
          {
            id: "sheep_barn",
            display_name: "羊舍（成羊區／仔羊區）",
            domain_id: "sheep_barn",
            domain_type: "livestock",
            data_kind: "real",
            file: "sheep_barn.csv",
            time: {
              start: "2026-08-01 00:00:00",
              end: "2026-08-13 14:00:00",
              rows: 100,
              sampling: "hourly",
              expected_hours: 100,
              missing_hours_from_gaps: 0,
              n_gaps: 0,
              longest_gap_hours: 0,
              timezone: "Asia/Taipei",
              timestamp_status: "verified",
            },
            columns: [],
            forecast_tasks: [],
            provenance_ref: "sheep_barn",
          },
        ],
        datasetId: "sheep_barn",
        onSelectDataset: () => undefined,
        health: {
          ok: true,
          engine_connected: true,
          engine_version: "1.0.0",
          read_only: true,
          version_warning: false,
          warning_message: null,
          gemini_configured: false,
          admin_configured: true,
          precomputed_available: true,
          live_sim_enabled: true,
        },
        adminRole: { configured: true, role: "admin" },
        onLiveBannerChange: () => undefined,
      }),
    })
  );
  assert.ok(html.includes("即時預測資料流"));
  assert.ok(html.includes("情境：一般（不注入事件）"));
  assert.equal(html.includes("情境：正常"), false);

  const eb = new PageErrorBoundary({
    pageKey: "live_forecast",
    children: null,
  });
  assert.deepEqual(PageErrorBoundary.getDerivedStateFromError(), { hasError: true });
  eb.state = { hasError: true, retryNonce: 0 };
  const errHtml = renderToStaticMarkup(eb.render() as React.ReactElement);
  assert.ok(errHtml.includes("此頁發生錯誤"));
  assert.ok(errHtml.includes("重新載入"));
});

const realDomainsSample = [
  {
    dataset_id: "sheep_barn",
    current_seq: 5,
    data_end: "2026-08-16 02:00:00",
    latest_source: "synthetic",
    mode: "simulated",
    staleness_h: 0,
    freshness: "fresh",
    forecast: {
      data_version: "羊舍-v0005-8ccb2c1908ab",
      issued_at: "2026-11-23 02:53:08",
      n_ok: 15,
      n_refused: 0,
      n_error: 0,
      up_to_date: true,
    },
    flags: [],
    health: "ok",
  },
];

const realStatusSample = {
  schema: "aide-live-status-v1",
  dataset_id: "sheep_barn",
  stem: "羊舍",
  current_seq: 5,
  version_id: "羊舍-v0005-8ccb2c1908ab",
  n_versions: 5,
  data_end: "2026-08-16 02:00:00",
  rows: 931,
  latest_source: "synthetic",
  mode: "simulated",
  clock: "2026-08-16 02:00:00",
  staleness_h: 0,
  freshness: "fresh",
  stale_after_h: 6,
  forecast: {
    data_version: "羊舍-v0005-8ccb2c1908ab",
    issued_at: "2026-11-23 02:53:08",
    n_ok: 15,
    n_refused: 0,
    n_error: 0,
    up_to_date: true,
  },
  pending_uploads: 0,
  counters: { ingest_count: 5, refused_count: 0, held_count: 0 },
  last_ingest_at: "2026-11-23 02:53:08",
  last_error: null,
  flags: [],
  health: "ok",
  integrity: null,
  live_version: "aide-live-1",
};

const realForecastSample = {
  schema: "aide-live-forecast-v1",
  dataset_id: "sheep_barn",
  data_version: "羊舍-v0005-8ccb2c1908ab",
  seq: 5,
  issued_at: "2026-11-23 02:53:08",
  data_end: "2026-08-16 02:00:00",
  guard: { alerts_ok: true, n_alerts_in_new_data: 0, error: null },
  n_tasks: 15,
  n_ok: 15,
  n_refused: 0,
  n_error: 0,
  disclaimer:
    "研究預測（探索性、未經獨立前瞻驗證）；沒有任何警戒門檻；不控制任何設備。 此預測使用的資料含合成（模擬）列：只是系統流程測試，不是真實預測，更不能當作模型表現的證據。",
  tasks: [
    {
      task_id: "羊舍::ID4-CH4::h1",
      sensor: "ID4-CH4",
      horizon_h: 1,
      origin: "2026-08-16 02:00:00",
      target_time: "2026-08-16 03:00:00",
      data_version: "羊舍-v0005-8ccb2c1908ab",
      models: {
        persistence: { label: "Persistence（持續性）", value: 0.16, refused: null },
        moving_average: { label: "Moving Average（移動平均）", value: 0.16233333333333336, refused: null },
        seasonal_naive_24h: { label: "Seasonal Naive（24 小時季節性）", value: 0.166, refused: null },
        linear_ar4: { label: "Linear AR（線性自迴歸）", value: 0.1679093708970506, refused: null },
        HGB: { label: "HGB（HistGradientBoosting）", value: 0.15988920564819964, refused: null },
        XGB: { label: "XGBoost", value: 0.16186873614788055, refused: null },
      },
      applicability: {
        status: "ok",
        reasons: [
          {
            level: "synthetic",
            category: "synthetic",
            text: "此預測使用的資料含合成（模擬）列：只是系統流程測試，不是真實預測，更不能當作模型表現的證據。",
          },
        ],
        facts: {
          model_trained_through: "2026-07-30 09:00:00",
          data_version: "羊舍-v0005-8ccb2c1908ab",
          staleness_days: 16.7,
        },
      },
      last_observation: { time: "2026-08-16 02:00:00", value: 0.16 },
      contains_synthetic: true,
      synthetic_banner:
        "此預測使用的資料含合成（模擬）列：只是系統流程測試，不是真實預測，更不能當作模型表現的證據。",
      artifact_sha256: "2e70014d01c0f2e291b94659432c3a202856a8d042b39e1291985535ce78ff72",
      model_version: 0,
      research_status: "Research Candidate｜Validation Pending（探索性；未經獨立驗證）",
      claims: "這裡不宣稱任何準確度：追加資料不是獨立驗證集，且模型從未在這段資料上被驗證過。",
      history: {
        times: ["2026-08-16 01:00:00", "2026-08-16 02:00:00"],
        values: [0.17, 0.16],
      },
    },
  ],
};

const realMonitorSample = {
  dataset_id: "sheep_barn",
  n_matured: 60,
  n_pending: 15,
  note: "只是『流程是否持續正常運作』的監測。資料含合成（模擬）列時，這些誤差不是模型效能證據，也不能用來宣稱任何模型較好。",
  tasks: [
    {
      task_id: "羊舍::ID4-CH4::h1",
      sensor: "ID4-CH4",
      horizon_h: 1,
      n_matured: 4,
      n_synthetic: 4,
      mae: {
        persistence: 0.0072499999999999995,
        moving_average: 0.0017083333333333395,
        seasonal_naive_24h: 0.005249999999999991,
        linear_ar4: 0.002243196043915187,
        HGB: 0.005411568285582688,
        XGB: 0.0057202415466308595,
      },
      rel_to_persistence: {
        moving_average: 0.7643678160919531,
        seasonal_naive_24h: 0.27586206896551846,
        linear_ar4: 0.6905936491151466,
        HGB: 0.25357678819549123,
        XGB: 0.2110011659819504,
      },
    },
  ],
};

test("liveAdapter 真實引擎樣本轉接與驗證：domains／status／forecast／monitor 全部通過且填入前端所需欄位", () => {
  const domains = validateLiveDomainsResponse(adaptLiveDomains(realDomainsSample));
  assert.equal(domains.domains.length, 1);
  assert.equal(domains.domains[0].dataset_id, "sheep_barn");
  assert.equal(domains.domains[0].current_version, "v0005");
  assert.equal(domains.domains[0].is_stale, false);
  assert.equal(domains.domains[0].n_tasks, 15);

  const status = validateLiveStatusResponse(adaptLiveStatus(realStatusSample));
  assert.equal(status.dataset_id, "sheep_barn");
  assert.equal(status.is_stale, false);
  assert.equal(status.mode, "sim");
  assert.equal(status.current_version, "羊舍-v0005-8ccb2c1908ab");
  assert.equal(status.contains_synthetic, true);
  assert.equal(status.forecast_matches_version, true);
  assert.equal(status.n_tasks, 15);
  assert.equal((status.health as { detail: string }).detail, "沒有旗標");

  // 含只有 task_id + refused、沒有 models 的任務時也必須能順利通過驗證
  const forecastWithRefusedTask = {
    ...realForecastSample,
    tasks: [
      ...realForecastSample.tasks,
      {
        task_id: "羊舍::ID4-NH3::h6",
        refused: "歷史資料缺口過長，暫不輸出預測",
      },
    ],
  };
  const forecast = validateLiveForecastResponse(
    adaptLiveForecast(forecastWithRefusedTask)
  );
  assert.equal(forecast.dataset_id, "sheep_barn");
  assert.equal(forecast.contains_synthetic, true);
  assert.equal(forecast.tasks.length, 1);
  assert.equal(forecast.tasks[0].target_timestamp, "2026-08-16 03:00:00");
  assert.deepEqual(forecast.tasks[0].history, [
    { time: "2026-08-16 01:00:00", value: 0.17 },
    { time: "2026-08-16 02:00:00", value: 0.16 },
  ]);
  assert.equal(forecast.tasks[0].applicability?.status, "ok");
  assert.ok(forecast.tasks[0].applicability?.reasons?.[0].includes("合成（模擬）列"));

  const series = buildLiveSensorChartSeries(forecast.tasks);
  assert.equal(series.length, 3);
  assert.equal(series[0].historyValue, 0.17);
  assert.equal(series[2].HGB, 0.15988920564819964);

  const monitor = validateLiveMonitorResponse(adaptLiveMonitor(realMonitorSample));
  assert.equal(monitor.n_matured, 60);
  assert.equal(monitor.tasks.length, 1);
  assert.equal(monitor.tasks[0].methods.persistence?.mae, 0.0072499999999999995);
  assert.equal(monitor.tasks[0].methods.persistence?.delta_vs_persistence, 0);
  assert.equal(monitor.tasks[0].methods.HGB?.delta_vs_persistence, 0.25357678819549123);
});

test("liveAdapter 邊界情境：sheep_barn forecast=null、north tasks=[]、status.freshness=stale", async () => {
  // 1. sheep_barn with forecast: null and freshness: "stale"
  const staleNullForecastStatus = validateLiveStatusResponse(
    adaptLiveStatus({
      ...realStatusSample,
      freshness: "stale",
      staleness_h: 9,
      forecast: null,
      flags: ["資料已逾時"],
      health: "warn",
    })
  );
  assert.equal(staleNullForecastStatus.is_stale, true);
  assert.equal(staleNullForecastStatus.current_version, "羊舍-v0005-8ccb2c1908ab");
  assert.equal(staleNullForecastStatus.issued_at, null);
  assert.equal(staleNullForecastStatus.forecast_data_version, null);
  assert.equal(staleNullForecastStatus.n_tasks, 0);
  assert.equal((staleNullForecastStatus.health as { detail: string }).detail, "有旗標需要留意");

  // 2. rearing_plant_1_north with tasks: []
  const northForecast = validateLiveForecastResponse(
    adaptLiveForecast({
      schema: "aide-live-forecast-v1",
      dataset_id: "rearing_plant_1_north",
      data_version: "育成一廠北側-v0001-aaaa",
      issued_at: "2026-11-23 02:53:08",
      guard: { alerts_ok: true, error: null },
      n_tasks: 0,
      disclaimer: "無預測任務",
      tasks: [],
    })
  );
  assert.equal(northForecast.dataset_id, "rearing_plant_1_north");
  assert.equal(northForecast.n_tasks, 0);
  assert.deepEqual(northForecast.tasks, []);

  // 3. End-to-end dataLoader fetchLive* accepts raw real Python engine payloads
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.endsWith("/api/live/domains")) {
        return new Response(JSON.stringify(realDomainsSample), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/status")) {
        return new Response(JSON.stringify(realStatusSample), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/forecast")) {
        return new Response(JSON.stringify(realForecastSample), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(realMonitorSample), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const d = await fetchLiveDomains();
    assert.equal(d.domains[0].current_version, "v0005");
    const s = await fetchLiveStatus("sheep_barn");
    assert.equal(s.current_version, "羊舍-v0005-8ccb2c1908ab");
    const f = await fetchLiveForecast("sheep_barn");
    assert.equal(f.tasks[0].target_timestamp, "2026-08-16 03:00:00");
    const m = await fetchLiveMonitor("sheep_barn");
    assert.equal(m.tasks[0].methods.XGB?.mae, 0.0057202415466308595);
  } finally {
    globalThis.fetch = origFetch;
  }
});
