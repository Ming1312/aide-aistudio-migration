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
