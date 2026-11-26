// node --experimental-strip-types --test reference/adminAuth.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { AdminGate, makeHash, verifyHash } from "./adminAuth.ts";

// 已知答案（known-answer）：這個值由 Python 的 p62_access.make_hash 產生（測試專用密碼，不是任何真實密碼），用來證明 Node 與 Python 雜湊格式相容。
const KAT = "pbkdf2$200000$00112233445566778899aabbccddeeff$c92193a517f8136746ca412e5c64db71c3b34959d2d9ed39faa7e1171731fa81";

test("與 Python 產生的雜湊相容", () => {
  assert.equal(verifyHash("test-only-passphrase-123", KAT), true);
  assert.equal(verifyHash("test-only-passphrase-124", KAT), false);
});

test("壞格式、空密碼、未設定 → 一律 false", () => {
  for (const bad of [undefined, null, "", "pbkdf2$x$y$z", "md5$1$00$00", "pbkdf2$10$00$00"]) assert.equal(verifyHash("x", bad as string), false);
  assert.equal(verifyHash("", KAT), false);
});

test("makeHash 往返", () => { const h = makeHash("another-long-passphrase"); assert.equal(verifyHash("another-long-passphrase", h), true); assert.equal(verifyHash("nope", h), false); });

test("沒有設定管理者：所有人唯讀（fail closed）", () => {
  const g = new AdminGate(undefined);
  assert.equal(g.login("s1", "anything").ok, false);
  assert.equal(g.role("s1"), "viewer");
});

test("解鎖、錯誤計數與 5 次鎖定；鎖定後連正確密碼都不行", () => {
  const g = new AdminGate(KAT);
  for (let i = 1; i <= 4; i++) { const r = g.login("s1", "wrong"); assert.equal(r.ok, false); assert.equal(r.remaining, 5 - i); }
  const r5 = g.login("s1", "wrong");
  assert.equal(r5.locked, true);
  assert.equal(g.login("s1", "test-only-passphrase-123").ok, false);
  assert.equal(g.role("s1"), "viewer");
  assert.equal(g.login("s2", "test-only-passphrase-123").ok, true);   // 其他連線不受影響
  assert.equal(g.role("s2"), "admin");
  g.logout("s2");
  assert.equal(g.role("s2"), "viewer");
});

// ---- 展示預設帳號（公開值；只能是 demo_admin，永遠不能是 admin）
import { DEMO_ACCOUNT, DEMO_PASSWORD } from "./adminAuth.ts";

test("展示預設帳號：沒有正式管理者且啟用時可登入，角色是 demo_admin（不是 admin）", () => {
  const g = new AdminGate(undefined, 5, { demoEnabled: true });
  assert.equal(g.configured(), false);
  assert.equal(g.demoAvailable(), true);
  const r = g.login("s1", DEMO_PASSWORD, DEMO_ACCOUNT);
  assert.equal(r.ok, true);
  assert.equal(r.role, "demo_admin");
  assert.equal(g.role("s1"), "demo_admin");
  // 舊版只輸入密碼也相容
  assert.equal(g.login("s2", DEMO_PASSWORD).role, "demo_admin");
  g.logout("s1");
  assert.equal(g.role("s1"), "viewer");
});

test("展示預設帳號：帳號或密碼錯、5 次鎖定；沒有啟用時完全不可用", () => {
  const g = new AdminGate(undefined, 5, { demoEnabled: true });
  assert.equal(g.login("a", "wrong", DEMO_ACCOUNT).ok, false);
  assert.equal(g.login("a", DEMO_PASSWORD, "someone-else").ok, false);
  for (let i = 0; i < 3; i++) g.login("a", "wrong", DEMO_ACCOUNT);
  assert.equal(g.login("a", DEMO_PASSWORD, DEMO_ACCOUNT).locked, true);
  const off = new AdminGate(undefined, 5, { demoEnabled: false });
  assert.equal(off.demoAvailable(), false);
  assert.equal(off.login("b", DEMO_PASSWORD, DEMO_ACCOUNT).ok, false);
  assert.equal(off.role("b"), "viewer");
});

test("一旦設定正式管理者，展示預設帳號自動停用；正式帳號可自訂名稱且必須相符", () => {
  const g = new AdminGate(KAT, 5, { demoEnabled: true, account: "Boss" });
  assert.equal(g.demoAvailable(), false);
  assert.equal(g.login("c", DEMO_PASSWORD, DEMO_ACCOUNT).ok, false);
  assert.equal(g.login("c", "test-only-passphrase-123", "demo").ok, false);   // 密碼對、帳號錯
  assert.equal(g.login("d", "test-only-passphrase-123", " boss ").role, "admin"); // 不分大小寫、去空白
  assert.equal(g.login("e", "test-only-passphrase-123").role, "admin");        // 省略帳號相容舊版
});

// ---- 員工角色與權限表
import { DEMO_STAFF_ACCOUNT, DEMO_STAFF_PASSWORD } from "./adminAuth.ts";
import { can } from "../contracts/permissions.ts";

test("展示員工帳號：沒有任何正式帳號時可登入，角色是 staff；admin 與 staff 互不冒用", () => {
  const g = new AdminGate(undefined, 5, { demoEnabled: true });
  const r = g.login("s", DEMO_STAFF_PASSWORD, DEMO_STAFF_ACCOUNT);
  assert.equal(r.role, "staff");
  assert.equal(g.login("t", DEMO_STAFF_PASSWORD, DEMO_ACCOUNT).ok, false); // 帳號與密碼配錯
  assert.equal(g.login("u", DEMO_PASSWORD, DEMO_STAFF_ACCOUNT).ok, false);
  assert.equal(g.login("v", DEMO_STAFF_PASSWORD).role, "staff"); // 只輸入密碼也可
});

test("正式員工：設定 STAFF 雜湊後，展示帳號全部停用；員工不能變成管理員", () => {
  const staffHash = makeHash("staff-long-passphrase-1");
  const g = new AdminGate(undefined, 5, { demoEnabled: true, staffHash });
  assert.equal(g.demoAvailable(), false);
  assert.equal(g.login("a", DEMO_STAFF_PASSWORD, DEMO_STAFF_ACCOUNT).ok, false);
  assert.equal(g.login("b", DEMO_PASSWORD, DEMO_ACCOUNT).ok, false);
  const r = g.login("c", "staff-long-passphrase-1", "STAFF");
  assert.equal(r.role, "staff");
  assert.equal(g.role("c"), "staff");

  const both = new AdminGate(KAT, 5, { demoEnabled: true, staffHash, staffAccount: "worker" });
  assert.equal(both.login("d", "staff-long-passphrase-1", "worker").role, "staff");
  assert.equal(both.login("e", "staff-long-passphrase-1", "admin").ok, false); // 員工密碼不能登入管理員帳號
  assert.equal(both.login("f", "test-only-passphrase-123", "admin").role, "admin");
});

test("權限表：訪客只能看；員工可匯入與記錄；門檻與管理狀態屬於管理員；只有正式管理員能寫入引擎", () => {
  assert.equal(can("viewer", "import_data"), false);
  assert.equal(can("viewer", "record_decision"), false);
  assert.equal(can("staff", "import_data"), true);
  assert.equal(can("staff", "record_decision"), true);
  assert.equal(can("staff", "edit_thresholds"), false);
  assert.equal(can("staff", "view_admin_status"), false);
  assert.equal(can("staff", "engine_write"), false);
  assert.equal(can("demo_admin", "edit_thresholds"), true);
  assert.equal(can("demo_admin", "engine_write"), false);
  assert.equal(can("admin", "engine_write"), true);
});
