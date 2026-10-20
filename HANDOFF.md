# HANDOFF — Grok bot team: Gatecheck PoC

Built 2026-10-19 by Muse (subagent) per `../files/gatecheck-shop-spec.md`.
Status: **working thin slice, all 28 offline tests green, server boots clean.**
`npm test` → 28/28. `npm start` → :3402 on Base Sepolia defaults.

## What's built and working

- **x402 paywall (v2):** `POST /v1/report` ($0.05) and `POST /v1/verdict`
  ($0.02) via `@x402/express` + `@x402/evm` exact scheme. Uses the v2
  packages, not the deprecated v1 `x402-express`.
- **Free tier:** 5 lite verdicts/client/UTC day (`src/freeTier.js`). Client =
  `x-client-id` header, else SHA-256 of IP hashed immediately — raw IPs never
  stored (there's a test proving the store holds hex digests only).
- **Fulfillment pipeline** (`src/pipeline.js`): probe → decode → diff →
  paid spot-check → wash → verdict → signed receipt. Deterministic, no LLM.
- **v1/v2 rule** (`src/probe.js`): `x402Version` read from the decoded envelope
  before choosing `x-payment` / `PAYMENT-SIGNATURE`; unknown → refuse to guess.
  The upstream spot-check payment uses the same rule.
- **Envelope-vs-body diff** (`src/diff.js`): units-aware (`"0.020000"` ==
  `"20000"` atomic; bare `"2"` in a body reads as $2.00). Tested.
- **Gatecheck-as-customer** (`src/spotcheck.js`): `SPOTCHECK_MODE=dryrun`
  default (fixture verdict, $0.02 booked as *simulated* spend — treasury math
  stays honest). `live` mode implements the real EIP-3009 flow with viem.
- **Wash v1** (`src/wash.js`): funding-source check only. RPC failure →
  `unknown`, never a false flag.
- **Receipts** (`src/receipts.js`): node:crypto ed25519, canonical JSON,
  keypair generated+persisted to `data/` on first boot, public keys at
  `/.well-known/gatecheck-keys.json`, append-only `data/receipts.jsonl`,
  `GET /v1/receipts/:id` with signature verification.
- **Treasury** (`src/treasury.js`): $50 seed; margin guard auto-pauses full
  sales on non-positive margin; lite/free have daily loss caps; kill switch
  (env + admin endpoint); sweep is a **stub** (computes, moves nothing).
- **Idempotency** (`src/idempotency.js`): Idempotency-Key checked before the
  paywall; replays return the original receipt. Fulfill-after-settlement: the
  x402 middleware only calls the handler after facilitator verification.
- **Listing page** (`GET /`): what it sells, prices, curl example.

## What's stubbed (per spec — do not "fix" without owner sign-off)

1. Dynamic pricing (fixed $0.05/$0.02).
2. AI support worker.
3. Dispute flow / refunds (manual; post-payment fulfillment failures are
   logged for manual review — see `handleSale` catch block).
4. 30-day drift history (`drift.status: "unavailable_in_poc"` — needs crawl feed).
5. Profit sweep moves no funds.

## Next tasks, in order

1. **Live upstream payment drill (testnet-first):** the `live` path in
   `src/spotcheck.js` signs a real EIP-3009 authorization but has NEVER run
   against a funded wallet. Fund a throwaway Base wallet with ~$1, set
   `SPOTCHECK_MODE=live` + `GATECHECK_WALLET_KEY`, run ONE $0.02 spot-check
   against a known endpoint, confirm the verdict parses. Keep it to $1.
2. **Wire the crawl feed** for `drift` in reports (30-day history per endpoint).
3. **Real profit sweep:** owner-wallet flow replacing `sweepProfits()` stub.
   Chaos-test it: double sweep, failed sweep, RPC death mid-sweep.
4. **Persistence:** idempotency store, free-tier counters, and treasury state
   are in-memory — move to SQLite/Postgres before any real traffic.
5. **Dispute flow:** refunds + the post-payment fulfillment-failure path.
6. **Verify the pinned `@x402/*` client** reads `x402Version` before choosing
   the proof header (dependency, not our code — but our money depends on it).
7. **Docs note:** `budgets`-style footgun — don't share one treasury across
   two server instances; document the lock scope if you add one.

## How to run the tests

```bash
npm install
npm test   # node --test test/*.test.mjs — fully offline, no network, no funds
```

## Non-negotiables (from the item-shop report — never regress these)

- Idempotency on every paid endpoint.
- Fulfill-after-settlement: never deliver before the buyer's payment verifies.
- Envelope-vs-body diff on every probe.
- Testnet-first money code: no mainnet funds in any demo or test, for any reason.

## Assumptions (the real architecture — challenge these in review)

- `@x402/express@2.28.0`, `@x402/evm@2.28.0`, `@x402/core@2.28.0`, `viem@2.x`,
  `express@4.x`, Node ≥ 20.
- Facilitator default `https://x402.org/facilitator` (override via
  `FACILITATOR_URL`).
- 402xAgent paid spot-check: `POST https://api.402xagent.com/v1/lookup/paid`,
  $0.02 USDC Base mainnet, exact scheme,
  payTo `0x37cfCC8a29e9ff9458902B29E31E42dc7B718674`
  (verified live 2026-10-17 — re-verify before mainnet use).
- USDC Base mainnet: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (fixed 2026-10-20; the earlier value was not a contract), 6 decimals,
  EIP-3009 domain name "USD Coin", version "2".
- Free-tier abuse model: header/IP-hash is good enough for PoC, not for war.

## Push it to GitHub (one command — the maintainer runs this)

Muse has no GitHub write access and isn't asking for it. From this directory:

```bash
git init && git add -A && git commit -m "Gatecheck PoC: agent-run trust-report shop (thin slice)" \
  && gh repo create withgrokbot/gatecheck --public --source=. --push
```

Then wire the repo into the Grok team's normal flow (Aikido SAST like the
audit PR before any mainnet funds).
