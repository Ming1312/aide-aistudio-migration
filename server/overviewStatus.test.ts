import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  computeDomainStatus,
  InvalidWindowHoursError,
  parseWindowHours,
  type OverviewStatusFile,
} from "./overviewStatus.ts";

function loadOverviewFile(): OverviewStatusFile {
  const filePath = path.resolve(
    process.cwd(),
    "public/data/real_public/precomputed/overview_status.json"
  );
  return JSON.parse(readFileSync(filePath, "utf-8")) as OverviewStatusFile;
}

test("computeDomainStatus：0 筆回傳 none_recent、大於 0 筆回傳 has_issue，且欄位完整", () => {
  const file = loadOverviewFile();
  const creek = file.datasets.sanyegong_creek;
  const creek24 = computeDomainStatus(
    { ...creek, dataset_id: "sanyegong_creek" },
    24
  );
  assert.deepEqual(creek24, {
    dataset_id: "sanyegong_creek",
    status: "none_recent",
    window_hours: 24,
    n_events: 0,
    kinds: {},
    columns: [],
    total_events: 3,
    hours_since_last_event: 736,
    data_end: "2026-05-01 00:00:00",
  });

  const sheep = file.datasets.sheep_barn;
  const sheep24 = computeDomainStatus(sheep, 24, "sheep_barn");
  assert.deepEqual(sheep24, {
    dataset_id: "sheep_barn",
    status: "has_issue",
    window_hours: 24,
    n_events: 3,
    kinds: { drift_or_offset: 2, out_of_historical_range: 1 },
    columns: ["ID4-NH3", "ID4-濕度", "成羊區THI"],
    total_events: 5,
    hours_since_last_event: 0,
    data_end: "2026-08-13 14:00:00",
  });
});

test("computeDomainStatus：24／72／168 三種時間範圍在七場域的筆數與狀態符合預期", () => {
  const file = loadOverviewFile();
  const expectedByWindow: Record<number, Record<string, number>> = {
    24: {
      sheep_barn: 3,
      expert_system_c22: 20,
      sanyegong_creek: 0,
      construction_site_cb13505: 0,
      northeast_corner: 6,
      rearing_plant_1: 0,
      rearing_plant_1_north: 11,
    },
    72: {
      sheep_barn: 3,
      expert_system_c22: 20,
      sanyegong_creek: 0,
      construction_site_cb13505: 4,
      northeast_corner: 8,
      rearing_plant_1: 2,
      rearing_plant_1_north: 11,
    },
    168: {
      sheep_barn: 3,
      expert_system_c22: 21,
      sanyegong_creek: 0,
      construction_site_cb13505: 17,
      northeast_corner: 17,
      rearing_plant_1: 11,
      rearing_plant_1_north: 11,
    },
  };

  for (const win of [24, 72, 168] as const) {
    for (const [id, expectedCount] of Object.entries(expectedByWindow[win])) {
      const result = computeDomainStatus(file.datasets[id], win, id);
      assert.equal(result.n_events, expectedCount);
      assert.equal(
        result.status,
        expectedCount > 0 ? "has_issue" : "none_recent"
      );
      assert.equal(result.window_hours, win);
    }
  }
});

test("computeDomainStatus 與 parseWindowHours：非法時間範圍一律拋出 InvalidWindowHoursError (status=400)", () => {
  const file = loadOverviewFile();
  const entry = file.datasets.sheep_barn;

  for (const bad of [0, 12, 48, -24, 24.5, Number.NaN, 360]) {
    assert.throws(
      () => computeDomainStatus(entry, bad, "sheep_barn"),
      (err: unknown) =>
        err instanceof InvalidWindowHoursError && err.status === 400
    );
  }

  assert.equal(parseWindowHours(undefined), 24);
  assert.equal(parseWindowHours(""), 24);
  assert.equal(parseWindowHours("24"), 24);
  assert.equal(parseWindowHours("72"), 72);
  assert.equal(parseWindowHours("168"), 168);

  for (const badQuery of ["12", "48", "24abc", "abc", ["24"], "0"]) {
    assert.throws(
      () => parseWindowHours(badQuery),
      (err: unknown) =>
        err instanceof InvalidWindowHoursError && err.status === 400
    );
  }
});
