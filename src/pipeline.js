// Fulfillment pipeline (deterministic, not LLM-flaky):
//   probe -> envelope decode -> envelope-vs-body diff -> paid spot-check
//   (Gatecheck as customer) -> wash signal -> verdict -> sign receipt.
//
// Verdict vocabulary reuses the spot-check reason codes: price_mismatch,
// network_mismatch, pay_to_mismatch, challenge_expired, bad_challenge,
// plus Gatecheck's own: envelope_body_mismatch, wash_self_funded.

import { config } from "./config.js";
import { probeEndpoint } from "./probe.js";
import { diffEnvelopeBody } from "./diff.js";
import { buySpotCheck } from "./spotcheck.js";
import { checkFundingSource } from "./wash.js";
import { signReceipt, logReceipt, receiptId } from "./receipts.js";

function validUrl(u) {
  try {
    const p = new URL(String(u));
    return p.protocol === "http:" || p.protocol === "https:" ? p.toString() : null;
  } catch { return null; }
}

/**
 * Run the full pipeline for a target endpoint URL.
 * kind: "full" | "lite". Lite skips the wash check and drift notes.
 * treasury: the treasury instance (records upstream spend AFTER success).
 * Returns { report, receipt } — receipt is ed25519-signed.
 */
export async function fulfillReport(targetUrl, { kind = "full", treasury, probe = null } = {}) {
  const url = validUrl(targetUrl);
  if (!url) throw Object.assign(new Error("invalid url"), { status: 400 });

  // 1. Live probe (unpaid).
  const p = probe || await probeEndpoint(url);

  // 2. Envelope-vs-body diff on every probe.
  const diff = p.envelope ? diffEnvelopeBody(p.envelope, p.body) : { clean: true, findings: [] };

  // 3. The paid spot-check — Gatecheck as a real customer ($0.02).
  const spot = await buySpotCheck(url);
  const upstreamAtomic = spot.spentAtomic ?? config.spotcheckCost;

  // 4. Wash signal (full reports only, v1 = funding-source check).
  let wash = { signal: "unknown", detail: "lite verdict skips wash check" };
  if (kind === "full" && p.envelope?.ok) {
    wash = await checkFundingSource(p.envelope.payTo);
  }

  // 5. Verdict: deterministic composition.
  const reasons = [];
  let verdict = spot.verdict === "skip" ? "skip" : "pay";
  if (spot.verdict === "skip") reasons.push(spot.reason || "spotcheck_skip");
  if (!diff.clean) {
    verdict = "recheck";
    for (const f of diff.findings) reasons.push(`${f.code}:${f.field}`);
  }
  if (p.error) {
    verdict = verdict === "pay" ? "recheck" : verdict;
    reasons.push(p.error);
  }
  if (p.status !== 402 && p.status !== null) {
    reasons.push(p.status === 200 ? "no_challenge: endpoint did not return 402" : `probe_status_${p.status}`);
    if (verdict === "pay") verdict = "recheck";
  }
  if (wash.signal === "self_funded") {
    if (verdict === "pay") verdict = "recheck";
    reasons.push("wash_self_funded");
  }
  if (!reasons.length) reasons.push(spot.reason || "terms_ok");

  const report = {
    kind,
    target: url,
    verdict,
    reasons,
    live: {
      probeStatus: p.status,
      latencyMs: p.latencyMs,
      proofHeader: p.proofHeader, // version-correct header name, or null
      challenge: p.envelope?.ok ? {
        x402Version: p.envelope.x402Version,
        amount: p.envelope.amount,
        asset: p.envelope.asset,
        network: p.envelope.network,
        payTo: p.envelope.payTo,
        scheme: p.envelope.scheme,
      } : null,
    },
    envelopeBodyDiff: diff,
    spotcheck: {
      verdict: spot.verdict,
      reason: spot.reason,
      receiptUrl: spot.receiptUrl,
      simulated: !!spot.simulated,
    },
    wash,
    // STUB (honest): 30-day drift history needs the crawl feed wired up.
    drift: { status: "unavailable_in_poc", note: "crawl feed not wired; next task" },
    upstreamSpendAtomic: upstreamAtomic.toString(),
    at: new Date().toISOString(),
  };

  // 6. Sign + log the receipt.
  const receipt = signReceipt({
    id: receiptId(),
    type: "gatecheck-report",
    target: url,
    kind,
    verdict,
    reasons,
    upstreamSpendAtomic: upstreamAtomic.toString(),
    at: report.at,
  });
  await logReceipt(receipt);

  // 7. Treasury books the upstream spend AFTER successful fulfillment.
  treasury?.recordSale({
    kind,
    priceAtomic: kind === "full" ? config.priceFull : kind === "lite" ? config.priceLite : 0n,
    upstreamAtomic,
    simulated: !!spot.simulated,
  });

  return { report, receipt, receiptUrl: `/v1/receipts/${receipt.id}` };
}
