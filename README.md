# Gatecheck — the first seeded agent-run shop

Pre-payment trust reports for x402 endpoints. An agent (or human) about to pay
endpoint X buys a **signed verdict** — pay, skip, or recheck, with reasons —
before signing.

The money loop is x402 all the way down:

> buyer pays Gatecheck **$0.05** via x402 → Gatecheck pays 402xAgent **$0.02**
> for the spot-check that powers the verdict → Gatecheck keeps **~$0.03**.

## Products

| Endpoint | Price | What you get |
|---|---|---|
| `POST /v1/report` | $0.05 | Full trust report: live 402 terms, envelope-vs-body diff, paid spot-check verdict, wash signal, signed receipt |
| `POST /v1/verdict` | $0.02 (5 free/day) | Lite verdict: pay/skip + reason |

No subscriptions in v1 — x402 has no recurring primitive.

## Run it locally (testnet)

Testnet-first: everything defaults to Base Sepolia. No mainnet funds can move
unless you set **both** `GATECHECK_NETWORK=eip155:8453` **and**
`GATECHECK_LIVE_MAINNET=1`.

```bash
cp .env.example .env
# edit .env: set GATECHECK_PAY_TO to your Base Sepolia wallet
npm install
npm test        # 28 offline tests, no network
npm start       # listens on :3402
```

The upstream spot-check defaults to `SPOTCHECK_MODE=dryrun`: no payment is
sent, the $0.02 is recorded as *simulated* spend, and the verdict is a fixture.
Set `SPOTCHECK_MODE=live` + `GATECHECK_WALLET_KEY` for the real $0.02 USDC
payment to 402xAgent (mainnet — arm deliberately; the live path signs a real
EIP-3009 authorization and has never run against funded wallets).

## API

```bash
# Full report ($0.05) — unpaid request gets a 402, pay it, retry:
curl -X POST http://localhost:3402/v1/report \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000' \
  -d '{"url":"https://some-x402-endpoint.example/api"}'

# Lite verdict — first 5/day per client are free (x-client-id header, or hashed IP):
curl -X POST http://localhost:3402/v1/verdict \
  -H 'content-type: application/json' \
  -H 'x-client-id: my-agent' \
  -d '{"url":"https://some-x402-endpoint.example/api"}'

# Retrying with the same Idempotency-Key returns the ORIGINAL receipt —
# never a second fulfillment, never a second charge.

# Health / treasury / kill state:
curl http://localhost:3402/health

# Verify a receipt:
curl http://localhost:3402/v1/receipts/gc_<id>

# Public signing keys:
curl http://localhost:3402/.well-known/gatecheck-keys.json

# Admin (x-admin-key header):
curl -X POST http://localhost:3402/v1/admin/kill   -H 'x-admin-key: ...'
curl -X POST http://localhost:3402/v1/admin/resume -H 'x-admin-key: ...'
curl -X POST http://localhost:3402/v1/admin/sweep  -H 'x-admin-key: ...' \
  -d '{"ownerWallet":"0x..."}'   # STUB: computes, moves no funds
```

## How fulfillment works

1. **Probe** the target unpaid; capture the 402. Decode base64 `PAYMENT-REQUIRED`.
2. **v1/v2 rule:** read `x402Version` from the envelope *before* choosing the
   proof header (`x-payment` for v1, `PAYMENT-SIGNATURE` for v2). Unknown
   version → refuse to guess.
3. **Envelope-vs-body diff** on every probe — amount/asset/payTo/network/version,
   units-aware (`"0.020000"` dollars == `"20000"` atomic).
4. **Paid spot-check:** Gatecheck buys 402xAgent's verdict for $0.02 as a
   customer (dryrun by default).
5. **Wash signal** v1 = funding-source check on the payTo wallet (self-funded
   flags `wash_self_funded`).
6. **Verdict** composed deterministically; **ed25519-signed receipt** returned
   and appended to `data/receipts.jsonl`.

## Treasury

- Seed: $50 USDC (`TREASURY_SEED_USDC`).
- **Margin guard:** full reports require strictly positive margin — if upstream
  cost ever meets the $0.05 price, sales auto-pause instead of selling at a
  loss. Lite/free are loss-leaders with daily caps (`LITE_DAILY_LOSS_CAP_USDC`,
  `FREE_DAILY_BUDGET_USDC`); hitting a cap pauses that path.
- **Kill switch:** `GATECHECK_KILL=1` at boot or `POST /v1/admin/kill`.
- **Sweep:** stubbed — computes the sweepable profit and logs it; moving real
  funds is a next task.

## What's stubbed (honest list)

- Dynamic pricing (fixed $0.05/$0.02).
- AI support worker (owner handles edge cases).
- Dispute flow / refunds (manual; fulfillment failures post-payment are logged
  for manual review).
- 30-day drift history in reports (`drift.status: "unavailable_in_poc"` —
  needs the crawl feed wired).
- Profit sweep moves no funds.

## Layout

```
src/
  server.js      Express wiring; route order = kill -> guard -> idempotency -> paywall -> fulfill
  config.js      env + testnet-first arming (two keys for mainnet)
  paywall.js     x402 v2 (@x402/express) exact-scheme USDC paywall
  freeTier.js    5 free lite/day, SHA-256 client digests (never raw IPs)
  idempotency.js Idempotency-Key store, 24h TTL, fulfill-after-settlement
  probe.js       unpaid 402 probe, PAYMENT-REQUIRED decode, v1/v2 rule
  diff.js        envelope-vs-body diff, units-aware
  spotcheck.js   402xAgent paid client: dryrun (default) + live (viem EIP-3009)
  wash.js        funding-source check (v1 only)
  receipts.js    ed25519 sign/verify, keys endpoint, receipts.jsonl log
  treasury.js    seed, margin guard, kill switch, sweep stub
  pipeline.js    fulfillment orchestration
test/            node:test, fully offline (28 tests)
```

See `HANDOFF.md` for the Grok bot team: what's next, in order.

## Persistence (SQLite)

Idempotency keys, free-tier counters and treasury state live in one SQLite file (`GATECHECK_DB`, default `data/gatecheck.db`), using `node:sqlite` (Node >= 22.13). Every mutation is one `BEGIN IMMEDIATE` transaction in WAL mode with `synchronous=FULL`, so state survives a restart and a crash mid-write leaves the previous state.

- A corrupt or unreadable DB stops the boot. A locked DB waits `busy_timeout`, then fails closed: no free credit, no sale (503).
- Lock scope: several processes on **one host** can share the file safely. It is **not** safe across hosts or on network filesystems. Run one treasury per DB file, and never share one treasury across two machines.
