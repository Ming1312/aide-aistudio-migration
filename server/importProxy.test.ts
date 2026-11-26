import { test } from "node:test";
import assert from "node:assert/strict";
import { checkImportUrl, fetchImportText, parseExtraHosts, type FetchLike } from "./importProxy.ts";

test("checkImportUrl：只允許 https 與白名單網域，擋下內網／帳密／連接埠", () => {
  assert.equal(checkImportUrl("https://docs.google.com/spreadsheets/d/abc/export?format=csv").ok, true);
  assert.equal(checkImportUrl("https://lh3.googleusercontent.com/x").ok, true);
  for (const bad of [
    "http://docs.google.com/x",
    "https://127.0.0.1/x",
    "https://localhost/x",
    "https://169.254.169.254/latest/meta-data",
    "https://evil.example.com/docs.google.com",
    "https://docs.google.com.evil.com/x",
    "https://user:pw@docs.google.com/x",
    "https://docs.google.com:8443/x",
    "file:///etc/passwd",
    "not a url",
  ]) {
    assert.equal(checkImportUrl(bad).ok, false, bad);
  }
  assert.equal(checkImportUrl("https://data.example.org/a.csv").ok, false);
  assert.equal(checkImportUrl("https://data.example.org/a.csv", parseExtraHosts("data.example.org, bad host")).ok, true);
});

test("fetchImportText：每一跳轉址都重新檢查；轉到內網會被拒絕", async () => {
  const redirectToInternal: FetchLike = async () =>
    new Response(null, { status: 302, headers: { location: "https://127.0.0.1/secret" } });
  const r = await fetchImportText("https://docs.google.com/spreadsheets/d/a/export?format=csv", [], redirectToInternal);
  assert.equal(r.ok, false);

  let n = 0;
  const okAfterRedirect: FetchLike = async () => {
    n += 1;
    return n === 1
      ? new Response(null, { status: 307, headers: { location: "https://doc-0.googleusercontent.com/x" } })
      : new Response("timestamp,a\n2026-01-01 00:00,1\n", { status: 200 });
  };
  const ok = await fetchImportText("https://docs.google.com/spreadsheets/d/a/export?format=csv", [], okAfterRedirect);
  assert.equal(ok.ok, true);
  if (ok.ok) assert.match(ok.text, /timestamp/);
});

test("fetchImportText：超過 5 MB 與來源錯誤都回報失敗", async () => {
  const big: FetchLike = async () =>
    new Response("x", { status: 200, headers: { "content-length": String(6 * 1024 * 1024) } });
  const r = await fetchImportText("https://docs.google.com/a", [], big);
  assert.equal(r.ok, false);
  const forbidden: FetchLike = async () => new Response("no", { status: 403 });
  const r2 = await fetchImportText("https://docs.google.com/a", [], forbidden);
  assert.equal(r2.ok, false);
});
