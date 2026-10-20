// Envelope-vs-body diff: exact match, mismatches, and the units case.
// No network — fixtures only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { diffEnvelopeBody, toAtomicUnits } from "../src/diff.js";

const env = (over = {}) => ({
  ok: true,
  x402Version: 2,
  amount: "20000",          // atomic ($0.02)
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA4A92",
  network: "eip155:8453",
  payTo: "0x37cfCC8a29e9ff9458902B29E31E42dc7B718674",
  scheme: "exact",
  ...over,
});

test("units: envelope atomic vs body decimal dollars match", () => {
  // The canonical case from the field: openapi says "0.020000" dollars,
  // the 402 envelope says "20000" atomic. Same money — no finding.
  const body = { price: "0.020000", payTo: "0x37cfCC8a29e9ff9458902B29E31E42dc7B718674", network: "eip155:8453" };
  const r = diffEnvelopeBody(env(), body);
  assert.equal(r.clean, true);
  assert.deepEqual(r.findings, []);
});

test("units: bare body integer reads as dollars, not atomic", () => {
  // Body { price: "2" } means $2.00 -> 2000000 atomic, NOT 2 atomic.
  assert.equal(toAtomicUnits("2", { decimal: true }), 2000000n);
  assert.equal(toAtomicUnits("20000", { decimal: false }), 20000n);
  const r = diffEnvelopeBody(env({ amount: "2000000" }), { price: "2" });
  assert.equal(r.clean, true);
});

test("clean diff when everything matches", () => {
  const body = {
    amount: "0.02",
    payTo: "0x37cfCC8a29e9ff9458902B29E31E42dc7B718674",
    network: "eip155:8453",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA4A92",
    x402Version: 2,
  };
  const r = diffEnvelopeBody(env(), body);
  assert.equal(r.clean, true);
});

test("price_mismatch on real amount drift", () => {
  const r = diffEnvelopeBody(env(), { price: "0.05" }); // body says $0.05, envelope $0.02
  assert.equal(r.clean, false);
  assert.ok(r.findings.some((f) => f.code === "price_mismatch" && f.field === "amount"));
});

test("pay_to_mismatch (case-insensitive)", () => {
  const r = diffEnvelopeBody(env(), { payTo: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" });
  assert.ok(r.findings.some((f) => f.code === "pay_to_mismatch"));
});

test("network_mismatch", () => {
  const r = diffEnvelopeBody(env(), { network: "eip155:84532" });
  assert.ok(r.findings.some((f) => f.code === "network_mismatch"));
});

test("version_mismatch", () => {
  const r = diffEnvelopeBody(env(), { x402Version: 1 });
  assert.ok(r.findings.some((f) => f.code === "version_mismatch"));
});

test("undecodable envelope -> bad_challenge", () => {
  const r = diffEnvelopeBody({ ok: false, reason: "undecodable_envelope" }, {});
  assert.equal(r.clean, false);
  assert.ok(r.findings.some((f) => f.code === "bad_challenge"));
});

test("nested terms objects are read", () => {
  const r = diffEnvelopeBody(env(), { terms: { price: "0.02" } });
  assert.equal(r.clean, true);
  const bad = diffEnvelopeBody(env(), { pricing: { price: "9.99" } });
  assert.ok(bad.findings.some((f) => f.code === "price_mismatch"));
});
