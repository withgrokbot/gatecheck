// Treasury: margin guard, kill switch, loss caps, sweep math.
// Uses injected overrides — no env needed, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTreasury, PAUSE_REASONS } from "../src/treasury.js";

const A = (s) => BigInt(Math.round(Number(s) * 1_000_000)); // usdc -> atomic

test("healthy sale passes the guard and books margin", () => {
  const t = createTreasury();
  assert.deepEqual(t.checkSale("full"), { ok: true });
  t.recordSale({ kind: "full", priceAtomic: A("0.05"), upstreamAtomic: A("0.02") });
  const s = t.summary();
  assert.equal(s.sales, 1);
  assert.equal(s.earnedUsdc, "0.05");
  assert.equal(s.netUsdc, "0.03");
  assert.equal(s.paused, false);
});

test("margin guard auto-pauses on negative margin (never sells at a loss)", () => {
  const t = createTreasury({ overrides: { gasPerReport: A("0.05") } }); // cost 0.07 > price 0.05
  const r = t.checkSale("full");
  assert.equal(r.ok, false);
  assert.equal(r.reason, PAUSE_REASONS.NEGATIVE_MARGIN);
  assert.equal(t.state.paused, true);
  assert.equal(t.state.pauseReason, PAUSE_REASONS.NEGATIVE_MARGIN);
  // stays paused
  assert.equal(t.checkSale("full").ok, false);
});

test("lite loss cap pauses lite sales after the daily budget is hit", () => {
  const t = createTreasury({ overrides: { liteDailyLossCap: A("0.022") } });
  // upstream per lite = 0.021 (0.02 spot-check + 0.001 gas); each sale banks 0.001 loss
  assert.deepEqual(t.checkSale("lite"), { ok: true });   // 0 + 0.021 <= 0.022
  t.recordSale({ kind: "lite", priceAtomic: A("0.02"), upstreamAtomic: A("0.021") });
  assert.deepEqual(t.checkSale("lite"), { ok: true });   // 0.001 + 0.021 <= 0.022
  t.recordSale({ kind: "lite", priceAtomic: A("0.02"), upstreamAtomic: A("0.021") });
  const r = t.checkSale("lite");                        // 0.002 + 0.021 > 0.022
  assert.equal(r.ok, false);
  assert.equal(r.reason, PAUSE_REASONS.LITE_LOSS_CAP);
  assert.equal(t.state.paused, true);
});

test("free budget cap pauses free verdicts", () => {
  const t = createTreasury({ overrides: { freeDailyBudget: A("0.03") } });
  assert.deepEqual(t.checkSale("free"), { ok: true });
  t.recordSale({ kind: "free", priceAtomic: 0n, upstreamAtomic: A("0.021") });
  const r = t.checkSale("free");
  assert.equal(r.ok, false);
  assert.equal(r.reason, PAUSE_REASONS.FREE_BUDGET_CAP);
});

test("kill switch halts everything instantly; resume restores", () => {
  const t = createTreasury();
  t.kill("test");
  assert.equal(t.checkSale("full").reason, PAUSE_REASONS.KILL_SWITCH);
  assert.equal(t.checkSale("free").reason, PAUSE_REASONS.KILL_SWITCH);
  assert.equal(t.state.killLog.length, 1);
  t.resume();
  assert.deepEqual(t.checkSale("full"), { ok: true });
});

test("sweep is a stub: computes, moves nothing", () => {
  const t = createTreasury();
  t.recordSale({ kind: "full", priceAtomic: A("0.05"), upstreamAtomic: A("0.02") });
  const s = t.sweepProfits("0xowner");
  assert.equal(s.stub, true);
  assert.equal(s.sweepableUsdc, "0.03");
  assert.equal(s.wouldSendTo, "0xowner");
  // books unchanged by the stub
  assert.equal(t.summary().earnedUsdc, "0.05");
});
