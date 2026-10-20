// Pins the dependency behaviour our money depends on: the pinned @x402/core HTTP client picks the proof header
// from x402Version (v1 -> X-PAYMENT, v2 -> PAYMENT-SIGNATURE, anything else throws), and our own proofHeaderForVersion
// agrees. If an @x402/* upgrade changes this, this test fails before any payment code runs.
// Source: node_modules/@x402/core/dist/esm/chunk-*.mjs x402HTTPClient.encodePaymentSignatureHeader (switch on
// paymentPayload.x402Version), client/index.mjs x402Client.createPaymentPayload (uses paymentRequired.x402Version).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { x402HTTPClient } from "@x402/core/http";
import { x402Client } from "@x402/core/client";
import { proofHeaderForVersion } from "../src/probe.js";


test("pinned @x402 packages are the audited 2.28.0", () => {
  const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
  for (const p of ["@x402/core", "@x402/evm", "@x402/express"]) assert.equal(lock.packages["node_modules/" + p].version, "2.28.0", p);
});

test("@x402/core client chooses the proof header from x402Version", () => {
  const http = new x402HTTPClient(new x402Client());
  const payload = (v) => ({ x402Version: v, payload: { signature: "0x", authorization: {} }, accepted: { scheme: "exact", network: "eip155:84532" }, scheme: "exact", network: "base-sepolia" });
  assert.deepEqual(Object.keys(http.encodePaymentSignatureHeader(payload(2))), ["PAYMENT-SIGNATURE"]);
  assert.deepEqual(Object.keys(http.encodePaymentSignatureHeader(payload(1))), ["X-PAYMENT"]);
  assert.throws(() => http.encodePaymentSignatureHeader(payload(3)), /Unsupported x402 version/);
  assert.throws(() => http.encodePaymentSignatureHeader(payload(undefined)), /Unsupported x402 version/);
  // Our own rule matches (header names are case-insensitive on the wire).
  for (const v of [1, 2]) assert.equal(proofHeaderForVersion(v).toLowerCase(), Object.keys(http.encodePaymentSignatureHeader(payload(v)))[0].toLowerCase());
  assert.equal(proofHeaderForVersion(3), null);
});

test("@x402/core client reads x402Version from the decoded 402 envelope (v2 header, v1 body)", () => {
  const http = new x402HTTPClient(new x402Client());
  const v2 = { x402Version: 2, resource: { url: "https://x.test/a" }, accepts: [] };
  const hdr = Buffer.from(JSON.stringify(v2)).toString("base64");
  assert.equal(http.getPaymentRequiredResponse((h) => (h === "PAYMENT-REQUIRED" ? hdr : null)).x402Version, 2);
  assert.equal(http.getPaymentRequiredResponse(() => null, { x402Version: 1, accepts: [] }).x402Version, 1);
  assert.throws(() => http.getPaymentRequiredResponse(() => null, { x402Version: 2, accepts: [] }), /Invalid payment required/);
});

test("x402Client refuses a version it has no scheme registered for (no silent fallback)", async () => {
  const c = new x402Client();
  await assert.rejects(c.createPaymentPayload({ x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:84532" }] }), /No client registered for x402 version: 2/);
});
