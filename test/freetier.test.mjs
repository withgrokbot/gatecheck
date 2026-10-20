// Free tier: 5/day per client, UTC rollover, and no raw identifiers stored.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFreeTier, clientDigest } from "../src/freeTier.js";

const req = (id, ip) => ({ get: (h) => (h === "x-client-id" ? id : null), ip });

test("5 free per day, 6th denied", () => {
  const ft = createFreeTier({ perDay: 5 });
  const r = req("agent-1");
  for (let i = 0; i < 5; i++) assert.equal(ft.tryConsume(r), true);
  assert.equal(ft.tryConsume(r), false);
  assert.equal(ft.remaining(r), 0);
});

test("counter resets on UTC day rollover", () => {
  let now = Date.parse("2026-10-19T23:59:00Z");
  const ft = createFreeTier({ perDay: 1, now: () => now });
  const r = req("agent-2");
  assert.equal(ft.tryConsume(r), true);
  assert.equal(ft.tryConsume(r), false);
  now = Date.parse("2026-10-20T00:01:00Z");
  assert.equal(ft.tryConsume(r), true);
});

test("different clients have independent quotas", () => {
  const ft = createFreeTier({ perDay: 1 });
  assert.equal(ft.tryConsume(req("a")), true);
  assert.equal(ft.tryConsume(req("b")), true);
  assert.equal(ft.tryConsume(req("a")), false);
});

test("store holds hashes only — no raw IPs or client ids", () => {
  const ft = createFreeTier({ perDay: 5 });
  ft.tryConsume(req(null, "203.0.113.77"));
  ft.tryConsume(req("super-secret-client", "198.51.100.9"));
  const keys = [...ft._store.keys()];
  assert.ok(keys.length > 0);
  for (const k of keys) {
    assert.match(k, /^[0-9a-f]{64}$/); // sha256 hex only
    assert.ok(!k.includes("203.0.113.77"));
    assert.ok(!k.includes("super-secret"));
  }
  // digest is stable for same input+day, differs across days
  const d1 = clientDigest(req("x"), Date.parse("2026-10-19T12:00:00Z"));
  const d2 = clientDigest(req("x"), Date.parse("2026-10-19T13:00:00Z"));
  const d3 = clientDigest(req("x"), Date.parse("2026-10-20T12:00:00Z"));
  assert.equal(d1, d2);
  assert.notEqual(d1, d3);
});
