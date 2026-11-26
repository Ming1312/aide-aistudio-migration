import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeSheetUrl, resolveSourceUrl } from "./importSources.ts";
import { accumulateImported, buildLiveTask, mergeRows, parseImportedText, toHourly } from "./liveSeries.ts";
import type { RealColumn } from "../../contracts/types.ts";

const cols = [
  { key: "TEMP", raw_header: "場域 - TEMP" },
  { key: "RH", raw_header: "場域 - RH" },
] as unknown as RealColumn[];

test("normalizeSheetUrl：分享網址轉成 CSV 匯出；非 Google 或不認得的回 null", () => {
  assert.equal(
    normalizeSheetUrl("https://docs.google.com/spreadsheets/d/AbC123/edit#gid=456"),
    "https://docs.google.com/spreadsheets/d/AbC123/export?format=csv&gid=456"
  );
  assert.equal(
    normalizeSheetUrl("https://docs.google.com/spreadsheets/d/AbC123/edit?usp=sharing"),
    "https://docs.google.com/spreadsheets/d/AbC123/export?format=csv&gid=0"
  );
  assert.match(
    normalizeSheetUrl("https://docs.google.com/spreadsheets/d/e/2PACX-abc/pub?gid=0&single=true") ?? "",
    /output=csv/
  );
  assert.equal(normalizeSheetUrl("https://example.com/spreadsheets/d/x/edit"), null);
  assert.equal(normalizeSheetUrl("nope"), null);
  assert.equal(resolveSourceUrl("url", "http://example.com/a.csv"), null);
  assert.ok(resolveSourceUrl("url", "https://example.com/a.csv"));
});

test("parseImportedText：欄名對應、時間格式容忍、壞列略過、HTML 回應被辨識", () => {
  const csv = "時間,TEMP,場域 - RH,其他\n2026/11/27 08:00,25.5,60,x\n2026-11-27T09:00:00,26,,y\nbad,1,1,z\n";
  const p = parseImportedText(csv, cols);
  assert.equal(p.rows.length, 2);
  assert.deepEqual(Object.values(p.matched).sort(), ["RH", "TEMP"]);
  assert.deepEqual(p.unmatched, ["其他"]);
  assert.equal(p.rows[0].values.TEMP, 25.5);
  assert.equal(p.rows[1].values.RH, null);
  assert.ok(p.issues.some((i) => i.includes("1 列")));
  const html = parseImportedText("<!DOCTYPE html>\n<html>", cols);
  assert.equal(html.rows.length, 0);
  assert.ok(html.issues[0].includes("網頁"));
});

test("mergeRows／accumulateImported：匯入蓋過同時間；排序；累積不重複", () => {
  const mk = (ts: string, v: number) => ({ timestamp: ts, tsMs: Date.parse(ts.replace(" ", "T")), values: { TEMP: v }, rawCells: [], flagValue: "1" });
  const base = [mk("2026-01-01 00:00:00", 1), mk("2026-01-01 01:00:00", 2)];
  const imp = [mk("2026-01-01 01:00:00", 9), mk("2026-01-01 02:00:00", 3)];
  const m = mergeRows(base, imp);
  assert.deepEqual(m.map((r) => r.values.TEMP), [1, 9, 3]);
  assert.equal(accumulateImported(imp, imp).length, 2);
});

test("buildLiveTask：因果——起點只用已抵達的值；最後起點沒有真值；歷史不足回 null", () => {
  const H = 3_600_000;
  const t0 = Date.parse("2026-01-01T00:00:00");
  const hourly = new Map<number, number>();
  for (let i = 0; i < 100; i++) hourly.set(t0 + i * H, 20 + (i % 24));
  const task = buildLiveTask("x", "TEMP", "°C", 3, hourly)!;
  assert.ok(task);
  const last = task.points[task.points.length - 1];
  assert.equal(last[3], "l");
  assert.equal(last[2], null);
  const mid = task.points[10];
  const origin = Date.parse(String(mid[0]).replace(" ", "T"));
  assert.equal(mid[4], hourly.get(origin));
  assert.equal(mid[2], hourly.get(origin + 3 * H) ?? null);
  const short = new Map([...hourly].slice(0, 10));
  assert.equal(buildLiveTask("x", "TEMP", "°C", 3, short), null);
  assert.equal(toHourly([], "TEMP").size, 0);
});

