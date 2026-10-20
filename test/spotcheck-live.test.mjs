// Offline test of the live upstream payment path against a mock 402xAgent (no network, no funds).
// Checks: discovery 402 is read, the v2 header is used, the payload has the v2 shape the worker requires
// (accepted + resource), the EIP-3009 signature verifies for Base USDC, and the verdict/receipt parse.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generatePrivateKey } from "viem/accounts";

const code = `
import { buySpotCheck } from "./src/spotcheck.js";
import { verifyTypedData } from "viem";
import { USDC_BASE } from "./src/config.js";
const accepted = { scheme: "exact", network: "eip155:8453", amount: "20000", asset: USDC_BASE, payTo: "0x37cfCC8a29e9ff9458902B29E31E42dc7B718674", maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } };
const env = { x402Version: 2, resource: { url: "https://api.402xagent.com/v1/products/endpoint-spot-check" }, accepts: [accepted] };
const calls = [];
const fetchImpl = async (u, init = {}) => {
  calls.push({ u: String(u), h: init.headers || {} });
  if (calls.length === 1) return new Response("{}", { status: 402, headers: { "payment-required": Buffer.from(JSON.stringify(env)).toString("base64") } });
  return Response.json({ verdict: "pay", reason_code: "price_ok", receipt_url: "https://402xagent.com/v1/receipts/sc-abc123", access: { tier: "paid", tx: "0xfeed" } });
};
const r = await buySpotCheck("https://seller.test/api", { fetchImpl });
const h = calls[1].h;
const p = JSON.parse(Buffer.from(h["PAYMENT-SIGNATURE"], "base64").toString());
const a = p.payload.authorization;
const ok = await verifyTypedData({ address: a.from, domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: USDC_BASE },
  types: { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
  primaryType: "TransferWithAuthorization", message: { ...a, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore) }, signature: p.payload.signature });
console.log(JSON.stringify({ r: { verdict: r.verdict, reason: r.reason, receiptId: r.receiptId, tx: r.tx, simulated: r.simulated }, first: calls[0].u, paidUrl: calls[1].u, hasX: "x-payment" in h, p: { v: p.x402Version, accepted: p.accepted, resource: p.resource, to: a.to, value: a.value }, ok }));
`;

test("live spot-check path: v2 header + payload shape, valid EIP-3009 signature, verdict parsed", () => {
  const out = spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", code], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, SPOTCHECK_MODE: "live", GATECHECK_WALLET_KEY: generatePrivateKey(), GATECHECK_PAY_TO: "0x000000000000000000000000000000000000dEaD" },
    encoding: "utf8",
  });
  assert.equal(out.status, 0, out.stderr);
  const j = JSON.parse(out.stdout.trim().split("\n").pop());
  assert.deepEqual(j.r, { verdict: "pay", reason: "price_ok", receiptId: "sc-abc123", tx: "0xfeed", simulated: false });
  assert.equal(j.first, "https://api.402xagent.com/v1/products/endpoint-spot-check");
  assert.match(j.paidUrl, /\?url=https%3A%2F%2Fseller\.test%2Fapi&client=gatecheck$/);
  assert.equal(j.hasX, false);
  assert.equal(j.p.v, 2);
  assert.equal(j.p.accepted.amount, "20000");
  assert.equal(j.p.resource.url, "https://api.402xagent.com/v1/products/endpoint-spot-check");
  assert.equal(j.p.to, "0x37cfCC8a29e9ff9458902B29E31E42dc7B718674");
  assert.equal(j.p.value, "20000");
  assert.equal(j.ok, true);
});
