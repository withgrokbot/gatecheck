// Treasury: the "business" part of the shop.
// - Owner seeds the wallet: TREASURY_SEED_USDC (default $50).
// - Every report records earned vs spent (spot-check cost + gas).
// - MARGIN GUARD: sales auto-pause rather than sell at a loss. Checked
//   BEFORE every fulfillment. Full reports need strictly positive margin;
//   lite + free verdicts draw from capped daily loss budgets (they are
//   loss-leaders by design: $0.02 price vs $0.02 cost + gas).
// - KILL SWITCH: env at boot, or POST /v1/admin/kill at runtime. Halts all
//   sales instantly. Every transition is logged.
// - sweepProfits() is a STUB in the PoC: it computes the sweepable amount and
//   logs it. Moving real funds needs the owner wallet flow (next task).

import { config, fromAtomic } from "./config.js";

export const PAUSE_REASONS = {
  NEGATIVE_MARGIN: "negative_margin",
  LITE_LOSS_CAP: "lite_daily_loss_cap",
  FREE_BUDGET_CAP: "free_daily_budget_cap",
  KILL_SWITCH: "kill_switch",
};

export function createTreasury({ now = () => Date.now(), overrides = {}, db = null } = {}) {
  // Injectable for tests; production always uses config.
  const priceFull = overrides.priceFull ?? config.priceFull;
  const priceLite = overrides.priceLite ?? config.priceLite;
  const spotcheckCost = overrides.spotcheckCost ?? config.spotcheckCost;
  const gasPerReport = overrides.gasPerReport ?? config.gasPerReport;
  const liteDailyLossCap = overrides.liteDailyLossCap ?? config.liteDailyLossCap;
  const freeDailyBudget = overrides.freeDailyBudget ?? config.freeDailyBudget;
  const seedAtomic = overrides.seedAtomic ?? config.seedAtomic;
  const dayKey = (t) => new Date(t).toISOString().slice(0, 10);
  const state = {
    seedAtomic,
    earnedAtomic: 0n,
    spentAtomic: 0n,       // real + simulated upstream spend
    simulatedSpentAtomic: 0n,
    sales: 0,
    freeGiven: 0,
    liteSold: 0,
    paused: false,
    pauseReason: null,
    killed: config.killAtBoot,
    killLog: config.killAtBoot ? [{ at: new Date(now()).toISOString(), reason: "env at boot" }] : [],
    // per-UTC-day loss counters for the loss-leader paths
    day: dayKey(now()),
    liteLossAtomic: 0n,
    freeSpendAtomic: 0n,
  };

  // Persistence (optional). State is one JSON row; every operation runs load -> mutate -> save inside one
  // BEGIN IMMEDIATE transaction, so a crash mid-write leaves the previous state and two processes on one
  // host serialize. Without db the treasury is in-memory exactly as before.
  const BIG = ["seedAtomic", "earnedAtomic", "spentAtomic", "simulatedSpentAtomic", "liteLossAtomic", "freeSpendAtomic"];
  const load = () => {
    const row = db.prepare("SELECT state FROM treasury WHERE id = 1").get();
    if (!row) return false;
    const j = JSON.parse(row.state);
    // Copy only the fields this treasury owns (never arbitrary keys from the row).
    for (const k of Object.keys(state)) {
      if (!Object.prototype.hasOwnProperty.call(j, k)) continue;
      state[k] = BIG.includes(k) ? BigInt(j[k]) : j[k];
    }
    if (config.killAtBoot && !state.killed) { state.killed = true; state.killLog.push({ at: new Date(now()).toISOString(), reason: "env at boot" }); }
    return true;
  };
  const save = () => {
    const j = { ...state };
    for (const k of BIG) j[k] = state[k].toString();
    db.prepare("INSERT INTO treasury (id, state, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at").run(JSON.stringify(j), now());
  };
  const mut = (fn) => (db ? db.tx(() => { load(); const out = fn(); save(); return out; }) : fn());
  const read = (fn) => (db ? db.tx(() => { load(); return fn(); }) : fn());
  if (db) db.tx(() => { load(); save(); });

  const rollDay = () => {
    const d = dayKey(now());
    if (d !== state.day) {
      state.day = d;
      state.liteLossAtomic = 0n;
      state.freeSpendAtomic = 0n;
    }
  };

  const pause = (reason) => {
    if (!state.paused) {
      state.paused = true;
      state.pauseReason = reason;
      console.warn(`[treasury] MARGIN GUARD: sales paused — ${reason}`);
    }
  };

  return {
    state,

    /** Gate every sale. Returns { ok } or { ok:false, reason }. */
    checkSale(kind /* "full" | "lite" | "free" */) {
      return mut(() => this._checkSale(kind));
    },
    _checkSale(kind) {
      rollDay();
      if (state.killed) return { ok: false, reason: PAUSE_REASONS.KILL_SWITCH };
      if (state.paused) return { ok: false, reason: state.pauseReason };

      const upstream = spotcheckCost + gasPerReport;
      if (kind === "full") {
        // Strict: never sell a full report at a loss.
        if (upstream >= priceFull) {
          pause(PAUSE_REASONS.NEGATIVE_MARGIN);
          return { ok: false, reason: PAUSE_REASONS.NEGATIVE_MARGIN };
        }
        return { ok: true };
      }
      if (kind === "lite") {
        // Loss-leader with a daily cap.
        if (state.liteLossAtomic + upstream > liteDailyLossCap) {
          pause(PAUSE_REASONS.LITE_LOSS_CAP);
          return { ok: false, reason: PAUSE_REASONS.LITE_LOSS_CAP };
        }
        return { ok: true };
      }
      // free
      if (state.freeSpendAtomic + upstream > freeDailyBudget) {
        pause(PAUSE_REASONS.FREE_BUDGET_CAP);
        return { ok: false, reason: PAUSE_REASONS.FREE_BUDGET_CAP };
      }
      return { ok: true };
    },

    /** Record a completed sale AFTER fulfillment. */
    recordSale(sale) {
      return mut(() => this._recordSale(sale));
    },
    _recordSale({ kind, priceAtomic, upstreamAtomic, simulated = false }) {
      rollDay();
      state.sales += 1;
      state.earnedAtomic += priceAtomic;
      state.spentAtomic += upstreamAtomic;
      if (simulated) state.simulatedSpentAtomic += upstreamAtomic;
      const loss = upstreamAtomic > priceAtomic ? upstreamAtomic - priceAtomic : 0n;
      if (kind === "lite") { state.liteSold += 1; state.liteLossAtomic += loss; }
      if (kind === "free") { state.freeGiven += 1; state.freeSpendAtomic += upstreamAtomic; }
    },

    kill(reason = "admin") {
      return mut(() => this._kill(reason));
    },
    _kill(reason) {
      state.killed = true;
      state.killLog.push({ at: new Date(now()).toISOString(), reason });
      console.warn(`[treasury] KILL SWITCH engaged — ${reason}`);
    },
    resume() {
      return mut(() => this._resume());
    },
    _resume() {
      state.killed = false;
      state.paused = false;
      state.pauseReason = null;
      state.killLog.push({ at: new Date(now()).toISOString(), reason: "resume" });
      console.log("[treasury] sales resumed");
    },

    /** STUB: computes the sweepable profit and logs it. Moves no funds. */
    sweepProfits(ownerWallet) {
      return read(() => this._sweepProfits(ownerWallet));
    },
    _sweepProfits(ownerWallet) {
      const reserve = 0n; // PoC: no refund reserve yet (refunds are manual)
      const sweepable = state.earnedAtomic - state.spentAtomic - reserve;
      const result = {
        stub: true,
        sweepableAtomic: sweepable > 0n ? sweepable : 0n,
        sweepableUsdc: fromAtomic(sweepable > 0n ? sweepable : 0n),
        wouldSendTo: ownerWallet || "(no owner wallet configured)",
        at: new Date(now()).toISOString(),
      };
      console.log(`[treasury] SWEEP STUB: would send ${result.sweepableUsdc} USDC to ${result.wouldSendTo} — no funds moved (manual in PoC)`);
      return result;
    },

    /** Re-read persisted state (another process may have changed it). No-op without db. */
    refresh() {
      if (db) read(() => {});
      return state;
    },
    summary() {
      return mut(() => this._summary());
    },
    _summary() {
      rollDay();
      const fmt = (n) => fromAtomic(n);
      return {
        seedUsdc: fmt(state.seedAtomic),
        earnedUsdc: fmt(state.earnedAtomic),
        spentUsdc: fmt(state.spentAtomic),
        simulatedSpentUsdc: fmt(state.simulatedSpentAtomic),
        netUsdc: fmt(state.earnedAtomic - state.spentAtomic),
        sales: state.sales,
        liteSold: state.liteSold,
        freeGiven: state.freeGiven,
        paused: state.paused,
        pauseReason: state.pauseReason,
        killed: state.killed,
        day: state.day,
        liteLossUsdc: fmt(state.liteLossAtomic),
        freeSpendUsdc: fmt(state.freeSpendAtomic),
      };
    },
  };
}
