// 402xAgent paid spot-check client — Gatecheck as a CUSTOMER.
// This is the money loop made concrete: every full report costs Gatecheck
// $0.02 USDC on Base mainnet (exact scheme, payTo 0x37cfCC8a29e9ff9458902B29E31E42dc7B718674).
//
// Modes:
//   dryrun (default) — no network, no funds. Returns a fixture verdict and
//     records the $0.02 as SIMULATED spend so treasury math stays honest.
//   live — real x402 payment. Requires GATECHECK_WALLET_KEY and explicit
//     mainnet arming (see config.js). Signs EIP-3009 authorization with viem,
//     sends under the version-correct proof header (v1 -> x-payment,
//     v2 -> PAYMENT-SIGNATURE), and parses the verdict.
//
// The live path is implemented but UNTESTED against real funds — it has never
// run with a funded wallet. Testnet-first: there is no testnet paid endpoint,
// so live == mainnet == deliberate.

import { config, toAtomic, USDC_BY_NETWORK } from "./config.js";
import { decodePaymentRequired, proofHeaderForVersion } from "./probe.js";

const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

function dryrunVerdict(url) {
  return {
    verdict: "pay",
    reason: "dryrun",
    receiptUrl: null,
    simulated: true,
    detail: `SPOTCHECK_MODE=dryrun: no payment sent for ${url}; $0.02 recorded as simulated spend.`,
  };
}

/** Live x402 payment to 402xAgent. Throws on any failure — callers record the attempt. */
async function liveSpotCheck(url, { fetchImpl = fetch } = {}) {
  const { privateKeyToAccount } = await import("viem/accounts");
  const account = privateKeyToAccount(config.walletKey);

  // 1. Unpaid request -> 402 challenge (authoritative terms from the envelope).
  // endpoint-spot-check answers a bare GET (no ?url=) with its x402 v2 challenge and never spends a free check;
  // a GET with ?url= would use the free tier first and answer 200. Its PAYMENT-REQUIRED header is ~29 KB, so Node
  // must run with --max-http-header-size=65536 (npm start / npm run drill set it).
  const paidUrl = new URL(config.spotcheckUrl);
  paidUrl.searchParams.set("url", url);
  paidUrl.searchParams.set("client", config.spotcheckClient);
  const challenge = await fetchImpl(config.spotcheckUrl, { method: "GET", headers: { accept: "application/json" } });
  if (challenge.status !== 402) {
    throw new Error(`spot-check: expected 402, got ${challenge.status}`);
  }
  const envelope = decodePaymentRequired(
    challenge.headers.get("payment-required") || challenge.headers.get("PAYMENT-REQUIRED")
  );
  if (!envelope.ok) throw new Error(`spot-check: undecodable envelope (${envelope.reason})`);

  // 2. Version-aware proof header — never assume.
  const proofHeader = proofHeaderForVersion(envelope.x402Version);
  if (!proofHeader) throw new Error(`spot-check: unknown x402Version ${envelope.x402Version}`);

  // 3. Sanity: the challenge must match 402xAgent's published terms.
  if (String(envelope.payTo).toLowerCase() !== config.spotcheckPayTo.toLowerCase()) {
    throw new Error(`spot-check: payTo mismatch (challenge=${envelope.payTo})`);
  }

  // 4. Sign EIP-3009 authorization for the exact challenged amount.
  const value = BigInt(envelope.amount);
  // Never sign more than the published price, whatever the challenge asks.
  if (value <= 0n || value > config.spotcheckCost) throw new Error(`spot-check: challenge amount ${value} exceeds the ${config.spotcheckCost} cap`);
  const nowSec = Math.floor(Date.now() / 1000);
  const nonce = `0x${[...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  const authorization = {
    from: account.address,
    to: envelope.payTo,
    value,
    validAfter: 0n,
    validBefore: BigInt(nowSec + 300),
    nonce,
  };
  const usdc = USDC_BY_NETWORK[envelope.network];
  if (!usdc) throw new Error(`spot-check: unsupported network ${envelope.network}`);
  if (envelope.asset && String(envelope.asset).toLowerCase() !== usdc.address.toLowerCase()) {
    throw new Error(`spot-check: asset ${envelope.asset} is not USDC on ${envelope.network}`);
  }
  const signature = await account.signTypedData({
    domain: { name: usdc.name, version: usdc.version, chainId: usdc.chainId, verifyingContract: usdc.address },
    types: EIP3009_TYPES,
    primaryType: "TransferWithAuthorization",
    message: authorization,
  });

  const auth = {
    from: authorization.from,
    to: authorization.to,
    value: authorization.value.toString(),
    validAfter: authorization.validAfter.toString(),
    validBefore: authorization.validBefore.toString(),
    nonce: authorization.nonce,
  };
  // v2 carries the accepted requirement and resource; v1 the flat scheme/network shape.
  const accepted = (envelope.raw.accepts || [])[0];
  const payment = envelope.x402Version === 2 || envelope.x402Version === "2"
    ? { x402Version: 2, resource: envelope.raw.resource, accepted, payload: { signature, authorization: auth } }
    : { x402Version: 1, scheme: "exact", network: envelope.network, payload: { signature, authorization: auth } };
  const paymentB64 = Buffer.from(JSON.stringify(payment)).toString("base64");

  // 5. Paid request.
  const paid = await fetchImpl(paidUrl.toString(), {
    method: "GET",
    headers: { accept: "application/json", [proofHeader]: paymentB64 },
  });
  if (!paid.ok) {
    const text = await paid.text().catch(() => "");
    throw new Error(`spot-check: paid request failed ${paid.status}: ${text.slice(0, 200)}`);
  }
  const verdict = await paid.json();
  return {
    verdict: verdict.verdict || "unknown",
    reason: verdict.reason_code || verdict.reason || "unknown",
    receiptUrl: verdict.receiptUrl || verdict.receipt_url || null,
    receiptId: verdict.receipt_id || (verdict.receipt_url ? String(verdict.receipt_url).split("/").pop() : null),
    tx: verdict.access?.tx || null,
    simulated: false,
    spentAtomic: toAtomic("0.02"),
    detail: verdict,
  };
}

export async function buySpotCheck(url, opts = {}) {
  if (config.spotcheckMode !== "live") {
    return { ...dryrunVerdict(url), spentAtomic: config.spotcheckCost };
  }
  return liveSpotCheck(url, opts);
}
