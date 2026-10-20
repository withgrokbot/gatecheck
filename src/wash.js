// Wash / self-payment signals, v1: FUNDING-SOURCE CHECK ONLY (per spec).
// Flags when the endpoint's payTo wallet was first funded BY ITSELF —
// i.e. no external funder on record, the classic fresh-wash-wallet shape.
//
// Implementation: eth_getTransactionCount + first inbound transfer lookup via
// the configured Base RPC. Any RPC failure -> "unknown", never a false flag.
// Heavier heuristics (cluster analysis, velocity) are explicitly out of v1.

import { config, USDC_BASE } from "./config.js";

/**
 * Returns { signal: "self_funded" | "externally_funded" | "unknown", detail }.
 * `rpc` is injectable for tests: { getFirstFunder(address) -> address|null }.
 */
export async function checkFundingSource(payTo, { rpc = null, timeoutMs = 5000 } = {}) {
  if (!payTo) return { signal: "unknown", detail: "no payTo to check" };
  try {
    const funder = rpc
      ? await rpc.getFirstFunder(payTo)
      : await firstFunderViaRpc(payTo, timeoutMs);
    if (!funder) return { signal: "unknown", detail: "no funding tx found" };
    if (String(funder).toLowerCase() === String(payTo).toLowerCase()) {
      return { signal: "self_funded", detail: "first inbound funding came from the wallet itself" };
    }
    return { signal: "externally_funded", detail: `first funded by ${funder}` };
  } catch (e) {
    return { signal: "unknown", detail: `rpc unavailable: ${e?.message || e}` };
  }
}

// Minimal first-funder lookup: binary-search the nonce history is overkill
// for v1; we check recent inbound transfers via eth_getLogs on the USDC
// contract and take the earliest. Good enough for a v1 signal, honest about it.
async function firstFunderViaRpc(payTo, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const toTopic = "0x000000000000000000000000" + String(payTo).toLowerCase().replace(/^0x/, "");
    const body = {
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getLogs",
      params: [{
        address: USDC_BASE,
        topics: [
          "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", // Transfer
          null,
          toTopic,
        ],
        fromBlock: "0x0",
        toBlock: "latest",
      }],
    };
    const res = await fetch(config.baseRpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`rpc ${res.status}`);
    const { result } = await res.json();
    if (!result || !result.length) return null;
    const earliest = result.sort((a, b) =>
      BigInt(a.blockNumber) < BigInt(b.blockNumber) ? -1 : 1)[0];
    // topics[1] is the `from` address, left-padded.
    return "0x" + earliest.topics[1].slice(-40);
  } finally {
    clearTimeout(timer);
  }
}
