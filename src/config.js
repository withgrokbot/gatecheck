// Central config. TESTNET-FIRST: every money path defaults to Base Sepolia.
// Mainnet requires BOTH GATECHECK_NETWORK=eip155:8453 AND GATECHECK_LIVE_MAINNET=1.
// There is no code path that touches mainnet funds by default.

const num = (v, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
};

// USDC token contracts, verified on-chain 2026-10-20 (eth_getCode non-empty, symbol() "USDC", decimals() 6).
// EIP-712 domain (name(), version()) differs by chain: mainnet "USD Coin"/"2", Sepolia "USDC"/"2".
export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const USDC_BY_NETWORK = Object.freeze({
  "eip155:8453": { address: USDC_BASE, chainId: 8453, name: "USD Coin", version: "2" },
  "eip155:84532": { address: USDC_BASE_SEPOLIA, chainId: 84532, name: "USDC", version: "2" },
});

// USDC has 6 decimals. All money math in this shop is integer atomic units (bigint).
export const toAtomic = (usdc) => BigInt(Math.round(Number(usdc) * 1_000_000));
export const fromAtomic = (a) => (Number(a) / 1_000_000).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");

const network = process.env.GATECHECK_NETWORK || "eip155:84532";
const liveMainnetArmed =
  network === "eip155:8453" && process.env.GATECHECK_LIVE_MAINNET === "1";

if (network === "eip155:8453" && !liveMainnetArmed) {
  console.warn(
    "[gatecheck] GATECHECK_NETWORK=eip155:8453 without GATECHECK_LIVE_MAINNET=1 — " +
    "refusing to arm mainnet. Falling back to Base Sepolia behavior."
  );
}

export const config = {
  port: num(process.env.PORT, 3402),

  // What buyers pay, and on which network.
  payTo: process.env.GATECHECK_PAY_TO || "0x0000000000000000000000000000000000000000",
  network: liveMainnetArmed ? "eip155:8453" : "eip155:84532",
  mainnet: liveMainnetArmed,
  facilitatorUrl: process.env.FACILITATOR_URL || "https://x402.org/facilitator",

  // Prices (atomic USDC).
  priceFull: toAtomic("0.05"),
  priceLite: toAtomic("0.02"),
  spotcheckCost: toAtomic("0.02"), // what 402xAgent charges us per paid lookup
  gasPerReport: toAtomic(process.env.GAS_PER_REPORT_USDC || "0.001"),

  // Upstream spot-check purchase.
  spotcheckMode: process.env.SPOTCHECK_MODE === "live" ? "live" : "dryrun",
  spotcheckApiKey: process.env.SPOTCHECK_API_KEY || null,
  walletKey: process.env.GATECHECK_WALLET_KEY || null,
  spotcheckUrl: process.env.SPOTCHECK_URL || "https://api.402xagent.com/v1/products/endpoint-spot-check",
  spotcheckClient: process.env.SPOTCHECK_CLIENT || "gatecheck",
  spotcheckPayTo: "0x37cfCC8a29e9ff9458902B29E31E42dc7B718674",
  spotcheckNetwork: "eip155:8453", // 402xAgent settles on Base mainnet, exact scheme

  // Treasury.
  seedAtomic: toAtomic(process.env.TREASURY_SEED_USDC || "50"),
  liteDailyLossCap: toAtomic(process.env.LITE_DAILY_LOSS_CAP_USDC || "2"),
  freeDailyBudget: toAtomic(process.env.FREE_DAILY_BUDGET_USDC || "5"),
  freePerDay: 5,

  // Wash-signal RPC.
  baseRpcUrl: process.env.BASE_RPC_URL || "https://mainnet.base.org",

  // Kill switch + admin.
  killAtBoot: process.env.GATECHECK_KILL === "1",
  adminKey: process.env.GATECHECK_ADMIN_KEY || null, // admin endpoints are off unless set (>= 16 chars)

  // Receipt signing.
  signingKeyB64: process.env.GATECHECK_SIGNING_KEY || null,
  keysUrlPath: "/.well-known/gatecheck-keys.json",
  dataDir: new URL("../data/", import.meta.url),
  // SQLite file for idempotency, free-tier counters and treasury state. One file per treasury (see db.js).
  dbPath: process.env.GATECHECK_DB || new URL("../data/gatecheck.db", import.meta.url).pathname,
};

if (!process.env.GATECHECK_PAY_TO) {
  console.warn("[gatecheck] GATECHECK_PAY_TO unset — paywall will 402 to the zero address. Set it before taking payments.");
}
if (config.spotcheckMode === "live" && !config.walletKey) {
  throw new Error("[gatecheck] SPOTCHECK_MODE=live requires GATECHECK_WALLET_KEY");
}
if (config.spotcheckMode === "live" && !config.mainnet) {
  console.warn(
    "[gatecheck] SPOTCHECK_MODE=live: the 402xAgent paid endpoint settles on Base mainnet. " +
    "Upstream payment will target mainnet USDC — arm deliberately. Dryrun is the default."
  );
}
