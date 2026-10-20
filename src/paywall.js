// x402 v2 paywall for Gatecheck's own endpoints.
// Buyers pay Gatecheck here; this is the "money in" side.
// Uses @x402/express (v2) — version-aware: the middleware reads x402Version
// from the 402 envelope and expects PAYMENT-SIGNATURE (v2) / x-payment (v1)
// in the matching slot. We only sell on ONE network (config.network).

import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { config } from "./config.js";

const facilitator = new HTTPFacilitatorClient({ url: config.facilitatorUrl });

const server = new x402ResourceServer(facilitator).register(
  config.network,
  new ExactEvmScheme()
);

const priceOf = (atomic) =>
  `$${(Number(atomic) / 1_000_000).toFixed(2)}`;

function routeEntry(priceAtomic, description) {
  return {
    accepts: [
      {
        scheme: "exact",
        price: priceOf(priceAtomic),
        network: config.network,
        payTo: config.payTo,
      },
    ],
    description,
    mimeType: "application/json",
    maxTimeoutSeconds: 300,
  };
}

// Per-route middleware (not app-wide) so the lite endpoint can offer a
// free-tier path that bypasses the paywall without touching the paid path.
export const fullReportPaywall = paymentMiddleware(
  {
    "POST /v1/report": routeEntry(
      config.priceFull,
      "Gatecheck full trust report for one x402 endpoint"
    ),
  },
  server
);

export const liteVerdictPaywall = paymentMiddleware(
  {
    "POST /v1/verdict": routeEntry(
      config.priceLite,
      "Gatecheck lite verdict for one x402 endpoint"
    ),
  },
  server
);
