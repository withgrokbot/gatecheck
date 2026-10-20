// Self-checked drill: ONE paid $0.02 call to our own endpoint-spot-check, paid from the 402xAgent payTo wallet
// (so the money returns to the same wallet). Labelled self-checked everywhere we record it. No retry.
// Usage: OWNER_WALLET_FILE=<wallet.json> npm run drill:self   (the key is read in-process, never printed)
import { readFileSync, statSync } from "node:fs";
const file = process.env.OWNER_WALLET_FILE;
if (!file || (statSync(file).mode & 0o077) !== 0) throw new Error("OWNER_WALLET_FILE must be a mode-600 wallet.json");
{ const k = String(JSON.parse(readFileSync(file, "utf8")).private_key).trim(); process.env.GATECHECK_WALLET_KEY = k.startsWith("0x") ? k : "0x" + k; }
process.env.SPOTCHECK_MODE = "live";
process.env.SPOTCHECK_CLIENT = "gatecheck-self-checked";
process.env.SPOTCHECK_REF = "self-checked";
const { privateKeyToAccount } = await import("viem/accounts");
const { config } = await import("../src/config.js");
const addr = privateKeyToAccount(process.env.GATECHECK_WALLET_KEY).address;
if (addr.toLowerCase() !== config.spotcheckPayTo.toLowerCase()) throw new Error("refusing: payer is not the 402xAgent payTo wallet (not a self-check)");
const { buySpotCheck } = await import("../src/spotcheck.js");
const { loadKeys, signReceipt, logReceipt, receiptId } = await import("../src/receipts.js");
const target = process.env.DRILL_TARGET || "https://api.402rates.com/v1/ping";
let r, error = null;
try { r = await buySpotCheck(target); } catch (e) { error = String(e?.message || e); }
await loadKeys();
const receipt = signReceipt({
  id: receiptId(), kind: "upstream_spotcheck_drill", self_checked: true, buyer: "self-checked (402xAgent payTo wallet paying itself)",
  counts_as_sale: false, target, payer: addr, amount_atomic: "20000", network: "eip155:8453",
  upstream: r ? { paid: r.paid, verdict: r.verdict, reason: r.reason, receipt_id: r.receiptId, receipt_url: r.receiptUrl, tx: r.tx } : null,
  error, at: new Date().toISOString(),
});
await logReceipt(receipt);
console.log(JSON.stringify({ ok: !error, error, paid: r?.paid, verdict: r?.verdict, reason: r?.reason, receiptId: r?.receiptId, receiptUrl: r?.receiptUrl, tx: r?.tx, gatecheckReceipt: receipt.id }));