test("parseImportedText：原始匯出格式（日期＋小時兩欄、表頭帶場域前綴）可直接匯入", () => {
  const north = [
    { key: "風速", raw_header: "育成一廠北側 - 風速" },
    { key: "溫度", raw_header: "育成一廠北側 - 溫度" },
  ] as unknown as RealColumn[];
  const csv = "日期,小時,育成一廠北側 - 風速,育成一廠北側 - 溫度\n2026/06/01,8,1,28.4\n2026/06/01,9,0.4,28.7\n2026/06/02,0,2,27\n2026/06/02,99,2,27\n";
  const p = parseImportedText(csv, north);
  assert.equal(p.rows.length, 3);
  assert.deepEqual(p.rows.map((r) => r.timestamp), ["2026-06-01 08:00:00", "2026-06-01 09:00:00", "2026-06-02 00:00:00"]);
  assert.equal(p.rows[0].values["風速"], 1);
  assert.equal(p.rows[1].values["溫度"], 28.7);
  assert.deepEqual(p.unmatched, []);
  assert.ok(p.issues.some((i) => i.includes("1 列")));
  assert.equal(new Set(p.rows.map((r) => r.tsMs)).size, 3);
});

import { readFileSync } from "node:fs";
import { extractSheetId, parseSheetTabs, sheetCsvUrl } from "../../contracts/sheetTabs.ts";
import { guessDataset } from "./sheetImport.ts";
import type { RealCatalog } from "../../contracts/types.ts";

test("parseSheetTabs／extractSheetId：從 htmlview 取出所有工作表；網址轉換", () => {
  const html =
    'items.push({name: "三爺宮溪", pageUrl: "https:\\/\\/x?gid\\x3d1", gid: "528252282",initialSheet: ("1" == gid)});' +
    'items.push({name: "羊舍", pageUrl: "u", gid: "1758647837",initialSheet: false});items.push({name: "羊舍", pageUrl: "u", gid: "1758647837"});';
  const tabs = parseSheetTabs(html);
  assert.deepEqual(tabs, [{ name: "三爺宮溪", gid: "528252282" }, { name: "羊舍", gid: "1758647837" }]);
  assert.equal(extractSheetId("https://docs.google.com/spreadsheets/d/ExampleSheetId0123456789abcdefgh/edit?gid=1"), "ExampleSheetId0123456789abcdefgh");
  assert.equal(extractSheetId("https://example.com/spreadsheets/d/ExampleSheetId0123456789abcdefgh"), null);
  assert.equal(extractSheetId("not a url"), null);
  assert.equal(sheetCsvUrl("ABC", "12"), "https://docs.google.com/spreadsheets/d/ABC/export?format=csv&gid=12");
});

test("guessDataset：依欄位自動判斷場域（原始表頭完全相同者優先）；對不上回 null", () => {
  const cat = JSON.parse(readFileSync("public/data/real_public/catalog_real.json", "utf-8")) as RealCatalog;
  for (const ds of cat.datasets) {
    const cols = ds.columns.filter((c) => c.n_observed > 0).slice(0, 6);
    const csv = ["日期,小時," + cols.map((c) => c.raw_header).join(","), "2026/06/01,8," + cols.map(() => "1").join(",")].join("\n");
    const g = guessDataset("工作表", csv, cat.datasets);
    assert.equal(g?.datasetId, ds.id, ds.id);
  }
  assert.equal(guessDataset("x", "timestamp,foo,bar\n2026-01-01 00:00,1,2", cat.datasets), null);
});

import { normalizeTimestamp } from "./liveSeries.ts";

test("normalizeTimestamp 與表頭前的說明列：2026/1/1 不補零也能解析；圖例列被略過", () => {
  assert.equal(normalizeTimestamp("2026/1/1 8:5"), "2026-01-01 08:05:00");
  assert.equal(normalizeTimestamp("2026-11-27T09:00:00"), "2026-11-27 09:00:00");
  assert.equal(normalizeTimestamp("2026/6/1"), "2026-06-01 00:00:00");
  const cb = [{ key: "風速", raw_header: "CB13505 - 風速" }, { key: "噪音", raw_header: "CB13505 - 噪音" }] as unknown as RealColumn[];
  const csv = "HH,,,4\nHI,,,3\n日期,小時,CB13505 - 風速,CB13505 - 噪音\n2026/1/1,0,0.8,86.6\n2026/1/1,1,1.4,52.8\n";
  const p = parseImportedText(csv, cb);
  assert.equal(p.rows.length, 2);
  assert.equal(p.rows[0].timestamp, "2026-01-01 00:00:00");
  assert.equal(p.rows[1].values["噪音"], 52.8);
  assert.equal(p.exactMatches, 2);
});
