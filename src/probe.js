// Live probe: fetch the target endpoint UNPAID and capture its 402.
// - Decodes the base64 PAYMENT-REQUIRED envelope.
// - Extracts x402Version BEFORE anything else (the v1/v2 rule): the proof
//   header name is chosen from the version, never assumed.
//     v1 -> "x-payment"            v2 -> "PAYMENT-SIGNATURE"
// - Returns structured probe data for the envelope-vs-body diff.
//
// Timeouts: the probe aborts after PROBE_TIMEOUT_MS so one slow endpoint
// cannot blow the p95 latency promise.

export const PROBE_TIMEOUT_MS = 8000;

/** Proof header name for a given x402 version. Unknown versions -> null (refuse to guess). */
export function proofHeaderForVersion(version) {
  if (version === 1 || version === "1") return "x-payment";
  if (version === 2 || version === "2") return "PAYMENT-SIGNATURE";
  return null;
}

export function decodePaymentRequired(headerValue) {
  if (!headerValue) return { ok: false, reason: "missing_header" };
  try {
    const json = JSON.parse(
      Buffer.from(String(headerValue).trim(), "base64").toString("utf8")
    );
    const accepts = json.accepts || json.accept || [];
    const first = Array.isArray(accepts) ? accepts[0] : accepts;
    return {
      ok: true,
      x402Version: json.x402Version ?? null,
      amount: first?.amount ?? first?.maxAmountRequired ?? null,
      asset: first?.asset ?? null,
      network: first?.network ?? null,
      payTo: first?.payTo ?? first?.pay_to ?? null,
      scheme: first?.scheme ?? null,
      raw: json,
    };
  } catch {
    return { ok: false, reason: "undecodable_envelope" };
  }
}

/**
 * Probe an endpoint without paying.
 * Returns { status, latencyMs, envelope, body, proofHeader, error }.
 * - status 402 + envelope.ok -> paid endpoint, challenge captured.
 * - status 200            -> no challenge (free or unprotected).
 * - anything else / timeout -> recorded, not fatal to the report.
 */
export async function probeEndpoint(url, { fetchImpl = fetch, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      signal: ctrl.signal,
      headers: { accept: "application/json" },
    });
    const latencyMs = Date.now() - started;
    const headerNames = [...res.headers.keys()];
    const paymentRequired =
      res.headers.get("payment-required") || res.headers.get("PAYMENT-REQUIRED");
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (res.status !== 402) {
      return { status: res.status, latencyMs, envelope: null, body, proofHeader: null, error: null, headerNames };
    }
    const envelope = decodePaymentRequired(paymentRequired);
    return {
      status: 402,
      latencyMs,
      envelope,
      body,
      proofHeader: envelope.ok ? proofHeaderForVersion(envelope.x402Version) : null,
      error: null,
      headerNames,
    };
  } catch (e) {
    return {
      status: null,
      latencyMs: Date.now() - started,
      envelope: null,
      body: null,
      proofHeader: null,
      error: e?.name === "AbortError" ? "probe_timeout" : `probe_error:${e?.message || e}`,
      headerNames: [],
    };
  } finally {
    clearTimeout(timer);
  }
}
