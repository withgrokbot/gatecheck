# x402Version and the proof header (pinned @x402/* 2.28.0)

Checked 2026-10-20 against `node_modules/@x402/core` 2.28.0 (`@x402/evm` and `@x402/express` are also 2.28.0).

**Client: yes, it reads x402Version before choosing the header.**
- `x402HTTPClient.getPaymentRequiredResponse` (`dist/esm/chunk-FV2JN4FK.mjs` ~2156) decodes the `PAYMENT-REQUIRED` header (v2). With no header it accepts a body only when `body.x402Version === 1`, and otherwise throws.
- `x402Client.createPaymentPayload` (`dist/esm/client/index.mjs` ~254) looks up the registered schemes by `paymentRequired.x402Version` and throws `No client registered for x402 version: N` if there are none.
- `x402HTTPClient.encodePaymentSignatureHeader` (`chunk-FV2JN4FK.mjs` ~2133) switches on `paymentPayload.x402Version`: 2 gives `PAYMENT-SIGNATURE`, 1 gives `X-PAYMENT`, and anything else throws `Unsupported x402 version`.

**Server (the paywall we run): v2 only.** `x402HTTPResourceServer.extractPayment` (`chunk-FV2JN4FK.mjs` ~3088) reads only `payment-signature`. A v1 buyer sending `X-PAYMENT` is not accepted by Gatecheck's paywall, so Gatecheck must advertise `x402Version: 2` only.

Gatecheck's own upstream payment (`src/spotcheck.js`) uses `proofHeaderForVersion` (`src/probe.js`), which matches the dependency, and unknown versions return null (refuse to pay).

Guard: `test/x402-version.test.mjs` pins the 2.28.0 lockfile versions and the behaviour above. An `@x402/*` upgrade that changes it fails the suite.
