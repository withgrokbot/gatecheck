import { timingSafeEqual } from "node:crypto";
// Gatecheck HTTP server.
// Route order per endpoint is the contract:
//   kill-check -> margin-guard -> idempotency lookup -> [free-tier | x402 paywall]
//   -> fulfill (AFTER settlement) -> store idempotency -> respond.
//
// fulfill-after-settlement: the x402 middleware only calls next() once the
// buyer's payment is verified by the facilitator. Fulfillment never runs on
// an unpaid request.

import express from "express";
import { config } from "./config.js";
import { fullReportPaywall, liteVerdictPaywall } from "./paywall.js";
import { createFreeTier } from "./freeTier.js";
import { createIdempotencyStore } from "./idempotency.js";
import { createTreasury, PAUSE_REASONS } from "./treasury.js";
import { fulfillReport } from "./pipeline.js";
import { loadKeys, keysDocument, verifyReceipt } from "./receipts.js";
import { readFile } from "node:fs/promises";

const app = express();
app.use(express.json({ limit: "64kb" }));
app.set("trust proxy", 1);

const treasury = createTreasury();
const idem = createIdempotencyStore();
const freeTier = createFreeTier({ perDay: config.freePerDay });

// ---- helpers -------------------------------------------------------------

const salesBlocked = () => {
  if (treasury.state.killed) return { blocked: true, reason: PAUSE_REASONS.KILL_SWITCH };
  if (treasury.state.paused) return { blocked: true, reason: treasury.state.pauseReason };
  return { blocked: false };
};

const idemKey = (req) => req.get("idempotency-key") || req.get("Idempotency-Key") || null;

async function handleSale(req, res, kind) {
  const blocked = salesBlocked();
  if (blocked.blocked) {
    return res.status(503).json({ error: "sales_paused", reason: blocked.reason });
  }
  const gate = treasury.checkSale(kind);
  if (!gate.ok) {
    return res.status(503).json({ error: "sales_paused", reason: gate.reason });
  }
  const key = idemKey(req);
  const replay = key && idem.check(key);
  if (replay) {
    // Retried purchase: original receipt, no second fulfillment, no second charge.
    return res.status(replay.status).json({ ...replay.body, idempotentReplay: true });
  }
  const { url } = req.body || {};
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "bad_request", detail: "JSON body needs { url }" });
  }
  try {
    // At this point the x402 middleware has verified the buyer's payment
    // (paid path), or the free-tier gate consumed a credit (free path).
    const { report, receipt, receiptUrl } = await fulfillReport(url, { kind, treasury });
    const body = { report, receipt, receiptUrl };
    if (key) idem.store(key, 200, body);
    return res.status(200).json(body);
  } catch (e) {
    // Fulfillment failed AFTER a verified payment: the money moved but the
    // report didn't. Manual review (dispute flow is stubbed in the PoC).
    console.error("[gatecheck] fulfillment failed post-payment for %s: %s", String(url), String(e?.message || e));
    return res.status(500).json({
      error: "fulfillment_failed",
      detail: "payment was verified but the report could not be built; flagged for manual review",
    });
  }
}

// ---- public --------------------------------------------------------------

app.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html><html><head><meta charset="utf-8">
<title>Gatecheck — pre-payment trust reports for x402 endpoints</title>
<style>body{font-family:system-ui;max-width:640px;margin:40px auto;padding:0 16px;line-height:1.5}</style>
</head><body>
<h1>Gatecheck</h1>
<p>Pre-payment due diligence for agent buyers. Before your agent pays endpoint X,
Gatecheck returns a <b>signed trust report</b> — pay, skip, or recheck, with reasons.</p>
<ul>
<li><b>Full report</b> — $0.05: live 402 terms, envelope-vs-body diff, paid spot-check verdict, wash signal, signed receipt.</li>
<li><b>Lite verdict</b> — $0.02 (5 free/day): pay/skip + reason.</li>
</ul>
<p>The money loop is x402 all the way down: you pay Gatecheck, Gatecheck pays
402xAgent $0.02 for the spot-check that powers the verdict, and keeps the spread.</p>
<h2>Try it</h2>
<pre>curl -X POST http://localhost:${config.port}/v1/report \\
  -H 'content-type: application/json' \\
  -H 'Idempotency-Key: my-unique-key' \\
  -d '{"url":"https://example.com/api"}'
# -&gt; 402 with PAYMENT-REQUIRED. Pay it with any x402 v2 client, retry.</pre>
<p>Receipts verify against <a href="${config.keysUrlPath}">${config.keysUrlPath}</a>.
Treasury: <a href="/health">/health</a>.</p>
</body></html>`);
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    network: config.network,
    mainnet: config.mainnet,
    spotcheckMode: config.spotcheckMode,
    treasury: treasury.summary(),
  });
});

app.get(config.keysUrlPath, (_req, res) => res.json(keysDocument()));

app.get("/v1/receipts/:id", async (req, res) => {
  try {
    const log = await readFile(new URL(config.dataDir + "receipts.jsonl"), "utf8").catch(() => "");
    const line = log.split("\n").find((l) => l.includes(`"id":"${req.params.id}"`));
    if (!line) return res.status(404).json({ error: "not_found" });
    const receipt = JSON.parse(line);
    res.json({ receipt, valid: verifyReceipt(receipt) });
  } catch {
    res.status(500).json({ error: "receipt_store_unavailable" });
  }
});

// ---- paid endpoints -------------------------------------------------------

// Full report: always paid.
app.post("/v1/report", (req, res, next) => fullReportPaywall(req, res, next), (req, res) => handleSale(req, res, "full"));

// Lite verdict: free-tier gate first; paid x402 path otherwise.
app.post("/v1/verdict", (req, res, next) => {
  if (freeTier.tryConsume(req)) {
    req.freeTier = true;
    return handleSale(req, res, "free");
  }
  return liteVerdictPaywall(req, res, (err) => {
    if (err) return next(err);
    return handleSale(req, res, "lite");
  });
});

// ---- admin ----------------------------------------------------------------

const requireAdmin = (req, res, next) => {
  // Admin is disabled unless a real key is configured (never the example default), compared in constant time.
  const want = config.adminKey;
  const got = String(req.get("x-admin-key") || "");
  const ok = !!want && want !== "change-me" && want.length >= 16 && got.length === want.length &&
    timingSafeEqual(Buffer.from(got), Buffer.from(want));
  if (!ok) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
};

app.post("/v1/admin/kill", requireAdmin, (_req, res) => {
  treasury.kill("admin endpoint");
  res.json({ killed: true });
});

app.post("/v1/admin/resume", requireAdmin, (_req, res) => {
  treasury.resume();
  res.json({ killed: false, paused: false });
});

app.post("/v1/admin/sweep", requireAdmin, (req, res) => {
  res.json(treasury.sweepProfits(req.body?.ownerWallet || process.env.GATECHECK_OWNER_WALLET));
});

// ---- boot -----------------------------------------------------------------

await loadKeys();
app.listen(config.port, () => {
  console.log(`[gatecheck] listening on :${config.port} — network=${config.network} mainnet=${config.mainnet} spotcheck=${config.spotcheckMode}`);
  if (treasury.state.killed) console.log("[gatecheck] KILL SWITCH engaged at boot — sales halted");
});
