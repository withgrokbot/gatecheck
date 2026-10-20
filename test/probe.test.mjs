// Probe: PAYMENT-REQUIRED decode + the v1/v2 proof-header rule.
// No network — fixtures only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodePaymentRequired, proofHeaderForVersion, probeEndpoint } from "../src/probe.js";

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const envelopeV2 = {
  x402Version: 2,
  accepts: [{ scheme: "exact", network: "eip155:8453", amount: "20000", asset: "0xabc", payTo: "0xdef" }],
};

test("v1 -> x-payment, v2 -> PAYMENT-SIGNATURE, unknown -> null (never guess)", () => {
  assert.equal(proofHeaderForVersion(1), "x-payment");
  assert.equal(proofHeaderForVersion("1"), "x-payment");
  assert.equal(proofHeaderForVersion(2), "PAYMENT-SIGNATURE");
  assert.equal(proofHeaderForVersion("2"), "PAYMENT-SIGNATURE");
  assert.equal(proofHeaderForVersion(3), null);
  assert.equal(proofHeaderForVersion(null), null);
});

test("decodes a v2 envelope", () => {
  const d = decodePaymentRequired(b64(envelopeV2));
  assert.equal(d.ok, true);
  assert.equal(d.x402Version, 2);
  assert.equal(d.amount, "20000");
  assert.equal(d.network, "eip155:8453");
  assert.equal(d.payTo, "0xdef");
});

test("missing / garbage envelope -> ok:false", () => {
  assert.equal(decodePaymentRequired(null).ok, false);
  assert.equal(decodePaymentRequired("!!!not-base64!!!").ok, false);
});

test("probe captures a 402 with envelope + version-correct header", async () => {
  const fakeFetch = async () => new Response(JSON.stringify({ hello: "world" }), {
    status: 402,
    headers: { "PAYMENT-REQUIRED": b64(envelopeV2) },
  });
  const p = await probeEndpoint("https://seller.example/api", { fetchImpl: fakeFetch });
  assert.equal(p.status, 402);
  assert.equal(p.envelope.ok, true);
  assert.equal(p.proofHeader, "PAYMENT-SIGNATURE");
  assert.ok(p.latencyMs >= 0);
});

test("probe records a 200 as no-challenge", async () => {
  const fakeFetch = async () => new Response(JSON.stringify({ ok: true }), { status: 200 });
  const p = await probeEndpoint("https://free.example/", { fetchImpl: fakeFetch });
  assert.equal(p.status, 200);
  assert.equal(p.envelope, null);
});

test("probe timeout is recorded, not thrown", async () => {
  const slow = () => new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error("x"), { name: "AbortError" })), 5));
  const p = await probeEndpoint("https://slow.example/", { fetchImpl: slow, timeoutMs: 1 });
  assert.equal(p.error, "probe_timeout");
});
