import { test } from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword, normalizeEmail } from "./auth";

test("accepts the correct password and rejects everything else", async () => {
  const stored = await hashPassword("correct horse battery staple");

  assert.equal(await verifyPassword("correct horse battery staple", stored), true);
  assert.equal(await verifyPassword("Correct horse battery staple", stored), false);
  assert.equal(await verifyPassword("correct horse battery stapl", stored), false);
  assert.equal(await verifyPassword("", stored), false);
});

test("never stores the password itself", async () => {
  const password = "correct horse battery staple";
  const stored = await hashPassword(password);

  assert.ok(!stored.includes(password), "the hash must not contain the password");
  assert.match(stored, /^[0-9a-f]{32}:[0-9a-f]{128}$/, "expected salt:hash hex");
});

test("salts each hash, so identical passwords do not collide", async () => {
  // Without a per-hash salt, two users choosing the same password would be
  // visibly identical in the database and crackable in one pass.
  const a = await hashPassword("same password here");
  const b = await hashPassword("same password here");

  assert.notEqual(a, b);
  assert.equal(await verifyPassword("same password here", a), true);
  assert.equal(await verifyPassword("same password here", b), true);
});

test("malformed stored values are rejected rather than throwing", async () => {
  for (const bad of ["", "nosalt", "not:hex", ":"]) {
    assert.equal(await verifyPassword("anything", bad), false, `"${bad}" should not verify`);
  }
});

test("emails are matched case-insensitively", () => {
  assert.equal(normalizeEmail("  Senthil@Example.COM "), "senthil@example.com");
});
