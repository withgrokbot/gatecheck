// Envelope-vs-body diff: the Oct 2026 drift check, run on EVERY probe.
// Compares the decoded 402 envelope against the JSON body the endpoint also
// returned, across amount / asset / payTo / network / x402Version.
// Units-aware: openapi-style dollars decimal ("0.020000") and atomic units
// ("20000") are normalized before comparison — a units mismatch is its own
// finding, not a false amount mismatch.

const ATOMIC_RE = /^\d+$/;
const DECIMAL_RE = /^\d+(\.\d+)?$/;

/** Normalize an amount to integer atomic units (BigInt), or null if unreadable.
 *  decimal=true: bare integers are whole dollars (openapi/body style).
 *  decimal=false: bare integers are already atomic (402 envelope style). */
export function toAtomicUnits(v, { decimal = false } = {}) {
  if (v == null) return null;
  if (typeof v === "bigint") return decimal ? v * 1_000_000n : v;
  const s = String(v).trim();
  if (ATOMIC_RE.test(s)) {
    try {
      const n = BigInt(s);
      return decimal ? n * 1_000_000n : n;
    } catch { return null; }
  }
  if (DECIMAL_RE.test(s)) {
    const [w, f = ""] = s.split(".");
    const frac = (f + "000000").slice(0, 6); // USDC: 6 decimals
    try { return BigInt(w) * 1_000_000n + BigInt(frac); } catch { return null; }
  }
  return null;
}

const normAddr = (a) => (a ? String(a).toLowerCase() : null);
const normStr = (s) => (s ? String(s).trim().toLowerCase() : null);

/**
 * Diff the decoded envelope against the JSON body.
 * bodyHints tells us which body fields are decimal-dollars vs atomic:
 *   { amountKind: "decimal" | "atomic" }  (default "decimal" — openapi style)
 * Envelope amounts are ALWAYS atomic (protocol rule).
 */
export function diffEnvelopeBody(envelope, body, { amountKind = "decimal" } = {}) {
  const findings = [];
  if (!envelope?.ok) {
    findings.push({ field: "envelope", code: "bad_challenge", detail: envelope?.reason || "undecodable" });
    return { clean: false, findings };
  }
  const b = body && typeof body === "object" ? body : {};
  // The body may nest terms under several conventional keys; check them all.
  const pick = (...keys) => {
    for (const k of keys) if (b[k] != null) return b[k];
    const t = b.terms || b.paymentTerms || b.pricing || {};
    for (const k of keys) if (t[k] != null) return t[k];
    return null;
  };

  // amount — units-aware. Envelope is ALWAYS atomic (protocol rule);
  // the body is decimal dollars by default (openapi style).
  const envAmount = toAtomicUnits(envelope.amount);
  const bodyAmountRaw = pick("amount", "price", "maxAmountRequired", "priceUsd", "cost");
  const bodyAmount = bodyAmountRaw == null ? null
    : toAtomicUnits(bodyAmountRaw, { decimal: amountKind !== "atomic" });
  if (bodyAmountRaw != null) {
    if (envAmount == null || bodyAmount == null) {
      findings.push({ field: "amount", code: "bad_challenge", detail: "unreadable amount on one side" });
    } else if (envAmount !== bodyAmount) {
      findings.push({
        field: "amount", code: "price_mismatch",
        detail: `envelope=${envelope.amount} (atomic) vs body=${bodyAmountRaw} (~${bodyAmount} atomic)`,
      });
    }
  }

  // payTo
  const bodyPayTo = pick("payTo", "pay_to", "wallet", "address", "recipient");
  if (bodyPayTo != null && normAddr(bodyPayTo) !== normAddr(envelope.payTo)) {
    findings.push({ field: "payTo", code: "pay_to_mismatch", detail: `envelope=${envelope.payTo} vs body=${bodyPayTo}` });
  }

  // network
  const bodyNet = pick("network", "chain", "chainId");
  if (bodyNet != null && normStr(bodyNet) !== normStr(envelope.network)) {
    findings.push({ field: "network", code: "network_mismatch", detail: `envelope=${envelope.network} vs body=${bodyNet}` });
  }

  // asset
  const bodyAsset = pick("asset", "token", "currency");
  if (bodyAsset != null && normStr(bodyAsset) !== normStr(envelope.asset)) {
    findings.push({ field: "asset", code: "asset_not_usdc", detail: `envelope=${envelope.asset} vs body=${bodyAsset}` });
  }

  // version
  const bodyVer = pick("x402Version", "x402version", "version");
  if (bodyVer != null && String(bodyVer) !== String(envelope.x402Version)) {
    findings.push({ field: "x402Version", code: "version_mismatch", detail: `envelope=${envelope.x402Version} vs body=${bodyVer}` });
  }

  return { clean: findings.length === 0, findings };
}
