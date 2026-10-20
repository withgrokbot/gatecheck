// ONE live paid spot-check (the only real spend). Reads the throwaway key from a mode-600 file (never printed),
// checks the balance, makes exactly one $0.02 call to 402xAgent endpoint-spot-check, prints verdict + receipt + tx.
// Usage: GATECHECK_WALLET_KEY_FILE=~/.secrets/gatecheck-drill.key DRILL_TARGET=<url> npm run drill
import { readFileSync, statSync } from "node:fs";
const file = process.env.GATECHECK_WALLET_KEY_FILE;
if (!file) throw new Error("set GATECHECK_WALLET_KEY_FILE");
if ((statSync(file).mode & 0o077) !== 0) throw new Error("key file must be mode 600");
process.env.GATECHECK_WALLET_KEY = readFileSync(file, "utf8").trim();
process.env.SPOTCHECK_MODE = "live";
const { privateKeyToAccount } = await import("viem/accounts");
const { buySpotCheck } = await import("../src/spotcheck.js");
const { USDC_BASE, config } = await import("../src/config.js");
const addr = privateKeyToAccount(process.env.GATECHECK_WALLET_KEY).address;
const rpc = async (method, params) => (await (await fetch(config.baseRpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()).result;
const bal = async () => Number(BigInt(await rpc("eth_call", [{ to: USDC_BASE, data: "0x70a08231" + addr.slice(2).toLowerCase().padStart(64, "0") }, "latest"]))) / 1e6;
const before = await bal();
console.log("payer", addr, "usdc_before", before);
if (before < 0.02 || before > 1) throw new Error("refusing: balance must be between $0.02 and $1.00");
const r = await buySpotCheck(process.env.DRILL_TARGET || "https://api.402rates.com/v1/ping");
console.log(JSON.stringify({ verdict: r.verdict, reason: r.reason, receiptId: r.receiptId, receiptUrl: r.receiptUrl, tx: r.tx, simulated: r.simulated }));
console.log("usdc_after", await bal());
