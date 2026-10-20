// Idempotency: same key -> original response, handler runs once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createIdempotencyStore } from "../src/idempotency.js";

test("second use of a key replays the stored response", () => {
  const idem = createIdempotencyStore();
  assert.equal(idem.check("k1"), null);
  idem.store("k1", 200, { receipt: "abc" });
  const hit = idem.check("k1");
  assert.equal(hit.status, 200);
  assert.deepEqual(hit.body, { receipt: "abc" });
  assert.equal(hit.replay, true);
});

test("unknown keys miss; empty keys are ignored", () => {
  const idem = createIdempotencyStore();
  assert.equal(idem.check("nope"), null);
  assert.equal(idem.check(null), null);
  assert.equal(idem.check(""), null);
  idem.store(null, 200, {});
  assert.equal(idem._size(), 0);
});

test("entries expire after the TTL", () => {
  let now = 1_000_000;
  const idem = createIdempotencyStore({ ttlMs: 1000, now: () => now });
  idem.store("k", 200, { x: 1 });
  assert.ok(idem.check("k"));
  now += 1001;
  assert.equal(idem.check("k"), null);
});
